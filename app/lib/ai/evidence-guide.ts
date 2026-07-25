import type { AgentAction, AgentPlan, AgentPlanStep, UiPage } from "./contracts";
import type { TelemetrySlotId } from "@/app/lib/iot/contracts";
import type {
  TelemetryAnalyticsState,
  TelemetryAvailabilityDiagnostic,
  TelemetryHistorySeries,
} from "@/app/lib/iot/telemetry-history-contracts";

export type EvidenceGuidePhase = "presenting" | "advancing" | "complete";

export interface EvidenceGuideDescriptor {
  stepIndex: number;
  position: number;
  total: number;
  page: UiPage;
  region: string;
  title: string;
  slotIds: TelemetrySlotId[];
}

export interface EvidenceGuideState extends EvidenceGuideDescriptor {
  phase: EvidenceGuidePhase;
  availability: "loading" | "available" | "limited" | "unavailable";
  explanation: string;
  conclusion: string | null;
}

const DATA_EVIDENCE_TITLES: Readonly<Record<string, string>> = {
  "live-chart": "实时趋势",
  "slot-details": "指标详情",
  "analysis-summary": "分析概览",
  "indicator-posture": "指标态势",
  "ai-analysis": "AI 监测简报",
  "ai-problems": "问题描述",
  "ai-recommendations": "处理建议",
  "range-profile": "范围画像",
  "correlation-matrix": "相关性矩阵",
  "daily-heatmap": "日内相对热力",
  "spatial-distribution": "空间分布",
  "history-table": "历史数据",
  "event-timeline": "事件记录",
};

const REGION_PURPOSES: Readonly<Record<string, string>> = {
  "live-chart": "这张图用于观察连续变化、转折和短时波动。",
  "slot-details": "这里汇总当前指标的数值、单位、状态和采集时间。",
  "analysis-summary": "这里先概括当前范围的数据覆盖、上报次数和整体状态。",
  "indicator-posture": "这张图对比区间趋势、极值和波动幅度，适合判断变化大小。",
  "ai-analysis": "这里把可验证的数据事实整理为问题描述和处理建议。",
  "ai-problems": "这里仅列出数据能够支持的问题与异常现象。",
  "ai-recommendations": "这里给出与前述证据对应的处理建议。",
  "range-profile": "这张图对比各指标的最小值、平均值和最大值。",
  "correlation-matrix": "这张图展示指标同步变化的相关程度，相关不代表因果。",
  "daily-heatmap": "这张图按小时展示相对近期基线的变化，适合定位波动明显的时段。",
  "spatial-distribution": "这张图把传感器读数放回房间位置，观察空间差异。",
  "history-table": "这里提供可核对的历史采样明细和区间统计。",
  "event-timeline": "这里按时间排列断流、恢复和异常波动等数据事件。",
};

/** Only evidence-rich regions participate; current-value cards remain immediate. */
export function evidenceGuideDescriptors(plan: AgentPlan): EvidenceGuideDescriptor[] {
  const focusSteps = plan.steps.filter(isGuidedEvidenceStep);
  if (focusSteps.length < 1) return [];

  return focusSteps.map((step, index) => ({
    stepIndex: step.index,
    position: index + 1,
    total: focusSteps.length,
    page: step.action.arguments.page,
    region: step.action.arguments.region,
    title: DATA_EVIDENCE_TITLES[step.action.arguments.region] ?? "数据证据",
    slotIds: slotIdsBeforeStep(plan.steps, step.index),
  }));
}

