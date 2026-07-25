import {
  ALERT_SEVERITIES,
  ALERT_WORK_ORDER_STATUSES,
  type AlertAction,
  type AlertListFilters,
  type AlertListResult,
  type AlertRule,
  type AlertWorkOrder,
} from "@/app/lib/alerts/contracts";
import {
  TELEMETRY_SLOT_IDS,
  type DashboardSnapshot,
  type TelemetrySlot,
  type TelemetrySlotId,
  type TelemetrySlots,
} from "@/app/lib/iot/contracts";
import type {
  TelemetryAnalysisRequest,
  TelemetryAnalysisResult,
  TelemetryBucket,
  TelemetryEventsRequest,
  TelemetryEventsResult,
  TelemetryHistoryRequest,
  TelemetryHistoryResult,
  TelemetryHistorySeries,
  TelemetryResolution,
  TelemetrySeriesSummary,
} from "@/app/lib/iot/telemetry-history-contracts";
import type { TelemetryEvent } from "@/app/lib/iot/telemetry-history-contracts";
import {
  analyzeAndroidTelemetry,
  beginAndroidAlertOrder,
  completeAndroidAlertOrder,
  createAndroidIndependentObservationCounter,
  deduplicateAndroidTelemetrySamples,
  detectAndroidDuplicateObservationStateEvents,
  detectAndroidTelemetryEvents,
  synchronizeAndroidTelemetryEventOrders,
  transitionAndroidCollectorFailure,
  transitionAndroidCollectorRecovery,
  transitionAndroidVehicleFire,
  validateCompleteAndroidAlertRules,
  type AndroidIndependentObservationStats,
  type AndroidTelemetrySample,
  type AndroidTelemetryStateCursor,
} from "./local-telemetry-algorithms";

const DATABASE_NAME = "xingxun-android-runtime";
const DATABASE_VERSION = 2;
const SNAPSHOT_STORE = "snapshots";
const EVENT_STORE = "telemetry-events";
const EVENT_STARTED_AT_INDEX = "startedAt";
const RULES_KEY = "xingxun:android-alert-rules:v1";
const ORDERS_KEY = "xingxun:android-alert-orders:v1";
const RULE_STATE_KEY = "xingxun:android-alert-rule-state:v1";
const IGNORED_BEFORE_KEY = "xingxun:android-alert-ignored-before:v1";
const EVENT_PROCESS_STATE_KEY = "xingxun:android-telemetry-event-state:v1";
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_QUERY_POINTS = 12_000;
const EVENT_DETECTION_SNAPSHOT_LIMIT = 512;
export const ANDROID_EXPECTED_SAMPLE_INTERVAL_MS = 10_000;
export const LOCAL_ALERTS_CHANGED_EVENT = "xingxun:android-alerts-changed";

interface StoredSnapshot {
  observedAt: string;
  recordedAt: string;
  slots: TelemetrySlots;
}

interface SnapshotQueryResult {
  snapshots: StoredSnapshot[];
  observations: AndroidIndependentObservationStats;
}

interface RuleState {
  violationCount: number;
  normalCount: number;
  activeWorkOrderId: string | null;
  lastObservedAt: string | null;
}

let databasePromise: Promise<IDBDatabase> | null = null;
let lastPrunedAt = 0;
let eventRefreshPromise: Promise<void> = Promise.resolve();

export async function recordAndroidSnapshot(snapshot: DashboardSnapshot) {
  if (snapshot.provider !== "huawei-cloud") return;
  const observedAt = latestObservation(snapshot.slots);
  if (!observedAt) return;
  const database = await openDatabase();
  const currentSamples = telemetrySamplesFromSnapshots([{
    observedAt,
    recordedAt: snapshot.generatedAt,
    slots: snapshot.slots,
  }]);
  const duplicateStateEvents = detectAndroidDuplicateObservationStateEvents(
    readTelemetryEventCursors(),
    currentSamples,
    normalizedObservedAt(snapshot.generatedAt) ?? new Date().toISOString(),
  );
  await transactionPromise(database, "readwrite", (store) => store.put({
    observedAt,
    recordedAt: snapshot.generatedAt,
    slots: snapshot.slots,
  } satisfies StoredSnapshot));
  evaluateAlertRules(snapshot.slots);
  if (duplicateStateEvents.length) {
    await persistAndSynchronizeTelemetryEvents(database, duplicateStateEvents);
  }
  if (hasUnprocessedTelemetryObservation(snapshot.slots)) {
    await refreshAndroidTelemetryEvents(database);
    rememberProcessedTelemetryObservations(snapshot.slots);
  }
  if (Date.now() - lastPrunedAt >= 60 * 60_000) {
    lastPrunedAt = Date.now();
    await pruneSnapshots(database, new Date(Date.now() - RETENTION_MS).toISOString());
  }
}

