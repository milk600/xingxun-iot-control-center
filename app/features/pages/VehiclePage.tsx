"use client";

import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BatteryCharging,
  CheckCircle2,
  CircleAlert,
  Compass,
  Crosshair,
  Flame,
  Gamepad2,
  Gauge,
  Keyboard,
  LocateFixed,
  Octagon,
  Radio,
  RotateCcw,
  RotateCw,
  Signal,
  Thermometer,
  WifiOff,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { VehicleMotion } from "@/app/lib/iot/contracts";
import {
  AI_ACTION_EVENT,
  registerActionReceiver,
  readActionDispatchDetail,
  reportActionSuccess,
} from "@/app/lib/ai/action-events";
import type { AgentActionDispatchDetail } from "@/app/lib/ai/contracts";
import { UI_PREFERENCES_EVENT, readPreferences } from "@/app/lib/ui-preferences";
import { useIotDashboard } from "@/app/features/iot/use-iot-dashboard";
import { VehicleCameraFeed } from "@/app/features/iot/VehicleCameraFeed";
import { useVehicleGamepad } from "@/app/features/iot/use-vehicle-gamepad";
import { VehicleSpatialMap } from "@/app/features/spatial/VehicleSpatialMap";
import { EmptyState, InlineError, StatusPill, formatTime } from "./PagePrimitives";
import styles from "./Pages.module.css";

const KEY_TO_MOTION: Record<string, Exclude<VehicleMotion, "stop">> = {
  ArrowUp: "forward", w: "forward", W: "forward",
  ArrowDown: "backward", s: "backward", S: "backward",
  ArrowLeft: "left", a: "left", A: "left",
  ArrowRight: "right", d: "right", D: "right",
};

const MOTION_LABEL: Record<VehicleMotion, string> = {
  forward: "前进",
  backward: "后退",
  left: "左转",
  right: "右转",
  stop: "停止",
};

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

interface DriveButtonProps {
  motion: Exclude<VehicleMotion, "stop">;
  label: string;
  icon: LucideIcon;
  active: boolean;
  disabled: boolean;
  onStart: (motion: Exclude<VehicleMotion, "stop">) => void;
  onStop: () => void;
}

function DriveButton({ motion, label, icon: Icon, active, disabled, onStart, onStop }: DriveButtonProps) {
  const visibleLabel = label;
  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    onStart(motion);
  };
  const pointerStop = (event: ReactPointerEvent<HTMLButtonElement>) => {
    onStop();
    if (document.activeElement === event.currentTarget) event.currentTarget.blur();
  };
  const keyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" && !event.repeat && !disabled) {
      event.preventDefault();
      event.stopPropagation();
      onStart(motion);
    }
  };

  return (
    <button
      type="button"
      className={`${styles.driveButton} ${styles[`drive_${motion}`]}${active ? ` ${styles.driveActive}` : ""}`}
      aria-label={`${label}，按住移动，松开停止`}
      aria-pressed={active}
      disabled={disabled}
      onPointerDown={pointerDown}
      onPointerUp={pointerStop}
      onPointerCancel={pointerStop}
      onLostPointerCapture={pointerStop}
      onKeyDown={keyDown}
      onKeyUp={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          onStop();
        }
      }}
    >
      <Icon size={25} aria-hidden="true" />
      <span>{visibleLabel}</span>
    </button>
  );
}

