import assert from "node:assert/strict";
import test from "node:test";
import type { AgentGatewayConfig } from "./config";
import {
  checkpointReturnLimitation,
  deepSeekThinkingParameters,
  decideWithDeepSeek,
  deterministicImmediateNavigationDecision,
  ensureSemanticEvidenceCoverage,
  inferLocalSemanticBrief,
  isExplicitVehicleEmergencyStop,
  normalizeVehiclePlannerArguments,
  normalizeSemanticTimeRange,
  parseSemanticIntentBrief,
  reconcileSemanticIntent,
  repairCheckpointPlan,
  type SemanticIntentBrief,
} from "./deepseek";

test("DeepSeek 请求参数支持思考开关与两档有效推理强度", () => {
  assert.deepEqual(deepSeekThinkingParameters({
    thinkingMode: "thinking",
    reasoningEffort: "high",
  }), {
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
  assert.deepEqual(deepSeekThinkingParameters({
    thinkingMode: "thinking",
    reasoningEffort: "max",
  }), {
    thinking: { type: "enabled" },
    reasoning_effort: "max",
  });
  assert.deepEqual(deepSeekThinkingParameters({
    thinkingMode: "non-thinking",
    reasoningEffort: "max",
  }), {
    thinking: { type: "disabled" },
  });
});

function semanticJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    goal: "spatial-pattern",
    summary: "查看环境温度的空间分布",
    subjects: [{ label: "环境温度", slotId: "slot-1" }],
    primaryEvidence: "spatial-distribution",
    supportingEvidence: [],
    evidenceSummary: "使用空间分布图呈现位置差异",
    successCriterion: "最终聚焦温度空间分布图",
    ...overrides,
  });
}

const monitoringContext = "目标屏幕当前位于数据监测。";
const vehicleContext = "目标屏幕当前位于小车遥控。";
const liveConfig = {
  mockMode: false,
  deepSeekApiKey: "test-key",
  deepSeekBaseUrl: "https://deepseek.invalid",
  model: "deepseek-v4-flash",
  reasoningMode: "always",
} as AgentGatewayConfig;

function completionResponse(
  message: Record<string, unknown>,
  finishReason: string | null = "stop",
) {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, message }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function planResponse(reply = "正在呈现对应证据。") {
  return completionResponse({ content: reply, tool_calls: [] });
}

function installFetchSequence(responses: Response[], requestBodies: Array<Record<string, unknown>>) {
  const queue = [...responses];
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = queue.shift();
    if (!response) throw new Error("测试未配置足够的 DeepSeek 响应");
    return response;
  };
}

test("完整的单页面导航使用严格白名单即时生成动作且不请求模型", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("纯页面导航不应请求 DeepSeek");
  };
  const progress: Array<{ phase: string; status: string }> = [];

  const decision = await decideWithDeepSeek(
    { ...liveConfig, deepSeekApiKey: "" },
    "请帮我打开数据监测页面",
    [],
    monitoringContext,
    (event) => progress.push({ phase: event.phase, status: event.status }),
    { thinkingMode: "thinking", reasoningEffort: "high" },
  );

  assert.equal(fetchCalls, 0);
  assert.equal(decision.planningMode, "thinking");
  assert.equal(decision.semantic.goal, "navigation");
  assert.deepEqual(decision.actions, [
    { name: "ui.navigate", arguments: { page: "monitoring" } },
  ]);
  assert.deepEqual(progress, [
    { phase: "understanding", status: "active" },
    { phase: "understanding", status: "complete" },
    { phase: "evidence", status: "active" },
    { phase: "evidence", status: "complete" },
    { phase: "actions", status: "active" },
    { phase: "actions", status: "complete" },
  ]);
});

test("即时导航拒绝复合、区域、设置修改、车辆控制和多页面请求", () => {
  assert.equal(deterministicImmediateNavigationDecision("打开空间孪生并切换俯视"), null);
  assert.equal(deterministicImmediateNavigationDecision("查看数据监测页的指标态势"), null);
  assert.equal(deterministicImmediateNavigationDecision("打开系统设置并把读取频率改为一秒"), null);
  assert.equal(deterministicImmediateNavigationDecision("打开小车并前进一米"), null);
  assert.equal(deterministicImmediateNavigationDecision("打开告警管理和系统设置"), null);
  assert.deepEqual(deterministicImmediateNavigationDecision("进入告警管理界面吧"), {
    action: { name: "ui.navigate", arguments: { page: "alerts" } },
    label: "告警管理",
  });
});