export async function recordAndroidCollectionFailure(
  error: unknown,
  observedAt: string | number | Date = new Date(),
) {
  const database = await openDatabase();
  const timestamp = normalizedEventTimestamp(observedAt);
  const detail = error instanceof Error ? error.message : String(error);
  return enqueueTelemetryEventTask(async () => {
    const existing = await readAllTelemetryEvents(database);
    const events = transitionAndroidCollectorFailure(existing, timestamp, detail);
    if (!events.length) return 0;
    await persistTelemetryEvents(database, events);
    synchronizeTelemetryEventOrders(events);
    return 1;
  });
}

export async function recordAndroidCollectionRecovery(
  observedAt: string | number | Date = new Date(),
) {
  const database = await openDatabase();
  const timestamp = normalizedEventTimestamp(observedAt);
  return enqueueTelemetryEventTask(async () => {
    const existing = await readAllTelemetryEvents(database);
    const events = transitionAndroidCollectorRecovery(existing, timestamp);
    if (!events.length) return 0;
    await persistTelemetryEvents(database, events);
    synchronizeTelemetryEventOrders(events);
    return 1;
  });
}

export async function recordAndroidVehicleFire(
  detected: boolean,
  observedAt: string | number | Date = new Date(),
) {
  const database = await openDatabase();
  const timestamp = normalizedEventTimestamp(observedAt);
  return enqueueTelemetryEventTask(async () => {
    const existing = await readAllTelemetryEvents(database);
    const events = transitionAndroidVehicleFire(
      existing,
      detected,
      timestamp,
      () => crypto.randomUUID(),
    );
    if (!events.length) return 0;
    await persistTelemetryEvents(database, events);
    synchronizeTelemetryEventOrders(events);
    return 1;
  });
}

export async function historyForAndroid(input: TelemetryHistoryRequest): Promise<TelemetryHistoryResult> {
  const query = await querySnapshots(input.from, input.to, input.slotIds);
  return historyResultFromSnapshots(input, query);
}

function historyResultFromSnapshots(
  input: TelemetryHistoryRequest,
  query: SnapshotQueryResult,
): TelemetryHistoryResult {
  const { snapshots, observations } = query;
  const resolution = input.resolution ?? recommendedResolution(input.from, input.to);
  const series = input.slotIds.map((slotId) => (
    buildSeries(
      snapshots,
      slotId,
      resolution,
      input.from,
      input.to,
      observations.slotNumericCounts[slotId] ?? 0,
    )
  ));
  const availableSlotIds = input.slotIds.filter((slotId) => (
    (observations.slotNumericCounts[slotId] ?? 0) > 0
  ));
  const requestedMs = Math.max(1, Date.parse(input.to) - Date.parse(input.from));
  const uniqueObservations = observations.uniqueObservations;
  const expected = Math.max(
    1,
    Math.floor(requestedMs / ANDROID_EXPECTED_SAMPLE_INTERVAL_MS) + 1,
  );
  const coverage = Math.min(1, uniqueObservations / expected);
  return {
    requestId: input.requestId,
    from: input.from,
    to: input.to,
    capturedFrom: observations.recordedFrom,
    generatedAt: new Date().toISOString(),
    dataVersion: observations.recordedTo ?? "empty",
    provider: "huawei-cloud",
    resolution,
    expectedIntervalMs: ANDROID_EXPECTED_SAMPLE_INTERVAL_MS,
    uniqueObservations,
    coverage,
    series,
    availability: {
      status: availableSlotIds.length === input.slotIds.length && uniqueObservations >= 2
        ? "available"
        : uniqueObservations > 0 ? "limited" : "unavailable",
      code: uniqueObservations === 0 ? "no-data-in-range" : availableSlotIds.length < input.slotIds.length ? "partial-slots" : uniqueObservations < 2 ? "insufficient-observations" : "available",
      title: uniqueObservations === 0 ? "所选时段暂无本机记录" : uniqueObservations < 2 ? "本机记录仍在积累" : "本机历史记录可用",
      detail: uniqueObservations === 0
        ? "Android 只保存安装后实际读取到的华为云上报数据。"
        : `已读取 ${uniqueObservations} 个真实上报时刻。`,
      requestedFrom: input.from,
      requestedTo: input.to,
      recordedFrom: observations.recordedFrom,
      recordedTo: observations.recordedTo,
      sampleCount: series.reduce((sum, item) => sum + item.summary.sampleCount, 0),
      uniqueObservations,
      requestedSlotIds: input.slotIds,
      availableSlotIds,
      unavailableSlotIds: input.slotIds.filter((slotId) => !availableSlotIds.includes(slotId)),
      latestReport: {
        observedAt: observations.recordedTo,
        state: uniqueObservations ? "live" : "unknown",
        collector: "ready",
      },
      suggestedRange: observations.recordedFrom && observations.recordedTo
        ? { from: observations.recordedFrom, to: observations.recordedTo }
        : null,
    },
  };
}

