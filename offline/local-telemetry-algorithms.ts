import {
  TELEMETRY_SLOT_IDS,
  type DataState,
  type TelemetrySlotId,
} from "@/app/lib/iot/contracts";
import {
  ALERT_ACTIONS,
  type AlertAction,
  type AlertRule,
  type AlertWorkOrder,
} from "@/app/lib/alerts/contracts";
import type {
  TelemetryAnalysisFinding,
  TelemetryAnalysisRecommendation,
  TelemetryEvent,
  TelemetryFact,
} from "@/app/lib/iot/telemetry-history-contracts";
import { VEHICLE_FIRE_SOURCE } from "@/app/lib/iot/fire-detection";

export const ANDROID_MIN_ANOMALY_BASELINE = 20;
export const ANDROID_FLATLINE_SAMPLE_COUNT = 20;
export const ANDROID_MIN_CORRELATION_PAIRS = 12;

export interface AndroidTelemetrySample {
  slotId: TelemetrySlotId;
  observedAt: string;
  value: number | null;
  state: DataState;
  sourceKey: string | null;
  label: string;
  unit: string;
  precision: number;
}

export interface AndroidTelemetrySeriesSummary {
  slotId: TelemetrySlotId;
  label: string;
  unit: string;
  precision: number;
  count: number;
  missingCount: number;
  minimum: number | null;
  maximum: number | null;
  average: number | null;
  median: number | null;
  first: number | null;
  latest: number | null;
  change: number | null;
  slopePerHour: number | null;
  mad: number | null;
  iqr: number | null;
  coverage: number;
  medianSampleIntervalMs: number | null;
  anomalyCount: number;
  latestObservedAt: string | null;
  flatline: boolean;
}

export interface AndroidTelemetryCorrelation {
  leftSlotId: TelemetrySlotId;
  rightSlotId: TelemetrySlotId;
  coefficient: number;
  pairCount: number;
}

export interface AndroidTelemetryAnomaly {
  slotId: TelemetrySlotId;
  observedAt: string;
  value: number;
  baselineMedian: number;
  method: "mad" | "iqr" | "flat-baseline";
}

export interface AndroidTelemetryAnalysis {
  from: string;
  to: string;
  reportCount: number;
  coverage: number;
  quality: "low" | "medium" | "high";
  summaries: AndroidTelemetrySeriesSummary[];
  correlations: AndroidTelemetryCorrelation[];
  anomalies: AndroidTelemetryAnomaly[];
  facts: TelemetryFact[];
  findings: TelemetryAnalysisFinding[];
  recommendations: TelemetryAnalysisRecommendation[];
  caveats: string[];
}

export interface AnalyzeAndroidTelemetryOptions {
  from: string;
  to: string;
  expectedIntervalMs: number;
  slotIds?: readonly TelemetrySlotId[];
  minimumCorrelationPairs?: number;
  minimumAnomalyBaseline?: number;
  exactReportCount?: number;
  exactSlotObservationCounts?: Partial<Record<TelemetrySlotId, number>>;
  exactSlotNumericCounts?: Partial<Record<TelemetrySlotId, number>>;
}

export interface DetectAndroidTelemetryEventsOptions {
  existingActiveFlatlines?: readonly TelemetryEvent[];
}

export interface AndroidTelemetryStateCursor {
  observedAt: string;
  state: DataState;
}

export interface AndroidIndependentObservationStats {
  uniqueObservations: number;
  recordedFrom: string | null;
  recordedTo: string | null;
  slotObservationCounts: Partial<Record<TelemetrySlotId, number>>;
  slotNumericCounts: Partial<Record<TelemetrySlotId, number>>;
}

export interface AndroidIndependentObservationCounter {
  add(
    slotId: TelemetrySlotId,
    observedAt: string,
    hasNumericValue: boolean,
  ): void;
  result(): AndroidIndependentObservationStats;
}

export interface SynchronizeAndroidEventOrdersOptions {
  now: string;
  ignoredBeforeMs?: number;
  idFactory: () => string;
}

export function createAndroidIndependentObservationCounter(
  requestedSlotIds: readonly TelemetrySlotId[],
): AndroidIndependentObservationCounter {
  const slotIds = [...new Set(requestedSlotIds)];
  const slotIndexes = new Map(slotIds.map((slotId, index) => [slotId, index]));
  // One number stores both masks: bits 0–5 mean an observation exists and
  // bits 6–11 mean that observation contains a finite numeric value.
  const masksByTimestamp = new Map<number, number>();
  const observationCounts: Partial<Record<TelemetrySlotId, number>> = {};
  const numericCounts: Partial<Record<TelemetrySlotId, number>> = {};
  let recordedFromMs = Number.POSITIVE_INFINITY;
  let recordedToMs = Number.NEGATIVE_INFINITY;
  return {
    add(slotId, observedAt, hasNumericValue) {
      const slotIndex = slotIndexes.get(slotId);
      const timestamp = Date.parse(observedAt);
      if (slotIndex === undefined || !Number.isFinite(timestamp)) return;
      const observationBit = 1 << slotIndex;
      const numericBit = 1 << (slotIndex + 6);
      const previousMask = masksByTimestamp.get(timestamp) ?? 0;
      let nextMask = previousMask;
      if ((previousMask & observationBit) === 0) {
        observationCounts[slotId] = (observationCounts[slotId] ?? 0) + 1;
        nextMask |= observationBit;
      }
      if (hasNumericValue && (previousMask & numericBit) === 0) {
        numericCounts[slotId] = (numericCounts[slotId] ?? 0) + 1;
        nextMask |= numericBit;
      }
      masksByTimestamp.set(timestamp, nextMask);
      recordedFromMs = Math.min(recordedFromMs, timestamp);
      recordedToMs = Math.max(recordedToMs, timestamp);
    },
    result() {
      return {
        uniqueObservations: masksByTimestamp.size,
        recordedFrom: Number.isFinite(recordedFromMs)
          ? new Date(recordedFromMs).toISOString()
          : null,
        recordedTo: Number.isFinite(recordedToMs)
          ? new Date(recordedToMs).toISOString()
          : null,
        slotObservationCounts: { ...observationCounts },
        slotNumericCounts: { ...numericCounts },
      };
    },
  };
}

