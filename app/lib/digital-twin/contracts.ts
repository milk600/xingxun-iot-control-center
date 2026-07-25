import type { TelemetrySlotId } from "@/app/lib/iot/contracts";

export const TWIN_MODEL_EXTENSIONS = [
  ".ply",
  ".glb",
  ".spz",
  ".splat",
  ".ksplat",
  ".sog",
  ".zip",
  ".rad",
] as const;

export type TwinModelExtension = (typeof TWIN_MODEL_EXTENSIONS)[number];

export type TwinDisplayMode = "color" | "enhanced" | "geometry";

export type TwinStandardView =
  | "perspective"
  | "top"
  | "front"
  | "left"
  | "right";

export type TwinLayerId = "primary" | "gap" | "framework";

export interface TwinLayerState {
  id: TwinLayerId;
  label: string;
  description: string;
  visible: boolean;
  opacity: number;
  fileName: string | null;
}

export interface TwinViewportAppearance {
  displayMode: TwinDisplayMode;
  pointSize: number;
  diagnosticActive: boolean;
}

/**
 * These files are generated together and therefore share one reconstruction
 * coordinate system. The browser still needs a user-selected File (or a
 * future served URL); a Windows filesystem path cannot be opened silently.
 */
export const ROOM_ONE_RECOMMENDED_MODELS = {
  primary: "demo-room.ply",
  gap: "demo-room-gap.ply",
  framework: "demo-room-framework.ply",
} as const;

export const ROOM_ONE_DEFAULT_ASSETS = {
  primary: `/models/room-01/${ROOM_ONE_RECOMMENDED_MODELS.primary}`,
  gap: `/models/room-01/${ROOM_ONE_RECOMMENDED_MODELS.gap}`,
  framework: `/models/room-01/${ROOM_ONE_RECOMMENDED_MODELS.framework}`,
} as const;

export interface TwinDeviceAnchor {
  anchorId: string;
  slotId: TelemetrySlotId;
  label: string;
  position: [number, number, number] | null;
  state: "unmapped" | "mapped";
}

export interface TwinSceneManifest {
  sceneId: string;
  name: string;
  revision: number;
  asset: {
    url: string;
    format: TwinModelExtension;
    bytes?: number;
    etag?: string;
  } | null;
  splatToWorld: number[];
  anchors: TwinDeviceAnchor[];
}

export const ROOM_ONE_ANCHORS: TwinDeviceAnchor[] = [
  { anchorId: "anchor-temperature", slotId: "slot-1", label: "温度传感器", position: null, state: "unmapped" },
  { anchorId: "anchor-humidity", slotId: "slot-2", label: "湿度传感器", position: null, state: "unmapped" },
  { anchorId: "anchor-co2", slotId: "slot-3", label: "CO₂ 传感器", position: null, state: "unmapped" },
  { anchorId: "anchor-tvoc", slotId: "slot-4", label: "TVOC 传感器", position: null, state: "unmapped" },
  { anchorId: "anchor-ch2o", slotId: "slot-5", label: "甲醛传感器", position: null, state: "unmapped" },
  { anchorId: "anchor-light", slotId: "slot-6", label: "环境光照", position: null, state: "unmapped" },
];

export function getTwinModelExtension(fileName: string): TwinModelExtension | null {
  const normalized = fileName.toLowerCase();
  return TWIN_MODEL_EXTENSIONS.find((extension) => normalized.endsWith(extension)) ?? null;
}
