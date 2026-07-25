import { TELEMETRY_SLOT_IDS, type TelemetrySlotId } from "@/app/lib/iot/contracts";
import {
  UI_REGION_IDS,
  type AgentAction,
  type AgentActionName,
  type UiPage,
  type UiRegion,
} from "./contracts";

export interface AgentToolDefinition {
  type: "function";
  function: {
    name: AgentActionName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const EMPTY_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const UI_PAGES = Object.keys(UI_REGION_IDS) as UiPage[];
const ALL_UI_REGIONS = [...new Set(Object.values(UI_REGION_IDS).flat())];
const UI_REGION_PAGES = new Map<string, UiPage[]>();
const TELEMETRY_SLOT_LABELS: Record<TelemetrySlotId, string> = {
  "slot-1": "环境温度",
  "slot-2": "环境湿度",
  "slot-3": "二氧化碳",
  "slot-4": "TVOC",
  "slot-5": "甲醛",
  "slot-6": "环境光照",
};

for (const page of UI_PAGES) {
  for (const region of UI_REGION_IDS[page]) {
    const pages = UI_REGION_PAGES.get(region) ?? [];
    if (!pages.includes(page)) pages.push(page);
    UI_REGION_PAGES.set(region, pages);
  }
}

export const UI_REGION_LABELS: Record<UiRegion, string> = {
  telemetry: "核心遥测",
  "spatial-overview": "空间态势",
  "vehicle-status": "车辆状态",
  "recent-events": "实时事件",
  "metric-cards": "实时指标",
  "live-chart": "实时趋势曲线",
  "slot-details": "指标详情",
  "analysis-summary": "分析汇总",
  "indicator-posture": "指标态势",
  "ai-analysis": "AI 分析建议",
  "ai-problems": "AI 问题描述",
  "ai-recommendations": "AI 处理建议",
  "range-profile": "范围画像",
  "correlation-matrix": "相关矩阵",
  "daily-heatmap": "日内热力图",
  "spatial-distribution": "空间分布",
  "history-table": "历史观测表",
  "event-timeline": "事件时间线",
  "inspection-map": "空间孪生巡检",
  "vehicle-camera": "车载摄像头",
  "manual-controls": "手动驾驶",
  "command-log": "操作记录",
  "alert-summary": "告警概况",
  "alert-list": "告警列表",
  "alert-detail": "告警详情",
  "alert-timeline": "处理时间线",
  "alert-rules": "告警规则",
  viewport: "空间视口",
  "scene-panel": "场景面板",
  "device-panel": "设备面板",
  "display-panel": "显示面板",
  "connection-summary": "连接概况",
  "sensor-connection": "传感器连接",
  "vehicle-connection": "小车连接",
  "ai-connection": "AI 智能中枢连接",
  "account-security": "账户与安全",
  "refresh-settings": "数据刷新设置",
  "vehicle-settings": "车辆控制设置",
  "model-storage": "模型与存储",
  diagnostics: "本机诊断",
};

export const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  tool("ui.navigate", "打开上位机中的指定页面。", {
    type: "object",
    properties: { page: { type: "string", enum: ["overview", "digital-twin", "vehicle", "monitoring", "alerts", "integrations", "settings"] } },
    required: ["page"], additionalProperties: false,
  }),
  tool("ui.back", "返回当前目标屏幕的上一个站内页面。只使用应用自身的导航历史，不接受 URL 或跳转目标。", EMPTY_PARAMETERS),
  tool("ui.focus_region", "打开指定页面，平滑滚动到命名区域并用边框高亮提示。用于‘看看指标态势’、‘定位到 AI 建议’等需要把内容带到视野中的请求；只可使用已列出的页面和区域标识。", {
    type: "object",
    properties: {
      page: { type: "string", enum: ["overview", "digital-twin", "vehicle", "monitoring", "alerts", "integrations", "settings"] },
      region: {
        type: "string",
        enum: ALL_UI_REGIONS,
        description: "命名区域：indicator-posture=指标态势，ai-analysis=AI 分析建议，ai-problems=问题描述，ai-recommendations=处理建议，range-profile=范围画像，correlation-matrix=相关矩阵，daily-heatmap=日内热力图，spatial-distribution=空间分布，live-chart=实时趋势，history-table=历史观测表，event-timeline=事件时间线，inspection-map=空间孪生巡检，vehicle-camera=车载摄像头，manual-controls=手动驾驶；其他值按英文语义选择。",
      },
    },
    required: ["page", "region"], additionalProperties: false,
  }),
  tool("ui.scroll", "在指定页面安全地向上、向下滚动，或回到顶部、前往底部。用于‘再往下看’、‘回到顶部’等相对浏览请求；不接受像素、选择器或任意 URL。", {
    type: "object",
    properties: {
      page: { type: "string", enum: ["overview", "digital-twin", "vehicle", "monitoring", "alerts", "integrations", "settings"] },
      direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
      amount: { type: "string", enum: ["small", "page"], description: "仅用于向上或向下；默认滚动一页。" },
    },
    required: ["page", "direction"], additionalProperties: false,
  }),
  tool("telemetry.read_current", "读取当前传感器数据；用户未指定时读取全部六个数据位。", {
    type: "object",
    properties: { slotId: { type: "string", enum: TELEMETRY_SLOT_IDS } },
    additionalProperties: false,
  }),
  tool("telemetry.inspect_current", "在车辆到达检查点后等待 2 秒，再清除网关读取缓存并读取真实六路传感器数据，给出阈值检测结论。可选指定数据位。", {
    type: "object",
    properties: {
      slotIds: {
        type: "array",
        items: { type: "string", enum: TELEMETRY_SLOT_IDS },
        minItems: 1,
        maxItems: TELEMETRY_SLOT_IDS.length,
        uniqueItems: true,
      },
    },
    additionalProperties: false,
  }),
  tool("telemetry.focus", "打开监测页并突出指定数据位。", {
    type: "object",
    properties: { slotId: { type: "string", enum: TELEMETRY_SLOT_IDS } },
    required: ["slotId"], additionalProperties: false,
  }),
  tool("monitoring.set_tab", "切换数据监测页的实时趋势、分析洞察、历史数据或事件标签。", {
    type: "object",
    properties: { tab: { type: "string", enum: ["live", "analysis", "history", "events"] } },
    required: ["tab"], additionalProperties: false,
  }),
  tool("monitoring.set_visible_series", "精确设置实时趋势图中可见的曲线集合。用于只看一项、比较多项、显示全部或隐藏全部。", {
    type: "object",
    properties: {
      slotIds: { type: "array", items: { type: "string", enum: TELEMETRY_SLOT_IDS }, uniqueItems: true, maxItems: TELEMETRY_SLOT_IDS.length },
    },
    required: ["slotIds"], additionalProperties: false,
  }),
  tool("monitoring.set_series_visibility", "单独显示或隐藏实时趋势图中的一个数据位，不改变其他曲线。", {
    type: "object",
    properties: {
      slotId: { type: "string", enum: TELEMETRY_SLOT_IDS },
      visible: { type: "boolean" },
    },
    required: ["slotId", "visible"], additionalProperties: false,
  }),
  tool("monitoring.set_range", "设置分析洞察或历史数据的时间范围。", {
    type: "object",
    properties: { range: { type: "string", enum: ["1h", "24h", "7d", "30d"] } },
    required: ["range"], additionalProperties: false,
  }),
  tool("monitoring.generate_analysis", "使用当前客户端选择的 Flash 思考设置，为指定数据位生成当前时间范围的 AI 分析；未指定时分析全部六路数据。", {
    type: "object",
    properties: {
      slotIds: { type: "array", items: { type: "string", enum: TELEMETRY_SLOT_IDS }, uniqueItems: true, minItems: 1, maxItems: TELEMETRY_SLOT_IDS.length },
    },
    additionalProperties: false,
  }),
  tool("monitoring.set_paused", "显式冻结或恢复监测页的实时画面。", {
    type: "object",
    properties: { paused: { type: "boolean" } },
    required: ["paused"], additionalProperties: false,
  }),
  tool("monitoring.refresh", "立即刷新监测页的当前数据。", EMPTY_PARAMETERS),
  tool("twin.set_view", "设置空间孪生的标准观察视角。", {
    type: "object",
    properties: { view: { type: "string", enum: ["perspective", "top", "front", "left", "right"] } },
    required: ["view"], additionalProperties: false,
  }),
  tool("twin.set_display_mode", "切换空间孪生的彩色、增强或几何显示模式。", {
    type: "object",
    properties: { mode: { type: "string", enum: ["color", "enhanced", "geometry"] } },
    required: ["mode"], additionalProperties: false,
  }),
  tool("twin.set_gap_diagnostic", "显示或隐藏点云缺口诊断层。", {
    type: "object",
    properties: { active: { type: "boolean" } },
    required: ["active"], additionalProperties: false,
  }),
  tool("twin.set_point_size", "设置空间孪生彩色点云的点尺寸。", {
    type: "object",
    properties: { size: { type: "number", minimum: 0.004, maximum: 0.024 } },
    required: ["size"], additionalProperties: false,
  }),
  tool("twin.open_panel", "打开空间孪生的场景、设备或显示控制面板。", {
    type: "object",
    properties: { panel: { type: "string", enum: ["scene", "devices", "display"] } },
    required: ["panel"], additionalProperties: false,
  }),
  tool("twin.close_panels", "收起空间孪生的控制面板。", EMPTY_PARAMETERS),
  tool("twin.reset_view", "重新拟合模型边界并恢复完整俯视画面。", EMPTY_PARAMETERS),
  tool("twin.capture", "保存当前空间孪生画面截图。仅在用户明确要求截图或保存画面时使用。", EMPTY_PARAMETERS),
  tool("twin.orbit", "围绕空间模型中心连续环绕观察。适合环视房间、绕一圈、从四周巡检或配合缺口诊断查看缺陷；不要用离散标准视角代替环绕。", {
    type: "object",
    properties: {
      revolutions: { type: "number", minimum: 0.25, maximum: 3, description: "环绕圈数，默认一圈。" },
      durationMs: { type: "integer", minimum: 2000, maximum: 20000, description: "总时长（毫秒），默认 9000。" },
      elevationDeg: { type: "number", minimum: 10, maximum: 75, description: "相对房间水平面的观察仰角，默认 35 度。" },
      direction: { type: "string", enum: ["clockwise", "counterclockwise"], description: "环绕方向，默认顺时针。" },
    },
    additionalProperties: false,
  }),
  tool("spatial.set_layer", "切换小车空间巡检地图的位置层或六路传感器分布图层。", {
    type: "object",
    properties: { layer: { type: "string", enum: ["position", ...TELEMETRY_SLOT_IDS] } },
    required: ["layer"], additionalProperties: false,
  }),
  tool("spatial.begin_calibration", "进入小车起点标定模式，等待用户在地图上点击并拖动朝向。不要替用户猜测落点。", EMPTY_PARAMETERS),
  tool("spatial.calibrate", "按用户明确提供的归一化地图坐标和朝向标定小车起点。", {
    type: "object",
    properties: {
      x: { type: "number", minimum: 0, maximum: 1 },
      y: { type: "number", minimum: 0, maximum: 1 },
      headingDeg: { type: "number", minimum: -360, maximum: 720 },
    },
    required: ["x", "y", "headingDeg"], additionalProperties: false,
  }),
  tool("spatial.set_dimensions", "设置巡检地图房间宽高；该动作会使现有定位需要重新标定。", {
    type: "object",
    properties: {
      widthM: { type: "number", minimum: 2, maximum: 20 },
      heightM: { type: "number", minimum: 2, maximum: 20 },
    },
    required: ["widthM", "heightM"], additionalProperties: false,
  }),
  tool("vehicle.set_control_speed", "设置人工遥控器的目标速度；不会直接让小车移动。", {
    type: "object",
    properties: { speedPercent: { type: "number", minimum: 10, maximum: 100 } },
    required: ["speedPercent"], additionalProperties: false,
  }),
  tool("vehicle.propose_move", "执行一次限时小车移动。客户端未授权时创建确认请求；已开启 AI 自主小车控制时直接执行并在时长结束后停车。", {
    type: "object",
    properties: {
      motion: { type: "string", enum: ["forward", "backward", "left", "right"], description: "车辆动作：前进、后退、左转或右转。left/right 不是横移。" },
      speedPercent: { type: "number", exclusiveMinimum: 0, maximum: 100 },
      durationMs: { type: "integer", minimum: 1 },
    },
    required: ["motion"], additionalProperties: false,
  }),
  tool("vehicle.move_distance", "按 Jetson 距离 PID 前进或后退指定毫米数。只有收到同一 request_id 的 completed 回执才算完成；未授权时创建确认请求。", {
    type: "object",
    properties: {
      direction: { type: "string", enum: ["forward", "backward"], description: "前进或后退。" },
      distanceMm: { type: "number", exclusiveMinimum: 0, description: "目标距离，单位毫米；仅要求为有限正数，不设置人工距离上限。" },
      maxSpeedMmps: { type: "number", exclusiveMinimum: 0, description: "PID 最大轮速，单位毫米每秒；默认 300，不设置应用层上限。" },
      timeoutS: { type: "number", exclusiveMinimum: 0, description: "任务超时，单位秒；省略时按距离与速度计算，不设置应用层上限。" },
    },
    required: ["direction", "distanceMm"], additionalProperties: false,
  }),
  tool("vehicle.turn_angle", "按 Jetson 航向 PID 向左或向右转动指定角度。只有收到同一 request_id 的 completed 回执才算完成；未授权时创建确认请求。", {
    type: "object",
    properties: {
      direction: { type: "string", enum: ["left", "right"], description: "左转或右转。" },
      angleDeg: { type: "number", exclusiveMinimum: 0, description: "目标转角，单位度；支持任意有限正角度和连续旋转，不设置应用层上限。" },
      maxSpeedMmps: { type: "number", exclusiveMinimum: 0, description: "PID 最大轮速，单位毫米每秒；默认 300，不设置应用层上限。" },
      timeoutS: { type: "number", exclusiveMinimum: 0, description: "任务超时，单位秒；省略时按角度计算，不设置应用层上限。" },
    },
    required: ["direction", "angleDeg"], additionalProperties: false,
  }),
  tool("vehicle.navigate_to_checkpoint", "前往客户端已经保存的固定检查点。必须使用运行时上下文列出的中文名称；坐标由网关解析并复用 Jetson navigation_plan → navigation_start → completed 闭环，禁止猜测坐标。", {
    type: "object",
    properties: {
      checkpointName: { type: "string" },
    },
    required: ["checkpointName"],
    additionalProperties: false,
  }),
  tool("vehicle.confirm", "确认当前待执行的小车移动。", EMPTY_PARAMETERS),
  tool("vehicle.cancel", "取消当前待执行的小车移动。", EMPTY_PARAMETERS),
  tool("vehicle.stop", "立即停止小车。无需二次确认。", EMPTY_PARAMETERS),
  tool("connections.refresh", "重新检查传感器、Jetson 小车与 AI 智能中枢连接状态。", EMPTY_PARAMETERS),
  tool("alerts.refresh", "刷新告警列表和汇总。只读取数据，不处理工单。", EMPTY_PARAMETERS),
  tool("alerts.set_tab", "切换告警管理中的未处理、处理中、已完成或告警规则标签。", {
    type: "object", properties: { tab: { type: "string", enum: ["pending", "processing", "completed", "rules"] } }, required: ["tab"], additionalProperties: false,
  }),
  tool("alerts.set_severity_filter", "按严重程度筛选告警列表。", {
    type: "object", properties: { severity: { type: "string", enum: ["all", "info", "warning", "critical"] } }, required: ["severity"], additionalProperties: false,
  }),
  tool("alerts.set_slot_filter", "按传感器指标筛选告警列表。", {
    type: "object", properties: { slotId: { type: "string", enum: ["all", ...TELEMETRY_SLOT_IDS] } }, required: ["slotId"], additionalProperties: false,
  }),
  tool("alerts.open_detail", "打开已知告警编号的详情，只用于查看和讲解，不能代替用户处理工单。", {
    type: "object", properties: { alertId: { type: "string", minLength: 1, maxLength: 128 } }, required: ["alertId"], additionalProperties: false,
  }),
  tool("alerts.begin_processing", "在用户已开启 AI 工单处理权限时开始处理指定告警。必须使用运行时上下文提供的真实告警编号与版本。", {
    type: "object",
    properties: {
      alertId: { type: "string", minLength: 1, maxLength: 128 },
      expectedVersion: { type: "integer", minimum: 1 },
    },
    required: ["alertId", "expectedVersion"], additionalProperties: false,
  }),
  tool("alerts.complete_work_order", "在用户已开启 AI 工单处理权限时完成指定告警工单。必须写明有事实依据的处理方式和记录。", {
    type: "object",
    properties: {
      alertId: { type: "string", minLength: 1, maxLength: 128 },
      expectedVersion: { type: "integer", minimum: 1 },
      action: { type: "string", enum: ["site-inspection", "restore-connection", "sensor-check", "environment-adjustment", "false-positive", "other"] },
      note: { type: "string", minLength: 2, maxLength: 500 },
    },
    required: ["alertId", "expectedVersion", "action", "note"], additionalProperties: false,
  }),
  tool("settings.set_section", "切换系统设置的分类。", {
    type: "object",
    properties: { section: { type: "string", enum: ["account", "refresh", "vehicle", "models", "diagnostics"] } },
    required: ["section"], additionalProperties: false,
  }),
  tool("settings.set_refresh_interval", "修改遥测刷新间隔草稿；随后调用 settings.save 才会持久化。", {
    type: "object",
    properties: { intervalMs: { type: "integer", enum: [1000, 3500, 5000, 10000] } },
    required: ["intervalMs"], additionalProperties: false,
  }),
  tool("settings.set_pause_when_hidden", "修改页面隐藏时暂停普通刷新的设置草稿。", {
    type: "object",
    properties: { enabled: { type: "boolean" } },
    required: ["enabled"], additionalProperties: false,
  }),
  tool("settings.set_motion_speed", "预览并修改界面动效速度草稿，范围 25% 到 180%。", {
    type: "object",
    properties: { percent: { type: "number", minimum: 25, maximum: 180, multipleOf: 5 } },
    required: ["percent"], additionalProperties: false,
  }),
  tool("settings.set_vehicle_default_speed", "修改人工遥控器默认速度草稿。", {
    type: "object",
    properties: { percent: { type: "integer", enum: [25, 55, 80] } },
    required: ["percent"], additionalProperties: false,
  }),
  tool("settings.set_keyboard_control", "修改键盘方向控制开关草稿。", {
    type: "object",
    properties: { enabled: { type: "boolean" } },
    required: ["enabled"], additionalProperties: false,
  }),
  tool("settings.set_voice_playback", "修改 AI 语音播报开关草稿。", {
    type: "object",
    properties: { enabled: { type: "boolean" } },
    required: ["enabled"], additionalProperties: false,
  }),
  tool("settings.run_diagnostics", "运行当前设备的 WebGL、像素比、内存提示和本地存储检查。", EMPTY_PARAMETERS),
  tool("settings.save", "保存当前系统设置草稿。", EMPTY_PARAMETERS),
  tool("overview.refresh", "刷新概览页的设备与遥测数据。", EMPTY_PARAMETERS),
];

function tool(
  name: AgentActionName,
  description: string,
  parameters: Record<string, unknown>,
): AgentToolDefinition {
  return { type: "function", function: { name, description, parameters } };
}

export interface AgentCapabilityGroup {
  id: "navigation" | "telemetry" | "alerts" | "spatial" | "twin" | "vehicle" | "system";
  label: string;
  summary: string;
  actions: AgentActionName[];
  examples: string[];
}

/** Public capability metadata for the AI function panel. Tool schemas above remain authoritative. */
export const AGENT_CAPABILITY_GROUPS: AgentCapabilityGroup[] = [
  {
    id: "alerts",
    label: "告警管理",
    summary: "刷新、筛选和讲解告警，并在授权后处理工单",
    actions: [
      "alerts.refresh", "alerts.set_tab", "alerts.set_severity_filter", "alerts.set_slot_filter",
      "alerts.open_detail", "alerts.begin_processing", "alerts.complete_work_order",
    ],
    examples: ["查看未处理的严重告警", "打开这条告警并讲解处理时间线"],
  },
  {
    id: "navigation",
    label: "页面与概览",
    summary: "打开页面、定位区域、刷新概览",
    actions: ["ui.navigate", "ui.back", "ui.focus_region", "ui.scroll", "overview.refresh"],
    examples: ["打开空间孪生", "返回上一页", "看看指标态势", "再往下看"],
  },
  {
    id: "telemetry",
    label: "数据监测",
    summary: "读数、曲线、历史范围与 AI 分析",
    actions: [
      "telemetry.read_current", "telemetry.inspect_current", "telemetry.focus", "monitoring.set_tab",
      "monitoring.set_visible_series", "monitoring.set_series_visibility",
      "monitoring.set_range", "monitoring.generate_analysis", "monitoring.set_paused",
      "monitoring.refresh",
    ],
    examples: ["只看温度曲线", "分析近 7 天温湿度并给出建议"],
  },
  {
    id: "spatial",
    label: "空间巡检",
    summary: "位置、环境图层、地图标定与尺寸",
    actions: ["spatial.set_layer", "spatial.begin_calibration", "spatial.calibrate", "spatial.set_dimensions"],
    examples: ["在巡检地图查看湿度层", "开始标定小车起点"],
  },
  {
    id: "twin",
    label: "空间孪生",
    summary: "视角、显示、点尺寸、面板、巡检与截图",
    actions: [
      "twin.set_view", "twin.set_display_mode", "twin.set_gap_diagnostic",
      "twin.set_point_size", "twin.open_panel", "twin.close_panels",
      "twin.reset_view", "twin.capture", "twin.orbit",
    ],
    examples: ["用大一点的点从顶部看几何", "打开缺口层并环绕一圈"],
  },
  {
    id: "vehicle",
    label: "小车控制",
    summary: "人工遥控、PID 定距/转角、固定检查点导航、授权确认与急停",
    actions: [
      "vehicle.set_control_speed", "vehicle.propose_move", "vehicle.move_distance",
      "vehicle.turn_angle", "vehicle.navigate_to_checkpoint", "vehicle.confirm", "vehicle.cancel", "vehicle.stop",
    ],
    examples: ["让小车向前移动 100 毫米", "前往油桶进行测量检测"],
  },
  {
    id: "system",
    label: "连接与设置",
    summary: "连接检查、刷新策略、动效与本机诊断",
    actions: [
      "connections.refresh", "settings.set_section", "settings.set_refresh_interval",
      "settings.set_pause_when_hidden", "settings.set_motion_speed",
      "settings.set_vehicle_default_speed", "settings.set_keyboard_control",
      "settings.set_voice_playback", "settings.run_diagnostics", "settings.save",
    ],
    examples: ["重新检查所有连接", "把动效速度调到 50 并保存"],
  },
];

const TOOL_NAMES = new Set(AGENT_TOOL_DEFINITIONS.map((item) => item.function.name));
const PAGE_NAMES = new Set(["overview", "digital-twin", "vehicle", "monitoring", "alerts", "integrations", "settings"]);
const SCROLL_DIRECTIONS = new Set(["up", "down", "top", "bottom"]);
const SCROLL_AMOUNTS = new Set(["small", "page"]);
const SLOT_IDS = new Set<string>(TELEMETRY_SLOT_IDS);
const TWIN_VIEWS = new Set(["perspective", "top", "front", "left", "right"]);
const DISPLAY_MODES = new Set(["color", "enhanced", "geometry"]);
const MOVEMENTS = new Set(["forward", "backward", "left", "right"]);
const DISTANCE_DIRECTIONS = new Set(["forward", "backward"]);
const TURN_DIRECTIONS = new Set(["left", "right"]);
const MONITORING_TABS = new Set(["live", "analysis", "history", "events"]);
const MONITORING_RANGES = new Set(["1h", "24h", "7d", "30d"]);
const SPATIAL_LAYERS = new Set(["position", ...TELEMETRY_SLOT_IDS]);
const TWIN_PANELS = new Set(["scene", "devices", "display"]);
const SETTINGS_SECTIONS = new Set(["account", "refresh", "vehicle", "models", "diagnostics"]);
const ALERT_TABS = new Set(["pending", "processing", "completed", "rules"]);
const ALERT_SEVERITIES = new Set(["all", "info", "warning", "critical"]);
const ALERT_WORK_ACTIONS = new Set(["site-inspection", "restore-connection", "sensor-check", "environment-adjustment", "false-positive", "other"]);
const REFRESH_INTERVALS = new Set([1000, 3500, 5000, 10000]);
const VEHICLE_DEFAULT_SPEEDS = new Set([25, 55, 80]);

interface ToolParameterSchema {
  type?: string;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ToolParameterSchema;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

const TOOL_SCHEMAS = new Map(
  AGENT_TOOL_DEFINITIONS.map((definition) => [
    definition.function.name,
    definition.function.parameters as ToolParameterSchema,
  ]),
);

export function parseAgentAction(name: unknown, rawArguments: unknown): AgentAction {
  if (typeof name !== "string" || !TOOL_NAMES.has(name as AgentActionName)) {
    throw new Error("模型请求了未授权动作");
  }
  const value = typeof rawArguments === "string" ? safeJson(rawArguments) : rawArguments;
  const args = objectValue(value);
  validateToolArguments(name as AgentActionName, args);

  switch (name as AgentActionName) {
    case "ui.navigate":
      if (!PAGE_NAMES.has(String(args.page))) throw new Error("页面参数无效");
      return { name, arguments: { page: args.page as AgentAction["arguments"] & never } } as AgentAction;
    case "ui.focus_region": {
      if (!PAGE_NAMES.has(String(args.page))) throw new Error("页面参数无效");
      const page = args.page as UiPage;
      const region = String(args.region);
      const regionPages = UI_REGION_PAGES.get(region);
      if (!regionPages) throw new Error("区域参数无效");
      if ((UI_REGION_IDS[page] as readonly string[]).includes(region)) {
        return { name: "ui.focus_region", arguments: { page, region: region as UiRegion } };
      }
      // Repair a model-selected page only when the registered region has one unambiguous owner.
      if (regionPages.length !== 1) {
        throw new Error("区域参数与页面不匹配，且区域不能唯一确定页面");
      }
      return {
        name: "ui.focus_region",
        arguments: { page: regionPages[0], region: region as UiRegion },
      };
    }
    case "ui.scroll": {
      if (!PAGE_NAMES.has(String(args.page))) throw new Error("页面参数无效");
      if (!SCROLL_DIRECTIONS.has(String(args.direction))) throw new Error("滚动方向参数无效");
      if (args.amount !== undefined && !SCROLL_AMOUNTS.has(String(args.amount))) throw new Error("滚动幅度参数无效");
      const page = args.page as UiPage;
      const direction = args.direction as "up" | "down" | "top" | "bottom";
      if (direction === "top" || direction === "bottom") {
        return { name: "ui.scroll", arguments: { page, direction } };
      }
      return {
        name: "ui.scroll",
        arguments: { page, direction, amount: (args.amount ?? "page") as "small" | "page" },
      };
    }
    case "telemetry.read_current":
      if (args.slotId !== undefined && !SLOT_IDS.has(String(args.slotId))) throw new Error("数据位参数无效");
      return { name, arguments: args.slotId ? { slotId: args.slotId } : {} } as AgentAction;
    case "telemetry.inspect_current": {
      if (args.slotIds === undefined) return { name, arguments: {} } as AgentAction;
      if (!Array.isArray(args.slotIds) || args.slotIds.length === 0 || args.slotIds.length > TELEMETRY_SLOT_IDS.length
        || args.slotIds.some((slotId) => !SLOT_IDS.has(String(slotId)))) {
        throw new Error("现场检测数据位参数无效");
      }
      return {
        name,
        arguments: { slotIds: [...new Set(args.slotIds.map(String))] as TelemetrySlotId[] },
      } as AgentAction;
    }
    case "telemetry.focus":
      if (!SLOT_IDS.has(String(args.slotId))) throw new Error("数据位参数无效");
      return { name, arguments: { slotId: args.slotId } } as AgentAction;
    case "monitoring.set_tab":
      if (!MONITORING_TABS.has(String(args.tab))) throw new Error("监测标签参数无效");
      return { name, arguments: { tab: args.tab } } as AgentAction;
    case "monitoring.set_visible_series": {
      if (!Array.isArray(args.slotIds) || args.slotIds.length > TELEMETRY_SLOT_IDS.length || args.slotIds.some((slotId) => !SLOT_IDS.has(String(slotId)))) {
        throw new Error("可见曲线参数无效");
      }
      const slotIds = [...new Set(args.slotIds.map(String))] as TelemetrySlotId[];
      return { name, arguments: { slotIds } } as AgentAction;
    }
    case "monitoring.set_series_visibility":
      if (!SLOT_IDS.has(String(args.slotId)) || typeof args.visible !== "boolean") throw new Error("曲线显隐参数无效");
      return { name, arguments: { slotId: args.slotId, visible: args.visible } } as AgentAction;
    case "monitoring.set_range":
      if (!MONITORING_RANGES.has(String(args.range))) throw new Error("监测范围参数无效");
      return { name, arguments: { range: args.range } } as AgentAction;
    case "monitoring.generate_analysis": {
      if (args.slotIds === undefined) return { name, arguments: {} } as AgentAction;
      if (!Array.isArray(args.slotIds) || args.slotIds.length === 0 || args.slotIds.length > TELEMETRY_SLOT_IDS.length || args.slotIds.some((slotId) => !SLOT_IDS.has(String(slotId)))) {
        throw new Error("分析数据位参数无效");
      }
      const slotIds = [...new Set(args.slotIds.map(String))] as TelemetrySlotId[];
      return { name, arguments: { slotIds } } as AgentAction;
    }
    case "monitoring.set_paused":
      if (typeof args.paused !== "boolean") throw new Error("冻结状态参数无效");
      return { name, arguments: { paused: args.paused } } as AgentAction;
    case "twin.set_view":
      if (!TWIN_VIEWS.has(String(args.view))) throw new Error("视角参数无效");
      return { name, arguments: { view: args.view } } as AgentAction;
    case "twin.set_display_mode":
      if (!DISPLAY_MODES.has(String(args.mode))) throw new Error("显示模式参数无效");
      return { name, arguments: { mode: args.mode } } as AgentAction;
    case "twin.set_gap_diagnostic":
      if (typeof args.active !== "boolean") throw new Error("缺口状态参数无效");
      return { name: "twin.set_gap_diagnostic", arguments: { active: args.active } };
    case "twin.set_point_size":
      return { name, arguments: { size: args.size } } as AgentAction;
    case "twin.open_panel":
      if (!TWIN_PANELS.has(String(args.panel))) throw new Error("孪生面板参数无效");
      return { name, arguments: { panel: args.panel } } as AgentAction;
    case "twin.orbit": {
      if (args.direction !== undefined && args.direction !== "clockwise" && args.direction !== "counterclockwise") {
        throw new Error("环绕方向参数无效");
      }
      return {
        name: "twin.orbit",
        arguments: {
          revolutions: args.revolutions === undefined ? 1 : args.revolutions as number,
          durationMs: args.durationMs === undefined ? 9000 : args.durationMs as number,
          elevationDeg: args.elevationDeg === undefined ? 35 : args.elevationDeg as number,
          direction: args.direction === "counterclockwise" ? "counterclockwise" : "clockwise",
        },
      };
    }
    case "spatial.set_layer":
      if (!SPATIAL_LAYERS.has(String(args.layer))) throw new Error("空间图层参数无效");
      return { name, arguments: { layer: args.layer } } as AgentAction;
    case "spatial.calibrate": {
      const x = Number(args.x);
      const y = Number(args.y);
      const headingDeg = Number(args.headingDeg);
      if (!Number.isFinite(x) || x < 0 || x > 1 || !Number.isFinite(y) || y < 0 || y > 1 || !Number.isFinite(headingDeg)) {
        throw new Error("空间标定参数无效");
      }
      return { name, arguments: { x, y, headingDeg: ((headingDeg % 360) + 360) % 360 } } as AgentAction;
    }
    case "spatial.set_dimensions": {
      const widthM = Number(args.widthM);
      const heightM = Number(args.heightM);
      if (!Number.isFinite(widthM) || widthM < 2 || widthM > 20 || !Number.isFinite(heightM) || heightM < 2 || heightM > 20) {
        throw new Error("地图尺寸参数无效");
      }
      return { name, arguments: { widthM, heightM } } as AgentAction;
    }
    case "vehicle.set_control_speed":
      return { name, arguments: { speedPercent: args.speedPercent } } as AgentAction;
    case "vehicle.propose_move": {
      if (!MOVEMENTS.has(String(args.motion))) throw new Error("移动方向参数无效");
      const speedPercent = args.speedPercent === undefined ? 20 : args.speedPercent;
      const durationMs = args.durationMs === undefined ? 1000 : args.durationMs;
      return { name, arguments: { motion: args.motion, speedPercent, durationMs } } as AgentAction;
    }
    case "vehicle.move_distance": {
      if (!DISTANCE_DIRECTIONS.has(String(args.direction))) throw new Error("定距移动方向参数无效");
      return {
        name,
        arguments: {
          direction: args.direction,
          distanceMm: args.distanceMm,
          maxSpeedMmps: args.maxSpeedMmps === undefined ? 300 : args.maxSpeedMmps,
          ...(args.timeoutS === undefined ? {} : { timeoutS: args.timeoutS }),
        },
      } as AgentAction;
    }
    case "vehicle.turn_angle": {
      if (!TURN_DIRECTIONS.has(String(args.direction))) throw new Error("定角转向方向参数无效");
      return {
        name,
        arguments: {
          direction: args.direction,
          angleDeg: args.angleDeg,
          maxSpeedMmps: args.maxSpeedMmps === undefined ? 300 : args.maxSpeedMmps,
          ...(args.timeoutS === undefined ? {} : { timeoutS: args.timeoutS }),
        },
      } as AgentAction;
    }
    case "vehicle.navigate_to_checkpoint": {
      const checkpointName = String(args.checkpointName ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
      const length = Array.from(checkpointName).length;
      if (length < 1 || length > 20) throw new Error("固定检查点名称参数无效");
      return { name, arguments: { checkpointName } } as AgentAction;
    }
    case "alerts.set_tab":
      if (!ALERT_TABS.has(String(args.tab))) throw new Error("告警标签参数无效");
      return { name, arguments: { tab: args.tab } } as AgentAction;
    case "alerts.set_severity_filter":
      if (!ALERT_SEVERITIES.has(String(args.severity))) throw new Error("告警级别参数无效");
      return { name, arguments: { severity: args.severity } } as AgentAction;
    case "alerts.set_slot_filter":
      if (args.slotId !== "all" && !SLOT_IDS.has(String(args.slotId))) throw new Error("告警指标参数无效");
      return { name, arguments: { slotId: args.slotId } } as AgentAction;
    case "alerts.open_detail": {
      const alertId = String(args.alertId ?? "").trim();
      if (!alertId || alertId.length > 128) throw new Error("告警编号参数无效");
      return { name, arguments: { alertId } } as AgentAction;
    }
    case "alerts.begin_processing": {
      const alertId = String(args.alertId ?? "").trim();
      const expectedVersion = Number(args.expectedVersion);
      if (!alertId || alertId.length > 128) throw new Error("告警编号参数无效");
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error("告警版本参数无效");
      return { name, arguments: { alertId, expectedVersion } } as AgentAction;
    }
    case "alerts.complete_work_order": {
      const alertId = String(args.alertId ?? "").trim();
      const expectedVersion = Number(args.expectedVersion);
      const action = String(args.action ?? "");
      const note = String(args.note ?? "").trim();
      if (!alertId || alertId.length > 128) throw new Error("告警编号参数无效");
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error("告警版本参数无效");
      if (!ALERT_WORK_ACTIONS.has(action)) throw new Error("工单处理方式参数无效");
      if (note.length < 2 || note.length > 500) throw new Error("工单处理记录长度应为 2–500 个字符");
      return { name, arguments: { alertId, expectedVersion, action, note } } as AgentAction;
    }
    case "settings.set_section":
      if (!SETTINGS_SECTIONS.has(String(args.section))) throw new Error("设置分类参数无效");
      return { name, arguments: { section: args.section } } as AgentAction;
    case "settings.set_refresh_interval": {
      const intervalMs = Number(args.intervalMs);
      if (!REFRESH_INTERVALS.has(intervalMs)) throw new Error("刷新间隔参数无效");
      return { name, arguments: { intervalMs } } as AgentAction;
    }
    case "settings.set_pause_when_hidden":
    case "settings.set_keyboard_control":
    case "settings.set_voice_playback":
      if (typeof args.enabled !== "boolean") throw new Error("设置开关参数无效");
      return { name, arguments: { enabled: args.enabled } } as AgentAction;
    case "settings.set_motion_speed":
      return { name, arguments: { percent: args.percent } } as AgentAction;
    case "settings.set_vehicle_default_speed": {
      const percent = Number(args.percent);
      if (!VEHICLE_DEFAULT_SPEEDS.has(percent)) throw new Error("车辆默认速度参数无效");
      return { name, arguments: { percent } } as AgentAction;
    }
    default:
      return { name, arguments: {} } as AgentAction;
  }
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new Error("动作参数不是有效 JSON"); }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("动作参数必须是对象");
  }
  return value as Record<string, unknown>;
}

function validateToolArguments(name: AgentActionName, args: Record<string, unknown>) {
  const schema = TOOL_SCHEMAS.get(name);
  if (!schema) throw new Error("模型请求了未授权动作");
  const properties = schema.properties ?? {};

  if (schema.additionalProperties === false) {
    const extraKey = Object.keys(args).find((key) => !(key in properties));
    if (extraKey) throw new Error(`动作 ${name} 含有额外参数 ${extraKey}`);
  }

  for (const requiredKey of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(args, requiredKey)) {
      throw new Error(`动作 ${name} 缺少必填参数 ${requiredKey}`);
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const propertySchema = properties[key];
    if (propertySchema) validateSchemaValue(name, key, value, propertySchema);
  }
}

function validateSchemaValue(name: AgentActionName, key: string, value: unknown, schema: ToolParameterSchema) {
  if (schema.type === "string" && typeof value !== "string") {
    throw new Error(`动作 ${name} 参数 ${key} 必须是字符串`);
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    throw new Error(`动作 ${name} 参数 ${key} 必须是布尔值`);
  }
  if ((schema.type === "number" || schema.type === "integer") && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`动作 ${name} 参数 ${key} 必须是有限数值`);
  }
  if (schema.type === "integer" && !Number.isInteger(value)) {
    throw new Error(`动作 ${name} 参数 ${key} 必须是整数`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`动作 ${name} 参数 ${key} 低于最小值 ${schema.minimum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      throw new Error(`动作 ${name} 参数 ${key} 必须大于 ${schema.exclusiveMinimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new Error(`动作 ${name} 参数 ${key} 高于最大值 ${schema.maximum}`);
    }
    if (schema.multipleOf !== undefined) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        throw new Error(`动作 ${name} 参数 ${key} 必须是 ${schema.multipleOf} 的整数倍`);
      }
    }
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`动作 ${name} 参数 ${key} 必须是数组`);
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`动作 ${name} 参数 ${key} 数量不足`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new Error(`动作 ${name} 参数 ${key} 数量过多`);
    }
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      throw new Error(`动作 ${name} 参数 ${key} 不能包含重复项`);
    }
    if (schema.items) value.forEach((item, index) => validateSchemaValue(name, `${key}[${index}]`, item, schema.items!));
  }
}

