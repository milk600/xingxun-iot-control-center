const MAX_PLY_HEADER_BYTES = 256 * 1024;
const INTERACTIVE_POINT_TARGET = 280_000;
const MAX_POINT_BUCKETS = 32;

const EXPECTED_OPENMVS_VERTEX_PROPERTIES = [
  "property float32 x",
  "property float32 y",
  "property float32 z",
  "property uint8 red",
  "property uint8 green",
  "property uint8 blue",
  "property float32 nx",
  "property float32 ny",
  "property float32 nz",
  "property list uint8 uint32 view_indices",
  "property list uint8 float32 view_weights",
] as const;

const SRGB_TO_LINEAR_BYTE = Uint8Array.from({ length: 256 }, (_, value) => {
  const srgb = value / 255;
  const linear = srgb <= 0.04045
    ? srgb / 12.92
    : ((srgb + 0.055) / 1.055) ** 2.4;
  return Math.round(linear * 255);
});

export interface PlyBlobProbe {
  dataOffset: number;
  headerText: string;
  vertexCount: number;
  isOpenMvsDensePointCloud: boolean;
}

export interface ParsedOpenMvsPointCloud {
  vertexCount: number;
  bucketCount: number;
  interactiveVertexCount: number;
  positions: Float32Array;
  colors: Uint8Array;
}

export interface OpenMvsParseProgress {
  bytesRead: number;
  pointsRead: number;
  ratio: number;
}

interface PlyHeaderAnalysis {
  vertexCount: number;
  isOpenMvsDensePointCloud: boolean;
}

function canonicalPlyType(type: string) {
  return {
    float: "float32",
    uchar: "uint8",
    uint: "uint32",
  }[type] ?? type;
}

function canonicalProperty(line: string) {
  const parts = line.trim().toLowerCase().split(/\s+/);
  if (parts[0] !== "property") return parts.join(" ");
  if (parts[1] === "list" && parts.length >= 5) {
    parts[2] = canonicalPlyType(parts[2]);
    parts[3] = canonicalPlyType(parts[3]);
  } else if (parts.length >= 3) {
    parts[1] = canonicalPlyType(parts[1]);
  }
  return parts.join(" ");
}

function findHeaderDataOffset(bytes: Uint8Array) {
  const marker = [101, 110, 100, 95, 104, 101, 97, 100, 101, 114]; // end_header
  outer: for (let index = 0; index <= bytes.length - marker.length; index += 1) {
    for (let markerIndex = 0; markerIndex < marker.length; markerIndex += 1) {
      if (bytes[index + markerIndex] !== marker[markerIndex]) continue outer;
    }
    let dataOffset = index + marker.length;
    if (bytes[dataOffset] === 13) dataOffset += 1;
    if (bytes[dataOffset] !== 10) {
      throw new Error("PLY 文件头的 end_header 后缺少换行符。");
    }
    return dataOffset + 1;
  }
  throw new Error("未找到完整的 PLY 文件头。");
}

function analyzePlyHeader(headerText: string): PlyHeaderAnalysis {
  const lines = headerText.replace(/\r/g, "").split("\n");
  if (lines[0]?.trim() !== "ply") throw new Error("文件不是有效的 PLY。");

  let vertexCount = 0;
  let faceCount = 0;
  let currentElement = "";
  const vertexProperties: string[] = [];
  let binaryLittleEndian = false;
  for (const rawLine of lines) {
    const line = rawLine.trim().toLowerCase().replace(/\s+/g, " ");
    if (line === "format binary_little_endian 1.0") binaryLittleEndian = true;
    if (line.startsWith("element ")) {
      const [, name, countText] = line.split(" ");
      currentElement = name;
      const count = Number(countText);
      if (name === "vertex") vertexCount = count;
      if (name === "face") faceCount = count;
    } else if (line.startsWith("property ") && currentElement === "vertex") {
      vertexProperties.push(canonicalProperty(line));
    }
  }

  if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0) {
    throw new Error("PLY 文件没有有效顶点。");
  }
  return {
    vertexCount,
    isOpenMvsDensePointCloud: binaryLittleEndian
      && faceCount === 0
      && vertexProperties.length === EXPECTED_OPENMVS_VERTEX_PROPERTIES.length
      && vertexProperties.every(
        (property, index) => property === EXPECTED_OPENMVS_VERTEX_PROPERTIES[index],
      ),
  };
}

export function isOpenMvsDensePointCloudHeader(headerText: string) {
  return analyzePlyHeader(headerText).isOpenMvsDensePointCloud;
}

export function pointCloudBucketCount(vertexCount: number) {
  if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0) {
    throw new Error("点云顶点数量无效。");
  }
  return Math.min(
    MAX_POINT_BUCKETS,
    Math.max(1, Math.ceil(vertexCount / INTERACTIVE_POINT_TARGET)),
  );
}

export function linearizeSrgbByte(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error("颜色通道必须是 0 到 255 的整数。");
  }
  return SRGB_TO_LINEAR_BYTE[value];
}

export async function probePlyBlob(blob: Blob): Promise<PlyBlobProbe> {
  const prefix = new Uint8Array(
    await blob.slice(0, Math.min(blob.size, MAX_PLY_HEADER_BYTES)).arrayBuffer(),
  );
  const dataOffset = findHeaderDataOffset(prefix);
  const headerText = new TextDecoder("ascii").decode(prefix.subarray(0, dataOffset));
  const { vertexCount, isOpenMvsDensePointCloud } = analyzePlyHeader(headerText);

  return { dataOffset, headerText, vertexCount, isOpenMvsDensePointCloud };
}

