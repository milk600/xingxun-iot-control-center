import type {
  VehicleCommandAck,
  VehicleCommandRequest,
  VehicleMotion,
} from "./contracts";

export const JETSON_SETTINGS_KEY = "xingxun:jetson-connection:v1";
export const JETSON_SETTINGS_EVENT = "xingxun:jetson-connection";

export interface JetsonConnectionSettings {
  enabled: boolean;
  wsUrl: string;
  maxWheelSpeed: number;
}

export interface JetsonOdomMessage {
  type: "odom";
  version?: 2;
  seq?: number;
  observedAt?: string;
  data: {
    M1: number;
    M2: number;
    M3: number;
    M4: number;
    xMm?: number;
    yMm?: number;
    headingDeg?: number;
    fireDetected?: boolean;
  };
}

export interface JetsonVideoMessage {
  type: "video";
  seq?: number;
  observedAt?: string;
  data: string;
}

export interface JetsonPowerMessage {
  deviceId: string | null;
  busVoltageV: number | null;
  psuVoltageV: number | null;
  currentA: number | null;
  powerW: number | null;
  percentage: number | null;
  observedAt?: string;
}

export interface JetsonImuMessage {
  type: "imu";
  version: 2;
  bootId: string;
  seq?: number;
  observedAt?: string;
  sampledAtMs?: number;
  data: {
    ax: number;
    ay: number;
    az: number;
    gx: number;
    gy: number;
    gz: number;
    temp: number;
    yawTotalDeg: number;
    headingDeg: number;
    yawRateDps: number;
    gyroBiasZDps: number;
    calibrated: boolean;
    stationary: boolean;
    calibrationSamples: number;
    zeroRevision: number;
    networkRttMs?: number | null;
    networkOneWayMs?: number | null;
  };
}

export interface NavigationPoint {
  x: number;
  y: number;
}

export interface NavigationStroke {
  id: string;
  points: NavigationPoint[];
}

export interface NavigationMapDefinition {
  version: 1;
  mapId: string;
  revision: number;
  widthM: number;
  heightM: number;
  resolutionM: 0.05;
  vehicle: {
    lengthM: number;
    widthM: number;
    clearanceM: number;
  };
  strokes: NavigationStroke[];
}

export type NavigationTaskState =
  | "map-ready"
  | "planning"
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped";

export type NavigationTaskPhase =
  | "ready"
  | "starting"
  | "turning"
  | "driving"
  | "replanning"
  | "completed"
  | "failed"
  | "stopped";

export interface JetsonNavigationMessage {
  type: "navigation";
  version: 1;
  state: NavigationTaskState;
  requestId?: string;
  observedAt?: string;
  ready?: boolean;
  map?: NavigationMapDefinition | null;
  mapRevision?: number;
  taskId?: string;
  phase?: NavigationTaskPhase;
  path?: NavigationPoint[];
  pose?: NavigationPoint & { headingDeg: number };
  distanceM?: number;
  remainingDistanceM?: number;
  estimatedSeconds?: number;
  goalToleranceM?: number;
  segmentIndex?: number;
  segmentCount?: number;
  pathRevision?: number;
  replanCount?: number;
  recoveryReplanCount?: number;
  replanReason?: string;
  completionQuality?: "nominal" | "tolerance";
  elapsedMs?: number;
  maxSpeedMmps?: number;
  outputSpeedMmps?: number;
  error?: string;
  reason?: string;
}

export type JetsonInboundMessage = JetsonOdomMessage | JetsonVideoMessage | JetsonImuMessage | JetsonNavigationMessage;

export interface JetsonVideoFrame extends JetsonVideoMessage {
  receivedAt: string;
}

export type JetsonVideoFrameListener = (frame: JetsonVideoFrame) => void;

export const MAX_JETSON_VIDEO_BASE64_LENGTH = 2_800_000;
const DEFAULT_JETSON_WS_URL = "ws://127.0.0.1:8765";
const LEGACY_JETSON_WS_URLS = new Set<string>();

