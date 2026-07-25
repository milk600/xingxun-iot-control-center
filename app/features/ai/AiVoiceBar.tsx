"use client";

import { AlertTriangle, ArrowRight, Bot, Check, ChevronUp, Circle, LoaderCircle, Mic, Radio, RotateCcw, Send, Settings2, Square, X, Zap } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AGENT_CAPABILITY_GROUPS } from "@/app/lib/ai/action-registry";
import type { PendingVehicleCommand } from "@/app/lib/ai/contracts";
import { getScaledMotionDurationMs } from "@/app/lib/ui-preferences";
import { AnimatedSelect } from "@/app/features/ui/AnimatedSelect";
import { useAndroidBack } from "@/app/features/ui/useAndroidBack";
import { AI_ACTION_EVENT, useAiControl } from "./AiControlContext";
import {
  CLIENT_ROLE_OPTIONS,
  REASONING_EFFORT_OPTIONS,
  THINKING_MODE_OPTIONS,
} from "./agent-preference-options";
import {
  androidAgentPanelDismissOffset,
  shouldDismissAndroidAgentPanel,
} from "./android-agent-panel-gesture";
import styles from "./AiVoiceBar.module.css";

const AUTO_HIDE_DELAY_MS = 3_000;
const BOTTOM_WAKE_DISTANCE_PX = 36;
const FOCUS_PRESENTATION_MS = 5_400;

const PHASE_LABEL = {
  idle: "按住说话",
  listening: "正在聆听",
  understanding: "正在理解",
  confirming: "等待确认",
  executing: "正在执行",
  speaking: "已完成",
  error: "出现问题",
};

type AiPanelView = "conversation" | "settings";

interface LeavingPanelView {
  view: AiPanelView;
  node: ReactNode;
  sequence: number;
  direction: "forward" | "back";
}

interface PanelDragSession {
  pointerId: number;
  startedAt: number;
  startY: number;
  distance: number;
}

function AiPanelTransition({ view, children }: { view: AiPanelView; children: ReactNode }) {
  const previousViewRef = useRef(view);
  const previousNodeRef = useRef(children);
  const sequenceRef = useRef(0);
  const currentRef = useRef<HTMLDivElement | null>(null);
  const leavingTimerRef = useRef<number | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [leaving, setLeaving] = useState<LeavingPanelView | null>(null);

  useLayoutEffect(() => {
    if (previousViewRef.current !== view) {
      const sequence = ++sequenceRef.current;
      const direction = view === "settings" ? "forward" : "back";
      setLeaving({
        view: previousViewRef.current,
        node: previousNodeRef.current,
        sequence,
        direction,
      });
      if (leavingTimerRef.current !== null) window.clearTimeout(leavingTimerRef.current);
      leavingTimerRef.current = window.setTimeout(() => {
        setLeaving((current) => current?.sequence === sequence ? null : current);
        leavingTimerRef.current = null;
      }, getScaledMotionDurationMs(220) + 48);
      previousViewRef.current = view;
    }
    previousNodeRef.current = children;
  }, [children, view]);

  useLayoutEffect(() => {
    const current = currentRef.current;
    if (!current) return;
    const measure = () => setHeight((value) => {
      const next = current.scrollHeight;
      return value === next ? value : next;
    });
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(current);
    return () => observer.disconnect();
  }, [view]);

  useEffect(() => () => {
    if (leavingTimerRef.current !== null) window.clearTimeout(leavingTimerRef.current);
  }, []);

  const direction = view === "settings" ? "forward" : "back";
  return (
    <div className={styles.panelSwitcher} style={height === null ? undefined : { height }}>
      {leaving && (
        <div
          key={`leaving-${leaving.view}-${leaving.sequence}`}
          className={`${styles.panelSwitchLayer} ${styles.panelSwitchLeaving} ${leaving.direction === "forward" ? styles.panelSwitchExitForward : styles.panelSwitchExitBack}`}
          aria-hidden="true"
          inert
        >
          {leaving.node}
        </div>
      )}
      <div
        key={`current-${view}`}
        ref={currentRef}
        className={`${styles.panelSwitchLayer} ${styles.panelSwitchCurrent} ${direction === "forward" ? styles.panelSwitchEnterForward : styles.panelSwitchEnterBack}`}
      >
        {children}
      </div>
    </div>
  );
}

