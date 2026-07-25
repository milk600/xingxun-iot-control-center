import WebSocket from "ws";

export type JetsonControlState =
  | "started"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped";

export interface JetsonControlStatus {
  type: "control";
  version?: number;
  ts?: number;
  request_id: string;
  kind: string;
  state: JetsonControlState;
  [key: string]: unknown;
}

export type JetsonNavigationState =
  | "planning"
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped";

export interface JetsonNavigationStatus {
  type: "navigation";
  version?: number;
  ts?: number;
  request_id: string;
  state: JetsonNavigationState;
  task_id?: string;
  estimated_seconds?: number;
  elapsed_ms?: number;
  [key: string]: unknown;
}

export interface JetsonNavigationCommand {
  requestId: string;
  mapRevision: number;
  start: { x: number; y: number; headingDeg: number };
  goal: { x: number; y: number };
}

export type JetsonClosedLoopCommand =
  | {
      cmd: "move_distance";
      request_id: string;
      direction: "forward" | "backward";
      distance_mm: number;
      max_speed_mmps: number;
      timeout_s: number;
    }
  | {
      cmd: "turn_angle";
      request_id: string;
      direction: "left" | "right";
      angle_deg: number;
      max_speed_mmps: number;
      timeout_s: number;
    };

interface StatusWaiter {
  accept: ReadonlySet<JetsonControlState>;
  resolve: (status: JetsonControlStatus) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface StatusWaitHandle {
  promise: Promise<JetsonControlStatus>;
  cancel: (error: Error) => void;
}

interface NavigationWaiter {
  accept: ReadonlySet<JetsonNavigationState>;
  resolve: (status: JetsonNavigationStatus) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface NavigationWaitHandle {
  promise: Promise<JetsonNavigationStatus>;
  cancel: (error: Error) => void;
}

export class JetsonControlError extends Error {
  constructor(
    message: string,
    readonly status?: JetsonControlStatus | JetsonNavigationStatus,
  ) {
    super(message);
    this.name = "JetsonControlError";
  }
}

export class JetsonControlClient {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private activeClosedLoopRequestId: string | null = null;
  private activeTimedRequestId: string | null = null;
  private activeNavigationRequestId: string | null = null;
  private readonly waiters = new Map<string, Set<StatusWaiter>>();
  private readonly navigationWaiters = new Map<string, Set<NavigationWaiter>>();

  constructor(
    private readonly url: string,
    private readonly onStatus?: (status: JetsonControlStatus | JetsonNavigationStatus) => void,
  ) {}

  async executeClosedLoop(command: JetsonClosedLoopCommand) {
    if (this.activeClosedLoopRequestId || this.activeTimedRequestId || this.activeNavigationRequestId) {
      throw new JetsonControlError("已有车辆任务正在执行");
    }
    this.activeClosedLoopRequestId = command.request_id;
    const terminal = this.waitForStatus(
      command.request_id,
      new Set(["completed", "failed", "cancelled", "stopped"]),
      Math.ceil((command.timeout_s + 10) * 1000),
    );
    try {
      try {
        await this.sendJson(command);
      } catch (error) {
        terminal.cancel(asControlError(error));
        throw error;
      }
      const status = await terminal.promise;
      if (status.state === "completed") return status;
      throw statusError(status);
    } catch (error) {
      const terminalState = error instanceof JetsonControlError ? error.status?.state : undefined;
      if (this.activeClosedLoopRequestId === command.request_id
        && terminalState !== "cancelled"
        && terminalState !== "stopped") {
        try {
          await this.stop(command.request_id);
        } catch {
          // The original command error remains the useful result. The gateway
          // reports stop failures independently when an explicit stop is used.
        }
      }
      throw error;
    } finally {
      if (this.activeClosedLoopRequestId === command.request_id) {
        this.activeClosedLoopRequestId = null;
      }
    }
  }

