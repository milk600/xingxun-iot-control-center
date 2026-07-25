import {
  actionPublicLabel,
  compileAgentPlanWithDiagnostics,
} from "@/app/lib/ai/action-registry";
import { pageActionTimeoutMs } from "@/app/lib/ai/action-events";
import {
  createAgentEnvelope,
  normalizeAgentReasoningEffort,
  normalizeAgentThinkingMode,
  type AgentAction,
  type AgentActionName,
  type AgentHistoryItem,
  type AgentNavigationContext,
  type AgentPlan,
  type AgentPlanningTrace,
  type AgentReasoningEffort,
  type AgentThinkingMode,
  type PendingVehicleCommand,
  type UiPage,
} from "@/app/lib/ai/contracts";
import {
  TELEMETRY_SLOT_IDS,
  type DashboardSnapshot,
  type TelemetrySlotId,
} from "@/app/lib/iot/contracts";
import { readJetsonSettings } from "@/app/lib/iot/jetson-websocket";
import {
  parseVehicleFireReport,
  VEHICLE_FIRE_REPORT_TYPE,
} from "@/app/lib/iot/fire-detection";
import type { TelemetryAvailabilityDiagnostic } from "@/app/lib/iot/telemetry-history-contracts";
import type { AgentGatewayConfig } from "@/agent/config";
import {
  choosePlanningMode,
  decideWithDeepSeek,
  deterministicImmediateNavigationDecision,
  isExplicitVehicleEmergencyStop,
  type ConversationTurn,
  type DeepSeekDecision,
} from "@/agent/deepseek";
import { analyzeTelemetryWithDeepSeek } from "@/agent/deepseek-analysis";
import { spatialAvailabilityDiagnostic } from "@/agent/telemetry-diagnostics";
import {
  beginAndroidAlert,
  clearAndroidAlerts,
  completeAndroidAlert,
  deterministicAnalysisForAndroid,
  eventsForAndroid,
  historyForAndroid,
  listAndroidAlertRules,
  listAndroidAlerts,
  LOCAL_ALERTS_CHANGED_EVENT,
  recordAndroidVehicleFire,
  readAndroidAlert,
  saveAndroidAlertRules,
} from "./local-data-store";
import {
  finishNativeAsr,
  pushNativeAsrAudio,
  readAndroidRuntimeConfig,
  startNativeAsr,
  type NativeAsrEventDetail,
} from "./native-cloud";
import {
  AndroidCheckpointInspectionError,
  findAndroidCheckpoint,
  parseAndroidNavigationContext,
  waitForFreshLiveTelemetry,
} from "./checkpoint-runtime";
import {
  AndroidJetsonControlClient,
  androidJetsonNavigationConflictRevision,
  completedAndroidVehicleMessage,
  defaultAndroidDistanceTimeout,
  defaultAndroidTurnTimeout,
  type AndroidJetsonNavigationStatus,
  type AndroidJetsonControlStatus,
} from "./jetson-control-runtime";

const LOCAL_AGENT_URL = "ws://xingxun.local/agent";
const HISTORY_KEY = "xingxun:android-agent-history:v1";
const ANDROID_AGENT_FULL_ACCESS = true;

type AndroidVehicleTask =
  | {
      kind: "timed";
      motion: "forward" | "backward" | "left" | "right";
      speedPercent: number;
      durationMs: number;
    }
  | {
      kind: "distance";
      direction: "forward" | "backward";
      distanceMm: number;
      maxSpeedMmps: number;
      timeoutS: number;
    }
  | {
      kind: "turn";
      direction: "left" | "right";
      angleDeg: number;
      maxSpeedMmps: number;
      timeoutS: number;
    };

interface ClientPayload {
  requestId?: string | null;
  text?: string;
  page?: UiPage;
  realVehicleEnabled?: boolean;
  alertWorkOrderAutomationEnabled?: boolean;
  thinkingMode?: AgentThinkingMode;
  reasoningEffort?: AgentReasoningEffort;
  confirmationId?: string;
  alertId?: string;
  expectedVersion?: number;
  actor?: string;
  action?: string;
  actionName?: AgentActionName;
  planId?: string | null;
  stepIndex?: number;
  actionExecutionId?: string;
  status?: "success" | "error";
  executionState?: "queued" | "started" | "cancelled";
  message?: string;
  completedAt?: string;
  note?: string;
  rules?: unknown;
  statuses?: unknown;
  severities?: unknown;
  slotIds?: unknown;
  from?: string;
  to?: string;
  resolution?: unknown;
  limit?: number;
  spatialSampleCounts?: unknown;
  navigationContext?: unknown;
  detected?: unknown;
  observedAt?: unknown;
  source?: unknown;
}

interface AndroidPageActionWaiter {
  requestId: string;
  planId: string;
  stepIndex: number;
  actionExecutionId: string;
  actionName: AgentActionName;
  actionLabel: string;
  actionTimeoutMs: number;
  executionState: "dispatching" | "queued" | "started";
  pageAfterSuccess: UiPage | null;
  resolve: (message: string | null) => void;
  reject: (error: Error) => void;
  timer: number;
}

class PagePresentationCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PagePresentationCancelledError";
  }
}

class AndroidLocalAgentRuntime {
  private socket: LocalAgentSocket | null = null;
  private clientId = "android-client";
  private currentPage: UiPage = "overview";
  private realVehicleEnabled = ANDROID_AGENT_FULL_ACCESS;
  private alertWorkOrderAutomationEnabled = ANDROID_AGENT_FULL_ACCESS;
  private thinkingMode: AgentThinkingMode = "thinking";
  private reasoningEffort: AgentReasoningEffort = "high";
  private spatialSampleCounts: Partial<Record<TelemetrySlotId, number>> | null = null;
  private navigationContext: AgentNavigationContext | null = null;
  private completedNavigation: {
    planId: string;
    checkpointName: string;
    completedAt: number;
  } | null = null;
  private conversation: ConversationTurn[] = [];
  private history = readHistory();
  private requestSequence = 0;
  private planningAbortController: AbortController | null = null;
  private pendingVehicle: PendingVehicleCommand | null = null;
  private pendingTimer: number | null = null;
  private asrSessionId: string | null = null;
  private partialTranscript = "";
  private readonly pageActionWaiters = new Map<
    string,
    AndroidPageActionWaiter
  >();
  private readonly jetsonControl = new AndroidJetsonControlClient({
    onStatus: (status) => this.send("vehicle.progress", { status }),
  });

  constructor() {
    window.addEventListener("xingxun:native-asr", this.onAsr as EventListener);
    window.addEventListener(LOCAL_ALERTS_CHANGED_EVENT, this.onAlertsChanged);
    window.addEventListener("xingxun:vehicle-stop-request", this.onLifecycleStop);
  }

  connect(socket: LocalAgentSocket) {
    this.socket?.close(1000, "replaced");
    this.socket = socket;
  }

  disconnect(socket: LocalAgentSocket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.requestSequence += 1;
    this.planningAbortController?.abort(
      new DOMException("Android Agent 连接已断开", "AbortError"),
    );
    this.planningAbortController = null;
    this.rejectPageActionWaiters(
      new Error("页面动作已因 Android Agent 连接断开而取消"),
    );
    this.finishVoice();
    if (this.jetsonControl.hasActiveTask) {
      void this.stopVehicle("控制设备断开").catch(() => undefined);
    }
  }

