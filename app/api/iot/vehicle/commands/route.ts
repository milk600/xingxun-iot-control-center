import type {
  VehicleCommandRequest,
  VehicleMotion,
} from "@/app/lib/iot/contracts";
import { getIoTProvider } from "@/app/lib/iot/provider-factory.server";
import { readLocalSession, unauthorizedResponse } from "@/app/lib/auth/local-auth.server";

const allowedMotions = new Set<VehicleMotion>([
  "forward",
  "backward",
  "left",
  "right",
  "stop",
]);

function isCommand(value: unknown): value is VehicleCommandRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<VehicleCommandRequest>;
  return Boolean(
    input.requestId &&
      typeof input.requestId === "string" &&
      input.motion &&
      allowedMotions.has(input.motion) &&
      typeof input.speedPercent === "number" &&
      input.speedPercent >= 0 &&
      input.speedPercent <= 100 &&
      input.issuedAt &&
      typeof input.issuedAt === "string",
  );
}

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "请求体必须为 JSON" }, { status: 400 });
  }

  if (!isCommand(payload)) {
    return Response.json(
      { error: "无效的小车控制指令" },
      { status: 400 },
    );
  }

  const normalized: VehicleCommandRequest = {
    ...payload,
    speedPercent: payload.motion === "stop" ? 0 : payload.speedPercent,
  };

  // A stop command remains available even when the session has just expired.
  // This preserves the local emergency-stop safety boundary during logout.
  if (normalized.motion !== "stop" && !(await readLocalSession(request))) {
    return unauthorizedResponse();
  }

  try {
    const ack = await getIoTProvider().sendVehicleCommand(normalized, {
      signal: request.signal,
      traceId: payload.requestId,
    });
    return Response.json(ack, {
      status: ack.status === "rejected" ? 409 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "控制接口暂不可用",
      },
      { status: 503 },
    );
  }
}