export function analyzeAndroidTelemetry(
  inputSamples: readonly AndroidTelemetrySample[],
  options: AnalyzeAndroidTelemetryOptions,
): AndroidTelemetryAnalysis {
  const fromMs = requiredTimestamp(options.from, "开始时间");
  const toMs = requiredTimestamp(options.to, "结束时间");
  if (toMs < fromMs) throw new RangeError("结束时间不能早于开始时间");
  const expectedIntervalMs = positiveInteger(options.expectedIntervalMs, "采样间隔");
  const minimumCorrelationPairs = positiveInteger(
    options.minimumCorrelationPairs ?? ANDROID_MIN_CORRELATION_PAIRS,
    "相关性样本数",
  );
  const minimumAnomalyBaseline = positiveInteger(
    options.minimumAnomalyBaseline ?? ANDROID_MIN_ANOMALY_BASELINE,
    "异常基线样本数",
  );
  const selected = new Set(options.slotIds ?? TELEMETRY_SLOT_IDS);
  const samples = deduplicateAndroidTelemetrySamples(inputSamples)
    .filter((sample) => selected.has(sample.slotId))
    .filter((sample) => {
      const observedAt = Date.parse(sample.observedAt);
      return observedAt >= fromMs && observedAt <= toMs;
    });
  const expectedCount = Math.max(1, Math.floor((toMs - fromMs) / expectedIntervalMs) + 1);
  const bySlot = groupBy(samples, (sample) => sample.slotId);
  const summaries: AndroidTelemetrySeriesSummary[] = [];
  const anomalies: AndroidTelemetryAnomaly[] = [];
  const facts: TelemetryFact[] = [];

  for (const slotId of options.slotIds ?? [...bySlot.keys()].sort()) {
    const series = (bySlot.get(slotId) ?? [])
      .slice()
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    if (!series.length) continue;
    const valid = series.filter(hasNumericValue);
    const values = valid.map((sample) => sample.value);
    const intervals = valid.slice(1)
      .map((sample, index) => Date.parse(sample.observedAt) - Date.parse(valid[index].observedAt))
      .filter((value) => value > 0);
    const seriesAnomalies: AndroidTelemetryAnomaly[] = [];
    for (let index = minimumAnomalyBaseline; index < valid.length; index += 1) {
      const baseline = valid
        .slice(index - minimumAnomalyBaseline, index)
        .map((sample) => sample.value);
      const detected = robustAnomaly(valid[index].value, baseline, minimumAnomalyBaseline);
      if (!detected) continue;
      seriesAnomalies.push({
        slotId,
        observedAt: valid[index].observedAt,
        value: valid[index].value,
        baselineMedian: detected.median,
        method: detected.method,
      });
    }
    anomalies.push(...seriesAnomalies);
    const latest = series.at(-1)!;
    const exactObservationCount = options.exactSlotObservationCounts?.[slotId];
    const exactNumericCount = options.exactSlotNumericCounts?.[slotId];
    const recentValues = values.slice(-ANDROID_FLATLINE_SAMPLE_COUNT);
    const flatline = recentValues.length >= ANDROID_FLATLINE_SAMPLE_COUNT
      && numericRange(recentValues) <= flatlineTolerance(latest.precision);
    const summary: AndroidTelemetrySeriesSummary = {
      slotId,
      label: latest.label,
      unit: latest.unit,
      precision: latest.precision,
      count: exactNumericCount ?? valid.length,
      missingCount: exactObservationCount === undefined || exactNumericCount === undefined
        ? series.length - valid.length
        : Math.max(0, exactObservationCount - exactNumericCount),
      minimum: values.length ? Math.min(...values) : null,
      maximum: values.length ? Math.max(...values) : null,
      average: mean(values),
      median: median(values),
      first: valid[0]?.value ?? null,
      latest: valid.at(-1)?.value ?? null,
      change: valid.length >= 2 ? valid.at(-1)!.value - valid[0].value : null,
      slopePerHour: linearSlopePerHour(valid),
      mad: medianAbsoluteDeviation(values),
      iqr: interquartileRange(values),
      coverage: clamp((exactNumericCount ?? valid.length) / expectedCount, 0, 1),
      medianSampleIntervalMs: median(intervals),
      anomalyCount: seriesAnomalies.length,
      latestObservedAt: valid.at(-1)?.observedAt ?? null,
      flatline,
    };
    summaries.push(summary);
    facts.push(...factsForSummary(summary, options.from, options.to));
  }

  const correlations: AndroidTelemetryCorrelation[] = [];
  const slotIds = [...bySlot.keys()].sort();
  for (let leftIndex = 0; leftIndex < slotIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < slotIds.length; rightIndex += 1) {
      const leftSlotId = slotIds[leftIndex];
      const rightSlotId = slotIds[rightIndex];
      const correlation = correlateSeries(
        bySlot.get(leftSlotId)!,
        bySlot.get(rightSlotId)!,
        minimumCorrelationPairs,
      );
      if (!correlation) continue;
      correlations.push({ leftSlotId, rightSlotId, ...correlation });
      facts.push({
        id: `correlation:${leftSlotId}:${rightSlotId}`,
        kind: "co-movement",
        slotIds: [leftSlotId, rightSlotId],
        statement: `${leftSlotId} 与 ${rightSlotId} 的同步 Pearson 相关系数为 ${correlation.coefficient.toFixed(3)}（${correlation.pairCount} 对独立观测）；相关性不代表因果关系。`,
        values: correlation,
        unit: null,
        windowStart: options.from,
        windowEnd: options.to,
      });
    }
  }

  for (const [slotId, slotAnomalies] of groupBy(anomalies, (anomaly) => anomaly.slotId)) {
    facts.push({
      id: `anomaly:${slotId}`,
      kind: "anomaly",
      slotIds: [slotId],
      statement: `${slotId} 检出 ${slotAnomalies.length} 个基于至少 ${minimumAnomalyBaseline} 个历史样本的稳健异常点。`,
      values: {
        count: slotAnomalies.length,
        minimumBaseline: minimumAnomalyBaseline,
      },
      unit: null,
      windowStart: options.from,
      windowEnd: options.to,
    });
  }

  const reportCount = options.exactReportCount
    ?? new Set(samples.map((sample) => sample.observedAt)).size;
  const coverage = clamp(reportCount / expectedCount, 0, 1);
  const quality = reportCount >= 20 && coverage >= 0.8
    ? "high"
    : reportCount >= 12 && coverage >= 0.5 ? "medium" : "low";
  const findings = findingsForAnalysis(facts, summaries, correlations, anomalies, coverage);
  const recommendations = recommendationsForAnalysis(facts, summaries, anomalies, coverage);

  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    reportCount,
    coverage,
    quality,
    summaries: summaries.sort((left, right) => left.slotId.localeCompare(right.slotId)),
    correlations,
    anomalies,
    facts,
    findings,
    recommendations,
    caveats: [
      "分析仅描述当前 Android 设备保存的真实观测，不构成医学、健康、合规或法规判断。",
      "同步变化和 Pearson 相关性不代表因果关系。",
      ...(reportCount < 12 ? ["独立观测较少，趋势与相关性结论的可信度有限。"] : []),
    ],
  };
}

