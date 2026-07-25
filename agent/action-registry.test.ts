import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_CAPABILITY_GROUPS,
  AGENT_TOOL_DEFINITIONS,
  actionPublicLabel,
  compileAgentPlan,
  compileAgentPlanWithDiagnostics,
  parseAgentAction,
  requiredPageForAction,
} from "../app/lib/ai/action-registry";
import {
  choosePlanningMode,
  decideWithDeepSeek,
  ensureExplicitActionCoverage,
  ensureSemanticEvidenceCoverage,
  fromDeepSeekToolName,
  inferLocalSemanticBrief,
  parseSemanticIntentBrief,
  reconcileSemanticIntent,
  selectRelevantConversationHistory,
  toDeepSeekToolName,
  validateVehiclePlanCompleteness,
} from "./deepseek";
import type { AgentGatewayConfig } from "./config";

test("动作注册表不暴露任意终端、URL 或 DOM 工具", () => {
  const names = AGENT_TOOL_DEFINITIONS.map((item) => item.function.name);
  assert.equal(names.includes("vehicle.stop"), true);
  assert.equal(names.some((name) => /shell|terminal|url|dom|wheel/i.test(name)), false);
});

test("功能栏由注册表完整生成且动作不重复", () => {
  const registered = AGENT_TOOL_DEFINITIONS.map((item) => item.function.name).sort();
  const visible = AGENT_CAPABILITY_GROUPS.flatMap((group) => group.actions);
  assert.equal(new Set(visible).size, visible.length);
  assert.deepEqual([...visible].sort(), registered);
});

test("限时小车移动保留默认值并开放完整的 1–100% 速度范围", () => {
  assert.deepEqual(parseAgentAction("vehicle.propose_move", { motion: "forward" }), {
    name: "vehicle.propose_move",
    arguments: { motion: "forward", speedPercent: 20, durationMs: 1000 },
  });
  assert.doesNotThrow(() => parseAgentAction("vehicle.propose_move", {
    motion: "forward",
    speedPercent: 99,
    durationMs: 60_000,
  }));
  assert.throws(() => parseAgentAction("vehicle.propose_move", {
    motion: "forward",
    speedPercent: 101,
    durationMs: 1000,
  }), /speedPercent.*最大值/);
  assert.throws(() => parseAgentAction("vehicle.propose_move", {
    motion: "forward",
    speedPercent: 20,
    durationMs: 3000.5,
  }), /durationMs.*整数/);
});

test("PID 定距与定角动作支持长距离、连续旋转并默认使用 300mm/s", () => {
  assert.deepEqual(parseAgentAction("vehicle.move_distance", { direction: "forward", distanceMm: 100 }), {
    name: "vehicle.move_distance",
    arguments: { direction: "forward", distanceMm: 100, maxSpeedMmps: 300 },
  });
  assert.deepEqual(parseAgentAction("vehicle.turn_angle", { direction: "left", angleDeg: 90 }), {
    name: "vehicle.turn_angle",
    arguments: { direction: "left", angleDeg: 90, maxSpeedMmps: 300 },
  });
  assert.doesNotThrow(() => parseAgentAction("vehicle.move_distance", { direction: "forward", distanceMm: 49 }));
  assert.throws(() => parseAgentAction("vehicle.move_distance", { direction: "forward", distanceMm: 0 }), /distanceMm.*必须大于/);
  assert.throws(() => parseAgentAction("vehicle.move_distance", { direction: "left", distanceMm: 100 }), /定距移动方向/);
  assert.doesNotThrow(() => parseAgentAction("vehicle.move_distance", { direction: "forward", distanceMm: 5000, timeoutS: 120 }));
  assert.doesNotThrow(() => parseAgentAction("vehicle.turn_angle", { direction: "left", angleDeg: 360, timeoutS: 120 }));
  assert.doesNotThrow(() => parseAgentAction("vehicle.move_distance", {
    direction: "forward",
    distanceMm: 50_000,
    maxSpeedMmps: 2_000,
    timeoutS: 1_000,
  }));
  assert.doesNotThrow(() => parseAgentAction("vehicle.turn_angle", {
    direction: "left",
    angleDeg: 1_440,
    maxSpeedMmps: 2_000,
    timeoutS: 1_000,
  }));
  assert.throws(() => parseAgentAction("vehicle.turn_angle", { direction: "left", angleDeg: 0 }), /angleDeg.*必须大于/);
  assert.throws(() => parseAgentAction("vehicle.turn_angle", { direction: "forward", angleDeg: 90 }), /定角转向方向/);
  assert.equal(actionPublicLabel(parseAgentAction("vehicle.move_distance", { direction: "backward", distanceMm: 100 })), "后退 100 毫米");
  assert.equal(actionPublicLabel(parseAgentAction("vehicle.turn_angle", { direction: "right", angleDeg: 45 })), "右转 45 度");
});

