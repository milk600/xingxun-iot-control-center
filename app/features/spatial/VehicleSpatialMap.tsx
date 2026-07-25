"use client";

import {
  Cloud,
  Crosshair,
  Droplets,
  FlaskConical,
  LocateFixed,
  MapPin,
  MapPinned,
  Octagon,
  Pencil,
  PencilLine,
  Play,
  Route,
  Ruler,
  Save,
  Sun,
  Thermometer,
  Trash2,
  Undo2,
  Wind,
  Eraser,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AI_ACTION_EVENT,
  registerActionReceiver,
  readActionDispatchDetail,
  reportActionError,
  reportActionSuccess,
} from "@/app/lib/ai/action-events";
import { useIotDashboard } from "@/app/features/iot/use-iot-dashboard";
import { useAndroidBack } from "@/app/features/ui/useAndroidBack";
import type { AgentActionDispatchDetail } from "@/app/lib/ai/contracts";
import type { TelemetrySlotId } from "@/app/lib/iot/contracts";
import type {
  NavigationMapDefinition,
  NavigationPoint,
  NavigationStroke,
  NavigationTaskState,
} from "@/app/lib/iot/jetson-websocket";
import {
  ROOM_ONE_NAVIGATION_MAP_ASSETS,
  ROOM_ONE_NAVIGATION_MAP_VIEW,
} from "@/app/lib/digital-twin/room-one-coordinate-system";
import type { HeatCell, HeatSample } from "@/app/lib/spatial/interpolation";
import {
  buildSpatialHeatGrid,
  heatSamplesForLayer,
  representativeHeatSamples,
} from "@/app/lib/spatial/interpolation";
import type { NavigationCheckpoint, SpatialLayerId } from "@/app/lib/spatial/contracts";
import { useSpatialMapping } from "./SpatialMappingContext";
import styles from "./VehicleSpatialMap.module.css";

const MAP_IMAGE = ROOM_ONE_NAVIGATION_MAP_ASSETS.image;
const MAP_MASK = ROOM_ONE_NAVIGATION_MAP_ASSETS.mask;
const GRID_COLUMNS = 64;
const GRID_ROWS = 80;
const INFLUENCE_RADIUS = 0.22;
const NAVIGATION_DRAFT_KEY = "xingxun:navigation-map-draft:v1";
const NAVIGATION_RESOLUTION_M = 0.05 as const;
const VEHICLE_LENGTH_M = 0.0;
const VEHICLE_WIDTH_M = 0.0;
const VEHICLE_CLEARANCE_M = 0.0;
const MAX_NAVIGATION_POINTS = 4_096;
const NAVIGATION_IMAGE_WIDTH = ROOM_ONE_NAVIGATION_MAP_VIEW.width;
const NAVIGATION_IMAGE_HEIGHT = ROOM_ONE_NAVIGATION_MAP_VIEW.height;
const NAVIGATION_CONTENT_BOUNDS = ROOM_ONE_NAVIGATION_MAP_VIEW.contentBounds;

interface LayerDefinition {
  id: SpatialLayerId;
  label: string;
  icon: LucideIcon;
  slotId: TelemetrySlotId | null;
  accent: string;
  palette: readonly [string, string, string];
}

const LAYERS: readonly LayerDefinition[] = [
  { id: "position", label: "位置", icon: LocateFixed, slotId: null, accent: "#3478f6", palette: ["#dbeafe", "#60a5fa", "#1d4ed8"] },
  { id: "slot-1", label: "温度", icon: Thermometer, slotId: "slot-1", accent: "#e78332", palette: ["#3b82f6", "#f6c453", "#ef6a3a"] },
  { id: "slot-2", label: "湿度", icon: Droplets, slotId: "slot-2", accent: "#18aeb7", palette: ["#dff7f6", "#42c7c9", "#1977c9"] },
  { id: "slot-3", label: "CO₂", icon: Cloud, slotId: "slot-3", accent: "#26a269", palette: ["#dcfce7", "#4fc48b", "#2367b1"] },
  { id: "slot-4", label: "TVOC", icon: Wind, slotId: "slot-4", accent: "#9868dc", palette: ["#ede9fe", "#a978df", "#5940a8"] },
  { id: "slot-5", label: "甲醛", icon: FlaskConical, slotId: "slot-5", accent: "#d45f86", palette: ["#fce7f3", "#dc76a0", "#9f3f74"] },
  { id: "slot-6", label: "光照", icon: Sun, slotId: "slot-6", accent: "#d99a20", palette: ["#475569", "#f1c75b", "#fff2a8"] },
] as const;

interface CalibrationDraft {
  pointerId: number;
  x: number;
  y: number;
  headingDeg: number;
  startClientX: number;
  startClientY: number;
}

type ClearTarget = "track" | "observations" | null;
type MapEditMode = "idle" | "draw" | "erase" | "target" | "checkpoint";

interface CheckpointEditorState {
  mode: "create" | "rename";
  point: NavigationPoint;
  checkpointId?: string;
}

interface ActiveWallStroke extends NavigationStroke {
  pointerId: number;
}

interface StoredNavigationDraft {
  version: 1;
  baseRevision: number;
  dirty: boolean;
  strokes: NavigationStroke[];
}

interface PendingNavigationRetry {
  point: NavigationPoint;
  checkpointId: string | null;
  revision: number;
}

function navigationRevisionConflict(message: {
  state?: NavigationTaskState;
  error?: string;
  reason?: string;
  mapRevision?: number;
} | null | undefined) {
  if (message?.state !== "failed") return null;
  const detail = `${message.error ?? ""} ${message.reason ?? ""}`;
  if (!/(?:地图修订冲突|map\s*revision\s*(?:conflict|mismatch))/iu.test(detail)) return null;
  const explicit = detail.match(/(?:当前修订(?:为|是)?|current\s*(?:map\s*)?revision(?:\s*is)?)\s*[:：]?\s*(\d+)/iu);
  const revision = explicit ? Number(explicit[1]) : message.mapRevision;
  return Number.isSafeInteger(revision) && Number(revision) >= 1 ? Number(revision) : null;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function normalizeHeading(value: number) {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function headingFromDrag(draft: CalibrationDraft, clientX: number, clientY: number) {
  const deltaX = clientX - draft.startClientX;
  const deltaY = clientY - draft.startClientY;
  if (Math.hypot(deltaX, deltaY) < 8) return draft.headingDeg;
  return normalizeHeading(Math.atan2(deltaX, -deltaY) * 180 / Math.PI);
}

function finiteMapPoint(point: { x: number; y: number }) {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function createLocalId(prefix: string) {
  return typeof crypto.randomUUID === "function"
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function validNavigationStrokes(value: unknown): value is NavigationStroke[] {
  if (!Array.isArray(value) || value.length > 256) return false;
  let pointCount = 0;
  return value.every((stroke) => {
    if (!stroke || typeof stroke !== "object") return false;
    const candidate = stroke as Partial<NavigationStroke>;
    if (typeof candidate.id !== "string" || !Array.isArray(candidate.points) || candidate.points.length < 2) return false;
    pointCount += candidate.points.length;
    return pointCount <= MAX_NAVIGATION_POINTS && candidate.points.every((point) => (
      point && Number.isFinite(point.x) && Number.isFinite(point.y)
      && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
    ));
  });
}

function readNavigationDraft(): StoredNavigationDraft {
  const fallback: StoredNavigationDraft = { version: 1, baseRevision: 0, dirty: false, strokes: [] };
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(NAVIGATION_DRAFT_KEY) ?? "null") as Partial<StoredNavigationDraft> | null;
    if (!parsed || parsed.version !== 1 || !Number.isSafeInteger(parsed.baseRevision)
      || Number(parsed.baseRevision) < 0 || !validNavigationStrokes(parsed.strokes)) return fallback;
    return {
      version: 1,
      baseRevision: Number(parsed.baseRevision),
      dirty: parsed.dirty === true,
      strokes: parsed.strokes,
    };
  } catch {
    return fallback;
  }
}

function distanceToSegmentPx(
  point: NavigationPoint,
  start: NavigationPoint,
  end: NavigationPoint,
  width: number,
  height: number,
) {
  const px = point.x * width;
  const py = point.y * height;
  const ax = start.x * width;
  const ay = start.y * height;
  const bx = end.x * width;
  const by = end.y * height;
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const ratio = denominator === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / denominator));
  return Math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy));
}

