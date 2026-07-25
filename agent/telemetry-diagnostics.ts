import type {
  TelemetryAvailabilityDiagnostic,
  TelemetryAvailabilityCode,
} from "../app/lib/iot/telemetry-history-contracts";
import {
  TELEMETRY_SLOT_IDS,
  type DataState,
  type TelemetrySlotId,
} from "../app/lib/iot/contracts";
import type {
  TelemetryAvailabilityInspection,
  TelemetryCollectorStatus,
  TelemetryStore,
} from "./telemetry-store";

export interface TelemetryAvailabilityRuntimeContext {
  slots?: Partial<Record<TelemetrySlotId, {
    state?: string;
    observedAt?: string | null;
  }>>;
  collector?: TelemetryCollectorStatus;
}

export interface TelemetryAvailabilityQuery {
  from: string;
  to: string;
  slotIds: readonly TelemetrySlotId[];
}

export function diagnoseTelemetryAvailability(
  store: TelemetryStore,
  query: TelemetryAvailabilityQuery,
  runtime: TelemetryAvailabilityRuntimeContext = {},
): TelemetryAvailabilityDiagnostic {
  const requestedSlotIds = [...new Set(query.slotIds)];
  const inspection = store.inspectAvailability(query);
  const availableSlotIds = inspection.availableSlotIds.filter(isSlotId);
  const availableSet = new Set(availableSlotIds);
  const unavailableSlotIds = requestedSlotIds.filter((slotId) => !availableSet.has(slotId));
  const code = availabilityCode(inspection, unavailableSlotIds.length > 0);
  const latestReport = latestReportFor(inspection, requestedSlotIds, runtime);
  const suggestedRange = suggestedRangeFor(inspection);
  const { title, detail } = publicAvailabilityText(
    code,
    inspection,
    unavailableSlotIds,
    latestReport,
  );

  return {
    status: code === "available" ? "available" : (
      code === "partial-slots" || code === "insufficient-observations" ? "limited" : "unavailable"
    ),
    code,
    title,
    detail,
    requestedFrom: inspection.from,
    requestedTo: inspection.to,
    recordedFrom: inspection.recordedFrom,
    recordedTo: inspection.recordedTo,
    sampleCount: inspection.sampleCount,
    uniqueObservations: inspection.uniqueObservations,
    requestedSlotIds,
    availableSlotIds,
    unavailableSlotIds,
    latestReport,
    suggestedRange,
  };
}

export function spatialAvailabilityDiagnostic(
  query: TelemetryAvailabilityQuery,
  sampleCounts?: Partial<Record<TelemetrySlotId, number>>,
): TelemetryAvailabilityDiagnostic {
  const requestedSlotIds = [...new Set(query.slotIds)];
  const hasClientEvidence = sampleCounts !== undefined;
  const availableSlotIds = requestedSlotIds.filter((slotId) => Number(sampleCounts?.[slotId] ?? 0) > 0);
  const unavailableSlotIds = requestedSlotIds.filter((slotId) => !availableSlotIds.includes(slotId));
  const sampleCount = availableSlotIds.reduce((sum, slotId) => sum + Math.max(0, Number(sampleCounts?.[slotId] ?? 0)), 0);
  const code: TelemetryAvailabilityCode = hasClientEvidence && unavailableSlotIds.length
    ? "spatial-samples-unavailable"
    : hasClientEvidence ? "available" : "spatial-samples-unverified";
  return {
    status: code === "available" ? "available" : code === "spatial-samples-unverified" ? "limited" : "unavailable",
    code,
    title: code === "available"
      ? "空间采样可用"
      : code === "spatial-samples-unavailable" ? "尚无对应空间采样" : "将在巡检地图中核对空间采样",
    detail: code === "available"
      ? `当前显示端保存了 ${sampleCount} 个对应空间采样点。`
      : code === "spatial-samples-unavailable"
        ? "当前显示端没有所选指标的位置采样点。请先完成小车起点标定并采集带位置的数据。"
        : "空间采样保存在显示端，网关不会把未核对的历史数据当作位置数据。进入巡检地图后将按实际采样情况显示。",
    requestedFrom: query.from,
    requestedTo: query.to,
    recordedFrom: null,
    recordedTo: null,
    sampleCount,
    uniqueObservations: sampleCount,
    requestedSlotIds,
    availableSlotIds,
    unavailableSlotIds,
    latestReport: { observedAt: null, state: "unknown", collector: "waiting" },
    suggestedRange: null,
  };
}

function availabilityCode(
  inspection: TelemetryAvailabilityInspection,
  hasUnavailableSlots: boolean,
): TelemetryAvailabilityCode {
  if (!inspection.recordedFrom || !inspection.recordedTo) return "empty-store";
  if (Date.parse(inspection.recordedTo) < Date.parse(inspection.from)) return "data-before-range";
  if (Date.parse(inspection.recordedFrom) > Date.parse(inspection.to)) return "data-after-range";
  if (inspection.uniqueObservations === 0) return "no-data-in-range";
  if (inspection.sampleCount === 0) return "no-valid-values";
  if (hasUnavailableSlots) return "partial-slots";
  if (inspection.uniqueObservations < 2) return "insufficient-observations";
  return "available";
}