export async function eventsForAndroid(input: TelemetryEventsRequest): Promise<TelemetryEventsResult> {
  const database = await openDatabase();
  await refreshAndroidTelemetryEvents(database);
  const selected = input.slotIds?.length ? input.slotIds : [...TELEMETRY_SLOT_IDS];
  const events = await queryTelemetryEvents(database, input.from, input.to);
  return {
    requestId: input.requestId,
    from: input.from,
    to: input.to,
    generatedAt: new Date().toISOString(),
    events: events
      .filter((event) => event.slotId === null || selected.includes(event.slotId))
      .slice(-250)
      .reverse(),
  };
}

export async function deterministicAnalysisForAndroid(input: TelemetryAnalysisRequest) {
  const query = await querySnapshots(input.from, input.to, input.slotIds);
  const { snapshots, observations } = query;
  const history = historyResultFromSnapshots({
    ...input,
    resolution: recommendedResolution(input.from, input.to),
  }, query);
  const deterministic = analyzeAndroidTelemetry(
    telemetrySamplesFromSnapshots(snapshots, input.slotIds),
    {
      from: input.from,
      to: input.to,
      expectedIntervalMs: ANDROID_EXPECTED_SAMPLE_INTERVAL_MS,
      slotIds: input.slotIds,
      exactReportCount: observations.uniqueObservations,
      exactSlotObservationCounts: observations.slotObservationCounts,
      exactSlotNumericCounts: observations.slotNumericCounts,
    },
  );
  const sampleCount = deterministic.summaries
    .reduce((sum, summary) => sum + summary.count, 0);
  const status = deterministic.reportCount >= 2 && deterministic.facts.length
    ? "complete"
    : "insufficient-data";
  const attention = deterministic.findings.some((finding) => finding.severity === "attention");
  return {
    requestId: input.requestId,
    status,
    generatedAt: new Date().toISOString(),
    dataVersion: history.dataVersion,
    basis: {
      provider: "huawei-cloud",
      isDemo: false,
      windowStart: input.from,
      windowEnd: input.to,
      sampleCount,
      uniqueObservations: deterministic.reportCount,
      coverage: deterministic.coverage,
      quality: deterministic.quality,
    },
    headline: status !== "complete"
      ? "本机真实历史数据仍在积累"
      : deterministic.coverage < 0.6
        ? "当前数据覆盖有限，建议先检查采集连续性"
        : attention
          ? "部分指标需要结合曲线和设备状态进一步复核"
          : "已基于 Android 本机保存的真实华为云数据完成统计",
    facts: deterministic.facts,
    findings: deterministic.findings,
    recommendations: deterministic.recommendations,
    caveats: status === "complete"
      ? [
          ...deterministic.caveats,
          "结论只基于当前 Android 设备保存的真实独立上报记录，与主机历史库相互独立。",
        ]
      : [
          ...deterministic.caveats,
          "至少需要两个不同的真实上报时刻才能判断变化。",
        ],
    availability: history.availability,
  } satisfies TelemetryAnalysisResult;
}

export function listAndroidAlertRules(): AlertRule[] {
  const stored = readJson<AlertRule[]>(RULES_KEY, []);
  return TELEMETRY_SLOT_IDS.map((slotId) => {
    const current = stored.find((item) => item.slotId === slotId);
    return current ?? { slotId, enabled: false, lowerLimit: null, upperLimit: null, version: 1, updatedAt: null };
  });
}

