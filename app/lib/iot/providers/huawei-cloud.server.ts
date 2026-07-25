import type {
  TelemetrySlots,
  VehicleCommandAck,
  VehicleCommandRequest,
  VehicleTelemetry,
} from "../contracts";
import type { IoTProvider, ProviderContext } from "../provider.server";

interface HuaweiCloudGatewayConfig {
  baseUrl: string;
  token: string;
}

/**
 * Server-only adapter reserved for the future Huawei Cloud integration.
 * The trusted gateway is responsible for Huawei authentication and for mapping
 * cloud device properties into the stable DTOs used by this application.
 */
export class HuaweiCloudGatewayProvider implements IoTProvider {
  readonly kind = "huawei-cloud" as const;

  constructor(private readonly config: HuaweiCloudGatewayConfig) {}

  private async request<T>(
    path: string,
    context: ProviderContext,
    init?: RequestInit,
  ): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      signal: context.signal,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "content-type": "application/json",
        "x-trace-id": context.traceId,
        ...init?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`Huawei Cloud gateway returned ${response.status}`);
    }

    return (await response.json()) as T;
  }

  readTelemetrySlots(context: ProviderContext) {
    return this.request<TelemetrySlots>("/telemetry/slots", context);
  }

  readVehicleTelemetry(context: ProviderContext) {
    return this.request<VehicleTelemetry>("/vehicle/telemetry", context);
  }

  sendVehicleCommand(
    input: VehicleCommandRequest,
    context: ProviderContext,
  ) {
    return this.request<VehicleCommandAck>("/vehicle/commands", context, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
}
