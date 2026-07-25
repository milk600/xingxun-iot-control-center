import { randomBytes, randomInt } from "node:crypto";
import { pathToFileURL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import {
  actionPublicLabel,
  compileAgentPlanWithDiagnostics,
  parseAgentAction,
} from "../app/lib/ai/action-registry";
import { pageActionTimeoutMs } from "../app/lib/ai/action-events";
import {
  AGENT_PROTOCOL_VERSION,
  createAgentEnvelope,
  normalizeAgentReasoningEffort,
  normalizeAgentThinkingMode,
  type AgentAction,
  type AgentEnvelope,
  type AgentHistoryItem,
  type AgentNavigationContext,
  type AgentPlan,
  type AgentPlanningTrace,
  type AgentReasoningEffort,
  type AgentThinkingMode,
  type ClientRole,
  type PendingVehicleCommand,
  type UiPage,
} from "../app/lib/ai/contracts";
import {
  TELEMETRY_SLOT_IDS,
  type TelemetrySlotId,
  type TelemetrySlots,
  type VehicleMotion,
} from "../app/lib/iot/contracts";
import {
  parseVehicleFireReport,
  VEHICLE_FIRE_REPORT_TYPE,
} from "../app/lib/iot/fire-detection";
import type {
  TelemetryAvailabilityDiagnostic,
  TelemetryCollectorSettings,
  TelemetryHistoryRange,
} from "../app/lib/iot/telemetry-history-contracts";
import { getIoTProvider } from "../app/lib/iot/provider-factory.server";
import { readAgentGatewayConfig } from "./config";
import {
  choosePlanningMode,
  decideWithDeepSeek,
  deterministicImmediateNavigationDecision,
  isExplicitVehicleEmergencyStop,
  type ConversationTurn,
  type DeepSeekDecision,
} from "./deepseek";
import { analyzeTelemetryWithDeepSeek } from "./deepseek-analysis";
import { FunAsrSession } from "./fun-asr";
import {
  deterministicAnalysisForRequest,
  eventsResultForRequest,
  historyResultForRequest,
} from "./telemetry-contract-adapter";
import {
  parseTelemetryAnalysisRequest,
  parseTelemetryEventsRequest,
  parseTelemetryHistoryRequest,
} from "./telemetry-protocol";
import {
  diagnoseTelemetryAvailability,
  spatialAvailabilityDiagnostic,
  type TelemetryAvailabilityRuntimeContext,
} from "./telemetry-diagnostics";
import {
  AlertStoreConflictError,
  TelemetryStore,
  createTelemetryCollector,
  resolveTelemetryPollIntervalMs,
} from "./telemetry-store";
import { PlanningCoordinator } from "./planning-coordinator";
import { isClientExecutedAction, projectPlanForActionTarget } from "./plan-projection";
import {
  confirmedVehicleMoveAuthorization,
  vehicleMoveAuthorization,
} from "./vehicle-permissions";
import {
  parseAlertBeginRequest,
  parseAlertClearRequest,
  parseAlertCompleteRequest,
  parseAlertDetailRequest,
  parseAlertListRequest,
  parseAlertRulesRequest,
  parseAlertRulesSaveRequest,
} from "./alerts-protocol";
import {
  canEditCollectorSettings,
  parseCollectorSettingsRequest,
  parseCollectorSettingsUpdateRequest,
} from "./collector-settings-protocol";
import {
  JetsonControlClient,
  jetsonNavigationConflictRevision,
  type JetsonControlStatus,
} from "./jetson-control";

interface ConnectedClient {
  id: string;
  name: string;
  role: ClientRole;
  socket: WebSocket;
  authenticated: boolean;
  realVehicleEnabled: boolean;
  alertWorkOrderAutomationEnabled: boolean;
  thinkingMode: AgentThinkingMode;
  reasoningEffort: AgentReasoningEffort;
  currentPage: UiPage;
  remoteAddress: string;
  asr: FunAsrSession | null;
  spatialSampleCounts: Partial<Record<TelemetrySlotId, number>> | null;
  navigationContext: AgentNavigationContext | null;
}

interface ClientMessagePayload {
  role?: ClientRole;
  token?: string;
  name?: string;
  code?: string;
  text?: string;
  confirmationId?: string;
  realVehicleEnabled?: boolean;
  alertWorkOrderAutomationEnabled?: boolean;
  thinkingMode?: AgentThinkingMode;
  reasoningEffort?: AgentReasoningEffort;
  page?: UiPage;
  action?: { name?: string; arguments?: unknown };
  requestId?: string | null;
  planId?: string | null;
  stepIndex?: number;
  actionExecutionId?: string;
  actionName?: string;
  status?: "success" | "error";
  executionState?: "queued" | "started" | "cancelled";
  message?: string;
  completedAt?: string;
  from?: string;
  to?: string;
  slotIds?: unknown;
  resolution?: unknown;
  spatialSampleCounts?: unknown;
  navigationContext?: unknown;
  alertId?: unknown;
  expectedVersion?: unknown;
  actor?: unknown;
  note?: unknown;
  statuses?: unknown;
  severities?: unknown;
  limit?: unknown;
  rules?: unknown;
  pollIntervalMs?: unknown;
  automatic?: boolean;
  detected?: unknown;
  observedAt?: unknown;
  source?: unknown;
}

interface ConversationState {
  history: ConversationTurn[];
  toolInteractions: number;
  updatedAt: number;
}

type VehiclePendingState = PendingVehicleCommand & { timer: NodeJS.Timeout };
interface AgentExecutionCorrelation {
  agentRequestId?: string;
  planId?: string;
  stepIndex?: number;
}

interface PendingPageActionExecution {
  sourceClientId: string;
  targetClientId: string;
  requestId: string | null;
  planId: string | null;
  stepIndex: number;
  actionName: AgentAction["name"];
  actionLabel: string;
  actionTimeoutMs: number;
  executionState: "dispatching" | "queued" | "started";
  pageAfterSuccess: UiPage | null;
  timer: NodeJS.Timeout;
  resolve: (message: string) => void;
  reject: (error: Error) => void;
}

class PagePresentationCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PagePresentationCancelledError";
  }
}

const MAX_CONVERSATION_TURNS = 128;
const MAX_CONVERSATIONS = 32;
const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
const TOOL_INTERACTION_COUNTER_RESET = 128;
const MAX_USER_INPUT_LENGTH = 4_000;
const VEHICLE_CONFIRMATION_WINDOW_MS = 60_000;
const AGENT_REQUEST_DEADLINE_MS = 120_000;
const PAGE_ACTION_ACCEPT_TIMEOUT_MS = 15_000;
const PAGE_ACTION_GUIDE_WAIT_TIMEOUT_MS = 30 * 60_000;
const INSPECTION_STABILIZE_MS = 2_000;
const INSPECTION_FRESH_WAIT_MS = 12_000;
const INSPECTION_POLL_MS = 1_000;
const NAVIGATION_POSE_FRESH_MS = 20_000;

type NormalizedVehicleTask =
  | Pick<Extract<PendingVehicleCommand, { kind: "timed" }>, "kind" | "motion" | "speedPercent" | "durationMs">
  | Pick<Extract<PendingVehicleCommand, { kind: "distance" }>, "kind" | "direction" | "distanceMm" | "maxSpeedMmps" | "timeoutS">
  | Pick<Extract<PendingVehicleCommand, { kind: "turn" }>, "kind" | "direction" | "angleDeg" | "maxSpeedMmps" | "timeoutS">;

interface TelemetrySnapshotPayload {
  slots?: Record<string, {
    label?: string;
    value?: number | null;
    unit?: string;
    state?: string;
    observedAt?: string | null;
  }>;
}

export interface AgentGatewayHandle {
  port: number;
  pairingCode: string;
  close: () => Promise<void>;
}

