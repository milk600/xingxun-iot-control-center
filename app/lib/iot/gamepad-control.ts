import type { VehicleMotion } from "./contracts";

export const GAMEPAD_STICK_DEADZONE = 0.12;

export interface GamepadControlSample {
  x: number;
  y: number;
  dpadX?: number;
  dpadY?: number;
}

export interface GamepadControlIntent {
  motion: Exclude<VehicleMotion, "stop">;
  speedPercent: number;
  source: "stick" | "dpad";
}

export function gamepadControlIntent(
  sample: GamepadControlSample,
  dpadSpeedPercent: number,
  previousMotion: VehicleMotion = "stop",
): GamepadControlIntent | null {
  const dpadX = clampedAxis(sample.dpadX ?? 0);
  const dpadY = clampedAxis(sample.dpadY ?? 0);
  if (Math.abs(dpadX) >= 0.5 || Math.abs(dpadY) >= 0.5) {
    return {
      motion: directionalMotion(dpadX, dpadY, previousMotion),
      speedPercent: clampedPercent(dpadSpeedPercent),
      source: "dpad",
    };
  }

  const x = clampedAxis(sample.x);
  const y = clampedAxis(sample.y);
  const travel = Math.min(1, Math.hypot(x, y));
  if (travel <= GAMEPAD_STICK_DEADZONE) return null;
  const normalizedTravel = (travel - GAMEPAD_STICK_DEADZONE) / (1 - GAMEPAD_STICK_DEADZONE);
  return {
    motion: directionalMotion(x, y, previousMotion),
    speedPercent: Math.max(1, Math.min(100, Math.round(normalizedTravel * 100))),
    source: "stick",
  };
}

function directionalMotion(
  x: number,
  y: number,
  previousMotion: VehicleMotion,
): Exclude<VehicleMotion, "stop"> {
  const horizontal = Math.abs(x);
  const vertical = Math.abs(y);
  if (Math.abs(horizontal - vertical) < 0.08) {
    if ((previousMotion === "left" && x < 0) || (previousMotion === "right" && x > 0)) {
      return previousMotion;
    }
    if ((previousMotion === "forward" && y < 0) || (previousMotion === "backward" && y > 0)) {
      return previousMotion;
    }
  }
  if (horizontal > vertical) return x < 0 ? "left" : "right";
  return y < 0 ? "forward" : "backward";
}

function clampedAxis(value: number) {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

function clampedPercent(value: number) {
  return Number.isFinite(value) ? Math.max(1, Math.min(100, Math.round(value))) : 1;
}
