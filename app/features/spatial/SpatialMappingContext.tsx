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
import { useIotDashboard } from "@/app/features/iot/use-iot-dashboard";
import {
  TELEMETRY_SLOT_IDS,
  type TelemetrySlotId,
} from "@/app/lib/iot/contracts";
import {
  DEFAULT_ROOM_MAP_DIMENSIONS,
  DEFAULT_ROOM_MAP_MANIFEST,
  MAX_NAVIGATION_CHECKPOINTS,
  MAX_SPATIAL_OBSERVATIONS,
  MAX_TRACK_POINTS,
  NAVIGATION_CHECKPOINT_STORAGE_KEY,
  SPATIAL_MAP_STORAGE_KEY,
  type NavigationCheckpoint,
  type RoomMapDimensions,
  type RoomMapManifest,
  type SpatialCalibration,
  type SpatialObservation,
  type SpatialObservationValue,
  type SpatialTrackingQuality,
  type VehicleMapPose,
  type VehicleTrackPoint,
} from "@/app/lib/spatial/contracts";
import {
  integrateWheelPoseWithJetsonHeading,
  metricPoseToMapPose,
  poseFromDeviceOdometry,
  shortestHeadingDeltaDeg,
  type MetricMapPose,
} from "@/app/lib/spatial/odometry";

interface StoredSpatialState {
  version: 1;
  mapDimensions: RoomMapDimensions;
  calibration: SpatialCalibration | null;
  observations: SpatialObservation[];
}

interface PoseHistoryItem {
  receivedAtMs: number;
  pose: VehicleMapPose;
}

interface DevicePoseOrigin {
  xMm: number;
  yMm: number;
  headingDeg: number;
}

interface SpatialMappingValue {
  manifest: RoomMapManifest;
  mapDimensions: RoomMapDimensions;
  setMapDimensions(widthM: number, heightM: number): void;
  calibration: SpatialCalibration | null;
  calibrationConfirmed: boolean;
  calibrateAt(x: number, y: number, headingDeg: number): void;
  pose: VehicleMapPose | null;
  track: readonly VehicleTrackPoint[];
  observations: readonly SpatialObservation[];
  checkpoints: readonly NavigationCheckpoint[];
  saveCheckpoint(input: { id?: string; name: string; x: number; y: number }): NavigationCheckpoint;
  deleteCheckpoint(id: string): void;
  clearTrack(): void;
  clearObservations(): void;
  trackingQuality: SpatialTrackingQuality | null;
}

const SpatialMappingContext = createContext<SpatialMappingValue | null>(null);

function createId(prefix: string) {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function finiteInRange(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function readStoredState(): StoredSpatialState {
  const fallback: StoredSpatialState = {
    version: 1,
    mapDimensions: DEFAULT_ROOM_MAP_DIMENSIONS,
    calibration: null,
    observations: [],
  };
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SPATIAL_MAP_STORAGE_KEY) ?? "null") as Partial<StoredSpatialState> | null;
    if (!parsed || parsed.version !== 1) return fallback;
    const widthM = parsed.mapDimensions?.widthM;
    const heightM = parsed.mapDimensions?.heightM;
    const mapDimensions = finiteInRange(widthM, 2, 20) && finiteInRange(heightM, 2, 20)
      ? { widthM: Number(widthM), heightM: Number(heightM), source: parsed.mapDimensions?.source === "manual" ? "manual" as const : "estimated" as const }
      : fallback.mapDimensions;
    const calibration = parsed.calibration
      && finiteInRange(parsed.calibration.originX, 0, 1)
      && finiteInRange(parsed.calibration.originY, 0, 1)
      && Number.isFinite(parsed.calibration.headingDeg)
      ? parsed.calibration
      : null;
    const observations = Array.isArray(parsed.observations)
      ? parsed.observations.filter((item) => (
          item
          && typeof item.id === "string"
          && typeof item.observedAt === "string"
          && finiteInRange(item.x, -1, 2)
          && finiteInRange(item.y, -1, 2)
        )).slice(-MAX_SPATIAL_OBSERVATIONS)
      : [];
    return { version: 1, mapDimensions, calibration, observations };
  } catch {
    return fallback;
  }
}

function normalizedCheckpointName(value: string) {
  const name = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 20) throw new Error("检查点名称需为 1–20 个字符");
  return name;
}