function bucketSizes(vertexCount: number, bucketCount: number) {
  return Array.from({ length: bucketCount }, (_, bucketIndex) => (
    bucketIndex < vertexCount
      ? Math.floor((vertexCount - 1 - bucketIndex) / bucketCount) + 1
      : 0
  ));
}

export async function parseOpenMvsDensePointCloud(
  blob: Blob,
  probe: PlyBlobProbe,
  onProgress?: (progress: OpenMvsParseProgress) => void,
): Promise<ParsedOpenMvsPointCloud> {
  if (!probe.isOpenMvsDensePointCloud) {
    throw new Error("该 PLY 不是受支持的 OpenMVS 彩色稠密点云布局。");
  }

  const bucketCount = pointCloudBucketCount(probe.vertexCount);
  const sizes = bucketSizes(probe.vertexCount, bucketCount);
  const bucketStarts = new Uint32Array(bucketCount);
  for (let bucketIndex = 1; bucketIndex < bucketCount; bucketIndex += 1) {
    bucketStarts[bucketIndex] = bucketStarts[bucketIndex - 1] + sizes[bucketIndex - 1];
  }
  const bucketOffsets = bucketStarts.slice();
  const positions = new Float32Array(probe.vertexCount * 3);
  const colors = new Uint8Array(probe.vertexCount * 3);
  const reader = blob.slice(probe.dataOffset).stream().getReader();
  const bodySize = Math.max(1, blob.size - probe.dataOffset);
  let carry = new Uint8Array(0);
  let bodyBytesRead = 0;
  let vertexIndex = 0;
  let nextProgressVertex = Math.max(1, Math.floor(probe.vertexCount / 100));

  try {
    while (vertexIndex < probe.vertexCount) {
      const { done, value } = await reader.read();
      if (done) break;
      bodyBytesRead += value.byteLength;

      let bytes: Uint8Array;
      if (carry.byteLength > 0) {
        bytes = new Uint8Array(carry.byteLength + value.byteLength);
        bytes.set(carry);
        bytes.set(value, carry.byteLength);
      } else {
        bytes = value;
      }

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 0;
      while (vertexIndex < probe.vertexCount) {
        // XYZ + RGB + normal occupies 27 bytes, followed by two variable lists.
        if (bytes.byteLength - offset < 28) break;
        const viewCount = bytes[offset + 27];
        const weightCountOffset = offset + 28 + viewCount * 4;
        if (weightCountOffset >= bytes.byteLength) break;
        const weightCount = bytes[weightCountOffset];
        const recordEnd = weightCountOffset + 1 + weightCount * 4;
        if (recordEnd > bytes.byteLength) break;
        if (viewCount !== weightCount) {
          throw new Error(`OpenMVS 点 ${vertexIndex.toLocaleString()} 的视图索引与权重数量不一致。`);
        }

        const x = view.getFloat32(offset, true);
        const y = view.getFloat32(offset + 4, true);
        const z = view.getFloat32(offset + 8, true);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          throw new Error(`OpenMVS 点 ${vertexIndex.toLocaleString()} 包含无效坐标。`);
        }

        const bucketIndex = vertexIndex % bucketCount;
        const outputOffset = bucketOffsets[bucketIndex] * 3;
        positions[outputOffset] = x;
        positions[outputOffset + 1] = y;
        positions[outputOffset + 2] = z;
        colors[outputOffset] = SRGB_TO_LINEAR_BYTE[bytes[offset + 12]];
        colors[outputOffset + 1] = SRGB_TO_LINEAR_BYTE[bytes[offset + 13]];
        colors[outputOffset + 2] = SRGB_TO_LINEAR_BYTE[bytes[offset + 14]];
        bucketOffsets[bucketIndex] += 1;
        vertexIndex += 1;
        offset = recordEnd;

        if (vertexIndex >= nextProgressVertex) {
          onProgress?.({
            bytesRead: probe.dataOffset + bodyBytesRead,
            pointsRead: vertexIndex,
            ratio: Math.min(1, bodyBytesRead / bodySize),
          });
          nextProgressVertex += Math.max(1, Math.floor(probe.vertexCount / 100));
        }
      }
      carry = offset === bytes.byteLength ? new Uint8Array(0) : bytes.slice(offset);
    }
  } finally {
    reader.releaseLock();
  }

  if (vertexIndex !== probe.vertexCount) {
    throw new Error(
      `OpenMVS PLY 数据不完整：期望 ${probe.vertexCount.toLocaleString()} 点，`
      + `实际读取 ${vertexIndex.toLocaleString()} 点。`,
    );
  }
  if (carry.byteLength > 0) {
    throw new Error("OpenMVS PLY 顶点数据后存在未识别内容。");
  }
  sizes.forEach((size, bucketIndex) => {
    if (bucketOffsets[bucketIndex] !== bucketStarts[bucketIndex] + size) {
      throw new Error(`点云分桶 ${bucketIndex + 1} 的点数不完整。`);
    }
  });
  onProgress?.({ bytesRead: blob.size, pointsRead: vertexIndex, ratio: 1 });

  return {
    vertexCount: probe.vertexCount,
    bucketCount,
    interactiveVertexCount: sizes[0],
    positions,
    colors,
  };
}