export function startAgentGateway(config = readAgentGatewayConfig()): AgentGatewayHandle {
  const server = new WebSocketServer({ host: "0.0.0.0", port: config.port, maxPayload: 256 * 1024 });
  const telemetryStore = new TelemetryStore();
  let collectorSettings: TelemetryCollectorSettings = telemetryStore.readCollectorSettings(resolveTelemetryPollIntervalMs());
  const telemetryCollector = createTelemetryCollector({
    store: telemetryStore,
    intervalMs: collectorSettings.pollIntervalMs,
    onError: (error) => console.warn(`遥测后台采集失败：${errorMessage(error)}`),
  });
  const pairingCode = String(randomInt(100_000, 999_999));
  const validTokens = new Map<string, ClientRole>();
  const clients = new Map<WebSocket, ConnectedClient>();
  const conversations = new Map<string, ConversationState>();
  const history: AgentHistoryItem[] = [];
  let pendingVehicle: VehiclePendingState | null = null;
  let movementControllerId: string | null = null;
  let shuttingDown = false;
  let telemetryCache: { expiresAt: number; snapshot: TelemetrySnapshotPayload } | null = null;
  let telemetryReadInFlight: Promise<TelemetrySnapshotPayload> | null = null;
  const telemetryAnalysisCache = new Map<string, ReturnType<typeof deterministicAnalysisForRequest>>();
  const telemetryAnalysisRequestedAt = new Map<string, number>();
  const completedNavigationPlans = new Map<string, { planId: string; completedAt: number; checkpointName: string }>();
  const planningCoordinator = new PlanningCoordinator();
  const planningAbortControllers = new Map<string, AbortController>();
  const pendingPageActions = new Map<string, PendingPageActionExecution>();
  const fullAccess = config.fullAccess === true;

  const conversationFor = (clientId: string) => {
    const now = Date.now();
    for (const [id, conversation] of conversations) {
      if (now - conversation.updatedAt > CONVERSATION_TTL_MS) conversations.delete(id);
    }
    const existing = conversations.get(clientId);
    if (existing) {
      existing.updatedAt = now;
      return existing;
    }
    if (conversations.size >= MAX_CONVERSATIONS) {
      const oldest = [...conversations.entries()]
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
      if (oldest) conversations.delete(oldest[0]);
    }
    const created: ConversationState = { history: [], toolInteractions: 0, updatedAt: now };
    conversations.set(clientId, created);
    return created;
  };

  void telemetryCollector.start().catch((error) => {
    console.warn(`遥测历史记录器启动失败：${errorMessage(error)}`);
  });

  const appendHistory = (kind: AgentHistoryItem["kind"], text: string) => {
    history.unshift({ id: crypto.randomUUID(), kind, text, timestamp: new Date().toISOString() });
    history.splice(120);
    broadcast("agent.history", { items: history });
  };

  const send = <T>(client: ConnectedClient, type: string, payload: T) => {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    client.socket.send(JSON.stringify(createAgentEnvelope(type, "gateway", client.id, payload)));
  };

  const broadcast = <T>(type: string, payload: T, filter?: (client: ConnectedClient) => boolean) => {
    for (const client of clients.values()) {
      if (client.authenticated && (!filter || filter(client))) send(client, type, payload);
    }
  };

  const voiceState = (
    client: ConnectedClient,
    phase: string,
    extra: Record<string, unknown> = {},
  ) => send(client, "voice.state", { phase, updatedAt: new Date().toISOString(), ...extra });

  const chooseActionTargets = (source: ConnectedClient) => {
    if (source.role === "remote") {
      const displays = [...clients.values()].filter((item) => item.authenticated && item.role === "display");
      if (displays.length) {
        return [displays.sort((left, right) => (
          Date.parse(right.navigationContext?.updatedAt ?? "") - Date.parse(left.navigationContext?.updatedAt ?? "")
        ))[0]];
      }
    }
    return [source];
  };

  const rejectPendingPageActions = (
    predicate: (pending: PendingPageActionExecution) => boolean,
    reason: string,
  ) => {
    for (const [executionId, pending] of pendingPageActions) {
      if (!predicate(pending)) continue;
      clearTimeout(pending.timer);
      pendingPageActions.delete(executionId);
      pending.reject(new Error(reason));
    }
  };

  const dispatchAction = async (
    source: ConnectedClient,
    action: AgentAction,
    planId: string | null = null,
    requestId: string | null = null,
    explicitTargets?: ConnectedClient[],
    stepIndex = 0,
  ): Promise<string> => {
    const targets = explicitTargets ?? chooseActionTargets(source);
    if (!targets.length) throw new Error("没有在线的页面执行端，动作未执行");
    const results = await Promise.all(targets.map((target) => new Promise<string>((resolve, reject) => {
      if (target.socket.readyState !== WebSocket.OPEN || !target.authenticated) {
        reject(new Error(`目标页面“${target.name}”当前离线，动作未执行`));
        return;
      }
      const actionExecutionId = crypto.randomUUID();
      const timer = setTimeout(() => {
        pendingPageActions.delete(actionExecutionId);
        reject(new Error(`页面执行端未就绪，未接收“${actionPublicLabel(action)}”，后续动作已停止`));
      }, PAGE_ACTION_ACCEPT_TIMEOUT_MS);
      timer.unref();
      pendingPageActions.set(actionExecutionId, {
        sourceClientId: source.id,
        targetClientId: target.id,
        requestId,
        planId,
        stepIndex,
        actionName: action.name,
        actionLabel: actionPublicLabel(action),
        actionTimeoutMs: pageActionTimeoutMs(action),
        executionState: "dispatching",
        pageAfterSuccess: action.name === "ui.navigate" ? action.arguments.page : null,
        timer,
        resolve,
        reject,
      });
      send(target, "action.dispatch", {
        action,
        requestedBy: source.id,
        requestId,
        planId,
        stepIndex,
        actionExecutionId,
      });
    })));
    const message = results.filter(Boolean).join("；") || `${actionPublicLabel(action)}已真实完成。`;
    appendHistory("action", message);
    return message;
  };

  const publishPlan = (
    source: ConnectedClient,
    plan: AgentPlan,
    explicitTargets: readonly ConnectedClient[] = chooseActionTargets(source),
  ) => {
    send(source, "agent.plan", { plan });
    const targetPlan = projectPlanForActionTarget(plan);
    if (targetPlan) {
      for (const recipient of explicitTargets) {
        if (recipient !== source) send(recipient, "agent.plan", { plan: targetPlan });
      }
    }
    appendHistory("action", `执行计划：${plan.steps.map((step) => step.label).join(" → ")}`);
  };

  const publishPlanningTrace = (
    source: ConnectedClient,
    trace: AgentPlanningTrace,
    explicitTargets: readonly ConnectedClient[] = chooseActionTargets(source),
  ) => {
    const recipients = new Set([source, ...explicitTargets]);
    for (const recipient of recipients) send(recipient, "agent.trace", { trace });
  };

  const clearPendingVehicle = (reason?: string) => {
    if (!pendingVehicle) return;
    clearTimeout(pendingVehicle.timer);
    pendingVehicle = null;
    broadcast("vehicle.pending", { command: null, reason: reason ?? null });
  };

  const jetsonControl = new JetsonControlClient(config.jetsonWsUrl, (status) => {
    broadcast("vehicle.progress", { status });
  });

  const stopVehicle = async (
    reason: string,
    source?: ConnectedClient,
    correlation: AgentExecutionCorrelation = {},
  ) => {
    clearPendingVehicle(reason);
    movementControllerId = null;
    try {
      const status = await jetsonControl.stop();
      appendHistory("action", `车辆停止：${reason}`);
      const message = "Jetson 已确认车辆停车。";
      broadcast("vehicle.result", {
        ok: true,
        action: "stop",
        requestId: status.request_id,
        deviceState: status.state,
        ...(source ? { requestedBy: source.id } : {}),
        ...correlation,
        message,
      });
      return message;
    } catch (error) {
      const message = `未收到 Jetson 停车确认：${errorMessage(error)}`;
      appendHistory("error", message);
      broadcast("vehicle.result", {
        ok: false,
        action: "stop",
        ...(source ? { requestedBy: source.id } : {}),
        ...correlation,
        message,
      });
      throw new Error(message, { cause: error });
    }
  };

  const executeVehicleMove = async (
    client: ConnectedClient,
    command: Extract<NormalizedVehicleTask, { kind: "timed" }>,
    correlation: AgentExecutionCorrelation = {},
  ) => {
    movementControllerId = client.id;
    try {
      const result = await jetsonControl.executeTimedMove(
        wheelSpeeds(command.motion, command.speedPercent),
        command.durationMs,
      );
      const message = `限时${motionLabel(command.motion)}命令已真实发送（${command.speedPercent}% · ${command.durationMs}ms），Jetson 已确认停车。`;
      appendHistory("action", message);
      broadcast("vehicle.result", {
        ok: true,
        action: "move",
        requestId: result.requestId,
        deviceState: result.stopped.state,
        requestedBy: client.id,
        ...correlation,
        message,
      });
      return message;
    } catch (error) {
      const message = `车辆任务失败：${errorMessage(error)}`;
      appendHistory("error", message);
      broadcast("vehicle.result", {
        ok: false,
        action: "move",
        requestedBy: client.id,
        ...correlation,
        message,
      });
      throw new Error(message, { cause: error });
    } finally {
      if (movementControllerId === client.id) movementControllerId = null;
    }
  };

  const executeClosedLoopVehicle = async (
    client: ConnectedClient,
    command: Extract<NormalizedVehicleTask, { kind: "distance" | "turn" }>,
    correlation: AgentExecutionCorrelation = {},
  ) => {
    movementControllerId = client.id;
    const requestId = `agent-${command.kind}-${crypto.randomUUID()}`;
    try {
      const status = await jetsonControl.executeClosedLoop(command.kind === "distance" ? {
        cmd: "move_distance",
        request_id: requestId,
        direction: command.direction,
        distance_mm: command.distanceMm,
        max_speed_mmps: command.maxSpeedMmps,
        timeout_s: command.timeoutS,
      } : {
        cmd: "turn_angle",
        request_id: requestId,
        direction: command.direction,
        angle_deg: command.angleDeg,
        max_speed_mmps: command.maxSpeedMmps,
        timeout_s: command.timeoutS,
      });
      const message = completedVehicleMessage(command, status);
      appendHistory("action", message);
      broadcast("vehicle.result", {
        ok: true,
        action: command.kind,
        requestId,
        deviceState: status.state,
        requestedBy: client.id,
        ...correlation,
        message,
      });
      return message;
    } catch (error) {
      const message = `${vehicleTaskLabel(command)}未完成：${errorMessage(error)}`;
      appendHistory("error", message);
      broadcast("vehicle.result", {
        ok: false,
        action: command.kind,
        requestId,
        requestedBy: client.id,
        ...correlation,
        message,
      });
      throw new Error(message, { cause: error });
    } finally {
      if (movementControllerId === client.id) movementControllerId = null;
    }
  };

  const executeVehicleTask = (
    client: ConnectedClient,
    command: NormalizedVehicleTask,
    correlation: AgentExecutionCorrelation = {},
  ) => (
    command.kind === "timed"
      ? executeVehicleMove(client, command, correlation)
      : executeClosedLoopVehicle(client, command, correlation)
  );

  const executePendingVehicle = async (
    client: ConnectedClient,
    confirmationId: string | undefined,
    correlation: AgentExecutionCorrelation = {},
  ) => {
    const command = pendingVehicle;
    if (!command || command.confirmationId !== confirmationId || Date.parse(command.expiresAt) <= Date.now()) {
      clearPendingVehicle("确认已失效");
      throw new Error("没有可执行的车辆任务，或确认已经过期");
    }
    if (confirmedVehicleMoveAuthorization(config.vehicleEnabled) === "disabled") {
      clearPendingVehicle("网关真实控制未启用");
      throw new Error("智能网关尚未允许真实小车控制；未向 Jetson 发送命令");
    }
    clearPendingVehicle("已确认");
    return executeVehicleTask(client, command, correlation);
  };

  const normalizedVehicleTask = (
    action: Extract<AgentAction, { name: "vehicle.propose_move" | "vehicle.move_distance" | "vehicle.turn_angle" }>,
  ): NormalizedVehicleTask => {
    if (action.name === "vehicle.propose_move") {
      return {
        kind: "timed",
        motion: action.arguments.motion,
        speedPercent: Math.min(100, Math.max(1, action.arguments.speedPercent ?? 20)),
        durationMs: Math.max(1, Math.round(action.arguments.durationMs ?? 1000)),
      };
    }
    if (action.name === "vehicle.move_distance") {
      const maxSpeedMmps = action.arguments.maxSpeedMmps ?? 300;
      return {
        kind: "distance",
        direction: action.arguments.direction,
        distanceMm: action.arguments.distanceMm,
        maxSpeedMmps,
        timeoutS: action.arguments.timeoutS ?? defaultDistanceTimeout(action.arguments.distanceMm, maxSpeedMmps),
      };
    }
    const maxSpeedMmps = action.arguments.maxSpeedMmps ?? 300;
    return {
      kind: "turn",
      direction: action.arguments.direction,
      angleDeg: action.arguments.angleDeg,
      maxSpeedMmps,
      timeoutS: action.arguments.timeoutS ?? defaultTurnTimeout(action.arguments.angleDeg),
    };
  };

  const proposeVehicle = (source: ConnectedClient, command: NormalizedVehicleTask) => {
    clearPendingVehicle("被新任务替换");
    const confirmationId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + VEHICLE_CONFIRMATION_WINDOW_MS).toISOString();
    const timer = setTimeout(
      () => clearPendingVehicle("确认超时"),
      VEHICLE_CONFIRMATION_WINDOW_MS,
    );
    timer.unref();
    pendingVehicle = {
      confirmationId,
      ...command,
      requestedBy: source.id,
      expiresAt,
      timer,
    };
    broadcast("vehicle.pending", { command: publicPendingVehicle(pendingVehicle) });
    appendHistory("action", `等待确认：${vehicleTaskLabel(command)}`);
    return confirmationId;
  };

  const fetchTelemetrySnapshot = async ({ force = false }: { force?: boolean } = {}) => {
    if (!force && telemetryCache && telemetryCache.expiresAt > Date.now()) return telemetryCache.snapshot;
    if (telemetryReadInFlight) return telemetryReadInFlight;
    const request = (async () => {
      const provider = getIoTProvider();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("传感器读取超时")), 6000);
      let slots: TelemetrySlots;
      try {
        slots = await provider.readTelemetrySlots({
          signal: controller.signal,
          traceId: crypto.randomUUID(),
        });
      } finally {
        clearTimeout(timeout);
      }
      const snapshot: TelemetrySnapshotPayload = { slots };
      telemetryCache = { expiresAt: Date.now() + 5000, snapshot };
      return snapshot;
    })();
    telemetryReadInFlight = request;
    try {
      return await request;
    } finally {
      if (telemetryReadInFlight === request) telemetryReadInFlight = null;
    }
  };

  const telemetryRuntimeContext = async () => {
    try {
      const snapshot = await fetchTelemetrySnapshot();
      const directory = Object.entries(snapshot.slots ?? {})
        .map(([slotId, slot]) => `${slotId}=${slot.label ?? "未命名数据"}${slot.unit ? `（单位 ${slot.unit}）` : ""}`)
        .join("；");
      return `运行时数据位目录：${directory || "暂无数据位"}。当前支持实时趋势、分析洞察和最多三十天的本机历史记录。用户说“曲线”或“趋势”但没有指定历史时间范围时，应使用 telemetry.focus 打开对应数据位的实时趋势；用户明确要求历史分析时应切换 monitoring 的 analysis 标签，不要反问槽位。`;
    } catch {
      return "运行时数据位目录暂时不可用。不得猜测槽位；如需读取数值，应调用 telemetry.read_current 让网关返回真实接口状态。";
    }
  };

  const alertRuntimeContext = () => {
    try {
      const items = telemetryStore.queryAlertWorkOrders({ statuses: ["pending", "processing"], limit: 20 }).items;
      const compact = items.map((item) => ({
        id: item.id,
        version: item.version,
        status: item.status,
        severity: item.severity,
        slotId: item.slotId,
        title: item.title,
        sourceState: item.sourceState,
      }));
      return `告警工单权限：${compact.length ? "以下工单可供规划" : "当前没有待处理或处理中的工单"}。真实工单列表：${JSON.stringify(compact)}。`;
    } catch {
      return "告警工单列表暂时不可用，不得猜测工单编号、版本或处理结果。";
    }
  };

  const navigationRuntimeContext = (target: ConnectedClient) => {
    const context = target.navigationContext;
    if (!context) {
      return "固定检查点上下文尚未从目标客户端同步。不得猜测检查点名称或坐标；如用户要求前往固定检查点，应明确说明需要先在导航地图中创建检查点并保持目标客户端在线。";
    }
    const checkpoints = context.checkpoints.map(({ name }) => name);
    return `目标客户端固定检查点目录：${JSON.stringify(checkpoints)}。标定状态：${context.calibrationConfirmed ? "已标定" : "未标定"}；当前位置：${context.pose ? JSON.stringify(context.pose) : "暂无"}；Jetson 地图修订：${context.mapRevision ?? "暂无"}。当前位置中的 headingDeg 是地图绝对航向，任意 0–360° 航向都完全有效；非 0° 不是错误、缺失条件或额外约束，普通定距/定角动作始终按车体当前姿态执行。模型选择检查点时只能使用目录中的名称，不得输出或猜测坐标。用户要求到点测量、检测或分析时，必须在 vehicle.navigate_to_checkpoint 后追加 telemetry.inspect_current；网关会等待真实 completed 后稳定 2 秒再读取。`;
  };

  const telemetrySummary = async (slotId?: string) => {
    const snapshot = await fetchTelemetrySnapshot();
    const slots = Object.entries(snapshot.slots ?? {})
      .filter(([id]) => !slotId || slotId === id)
      .map(([, slot]) => slot);
    if (!slots.length) return "没有找到对应数据位。";
    const stateLabel: Record<string, string> = {
      loading: "加载中",
      live: "实时",
      stale: "数据陈旧",
      offline: "离线",
      empty: "暂无数据",
      error: "读取异常",
    };
    return slots.map((slot) => `${slot.label ?? "数据位"}：${slot.value ?? "暂无"}${slot.value === null ? "" : slot.unit ?? ""}（${stateLabel[slot.state ?? ""] ?? "状态未知"}）`).join("；");
  };

  const inspectCurrentTelemetry = async (
    source: ConnectedClient,
    planId: string | null,
    slotIds?: TelemetrySlotId[],
  ) => {
    const completedNavigation = completedNavigationPlans.get(source.id);
    if (!planId || !completedNavigation || completedNavigation.planId !== planId
      || Date.now() - completedNavigation.completedAt > 5 * 60_000) {
      throw new Error("现场检测必须紧接在同一执行计划中已真实完成的固定检查点导航之后");
    }
    const selected = slotIds?.length ? new Set(slotIds) : new Set<TelemetrySlotId>(TELEMETRY_SLOT_IDS);
    await delay(INSPECTION_STABILIZE_MS);
    const freshDeadline = Date.now() + INSPECTION_FRESH_WAIT_MS - INSPECTION_STABILIZE_MS;
    let snapshot: TelemetrySnapshotPayload;
    let pendingFreshSlotIds: TelemetrySlotId[] = [];
    do {
      telemetryCache = null;
      snapshot = await fetchTelemetrySnapshot({ force: true });
      pendingFreshSlotIds = [...selected].filter((slotId) => {
        const slot = snapshot.slots?.[slotId];
        const observedAtMs = Date.parse(slot?.observedAt ?? "");
        return slot?.state !== "live"
          || typeof slot.value !== "number"
          || !Number.isFinite(slot.value)
          || !Number.isFinite(observedAtMs)
          || observedAtMs <= completedNavigation.completedAt;
      });
      if (!pendingFreshSlotIds.length || Date.now() >= freshDeadline) break;
      await delay(Math.min(INSPECTION_POLL_MS, Math.max(0, freshDeadline - Date.now())));
    } while (Date.now() < freshDeadline);
    const rules = new Map(telemetryStore.listAlertRules().map((rule) => [rule.slotId, rule]));
    const readings: string[] = [];
    const violations: string[] = [];
    const unavailable: string[] = [];
    const notRefreshed: string[] = [];
    let enabledRuleCount = 0;
    const stateLabel: Record<string, string> = {
      loading: "加载中",
      live: "实时",
      stale: "数据陈旧",
      offline: "离线",
      empty: "暂无数据",
      error: "读取异常",
    };
    for (const slotId of selected) {
      const slot = snapshot.slots?.[slotId];
      if (!slot) {
        unavailable.push(slotId);
        readings.push(`${slotId}：没有返回数据位`);
        continue;
      }
      const label = slot.label ?? slotId;
      const observedAt = slot.observedAt
        ? new Date(slot.observedAt).toLocaleString("zh-CN", { hour12: false })
        : "时间未知";
      if (typeof slot.value !== "number" || !Number.isFinite(slot.value)) {
        unavailable.push(`${label}（${stateLabel[slot.state ?? ""] ?? "状态未知"}）`);
        readings.push(`${label}：暂无有效读数（${stateLabel[slot.state ?? ""] ?? "状态未知"}，数据时间 ${observedAt}）`);
        continue;
      }
      const observedAtMs = Date.parse(slot.observedAt ?? "");
      const freshAfterArrival = slot.state === "live"
        && Number.isFinite(observedAtMs)
        && observedAtMs > completedNavigation.completedAt;
      readings.push(`${label}：${formatVehicleNumber(slot.value)}${slot.unit ?? ""}（${stateLabel[slot.state ?? ""] ?? "状态未知"}，数据时间 ${observedAt}${freshAfterArrival ? "，到点后新样本" : "，最近有效样本"}）`);
      if (!freshAfterArrival) {
        notRefreshed.push(label);
        continue;
      }
      const rule = rules.get(slotId);
      if (!rule?.enabled) continue;
      enabledRuleCount += 1;
      if (rule.lowerLimit !== null && slot.value < rule.lowerLimit) {
        violations.push(`${label}低于下限 ${formatVehicleNumber(rule.lowerLimit)}${slot.unit ?? ""}`);
      }
      if (rule.upperLimit !== null && slot.value > rule.upperLimit) {
        violations.push(`${label}高于上限 ${formatVehicleNumber(rule.upperLimit)}${slot.unit ?? ""}`);
      }
    }
    const incomplete = [...unavailable, ...notRefreshed];
    const conclusion = violations.length
      ? `检测结论：到点后新样本中发现 ${violations.length} 项越过当前告警阈值——${violations.join("；")}。${incomplete.length ? `另有 ${incomplete.join("、")} 尚不能形成到点后判定。` : ""}`
      : incomplete.length
        ? `检测结论：${incomplete.join("、")} 在等待窗口内没有产生可用于到点判断的新实时样本；以上仅展示最新有效读数，本次不判定为正常或异常。`
        : enabledRuleCount > 0
          ? "检测结论：本次到点后新样本均处于当前启用的告警阈值范围内。"
          : "检测结论：已取得到点后的新实时样本；当前没有启用可用于判定的告警阈值，因此只报告数据，不虚构正常或异常结论。";
    const waitedSeconds = Math.ceil((Date.now() - completedNavigation.completedAt) / 1000);
    return `到达“${completedNavigation.checkpointName}”后等待并重新读取真实数据（约 ${waitedSeconds} 秒）：${readings.join("；")}。${conclusion}`;
  };

  const executeCheckpointNavigation = async (
    source: ConnectedClient,
    target: ConnectedClient,
    checkpointName: string,
    planId: string | null,
    correlation: AgentExecutionCorrelation = {},
  ) => {
    if (!config.vehicleEnabled) throw new Error("智能网关尚未启用真实小车控制，未发送导航命令");
    const context = target.navigationContext;
    if (!context) throw new Error("目标客户端尚未同步固定检查点，请先打开小车导航页面");
    const normalizedName = checkpointName.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("zh-CN");
    const checkpoint = context.checkpoints.find((item) => item.name.toLocaleLowerCase("zh-CN") === normalizedName);
    if (!checkpoint) {
      const names = context.checkpoints.map((item) => `“${item.name}”`).join("、");
      throw new Error(names
        ? `没有找到固定检查点“${checkpointName}”。当前可用检查点：${names}`
        : `没有找到固定检查点“${checkpointName}”。请先在导航地图中创建并命名检查点`);
    }
    if (context.controlLink && context.controlLink !== "connected") {
      throw new Error(`Jetson 当前离线或正在重连（控制链路：${context.controlLink}），未发送导航命令`);
    }
    if (context.vehicleConnection && context.vehicleConnection !== "online") {
      throw new Error(`Jetson 当前没有可用的实时车辆回传（状态：${context.vehicleConnection}），未发送导航命令`);
    }
    if (context.imuState && context.imuState !== "live") {
      throw new Error(`Jetson 当前 IMU 尚未就绪（状态：${context.imuState}），未发送导航命令`);
    }
    if (!context.calibrationConfirmed || !context.pose) {
      throw new Error(`固定检查点“${checkpoint.name}”已找到，但小车当前位置尚未标定`);
    }
    const poseObservedAtMs = Date.parse(context.poseObservedAt ?? context.pose.observedAt ?? "");
    if (Number.isFinite(poseObservedAtMs) && Date.now() - poseObservedAtMs > NAVIGATION_POSE_FRESH_MS) {
      throw new Error(`小车位姿已过期（最后更新于 ${new Date(poseObservedAtMs).toLocaleString("zh-CN", { hour12: false })}），未发送导航命令`);
    }
    if (context.mapRevision === null) {
      throw new Error(`固定检查点“${checkpoint.name}”已找到，但 Jetson 导航地图尚未保存或同步`);
    }
    movementControllerId = source.id;
    completedNavigationPlans.delete(source.id);
    let requestId = `agent-navigation-${crypto.randomUUID()}`;
    try {
      const execute = (mapRevision: number) => jetsonControl.executeNavigation({
        requestId,
        mapRevision,
        start: {
          x: context.pose!.x,
          y: context.pose!.y,
          headingDeg: normalizeMapHeading(context.pose!.headingDeg),
        },
        goal: { x: checkpoint.x, y: checkpoint.y },
      });
      let status;
      try {
        status = await execute(context.mapRevision);
      } catch (error) {
        const currentRevision = jetsonNavigationConflictRevision(error);
        if (currentRevision === null || currentRevision === context.mapRevision) throw error;
        target.navigationContext = {
          ...context,
          mapRevision: currentRevision,
          mapObservedAt: new Date().toISOString(),
        };
        requestId = `agent-navigation-retry-${crypto.randomUUID()}`;
        status = await execute(currentRevision);
      }
      const elapsed = finiteStatusNumber(status.elapsed_ms);
      const message = `Jetson 已确认到达固定检查点“${checkpoint.name}”（request_id=${requestId}${elapsed === null ? "" : `，耗时 ${Math.ceil(elapsed / 1000)}秒`}）。`;
      if (planId) {
        completedNavigationPlans.set(source.id, {
          planId,
          completedAt: Date.now(),
          checkpointName: checkpoint.name,
        });
      }
      appendHistory("action", message);
      broadcast("vehicle.result", {
        ok: true,
        action: "navigation",
        requestId,
        deviceState: status.state,
        requestedBy: source.id,
        checkpointName: checkpoint.name,
        ...correlation,
        message,
      });
      return message;
    } catch (error) {
      const message = `前往固定检查点“${checkpoint.name}”未完成：${errorMessage(error)}`;
      appendHistory("error", message);
      broadcast("vehicle.result", {
        ok: false,
        action: "navigation",
        requestId,
        requestedBy: source.id,
        checkpointName: checkpoint.name,
        ...correlation,
        message,
      });
      throw new Error(message, { cause: error });
    } finally {
      if (movementControllerId === source.id) movementControllerId = null;
    }
  };

  const telemetryAvailabilityRuntime = async (): Promise<TelemetryAvailabilityRuntimeContext> => {
    try {
      const snapshot = await fetchTelemetrySnapshot();
      return {
        slots: Object.fromEntries(Object.entries(snapshot.slots ?? {}).flatMap(([slotId, slot]) => (
          isTelemetrySlotId(slotId)
            ? [[slotId, { state: slot.state, observedAt: slot.observedAt ?? null }]]
            : []
        ))),
        collector: telemetryCollector.status(),
      };
    } catch {
      return { collector: telemetryCollector.status() };
    }
  };

  const availabilityForDecision = async (
    target: ConnectedClient,
    decision: DeepSeekDecision,
    actions: readonly AgentAction[],
  ): Promise<TelemetryAvailabilityDiagnostic | undefined> => {
    const query = availabilityQueryForDecision(decision, actions);
    if (!query) return undefined;
    if (decision.semantic.primaryEvidence === "spatial-distribution" || decision.semantic.primaryEvidence === "inspection-map") {
      return spatialAvailabilityDiagnostic(query, target.spatialSampleCounts ?? undefined);
    }
    return diagnoseTelemetryAvailability(
      telemetryStore,
      query,
      await telemetryAvailabilityRuntime(),
    );
  };

  const runAction = async (
    source: ConnectedClient,
    action: AgentAction,
    planId: string | null = null,
    requestId: string | null = null,
    target: ConnectedClient = source,
    stepIndex?: number,
  ): Promise<string | null> => {
    const correlation: AgentExecutionCorrelation = {
      ...(requestId ? { agentRequestId: requestId } : {}),
      ...(planId ? { planId } : {}),
      ...(stepIndex ? { stepIndex } : {}),
    };
    switch (action.name) {
      case "telemetry.read_current":
        return telemetrySummary(action.arguments.slotId);
      case "telemetry.inspect_current":
        return inspectCurrentTelemetry(source, planId, action.arguments.slotIds);
      case "vehicle.navigate_to_checkpoint":
        return executeCheckpointNavigation(
          source,
          target,
          action.arguments.checkpointName,
          planId,
          correlation,
        );
      case "vehicle.propose_move":
      case "vehicle.move_distance":
      case "vehicle.turn_angle":
        {
          const command = normalizedVehicleTask(action);
          if (vehicleMoveAuthorization(config.vehicleEnabled, fullAccess || source.realVehicleEnabled) === "direct") {
            clearPendingVehicle("被自主任务替换");
            return executeVehicleTask(source, command, correlation);
          }
          proposeVehicle(source, command);
          return `车辆任务“${vehicleTaskLabel(command)}”已创建，等待二次确认；尚未向 Jetson 发送命令。`;
        }
      case "vehicle.confirm":
        if (!pendingVehicle) throw new Error("没有等待确认的车辆任务");
        return executePendingVehicle(source, pendingVehicle.confirmationId, correlation);
      case "vehicle.cancel":
        clearPendingVehicle("用户取消");
        return "已取消车辆任务。";
      case "vehicle.stop":
        return stopVehicle("语音急停", source, correlation);
      case "alerts.begin_processing": {
        if (!fullAccess && !source.alertWorkOrderAutomationEnabled) throw new Error("尚未开启 AI 处理告警工单权限");
        const item = telemetryStore.beginAlertWorkOrder(action.arguments.alertId, action.arguments.expectedVersion, "AI 智能中枢");
        broadcast("alerts.changed", { alertId: item.id, version: item.version });
        appendHistory("action", `AI 开始处理告警：${item.title}`);
        return `已开始处理“${item.title}”，工单版本已更新为 ${item.version}。`;
      }
      case "alerts.complete_work_order": {
        if (!fullAccess && !source.alertWorkOrderAutomationEnabled) throw new Error("尚未开启 AI 处理告警工单权限");
        const item = telemetryStore.completeAlertWorkOrder({
          alertId: action.arguments.alertId,
          expectedVersion: action.arguments.expectedVersion,
          actor: "AI 智能中枢",
          action: action.arguments.action,
          note: action.arguments.note,
        });
        broadcast("alerts.changed", { alertId: item.id, version: item.version });
        appendHistory("action", `AI 完成告警工单：${item.title}`);
        return `已完成“${item.title}”工单，处理记录已写入时间线。`;
      }
      default:
        return dispatchAction(source, action, planId, requestId, [target], stepIndex ?? 0);
    }
  };

  const handleTelemetryAnalysis = async (
    client: ConnectedClient,
    payload: ClientMessagePayload,
  ) => {
    let requestId = safeRequestId(payload.requestId);
    let fallback: ReturnType<typeof deterministicAnalysisForRequest> | null = null;
    try {
      const input = parseTelemetryAnalysisRequest(payload);
      requestId = input.requestId;
      send(client, "telemetry.analysis.state", { requestId, phase: "loading-data" });
      send(client, "telemetry.analysis.state", { requestId, phase: "calculating" });

      fallback = deterministicAnalysisForRequest(
        telemetryStore,
        input,
        getIoTProvider().kind,
        await telemetryAvailabilityRuntime(),
      );
      if (fallback.status === "insufficient-data") {
        send(client, "telemetry.analysis.result", { result: fallback });
        return;
      }

      const cacheKey = [
        fallback.dataVersion,
        Date.parse(fallback.basis.windowEnd) - Date.parse(fallback.basis.windowStart),
        client.thinkingMode,
        client.reasoningEffort,
        ...input.slotIds.slice().sort(),
      ].join("|");
      const cached = telemetryAnalysisCache.get(cacheKey);
      if (cached) {
        send(client, "telemetry.analysis.state", { requestId, phase: "organizing" });
        send(client, "telemetry.analysis.result", {
          result: {
            ...cached,
            requestId: input.requestId,
            availability: fallback.availability,
          },
        });
        return;
      }

      const lastRequestedAt = telemetryAnalysisRequestedAt.get(client.id) ?? 0;
      if (Date.now() - lastRequestedAt < 3_000) {
        throw new Error("AI 分析请求过于频繁，请稍后重试");
      }
      telemetryAnalysisRequestedAt.set(client.id, Date.now());
      const result = await analyzeTelemetryWithDeepSeek(config, fallback, (phase) => {
        send(client, "telemetry.analysis.state", { requestId, phase });
      }, {
        thinkingMode: client.thinkingMode,
        reasoningEffort: client.reasoningEffort,
      });
      telemetryAnalysisCache.set(cacheKey, result);
      if (telemetryAnalysisCache.size > 24) {
        const oldestKey = telemetryAnalysisCache.keys().next().value;
        if (typeof oldestKey === "string") telemetryAnalysisCache.delete(oldestKey);
      }
      send(client, "telemetry.analysis.result", { result });
    } catch (error) {
      const failure = publicGatewayFailure(error, fallback ? "analysis" : "request");
      send(client, "telemetry.analysis.error", {
        requestId,
        code: failure.code,
        message: failure.message,
        ...(fallback ? { fallback } : {}),
      });
    }
  };

  const handleTelemetryHistory = async (
    client: ConnectedClient,
    payload: ClientMessagePayload,
  ) => {
    try {
      const input = parseTelemetryHistoryRequest(payload);
      const result = historyResultForRequest(
        telemetryStore,
        input,
        getIoTProvider().kind,
        await telemetryAvailabilityRuntime(),
      );
      send(client, "telemetry.history.result", { result });
    } catch (error) {
      const failure = publicGatewayFailure(error, "request");
      send(client, "telemetry.history.error", {
        requestId: safeRequestId(payload.requestId),
        code: failure.code,
        message: failure.message,
      });
    }
  };

  const processText = async (client: ConnectedClient, text: string, requestedId?: string) => {
    const cleanText = text.trim().slice(0, MAX_USER_INPUT_LENGTH);
    if (!cleanText) return;
    const skipsTelemetryContext = deterministicImmediateNavigationDecision(cleanText) !== null
      || isExplicitVehicleEmergencyStop(cleanText);
    const requestId = safeRequestId(requestedId) || crypto.randomUUID();
    const actionTargets = chooseActionTargets(client);
    const actionTarget = actionTargets[0] ?? client;
    const { lease, superseded } = planningCoordinator.begin(
      client.id,
      actionTargets.map((target) => target.id),
      requestId,
    );
    for (const previous of superseded) {
      planningAbortControllers.get(previous.leaseId)?.abort(
        new DOMException("任务已被新的用户指令取代", "AbortError"),
      );
      planningAbortControllers.delete(previous.leaseId);
      rejectPendingPageActions(
        (pending) => pending.sourceClientId === previous.sourceId
          && pending.requestId === previous.requestId,
        "上一项任务已被新的用户指令取代，未再等待旧页面动作",
      );
      const affectedClientIds = new Set([previous.sourceId, ...previous.targetIds]);
      for (const affectedClient of clients.values()) {
        if (!affectedClientIds.has(affectedClient.id)) continue;
        send(affectedClient, "agent.cancelled", {
          requestId: previous.requestId,
          message: "上一项任务已被新的指令取代。",
        });
      }
    }
    const requestAbortController = new AbortController();
    planningAbortControllers.set(lease.leaseId, requestAbortController);
    const requestDeadline = setTimeout(() => {
      requestAbortController.abort(
        new DOMException("智能规划已达到本轮总等待时限", "TimeoutError"),
      );
    }, AGENT_REQUEST_DEADLINE_MS);
    requestDeadline.unref();
    const isCurrentRequest = () => planningCoordinator.isCurrent(lease.leaseId);
    const planningTrace: AgentPlanningTrace = {
      requestId,
      planningMode: null,
      stages: [
        { id: "understand", label: "理解信息目标", status: "active", detail: "正在区分数值、趋势、波动、分布、状态与建议" },
        { id: "context", label: "选择数据证据", status: "pending", detail: "等待匹配能够直接回答问题的图表或状态" },
        { id: "plan", label: "生成动作计划", status: "pending", detail: "等待把目标编排为可执行操作" },
        { id: "validate", label: "校验计划", status: "pending", detail: "等待检查协议、目标与动作顺序" },
        { id: "execution", label: "执行动作", status: "pending", detail: "等待逐步执行并确认真实回执" },
      ],
      updatedAt: new Date().toISOString(),
    };
    const updatePlanningStage = (
      id: AgentPlanningTrace["stages"][number]["id"],
      status: AgentPlanningTrace["stages"][number]["status"],
      detail: string,
    ) => {
      if (!isCurrentRequest()) return;
      planningTrace.stages = planningTrace.stages.map((stage) => (
        stage.id === id ? { ...stage, status, detail } : stage
      ));
      planningTrace.updatedAt = new Date().toISOString();
      publishPlanningTrace(
        client,
        { ...planningTrace, stages: planningTrace.stages.map((stage) => ({ ...stage })) },
        actionTargets,
      );
    };
    appendHistory("user", cleanText);
    voiceState(client, "understanding", { requestId, transcript: cleanText, error: null });
    publishPlanningTrace(client, planningTrace, actionTargets);
    const conversation = conversationFor(client.id);
    try {
      const runtimeContext = skipsTelemetryContext
        ? `目标屏幕当前位于${pageLabel(actionTarget.currentPage)}。本次请求是不依赖遥测数据的即时动作。${navigationRuntimeContext(actionTarget)}${fullAccess ? "Agent 完整应用权限已开启。" : ""}`
        : `${await telemetryRuntimeContext()} ${alertRuntimeContext()} ${navigationRuntimeContext(actionTarget)} ${fullAccess ? "Agent 完整应用权限已开启，所有已注册功能动作均可直接调用；" : ""}当前客户端 AI 工单处理权限为${client.alertWorkOrderAutomationEnabled ? "已开启" : "未开启"}；AI 自主小车控制权限为${client.realVehicleEnabled && config.vehicleEnabled ? "已开启，车辆通用移动、旋转和固定检查点导航原语可在同一计划内自主编排并顺序等待真实回执" : "未开启，车辆移动动作只创建确认请求，不会发送给 Jetson"}。目标屏幕当前位于${pageLabel(actionTarget.currentPage)}。可用页面能力包括：站内返回；所有页面的命名区域滚动定位与高亮，以及向上、向下、顶部、底部浏览；监测标签、曲线、时间范围、Flash AI 分析与冻结；小车实景导航地图的位置和六路环境图层、起点标定、房间尺寸、固定检查点与到点检测；孪生视角、显示、点尺寸、面板、缺口、环绕与截图；告警读取与工单处理；连接重检；设置草稿与保存。用户要求查看页面中的具体卡片或区域时使用 ui.focus_region，不能只导航到页面；只说“再往下看”等相对方向时使用 ui.scroll；要求返回时使用 ui.back。若请求的操作就在当前页面完成，不要重复调用 ui.navigate。`;
      const decision = await decideWithDeepSeek(
        config,
        cleanText,
        conversation.history,
        runtimeContext,
        (progress) => {
          if (progress.phase === "understanding") {
            updatePlanningStage("understand", progress.status, progress.detail);
            return;
          }
          if (progress.phase === "evidence") {
            if (progress.status === "active") {
              updatePlanningStage("context", "active", `${progress.detail}；目标屏幕位于${pageLabel(actionTarget.currentPage)}`);
            } else {
              updatePlanningStage("context", "complete", progress.detail);
            }
            return;
          }
          updatePlanningStage("plan", progress.status, progress.detail);
        },
        {
          thinkingMode: client.thinkingMode,
          reasoningEffort: client.reasoningEffort,
        },
        requestAbortController.signal,
      );
      if (!isCurrentRequest()) return;
      clearTimeout(requestDeadline);
      const compiledPlan = compileAgentPlanWithDiagnostics(decision.actions, actionTarget.currentPage);
      const actions = compiledPlan.actions;
      const planWarnings = [...new Set([
        ...(decision.warnings ?? []),
        ...compiledPlan.warnings,
      ])];
      const finalPlanningMode = choosePlanningMode(client.thinkingMode, cleanText, actions);
      planningTrace.planningMode = finalPlanningMode;
      updatePlanningStage(
        "plan",
        "complete",
        `已按“${decision.semantic.summary}”生成 ${decision.actions.length} 个候选动作`,
      );
      updatePlanningStage("validate", "active", "正在检查动作协议、目标、顺序与执行条件");
      const dataAvailability = await availabilityForDecision(actionTarget, decision, actions);
      if (!isCurrentRequest()) return;
      updatePlanningStage(
        "validate",
        "complete",
        dataAvailability && dataAvailability.status !== "available"
          ? `动作已通过校验；已定位数据条件：${dataAvailability.title}`
          : `已确认 ${actions.length} 个可执行动作`,
      );
      const plannedReply = replyForAvailability(dataAvailability) ?? replyForActions(actions, decision.reply);
      const planId = crypto.randomUUID();
      if (actions.length) {
        publishPlan(client, {
          id: planId,
          requestId,
          summary: plannedReply,
          planningMode: finalPlanningMode,
          steps: actions.map((action, index) => ({ index: index + 1, label: actionPublicLabel(action), action })),
          createdAt: new Date().toISOString(),
          planQuality: planWarnings.length ? "best-effort" : decision.planQuality ?? "verified",
          ...(planWarnings.length ? { warnings: planWarnings } : {}),
          ...(dataAvailability ? { dataAvailability } : {}),
        }, actionTargets);
        updatePlanningStage("execution", "active", `正在依次执行 ${actions.length} 个动作，并等待每一步真实完成回执`);
      } else {
        updatePlanningStage("execution", "complete", "本次为信息回复，无需执行页面或设备动作");
      }
      const resultTexts: string[] = [];
      let projectedTargetStepIndex = 0;
      for (const [index, action] of actions.entries()) {
        if (!isCurrentRequest()) return;
        if (isClientExecutedAction(action)) projectedTargetStepIndex += 1;
        const executionStepIndex = actionTarget === client || !isClientExecutedAction(action)
          ? index + 1
          : projectedTargetStepIndex;
        voiceState(client, isVehicleMovementAction(action)
          && vehicleMoveAuthorization(config.vehicleEnabled, fullAccess || client.realVehicleEnabled) === "confirmation"
          ? "confirming"
          : "executing", {
          requestId,
          transcript: cleanText,
          publicAction: `${index + 1}/${actions.length} ${actionPublicLabel(action)}`,
        });
        const result = await runAction(
          client,
          action,
          planId,
          requestId,
          actionTarget,
          executionStepIndex,
        );
        if (result) resultTexts.push(result);
        conversation.toolInteractions += 1;
      }
      if (actions.length) {
        updatePlanningStage("execution", "complete", `${actions.length} 个动作均已收到真实完成回执`);
      }
      const reply = resultTexts.length ? resultTexts.join("\n") : plannedReply;
      if (!isCurrentRequest()) return;
      conversation.history.push({ role: "user", content: cleanText }, { role: "assistant", content: reply });
      if (conversation.toolInteractions >= TOOL_INTERACTION_COUNTER_RESET) {
        conversation.toolInteractions = 0;
      }
      conversation.history = conversation.history.slice(-MAX_CONVERSATION_TURNS);
      conversation.updatedAt = Date.now();
      conversations.set(client.id, conversation);
      appendHistory("assistant", reply);
      send(client, "agent.reply", { requestId, text: reply, transcript: cleanText, speak: true });
      voiceState(client, pendingVehicle ? "confirming" : "speaking", {
        requestId,
        transcript: cleanText,
        reply,
        publicAction: null,
      });
      const timer = setTimeout(() => {
        voiceState(client, pendingVehicle ? "confirming" : "idle", { requestId, transcript: cleanText, reply });
      }, 1800);
      timer.unref();
    } catch (error) {
      if (!isCurrentRequest()) return;
      if (error instanceof PagePresentationCancelledError) {
        const reply = "已按你的选择结束本次证据讲解，其余可视步骤未执行。";
        conversation.history.push(
          { role: "user", content: cleanText },
          { role: "assistant", content: reply },
        );
        conversation.history = conversation.history.slice(-MAX_CONVERSATION_TURNS);
        conversation.updatedAt = Date.now();
        conversations.set(client.id, conversation);
        updatePlanningStage("execution", "complete", "用户已结束逐图讲解，后续可视动作已取消");
        appendHistory("assistant", reply);
        send(client, "agent.reply", { requestId, text: reply, transcript: cleanText, speak: false });
        voiceState(client, "speaking", {
          requestId,
          transcript: cleanText,
          reply,
          publicAction: null,
          error: null,
        });
        return;
      }
      const failure = publicGatewayFailure(error, "planning");
      const message = failure.message;
      conversation.history.push(
        { role: "user", content: cleanText },
        { role: "assistant", content: message },
      );
      conversation.history = conversation.history.slice(-MAX_CONVERSATION_TURNS);
      conversation.updatedAt = Date.now();
      conversations.set(client.id, conversation);
      const activeStage = planningTrace.stages.find((stage) => stage.status === "active")?.id ?? "validate";
      updatePlanningStage(activeStage, "error", message);
      appendHistory("error", message);
      voiceState(client, "error", { requestId, transcript: cleanText, error: message });
      send(client, "agent.error", { requestId, code: failure.code, message });
      console.warn(`Agent request ${requestId} failed [${failure.code}]: ${errorMessage(error)}`);
    } finally {
      clearTimeout(requestDeadline);
      if (planningAbortControllers.get(lease.leaseId) === requestAbortController) {
        planningAbortControllers.delete(lease.leaseId);
      }
      planningCoordinator.complete(lease.leaseId);
    }
  };

  const authenticateLocalClient = (client: ConnectedClient) => {
    if (!config.allowLocalAutoPair || !isLoopback(client.remoteAddress)) return false;
    const token = randomBytes(24).toString("base64url");
    validTokens.set(token, client.role);
    client.authenticated = true;
    send(client, "pair.accepted", { token, pairingCodeRequired: false });
    return true;
  };

  server.on("connection", (socket, request) => {
    const client: ConnectedClient = {
      id: crypto.randomUUID(),
      name: "未命名设备",
      role: "standalone",
      socket,
      authenticated: false,
      realVehicleEnabled: fullAccess,
      alertWorkOrderAutomationEnabled: fullAccess,
      thinkingMode: "thinking",
      reasoningEffort: "high",
      currentPage: "overview",
      remoteAddress: request.socket.remoteAddress ?? "",
      asr: null,
      spatialSampleCounts: null,
      navigationContext: null,
    };
    clients.set(socket, client);
    send(client, "gateway.hello", {
      requiresPairing: true,
      model: config.model,
      asrModel: config.asrModel,
      mockMode: config.mockMode,
      fullAccess,
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        if (client.authenticated) client.asr?.pushAudio(Buffer.from(data as Buffer));
        return;
      }
      let message: AgentEnvelope<string, ClientMessagePayload>;
      try { message = JSON.parse(data.toString()) as AgentEnvelope<string, ClientMessagePayload>; } catch { return; }
      if (message.version !== AGENT_PROTOCOL_VERSION || typeof message.type !== "string") return;
      const payload = message.payload ?? {};

      if (message.type === "pair.request") {
        if (payload.code !== pairingCode) {
          send(client, "agent.error", { message: "配对码错误" });
          return;
        }
        const token = randomBytes(24).toString("base64url");
        validTokens.set(token, client.role);
        client.authenticated = true;
        send(client, "pair.accepted", { token, pairingCodeRequired: true });
        send(client, "agent.history", { items: history });
        return;
      }

      if (message.type === "client.hello") {
        client.id = message.source || client.id;
        client.name = payload.name?.slice(0, 80) || client.name;
        const requestedRole = payload.role === "display" || payload.role === "remote" || payload.role === "standalone"
          ? payload.role
          : "standalone";
        client.realVehicleEnabled = fullAccess || payload.realVehicleEnabled === true;
        client.alertWorkOrderAutomationEnabled = fullAccess || payload.alertWorkOrderAutomationEnabled === true;
        client.thinkingMode = normalizeAgentThinkingMode(payload.thinkingMode);
        client.reasoningEffort = normalizeAgentReasoningEffort(payload.reasoningEffort);
        client.spatialSampleCounts = parseSpatialSampleCounts(payload.spatialSampleCounts) ?? client.spatialSampleCounts;
        client.navigationContext = parseNavigationContext(payload.navigationContext) ?? client.navigationContext;
        if (isUiPage(payload.page)) client.currentPage = payload.page;
        if (!client.authenticated) {
          const tokenRole = typeof payload.token === "string"
            ? validTokens.get(payload.token)
            : undefined;
          if (tokenRole) {
            client.role = tokenRole;
            client.authenticated = true;
          } else {
            client.role = requestedRole;
            authenticateLocalClient(client);
          }
        }
        if (client.authenticated) {
          send(client, "gateway.ready", {
            model: config.model,
            reasoningMode: client.thinkingMode,
            reasoningEffort: client.reasoningEffort,
            asrModel: config.asrModel,
            vehicleEnabled: config.vehicleEnabled,
            fullAccess,
            clientId: client.id,
          });
          send(client, "agent.history", { items: history });
          if (pendingVehicle) {
            send(client, "vehicle.pending", { command: publicPendingVehicle(pendingVehicle) });
          }
        } else {
          send(client, "gateway.pairing-required", { message: "请输入网关启动时显示的六位配对码" });
        }
        return;
      }

      if (!client.authenticated) return;
      if (message.type === "voice.start") {
        client.asr?.close();
        voiceState(client, "listening", { transcript: "", reply: "", error: null });
        client.asr = new FunAsrSession(config, {
          onReady: () => voiceState(client, "listening"),
          onPartial: (text) => voiceState(client, "listening", { transcript: text }),
          onFinal: (text) => voiceState(client, "listening", { transcript: text }),
          onFinished: (text) => {
            client.asr = null;
            if (text.trim()) {
              void processText(client, text);
            } else {
              voiceState(client, "idle", { transcript: "", reply: "", error: null });
            }
          },
          onError: (error) => { client.asr = null; voiceState(client, "error", { error: error.message }); },
        });
        client.asr.start();
        return;
      }
      if (message.type === "voice.stop") { client.asr?.finish(); return; }
      if (message.type === "agent.ask") {
        if (isUiPage(payload.page)) client.currentPage = payload.page;
        void processText(client, payload.text ?? "", payload.requestId ?? undefined);
        return;
      }
      if (message.type === "action.execution-state") {
        const executionId = typeof payload.actionExecutionId === "string"
          ? payload.actionExecutionId.trim()
          : "";
        const pending = executionId ? pendingPageActions.get(executionId) : undefined;
        if (!pending || pending.targetClientId !== client.id) return;
        if (
          payload.executionState !== "queued"
          && payload.executionState !== "started"
          && payload.executionState !== "cancelled"
        ) return;
        if (payload.executionState === "queued" && pending.executionState === "started") return;

        clearTimeout(pending.timer);
        if (payload.executionState === "cancelled") {
          pendingPageActions.delete(executionId);
          pending.reject(new PagePresentationCancelledError(
            `用户已结束页面讲解，“${pending.actionLabel}”未继续执行`,
          ));
          return;
        }

        const waitingForGuide = payload.executionState === "queued";
        pending.executionState = payload.executionState;
        pending.timer = setTimeout(() => {
          if (pendingPageActions.get(executionId) !== pending) return;
          pendingPageActions.delete(executionId);
          pending.reject(new Error(waitingForGuide
            ? `等待用户继续页面讲解超时，“${pending.actionLabel}”未执行`
            : `等待“${pending.actionLabel}”真实完成回执超时，后续动作已停止`));
        }, waitingForGuide ? PAGE_ACTION_GUIDE_WAIT_TIMEOUT_MS : pending.actionTimeoutMs);
        pending.timer.unref();
        return;
      }
      if (message.type === "action.result") {
        const executionId = typeof payload.actionExecutionId === "string"
          ? payload.actionExecutionId.trim()
          : "";
        const pending = executionId ? pendingPageActions.get(executionId) : undefined;
        if (!pending || pending.targetClientId !== client.id) return;
        const resultRequestId = typeof payload.requestId === "string"
          ? payload.requestId
          : payload.requestId === null
            ? null
            : undefined;
        const resultPlanId = typeof payload.planId === "string"
          ? payload.planId
          : payload.planId === null
            ? null
            : undefined;
        const metadataMatches = resultRequestId !== undefined
          && resultPlanId !== undefined
          && Number.isSafeInteger(payload.stepIndex)
          && payload.stepIndex === pending.stepIndex
          && resultRequestId === pending.requestId
          && resultPlanId === pending.planId
          && payload.actionName === pending.actionName
          && (payload.status === "success" || payload.status === "error");
        clearTimeout(pending.timer);
        pendingPageActions.delete(executionId);
        if (!metadataMatches) {
          pending.reject(new Error(`“${pending.actionLabel}”返回了无法关联的完成回执，后续动作已停止`));
          return;
        }
        const resultMessage = typeof payload.message === "string" && payload.message.trim()
          ? payload.message.trim()
          : payload.status === "success"
            ? `${pending.actionLabel}已真实完成。`
            : `${pending.actionLabel}执行失败。`;
        if (payload.status === "error") {
          pending.reject(new Error(resultMessage));
          return;
        }
        if (pending.pageAfterSuccess) client.currentPage = pending.pageAfterSuccess;
        pending.resolve(resultMessage);
        return;
      }
      if (message.type === "action.request") {
        try {
          const action = parseAgentAction(payload.action?.name, payload.action?.arguments ?? {});
          const actionTarget = chooseActionTargets(client)[0] ?? client;
          const directPlanId = action.name === "vehicle.navigate_to_checkpoint" ? crypto.randomUUID() : null;
          void runAction(client, action, directPlanId, null, actionTarget)
            .then((result) => send(client, "action.accepted", { text: result || actionPublicLabel(action), action }))
            .catch((error) => send(client, "agent.error", { message: errorMessage(error) }));
        } catch (error) {
          send(client, "agent.error", { message: errorMessage(error) });
        }
        return;
      }
      if (message.type === "telemetry.history.request") {
        void handleTelemetryHistory(client, payload);
        return;
      }
      if (message.type === "telemetry.events.request") {
        try {
          const input = parseTelemetryEventsRequest(payload);
          const result = eventsResultForRequest(telemetryStore, input);
          send(client, "telemetry.events.result", { result });
        } catch (error) {
          send(client, "telemetry.events.error", {
            requestId: safeRequestId(payload.requestId),
            message: errorMessage(error),
          });
        }
        return;
      }
      if (message.type === VEHICLE_FIRE_REPORT_TYPE) {
        try {
          const report = parseVehicleFireReport(payload);
          const result = telemetryStore.recordVehicleFireState(
            report.detected,
            report.observedAt,
            client.id,
          );
          send(client, "vehicle.fire.reported", result);
          if (result.changed) {
            broadcast("alerts.changed", {
              fireDetected: report.detected,
              observedAt: report.observedAt,
            });
          }
        } catch (error) {
          send(client, "vehicle.fire.report.error", { message: errorMessage(error) });
        }
        return;
      }
      if (message.type === "telemetry.analysis.request") {
        void handleTelemetryAnalysis(client, payload);
        return;
      }
      if (message.type === "telemetry.collector.settings.request") {
        try {
          const input = parseCollectorSettingsRequest(payload);
          send(client, "telemetry.collector.settings.result", {
            requestId: input.requestId,
            settings: collectorSettings,
            canEdit: canEditCollectorSettings(client.role),
          });
        } catch (error) {
          send(client, "telemetry.collector.settings.error", {
            requestId: safeRequestId(payload.requestId),
            message: errorMessage(error),
          });
        }
        return;
      }
      if (message.type === "telemetry.collector.settings.update") {
        try {
          const input = parseCollectorSettingsUpdateRequest(payload);
          if (!canEditCollectorSettings(client.role)) throw new Error("只有电脑显示端可以修改华为云后台读取间隔");
          collectorSettings = telemetryStore.saveCollectorSettings(
            input.pollIntervalMs,
            client.name || "电脑显示端",
          );
          telemetryCollector.setPollIntervalMs(collectorSettings.pollIntervalMs);
          send(client, "telemetry.collector.settings.result", {
            requestId: input.requestId,
            settings: collectorSettings,
            canEdit: true,
          });
          for (const target of clients.values()) {
            if (!target.authenticated || target === client) continue;
            send(target, "telemetry.collector.settings.changed", {
              settings: collectorSettings,
              canEdit: canEditCollectorSettings(target.role),
            });
          }
        } catch (error) {
          send(client, "telemetry.collector.settings.error", {
            requestId: safeRequestId(payload.requestId),
            message: errorMessage(error),
          });
        }
        return;
      }
      if (message.type === "alerts.list.request") {
        try {
          const input = parseAlertListRequest(payload);
          const result = telemetryStore.queryAlertWorkOrders(input);
          send(client, "alerts.list.result", { result: { ...result, requestId: input.requestId } });
        } catch (error) {
          send(client, "alerts.error", { requestId: safeRequestId(payload.requestId), scope: "list", message: errorMessage(error) });
        }
        return;
      }
      if (message.type === "alerts.detail.request") {
        try {
          const input = parseAlertDetailRequest(payload);
          const item = telemetryStore.readAlertWorkOrder(input.alertId);
          if (!item) throw new Error("告警记录不存在或已清理");
          send(client, "alerts.detail.result", { result: { requestId: input.requestId, item } });
        } catch (error) {
          send(client, "alerts.error", { requestId: safeRequestId(payload.requestId), scope: "detail", message: errorMessage(error) });
        }
        return;
      }
      if (message.type === "alerts.begin.request") {
        try {
          const input = parseAlertBeginRequest(payload);
          const item = telemetryStore.beginAlertWorkOrder(input.alertId, input.expectedVersion, input.actor);
          send(client, "alerts.detail.result", { result: { requestId: input.requestId, item } });
          broadcast("alerts.changed", { alertId: item.id, version: item.version });
        } catch (error) {
          send(client, "alerts.error", {
            requestId: safeRequestId(payload.requestId),
            scope: "detail",
            code: error instanceof AlertStoreConflictError ? "version-conflict" : "request-failed",
            message: errorMessage(error),
          });
        }
        return;
      }
      if (message.type === "alerts.complete.request") {
        try {
          const input = parseAlertCompleteRequest(payload);
          const item = telemetryStore.completeAlertWorkOrder(input);
          send(client, "alerts.detail.result", { result: { requestId: input.requestId, item } });
          broadcast("alerts.changed", { alertId: item.id, version: item.version });
        } catch (error) {
          send(client, "alerts.error", {
            requestId: safeRequestId(payload.requestId),
            scope: "detail",
            code: error instanceof AlertStoreConflictError ? "version-conflict" : "request-failed",
            message: errorMessage(error),
          });
        }
        return;
      }
      if (message.type === "alerts.rules.request") {
        try {
          const input = parseAlertRulesRequest(payload);
          send(client, "alerts.rules.result", { result: { requestId: input.requestId, rules: telemetryStore.listAlertRules(), generatedAt: new Date().toISOString() } });
        } catch (error) {
          send(client, "alerts.error", { requestId: safeRequestId(payload.requestId), scope: "rules", message: errorMessage(error) });
        }
        return;
      }
      if (message.type === "alerts.rules.save") {
        try {
          const input = parseAlertRulesSaveRequest(payload);
          const rules = telemetryStore.saveAlertRules(input);
          send(client, "alerts.rules.result", { result: { requestId: input.requestId, rules, generatedAt: new Date().toISOString() } });
          broadcast("alerts.changed", { rulesChanged: true });
        } catch (error) {
          send(client, "alerts.error", {
            requestId: safeRequestId(payload.requestId),
            scope: "rules",
            code: error instanceof AlertStoreConflictError ? "version-conflict" : "request-failed",
            message: errorMessage(error),
          });
        }
        return;
      }
      if (message.type === "alerts.clear.request") {
        try {
          const input = parseAlertClearRequest(payload);
          const cleared = telemetryStore.clearAlertWorkOrders();
          send(client, "alerts.clear.result", {
            result: {
              requestId: input.requestId,
              ...cleared,
              generatedAt: new Date().toISOString(),
            },
          });
          broadcast("alerts.changed", { cleared: true });
        } catch (error) {
          send(client, "alerts.error", {
            requestId: safeRequestId(payload.requestId),
            scope: "clear",
            message: errorMessage(error),
          });
        }
        return;
      }
      if (message.type === "vehicle.confirm") {
        void executePendingVehicle(client, payload.confirmationId)
          .catch((error) => send(client, "agent.error", { message: errorMessage(error) }));
        return;
      }
      if (message.type === "vehicle.cancel") { clearPendingVehicle("用户取消"); return; }
      if (message.type === "vehicle.stop") {
        if (payload.automatic === true && movementControllerId === null) return;
        void stopVehicle(payload.automatic === true ? "控制页面隐藏" : "本地急停", client)
          .catch((error) => send(client, "agent.error", { message: errorMessage(error) }));
        return;
      }
      if (message.type === "client.context") {
        if (isUiPage(payload.page)) client.currentPage = payload.page;
        client.spatialSampleCounts = parseSpatialSampleCounts(payload.spatialSampleCounts) ?? client.spatialSampleCounts;
        client.navigationContext = parseNavigationContext(payload.navigationContext) ?? client.navigationContext;
        return;
      }
      if (message.type === "client.preferences") {
        client.realVehicleEnabled = fullAccess || payload.realVehicleEnabled === true;
        client.alertWorkOrderAutomationEnabled = fullAccess || payload.alertWorkOrderAutomationEnabled === true;
        client.thinkingMode = normalizeAgentThinkingMode(payload.thinkingMode);
        client.reasoningEffort = normalizeAgentReasoningEffort(payload.reasoningEffort);
      }
    });

    socket.on("close", () => {
      client.asr?.close();
      clients.delete(socket);
      rejectPendingPageActions(
        (pending) => pending.sourceClientId === client.id || pending.targetClientId === client.id,
        pendingPageActions.size
          ? `页面执行端“${client.name}”已断开，未完成的动作已停止`
          : "页面执行端已断开",
      );
      for (const lease of planningCoordinator.clearClient(client.id)) {
        planningAbortControllers.get(lease.leaseId)?.abort(
          new DOMException("客户端已断开", "AbortError"),
        );
        planningAbortControllers.delete(lease.leaseId);
      }
      telemetryAnalysisRequestedAt.delete(client.id);
      completedNavigationPlans.delete(client.id);
      if (pendingVehicle?.requestedBy === client.id) clearPendingVehicle("发起设备已断开");
      if (!shuttingDown && movementControllerId === client.id) {
        void stopVehicle("控制设备断开").catch(() => undefined);
      }
    });
  });

  server.on("listening", () => {
    console.log(`\n星巡智能网关已启动：ws://0.0.0.0:${config.port}`);
    console.log(`配对码：${pairingCode}`);
    console.log(`模型：${config.mockMode ? "本地模拟" : config.model} + ${config.asrModel}`);
    console.log(`AI 小车控制：${config.vehicleEnabled ? "网关已允许（客户端可授权限时、定距与定角移动）" : "关闭"}\n`);
    console.log(`遥测历史：${telemetryStore.path} · 保留 ${telemetryStore.retentionDays} 天\n`);
    console.log(`华为云后台读取：${collectorSettings.pollIntervalMs / 1000} 秒\n`);
  });

  const shutdown = async () => {
    shuttingDown = true;
    for (const controller of planningAbortControllers.values()) {
      controller.abort(new DOMException("智能网关正在关闭", "AbortError"));
    }
    planningAbortControllers.clear();
    rejectPendingPageActions(() => true, "智能网关正在关闭，未完成的页面动作已停止");
    clearPendingVehicle("网关关闭");
    try { await stopVehicle("网关关闭"); } catch { /* best effort */ }
    await jetsonControl.close();
    for (const client of clients.values()) {
      client.asr?.close();
      client.socket.close(1001, "gateway shutdown");
    }
    await telemetryCollector.stop();
    telemetryStore.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { port: config.port, pairingCode, close: shutdown };
}