export function actionPublicLabel(action: AgentAction): string {
  if (action.name === "ui.navigate") {
    return `打开${({ overview: "概览", "digital-twin": "空间孪生", vehicle: "小车遥控", monitoring: "数据监测", alerts: "告警管理", integrations: "连接管理", settings: "系统设置" } as const)[action.arguments.page]}`;
  }
  if (action.name === "ui.focus_region") return `定位到${UI_REGION_LABELS[action.arguments.region]}`;
  if (action.name === "ui.scroll") {
    if (action.arguments.direction === "top") return "回到页面顶部";
    if (action.arguments.direction === "bottom") return "前往页面底部";
    return `${action.arguments.direction === "up" ? "向上" : "向下"}滚动${action.arguments.amount === "small" ? "一段" : "一页"}`;
  }
  if (action.name === "telemetry.focus") return `聚焦${TELEMETRY_SLOT_LABELS[action.arguments.slotId]}`;
  if (action.name === "monitoring.set_tab") {
    return `切换到${({ live: "实时趋势", analysis: "分析洞察", history: "历史数据", events: "事件" } as const)[action.arguments.tab]}`;
  }
  if (action.name === "monitoring.set_visible_series") {
    return action.arguments.slotIds.length
      ? `仅显示${action.arguments.slotIds.map((slotId) => TELEMETRY_SLOT_LABELS[slotId]).join("、")}`
      : "隐藏全部趋势曲线";
  }
  if (action.name === "monitoring.set_series_visibility") {
    return `${action.arguments.visible ? "显示" : "隐藏"}${TELEMETRY_SLOT_LABELS[action.arguments.slotId]}曲线`;
  }
  if (action.name === "monitoring.set_range") {
    return `设置分析范围为${({ "1h": "近 1 小时", "24h": "近 24 小时", "7d": "近 7 天", "30d": "近 30 天" } as const)[action.arguments.range]}`;
  }
  if (action.name === "monitoring.generate_analysis") {
    return action.arguments.slotIds?.length
      ? `分析${action.arguments.slotIds.map((slotId) => TELEMETRY_SLOT_LABELS[slotId]).join("、")}`
      : "生成全部数据分析";
  }
  if (action.name === "monitoring.set_paused") return action.arguments.paused ? "冻结实时画面" : "恢复实时画面";
  if (action.name === "twin.set_view") {
    return `切换到${({
      perspective: "3D 透视",
      top: "俯视",
      front: "前视",
      left: "左视",
      right: "右视",
    } as const)[action.arguments.view]}视角`;
  }
  if (action.name === "twin.set_display_mode") {
    return `切换到${({ color: "彩色", enhanced: "增强", geometry: "几何" } as const)[action.arguments.mode]}模式`;
  }
  if (action.name === "twin.set_point_size") return `设置点尺寸为 ${action.arguments.size.toFixed(3)}`;
  if (action.name === "twin.open_panel") {
    return `打开${({ scene: "场景", devices: "设备", display: "显示" } as const)[action.arguments.panel]}面板`;
  }
  if (action.name === "twin.orbit") {
    const direction = action.arguments.direction === "clockwise" ? "顺时针" : "逆时针";
    return `${direction}环绕 ${formatCompactNumber(action.arguments.revolutions)} 圈检查空间`;
  }
  if (action.name === "spatial.set_layer") {
    return action.arguments.layer === "position" ? "查看小车位置图层" : `查看${TELEMETRY_SLOT_LABELS[action.arguments.layer]}空间图层`;
  }
  if (action.name === "spatial.calibrate") {
    return `标定小车起点（${action.arguments.x.toFixed(2)}, ${action.arguments.y.toFixed(2)}）`;
  }
  if (action.name === "vehicle.navigate_to_checkpoint") return `前往固定检查点“${action.arguments.checkpointName}”`;
  if (action.name === "telemetry.inspect_current") {
    return action.arguments.slotIds?.length
      ? `稳定后检测${action.arguments.slotIds.map((slotId) => TELEMETRY_SLOT_LABELS[slotId]).join("、")}`
      : "稳定后检测现场六路数据";
  }
  if (action.name === "vehicle.move_distance") {
    return `${action.arguments.direction === "forward" ? "前进" : "后退"} ${formatCompactNumber(action.arguments.distanceMm)} 毫米`;
  }
  if (action.name === "vehicle.turn_angle") {
    return `${action.arguments.direction === "left" ? "左转" : "右转"} ${formatCompactNumber(action.arguments.angleDeg)} 度`;
  }
  if (action.name === "spatial.set_dimensions") {
    return `设置房间尺寸 ${formatCompactNumber(action.arguments.widthM)} × ${formatCompactNumber(action.arguments.heightM)} 米`;
  }
  if (action.name === "vehicle.set_control_speed") return `设置遥控速度为 ${action.arguments.speedPercent}%`;
  if (action.name === "alerts.set_tab") return `切换到${({ pending: "未处理", processing: "处理中", completed: "已完成", rules: "告警规则" } as const)[action.arguments.tab]}`;
  if (action.name === "alerts.set_severity_filter") return `筛选${({ all: "全部", info: "提示", warning: "关注", critical: "严重" } as const)[action.arguments.severity]}告警`;
  if (action.name === "alerts.set_slot_filter") return action.arguments.slotId === "all" ? "显示全部指标告警" : `筛选${TELEMETRY_SLOT_LABELS[action.arguments.slotId]}告警`;
  if (action.name === "alerts.open_detail") return "打开告警详情";
  if (action.name === "settings.set_section") {
    return `打开${({ account: "账户与安全", refresh: "数据刷新", vehicle: "车辆控制", models: "模型与存储", diagnostics: "本机诊断" } as const)[action.arguments.section]}设置`;
  }
  if (action.name === "settings.set_refresh_interval") return `设置刷新间隔为 ${action.arguments.intervalMs / 1000} 秒`;
  if (action.name === "settings.set_pause_when_hidden") return `${action.arguments.enabled ? "开启" : "关闭"}隐藏页面暂停刷新`;
  if (action.name === "settings.set_motion_speed") return `设置动效速度为 ${action.arguments.percent}%`;
  if (action.name === "settings.set_vehicle_default_speed") return `设置默认车速为 ${action.arguments.percent}%`;
  if (action.name === "settings.set_keyboard_control") return `${action.arguments.enabled ? "开启" : "关闭"}键盘控制`;
  if (action.name === "settings.set_voice_playback") return `${action.arguments.enabled ? "开启" : "关闭"}语音播报`;
  const labels: Record<AgentActionName, string> = {
    "ui.navigate": "打开页面",
    "ui.back": "返回上一页",
    "ui.focus_region": "定位页面区域",
    "ui.scroll": "滚动页面",
    "telemetry.read_current": "读取数据",
    "telemetry.inspect_current": "检测现场数据",
    "telemetry.focus": "定位数据",
    "monitoring.set_tab": "切换监测视图",
    "monitoring.set_visible_series": "设置可见曲线",
    "monitoring.set_series_visibility": "调整曲线显隐",
    "monitoring.set_range": "设置分析范围",
    "monitoring.generate_analysis": "生成数据分析",
    "monitoring.set_paused": "调整实时画面",
    "monitoring.refresh": "刷新监测数据",
    "twin.set_view": "调整空间视角",
    "twin.set_display_mode": "切换空间显示",
    "twin.set_gap_diagnostic": "检查模型缺口",
    "twin.set_point_size": "调整点尺寸",
    "twin.open_panel": "打开孪生面板",
    "twin.close_panels": "收起孪生面板",
    "twin.reset_view": "复位空间视角",
    "twin.capture": "保存孪生截图",
    "twin.orbit": "环绕检查空间",
    "spatial.set_layer": "切换巡检图层",
    "spatial.begin_calibration": "开始标定小车起点",
    "spatial.calibrate": "标定小车起点",
    "spatial.set_dimensions": "设置巡检地图尺寸",
    "vehicle.set_control_speed": "调整遥控速度",
    "vehicle.propose_move": "准备车辆任务",
    "vehicle.move_distance": "定距移动车辆",
    "vehicle.turn_angle": "定角转动车辆",
    "vehicle.navigate_to_checkpoint": "导航到固定检查点",
    "vehicle.confirm": "确认车辆任务",
    "vehicle.cancel": "取消车辆任务",
    "vehicle.stop": "停止车辆",
    "connections.refresh": "重新检查连接",
    "alerts.refresh": "刷新告警",
    "alerts.set_tab": "切换告警标签",
    "alerts.set_severity_filter": "筛选告警级别",
    "alerts.set_slot_filter": "筛选告警指标",
    "alerts.open_detail": "查看告警详情",
    "alerts.begin_processing": "开始处理告警",
    "alerts.complete_work_order": "完成告警工单",
    "settings.set_section": "切换设置分类",
    "settings.set_refresh_interval": "调整刷新间隔",
    "settings.set_pause_when_hidden": "调整后台刷新",
    "settings.set_motion_speed": "调整动效速度",
    "settings.set_vehicle_default_speed": "调整默认车速",
    "settings.set_keyboard_control": "调整键盘控制",
    "settings.set_voice_playback": "调整语音播报",
    "settings.run_diagnostics": "运行本机诊断",
    "settings.save": "保存系统设置",
    "overview.refresh": "刷新概览数据",
  };
  return labels[action.name];
}

function formatCompactNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function requiredPageForAction(action: AgentAction): UiPage | null {
  if (action.name === "ui.navigate") return action.arguments.page;
  if (action.name === "ui.focus_region") return action.arguments.page;
  if (action.name === "ui.scroll") return action.arguments.page;
  if (action.name === "telemetry.focus" || action.name.startsWith("monitoring.")) return "monitoring";
  if (action.name.startsWith("twin.")) return "digital-twin";
  if (action.name.startsWith("spatial.") || action.name === "vehicle.set_control_speed") return "vehicle";
  if (action.name.startsWith("connections.")) return "integrations";
  if (action.name.startsWith("alerts.")) return "alerts";
  if (action.name.startsWith("settings.")) return "settings";
  if (action.name.startsWith("overview.")) return "overview";
  return null;
}

function prerequisiteForFocusedRegion(
  action: Extract<AgentAction, { name: "ui.focus_region" }>,
): AgentAction | null {
  if (action.arguments.page === "monitoring") {
    if (["live-chart", "slot-details"].includes(action.arguments.region)) {
      return { name: "monitoring.set_tab", arguments: { tab: "live" } };
    }
    if ([
      "analysis-summary",
      "indicator-posture",
      "ai-analysis",
      "ai-problems",
      "ai-recommendations",
      "range-profile",
      "correlation-matrix",
      "daily-heatmap",
      "spatial-distribution",
    ].includes(action.arguments.region)) {
      return { name: "monitoring.set_tab", arguments: { tab: "analysis" } };
    }
    if (action.arguments.region === "history-table") {
      return { name: "monitoring.set_tab", arguments: { tab: "history" } };
    }
    if (action.arguments.region === "event-timeline") {
      return { name: "monitoring.set_tab", arguments: { tab: "events" } };
    }
  }
  if (action.arguments.page === "settings") {
    const section = ({
      "account-security": "account",
      "refresh-settings": "refresh",
      "vehicle-settings": "vehicle",
      "model-storage": "models",
      diagnostics: "diagnostics",
    } as const)[action.arguments.region as "account-security" | "refresh-settings" | "vehicle-settings" | "model-storage" | "diagnostics"];
    return section ? { name: "settings.set_section", arguments: { section } } : null;
  }
  if (action.arguments.page === "digital-twin") {
    const panel = ({
      "scene-panel": "scene",
      "device-panel": "devices",
      "display-panel": "display",
    } as const)[action.arguments.region as "scene-panel" | "device-panel" | "display-panel"];
    return panel ? { name: "twin.open_panel", arguments: { panel } } : null;
  }
  return null;
}

