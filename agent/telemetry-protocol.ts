import {
  TELEMETRY_RESOLUTIONS,
  type TelemetryAnalysisRequest,
  type TelemetryEventsRequest,
  type TelemetryHistoryRequest,
  type TelemetryResolution,
} from "../app/lib/iot/telemetry-history-contracts";
import { TELEMETRY_SLOT_IDS, type TelemetrySlotId } from "../app/lib/iot/contracts";

const MAX_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SLOT_IDS = new Set<string>(TELEMETRY_SLOT_IDS);
const RESOLUTIONS = new Set<string>(TELEMETRY_RESOLUTIONS);

export function parseTelemetryHistoryRequest(payload: unknown): TelemetryHistoryRequest {
  const input = objectValue(payload);
  const base = parseBaseRequest(input, true);
  const resolution = input.resolution === undefined
    ? undefined
    : parseResolution(input.resolution);
  return { ...base, ...(resolution ? { resolution } : {}) };
}
export function parseTelemetryEventsRequest(payload: unknown): TelemetryEventsRequest {
  const input = objectValue(payload);
  const base = parseBaseRequest(input, false);
  return {
    requestId: base.requestId,
    from: base.from,
    to: base.to,
    ...(base.slotIds.length ? { slotIds: base.slotIds } : {}),
  };
}

export function parseTelemetryAnalysisRequest(payload: unknown): TelemetryAnalysisRequest {
  return parseBaseRequest(objectValue(payload), true);
}

function parseBaseRequest(input: Record<string, unknown>, requireSlots: boolean) {
  const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
  if (!requestId || requestId.length > 80 || !/^[A-Za-z0-9_.:-]+$/.test(requestId)) {
    throw new Error("遥测请求 ID 无效");
  }
  const from = parseIsoTime(input.from, "开始时间");
  const to = parseIsoTime(input.to, "结束时间");
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (fromMs >= toMs) throw new Error("遥测时间范围无效");
  if (toMs - fromMs > MAX_HISTORY_WINDOW_MS + 60_000) throw new Error("遥测时间范围不能超过 30 天");
  if (toMs > Date.now() + 5 * 60_000) throw new Error("遥测结束时间不能位于未来");
  const slotIds = parseSlotIds(input.slotIds, requireSlots);
  return { requestId, from, to, slotIds };
}

function parseSlotIds(value: unknown, required: boolean) {
  if (value === undefined && !required) return [] as TelemetrySlotId[];
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > TELEMETRY_SLOT_IDS.length) {
    throw new Error("遥测数据位集合无效");
  }
  if (value.some((slotId) => typeof slotId !== "string" || !SLOT_IDS.has(slotId))) {
    throw new Error("遥测数据位集合无效");
  }
  return [...new Set(value)] as TelemetrySlotId[];
}

function parseResolution(value: unknown): TelemetryResolution {
  if (typeof value !== "string" || !RESOLUTIONS.has(value)) throw new Error("遥测聚合粒度无效");
  return value as TelemetryResolution;
}

function parseIsoTime(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label}无效`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label}无效`);
  return new Date(timestamp).toISOString();
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("遥测请求格式无效");
  return value as Record<string, unknown>;
}
