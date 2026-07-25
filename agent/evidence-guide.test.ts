import assert from "node:assert/strict";
import test from "node:test";
import {
  canBypassEvidenceBarrier,
  analysisMatchesCurrentHistory,
  describeEvidenceGuide,
  evidenceGuideConclusion,
  evidenceGuideDescriptors,
  isPresentationVisualAction,
  retainNonVisualQueuedActions,
} from "../app/lib/ai/evidence-guide";
import type { AgentAction, AgentPlan } from "../app/lib/ai/contracts";
import type { TelemetryAnalyticsState } from "../app/lib/iot/telemetry-history-contracts";

const basePlan: AgentPlan = {
  id: "plan-guide",
  summary: "查看温度变化证据",
  planningMode: "thinking",
  createdAt: "2026-07-20T00:00:00.000Z",
  steps: [
    { index: 1, label: "选择温度", action: { name: "monitoring.set_visible_series", arguments: { slotIds: ["slot-1"] } } },
    { index: 2, label: "查看指标态势", action: { name: "ui.focus_region", arguments: { page: "monitoring", region: "indicator-posture" } } },
    { index: 3, label: "查看日内热力", action: { name: "ui.focus_region", arguments: { page: "monitoring", region: "daily-heatmap" } } },
  ],
};

const analytics: TelemetryAnalyticsState = {
  historyPhase: "ready",
  historyError: null,
  history: {
    requestId: "history-1",
    from: "2026-07-19T00:00:00.000Z",
    to: "2026-07-20T00:00:00.000Z",
    capturedFrom: "2026-07-19T00:00:00.000Z",
    generatedAt: "2026-07-20T00:00:00.000Z",
    dataVersion: "v1",
    provider: "huawei-cloud",
    resolution: "1h",
    expectedIntervalMs: 10_000,
    uniqueObservations: 24,
    coverage: 0.75,
    series: [{
      slotId: "slot-1",
      sourceKey: "temperature",
      label: "环境温度",
      unit: "°C",
      precision: 1,
      buckets: [],
      summary: {
        minimum: 21.2,
        maximum: 25.8,
        average: 23.4,
        median: 23.3,
        delta: 1.6,
        slopePerHour: 0.1,
        volatility: 0.8,
        sampleCount: 24,
        completeness: 0.75,
        latestObservedAt: "2026-07-20T00:00:00.000Z",
      },
    }],
  },
  eventsPhase: "idle",
  events: null,
  eventsError: null,
  analysisPhase: "idle",
  analysis: null,
  analysisError: null,
};

test("evidence guide supports both single and multi-region tours and carries selected slots", () => {
  const descriptors = evidenceGuideDescriptors(basePlan);
  assert.equal(descriptors.length, 2);
  assert.deepEqual(descriptors.map((item) => item.title), ["指标态势", "日内相对热力"]);
  assert.deepEqual(descriptors[0].slotIds, ["slot-1"]);

  const single = evidenceGuideDescriptors({ ...basePlan, steps: basePlan.steps.slice(0, 2) });
  assert.equal(single.length, 1);
  assert.equal(single[0].position, 1);
  assert.equal(single[0].total, 1);
  assert.deepEqual(evidenceGuideDescriptors({ ...basePlan, steps: basePlan.steps.slice(0, 1) }), []);
});

test("evidence guide provides deterministic public chart facts", () => {
  const descriptor = evidenceGuideDescriptors(basePlan)[0];
  const result = describeEvidenceGuide(descriptor, basePlan, analytics);
  assert.equal(result.availability, "available");
  assert.match(result.explanation, /21\.2–25\.8°C/);
  assert.match(result.explanation, /覆盖率约 75%/);
  assert.match(evidenceGuideConclusion(basePlan, analytics, 2), /已完成 2 项证据导览/);
});

