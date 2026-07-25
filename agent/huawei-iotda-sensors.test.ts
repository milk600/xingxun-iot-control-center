import assert from "node:assert/strict";
import test from "node:test";
import { HuaweiIoTDASensorSource } from "../app/lib/iot/providers/huawei-iotda-sensors.server";

test("并发即时读取与后台采集共用同一次华为云设备影子请求", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCount = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async () => {
    fetchCount += 1;
    await gate;
    return new Response(JSON.stringify({
      device_id: "device-1",
      shadow: [{
        service_id: "sensor",
        reported: {
          event_time: new Date().toISOString(),
          properties: { temperature: 25 },
        },
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const source = new HuaweiIoTDASensorSource({
    endpoint: "https://iot.example.invalid",
    projectId: "project-1",
    deviceId: "device-1",
    serviceId: "sensor",
    token: "test-token",
    requestCacheMs: 0,
  });
  const first = source.readTelemetrySlots({
    traceId: "collector",
    signal: AbortSignal.timeout(2_000),
  });
  const second = source.readTelemetrySlots({
    traceId: "inspection",
    signal: AbortSignal.timeout(2_000),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(fetchCount, 1);
});