function runtimeJetsonUrl() {
  if (typeof window === "undefined") return DEFAULT_JETSON_WS_URL;
  try {
    const bridge = (window as typeof window & { XingXunCloud?: { getRuntimeConfig(): string } }).XingXunCloud;
    if (!bridge) return DEFAULT_JETSON_WS_URL;
    const config = JSON.parse(bridge.getRuntimeConfig()) as { jetsonWsUrl?: unknown };
    return typeof config.jetsonWsUrl === "string" && /^(ws|wss):\/\//i.test(config.jetsonWsUrl)
      ? config.jetsonWsUrl
      : DEFAULT_JETSON_WS_URL;
  } catch {
    return DEFAULT_JETSON_WS_URL;
  }
}

export const DEFAULT_JETSON_SETTINGS: JetsonConnectionSettings = {
  enabled: false,
  wsUrl: runtimeJetsonUrl(),
  maxWheelSpeed: 300,
};

export function normalizeJetsonSettings(value: unknown): JetsonConnectionSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_JETSON_SETTINGS };
  const input = value as Partial<JetsonConnectionSettings>;
  const url = typeof input.wsUrl === "string" ? input.wsUrl.trim() : DEFAULT_JETSON_SETTINGS.wsUrl;
  const migratedUrl = LEGACY_JETSON_WS_URLS.has(url.toLowerCase())
    ? DEFAULT_JETSON_WS_URL
    : url;
  const maxWheelSpeed = Number(input.maxWheelSpeed);
  return {
    enabled: input.enabled === true,
    wsUrl: /^(ws|wss):\/\//i.test(migratedUrl) ? migratedUrl : DEFAULT_JETSON_SETTINGS.wsUrl,
    maxWheelSpeed: Number.isFinite(maxWheelSpeed)
      ? Math.min(2_000, Math.max(1, Math.round(maxWheelSpeed)))
      : DEFAULT_JETSON_SETTINGS.maxWheelSpeed,
  };
}

export function readJetsonSettings() {
  if (typeof window === "undefined") return { ...DEFAULT_JETSON_SETTINGS };
  try {
    const stored = window.localStorage.getItem(JETSON_SETTINGS_KEY);
    return stored ? normalizeJetsonSettings(JSON.parse(stored)) : { ...DEFAULT_JETSON_SETTINGS };
  } catch {
    return { ...DEFAULT_JETSON_SETTINGS };
  }
}