test("固定检查点导航与到点检测使用名称和六路白名单参数", () => {
  assert.deepEqual(parseAgentAction("vehicle.navigate_to_checkpoint", { checkpointName: "  油桶  " }), {
    name: "vehicle.navigate_to_checkpoint",
    arguments: { checkpointName: "油桶" },
  });
  assert.deepEqual(parseAgentAction("telemetry.inspect_current", { slotIds: ["slot-1", "slot-5"] }), {
    name: "telemetry.inspect_current",
    arguments: { slotIds: ["slot-1", "slot-5"] },
  });
  assert.equal(actionPublicLabel(parseAgentAction("vehicle.navigate_to_checkpoint", { checkpointName: "油桶" })), "前往固定检查点“油桶”");
  assert.throws(() => parseAgentAction("vehicle.navigate_to_checkpoint", { checkpointName: "" }), /名称参数无效/);
  assert.throws(() => parseAgentAction("telemetry.inspect_current", { slotIds: ["slot-9"] }), /数据位/);
});

test("未知动作和非法枚举会被拒绝", () => {
  assert.throws(() => parseAgentAction("terminal.exec", { command: "dir" }), /未授权/);
  assert.throws(() => parseAgentAction("ui.navigate", { page: "https://example.com" }), /页面参数无效/);
  assert.throws(() => parseAgentAction("telemetry.focus", { slotId: "slot-9" }), /数据位参数无效/);
});

test("遥测聚焦公开标签使用人类可读的六路指标名", () => {
  const labels = (["slot-1", "slot-2", "slot-3", "slot-4", "slot-5", "slot-6"] as const)
    .map((slotId) => actionPublicLabel(parseAgentAction("telemetry.focus", { slotId })));
  assert.deepEqual(labels, [
    "聚焦环境温度",
    "聚焦环境湿度",
    "聚焦二氧化碳",
    "聚焦TVOC",
    "聚焦甲醛",
    "聚焦环境光照",
  ]);
  assert.equal(actionPublicLabel(parseAgentAction("monitoring.generate_analysis", { slotIds: ["slot-1", "slot-2"] })), "分析环境温度、环境湿度");
  assert.equal(actionPublicLabel(parseAgentAction("monitoring.set_visible_series", { slotIds: ["slot-1"] })), "仅显示环境温度");
  assert.equal(actionPublicLabel(parseAgentAction("spatial.set_layer", { layer: "slot-6" })), "查看环境光照空间图层");
});

test("页面区域定位会安全纠正唯一归属区域，同时拒绝未知和歧义区域", () => {
  const action = parseAgentAction("ui.focus_region", {
    page: "monitoring",
    region: "indicator-posture",
  });
  assert.deepEqual(action, {
    name: "ui.focus_region",
    arguments: { page: "monitoring", region: "indicator-posture" },
  });
  assert.equal(actionPublicLabel(action), "定位到指标态势");
  assert.doesNotThrow(() => parseAgentAction("ui.focus_region", {
    page: "monitoring",
    region: "spatial-distribution",
  }));
  assert.doesNotThrow(() => parseAgentAction("ui.focus_region", {
    page: "monitoring",
    region: "ai-recommendations",
  }));
  assert.deepEqual(parseAgentAction("ui.focus_region", {
    page: "monitoring",
    region: "inspection-map",
  }), {
    name: "ui.focus_region",
    arguments: { page: "vehicle", region: "inspection-map" },
  });
  const cameraFocus = parseAgentAction("ui.focus_region", {
    page: "vehicle",
    region: "vehicle-camera",
  });
  assert.deepEqual(cameraFocus, {
    name: "ui.focus_region",
    arguments: { page: "vehicle", region: "vehicle-camera" },
  });
  assert.equal(actionPublicLabel(cameraFocus), "定位到车载摄像头");
  assert.deepEqual(parseAgentAction("ui.focus_region", {
    page: "vehicle",
    region: "spatial-distribution",
  }), {
    name: "ui.focus_region",
    arguments: { page: "monitoring", region: "spatial-distribution" },
  });
  assert.doesNotThrow(() => parseAgentAction("ui.focus_region", {
    page: "overview",
    region: "vehicle-status",
  }));
  assert.doesNotThrow(() => parseAgentAction("ui.focus_region", {
    page: "vehicle",
    region: "vehicle-status",
  }));
  assert.throws(() => parseAgentAction("ui.focus_region", {
    page: "monitoring",
    region: "vehicle-status",
  }), /区域不能唯一确定页面/);
  assert.throws(() => parseAgentAction("ui.focus_region", {
    page: "monitoring",
    region: "#temperature-map",
  }), /区域参数无效/);
  assert.throws(() => parseAgentAction("ui.focus_region", {
    page: "monitoring",
    region: "spatial-distribution",
    selector: "#temperature-map",
  }), /额外参数 selector/);
  assert.throws(() => parseAgentAction("ui.focus_region", {
    page: "https://example.com",
    region: "indicator-posture",
  }), /页面参数无效/);
});

