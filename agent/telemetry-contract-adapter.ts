import { createHash } from "node:crypto";
import type {
  TelemetryAnalysisRequest,
  TelemetryAnalysisResult,
  TelemetryEventsRequest,
  TelemetryEventsResult,
  TelemetryFact,
  TelemetryFactKind,
  TelemetryHistoryRequest,
  TelemetryHistoryResult,
  TelemetryHistorySeries,
  TelemetrySeriesSummary as PublicSeriesSummary,
} from "../app/lib/iot/telemetry-history-contracts";
import type { DashboardSnapshot, TelemetrySlotId } from "../app/lib/iot/contracts";
import type {
  TelemetryDeterministicAnalysis,
  TelemetryEvent as StoredEvent,
  TelemetryFact as StoredFact,
  TelemetryHistoryResult as StoredHistoryResult,
  TelemetrySample,
  TelemetrySeriesSummary as StoredSeriesSummary,
  TelemetryStore,
} from "./telemetry-store";
import {
  diagnoseTelemetryAvailability,
  type TelemetryAvailabilityRuntimeContext,
} from "./telemetry-diagnostics";

export function historyResultForRequest(
  store: TelemetryStore,
  request: TelemetryHistoryRequest,
  provider: DashboardSnapshot["provider"],
  runtime: TelemetryAvailabilityRuntimeContext = {},
): TelemetryHistoryResult {
  const stored = store.queryHistory({
    from: request.from,
    to: request.to,
    slotIds: request.slotIds,
    resolution: request.resolution ?? "auto",
  });
  const samples = store.querySamples({ from: request.from, to: request.to, slotIds: request.slotIds });
  const deterministic = store.analyze({ from: request.from, to: request.to, slotIds: request.slotIds });
  const availability = diagnoseTelemetryAvailability(store, request, runtime);
  return mapHistory(
    request.requestId,
    stored,
    deterministic,
    store.expectedIntervalMs,
    provider,
    request.slotIds,
    availability,
    telemetryDataVersion(samples),
  );
}

export function eventsResultForRequest(
  store: TelemetryStore,
  request: TelemetryEventsRequest,
): TelemetryEventsResult {
  const events = store.queryEvents({
    from: request.from,
    to: request.to,
    slotIds: request.slotIds,
  });
  return {
    requestId: request.requestId,
    from: request.from,
    to: request.to,
    generatedAt: new Date().toISOString(),
    events: events.map(mapEvent),
  };
}

