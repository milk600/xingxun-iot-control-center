import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TELEMETRY_SLOT_IDS,
  type DataState,
  type TelemetrySlot,
  type TelemetrySlotId,
  type TelemetrySlots,
} from "../app/lib/iot/contracts";
import {
  TelemetryStore,
  computeDeterministicAnalysis,
  createTelemetryCollector,
  parseTelemetryPollIntervalMs,
  resolveTelemetryPollIntervalMs,
  toTelemetryEventsResult,
  type TelemetrySample,
} from "./telemetry-store";

const BASE_MS = Date.parse("2026-07-20T00:00:00.000Z");

test("poll interval defaults to one second and keeps the legacy supported-value fallback", () => {
  assert.equal(resolveTelemetryPollIntervalMs({}), 1_000);
  assert.equal(resolveTelemetryPollIntervalMs({ TELEMETRY_SAMPLE_INTERVAL_MS: "5000" }), 5_000);
  assert.equal(resolveTelemetryPollIntervalMs({
    TELEMETRY_POLL_INTERVAL_MS: "3500",
    TELEMETRY_SAMPLE_INTERVAL_MS: "10000",
  }), 3_500);
  assert.equal(resolveTelemetryPollIntervalMs({ TELEMETRY_SAMPLE_INTERVAL_MS: "2000" }), 1_000);
  assert.throws(() => parseTelemetryPollIntervalMs(2_000), /仅支持 1、3.5、5 或 10 秒/);
});

function slot(
  value: number | null,
  observedAtMs: number,
  options: {
    slotId?: TelemetrySlotId;
    state?: DataState;
    label?: string;
    unit?: string;
    precision?: number;
    lightRaw?: number | null;
    auxiliaryReadings?: TelemetrySlot["auxiliaryReadings"];
  } = {},
) {
  return {
    slotId: options.slotId ?? "slot-1",
    sourceKey: "Environment.test",
    label: options.label ?? "测试指标",
    value,
    unit: options.unit ?? "u",
    precision: options.precision ?? 1,
    tone: "blue",
    state: options.state ?? "live",
    observedAt: new Date(observedAtMs).toISOString(),
    supportingText: "测试",
    auxiliaryReadings: options.auxiliaryReadings ?? [],
    lightRaw: options.lightRaw,
  } as TelemetrySlot & { lightRaw?: number | null };
}