export function saveAndroidAlertRules(rules: AlertRule[]) {
  const current = listAndroidAlertRules();
  const now = new Date().toISOString();
  const next = validateCompleteAndroidAlertRules(rules, current, now);
  const states = readJson<Partial<Record<TelemetrySlotId, RuleState>>>(RULE_STATE_KEY, {});
  const orders = readOrders();
  let ordersChanged = false;
  for (const slotId of TELEMETRY_SLOT_IDS) {
    const activeWorkOrderId = states[slotId]?.activeWorkOrderId;
    if (!activeWorkOrderId) continue;
    const order = orders.find((item) => item.id === activeWorkOrderId);
    if (!order || order.sourceState !== "active") continue;
    order.sourceState = "resolved";
    order.recoveredAt = now;
    order.version += 1;
    order.timeline.push({
      id: crypto.randomUUID(),
      type: "source-recovered",
      timestamp: now,
      actor: null,
      detail: "规则已修改或关闭，源告警已结束，等待人工确认",
    });
    ordersChanged = true;
  }
  window.localStorage.setItem(RULES_KEY, JSON.stringify(next));
  window.localStorage.removeItem(RULE_STATE_KEY);
  if (ordersChanged) saveOrders(orders);
  notifyAlertsChanged();
  return next;
}

export function listAndroidAlerts(requestId: string, filters: AlertListFilters = {}): AlertListResult {
  const ignoredBefore = Number(window.localStorage.getItem(IGNORED_BEFORE_KEY) ?? 0);
  const items = readOrders()
    .filter((item) => Date.parse(item.createdAt) >= ignoredBefore)
    .filter((item) => !filters.statuses?.length || filters.statuses.includes(item.status))
    .filter((item) => !filters.severities?.length || filters.severities.includes(item.severity))
    .filter((item) => !filters.slotIds?.length || (item.slotId !== null && filters.slotIds.includes(item.slotId)))
    .filter((item) => !filters.from || Date.parse(item.createdAt) >= Date.parse(filters.from))
    .filter((item) => !filters.to || Date.parse(item.createdAt) <= Date.parse(filters.to))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, filters.limit ?? 100);
  const all = readOrders().filter((item) => Date.parse(item.createdAt) >= ignoredBefore);
  return {
    requestId,
    generatedAt: new Date().toISOString(),
    summary: {
      pending: all.filter((item) => item.status === "pending").length,
      processing: all.filter((item) => item.status === "processing").length,
      completed: all.filter((item) => item.status === "completed").length,
      critical: all.filter((item) => item.severity === "critical" && item.status !== "completed").length,
    },
    items,
  };
}

export function readAndroidAlert(alertId: string) {
  const ignoredBefore = Number(window.localStorage.getItem(IGNORED_BEFORE_KEY) ?? 0);
  const item = readOrders().find((candidate) => (
    candidate.id === alertId
    && Date.parse(candidate.createdAt) >= ignoredBefore
  ));
  if (!item) throw new Error("告警工单不存在或已清理");
  return item;
}

export function beginAndroidAlert(alertId: string, expectedVersion: number, actor: string) {
  return mutateOrder(alertId, expectedVersion, (item, now) => (
    beginAndroidAlertOrder(
      item,
      expectedVersion,
      actor,
      now,
      () => crypto.randomUUID(),
    )
  ));
}

export function completeAndroidAlert(
  alertId: string,
  expectedVersion: number,
  actor: string,
  action: AlertAction,
  note: string,
) {
  return mutateOrder(alertId, expectedVersion, (item, now) => (
    completeAndroidAlertOrder(
      item,
      expectedVersion,
      actor,
      action,
      note,
      now,
      () => crypto.randomUUID(),
    )
  ));
}

export function clearAndroidAlerts(requestId: string) {
  const orders = readOrders();
  const ignoredBefore = new Date().toISOString();
  window.localStorage.setItem(IGNORED_BEFORE_KEY, String(Date.parse(ignoredBefore)));
  saveOrders([]);
  window.localStorage.removeItem(RULE_STATE_KEY);
  notifyAlertsChanged();
  return { requestId, clearedCount: orders.length, ignoredBefore, generatedAt: ignoredBefore };
}