function hasMatchingPrerequisiteSinceNavigation(compiled: AgentAction[], prerequisite: AgentAction) {
  for (let index = compiled.length - 1; index >= 0; index -= 1) {
    const candidate = compiled[index];
    if (candidate.name === "ui.navigate") break;
    if (candidate.name !== prerequisite.name) continue;
    return JSON.stringify(candidate.arguments) === JSON.stringify(prerequisite.arguments);
  }
  return false;
}

export function compileAgentPlan(actions: AgentAction[], initialPage: UiPage | null = null) {
  return compileAgentPlanWithDiagnostics(actions, initialPage).actions;
}

export function compileAgentPlanWithDiagnostics(
  actions: AgentAction[],
  initialPage: UiPage | null = null,
) {
  const parsedActions = actions.map((action) => parseAgentAction(action.name, action.arguments));
  const vehicleMovementNames = new Set(["vehicle.propose_move", "vehicle.move_distance", "vehicle.turn_angle", "vehicle.navigate_to_checkpoint"]);
  const hasVehicleMovement = parsedActions.some((action) => vehicleMovementNames.has(action.name));
  const hasRedundantConfirmation = hasVehicleMovement
    && parsedActions.some((action) => action.name === "vehicle.confirm");
  const validatedActions = hasRedundantConfirmation
    ? parsedActions.filter((action) => action.name !== "vehicle.confirm")
    : parsedActions;
  const warnings = hasRedundantConfirmation
    ? ["计划同时包含车辆动作和冗余确认动作；完整权限模式已保留全部车辆动作并自动跳过冗余确认。"]
    : [];

  const compiled: AgentAction[] = [];
  let plannedPage: UiPage | null = initialPage;
  for (const action of validatedActions) {
    if (action.name === "ui.navigate" && action.arguments.page === plannedPage) continue;
    const requiredPage = requiredPageForAction(action);
    if (action.name !== "ui.navigate" && requiredPage && plannedPage !== requiredPage) {
      compiled.push({ name: "ui.navigate", arguments: { page: requiredPage } });
      plannedPage = requiredPage;
    }
    if (action.name === "ui.focus_region") {
      const prerequisite = prerequisiteForFocusedRegion(action);
      if (prerequisite && !hasMatchingPrerequisiteSinceNavigation(compiled, prerequisite)) {
        compiled.push(prerequisite);
      }
    }
    compiled.push(action);
    if (action.name === "ui.navigate") plannedPage = action.arguments.page;
    if (action.name === "ui.back") plannedPage = null;
  }
  return { actions: compiled, warnings };
}
