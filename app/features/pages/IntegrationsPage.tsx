"use client";

import {
  ArrowRight,
  Bot,
  CarFront,
  CircleAlert,
  Cloud,
  CloudCog,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { useAiControl } from "@/app/features/ai/AiControlContext";
import {
  AI_ACTION_EVENT,
  registerActionReceiver,
  readActionDispatchDetail,
  reportActionError,
  reportActionSuccess,
} from "@/app/lib/ai/action-events";
import { useIotDashboard } from "@/app/features/iot/use-iot-dashboard";
import { TransitionLink } from "@/app/features/transitions/NavigationTransition";
import {
  TELEMETRY_SLOT_IDS,
  type DashboardSnapshot,
  type DataState,
  type VehicleTelemetry,
} from "@/app/lib/iot/contracts";
import {
  SLOT_ICONS,
  STATE_LABELS,
  formatMetric,
  formatTime,
  InlineError,
} from "./PagePrimitives";
import styles from "./Pages.module.css";

const LEGACY_MAPPING_DRAFT_KEY = "xingxun:iot-slot-mapping-draft";
const INITIAL_TIMESTAMP = new Date(0).toISOString();

type ConnectionTone = "ready" | "info" | "loading" | "warning" | "offline" | "error" | "neutral";
type AiConnection = ReturnType<typeof useAiControl>["connection"];

interface ConnectionHealth {
  label: string;
  detail: string;
  tone: ConnectionTone;
}

const SLOT_STATE_DETAIL: Record<DataState, string> = {
  loading: "正在读取",
  live: "实时",
  stale: "待更新",
  offline: "离线",
  empty: "等待数据",
  error: "异常",
};

function latestTimestamp(values: ReadonlyArray<string | null>) {
  let latest: { value: string; time: number } | null = null;
  for (const value of values) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) continue;
    if (!latest || time > latest.time) latest = { value, time };
  }
  return latest?.value ?? null;
}

function getSensorHealth(snapshot: DashboardSnapshot, isRefreshing: boolean): ConnectionHealth {
  const slots = TELEMETRY_SLOT_IDS.map((slotId) => snapshot.slots[slotId]);
  const counts = slots.reduce<Record<DataState, number>>(
    (result, slot) => ({ ...result, [slot.state]: result[slot.state] + 1 }),
    { loading: 0, live: 0, stale: 0, offline: 0, empty: 0, error: 0 },
  );
  const hasReadError = snapshot.partialErrors.some((error) => error.scope === "slots");

  if (hasReadError || counts.error > 0) {
    return { label: "读取异常", detail: "部分传感器数据读取失败", tone: "error" };
  }
  if (counts.loading === slots.length || (isRefreshing && snapshot.generatedAt === INITIAL_TIMESTAMP)) {
    return { label: "正在读取", detail: "正在检查传感器数据源", tone: "loading" };
  }
  if (counts.offline + counts.empty === slots.length) {
    return { label: "全部离线", detail: "暂未收到设备上报", tone: "offline" };
  }
  if (counts.stale + counts.offline + counts.empty > 0) {
    return { label: "部分待更新", detail: `${counts.live} 路实时，${slots.length - counts.live} 路待更新`, tone: "warning" };
  }
  if (snapshot.provider === "mock") {
    return { label: "接口未配置", detail: "当前没有可用的真实传感器数据源", tone: "warning" };
  }
  return { label: "连接正常", detail: `${slots.length} 路传感器均在实时上报`, tone: "ready" };
}

function getVehicleHealth(enabled: boolean, vehicle: VehicleTelemetry): ConnectionHealth {
  if (!enabled || vehicle.controlLink === "disabled") {
    return { label: "未启用", detail: "可在系统设置中启用小车连接", tone: "neutral" };
  }
  if (vehicle.connection === "online") {
    return { label: "回传正常", detail: "已收到经过协议校验的车辆状态", tone: "ready" };
  }
  if (vehicle.controlLink === "connected") {
    return { label: "链路已连接", detail: "控制链路可用，尚未收到有效车辆回传", tone: "warning" };
  }
  if (vehicle.controlLink === "connecting") {
    return { label: "连接中", detail: "正在建立 Jetson 控制链路", tone: "loading" };
  }
  if (vehicle.connection === "stale") {
    return { label: "回传中断", detail: "保留最后回传时间，但当前链路已断开", tone: "warning" };
  }
  return { label: "链路断开", detail: "当前无法连接 Jetson 控制服务", tone: "offline" };
}

function getAiHealth(connection: AiConnection): ConnectionHealth {
  const states: Record<AiConnection, ConnectionHealth> = {
    connecting: { label: "连接中", detail: "正在连接智能中枢", tone: "loading" },
    pairing: { label: "等待配对", detail: "智能中枢已响应，等待完成配对", tone: "warning" },
    online: { label: "在线", detail: "智能中枢可以接收控制请求", tone: "ready" },
    offline: { label: "离线", detail: "智能中枢当前未连接", tone: "offline" },
  };
  return states[connection];
}

