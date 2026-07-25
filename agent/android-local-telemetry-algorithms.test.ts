import assert from "node:assert/strict";
import test from "node:test";
import type { AlertRule, AlertWorkOrder } from "../app/lib/alerts/contracts";
import type { DataState, TelemetrySlotId } from "../app/lib/iot/contracts";
import {
  analyzeAndroidTelemetry,
  beginAndroidAlertOrder,
  completeAndroidAlertOrder,
  createAndroidIndependentObservationCounter,
  detectAndroidDuplicateObservationStateEvents,
  detectAndroidTelemetryEvents,
  synchronizeAndroidTelemetryEventOrders,
  transitionAndroidCollectorFailure,
  transitionAndroidCollectorRecovery,
  transitionAndroidVehicleFire,
  validateCompleteAndroidAlertRules,
  type AndroidTelemetrySample,
} from "../offline/local-telemetry-algorithms";

const BASE_TIME_MS = Date.parse("2026-07-23T00:00:00.000Z");

test("Android 按 10 秒真实上报间隔计算覆盖率，不受 1 秒轮询影响", () => {
  const samples = Array.from({ length: 20 }, (_, index) => (
    telemetrySample("slot-1", index, 20 + index / 10)
  ));
  const analysis = analyzeAndroidTelemetry(samples, {
    from: at(0),
    to: at(19),
    expectedIntervalMs: 10_000,
    slotIds: ["slot-1"],
  });

  assert.equal(analysis.reportCount, 20);
  assert.equal(analysis.coverage, 1);
  assert.equal(analysis.summaries[0]?.coverage, 1);
  assert.equal(analysis.quality, "high");
  assert.equal(
    analysis.facts.find((fact) => fact.kind === "data-quality")?.values.coverage,
    1,
  );
});

test("精确覆盖计数独立于绘图下采样，并且不会被其他槽位更新时间抬高", () => {
  const counter = createAndroidIndependentObservationCounter(["slot-1"]);
  for (let snapshotIndex = 0; snapshotIndex < 15_000; snapshotIndex += 1) {
    const requestedObservation = Math.floor(snapshotIndex / 750);
    counter.add("slot-1", at(requestedObservation), true);
    counter.add("slot-2", new Date(BASE_TIME_MS + snapshotIndex * 1_000).toISOString(), true);
  }
  const observations = counter.result();
  assert.equal(observations.uniqueObservations, 20);
  assert.equal(observations.slotObservationCounts["slot-1"], 20);
  assert.equal(observations.slotNumericCounts["slot-1"], 20);
  assert.equal(observations.slotObservationCounts["slot-2"], undefined);

  // Simulate a bounded chart payload retaining only the first and last point.
  const analysis = analyzeAndroidTelemetry([
    telemetrySample("slot-1", 0, 1),
    telemetrySample("slot-1", 19, 20),
  ], {
    from: at(0),
    to: at(19),
    expectedIntervalMs: 10_000,
    slotIds: ["slot-1"],
    exactReportCount: observations.uniqueObservations,
    exactSlotObservationCounts: observations.slotObservationCounts,
    exactSlotNumericCounts: observations.slotNumericCounts,
  });
  assert.equal(analysis.reportCount, 20);
  assert.equal(analysis.coverage, 1);
  assert.equal(analysis.summaries[0]?.count, 20);
  assert.equal(analysis.summaries[0]?.coverage, 1);
});

test("Android 只在至少 12 对同步独立观测上计算 Pearson 相关性", () => {
  const samples = Array.from({ length: 12 }, (_, index) => [
    telemetrySample("slot-1", index, index + 1),
    telemetrySample("slot-2", index, (index + 1) * 2),
  ]).flat();
  const analysis = analyzeAndroidTelemetry(samples, {
    from: at(0),
    to: at(11),
    expectedIntervalMs: 10_000,
    slotIds: ["slot-1", "slot-2"],
  });

  assert.equal(analysis.correlations.length, 1);
  assert.equal(analysis.correlations[0]?.pairCount, 12);
  assert.ok(Math.abs((analysis.correlations[0]?.coefficient ?? 0) - 1) < 1e-12);
  const fact = analysis.facts.find((item) => item.kind === "co-movement");
  assert.equal(fact?.values.pairCount, 12);
  assert.match(fact?.statement ?? "", /不代表因果/);

  const insufficient = analyzeAndroidTelemetry(samples.slice(0, 22), {
    from: at(0),
    to: at(10),
    expectedIntervalMs: 10_000,
    slotIds: ["slot-1", "slot-2"],
  });
  assert.equal(insufficient.correlations.length, 0);
});

