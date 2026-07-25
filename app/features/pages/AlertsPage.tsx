"use client";

import {
  AlertTriangle,
  BellRing,
  Check,
  CheckCircle2,
  ChevronLeft,
  CircleDot,
  Clock3,
  RefreshCw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRoundCheck,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAiControl } from "@/app/features/ai/AiControlContext";
import {
  AI_ACTION_EVENT,
  registerActionReceiver,
  readActionDispatchDetail,
  reportActionError,
  reportActionSuccess,
} from "@/app/lib/ai/action-events";
import { useAuth } from "@/app/features/auth/AuthContext";
import { useIotDashboard } from "@/app/features/iot/use-iot-dashboard";
import { useAndroidBack } from "@/app/features/ui/useAndroidBack";
import {
  ALERT_ACTION_LABELS,
  type AlertAction,
  type AlertListFilters,
  type AlertRule,
  type AlertSeverity,
  type AlertWorkOrder,
  type AlertWorkOrderStatus,
} from "@/app/lib/alerts/contracts";
import type { AgentActionDispatchDetail } from "@/app/lib/ai/contracts";
import { TELEMETRY_SLOT_IDS, type TelemetrySlotId } from "@/app/lib/iot/contracts";
import styles from "./AlertsPage.module.css";

type AlertTab = AlertWorkOrderStatus | "rules";

const TAB_LABELS: Record<AlertTab, string> = {
  pending: "未处理",
  processing: "处理中",
  completed: "已完成",
  rules: "告警规则",
};

const SEVERITY_LABELS: Record<AlertSeverity, string> = {
  info: "提示",
  warning: "关注",
  critical: "严重",
};

const TIMELINE_LABELS = {
  created: "创建告警",
  "source-recovered": "数据源恢复",
  "processing-started": "开始处理",
  completed: "处理完成",
} as const;