export function saveJetsonSettings(settings: JetsonConnectionSettings) {
  const normalized = normalizeJetsonSettings(settings);
  window.localStorage.setItem(JETSON_SETTINGS_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new Event(JETSON_SETTINGS_EVENT));
  return normalized;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numericValue(value: unknown) {
  if (finiteNumber(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJetsonPayload(value: unknown): Record<string, unknown> | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  return parsed as Record<string, unknown>;
}

function epochIso(timestampMs: number) {
  const minimumEpochMs = Date.UTC(2000, 0, 1);
  const maximumEpochMs = Date.UTC(2100, 0, 1);
  return timestampMs >= minimumEpochMs && timestampMs < maximumEpochMs
    ? new Date(timestampMs).toISOString()
    : null;
}

function finiteNonNegative(value: unknown): value is number {
  return finiteNumber(value) && value >= 0;
}

function genericTimestampMs(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return genericTimestampMs(numeric);
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!finiteNonNegative(value)) return null;
  // Contemporary Unix seconds are around 1e9, while Unix milliseconds are
  // around 1e12. Smaller values are treated as monotonic milliseconds.
  if (value >= 1_000_000_000 && value < 100_000_000_000) return value * 1_000;
  return value;
}

function optionalMessageMetadata(message: Record<string, unknown>, includeSampleTime = false) {
  const metadata: { seq?: number; observedAt?: string; sampledAtMs?: number } = {};
  if (Number.isSafeInteger(message.seq) && Number(message.seq) >= 0) {
    metadata.seq = Number(message.seq);
  }
  const observedAtMs = typeof message.observedAt === "string"
    ? Date.parse(message.observedAt)
    : Number.NaN;
  if (Number.isFinite(observedAtMs)) {
    metadata.observedAt = new Date(observedAtMs).toISOString();
  }
  if (!includeSampleTime) {
    const timestampMs = genericTimestampMs(message.timestamp ?? message.ts);
    if (!metadata.observedAt && timestampMs !== null) {
      metadata.observedAt = epochIso(timestampMs) ?? undefined;
    }
    return metadata;
  }

  const monotonicMs = message.monotonic_ms ?? message.monotonicMs;
  const explicitTimestampMs = message.timestamp_ms ?? message.timestampMs;
  const explicitTimestampUs = message.timestamp_us ?? message.timestampUs;
  const explicitTimestampNs = message.timestamp_ns ?? message.timestampNs;
  if (finiteNonNegative(monotonicMs)) {
    metadata.sampledAtMs = monotonicMs;
  } else if (finiteNonNegative(explicitTimestampMs)) {
    metadata.sampledAtMs = explicitTimestampMs;
  } else if (finiteNonNegative(explicitTimestampUs)) {
    metadata.sampledAtMs = explicitTimestampUs / 1_000;
  } else if (finiteNonNegative(explicitTimestampNs)) {
    metadata.sampledAtMs = explicitTimestampNs / 1_000_000;
  } else {
    const timestampMs = genericTimestampMs(message.timestamp ?? message.ts);
    if (timestampMs !== null) metadata.sampledAtMs = timestampMs;
  }
  if (metadata.sampledAtMs === undefined && Number.isFinite(observedAtMs)) {
    metadata.sampledAtMs = observedAtMs;
  }
  const timestampMs = genericTimestampMs(message.timestamp ?? message.ts);
  if (!metadata.observedAt && timestampMs !== null) {
    metadata.observedAt = epochIso(timestampMs) ?? undefined;
  }
  if (!metadata.observedAt && metadata.sampledAtMs !== undefined) {
    metadata.observedAt = epochIso(metadata.sampledAtMs) ?? undefined;
  }
  return metadata;
}

function parseOdomPayload(message: Record<string, unknown>): JetsonOdomMessage | null {
  const input = message as {
    type?: unknown;
    version?: unknown;
    seq?: unknown;
    observedAt?: unknown;
    timestamp?: unknown;
    data?: Record<string, unknown>;
  };
  if (input.type !== "odom" || !input.data) return null;
  if (![input.data.M1, input.data.M2, input.data.M3, input.data.M4].every(finiteNumber)) return null;
  const result: JetsonOdomMessage = {
    type: "odom",
    data: {
      M1: input.data.M1 as number,
      M2: input.data.M2 as number,
      M3: input.data.M3 as number,
      M4: input.data.M4 as number,
    },
  };
  const nestedPose = input.data.pose && typeof input.data.pose === "object"
    ? input.data.pose as Record<string, unknown>
    : null;
  const xMm = input.data.xMm ?? nestedPose?.x_mm;
  const yMm = input.data.yMm ?? nestedPose?.y_mm;
  const headingDeg = input.data.headingDeg ?? nestedPose?.yaw_deg;
  const poseValues = [xMm, yMm, headingDeg];
  if (poseValues.every(finiteNumber)) {
    result.version = 2;
    result.data.xMm = xMm as number;
    result.data.yMm = yMm as number;
    result.data.headingDeg = headingDeg as number;
  }
  if (Object.prototype.hasOwnProperty.call(input.data, "fire_detected")) {
    if (typeof input.data.fire_detected !== "boolean") return null;
    result.data.fireDetected = input.data.fire_detected;
  }
  Object.assign(result, optionalMessageMetadata(message));
  return result;
}

function validJpegBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 8 || value.length > MAX_JETSON_VIDEO_BASE64_LENGTH) return false;
  if (value.length % 4 !== 0 || !value.startsWith("/9j/")) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function parseVideoPayload(message: Record<string, unknown>): JetsonVideoMessage | null {
  if (message.type !== "video" || !validJpegBase64(message.data)) return null;
  return {
    type: "video",
    data: message.data,
    ...optionalMessageMetadata(message),
  };
}

function finiteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return finiteNumber(value) && value >= minimum && value <= maximum;
}

function optionalPowerValue(
  message: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
) {
  const value = message[key];
  if (value === undefined || value === null) return null;
  const parsed = numericValue(value);
  return parsed !== null && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}

