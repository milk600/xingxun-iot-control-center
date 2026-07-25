import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AgentGatewayConfig {
  port: number;
  deepSeekApiKey: string;
  dashScopeApiKey: string;
  workspaceId: string;
  model: "deepseek-v4-flash";
  telemetryAnalysisModel: "deepseek-v4-flash";
  telemetryAnalysisReasoningEffort: "high" | "max";
  asrModel: string;
  deepSeekBaseUrl: string;
  asrWebSocketUrl: string;
  iotWebBaseUrl: string;
  jetsonWsUrl: string;
  vehicleEnabled: boolean;
  fullAccess?: boolean;
  allowLocalAutoPair: boolean;
  mockMode: boolean;
  reasoningMode: "always";
}

export function loadLocalEnv(cwd = process.cwd()) {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = resolve(cwd, fileName);
    if (!existsSync(filePath)) continue;
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const equals = trimmed.indexOf("=");
      if (equals <= 0) continue;
      const key = trimmed.slice(0, equals).trim();
      const value = trimmed.slice(equals + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export function readAgentGatewayConfig(): AgentGatewayConfig {
  loadLocalEnv();
  loadDashScopeCredentialsFile();
  const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID?.trim() ?? "";
  const asrBase = workspaceId
    ? `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`
    : "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

  return {
    port: positiveInteger(process.env.AI_GATEWAY_PORT, 8766),
    deepSeekApiKey: process.env.DEEPSEEK_API_KEY?.trim() ?? "",
    dashScopeApiKey: process.env.DASHSCOPE_API_KEY?.trim() ?? "",
    workspaceId,
    model: "deepseek-v4-flash",
    telemetryAnalysisModel: "deepseek-v4-flash",
    telemetryAnalysisReasoningEffort: telemetryAnalysisReasoningEffort(
      process.env.DEEPSEEK_ANALYSIS_REASONING_EFFORT,
    ),
    asrModel: process.env.FUN_ASR_MODEL?.trim() || "fun-asr-realtime",
    deepSeekBaseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
    asrWebSocketUrl: process.env.FUN_ASR_WS_URL?.trim() || asrBase,
    iotWebBaseUrl: process.env.IOT_WEB_BASE_URL?.trim() || "http://localhost:3000",
    jetsonWsUrl: process.env.JETSON_WS_URL?.trim() || "ws://127.0.0.1:8765",
    vehicleEnabled: booleanValue(process.env.AI_VEHICLE_ENABLED, true),
    fullAccess: booleanValue(process.env.AI_FULL_ACCESS, true),
    allowLocalAutoPair: booleanValue(process.env.AI_ALLOW_LOCAL_AUTO_PAIR, true),
    mockMode: booleanValue(process.env.AI_MOCK_MODE, false),
    reasoningMode: "always",
  };
}

function telemetryAnalysisReasoningEffort(
  value: string | undefined,
): AgentGatewayConfig["telemetryAnalysisReasoningEffort"] {
  return value?.trim() === "max" ? "max" : "high";
}

function loadDashScopeCredentialsFile() {
  const configuredPath = process.env.DASHSCOPE_CREDENTIALS_FILE?.trim();
  if (!configuredPath) return;

  const filePath = resolve(configuredPath);
  if (!existsSync(filePath)) {
    throw new Error(`DASHSCOPE_CREDENTIALS_FILE 不存在: ${filePath}`);
  }

  const rows = readFileSync(filePath, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseCsvRow);
  const values = Object.fromEntries(
    rows.slice(1).flatMap((row) => {
      const key = row[0]?.trim();
      const value = row[1]?.trim();
      return key && value ? [[key, value]] : [];
    }),
  );

  if (!process.env.DASHSCOPE_API_KEY && values.apiKey) {
    process.env.DASHSCOPE_API_KEY = values.apiKey;
  }
  if (!process.env.DASHSCOPE_WORKSPACE_ID && values.workspaceId) {
    process.env.DASHSCOPE_WORKSPACE_ID = values.workspaceId;
  }
}

function parseCsvRow(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}