test("unavailable ranges become a user-facing diagnosis instead of an internal error", () => {
  const unavailablePlan: AgentPlan = {
    ...basePlan,
    dataAvailability: {
      status: "unavailable",
      code: "data-before-range",
      title: "所选时间早于现有记录",
      detail: "历史记录从 7 月 20 日开始。",
      requestedFrom: "2026-07-01T00:00:00.000Z",
      requestedTo: "2026-07-02T00:00:00.000Z",
      recordedFrom: "2026-07-20T00:00:00.000Z",
      recordedTo: "2026-07-20T01:00:00.000Z",
      sampleCount: 0,
      uniqueObservations: 0,
      requestedSlotIds: ["slot-1"],
      availableSlotIds: [],
      unavailableSlotIds: ["slot-1"],
      latestReport: { observedAt: null, state: "unknown", collector: "collecting" },
      suggestedRange: { from: "2026-07-20T00:00:00.000Z", to: "2026-07-20T01:00:00.000Z" },
    },
  };
  const descriptor = evidenceGuideDescriptors(unavailablePlan)[0];
  const result = describeEvidenceGuide(descriptor, unavailablePlan, analytics);
  assert.equal(result.availability, "unavailable");
  assert.match(result.explanation, /历史记录从 7 月 20 日开始/);
  assert.match(evidenceGuideConclusion(unavailablePlan, analytics, 1), /不能据此判断变化程度/);
});

test("guide barrier never classifies raw reads or vehicle safety actions as visual", () => {
  assert.equal(isPresentationVisualAction({ name: "monitoring.set_range", arguments: { range: "24h" } }), true);
  assert.equal(isPresentationVisualAction({ name: "ui.focus_region", arguments: { page: "monitoring", region: "daily-heatmap" } }), true);
  assert.equal(isPresentationVisualAction({ name: "telemetry.read_current", arguments: { slotId: "slot-1" } }), false);
  assert.equal(isPresentationVisualAction({ name: "vehicle.stop", arguments: {} }), false);
  assert.equal(isPresentationVisualAction({ name: "vehicle.confirm", arguments: {} }), false);
  assert.equal(isPresentationVisualAction({ name: "monitoring.generate_analysis", arguments: {} }), false);
  assert.equal(isPresentationVisualAction({ name: "connections.refresh", arguments: {} }), false);

  const queue: Array<{ action: AgentAction; id: string }> = [
    { action: { name: "ui.focus_region", arguments: { page: "monitoring", region: "daily-heatmap" } } as const, id: "visual" },
    { action: { name: "monitoring.generate_analysis", arguments: {} } as const, id: "analysis" },
    { action: { name: "vehicle.stop", arguments: {} } as const, id: "stop" },
    { action: { name: "vehicle.confirm", arguments: {} } as const, id: "confirm" },
  ];
  const retained = retainNonVisualQueuedActions(queue);
  assert.deepEqual(retained.map((item) => item.id), ["analysis", "stop", "confirm"]);

  assert.equal(canBypassEvidenceBarrier({ name: "telemetry.read_current", arguments: {} }), true);
  assert.equal(canBypassEvidenceBarrier({ name: "vehicle.stop", arguments: {} }), true);
  assert.equal(canBypassEvidenceBarrier({ name: "vehicle.confirm", arguments: {} }), true);
  assert.equal(canBypassEvidenceBarrier({ name: "vehicle.cancel", arguments: {} }), true);
  assert.equal(canBypassEvidenceBarrier({ name: "monitoring.generate_analysis", arguments: {} }), false);
  assert.equal(canBypassEvidenceBarrier({ name: "connections.refresh", arguments: {} }), false);
  assert.equal(canBypassEvidenceBarrier({ name: "settings.save", arguments: {} }), false);
});

test("guide waits for the current history request instead of reusing old statistics", () => {
  const descriptor = evidenceGuideDescriptors(basePlan)[0];
  const result = describeEvidenceGuide(descriptor, basePlan, {
    ...analytics,
    historyPhase: "loading",
    history: null,
  });
  assert.equal(result.availability, "loading");
  assert.match(result.explanation, /正在调取当前时间范围的数据/);
  assert.doesNotMatch(result.explanation, /21\.2–25\.8/);
});

test("guide never reuses an analysis from a different time range", () => {
  const stale = {
    ...analytics,
    analysisPhase: "ready" as const,
    analysis: {
      requestId: "analysis-old",
      status: "complete" as const,
      generatedAt: "2026-07-18T01:00:00.000Z",
      dataVersion: "old",
      basis: {
        provider: "huawei-cloud" as const,
        isDemo: false,
        windowStart: "2026-07-17T00:00:00.000Z",
        windowEnd: "2026-07-18T00:00:00.000Z",
        sampleCount: 20,
        uniqueObservations: 20,
        coverage: 1,
        quality: "high" as const,
      },
      headline: "不应出现的旧结论",
      facts: [],
      findings: [],
      recommendations: [],
      caveats: [],
    },
  };
  assert.equal(analysisMatchesCurrentHistory(stale), false);
  assert.doesNotMatch(evidenceGuideConclusion(basePlan, stale, 2), /不应出现的旧结论/);
});
