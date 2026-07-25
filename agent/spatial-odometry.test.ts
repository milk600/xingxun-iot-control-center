import assert from "node:assert/strict";
import test from "node:test";
import { parseJetsonMessage } from "../app/lib/iot/jetson-websocket";
import {
  carBodyVelocity,
  integrateWheelPoseWithJetsonHeading,
  metricPoseToMapPose,
  poseFromDeviceOdometry,
  type MetricMapPose,
  type WheelSpeedsMmps,
} from "../app/lib/spatial/odometry";
import { buildSpatialHeatGrid, interpolateSpatialValueAt, type HeatSample } from "../app/lib/spatial/interpolation";

const EPSILON = 1e-9;

function assertClose(actual: number, expected: number, message: string) {
  assert.ok(
    Math.abs(actual - expected) <= EPSILON,
    `${message}: expected ${expected}, received ${actual}`,
  );
}

test("tested wheel patterns provide translation only, never heading", () => {
  const cases: Array<{
    label: string;
    wheels: WheelSpeedsMmps;
    forwardMmps: number;
    steeringMmps: number;
    driveMmps: number;
  }> = [
    {
      label: "forward",
      wheels: { m1: 120, m2: -120, m3: 120, m4: -120 },
      forwardMmps: 120,
      steeringMmps: 0,
      driveMmps: 120,
    },
    {
      label: "backward",
      wheels: { m1: -120, m2: 120, m3: -120, m4: 120 },
      forwardMmps: -120,
      steeringMmps: 0,
      driveMmps: -120,
    },
    {
      label: "left turn",
      wheels: { m1: -120, m2: -120, m3: 120, m4: 120 },
      forwardMmps: 0,
      steeringMmps: 120,
      driveMmps: 120,
    },
    {
      label: "right turn",
      wheels: { m1: 120, m2: 120, m3: -120, m4: -120 },
      forwardMmps: 0,
      steeringMmps: -120,
      driveMmps: 120,
    },
  ];

  for (const item of cases) {
    const velocity = carBodyVelocity(item.wheels);
    assert.ok(velocity, `${item.label} should produce a valid velocity`);
    assert.equal(velocity.forwardMmps, item.forwardMmps, item.label);
    assert.equal(velocity.steeringMmps, item.steeringMmps, item.label);
    assert.equal(velocity.driveMmps, item.driveMmps, item.label);
    assert.equal(velocity.speedMmps, 120, `${item.label} speed magnitude`);
  }
});

test("Jetson heading is the sole angle input while wheel speed supplies translation", () => {
  const initial: MetricMapPose = { rightM: 0, downM: 0, headingDeg: 0, distanceM: 0 };
  const wheelLeft: WheelSpeedsMmps = { m1: -120, m2: -120, m3: 120, m4: 120 };
  const result = integrateWheelPoseWithJetsonHeading(initial, wheelLeft, 0.1, 10);
  assert.ok(result);
  assertClose(result.headingDeg, 10, "Jetson-only heading");
  assert.ok(result.rightM > 0, "positive clockwise heading bends projected translation right");
  assert.ok(result.downM < 0, "wheel speed still supplies travel distance");
  assertClose(result.distanceM, 0.012, "wheel distance");

  const disconnected = integrateWheelPoseWithJetsonHeading(initial, wheelLeft, 0.5, 10);
  assert.equal(disconnected, null, "a disconnected interval must not mutate position");
});

