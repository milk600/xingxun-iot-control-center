import type { TwinDisplayMode, TwinStandardView } from "@/app/lib/digital-twin/contracts";
import type { TelemetrySlotId, VehicleMotion } from "@/app/lib/iot/contracts";
import type {
  TelemetryAvailabilityDiagnostic,
  TelemetryHistoryRange,
} from "@/app/lib/iot/telemetry-history-contracts";
import type { SpatialLayerId } from "@/app/lib/spatial/contracts";
import type { AlertAction, AlertSeverity, AlertWorkOrderStatus } from "@/app/lib/alerts/contracts";

export const AGENT_PROTOCOL_VERSION = 1 as const;

export type ClientRole = "display" | "remote" | "standalone";
export type VoiceSessionPhase =
  | "idle"
  | "listening"
  | "understanding"
  | "confirming"
  | "executing"
  | "speaking"
  | "error";

export interface VoiceSessionState {
  phase: VoiceSessionPhase;
  transcript: string;
  reply: string;
  publicAction: string | null;
  error: string | null;
  updatedAt: string;
}

export type UiPage =
  | "overview"
  | "digital-twin"
  | "vehicle"
  | "monitoring"
  | "alerts"
  | "integrations"
  | "settings";

/** Stable, user-facing regions that the Agent may reveal and highlight. */
export const UI_REGION_IDS = {
  overview: ["telemetry", "spatial-overview", "vehicle-status", "recent-events"],
  monitoring: [
    "metric-cards",
    "live-chart",
    "slot-details",
    "analysis-summary",
    "indicator-posture",
    "ai-analysis",
    "ai-problems",
    "ai-recommendations",
    "range-profile",
    "correlation-matrix",
    "daily-heatmap",
    "spatial-distribution",
    "history-table",
    "event-timeline",
  ],
  vehicle: ["inspection-map", "vehicle-camera", "manual-controls", "vehicle-status", "command-log"],
  alerts: ["alert-summary", "alert-list", "alert-detail", "alert-timeline", "alert-rules"],
  "digital-twin": ["viewport", "scene-panel", "device-panel", "display-panel"],
  integrations: ["connection-summary", "sensor-connection", "vehicle-connection", "ai-connection"],
  settings: ["account-security", "refresh-settings", "vehicle-settings", "model-storage", "diagnostics"],
} as const satisfies Record<UiPage, readonly string[]>;

export type UiRegion = (typeof UI_REGION_IDS)[UiPage][number];

export type MonitoringTab = "live" | "analysis" | "history" | "events";
export type TwinPanel = "scene" | "devices" | "display";
export type SettingsSection = "account" | "refresh" | "vehicle" | "models" | "diagnostics";

