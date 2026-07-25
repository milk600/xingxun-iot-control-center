import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_JETSON_VIDEO_BASE64_LENGTH,
  mergeJetsonNavigationState,
  navigationMapToWire,
  parseJetsonInboundMessage,
  parseJetsonMessage,
} from "../app/lib/iot/jetson-websocket";

const TINY_JPEG = "/9j/2Q==";
const V2_IMU_DATA = {
  ax: 0,
  ay: 0,
  az: 1,
  gx: 0,
  gy: 0,
  gz: -0.4,
  temp: 44,
  yaw_total_deg: 0,
  heading_deg: 0,
  yaw_rate_dps: 0,
  gyro_bias_z_dps: -0.4,
  calibrated: true,
  stationary: true,
  calibration_samples: 126,
  zero_revision: 1,
};
const NAVIGATION_MAP = {
  version: 1 as const,
  mapId: "room-01",
  revision: 3,
  widthM: 4,
  heightM: 5,
  resolutionM: 0.05 as const,
  vehicle: { lengthM: 0, widthM: 0, clearanceM: 0 },
  strokes: [{ id: "wall-a", points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }] }],
};

test("Jetson 入站解析器同时识别里程计、IMU 和 JPEG 视频帧", () => {
  assert.deepEqual(parseJetsonInboundMessage(JSON.stringify({
    type: "odom",
    ts: 1_784_588_200.125,
    data: { M1: 10, M2: -10, M3: 10, M4: -10, fire_detected: true },
  })), {
    type: "odom",
    observedAt: new Date(1_784_588_200_125).toISOString(),
    data: { M1: 10, M2: -10, M3: 10, M4: -10, fireDetected: true },
  });
  assert.equal(parseJetsonInboundMessage({
    type: "odom",
    data: { M1: 0, M2: 0, M3: 0, M4: 0, fire_detected: "true" },
  }), null);

  assert.deepEqual(parseJetsonInboundMessage(JSON.stringify({
    type: "imu",
    version: 2,
    boot_id: "general-test",
    seq: 8,
    timestamp: "2026-07-21T10:30:01+08:00",
    data: { ...V2_IMU_DATA, ax: 0.01, ay: -0.02, az: 0.99, gx: 0.1, gy: -0.2, gz: 1.5, temp: 36.5 },
  })), {
    type: "imu",
    version: 2,
    bootId: "general-test",
    seq: 8,
    observedAt: "2026-07-21T02:30:01.000Z",
    sampledAtMs: Date.parse("2026-07-21T02:30:01.000Z"),
    data: {
      ax: 0.01, ay: -0.02, az: 0.99, gx: 0.1, gy: -0.2, gz: 1.5, temp: 36.5,
      yawTotalDeg: 0, headingDeg: 0, yawRateDps: 0, gyroBiasZDps: -0.4,
      calibrated: true, stationary: true, calibrationSamples: 126, zeroRevision: 1,
    },
  });

  assert.deepEqual(parseJetsonInboundMessage(JSON.stringify({
    type: "video",
    seq: 7,
    observedAt: "2026-07-21T10:30:00+08:00",
    data: TINY_JPEG,
  })), {
    type: "video",
    seq: 7,
    observedAt: "2026-07-21T02:30:00.000Z",
    data: TINY_JPEG,
  });

  assert.equal(parseJetsonMessage(JSON.stringify({ type: "video", data: TINY_JPEG })), null);
});

test("IMU 时间戳兼容 Unix 秒、毫秒与设备单调毫秒", () => {
  const unixSeconds = parseJetsonInboundMessage({
    type: "imu",
    version: 2,
    boot_id: "timestamp-seconds",
    ts: 1_784_588_200.25,
    data: V2_IMU_DATA,
  });
  assert.ok(unixSeconds?.type === "imu");
  assert.equal(unixSeconds.sampledAtMs, 1_784_588_200_250);
  assert.equal(unixSeconds.observedAt, new Date(1_784_588_200_250).toISOString());

  const unixMilliseconds = parseJetsonInboundMessage({
    type: "imu",
    version: 2,
    boot_id: "timestamp-ms",
    timestamp_ms: 1_784_588_200_375,
    data: V2_IMU_DATA,
  });
  assert.ok(unixMilliseconds?.type === "imu");
  assert.equal(unixMilliseconds.sampledAtMs, 1_784_588_200_375);
  assert.equal(unixMilliseconds.observedAt, new Date(1_784_588_200_375).toISOString());

  const monotonic = parseJetsonInboundMessage({
    type: "imu",
    version: 2,
    boot_id: "timestamp-monotonic",
    monotonic_ms: 123_456.75,
    data: V2_IMU_DATA,
  });
  assert.ok(monotonic?.type === "imu");
  assert.equal(monotonic.sampledAtMs, 123_456.75);
  assert.equal(monotonic.observedAt, undefined);
});

