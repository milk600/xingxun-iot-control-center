import WebSocket from "ws";
import type { AgentGatewayConfig } from "./config";

interface FunAsrCallbacks {
  onReady: () => void;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onFinished: (fullText: string) => void;
  onError: (error: Error) => void;
}

export interface FunAsrTimingOptions {
  connectTimeoutMs?: number;
  startTimeoutMs?: number;
  finishTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_FINISH_TIMEOUT_MS = 8_000;

export class FunAsrSession {
  private socket: WebSocket | null = null;
  private readonly taskId = crypto.randomUUID();
  private readonly queuedAudio: Buffer[] = [];
  private readonly finalSentences: string[] = [];
  private readonly connectTimeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly finishTimeoutMs: number;
  private connectWatchdog: NodeJS.Timeout | null = null;
  private startWatchdog: NodeJS.Timeout | null = null;
  private finishWatchdog: NodeJS.Timeout | null = null;
  private started = false;
  private finishing = false;
  private finishSent = false;
  private readyNotified = false;
  private terminal = false;
  private latestTranscript = "";

  constructor(
    private readonly config: AgentGatewayConfig,
    private readonly callbacks: FunAsrCallbacks,
    timing: FunAsrTimingOptions = {},
  ) {
    this.connectTimeoutMs = positiveTimeout(timing.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.startTimeoutMs = positiveTimeout(timing.startTimeoutMs, DEFAULT_START_TIMEOUT_MS);
    this.finishTimeoutMs = positiveTimeout(timing.finishTimeoutMs, DEFAULT_FINISH_TIMEOUT_MS);
  }

  start() {
    if (this.terminal || this.socket) return;
    if (!this.config.dashScopeApiKey) {
      this.fail(new Error("尚未配置 DASHSCOPE_API_KEY"));
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.config.asrWebSocketUrl, {
        headers: { Authorization: `Bearer ${this.config.dashScopeApiKey}` },
      });
    } catch (error) {
      this.fail(asError(error, "无法创建语音识别连接"));
      return;
    }
    this.socket = socket;
    this.connectWatchdog = this.watch(
      this.connectTimeoutMs,
      () => this.fail(new Error("语音识别连接超时，请重试")),
    );

    socket.on("open", () => {
      if (this.terminal || socket !== this.socket) return;
      this.clearTimer("connect");
      try {
        socket.send(JSON.stringify({
          header: { action: "run-task", task_id: this.taskId, streaming: "duplex" },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: this.config.asrModel,
            parameters: {
              format: "pcm",
              sample_rate: 16000,
              language_hints: ["zh"],
              semantic_punctuation_enabled: false,
              max_sentence_silence: 500,
            },
            input: {
              context: [{
                role: "user",
                content: [{
                  type: "input_text",
                  text: "危化智巡，空间孪生，数据位，华为云，巡检小车，俯视，缺口诊断",
                }],
              }],
            },
          },
        }));
      } catch {
        this.fail(new Error("语音识别启动请求发送失败，请重试"));
        return;
      }
      this.startWatchdog = this.watch(
        this.startTimeoutMs,
        () => this.fail(new Error("语音识别服务启动超时，请重试")),
      );
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary || this.terminal || socket !== this.socket) return;
      this.handleMessage(data.toString());
    });
    socket.on("error", (error) => this.fail(asError(error, "语音识别连接失败")));
    socket.on("close", () => {
      if (this.terminal || socket !== this.socket) return;
      if (this.finishing) this.complete();
      else this.fail(new Error("语音识别连接已关闭，请重试"));
    });
  }

  pushAudio(audio: Buffer) {
    if (!audio.length || this.finishing || this.terminal) return;
    if (!this.started || this.socket?.readyState !== WebSocket.OPEN) {
      if (this.queuedAudio.length < 160) this.queuedAudio.push(audio);
      return;
    }
    this.socket.send(audio, { binary: true });
  }

  finish() {
    if (this.finishing || this.terminal) return;
    this.finishing = true;

    // A press-and-release that produced no audio is not an ASR failure. Finish
    // immediately so the UI returns to idle instead of waiting for the cloud.
    if (!this.started && this.queuedAudio.length === 0) {
      this.complete("");
      return;
    }

    this.finishWatchdog = this.watch(this.finishTimeoutMs, () => this.complete());
    if (this.started && this.socket?.readyState === WebSocket.OPEN) this.finishNow();
  }

  close() {
    if (this.terminal) return;
    this.terminal = true;
    this.clearWatchdogs();
    this.disposeSocket();
  }

  private finishNow() {
    if (this.finishSent || this.terminal) return;
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.complete();
      return;
    }
    this.finishSent = true;
    try {
      this.socket.send(JSON.stringify({
        header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" },
        payload: { input: {} },
      }));
    } catch {
      this.complete();
    }
  }

  private handleMessage(raw: string) {
    let message: {
      header?: { event?: string; error_message?: string };
      payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean; heartbeat?: boolean } } };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const event = message.header?.event;
    if (event === "task-started") {
      if (this.started) return;
      this.started = true;
      this.clearTimer("start");
      for (const audio of this.queuedAudio.splice(0)) {
        this.socket?.send(audio, { binary: true });
      }
      if (!this.readyNotified) {
        this.readyNotified = true;
        this.callbacks.onReady();
      }
      if (this.finishing) this.finishNow();
      return;
    }
    if (event === "result-generated") {
      const sentence = message.payload?.output?.sentence;
      const text = sentence?.text?.trim() ?? "";
      if (!text || sentence?.heartbeat) return;
      this.latestTranscript = text;
      this.callbacks.onPartial(text);
      if (sentence?.sentence_end) {
        this.finalSentences.push(text);
        this.callbacks.onFinal(text);
      }
      return;
    }
    if (event === "task-finished") {
      this.complete();
      return;
    }
    if (event === "task-failed") {
      this.fail(new Error(message.header?.error_message || "语音识别失败"));
    }
  }

  private complete(explicitText?: string) {
    if (this.terminal) return;
    this.terminal = true;
    const text = explicitText ?? this.transcript();
    this.clearWatchdogs();
    this.disposeSocket();
    this.callbacks.onFinished(text);
  }

  private fail(error: Error) {
    if (this.terminal) return;
    this.terminal = true;
    this.clearWatchdogs();
    this.disposeSocket();
    this.callbacks.onError(error);
  }

  private transcript() {
    const finalText = this.finalSentences.join("").trim();
    return finalText || this.latestTranscript.trim();
  }

  private watch(timeoutMs: number, callback: () => void) {
    const timer = setTimeout(callback, timeoutMs);
    timer.unref();
    return timer;
  }

  private clearTimer(timer: "connect" | "start" | "finish") {
    const key = `${timer}Watchdog` as const;
    const active = this[key];
    if (active) clearTimeout(active);
    this[key] = null;
  }

  private clearWatchdogs() {
    this.clearTimer("connect");
    this.clearTimer("start");
    this.clearTimer("finish");
  }

  private disposeSocket() {
    const socket = this.socket;
    this.socket = null;
    this.queuedAudio.length = 0;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "session complete");
    else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  }
}

function positiveTimeout(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function asError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}
