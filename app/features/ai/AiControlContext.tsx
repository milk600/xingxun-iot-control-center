"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { useNavigationTransition } from "@/app/features/transitions/NavigationTransition";
import { useSpatialMapping } from "@/app/features/spatial/SpatialMappingContext";
import { useIotDashboard } from "@/app/features/iot/use-iot-dashboard";
import { actionPublicLabel, requiredPageForAction } from "@/app/lib/ai/action-registry";
import {
  AI_ACTION_EVENT,
  AI_ACTION_RESULT_EVENT,
  createActionDispatchDetail,
  isActionReceiverReady,
  pageActionTimeoutMs,
  waitForActionReceiver,
} from "@/app/lib/ai/action-events";
import {
  AI_PREFERENCES_EVENT,
  readAiClientPreferences,
  saveAiClientPreferences,
  type AiClientPreferences,
} from "@/app/lib/ai/preferences";
import {
  canBypassEvidenceBarrier,
  describeEvidenceGuide,
  evidenceGuideConclusion,
  evidenceGuideDescriptors,
  retainNonVisualQueuedActions,
  type EvidenceGuideDescriptor,
  type EvidenceGuideState,
} from "@/app/lib/ai/evidence-guide";
import {
  belongsToCurrentAgentRequest,
  clearRetryableAgentRequest,
  createAgentRequestAttempt,
  retryableAgentRequest,
  retryableVoiceInstruction,
  shouldOfferAgentRetry,
  shouldRetryAfterVehiclePendingCleared,
  type RetryableAgentRequest,
} from "@/app/lib/ai/request-retry";
import {
  EMPTY_VOICE_SESSION,
  PAGE_PATHS,
  createAgentEnvelope,
  normalizeAgentReasoningEffort,
  normalizeAgentThinkingMode,
  type AgentAction,
  type AgentActionResultDetail,
  type AgentEnvelope,
  type AgentHistoryItem,
  type AgentNavigationContext,
  type AgentPlan,
  type AgentPlanningTrace,
  type AgentPlanningStageId,
  type AgentReasoningEffort,
  type AgentThinkingMode,
  type PendingVehicleCommand,
  type UiPage,
  type VoiceSessionState,
} from "@/app/lib/ai/contracts";
import type {
  TelemetryAnalysisRequest,
  TelemetryAnalysisResult,
  TelemetryAnalyticsState,
  TelemetryCollectorSettings,
  TelemetryCollectorSettingsState,
  TelemetryEventsRequest,
  TelemetryEventsResult,
  TelemetryHistoryRequest,
  TelemetryHistoryResult,
  TelemetryPollIntervalMs,
} from "@/app/lib/iot/telemetry-history-contracts";
import { TELEMETRY_POLL_INTERVALS } from "@/app/lib/iot/telemetry-history-contracts";
import {
  EMPTY_ALERT_CLIENT_STATE,
  type AlertAction,
  type AlertClearResult,
  type AlertClientState,
  type AlertListFilters,
  type AlertRule,
  type AlertRulesResult,
  type AlertWorkOrder,
} from "@/app/lib/alerts/contracts";
import { TELEMETRY_SLOT_IDS, type TelemetrySlotId } from "@/app/lib/iot/contracts";
import {
  VEHICLE_FIRE_REPORT_TYPE,
  VEHICLE_FIRE_SOURCE,
} from "@/app/lib/iot/fire-detection";

const CLIENT_ID_KEY = "xingxun:ai-client-id";
export const AI_PENDING_ACTION_KEY = "xingxun:ai-pending-action";
export { AI_ACTION_EVENT } from "@/app/lib/ai/action-events";

type ConnectionState = "offline" | "connecting" | "pairing" | "online";

interface AgentExecutionProgress {
  planId: string | null;
  totalSteps: number;
  activeStep: number;
  completedSteps: number;
}

export type AgentPublicPlanningStageId =
  | "intent"
  | "evidence"
  | "destination"
  | "validation"
  | "execution"
  | "ready";

export interface AgentPublicPlanningStage {
  id: AgentPublicPlanningStageId;
  label: string;
  status: AgentPlanningTrace["stages"][number]["status"];
}

export interface AgentPublicPlanningProgress {
  requestId: string;
  progressPercent: number;
  currentStageId: AgentPublicPlanningStageId;
  currentLabel: string;
  currentSummary: string;
  stages: AgentPublicPlanningStage[];
  updatedAt: string;
}

export interface AgentRuntimeProfile {
  model: string;
  reasoningMode: AgentThinkingMode;
  reasoningEffort: AgentReasoningEffort;
  fullAccess: boolean;
}

interface QueuedAgentAction {
  action: AgentAction;
  stepIndex: number;
  generation: number;
  planId: string | null;
  requestId: string | null;
  actionExecutionId: string;
  navigationAttempts: number;
}

interface NavigationWait {
  generation: number;
  planId: string | null;
  targetPath: string;
}

interface AiControlContextValue {
  connection: ConnectionState;
  session: VoiceSessionState;
  preferences: AiClientPreferences;
  history: AgentHistoryItem[];
  plan: AgentPlan | null;
  planningTrace: AgentPlanningTrace | null;
  planningProgress: AgentPublicPlanningProgress | null;
  executionProgress: AgentExecutionProgress;
  evidenceGuide: EvidenceGuideState | null;
  pendingVehicle: PendingVehicleCommand | null;
  isRecording: boolean;
  telemetryAnalytics: TelemetryAnalyticsState;
  collectorSettings: TelemetryCollectorSettingsState;
  alerts: AlertClientState;
  runtimeProfile: AgentRuntimeProfile;
  hasRetryableRequest: boolean;
  canRetryLastRequest: boolean;
  updatePreferences: (value: AiClientPreferences) => void;
  pair: (code: string) => void;
  ask: (text: string) => void;
  retryLastRequest: () => void;
  beginListening: () => Promise<void>;
  endListening: () => void;
  confirmVehicle: () => void;
  cancelVehicle: () => void;
  emergencyStop: () => void;
  continueEvidenceGuide: () => void;
  endEvidenceGuide: () => void;
  requestTelemetryHistory: (input: Omit<TelemetryHistoryRequest, "requestId">) => string | null;
  requestTelemetryEvents: (input: Omit<TelemetryEventsRequest, "requestId">) => string | null;
  requestTelemetryAnalysis: (input: Omit<TelemetryAnalysisRequest, "requestId">) => string | null;
  requestCollectorSettings: () => string | null;
  saveCollectorPollInterval: (pollIntervalMs: TelemetryPollIntervalMs) => string | null;
  showTelemetryEvidence: (slotIds: TelemetrySlotId[]) => void;
  requestAlerts: (filters?: AlertListFilters) => string | null;
  requestAlertDetail: (alertId: string) => string | null;
  beginAlert: (alertId: string, expectedVersion: number, actor: string) => string | null;
  completeAlert: (alertId: string, expectedVersion: number, actor: string, action: AlertAction, note: string) => string | null;
  requestAlertRules: () => string | null;
  saveAlertRules: (rules: AlertRule[], actor: string) => string | null;
  clearAlerts: (actor: string) => string | null;
}

const AiControlContext = createContext<AiControlContextValue | null>(null);

const EMPTY_TELEMETRY_ANALYTICS: TelemetryAnalyticsState = {
  historyPhase: "idle",
  history: null,
  historyError: null,
  eventsPhase: "idle",
  events: null,
  eventsError: null,
  analysisPhase: "idle",
  analysis: null,
  analysisError: null,
};

const EMPTY_COLLECTOR_SETTINGS: TelemetryCollectorSettingsState = {
  phase: "idle",
  settings: null,
  canEdit: false,
  requestId: null,
  error: null,
};

