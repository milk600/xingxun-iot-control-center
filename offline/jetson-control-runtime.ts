import type { VehicleMotion } from "@/app/lib/iot/contracts";
import {
  readJetsonSettings,
  type JetsonConnectionSettings,
} from "@/app/lib/iot/jetson-websocket";

export type AndroidJetsonControlState =
  | "started"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped";

export interface AndroidJetsonControlStatus {
  type: "control";
  version?: number;
  ts?: number;
  request_id: string;
  kind: string;
  state: AndroidJetsonControlState;
  [key: string]: unknown;
}

export type AndroidJetsonNavigationState =
  | "planning"
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped";

export interface AndroidJetsonNavigationStatus {
  type: "navigation";
  version?: number;
  ts?: number;
  request_id: string;
  state: AndroidJetsonNavigationState;
  task_id?: string;
  estimated_seconds?: number;
  elapsed_ms?: number;
  [key: string]: unknown;
}

export interface AndroidJetsonNavigationCommand {
  requestId: string;
  mapRevision: number;
  start: { x: number; y: number; headingDeg: number };
  goal: { x: number; y: number };
}

export type AndroidJetsonClosedLoopCommand =
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

interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface StatusWaiter {
  accept: ReadonlySet<AndroidJetsonControlState>;
  resolve: (status: AndroidJetsonControlStatus) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface StatusWaitHandle {
  promise: Promise<AndroidJetsonControlStatus>;
  cancel: (error: Error) => void;
}

interface NavigationWaiter {
  accept: ReadonlySet<AndroidJetsonNavigationState>;
  resolve: (status: AndroidJetsonNavigationStatus) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface NavigationWaitHandle {
  promise: Promise<AndroidJetsonNavigationStatus>;
  cancel: (error: Error) => void;
}

export interface AndroidJetsonControlClientOptions {
  settings?: () => JetsonConnectionSettings;
  socket?: (url: string) => SocketLike;
  connectionTimeoutMs?: number;
  onStatus?: (
    status: AndroidJetsonControlStatus | AndroidJetsonNavigationStatus
  ) => void;
}

export class AndroidJetsonControlError extends Error {
  constructor(
    message: string,
    readonly status?:
      | AndroidJetsonControlStatus
      | AndroidJetsonNavigationStatus,
  ) {
    super(message);
    this.name = "AndroidJetsonControlError";
  }
}

/**
 * Device-local Jetson controller used by the Android Agent runtime.
 *
 * It deliberately owns a control-only WebSocket instead of borrowing the
 * currently mounted page controller. Agent commands therefore keep the same
 * receipt semantics on every route, including settings and digital twin.
 */
export class AndroidJetsonControlClient {
  private socket: SocketLike | null = null;
  private socketUrl: string | null = null;
  private connecting: Promise<SocketLike> | null = null;
  private connectingSocket: SocketLike | null = null;
  private activeRequestId: string | null = null;
  private activeNavigationTaskId: string | null = null;
  private readonly waiters = new Map<string, Set<StatusWaiter>>();
  private readonly navigationWaiters = new Map<string, Set<NavigationWaiter>>();
  private readonly terminalStatuses = new Map<string, AndroidJetsonControlStatus>();
  private readonly settings: () => JetsonConnectionSettings;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly connectionTimeoutMs: number;
  private readonly onStatus?: (
    status: AndroidJetsonControlStatus | AndroidJetsonNavigationStatus
  ) => void;

  constructor(options: AndroidJetsonControlClientOptions = {}) {
    this.settings = options.settings ?? readJetsonSettings;
    this.createSocket = options.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 12_000;
    this.onStatus = options.onStatus;
  }

  get hasActiveTask() {
    return this.activeRequestId !== null;
  }

  async executeTimedMove(
    motion: Exclude<VehicleMotion, "stop">,
    speedPercent: number,
    durationMs: number,
  ) {
    this.assertIdle();
    const requestId = controlRequestId("android-agent-timed");
    this.activeRequestId = requestId;
    try {
      await this.sendJson({
        cmd: "move",
        request_id: requestId,
        speeds: timedMoveWheelSpeeds(motion, speedPercent),
      });
      await delay(durationMs);
      const stopped = await this.stopRequest(requestId);
      return { requestId, stopped };
    } finally {
      if (this.activeRequestId === requestId) this.activeRequestId = null;
    }
  }

  async executeClosedLoop(command: AndroidJetsonClosedLoopCommand) {
    this.assertIdle();
    this.activeRequestId = command.request_id;
    const terminal = this.waitForStatus(
      command.request_id,
      new Set(["completed", "failed", "cancelled", "stopped"]),
      Math.ceil((command.timeout_s + 10) * 1_000),
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
      const state = error instanceof AndroidJetsonControlError
        ? error.status?.state
        : undefined;
      if (state !== "cancelled" && state !== "stopped") {
        try {
          await this.stopRequest(command.request_id);
        } catch {
          // Preserve the command failure. A missing stop receipt must not turn
          // the original operation into a false success.
        }
      }
      throw error;
    } finally {
      if (this.activeRequestId === command.request_id) this.activeRequestId = null;
    }
  }

  async executeNavigation(command: AndroidJetsonNavigationCommand) {
    this.assertIdle();
    this.activeRequestId = command.requestId;
    this.activeNavigationTaskId = null;
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
      if (planStatus.state !== "planned") {
        throw navigationStatusError(planStatus);
      }
      const taskId = typeof planStatus.task_id === "string"
        ? planStatus.task_id.trim()
        : "";
      if (!taskId) {
        throw new AndroidJetsonControlError(
          "Jetson 路线规划回执缺少 task_id",
        );
      }
      this.activeNavigationTaskId = taskId;
      const estimatedSeconds = finiteStatusNumber(
        planStatus.estimated_seconds,
      ) ?? 60;
      const terminal = this.waitForNavigationStatus(
        command.requestId,
        new Set(["completed", "failed", "cancelled", "stopped"]),
        Math.max(
          90_000,
          Math.ceil((estimatedSeconds * 3 + 30) * 1_000),
        ),
      );
      try {
        await this.sendJson({
          cmd: "navigation_start",
          request_id: controlRequestId("android-agent-navigation-start"),
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
      const terminalState = error instanceof AndroidJetsonControlError
        ? error.status?.state
        : undefined;
      const taskId = this.activeNavigationTaskId;
      if (
        taskId
        && terminalState !== "cancelled"
        && terminalState !== "stopped"
      ) {
        try {
          await this.sendJson({
            cmd: "navigation_cancel",
            request_id: controlRequestId("android-agent-navigation-cancel"),
            task_id: taskId,
          });
        } catch {
          // Keep the original navigation error as the public result.
        }
      }
      throw error;
    } finally {
      if (this.activeRequestId === command.requestId) {
        this.activeRequestId = null;
        this.activeNavigationTaskId = null;
      }
    }
  }

  async stop() {
    if (this.activeRequestId && this.activeNavigationTaskId) {
      const requestId = this.activeRequestId;
      const terminal = this.waitForNavigationStatus(
        requestId,
        new Set(["cancelled", "stopped", "failed"]),
        6_000,
      );
      try {
        await this.sendJson({
          cmd: "navigation_cancel",
          request_id: controlRequestId("android-agent-navigation-cancel"),
          task_id: this.activeNavigationTaskId,
        });
      } catch (error) {
        terminal.cancel(asControlError(error));
        throw error;
      }
      const status = await terminal.promise;
      if (status.state === "cancelled" || status.state === "stopped") {
        return status;
      }
      throw navigationStatusError(status);
    }
    const requestId = this.activeRequestId ?? controlRequestId("android-agent-stop");
    return this.stopRequest(requestId);
  }

  async close() {
    this.rejectAll(new AndroidJetsonControlError("Android Jetson 控制连接已关闭"));
    this.activeRequestId = null;
    this.activeNavigationTaskId = null;
    const sockets = [...new Set(
      [this.socket, this.connectingSocket].filter(
        (socket): socket is SocketLike => socket !== null,
      ),
    )];
    this.socket = null;
    this.socketUrl = null;
    this.connecting = null;
    this.connectingSocket = null;
    await Promise.all(sockets.map((socket) => this.closeSocket(socket)));
  }

  private assertIdle() {
    if (this.activeRequestId) {
      throw new AndroidJetsonControlError("已有车辆任务正在执行");
    }
  }

  private async stopRequest(requestId: string) {
    // A closed-loop failure and its compensating stop intentionally reuse the
    // device request_id. Never let the earlier failed terminal state satisfy
    // the new stop waiter.
    this.terminalStatuses.delete(requestId);
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

  private async sendJson(payload: unknown) {
    const socket = await this.open();
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      throw new AndroidJetsonControlError(
        `Jetson 命令发送失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private open() {
    const settings = this.settings();
    if (!settings.enabled) {
      return Promise.reject(new AndroidJetsonControlError("小车连接已在系统设置中关闭"));
    }
    if (!/^(ws|wss):\/\//i.test(settings.wsUrl)) {
      return Promise.reject(new AndroidJetsonControlError("Jetson 连接地址无效"));
    }
    if (
      this.socket
      && this.socketUrl === settings.wsUrl
      && this.socket.readyState === 1
    ) {
      return Promise.resolve(this.socket);
    }
    if (this.connecting && this.socketUrl === settings.wsUrl) return this.connecting;
    if (this.connecting && this.socketUrl !== settings.wsUrl) {
      const replaced = this.connectingSocket;
      this.connecting = null;
      this.connectingSocket = null;
      try {
        replaced?.close(1000, "Jetson address changed");
      } catch {
        // The replaced connection will reject its original caller.
      }
    }
    if (this.socket && this.socketUrl !== settings.wsUrl) {
      const replaced = this.socket;
      this.socket = null;
      try {
        replaced.close(1000, "Jetson address changed");
      } catch {
        // Continue with the newly configured endpoint.
      }
    }

    const socket = this.createSocket(settings.wsUrl);
    this.socketUrl = settings.wsUrl;
    this.connectingSocket = socket;
    const connection = new Promise<SocketLike>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onEarlyClose);
        if (error) reject(error);
        else resolve(socket);
      };
      const onOpen = () => finish();
      const onError = () => finish(new AndroidJetsonControlError("Jetson 控制连接失败"));
      const onEarlyClose = () => finish(new AndroidJetsonControlError("Jetson 控制连接在建立前关闭"));
      const timer = setTimeout(() => {
        finish(new AndroidJetsonControlError("Jetson 控制连接超时"));
        try {
          socket.close(1000, "connection timeout");
        } catch {
          // The timeout error is already the useful public result.
        }
      }, this.connectionTimeoutMs);
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("close", onEarlyClose, { once: true });
      socket.addEventListener("message", this.handleMessage);
      socket.addEventListener("close", () => this.handleSocketClose(socket));
    }).then((opened) => {
      if (this.connectingSocket !== opened) {
        try {
          opened.close(1000, "connection replaced");
        } catch {
          // The useful result is the replacement error below.
        }
        throw new AndroidJetsonControlError("Jetson 控制连接已被新地址替换");
      }
      this.socket = opened;
      return opened;
    }).finally(() => {
      if (this.connectingSocket === socket) {
        this.connecting = null;
        this.connectingSocket = null;
      }
    });
    this.connecting = connection;
    return this.connecting;
  }

  private readonly handleMessage = (event: Event) => {
    const raw = (event as MessageEvent<unknown>).data;
    const text = typeof raw === "string" ? raw : "";
    const status = parseAndroidJetsonControlStatus(text);
    if (status) {
      this.onStatus?.(status);
      if (isTerminalState(status.state)) {
        this.terminalStatuses.set(status.request_id, status);
        while (this.terminalStatuses.size > 32) {
          const oldest = this.terminalStatuses.keys().next().value;
          if (typeof oldest !== "string") break;
          this.terminalStatuses.delete(oldest);
        }
      }
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
    const navigationStatus = parseAndroidJetsonNavigationStatus(text);
    if (!navigationStatus) return;
    this.onStatus?.(navigationStatus);
    const requestWaiters = this.navigationWaiters.get(
      navigationStatus.request_id,
    );
    if (!requestWaiters) return;
    for (const waiter of [...requestWaiters]) {
      if (!waiter.accept.has(navigationStatus.state)) continue;
      clearTimeout(waiter.timer);
      requestWaiters.delete(waiter);
      waiter.resolve(navigationStatus);
    }
    if (!requestWaiters.size) {
      this.navigationWaiters.delete(navigationStatus.request_id);
    }
  };

  private handleSocketClose(socket: SocketLike) {
    if (socket !== this.socket && socket !== this.connectingSocket) return;
    if (this.socket === socket) this.socket = null;
    if (this.connectingSocket === socket) {
      this.connecting = null;
      this.connectingSocket = null;
    }
    this.rejectAll(new AndroidJetsonControlError("Jetson 控制连接已断开"));
  }

  private closeSocket(socket: SocketLike) {
    if (socket.readyState >= 2) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("close", finish as EventListener);
        resolve();
      };
      const timer = setTimeout(finish, 1_000);
      socket.addEventListener("close", finish as EventListener, { once: true });
      try {
        socket.close(1000, "android agent shutdown");
      } catch {
        finish();
      }
    });
  }

  private waitForStatus(
    requestId: string,
    accept: ReadonlySet<AndroidJetsonControlState>,
    timeoutMs: number,
  ): StatusWaitHandle {
    const cached = this.terminalStatuses.get(requestId);
    if (cached && accept.has(cached.state)) {
      return {
        promise: Promise.resolve(cached),
        cancel: () => undefined,
      };
    }
    let waiter: StatusWaiter;
    const promise = new Promise<AndroidJetsonControlStatus>((resolve, reject) => {
      waiter = {} as StatusWaiter;
      waiter.accept = accept;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        const requestWaiters = this.waiters.get(requestId);
        requestWaiters?.delete(waiter);
        if (requestWaiters && !requestWaiters.size) this.waiters.delete(requestId);
        reject(new AndroidJetsonControlError(
          `等待 Jetson 回执超时（request_id=${requestId}）`,
        ));
      }, timeoutMs);
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
    accept: ReadonlySet<AndroidJetsonNavigationState>,
    timeoutMs: number,
  ): NavigationWaitHandle {
    let waiter: NavigationWaiter;
    const promise = new Promise<AndroidJetsonNavigationStatus>(
      (resolve, reject) => {
        waiter = {} as NavigationWaiter;
        waiter.accept = accept;
        waiter.resolve = resolve;
        waiter.reject = reject;
        waiter.timer = setTimeout(() => {
          const requestWaiters = this.navigationWaiters.get(requestId);
          requestWaiters?.delete(waiter);
          if (requestWaiters && !requestWaiters.size) {
            this.navigationWaiters.delete(requestId);
          }
          reject(new AndroidJetsonControlError(
            `等待 Jetson 导航回执超时（request_id=${requestId}）`,
          ));
        }, timeoutMs);
        const requestWaiters = this.navigationWaiters.get(requestId)
          ?? new Set<NavigationWaiter>();
        requestWaiters.add(waiter);
        this.navigationWaiters.set(requestId, requestWaiters);
      },
    );
    void promise.catch(() => undefined);
    return {
      promise,
      cancel: (error) => {
        const requestWaiters = this.navigationWaiters.get(requestId);
        if (!requestWaiters?.has(waiter)) return;
        clearTimeout(waiter.timer);
        requestWaiters.delete(waiter);
        if (!requestWaiters.size) {
          this.navigationWaiters.delete(requestId);
        }
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

export function parseAndroidJetsonControlStatus(
  raw: string,
): AndroidJetsonControlStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value as Record<string, unknown>;
  if (
    status.type !== "control"
    || typeof status.request_id !== "string"
    || !status.request_id
    || typeof status.kind !== "string"
    || !status.kind
    || !isControlState(status.state)
  ) {
    return null;
  }
  return status as unknown as AndroidJetsonControlStatus;
}

export function parseAndroidJetsonNavigationStatus(
  raw: string,
): AndroidJetsonNavigationStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value as Record<string, unknown>;
  if (
    status.type !== "navigation"
    || typeof status.request_id !== "string"
    || !status.request_id
    || !isNavigationState(status.state)
  ) {
    return null;
  }
  return status as unknown as AndroidJetsonNavigationStatus;
}

export function defaultAndroidDistanceTimeout(
  distanceMm: number,
  maxSpeedMmps: number,
) {
  return Math.max(5, distanceMm / maxSpeedMmps * 5 + 5);
}

export function defaultAndroidTurnTimeout(angleDeg: number) {
  return Math.max(5, angleDeg / 25 * 5 + 5);
}

export function completedAndroidVehicleMessage(
  command:
    | {
        kind: "distance";
        direction: "forward" | "backward";
        distanceMm: number;
      }
    | {
        kind: "turn";
        direction: "left" | "right";
        angleDeg: number;
      },
  status: AndroidJetsonControlStatus,
) {
  const elapsed = finiteStatusNumber(status.elapsed_ms);
  const elapsedText = elapsed === null ? "" : `，耗时 ${Math.round(elapsed)}ms`;
  if (command.kind === "distance") {
    const measured = finiteStatusNumber(status.measured_distance_mm);
    const error = finiteStatusNumber(status.final_error_mm);
    const measuredText = measured === null ? "" : `，实测 ${formatVehicleNumber(measured)}mm`;
    const errorText = error === null ? "" : `，最终误差 ${formatVehicleNumber(error)}mm`;
    return `Jetson 已确认${command.direction === "forward" ? "前进" : "后退"} ${formatVehicleNumber(command.distanceMm)}mm 完成（request_id=${status.request_id}${measuredText}${errorText}${elapsedText}）。`;
  }
  const measured = finiteStatusNumber(status.measured_angle_deg);
  const error = finiteStatusNumber(status.final_error_deg);
  const measuredText = measured === null ? "" : `，实测 ${formatVehicleNumber(measured)}°`;
  const errorText = error === null ? "" : `，最终误差 ${formatVehicleNumber(error)}°`;
  return `Jetson 已确认${command.direction === "left" ? "左转" : "右转"} ${formatVehicleNumber(command.angleDeg)}° 完成（request_id=${status.request_id}${measuredText}${errorText}${elapsedText}）。`;
}

function timedMoveWheelSpeeds(
  motion: Exclude<VehicleMotion, "stop">,
  percent: number,
) {
  const speed = Math.round(300 * Math.min(100, Math.max(1, percent)) / 100);
  return {
    forward: [speed, -speed, speed, -speed],
    backward: [-speed, speed, -speed, speed],
    left: [-speed, -speed, speed, speed],
    right: [speed, speed, -speed, -speed],
  }[motion];
}

function controlRequestId(prefix: string) {
  return typeof crypto.randomUUID === "function"
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isControlState(value: unknown): value is AndroidJetsonControlState {
  return typeof value === "string"
    && ["started", "running", "completed", "failed", "cancelled", "stopped"].includes(value);
}

function isTerminalState(value: AndroidJetsonControlState) {
  return value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "stopped";
}

function isNavigationState(
  value: unknown,
): value is AndroidJetsonNavigationState {
  return typeof value === "string"
    && [
      "planning",
      "planned",
      "running",
      "completed",
      "failed",
      "cancelled",
      "stopped",
    ].includes(value);
}

function statusError(status: AndroidJetsonControlStatus) {
  const detail = typeof status.error === "string"
    ? status.error
    : typeof status.reason === "string"
      ? status.reason
      : status.state;
  return new AndroidJetsonControlError(
    `Jetson ${status.kind} 任务${status.state}：${detail}`,
    status,
  );
}

function navigationStatusError(status: AndroidJetsonNavigationStatus) {
  const detail = typeof status.error === "string"
    ? status.error
    : typeof status.reason === "string"
      ? status.reason
      : status.state;
  return new AndroidJetsonControlError(
    `Jetson 导航任务${status.state}：${detail}`,
    status,
  );
}

export function androidJetsonNavigationConflictRevision(error: unknown) {
  if (!(error instanceof AndroidJetsonControlError) || error.status?.type !== "navigation") return null;
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
  return error instanceof Error
    ? error
    : new AndroidJetsonControlError(String(error));
}

function finiteStatusNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatVehicleNumber(value: number) {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
