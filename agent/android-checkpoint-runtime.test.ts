import assert from "node:assert/strict";
import test from "node:test";
import {
  createUnavailableVehicle,
  type DashboardSnapshot,
  type TelemetrySlot,
} from "../app/lib/iot/contracts";
import {
  AndroidCheckpointInspectionError,
  findAndroidCheckpoint,
  parseAndroidNavigationContext,
  waitForFreshLiveTelemetry,
} from "../offline/checkpoint-runtime";

test("Android 固定检查点上下文只接受有效归一化坐标并保留中文名称", () => {
  const context = parseAndroidNavigationContext({
    checkpoints: [{
      id: "oil",
      name: "  油　桶  ",
      x: 0.25,
      y: 0.75,
      updatedAt: "2026-07-23T12:00:00.000Z",
    }],
    pose: {
      x: 0.1,
      y: 0.2,
      headingDeg: 450,
      observedAt: "2026-07-23T12:00:01.000Z",
    },
    calibrationConfirmed: true,
    mapRevision: 3,
    controlLink: "connected",
    vehicleConnection: "online",
    imuState: "live",
    mapObservedAt: "2026-07-23T12:00:01.000Z",
    poseObservedAt: "2026-07-23T12:00:01.000Z",
    updatedAt: "2026-07-23T12:00:02.000Z",
  });
  assert.ok(context);
  assert.equal(context.checkpoints[0]?.name, "油 桶");
  assert.equal(context.pose?.headingDeg, 90);
  assert.equal(context.controlLink, "connected");
  assert.equal(context.vehicleConnection, "online");
  assert.equal(context.imuState, "live");
  assert.equal(findAndroidCheckpoint(context, "油　桶")?.id, "oil");
  assert.equal(parseAndroidNavigationContext({
    checkpoints: [{
      id: "outside",
      name: "越界点",
      x: 1.1,
      y: 0.5,
      updatedAt: "2026-07-23T12:00:00.000Z",
    }],
    pose: null,
    calibrationConfirmed: false,
    mapRevision: null,
    updatedAt: "2026-07-23T12:00:02.000Z",
  }), null);
});

test("Android 到点检测等待 2 秒后只接受到点后的 live 新样本", async () => {
  let now = 10_000;
  let reads = 0;
  const snapshot = await waitForFreshLiveTelemetry({
    completedAtMs: 9_000,
    slotIds: ["slot-1"],
    settleMs: 2_000,
    timeoutMs: 5_000,
    pollIntervalMs: 1_000,
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
    readSnapshot: async () => {
      reads += 1;
      return dashboardSnapshot(
        reads === 1
          ? "1970-01-01T00:00:08.000Z"
          : "1970-01-01T00:00:10.000Z",
        "live",
        26,
      );
    },
  });
  assert.equal(reads, 2);
  assert.equal(snapshot.slots["slot-1"].value, 26);
  assert.equal(now, 13_000);
});

test("Android 到点检测不会用 stale 或到点前旧值判断正常", async () => {
  let now = 20_000;
  await assert.rejects(
    waitForFreshLiveTelemetry({
      completedAtMs: 20_000,
      slotIds: ["slot-1"],
      settleMs: 0,
      timeoutMs: 1_500,
      pollIntervalMs: 1_000,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      readSnapshot: async () => dashboardSnapshot(
        "1970-01-01T00:00:19.000Z",
        "stale",
        25,
      ),
    }),
    (error: unknown) => (
      error instanceof AndroidCheckpointInspectionError
      && /状态为stale/.test(error.message)
      && /没有据此判断现场正常或异常/.test(error.message)
    ),
  );
});

test("Android 到点检测会在瞬时读取失败后继续等待新样本", async () => {
  let now = 30_000;
  let reads = 0;
  const snapshot = await waitForFreshLiveTelemetry({
    completedAtMs: 30_000,
    slotIds: ["slot-1"],
    settleMs: 0,
    timeoutMs: 2_000,
    pollIntervalMs: 500,
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
    readSnapshot: async () => {
      reads += 1;
      if (reads === 1) throw new Error("暂时断网");
      return dashboardSnapshot(
        "1970-01-01T00:00:31.000Z",
        "live",
        24,
      );
    },
  });
  assert.equal(reads, 2);
  assert.equal(snapshot.slots["slot-1"].state, "live");
});

function dashboardSnapshot(
  observedAt: string,
  state: TelemetrySlot["state"],
  value: number,
): DashboardSnapshot {
  const slots = Object.fromEntries(
    Array.from({ length: 6 }, (_, index) => {
      const slotId = `slot-${index + 1}` as TelemetrySlot["slotId"];
      return [slotId, {
        slotId,
        sourceKey: `sensor.${slotId}`,
        label: slotId === "slot-1" ? "环境温度" : `数据位${index + 1}`,
        value,
        unit: slotId === "slot-1" ? "°C" : "",
        precision: 0,
        tone: "blue" as const,
        state,
        observedAt,
        supportingText: "",
        auxiliaryReadings: [],
      }];
    }),
  ) as unknown as DashboardSnapshot["slots"];
  return {
    slots,
    vehicle: createUnavailableVehicle(),
    generatedAt: observedAt,
    provider: "huawei-cloud",
    partialErrors: [],
  };
}