test("IMU V2 接收 Jetson 本地累计航向和网络延时", () => {
  assert.deepEqual(parseJetsonInboundMessage({
    type: "imu",
    version: 2,
    boot_id: "1721628000-1234",
    seq: 12580,
    ts: 1_784_588_200.25,
    monotonic_ms: 8_435_123.5,
    data: {
      ax: 0.01,
      ay: -0.02,
      az: 1.01,
      gx: 0.1,
      gy: -0.2,
      gz: -0.4,
      temp: 43.1,
      yaw_total_deg: 451.42,
      heading_deg: 91.42,
      yaw_rate_dps: 0.03,
      gyro_bias_z_dps: -0.373,
      calibrated: true,
      stationary: true,
      calibration_samples: 126,
      zero_revision: 1,
      network_rtt_ms: 12.4,
      network_one_way_ms: 6.2,
    },
  }), {
    type: "imu",
    version: 2,
    bootId: "1721628000-1234",
    seq: 12580,
    observedAt: new Date(1_784_588_200_250).toISOString(),
    sampledAtMs: 8_435_123.5,
    data: {
      ax: 0.01,
      ay: -0.02,
      az: 1.01,
      gx: 0.1,
      gy: -0.2,
      gz: -0.4,
      temp: 43.1,
      yawTotalDeg: 451.42,
      headingDeg: 91.42,
      yawRateDps: 0.03,
      gyroBiasZDps: -0.373,
      calibrated: true,
      stationary: true,
      calibrationSamples: 126,
      zeroRevision: 1,
      networkRttMs: 12.4,
      networkOneWayMs: 6.2,
    },
  });

  const pendingLatency = parseJetsonInboundMessage({
    type: "imu",
    version: 2,
    boot_id: "pending-latency",
    data: {
      ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, temp: 40,
      yaw_total_deg: 0, heading_deg: 0, yaw_rate_dps: 0, gyro_bias_z_dps: 0,
      calibrated: false, stationary: true, calibration_samples: 10, zero_revision: 0,
      network_rtt_ms: null, network_one_way_ms: null,
    },
  });
  assert.ok(pendingLatency?.type === "imu");
  assert.equal(pendingLatency.data.networkRttMs, null);
});

test("IMU 校验拒绝缺字段、非有限值和越界读数", () => {
  assert.equal(parseJetsonInboundMessage({
    type: "imu",
    data: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, temp: 30 },
  }), null);
  assert.equal(parseJetsonInboundMessage({
    type: "imu",
    data: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: Number.NaN, temp: 30 },
  }), null);
  assert.equal(parseJetsonInboundMessage({
    type: "imu",
    data: { ax: 21, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, temp: 30 },
  }), null);
  assert.equal(parseJetsonInboundMessage({
    type: "imu",
    data: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, temp: 150 },
  }), null);
  assert.equal(parseJetsonInboundMessage({
    type: "imu",
    data: {
      ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, temp: 30,
      yaw_total_deg: 90, heading_deg: 90, yaw_rate_dps: 0, gyro_bias_z_dps: 0,
      calibrated: true, stationary: true, calibration_samples: 24, zero_revision: 1,
      network_rtt_ms: -1,
    },
  }), null);
});

test("IMU V1 原始数据不再进入航向链路", () => {
  assert.equal(parseJetsonInboundMessage({
    type: "imu",
    seq: 1,
    data: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: -0.4, temp: 44 },
  }), null);
});

test("视频帧校验拒绝非法 Base64、非 JPEG 和超大载荷", () => {
  assert.equal(parseJetsonInboundMessage({ type: "video", data: "not-base64" }), null);
  assert.equal(parseJetsonInboundMessage({ type: "video", data: "iVBORw0K" }), null);
  assert.equal(parseJetsonInboundMessage({
    type: "video",
    data: `/9j/${"A".repeat(MAX_JETSON_VIDEO_BASE64_LENGTH)}`,
  }), null);
});

