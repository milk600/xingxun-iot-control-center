import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import {
  parseOpenMvsDensePointCloud,
  probePlyBlob,
} from "../app/lib/digital-twin/openmvs-ply.ts";
import {
  ROOM_ONE_TOP_DIRECTION,
  ROOM_ONE_TOP_RIGHT,
  ROOM_ONE_TOP_UP,
} from "../app/lib/digital-twin/room-one-coordinate-system.ts";

const WIDTH = 1600;
const HEIGHT = 1000;
const PADDING = 42;
const SOURCE = resolve("public/models/room-01/demo-room.ply");
const OUTPUT_IMAGE = resolve("public/models/room-01/room-top-map.png");
const OUTPUT_MASK = resolve("public/models/room-01/room-top-mask.png");
const OUTPUT_MANIFEST = resolve("public/models/room-01/room-top-map.json");

function dot(x: number, y: number, z: number, axis: readonly number[]) {
  return x * axis[0] + y * axis[1] + z * axis[2];
}

function quantile(values: number[], ratio: number) {
  const index = Math.max(0, Math.min(values.length - 1, Math.round((values.length - 1) * ratio)));
  return values[index];
}

function srgbByte(linearByte: number) {
  const linear = linearByte / 255;
  const srgb = linear <= 0.0031308
    ? linear * 12.92
    : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(srgb * 255)));
}

function enhanceChannel(value: number, luminance: number) {
  const saturated = luminance + (value - luminance) * 1.13;
  return Math.max(0, Math.min(255, Math.round((saturated - 127.5) * 1.07 + 134)));
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  const chunk = Buffer.allocUnsafe(data.byteLength + 12);
  chunk.writeUInt32BE(data.byteLength, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), data.byteLength + 8);
  return chunk;
}

function encodePng(width: number, height: number, rgba: Uint8Array) {
  const scanlines = Buffer.allocUnsafe((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const target = row * (width * 4 + 1);
    scanlines[target] = 0;
    scanlines.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), target + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

function dilate(source: Uint8Array, width: number, height: number, iterations: number) {
  let current = source;
  for (let pass = 0; pass < iterations; pass += 1) {
    const next = current.slice();
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (current[index]) continue;
        for (let dy = -1; dy <= 1 && !next[index]; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (current[index + dy * width + dx]) {
              next[index] = 1;
              break;
            }
          }
        }
      }
    }
    current = next;
  }
  return current;
}

