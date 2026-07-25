import { AGENT_TOOL_DEFINITIONS, parseAgentAction } from "../app/lib/ai/action-registry";
import type {
  AgentAction,
  AgentModelPreferences,
  AgentThinkingMode,
} from "../app/lib/ai/contracts";
import type { TelemetrySlotId } from "../app/lib/iot/contracts";
import type { TelemetryHistoryRange } from "../app/lib/iot/telemetry-history-contracts";
import type { AgentGatewayConfig } from "./config";
import { fetchDeepSeekWithRetry } from "./deepseek-http";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface DeepSeekDecision {
  reply: string;
  actions: AgentAction[];
  planningMode: AgentThinkingMode;
  semantic: SemanticIntentBrief;
  planQuality?: "verified" | "best-effort";
  warnings?: string[];
}

export type SemanticInformationGoal =
  | "current-value"
  | "trend"
  | "variation"
  | "comparison"
  | "spatial-pattern"
  | "problem-diagnosis"
  | "recommendations"
  | "connection-health"
  | "vehicle-state"
  | "direct-control"
  | "navigation"
  | "other";

export type SemanticEvidence =
  | "current-reading"
  | "live-curve"
  | "indicator-posture"
  | "range-profile"
  | "correlation-matrix"
  | "daily-heatmap"
  | "spatial-distribution"
  | "history-table"
  | "event-timeline"
  | "ai-problems"
  | "ai-recommendations"
  | "connection-summary"
  | "sensor-connection"
  | "vehicle-connection"
  | "ai-connection"
  | "vehicle-status"
  | "inspection-map"
  | "vehicle-camera"
  | "twin-viewport"
  | "named-page-region";

export interface SemanticIntentSubject {
  label: string;
  slotId?: TelemetrySlotId;
}

/** A short, user-visible semantic summary. It must never contain hidden reasoning. */
export interface SemanticIntentBrief {
  goal: SemanticInformationGoal;
  summary: string;
  subjects: SemanticIntentSubject[];
  timeRange: TelemetryHistoryRange | null;
  primaryEvidence: SemanticEvidence;
  supportingEvidence: SemanticEvidence[];
  evidenceSummary: string;
  successCriterion: string;
}

export interface SemanticPlanningProgress {
  phase: "understanding" | "evidence" | "actions";
  status: "active" | "complete";
  detail: string;
}

type SemanticProgressListener = (progress: SemanticPlanningProgress) => void;

const DEFAULT_MODEL_PREFERENCES: AgentModelPreferences = {
  thinkingMode: "thinking",
  reasoningEffort: "high",
};

function resolveModelPreferences(
  value?: Partial<AgentModelPreferences>,
  defaultEffort: AgentModelPreferences["reasoningEffort"] = "high",
): AgentModelPreferences {
  return {
    thinkingMode: value?.thinkingMode === "non-thinking" ? "non-thinking" : "thinking",
    reasoningEffort: value?.reasoningEffort === "max" ? "max" : defaultEffort,
  };
}

export function deepSeekThinkingParameters(value?: Partial<AgentModelPreferences>) {
  const preferences = resolveModelPreferences(value);
  return preferences.thinkingMode === "thinking"
    ? { thinking: { type: "enabled" as const }, reasoning_effort: preferences.reasoningEffort }
    : { thinking: { type: "disabled" as const } };
}

const SEMANTIC_GOALS = [
  "current-value", "trend", "variation", "comparison", "spatial-pattern", "problem-diagnosis",
  "recommendations", "connection-health", "vehicle-state", "direct-control", "navigation", "other",
] as const satisfies readonly SemanticInformationGoal[];

const SEMANTIC_EVIDENCE = [
  "current-reading", "live-curve", "indicator-posture", "range-profile", "correlation-matrix",
  "daily-heatmap", "spatial-distribution", "history-table", "event-timeline", "ai-problems",
  "ai-recommendations", "connection-summary", "sensor-connection", "vehicle-connection",
  "ai-connection", "vehicle-status", "inspection-map", "vehicle-camera", "twin-viewport", "named-page-region",
] as const satisfies readonly SemanticEvidence[];

const SEMANTIC_OUTPUT_TOKENS = 4_096;
const SEMANTIC_REPAIR_OUTPUT_TOKENS = 8_192;
const CONTEXT_RESOLUTION_OUTPUT_TOKENS = 2_048;
const PLAN_OUTPUT_TOKENS = 4_096;
const PLAN_REPAIR_OUTPUT_TOKENS = 8_192;
const MODEL_REQUEST_TIMEOUT_MS = 45_000;
const MODEL_REPAIR_TIMEOUT_MS = 75_000;
const CONTINUATION_CONTEXT_TURNS = 128;
const CONTEXT_MODEL_TURNS = 24;
const VEHICLE_PLAN_MAX_ATTEMPTS = 3;
const VEHICLE_PLAN_REVIEW_OUTPUT_TOKENS = 4_096;

const SEMANTIC_PROMPT = `你负责在动作规划之前理解用户真正想获得的信息，而不是仅匹配句子中的名词。在内部完成判断，但只输出一个简短 JSON 语义摘要，绝不输出思维链、分析过程或独白。

必须区分以下信息目标：
- current-value：用户明确询问当前值、现在多少；证据是 current-reading。
- trend：用户询问升降方向、走势或随时间如何变化；优先 indicator-posture，实时过程才用 live-curve。
- variation：用户询问变化大不大、波动、稳定性、变幅或哪个时段变化明显；优先 daily-heatmap，indicator-posture 或 range-profile 可作辅助，不能用当前读数代替。
- comparison：比较多个指标或相关关系；按问题选择 correlation-matrix、range-profile 或曲线。
- spatial-pattern：用户询问房间哪里高、不同位置差异或空间分布；数据监测/分析语境使用 spatial-distribution，明确提到小车、巡检、地图图层时使用 inspection-map。只说“温度地图”等模糊地图名称时，以目标屏幕当前页面为准：数据监测页选择 spatial-distribution，小车遥控页选择 inspection-map。
- problem-diagnosis：先定位问题、异常或关注项；优先 ai-problems、event-timeline 或 indicator-posture。
- recommendations：用户明确询问建议、怎么改善或怎么处理；先以 ai-problems 描述问题，再以 ai-recommendations 给出建议。
- connection-health：连接、在线、离线或链路问题；按对象选择 connection-summary、sensor-connection、vehicle-connection 或 ai-connection。
- vehicle-state：小车当前状态、位置、回传或实时视野；普通状态选择 vehicle-status，位置与轨迹选择 inspection-map，车载摄像头、实时画面或前方视野选择 vehicle-camera。
- direct-control / navigation：真实车辆运动、转向、前往固定检查点或到点检测属于 direct-control；只打开或浏览应用页面属于 navigation。不要虚构分析证据。
  固定检查点语义示例：“去油桶测量，回来告诉我检测结果”仍是 direct-control；这里的“回来告诉我”要求助手在检测后回复，不是车辆返程，不能因此添加额外移动。

证据必须直接回答用户的问题。不要因为句子出现“温度”就默认 current-reading；先判断用户问的是数值、趋势、波动、空间差异、问题还是建议。时间表达映射到 1h / 24h / 7d / 30d；没有时间含义或巡检地图不使用时间范围时，timeRange 必须为 null；“最近”且未指定时，分析类请求默认 24h。数据为空、覆盖不足或暂不可用是执行/分析阶段的数据状态，不能写进 timeRange。根据运行时数据位目录填写 subjects.slotId，无法可靠匹配时省略 slotId，不得猜测。

只输出严格 JSON，结构必须为：
{"goal":"variation","summary":"判断近期温度波动幅度与发生时段","subjects":[{"label":"环境温度","slotId":"slot-1"}],"timeRange":"24h","primaryEvidence":"daily-heatmap","supportingEvidence":["indicator-posture"],"evidenceSummary":"使用24小时日内热力图，并以指标态势核对波动幅度","successCriterion":"最终聚焦能体现温度变化大小的图表"}

summary、evidenceSummary、successCriterion 都是可以直接展示给用户的短句；它们只能陈述已识别的目标和选用的证据，不得解释内部推理。primaryEvidence 只能有一个，supportingEvidence 最多四个且不得与主证据重复；复合请求应保留所有直接相关的证据，不得只保留最后一句“建议”。`;

const SYSTEM_PROMPT = `你是“危化智巡物联中枢”的语音操作助手。你只能通过提供的工具操作界面、读取数据或提出小车任务，绝不能编造传感器读数、操作任意 DOM、URL、终端命令、文件或原始轮速。
规则：
1. 先理解用户想达到的最终界面状态，再把它拆成按顺序执行的原子工具调用。不要把复合意图缩减成一个近似动作。
2. 用户要求读取具体数值时调用 telemetry.read_current。查看实时曲线时切到 live 并精确设置曲线集合；历史或分析请求要设置标签、时间范围、关注指标，并在用户要求建议时调用 monitoring.generate_analysis。
3. 根据运行时数据位目录选择槽位，目录已有对应名称时不得反问用户槽位编号。“只看某项”必须用 monitoring.set_visible_series 只保留对应槽位；“比较若干项”只保留指定的多个槽位；“隐藏某项”使用 monitoring.set_series_visibility 且不改变其他曲线。
4. 小车前进/后退明确给出距离时调用 vehicle.move_distance，并把米、厘米准确换算为毫米；左转/右转明确给出角度时调用 vehicle.turn_angle；只给方向而没有距离或角度时才调用 vehicle.propose_move；前往运行时列出的固定检查点时调用 vehicle.navigate_to_checkpoint；到点测量或检测时紧接着调用 telemetry.inspect_current；停止立即调用 vehicle.stop。复合路径必须由这些通用原子动作按用户要求自行编排，可以在同一计划中连续安排多段移动与转向；网关会等待每段真实回执后再执行下一段。不要在包含移动的计划里加入 vehicle.confirm。
5. 限时移动默认 20% 速度、1000ms，速度百分比使用 0–100 的有效范围。PID 定距、定角、最大轮速与任务超时只要求为有限正数，应用层不设置距离、角度、速度或时长上限；省略最大轮速时使用 300mm/s，省略超时时由运行时根据任务量计算。不得把精确距离或角度改写成定时移动，也不得因为角度超过一圈、距离较长或预计耗时较长而拒绝或缩减用户目标。
6. 回复简洁自然，不展示思维过程。工具规划阶段只能说“准备执行”或“等待确认”，不得声称车辆已移动、已完成或已发送；只有运行时收到 Jetson 对同一 request_id 的真实回执后才能报告设备结果。
7. 用户一句话包含多个明确动作时，必须在同一次响应中按用户表达顺序返回多个工具调用，不要只执行第一步。例如“打开空间孪生并切换俯视”依次调用 ui.navigate 和 twin.set_view。
8. “环绕、环视、绕一圈、从四周检查”表示连续相机运动，必须使用 twin.orbit；若同时提到缺陷、缺口、空缺或未建模区域，还要启用 twin.set_gap_diagnostic。环绕检查通常使用 perspective 视角，不要只打开空间孪生就结束。
9. “在分析页看空间分布”使用 monitoring 标签、范围和 telemetry.focus；“在巡检地图看某图层”使用 spatial.set_layer。只说“温度地图”等模糊地图名称时，结合目标屏幕当前页区分数据监测空间分布与小车巡检图层。标定落点不明确时只调用 spatial.begin_calibration，等待用户点击，不要猜坐标。
10. 设置类 set_* 动作只修改草稿；用户要求真正修改或保存时，最后追加 settings.save。不得自行修改连接地址、密钥、AI 真车授权、清空轨迹或清空数据。
11. 当前请求拥有最高优先级，但必须结合近期对话解析省略主语、代词、目标设备、页面和连续任务。明确的新请求覆盖旧意图；不要把已经完成且与当前请求无关的动作重新执行。回复中只能描述本次实际调用的动作，不得承诺没有调用的操作。
12. 用户要求“看看、带我看、定位到、滚到、聚焦”页面中的具体卡片或区域时，不能只打开页面，必须调用 ui.focus_region，让目标区域进入视野并高亮。比如“看看指标态势”使用 monitoring/indicator-posture，“看看 AI 建议”使用 monitoring/ai-analysis，“看相关矩阵”使用 monitoring/correlation-matrix，“看看巡检地图”使用 vehicle/inspection-map，“看看小车摄像头”使用 vehicle/vehicle-camera。ui.focus_region 会自动补齐页面导航和目标标签或面板，不要重复调用相同的前置动作。
13. 用户只表达相对浏览方向时使用 ui.scroll：例如“再往下看”使用当前目标页面、direction=down，“往上挪一点”使用 up/small，“回到顶部”使用 top。已知具体区域时优先使用 ui.focus_region。不得把滚动转换为像素、DOM 选择器或任意脚本。
14. 用户明确要求“返回、上一页、回去”时使用 ui.back。它只复用目标屏幕的站内历史，不要改写成猜测页面的 ui.navigate，也不要提供 URL。
15. 规划前会提供一份公开语义摘要。它明确了用户真正的信息目标、主证据、辅助证据和成功条件；动作必须兑现这份摘要。不能因为出现传感器名称就把趋势、波动、空间分布、问题或建议请求退化成 telemetry.read_current。
16. “当前多少”才使用 current-reading；“走势/升降”优先 indicator-posture；“变化大不大/波动/稳定性/哪个时段变化明显”优先 daily-heatmap；“哪里高/不同位置”在监测语境使用 spatial-distribution，在小车巡检语境使用 inspection-map；“问题和建议”必须先呈现 ai-problems，再呈现 ai-recommendations，并调用 monitoring.generate_analysis。
17. 语义摘要的 supportingEvidence 先展示，primaryEvidence 最后聚焦。回复只概括目标和将要显示的证据，不复述或扩展模型内部推理。`;

