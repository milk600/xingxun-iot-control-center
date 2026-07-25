import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TELEMETRY_SLOT_IDS,
  type DashboardSnapshot,
  type DataState,
  type TelemetrySlot,
  type TelemetrySlotId,
} from "../app/lib/iot/contracts";
import type {
  TelemetryAnalysisResult as PublicTelemetryAnalysisResult,
  TelemetryCollectorSettings,
  TelemetryEvent as PublicTelemetryEvent,
  TelemetryEventsResult as PublicTelemetryEventsResult,
  TelemetryFact as PublicTelemetryFact,
  TelemetryHistoryRequest as PublicTelemetryHistoryRequest,
  TelemetryHistoryResult as PublicTelemetryHistoryResult,
  TelemetryHistorySeries as PublicTelemetryHistorySeries,
  TelemetryPollIntervalMs,
} from "../app/lib/iot/telemetry-history-contracts";
import { TELEMETRY_POLL_INTERVALS } from "../app/lib/iot/telemetry-history-contracts";
import {
  ALERT_ACTIONS,
  ALERT_SEVERITIES,
  ALERT_WORK_ORDER_STATUSES,
  type AlertAction,
  type AlertCompleteRequest,
  type AlertListFilters,
  type AlertListResult,
  type AlertRule,
  type AlertRulesSaveRequest,
  type AlertSeverity,
  type AlertTimelineEntry,
  type AlertWorkOrder,
} from "../app/lib/alerts/contracts";
import { getIoTProvider } from "../app/lib/iot/provider-factory.server";
import type { IoTProvider } from "../app/lib/iot/provider.server";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;
export const DEFAULT_TELEMETRY_POLL_INTERVAL_MS: TelemetryPollIntervalMs = 1_000;
export const DEFAULT_TELEMETRY_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_FAILURE_BACKOFF_MAX_MS = 5 * 60_000;
const MIN_CORRELATION_PAIRS = 12;
const MIN_ANOMALY_BASELINE = 20;
const FLATLINE_SAMPLE_COUNT = 20;

export type TelemetryResolution = "raw" | "1m" | "5m" | "1h";
export type TelemetryEventType = "gap" | "state-change" | "flatline" | "anomaly" | "fire" | "recovery";
export type TelemetryEventSeverity = "info" | "warning" | "error";

export interface TelemetryAuxiliaryReadingsMap {
  [key: string]: string | number | boolean | null;
}

export interface TelemetryAuxiliaryReading {
  sourceKey: string;
  label: string;
  value: number | null;
  unit: string;
  precision: number;
}

export type TelemetryAuxiliaryReadings = TelemetryAuxiliaryReadingsMap | TelemetryAuxiliaryReading[];

export interface TelemetrySample {
  slotId: string;
  observedAt: string;
  ingestedAt: string;
  value: number | null;
  state: DataState | string;
  provider: string;
  sourceKey: string | null;
  label: string;
  unit: string;
  precision: number;
  auxiliaryReadings: TelemetryAuxiliaryReadings;
}

export interface TelemetryBucket {
  slotId: string;
  startAt: string;
  endAt: string;
  min: number | null;
  max: number | null;
  average: number | null;
  last: number | null;
  count: number;
  state: DataState | string;
  provider: string;
  sourceKey: string | null;
  label: string;
  unit: string;
  precision: number;
}

export interface TelemetryHistoryQuery {
  from: string | number | Date;
  to: string | number | Date;
  slotIds?: readonly string[];
  resolution?: TelemetryResolution | "auto";
}

export interface TelemetryHistoryResult {
  from: string;
  to: string;
  resolution: TelemetryResolution;
  buckets: TelemetryBucket[];
  firstRecordedAt: string | null;
  expectedIntervalMs: number;
  uniqueObservations: number;
  coverage: number;
  provider: DashboardSnapshot["provider"];
}

export interface TelemetryAvailabilityInspection {
  from: string;
  to: string;
  recordedFrom: string | null;
  recordedTo: string | null;
  sampleCount: number;
  uniqueObservations: number;
  availableSlotIds: string[];
  latestBySlot: Record<string, {
    observedAt: string;
    state: string;
  }>;
}

export interface TelemetryEvent {
  id: number;
  type: TelemetryEventType;
  slotId: string | null;
  observedAt: string;
  resolvedAt: string | null;
  status: "active" | "resolved";
  severity: TelemetryEventSeverity;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
}

export interface TelemetryEventQuery {
  from: string | number | Date;
  to: string | number | Date;
  slotIds?: readonly string[];
  types?: readonly TelemetryEventType[];
  limit?: number;
}

export interface TelemetrySeriesSummary {
  slotId: string;
  label: string;
  unit: string;
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
}

export interface TelemetryCorrelation {
  leftSlotId: string;
  rightSlotId: string;
  coefficient: number;
  pairCount: number;
}

export interface TelemetryAnomaly {
  slotId: string;
  observedAt: string;
  value: number;
  baselineMedian: number;
  method: "mad" | "iqr" | "flat-baseline";
}

export interface TelemetryFact {
  factId: string;
  kind: "range" | "trend" | "quality" | "correlation" | "anomaly";
  slotIds: string[];
  label: string;
  text: string;
  value?: number;
  unit?: string;
  evidence: Record<string, unknown>;
}

export interface TelemetryDeterministicAnalysis {
  from: string;
  to: string;
  reportCount: number;
  coverage: number;
  summaries: TelemetrySeriesSummary[];
  correlations: TelemetryCorrelation[];
  anomalies: TelemetryAnomaly[];
  facts: TelemetryFact[];
}

export interface DeterministicAnalysisOptions {
  from?: string | number | Date;
  to?: string | number | Date;
  expectedIntervalMs?: number;
  minimumCorrelationPairs?: number;
  minimumAnomalyBaseline?: number;
}

export interface TelemetryStoreOptions {
  path?: string;
  retentionDays?: number;
  expectedIntervalMs?: number;
}

type CollectableSlot = TelemetrySlot & {
  supportingReadings?: unknown;
  lightRaw?: unknown;
};

interface SampleRow {
  slot_id: string;
  observed_at: number;
  ingested_at: number;
  value: number | null;
  state: string;
  provider: string;
  source_key: string | null;
  label: string;
  unit: string;
  precision: number;
  auxiliary_json: string;
}

interface BucketRow {
  slot_id: string;
  bucket_id: number;
  minimum: number | null;
  maximum: number | null;
  average: number | null;
  last_value: number | null;
  sample_count: number;
  state: string;
  provider: string;
  source_key: string | null;
  label: string;
  unit: string;
  precision: number;
}

interface EventRow {
  id: number;
  event_type: TelemetryEventType;
  slot_id: string | null;
  observed_at: number;
  resolved_at: number | null;
  status: "active" | "resolved";
  severity: TelemetryEventSeverity;
  title: string;
  detail: string;
  evidence_json: string;
}

interface AlertWorkOrderRow {
  id: string;
  source_key: string;
  source_type: "telemetry-event" | "threshold";
  source_event_id: string | null;
  telemetry_event_type: AlertWorkOrder["telemetryEventType"];
  slot_id: string | null;
  title: string;
  detail: string;
  severity: AlertSeverity;
  source_state: "active" | "resolved";
  created_at: number;
  recovered_at: number | null;
  work_status: AlertWorkOrder["status"];
  assignee: string | null;
  started_at: number | null;
  completed_at: number | null;
  action: AlertAction | null;
  note: string | null;
  version: number;
  evidence_json: string;
}

interface AlertTimelineRow {
  id: string;
  entry_type: AlertTimelineEntry["type"];
  happened_at: number;
  actor: string | null;
  detail: string;
}

interface AlertRuleRow {
  slot_id: string;
  enabled: number;
  lower_limit: number | null;
  upper_limit: number | null;
  version: number;
  updated_at: number | null;
}

interface AlertRuleStateRow {
  slot_id: string;
  violation_count: number;
  normal_count: number;
  active_work_order_id: string | null;
  last_observed_at: number | null;
}

interface CollectorPreferencesRow {
  poll_interval_ms: number;
  updated_at: number;
  updated_by: string;
}

export class AlertStoreConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "AlertStoreConflictError";
  }
}