export function parseJetsonPowerMessage(value: unknown): JetsonPowerMessage | null {
  const message = parseJetsonPayload(value);
  if (!message) return null;
  const busVoltageV = optionalPowerValue(message, "bus_voltage", 0, 100);
  const psuVoltageV = optionalPowerValue(message, "psu_voltage", 0, 100);
  const currentA = optionalPowerValue(message, "current", -100, 100);
  const powerW = optionalPowerValue(message, "power", -10_000, 10_000);
  const percentage = optionalPowerValue(message, "percentage", 0, 100);
  if (
    busVoltageV === undefined
    || psuVoltageV === undefined
    || currentA === undefined
    || powerW === undefined
    || percentage === undefined
  ) {
    return null;
  }
  if ([busVoltageV, psuVoltageV, currentA, powerW, percentage].every((item) => item === null)) {
    return null;
  }
  const deviceId = message.device_id === undefined || message.device_id === null
    ? null
    : typeof message.device_id === "string" && message.device_id.length <= 128
      ? message.device_id
      : undefined;
  if (deviceId === undefined) return null;
  const timestampMs = genericTimestampMs(message.timestamp);
  return {
    deviceId,
    busVoltageV,
    psuVoltageV,
    currentA,
    powerW,
    percentage,
    ...(timestampMs !== null && epochIso(timestampMs)
      ? { observedAt: epochIso(timestampMs) ?? undefined }
      : {}),
  };
}

