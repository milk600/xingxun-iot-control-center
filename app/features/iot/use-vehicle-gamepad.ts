"use client";

import { useEffect, useRef, useState } from "react";
import type { VehicleMotion } from "@/app/lib/iot/contracts";
import {
  gamepadControlIntent,
  type GamepadControlIntent,
  type GamepadControlSample,
} from "@/app/lib/iot/gamepad-control";

interface UseVehicleGamepadOptions {
  enabled: boolean;
  dpadSpeedPercent: number;
  onMove: (motion: Exclude<VehicleMotion, "stop">, speedPercent: number) => void;
  onStop: () => void;
}

export interface VehicleGamepadState {
  connected: boolean;
  name: string | null;
  motion: VehicleMotion;
  throttlePercent: number;
  inputSource: "stick" | "dpad" | null;
}

interface NativeGamepadConnection {
  connected?: unknown;
  deviceId?: unknown;
  name?: unknown;
}

interface NativeGamepadInput {
  deviceId?: unknown;
  name?: unknown;
  x?: unknown;
  y?: unknown;
  dpadX?: unknown;
  dpadY?: unknown;
}

const INITIAL_STATE: VehicleGamepadState = {
  connected: false,
  name: null,
  motion: "stop",
  throttlePercent: 0,
  inputSource: null,
};

export function useVehicleGamepad({
  enabled,
  dpadSpeedPercent,
  onMove,
  onStop,
}: UseVehicleGamepadOptions) {
  const [state, setState] = useState<VehicleGamepadState>(INITIAL_STATE);
  const enabledRef = useRef(enabled);
  const dpadSpeedRef = useRef(dpadSpeedPercent);
  const onMoveRef = useRef(onMove);
  const onStopRef = useRef(onStop);
  const nativeConnectedRef = useRef(false);
  const browserConnectedRef = useRef(false);
  const previousMotionRef = useRef<VehicleMotion>("stop");
  const lastSentRef = useRef<{
    motion: Exclude<VehicleMotion, "stop">;
    speedPercent: number;
    sentAt: number;
  } | null>(null);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { dpadSpeedRef.current = dpadSpeedPercent; }, [dpadSpeedPercent]);
  useEffect(() => { onMoveRef.current = onMove; }, [onMove]);
  useEffect(() => { onStopRef.current = onStop; }, [onStop]);

  useEffect(() => {
    let frame = 0;
    let disposed = false;

    const updateState = (next: VehicleGamepadState) => {
      setState((current) => (
        current.connected === next.connected
        && current.name === next.name
        && current.motion === next.motion
        && current.throttlePercent === next.throttlePercent
        && current.inputSource === next.inputSource
          ? current
          : next
      ));
    };

    const stopActiveControl = (connected: boolean, name: string | null) => {
      if (lastSentRef.current) onStopRef.current();
      lastSentRef.current = null;
      previousMotionRef.current = "stop";
      updateState({
        connected,
        name,
        motion: "stop",
        throttlePercent: 0,
        inputSource: null,
      });
    };

    const applySample = (
      sample: GamepadControlSample,
      name: string,
    ) => {
      const intent = gamepadControlIntent(
        sample,
        dpadSpeedRef.current,
        previousMotionRef.current,
      );
      if (!enabledRef.current) {
        stopActiveControl(true, name);
        return;
      }
      if (!intent) {
        stopActiveControl(true, name);
        return;
      }
      previousMotionRef.current = intent.motion;
      updateState({
        connected: true,
        name,
        motion: intent.motion,
        throttlePercent: intent.speedPercent,
        inputSource: intent.source,
      });
      sendIntentWhenChanged(intent);
    };

    const sendIntentWhenChanged = (intent: GamepadControlIntent) => {
      const now = performance.now();
      const previous = lastSentRef.current;
      const speedChanged = !previous || Math.abs(previous.speedPercent - intent.speedPercent) >= 2;
      const directionChanged = !previous || previous.motion !== intent.motion;
      const periodicFineUpdate = Boolean(
        previous
        && previous.speedPercent !== intent.speedPercent
        && now - previous.sentAt >= 250,
      );
      if (!directionChanged && !(speedChanged && (!previous || now - previous.sentAt >= 80)) && !periodicFineUpdate) {
        return;
      }
      onMoveRef.current(intent.motion, intent.speedPercent);
      lastSentRef.current = {
        motion: intent.motion,
        speedPercent: intent.speedPercent,
        sentAt: now,
      };
    };

    const onNativeConnection = (event: Event) => {
      const detail = (event as CustomEvent<NativeGamepadConnection>).detail ?? {};
      const connected = detail.connected === true;
      nativeConnectedRef.current = connected;
      const name = typeof detail.name === "string" && detail.name.trim()
        ? detail.name.trim().slice(0, 80)
        : "Android 手柄";
      if (connected) updateState({ ...INITIAL_STATE, connected: true, name });
      else stopActiveControl(false, null);
    };

    const onNativeInput = (event: Event) => {
      const detail = (event as CustomEvent<NativeGamepadInput>).detail ?? {};
      nativeConnectedRef.current = true;
      applySample({
        x: finiteAxis(detail.x),
        y: finiteAxis(detail.y),
        dpadX: finiteAxis(detail.dpadX),
        dpadY: finiteAxis(detail.dpadY),
      }, typeof detail.name === "string" && detail.name.trim()
        ? detail.name.trim().slice(0, 80)
        : "Android 手柄");
    };

    const poll = () => {
      if (disposed) return;
      if (!nativeConnectedRef.current && typeof navigator.getGamepads === "function") {
        const gamepad = Array.from(navigator.getGamepads()).find(
          (candidate): candidate is Gamepad => Boolean(candidate?.connected),
        );
        if (gamepad) {
          browserConnectedRef.current = true;
          applySample({
            x: gamepad.axes[0] ?? 0,
            y: gamepad.axes[1] ?? 0,
            dpadX: buttonValue(gamepad.buttons[15]) - buttonValue(gamepad.buttons[14]),
            dpadY: buttonValue(gamepad.buttons[13]) - buttonValue(gamepad.buttons[12]),
          }, gamepad.id || "USB / 蓝牙手柄");
        } else if (browserConnectedRef.current) {
          browserConnectedRef.current = false;
          stopActiveControl(false, null);
        }
      }
      frame = window.requestAnimationFrame(poll);
    };

    window.addEventListener("xingxun:native-gamepad-connection", onNativeConnection);
    window.addEventListener("xingxun:native-gamepad-input", onNativeInput);
    frame = window.requestAnimationFrame(poll);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("xingxun:native-gamepad-connection", onNativeConnection);
      window.removeEventListener("xingxun:native-gamepad-input", onNativeInput);
      if (lastSentRef.current) onStopRef.current();
      lastSentRef.current = null;
      previousMotionRef.current = "stop";
    };
  }, []);

  return state;
}

function buttonValue(button: GamepadButton | undefined) {
  return button?.pressed ? Math.max(1, button.value) : 0;
}

function finiteAxis(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