function temporaryStore(options: ConstructorParameters<typeof TelemetryStore>[0] = {}) {
  const directory = mkdtempSync(join(tmpdir(), "xingxun-telemetry-"));
  const store = new TelemetryStore({ path: join(directory, "history.sqlite"), ...options });
  return {
    store,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("collector settings persist across store reopen without changing the expected sample interval", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingxun-collector-settings-"));
  const path = join(directory, "history.sqlite");
  const first = new TelemetryStore({ path });
  try {
    assert.equal(first.expectedIntervalMs, 10_000);
    assert.equal(first.readCollectorSettings(1_000).pollIntervalMs, 1_000);
    const saved = first.saveCollectorSettings(3_500, "电脑显示端", BASE_MS);
    assert.equal(saved.pollIntervalMs, 3_500);
    assert.equal(saved.updatedAt, new Date(BASE_MS).toISOString());
  } finally {
    first.close();
  }

  const reopened = new TelemetryStore({ path });
  try {
    assert.equal(reopened.readCollectorSettings(1_000).pollIntervalMs, 3_500);
    assert.equal(reopened.expectedIntervalMs, 10_000);
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stores zero and auxiliary readings while deduplicating observedAt plus slotId", () => {
  const fixture = temporaryStore();
  try {
    const first = fixture.store.recordSlots({
      "slot-1": slot(0, BASE_MS, {
        auxiliaryReadings: [{
          sourceKey: "Environment.lightRaw",
          label: "光照原始值",
          value: 17,
          unit: "raw",
          precision: 0,
        }],
      }),
    }, "huawei-cloud", BASE_MS + 100);
    const duplicate = fixture.store.recordSlots({
      "slot-1": slot(99, BASE_MS, {
        auxiliaryReadings: [{
          sourceKey: "Environment.lightRaw",
          label: "光照原始值",
          value: 999,
          unit: "raw",
          precision: 0,
        }],
      }),
    }, "huawei-cloud", BASE_MS + 200);

    assert.deepEqual(first, { inserted: 1, duplicates: 0, missingObservedAt: 0, events: 0 });
    assert.equal(duplicate.inserted, 0);
    assert.equal(duplicate.duplicates, 1);
    const samples = fixture.store.querySamples({ from: BASE_MS, to: BASE_MS + 1_000 });
    assert.equal(samples.length, 1);
    assert.equal(samples[0].value, 0);
    assert.ok(Array.isArray(samples[0].auxiliaryReadings));
    if (Array.isArray(samples[0].auxiliaryReadings)) {
      assert.deepEqual(samples[0].auxiliaryReadings[0], {
        sourceKey: "Environment.lightRaw",
        label: "光照原始值",
        value: 17,
        unit: "raw",
        precision: 0,
      });
    }
    assert.equal(samples[0].provider, "huawei-cloud");
  } finally {
    fixture.cleanup();
  }
});

test("aggregates minute buckets with min, max, average, last, and numeric count", () => {
  const fixture = temporaryStore();
  try {
    for (const [offset, value] of [[0, 0], [10_000, 10], [20_000, 20]] as const) {
      fixture.store.recordSlots({ "slot-1": slot(value, BASE_MS + offset) }, "mock", BASE_MS + offset);
    }
    const result = fixture.store.queryHistory({
      from: BASE_MS,
      to: BASE_MS + 59_999,
      slotIds: ["slot-1"],
      resolution: "1m",
    });
    assert.equal(result.resolution, "1m");
    assert.equal(result.buckets.length, 1);
    assert.deepEqual(
      {
        min: result.buckets[0].min,
        max: result.buckets[0].max,
        average: result.buckets[0].average,
        last: result.buckets[0].last,
        count: result.buckets[0].count,
      },
      { min: 0, max: 20, average: 10, last: 20, count: 3 },
    );
  } finally {
    fixture.cleanup();
  }
});

test("prunes samples and resolved events outside the configured retention window", () => {
  const fixture = temporaryStore({ retentionDays: 1 });
  try {
    fixture.store.recordSlots({ "slot-1": slot(1, BASE_MS) }, "mock", BASE_MS);
    fixture.store.recordSlots({ "slot-1": slot(2, BASE_MS + 2 * 24 * 60 * 60_000) }, "mock", BASE_MS + 2 * 24 * 60 * 60_000);
    const result = fixture.store.prune(BASE_MS + 2 * 24 * 60 * 60_000);
    assert.equal(result.samples, 1);
    const remaining = fixture.store.querySamples({
      from: BASE_MS,
      to: BASE_MS + 3 * 24 * 60 * 60_000,
    });
    assert.deepEqual(remaining.map((sample) => sample.value), [2]);
  } finally {
    fixture.cleanup();
  }
});

test("persists history after the SQLite database is closed and reopened", () => {
  const directory = mkdtempSync(join(tmpdir(), "xingxun-telemetry-reopen-"));
  const path = join(directory, "history.sqlite");
  try {
    const first = new TelemetryStore({ path });
    first.recordSlots({ "slot-1": slot(12, BASE_MS) }, "mock", BASE_MS);
    first.close();

    const reopened = new TelemetryStore({ path });
    try {
      const samples = reopened.querySamples({ from: BASE_MS, to: BASE_MS + 1_000 });
      assert.equal(samples.length, 1);
      assert.equal(samples[0].value, 12);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("records state changes for duplicate observations without manufacturing samples", () => {
  const fixture = temporaryStore();
  try {
    fixture.store.recordSlots({ "slot-1": slot(7, BASE_MS, { state: "live" }) }, "huawei-cloud", BASE_MS);
    fixture.store.recordSlots({ "slot-1": slot(7, BASE_MS, { state: "stale" }) }, "huawei-cloud", BASE_MS + 40_000);
    fixture.store.recordSlots({ "slot-1": slot(7, BASE_MS, { state: "offline" }) }, "huawei-cloud", BASE_MS + 100_000);
    fixture.store.recordSlots({ "slot-1": slot(7, BASE_MS, { state: "live" }) }, "huawei-cloud", BASE_MS + 110_000);

    const samples = fixture.store.querySamples({ from: BASE_MS, to: BASE_MS + 1 });
    assert.equal(samples.length, 1);
    assert.equal(samples[0].state, "live");
    const events = fixture.store.queryEvents({ from: BASE_MS, to: BASE_MS + 120_000 });
    assert.equal(events.filter((event) => event.type === "state-change").length, 3);
    assert.equal(events.filter((event) => event.type === "recovery").length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("collector starts immediately, retries a failed provider, and exposes collector-error", async () => {
  const fixture = temporaryStore();
  let calls = 0;
  let errors = 0;
  const slots = Object.fromEntries(TELEMETRY_SLOT_IDS.map((slotId, index) => [
    slotId,
    slot(index, BASE_MS + 10_000, { slotId }),
  ])) as TelemetrySlots;
  const collector = createTelemetryCollector({
    store: fixture.store,
    intervalMs: 5,
    failureBackoffMaxMs: 10,
    retentionIntervalMs: 60_000,
    provider: {
      kind: "mock",
      async readTelemetrySlots() {
        calls += 1;
        if (calls === 1) throw new Error("temporary provider failure");
        return slots;
      },
    },
    onError() {
      errors += 1;
    },
  });
  try {
    await collector.start();
    await waitUntil(() => calls >= 2 && collector.status().lastSuccessAt !== null);
    await collector.stop();
    assert.equal(errors, 1);
    assert.equal(fixture.store.querySamples({ from: BASE_MS, to: BASE_MS + 20_000 }).length, 6);
    const storedEvents = fixture.store.queryEvents({ from: BASE_MS, to: Date.now() + 1_000 });
    const publicEvents = toTelemetryEventsResult("collector-test", {
      from: new Date(BASE_MS).toISOString(),
      to: new Date(Date.now() + 1_000).toISOString(),
    }, storedEvents);
    assert.ok(publicEvents.events.some((event) => event.type === "collector-error"));
    assert.ok(publicEvents.events.some((event) => event.type === "recovery"));
  } finally {
    await collector.stop();
    fixture.cleanup();
  }
});

test("collector request timeout is independent from polling and keeps reads single-flight", async () => {
  const fixture = temporaryStore();
  let calls = 0;
  let receivedSignal: AbortSignal | undefined;
  let fallbackTimer: NodeJS.Timeout | undefined;
  const collector = createTelemetryCollector({
    store: fixture.store,
    intervalMs: 5,
    requestTimeoutMs: 100,
    failureBackoffMaxMs: 100,
    now: () => BASE_MS,
    provider: {
      kind: "mock",
      async readTelemetrySlots({ signal }) {
        calls += 1;
        receivedSignal = signal;
        return new Promise<TelemetrySlots>((_resolve, reject) => {
          fallbackTimer = setTimeout(() => reject(new Error("request timeout was not applied")), 500);
          signal?.addEventListener("abort", () => {
            if (fallbackTimer) clearTimeout(fallbackTimer);
            reject(signal.reason);
          }, { once: true });
        });
      },
    },
  });
  try {
    const firstRun = collector.start();
    await waitUntil(() => calls === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await collector.collectOnce();
    assert.equal(calls, 1, "a poll interval shorter than the request must not overlap it");

    await firstRun;
    assert.equal(receivedSignal?.aborted, true, "the independent request deadline must abort the provider");
    assert.equal(collector.status().consecutiveFailures, 1);
    assert.equal(collector.status().nextAttemptAt, new Date(BASE_MS + 5).toISOString());
  } finally {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    await collector.stop();
    fixture.cleanup();
  }
});

test("collector reconfigures the next poll without overlapping an active read", async () => {
  const fixture = temporaryStore();
  let calls = 0;
  let releaseRead: () => void = () => {};
  const readBarrier = new Promise<void>((resolve) => { releaseRead = resolve; });
  const slots = Object.fromEntries(TELEMETRY_SLOT_IDS.map((slotId, index) => [
    slotId,
    slot(index, BASE_MS, { slotId }),
  ])) as TelemetrySlots;
  const collector = createTelemetryCollector({
    store: fixture.store,
    intervalMs: 1_000,
    now: () => BASE_MS,
    provider: {
      kind: "mock",
      async readTelemetrySlots() {
        calls += 1;
        await readBarrier;
        return slots;
      },
    },
  });
  try {
    const firstRead = collector.collectOnce();
    await collector.collectOnce();
    assert.equal(calls, 1);
    collector.setPollIntervalMs(3_500);
    assert.equal(collector.status().pollIntervalMs, 3_500);
    releaseRead();
    await firstRead;
  } finally {
    releaseRead();
    await collector.stop();
    fixture.cleanup();
  }
});

test("creates persistent flatline and gap events without duplicating active flatlines", () => {
  const fixture = temporaryStore({ expectedIntervalMs: 10_000 });
  try {
    for (let index = 0; index < 21; index += 1) {
      fixture.store.recordSlots({ "slot-1": slot(8, BASE_MS + index * 10_000) }, "mock", BASE_MS + index * 10_000);
    }
    fixture.store.recordSlots({ "slot-1": slot(9, BASE_MS + 300_000) }, "mock", BASE_MS + 300_000);
    const events = fixture.store.queryEvents({ from: BASE_MS, to: BASE_MS + 400_000 });
    assert.equal(events.filter((event) => event.type === "flatline").length, 1);
    assert.ok(events.some((event) => event.type === "gap"));
    assert.ok(events.some((event) => event.type === "recovery"));
  } finally {
    fixture.cleanup();
  }
});

test("deterministic analysis computes robust statistics, synchronized correlation, and anomalies", () => {
  const samples: TelemetrySample[] = [];
  for (let index = 0; index < 25; index += 1) {
    const observedAt = new Date(BASE_MS + index * 10_000).toISOString();
    samples.push(sampleForAnalysis("slot-1", index, observedAt, "温度"));
    samples.push(sampleForAnalysis("slot-2", index * 2, observedAt, "湿度"));
    samples.push(sampleForAnalysis("slot-3", index === 24 ? 50 : 5, observedAt, "气体"));
  }
  samples.push({ ...samples[0], value: 999 });

  const analysis = computeDeterministicAnalysis(samples, {
    from: BASE_MS,
    to: BASE_MS + 240_000,
    expectedIntervalMs: 10_000,
  });
  const first = analysis.summaries.find((summary) => summary.slotId === "slot-1")!;
  assert.equal(first.count, 25);
  assert.equal(first.minimum, 0);
  assert.equal(first.maximum, 24);
  assert.equal(first.median, 12);
  assert.equal(first.iqr, 12);
  assert.equal(first.coverage, 1);
  const correlation = analysis.correlations.find((item) => item.leftSlotId === "slot-1" && item.rightSlotId === "slot-2");
  assert.ok(correlation);
  assert.equal(correlation.pairCount, 25);
  assert.ok(correlation.coefficient > 0.999);
  assert.ok(analysis.anomalies.some((anomaly) => anomaly.slotId === "slot-3" && anomaly.value === 50));
  assert.ok(analysis.facts.every((fact) => fact.factId.length > 0));
});

test("threshold rules create one alert after two samples and keep work orders open after source recovery", () => {
  const fixture = temporaryStore();
  try {
    const rules = fixture.store.listAlertRules().map((rule) => rule.slotId === "slot-1"
      ? { ...rule, enabled: true, upperLimit: 10 }
      : rule);
    fixture.store.saveAlertRules({ rules, actor: "测试员" });

    fixture.store.recordSlots({ "slot-1": slot(12, BASE_MS) }, "mock", BASE_MS);
    assert.equal(fixture.store.queryAlertWorkOrders().items.filter((item) => item.sourceType === "threshold").length, 0);
    fixture.store.recordSlots({ "slot-1": slot(12, BASE_MS) }, "mock", BASE_MS + 1_000);
    assert.equal(fixture.store.queryAlertWorkOrders().items.filter((item) => item.sourceType === "threshold").length, 0, "duplicate observations do not advance the debounce counter");
    fixture.store.recordSlots({ "slot-1": slot(13, BASE_MS + 10_000) }, "mock", BASE_MS + 10_000);
    const created = fixture.store.queryAlertWorkOrders().items.find((item) => item.sourceType === "threshold");
    assert.ok(created);
    assert.equal(created.sourceState, "active");
    assert.equal(created.status, "pending");

    fixture.store.recordSlots({ "slot-1": slot(9, BASE_MS + 20_000) }, "mock", BASE_MS + 20_000);
    fixture.store.recordSlots({ "slot-1": slot(8, BASE_MS + 30_000) }, "mock", BASE_MS + 30_000);
    const recovered = fixture.store.readAlertWorkOrder(created.id);
    assert.equal(recovered?.sourceState, "resolved");
    assert.equal(recovered?.status, "pending");
    assert.ok(recovered?.timeline.some((entry) => entry.type === "source-recovered"));
  } finally {
    fixture.cleanup();
  }
});

test("Jetson 火焰状态立即创建去重严重告警并在火焰消失后标记源恢复", () => {
  const fixture = temporaryStore();
  try {
    const detected = fixture.store.recordVehicleFireState(true, BASE_MS, "display-test");
    assert.equal(detected.changed, true);
    const duplicate = fixture.store.recordVehicleFireState(true, BASE_MS + 1_000, "display-test");
    assert.equal(duplicate.changed, false);

    const pending = fixture.store.queryAlertWorkOrders({ statuses: ["pending"] }).items;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.title, "检测到火焰");
    assert.equal(pending[0]?.severity, "critical");
    assert.equal(pending[0]?.sourceState, "active");
    assert.equal(pending[0]?.slotId, null);
    assert.equal(pending[0]?.evidence.fireDetected, true);

    const cleared = fixture.store.recordVehicleFireState(false, BASE_MS + 2_000, "display-test");
    assert.equal(cleared.changed, true);
    const recovered = fixture.store.readAlertWorkOrder(pending[0]!.id);
    assert.equal(recovered?.sourceState, "resolved");
    assert.equal(recovered?.status, "pending");
    assert.equal(recovered?.timeline.filter((entry) => entry.type === "source-recovered").length, 1);

    fixture.store.recordVehicleFireState(true, BASE_MS + 3_000, "display-test");
    assert.equal(fixture.store.queryAlertWorkOrders().items.filter((item) => item.title === "检测到火焰").length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("new telemetry stores expose six disabled threshold rules", () => {
  const fixture = temporaryStore();
  try {
    const rules = fixture.store.listAlertRules();
    assert.deepEqual(rules.map((rule) => rule.slotId), [
      "slot-1",
      "slot-2",
      "slot-3",
      "slot-4",
      "slot-5",
      "slot-6",
    ]);
    assert.ok(rules.every((rule) => !rule.enabled && rule.lowerLimit === null && rule.upperLimit === null));
  } finally {
    fixture.cleanup();
  }
});

test("alert work orders enforce versioned begin and complete transitions", () => {
  const fixture = temporaryStore();
  try {
    fixture.store.recordCollectionFailure(new Error("network unavailable"), BASE_MS);
    const pending = fixture.store.queryAlertWorkOrders({ statuses: ["pending"] }).items[0];
    assert.ok(pending);
    const processing = fixture.store.beginAlertWorkOrder(pending.id, pending.version, "测试员");
    assert.equal(processing.status, "processing");
    assert.throws(() => fixture.store.beginAlertWorkOrder(pending.id, pending.version, "测试员"), /更新|刷新|version/i);
    const completed = fixture.store.completeAlertWorkOrder({
      alertId: processing.id,
      expectedVersion: processing.version,
      actor: "测试员",
      action: "restore-connection",
      note: "已恢复采集连接",
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.timeline.at(-1)?.type, "completed");
    assert.equal(fixture.store.queryAlertWorkOrders().summary.completed, 1);
  } finally {
    fixture.cleanup();
  }
});

test("clearing test alerts suppresses existing source events without deleting telemetry history or rules", () => {
  const fixture = temporaryStore();
  try {
    fixture.store.recordCollectionFailure(new Error("test network failure"), BASE_MS);
    assert.equal(fixture.store.queryAlertWorkOrders().summary.pending, 1);
    const beforeRules = fixture.store.listAlertRules();
    const cleared = fixture.store.clearAlertWorkOrders();
    assert.equal(cleared.clearedCount, 1);
    assert.equal(fixture.store.queryAlertWorkOrders().items.length, 0);
    assert.deepEqual(fixture.store.listAlertRules(), beforeRules);
  } finally {
    fixture.cleanup();
  }
});

function sampleForAnalysis(slotId: string, value: number | null, observedAt: string, label: string): TelemetrySample {
  return {
    slotId,
    observedAt,
    ingestedAt: observedAt,
    value,
    state: "live",
    provider: "test",
    sourceKey: `Environment.${slotId}`,
    label,
    unit: "u",
    precision: 1,
    auxiliaryReadings: {},
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for collector");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