export function deterministicAnalysisForRequest(
  store: TelemetryStore,
  request: TelemetryAnalysisRequest,
  provider: DashboardSnapshot["provider"],
  runtime: TelemetryAvailabilityRuntimeContext = {},
): TelemetryAnalysisResult {
  const stored = store.analyze({ from: request.from, to: request.to, slotIds: request.slotIds });
  const samples = store.querySamples({ from: request.from, to: request.to, slotIds: request.slotIds });
  const availability = diagnoseTelemetryAvailability(store, request, runtime);
  const dataVersion = telemetryDataVersion(samples);
  const quality = stored.reportCount >= 20 && stored.coverage >= 0.8
    ? "high"
    : stored.reportCount >= 12 && stored.coverage >= 0.5 ? "medium" : "low";
  const facts = stored.facts.map((fact) => mapFact(fact, stored.from, stored.to));
  const factIds = new Set(facts.map((fact) => fact.id));
  const anomalyFacts = facts.filter((fact) => fact.kind === "anomaly").map((fact) => fact.id);
  const flatlineSummaries = stored.summaries.filter((summary) => (
    summary.count >= 20
    && summary.minimum !== null
    && summary.minimum === summary.maximum
  ));
  const correlationFacts = stored.correlations
    .filter((correlation) => Math.abs(correlation.coefficient) >= 0.7)
    .map((correlation) => `correlation:${correlation.leftSlotId}:${correlation.rightSlotId}`)
    .filter((id) => factIds.has(id));

  const findings: TelemetryAnalysisResult["findings"] = [];
  if (stored.coverage < 0.6) {
    const qualityFacts = facts.filter((fact) => fact.kind === "data-quality").map((fact) => fact.id).slice(0, 3);
    if (qualityFacts.length) findings.push({
      id: "local-finding-coverage",
      title: "数据覆盖存在缺口",
      summary: "当前时间窗存在较多未覆盖时段，现有数据不足以稳定描述完整时段趋势。",
      factIds: qualityFacts,
      severity: "attention",
    });
  }
  if (flatlineSummaries.length) {
    const related = flatlineSummaries.map((summary) => `range:${summary.slotId}`).filter((id) => factIds.has(id)).slice(0, 3);
    if (related.length) findings.push({
      id: "local-finding-flatline",
      title: "部分指标保持平线",
      summary: "持续不变既可能来自稳定环境，也可能来自传感器或上报链路，单凭当前数据无法区分。",
      factIds: related,
      severity: "attention",
    });
  }
  if (anomalyFacts.length) findings.push({
    id: "local-finding-anomaly",
    title: "发现近期基线异常",
    summary: "稳健统计检测到偏离近期基线的观测点，当前数据不能判断变化来源。",
    factIds: anomalyFacts.slice(0, 3),
    severity: "attention",
  });
  if (correlationFacts.length && findings.length < 3) findings.push({
    id: "local-finding-correlation",
    title: "指标存在同步变化",
    summary: "部分指标在相同时刻呈现较明显的同步变化，该关系不代表因果。",
    factIds: correlationFacts.slice(0, 3),
    severity: "info",
  });

  const recommendations: TelemetryAnalysisResult["recommendations"] = [];
  if (stored.coverage < 0.6) recommendations.push({
    id: "local-recommendation-coverage",
    title: "优先补充连续采样",
    rationale: "提高数据覆盖后再判断长期趋势，可减少短窗口带来的偏差。",
    factIds: facts.filter((fact) => fact.kind === "data-quality").map((fact) => fact.id).slice(0, 3),
    relatedSlotIds: [],
  });
  if (flatlineSummaries.length) recommendations.push({
    id: "local-recommendation-flatline",
    title: "核验持续平线指标",
    rationale: "检查传感器响应、设备上报和现场环境，确认零值或恒定值是否可信。",
    factIds: flatlineSummaries.map((summary) => `range:${summary.slotId}`).filter((id) => factIds.has(id)).slice(0, 3),
    relatedSlotIds: flatlineSummaries.map((summary) => summary.slotId).filter(isSlotId),
  });
  if (anomalyFacts.length) recommendations.push({
    id: "local-recommendation-anomaly",
    title: "查看异常点前后曲线",
    rationale: "结合异常点附近的其他指标与设备状态，判断变化来自环境还是采集链路。",
    factIds: anomalyFacts.slice(0, 3),
    relatedSlotIds: slotIdsForFacts(facts, anomalyFacts),
  });

  return {
    requestId: request.requestId,
    status: stored.reportCount >= 2 && availability.availableSlotIds.length > 0
      ? "complete"
      : "insufficient-data",
    generatedAt: new Date().toISOString(),
    dataVersion,
    basis: {
      provider,
      isDemo: provider === "mock",
      windowStart: stored.from,
      windowEnd: stored.to,
      sampleCount: stored.summaries.reduce((sum, summary) => sum + summary.count, 0),
      uniqueObservations: stored.reportCount,
      coverage: stored.coverage,
      quality,
    },
    headline: availability.status === "available"
      ? headlineFor(stored, flatlineSummaries.length)
      : availability.title,
    facts,
    findings: findings.slice(0, 3),
    recommendations: recommendations.filter((item) => item.factIds.length).slice(0, 3),
    caveats: [
      "分析仅基于已记录的设备观测，不包含医学或法规判断。",
      ...(provider === "mock" ? ["当前为本机演示数据，不能作为真实环境结论。"] : []),
      ...(stored.reportCount < 12 ? ["独立观测较少，趋势与相关性结论的可信度有限。"] : []),
      ...(availability.status === "available" ? [] : [availability.detail]),
    ],
    availability,
  };
}

function mapHistory(
  requestId: string,
  stored: StoredHistoryResult,
  deterministic: TelemetryDeterministicAnalysis,
  expectedIntervalMs: number,
  fallbackProvider: DashboardSnapshot["provider"],
  slotIds: readonly TelemetrySlotId[],
  availability: TelemetryHistoryResult["availability"],
  dataVersion: string,
): TelemetryHistoryResult {
  const summaries = new Map(deterministic.summaries.map((summary) => [summary.slotId, summary]));
  const bySlot = new Map<string, StoredHistoryResult["buckets"]>();
  for (const bucket of stored.buckets) bySlot.set(bucket.slotId, [...(bySlot.get(bucket.slotId) ?? []), bucket]);
  const series = slotIds.flatMap((slotId) => {
    const buckets = bySlot.get(slotId) ?? [];
    const summary = summaries.get(slotId);
    const latest = buckets.at(-1);
    if (!summary && !latest) return [];
    const item: TelemetryHistorySeries = {
      slotId,
      sourceKey: latest?.sourceKey ?? null,
      label: latest?.label ?? summary?.label ?? slotId,
      unit: latest?.unit ?? summary?.unit ?? "",
      precision: latest?.precision ?? 2,
      buckets: buckets.flatMap((bucket) => (
        bucket.min === null || bucket.max === null || bucket.average === null || bucket.last === null || bucket.count < 1
          ? []
          : [{
              startAt: bucket.startAt,
              endAt: bucket.endAt,
              minimum: bucket.min,
              maximum: bucket.max,
              average: bucket.average,
              last: bucket.last,
              count: bucket.count,
            }]
      )),
      summary: mapSummary(summary),
    };
    return [item];
  });
  const latestBucket = stored.buckets.at(-1);
  return {
    requestId,
    from: stored.from,
    to: stored.to,
    capturedFrom: stored.firstRecordedAt,
    generatedAt: new Date().toISOString(),
    dataVersion,
    provider: isProvider(latestBucket?.provider) ? latestBucket.provider : fallbackProvider,
    resolution: stored.resolution,
    expectedIntervalMs,
    uniqueObservations: deterministic.reportCount,
    coverage: deterministic.coverage,
    series,
    availability,
  };
}

