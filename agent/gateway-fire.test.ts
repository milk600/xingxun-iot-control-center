import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import WebSocket from "ws";
import {
  createAgentEnvelope,
  type AgentEnvelope,
} from "../app/lib/ai/contracts";
import {
  VEHICLE_FIRE_REPORT_TYPE,
  VEHICLE_FIRE_SOURCE,
} from "../app/lib/iot/fire-detection";
import type { AgentGatewayConfig } from "./config";
import { startAgentGateway } from "./gateway";

test("Jetson 火焰上报经网关生成一条去重严重告警并支持源恢复", { timeout: 15_000 }, async () => {
  process.env.TELEMETRY_HISTORY_DB = ":memory:";
  process.env.IOT_PROVIDER = "mock";
  const port = await freePort();
  const gateway = startAgentGateway(testConfig(port));
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const clientId = `fire-test-${crypto.randomUUID()}`;
  try {
    await waitForOpen(socket);
    socket.send(JSON.stringify(createAgentEnvelope("client.hello", clientId, "gateway", {
      role: "display",
      name: "fire-test-display",
      token: "",
    })));
    await waitForType(socket, "gateway.ready");

    const observedAt = "2026-07-23T10:00:00.000Z";
    const created = await sendAndWait(socket, clientId, VEHICLE_FIRE_REPORT_TYPE, {
      detected: true,
      observedAt,
      source: VEHICLE_FIRE_SOURCE,
    }, "vehicle.fire.reported");
    assert.equal(created.payload.changed, true);

    const duplicate = await sendAndWait(socket, clientId, VEHICLE_FIRE_REPORT_TYPE, {
      detected: true,
      observedAt: "2026-07-23T10:00:01.000Z",
      source: VEHICLE_FIRE_SOURCE,
    }, "vehicle.fire.reported");
    assert.equal(duplicate.payload.changed, false);

    const firstList = await sendAndWait(socket, clientId, "alerts.list.request", {
      requestId: "fire-list-1",
      limit: 20,
    }, "alerts.list.result");
    const firstItems = alertItems(firstList);
    assert.equal(firstItems.length, 1);
    assert.equal(firstItems[0]?.title, "检测到火焰");
    assert.equal(firstItems[0]?.severity, "critical");
    assert.equal(firstItems[0]?.sourceState, "active");

    const resolved = await sendAndWait(socket, clientId, VEHICLE_FIRE_REPORT_TYPE, {
      detected: false,
      observedAt: "2026-07-23T10:00:02.000Z",
      source: VEHICLE_FIRE_SOURCE,
    }, "vehicle.fire.reported");
    assert.equal(resolved.payload.changed, true);

    const secondList = await sendAndWait(socket, clientId, "alerts.list.request", {
      requestId: "fire-list-2",
      limit: 20,
    }, "alerts.list.result");
    assert.equal(alertItems(secondList)[0]?.sourceState, "resolved");
  } finally {
    socket.close(1000, "test complete");
    await gateway.close();
  }
});

function alertItems(message: AgentEnvelope<string, Record<string, unknown>>) {
  const result = message.payload.result as { items?: Array<Record<string, unknown>> } | undefined;
  return result?.items ?? [];
}

function sendAndWait(
  socket: WebSocket,
  clientId: string,
  type: string,
  payload: Record<string, unknown>,
  responseType: string,
) {
  const response = waitForType(socket, responseType);
  socket.send(JSON.stringify(createAgentEnvelope(type, clientId, "gateway", payload)));
  return response;
}

function waitForOpen(socket: WebSocket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接网关超时")), 3_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", reject);
  });
}

function waitForType(socket: WebSocket, type: string) {
  return new Promise<AgentEnvelope<string, Record<string, unknown>>>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", receive);
      reject(new Error(`等待 ${type} 超时`));
    }, 5_000);
    const receive = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as AgentEnvelope<string, Record<string, unknown>>;
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off("message", receive);
      resolve(message);
    };
    socket.on("message", receive);
  });
}

function testConfig(port: number): AgentGatewayConfig {
  return {
    port,
    deepSeekApiKey: "",
    dashScopeApiKey: "",
    workspaceId: "",
    model: "deepseek-v4-flash",
    telemetryAnalysisModel: "deepseek-v4-flash",
    telemetryAnalysisReasoningEffort: "high",
    asrModel: "fun-asr-realtime",
    deepSeekBaseUrl: "https://api.deepseek.com",
    asrWebSocketUrl: "ws://127.0.0.1:1",
    iotWebBaseUrl: "http://127.0.0.1:3000",
    jetsonWsUrl: "ws://127.0.0.1:1",
    vehicleEnabled: false,
    allowLocalAutoPair: true,
    mockMode: true,
    reasoningMode: "always",
  };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("测试网关端口不可用");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