export function detectAndroidTelemetryEvents(
  inputSamples: readonly AndroidTelemetrySample[],
  options: DetectAndroidTelemetryEventsOptions = {},
): TelemetryEvent[] {
  const samples = deduplicateAndroidTelemetrySamples(inputSamples);
  const events: TelemetryEvent[] = [];
  const existingActiveBySlot = new Map(
    (options.existingActiveFlatlines ?? [])
      .filter((event) => event.type === "flatline" && event.status === "active" && event.slotId)
      .map((event) => [event.slotId!, event]),
  );

  for (const [slotId, rawSeries] of groupBy(samples, (sample) => sample.slotId)) {
    const series = rawSeries
      .slice()
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    for (let index = 1; index < series.length; index += 1) {
      const previous = series[index - 1];
      const current = series[index];
      const gapMs = Date.parse(current.observedAt) - Date.parse(previous.observedAt);
      if (gapMs > 30_000) {
        events.push({
          id: eventId("data-gap", slotId, previous.observedAt, current.observedAt),
          slotId,
          type: "data-gap",
          severity: "warning",
          status: "resolved",
          title: `${current.label} 出现采样缺口`,
          detail: `相邻两次独立上报间隔为 ${Math.round(gapMs / 1_000)} 秒。`,
          startedAt: current.observedAt,
          endedAt: current.observedAt,
          evidence: {
            previousObservedAt: previous.observedAt,
            gapMs,
          },
        });
      }
      if (previous.state !== current.state) {
        events.push({
          id: eventId("state-change", slotId, current.observedAt, previous.state, current.state),
          slotId,
          type: "state-change",
          severity: stateSeverity(current.state),
          status: "resolved",
          title: `${current.label} 数据状态变化`,
          detail: `${previous.state} → ${current.state}`,
          startedAt: current.observedAt,
          endedAt: current.observedAt,
          evidence: { from: previous.state, to: current.state },
        });
        if (current.state === "live" && previous.state !== "live") {
          events.push({
            id: eventId("recovery", slotId, current.observedAt, previous.state, current.state),
            slotId,
            type: "recovery",
            severity: "info",
            status: "resolved",
            title: `${current.label} 数据已恢复`,
            detail: `数据状态已从 ${previous.state} 恢复为 live。`,
            startedAt: current.observedAt,
            endedAt: current.observedAt,
            evidence: { from: previous.state, to: current.state },
          });
        }
      }
    }

    const valid = series.filter(hasNumericValue);
    for (let index = ANDROID_MIN_ANOMALY_BASELINE; index < valid.length; index += 1) {
      const baseline = valid
        .slice(index - ANDROID_MIN_ANOMALY_BASELINE, index)
        .map((sample) => sample.value);
      const anomaly = robustAnomaly(
        valid[index].value,
        baseline,
        ANDROID_MIN_ANOMALY_BASELINE,
      );
      if (!anomaly) continue;
      events.push({
        id: eventId("anomaly", slotId, valid[index].observedAt),
        slotId,
        type: "anomaly",
        severity: "warning",
        status: "resolved",
        title: `${valid[index].label} 偏离近期基线`,
        detail: "当前读数与此前至少 20 个有效独立样本形成的稳健基线存在明显偏离，现有数据不能判断变化来源。",
        startedAt: valid[index].observedAt,
        endedAt: valid[index].observedAt,
        evidence: {
          value: valid[index].value,
          median: anomaly.median,
          mad: anomaly.mad,
          iqr: anomaly.iqr,
          method: anomaly.method,
          ...(anomaly.robustZ === undefined ? {} : { robustZ: anomaly.robustZ }),
          ...(anomaly.lower === undefined ? {} : { lower: anomaly.lower }),
          ...(anomaly.upper === undefined ? {} : { upper: anomaly.upper }),
        },
      });
    }

    const computedFlatlines = flatlineEventsForSeries(valid);
    const existingActive = existingActiveBySlot.get(slotId);
    const computedActive = [...computedFlatlines].reverse().find((event) => event.status === "active");
    if (existingActive && !computedFlatlines.some((event) => event.id === existingActive.id)) {
      const recoverySample = firstFlatlineBreak(existingActive, valid);
      if (recoverySample) {
        computedFlatlines.push({
          ...existingActive,
          status: "resolved",
          endedAt: recoverySample.observedAt,
        }, flatlineRecoveryEvent(recoverySample, existingActive.id));
      } else if (computedActive) {
        // The active event began before the bounded detector window and every
        // visible point still belongs to the same flatline. Preserve its ID.
        const index = computedFlatlines.indexOf(computedActive);
        computedFlatlines[index] = {
          ...computedActive,
          id: existingActive.id,
          startedAt: existingActive.startedAt,
          evidence: existingActive.evidence,
        };
      } else if (valid.length) {
        computedFlatlines.push(existingActive);
      }
    }
    events.push(...computedFlatlines);
  }

  return deduplicateEvents(events)
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
}

