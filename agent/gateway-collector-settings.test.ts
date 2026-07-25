import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import WebSocket from "ws";
import {
  createAgentEnvelope,
  type AgentEnvelope,
  type ClientRole,
} from "../app/lib/ai/contracts";
import type { AgentGatewayConfig } from "./config";
import { startAgentGateway } from "./gateway";

test("采集设置写权限绑定首次认证角色，remote token 和会话不能自报 display 提权", { timeout: 15_000 }, async () => {
  process.env.TELEMETRY_HISTORY_DB = ":memory:";
  process.env.IOT_PROVIDER = "mock";
  const gatewayPort = await freePort();
  const gateway = startAgentGateway(testConfig(gatewayPort));
  const clients: TestGatewayClient[] = [];

  try {
    const remote = await TestGatewayClient.connect(gatewayPort, "remote");
    clients.push(remote);
    assert.ok(remote.token, "本机自动配对应签发 token");

    await remote.hello("display", remote.token);
    const sameSessionRead = await remote.collectorSettings();
    assert.equal(sameSessionRead.type, "telemetry.collector.settings.result");
    assert.equal(sameSessionRead.payload.canEdit, false);

    const sameSessionWrite = await remote.updateCollectorSettings(3_500);
    assert.equal(sameSessionWrite.type, "telemetry.collector.settings.error");
    assert.match(String(sameSessionWrite.payload.message), /只有电脑显示端可以修改/);

    const reusedRemoteToken = await TestGatewayClient.connect(gatewayPort, "display", remote.token);
    clients.push(reusedRemoteToken);
    const reusedTokenRead = await reusedRemoteToken.collectorSettings();
    assert.equal(reusedTokenRead.type, "telemetry.collector.settings.result");
    assert.equal(reusedTokenRead.payload.canEdit, false);

    const reusedTokenWrite = await reusedRemoteToken.updateCollectorSettings(5_000);
    assert.equal(reusedTokenWrite.type, "telemetry.collector.settings.error");
    assert.match(String(reusedTokenWrite.payload.message), /只有电脑显示端可以修改/);

    const trustedDisplay = await TestGatewayClient.connect(gatewayPort, "display");
    clients.push(trustedDisplay);
    const displayRead = await trustedDisplay.collectorSettings();
    assert.equal(displayRead.type, "telemetry.collector.settings.result");
    assert.equal(displayRead.payload.canEdit, true);

    const displayWrite = await trustedDisplay.updateCollectorSettings(3_500);
    assert.equal(displayWrite.type, "telemetry.collector.settings.result");
    assert.equal(displayWrite.payload.canEdit, true);
    assert.equal(
      (displayWrite.payload.settings as Record<string, unknown>).pollIntervalMs,
      3_500,
    );
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await gateway.close();
  }
});

class TestGatewayClient {
  private constructor(
    private readonly socket: WebSocket,
    private readonly id: string,
    readonly token: string,
  ) {}

  static async connect(port: number, role: ClientRole, token = "") {
    const id = `collector-settings-test-${crypto.randomUUID()}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    let issuedToken = token;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("采集设置测试客户端连接网关超时")), 3_000);
      const receive = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as AgentEnvelope<string, Record<string, unknown>>;
        if (message.type === "pair.accepted" && typeof message.payload.token === "string") {
          issuedToken = message.payload.token;
          return;
        }
        if (message.type !== "gateway.ready") return;
        clearTimeout(timer);
        socket.off("message", receive);
        resolve();
      };
      socket.on("message", receive);
      socket.once("open", () => {
        socket.send(JSON.stringify(createAgentEnvelope("client.hello", id, "gateway", {
          role,
          name: role === "display" ? "采集设置电脑显示端" : "采集设置遥控端",
          token,
        })));
      });
      socket.once("error", reject);
    });
    return new TestGatewayClient(socket, id, issuedToken);
  }

  hello(role: ClientRole, token: string) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待重新握手结果超时")), 3_000);
      const receive = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as AgentEnvelope;
        if (message.type !== "gateway.ready") return;
        clearTimeout(timer);
        this.socket.off("message", receive);
        resolve();
      };
      this.socket.on("message", receive);
      this.socket.send(JSON.stringify(createAgentEnvelope("client.hello", this.id, "gateway", {
        role,
        name: "尝试切换为电脑显示端",
        token,
      })));
    });
  }

  collectorSettings() {
    const requestId = `collector-read-${crypto.randomUUID()}`;
    return this.request(
      "telemetry.collector.settings.request",
      { requestId },
      requestId,
    );
  }

  updateCollectorSettings(pollIntervalMs: number) {
    const requestId = `collector-write-${crypto.randomUUID()}`;
    return this.request(
      "telemetry.collector.settings.update",
      { requestId, pollIntervalMs },
      requestId,
    );
  }

  close() {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close(1000, "test complete");
    });
  }

  private request(
    type: string,
    payload: Record<string, unknown>,
    requestId: string,
  ) {
    return new Promise<AgentEnvelope<string, Record<string, unknown>>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${type} 结果超时`)), 3_000);
      const receive = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as AgentEnvelope<string, Record<string, unknown>>;
        if (
          message.payload.requestId !== requestId
          || (
            message.type !== "telemetry.collector.settings.result"
            && message.type !== "telemetry.collector.settings.error"
          )
        ) return;
        clearTimeout(timer);
        this.socket.off("message", receive);
        resolve(message);
      };
      this.socket.on("message", receive);
      this.socket.send(JSON.stringify(createAgentEnvelope(type, this.id, "gateway", payload)));
    });
  }
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