/**
 * Version the exact observations instead of the aggregate bucket boundary.
 * A new sample inside an existing 5-minute/1-hour bucket must invalidate both
 * chart summaries and model-analysis caches.
 */
export function telemetryDataVersion(samples: readonly TelemetrySample[]) {
  if (!samples.length) return "telemetry:empty";
  const digest = createHash("sha256");
  for (const sample of samples) {
    digest.update(JSON.stringify([
      sample.slotId,
      sample.observedAt,
      sample.value,
      sample.state,
      sample.provider,
      sample.sourceKey,
      sample.label,
      sample.unit,
      sample.precision,
    ]));
    digest.update("\n");
  }
  return `telemetry:${samples.length}:${digest.digest("base64url").slice(0, 20)}`;
}

function mapSummary(summary: StoredSeriesSummary | undefined): PublicSeriesSummary {
  return {
    minimum: summary?.minimum ?? null,
    maximum: summary?.maximum ?? null,
    average: summary?.average ?? null,
    median: summary?.median ?? null,
    delta: summary?.change ?? null,
    slopePerHour: summary?.slopePerHour ?? null,
    volatility: summary?.mad ?? summary?.iqr ?? null,
    sampleCount: summary?.count ?? 0,
    completeness: summary?.coverage ?? 0,
    latestObservedAt: summary?.latestObservedAt ?? null,
  };
}

function mapEvent(event: StoredEvent): TelemetryEventsResult["events"][number] {
  return {
    id: String(event.id),
    slotId: isSlotId(event.slotId) ? event.slotId : null,
    type: event.type === "gap" ? "data-gap" : event.type === "fire" ? "anomaly" : event.type,
    severity: event.severity === "error" ? "critical" : event.severity,
    status: event.status,
    title: event.title,
    detail: event.detail,
    startedAt: event.observedAt,
    endedAt: event.resolvedAt,
    evidence: safeEvidence(event.evidence),
  };
}

function mapFact(fact: StoredFact, from: string, to: string): TelemetryFact {
  return {
    id: fact.factId,
    kind: factKind(fact.kind),
    slotIds: fact.slotIds.filter(isSlotId),
    statement: fact.text,
    values: safeFactValues(fact.evidence),
    unit: fact.unit ?? null,
    windowStart: from,
    windowEnd: to,
  };
}

function factKind(kind: StoredFact["kind"]): TelemetryFactKind {
  if (kind === "quality") return "data-quality";
  if (kind === "correlation") return "co-movement";
  return kind;
}

function safeEvidence(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).flatMap(([key, value]) => (
    value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
      ? [[key, value]]
      : []
  ))) as Record<string, number | string | boolean | null>;
}

function safeFactValues(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).flatMap(([key, value]) => (
    value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
      ? [[key, value]]
      : []
  ))) as Record<string, number | string | null>;
}

function isSlotId(value: unknown): value is TelemetrySlotId {
  return typeof value === "string" && /^slot-[1-6]$/.test(value);
}

function isProvider(value: unknown): value is DashboardSnapshot["provider"] {
  return value === "mock" || value === "huawei-cloud";
}

function slotIdsForFacts(facts: TelemetryFact[], ids: string[]) {
  const wanted = new Set(ids);
  return [...new Set(facts.filter((fact) => wanted.has(fact.id)).flatMap((fact) => fact.slotIds))];
}

function headlineFor(analysis: TelemetryDeterministicAnalysis, flatlineCount: number) {
  if (analysis.reportCount < 2) return "数据正在积累，暂不足以判断趋势";
  if (analysis.coverage < 0.6) return "当前数据覆盖有限，建议先检查采集连续性";
  if (flatlineCount || analysis.anomalies.length) return "部分指标需要结合曲线和设备状态进一步复核";
  return "所选时间范围的数据统计已经完成";
}