test("七个命名页面的即时导航都返回导航语义且不借用连接或车辆状态语义", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    throw new Error("命名页面导航不应请求 DeepSeek");
  };
  const cases = [
    ["打开控制概览页面", "overview", "控制概览"],
    ["打开数据监测页面", "monitoring", "数据监测"],
    ["进入告警管理界面", "alerts", "告警管理"],
    ["打开连接管理页面", "integrations", "接口配置"],
    ["前往系统设置", "settings", "系统设置"],
    ["打开小车遥控页面", "vehicle", "小车遥控"],
    ["显示空间孪生", "digital-twin", "空间孪生"],
  ] as const;

  for (const [input, page, label] of cases) {
    const decision = await decideWithDeepSeek(
      { ...liveConfig, deepSeekApiKey: "" },
      input,
      [],
      monitoringContext,
    );
    assert.equal(decision.semantic.goal, "navigation");
    assert.equal(decision.semantic.primaryEvidence, "named-page-region");
    assert.match(decision.semantic.summary, new RegExp(label));
    assert.deepEqual(decision.actions, [
      { name: "ui.navigate", arguments: { page } },
    ]);
  }
});

test("严格车辆急停不等待模型，并拒绝把停止环绕或停止播报误判为停车", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("车辆急停不应请求 DeepSeek");
  };

  assert.equal(isExplicitVehicleEmergencyStop("请帮我立即停止小车"), true);
  assert.equal(isExplicitVehicleEmergencyStop("急停"), true);
  assert.equal(isExplicitVehicleEmergencyStop("停止"), true);
  assert.equal(isExplicitVehicleEmergencyStop("停止环绕"), false);
  assert.equal(isExplicitVehicleEmergencyStop("停止语音播报"), false);
  assert.equal(isExplicitVehicleEmergencyStop("打开停车场页面"), false);

  const decision = await decideWithDeepSeek(
    { ...liveConfig, deepSeekApiKey: "" },
    "请帮我立即停止小车",
    [],
    monitoringContext,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(decision.semantic.goal, "direct-control");
  assert.deepEqual(decision.actions, [{ name: "vehicle.stop", arguments: {} }]);

  const navigation = inferLocalSemanticBrief("停止环绕", monitoringContext);
  assert.equal(
    ensureSemanticEvidenceCoverage("停止环绕", navigation, []).some((action) => action.name === "vehicle.stop"),
    false,
  );
});

test("纯固定检查点导航移除模型猜测的多余移动，并把检测放到到达之后", () => {
  const actions = repairCheckpointPlan([
    {
      name: "vehicle.move_distance",
      arguments: { direction: "forward", distanceMm: 100, maxSpeedMmps: 300 },
    },
    { name: "telemetry.inspect_current", arguments: {} },
    { name: "vehicle.navigate_to_checkpoint", arguments: { checkpointName: "油桶" } },
  ], {
    minimumMovementActions: 1,
    minimumDistanceActions: 0,
    minimumTurnActions: 0,
    requiresClosedPosition: false,
    requiresOriginalHeading: false,
  });

  assert.deepEqual(actions, [
    { name: "vehicle.navigate_to_checkpoint", arguments: { checkpointName: "油桶" } },
    { name: "telemetry.inspect_current", arguments: {} },
  ]);

  assert.deepEqual(
    normalizeVehiclePlannerArguments("telemetry.inspect_current", { slotIds: [] }),
    {},
  );
  assert.deepEqual(
    normalizeVehiclePlannerArguments("telemetry.inspect_current", { slotIds: ["slot-1"] }),
    { slotIds: ["slot-1"] },
  );

  assert.match(
    checkpointReturnLimitation({
      minimumMovementActions: 2,
      minimumDistanceActions: 0,
      minimumTurnActions: 0,
      requiresClosedPosition: true,
      requiresOriginalHeading: false,
    }, [
      { name: "vehicle.navigate_to_checkpoint", arguments: { checkpointName: "油桶" } },
      { name: "telemetry.inspect_current", arguments: {} },
      {
        name: "vehicle.move_distance",
        arguments: { direction: "backward", distanceMm: 1_000, maxSpeedMmps: 300 },
      },
    ]) ?? "",
    /不能用猜测距离或定时后退冒充返程/,
  );
  assert.equal(
    checkpointReturnLimitation({
      minimumMovementActions: 2,
      minimumDistanceActions: 0,
      minimumTurnActions: 0,
      requiresClosedPosition: true,
      requiresOriginalHeading: false,
    }, [
      { name: "vehicle.navigate_to_checkpoint", arguments: { checkpointName: "油桶" } },
      { name: "vehicle.navigate_to_checkpoint", arguments: { checkpointName: "起点" } },
    ]),
    null,
  );
});