export async function decideWithDeepSeek(
  config: AgentGatewayConfig,
  input: string,
  history: ConversationTurn[],
  runtimeContext = "",
  onProgress?: SemanticProgressListener,
  modelPreferences: Partial<AgentModelPreferences> = DEFAULT_MODEL_PREFERENCES,
  signal?: AbortSignal,
): Promise<DeepSeekDecision> {
  const effectiveModelPreferences = resolveModelPreferences(modelPreferences);
  const candidateHistory = history.slice(-CONTINUATION_CONTEXT_TURNS);
  const relevantHistory = selectRelevantConversationHistory(input, candidateHistory);
  let effectiveInput = input;
  onProgress?.({
    phase: "understanding",
    status: "active",
    detail: "正在区分当前值、趋势、波动、空间分布、状态与建议等信息目标",
  });
  if (isExplicitVehicleEmergencyStop(input)) {
    const semantic = semanticBrief(
      "direct-control",
      "立即停止车辆",
      [],
      null,
      "named-page-region",
      [],
      "使用不经过模型的车辆安全急停动作",
      "等待 Jetson 返回真实停车结果",
    );
    onProgress?.({ phase: "understanding", status: "complete", detail: "已理解：立即停止车辆" });
    onProgress?.({ phase: "evidence", status: "active", detail: "正在核对车辆安全急停规则" });
    onProgress?.({ phase: "evidence", status: "complete", detail: "车辆急停无需模型规划或二次确认" });
    onProgress?.({ phase: "actions", status: "active", detail: "正在生成车辆安全急停动作" });
    onProgress?.({ phase: "actions", status: "complete", detail: "已生成 1 个候选动作" });
    return {
      reply: "正在请求车辆停止。",
      actions: [{ name: "vehicle.stop", arguments: {} }],
      planningMode: effectiveModelPreferences.thinkingMode,
      semantic,
    };
  }
  const immediateNavigation = deterministicImmediateNavigationDecision(input);
  if (immediateNavigation) {
    const semantic = semanticBrief(
      "navigation",
      `打开${immediateNavigation.label}`,
      [],
      null,
      "named-page-region",
      [],
      `使用受限站内导航进入${immediateNavigation.label}`,
      `最终显示${immediateNavigation.label}页面`,
    );
    onProgress?.({ phase: "understanding", status: "complete", detail: `已理解：打开${immediateNavigation.label}` });
    onProgress?.({ phase: "evidence", status: "active", detail: "正在核对站内导航白名单" });
    onProgress?.({ phase: "evidence", status: "complete", detail: "纯页面导航不需要读取遥测或请求模型" });
    onProgress?.({ phase: "actions", status: "active", detail: "正在生成站内导航动作" });
    onProgress?.({ phase: "actions", status: "complete", detail: "已生成 1 个候选动作" });
    return {
      reply: `正在打开${immediateNavigation.label}。`,
      actions: [immediateNavigation.action],
      planningMode: effectiveModelPreferences.thinkingMode,
      semantic,
    };
  }
  if (!config.mockMode && !config.deepSeekApiKey) throw new Error("尚未配置 DEEPSEEK_API_KEY");
  if (!config.mockMode && relevantHistory.length) {
    try {
      const contextResolution = await requestDeepSeekContextResolution(
        config,
        input,
        relevantHistory,
        runtimeContext,
        effectiveModelPreferences,
        signal,
      );
      effectiveInput = contextResolution.resolvedInput;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      effectiveInput = fallbackContextResolution(input, relevantHistory);
      onProgress?.({
        phase: "understanding",
        status: "active",
        detail: `上下文解析暂未返回，已结合最近一轮明确承接内容继续处理：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  let semanticDraft: SemanticIntentBrief;
  if (config.mockMode) {
    semanticDraft = inferLocalSemanticBrief(input, runtimeContext);
  } else {
    try {
      semanticDraft = await requestDeepSeekSemanticBrief(
        config,
        effectiveInput,
        [],
        runtimeContext,
        effectiveModelPreferences,
        signal,
      );
    } catch (error) {
      if (!isRecoverableSemanticResponseFailure(error)) throw error;
      semanticDraft = inferLocalSemanticBrief(effectiveInput, runtimeContext);
      onProgress?.({
        phase: "understanding",
        status: "active",
        detail: "云端语义摘要暂不可用，正在使用公开、可校验的本地语义继续规划",
      });
    }
  }
  const semantic = reconcileSemanticIntent(effectiveInput, semanticDraft, runtimeContext);
  const vehicleDirectControl = semantic.goal === "direct-control";
  let operationalIntent: OperationalIntent | null = null;
  let operationalWarning: string | null = null;
  if (!config.mockMode && vehicleDirectControl) {
    try {
      operationalIntent = await requestDeepSeekOperationalIntent(
        config,
        effectiveInput,
        [],
        runtimeContext,
        effectiveModelPreferences,
        signal,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      operationalWarning = `车辆任务约束复核暂不可用，已继续使用协议有效的尽力规划：${reason}`;
    }
    if (operationalIntent?.confidence === "low") {
      onProgress?.({ phase: "understanding", status: "complete", detail: `还需要补充：${operationalIntent.reason}` });
      onProgress?.({ phase: "evidence", status: "complete", detail: "已保留本轮上下文，等待补充信息" });
      onProgress?.({ phase: "actions", status: "complete", detail: "信息不足，未生成设备动作" });
      return {
        reply: `我还需要你补充：${operationalIntent.reason}`,
        actions: [],
        planningMode: effectiveModelPreferences.thinkingMode,
        semantic,
        planQuality: "best-effort",
        warnings: [operationalIntent.reason],
      };
    }
    if (operationalIntent && (
      operationalIntent.domain !== "vehicle-control"
      || !operationalIntent.vehicleRequirements
    )) {
      operationalWarning = "车辆任务约束复核与已确认的车辆意图不一致，已继续使用协议有效的尽力规划。";
    }
  }
  onProgress?.({ phase: "understanding", status: "complete", detail: `已理解：${semantic.summary}` });
  onProgress?.({ phase: "evidence", status: "active", detail: "正在匹配能够直接回答问题的数据证据" });
  onProgress?.({ phase: "evidence", status: "complete", detail: `证据路径：${semantic.evidenceSummary}` });
  onProgress?.({ phase: "actions", status: "active", detail: "正在把信息目标编排为受限页面动作" });

  if (!config.mockMode && vehicleDirectControl) {
    const requirements = operationalIntent?.domain === "vehicle-control"
      && operationalIntent.vehicleRequirements
      ? operationalIntent.vehicleRequirements
      : defaultVehiclePlanRequirements();
    const draft = await planVehicleDirectControl(
      config,
      effectiveInput,
      semantic,
      requirements,
      [],
      runtimeContext,
      effectiveModelPreferences,
      (detail) => onProgress?.({ phase: "actions", status: "active", detail }),
      signal,
    );
    onProgress?.({ phase: "actions", status: "complete", detail: `已生成并校验 ${draft.actions.length} 个车辆原子动作` });
    return {
      reply: draft.reply || `好的，正在${semantic.summary}。`,
      actions: draft.actions,
      planningMode: effectiveModelPreferences.thinkingMode,
      semantic,
      planQuality: operationalWarning ? "best-effort" : draft.planQuality,
      warnings: operationalWarning
        ? [...(draft.warnings ?? []), operationalWarning]
        : draft.warnings,
    };
  }

  if (config.mockMode) {
    const mock = mockDecision(input, semantic);
    const actions = ensureSemanticEvidenceCoverage(
      input,
      semantic,
      ensureExplicitActionCoverage(input, mock.actions),
    );
    onProgress?.({ phase: "actions", status: "complete", detail: `已生成 ${actions.length} 个候选动作` });
    return { ...mock, actions, planningMode: effectiveModelPreferences.thinkingMode, semantic };
  }
  const semanticContext = `本次请求的公开语义摘要如下。它是动作规划的约束，不是思维链：${JSON.stringify(semantic)}。请先安排 supportingEvidence，再让 primaryEvidence 成为最终聚焦区域，并满足 successCriterion。`;
  const baseMessages: ModelMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: "告警工单处理必须服从运行时权限。权限已开启时，可以使用运行时真实列表中的 alertId/version 自主规划 alerts.begin_processing 与 alerts.complete_work_order；禁止猜测编号、版本、现场检查结果或设备修复结果。待处理工单开始后版本加一，只有具备充分数据依据时才能继续完成，否则应停在处理中并说明需要人工核验。权限未开启时只能查看和讲解。任何情况下都不能修改告警阈值。" },
    { role: "system", content: "车辆动作严格区分：明确前后距离使用 vehicle.move_distance，明确左右转角使用 vehicle.turn_angle，仅无距离/角度的短时方向控制使用 vehicle.propose_move，停止使用 vehicle.stop。正方形、往返、巡线路径等复合任务不得写成固定场景工具，应由通用移动与转向动作按几何和用户顺序组成完整计划；每段等待 Jetson 终态后再执行下一段。车辆当前绝对航向可以是任意 0–360° 数值，非 0° 永远不是异常、信息不足或拒绝动作的理由；固定点导航由确定性运行时把地图绝对航向与 IMU 相对航向对齐，普通定距和定角动作以车体当前姿态为基准。运行时显示自主权限开启时会直接执行；未开启时创建确认请求。工具规划回复不得冒充已发送或已完成，最终执行结果完全以网关收到的同 request_id 设备回执为准。" },
    ...(runtimeContext ? [{ role: "system" as const, content: runtimeContext }] : []),
    { role: "system", content: semanticContext },
    ...relevantHistory,
    { role: "user", content: effectiveInput },
  ];
  let draft: DeepSeekPlanDraft;
  try {
    draft = await requestDeepSeekPlan(
      config,
      baseMessages,
      effectiveModelPreferences.thinkingMode,
      effectiveModelPreferences,
      signal,
    );
  } catch (error) {
    if (!canRecoverPlanFromSemantic(semantic) || !isRecoverablePlanningResponseFailure(error)) throw error;
    onProgress?.({
      phase: "actions",
      status: "active",
      detail: "云端规划响应较慢，正在依据已确认的语义证据完成动作编排",
    });
    draft = {
      reply: "",
      actions: [],
      planQuality: "best-effort",
      warnings: ["云端动作规划本轮未完整返回，已依据已确认的语义目标补齐确定性页面动作。"],
    };
  }
  if (draft.actions.some((action) => VEHICLE_DIRECT_ACTIONS.has(action.name))) {
    let recoveredIntent: OperationalIntent | null = null;
    let recoveredWarning: string | null = null;
    try {
      recoveredIntent = await requestDeepSeekOperationalIntent(
        config,
        effectiveInput,
        [],
        runtimeContext,
        effectiveModelPreferences,
        signal,
      );
    } catch (error) {
      recoveredWarning = `车辆意图复核暂不可用，已将模型返回的车辆动作转入专用协议规划器重新生成：${error instanceof Error ? error.message : String(error)}`;
    }

    if (recoveredIntent?.domain !== "vehicle-control") {
      if (recoveredIntent) {
        draft = {
          ...draft,
          actions: draft.actions.filter((action) => !VEHICLE_DIRECT_ACTIONS.has(action.name)),
          planQuality: "best-effort",
          warnings: [
            ...(draft.warnings ?? []),
            "通用规划器返回了与 AI 意图复核不一致的车辆动作，已移除这些动作且未向车辆发送。",
          ],
        };
      } else {
        const recoveredSemantic: SemanticIntentBrief = {
          ...semantic,
          goal: "direct-control",
          summary: semantic.summary === "理解并处理当前请求"
            ? "执行车辆任务"
            : semantic.summary,
          timeRange: null,
          primaryEvidence: "named-page-region",
          supportingEvidence: [],
          evidenceSummary: "使用车辆专用原子动作与真实设备回执完成任务",
          successCriterion: "所有车辆动作依次收到对应真实完成回执",
        };
        const vehicleDraft = await planVehicleDirectControl(
          config,
          effectiveInput,
          recoveredSemantic,
          defaultVehiclePlanRequirements(),
          [],
          runtimeContext,
          effectiveModelPreferences,
          (detail) => onProgress?.({ phase: "actions", status: "active", detail }),
          signal,
        );
        onProgress?.({ phase: "actions", status: "complete", detail: `已生成并校验 ${vehicleDraft.actions.length} 个车辆原子动作` });
        return {
          reply: vehicleDraft.reply || `好的，正在${recoveredSemantic.summary}。`,
          actions: vehicleDraft.actions,
          planningMode: effectiveModelPreferences.thinkingMode,
          semantic: recoveredSemantic,
          planQuality: "best-effort",
          warnings: [...(vehicleDraft.warnings ?? []), recoveredWarning ?? "车辆动作已转入专用协议规划器复核。"],
        };
      }
    } else {
      if (recoveredIntent.confidence === "low") {
        onProgress?.({ phase: "actions", status: "complete", detail: "车辆任务信息不足，未生成设备动作" });
        return {
          reply: `我还需要你补充：${recoveredIntent.reason}`,
          actions: [],
          planningMode: effectiveModelPreferences.thinkingMode,
          semantic,
          planQuality: "best-effort",
          warnings: [recoveredIntent.reason],
        };
      }
      const recoveredSemantic: SemanticIntentBrief = {
        ...semantic,
        goal: "direct-control",
        summary: recoveredIntent.summary,
        timeRange: null,
        primaryEvidence: "named-page-region",
        supportingEvidence: [],
        evidenceSummary: "使用车辆专用原子动作与真实设备回执完成任务",
        successCriterion: recoveredIntent.successCriterion,
      };
      const vehicleDraft = await planVehicleDirectControl(
        config,
        effectiveInput,
        recoveredSemantic,
        recoveredIntent.vehicleRequirements ?? defaultVehiclePlanRequirements(),
        [],
        runtimeContext,
        effectiveModelPreferences,
        (detail) => onProgress?.({ phase: "actions", status: "active", detail }),
        signal,
      );
      onProgress?.({ phase: "actions", status: "complete", detail: `已生成并校验 ${vehicleDraft.actions.length} 个车辆原子动作` });
      return {
        reply: vehicleDraft.reply || `好的，正在${recoveredSemantic.summary}。`,
        actions: vehicleDraft.actions,
        planningMode: effectiveModelPreferences.thinkingMode,
        semantic: recoveredSemantic,
        planQuality: recoveredWarning ? "best-effort" : vehicleDraft.planQuality,
        warnings: recoveredWarning
          ? [...(vehicleDraft.warnings ?? []), recoveredWarning]
          : vehicleDraft.warnings,
      };
    }
  }
  const planningMode = choosePlanningMode(effectiveModelPreferences.thinkingMode, effectiveInput, draft.actions);
  const completedActions = ensureSemanticEvidenceCoverage(
    effectiveInput,
    semantic,
    ensureExplicitActionCoverage(effectiveInput, draft.actions),
  );
  onProgress?.({ phase: "actions", status: "complete", detail: `已生成 ${completedActions.length} 个候选动作` });
  return {
    reply: draft.reply || (completedActions.length ? `好的，正在${semantic.summary}。` : "我没有理解这条指令。"),
    actions: completedActions,
    planningMode,
    semantic,
    planQuality: draft.planQuality,
    warnings: draft.warnings,
  };
}

function isRecoverablePlanningResponseFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:timed?\s*out|timeout|aborted due to timeout|动作规划未完成|动作规划暂时不可用|未返回有效动作规划消息|动作列表为空|工具参数不是有效 JSON)/i.test(message);
}

function canRecoverPlanFromSemantic(semantic: SemanticIntentBrief) {
  return semantic.goal !== "direct-control"
    && semantic.goal !== "navigation"
    && semantic.goal !== "other";
}

export function selectRelevantConversationHistory(input: string, history: ConversationTurn[]) {
  const referencesPriorTurn = /(?:^|[，。！？\s])(然后|接着|继续|再来|还是|另外|刚才|之前|上一(?:个|项|步)|把它|将它|这个|那个|同样|照刚才|改成|换成)/.test(input.trim());
  const lastAssistant = findLastMatching(history, (turn) => turn.role === "assistant")?.content ?? "";
  const looksLikeClarificationAnswer = input.trim().length <= 80
    && /(?:还需要|请补充|缺少|需要你提供|请告诉我).{0,80}(?:距离|角度|尺寸|名称|检查点|方向|时长|数量|半径|直径|长|宽)/.test(lastAssistant);
  return referencesPriorTurn || looksLikeClarificationAnswer
    ? history.slice(-CONTEXT_MODEL_TURNS)
    : [];
}

function fallbackContextResolution(input: string, history: ConversationTurn[]) {
  const lastUser = findLastMatching(history, (turn) => turn.role === "user")?.content;
  if (!lastUser) return input;
  return `${lastUser}\n用户本轮补充：${input}`;
}

export function inferLocalSemanticBrief(input: string, runtimeContext = ""): SemanticIntentBrief {
  const text = input.trim();
  const subjects = inferSemanticSubjects(text);
  const timeRange = inferSemanticTimeRange(text);
  const hasVehicle = /(小车|车辆|Jetson)/i.test(text);
  const recommendationsNegated = /(?:不要|不用|无需|不需要|别).{0,8}(?:建议|方案|改善|处理)/.test(text);

  if (!recommendationsNegated && /(建议|怎么办|怎么改善|如何改善|怎么处理|如何处理|给.*方案)/.test(text)) {
    const supportingEvidence: SemanticEvidence[] = [];
    if (/(变化大不大|波动|稳定|起伏|变幅|变化幅度|哪个时段|时段.*明显)/.test(text)) {
      supportingEvidence.push("indicator-posture", "daily-heatmap");
    }
    if (/(相关|关系|一起变化|同步变化|是否同步|对比|比较)/.test(text)) {
      supportingEvidence.push("correlation-matrix");
    }
    supportingEvidence.push("ai-problems");
    return semanticBrief(
      "recommendations",
      subjects.length ? `分析${subjectNames(subjects)}的问题并形成处理建议` : "识别当前问题并形成处理建议",
      subjects,
      timeRange ?? "24h",
      "ai-recommendations",
      [...new Set(supportingEvidence)].slice(0, 4),
      supportingEvidence.length > 1
        ? "先查看变化、时段或关联证据，再呈现问题描述与对应建议"
        : "先呈现问题描述，再呈现对应建议",
      "最终聚焦处理建议，并保留可查看的问题依据",
    );
  }
  if (/(连接|链路|在线|离线|接入|配对)/.test(text)) {
    const primaryEvidence = /(传感|华为云|IoTDA)/i.test(text)
      ? "sensor-connection"
      : hasVehicle
        ? "vehicle-connection"
        : /(?:AI|智能中枢|DeepSeek)/i.test(text)
          ? "ai-connection"
          : "connection-summary";
    return semanticBrief(
      "connection-health",
      "检查相关连接链路的当前状态",
      subjects,
      null,
      primaryEvidence,
      primaryEvidence === "connection-summary" ? [] : ["connection-summary"],
      "重新检查连接，并聚焦对应链路状态",
      "最终显示能判断在线、离线或异常的连接证据",
    );
  }
  if (hasVehicle && /(摄像头|相机|实时画面|车载画面|前方视野)/.test(text)) {
    return semanticBrief(
      "vehicle-state",
      "查看小车车载摄像头的实时画面",
      subjects,
      null,
      "vehicle-camera",
      [],
      "打开小车页面并聚焦车载摄像头",
      "最终显示车载摄像头画面及其真实连接状态",
    );
  }
  if (hasVehicle && /(状态|回传|速度|电量|位置|在哪|轨迹)/.test(text)) {
    const primaryEvidence = /(位置|在哪|轨迹)/.test(text) ? "inspection-map" : "vehicle-status";
    return semanticBrief(
      "vehicle-state",
      primaryEvidence === "inspection-map" ? "查看小车当前位置与巡检轨迹" : "查看小车当前状态与回传",
      subjects,
      null,
      primaryEvidence,
      [],
      primaryEvidence === "inspection-map" ? "使用巡检地图呈现位置关系" : "使用车辆状态卡呈现当前回传",
      "最终聚焦与所问车辆状态直接对应的区域",
    );
  }
  if (isSpatialMapRequest(text)) {
    const primaryEvidence = inferSpatialMapEvidence(text, runtimeContext);
    const isInspectionMap = primaryEvidence === "inspection-map";
    return semanticBrief(
      "spatial-pattern",
      subjects.length
        ? `查看${subjectNames(subjects)}的${isInspectionMap ? "巡检地图图层" : "空间分布差异"}`
        : `查看环境数据的${isInspectionMap ? "巡检地图图层" : "空间分布差异"}`,
      subjects,
      isInspectionMap ? null : timeRange ?? "24h",
      primaryEvidence,
      [],
      isInspectionMap ? "使用小车巡检地图呈现所选环境图层" : "使用空间分布图呈现不同位置的差异",
      isInspectionMap ? "最终聚焦小车巡检地图中的目标数据图层" : "最终聚焦具有位置关系的环境数据图层",
    );
  }
  if (/(?:实时|当前|现在|此刻).{0,8}(?:曲线|变化过程)|(?:曲线|变化过程).{0,8}(?:实时|当前|现在|此刻)/.test(text)) {
    return semanticBrief(
      "trend",
      subjects.length ? `查看${subjectNames(subjects)}的实时变化过程` : "查看数据的实时变化过程",
      subjects,
      null,
      "live-curve",
      [],
      "使用实时曲线呈现连续变化",
      "最终只显示用户指定指标的实时曲线",
    );
  }
  if (/(变化大不大|波动|稳定|起伏|变幅|变化幅度|哪个时段.*变化|变化.*明显)/.test(text)) {
    return semanticBrief(
      "variation",
      subjects.length ? `判断近期${subjectNames(subjects)}的波动幅度与发生时段` : "判断近期数据的波动幅度与发生时段",
      subjects,
      timeRange ?? "24h",
      "daily-heatmap",
      ["indicator-posture"],
      "使用日内热力图观察变化时段，并以指标态势核对波动幅度",
      "最终聚焦能体现变化大小与发生时段的图表",
    );
  }
  if (/(相关|关系|一起变化|同步变化|对比|比较)/.test(text)) {
    const evidence: SemanticEvidence = /(相关|关系|一起变化|同步变化)/.test(text)
      ? "correlation-matrix"
      : "range-profile";
    return semanticBrief(
      "comparison",
      subjects.length ? `比较${subjectNames(subjects)}的变化特征` : "比较多个指标的变化特征",
      subjects,
      timeRange ?? "24h",
      evidence,
      ["indicator-posture"],
      evidence === "correlation-matrix" ? "使用相关性矩阵比较同步变化" : "使用范围画像比较波动范围",
      "最终聚焦能够直接支持比较结论的图表",
    );
  }
  if (/(趋势|走势|上升|下降|升高|降低|随时间|变化如何|怎么变)/.test(text)) {
    return semanticBrief(
      "trend",
      subjects.length ? `查看${subjectNames(subjects)}随时间的变化方向` : "查看数据随时间的变化方向",
      subjects,
      timeRange ?? "24h",
      "indicator-posture",
      ["live-curve"],
      "使用指标态势判断升降方向，并以曲线补充时间过程",
      "最终聚焦能够体现趋势方向的图表",
    );
  }
  if (/(问题|异常|关注项|风险|缺失|断流)/.test(text)) {
    return semanticBrief(
      "problem-diagnosis",
      subjects.length ? `识别${subjectNames(subjects)}中的问题与异常` : "识别当前数据中的问题与异常",
      subjects,
      timeRange ?? "24h",
      "ai-problems",
      ["indicator-posture"],
      "先用指标证据定位异常，再呈现问题描述",
      "最终聚焦问题描述并保留数据证据",
    );
  }
  if (subjects.length && /(当前|现在|此刻|多少|读数|数值)/.test(text)) {
    return semanticBrief(
      "current-value",
      `读取${subjectNames(subjects)}的当前数值`,
      subjects,
      null,
      "current-reading",
      [],
      "读取对应传感器的最新有效值",
      "返回带单位和状态的当前读数",
    );
  }
  if (/(前进|向前|往前|后退|向后|往后|左转|右转|停止|急停|停车|标定|校准)/.test(text)) {
    return semanticBrief("direct-control", "执行明确的受限控制动作", subjects, null, "named-page-region", [], "使用已注册的安全动作", "动作参数通过白名单与安全限制");
  }
  if (/(打开|切换|进入|前往|去到|转到|回到|显示|查看|返回|上一页|回去|看看|聚焦|定位|滚动|往下|往上)/.test(text)) {
    return semanticBrief("navigation", "打开并定位用户指定的界面内容", subjects, null, "named-page-region", [], "使用命名页面区域完成定位", "最终界面与用户指定内容一致");
  }
  return semanticBrief("other", "理解并处理当前请求", subjects, timeRange, "named-page-region", [], "仅使用与请求直接相关的受限动作", "不执行无法从请求确定的操作");
}

function isSpatialMapRequest(input: string) {
  return /(空间分布|位置分布|哪里.{0,10}(?:高|低|异常|变化)|哪个区域|不同位置|地图图层|(?:环境温度|温度|环境湿度|湿度|二氧化碳|CO2|CO₂|TVOC|甲醛|HCHO|环境光照|光照)(?:空间)?(?:地图|分布图|图层))/i.test(input);
}

function inferSpatialMapEvidence(input: string, runtimeContext: string): Extract<SemanticEvidence, "spatial-distribution" | "inspection-map"> {
  const explicitlyInspection = /(?:小车|车辆|Jetson|巡检(?:地图|视野|图层)?|轨迹(?:地图)?)/i.test(input);
  if (explicitlyInspection) return "inspection-map";

  const explicitlyMonitoring = /(?:数据)?监测(?:页|分析)?|分析(?:页|洞察)|空间分布|位置分布|房间|室内|区域|不同位置|哪里/.test(input);
  if (explicitlyMonitoring) return "spatial-distribution";

  const currentPageIsVehicle = /目标屏幕当前位于(?:小车遥控|小车巡检)|(?:currentPage|current page)\s*(?:=|:|为|is)\s*["']?vehicle/i.test(runtimeContext);
  if (currentPageIsVehicle) return "inspection-map";

  return "spatial-distribution";
}

export function reconcileSemanticIntent(
  input: string,
  modelBrief: SemanticIntentBrief,
  runtimeContext = "",
): SemanticIntentBrief {
  const checkpointNames = knownCheckpointNames(runtimeContext);
  const referencesKnownCheckpoint = checkpointNames.some((name) => (
    input.normalize("NFKC").toLocaleLowerCase("zh-CN")
      .includes(name.normalize("NFKC").toLocaleLowerCase("zh-CN"))
  ));
  const modelDescribesCheckpointTravel = /(?:前往|到达|导航到|去往)/.test(modelBrief.summary);
  if (referencesKnownCheckpoint && modelDescribesCheckpointTravel) {
    return {
      ...modelBrief,
      goal: "direct-control",
      timeRange: null,
      primaryEvidence: "named-page-region",
      supportingEvidence: [],
      evidenceSummary: "使用已命名固定检查点执行真实导航，到达后再按请求处理现场检测",
      successCriterion: "车辆真实到达指定固定检查点；需要检测时在到达后读取现场数据",
    };
  }
  if (modelBrief.goal === "spatial-pattern" && isSpatialMapRequest(input)) {
    const primaryEvidence = inferSpatialMapEvidence(input, runtimeContext);
    return {
      ...modelBrief,
      primaryEvidence,
      supportingEvidence: modelBrief.supportingEvidence.filter((item) => item !== primaryEvidence),
      timeRange: primaryEvidence === "inspection-map"
        ? null
        : modelBrief.timeRange ?? inferSemanticTimeRange(input) ?? "24h",
    };
  }
  return modelBrief;
}

function knownCheckpointNames(runtimeContext: string) {
  const match = runtimeContext.match(/目标客户端固定检查点目录：(\[[\s\S]*?\])。标定状态/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (typeof item === "string" && item.trim()) return [item.trim()];
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const name = (item as Record<string, unknown>).name;
      return typeof name === "string" && name.trim() ? [name.trim()] : [];
    });
  } catch {
    return [];
  }
}

function isRecoverableSemanticResponseFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return !message.includes("语义摘要被内容过滤中止");
}

export function ensureSemanticEvidenceCoverage(
  input: string,
  semantic: SemanticIntentBrief,
  actions: AgentAction[],
) {
  if (semantic.goal === "direct-control") {
    return actions.filter((action) => (
      !["telemetry.read_current", "ui.focus_region", "ui.scroll"].includes(action.name)
    ));
  }
  const analyticalGoals: SemanticInformationGoal[] = [
    "trend", "variation", "comparison", "spatial-pattern", "problem-diagnosis", "recommendations",
  ];
  const semanticEvidence = new Set([semantic.primaryEvidence, ...semantic.supportingEvidence]);
  const semanticRegions = new Set(
    [...semanticEvidence].map(evidenceRegion).filter((item): item is Exclude<ReturnType<typeof evidenceRegion>, null> => item !== null),
  );
  const spatialTarget = semantic.goal === "spatial-pattern" ? semantic.primaryEvidence : null;
  let result = actions.filter((action) => {
    if (analyticalGoals.includes(semantic.goal) && action.name === "telemetry.read_current") return false;
    if (action.name === "ui.focus_region" && semanticRegions.has(`${action.arguments.page}/${action.arguments.region}`)) return false;
    if (spatialTarget === "inspection-map") {
      if (action.name === "monitoring.set_range" || action.name === "telemetry.focus") return false;
      if (action.name === "ui.focus_region" && action.arguments.page === "monitoring" && action.arguments.region === "spatial-distribution") return false;
    }
    if (spatialTarget === "spatial-distribution") {
      if (action.name === "spatial.set_layer") return false;
      if (action.name === "ui.focus_region" && action.arguments.page === "vehicle" && action.arguments.region === "inspection-map") return false;
    }
    return true;
  });
  const slotIds = semantic.subjects.flatMap((subject) => subject.slotId ? [subject.slotId] : []);

  if (semantic.timeRange && [...semanticEvidence].some(isMonitoringEvidence)) {
    result = result.filter((action) => action.name !== "monitoring.set_range");
    result.push(parseAgentAction("monitoring.set_range", { range: semantic.timeRange }));
  }
  if (slotIds.length && [...semanticEvidence].some(requiresFocusedTelemetry)) {
    result = result.filter((action) => action.name !== "telemetry.focus");
    result.push(parseAgentAction("telemetry.focus", { slotId: slotIds[0] }));
  }
  if (semanticEvidence.has("live-curve") && slotIds.length) {
    result = result.filter((action) => action.name !== "monitoring.set_visible_series");
    result.push(parseAgentAction("monitoring.set_visible_series", { slotIds }));
  }
  if (semanticEvidence.has("inspection-map") && slotIds.length) {
    result = result.filter((action) => action.name !== "spatial.set_layer");
    result.push(parseAgentAction("spatial.set_layer", { layer: slotIds[0] }));
  }
  if (semanticEvidence.has("ai-problems") || semanticEvidence.has("ai-recommendations")) {
    result = result.filter((action) => action.name !== "monitoring.generate_analysis");
    result.push(parseAgentAction("monitoring.generate_analysis", slotIds.length ? { slotIds } : {}));
  }
  if ([...semanticEvidence].some((item) => item.endsWith("connection") || item === "connection-summary")) {
    result = result.filter((action) => action.name !== "connections.refresh");
    result.push(parseAgentAction("connections.refresh", {}));
  }
  if (semantic.goal === "current-value" && !result.some((action) => action.name === "telemetry.read_current")) {
    result.push(parseAgentAction("telemetry.read_current", slotIds[0] ? { slotId: slotIds[0] } : {}));
  }

  for (const evidence of semantic.supportingEvidence) appendEvidenceFocus(result, evidence);
  appendEvidenceFocus(result, semantic.primaryEvidence);

  // Explicit stop remains a local safety intent and may never be displaced by semantic evidence.
  if (isExplicitVehicleEmergencyStop(input) && !result.some((action) => action.name === "vehicle.stop")) {
    result.unshift(parseAgentAction("vehicle.stop", {}));
  }
  return result;
}

function semanticBrief(
  goal: SemanticInformationGoal,
  summary: string,
  subjects: SemanticIntentSubject[],
  timeRange: TelemetryHistoryRange | null,
  primaryEvidence: SemanticEvidence,
  supportingEvidence: SemanticEvidence[],
  evidenceSummary: string,
  successCriterion: string,
): SemanticIntentBrief {
  return { goal, summary, subjects, timeRange, primaryEvidence, supportingEvidence, evidenceSummary, successCriterion };
}

function inferSemanticSubjects(input: string): SemanticIntentSubject[] {
  const catalog: Array<[RegExp, SemanticIntentSubject]> = [
    [/(环境温度|温度)/, { label: "环境温度", slotId: "slot-1" }],
    [/(环境湿度|湿度)/, { label: "环境湿度", slotId: "slot-2" }],
    [/(二氧化碳|CO2|CO₂)/i, { label: "二氧化碳", slotId: "slot-3" }],
    [/(TVOC|挥发性有机物)/i, { label: "TVOC", slotId: "slot-4" }],
    [/(甲醛|HCHO)/i, { label: "甲醛", slotId: "slot-5" }],
    [/(环境光照|光照|亮度)/, { label: "环境光照", slotId: "slot-6" }],
  ];
  return catalog.filter(([pattern]) => pattern.test(input)).map(([, subject]) => ({ ...subject }));
}

function inferSemanticTimeRange(input: string): TelemetryHistoryRange | null {
  if (/(30\s*天|三十天|一个月|近月|本月)/.test(input)) return "30d";
  if (/(7\s*天|七天|一周|近周|本周)/.test(input)) return "7d";
  if (/(1\s*小时|一小时|近一小时|最近一小时)/.test(input)) return "1h";
  if (/(24\s*小时|二十四小时|一天|今天|最近|近期)/.test(input)) return "24h";
  return null;
}

function subjectNames(subjects: SemanticIntentSubject[]) {
  return subjects.map((subject) => subject.label).join("与");
}

function isMonitoringEvidence(evidence: SemanticEvidence) {
  return [
    "live-curve", "indicator-posture", "range-profile", "correlation-matrix", "daily-heatmap",
    "spatial-distribution", "history-table", "event-timeline", "ai-problems", "ai-recommendations",
  ].includes(evidence);
}

function requiresFocusedTelemetry(evidence: SemanticEvidence) {
  return [
    "live-curve", "indicator-posture", "range-profile", "daily-heatmap", "spatial-distribution",
    "history-table", "ai-problems", "ai-recommendations",
  ].includes(evidence);
}

function evidenceRegion(evidence: SemanticEvidence): string | null {
  const regions: Partial<Record<SemanticEvidence, string>> = {
    "live-curve": "monitoring/live-chart",
    "indicator-posture": "monitoring/indicator-posture",
    "range-profile": "monitoring/range-profile",
    "correlation-matrix": "monitoring/correlation-matrix",
    "daily-heatmap": "monitoring/daily-heatmap",
    "spatial-distribution": "monitoring/spatial-distribution",
    "history-table": "monitoring/history-table",
    "event-timeline": "monitoring/event-timeline",
    "ai-problems": "monitoring/ai-problems",
    "ai-recommendations": "monitoring/ai-recommendations",
    "connection-summary": "integrations/connection-summary",
    "sensor-connection": "integrations/sensor-connection",
    "vehicle-connection": "integrations/vehicle-connection",
    "ai-connection": "integrations/ai-connection",
    "vehicle-status": "vehicle/vehicle-status",
    "inspection-map": "vehicle/inspection-map",
    "vehicle-camera": "vehicle/vehicle-camera",
    "twin-viewport": "digital-twin/viewport",
  };
  return regions[evidence] ?? null;
}

function appendEvidenceFocus(actions: AgentAction[], evidence: SemanticEvidence) {
  const region = evidenceRegion(evidence);
  if (!region) return;
  const [page, regionName] = region.split("/");
  actions.push(parseAgentAction("ui.focus_region", { page, region: regionName }));
}

export function ensureExplicitActionCoverage(input: string, actions: AgentAction[]) {
  const result = [...actions];
  const changesSettings = result.some((action) => action.name.startsWith("settings.set_"));
  const explicitlyPersistsSettings = /(?:保存|应用|确认修改|立即生效|持久化)/.test(input)
    && !/(?:不要|不用|无需|别).{0,6}(?:保存|应用|持久化)/.test(input);
  if (changesSettings && explicitlyPersistsSettings
    && !result.some((action) => action.name === "settings.save")) {
    result.push(parseAgentAction("settings.save", {}));
  }
  const orbitPhrase = /(环绕|环视|绕(?:房间|模型|空间|一|半|两|三|四|[0-9.]+)?.{0,4}圈|(?:从|看遍)四周)/;
  const orbitNegated = /(?:不要|不用|无需|取消|停止).{0,6}(?:环绕|环视|绕|四周)/.test(input);
  const wantsOrbit = orbitPhrase.test(input) && !orbitNegated;
  if (!wantsOrbit) return result;

  const gapPhrase = /(缺陷|缺口|空缺|漏洞|漏扫|未建模|没拍到)/;
  const gapNegated = /(?:不要|不用|无需|关闭|隐藏).{0,6}(?:缺陷|缺口|空缺|诊断)/.test(input);
  const wantsGapDiagnostic = gapPhrase.test(input) && !gapNegated;
  let orbitIndex = result.findIndex((action) => action.name === "twin.orbit");

  if (wantsGapDiagnostic) {
    const diagnosticIndex = result.findIndex(
      (action) => action.name === "twin.set_gap_diagnostic" && action.arguments.active,
    );
    if (diagnosticIndex < 0) {
      const insertionIndex = orbitIndex < 0 ? result.length : orbitIndex;
      result.splice(insertionIndex, 0, {
        name: "twin.set_gap_diagnostic",
        arguments: { active: true },
      });
      if (orbitIndex >= 0) orbitIndex += 1;
    } else if (orbitIndex >= 0 && diagnosticIndex > orbitIndex) {
      const [diagnostic] = result.splice(diagnosticIndex, 1);
      result.splice(orbitIndex, 0, diagnostic);
      orbitIndex += 1;
    }
  }

  if (orbitIndex < 0) result.push(parseAgentAction("twin.orbit", {}));
  return result;
}

type ModelMessage = { role: "system" | "user" | "assistant"; content: string };
type DeepSeekPlanDraft = Pick<DeepSeekDecision, "reply" | "actions" | "planQuality" | "warnings">;
type VehiclePlanProgressListener = (detail: string) => void;
type ContextResolution = {
  usesPriorContext: boolean;
  resolvedInput: string;
  reason: string;
};
type OperationalIntentDomain =
  | "vehicle-control"
  | "telemetry"
  | "ui-navigation"
  | "digital-twin"
  | "alerts"
  | "settings"
  | "connections"
  | "other";
type OperationalIntent = {
  domain: OperationalIntentDomain;
  confidence: "high" | "medium" | "low";
  summary: string;
  reason: string;
  successCriterion: string;
  vehicleRequirements: VehiclePlanRequirements | null;
};

export type VehiclePlanRequirements = {
  minimumMovementActions: number;
  minimumDistanceActions: number;
  minimumTurnActions: number;
  requiresClosedPosition: boolean;
  requiresOriginalHeading: boolean;
};

function defaultVehiclePlanRequirements(): VehiclePlanRequirements {
  return {
    minimumMovementActions: 1,
    minimumDistanceActions: 0,
    minimumTurnActions: 0,
    requiresClosedPosition: false,
    requiresOriginalHeading: false,
  };
}

const VEHICLE_DIRECT_ACTIONS = new Set<AgentAction["name"]>([
  "vehicle.propose_move",
  "vehicle.move_distance",
  "vehicle.turn_angle",
  "vehicle.navigate_to_checkpoint",
  "telemetry.inspect_current",
  "vehicle.stop",
]);

export async function requestDeepSeekContextResolution(
  config: AgentGatewayConfig,
  input: string,
  history: ConversationTurn[],
  runtimeContext: string,
  modelPreferences: AgentModelPreferences,
  signal?: AbortSignal,
  repairAttempt = false,
): Promise<ContextResolution> {
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: `你是对话上下文解析 Agent。只判断当前用户消息是否在承接历史，不规划动作，不判断动作权限，不展示思维链。
输入会以 JSON 对象提供，history 是按时间排列的历史消息，currentInput 是当前消息。必须显式比较二者，不能只看 currentInput。
如果上一条 assistant 消息说明原任务缺少某个参数，而当前用户直接补充该参数，usesPriorContext 必须为 true。此时 resolvedInput 必须把之前未完成的完整目标与本次补充合并，改写成一条脱离历史也能独立理解的用户指令。
代词、省略主语、回答澄清问题或明确表示继续时，也应在确实依赖历史的情况下合并。
如果当前消息本身是一条完整的新任务，usesPriorContext 必须为 false，resolvedInput 必须原样保留当前消息，不得把已完成或无关的旧任务带进来。
usesPriorContext=true 时，resolvedInput 必须保留原任务的目标对象、形状、数量、顺序、终点要求等全部仍有效约束，只把当前补充填入缺失位置；不得用补充参数的对象替换原任务目标。
不得编造历史和当前消息都没有的信息。只输出严格 JSON：{"usesPriorContext":true,"resolvedInput":"合并后的完整独立指令","reason":"简短公开依据"}。`,
    },
    ...(runtimeContext ? [{ role: "system" as const, content: runtimeContext }] : []),
    {
      role: "user",
      content: JSON.stringify({ history, currentInput: input }),
    },
    ...(repairAttempt ? [{
      role: "system" as const,
      content: "上一版上下文解析缺少字段或不是有效 JSON。请严格返回 usesPriorContext、resolvedInput、reason 三个字段。",
    }] : []),
  ];
  const response = await fetchDeepSeekWithRetry(`${config.deepSeekBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${config.deepSeekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      ...deepSeekThinkingParameters(modelPreferences),
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: CONTEXT_RESOLUTION_OUTPUT_TOKENS,
    }),
  }, MODEL_REQUEST_TIMEOUT_MS);
  const payload = await response.json().catch(() => {
    throw new Error(`DeepSeek 上下文解析返回了非 JSON 响应（HTTP ${response.status}）`);
  }) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: ModelFinalContent } }>;
  };
  if (!response.ok) throw new Error(payload.error?.message || `DeepSeek 上下文解析失败（${response.status}）`);
  const content = finalMessageText(payload.choices?.[0]?.message?.content);
  if (!content) {
    if (!repairAttempt) {
      return requestDeepSeekContextResolution(
        config,
        input,
        history,
        runtimeContext,
        modelPreferences,
        signal,
        true,
      );
    }
    throw new Error("DeepSeek 未返回上下文解析结果");
  }
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("DeepSeek 上下文解析结果无效");
    }
    if (typeof parsed.usesPriorContext !== "boolean") {
      throw new Error("DeepSeek 上下文解析 usesPriorContext 无效");
    }
    const resolvedInput = publicContextText(parsed.resolvedInput, "上下文合并指令", 2_000);
    return {
      usesPriorContext: parsed.usesPriorContext,
      resolvedInput: parsed.usesPriorContext ? resolvedInput : input,
      reason: publicContextText(parsed.reason, "上下文判断依据", 300),
    };
  } catch (error) {
    if (!repairAttempt) {
      return requestDeepSeekContextResolution(
        config,
        input,
        history,
        runtimeContext,
        modelPreferences,
        signal,
        true,
      );
    }
    throw error;
  }
}

