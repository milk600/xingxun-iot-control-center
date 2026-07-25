"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  BatteryCharging,
  Box,
  CarFront,
  CircleCheck,
  Compass,
  Expand,
  Focus,
  Flame,
  Gauge,
  History,
  LocateFixed,
  Octagon,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Signal,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import {
  AI_ACTION_EVENT,
  registerActionReceiver,
  readActionDispatchDetail,
  reportActionError,
  reportActionSuccess,
} from "@/app/lib/ai/action-events";
import { TELEMETRY_SLOT_IDS } from "@/app/lib/iot/contracts";
import { useIotDashboard } from "@/app/features/iot/use-iot-dashboard";
import { TransitionLink } from "@/app/features/transitions/NavigationTransition";
import {
  EmptyState,
  InlineError,
  MetricCard,
  StatusPill,
  formatTime,
} from "./PagePrimitives";
import { useSessionTelemetry } from "./useSessionTelemetry";
import styles from "./Pages.module.css";

export function OverviewPage() {
  const {
    snapshot,
    isRefreshing,
    refreshError,
    refresh,
    sendCommand,
    commandLog,
  } = useIotDashboard();
  const { points } = useSessionTelemetry(snapshot, 80);
  const slots = useMemo(() => TELEMETRY_SLOT_IDS.map((slotId) => snapshot.slots[slotId]), [snapshot.slots]);
  const vehicle = snapshot.vehicle;
  const vehicleTelemetryLive = vehicle.connection === "online";
  const vehicleLinkConnected = vehicle.controlLink === "connected";
  const vehicleStatusState = vehicleTelemetryLive
    ? "online"
    : vehicleLinkConnected || vehicle.controlLink === "connecting"
      ? "warning"
      : "offline";
  const vehicleStatusLabel = vehicleTelemetryLive
    ? "回传正常"
    : vehicleLinkConnected
      ? "等待车辆回传"
      : vehicle.controlLink === "connecting"
        ? "正在连接"
        : vehicle.controlLink === "disabled"
          ? "未启用"
          : "链路断开";

  useEffect(() => {
    const handleAction = (event: Event) => {
      const action = readActionDispatchDetail(event);
      if (action?.name !== "overview.refresh") return;
      void refresh().then((ok) => {
        if (ok) reportActionSuccess(action, "概览数据已刷新。");
        else reportActionError(action, "概览数据刷新失败，请检查数据连接。");
      }).catch((error) => reportActionError(action, error, "概览数据刷新失败。"));
    };
    window.addEventListener(AI_ACTION_EVENT, handleAction);
    const unregisterReceiver = registerActionReceiver(["overview.refresh"]);
    return () => {
      unregisterReceiver();
      window.removeEventListener(AI_ACTION_EVENT, handleAction);
    };
  }, [refresh]);

  return (
    <div className={styles.pageSurface}>
      <div className={styles.pageActionBar}>
        <button className={styles.headerButton} type="button" onClick={() => void refresh()} disabled={isRefreshing}>
          <RefreshCw size={16} className={isRefreshing ? styles.spinning : undefined} />
          <span>刷新数据</span>
        </button>
      </div>
      {refreshError && <InlineError message={refreshError} retry={() => void refresh()} />}

      <section className={styles.metricGrid} data-ai-region="telemetry" aria-label="六路物联网遥测">
        {slots.map((slot) => <MetricCard key={slot.slotId} slot={slot} points={points} />)}
      </section>

      <section className={styles.overviewHero}>
        <article className={`${styles.card} ${styles.spatialCard}`} data-ai-region="spatial-overview">
          <header className={styles.cardHeaderOnDark}>
            <div>
              <h2>房间 01 · 空间态势</h2>
            </div>
            <div className={styles.darkCardActions}>
              <button type="button" aria-label="定位房间中心" title="定位房间中心"><Focus size={17} /></button>
              <TransitionLink href="/digital-twin" aria-label="进入全屏空间孪生"><Expand size={17} /></TransitionLink>
            </div>
          </header>

          <div className={styles.spatialCanvas}>
            <div className={styles.sceneGrid} aria-hidden="true" />
            <div className={styles.roomWireframe} aria-hidden="true">
              <span className={styles.wallTop} />
              <span className={styles.wallLeft} />
              <span className={styles.bedBlock} />
              <span className={styles.deskBlock} />
              <span className={styles.shelfBlock} />
              <i className={styles.anchorOne} />
              <i className={styles.anchorTwo} />
              <i className={styles.anchorThree} />
            </div>
            <div className={styles.sceneStatus}>
              <span><i aria-hidden="true" /> 场景入口就绪</span>
              <strong>彩色去屋顶点云</strong>
            </div>
            <div className={styles.axisBadge}><span>X</span><span>Y</span><span>Z</span></div>
            <div className={styles.sceneScale}>0&nbsp;&nbsp;&nbsp;1&nbsp;&nbsp;&nbsp;2 m</div>
          </div>

          <footer className={styles.spatialFooter}>
            <div><Box size={16} /><span><strong>彩色点云 · 开放屋顶</strong></span></div>
            <div><ScanLine size={16} /><span><strong>图层与诊断工具</strong></span></div>
            <TransitionLink href="/digital-twin">进入空间工作台 <ArrowUpRight size={16} /></TransitionLink>
          </footer>
        </article>

        <aside className={`${styles.card} ${styles.vehicleSummary}`} data-ai-region="vehicle-status">
          <header className={styles.cardHeader}>
            <div><h2>巡检车状态</h2></div>
            <StatusPill state={vehicleStatusState}>{vehicleStatusLabel}</StatusPill>
          </header>

          <div className={styles.vehicleDial}>
            <span className={styles.dialRingOne} />
            <span className={styles.dialRingTwo} />
            {vehicle.headingDeg !== null && <span className={styles.vehicleArrow} style={{ transform: `rotate(${vehicle.headingDeg}deg)` }}><LocateFixed size={25} /></span>}
            <div><strong>{vehicleTelemetryLive ? `${vehicle.speedPercent}%` : "--"}</strong><small>{vehicleTelemetryLive ? "轮速比例" : "暂无回传"}</small></div>
          </div>

          <div className={styles.compactStats}>
            <div title={vehicle.powerTelemetry.state === "live" ? "UPS 电源数据实时" : vehicle.powerTelemetry.state === "stale" ? "UPS 电源数据已过期" : "UPS 电源数据未连接"}><BatteryCharging /><span>电量{vehicle.powerTelemetry.state === "stale" ? "·过期" : ""}</span><strong>{vehicle.batteryPercent ?? "未接入"}{vehicle.batteryPercent !== null && <small>%</small>}</strong></div>
            <div><Gauge /><span>障碍距离</span><strong>{vehicle.obstacleDistanceCm ?? "未接入"}{vehicle.obstacleDistanceCm !== null && <small>cm</small>}</strong></div>
            <div><Signal /><span>信号</span><strong>{vehicle.signalDbm ?? "未接入"}{vehicle.signalDbm !== null && <small>dBm</small>}</strong></div>
            <div><Compass /><span>航向</span><strong>{vehicle.headingDeg ?? "未接入"}{vehicle.headingDeg !== null && <small>°</small>}</strong></div>
            <div className={vehicle.fireDetection.state === "live" && vehicle.fireDetection.detected ? styles.fireStatCritical : undefined}>
              <Flame />
              <span>火焰检测</span>
              <strong>{vehicle.fireDetection.state !== "live"
                ? vehicle.fireDetection.state === "stale" ? "已过期" : "未上报"
                : vehicle.fireDetection.detected ? "检测到火焰" : "正常"}</strong>
            </div>
          </div>

          <div className={styles.vehicleActionRow}>
            <TransitionLink href="/vehicle"><CarFront size={16} />打开遥控台</TransitionLink>
            <button type="button" onClick={() => void sendCommand("stop", 0)}><Octagon size={16} />立即停止</button>
          </div>
          <p className={styles.observedAt}><Wifi size={13} />最后回传：{formatTime(vehicle.observedAt)}</p>
        </aside>
      </section>

      <section className={styles.overviewLower}>
        <article className={`${styles.card} ${styles.eventCard}`} data-ai-region="recent-events">
          <header className={styles.cardHeader}>
            <div><h2>实时事件</h2></div>
            <TransitionLink href="/alerts">告警管理</TransitionLink>
          </header>
          {snapshot.partialErrors.length === 0 && commandLog.length === 0 && vehicle.fireDetection.detected !== true ? (
            <EmptyState icon={History} title="当前没有事件" detail="系统运行正常，新的异常或操作记录会显示在这里。" />
          ) : (
            <ul className={styles.eventList}>
              {vehicle.fireDetection.detected === true && (
                <li>
                  <span className={styles.eventCritical}><Flame size={16} /></span>
                  <div><strong>车辆画面检测到火焰</strong><p>请立即核查现场，告警中心正在记录本次火情。</p></div>
                  <time>{formatTime(vehicle.fireDetection.observedAt)}</time>
                </li>
              )}
              {snapshot.partialErrors.map((error, index) => (
                <li key={`${error.scope}-${index}`}><span className={styles.eventWarn}><AlertTriangle size={16} /></span><div><strong>{error.scope === "vehicle" ? "小车连接异常" : "传感器数据异常"}</strong><p>{error.scope === "vehicle" ? "暂时无法获取小车状态，请检查连接设置。" : "暂时无法读取部分传感器数据，请稍后重试。"}</p></div><time>当前</time></li>
              ))}
              {commandLog.map((item) => (
                <li key={item.requestId}><span className={item.status === "rejected" ? styles.eventWarn : styles.eventOk}>{item.status === "rejected" ? <AlertTriangle size={16} /> : <CircleCheck size={16} />}</span><div><strong>车辆指令 · {item.motion}</strong><p>{item.message}</p></div><time>{formatTime(item.acknowledgedAt)}</time></li>
              ))}
            </ul>
          )}
          <footer className={`${styles.healthStrip}${vehicle.fireDetection.detected === true ? ` ${styles.healthStripCritical}` : ""}`}>
            {vehicle.fireDetection.detected === true ? <Flame size={18} /> : <ShieldCheck size={18} />}
            <span><strong>{vehicle.fireDetection.detected === true ? "检测到火焰" : "系统健康"}</strong><small>{vehicle.fireDetection.detected === true ? "请立即核查现场" : "数据与控制连接"}</small></span>
            <span className={styles.healthValue}>{vehicle.fireDetection.detected === true ? "严重告警" : refreshError ? "部分异常" : "正常"}</span>
          </footer>
        </article>
      </section>

    </div>
  );
}