test("通用语义误分流的固定点动作会由 AI 意图复核并转入车辆专用规划", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  installFetchSequence([
    completionResponse({
      content: semanticJson({
        goal: "other",
        summary: "理解并处理当前请求",
        subjects: [],
        timeRange: null,
        primaryEvidence: "named-page-region",
        supportingEvidence: [],
        evidenceSummary: "处理当前请求",
        successCriterion: "完成当前请求",
      }),
    }),
    completionResponse({
      content: "准备前往固定检查点。",
      tool_calls: [
        {
          function: {
            name: "vehicle__navigate_to_checkpoint",
            arguments: JSON.stringify({ checkpointName: "油桶" }),
          },
        },
        {
          function: {
            name: "telemetry__inspect_current",
            arguments: JSON.stringify({ slotIds: [] }),
          },
        },
        {
          function: {
            name: "vehicle__propose_move",
            arguments: JSON.stringify({ motion: "backward", speedPercent: 20, durationMs: 3_000 }),
          },
        },
      ],
    }, "tool_calls"),
    completionResponse({
      content: JSON.stringify({
        domain: "vehicle-control",
        confidence: "high",
        summary: "前往油桶并检测后回复结果",
        reason: "固定检查点导航与到点检测目标明确",
        successCriterion: "到达油桶后读取六路数据并回复检测结果",
        vehicleRequirements: {
          minimumMovementActions: 1,
          minimumDistanceActions: 0,
          minimumTurnActions: 0,
          requiresClosedPosition: false,
          requiresOriginalHeading: false,
        },
      }),
    }),
    completionResponse({
      content: JSON.stringify({
        reply: "准备前往油桶并在到达后检测。",
        actions: [
          { name: "vehicle.navigate_to_checkpoint", arguments: { checkpointName: "油桶" } },
          { name: "telemetry.inspect_current", arguments: { slotIds: [] } },
        ],
      }),
    }),
    completionResponse({
      content: JSON.stringify({
        complete: true,
        reason: "导航后检测，未添加无关车辆移动",
      }),
    }),
  ], requestBodies);

  const decision = await decideWithDeepSeek(
    liveConfig,
    "去油桶测量一下，回来告诉我测量数据和检测结果",
    [],
    `${vehicleContext} 固定检查点目录：["油桶"]。`,
  );

  assert.equal(
    requestBodies.length,
    5,
    JSON.stringify(requestBodies.map((body) => ({
      responseFormat: body.response_format,
      hasTools: Array.isArray(body.tools),
      firstSystem: Array.isArray(body.messages)
        ? String((body.messages[0] as { content?: unknown })?.content ?? "").slice(0, 80)
        : "",
    }))),
  );
  assert.equal(decision.semantic.goal, "direct-control");
  assert.deepEqual(decision.actions, [
    { name: "vehicle.navigate_to_checkpoint", arguments: { checkpointName: "油桶" } },
    { name: "telemetry.inspect_current", arguments: {} },
  ]);
});

test("复合孪生请求不会命中导航快路径，而会保留两阶段模型与完整原子动作", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  installFetchSequence([
    completionResponse({
      content: semanticJson({
        goal: "navigation",
        summary: "打开空间孪生并切换到俯视",
        subjects: [],
        timeRange: null,
        primaryEvidence: "twin-viewport",
        supportingEvidence: [],
        evidenceSummary: "使用空间孪生视口呈现俯视画面",
        successCriterion: "最终显示空间孪生俯视画面",
      }),
    }),
    completionResponse({
      content: "准备打开空间孪生并切换俯视。",
      tool_calls: [
        {
          function: {
            name: "ui__navigate",
            arguments: JSON.stringify({ page: "digital-twin" }),
          },
        },
        {
          function: {
            name: "twin__set_view",
            arguments: JSON.stringify({ view: "top" }),
          },
        },
      ],
    }, "tool_calls"),
  ], requestBodies);

  const decision = await decideWithDeepSeek(
    liveConfig,
    "打开空间孪生并切换俯视",
    [],
    monitoringContext,
  );

  assert.equal(deterministicImmediateNavigationDecision("打开空间孪生并切换俯视"), null);
  assert.equal(requestBodies.length, 2);
  assert.deepEqual(requestBodies[0]?.response_format, { type: "json_object" });
  assert.ok(Array.isArray(requestBodies[1]?.tools));
  assert.deepEqual(decision.actions, [
    { name: "ui.navigate", arguments: { page: "digital-twin" } },
    { name: "twin.set_view", arguments: { view: "top" } },
    { name: "ui.focus_region", arguments: { page: "digital-twin", region: "viewport" } },
  ]);
});