function ConnectionBadge({ health }: { health: ConnectionHealth }) {
  return (
    <span className={`${styles.connectionBadge} ${styles[`connectionTone_${health.tone}`]}`}>
      <i aria-hidden="true" />
      {health.label}
    </span>
  );
}

function ErrorDetails({ title, messages }: { title: string; messages: ReadonlyArray<string> }) {
  if (messages.length === 0) return null;
  return (
    <div className={styles.connectionErrors} role="alert">
      <CircleAlert size={17} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <ul>{messages.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}</ul>
      </div>
    </div>
  );
}

function ConnectionCard({
  icon,
  title,
  eyebrow,
  health,
  children,
  className,
  aiRegion,
}: {
  icon: ReactNode;
  title: string;
  eyebrow: string;
  health: ConnectionHealth;
  children: ReactNode;
  className?: string;
  aiRegion?: string;
}) {
  return (
    <article className={`${styles.card} ${styles.connectionCard}${className ? ` ${className}` : ""}`} data-ai-region={aiRegion}>
      <header className={styles.connectionCardHeader}>
        <span className={styles.connectionCardIcon}>{icon}</span>
        <div>
          <span>{eyebrow}</span>
          <h2>{title}</h2>
        </div>
        <ConnectionBadge health={health} />
      </header>
      <p className={styles.connectionDescription}>{health.detail}</p>
      {children}
    </article>
  );
}