function latestReportFor(
  inspection: TelemetryAvailabilityInspection,
  requestedSlotIds: readonly TelemetrySlotId[],
  runtime: TelemetryAvailabilityRuntimeContext,
): TelemetryAvailabilityDiagnostic["latestReport"] {
  const runtimeReports = requestedSlotIds.flatMap((slotId) => {
    const slot = runtime.slots?.[slotId];
    return slot ? [{ state: normalizeState(slot.state), observedAt: validIso(slot.observedAt) }] : [];
  });
  const storedReports = requestedSlotIds.flatMap((slotId) => {
    const slot = inspection.latestBySlot[slotId];
    return slot ? [{ state: normalizeState(slot.state), observedAt: validIso(slot.observedAt) }] : [];
  });
  const reports = runtimeReports.length ? runtimeReports : storedReports;
  const observedAt = reports
    .flatMap((report) => report.observedAt ? [report.observedAt] : [])
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1) ?? null;
  const state = reports.length
    ? reports.map((report) => report.state).sort((left, right) => statePriority(right) - statePriority(left))[0]
    : "unknown";
  return {
    observedAt,
    state,
    collector: collectorState(runtime.collector),
  };
}

function suggestedRangeFor(
  inspection: TelemetryAvailabilityInspection,
): TelemetryAvailabilityDiagnostic["suggestedRange"] {
  if (!inspection.recordedFrom || !inspection.recordedTo) return null;
  const recordedFromMs = Date.parse(inspection.recordedFrom);
  const recordedToMs = Date.parse(inspection.recordedTo);
  const requestedDuration = Math.max(60_000, Date.parse(inspection.to) - Date.parse(inspection.from));
  const toMs = recordedToMs;
  const fromMs = Math.min(toMs - 1, Math.max(recordedFromMs, toMs - requestedDuration));
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  };
}

function publicAvailabilityText(
  code: TelemetryAvailabilityCode,
  inspection: TelemetryAvailabilityInspection,
  unavailableSlotIds: readonly TelemetrySlotId[],
  latestReport: TelemetryAvailabilityDiagnostic["latestReport"],
) {
  const recordedRange = inspection.recordedFrom && inspection.recordedTo
    ? `本机记录从 ${publicTime(inspection.recordedFrom)} 到 ${publicTime(inspection.recordedTo)}`
    : "本机尚未形成历史记录";
  const latest = latestReport.observedAt
    ? `最近上报于 ${publicTime(latestReport.observedAt)}，状态为${stateLabel(latestReport.state)}`
    : `当前上报状态为${stateLabel(latestReport.state)}`;
  switch (code) {
    case "empty-store":
      return { title: "尚未记录到所选数据", detail: `${recordedRange}；${latest}。页面可以打开，但不能据此判断时段变化。` };
    case "data-before-range":
      return { title: "所选时段晚于现有记录", detail: `该时段没有样本；${recordedRange}；${latest}。可切换到最近有记录的时段查看。` };
    case "data-after-range":
      return { title: "所选时段早于本机记录", detail: `该时段没有样本；${recordedRange}。历史记录器无法回填启动前的数据。` };
    case "no-data-in-range":
      return { title: "所选时段存在采样空档", detail: `该时段没有独立上报；${recordedRange}；${latest}。这属于数据缺口，不是界面参数错误。` };
    case "no-valid-values":
      return { title: "所选时段没有有效数值", detail: `已找到上报记录，但所选指标没有可用于绘图的数值；${latest}。` };
    case "partial-slots":
      return { title: "部分指标缺少样本", detail: `当前有 ${inspection.uniqueObservations} 次独立上报，但 ${unavailableSlotIds.length} 个所选指标没有有效数值；其余指标仍可继续查看。` };
    case "insufficient-observations":
      return { title: "样本正在积累", detail: `该时段只有 ${inspection.uniqueObservations} 次独立上报，可以查看读数，但不足以判断变化幅度或趋势。` };
    default:
      return { title: "数据证据可用", detail: `已找到 ${inspection.uniqueObservations} 次独立上报，可继续查看图表与统计。` };
  }
}

function validIso(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function normalizeState(value: unknown): DataState | "unknown" {
  return typeof value === "string" && ["loading", "live", "stale", "offline", "empty", "error"].includes(value)
    ? value as DataState
    : "unknown";
}

function statePriority(state: DataState | "unknown") {
  return ({ unknown: 0, live: 1, loading: 2, empty: 3, stale: 4, offline: 5, error: 6 } as const)[state];
}

function stateLabel(state: DataState | "unknown") {
  return ({
    live: "正常",
    loading: "读取中",
    stale: "较久未更新",
    offline: "离线",
    empty: "暂无读数",
    error: "读取异常",
    unknown: "待确认",
  } as const)[state];
}

function collectorState(status: TelemetryCollectorStatus | undefined): TelemetryAvailabilityDiagnostic["latestReport"]["collector"] {
  if (!status?.running) return status ? "stopped" : "waiting";
  if (status.collecting) return "collecting";
  if (status.consecutiveFailures > 0) return "retrying";
  return status.lastSuccessAt ? "ready" : "waiting";
}

function publicTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function isSlotId(value: string): value is TelemetrySlotId {
  return (TELEMETRY_SLOT_IDS as readonly string[]).includes(value);
}
