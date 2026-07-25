import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve("public/models/room-01");
const primary = [];
const framework = [];
const gap = [];

function add(points, x, y, z, color) {
  points.push([x, y, z, ...color]);
}

function addLine(points, start, end, steps, color) {
  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps;
    add(
      points,
      start[0] + (end[0] - start[0]) * ratio,
      start[1] + (end[1] - start[1]) * ratio,
      start[2] + (end[2] - start[2]) * ratio,
      color,
    );
  }
}

const floorColor = [102, 137, 173];
const wallColor = [162, 190, 216];
const equipmentColor = [74, 166, 151];
const frameworkColor = [45, 213, 196];
const gapColor = [255, 154, 72];

for (let x = -4; x <= 4.0001; x += 0.2) {
  for (let z = -2.5; z <= 2.5001; z += 0.2) {
    add(primary, x, 0, z, floorColor);
  }
}

for (let height = 0.2; height <= 2.6001; height += 0.2) {
  for (let x = -4; x <= 4.0001; x += 0.2) {
    add(primary, x, height, -2.5, wallColor);
    if (x < -0.7 || x > 0.7 || height > 2.2) {
      add(primary, x, height, 2.5, wallColor);
    }
  }
  for (let z = -2.3; z <= 2.3001; z += 0.2) {
    add(primary, -4, height, z, wallColor);
    add(primary, 4, height, z, wallColor);
  }
}

for (const [centreX, centreZ, width, depth] of [
  [-2.2, -1.1, 1.4, 0.9],
  [0.2, 0.8, 1.8, 1.0],
  [2.5, -0.7, 1.1, 1.4],
]) {
  for (let x = centreX - width / 2; x <= centreX + width / 2; x += 0.15) {
    for (let z = centreZ - depth / 2; z <= centreZ + depth / 2; z += 0.15) {
      add(primary, x, 0.55, z, equipmentColor);
    }
  }
}

const corners = [
  [-4, 0, -2.5],
  [4, 0, -2.5],
  [4, 0, 2.5],
  [-4, 0, 2.5],
];
for (let index = 0; index < corners.length; index += 1) {
  const next = corners[(index + 1) % corners.length];
  addLine(framework, corners[index], next, 70, frameworkColor);
  addLine(framework, [corners[index][0], 0, corners[index][2]], [corners[index][0], 2.6, corners[index][2]], 26, frameworkColor);
  addLine(framework, [corners[index][0], 2.6, corners[index][2]], [next[0], 2.6, next[2]], 70, frameworkColor);
}

for (let x = -0.65; x <= 0.65; x += 0.08) {
  add(gap, x, 0.05, 2.48, gapColor);
  add(gap, x, 0.45, 2.48, gapColor);
  add(gap, x, 0.9, 2.48, gapColor);
}

function encodePly(points, comment) {
  const header = [
    "ply",
    "format ascii 1.0",
    `comment ${comment}`,
    `element vertex ${points.length}`,
    "property float x",
    "property float y",
    "property float z",
    "property uchar red",
    "property uchar green",
    "property uchar blue",
    "end_header",
  ];
  const body = points.map((point) => point.map((value, index) => (
    index < 3 ? Number(value).toFixed(4) : String(value)
  )).join(" "));
  return `${[...header, ...body].join("\n")}\n`;
}

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDirectory, "demo-room.ply"), encodePly(primary, "Synthetic demo room; contains no captured site data.")),
  writeFile(resolve(outputDirectory, "demo-room-framework.ply"), encodePly(framework, "Synthetic geometry framework.")),
  writeFile(resolve(outputDirectory, "demo-room-gap.ply"), encodePly(gap, "Synthetic diagnostic marker layer.")),
  writeFile(resolve(outputDirectory, "room-top-map.json"), `${JSON.stringify({
    version: 1,
    sceneId: "room-01",
    sceneRevision: 1,
    width: 1600,
    height: 1000,
    contentBounds: { left: 0.08, top: 0.08, width: 0.84, height: 0.84 },
    suggestedRoom: { widthM: 8, heightM: 5 },
    projection: {
      direction: [0, 1, 0],
      up: [0, 0, -1],
      right: [1, 0, 0],
    },
    generatedFrom: "demo-room.ply",
    vertexCount: primary.length,
  }, null, 2)}\n`),
]);

console.log(`Generated synthetic demo room (${primary.length} primary points).`);