function evaluateAlertRules(slots: TelemetrySlots) {
  const rules = listAndroidAlertRules();
  const states = readJson<Partial<Record<TelemetrySlotId, RuleState>>>(RULE_STATE_KEY, {});
  const orders = readOrders();
  let changed = false;
  for (const rule of rules) {
    const slot = slots[rule.slotId];
    const observedAt = normalizedObservedAt(slot.observedAt);
    if (!rule.enabled || slot.value === null || !Number.isFinite(slot.value) || !observedAt) continue;
    const state = states[rule.slotId] ?? { violationCount: 0, normalCount: 0, activeWorkOrderId: null, lastObservedAt: null };
    if (state.lastObservedAt === observedAt) continue;
    const outside = (rule.lowerLimit !== null && slot.value < rule.lowerLimit)
      || (rule.upperLimit !== null && slot.value > rule.upperLimit);
    state.lastObservedAt = observedAt;
    state.violationCount = outside ? state.violationCount + 1 : 0;
    state.normalCount = outside ? 0 : state.normalCount + 1;
    if (outside && state.violationCount >= 2 && !state.activeWorkOrderId) {
      const id = crypto.randomUUID();
      state.activeWorkOrderId = id;
      orders.unshift(createThresholdOrder(id, slot, rule, observedAt));
      changed = true;
    }
    if (!outside && state.normalCount >= 2 && state.activeWorkOrderId) {
      const order = orders.find((item) => item.id === state.activeWorkOrderId);
      if (order && order.sourceState !== "resolved") {
        order.sourceState = "resolved";
        order.recoveredAt = observedAt;
        order.version += 1;
        order.timeline.push({ id: crypto.randomUUID(), type: "source-recovered", timestamp: observedAt, actor: null, detail: "连续两次真实上报恢复到阈值范围" });
        changed = true;
      }
      state.activeWorkOrderId = null;
    }
    states[rule.slotId] = state;
  }
  window.localStorage.setItem(RULE_STATE_KEY, JSON.stringify(states));
  if (changed) {
    saveOrders(orders);
    notifyAlertsChanged();
  }
}

function createThresholdOrder(id: string, slot: TelemetrySlot, rule: AlertRule, observedAt: string): AlertWorkOrder {
  const limit = rule.lowerLimit !== null && rule.upperLimit !== null
    ? `${rule.lowerLimit}${slot.unit}–${rule.upperLimit}${slot.unit}`
    : rule.lowerLimit !== null ? `不低于 ${rule.lowerLimit}${slot.unit}` : `不高于 ${rule.upperLimit}${slot.unit}`;
  return {
    id,
    sourceType: "threshold",
    sourceEventId: null,
    telemetryEventType: "threshold",
    slotId: slot.slotId,
    title: `${slot.label} 超出设定范围`,
    detail: `连续两次真实上报超出设定范围（${limit}）。`,
    severity: "warning",
    sourceState: "active",
    createdAt: observedAt,
    recoveredAt: null,
    status: "pending",
    assignee: null,
    startedAt: null,
    completedAt: null,
    action: null,
    note: null,
    version: 1,
    evidence: { value: slot.value, unit: slot.unit, lowerLimit: rule.lowerLimit, upperLimit: rule.upperLimit },
    timeline: [{ id: crypto.randomUUID(), type: "created", timestamp: observedAt, actor: null, detail: "连续两次越界，Android 本机创建告警" }],
  };
}

function mutateOrder(
  alertId: string,
  expectedVersion: number,
  mutate: (item: AlertWorkOrder, now: string) => AlertWorkOrder,
) {
  const orders = readOrders();
  const index = orders.findIndex((item) => item.id === alertId);
  if (index < 0) throw new Error("告警工单不存在或已清理");
  if (orders[index].version !== expectedVersion) throw new Error("工单版本已变化，请刷新后重试");
  orders[index] = mutate(orders[index], new Date().toISOString());
  saveOrders(orders);
  notifyAlertsChanged();
  return orders[index];
}

function buildSeries(
  snapshots: StoredSnapshot[],
  slotId: TelemetrySlotId,
  resolution: TelemetryResolution,
  from: string,
  to: string,
  exactSampleCount: number,
): TelemetryHistorySeries {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const samples = telemetrySamplesFromSnapshots(snapshots, [slotId])
    .filter((sample) => {
      const observedAt = Date.parse(sample.observedAt);
      return observedAt >= fromMs && observedAt <= toMs;
    });
  const valid = samples.flatMap((sample) => (
    sample.value === null || !Number.isFinite(sample.value)
      ? []
      : [{ at: sample.observedAt, value: sample.value, sample }]
  ));
  const latestSlot = valid.at(-1)?.sample ?? samples.at(-1);
  const bucketMs = resolutionMs(resolution);
  const groups = new Map<number, Array<{ at: string; value: number }>>();
  for (const item of valid) {
    const start = bucketMs === 0 ? Date.parse(item.at) : Math.floor(Date.parse(item.at) / bucketMs) * bucketMs;
    const group = groups.get(start) ?? [];
    group.push(item);
    groups.set(start, group);
  }
  const buckets: TelemetryBucket[] = [...groups.entries()].map(([start, group]) => {
    const values = group.map((item) => item.value);
    return {
      startAt: new Date(start).toISOString(),
      endAt: new Date(bucketMs ? start + bucketMs : start).toISOString(),
      minimum: Math.min(...values),
      maximum: Math.max(...values),
      average: average(values),
      last: values.at(-1)!,
      count: values.length,
    };
  });
  const values = valid.map((item) => item.value);
  return {
    slotId,
    sourceKey: latestSlot?.sourceKey ?? null,
    label: latestSlot?.label ?? slotId,
    unit: latestSlot?.unit ?? "",
    precision: latestSlot?.precision ?? 2,
    buckets,
    summary: summarize(
      values,
      valid.map((item) => item.at),
      from,
      to,
      exactSampleCount,
    ),
  };
}

