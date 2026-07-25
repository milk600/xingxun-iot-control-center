import type {
  DashboardSnapshot,
  DataState,
  TelemetryAuxiliaryReading,
  TelemetrySlot,
  TelemetrySlotId,
  TelemetrySlots,
  VehicleCommandAck,
  VehicleCommandRequest,
} from "@/app/lib/iot/contracts";
import { createUnavailableSlots, createUnavailableVehicle } from "@/app/lib/iot/contracts";
import {
  recordAndroidCollectionFailure,
  recordAndroidCollectionRecovery,
  recordAndroidSnapshot,
} from "./local-data-store";
import {
  isExpectedNativeCloudCancellation,
  nativeDeepSeekFetch,
  readAndroidRuntimeConfig,
  readHuaweiShadow,
} from "./native-cloud";
import { androidCollectionRetryDelayMs } from "./collection-backoff";

interface HuaweiShadowResponse {
  shadow?: Array<{
    service_id?: string;
    reported?: {
      properties?: Record<string, unknown>;
      event_time?: string;
    };
  }>;
}

const nativeFetch = window.fetch.bind(window);
const LAST_REAL_SHADOW_KEY = "xingxun:android-last-real-shadow:v1";
let consecutiveCollectionFailures = 0;
let collectionRetryNotBefore = 0;
let lastCollectionFailure = "";

