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

test("页面动作只有收到严格关联的真实成功回执后才返回 accepted", { timeout: 10_000 }, async () => {
  process.env.TELEMETRY_HISTORY_DB = ":memory:";
  process.env.IOT_PROVIDER = "mock";
  const port = await freePort();
  const gateway = startAgentGateway(testConfig(port));
  const client = await TestGatewayClient.connect(port, "display");
  try {
    const request = client.requestAction("settings.set_voice_playback", { enabled: false });
    const dispatch = await client.next("action.dispatch");
    assert.equal(dispatch.payload.requestId, null);
    assert.equal(dispatch.payload.planId, null);
    assert.equal(dispatch.payload.stepIndex, 0);
    assert.equal(typeof dispatch.payload.actionExecutionId, "string");

    const early = await client.nextAny(["action.accepted", "agent.error"], 120);
    assert.equal(early, null, "没有页面回执时不得提前报告成功");

    client.send("action.result", {
      requestId: null,
      planId: null,
      stepIndex: 0,
      actionExecutionId: dispatch.payload.actionExecutionId,
      actionName: "settings.set_voice_playback",
      status: "success",
      message: "深色主题已真实生效。",
      completedAt: new Date().toISOString(),
    });
    const result = await request;
    assert.equal(result.type, "action.accepted");
    assert.equal(result.payload.text, "深色主题已真实生效。");
  } finally {
    await client.close();
    await gateway.close();
  }
});

test("页面失败或错误关联回执会停止动作且不误报成功", { timeout: 10_000 }, async () => {
  process.env.TELEMETRY_HISTORY_DB = ":memory:";
  process.env.IOT_PROVIDER = "mock";
  const port = await freePort();
  const gateway = startAgentGateway(testConfig(port));
  const client = await TestGatewayClient.connect(port, "display");
  try {
    const failedRequest = client.requestAction("settings.save", {});
    const failedDispatch = await client.next("action.dispatch");
    client.send("action.result", {
      requestId: null,
      planId: null,
      stepIndex: 0,
      actionExecutionId: failedDispatch.payload.actionExecutionId,
      actionName: "settings.save",
      status: "error",
      message: "网关离线，草稿已保留。",
      completedAt: new Date().toISOString(),
    });
    const failed = await failedRequest;
    assert.equal(failed.type, "agent.error");
    assert.match(String(failed.payload.message), /网关离线，草稿已保留/);

    const mismatchedRequest = client.requestAction("settings.set_voice_playback", { enabled: true });
    const mismatchedDispatch = await client.next("action.dispatch");
    client.send("action.result", {
      requestId: null,
      planId: null,
      stepIndex: 99,
      actionExecutionId: mismatchedDispatch.payload.actionExecutionId,
      actionName: "settings.set_voice_playback",
      status: "success",
      message: "这是不能完成当前步骤的旧回执。",
      completedAt: new Date().toISOString(),
    });
    const mismatched = await mismatchedRequest;
    assert.equal(mismatched.type, "agent.error");
    assert.match(String(mismatched.payload.message), /无法关联的完成回执/);
  } finally {
    await client.close();
    await gateway.close();
  }
});

test("遥控端等待电脑页面执行时，显示端断开会立即向遥控端报告失败", { timeout: 10_000 }, async () => {
  process.env.TELEMETRY_HISTORY_DB = ":memory:";
  process.env.IOT_PROVIDER = "mock";
  const port = await freePort();
  const gateway = startAgentGateway(testConfig(port));
  const display = await TestGatewayClient.connect(port, "display");
  const remote = await TestGatewayClient.connect(port, "remote");
  try {
    const request = remote.requestAction("settings.set_voice_playback", { enabled: true });
    await display.next("action.dispatch");
    await display.close();
    const result = await request;
    assert.equal(result.type, "agent.error");
    assert.match(String(result.payload.message), /已断开.*动作已停止/);
  } finally {
    await remote.close();
    await display.close();
    await gateway.close();
  }
});

class TestGatewayClient {
  private readonly inbox: AgentEnvelope<string, Record<string, unknown>>[] = [];
  private readonly waiters = new Set<() => void>();

  private constructor(
    private readonly socket: WebSocket,
    private readonly id: string,
  ) {
    socket.on("message", (raw) => {
      this.inbox.push(JSON.parse(raw.toString()) as AgentEnvelope<string, Record<string, unknown>>);
      for (const notify of this.waiters) notify();
    });
  }

  static async connect(port: number, role: ClientRole) {
    const id = `page-action-test-${role}-${crypto.randomUUID()}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("页面动作测试客户端连接超时")), 3_000);
      const receive = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as AgentEnvelope;
        if (message.type !== "gateway.ready") return;
        clearTimeout(timer);
        socket.off("message", receive);
        resolve();
      };
      socket.on("message", receive);
      socket.once("open", () => {
        socket.send(JSON.stringify(createAgentEnvelope("client.hello", id, "gateway", {
          role,
          name: role === "display" ? "页面动作显示端" : "页面动作遥控端",
          token: "",
        })));
      });
      socket.once("error", reject);
    });
    return new TestGatewayClient(socket, id);
  }

  send(type: string, payload: Record<string, unknown>) {
    this.socket.send(JSON.stringify(createAgentEnvelope(type, this.id, "gateway", payload)));
  }

  requestAction(name: string, argumentsValue: Record<string, unknown>) {
    this.send("action.request", { action: { name, arguments: argumentsValue } });
    return this.nextAny(["action.accepted", "agent.error"], 5_000).then((message) => {
      if (!message) throw new Error(`等待 ${name} 结果超时`);
      return message;
    });
  }

  async next(type: string) {
    const result = await this.nextAny([type], 3_000);
    if (!result) throw new Error(`等待 ${type} 超时`);
    return result;
  }

  async nextAny(types: string[], timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.inbox.findIndex((message) => types.includes(message.type));
      if (index >= 0) return this.inbox.splice(index, 1)[0];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(notify);
          resolve();
        }, Math.min(25, Math.max(1, deadline - Date.now())));
        const notify = () => {
          clearTimeout(timer);
          this.waiters.delete(notify);
          resolve();
        };
        this.waiters.add(notify);
      });
    }
    return null;
  }

  close() {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close(1000, "test complete");
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
    deepSeekBaseUrl: "http://127.0.0.1:1",
    asrWebSocketUrl: "ws://127.0.0.1:1",
    iotWebBaseUrl: "http://127.0.0.1:1",
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