function summarize(
  values: number[],
  times: string[],
  from: string,
  to: string,
  exactSampleCount: number,
): TelemetrySeriesSummary {
  const expected = Math.max(
    1,
    Math.floor((Date.parse(to) - Date.parse(from)) / ANDROID_EXPECTED_SAMPLE_INTERVAL_MS) + 1,
  );
  if (!values.length) {
    return {
      minimum: null,
      maximum: null,
      average: null,
      median: null,
      delta: null,
      slopePerHour: null,
      volatility: null,
      sampleCount: exactSampleCount,
      completeness: Math.min(1, exactSampleCount / expected),
      latestObservedAt: null,
    };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const mean = average(values);
  const durationHours = Math.max(0, (Date.parse(times.at(-1)!) - Date.parse(times[0])) / 3_600_000);
  return {
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    average: mean,
    median: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : average([sorted[sorted.length / 2 - 1], sorted[sorted.length / 2]]),
    delta: values.at(-1)! - values[0],
    slopePerHour: durationHours > 0 ? (values.at(-1)! - values[0]) / durationHours : 0,
    volatility: Math.sqrt(average(values.map((value) => (value - mean) ** 2))),
    sampleCount: exactSampleCount,
    completeness: Math.min(1, exactSampleCount / expected),
    latestObservedAt: times.at(-1)!,
  };
}

async function querySnapshots(
  from: string,
  to: string,
  slotIds: readonly TelemetrySlotId[],
): Promise<SnapshotQueryResult> {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (
    !Number.isFinite(fromMs)
    || !Number.isFinite(toMs)
    || fromMs >= toMs
    || toMs - fromMs > RETENTION_MS + 60_000
  ) {
    throw new Error("Android 本机历史时间范围无效或超过 30 天");
  }
  const database = await openDatabase();
  const range = IDBKeyRange.bound(from, to);
  const count = await requestPromise(
    database
      .transaction(SNAPSHOT_STORE, "readonly")
      .objectStore(SNAPSHOT_STORE)
      .count(range),
  );
  const stride = Math.max(1, Math.ceil(Number(count) / MAX_QUERY_POINTS));
  const requested = new Set(slotIds);
  const counter = createAndroidIndependentObservationCounter(slotIds);
  return new Promise<SnapshotQueryResult>((resolve, reject) => {
    const values: StoredSnapshot[] = [];
    const request = database
      .transaction(SNAPSHOT_STORE, "readonly")
      .objectStore(SNAPSHOT_STORE)
      .openCursor(range);
    let index = 0;
    let lastSnapshot: StoredSnapshot | null = null;
    request.onerror = () => reject(request.error ?? new Error("Android 本机历史读取失败"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        if (
          lastSnapshot
          && values.at(-1)?.observedAt !== lastSnapshot.observedAt
        ) {
          if (values.length >= MAX_QUERY_POINTS) values[values.length - 1] = lastSnapshot;
          else values.push(lastSnapshot);
        }
        resolve({
          snapshots: values,
          observations: counter.result(),
        });
        return;
      }
      const snapshot = cursor.value as StoredSnapshot;
      lastSnapshot = snapshot;
      for (const slotId of TELEMETRY_SLOT_IDS) {
        if (!requested.has(slotId)) continue;
        const slot = snapshot.slots[slotId];
        const observedAt = normalizedObservedAt(slot.observedAt);
        if (!observedAt) continue;
        const observedAtMs = Date.parse(observedAt);
        if (observedAtMs < fromMs || observedAtMs > toMs) continue;
        counter.add(
          slotId,
          observedAt,
          typeof slot.value === "number" && Number.isFinite(slot.value),
        );
      }
      if (index % stride === 0) values.push(snapshot);
      index += 1;
      cursor.continue();
    };
  });
}

async function queryRecentSnapshots(
  database: IDBDatabase,
  limit = EVENT_DETECTION_SNAPSHOT_LIMIT,
) {
  return new Promise<StoredSnapshot[]>((resolve, reject) => {
    const values: StoredSnapshot[] = [];
    const request = database
      .transaction(SNAPSHOT_STORE, "readonly")
      .objectStore(SNAPSHOT_STORE)
      .openCursor(null, "prev");
    request.onerror = () => reject(request.error ?? new Error("Android 本机历史读取失败"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || values.length >= limit) {
        resolve(values.reverse());
        return;
      }
      values.push(cursor.value as StoredSnapshot);
      cursor.continue();
    };
  });
}

function telemetrySamplesFromSnapshots(
  snapshots: readonly StoredSnapshot[],
  slotIds: readonly TelemetrySlotId[] = TELEMETRY_SLOT_IDS,
) {
  const selected = new Set(slotIds);
  const samples: AndroidTelemetrySample[] = [];
  for (const snapshot of snapshots) {
    for (const slotId of TELEMETRY_SLOT_IDS) {
      if (!selected.has(slotId)) continue;
      const slot = snapshot.slots[slotId];
      const observedAt = normalizedObservedAt(slot.observedAt);
      if (!observedAt) continue;
      samples.push({
        slotId,
        observedAt,
        value: typeof slot.value === "number" && Number.isFinite(slot.value)
          ? slot.value
          : null,
        state: slot.state,
        sourceKey: slot.sourceKey,
        label: slot.label,
        unit: slot.unit,
        precision: slot.precision,
      });
    }
  }
  return deduplicateAndroidTelemetrySamples(samples);
}

function refreshAndroidTelemetryEvents(database: IDBDatabase) {
  return enqueueTelemetryEventTask(async () => {
    const snapshots = await queryRecentSnapshots(database);
    const samples = telemetrySamplesFromSnapshots(snapshots);
    if (!samples.length) return;
    const existing = await readAllTelemetryEvents(database);
    const events = detectAndroidTelemetryEvents(samples, {
      existingActiveFlatlines: existing.filter((event) => (
        event.type === "flatline" && event.status === "active"
      )),
    });
    if (events.length) await persistTelemetryEvents(database, events);
    synchronizeTelemetryEventOrders(events);
  });
}

function persistAndSynchronizeTelemetryEvents(
  database: IDBDatabase,
  events: readonly TelemetryEvent[],
) {
  return enqueueTelemetryEventTask(async () => {
    await persistTelemetryEvents(database, events);
    synchronizeTelemetryEventOrders(events);
  });
}

function synchronizeTelemetryEventOrders(events: readonly TelemetryEvent[]) {
  const ignoredBeforeMs = Number(
    window.localStorage.getItem(IGNORED_BEFORE_KEY) ?? 0,
  );
  const synchronized = synchronizeAndroidTelemetryEventOrders(
    events,
    readOrders(),
    {
      now: new Date().toISOString(),
      ignoredBeforeMs: Number.isFinite(ignoredBeforeMs) ? ignoredBeforeMs : 0,
      idFactory: () => crypto.randomUUID(),
    },
  );
  if (!synchronized.changed) return false;
  saveOrders(synchronized.orders);
  notifyAlertsChanged();
  return true;
}

function enqueueTelemetryEventTask<T>(task: () => Promise<T>) {
  const result = eventRefreshPromise
    .catch(() => undefined)
    .then(task);
  eventRefreshPromise = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function readAllTelemetryEvents(database: IDBDatabase) {
  return requestPromise(
    database
      .transaction(EVENT_STORE, "readonly")
      .objectStore(EVENT_STORE)
      .getAll(),
  ) as Promise<TelemetryEvent[]>;
}

function persistTelemetryEvents(
  database: IDBDatabase,
  events: readonly TelemetryEvent[],
) {
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(EVENT_STORE, "readwrite");
    const store = transaction.objectStore(EVENT_STORE);
    for (const event of events) store.put(event);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error("Android 本机事件写入失败"),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error("Android 本机事件写入已中止"),
    );
  });
}

