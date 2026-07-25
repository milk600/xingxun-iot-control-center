"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  TELEMETRY_SLOT_IDS,
  type DashboardSnapshot,
  type DataState,
  type TelemetrySlotId,
} from "@/app/lib/iot/contracts";

const INITIAL_TIMESTAMP = new Date(0).toISOString();

export interface SessionTelemetryPoint {
  /** The device observation time. Never the client refresh time. */
  at: string;
  values: Partial<Record<TelemetrySlotId, number>>;
}

export interface SessionTelemetryEvent {
  id: string;
  at: string;
  kind: "state" | "error";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  slotId?: TelemetrySlotId;
}

function isRealTimestamp(value: string | null): value is string {
  return Boolean(value && value !== INITIAL_TIMESTAMP && Number.isFinite(Date.parse(value)));
}

function stateSeverity(state: DataState): SessionTelemetryEvent["severity"] {
  if (state === "error" || state === "offline") return "critical";
  if (state === "stale" || state === "empty") return "warning";
  return "info";
}

/**
 * Keeps a truthful, in-memory timeline for this browser session. Each metric is
 * de-duplicated by its own observedAt value, so polling the same device sample
 * never manufactures extra points.
 */
export function useSessionTelemetry(snapshot: DashboardSnapshot, limit = 120) {
  const [points, setPoints] = useState<SessionTelemetryPoint[]>([]);
  const [events, setEvents] = useState<SessionTelemetryEvent[]>([]);
  const previousStatesRef = useRef<Partial<Record<TelemetrySlotId, DataState>>>({});
  const seenErrorsRef = useRef(new Set<string>());

  useEffect(() => {
    const samples = TELEMETRY_SLOT_IDS.flatMap((slotId) => {
      const slot = snapshot.slots[slotId];
      return typeof slot.value === "number" && Number.isFinite(slot.value) && isRealTimestamp(slot.observedAt)
        ? [{ slotId, at: slot.observedAt, value: slot.value }]
        : [];
    });

    const timer = window.setTimeout(() => {
      if (samples.length > 0) setPoints((current) => {
        let changed = false;
        const nextByTime = new Map(current.map((point) => [point.at, point]));

        for (const sample of samples) {
          const existing = nextByTime.get(sample.at);
          if (existing?.values[sample.slotId] === sample.value) continue;
          nextByTime.set(sample.at, {
            at: sample.at,
            values: { ...(existing?.values ?? {}), [sample.slotId]: sample.value },
          });
          changed = true;
        }

        if (!changed) return current;
        return [...nextByTime.values()]
          .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
          .slice(-limit);
      });

    const stateEvents: SessionTelemetryEvent[] = [];
    for (const slotId of TELEMETRY_SLOT_IDS) {
      const slot = snapshot.slots[slotId];
      const previous = previousStatesRef.current[slotId];
      previousStatesRef.current[slotId] = slot.state;
      if (!previous || previous === slot.state) continue;
      const at = isRealTimestamp(slot.observedAt) ? slot.observedAt : snapshot.generatedAt;
      stateEvents.push({
        id: `state:${slotId}:${previous}:${slot.state}:${at}`,
        at,
        kind: "state",
        severity: stateSeverity(slot.state),
        title: `${slot.label}状态变化`,
        detail: `${previous} → ${slot.state}`,
        slotId,
      });
    }

    const errorEvents = snapshot.partialErrors.flatMap<SessionTelemetryEvent>((error) => {
      const id = `error:${snapshot.generatedAt}:${error.scope}:${error.message}`;
      if (seenErrorsRef.current.has(id)) return [];
      seenErrorsRef.current.add(id);
      return [{
        id,
        at: snapshot.generatedAt,
        kind: "error",
        severity: "critical",
        title: error.scope === "slots" ? "传感器数据异常" : "小车连接异常",
        detail: error.scope === "slots"
          ? "暂时无法读取部分传感器数据，请稍后重试。"
          : "暂时无法获取小车状态，请检查连接设置。",
      }];
    });

      if (stateEvents.length > 0 || errorEvents.length > 0) {
        setEvents((current) => [...stateEvents, ...errorEvents, ...current].slice(0, limit));
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [limit, snapshot]);

  const clear = useCallback(() => {
    setPoints([]);
    setEvents([]);
    seenErrorsRef.current.clear();
  }, []);

  return { points, events, clear };
}