test("站内返回不接受 URL 或其他参数", () => {
  const action = parseAgentAction("ui.back", {});
  assert.deepEqual(action, { name: "ui.back", arguments: {} });
  assert.equal(actionPublicLabel(action), "返回上一页");
  assert.throws(() => parseAgentAction("ui.back", { url: "/settings" }), /额外参数 url/);
});

test("页面滚动只接受受限方向和幅度", () => {
  assert.deepEqual(parseAgentAction("ui.scroll", {
    page: "monitoring",
    direction: "down",
  }), {
    name: "ui.scroll",
    arguments: { page: "monitoring", direction: "down", amount: "page" },
  });
  assert.deepEqual(parseAgentAction("ui.scroll", {
    page: "vehicle",
    direction: "up",
    amount: "small",
  }), {
    name: "ui.scroll",
    arguments: { page: "vehicle", direction: "up", amount: "small" },
  });
  assert.deepEqual(parseAgentAction("ui.scroll", {
    page: "settings",
    direction: "top",
    amount: "small",
  }), {
    name: "ui.scroll",
    arguments: { page: "settings", direction: "top" },
  });
  assert.throws(() => parseAgentAction("ui.scroll", {
    page: "monitoring",
    direction: "left",
  }), /滚动方向参数无效/);
  assert.throws(() => parseAgentAction("ui.scroll", {
    page: "monitoring",
    direction: "down",
    amount: "200px",
  }), /滚动幅度参数无效/);
  assert.throws(() => parseAgentAction("ui.scroll", {
    page: "monitoring",
    direction: "down",
    selector: "#secret",
  }), /额外参数 selector/);
});

test("DeepSeek 官方工具名映射不会改变内部动作协议", () => {
  assert.equal(toDeepSeekToolName("twin.set_display_mode"), "twin__set_display_mode");
  assert.equal(fromDeepSeekToolName("twin__set_display_mode"), "twin.set_display_mode");
  assert.match(toDeepSeekToolName("vehicle.propose_move"), /^[a-zA-Z0-9_-]+$/);
});

test("监测曲线原子动作支持精确集合与单项显隐", () => {
  assert.deepEqual(parseAgentAction("monitoring.set_visible_series", { slotIds: ["slot-1", "slot-2"] }), {
    name: "monitoring.set_visible_series",
    arguments: { slotIds: ["slot-1", "slot-2"] },
  });
  assert.deepEqual(parseAgentAction("monitoring.set_series_visibility", { slotId: "slot-3", visible: false }), {
    name: "monitoring.set_series_visibility",
    arguments: { slotId: "slot-3", visible: false },
  });
  assert.throws(() => parseAgentAction("monitoring.set_visible_series", { slotIds: ["slot-8"] }), /可见曲线/);
  assert.throws(() => parseAgentAction("monitoring.set_visible_series", { slotIds: ["slot-1", "slot-1"] }), /不能包含重复项/);
});

test("监测页允许分析洞察标签与第六数据位", () => {
  assert.deepEqual(parseAgentAction("monitoring.set_tab", { tab: "analysis" }), {
    name: "monitoring.set_tab",
    arguments: { tab: "analysis" },
  });
  assert.deepEqual(parseAgentAction("telemetry.focus", { slotId: "slot-6" }), {
    name: "telemetry.focus",
    arguments: { slotId: "slot-6" },
  });
  assert.deepEqual(parseAgentAction("monitoring.set_visible_series", {
    slotIds: ["slot-1", "slot-2", "slot-3", "slot-4", "slot-5", "slot-6"],
  }).arguments, {
    slotIds: ["slot-1", "slot-2", "slot-3", "slot-4", "slot-5", "slot-6"],
  });
});

test("Agent 计划遵循客户端选择的思考模式", () => {
  assert.equal(choosePlanningMode("always", "查看温度", [
    { name: "telemetry.read_current", arguments: {} },
  ]), "thinking");
  assert.equal(choosePlanningMode("always", "只显示当前环境温度曲线"), "thinking");
  assert.equal(choosePlanningMode("always", "进入房间模型，从正上方用增强效果看一下缺失区域", [
    { name: "twin.set_view", arguments: { view: "top" } },
    { name: "twin.set_display_mode", arguments: { mode: "enhanced" } },
    { name: "twin.set_gap_diagnostic", arguments: { active: true } },
  ]), "thinking");
  assert.equal(choosePlanningMode("always", "环绕房间检查缺陷处"), "thinking");
  assert.equal(choosePlanningMode("always", "查看温度"), "thinking");
  assert.equal(choosePlanningMode("non-thinking", "查看温度"), "non-thinking");
  assert.equal(choosePlanningMode("thinking", "查看温度"), "thinking");
});

