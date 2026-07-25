export interface AgentRequestAttempt {
  requestId: string;
  text: string;
}

export interface RetryableAgentRequest {
  requestId: string;
  instruction: string;
}

export type AgentRequestIdFactory = () => string;

export function createAgentRequestAttempt(
  text: string,
  createRequestId: AgentRequestIdFactory = () => crypto.randomUUID(),
): AgentRequestAttempt | null {
  const cleanText = text.trim();
  if (!cleanText) return null;
  const requestId = createRequestId().trim();
  if (!requestId) throw new Error("Agent requestId 不能为空");
  return { requestId, text: cleanText };
}

export function retryableVoiceInstruction(
  phase: unknown,
  transcript: unknown,
): string | null {
  if (phase !== "understanding" || typeof transcript !== "string") return null;
  const cleanText = transcript.trim();
  return cleanText || null;
}

export function retryableAgentRequest(
  requestId: unknown,
  instruction: unknown,
): RetryableAgentRequest | null {
  if (typeof requestId !== "string" || typeof instruction !== "string") return null;
  const cleanRequestId = requestId.trim();
  const cleanInstruction = instruction.trim();
  if (!cleanRequestId || !cleanInstruction) return null;
  return {
    requestId: cleanRequestId,
    instruction: cleanInstruction,
  };
}

export function clearRetryableAgentRequest(
  current: RetryableAgentRequest | null,
  successfulRequestId: unknown,
) {
  if (
    !current
    || typeof successfulRequestId !== "string"
    || current.requestId !== successfulRequestId.trim()
  ) return current;
  return null;
}

export function shouldRetryAfterVehiclePendingCleared(reason: unknown) {
  if (typeof reason !== "string") return false;
  const cleanReason = reason.trim();
  return Boolean(cleanReason) && cleanReason !== "已确认";
}

export function belongsToCurrentAgentRequest(
  currentRequestId: unknown,
  messageRequestId: unknown,
) {
  const current = typeof currentRequestId === "string" ? currentRequestId.trim() : "";
  if (!current) return true;
  return typeof messageRequestId === "string"
    && messageRequestId.trim() === current;
}

export function shouldOfferAgentRetry(input: {
  hasRetryableRequest: boolean;
  requestInFlight: boolean;
}) {
  return input.hasRetryableRequest && !input.requestInFlight;
}