export function describeEvidenceGuide(
  descriptor: EvidenceGuideDescriptor,
  plan: AgentPlan,
  analytics: TelemetryAnalyticsState,
): Omit<EvidenceGuideState, keyof EvidenceGuideDescriptor | "phase" | "conclusion"> {
  if (["ai-analysis", "ai-problems", "ai-recommendations"].includes(descriptor.region)
    && ["loading-data", "calculating", "analyzing", "organizing"].includes(analytics.analysisPhase)) {
    return {
      availability: "loading",
      explanation: "正在结合当前区间的数据生成分析，完成后会在这里呈现可核对的问题或建议。",
    };
  }
  if (analytics.historyPhase === "loading") {
    return {
      availability: "loading",
      explanation: "正在调取当前时间范围的数据，完成后会在这里给出这张图的分析。",
    };
  }

  const diagnostic = preferredDiagnostic(plan, analytics);
  if (diagnostic && diagnostic.status !== "available") {
    return {
      availability: diagnostic.status,
      explanation: `${diagnostic.title}。${diagnostic.detail}`,
    };
  }

  const structuredAnalysis = describeStructuredAnalysis(descriptor, analytics);
  if (structuredAnalysis) {
    return {
      availability: analytics.analysisPhase === "error" ? "limited" : "available",
      explanation: `${REGION_PURPOSES[descriptor.region] ?? "这里展示与问题直接相关的数据证据。"}${structuredAnalysis}`,
    };
  }

  const series = relevantSeries(analytics, descriptor.slotIds);
  const statisticalSummary = describeSeries(series, analytics.history?.coverage);
  const regionInsight = describeRegionInsight(descriptor.region, series, analytics);
  return {
    availability: diagnostic?.status ?? (statisticalSummary ? "available" : "limited"),
    explanation: statisticalSummary
      ? `${REGION_PURPOSES[descriptor.region] ?? "这里展示与问题直接相关的数据证据。"}${regionInsight}${statisticalSummary}`
      : `${REGION_PURPOSES[descriptor.region] ?? "这里展示与问题直接相关的数据证据。"}当前图表尚未形成足够的区间样本，可继续查看其他证据。`,
  };
}

const GUIDE_PAUSE_BYPASS_NAMES = new Set<AgentAction["name"]>([
  "vehicle.stop",
  "vehicle.cancel",
  "vehicle.confirm",
  "telemetry.read_current",
]);

/** Only time-critical safety/current-value actions may cross an evidence pause. */
export function canBypassEvidenceBarrier(action: AgentAction) {
  return GUIDE_PAUSE_BYPASS_NAMES.has(action.name);
}

export function evidenceGuideConclusion(
  plan: AgentPlan,
  analytics: TelemetryAnalyticsState,
  visitedCount: number,
) {
  const diagnostic = preferredDiagnostic(plan, analytics);
  if (diagnostic && diagnostic.status !== "available") {
    const rangeHint = diagnostic.suggestedRange
      ? "可以切换到系统建议的有记录时间段后再次查看。"
      : "可以先继续采集数据，再重新分析该时间范围。";
    return `已查看 ${visitedCount} 项证据。${diagnostic.title}，当前不能据此判断变化程度；${rangeHint}`;
  }

  const analysis = currentAnalysis(analytics);
  if (analysis?.headline) {
    const finding = analysis.findings[0];
    const recommendation = analysis.recommendations[0];
    return [
      `已完成 ${visitedCount} 项证据导览。${analysis.headline}。`,
      finding ? `${finding.title}：${finding.summary}` : "",
      recommendation ? `建议：${recommendation.title}，${recommendation.rationale}` : "",
    ].filter(Boolean).join(" ");
  }

  const available = analytics.history?.series.filter((series) => series.summary.sampleCount > 0) ?? [];
  if (!available.length) {
    return `已查看 ${visitedCount} 项证据。当前范围内可用于比较的样本仍然有限，暂不对变化大小作确定结论。`;
  }
  if (available.length === 1) {
    const summary = describeSeries(available, analytics.history?.coverage);
    return `已完成 ${visitedCount} 项证据导览。${summary || "请结合图表中的区间变化和数据覆盖情况判断。"}`;
  }
  return `已完成 ${visitedCount} 项证据导览。当前有 ${available.length} 个指标具备有效区间样本，请结合趋势、波动和覆盖率综合判断。`;
}