export function AlertsPage() {
  const {
    connection,
    alerts,
    requestAlerts,
    requestAlertDetail,
    beginAlert,
    completeAlert,
    requestAlertRules,
    saveAlertRules,
    clearAlerts,
  } = useAiControl();
  const auth = useAuth();
  const { snapshot } = useIotDashboard();
  const [tab, setTab] = useState<AlertTab>("pending");
  const [severity, setSeverity] = useState<AlertSeverity | "all">("all");
  const [slotId, setSlotId] = useState<TelemetrySlotId | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [action, setAction] = useState<AlertAction>("site-inspection");
  const [note, setNote] = useState("");
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const pendingActionRef = useRef<AgentActionDispatchDetail | null>(null);
  const pendingLoadKindRef = useRef<"list" | "rules" | "detail" | null>(null);

  useAndroidBack(clearConfirmOpen || mobileDetailOpen, () => {
    if (clearConfirmOpen) setClearConfirmOpen(false);
    else setMobileDetailOpen(false);
  }, clearConfirmOpen ? 90 : 70);

  const actor = auth.profile?.displayName ?? auth.session?.user.displayName ?? auth.session?.user.username ?? "管理员";
  const filters = useMemo<AlertListFilters>(() => ({
    statuses: tab === "rules" ? undefined : [tab],
    severities: severity === "all" ? undefined : [severity],
    slotIds: slotId === "all" ? undefined : [slotId],
    limit: 300,
  }), [severity, slotId, tab]);

  const refresh = useCallback(() => {
    if (tab === "rules") return requestAlertRules();
    return requestAlerts(filters);
  }, [filters, requestAlertRules, requestAlerts, tab]);

  useEffect(() => { refresh(); }, [refresh]);
  const effectiveSelectedId = selectedId && alerts.list?.items.some((item) => item.id === selectedId)
    ? selectedId
    : alerts.list?.items[0]?.id ?? null;
  const effectiveListItem = alerts.list?.items.find((item) => item.id === effectiveSelectedId) ?? null;
  useEffect(() => {
    const detailIsStale = effectiveListItem
      && alerts.detail?.id === effectiveListItem.id
      && alerts.detail.version !== effectiveListItem.version;
    if (effectiveSelectedId && (alerts.detail?.id !== effectiveSelectedId || detailIsStale) && alerts.detailPhase !== "loading") {
      requestAlertDetail(effectiveSelectedId);
    }
  }, [alerts.detail?.id, alerts.detail?.version, alerts.detailPhase, effectiveListItem, effectiveSelectedId, requestAlertDetail]);

  useEffect(() => {
    const onAction = (event: Event) => {
      const next = readActionDispatchDetail(event);
      if (!next) return;
      if (next.name === "alerts.refresh") {
        pendingActionRef.current = next;
        pendingLoadKindRef.current = tab === "rules" ? "rules" : "list";
        if (!refresh()) {
          pendingActionRef.current = null;
          pendingLoadKindRef.current = null;
          reportActionError(next, "智能网关未连接，无法刷新告警。");
        }
        return;
      }
      if (next.name === "alerts.set_tab") {
        if (tab === next.arguments.tab) {
          reportActionSuccess(next, "告警标签已符合要求。");
          return;
        }
        pendingActionRef.current = next;
        setTab(next.arguments.tab);
        return;
      }
      if (next.name === "alerts.set_severity_filter") {
        if (severity === next.arguments.severity) {
          reportActionSuccess(next, "告警级别筛选已符合要求。");
          return;
        }
        pendingActionRef.current = next;
        setSeverity(next.arguments.severity);
        return;
      }
      if (next.name === "alerts.set_slot_filter") {
        if (slotId === next.arguments.slotId) {
          reportActionSuccess(next, "告警指标筛选已符合要求。");
          return;
        }
        pendingActionRef.current = next;
        setSlotId(next.arguments.slotId);
        return;
      }
      if (next?.name === "alerts.open_detail") {
        pendingActionRef.current = next;
        pendingLoadKindRef.current = "detail";
        setSelectedId(next.arguments.alertId);
        setMobileDetailOpen(true);
        if (!requestAlertDetail(next.arguments.alertId)) {
          pendingActionRef.current = null;
          pendingLoadKindRef.current = null;
          reportActionError(next, "智能网关未连接，无法读取告警详情。");
        }
      }
    };
    window.addEventListener(AI_ACTION_EVENT, onAction);
    const unregisterReceiver = registerActionReceiver([
      "alerts.refresh",
      "alerts.set_tab",
      "alerts.set_severity_filter",
      "alerts.set_slot_filter",
      "alerts.open_detail",
    ]);
    return () => {
      unregisterReceiver();
      window.removeEventListener(AI_ACTION_EVENT, onAction);
    };
  }, [refresh, requestAlertDetail, severity, slotId, tab]);

  useEffect(() => {
    const pending = pendingActionRef.current;
    if (!pending) return;
    if (pending.name === "alerts.set_tab" && tab === pending.arguments.tab) {
      pendingActionRef.current = null;
      reportActionSuccess(pending, "告警标签已切换。");
      return;
    }
    if (
      pending.name === "alerts.set_severity_filter"
      && severity === pending.arguments.severity
    ) {
      pendingActionRef.current = null;
      reportActionSuccess(pending, "告警级别筛选已更新。");
      return;
    }
    if (
      pending.name === "alerts.set_slot_filter"
      && slotId === pending.arguments.slotId
    ) {
      pendingActionRef.current = null;
      reportActionSuccess(pending, "告警指标筛选已更新。");
      return;
    }
    if (pending.name === "alerts.refresh") {
      if (pendingLoadKindRef.current === "rules") {
        if (alerts.rulesPhase === "ready") {
          pendingActionRef.current = null;
          pendingLoadKindRef.current = null;
          reportActionSuccess(pending, "告警规则已刷新。");
        } else if (alerts.rulesPhase === "error") {
          pendingActionRef.current = null;
          pendingLoadKindRef.current = null;
          reportActionError(pending, alerts.rulesError ?? "告警规则刷新失败。");
        }
      } else if (pendingLoadKindRef.current === "list") {
        if (alerts.listPhase === "ready") {
          pendingActionRef.current = null;
          pendingLoadKindRef.current = null;
          reportActionSuccess(pending, "告警列表已刷新。");
        } else if (alerts.listPhase === "error") {
          pendingActionRef.current = null;
          pendingLoadKindRef.current = null;
          reportActionError(pending, alerts.listError ?? "告警列表刷新失败。");
        }
      }
      return;
    }
    if (pending.name === "alerts.open_detail" && pendingLoadKindRef.current === "detail") {
      if (
        alerts.detailPhase === "ready"
        && alerts.detail?.id === pending.arguments.alertId
      ) {
        pendingActionRef.current = null;
        pendingLoadKindRef.current = null;
        reportActionSuccess(pending, "告警详情已打开。");
      } else if (alerts.detailPhase === "error") {
        pendingActionRef.current = null;
        pendingLoadKindRef.current = null;
        reportActionError(pending, alerts.detailError ?? "告警详情读取失败。");
      }
    }
  }, [
    alerts.detail?.id,
    alerts.detailError,
    alerts.detailPhase,
    alerts.listError,
    alerts.listPhase,
    alerts.rulesError,
    alerts.rulesPhase,
    severity,
    slotId,
    tab,
  ]);

  const selectAlert = (item: AlertWorkOrder) => {
    setSelectedId(item.id);
    setMobileDetailOpen(true);
    setNote("");
    requestAlertDetail(item.id);
  };

  const selected = alerts.detail?.id === effectiveSelectedId
    && (!effectiveListItem || alerts.detail.version === effectiveListItem.version)
    ? alerts.detail
    : effectiveListItem;
  const summary = alerts.list?.summary ?? { pending: 0, processing: 0, completed: 0, critical: 0 };
  const readOnly = connection !== "online" || alerts.readOnly;
  const rulesVersionKey = alerts.rules.length === 0
    ? "rules-loading"
    : alerts.rules.map((rule) => `${rule.slotId}:${rule.version}`).join("|");
  const alertCount = summary.pending + summary.processing + summary.completed;

  return (
    <div className={styles.page}>
      <section className={styles.summary} data-ai-region="alert-summary">
        <div className={styles.summaryLead}>
          <span className={styles.heroIcon}><BellRing size={23} /></span>
          <div><h2>告警概况</h2><p>{connection === "online" ? "记录环境异常与处理进度" : "智能网关未连接"}</p></div>
        </div>
        <SummaryMetric label="未处理" value={summary.pending} tone="orange" />
        <SummaryMetric label="处理中" value={summary.processing} tone="blue" />
        <SummaryMetric label="已完成" value={summary.completed} tone="green" />
        <SummaryMetric label="严重" value={summary.critical} tone="red" />
        <div className={styles.summaryActions}>
          <button type="button" className={styles.refreshButton} onClick={refresh} disabled={alerts.listPhase === "loading" || alerts.rulesPhase === "loading"}>
            <RefreshCw size={17} className={alerts.listPhase === "loading" || alerts.rulesPhase === "loading" ? styles.spinning : undefined} />
            重新检查
          </button>
          <button type="button" className={styles.clearButton} onClick={() => setClearConfirmOpen(true)} disabled={readOnly || alertCount === 0 || alerts.clearPhase === "loading"}>
            <Trash2 size={17} />清除告警记录
          </button>
        </div>
        {clearConfirmOpen && (
          <div className={styles.clearConfirm} role="alertdialog" aria-labelledby="clear-alerts-title" aria-describedby="clear-alerts-detail">
            <div><strong id="clear-alerts-title">清除全部告警记录？</strong><span id="clear-alerts-detail">现有告警和工单将被忽略，遥测历史与告警规则保持不变。</span></div>
            <button type="button" onClick={() => setClearConfirmOpen(false)}>取消</button>
            <button type="button" className={styles.confirmClearButton} onClick={() => {
              if (!clearAlerts(actor)) return;
              setClearConfirmOpen(false);
              setSelectedId(null);
              setMobileDetailOpen(false);
            }} disabled={alerts.clearPhase === "loading"}>{alerts.clearPhase === "loading" ? "正在清除" : "确认清除"}</button>
          </div>
        )}
      </section>
      {alerts.clearResult && alerts.clearPhase === "ready" && <p className={styles.clearSuccess} role="status"><CheckCircle2 size={16} />已清除 {alerts.clearResult.clearedCount} 条告警记录，旧告警不会重新出现。</p>}
      {alerts.clearError && <p className={styles.error} role="alert">{alerts.clearError}</p>}

      <div className={styles.toolbar}>
        <div className={styles.tabs} role="tablist">
          {(Object.keys(TAB_LABELS) as AlertTab[]).map((item) => (
            <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => { setTab(item); setMobileDetailOpen(false); }}>
              {TAB_LABELS[item]}
              {item !== "rules" && summary[item] > 0 && <span>{summary[item]}</span>}
            </button>
          ))}
        </div>
        {tab !== "rules" && (
          <div className={styles.filters}>
            <SlidersHorizontal size={16} />
            <select aria-label="按严重程度筛选" value={severity} onChange={(event) => setSeverity(event.target.value as AlertSeverity | "all")}>
              <option value="all">全部级别</option>
              <option value="critical">严重</option><option value="warning">关注</option><option value="info">提示</option>
            </select>
            <select aria-label="按指标筛选" value={slotId} onChange={(event) => setSlotId(event.target.value as TelemetrySlotId | "all")}>
              <option value="all">全部指标</option>
              {TELEMETRY_SLOT_IDS.map((id) => <option key={id} value={id}>{snapshot.slots[id].label}</option>)}
            </select>
          </div>
        )}
      </div>

      {tab === "rules" ? (
        <RulesPanel
          key={rulesVersionKey}
          rules={alerts.rules}
          slots={snapshot.slots}
          readOnly={readOnly}
          saving={alerts.rulesPhase === "saving"}
          error={alerts.rulesError}
          onSave={(rules) => saveAlertRules(rules, actor)}
        />
      ) : (
        <section key={tab} className={`${styles.workspace} ${styles.viewEnter}${mobileDetailOpen ? ` ${styles.mobileShowingDetail}` : ""}`}>
          <div className={styles.alertList} data-ai-region="alert-list">
            {readOnly && <div className={styles.offlineNotice}><WifiOff size={17} /><span>当前为只读状态</span></div>}
            {alerts.listPhase === "loading" && !alerts.list && <LoadingRows />}
            {alerts.listError && !alerts.list && <EmptyState icon={<WifiOff />} title="暂时无法读取告警" detail={alerts.listError} />}
            {alerts.listPhase !== "loading" && alerts.list?.items.length === 0 && <EmptyState icon={<ShieldCheck />} title={`暂无${TAB_LABELS[tab]}`} detail="系统会在发现异常时自动记录" />}
            {alerts.list?.items.map((item) => (
              <button key={item.id} type="button" className={`${styles.alertItem}${effectiveSelectedId === item.id ? ` ${styles.alertItemActive}` : ""}`} onClick={() => selectAlert(item)}>
                <span className={`${styles.severityDot} ${styles[`severity_${item.severity}`]}`} />
                <span className={styles.alertItemBody}>
                  <span><strong>{item.title}</strong><time>{formatRelative(item.createdAt)}</time></span>
                  <small>{item.detail}</small>
                  <span className={styles.itemMeta}>
                    <i className={styles[`source_${item.sourceState}`]}>{item.sourceState === "resolved" ? "数据已恢复" : "异常持续"}</i>
                    {item.slotId && <i>{snapshot.slots[item.slotId].label}</i>}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div className={styles.detail} data-ai-region="alert-detail">
            <button type="button" className={styles.mobileBack} onClick={() => setMobileDetailOpen(false)}><ChevronLeft size={18} />返回列表</button>
            {!selected && <EmptyState icon={<BellRing />} title="选择一条告警" detail="查看证据与处理进度" />}
            {selected && <AlertDetail
              item={selected}
              slotLabel={selected.slotId ? snapshot.slots[selected.slotId].label : "系统"}
              readOnly={readOnly}
              saving={alerts.detailPhase === "saving"}
              error={alerts.detailError}
              action={action}
              note={note}
              onAction={setAction}
              onNote={setNote}
              onBegin={() => beginAlert(selected.id, selected.version, actor)}
              onComplete={() => completeAlert(selected.id, selected.version, actor, action, note)}
            />}
          </div>
        </section>
      )}
    </div>
  );
}

function SummaryMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`${styles.summaryMetric} ${styles[`metric_${tone}`]}`}><strong>{value}</strong><span>{label}</span></div>;
}

