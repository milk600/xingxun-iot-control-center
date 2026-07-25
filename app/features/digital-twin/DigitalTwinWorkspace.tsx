"use client";

import {
  ArrowLeft,
  FileUp,
  Layers3,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  ScanSearch,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useNavigationTransition } from "@/app/features/transitions/NavigationTransition";
import { useAndroidBack } from "@/app/features/ui/useAndroidBack";
import { getDashboardSnapshot } from "@/app/lib/iot/client";
import {
  createInitialSnapshot,
  type DashboardSnapshot,
} from "@/app/lib/iot/contracts";
import {
  getTwinModelExtension,
  ROOM_ONE_ANCHORS,
  TWIN_MODEL_EXTENSIONS,
  type TwinDisplayMode,
  type TwinViewportAppearance,
} from "@/app/lib/digital-twin/contracts";
import { assertLocalModelFileSize } from "@/app/lib/digital-twin/model-safety";
import { getScaledMotionDurationMs } from "@/app/lib/ui-preferences";
import {
  AI_ACTION_EVENT,
  registerActionReceiver,
  readActionDispatchDetail,
  reportActionError,
  reportActionSuccess,
} from "@/app/lib/ai/action-events";
import type { AgentActionDispatchDetail } from "@/app/lib/ai/contracts";
import {
  GaussianSplatViewport,
  type TwinModelState,
} from "./GaussianSplatViewport";
import {
  loadRoomOneTwinSceneFiles,
  type RoomOneTwinSceneFiles,
} from "./preloadRoomOneTwinScene";
import {
  DIGITAL_TWIN_NAVIGATION_START,
  isDigitalTwinExitNavigation,
} from "./digitalTwinNavigation";
import styles from "./DigitalTwinWorkspace.module.css";

const INITIAL_MODEL_STATE: TwinModelState = {
  phase: "idle",
  progress: 0,
  message: "正在准备默认场景",
  elementCount: null,
  modelKind: null,
  rendererLabel: null,
};

const INITIAL_APPEARANCE: TwinViewportAppearance = {
  displayMode: "enhanced",
  pointSize: 0.012,
  diagnosticActive: false,
};

type PanelTab = "scene" | "devices";
type MobileSheet = PanelTab | "display" | null;

function formatMetric(value: number | null, precision: number, unit: string) {
  if (value === null) return "--";
  return `${value.toFixed(precision)}${unit}`;
}

