"use client";

import {
  Activity,
  CircleAlert,
  Cloud,
  Droplets,
  FlaskConical,
  Gauge,
  Radio,
  Thermometer,
  Wind,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { TELEMETRY_SLOT_IDS, type DataState, type TelemetrySlot, type TelemetrySlotId } from "@/app/lib/iot/contracts";
import { DataFade } from "./PageTransitions";
import type { SessionTelemetryPoint } from "./useSessionTelemetry";
import styles from "./Pages.module.css";

const ICON_SEQUENCE: readonly LucideIcon[] = [Thermometer, Droplets, Cloud, Wind, FlaskConical, Gauge];
const COLOR_SEQUENCE = ["#2f76f6", "#16aeb0", "#20a860", "#df8510", "#df4633", "#7857d6"] as const;

/** Slot presentation is generated from the contract so a sixth or later slot never disappears. */
export const SLOT_ICONS = Object.fromEntries(
  TELEMETRY_SLOT_IDS.map((slotId, index) => [slotId, ICON_SEQUENCE[index % ICON_SEQUENCE.length] ?? Activity]),
) as Record<TelemetrySlotId, LucideIcon>;

export const SLOT_COLORS = Object.fromEntries(
  TELEMETRY_SLOT_IDS.map((slotId, index) => [slotId, COLOR_SEQUENCE[index % COLOR_SEQUENCE.length] ?? "#64748b"]),
) as Record<TelemetrySlotId, string>;

export const STATE_LABELS: Record<DataState, string> = {
  loading: "读取中",
  live: "实时",
  stale: "数据陈旧",
  offline: "离线",
  empty: "等待映射",
  error: "异常",
};

export function formatTime(value: string | null) {
  if (!value || value === new Date(0).toISOString()) return "等待数据";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatMetric(slot: TelemetrySlot) {
  if (slot.value === null) return "--";
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: slot.precision,
    maximumFractionDigits: slot.precision,
  }).format(slot.value);
}

export function StatusPill({ state, children }: { state: DataState | "online" | "ready" | "warning"; children?: ReactNode }) {
  return (
    <span className={`${styles.statusPill} ${styles[`status_${state}`]}`}>
      <i aria-hidden="true" />
      {children ?? (state in STATE_LABELS ? STATE_LABELS[state as DataState] : state)}
    </span>
  );
}

function Sparkline({ slotId, points }: { slotId: TelemetrySlotId; points: SessionTelemetryPoint[] }) {
  const values = points.map((point) => point.values[slotId]).filter((value): value is number => typeof value === "number");
  if (values.length < 2) {
    return (
      <div className={styles.sparklineEmpty} title="需要至少两次有效采样才能绘制趋势">
        <span /><span /><span /><span />
      </div>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 0.001);
  const path = values.map((value, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100;
    const y = 25 - ((value - min) / span) * 20;
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return (
    <svg className={styles.sparkline} viewBox="0 0 100 30" role="img" aria-label={`${values.length} 个有效采样点趋势`} preserveAspectRatio="none">
      <path d={path} style={{ stroke: SLOT_COLORS[slotId] }} />
    </svg>
  );
}

export function MetricCard({ slot, points = [] }: { slot: TelemetrySlot; points?: SessionTelemetryPoint[] }) {
  const Icon = SLOT_ICONS[slot.slotId] ?? Activity;
  return (
    <article className={`${styles.metricCard} ${styles[`tone_${slot.tone}`]}`} data-slot-id={slot.slotId}>
      <div className={styles.metricTop}>
        <span className={styles.metricIcon}><Icon size={21} aria-hidden="true" /></span>
        <StatusPill state={slot.state} />
      </div>
      <div className={styles.metricValue}>
        <span>{slot.label}</span>
        <div><strong><DataFade value={slot.value}>{formatMetric(slot)}</DataFade></strong>{slot.unit && <small>{slot.unit}</small>}</div>
      </div>
      <Sparkline slotId={slot.slotId} points={points} />
    </article>
  );
}

export function EmptyState({ icon: Icon = Radio, title, detail, action }: { icon?: LucideIcon; title: string; detail: string; action?: ReactNode }) {
  return (
    <div className={styles.emptyState}>
      <span><Icon size={23} aria-hidden="true" /></span>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  );
}

export function InlineError({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className={styles.inlineError} role="alert">
      <CircleAlert size={18} aria-hidden="true" />
      <span>{message}</span>
      {retry && <button type="button" onClick={retry}>重新尝试</button>}
    </div>
  );
}

export function downloadSessionCsv(points: SessionTelemetryPoint[], slots: readonly TelemetrySlot[] = []) {
  if (points.length === 0) return;
  const slotDirectory = new Map(slots.map((slot) => [slot.slotId, slot]));
  const header = ["observedAt", "slotId", "name", "value", "unit", "sourceKey", "currentState"];
  const rows = points.flatMap((point) => TELEMETRY_SLOT_IDS.map((slotId) => {
    const slot = slotDirectory.get(slotId);
    return [
      point.at,
      slotId,
      slot?.label ?? slotId,
      point.values[slotId] ?? "",
      slot?.unit ?? "",
      slot?.sourceKey ?? "",
      slot?.state ?? "",
    ];
  }));
  const csv = [header, ...rows].map((row) => row.map((cell) => JSON.stringify(cell)).join(",")).join("\n");
  const content = `\uFEFF${csv}`;
  const fileName = `iot-session-${new Date().toISOString().replaceAll(":", "-")}.csv`;
  const mimeType = "text/csv;charset=utf-8";
  if (typeof window.XingXunCloud?.saveTextFile === "function") {
    window.XingXunCloud.saveTextFile(content, fileName, mimeType);
    return;
  }

  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