  receive(socket: LocalAgentSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (socket !== this.socket) return;
    if (typeof data !== "string") {
      if (this.asrSessionId && !dataIsBlob(data)) {
        const bytes = ArrayBuffer.isView(data) ? data : data as ArrayBuffer;
        pushNativeAsrAudio(this.asrSessionId, bytes);
      }
      return;
    }
    let message: { type?: string; source?: string; payload?: ClientPayload };
    try { message = JSON.parse(data) as typeof message; } catch { return; }
    const payload = message.payload ?? {};
    switch (message.type) {
      case "client.hello":
        if (typeof message.source === "string" && message.source.trim()) {
          this.clientId = message.source.trim().slice(0, 120);
        }
        this.applyPreferences(payload);
        this.applyDisplayContext(payload);
        this.send("gateway.ready", {
          model: "deepseek-v4-flash",
          reasoningMode: this.thinkingMode,
          reasoningEffort: this.reasoningEffort,
          asrModel: readAndroidRuntimeConfig().asrModel,
          vehicleEnabled: readJetsonSettings().enabled,
          fullAccess: ANDROID_AGENT_FULL_ACCESS,
          clientId: "android-local",
          standalone: true,
        });
        this.send("agent.history", { items: this.history });
        return;
      case "client.context":
        this.applyDisplayContext(payload);
        return;
      case "client.preferences":
        this.applyPreferences(payload);
        return;
      case "action.execution-state":
        this.handlePageActionExecutionState(payload);
        return;
      case "action.result":
        this.handlePageActionResult(payload);
        return;
      case "agent.ask":
        this.rejectPageActionWaiters(
          new Error("页面动作已被新的 Agent 请求替换"),
        );
        void this.processText(String(payload.text ?? ""), safeRequestId(payload.requestId));
        return;
      case "telemetry.history.request":
        void this.handleHistory(payload);
        return;
      case "telemetry.events.request":
        void this.handleEvents(payload);
        return;
      case VEHICLE_FIRE_REPORT_TYPE:
        void this.handleVehicleFire(payload);
        return;
      case "telemetry.analysis.request":
        void this.handleAnalysis(payload);
        return;
      case "telemetry.collector.settings.request":
      case "telemetry.collector.settings.update":
        this.send("telemetry.collector.settings.error", {
          requestId: safeRequestId(payload.requestId),
          message: "Android 独立端由当前设备的页面刷新周期直接控制华为云读取，不使用电脑网关后台采集设置",
        });
        return;
      case "alerts.list.request":
        this.handleAlertList(payload);
        return;
      case "alerts.detail.request":
        this.handleAlertDetail(payload);
        return;
      case "alerts.begin.request":
        this.handleAlertBegin(payload);
        return;
      case "alerts.complete.request":
        this.handleAlertComplete(payload);
        return;
      case "alerts.rules.request":
        this.send("alerts.rules.result", { result: { requestId: safeRequestId(payload.requestId), rules: listAndroidAlertRules(), generatedAt: new Date().toISOString() } });
        return;
      case "alerts.rules.save":
        this.handleRulesSave(payload);
        return;
      case "alerts.clear.request":
        this.send("alerts.clear.result", { result: clearAndroidAlerts(safeRequestId(payload.requestId)) });
        return;
      case "vehicle.confirm":
        void this.confirmVehicle(payload.confirmationId);
        return;
      case "vehicle.cancel":
        this.clearPending("用户取消");
        return;
      case "vehicle.stop":
        void this.stopVehicle("本地急停").catch(() => undefined);
        return;
      case "voice.start":
        this.startVoice();
        return;
      case "voice.stop":
        this.finishVoice();
    }
  }