test("语义时间范围先规范化，缺省或数据不可用状态不会被误报成格式错误", () => {
  assert.equal(normalizeSemanticTimeRange(undefined), null);
  assert.equal(normalizeSemanticTimeRange(""), null);
  assert.equal(normalizeSemanticTimeRange("近 24 小时"), "24h");
  assert.equal(normalizeSemanticTimeRange("最近一周"), "7d");
  assert.equal(normalizeSemanticTimeRange("暂无可用时间范围"), null);
  assert.equal(normalizeSemanticTimeRange("覆盖不足"), null);

  assert.equal(parseSemanticIntentBrief(semanticJson()).timeRange, null);
  assert.equal(parseSemanticIntentBrief(semanticJson({ timeRange: "数据不足" })).timeRange, null);
  assert.equal(parseSemanticIntentBrief(semanticJson({ timeRange: "近 24 小时" })).timeRange, "24h");
  assert.throws(() => parseSemanticIntentBrief(semanticJson({ timeRange: "90d" })), /语义时间范围无效/);
  assert.throws(() => parseSemanticIntentBrief(semanticJson({ timeRange: 24 })), /语义时间范围无效/);
});

test("温度地图根据显式页面措辞和当前页面区分监测分布与小车巡检图层", () => {
  const vagueOnMonitoring = inferLocalSemanticBrief("看看温度地图", monitoringContext);
  assert.deepEqual({
    goal: vagueOnMonitoring.goal,
    primaryEvidence: vagueOnMonitoring.primaryEvidence,
    timeRange: vagueOnMonitoring.timeRange,
  }, {
    goal: "spatial-pattern",
    primaryEvidence: "spatial-distribution",
    timeRange: "24h",
  });
  assert.deepEqual(ensureSemanticEvidenceCoverage("看看温度地图", vagueOnMonitoring, []), [
    { name: "monitoring.set_range", arguments: { range: "24h" } },
    { name: "telemetry.focus", arguments: { slotId: "slot-1" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "spatial-distribution" } },
  ]);

  const vagueOnVehicle = inferLocalSemanticBrief("看看温度地图", vehicleContext);
  assert.deepEqual({
    goal: vagueOnVehicle.goal,
    primaryEvidence: vagueOnVehicle.primaryEvidence,
    timeRange: vagueOnVehicle.timeRange,
  }, {
    goal: "spatial-pattern",
    primaryEvidence: "inspection-map",
    timeRange: null,
  });
  assert.deepEqual(ensureSemanticEvidenceCoverage("看看温度地图", vagueOnVehicle, []), [
    { name: "spatial.set_layer", arguments: { layer: "slot-1" } },
    { name: "ui.focus_region", arguments: { page: "vehicle", region: "inspection-map" } },
  ]);

  assert.equal(
    inferLocalSemanticBrief("在小车巡检地图看温度图层", monitoringContext).primaryEvidence,
    "inspection-map",
  );
  assert.equal(
    inferLocalSemanticBrief("在数据监测页看温度地图图层", vehicleContext).primaryEvidence,
    "spatial-distribution",
  );
});

test("语义护栏纠正模型选错的地图页面，并让巡检地图不携带历史时间范围", () => {
  const modelBrief: SemanticIntentBrief = {
    goal: "spatial-pattern",
    summary: "查看温度地图",
    subjects: [{ label: "环境温度", slotId: "slot-1" }],
    timeRange: "24h",
    primaryEvidence: "spatial-distribution",
    supportingEvidence: [],
    evidenceSummary: "查看温度分布",
    successCriterion: "显示温度地图",
  };
  const reconciled = reconcileSemanticIntent("在小车巡检地图看温度图层", modelBrief, monitoringContext);
  assert.equal(reconciled.primaryEvidence, "inspection-map");
  assert.equal(reconciled.timeRange, null);
  assert.deepEqual(ensureSemanticEvidenceCoverage("在小车巡检地图看温度图层", reconciled, [
    { name: "monitoring.set_range", arguments: { range: "24h" } },
    { name: "telemetry.focus", arguments: { slotId: "slot-1" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "spatial-distribution" } },
  ]), [
    { name: "spatial.set_layer", arguments: { layer: "slot-1" } },
    { name: "ui.focus_region", arguments: { page: "vehicle", region: "inspection-map" } },
  ]);
});