export function VehiclePage() {
  const {
    snapshot,
    refreshError,
    sendCommand,
    stopIfMoving,
    activeMotion,
    commandPhase,
    commandFeedback,
    commandLog,
    zeroImuHeading,
    navigation,
  } = useIotDashboard();
  const [speed, setSpeed] = useState(55);
  const pendingSpeedActionRef = useRef<AgentActionDispatchDetail | null>(null);
  const [keyboardEnabled, setKeyboardEnabled] = useState(true);
  const [imuZeroFeedback, setImuZeroFeedback] = useState<string | null>(null);
  const [imuZeroPending, setImuZeroPending] = useState(false);
  const pendingImuZeroRevisionRef = useRef<number | null>(null);
  const imuZeroTimeoutRef = useRef<number | null>(null);
  const pressedMotion = useRef<VehicleMotion>("stop");
  const vehicle = snapshot.vehicle;
  const powerTelemetry = vehicle.powerTelemetry;
  const fireDetection = vehicle.fireDetection;
  const imu = vehicle.imu;
  const navigationRunning = navigation?.state === "running";
  const canZeroImuHeading = Boolean(!navigationRunning && imu && imu.state === "live" && imu.canZeroHeading && vehicle.connection === "online");
  const controlReady = vehicle.controlLink === "connected";
  const manualControlReady = controlReady && !navigationRunning;
  const telemetryLive = vehicle.connection === "online";
  const controlStatusState = telemetryLive
    ? "online"
    : controlReady || vehicle.controlLink === "connecting"
      ? "warning"
      : "offline";
  const controlStatusLabel = telemetryLive
    ? "车辆回传正常"
    : controlReady
      ? "控制链路已连接"
      : vehicle.controlLink === "connecting"
        ? "正在连接控制链路"
        : vehicle.controlLink === "disabled"
          ? "车辆控制未启用"
          : "控制链路未连接";
  const hasAuxiliaryTelemetry = [
    vehicle.batteryPercent,
    vehicle.obstacleDistanceCm,
    vehicle.signalDbm,
    vehicle.headingDeg,
  ].some((value) => value !== null);

  useEffect(() => {
    const applyPreferences = () => {
      const stored = readPreferences();
      setSpeed(stored.vehicleSpeedPercent);
      setKeyboardEnabled(stored.keyboardControlEnabled);
    };
    const timer = window.setTimeout(applyPreferences, 0);
    window.addEventListener(UI_PREFERENCES_EVENT, applyPreferences);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(UI_PREFERENCES_EVENT, applyPreferences);
    };
  }, []);

  useEffect(() => {
    const pendingRevision = pendingImuZeroRevisionRef.current;
    if (!imu || pendingRevision === null || imu.zeroRevision === pendingRevision) return;
    pendingImuZeroRevisionRef.current = null;
    if (imuZeroTimeoutRef.current !== null) {
      window.clearTimeout(imuZeroTimeoutRef.current);
      imuZeroTimeoutRef.current = null;
    }
    setImuZeroPending(false);
    setImuZeroFeedback("Jetson 已确认，本地航向归零完成。");
  }, [imu]);

  useEffect(() => () => {
    if (imuZeroTimeoutRef.current !== null) window.clearTimeout(imuZeroTimeoutRef.current);
  }, []);

  useEffect(() => {
    const handleAction = (event: Event) => {
      const action = readActionDispatchDetail(event);
      if (action?.name !== "vehicle.set_control_speed") return;
      const nextSpeed = Math.min(100, Math.max(10, action.arguments.speedPercent));
      if (speed === nextSpeed) {
        reportActionSuccess(action, `手动遥控速度已是 ${nextSpeed}%。`);
        return;
      }
      pendingSpeedActionRef.current = action;
      setSpeed(nextSpeed);
    };
    window.addEventListener(AI_ACTION_EVENT, handleAction);
    const unregisterReceiver = registerActionReceiver(["vehicle.set_control_speed"]);
    return () => {
      unregisterReceiver();
      window.removeEventListener(AI_ACTION_EVENT, handleAction);
    };
  }, [speed]);

  useEffect(() => {
    const action = pendingSpeedActionRef.current;
    if (!action || action.name !== "vehicle.set_control_speed") return;
    const expected = Math.min(100, Math.max(10, action.arguments.speedPercent));
    if (speed !== expected) return;
    pendingSpeedActionRef.current = null;
    reportActionSuccess(action, `手动遥控速度已调整为 ${expected}%。`);
  }, [speed]);

  const startMotion = useCallback((motion: Exclude<VehicleMotion, "stop">) => {
    if (!manualControlReady) return;
    pressedMotion.current = motion;
    void sendCommand(motion, speed);
  }, [manualControlReady, sendCommand, speed]);

  const stopMotion = useCallback(() => {
    pressedMotion.current = "stop";
    stopIfMoving();
  }, [stopIfMoving]);

  const gamepadMove = useCallback((
    motion: Exclude<VehicleMotion, "stop">,
    throttlePercent: number,
  ) => {
    if (!manualControlReady) return;
    pressedMotion.current = motion;
    void sendCommand(motion, throttlePercent);
  }, [manualControlReady, sendCommand]);

  const gamepad = useVehicleGamepad({
    enabled: manualControlReady,
    dpadSpeedPercent: speed,
    onMove: gamepadMove,
    onStop: stopMotion,
  });

  const emergencyStop = useCallback(() => {
    pressedMotion.current = "stop";
    void sendCommand("stop", 0);
  }, [sendCommand]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) emergencyStop();
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (!keyboardEnabled) return;
      const motion = KEY_TO_MOTION[event.key];
      if (!motion || event.repeat || !manualControlReady) return;
      event.preventDefault();
      startMotion(motion);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || !KEY_TO_MOTION[event.key]) return;
      event.preventDefault();
      stopMotion();
    };
    const visibility = () => { if (document.visibilityState === "hidden") stopMotion(); };
    const navigationStart = () => stopMotion();

    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", stopMotion);
    window.addEventListener("pagehide", stopMotion);
    window.addEventListener("xingxun:navigation-start", navigationStart);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", stopMotion);
      window.removeEventListener("pagehide", stopMotion);
      window.removeEventListener("xingxun:navigation-start", navigationStart);
      document.removeEventListener("visibilitychange", visibility);
      stopMotion();
    };
  }, [emergencyStop, keyboardEnabled, manualControlReady, startMotion, stopMotion]);

  return (
    <div className={styles.pageSurface}>
      <div className={styles.pageActionBar}>
        <StatusPill state={controlStatusState}>{controlStatusLabel}</StatusPill>
        <button type="button" className={styles.headerStop} onClick={emergencyStop}><Octagon size={17} />立即停止</button>
      </div>
      {refreshError && <InlineError message={refreshError} />}
      {fireDetection.state === "live" && fireDetection.detected === true && (
        <div className={`${styles.safetyBanner} ${styles.fireAlertBanner}`} role="alert" aria-live="assertive">
          <Flame size={19} aria-hidden="true" />
          <div><strong>Jetson 检测到火焰</strong><span>请立即核查车辆画面与现场，并按应急流程处置；系统正在同步严重告警。</span></div>
        </div>
      )}
      {!controlReady && (
        <div className={styles.safetyBanner} role="status">
          <WifiOff size={18} aria-hidden="true" />
          <div><strong>{controlStatusLabel}</strong><span>移动控制已锁定。最后有效回传：{formatTime(vehicle.lastSeenAt)}</span></div>
        </div>
      )}
      {controlReady && !telemetryLive && (
        <div className={styles.safetyBanner} role="status">
          <Radio size={18} aria-hidden="true" />
          <div><strong>控制链路已连接，等待车辆回传</strong><span>链路连通不等于设备状态在线；当前页面不会生成车辆状态数据。</span></div>
        </div>
      )}
      {navigationRunning && (
        <div className={styles.safetyBanner} role="status">
          <LocateFixed size={18} aria-hidden="true" />
          <div><strong>Jetson 正在执行自动巡航</strong><span>人工方向键与航向归零已锁定；“立即停止”和空格急停仍然可用。</span></div>
        </div>
      )}

      <section className={styles.driveLayout}>
        <div className={styles.inspectionViews}>
          <div className={styles.vehicleCameraCell} data-ai-region="vehicle-camera">
            <VehicleCameraFeed />
          </div>
          <VehicleSpatialMap />
        </div>

        <aside className={styles.controlConsole} data-ai-region="manual-controls">
          <header>
            <div><h2>手动驾驶</h2></div>
          </header>

          <div className={styles.dpad} aria-label="小车方向控制">
            <DriveButton motion="forward" label="前进" icon={ArrowUp} active={activeMotion === "forward"} disabled={!manualControlReady} onStart={startMotion} onStop={stopMotion} />
            <DriveButton motion="left" label="左转" icon={ArrowLeft} active={activeMotion === "left"} disabled={!manualControlReady} onStart={startMotion} onStop={stopMotion} />
            <button type="button" className={styles.consoleStop} aria-label="立即停止小车" onClick={emergencyStop}><Octagon size={26} /><span>停止</span></button>
            <DriveButton motion="right" label="右转" icon={ArrowRight} active={activeMotion === "right"} disabled={!manualControlReady} onStart={startMotion} onStop={stopMotion} />
            <DriveButton motion="backward" label="后退" icon={ArrowDown} active={activeMotion === "backward"} disabled={!manualControlReady} onStart={startMotion} onStop={stopMotion} />
          </div>

          <div className={styles.speedPanel}>
            <div><label htmlFor="vehicle-speed">目标速度</label><strong>{speed}%</strong></div>
            <input id="vehicle-speed" type="range" min="10" max="100" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} />
            <div className={styles.speedPresets}>
              {[25, 55, 80].map((value) => <button key={value} type="button" className={speed === value ? styles.presetActive : undefined} onClick={() => setSpeed(value)}>{value === 25 ? "精细" : value === 55 ? "标准" : "快速"}<span>{value}%</span></button>)}
            </div>
          </div>

          <div className={`${styles.commandState} ${commandPhase === "error" ? styles.commandError : ""}`} aria-live="polite">
            <span>{commandPhase === "error" ? <CircleAlert size={18} /> : commandPhase === "accepted" ? <CheckCircle2 size={18} /> : <Radio size={18} />}</span>
            <div><strong>{commandFeedback}</strong></div>
          </div>

          <div className={styles.inputHints}>
            <span><Keyboard size={16} /><strong>键盘{keyboardEnabled ? "" : "（关闭）"}</strong><small>WASD / 方向键 · 空格急停</small></span>
            <span className={gamepad.connected ? styles.inputConnected : styles.inputUnavailable}>
              <Gamepad2 size={16} />
              <strong>手柄{gamepad.connected ? " · 已连接" : ""}</strong>
              <small>{gamepad.connected
                ? `${gamepad.motion === "stop" ? "摇杆回中" : MOTION_LABEL[gamepad.motion]} · 油门 ${gamepad.throttlePercent}%`
                : "未检测到手柄"}</small>
            </span>
          </div>
        </aside>
      </section>

      <section className={styles.driveBottom}>
        <article className={styles.card} data-ai-region="vehicle-status">
          <header className={styles.cardHeader}>
            <div><h2>车辆回传</h2></div>
            <div className={styles.vehicleStatusMeta}>
              <span className={`${styles.fireDetectionBadge} ${
                fireDetection.state !== "live"
                  ? styles.fireDetectionUnknown
                  : fireDetection.detected
                    ? styles.fireDetectionCritical
                    : styles.fireDetectionClear
              }`}>
                <Flame size={14} />
                {fireDetection.state !== "live"
                  ? fireDetection.state === "stale" ? "火焰状态已过期" : "火焰检测未上报"
                  : fireDetection.detected ? "检测到火焰" : "未检测到火焰"}
              </span>
              <span className={styles.updateTime}>最后有效回传 {formatTime(vehicle.observedAt)}</span>
            </div>
          </header>
          {telemetryLive && vehicle.wheelSpeeds ? (
            <div className={styles.telemetryTiles} aria-label="Jetson 四轮速度回传">
              <div><Gauge /><span>M1 轮速</span><strong>{vehicle.wheelSpeeds.m1}<small>{vehicle.wheelSpeeds.unit}</small></strong></div>
              <div><Gauge /><span>M2 轮速</span><strong>{vehicle.wheelSpeeds.m2}<small>{vehicle.wheelSpeeds.unit}</small></strong></div>
              <div><Gauge /><span>M3 轮速</span><strong>{vehicle.wheelSpeeds.m3}<small>{vehicle.wheelSpeeds.unit}</small></strong></div>
              <div><Gauge /><span>M4 轮速</span><strong>{vehicle.wheelSpeeds.m4}<small>{vehicle.wheelSpeeds.unit}</small></strong></div>
              <div><LocateFixed /><span>轮速比例</span><strong>{vehicle.speedPercent}<small>%</small></strong></div>
            </div>
          ) : (
            <EmptyState
              icon={Radio}
              title="暂无有效车辆回传"
              detail={controlReady ? "控制链路已连接，但尚未收到符合协议的 odom 数据。" : "连接 Jetson 后，此处只显示设备真实回传。"}
            />
          )}
          {hasAuxiliaryTelemetry && (
            <div className={styles.telemetryTiles}>
              {vehicle.batteryPercent !== null && <div><BatteryCharging /><span>电池电量</span><strong>{vehicle.batteryPercent}<small>%</small></strong></div>}
              {vehicle.obstacleDistanceCm !== null && <div><LocateFixed /><span>障碍距离</span><strong>{vehicle.obstacleDistanceCm}<small>cm</small></strong></div>}
              {vehicle.signalDbm !== null && <div><Signal /><span>无线信号</span><strong>{vehicle.signalDbm}<small>dBm</small></strong></div>}
              {vehicle.headingDeg !== null && <div><Compass /><span>车辆航向</span><strong>{vehicle.headingDeg}<small>°</small></strong></div>}
            </div>
          )}
          <section className={styles.powerTelemetryBlock} aria-label="Jetson UPS 电源回传">
            <header className={styles.imuTelemetryHeader}>
              <div>
                <h3>UPS 电源监控</h3>
                <span>{powerTelemetry.deviceId ? `设备 ${powerTelemetry.deviceId}` : "自动连接 Jetson 的 8001/ws 电源数据通道"}</span>
              </div>
              <StatusPill state={powerTelemetry.state === "live" ? "online" : powerTelemetry.state === "connecting" ? "warning" : "offline"}>
                {powerTelemetry.state === "live"
                  ? "电源数据实时"
                  : powerTelemetry.state === "stale"
                    ? "电源数据已过期"
                    : powerTelemetry.state === "connecting"
                      ? "正在连接电源数据"
                      : "电源数据未连接"}
              </StatusPill>
            </header>
            <div className={`${styles.telemetryTiles} ${styles.powerTelemetryTiles}`}>
              <div><BatteryCharging /><span>剩余电量</span><strong>{powerTelemetry.percentage === null ? "--" : powerTelemetry.percentage.toFixed(1)}<small>%</small></strong></div>
              <div><Zap /><span>负载电压</span><strong>{powerTelemetry.busVoltageV === null ? "--" : powerTelemetry.busVoltageV.toFixed(3)}<small>V</small></strong></div>
              <div><Zap /><span>电源电压</span><strong>{powerTelemetry.psuVoltageV === null ? "--" : powerTelemetry.psuVoltageV.toFixed(3)}<small>V</small></strong></div>
              <div><Activity /><span>电流</span><strong>{powerTelemetry.currentA === null ? "--" : powerTelemetry.currentA.toFixed(3)}<small>A</small></strong></div>
              <div><Gauge /><span>功率</span><strong>{powerTelemetry.powerW === null ? "--" : powerTelemetry.powerW.toFixed(3)}<small>W</small></strong></div>
            </div>
            <p className={styles.powerTelemetryMeta}>设备上报时间 {formatTime(powerTelemetry.observedAt)} · 本机接收时间 {formatTime(powerTelemetry.receivedAt)}</p>
          </section>
          {imu && (
            <section className={styles.imuTelemetryBlock} aria-label="MPU6050 IMU 实时回传">
              <header className={styles.imuTelemetryHeader}>
                <div>
                  <h3>MPU6050 姿态传感器</h3>
                  <span>车辆页与空间孪生仅使用 Jetson 本地累计航向；原始陀螺仪只作诊断显示。</span>
                </div>
                <div className={styles.imuTelemetryActions}>
                  <StatusPill state={imu.state === "live" ? "online" : imu.state === "calibrating" ? "warning" : "offline"}>
                    {imu.state === "live"
                      ? "Jetson 航向已就绪"
                      : imu.state === "calibrating"
                        ? `静止校准 ${imu.calibrationSamples}/${imu.calibrationRequiredSamples}`
                        : "IMU 回传已过期"}
                  </StatusPill>
                  <button
                    type="button"
                    className={styles.imuZeroButton}
                    disabled={!canZeroImuHeading || imuZeroPending}
                    aria-describedby="imu-zero-guidance"
                    title={imuZeroPending
                      ? "等待 Jetson 确认归零"
                      : canZeroImuHeading ? "把当前相对航向设为 0°" : "仅在车辆静止且 IMU 就绪时可归零"}
                    onClick={() => {
                      const zeroed = zeroImuHeading();
                      if (!zeroed) {
                        setImuZeroFeedback("归零请求未发送，请确认车辆完全静止、Jetson 航向在线。");
                        return;
                      }
                      pendingImuZeroRevisionRef.current = imu.zeroRevision;
                      setImuZeroPending(true);
                      setImuZeroFeedback("归零请求已发送，等待 Jetson 返回新的航向修订。");
                      if (imuZeroTimeoutRef.current !== null) window.clearTimeout(imuZeroTimeoutRef.current);
                      imuZeroTimeoutRef.current = window.setTimeout(() => {
                        if (pendingImuZeroRevisionRef.current === null) return;
                        pendingImuZeroRevisionRef.current = null;
                        imuZeroTimeoutRef.current = null;
                        setImuZeroPending(false);
                        setImuZeroFeedback("Jetson 未在 3 秒内确认归零，请查看 Jetson 的 [IMU ZERO] 日志。");
                      }, 3_000);
                    }}
                  >
                    <Crosshair size={16} aria-hidden="true" />
                    航向归零
                  </button>
                </div>
              </header>
              <div className={`${styles.telemetryTiles} ${styles.imuTelemetryTiles}`}>
                <div><Activity /><span>Acc X</span><strong>{imu.acceleration.x.toFixed(2)}<small>{imu.acceleration.unit}</small></strong></div>
                <div><Activity /><span>Acc Y</span><strong>{imu.acceleration.y.toFixed(2)}<small>{imu.acceleration.unit}</small></strong></div>
                <div><Activity /><span>Acc Z</span><strong>{imu.acceleration.z.toFixed(2)}<small>{imu.acceleration.unit}</small></strong></div>
                <div><RotateCw /><span>Gyro X</span><strong>{imu.angularVelocity.x.toFixed(2)}<small>°/s</small></strong></div>
                <div><RotateCw /><span>Gyro Y</span><strong>{imu.angularVelocity.y.toFixed(2)}<small>°/s</small></strong></div>
                <div><RotateCw /><span>Gyro Z</span><strong>{imu.angularVelocity.z.toFixed(2)}<small>°/s</small></strong></div>
                <div><Thermometer /><span>传感器温度</span><strong>{imu.temperatureC.toFixed(1)}<small>℃</small></strong></div>
                <div><Compass /><span>Jetson 相对航向</span><strong>{imu.relativeHeadingDeg.toFixed(1)}<small>°</small></strong></div>
              </div>
              <p className={styles.imuTelemetryMeta}>
                航向源 Jetson 本地积分 · 网络 {imu.networkRttMs === null ? "RTT 测量中" : `RTT ${imu.networkRttMs.toFixed(1)}ms / 单程估算 ${(imu.networkOneWayMs ?? imu.networkRttMs / 2).toFixed(1)}ms`} · 加速度模长 {imu.accelerationMagnitudeG.toFixed(3)}g · Jetson 校正角速度 {imu.correctedYawRateDegps.toFixed(2)}°/s · Z 轴零偏 {imu.gyroBiasZDps.toFixed(3)}°/s
              </p>
              <p id="imu-zero-guidance" className={styles.imuZeroGuidance} aria-live="polite">
                {imuZeroFeedback ?? `首次静止校准与手动归零均由 Jetson 执行。上次航向修订 ${formatTime(imu.zeroedAt)} · 更新 ${formatTime(imu.observedAt)}`}
              </p>
            </section>
          )}
        </article>

        <article className={styles.card} data-ai-region="command-log">
          <header className={styles.cardHeader}><div><h2>操作记录</h2></div><span className={styles.updateTime}>最近 {commandLog.length} 条</span></header>
          {commandLog.length === 0 ? <EmptyState icon={RotateCcw} title="暂无操作记录" detail="控制小车后，操作记录会显示在这里。" /> : (
            <ul className={styles.commandTimeline}>
              {commandLog.map((item) => <li key={item.requestId}><span className={item.status === "rejected" ? styles.timelineRejected : styles.timelineAccepted}>{item.status === "rejected" ? <CircleAlert /> : item.status === "executed" ? <CheckCircle2 /> : <Radio />}</span><div><strong>{MOTION_LABEL[item.motion]} · {item.speedPercent}%</strong><p>{item.message}</p></div><time>{formatTime(item.acknowledgedAt)}</time></li>)}
            </ul>
          )}
        </article>
      </section>
    </div>
  );
}