function publicContextText(value: unknown, label: string, limit: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`DeepSeek ${label}无效`);
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

async function requestDeepSeekOperationalIntent(
  config: AgentGatewayConfig,
  input: string,
  history: ConversationTurn[],
  runtimeContext: string,
  modelPreferences: AgentModelPreferences,
  signal?: AbortSignal,
  repairAttempt = false,
): Promise<OperationalIntent> {
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: `你是星巡应用的意图路由 Agent。请根据当前用户原话自主判断最终目标，不生成动作，不展示思维链。
domain 只能是 vehicle-control、telemetry、ui-navigation、digital-twin、alerts、settings、connections、other。
vehicle-control 表示用户要让真实车辆运动、停止、转向或完成一条车辆路径；ui-navigation 表示只浏览页面，不改变车辆物理状态。不要因为“回到原点”等自然语言里出现“回到”就误判成页面返回。
输入已由独立的上下文解析 Agent 处理为可独立理解的当前请求；不要自行引入其他历史任务。
confidence 使用 high、medium、low。若无法确定用户最终目标，使用 low，并在 reason 中简短说明缺少什么信息。
当 domain=vehicle-control 时，还要根据用户真实语义给出 vehicleRequirements：minimumMovementActions 是完成目标至少需要的移动与转向动作总数，minimumDistanceActions 是至少需要的定距直线段数，minimumTurnActions 是至少需要的定角转向数；requiresClosedPosition 表示终点是否必须回到起点；requiresOriginalHeading 表示最终朝向是否必须恢复。只要求车辆回到起点、原点或原位置时，requiresClosedPosition=true，但不得据此擅自把 requiresOriginalHeading 设为 true；只有用户明确要求恢复初始朝向、原方向或原姿态时才设为 true。必须判断“回来”的语义主语：用户让助手“回来告诉我、回来汇报、回来给结果”是在要求完成后回复检测结果，不是让车辆返程；只有明确说小车、车辆或导航目标需要返回某个物理位置时，才增加返程动作或闭环约束。你应自行理解路径、重复次数和几何关系，不依赖关键词表。非车辆意图时 vehicleRequirements 必须为 null。
语义对照：“去油桶测量，回来告诉我检测结果”表示导航、检测并由助手回复，minimumMovementActions=1、requiresClosedPosition=false；“让小车去油桶测量，然后让车辆回到起点”才表示物理返程，requiresClosedPosition=true。不要把对话中的“回复给我”转写成车辆运动。
车辆运动必须能落实为可量化的距离、角度和执行顺序。若路径的必要任务级尺度、几何关系或方向无法从当前请求及明确承接的历史中可靠确定，confidence 必须为 low，reason 必须具体指出缺少的执行信息；不得自行编造尺寸或路径。用户给出可识别的几何形状和足够的边长、长宽、半径或直径后，就应把具体折线段数、每段距离和转角留给后续规划 Agent 推导，不能反过来要求用户提供底层动作参数。若用户要求前往运行时上下文中已经存在的固定检查点，则该检查点名称本身就是完整导航目标，不需要用户再提供距离、角度或坐标；如还要求测量检测，应由后续规划在导航动作后追加现场检测动作。仅前往固定检查点时，vehicleRequirements 应为 minimumMovementActions=1、minimumDistanceActions=0、minimumTurnActions=0；只有用户另外明确要求了定距移动或定角转向时才增加对应数量。
只输出严格 JSON：{"domain":"vehicle-control","confidence":"high","summary":"公开意图摘要","reason":"公开判断依据","successCriterion":"完成标准","vehicleRequirements":{"minimumMovementActions":1,"minimumDistanceActions":1,"minimumTurnActions":0,"requiresClosedPosition":false,"requiresOriginalHeading":false}}。`,
    },
    ...(runtimeContext ? [{ role: "system" as const, content: runtimeContext }] : []),
    ...history,
    { role: "user", content: input },
    ...(repairAttempt ? [{
      role: "system" as const,
      content: "上一版意图结果缺少字段或不符合指定 JSON 结构。请完整返回所有字段；车辆意图不要省略 vehicleRequirements。",
    }] : []),
  ];
  const response = await fetchDeepSeekWithRetry(`${config.deepSeekBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${config.deepSeekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      ...deepSeekThinkingParameters(modelPreferences),
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: SEMANTIC_OUTPUT_TOKENS,
    }),
  }, MODEL_REQUEST_TIMEOUT_MS);
  const payload = await response.json().catch(() => {
    throw new Error(`DeepSeek 意图识别返回了非 JSON 响应（HTTP ${response.status}）`);
  }) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: ModelFinalContent } }>;
  };
  if (!response.ok) throw new Error(payload.error?.message || `DeepSeek 意图识别失败（${response.status}）`);
  const content = finalMessageText(payload.choices?.[0]?.message?.content);
  if (!content) {
    if (!repairAttempt) {
      return requestDeepSeekOperationalIntent(
        config,
        input,
        history,
        runtimeContext,
        modelPreferences,
        signal,
        true,
      );
    }
    throw new Error("DeepSeek 未返回意图识别结果");
  }
  try {
    return parseOperationalIntent(content);
  } catch (error) {
    if (!repairAttempt) {
      return requestDeepSeekOperationalIntent(
        config,
        input,
        history,
        runtimeContext,
        modelPreferences,
        signal,
        true,
      );
    }
    throw error;
  }
}

function parseOperationalIntent(content: string): OperationalIntent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("DeepSeek 意图识别结果不是有效 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DeepSeek 意图识别结果无效");
  }
  const value = parsed as Record<string, unknown>;
  const domains: OperationalIntentDomain[] = [
    "vehicle-control", "telemetry", "ui-navigation", "digital-twin",
    "alerts", "settings", "connections", "other",
  ];
  if (!domains.includes(value.domain as OperationalIntentDomain)) {
    throw new Error("DeepSeek 意图识别 domain 无效");
  }
  if (!["high", "medium", "low"].includes(String(value.confidence))) {
    throw new Error("DeepSeek 意图识别 confidence 无效");
  }
  const domain = value.domain as OperationalIntentDomain;
  return {
    domain,
    confidence: value.confidence as OperationalIntent["confidence"],
    summary: publicIntentText(value.summary, "意图摘要"),
    reason: publicIntentText(value.reason, "意图依据"),
    successCriterion: publicIntentText(value.successCriterion, "完成标准"),
    vehicleRequirements: domain === "vehicle-control"
      ? parseVehiclePlanRequirements(value.vehicleRequirements)
      : null,
  };
}

function publicIntentText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`DeepSeek ${label}无效`);
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

function parseVehiclePlanRequirements(value: unknown): VehiclePlanRequirements {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DeepSeek 车辆任务约束无效");
  }
  const raw = value as Record<string, unknown>;
  const integer = (key: keyof VehiclePlanRequirements) => {
    const candidate = raw[key];
    if (!Number.isInteger(candidate) || Number(candidate) < 0 || Number(candidate) > 128) {
      throw new Error(`DeepSeek 车辆任务约束 ${key} 无效`);
    }
    return Number(candidate);
  };
  if (typeof raw.requiresClosedPosition !== "boolean"
    || typeof raw.requiresOriginalHeading !== "boolean") {
    throw new Error("DeepSeek 车辆任务终点约束无效");
  }
  return {
    minimumMovementActions: integer("minimumMovementActions"),
    minimumDistanceActions: integer("minimumDistanceActions"),
    minimumTurnActions: integer("minimumTurnActions"),
    requiresClosedPosition: raw.requiresClosedPosition,
    requiresOriginalHeading: raw.requiresOriginalHeading,
  };
}

async function planVehicleDirectControl(
  config: AgentGatewayConfig,
  input: string,
  semantic: SemanticIntentBrief,
  requirements: VehiclePlanRequirements,
  history: ConversationTurn[],
  runtimeContext: string,
  modelPreferences: AgentModelPreferences,
  onProgress?: VehiclePlanProgressListener,
  signal?: AbortSignal,
): Promise<DeepSeekPlanDraft> {
  let feedback = "";
  let lastReason = "候选计划未覆盖完整车辆目标";
  let bestCandidate: { draft: DeepSeekPlanDraft; issues: string[]; score: number } | null = null;
  for (let attempt = 1; attempt <= VEHICLE_PLAN_MAX_ATTEMPTS; attempt += 1) {
    onProgress?.(attempt === 1
      ? "正在生成完整车辆运动计划"
      : `正在根据完整性检查重新规划车辆动作（${attempt}/${VEHICLE_PLAN_MAX_ATTEMPTS}）`);
    let draft: DeepSeekPlanDraft;
    try {
      draft = await requestDeepSeekVehiclePlan(
        config,
        input,
        semantic,
        requirements,
        history,
        runtimeContext,
        modelPreferences,
        feedback,
        signal,
      );
      draft = { ...draft, actions: repairCheckpointPlan(draft.actions, requirements) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (
        !reason.startsWith("车辆候选计划动作协议无效")
        && !isRecoverableVehiclePlanDraftFailure(reason)
      ) throw error;
      lastReason = reason;
      feedback = `上一版车辆计划响应不可执行：${reason}`;
      continue;
    }
    const structuralIssues = validateVehiclePlanCompleteness(requirements, draft.actions);
    if (draft.actions.length) {
      const score = vehiclePlanCoverageScore(requirements, draft.actions, structuralIssues);
      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = { draft, issues: structuralIssues, score };
      }
    }
    if (structuralIssues.length) {
      lastReason = structuralIssues.join("；");
      feedback = `上一版计划未通过确定性结构检查：${lastReason}`;
      continue;
    }
    let review: { complete: boolean; reason: string };
    try {
      review = await reviewDeepSeekVehiclePlan(
        config,
        input,
        semantic,
        requirements,
        draft,
        modelPreferences,
        signal,
      );
    } catch (error) {
      return {
        ...draft,
        planQuality: "best-effort",
        warnings: [`AI 复核暂不可用，已继续执行通过确定性结构检查的完整协议计划：${error instanceof Error ? error.message : String(error)}`],
      };
    }
    if (review.complete) return { ...draft, planQuality: "verified", warnings: [] };
    lastReason = review.reason;
    if (bestCandidate && bestCandidate.draft === draft) {
      bestCandidate.issues = [review.reason];
      bestCandidate.score -= 2;
    }
    feedback = `上一版计划未通过目标完整性检查：${lastReason}`;
  }
  if (bestCandidate) {
    const checkpointReturnIssue = checkpointReturnLimitation(
      requirements,
      bestCandidate.draft.actions,
    );
    if (checkpointReturnIssue) {
      return {
        reply: `${checkpointReturnIssue}。请先把出发位置保存为固定检查点并告诉我名称，我会在同一上下文中重新规划完整往返路线。`,
        actions: [],
        planQuality: "best-effort",
        warnings: [checkpointReturnIssue],
      };
    }
    const warnings = [...new Set(bestCandidate.issues.length ? bestCandidate.issues : [lastReason])];
    return {
      ...bestCandidate.draft,
      reply: bestCandidate.draft.reply || "已选择协议有效且覆盖度最高的车辆计划继续执行。",
      planQuality: "best-effort",
      warnings,
    };
  }
  const closedPositionGuidance = requirements.requiresClosedPosition
    ? "任务还要求可靠回到出发位置；如果路线涉及固定检查点，请先把出发位置保存为命名固定检查点并告诉我名称，我不会用猜测距离或定时后退冒充返程"
    : null;
  return {
    reply: `我暂时无法生成可执行的车辆动作，具体原因：${lastReason}。${closedPositionGuidance ? `${closedPositionGuidance}。` : ""}你可以直接补充缺少的距离、角度、检查点名称或路径尺寸，我会接着当前上下文重新规划。`,
    actions: [],
    planQuality: "best-effort",
    warnings: [...new Set([lastReason, ...(closedPositionGuidance ? [closedPositionGuidance] : [])])],
  };
}

export function checkpointReturnLimitation(
  requirements: VehiclePlanRequirements,
  actions: readonly AgentAction[],
) {
  if (!requirements.requiresClosedPosition) return null;
  const checkpointNavigations = actions.filter(
    (action) => action.name === "vehicle.navigate_to_checkpoint",
  );
  if (checkpointNavigations.length !== 1) return null;
  return "任务要求从固定检查点返回出发位置，但当前计划没有可解析的返程检查点；不能用猜测距离或定时后退冒充返程";
}

function isRecoverableVehiclePlanDraftFailure(reason: string) {
  return /DeepSeek (?:未返回车辆规划结果|车辆规划返回了非 JSON 响应|车辆规划结果无效|车辆规划缺少 actions)/.test(reason);
}

function vehiclePlanCoverageScore(
  requirements: VehiclePlanRequirements,
  actions: readonly AgentAction[],
  issues: readonly string[],
) {
  const movementCount = actions.filter(isVehiclePlanMovementAction).length;
  const distanceCount = actions.filter((action) => action.name === "vehicle.move_distance").length;
  const turnCount = actions.filter((action) => action.name === "vehicle.turn_angle").length;
  const ratio = (actual: number, required: number) => (
    required <= 0 ? 1 : Math.min(1, actual / required)
  );
  let score = ratio(movementCount, requirements.minimumMovementActions) * 40
    + ratio(distanceCount, requirements.minimumDistanceActions) * 20
    + ratio(turnCount, requirements.minimumTurnActions) * 20;
  const pose = plannedVehiclePose(actions);
  if (!requirements.requiresClosedPosition
    || (pose.verifiable && Math.hypot(pose.xMm, pose.yMm) <= 0.01)) score += 10;
  const heading = normalizedHeading(pose.headingDeg);
  if (!requirements.requiresOriginalHeading
    || (pose.verifiable && Math.min(heading, 360 - heading) <= 0.001)) score += 10;
  const excessiveActions = Math.max(0, movementCount - requirements.minimumMovementActions);
  score -= excessiveActions * 0.25;
  score -= issues.length * 2;
  return score;
}

function isVehiclePlanMovementAction(action: AgentAction) {
  return action.name === "vehicle.propose_move"
    || action.name === "vehicle.move_distance"
    || action.name === "vehicle.turn_angle"
    || action.name === "vehicle.navigate_to_checkpoint";
}

function findLastMatching<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean,
) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) return values[index];
  }
  return undefined;
}

function findLastMatchingIndex<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean,
) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) return index;
  }
  return -1;
}

export function repairCheckpointPlan(
  actions: AgentAction[],
  requirements: VehiclePlanRequirements,
) {
  const navigationCount = actions.filter(
    (action) => action.name === "vehicle.navigate_to_checkpoint",
  ).length;
  const pureCheckpointNavigation = navigationCount > 0
    && requirements.minimumMovementActions <= navigationCount
    && requirements.minimumDistanceActions === 0
    && requirements.minimumTurnActions === 0;
  const normalizedActions = pureCheckpointNavigation
    ? actions.filter((action) => ![
      "vehicle.move_distance",
      "vehicle.turn_angle",
      "vehicle.propose_move",
    ].includes(action.name))
    : actions;
  const lastNavigationIndex = findLastMatchingIndex(
    normalizedActions,
    (action) => action.name === "vehicle.navigate_to_checkpoint",
  );
  if (lastNavigationIndex < 0) return normalizedActions;
  const inspectionsBeforeNavigation = normalizedActions
    .slice(0, lastNavigationIndex)
    .filter((action) => action.name === "telemetry.inspect_current");
  if (!inspectionsBeforeNavigation.length) return normalizedActions;
  const withoutMovedInspections = normalizedActions.filter((action, index) => (
    index >= lastNavigationIndex || action.name !== "telemetry.inspect_current"
  ));
  const navigationPosition = findLastMatchingIndex(
    withoutMovedInspections,
    (action) => action.name === "vehicle.navigate_to_checkpoint",
  );
  return [
    ...withoutMovedInspections.slice(0, navigationPosition + 1),
    ...inspectionsBeforeNavigation,
    ...withoutMovedInspections.slice(navigationPosition + 1),
  ];
}

async function requestDeepSeekVehiclePlan(
  config: AgentGatewayConfig,
  input: string,
  semantic: SemanticIntentBrief,
  requirements: VehiclePlanRequirements,
  history: ConversationTurn[],
  runtimeContext: string,
  modelPreferences: AgentModelPreferences,
  feedback: string,
  signal?: AbortSignal,
): Promise<DeepSeekPlanDraft> {
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: `你负责把车辆运动目标编排成完整的通用原子动作列表。只输出严格 JSON，不调用工具，不输出 Markdown 或思维过程。
允许的动作只有 vehicle.move_distance、vehicle.turn_angle、vehicle.propose_move、vehicle.navigate_to_checkpoint、telemetry.inspect_current、vehicle.stop，各动作必须严格使用以下参数，不能使用任何别名或额外字段：
- vehicle.move_distance：{"direction":"forward"或"backward","distanceMm":毫米数,"maxSpeedMmps":可选毫米每秒,"timeoutS":可选秒数}
- vehicle.turn_angle：{"direction":"left"或"right","angleDeg":角度数,"maxSpeedMmps":可选毫米每秒,"timeoutS":可选秒数}
- vehicle.propose_move：{"motion":"forward"或"backward"或"left"或"right","speedPercent":百分比,"durationMs":毫秒数}
- vehicle.navigate_to_checkpoint：{"checkpointName":"运行时上下文中存在的检查点名称"}
- telemetry.inspect_current：{"slotIds":可选的数据位数组}，仅用于到达检查点后的现场检测
- vehicle.stop：{}
明确距离必须使用 vehicle.move_distance，单位统一换算为毫米；明确角度必须使用 vehicle.turn_angle，单位为度；只有没有距离或角度的短时方向控制才使用 vehicle.propose_move。
任何由多段直线、转角或重复部分组成的路径，都必须把每一次实际移动和旋转按执行顺序完整写入 actions 数组。不得只给第一步，不得使用 repeat/count/循环占位，不得添加地图、摄像头、页面或其他无关动作。用户要求前往已命名的固定检查点时，应使用 vehicle.navigate_to_checkpoint，名称必须来自运行时上下文，禁止猜坐标；检查点导航会自行规划完整路线，因此除非用户另外明确要求了独立的定距移动或定角转向，否则不得在其前后添加 move_distance、turn_angle 或 propose_move。用户让助手“回来告诉我、回来汇报、回来给结果”只表示完成后回复，不表示车辆返程，绝不能据此追加盲目前进、后退或转向。用户同时要求到点测量或检测时，必须在导航后追加 telemetry.inspect_current，由网关等待真实到达后再稳定读取。
本次 requirements 是上游语义 Agent 对物理任务的约束，必须按其字段规划：若固定检查点任务的 minimumMovementActions=1、minimumDistanceActions=0、minimumTurnActions=0、requiresClosedPosition=false，唯一车辆运动就是 navigate_to_checkpoint；不得因为原句要求“告诉我结果”再添加任何移动。
如果用户要求回到某个位置或方向，请在生成计划时按二维几何核对最终位置和朝向。动作仍必须使用上述通用原语，不得创建任何图形或场景专用动作。
固定检查点导航后要求返回出发位置时，只能导航到运行时目录中可解析且确实代表出发位置的命名检查点；若没有这样的返程检查点，不得猜测后退距离、时长或转角来冒充返程，应返回空 actions 并具体说明需要先保存出发检查点。
车辆初始绝对航向可以是任意 0–360° 数值，非 0° 不得被视为异常、信息不足或计划不完整。move_distance 和 turn_angle 都相对车体当前姿态执行；固定点导航的绝对地图航向由运行时处理，不得由模型自行换算、归零或据此拒绝任务。
当 requirements.requiresOriginalHeading=true 时，返回起点并不代表朝向已经恢复；必须只核对全部 turn_angle 的带符号相对累计角度，并在需要时于末尾补充定角转向，使相对累计转角回到 360° 的整数倍。这里核对的是相对变化，不要求初始绝对航向为 0°。当它为 false 时，不得额外添加用户没有要求的姿态恢复约束。
连续曲线只能用现有直线与转向原语作离散近似；这种情况下 reply 必须明确说明采用了多少段折线近似，不能声称车辆会执行协议无法表达的连续曲线。
输出结构必须为：{"reply":"准备执行的简短说明","actions":[{"name":"vehicle.move_distance","arguments":{"direction":"forward","distanceMm":1000,"maxSpeedMmps":300}}]}。`,
    },
    ...(runtimeContext ? [{ role: "system" as const, content: runtimeContext }] : []),
    {
      role: "system",
      content: `本次公开目标摘要：${JSON.stringify({
        goal: semantic.goal,
        summary: semantic.summary,
        successCriterion: semantic.successCriterion,
        requirements,
      })}`,
    },
    ...history,
    ...(feedback ? [{ role: "system" as const, content: `${feedback}。请从原始用户目标重新生成整份计划，不得续写上一版。` }] : []),
    { role: "user", content: input },
  ];
  const response = await fetchDeepSeekWithRetry(`${config.deepSeekBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${config.deepSeekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      ...deepSeekThinkingParameters(modelPreferences),
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: PLAN_REPAIR_OUTPUT_TOKENS,
    }),
  }, MODEL_REPAIR_TIMEOUT_MS);
  const payload = await response.json().catch(() => {
    throw new Error(`DeepSeek 车辆规划返回了非 JSON 响应（HTTP ${response.status}）`);
  }) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: ModelFinalContent } }>;
  };
  if (!response.ok) throw new Error(payload.error?.message || `DeepSeek 车辆规划失败（${response.status}）`);
  const content = finalMessageText(payload.choices?.[0]?.message?.content);
  if (!content) throw new Error("DeepSeek 未返回车辆规划结果");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("DeepSeek 车辆规划结果不是有效 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DeepSeek 车辆规划结果无效");
  }
  const value = parsed as Record<string, unknown>;
  if (!Array.isArray(value.actions)) throw new Error("DeepSeek 车辆规划缺少 actions");
  const actions = value.actions.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("DeepSeek 车辆动作结构无效");
    }
    const raw = item as Record<string, unknown>;
    let action: AgentAction;
    try {
      action = parseAgentAction(
        raw.name,
        normalizeVehiclePlannerArguments(raw.name, raw.arguments),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`车辆候选计划动作协议无效：${reason}`);
    }
    if (!VEHICLE_DIRECT_ACTIONS.has(action.name)) {
      throw new Error(`车辆专用规划返回了非车辆动作：${action.name}`);
    }
    return action;
  });
  return {
    reply: typeof value.reply === "string" ? value.reply.replace(/\s+/g, " ").trim().slice(0, 300) : "",
    actions,
  };
}