function queryTelemetryEvents(
  database: IDBDatabase,
  from: string,
  to: string,
) {
  return requestPromise(
    database
      .transaction(EVENT_STORE, "readonly")
      .objectStore(EVENT_STORE)
      .index(EVENT_STARTED_AT_INDEX)
      .getAll(IDBKeyRange.bound(from, to)),
  ) as Promise<TelemetryEvent[]>;
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SNAPSHOT_STORE)) {
        request.result.createObjectStore(SNAPSHOT_STORE, { keyPath: "observedAt" });
      }
      if (!request.result.objectStoreNames.contains(EVENT_STORE)) {
        const eventStore = request.result.createObjectStore(EVENT_STORE, {
          keyPath: "id",
        });
        eventStore.createIndex(EVENT_STARTED_AT_INDEX, "startedAt");
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Android 本机历史库打开失败"));
    request.onsuccess = () => resolve(request.result);
  });
  return databasePromise;
}

function transactionPromise(database: IDBDatabase, mode: IDBTransactionMode, mutate: (store: IDBObjectStore) => void) {
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE, mode);
    mutate(transaction.objectStore(SNAPSHOT_STORE));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Android 本机历史写入失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Android 本机历史写入已中止"));
  });
}

function requestPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Android 本机数据库请求失败"));
  });
}

