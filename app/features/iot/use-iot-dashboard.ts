"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createInitialSnapshot,
  type CommandLogItem,
  type DashboardSnapshot,
  type VehicleMotion,
} from "@/app/lib/iot/contracts";
import { getDashboardSnapshot } from "@/app/lib/iot/client";
import type { AgentAction } from "@/app/lib/ai/contracts";
import { UI_PREFERENCES_EVENT, readPreferences } from "@/app/lib/ui-preferences";
import { useJetsonVehicle } from "./use-jetson-vehicle";

type CommandPhase = "idle" | "sending" | "accepted" | "error";

function isAbortError(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "name" in error
    && error.name === "AbortError",
  );
}

function requestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function useIotDashboardController() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(
    createInitialSnapshot,
  );
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [commandPhase, setCommandPhase] = useState<CommandPhase>("idle");
  const [commandFeedback, setCommandFeedback] = useState("尚未发送指令");
  const [commandLog, setCommandLog] = useState<CommandLogItem[]>([]);
  const [activeMotion, setActiveMotion] = useState<VehicleMotion>("stop");
  const activeMotionRef = useRef<VehicleMotion>("stop");
  const refreshController = useRef<AbortController | null>(null);
  const refreshPromiseRef = useRef<Promise<boolean> | null>(null);
  const lastRefreshSucceededRef = useRef(false);
  const pollingRefreshRef = useRef<((silent?: boolean) => Promise<void>) | null>(null);
  const navigationActiveRef = useRef(false);
  const queuedSnapshotRef = useRef<DashboardSnapshot | null>(null);
  const navigationReleaseTimerRef = useRef<number | null>(null);
  const aiVehicleStopTimerRef = useRef<number | null>(null);
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(() => readPreferences().refreshIntervalMs);
  const [pauseWhenHidden, setPauseWhenHidden] = useState(() => readPreferences().pauseWhenHidden);
  const {
    enabled: jetsonEnabled,
    telemetry: jetsonTelemetry,
    navigation,
    sendCommand: sendJetsonCommand,
    subscribeVideoFrames,
    zeroImuHeading,
    saveNavigationMap,
    planNavigation,
    startNavigation,
    cancelNavigation,
    refreshNavigation,
  } = useJetsonVehicle();

  const commitQueuedSnapshot = useCallback(() => {
    navigationActiveRef.current = false;
    if (navigationReleaseTimerRef.current !== null) {
      window.clearTimeout(navigationReleaseTimerRef.current);
      navigationReleaseTimerRef.current = null;
    }
    const queued = queuedSnapshotRef.current;
    queuedSnapshotRef.current = null;
    if (queued) setSnapshot(queued);
  }, []);

  const performRefresh = useCallback((silent = false): Promise<boolean> => {
    const inFlight = refreshPromiseRef.current;
    if (inFlight) {
      if (!silent) setIsRefreshing(true);
      return inFlight;
    }

    const controller = new AbortController();
    refreshController.current = controller;
    if (!silent) setIsRefreshing(true);

    const request = (async () => {
      try {
        const next = await getDashboardSnapshot(controller.signal);
        if (navigationActiveRef.current) queuedSnapshotRef.current = next;
        else setSnapshot(next);
        setRefreshError(null);
        lastRefreshSucceededRef.current = true;
        return true;
      } catch (error) {
        lastRefreshSucceededRef.current = false;
        if (controller.signal.aborted || isAbortError(error)) return false;
        setRefreshError(
          "暂时无法读取数据，请稍后重试。",
        );
        return true;
      } finally {
        if (refreshController.current === controller) {
          refreshController.current = null;
          refreshPromiseRef.current = null;
        }
        if (!controller.signal.aborted) setIsRefreshing(false);
      }
    })();
    refreshPromiseRef.current = request;
    return request;
  }, []);

  const refresh = useCallback((silent = false) => {
    const scheduledRefresh = pollingRefreshRef.current;
    if (scheduledRefresh) {
      return scheduledRefresh(silent).then(() => lastRefreshSucceededRef.current);
    }
    return performRefresh(silent).then(() => lastRefreshSucceededRef.current);
  }, [performRefresh]);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let cyclePromise: Promise<void> | null = null;
    let nativeHostPaused = false;

    const shouldPause = () => nativeHostPaused
      || (pauseWhenHidden && document.visibilityState === "hidden");
    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const cancelActiveRefresh = (message: string) => {
      clearTimer();
      refreshController.current?.abort(new DOMException(message, "AbortError"));
      setIsRefreshing(false);
    };
    const schedule = () => {
      clearTimer();
      if (disposed || shouldPause()) return;
      timer = window.setTimeout(() => {
        timer = null;
        void runCycle(true);
      }, refreshIntervalMs);
    };
    const runCycle = (silent = true): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (shouldPause()) {
        if (!silent) setIsRefreshing(false);
        return Promise.resolve();
      }
      if (cyclePromise) {
        if (!silent) setIsRefreshing(true);
        return cyclePromise;
      }

      const nextCycle = (async () => {
        const completed = await performRefresh(silent);
        cyclePromise = null;
        if (!completed && !disposed && !shouldPause()) {
          await runCycle(silent);
          return;
        }
        schedule();
      })();
      cyclePromise = nextCycle;
      return nextCycle;
    };
    const requestRefresh = (silent = false) => {
      clearTimer();
      return runCycle(silent);
    };
    const handleVisibilityChange = () => {
      if (!pauseWhenHidden) return;
      if (document.visibilityState === "hidden") {
        cancelActiveRefresh("页面已隐藏，暂停数据读取");
        return;
      }
      void requestRefresh(true);
    };
    const handleNativeLifecycle = (event: Event) => {
      const state = (event as CustomEvent<{ state?: unknown }>).detail?.state;
      if (state === "paused") {
        nativeHostPaused = true;
        cancelActiveRefresh("应用已进入后台，暂停数据读取");
        return;
      }
      if (state !== "resumed") return;
      nativeHostPaused = false;
      if (!shouldPause()) void requestRefresh(true);
    };

    pollingRefreshRef.current = requestRefresh;
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("xingxun:native-lifecycle", handleNativeLifecycle);
    void requestRefresh(false);

    return () => {
      disposed = true;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("xingxun:native-lifecycle", handleNativeLifecycle);
      if (pollingRefreshRef.current === requestRefresh) pollingRefreshRef.current = null;
    };
  }, [pauseWhenHidden, performRefresh, refreshIntervalMs]);

  useEffect(() => () => {
    refreshController.current?.abort(
      new DOMException("页面已卸载，取消数据读取", "AbortError"),
    );
  }, []);

  useEffect(() => {
    const reload = () => {
      const preferences = readPreferences();
      setRefreshIntervalMs(preferences.refreshIntervalMs);
      setPauseWhenHidden(preferences.pauseWhenHidden);
    };
    window.addEventListener(UI_PREFERENCES_EVENT, reload);
    return () => window.removeEventListener(UI_PREFERENCES_EVENT, reload);
  }, []);

  useEffect(() => {
    const holdSnapshotPaints = () => {
      navigationActiveRef.current = true;
      if (navigationReleaseTimerRef.current !== null) {
        window.clearTimeout(navigationReleaseTimerRef.current);
      }
      // The matching navigation-end event normally releases this immediately.
      // This guard also covers interrupted navigation and older cached clients.
      navigationReleaseTimerRef.current = window.setTimeout(
        commitQueuedSnapshot,
        1_200,
      );
    };

    window.addEventListener("xingxun:navigation-start", holdSnapshotPaints);
    window.addEventListener("xingxun:navigation-end", commitQueuedSnapshot);
    return () => {
      window.removeEventListener("xingxun:navigation-start", holdSnapshotPaints);
      window.removeEventListener("xingxun:navigation-end", commitQueuedSnapshot);
      if (navigationReleaseTimerRef.current !== null) {
        window.clearTimeout(navigationReleaseTimerRef.current);
      }
    };
  }, [commitQueuedSnapshot]);

  const sendCommand = useCallback(
    async (motion: VehicleMotion, speedPercent: number) => {
      const normalizedSpeed = motion === "stop" ? 0 : speedPercent;
      const input = {
        requestId: requestId(),
        motion,
        speedPercent: normalizedSpeed,
        issuedAt: new Date().toISOString(),
      };

      activeMotionRef.current = motion;
      setActiveMotion(motion);
      setCommandPhase("sending");
      setCommandFeedback(
        motion === "stop" ? "正在发送停止指令…" : "正在发送移动指令…",
      );

      try {
        if (!jetsonEnabled) throw new Error("小车控制连接尚未启用。");
        const ack = await sendJetsonCommand(input);
        setCommandPhase(ack.status === "rejected" ? "error" : "accepted");
        setCommandFeedback(ack.message);
        setCommandLog((current) => [
          { ...ack, motion, speedPercent: normalizedSpeed },
          ...current,
        ].slice(0, 5));
        void refresh(true);
        return ack;
      } catch (error) {
        activeMotionRef.current = "stop";
        setActiveMotion("stop");
        setCommandPhase("error");
        setCommandFeedback(
          error instanceof Error ? error.message : "指令发送失败",
        );
        setCommandLog((current) => [
          {
            requestId: input.requestId,
            commandId: "not-issued",
            status: "rejected" as const,
            acknowledgedAt: new Date().toISOString(),
            message: error instanceof Error ? error.message : "指令发送失败",
            motion,
            speedPercent: normalizedSpeed,
          },
          ...current,
        ].slice(0, 5));
        return null;
      }
    },
    [jetsonEnabled, refresh, sendJetsonCommand],
  );

  const stopIfMoving = useCallback(() => {
    if (activeMotionRef.current === "stop") return;
    activeMotionRef.current = "stop";
    setActiveMotion("stop");
    void sendCommand("stop", 0);
  }, [sendCommand]);

  useEffect(() => {
    const clearAiTimer = () => {
      if (aiVehicleStopTimerRef.current !== null) window.clearTimeout(aiVehicleStopTimerRef.current);
      aiVehicleStopTimerRef.current = null;
    };
    const sendStop = () => {
      clearAiTimer();
      void sendCommand("stop", 0).catch(() => undefined);
    };
    const handleAgentAction = (event: Event) => {
      const action = (event as CustomEvent<AgentAction>).detail;
      if (action?.name === "vehicle.stop") {
        sendStop();
        return;
      }
      if (action?.name !== "vehicle.propose_move") return;
      clearAiTimer();
      const speed = Math.min(30, Math.max(1, Math.round(action.arguments.speedPercent ?? 20)));
      const duration = Math.min(3_000, Math.max(100, Math.round(action.arguments.durationMs ?? 1_000)));
      void sendCommand(action.arguments.motion, speed).then((ack) => {
        if (!ack || ack.status === "rejected") return;
        aiVehicleStopTimerRef.current = window.setTimeout(sendStop, duration);
      });
    };
    const handleLifecycleStop = () => {
      try {
        cancelNavigation();
      } catch {
        // The navigation link can already be closed; stopping remains mandatory.
      }
      sendStop();
    };
    window.addEventListener("xingxun:ai-action", handleAgentAction);
    window.addEventListener("xingxun:vehicle-stop-request", handleLifecycleStop);
    return () => {
      window.removeEventListener("xingxun:ai-action", handleAgentAction);
      window.removeEventListener("xingxun:vehicle-stop-request", handleLifecycleStop);
      clearAiTimer();
    };
  }, [cancelNavigation, sendCommand]);

  // Vehicle state always comes from the real Jetson transport. The sensor
  // provider may be a demo source, but it must never supply simulated vehicle data.
  const effectiveSnapshot = { ...snapshot, vehicle: jetsonTelemetry };

  return {
    snapshot: effectiveSnapshot,
    navigation,
    jetsonEnabled,
    isRefreshing,
    refreshError,
    refresh,
    sendCommand,
    stopIfMoving,
    activeMotion,
    activeMotionRef,
    commandPhase,
    commandFeedback,
    commandLog,
    subscribeVideoFrames,
    zeroImuHeading,
    saveNavigationMap,
    planNavigation,
    startNavigation,
    cancelNavigation,
    refreshNavigation,
  };
}

type IotDashboardContextValue = ReturnType<typeof useIotDashboardController>;

const IotDashboardContext = createContext<IotDashboardContextValue | null>(null);

export function IotDashboardProvider({ children }: { children: ReactNode }) {
  const controller = useIotDashboardController();
  return createElement(
    IotDashboardContext.Provider,
    { value: controller },
    children,
  );
}

export function useIotDashboard() {
  const controller = useContext(IotDashboardContext);
  if (!controller) {
    throw new Error("useIotDashboard 必须在 IotDashboardProvider 内使用。");
  }
  return controller;
}
