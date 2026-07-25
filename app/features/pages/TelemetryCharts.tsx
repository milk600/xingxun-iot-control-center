"use client";

import { LineChart, HeatmapChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useMemo, useRef } from "react";
import type { TelemetrySlot, TelemetrySlotId } from "@/app/lib/iot/contracts";
import { EmptyState, SLOT_COLORS, formatTime } from "./PagePrimitives";
import type { SessionTelemetryPoint } from "./useSessionTelemetry";
import styles from "./Pages.module.css";

echarts.use([
  LineChart,
  HeatmapChart,
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

function EChart({ option, label, className }: { option: echarts.EChartsCoreOption; label: string; className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.EChartsType | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = echarts.init(host, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => chart.resize());
    observer?.observe(host);
    const resize = () => chart.resize();
    if (!observer) window.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={hostRef} className={className ?? styles.echart} role="img" aria-label={label} tabIndex={0} />;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function withMissingIntervals<T extends { at: string; value: number }>(values: T[]) {
  if (values.length < 3) return values.map((item) => ({ ...item, missing: false as const }));
  const intervals = values.slice(1)
    .map((item, index) => Date.parse(item.at) - Date.parse(values[index].at))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  const typical = intervals[Math.floor(intervals.length / 2)];
  if (!typical) return values.map((item) => ({ ...item, missing: false as const }));
  return values.flatMap((item, index) => {
    if (index === 0) return [{ ...item, missing: false as const }];
    const previousAt = Date.parse(values[index - 1].at);
    const currentAt = Date.parse(item.at);
    if (currentAt - previousAt <= typical * 1.8) return [{ ...item, missing: false as const }];
    return [
      { ...item, at: new Date(previousAt + typical).toISOString(), value: Number.NaN, missing: true as const },
      { ...item, missing: false as const },
    ];
  });
}

export function TelemetryTrendChart({
  points,
  slots,
  visibleSlots,
}: {
  points: SessionTelemetryPoint[];
  slots: TelemetrySlot[];
  visibleSlots: TelemetrySlotId[];
}) {
  const drawableSlots = useMemo(
    () => slots.filter((slot) => visibleSlots.includes(slot.slotId) && points.some((point) => typeof point.values[slot.slotId] === "number")),
    [points, slots, visibleSlots],
  );
  const units = new Set(drawableSlots.map((slot) => slot.unit || "无单位"));
  const relative = drawableSlots.length > 1 && units.size > 1;
  const zeroBaselineLabels = relative
    ? drawableSlots.filter((slot) => points.find((point) => typeof point.values[slot.slotId] === "number")?.values[slot.slotId] === 0).map((slot) => slot.label)
    : [];

  const option = useMemo<echarts.EChartsCoreOption>(() => ({
    animationDuration: 180,
    aria: {
      enabled: true,
      description: relative
        ? `本次会话 ${drawableSlots.length} 路混合单位遥测相对首个观测值的变化百分比。`
        : `本次会话 ${drawableSlots.length} 路遥测的绝对值趋势。`,
    },
    grid: { left: 52, right: 22, top: 24, bottom: 66, containLabel: false },
    toolbox: {
      right: 4,
      top: -7,
      itemSize: 15,
      feature: {
        dataZoom: { yAxisIndex: "none", title: { zoom: "框选缩放", back: "还原缩放" } },
        saveAsImage: { name: "危化智巡-遥测数据", pixelRatio: 2, title: "导出图表" },
      },
    },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: "#0b1533",
      borderWidth: 0,
      textStyle: { color: "#fff", fontSize: 12 },
      formatter: (params: unknown) => {
        const rows = (Array.isArray(params) ? params : [params]) as Array<{ data?: { raw?: number | null; at?: string; unit?: string; precision?: number }; marker?: string; seriesName?: string }>;
        const at = rows[0]?.data?.at;
        return [
          `<strong>${escapeHtml(at ? new Date(at).toLocaleString("zh-CN", { hour12: false }) : "")}</strong>`,
          ...rows.map((row) => {
            const raw = row.data?.raw;
            const value = typeof raw === "number" ? raw.toFixed(row.data?.precision ?? 2) : "--";
            return `${row.marker ?? ""}${escapeHtml(row.seriesName ?? "")}：${value}${escapeHtml(row.data?.unit ?? "")}`;
          }),
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: "#d9e0ea" } },
      axisLabel: { color: "#77849a", fontSize: 12, hideOverlap: true },
      axisTick: { show: false },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: relative ? "相对首点 %" : drawableSlots.length === 1 ? (drawableSlots[0]?.unit || "数值") : (drawableSlots[0]?.unit || "数值"),
      nameTextStyle: { color: "#77849a", fontSize: 12, align: "left" },
      axisLabel: { color: "#77849a", fontSize: 12, formatter: relative ? "{value}%" : "{value}" },
      splitLine: { lineStyle: { color: "#eef2f6" } },
    },
    dataZoom: [
      { type: "inside", filterMode: "none", minSpan: 5 },
      { type: "slider", height: 18, bottom: 13, borderColor: "#e7ecf3", fillerColor: "rgba(47,118,246,.12)", handleStyle: { color: "#2f76f6" }, textStyle: { color: "#77849a", fontSize: 10 } },
    ],
    series: drawableSlots.map((slot) => {
      const values = points.flatMap((point) => {
        const value = point.values[slot.slotId];
        return typeof value === "number" ? [{ at: point.at, value }] : [];
      });
      const baseline = values[0]?.value;
      const plottedValues = withMissingIntervals(values);
      return {
        type: "line",
        name: slot.label,
        showSymbol: false,
        symbol: "circle",
        symbolSize: 7,
        smooth: 0.2,
        connectNulls: false,
        lineStyle: { width: 2, color: SLOT_COLORS[slot.slotId] },
        itemStyle: { color: SLOT_COLORS[slot.slotId] },
        emphasis: { focus: "series" },
        data: plottedValues.map(({ at, value, missing }, index) => ({
          value: [at, missing ? null : relative ? (baseline === 0 || baseline === undefined ? null : ((value - baseline) / Math.abs(baseline)) * 100) : value],
          raw: missing ? null : value,
          unit: slot.unit,
          precision: slot.precision,
          at,
          symbolSize: index === plottedValues.length - 1 ? 7 : 0,
          showSymbol: index === plottedValues.length - 1,
        })),
      };
    }),
  }), [drawableSlots, points, relative]);

  if (points.length < 2 || drawableSlots.length === 0) {
    return <EmptyState title="正在建立本次会话趋势" detail="至少收到两轮带设备观测时间的真实数据后，趋势曲线会自动出现。" />;
  }

  const label = relative
    ? `混合单位趋势已换算为相对首个观测值百分比，共 ${points.length} 个时间点。`
    : `${drawableSlots.map((slot) => slot.label).join("、")}绝对值趋势，共 ${points.length} 个时间点。`;

  return (
    <figure className={styles.chartFigure}>
      <EChart option={option} label={label} />
      <figcaption>
        <span>{formatTime(points[0]?.at ?? null)} — {formatTime(points.at(-1)?.at ?? null)}</span>
        <span>{relative ? "混合单位已按各序列首点归一化" : "纵轴显示原始绝对值"}</span>
        {zeroBaselineLabels.length > 0 && <span className={styles.chartWarning}>{zeroBaselineLabels.join("、")}首点为 0，无法计算相对变化</span>}
      </figcaption>
    </figure>
  );
}

export function MetricAbsoluteTrendChart({ points, slot }: { points: SessionTelemetryPoint[]; slot: TelemetrySlot }) {
  const samples = points.flatMap((point) => {
    const value = point.values[slot.slotId];
    return typeof value === "number" ? [{ at: point.at, value }] : [];
  });
  const plottedSamples = withMissingIntervals(samples);
  const option = useMemo<echarts.EChartsCoreOption>(() => ({
    animationDuration: 180,
    aria: { enabled: true, description: `${slot.label}绝对值趋势，共 ${samples.length} 个观测。` },
    grid: { left: 45, right: 12, top: 18, bottom: 30 },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: "#0b1533",
      borderWidth: 0,
      textStyle: { color: "#fff", fontSize: 11 },
      formatter: (params: unknown) => {
        const row = (Array.isArray(params) ? params[0] : params) as { data?: { raw?: number | null; at?: string } };
        const value = typeof row.data?.raw === "number" ? row.data.raw.toFixed(slot.precision) : "—";
        return `${escapeHtml(row.data?.at ? new Date(row.data.at).toLocaleString("zh-CN", { hour12: false }) : "")}<br/>${escapeHtml(slot.label)}：${value}${escapeHtml(slot.unit)}`;
      },
    },
    xAxis: { type: "time", axisLabel: { color: "#8490a3", fontSize: 11, hideOverlap: true }, axisTick: { show: false }, axisLine: { lineStyle: { color: "#dfe5ed" } }, splitLine: { show: false } },
    yAxis: { type: "value", name: slot.unit || "数值", scale: true, nameTextStyle: { color: "#8490a3", fontSize: 11 }, axisLabel: { color: "#8490a3", fontSize: 11 }, splitLine: { lineStyle: { color: "#eef2f6" } } },
    series: [{
      type: "line",
      name: slot.label,
      showSymbol: false,
      smooth: 0.16,
      lineStyle: { width: 2, color: SLOT_COLORS[slot.slotId] },
      itemStyle: { color: SLOT_COLORS[slot.slotId] },
      data: plottedSamples.map(({ at, value, missing }, index) => ({ value: [at, missing ? null : value], raw: missing ? null : value, at, symbolSize: index === plottedSamples.length - 1 ? 6 : 0, showSymbol: index === plottedSamples.length - 1 })),
    }],
  }), [plottedSamples, samples.length, slot]);

  if (samples.length < 2) return <EmptyState title="暂无区间趋势" detail="所选范围至少需要两个有效观测。" />;
  return <EChart option={option} label={`${slot.label}绝对值趋势，共 ${samples.length} 个有效观测。`} className={styles.analysisMetricChart} />;
}

export function IntradayHeatmap({ points, slots }: { points: SessionTelemetryPoint[]; slots: TelemetrySlot[] }) {
  const cells = useMemo(() => slots.flatMap((slot, row) => {
    const recentValues = points.slice(-24).map((point) => point.values[slot.slotId]).filter((value): value is number => typeof value === "number");
    const baseline = recentValues.length ? recentValues.reduce((sum, value) => sum + value, 0) / recentValues.length : null;
    if (baseline === null || baseline === 0) return [];
    const byHour = new Map<number, number[]>();
    for (const point of points) {
      const value = point.values[slot.slotId];
      if (typeof value !== "number") continue;
      const hour = new Date(point.at).getHours();
      byHour.set(hour, [...(byHour.get(hour) ?? []), value]);
    }
    return [...byHour].map(([hour, values]) => {
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      return {
        value: [hour, row, ((average - baseline) / Math.abs(baseline)) * 100],
        average,
        baseline,
        unit: slot.unit,
        precision: slot.precision,
      };
    });
  }), [points, slots]);
  const magnitudes = cells.map((cell) => Math.abs(cell.value[2] ?? 0));
  const max = Math.max(...magnitudes, 1);
  const option = useMemo<echarts.EChartsCoreOption>(() => ({
    animationDuration: 180,
    aria: { enabled: true, description: `${slots.length} 路遥测按各指标自身近期基线计算相对变化的日内热力图，有数据的格子 ${cells.length} 个。` },
    grid: { left: 88, right: 18, top: 18, bottom: 40 },
    tooltip: {
      position: "top",
      formatter: (param: unknown) => {
        const item = param as { data?: { value: [number, number, number]; average: number; baseline: number; unit: string; precision: number } };
        const [hour, row, relative] = item.data?.value ?? [];
        const slot = slots[row ?? -1];
        return `${String(hour).padStart(2, "0")}:00<br/>${escapeHtml(slot?.label ?? "")}均值：${item.data ? item.data.average.toFixed(item.data.precision) : "—"}${escapeHtml(item.data?.unit ?? "")}<br/>相对近期基线：${typeof relative === "number" ? `${relative >= 0 ? "+" : ""}${relative.toFixed(1)}%` : "—"}`;
      },
    },
    xAxis: { type: "category", data: Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`), axisLabel: { color: "#77849a", fontSize: 11, interval: 3 }, axisTick: { show: false }, axisLine: { lineStyle: { color: "#d9e0ea" } } },
    yAxis: { type: "category", data: slots.map((slot) => slot.label), axisLabel: { color: "#5f6c86", fontSize: 12, width: 72, overflow: "truncate" }, axisTick: { show: false }, axisLine: { show: false } },
    visualMap: { min: -max, max, show: false, dimension: 2, inRange: { color: ["#5d96ee", "#f3f6fa", "#ee9d3c"] } },
    series: [{ type: "heatmap", data: cells, itemStyle: { borderColor: "#fff", borderWidth: 2, borderRadius: 3 }, emphasis: { itemStyle: { borderColor: "#0b1533", borderWidth: 1 } } }],
  }), [cells, max, slots]);

  if (cells.length === 0) return <EmptyState title="暂无日内分布" detail="需要具有非零近期基线的有效观测后，才能计算相对热力。" />;
  return <EChart option={option} label={`遥测日内相对基线热力图，包含 ${cells.length} 个有效数据格。`} className={styles.heatmapChart} />;
}
