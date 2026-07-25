import {
  createUnavailableSlots,
  createUnavailableVehicle,
  type DashboardSnapshot,
} from "@/app/lib/iot/contracts";
import { getIoTProvider } from "@/app/lib/iot/provider-factory.server";
import { readLocalSession, unauthorizedResponse } from "@/app/lib/auth/local-auth.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await readLocalSession(request))) return unauthorizedResponse();
  const provider = getIoTProvider();
  const context = {
    signal: request.signal,
    traceId: crypto.randomUUID(),
  };
  const [slotsResult, vehicleResult] = await Promise.allSettled([
    provider.readTelemetrySlots(context),
    provider.readVehicleTelemetry(context),
  ]);

  const slotsError = slotsResult.status === "rejected"
    ? slotsResult.reason instanceof Error ? slotsResult.reason.message : "传感器数据读取失败"
    : null;
  const vehicleError = vehicleResult.status === "rejected"
    ? vehicleResult.reason instanceof Error ? vehicleResult.reason.message : "车辆数据读取失败"
    : null;

  const snapshot: DashboardSnapshot = {
    slots: slotsResult.status === "fulfilled"
      ? slotsResult.value
      : createUnavailableSlots(slotsError ?? "传感器数据读取失败"),
    vehicle: vehicleResult.status === "fulfilled"
      ? vehicleResult.value
      : createUnavailableVehicle(),
    generatedAt: new Date().toISOString(),
    provider: provider.kind,
    partialErrors: [
      ...(slotsError ? [{ scope: "slots" as const, message: slotsError }] : []),
      ...(vehicleError ? [{ scope: "vehicle" as const, message: vehicleError }] : []),
    ],
  };

  return Response.json(snapshot, {
    headers: { "cache-control": "no-store" },
  });
}