export function detectAndroidDuplicateObservationStateEvents(
  previous: Partial<Record<TelemetrySlotId, AndroidTelemetryStateCursor>>,
  currentSamples: readonly AndroidTelemetrySample[],
  detectedAt: string,
): TelemetryEvent[] {
  const detectedAtMs = requiredTimestamp(detectedAt, "状态检测时间");
  const timestamp = new Date(detectedAtMs).toISOString();
  const events: TelemetryEvent[] = [];
  for (const sample of deduplicateAndroidTelemetrySamples(currentSamples)) {
    const before = previous[sample.slotId];
    if (
      !before
      || before.observedAt !== sample.observedAt
      || before.state === sample.state
    ) {
      continue;
    }
    events.push({
      id: eventId(
        "state-change",
        sample.slotId,
        timestamp,
        before.state,
        sample.state,
      ),
      slotId: sample.slotId,
      type: "state-change",
      severity: stateSeverity(sample.state),
      status: "resolved",
      title: `${sample.label} 数据状态变化`,
      detail: `${before.state} → ${sample.state}`,
      startedAt: timestamp,
      endedAt: timestamp,
      evidence: {
        from: before.state,
        to: sample.state,
        sensorObservedAt: sample.observedAt,
        duplicateObservation: true,
      },
    });
    if (sample.state === "live" && before.state !== "live") {
      events.push({
        id: eventId(
          "recovery",
          sample.slotId,
          timestamp,
          before.state,
          sample.state,
        ),
        slotId: sample.slotId,
        type: "recovery",
        severity: "info",
        status: "resolved",
        title: `${sample.label} 数据已恢复`,
        detail: `数据状态已从 ${before.state} 恢复为 live。`,
        startedAt: timestamp,
        endedAt: timestamp,
        evidence: {
          from: before.state,
          to: sample.state,
          sensorObservedAt: sample.observedAt,
          duplicateObservation: true,
        },
      });
    }
  }
  return events;
}

export function transitionAndroidCollectorFailure(
  existingEvents: readonly TelemetryEvent[],
  observedAt: string,
  detail: string,
): TelemetryEvent[] {
  if (activeCollectorEvent(existingEvents)) return [];
  const timestamp = new Date(requiredTimestamp(observedAt, "采集失败时间")).toISOString();
  return [{
    id: eventId("collector-error", timestamp),
    slotId: null,
    type: "collector-error",
    severity: "critical",
    status: "active",
    title: "遥测采集暂时中断",
    detail: detail.trim().slice(0, 300) || "华为云遥测读取失败",
    startedAt: timestamp,
    endedAt: null,
    evidence: { source: "collector" },
  }];
}

export function transitionAndroidCollectorRecovery(
  existingEvents: readonly TelemetryEvent[],
  observedAt: string,
): TelemetryEvent[] {
  const active = activeCollectorEvent(existingEvents);
  if (!active) return [];
  const timestamp = new Date(requiredTimestamp(observedAt, "采集恢复时间")).toISOString();
  return [{
    ...active,
    status: "resolved",
    endedAt: timestamp,
  }, {
    id: eventId("recovery", "collector", timestamp, active.id),
    slotId: null,
    type: "recovery",
    severity: "info",
    status: "resolved",
    title: "遥测采集已恢复",
    detail: "Android 已重新取得有效的华为云遥测数据。",
    startedAt: timestamp,
    endedAt: timestamp,
    evidence: {
      recoveredEventType: "collector-error",
      recoveredEventId: active.id,
      source: "collector",
    },
  }];
}

export function transitionAndroidVehicleFire(
  existingEvents: readonly TelemetryEvent[],
  detected: boolean,
  observedAt: string,
  idFactory: () => string,
): TelemetryEvent[] {
  const timestamp = new Date(requiredTimestamp(observedAt, "火焰检测时间")).toISOString();
  const active = existingEvents.find((event) => (
    event.type === "anomaly"
    && event.status === "active"
    && event.evidence.source === VEHICLE_FIRE_SOURCE
  ));
  if (detected) {
    if (active) return [];
    return [{
      id: eventId("anomaly", "vehicle-fire", timestamp, idFactory()),
      slotId: null,
      type: "anomaly",
      severity: "critical",
      status: "active",
      title: "检测到火焰",
      detail: "Jetson YOLO 已在车辆画面中检测到火焰，请立即核查现场并采取安全措施。",
      startedAt: timestamp,
      endedAt: null,
      evidence: {
        fireDetected: true,
        source: VEHICLE_FIRE_SOURCE,
      },
    }];
  }
  if (!active) return [];
  return [{
    ...active,
    status: "resolved",
    endedAt: new Date(Math.max(Date.parse(active.startedAt), Date.parse(timestamp))).toISOString(),
  }];
}

