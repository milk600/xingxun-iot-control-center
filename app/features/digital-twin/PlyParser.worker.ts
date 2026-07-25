/// <reference lib="webworker" />

import type { BufferAttribute, InterleavedBufferAttribute } from "three";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import {
  parseOpenMvsDensePointCloud,
  pointCloudBucketCount,
  probePlyBlob,
} from "@/app/lib/digital-twin/openmvs-ply";

type SupportedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

interface SerializedAttribute {
  buffer: ArrayBuffer;
  arrayType: SupportedArray["constructor"]["name"];
  itemSize: number;
  normalized: boolean;
}

interface ParseRequest {
  file: File;
}

function serializeArray(
  array: SupportedArray,
  itemSize: number,
  normalized = false,
): SerializedAttribute {
  const ownBuffer = array.byteOffset === 0 && array.byteLength === array.buffer.byteLength
    ? array.buffer
    : array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength);
  if (!(ownBuffer instanceof ArrayBuffer)) {
    throw new Error("PLY 属性使用了浏览器不支持的共享内存。");
  }
  return {
    buffer: ownBuffer,
    arrayType: array.constructor.name,
    itemSize,
    normalized,
  };
}

function serializeAttribute(
  attribute: BufferAttribute | InterleavedBufferAttribute,
): SerializedAttribute {
  if ("isInterleavedBufferAttribute" in attribute && attribute.isInterleavedBufferAttribute) {
    throw new Error("暂不支持交错存储的 PLY 属性。");
  }
  const bufferAttribute = attribute as BufferAttribute;
  return serializeArray(
    bufferAttribute.array as SupportedArray,
    bufferAttribute.itemSize,
    bufferAttribute.normalized,
  );
}

function pointBucketSizes(vertexCount: number, bucketCount: number) {
  return Array.from({ length: bucketCount }, (_, bucketIndex) => (
    Math.floor((vertexCount - 1 - bucketIndex) / bucketCount) + 1
  ));
}

function reorderPointCloudForInteraction(
  position: BufferAttribute | InterleavedBufferAttribute,
  color: BufferAttribute | InterleavedBufferAttribute | undefined,
) {
  const vertexCount = position.count;
  const bucketCount = pointCloudBucketCount(vertexCount);
  const sizes = pointBucketSizes(vertexCount, bucketCount);
  const starts = new Uint32Array(bucketCount);
  for (let bucketIndex = 1; bucketIndex < bucketCount; bucketIndex += 1) {
    starts[bucketIndex] = starts[bucketIndex - 1] + sizes[bucketIndex - 1];
  }
  const positions = new Float32Array(vertexCount * 3);
  const colors = color ? new Uint8Array(vertexCount * 3) : null;

  for (let sourceIndex = 0; sourceIndex < vertexCount; sourceIndex += 1) {
    const bucketIndex = sourceIndex % bucketCount;
    const targetIndex = starts[bucketIndex] + Math.floor(sourceIndex / bucketCount);
    const offset = targetIndex * 3;
    positions[offset] = position.getX(sourceIndex);
    positions[offset + 1] = position.getY(sourceIndex);
    positions[offset + 2] = position.getZ(sourceIndex);
    if (colors && color) {
      colors[offset] = Math.round(Math.min(1, Math.max(0, color.getX(sourceIndex))) * 255);
      colors[offset + 1] = Math.round(Math.min(1, Math.max(0, color.getY(sourceIndex))) * 255);
      colors[offset + 2] = Math.round(Math.min(1, Math.max(0, color.getZ(sourceIndex))) * 255);
    }
  }

  return {
    position: serializeArray(positions, 3),
    color: colors ? serializeArray(colors, 3, true) : null,
    bucketCount,
    interactiveVertexCount: sizes[0],
  };
}

function transferBuffers(result: {
  position: SerializedAttribute;
  normal: SerializedAttribute | null;
  color: SerializedAttribute | null;
  index: SerializedAttribute | null;
}) {
  return [
    result.position.buffer,
    result.normal?.buffer,
    result.color?.buffer,
    result.index?.buffer,
  ].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
}

self.addEventListener("message", (event: MessageEvent<ParseRequest>) => {
  void (async () => {
    try {
      const { file } = event.data;
      const probe = await probePlyBlob(file);
      if (probe.isOpenMvsDensePointCloud) {
        const parsed = await parseOpenMvsDensePointCloud(file, probe, (progress) => {
          self.postMessage({ type: "progress", progress: progress.ratio });
        });
        const result = {
          position: serializeArray(parsed.positions, 3),
          normal: null,
          color: serializeArray(parsed.colors, 3, true),
          index: null,
          vertexCount: parsed.vertexCount,
          faceCount: 0,
          bucketCount: parsed.bucketCount,
          interactiveVertexCount: parsed.interactiveVertexCount,
          optimizedPointCloud: true,
        };
        self.postMessage({ type: "result", result }, { transfer: transferBuffers(result) });
        return;
      }

      self.postMessage({ type: "progress", progress: 0.08 });
      const buffer = await file.arrayBuffer();
      self.postMessage({ type: "progress", progress: 0.42 });
      const geometry = new PLYLoader().parse(buffer);
      const position = geometry.getAttribute("position");
      if (!position || position.count === 0) {
        throw new Error("PLY 文件没有可显示的顶点坐标。");
      }

      const normal = geometry.getAttribute("normal");
      const color = geometry.getAttribute("color");
      const index = geometry.getIndex();
      self.postMessage({ type: "progress", progress: 0.78 });

      if (!index) {
        const reordered = reorderPointCloudForInteraction(position, color);
        const result = {
          position: reordered.position,
          normal: null,
          color: reordered.color,
          index: null,
          vertexCount: position.count,
          faceCount: 0,
          bucketCount: reordered.bucketCount,
          interactiveVertexCount: reordered.interactiveVertexCount,
          optimizedPointCloud: false,
        };
        geometry.dispose();
        self.postMessage({ type: "result", result }, { transfer: transferBuffers(result) });
        return;
      }

      const result = {
        position: serializeAttribute(position),
        normal: normal ? serializeAttribute(normal) : null,
        color: color ? serializeAttribute(color) : null,
        index: serializeAttribute(index),
        vertexCount: position.count,
        faceCount: Math.floor(index.count / 3),
        bucketCount: 1,
        interactiveVertexCount: position.count,
        optimizedPointCloud: false,
      };
      self.postMessage({ type: "result", result }, { transfer: transferBuffers(result) });
      geometry.dispose();
    } catch (error: unknown) {
      self.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : "PLY 后台解析失败。",
      });
    }
  })();
});

export {};