export function isPresentationVisualAction(action: AgentAction) {
  return action.name === "ui.navigate"
    || action.name === "ui.back"
    || action.name === "ui.focus_region"
    || action.name === "ui.scroll"
    || action.name === "telemetry.focus"
    || action.name === "monitoring.set_tab"
    || action.name === "monitoring.set_visible_series"
    || action.name === "monitoring.set_series_visibility"
    || action.name === "monitoring.set_range"
    || action.name.startsWith("twin.")
    || action.name.startsWith("spatial.")
    || action.name === "settings.set_section";
}

export function retainNonVisualQueuedActions<T extends { action: AgentAction }>(queue: readonly T[]) {
  return queue.filter((item) => !isPresentationVisualAction(item.action));
}

function isGuidedEvidenceStep(step: AgentPlanStep): step is AgentPlanStep & {
  action: Extract<AgentAction, { name: "ui.focus_region" }>;
} {
  return step.action.name === "ui.focus_region"
    && step.action.arguments.page === "monitoring"
    && Object.hasOwn(DATA_EVIDENCE_TITLES, step.action.arguments.region);
}

function slotIdsBeforeStep(steps: AgentPlanStep[], stepIndex: number) {
  let slotIds: TelemetrySlotId[] = [];
  for (const step of steps) {
    if (step.index > stepIndex) break;
    if (step.action.name === "monitoring.set_visible_series") slotIds = step.action.arguments.slotIds;
    if (step.action.name === "telemetry.focus") slotIds = [step.action.arguments.slotId];
    if (step.action.name === "monitoring.generate_analysis" && step.action.arguments.slotIds?.length) {
      slotIds = step.action.arguments.slotIds;
    }
  }
  return [...new Set(slotIds)];
}

function preferredDiagnostic(plan: AgentPlan, analytics: TelemetryAnalyticsState) {
  return plan.dataAvailability
    ?? analytics.history?.availability
    ?? currentAnalysis(analytics)?.availability
    ?? null;
}

function relevantSeries(analytics: TelemetryAnalyticsState, slotIds: TelemetrySlotId[]) {
  const all = analytics.history?.series ?? [];
  if (!slotIds.length) return all.filter((series) => series.summary.sampleCount > 0);
  const selected = new Set(slotIds);
  return all.filter((series) => selected.has(series.slotId) && series.summary.sampleCount > 0);
}

function describeSeries(series: TelemetryHistorySeries[], coverage: number | undefined) {
  if (!series.length) return "";
  if (series.length > 1) {
    const summaries = series.slice(0, 3).flatMap((item) => {
      const summary = item.summary;
      if (summary.minimum === null || summary.maximum === null) return [];
      const precision = Math.max(0, Math.min(4, item.precision));
      const delta = summary.delta === null ? "" : `，变化 ${signed(summary.delta, precision)}${item.unit}`;
      return [`${item.label} ${summary.minimum.toFixed(precision)}–${summary.maximum.toFixed(precision)}${item.unit}${delta}`];
    });
    const coverageText = coverage === undefined ? "" : `，数据覆盖率约 ${Math.round(coverage * 100)}%`;
    return summaries.length
      ? `当前区间：${summaries.join("；")}${coverageText}。`
      : `当前 ${series.length} 个指标已形成区间样本${coverageText}。`;
  }

  const item = series[0];
  const summary = item.summary;
  const precision = Math.max(0, Math.min(4, item.precision));
  if (summary.minimum === null || summary.maximum === null) return "";
  const range = `${summary.minimum.toFixed(precision)}–${summary.maximum.toFixed(precision)}${item.unit}`;
  const delta = summary.delta === null
    ? ""
    : `，区间变化 ${signed(summary.delta, precision)}${item.unit}`;
  const volatility = summary.volatility === null
    ? ""
    : `，波动量 ${summary.volatility.toFixed(precision)}${item.unit}`;
  const coverageText = coverage === undefined ? "" : `，覆盖率约 ${Math.round(coverage * 100)}%`;
  return `${item.label}在当前范围为 ${range}${delta}${volatility}${coverageText}。`;
}