  private async handleVehicleFire(payload: ClientPayload) {
    try {
      const report = parseVehicleFireReport(payload);
      const changed = await recordAndroidVehicleFire(report.detected, report.observedAt);
      this.send("vehicle.fire.reported", {
        changed: changed > 0,
        detected: report.detected,
        observedAt: report.observedAt,
      });
    } catch (error) {
      this.send("vehicle.fire.report.error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private applyPreferences(payload: ClientPayload) {
    this.realVehicleEnabled = ANDROID_AGENT_FULL_ACCESS || payload.realVehicleEnabled === true;
    this.alertWorkOrderAutomationEnabled = ANDROID_AGENT_FULL_ACCESS
      || payload.alertWorkOrderAutomationEnabled === true;
    this.thinkingMode = normalizeAgentThinkingMode(payload.thinkingMode);
    this.reasoningEffort = normalizeAgentReasoningEffort(payload.reasoningEffort);
  }

  private applyDisplayContext(payload: ClientPayload) {
    if (isUiPage(payload.page)) this.currentPage = payload.page;
    this.spatialSampleCounts = parseSpatialSampleCounts(
      payload.spatialSampleCounts,
    ) ?? this.spatialSampleCounts;
    if (payload.navigationContext === null) {
      this.navigationContext = null;
    } else if (payload.navigationContext !== undefined) {
      this.navigationContext = parseAndroidNavigationContext(
        payload.navigationContext,
      ) ?? this.navigationContext;
    }
  }

  private async processText(input: string, requestedId: string) {
    const text = input.trim().slice(0, 4_000);
    if (!text) return;
    const skipsTelemetryContext = deterministicImmediateNavigationDecision(text) !== null
      || isExplicitVehicleEmergencyStop(text);
    const requestId = requestedId || crypto.randomUUID();
    this.planningAbortController?.abort(
      new DOMException("任务已被新的用户指令取代", "AbortError"),
    );
    const planningAbortController = new AbortController();
    this.planningAbortController = planningAbortController;
    const sequence = ++this.requestSequence;
    const isCurrent = () => sequence === this.requestSequence;
    const trace: AgentPlanningTrace = {
      requestId,
      planningMode: null,
      stages: [
        { id: "understand", label: "理解信息目标", status: "active", detail: "正在区分数值、趋势、波动、分布、状态与建议" },
        { id: "context", label: "选择数据证据", status: "pending", detail: "等待匹配能够直接回答问题的图表或状态" },
        { id: "plan", label: "生成动作计划", status: "pending", detail: "等待把目标编排为可执行操作" },
        { id: "validate", label: "校验计划", status: "pending", detail: "等待检查协议、目标与动作顺序" },
        { id: "execution", label: "执行动作", status: "pending", detail: "等待计划校验完成后按顺序执行并核对真实回执" },
      ],
      updatedAt: new Date().toISOString(),
    };
    const update = (id: AgentPlanningTrace["stages"][number]["id"], status: AgentPlanningTrace["stages"][number]["status"], detail: string) => {
      trace.stages = trace.stages.map((stage) => stage.id === id ? { ...stage, status, detail } : stage);
      trace.updatedAt = new Date().toISOString();
      this.send("agent.trace", { trace });
    };
    this.appendHistory("user", text);
    this.send("voice.state", { phase: "understanding", requestId, transcript: text, error: null, updatedAt: new Date().toISOString() });
    this.send("agent.trace", { trace });
    try {
      const runtimeContext = skipsTelemetryContext
        ? `Android 独立运行；目标屏幕当前位于${pageLabel(this.currentPage)}。本次请求是不依赖遥测数据的即时动作。`
        : await this.runtimeContext();
      const config = androidAgentConfig();
      const decision = await decideWithDeepSeek(
        config,
        text,
        this.conversation,
        runtimeContext,
        (progress) => {
          if (!isCurrent()) return;
          if (progress.phase === "understanding") update("understand", progress.status, progress.detail);
          else if (progress.phase === "evidence") update(
            "context",
            progress.status,
            progress.status === "active" ? `${progress.detail}；目标屏幕位于${pageLabel(this.currentPage)}` : progress.detail,
          );
          else update("plan", progress.status, progress.detail);
        },
        {
          thinkingMode: this.thinkingMode,
          reasoningEffort: this.reasoningEffort,
        },
        planningAbortController.signal,
      );
      if (!isCurrent()) return;
      const compiledPlan = compileAgentPlanWithDiagnostics(decision.actions, this.currentPage);
      const actions = compiledPlan.actions;
      const planWarnings = [...new Set([
        ...(decision.warnings ?? []),
        ...compiledPlan.warnings,
      ])];
      trace.planningMode = choosePlanningMode(this.thinkingMode, text, actions);
      update("plan", "complete", `已按“${decision.semantic.summary}”生成 ${decision.actions.length} 个候选动作`);
      update("validate", "active", "正在检查动作协议、目标、顺序与执行条件");
      const dataAvailability = await this.availabilityForDecision(
        decision,
        actions,
      );
      if (!isCurrent()) return;
      update(
        "validate",
        "complete",
        dataAvailability && dataAvailability.status !== "available"
          ? `动作已通过校验；已定位数据条件：${dataAvailability.title}`
          : `已确认 ${actions.length} 个可执行动作`,
      );
      const planId = crypto.randomUUID();
      const reply = replyForAvailability(dataAvailability)
        ?? replyForActions(actions, decision.reply);
      if (actions.length) {
        const plan: AgentPlan = {
          id: planId,
          requestId,
          summary: reply,
          planningMode: trace.planningMode ?? "thinking",
          steps: actions.map((action, index) => ({ index: index + 1, label: actionPublicLabel(action), action })),
          createdAt: new Date().toISOString(),
          planQuality: planWarnings.length ? "best-effort" : decision.planQuality ?? "verified",
          ...(planWarnings.length
            ? { warnings: planWarnings }
            : {}),
          ...(dataAvailability ? { dataAvailability } : {}),
        };
        this.send("agent.plan", { plan });
      }
      update(
        "execution",
        "active",
        actions.length
          ? `正在按顺序执行 ${actions.length} 个动作并等待真实完成回执`
          : "当前计划没有需要执行的动作",
      );
      const resultTexts: string[] = [];
      for (const [index, action] of actions.entries()) {
        if (!isCurrent()) return;
        this.send("voice.state", {
          phase: isVehicleMovementAction(action) && !this.realVehicleEnabled
            ? "confirming"
            : "executing",
          requestId,
          transcript: text,
          publicAction: `${index + 1}/${actions.length} ${actionPublicLabel(action)}`,
          updatedAt: new Date().toISOString(),
        });
        const result = await this.runAction(
          action,
          planId,
          requestId,
          index + 1,
        );
        if (result) resultTexts.push(result);
      }
      update(
        "execution",
        "complete",
        actions.length
          ? `已确认 ${actions.length} 个动作全部完成`
          : "无需执行动作，已完成回复准备",
      );
      const finalReply = resultTexts.length ? resultTexts.join("\n") : reply;
      const completedTurns: ConversationTurn[] = [
        ...this.conversation,
        { role: "user", content: text },
        { role: "assistant", content: finalReply },
      ];
      this.conversation = completedTurns.slice(-128);
      this.appendHistory("assistant", finalReply);
      this.send("agent.reply", { requestId, text: finalReply, transcript: text, speak: true });
      this.send("voice.state", { phase: this.pendingVehicle ? "confirming" : "idle", requestId, transcript: text, reply: finalReply, publicAction: null, updatedAt: new Date().toISOString() });
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof PagePresentationCancelledError) {
        const reply = "已按你的选择结束本次证据讲解，其余可视步骤未执行。";
        this.conversation = [
          ...this.conversation,
          { role: "user" as const, content: text },
          { role: "assistant" as const, content: reply },
        ].slice(-128);
        update("execution", "complete", "用户已结束逐图讲解，后续可视动作已取消");
        this.appendHistory("assistant", reply);
        this.send("agent.reply", {
          requestId,
          text: reply,
          transcript: text,
          speak: false,
        });
        this.send("voice.state", {
          phase: "idle",
          requestId,
          transcript: text,
          reply,
          error: null,
          publicAction: null,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      const message = publicError(error, "设备内智能中枢执行失败");
      this.conversation = [
        ...this.conversation,
        { role: "user" as const, content: text },
        { role: "assistant" as const, content: message },
      ].slice(-128);
      const active = trace.stages.some(
        (stage) => stage.id === "execution" && stage.status === "active",
      )
        ? "execution"
        : trace.stages.find((stage) => stage.status === "active")?.id
          ?? "validate";
      update(active, "error", message);
      this.appendHistory("error", message);
      this.send("agent.error", { requestId, message });
      this.send("voice.state", { phase: "error", requestId, transcript: text, error: message, updatedAt: new Date().toISOString() });
    } finally {
      if (this.planningAbortController === planningAbortController) {
        this.planningAbortController = null;
      }
    }
  }

  private async runAction(
    action: AgentAction,
    planId: string,
    requestId: string,
    stepIndex: number,
  ): Promise<string | null> {
    if (action.name === "telemetry.read_current") return this.telemetrySummary(action.arguments.slotId);
    if (action.name === "vehicle.navigate_to_checkpoint") {
      return this.executeCheckpointNavigation(
        action.arguments.checkpointName,
        planId,
        requestId,
      );
    }
    if (action.name === "telemetry.inspect_current") {
      return this.inspectCurrentTelemetry(
        planId,
        action.arguments.slotIds,
      );
    }
    if (
      action.name === "vehicle.propose_move"
      || action.name === "vehicle.move_distance"
      || action.name === "vehicle.turn_angle"
    ) {
      const command = normalizeVehicleTask(action);
      if (this.realVehicleEnabled) {
        this.clearPending("被自主任务替换");
        return this.executeVehicleTask(command, requestId);
      }
      this.proposeVehicle(command);
      return `车辆任务“${vehicleTaskLabel(command)}”已创建，等待二次确认；尚未向 Jetson 发送命令。`;
    }
    if (action.name === "vehicle.confirm") {
      return this.executePendingVehicle();
    }
    if (action.name === "vehicle.stop") {
      return this.stopVehicle("语音急停", requestId);
    }
    if (action.name === "vehicle.cancel") {
      this.clearPending("用户取消");
      return "已取消车辆任务。";
    }
    if (action.name === "alerts.begin_processing") {
      if (!this.alertWorkOrderAutomationEnabled) throw new Error("尚未开启 AI 处理告警工单权限");
      const item = beginAndroidAlert(action.arguments.alertId, action.arguments.expectedVersion, "AI 智能中枢");
      return `已开始处理“${item.title}”，Android 本机工单版本为 ${item.version}。`;
    }
    if (action.name === "alerts.complete_work_order") {
      if (!this.alertWorkOrderAutomationEnabled) throw new Error("尚未开启 AI 处理告警工单权限");
      const item = completeAndroidAlert(action.arguments.alertId, action.arguments.expectedVersion, "AI 智能中枢", action.arguments.action, action.arguments.note);
      return `已完成“${item.title}”工单，记录保存在当前 Android 设备。`;
    }
    return this.dispatchAndWait(
      action,
      planId,
      requestId,
      stepIndex,
    );
  }

  private async availabilityForDecision(
    decision: DeepSeekDecision,
    actions: readonly AgentAction[],
  ): Promise<TelemetryAvailabilityDiagnostic | undefined> {
    const query = availabilityQueryForDecision(decision, actions);
    if (!query) return undefined;
    if (
      decision.semantic.primaryEvidence === "spatial-distribution"
      || decision.semantic.primaryEvidence === "inspection-map"
    ) {
      return spatialAvailabilityDiagnostic(
        query,
        this.spatialSampleCounts ?? undefined,
      );
    }
    const history = await historyForAndroid({
      requestId: `availability-${crypto.randomUUID()}`,
      from: query.from,
      to: query.to,
      slotIds: query.slotIds,
      resolution: "raw",
    });
    return history.availability;
  }

  private dispatchAndWait(
    action: AgentAction,
    planId: string,
    requestId: string,
    stepIndex: number,
  ) {
    const actionExecutionId = crypto.randomUUID();
    return new Promise<string | null>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pageActionWaiters.delete(actionExecutionId);
        reject(new Error(
          `页面执行端未就绪，未接收“${actionPublicLabel(action)}”，后续动作已停止`,
        ));
      }, 15_000);
      this.pageActionWaiters.set(actionExecutionId, {
        requestId,
        planId,
        stepIndex,
        actionExecutionId,
        actionName: action.name,
        actionLabel: actionPublicLabel(action),
        actionTimeoutMs: pageActionTimeoutMs(action),
        executionState: "dispatching",
        pageAfterSuccess: action.name === "ui.navigate"
          ? action.arguments.page
          : null,
        resolve,
        reject,
        timer,
      });
      this.send("action.dispatch", {
        action,
        requestId,
        planId,
        stepIndex,
        actionExecutionId,
      });
    });
  }