export function AiVoiceBar() {
  const ai = useAiControl();
  const androidStandalone = typeof window !== "undefined" && window.location.hostname === "xingxun.local";
  const [expanded, setExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pairCode, setPairCode] = useState("");
  const [draft, setDraft] = useState("");
  const [autoHidden, setAutoHidden] = useState(false);
  const [focusPresentationActive, setFocusPresentationActive] = useState(false);
  const [panelDismissed, setPanelDismissed] = useState(false);
  const [panelDragY, setPanelDragY] = useState(0);
  const [panelDragging, setPanelDragging] = useState(false);
  const [panelDismissing, setPanelDismissing] = useState(false);
  const [hostDragY, setHostDragY] = useState(0);
  const [hostDragging, setHostDragging] = useState(false);
  const hostRef = useRef<HTMLElement | null>(null);
  const panelSurfaceRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const panelDragRef = useRef<PanelDragSession | null>(null);
  const hostDragRef = useRef<PanelDragSession | null>(null);
  const panelDismissTimerRef = useRef<number | null>(null);
  const suppressHandleClickRef = useRef(false);
  const inactivityTimerRef = useRef<number | null>(null);
  const focusPresentationTimerRef = useRef<number | null>(null);
  const autoHiddenRef = useRef(false);
  const manuallyHiddenRef = useRef(false);
  const interactionLockedRef = useRef(false);

  const taskExecuting = ai.executionProgress.totalSteps > ai.executionProgress.completedSteps;
  const taskFeedbackOpen = Boolean(ai.evidenceGuide) || (!focusPresentationActive
    && (taskExecuting || ["understanding", "executing", "confirming"].includes(ai.session.phase)));
  const panelRequestedOpen = expanded || Boolean(ai.pendingVehicle) || taskFeedbackOpen;
  const panelOpen = panelRequestedOpen && !(androidStandalone && panelDismissed);
  const activePlanStep = ai.executionProgress.activeStep;
  const planFinished = ai.plan !== null
    && ai.executionProgress.totalSteps > 0
    && ai.executionProgress.completedSteps >= ai.executionProgress.totalSteps;
  const currentPlanStep = ai.plan?.steps.find((step) => step.index === activePlanStep) ?? null;
  const currentPlanningStatus = ai.planningProgress?.stages.find(
    (stage) => stage.id === ai.planningProgress?.currentStageId,
  )?.status;
  const phaseLabel = ai.canRetryLastRequest
    ? "任务可重试"
    : taskExecuting && ai.session.phase !== "understanding"
    ? PHASE_LABEL.executing
    : ai.session.phase === "understanding" && ai.planningProgress
      ? `${ai.planningProgress.currentLabel} ${ai.planningProgress.progressPercent}%`
      : PHASE_LABEL[ai.session.phase];

  const interactionLocked = ai.isRecording
    || taskExecuting
    || Boolean(ai.evidenceGuide)
    || Boolean(ai.pendingVehicle)
    || ["listening", "understanding", "confirming", "executing"].includes(ai.session.phase);

  const clearPanelDismissTimer = useCallback(() => {
    if (panelDismissTimerRef.current === null) return;
    window.clearTimeout(panelDismissTimerRef.current);
    panelDismissTimerRef.current = null;
  }, []);

  const resetPanelMotion = useCallback(() => {
    clearPanelDismissTimer();
    panelDragRef.current = null;
    setPanelDragY(0);
    setPanelDragging(false);
    setPanelDismissing(false);
  }, [clearPanelDismissTimer]);

  const revealPanel = useCallback(() => {
    resetPanelMotion();
    setPanelDismissed(false);
    setExpanded(true);
  }, [resetPanelMotion]);

  const collapsePanel = useCallback(() => {
    resetPanelMotion();
    setSettingsOpen(false);
    setExpanded(false);
    if (androidStandalone) setPanelDismissed(true);
  }, [androidStandalone, resetPanelMotion]);

  const animatePanelDismissal = useCallback(() => {
    if (!androidStandalone || !panelOpen) {
      collapsePanel();
      return;
    }
    clearPanelDismissTimer();
    const panelHeight = panelSurfaceRef.current?.getBoundingClientRect().height ?? 0;
    setPanelDragging(false);
    setPanelDismissing(true);
    setPanelDragY(androidAgentPanelDismissOffset(panelHeight));
    const duration = getScaledMotionDurationMs(210);
    if (duration <= 0) {
      collapsePanel();
      return;
    }
    panelDismissTimerRef.current = window.setTimeout(() => {
      panelDismissTimerRef.current = null;
      collapsePanel();
    }, duration + 24);
  }, [androidStandalone, clearPanelDismissTimer, collapsePanel, panelOpen]);

  useAndroidBack(settingsOpen || expanded || (androidStandalone && panelOpen), () => {
    if (settingsOpen) setSettingsOpen(false);
    else collapsePanel();
  }, 60);

  useEffect(() => () => clearPanelDismissTimer(), [clearPanelDismissTimer]);

  useEffect(() => {
    if (panelOpen) return;
    panelDragRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      setPanelDragY(0);
      setPanelDragging(false);
      setPanelDismissing(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panelOpen]);

  const clearInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current === null) return;
    window.clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = null;
  }, []);

  const hideControls = useCallback((manual = false) => {
    clearInactivityTimer();
    hostDragRef.current = null;
    manuallyHiddenRef.current = manual;
    autoHiddenRef.current = true;
    setHostDragging(false);
    setHostDragY(0);
    setAutoHidden(true);
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && hostRef.current?.contains(activeElement)) {
      activeElement.blur();
    }
  }, [clearInactivityTimer]);

  const scheduleAutoHide = useCallback(() => {
    clearInactivityTimer();
    // Android is hidden only by an explicit downward swipe and always leaves a
    // visible restore control. Desktop keeps its inactivity behavior.
    if (androidStandalone) return;
    if (interactionLockedRef.current) return;

    inactivityTimerRef.current = window.setTimeout(() => {
      inactivityTimerRef.current = null;
      if (interactionLockedRef.current) return;

      const activeElement = document.activeElement;
      const editingInside = activeElement instanceof HTMLElement
        && hostRef.current?.contains(activeElement)
        && (activeElement.matches("input, textarea, select, [contenteditable='true']") || activeElement.isContentEditable);
      if (editingInside) return;

      if (activeElement instanceof HTMLElement && hostRef.current?.contains(activeElement)) {
        activeElement.blur();
      }
      hideControls(false);
    }, AUTO_HIDE_DELAY_MS);
  }, [androidStandalone, clearInactivityTimer, hideControls]);

  const revealControls = useCallback(() => {
    hostDragRef.current = null;
    manuallyHiddenRef.current = false;
    setHostDragging(false);
    setHostDragY(0);
    if (autoHiddenRef.current) {
      autoHiddenRef.current = false;
      setAutoHidden(false);
    }
    scheduleAutoHide();
  }, [scheduleAutoHide]);

  useEffect(() => {
    interactionLockedRef.current = interactionLocked;
    if (interactionLocked) {
      clearInactivityTimer();
      if (manuallyHiddenRef.current) return;
      const wasHidden = autoHiddenRef.current;
      autoHiddenRef.current = false;
      if (!wasHidden) return;
      const revealFrame = window.requestAnimationFrame(() => setAutoHidden(false));
      return () => window.cancelAnimationFrame(revealFrame);
    }
    scheduleAutoHide();
  }, [clearInactivityTimer, interactionLocked, scheduleAutoHide]);

  useEffect(() => {
    const wakeFromBottom = (event: globalThis.PointerEvent) => {
      if (
        autoHiddenRef.current
        && event.pointerType === "mouse"
        && event.clientY >= window.innerHeight - BOTTOM_WAKE_DISTANCE_PX
      ) {
        revealControls();
      }
    };
    window.addEventListener("pointermove", wakeFromBottom, { passive: true });
    return () => window.removeEventListener("pointermove", wakeFromBottom);
  }, [revealControls]);

  useEffect(() => () => clearInactivityTimer(), [clearInactivityTimer]);

  useEffect(() => {
    const handleAction = (event: Event) => {
      const action = (event as CustomEvent<{ name?: string }>).detail;
      if (action?.name !== "ui.focus_region" && action?.name !== "ui.scroll" && action?.name !== "ui.back") return;
      setExpanded(false);
      setSettingsOpen(false);
      setFocusPresentationActive(true);
      if (focusPresentationTimerRef.current !== null) {
        window.clearTimeout(focusPresentationTimerRef.current);
      }
      focusPresentationTimerRef.current = window.setTimeout(() => {
        focusPresentationTimerRef.current = null;
        setFocusPresentationActive(false);
      }, action.name === "ui.focus_region" ? FOCUS_PRESENTATION_MS : 1_600);
    };
    window.addEventListener(AI_ACTION_EVENT, handleAction);
    return () => {
      if (focusPresentationTimerRef.current !== null) {
        window.clearTimeout(focusPresentationTimerRef.current);
      }
      window.removeEventListener(AI_ACTION_EVENT, handleAction);
    };
  }, []);

  useEffect(() => {
    if (!ai.evidenceGuide) return;
    if (focusPresentationTimerRef.current !== null) {
      window.clearTimeout(focusPresentationTimerRef.current);
      focusPresentationTimerRef.current = null;
    }
    const frame = window.requestAnimationFrame(() => setFocusPresentationActive(false));
    return () => window.cancelAnimationFrame(frame);
  }, [ai.evidenceGuide]);

  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (ai.connection !== "online") { revealPanel(); setSettingsOpen(true); return; }
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    void ai.beginListening();
  };
  const stop = (event?: ReactPointerEvent<HTMLButtonElement>) => {
    if (event && pointerIdRef.current !== null && event.pointerId !== pointerIdRef.current) return;
    pointerIdRef.current = null;
    ai.endListening();
    if (event && document.activeElement === event.currentTarget) event.currentTarget.blur();
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === " " || event.key === "Enter") && !event.repeat) {
      event.preventDefault(); void ai.beginListening();
    }
  };

  const submitText = () => {
    const value = draft.trim();
    if (!value) return;
    ai.ask(value); setDraft(""); revealPanel();
  };
  const retryLastTask = () => {
    ai.retryLastRequest();
    revealPanel();
  };

  const startPanelDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!androidStandalone || event.button !== 0 || panelDismissing) return;
    clearPanelDismissTimer();
    suppressHandleClickRef.current = false;
    panelDragRef.current = {
      pointerId: event.pointerId,
      startedAt: performance.now(),
      startY: event.clientY,
      distance: 0,
    };
    setHostDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const movePanelDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = panelDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientY - drag.startY);
    drag.distance = distance;
    if (distance > 6) suppressHandleClickRef.current = true;
    setHostDragY(distance);
  };

  const finishPanelDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    cancelled = false,
  ) => {
    const drag = panelDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    panelDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const hostHeight = hostRef.current?.getBoundingClientRect().height ?? 0;
    const shouldHide = !cancelled && shouldDismissAndroidAgentPanel(
      drag.distance,
      performance.now() - drag.startedAt,
      hostHeight,
    );
    setHostDragging(false);
    if (shouldHide) hideControls(true);
    else setHostDragY(0);
  };

  const startHostDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!androidStandalone || autoHidden || event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, input, textarea, select, a")) return;
    hostDragRef.current = {
      pointerId: event.pointerId,
      startedAt: performance.now(),
      startY: event.clientY,
      distance: 0,
    };
    setHostDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveHostDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = hostDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientY - drag.startY);
    drag.distance = distance;
    setHostDragY(distance);
  };

  const finishHostDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled = false,
  ) => {
    const drag = hostDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    hostDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const shouldHide = !cancelled && shouldDismissAndroidAgentPanel(
      drag.distance,
      performance.now() - drag.startedAt,
      event.currentTarget.getBoundingClientRect().height,
    );
    setHostDragging(false);
    if (shouldHide) hideControls(true);
    else setHostDragY(0);
  };

  return (
    <>
    <section
      ref={hostRef}
      className={`${styles.host}${androidStandalone ? ` ${styles.androidHost}` : ""}${hostDragging ? ` ${styles.hostDragging}` : ""}${panelOpen ? ` ${styles.expanded}` : ""}${autoHidden ? ` ${styles.hostHidden}` : ""}${ai.evidenceGuide ? ` ${styles.guideHost}` : ""}`}
      style={{ "--ai-host-drag-y": `${hostDragY}px` } as CSSProperties}
      aria-label="AI 智能中枢"
      aria-hidden={autoHidden || undefined}
      onPointerDown={revealControls}
      onPointerMove={revealControls}
      onKeyDownCapture={revealControls}
      onFocusCapture={revealControls}
      onBlurCapture={scheduleAutoHide}
    >
      {panelOpen && (
        <div
          ref={panelSurfaceRef}
          className={`${styles.panelDragSurface}${panelDragging ? ` ${styles.panelDragSurfaceDragging}` : ""}${panelDismissing ? ` ${styles.panelDragSurfaceDismissing}` : ""}`}
          style={{ "--ai-panel-drag-y": `${panelDragY}px` } as CSSProperties}
        >
        <div className={styles.panel}>
          <header>
            <span><Bot size={18} />智能中枢</span>
            {androidStandalone && (
              <button
                type="button"
                className={styles.androidDragHandle}
                aria-label="向下滑动收起智能中枢"
                title="向下滑动收起"
                onPointerDown={startPanelDrag}
                onPointerMove={movePanelDrag}
                onPointerUp={(event) => finishPanelDrag(event)}
                onPointerCancel={(event) => finishPanelDrag(event, true)}
                onLostPointerCapture={(event) => finishPanelDrag(event, true)}
                onClick={() => {
                  if (suppressHandleClickRef.current) {
                    suppressHandleClickRef.current = false;
                    return;
                  }
                  hideControls(true);
                }}
              ><span aria-hidden="true" /></button>
            )}
            <div>
              <i className={styles[`status_${ai.connection}`]} aria-hidden="true" />
              <button type="button" aria-label="智能中枢设置" onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={17} /></button>
              <button
                type="button"
                aria-label="收起智能中枢"
                aria-expanded={panelOpen}
                onClick={androidStandalone ? animatePanelDismissal : collapsePanel}
              ><X size={17} /></button>
            </div>
          </header>

          <AiPanelTransition view={settingsOpen && !taskFeedbackOpen ? "settings" : "conversation"}>
          {settingsOpen && !taskFeedbackOpen ? (
            <div className={styles.settings}>
              <div className={styles.agentProfile}>
                <span><Bot size={16} /><strong>{ai.runtimeProfile.model}</strong></span>
                <small>{ai.runtimeProfile.reasoningMode === "thinking"
                  ? `思考模式 · ${ai.runtimeProfile.reasoningEffort === "max" ? "最高" : "标准"}推理`
                  : "非思考模式"}{ai.runtimeProfile.fullAccess ? " · 完整权限" : ""}</small>
              </div>
              <section className={styles.capabilities} aria-label="Agent 可控制功能">
                <header><strong>可控制功能</strong><span>{AGENT_CAPABILITY_GROUPS.reduce((total, group) => total + group.actions.length, 0)} 项原子动作</span></header>
                <div>
                  {AGENT_CAPABILITY_GROUPS.map((group) => (
                    <article key={group.id}>
                      <strong>{group.label}</strong>
                      <span>{group.summary}</span>
                      <button type="button" onClick={() => { setDraft(group.examples[0]); setSettingsOpen(false); }}>
                        {group.examples[0]}
                      </button>
                    </article>
                  ))}
                </div>
              </section>
              <label>智能中枢地址<input value={typeof window !== "undefined" && window.location.hostname === "xingxun.local" ? "设备内置智能中枢" : ai.preferences.gatewayUrl} readOnly={typeof window !== "undefined" && window.location.hostname === "xingxun.local"} onChange={(event) => ai.updatePreferences({ ...ai.preferences, gatewayUrl: event.target.value })} /></label>
              <div className={styles.selectSetting}><span>设备角色</span><AnimatedSelect compact ariaLabel="设备角色" value={ai.preferences.clientRole} options={CLIENT_ROLE_OPTIONS} disabled={typeof window !== "undefined" && window.location.hostname === "xingxun.local"} onChange={(clientRole) => ai.updatePreferences({ ...ai.preferences, clientRole })} /></div>
              <div className={styles.selectSetting}><span>思考模式</span><AnimatedSelect compact ariaLabel="思考模式" value={ai.preferences.thinkingMode} options={THINKING_MODE_OPTIONS} onChange={(thinkingMode) => ai.updatePreferences({ ...ai.preferences, thinkingMode })} /></div>
              <div className={styles.selectSetting}><span>推理强度</span><AnimatedSelect compact ariaLabel="推理强度" value={ai.preferences.reasoningEffort} options={REASONING_EFFORT_OPTIONS} disabled={ai.preferences.thinkingMode === "non-thinking"} onChange={(reasoningEffort) => ai.updatePreferences({ ...ai.preferences, reasoningEffort })} /></div>
              {ai.connection === "pairing" && <div className={styles.pair}><input inputMode="numeric" maxLength={6} placeholder="六位配对码" value={pairCode} onChange={(event) => setPairCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /><button type="button" onClick={() => ai.pair(pairCode)}>配对</button></div>}
              <label className={styles.switchRow}><span>语音播报</span><input type="checkbox" checked={ai.preferences.voicePlaybackEnabled} onChange={(event) => ai.updatePreferences({ ...ai.preferences, voicePlaybackEnabled: event.target.checked })} /></label>
              <label className={styles.switchRow}><span>允许 AI 自主控制小车</span><input type="checkbox" checked={ai.runtimeProfile.fullAccess || ai.preferences.realVehicleEnabled} disabled={ai.runtimeProfile.fullAccess} onChange={(event) => ai.updatePreferences({ ...ai.preferences, realVehicleEnabled: event.target.checked })} /></label>
              <label className={styles.switchRow}><span>允许 AI 处理告警工单</span><input type="checkbox" checked={ai.runtimeProfile.fullAccess || ai.preferences.alertWorkOrderAutomationEnabled} disabled={ai.runtimeProfile.fullAccess} onChange={(event) => ai.updatePreferences({ ...ai.preferences, alertWorkOrderAutomationEnabled: event.target.checked })} /></label>
            </div>
          ) : (
            <>
              <div className={`${styles.conversation}${ai.evidenceGuide ? ` ${styles.guideConversation}` : ""}`} aria-live="polite">
                {ai.session.transcript && <p><span>你</span>{ai.session.transcript}</p>}
                {(
                  ai.session.phase === "understanding"
                  || ai.session.phase === "executing"
                  || (ai.session.phase === "error" && ai.planningProgress)
                ) && ai.planningProgress && (
                  <section
                    className={styles.planningProgress}
                    aria-label="理解、规划与执行进度"
                    style={{ "--ai-planning-progress": `${ai.planningProgress.progressPercent}%` } as CSSProperties}
                  >
                    <header>
                      <strong>理解、规划与执行</strong>
                      <output aria-live="off">约 {ai.planningProgress.progressPercent}%</output>
                    </header>
                    <div
                      className={styles.planningProgressTrack}
                      role="progressbar"
                      aria-label="任务完成度"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={ai.planningProgress.progressPercent}
                    ><i /></div>
                    <div
                      key={`${ai.planningProgress.requestId}-${ai.planningProgress.currentStageId}`}
                      className={styles.planningCurrent}
                      data-status={currentPlanningStatus}
                    >
                      <span>
                        {currentPlanningStatus === "error"
                          ? <X size={13} />
                          : currentPlanningStatus === "complete"
                            ? <Check size={13} />
                            : <LoaderCircle size={13} />}
                        {ai.planningProgress.currentLabel}
                      </span>
                      <p>{ai.planningProgress.currentSummary}</p>
                    </div>
                    <ol className={styles.planningStages}>
                      {ai.planningProgress.stages.map((stage) => (
                        <li
                          key={`${ai.planningProgress?.requestId}-${stage.id}`}
                          data-status={stage.status}
                          aria-current={stage.id === ai.planningProgress?.currentStageId ? "step" : undefined}
                        >
                          <i aria-hidden="true">
                            {stage.status === "complete"
                              ? <Check size={11} />
                              : stage.status === "active"
                                ? <LoaderCircle size={11} />
                                : stage.status === "error"
                                  ? <X size={11} />
                                  : <Circle size={8} />}
                          </i>
                          <span>{stage.label}</span>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
                {ai.plan && (
                  <div className={styles.plan}>
                    <header>
                      <strong>执行计划</strong>
                      <span>{ai.plan.planQuality === "best-effort" ? "尽力修复并继续" : "Flash 思考"}</span>
                    </header>
                    {ai.plan.warnings?.length ? (
                      <div className={styles.planWarnings} role="status">
                        <AlertTriangle size={14} aria-hidden="true" />
                        <span>{ai.plan.warnings.join("；")}</span>
                      </div>
                    ) : null}
                    <ol>{ai.plan.steps.map((step) => {
                      const status = planFinished || step.index <= ai.executionProgress.completedSteps
                        ? "complete"
                        : step.index === activePlanStep
                          ? "active"
                          : "pending";
                      return (
                        <li key={`${ai.plan?.id}-${step.index}`} data-status={status} aria-current={status === "active" ? "step" : undefined}>
                          <i aria-hidden="true">{status === "complete" ? <Check size={13} /> : status === "active" ? <LoaderCircle size={13} /> : <span>{step.index}</span>}</i>
                          <span>{step.label}</span>
                        </li>
                      );
                    })}</ol>
                  </div>
                )}
                {ai.evidenceGuide && (
                  <section
                    className={styles.evidenceGuide}
                    data-status={ai.evidenceGuide.availability}
                    data-phase={ai.evidenceGuide.phase}
                    aria-label="AI 分步证据导览"
                  >
                    <header>
                      <span>{ai.evidenceGuide.phase === "complete" ? "综合结论" : `当前证据 ${ai.evidenceGuide.position}/${ai.evidenceGuide.total}`}</span>
                      {ai.evidenceGuide.availability === "loading"
                        ? <small>调取数据</small>
                        : ai.evidenceGuide.availability !== "available" && <small>数据有限</small>}
                    </header>
                    {ai.evidenceGuide.phase !== "complete" ? (
                      <>
                        <strong>{ai.evidenceGuide.title}</strong>
                        <p>{ai.evidenceGuide.explanation}</p>
                        <div className={styles.evidenceGuideActions}>
                          <button type="button" disabled={ai.evidenceGuide.phase === "advancing"} onClick={ai.endEvidenceGuide}>结束讲解</button>
                          <button type="button" disabled={ai.evidenceGuide.phase === "advancing" || ai.evidenceGuide.availability === "loading"} className={styles.evidenceGuideContinue} onClick={ai.continueEvidenceGuide}>
                            {ai.evidenceGuide.availability === "loading" ? "分析中" : ai.evidenceGuide.position >= ai.evidenceGuide.total ? "查看结论" : "继续"}<ArrowRight size={14} />
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p>{ai.evidenceGuide.conclusion ?? ai.evidenceGuide.explanation}</p>
                        <div className={styles.evidenceGuideActions}>
                          <button type="button" className={styles.evidenceGuideContinue} onClick={ai.endEvidenceGuide}>完成</button>
                        </div>
                      </>
                    )}
                  </section>
                )}
                {(currentPlanStep || ai.session.publicAction) && <p className={styles.action}><Zap size={15} />{currentPlanStep ? `${activePlanStep}/${ai.executionProgress.totalSteps} ${currentPlanStep.label}` : ai.session.publicAction}</p>}
                {ai.session.reply && !taskExecuting && <p><span>AI</span>{ai.session.reply}</p>}
                {ai.session.error && <p className={styles.error}>{ai.session.error}</p>}
                {ai.hasRetryableRequest && (
                  <div className={styles.retryPrompt} role="group" aria-label="重新执行失败的任务">
                    <span>{ai.canRetryLastRequest
                      ? "可以使用相同指令从头重新规划，旧任务回执不会继续生效。"
                      : "上一项未完成任务已保留；当前任务结束后可以从头重试。"}</span>
                    <button
                      type="button"
                      disabled={!ai.canRetryLastRequest}
                      onClick={retryLastTask}
                    >
                      <RotateCcw size={15} aria-hidden="true" />重试本次任务
                    </button>
                  </div>
                )}
                {!ai.session.transcript && !ai.session.reply && <p className={styles.empty}>描述你想达到的结果，Agent 会先规划，再组合页面、数据、空间与控制动作。</p>}
              </div>
              {!ai.evidenceGuide && <form className={styles.textInput} onSubmit={(event) => { event.preventDefault(); submitText(); }}>
                <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="也可以输入指令" />
                <button type="submit" aria-label="发送文字指令"><Send size={16} /></button>
              </form>}
            </>
          )}
          </AiPanelTransition>

          {ai.pendingVehicle && (
            <div className={styles.confirmation} role="alertdialog" aria-label="小车任务确认">
              <div><strong>确认小车任务</strong><span>{pendingVehicleText(ai.pendingVehicle)}</span></div>
              <button type="button" onClick={ai.cancelVehicle}><X size={16} />取消</button>
              <button type="button" className={styles.confirmButton} onClick={ai.confirmVehicle}><Check size={16} />确认</button>
            </div>
          )}
        </div>
        </div>
      )}

      <div
        className={`${styles.bar}${ai.hasRetryableRequest ? ` ${styles.barRetry}` : ""}`}
        role="toolbar"
        aria-label={androidStandalone ? "Agent 功能栏，向下滑动可收起" : "Agent 功能栏"}
        title={androidStandalone ? "向下滑动收起 Agent 功能栏" : undefined}
        onPointerDown={startHostDrag}
        onPointerMove={moveHostDrag}
        onPointerUp={(event) => finishHostDrag(event)}
        onPointerCancel={(event) => finishHostDrag(event, true)}
        onLostPointerCapture={(event) => finishHostDrag(event, true)}
      >
        <button
          type="button"
          className={styles.expandButton}
          aria-label={panelOpen ? "收起智能中枢" : "展开智能中枢"}
          aria-expanded={panelOpen}
          onClick={() => {
            if (panelOpen) {
              if (androidStandalone) animatePanelDismissal();
              else collapsePanel();
            } else {
              revealPanel();
            }
          }}
        ><ChevronUp size={17} /></button>
        <span className={styles.state}><i className={styles[`status_${ai.connection}`]} /><strong>{phaseLabel}</strong></span>
        {ai.hasRetryableRequest && (
          <button
            type="button"
            className={styles.retryBarButton}
            aria-label="重试本次任务"
            title={ai.canRetryLastRequest ? "使用上一条未完成指令从头重试" : "当前任务结束后可重试上一项任务"}
            disabled={!ai.canRetryLastRequest}
            onClick={retryLastTask}
          ><RotateCcw size={17} aria-hidden="true" /></button>
        )}
        <button
          type="button"
          className={`${styles.micButton}${ai.isRecording ? ` ${styles.recording}` : ""}`}
          aria-label="按住说话"
          onPointerDown={start}
          onPointerUp={stop}
          onPointerCancel={stop}
          onLostPointerCapture={stop}
          onKeyDown={keyDown}
          onKeyUp={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); ai.endListening(); } }}
        >{ai.isRecording ? <Square size={16} fill="currentColor" /> : <Mic size={19} />}</button>
        <button type="button" className={styles.stopButton} aria-label="立即停止小车" title="立即停止小车" onClick={ai.emergencyStop}><Radio size={17} /></button>
      </div>
    </section>
    <button
      type="button"
      className={`${styles.wakeZone}${androidStandalone ? ` ${styles.androidWakeZone}` : ""}${autoHidden ? ` ${styles.wakeZoneVisible}` : ""}`}
      aria-label="显示 AI 智能中枢"
      aria-hidden={!autoHidden || undefined}
      tabIndex={autoHidden ? 0 : -1}
      onPointerEnter={revealControls}
      onPointerDown={revealControls}
      onClick={revealControls}
      onFocus={revealControls}
    >{androidStandalone && <><Bot size={15} aria-hidden="true" /><span>AI</span><ChevronUp size={14} aria-hidden="true" /></>}</button>
    </>
  );
}

function motionText(value: string) {
  return ({ forward: "前进", backward: "后退", left: "左转", right: "右转" } as Record<string, string>)[value] ?? value;
}

function pendingVehicleText(command: PendingVehicleCommand) {
  if (command.kind === "timed") {
    return `${motionText(command.motion)} · ${command.speedPercent}% · ${(command.durationMs / 1000).toFixed(1)} 秒`;
  }
  if (command.kind === "distance") {
    return `${command.direction === "forward" ? "前进" : "后退"} · ${command.distanceMm} 毫米 · 最大 ${command.maxSpeedMmps} 毫米/秒`;
  }
  return `${command.direction === "left" ? "左转" : "右转"} · ${command.angleDeg} 度 · 最大 ${command.maxSpeedMmps} 毫米/秒`;
}
