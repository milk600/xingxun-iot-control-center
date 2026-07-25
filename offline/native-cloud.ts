export interface AndroidRuntimeConfig {
  android: boolean;
  iotConfigured: boolean;
  deepSeekConfigured: boolean;
  asrConfigured: boolean;
  serviceId: string;
  staleAfterMs: number;
  offlineAfterMs: number;
  deepSeekBaseUrl: string;
  asrModel: string;
  jetsonWsUrl: string;
}

interface AndroidCloudJavascriptBridge {
  getRuntimeConfig(): string;
  setActiveRoute(path: string): void;
  setAgentActivity(phase: "recording" | "planning" | "executing" | "vehicle", active: boolean): void;
  saveDataUrl(dataUrl: string, requestedName: string): void;
  saveTextFile(content: string, requestedName: string, mimeType: string): void;
  readIotShadow(requestId: string): void;
  requestDeepSeek(requestId: string, body: string): void;
  cancelRequest(requestId: string): void;
  startAsr(sessionId: string): void;
  sendAsrAudio(sessionId: string, base64Audio: string): void;
  finishAsr(sessionId: string): void;
}

interface NativeCloudEventDetail {
  requestId: string;
  status: number;
  body: string;
  error?: string;
  cancelled?: boolean;
}

export interface NativeAsrEventDetail {
  sessionId: string;
  type: "ready" | "partial" | "final" | "finished" | "error";
  text?: string;
  error?: string;
}

declare global {
  interface Window {
    XingXunCloud?: AndroidCloudJavascriptBridge;
  }
}

const FALLBACK_CONFIG: AndroidRuntimeConfig = {
  android: false,
  iotConfigured: false,
  deepSeekConfigured: false,
  asrConfigured: false,
  serviceId: "Environment",
  staleAfterMs: 30_000,
  offlineAfterMs: 90_000,
  deepSeekBaseUrl: "https://api.deepseek.com",
  asrModel: "fun-asr-realtime",
  jetsonWsUrl: "",
};

let cachedConfig: AndroidRuntimeConfig | null = null;

export function readAndroidRuntimeConfig(): AndroidRuntimeConfig {
  if (cachedConfig) return cachedConfig;
  const bridge = window.XingXunCloud;
  if (!bridge) return { ...FALLBACK_CONFIG };
  try {
    const value = JSON.parse(bridge.getRuntimeConfig()) as Partial<AndroidRuntimeConfig>;
    cachedConfig = {
      android: value.android === true,
      iotConfigured: value.iotConfigured === true,
      deepSeekConfigured: value.deepSeekConfigured === true,
      asrConfigured: value.asrConfigured === true,
      serviceId: typeof value.serviceId === "string" && value.serviceId ? value.serviceId : "Environment",
      staleAfterMs: positiveNumber(value.staleAfterMs, 30_000),
      offlineAfterMs: positiveNumber(value.offlineAfterMs, 90_000),
      deepSeekBaseUrl: typeof value.deepSeekBaseUrl === "string" && value.deepSeekBaseUrl
        ? value.deepSeekBaseUrl.replace(/\/$/, "")
        : FALLBACK_CONFIG.deepSeekBaseUrl,
      asrModel: typeof value.asrModel === "string" && value.asrModel ? value.asrModel : FALLBACK_CONFIG.asrModel,
      jetsonWsUrl: typeof value.jetsonWsUrl === "string" ? value.jetsonWsUrl : "",
    };
    return cachedConfig;
  } catch {
    return { ...FALLBACK_CONFIG, android: true };
  }
}

export function readHuaweiShadow(signal?: AbortSignal) {
  return nativeCloudRequest("iot-shadow", signal, (bridge, requestId) => {
    bridge.readIotShadow(requestId);
  }).then((response) => JSON.parse(response.body) as unknown);
}

export function nativeDeepSeekFetch(init?: RequestInit) {
  return nativeCloudRequest("deepseek", init?.signal ?? undefined, (bridge, requestId) => {
    bridge.requestDeepSeek(requestId, typeof init?.body === "string" ? init.body : "{}");
  }).then((result) => new Response(result.body, {
    status: result.status || 502,
    headers: { "content-type": "application/json; charset=utf-8" },
  }));
}

export function startNativeAsr(sessionId: string) {
  window.XingXunCloud?.startAsr(sessionId);
}

export function pushNativeAsrAudio(sessionId: string, audio: ArrayBuffer | ArrayBufferView) {
  const bytes = audio instanceof ArrayBuffer
    ? new Uint8Array(audio)
    : new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  let binary = "";
  const batch = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += batch) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + batch));
  }
  window.XingXunCloud?.sendAsrAudio(sessionId, window.btoa(binary));
}

export function finishNativeAsr(sessionId: string) {
  window.XingXunCloud?.finishAsr(sessionId);
}

function nativeCloudRequest(
  prefix: string,
  signal: AbortSignal | undefined,
  invoke: (bridge: AndroidCloudJavascriptBridge, requestId: string) => void,
) {
  const bridge = window.XingXunCloud;
  if (!bridge) return Promise.reject(new Error("Android 云端数据桥不可用"));
  const requestId = `${prefix}-${crypto.randomUUID()}`;
  return new Promise<NativeCloudEventDetail>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("xingxun:native-cloud", onResult as EventListener);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      bridge.cancelRequest(requestId);
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("请求已取消", "AbortError"));
    };
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<NativeCloudEventDetail>).detail;
      if (!detail || detail.requestId !== requestId) return;
      cleanup();
      if (detail.cancelled) reject(new DOMException(detail.error || "请求已取消", "AbortError"));
      else if (detail.error) reject(new Error(detail.error));
      else resolve(detail);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    window.addEventListener("xingxun:native-cloud", onResult as EventListener);
    signal?.addEventListener("abort", onAbort, { once: true });
    invoke(bridge, requestId);
  });
}

export function isExpectedNativeCloudCancellation(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  if (!error || typeof error !== "object") return false;
  return "name" in error && error.name === "AbortError";
}

function positiveNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