  private handlePageActionExecutionState(payload: ClientPayload) {
    if (
      typeof payload.actionExecutionId !== "string"
      || !payload.actionExecutionId
      || (
        payload.executionState !== "queued"
        && payload.executionState !== "started"
        && payload.executionState !== "cancelled"
      )
    ) {
      return;
    }
    const waiter = this.pageActionWaiters.get(payload.actionExecutionId);
    if (!waiter) return;
    if (
      payload.requestId !== waiter.requestId
      || payload.planId !== waiter.planId
      || payload.stepIndex !== waiter.stepIndex
      || payload.actionName !== waiter.actionName
    ) {
      return;
    }
    if (payload.executionState === "queued" && waiter.executionState === "started") {
      return;
    }

    window.clearTimeout(waiter.timer);
    if (payload.executionState === "cancelled") {
      this.pageActionWaiters.delete(payload.actionExecutionId);
      waiter.reject(new PagePresentationCancelledError(
        `用户已结束页面讲解，“${waiter.actionLabel}”未继续执行`,
      ));
      return;
    }

    const waitingForGuide = payload.executionState === "queued";
    waiter.executionState = payload.executionState;
    waiter.timer = window.setTimeout(() => {
      if (this.pageActionWaiters.get(payload.actionExecutionId!) !== waiter) return;
      this.pageActionWaiters.delete(payload.actionExecutionId!);
      waiter.reject(new Error(waitingForGuide
        ? `等待用户继续页面讲解超时，“${waiter.actionLabel}”未执行`
        : `等待“${waiter.actionLabel}”真实完成回执超时，后续动作已停止`));
    }, waitingForGuide ? 30 * 60_000 : waiter.actionTimeoutMs);
  }

  private handlePageActionResult(payload: ClientPayload) {
    if (
      typeof payload.actionExecutionId !== "string"
      || !payload.actionExecutionId
    ) {
      return;
    }
    const waiter = this.pageActionWaiters.get(payload.actionExecutionId);
    if (!waiter) return;
    if (
      payload.requestId !== waiter.requestId
      || payload.planId !== waiter.planId
      || payload.stepIndex !== waiter.stepIndex
      || payload.actionName !== waiter.actionName
      || (payload.status !== "success" && payload.status !== "error")
    ) {
      return;
    }
    window.clearTimeout(waiter.timer);
    this.pageActionWaiters.delete(payload.actionExecutionId);
    const message = typeof payload.message === "string"
      && payload.message.trim()
      ? payload.message.trim()
      : payload.status === "success"
        ? `已完成${waiter.actionLabel}`
        : `${waiter.actionLabel}未完成`;
    if (payload.status === "error") {
      waiter.reject(new Error(message));
      return;
    }
    if (waiter.pageAfterSuccess) {
      this.currentPage = waiter.pageAfterSuccess;
    }
    this.appendHistory("action", message);
    waiter.resolve(null);
  }