test("思考模式不会因任务复杂度被自动改写", () => {
  assert.equal(choosePlanningMode("always", "切为几何显示模式", [
    { name: "twin.set_display_mode", arguments: { mode: "geometry" } },
  ]), "thinking");
  assert.equal(choosePlanningMode("always", "检查房间", [
    { name: "twin.set_gap_diagnostic", arguments: { active: true } },
    { name: "twin.orbit", arguments: { revolutions: 1, durationMs: 9000, elevationDeg: 35, direction: "clockwise" } },
  ]), "thinking");
  assert.equal(choosePlanningMode("non-thinking", "检查房间", [
    { name: "twin.set_gap_diagnostic", arguments: { active: true } },
    { name: "twin.orbit", arguments: { revolutions: 1, durationMs: 9000, elevationDeg: 35, direction: "clockwise" } },
  ]), "non-thinking");
});

test("新增页面能力均使用细粒度白名单参数", () => {
  assert.deepEqual(parseAgentAction("monitoring.set_range", { range: "7d" }), {
    name: "monitoring.set_range", arguments: { range: "7d" },
  });
  assert.deepEqual(parseAgentAction("monitoring.generate_analysis", { slotIds: ["slot-1", "slot-2"] }), {
    name: "monitoring.generate_analysis", arguments: { slotIds: ["slot-1", "slot-2"] },
  });
  assert.deepEqual(parseAgentAction("spatial.set_layer", { layer: "slot-6" }), {
    name: "spatial.set_layer", arguments: { layer: "slot-6" },
  });
  assert.deepEqual(parseAgentAction("twin.set_point_size", { size: 0.012 }), {
    name: "twin.set_point_size", arguments: { size: 0.012 },
  });
  assert.deepEqual(parseAgentAction("settings.set_motion_speed", { percent: 55 }), {
    name: "settings.set_motion_speed", arguments: { percent: 55 },
  });
  assert.throws(() => parseAgentAction("twin.set_point_size", { size: 9 }), /size.*最大值/);
  assert.throws(() => parseAgentAction("settings.set_motion_speed", { percent: 53 }), /percent.*整数倍/);
  assert.throws(() => parseAgentAction("spatial.calibrate", { x: 2, y: 0.5, headingDeg: 0 }), /x.*最大值/);
});

test("工具参数严格遵循 schema：拒绝额外字段、缺失必填数值与类型偷换", () => {
  assert.throws(() => parseAgentAction("twin.reset_view", { force: true }), /额外参数 force/);
  assert.throws(() => parseAgentAction("twin.set_point_size", {}), /缺少必填参数 size/);
  assert.throws(() => parseAgentAction("twin.set_point_size", { size: "0.012" }), /size.*有限数值/);
  assert.throws(() => parseAgentAction("spatial.calibrate", { x: 0.5, y: 0.5 }), /缺少必填参数 headingDeg/);
  assert.throws(() => parseAgentAction("spatial.set_dimensions", { widthM: 4.7 }), /缺少必填参数 heightM/);
  assert.throws(() => parseAgentAction("spatial.set_dimensions", { widthM: 4.7, heightM: 7, turnRadiusM: 0.45 }), /额外参数 turnRadiusM/);
  assert.throws(() => parseAgentAction("vehicle.set_control_speed", {}), /缺少必填参数 speedPercent/);
});

test("空间标定角度与点尺寸使用注册 schema 的同一边界", () => {
  assert.deepEqual(parseAgentAction("spatial.calibrate", { x: 0.5, y: 0.25, headingDeg: -90 }), {
    name: "spatial.calibrate",
    arguments: { x: 0.5, y: 0.25, headingDeg: 270 },
  });
  assert.deepEqual(parseAgentAction("spatial.calibrate", { x: 0, y: 1, headingDeg: 720 }).arguments, {
    x: 0, y: 1, headingDeg: 0,
  });
  assert.throws(() => parseAgentAction("spatial.calibrate", { x: 0.5, y: 0.5, headingDeg: -361 }), /headingDeg.*最小值/);
  assert.throws(() => parseAgentAction("spatial.calibrate", { x: 0.5, y: 0.5, headingDeg: 721 }), /headingDeg.*最大值/);
  assert.deepEqual(parseAgentAction("twin.set_point_size", { size: 0.004 }).arguments, { size: 0.004 });
  assert.deepEqual(parseAgentAction("twin.set_point_size", { size: 0.024 }).arguments, { size: 0.024 });
  assert.throws(() => parseAgentAction("twin.set_point_size", { size: 0.0039 }), /size.*最小值/);
  assert.throws(() => parseAgentAction("twin.set_point_size", { size: 0.0241 }), /size.*最大值/);
});

test("跨页面原子动作由计划编译器补齐对应页面", () => {
  assert.deepEqual(compileAgentPlan([
    { name: "spatial.set_layer", arguments: { layer: "slot-2" } },
    { name: "connections.refresh", arguments: {} },
    { name: "settings.set_motion_speed", arguments: { percent: 50 } },
    { name: "settings.save", arguments: {} },
  ]), [
    { name: "ui.navigate", arguments: { page: "vehicle" } },
    { name: "spatial.set_layer", arguments: { layer: "slot-2" } },
    { name: "ui.navigate", arguments: { page: "integrations" } },
    { name: "connections.refresh", arguments: {} },
    { name: "ui.navigate", arguments: { page: "settings" } },
    { name: "settings.set_motion_speed", arguments: { percent: 50 } },
    { name: "settings.save", arguments: {} },
  ]);
});