function AlertDetail({ item, slotLabel, readOnly, saving, error, action, note, onAction, onNote, onBegin, onComplete }: {
  item: AlertWorkOrder; slotLabel: string; readOnly: boolean; saving: boolean; error: string | null;
  action: AlertAction; note: string; onAction: (value: AlertAction) => void; onNote: (value: string) => void;
  onBegin: () => void; onComplete: () => void;
}) {
  return <article className={styles.detailCard}>
    <header className={styles.detailHeader}>
      <span className={`${styles.detailIcon} ${styles[`severity_${item.severity}`]}`}><AlertTriangle size={21} /></span>
      <div><span>{SEVERITY_LABELS[item.severity]}告警 · {slotLabel}</span><h2>{item.title}</h2></div>
      <StatusBadge status={item.status} />
    </header>
    <p className={styles.detailText}>{item.detail}</p>
    <dl className={styles.detailFacts}>
      <div><dt>开始时间</dt><dd>{formatDateTime(item.createdAt)}</dd></div>
      <div><dt>数据状态</dt><dd>{item.sourceState === "resolved" ? `已于 ${formatDateTime(item.recoveredAt)} 恢复` : "异常仍在持续"}</dd></div>
      <div><dt>处理人</dt><dd>{item.assignee ?? "尚未分配"}</dd></div>
      <div><dt>工单状态</dt><dd>{TAB_LABELS[item.status]}</dd></div>
    </dl>
    {Object.keys(item.evidence).length > 0 && <section className={styles.evidence}><h3>相关证据</h3><div>{Object.entries(item.evidence).map(([key, value]) => <span key={key}><small>{evidenceLabel(key)}</small><strong>{String(value)}</strong></span>)}</div></section>}
    <section className={styles.timeline} data-ai-region="alert-timeline">
      <h3>处理进度</h3>
      {item.timeline.map((entry) => <div key={entry.id}><span><CircleDot size={13} /></span><p><strong>{TIMELINE_LABELS[entry.type]}</strong><small>{entry.detail}</small><time>{formatDateTime(entry.timestamp)}{entry.actor ? ` · ${entry.actor}` : ""}</time></p></div>)}
    </section>
    {item.status === "pending" && <button type="button" className={styles.primaryAction} disabled={readOnly || saving} onClick={onBegin}><UserRoundCheck size={18} />开始处理</button>}
    {item.status === "processing" && <section className={styles.handleForm}>
      <h3>完成工单</h3>
      <label>处理方式<select value={action} onChange={(event) => onAction(event.target.value as AlertAction)}>{Object.entries(ALERT_ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>处理说明<textarea value={note} maxLength={500} placeholder="记录已完成的检查或处理" onChange={(event) => onNote(event.target.value)} /></label>
      <button type="button" className={styles.primaryAction} disabled={readOnly || saving || note.trim().length < 2} onClick={onComplete}><CheckCircle2 size={18} />确认完成</button>
    </section>}
    {item.status === "completed" && <div className={styles.completion}><Check size={18} /><span><strong>{item.action ? ALERT_ACTION_LABELS[item.action] : "处理完成"}</strong><small>{item.note}</small></span></div>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </article>;
}

function RulesPanel({ rules, slots, readOnly, saving, error, onSave }: {
  rules: AlertRule[]; slots: ReturnType<typeof useIotDashboard>["snapshot"]["slots"];
  readOnly: boolean; saving: boolean; error: string | null; onSave: (rules: AlertRule[]) => void;
}) {
  const [drafts, setDrafts] = useState(() => rules.map((rule) => ({ ...rule })));
  const update = (slotId: TelemetrySlotId, change: Partial<AlertRule>) => setDrafts((current) => current.map((rule) => rule.slotId === slotId ? { ...rule, ...change } : rule));
  const invalid = drafts.some((rule) => rule.enabled && rule.lowerLimit === null && rule.upperLimit === null)
    || drafts.some((rule) => rule.lowerLimit !== null && rule.upperLimit !== null && rule.lowerLimit >= rule.upperLimit);
  return <section className={`${styles.rules} ${styles.viewEnter}`} data-ai-region="alert-rules">
    <header><div><h2>阈值规则</h2><p>连续两次越界后创建告警，连续两次恢复后标记数据源已恢复</p></div><button type="button" className={styles.saveButton} disabled={readOnly || saving || invalid || drafts.length !== TELEMETRY_SLOT_IDS.length} onClick={() => onSave(drafts)}><Save size={17} />{saving ? "保存中" : "保存规则"}</button></header>
    <div className={styles.ruleGrid}>{drafts.map((rule) => <article key={rule.slotId}>
        <div><span><strong>{slots[rule.slotId].label}</strong><small>{slots[rule.slotId].unit || "数值"}</small></span><label className={styles.switch}><input type="checkbox" checked={rule.enabled} disabled={readOnly} onChange={(event) => update(rule.slotId, { enabled: event.target.checked })} /><i /></label></div>
      <div className={styles.limitFields}>
        <label>下限<input type="number" value={rule.lowerLimit ?? ""} placeholder="不设置" disabled={readOnly} onChange={(event) => update(rule.slotId, { lowerLimit: event.target.value === "" ? null : Number(event.target.value) })} /></label>
        <label>上限<input type="number" value={rule.upperLimit ?? ""} placeholder="不设置" disabled={readOnly} onChange={(event) => update(rule.slotId, { upperLimit: event.target.value === "" ? null : Number(event.target.value) })} /></label>
      </div>
    </article>)}</div>
    {invalid && <p className={styles.error}>启用规则时至少填写一个阈值，且下限必须小于上限。</p>}
    {error && <p className={styles.error}>{error}</p>}
  </section>;
}

function StatusBadge({ status }: { status: AlertWorkOrderStatus }) {
  const Icon = status === "completed" ? CheckCircle2 : status === "processing" ? Clock3 : BellRing;
  return <span className={`${styles.statusBadge} ${styles[`status_${status}`]}`}><Icon size={14} />{TAB_LABELS[status]}</span>;
}

function LoadingRows() { return <div className={styles.loadingRows}>{[0, 1, 2].map((item) => <i key={item} />)}</div>; }
function EmptyState({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) { return <div className={styles.empty}>{icon}<strong>{title}</strong><span>{detail}</span></div>; }
function formatDateTime(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function formatRelative(value: string) { const ms = Date.now() - Date.parse(value); if (ms < 60_000) return "刚刚"; if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`; if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`; return new Date(value).toLocaleDateString("zh-CN"); }
function evidenceLabel(key: string) { return ({ value: "观测值", lowerLimit: "规则下限", upperLimit: "规则上限", state: "数据状态" } as Record<string, string>)[key] ?? key; }
