"use client";

import {
  CheckCircle2,
  Bot,
  CircleHelp,
  Database,
  Gauge,
  HardDrive,
  Keyboard,
  MonitorCog,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  UserRound,
  Wifi,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ANDROID_DEFAULT_PREFERENCES,
  DEFAULT_PREFERENCES,
  LEGACY_UI_PREFERENCES_KEY,
  MOTION_SPEED_MAX,
  MOTION_SPEED_MIN,
  MOTION_SPEED_STEP,
  UI_PREFERENCES_EVENT,
  UI_PREFERENCES_KEY,
  motionSpeedLabel,
  normalizeMotionSpeedPercent,
  normalizePreferences,
  previewMotionSpeed,
  type PreferencesV2,
} from "@/app/lib/ui-preferences";
import {
  DEFAULT_JETSON_SETTINGS,
  readJetsonSettings,
  saveJetsonSettings,
  type JetsonConnectionSettings,
} from "@/app/lib/iot/jetson-websocket";
import { TransitionLink } from "@/app/features/transitions/NavigationTransition";
import { useAiControl } from "@/app/features/ai/AiControlContext";
import {
  AI_ACTION_EVENT,
  registerActionReceiver,
  readActionDispatchDetail,
  reportActionError,
  reportActionSuccess,
} from "@/app/lib/ai/action-events";
import {
  CLIENT_ROLE_OPTIONS,
  REASONING_EFFORT_OPTIONS,
  THINKING_MODE_OPTIONS,
} from "@/app/features/ai/agent-preference-options";
import { AnimatedSelect } from "@/app/features/ui/AnimatedSelect";
import type { AgentActionDispatchDetail } from "@/app/lib/ai/contracts";
import { defaultAiClientPreferences, type AiClientPreferences } from "@/app/lib/ai/preferences";
import {
  TELEMETRY_POLL_INTERVALS,
  type TelemetryPollIntervalMs,
} from "@/app/lib/iot/telemetry-history-contracts";
import { DirectionalPanel, SlidingTabs, useDirectionalSelection } from "./PageTransitions";
import { AccountSecurityPanel } from "./AccountSecurityPanel";
import styles from "./Pages.module.css";

type SettingsSection = "account" | "refresh" | "vehicle" | "models" | "diagnostics";
const VEHICLE_SETTINGS_TARGETS = new Set([
  "jetson-connection-settings",
  "ai-agent-settings",
]);
const SETTING_ITEMS: ReadonlyArray<{ id: SettingsSection; label: string; icon: LucideIcon }> = [
  { id: "account", label: "账户与安全", icon: UserRound },
  { id: "refresh", label: "数据刷新", icon: RefreshCw },
  { id: "vehicle", label: "车辆控制", icon: Keyboard },
  { id: "models", label: "模型与存储", icon: HardDrive },
  { id: "diagnostics", label: "本机诊断", icon: Wrench },
];
const SETTING_ORDER = ["account", "refresh", "vehicle", "models", "diagnostics"] as const;

function Choice<T extends string | number>({ value, current, label, detail, disabled = false, onSelect }: { value: T; current: T; label: string; detail: string; disabled?: boolean; onSelect: (value: T) => void }) {
  const active = value === current;
  return (
    <button type="button" className={`${styles.choiceCard}${active ? ` ${styles.choiceActive}` : ""}`} disabled={disabled} onClick={() => onSelect(value)} aria-pressed={active}>
      <span>{active && <CheckCircle2 size={18} />}</span>
      <div><strong>{label}</strong><small>{detail}</small></div>
    </button>
  );
}

function collectLocalDiagnostics() {
  if (typeof window === "undefined") return null;
  const canvas = document.createElement("canvas");
  const extendedNavigator = navigator as Navigator & { deviceMemory?: number };
  let storage = false;
  try {
    const probeKey = "xingxun:diagnostics-probe";
    window.localStorage.setItem(probeKey, "1");
    window.localStorage.removeItem(probeKey);
    storage = true;
  } catch {
    storage = false;
  }
  return {
    webgl2: Boolean(canvas.getContext("webgl2")),
    dpr: window.devicePixelRatio,
    memory: extendedNavigator.deviceMemory,
    storage,
    browser: navigator.userAgent,
  };
}