const HISTORY_RANGE_MS: Record<TelemetryHistoryRange, number> = {
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

const HISTORICAL_EVIDENCE = new Set([
  "indicator-posture",
  "range-profile",
  "correlation-matrix",
  "daily-heatmap",
  "spatial-distribution",
  "inspection-map",
  "history-table",
  "event-timeline",
  "ai-problems",
  "ai-recommendations",
]);

export function availabilityQueryForDecision(
  decision: DeepSeekDecision,
  actions: readonly AgentAction[],
  now: Date = new Date(),
) {
  const evidence = [decision.semantic.primaryEvidence, ...decision.semantic.supportingEvidence];
  const explicitRange = actions.find((action): action is Extract<AgentAction, { name: "monitoring.set_range" }> => (
    action.name === "monitoring.set_range"
  ))?.arguments.range;
  const needsHistoricalEvidence = evidence.some((item) => HISTORICAL_EVIDENCE.has(item))
    || actions.some((action) => action.name === "monitoring.generate_analysis");
  if (!needsHistoricalEvidence) return null;
  const range = decision.semantic.timeRange ?? explicitRange ?? "24h";
  const subjectSlots = decision.semantic.subjects.flatMap((subject) => subject.slotId ? [subject.slotId] : []);
  const actionSlots = actions.flatMap((action): TelemetrySlotId[] => {
    if (action.name === "telemetry.focus") return [action.arguments.slotId];
    if (action.name === "monitoring.generate_analysis") return action.arguments.slotIds ?? [];
    if (action.name === "spatial.set_layer" && action.arguments.layer !== "position") return [action.arguments.layer];
    return [];
  });
  const slotIds = [...new Set([...subjectSlots, ...actionSlots])];
  const to = now.toISOString();
  return {
    from: new Date(now.getTime() - HISTORY_RANGE_MS[range]).toISOString(),
    to,
    slotIds: slotIds.length ? slotIds : [...TELEMETRY_SLOT_IDS],
  };
}

function replyForAvailability(availability: TelemetryAvailabilityDiagnostic | undefined) {
  if (!availability || availability.status === "available") return null;
  return `我定位到数据条件问题：${availability.title}。${availability.detail}`;
}

export function publicGatewayFailure(
  error: unknown,
  context: "planning" | "request" | "analysis",
) {
  const raw = errorMessage(error);
  if (context === "request") {
    if (/(?:遥测|开始时间|结束时间|数据位|聚合粒度|请求).*(?:无效|不能|未来|格式)/.test(raw)) {
      return {
        code: "invalid-telemetry-request",
        message: "这次数据查询条件无效，请重新选择指标或时间范围。",
      } as const;
    }
    return {
      code: "telemetry-query-unavailable",
      message: "历史数据暂时无法读取，请稍后重新检查。",
    } as const;
  }
  if (context === "analysis") {
    if (/过于频繁/.test(raw)) {
      return { code: "analysis-busy", message: "上一项分析仍在处理中，请稍后再试。" } as const;
    }
    return {
      code: "analysis-service-unavailable",
      message: "AI 建议暂时不可用，已保留当前页面的数据和本地统计。",
      } as const;
  }
  if (/^智能网关尚未启用真实小车控制/.test(raw)) {
    return {
      code: "vehicle-control-disabled",
      message: `${raw.slice(0, 450)}。请在网关配置中启用小车控制后重新下达任务。`,
    } as const;
  }
  if (/^目标客户端尚未同步固定检查点/.test(raw)) {
    return {
      code: "checkpoint-context-missing",
      message: `${raw.slice(0, 450)}。请保持目标显示端在线并打开一次小车导航页面，等待固定检查点目录同步完成。`,
    } as const;
  }
  if (/^没有找到固定检查点/.test(raw)) {
    return {
      code: "checkpoint-not-found",
      message: raw.slice(0, 500),
    } as const;
  }
  if (/^固定检查点上下文已过期|^Jetson 当前离线|^小车位姿已过期|^Jetson 导航地图状态已过期/.test(raw)) {
    return {
      code: "vehicle-navigation-stale",
      message: raw.slice(0, 500),
    } as const;
  }
  if (/^(?:车辆任务失败|(?:前进|后退|左转|右转|前往固定检查点).+未完成)|Jetson .+(?:任务|连接).*(?:failed|失败|超时|断开)/i.test(raw)) {
    return {
      code: "vehicle-execution-failed",
      message: `${raw.slice(0, 450)}。后续车辆动作已停止。`,
    } as const;
  }
  if (/^固定检查点.+(?:小车当前位置尚未标定|Jetson 导航地图尚未保存或同步)/.test(raw)) {
    const nextStep = raw.includes("尚未标定")
      ? "请先在车辆导航页完成起点标定，再重新下达任务。"
      : "请先确认小车已连接，并等待 Jetson 导航地图加载完成后重试。";
    return {
      code: "vehicle-navigation-not-ready",
      message: `${raw.slice(0, 450)}。${nextStep}`,
    } as const;
  }
  if (/^(?:AI 意图判断不确定|AI 已识别为车辆控制|车辆计划未完整覆盖用户目标|DeepSeek 车辆任务)/.test(raw)) {
    return {
      code: "planning-clarification-needed",
      message: raw.slice(0, 500),
    } as const;
  }
  if (/^DeepSeek (?:车辆规划|车辆计划校验|未返回车辆)/.test(raw)) {
    return {
      code: "planner-unavailable",
      message: `车辆规划服务本轮没有返回可执行动作：${raw.slice(0, 400)}`,
    } as const;
  }
  if (/^DeepSeek 网络连接中断/.test(raw)) {
    return {
      code: "planner-unavailable",
      message: `${raw.slice(0, 450)}。本轮没有执行任何动作；可点击“重试本次任务”重新规划。`,
    } as const;
  }
  if (
    /(?:真实完成回执超时|完成回执.*超时|无法关联的完成回执|页面执行端.*(?:断开|未就绪)|动作接收器.*(?:未就绪|未挂载)|后续动作已停止)/.test(raw)
  ) {
    return {
      code: "agent-operation-failed",
      message: `页面动作没有真实完成，后续步骤已停止。具体原因：${raw.slice(0, 450)}`,
    } as const;
  }
  if (/(?:语义|证据|区域|页面|动作|参数|白名单|安全规则|tool|schema|JSON)/i.test(raw)) {
    return {
      code: "plan-validation-failed",
      message: `动作计划未通过协议校验，未执行任何动作。具体原因：${raw.slice(0, 420)}`,
    } as const;
  }
  if (/(?:DeepSeek|fetch|network|timeout|超时|429|限流|余额|API)/i.test(raw)) {
    return {
      code: "planner-unavailable",
      message: `智能规划本轮没有完成，未执行任何动作。具体原因：${raw.slice(0, 420)}。可点击“重试本次任务”重新规划。`,
    } as const;
  }
  return {
    code: "agent-operation-failed",
    message: `这次操作没有完成，后续步骤已停止。具体原因：${raw.slice(0, 450)}`,
  } as const;
}

function parseSpatialSampleCounts(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Partial<Record<TelemetrySlotId, number>> = {};
  for (const [slotId, count] of Object.entries(value)) {
    if (!isTelemetrySlotId(slotId) || !Number.isInteger(count) || Number(count) < 0 || Number(count) > 1_000_000) continue;
    result[slotId] = Number(count);
  }
  return result;
}

function parseNavigationContext(value: unknown): AgentNavigationContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.checkpoints) || raw.checkpoints.length > 64
    || typeof raw.calibrationConfirmed !== "boolean"
    || typeof raw.updatedAt !== "string"
    || !Number.isFinite(Date.parse(raw.updatedAt))) return null;
  const seen = new Set<string>();
  const checkpoints: AgentNavigationContext["checkpoints"] = [];
  for (const item of raw.checkpoints) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const checkpoint = item as Record<string, unknown>;
    const id = typeof checkpoint.id === "string" ? checkpoint.id.trim() : "";
    const name = typeof checkpoint.name === "string"
      ? checkpoint.name.normalize("NFKC").replace(/\s+/g, " ").trim()
      : "";
    const x = Number(checkpoint.x);
    const y = Number(checkpoint.y);
    const updatedAt = typeof checkpoint.updatedAt === "string" ? checkpoint.updatedAt : "";
    const nameKey = name.toLocaleLowerCase("zh-CN");
    if (!id || id.length > 128 || Array.from(name).length < 1 || Array.from(name).length > 20
      || seen.has(nameKey) || !Number.isFinite(x) || x < 0 || x > 1
      || !Number.isFinite(y) || y < 0 || y > 1 || !Number.isFinite(Date.parse(updatedAt))) return null;
    seen.add(nameKey);
    checkpoints.push({ id, name, x, y, updatedAt });
  }
  let pose: AgentNavigationContext["pose"] = null;
  if (raw.pose !== null && raw.pose !== undefined) {
    if (!raw.pose || typeof raw.pose !== "object" || Array.isArray(raw.pose)) return null;
    const candidate = raw.pose as Record<string, unknown>;
    const x = Number(candidate.x);
    const y = Number(candidate.y);
    const headingDeg = Number(candidate.headingDeg);
    const observedAt = candidate.observedAt === null ? null : typeof candidate.observedAt === "string" ? candidate.observedAt : undefined;
    if (!Number.isFinite(x) || x < 0 || x > 1
      || !Number.isFinite(y) || y < 0 || y > 1
      || !Number.isFinite(headingDeg) || observedAt === undefined
      || (observedAt !== null && !Number.isFinite(Date.parse(observedAt)))) return null;
    pose = { x, y, headingDeg: normalizeMapHeading(headingDeg), observedAt };
  }
  const mapRevision = raw.mapRevision === null
    ? null
    : Number.isSafeInteger(raw.mapRevision) && Number(raw.mapRevision) >= 1
      ? Number(raw.mapRevision)
      : null;
  const controlLink = typeof raw.controlLink === "string"
    && ["disabled", "disconnected", "connecting", "connected", "error"].includes(raw.controlLink)
    ? raw.controlLink as NonNullable<AgentNavigationContext["controlLink"]>
    : undefined;
  const vehicleConnection = typeof raw.vehicleConnection === "string"
    && ["online", "stale", "offline"].includes(raw.vehicleConnection)
    ? raw.vehicleConnection as NonNullable<AgentNavigationContext["vehicleConnection"]>
    : undefined;
  const imuState = raw.imuState === null
    ? null
    : typeof raw.imuState === "string"
      && ["live", "calibrating", "stale", "offline", "error"].includes(raw.imuState)
      ? raw.imuState as Exclude<AgentNavigationContext["imuState"], null | undefined>
      : undefined;
  const parseOptionalTimestamp = (candidate: unknown) => (
    candidate === null
      ? null
      : typeof candidate === "string" && Number.isFinite(Date.parse(candidate))
        ? candidate
        : undefined
  );
  const mapObservedAt = parseOptionalTimestamp(raw.mapObservedAt);
  const poseObservedAt = parseOptionalTimestamp(raw.poseObservedAt);
  return {
    checkpoints,
    pose,
    calibrationConfirmed: raw.calibrationConfirmed,
    mapRevision,
    ...(controlLink === undefined ? {} : { controlLink }),
    ...(vehicleConnection === undefined ? {} : { vehicleConnection }),
    ...(imuState === undefined ? {} : { imuState }),
    ...(mapObservedAt === undefined ? {} : { mapObservedAt }),
    ...(poseObservedAt === undefined ? {} : { poseObservedAt }),
    updatedAt: raw.updatedAt,
  };
}

