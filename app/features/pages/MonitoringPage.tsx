"use client";

import {
  Activity,
  BrainCircuit,
  CircleAlert,
  CircleCheck,
  Clock3,
  Download,
  Eraser,
  History,
  Pause,
  Play,
  RefreshCw,
  Rows3,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAiControl } from "@/app/features/ai/AiControlContext";
import {
  AI_ACTION_EVENT,
  registerActionReceiver,
  readActionDispatchDetail,
  reportActionError,
  reportActionSuccess,
} from "@/app/lib/ai/action-events";
import { useIotDashboard } from "@/app/features/iot/use-iot-dashboard";
import { SpatialDistributionPanel } from "@/app/features/spatial/SpatialDistributionMap";
import { TransitionLink } from "@/app/features/transitions/NavigationTransition";
import type { AgentActionDispatchDetail } from "@/app/lib/ai/contracts";
import { TELEMETRY_SLOT_IDS, type TelemetrySlot, type TelemetrySlotId } from "@/app/lib/iot/contracts";
import type {
  TelemetryAnalysisResult,
  TelemetryAnalyticsState,
  TelemetryEventsResult,
  TelemetryHistoryRange,
  TelemetryHistoryResult,
} from "@/app/lib/iot/telemetry-history-contracts";
import {
  EmptyState,
  InlineError,
  MetricCard,
  SLOT_COLORS,
  SLOT_ICONS,
  STATE_LABELS,
  StatusPill,
  downloadSessionCsv,
  formatMetric,
  formatTime,
} from "./PagePrimitives";
import {
  DataFade,
  DirectionalPanel,
  SlidingTabs,
  useDirectionalSelection,
  type SlidingTabItem,
} from "./PageTransitions";
import { useSessionTelemetry, type SessionTelemetryEvent, type SessionTelemetryPoint } from "./useSessionTelemetry";
import styles from "./Pages.module.css";

const TelemetryTrendChart = lazy(async () => ({ default: (await import("./TelemetryCharts")).TelemetryTrendChart }));
const MetricAbsoluteTrendChart = lazy(async () => ({ default: (await import("./TelemetryCharts")).MetricAbsoluteTrendChart }));
const IntradayHeatmap = lazy(async () => ({ default: (await import("./TelemetryCharts")).IntradayHeatmap }));

type MonitorTab = "live" | "analysis" | "history" | "events";
function sameSlotList(left: readonly TelemetrySlotId[], right: readonly TelemetrySlotId[]) {
  return left.length === right.length && left.every((slotId, index) => slotId === right[index]);
}

const MONITOR_TAB_ORDER = ["live", "analysis", "history", "events"] as const;
const MONITOR_TABS: readonly SlidingTabItem<MonitorTab>[] = [
  { id: "live", label: "实时趋势", icon: Activity },
  { id: "analysis", label: "分析洞察", icon: BrainCircuit },
  { id: "history", label: "历史数据", icon: History },
  { id: "events", label: "事件记录", icon: Rows3 },
];

/** Injection boundary for the history/analysis protocol owned by AiControlContext. */
export interface MonitoringBackendData {
  history?: { status: "idle" | "loading" | "ready" | "error"; points: SessionTelemetryPoint[]; result?: TelemetryHistoryResult; error?: string };
  events?: { status: "idle" | "loading" | "ready" | "error"; items: SessionTelemetryEvent[]; result?: TelemetryEventsResult; error?: string };
  aiBrief?: { status: "idle" | "loading" | "ready" | "error"; phase?: TelemetryAnalyticsState["analysisPhase"]; result?: TelemetryAnalysisResult; error?: string };
}

const HISTORY_RANGE_LABELS: Record<TelemetryHistoryRange, string> = { "1h": "近 1 小时", "24h": "近 24 小时", "7d": "近 7 天", "30d": "近 30 天" };
const HISTORY_RANGE_MS: Record<TelemetryHistoryRange, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };

function historyResultToPoints(result: TelemetryHistoryResult | null): SessionTelemetryPoint[] {
  if (!result) return [];
  const byTime = new Map<string, SessionTelemetryPoint>();
  for (const series of result.series) {
    for (const bucket of series.buckets) {
      const existing = byTime.get(bucket.startAt);
      byTime.set(bucket.startAt, { at: bucket.startAt, values: { ...(existing?.values ?? {}), [series.slotId]: bucket.average } });
    }
  }
  return [...byTime.values()].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

function eventResultToItems(result: TelemetryEventsResult | null): SessionTelemetryEvent[] {
  if (!result) return [];
  return result.events.map((event) => ({
    id: event.id,
    at: event.startedAt,
    kind: event.type === "collector-error" ? "error" : "state",
    severity: event.severity,
    title: event.type === "collector-error" ? "数据读取异常" : event.title,
    detail: event.type === "collector-error" ? "暂时无法更新历史数据，请稍后重试。" : event.detail,
    slotId: event.slotId ?? undefined,
  }));
}

function valuesFor(points: SessionTelemetryPoint[], slotId: TelemetrySlotId) {
  return points.map((point) => point.values[slotId]).filter((value): value is number => typeof value === "number");
}

function mean(values: number[]) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pearson(points: SessionTelemetryPoint[], left: TelemetrySlotId, right: TelemetrySlotId) {
  const pairs = points.flatMap((point) => {
    const x = point.values[left];
    const y = point.values[right];
    return typeof x === "number" && typeof y === "number" ? [[x, y] as const] : [];
  });
  if (pairs.length < 12) return null;
  const xMean = pairs.reduce((sum, [value]) => sum + value, 0) / pairs.length;
  const yMean = pairs.reduce((sum, [, value]) => sum + value, 0) / pairs.length;
  const numerator = pairs.reduce((sum, [x, y]) => sum + (x - xMean) * (y - yMean), 0);
  const xSpread = Math.sqrt(pairs.reduce((sum, [x]) => sum + (x - xMean) ** 2, 0));
  const ySpread = Math.sqrt(pairs.reduce((sum, [, y]) => sum + (y - yMean) ** 2, 0));
  return xSpread === 0 || ySpread === 0 ? null : numerator / (xSpread * ySpread);
}

function formatDelay(value: string | null | undefined) {
  if (!value) return "—";
  const milliseconds = Date.now() - Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 60_000) return "< 1 分钟";
  if (milliseconds < 3_600_000) return `${Math.floor(milliseconds / 60_000)} 分钟`;
  if (milliseconds < 86_400_000) return `${(milliseconds / 3_600_000).toFixed(1)} 小时`;
  return `${Math.floor(milliseconds / 86_400_000)} 天`;
}

