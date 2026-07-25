export const VEHICLE_FIRE_REPORT_TYPE = "vehicle.fire.report";
export const VEHICLE_FIRE_SOURCE = "jetson-yolo";

export interface VehicleFireReport {
  detected: boolean;
  observedAt: string;
  source: typeof VEHICLE_FIRE_SOURCE;
}

export function parseVehicleFireReport(value: unknown): VehicleFireReport {
  if (!value || typeof value !== "object") {
    throw new Error("火焰检测上报格式无效");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.detected !== "boolean") {
    throw new Error("火焰检测状态必须是布尔值");
  }
  if (input.source !== VEHICLE_FIRE_SOURCE) {
    throw new Error("火焰检测来源无效");
  }
  if (typeof input.observedAt !== "string" || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error("火焰检测时间无效");
  }
  return {
    detected: input.detected,
    observedAt: new Date(input.observedAt).toISOString(),
    source: VEHICLE_FIRE_SOURCE,
  };
}
