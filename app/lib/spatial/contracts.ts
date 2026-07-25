import type { TelemetrySlotId } from "@/app/lib/iot/contracts";

export type SpatialLayerId = "position" | TelemetrySlotId;
export type SpatialTrackingQuality = "unavailable" | "fused" | "reported";

export interface RoomMapManifest {
  version: 1;
  sceneId: "room-01";
  sceneRevision: number;
  width: number;
  height: number;
  contentBounds: { left: number; top: number; width: number; height: number };
  suggestedRoom: { widthM: number; heightM: number };
  generatedFrom: string;
  vertexCount: number;
}

export interface RoomMapDimensions {
  widthM: number;
  heightM: number;
  source: "estimated" | "manual";
}

export interface SpatialCalibration {
  id: string;
  originX: number;
  originY: number;
  headingDeg: number;
  createdAt: string;
}

export interface VehicleMapPose {
  x: number;
  y: number;
  headingDeg: number;
  distanceM: number;
  observedAt: string | null;
  quality: SpatialTrackingQuality;
}

export interface VehicleTrackPoint extends VehicleMapPose {
  id: string;
}

export interface NavigationCheckpoint {
  id: string;
  name: string;
  x: number;
  y: number;
  createdAt: string;
  updatedAt: string;
}

export interface SpatialObservationValue {
  value: number;
  unit: string;
}

export interface SpatialObservation {
  id: string;
  observedAt: string;
  receivedAt: string;
  x: number;
  y: number;
  headingDeg: number;
  alignment: "device-time" | "arrival-time";
  alignmentOffsetMs: number | null;
  quality: SpatialTrackingQuality;
  values: Partial<Record<TelemetrySlotId, SpatialObservationValue>>;
}

export const DEFAULT_ROOM_MAP_MANIFEST: RoomMapManifest = {
  version: 1,
  sceneId: "room-01",
  sceneRevision: 1,
  width: 1600,
  height: 1000,
  contentBounds: {
    left: 0.08,
    top: 0.08,
    width: 0.84,
    height: 0.84,
  },
  suggestedRoom: { widthM: 8, heightM: 5 },
  generatedFrom: "demo-room.ply",
  vertexCount: 2_920,
};

export const DEFAULT_ROOM_MAP_DIMENSIONS: RoomMapDimensions = {
  ...DEFAULT_ROOM_MAP_MANIFEST.suggestedRoom,
  source: "estimated",
};

export const SPATIAL_MAP_STORAGE_KEY = "xingxun:room-one-spatial-map:v2";
export const NAVIGATION_CHECKPOINT_STORAGE_KEY = "xingxun:navigation-checkpoints:v1";
export const MAX_NAVIGATION_CHECKPOINTS = 64;
export const MAX_SPATIAL_OBSERVATIONS = 2_000;
export const MAX_TRACK_POINTS = 1_500;