export function IntegrationsPage() {
  const { snapshot, jetsonEnabled, isRefreshing, refreshError, refresh } = useIotDashboard();
  const { connection: aiConnection } = useAiControl();
  const androidStandalone = typeof window !== "undefined" && window.location.hostname === "xingxun.local";

  useEffect(() => {
    try {
      window.localStorage.removeItem(LEGACY_MAPPING_DRAFT_KEY);
    } catch {
      // Storage can be unavailable in privacy-restricted WebViews.
    }
  }, []);

  useEffect(() => {
    const handleAction = (event: Event) => {
      const action = readActionDispatchDetail(event);
      if (action?.name !== "connections.refresh") return;
      void refresh().then((ok) => {
        if (ok) reportActionSuccess(action, "连接状态数据已刷新。");
        else reportActionError(action, "连接状态刷新失败，请检查数据或网络连接。");
      }).catch((error) => reportActionError(action, error, "连接状态刷新失败。"));
    };
    window.addEventListener(AI_ACTION_EVENT, handleAction);
    const unregisterReceiver = registerActionReceiver(["connections.refresh"]);
    return () => {
      unregisterReceiver();
      window.removeEventListener(AI_ACTION_EVENT, handleAction);
    };
  }, [refresh]);

  const sensorHealth = getSensorHealth(snapshot, isRefreshing);
  const vehicleHealth = getVehicleHealth(jetsonEnabled, snapshot.vehicle);
  const aiHealth = getAiHealth(aiConnection);
  const sensorErrors = snapshot.partialErrors.some((error) => error.scope === "slots")
    ? ["暂时无法读取部分传感器数据，请稍后重试。"]
    : [];
  const vehicleErrors = jetsonEnabled && snapshot.partialErrors.some((error) => error.scope === "vehicle")
    ? ["小车连接异常，请检查小车网络与连接设置。"]
    : [];
  const latestSensorReading = latestTimestamp(
    TELEMETRY_SLOT_IDS.map((slotId) => snapshot.slots[slotId].observedAt),
  );
  const latestVehicleReading = snapshot.vehicle.lastSeenAt ?? snapshot.vehicle.observedAt;
  const availableConnections = [
    sensorHealth.tone === "ready" || sensorHealth.tone === "info",
    vehicleHealth.tone === "ready",
    aiHealth.tone === "ready",
  ].filter(Boolean).length;
  const hasCriticalIssue = sensorHealth.tone === "error" || (jetsonEnabled && vehicleHealth.tone === "offline");
  const hasPendingConnection = [sensorHealth, vehicleHealth, aiHealth].some(
    (health) => health.tone === "warning" || health.tone === "offline" || health.tone === "loading",
  );
  const overallHealth: ConnectionHealth = hasCriticalIssue
    ? { label: "存在异常", detail: "请查看下方异常连接", tone: "error" }
    : hasPendingConnection
      ? { label: "部分待连接", detail: "部分服务尚未就绪", tone: "warning" }
      : { label: "运行正常", detail: "所有已启用连接均可用", tone: "ready" };

  return (
    <div className={`${styles.pageSurface} ${styles.connectionDashboard}`}>
      {refreshError && <InlineError message="暂时无法更新连接状态，请稍后重试。" retry={() => void refresh()} />}

      <section className={styles.connectionHero} data-ai-region="connection-summary" aria-labelledby="connection-summary-title">
        <div className={styles.connectionHeroLead}>
          <span className={styles.connectionHeroIcon}><CloudCog size={24} aria-hidden="true" /></span>
          <div>
            <span>连接概况</span>
            <h2 id="connection-summary-title">3 条连接 · {availableConnections} 条可用</h2>
            <p>设备、车辆和智能中枢的实时连接状态</p>
          </div>
        </div>
        <div className={styles.connectionHeroMeta}>
          <ConnectionBadge health={overallHealth} />
          <span>
            最后检查
            <time dateTime={snapshot.generatedAt}>{formatTime(snapshot.generatedAt)}</time>
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={isRefreshing}
            aria-busy={isRefreshing}
          >
            <RefreshCw size={16} className={isRefreshing ? styles.spinning : undefined} aria-hidden="true" />
            {isRefreshing ? "检查中" : "重新检查"}
          </button>
        </div>
      </section>

      <section className={styles.connectionGrid} aria-label="连接状态">
        <ConnectionCard
          icon={snapshot.provider === "huawei-cloud" ? <Cloud size={22} aria-hidden="true" /> : <CloudCog size={22} aria-hidden="true" />}
          eyebrow="传感器数据"
          title={snapshot.provider === "huawei-cloud" ? "华为云 IoTDA" : "传感器接口未连接"}
          health={sensorHealth}
          className={styles.sensorConnectionCard}
          aiRegion="sensor-connection"
        >
          <dl className={styles.connectionFacts}>
            <div><dt>数据通道</dt><dd>{TELEMETRY_SLOT_IDS.length} 路</dd></div>
            <div><dt>最后设备上报</dt><dd><time dateTime={latestSensorReading ?? undefined}>{formatTime(latestSensorReading)}</time></dd></div>
          </dl>

          <ul className={styles.sensorChannelList} aria-label="六路传感器状态">
            {TELEMETRY_SLOT_IDS.map((slotId) => {
              const slot = snapshot.slots[slotId];
              const Icon = SLOT_ICONS[slotId];
              return (
                <li key={slotId}>
                  <span className={styles.sensorChannelIcon}><Icon size={17} aria-hidden="true" /></span>
                  <div className={styles.sensorChannelName}>
                    <strong>{slot.label}</strong>
                    <span className={`${styles.sensorChannelState} ${styles[`channelState_${slot.state}`]}`}>
                      <i aria-hidden="true" />{SLOT_STATE_DETAIL[slot.state] ?? STATE_LABELS[slot.state]}
                    </span>
                  </div>
                  <div className={styles.sensorChannelValue}>
                    <strong>{formatMetric(slot)}</strong>
                    {slot.unit && <span>{slot.unit}</span>}
                  </div>
                </li>
              );
            })}
          </ul>

          <ErrorDetails title="传感器读取异常" messages={sensorErrors} />
          <footer className={styles.connectionCardFooter}>
            <TransitionLink href="/monitoring">查看数据<ArrowRight size={15} aria-hidden="true" /></TransitionLink>
          </footer>
        </ConnectionCard>

        <ConnectionCard
          icon={<CarFront size={22} aria-hidden="true" />}
          eyebrow="小车控制"
          title="Jetson 小车"
          health={vehicleHealth}
          className={styles.vehicleConnectionCard}
          aiRegion="vehicle-connection"
        >
          <dl className={styles.connectionFacts}>
            <div><dt>连接状态</dt><dd>{vehicleHealth.label}</dd></div>
            <div><dt>最后回传</dt><dd><time dateTime={latestVehicleReading ?? undefined}>{formatTime(latestVehicleReading)}</time></dd></div>
          </dl>
          <ErrorDetails title="车辆回传异常" messages={vehicleErrors} />
          <footer className={styles.connectionCardFooter}>
            <TransitionLink
              href="/settings#jetson-connection-settings"
              aria-label="打开 Jetson 小车连接设置"
            >
              <Settings2 size={15} aria-hidden="true" />连接设置
            </TransitionLink>
          </footer>
        </ConnectionCard>

        <ConnectionCard
          icon={<Bot size={22} aria-hidden="true" />}
          eyebrow="智能服务"
          title="AI 智能中枢"
          health={aiHealth}
          className={styles.aiConnectionCard}
          aiRegion="ai-connection"
        >
          <dl className={styles.connectionFacts}>
            <div><dt>中枢状态</dt><dd>{aiHealth.label}</dd></div>
            <div><dt>运行位置</dt><dd>{androidStandalone ? "当前 Android 设备" : "当前电脑"}</dd></div>
          </dl>
          <footer className={styles.connectionCardFooter}>
            <TransitionLink
              href="/settings#ai-agent-settings"
              aria-label="打开 AI 智能中枢设置"
            >
              <Settings2 size={15} aria-hidden="true" />智能体设置
            </TransitionLink>
          </footer>
        </ConnectionCard>
      </section>
    </div>
  );
}
