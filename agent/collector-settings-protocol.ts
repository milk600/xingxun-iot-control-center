import type { TelemetryPollIntervalMs } from "../app/lib/iot/telemetry-history-contracts";
import type { ClientRole } from "../app/lib/ai/contracts";
import { parseTelemetryPollIntervalMs } from "./telemetry-store";

interface CollectorSettingsPayload {
  requestId?: unknown;
  pollIntervalMs?: unknown;
}

export interface CollectorSettingsRequest {
  requestId: string;
}

export interface CollectorSettingsUpdateRequest extends CollectorSettingsRequest {
  pollIntervalMs: TelemetryPollIntervalMs;
}

export function parseCollectorSettingsRequest(payload: CollectorSettingsPayload): CollectorSettingsRequest {
  return { requestId: requiredRequestId(payload.requestId) };
}

export function parseCollectorSettingsUpdateRequest(payload: CollectorSettingsPayload): CollectorSettingsUpdateRequest {
  return {
    requestId: requiredRequestId(payload.requestId),
    pollIntervalMs: parseTelemetryPollIntervalMs(payload.pollIntervalMs),
  };
}

export function canEditCollectorSettings(role: ClientRole) {
  return role === "display";
}

function requiredRequestId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new Error("采集设置请求 ID 无效");
  }
  return value;
}