export function normalizeVehiclePlannerArguments(name: unknown, value: unknown) {
  if (typeof value === "string") {
    try {
      return normalizeVehiclePlannerArguments(name, JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (
    name !== "telemetry.inspect_current"
    || !value
    || typeof value !== "object"
    || Array.isArray(value)
  ) return value;
  const argumentsRecord = value as Record<string, unknown>;
  if (!Array.isArray(argumentsRecord.slotIds) || argumentsRecord.slotIds.length > 0) {
    return value;
  }
  const normalized = { ...argumentsRecord };
  delete normalized.slotIds;
  return normalized;
}

export function validateVehiclePlanCompleteness(
  requirements: VehiclePlanRequirements,
  actions: AgentAction[],
) {
  const issues: string[] = [];
  const movementActions = actions.filter((action) => (
    action.name === "vehicle.propose_move"
    || action.name === "vehicle.move_distance"
    || action.name === "vehicle.turn_angle"
    || action.name === "vehicle.navigate_to_checkpoint"
  ));
  if (actions.some((action) => !VEHICLE_DIRECT_ACTIONS.has(action.name))) {
    issues.push("包含非车辆动作");
  }
  if (!movementActions.length && !actions.some((action) => action.name === "vehicle.stop")) {
    issues.push("没有车辆运动动作");
  }
  if (movementActions.length < requirements.minimumMovementActions) {
    issues.push(`AI 判断至少需要 ${requirements.minimumMovementActions} 个运动步骤，但候选计划只有 ${movementActions.length} 个`);
  }
  const distanceActions = actions.filter((action) => action.name === "vehicle.move_distance");
  if (distanceActions.length < requirements.minimumDistanceActions) {
    issues.push(`AI 判断至少需要 ${requirements.minimumDistanceActions} 段定距移动，但候选计划只有 ${distanceActions.length} 段`);
  }
  const turnActions = actions.filter((action) => action.name === "vehicle.turn_angle");
  if (turnActions.length < requirements.minimumTurnActions) {
    issues.push(`AI 判断至少需要 ${requirements.minimumTurnActions} 次定角转向，但候选计划只有 ${turnActions.length} 次`);
  }
  if (requirements.requiresClosedPosition) {
    const pose = plannedVehiclePose(actions);
    if (!pose.verifiable) {
      issues.push("用户要求回到原点，但计划包含无法验证位移的限时动作");
    } else if (Math.hypot(pose.xMm, pose.yMm) > 0.01) {
      issues.push(`计划终点未回到原点（偏移约 ${Math.round(Math.hypot(pose.xMm, pose.yMm))}mm）`);
    }
  }
  if (requirements.requiresOriginalHeading) {
    const pose = plannedVehiclePose(actions);
    const heading = normalizedHeading(pose.headingDeg);
    if (!pose.verifiable) {
      issues.push("用户要求恢复初始朝向，但计划包含无法离线验证最终姿态的导航或限时动作");
    } else if (Math.min(heading, 360 - heading) > 0.001) {
      issues.push(`计划结束朝向未恢复（偏转 ${formatVehiclePlanNumber(heading)}°）；需要补充末尾定角转向，使累计朝向回到 360° 的整数倍`);
    }
  }
  return issues;
}

function plannedVehiclePose(actions: readonly AgentAction[]) {
  let xMm = 0;
  let yMm = 0;
  let headingDeg = 0;
  let verifiable = true;
  for (const action of actions) {
    if (action.name === "vehicle.turn_angle") {
      headingDeg += action.arguments.direction === "left"
        ? action.arguments.angleDeg
        : -action.arguments.angleDeg;
    } else if (action.name === "vehicle.move_distance") {
      const signedDistance = action.arguments.direction === "forward"
        ? action.arguments.distanceMm
        : -action.arguments.distanceMm;
      const radians = headingDeg * Math.PI / 180;
      xMm += signedDistance * Math.cos(radians);
      yMm += signedDistance * Math.sin(radians);
    } else if (action.name === "vehicle.propose_move"
      || action.name === "vehicle.navigate_to_checkpoint") {
      verifiable = false;
    }
  }
  return { xMm, yMm, headingDeg, verifiable };
}

function normalizedHeading(value: number) {
  return ((value % 360) + 360) % 360;
}

function formatVehiclePlanNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

async function reviewDeepSeekVehiclePlan(
  config: AgentGatewayConfig,
  input: string,
  semantic: SemanticIntentBrief,
  requirements: VehiclePlanRequirements,
  draft: DeepSeekPlanDraft,
  modelPreferences: AgentModelPreferences,
  signal?: AbortSignal,
) {
  const response = await fetchDeepSeekWithRetry(`${config.deepSeekBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${config.deepSeekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content: `你只负责校验车辆计划是否完整兑现原始用户目标，不执行动作。
检查所有要求的直线段、转角、重复次数、距离、角度、顺序、最终位置和最终方向；不得把“第一步合法”当成“整条路径完成”。
候选计划只能包含已注册的通用车辆动作；用户要求到点测量或检测时，允许且必须在固定检查点导航之后加入 telemetry.inspect_current。固定检查点导航本身就是完整路线，若用户没有另外明确要求定距或转向，候选计划却在检查点导航前后加入 move_distance、turn_angle 或 propose_move，应判定 complete=false。遗漏任一段、只规划第一步、单位换算错误、终点或朝向不符合要求、加入无关动作时 complete=false。
“回来告诉我、回来汇报、回来给结果”是要求助手完成后回复，并非车辆返程；不得把为此追加的盲目前进、后退或转向判为完整。
只有 requirements.requiresOriginalHeading=true 才检查最终朝向；它为 true 时必须确认累计转角回到 360° 的整数倍，不能把位置闭合误当成朝向闭合。
连续曲线若由折线近似，回复必须向用户公开说明近似方式；否则 complete=false。
不要要求固定场景工具。只输出严格 JSON：{"complete":true,"reason":"简短公开原因"}。`,
        },
        {
          role: "user",
          content: JSON.stringify({
            input,
            semantic: {
              summary: semantic.summary,
              successCriterion: semantic.successCriterion,
            },
            requirements,
            candidateActions: draft.actions,
          }),
        },
      ],
      ...deepSeekThinkingParameters(modelPreferences),
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: VEHICLE_PLAN_REVIEW_OUTPUT_TOKENS,
    }),
  }, MODEL_REQUEST_TIMEOUT_MS);
  const payload = await response.json().catch(() => {
    throw new Error(`DeepSeek 车辆计划校验返回了非 JSON 响应（HTTP ${response.status}）`);
  }) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: ModelFinalContent } }>;
  };
  if (!response.ok) throw new Error(payload.error?.message || `DeepSeek 车辆计划校验失败（${response.status}）`);
  const content = finalMessageText(payload.choices?.[0]?.message?.content);
  if (!content) throw new Error("DeepSeek 未返回车辆计划校验结果");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("DeepSeek 车辆计划校验结果不是有效 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DeepSeek 车辆计划校验结果无效");
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.complete !== "boolean") throw new Error("DeepSeek 车辆计划校验缺少 complete");
  return {
    complete: value.complete,
    reason: typeof value.reason === "string" && value.reason.trim()
      ? value.reason.replace(/\s+/g, " ").trim().slice(0, 300)
      : value.complete ? "车辆计划完整" : "车辆计划未覆盖完整目标",
  };
}

async function requestDeepSeekSemanticBrief(
  config: AgentGatewayConfig,
  input: string,
  history: ConversationTurn[],
  runtimeContext: string,
  modelPreferences: AgentModelPreferences,
  signal?: AbortSignal,
  repairAttempt = false,
): Promise<SemanticIntentBrief> {
  const messages: ModelMessage[] = [
    { role: "system", content: SEMANTIC_PROMPT },
    ...(runtimeContext ? [{ role: "system" as const, content: runtimeContext }] : []),
    ...history,
    { role: "user", content: input },
    ...(repairAttempt ? [{
      role: "system" as const,
      content: "上一版语义摘要为空、被截断或不符合指定 JSON 结构。请重新生成一份完整的严格 JSON；不要输出解释、Markdown 或思维过程。",
    }] : []),
  ];
  const response = await fetchDeepSeekWithRetry(`${config.deepSeekBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${config.deepSeekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      ...deepSeekThinkingParameters(modelPreferences),
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: repairAttempt ? SEMANTIC_REPAIR_OUTPUT_TOKENS : SEMANTIC_OUTPUT_TOKENS,
    }),
  }, repairAttempt ? MODEL_REPAIR_TIMEOUT_MS : MODEL_REQUEST_TIMEOUT_MS);
  const payload = await response.json().catch(() => {
    throw new Error(`DeepSeek 语义理解返回了非 JSON 响应（HTTP ${response.status}）`);
  }) as {
    error?: { message?: string };
    choices?: Array<{
      finish_reason?: "stop" | "length" | "content_filter" | "tool_calls" | "insufficient_system_resource" | string | null;
      message?: { content?: ModelFinalContent };
    }>;
  };
  if (!response.ok) throw new Error(payload.error?.message || `DeepSeek 语义理解失败（${response.status}）`);
  const choice = payload.choices?.[0];
  if (choice?.finish_reason === "content_filter") throw new Error("DeepSeek 语义摘要被内容过滤中止");
  if (choice?.finish_reason === "insufficient_system_resource") {
    if (!repairAttempt) return requestDeepSeekSemanticBrief(config, input, history, runtimeContext, modelPreferences, signal, true);
    throw new Error("DeepSeek 语义理解暂时不可用（推理资源不足）");
  }
  const content = finalMessageText(choice?.message?.content);
  if (choice?.finish_reason === "length" || !content) {
    if (!repairAttempt) return requestDeepSeekSemanticBrief(config, input, history, runtimeContext, modelPreferences, signal, true);
    const suffix = choice?.finish_reason === "length" ? "（输出达到长度限制）" : "";
    throw new Error(`DeepSeek 未返回语义摘要${suffix}`);
  }
  try {
    return parseSemanticIntentBrief(content);
  } catch (error) {
    if (repairAttempt) throw error;
    return requestDeepSeekSemanticBrief(config, input, history, runtimeContext, modelPreferences, signal, true);
  }
}

type ModelFinalContent = string | null | Array<{
  type?: unknown;
  text?: unknown;
}>;

function finalMessageText(content: ModelFinalContent | undefined) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    if (part.type !== "text" && part.type !== "output_text") return [];
    return typeof part.text === "string" ? [part.text] : [];
  }).join("").trim();
}