export function synchronizeAndroidTelemetryEventOrders(
  events: readonly TelemetryEvent[],
  inputOrders: readonly AlertWorkOrder[],
  options: SynchronizeAndroidEventOrdersOptions,
): { orders: AlertWorkOrder[]; changed: boolean } {
  const orders = inputOrders.map(cloneWorkOrder);
  const ignoredBeforeMs = options.ignoredBeforeMs ?? 0;
  let changed = false;
  for (const event of events) {
    if (event.severity === "info" || event.type === "recovery") continue;
    if (Date.parse(event.startedAt) <= ignoredBeforeMs) continue;
    let order = orders.find((candidate) => (
      candidate.sourceType === "telemetry-event"
      && candidate.sourceEventId === event.id
    ));
    if (!order) {
      order = {
        id: options.idFactory(),
        sourceType: "telemetry-event",
        sourceEventId: event.id,
        telemetryEventType: event.type,
        slotId: event.slotId,
        title: event.title,
        detail: event.detail,
        severity: event.severity,
        sourceState: event.status,
        createdAt: event.startedAt,
        recoveredAt: event.status === "resolved" ? event.endedAt ?? event.startedAt : null,
        status: "pending",
        assignee: null,
        startedAt: null,
        completedAt: null,
        action: null,
        note: null,
        version: 1,
        evidence: { ...event.evidence },
        timeline: [{
          id: options.idFactory(),
          type: "created",
          timestamp: event.startedAt,
          actor: null,
          detail: "系统根据 Android 本机真实遥测事件创建告警",
        }],
      };
      if (event.status === "resolved") {
        order.timeline.push({
          id: options.idFactory(),
          type: "source-recovered",
          timestamp: order.recoveredAt ?? options.now,
          actor: null,
          detail: "数据源已恢复，等待人工确认",
        });
      }
      orders.unshift(order);
      changed = true;
      continue;
    }
    if (event.status === "resolved" && order.sourceState === "active") {
      const recoveredAt = event.endedAt ?? options.now;
      order.sourceState = "resolved";
      order.recoveredAt = recoveredAt;
      order.version += 1;
      order.timeline.push({
        id: options.idFactory(),
        type: "source-recovered",
        timestamp: recoveredAt,
        actor: null,
        detail: "数据源已恢复，等待人工确认",
      });
      changed = true;
    }
  }
  return { orders, changed };
}

export function beginAndroidAlertOrder(
  item: AlertWorkOrder,
  expectedVersion: number,
  actor: string,
  now: string,
  idFactory: () => string,
): AlertWorkOrder {
  assertExpectedVersion(item, expectedVersion);
  if (item.status !== "pending") throw new Error("只有待处理工单可以开始处理");
  const normalizedActor = normalizeAndroidActor(actor);
  return {
    ...cloneWorkOrder(item),
    status: "processing",
    assignee: normalizedActor,
    startedAt: item.startedAt ?? now,
    version: item.version + 1,
    timeline: [...item.timeline, {
      id: idFactory(),
      type: "processing-started",
      timestamp: now,
      actor: normalizedActor,
      detail: `${normalizedActor}开始处理工单`,
    }],
  };
}

export function completeAndroidAlertOrder(
  item: AlertWorkOrder,
  expectedVersion: number,
  actor: string,
  action: AlertAction,
  note: string,
  now: string,
  idFactory: () => string,
): AlertWorkOrder {
  assertExpectedVersion(item, expectedVersion);
  if (item.status !== "processing") throw new Error("只有处理中的工单可以完成");
  const normalizedActor = normalizeAndroidActor(actor);
  if (!ALERT_ACTIONS.includes(action)) throw new Error("处理方式无效");
  const normalizedNote = note.trim();
  if (normalizedNote.length < 2 || normalizedNote.length > 500) {
    throw new Error("处理说明需为 2–500 个字符");
  }
  return {
    ...cloneWorkOrder(item),
    status: "completed",
    assignee: item.assignee ?? normalizedActor,
    startedAt: item.startedAt ?? now,
    completedAt: now,
    action,
    note: normalizedNote,
    version: item.version + 1,
    timeline: [...item.timeline, {
      id: idFactory(),
      type: "completed",
      timestamp: now,
      actor: normalizedActor,
      detail: normalizedNote,
    }],
  };
}

export function validateCompleteAndroidAlertRules(
  rules: readonly AlertRule[],
  current: readonly AlertRule[],
  now: string,
): AlertRule[] {
  if (rules.length !== TELEMETRY_SLOT_IDS.length) {
    throw new Error("需要提交完整的六路告警规则");
  }
  const bySlot = new Map<TelemetrySlotId, AlertRule>();
  for (const rule of rules) {
    if (!TELEMETRY_SLOT_IDS.includes(rule.slotId) || bySlot.has(rule.slotId)) {
      throw new Error("告警规则存在无效或重复数据位");
    }
    if (typeof rule.enabled !== "boolean") throw new Error("规则启用状态无效");
    if (!Number.isInteger(rule.version) || rule.version < 1) throw new Error("规则版本无效");
    const lowerLimit = strictNullableNumber(rule.lowerLimit, "下限");
    const upperLimit = strictNullableNumber(rule.upperLimit, "上限");
    if (rule.enabled && lowerLimit === null && upperLimit === null) {
      throw new Error("启用规则时至少填写一个阈值");
    }
    if (lowerLimit !== null && upperLimit !== null && lowerLimit >= upperLimit) {
      throw new Error("下限必须小于上限");
    }
    const previous = current.find((candidate) => candidate.slotId === rule.slotId);
    if (!previous || previous.version !== rule.version) {
      throw new Error(`${rule.slotId} 规则版本已变化，请刷新后重试`);
    }
    bySlot.set(rule.slotId, {
      slotId: rule.slotId,
      enabled: rule.enabled,
      lowerLimit,
      upperLimit,
      version: rule.version + 1,
      updatedAt: now,
    });
  }
  return TELEMETRY_SLOT_IDS.map((slotId) => bySlot.get(slotId)!);
}