export class TelemetryStore {
  readonly path: string;
  readonly retentionDays: number;
  readonly expectedIntervalMs: number;
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(options: TelemetryStoreOptions = {}) {
    const configuredPath = options.path?.trim() || process.env.TELEMETRY_HISTORY_DB?.trim() || "./data/telemetry-history.sqlite";
    this.path = configuredPath === ":memory:" ? configuredPath : resolve(configuredPath);
    this.retentionDays = positiveNumber(options.retentionDays ?? process.env.TELEMETRY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
    this.expectedIntervalMs = positiveInteger(options.expectedIntervalMs ?? process.env.TELEMETRY_SAMPLE_INTERVAL_MS, DEFAULT_SAMPLE_INTERVAL_MS);

    if (this.path !== ":memory:") {
      const parent = dirname(this.path);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    }
    this.database = new DatabaseSync(this.path);
    this.configureDatabase();
    this.createSchema();
  }

  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  readCollectorSettings(fallbackPollIntervalMs: TelemetryPollIntervalMs): TelemetryCollectorSettings {
    this.assertOpen();
    const existing = this.database.prepare(`
      SELECT poll_interval_ms, updated_at, updated_by
      FROM collector_preferences
      WHERE id = 1
      LIMIT 1
    `).get() as unknown as CollectorPreferencesRow | undefined;
    if (existing) return collectorSettingsFromRow(existing);

    const updatedAt = Date.now();
    this.database.prepare(`
      INSERT INTO collector_preferences (id, poll_interval_ms, updated_at, updated_by)
      VALUES (1, ?, ?, 'system-default')
    `).run(fallbackPollIntervalMs, updatedAt);
    return {
      pollIntervalMs: fallbackPollIntervalMs,
      updatedAt: new Date(updatedAt).toISOString(),
      updatedBy: "system-default",
    };
  }

  saveCollectorSettings(
    pollIntervalMs: TelemetryPollIntervalMs,
    updatedBy: string,
    updatedAt: string | number | Date = Date.now(),
  ): TelemetryCollectorSettings {
    this.assertOpen();
    const normalizedInterval = parseTelemetryPollIntervalMs(pollIntervalMs);
    const normalizedActor = normalizeCollectorSettingsActor(updatedBy);
    const updatedAtMs = timestampMs(updatedAt, "updatedAt");
    this.database.prepare(`
      INSERT INTO collector_preferences (id, poll_interval_ms, updated_at, updated_by)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        poll_interval_ms = excluded.poll_interval_ms,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(normalizedInterval, updatedAtMs, normalizedActor);
    return {
      pollIntervalMs: normalizedInterval,
      updatedAt: new Date(updatedAtMs).toISOString(),
      updatedBy: normalizedActor,
    };
  }

  recordSlots(
    slots: Readonly<Record<string, CollectableSlot>> | readonly CollectableSlot[],
    provider: string,
    ingestedAt: string | number | Date = Date.now(),
  ) {
    this.assertOpen();
    const ingestedAtMs = timestampMs(ingestedAt, "ingestedAt");
    const values = Array.isArray(slots) ? slots : Object.values(slots);
    let inserted = 0;
    let duplicates = 0;
    let missingObservedAt = 0;
    let events = 0;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const slot of values) {
        const observedAtMs = optionalTimestampMs(slot.observedAt);
        if (observedAtMs === null) {
          missingObservedAt += 1;
          events += this.ensureActiveEvent({
            type: "gap",
            slotId: slot.slotId,
            observedAtMs: ingestedAtMs,
            severity: slot.state === "error" ? "error" : "warning",
            title: `${slot.label} 缺少上报时间`,
            detail: "本次读数没有有效 observedAt，未写入历史样本。",
            evidence: { state: slot.state, provider },
          });
          continue;
        }

        const previous = this.latestSampleRow(slot.slotId);
        const result = this.database.prepare(`
          INSERT OR IGNORE INTO telemetry_samples (
            slot_id, observed_at, observed_at_iso, ingested_at, value, state,
            provider, source_key, label, unit, precision, auxiliary_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          slot.slotId,
          observedAtMs,
          new Date(observedAtMs).toISOString(),
          ingestedAtMs,
          finiteNumberOrNull(slot.value),
          slot.state,
          provider,
          slot.sourceKey,
          slot.label,
          slot.unit,
          slot.precision,
          JSON.stringify(extractAuxiliaryReadings(slot)),
        );

        if (Number(result.changes) === 0) {
          duplicates += 1;
          const existing = this.sampleRow(slot.slotId, observedAtMs);
          if (existing && existing.state !== slot.state) {
            events += this.recordStateTransition(slot, provider, ingestedAtMs, existing.state);
            this.database.prepare(`
              UPDATE telemetry_samples
              SET state = ?, ingested_at = ?, provider = ?, source_key = ?,
                  label = ?, unit = ?, precision = ?, auxiliary_json = ?
              WHERE slot_id = ? AND observed_at = ?
            `).run(
              slot.state,
              ingestedAtMs,
              provider,
              slot.sourceKey,
              slot.label,
              slot.unit,
              slot.precision,
              JSON.stringify(extractAuxiliaryReadings(slot)),
              slot.slotId,
              observedAtMs,
            );
          }
          continue;
        }
        inserted += 1;
        events += this.detectEvents(slot, provider, observedAtMs, previous);
        events += this.evaluateThresholdRule(slot, observedAtMs);
      }
      this.synchronizeTelemetryEventWorkOrders(ingestedAtMs);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return { inserted, duplicates, missingObservedAt, events };
  }

  recordCollectionFailure(error: unknown, observedAt: string | number | Date = Date.now()) {
    this.assertOpen();
    const observedAtMs = timestampMs(observedAt, "observedAt");
    const result = this.ensureActiveEvent({
      type: "gap",
      slotId: null,
      observedAtMs,
      severity: "error",
      title: "遥测采集暂时中断",
      detail: error instanceof Error ? error.message : String(error),
      evidence: { source: "collector" },
    });
    this.synchronizeTelemetryEventWorkOrders(observedAtMs);
    return result;
  }

  recordCollectionRecovery(observedAt: string | number | Date = Date.now()) {
    this.assertOpen();
    const observedAtMs = timestampMs(observedAt, "observedAt");
    const resolved = this.resolveActiveEvent("gap", null, observedAtMs);
    if (!resolved) return 0;
    this.insertPointEvent({
      type: "recovery",
      slotId: null,
      observedAtMs,
      severity: "info",
      title: "遥测采集已恢复",
      detail: "智能网关已重新取得有效遥测数据。",
      evidence: { recoveredEventType: "gap", source: "collector" },
    });
    this.synchronizeTelemetryEventWorkOrders(observedAtMs);
    return 1;
  }

  recordVehicleFireState(
    detected: boolean,
    observedAt: string | number | Date = Date.now(),
    reporter = "vehicle-client",
  ) {
    this.assertOpen();
    const observedAtMs = timestampMs(observedAt, "observedAt");
    const normalizedReporter = String(reporter).trim().slice(0, 120) || "vehicle-client";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const changed = detected
        ? this.ensureActiveEvent({
            type: "fire",
            slotId: null,
            observedAtMs,
            severity: "error",
            title: "检测到火焰",
            detail: "Jetson YOLO 已在车辆画面中检测到火焰，请立即核查现场并采取安全措施。",
            evidence: {
              fireDetected: true,
              source: "jetson-yolo",
              reporter: normalizedReporter,
            },
          })
        : this.resolveActiveEvent("fire", null, observedAtMs);
      if (changed) this.synchronizeTelemetryEventWorkOrders(observedAtMs);
      this.database.exec("COMMIT");
      return {
        changed: changed > 0,
        detected,
        observedAt: new Date(observedAtMs).toISOString(),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  querySamples(query: Omit<TelemetryHistoryQuery, "resolution">): TelemetrySample[] {
    this.assertOpen();
    const { fromMs, toMs } = normalizedRange(query.from, query.to);
    const { clause, parameters } = slotFilter(query.slotIds);
    const rows = this.database.prepare(`
      SELECT slot_id, observed_at, ingested_at, value, state, provider,
             source_key, label, unit, precision, auxiliary_json
      FROM telemetry_samples
      WHERE observed_at >= ? AND observed_at <= ? ${clause}
      ORDER BY observed_at ASC, slot_id ASC
    `).all(fromMs, toMs, ...parameters) as unknown as SampleRow[];
    return rows.map(mapSampleRow);
  }

  queryHistory(query: TelemetryHistoryQuery): TelemetryHistoryResult {
    this.assertOpen();
    const { fromMs, toMs } = normalizedRange(query.from, query.to);
    const resolution = query.resolution && query.resolution !== "auto"
      ? query.resolution
      : automaticResolution(toMs - fromMs);
    const bucketMs = resolutionMs(resolution);
    const { clause, parameters } = slotFilter(query.slotIds, "s.slot_id");
    let buckets: TelemetryBucket[];

    if (resolution === "raw") {
      buckets = this.querySamples({ from: fromMs, to: toMs, slotIds: query.slotIds }).map((sample) => ({
        slotId: sample.slotId,
        startAt: sample.observedAt,
        endAt: sample.observedAt,
        min: sample.value,
        max: sample.value,
        average: sample.value,
        last: sample.value,
        count: sample.value === null ? 0 : 1,
        state: sample.state,
        provider: sample.provider,
        sourceKey: sample.sourceKey,
        label: sample.label,
        unit: sample.unit,
        precision: sample.precision,
      }));
    } else {
      const rows = this.database.prepare(`
        WITH ranked AS (
          SELECT s.*,
                 CAST(s.observed_at / ? AS INTEGER) AS bucket_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY s.slot_id, CAST(s.observed_at / ? AS INTEGER)
                   ORDER BY s.observed_at DESC, s.id DESC
                 ) AS bucket_rank
          FROM telemetry_samples s
          WHERE s.observed_at >= ? AND s.observed_at <= ? ${clause}
        )
        SELECT slot_id, bucket_id,
               MIN(value) AS minimum,
               MAX(value) AS maximum,
               AVG(value) AS average,
               MAX(CASE WHEN bucket_rank = 1 THEN value END) AS last_value,
               COUNT(value) AS sample_count,
               MAX(CASE WHEN bucket_rank = 1 THEN state END) AS state,
               MAX(CASE WHEN bucket_rank = 1 THEN provider END) AS provider,
               MAX(CASE WHEN bucket_rank = 1 THEN source_key END) AS source_key,
               MAX(CASE WHEN bucket_rank = 1 THEN label END) AS label,
               MAX(CASE WHEN bucket_rank = 1 THEN unit END) AS unit,
               MAX(CASE WHEN bucket_rank = 1 THEN precision END) AS precision
        FROM ranked
        GROUP BY slot_id, bucket_id
        ORDER BY bucket_id ASC, slot_id ASC
      `).all(bucketMs, bucketMs, fromMs, toMs, ...parameters) as unknown as BucketRow[];
      buckets = rows.map((row) => {
        const startAtMs = row.bucket_id * bucketMs;
        return {
          slotId: row.slot_id,
          startAt: new Date(startAtMs).toISOString(),
          endAt: new Date(startAtMs + bucketMs).toISOString(),
          min: finiteNumberOrNull(row.minimum),
          max: finiteNumberOrNull(row.maximum),
          average: finiteNumberOrNull(row.average),
          last: finiteNumberOrNull(row.last_value),
          count: Number(row.sample_count),
          state: row.state,
          provider: row.provider,
          sourceKey: row.source_key,
          label: row.label,
          unit: row.unit,
          precision: Number(row.precision),
        };
      });
    }

    const uniqueObservations = this.countUniqueObservations(fromMs, toMs, query.slotIds);
    return {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      resolution,
      buckets,
      firstRecordedAt: this.firstRecordedAt(),
      expectedIntervalMs: this.expectedIntervalMs,
      uniqueObservations,
      coverage: clamp(
        uniqueObservations / Math.max(1, Math.floor((toMs - fromMs) / this.expectedIntervalMs) + 1),
        0,
        1,
      ),
      provider: normalizeProvider(buckets.at(-1)?.provider),
    };
  }

  inspectAvailability(query: Omit<TelemetryHistoryQuery, "resolution">): TelemetryAvailabilityInspection {
    this.assertOpen();
    const { fromMs, toMs } = normalizedRange(query.from, query.to);
    const { clause, parameters } = slotFilter(query.slotIds);
    const bounds = this.database.prepare(`
      SELECT MIN(observed_at) AS first_observed_at,
             MAX(observed_at) AS last_observed_at
      FROM telemetry_samples
      WHERE 1 = 1 ${clause}
    `).get(...parameters) as { first_observed_at: number | null; last_observed_at: number | null } | undefined;
    const rangeRows = this.database.prepare(`
      SELECT slot_id,
             COUNT(value) AS numeric_sample_count
      FROM telemetry_samples
      WHERE observed_at >= ? AND observed_at <= ? ${clause}
      GROUP BY slot_id
      ORDER BY slot_id ASC
    `).all(fromMs, toMs, ...parameters) as unknown as Array<{
      slot_id: string;
      numeric_sample_count: number;
    }>;
    const latestBySlot: TelemetryAvailabilityInspection["latestBySlot"] = {};
    const requestedSlotIds = [...new Set(query.slotIds ?? rangeRows.map((row) => row.slot_id))];
    for (const slotId of requestedSlotIds) {
      const latest = this.latestSampleRow(slotId);
      if (!latest) continue;
      latestBySlot[slotId] = {
        observedAt: new Date(Number(latest.observed_at)).toISOString(),
        state: latest.state,
      };
    }
    return {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      recordedFrom: bounds?.first_observed_at == null ? null : new Date(Number(bounds.first_observed_at)).toISOString(),
      recordedTo: bounds?.last_observed_at == null ? null : new Date(Number(bounds.last_observed_at)).toISOString(),
      sampleCount: rangeRows.reduce((sum, row) => sum + Number(row.numeric_sample_count), 0),
      uniqueObservations: this.countUniqueObservations(fromMs, toMs, query.slotIds),
      availableSlotIds: rangeRows
        .filter((row) => Number(row.numeric_sample_count) > 0)
        .map((row) => row.slot_id),
      latestBySlot,
    };
  }

  queryEvents(query: TelemetryEventQuery): TelemetryEvent[] {
    this.assertOpen();
    const { fromMs, toMs } = normalizedRange(query.from, query.to);
    const clauses = ["observed_at >= ?", "observed_at <= ?"];
    const parameters: Array<string | number> = [fromMs, toMs];
    appendInFilter(clauses, parameters, "slot_id", query.slotIds, true);
    appendInFilter(clauses, parameters, "event_type", query.types);
    const limit = Math.min(2_000, Math.max(1, Math.trunc(query.limit ?? 500)));
    const rows = this.database.prepare(`
      SELECT id, event_type, slot_id, observed_at, resolved_at, status,
             severity, title, detail, evidence_json
      FROM telemetry_events
      WHERE ${clauses.join(" AND ")}
      ORDER BY observed_at DESC, id DESC
      LIMIT ?
    `).all(...parameters, limit) as unknown as EventRow[];
    return rows.map(mapEventRow);
  }

  queryAlertWorkOrders(filters: AlertListFilters = {}): AlertListResult {
    this.assertOpen();
    this.synchronizeTelemetryEventWorkOrders(Date.now());
    const rows = this.database.prepare(`
      SELECT id, source_key, source_type, source_event_id, telemetry_event_type,
             slot_id, title, detail, severity, source_state, created_at,
             recovered_at, work_status, assignee, started_at, completed_at,
             action, note, version, evidence_json
      FROM alert_work_orders
      ORDER BY
        CASE work_status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
        CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        created_at DESC
    `).all() as unknown as AlertWorkOrderRow[];
    const allItems = rows.map((row) => this.mapAlertWorkOrder(row));
    const fromMs = filters.from ? Date.parse(filters.from) : Number.NEGATIVE_INFINITY;
    const toMs = filters.to ? Date.parse(filters.to) : Number.POSITIVE_INFINITY;
    const statuses = filters.statuses?.length ? new Set(filters.statuses) : null;
    const severities = filters.severities?.length ? new Set(filters.severities) : null;
    const slotIds = filters.slotIds?.length ? new Set(filters.slotIds) : null;
    const limit = Math.min(2_000, Math.max(1, Math.trunc(filters.limit ?? 500)));
    const items = allItems.filter((item) => {
      const createdAt = Date.parse(item.createdAt);
      return (!statuses || statuses.has(item.status))
        && (!severities || severities.has(item.severity))
        && (!slotIds || (item.slotId !== null && slotIds.has(item.slotId)))
        && createdAt >= fromMs
        && createdAt <= toMs;
    }).slice(0, limit);
    return {
      requestId: "",
      generatedAt: new Date().toISOString(),
      summary: {
        pending: allItems.filter((item) => item.status === "pending").length,
        processing: allItems.filter((item) => item.status === "processing").length,
        completed: allItems.filter((item) => item.status === "completed").length,
        critical: allItems.filter((item) => item.severity === "critical" && item.status !== "completed").length,
      },
      items,
    };
  }

  readAlertWorkOrder(id: string) {
    this.assertOpen();
    this.synchronizeTelemetryEventWorkOrders(Date.now());
    const row = this.alertWorkOrderRow(id);
    return row ? this.mapAlertWorkOrder(row) : null;
  }

  beginAlertWorkOrder(id: string, expectedVersion: number, actor: string) {
    this.assertOpen();
    const normalizedActor = normalizedActorName(actor);
    const happenedAt = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.database.prepare(`
        UPDATE alert_work_orders
        SET work_status = 'processing', assignee = ?, started_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND work_status = 'pending'
      `).run(normalizedActor, happenedAt, id, expectedVersion);
      if (Number(update.changes) !== 1) throw new AlertStoreConflictError("告警状态已更新，正在刷新最新内容");
      this.insertAlertTimeline(id, "processing-started", happenedAt, normalizedActor, `${normalizedActor} 开始处理`);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.readAlertWorkOrder(id)!;
  }

  completeAlertWorkOrder(input: Pick<AlertCompleteRequest, "alertId" | "expectedVersion" | "actor" | "action" | "note">) {
    this.assertOpen();
    const normalizedActor = normalizedActorName(input.actor);
    if (!ALERT_ACTIONS.includes(input.action)) throw new Error("处理方式无效");
    const note = input.note.trim();
    if (note.length < 2 || note.length > 500) throw new Error("处理说明需为 2–500 个字符");
    const happenedAt = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.database.prepare(`
        UPDATE alert_work_orders
        SET work_status = 'completed', assignee = COALESCE(assignee, ?),
            completed_at = ?, action = ?, note = ?, version = version + 1
        WHERE id = ? AND version = ? AND work_status = 'processing'
      `).run(normalizedActor, happenedAt, input.action, note, input.alertId, input.expectedVersion);
      if (Number(update.changes) !== 1) throw new AlertStoreConflictError("告警状态已更新，正在刷新最新内容");
      this.insertAlertTimeline(input.alertId, "completed", happenedAt, normalizedActor, `${normalizedActor} 完成处理：${note}`);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.readAlertWorkOrder(input.alertId)!;
  }

  listAlertRules(): AlertRule[] {
    this.assertOpen();
    const rows = this.database.prepare(`
      SELECT slot_id, enabled, lower_limit, upper_limit, version, updated_at
      FROM alert_rules ORDER BY slot_id ASC
    `).all() as unknown as AlertRuleRow[];
    return rows.flatMap((row): AlertRule[] => isTelemetrySlotId(row.slot_id) ? [{
      slotId: row.slot_id,
      enabled: row.enabled === 1,
      lowerLimit: finiteNumberOrNull(row.lower_limit),
      upperLimit: finiteNumberOrNull(row.upper_limit),
      version: Number(row.version),
      updatedAt: row.updated_at === null ? null : new Date(Number(row.updated_at)).toISOString(),
    }] : []);
  }

  saveAlertRules(input: Pick<AlertRulesSaveRequest, "rules" | "actor">) {
    this.assertOpen();
    normalizedActorName(input.actor);
    const happenedAt = Date.now();
    const uniqueSlots = new Set<TelemetrySlotId>();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const rule of input.rules) {
        if (!isTelemetrySlotId(rule.slotId) || uniqueSlots.has(rule.slotId)) throw new Error("告警规则数据无效");
        uniqueSlots.add(rule.slotId);
        const lower = finiteNumberOrNull(rule.lowerLimit);
        const upper = finiteNumberOrNull(rule.upperLimit);
        if (rule.enabled && lower === null && upper === null) throw new Error("启用规则时至少填写一个阈值");
        if (lower !== null && upper !== null && lower >= upper) throw new Error("下限必须小于上限");
        const update = this.database.prepare(`
          UPDATE alert_rules
          SET enabled = ?, lower_limit = ?, upper_limit = ?, updated_at = ?, version = version + 1
          WHERE slot_id = ? AND version = ?
        `).run(rule.enabled ? 1 : 0, lower, upper, happenedAt, rule.slotId, rule.version);
        if (Number(update.changes) !== 1) throw new AlertStoreConflictError(`${rule.slotId} 规则已被其他页面修改`);
        this.resetAlertRuleState(rule.slotId, happenedAt, true);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.listAlertRules();
  }

  clearAlertWorkOrders() {
    this.assertOpen();
    const ignoredBeforeMs = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const deleted = this.database.prepare("DELETE FROM alert_work_orders").run();
      this.database.prepare(`
        INSERT INTO alert_preferences (id, ignored_before)
        VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET ignored_before = excluded.ignored_before
      `).run(ignoredBeforeMs);
      this.database.prepare(`
        UPDATE alert_rule_state
        SET violation_count = 0, normal_count = 0,
            active_work_order_id = NULL, last_observed_at = NULL
      `).run();
      this.database.exec("COMMIT");
      return {
        clearedCount: Number(deleted.changes),
        ignoredBefore: new Date(ignoredBeforeMs).toISOString(),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  analyze(query: Omit<TelemetryHistoryQuery, "resolution">): TelemetryDeterministicAnalysis {
    const samples = this.querySamples(query);
    return computeDeterministicAnalysis(samples, {
      from: query.from,
      to: query.to,
      expectedIntervalMs: this.expectedIntervalMs,
    });
  }

  prune(now: string | number | Date = Date.now()) {
    this.assertOpen();
    const nowMs = timestampMs(now, "now");
    const cutoffMs = nowMs - this.retentionDays * 24 * 60 * 60_000;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const samples = this.database.prepare("DELETE FROM telemetry_samples WHERE observed_at < ?").run(cutoffMs);
      const events = this.database.prepare(
        "DELETE FROM telemetry_events WHERE observed_at < ? AND status = 'resolved'",
      ).run(cutoffMs);
      const alerts = this.database.prepare(
        "DELETE FROM alert_work_orders WHERE created_at < ? AND work_status = 'completed'",
      ).run(cutoffMs);
      this.database.exec("COMMIT");
      return { samples: Number(samples.changes), events: Number(events.changes), alerts: Number(alerts.changes), cutoffAt: new Date(cutoffMs).toISOString() };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  firstRecordedAt() {
    this.assertOpen();
    const row = this.database.prepare("SELECT MIN(observed_at) AS first_observed_at FROM telemetry_samples").get() as
      | { first_observed_at: number | null }
      | undefined;
    return row?.first_observed_at == null ? null : new Date(Number(row.first_observed_at)).toISOString();
  }

  private configureDatabase() {
    this.database.exec("PRAGMA busy_timeout = 5000");
    if (this.path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA foreign_keys = ON");
  }

  private createSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        observed_at_iso TEXT NOT NULL,
        ingested_at INTEGER NOT NULL,
        value REAL,
        state TEXT NOT NULL,
        provider TEXT NOT NULL,
        source_key TEXT,
        label TEXT NOT NULL,
        unit TEXT NOT NULL,
        precision INTEGER NOT NULL,
        auxiliary_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(observed_at, slot_id)
      );
      CREATE INDEX IF NOT EXISTS telemetry_samples_time_idx
        ON telemetry_samples(observed_at);
      CREATE INDEX IF NOT EXISTS telemetry_samples_slot_time_idx
        ON telemetry_samples(slot_id, observed_at);

      CREATE TABLE IF NOT EXISTS telemetry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        slot_id TEXT,
        observed_at INTEGER NOT NULL,
        resolved_at INTEGER,
        status TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS telemetry_events_time_idx
        ON telemetry_events(observed_at DESC);
      CREATE INDEX IF NOT EXISTS telemetry_events_slot_time_idx
        ON telemetry_events(slot_id, observed_at DESC);
      CREATE INDEX IF NOT EXISTS telemetry_events_active_idx
        ON telemetry_events(event_type, slot_id, status);

      CREATE TABLE IF NOT EXISTS alert_work_orders (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL,
        source_event_id TEXT,
        telemetry_event_type TEXT NOT NULL,
        slot_id TEXT,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        severity TEXT NOT NULL,
        source_state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        recovered_at INTEGER,
        work_status TEXT NOT NULL,
        assignee TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        action TEXT,
        note TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        evidence_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS alert_work_orders_status_idx
        ON alert_work_orders(work_status, severity, created_at DESC);
      CREATE INDEX IF NOT EXISTS alert_work_orders_slot_idx
        ON alert_work_orders(slot_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS alert_timeline (
        id TEXT PRIMARY KEY,
        work_order_id TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        happened_at INTEGER NOT NULL,
        actor TEXT,
        detail TEXT NOT NULL,
        FOREIGN KEY(work_order_id) REFERENCES alert_work_orders(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS alert_timeline_work_order_idx
        ON alert_timeline(work_order_id, happened_at ASC);

      CREATE TABLE IF NOT EXISTS alert_rules (
        slot_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        lower_limit REAL,
        upper_limit REAL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS alert_rule_state (
        slot_id TEXT PRIMARY KEY,
        violation_count INTEGER NOT NULL DEFAULT 0,
        normal_count INTEGER NOT NULL DEFAULT 0,
        active_work_order_id TEXT,
        last_observed_at INTEGER,
        FOREIGN KEY(active_work_order_id) REFERENCES alert_work_orders(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS alert_preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ignored_before INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO alert_preferences (id, ignored_before) VALUES (1, 0);

      CREATE TABLE IF NOT EXISTS collector_preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        poll_interval_ms INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL
      );
    `);
    const insertRule = this.database.prepare(`
      INSERT OR IGNORE INTO alert_rules (slot_id, enabled, lower_limit, upper_limit, version, updated_at)
      VALUES (?, 0, NULL, NULL, 1, NULL)
    `);
    for (const slotId of TELEMETRY_SLOT_IDS) insertRule.run(slotId);
  }

  private assertOpen() {
    if (this.closed) throw new Error("TelemetryStore is closed");
  }

  private latestSampleRow(slotId: string) {
    return this.database.prepare(`
      SELECT slot_id, observed_at, ingested_at, value, state, provider,
             source_key, label, unit, precision, auxiliary_json
      FROM telemetry_samples
      WHERE slot_id = ?
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `).get(slotId) as unknown as SampleRow | undefined;
  }

  private sampleRow(slotId: string, observedAtMs: number) {
    return this.database.prepare(`
      SELECT slot_id, observed_at, ingested_at, value, state, provider,
             source_key, label, unit, precision, auxiliary_json
      FROM telemetry_samples
      WHERE slot_id = ? AND observed_at = ?
      LIMIT 1
    `).get(slotId, observedAtMs) as unknown as SampleRow | undefined;
  }

  private countUniqueObservations(fromMs: number, toMs: number, slotIds?: readonly string[]) {
    const { clause, parameters } = slotFilter(slotIds);
    const row = this.database.prepare(`
      SELECT COUNT(DISTINCT observed_at) AS observation_count
      FROM telemetry_samples
      WHERE observed_at >= ? AND observed_at <= ? ${clause}
    `).get(fromMs, toMs, ...parameters) as { observation_count: number } | undefined;
    return Number(row?.observation_count ?? 0);
  }

  private alertWorkOrderRow(id: string) {
    return this.database.prepare(`
      SELECT id, source_key, source_type, source_event_id, telemetry_event_type,
             slot_id, title, detail, severity, source_state, created_at,
             recovered_at, work_status, assignee, started_at, completed_at,
             action, note, version, evidence_json
      FROM alert_work_orders WHERE id = ? LIMIT 1
    `).get(id) as unknown as AlertWorkOrderRow | undefined;
  }

  private mapAlertWorkOrder(row: AlertWorkOrderRow): AlertWorkOrder {
    const timelineRows = this.database.prepare(`
      SELECT id, entry_type, happened_at, actor, detail
      FROM alert_timeline WHERE work_order_id = ?
      ORDER BY happened_at ASC, rowid ASC
    `).all(row.id) as unknown as AlertTimelineRow[];
    return {
      id: row.id,
      sourceType: row.source_type,
      sourceEventId: row.source_event_id,
      telemetryEventType: row.telemetry_event_type,
      slotId: row.slot_id !== null && isTelemetrySlotId(row.slot_id) ? row.slot_id : null,
      title: row.title,
      detail: row.detail,
      severity: ALERT_SEVERITIES.includes(row.severity) ? row.severity : "warning",
      sourceState: row.source_state,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      recoveredAt: row.recovered_at === null ? null : new Date(Number(row.recovered_at)).toISOString(),
      status: ALERT_WORK_ORDER_STATUSES.includes(row.work_status) ? row.work_status : "pending",
      assignee: row.assignee,
      startedAt: row.started_at === null ? null : new Date(Number(row.started_at)).toISOString(),
      completedAt: row.completed_at === null ? null : new Date(Number(row.completed_at)).toISOString(),
      action: row.action && ALERT_ACTIONS.includes(row.action) ? row.action : null,
      note: row.note,
      version: Number(row.version),
      evidence: primitiveEvidence(parseJsonRecord(row.evidence_json)),
      timeline: timelineRows.map((entry) => ({
        id: entry.id,
        type: entry.entry_type,
        timestamp: new Date(Number(entry.happened_at)).toISOString(),
        actor: entry.actor,
        detail: entry.detail,
      })),
    };
  }

  private synchronizeTelemetryEventWorkOrders(nowMs: number) {
    const preference = this.database.prepare(
      "SELECT ignored_before FROM alert_preferences WHERE id = 1 LIMIT 1",
    ).get() as { ignored_before: number } | undefined;
    const ignoredBefore = Number(preference?.ignored_before ?? 0);
    const rows = this.database.prepare(`
      SELECT id, event_type, slot_id, observed_at, resolved_at, status,
             severity, title, detail, evidence_json
      FROM telemetry_events
      WHERE event_type <> 'recovery' AND severity <> 'info' AND observed_at > ?
      ORDER BY id ASC
    `).all(ignoredBefore) as unknown as EventRow[];
    for (const row of rows) {
      const event = mapEventRow(row);
      const sourceKey = `event:${event.id}`;
      let workOrder = this.database.prepare(`
        SELECT id, source_state, recovered_at FROM alert_work_orders WHERE source_key = ? LIMIT 1
      `).get(sourceKey) as { id: string; source_state: "active" | "resolved"; recovered_at: number | null } | undefined;
      if (!workOrder) {
        const workOrderId = randomUUID();
        this.database.prepare(`
          INSERT INTO alert_work_orders (
            id, source_key, source_type, source_event_id, telemetry_event_type,
            slot_id, title, detail, severity, source_state, created_at,
            recovered_at, work_status, version, evidence_json
          ) VALUES (?, ?, 'telemetry-event', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?)
        `).run(
          workOrderId,
          sourceKey,
          String(event.id),
          publicEventType(event),
          event.slotId,
          event.title,
          event.detail,
          event.severity === "error" ? "critical" : event.severity,
          event.status === "resolved" ? "resolved" : "active",
          Date.parse(event.observedAt),
          event.resolvedAt ? Date.parse(event.resolvedAt) : null,
          JSON.stringify(event.evidence),
        );
        this.insertAlertTimeline(workOrderId, "created", Date.parse(event.observedAt), null, "系统创建告警");
        if (event.status === "resolved") {
          this.insertAlertTimeline(workOrderId, "source-recovered", event.resolvedAt ? Date.parse(event.resolvedAt) : nowMs, null, "数据源已恢复，等待人工确认");
        }
        workOrder = { id: workOrderId, source_state: event.status === "resolved" ? "resolved" : "active", recovered_at: event.resolvedAt ? Date.parse(event.resolvedAt) : null };
      }
      if (event.status === "resolved" && workOrder.source_state !== "resolved") {
        const recoveredAt = event.resolvedAt ? Date.parse(event.resolvedAt) : nowMs;
        this.database.prepare(`
          UPDATE alert_work_orders
          SET source_state = 'resolved', recovered_at = ?, version = version + 1
          WHERE id = ? AND source_state = 'active'
        `).run(recoveredAt, workOrder.id);
        this.insertAlertTimeline(workOrder.id, "source-recovered", recoveredAt, null, "数据源已恢复，等待人工确认");
      }
    }
  }

  private insertAlertTimeline(
    workOrderId: string,
    type: AlertTimelineEntry["type"],
    happenedAt: number,
    actor: string | null,
    detail: string,
  ) {
    this.database.prepare(`
      INSERT INTO alert_timeline (id, work_order_id, entry_type, happened_at, actor, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), workOrderId, type, happenedAt, actor, detail);
  }

  private evaluateThresholdRule(slot: CollectableSlot, observedAtMs: number) {
    const rule = this.database.prepare(`
      SELECT slot_id, enabled, lower_limit, upper_limit, version, updated_at
      FROM alert_rules WHERE slot_id = ? LIMIT 1
    `).get(slot.slotId) as unknown as AlertRuleRow | undefined;
    if (!rule || rule.enabled !== 1 || slot.value === null || !Number.isFinite(slot.value)) return 0;
    const value = Number(slot.value);
    const outside = (rule.lower_limit !== null && value < Number(rule.lower_limit))
      || (rule.upper_limit !== null && value > Number(rule.upper_limit));
    const previous = this.database.prepare(`
      SELECT slot_id, violation_count, normal_count, active_work_order_id, last_observed_at
      FROM alert_rule_state WHERE slot_id = ? LIMIT 1
    `).get(slot.slotId) as unknown as AlertRuleStateRow | undefined;
    let violationCount = outside ? Number(previous?.violation_count ?? 0) + 1 : 0;
    let normalCount = outside ? 0 : Number(previous?.normal_count ?? 0) + 1;
    let activeWorkOrderId = previous?.active_work_order_id ?? null;
    let created = 0;

    if (outside && violationCount >= 2 && !activeWorkOrderId) {
      activeWorkOrderId = randomUUID();
      const limits = thresholdLimitsText(rule.lower_limit, rule.upper_limit, slot.unit);
      this.database.prepare(`
        INSERT INTO alert_work_orders (
          id, source_key, source_type, source_event_id, telemetry_event_type,
          slot_id, title, detail, severity, source_state, created_at,
          recovered_at, work_status, version, evidence_json
        ) VALUES (?, ?, 'threshold', NULL, 'threshold', ?, ?, ?, 'warning', 'active', ?, NULL, 'pending', 1, ?)
      `).run(
        activeWorkOrderId,
        `threshold:${slot.slotId}:${observedAtMs}`,
        slot.slotId,
        `${slot.label} 超出设定范围`,
        `连续两次上报超出设定范围（${limits}）。`,
        observedAtMs,
        JSON.stringify({ value, unit: slot.unit, lowerLimit: rule.lower_limit, upperLimit: rule.upper_limit }),
      );
      this.insertAlertTimeline(activeWorkOrderId, "created", observedAtMs, null, "连续两次越界，系统创建告警");
      violationCount = 2;
      created = 1;
    }

    if (!outside && normalCount >= 2 && activeWorkOrderId) {
      const recovered = this.database.prepare(`
        UPDATE alert_work_orders
        SET source_state = 'resolved', recovered_at = ?, version = version + 1
        WHERE id = ? AND source_state = 'active'
      `).run(observedAtMs, activeWorkOrderId);
      if (Number(recovered.changes) === 1) {
        this.insertAlertTimeline(activeWorkOrderId, "source-recovered", observedAtMs, null, "连续两次读数恢复至设定范围，等待人工确认");
      }
      activeWorkOrderId = null;
      normalCount = 2;
    }

    this.database.prepare(`
      INSERT INTO alert_rule_state (slot_id, violation_count, normal_count, active_work_order_id, last_observed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slot_id) DO UPDATE SET
        violation_count = excluded.violation_count,
        normal_count = excluded.normal_count,
        active_work_order_id = excluded.active_work_order_id,
        last_observed_at = excluded.last_observed_at
    `).run(slot.slotId, violationCount, normalCount, activeWorkOrderId, observedAtMs);
    return created;
  }

  private resetAlertRuleState(slotId: TelemetrySlotId, happenedAt: number, resolveActive: boolean) {
    const state = this.database.prepare(`
      SELECT slot_id, violation_count, normal_count, active_work_order_id, last_observed_at
      FROM alert_rule_state WHERE slot_id = ? LIMIT 1
    `).get(slotId) as unknown as AlertRuleStateRow | undefined;
    if (resolveActive && state?.active_work_order_id) {
      const update = this.database.prepare(`
        UPDATE alert_work_orders
        SET source_state = 'resolved', recovered_at = ?, version = version + 1
        WHERE id = ? AND source_state = 'active'
      `).run(happenedAt, state.active_work_order_id);
      if (Number(update.changes) === 1) {
        this.insertAlertTimeline(state.active_work_order_id, "source-recovered", happenedAt, null, "规则已修改或关闭，源告警已结束");
      }
    }
    this.database.prepare(`
      INSERT INTO alert_rule_state (slot_id, violation_count, normal_count, active_work_order_id, last_observed_at)
      VALUES (?, 0, 0, NULL, NULL)
      ON CONFLICT(slot_id) DO UPDATE SET
        violation_count = 0, normal_count = 0,
        active_work_order_id = NULL, last_observed_at = NULL
    `).run(slotId);
  }

  private detectEvents(slot: CollectableSlot, provider: string, observedAtMs: number, previous?: SampleRow) {
    let eventCount = 0;
    if (previous) {
      const gapMs = observedAtMs - previous.observed_at;
      if (gapMs > Math.max(30_000, this.expectedIntervalMs * 3)) {
        this.insertPointEvent({
          type: "gap",
          slotId: slot.slotId,
          observedAtMs,
          severity: "warning",
          title: `${slot.label} 出现采样缺口`,
          detail: `相邻两次独立上报间隔为 ${Math.round(gapMs / 1_000)} 秒。`,
          evidence: { previousObservedAt: new Date(previous.observed_at).toISOString(), gapMs, provider },
        });
        eventCount += 1;
      }

      if (previous.state !== slot.state) {
        eventCount += this.recordStateTransition(slot, provider, observedAtMs, previous.state);
      }
    }

    if (slot.value !== null && Number.isFinite(slot.value)) {
      const recentRows = this.database.prepare(`
        SELECT value, observed_at
        FROM telemetry_samples
        WHERE slot_id = ? AND value IS NOT NULL
        ORDER BY observed_at DESC, id DESC
        LIMIT ?
      `).all(slot.slotId, Math.max(FLATLINE_SAMPLE_COUNT, MIN_ANOMALY_BASELINE + 1)) as unknown as Array<{
        value: number;
        observed_at: number;
      }>;
      const chronological = recentRows.slice().reverse();
      const flatlineValues = chronological.slice(-FLATLINE_SAMPLE_COUNT).map((row) => Number(row.value));
      const isFlatline = flatlineValues.length >= FLATLINE_SAMPLE_COUNT && numericRange(flatlineValues) <= flatlineTolerance(slot.precision);
      if (isFlatline) {
        eventCount += this.ensureActiveEvent({
          type: "flatline",
          slotId: slot.slotId,
          observedAtMs: chronological.at(-FLATLINE_SAMPLE_COUNT)!.observed_at,
          severity: "warning",
          title: `${slot.label} 连续保持不变`,
          detail: `最近 ${FLATLINE_SAMPLE_COUNT} 次上报值未出现可辨识变化，建议确认传感器状态。`,
          evidence: { count: FLATLINE_SAMPLE_COUNT, value: slot.value, tolerance: flatlineTolerance(slot.precision) },
        });
      } else if (this.resolveActiveEvent("flatline", slot.slotId, observedAtMs)) {
        this.insertPointEvent({
          type: "recovery",
          slotId: slot.slotId,
          observedAtMs,
          severity: "info",
          title: `${slot.label} 数据变化已恢复`,
          detail: "传感器读数已脱离连续平线状态。",
          evidence: { recoveredEventType: "flatline" },
        });
        eventCount += 1;
      }

      if (chronological.length >= MIN_ANOMALY_BASELINE + 1) {
        const baseline = chronological.slice(-(MIN_ANOMALY_BASELINE + 1), -1).map((row) => Number(row.value));
        const anomaly = robustAnomaly(Number(slot.value), baseline);
        if (anomaly) {
          this.insertPointEvent({
            type: "anomaly",
            slotId: slot.slotId,
            observedAtMs,
            severity: "warning",
            title: `${slot.label} 偏离近期基线`,
            detail: "当前读数与此前至少 20 个有效样本形成的稳健基线存在明显偏离。",
            evidence: { value: slot.value, ...anomaly },
          });
          eventCount += 1;
        }
      }
    }
    return eventCount;
  }

  private recordStateTransition(
    slot: CollectableSlot,
    provider: string,
    detectedAtMs: number,
    previousState: string,
  ) {
    this.insertPointEvent({
      type: "state-change",
      slotId: slot.slotId,
      observedAtMs: detectedAtMs,
      severity: stateSeverity(slot.state),
      title: `${slot.label} 数据状态变化`,
      detail: `${previousState} → ${slot.state}`,
      evidence: { from: previousState, to: slot.state, provider },
    });
    let count = 1;
    if (slot.state === "live" && previousState !== "live") {
      this.insertPointEvent({
        type: "recovery",
        slotId: slot.slotId,
        observedAtMs: detectedAtMs,
        severity: "info",
        title: `${slot.label} 数据已恢复`,
        detail: `数据状态已从 ${previousState} 恢复为 live。`,
        evidence: { from: previousState, to: slot.state, provider },
      });
      this.resolveActiveEvent("gap", slot.slotId, detectedAtMs);
      count += 1;
    }
    return count;
  }

  private insertPointEvent(input: ActiveEventInput) {
    this.database.prepare(`
      INSERT INTO telemetry_events (
        event_type, slot_id, observed_at, resolved_at, status,
        severity, title, detail, evidence_json
      ) VALUES (?, ?, ?, ?, 'resolved', ?, ?, ?, ?)
    `).run(
      input.type,
      input.slotId,
      input.observedAtMs,
      input.observedAtMs,
      input.severity,
      input.title,
      input.detail,
      JSON.stringify(input.evidence),
    );
  }

  private ensureActiveEvent(input: ActiveEventInput) {
    const existing = this.database.prepare(`
      SELECT id FROM telemetry_events
      WHERE event_type = ?
        AND ((slot_id = ?) OR (slot_id IS NULL AND ? IS NULL))
        AND status = 'active'
      LIMIT 1
    `).get(input.type, input.slotId, input.slotId) as { id: number } | undefined;
    if (existing) return 0;
    this.database.prepare(`
      INSERT INTO telemetry_events (
        event_type, slot_id, observed_at, resolved_at, status,
        severity, title, detail, evidence_json
      ) VALUES (?, ?, ?, NULL, 'active', ?, ?, ?, ?)
    `).run(
      input.type,
      input.slotId,
      input.observedAtMs,
      input.severity,
      input.title,
      input.detail,
      JSON.stringify(input.evidence),
    );
    return 1;
  }

  private resolveActiveEvent(type: TelemetryEventType, slotId: string | null, resolvedAtMs: number) {
    const result = this.database.prepare(`
      UPDATE telemetry_events
      SET status = 'resolved', resolved_at = ?
      WHERE event_type = ?
        AND ((slot_id = ?) OR (slot_id IS NULL AND ? IS NULL))
        AND status = 'active'
    `).run(resolvedAtMs, type, slotId, slotId);
    return Number(result.changes);
  }
}

interface ActiveEventInput {
  type: TelemetryEventType;
  slotId: string | null;
  observedAtMs: number;
  severity: TelemetryEventSeverity;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
}

export interface TelemetryCollectorOptions {
  store?: TelemetryStore;
  provider?: Pick<IoTProvider, "kind" | "readTelemetrySlots">;
  intervalMs?: number;
  requestTimeoutMs?: number;
  failureBackoffMaxMs?: number;
  retentionIntervalMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface TelemetryCollectorStatus {
  running: boolean;
  collecting: boolean;
  pollIntervalMs: number;
  consecutiveFailures: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
}

export function createTelemetryCollector(options: TelemetryCollectorOptions = {}) {
  const store = options.store ?? new TelemetryStore();
  const provider = options.provider ?? getIoTProvider();
  let pollIntervalMs = positiveInteger(options.intervalMs ?? resolveTelemetryPollIntervalMs(), DEFAULT_TELEMETRY_POLL_INTERVAL_MS);
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs ?? process.env.TELEMETRY_REQUEST_TIMEOUT_MS,
    DEFAULT_TELEMETRY_REQUEST_TIMEOUT_MS,
  );
  const failureBackoffMaxMs = positiveInteger(options.failureBackoffMaxMs, DEFAULT_FAILURE_BACKOFF_MAX_MS);
  const retentionIntervalMs = positiveInteger(options.retentionIntervalMs, 60 * 60_000);
  const now = options.now ?? Date.now;
  let running = false;
  let collecting = false;
  let consecutiveFailures = 0;
  let timer: NodeJS.Timeout | null = null;
  let lastAttemptAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let nextAttemptAt: number | null = null;
  let lastPrunedAt = 0;
  let inFlight: Promise<void> | null = null;

  const schedule = (delayMs: number) => {
    if (!running) return;
    nextAttemptAt = now() + delayMs;
    timer = setTimeout(() => {
      inFlight = collectAndSchedule();
    }, delayMs);
    timer.unref?.();
  };

  const collectOnce = async () => {
    if (collecting) return;
    collecting = true;
    lastAttemptAt = now();
    try {
      const slots = await provider.readTelemetrySlots({
        traceId: randomUUID(),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      store.recordSlots(slots as Readonly<Record<string, CollectableSlot>>, provider.kind, lastAttemptAt);
      store.recordCollectionRecovery(lastAttemptAt);
      if (lastAttemptAt - lastPrunedAt >= retentionIntervalMs) {
        store.prune(lastAttemptAt);
        lastPrunedAt = lastAttemptAt;
      }
      consecutiveFailures = 0;
      lastSuccessAt = lastAttemptAt;
    } catch (error) {
      consecutiveFailures += 1;
      store.recordCollectionFailure(error, lastAttemptAt);
      options.onError?.(error);
      throw error;
    } finally {
      collecting = false;
    }
  };

  const collectAndSchedule = async () => {
    try {
      await collectOnce();
    } catch {
      // The failure is persisted and exposed through status; the loop continues.
    } finally {
      if (running) {
        const delay = consecutiveFailures === 0
          ? pollIntervalMs
          : Math.min(failureBackoffMaxMs, pollIntervalMs * 2 ** Math.min(consecutiveFailures - 1, 8));
        schedule(delay);
      }
    }
  };

  return {
    store,
    async start() {
      if (running) return;
      running = true;
      nextAttemptAt = null;
      inFlight = collectAndSchedule();
      await inFlight;
    },
    async collectOnce() {
      await collectOnce();
    },
    setPollIntervalMs(value: TelemetryPollIntervalMs) {
      pollIntervalMs = parseTelemetryPollIntervalMs(value);
      if (running && !collecting) {
        if (timer) clearTimeout(timer);
        timer = null;
        const delay = consecutiveFailures === 0
          ? pollIntervalMs
          : Math.min(failureBackoffMaxMs, pollIntervalMs * 2 ** Math.min(consecutiveFailures - 1, 8));
        schedule(delay);
      }
      return pollIntervalMs;
    },
    async stop() {
      running = false;
      nextAttemptAt = null;
      if (timer) clearTimeout(timer);
      timer = null;
      await inFlight?.catch(() => undefined);
      inFlight = null;
    },
    status(): TelemetryCollectorStatus {
      return {
        running,
        collecting,
        pollIntervalMs,
        consecutiveFailures,
        lastAttemptAt: lastAttemptAt === null ? null : new Date(lastAttemptAt).toISOString(),
        lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
        nextAttemptAt: nextAttemptAt === null ? null : new Date(nextAttemptAt).toISOString(),
      };
    },
  };
}

export function parseTelemetryPollIntervalMs(value: unknown): TelemetryPollIntervalMs {
  const parsed = Number(value);
  if (!(TELEMETRY_POLL_INTERVALS as readonly number[]).includes(parsed)) {
    throw new RangeError("华为云后台读取间隔仅支持 1、3.5、5 或 10 秒");
  }
  return parsed as TelemetryPollIntervalMs;
}

export function resolveTelemetryPollIntervalMs(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TelemetryPollIntervalMs {
  const configured = environment.TELEMETRY_POLL_INTERVAL_MS?.trim();
  if (configured) return parseTelemetryPollIntervalMs(configured);
  const legacy = environment.TELEMETRY_SAMPLE_INTERVAL_MS?.trim();
  if (legacy && (TELEMETRY_POLL_INTERVALS as readonly number[]).includes(Number(legacy))) {
    return Number(legacy) as TelemetryPollIntervalMs;
  }
  return DEFAULT_TELEMETRY_POLL_INTERVAL_MS;
}

export function computeDeterministicAnalysis(
  inputSamples: readonly TelemetrySample[],
  options: DeterministicAnalysisOptions = {},
): TelemetryDeterministicAnalysis {
  const samples = deduplicateSamples(inputSamples);
  const inferredFrom = samples[0]?.observedAt ?? new Date(0).toISOString();
  const inferredTo = samples.at(-1)?.observedAt ?? inferredFrom;
  const fromMs = timestampMs(options.from ?? inferredFrom, "from");
  const toMs = timestampMs(options.to ?? inferredTo, "to");
  if (toMs < fromMs) throw new RangeError("to must be at or after from");
  const expectedIntervalMs = positiveInteger(options.expectedIntervalMs, DEFAULT_SAMPLE_INTERVAL_MS);
  const minimumCorrelationPairs = positiveInteger(options.minimumCorrelationPairs, MIN_CORRELATION_PAIRS);
  const minimumAnomalyBaseline = positiveInteger(options.minimumAnomalyBaseline, MIN_ANOMALY_BASELINE);
  const bySlot = groupBy(samples, (sample) => sample.slotId);
  const summaries: TelemetrySeriesSummary[] = [];
  const anomalies: TelemetryAnomaly[] = [];
  const facts: TelemetryFact[] = [];

  for (const [slotId, series] of bySlot) {
    const ordered = series.slice().sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    const valid = ordered.filter((sample): sample is TelemetrySample & { value: number } => (
      typeof sample.value === "number" && Number.isFinite(sample.value)
    ));
    const values = valid.map((sample) => sample.value);
    const intervals = valid.slice(1).map((sample, index) => Date.parse(sample.observedAt) - Date.parse(valid[index].observedAt)).filter((value) => value > 0);
    const expectedCount = Math.max(1, Math.floor((toMs - fromMs) / expectedIntervalMs) + 1);
    const seriesAnomalies: TelemetryAnomaly[] = [];
    for (let index = minimumAnomalyBaseline; index < valid.length; index += 1) {
      const baseline = valid.slice(index - minimumAnomalyBaseline, index).map((sample) => sample.value);
      const detected = robustAnomaly(valid[index].value, baseline);
      if (detected) {
        seriesAnomalies.push({
          slotId,
          observedAt: valid[index].observedAt,
          value: valid[index].value,
          baselineMedian: detected.median,
          method: detected.method,
        });
      }
    }
    anomalies.push(...seriesAnomalies);
    const summary: TelemetrySeriesSummary = {
      slotId,
      label: ordered.at(-1)?.label ?? slotId,
      unit: ordered.at(-1)?.unit ?? "",
      count: valid.length,
      missingCount: ordered.length - valid.length,
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
      coverage: clamp(valid.length / expectedCount, 0, 1),
      medianSampleIntervalMs: median(intervals),
      anomalyCount: seriesAnomalies.length,
      latestObservedAt: valid.at(-1)?.observedAt ?? null,
    };
    summaries.push(summary);
    facts.push(...factsForSummary(summary));
  }

  const correlations: TelemetryCorrelation[] = [];
  const slotIds = [...bySlot.keys()].sort();
  for (let leftIndex = 0; leftIndex < slotIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < slotIds.length; rightIndex += 1) {
      const leftId = slotIds[leftIndex];
      const rightId = slotIds[rightIndex];
      const correlation = correlateSeries(bySlot.get(leftId)!, bySlot.get(rightId)!, minimumCorrelationPairs);
      if (!correlation) continue;
      const result = { leftSlotId: leftId, rightSlotId: rightId, ...correlation };
      correlations.push(result);
      facts.push({
        factId: `correlation:${leftId}:${rightId}`,
        kind: "correlation",
        slotIds: [leftId, rightId],
        label: "同步相关性",
        text: `${leftId} 与 ${rightId} 的同步相关系数为 ${result.coefficient.toFixed(3)}（${result.pairCount} 对样本）。`,
        value: result.coefficient,
        evidence: { coefficient: result.coefficient, pairCount: result.pairCount },
      });
    }
  }

  for (const [slotId, count] of countBy(anomalies, (anomaly) => anomaly.slotId)) {
    facts.push({
      factId: `anomaly:${slotId}`,
      kind: "anomaly",
      slotIds: [slotId],
      label: "近期基线异常",
      text: `${slotId} 检出 ${count} 个基于历史窗口的稳健异常点。`,
      value: count,
      evidence: { count, minimumBaseline: minimumAnomalyBaseline },
    });
  }

  const reportCount = new Set(samples.map((sample) => sample.observedAt)).size;
  const expectedReports = Math.max(1, Math.floor((toMs - fromMs) / expectedIntervalMs) + 1);
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    reportCount,
    coverage: clamp(reportCount / expectedReports, 0, 1),
    summaries: summaries.sort((left, right) => left.slotId.localeCompare(right.slotId)),
    correlations,
    anomalies,
    facts,
  };
}

/**
 * Converts the storage-oriented bucket stream to the cross-screen protocol.
 * Keeping this adapter here prevents the gateway from duplicating aggregation
 * semantics or silently turning missing numeric buckets into zeroes.
 */
export function toTelemetryHistoryResult(
  requestId: string,
  query: Pick<PublicTelemetryHistoryRequest, "from" | "to" | "slotIds">,
  storeResult: TelemetryHistoryResult,
): PublicTelemetryHistoryResult {
  const requestedSlots = new Set<string>(query.slotIds);
  const grouped = groupBy(
    storeResult.buckets.filter((bucket) => requestedSlots.size === 0 || requestedSlots.has(bucket.slotId)),
    (bucket) => bucket.slotId,
  );
  const series: PublicTelemetryHistorySeries[] = [];

  for (const [slotId, allBuckets] of grouped) {
    if (!isTelemetrySlotId(slotId)) continue;
    const buckets = allBuckets
      .filter((bucket): bucket is TelemetryBucket & {
        min: number;
        max: number;
        average: number;
        last: number;
      } => (
        bucket.count > 0
        && bucket.min !== null
        && bucket.max !== null
        && bucket.average !== null
        && bucket.last !== null
      ))
      .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
    if (!buckets.length) continue;
    const sampleCount = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    const average = sampleCount
      ? buckets.reduce((sum, bucket) => sum + bucket.average * bucket.count, 0) / sampleCount
      : null;
    const lastBucket = buckets.at(-1)!;
    const firstBucket = buckets[0];
    const bucketValues = buckets.map((bucket) => bucket.average);
    series.push({
      slotId,
      sourceKey: lastBucket.sourceKey,
      label: lastBucket.label,
      unit: lastBucket.unit,
      precision: lastBucket.precision,
      buckets: buckets.map((bucket) => ({
        startAt: bucket.startAt,
        endAt: bucket.endAt,
        minimum: bucket.min,
        maximum: bucket.max,
        average: bucket.average,
        last: bucket.last,
        count: bucket.count,
      })),
      summary: {
        minimum: Math.min(...buckets.map((bucket) => bucket.min)),
        maximum: Math.max(...buckets.map((bucket) => bucket.max)),
        average,
        median: median(bucketValues),
        delta: lastBucket.last - firstBucket.last,
        slopePerHour: slopeForBuckets(buckets),
        volatility: standardDeviation(bucketValues),
        sampleCount,
        completeness: storeResult.coverage,
        latestObservedAt: lastBucket.startAt,
      },
    });
  }

  return {
    requestId,
    from: storeResult.from,
    to: storeResult.to,
    capturedFrom: storeResult.firstRecordedAt,
    generatedAt: new Date().toISOString(),
    dataVersion: historyDataVersion(storeResult),
    provider: storeResult.provider,
    resolution: storeResult.resolution,
    expectedIntervalMs: storeResult.expectedIntervalMs,
    uniqueObservations: storeResult.uniqueObservations,
    coverage: storeResult.coverage,
    series: series.sort((left, right) => left.slotId.localeCompare(right.slotId)),
  };
}

export function toTelemetryEventsResult(
  requestId: string,
  query: Pick<TelemetryEventQuery, "from" | "to">,
  events: readonly TelemetryEvent[],
): PublicTelemetryEventsResult {
  const { fromMs, toMs } = normalizedRange(query.from, query.to);
  return {
    requestId,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    generatedAt: new Date().toISOString(),
    events: events.flatMap((event): PublicTelemetryEvent[] => {
      if (event.slotId !== null && !isTelemetrySlotId(event.slotId)) return [];
      return [{
        id: String(event.id),
        slotId: event.slotId,
        type: publicEventType(event),
        severity: event.severity === "error" ? "critical" : event.severity,
        status: event.status,
        title: event.title,
        detail: event.detail,
        startedAt: event.observedAt,
        endedAt: event.resolvedAt,
        evidence: primitiveEvidence(event.evidence),
      }];
    }),
  };
}

export function toTelemetryAnalysisResult(
  requestId: string,
  deterministic: TelemetryDeterministicAnalysis,
  provider: DashboardSnapshot["provider"],
): PublicTelemetryAnalysisResult {
  const publicFacts = deterministic.facts.flatMap((fact): PublicTelemetryFact[] => {
    const slotIds = fact.slotIds.filter(isTelemetrySlotId);
    if (!slotIds.length) return [];
    return [{
      id: fact.factId,
      kind: publicFactKind(fact.kind),
      slotIds,
      statement: fact.text,
      values: primitiveEvidence(fact.evidence, true),
      unit: fact.unit ?? null,
      windowStart: deterministic.from,
      windowEnd: deterministic.to,
    }];
  });
  const quality = deterministic.coverage >= 0.9 && deterministic.reportCount >= MIN_ANOMALY_BASELINE
    ? "high"
    : deterministic.coverage >= 0.6 && deterministic.reportCount >= MIN_CORRELATION_PAIRS
      ? "medium"
      : "low";
  const status = deterministic.reportCount >= MIN_CORRELATION_PAIRS ? "complete" : "insufficient-data";
  const anomalyFacts = publicFacts.filter((fact) => fact.kind === "variability").slice(0, 3);

  return {
    requestId,
    status,
    generatedAt: new Date().toISOString(),
    dataVersion: analysisDataVersion(deterministic),
    basis: {
      provider,
      isDemo: provider === "mock",
      windowStart: deterministic.from,
      windowEnd: deterministic.to,
      sampleCount: deterministic.summaries.reduce((sum, summary) => sum + summary.count, 0),
      uniqueObservations: deterministic.reportCount,
      coverage: deterministic.coverage,
      quality,
    },
    headline: status === "complete"
      ? `已完成 ${deterministic.reportCount} 次独立上报的本地统计。`
      : `当前只有 ${deterministic.reportCount} 次独立上报，暂不足以形成稳定分析。`,
    facts: publicFacts,
    findings: anomalyFacts.map((fact, index) => ({
      id: `local-finding-${index + 1}`,
      title: "近期基线出现偏离",
      summary: fact.statement,
      factIds: [fact.id],
      severity: "attention" as const,
    })),
    recommendations: [],
    caveats: [
      "本地统计只描述数据变化，不代表健康、法规或因果结论。",
      "相关性仅表示同步变化，不代表因果关系。",
    ],
  };
}

function factsForSummary(summary: TelemetrySeriesSummary): TelemetryFact[] {
  const facts: TelemetryFact[] = [{
    factId: `range:${summary.slotId}`,
    kind: "range",
    slotIds: [summary.slotId],
    label: `${summary.label}范围`,
    text: summary.count
      ? `${summary.label}共 ${summary.count} 个有效点，范围 ${formatFactValue(summary.minimum, summary.unit)} 至 ${formatFactValue(summary.maximum, summary.unit)}。`
      : `${summary.label}没有有效数值。`,
    evidence: {
      count: summary.count,
      minimum: summary.minimum,
      maximum: summary.maximum,
      average: summary.average,
      median: summary.median,
    },
  }, {
    factId: `quality:${summary.slotId}`,
    kind: "quality",
    slotIds: [summary.slotId],
    label: `${summary.label}数据质量`,
    text: `${summary.label}数据覆盖率为 ${(summary.coverage * 100).toFixed(1)}%。`,
    value: summary.coverage,
    unit: "%",
    evidence: { count: summary.count, missingCount: summary.missingCount, coverage: summary.coverage },
  }];
  if (summary.change !== null) {
    facts.push({
      factId: `trend:${summary.slotId}`,
      kind: "trend",
      slotIds: [summary.slotId],
      label: `${summary.label}变化`,
      text: `${summary.label}首末变化为 ${formatSigned(summary.change)}${summary.unit}。`,
      value: summary.change,
      unit: summary.unit,
      evidence: { first: summary.first, latest: summary.latest, change: summary.change, slopePerHour: summary.slopePerHour },
    });
  }
  return facts;
}

function mapSampleRow(row: SampleRow): TelemetrySample {
  return {
    slotId: row.slot_id,
    observedAt: new Date(Number(row.observed_at)).toISOString(),
    ingestedAt: new Date(Number(row.ingested_at)).toISOString(),
    value: finiteNumberOrNull(row.value),
    state: row.state,
    provider: row.provider,
    sourceKey: row.source_key,
    label: row.label,
    unit: row.unit,
    precision: Number(row.precision),
    auxiliaryReadings: parseAuxiliaryJson(row.auxiliary_json),
  };
}

function mapEventRow(row: EventRow): TelemetryEvent {
  return {
    id: Number(row.id),
    type: row.event_type,
    slotId: row.slot_id,
    observedAt: new Date(Number(row.observed_at)).toISOString(),
    resolvedAt: row.resolved_at === null ? null : new Date(Number(row.resolved_at)).toISOString(),
    status: row.status,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    evidence: parsePrimitiveJsonObject(row.evidence_json),
  };
}

function extractAuxiliaryReadings(slot: CollectableSlot): TelemetryAuxiliaryReadings {
  if (Array.isArray(slot.auxiliaryReadings)) {
    const normalized = slot.auxiliaryReadings.flatMap((reading) => {
      if (!reading || typeof reading !== "object") return [];
      const candidate = reading as Partial<TelemetryAuxiliaryReading>;
      if (typeof candidate.sourceKey !== "string" || typeof candidate.label !== "string") return [];
      return [{
        sourceKey: candidate.sourceKey,
        label: candidate.label,
        value: finiteNumberOrNull(candidate.value),
        unit: typeof candidate.unit === "string" ? candidate.unit : "",
        precision: Number.isInteger(candidate.precision) && Number(candidate.precision) >= 0 ? Number(candidate.precision) : 0,
      }];
    });
    if (normalized.length) return normalized;
  }

  const readings: TelemetryAuxiliaryReadingsMap = {};
  for (const candidate of [slot.supportingReadings]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    for (const [key, value] of Object.entries(candidate)) {
      if (
        value === null
        || typeof value === "string"
        || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))
      ) {
        readings[key] = value;
      }
    }
  }
  if (slot.lightRaw === null || (typeof slot.lightRaw === "number" && Number.isFinite(slot.lightRaw))) {
    readings.lightRaw = slot.lightRaw;
  }
  return readings;
}

function parseAuxiliaryJson(input: string): TelemetryAuxiliaryReadings {
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) {
      return parsed.flatMap((reading) => {
        if (!reading || typeof reading !== "object") return [];
        const candidate = reading as Partial<TelemetryAuxiliaryReading>;
        if (typeof candidate.sourceKey !== "string" || typeof candidate.label !== "string") return [];
        return [{
          sourceKey: candidate.sourceKey,
          label: candidate.label,
          value: finiteNumberOrNull(candidate.value),
          unit: typeof candidate.unit === "string" ? candidate.unit : "",
          precision: Number.isInteger(candidate.precision) && Number(candidate.precision) >= 0 ? Number(candidate.precision) : 0,
        }];
      });
    }
    if (!parsed || typeof parsed !== "object") return {};
    const result: TelemetryAuxiliaryReadingsMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        value === null
        || typeof value === "string"
        || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))
      ) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function parsePrimitiveJsonObject(input: string): Record<string, unknown> {
  const parsed = parseAuxiliaryJson(input);
  if (Array.isArray(parsed)) return {};
  return parsed;
}

function deduplicateSamples(samples: readonly TelemetrySample[]) {
  const byKey = new Map<string, TelemetrySample>();
  for (const sample of samples) {
    const timestamp = optionalTimestampMs(sample.observedAt);
    if (timestamp === null) continue;
    const key = `${sample.slotId}\u0000${timestamp}`;
    if (!byKey.has(key)) {
      byKey.set(key, { ...sample, observedAt: new Date(timestamp).toISOString() });
    }
  }
  return [...byKey.values()].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
}

function correlateSeries(left: readonly TelemetrySample[], right: readonly TelemetrySample[], minimumPairs: number) {
  const rightByTime = new Map(right.filter(hasNumericValue).map((sample) => [Date.parse(sample.observedAt), sample.value]));
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
  return { coefficient: clamp(covariance / Math.sqrt(leftVariance * rightVariance), -1, 1), pairCount: pairs.length };
}

function robustAnomaly(value: number, baseline: readonly number[]) {
  if (baseline.length < MIN_ANOMALY_BASELINE || !Number.isFinite(value)) return null;
  const center = median(baseline)!;
  const mad = medianAbsoluteDeviation(baseline)!;
  const iqr = interquartileRange(baseline)!;
  if (mad > Number.EPSILON) {
    const robustZ = Math.abs(value - center) / (1.4826 * mad);
    return robustZ > 3.5 ? { method: "mad" as const, median: center, mad, iqr, robustZ } : null;
  }
  if (iqr > Number.EPSILON) {
    const q1 = quantile(baseline, 0.25)!;
    const q3 = quantile(baseline, 0.75)!;
    return value < q1 - 3 * iqr || value > q3 + 3 * iqr
      ? { method: "iqr" as const, median: center, mad, iqr, lower: q1 - 3 * iqr, upper: q3 + 3 * iqr }
      : null;
  }
  return Math.abs(value - center) > Number.EPSILON
    ? { method: "flat-baseline" as const, median: center, mad, iqr }
    : null;
}

function linearSlopePerHour(samples: readonly (TelemetrySample & { value: number })[]) {
  if (samples.length < 2) return null;
  const start = Date.parse(samples[0].observedAt);
  const xs = samples.map((sample) => (Date.parse(sample.observedAt) - start) / 3_600_000);
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

function hasNumericValue(sample: TelemetrySample): sample is TelemetrySample & { value: number } {
  return typeof sample.value === "number" && Number.isFinite(sample.value);
}

function automaticResolution(durationMs: number): TelemetryResolution {
  if (durationMs <= 60 * 60_000) return "raw";
  if (durationMs <= 24 * 60 * 60_000) return "1m";
  if (durationMs <= 7 * 24 * 60 * 60_000) return "5m";
  return "1h";
}

function resolutionMs(resolution: TelemetryResolution) {
  if (resolution === "raw") return 1;
  if (resolution === "1m") return 60_000;
  if (resolution === "5m") return 5 * 60_000;
  return 60 * 60_000;
}

function slotFilter(slotIds: readonly string[] | undefined, column = "slot_id") {
  const normalized = [...new Set((slotIds ?? []).filter(Boolean))];
  if (!normalized.length) return { clause: "", parameters: [] as string[] };
  return {
    clause: `AND ${column} IN (${normalized.map(() => "?").join(", ")})`,
    parameters: normalized,
  };
}

function appendInFilter(
  clauses: string[],
  parameters: Array<string | number>,
  column: string,
  values: readonly string[] | undefined,
  includeNull = false,
) {
  const normalized = [...new Set((values ?? []).filter(Boolean))];
  if (!normalized.length) return;
  const placeholders = normalized.map(() => "?").join(", ");
  clauses.push(includeNull ? `(${column} IN (${placeholders}) OR ${column} IS NULL)` : `${column} IN (${placeholders})`);
  parameters.push(...normalized);
}

function normalizedRange(from: string | number | Date, to: string | number | Date) {
  const fromMs = timestampMs(from, "from");
  const toMs = timestampMs(to, "to");
  if (toMs < fromMs) throw new RangeError("to must be at or after from");
  return { fromMs, toMs };
}

function timestampMs(value: string | number | Date, label: string) {
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a valid timestamp`);
  return Math.trunc(parsed);
}

function optionalTimestampMs(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function finiteNumberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedActorName(value: string) {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < 2 || normalized.length > 50) throw new Error("处理人名称需为 2–50 个字符");
  return normalized;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function thresholdLimitsText(lower: number | null, upper: number | null, unit: string) {
  if (lower !== null && upper !== null) return `${lower}${unit}–${upper}${unit}`;
  if (lower !== null) return `不低于 ${lower}${unit}`;
  if (upper !== null) return `不高于 ${upper}${unit}`;
  return "未设置";
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function collectorSettingsFromRow(row: CollectorPreferencesRow): TelemetryCollectorSettings {
  return {
    pollIntervalMs: parseTelemetryPollIntervalMs(row.poll_interval_ms),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    updatedBy: row.updated_by,
  };
}

function normalizeCollectorSettingsActor(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, 80);
  if (normalized.length < 2) throw new Error("设置修改人名称无效");
  return normalized;
}

function stateSeverity(state: string): TelemetryEventSeverity {
  return state === "error" || state === "offline" ? "error" : state === "live" ? "info" : "warning";
}

function normalizeProvider(provider: string | undefined): DashboardSnapshot["provider"] {
  return provider === "huawei-cloud" ? "huawei-cloud" : "mock";
}

function isTelemetrySlotId(value: string): value is TelemetrySlotId {
  return (TELEMETRY_SLOT_IDS as readonly string[]).includes(value);
}

function slopeForBuckets(buckets: readonly (TelemetryBucket & { average: number })[]) {
  if (buckets.length < 2) return null;
  const start = Date.parse(buckets[0].startAt);
  const xs = buckets.map((bucket) => (Date.parse(bucket.startAt) - start) / 3_600_000);
  const ys = buckets.map((bucket) => bucket.average);
  const meanX = mean(xs)!;
  const meanY = mean(ys)!;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY);
    denominator += (xs[index] - meanX) ** 2;
  }
  return denominator === 0 ? null : numerator / denominator;
}

function standardDeviation(values: readonly number[]) {
  const center = mean(values);
  if (center === null) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);
}

function historyDataVersion(result: TelemetryHistoryResult) {
  return `history:${result.to}:${result.uniqueObservations}:${result.buckets.length}`;
}

function analysisDataVersion(result: TelemetryDeterministicAnalysis) {
  return `analysis:${result.to}:${result.reportCount}:${result.facts.length}`;
}

function publicEventType(event: TelemetryEvent): PublicTelemetryEvent["type"] {
  if (event.type === "gap") return event.slotId === null ? "collector-error" : "data-gap";
  if (event.type === "fire") return "anomaly";
  return event.type;
}

function publicFactKind(kind: TelemetryFact["kind"]): PublicTelemetryFact["kind"] {
  if (kind === "correlation") return "co-movement";
  if (kind === "anomaly") return "variability";
  if (kind === "quality") return "data-quality";
  return kind;
}

function primitiveEvidence(
  evidence: Record<string, unknown>,
  excludeBoolean: true,
): Record<string, number | string | null>;
function primitiveEvidence(
  evidence: Record<string, unknown>,
  excludeBoolean?: false,
): Record<string, number | string | boolean | null>;
function primitiveEvidence(
  evidence: Record<string, unknown>,
  excludeBoolean = false,
) {
  const output: Record<string, number | string | boolean | null> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (
      value === null
      || typeof value === "string"
      || (typeof value === "number" && Number.isFinite(value))
      || (!excludeBoolean && typeof value === "boolean")
    ) {
      output[key] = value as number | string | boolean | null;
    }
  }
  return output;
}

function flatlineTolerance(precision: number) {
  return 0.5 * 10 ** -Math.max(0, precision);
}

function numericRange(values: readonly number[]) {
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
}

function mean(values: readonly number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
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
  return center === null ? null : median(values.map((value) => Math.abs(value - center)));
}

function interquartileRange(values: readonly number[]) {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  return q1 === null || q3 === null ? null : q3 - q1;
}

function groupBy<T, K>(values: readonly T[], key: (value: T) => K) {
  const grouped = new Map<K, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const bucket = grouped.get(groupKey);
    if (bucket) bucket.push(value);
    else grouped.set(groupKey, [value]);
  }
  return grouped;
}

function countBy<T, K>(values: readonly T[], key: (value: T) => K) {
  const counts = new Map<K, number>();
  for (const value of values) {
    const groupKey = key(value);
    counts.set(groupKey, (counts.get(groupKey) ?? 0) + 1);
  }
  return counts;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatFactValue(value: number | null, unit: string) {
  return value === null ? "—" : `${Number(value.toFixed(3))}${unit}`;
}

function formatSigned(value: number) {
  return `${value >= 0 ? "+" : ""}${Number(value.toFixed(3))}`;
}