export type AgentAction =
  | { name: "ui.navigate"; arguments: { page: UiPage } }
  | { name: "ui.back"; arguments: Record<string, never> }
  | { name: "ui.focus_region"; arguments: { page: UiPage; region: UiRegion } }
  | {
      name: "ui.scroll";
      arguments: {
        page: UiPage;
        direction: "up" | "down" | "top" | "bottom";
        amount?: "small" | "page";
      };
    }
  | { name: "telemetry.read_current"; arguments: { slotId?: TelemetrySlotId } }
  | { name: "telemetry.inspect_current"; arguments: { slotIds?: TelemetrySlotId[] } }
  | { name: "telemetry.focus"; arguments: { slotId: TelemetrySlotId } }
  | { name: "monitoring.set_tab"; arguments: { tab: MonitoringTab } }
  | { name: "monitoring.set_visible_series"; arguments: { slotIds: TelemetrySlotId[] } }
  | { name: "monitoring.set_series_visibility"; arguments: { slotId: TelemetrySlotId; visible: boolean } }
  | { name: "monitoring.set_range"; arguments: { range: TelemetryHistoryRange } }
  | { name: "monitoring.generate_analysis"; arguments: { slotIds?: TelemetrySlotId[] } }
  | { name: "monitoring.set_paused"; arguments: { paused: boolean } }
  | { name: "monitoring.refresh"; arguments: Record<string, never> }
  | { name: "twin.set_view"; arguments: { view: TwinStandardView } }
  | { name: "twin.set_display_mode"; arguments: { mode: TwinDisplayMode } }
  | { name: "twin.set_gap_diagnostic"; arguments: { active: boolean } }
  | { name: "twin.set_point_size"; arguments: { size: number } }
  | { name: "twin.open_panel"; arguments: { panel: TwinPanel } }
  | { name: "twin.close_panels"; arguments: Record<string, never> }
  | { name: "twin.reset_view"; arguments: Record<string, never> }
  | { name: "twin.capture"; arguments: Record<string, never> }
  | {
      name: "twin.orbit";
      arguments: {
        revolutions: number;
        durationMs: number;
        elevationDeg: number;
        direction: "clockwise" | "counterclockwise";
      };
    }
  | { name: "spatial.set_layer"; arguments: { layer: SpatialLayerId } }
  | { name: "spatial.begin_calibration"; arguments: Record<string, never> }
  | { name: "spatial.calibrate"; arguments: { x: number; y: number; headingDeg: number } }
  | {
      name: "spatial.set_dimensions";
      arguments: { widthM: number; heightM: number };
    }
  | { name: "vehicle.set_control_speed"; arguments: { speedPercent: number } }
  | {
      name: "vehicle.propose_move";
      arguments: {
        motion: Exclude<VehicleMotion, "stop">;
        speedPercent?: number;
        durationMs?: number;
      };
    }
  | {
      name: "vehicle.move_distance";
      arguments: {
        direction: "forward" | "backward";
        distanceMm: number;
        maxSpeedMmps?: number;
        timeoutS?: number;
      };
    }
  | {
      name: "vehicle.turn_angle";
      arguments: {
        direction: "left" | "right";
        angleDeg: number;
        maxSpeedMmps?: number;
        timeoutS?: number;
      };
    }
  | { name: "vehicle.navigate_to_checkpoint"; arguments: { checkpointName: string } }
  | { name: "vehicle.confirm"; arguments: Record<string, never> }
  | { name: "vehicle.cancel"; arguments: Record<string, never> }
  | { name: "vehicle.stop"; arguments: Record<string, never> }
  | { name: "connections.refresh"; arguments: Record<string, never> }
  | { name: "alerts.refresh"; arguments: Record<string, never> }
  | { name: "alerts.set_tab"; arguments: { tab: AlertWorkOrderStatus | "rules" } }
  | { name: "alerts.set_severity_filter"; arguments: { severity: AlertSeverity | "all" } }
  | { name: "alerts.set_slot_filter"; arguments: { slotId: TelemetrySlotId | "all" } }
  | { name: "alerts.open_detail"; arguments: { alertId: string } }
  | { name: "alerts.begin_processing"; arguments: { alertId: string; expectedVersion: number } }
  | { name: "alerts.complete_work_order"; arguments: { alertId: string; expectedVersion: number; action: AlertAction; note: string } }
  | { name: "settings.set_section"; arguments: { section: SettingsSection } }
  | { name: "settings.set_refresh_interval"; arguments: { intervalMs: 1000 | 3500 | 5000 | 10000 } }
  | { name: "settings.set_pause_when_hidden"; arguments: { enabled: boolean } }
  | { name: "settings.set_motion_speed"; arguments: { percent: number } }
  | { name: "settings.set_vehicle_default_speed"; arguments: { percent: 25 | 55 | 80 } }
  | { name: "settings.set_keyboard_control"; arguments: { enabled: boolean } }
  | { name: "settings.set_voice_playback"; arguments: { enabled: boolean } }
  | { name: "settings.run_diagnostics"; arguments: Record<string, never> }
  | { name: "settings.save"; arguments: Record<string, never> }
  | { name: "overview.refresh"; arguments: Record<string, never> };

export type AgentActionName = AgentAction["name"];

/**
 * Correlation carried by every browser-side Agent action dispatch. The same
 * values are returned in `action.result`, so a late page callback can never
 * complete a newer plan step.
 */
export interface AgentActionExecutionMetadata {
  requestId: string | null;
  planId: string | null;
  stepIndex: number;
  actionExecutionId: string;
}

export type AgentActionDispatchDetail = AgentAction & AgentActionExecutionMetadata;

export interface AgentActionResultDetail extends AgentActionExecutionMetadata {
  actionName: AgentActionName;
  status: "success" | "error";
  message: string;
  completedAt: string;
}

