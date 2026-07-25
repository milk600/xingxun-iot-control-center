"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createUnavailableVehicle,
  type VehicleCommandRequest,
  type VehicleMotion,
  type VehicleTelemetry,
} from "@/app/lib/iot/contracts";
import {
  buildJetsonCommand,
  createJetsonCommandAck,
  JETSON_SETTINGS_EVENT,
  jetsonPowerWebSocketUrl,
  mergeJetsonNavigationState,
  navigationMapToWire,
  parseJetsonInboundMessage,
  parseJetsonPowerMessage,
  readJetsonSettings,
  type JetsonConnectionSettings,
  type JetsonNavigationMessage,
  type JetsonVideoFrameListener,
  type NavigationMapDefinition,
  type NavigationPoint,
} from "@/app/lib/iot/jetson-websocket";
import { normalizeHeadingDeg, type WheelSpeedsMmps } from "@/app/lib/spatial/odometry";

const IMU_FRESHNESS_MS = 500;
const IMU_CALIBRATION_MIN_SAMPLES = 24;
const POWER_TELEMETRY_FRESHNESS_MS = 5_000;

interface DeviceHeadingState {
  bootId: string;
  deviceZeroRevision: number;
  mapZeroRevision: number;
  calibrated: boolean;
  stationary: boolean;
  yawRateDps: number;
  receivedAtMs: number;
  sequence: number | null;
}