export function SettingsPage() {
  const ai = useAiControl();
  const aiConnection = ai.connection;
  const requestCollectorSettings = ai.requestCollectorSettings;
  const updateAiPreferences = ai.updatePreferences;
  const androidStandalone = typeof window !== "undefined" && window.location.hostname === "xingxun.local";
  const runtimeDefaultPreferences = androidStandalone
    ? ANDROID_DEFAULT_PREFERENCES
    : DEFAULT_PREFERENCES;
  const { value: section, direction: sectionDirection, select: selectSection } = useDirectionalSelection(SETTING_ORDER, "account");
  const [prefs, setPrefs] = useState<PreferencesV2>(() => ({ ...runtimeDefaultPreferences }));
  const [jetsonSettings, setJetsonSettings] = useState<JetsonConnectionSettings>(DEFAULT_JETSON_SETTINGS);
  const [aiSettings, setAiSettings] = useState<AiClientPreferences>(() => ai.preferences);
  const [collectorPollIntervalMs, setCollectorPollIntervalMs] = useState<TelemetryPollIntervalMs>(1_000);
  const [collectorSettingsDirty, setCollectorSettingsDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [diagnosticsRun, setDiagnosticsRun] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ReturnType<typeof collectLocalDiagnostics>>(null);
  const persistedMotionSpeedRef = useRef(DEFAULT_PREFERENCES.motionSpeedPercent);
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const pendingActionRef = useRef<AgentActionDispatchDetail | null>(null);
  const collectorSaveRequestRef = useRef<string | null>(null);
  const collectorSaveResolverRef = useRef<{
    requestId: string;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const pendingSettingsRef = useRef<{
    prefs: PreferencesV2;
    jetsonSettings: JetsonConnectionSettings;
    aiSettings: AiClientPreferences;
  } | null>(null);

  const persistSettings = useCallback((next: {
    prefs: PreferencesV2;
    jetsonSettings: JetsonConnectionSettings;
    aiSettings: AiClientPreferences;
  }) => {
    window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(next.prefs));
    saveJetsonSettings(next.jetsonSettings);
    persistedMotionSpeedRef.current = next.prefs.motionSpeedPercent;
    window.dispatchEvent(new Event(UI_PREFERENCES_EVENT));
    updateAiPreferences(next.aiSettings);
  }, [updateAiPreferences]);

  useEffect(() => {
    const jetsonTimer = window.setTimeout(() => setJetsonSettings(readJetsonSettings()), 0);
    const stored = window.localStorage.getItem(UI_PREFERENCES_KEY) ?? window.localStorage.getItem(LEGACY_UI_PREFERENCES_KEY);
    if (stored) {
      try {
        const migrated = normalizePreferences(JSON.parse(stored), runtimeDefaultPreferences);
        window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(migrated));
        window.localStorage.removeItem(LEGACY_UI_PREFERENCES_KEY);
        persistedMotionSpeedRef.current = migrated.motionSpeedPercent;
        previewMotionSpeed(migrated.motionSpeedPercent);
        window.setTimeout(() => setPrefs(migrated), 0);
      } catch {
        if (androidStandalone) {
          window.localStorage.setItem(
            UI_PREFERENCES_KEY,
            JSON.stringify(runtimeDefaultPreferences),
          );
        } else {
          window.localStorage.removeItem(UI_PREFERENCES_KEY);
        }
        window.localStorage.removeItem(LEGACY_UI_PREFERENCES_KEY);
      }
    }

    return () => {
      window.clearTimeout(jetsonTimer);
      previewMotionSpeed(persistedMotionSpeedRef.current);
    };
  }, [androidStandalone, runtimeDefaultPreferences]);

  useEffect(() => {
    const openLinkedSettings = () => {
      const targetId = window.location.hash.slice(1);
      if (!VEHICLE_SETTINGS_TARGETS.has(targetId)) return;
      selectSection("vehicle");

      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const target = document.getElementById(targetId);
          if (!target) return;
          target.scrollIntoView({ behavior: "smooth", block: "start" });
          target.focus({ preventScroll: true });
        });
      });
    };

    openLinkedSettings();
    window.addEventListener("hashchange", openLinkedSettings);
    return () => window.removeEventListener("hashchange", openLinkedSettings);
  }, [selectSection]);

  useEffect(() => {
    if (androidStandalone || aiConnection !== "online") return;
    requestCollectorSettings();
  }, [aiConnection, androidStandalone, requestCollectorSettings]);

  useEffect(() => {
    if (androidStandalone) return;
    const state = ai.collectorSettings;
    const matchedSave = Boolean(
      collectorSaveRequestRef.current
      && state.requestId === collectorSaveRequestRef.current,
    );
    if (state.phase === "ready" && state.settings) {
      if (!collectorSettingsDirty || matchedSave) {
        setCollectorPollIntervalMs(state.settings.pollIntervalMs);
      }
      if (matchedSave) {
        const requestId = collectorSaveRequestRef.current;
        window.queueMicrotask(() => {
          try {
            if (pendingSettingsRef.current) {
              persistSettings(pendingSettingsRef.current);
              pendingSettingsRef.current = null;
            }
            setCollectorSettingsDirty(false);
            setSaved(true);
            if (
              requestId
              && collectorSaveResolverRef.current?.requestId === requestId
            ) {
              collectorSaveResolverRef.current.resolve();
              collectorSaveResolverRef.current = null;
            }
          } catch (error) {
            setSaved(false);
            if (
              requestId
              && collectorSaveResolverRef.current?.requestId === requestId
            ) {
              collectorSaveResolverRef.current.reject(
                error instanceof Error ? error : new Error("本地设置持久化失败。"),
              );
              collectorSaveResolverRef.current = null;
            }
          }
        });
        collectorSaveRequestRef.current = null;
      }
      return;
    }
    if (state.phase === "error" && matchedSave) {
      const requestId = collectorSaveRequestRef.current;
      collectorSaveRequestRef.current = null;
      pendingSettingsRef.current = null;
      setSaved(false);
      if (
        requestId
        && collectorSaveResolverRef.current?.requestId === requestId
      ) {
        collectorSaveResolverRef.current.reject(
          new Error(state.error ?? "华为云后台读取间隔保存失败。"),
        );
        collectorSaveResolverRef.current = null;
      }
    }
  }, [ai.collectorSettings, androidStandalone, collectorSettingsDirty, persistSettings]);

  const runDiagnostics = useCallback(() => {
    const next = collectLocalDiagnostics();
    setDiagnostics(next);
    setDiagnosticsRun(true);
    return next;
  }, []);

  const update = <K extends keyof PreferencesV2>(key: K, value: PreferencesV2[K]) => {
    setPrefs((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const save = useCallback(async () => {
    const next = { prefs, jetsonSettings, aiSettings };
    if (androidStandalone) {
      persistSettings(next);
      setSaved(true);
      return;
    }
    setSaved(false);
    if (!collectorSettingsDirty) {
      persistSettings(next);
      setSaved(true);
      return;
    }
    pendingSettingsRef.current = next;
    const requestId = ai.saveCollectorPollInterval(collectorPollIntervalMs);
    collectorSaveRequestRef.current = requestId;
    if (!requestId) {
      pendingSettingsRef.current = null;
      throw new Error("智能网关未连接，设置未保存。");
    }
    await new Promise<void>((resolve, reject) => {
      collectorSaveResolverRef.current = { requestId, resolve, reject };
    });
  }, [ai, aiSettings, androidStandalone, collectorPollIntervalMs, collectorSettingsDirty, jetsonSettings, persistSettings, prefs]);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const reset = () => {
    setPrefs({ ...runtimeDefaultPreferences });
    setJetsonSettings(DEFAULT_JETSON_SETTINGS);
    setAiSettings(defaultAiClientPreferences());
    setCollectorPollIntervalMs(1_000);
    setCollectorSettingsDirty(true);
    previewMotionSpeed(runtimeDefaultPreferences.motionSpeedPercent);
    setSaved(false);
  };

  const updateMotionSpeed = (value: number) => {
    const motionSpeedPercent = previewMotionSpeed(value);
    update("motionSpeedPercent", motionSpeedPercent);
  };

  useEffect(() => {
    const handleAction = (event: Event) => {
      const action = readActionDispatchDetail(event);
      if (!action) return;
      if (action.name === "settings.set_section") {
        if (section === action.arguments.section) {
          reportActionSuccess(action, "设置分类已处于目标位置。");
          return;
        }
        pendingActionRef.current = action;
        selectSection(action.arguments.section);
        return;
      }
      if (action.name === "settings.set_refresh_interval") {
        if (prefs.refreshIntervalMs === action.arguments.intervalMs) {
          reportActionSuccess(action, "页面刷新间隔已符合要求。");
          return;
        }
        pendingActionRef.current = action;
        setPrefs((current) => ({ ...current, refreshIntervalMs: action.arguments.intervalMs }));
        setSaved(false);
        return;
      }
      if (action.name === "settings.set_pause_when_hidden") {
        if (prefs.pauseWhenHidden === action.arguments.enabled) {
          reportActionSuccess(action, "后台刷新设置已符合要求。");
          return;
        }
        pendingActionRef.current = action;
        setPrefs((current) => ({ ...current, pauseWhenHidden: action.arguments.enabled }));
        setSaved(false);
        return;
      }
      if (action.name === "settings.set_motion_speed") {
        const percent = previewMotionSpeed(action.arguments.percent);
        if (prefs.motionSpeedPercent === percent) {
          reportActionSuccess(action, "动效速度已符合要求。");
          return;
        }
        pendingActionRef.current = action;
        setPrefs((current) => ({ ...current, motionSpeedPercent: percent }));
        setSaved(false);
        return;
      }
      if (action.name === "settings.set_vehicle_default_speed") {
        if (prefs.vehicleSpeedPercent === action.arguments.percent) {
          reportActionSuccess(action, "默认车速已符合要求。");
          return;
        }
        pendingActionRef.current = action;
        setPrefs((current) => ({ ...current, vehicleSpeedPercent: action.arguments.percent }));
        setSaved(false);
        return;
      }
      if (action.name === "settings.set_keyboard_control") {
        if (prefs.keyboardControlEnabled === action.arguments.enabled) {
          reportActionSuccess(action, "键盘控制设置已符合要求。");
          return;
        }
        pendingActionRef.current = action;
        setPrefs((current) => ({ ...current, keyboardControlEnabled: action.arguments.enabled }));
        setSaved(false);
        return;
      }
      if (action.name === "settings.set_voice_playback") {
        if (aiSettings.voicePlaybackEnabled === action.arguments.enabled) {
          reportActionSuccess(action, "语音播报设置已符合要求。");
          return;
        }
        pendingActionRef.current = action;
        setAiSettings((current) => ({ ...current, voicePlaybackEnabled: action.arguments.enabled }));
        setSaved(false);
        return;
      }
      if (action.name === "settings.run_diagnostics") {
        selectSection("diagnostics");
        const result = runDiagnostics();
        if (result) reportActionSuccess(action, "本机诊断已重新运行。");
        else reportActionError(action, "当前环境无法运行本机诊断。");
        return;
      }
      if (action.name === "settings.save") {
        void saveRef.current()
          .then(() => reportActionSuccess(action, "系统设置已保存并持久化。"))
          .catch((error) => reportActionError(action, error, "系统设置保存失败。"));
      }
    };
    window.addEventListener(AI_ACTION_EVENT, handleAction);
    const unregisterReceiver = registerActionReceiver([
      "settings.set_section",
      "settings.set_refresh_interval",
      "settings.set_pause_when_hidden",
      "settings.set_motion_speed",
      "settings.set_vehicle_default_speed",
      "settings.set_keyboard_control",
      "settings.set_voice_playback",
      "settings.run_diagnostics",
      "settings.save",
    ]);
    return () => {
      unregisterReceiver();
      window.removeEventListener(AI_ACTION_EVENT, handleAction);
    };
  }, [aiSettings.voicePlaybackEnabled, prefs, runDiagnostics, section, selectSection]);

  useEffect(() => {
    const action = pendingActionRef.current;
    if (!action) return;
    let complete = false;
    if (action.name === "settings.set_section") {
      complete = section === action.arguments.section;
    } else if (action.name === "settings.set_refresh_interval") {
      complete = prefs.refreshIntervalMs === action.arguments.intervalMs;
    } else if (action.name === "settings.set_pause_when_hidden") {
      complete = prefs.pauseWhenHidden === action.arguments.enabled;
    } else if (action.name === "settings.set_motion_speed") {
      complete = prefs.motionSpeedPercent === normalizeMotionSpeedPercent(action.arguments.percent);
    } else if (action.name === "settings.set_vehicle_default_speed") {
      complete = prefs.vehicleSpeedPercent === action.arguments.percent;
    } else if (action.name === "settings.set_keyboard_control") {
      complete = prefs.keyboardControlEnabled === action.arguments.enabled;
    } else if (action.name === "settings.set_voice_playback") {
      complete = aiSettings.voicePlaybackEnabled === action.arguments.enabled;
    }
    if (!complete) return;
    pendingActionRef.current = null;
    reportActionSuccess(action, "设置草稿已更新。");
  }, [aiSettings.voicePlaybackEnabled, prefs, section]);

  useEffect(() => () => {
    collectorSaveResolverRef.current?.reject(new Error("设置页面已关闭，保存未完成。"));
    collectorSaveResolverRef.current = null;
  }, []);

  const motionProgress = (prefs.motionSpeedPercent - MOTION_SPEED_MIN)
    / (MOTION_SPEED_MAX - MOTION_SPEED_MIN) * 100;
  const motionRangeStyle = {
    "--motion-range-progress": `${motionProgress}%`,
  } as CSSProperties;

  return (
    <div className={styles.pageSurface}>
      <div className={styles.pageActionBar}>
        <button className={styles.headerButton} type="button" onClick={save}><Save size={16} />保存设置</button>
      </div>
      {saved && <div className={styles.saveBanner} role="status"><CheckCircle2 size={18} /><span>{androidStandalone ? "设置已保存在当前设备。" : "页面设置与华为云读取周期已保存。"}</span></div>}

      <section className={styles.settingsLayout}>
        <SlidingTabs items={SETTING_ITEMS} value={section} onChange={selectSection} ariaLabel="设置分类" idBase="settings-section" variant="settings" />

        <div className={styles.settingsContent}>
          <DirectionalPanel activeKey={section} direction={sectionDirection} idBase="settings-section">
          {section === "account" && <AccountSecurityPanel />}
          {section === "refresh" && (
            <article className={styles.settingsPanel} data-ai-region="refresh-settings">
              <header><span><RefreshCw size={22} /></span><div><h2>数据刷新</h2><small>设置实时数据的读取节奏。</small></div></header>
              {!androidStandalone && (
                <section>
                  <div className={styles.settingLabel}>
                    <strong>华为云后台读取间隔</strong>
                    <small>{ai.collectorSettings.phase === "loading" ? "正在读取网关设置…" : ai.collectorSettings.phase === "saving" ? "正在保存到智能网关…" : ai.connection !== "online" ? "智能网关离线" : ai.collectorSettings.canEdit ? "保存后立即生效并在网关重启后保留" : "当前客户端只读"}</small>
                  </div>
                  <div className={styles.choiceGrid}>
                    {TELEMETRY_POLL_INTERVALS.map((value) => (
                      <Choice
                        key={value}
                        value={value}
                        current={collectorPollIntervalMs}
                        label={value === 1_000 ? "1 秒" : value === 3_500 ? "3.5 秒" : `${value / 1_000} 秒`}
                        detail={value === 1_000 ? "默认 · 高频" : value === 3_500 ? "平衡" : "较低频率"}
                        disabled={ai.connection !== "online" || !ai.collectorSettings.canEdit || ai.collectorSettings.phase === "loading" || ai.collectorSettings.phase === "saving"}
                        onSelect={(next) => {
                          setCollectorPollIntervalMs(next);
                          setCollectorSettingsDirty(true);
                          setSaved(false);
                        }}
                      />
                    ))}
                  </div>
                  {ai.collectorSettings.error && <p className={styles.settingsError} role="alert">{ai.collectorSettings.error}</p>}
                </section>
              )}
              <section>
                <div className={styles.settingLabel}>
                  <strong>{androidStandalone ? "页面与华为云直读间隔" : "页面显示刷新间隔"}</strong>
                  <small>{androidStandalone ? "当前 Android 设备按此节奏直接读取华为云 IoTDA 并刷新页面" : "只影响当前浏览器读取仪表盘快照的频率"}</small>
                </div>
                <div className={styles.choiceGrid}>
                  {([1000, 3500, 5000, 10000] as const).map((value) => <Choice key={value} value={value} current={prefs.refreshIntervalMs} label={value === 1000 ? "1 秒" : value === 3500 ? "3.5 秒" : `${value / 1000} 秒`} detail={value === 3500 ? "推荐" : value === 1000 ? "高频" : "较低频率"} onSelect={(next) => update("refreshIntervalMs", next)} />)}
                </div>
              </section>
              <section><label className={styles.switchRow}><span><strong>页面隐藏时暂停普通刷新</strong><small>车辆自动停车不受影响。</small></span><input type="checkbox" checked={prefs.pauseWhenHidden} onChange={(event) => update("pauseWhenHidden", event.target.checked)} /></label></section>
              <section className={styles.motionSetting}>
                <div className={styles.motionSettingHeader}>
                  <label htmlFor="motion-speed">界面动效速度</label>
                  <output htmlFor="motion-speed">{prefs.motionSpeedPercent}% · {motionSpeedLabel(prefs.motionSpeedPercent)}</output>
                </div>
                <input
                  id="motion-speed"
                  className={styles.motionRange}
                  type="range"
                  min={MOTION_SPEED_MIN}
                  max={MOTION_SPEED_MAX}
                  step={MOTION_SPEED_STEP}
                  value={prefs.motionSpeedPercent}
                  style={motionRangeStyle}
                  aria-valuetext={`${prefs.motionSpeedPercent}%，${motionSpeedLabel(prefs.motionSpeedPercent)}`}
                  onChange={(event) => updateMotionSpeed(Number(event.target.value))}
                />
                <div className={styles.motionRangeLegend} aria-hidden="true"><span>更慢</span><span>标准 100%</span><span>更快</span></div>
              </section>
            </article>
          )}

          {section === "vehicle" && (
            <article className={styles.settingsPanel} data-ai-region="vehicle-settings">
              <header><span><Keyboard size={22} /></span><div><h2>车辆控制</h2><small>设置遥控台默认输入方式。</small></div></header>
              <section>
                <div className={styles.settingLabel}><strong>默认速度</strong></div>
                <div className={styles.choiceGrid}>
                  <Choice value={25} current={prefs.vehicleSpeedPercent} label="精细 25%" detail="狭窄空间" onSelect={(value) => update("vehicleSpeedPercent", value)} />
                  <Choice value={55} current={prefs.vehicleSpeedPercent} label="标准 55%" detail="日常巡检" onSelect={(value) => update("vehicleSpeedPercent", value)} />
                  <Choice value={80} current={prefs.vehicleSpeedPercent} label="快速 80%" detail="开阔区域" onSelect={(value) => update("vehicleSpeedPercent", value)} />
                </div>
              </section>
              <section><label className={styles.switchRow}><span><strong>键盘方向控制</strong><small>WASD、方向键与空格急停。</small></span><input type="checkbox" checked={prefs.keyboardControlEnabled} onChange={(event) => update("keyboardControlEnabled", event.target.checked)} /></label><label className={`${styles.switchRow} ${styles.lockedSetting}`}><span><strong>失焦与离页自动停车</strong><small>安全规则始终开启。</small></span><input type="checkbox" checked readOnly disabled /></label></section>
              <section
                id="jetson-connection-settings"
                className={`${styles.jetsonSettings} ${styles.linkedSettingsSection}`}
                tabIndex={-1}
              >
                <div className={styles.settingLabel}><strong>Jetson 局域网连接</strong></div>
                <label className={styles.switchRow}><span><strong>启用小车连接</strong><small>关闭后停止局域网连接，不生成模拟车辆状态</small></span><input type="checkbox" checked={jetsonSettings.enabled} onChange={(event) => setJetsonSettings((current) => ({ ...current, enabled: event.target.checked }))} /></label>
                <label className={styles.connectionField}><span><Wifi size={16} />小车连接地址</span><input type="url" value={jetsonSettings.wsUrl} placeholder="ws://Jetson-IP:8765" onChange={(event) => setJetsonSettings((current) => ({ ...current, wsUrl: event.target.value }))} /></label>
                <label className={styles.connectionField}><span>100% 对应轮速</span><input type="number" min="1" max="2000" value={jetsonSettings.maxWheelSpeed} onChange={(event) => setJetsonSettings((current) => ({ ...current, maxWheelSpeed: Number(event.target.value) }))} /></label>
              </section>
              <section
                id="ai-agent-settings"
                className={`${styles.jetsonSettings} ${styles.linkedSettingsSection}`}
                tabIndex={-1}
              >
                <div className={styles.settingLabel}><strong><Bot size={16} /> AI 智能中枢</strong></div>
                <label className={styles.connectionField}><span>智能中枢地址</span><input type="url" value={aiSettings.gatewayUrl} placeholder="设备内置或 ws://网关地址:8766" readOnly={typeof window !== "undefined" && window.location.hostname === "xingxun.local"} onChange={(event) => setAiSettings((current) => ({ ...current, gatewayUrl: event.target.value }))} /></label>
                <div className={styles.connectionField}><span>设备角色</span><AnimatedSelect ariaLabel="设备角色" value={aiSettings.clientRole} options={CLIENT_ROLE_OPTIONS} disabled={androidStandalone} onChange={(clientRole) => setAiSettings((current) => ({ ...current, clientRole }))} /></div>
                <div className={styles.connectionField}><span>Agent 思考模式</span><AnimatedSelect ariaLabel="Agent 思考模式" value={aiSettings.thinkingMode} options={THINKING_MODE_OPTIONS} onChange={(thinkingMode) => setAiSettings((current) => ({ ...current, thinkingMode }))} /></div>
                <div className={styles.connectionField}><span>推理强度</span><AnimatedSelect ariaLabel="推理强度" value={aiSettings.reasoningEffort} options={REASONING_EFFORT_OPTIONS} disabled={aiSettings.thinkingMode === "non-thinking"} onChange={(reasoningEffort) => setAiSettings((current) => ({ ...current, reasoningEffort }))} /></div>
                <label className={styles.switchRow}><span><strong>语音播报</strong><small>使用当前系统的中文语音引擎</small></span><input type="checkbox" checked={aiSettings.voicePlaybackEnabled} onChange={(event) => setAiSettings((current) => ({ ...current, voicePlaybackEnabled: event.target.checked }))} /></label>
                <label className={styles.switchRow}><span><strong>允许 AI 自主控制小车</strong><small>{ai.runtimeProfile.fullAccess ? "完整权限模式已启用，Agent 可自主编排并直接执行多段通用移动与旋转动作" : "AI 可直接执行限时、定距与定角任务"}</small></span><input type="checkbox" checked={ai.runtimeProfile.fullAccess || aiSettings.realVehicleEnabled} disabled={ai.runtimeProfile.fullAccess} onChange={(event) => setAiSettings((current) => ({ ...current, realVehicleEnabled: event.target.checked }))} /></label>
                <label className={styles.switchRow}><span><strong>允许 AI 处理告警工单</strong><small>{ai.runtimeProfile.fullAccess ? "完整权限模式已启用，Agent 可直接处理工单" : "AI 可开始和完成工单，所有操作会记录时间线"}</small></span><input type="checkbox" checked={ai.runtimeProfile.fullAccess || aiSettings.alertWorkOrderAutomationEnabled} disabled={ai.runtimeProfile.fullAccess} onChange={(event) => setAiSettings((current) => ({ ...current, alertWorkOrderAutomationEnabled: event.target.checked }))} /></label>
              </section>
            </article>
          )}

          {section === "models" && (
            <article className={styles.settingsPanel} data-ai-region="model-storage">
              <header><span><HardDrive size={22} /></span><div><h2>模型与存储</h2><small>模型只在当前{androidStandalone ? "设备" : "浏览器"}读取。</small></div></header>
              <section className={styles.modelSetting}><div><span><Database size={21} /></span><p><small>当前主模型</small><strong>demo-room.ply</strong><span>合成演示点云 · 可替换</span></p></div><TransitionLink href="/digital-twin">打开空间孪生</TransitionLink></section>
              <section><button type="button" className={styles.destructiveQuiet} onClick={() => window.localStorage.removeItem("xingxun:recent-models")}><Trash2 size={16} />清除最近模型记录</button></section>
            </article>
          )}

          {section === "diagnostics" && (
            <article className={styles.settingsPanel} data-ai-region="diagnostics">
              <header><span><Wrench size={22} /></span><div><h2>本机诊断</h2><small>检测只在当前{androidStandalone ? "Android 设备" : "电脑"}完成。</small></div><button type="button" className={styles.runDiagnostic} onClick={runDiagnostics}><Gauge size={16} />运行检查</button></header>
              {diagnosticsRun && diagnostics ? <div className={styles.diagnosticGrid}><div><span>WebGL 2</span><strong>{diagnostics.webgl2 ? "可用" : "不可用"}</strong></div><div><span>设备像素比</span><strong>{diagnostics.dpr.toFixed(2)}</strong></div><div><span>内存提示</span><strong>{diagnostics.memory ? `${diagnostics.memory} GB` : "未提供"}</strong></div><div><span>本地存储</span><strong>{diagnostics.storage ? "可用" : "不可用"}</strong></div><div className={styles.browserDiagnostic}><span>浏览器</span><strong>{diagnostics.browser}</strong></div></div> : <div className={styles.diagnosticEmpty}><MonitorCog size={30} /><strong>尚未运行诊断</strong><span>可检查三维渲染和本地存储能力。</span></div>}
            </article>
          )}
          </DirectionalPanel>

          <footer className={styles.settingsFooter}>
            <button type="button" onClick={reset}><RotateCcw size={16} />恢复默认</button>
            <div><CircleHelp size={16} /><span>{androidStandalone ? "修改只保存在当前设备。" : "页面偏好保存在当前浏览器；华为云读取周期保存在本机网关。"}</span></div>
            <button type="button" className={styles.saveSettings} onClick={save}><Save size={16} />保存设置</button>
          </footer>
        </div>
      </section>
    </div>
  );
}