test("Android 稳健异常检测覆盖 MAD、IQR 和 flat-baseline", () => {
  const madBaseline = Array.from({ length: 20 }, (_, index) => index);
  const iqrBaseline = [...Array<number>(15).fill(0), ...Array<number>(5).fill(1)];
  const flatBaseline = Array<number>(20).fill(5);
  const samples = Array.from({ length: 21 }, (_, index) => [
    telemetrySample("slot-1", index, index < 20 ? madBaseline[index] : 100),
    telemetrySample("slot-2", index, index < 20 ? iqrBaseline[index] : 10),
    telemetrySample("slot-3", index, index < 20 ? flatBaseline[index] : 6),
  ]).flat();
  const analysis = analyzeAndroidTelemetry(samples, {
    from: at(0),
    to: at(20),
    expectedIntervalMs: 10_000,
    slotIds: ["slot-1", "slot-2", "slot-3"],
  });

  assert.deepEqual(
    Object.fromEntries(analysis.anomalies.map((item) => [item.slotId, item.method])),
    {
      "slot-1": "mad",
      "slot-2": "iqr",
      "slot-3": "flat-baseline",
    },
  );
  assert.equal(
    analysis.facts.filter((fact) => fact.kind === "variability").length,
    3,
  );
  assert.ok(analysis.findings.some((finding) => finding.id === "local-finding-anomaly"));
  assert.ok(analysis.caveats.some((caveat) => /医学.*法规/.test(caveat)));
});

test("Android 检测 gap、状态恢复、20 点平线及平线恢复", () => {
  const flatSamples = Array.from({ length: 20 }, (_, index) => (
    telemetrySample("slot-1", index, 8)
  ));
  const activeEvents = detectAndroidTelemetryEvents(flatSamples);
  const activeFlatline = activeEvents.find((event) => event.type === "flatline");
  assert.equal(activeFlatline?.status, "active");
  assert.equal(activeFlatline?.evidence.count, 20);

  const resolvedEvents = detectAndroidTelemetryEvents([
    ...flatSamples,
    telemetrySample("slot-1", 20, 9),
  ], {
    existingActiveFlatlines: activeFlatline ? [activeFlatline] : [],
  });
  const resolvedFlatline = resolvedEvents.find((event) => event.type === "flatline");
  assert.equal(resolvedFlatline?.id, activeFlatline?.id);
  assert.equal(resolvedFlatline?.status, "resolved");
  assert.equal(resolvedFlatline?.endedAt, at(20));
  assert.ok(resolvedEvents.some((event) => (
    event.type === "recovery"
    && event.evidence.recoveredEventType === "flatline"
  )));

  const linkEvents = detectAndroidTelemetryEvents([
    telemetrySample("slot-2", 0, 1, "live"),
    telemetrySample("slot-2", 4, 1, "offline"),
    telemetrySample("slot-2", 5, 1, "live"),
  ]);
  assert.ok(linkEvents.some((event) => event.type === "data-gap"));
  assert.ok(linkEvents.some((event) => (
    event.type === "state-change" && event.severity === "critical"
  )));
  assert.ok(linkEvents.some((event) => (
    event.type === "recovery" && event.evidence.from === "offline"
  )));
});

test("旧平线恢复后形成的新平线必须获得新事件 ID", () => {
  const firstRun = Array.from({ length: 20 }, (_, index) => (
    telemetrySample("slot-1", index, 8)
  ));
  const oldActive = detectAndroidTelemetryEvents(firstRun)
    .find((event) => event.type === "flatline");
  assert.ok(oldActive);
  const secondRun = [
    ...firstRun,
    ...Array.from({ length: 20 }, (_, index) => (
      telemetrySample("slot-1", index + 20, 9)
    )),
  ];
  const events = detectAndroidTelemetryEvents(secondRun, {
    existingActiveFlatlines: [oldActive],
  });
  const flatlines = events.filter((event) => event.type === "flatline");
  assert.equal(flatlines.length, 2);
  assert.equal(
    flatlines.find((event) => event.id === oldActive.id)?.status,
    "resolved",
  );
  const nextActive = flatlines.find((event) => event.status === "active");
  assert.ok(nextActive);
  assert.notEqual(nextActive.id, oldActive.id);
  assert.equal(nextActive.startedAt, at(20));
});

