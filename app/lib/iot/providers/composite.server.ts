import type {
  VehicleCommandRequest,
} from "../contracts";
import type { IoTProvider, ProviderContext } from "../provider.server";
import type { HuaweiIoTDASensorSource } from "./huawei-iotda-sensors.server";
import type { MockIoTProvider } from "./mock.server";

/**
 * Keeps cloud sensors and the vehicle transport independent. The vehicle side
 * remains on the existing local provider until the Jetson WebSocket is enabled
 * in the browser.
 */
export class CompositeIoTProvider implements IoTProvider {
  readonly kind = "huawei-cloud" as const;

  constructor(
    private readonly sensors: HuaweiIoTDASensorSource,
    private readonly vehicle: MockIoTProvider,
  ) {}

  readTelemetrySlots(context: ProviderContext) {
    return this.sensors.readTelemetrySlots(context);
  }

  readVehicleTelemetry() {
    return this.vehicle.readVehicleTelemetry();
  }

  sendVehicleCommand(input: VehicleCommandRequest) {
    return this.vehicle.sendVehicleCommand(input);
  }
}