test("独立请求隔离历史，只有明确承接时才使用上下文", () => {
  const history = [
    { role: "user" as const, content: "环绕房间检查缺口" },
    { role: "assistant" as const, content: "正在执行巡检" },
  ];
  assert.deepEqual(selectRelevantConversationHistory("切为几何显示模式", history), []);
  assert.deepEqual(selectRelevantConversationHistory("继续，把它换成几何模式", history), history);
});

test("多步车辆规划必须覆盖完整路径并满足闭环约束", () => {
  const requirements = {
    minimumMovementActions: 7,
    minimumDistanceActions: 4,
    minimumTurnActions: 3,
    requiresClosedPosition: true,
    requiresOriginalHeading: false,
  };
  const incomplete = [
    parseAgentAction("vehicle.move_distance", {
      direction: "forward",
      distanceMm: 1000,
    }),
  ];
  const incompleteIssues = validateVehiclePlanCompleteness(requirements, incomplete);
  assert.ok(incompleteIssues.some((issue) => issue.includes("候选计划只有 1 个")));
  assert.ok(incompleteIssues.some((issue) => issue.includes("未回到原点")));

  const complete = [
    parseAgentAction("vehicle.move_distance", { direction: "forward", distanceMm: 1000 }),
    parseAgentAction("vehicle.turn_angle", { direction: "right", angleDeg: 90 }),
    parseAgentAction("vehicle.move_distance", { direction: "forward", distanceMm: 1000 }),
    parseAgentAction("vehicle.turn_angle", { direction: "right", angleDeg: 90 }),
    parseAgentAction("vehicle.move_distance", { direction: "forward", distanceMm: 1000 }),
    parseAgentAction("vehicle.turn_angle", { direction: "right", angleDeg: 90 }),
    parseAgentAction("vehicle.move_distance", { direction: "forward", distanceMm: 1000 }),
  ];
  assert.deepEqual(validateVehiclePlanCompleteness(requirements, complete), []);
});

test("空间环绕动作提供稳定默认值并限制极端参数", () => {
  assert.deepEqual(parseAgentAction("twin.orbit", {}), {
    name: "twin.orbit",
    arguments: { revolutions: 1, durationMs: 9000, elevationDeg: 35, direction: "clockwise" },
  });
  assert.deepEqual(parseAgentAction("twin.orbit", {
    revolutions: 3,
    durationMs: 20_000,
    elevationDeg: 10,
    direction: "counterclockwise",
  }), {
    name: "twin.orbit",
    arguments: { revolutions: 3, durationMs: 20_000, elevationDeg: 10, direction: "counterclockwise" },
  });
  assert.throws(() => parseAgentAction("twin.orbit", {
    revolutions: 9,
    durationMs: 99_000,
    elevationDeg: -20,
    direction: "counterclockwise",
  }), /revolutions.*最大值/);
  assert.throws(() => parseAgentAction("twin.orbit", { direction: "up" }), /环绕方向/);
});

test("显式环绕意图不会因模型漏调工具而退化成只打开页面", () => {
  assert.deepEqual(ensureExplicitActionCoverage("环绕房间检查一下缺陷处", [
    { name: "ui.navigate", arguments: { page: "digital-twin" } },
  ]), [
    { name: "ui.navigate", arguments: { page: "digital-twin" } },
    { name: "twin.set_gap_diagnostic", arguments: { active: true } },
    {
      name: "twin.orbit",
      arguments: { revolutions: 1, durationMs: 9000, elevationDeg: 35, direction: "clockwise" },
    },
  ]);
  assert.equal(ensureExplicitActionCoverage("不要环绕，只打开空间孪生", []).length, 0);
  assert.deepEqual(ensureExplicitActionCoverage("环绕房间，不用打开缺口层", []), [{
    name: "twin.orbit",
    arguments: { revolutions: 1, durationMs: 9000, elevationDeg: 35, direction: "clockwise" },
  }]);
});

test("计划编译器为页面内动作补齐公开导航步骤", () => {
  assert.deepEqual(compileAgentPlan([
    { name: "monitoring.set_tab", arguments: { tab: "live" } },
    { name: "monitoring.set_visible_series", arguments: { slotIds: ["slot-1"] } },
  ]), [
    { name: "ui.navigate", arguments: { page: "monitoring" } },
    { name: "monitoring.set_tab", arguments: { tab: "live" } },
    { name: "monitoring.set_visible_series", arguments: { slotIds: ["slot-1"] } },
  ]);
});