  private rejectPageActionWaiters(error: Error) {
    for (const waiter of this.pageActionWaiters.values()) {
      window.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pageActionWaiters.clear();
  }

  private proposeVehicle(command: AndroidVehicleTask) {
    this.clearPending("被新任务替换");
    const confirmationId = crypto.randomUUID();
    this.pendingVehicle = {
      confirmationId,
      ...command,
      requestedBy: this.clientId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as PendingVehicleCommand;
    this.pendingTimer = window.setTimeout(() => this.clearPending("确认超时"), 60_000);
    this.send("vehicle.pending", { command: this.pendingVehicle });
  }

  private async confirmVehicle(confirmationId: unknown) {
    const pending = this.pendingVehicle;
    if (!pending || confirmationId !== pending.confirmationId || Date.parse(pending.expiresAt) <= Date.now()) {
      this.clearPending("确认已过期");
      this.send("agent.error", { message: "没有可执行的车辆任务，或确认已经过期" });
      return;
    }
    this.clearPending("已确认");
    try {
      const message = await this.executeVehicleTask(pending, safeRequestId(undefined));
      this.send("voice.state", {
        phase: "speaking",
        reply: message,
        publicAction: null,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.send("agent.error", {
        message: publicError(error, "车辆任务执行失败"),
      });
    }
  }

  private async executePendingVehicle() {
    const pending = this.pendingVehicle;
    if (!pending || Date.parse(pending.expiresAt) <= Date.now()) {
      this.clearPending("确认已过期");
      throw new Error("没有可执行的车辆任务，或确认已经过期");
    }
    this.clearPending("已确认");
    return this.executeVehicleTask(pending, crypto.randomUUID());
  }

  private clearPending(reason: string) {
    if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    if (!this.pendingVehicle) return;
    this.pendingVehicle = null;
    this.send("vehicle.pending", { command: null, reason });
  }

  private async executeCheckpointNavigation(
    checkpointName: string,
    planId: string,
    agentRequestId: string,
  ) {
    if (!this.realVehicleEnabled) {
      throw new Error(
        "当前 Android 设备没有启用 AI 小车控制，未发送导航命令",
      );
    }
    if (!readJetsonSettings().enabled) {
      throw new Error(
        "小车连接已在系统设置中关闭，未发送固定检查点导航命令",
      );
    }
    const context = this.navigationContext;
    if (!context) {
      throw new Error(
        "Android 独立端尚未同步固定检查点，请先打开小车导航页面",
      );
    }
    const checkpoint = findAndroidCheckpoint(context, checkpointName);
    if (!checkpoint) {
      const available = context.checkpoints
        .map((item) => `“${item.name}”`)
        .join("、");
      throw new Error(
        available
          ? `没有找到固定检查点“${checkpointName}”。当前可用检查点：${available}`
          : `没有找到固定检查点“${checkpointName}”。请先在导航地图中创建并命名检查点`,
      );
    }
    if (!context.calibrationConfirmed || !context.pose) {
      throw new Error(
        `固定检查点“${checkpoint.name}”已找到，但小车当前位置尚未标定`,
      );
    }
    if (context.mapRevision === null) {
      throw new Error(
        `固定检查点“${checkpoint.name}”已找到，但 Jetson 导航地图尚未保存或同步`,
      );
    }
    if (context.controlLink && context.controlLink !== "connected") {
      throw new Error(
        `固定检查点“${checkpoint.name}”已找到，但 Jetson 控制链路当前为 ${context.controlLink}`,
      );
    }
    if (
      context.vehicleConnection
      && context.vehicleConnection !== "online"
    ) {
      throw new Error(
        `固定检查点“${checkpoint.name}”已找到，但车辆遥测当前离线`,
      );
    }
    if (context.imuState && context.imuState !== "live") {
      throw new Error(
        `固定检查点“${checkpoint.name}”已找到，但 IMU 当前为 ${context.imuState}，无法确认实时导航姿态`,
      );
    }

    this.completedNavigation = null;
    const deviceRequestId = `android-agent-navigation-${crypto.randomUUID()}`;
    try {
      const execute = (requestId: string, mapRevision: number) => this.jetsonControl.executeNavigation({
        requestId,
        mapRevision,
        start: {
          x: context.pose!.x,
          y: context.pose!.y,
          headingDeg: normalizeMapHeading(context.pose!.headingDeg),
        },
        goal: {
          x: checkpoint.x,
          y: checkpoint.y,
        },
      });
      let effectiveRequestId = deviceRequestId;
      let status;
      try {
        status = await execute(effectiveRequestId, context.mapRevision);
      } catch (error) {
        const currentRevision = androidJetsonNavigationConflictRevision(error);
        if (currentRevision === null || currentRevision === context.mapRevision) throw error;
        this.navigationContext = {
          ...context,
          mapRevision: currentRevision,
          mapObservedAt: new Date().toISOString(),
        };
        effectiveRequestId = `android-agent-navigation-retry-${crypto.randomUUID()}`;
        status = await execute(effectiveRequestId, currentRevision);
      }
      const completedAt = Date.now();
      this.completedNavigation = {
        planId,
        checkpointName: checkpoint.name,
        completedAt,
      };
      const elapsed = finiteRuntimeNumber(status.elapsed_ms);
      const message = `Jetson 已确认到达固定检查点“${checkpoint.name}”（request_id=${effectiveRequestId}`
        + `${elapsed === null ? "" : `，耗时 ${Math.ceil(elapsed / 1_000)}秒`}）。`;
      this.appendHistory("action", message);
      this.send("vehicle.result", {
        ok: true,
        action: "navigation",
        requestId: effectiveRequestId,
        agentRequestId,
        planId,
        deviceState: status.state,
        requestedBy: this.clientId,
        checkpointName: checkpoint.name,
        message,
      });
      return message;
    } catch (error) {
      const message = `前往固定检查点“${checkpoint.name}”未完成：`
        + publicError(error, "Jetson 导航失败");
      this.appendHistory("error", message);
      this.send("vehicle.result", {
        ok: false,
        action: "navigation",
        requestId: deviceRequestId,
        agentRequestId,
        planId,
        requestedBy: this.clientId,
        checkpointName: checkpoint.name,
        message,
      });
      throw new Error(message, { cause: error });
    }
  }

  private async inspectCurrentTelemetry(
    planId: string,
    slotIds?: TelemetrySlotId[],
  ) {
    const completed = this.completedNavigation;
    if (
      !completed
      || completed.planId !== planId
      || Date.now() - completed.completedAt > 5 * 60_000
    ) {
      throw new Error(
        "现场检测必须紧接在同一执行计划中已真实完成的固定检查点导航之后",
      );
    }
    const selected = slotIds?.length
      ? [...new Set(slotIds)]
      : [...TELEMETRY_SLOT_IDS];
    let snapshot: DashboardSnapshot;
    let freshWaitError: AndroidCheckpointInspectionError | null = null;
    try {
      snapshot = await waitForFreshLiveTelemetry({
        completedAtMs: completed.completedAt,
        slotIds: selected,
        readSnapshot: () => this.readTelemetrySnapshot(),
      });
    } catch (error) {
      if (!(error instanceof AndroidCheckpointInspectionError) || !error.lastSnapshot) {
        throw error;
      }
      const hasLatestReading = selected.some((slotId) => {
        const value = error.lastSnapshot?.slots[slotId]?.value;
        return typeof value === "number" && Number.isFinite(value);
      });
      if (!hasLatestReading) throw error;
      snapshot = error.lastSnapshot;
      freshWaitError = error;
    }
    const rules = new Map(
      listAndroidAlertRules().map((rule) => [rule.slotId, rule]),
    );
    const readings: string[] = [];
    const violations: string[] = [];
    const notRefreshed: string[] = [];
    const unavailable: string[] = [];
    let enabledRuleCount = 0;
    for (const slotId of selected) {
      const slot = snapshot.slots[slotId];
      if (!slot) {
        unavailable.push(slotId);
        readings.push(`${slotId}：没有返回数据位`);
        continue;
      }
      const observedAt = slot.observedAt
        ? new Date(slot.observedAt).toLocaleString(
            "zh-CN",
            { hour12: false },
          )
        : "时间未知";
      if (typeof slot.value !== "number" || !Number.isFinite(slot.value)) {
        unavailable.push(slot.label);
        readings.push(`${slot.label}：暂无有效读数（状态 ${slot.state}，数据时间 ${observedAt}）`);
        continue;
      }
      const observedAtMs = Date.parse(slot.observedAt ?? "");
      const freshAfterArrival = slot.state === "live"
        && Number.isFinite(observedAtMs)
        && observedAtMs >= completed.completedAt;
      readings.push(
        `${slot.label}：${formatVehicleNumber(slot.value)}`
        + `${slot.unit}（${slot.state === "live" ? "实时" : slot.state}，数据时间 ${observedAt}`
        + `${freshAfterArrival ? "，到点后新样本" : "，最近有效样本"}）`,
      );
      if (!freshAfterArrival) {
        notRefreshed.push(slot.label);
        continue;
      }
      const rule = rules.get(slotId);
      if (!rule?.enabled) continue;
      enabledRuleCount += 1;
      if (
        rule.lowerLimit !== null
        && slot.value < rule.lowerLimit
      ) {
        violations.push(
          `${slot.label}低于下限 ${formatVehicleNumber(rule.lowerLimit)}`
          + slot.unit,
        );
      }
      if (
        rule.upperLimit !== null
        && slot.value > rule.upperLimit
      ) {
        violations.push(
          `${slot.label}高于上限 ${formatVehicleNumber(rule.upperLimit)}`
          + slot.unit,
        );
      }
    }
    const incomplete = [...unavailable, ...notRefreshed];
    const conclusion = violations.length
      ? `检测结论：到点后新样本中发现 ${violations.length} 项越过当前告警阈值——${violations.join("；")}。`
      : incomplete.length
        ? `检测结论：${incomplete.join("、")} 在等待窗口内没有产生可用于到点判断的新实时样本；以上仅展示最新有效读数，本次不判定为正常或异常。`
        : enabledRuleCount > 0
          ? "检测结论：本次到点后的新鲜实时读数均处于当前启用的告警阈值范围内。"
          : "检测结论：已取得到点后的新鲜实时读数；当前没有启用可用于判定的告警阈值，因此只报告数据，不虚构正常或异常结论。";
    return `到达“${completed.checkpointName}”后已等待传感器产生新样本${freshWaitError ? "（等待窗口内未全部刷新，已保留最新有效读数）" : ""}：`
      + `${readings.join("；")}。${conclusion}`;
  }

  private async executeVehicleTask(
    command: AndroidVehicleTask,
    requestId: string,
  ) {
    try {
      if (command.kind === "timed") {
        const result = await this.jetsonControl.executeTimedMove(
          command.motion,
          command.speedPercent,
          command.durationMs,
        );
        const message = `限时${motionLabel(command.motion)}命令已真实发送（${command.speedPercent}% · ${command.durationMs}ms），Jetson 已确认停车。`;
        this.sendVehicleResult(true, "move", result.requestId, result.stopped, message);
        return message;
      }
      const deviceRequestId = `android-agent-${command.kind}-${crypto.randomUUID()}`;
      const status = await this.jetsonControl.executeClosedLoop(
        command.kind === "distance"
          ? {
              cmd: "move_distance",
              request_id: deviceRequestId,
              direction: command.direction,
              distance_mm: command.distanceMm,
              max_speed_mmps: command.maxSpeedMmps,
              timeout_s: command.timeoutS,
            }
          : {
              cmd: "turn_angle",
              request_id: deviceRequestId,
              direction: command.direction,
              angle_deg: command.angleDeg,
              max_speed_mmps: command.maxSpeedMmps,
              timeout_s: command.timeoutS,
            },
      );
      const message = completedAndroidVehicleMessage(command, status);
      this.sendVehicleResult(true, command.kind, deviceRequestId, status, message);
      return message;
    } catch (error) {
      const message = `${vehicleTaskLabel(command)}未完成：${publicError(error, "Jetson 控制失败")}`;
      this.send("vehicle.result", {
        ok: false,
        action: command.kind === "timed" ? "move" : command.kind,
        requestId,
        requestedBy: this.clientId,
        message,
      });
      throw new Error(message, { cause: error });
    }
  }

  private async stopVehicle(reason: string, requestId?: string) {
    this.clearPending("停止指令");
    try {
      const status = await this.jetsonControl.stop();
      const message = "Jetson 已确认车辆停车。";
      this.sendVehicleResult(
        true,
        "stop",
        status.request_id,
        status,
        `${message.slice(0, -1)}（${reason}）。`,
      );
      return message;
    } catch (error) {
      const message = `未收到 Jetson 停车确认：${publicError(error, "Jetson 控制失败")}`;
      this.appendHistory("error", message);
      this.send("vehicle.result", {
        ok: false,
        action: "stop",
        requestId: requestId ?? null,
        requestedBy: this.clientId,
        message,
      });
      throw new Error(message, { cause: error });
    }
  }

  private sendVehicleResult(
    ok: boolean,
    action: "move" | "distance" | "turn" | "stop",
    requestId: string,
    status: AndroidJetsonControlStatus | AndroidJetsonNavigationStatus,
    message: string,
  ) {
    this.appendHistory(ok ? "action" : "error", message);
    this.send("vehicle.result", {
      ok,
      action,
      requestId,
      deviceState: status.state,
      requestedBy: this.clientId,
      message,
    });
  }

  private async readTelemetrySnapshot() {
    const response = await fetch("/api/iot/snapshot", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(
        `Android 本机遥测读取失败（HTTP ${response.status}）`,
      );
    }
    return response.json() as Promise<DashboardSnapshot>;
  }

  private async telemetrySummary(slotId?: TelemetrySlotId) {
    const snapshot = await this.readTelemetrySnapshot();
    const items = Object.entries(snapshot.slots).filter(([id]) => !slotId || id === slotId);
    if (!items.length) return "没有找到对应数据位。";
    return items.map(([, slot]) => `${slot.label}：${slot.value ?? "暂无"}${slot.value === null ? "" : slot.unit}（${slot.state}）`).join("；");
  }

  private async runtimeContext() {
    let telemetryContext = "当前真实遥测暂时不可用；导航、设置、连接、孪生和车辆等不依赖传感器数值的操作仍可继续。";
    try {
      const snapshot = await this.readTelemetrySnapshot();
      const directory = Object.entries(snapshot.slots)
        .map(([slotId, slot]) => `${slotId}=${slot.label}${slot.unit ? `（${slot.unit}）` : ""}`)
        .join("；");
      telemetryContext = `数据位目录：${directory || "暂无真实数据"}`;
    } catch {
      // Planning must remain available for UI, settings and safety actions when
      // Huawei Cloud is temporarily unreachable.
    }
    const activeAlerts = listAndroidAlerts("runtime", { statuses: ["pending", "processing"], limit: 20 }).items
      .map((item) => ({ id: item.id, version: item.version, status: item.status, slotId: item.slotId, title: item.title }));
    const navigationContext = this.navigationContext
      ? `固定检查点目录：${JSON.stringify(this.navigationContext.checkpoints.map(({ name }) => name))}。`
        + `标定状态：${this.navigationContext.calibrationConfirmed ? "已标定" : "未标定"}；`
        + `当前位置：${this.navigationContext.pose ? JSON.stringify(this.navigationContext.pose) : "暂无"}；`
        + `Jetson 地图修订：${this.navigationContext.mapRevision ?? "暂无"}。`
        + "当前位置中的 headingDeg 是地图绝对航向，任意 0–360° 航向都完全有效；非 0° 不是错误、缺失条件或额外约束，普通定距/定角动作始终按车体当前姿态执行。"
        + "模型只能选择目录中的检查点名称，不得猜测坐标。需要到点测量或检测时，必须在 vehicle.navigate_to_checkpoint 后追加 telemetry.inspect_current。"
      : "固定检查点上下文尚未从本机导航页面同步；不得猜测检查点名称或坐标。";
    return `Android 独立运行；${telemetryContext}。${navigationContext}历史、告警和工单只保存在本设备，与主机分离。Agent 完整应用权限已开启，所有已注册且具备本机执行器的功能动作均可直接调用。当前工单：${JSON.stringify(activeAlerts)}。AI 工单处理权限已开启；AI 自主小车控制权限已开启，车辆通用移动与旋转原语可在同一计划内自主编排并顺序等待真实终态回执。目标屏幕当前位于${pageLabel(this.currentPage)}。可用页面能力包括：站内返回；所有页面的命名区域滚动定位与高亮，以及向上、向下、顶部、底部浏览；监测标签、曲线、时间范围、Flash AI 分析与冻结；小车巡检地图的位置和六路环境图层、起点标定与房间尺寸；孪生视角、显示、点尺寸、面板、缺口、环绕与截图；告警读取与工单处理；连接重检；设置草稿与保存。用户要求查看页面中的具体卡片或区域时使用 ui.focus_region，不能只导航到页面；只说“再往下看”等相对方向时使用 ui.scroll；要求返回时使用 ui.back。若请求的操作就在当前页面完成，不要重复调用 ui.navigate。`;
  }

  private async handleHistory(payload: ClientPayload) {
    const requestId = safeRequestId(payload.requestId);
    try {
      const result = await historyForAndroid({
        requestId,
        from: requiredTime(payload.from),
        to: requiredTime(payload.to),
        slotIds: requiredSlotIds(payload.slotIds),
        ...(isResolution(payload.resolution) ? { resolution: payload.resolution } : {}),
      });
      this.send("telemetry.history.result", { result });
    } catch (error) {
      this.send("telemetry.history.error", { requestId, message: publicError(error, "Android 本机历史读取失败") });
    }
  }

  private async handleEvents(payload: ClientPayload) {
    const requestId = safeRequestId(payload.requestId);
    try {
      const result = await eventsForAndroid({
        requestId,
        from: requiredTime(payload.from),
        to: requiredTime(payload.to),
        ...(Array.isArray(payload.slotIds) ? { slotIds: requiredSlotIds(payload.slotIds, false) } : {}),
      });
      this.send("telemetry.events.result", { result });
    } catch (error) {
      this.send("telemetry.events.error", { requestId, message: publicError(error, "Android 本机事件读取失败") });
    }
  }

  private async handleAnalysis(payload: ClientPayload) {
    const requestId = safeRequestId(payload.requestId);
    let fallback: Awaited<ReturnType<typeof deterministicAnalysisForAndroid>> | null = null;
    try {
      const input = { requestId, from: requiredTime(payload.from), to: requiredTime(payload.to), slotIds: requiredSlotIds(payload.slotIds) };
      this.send("telemetry.analysis.state", { requestId, phase: "loading-data" });
      fallback = await deterministicAnalysisForAndroid(input);
      this.send("telemetry.analysis.state", { requestId, phase: "calculating" });
      if (fallback.status !== "complete" || !readAndroidRuntimeConfig().deepSeekConfigured) {
        this.send("telemetry.analysis.result", { result: fallback });
        return;
      }
      const result = await analyzeTelemetryWithDeepSeek(androidAgentConfig(), fallback, (phase) => {
        this.send("telemetry.analysis.state", { requestId, phase });
      }, {
        thinkingMode: this.thinkingMode,
        reasoningEffort: this.reasoningEffort,
      });
      this.send("telemetry.analysis.result", { result });
    } catch (error) {
      this.send("telemetry.analysis.error", { requestId, message: publicError(error, "AI 建议暂不可用"), ...(fallback ? { fallback } : {}) });
    }
  }

  private handleAlertList(payload: ClientPayload) {
    const requestId = safeRequestId(payload.requestId);
    try {
      this.send("alerts.list.result", { result: listAndroidAlerts(requestId, {
        ...(Array.isArray(payload.statuses) ? { statuses: payload.statuses as never } : {}),
        ...(Array.isArray(payload.severities) ? { severities: payload.severities as never } : {}),
        ...(Array.isArray(payload.slotIds) ? { slotIds: payload.slotIds as TelemetrySlotId[] } : {}),
        ...(payload.from ? { from: payload.from } : {}),
        ...(payload.to ? { to: payload.to } : {}),
        ...(payload.limit ? { limit: payload.limit } : {}),
      }) });
    } catch (error) {
      this.send("alerts.error", { requestId, scope: "list", message: publicError(error, "Android 本机告警读取失败") });
    }
  }

  private handleAlertDetail(payload: ClientPayload) {
    const requestId = safeRequestId(payload.requestId);
    try {
      this.send("alerts.detail.result", { result: { requestId, item: readAndroidAlert(String(payload.alertId ?? "")) } });
    } catch (error) {
      this.send("alerts.error", { requestId, scope: "detail", message: publicError(error, "工单读取失败") });
    }
  }

  private handleAlertBegin(payload: ClientPayload) {
    const requestId = safeRequestId(payload.requestId);
    try {
      const item = beginAndroidAlert(String(payload.alertId ?? ""), Number(payload.expectedVersion), String(payload.actor ?? "Android 用户"));
      this.send("alerts.detail.result", { result: { requestId, item } });
    } catch (error) {
      this.send("alerts.error", { requestId, scope: "detail", message: publicError(error, "工单更新失败") });
    }
  }

  private handleAlertComplete(payload: ClientPayload) {
    const requestId = safeRequestId(payload.requestId);
    try {
      const item = completeAndroidAlert(String(payload.alertId ?? ""), Number(payload.expectedVersion), String(payload.actor ?? "Android 用户"), payload.action as never, String(payload.note ?? ""));
      this.send("alerts.detail.result", { result: { requestId, item } });
    } catch (error) {
      this.send("alerts.error", { requestId, scope: "detail", message: publicError(error, "工单完成失败") });
    }
  }

  private handleRulesSave(payload: ClientPayload) {
    const requestId = safeRequestId(payload.requestId);
    try {
      const rules = saveAndroidAlertRules(Array.isArray(payload.rules) ? payload.rules as ReturnType<typeof listAndroidAlertRules> : []);
      this.send("alerts.rules.result", { result: { requestId, rules, generatedAt: new Date().toISOString() } });
    } catch (error) {
      this.send("alerts.error", { requestId, scope: "rules", message: publicError(error, "告警规则保存失败") });
    }
  }

  private startVoice() {
    const config = readAndroidRuntimeConfig();
    if (!config.asrConfigured) {
      this.send("voice.state", { phase: "error", error: "Android 构建中缺少 Fun-ASR 凭据", updatedAt: new Date().toISOString() });
      return;
    }
    this.finishVoice();
    this.asrSessionId = `asr-${crypto.randomUUID()}`;
    this.partialTranscript = "";
    startNativeAsr(this.asrSessionId);
    this.send("voice.state", { phase: "listening", transcript: "", error: null, updatedAt: new Date().toISOString() });
  }

  private finishVoice() {
    if (!this.asrSessionId) return;
    finishNativeAsr(this.asrSessionId);
  }

  private onAsr = (event: Event) => {
    const detail = (event as CustomEvent<NativeAsrEventDetail>).detail;
    if (!detail || detail.sessionId !== this.asrSessionId) return;
    if (detail.type === "ready") {
      this.send("voice.state", { phase: "listening", updatedAt: new Date().toISOString() });
      return;
    }
    if (detail.type === "partial" || detail.type === "final") {
      this.partialTranscript = detail.text ?? this.partialTranscript;
      this.send("voice.state", { phase: "transcribing", transcript: this.partialTranscript, updatedAt: new Date().toISOString() });
      return;
    }
    if (detail.type === "error") {
      this.asrSessionId = null;
      this.send("voice.state", { phase: "error", error: detail.error ?? "语音识别失败", updatedAt: new Date().toISOString() });
      return;
    }
    const transcript = (detail.text ?? this.partialTranscript).trim();
    this.asrSessionId = null;
    if (transcript) void this.processText(transcript, crypto.randomUUID());
    else this.send("voice.state", { phase: "idle", transcript: "", updatedAt: new Date().toISOString() });
  };

  private onAlertsChanged = () => this.send("alerts.changed", { local: true });

  private onLifecycleStop = () => {
    this.finishVoice();
    if (this.jetsonControl.hasActiveTask) {
      void this.stopVehicle("Android 进入后台").catch(() => undefined);
    }
  };

  private appendHistory(kind: AgentHistoryItem["kind"], text: string) {
    this.history = [{ id: crypto.randomUUID(), kind, text, timestamp: new Date().toISOString() }, ...this.history].slice(0, 120);
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history));
    this.send("agent.history", { items: this.history });
  }

  private send<T>(type: string, payload: T) {
    this.socket?.receive(JSON.stringify(createAgentEnvelope(type, "android-local-gateway", "android-client", payload)));
  }
}

class LocalAgentSocket extends EventTarget {
  readonly url = LOCAL_AGENT_URL;
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  readyState: number = WebSocket.CONNECTING;
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;

  constructor(private readonly runtime: AndroidLocalAgentRuntime) {
    super();
    runtime.connect(this);
    window.setTimeout(() => {
      if (this.readyState !== WebSocket.CONNECTING) return;
      this.readyState = WebSocket.OPEN;
      const event = new Event("open");
      this.dispatchEvent(event);
      this.onopen?.call(this as unknown as WebSocket, event);
    }, 0);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== WebSocket.OPEN) throw new DOMException("WebSocket is not open", "InvalidStateError");
    this.runtime.receive(this, data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    this.runtime.disconnect(this);
    this.readyState = WebSocket.CLOSED;
    const event = new CloseEvent("close", { code, reason, wasClean: true });
    this.dispatchEvent(event);
    this.onclose?.call(this as unknown as WebSocket, event);
  }

  receive(data: string) {
    if (this.readyState !== WebSocket.OPEN) return;
    const event = new MessageEvent("message", { data });
    this.dispatchEvent(event);
    this.onmessage?.call(this as unknown as WebSocket, event);
  }
}

export function installAndroidLocalAgentRuntime() {
  if (!readAndroidRuntimeConfig().android) return;
  const NativeWebSocket = window.WebSocket;
  const runtime = new AndroidLocalAgentRuntime();
  const RoutedWebSocket = function RoutedWebSocket(url: string | URL, protocols?: string | string[]) {
    if (String(url).replace(/\/$/, "") === LOCAL_AGENT_URL) return new LocalAgentSocket(runtime);
    return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
  } as unknown as typeof WebSocket;
  Object.defineProperties(RoutedWebSocket, {
    CONNECTING: { value: NativeWebSocket.CONNECTING },
    OPEN: { value: NativeWebSocket.OPEN },
    CLOSING: { value: NativeWebSocket.CLOSING },
    CLOSED: { value: NativeWebSocket.CLOSED },
  });
  RoutedWebSocket.prototype = NativeWebSocket.prototype;
  Object.defineProperty(window, "WebSocket", { configurable: true, writable: true, value: RoutedWebSocket });
}

function androidAgentConfig(): AgentGatewayConfig {
  const config = readAndroidRuntimeConfig();
  return {
    port: 0,
    deepSeekApiKey: config.deepSeekConfigured ? "android-native-build-config" : "",
    dashScopeApiKey: config.asrConfigured ? "android-native-build-config" : "",
    workspaceId: "android",
    model: "deepseek-v4-flash",
    telemetryAnalysisModel: "deepseek-v4-flash",
    telemetryAnalysisReasoningEffort: "high",
    asrModel: config.asrModel,
    deepSeekBaseUrl: config.deepSeekBaseUrl,
    asrWebSocketUrl: "native://fun-asr",
    iotWebBaseUrl: window.location.origin,
    jetsonWsUrl: readAndroidRuntimeConfig().jetsonWsUrl,
    vehicleEnabled: readJetsonSettings().enabled,
    fullAccess: ANDROID_AGENT_FULL_ACCESS,
    allowLocalAutoPair: true,
    mockMode: false,
    reasoningMode: "always",
  };
}

function normalizeVehicleTask(
  action: Extract<
    AgentAction,
    {
      name:
        | "vehicle.propose_move"
        | "vehicle.move_distance"
        | "vehicle.turn_angle";
    }
  >,
): AndroidVehicleTask {
  if (action.name === "vehicle.propose_move") {
    return {
      kind: "timed",
      motion: action.arguments.motion,
      speedPercent: Math.min(
        100,
        Math.max(1, action.arguments.speedPercent ?? 20),
      ),
      durationMs: Math.max(1, Math.round(action.arguments.durationMs ?? 1_000)),
    };
  }
  if (action.name === "vehicle.move_distance") {
    const maxSpeedMmps = action.arguments.maxSpeedMmps ?? 300;
    return {
      kind: "distance",
      direction: action.arguments.direction,
      distanceMm: action.arguments.distanceMm,
      maxSpeedMmps,
      timeoutS: action.arguments.timeoutS
        ?? defaultAndroidDistanceTimeout(
          action.arguments.distanceMm,
          maxSpeedMmps,
        ),
    };
  }
  const maxSpeedMmps = action.arguments.maxSpeedMmps ?? 300;
  return {
    kind: "turn",
    direction: action.arguments.direction,
    angleDeg: action.arguments.angleDeg,
    maxSpeedMmps,
    timeoutS: action.arguments.timeoutS
      ?? defaultAndroidTurnTimeout(action.arguments.angleDeg),
  };
}

function isVehicleMovementAction(
  action: AgentAction,
): action is Extract<
  AgentAction,
  {
      name:
        | "vehicle.propose_move"
        | "vehicle.move_distance"
        | "vehicle.turn_angle"
        | "vehicle.navigate_to_checkpoint";
  }
> {
  return action.name === "vehicle.propose_move"
    || action.name === "vehicle.move_distance"
    || action.name === "vehicle.turn_angle"
    || action.name === "vehicle.navigate_to_checkpoint";
}

function normalizeMapHeading(value: number) {
  return ((value % 360) + 360) % 360;
}

function vehicleTaskLabel(command: AndroidVehicleTask) {
  if (command.kind === "timed") {
    return `${motionLabel(command.motion)} ${command.speedPercent}% · ${command.durationMs}ms`;
  }
  if (command.kind === "distance") {
    return `${command.direction === "forward" ? "前进" : "后退"} ${formatVehicleNumber(command.distanceMm)}mm`;
  }
  return `${command.direction === "left" ? "左转" : "右转"} ${formatVehicleNumber(command.angleDeg)}°`;
}

function motionLabel(motion: string) {
  return ({
    forward: "前进",
    backward: "后退",
    left: "左转",
    right: "右转",
  } as Record<string, string>)[motion] ?? motion;
}

function formatVehicleNumber(value: number) {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function finiteRuntimeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const HISTORY_RANGE_MS = {
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
} as const;

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

function availabilityQueryForDecision(
  decision: DeepSeekDecision,
  actions: readonly AgentAction[],
  now: Date = new Date(),
) {
  const evidence = [
    decision.semantic.primaryEvidence,
    ...decision.semantic.supportingEvidence,
  ];
  const explicitRange = actions.find(
    (
      action,
    ): action is Extract<AgentAction, { name: "monitoring.set_range" }> => (
      action.name === "monitoring.set_range"
    ),
  )?.arguments.range;
  const needsHistoricalEvidence = evidence.some((item) => (
    HISTORICAL_EVIDENCE.has(item)
  )) || actions.some((action) => action.name === "monitoring.generate_analysis");
  if (!needsHistoricalEvidence) return null;
  const range = decision.semantic.timeRange ?? explicitRange ?? "24h";
  const subjectSlots = decision.semantic.subjects.flatMap((subject) => (
    subject.slotId ? [subject.slotId] : []
  ));
  const actionSlots = actions.flatMap((action): TelemetrySlotId[] => {
    if (action.name === "telemetry.focus") return [action.arguments.slotId];
    if (action.name === "monitoring.generate_analysis") {
      return action.arguments.slotIds ?? [];
    }
    if (
      action.name === "spatial.set_layer"
      && action.arguments.layer !== "position"
    ) {
      return [action.arguments.layer];
    }
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

function replyForAvailability(
  availability: TelemetryAvailabilityDiagnostic | undefined,
) {
  if (!availability || availability.status === "available") return null;
  return `我定位到数据条件问题：${availability.title}。${availability.detail}`;
}

function parseSpatialSampleCounts(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Partial<Record<TelemetrySlotId, number>> = {};
  for (const [slotId, count] of Object.entries(value)) {
    if (
      !(TELEMETRY_SLOT_IDS as readonly string[]).includes(slotId)
      || !Number.isInteger(count)
      || Number(count) < 0
      || Number(count) > 1_000_000
    ) {
      continue;
    }
    result[slotId as TelemetrySlotId] = Number(count);
  }
  return result;
}

function readHistory() {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as AgentHistoryItem[]).slice(0, 120) : [];
  } catch {
    return [];
  }
}

function safeRequestId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : crypto.randomUUID();
}

function requiredTime(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("遥测时间范围无效");
  return new Date(value).toISOString();
}

function requiredSlotIds(value: unknown, required = true) {
  if (!Array.isArray(value) || (required && !value.length)) throw new Error("遥测数据位集合无效");
  const valid = value.filter((item): item is TelemetrySlotId => /^slot-[1-6]$/.test(String(item)));
  if (valid.length !== value.length) throw new Error("遥测数据位集合无效");
  return [...new Set(valid)];
}

function isResolution(value: unknown): value is "raw" | "1m" | "5m" | "1h" {
  return value === "raw" || value === "1m" || value === "5m" || value === "1h";
}

function isUiPage(value: unknown): value is UiPage {
  return value === "overview" || value === "digital-twin" || value === "vehicle" || value === "monitoring" || value === "alerts" || value === "integrations" || value === "settings";
}

function publicError(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
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
    integrations: "接口配置",
    settings: "系统设置",
  } as const)[page];
}

function dataIsBlob(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}