test("语义模型已描述前往真实检查点时不会被错误的 vehicle-state 枚举降级", () => {
  const modelBrief: SemanticIntentBrief = {
    goal: "vehicle-state",
    summary: "前往油桶并查看现场数据",
    subjects: [],
    timeRange: null,
    primaryEvidence: "vehicle-camera",
    supportingEvidence: [],
    evidenceSummary: "查看现场画面",
    successCriterion: "显示现场状态",
  };
  const runtimeContext = "目标客户端固定检查点目录：[\"油桶\"]。标定状态：已标定；当前位置：暂无；Jetson 地图修订：1。";
  const reconciled = reconcileSemanticIntent("去油桶看看现场数据怎么样", modelBrief, runtimeContext);

  assert.equal(reconciled.goal, "direct-control");
  assert.equal(reconciled.primaryEvidence, "named-page-region");
  assert.equal(reconciled.timeRange, null);
});

test("缺少 timeRange 的真实模型语义响应仍完成地图规划且两次请求保持 V4 Flash thinking", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (requestBodies.length === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: semanticJson() } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "正在显示温度空间分布。", tool_calls: [] } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const decision = await decideWithDeepSeek({
    mockMode: false,
    deepSeekApiKey: "test-key",
    deepSeekBaseUrl: "https://deepseek.invalid",
    model: "deepseek-v4-flash",
    reasoningMode: "always",
  } as AgentGatewayConfig, "看看温度地图", [], monitoringContext);

  assert.equal(requestBodies.length, 2);
  for (const body of requestBodies) {
    assert.equal(body.model, "deepseek-v4-flash");
    assert.deepEqual(body.thinking, { type: "enabled" });
  }
  assert.equal(requestBodies[1]?.reasoning_effort, "high");
  assert.equal(requestBodies[0]?.max_tokens, 4_096);
  assert.deepEqual(requestBodies[0]?.response_format, { type: "json_object" });
  assert.equal(decision.planningMode, "thinking");
  assert.equal(decision.semantic.timeRange, "24h");
  assert.deepEqual(decision.actions, [
    { name: "monitoring.set_range", arguments: { range: "24h" } },
    { name: "telemetry.focus", arguments: { slotId: "slot-1" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "spatial-distribution" } },
  ]);
});

test("非思考模式贯穿语义理解和动作规划且不发送无效推理强度", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  installFetchSequence([
    completionResponse({ content: semanticJson() }),
    planResponse(),
  ], requestBodies);

  const decision = await decideWithDeepSeek(
    liveConfig,
    "看看温度地图",
    [],
    monitoringContext,
    undefined,
    { thinkingMode: "non-thinking", reasoningEffort: "max" },
  );

  assert.equal(requestBodies.length, 2);
  for (const body of requestBodies) {
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal("reasoning_effort" in body, false);
  }
  assert.equal(decision.planningMode, "non-thinking");
});

test("复杂请求在模型语义摘要缺失时恢复完整证据链而不是直接报错", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (requestBodies.length === 1) {
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "length",
          message: {
            content: "{\"goal\":",
            reasoning_content: "不应进入公开语义摘要的隐藏推理",
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (requestBodies.length === 2) {
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: {
            content: "",
            reasoning_content: semanticJson({ goal: "current-value" }),
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "正在组织证据。", tool_calls: [] } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const input = "请分析今天房间环境是否稳定，重点判断温度变化大不大、湿度是否同步变化，并找出波动最明显的时段，最后描述问题并给出建议。";
  const decision = await decideWithDeepSeek({
    mockMode: false,
    deepSeekApiKey: "test-key",
    deepSeekBaseUrl: "https://deepseek.invalid",
    model: "deepseek-v4-flash",
    reasoningMode: "always",
  } as AgentGatewayConfig, input, [], monitoringContext);

  assert.equal(requestBodies.length, 3);
  assert.equal(requestBodies[0]?.max_tokens, 4_096);
  assert.equal(requestBodies[1]?.max_tokens, 8_192);
  assert.deepEqual(requestBodies[0]?.thinking, { type: "enabled" });
  assert.deepEqual(requestBodies[1]?.thinking, { type: "enabled" });
  assert.equal(decision.semantic.summary.includes("隐藏推理"), false);
  assert.equal(decision.semantic.goal, "recommendations");
  assert.deepEqual(decision.semantic.subjects.map((subject) => subject.slotId), ["slot-1", "slot-2"]);
  assert.deepEqual(decision.semantic.supportingEvidence, [
    "indicator-posture",
    "daily-heatmap",
    "correlation-matrix",
    "ai-problems",
  ]);
  assert.deepEqual(decision.actions, [
    { name: "monitoring.set_range", arguments: { range: "24h" } },
    { name: "telemetry.focus", arguments: { slotId: "slot-1" } },
    { name: "monitoring.generate_analysis", arguments: { slotIds: ["slot-1", "slot-2"] } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "indicator-posture" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "daily-heatmap" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "correlation-matrix" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "ai-problems" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "ai-recommendations" } },
  ]);
});

test("finish_reason=length 会以更高 token 上限修复，stop 字符串 JSON 成功后再规划", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  const repairedSemantic = semanticJson({
    goal: "variation",
    summary: "查看最近环境温度的变化幅度",
    timeRange: "24h",
    primaryEvidence: "daily-heatmap",
    supportingEvidence: ["indicator-posture"],
    evidenceSummary: "以日内热力图判断变化幅度，并用指标态势辅助",
    successCriterion: "最终聚焦温度日内热力图",
  });
  installFetchSequence([
    completionResponse({ content: repairedSemantic.slice(0, 48) }, "length"),
    completionResponse({ content: repairedSemantic }, "stop"),
    planResponse(),
  ], requestBodies);

  const decision = await decideWithDeepSeek(
    liveConfig,
    "我想看看最近的温度变化大不大",
    [],
    monitoringContext,
  );

  assert.equal(requestBodies.length, 3);
  assert.equal(decision.semantic.goal, "variation");
  assert.equal(decision.semantic.primaryEvidence, "daily-heatmap");
  assert.deepEqual(requestBodies[0].response_format, { type: "json_object" });
  assert.equal(requestBodies[0].max_tokens, 4_096);
  assert.deepEqual(requestBodies[1].response_format, { type: "json_object" });
  assert.equal(requestBodies[1].max_tokens, 8_192);
  const repairMessages = requestBodies[1].messages as Array<{ role?: string; content?: string }>;
  assert.match(repairMessages.at(-1)?.content ?? "", /上一版语义摘要为空、被截断/);
  assert.equal(requestBodies[2].response_format, undefined);
  assert.ok(Array.isArray(requestBodies[2].tools), "动作规划请求应继续使用工具调用而不是 JSON mode");
});