function replyForActions(actions: AgentAction[], fallback: string) {
  if (!actions.length) return fallback || "我暂时没有找到可执行的操作。";
  const labels = actions.map(actionPublicLabel);
  if (labels.length === 1) return `正在${labels[0]}。`;
  return `好的，${labels.map((label, index) => `${index === 0 ? "先" : "再"}${label}`).join("，")}。`;
}

function pageLabel(page: UiPage) {
  return ({
    overview: "控制概览",
    "digital-twin": "空间孪生",
    vehicle: "小车遥控",
    monitoring: "数据监测",
    alerts: "告警管理",
    integrations: "连接管理",
    settings: "系统设置",
  } as const)[page];
}

function isUiPage(value: unknown): value is UiPage {
  return typeof value === "string" && [
    "overview",
    "digital-twin",
    "vehicle",
    "monitoring",
    "alerts",
    "integrations",
    "settings",
  ].includes(value);
}

function isTelemetrySlotId(value: string): value is TelemetrySlotId {
  return (TELEMETRY_SLOT_IDS as readonly string[]).includes(value);
}

function wheelSpeeds(motion: Exclude<VehicleMotion, "stop">, percent: number) {
  const speed = Math.round(300 * percent / 100);
  const table = {
    forward: [speed, -speed, speed, -speed],
    backward: [-speed, speed, -speed, speed],
    left: [-speed, -speed, speed, speed],
    right: [speed, speed, -speed, -speed],
  };
  return table[motion];
}

