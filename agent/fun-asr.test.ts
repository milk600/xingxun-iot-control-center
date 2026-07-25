import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentGatewayConfig } from "./config";
import { FunAsrSession } from "./fun-asr";

const TEST_TIMING = {
  connectTimeoutMs: 500,
  startTimeoutMs: 250,
  finishTimeoutMs: 200,
};

test("Fun-ASR 正常流程只发布一次完成态并保留最终文本", async (context) => {
  const server = await loopbackServer(context);
  let taskId = "";
  server.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(String(data)) as { header?: { action?: string; task_id?: string } };
      if (message.header?.action === "run-task") {
        taskId = message.header.task_id ?? "";
        socket.send(event("task-started"));
        return;
      }
      if (message.header?.action === "finish-task") {
        socket.send(result("前往油桶", true));
        socket.send(event("task-finished"));
        socket.send(event("task-finished"));
      }
    });
  });

  let ready = 0;
  let finished = 0;
  let errors = 0;
  const completed = Promise.withResolvers<string>();
  const session = new FunAsrSession(configFor(server), {
    onReady: () => {
      ready += 1;
      session.pushAudio(Buffer.from([1, 2, 3, 4]));
      session.finish();
    },
    onPartial: () => undefined,
    onFinal: () => undefined,
    onFinished: (text) => {
      finished += 1;
      completed.resolve(text);
    },
    onError: (error) => {
      errors += 1;
      completed.reject(error);
    },
  }, TEST_TIMING);

  session.start();
  assert.equal(await completed.promise, "前往油桶");
  await delay(20);
  assert.ok(taskId);
  assert.equal(ready, 1);
  assert.equal(finished, 1);
  assert.equal(errors, 0);
});

test("Fun-ASR 快速松手且没有音频时立即以空文本完成", async () => {
  let finished = 0;
  let errors = 0;
  let transcript: string | null = null;
  const config = {
    ...baseConfig,
    dashScopeApiKey: "test-key",
    asrWebSocketUrl: "ws://127.0.0.1:1",
  };
  const session = new FunAsrSession(config, {
    onReady: () => undefined,
    onPartial: () => undefined,
    onFinal: () => undefined,
    onFinished: (text) => {
      finished += 1;
      transcript = text;
    },
    onError: () => {
      errors += 1;
    },
  }, TEST_TIMING);

  session.start();
  session.finish();
  await delay(20);
  assert.equal(transcript, "");
  assert.equal(finished, 1);
  assert.equal(errors, 0);
});

test("Fun-ASR task-started 缺失时由启动看门狗准确结束", async (context) => {
  const server = await loopbackServer(context);
  server.on("connection", (socket) => socket.on("message", () => undefined));
  const terminal = Promise.withResolvers<Error>();
  let errors = 0;
  let finished = 0;
  const session = new FunAsrSession(configFor(server), {
    onReady: () => undefined,
    onPartial: () => undefined,
    onFinal: () => undefined,
    onFinished: () => {
      finished += 1;
    },
    onError: (error) => {
      errors += 1;
      terminal.resolve(error);
    },
  }, TEST_TIMING);

  session.start();
  assert.match((await terminal.promise).message, /启动超时/);
  await delay(20);
  assert.equal(errors, 1);
  assert.equal(finished, 0);
});

test("Fun-ASR 完成帧缺失时使用最近识别文本并只完成一次", async (context) => {
  const server = await loopbackServer(context);
  server.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(String(data)) as { header?: { action?: string } };
      if (message.header?.action !== "run-task") return;
      socket.send(event("task-started"));
      socket.send(result("检查油桶", false));
    });
  });
  const terminal = Promise.withResolvers<string>();
  let finished = 0;
  let errors = 0;
  const session = new FunAsrSession(configFor(server), {
    onReady: () => session.finish(),
    onPartial: () => undefined,
    onFinal: () => undefined,
    onFinished: (text) => {
      finished += 1;
      terminal.resolve(text);
    },
    onError: (error) => {
      errors += 1;
      terminal.reject(error);
    },
  }, TEST_TIMING);

  session.start();
  assert.equal(await terminal.promise, "检查油桶");
  await delay(20);
  assert.equal(finished, 1);
  assert.equal(errors, 0);
});

const baseConfig: AgentGatewayConfig = {
  port: 0,
  deepSeekApiKey: "",
  dashScopeApiKey: "test-key",
  workspaceId: "",
  model: "deepseek-v4-flash",
  telemetryAnalysisModel: "deepseek-v4-flash",
  telemetryAnalysisReasoningEffort: "high",
  asrModel: "fun-asr-realtime",
  deepSeekBaseUrl: "http://127.0.0.1",
  asrWebSocketUrl: "",
  iotWebBaseUrl: "http://127.0.0.1",
  jetsonWsUrl: "ws://127.0.0.1",
  vehicleEnabled: false,
  allowLocalAutoPair: true,
  mockMode: true,
  reasoningMode: "always",
};

function configFor(server: WebSocketServer): AgentGatewayConfig {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试 WebSocket 未监听");
  return { ...baseConfig, asrWebSocketUrl: `ws://127.0.0.1:${address.port}` };
}

async function loopbackServer(context: { after(callback: () => void | Promise<void>): void }) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  context.after(async () => {
    for (const client of server.clients) terminate(client);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return server;
}

function terminate(socket: WebSocket) {
  try {
    socket.terminate();
  } catch {
    // The socket already closed with the session.
  }
}

function event(name: string) {
  return JSON.stringify({ header: { event: name } });
}

function result(text: string, sentenceEnd: boolean) {
  return JSON.stringify({
    header: { event: "result-generated" },
    payload: { output: { sentence: { text, sentence_end: sentenceEnd, heartbeat: false } } },
  });
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
