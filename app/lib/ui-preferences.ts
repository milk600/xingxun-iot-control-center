export type RefreshInterval = 1000 | 3500 | 5000 | 10000;
export type VehicleSpeed = 25 | 55 | 80;

export interface PreferencesV2 {
  version: 2;
  refreshIntervalMs: RefreshInterval;
  pauseWhenHidden: boolean;
  vehicleSpeedPercent: VehicleSpeed;
  keyboardControlEnabled: boolean;
  motionSpeedPercent: number;
}

export const UI_PREFERENCES_KEY = "xingxun:preferences:v2";
export const LEGACY_UI_PREFERENCES_KEY = "xingxun:ui-preferences";
export const UI_PREFERENCES_EVENT = "xingxun:preferences";
export const MOTION_SPEED_PREVIEW_EVENT = "xingxun:motion-speed-preview";

export const MOTION_SPEED_MIN = 25;
export const MOTION_SPEED_MAX = 180;
export const MOTION_SPEED_STEP = 5;
export const DEFAULT_MOTION_SPEED_PERCENT = 50;

export const DEFAULT_PREFERENCES: PreferencesV2 = {
  version: 2,
  refreshIntervalMs: 3500,
  pauseWhenHidden: true,
  vehicleSpeedPercent: 55,
  keyboardControlEnabled: true,
  motionSpeedPercent: DEFAULT_MOTION_SPEED_PERCENT,
};

export const ANDROID_DEFAULT_PREFERENCES: PreferencesV2 = {
  ...DEFAULT_PREFERENCES,
  refreshIntervalMs: 1000,
};

const MOTION_CSS_BASE_DURATIONS = {
  "--motion-duration-quick": 160,
  "--motion-duration-control": 180,
  "--motion-duration-local": 200,
  "--motion-duration-panel": 210,
  "--motion-duration-sheet": 220,
  "--motion-duration-data": 150,
  "--motion-duration-subtle": 100,
  "--motion-duration-route-enter": 188,
  "--motion-duration-twin-enter-opacity": 140,
  "--motion-duration-twin-enter-transform": 170,
  "--motion-duration-twin-mode-hide": 110,
  "--motion-duration-twin-mode-show": 150,
  "--motion-duration-twin-canvas-opacity": 68,
  "--motion-duration-twin-canvas-transform": 76,
  "--motion-duration-twin-exit-opacity": 70,
  "--motion-duration-twin-exit-transform": 78,
} as const;

export function normalizeMotionSpeedPercent(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MOTION_SPEED_PERCENT;
  const clamped = Math.min(MOTION_SPEED_MAX, Math.max(MOTION_SPEED_MIN, numeric));
  return Math.round(clamped / MOTION_SPEED_STEP) * MOTION_SPEED_STEP;
}

export function getRuntimeDefaultPreferences(): PreferencesV2 {
  if (typeof window !== "undefined" && window.location.hostname === "xingxun.local") {
    return { ...ANDROID_DEFAULT_PREFERENCES };
  }
  return { ...DEFAULT_PREFERENCES };
}

export function normalizePreferences(
  raw: unknown,
  defaults: PreferencesV2 = DEFAULT_PREFERENCES,
): PreferencesV2 {
  if (!raw || typeof raw !== "object") return { ...defaults };
  const source = raw as Record<string, unknown>;
  const refreshValue = source.refreshIntervalMs ?? source.refreshMs;
  const vehicleSpeedValue = source.vehicleSpeedPercent ?? source.speed;
  const refreshIntervalMs = [1000, 3500, 5000, 10000].includes(Number(refreshValue))
    ? Number(refreshValue) as RefreshInterval
    : defaults.refreshIntervalMs;
  const vehicleSpeedPercent = [25, 55, 80].includes(Number(vehicleSpeedValue))
    ? Number(vehicleSpeedValue) as VehicleSpeed
    : defaults.vehicleSpeedPercent;

  return {
    version: 2,
    refreshIntervalMs,
    pauseWhenHidden: typeof source.pauseWhenHidden === "boolean"
      ? source.pauseWhenHidden
      : defaults.pauseWhenHidden,
    vehicleSpeedPercent,
    keyboardControlEnabled: typeof (source.keyboardControlEnabled ?? source.keyboardEnabled) === "boolean"
      ? Boolean(source.keyboardControlEnabled ?? source.keyboardEnabled)
      : defaults.keyboardControlEnabled,
    motionSpeedPercent: source.motionSpeedPercent === undefined
      ? defaults.motionSpeedPercent
      : normalizeMotionSpeedPercent(source.motionSpeedPercent),
  };
}

export function readPreferences(): PreferencesV2 {
  if (typeof window === "undefined") return { ...DEFAULT_PREFERENCES };
  const defaults = getRuntimeDefaultPreferences();
  try {
    const stored = window.localStorage.getItem(UI_PREFERENCES_KEY)
      ?? window.localStorage.getItem(LEGACY_UI_PREFERENCES_KEY);
    return stored ? normalizePreferences(JSON.parse(stored), defaults) : defaults;
  } catch {
    return defaults;
  }
}

export function getScaledMotionDurationMs(
  baseDurationMs: number,
  speedPercent = getCurrentMotionSpeedPercent(),
) {
  return Math.max(1, Math.round(baseDurationMs * 100 / normalizeMotionSpeedPercent(speedPercent)));
}

export function getCurrentMotionSpeedPercent() {
  if (typeof document !== "undefined") {
    const activeValue = Number(document.documentElement.dataset.motionSpeedPercent);
    if (Number.isFinite(activeValue) && activeValue > 0) {
      return normalizeMotionSpeedPercent(activeValue);
    }
  }
  return readPreferences().motionSpeedPercent;
}

export function applyMotionSpeedToDocument(value: unknown) {
  const speedPercent = normalizeMotionSpeedPercent(value);
  if (typeof document === "undefined") return speedPercent;

  const root = document.documentElement;
  root.dataset.motionSpeedPercent = String(speedPercent);
  for (const [property, baseDurationMs] of Object.entries(MOTION_CSS_BASE_DURATIONS)) {
    root.style.setProperty(
      property,
      `${getScaledMotionDurationMs(baseDurationMs, speedPercent)}ms`,
    );
  }
  root.style.setProperty(
    "--app-motion-page",
    `${getScaledMotionDurationMs(284, speedPercent)}ms cubic-bezier(.16, 1, .3, 1)`,
  );
  root.style.setProperty(
    "--app-motion-local",
    `${getScaledMotionDurationMs(200, speedPercent)}ms cubic-bezier(.22, 1, .36, 1)`,
  );
  return speedPercent;
}

export function previewMotionSpeed(value: unknown) {
  const motionSpeedPercent = normalizeMotionSpeedPercent(value);
  applyMotionSpeedToDocument(motionSpeedPercent);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MOTION_SPEED_PREVIEW_EVENT, {
      detail: { motionSpeedPercent },
    }));
  }
  return motionSpeedPercent;
}

export function motionSpeedLabel(value: number) {
  if (value < 90) return "舒缓";
  if (value > 110) return "轻快";
  return "标准";
}