function describeStructuredAnalysis(descriptor: EvidenceGuideDescriptor, analytics: TelemetryAnalyticsState) {
  const result = currentAnalysis(analytics);
  if (analytics.analysis && !result && ["ai-analysis", "ai-problems", "ai-recommendations"].includes(descriptor.region)) {
    return "当前时间范围尚未生成匹配的分析，请重新生成后再查看。";
  }
  if (descriptor.region === "ai-analysis") {
    if (result?.headline) return result.headline;
    if (analytics.analysisPhase === "error") return analytics.analysisError ?? "本次 AI 分析未能完成。";
    return "";
  }
  if (descriptor.region === "ai-problems") {
    if (result?.findings.length) {
      return result.findings.slice(0, 2).map((item) => `${item.title}：${item.summary}`).join("；");
    }
    if (result?.status === "complete") return "当前分析没有形成需要单独列出的关注项。";
    if (analytics.analysisPhase === "error") return analytics.analysisError ?? "问题分析暂时不可用。";
    return "";
  }
  if (descriptor.region === "ai-recommendations") {
    if (result?.recommendations.length) {
      return result.recommendations.slice(0, 2).map((item) => `${item.title}：${item.rationale}`).join("；");
    }
    if (result?.status === "complete") return "当前证据没有形成需要执行的额外建议。";
    if (analytics.analysisPhase === "error") return analytics.analysisError ?? "建议生成暂时不可用。";
  }
  return "";
}

function describeRegionInsight(
  region: string,
  series: TelemetryHistorySeries[],
  analytics: TelemetryAnalyticsState,
) {
  if (region === "daily-heatmap") {
    const strongest = strongestBucketChange(series);
    return strongest
      ? `${strongest.label}在 ${strongest.time} 附近出现相邻时间段最大变化 ${strongest.delta}。`
      : "";
  }
  if (region === "correlation-matrix") {
    const selected = new Set(series.map((item) => item.slotId));
    const fact = currentAnalysis(analytics)?.facts.find((item) => (
      item.kind === "co-movement" && item.slotIds.filter((slotId) => selected.has(slotId)).length >= 2
    ));
    return fact ? `${fact.statement}。` : "";
  }
  return "";
}

export function analysisMatchesCurrentHistory(analytics: TelemetryAnalyticsState) {
  if (!analytics.analysis) return false;
  if (!analytics.history) return true;
  const historyFrom = Date.parse(analytics.history.from);
  const historyTo = Date.parse(analytics.history.to);
  const analysisFrom = Date.parse(analytics.analysis.basis.windowStart);
  const analysisTo = Date.parse(analytics.analysis.basis.windowEnd);
  if ([historyFrom, historyTo, analysisFrom, analysisTo].some(Number.isNaN)) return false;
  const toleranceMs = 5 * 60 * 1000;
  return Math.abs(historyFrom - analysisFrom) <= toleranceMs
    && Math.abs(historyTo - analysisTo) <= toleranceMs;
}

function currentAnalysis(analytics: TelemetryAnalyticsState) {
  return analysisMatchesCurrentHistory(analytics) ? analytics.analysis : null;
}

function strongestBucketChange(series: TelemetryHistorySeries[]) {
  let strongest: { label: string; time: string; delta: string; magnitude: number } | null = null;
  for (const item of series) {
    for (let index = 1; index < item.buckets.length; index += 1) {
      const previous = item.buckets[index - 1];
      const current = item.buckets[index];
      const difference = current.average - previous.average;
      const magnitude = Math.abs(difference);
      if (!strongest || magnitude > strongest.magnitude) {
        const precision = Math.max(0, Math.min(4, item.precision));
        strongest = {
          label: item.label,
          time: formatGuideTime(current.startAt),
          delta: `${signed(difference, precision)}${item.unit}`,
          magnitude,
        };
      }
    }
  }
  return strongest;
}

function formatGuideTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "对应时段";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function signed(value: number, precision: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(precision)}`;
}

export function availabilityForGuide(
  plan: AgentPlan,
  analytics: TelemetryAnalyticsState,
): TelemetryAvailabilityDiagnostic | null {
  return preferredDiagnostic(plan, analytics);
}
