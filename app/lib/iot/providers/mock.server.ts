import type {
  TelemetryAuxiliaryReading,
  TelemetrySlot,
  TelemetrySlotId,
  TelemetrySlots,
  VehicleCommandAck,
  VehicleCommandRequest,
  VehicleTelemetry,
} from "../contracts";
import { createUnavailableVehicle } from "../contracts";
import type { IoTProvider } from "../provider.server";

function oscillate(base: number, spread: number, speed = 1) {
  return base + Math.sin((Date.now() / 10_000) * speed) * spread;
}

function numberSlot(
  slotId: TelemetrySlotId,
  sourceKey: string,
  label: string,
  value: number,
  unit: string,
  precision: number,
  tone: TelemetrySlot["tone"],
  supportingText: string,
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
    state: "live",
    observedAt: new Date().toISOString(),
    supportingText,
    auxiliaryReadings,
  };
}

export class MockIoTProvider implements IoTProvider {
  readonly kind = "mock" as const;

  async readTelemetrySlots(): Promise<TelemetrySlots> {
    const lightPercent = Math.max(0, Math.min(100, Math.round(oscillate(62, 12, 0.35))));
    const lightRaw = Math.round((lightPercent / 100) * 4095);

    return {
      "slot-1": numberSlot(
        "slot-1",
        "mock.environment.temperature",
        "环境温度",
        oscillate(23.6, 0.7),
        "°C",
        1,
        "blue",
        "演示数据 · 华为云属性待映射",
      ),
      "slot-2": numberSlot(
        "slot-2",
        "mock.environment.humidity",
        "环境湿度",
        oscillate(48, 2.4, 0.6),
        "%",
        0,
        "cyan",
        "演示数据 · 华为云属性待映射",
      ),
      "slot-3": numberSlot(
        "slot-3",
        "mock.environment.co2",
        "二氧化碳",
        oscillate(620, 35, 0.4),
        "ppm",
        0,
        "green",
        "演示数据 · 华为云属性待映射",
      ),
      "slot-4": numberSlot(
        "slot-4",
        "mock.environment.TVOC",
        "TVOC",
        oscillate(0.18, 0.025, 0.8),
        "mg/m³",
        3,
        "orange",
        "演示数据 · 华为云属性待映射",
      ),
      "slot-5": numberSlot(
        "slot-5",
        "mock.environment.ch2o",
        "甲醛",
        oscillate(0.035, 0.004, 0.7),
        "mg/m³",
        3,
        "red",
        "演示数据 · 华为云属性待映射",
      ),
      "slot-6": numberSlot(
        "slot-6",
        "mock.environment.lightPercent",
        "环境光照",
        lightPercent,
        "%",
        0,
        "orange",
        "演示数据 · 华为云属性待映射",
        [{
          sourceKey: "mock.environment.lightRaw",
          label: "光照原始值",
          value: lightRaw,
          unit: "ADC",
          precision: 0,
        }],
      ),
    };
  }

  async readVehicleTelemetry(): Promise<VehicleTelemetry> {
    return createUnavailableVehicle();
  }

  async sendVehicleCommand(
    input: VehicleCommandRequest,
  ): Promise<VehicleCommandAck> {
    return {
      requestId: input.requestId,
      commandId: `not-issued-${crypto.randomUUID()}`,
      status: "rejected",
      acknowledgedAt: new Date().toISOString(),
      message: "演示数据源不会发送车辆指令，请连接真实 Jetson 控制链路。",
    };
  }
}

export const mockIoTProvider = new MockIoTProvider();