export function normalizeAndroidActor(value: string) {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < 2 || normalized.length > 50) {
    throw new Error("处理人名称需为 2–50 个字符");
  }
  return normalized;
}

export function deduplicateAndroidTelemetrySamples(
  samples: readonly AndroidTelemetrySample[],
) {
  const byKey = new Map<string, AndroidTelemetrySample>();
  for (const sample of samples) {
    const observedAtMs = Date.parse(sample.observedAt);
    if (!Number.isFinite(observedAtMs)) continue;
    byKey.set(`${sample.slotId}:${observedAtMs}`, {
      ...sample,
      observedAt: new Date(observedAtMs).toISOString(),
    });
  }
  return [...byKey.values()].sort((left, right) => (
    Date.parse(left.observedAt) - Date.parse(right.observedAt)
    || left.slotId.localeCompare(right.slotId)
  ));
}

function factsForSummary(
  summary: AndroidTelemetrySeriesSummary,
  from: string,
  to: string,
): TelemetryFact[] {
  const facts: TelemetryFact[] = [{
    id: `range:${summary.slotId}`,
    kind: "range",
    slotIds: [summary.slotId],
    statement: summary.count
      ? `${summary.label}共有 ${summary.count} 个有效独立观测，范围 ${formatValue(summary.minimum, summary.precision)}–${formatValue(summary.maximum, summary.precision)}${summary.unit}，平均 ${formatValue(summary.average, summary.precision)}${summary.unit}。`
      : `${summary.label}没有有效数值。`,
    values: {
      count: summary.count,
      minimum: summary.minimum,
      maximum: summary.maximum,
      average: summary.average,
      median: summary.median,
    },
    unit: summary.unit,
    windowStart: from,
    windowEnd: to,
  }, {
    id: `quality:${summary.slotId}`,
    kind: "data-quality",
    slotIds: [summary.slotId],
    statement: `${summary.label}按 10 秒独立上报基准计算的数据覆盖率为 ${(summary.coverage * 100).toFixed(1)}%。`,
    values: {
      count: summary.count,
      missingCount: summary.missingCount,
      coverage: summary.coverage,
      medianSampleIntervalMs: summary.medianSampleIntervalMs,
    },
    unit: "%",
    windowStart: from,
    windowEnd: to,
  }, {
    id: `variability:${summary.slotId}`,
    kind: "variability",
    slotIds: [summary.slotId],
    statement: `${summary.label}的中位绝对偏差为 ${formatValue(summary.mad, summary.precision)}${summary.unit}，四分位距为 ${formatValue(summary.iqr, summary.precision)}${summary.unit}。`,
    values: {
      mad: summary.mad,
      iqr: summary.iqr,
      anomalyCount: summary.anomalyCount,
    },
    unit: summary.unit,
    windowStart: from,
    windowEnd: to,
  }];
  if (summary.change !== null) {
    facts.push({
      id: `trend:${summary.slotId}`,
      kind: "trend",
      slotIds: [summary.slotId],
      statement: `${summary.label}首末变化为 ${formatSigned(summary.change, summary.precision)}${summary.unit}。`,
      values: {
        first: summary.first,
        latest: summary.latest,
        change: summary.change,
        slopePerHour: summary.slopePerHour,
      },
      unit: summary.unit,
      windowStart: from,
      windowEnd: to,
    });
  }
  if (summary.flatline) {
    facts.push({
      id: `flatline:${summary.slotId}`,
      kind: "flatline",
      slotIds: [summary.slotId],
      statement: `${summary.label}最近 ${ANDROID_FLATLINE_SAMPLE_COUNT} 个独立观测未出现可辨识变化；仅凭数据无法区分稳定环境与传感器或链路问题。`,
      values: {
        count: ANDROID_FLATLINE_SAMPLE_COUNT,
        tolerance: flatlineTolerance(summary.precision),
      },
      unit: summary.unit,
      windowStart: from,
      windowEnd: to,
    });
  }
  return facts;
}