async function pruneSnapshots(database: IDBDatabase, before: string) {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE, "readwrite");
    const request = transaction.objectStore(SNAPSHOT_STORE).openCursor(IDBKeyRange.upperBound(before, true));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(EVENT_STORE, "readwrite");
    const request = transaction
      .objectStore(EVENT_STORE)
      .index(EVENT_STARTED_AT_INDEX)
      .openCursor(IDBKeyRange.upperBound(before, true));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const event = cursor.value as TelemetryEvent;
      if (event.status === "resolved") cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function latestObservation(slots: TelemetrySlots) {
  return TELEMETRY_SLOT_IDS.map((slotId) => slots[slotId].observedAt)
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)))
    .sort()
    .at(-1) ?? null;
}

function normalizedObservedAt(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizedEventTimestamp(value: string | number | Date) {
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("遥测事件时间无效");
  return new Date(parsed).toISOString();
}

function readTelemetryEventCursors() {
  const stored = readJson<Partial<Record<TelemetrySlotId, unknown>>>(
    EVENT_PROCESS_STATE_KEY,
    {},
  );
  const cursors: Partial<Record<TelemetrySlotId, AndroidTelemetryStateCursor>> = {};
  for (const slotId of TELEMETRY_SLOT_IDS) {
    const value = stored[slotId];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    const observedAt = typeof candidate.observedAt === "string"
      ? normalizedObservedAt(candidate.observedAt)
      : null;
    if (!observedAt || !isDataState(candidate.state)) continue;
    cursors[slotId] = { observedAt, state: candidate.state };
  }
  return cursors;
}

function hasUnprocessedTelemetryObservation(slots: TelemetrySlots) {
  const processed = readTelemetryEventCursors();
  return TELEMETRY_SLOT_IDS.some((slotId) => {
    const observedAt = normalizedObservedAt(slots[slotId].observedAt);
    return observedAt !== null && (
      processed[slotId]?.observedAt !== observedAt
      || processed[slotId]?.state !== slots[slotId].state
    );
  });
}

function rememberProcessedTelemetryObservations(slots: TelemetrySlots) {
  const processed = readTelemetryEventCursors();
  for (const slotId of TELEMETRY_SLOT_IDS) {
    const observedAt = normalizedObservedAt(slots[slotId].observedAt);
    if (observedAt) {
      processed[slotId] = {
        observedAt,
        state: slots[slotId].state,
      };
    }
  }
  window.localStorage.setItem(EVENT_PROCESS_STATE_KEY, JSON.stringify(processed));
}

function isDataState(value: unknown): value is TelemetrySlots[TelemetrySlotId]["state"] {
  return value === "loading"
    || value === "live"
    || value === "stale"
    || value === "offline"
    || value === "empty"
    || value === "error";
}

function recommendedResolution(from: string, to: string): TelemetryResolution {
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 60 * 60_000) return "raw";
  if (duration <= 24 * 60 * 60_000) return "1m";
  if (duration <= 7 * 24 * 60 * 60_000) return "5m";
  return "1h";
}

function resolutionMs(value: TelemetryResolution) {
  return value === "raw" ? 0 : value === "1m" ? 60_000 : value === "5m" ? 300_000 : 3_600_000;
}

function readOrders() {
  return readJson<AlertWorkOrder[]>(ORDERS_KEY, []).filter((item) => ALERT_WORK_ORDER_STATUSES.includes(item.status) && ALERT_SEVERITIES.includes(item.severity));
}

function saveOrders(orders: AlertWorkOrder[]) {
  window.localStorage.setItem(ORDERS_KEY, JSON.stringify(orders.slice(0, 1_000)));
}

function notifyAlertsChanged() {
  window.dispatchEvent(new Event(LOCAL_ALERTS_CHANGED_EVENT));
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}