test("语义 JSON 支持 text 与 output_text 数组分片，并忽略非最终文本块", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  const content = semanticJson({
    goal: "variation",
    summary: "查看环境温度波动",
    timeRange: "24h",
    primaryEvidence: "daily-heatmap",
    supportingEvidence: [],
    evidenceSummary: "使用日内热力图呈现温度波动",
    successCriterion: "聚焦温度日内热力图",
  });
  const splitAt = Math.floor(content.length / 2);
  installFetchSequence([
    completionResponse({
      content: [
        { type: "reasoning", text: "这不是最终输出，不应参与 JSON 解析" },
        { type: "text", text: content.slice(0, splitAt) },
        { type: "output_text", text: content.slice(splitAt) },
      ],
    }),
    planResponse(),
  ], requestBodies);

  const decision = await decideWithDeepSeek(
    liveConfig,
    "看看今天温度波动",
    [],
    monitoringContext,
  );

  assert.equal(requestBodies.length, 2);
  assert.equal(decision.semantic.summary, "查看环境温度波动");
  assert.equal(decision.semantic.primaryEvidence, "daily-heatmap");
});

test("finish_reason=stop 但 content=null 时仍会修复，第二次完整 JSON 可恢复", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  const repairedSemantic = semanticJson({
    goal: "trend",
    summary: "查看环境温度近期走势",
    timeRange: "24h",
    primaryEvidence: "indicator-posture",
    supportingEvidence: [],
    evidenceSummary: "使用指标态势判断近期升降方向",
    successCriterion: "聚焦温度指标态势",
  });
  installFetchSequence([
    completionResponse({ content: null }, "stop"),
    completionResponse({ content: repairedSemantic }, "stop"),
    planResponse(),
  ], requestBodies);

  const decision = await decideWithDeepSeek(
    liveConfig,
    "看看最近温度走势",
    [],
    monitoringContext,
  );

  assert.equal(requestBodies.length, 3);
  assert.equal(decision.semantic.goal, "trend");
  assert.equal(decision.semantic.primaryEvidence, "indicator-posture");
});

test("只有 reasoning_content 且两次没有最终 content 时，不会把思维链当摘要并回退本地语义", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  installFetchSequence([
    completionResponse({ content: null, reasoning_content: "内部推理文本，不是最终 JSON" }, "stop"),
    completionResponse({ reasoning_content: "修复请求仍然只有内部推理" }, "stop"),
    planResponse(),
  ], requestBodies);

  const decision = await decideWithDeepSeek(
    liveConfig,
    "我想看看最近的温度变化大不大",
    [],
    monitoringContext,
  );

  assert.equal(requestBodies.length, 3);
  assert.equal(decision.semantic.goal, "variation");
  assert.equal(decision.semantic.primaryEvidence, "daily-heatmap");
  assert.equal(decision.semantic.timeRange, "24h");
  assert.doesNotMatch(decision.semantic.summary, /内部推理/);
});