test("同一 observedAt 的状态变化会产生事件但不会增加独立样本数", () => {
  const observedAt = at(0);
  const staleEvents = detectAndroidDuplicateObservationStateEvents({
    "slot-1": { observedAt, state: "live" },
  }, [
    telemetrySample("slot-1", 0, 1, "stale"),
  ], at(1));
  assert.equal(staleEvents.length, 1);
  assert.equal(staleEvents[0]?.type, "state-change");
  assert.equal(staleEvents[0]?.evidence.duplicateObservation, true);

  const recoveryEvents = detectAndroidDuplicateObservationStateEvents({
    "slot-1": { observedAt, state: "stale" },
  }, [
    telemetrySample("slot-1", 0, 1, "live"),
  ], at(2));
  assert.deepEqual(
    recoveryEvents.map((event) => event.type),
    ["state-change", "recovery"],
  );

  const counter = createAndroidIndependentObservationCounter(["slot-1"]);
  counter.add("slot-1", observedAt, true);
  counter.add("slot-1", observedAt, true);
  counter.add("slot-1", observedAt, true);
  assert.equal(counter.result().uniqueObservations, 1);
});

test("collector-error 连续失败幂等，恢复只结束来源而不完成人工工单", () => {
  const failure = transitionAndroidCollectorFailure([], at(0), "网络超时");
  assert.equal(failure.length, 1);
  assert.equal(failure[0]?.type, "collector-error");
  assert.equal(failure[0]?.status, "active");
  assert.equal(
    transitionAndroidCollectorFailure(failure, at(1), "仍然超时").length,
    0,
  );

  let id = 0;
  const idFactory = () => `collector-${++id}`;
  const created = synchronizeAndroidTelemetryEventOrders(failure, [], {
    now: at(0),
    idFactory,
  });
  assert.equal(created.orders.length, 1);
  assert.equal(created.orders[0]?.sourceState, "active");

  const recovery = transitionAndroidCollectorRecovery(failure, at(2));
  assert.deepEqual(recovery.map((event) => event.type), [
    "collector-error",
    "recovery",
  ]);
  const synchronized = synchronizeAndroidTelemetryEventOrders(
    recovery,
    created.orders,
    { now: at(2), idFactory },
  );
  assert.equal(synchronized.orders.length, 1);
  assert.equal(synchronized.orders[0]?.sourceState, "resolved");
  assert.equal(synchronized.orders[0]?.status, "pending");
  assert.equal(
    synchronized.orders[0]?.timeline.filter((entry) => (
      entry.type === "source-recovered"
    )).length,
    1,
  );
  assert.equal(transitionAndroidCollectorRecovery(recovery, at(3)).length, 0);
});

test("非 info 遥测事件只创建一个工单，源恢复不会自动完成", () => {
  const activeFlatline = detectAndroidTelemetryEvents(
    Array.from({ length: 20 }, (_, index) => telemetrySample("slot-1", index, 8)),
  ).find((event) => event.type === "flatline");
  assert.ok(activeFlatline);
  let id = 0;
  const idFactory = () => `generated-${++id}`;
  const first = synchronizeAndroidTelemetryEventOrders(
    [activeFlatline],
    [],
    { now: at(19), idFactory },
  );
  assert.equal(first.orders.length, 1);
  assert.equal(first.orders[0].sourceState, "active");
  assert.equal(first.orders[0].status, "pending");

  const duplicate = synchronizeAndroidTelemetryEventOrders(
    [activeFlatline],
    first.orders,
    { now: at(19), idFactory },
  );
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.orders.length, 1);

  const resolved = synchronizeAndroidTelemetryEventOrders(
    [{ ...activeFlatline, status: "resolved", endedAt: at(20) }],
    duplicate.orders,
    { now: at(20), idFactory },
  );
  assert.equal(resolved.orders.length, 1);
  assert.equal(resolved.orders[0].sourceState, "resolved");
  assert.equal(resolved.orders[0].status, "pending");
  assert.equal(
    resolved.orders[0].timeline.filter((entry) => entry.type === "source-recovered").length,
    1,
  );
});

test("Android Jetson 火焰事件按单次火情去重并同步严重告警", () => {
  let sequence = 0;
  const idFactory = () => `fire-${++sequence}`;
  const detected = transitionAndroidVehicleFire([], true, at(0), idFactory);
  assert.equal(detected.length, 1);
  assert.equal(detected[0]?.title, "检测到火焰");
  assert.equal(detected[0]?.severity, "critical");
  assert.equal(detected[0]?.status, "active");
  assert.equal(detected[0]?.evidence.fireDetected, true);
  assert.equal(transitionAndroidVehicleFire(detected, true, at(1), idFactory).length, 0);

  const created = synchronizeAndroidTelemetryEventOrders(detected, [], {
    now: at(0),
    idFactory,
  });
  assert.equal(created.orders.length, 1);
  assert.equal(created.orders[0]?.severity, "critical");
  assert.equal(created.orders[0]?.sourceState, "active");

  const resolvedEvents = transitionAndroidVehicleFire(detected, false, at(2), idFactory);
  assert.equal(resolvedEvents.length, 1);
  assert.equal(resolvedEvents[0]?.status, "resolved");
  const resolved = synchronizeAndroidTelemetryEventOrders(
    resolvedEvents,
    created.orders,
    { now: at(2), idFactory },
  );
  assert.equal(resolved.orders[0]?.sourceState, "resolved");
  assert.equal(
    resolved.orders[0]?.timeline.filter((entry) => entry.type === "source-recovered").length,
    1,
  );

  const secondEpisode = transitionAndroidVehicleFire(
    resolvedEvents,
    true,
    at(3),
    idFactory,
  );
  assert.equal(secondEpisode.length, 1);
  assert.notEqual(secondEpisode[0]?.id, detected[0]?.id);
});