export function DigitalTwinWorkspace() {
  const navigation = useNavigationTransition();
  const pageRef = useRef<HTMLElement>(null);
  const navigationLeavingRef = useRef(false);
  const primaryInputRef = useRef<HTMLInputElement>(null);
  const manualPrimaryRef = useRef(false);
  const mobileSheetRef = useRef<HTMLElement>(null);
  const lastMobileTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileSheetOpenFrameRef = useRef<number | null>(null);
  const mobileSheetSecondFrameRef = useRef<number | null>(null);
  const mobileSheetCloseTimerRef = useRef<number | null>(null);
  const diagnosticPointerIdRef = useRef<number | null>(null);
  const diagnosticPersistentRef = useRef(false);
  const displayModeMidpointRef = useRef<number | null>(null);
  const displayModeRevealRef = useRef<number | null>(null);
  const displayModeSecondFrameRef = useRef<number | null>(null);
  const displayModeFinishRef = useRef<number | null>(null);
  const displayModeSequenceRef = useRef(0);
  const pendingActionRef = useRef<AgentActionDispatchDetail | null>(null);
  const [sceneFiles, setSceneFiles] = useState<RoomOneTwinSceneFiles | null>(null);
  const [modelState, setModelState] = useState<TwinModelState>(INITIAL_MODEL_STATE);
  const [fileError, setFileError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(createInitialSnapshot);
  const [panelTab, setPanelTab] = useState<PanelTab>("scene");
  const [appearance, setAppearance] = useState<TwinViewportAppearance>(INITIAL_APPEARANCE);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [mobileSheet, setMobileSheet] = useState<MobileSheet>(null);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [displayModeTransitioning, setDisplayModeTransitioning] = useState(false);
  const [displayModeVeilDark, setDisplayModeVeilDark] = useState(false);

  const modelFile = sceneFiles?.primary ?? null;
  const gapFile = sceneFiles?.gap ?? null;
  const frameworkFile = sceneFiles?.framework ?? null;

  const closeMobileSheet = useCallback((restoreFocus = false) => {
    diagnosticPersistentRef.current = false;
    setAppearance((current) => ({ ...current, diagnosticActive: false }));
    diagnosticPointerIdRef.current = null;
    if (mobileSheetOpenFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileSheetOpenFrameRef.current);
      mobileSheetOpenFrameRef.current = null;
    }
    if (mobileSheetSecondFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileSheetSecondFrameRef.current);
      mobileSheetSecondFrameRef.current = null;
    }
    if (mobileSheetCloseTimerRef.current !== null) {
      window.clearTimeout(mobileSheetCloseTimerRef.current);
    }
    setMobileSheetOpen(false);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    mobileSheetCloseTimerRef.current = window.setTimeout(() => {
      setMobileSheet(null);
      mobileSheetCloseTimerRef.current = null;
      if (restoreFocus) {
        window.requestAnimationFrame(() => {
          lastMobileTriggerRef.current?.focus({ preventScroll: true });
        });
      }
    }, reducedMotion ? 0 : getScaledMotionDurationMs(280));
  }, []);

  useAndroidBack(mobileSheetOpen, () => closeMobileSheet(false), 70);

  useEffect(() => {
    let active = true;
    void loadRoomOneTwinSceneFiles().then(
      (files) => {
        if (!active || navigationLeavingRef.current || manualPrimaryRef.current) return;
        setSceneFiles(files);
        setFileError(null);
      },
      (error: unknown) => {
        if (!active || navigationLeavingRef.current || manualPrimaryRef.current) return;
        setFileError(
          error instanceof Error
            ? `默认模型未能自动载入：${error.message}`
            : "默认模型未能自动载入。",
        );
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => () => {
    displayModeSequenceRef.current += 1;
    if (displayModeMidpointRef.current !== null) window.clearTimeout(displayModeMidpointRef.current);
    if (displayModeRevealRef.current !== null) window.cancelAnimationFrame(displayModeRevealRef.current);
    if (displayModeSecondFrameRef.current !== null) window.cancelAnimationFrame(displayModeSecondFrameRef.current);
    if (displayModeFinishRef.current !== null) window.clearTimeout(displayModeFinishRef.current);
    if (mobileSheetOpenFrameRef.current !== null) window.cancelAnimationFrame(mobileSheetOpenFrameRef.current);
    if (mobileSheetSecondFrameRef.current !== null) window.cancelAnimationFrame(mobileSheetSecondFrameRef.current);
    if (mobileSheetCloseTimerRef.current !== null) window.clearTimeout(mobileSheetCloseTimerRef.current);
  }, []);

  useEffect(() => {
    const handleNavigationStart = (event: Event) => {
      if (!isDigitalTwinExitNavigation(event)) return;
      navigationLeavingRef.current = true;
      displayModeSequenceRef.current += 1;
      if (displayModeMidpointRef.current !== null) window.clearTimeout(displayModeMidpointRef.current);
      if (displayModeRevealRef.current !== null) window.cancelAnimationFrame(displayModeRevealRef.current);
      if (displayModeSecondFrameRef.current !== null) window.cancelAnimationFrame(displayModeSecondFrameRef.current);
      if (displayModeFinishRef.current !== null) window.clearTimeout(displayModeFinishRef.current);
      pageRef.current?.classList.add(styles.isNavigationLeaving);
    };
    window.addEventListener(DIGITAL_TWIN_NAVIGATION_START, handleNavigationStart);
    return () => {
      window.removeEventListener(DIGITAL_TWIN_NAVIGATION_START, handleNavigationStart);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const next = await getDashboardSnapshot(controller.signal);
        if (active && !navigationLeavingRef.current) setSnapshot(next);
      } catch {
        // Stable placeholder values remain visible while telemetry is unavailable.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3_500);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!appearance.diagnosticActive) return;
    const release = (event?: globalThis.PointerEvent) => {
      if (diagnosticPersistentRef.current) return;
      if (
        event &&
        diagnosticPointerIdRef.current !== null &&
        event.pointerId !== diagnosticPointerIdRef.current
      ) {
        return;
      }
      diagnosticPointerIdRef.current = null;
      setAppearance((current) => ({ ...current, diagnosticActive: false }));
    };
    const handleVisibility = () => {
      if (document.hidden) {
        diagnosticPersistentRef.current = false;
        release();
      }
    };
    const handleBlur = () => {
      diagnosticPersistentRef.current = false;
      release();
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [appearance.diagnosticActive]);

  useEffect(() => {
    if (!mobileSheet) return;
    const sheet = mobileSheetRef.current;
    if (!sheet) return;

    const getFocusableElements = () => Array.from(
      sheet.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute("hidden"));

    const focusFrame = window.requestAnimationFrame(() => {
      const first = getFocusableElements()[0] ?? sheet;
      first.focus({ preventScroll: true });
    });

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobileSheet(true);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        sheet.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !sheet.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !sheet.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeMobileSheet, mobileSheet]);

  const choosePrimary = useCallback(() => primaryInputRef.current?.click(), []);

  const handlePrimaryFile = (file: File | null) => {
    if (!file) return;
    try {
      const extension = getTwinModelExtension(file.name);
      if (!extension) {
        throw new Error(`暂不支持该文件。请选择 ${TWIN_MODEL_EXTENSIONS.join("、")} 格式。`);
      }
      if (file.size === 0) throw new Error("文件内容为空，请重新导出模型。");
      assertLocalModelFileSize(file.size);
      manualPrimaryRef.current = true;
      setFileError(null);
      setModelState({ ...INITIAL_MODEL_STATE, phase: "loading", message: "准备读取模型" });
      setSceneFiles({ primary: file, gap: null, framework: null });
    } catch (error: unknown) {
      setFileError(error instanceof Error ? error.message : "无法读取该模型文件。");
    }
  };

  const updateAppearance = useCallback(<K extends keyof TwinViewportAppearance,>(
    key: K,
    value: TwinViewportAppearance[K],
  ) => setAppearance((current) => ({ ...current, [key]: value })), []);

  const beginDisplayModeTransition = useCallback((nextMode: TwinDisplayMode) => {
    if (displayModeTransitioning || nextMode === appearance.displayMode) return false;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      updateAppearance("displayMode", nextMode);
      return true;
    }

    const sequence = ++displayModeSequenceRef.current;
    setDisplayModeTransitioning(true);
    setDisplayModeVeilDark(true);
    displayModeMidpointRef.current = window.setTimeout(() => {
      if (displayModeSequenceRef.current !== sequence) return;
      updateAppearance("displayMode", nextMode);
      displayModeRevealRef.current = window.requestAnimationFrame(() => {
        displayModeSecondFrameRef.current = window.requestAnimationFrame(() => {
          if (displayModeSequenceRef.current !== sequence) return;
          setDisplayModeVeilDark(false);
          displayModeFinishRef.current = window.setTimeout(() => {
            if (displayModeSequenceRef.current !== sequence) return;
            setDisplayModeTransitioning(false);
          }, getScaledMotionDurationMs(150));
        });
      });
    }, getScaledMotionDurationMs(110));
    return true;
  }, [appearance.displayMode, displayModeTransitioning, updateAppearance]);

  const beginDiagnostic = (event?: PointerEvent<HTMLButtonElement>) => {
    if (event && diagnosticPointerIdRef.current !== null) return;
    diagnosticPersistentRef.current = false;
    diagnosticPointerIdRef.current = event?.pointerId ?? null;
    event?.currentTarget.setPointerCapture?.(event.pointerId);
    setAppearance((current) => ({ ...current, diagnosticActive: true }));
  };

  const handleDiagnosticKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      diagnosticPersistentRef.current = false;
      setAppearance((current) => ({ ...current, diagnosticActive: true }));
    }
  };

  const releaseDiagnostic = (pointerId?: number) => {
    if (
      pointerId !== undefined &&
      diagnosticPointerIdRef.current !== null &&
      pointerId !== diagnosticPointerIdRef.current
    ) {
      return;
    }
    diagnosticPointerIdRef.current = null;
    diagnosticPersistentRef.current = false;
    setAppearance((current) => ({ ...current, diagnosticActive: false }));
  };

  const openMobileSheet = useCallback((next: Exclude<MobileSheet, null>) => {
    if (mobileSheetCloseTimerRef.current !== null) {
      window.clearTimeout(mobileSheetCloseTimerRef.current);
      mobileSheetCloseTimerRef.current = null;
    }
    setMobileSheet(next);
    setMobileSheetOpen(false);
    if (mobileSheetOpenFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileSheetOpenFrameRef.current);
    }
    if (mobileSheetSecondFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileSheetSecondFrameRef.current);
    }
    mobileSheetOpenFrameRef.current = window.requestAnimationFrame(() => {
      mobileSheetOpenFrameRef.current = null;
      mobileSheetSecondFrameRef.current = window.requestAnimationFrame(() => {
        mobileSheetSecondFrameRef.current = null;
        setMobileSheetOpen(true);
      });
    });
  }, []);

  const toggleMobileSheet = (
    next: Exclude<MobileSheet, null>,
    trigger: HTMLButtonElement,
  ) => {
    lastMobileTriggerRef.current = trigger;
    if (mobileSheet === next && mobileSheetOpen) {
      closeMobileSheet(false);
      return;
    }
    setAppearance((current) => ({ ...current, diagnosticActive: false }));
    diagnosticPointerIdRef.current = null;
    diagnosticPersistentRef.current = false;
    if (mobileSheet && mobileSheetOpen) {
      setMobileSheet(next);
      return;
    }
    openMobileSheet(next);
  };

  useEffect(() => {
    const handleAction = (event: Event) => {
      const action = readActionDispatchDetail(event);
      if (!action) return;
      if (action.name === "twin.set_display_mode") {
        if (
          appearance.displayMode === action.arguments.mode
          && !displayModeTransitioning
        ) {
          reportActionSuccess(action, "孪生显示模式已符合要求。");
          return;
        }
        pendingActionRef.current = action;
        if (!beginDisplayModeTransition(action.arguments.mode)) {
          pendingActionRef.current = null;
          reportActionError(action, "孪生显示模式正在切换，请稍后重试。");
        }
        return;
      }
      if (action.name === "twin.set_gap_diagnostic") {
        if (appearance.diagnosticActive === action.arguments.active) {
          reportActionSuccess(action, "缺口诊断图层状态已符合要求。");
          return;
        }
        pendingActionRef.current = action;
        diagnosticPointerIdRef.current = null;
        diagnosticPersistentRef.current = action.arguments.active;
        setAppearance((current) => ({ ...current, diagnosticActive: action.arguments.active }));
        return;
      }
      if (action.name === "twin.set_point_size") {
        const size = Math.min(0.024, Math.max(0.004, action.arguments.size));
        if (Math.abs(appearance.pointSize - size) <= 1e-6) {
          reportActionSuccess(action, "点尺寸已符合要求。");
          return;
        }
        pendingActionRef.current = action;
        setAppearance((current) => current.pointSize === size ? current : { ...current, pointSize: size });
        return;
      }
      if (action.name === "twin.open_panel") {
        pendingActionRef.current = action;
        if (window.matchMedia("(max-width: 767px)").matches) {
          openMobileSheet(action.arguments.panel);
          return;
        }
        closeMobileSheet(false);
        if (action.arguments.panel === "display") {
          setRightCollapsed(false);
        } else {
          setPanelTab(action.arguments.panel);
          setLeftCollapsed(false);
        }
        return;
      }
      if (action.name === "twin.close_panels") {
        pendingActionRef.current = action;
        if (window.matchMedia("(max-width: 767px)").matches) {
          closeMobileSheet(false);
        } else {
          setLeftCollapsed(true);
          setRightCollapsed(true);
        }
      }
    };
    window.addEventListener(AI_ACTION_EVENT, handleAction);
    const unregisterReceiver = registerActionReceiver([
      "twin.set_display_mode",
      "twin.set_gap_diagnostic",
      "twin.set_point_size",
      "twin.open_panel",
      "twin.close_panels",
    ]);
    return () => {
      unregisterReceiver();
      window.removeEventListener(AI_ACTION_EVENT, handleAction);
    };
  }, [
    appearance.diagnosticActive,
    appearance.displayMode,
    appearance.pointSize,
    beginDisplayModeTransition,
    closeMobileSheet,
    displayModeTransitioning,
    openMobileSheet,
  ]);

  useEffect(() => {
    const action = pendingActionRef.current;
    if (!action) return;
    if (
      action.name === "twin.set_display_mode"
      && appearance.displayMode === action.arguments.mode
      && !displayModeTransitioning
    ) {
      pendingActionRef.current = null;
      reportActionSuccess(action, "孪生显示模式切换完成。");
      return;
    }
    if (
      action.name === "twin.set_gap_diagnostic"
      && appearance.diagnosticActive === action.arguments.active
    ) {
      pendingActionRef.current = null;
      reportActionSuccess(action, "缺口诊断图层已更新。");
      return;
    }
    if (action.name === "twin.set_point_size") {
      const size = Math.min(0.024, Math.max(0.004, action.arguments.size));
      if (Math.abs(appearance.pointSize - size) <= 1e-6) {
        pendingActionRef.current = null;
        reportActionSuccess(action, "点尺寸已更新。");
      }
      return;
    }
    const mobile = window.matchMedia("(max-width: 767px)").matches;
    if (action.name === "twin.open_panel") {
      const opened = mobile
        ? mobileSheet === action.arguments.panel && mobileSheetOpen
        : action.arguments.panel === "display"
          ? !rightCollapsed
          : !leftCollapsed && panelTab === action.arguments.panel;
      if (opened) {
        pendingActionRef.current = null;
        reportActionSuccess(action, "孪生控制面板已打开。");
      }
      return;
    }
    if (action.name === "twin.close_panels") {
      const closed = mobile ? !mobileSheetOpen : leftCollapsed && rightCollapsed;
      if (closed) {
        pendingActionRef.current = null;
        reportActionSuccess(action, "孪生控制面板已收起。");
      }
    }
  }, [
    appearance.diagnosticActive,
    appearance.displayMode,
    appearance.pointSize,
    displayModeTransitioning,
    leftCollapsed,
    mobileSheet,
    mobileSheetOpen,
    panelTab,
    rightCollapsed,
  ]);

  const displayModes: Array<{ id: TwinDisplayMode; label: string }> = [
    { id: "color", label: "彩色" },
    { id: "enhanced", label: "增强" },
    { id: "geometry", label: "几何" },
  ];

  const sceneContent = (
    <div className={styles.sceneRows} aria-label="场景图层">
      <div><i className={styles.primaryDot} aria-hidden="true" /><span>彩色真实点云</span></div>
      <div><i className={styles.gapDot} aria-hidden="true" /><span>缺口诊断层</span></div>
      <div><i className={styles.frameworkDot} aria-hidden="true" /><span>房间几何框架</span></div>
    </div>
  );

  const deviceContent = (
    <ul className={styles.anchorList} aria-label="设备点位">
      {ROOM_ONE_ANCHORS.map((anchor) => {
        const slot = snapshot.slots[anchor.slotId];
        return (
          <li key={anchor.anchorId}>
            <span className={styles.anchorIcon}><MapPin size={15} /></span>
            <strong>{anchor.label}</strong>
            <b>{formatMetric(slot.value, slot.precision, slot.unit)}</b>
          </li>
        );
      })}
    </ul>
  );

  const displayContent = (
    <div className={styles.displayControls}>
      <div
        className={styles.displayModes}
        aria-label="显示模式"
        aria-busy={displayModeTransitioning || undefined}
      >
        {displayModes.map((mode) => (
          <button
            key={mode.id}
            type="button"
            className={appearance.displayMode === mode.id ? styles.isActive : undefined}
            aria-pressed={appearance.displayMode === mode.id}
            disabled={displayModeTransitioning}
            onClick={() => beginDisplayModeTransition(mode.id)}
          >{mode.label}</button>
        ))}
      </div>
      <label className={styles.rangeControl}>
        <span>点尺寸 <output>{appearance.pointSize.toFixed(3)}</output></span>
        <input
          type="range"
          min="0.004"
          max="0.024"
          step="0.001"
          value={appearance.pointSize}
          onChange={(event) => updateAppearance("pointSize", Number(event.target.value))}
        />
      </label>
    </div>
  );

  return (
    <main ref={pageRef} className={styles.page}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.backButton}
          aria-label="返回控制概览"
          title="返回控制概览"
          onClick={() => navigation.back("/")}
        >
          <ArrowLeft size={19} />
        </button>
        <h1>空间孪生</h1>
        <div className={styles.headerActions}>
          <input
            ref={primaryInputRef}
            className={styles.hiddenInput}
            type="file"
            aria-label="选择本地三维主模型"
            accept={TWIN_MODEL_EXTENSIONS.join(",")}
            onChange={(event) => {
              handlePrimaryFile(event.target.files?.[0] ?? null);
              event.currentTarget.value = "";
            }}
          />
          <button
            className={styles.importButton}
            type="button"
            onClick={choosePrimary}
            disabled={modelState.phase === "loading"}
          >
            <FileUp size={17} />
            <span>导入</span>
          </button>
        </div>
      </header>

      {fileError && (
        <div className={styles.inlineError} role="alert">
          <span>{fileError}</span>
          <button type="button" onClick={choosePrimary}>选择文件</button>
        </div>
      )}

      <section
        className={`${styles.workbench} ${leftCollapsed ? styles.leftCollapsed : ""} ${rightCollapsed ? styles.rightCollapsed : ""}`}
        aria-label="空间孪生工作区"
      >
        <aside className={`${styles.floatingPanel} ${styles.leftPanel} ${leftCollapsed ? styles.isCollapsed : ""}`}>
          <button
            type="button"
            className={styles.collapseButton}
            aria-label={leftCollapsed ? "展开场景面板" : "收起场景面板"}
            title={leftCollapsed ? "展开场景面板" : "收起场景面板"}
            onClick={() => setLeftCollapsed((current) => !current)}
          >
            {leftCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          {!leftCollapsed && (
            <>
              <div
                className={`${styles.panelTabs} ${panelTab === "devices" ? styles.showDevices : ""}`}
                role="tablist"
                aria-label="场景与设备"
              >
                <button type="button" role="tab" aria-selected={panelTab === "scene"} className={panelTab === "scene" ? styles.isActive : undefined} onClick={() => setPanelTab("scene")}>场景</button>
                <button type="button" role="tab" aria-selected={panelTab === "devices"} className={panelTab === "devices" ? styles.isActive : undefined} onClick={() => setPanelTab("devices")}>设备</button>
              </div>
              <div className={styles.panelBody}>
                <div className={`${styles.panelTrack} ${panelTab === "devices" ? styles.showDevices : ""}`}>
                  <div
                    className={styles.panelPage}
                    data-ai-region="scene-panel"
                    role="tabpanel"
                    aria-hidden={panelTab !== "scene"}
                  >
                    {sceneContent}
                  </div>
                  <div
                    className={styles.panelPage}
                    data-ai-region="device-panel"
                    role="tabpanel"
                    aria-hidden={panelTab !== "devices"}
                  >
                    {deviceContent}
                  </div>
                </div>
              </div>
            </>
          )}
        </aside>

        <article className={styles.stagePanel} data-ai-region="viewport">
          <GaussianSplatViewport
            file={modelFile}
            gapFile={gapFile}
            frameworkFile={frameworkFile}
            appearance={appearance}
            onStateChange={setModelState}
            onChooseFile={choosePrimary}
          />
          <div
            className={`${styles.displayModeVeil} ${displayModeVeilDark ? styles.isDark : ""} ${displayModeTransitioning ? styles.isTransitioning : ""}`}
            aria-hidden="true"
          />
          <button
            type="button"
            className={`${styles.diagnosticButton} ${appearance.diagnosticActive ? styles.isPressed : ""}`}
            disabled={!gapFile}
            aria-label="按住查看缺口；按住期间可用另一根手指移动模型"
            onPointerDown={beginDiagnostic}
            onPointerUp={(event) => releaseDiagnostic(event.pointerId)}
            onPointerCancel={(event) => releaseDiagnostic(event.pointerId)}
            onLostPointerCapture={(event) => releaseDiagnostic(event.pointerId)}
            onKeyDown={handleDiagnosticKeyDown}
            onKeyUp={() => releaseDiagnostic()}
            onBlur={() => releaseDiagnostic()}
          >
            <ScanSearch size={17} />
            <span>{appearance.diagnosticActive ? "正在显示缺口" : "按住查看缺口"}</span>
          </button>
        </article>

        <aside className={`${styles.floatingPanel} ${styles.rightPanel} ${rightCollapsed ? styles.isCollapsed : ""}`} data-ai-region="display-panel">
          <button
            type="button"
            className={styles.collapseButton}
            aria-label={rightCollapsed ? "展开显示面板" : "收起显示面板"}
            title={rightCollapsed ? "展开显示面板" : "收起显示面板"}
            onClick={() => setRightCollapsed((current) => !current)}
          >
            {rightCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
          </button>
          {!rightCollapsed && displayContent}
        </aside>
      </section>

      <nav className={styles.mobileDock} aria-label="数字孪生移动工具">
        <button type="button" aria-pressed={mobileSheetOpen && mobileSheet === "scene"} onClick={(event) => toggleMobileSheet("scene", event.currentTarget)}><Layers3 size={18} />场景</button>
        <button type="button" aria-pressed={mobileSheetOpen && mobileSheet === "devices"} onClick={(event) => toggleMobileSheet("devices", event.currentTarget)}><MapPin size={18} />设备</button>
        <button type="button" aria-pressed={mobileSheetOpen && mobileSheet === "display"} onClick={(event) => toggleMobileSheet("display", event.currentTarget)}><SlidersHorizontal size={18} />显示</button>
      </nav>

      {mobileSheet && (
        <>
          <button className={`${styles.sheetBackdrop} ${mobileSheetOpen ? styles.isOpen : ""}`} type="button" aria-label="关闭工具面板" onClick={() => closeMobileSheet(false)} />
          <section
            ref={mobileSheetRef}
            className={`${styles.mobileSheet} ${mobileSheetOpen ? styles.isOpen : ""}`}
            data-ai-region={mobileSheet === "devices" ? "device-panel" : `${mobileSheet}-panel`}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-label={`${mobileSheet === "scene" ? "场景" : mobileSheet === "devices" ? "设备" : "显示"}面板`}
          >
            <div className={styles.sheetHandle} aria-hidden="true" />
            <header key={`header-${mobileSheet}`} className={styles.sheetSwapContent}>
              <h2>{mobileSheet === "scene" ? "场景" : mobileSheet === "devices" ? "设备" : "显示"}</h2>
              <button type="button" aria-label="关闭工具面板" onClick={() => closeMobileSheet(false)}><X size={18} /></button>
            </header>
            <div key={`content-${mobileSheet}`} className={`${styles.sheetContent} ${styles.sheetSwapContent}`}>
              {mobileSheet === "scene" ? sceneContent : mobileSheet === "devices" ? deviceContent : displayContent}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