export function parseSemanticIntentBrief(value: string): SemanticIntentBrief {
  const objectText = normalizeToolArguments(value);
  const parsed = JSON.parse(objectText) as Record<string, unknown>;
  if (!SEMANTIC_GOALS.includes(parsed.goal as SemanticInformationGoal)) throw new Error("语义目标无效");
  if (!SEMANTIC_EVIDENCE.includes(parsed.primaryEvidence as SemanticEvidence)) throw new Error("主证据无效");
  const summary = publicSemanticText(parsed.summary, "语义摘要", 80);
  const evidenceSummary = publicSemanticText(parsed.evidenceSummary, "证据摘要", 120);
  const successCriterion = publicSemanticText(parsed.successCriterion, "成功条件", 120);
  if (!Array.isArray(parsed.subjects)) throw new Error("语义主体必须是数组");
  const subjects = parsed.subjects.slice(0, 6).map((subject) => {
    if (!subject || typeof subject !== "object" || Array.isArray(subject)) throw new Error("语义主体无效");
    const record = subject as Record<string, unknown>;
    const label = publicSemanticText(record.label, "主体名称", 30);
    if (record.slotId === undefined) return { label };
    if (!isTelemetrySlotId(record.slotId)) throw new Error("语义主体数据位无效");
    return { label, slotId: record.slotId };
  });
  const timeRange = normalizeSemanticTimeRange(parsed.timeRange);
  if (!Array.isArray(parsed.supportingEvidence)) throw new Error("辅助证据必须是数组");
  const primaryEvidence = parsed.primaryEvidence as SemanticEvidence;
  const supportingEvidence = [...new Set(parsed.supportingEvidence)].slice(0, 4).map((evidence) => {
    if (!SEMANTIC_EVIDENCE.includes(evidence as SemanticEvidence)) throw new Error("辅助证据无效");
    if (evidence === primaryEvidence) throw new Error("辅助证据不得与主证据重复");
    return evidence as SemanticEvidence;
  });
  return {
    goal: parsed.goal as SemanticInformationGoal,
    summary,
    subjects,
    timeRange,
    primaryEvidence,
    supportingEvidence,
    evidenceSummary,
    successCriterion,
  };
}