function readStoredCheckpoints(): NavigationCheckpoint[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(NAVIGATION_CHECKPOINT_STORAGE_KEY) ?? "null") as {
      version?: unknown;
      checkpoints?: unknown;
    } | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.checkpoints)) return [];
    const seen = new Set<string>();
    const checkpoints: NavigationCheckpoint[] = [];
    for (const value of parsed.checkpoints.slice(0, MAX_NAVIGATION_CHECKPOINTS)) {
      if (!value || typeof value !== "object") continue;
      const candidate = value as Partial<NavigationCheckpoint>;
      if (typeof candidate.id !== "string" || candidate.id.length < 1 || candidate.id.length > 128
        || typeof candidate.name !== "string"
        || !finiteInRange(candidate.x, 0, 1) || !finiteInRange(candidate.y, 0, 1)
        || typeof candidate.createdAt !== "string" || typeof candidate.updatedAt !== "string") continue;
      let name: string;
      try {
        name = normalizedCheckpointName(candidate.name);
      } catch {
        continue;
      }
      const key = name.toLocaleLowerCase("zh-CN");
      if (seen.has(key)) continue;
      seen.add(key);
      checkpoints.push({
        id: candidate.id,
        name,
        x: Number(candidate.x),
        y: Number(candidate.y),
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      });
    }
    return checkpoints;
  } catch {
    return [];
  }
}

function metricOrigin(headingDeg: number): MetricMapPose {
  return { rightM: 0, downM: 0, headingDeg, distanceM: 0 };
}

function closestPose(history: readonly PoseHistoryItem[], targetMs: number) {
  let closest: PoseHistoryItem | null = null;
  let offsetMs = Number.POSITIVE_INFINITY;
  for (const item of history) {
    const nextOffset = Math.abs(item.receivedAtMs - targetMs);
    if (nextOffset < offsetMs) {
      closest = item;
      offsetMs = nextOffset;
    }
  }
  return { closest, offsetMs };
}