function motionLabel(motion: string) {
  return ({ forward: "前进", backward: "后退", left: "左转", right: "右转" } as Record<string, string>)[motion] ?? motion;
}

function isVehicleMovementAction(
  action: AgentAction,
): action is Extract<AgentAction, { name: "vehicle.propose_move" | "vehicle.move_distance" | "vehicle.turn_angle" | "vehicle.navigate_to_checkpoint" }> {
  return action.name === "vehicle.propose_move"
    || action.name === "vehicle.move_distance"
    || action.name === "vehicle.turn_angle"
    || action.name === "vehicle.navigate_to_checkpoint";
}

function normalizeMapHeading(value: number) {
  return ((value % 360) + 360) % 360;
}

function defaultDistanceTimeout(distanceMm: number, maxSpeedMmps: number) {
  return Math.max(5, distanceMm / maxSpeedMmps * 5 + 5);
}

function defaultTurnTimeout(angleDeg: number) {
  return Math.max(5, angleDeg / 25 * 5 + 5);
}

function vehicleTaskLabel(command: NormalizedVehicleTask) {
  if (command.kind === "timed") {
    return `${motionLabel(command.motion)} ${command.speedPercent}% · ${command.durationMs}ms`;
  }
  if (command.kind === "distance") {
    return `${command.direction === "forward" ? "前进" : "后退"} ${formatVehicleNumber(command.distanceMm)}mm`;
  }
  return `${command.direction === "left" ? "左转" : "右转"} ${formatVehicleNumber(command.angleDeg)}°`;
}

