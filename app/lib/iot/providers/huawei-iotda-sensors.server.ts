import type {
  DataState,
  TelemetryAuxiliaryReading,
  TelemetrySlot,
  TelemetrySlotId,
  TelemetrySlots,
} from "../contracts";
import type { ProviderContext } from "../provider.server";
import type { IoTDAClient } from "@huaweicloud/huaweicloud-sdk-iotda";

interface HuaweiIoTDAIamConfig {
  endpoint: string;
  accountName: string;
  username: string;
  password: string;
  projectName: string;
}

interface HuaweiIoTDAAkSkConfig {
  regionId: string;
  credentialFile?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface HuaweiIoTDASensorConfig {
  endpoint: string;
  projectId: string;
  deviceId: string;
  serviceId: string;
  instanceId?: string;
  token?: string;
  iam?: HuaweiIoTDAIamConfig;
  akSk?: HuaweiIoTDAAkSkConfig;
  staleAfterMs?: number;
  offlineAfterMs?: number;
  requestCacheMs?: number;
}

interface HuaweiShadowProperties {
  properties?: Record<string, unknown>;
  event_time?: string;
}

interface HuaweiShadowService {
  service_id?: string;
  reported?: HuaweiShadowProperties;
}

interface HuaweiShadowResponse {
  device_id?: string;
  shadow?: HuaweiShadowService[];
}

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

interface CachedShadow {
  value: HuaweiShadowResponse;
  fetchedAtMs: number;
}

interface HuaweiAccessKeyCredential {
  accessKeyId: string;
  secretAccessKey: string;
}

const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_OFFLINE_AFTER_MS = 90_000;
// The collector already serializes reads and controls their cadence. A
// provider-side positive cache would silently turn a configured one-second
// poll into fewer real IoTDA requests, so cache reuse is opt-in only.
const DEFAULT_REQUEST_CACHE_MS = 0;

function parseCsvRow(row: string) {
  const fields: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("华为云凭据 CSV 包含未闭合的引号");
  fields.push(field.trim());
  return fields;
}

function normalizeCredentialHeader(value: string) {
  return value.replace(/^\uFEFF/, "").replace(/[\s_-]/g, "").toLowerCase();
}

export function parseHuaweiCredentialCsv(csv: string): HuaweiAccessKeyCredential {
  const rows = csv.split(/\r?\n/).filter((row) => row.trim().length > 0);
  if (rows.length < 2) throw new Error("华为云凭据 CSV 中没有可用的凭据记录");

  const headers = parseCsvRow(rows[0]).map(normalizeCredentialHeader);
  const values = parseCsvRow(rows[1]);
  const accessKeyIndex = headers.findIndex((header) => header === "accesskeyid" || header === "ak");
  const secretKeyIndex = headers.findIndex((header) => header === "secretaccesskey" || header === "sk");
  const accessKeyId = values[accessKeyIndex]?.trim();
  const secretAccessKey = values[secretKeyIndex]?.trim();

  if (accessKeyIndex < 0 || secretKeyIndex < 0 || !accessKeyId || !secretAccessKey) {
    throw new Error("华为云凭据 CSV 缺少 Access Key Id 或 Secret Access Key");
  }
  return { accessKeyId, secretAccessKey };
}

function cleanBaseUrl(value: string, label: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} 不是有效 URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} 必须使用 HTTPS`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function parseHuaweiTime(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(value);
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function numericProperty(properties: Record<string, unknown>, key: string) {
  const value = properties[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function numericPropertyAny(properties: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = numericProperty(properties, key);
    if (value !== null) return value;
  }
  return null;
}

function dataState(observedAt: string | null, nowMs: number, staleMs: number, offlineMs: number): DataState {
  if (!observedAt) return "stale";
  const age = Math.max(0, nowMs - Date.parse(observedAt));
  if (age >= offlineMs) return "offline";
  if (age >= staleMs) return "stale";
  return "live";
}

function slot(
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
    supportingText: state === "live" ? "华为云实时数据" : state === "stale" ? "华为云数据更新延迟" : "设备长时间未上报",
    auxiliaryReadings,
  };
}

export function mapHuaweiShadowToSlots(
  response: HuaweiShadowResponse,
  serviceId = "Environment",
  nowMs = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  offlineAfterMs = DEFAULT_OFFLINE_AFTER_MS,
): TelemetrySlots {
  const service = response.shadow?.find((item) => item.service_id === serviceId);
  if (!service?.reported?.properties) {
    throw new Error(`华为云设备影子中没有 ${serviceId} 服务的已上报属性`);
  }

  const properties = service.reported.properties;
  const observedAt = parseHuaweiTime(service.reported.event_time);
  const state = dataState(observedAt, nowMs, staleAfterMs, offlineAfterMs);

  return {
    "slot-1": slot("slot-1", `${serviceId}.temperature`, "环境温度", numericProperty(properties, "temperature"), "°C", 0, "blue", state, observedAt),
    "slot-2": slot("slot-2", `${serviceId}.humidity`, "环境湿度", numericProperty(properties, "humidity"), "%", 0, "cyan", state, observedAt),
    "slot-3": slot("slot-3", `${serviceId}.co2`, "二氧化碳", numericProperty(properties, "co2"), "ppm", 0, "green", state, observedAt),
    "slot-4": slot("slot-4", `${serviceId}.TVOC`, "TVOC", numericPropertyAny(properties, ["TVOC", "tvoc"]), "mg/m³", 3, "orange", state, observedAt),
    "slot-5": slot("slot-5", `${serviceId}.ch2o`, "甲醛", numericProperty(properties, "ch2o"), "mg/m³", 3, "red", state, observedAt),
    "slot-6": slot(
      "slot-6",
      `${serviceId}.lightPercent`,
      "环境光照",
      numericProperty(properties, "lightPercent"),
      "%",
      0,
      "orange",
      state,
      observedAt,
      [{
        sourceKey: `${serviceId}.lightRaw`,
        label: "光照原始值",
        value: numericProperty(properties, "lightRaw"),
        unit: "ADC",
        precision: 0,
      }],
    ),
  };
}

export class HuaweiIoTDASensorSource {
  private readonly config: HuaweiIoTDASensorConfig;
  private readonly endpoint: string;
  private readonly staleAfterMs: number;
  private readonly offlineAfterMs: number;
  private readonly requestCacheMs: number;
  private cachedToken: CachedToken | null = null;
  private cachedShadow: CachedShadow | null = null;
  private sdkClientPromise: Promise<IoTDAClient> | null = null;
  private shadowRequestInFlight: Promise<HuaweiShadowResponse> | null = null;

  constructor(config: HuaweiIoTDASensorConfig) {
    this.config = config;
    this.endpoint = cleanBaseUrl(config.endpoint, "HUAWEI_IOTDA_ENDPOINT");
    this.staleAfterMs = config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.offlineAfterMs = config.offlineAfterMs ?? DEFAULT_OFFLINE_AFTER_MS;
    this.requestCacheMs = config.requestCacheMs ?? DEFAULT_REQUEST_CACHE_MS;
  }

  private async loadAccessKeyCredential(): Promise<HuaweiAccessKeyCredential> {
    const akSk = this.config.akSk;
    if (!akSk) throw new Error("华为云传感器缺少 AK/SK 配置");
    if (akSk.accessKeyId && akSk.secretAccessKey) {
      return { accessKeyId: akSk.accessKeyId, secretAccessKey: akSk.secretAccessKey };
    }
    if (!akSk.credentialFile) {
      throw new Error("华为云传感器缺少 AK/SK 凭据文件路径");
    }

    try {
      const { readFile } = await import("node:fs/promises");
      return parseHuaweiCredentialCsv(await readFile(akSk.credentialFile, "utf8"));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("华为云凭据 CSV")) throw error;
      throw new Error("无法读取华为云 AK/SK 凭据文件", { cause: error });
    }
  }

  private getSdkClient() {
    if (this.sdkClientPromise) return this.sdkClientPromise;
    this.sdkClientPromise = (async () => {
      const [{ BasicCredentials, Region }, { IoTDAClient }] = await Promise.all([
        import("@huaweicloud/huaweicloud-sdk-core"),
        import("@huaweicloud/huaweicloud-sdk-iotda"),
      ]);
      const credential = await this.loadAccessKeyCredential();
      const basicCredentials = new BasicCredentials()
        .withAk(credential.accessKeyId)
        .withSk(credential.secretAccessKey)
        .withProjectId(this.config.projectId);

      // st1 is the standard/enterprise IoTDA endpoint and requires derived signing.
      if (new URL(this.endpoint).hostname.includes(".st1.")) {
        basicCredentials.withDerivedPredicate((request) => (
          BasicCredentials.getDefaultDerivedPredicate(request)
        ));
      }

      return IoTDAClient.newBuilder()
        .withCredential(basicCredentials)
        .withEndpoint(this.endpoint)
        .withRegion(new Region(this.config.akSk!.regionId, this.endpoint))
        .build();
    })();
    return this.sdkClientPromise;
  }

  private async requestShadowWithSdk(context: ProviderContext): Promise<HuaweiShadowResponse> {
    if (context.signal?.aborted) throw context.signal.reason;
    const [{ ShowDeviceShadowRequest }, client] = await Promise.all([
      import("@huaweicloud/huaweicloud-sdk-iotda"),
      this.getSdkClient(),
    ]);
    const request = new ShowDeviceShadowRequest(this.config.deviceId);
    if (this.config.instanceId) request.withInstanceId(this.config.instanceId);
    const response = await client.showDeviceShadow(request);
    if (context.signal?.aborted) throw context.signal.reason;
    return response as unknown as HuaweiShadowResponse;
  }

  private async acquireToken(signal?: AbortSignal) {
    if (this.config.token) return this.config.token;
    if (this.cachedToken && this.cachedToken.expiresAtMs - Date.now() > 5 * 60_000) {
      return this.cachedToken.value;
    }
    if (!this.config.iam) {
      throw new Error("华为云传感器缺少应用侧 Token 或 IAM 用户配置");
    }

    const iamEndpoint = cleanBaseUrl(this.config.iam.endpoint, "HUAWEI_IAM_ENDPOINT");
    const response = await fetch(`${iamEndpoint}/v3/auth/tokens?nocatalog=true`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json;charset=utf-8" },
      body: JSON.stringify({
        auth: {
          identity: {
            methods: ["password"],
            password: {
              user: {
                domain: { name: this.config.iam.accountName },
                name: this.config.iam.username,
                password: this.config.iam.password,
              },
            },
          },
          scope: { project: { name: this.config.iam.projectName } },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`华为云 IAM 鉴权失败（HTTP ${response.status}）`);
    }
    const token = response.headers.get("x-subject-token");
    const body = await response.json().catch(() => ({})) as { token?: { expires_at?: string } };
    if (!token) throw new Error("华为云 IAM 响应缺少 X-Subject-Token");
    const expiresAtMs = Date.parse(body.token?.expires_at ?? "");
    this.cachedToken = {
      value: token,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 23 * 60 * 60_000,
    };
    return token;
  }

  private async requestShadowUncached(context: ProviderContext) {
    const now = Date.now();
    if (this.config.akSk) {
      const value = await this.requestShadowWithSdk(context);
      this.cachedShadow = { value, fetchedAtMs: now };
      return value;
    }

    const token = await this.acquireToken(context.signal);
    const url = `${this.endpoint}/v5/iot/${encodeURIComponent(this.config.projectId)}/devices/${encodeURIComponent(this.config.deviceId)}/shadow`;
    const headers: Record<string, string> = {
      "content-type": "application/json;charset=utf-8",
      "x-auth-token": token,
      "x-trace-id": context.traceId,
    };
    if (this.config.instanceId) headers["instance-id"] = this.config.instanceId;

    let response = await fetch(url, { signal: context.signal, headers, cache: "no-store" });
    if (response.status === 401 && !this.config.token && this.config.iam) {
      this.cachedToken = null;
      headers["x-auth-token"] = await this.acquireToken(context.signal);
      response = await fetch(url, { signal: context.signal, headers, cache: "no-store" });
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error_msg?: string };
      throw new Error(payload.error_msg || `华为云设备影子读取失败（HTTP ${response.status}）`);
    }
    const value = await response.json() as HuaweiShadowResponse;
    this.cachedShadow = { value, fetchedAtMs: now };
    return value;
  }

  private async requestShadow(context: ProviderContext) {
    const now = Date.now();
    if (this.cachedShadow && now - this.cachedShadow.fetchedAtMs < this.requestCacheMs) {
      return this.cachedShadow.value;
    }
    if (context.signal?.aborted) throw context.signal.reason;
    if (!this.shadowRequestInFlight) {
      const request = this.requestShadowUncached(context);
      this.shadowRequestInFlight = request;
      void request.finally(() => {
        if (this.shadowRequestInFlight === request) this.shadowRequestInFlight = null;
      }).catch(() => undefined);
    }
    return this.shadowRequestInFlight;
  }

  async readTelemetrySlots(context: ProviderContext): Promise<TelemetrySlots> {
    try {
      const shadow = await this.requestShadow(context);
      return mapHuaweiShadowToSlots(
        shadow,
        this.config.serviceId,
        Date.now(),
        this.staleAfterMs,
        this.offlineAfterMs,
      );
    } catch (error) {
      if (!this.cachedShadow) throw error;
      return mapHuaweiShadowToSlots(
        this.cachedShadow.value,
        this.config.serviceId,
        Date.now(),
        0,
        this.offlineAfterMs,
      );
    }
  }
}