test("语义修复请求若被内容过滤会明确失败，且不会继续发送动作规划", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  installFetchSequence([
    completionResponse({ content: "{\"goal\":" }, "length"),
    completionResponse({ content: null }, "content_filter"),
  ], requestBodies);

  await assert.rejects(
    () => decideWithDeepSeek(
      liveConfig,
      "分析最近温度波动",
      [],
      monitoringContext,
    ),
    /语义摘要被内容过滤中止/,
  );
  assert.equal(requestBodies.length, 2);
  assert.ok(requestBodies.every((body) => body.response_format !== undefined));
  assert.ok(requestBodies.every((body) => body.tools === undefined), "失败后不得误入动作规划请求");
});

test("语义摘要被截断后使用扩展预算重试，并只接受 content 中的最终文本", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (requestBodies.length === 1) {
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "length",
          message: {
            content: "{\"goal\":",
            reasoning_content: "隐藏推理不可用作最终结果",
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (requestBodies.length === 2) {
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: {
            content: [
              { type: "reasoning", text: semanticJson({ goal: "current-value" }) },
              { type: "output_text", text: semanticJson() },
            ],
            reasoning_content: "不应被解析或显示",
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "正在显示温度空间分布。", tool_calls: [] } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const decision = await decideWithDeepSeek({
    mockMode: false,
    deepSeekApiKey: "test-key",
    deepSeekBaseUrl: "https://deepseek.invalid",
    model: "deepseek-v4-flash",
    reasoningMode: "always",
  } as AgentGatewayConfig, "看看温度地图", [], monitoringContext);

  assert.equal(requestBodies.length, 3);
  assert.equal(requestBodies[0]?.max_tokens, 4_096);
  assert.equal(requestBodies[1]?.max_tokens, 8_192);
  assert.equal(decision.semantic.goal, "spatial-pattern");
  assert.equal(JSON.stringify(decision.semantic).includes("不应被解析或显示"), false);
});

test("内容过滤结束不会被当作空摘要降级执行", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "content_filter",
        message: {
          content: "",
          reasoning_content: "内部文本不得进入报错或降级结果",
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await assert.rejects(
    decideWithDeepSeek({
      mockMode: false,
      deepSeekApiKey: "test-key",
      deepSeekBaseUrl: "https://deepseek.invalid",
      model: "deepseek-v4-flash",
      reasoningMode: "always",
    } as AgentGatewayConfig, "看看温度地图", [], monitoringContext),
    (error: unknown) => error instanceof Error
      && error.message === "DeepSeek 语义摘要被内容过滤中止"
      && !error.message.includes("内部文本"),
  );
  assert.equal(callCount, 1);
});

test("语义请求超时会恢复为本地公开摘要，并继续生成完整复合证据链", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) throw new Error("The operation was aborted due to timeout");
    return planResponse();
  };

  const decision = await decideWithDeepSeek(
    liveConfig,
    "请分析今天房间环境是否稳定，重点判断温度变化大不大、湿度是否同步变化，并找出波动最明显的时段，最后描述问题并给出建议",
    [],
    monitoringContext,
  );

  assert.equal(callCount, 2);
  assert.equal(decision.semantic.goal, "recommendations");
  assert.deepEqual(decision.semantic.subjects.map((subject) => subject.slotId), ["slot-1", "slot-2"]);
  assert.deepEqual(
    decision.actions.filter((action) => action.name === "ui.focus_region").map((action) => action.arguments.region),
    ["indicator-posture", "daily-heatmap", "correlation-matrix", "ai-problems", "ai-recommendations"],
  );
});

test("DeepSeek 返回精确的主证据无效时会降级到本地语义并继续规划", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount <= 2) {
      return completionResponse({
        content: semanticJson({
          goal: "navigation",
          summary: "打开数据监测页面",
          subjects: [],
          timeRange: null,
          primaryEvidence: "invalid-primary-evidence",
          supportingEvidence: [],
          evidenceSummary: "打开数据监测页面",
          successCriterion: "最终显示数据监测页面",
        }),
      });
    }
    return completionResponse({
      content: "已打开数据监测页面。",
      tool_calls: [{
        function: { name: "ui__navigate", arguments: JSON.stringify({ page: "monitoring" }) },
      }],
    }, "tool_calls");
  };

  const decision = await decideWithDeepSeek(
    liveConfig,
    "请规划打开数据监测页面",
    [],
    monitoringContext,
  );

  assert.equal(callCount, 3);
  assert.equal(decision.semantic.goal, "navigation");
  assert.deepEqual(decision.actions, [
    { name: "ui.navigate", arguments: { page: "monitoring" } },
  ]);
});