test("V2 device pose is parsed and transformed relative to its calibrated origin", () => {
  const message = parseJetsonMessage(JSON.stringify({
    type: "odom",
    version: 2,
    seq: 42,
    observedAt: "2026-07-20T08:30:00+08:00",
    data: {
      M1: 10,
      M2: -10,
      M3: 10,
      M4: -10,
      xMm: 2_000,
      yMm: 2_500,
      headingDeg: 60,
    },
  }));

  assert.ok(message);
  assert.equal(message.version, 2);
  assert.equal(message.seq, 42);
  assert.equal(message.observedAt, "2026-07-20T00:30:00.000Z");

  const metric = poseFromDeviceOdometry(
    { headingDeg: 90 },
    { xMm: 1_000, yMm: 2_000, headingDeg: 30 },
    {
      xMm: message.data.xMm!,
      yMm: message.data.yMm!,
      headingDeg: message.data.headingDeg!,
    },
  );
  assertClose(metric.rightM, 0.6160254037844386, "right displacement");
  assertClose(metric.downM, -0.9330127018922193, "down displacement");
  assert.equal(metric.headingDeg, 120);
  assertClose(metric.distanceM, Math.hypot(1, 0.5), "travel distance");

  const mapPose = metricPoseToMapPose(
    metric,
    { x: 0.25, y: 0.4 },
    { widthM: 5, heightM: 10 },
    message.observedAt ?? null,
    "reported",
  );
  assertClose(mapPose.x, 0.3732050807568877, "normalized map x");
  assertClose(mapPose.y, 0.3066987298107781, "normalized map y");
  assert.equal(mapPose.headingDeg, 120);
  assert.equal(mapPose.observedAt, "2026-07-20T00:30:00.000Z");
  assert.equal(mapPose.quality, "reported");

  const documentedV2 = parseJetsonMessage({
    type: "odom",
    version: 2,
    seq: 43,
    timestamp: "2026-07-20T00:30:01.000Z",
    data: {
      M1: 10,
      M2: -10,
      M3: 10,
      M4: -10,
      pose: { x_mm: 2_010, y_mm: 2_500, yaw_deg: 61 },
    },
  });
  assert.ok(documentedV2);
  assert.equal(documentedV2.data.xMm, 2_010);
  assert.equal(documentedV2.data.yMm, 2_500);
  assert.equal(documentedV2.data.headingDeg, 61);
  assert.equal(documentedV2.observedAt, "2026-07-20T00:30:01.000Z");
});

test("a sparse heat layer does not invent a filled surface", () => {
  const sparse: HeatSample[] = [
    { id: "one", x: 0.2, y: 0.2, value: 18, observedAt: "2026-07-20T00:00:00.000Z" },
    { id: "two", x: 0.8, y: 0.8, value: 26, observedAt: "2026-07-20T00:00:10.000Z" },
  ];

  const grid = buildSpatialHeatGrid(sparse, 16, 16, 0.3);
  assert.equal(grid.interpolated, false);
  assert.deepEqual(grid.cells, []);
  assert.equal(grid.min, 18);
  assert.equal(grid.max, 26);
});

test("three non-collinear heat samples interpolate only inside their value range", () => {
  const samples: HeatSample[] = [
    { id: "low", x: 0.2, y: 0.2, value: 10, observedAt: "2026-07-20T00:00:00.000Z" },
    { id: "middle", x: 0.8, y: 0.2, value: 20, observedAt: "2026-07-20T00:00:10.000Z" },
    { id: "high", x: 0.5, y: 0.8, value: 30, observedAt: "2026-07-20T00:00:20.000Z" },
  ];

  const grid = buildSpatialHeatGrid(samples, 24, 24, 0.5);
  assert.equal(grid.interpolated, true);
  assert.equal(grid.min, 10);
  assert.equal(grid.max, 30);
  assert.ok(grid.cells.length > 0);
  for (const cell of grid.cells) {
    assert.ok(cell.value >= 10 && cell.value <= 30, `cell value ${cell.value} escaped source range`);
    assert.ok(cell.x >= 0 && cell.x <= 1, `cell x ${cell.x} escaped map bounds`);
    assert.ok(cell.y >= 0 && cell.y <= 1, `cell y ${cell.y} escaped map bounds`);
  }

  const inspected = interpolateSpatialValueAt(samples, 0.5, 0.35, 0.5);
  assert.ok(inspected);
  assert.ok(inspected.value >= 10 && inspected.value <= 30);
  assert.equal(inspected.support, 3);
  assert.ok(inspected.confidence > 0 && inspected.confidence <= 1);
  assert.equal(interpolateSpatialValueAt(samples, 0.02, 0.98, 0.2), null);
});