test("无效视频不会影响随后到达的有效里程计", () => {
  assert.equal(parseJetsonInboundMessage({ type: "video", data: "/9j/%%%=" }), null);
  assert.deepEqual(parseJetsonInboundMessage({
    type: "odom",
    data: { M1: 1, M2: -2, M3: 3, M4: -4 },
  }), {
    type: "odom",
    data: { M1: 1, M2: -2, M3: 3, M4: -4 },
  });
});

test("导航协议解析地图、规划路线与 Jetson 位姿", () => {
  const mapReady = parseJetsonInboundMessage({
    type: "navigation",
    version: 1,
    state: "map-ready",
    map_revision: 3,
    ready: true,
    map: navigationMapToWire(NAVIGATION_MAP),
  });
  assert.ok(mapReady?.type === "navigation");
  assert.deepEqual(mapReady.map, NAVIGATION_MAP);

  const running = parseJetsonInboundMessage({
    type: "navigation",
    version: 1,
    state: "running",
    request_id: "request-1",
    task_id: "task-1",
    map_revision: 3,
    phase: "replanning",
    path: [{ x: 0.2, y: 0.3 }, { x: 0.7, y: 0.6 }],
    pose: { x: 0.4, y: 0.45, heading_deg: 92.5 },
    distance_m: 2.4,
    remaining_distance_m: 1.2,
    segment_index: 1,
    segment_count: 2,
    path_revision: 3,
    replan_count: 2,
    recovery_replan_count: 1,
    replan_reason: "turn-timeout",
    completion_quality: "tolerance",
    elapsed_ms: 4_200,
    output_speed_mmps: 180,
  });
  assert.ok(running?.type === "navigation");
  assert.deepEqual(running.pose, { x: 0.4, y: 0.45, headingDeg: 92.5 });
  assert.equal(running.remainingDistanceM, 1.2);
  assert.equal(running.phase, "replanning");
  assert.equal(running.pathRevision, 3);
  assert.equal(running.replanReason, "turn-timeout");
  assert.equal(running.completionQuality, "tolerance");
});

test("导航协议拒绝非法地图、越界点和超大路径", () => {
  const unsafeMap = navigationMapToWire(NAVIGATION_MAP);
  unsafeMap.vehicle.clearance_m = 0.01;
  assert.equal(parseJetsonInboundMessage({
    type: "navigation", version: 1, state: "map-ready", map: unsafeMap,
  }), null);
  assert.equal(parseJetsonInboundMessage({
    type: "navigation", version: 1, state: "planned", path: [{ x: 1.1, y: 0.5 }],
  }), null);
  assert.equal(parseJetsonInboundMessage({
    type: "navigation",
    version: 1,
    state: "planned",
    path: Array.from({ length: 4_097 }, () => ({ x: 0.5, y: 0.5 })),
  }), null);
});

test("导航状态合并保留设备地图并拒绝同任务乱序回退", () => {
  const receivedAt = "2026-07-22T10:00:00.000Z";
  const ready = mergeJetsonNavigationState(null, {
    type: "navigation", version: 1, state: "map-ready", mapRevision: 3, map: NAVIGATION_MAP,
  }, receivedAt);
  const planned = mergeJetsonNavigationState(ready, {
    type: "navigation", version: 1, state: "planned", mapRevision: 3, taskId: "task-1",
  }, receivedAt);
  assert.deepEqual(planned.map, NAVIGATION_MAP);
  const running = mergeJetsonNavigationState(planned, {
    type: "navigation", version: 1, state: "running", mapRevision: 3, taskId: "task-1",
    pathRevision: 4, path: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }],
  }, receivedAt);
  const stalePlanned = mergeJetsonNavigationState(running, {
    type: "navigation", version: 1, state: "planned", mapRevision: 3, taskId: "task-1",
  }, receivedAt);
  assert.equal(stalePlanned.state, "running");
  const stalePath = mergeJetsonNavigationState(running, {
    type: "navigation", version: 1, state: "running", mapRevision: 3, taskId: "task-1",
    pathRevision: 3, path: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }],
  }, receivedAt);
  assert.equal(stalePath.pathRevision, 4);
  assert.deepEqual(stalePath.path, running.path);

  const revisedMap = { ...NAVIGATION_MAP, revision: 4 };
  const nextReady = mergeJetsonNavigationState(planned, {
    type: "navigation", version: 1, state: "map-ready", mapRevision: 4, map: revisedMap,
  }, receivedAt);
  assert.equal(nextReady.state, "map-ready");
  assert.equal(nextReady.mapRevision, 4);
});