function findingsForAnalysis(
  facts: readonly TelemetryFact[],
  summaries: readonly AndroidTelemetrySeriesSummary[],
  correlations: readonly AndroidTelemetryCorrelation[],
  anomalies: readonly AndroidTelemetryAnomaly[],
  coverage: number,
) {
  const findings: TelemetryAnalysisFinding[] = [];
  if (coverage < 0.6) {
    const factIds = facts
      .filter((fact) => fact.kind === "data-quality")
      .map((fact) => fact.id)
      .slice(0, 3);
    if (factIds.length) findings.push({
      id: "local-finding-coverage",
      title: "数据覆盖存在缺口",
      summary: "当前时间窗存在较多未覆盖时段，现有数据不足以稳定描述完整时段趋势。",
      factIds,
      severity: "attention",
    });
  }
  const flatlineFactIds = summaries
    .filter((summary) => summary.flatline)
    .map((summary) => `flatline:${summary.slotId}`)
    .filter((id) => facts.some((fact) => fact.id === id))
    .slice(0, 3);
  if (flatlineFactIds.length) findings.push({
    id: "local-finding-flatline",
    title: "部分指标保持平线",
    summary: "持续不变既可能来自稳定环境，也可能来自传感器或上报链路；单凭当前数据无法区分。",
    factIds: flatlineFactIds,
    severity: "attention",
  });
  const anomalyFactIds = [...new Set(anomalies.map((anomaly) => `anomaly:${anomaly.slotId}`))]
    .filter((id) => facts.some((fact) => fact.id === id))
    .slice(0, 3);
  if (anomalyFactIds.length) findings.push({
    id: "local-finding-anomaly",
    title: "发现近期基线异常",
    summary: "稳健统计检测到偏离近期基线的观测点，当前数据不能判断变化来源。",
    factIds: anomalyFactIds,
    severity: "attention",
  });
  const correlationFactIds = correlations
    .filter((correlation) => Math.abs(correlation.coefficient) >= 0.7)
    .map((correlation) => `correlation:${correlation.leftSlotId}:${correlation.rightSlotId}`)
    .slice(0, 3);
  if (correlationFactIds.length && findings.length < 3) findings.push({
    id: "local-finding-correlation",
    title: "指标存在同步变化",
    summary: "部分指标在相同时刻呈现较明显的同步变化；该统计关系不代表因果。",
    factIds: correlationFactIds,
    severity: "info",
  });
  return findings.slice(0, 3);
}

function recommendationsForAnalysis(
  facts: readonly TelemetryFact[],
  summaries: readonly AndroidTelemetrySeriesSummary[],
  anomalies: readonly AndroidTelemetryAnomaly[],
  coverage: number,
) {
  const recommendations: TelemetryAnalysisRecommendation[] = [];
  if (coverage < 0.6) {
    const factIds = facts
      .filter((fact) => fact.kind === "data-quality")
      .map((fact) => fact.id)
      .slice(0, 3);
    if (factIds.length) recommendations.push({
      id: "local-recommendation-coverage",
      title: "优先补充连续采样",
      rationale: "提高真实独立观测覆盖后再判断长期趋势，可减少短窗口带来的偏差。",
      factIds,
      relatedSlotIds: [],
    });
  }
  const flatlineSlots = summaries
    .filter((summary) => summary.flatline)
    .map((summary) => summary.slotId);
  const flatlineFactIds = flatlineSlots
    .map((slotId) => `flatline:${slotId}`)
    .filter((id) => facts.some((fact) => fact.id === id))
    .slice(0, 3);
  if (flatlineFactIds.length) recommendations.push({
    id: "local-recommendation-flatline",
    title: "核验持续平线指标",
    rationale: "检查传感器响应、设备上报和现场环境，确认恒定值是否可信。",
    factIds: flatlineFactIds,
    relatedSlotIds: flatlineSlots,
  });
  const anomalySlots = [...new Set(anomalies.map((anomaly) => anomaly.slotId))];
  const anomalyFactIds = anomalySlots
    .map((slotId) => `anomaly:${slotId}`)
    .filter((id) => facts.some((fact) => fact.id === id))
    .slice(0, 3);
  if (anomalyFactIds.length) recommendations.push({
    id: "local-recommendation-anomaly",
    title: "查看异常点前后曲线",
    rationale: "结合异常点附近的其他指标与设备状态，判断变化来自环境还是采集链路，不能仅凭相关性推断原因。",
    factIds: anomalyFactIds,
    relatedSlotIds: anomalySlots,
  });
  return recommendations.slice(0, 3);
}

function flatlineEventsForSeries(
  valid: readonly (AndroidTelemetrySample & { value: number })[],
): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  let active: TelemetryEvent | null = null;
  for (let index = ANDROID_FLATLINE_SAMPLE_COUNT - 1; index < valid.length; index += 1) {
    const window = valid.slice(index - ANDROID_FLATLINE_SAMPLE_COUNT + 1, index + 1);
    const current = valid[index];
    const flatline = numericRange(window.map((sample) => sample.value))
      <= flatlineTolerance(current.precision);
    if (flatline && !active) {
      active = {
        id: eventId("flatline", current.slotId, window[0].observedAt),
        slotId: current.slotId,
        type: "flatline",
        severity: "warning",
        status: "active",
        title: `${current.label} 连续保持不变`,
        detail: `最近 ${ANDROID_FLATLINE_SAMPLE_COUNT} 次独立上报值未出现可辨识变化，建议确认传感器和上报链路状态。`,
        startedAt: window[0].observedAt,
        endedAt: null,
        evidence: {
          count: ANDROID_FLATLINE_SAMPLE_COUNT,
          value: current.value,
          tolerance: flatlineTolerance(current.precision),
        },
      };
      continue;
    }
    if (!flatline && active) {
      events.push({
        ...active,
        status: "resolved",
        endedAt: current.observedAt,
      }, flatlineRecoveryEvent(current, active.id));
      active = null;
    }
  }
  if (active) events.push(active);
  return events;
}

function flatlineRecoveryEvent(
  sample: AndroidTelemetrySample,
  recoveredEventId: string,
): TelemetryEvent {
  return {
    id: eventId("recovery", sample.slotId, sample.observedAt, recoveredEventId),
    slotId: sample.slotId,
    type: "recovery",
    severity: "info",
    status: "resolved",
    title: `${sample.label} 数据变化已恢复`,
    detail: "传感器读数已脱离连续平线状态。",
    startedAt: sample.observedAt,
    endedAt: sample.observedAt,
    evidence: {
      recoveredEventType: "flatline",
      recoveredEventId,
    },
  };
}

