import type {
  AgentAction,
  AgentActionDispatchDetail,
  AgentActionExecutionMetadata,
  AgentActionResultDetail,
} from "./contracts";

export const AI_ACTION_EVENT = "xingxun:ai-action";
export const AI_ACTION_RESULT_EVENT = "xingxun:ai-action-result";

type AgentActionName = AgentAction["name"];
type ReceiverWaiter = (ready: boolean) => void;

const actionReceiverCounts = new Map<AgentActionName, number>();
const actionReceiverWaiters = new Map<AgentActionName, Set<ReceiverWaiter>>();

function notifyActionReceiverReady(name: AgentActionName) {
  const waiters = actionReceiverWaiters.get(name);
  if (!waiters) return;
  actionReceiverWaiters.delete(name);
  for (const resolve of waiters) resolve(true);
}

/**
 * Registers the action names handled by a mounted UI listener. The registry
 * makes cross-page dispatch durable: the Agent waits for the destination
 * listener instead of dropping a one-shot CustomEvent during route mounting.
 */
export function registerActionReceiver(names: readonly AgentActionName[]) {
  const uniqueNames = [...new Set(names)];
  for (const name of uniqueNames) {
    actionReceiverCounts.set(name, (actionReceiverCounts.get(name) ?? 0) + 1);
    notifyActionReceiverReady(name);
  }

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    for (const name of uniqueNames) {
      const nextCount = (actionReceiverCounts.get(name) ?? 0) - 1;
      if (nextCount > 0) actionReceiverCounts.set(name, nextCount);
      else actionReceiverCounts.delete(name);
    }
  };
}

export function isActionReceiverReady(name: AgentActionName) {
  return (actionReceiverCounts.get(name) ?? 0) > 0;
}

export function waitForActionReceiver(name: AgentActionName, timeoutMs: number) {
  if (isActionReceiverReady(name)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let waiters = actionReceiverWaiters.get(name);
    if (!waiters) {
      waiters = new Set();
      actionReceiverWaiters.set(name, waiters);
    }
    let settled = false;
    const finish: ReceiverWaiter = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const current = actionReceiverWaiters.get(name);
      current?.delete(finish);
      if (current?.size === 0) actionReceiverWaiters.delete(name);
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    waiters.add(finish);
    if (isActionReceiverReady(name)) finish(true);
  });
}

export function createActionDispatchDetail(
  action: AgentAction,
  metadata: AgentActionExecutionMetadata,
): AgentActionDispatchDetail {
  return {
    ...action,
    ...metadata,
  } as AgentActionDispatchDetail;
}

export function readActionDispatchDetail(event: Event): AgentActionDispatchDetail | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return null;
  const candidate = detail as Partial<AgentActionDispatchDetail>;
  return typeof candidate.name === "string" && candidate.arguments && typeof candidate.arguments === "object"
    ? candidate as AgentActionDispatchDetail
    : null;
}

export function reportActionSuccess(
  detail: AgentActionDispatchDetail,
  message = "页面动作已生效。",
) {
  return reportActionResult(detail, "success", message);
}

export function reportActionError(
  detail: AgentActionDispatchDetail,
  error: unknown,
  fallback = "页面动作执行失败。",
) {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string" && error.trim()
      ? error.trim()
      : fallback;
  return reportActionResult(detail, "error", message);
}

export function reportActionResult(
  detail: AgentActionDispatchDetail,
  status: AgentActionResultDetail["status"],
  message: string,
) {
  if (!detail.actionExecutionId) return false;
  const result: AgentActionResultDetail = {
    requestId: detail.requestId ?? null,
    planId: detail.planId ?? null,
    stepIndex: Number.isSafeInteger(detail.stepIndex) ? detail.stepIndex : 0,
    actionExecutionId: detail.actionExecutionId,
    actionName: detail.name,
    status,
    message,
    completedAt: new Date().toISOString(),
  };
  window.dispatchEvent(new CustomEvent<AgentActionResultDetail>(AI_ACTION_RESULT_EVENT, {
    detail: result,
  }));
  return true;
}

/**
 * A watchdog only: actions complete exclusively through `action.result`.
 * Longer operations receive enough time for the real backend/animation result.
 */
export function pageActionTimeoutMs(action: AgentAction) {
  if (action.name === "monitoring.generate_analysis") return 210_000;
  if (action.name === "settings.save") return 30_000;
  if (
    action.name === "overview.refresh"
    || action.name === "monitoring.refresh"
    || action.name === "connections.refresh"
    || action.name === "alerts.refresh"
    || action.name === "alerts.open_detail"
  ) return 20_000;
  if (action.name === "twin.orbit") return action.arguments.durationMs + 8_000;
  if (action.name.startsWith("twin.")) return 12_000;
  // Analysis views can still be committing charts when the focus action starts.
  // The gateway now pauses this watchdog while an action is intentionally
  // queued behind the user's step-by-step evidence guide.
  if (action.name === "ui.focus_region") return 15_000;
  if (action.name === "monitoring.set_tab" && action.arguments.tab === "analysis") return 15_000;
  if (action.name === "ui.navigate" || action.name === "ui.back") return 8_000;
  return 6_000;
}
