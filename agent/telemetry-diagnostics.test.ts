import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentAction } from "../app/lib/ai/contracts";
import type { TelemetrySlot } from "../app/lib/iot/contracts";
import type { DeepSeekDecision } from "./deepseek";
import {
  availabilityQueryForDecision,
  publicGatewayFailure,
} from "./gateway";
import {
  deterministicAnalysisForRequest,
  historyResultForRequest,
} from "./telemetry-contract-adapter";
import { diagnoseTelemetryAvailability } from "./telemetry-diagnostics";
import { TelemetryStore } from "./telemetry-store";

const BASE_MS = Date.parse("2026-07-20T00:00:00.000Z");

function temporaryStore() {
  const directory = mkdtempSync(join(tmpdir(), "xingxun-diagnostics-"));
  const store = new TelemetryStore({ path: join(directory, "history.sqlite") });
  return {
    store,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function slot(slotId: "slot-1" | "slot-2", value: number, at: number): TelemetrySlot {
  return {
    slotId,
    sourceKey: `Environment.${slotId}`,
    label: slotId === "slot-1" ? "环境温度" : "环境湿度",
    value,
    unit: slotId === "slot-1" ? "°C" : "%",
    precision: 1,
    tone: "blue",
    state: "live",
    observedAt: new Date(at).toISOString(),
    supportingText: "测试",
    auxiliaryReadings: [],
  };
}

test("无样本是可解释的数据状态，不会被伪装为协议错误", () => {
  const fixture = temporaryStore();
  try {
    const from = new Date(BASE_MS).toISOString();
    const to = new Date(BASE_MS + 60 * 60_000).toISOString();
    const diagnostic = diagnoseTelemetryAvailability(fixture.store, {
      from,
      to,
      slotIds: ["slot-1"],
    }, {
      slots: { "slot-1": { state: "offline", observedAt: null } },
      collector: {
        running: true,
        collecting: false,
        pollIntervalMs: 1_000,
        consecutiveFailures: 2,
        lastAttemptAt: to,
        lastSuccessAt: null,
        nextAttemptAt: null,
      },
    });
    assert.equal(diagnostic.status, "unavailable");
    assert.equal(diagnostic.code, "empty-store");
    assert.equal(diagnostic.latestReport.state, "offline");
    assert.equal(diagnostic.latestReport.collector, "retrying");
    assert.match(diagnostic.detail, /尚未形成历史记录/);
    assert.equal(diagnostic.detail.includes("SQL"), false);

    const history = historyResultForRequest(fixture.store, {
      requestId: "history-empty",
      from,
      to,
      slotIds: ["slot-1"],
    }, "huawei-cloud");
    assert.deepEqual(history.series, []);
    assert.equal(history.availability?.code, "empty-store");

    const analysis = deterministicAnalysisForRequest(fixture.store, {
      requestId: "analysis-empty",
      from,
      to,
      slotIds: ["slot-1"],
    }, "huawei-cloud");
    assert.equal(analysis.status, "insufficient-data");
    assert.equal(analysis.availability?.code, "empty-store");
    assert.equal(analysis.headline, "尚未记录到所选数据");
  } finally {
    fixture.cleanup();
  }
});

test("诊断区分记录早于查询、部分指标缺失与样本不足", () => {
  const fixture = temporaryStore();
  try {
    fixture.store.recordSlots({ "slot-1": slot("slot-1", 24, BASE_MS) }, "huawei-cloud", BASE_MS);
    const later = diagnoseTelemetryAvailability(fixture.store, {
      from: new Date(BASE_MS + 60 * 60_000).toISOString(),
      to: new Date(BASE_MS + 2 * 60 * 60_000).toISOString(),
      slotIds: ["slot-1"],
    });
    assert.equal(later.code, "data-before-range");
    assert.equal(later.suggestedRange?.to, new Date(BASE_MS).toISOString());

    fixture.store.recordSlots({ "slot-1": slot("slot-1", 25, BASE_MS + 2 * 60 * 60_000) }, "huawei-cloud", BASE_MS + 2 * 60 * 60_000);
    const gap = diagnoseTelemetryAvailability(fixture.store, {
      from: new Date(BASE_MS + 50 * 60_000).toISOString(),
      to: new Date(BASE_MS + 70 * 60_000).toISOString(),
      slotIds: ["slot-1"],
    });
    assert.equal(gap.code, "no-data-in-range");
    assert.match(gap.detail, /数据缺口/);

    const earlier = diagnoseTelemetryAvailability(fixture.store, {
      from: new Date(BASE_MS - 2 * 60 * 60_000).toISOString(),
      to: new Date(BASE_MS - 60 * 60_000).toISOString(),
      slotIds: ["slot-1"],
    });
    assert.equal(earlier.code, "data-after-range");
    assert.match(earlier.detail, /无法回填/);

    const partial = diagnoseTelemetryAvailability(fixture.store, {
      from: new Date(BASE_MS - 1_000).toISOString(),
      to: new Date(BASE_MS + 1_000).toISOString(),
      slotIds: ["slot-1", "slot-2"],
    });
    assert.equal(partial.code, "partial-slots");
    assert.deepEqual(partial.availableSlotIds, ["slot-1"]);
    assert.deepEqual(partial.unavailableSlotIds, ["slot-2"]);

    const single = diagnoseTelemetryAvailability(fixture.store, {
      from: new Date(BASE_MS - 1_000).toISOString(),
      to: new Date(BASE_MS + 1_000).toISOString(),
      slotIds: ["slot-1"],
    });
    assert.equal(single.code, "insufficient-observations");
    assert.match(single.detail, /不足以判断变化幅度或趋势/);
  } finally {
    fixture.cleanup();
  }
});

test("历史型语义产生确定的可用性查询，而实时读数不会误查历史", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const variation: DeepSeekDecision = {
    reply: "",
    actions: [],
    planningMode: "thinking",
    semantic: {
      goal: "variation",
      summary: "查看温度变化幅度",
      subjects: [{ label: "环境温度", slotId: "slot-1" }],
      timeRange: "24h",
      primaryEvidence: "daily-heatmap",
      supportingEvidence: ["indicator-posture"],
      evidenceSummary: "查看时段分布",
      successCriterion: "定位变化时段",
    },
  };
  assert.deepEqual(availabilityQueryForDecision(variation, [], now), {
    from: "2026-07-19T12:00:00.000Z",
    to: "2026-07-20T12:00:00.000Z",
    slotIds: ["slot-1"],
  });

  const current: DeepSeekDecision = {
    ...variation,
    semantic: {
      ...variation.semantic,
      goal: "current-value",
      timeRange: null,
      primaryEvidence: "current-reading",
      supportingEvidence: [],
    },
  };
  const currentActions: AgentAction[] = [{ name: "telemetry.read_current", arguments: { slotId: "slot-1" } }];
  assert.equal(availabilityQueryForDecision(current, currentActions, now), null);

  const inspectionMap: DeepSeekDecision = {
    ...variation,
    semantic: {
      ...variation.semantic,
      goal: "spatial-pattern",
      timeRange: null,
      primaryEvidence: "inspection-map",
      supportingEvidence: [],
    },
  };
  const spatialActions: AgentAction[] = [{ name: "spatial.set_layer", arguments: { layer: "slot-1" } }];
  assert.deepEqual(availabilityQueryForDecision(inspectionMap, spatialActions, now), {
    from: "2026-07-19T12:00:00.000Z",
    to: "2026-07-20T12:00:00.000Z",
    slotIds: ["slot-1"],
  });
});

test("规划校验错误公开具体原因，且与数据不可用使用不同错误语义", () => {
  const planning = publicGatewayFailure(new Error("区域参数与页面不匹配: internal-selector"), "planning");
  assert.equal(planning.code, "plan-validation-failed");
  assert.match(planning.message, /区域参数与页面不匹配/);
  const request = publicGatewayFailure(new Error("遥测时间范围无效"), "request");
  assert.equal(request.code, "invalid-telemetry-request");
  assert.match(request.message, /查询条件无效/);
});

test("页面真实回执超时不会误报计划校验，也不改变车辆失败分类", () => {
  const pageAction = publicGatewayFailure(
    new Error("等待“切换到分析洞察”真实完成回执超时，后续动作已停止"),
    "planning",
  );
  assert.equal(pageAction.code, "agent-operation-failed");
  assert.match(pageAction.message, /页面动作没有真实完成/);
  assert.doesNotMatch(pageAction.message, /协议校验|未执行任何动作/);

  const vehicle = publicGatewayFailure(
    new Error("车辆任务失败：Jetson 连接超时"),
    "planning",
  );
  assert.equal(vehicle.code, "vehicle-execution-failed");
  assert.match(vehicle.message, /后续车辆动作已停止/);
});

test("车辆意图或完整性异常不会再使用 plan-incomplete 错误码", () => {
  const ambiguous = publicGatewayFailure(
    new Error("AI 意图判断不确定，未执行任何动作：缺少路径尺寸"),
    "planning",
  );
  assert.equal(ambiguous.code, "planning-clarification-needed");
  assert.match(ambiguous.message, /缺少路径尺寸/);

  const incomplete = publicGatewayFailure(
    new Error("车辆计划未完整覆盖用户目标，未执行任何动作：终点未回到原点"),
    "planning",
  );
  assert.equal(incomplete.code, "planning-clarification-needed");
  assert.match(incomplete.message, /终点未回到原点/);
});

test("固定检查点导航前置条件会保留真实原因和下一步操作", () => {
  const missingMap = publicGatewayFailure(
    new Error("固定检查点“油桶”已找到，但 Jetson 导航地图尚未保存或同步"),
    "planning",
  );
  assert.equal(missingMap.code, "vehicle-navigation-not-ready");
  assert.match(missingMap.message, /油桶/);
  assert.match(missingMap.message, /确认小车已连接/);

  const missingCalibration = publicGatewayFailure(
    new Error("固定检查点“炉”已找到，但小车当前位置尚未标定"),
    "planning",
  );
  assert.equal(missingCalibration.code, "vehicle-navigation-not-ready");
  assert.match(missingCalibration.message, /起点标定/);
});