test("分析类动作规划超时不会只报错，而会由已校验语义确定性补齐动作", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return completionResponse({
        content: semanticJson({
          goal: "variation",
          summary: "判断今天环境温度的波动幅度与发生时段",
          subjects: [{ label: "环境温度", slotId: "slot-1" }],
          timeRange: "24h",
          primaryEvidence: "daily-heatmap",
          supportingEvidence: ["indicator-posture"],
          evidenceSummary: "先看指标态势，再用日内热力图定位波动时段",
          successCriterion: "最终聚焦温度日内热力图",
        }),
      });
    }
    throw new Error("The operation was aborted due to timeout");
  };

  const decision = await decideWithDeepSeek(
    liveConfig,
    "看看今天温度变化大不大",
    [],
    monitoringContext,
  );

  assert.equal(callCount, 2);
  assert.match(decision.reply, /判断今天环境温度|判断近期环境温度/);
  assert.deepEqual(decision.actions, [
    { name: "monitoring.set_range", arguments: { range: "24h" } },
    { name: "telemetry.focus", arguments: { slotId: "slot-1" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "indicator-posture" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "daily-heatmap" } },
  ]);
});

test("动作规划 length 响应的部分工具不会被执行，高预算重试接受空 content 与完整 tool_calls", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  installFetchSequence([
    completionResponse({
      content: semanticJson({
        goal: "navigation",
        summary: "打开系统设置",
        subjects: [],
        timeRange: null,
        primaryEvidence: "named-page-region",
        supportingEvidence: [],
        evidenceSummary: "使用受限页面导航",
        successCriterion: "最终显示系统设置页",
      }),
    }),
    completionResponse({
      content: "",
      reasoning_content: "这段隐藏推理和部分动作不得被执行",
      tool_calls: [{
        function: { name: "ui__navigate", arguments: JSON.stringify({ page: "vehicle" }) },
      }],
    }, "length"),
    completionResponse({
      content: null,
      reasoning_content: "完整计划的隐藏推理仍不得显示",
      tool_calls: [{
        function: { name: "ui__navigate", arguments: JSON.stringify({ page: "settings" }) },
      }],
    }, "tool_calls"),
  ], requestBodies);

  const decision = await decideWithDeepSeek(
    liveConfig,
    "请规划打开系统设置",
    [],
    monitoringContext,
  );

  assert.equal(requestBodies.length, 3);
  assert.equal(requestBodies[1]?.max_tokens, 4_096);
  assert.equal(requestBodies[2]?.max_tokens, 8_192);
  assert.deepEqual(requestBodies[1]?.thinking, { type: "enabled" });
  assert.deepEqual(requestBodies[2]?.thinking, { type: "enabled" });
  assert.equal(requestBodies[1]?.reasoning_effort, "high");
  assert.equal(requestBodies[2]?.reasoning_effort, "high");
  assert.deepEqual(decision.actions, [
    { name: "ui.navigate", arguments: { page: "settings" } },
  ]);
  assert.equal(JSON.stringify(decision).includes("隐藏推理"), false);
});

test("动作规划两次 length 时明确失败，不解析任何部分工具调用", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  const partialPlan = completionResponse({
    content: "",
    reasoning_content: "不得泄露的截断推理",
    tool_calls: [{
      function: { name: "ui__navigate", arguments: JSON.stringify({ page: "vehicle" }) },
    }],
  }, "length");
  installFetchSequence([
    completionResponse({
      content: semanticJson({
        goal: "navigation",
        summary: "打开系统设置",
        subjects: [],
        timeRange: null,
        primaryEvidence: "named-page-region",
        supportingEvidence: [],
        evidenceSummary: "使用受限页面导航",
        successCriterion: "最终显示系统设置页",
      }),
    }),
    partialPlan,
    partialPlan.clone(),
  ], requestBodies);

  await assert.rejects(
    decideWithDeepSeek(liveConfig, "请规划打开系统设置", [], monitoringContext),
    (error: unknown) => error instanceof Error
      && error.message === "DeepSeek 动作规划未完成（输出达到长度限制）"
      && !error.message.includes("截断推理"),
  );
  assert.equal(requestBodies.length, 3);
  assert.equal(requestBodies[1]?.max_tokens, 4_096);
  assert.equal(requestBodies[2]?.max_tokens, 8_192);
});