test("区域定位会补齐导航与隐藏视图前置动作且不重复", () => {
  assert.deepEqual(compileAgentPlan([
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "indicator-posture" } },
  ], "overview"), [
    { name: "ui.navigate", arguments: { page: "monitoring" } },
    { name: "monitoring.set_tab", arguments: { tab: "analysis" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "indicator-posture" } },
  ]);

  assert.deepEqual(compileAgentPlan([
    { name: "monitoring.set_tab", arguments: { tab: "analysis" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "ai-analysis" } },
  ], "monitoring"), [
    { name: "monitoring.set_tab", arguments: { tab: "analysis" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "ai-analysis" } },
  ]);

  assert.deepEqual(compileAgentPlan([
    { name: "ui.focus_region", arguments: { page: "settings", region: "diagnostics" } },
    { name: "ui.focus_region", arguments: { page: "digital-twin", region: "device-panel" } },
  ]), [
    { name: "ui.navigate", arguments: { page: "settings" } },
    { name: "settings.set_section", arguments: { section: "diagnostics" } },
    { name: "ui.focus_region", arguments: { page: "settings", region: "diagnostics" } },
    { name: "ui.navigate", arguments: { page: "digital-twin" } },
    { name: "twin.open_panel", arguments: { panel: "devices" } },
    { name: "ui.focus_region", arguments: { page: "digital-twin", region: "device-panel" } },
  ]);

  assert.deepEqual(compileAgentPlan([
    { name: "ui.focus_region", arguments: { page: "vehicle", region: "spatial-distribution" } },
  ], "vehicle"), [
    { name: "ui.navigate", arguments: { page: "monitoring" } },
    { name: "monitoring.set_tab", arguments: { tab: "analysis" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "spatial-distribution" } },
  ]);

  assert.deepEqual(compileAgentPlan([
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "inspection-map" } },
  ], "monitoring"), [
    { name: "ui.navigate", arguments: { page: "vehicle" } },
    { name: "ui.focus_region", arguments: { page: "vehicle", region: "inspection-map" } },
  ]);

  assert.throws(() => compileAgentPlan([
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "vehicle-status" } },
  ]), /区域不能唯一确定页面/);
});

test("安全页面滚动会自动打开目标页面", () => {
  assert.deepEqual(compileAgentPlan([
    { name: "ui.scroll", arguments: { page: "monitoring", direction: "down", amount: "page" } },
  ], "overview"), [
    { name: "ui.navigate", arguments: { page: "monitoring" } },
    { name: "ui.scroll", arguments: { page: "monitoring", direction: "down", amount: "page" } },
  ]);
});

test("站内返回后后续页面动作会重新补齐导航", () => {
  assert.deepEqual(compileAgentPlan([
    { name: "ui.back", arguments: {} },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "ai-problems" } },
  ], "settings"), [
    { name: "ui.back", arguments: {} },
    { name: "ui.navigate", arguments: { page: "monitoring" } },
    { name: "monitoring.set_tab", arguments: { tab: "analysis" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "ai-problems" } },
  ]);
});

test("目标屏幕已在所需页面时不重复生成导航步骤", () => {
  assert.deepEqual(compileAgentPlan([
    { name: "ui.navigate", arguments: { page: "digital-twin" } },
    { name: "twin.set_display_mode", arguments: { mode: "geometry" } },
  ], "digital-twin"), [
    { name: "twin.set_display_mode", arguments: { mode: "geometry" } },
  ]);
});

test("计划编译器自动移除完整权限下的冗余车辆确认而不阻断合法动作", () => {
  const proposed = compileAgentPlanWithDiagnostics([
    { name: "vehicle.propose_move", arguments: { motion: "forward", speedPercent: 20, durationMs: 1000 } },
    { name: "vehicle.confirm", arguments: {} },
  ]);
  assert.deepEqual(proposed.actions, [
    { name: "vehicle.propose_move", arguments: { motion: "forward", speedPercent: 20, durationMs: 1000 } },
  ]);
  assert.match(proposed.warnings.join("；"), /跳过冗余确认/);
  assert.doesNotThrow(() => compileAgentPlan([
    { name: "vehicle.confirm", arguments: {} },
  ]));
  assert.doesNotThrow(() => compileAgentPlan([
    { name: "vehicle.stop", arguments: {} },
  ]));
  assert.deepEqual(compileAgentPlan([
    { name: "vehicle.move_distance", arguments: { direction: "forward", distanceMm: 100 } },
    { name: "vehicle.turn_angle", arguments: { direction: "left", angleDeg: 90 } },
  ]), [
    { name: "vehicle.move_distance", arguments: { direction: "forward", distanceMm: 100, maxSpeedMmps: 300 } },
    { name: "vehicle.turn_angle", arguments: { direction: "left", angleDeg: 90, maxSpeedMmps: 300 } },
  ]);
  const turned = compileAgentPlanWithDiagnostics([
    { name: "vehicle.turn_angle", arguments: { direction: "left", angleDeg: 90 } },
    { name: "vehicle.confirm", arguments: {} },
  ]);
  assert.deepEqual(turned.actions, [
    { name: "vehicle.turn_angle", arguments: { direction: "left", angleDeg: 90, maxSpeedMmps: 300 } },
  ]);
  assert.equal(turned.warnings.length, 1);
});

