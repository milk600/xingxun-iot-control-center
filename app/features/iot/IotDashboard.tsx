"use client";

import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BatteryCharging,
  Bell,
  CarFront,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Cloud,
  Command,
  Compass,
  Database,
  Droplets,
  FlaskConical,
  Gauge,
  Keyboard,
  LayoutDashboard,
  Menu,
  Navigation,
  Octagon,
  PlugZap,
  RadioTower,
  RefreshCw,
  Ruler,
  ScanLine,
  ServerCog,
  Settings2,
  ShieldCheck,
  Signal,
  Sun,
  Thermometer,
  Wind,
  Wifi,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";
import {
  TELEMETRY_SLOT_IDS,
  type TelemetrySlot,
  type TelemetrySlotId,
  type VehicleMotion,
} from "@/app/lib/iot/contracts";
import { useIotDashboard } from "./use-iot-dashboard";
import { useAndroidBack } from "@/app/features/ui/useAndroidBack";

const metricIcons: Record<TelemetrySlotId, LucideIcon> = {
  "slot-1": Thermometer,
  "slot-2": Droplets,
  "slot-3": Cloud,
  "slot-4": Wind,
  "slot-5": FlaskConical,
  "slot-6": Sun,
};

const motionLabels: Record<VehicleMotion, string> = {
  forward: "前进",
  backward: "后退",
  left: "左转",
  right: "右转",
  stop: "停止",
};

const keyToMotion: Record<string, VehicleMotion> = {
  ArrowUp: "forward",
  w: "forward",
  W: "forward",
  ArrowDown: "backward",
  s: "backward",
  S: "backward",
  ArrowLeft: "left",
  a: "left",
  A: "left",
  ArrowRight: "right",
  d: "right",
  D: "right",
};

function formatTime(value: string | null) {
  if (!value || value === new Date(0).toISOString()) return "等待数据";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatMetric(slot: TelemetrySlot) {
  if (slot.value === null) return "--";
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: slot.precision,
    maximumFractionDigits: slot.precision,
  }).format(slot.value);
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function MetricCard({ slot }: { slot: TelemetrySlot }) {
  const Icon = metricIcons[slot.slotId];
  return (
    <article
      className={`metric-card tone-${slot.tone}`}
      data-slot-id={slot.slotId}
      aria-label={`${slot.label}，${slot.state === "live" ? "实时" : slot.state}`}
    >
      <div className="metric-card-topline">
        <div className="metric-icon" aria-hidden="true">
          <Icon size={23} strokeWidth={1.9} />
        </div>
        <span className="slot-id">{slot.slotId.toUpperCase()}</span>
      </div>
      <div className="metric-content">
        <p>{slot.label}</p>
        <div className="metric-value-row">
          <strong>{formatMetric(slot)}</strong>
          {slot.unit && <span>{slot.unit}</span>}
        </div>
      </div>
      <div className="metric-foot">
        <span className={`state-dot state-${slot.state}`} aria-hidden="true" />
        <span>{slot.supportingText}</span>
      </div>
    </article>
  );
}

interface DirectionButtonProps {
  motion: Exclude<VehicleMotion, "stop">;
  label: string;
  Icon: LucideIcon;
  active: boolean;
  disabled: boolean;
  onStart: (motion: Exclude<VehicleMotion, "stop">) => void;
  onStop: () => void;
}

