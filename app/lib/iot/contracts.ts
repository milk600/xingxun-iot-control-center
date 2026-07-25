export const TELEMETRY_SLOT_IDS = [
  "slot-1",
  "slot-2",
  "slot-3",
  "slot-4",
  "slot-5",
  "slot-6",
] as const;

export type TelemetrySlotId = (typeof TELEMETRY_SLOT_IDS)[number];
export type DataState =
  | "loading"
  | "live"
  | "stale"
  | "offline"
  | "empty"
  | "error";
export type TelemetryTone =
  | "blue"
  | "cyan"
  | "green"
  | "orange"
  | "red"
  | "gray";

export interface TelemetryAuxiliaryReading {
  sourceKey: string;
  label: string;
  value: number | null;
  unit: string;
  precision: number;
}

export interface TelemetrySlot {
  slotId: TelemetrySlotId;
  sourceKey: string | null;
  label: string;
  value: number | null;
  unit: string;
  precision: number;
  tone: TelemetryTone;
  state: DataState;
  observedAt: string | null;
  supportingText: string;
  auxiliaryReadings: ReadonlyArray<TelemetryAuxiliaryReading>;
}

export type TelemetrySlots = Readonly<
  Record<TelemetrySlotId, TelemetrySlot>
>;

/** @deprecated Use TelemetrySlots. Retained for source compatibility. */
export type FiveTelemetrySlots = TelemetrySlots;

export type VehicleMotion =
  | "forward"
  | "backward"
  | "left"
  | "right"
  | "stop";

export interface VehicleCommandRequest {
  requestId: string;
  motion: VehicleMotion;
  speedPercent: number;
  issuedAt: string;
}

export interface VehicleCommandAck {
  requestId: string;
  commandId: string;
  status: "accepted" | "executed" | "rejected" | "timeout";
  acknowledgedAt: string;
  message: string;
}

export type VehicleControlLinkState = "disabled" | "connecting" | "connected" | "disconnected";

export interface VehiclePowerTelemetry {
  state: "connecting" | "live" | "stale" | "offline";
  deviceId: string | null;
  busVoltageV: number | null;
  psuVoltageV: number | null;
  currentA: number | null;
  powerW: number | null;
  percentage: number | null;
  observedAt: string | null;
  receivedAt: string | null;
}

export interface VehicleFireDetection {
  state: "live" | "stale" | "offline";
  detected: boolean | null;
  observedAt: string | null;
  receivedAt: string | null;
}

export interface VehicleTelemetry {
  /** WebSocket transport state. This does not imply that device telemetry exists. */
  controlLink: VehicleControlLinkState;
  /** Freshness of the most recent validated device telemetry message. */
  connection: "online" | "offline" | "stale";
  motion: VehicleMotion;
  speedPercent: number;
  batteryPercent: number | null;
  obstacleDistanceCm: number | null;
  signalDbm: number | null;
  headingDeg: number | null;
  powerTelemetry: VehiclePowerTelemetry;
  fireDetection: VehicleFireDetection;
  observedAt: string | null;
  lastSeenAt: string | null;
  wheelSpeeds?: {
    m1: number;
    m2: number;
    m3: number;
    m4: number;
    unit: "mm/s";
  } | null;
  imu?: {
    acceleration: { x: number; y: number; z: number; unit: "g" };
    angularVelocity: { x: number; y: number; z: number; unit: "deg/s" };
    temperatureC: number;
    accelerationMagnitudeG: number;
    correctedYawRateDegps: number;
    relativeHeadingDeg: number;
    gyroBiasZDps: number;
    stationary: boolean;
    canZeroHeading: boolean;
    calibrationSamples: number;
    calibrationRequiredSamples: number;
    zeroRevision: number;
    zeroedAt: string | null;
    networkRttMs: number | null;
    networkOneWayMs: number | null;
    state: "calibrating" | "live" | "stale";
    sequence: number | null;
    observedAt: string;
    receivedAt: string;
  } | null;
  odometry?: {
    source: "heading-unavailable" | "wheel-jetson-heading-v2" | "device-pose-v2";
    sequence: number | null;
    observedAt: string;
    receivedAt: string;
    pose: {
      xMm: number;
      yMm: number;
      headingDeg: number;
    } | null;
    quality: "unavailable" | "fused" | "reported";
  } | null;
}

export interface DashboardSnapshot {
  slots: TelemetrySlots;
  vehicle: VehicleTelemetry;
  generatedAt: string;
  provider: "mock" | "huawei-cloud";
  partialErrors: ReadonlyArray<{
    scope: "slots" | "vehicle";
    message: string;
  }>;
}

export interface CommandLogItem extends VehicleCommandAck {
  motion: VehicleMotion;
  speedPercent: number;
}

export function createLoadingSlots(): TelemetrySlots {
  const labels = ["数据位 01", "数据位 02", "数据位 03", "数据位 04", "数据位 05", "数据位 06"];

  return Object.fromEntries(
    TELEMETRY_SLOT_IDS.map((slotId, index) => [
      slotId,
      {
        slotId,
        sourceKey: null,
        label: labels[index],
        value: null,
        unit: "",
        precision: 0,
        tone: "gray" as const,
        state: "loading" as const,
        observedAt: null,
        supportingText: "正在读取接口数据",
        auxiliaryReadings: [],
      },
    ]),
  ) as unknown as TelemetrySlots;
}

export function createInitialSnapshot(): DashboardSnapshot {
  return {
    slots: createLoadingSlots(),
    vehicle: { ...createUnavailableVehicle(), connection: "stale" },
    generatedAt: new Date(0).toISOString(),
    provider: "mock",
    partialErrors: [],
  };
}

export function createUnavailableSlots(message: string): TelemetrySlots {
  const slots = createLoadingSlots();
  return Object.fromEntries(
    TELEMETRY_SLOT_IDS.map((slotId) => [
      slotId,
      {
        ...slots[slotId],
        state: "error" as const,
        supportingText: message,
      },
    ]),
  ) as unknown as TelemetrySlots;
}

export function createUnavailableVehicle(): VehicleTelemetry {
  return {
    controlLink: "disabled",
    connection: "offline",
    motion: "stop",
    speedPercent: 0,
    batteryPercent: null,
    obstacleDistanceCm: null,
    signalDbm: null,
    headingDeg: null,
    powerTelemetry: {
      state: "offline",
      deviceId: null,
      busVoltageV: null,
      psuVoltageV: null,
      currentA: null,
      powerW: null,
      percentage: null,
      observedAt: null,
      receivedAt: null,
    },
    fireDetection: {
      state: "offline",
      detected: null,
      observedAt: null,
      receivedAt: null,
    },
    observedAt: null,
    lastSeenAt: null,
    wheelSpeeds: null,
    imu: null,
    odometry: null,
  };
}