export function useJetsonVehicle() {
  const [settings, setSettings] = useState<JetsonConnectionSettings>(() => readJetsonSettings());
  const [telemetry, setTelemetry] = useState<VehicleTelemetry>(() => createUnavailableVehicle());
  const [navigation, setNavigation] = useState<JetsonNavigationMessage | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const powerSocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const powerReconnectTimerRef = useRef<number | null>(null);
  const telemetryStaleTimerRef = useRef<number | null>(null);
  const powerStaleTimerRef = useRef<number | null>(null);
  const imuStaleTimerRef = useRef<number | null>(null);
  const deviceHeadingRef = useRef<DeviceHeadingState | null>(null);
  const latestImuReceivedAtMsRef = useRef<number | null>(null);
  const latestWheelsRef = useRef<{ speeds: WheelSpeedsMmps; receivedAtMs: number } | null>(null);
  const videoListenersRef = useRef(new Set<JetsonVideoFrameListener>());
  const navigationRef = useRef<JetsonNavigationMessage | null>(null);

  const subscribeVideoFrames = useCallback((listener: JetsonVideoFrameListener) => {
    videoListenersRef.current.add(listener);
    return () => {
      videoListenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    const reload = () => setSettings(readJetsonSettings());
    const timer = window.setTimeout(reload, 0);
    window.addEventListener(JETSON_SETTINGS_EVENT, reload);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(JETSON_SETTINGS_EVENT, reload);
    };
  }, []);

  useEffect(() => {
    if (!settings.enabled) {
      socketRef.current?.close();
      socketRef.current = null;
      powerSocketRef.current?.close();
      powerSocketRef.current = null;
      if (telemetryStaleTimerRef.current !== null) {
        window.clearTimeout(telemetryStaleTimerRef.current);
        telemetryStaleTimerRef.current = null;
      }
      if (imuStaleTimerRef.current !== null) {
        window.clearTimeout(imuStaleTimerRef.current);
        imuStaleTimerRef.current = null;
      }
      if (powerStaleTimerRef.current !== null) {
        window.clearTimeout(powerStaleTimerRef.current);
        powerStaleTimerRef.current = null;
      }
      deviceHeadingRef.current = null;
      latestImuReceivedAtMsRef.current = null;
      latestWheelsRef.current = null;
      navigationRef.current = null;
      const disabledStateTimer = window.setTimeout(() => setTelemetry(createUnavailableVehicle()), 0);
      const disabledNavigationTimer = window.setTimeout(() => setNavigation(null), 0);
      return () => {
        window.clearTimeout(disabledStateTimer);
        window.clearTimeout(disabledNavigationTimer);
      };
    }

    let disposed = false;
    const connectingStateTimer = window.setTimeout(() => {
      setTelemetry((current) => ({
        ...current,
        controlLink: "connecting",
        connection: current.lastSeenAt ? "stale" : "offline",
      }));
    }, 0);
    const connect = () => {
      if (disposed) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(settings.wsUrl);
      } catch {
        setTelemetry((current) => ({
          ...current,
          controlLink: "disconnected",
          connection: current.lastSeenAt ? "stale" : "offline",
        }));
        return;
      }
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        if (disposed) return;
        setTelemetry((current) => ({ ...current, controlLink: "connected" }));
        socket.send(JSON.stringify({ cmd: "navigation_status", request_id: requestId("navigation-status") }));
        socket.send(JSON.stringify({ cmd: "navigation_map_get", request_id: requestId("navigation-map") }));
      });
      socket.addEventListener("message", (event) => {
        const message = parseJetsonInboundMessage(event.data);
        if (!message) return;
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        if (message.type === "navigation") {
          setNavigation((current) => {
            const next = mergeJetsonNavigationState(current, message, now);
            navigationRef.current = next;
            return next;
          });
          return;
        }
        if (message.type === "video") {
          const frame = { ...message, receivedAt: now };
          for (const listener of videoListenersRef.current) listener(frame);
          return;
        }
        if (message.type === "imu") {
          const previousDeviceHeading = deviceHeadingRef.current;
          if (previousDeviceHeading?.bootId === message.bootId
            && message.seq !== undefined
            && previousDeviceHeading.sequence !== null
            && message.seq <= previousDeviceHeading.sequence) return;
          const deviceReferenceChanged = previousDeviceHeading === null
            || previousDeviceHeading.bootId !== message.bootId
            || previousDeviceHeading.deviceZeroRevision !== message.data.zeroRevision;
          const mapZeroRevision = deviceReferenceChanged
            ? (previousDeviceHeading?.mapZeroRevision ?? 0) + 1
            : previousDeviceHeading.mapZeroRevision;
          deviceHeadingRef.current = {
            bootId: message.bootId,
            deviceZeroRevision: message.data.zeroRevision,
            mapZeroRevision,
            calibrated: message.data.calibrated,
            stationary: message.data.stationary,
            yawRateDps: message.data.yawRateDps,
            receivedAtMs: nowMs,
            sequence: message.seq ?? null,
          };
          latestImuReceivedAtMsRef.current = nowMs;
          if (imuStaleTimerRef.current !== null) window.clearTimeout(imuStaleTimerRef.current);
          imuStaleTimerRef.current = window.setTimeout(() => {
            setTelemetry((current) => current.imu?.receivedAt === now
              ? { ...current, imu: { ...current.imu, state: "stale" } }
              : current);
          }, IMU_FRESHNESS_MS);
          setTelemetry((current) => ({
            ...current,
            imu: {
              acceleration: { x: message.data.ax, y: message.data.ay, z: message.data.az, unit: "g" },
              angularVelocity: { x: message.data.gx, y: message.data.gy, z: message.data.gz, unit: "deg/s" },
              temperatureC: message.data.temp,
              accelerationMagnitudeG: Math.hypot(message.data.ax, message.data.ay, message.data.az),
              correctedYawRateDegps: message.data.yawRateDps,
              relativeHeadingDeg: normalizeHeadingDeg(message.data.yawTotalDeg),
              gyroBiasZDps: message.data.gyroBiasZDps,
              stationary: message.data.stationary,
              canZeroHeading: message.data.calibrated
                && message.data.stationary
                && message.data.yawRateDps === 0,
              calibrationSamples: Math.min(message.data.calibrationSamples, IMU_CALIBRATION_MIN_SAMPLES),
              calibrationRequiredSamples: IMU_CALIBRATION_MIN_SAMPLES,
              zeroRevision: mapZeroRevision,
              zeroedAt: deviceReferenceChanged ? now : current.imu?.zeroedAt ?? null,
              networkRttMs: message.data.networkRttMs ?? null,
              networkOneWayMs: message.data.networkOneWayMs ?? null,
              state: message.data.calibrated ? "live" : "calibrating",
              sequence: message.seq ?? null,
              observedAt: message.observedAt ?? now,
              receivedAt: now,
            },
          }));
          return;
        }
        if (telemetryStaleTimerRef.current !== null) {
          window.clearTimeout(telemetryStaleTimerRef.current);
        }
        telemetryStaleTimerRef.current = window.setTimeout(() => {
          setTelemetry((current) => current.lastSeenAt === now
            ? {
                ...current,
                connection: "stale",
                motion: "stop",
                speedPercent: 0,
                fireDetection: {
                  ...current.fireDetection,
                  state: current.fireDetection.receivedAt ? "stale" : "offline",
                },
              }
            : current);
        }, 5_000);
        const reportedPose = message.version === 2
          && typeof message.data.xMm === "number"
          && typeof message.data.yMm === "number"
          && typeof message.data.headingDeg === "number"
          ? {
              xMm: message.data.xMm,
              yMm: message.data.yMm,
              headingDeg: message.data.headingDeg,
            }
          : null;
        const wheelSpeeds: WheelSpeedsMmps = {
          m1: message.data.M1,
          m2: message.data.M2,
          m3: message.data.M3,
          m4: message.data.M4,
        };
        latestWheelsRef.current = { speeds: wheelSpeeds, receivedAtMs: nowMs };
        const imuFresh = latestImuReceivedAtMsRef.current !== null
          && nowMs - latestImuReceivedAtMsRef.current <= IMU_FRESHNESS_MS;
        const imuReady = imuFresh && deviceHeadingRef.current?.calibrated === true;
        setTelemetry((current) => ({
          ...current,
          controlLink: "connected",
          connection: "online",
          motion: inferReportedMotion(message.data),
          speedPercent: reportedSpeedPercent(message.data, settings.maxWheelSpeed),
          observedAt: now,
          lastSeenAt: now,
          headingDeg: reportedPose?.headingDeg ?? null,
          fireDetection: typeof message.data.fireDetected === "boolean"
            ? {
                state: "live",
                detected: message.data.fireDetected,
                observedAt: message.observedAt ?? now,
                receivedAt: now,
              }
            : current.fireDetection,
          wheelSpeeds: {
            ...wheelSpeeds,
            unit: "mm/s",
          },
          odometry: {
            source: reportedPose
              ? "device-pose-v2"
              : imuReady ? "wheel-jetson-heading-v2" : "heading-unavailable",
            sequence: message.seq ?? null,
            observedAt: message.observedAt ?? now,
            receivedAt: now,
            pose: reportedPose,
            quality: reportedPose ? "reported" : imuReady ? "fused" : "unavailable",
          },
        }));
      });
      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        if (imuStaleTimerRef.current !== null) window.clearTimeout(imuStaleTimerRef.current);
        latestImuReceivedAtMsRef.current = null;
        latestWheelsRef.current = null;
        setTelemetry((current) => ({
          ...current,
          controlLink: "disconnected",
          connection: current.lastSeenAt ? "stale" : "offline",
          motion: "stop",
          speedPercent: 0,
          imu: current.imu ? { ...current.imu, state: "stale" } : null,
          fireDetection: {
            ...current.fireDetection,
            state: current.fireDetection.receivedAt ? "stale" : "offline",
          },
        }));
        reconnectTimerRef.current = window.setTimeout(connect, 2_000);
      });
      socket.addEventListener("error", () => socket.close());
    };
    const connectPower = () => {
      if (disposed) return;
      const powerUrl = jetsonPowerWebSocketUrl(settings.wsUrl);
      if (!powerUrl) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(powerUrl);
      } catch {
        return;
      }
      powerSocketRef.current = socket;
      setTelemetry((current) => ({
        ...current,
        powerTelemetry: {
          ...current.powerTelemetry,
          state: current.powerTelemetry.receivedAt ? "stale" : "connecting",
        },
      }));
      socket.addEventListener("message", (event) => {
        const message = parseJetsonPowerMessage(event.data);
        if (!message) return;
        const now = new Date().toISOString();
        if (powerStaleTimerRef.current !== null) {
          window.clearTimeout(powerStaleTimerRef.current);
        }
        powerStaleTimerRef.current = window.setTimeout(() => {
          setTelemetry((current) => ({
            ...current,
            powerTelemetry: current.powerTelemetry.receivedAt === now
              ? { ...current.powerTelemetry, state: "stale" }
              : current.powerTelemetry,
          }));
        }, POWER_TELEMETRY_FRESHNESS_MS);
        setTelemetry((current) => {
          const previous = current.powerTelemetry;
          const percentage = message.percentage ?? previous.percentage;
          return {
            ...current,
            batteryPercent: percentage,
            powerTelemetry: {
              state: "live",
              deviceId: message.deviceId ?? previous.deviceId,
              busVoltageV: message.busVoltageV ?? previous.busVoltageV,
              psuVoltageV: message.psuVoltageV ?? previous.psuVoltageV,
              currentA: message.currentA ?? previous.currentA,
              powerW: message.powerW ?? previous.powerW,
              percentage,
              observedAt: message.observedAt ?? now,
              receivedAt: now,
            },
          };
        });
      });
      socket.addEventListener("close", () => {
        if (powerSocketRef.current === socket) powerSocketRef.current = null;
        if (disposed) return;
        if (powerStaleTimerRef.current !== null) window.clearTimeout(powerStaleTimerRef.current);
        setTelemetry((current) => ({
          ...current,
          powerTelemetry: {
            ...current.powerTelemetry,
            state: current.powerTelemetry.receivedAt ? "stale" : "offline",
          },
        }));
        powerReconnectTimerRef.current = window.setTimeout(connectPower, 2_000);
      });
      socket.addEventListener("error", () => socket.close());
    };
    connect();
    connectPower();

    return () => {
      disposed = true;
      window.clearTimeout(connectingStateTimer);
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      if (powerReconnectTimerRef.current !== null) window.clearTimeout(powerReconnectTimerRef.current);
      if (telemetryStaleTimerRef.current !== null) window.clearTimeout(telemetryStaleTimerRef.current);
      if (powerStaleTimerRef.current !== null) window.clearTimeout(powerStaleTimerRef.current);
      if (imuStaleTimerRef.current !== null) window.clearTimeout(imuStaleTimerRef.current);
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ cmd: "stop" }));
        } catch {
          // Best effort: closing the transport must not skip the remaining cleanup.
        }
      }
      socket?.close();
      socketRef.current = null;
      powerSocketRef.current?.close();
      powerSocketRef.current = null;
      deviceHeadingRef.current = null;
      latestImuReceivedAtMsRef.current = null;
      latestWheelsRef.current = null;
    };
  }, [settings]);

  const zeroImuHeading = useCallback(() => {
    const nowMs = Date.now();
    const deviceHeading = deviceHeadingRef.current;
    const socket = socketRef.current;
    const imuFresh = latestImuReceivedAtMsRef.current !== null
      && nowMs - latestImuReceivedAtMsRef.current <= IMU_FRESHNESS_MS;
    if (navigationRef.current?.state === "running"
      || !imuFresh || !deviceHeading?.calibrated || !deviceHeading.stationary || deviceHeading.yawRateDps !== 0
      || !socket || socket.readyState !== WebSocket.OPEN) return false;
    const requestId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `imu-zero-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    socket.send(JSON.stringify({ cmd: "imu_zero", request_id: requestId }));
    return true;
  }, []);

  const sendCommand = useCallback(async (input: VehicleCommandRequest) => {
    const socket = socketRef.current;
    if (!settings.enabled || !socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("小车尚未连接，请在系统设置中检查连接。");
    }
    socket.send(JSON.stringify(buildJetsonCommand(input, settings.maxWheelSpeed)));
    return createJetsonCommandAck(input);
  }, [settings]);

  const sendNavigationCommand = useCallback((command: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!settings.enabled || !socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("小车尚未连接，无法使用自动巡航。");
    }
    socket.send(JSON.stringify(command));
  }, [settings.enabled]);

  const saveNavigationMap = useCallback((map: NavigationMapDefinition, baseRevision: number) => {
    const request = requestId("navigation-map-set");
    sendNavigationCommand({
      cmd: "navigation_map_set",
      request_id: request,
      base_revision: baseRevision,
      map: navigationMapToWire(map),
    });
    return request;
  }, [sendNavigationCommand]);

  const planNavigation = useCallback((input: {
    mapRevision: number;
    start: NavigationPoint & { headingDeg: number };
    goal: NavigationPoint;
  }) => {
    const request = requestId("navigation-plan");
    sendNavigationCommand({
      cmd: "navigation_plan",
      request_id: request,
      map_revision: input.mapRevision,
      start: {
        x: input.start.x,
        y: input.start.y,
        heading_deg: input.start.headingDeg,
      },
      goal: input.goal,
    });
    return request;
  }, [sendNavigationCommand]);

  const startNavigation = useCallback((taskId: string) => {
    const request = requestId("navigation-start");
    sendNavigationCommand({ cmd: "navigation_start", request_id: request, task_id: taskId });
    return request;
  }, [sendNavigationCommand]);

  const cancelNavigation = useCallback((taskId?: string) => {
    const request = requestId("navigation-cancel");
    sendNavigationCommand({
      cmd: "navigation_cancel",
      request_id: request,
      ...(taskId ? { task_id: taskId } : {}),
    });
    return request;
  }, [sendNavigationCommand]);

  const refreshNavigation = useCallback(() => {
    sendNavigationCommand({ cmd: "navigation_status", request_id: requestId("navigation-status") });
    sendNavigationCommand({ cmd: "navigation_map_get", request_id: requestId("navigation-map") });
  }, [sendNavigationCommand]);

  return {
    enabled: settings.enabled,
    telemetry,
    navigation,
    sendCommand,
    subscribeVideoFrames,
    zeroImuHeading,
    saveNavigationMap,
    planNavigation,
    startNavigation,
    cancelNavigation,
    refreshNavigation,
  };
}

function requestId(prefix: string) {
  return typeof crypto.randomUUID === "function"
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function inferReportedMotion(data: { M1: number; M2: number; M3: number; M4: number }): VehicleMotion {
  const deadband = 0.5;
  const values = [data.M1, data.M2, data.M3, data.M4];
  if (values.every((value) => Math.abs(value) <= deadband)) return "stop";
  const signs = values.map((value) => value > deadband ? 1 : value < -deadband ? -1 : 0);
  if (signs[0] >= 0 && signs[1] <= 0 && signs[2] >= 0 && signs[3] <= 0) return "forward";
  if (signs[0] <= 0 && signs[1] >= 0 && signs[2] <= 0 && signs[3] >= 0) return "backward";
  if (signs[0] <= 0 && signs[1] <= 0 && signs[2] >= 0 && signs[3] >= 0) return "left";
  if (signs[0] >= 0 && signs[1] >= 0 && signs[2] <= 0 && signs[3] <= 0) return "right";
  return "stop";
}

function reportedSpeedPercent(data: { M1: number; M2: number; M3: number; M4: number }, maxWheelSpeed: number) {
  if (!Number.isFinite(maxWheelSpeed) || maxWheelSpeed <= 0) return 0;
  const meanMagnitude = (Math.abs(data.M1) + Math.abs(data.M2) + Math.abs(data.M3) + Math.abs(data.M4)) / 4;
  return Math.min(100, Math.max(0, Math.round(meanMagnitude / maxWheelSpeed * 100)));
}
