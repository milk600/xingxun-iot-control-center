import assert from "node:assert/strict";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import {
  JetsonControlClient,
  JetsonControlError,
  parseJetsonControlStatus,
  parseJetsonNavigationStatus,
} from "./jetson-control";

test("只接受结构完整的 Jetson control 回执", () => {
  assert.equal(parseJetsonControlStatus("not-json"), null);
  assert.equal(parseJetsonControlStatus(JSON.stringify({ type: "odom" })), null);
  assert.equal(parseJetsonControlStatus(JSON.stringify({
    type: "control",
    request_id: "req-1",
    kind: "distance",
    state: "completed",
  }))?.state, "completed");
});

test("距离闭环必须等待同 request_id 的 completed", async () => {
  const server = await createServer((socket, command) => {
    socket.send(JSON.stringify({ type: "control", request_id: "other", kind: "distance", state: "completed" }));
    setTimeout(() => socket.send(JSON.stringify({
      type: "control",
      request_id: command.request_id,
      kind: "distance",
      state: "completed",
      measured_distance_mm: 99.2,
      final_error_mm: 0.8,
    })), 20);
  });
  const client = new JetsonControlClient(server.url);
  try {
    const status = await client.executeClosedLoop({
      cmd: "move_distance",
      request_id: "distance-1",
      direction: "forward",
      distance_mm: 100,
      max_speed_mmps: 300,
      timeout_s: 2,
    });
    assert.equal(status.request_id, "distance-1");
    assert.equal(status.measured_distance_mm, 99.2);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Jetson failed 回执不会被包装成成功", async () => {
  const server = await createServer((socket, command) => {
    socket.send(JSON.stringify({
      type: "control",
      request_id: command.request_id,
      kind: "turn",
      state: "failed",
      error: "IMU 反馈超时",
    }));
  });
  const client = new JetsonControlClient(server.url);
  try {
    await assert.rejects(client.executeClosedLoop({
      cmd: "turn_angle",
      request_id: "turn-1",
      direction: "left",
      angle_deg: 90,
      max_speed_mmps: 300,
      timeout_s: 2,
    }), (error: unknown) => error instanceof JetsonControlError && /IMU 反馈超时/.test(error.message));
  } finally {
    await client.close();
    await server.close();
  }
});

test("限时移动只有真实发送 move 且收到 stop 回执后才结束", async () => {
  const commands: Record<string, unknown>[] = [];
  const server = await createServer((socket, command) => {
    commands.push(command);
    if (command.cmd === "stop") {
      socket.send(JSON.stringify({
        type: "control",
        request_id: command.request_id,
        kind: "stop",
        state: "stopped",
      }));
    }
  });
  const client = new JetsonControlClient(server.url);
  try {
    const result = await client.executeTimedMove([75, -75, 75, -75], 10);
    assert.equal(result.stopped.state, "stopped");
    assert.deepEqual(commands.map((command) => command.cmd), ["move", "stop"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("固定检查点导航按 plan → start 顺序并等待原 request_id 的 completed", async () => {
  const commands: Record<string, unknown>[] = [];
  const navigationRequestId = "agent-navigation-1";
  const server = await createServer((socket, command) => {
    commands.push(command);
    if (command.cmd === "navigation_plan") {
      socket.send(JSON.stringify({
        type: "navigation",
        request_id: navigationRequestId,
        state: "planned",
        task_id: "navigation-task-1",
        estimated_seconds: 1,
      }));
    } else if (command.cmd === "navigation_start") {
      socket.send(JSON.stringify({
        type: "navigation",
        request_id: "unrelated-request",
        state: "completed",
        task_id: "navigation-task-1",
      }));
      setTimeout(() => socket.send(JSON.stringify({
        type: "navigation",
        request_id: navigationRequestId,
        state: "completed",
        task_id: "navigation-task-1",
        elapsed_ms: 20,
      })), 10);
    }
  });
  const client = new JetsonControlClient(server.url);
  try {
    const status = await client.executeNavigation({
      requestId: navigationRequestId,
      mapRevision: 3,
      start: { x: 0.1, y: 0.2, headingDeg: 30 },
      goal: { x: 0.8, y: 0.7 },
    });
    assert.equal(status.state, "completed");
    assert.deepEqual(commands.map((command) => command.cmd), ["navigation_plan", "navigation_start"]);
    assert.deepEqual(commands[0].goal, { x: 0.8, y: 0.7 });
  } finally {
    await client.close();
    await server.close();
  }
});

test("只接受带 request_id 的 Jetson navigation 回执", () => {
  assert.equal(parseJetsonNavigationStatus(JSON.stringify({ type: "navigation", state: "planned" })), null);
  assert.equal(parseJetsonNavigationStatus(JSON.stringify({
    type: "navigation",
    request_id: "plan-1",
    state: "planned",
    task_id: "task-1",
  }))?.task_id, "task-1");
});

async function createServer(
  onCommand: (socket: WebSocket, command: Record<string, unknown>) => void,
) {
  const webSocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => webSocketServer.once("listening", resolve));
  webSocketServer.on("connection", (socket) => {
    socket.on("message", (raw) => onCommand(socket, JSON.parse(raw.toString()) as Record<string, unknown>));
  });
  const address = webSocketServer.address();
  if (typeof address === "string" || address === null) throw new Error("测试 WebSocket 未分配 TCP 端口");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => webSocketServer.close(() => resolve())),
  };
}