export function normalizeSemanticTimeRange(value: unknown): TelemetryHistoryRange | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("语义时间范围无效");

  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return null;

  const aliases: Record<string, TelemetryHistoryRange> = {
    "1h": "1h",
    "1hour": "1h",
    "1小时": "1h",
    "一小时": "1h",
    "近1小时": "1h",
    "最近1小时": "1h",
    "24h": "24h",
    "24hours": "24h",
    "24小时": "24h",
    "二十四小时": "24h",
    "近24小时": "24h",
    "最近24小时": "24h",
    "1d": "24h",
    "1day": "24h",
    "一天": "24h",
    "今天": "24h",
    "最近": "24h",
    "近期": "24h",
    "7d": "7d",
    "7days": "7d",
    "7天": "7d",
    "七天": "7d",
    "一周": "7d",
    "近一周": "7d",
    "最近一周": "7d",
    "30d": "30d",
    "30days": "30d",
    "30天": "30d",
    "三十天": "30d",
    "一个月": "30d",
    "近一个月": "30d",
    "最近一个月": "30d",
  };
  if (aliases[normalized]) return aliases[normalized];

  const unavailable = new Set([
    "none", "null", "na", "n/a", "unknown", "unavailable", "notavailable", "notapplicable",
    "insufficientdata", "nodata", "无", "暂无", "没有", "未知", "未指定", "不适用",
    "无可用时间范围", "暂无可用时间范围", "无可用范围", "暂无可用范围", "数据不足",
    "暂无数据", "无历史数据", "历史为空", "覆盖不足",
  ]);
  if (unavailable.has(normalized)) return null;

  throw new Error("语义时间范围无效");
}