test("空间尺寸、标定和移动动作不再被应用层整计划阻断", () => {
  const dimensions = { name: "spatial.set_dimensions", arguments: { widthM: 4.7, heightM: 7 } } as const;
  assert.doesNotThrow(() => compileAgentPlan([
    dimensions,
    { name: "spatial.begin_calibration", arguments: {} },
  ]));
  assert.doesNotThrow(() => compileAgentPlan([
    dimensions,
    { name: "spatial.calibrate", arguments: { x: 0.5, y: 0.5, headingDeg: 0 } },
  ]));
  assert.doesNotThrow(() => compileAgentPlan([
    dimensions,
    { name: "vehicle.propose_move", arguments: { motion: "forward", speedPercent: 10, durationMs: 500 } },
  ]));
  assert.doesNotThrow(() => compileAgentPlan([dimensions]));
});

test("公开语义摘要只接受严格 JSON、白名单目标与命名证据", () => {
  const brief = parseSemanticIntentBrief(JSON.stringify({
    goal: "variation",
    summary: "判断近期温度波动幅度与发生时段",
    subjects: [{ label: "环境温度", slotId: "slot-1" }],
    timeRange: "24h",
    primaryEvidence: "daily-heatmap",
    supportingEvidence: ["indicator-posture"],
    evidenceSummary: "使用24小时日内热力图，并以指标态势核对波动幅度",
    successCriterion: "最终聚焦能体现温度变化大小的图表",
  }));
  assert.equal(brief.goal, "variation");
  assert.equal(brief.primaryEvidence, "daily-heatmap");
  assert.deepEqual(brief.subjects, [{ label: "环境温度", slotId: "slot-1" }]);
  assert.throws(() => parseSemanticIntentBrief(JSON.stringify({
    ...brief,
    primaryEvidence: "raw-dom-selector",
  })), /主证据无效/);
  assert.throws(() => parseSemanticIntentBrief(JSON.stringify({
    ...brief,
    subjects: [{ label: "环境温度", slotId: "slot-9" }],
  })), /数据位无效/);
});

test("变化大小意图不会退化为当前值，而会以热力图作为最终证据", () => {
  const semantic = inferLocalSemanticBrief("我想看看最近的温度变化大不大");
  assert.equal(semantic.goal, "variation");
  assert.equal(semantic.primaryEvidence, "daily-heatmap");
  assert.equal(semantic.timeRange, "24h");
  const actions = ensureSemanticEvidenceCoverage("我想看看最近的温度变化大不大", semantic, [
    { name: "telemetry.read_current", arguments: { slotId: "slot-1" } },
  ]);
  assert.equal(actions.some((action) => action.name === "telemetry.read_current"), false);
  assert.deepEqual(actions, [
    { name: "monitoring.set_range", arguments: { range: "24h" } },
    { name: "telemetry.focus", arguments: { slotId: "slot-1" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "indicator-posture" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "daily-heatmap" } },
  ]);
});

test("生产语义不再由本地关键词规则改写 AI 的意图判断", () => {
  const reconciled = reconcileSemanticIntent("我想看看最近的温度变化大不大", {
    goal: "variation",
    summary: "分析近期数据变化情况",
    subjects: [{ label: "未知指标" }],
    timeRange: "24h",
    primaryEvidence: "daily-heatmap",
    supportingEvidence: ["indicator-posture"],
    evidenceSummary: "使用日内热力图和指标态势",
    successCriterion: "识别变化较大的时段",
  });
  assert.deepEqual(reconciled.subjects, [{ label: "未知指标" }]);
  assert.equal(reconciled.summary, "分析近期数据变化情况");
});

test("语义证据规划覆盖趋势、空间分布、连接、车辆状态与问题建议", () => {
  const trend = inferLocalSemanticBrief("看看最近一周温度是不是一直在上升");
  assert.deepEqual({ goal: trend.goal, range: trend.timeRange, primary: trend.primaryEvidence }, {
    goal: "trend", range: "7d", primary: "indicator-posture",
  });

  const spatial = ensureSemanticEvidenceCoverage(
    "房间里哪里温度更高",
    inferLocalSemanticBrief("房间里哪里温度更高"),
    [],
  );
  assert.deepEqual(spatial.at(-1), {
    name: "ui.focus_region",
    arguments: { page: "monitoring", region: "spatial-distribution" },
  });

  const connection = ensureSemanticEvidenceCoverage(
    "看看华为云传感器连接是否正常",
    inferLocalSemanticBrief("看看华为云传感器连接是否正常"),
    [],
  );
  assert.equal(connection[0]?.name, "connections.refresh");
  assert.deepEqual(connection.at(-1), {
    name: "ui.focus_region",
    arguments: { page: "integrations", region: "sensor-connection" },
  });

  const vehicle = ensureSemanticEvidenceCoverage(
    "我想看看小车当前回传状态",
    inferLocalSemanticBrief("我想看看小车当前回传状态"),
    [],
  );
  assert.deepEqual(vehicle, [{
    name: "ui.focus_region",
    arguments: { page: "vehicle", region: "vehicle-status" },
  }]);

  const camera = ensureSemanticEvidenceCoverage(
    "看看小车的实时摄像头画面",
    inferLocalSemanticBrief("看看小车的实时摄像头画面"),
    [],
  );
  assert.deepEqual(camera, [{
    name: "ui.focus_region",
    arguments: { page: "vehicle", region: "vehicle-camera" },
  }]);

  const advice = ensureSemanticEvidenceCoverage(
    "分析最近温度湿度的问题并给我建议",
    inferLocalSemanticBrief("分析最近温度湿度的问题并给我建议"),
    [],
  );
  assert.deepEqual(advice.filter((action) => action.name === "monitoring.generate_analysis"), [{
    name: "monitoring.generate_analysis",
    arguments: { slotIds: ["slot-1", "slot-2"] },
  }]);
  assert.deepEqual(advice.slice(-2), [
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "ai-problems" } },
    { name: "ui.focus_region", arguments: { page: "monitoring", region: "ai-recommendations" } },
  ]);
});