export function jetsonPowerWebSocketUrl(controlUrl: string) {
  try {
    const url = new URL(controlUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    url.port = "8001";
    url.pathname = "/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function parseImuPayload(message: Record<string, unknown>): JetsonImuMessage | null {
  if (message.type !== "imu" || message.version !== 2
    || !message.data || typeof message.data !== "object") return null;
  const data = message.data as Record<string, unknown>;
  if (![data.ax, data.ay, data.az].every((value) => finiteInRange(value, -20, 20))) return null;
  if (![data.gx, data.gy, data.gz].every((value) => finiteInRange(value, -2_500, 2_500))) return null;
  if (!finiteInRange(data.temp, -60, 125)) return null;
  const yawTotalDeg = data.yaw_total_deg ?? data.yawTotalDeg;
  const headingDeg = data.heading_deg ?? data.headingDeg;
  const yawRateDps = data.yaw_rate_dps ?? data.yawRateDps;
  const gyroBiasZDps = data.gyro_bias_z_dps ?? data.gyroBiasZDps;
  const calibrationSamples = data.calibration_samples ?? data.calibrationSamples;
  const zeroRevision = data.zero_revision ?? data.zeroRevision;
  const networkRttMs = data.network_rtt_ms !== undefined ? data.network_rtt_ms : data.networkRttMs;
  const networkOneWayMs = data.network_one_way_ms !== undefined ? data.network_one_way_ms : data.networkOneWayMs;
  if (
    !finiteNumber(yawTotalDeg)
    || !finiteInRange(headingDeg, 0, 360)
    || !finiteInRange(yawRateDps, -2_500, 2_500)
    || !finiteInRange(gyroBiasZDps, -100, 100)
    || typeof data.calibrated !== "boolean"
    || typeof data.stationary !== "boolean"
    || !Number.isSafeInteger(calibrationSamples)
    || Number(calibrationSamples) < 0
    || !Number.isSafeInteger(zeroRevision)
    || Number(zeroRevision) < 0
  ) return null;
  const validNullableLatency = (value: unknown) => value === null || finiteInRange(value, 0, 60_000);
  if ((networkRttMs !== undefined && !validNullableLatency(networkRttMs))
    || (networkOneWayMs !== undefined && !validNullableLatency(networkOneWayMs))) return null;

  const bootIdValue = message.boot_id ?? message.bootId;
  const bootId = typeof bootIdValue === "string" && bootIdValue.length > 0 && bootIdValue.length <= 128
    ? bootIdValue
    : undefined;
  if (!bootId) return null;
  const result: JetsonImuMessage = {
    type: "imu",
    version: 2,
    bootId,
    data: {
      ax: data.ax as number,
      ay: data.ay as number,
      az: data.az as number,
      gx: data.gx as number,
      gy: data.gy as number,
      gz: data.gz as number,
      temp: data.temp as number,
      yawTotalDeg: yawTotalDeg as number,
      headingDeg: headingDeg as number,
      yawRateDps: yawRateDps as number,
      gyroBiasZDps: gyroBiasZDps as number,
      calibrated: data.calibrated as boolean,
      stationary: data.stationary as boolean,
      calibrationSamples: Number(calibrationSamples),
      zeroRevision: Number(zeroRevision),
      ...(networkRttMs !== undefined ? { networkRttMs: networkRttMs as number | null } : {}),
      ...(networkOneWayMs !== undefined ? { networkOneWayMs: networkOneWayMs as number | null } : {}),
    },
    ...optionalMessageMetadata(message, true),
  };
  return result;
}

function parseNavigationPoint(value: unknown): NavigationPoint | null {
  if (!value || typeof value !== "object") return null;
  const point = value as Record<string, unknown>;
  return finiteInRange(point.x, 0, 1) && finiteInRange(point.y, 0, 1)
    ? { x: point.x, y: point.y }
    : null;
}

function parseNavigationMap(value: unknown): NavigationMapDefinition | null {
  if (!value || typeof value !== "object") return null;
  const map = value as Record<string, unknown>;
  const vehicle = map.vehicle && typeof map.vehicle === "object"
    ? map.vehicle as Record<string, unknown>
    : null;
  if (map.version !== 1
    || typeof map.map_id !== "string" || map.map_id.length < 1 || map.map_id.length > 64
    || !Number.isSafeInteger(map.revision) || Number(map.revision) < 1
    || !finiteInRange(map.width_m, 2, 20)
    || !finiteInRange(map.height_m, 2, 20)
    || map.resolution_m !== 0.05
    || !vehicle
    || !finiteInRange(vehicle.length_m, 0, 1.5)
    || !finiteInRange(vehicle.width_m, 0, 1.5)
    || !finiteInRange(vehicle.clearance_m, 0, 1)
    || vehicle.length_m !== 0
    || vehicle.width_m !== 0
    || vehicle.clearance_m !== 0
    || !Array.isArray(map.strokes)
    || map.strokes.length > 256) return null;
  let pointCount = 0;
  const strokes: NavigationStroke[] = [];
  for (const value of map.strokes) {
    if (!value || typeof value !== "object") return null;
    const stroke = value as Record<string, unknown>;
    if (typeof stroke.id !== "string" || stroke.id.length < 1 || stroke.id.length > 128
      || !Array.isArray(stroke.points) || stroke.points.length < 2) return null;
    pointCount += stroke.points.length;
    if (pointCount > 4_096) return null;
    const points = stroke.points.map(parseNavigationPoint);
    if (points.some((point) => point === null)) return null;
    strokes.push({ id: stroke.id, points: points as NavigationPoint[] });
  }
  return {
    version: 1,
    mapId: map.map_id,
    revision: Number(map.revision),
    widthM: map.width_m,
    heightM: map.height_m,
    resolutionM: 0.05,
    vehicle: {
      lengthM: vehicle.length_m,
      widthM: vehicle.width_m,
      clearanceM: vehicle.clearance_m,
    },
    strokes,
  };
}

const NAVIGATION_STATES = new Set<NavigationTaskState>([
  "map-ready", "planning", "planned", "running", "completed", "failed", "cancelled", "stopped",
]);
const NAVIGATION_PHASES = new Set<NavigationTaskPhase>([
  "ready", "starting", "turning", "driving", "replanning", "completed", "failed", "stopped",
]);

function optionalFiniteField(
  source: Record<string, unknown>,
  snakeName: string,
  camelName: string,
  minimum: number,
  maximum: number,
) {
  const value = source[snakeName] ?? source[camelName];
  if (value === undefined) return undefined;
  return finiteInRange(value, minimum, maximum) ? value : null;
}

function parseNavigationPayload(message: Record<string, unknown>): JetsonNavigationMessage | null {
  if (message.type !== "navigation" || message.version !== 1
    || typeof message.state !== "string"
    || !NAVIGATION_STATES.has(message.state as NavigationTaskState)) return null;
  const result: JetsonNavigationMessage = {
    type: "navigation",
    version: 1,
    state: message.state as NavigationTaskState,
    ...optionalMessageMetadata(message),
  };
  const requestId = message.request_id ?? message.requestId;
  if (requestId !== undefined) {
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128) return null;
    result.requestId = requestId;
  }
  if (message.ready !== undefined) {
    if (typeof message.ready !== "boolean") return null;
    result.ready = message.ready;
  }
  if (message.map !== undefined) {
    if (message.map === null) result.map = null;
    else {
      const parsedMap = parseNavigationMap(message.map);
      if (!parsedMap) return null;
      result.map = parsedMap;
    }
  }
  const mapRevision = message.map_revision ?? message.mapRevision;
  if (mapRevision !== undefined) {
    if (!Number.isSafeInteger(mapRevision) || Number(mapRevision) < 1) return null;
    result.mapRevision = Number(mapRevision);
  }
  const taskId = message.task_id ?? message.taskId;
  if (taskId !== undefined) {
    if (typeof taskId !== "string" || taskId.length < 1 || taskId.length > 160) return null;
    result.taskId = taskId;
  }
  if (message.phase !== undefined) {
    if (typeof message.phase !== "string" || !NAVIGATION_PHASES.has(message.phase as NavigationTaskPhase)) return null;
    result.phase = message.phase as NavigationTaskPhase;
  }
  if (message.path !== undefined) {
    if (!Array.isArray(message.path) || message.path.length > 4_096) return null;
    const path = message.path.map(parseNavigationPoint);
    if (path.some((point) => point === null)) return null;
    result.path = path as NavigationPoint[];
  }
  if (message.pose !== undefined) {
    if (!message.pose || typeof message.pose !== "object") return null;
    const pose = message.pose as Record<string, unknown>;
    const point = parseNavigationPoint(pose);
    const headingDeg = pose.heading_deg ?? pose.headingDeg;
    if (!point || !finiteInRange(headingDeg, 0, 360)) return null;
    result.pose = { ...point, headingDeg };
  }
  const numericFields: Array<[keyof JetsonNavigationMessage, string, string, number, number]> = [
    ["distanceM", "distance_m", "distanceM", 0, 10],
    ["remainingDistanceM", "remaining_distance_m", "remainingDistanceM", 0, 10],
    ["estimatedSeconds", "estimated_seconds", "estimatedSeconds", 0, 3_600],
    ["goalToleranceM", "goal_tolerance_m", "goalToleranceM", 0, 2],
    ["segmentIndex", "segment_index", "segmentIndex", 0, 4_096],
    ["segmentCount", "segment_count", "segmentCount", 0, 4_096],
    ["pathRevision", "path_revision", "pathRevision", 1, 1_000_000],
    ["replanCount", "replan_count", "replanCount", 0, 100_000],
    ["recoveryReplanCount", "recovery_replan_count", "recoveryReplanCount", 0, 100_000],
    ["elapsedMs", "elapsed_ms", "elapsedMs", 0, 3_600_000],
    ["maxSpeedMmps", "max_speed_mmps", "maxSpeedMmps", 0, 2_000],
    ["outputSpeedMmps", "output_speed_mmps", "outputSpeedMmps", -2_000, 2_000],
  ];
  for (const [key, snakeName, camelName, minimum, maximum] of numericFields) {
    const value = optionalFiniteField(message, snakeName, camelName, minimum, maximum);
    if (value === null) return null;
    if (value !== undefined) Object.assign(result, { [key]: value });
  }
  for (const key of ["error", "reason"] as const) {
    const value = message[key];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length > 500) return null;
      result[key] = value;
    }
  }
  const replanReason = message.replan_reason ?? message.replanReason;
  if (replanReason !== undefined) {
    if (replanReason !== null && (typeof replanReason !== "string" || replanReason.length > 100)) return null;
    if (typeof replanReason === "string") result.replanReason = replanReason;
  }
  const completionQuality = message.completion_quality ?? message.completionQuality;
  if (completionQuality !== undefined) {
    if (completionQuality !== "nominal" && completionQuality !== "tolerance") return null;
    result.completionQuality = completionQuality;
  }
  return result;
}