function publicSemanticText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field}无效`);
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isTelemetrySlotId(value: unknown): value is TelemetrySlotId {
  return typeof value === "string" && /^slot-[1-6]$/.test(value);
}

async function requestDeepSeekPlan(
  config: AgentGatewayConfig,
  messages: ModelMessage[],
  planningMode: DeepSeekDecision["planningMode"],
  modelPreferences: AgentModelPreferences,
  signal?: AbortSignal,
  repairAttempt = false,
): Promise<DeepSeekPlanDraft> {
  const response = await fetchDeepSeekWithRetry(`${config.deepSeekBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${config.deepSeekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: AGENT_TOOL_DEFINITIONS.map((tool) => ({
        ...tool,
        function: { ...tool.function, name: toDeepSeekToolName(tool.function.name) },
      })),
      tool_choice: "auto",
      parallel_tool_calls: true,
      ...deepSeekThinkingParameters(modelPreferences),
      temperature: 0,
      max_tokens: repairAttempt ? PLAN_REPAIR_OUTPUT_TOKENS : PLAN_OUTPUT_TOKENS,
    }),
  }, repairAttempt ? MODEL_REPAIR_TIMEOUT_MS : MODEL_REQUEST_TIMEOUT_MS);
  const payload = await response.json().catch(() => {
    throw new Error(`DeepSeek 动作规划返回了非 JSON 响应（HTTP ${response.status}）`);
  }) as {
    error?: { message?: string };
    choices?: Array<{
      finish_reason?: "stop" | "length" | "content_filter" | "tool_calls" | "insufficient_system_resource" | string | null;
      message?: {
        content?: string | null;
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
      };
    }>;
  };
  if (!response.ok) throw new Error(payload.error?.message || `DeepSeek 请求失败（${response.status}）`);
  const choice = payload.choices?.[0];
  if (choice?.finish_reason === "content_filter") throw new Error("DeepSeek 动作规划被内容过滤中止");
  if (choice?.finish_reason === "length") {
    if (repairAttempt) throw new Error("DeepSeek 动作规划未完成（输出达到长度限制）");
    return retryDeepSeekPlan(config, messages, planningMode, modelPreferences, signal, "上一版动作规划被截断");
  }
  if (choice?.finish_reason === "insufficient_system_resource") {
    if (repairAttempt) throw new Error("DeepSeek 动作规划暂时不可用（推理资源不足）");
    return retryDeepSeekPlan(config, messages, planningMode, modelPreferences, signal, "上一版动作规划因推理资源不足而中止");
  }
  const message = choice?.message;
  if (!message) {
    if (repairAttempt) throw new Error("DeepSeek 未返回有效动作规划消息");
    return retryDeepSeekPlan(config, messages, planningMode, modelPreferences, signal, "上一版响应未包含动作规划消息");
  }
  if (choice?.finish_reason === "tool_calls" && !(message.tool_calls?.length)) {
    if (repairAttempt) throw new Error("DeepSeek 声称返回工具调用，但动作列表为空");
    return retryDeepSeekPlan(config, messages, planningMode, modelPreferences, signal, "上一版响应缺少完整的工具调用");
  }
  try {
    return {
      reply: message.content?.trim() ?? "",
      actions: (message.tool_calls ?? []).map((call) => {
        const actionName = fromDeepSeekToolName(call.function?.name);
        return parseAgentAction(
          actionName,
          normalizeVehiclePlannerArguments(
            actionName,
            normalizeToolArguments(call.function?.arguments),
          ),
        );
      }),
    };
  } catch (error) {
    if (repairAttempt) throw error;
    return retryDeepSeekPlan(config, messages, planningMode, modelPreferences, signal, "上一版工具参数不是有效 JSON");
  }
}

