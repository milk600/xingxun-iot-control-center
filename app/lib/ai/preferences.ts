import {
  normalizeAgentReasoningEffort,
  normalizeAgentThinkingMode,
  type AgentReasoningEffort,
  type AgentThinkingMode,
  type ClientRole,
} from "./contracts";

export const AI_PREFERENCES_KEY = "xingxun:ai-control:v2";
const LEGACY_AI_PREFERENCES_KEY = "xingxun:ai-control:v1";
export const AI_PREFERENCES_EVENT = "xingxun:ai-preferences";

export interface AiClientPreferences {
  gatewayUrl: string;
  pairingToken: string;
  clientRole: ClientRole;
  voicePlaybackEnabled: boolean;
  thinkingMode: AgentThinkingMode;
  reasoningEffort: AgentReasoningEffort;
  realVehicleEnabled: boolean;
  alertWorkOrderAutomationEnabled: boolean;
}

function defaultGatewayUrl() {
  if (typeof window === "undefined") return "ws://127.0.0.1:8766";
  const androidOffline = window.location.hostname === "xingxun.local";
  return androidOffline ? "ws://xingxun.local/agent" : `ws://${window.location.hostname || "127.0.0.1"}:8766`;
}

export function defaultAiClientPreferences(): AiClientPreferences {
  const androidOffline = typeof window !== "undefined" && window.location.hostname === "xingxun.local";
  return {
    gatewayUrl: defaultGatewayUrl(),
    pairingToken: "",
    clientRole: androidOffline ? "standalone" : "display",
    voicePlaybackEnabled: true,
    thinkingMode: "thinking",
    reasoningEffort: "high",
    realVehicleEnabled: true,
    alertWorkOrderAutomationEnabled: true,
  };
}

export function readAiClientPreferences(): AiClientPreferences {
  const defaults = defaultAiClientPreferences();
  if (typeof window === "undefined") return defaults;
  try {
    const current = window.localStorage.getItem(AI_PREFERENCES_KEY);
    const legacy = current ? null : window.localStorage.getItem(LEGACY_AI_PREFERENCES_KEY);
    const raw = current ?? legacy;
    if (!raw) return defaults;
    const migratingLegacyPreferences = !current && Boolean(legacy);
    const value = JSON.parse(raw) as Partial<AiClientPreferences>;
    if (typeof window !== "undefined" && window.location.hostname === "xingxun.local") {
      return {
        ...defaults,
        voicePlaybackEnabled: value.voicePlaybackEnabled !== false,
        thinkingMode: normalizeAgentThinkingMode(value.thinkingMode),
        reasoningEffort: normalizeAgentReasoningEffort(value.reasoningEffort),
        realVehicleEnabled: migratingLegacyPreferences ? true : value.realVehicleEnabled !== false,
        alertWorkOrderAutomationEnabled: migratingLegacyPreferences
          ? true
          : value.alertWorkOrderAutomationEnabled !== false,
      };
    }
    const gatewayUrl = typeof value.gatewayUrl === "string" && /^wss?:\/\//i.test(value.gatewayUrl.trim())
      ? value.gatewayUrl.trim()
      : defaults.gatewayUrl;
    const role = value.clientRole;
    return {
      gatewayUrl,
      pairingToken: typeof value.pairingToken === "string" ? value.pairingToken : "",
      clientRole: role === "display" || role === "remote" || role === "standalone" ? role : defaults.clientRole,
      voicePlaybackEnabled: value.voicePlaybackEnabled !== false,
      thinkingMode: normalizeAgentThinkingMode(value.thinkingMode),
      reasoningEffort: normalizeAgentReasoningEffort(value.reasoningEffort),
      realVehicleEnabled: migratingLegacyPreferences ? true : value.realVehicleEnabled !== false,
      alertWorkOrderAutomationEnabled: migratingLegacyPreferences
        ? true
        : value.alertWorkOrderAutomationEnabled !== false,
    };
  } catch {
    return defaults;
  }
}

export function saveAiClientPreferences(value: AiClientPreferences) {
  window.localStorage.setItem(AI_PREFERENCES_KEY, JSON.stringify(value));
  window.dispatchEvent(new Event(AI_PREFERENCES_EVENT));
}