function completedVehicleMessage(
  command: Extract<NormalizedVehicleTask, { kind: "distance" | "turn" }>,
  status: JetsonControlStatus,
) {
  const elapsed = finiteStatusNumber(status.elapsed_ms);
  const elapsedText = elapsed === null ? "" : `，耗时 ${Math.round(elapsed)}ms`;
  if (command.kind === "distance") {
    const measured = finiteStatusNumber(status.measured_distance_mm);
    const error = finiteStatusNumber(status.final_error_mm);
    const measuredText = measured === null ? "" : `，实测 ${formatVehicleNumber(measured)}mm`;
    const errorText = error === null ? "" : `，最终误差 ${formatVehicleNumber(error)}mm`;
    return `Jetson 已确认${vehicleTaskLabel(command)}完成（request_id=${status.request_id}${measuredText}${errorText}${elapsedText}）。`;
  }
  const measured = finiteStatusNumber(status.measured_angle_deg);
  const error = finiteStatusNumber(status.final_error_deg);
  const measuredText = measured === null ? "" : `，实测 ${formatVehicleNumber(measured)}°`;
  const errorText = error === null ? "" : `，最终误差 ${formatVehicleNumber(error)}°`;
  return `Jetson 已确认${vehicleTaskLabel(command)}完成（request_id=${status.request_id}${measuredText}${errorText}${elapsedText}）。`;
}

function finiteStatusNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatVehicleNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, milliseconds));
  });
}

function publicPendingVehicle(command: VehiclePendingState): PendingVehicleCommand {
  const base = {
    confirmationId: command.confirmationId,
    requestedBy: command.requestedBy,
    expiresAt: command.expiresAt,
  };
  if (command.kind === "timed") {
    return {
      ...base,
      kind: "timed",
      motion: command.motion,
      speedPercent: command.speedPercent,
      durationMs: command.durationMs,
    };
  }
  if (command.kind === "distance") {
    return {
      ...base,
      kind: "distance",
      direction: command.direction,
      distanceMm: command.distanceMm,
      maxSpeedMmps: command.maxSpeedMmps,
      timeoutS: command.timeoutS,
    };
  }
  return {
    ...base,
    kind: "turn",
    direction: command.direction,
    angleDeg: command.angleDeg,
    maxSpeedMmps: command.maxSpeedMmps,
    timeoutS: command.timeoutS,
  };
}

function isLoopback(address: string) {
  return address === "127.0.0.1" || address === "::1" || address.endsWith(":127.0.0.1");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}

function safeRequestId(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  const handle = startAgentGateway();
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