function parseHuaweiTime(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(value);
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function numericProperty(properties: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function dataState(observedAt: string | null, staleAfterMs: number, offlineAfterMs: number): DataState {
  if (!observedAt) return "stale";
  const age = Math.max(0, Date.now() - Date.parse(observedAt));
  if (age >= offlineAfterMs) return "offline";
  if (age >= staleAfterMs) return "stale";
  return "live";
}

function numberSlot(
  slotId: TelemetrySlotId,
  sourceKey: string,
  label: string,
  value: number | null,
  unit: string,
  precision: number,
  tone: TelemetrySlot["tone"],
  state: DataState,
  observedAt: string | null,
  auxiliaryReadings: ReadonlyArray<TelemetryAuxiliaryReading> = [],
): TelemetrySlot {
  return {
    slotId,
    sourceKey,
    label,
    value,
    unit,
    precision,
    tone,
    state: value === null ? "empty" : state,
    observedAt,
    supportingText: state === "live"
      ? "华为云 IoTDA 实时数据"
      : state === "stale" ? "最后一次真实数据已延迟" : "华为云设备长时间未上报",
    auxiliaryReadings,
  };
}

function mapHuaweiShadow(response: HuaweiShadowResponse, forceCached = false): TelemetrySlots {
  const config = readAndroidRuntimeConfig();
  const service = response.shadow?.find((item) => item.service_id === config.serviceId);
  if (!service?.reported?.properties) {
    throw new Error(`华为云设备影子中没有 ${config.serviceId} 服务的已上报属性`);
  }
  const properties = service.reported.properties;
  const observedAt = parseHuaweiTime(service.reported.event_time);
  const state = dataState(
    observedAt,
    forceCached ? 0 : config.staleAfterMs,
    config.offlineAfterMs,
  );
  return {
    "slot-1": numberSlot("slot-1", `${config.serviceId}.temperature`, "环境温度", numericProperty(properties, "temperature"), "°C", 0, "blue", state, observedAt),
    "slot-2": numberSlot("slot-2", `${config.serviceId}.humidity`, "环境湿度", numericProperty(properties, "humidity"), "%", 0, "cyan", state, observedAt),
    "slot-3": numberSlot("slot-3", `${config.serviceId}.co2`, "二氧化碳", numericProperty(properties, "co2"), "ppm", 0, "green", state, observedAt),
    "slot-4": numberSlot("slot-4", `${config.serviceId}.TVOC`, "TVOC", numericProperty(properties, "TVOC", "tvoc"), "mg/m³", 3, "orange", state, observedAt),
    "slot-5": numberSlot("slot-5", `${config.serviceId}.ch2o`, "甲醛", numericProperty(properties, "ch2o"), "mg/m³", 3, "red", state, observedAt),
    "slot-6": numberSlot(
      "slot-6",
      `${config.serviceId}.lightPercent`,
      "环境光照",
      numericProperty(properties, "lightPercent"),
      "%",
      0,
      "orange",
      state,
      observedAt,
      [{
        sourceKey: `${config.serviceId}.lightRaw`,
        label: "光照原始值",
        value: numericProperty(properties, "lightRaw"),
        unit: "ADC",
        precision: 0,
      }],
    ),
  };
}

async function readSnapshot(signal?: AbortSignal): Promise<DashboardSnapshot> {
  const config = readAndroidRuntimeConfig();
  if (collectionRetryNotBefore > Date.now()) {
    return cachedOrUnavailableSnapshot(
      `${lastCollectionFailure || "华为云设备影子读取失败"}；正在等待网络重试`,
    );
  }
  if (!config.iotConfigured) {
    const message = "Android 构建中缺少华为云 IoTDA 配置";
    beginCollectionBackoff(message);
    persistLocalTelemetry(recordAndroidCollectionFailure(message));
    return unavailableSnapshot(message);
  }
  try {
    const shadow = await readHuaweiShadow(signal) as HuaweiShadowResponse;
    const snapshot: DashboardSnapshot = {
      slots: mapHuaweiShadow(shadow),
      vehicle: createUnavailableVehicle(),
      generatedAt: new Date().toISOString(),
      provider: "huawei-cloud",
      partialErrors: [],
    };
    clearCollectionBackoff();
    window.localStorage.setItem(LAST_REAL_SHADOW_KEY, JSON.stringify(shadow));
    persistLocalTelemetry(
      recordAndroidSnapshot(snapshot)
        .then(() => recordAndroidCollectionRecovery(snapshot.generatedAt)),
    );
    return snapshot;
  } catch (error) {
    if (isExpectedNativeCloudCancellation(error, signal)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "华为云设备影子读取失败";
    beginCollectionBackoff(message);
    const cached = readCachedShadow();
    if (!cached) {
      persistLocalTelemetry(recordAndroidCollectionFailure(error));
      return unavailableSnapshot(message);
    }
    const snapshot: DashboardSnapshot = {
      slots: mapHuaweiShadow(cached, true),
      vehicle: createUnavailableVehicle(),
      generatedAt: new Date().toISOString(),
      provider: "huawei-cloud",
      partialErrors: [{ scope: "slots", message: `${message}；当前显示最后一次真实数据` }],
    };
    persistLocalTelemetry(
      recordAndroidCollectionFailure(error, snapshot.generatedAt)
        .then(() => recordAndroidSnapshot(snapshot)),
    );
    return snapshot;
  }
}

function beginCollectionBackoff(message: string) {
  consecutiveCollectionFailures += 1;
  lastCollectionFailure = message;
  collectionRetryNotBefore = Date.now()
    + androidCollectionRetryDelayMs(consecutiveCollectionFailures);
}

function clearCollectionBackoff() {
  consecutiveCollectionFailures = 0;
  collectionRetryNotBefore = 0;
  lastCollectionFailure = "";
}

function cachedOrUnavailableSnapshot(message: string): DashboardSnapshot {
  const cached = readCachedShadow();
  if (!cached) return unavailableSnapshot(message);
  return {
    slots: mapHuaweiShadow(cached, true),
    vehicle: createUnavailableVehicle(),
    generatedAt: new Date().toISOString(),
    provider: "huawei-cloud",
    partialErrors: [{ scope: "slots", message: `${message}；当前显示最后一次真实数据` }],
  };
}

function persistLocalTelemetry(task: Promise<unknown>) {
  void task.catch(() => undefined);
}

function readCachedShadow(): HuaweiShadowResponse | null {
  try {
    const value = window.localStorage.getItem(LAST_REAL_SHADOW_KEY);
    return value ? JSON.parse(value) as HuaweiShadowResponse : null;
  } catch {
    return null;
  }
}

function unavailableSnapshot(message: string): DashboardSnapshot {
  return {
    slots: createUnavailableSlots(message),
    vehicle: createUnavailableVehicle(),
    generatedAt: new Date().toISOString(),
    provider: "huawei-cloud",
    partialErrors: [{ scope: "slots", message }],
  };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isVehicleCommand(value: unknown): value is VehicleCommandRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<VehicleCommandRequest>;
  return typeof input.requestId === "string"
    && ["forward", "backward", "left", "right", "stop"].includes(input.motion ?? "")
    && typeof input.speedPercent === "number"
    && input.speedPercent >= 0
    && input.speedPercent <= 100
    && typeof input.issuedAt === "string";
}

async function handleVehicleCommand(input: RequestInfo | URL, init?: RequestInit) {
  let payload: unknown;
  try {
    if (typeof init?.body === "string") payload = JSON.parse(init.body);
    else if (input instanceof Request) payload = await input.clone().json();
  } catch {
    return json({ error: "请求体必须为 JSON" }, 400);
  }
  if (!isVehicleCommand(payload)) return json({ error: "无效的小车控制指令" }, 400);
  const ack: VehicleCommandAck = {
    requestId: payload.requestId,
    commandId: `android-${crypto.randomUUID()}`,
    status: "rejected",
    acknowledgedAt: new Date().toISOString(),
    message: "车辆控制必须通过当前 Android 设备与 Jetson 的局域网 WebSocket 发送。",
  };
  return json(ack, 409);
}

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof Request) return new URL(input.url, window.location.href);
  return new URL(String(input), window.location.href);
}

/** Installs real Android transports while keeping the existing Web API shape. */
export function installOfflineIotProvider() {
  const config = readAndroidRuntimeConfig();
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.origin === window.location.origin && url.pathname === "/api/iot/snapshot") {
      return json(await readSnapshot(init?.signal ?? (input instanceof Request ? input.signal : undefined)));
    }
    if (url.origin === window.location.origin && url.pathname === "/api/iot/vehicle/commands") {
      return handleVehicleCommand(input, init);
    }
    if (url.href.startsWith(`${config.deepSeekBaseUrl.replace(/\/$/, "")}/`)) {
      return nativeDeepSeekFetch(init);
    }
    return nativeFetch(input, init);
  };
}