export function parseJetsonInboundMessage(value: unknown): JetsonInboundMessage | null {
  const message = parseJetsonPayload(value);
  if (!message) return null;
  if (message.type === "odom") return parseOdomPayload(message);
  if (message.type === "video") return parseVideoPayload(message);
  if (message.type === "imu") return parseImuPayload(message);
  if (message.type === "navigation") return parseNavigationPayload(message);
  return null;
}

export function navigationMapToWire(map: NavigationMapDefinition) {
  return {
    version: 1,
    map_id: map.mapId,
    revision: map.revision,
    width_m: map.widthM,
    height_m: map.heightM,
    resolution_m: map.resolutionM,
    vehicle: {
      length_m: map.vehicle.lengthM,
      width_m: map.vehicle.widthM,
      clearance_m: map.vehicle.clearanceM,
    },
    strokes: map.strokes,
  };
}

function navigationStateOrder(state: NavigationTaskState) {
  if (state === "planning" || state === "map-ready") return 0;
  if (state === "planned") return 1;
  if (state === "running") return 2;
  return 3;
}

export function mergeJetsonNavigationState(
  current: JetsonNavigationMessage | null,
  message: JetsonNavigationMessage,
  receivedAt: string,
): JetsonNavigationMessage {
  const withArrivalTime = { ...message, observedAt: message.observedAt ?? receivedAt };
  const activeState = Boolean(current && ["planning", "planned", "running"].includes(current.state));
  const mapRevisionChanged = message.state === "map-ready"
    && current?.mapRevision !== undefined
    && message.mapRevision !== undefined
    && current.mapRevision !== message.mapRevision;
  if (current?.state === "running" && message.state === "failed" && !message.taskId) {
    return current;
  }
  if (current?.state === "running" && message.state === "running"
    && current.taskId && message.taskId === current.taskId
    && current.pathRevision !== undefined && message.pathRevision !== undefined
    && message.pathRevision < current.pathRevision) {
    return current;
  }
  if (current?.taskId && message.taskId === current.taskId
    && navigationStateOrder(message.state) < navigationStateOrder(current.state)) {
    return current;
  }
  if (message.state === "map-ready" && activeState && !mapRevisionChanged && current) {
    return {
      ...current,
      map: message.map,
      mapRevision: message.mapRevision ?? current.mapRevision,
      observedAt: withArrivalTime.observedAt,
    };
  }
  return {
    ...withArrivalTime,
    ...(withArrivalTime.map === undefined && current?.map ? { map: current.map } : {}),
  };
}