function retryDeepSeekPlan(
  config: AgentGatewayConfig,
  messages: ModelMessage[],
  planningMode: DeepSeekDecision["planningMode"],
  modelPreferences: AgentModelPreferences,
  signal: AbortSignal | undefined,
  reason: string,
): Promise<DeepSeekPlanDraft> {
  return requestDeepSeekPlan(
    config,
    [
      ...messages,
      {
        role: "system",
        content: `${reason}。请从原始用户请求重新生成完整动作规划；不得执行或续写上一版部分工具调用。每个 arguments 必须是严格 JSON 对象，不得使用代码块、注释、单引号或尾随逗号。不要改变用户意图。`,
      },
    ],
    planningMode,
    modelPreferences,
    signal,
    true,
  );
}

function normalizeToolArguments(value: string | undefined) {
  const raw = (value ?? "{}").trim();
  if (!raw) return "{}";
  const withoutFence = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  const objectText = start >= 0 && end >= start
    ? withoutFence.slice(start, end + 1)
    : withoutFence;
  return objectText.replace(/,\s*([}\]])/g, "$1");
}

export function choosePlanningMode(
  configured: AgentGatewayConfig["reasoningMode"] | AgentThinkingMode,
  _input: string,
  _actions: AgentAction[] = [],
): DeepSeekDecision["planningMode"] {
  void _input;
  void _actions;
  return configured === "non-thinking" ? "non-thinking" : "thinking";
}

export function toDeepSeekToolName(name: string) {
  return name.replaceAll(".", "__");
}

export function fromDeepSeekToolName(name: string | undefined) {
  return name?.replaceAll("__", ".");
}

function mockDecision(input: string, semantic: SemanticIntentBrief): Omit<DeepSeekDecision, "semantic"> {
  const text = input.trim();
  if (isExplicitVehicleEmergencyStop(text)) return { reply: "正在请求车辆停止。", actions: [{ name: "vehicle.stop", arguments: {} }], planningMode: "thinking" };
  if (/返回|上一页|回去/.test(text)) return { reply: "正在返回上一页。", actions: [{ name: "ui.back", arguments: {} }], planningMode: "thinking" };
  if (["trend", "variation", "comparison", "spatial-pattern", "problem-diagnosis", "recommendations", "connection-health", "vehicle-state"].includes(semantic.goal)) {
    return { reply: `正在${semantic.summary}。`, actions: [], planningMode: "thinking" };
  }
  if (/指标态势/.test(text)) return {
    reply: "正在定位到指标态势。",
    actions: [{ name: "ui.focus_region", arguments: { page: "monitoring", region: "indicator-posture" } }],
    planningMode: "thinking",
  };
  const navigation = deterministicNavigationDecision(text);
  if (navigation) return navigation;
  const vehicle = mockVehicleDecision(text);
  if (vehicle) return vehicle;
  if (/聚焦|定位|突出|查看第/.test(text) && /[1-6一二三四五六]/.test(text)) {
    const match = text.match(/[1-6一二三四五六]/)?.[0] ?? "1";
    const index = "123456一二三四五六".indexOf(match) % 6;
    return { reply: `正在定位第 ${index + 1} 个数据位。`, actions: [{ name: "telemetry.focus", arguments: { slotId: `slot-${index + 1}` as never } }], planningMode: "thinking" };
  }
  if (/温度|湿度|光照|距离|传感器|数据/.test(text)) {
    const match = text.match(/[1-6一二三四五六]/)?.[0];
    const index = match ? "123456一二三四五六".indexOf(match) % 6 : -1;
    return {
      reply: "正在读取当前传感器数据。",
      actions: [{ name: "telemetry.read_current", arguments: index >= 0 ? { slotId: `slot-${index + 1}` as never } : {} }], planningMode: "thinking",
    };
  }
  if (/俯视|顶部|正上方/.test(text)) return { reply: "正在切换到俯视视角。", actions: [{ name: "twin.set_view", arguments: { view: "top" } }], planningMode: "thinking" };
  if (/几何/.test(text)) return { reply: "正在切换到几何模式。", actions: [{ name: "twin.set_display_mode", arguments: { mode: "geometry" } }], planningMode: "thinking" };
  if (/增强/.test(text)) return { reply: "正在切换到增强模式。", actions: [{ name: "twin.set_display_mode", arguments: { mode: "enhanced" } }], planningMode: "thinking" };
  if (/彩色|原始/.test(text)) return { reply: "正在切换到彩色模式。", actions: [{ name: "twin.set_display_mode", arguments: { mode: "color" } }], planningMode: "thinking" };
  return { reply: "模拟模式已连接，但这条命令没有匹配到动作。", actions: [], planningMode: "thinking" };
}

function mockVehicleDecision(text: string): Omit<DeepSeekDecision, "semantic"> | null {
  if (!/前进|向前|往前|后退|向后|往后|左转|右转/.test(text)) return null;
  const forwardOrBackward = /前进|向前|往前|后退|向后|往后/.test(text);
  const backward = /后退|向后|往后/.test(text);
  const distanceMm = explicitDistanceMm(text);
  if (forwardOrBackward && distanceMm !== null) {
    return {
      reply: "正在准备定距移动任务。",
      actions: [{
        name: "vehicle.move_distance",
        arguments: { direction: backward ? "backward" : "forward", distanceMm, maxSpeedMmps: 300 },
      }],
      planningMode: "thinking",
    };
  }
  const angleDeg = explicitAngleDeg(text);
  if ((/左转|右转/.test(text)) && angleDeg !== null) {
    return {
      reply: "正在准备定角转向任务。",
      actions: [{
        name: "vehicle.turn_angle",
        arguments: { direction: /右转/.test(text) ? "right" : "left", angleDeg, maxSpeedMmps: 300 },
      }],
      planningMode: "thinking",
    };
  }
  const motion = backward ? "backward" : /左/.test(text) ? "left" : /右/.test(text) ? "right" : "forward";
  return {
    reply: "正在准备限时车辆任务。",
    actions: [{ name: "vehicle.propose_move", arguments: { motion, speedPercent: 20, durationMs: 1000 } }],
    planningMode: "thinking",
  };
}

function explicitDistanceMm(text: string) {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(毫米|mm|厘米|cm|米(?!秒)|m\b)/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value)) return null;
  if (unit === "米" || unit === "m") return value * 1000;
  if (unit === "厘米" || unit === "cm") return value * 10;
  return value;
}

function explicitAngleDeg(text: string) {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:度|°)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

interface ImmediateNavigationTarget {
  action: AgentAction & { name: "ui.navigate" };
  label: string;
}

const NAVIGATION_ROUTES: Array<ImmediateNavigationTarget & { aliases: readonly string[]; pattern: RegExp }> = [
  {
    aliases: ["数据监测", "数据监控", "监测"],
    pattern: /(?:数据监测|数据监控|监测)/,
    action: { name: "ui.navigate", arguments: { page: "monitoring" } },
    label: "数据监测",
  },
  {
    aliases: ["空间孪生", "数字孪生", "孪生"],
    pattern: /(?:空间孪生|数字孪生|孪生)/,
    action: { name: "ui.navigate", arguments: { page: "digital-twin" } },
    label: "空间孪生",
  },
  {
    aliases: ["告警管理", "告警中心", "告警工单", "工单管理", "告警", "工单"],
    pattern: /(?:告警管理|告警中心|告警工单|工单管理|告警|工单)/,
    action: { name: "ui.navigate", arguments: { page: "alerts" } },
    label: "告警管理",
  },
  {
    aliases: ["接口配置", "连接管理", "连接配置", "集成配置"],
    pattern: /(?:接口配置|连接管理|连接配置|集成配置)/,
    action: { name: "ui.navigate", arguments: { page: "integrations" } },
    label: "接口配置",
  },
  {
    aliases: ["系统设置", "设置"],
    pattern: /(?:系统设置|设置)/,
    action: { name: "ui.navigate", arguments: { page: "settings" } },
    label: "系统设置",
  },
  {
    aliases: ["小车遥控", "车辆遥控", "小车控制", "车辆控制", "小车", "车辆"],
    pattern: /(?:小车遥控|车辆遥控|小车控制|车辆控制|小车|车辆)/,
    action: { name: "ui.navigate", arguments: { page: "vehicle" } },
    label: "小车遥控",
  },
  {
    aliases: ["控制概览", "总览", "概览", "首页"],
    pattern: /(?:控制概览|总览|概览|首页)/,
    action: { name: "ui.navigate", arguments: { page: "overview" } },
    label: "控制概览",
  },
];

/**
 * Resolves only a complete, single-page navigation utterance.
 *
 * Keeping this matcher exact is intentional: compound requests, named regions,
 * telemetry questions, settings mutations, and vehicle commands continue through
 * the full semantic + tool-planning workflow.
 */
export function deterministicImmediateNavigationDecision(input: string): ImmediateNavigationTarget | null {
  const normalized = input
    .trim()
    .replace(/[\s，。！？!?、；;：:]/g, "");
  const prefix = normalized.match(
    /^(?:(?:请|麻烦)(?:你)?(?:帮我|给我|带我)?|(?:帮我|给我|带我))?(?:打开|进入|切换到|前往|去到|去|转到|回到|显示|查看)/,
  )?.[0];
  if (!prefix) return null;

  const target = normalized
    .slice(prefix.length)
    .replace(/(?:一下|吧|好吗|可以吗)$/, "")
    .replace(/(?:页面|界面|页|模块)$/, "");
  const matches = NAVIGATION_ROUTES.filter((route) => route.aliases.includes(target));
  return matches.length === 1
    ? { action: matches[0].action, label: matches[0].label }
    : null;
}

export function isExplicitVehicleEmergencyStop(input: string) {
  const normalized = input
    .trim()
    .replace(/[\s，。！？!?、；;：:]/g, "");
  return /^(?:(?:请|麻烦)(?:你)?(?:帮我|给我)?|(?:帮我|给我))?(?:(?:立即|马上)?(?:停止|停下)(?:小车|车辆)|(?:小车|车辆)(?:立即|马上)?(?:停止|停下|急停|停车)|(?:立即|马上)?(?:急停|停车)|停止)(?:一下|吧)?$/.test(normalized);
}

function deterministicNavigationDecision(text: string): Omit<DeepSeekDecision, "semantic"> | null {
  if (!/(?:打开|进入|切换到|前往|去到|转到|查看|显示|回到)/.test(text)) return null;
  const match = NAVIGATION_ROUTES.find(({ pattern }) => pattern.test(text));
  return match
    ? { reply: `正在打开${match.label}。`, actions: [match.action], planningMode: "thinking" }
    : null;
}