function navigationStateLabel(state: NavigationTaskState | undefined) {
  const labels: Record<NavigationTaskState, string> = {
    "map-ready": "地图已同步",
    planning: "正在规划",
    planned: "路线待启动",
    running: "自动巡航中",
    completed: "已到达目标",
    failed: "巡航失败",
    cancelled: "巡航已取消",
    stopped: "小车已停止",
  };
  return state ? labels[state] : "等待地图同步";
}

function convexHull(samples: readonly HeatSample[]) {
  const points = samples
    .filter(finiteMapPoint)
    .map((sample) => ({ x: sample.x, y: sample.y }))
    .sort((left, right) => left.x - right.x || left.y - right.y);
  const unique = points.filter((point, index) => (
    index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y
  ));
  if (unique.length < 3) return unique;
  const cross = (origin: typeof unique[number], left: typeof unique[number], right: typeof unique[number]) => (
    (left.x - origin.x) * (right.y - origin.y)
    - (left.y - origin.y) * (right.x - origin.x)
  );
  const lower: typeof unique = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: typeof unique = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function insideConvexPolygon(point: { x: number; y: number }, polygon: readonly { x: number; y: number }[]) {
  if (polygon.length < 3) return false;
  let direction = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const left = polygon[index];
    const right = polygon[(index + 1) % polygon.length];
    const cross = (right.x - left.x) * (point.y - left.y) - (right.y - left.y) * (point.x - left.x);
    if (Math.abs(cross) < 1e-8) continue;
    const nextDirection = Math.sign(cross);
    if (direction !== 0 && nextDirection !== direction) return false;
    direction = nextDirection;
  }
  return true;
}

function supportedCells(cells: readonly HeatCell[], samples: readonly HeatSample[], hull: readonly { x: number; y: number }[]) {
  const influenceRadiusSquared = INFLUENCE_RADIUS * INFLUENCE_RADIUS;
  return cells.filter((cell) => {
    if (!insideConvexPolygon(cell, hull)) return false;
    let nearby = 0;
    for (const sample of samples) {
      const deltaX = sample.x - cell.x;
      const deltaY = sample.y - cell.y;
      if (deltaX * deltaX + deltaY * deltaY <= influenceRadiusSquared) nearby += 1;
      if (nearby >= 3) return true;
    }
    return false;
  });
}