/** Retained for callers that only consume odometry. */
export function parseJetsonMessage(value: unknown): JetsonOdomMessage | null {
  const message = parseJetsonInboundMessage(value);
  return message?.type === "odom" ? message : null;
}

function wheelSpeedsForMotion(motion: Exclude<VehicleMotion, "stop">, speed: number) {
  const table: Record<Exclude<VehicleMotion, "stop">, [number, number, number, number]> = {
    forward: [speed, -speed, speed, -speed],
    backward: [-speed, speed, -speed, speed],
    left: [-speed, -speed, speed, speed],
    right: [speed, speed, -speed, -speed],
  };
  return table[motion];
}

export function buildJetsonCommand(input: VehicleCommandRequest, maxWheelSpeed: number) {
  if (input.motion === "stop") return { cmd: "stop" } as const;
  const speed = Math.round(Math.max(0, Math.min(100, input.speedPercent)) * maxWheelSpeed / 100);
  return { cmd: "move", speeds: wheelSpeedsForMotion(input.motion, speed) } as const;
}

export function createJetsonCommandAck(input: VehicleCommandRequest): VehicleCommandAck {
  return {
    requestId: input.requestId,
    commandId: `jetson-${input.requestId}`,
    status: "accepted",
    acknowledgedAt: new Date().toISOString(),
    message: input.motion === "stop"
      ? "停止指令已写入控制链路；设备端未提供执行回执"
      : "移动指令已写入控制链路；设备端未提供执行回执",
  };
}
