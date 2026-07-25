import type { TelemetryEvent, TelemetryEventType } from "@/app/lib/iot/telemetry-history-contracts";
import type { TelemetrySlotId } from "@/app/lib/iot/contracts";

export const ALERT_WORK_ORDER_STATUSES = ["pending", "processing", "completed"] as const;
export type AlertWorkOrderStatus = (typeof ALERT_WORK_ORDER_STATUSES)[number];

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_ACTIONS = [
  "site-inspection",
  "restore-connection",
  "sensor-check",
  "environment-adjustment",
  "false-positive",
  "other",
] as const;
export type AlertAction = (typeof ALERT_ACTIONS)[number];

export const ALERT_ACTION_LABELS: Record<AlertAction, string> = {
  "site-inspection": "现场检查",
  "restore-connection": "恢复连接",
  "sensor-check": "检查或校准传感器",
  "environment-adjustment": "调整环境",
  "false-positive": "确认误报",
  other: "其他",
};

export type AlertSourceType = "telemetry-event" | "threshold";
export type AlertSourceState = "active" | "resolved";

export interface AlertTimelineEntry {
  id: string;
  type: "created" | "source-recovered" | "processing-started" | "completed";
  timestamp: string;
  actor: string | null;
  detail: string;
}

export interface AlertWorkOrder {
  id: string;
  sourceType: AlertSourceType;
  sourceEventId: string | null;
  telemetryEventType: TelemetryEventType | "threshold";
  slotId: TelemetrySlotId | null;
  title: string;
  detail: string;
  severity: AlertSeverity;
  sourceState: AlertSourceState;
  createdAt: string;
  recoveredAt: string | null;
  status: AlertWorkOrderStatus;
  assignee: string | null;
  startedAt: string | null;
  completedAt: string | null;
  action: AlertAction | null;
  note: string | null;
  version: number;
  evidence: Record<string, number | string | boolean | null>;
  timeline: AlertTimelineEntry[];
}

export interface AlertRule {
  slotId: TelemetrySlotId;
  enabled: boolean;
  lowerLimit: number | null;
  upperLimit: number | null;
  version: number;
  updatedAt: string | null;
}

export interface AlertSummary {
  pending: number;
  processing: number;
  completed: number;
  critical: number;
}

export interface AlertListFilters {
  statuses?: AlertWorkOrderStatus[];
  severities?: AlertSeverity[];
  slotIds?: TelemetrySlotId[];
  from?: string;
  to?: string;
  limit?: number;
}

export interface AlertListRequest extends AlertListFilters {
  requestId: string;
}

export interface AlertListResult {
  requestId: string;
  generatedAt: string;
  summary: AlertSummary;
  items: AlertWorkOrder[];
}

export interface AlertDetailRequest {
  requestId: string;
  alertId: string;
}

export interface AlertDetailResult {
  requestId: string;
  item: AlertWorkOrder;
}

export interface AlertBeginRequest extends AlertDetailRequest {
  expectedVersion: number;
  actor: string;
}

export interface AlertCompleteRequest extends AlertBeginRequest {
  action: AlertAction;
  note: string;
}

export interface AlertRulesRequest {
  requestId: string;
}

export interface AlertRulesResult {
  requestId: string;
  rules: AlertRule[];
  generatedAt: string;
}

export interface AlertRulesSaveRequest extends AlertRulesRequest {
  rules: AlertRule[];
  actor: string;
}

export interface AlertClearRequest {
  requestId: string;
  actor: string;
}

export interface AlertClearResult {
  requestId: string;
  clearedCount: number;
  ignoredBefore: string;
  generatedAt: string;
}

export interface AlertClientState {
  listPhase: "idle" | "loading" | "ready" | "error";
  list: AlertListResult | null;
  listError: string | null;
  detailPhase: "idle" | "loading" | "ready" | "saving" | "error";
  detail: AlertWorkOrder | null;
  detailError: string | null;
  rulesPhase: "idle" | "loading" | "ready" | "saving" | "error";
  rules: AlertRule[];
  rulesError: string | null;
  clearPhase: "idle" | "loading" | "ready" | "error";
  clearResult: AlertClearResult | null;
  clearError: string | null;
  readOnly: boolean;
}

export const EMPTY_ALERT_CLIENT_STATE: AlertClientState = {
  listPhase: "idle",
  list: null,
  listError: null,
  detailPhase: "idle",
  detail: null,
  detailError: null,
  rulesPhase: "idle",
  rules: [],
  rulesError: null,
  clearPhase: "idle",
  clearResult: null,
  clearError: null,
  readOnly: true,
};

export function telemetryEventSeverity(event: TelemetryEvent): AlertSeverity {
  return event.severity;
}