test("模拟模式仍使用同一组受限动作", async () => {
  const config = {
    mockMode: true,
    deepSeekApiKey: "",
    dashScopeApiKey: "",
  } as AgentGatewayConfig;
  const stop = await decideWithDeepSeek(config, "急停", []);
  assert.equal(stop.actions[0]?.name, "vehicle.stop");
  const move = await decideWithDeepSeek(config, "让小车前进", []);
  assert.deepEqual(move.actions[0], {
    name: "vehicle.propose_move",
    arguments: { motion: "forward", speedPercent: 20, durationMs: 1000 },
  });
  const distance = await decideWithDeepSeek(config, "让小车向前走 0.1 米", []);
  assert.deepEqual(distance.actions[0], {
    name: "vehicle.move_distance",
    arguments: { direction: "forward", distanceMm: 100, maxSpeedMmps: 300 },
  });
  const turn = await decideWithDeepSeek(config, "让小车向右转 90 度", []);
  assert.deepEqual(turn.actions[0], {
    name: "vehicle.turn_angle",
    arguments: { direction: "right", angleDeg: 90, maxSpeedMmps: 300 },
  });
  const focus = await decideWithDeepSeek(config, "看看指标态势", []);
  assert.deepEqual(focus.actions, [{
    name: "ui.focus_region",
    arguments: { page: "monitoring", region: "indicator-posture" },
  }]);
  const variation = await decideWithDeepSeek(config, "我想看看最近的温度变化大不大", []);
  assert.equal(variation.semantic.goal, "variation");
  assert.equal(variation.actions.some((action) => action.name === "telemetry.read_current"), false);
  assert.deepEqual(variation.actions.at(-1), {
    name: "ui.focus_region",
    arguments: { page: "monitoring", region: "daily-heatmap" },
  });
  const back = await decideWithDeepSeek(config, "返回上一页", []);
  assert.deepEqual(back.actions, [{ name: "ui.back", arguments: {} }]);
});

test("告警能力开放受权限保护的工单原子动作，但不开放阈值修改", () => {
  assert.deepEqual(parseAgentAction("alerts.set_tab", { tab: "pending" }), {
    name: "alerts.set_tab",
    arguments: { tab: "pending" },
  });
  assert.deepEqual(parseAgentAction("alerts.set_severity_filter", { severity: "critical" }), {
    name: "alerts.set_severity_filter",
    arguments: { severity: "critical" },
  });
  assert.equal(requiredPageForAction(parseAgentAction("alerts.refresh", {})), "alerts");
  assert.deepEqual(parseAgentAction("alerts.begin_processing", { alertId: "alert-1", expectedVersion: 2 }), {
    name: "alerts.begin_processing",
    arguments: { alertId: "alert-1", expectedVersion: 2 },
  });
  assert.deepEqual(parseAgentAction("alerts.complete_work_order", {
    alertId: "alert-1",
    expectedVersion: 3,
    action: "sensor-check",
    note: "已根据数据复核传感器状态",
  }), {
    name: "alerts.complete_work_order",
    arguments: {
      alertId: "alert-1",
      expectedVersion: 3,
      action: "sensor-check",
      note: "已根据数据复核传感器状态",
    },
  });
  assert.equal(requiredPageForAction(parseAgentAction("alerts.begin_processing", { alertId: "alert-1", expectedVersion: 2 })), "alerts");
  assert.equal(AGENT_TOOL_DEFINITIONS.some((tool) => String(tool.function.name) === "alerts.rules.save"), false);
  assert.throws(() => parseAgentAction("alerts.complete_work_order", {
    alertId: "alert-1", expectedVersion: 0, action: "sensor-check", note: "x",
  }), /版本|长度|最小值/);
  assert.throws(() => parseAgentAction("alerts.complete", { alertId: "x" }), /未知|授权/);
});
