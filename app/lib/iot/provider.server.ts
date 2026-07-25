import type {
  TelemetrySlots,
  VehicleCommandAck,
  VehicleCommandRequest,
  VehicleTelemetry,
} from "./contracts";

export interface ProviderContext {
  signal?: AbortSignal;
  traceId: string;
}

export interface IoTProvider {
  readonly kind: "mock" | "huawei-cloud";
  readTelemetrySlots(context: ProviderContext): Promise<TelemetrySlots>;
  readVehicleTelemetry(context: ProviderContext): Promise<VehicleTelemetry>;
  sendVehicleCommand(
    input: VehicleCommandRequest,
    context: ProviderContext,
  ): Promise<VehicleCommandAck>;
}