function parseHex(color: string) {
  const value = color.replace("#", "");
  const normalized = value.length === 3
    ? value.split("").map((item) => `${item}${item}`).join("")
    : value;
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function heatColor(palette: LayerDefinition["palette"], ratio: number, alpha: number) {
  const normalized = clamp01(ratio) * 2;
  const segment = Math.min(1, Math.floor(normalized));
  const amount = normalized - segment;
  const from = parseHex(palette[segment]);
  const to = parseHex(palette[segment + 1]);
  const channel = (left: number, right: number) => Math.round(left + (right - left) * amount);
  return `rgba(${channel(from.r, to.r)}, ${channel(from.g, to.g)}, ${channel(from.b, to.b)}, ${alpha.toFixed(3)})`;
}

function formatValue(value: number, unit: string) {
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 }).format(value)}${unit}`;
}

function formatObservedAt(value: string | null | undefined) {
  if (!value) return "等待位置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function VehicleSpatialMap() {
  const {
    snapshot,
    navigation,
    saveNavigationMap,
    planNavigation,
    startNavigation,
    cancelNavigation,
    refreshNavigation,
    sendCommand,
  } = useIotDashboard();
  const {
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
    trackingQuality,
  } = useSpatialMapping();
  const [activeLayerId, setActiveLayerId] = useState<SpatialLayerId>("position");
  const pendingActionRef = useRef<AgentActionDispatchDetail | null>(null);
  const [calibrationMode, setCalibrationMode] = useState(false);
  const [calibrationDraft, setCalibrationDraft] = useState<CalibrationDraft | null>(null);
  const [dimensionOpen, setDimensionOpen] = useState(false);
  const [widthInput, setWidthInput] = useState(String(mapDimensions.widthM));
  const [heightInput, setHeightInput] = useState(String(mapDimensions.heightM));
  const [dimensionError, setDimensionError] = useState<string | null>(null);
  const [clearTarget, setClearTarget] = useState<ClearTarget>(null);
  const [initialNavigationDraft] = useState(readNavigationDraft);
  const [wallStrokes, setWallStrokes] = useState<NavigationStroke[]>(initialNavigationDraft.strokes);
  const [wallBaseRevision, setWallBaseRevision] = useState(initialNavigationDraft.baseRevision);
  const [wallDirty, setWallDirty] = useState(initialNavigationDraft.dirty);
  const [mapEditMode, setMapEditMode] = useState<MapEditMode>("idle");
  const [activeWallStroke, setActiveWallStroke] = useState<ActiveWallStroke | null>(null);
  const [goalPoint, setGoalPoint] = useState<NavigationPoint | null>(null);
  const [wallClearArmed, setWallClearArmed] = useState(false);
  const [navigationFeedback, setNavigationFeedback] = useState<string | null>(null);
  const [pendingMapRevision, setPendingMapRevision] = useState<number | null>(null);
  const [pendingNavigationRetry, setPendingNavigationRetry] = useState<PendingNavigationRetry | null>(null);
  const [checkpointEditor, setCheckpointEditor] = useState<CheckpointEditorState | null>(null);
  const [checkpointName, setCheckpointName] = useState("");
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [checkpointDeleteArmed, setCheckpointDeleteArmed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapFrameRef = useRef<HTMLDivElement | null>(null);
  const checkpointInputRef = useRef<HTMLInputElement | null>(null);
  const autoRetriedConflictRef = useRef<string | null>(null);

  useAndroidBack(Boolean(checkpointEditor || selectedCheckpointId || dimensionOpen || clearTarget), () => {
    if (checkpointEditor) {
      setCheckpointEditor(null);
      setCheckpointError(null);
    } else if (selectedCheckpointId) {
      setSelectedCheckpointId(null);
      setCheckpointDeleteArmed(false);
    } else if (dimensionOpen) {
      setDimensionOpen(false);
      setDimensionError(null);
    } else {
      setClearTarget(null);
    }
  }, checkpointEditor ? 110 : selectedCheckpointId ? 100 : dimensionOpen ? 90 : 65);

  const navigationRunning = navigation?.state === "running";
  const navigationBusy = navigation?.state === "planning" || navigationRunning;
  const navigationMap = navigation?.map;
  const navigationPath = navigation?.path ?? [];
  const selectedCheckpoint = useMemo(
    () => checkpoints.find((checkpoint) => checkpoint.id === selectedCheckpointId) ?? null,
    [checkpoints, selectedCheckpointId],
  );

  useEffect(() => {
    if (!checkpointEditor) return;
    const frame = window.requestAnimationFrame(() => {
      checkpointInputRef.current?.focus();
      checkpointInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [checkpointEditor]);

  useEffect(() => {
    if (!checkpointDeleteArmed) return;
    const timer = window.setTimeout(() => setCheckpointDeleteArmed(false), 2_500);
    return () => window.clearTimeout(timer);
  }, [checkpointDeleteArmed]);

  const renderedLayerId = useDeferredValue(activeLayerId);
  const layerPending = renderedLayerId !== activeLayerId;
  const requestedLayer = LAYERS.find((layer) => layer.id === activeLayerId) ?? LAYERS[0];
  const activeLayer = LAYERS.find((layer) => layer.id === renderedLayerId) ?? LAYERS[0];
  const heatSamples = useMemo(
    () => activeLayer.slotId ? heatSamplesForLayer(observations, activeLayer.slotId) : [],
    [activeLayer.slotId, observations],
  );
  const validHeatSamples = useMemo(
    () => heatSamples.filter((sample) => sample.x >= 0 && sample.x <= 1 && sample.y >= 0 && sample.y <= 1),
    [heatSamples],
  );
  const interpolationHeatSamples = useMemo(
    () => representativeHeatSamples(validHeatSamples, 480),
    [validHeatSamples],
  );
  const heatGrid = useMemo(
    () => buildSpatialHeatGrid(interpolationHeatSamples, GRID_COLUMNS, GRID_ROWS, INFLUENCE_RADIUS),
    [interpolationHeatSamples],
  );
  const heatHull = useMemo(() => convexHull(interpolationHeatSamples), [interpolationHeatSamples]);
  const drawableHeatCells = useMemo(
    () => heatGrid.interpolated ? supportedCells(heatGrid.cells, interpolationHeatSamples, heatHull) : [],
    [heatGrid, heatHull, interpolationHeatSamples],
  );
  const validSamples = useMemo(
    () => representativeHeatSamples(validHeatSamples, 360),
    [validHeatSamples],
  );
  const validTrack = useMemo(() => track.filter(finiteMapPoint), [track]);
  const activeUnit = useMemo(() => {
    if (!activeLayer.slotId) return "";
    return observations.find((observation) => observation.values[activeLayer.slotId!])
      ?.values[activeLayer.slotId]?.unit ?? "";
  }, [activeLayer.slotId, observations]);
  const contentWidth = NAVIGATION_IMAGE_WIDTH * NAVIGATION_CONTENT_BOUNDS.width;
  const contentHeight = NAVIGATION_IMAGE_HEIGHT * NAVIGATION_CONTENT_BOUNDS.height;
  const viewWidth = Math.max(1, contentWidth);
  const viewHeight = Math.max(1, contentHeight);
  const mapStyle = {
    aspectRatio: `${contentWidth} / ${contentHeight}`,
    "--layer-accent": activeLayer.accent,
  } as CSSProperties;
  const imageStyle = {
    width: `${100 / NAVIGATION_CONTENT_BOUNDS.width}%`,
    height: `${100 / NAVIGATION_CONTENT_BOUNDS.height}%`,
    left: `${-NAVIGATION_CONTENT_BOUNDS.left / NAVIGATION_CONTENT_BOUNDS.width * 100}%`,
    top: `${-NAVIGATION_CONTENT_BOUNDS.top / NAVIGATION_CONTENT_BOUNDS.height * 100}%`,
  } as CSSProperties;

  useEffect(() => {
    const stored: StoredNavigationDraft = {
      version: 1,
      baseRevision: wallBaseRevision,
      dirty: wallDirty,
      strokes: wallStrokes,
    };
    window.localStorage.setItem(NAVIGATION_DRAFT_KEY, JSON.stringify(stored));
  }, [wallBaseRevision, wallDirty, wallStrokes]);

  useEffect(() => {
    if (!navigationMap) return;
    const acknowledgesPendingSave = pendingMapRevision === navigationMap.revision;
    if (!acknowledgesPendingSave && wallDirty) return;
    // Jetson's persisted map is the shared source for desktop and Android.
    setWallStrokes(navigationMap.strokes);
    setWallBaseRevision(navigationMap.revision);
    setWallDirty(false);
    setPendingMapRevision(null);
    setNavigationFeedback("地图已保存到 Jetson。");
    if (Math.abs(navigationMap.widthM - mapDimensions.widthM) > 1e-6
      || Math.abs(navigationMap.heightM - mapDimensions.heightM) > 1e-6) {
      setMapDimensions(navigationMap.widthM, navigationMap.heightM);
    }
    if (pendingNavigationRetry?.revision === navigationMap.revision && pose) {
      const retry = pendingNavigationRetry;
      setPendingNavigationRetry(null);
      setSelectedCheckpointId(retry.checkpointId);
      setNavigationFeedback(`地图已同步到 Jetson 修订 ${navigationMap.revision}，正在重新规划路线…`);
      try {
        planNavigation({
          mapRevision: navigationMap.revision,
          start: { x: pose.x, y: pose.y, headingDeg: normalizeHeading(pose.headingDeg) },
          goal: retry.point,
        });
      } catch (error) {
        setNavigationFeedback(error instanceof Error ? error.message : "路线重新规划请求发送失败。");
      }
    }
  }, [mapDimensions.heightM, mapDimensions.widthM, navigationMap, pendingMapRevision, pendingNavigationRetry, planNavigation, pose, setMapDimensions, wallDirty]);

  useEffect(() => {
    if (navigation?.state !== "failed") return;
    const currentRevision = navigationRevisionConflict(navigation);
    if (currentRevision !== null && goalPoint && !wallDirty) {
      const retryKey = `${goalPoint.x}:${goalPoint.y}:${currentRevision}`;
      if (pendingNavigationRetry?.revision === currentRevision) return;
      if (autoRetriedConflictRef.current !== retryKey) {
        autoRetriedConflictRef.current = retryKey;
        setPendingNavigationRetry({
          point: goalPoint,
          checkpointId: selectedCheckpointId,
          revision: currentRevision,
        });
        setPendingMapRevision(null);
        setNavigationFeedback(`Jetson 地图已变为修订 ${currentRevision}，正在自动同步并重试本次路线…`);
        try {
          refreshNavigation();
        } catch (error) {
          window.setTimeout(() => {
            setPendingNavigationRetry(null);
            setNavigationFeedback(error instanceof Error ? error.message : "导航地图同步失败，请点击重试。");
          }, 0);
        }
        return;
      }
    }
    const timer = window.setTimeout(() => {
      setPendingMapRevision(null);
      setNavigationFeedback(currentRevision === null
        ? navigation.error ?? "Jetson 无法完成本次巡航操作。"
        : `地图已同步到 Jetson 修订 ${currentRevision}，但重新规划仍未完成；可点击“同步地图并重试”。`);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [goalPoint, navigation, pendingNavigationRetry?.revision, refreshNavigation, selectedCheckpointId, wallDirty]);

  useEffect(() => {
    if (!clearTarget) return;
    const timer = window.setTimeout(() => setClearTarget(null), 2_500);
    return () => window.clearTimeout(timer);
  }, [clearTarget]);

  useEffect(() => {
    if (!wallClearArmed) return;
    const timer = window.setTimeout(() => setWallClearArmed(false), 2_500);
    return () => window.clearTimeout(timer);
  }, [wallClearArmed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = mapFrameRef.current;
    if (!canvas || !host) return;
    const maskImage = new Image();
    maskImage.decoding = "async";
    const draw = () => {
      const bounds = host.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      if (!activeLayer.slotId || drawableHeatCells.length === 0 || heatGrid.min === null || heatGrid.max === null) return;
      const span = heatGrid.max - heatGrid.min;
      const cellWidth = width / GRID_COLUMNS;
      const cellHeight = height / GRID_ROWS;
      for (const cell of drawableHeatCells) {
        const ratio = span === 0 ? 0.5 : (cell.value - heatGrid.min) / span;
        context.fillStyle = heatColor(activeLayer.palette, ratio, Math.min(0.72, cell.alpha));
        context.fillRect(
          cell.x * width - cellWidth * 0.55,
          cell.y * height - cellHeight * 0.55,
          cellWidth * 1.1,
          cellHeight * 1.1,
        );
      }
      if (maskImage.complete && maskImage.naturalWidth > 0) {
        context.globalCompositeOperation = "destination-in";
        context.drawImage(
          maskImage,
          NAVIGATION_CONTENT_BOUNDS.left * maskImage.naturalWidth,
          NAVIGATION_CONTENT_BOUNDS.top * maskImage.naturalHeight,
          NAVIGATION_CONTENT_BOUNDS.width * maskImage.naturalWidth,
          NAVIGATION_CONTENT_BOUNDS.height * maskImage.naturalHeight,
          0,
          0,
          width,
          height,
        );
        context.globalCompositeOperation = "source-over";
      }
    };
    maskImage.addEventListener("load", draw);
    maskImage.src = MAP_MASK;
    draw();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(draw);
    observer?.observe(host);
    if (!observer) window.addEventListener("resize", draw);
    return () => {
      maskImage.removeEventListener("load", draw);
      observer?.disconnect();
      window.removeEventListener("resize", draw);
    };
  }, [activeLayer.palette, activeLayer.slotId, drawableHeatCells, heatGrid.max, heatGrid.min]);

  const pointFromEvent = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - bounds.left) / bounds.width),
      y: clamp01((event.clientY - bounds.top) / bounds.height),
    };
  }, []);

  const beginCalibration = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!calibrationMode) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    setCalibrationDraft({
      pointerId: event.pointerId,
      ...point,
      headingDeg: pose?.headingDeg ?? calibration?.headingDeg ?? 0,
      startClientX: event.clientX,
      startClientY: event.clientY,
    });
  }, [calibration?.headingDeg, calibrationMode, pointFromEvent, pose?.headingDeg]);

  const moveCalibration = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!calibrationMode) return;
    setCalibrationDraft((current) => current && current.pointerId === event.pointerId
      ? { ...current, headingDeg: headingFromDrag(current, event.clientX, event.clientY) }
      : current);
  }, [calibrationMode]);

  const finishCalibration = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!calibrationDraft || calibrationDraft.pointerId !== event.pointerId) return;
    event.preventDefault();
    const headingDeg = headingFromDrag(calibrationDraft, event.clientX, event.clientY);
    calibrateAt(calibrationDraft.x, calibrationDraft.y, headingDeg);
    setCalibrationDraft(null);
    setCalibrationMode(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, [calibrateAt, calibrationDraft]);

  const markWallsChanged = useCallback((next: NavigationStroke[]) => {
    setWallStrokes(next);
    setWallDirty(true);
    setPendingMapRevision(null);
    setGoalPoint(null);
    setNavigationFeedback("地图有未保存修改，请先保存到 Jetson 再规划路线。");
  }, []);

  const eraseWallAt = useCallback((point: NavigationPoint, width: number, height: number) => {
    let closestId: string | null = null;
    let closestDistance = 14;
    for (const stroke of wallStrokes) {
      for (let index = 1; index < stroke.points.length; index += 1) {
        const distance = distanceToSegmentPx(point, stroke.points[index - 1], stroke.points[index], width, height);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestId = stroke.id;
        }
      }
    }
    if (closestId) markWallsChanged(wallStrokes.filter((stroke) => stroke.id !== closestId));
  }, [markWallsChanged, wallStrokes]);

  const requestNavigationToPoint = useCallback((point: NavigationPoint, checkpoint?: NavigationCheckpoint) => {
    if (!calibrationConfirmed || !pose) {
      setNavigationFeedback("请先在地图上标定小车当前位置和朝向。");
      return;
    }
    if (wallDirty || wallBaseRevision < 1) {
      setNavigationFeedback("请先保存当前墙线地图，再选择目标点。");
      return;
    }
    if (snapshot.vehicle.connection !== "online" || snapshot.vehicle.imu?.state !== "live") {
      setNavigationFeedback("Jetson 航向或车辆回传尚未就绪。");
      return;
    }
    setGoalPoint(point);
    autoRetriedConflictRef.current = null;
    setPendingNavigationRetry(null);
    setMapEditMode("idle");
    setSelectedCheckpointId(checkpoint?.id ?? null);
    setCheckpointDeleteArmed(false);
    setActiveLayerId("position");
    setNavigationFeedback(checkpoint
      ? `正在规划前往“${checkpoint.name}”的路线…`
      : "目标已发送到 Jetson，正在规划路线…");
    try {
      planNavigation({
        mapRevision: navigationMap?.revision ?? wallBaseRevision,
        start: { x: pose.x, y: pose.y, headingDeg: normalizeHeading(pose.headingDeg) },
        goal: point,
      });
    } catch (error) {
      setNavigationFeedback(error instanceof Error ? error.message : "路线规划请求发送失败。");
    }
  }, [calibrationConfirmed, navigationMap, planNavigation, pose, snapshot.vehicle.connection, snapshot.vehicle.imu?.state, wallBaseRevision, wallDirty]);

  const beginMapInteraction = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (navigationRunning) return;
    if (calibrationMode) {
      beginCalibration(event);
      return;
    }
    if (mapEditMode === "idle") return;
    event.preventDefault();
    const point = pointFromEvent(event);
    if (mapEditMode === "checkpoint") {
      setCheckpointName("");
      setCheckpointError(null);
      setCheckpointEditor({ mode: "create", point });
      setSelectedCheckpointId(null);
      setMapEditMode("idle");
      return;
    }
    if (mapEditMode === "target") {
      requestNavigationToPoint(point);
      return;
    }
    if (mapEditMode === "erase") {
      const bounds = event.currentTarget.getBoundingClientRect();
      eraseWallAt(point, bounds.width, bounds.height);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setActiveWallStroke({
      id: createLocalId("wall"),
      pointerId: event.pointerId,
      points: [point],
    });
  }, [beginCalibration, calibrationMode, eraseWallAt, mapEditMode, navigationRunning, pointFromEvent, requestNavigationToPoint]);

  const moveMapInteraction = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (calibrationMode) {
      moveCalibration(event);
      return;
    }
    if (!activeWallStroke || activeWallStroke.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    setActiveWallStroke((current) => {
      if (!current || current.pointerId !== event.pointerId) return current;
      const last = current.points.at(-1)!;
      const distanceM = Math.hypot(
        (point.x - last.x) * mapDimensions.widthM,
        (point.y - last.y) * mapDimensions.heightM,
      );
      const totalPoints = wallStrokes.reduce((sum, stroke) => sum + stroke.points.length, 0) + current.points.length;
      if (distanceM < NAVIGATION_RESOLUTION_M / 2 || totalPoints >= MAX_NAVIGATION_POINTS) return current;
      return { ...current, points: [...current.points, point] };
    });
  }, [activeWallStroke, calibrationMode, mapDimensions.heightM, mapDimensions.widthM, moveCalibration, pointFromEvent, wallStrokes]);

  const finishMapInteraction = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (calibrationMode) {
      finishCalibration(event);
      return;
    }
    if (!activeWallStroke || activeWallStroke.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (activeWallStroke.points.length >= 2) {
      markWallsChanged([...wallStrokes, { id: activeWallStroke.id, points: activeWallStroke.points }]);
    }
    setActiveWallStroke(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, [activeWallStroke, calibrationMode, finishCalibration, markWallsChanged, wallStrokes]);

  const setInteractionMode = useCallback((mode: MapEditMode) => {
    setMapEditMode((current) => current === mode ? "idle" : mode);
    setCalibrationMode(false);
    setCalibrationDraft(null);
    setActiveWallStroke(null);
    setActiveLayerId("position");
  }, []);

  const saveWalls = useCallback(() => {
    if (navigationRunning) return;
    const nextRevision = wallBaseRevision + 1;
    const map: NavigationMapDefinition = {
      version: 1,
      mapId: "room-01",
      revision: nextRevision,
      widthM: mapDimensions.widthM,
      heightM: mapDimensions.heightM,
      resolutionM: NAVIGATION_RESOLUTION_M,
      vehicle: {
        lengthM: VEHICLE_LENGTH_M,
        widthM: VEHICLE_WIDTH_M,
        clearanceM: VEHICLE_CLEARANCE_M,
      },
      strokes: wallStrokes,
    };
    setPendingMapRevision(nextRevision);
    setNavigationFeedback("正在把固定障碍地图保存到 Jetson…");
    try {
      saveNavigationMap(map, wallBaseRevision);
    } catch (error) {
      setPendingMapRevision(null);
      setNavigationFeedback(error instanceof Error ? error.message : "地图保存请求发送失败。");
    }
  }, [mapDimensions.heightM, mapDimensions.widthM, navigationRunning, saveNavigationMap, wallBaseRevision, wallStrokes]);

  const undoWall = useCallback(() => {
    if (navigationRunning || wallStrokes.length === 0) return;
    markWallsChanged(wallStrokes.slice(0, -1));
  }, [markWallsChanged, navigationRunning, wallStrokes]);

  const clearWalls = useCallback(() => {
    if (navigationRunning) return;
    if (!wallClearArmed) {
      setWallClearArmed(true);
      return;
    }
    markWallsChanged([]);
    setWallClearArmed(false);
  }, [markWallsChanged, navigationRunning, wallClearArmed]);

  const beginNavigation = useCallback(() => {
    if (navigation?.state !== "planned" || !navigation.taskId || wallDirty) return;
    setNavigationFeedback("启动指令已发送，等待 Jetson 闭环执行回传。");
    try {
      window.dispatchEvent(new Event("xingxun:navigation-start"));
      startNavigation(navigation.taskId);
    } catch (error) {
      setNavigationFeedback(error instanceof Error ? error.message : "启动导航失败。");
    }
  }, [navigation, startNavigation, wallDirty]);

  const stopNavigation = useCallback(() => {
    setNavigationFeedback("正在发送停车指令…");
    void sendCommand("stop", 0);
  }, [sendCommand]);

  const discardNavigation = useCallback(() => {
    if (!navigation?.taskId) return;
    try {
      cancelNavigation(navigation.taskId);
    } catch (error) {
      setNavigationFeedback(error instanceof Error ? error.message : "取消路线失败。");
    }
  }, [cancelNavigation, navigation]);

  const synchronizeNavigation = useCallback(() => {
    try {
      refreshNavigation();
      setNavigationFeedback("正在从 Jetson 读取地图与任务状态…");
    } catch (error) {
      setNavigationFeedback(error instanceof Error ? error.message : "导航状态同步失败。");
    }
  }, [refreshNavigation]);

  const submitDimensions = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const width = Number(widthInput);
    const height = Number(heightInput);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || width > 20 || height < 2 || height > 20) {
      setDimensionError("请输入 2–20 米之间的房间尺寸。");
      return;
    }
    setMapDimensions(width, height);
    setWallDirty(true);
    setGoalPoint(null);
    setNavigationFeedback("房间尺寸已变化，请重新保存墙线地图并标定位置。");
    setDimensionError(null);
    setDimensionOpen(false);
    setCalibrationMode(true);
  };

  const submitCheckpoint = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!checkpointEditor) return;
    try {
      const saved = saveCheckpoint({
        id: checkpointEditor.checkpointId,
        name: checkpointName,
        x: checkpointEditor.point.x,
        y: checkpointEditor.point.y,
      });
      setSelectedCheckpointId(saved.id);
      setCheckpointEditor(null);
      setCheckpointError(null);
      setNavigationFeedback(`固定检查点“${saved.name}”已保存在本机。`);
    } catch (error) {
      setCheckpointError(error instanceof Error ? error.message : "固定检查点保存失败。");
    }
  };

  const beginRenameCheckpoint = useCallback((checkpoint: NavigationCheckpoint) => {
    setCheckpointName(checkpoint.name);
    setCheckpointError(null);
    setCheckpointDeleteArmed(false);
    setCheckpointEditor({
      mode: "rename",
      checkpointId: checkpoint.id,
      point: { x: checkpoint.x, y: checkpoint.y },
    });
  }, []);

  const removeSelectedCheckpoint = useCallback(() => {
    if (!selectedCheckpoint) return;
    if (!checkpointDeleteArmed) {
      setCheckpointDeleteArmed(true);
      return;
    }
    deleteCheckpoint(selectedCheckpoint.id);
    setSelectedCheckpointId(null);
    setCheckpointDeleteArmed(false);
    setNavigationFeedback(`固定检查点“${selectedCheckpoint.name}”已删除。`);
  }, [checkpointDeleteArmed, deleteCheckpoint, selectedCheckpoint]);

  useEffect(() => {
    const handleAction = (event: Event) => {
      const action = readActionDispatchDetail(event);
      if (!action) return;
      if (action.name === "spatial.set_layer") {
        if (renderedLayerId === action.arguments.layer) {
          reportActionSuccess(action, "巡检图层已符合要求。");
          return;
        }
        pendingActionRef.current = action;
        setActiveLayerId(action.arguments.layer);
        return;
      }
      if (action.name === "spatial.begin_calibration") {
        if (calibrationMode) {
          reportActionSuccess(action, "地图已处于起点标定模式。");
          return;
        }
        pendingActionRef.current = action;
        setCalibrationDraft(null);
        setMapEditMode("idle");
        setCalibrationMode(true);
        return;
      }
      if (action.name === "spatial.calibrate") {
        pendingActionRef.current = action;
        try {
          calibrateAt(
            clamp01(action.arguments.x),
            clamp01(action.arguments.y),
            normalizeHeading(action.arguments.headingDeg),
          );
          setCalibrationDraft(null);
          setMapEditMode("idle");
          setCalibrationMode(false);
        } catch (error) {
          pendingActionRef.current = null;
          reportActionError(action, error, "起点标定失败。");
        }
        return;
      }
      if (action.name === "spatial.set_dimensions") {
        const { widthM, heightM } = action.arguments;
        if (
          Math.abs(mapDimensions.widthM - widthM) <= 1e-6
          && Math.abs(mapDimensions.heightM - heightM) <= 1e-6
          && calibrationMode
        ) {
          reportActionSuccess(action, "巡检地图尺寸已符合要求。");
          return;
        }
        pendingActionRef.current = action;
        try {
          setMapDimensions(widthM, heightM);
          setWidthInput(String(widthM));
          setHeightInput(String(heightM));
          setDimensionError(null);
          setDimensionOpen(false);
          setCalibrationDraft(null);
          setMapEditMode("idle");
          setWallDirty(true);
          setGoalPoint(null);
          setCalibrationMode(true);
        } catch (error) {
          pendingActionRef.current = null;
          reportActionError(action, error, "巡检地图尺寸更新失败。");
        }
      }
    };
    window.addEventListener(AI_ACTION_EVENT, handleAction);
    const unregisterReceiver = registerActionReceiver([
      "spatial.set_layer",
      "spatial.begin_calibration",
      "spatial.calibrate",
      "spatial.set_dimensions",
    ]);
    return () => {
      unregisterReceiver();
      window.removeEventListener(AI_ACTION_EVENT, handleAction);
    };
  }, [
    activeLayerId,
    calibrateAt,
    calibrationMode,
    mapDimensions.heightM,
    mapDimensions.widthM,
    renderedLayerId,
    setMapDimensions,
  ]);

  useEffect(() => {
    const action = pendingActionRef.current;
    if (!action) return;
    if (action.name === "spatial.set_layer" && renderedLayerId === action.arguments.layer) {
      pendingActionRef.current = null;
      reportActionSuccess(action, "巡检图层已切换。");
      return;
    }
    if (action.name === "spatial.begin_calibration" && calibrationMode) {
      pendingActionRef.current = null;
      reportActionSuccess(action, "地图已进入起点标定模式。");
      return;
    }
    if (action.name === "spatial.calibrate" && calibration) {
      const x = clamp01(action.arguments.x);
      const y = clamp01(action.arguments.y);
      const heading = normalizeHeading(action.arguments.headingDeg);
      if (
        Math.abs(calibration.originX - x) <= 1e-6
        && Math.abs(calibration.originY - y) <= 1e-6
        && Math.abs(normalizeHeading(calibration.headingDeg) - heading) <= 1e-6
      ) {
        pendingActionRef.current = null;
        reportActionSuccess(action, "小车起点和朝向已标定。");
      }
      return;
    }
    if (action.name === "spatial.set_dimensions") {
      const { widthM, heightM } = action.arguments;
      if (
        Math.abs(mapDimensions.widthM - widthM) <= 1e-6
        && Math.abs(mapDimensions.heightM - heightM) <= 1e-6
        && calibrationMode
      ) {
        pendingActionRef.current = null;
        reportActionSuccess(action, "巡检地图尺寸已更新并进入重新标定模式。");
      }
    }
  }, [
    calibration,
    calibrationMode,
    mapDimensions.heightM,
    mapDimensions.widthM,
    renderedLayerId,
  ]);

  const requestClear = (target: Exclude<ClearTarget, null>) => {
    if (clearTarget !== target) {
      setClearTarget(target);
      return;
    }
    if (target === "track") clearTrack();
    else clearObservations();
    setClearTarget(null);
  };

  const calibrationPoint = calibrationDraft ?? (calibration ? {
    x: calibration.originX,
    y: calibration.originY,
    headingDeg: calibration.headingDeg,
  } : null);
  const poseOutside = Boolean(pose && (pose.x < 0 || pose.x > 1 || pose.y < 0 || pose.y > 1));
  const displayPose = pose ? { ...pose, x: clamp01(pose.x), y: clamp01(pose.y) } : null;
  const poseLabel = poseOutside
    ? "位置超出地图"
    : trackingQuality === "reported"
      ? "设备位姿"
      : trackingQuality === "fused"
        ? "Jetson 航向 + 轮速里程"
      : trackingQuality === "unavailable"
        ? "等待 Jetson 航向"
        : calibrationConfirmed ? "等待里程计" : "等待定位";
  const gridVisible = drawableHeatCells.length > 0;
  const layerSummary = activeLayer.slotId
    ? gridVisible
      ? `实测点 ${validHeatSamples.length} · 显示估算区域`
      : validHeatSamples.length > 0
        ? `实测点 ${validHeatSamples.length} · 样本不足，仅显示点位`
        : "暂无实测点"
    : poseOutside ? "位置已超出地图，请重新标定" : `${poseLabel} · 轨迹 ${validTrack.length} 点`;
  const displayedGoal = goalPoint ?? navigationPath.at(-1) ?? null;
  const canStartNavigation = navigation?.state === "planned" && Boolean(navigation.taskId) && !wallDirty;
  const navigationDetail = navigation?.state === "running"
    ? navigation.phase === "replanning"
      ? `${navigation.reason ?? "已停车，正在按当前位置重新规划"} · 路线版本 ${navigation.pathRevision ?? 1}`
      : `${navigation.phase === "turning" ? "正在转向" : navigation.phase === "driving" ? "正在前进" : "正在启动"} · 巡航点 ${navigation.segmentIndex ?? 0}/${navigation.segmentCount ?? 0}${navigation.replanCount ? ` · 已重规划 ${navigation.replanCount} 次` : ""}`
    : navigation?.state === "planned"
      ? `路线 ${navigation.distanceM?.toFixed(2) ?? "--"}m · 预计 ${Math.ceil(navigation.estimatedSeconds ?? 0)}秒`
      : navigation?.state === "completed"
        ? `用时 ${Math.ceil((navigation.elapsedMs ?? 0) / 1000)}秒${navigation.completionQuality === "tolerance" ? " · 在导航容差内到达" : ""}`
        : navigation?.error ?? navigation?.reason ?? navigationFeedback ?? "先画固定墙线，保存后选择目标点。";

  return (
    <section className={styles.root} data-ai-region="inspection-map" aria-label="小车空间巡检地图">
      <header className={styles.toolbar}>
        <div className={styles.titleBlock}>
          <span className={styles.titleIcon}><MapPinned size={19} aria-hidden="true" /></span>
          <div><h3>实景导航地图</h3><p>{poseLabel}</p></div>
        </div>
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={`${styles.toolButton}${calibrationMode ? ` ${styles.toolButtonActive}` : ""}`}
            aria-pressed={calibrationMode}
            disabled={navigationRunning}
            onClick={() => {
              setCalibrationMode((current) => !current);
              setCalibrationDraft(null);
              setMapEditMode("idle");
            }}
          >
            <Crosshair size={16} aria-hidden="true" />
            {calibrationConfirmed ? "重新定位" : "标定位置"}
          </button>
          <button
            type="button"
            className={styles.toolButton}
            aria-expanded={dimensionOpen}
            disabled={navigationRunning}
            onClick={() => {
              setWidthInput(String(mapDimensions.widthM));
              setHeightInput(String(mapDimensions.heightM));
              setDimensionError(null);
              setDimensionOpen((current) => !current);
            }}
          >
            <Ruler size={16} aria-hidden="true" />
            {mapDimensions.widthM.toFixed(1)} × {mapDimensions.heightM.toFixed(1)}m
          </button>
          <button type="button" className={styles.iconButton} title="清除行驶轨迹" aria-label={clearTarget === "track" ? "再次点击确认清除轨迹" : "清除行驶轨迹"} onClick={() => requestClear("track")}>
            {clearTarget === "track" ? <span>确认</span> : <LocateFixed size={17} aria-hidden="true" />}
          </button>
          <button type="button" className={styles.iconButton} title="清除空间采样" aria-label={clearTarget === "observations" ? "再次点击确认清除空间采样" : "清除空间采样"} onClick={() => requestClear("observations")}>
            {clearTarget === "observations" ? <span>确认</span> : <Trash2 size={17} aria-hidden="true" />}
          </button>
        </div>
      </header>

      {dimensionOpen && (
        <form className={styles.dimensionPanel} onSubmit={submitDimensions}>
          <label>宽度<input type="number" min="2" max="20" step="0.01" inputMode="decimal" value={widthInput} onChange={(event) => setWidthInput(event.target.value)} /><span>m</span></label>
          <label>长度<input type="number" min="2" max="20" step="0.01" inputMode="decimal" value={heightInput} onChange={(event) => setHeightInput(event.target.value)} /><span>m</span></label>
          <button type="submit">保存并标定</button>
          <button type="button" className={styles.quietButton} onClick={() => setDimensionOpen(false)}>取消</button>
          {dimensionError && <p role="alert">{dimensionError}</p>}
        </form>
      )}

      <section className={styles.navigationPanel} aria-label="固定地图自动巡航">
        <div className={styles.navigationEditor}>
          <div className={styles.navigationPanelTitle}>
            <span><Route size={17} aria-hidden="true" /></span>
            <div>
              <strong>固定地图巡航</strong>
              <small>仅避让手动画出的固定墙线，不具备实时障碍识别</small>
            </div>
          </div>
          <div className={styles.navigationTools} role="toolbar" aria-label="墙线地图编辑工具">
            <button type="button" className={mapEditMode === "draw" ? styles.navigationToolActive : undefined} aria-pressed={mapEditMode === "draw"} disabled={navigationBusy} onClick={() => setInteractionMode("draw")}>
              <Pencil size={15} aria-hidden="true" />画墙线
            </button>
            <button type="button" className={mapEditMode === "erase" ? styles.navigationToolActive : undefined} aria-pressed={mapEditMode === "erase"} disabled={navigationBusy || wallStrokes.length === 0} onClick={() => setInteractionMode("erase")}>
              <Eraser size={15} aria-hidden="true" />擦除
            </button>
            <button type="button" disabled={navigationBusy || wallStrokes.length === 0} onClick={undoWall}>
              <Undo2 size={15} aria-hidden="true" />撤销
            </button>
            <button type="button" className={wallClearArmed ? styles.navigationDangerArmed : undefined} disabled={navigationBusy || wallStrokes.length === 0} onClick={clearWalls}>
              <Trash2 size={15} aria-hidden="true" />{wallClearArmed ? "确认清空" : "清空"}
            </button>
            <button type="button" className={styles.navigationSaveButton} disabled={navigationBusy || !wallDirty || pendingMapRevision !== null} onClick={saveWalls}>
              <Save size={15} aria-hidden="true" />{pendingMapRevision !== null ? "保存中" : "保存地图"}
            </button>
            <button type="button" className={mapEditMode === "target" ? styles.navigationToolActive : undefined} aria-pressed={mapEditMode === "target"} disabled={navigationBusy || wallDirty || wallBaseRevision < 1 || !calibrationConfirmed} onClick={() => setInteractionMode("target")}>
              <Crosshair size={15} aria-hidden="true" />选择目标
            </button>
            <button type="button" className={mapEditMode === "checkpoint" ? styles.navigationToolActive : undefined} aria-pressed={mapEditMode === "checkpoint"} disabled={navigationRunning} onClick={() => setInteractionMode("checkpoint")}>
              <MapPin size={15} aria-hidden="true" />设置固定检查点
            </button>
          </div>
          <div className={styles.navigationMapMeta}>
            <span>墙线 {wallStrokes.length} 段</span>
            <span>车体边界保护关闭</span>
            <span>安全间隙 0cm</span>
            <span>{wallDirty ? "有未保存修改" : `Jetson 修订 ${wallBaseRevision || "—"}`}</span>
            <button type="button" onClick={synchronizeNavigation} disabled={navigationRunning}>重新同步</button>
          </div>
        </div>
        <div className={`${styles.navigationStatus} ${styles[`navigationState_${navigation?.state ?? "idle"}`]}`} aria-live="polite">
          <div>
            <span className={styles.navigationStatusDot} aria-hidden="true" />
            <p><strong>{navigationStateLabel(navigation?.state)}</strong><small>{navigationDetail}</small></p>
          </div>
          {navigation?.state === "running" && (
            <div className={styles.navigationProgress}>
              <span style={{ width: `${Math.max(0, Math.min(100, navigation.distanceM ? (1 - (navigation.remainingDistanceM ?? navigation.distanceM) / navigation.distanceM) * 100 : 0))}%` }} />
            </div>
          )}
          <div className={styles.navigationActions}>
            <button type="button" className={styles.navigationStartButton} disabled={!canStartNavigation} onClick={beginNavigation}>
              <Play size={15} aria-hidden="true" />开始导航
            </button>
            {navigation?.state === "planned" && <button type="button" onClick={discardNavigation}>取消路线</button>}
            {navigation?.state === "failed" && goalPoint && (
              <button type="button" onClick={() => requestNavigationToPoint(goalPoint, selectedCheckpoint ?? undefined)}>
                重新同步并重试
              </button>
            )}
            {navigationRunning && (
              <button type="button" className={styles.navigationStopButton} onClick={stopNavigation}>
                <Octagon size={16} aria-hidden="true" />紧急停止
              </button>
            )}
          </div>
        </div>
      </section>

      <nav className={styles.layerScroller} aria-label="空间数据图层">
        <div className={styles.layerTabs} role="tablist">
          {LAYERS.map((layer) => {
            const Icon = layer.icon;
            const selected = layer.id === activeLayerId;
            return (
              <button
                key={layer.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`${styles.layerTab}${selected ? ` ${styles.layerTabActive}` : ""}`}
                style={{ "--tab-accent": layer.accent } as CSSProperties}
                onClick={() => setActiveLayerId(layer.id)}
              >
                <Icon size={16} aria-hidden="true" />
                {layer.label}
              </button>
            );
          })}
        </div>
      </nav>

      <div className={styles.mapStage}>
        <div
          ref={mapFrameRef}
          className={`${styles.mapFrame}${calibrationMode ? ` ${styles.mapFrameCalibrating}` : ""}${mapEditMode !== "idle" ? ` ${styles.mapFrameEditing}` : ""}`}
          style={mapStyle}
          aria-busy={layerPending}
          tabIndex={calibrationMode || mapEditMode !== "idle" ? 0 : -1}
          aria-label={calibrationMode
            ? "在房间地图上点击小车位置，并拖动设置车头方向"
            : mapEditMode === "draw" ? "在地图上拖动画出固定墙线"
              : mapEditMode === "erase" ? "点击要擦除的墙线"
                : mapEditMode === "target" ? "点击自动巡航目标点"
                  : mapEditMode === "checkpoint" ? "点击固定检查点的位置"
                  : layerSummary}
          onPointerDown={beginMapInteraction}
          onPointerMove={moveMapInteraction}
          onPointerUp={finishMapInteraction}
          onPointerCancel={() => {
            setCalibrationDraft(null);
            setActiveWallStroke(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            setCalibrationDraft(null);
            setCalibrationMode(false);
            setActiveWallStroke(null);
            setMapEditMode("idle");
          }}
        >
          {/* Navigation uses the registered real-scene photo map; digital twin keeps its original render. */}
          {/* The offline Android build serves the same bundled public asset, so a native img is intentional. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.mapImage} style={imageStyle} src={MAP_IMAGE} alt="房间实景正俯视导航图" draggable={false} />
          <canvas ref={canvasRef} className={styles.heatCanvas} aria-hidden="true" />
          <svg className={styles.overlay} viewBox={`0 0 ${viewWidth} ${viewHeight}`} preserveAspectRatio="none" aria-hidden="true">
            {wallStrokes.map((stroke) => (
              <polyline
                key={stroke.id}
                className={styles.wallLine}
                points={stroke.points.map((point) => `${point.x * viewWidth},${point.y * viewHeight}`).join(" ")}
              />
            ))}
            {activeWallStroke && (
              <polyline
                className={`${styles.wallLine} ${styles.wallLineDraft}`}
                points={activeWallStroke.points.map((point) => `${point.x * viewWidth},${point.y * viewHeight}`).join(" ")}
              />
            )}
            {navigationPath.length > 1 && (
              <polyline
                className={styles.navigationRouteLine}
                points={navigationPath.map((point) => `${point.x * viewWidth},${point.y * viewHeight}`).join(" ")}
              />
            )}
            {validTrack.length > 1 && (
              <polyline
                className={styles.trackLine}
                points={validTrack.map((point) => `${point.x * viewWidth},${point.y * viewHeight}`).join(" ")}
              />
            )}
            {activeLayer.slotId && validSamples.map((sample) => (
              <circle key={sample.id} className={styles.samplePoint} cx={sample.x * viewWidth} cy={sample.y * viewHeight} r="7">
                <title>{`${activeLayer.label}实测：${formatValue(sample.value, activeUnit)} · ${formatObservedAt(sample.observedAt)}`}</title>
              </circle>
            ))}
            {displayedGoal && (
              <g className={styles.navigationGoal} transform={`translate(${displayedGoal.x * viewWidth} ${displayedGoal.y * viewHeight})`}>
                <circle r="17" />
                <circle r="5" />
              </g>
            )}
            {calibrationPoint && (
              <g className={styles.calibrationMarker} transform={`translate(${calibrationPoint.x * viewWidth} ${calibrationPoint.y * viewHeight}) rotate(${calibrationPoint.headingDeg})`}>
                <circle r="13" />
                <path d="M 0 -31 L 8 -15 L 0 -19 L -8 -15 Z" />
              </g>
            )}
            {displayPose && (
              <g className={`${styles.vehicleMarker}${poseOutside ? ` ${styles.vehicleMarkerOutside}` : ""}`} transform={`translate(${displayPose.x * viewWidth} ${displayPose.y * viewHeight}) rotate(${displayPose.headingDeg})`}>
                <circle r="24" />
                <path d="M 0 -20 L 14 15 L 0 9 L -14 15 Z" />
              </g>
            )}
          </svg>

          {layerPending && (
            <div className={styles.layerSwitchStatus} role="status">
              正在切换到{requestedLayer.label}图层
            </div>
          )}

          <div className={styles.checkpointLayer} aria-label="固定检查点">
            {checkpoints.map((checkpoint) => (
              <button
                key={checkpoint.id}
                type="button"
                className={`${styles.checkpointMarker}${selectedCheckpointId === checkpoint.id ? ` ${styles.checkpointMarkerSelected}` : ""}`}
                style={{ left: `${checkpoint.x * 100}%`, top: `${checkpoint.y * 100}%` }}
                aria-label={`固定检查点 ${checkpoint.name}`}
                aria-pressed={selectedCheckpointId === checkpoint.id}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  setSelectedCheckpointId((current) => current === checkpoint.id ? null : checkpoint.id);
                  setCheckpointDeleteArmed(false);
                }}
              >
                <span><MapPin size={16} aria-hidden="true" /></span>
                <strong>{checkpoint.name}</strong>
              </button>
            ))}
          </div>

          {calibrationMode && (
            <div className={styles.calibrationHint} role="status">
              <Crosshair size={17} aria-hidden="true" />
              点击起点，拖动设置车头方向
            </div>
          )}
          {!calibrationMode && mapEditMode !== "idle" && (
            <div className={styles.calibrationHint} role="status">
              {mapEditMode === "draw" ? <Pencil size={17} aria-hidden="true" /> : mapEditMode === "erase" ? <Eraser size={17} aria-hidden="true" /> : mapEditMode === "checkpoint" ? <MapPin size={17} aria-hidden="true" /> : <Crosshair size={17} aria-hidden="true" />}
              {mapEditMode === "draw" ? "拖动画出墙线或固定障碍边界" : mapEditMode === "erase" ? "点击墙线即可擦除整段" : mapEditMode === "checkpoint" ? "点击地图位置并为固定检查点命名" : "点击小车要到达的目标点"}
            </div>
          )}
          {selectedCheckpoint && !checkpointEditor && (
            <aside className={styles.checkpointCard} aria-label={`检查点 ${selectedCheckpoint.name}`}>
              <div>
                <span><MapPin size={16} aria-hidden="true" /></span>
                <p><strong>{selectedCheckpoint.name}</strong><small>{(selectedCheckpoint.x * mapDimensions.widthM).toFixed(2)}m · {(selectedCheckpoint.y * mapDimensions.heightM).toFixed(2)}m</small></p>
              </div>
              <div>
                <button type="button" disabled={navigationBusy} onClick={() => requestNavigationToPoint(selectedCheckpoint, selectedCheckpoint)}>
                  <Route size={15} aria-hidden="true" />规划路线
                </button>
                <button type="button" onClick={() => beginRenameCheckpoint(selectedCheckpoint)}>
                  <PencilLine size={15} aria-hidden="true" />重命名
                </button>
                <button type="button" className={checkpointDeleteArmed ? styles.checkpointDeleteArmed : undefined} onClick={removeSelectedCheckpoint}>
                  <Trash2 size={15} aria-hidden="true" />{checkpointDeleteArmed ? "确认删除" : "删除"}
                </button>
              </div>
            </aside>
          )}
          {!calibrationConfirmed && !calibrationMode && (
            <button type="button" className={styles.mapPrompt} onClick={() => setCalibrationMode(true)}>
              <LocateFixed size={18} aria-hidden="true" />
              在地图上标记小车起点
            </button>
          )}
        </div>
      </div>

      <footer className={styles.footer}>
        <div className={styles.layerStatus}>
          <span className={styles.statusDot} aria-hidden="true" />
          <strong>{activeLayer.label}</strong>
          <span>{layerSummary}</span>
        </div>
        {activeLayer.slotId && heatGrid.min !== null && heatGrid.max !== null ? (
          <div className={styles.legend} aria-label={`${activeLayer.label}图层范围 ${heatGrid.min} 至 ${heatGrid.max}`}>
            <span>{formatValue(heatGrid.min, activeUnit)}</span>
            <i style={{ background: `linear-gradient(90deg, ${activeLayer.palette.join(", ")})` }} aria-hidden="true" />
            <span>{formatValue(heatGrid.max, activeUnit)}</span>
          </div>
        ) : (
          <div className={styles.poseMeta}>
            <span>{pose ? `里程 ${pose.distanceM.toFixed(2)}m` : "里程暂无定位回传"}</span>
            <span>更新 {formatObservedAt(pose?.observedAt)}</span>
          </div>
        )}
      </footer>

      {checkpointEditor && (
        <div
          className={styles.checkpointDialogBackdrop}
          role="presentation"
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget) return;
            setCheckpointEditor(null);
            setCheckpointError(null);
          }}
        >
          <form
            className={styles.checkpointDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="checkpoint-dialog-title"
            onSubmit={submitCheckpoint}
          >
            <span className={styles.checkpointDialogIcon}><MapPin size={21} aria-hidden="true" /></span>
            <div>
              <h4 id="checkpoint-dialog-title">{checkpointEditor.mode === "create" ? "命名固定检查点" : "重命名固定检查点"}</h4>
              <p>支持中文名称，Agent 可以按名称前往并执行检测。</p>
            </div>
            <label>
              <span>检查点名称</span>
              <input
                ref={checkpointInputRef}
                value={checkpointName}
                maxLength={20}
                autoComplete="off"
                placeholder="例如：油桶"
                onChange={(event) => {
                  setCheckpointName(event.target.value);
                  setCheckpointError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  setCheckpointEditor(null);
                  setCheckpointError(null);
                }}
              />
            </label>
            {checkpointError && <p className={styles.checkpointDialogError} role="alert">{checkpointError}</p>}
            <div className={styles.checkpointDialogActions}>
              <button type="button" onClick={() => {
                setCheckpointEditor(null);
                setCheckpointError(null);
              }}>取消</button>
              <button type="submit">保存检查点</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