function factSlotIds(analysis: TelemetryAnalysisResult, factIds: string[]) {
  const ids = new Set(factIds);
  return [...new Set(analysis.facts.filter((fact) => ids.has(fact.id)).flatMap((fact) => fact.slotIds))];
}

function RangeSelector({ range, onChange }: { range: TelemetryHistoryRange; onChange: (range: TelemetryHistoryRange) => void }) {
  return <div className={styles.rangeSelector} aria-label="数据时间范围">{(Object.keys(HISTORY_RANGE_LABELS) as TelemetryHistoryRange[]).map((item) => <button key={item} type="button" aria-pressed={range === item} className={range === item ? styles.rangeActive : undefined} onClick={() => onChange(item)}>{HISTORY_RANGE_LABELS[item]}</button>)}</div>;
}

function AnalysisProgress({ phase }: { phase: TelemetryAnalyticsState["analysisPhase"] }) {
  if (phase === "idle") return null;
  const label = phase === "loading-data"
    ? "正在调取数据"
    : phase === "calculating"
      ? "正在计算统计"
      : phase === "analyzing"
        ? "正在识别问题"
        : phase === "organizing"
          ? "正在生成建议"
          : phase === "ready"
            ? "分析完成"
            : "生成失败";
  const stages = ["调取数据", "统计分析", "问题描述", "生成建议"];
  const activeIndex = phase === "loading-data" ? 0 : phase === "calculating" ? 1 : phase === "analyzing" ? 2 : phase === "organizing" ? 3 : -1;
  return (
    <div className={`${styles.analysisProgress} ${styles[`analysisProgress_${phase}`]}`} role="status" aria-live="polite">
      <div><strong>{label}</strong>{activeIndex >= 0 && <RefreshCw className={styles.spinning} size={14} />}</div>
      <ol>{stages.map((stage, index) => {
        const complete = phase === "ready" || (activeIndex >= 0 && index < activeIndex);
        const current = activeIndex === index;
        return <li key={stage} data-state={phase === "error" && index === stages.length - 1 ? "error" : complete ? "complete" : current ? "current" : "pending"}><i aria-hidden="true" />{stage}</li>;
      })}</ol>
    </div>
  );
}

function ChartFallback({ compact = false }: { compact?: boolean }) {
  return <div className={`${styles.chartLoading} ${compact ? styles.chartLoadingCompact : ""}`} role="status" aria-live="polite"><RefreshCw className={styles.spinning} size={18} />正在准备图表</div>;
}