export function SpatialMappingProvider({ children }: { children: ReactNode }) {
  const { snapshot, navigation } = useIotDashboard();
  const [initialState] = useState(readStoredState);
  const [initialCheckpoints] = useState(readStoredCheckpoints);

  const [mapDimensions, setMapDimensionsState] = useState(initialState.mapDimensions);
  const [calibration, setCalibration] = useState<SpatialCalibration | null>(initialState.calibration);
  const [calibrationConfirmed, setCalibrationConfirmed] = useState(false);
  const [pose, setPose] = useState<VehicleMapPose | null>(null);
  const [track, setTrack] = useState<VehicleTrackPoint[]>([]);
  const [observations, setObservations] = useState<SpatialObservation[]>(initialState.observations);
  const [checkpoints, setCheckpoints] = useState<NavigationCheckpoint[]>(initialCheckpoints);

  const metricPoseRef = useRef<MetricMapPose | null>(null);
  const deviceOriginRef = useRef<DevicePoseOrigin | null>(null);
  const lastOdomKeyRef = useRef<string | null>(null);
  const lastOdomReceivedMsRef = useRef<number | null>(null);
  const lastImuHeadingRef = useRef<number | null>(null);
  const lastImuZeroRevisionRef = useRef<number | null>(null);
  const poseHistoryRef = useRef<PoseHistoryItem[]>([]);
  const seenObservationKeysRef = useRef(new Set<string>());

  useEffect(() => {
    for (const observation of observations) {
      for (const slotId of Object.keys(observation.values) as TelemetrySlotId[]) {
        seenObservationKeysRef.current.add(`${slotId}:${observation.observedAt}`);
      }
    }
  }, [observations]);

  useEffect(() => {
    const stored: StoredSpatialState = {
      version: 1,
      mapDimensions,
      calibration,
      observations: observations.slice(-MAX_SPATIAL_OBSERVATIONS),
    };
    window.localStorage.setItem(SPATIAL_MAP_STORAGE_KEY, JSON.stringify(stored));
  }, [calibration, mapDimensions, observations]);

  useEffect(() => {
    window.localStorage.setItem(NAVIGATION_CHECKPOINT_STORAGE_KEY, JSON.stringify({
      version: 1,
      checkpoints,
    }));
  }, [checkpoints]);

  const saveCheckpoint = useCallback((input: { id?: string; name: string; x: number; y: number }) => {
    if (!finiteInRange(input.x, 0, 1) || !finiteInRange(input.y, 0, 1)) {
      throw new Error("检查点坐标无效");
    }
    const name = normalizedCheckpointName(input.name);
    const duplicate = checkpoints.find((checkpoint) => (
      checkpoint.id !== input.id
      && checkpoint.name.toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN")
    ));
    if (duplicate) throw new Error(`检查点“${name}”已存在`);
    const existing = input.id ? checkpoints.find((checkpoint) => checkpoint.id === input.id) : null;
    if (!existing && checkpoints.length >= MAX_NAVIGATION_CHECKPOINTS) {
      throw new Error(`固定检查点最多保存 ${MAX_NAVIGATION_CHECKPOINTS} 个`);
    }
    const now = new Date().toISOString();
    const checkpoint: NavigationCheckpoint = {
      id: existing?.id ?? createId("checkpoint"),
      name,
      x: input.x,
      y: input.y,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    setCheckpoints((current) => (
      existing
        ? current.map((item) => item.id === existing.id ? checkpoint : item)
        : [...current, checkpoint]
    ));
    return checkpoint;
  }, [checkpoints]);

  const deleteCheckpoint = useCallback((id: string) => {
    setCheckpoints((current) => current.filter((checkpoint) => checkpoint.id !== id));
  }, []);

  const setMapDimensions = useCallback((widthM: number, heightM: number) => {
    if (!finiteInRange(widthM, 2, 20) || !finiteInRange(heightM, 2, 20)) return;
    setMapDimensionsState({ widthM, heightM, source: "manual" });
    setCalibrationConfirmed(false);
    setPose(null);
    setTrack([]);
    metricPoseRef.current = null;
    lastImuHeadingRef.current = null;
    lastImuZeroRevisionRef.current = null;
    poseHistoryRef.current = [];
  }, []);

  const calibrateAt = useCallback((x: number, y: number, headingDeg: number) => {
    if (!finiteInRange(x, 0, 1) || !finiteInRange(y, 0, 1) || !Number.isFinite(headingDeg)) return;
    const now = new Date().toISOString();
    const normalizedHeading = ((headingDeg % 360) + 360) % 360;
    const nextCalibration: SpatialCalibration = {
      id: createId("calibration"),
      originX: x,
      originY: y,
      headingDeg: normalizedHeading,
      createdAt: now,
    };
    const odometry = snapshot.vehicle.odometry;
    deviceOriginRef.current = odometry?.source === "device-pose-v2" && odometry.pose
      ? { ...odometry.pose }
      : null;
    lastOdomKeyRef.current = odometry ? `${odometry.sequence ?? "v1"}:${odometry.receivedAt}` : null;
    lastOdomReceivedMsRef.current = odometry ? Date.parse(odometry.receivedAt) : null;
    lastImuHeadingRef.current = snapshot.vehicle.imu && snapshot.vehicle.imu.state !== "stale"
      ? snapshot.vehicle.imu.relativeHeadingDeg
      : null;
    lastImuZeroRevisionRef.current = snapshot.vehicle.imu && snapshot.vehicle.imu.state !== "stale"
      ? snapshot.vehicle.imu.zeroRevision
      : null;
    const initialMetricPose = metricOrigin(normalizedHeading);
    const initialPose = metricPoseToMapPose(
      initialMetricPose,
      { x, y },
      mapDimensions,
      odometry?.receivedAt ?? now,
      odometry?.quality ?? "unavailable",
    );
    metricPoseRef.current = initialMetricPose;
    poseHistoryRef.current = [{ receivedAtMs: Date.parse(odometry?.receivedAt ?? now), pose: initialPose }];
    setCalibration(nextCalibration);
    setCalibrationConfirmed(true);
    setPose(initialPose);
    setTrack([{ ...initialPose, id: createId("track") }]);
  }, [mapDimensions, snapshot.vehicle.imu, snapshot.vehicle.odometry]);

  useEffect(() => {
    if (!calibrationConfirmed || !calibration) return;
    if (navigation?.state === "running" && navigation.pose) return;
    const odometry = snapshot.vehicle.odometry;
    if (!odometry || snapshot.vehicle.connection !== "online") return;
    const odometrySampledAt = odometry.observedAt || odometry.receivedAt;
    const odomKey = `${odometry.sequence ?? "v1"}:${odometrySampledAt}`;
    if (lastOdomKeyRef.current === odomKey) return;

    const receivedAtMs = Date.parse(odometrySampledAt);
    if (!Number.isFinite(receivedAtMs)) return;
    let nextMetric: MetricMapPose | null = null;
    if (odometry.source === "device-pose-v2" && odometry.pose) {
      const origin = deviceOriginRef.current;
      if (!origin) {
        deviceOriginRef.current = { ...odometry.pose };
        nextMetric = metricOrigin(calibration.headingDeg);
      } else {
        nextMetric = poseFromDeviceOdometry(calibration, origin, odometry.pose);
      }
    } else if (snapshot.vehicle.wheelSpeeds && metricPoseRef.current) {
      const previousMs = lastOdomReceivedMsRef.current;
      if (previousMs !== null) {
        const dtSeconds = (receivedAtMs - previousMs) / 1_000;
        const imu = snapshot.vehicle.imu;
        const previousImuHeading = lastImuHeadingRef.current;
        if (odometry.source === "wheel-jetson-heading-v2" && imu && imu.state === "live") {
          const zeroRevisionChanged = lastImuZeroRevisionRef.current !== null
            && lastImuZeroRevisionRef.current !== imu.zeroRevision;
          const imuHeadingDeltaDeg = previousImuHeading !== null && !zeroRevisionChanged
            ? shortestHeadingDeltaDeg(previousImuHeading, imu.relativeHeadingDeg)
            : 0;
          nextMetric = integrateWheelPoseWithJetsonHeading(
            metricPoseRef.current,
            snapshot.vehicle.wheelSpeeds,
            dtSeconds,
            imuHeadingDeltaDeg,
          );
          lastImuHeadingRef.current = imu.relativeHeadingDeg;
          lastImuZeroRevisionRef.current = imu.zeroRevision;
        }
      }
    }

    lastOdomKeyRef.current = odomKey;
    lastOdomReceivedMsRef.current = receivedAtMs;
    if (!nextMetric) return;
    metricPoseRef.current = nextMetric;
    const nextPose = metricPoseToMapPose(
      nextMetric,
      { x: calibration.originX, y: calibration.originY },
      mapDimensions,
      odometry.receivedAt,
      odometry.quality,
    );
    setPose(nextPose);
    poseHistoryRef.current = [...poseHistoryRef.current, { receivedAtMs, pose: nextPose }]
      .filter((item) => receivedAtMs - item.receivedAtMs <= 120_000)
      .slice(-600);
    setTrack((current) => {
      const last = current.at(-1);
      if (last && Math.hypot(nextPose.x - last.x, nextPose.y - last.y) < 0.0025
        && receivedAtMs - Date.parse(last.observedAt ?? "") < 250) return current;
      return [...current, { ...nextPose, id: createId("track") }].slice(-MAX_TRACK_POINTS);
    });
  }, [calibration, calibrationConfirmed, mapDimensions, navigation?.pose, navigation?.state, snapshot.vehicle]);

  useEffect(() => {
    if (!calibrationConfirmed || !calibration || !navigation?.pose) return;
    if (!["running", "completed", "failed", "cancelled", "stopped"].includes(navigation.state)) return;
    const now = navigation.observedAt ?? new Date().toISOString();
    const completedDistanceM = Math.max(0, (navigation.distanceM ?? 0) - (navigation.remainingDistanceM ?? 0));
    const nextPose: VehicleMapPose = {
      x: navigation.pose.x,
      y: navigation.pose.y,
      headingDeg: navigation.pose.headingDeg,
      distanceM: Math.max(metricPoseRef.current?.distanceM ?? 0, completedDistanceM),
      observedAt: now,
      quality: "reported",
    };
    metricPoseRef.current = {
      rightM: (nextPose.x - calibration.originX) * mapDimensions.widthM,
      downM: (nextPose.y - calibration.originY) * mapDimensions.heightM,
      headingDeg: nextPose.headingDeg,
      distanceM: nextPose.distanceM,
    };
    const odometry = snapshot.vehicle.odometry;
    lastOdomKeyRef.current = odometry ? `${odometry.sequence ?? "v1"}:${odometry.observedAt || odometry.receivedAt}` : null;
    lastOdomReceivedMsRef.current = odometry ? Date.parse(odometry.observedAt || odometry.receivedAt) : null;
    lastImuHeadingRef.current = snapshot.vehicle.imu?.relativeHeadingDeg ?? null;
    lastImuZeroRevisionRef.current = snapshot.vehicle.imu?.zeroRevision ?? null;
    setPose(nextPose);
    const receivedAtMs = Date.parse(now);
    if (Number.isFinite(receivedAtMs)) {
      poseHistoryRef.current = [...poseHistoryRef.current, { receivedAtMs, pose: nextPose }]
        .filter((item) => receivedAtMs - item.receivedAtMs <= 120_000)
        .slice(-600);
    }
    setTrack((current) => {
      const last = current.at(-1);
      if (last && Math.hypot(nextPose.x - last.x, nextPose.y - last.y) < 0.0025) return current;
      return [...current, { ...nextPose, id: createId("navigation-track") }].slice(-MAX_TRACK_POINTS);
    });
  }, [calibration, calibrationConfirmed, mapDimensions, navigation, snapshot.vehicle.imu, snapshot.vehicle.odometry]);

  useEffect(() => {
    if (!calibrationConfirmed || !calibration || !pose) return;
    if (snapshot.provider !== "huawei-cloud" || snapshot.vehicle.connection !== "online" || !snapshot.vehicle.odometry) return;

    const groups = new Map<string, Partial<Record<TelemetrySlotId, SpatialObservationValue>>>();
    for (const slotId of TELEMETRY_SLOT_IDS) {
      const slot = snapshot.slots[slotId];
      if (slot.state !== "live" || slot.value === null || !Number.isFinite(slot.value) || !slot.observedAt) continue;
      if (Date.parse(slot.observedAt) < Date.parse(calibration.createdAt) - 1_000) continue;
      const key = `${slotId}:${slot.observedAt}`;
      if (seenObservationKeysRef.current.has(key)) continue;
      const values = groups.get(slot.observedAt) ?? {};
      values[slotId] = { value: slot.value, unit: slot.unit };
      groups.set(slot.observedAt, values);
    }
    if (groups.size === 0) return;

    const nextObservations: SpatialObservation[] = [];
    for (const [observedAt, values] of groups) {
      const targetMs = Date.parse(observedAt);
      const { closest, offsetMs } = closestPose(poseHistoryRef.current, targetMs);
      const mappedPose = closest && offsetMs <= 15_000 ? closest.pose : pose;
      const alignment = closest && offsetMs <= 15_000 ? "device-time" as const : "arrival-time" as const;
      nextObservations.push({
        id: `${calibration.id}:${observedAt}`,
        observedAt,
        receivedAt: snapshot.generatedAt,
        x: mappedPose.x,
        y: mappedPose.y,
        headingDeg: mappedPose.headingDeg,
        alignment,
        alignmentOffsetMs: Number.isFinite(offsetMs) ? offsetMs : null,
        quality: mappedPose.quality,
        values,
      });
      for (const slotId of Object.keys(values) as TelemetrySlotId[]) {
        seenObservationKeysRef.current.add(`${slotId}:${observedAt}`);
      }
    }
    // Context changes are the external telemetry subscription for this provider.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setObservations((current) => [...current, ...nextObservations].slice(-MAX_SPATIAL_OBSERVATIONS));
  }, [calibration, calibrationConfirmed, pose, snapshot.generatedAt, snapshot.provider, snapshot.slots, snapshot.vehicle.connection, snapshot.vehicle.odometry]);

  const clearTrack = useCallback(() => {
    setTrack((current) => pose ? [{ ...pose, id: createId("track") }] : current.slice(-1));
  }, [pose]);

  const clearObservations = useCallback(() => {
    setObservations([]);
    seenObservationKeysRef.current.clear();
  }, []);

  const value = useMemo<SpatialMappingValue>(() => ({
    manifest: DEFAULT_ROOM_MAP_MANIFEST,
    mapDimensions,
    setMapDimensions,
    calibration,
    calibrationConfirmed,
    calibrateAt,
    pose,
    track,
    observations,
    checkpoints,
    saveCheckpoint,
    deleteCheckpoint,
    clearTrack,
    clearObservations,
    trackingQuality: navigation?.pose && ["running", "completed", "failed", "cancelled", "stopped"].includes(navigation.state)
      ? "reported"
      : snapshot.vehicle.odometry?.quality ?? null,
  }), [calibrateAt, calibration, calibrationConfirmed, checkpoints, clearObservations, clearTrack, deleteCheckpoint, mapDimensions, navigation, observations, pose, saveCheckpoint, setMapDimensions, snapshot.vehicle.odometry, track]);

  return <SpatialMappingContext.Provider value={value}>{children}</SpatialMappingContext.Provider>;
}

export function useSpatialMapping() {
  const value = useContext(SpatialMappingContext);
  if (!value) throw new Error("useSpatialMapping 必须在 SpatialMappingProvider 内使用。");
  return value;
}