  async executeTimedMove(speeds: readonly number[], durationMs: number) {
    if (this.activeClosedLoopRequestId || this.activeTimedRequestId || this.activeNavigationRequestId) {
      throw new JetsonControlError("已有车辆任务正在执行");
    }
    const requestId = `agent-timed-${crypto.randomUUID()}`;
    this.activeTimedRequestId = requestId;
    try {
      await this.sendJson({ cmd: "move", request_id: requestId, speeds: [...speeds] });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, durationMs);
        timer.unref();
      });
      const stopped = await this.stop(requestId);
      return { requestId, stopped };
    } finally {
      if (this.activeTimedRequestId === requestId) this.activeTimedRequestId = null;
    }
  }

  async executeNavigation(command: JetsonNavigationCommand) {
    if (this.activeClosedLoopRequestId || this.activeTimedRequestId || this.activeNavigationRequestId) {
      throw new JetsonControlError("已有车辆任务正在执行");
    }
    this.activeNavigationRequestId = command.requestId;
    let taskId: string | null = null;
    const planned = this.waitForNavigationStatus(
      command.requestId,
      new Set(["planned", "failed", "cancelled", "stopped"]),
      30_000,
    );
    try {
      try {
        await this.sendJson({
          cmd: "navigation_plan",
          request_id: command.requestId,
          map_revision: command.mapRevision,
          start: {
            x: command.start.x,
            y: command.start.y,
            heading_deg: normalizeNavigationHeading(command.start.headingDeg),
          },
          goal: command.goal,
        });
      } catch (error) {
        planned.cancel(asControlError(error));
        throw error;
      }
      const planStatus = await planned.promise;
      if (planStatus.state !== "planned") throw navigationStatusError(planStatus);
      taskId = typeof planStatus.task_id === "string" ? planStatus.task_id : null;
      if (!taskId) throw new JetsonControlError("Jetson 路线规划回执缺少 task_id");
      const estimatedSeconds = typeof planStatus.estimated_seconds === "number"
        && Number.isFinite(planStatus.estimated_seconds)
        ? planStatus.estimated_seconds
        : 60;
      const terminal = this.waitForNavigationStatus(
        command.requestId,
        new Set(["completed", "failed", "cancelled", "stopped"]),
        Math.max(90_000, Math.ceil((estimatedSeconds * 3 + 30) * 1000)),
      );
      try {
        await this.sendJson({
          cmd: "navigation_start",
          request_id: `agent-navigation-start-${crypto.randomUUID()}`,
          task_id: taskId,
        });
      } catch (error) {
        terminal.cancel(asControlError(error));
        throw error;
      }
      const status = await terminal.promise;
      if (status.state === "completed") return status;
      throw navigationStatusError(status);
    } catch (error) {
      if (taskId) {
        try {
          await this.sendJson({
            cmd: "navigation_cancel",
            request_id: `agent-navigation-cancel-${crypto.randomUUID()}`,
            task_id: taskId,
          });
        } catch {
          // Preserve the original planning/execution error.
        }
      }
      throw error;
    } finally {
      if (this.activeNavigationRequestId === command.requestId) this.activeNavigationRequestId = null;
    }
  }

  async stop(requestId = this.activeClosedLoopRequestId ?? `agent-stop-${crypto.randomUUID()}`) {
    const terminal = this.waitForStatus(
      requestId,
      new Set(["stopped", "failed"]),
      6_000,
    );
    try {
      await this.sendJson({ cmd: "stop", request_id: requestId });
    } catch (error) {
      terminal.cancel(asControlError(error));
      throw error;
    }
    const status = await terminal.promise;
    if (status.state === "stopped") return status;
    throw statusError(status);
  }

  async close() {
    this.rejectAll(new JetsonControlError("Jetson 控制连接已关闭"));
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      socket.once("close", finish);
      socket.close(1000, "gateway shutdown");
      timer = setTimeout(() => {
        socket.terminate();
        finish();
      }, 1_000);
      timer.unref();
    });
  }

  private async sendJson(payload: unknown) {
    const socket = await this.open();
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(payload), (error) => {
        if (error) reject(new JetsonControlError(`Jetson 命令发送失败：${error.message}`));
        else resolve();
      });
    });
  }

  private open() {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.url, { handshakeTimeout: 12_000 });
      const fail = (error: Error) => {
        if (this.socket === socket) this.socket = null;
        reject(new JetsonControlError(`Jetson 连接失败：${error.message}`));
      };
      socket.once("open", () => {
        this.socket = socket;
        resolve(socket);
      });
      socket.once("error", fail);
      socket.on("message", (raw) => this.handleMessage(raw));
      socket.on("close", () => {
        if (this.socket === socket) this.socket = null;
        this.rejectAll(new JetsonControlError("Jetson 控制连接已断开"));
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private handleMessage(raw: WebSocket.RawData) {
    const text = raw.toString();
    const status = parseJetsonControlStatus(text);
    if (status) {
      this.onStatus?.(status);
      const requestWaiters = this.waiters.get(status.request_id);
      if (!requestWaiters) return;
      for (const waiter of [...requestWaiters]) {
        if (!waiter.accept.has(status.state)) continue;
        clearTimeout(waiter.timer);
        requestWaiters.delete(waiter);
        waiter.resolve(status);
      }
      if (!requestWaiters.size) this.waiters.delete(status.request_id);
      return;
    }
    const navigationStatus = parseJetsonNavigationStatus(text);
    if (!navigationStatus) return;
    this.onStatus?.(navigationStatus);
    const navigationRequestWaiters = this.navigationWaiters.get(navigationStatus.request_id);
    if (!navigationRequestWaiters) return;
    for (const waiter of [...navigationRequestWaiters]) {
      if (!waiter.accept.has(navigationStatus.state)) continue;
      clearTimeout(waiter.timer);
      navigationRequestWaiters.delete(waiter);
      waiter.resolve(navigationStatus);
    }
    if (!navigationRequestWaiters.size) this.navigationWaiters.delete(navigationStatus.request_id);
  }

  private waitForStatus(
    requestId: string,
    accept: ReadonlySet<JetsonControlState>,
    timeoutMs: number,
  ): StatusWaitHandle {
    let waiter: StatusWaiter;
    const promise = new Promise<JetsonControlStatus>((resolve, reject) => {
      waiter = {} as StatusWaiter;
      waiter.accept = accept;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        const requestWaiters = this.waiters.get(requestId);
        requestWaiters?.delete(waiter);
        if (requestWaiters && !requestWaiters.size) this.waiters.delete(requestId);
        reject(new JetsonControlError(`等待 Jetson 回执超时（request_id=${requestId}）`));
      }, timeoutMs);
      waiter.timer.unref();
      const requestWaiters = this.waiters.get(requestId) ?? new Set<StatusWaiter>();
      requestWaiters.add(waiter);
      this.waiters.set(requestId, requestWaiters);
    });
    void promise.catch(() => undefined);
    return {
      promise,
      cancel: (error) => {
        const requestWaiters = this.waiters.get(requestId);
        if (!requestWaiters?.has(waiter)) return;
        clearTimeout(waiter.timer);
        requestWaiters.delete(waiter);
        if (!requestWaiters.size) this.waiters.delete(requestId);
        waiter.reject(error);
      },
    };
  }

  private waitForNavigationStatus(
    requestId: string,
    accept: ReadonlySet<JetsonNavigationState>,
    timeoutMs: number,
  ): NavigationWaitHandle {
    let waiter: NavigationWaiter;
    const promise = new Promise<JetsonNavigationStatus>((resolve, reject) => {
      waiter = {} as NavigationWaiter;
      waiter.accept = accept;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        const requestWaiters = this.navigationWaiters.get(requestId);
        requestWaiters?.delete(waiter);
        if (requestWaiters && !requestWaiters.size) this.navigationWaiters.delete(requestId);
        reject(new JetsonControlError(`等待 Jetson 导航回执超时（request_id=${requestId}）`));
      }, timeoutMs);
      waiter.timer.unref();
      const requestWaiters = this.navigationWaiters.get(requestId) ?? new Set<NavigationWaiter>();
      requestWaiters.add(waiter);
      this.navigationWaiters.set(requestId, requestWaiters);
    });
    void promise.catch(() => undefined);
    return {
      promise,
      cancel: (error) => {
        const requestWaiters = this.navigationWaiters.get(requestId);
        if (!requestWaiters?.has(waiter)) return;
        clearTimeout(waiter.timer);
        requestWaiters.delete(waiter);
        if (!requestWaiters.size) this.navigationWaiters.delete(requestId);
        waiter.reject(error);
      },
    };
  }

  private rejectAll(error: Error) {
    for (const requestWaiters of this.waiters.values()) {
      for (const waiter of requestWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
    for (const requestWaiters of this.navigationWaiters.values()) {
      for (const waiter of requestWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.navigationWaiters.clear();
  }
}

export function parseJetsonControlStatus(raw: string): JetsonControlStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const status = value as Record<string, unknown>;
  if (status.type !== "control" || typeof status.request_id !== "string" || typeof status.kind !== "string") return null;
  if (!["started", "running", "completed", "failed", "cancelled", "stopped"].includes(String(status.state))) return null;
  return status as unknown as JetsonControlStatus;
}

export function parseJetsonNavigationStatus(raw: string): JetsonNavigationStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const status = value as Record<string, unknown>;
  if (status.type !== "navigation" || typeof status.request_id !== "string") return null;
  if (!["planning", "planned", "running", "completed", "failed", "cancelled", "stopped"].includes(String(status.state))) return null;
  return status as unknown as JetsonNavigationStatus;
}

function statusError(status: JetsonControlStatus) {
  const detail = typeof status.error === "string"
    ? status.error
    : typeof status.reason === "string"
      ? status.reason
      : status.state;
  return new JetsonControlError(`Jetson ${status.kind} 任务${status.state}：${detail}`, status);
}

function navigationStatusError(status: JetsonNavigationStatus) {
  const detail = typeof status.error === "string"
    ? status.error
    : typeof status.reason === "string"
      ? status.reason
      : status.state;
  return new JetsonControlError(`Jetson 导航任务${status.state}：${detail}`, status);
}

export function jetsonNavigationConflictRevision(error: unknown) {
  if (!(error instanceof JetsonControlError) || error.status?.type !== "navigation") return null;
  const status = error.status;
  const detail = `${typeof status.error === "string" ? status.error : ""} ${typeof status.reason === "string" ? status.reason : ""}`;
  if (!/(?:地图修订冲突|map\s*revision\s*(?:conflict|mismatch))/iu.test(detail)) return null;
  const explicit = detail.match(/(?:当前修订(?:为|是)?|current\s*(?:map\s*)?revision(?:\s*is)?)\s*[:：]?\s*(\d+)/iu);
  const revision = explicit ? Number(explicit[1]) : Number(status.map_revision ?? status.mapRevision);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}

function normalizeNavigationHeading(value: number) {
  return ((value % 360) + 360) % 360;
}

function asControlError(error: unknown) {
  return error instanceof Error ? error : new JetsonControlError(String(error));
}