function largestConnectedComponent(source: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(source.length);
  const queue = new Int32Array(source.length);
  let largest: number[] = [];
  for (let seed = 0; seed < source.length; seed += 1) {
    if (!source[seed] || visited[seed]) continue;
    let head = 0;
    let tail = 0;
    const component: number[] = [];
    visited[seed] = 1;
    queue[tail++] = seed;
    while (head < tail) {
      const index = queue[head++];
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (!source[next] || visited[next]) continue;
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    if (component.length > largest.length) largest = component;
  }
  const result = new Uint8Array(source.length);
  for (const index of largest) result[index] = 1;
  return result;
}

function fillInterior(source: Uint8Array, width: number, height: number) {
  const exterior = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const add = (x: number, y: number) => {
    const index = y * width + x;
    if (source[index] || exterior[index]) return;
    exterior[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x += 1) {
    add(x, 0);
    add(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    add(0, y);
    add(width - 1, y);
  }
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) add(x - 1, y);
    if (x + 1 < width) add(x + 1, y);
    if (y > 0) add(x, y - 1);
    if (y + 1 < height) add(x, y + 1);
  }
  const result = source.slice();
  for (let index = 0; index < result.length; index += 1) {
    if (!exterior[index]) result[index] = 1;
  }
  return result;
}

async function main() {
  const bytes = await readFile(SOURCE);
  const blob = new Blob([bytes]);
  const probe = await probePlyBlob(blob);
  const parsed = await parseOpenMvsDensePointCloud(blob, probe, (progress) => {
    if (progress.pointsRead % 250_000 < 32) {
      process.stdout.write(`\r解析点云 ${Math.round(progress.ratio * 100)}%`);
    }
  });
  process.stdout.write("\r解析点云 100%\n");

  const projectedX: number[] = [];
  const projectedY: number[] = [];
  const sampleStride = Math.max(1, Math.floor(parsed.vertexCount / 80_000));
  for (let index = 0; index < parsed.vertexCount; index += sampleStride) {
    const offset = index * 3;
    const x = parsed.positions[offset];
    const y = parsed.positions[offset + 1];
    const z = parsed.positions[offset + 2];
    projectedX.push(dot(x, y, z, ROOM_ONE_TOP_RIGHT));
    projectedY.push(dot(x, y, z, ROOM_ONE_TOP_UP));
  }
  projectedX.sort((left, right) => left - right);
  projectedY.sort((left, right) => left - right);
  let minX = quantile(projectedX, 0.008);
  let maxX = quantile(projectedX, 0.992);
  let minY = quantile(projectedY, 0.008);
  let maxY = quantile(projectedY, 0.992);
  const expandX = (maxX - minX) * 0.035;
  const expandY = (maxY - minY) * 0.035;
  minX -= expandX;
  maxX += expandX;
  minY -= expandY;
  maxY += expandY;

  const scale = Math.min(
    (WIDTH - PADDING * 2) / (maxX - minX),
    (HEIGHT - PADDING * 2) / (maxY - minY),
  );
  const contentWidth = (maxX - minX) * scale;
  const contentHeight = (maxY - minY) * scale;
  const offsetX = (WIDTH - contentWidth) / 2;
  const offsetY = (HEIGHT - contentHeight) / 2;
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  const depth = new Float32Array(WIDTH * HEIGHT);
  depth.fill(Number.NEGATIVE_INFINITY);
  const maskSmallWidth = 200;
  const maskSmallHeight = 125;
  const occupancy = new Uint8Array(maskSmallWidth * maskSmallHeight);

  for (let index = 0; index < parsed.vertexCount; index += 1) {
    const sourceOffset = index * 3;
    const x = parsed.positions[sourceOffset];
    const y = parsed.positions[sourceOffset + 1];
    const z = parsed.positions[sourceOffset + 2];
    const planeX = dot(x, y, z, ROOM_ONE_TOP_RIGHT);
    const planeY = dot(x, y, z, ROOM_ONE_TOP_UP);
    const px = Math.round(offsetX + (planeX - minX) * scale);
    const py = Math.round(offsetY + (maxY - planeY) * scale);
    if (px < 0 || px >= WIDTH || py < 0 || py >= HEIGHT) continue;
    const cameraDepth = dot(x, y, z, ROOM_ONE_TOP_DIRECTION);
    const red = srgbByte(parsed.colors[sourceOffset]);
    const green = srgbByte(parsed.colors[sourceOffset + 1]);
    const blue = srgbByte(parsed.colors[sourceOffset + 2]);
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    const outRed = enhanceChannel(red, luminance);
    const outGreen = enhanceChannel(green, luminance);
    const outBlue = enhanceChannel(blue, luminance);
    for (let dy = -1; dy <= 1; dy += 1) {
      const targetY = py + dy;
      if (targetY < 0 || targetY >= HEIGHT) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const targetX = px + dx;
        if (targetX < 0 || targetX >= WIDTH) continue;
        const pixel = targetY * WIDTH + targetX;
        if (cameraDepth < depth[pixel]) continue;
        depth[pixel] = cameraDepth;
        const outputOffset = pixel * 4;
        rgba[outputOffset] = outRed;
        rgba[outputOffset + 1] = outGreen;
        rgba[outputOffset + 2] = outBlue;
        rgba[outputOffset + 3] = 255;
      }
    }
    const smallX = Math.max(0, Math.min(maskSmallWidth - 1, Math.floor(px / WIDTH * maskSmallWidth)));
    const smallY = Math.max(0, Math.min(maskSmallHeight - 1, Math.floor(py / HEIGHT * maskSmallHeight)));
    occupancy[smallY * maskSmallWidth + smallX] = 1;
  }

  const mainOccupancy = largestConnectedComponent(occupancy, maskSmallWidth, maskSmallHeight);
  const roomMaskSmall = fillInterior(dilate(mainOccupancy, maskSmallWidth, maskSmallHeight, 3), maskSmallWidth, maskSmallHeight);
  const maskRgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    const smallY = Math.min(maskSmallHeight - 1, Math.floor(y / HEIGHT * maskSmallHeight));
    for (let x = 0; x < WIDTH; x += 1) {
      const smallX = Math.min(maskSmallWidth - 1, Math.floor(x / WIDTH * maskSmallWidth));
      const offset = (y * WIDTH + x) * 4;
      if (!roomMaskSmall[smallY * maskSmallWidth + smallX]) {
        rgba[offset + 3] = 0;
        continue;
      }
      maskRgba[offset] = 255;
      maskRgba[offset + 1] = 255;
      maskRgba[offset + 2] = 255;
      maskRgba[offset + 3] = 255;
    }
  }

  const contentBounds = {
    left: offsetX / WIDTH,
    top: offsetY / HEIGHT,
    width: contentWidth / WIDTH,
    height: contentHeight / HEIGHT,
  };
  const suggestedRoom = { widthM: 8, heightM: 5 };

  await Promise.all([
    writeFile(OUTPUT_IMAGE, encodePng(WIDTH, HEIGHT, rgba)),
    writeFile(OUTPUT_MASK, encodePng(WIDTH, HEIGHT, maskRgba)),
    writeFile(OUTPUT_MANIFEST, `${JSON.stringify({
      version: 1,
      sceneId: "room-01",
      sceneRevision: 1,
      width: WIDTH,
      height: HEIGHT,
      contentBounds,
      suggestedRoom,
      projection: {
        direction: ROOM_ONE_TOP_DIRECTION,
        up: ROOM_ONE_TOP_UP,
        right: ROOM_ONE_TOP_RIGHT,
      },
      generatedFrom: "demo-room.ply",
      vertexCount: parsed.vertexCount,
    }, null, 2)}\n`, "utf8"),
  ]);
  console.log(`生成完成：${OUTPUT_IMAGE}`);
  console.log(`地图内容区域：${JSON.stringify(contentBounds)}`);
  console.log(`建议房间尺寸：${suggestedRoom.widthM}m × ${suggestedRoom.heightM}m`);
}

await main();