function firstFlatlineBreak(
  active: TelemetryEvent,
  valid: readonly (AndroidTelemetrySample & { value: number })[],
) {
  const baselineValue = typeof active.evidence.value === "number"
    ? active.evidence.value
    : null;
  const tolerance = typeof active.evidence.tolerance === "number"
    ? active.evidence.tolerance
    : null;
  if (baselineValue === null || tolerance === null) return valid.at(-1) ?? null;
  return valid.find((sample) => Math.abs(sample.value - baselineValue) > tolerance) ?? null;
}

function activeCollectorEvent(events: readonly TelemetryEvent[]) {
  return events.find((event) => (
    event.type === "collector-error"
    && event.slotId === null
    && event.status === "active"
  ));
}

function correlateSeries(
  left: readonly AndroidTelemetrySample[],
  right: readonly AndroidTelemetrySample[],
  minimumPairs: number,
) {
  const rightByTime = new Map(
    right.filter(hasNumericValue).map((sample) => [Date.parse(sample.observedAt), sample.value]),
  );
  const pairs = left.filter(hasNumericValue).flatMap((sample) => {
    const rightValue = rightByTime.get(Date.parse(sample.observedAt));
    return rightValue === undefined ? [] : [[sample.value, rightValue] as const];
  });
  if (pairs.length < minimumPairs) return null;
  const leftMean = mean(pairs.map((pair) => pair[0]))!;
  const rightMean = mean(pairs.map((pair) => pair[1]))!;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (const [leftValue, rightValue] of pairs) {
    const leftDelta = leftValue - leftMean;
    const rightDelta = rightValue - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  if (leftVariance === 0 || rightVariance === 0) return null;
  return {
    coefficient: clamp(
      covariance / Math.sqrt(leftVariance * rightVariance),
      -1,
      1,
    ),
    pairCount: pairs.length,
  };
}

function robustAnomaly(
  value: number,
  baseline: readonly number[],
  minimumBaseline: number,
) {
  if (baseline.length < minimumBaseline || !Number.isFinite(value)) return null;
  const center = median(baseline)!;
  const mad = medianAbsoluteDeviation(baseline)!;
  const iqr = interquartileRange(baseline)!;
  if (mad > Number.EPSILON) {
    const robustZ = Math.abs(value - center) / (1.4826 * mad);
    return robustZ > 3.5
      ? { method: "mad" as const, median: center, mad, iqr, robustZ }
      : null;
  }
  if (iqr > Number.EPSILON) {
    const q1 = quantile(baseline, 0.25)!;
    const q3 = quantile(baseline, 0.75)!;
    const lower = q1 - 3 * iqr;
    const upper = q3 + 3 * iqr;
    return value < lower || value > upper
      ? { method: "iqr" as const, median: center, mad, iqr, lower, upper }
      : null;
  }
  return Math.abs(value - center) > Number.EPSILON
    ? { method: "flat-baseline" as const, median: center, mad, iqr }
    : null;
}

function linearSlopePerHour(
  samples: readonly (AndroidTelemetrySample & { value: number })[],
) {
  if (samples.length < 2) return null;
  const start = Date.parse(samples[0].observedAt);
  const xs = samples.map((sample) => (
    (Date.parse(sample.observedAt) - start) / 3_600_000
  ));
  const ys = samples.map((sample) => sample.value);
  const meanX = mean(xs)!;
  const meanY = mean(ys)!;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY);
    denominator += (xs[index] - meanX) ** 2;
  }
  return denominator === 0 ? null : numerator / denominator;
}

function assertExpectedVersion(item: AlertWorkOrder, expectedVersion: number) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error("工单版本无效");
  }
  if (item.version !== expectedVersion) {
    throw new Error("工单版本已变化，请刷新后重试");
  }
}

function strictNullableNumber(value: unknown, label: string) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function cloneWorkOrder(item: AlertWorkOrder): AlertWorkOrder {
  return {
    ...item,
    evidence: { ...item.evidence },
    timeline: item.timeline.map((entry) => ({ ...entry })),
  };
}

function deduplicateEvents(events: readonly TelemetryEvent[]) {
  const byId = new Map<string, TelemetryEvent>();
  for (const event of events) byId.set(event.id, event);
  return [...byId.values()];
}

function eventId(type: string, ...parts: Array<string | number>) {
  return ["android", type, ...parts].map((part) => encodeURIComponent(String(part))).join(":");
}

function stateSeverity(state: DataState): TelemetryEvent["severity"] {
  if (state === "error" || state === "offline") return "critical";
  if (state === "live") return "info";
  return "warning";
}

function hasNumericValue(
  sample: AndroidTelemetrySample,
): sample is AndroidTelemetrySample & { value: number } {
  return typeof sample.value === "number" && Number.isFinite(sample.value);
}

function flatlineTolerance(precision: number) {
  return 0.5 * 10 ** -Math.max(0, precision);
}

function numericRange(values: readonly number[]) {
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
}

function mean(values: readonly number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function median(values: readonly number[]) {
  return quantile(values, 0.5);
}

function quantile(values: readonly number[], percentile: number) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const index = clamp(percentile, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function medianAbsoluteDeviation(values: readonly number[]) {
  const center = median(values);
  return center === null
    ? null
    : median(values.map((value) => Math.abs(value - center)));
}

function interquartileRange(values: readonly number[]) {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  return q1 === null || q3 === null ? null : q3 - q1;
}

function groupBy<T, K>(values: readonly T[], key: (value: T) => K) {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const group = groups.get(groupKey);
    if (group) group.push(value);
    else groups.set(groupKey, [value]);
  }
  return groups;
}

function requiredTimestamp(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label}无效`);
  return parsed;
}

function positiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label}无效`);
  return value;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatValue(value: number | null, precision: number) {
  return value === null ? "暂无" : value.toFixed(precision);
}

function formatSigned(value: number, precision: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(precision)}`;
}