export function AiControlProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { navigate } = useNavigationTransition();
  const { observations, checkpoints, pose, calibrationConfirmed } = useSpatialMapping();
  const { snapshot, navigation } = useIotDashboard();
  const fireDetection = snapshot.vehicle.fireDetection;
  const spatialSampleCounts = useMemo(() => Object.fromEntries(
    TELEMETRY_SLOT_IDS.map((slotId) => [
      slotId,
      observations.reduce((count, observation) => (
        observation.values[slotId] === undefined ? count : count + 1
      ), 0),
    ]),
  ) as Record<TelemetrySlotId, number>, [observations]);
  const navigationContext = useMemo<AgentNavigationContext>(() => ({
    checkpoints: checkpoints.map(({ id, name, x, y, updatedAt }) => ({ id, name, x, y, updatedAt })),
    pose: pose ? {
      x: pose.x,
      y: pose.y,
      headingDeg: ((pose.headingDeg % 360) + 360) % 360,
      observedAt: pose.observedAt,
    } : null,
    calibrationConfirmed,
    mapRevision: navigation?.map?.revision ?? null,
    controlLink: snapshot.vehicle.controlLink,
    vehicleConnection: snapshot.vehicle.connection,
    imuState: snapshot.vehicle.imu?.state ?? null,
    mapObservedAt: navigation?.observedAt ?? null,
    poseObservedAt: pose?.observedAt ?? null,
    updatedAt: new Date().toISOString(),
  }), [
    calibrationConfirmed,
    checkpoints,
    navigation?.map?.revision,
    navigation?.observedAt,
    pose,
    snapshot.vehicle.connection,
    snapshot.vehicle.controlLink,
    snapshot.vehicle.imu?.state,
  ]);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<PcmRecorder | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const listeningIntentRef = useRef(false);
  const pathnameRef = useRef(pathname);
  const [preferences, setPreferences] = useState<AiClientPreferences>(() => readAiClientPreferences());
  const preferencesRef = useRef(preferences);
  const [connection, setConnection] = useState<ConnectionState>("offline");
  const [session, setSession] = useState<VoiceSessionState>(EMPTY_VOICE_SESSION);
  const [history, setHistory] = useState<AgentHistoryItem[]>([]);
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [planningTrace, setPlanningTrace] = useState<AgentPlanningTrace | null>(null);
  const [executionProgress, setExecutionProgress] = useState<AgentExecutionProgress>({
    planId: null,
    totalSteps: 0,
    activeStep: 0,
    completedSteps: 0,
  });
  const [evidenceGuide, setEvidenceGuide] = useState<EvidenceGuideState | null>(null);
  const [pendingVehicle, setPendingVehicle] = useState<PendingVehicleCommand | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [pageActionActive, setPageActionActive] = useState(false);
  const [telemetryAnalytics, setTelemetryAnalytics] = useState<TelemetryAnalyticsState>(EMPTY_TELEMETRY_ANALYTICS);
  const [collectorSettings, setCollectorSettings] = useState<TelemetryCollectorSettingsState>(EMPTY_COLLECTOR_SETTINGS);
  const [alerts, setAlerts] = useState<AlertClientState>(EMPTY_ALERT_CLIENT_STATE);
  const [requestInFlight, setRequestInFlight] = useState(false);
  const [retryableRequest, setRetryableRequest] = useState<RetryableAgentRequest | null>(null);
  const [runtimeProfile, setRuntimeProfile] = useState<AgentRuntimeProfile>({
    model: "deepseek-v4-flash",
    reasoningMode: "thinking",
    reasoningEffort: "high",
    fullAccess: false,
  });
  const clientIdRef = useRef("");
  const actionQueueRef = useRef<QueuedAgentAction[]>([]);
  const actionRunningRef = useRef(false);
  const activeActionRef = useRef<QueuedAgentAction | null>(null);
  const actionTimerRef = useRef<number | null>(null);
  const executionGenerationRef = useRef(0);
  const activePlanIdRef = useRef<string | null>(null);
  const planRef = useRef<AgentPlan | null>(null);
  const evidenceGuideDescriptorsRef = useRef<EvidenceGuideDescriptor[]>([]);
  const evidenceGuidePausedRef = useRef(false);
  const evidenceGuideTransitionSequenceRef = useRef(0);
  const deferredSpeechRef = useRef<{ text: string; enabled: boolean } | null>(null);
  const speakRef = useRef<(text: string) => void>(() => undefined);
  const nextPlanSearchIndexRef = useRef(0);
  const planningRequestIdRef = useRef("");
  const lastUserRequestRef = useRef("");
  const requestInFlightRef = useRef(false);
  const retryableRequestRef = useRef<RetryableAgentRequest | null>(null);
  const requestInstructionsRef = useRef(new Map<string, string>());
  const pendingVehicleRequestIdRef = useRef<string | null>(null);
  const historyRequestIdRef = useRef("");
  const eventsRequestIdRef = useRef("");
  const analysisRequestIdRef = useRef("");
  const collectorSettingsRequestIdRef = useRef("");
  const alertListRequestIdRef = useRef("");
  const alertDetailRequestIdRef = useRef("");
  const alertRulesRequestIdRef = useRef("");
  const alertClearRequestIdRef = useRef("");
  const alertFiltersRef = useRef<AlertListFilters>({});
  const navigationWaitingRef = useRef(false);
  const navigationWaitRef = useRef<NavigationWait | null>(null);
  const navigationFallbackRef = useRef<number | null>(null);
  const drainActionQueueRef = useRef<() => void>(() => undefined);
  const telemetryAnalyticsRef = useRef(telemetryAnalytics);
  const collectorSettingsRef = useRef(collectorSettings);
  const alertsRef = useRef(alerts);
  const spatialSampleCountsRef = useRef(spatialSampleCounts);
  const navigationContextRef = useRef(navigationContext);
  const reportedFireStateRef = useRef<boolean | null>(null);

  useEffect(() => { pathnameRef.current = pathname; }, [pathname]);
  useEffect(() => { preferencesRef.current = preferences; }, [preferences]);
  useEffect(() => { telemetryAnalyticsRef.current = telemetryAnalytics; }, [telemetryAnalytics]);
  useEffect(() => { collectorSettingsRef.current = collectorSettings; }, [collectorSettings]);
  useEffect(() => { alertsRef.current = alerts; }, [alerts]);
  useEffect(() => { spatialSampleCountsRef.current = spatialSampleCounts; }, [spatialSampleCounts]);
  useEffect(() => { navigationContextRef.current = navigationContext; }, [navigationContext]);
  const nativeRecordingActive = isRecording || session.phase === "listening";
  const nativePlanningActive = session.phase === "understanding"
    || Boolean(planningTrace?.stages.some((stage) => stage.status === "active"));
  const nativeExecutingActive = pageActionActive || session.phase === "executing";
  const nativeVehicleActive = Boolean(pendingVehicle)
    || (
      nativeExecutingActive
      && Boolean(plan?.steps.some((step) => step.action.name.startsWith("vehicle.")))
    );
  useEffect(() => {
    setNativeAgentActivity("recording", nativeRecordingActive);
    return () => setNativeAgentActivity("recording", false);
  }, [nativeRecordingActive]);
  useEffect(() => {
    setNativeAgentActivity("planning", nativePlanningActive);
    return () => setNativeAgentActivity("planning", false);
  }, [nativePlanningActive]);
  useEffect(() => {
    setNativeAgentActivity("executing", nativeExecutingActive);
    return () => setNativeAgentActivity("executing", false);
  }, [nativeExecutingActive]);
  useEffect(() => {
    setNativeAgentActivity("vehicle", nativeVehicleActive);
    return () => setNativeAgentActivity("vehicle", false);
  }, [nativeVehicleActive]);
  useEffect(() => {
    const currentPlan = planRef.current;
    if (!currentPlan) return;
    setEvidenceGuide((current) => {
      if (!current || current.phase !== "presenting") return current;
      const descriptor = evidenceGuideDescriptorsRef.current.find((item) => item.stepIndex === current.stepIndex);
      if (!descriptor) return current;
      const evidence = describeEvidenceGuide(descriptor, currentPlan, telemetryAnalytics);
      return {
        ...current,
        ...evidence,
        conclusion: descriptor.position >= descriptor.total
          ? evidenceGuideConclusion(currentPlan, telemetryAnalytics, descriptor.position)
          : null,
      };
    });
  }, [telemetryAnalytics]);

  const send = useCallback((type: string, payload: unknown) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(createAgentEnvelope(type, clientIdRef.current, "gateway", payload)));
    return true;
  }, []);

  const updateRequestInFlight = useCallback((active: boolean) => {
    requestInFlightRef.current = active;
    setRequestInFlight(active);
  }, []);

  const rememberRequestInstruction = useCallback((requestId: string, instruction: string) => {
    const retryable = retryableAgentRequest(requestId, instruction);
    if (!retryable) return;
    requestInstructionsRef.current.delete(retryable.requestId);
    requestInstructionsRef.current.set(retryable.requestId, retryable.instruction);
    while (requestInstructionsRef.current.size > 32) {
      const oldestRequestId = requestInstructionsRef.current.keys().next().value;
      if (typeof oldestRequestId !== "string") break;
      requestInstructionsRef.current.delete(oldestRequestId);
    }
  }, []);

  const replaceRetryableRequest = useCallback((next: RetryableAgentRequest | null) => {
    retryableRequestRef.current = next;
    setRetryableRequest(next);
  }, []);

  const markRequestRetryable = useCallback((requestId?: string | null) => {
    const targetRequestId = requestId?.trim() || planningRequestIdRef.current;
    const instruction = requestInstructionsRef.current.get(targetRequestId)
      ?? (targetRequestId === planningRequestIdRef.current ? lastUserRequestRef.current : "");
    const retryable = retryableAgentRequest(targetRequestId, instruction);
    if (retryable) replaceRetryableRequest(retryable);
    if (!requestId || targetRequestId === planningRequestIdRef.current) {
      updateRequestInFlight(false);
    }
  }, [replaceRetryableRequest, updateRequestInFlight]);

  const clearRequestRetryable = useCallback((successfulRequestId: string) => {
    const next = clearRetryableAgentRequest(
      retryableRequestRef.current,
      successfulRequestId,
    );
    if (next !== retryableRequestRef.current) replaceRetryableRequest(next);
  }, [replaceRetryableRequest]);

  useEffect(() => {
    if (connection !== "online") {
      reportedFireStateRef.current = null;
      return;
    }
    const fire = fireDetection;
    if (
      fire.state !== "live"
      || fire.detected === null
      || !fire.observedAt
      || reportedFireStateRef.current === fire.detected
    ) return;
    if (send(VEHICLE_FIRE_REPORT_TYPE, {
      detected: fire.detected,
      observedAt: fire.observedAt,
      source: VEHICLE_FIRE_SOURCE,
    })) {
      reportedFireStateRef.current = fire.detected;
    }
  }, [
    connection,
    send,
    fireDetection,
  ]);

  const invalidateExecution = useCallback(() => {
    executionGenerationRef.current += 1;
    if (actionTimerRef.current !== null) window.clearTimeout(actionTimerRef.current);
    if (navigationFallbackRef.current !== null) window.clearTimeout(navigationFallbackRef.current);
    actionTimerRef.current = null;
    navigationFallbackRef.current = null;
    navigationWaitingRef.current = false;
    navigationWaitRef.current = null;
    actionRunningRef.current = false;
    activeActionRef.current = null;
    actionQueueRef.current = [];
    activePlanIdRef.current = null;
    setPageActionActive(false);
    return executionGenerationRef.current;
  }, []);

  const settleActionExecution = useCallback((result: AgentActionResultDetail) => {
    const queued = activeActionRef.current;
    if (
      !queued
      || queued.actionExecutionId !== result.actionExecutionId
      || queued.action.name !== result.actionName
      || queued.requestId !== result.requestId
      || queued.planId !== result.planId
      || queued.stepIndex !== result.stepIndex
      || queued.generation !== executionGenerationRef.current
      || (queued.planId && queued.planId !== activePlanIdRef.current)
    ) return;

    if (actionTimerRef.current !== null) window.clearTimeout(actionTimerRef.current);
    actionTimerRef.current = null;
    activeActionRef.current = null;
    actionRunningRef.current = false;
    setPageActionActive(false);
    send("action.result", result);

    if (result.status === "error") {
      markRequestRetryable();
      actionQueueRef.current = [];
      evidenceGuidePausedRef.current = false;
      setEvidenceGuide(null);
      setExecutionProgress((current) => ({ ...current, activeStep: 0 }));
      setSession((current) => ({
        ...current,
        phase: "error",
        publicAction: null,
        error: `${actionPublicLabel(queued.action)}未完成：${result.message}`,
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    if (queued.stepIndex > 0) {
      setExecutionProgress((current) => ({
        ...current,
        activeStep: 0,
        completedSteps: Math.max(current.completedSteps, queued.stepIndex),
      }));
    }
    const currentPlan = planRef.current;
    const descriptor = evidenceGuideDescriptorsRef.current.find(
      (item) => item.stepIndex === queued.stepIndex,
    );
    if (descriptor && currentPlan) {
      const evidence = describeEvidenceGuide(
        descriptor,
        currentPlan,
        telemetryAnalyticsRef.current,
      );
      const finalEvidence = descriptor.position >= descriptor.total;
      evidenceGuidePausedRef.current = true;
      setEvidenceGuide({
        ...descriptor,
        ...evidence,
        phase: "presenting",
        conclusion: finalEvidence
          ? evidenceGuideConclusion(
            currentPlan,
            telemetryAnalyticsRef.current,
            descriptor.position,
          )
          : null,
      });
    }
    drainActionQueueRef.current();
  }, [markRequestRetryable, send]);

  const drainActionQueue = useCallback(() => {
    if (actionRunningRef.current || navigationWaitingRef.current) return;
    const queueIndex = evidenceGuidePausedRef.current
      ? actionQueueRef.current.findIndex((item) => canBypassEvidenceBarrier(item.action))
      : 0;
    if (queueIndex < 0) return;
    const queued = actionQueueRef.current[queueIndex];
    if (!queued) return;
    const {
      action,
      stepIndex,
      generation,
      planId,
      requestId,
      actionExecutionId,
    } = queued;
    if (generation !== executionGenerationRef.current || (planId && planId !== activePlanIdRef.current)) {
      actionQueueRef.current.splice(queueIndex, 1);
      window.requestAnimationFrame(() => drainActionQueueRef.current());
      return;
    }
    const requiredPage = requiredPageForAction(action);
    const pathForAction = requiredPage ? PAGE_PATHS[requiredPage] : null;

    if (pathForAction && pathnameRef.current !== pathForAction) {
      queued.navigationAttempts += 1;
      navigationWaitingRef.current = true;
      navigationWaitRef.current = { generation, planId, targetPath: pathForAction };
      navigate(pathForAction);
      navigationFallbackRef.current = window.setTimeout(() => {
        const wait = navigationWaitRef.current;
        if (!wait || wait.generation !== generation || wait.planId !== planId || wait.targetPath !== pathForAction) return;
        navigationFallbackRef.current = null;
        navigationWaitingRef.current = false;
        navigationWaitRef.current = null;
        if (generation !== executionGenerationRef.current || (planId && planId !== activePlanIdRef.current)) return;
        if (pathnameRef.current === pathForAction || queued.navigationAttempts < 2) {
          drainActionQueueRef.current();
          return;
        }
        actionQueueRef.current = [];
        evidenceGuidePausedRef.current = false;
        setEvidenceGuide(null);
        const result: AgentActionResultDetail = {
          requestId,
          planId,
          stepIndex,
          actionExecutionId,
          actionName: action.name,
          status: "error",
          message: "无法打开目标页面，后续页面动作已停止。",
          completedAt: new Date().toISOString(),
        };
        send("action.result", result);
        markRequestRetryable();
        setSession((current) => ({
          ...current,
          phase: "error",
          publicAction: null,
          error: "无法打开目标页面，已停止后续界面操作。",
          updatedAt: new Date().toISOString(),
        }));
      }, 2400);
      return;
    }

    if (requiredPage && !isActionReceiverReady(action.name)) {
      navigationWaitingRef.current = true;
      const receiverWaitMs = Math.min(
        3_000,
        Math.max(800, pageActionTimeoutMs(action) - 2_000),
      );
      void waitForActionReceiver(action.name, receiverWaitMs).then((ready) => {
        if (
          generation !== executionGenerationRef.current
          || (planId && planId !== activePlanIdRef.current)
        ) return;
        navigationWaitingRef.current = false;
        if (ready) {
          drainActionQueueRef.current();
          return;
        }
        const pendingIndex = actionQueueRef.current.findIndex(
          (item) => item.actionExecutionId === actionExecutionId,
        );
        if (pendingIndex < 0) return;
        actionQueueRef.current.splice(pendingIndex, 1);
        actionRunningRef.current = true;
        activeActionRef.current = queued;
        setPageActionActive(true);
        settleActionExecution({
          requestId,
          planId,
          stepIndex,
          actionExecutionId,
          actionName: action.name,
          status: "error",
          message: `目标页面尚未完成动作接收器挂载，“${actionPublicLabel(action)}”未执行。`,
          completedAt: new Date().toISOString(),
        });
      });
      return;
    }

    actionQueueRef.current.splice(queueIndex, 1);
    actionRunningRef.current = true;
    activeActionRef.current = queued;
    setPageActionActive(true);
    send("action.execution-state", {
      requestId,
      planId,
      stepIndex,
      actionExecutionId,
      actionName: action.name,
      executionState: "started",
    });
    if (stepIndex > 0) {
      setExecutionProgress((current) => ({
        ...current,
        activeStep: stepIndex,
        completedSteps: Math.max(current.completedSteps, stepIndex - 1),
      }));
    }
    actionTimerRef.current = window.setTimeout(() => {
      actionTimerRef.current = null;
      settleActionExecution({
        requestId,
        planId,
        stepIndex,
        actionExecutionId,
        actionName: action.name,
        status: "error",
        message: `等待“${actionPublicLabel(action)}”真实完成回执超时。`,
        completedAt: new Date().toISOString(),
      });
    }, pageActionTimeoutMs(action));
    try {
      window.dispatchEvent(new CustomEvent(AI_ACTION_EVENT, {
        detail: createActionDispatchDetail(action, {
          requestId,
          planId,
          stepIndex,
          actionExecutionId,
        }),
      }));
    } catch (error) {
      settleActionExecution({
        requestId,
        planId,
        stepIndex,
        actionExecutionId,
        actionName: action.name,
        status: "error",
        message: error instanceof Error ? error.message : "页面动作派发失败。",
        completedAt: new Date().toISOString(),
      });
    }
  }, [markRequestRetryable, navigate, send, settleActionExecution]);
  drainActionQueueRef.current = drainActionQueue;

  const enqueueAction = useCallback((
    action: AgentAction,
    stepIndex = 0,
    planId: string | null = activePlanIdRef.current,
    requestId: string | null = planningRequestIdRef.current || null,
    actionExecutionId = createClientActionExecutionId(),
  ) => {
    actionQueueRef.current.push({
      action,
      stepIndex,
      generation: executionGenerationRef.current,
      planId,
      requestId,
      actionExecutionId,
      navigationAttempts: 0,
    });
    drainActionQueueRef.current();
  }, []);

  useEffect(() => {
    const handleResult = (event: Event) => {
      const result = (event as CustomEvent<AgentActionResultDetail>).detail;
      if (
        !result
        || typeof result.actionExecutionId !== "string"
        || (result.status !== "success" && result.status !== "error")
      ) return;
      settleActionExecution(result);
    };
    window.addEventListener(AI_ACTION_RESULT_EVENT, handleResult);
    return () => window.removeEventListener(AI_ACTION_RESULT_EVENT, handleResult);
  }, [settleActionExecution]);

  const speak = useCallback((text: string) => {
    if (!preferencesRef.current.voicePlaybackEnabled || !text || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 1.02;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  }, []);
  speakRef.current = speak;

  useEffect(() => {
    clientIdRef.current = window.localStorage.getItem(CLIENT_ID_KEY) || `client-${crypto.randomUUID()}`;
    window.localStorage.setItem(CLIENT_ID_KEY, clientIdRef.current);
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const prefs = preferencesRef.current;
      setConnection("connecting");
      let socket: WebSocket;
      try { socket = new WebSocket(prefs.gatewayUrl); } catch {
        setConnection("offline");
        return;
      }
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      socket.onopen = () => {
        socket.send(JSON.stringify(createAgentEnvelope("client.hello", clientIdRef.current, "gateway", {
          role: prefs.clientRole,
          name: prefs.clientRole === "remote" ? "安卓语音遥控器" : "电脑显示端",
          token: prefs.pairingToken,
          realVehicleEnabled: prefs.realVehicleEnabled,
          alertWorkOrderAutomationEnabled: prefs.alertWorkOrderAutomationEnabled,
          thinkingMode: prefs.thinkingMode,
          reasoningEffort: prefs.reasoningEffort,
          page: pageFromPath(pathnameRef.current),
          spatialSampleCounts: spatialSampleCountsRef.current,
          navigationContext: navigationContextRef.current,
        })));
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let message: AgentEnvelope<string, Record<string, unknown>>;
        try { message = JSON.parse(event.data) as AgentEnvelope<string, Record<string, unknown>>; } catch { return; }
        const payload = message.payload ?? {};
        const messageRequestId = typeof payload.requestId === "string" ? payload.requestId : "";
        const belongsToCurrentPlanningRequest = belongsToCurrentAgentRequest(
          planningRequestIdRef.current,
          messageRequestId,
        );
        if (message.type === "gateway.pairing-required") { setConnection("pairing"); return; }
        if (message.type === "pair.accepted") {
          const token = typeof payload.token === "string" ? payload.token : "";
          if (token) {
            const next = { ...preferencesRef.current, pairingToken: token };
            setPreferences(next); preferencesRef.current = next; saveAiClientPreferences(next);
            socket.send(JSON.stringify(createAgentEnvelope("client.hello", clientIdRef.current, "gateway", {
              role: next.clientRole, name: next.clientRole === "remote" ? "安卓语音遥控器" : "电脑显示端",
              token,
              realVehicleEnabled: next.realVehicleEnabled,
              alertWorkOrderAutomationEnabled: next.alertWorkOrderAutomationEnabled,
              thinkingMode: next.thinkingMode,
              reasoningEffort: next.reasoningEffort,
              page: pageFromPath(pathnameRef.current),
              spatialSampleCounts: spatialSampleCountsRef.current,
              navigationContext: navigationContextRef.current,
            })));
          }
          setConnection("online");
          return;
        }
        if (message.type === "gateway.ready") {
          setConnection("online");
          setRuntimeProfile({
            model: typeof payload.model === "string" ? payload.model : "deepseek-v4-flash",
            reasoningMode: normalizeAgentThinkingMode(payload.reasoningMode),
            reasoningEffort: normalizeAgentReasoningEffort(payload.reasoningEffort),
            fullAccess: payload.fullAccess === true,
          });
          return;
        }
        if (message.type === "telemetry.collector.settings.result" && payload.settings) {
          const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
          if (requestId && requestId !== collectorSettingsRequestIdRef.current) return;
          const settings = parseCollectorSettingsPayload(payload.settings);
          if (!settings) return;
          const next: TelemetryCollectorSettingsState = {
            phase: "ready",
            settings,
            canEdit: payload.canEdit === true,
            requestId: requestId || null,
            error: null,
          };
          collectorSettingsRef.current = next;
          setCollectorSettings(next);
          return;
        }
        if (message.type === "telemetry.collector.settings.changed" && payload.settings) {
          const settings = parseCollectorSettingsPayload(payload.settings);
          if (!settings) return;
          const next: TelemetryCollectorSettingsState = {
            phase: "ready",
            settings,
            canEdit: payload.canEdit === true,
            requestId: null,
            error: null,
          };
          collectorSettingsRef.current = next;
          setCollectorSettings(next);
          return;
        }
        if (message.type === "telemetry.collector.settings.error") {
          const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
          if (requestId && requestId !== collectorSettingsRequestIdRef.current) return;
          setCollectorSettings((current) => {
            const next: TelemetryCollectorSettingsState = {
              ...current,
              phase: "error",
              requestId: requestId || current.requestId,
              error: typeof payload.message === "string" ? payload.message : "华为云读取设置保存失败",
            };
            collectorSettingsRef.current = next;
            return next;
          });
          return;
        }
        if (message.type === "voice.state") {
          if (!belongsToCurrentPlanningRequest) return;
          const nextPhase = isVoicePhase(payload.phase) ? payload.phase : null;
          const retryableInstruction = retryableVoiceInstruction(nextPhase, payload.transcript);
          if (retryableInstruction) {
            if (!messageRequestId) return;
            planningRequestIdRef.current = messageRequestId;
            lastUserRequestRef.current = retryableInstruction;
            rememberRequestInstruction(messageRequestId, retryableInstruction);
            updateRequestInFlight(true);
          }
          if (nextPhase === "error") markRequestRetryable(messageRequestId);
          setSession((current) => ({
            ...current,
            phase: nextPhase ?? current.phase,
            transcript: typeof payload.transcript === "string" ? payload.transcript : current.transcript,
            reply: typeof payload.reply === "string" ? payload.reply : current.reply,
            publicAction: typeof payload.publicAction === "string" ? payload.publicAction : payload.publicAction === null ? null : current.publicAction,
            error: typeof payload.error === "string" ? payload.error : payload.error === null ? null : current.error,
            updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : new Date().toISOString(),
          }));
          return;
        }
        if (message.type === "vehicle.result") {
          if (payload.requestedBy !== clientIdRef.current) return;
          const resultRequestId = typeof payload.agentRequestId === "string"
            ? payload.agentRequestId
            : null;
          const resultPlanId = typeof payload.planId === "string" ? payload.planId : null;
          const currentRequestId = planningRequestIdRef.current || null;
          const currentPlanId = activePlanIdRef.current;
          if (
            (resultRequestId && resultRequestId !== currentRequestId)
            || (resultPlanId && resultPlanId !== currentPlanId)
            || (!resultRequestId && currentRequestId)
            || (!resultPlanId && currentPlanId)
          ) {
            // The vehicle transport keeps its own state, but a late result must
            // never overwrite the conversation for a newer Agent request.
            return;
          }
          const resultMessage = typeof payload.message === "string" ? payload.message : "车辆控制结果未知";
          const resultStepIndex = Number.isSafeInteger(payload.stepIndex)
            ? Number(payload.stepIndex)
            : 0;
          if (payload.ok === true) {
            if (resultStepIndex > 0) {
              setExecutionProgress((current) => ({
                ...current,
                activeStep: 0,
                completedSteps: Math.max(current.completedSteps, resultStepIndex),
              }));
            }
            setSession((current) => ({
              ...current,
              phase: "speaking",
              reply: resultMessage,
              error: null,
              publicAction: null,
              updatedAt: new Date().toISOString(),
            }));
          } else {
            markRequestRetryable(resultRequestId);
            setSession((current) => ({
              ...current,
              phase: "error",
              error: resultMessage,
              publicAction: null,
              updatedAt: new Date().toISOString(),
            }));
          }
          return;
        }
        if (message.type === "agent.reply") {
          if (!belongsToCurrentPlanningRequest) return;
          const text = typeof payload.text === "string" ? payload.text : "";
          updateRequestInFlight(false);
          clearRequestRetryable(messageRequestId);
          setSession((current) => ({ ...current, reply: text, error: null }));
          if (planRef.current && nextPlanSearchIndexRef.current === 0) {
            setExecutionProgress((current) => ({
              ...current,
              activeStep: 0,
              completedSteps: current.totalSteps,
            }));
          }
          if (evidenceGuideDescriptorsRef.current.length >= 1) {
            deferredSpeechRef.current = { text, enabled: payload.speak === true };
          } else if (payload.speak === true) {
            speak(text);
          }
          return;
        }
        if (message.type === "agent.error") {
          if (!belongsToCurrentPlanningRequest) return;
          const error = typeof payload.message === "string" ? payload.message : "智能中枢发生错误";
          markRequestRetryable(messageRequestId);
          setSession((current) => ({ ...current, phase: "error", error, updatedAt: new Date().toISOString() }));
          return;
        }
        if (message.type === "agent.cancelled") {
          markRequestRetryable(messageRequestId);
          if (!belongsToCurrentPlanningRequest) return;
          invalidateExecution();
          planRef.current = null;
          evidenceGuideDescriptorsRef.current = [];
          evidenceGuidePausedRef.current = false;
          evidenceGuideTransitionSequenceRef.current += 1;
          deferredSpeechRef.current = null;
          setPlan(null);
          setEvidenceGuide(null);
          setExecutionProgress({ planId: null, totalSteps: 0, activeStep: 0, completedSteps: 0 });
          setSession((current) => ({
            ...current,
            phase: "idle",
            reply: typeof payload.message === "string" ? payload.message : "上一项任务已停止。",
            publicAction: null,
            error: null,
            updatedAt: new Date().toISOString(),
          }));
          return;
        }
        if (message.type === "agent.plan" && payload.plan) {
          const nextPlan = payload.plan as unknown as AgentPlan;
          if (
            planningRequestIdRef.current
            && nextPlan.requestId !== planningRequestIdRef.current
          ) return;
          invalidateExecution();
          activePlanIdRef.current = nextPlan.id;
          planRef.current = nextPlan;
          evidenceGuideDescriptorsRef.current = evidenceGuideDescriptors(nextPlan);
          evidenceGuidePausedRef.current = false;
          evidenceGuideTransitionSequenceRef.current += 1;
          deferredSpeechRef.current = null;
          setEvidenceGuide(null);
          nextPlanSearchIndexRef.current = 0;
          setExecutionProgress({
            planId: nextPlan.id,
            totalSteps: nextPlan.steps.length,
            activeStep: 0,
            completedSteps: 0,
          });
          setPlan(nextPlan);
          return;
        }
        if (message.type === "agent.trace" && payload.trace) {
          const nextTrace = payload.trace as unknown as AgentPlanningTrace;
          if (typeof nextTrace.requestId !== "string" || !Array.isArray(nextTrace.stages)) return;
          if (
            planningRequestIdRef.current
            && planningRequestIdRef.current !== nextTrace.requestId
          ) return;
          if (planningRequestIdRef.current !== nextTrace.requestId) {
            planningRequestIdRef.current = nextTrace.requestId;
            invalidateExecution();
            planRef.current = null;
            evidenceGuideDescriptorsRef.current = [];
            evidenceGuidePausedRef.current = false;
            evidenceGuideTransitionSequenceRef.current += 1;
            deferredSpeechRef.current = null;
            setEvidenceGuide(null);
            nextPlanSearchIndexRef.current = 0;
            setExecutionProgress({ planId: null, totalSteps: 0, activeStep: 0, completedSteps: 0 });
            setPlan(null);
          }
          setPlanningTrace(nextTrace);
          return;
        }
        if (message.type === "action.dispatch" && payload.action) {
          if (!belongsToCurrentPlanningRequest) return;
          const action = payload.action as AgentAction;
          const dispatchedPlanId = typeof payload.planId === "string" ? payload.planId : null;
          if (dispatchedPlanId && dispatchedPlanId !== activePlanIdRef.current) return;
          const steps = planRef.current?.steps ?? [];
          let stepIndex = Number.isSafeInteger(payload.stepIndex)
            ? Number(payload.stepIndex)
            : 0;
          if (stepIndex <= 0) {
            for (let index = nextPlanSearchIndexRef.current; index < steps.length; index += 1) {
              if (!sameAgentAction(steps[index].action, action)) continue;
              stepIndex = steps[index].index;
              nextPlanSearchIndexRef.current = index + 1;
              break;
            }
          }
          const dispatchedRequestId = typeof payload.requestId === "string"
            ? payload.requestId
            : payload.requestId === null
              ? null
              : planningRequestIdRef.current || null;
          const actionExecutionId = typeof payload.actionExecutionId === "string"
            && payload.actionExecutionId.trim()
            ? payload.actionExecutionId
            : createClientActionExecutionId();
          send("action.execution-state", {
            requestId: dispatchedRequestId,
            planId: dispatchedPlanId,
            stepIndex,
            actionExecutionId,
            actionName: action.name,
            executionState: "queued",
          });
          enqueueAction(
            action,
            stepIndex,
            dispatchedPlanId,
            dispatchedRequestId,
            actionExecutionId,
          );
          return;
        }
        if (message.type === "agent.history" && Array.isArray(payload.items)) {
          setHistory(payload.items as unknown as AgentHistoryItem[]);
          return;
        }
        if (message.type === "telemetry.history.result" && payload.result) {
          const result = payload.result as unknown as TelemetryHistoryResult;
          if (!result.requestId || result.requestId !== historyRequestIdRef.current) return;
          setTelemetryAnalytics((current) => ({
            ...current,
            historyPhase: "ready",
            history: result,
            historyError: null,
          }));
          return;
        }
        if (message.type === "telemetry.history.error") {
          const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
          if (requestId && requestId !== historyRequestIdRef.current) return;
          setTelemetryAnalytics((current) => ({
            ...current,
            historyPhase: "error",
            historyError: typeof payload.message === "string" ? payload.message : "历史数据读取失败",
          }));
          return;
        }
        if (message.type === "telemetry.events.result" && payload.result) {
          const result = payload.result as unknown as TelemetryEventsResult;
          if (!result.requestId || result.requestId !== eventsRequestIdRef.current) return;
          setTelemetryAnalytics((current) => ({
            ...current,
            eventsPhase: "ready",
            events: result,
            eventsError: null,
          }));
          return;
        }
        if (message.type === "telemetry.events.error") {
          const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
          if (requestId && requestId !== eventsRequestIdRef.current) return;
          setTelemetryAnalytics((current) => ({
            ...current,
            eventsPhase: "error",
            eventsError: typeof payload.message === "string" ? payload.message : "事件记录读取失败",
          }));
          return;
        }
        if (message.type === "telemetry.analysis.state") {
          const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
          if (requestId && requestId !== analysisRequestIdRef.current) return;
          const phase = payload.phase === "calculating" || payload.phase === "analyzing" || payload.phase === "organizing"
            ? payload.phase
            : "loading-data";
          setTelemetryAnalytics((current) => ({
            ...current,
            analysisPhase: phase,
            analysisError: null,
          }));
          return;
        }
        if (message.type === "telemetry.analysis.result" && payload.result) {
          const result = payload.result as unknown as TelemetryAnalysisResult;
          if (!result.requestId || result.requestId !== analysisRequestIdRef.current) return;
          setTelemetryAnalytics((current) => ({
            ...current,
            analysisPhase: "ready",
            analysis: result,
            analysisError: null,
          }));
          return;
        }
        if (message.type === "telemetry.analysis.error") {
          const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
          if (requestId && requestId !== analysisRequestIdRef.current) return;
          const fallback = payload.fallback as unknown as TelemetryAnalysisResult | undefined;
          setTelemetryAnalytics((current) => ({
            ...current,
            analysisPhase: "error",
            analysis: fallback ?? current.analysis,
            analysisError: typeof payload.message === "string" ? payload.message : "AI 建议暂不可用",
          }));
          return;
        }
        if (message.type === "alerts.list.result" && payload.result) {
          const result = payload.result as unknown as AlertClientState["list"];
          if (!result || (result.requestId && result.requestId !== alertListRequestIdRef.current)) return;
          setAlerts((current) => ({ ...current, listPhase: "ready", list: result, listError: null, readOnly: false }));
          return;
        }
        if (message.type === "alerts.detail.result" && payload.result) {
          const result = payload.result as unknown as { requestId: string; item: AlertWorkOrder };
          if (result.requestId && result.requestId !== alertDetailRequestIdRef.current) return;
          setAlerts((current) => ({
            ...current,
            detailPhase: "ready",
            detail: result.item,
            detailError: null,
            readOnly: false,
            list: current.list ? {
              ...current.list,
              items: current.list.items.map((item) => item.id === result.item.id ? result.item : item),
            } : current.list,
          }));
          return;
        }
        if (message.type === "alerts.rules.result" && payload.result) {
          const result = payload.result as unknown as AlertRulesResult;
          if (result.requestId && result.requestId !== alertRulesRequestIdRef.current) return;
          setAlerts((current) => ({ ...current, rulesPhase: "ready", rules: result.rules, rulesError: null, readOnly: false }));
          return;
        }
        if (message.type === "alerts.clear.result" && payload.result) {
          const result = payload.result as unknown as AlertClearResult;
          if (result.requestId && result.requestId !== alertClearRequestIdRef.current) return;
          setAlerts((current) => ({
            ...current,
            listPhase: "ready",
            list: {
              requestId: result.requestId,
              generatedAt: result.generatedAt,
              summary: { pending: 0, processing: 0, completed: 0, critical: 0 },
              items: [],
            },
            detailPhase: "idle",
            detail: null,
            detailError: null,
            clearPhase: "ready",
            clearResult: result,
            clearError: null,
            readOnly: false,
          }));
          return;
        }
        if (message.type === "alerts.error") {
          const scope = payload.scope === "detail" || payload.scope === "rules" || payload.scope === "clear" ? payload.scope : "list";
          const messageText = typeof payload.message === "string" ? payload.message : "告警数据暂不可用";
          setAlerts((current) => scope === "clear"
            ? { ...current, clearPhase: "error", clearError: messageText }
            : scope === "detail"
            ? { ...current, detailPhase: "error", detailError: messageText }
            : scope === "rules"
              ? { ...current, rulesPhase: "error", rulesError: messageText }
              : { ...current, listPhase: "error", listError: messageText });
          return;
        }
        if (message.type === "alerts.changed") {
          const requestId = crypto.randomUUID();
          alertListRequestIdRef.current = requestId;
          send("alerts.list.request", { requestId, ...alertFiltersRef.current });
          if (payload.alertId && alertsRef.current.detail?.id === payload.alertId) {
            const detailRequestId = crypto.randomUUID();
            alertDetailRequestIdRef.current = detailRequestId;
            send("alerts.detail.request", { requestId: detailRequestId, alertId: payload.alertId });
          }
          return;
        }
        if (message.type === "vehicle.pending") {
          const nextPendingVehicle = (payload.command as unknown as PendingVehicleCommand | null) ?? null;
          if (nextPendingVehicle) {
            pendingVehicleRequestIdRef.current = planningRequestIdRef.current || null;
          } else {
            const pendingRequestId = pendingVehicleRequestIdRef.current;
            pendingVehicleRequestIdRef.current = null;
            if (
              pendingRequestId
              && shouldRetryAfterVehiclePendingCleared(payload.reason)
            ) {
              markRequestRetryable(pendingRequestId);
            }
          }
          setPendingVehicle(nextPendingVehicle);
        }
      };
      socket.onclose = () => {
        const interruptedAgentRequest = requestInFlightRef.current;
        const interruptedRequestId = interruptedAgentRequest
          ? planningRequestIdRef.current
          : pendingVehicleRequestIdRef.current;
        pendingVehicleRequestIdRef.current = null;
        if (socketRef.current === socket) socketRef.current = null;
        recorderRef.current?.stop(); recorderRef.current = null; setIsRecording(false);
        if (disposed) return;
        window.dispatchEvent(new Event("xingxun:vehicle-stop-request"));
        invalidateExecution();
        if (interruptedRequestId) {
          markRequestRetryable(interruptedRequestId);
          setSession((current) => ({
            ...current,
            phase: "error",
            publicAction: null,
            error: "智能中枢连接已断开，本次任务未完成。",
            updatedAt: new Date().toISOString(),
          }));
        }
        setConnection("offline");
        setAlerts((current) => ({ ...current, readOnly: true }));
        setTelemetryAnalytics((current) => ({
          ...current,
          historyPhase: current.history ? "ready" : "error",
          historyError: current.history ? current.historyError : "历史记录器未连接",
          eventsPhase: current.events ? "ready" : "error",
          eventsError: current.events ? current.eventsError : "事件记录器未连接",
          analysisPhase: current.analysis ? current.analysisPhase : "error",
          analysisError: current.analysis ? current.analysisError : "AI 建议暂不可用",
        }));
        reconnectTimerRef.current = window.setTimeout(connect, 2500);
      };
      socket.onerror = () => socket.close();
    };

    connect();
    return () => {
      disposed = true;
      invalidateExecution();
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
      recorderRef.current?.stop();
      window.speechSynthesis?.cancel();
    };
  }, [
    clearRequestRetryable,
    enqueueAction,
    invalidateExecution,
    markRequestRetryable,
    rememberRequestInstruction,
    send,
    speak,
    updateRequestInFlight,
  ]);

  useEffect(() => {
    if (connection === "online") send("client.context", {
      page: pageFromPath(pathname),
      spatialSampleCounts,
      navigationContext,
    });
  }, [connection, navigationContext, pathname, send, spatialSampleCounts]);

  useEffect(() => {
    const navigationEnd = (event: Event) => {
      const wait = navigationWaitRef.current;
      if (!wait) return;
      const destination = (event as CustomEvent<{ to?: string }>).detail?.to;
      if (destination && destination !== wait.targetPath) return;
      if (wait.generation !== executionGenerationRef.current || (wait.planId && wait.planId !== activePlanIdRef.current)) return;
      if (navigationFallbackRef.current !== null) window.clearTimeout(navigationFallbackRef.current);
      navigationFallbackRef.current = null;
      navigationWaitingRef.current = false;
      navigationWaitRef.current = null;
      const { generation, planId } = wait;
      window.setTimeout(() => {
        if (generation !== executionGenerationRef.current || (planId && planId !== activePlanIdRef.current)) return;
        drainActionQueueRef.current();
      }, 80);
    };
    window.addEventListener("xingxun:navigation-end", navigationEnd);
    return () => window.removeEventListener("xingxun:navigation-end", navigationEnd);
  }, []);

  useEffect(() => {
    const handlePreferences = () => {
      const next = readAiClientPreferences();
      setPreferences(next);
      preferencesRef.current = next;
    };
    window.addEventListener(AI_PREFERENCES_EVENT, handlePreferences);
    return () => window.removeEventListener(AI_PREFERENCES_EVENT, handlePreferences);
  }, []);

  useEffect(() => {
    const raw = window.sessionStorage.getItem(AI_PENDING_ACTION_KEY);
    if (!raw) return;
    window.sessionStorage.removeItem(AI_PENDING_ACTION_KEY);
    try {
      const action = JSON.parse(raw) as AgentAction;
      const timer = window.setTimeout(() => enqueueAction(action), 120);
      return () => window.clearTimeout(timer);
    } catch { return; }
  }, [enqueueAction, pathname]);

  useEffect(() => {
    const stopWhenHidden = () => {
      if (document.hidden) send("vehicle.stop", { automatic: true });
    };
    const stopWhenLeaving = () => {
      send("vehicle.stop", { automatic: true });
    };
    document.addEventListener("visibilitychange", stopWhenHidden);
    window.addEventListener("pagehide", stopWhenLeaving);
    return () => {
      document.removeEventListener("visibilitychange", stopWhenHidden);
      window.removeEventListener("pagehide", stopWhenLeaving);
    };
  }, [send]);

  const updatePreferences = useCallback((next: AiClientPreferences) => {
    const current = preferencesRef.current;
    const requiresReconnect = current.gatewayUrl !== next.gatewayUrl
      || current.clientRole !== next.clientRole
      || current.pairingToken !== next.pairingToken;
    setPreferences(next); preferencesRef.current = next; saveAiClientPreferences(next);
    if (requiresReconnect) {
      socketRef.current?.close(1000, "connection preferences changed");
      return;
    }
    send("client.preferences", {
      realVehicleEnabled: next.realVehicleEnabled,
      alertWorkOrderAutomationEnabled: next.alertWorkOrderAutomationEnabled,
      thinkingMode: next.thinkingMode,
      reasoningEffort: next.reasoningEffort,
    });
  }, [send]);

  const pair = useCallback((code: string) => { send("pair.request", { code: code.replace(/\D/g, "").slice(0, 6) }); }, [send]);
  const submitAgentRequest = useCallback((text: string) => {
    const attempt = createAgentRequestAttempt(text);
    if (!attempt) return false;
    const { requestId, text: cleanText } = attempt;
    lastUserRequestRef.current = cleanText;
    rememberRequestInstruction(requestId, cleanText);
    updateRequestInFlight(true);
    invalidateExecution();
    planningRequestIdRef.current = requestId;
    planRef.current = null;
    evidenceGuideDescriptorsRef.current = [];
    evidenceGuidePausedRef.current = false;
    evidenceGuideTransitionSequenceRef.current += 1;
    deferredSpeechRef.current = null;
    setEvidenceGuide(null);
    nextPlanSearchIndexRef.current = 0;
    setPlan(null);
    setPlanningTrace(null);
    setExecutionProgress({ planId: null, totalSteps: 0, activeStep: 0, completedSteps: 0 });
    setSession((current) => ({
      ...current,
      phase: "understanding",
      transcript: cleanText,
      reply: "",
      publicAction: null,
      error: null,
      updatedAt: new Date().toISOString(),
    }));
    if (!send("agent.ask", { text: cleanText, page: pageFromPath(pathnameRef.current), requestId })) {
      markRequestRetryable(requestId);
      setSession((current) => ({
        ...current,
        phase: "error",
        error: "智能中枢未连接，请稍后重试。",
        updatedAt: new Date().toISOString(),
      }));
      return false;
    }
    return true;
  }, [
    invalidateExecution,
    markRequestRetryable,
    rememberRequestInstruction,
    send,
    updateRequestInFlight,
  ]);

  const ask = useCallback((text: string) => {
    void submitAgentRequest(text);
  }, [submitAgentRequest]);

  const retryLastRequest = useCallback(() => {
    const retryable = retryableRequestRef.current;
    if (!retryable || requestInFlightRef.current) return;
    replaceRetryableRequest(null);
    void submitAgentRequest(retryable.instruction);
  }, [replaceRetryableRequest, submitAgentRequest]);

  const beginListening = useCallback(async () => {
    if (connection !== "online" || isRecording) return;
    invalidateExecution();
    planningRequestIdRef.current = "";
    updateRequestInFlight(false);
    listeningIntentRef.current = true;
    try {
      const recorder = await PcmRecorder.create((chunk) => socketRef.current?.send(chunk));
      if (!listeningIntentRef.current) { recorder.stop(); return; }
      recorderRef.current = recorder;
      planRef.current = null;
      evidenceGuideDescriptorsRef.current = [];
      evidenceGuidePausedRef.current = false;
      evidenceGuideTransitionSequenceRef.current += 1;
      deferredSpeechRef.current = null;
      setEvidenceGuide(null);
      nextPlanSearchIndexRef.current = 0;
      setPlan(null);
      setPlanningTrace(null);
      setExecutionProgress({ planId: null, totalSteps: 0, activeStep: 0, completedSteps: 0 });
      send("voice.start", {});
      recorder.start();
      setIsRecording(true);
    } catch (error) {
      setSession((current) => ({ ...current, phase: "error", error: error instanceof Error ? error.message : "无法使用麦克风" }));
    }
  }, [connection, invalidateExecution, isRecording, send, updateRequestInFlight]);

  const endListening = useCallback(() => {
    listeningIntentRef.current = false;
    if (!recorderRef.current) return;
    recorderRef.current.stop(); recorderRef.current = null;
    setIsRecording(false);
    send("voice.stop", {});
  }, [send]);

  const confirmVehicle = useCallback(() => {
    if (pendingVehicle) send("vehicle.confirm", { confirmationId: pendingVehicle.confirmationId });
  }, [pendingVehicle, send]);
  const cancelVehicle = useCallback(() => {
    const cancelledRequestId = pendingVehicleRequestIdRef.current;
    send("vehicle.cancel", {});
    if (cancelledRequestId) markRequestRetryable(cancelledRequestId);
  }, [markRequestRetryable, send]);
  const emergencyStop = useCallback(() => { send("vehicle.stop", {}); }, [send]);

  const continueEvidenceGuide = useCallback(() => {
    if (!evidenceGuidePausedRef.current) return;
    if (evidenceGuide?.availability === "loading") return;
    const finalEvidence = Boolean(evidenceGuide && evidenceGuide.position >= evidenceGuide.total);
    const sequence = ++evidenceGuideTransitionSequenceRef.current;
    setEvidenceGuide((current) => current ? { ...current, phase: "advancing" } : current);
    window.setTimeout(() => {
      if (evidenceGuideTransitionSequenceRef.current !== sequence) return;
      if (finalEvidence) {
        setEvidenceGuide((current) => current ? { ...current, phase: "complete" } : current);
      } else {
        evidenceGuidePausedRef.current = false;
        setEvidenceGuide(null);
      }
      if (finalEvidence && deferredSpeechRef.current) {
        const deferred = deferredSpeechRef.current;
        deferredSpeechRef.current = null;
        if (deferred.enabled) speakRef.current(deferred.text);
      }
      if (!finalEvidence) window.requestAnimationFrame(() => drainActionQueueRef.current());
    }, evidenceGuideTransitionDurationMs());
  }, [evidenceGuide]);

  const endEvidenceGuide = useCallback(() => {
    if (evidenceGuide?.phase === "complete") {
      const sequence = ++evidenceGuideTransitionSequenceRef.current;
      setEvidenceGuide((current) => current ? { ...current, phase: "advancing" } : current);
      window.setTimeout(() => {
        if (evidenceGuideTransitionSequenceRef.current !== sequence) return;
        evidenceGuidePausedRef.current = false;
        evidenceGuideDescriptorsRef.current = [];
        setEvidenceGuide(null);
        window.requestAnimationFrame(() => drainActionQueueRef.current());
      }, evidenceGuideTransitionDurationMs());
      return;
    }
    evidenceGuideTransitionSequenceRef.current += 1;
    const currentPlan = planRef.current;
    const visited = evidenceGuide?.position ?? 0;
    evidenceGuidePausedRef.current = false;
    const queuedBeforeEnding = actionQueueRef.current;
    const retainedActions = retainNonVisualQueuedActions(queuedBeforeEnding);
    for (const queued of queuedBeforeEnding) {
      if (retainedActions.includes(queued)) continue;
      send("action.execution-state", {
        requestId: queued.requestId,
        planId: queued.planId,
        stepIndex: queued.stepIndex,
        actionExecutionId: queued.actionExecutionId,
        actionName: queued.action.name,
        executionState: "cancelled",
      });
    }
    actionQueueRef.current = retainedActions
      .map((item) => ({ ...item, stepIndex: 0 }));
    planRef.current = null;
    evidenceGuideDescriptorsRef.current = [];
    deferredSpeechRef.current = null;
    setEvidenceGuide((current) => current && currentPlan ? {
      ...current,
      phase: "complete",
      explanation: "已按你的选择停止后续图表切换。",
      conclusion: `讲解已在第 ${Math.max(1, visited)} 项结束，未继续执行其余可视步骤。`,
    } : null);
    setSession((current) => ({
      ...current,
      phase: "speaking",
      reply: "已结束本次证据讲解，其余可视步骤未执行。",
      publicAction: null,
      error: null,
      updatedAt: new Date().toISOString(),
    }));
    if (currentPlan) setPlan(null);
    setExecutionProgress({ planId: null, totalSteps: 0, activeStep: 0, completedSteps: 0 });
    window.requestAnimationFrame(() => drainActionQueueRef.current());
  }, [evidenceGuide?.phase, evidenceGuide?.position, send]);

  const requestCollectorSettings = useCallback(() => {
    const requestId = crypto.randomUUID();
    collectorSettingsRequestIdRef.current = requestId;
    setCollectorSettings((current) => {
      const next: TelemetryCollectorSettingsState = {
        ...current,
        phase: "loading",
        requestId,
        error: null,
      };
      collectorSettingsRef.current = next;
      return next;
    });
    if (!send("telemetry.collector.settings.request", { requestId })) {
      setCollectorSettings((current) => {
        const next: TelemetryCollectorSettingsState = {
          ...current,
          phase: "error",
          requestId,
          error: "智能网关未连接",
        };
        collectorSettingsRef.current = next;
        return next;
      });
      return null;
    }
    return requestId;
  }, [send]);

  const saveCollectorPollInterval = useCallback((pollIntervalMs: TelemetryPollIntervalMs) => {
    const requestId = crypto.randomUUID();
    collectorSettingsRequestIdRef.current = requestId;
    if (!collectorSettingsRef.current.canEdit) {
      setCollectorSettings((current) => {
        const next: TelemetryCollectorSettingsState = {
          ...current,
          phase: "error",
          requestId,
          error: "只有电脑显示端可以修改华为云后台读取间隔",
        };
        collectorSettingsRef.current = next;
        return next;
      });
      return null;
    }
    setCollectorSettings((current) => {
      const next: TelemetryCollectorSettingsState = {
        ...current,
        phase: "saving",
        requestId,
        error: null,
      };
      collectorSettingsRef.current = next;
      return next;
    });
    if (!send("telemetry.collector.settings.update", { requestId, pollIntervalMs })) {
      setCollectorSettings((current) => {
        const next: TelemetryCollectorSettingsState = {
          ...current,
          phase: "error",
          requestId,
          error: "智能网关未连接",
        };
        collectorSettingsRef.current = next;
        return next;
      });
      return null;
    }
    return requestId;
  }, [send]);

  const requestTelemetryHistory = useCallback((input: Omit<TelemetryHistoryRequest, "requestId">) => {
    const requestId = crypto.randomUUID();
    historyRequestIdRef.current = requestId;
    setTelemetryAnalytics((current) => {
      const next: TelemetryAnalyticsState = {
        ...current,
        historyPhase: "loading",
        history: null,
        historyError: null,
      };
      telemetryAnalyticsRef.current = next;
      return next;
    });
    if (!send("telemetry.history.request", { ...input, requestId })) {
      setTelemetryAnalytics((current) => {
        const next: TelemetryAnalyticsState = {
          ...current,
          historyPhase: "error",
          history: null,
          historyError: "历史记录器未连接",
        };
        telemetryAnalyticsRef.current = next;
        return next;
      });
      return null;
    }
    return requestId;
  }, [send]);

  const requestTelemetryEvents = useCallback((input: Omit<TelemetryEventsRequest, "requestId">) => {
    const requestId = crypto.randomUUID();
    eventsRequestIdRef.current = requestId;
    setTelemetryAnalytics((current) => ({ ...current, eventsPhase: "loading", eventsError: null }));
    if (!send("telemetry.events.request", { ...input, requestId })) {
      setTelemetryAnalytics((current) => ({ ...current, eventsPhase: "error", eventsError: "事件记录器未连接" }));
      return null;
    }
    return requestId;
  }, [send]);

  const requestTelemetryAnalysis = useCallback((input: Omit<TelemetryAnalysisRequest, "requestId">) => {
    const requestId = crypto.randomUUID();
    analysisRequestIdRef.current = requestId;
    setTelemetryAnalytics((current) => {
      const next: TelemetryAnalyticsState = {
        ...current,
        analysisPhase: "loading-data",
        analysis: null,
        analysisError: null,
      };
      telemetryAnalyticsRef.current = next;
      return next;
    });
    if (!send("telemetry.analysis.request", { ...input, requestId })) {
      setTelemetryAnalytics((current) => ({ ...current, analysisPhase: "error", analysisError: "AI 建议暂不可用" }));
      return null;
    }
    return requestId;
  }, [send]);

  const showTelemetryEvidence = useCallback((slotIds: TelemetrySlotId[]) => {
    const unique = [...new Set(slotIds)];
    if (!unique.length) return;
    enqueueAction({ name: "monitoring.set_tab", arguments: { tab: "live" } });
    enqueueAction({ name: "monitoring.set_visible_series", arguments: { slotIds: unique } });
    enqueueAction({ name: "telemetry.focus", arguments: { slotId: unique[0] } });
  }, [enqueueAction]);

  const requestAlerts = useCallback((filters: AlertListFilters = {}) => {
    const requestId = crypto.randomUUID();
    alertListRequestIdRef.current = requestId;
    alertFiltersRef.current = filters;
    setAlerts((current) => ({ ...current, listPhase: "loading", listError: null, readOnly: connection !== "online" }));
    if (!send("alerts.list.request", { requestId, ...filters })) {
      setAlerts((current) => ({ ...current, listPhase: "error", listError: "智能网关未连接", readOnly: true }));
      return null;
    }
    return requestId;
  }, [connection, send]);

  const requestAlertDetail = useCallback((alertId: string) => {
    const requestId = crypto.randomUUID();
    alertDetailRequestIdRef.current = requestId;
    setAlerts((current) => ({ ...current, detailPhase: "loading", detailError: null }));
    if (!send("alerts.detail.request", { requestId, alertId })) return null;
    return requestId;
  }, [send]);

  const beginAlert = useCallback((alertId: string, expectedVersion: number, actor: string) => {
    const requestId = crypto.randomUUID();
    alertDetailRequestIdRef.current = requestId;
    setAlerts((current) => ({ ...current, detailPhase: "saving", detailError: null }));
    if (!send("alerts.begin.request", { requestId, alertId, expectedVersion, actor })) return null;
    return requestId;
  }, [send]);

  const completeAlert = useCallback((alertId: string, expectedVersion: number, actor: string, action: AlertAction, note: string) => {
    const requestId = crypto.randomUUID();
    alertDetailRequestIdRef.current = requestId;
    setAlerts((current) => ({ ...current, detailPhase: "saving", detailError: null }));
    if (!send("alerts.complete.request", { requestId, alertId, expectedVersion, actor, action, note })) return null;
    return requestId;
  }, [send]);

  const requestAlertRules = useCallback(() => {
    const requestId = crypto.randomUUID();
    alertRulesRequestIdRef.current = requestId;
    setAlerts((current) => ({ ...current, rulesPhase: "loading", rulesError: null }));
    if (!send("alerts.rules.request", { requestId })) return null;
    return requestId;
  }, [send]);

  const saveAlertRules = useCallback((rules: AlertRule[], actor: string) => {
    const requestId = crypto.randomUUID();
    alertRulesRequestIdRef.current = requestId;
    setAlerts((current) => ({ ...current, rulesPhase: "saving", rulesError: null }));
    if (!send("alerts.rules.save", { requestId, rules, actor })) return null;
    return requestId;
  }, [send]);

  const clearAlerts = useCallback((actor: string) => {
    const requestId = crypto.randomUUID();
    alertClearRequestIdRef.current = requestId;
    setAlerts((current) => ({ ...current, clearPhase: "loading", clearError: null }));
    if (!send("alerts.clear.request", { requestId, actor })) {
      setAlerts((current) => ({ ...current, clearPhase: "error", clearError: "智能网关未连接" }));
      return null;
    }
    return requestId;
  }, [send]);

  const planningProgress = useMemo(
    () => buildPublicPlanningProgress(planningTrace, session, plan),
    [plan, planningTrace, session],
  );
  const hasRetryableRequest = retryableRequest !== null;
  const canRetryLastRequest = shouldOfferAgentRetry({
    hasRetryableRequest,
    requestInFlight: requestInFlight
      || isRecording
      || pendingVehicle !== null
      || evidenceGuide !== null,
  });

  const value = useMemo<AiControlContextValue>(() => ({
    connection, session, preferences, history, plan, planningTrace, planningProgress, executionProgress, evidenceGuide, pendingVehicle, isRecording,
    telemetryAnalytics, collectorSettings, alerts, runtimeProfile, hasRetryableRequest, canRetryLastRequest,
    updatePreferences, pair, ask, retryLastRequest, beginListening, endListening,
    confirmVehicle, cancelVehicle, emergencyStop, continueEvidenceGuide, endEvidenceGuide,
    requestTelemetryHistory, requestTelemetryEvents, requestTelemetryAnalysis, requestCollectorSettings, saveCollectorPollInterval, showTelemetryEvidence,
    requestAlerts, requestAlertDetail, beginAlert, completeAlert, requestAlertRules, saveAlertRules, clearAlerts,
  }), [alerts, ask, beginAlert, beginListening, canRetryLastRequest, cancelVehicle, clearAlerts, collectorSettings, completeAlert, confirmVehicle, connection, continueEvidenceGuide, emergencyStop, endEvidenceGuide, endListening, evidenceGuide, executionProgress, hasRetryableRequest, history, isRecording, pair, pendingVehicle, plan, planningProgress, planningTrace, preferences, requestAlertDetail, requestAlertRules, requestAlerts, requestCollectorSettings, requestTelemetryAnalysis, requestTelemetryEvents, requestTelemetryHistory, retryLastRequest, runtimeProfile, saveAlertRules, saveCollectorPollInterval, session, showTelemetryEvidence, telemetryAnalytics, updatePreferences]);

  return <AiControlContext.Provider value={value}>{children}</AiControlContext.Provider>;
}

export function useAiControl() {
  const value = useContext(AiControlContext);
  if (!value) throw new Error("useAiControl must be used inside AiControlProvider");
  return value;
}

function parseCollectorSettingsPayload(value: unknown): TelemetryCollectorSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const pollIntervalMs = Number(source.pollIntervalMs);
  if (!(TELEMETRY_POLL_INTERVALS as readonly number[]).includes(pollIntervalMs)) return null;
  if (typeof source.updatedAt !== "string" || Number.isNaN(Date.parse(source.updatedAt))) return null;
  if (typeof source.updatedBy !== "string" || !source.updatedBy.trim()) return null;
  return {
    pollIntervalMs: pollIntervalMs as TelemetryPollIntervalMs,
    updatedAt: source.updatedAt,
    updatedBy: source.updatedBy,
  };
}

const PUBLIC_PLANNING_STAGES: ReadonlyArray<{
  id: AgentPublicPlanningStageId;
  label: string;
  sourceId: AgentPlanningStageId | null;
  summary: string;
}> = [
  {
    id: "intent",
    label: "理解目标",
    sourceId: "understand",
    summary: "正在判断你真正想查看、比较或完成的结果",
  },
  {
    id: "evidence",
    label: "识别证据",
    sourceId: "context",
    summary: "正在匹配相关数据、时间范围与可用页面能力",
  },
  {
    id: "destination",
    label: "选择界面",
    sourceId: "plan",
    summary: "正在选择最能表达结果的页面、图表与聚焦区域",
  },
  {
    id: "validation",
    label: "校验动作",
    sourceId: "validate",
    summary: "正在检查动作顺序、协议一致性与目标覆盖",
  },
  {
    id: "execution",
    label: "执行动作",
    sourceId: "execution",
    summary: "正在等待页面、设备或数据服务返回真实完成结果",
  },
  {
    id: "ready",
    label: "任务完成",
    sourceId: null,
    summary: "计划中的动作均已收到真实完成回执",
  },
];

/** Convert the gateway trace to a stable public progress view without exposing reasoning text. */
export function buildPublicPlanningProgress(
  trace: AgentPlanningTrace | null,
  session: VoiceSessionState,
  plan: AgentPlan | null,
): AgentPublicPlanningProgress | null {
  if (!trace && session.phase !== "understanding") return null;

  const traceStage = (id: AgentPlanningStageId) => trace?.stages.find((stage) => stage.id === id);
  const upstreamError = trace?.stages.find((stage) => stage.status === "error");
  const executionStage = traceStage("execution");
  const stages: AgentPublicPlanningStage[] = PUBLIC_PLANNING_STAGES.map((stage) => {
    if (stage.id === "execution" && !executionStage) {
      if (plan && session.phase === "speaking") {
        return { id: stage.id, label: stage.label, status: "complete" };
      }
      if (plan && session.phase === "executing") {
        return { id: stage.id, label: stage.label, status: "active" };
      }
      return { id: stage.id, label: stage.label, status: "pending" };
    }
    if (stage.id === "ready") {
      if (
        executionStage?.status === "complete"
        || (!executionStage && plan && session.phase === "speaking")
      ) {
        return { id: stage.id, label: stage.label, status: "complete" };
      }
      return { id: stage.id, label: stage.label, status: "pending" };
    }
    return {
      id: stage.id,
      label: stage.label,
      status: stage.sourceId ? traceStage(stage.sourceId)?.status ?? (stage.id === "intent" ? "active" : "pending") : "pending",
    };
  });

  const current = stages.find((stage) => stage.status === "error")
    ?? stages.find((stage) => stage.status === "active")
    ?? stages.find((stage) => stage.status === "pending")
    ?? stages.at(-1)!;
  const definition = PUBLIC_PLANNING_STAGES.find((stage) => stage.id === current.id)!;
  const completedCount = stages.filter((stage) => stage.status === "complete").length;
  const progressPercent = current.id === "ready" && current.status === "complete"
    ? 100
    : trace
      ? Math.min(
        96,
        Math.max(
          8,
          Math.round(
            (completedCount / stages.length) * 100
            + (current.status === "active" ? 100 / stages.length / 2 : 0),
          ),
        ),
      )
      : 8;
  const publicStageDetail = definition.sourceId
    ? traceStage(definition.sourceId)?.detail.trim().slice(0, 120)
    : "";
  const currentSummary = current.status === "error"
    ? upstreamError?.detail || session.error || "规划未能通过校验"
    : plan && current.id === "execution"
      ? `正在按顺序执行 ${plan.steps.length} 个动作，并等待真实完成回执`
      : plan && current.id === "ready"
        ? `${plan.steps.length} 个动作均已完成`
        : publicStageDetail || definition.summary;
  const currentLabel = current.status === "error"
    ? /固定检查点|Jetson 导航地图|小车当前位置|车辆任务|前往固定检查点/.test(currentSummary)
      ? "车辆导航未就绪"
      : `${current.label}未完成`
    : current.label;

  return {
    requestId: trace?.requestId ?? `local-${session.updatedAt}`,
    progressPercent,
    currentStageId: current.id,
    currentLabel,
    currentSummary,
    stages,
    updatedAt: trace?.updatedAt ?? session.updatedAt,
  };
}

function isVoicePhase(value: unknown): value is VoiceSessionState["phase"] {
  return typeof value === "string" && ["idle", "listening", "understanding", "confirming", "executing", "speaking", "error"].includes(value);
}

function createClientActionExecutionId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `action-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setNativeAgentActivity(
  phase: "recording" | "planning" | "executing" | "vehicle",
  active: boolean,
) {
  try {
    window.XingXunCloud?.setAgentActivity?.(phase, active);
  } catch {
    // Native lifecycle reporting must never break the browser-side Agent queue.
  }
}

function evidenceGuideTransitionDurationMs() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? 0
    : 180;
}

function pageFromPath(pathname: string): UiPage {
  const entry = (Object.entries(PAGE_PATHS) as Array<[UiPage, string]>)
    .find(([, path]) => path === pathname);
  return entry?.[0] ?? "overview";
}

function sameAgentAction(left: AgentAction, right: AgentAction) {
  return left.name === right.name
    && JSON.stringify(left.arguments) === JSON.stringify(right.arguments);
}

class PcmRecorder {
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private pending: number[] = [];

  private constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly onChunk: (chunk: ArrayBuffer) => void,
  ) {}

  static async create(onChunk: (chunk: ArrayBuffer) => void) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前设备不支持麦克风采集");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const context = new AudioContext({ latencyHint: "interactive" });
    await context.resume();
    return new PcmRecorder(stream, context, onChunk);
  }

  start() {
    const source = this.context.createMediaStreamSource(this.stream);
    const processor = this.context.createScriptProcessor(2048, 1, 1);
    const silent = this.context.createGain();
    silent.gain.value = 0;
    processor.onaudioprocess = (event) => this.consume(event.inputBuffer.getChannelData(0), this.context.sampleRate);
    source.connect(processor); processor.connect(silent); silent.connect(this.context.destination);
    this.source = source; this.processor = processor;
  }

  stop() {
    this.processor?.disconnect(); this.source?.disconnect();
    if (this.processor) this.processor.onaudioprocess = null;
    this.stream.getTracks().forEach((track) => track.stop());
    void this.context.close();
    this.processor = null; this.source = null; this.pending = [];
  }

  private consume(input: Float32Array, sourceRate: number) {
    const ratio = sourceRate / 16000;
    const outputLength = Math.floor(input.length / ratio);
    for (let index = 0; index < outputLength; index += 1) {
      const sourceIndex = Math.min(input.length - 1, Math.floor(index * ratio));
      this.pending.push(Math.max(-1, Math.min(1, input[sourceIndex])));
    }
    while (this.pending.length >= 640) {
      const samples = this.pending.splice(0, 640);
      const pcm = new Int16Array(samples.length);
      for (let index = 0; index < samples.length; index += 1) pcm[index] = samples[index] < 0 ? samples[index] * 32768 : samples[index] * 32767;
      this.onChunk(pcm.buffer);
    }
  }
}
