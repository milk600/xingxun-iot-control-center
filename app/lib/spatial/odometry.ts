import type { VehicleMapPose } from "./contracts";

export interface WheelSpeedsMmps {
  m1: number;
  m2: number;
  m3: number;
  m4: number;
}

export interface CarBodyVelocity {
  forwardMmps: number;
  steeringMmps: number;
  driveMmps: number;
  speedMmps: number;
}

export interface MetricMapPose {
  rightM: number;
  downM: number;
  headingDeg: number;
  distanceM: number;
}

export function normalizeHeadingDeg(value: number) {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

/**
 * Decode the four tested motor patterns used by ws_server.py.
 *
 * Forward/backward are projected onto [+,-,+,-]. The orthogonal
 * [-,-,+,+] component is the tested left/right steering command; it is not
 * lateral translation. A pure steering command still drives the vehicle, so
 * its magnitude is used as the arc speed when no forward component exists.
 */
export function carBodyVelocity(wheels: WheelSpeedsMmps): CarBodyVelocity | null {
  const values = [wheels.m1, wheels.m2, wheels.m3, wheels.m4];
  if (values.some((value) => !Number.isFinite(value) || Math.abs(value) > 2_000)) return null;

  const forwardMmps = (wheels.m1 - wheels.m2 + wheels.m3 - wheels.m4) / 4;
  const steeringMmps = (-wheels.m1 - wheels.m2 + wheels.m3 + wheels.m4) / 4;
  const driveMmps = Math.abs(forwardMmps) > 0.5
    ? forwardMmps
    : Math.abs(steeringMmps) > 0.5 ? Math.abs(steeringMmps) : 0;
  return {
    forwardMmps,
    steeringMmps,
    driveMmps,
    speedMmps: Math.abs(driveMmps),
  };
}

export function shortestHeadingDeltaDeg(fromDeg: number, toDeg: number) {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

export function integrateWheelPoseWithJetsonHeading(
  pose: MetricMapPose,
  wheels: WheelSpeedsMmps,
  dtSeconds: number,
  headingDeltaDeg: number,
): MetricMapPose | null {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0 || dtSeconds > 0.25) return null;
  if (!Number.isFinite(headingDeltaDeg) || Math.abs(headingDeltaDeg) > 90) return null;
  const velocity = carBodyVelocity(wheels);
  if (!velocity) return null;
  const headingMidRad = (pose.headingDeg + headingDeltaDeg / 2) * Math.PI / 180;
  const deltaRightM = velocity.driveMmps * Math.sin(headingMidRad) * dtSeconds / 1_000;
  const deltaDownM = -velocity.driveMmps * Math.cos(headingMidRad) * dtSeconds / 1_000;
  return {
    rightM: pose.rightM + deltaRightM,
    downM: pose.downM + deltaDownM,
    headingDeg: normalizeHeadingDeg(pose.headingDeg + headingDeltaDeg),
    distanceM: pose.distanceM + velocity.speedMmps * dtSeconds / 1_000,
  };
}

export function poseFromDeviceOdometry(
  calibration: { headingDeg: number },
  origin: { xMm: number; yMm: number; headingDeg: number },
  current: { xMm: number; yMm: number; headingDeg: number },
): MetricMapPose {
  const mapRotation = (calibration.headingDeg - origin.headingDeg) * Math.PI / 180;
  const forwardMm = current.xMm - origin.xMm;
  const leftMm = current.yMm - origin.yMm;
  return {
    rightM: (forwardMm * Math.sin(mapRotation) - leftMm * Math.cos(mapRotation)) / 1_000,
    downM: (-forwardMm * Math.cos(mapRotation) - leftMm * Math.sin(mapRotation)) / 1_000,
    headingDeg: normalizeHeadingDeg(calibration.headingDeg + current.headingDeg - origin.headingDeg),
    distanceM: Math.hypot(forwardMm, leftMm) / 1_000,
  };
}

export function metricPoseToMapPose(
  metric: MetricMapPose,
  origin: { x: number; y: number },
  dimensions: { widthM: number; heightM: number },
  observedAt: string | null,
  quality: VehicleMapPose["quality"],
): VehicleMapPose {
  return {
    x: origin.x + metric.rightM / dimensions.widthM,
    y: origin.y + metric.downM / dimensions.heightM,
    headingDeg: metric.headingDeg,
    distanceM: metric.distanceM,
    observedAt,
    quality,
  };
}