export type AgentThinkingMode = "thinking" | "non-thinking";
export type AgentReasoningEffort = "high" | "max";

export interface AgentModelPreferences {
  thinkingMode: AgentThinkingMode;
  reasoningEffort: AgentReasoningEffort;
}

export interface AgentNavigationContext {
  checkpoints: Array<{
    id: string;
    name: string;
    x: number;
    y: number;
    updatedAt: string;
  }>;
  pose: {
    x: number;
    y: number;
    headingDeg: number;
    observedAt: string | null;
  } | null;
  calibrationConfirmed: boolean;
  mapRevision: number | null;
  /** Optional for protocol compatibility with clients predating live readiness reporting. */
  controlLink?: "disabled" | "disconnected" | "connecting" | "connected" | "error";
  vehicleConnection?: "online" | "stale" | "offline";
  imuState?: "live" | "calibrating" | "stale" | "offline" | "error" | null;
  mapObservedAt?: string | null;
  poseObservedAt?: string | null;
  updatedAt: string;
}

export function normalizeAgentThinkingMode(value: unknown): AgentThinkingMode {
  return value === "non-thinking" ? "non-thinking" : "thinking";
}

export function normalizeAgentReasoningEffort(value: unknown): AgentReasoningEffort {
  return value === "max" ? "max" : "high";
}

export interface AgentPlanStep {
  index: number;
  label: string;
  action: AgentAction;
}

export interface AgentPlan {
  id: string;
  requestId?: string;
  summary: string;
  planningMode: AgentThinkingMode;
  steps: AgentPlanStep[];
  createdAt: string;
  planQuality?: "verified" | "best-effort";
  warnings?: string[];
  dataAvailability?: TelemetryAvailabilityDiagnostic;
}

export type AgentPlanningStageId = "understand" | "context" | "plan" | "validate" | "execution";
export type AgentPlanningStageStatus = "pending" | "active" | "complete" | "error";

export interface AgentPlanningStage {
  id: AgentPlanningStageId;
  label: string;
  status: AgentPlanningStageStatus;
  detail: string;
}

export interface AgentPlanningTrace {
  requestId: string;
  planningMode: AgentThinkingMode | null;
  stages: AgentPlanningStage[];
  updatedAt: string;
}

export interface AgentEnvelope<TType extends string = string, TPayload = unknown> {
  version: typeof AGENT_PROTOCOL_VERSION;
  id: string;
  type: TType;
  source: string;
  target: string;
  timestamp: string;
  payload: TPayload;
}

interface PendingVehicleCommandBase {
  confirmationId: string;
  requestedBy: string;
  expiresAt: string;
}

export type PendingVehicleCommand = PendingVehicleCommandBase & (
  | {
      kind: "timed";
      motion: Exclude<VehicleMotion, "stop">;
      speedPercent: number;
      durationMs: number;
    }
  | {
      kind: "distance";
      direction: "forward" | "backward";
      distanceMm: number;
      maxSpeedMmps: number;
      timeoutS: number;
    }
  | {
      kind: "turn";
      direction: "left" | "right";
      angleDeg: number;
      maxSpeedMmps: number;
      timeoutS: number;
    }
);

export interface AgentHistoryItem {
  id: string;
  kind: "user" | "assistant" | "action" | "error";
  text: string;
  timestamp: string;
}

export const PAGE_PATHS: Record<UiPage, string> = {
  overview: "/",
  "digital-twin": "/digital-twin",
  vehicle: "/vehicle",
  monitoring: "/monitoring",
  alerts: "/alerts",
  integrations: "/integrations",
  settings: "/settings",
};

export const EMPTY_VOICE_SESSION: VoiceSessionState = {
  phase: "idle",
  transcript: "",
  reply: "",
  publicAction: null,
  error: null,
  updatedAt: new Date(0).toISOString(),
};

export function createAgentEnvelope<TType extends string, TPayload>(
  type: TType,
  source: string,
  target: string,
  payload: TPayload,
): AgentEnvelope<TType, TPayload> {
  return {
    version: AGENT_PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    type,
    source,
    target,
    timestamp: new Date().toISOString(),
    payload,
  };
}
