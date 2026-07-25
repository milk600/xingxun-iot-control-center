import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { createAgentEnvelope, type AgentEnvelope } from "../app/lib/ai/contracts";
import type { AgentGatewayConfig } from "./config";
import { startAgentGateway } from "./gateway";

test("网关权限与 Jetson 终态回执共同决定车辆 Agent 的真实结果", { timeout: 15_000 }, async () => {
  process.env.TELEMETRY_HISTORY_DB = ":memory:";
  process.env.IOT_PROVIDER = "mock";
  const jetsonCommands: Record<string, unknown>[] = [];
  const jetson = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await onceListening(jetson);
  jetson.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const command = JSON.parse(raw.toString()) as Record<string, unknown>;
      jetsonCommands.push(command);
      const requestId = String(command.request_id ?? "missing");
      if (command.cmd === "move_distance") {
        socket.send(JSON.stringify({ type: "control", request_id: requestId, kind: "distance", state: "started" }));
        socket.send(JSON.stringify({
          type: "control",
          request_id: requestId,
          kind: "distance",
          state: "completed",
          measured_distance_mm: 101.5,
          final_error_mm: -1.5,
          elapsed_ms: 720,
        }));
      } else if (command.cmd === "turn_angle") {
        socket.send(JSON.stringify({
          type: "control",
          request_id: requestId,
          kind: "turn",
          state: "failed",
          error: "IMU 反馈超时",
        }));
      } else if (command.cmd === "stop") {
        socket.send(JSON.stringify({ type: "control", request_id: requestId, kind: "stop", state: "stopped" }));
      }
    });
  });

  const gatewayPort = await freePort();
  const jetsonAddress = jetson.address();
  if (typeof jetsonAddress === "string" || jetsonAddress === null) throw new Error("Jetson 测试端口不可用");
  const gateway = startAgentGateway(testConfig(gatewayPort, `ws://127.0.0.1:${jetsonAddress.port}`));
  const direct = await TestGatewayClient.connect(gatewayPort, true);
  const confirmation = await TestGatewayClient.connect(gatewayPort, false);
  try {
    const completed = await direct.action("vehicle.move_distance", {
      direction: "forward",
      distanceMm: 100,
      maxSpeedMmps: 300,
    });
    assert.equal(completed.type, "action.accepted");
    assert.match(String(completed.payload.text), /Jetson 已确认前进 100mm完成/);
    assert.match(String(completed.payload.text), /实测 101.5mm/);

    const failed = await direct.action("vehicle.turn_angle", {
      direction: "left",
      angleDeg: 90,
      maxSpeedMmps: 300,
    });
    assert.equal(failed.type, "agent.error");
    assert.match(String(failed.payload.message), /未完成.*IMU 反馈超时/);

    const beforeConfirmation = jetsonCommands.length;
    const pending = await confirmation.action("vehicle.move_distance", {
      direction: "backward",
      distanceMm: 100,
      maxSpeedMmps: 300,
    });
    assert.equal(pending.type, "action.accepted");
    assert.match(String(pending.payload.text), /等待二次确认；尚未向 Jetson 发送命令/);
    assert.equal(jetsonCommands.length, beforeConfirmation);
  } finally {
    await gateway.close();
    await new Promise<void>((resolve) => jetson.close(() => resolve()));
  }
});

test("空闲客户端的自动停车与断开不会唤醒 Jetson 连接", { timeout: 15_000 }, async () => {
  process.env.TELEMETRY_HISTORY_DB = ":memory:";
  process.env.IOT_PROVIDER = "mock";
  const jetsonCommands: Record<string, unknown>[] = [];
  const jetson = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await onceListening(jetson);
  jetson.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const command = JSON.parse(raw.toString()) as Record<string, unknown>;
      jetsonCommands.push(command);
      if (command.cmd !== "stop") return;
      socket.send(JSON.stringify({
        type: "control",
        request_id: command.request_id,
        kind: "stop",
        state: "stopped",
      }));
    });
  });

  const gatewayPort = await freePort();
  const jetsonAddress = jetson.address();
  if (typeof jetsonAddress === "string" || jetsonAddress === null) throw new Error("Jetson 测试端口不可用");
  const gateway = startAgentGateway(testConfig(gatewayPort, `ws://127.0.0.1:${jetsonAddress.port}`));
  const client = await TestGatewayClient.connect(gatewayPort, true);
  try {
    client.automaticStop();
    await delay(120);
    assert.deepEqual(jetsonCommands, [], "没有活动车辆任务时，页面隐藏不应连接 Jetson");

    await client.close();
    await delay(120);
    assert.deepEqual(jetsonCommands, [], "只有车辆权限但没有活动任务时，客户端断开不应连接 Jetson");
  } finally {
    await gateway.close();
    await new Promise<void>((resolve) => jetson.close(() => resolve()));
  }
});

class TestGatewayClient {
  private constructor(
    private readonly socket: WebSocket,
    private readonly id: string,
  ) {}

  static async connect(port: number, realVehicleEnabled: boolean) {
    const id = `gateway-test-${crypto.randomUUID()}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("测试客户端连接网关超时")), 3_000);
      socket.once("open", () => {
        socket.send(JSON.stringify(createAgentEnvelope("client.hello", id, "gateway", {
          role: "remote",
          name: "gateway-vehicle-test",
          token: "",
          realVehicleEnabled,
        })));
      });
      const ready = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as AgentEnvelope;
        if (message.type !== "gateway.ready" && message.type !== "pair.accepted") return;
        clearTimeout(timer);
        socket.off("message", ready);
        resolve();
      };
      socket.on("message", ready);
      socket.once("error", reject);
    });
    return new TestGatewayClient(socket, id);
  }

  action(name: string, argumentsValue: Record<string, unknown>) {
    return new Promise<AgentEnvelope<string, Record<string, unknown>>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${name} 结果超时`)), 5_000);
      const receive = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as AgentEnvelope<string, Record<string, unknown>>;
        if (message.type !== "action.accepted" && message.type !== "agent.error") return;
        clearTimeout(timer);
        this.socket.off("message", receive);
        resolve(message);
      };
      this.socket.on("message", receive);
      this.socket.send(JSON.stringify(createAgentEnvelope("action.request", this.id, "gateway", {
        action: { name, arguments: argumentsValue },
      })));
    });
  }

  automaticStop() {
    this.socket.send(JSON.stringify(createAgentEnvelope("vehicle.stop", this.id, "gateway", {
      automatic: true,
    })));
  }

  close() {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close(1000, "test complete");
    });
  }
}

function testConfig(port: number, jetsonWsUrl: string): AgentGatewayConfig {
  return {
    port,
    deepSeekApiKey: "",
    dashScopeApiKey: "",
    workspaceId: "",
    model: "deepseek-v4-flash",
    telemetryAnalysisModel: "deepseek-v4-flash",
    telemetryAnalysisReasoningEffort: "max",
    asrModel: "fun-asr-realtime",
    deepSeekBaseUrl: "https://api.deepseek.com",
    asrWebSocketUrl: "ws://127.0.0.1:1",
    iotWebBaseUrl: "http://127.0.0.1:3000",
    jetsonWsUrl,
    vehicleEnabled: true,
    allowLocalAutoPair: true,
    mockMode: true,
    reasoningMode: "always",
  };
}

function onceListening(server: WebSocketServer) {
  return new Promise<void>((resolve) => server.once("listening", resolve));
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

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
