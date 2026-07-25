import {
  ALERT_ACTIONS,
  ALERT_SEVERITIES,
  ALERT_WORK_ORDER_STATUSES,
  type AlertBeginRequest,
  type AlertCompleteRequest,
  type AlertClearRequest,
  type AlertDetailRequest,
  type AlertListRequest,
  type AlertRule,
  type AlertRulesRequest,
  type AlertRulesSaveRequest,
} from "../app/lib/alerts/contracts";
import { TELEMETRY_SLOT_IDS, type TelemetrySlotId } from "../app/lib/iot/contracts";

const SLOT_IDS = new Set<string>(TELEMETRY_SLOT_IDS);
const STATUSES = new Set<string>(ALERT_WORK_ORDER_STATUSES);
const SEVERITIES = new Set<string>(ALERT_SEVERITIES);
const ACTIONS = new Set<string>(ALERT_ACTIONS);

export function parseAlertListRequest(payload: unknown): AlertListRequest {
  const input = object(payload);
  return {
    requestId: requestId(input.requestId),
    ...(input.statuses === undefined ? {} : { statuses: stringArray(input.statuses, STATUSES, 3) as AlertListRequest["statuses"] }),
    ...(input.severities === undefined ? {} : { severities: stringArray(input.severities, SEVERITIES, 3) as AlertListRequest["severities"] }),
    ...(input.slotIds === undefined ? {} : { slotIds: stringArray(input.slotIds, SLOT_IDS, TELEMETRY_SLOT_IDS.length) as TelemetrySlotId[] }),
    ...(input.from === undefined ? {} : { from: timestamp(input.from, "开始时间") }),
    ...(input.to === undefined ? {} : { to: timestamp(input.to, "结束时间") }),
    ...(input.limit === undefined ? {} : { limit: integer(input.limit, 1, 2_000, "返回数量") }),
  };
}

export function parseAlertDetailRequest(payload: unknown): AlertDetailRequest {
  const input = object(payload);
  return { requestId: requestId(input.requestId), alertId: identifier(input.alertId, "告警编号") };
}

export function parseAlertBeginRequest(payload: unknown): AlertBeginRequest {
  const input = object(payload);
  return {
    ...parseAlertDetailRequest(input),
    expectedVersion: integer(input.expectedVersion, 1, Number.MAX_SAFE_INTEGER, "版本号"),
    actor: actor(input.actor),
  };
}

export function parseAlertCompleteRequest(payload: unknown): AlertCompleteRequest {
  const input = object(payload);
  const action = String(input.action ?? "");
  if (!ACTIONS.has(action)) throw new Error("处理方式无效");
  const note = String(input.note ?? "").trim();
  if (note.length < 2 || note.length > 500) throw new Error("处理说明需为 2–500 个字符");
  return { ...parseAlertBeginRequest(input), action: action as AlertCompleteRequest["action"], note };
}

export function parseAlertRulesRequest(payload: unknown): AlertRulesRequest {
  const input = object(payload);
  return { requestId: requestId(input.requestId) };
}

export function parseAlertClearRequest(payload: unknown): AlertClearRequest {
  const input = object(payload);
  return { requestId: requestId(input.requestId), actor: actor(input.actor) };
}

export function parseAlertRulesSaveRequest(payload: unknown): AlertRulesSaveRequest {
  const input = object(payload);
  if (!Array.isArray(input.rules) || input.rules.length !== TELEMETRY_SLOT_IDS.length) {
    throw new Error("需要提交完整的六路告警规则");
  }
  const rules = input.rules.map(parseRule);
  if (new Set(rules.map((rule) => rule.slotId)).size !== TELEMETRY_SLOT_IDS.length) {
    throw new Error("告警规则存在重复数据位");
  }
  return { requestId: requestId(input.requestId), actor: actor(input.actor), rules };
}

function parseRule(value: unknown): AlertRule {
  const input = object(value);
  const slotId = String(input.slotId ?? "");
  if (!SLOT_IDS.has(slotId)) throw new Error("规则数据位无效");
  if (typeof input.enabled !== "boolean") throw new Error("规则启用状态无效");
  const lowerLimit = nullableNumber(input.lowerLimit, "下限");
  const upperLimit = nullableNumber(input.upperLimit, "上限");
  if (input.enabled && lowerLimit === null && upperLimit === null) throw new Error("启用规则时至少填写一个阈值");
  if (lowerLimit !== null && upperLimit !== null && lowerLimit >= upperLimit) throw new Error("下限必须小于上限");
  return {
    slotId: slotId as TelemetrySlotId,
    enabled: input.enabled,
    lowerLimit,
    upperLimit,
    version: integer(input.version, 1, Number.MAX_SAFE_INTEGER, "规则版本"),
    updatedAt: input.updatedAt === null || input.updatedAt === undefined ? null : timestamp(input.updatedAt, "更新时间"),
  };
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求内容无效");
  return value as Record<string, unknown>;
}

function requestId(value: unknown) {
  return identifier(value, "请求编号");
}

function identifier(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new Error(`${label}无效`);
  return value.trim();
}

function actor(value: unknown) {
  if (typeof value !== "string") throw new Error("处理人无效");
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < 2 || normalized.length > 50) throw new Error("处理人名称需为 2–50 个字符");
  return normalized;
}

function stringArray(value: unknown, allowed: Set<string>, maximum: number) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("筛选条件无效");
  const normalized = [...new Set(value.map(String))];
  if (normalized.some((item) => !allowed.has(item))) throw new Error("筛选条件包含无效值");
  return normalized;
}

function timestamp(value: unknown, label: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label}无效`);
  return new Date(Date.parse(value)).toISOString();
}

function integer(value: unknown, minimum: number, maximum: number, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label}无效`);
  return parsed;
}

function nullableNumber(value: unknown, label: string) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label}无效`);
  return parsed;
}