function DirectionButton({
  motion,
  label,
  Icon,
  active,
  disabled,
  onStart,
  onStop,
}: DirectionButtonProps) {
  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    onStart(motion);
  };

  const handleKeyboardDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      onStart(motion);
    }
  };

  const handleKeyboardUp = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      onStop();
    }
  };

  return (
    <button
      className={`direction-button direction-${motion}${active ? " is-active" : ""}`}
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={`${label}（按住移动，松开停止）`}
      disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerUp={onStop}
      onPointerCancel={onStop}
      onLostPointerCapture={onStop}
      onKeyDown={handleKeyboardDown}
      onKeyUp={handleKeyboardUp}
    >
      <Icon size={25} strokeWidth={2} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

export function IotDashboard() {
  const androidStandalone = typeof window !== "undefined" && window.location.hostname === "xingxun.local";
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("overview");
  const [speedPercent, setSpeedPercent] = useState(56);
  const keyboardMotion = useRef<VehicleMotion>("stop");
  const {
    snapshot,
    isRefreshing,
    refreshError,
    refresh,
    sendCommand,
    stopIfMoving,
    activeMotion,
    commandPhase,
    commandFeedback,
    commandLog,
  } = useIotDashboard();

  useAndroidBack(menuOpen, () => setMenuOpen(false), 50);

  const vehicleOnline = snapshot.vehicle.connection === "online";
  const slots = useMemo(
    () => TELEMETRY_SLOT_IDS.map((id) => snapshot.slots[id]),
    [snapshot.slots],
  );

  const startMotion = useCallback(
    (motion: Exclude<VehicleMotion, "stop">) => {
      if (!vehicleOnline) return;
      keyboardMotion.current = motion;
      void sendCommand(motion, speedPercent);
    },
    [sendCommand, speedPercent, vehicleOnline],
  );

  const stopMotion = useCallback(() => {
    keyboardMotion.current = "stop";
    stopIfMoving();
  }, [stopIfMoving]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.code === "Space") {
        event.preventDefault();
        keyboardMotion.current = "stop";
        void sendCommand("stop", 0);
        return;
      }
      const motion = keyToMotion[event.key];
      if (!motion || event.repeat || !vehicleOnline) return;
      event.preventDefault();
      startMotion(motion as Exclude<VehicleMotion, "stop">);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const motion = keyToMotion[event.key];
      if (!motion || keyboardMotion.current === "stop") return;
      event.preventDefault();
      stopMotion();
    };

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") stopMotion();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", stopMotion);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", stopMotion);
      document.removeEventListener("visibilitychange", handleVisibility);
      stopMotion();
    };
  }, [sendCommand, startMotion, stopMotion, vehicleOnline]);

  const navItems: Array<{
    id: string;
    label: string;
    icon: LucideIcon;
    href?: string;
  }> = [
    { id: "overview", label: "控制概览", icon: LayoutDashboard },
    { id: "digital-twin", label: "空间孪生", icon: ScanLine, href: "/digital-twin" },
    { id: "remote-control", label: "小车遥控", icon: CarFront },
    { id: "telemetry", label: "数据监测", icon: Activity },
    { id: "interfaces", label: "连接管理", icon: ServerCog },
    { id: "settings", label: "系统设置", icon: Settings2 },
  ];

  const goTo = (id: string) => {
    setActiveSection(id);
    setMenuOpen(false);
    document.getElementById(id)?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  };

  return (
    <div className="app-shell">
      {menuOpen && (
        <button
          className="mobile-backdrop"
          type="button"
          aria-label="关闭导航"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <aside className={`sidebar${menuOpen ? " is-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            <RadioTower size={25} strokeWidth={2} />
          </div>
          <div>
            <strong>危化智巡</strong>
            <span>IoT Control Center</span>
          </div>
          <button
            className="sidebar-close icon-button"
            type="button"
            aria-label="关闭导航"
            title="关闭导航"
            onClick={() => setMenuOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        <nav className="main-nav" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            if (item.href) {
              return (
                <Link href={item.href} key={item.id}>
                  <Icon size={20} strokeWidth={1.9} aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              );
            }
            return (
              <button
                type="button"
                key={item.id}
                className={activeSection === item.id ? "is-active" : ""}
                onClick={() => goTo(item.id)}
              >
                <Icon size={20} strokeWidth={1.9} aria-hidden="true" />
                <span>{item.label}</span>
                {item.id === "interfaces" && (
                  <span className="nav-dot" aria-label="接口待配置" />
                )}
              </button>
            );
          })}
        </nav>

        <section className="sidebar-interface-card" aria-labelledby="sidebar-api-title">
          <div>
            <PlugZap size={17} aria-hidden="true" />
            <strong id="sidebar-api-title">接口模式</strong>
          </div>
          <p>当前运行 Mock Provider</p>
          <span><i aria-hidden="true" /> 华为云接口已预留</span>
        </section>

        <div className="system-health">
          <span className="health-dot" aria-hidden="true" />
          <div>
            <strong>本地系统正常</strong>
            <span>5 个数据位 · 控制接口就绪</span>
          </div>
        </div>
      </aside>

      <main className="dashboard-main" id="overview">
        <header className="top-header">
          <div className="header-title-group">
            <button
              className="menu-button icon-button"
              type="button"
              aria-label="打开导航"
              title="打开导航"
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={22} />
            </button>
            <div>
              <p className="eyebrow">IOT OPERATIONS</p>
              <h1>智能巡检控制台</h1>
              <p className="page-subtitle">设备遥测、云端接口与移动小车控制</p>
            </div>
          </div>

          <div className="header-actions">
            <div className={`provider-badge provider-${snapshot.provider}`}>
              <Cloud size={16} aria-hidden="true" />
              <span>{snapshot.provider === "mock" ? (androidStandalone ? "等待华为云" : "演示接口") : "华为云"}</span>
            </div>
            <div className="last-update">
              <span>最后刷新</span>
              <strong>{formatTime(snapshot.generatedAt)}</strong>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="刷新数据"
              title="刷新数据"
              onClick={() => void refresh()}
              disabled={isRefreshing}
            >
              <RefreshCw
                size={19}
                className={isRefreshing ? "is-spinning" : ""}
              />
            </button>
            <button
              className="icon-button notification-button"
              type="button"
              aria-label="查看通知，当前无未读告警"
              title="通知"
              onClick={() => goTo("interfaces")}
            >
              <Bell size={19} />
              <span aria-hidden="true" />
            </button>
            <div className="operator-badge" aria-label="当前用户：操作员">
              <span>OP</span>
              <div><strong>操作员</strong><small>管理员</small></div>
            </div>
          </div>
        </header>

        {refreshError && (
          <div className="inline-alert" role="alert">
            <CircleAlert size={18} aria-hidden="true" />
            <span>数据刷新失败：{refreshError}</span>
            <button type="button" onClick={() => void refresh()}>重试</button>
          </div>
        )}

        <section className="telemetry-section" id="telemetry" aria-labelledby="telemetry-title">
          <div className="section-heading">
            <div>
              <h2 id="telemetry-title">遥测数据位</h2>
              <p>固定预留 5 个显示位，后续映射华为云设备属性</p>
            </div>
            <span className="section-status"><i aria-hidden="true" /> 3.5 秒轮询</span>
          </div>
          <div className="metric-grid">
            {slots.map((slot) => <MetricCard key={slot.slotId} slot={slot} />)}
          </div>
        </section>

        <section className="vehicle-grid" id="remote-control" aria-label="小车控制与回传数据">
          <article className="panel-card remote-card">
            <div className="card-heading">
              <div>
                <p className="card-kicker">VEHICLE CONTROL</p>
                <h2>小车遥控器</h2>
                <p>按住方向键移动，松开后自动发送停止指令</p>
              </div>
              <span className={`connection-badge connection-${snapshot.vehicle.connection}`}>
                <i aria-hidden="true" />
                {vehicleOnline ? "小车在线" : "小车离线"}
              </span>
            </div>

            <div className="remote-layout">
              <div className="dpad" aria-label="小车方向控制区">
                <DirectionButton
                  motion="forward"
                  label="前进"
                  Icon={ArrowUp}
                  active={activeMotion === "forward"}
                  disabled={!vehicleOnline}
                  onStart={startMotion}
                  onStop={stopMotion}
                />
                <DirectionButton
                  motion="left"
                  label="左转"
                  Icon={ArrowLeft}
                  active={activeMotion === "left"}
                  disabled={!vehicleOnline}
                  onStart={startMotion}
                  onStop={stopMotion}
                />
                <button
                  className="stop-button"
                  type="button"
                  aria-label="立即停止小车"
                  title="停止（空格键）"
                  onClick={() => void sendCommand("stop", 0)}
                >
                  <Octagon size={24} strokeWidth={2.2} aria-hidden="true" />
                  <span>STOP</span>
                </button>
                <DirectionButton
                  motion="right"
                  label="右转"
                  Icon={ArrowRight}
                  active={activeMotion === "right"}
                  disabled={!vehicleOnline}
                  onStart={startMotion}
                  onStop={stopMotion}
                />
                <DirectionButton
                  motion="backward"
                  label="后退"
                  Icon={ArrowDown}
                  active={activeMotion === "backward"}
                  disabled={!vehicleOnline}
                  onStart={startMotion}
                  onStop={stopMotion}
                />
              </div>

              <div className="control-settings">
                <div className="speed-control">
                  <div className="control-label-row">
                    <label htmlFor="speed-range">目标速度</label>
                    <strong>{speedPercent}%</strong>
                  </div>
                  <input
                    id="speed-range"
                    type="range"
                    min="10"
                    max="100"
                    value={speedPercent}
                    onChange={(event) => setSpeedPercent(Number(event.target.value))}
                    aria-describedby="speed-help"
                  />
                  <div className="range-labels" id="speed-help"><span>稳速</span><span>快速</span></div>
                </div>

                <div className={`command-feedback feedback-${commandPhase}`} aria-live="polite">
                  <div className="feedback-icon" aria-hidden="true">
                    {commandPhase === "error" ? <CircleAlert size={19} /> : <Command size={19} />}
                  </div>
                  <div>
                    <span>当前指令</span>
                    <strong>{motionLabels[activeMotion]}</strong>
                    <p>{commandFeedback}</p>
                  </div>
                </div>

                <div className="keyboard-hint">
                  <Keyboard size={18} aria-hidden="true" />
                  <p><strong>键盘控制</strong><span>WASD / 方向键移动 · 空格急停</span></p>
                </div>
              </div>
            </div>
          </article>

          <article className="panel-card vehicle-data-card">
            <div className="card-heading compact-heading">
              <div>
                <p className="card-kicker">RETURN TELEMETRY</p>
                <h2>小车回传数据</h2>
              </div>
              <span className="live-time"><Clock3 size={15} /> {formatTime(snapshot.vehicle.observedAt)}</span>
            </div>

            <div className="vehicle-visual" aria-label={`小车航向 ${snapshot.vehicle.headingDeg ?? 0} 度`}>
              <div className="radar-ring ring-one" />
              <div className="radar-ring ring-two" />
              <div className="radar-cross cross-x" />
              <div className="radar-cross cross-y" />
              <div className="vehicle-marker" style={{ transform: `rotate(${snapshot.vehicle.headingDeg ?? 0}deg)` }}>
                <Navigation size={28} fill="currentColor" aria-hidden="true" />
              </div>
              <span className="vehicle-motion-label">{motionLabels[snapshot.vehicle.motion]}</span>
            </div>

            <div className="vehicle-stat-grid">
              <div><BatteryCharging aria-hidden="true" /><span>电池</span><strong>{snapshot.vehicle.batteryPercent ?? "--"}<small>%</small></strong></div>
              <div><Gauge aria-hidden="true" /><span>速度</span><strong>{snapshot.vehicle.speedPercent}<small>%</small></strong></div>
              <div><Ruler aria-hidden="true" /><span>前方距离</span><strong>{snapshot.vehicle.obstacleDistanceCm ?? "--"}<small>cm</small></strong></div>
              <div><Signal aria-hidden="true" /><span>信号</span><strong>{snapshot.vehicle.signalDbm ?? "--"}<small>dBm</small></strong></div>
              <div><Compass aria-hidden="true" /><span>航向</span><strong>{snapshot.vehicle.headingDeg ?? "--"}<small>°</small></strong></div>
            </div>
          </article>
        </section>

        <section className="bottom-grid" id="interfaces" aria-label="接口与系统信息">
          <article className="panel-card interface-card">
            <div className="card-heading compact-heading">
              <div>
                <p className="card-kicker">INTEGRATION READY</p>
                <h2>预留接口</h2>
                <p>组件不依赖云厂商字段，替换服务端 Provider 即可接入</p>
              </div>
              <span className="ready-badge"><ShieldCheck size={16} /> 边界已建立</span>
            </div>
            <div className="interface-list">
              <div className="interface-row">
                <span className="interface-icon blue"><Database size={19} /></span>
                <div><strong>五位遥测输入</strong><code>GET /api/iot/snapshot</code></div>
                <span className="interface-state"><i /> Mock 已连接</span>
              </div>
              <div className="interface-row">
                <span className="interface-icon green"><Command size={19} /></span>
                <div><strong>小车指令输出</strong><code>POST /api/iot/vehicle/commands</code></div>
                <span className="interface-state"><i /> 可发送</span>
              </div>
              <div className="interface-row">
                <span className="interface-icon orange"><Cloud size={19} /></span>
                <div><strong>华为云 Provider</strong><code>IOT_PROVIDER=huawei-cloud</code></div>
                <span className="interface-state waiting"><i /> 待配置</span>
              </div>
            </div>
          </article>

          <article className="panel-card command-log-card">
            <div className="card-heading compact-heading">
              <div><p className="card-kicker">COMMAND HISTORY</p><h2>最近指令</h2></div>
              <span>{commandLog.length} 条</span>
            </div>
            {commandLog.length === 0 ? (
              <div className="empty-state"><Command size={24} /><strong>暂无控制指令</strong><p>使用方向键控制小车后，回执会显示在这里。</p></div>
            ) : (
              <ul className="command-list">
                {commandLog.map((item) => (
                  <li key={`${item.requestId}-${item.acknowledgedAt}`}>
                    <span className={`log-icon log-${item.status}`}>
                      {item.status === "rejected" ? <CircleAlert size={17} /> : <CircleCheck size={17} />}
                    </span>
                    <div><strong>{motionLabels[item.motion]}</strong><span>{item.speedPercent}% · {item.message}</span></div>
                    <time>{formatTime(item.acknowledgedAt)}</time>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="panel-card status-card" id="settings">
            <div className="card-heading compact-heading">
              <div><p className="card-kicker">SYSTEM STATUS</p><h2>运行状态</h2></div>
              <button className="text-button" type="button" onClick={() => void refresh()}>重新检查 <ChevronRight size={16} /></button>
            </div>
            <div className="status-summary"><span><Wifi size={22} /></span><div><strong>系统运行正常</strong><p>数据接口与控制通道均可访问</p></div></div>
            <ul className="health-list">
              <li><span>遥测显示位</span><strong><i /> 5 / 5 已预留</strong></li>
              <li><span>小车控制通道</span><strong><i /> 在线</strong></li>
              <li><span>华为云配置</span><strong className="is-waiting"><i /> 等待凭据</strong></li>
            </ul>
          </article>
        </section>

        <footer className="app-footer">
          <span>危化智巡 · IoT Web Console</span>
          <span>{androidStandalone ? "Android 独立数据链路 · 华为云 IoTDA / Jetson 局域网直连" : "当前为演示数据，生产环境请配置服务端华为云 Provider。"}</span>
        </footer>
      </main>
    </div>
  );
}