function AnalysisView({ points, slots, backendData, range, aiRequestedRange, selectedSlotId, onRangeChange, onSelectSlot, onViewTrend, onGenerateAi, onShowEvidence }: {
  points: SessionTelemetryPoint[];
  slots: TelemetrySlot[];
  backendData?: MonitoringBackendData;
  range: TelemetryHistoryRange;
  aiRequestedRange: TelemetryHistoryRange | null;
  selectedSlotId: TelemetrySlotId;
  onRangeChange: (range: TelemetryHistoryRange) => void;
  onSelectSlot: (slotId: TelemetrySlotId) => void;
  onViewTrend: (slotId: TelemetrySlotId) => void;
  onGenerateAi: () => void;
  onShowEvidence: (slotIds: TelemetrySlotId[]) => void;
}) {
  const historyResult = backendData?.history?.result;
  const eventsResult = backendData?.events?.result;
  const brief = aiRequestedRange === range ? backendData?.aiBrief : undefined;
  const analysis = brief?.result;
  const analysisPoints = backendData?.history?.status === "ready" && backendData.history.points.length > 0 ? backendData.history.points : points;
  const profiles = slots.map((slot) => {
    const values = valuesFor(analysisPoints, slot.slotId);
    const summary = historyResult?.series.find((series) => series.slotId === slot.slotId)?.summary;
    return {
      slot,
      values,
      min: summary?.minimum ?? (values.length ? Math.min(...values) : null),
      max: summary?.maximum ?? (values.length ? Math.max(...values) : null),
      average: summary?.average ?? mean(values),
      delta: summary?.delta ?? (values.length > 1 ? values.at(-1)! - values[0] : null),
      sampleCount: summary?.sampleCount ?? values.length,
    };
  });
  const selectedSlot = slots.find((slot) => slot.slotId === selectedSlotId) ?? slots[0];
  const selectedProfile = profiles.find((profile) => profile.slot.slotId === selectedSlot.slotId)!;
  const selectedEvents = eventsResult?.events.filter((event) => event.slotId === selectedSlot.slotId) ?? [];
  const anomalyCount = selectedEvents.filter((event) => event.type === "anomaly").length;
  const gapCount = selectedEvents.filter((event) => event.type === "data-gap").length;
  const attentionCount = eventsResult
    ? eventsResult.events.filter((event) => event.status === "active" && event.severity !== "info").length
    : (backendData?.events?.items ?? []).filter((event) => event.severity !== "info").length;
  const latestObservedAt = historyResult?.series.map((series) => series.summary.latestObservedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? analysisPoints.at(-1)?.at;
  const coverage = historyResult?.coverage;
  const posture = attentionCount > 0
    ? { label: "存在关注项", detail: `${attentionCount} 个当前事件需要核查`, className: styles.postureWarning, icon: CircleAlert }
    : { label: "态势平稳", detail: "所选范围内没有活跃关注事件", className: styles.postureHealthy, icon: ShieldCheck };
  const PostureIcon = posture.icon;
  const qualityLabel = analysis?.basis.quality === "high" ? "高" : analysis?.basis.quality === "medium" ? "中" : analysis?.basis.quality === "low" ? "低" : "—";

  return (
    <div className={styles.analysisStack}>
      <div className={styles.analysisRangeBar}><div><strong>分析范围</strong><span>选择要查看的时间区间</span></div><RangeSelector range={range} onChange={onRangeChange} /></div>
      <section className={styles.analysisSummary} data-ai-region="analysis-summary" aria-label="区间分析汇总">
        <div><span>独立上报次数</span><strong>{historyResult?.uniqueObservations ?? analysisPoints.length}</strong></div>
        <div><span>数据覆盖率</span><strong>{coverage === undefined ? "—" : `${(coverage * 100).toFixed(0)}%`}</strong></div>
        <div><span>最新上报延迟</span><strong>{formatDelay(latestObservedAt)}</strong></div>
        <div><span>当前关注事件</span><strong>{attentionCount}<small> 项</small></strong></div>
      </section>

      <section className={styles.analysisTopGrid}>
        <article className={`${styles.card} ${styles.postureCard} ${posture.className}`} data-ai-region="indicator-posture" data-ai-label="指标态势">
          <header className={styles.cardHeader}><div><h2>指标态势</h2><span>区间走势与波动概览</span></div></header>
          <div className={styles.postureBody}><span><PostureIcon size={24} /></span><div><strong>{posture.label}</strong><p>{posture.detail}</p></div></div>
          <div className={styles.analysisMetricPicker}>{slots.map((slot) => <button key={slot.slotId} type="button" aria-pressed={slot.slotId === selectedSlot.slotId} onClick={() => onSelectSlot(slot.slotId)}><span style={{ backgroundColor: SLOT_COLORS[slot.slotId] }} />{slot.label}</button>)}</div>
          <Suspense fallback={<ChartFallback compact />}><MetricAbsoluteTrendChart points={analysisPoints} slot={selectedSlot} /></Suspense>
          <dl className={styles.metricAnalysisStats}>
            <div><dt>均值</dt><dd>{selectedProfile.average === null ? "—" : selectedProfile.average.toFixed(selectedSlot.precision)}<small>{selectedSlot.unit}</small></dd></div>
            <div><dt>最小</dt><dd>{selectedProfile.min === null ? "—" : selectedProfile.min.toFixed(selectedSlot.precision)}<small>{selectedSlot.unit}</small></dd></div>
            <div><dt>最大</dt><dd>{selectedProfile.max === null ? "—" : selectedProfile.max.toFixed(selectedSlot.precision)}<small>{selectedSlot.unit}</small></dd></div>
            <div><dt>变化量</dt><dd>{selectedProfile.delta === null ? "—" : `${selectedProfile.delta >= 0 ? "+" : ""}${selectedProfile.delta.toFixed(selectedSlot.precision)}`}<small>{selectedSlot.unit}</small></dd></div>
            <div><dt>异常点</dt><dd>{anomalyCount}<small> 个</small></dd></div>
            <div><dt>数据缺口</dt><dd>{gapCount}<small> 个</small></dd></div>
          </dl>
        </article>

        <article className={`${styles.card} ${styles.aiBriefCard}`} data-ai-region="ai-analysis" data-ai-label="AI 分析建议">
          <header className={styles.cardHeader}><div><h2>AI 分析建议</h2><span>先识别问题，再生成对应建议</span></div><button type="button" className={styles.generateAiButton} onClick={onGenerateAi} disabled={brief?.status === "loading"}><Sparkles size={15} />{brief?.status === "loading" ? "分析中" : "开始 AI 分析"}</button></header>
          {brief?.phase && <AnalysisProgress phase={brief.phase} />}
          <div className={styles.briefContent}>
            {brief?.status === "ready" && analysis && <>
              <div className={styles.briefHeadline}><strong>{analysis.headline}</strong><time>生成于 {formatTime(analysis.generatedAt)}</time></div>
              <div className={styles.briefBasis}><span>覆盖率 {(analysis.basis.coverage * 100).toFixed(0)}%</span><span>可信度 {qualityLabel}</span><span>{analysis.basis.uniqueObservations} 次独立上报</span></div>
            </>}
            <section className={`${styles.briefSection} ${styles.briefProblemStage}`} data-ai-region="ai-problems" data-ai-label="问题描述" aria-labelledby="ai-problem-heading">
              <header className={styles.briefStageHeader}><span aria-hidden="true">1</span><h3 id="ai-problem-heading">问题描述</h3></header>
              {brief?.status === "ready" && analysis
                ? analysis.findings.length > 0 ? analysis.findings.slice(0, 3).map((finding) => {
                  const evidence = factSlotIds(analysis, finding.factIds);
                  return <article key={finding.id}><div><strong>{finding.title}</strong><p>{finding.summary}</p></div><button type="button" onClick={() => onShowEvidence(evidence)} disabled={evidence.length === 0}>查看证据</button></article>;
                }) : <p className={styles.briefEmptyStage}>当前区间未识别出明确问题。</p>
                : <p className={styles.briefEmptyStage}>
                    {brief?.status === "loading"
                      ? "正在识别问题，请稍候。"
                      : brief?.status === "error"
                        ? `问题描述暂不可用：${brief.error ?? "AI 分析失败。"}`
                        : "尚未生成问题描述，请先点击“开始 AI 分析”。"}
                  </p>}
            </section>
            <section className={`${styles.briefSection} ${styles.briefRecommendationStage}`} data-ai-region="ai-recommendations" data-ai-label="处理建议" aria-labelledby="ai-recommendation-heading">
              <header className={styles.briefStageHeader}><span aria-hidden="true">2</span><h3 id="ai-recommendation-heading">处理建议</h3></header>
              {brief?.status === "ready" && analysis
                ? analysis.recommendations.length > 0 ? analysis.recommendations.slice(0, 3).map((recommendation) => <article key={recommendation.id}><div><strong>{recommendation.title}</strong><p>{recommendation.rationale}</p></div><button type="button" onClick={() => onShowEvidence(recommendation.relatedSlotIds)} disabled={recommendation.relatedSlotIds.length === 0}>查看依据</button></article>) : <p className={styles.briefEmptyStage}>当前没有需要追加的处理建议。</p>
                : <p className={styles.briefEmptyStage}>
                    {brief?.status === "loading"
                      ? "正在根据问题整理处理建议，请稍候。"
                      : brief?.status === "error"
                        ? `处理建议暂不可用：${brief.error ?? "AI 分析失败。"}`
                        : "尚未生成处理建议，请先完成 AI 分析。"}
                  </p>}
            </section>
            {brief?.status === "ready" && analysis && analysis.caveats.length > 0 && <p className={styles.briefCaveat}>{`${analysis.caveats.map((item) => item.replace(/[。；]+$/u, "")).join("；")}。`}</p>}
          </div>
        </article>
      </section>

      <SpatialDistributionPanel
        slots={slots}
        selectedSlotId={selectedSlot.slotId}
        onViewTrend={onViewTrend}
      />

      <article className={`${styles.card} ${styles.profileCard}`} data-ai-region="range-profile">
        <header className={styles.cardHeader}><div><h2>范围画像</h2><span>所选范围的最低、平均和最高读数</span></div></header>
        <div className={styles.profileGrid}>{profiles.map(({ slot, min, max, average, sampleCount }) => {
          const averagePosition = average === null || min === null || max === null || max === min
            ? 50
            : Math.max(0, Math.min(100, ((average - min) / (max - min)) * 100));
          return <section key={slot.slotId} className={styles.profileItem}>
            <header><span style={{ color: SLOT_COLORS[slot.slotId] }}>{(() => { const Icon = SLOT_ICONS[slot.slotId]; return <Icon size={16} />; })()}</span><strong>{slot.label}</strong><small>{sampleCount} 点</small></header>
            {average === null || min === null || max === null ? <p>暂无有效样本</p> : <>
              <div className={styles.profileRange} aria-label={`${slot.label} 最小值到最大值范围，均值位于范围的 ${averagePosition.toFixed(0)}%`}>
                <span style={{ backgroundColor: SLOT_COLORS[slot.slotId] }} />
                <i style={{ left: `${averagePosition}%`, borderColor: SLOT_COLORS[slot.slotId] }} />
              </div>
              <dl><div><dt>最低</dt><dd>{min.toFixed(slot.precision)}</dd></div><div><dt>均值</dt><dd>{average.toFixed(slot.precision)}</dd></div><div><dt>最高</dt><dd>{max.toFixed(slot.precision)}</dd></div></dl>
            </>}
            <footer>{slot.unit || "无单位"}</footer>
          </section>;
        })}</div>
      </article>

      <section className={styles.analysisBottomGrid}>
        <article className={`${styles.card} ${styles.matrixCard}`} data-ai-region="correlation-matrix">
          <header className={styles.cardHeader}><div><h2>相关矩阵</h2><span>Pearson r · 至少 12 组同刻样本；常量序列显示“—”</span></div></header>
          <div className={styles.matrixScroll}>
            <table aria-label="遥测指标相关系数矩阵">
              <thead><tr><th aria-label="指标" />{slots.map((slot) => <th key={slot.slotId} title={slot.label}>{slot.slotId.replace("slot-", "S")}</th>)}</tr></thead>
              <tbody>{slots.map((row) => <tr key={row.slotId}><th title={row.label}>{row.slotId.replace("slot-", "S")}</th>{slots.map((column) => {
                const correlation = pearson(analysisPoints, row.slotId, column.slotId);
                const intensity = correlation === null ? 0 : Math.abs(correlation);
                return <td key={column.slotId} title={`${row.label} × ${column.label}；相关不代表因果`} style={{ backgroundColor: correlation === null ? "#f4f7fb" : correlation >= 0 ? `rgb(47 118 246 / ${0.08 + intensity * 0.3})` : `rgb(239 75 53 / ${0.08 + intensity * 0.28})` }}>{correlation === null ? "—" : correlation.toFixed(2)}</td>;
              })}</tr>)}</tbody>
            </table>
          </div>
          <p className={styles.matrixNote}>相关仅描述同刻线性共同变化，不代表因果关系。</p>
        </article>

        <article className={`${styles.card} ${styles.heatmapCard}`} data-ai-region="daily-heatmap">
          <header className={styles.cardHeader}><div><h2>日内相对热力</h2><span>颜色表示各指标相对自身近期基线的变化</span></div></header>
          <Suspense fallback={<ChartFallback />}><IntradayHeatmap points={analysisPoints} slots={slots} /></Suspense>
        </article>
      </section>
    </div>
  );
}

function HistoryView({ points, slots, backendData, range, onRangeChange }: { points: SessionTelemetryPoint[]; slots: TelemetrySlot[]; backendData?: MonitoringBackendData; range: TelemetryHistoryRange; onRangeChange: (range: TelemetryHistoryRange) => void }) {
  const history = backendData?.history;
  const result = history?.result;
  const usingBackend = history?.status === "ready";
  const rows = usingBackend ? history.points : points;
  return (
    <article className={`${styles.card} ${styles.historyCard}`} data-ai-region="history-table">
      <header className={styles.cardHeader}>
        <div><h2>历史观测表</h2><span>所选范围内的环境读数</span></div>
        <div className={styles.cardActionGroup}>
          <span className={styles.sourceBadge}>{usingBackend ? "历史数据" : "本次会话"}</span>
          <button type="button" onClick={() => downloadSessionCsv(rows, slots)} disabled={rows.length === 0}><Download size={14} />导出 CSV</button>
        </div>
      </header>
      <RangeSelector range={range} onChange={onRangeChange} />
      {history?.status === "error" && <InlineError message={history.error ?? "历史数据读取失败"} />}
      {result && <>
        <section className={styles.historySummary} aria-label="历史区间统计">
          <div><span>独立上报</span><strong>{result.uniqueObservations}</strong></div>
          <div><span>覆盖率</span><strong>{(result.coverage * 100).toFixed(0)}%</strong></div>
          <div><span>有效指标</span><strong>{result.series.filter((series) => series.summary.sampleCount > 0).length}<small> / {slots.length}</small></strong></div>
          <div><span>聚合粒度</span><strong>{result.resolution}</strong></div>
        </section>
        {result.capturedFrom && <p className={styles.capturedNotice}><Clock3 size={14} />记录器从 {new Date(result.capturedFrom).toLocaleString("zh-CN", { hour12: false })} 开始采集；更早区间可能无数据。</p>}
      </>}
      {rows.length === 0 ? <EmptyState icon={History} title="暂无历史记录" detail="此时间范围内暂未收到数据。" action={<TransitionLink className={styles.primaryLink} href="/integrations">查看连接状态</TransitionLink>} /> : (
        <div className={styles.tableScroll}>
          <table>
            <thead><tr><th>设备观测时间</th>{slots.map((slot) => <th key={slot.slotId}>{slot.label}<small>{slot.unit ? ` (${slot.unit})` : ""}</small></th>)}</tr></thead>
            <tbody>{[...rows].reverse().map((point) => <tr key={point.at}><td><time dateTime={point.at}>{new Date(point.at).toLocaleString("zh-CN", { hour12: false })}</time></td>{slots.map((slot) => <td key={slot.slotId} className={styles.numeric}>{typeof point.values[slot.slotId] === "number" ? point.values[slot.slotId]?.toFixed(slot.precision) : "—"}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function EventsView({ events, backendData }: { events: SessionTelemetryEvent[]; backendData?: MonitoringBackendData }) {
  const backendEvents = backendData?.events;
  const usingBackend = backendEvents?.status === "ready";
  const items = usingBackend ? backendEvents.items : events;
  return (
    <article className={`${styles.card} ${styles.timelineCard}`} data-ai-region="event-timeline">
      <header className={styles.cardHeader}><div><h2>事件时间线</h2><span>所选范围内的状态变化与提醒</span></div><TransitionLink href="/alerts" className={styles.sourceBadge}>进入告警管理</TransitionLink></header>
      {backendEvents?.status === "error" && <InlineError message={backendEvents.error ?? "事件记录读取失败"} />}
      {items.length === 0 ? <EmptyState icon={Rows3} title="暂无事件" detail="此时间范围内没有状态变化或提醒。" /> : (
        <ol className={styles.eventTimeline}>{items.map((event) => (
          <li key={event.id} className={styles[`event_${event.severity}`]}>
            <span className={styles.timelineMarker}>{event.severity === "info" ? <CircleCheck size={17} /> : <CircleAlert size={17} />}</span>
            <div><header><strong>{event.title}</strong><span>{event.kind === "error" ? "数据异常" : "状态变化"}</span></header><p>{event.detail}</p></div>
            <time dateTime={event.at}>{new Date(event.at).toLocaleString("zh-CN", { hour12: false })}</time>
          </li>
        ))}</ol>
      )}
    </article>
  );
}

export function MonitoringPage({ backendData }: { backendData?: MonitoringBackendData } = {}) {
  const { snapshot, isRefreshing, refreshError, refresh } = useIotDashboard();
  const { telemetryAnalytics, requestTelemetryHistory, requestTelemetryEvents, requestTelemetryAnalysis, showTelemetryEvidence } = useAiControl();
  const { points, events, clear } = useSessionTelemetry(snapshot, 720);
  const { value: tab, direction: tabDirection, select: selectTab } = useDirectionalSelection(MONITOR_TAB_ORDER, "live");
  const [paused, setPaused] = useState(false);
  const [frozenPoints, setFrozenPoints] = useState<SessionTelemetryPoint[]>([]);
  const [frozenSlots, setFrozenSlots] = useState<TelemetrySlot[]>([]);
  const [visibleSlots, setVisibleSlots] = useState<TelemetrySlotId[]>([...TELEMETRY_SLOT_IDS]);
  const [historyRange, setHistoryRange] = useState<TelemetryHistoryRange>("24h");
  const [aiRequestedRange, setAiRequestedRange] = useState<TelemetryHistoryRange | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<TelemetrySlotId>(TELEMETRY_SLOT_IDS[0]);
  const pendingActionRef = useRef<AgentActionDispatchDetail | null>(null);
  const slots = useMemo(() => TELEMETRY_SLOT_IDS.map((slotId) => snapshot.slots[slotId]), [snapshot.slots]);
  const displayedPoints = paused ? frozenPoints : points;
  const displayedSlots = paused && frozenSlots.length > 0 ? frozenSlots : slots;
  const selectedSlot = displayedSlots.find((slot) => slot.slotId === selectedSlotId) ?? snapshot.slots[selectedSlotId];
  const contextBackendData = useMemo<MonitoringBackendData>(() => ({
    history: {
      status: telemetryAnalytics.historyPhase,
      points: historyResultToPoints(telemetryAnalytics.history),
      result: telemetryAnalytics.history ?? undefined,
      error: telemetryAnalytics.historyError ?? undefined,
    },
    events: {
      status: telemetryAnalytics.eventsPhase,
      items: eventResultToItems(telemetryAnalytics.events),
      result: telemetryAnalytics.events ?? undefined,
      error: telemetryAnalytics.eventsError ?? undefined,
    },
    aiBrief: {
      status: telemetryAnalytics.analysisPhase === "ready" ? "ready" : telemetryAnalytics.analysisPhase === "error" ? "error" : telemetryAnalytics.analysisPhase === "idle" ? "idle" : "loading",
      phase: telemetryAnalytics.analysisPhase,
      result: telemetryAnalytics.analysis ?? undefined,
      error: telemetryAnalytics.analysisError ?? (telemetryAnalytics.analysis?.caveats.join("；") || undefined),
    },
  }), [telemetryAnalytics]);
  const resolvedBackendData = backendData ?? contextBackendData;

  const requestTabData = useCallback((nextTab: MonitorTab, range: TelemetryHistoryRange = historyRange) => {
    if (nextTab === "live") return;
    const to = new Date();
    const from = new Date(to.getTime() - HISTORY_RANGE_MS[range]);
    const queryWindow = { from: from.toISOString(), to: to.toISOString() };
    if (nextTab === "history" || nextTab === "analysis") requestTelemetryHistory({ ...queryWindow, slotIds: [...TELEMETRY_SLOT_IDS], resolution: range === "1h" ? "raw" : range === "24h" ? "5m" : "1h" });
    if (nextTab === "events" || nextTab === "analysis") requestTelemetryEvents({ ...queryWindow, slotIds: [...TELEMETRY_SLOT_IDS] });
  }, [historyRange, requestTelemetryEvents, requestTelemetryHistory]);

  const chooseTab = useCallback((nextTab: MonitorTab) => {
    selectTab(nextTab);
    requestTabData(nextTab);
  }, [requestTabData, selectTab]);

  const changeRange = useCallback((range: TelemetryHistoryRange) => {
    setHistoryRange(range);
    setAiRequestedRange(null);
    requestTabData(tab === "analysis" ? "analysis" : "history", range);
  }, [requestTabData, tab]);

  const generateAiAdvice = useCallback((slotIds: TelemetrySlotId[] = [...TELEMETRY_SLOT_IDS]) => {
    const to = new Date();
    const from = new Date(to.getTime() - HISTORY_RANGE_MS[historyRange]);
    setAiRequestedRange(historyRange);
    return requestTelemetryAnalysis({ from: from.toISOString(), to: to.toISOString(), slotIds });
  }, [historyRange, requestTelemetryAnalysis]);

  const setPausedState = useCallback((nextPaused: boolean) => {
    setPaused((current) => {
      if (current === nextPaused) return current;
      if (nextPaused) {
        setFrozenPoints(points);
        setFrozenSlots(slots.map((slot) => ({ ...slot })));
      }
      return nextPaused;
    });
  }, [points, slots]);

  const togglePaused = () => setPausedState(!paused);

  const clearSession = () => {
    clear();
    setFrozenPoints([]);
  };

  const viewSpatialTrend = useCallback((slotId: TelemetrySlotId) => {
    setSelectedSlotId(slotId);
    setVisibleSlots([slotId]);
    chooseTab("live");
    window.setTimeout(() => {
      document.querySelector<HTMLElement>('[data-ai-region="live-chart"]')?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 80);
  }, [chooseTab]);

  useEffect(() => {
    const handleAction = (event: Event) => {
      const action = readActionDispatchDetail(event);
      if (!action) return;
      if (action.name === "telemetry.focus") {
        if (selectedSlotId === action.arguments.slotId) {
          const target = document.querySelector<HTMLElement>(
            `[data-telemetry-slot="${action.arguments.slotId}"]`,
          );
          if (!target) {
            reportActionError(action, `未找到数据位 ${action.arguments.slotId} 的卡片。`);
            return;
          }
          target.focus({ preventScroll: false });
          reportActionSuccess(action, `已聚焦 ${action.arguments.slotId}。`);
          return;
        }
        pendingActionRef.current = action;
        setSelectedSlotId(action.arguments.slotId);
        return;
      }
      if (action.name === "monitoring.set_tab") {
        if (tab === action.arguments.tab) {
          reportActionSuccess(action, `监测页已位于 ${action.arguments.tab} 标签。`);
          return;
        }
        pendingActionRef.current = action;
        chooseTab(action.arguments.tab);
        return;
      }
      if (action.name === "monitoring.set_visible_series") {
        if (sameSlotList(visibleSlots, action.arguments.slotIds)) {
          reportActionSuccess(action, "实时曲线集合已符合要求。");
          return;
        }
        pendingActionRef.current = action;
        setVisibleSlots(action.arguments.slotIds);
        return;
      }
      if (action.name === "monitoring.set_series_visibility") {
        const alreadyVisible = visibleSlots.includes(action.arguments.slotId);
        if (alreadyVisible === action.arguments.visible) {
          reportActionSuccess(action, "曲线可见状态已符合要求。");
          return;
        }
        pendingActionRef.current = action;
        setVisibleSlots((current) => action.arguments.visible
          ? current.includes(action.arguments.slotId) ? current : [...current, action.arguments.slotId]
          : current.filter((slotId) => slotId !== action.arguments.slotId));
        return;
      }
      if (action.name === "monitoring.set_range") {
        if (historyRange === action.arguments.range) {
          reportActionSuccess(action, `分析范围已是 ${action.arguments.range}。`);
          return;
        }
        pendingActionRef.current = action;
        changeRange(action.arguments.range);
        return;
      }
      if (action.name === "monitoring.generate_analysis") {
        pendingActionRef.current = action;
        if (tab !== "analysis") chooseTab("analysis");
        const requestId = generateAiAdvice(
          action.arguments.slotIds?.length
            ? action.arguments.slotIds
            : [...TELEMETRY_SLOT_IDS],
        );
        if (!requestId) {
          pendingActionRef.current = null;
          reportActionError(action, "智能中枢未连接，无法提交监测分析。");
        }
        return;
      }
      if (action.name === "monitoring.set_paused") {
        if (paused === action.arguments.paused) {
          reportActionSuccess(action, action.arguments.paused ? "实时画面已冻结。" : "实时画面已恢复。");
          return;
        }
        pendingActionRef.current = action;
        setPausedState(action.arguments.paused);
        return;
      }
      if (action.name === "monitoring.refresh") {
        void refresh().then((ok) => {
          if (ok) reportActionSuccess(action, "监测数据已刷新。");
          else reportActionError(action, "监测数据刷新失败，请检查数据连接。");
        }).catch((error) => reportActionError(action, error, "监测数据刷新失败。"));
      }
    };
    window.addEventListener(AI_ACTION_EVENT, handleAction);
    const unregisterReceiver = registerActionReceiver([
      "telemetry.focus",
      "monitoring.set_tab",
      "monitoring.set_visible_series",
      "monitoring.set_series_visibility",
      "monitoring.set_range",
      "monitoring.generate_analysis",
      "monitoring.set_paused",
      "monitoring.refresh",
    ]);
    return () => {
      unregisterReceiver();
      window.removeEventListener(AI_ACTION_EVENT, handleAction);
    };
  }, [
    changeRange,
    chooseTab,
    generateAiAdvice,
    historyRange,
    paused,
    refresh,
    selectedSlotId,
    setPausedState,
    tab,
    visibleSlots,
  ]);

  useEffect(() => {
    const action = pendingActionRef.current;
    if (!action) return;
    if (action.name === "telemetry.focus" && selectedSlotId === action.arguments.slotId) {
      const target = document.querySelector<HTMLElement>(
        `[data-telemetry-slot="${action.arguments.slotId}"]`,
      );
      pendingActionRef.current = null;
      if (!target) {
        reportActionError(action, `未找到数据位 ${action.arguments.slotId} 的卡片。`);
        return;
      }
      target.focus({ preventScroll: false });
      reportActionSuccess(action, `已聚焦 ${action.arguments.slotId}。`);
      return;
    }
    if (action.name === "monitoring.set_tab" && tab === action.arguments.tab) {
      pendingActionRef.current = null;
      reportActionSuccess(action, `已切换到 ${action.arguments.tab} 标签。`);
      return;
    }
    if (
      action.name === "monitoring.set_visible_series"
      && sameSlotList(visibleSlots, action.arguments.slotIds)
    ) {
      pendingActionRef.current = null;
      reportActionSuccess(action, "实时曲线集合已更新。");
      return;
    }
    if (action.name === "monitoring.set_series_visibility") {
      const visible = visibleSlots.includes(action.arguments.slotId);
      if (visible === action.arguments.visible) {
        pendingActionRef.current = null;
        reportActionSuccess(action, "曲线可见状态已更新。");
        return;
      }
    }
    if (action.name === "monitoring.set_range" && historyRange === action.arguments.range) {
      pendingActionRef.current = null;
      reportActionSuccess(action, `分析范围已切换到 ${action.arguments.range}。`);
      return;
    }
    if (action.name === "monitoring.set_paused" && paused === action.arguments.paused) {
      pendingActionRef.current = null;
      reportActionSuccess(action, paused ? "实时画面已冻结。" : "实时画面已恢复。");
      return;
    }
    if (action.name === "monitoring.generate_analysis") {
      if (telemetryAnalytics.analysisPhase === "ready") {
        pendingActionRef.current = null;
        reportActionSuccess(action, "监测分析已生成。");
      } else if (telemetryAnalytics.analysisPhase === "error") {
        pendingActionRef.current = null;
        reportActionError(
          action,
          telemetryAnalytics.analysisError ?? "监测分析生成失败。",
        );
      }
    }
  }, [
    historyRange,
    paused,
    selectedSlotId,
    tab,
    telemetryAnalytics.analysisError,
    telemetryAnalytics.analysisPhase,
    visibleSlots,
  ]);

  return (
    <div className={styles.pageSurface}>
      <div className={styles.pageActionBar}>
        <span className={styles.liveIndicator}><i aria-hidden="true" />{paused ? `已冻结于 ${formatTime(frozenPoints.at(-1)?.at ?? null)}` : "实时采集"}</span>
        <button className={styles.headerButton} type="button" onClick={togglePaused} aria-pressed={paused} title={paused ? "恢复实时画面" : "冻结当前画面"}><span>{paused ? "恢复实时" : "冻结画面"}</span>{paused ? <Play size={15} /> : <Pause size={15} />}</button>
        <button className={styles.headerButton} type="button" onClick={() => void refresh()} disabled={isRefreshing} title="刷新数据"><RefreshCw size={15} className={isRefreshing ? styles.spinning : undefined} /><span>刷新数据</span></button>
      </div>
      {refreshError && <InlineError message={refreshError} retry={() => void refresh()} />}

      <section className={styles.monitorMetricGrid} data-ai-region="metric-cards" aria-label={`${displayedSlots.length} 路实时数据`}>
        {displayedSlots.map((slot) => <button type="button" key={slot.slotId} data-telemetry-slot={slot.slotId} className={selectedSlotId === slot.slotId ? styles.metricSelected : undefined} onClick={() => setSelectedSlotId(slot.slotId)}><MetricCard slot={slot} points={displayedPoints} /></button>)}
      </section>

      <SlidingTabs items={MONITOR_TABS} value={tab} onChange={chooseTab} ariaLabel="监测视图" idBase="monitor-view" />

      <DirectionalPanel activeKey={tab} direction={tabDirection} idBase="monitor-view">
        {tab === "live" ? (
          <section className={styles.monitorLayout}>
            <article className={`${styles.card} ${styles.largeChartCard}`} data-ai-region="live-chart">
              <header className={styles.cardHeader}>
                <div><h2>本次会话曲线</h2><span>设备观测时间 · 自动去除重复上报</span></div>
                <div className={styles.cardActionGroup}>
                  <button type="button" onClick={clearSession} disabled={points.length === 0}><Eraser size={14} />清空会话</button>
                  <button type="button" onClick={() => downloadSessionCsv(displayedPoints, displayedSlots)} disabled={displayedPoints.length === 0}><Download size={14} />导出 CSV</button>
                </div>
              </header>
              <div className={styles.chartToolbar}>
                <div className={styles.chartLegend} aria-label="趋势序列开关">
                  {displayedSlots.map((slot) => {
                    const Icon = SLOT_ICONS[slot.slotId];
                    const active = visibleSlots.includes(slot.slotId);
                    return <button key={slot.slotId} type="button" className={active ? styles.legendActive : undefined} aria-pressed={active} onClick={() => setVisibleSlots((current) => active ? current.filter((id) => id !== slot.slotId) : [...current, slot.slotId])}><Icon size={13} style={{ color: SLOT_COLORS[slot.slotId] }} />{slot.label}</button>;
                  })}
                </div>
                <span className={styles.sessionBadge}>{paused ? `画面已冻结 · ${displayedPoints.length} 个采样点` : `${points.length} 个采样点`}</span>
              </div>
              <Suspense fallback={<ChartFallback />}><TelemetryTrendChart points={displayedPoints} slots={displayedSlots} visibleSlots={visibleSlots} /></Suspense>
            </article>

            <aside className={`${styles.card} ${styles.slotInspector}`} data-ai-region="slot-details">
              <header><span className={styles.inspectorIcon}>{(() => { const Icon = SLOT_ICONS[selectedSlotId]; return <Icon size={20} />; })()}</span><div><h2>{selectedSlot.label}</h2></div><StatusPill state={selectedSlot.state} /></header>
              <div className={styles.inspectorReading}><strong><DataFade value={selectedSlot.value}>{formatMetric(selectedSlot)}</DataFade></strong><span>{selectedSlot.unit || "无单位"}</span></div>
              <dl>
                <div><dt>数据状态</dt><dd>{STATE_LABELS[selectedSlot.state]}</dd></div>
                <div><dt>观测时间</dt><dd>{formatTime(selectedSlot.observedAt)}</dd></div>
                <div><dt>会话样本</dt><dd>{valuesFor(displayedPoints, selectedSlotId).length} 个</dd></div>
                <div><dt>说明</dt><dd>{selectedSlot.supportingText}</dd></div>
              </dl>
              {selectedSlot.auxiliaryReadings.length > 0 && <section className={styles.auxiliaryReadings}><h3>辅助读数</h3>{selectedSlot.auxiliaryReadings.map((reading) => <div key={reading.sourceKey}><span>{reading.label}</span><strong>{reading.value === null ? "—" : reading.value.toFixed(reading.precision)}<small>{reading.unit}</small></strong></div>)}</section>}
              <TransitionLink href="/integrations">查看连接状态</TransitionLink>
            </aside>
          </section>
        ) : tab === "analysis" ? (
          <AnalysisView points={displayedPoints} slots={displayedSlots} backendData={resolvedBackendData} range={historyRange} aiRequestedRange={aiRequestedRange} selectedSlotId={selectedSlotId} onRangeChange={changeRange} onSelectSlot={setSelectedSlotId} onViewTrend={viewSpatialTrend} onGenerateAi={() => generateAiAdvice()} onShowEvidence={showTelemetryEvidence} />
        ) : tab === "history" ? (
          <HistoryView points={points} slots={slots} backendData={resolvedBackendData} range={historyRange} onRangeChange={changeRange} />
        ) : (
          <EventsView events={events} backendData={resolvedBackendData} />
        )}
      </DirectionalPanel>
    </div>
  );
}
