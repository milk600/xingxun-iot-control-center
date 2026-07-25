import type { DashboardSnapshot, DataState, TelemetrySlotId } from "./contracts";

export const TELEMETRY_HISTORY_RANGES = ["1h", "24h", "7d", "30d"] as const;
export type TelemetryHistoryRange = (typeof TELEMETRY_HISTORY_RANGES)[number];

export const TELEMETRY_RESOLUTIONS = ["raw", "1m", "5m", "1h"] as const;
export type TelemetryResolution = (typeof TELEMETRY_RESOLUTIONS)[number];

export const TELEMETRY_POLL_INTERVALS = [1000, 3500, 5000, 10000] as const;
export type TelemetryPollIntervalMs = (typeof TELEMETRY_POLL_INTERVALS)[number];

export interface TelemetryCollectorSettings {
  pollIntervalMs: TelemetryPollIntervalMs;
  updatedAt: string;
  updatedBy: string;
}

export interface TelemetryCollectorSettingsState {
  phase: "idle" | "loading" | "saving" | "ready" | "error";
  settings: TelemetryCollectorSettings | null;
  canEdit: boolean;
  requestId: string | null;
  error: string | null;
}

export interface TelemetryHistoryRequest {
  requestId: string;
  from: string;
  to: string;
  slotIds: TelemetrySlotId[];
  resolution?: TelemetryResolution;
}

export interface TelemetryBucket {
  startAt: string;
  endAt: string;
  minimum: number;
  maximum: number;
  average: number;
  last: number;
  count: number;
}

export interface TelemetrySeriesSummary {
  minimum: number | null;
  maximum: number | null;
  average: number | null;
  median: number | null;
  delta: number | null;
  slopePerHour: number | null;
  volatility: number | null;
  sampleCount: number;
  completeness: number;
  latestObservedAt: string | null;
}

export type TelemetryAvailabilityStatus = "available" | "limited" | "unavailable";

export type TelemetryAvailabilityCode =
  | "available"
  | "empty-store"
  | "data-before-range"
  | "data-after-range"
  | "no-data-in-range"
  | "no-valid-values"
  | "partial-slots"
  | "insufficient-observations"
  | "spatial-samples-unavailable"
  | "spatial-samples-unverified";

/**
 * Public, deterministic evidence about whether the requested data can answer a
 * question. Text fields are safe to show directly; they never contain model
 * reasoning or storage/SQL errors.
 */
export interface TelemetryAvailabilityDiagnostic {
  status: TelemetryAvailabilityStatus;
  code: TelemetryAvailabilityCode;
  title: string;
  detail: string;
  requestedFrom: string;
  requestedTo: string;
  recordedFrom: string | null;
  recordedTo: string | null;
  sampleCount: number;
  uniqueObservations: number;
  requestedSlotIds: TelemetrySlotId[];
  availableSlotIds: TelemetrySlotId[];
  unavailableSlotIds: TelemetrySlotId[];
  latestReport: {
    observedAt: string | null;
    state: DataState | "unknown";
    collector: "ready" | "collecting" | "retrying" | "waiting" | "stopped";
  };
  suggestedRange: { from: string; to: string } | null;
}

export interface TelemetryHistorySeries {
  slotId: TelemetrySlotId;
  sourceKey: string | null;
  label: string;
  unit: string;
  precision: number;
  buckets: TelemetryBucket[];
  summary: TelemetrySeriesSummary;
}

export interface TelemetryHistoryResult {
  requestId: string;
  from: string;
  to: string;
  capturedFrom: string | null;
  generatedAt: string;
  dataVersion: string;
  provider: DashboardSnapshot["provider"];
  resolution: TelemetryResolution;
  expectedIntervalMs: number;
  uniqueObservations: number;
  coverage: number;
  series: TelemetryHistorySeries[];
  availability?: TelemetryAvailabilityDiagnostic;
}

export type TelemetryEventType =
  | "data-gap"
  | "state-change"
  | "flatline"
  | "anomaly"
  | "collector-error"
  | "recovery";

export interface TelemetryEvent {
  id: string;
  slotId: TelemetrySlotId | null;
  type: TelemetryEventType;
  severity: "info" | "warning" | "critical";
  status: "active" | "resolved";
  title: string;
  detail: string;
  startedAt: string;
  endedAt: string | null;
  evidence: Record<string, number | string | boolean | null>;
}

export interface TelemetryEventsRequest {
  requestId: string;
  from: string;
  to: string;
  slotIds?: TelemetrySlotId[];
}

export interface TelemetryEventsResult {
  requestId: string;
  from: string;
  to: string;
  generatedAt: string;
  events: TelemetryEvent[];
}

export type TelemetryFactKind =
  | "current"
  | "range"
  | "change"
  | "trend"
  | "variability"
  | "data-gap"
  | "co-movement"
  | "flatline"
  | "anomaly"
  | "data-quality";

export interface TelemetryFact {
  id: string;
  kind: TelemetryFactKind;
  slotIds: TelemetrySlotId[];
  statement: string;
  values: Record<string, number | string | null>;
  unit: string | null;
  windowStart: string;
  windowEnd: string;
}

export interface TelemetryAnalysisRequest {
  requestId: string;
  from: string;
  to: string;
  slotIds: TelemetrySlotId[];
}

export interface TelemetryAnalysisFinding {
  id: string;
  title: string;
  summary: string;
  factIds: string[];
  severity: "info" | "attention";
}

export interface TelemetryAnalysisRecommendation {
  id: string;
  title: string;
  rationale: string;
  factIds: string[];
  relatedSlotIds: TelemetrySlotId[];
}

export interface TelemetryAnalysisResult {
  requestId: string;
  status: "complete" | "insufficient-data" | "unavailable";
  generatedAt: string;
  dataVersion: string;
  basis: {
    provider: DashboardSnapshot["provider"];
    isDemo: boolean;
    windowStart: string;
    windowEnd: string;
    sampleCount: number;
    uniqueObservations: number;
    coverage: number;
    quality: "low" | "medium" | "high";
  };
  headline: string;
  facts: TelemetryFact[];
  findings: TelemetryAnalysisFinding[];
  recommendations: TelemetryAnalysisRecommendation[];
  caveats: string[];
  availability?: TelemetryAvailabilityDiagnostic;
}

export interface TelemetryAnalyticsState {
  historyPhase: "idle" | "loading" | "ready" | "error";
  history: TelemetryHistoryResult | null;
  historyError: string | null;
  eventsPhase: "idle" | "loading" | "ready" | "error";
  events: TelemetryEventsResult | null;
  eventsError: string | null;
  analysisPhase: "idle" | "loading-data" | "calculating" | "analyzing" | "organizing" | "ready" | "error";
  analysis: TelemetryAnalysisResult | null;
  analysisError: string | null;
}

export interface TelemetryCollectorSnapshot {
  slots: Partial<Record<TelemetrySlotId, {
    sourceKey: string | null;
    label: string;
    value: number | null;
    unit: string;
    precision: number;
    state: DataState;
    observedAt: string | null;
    auxiliaryReadings?: ReadonlyArray<{
      sourceKey: string;
      label: string;
      value: number | null;
      unit: string;
      precision: number;
    }>;
  }>>;
  provider: DashboardSnapshot["provider"];
  generatedAt: string;
}