test("Android 工单严格执行 pending → processing → completed", () => {
  const pending = workOrderFixture();
  let id = 0;
  const idFactory = () => `timeline-${++id}`;
  assert.throws(() => completeAndroidAlertOrder(
    pending,
    1,
    "测试员",
    "site-inspection",
    "已经完成检查",
    at(1),
    idFactory,
  ), /处理中/);

  const processing = beginAndroidAlertOrder(
    pending,
    1,
    " ＡＢ ",
    at(1),
    idFactory,
  );
  assert.equal(processing.status, "processing");
  assert.equal(processing.assignee, "AB");
  assert.equal(processing.version, 2);
  assert.throws(
    () => beginAndroidAlertOrder(processing, 2, "测试员", at(2), idFactory),
    /待处理/,
  );

  const completed = completeAndroidAlertOrder(
    processing,
    2,
    "测试员",
    "site-inspection",
    " 已完成现场检查 ",
    at(2),
    idFactory,
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.note, "已完成现场检查");
  assert.equal(completed.version, 3);
  assert.throws(
    () => completeAndroidAlertOrder(
      processing,
      1,
      "测试员",
      "site-inspection",
      "已完成现场检查",
      at(2),
      idFactory,
    ),
    /版本/,
  );
  assert.throws(
    () => beginAndroidAlertOrder(pending, 1, "A", at(1), idFactory),
    /2–50/,
  );
});

test("Android 告警规则保存必须包含六路唯一规则并校验版本", () => {
  const current = rulesFixture();
  const next = validateCompleteAndroidAlertRules(
    current.slice().reverse(),
    current,
    at(0),
  );
  assert.deepEqual(next.map((rule) => rule.slotId), [
    "slot-1",
    "slot-2",
    "slot-3",
    "slot-4",
    "slot-5",
    "slot-6",
  ]);
  assert.ok(next.every((rule) => rule.version === 2 && rule.updatedAt === at(0)));
  assert.throws(
    () => validateCompleteAndroidAlertRules(current.slice(0, 5), current, at(0)),
    /完整/,
  );
  assert.throws(
    () => validateCompleteAndroidAlertRules(
      [...current.slice(0, 5), { ...current[0] }],
      current,
      at(0),
    ),
    /重复/,
  );
  assert.throws(
    () => validateCompleteAndroidAlertRules(
      current.map((rule, index) => index === 0 ? { ...rule, version: 9 } : rule),
      current,
      at(0),
    ),
    /版本/,
  );
});

function telemetrySample(
  slotId: TelemetrySlotId,
  index: number,
  value: number | null,
  state: DataState = "live",
): AndroidTelemetrySample {
  return {
    slotId,
    observedAt: at(index),
    value,
    state,
    sourceKey: `source-${slotId}`,
    label: `指标 ${slotId}`,
    unit: "u",
    precision: 2,
  };
}

function at(index: number) {
  return new Date(BASE_TIME_MS + index * 10_000).toISOString();
}

function workOrderFixture(): AlertWorkOrder {
  return {
    id: "order-1",
    sourceType: "threshold",
    sourceEventId: null,
    telemetryEventType: "threshold",
    slotId: "slot-1",
    title: "测试工单",
    detail: "真实测试工单",
    severity: "warning",
    sourceState: "active",
    createdAt: at(0),
    recoveredAt: null,
    status: "pending",
    assignee: null,
    startedAt: null,
    completedAt: null,
    action: null,
    note: null,
    version: 1,
    evidence: { value: 1 },
    timeline: [{
      id: "created-1",
      type: "created",
      timestamp: at(0),
      actor: null,
      detail: "创建",
    }],
  };
}

function rulesFixture(): AlertRule[] {
  return Array.from({ length: 6 }, (_, index) => ({
    slotId: `slot-${index + 1}` as TelemetrySlotId,
    enabled: true,
    lowerLimit: 0,
    upperLimit: 100,
    version: 1,
    updatedAt: null,
  }));
}
