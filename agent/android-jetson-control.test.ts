import assert from "node:assert/strict";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import {
  AndroidJetsonControlClient,
  AndroidJetsonControlError,
  defaultAndroidDistanceTimeout,
  defaultAndroidTurnTimeout,
  parseAndroidJetsonControlStatus,
  parseAndroidJetsonNavigationStatus,
} from "../offline/jetson-control-runtime";

test("Android 只接受结构完整的 Jetson control 回执", () => {
  assert.equal(parseAndroidJetsonControlStatus("not-json"), null);
  assert.equal(parseAndroidJetsonControlStatus(JSON.stringify({ type: "odom" })), null);
  assert.equal(parseAndroidJetsonControlStatus(JSON.stringify({
    type: "control",
    request_id: "android-distance-1",
    kind: "distance",
    state: "completed",
  }))?.state, "completed");
});

test("Android 只接受结构完整的 Jetson navigation 回执", () => {
  assert.equal(parseAndroidJetsonNavigationStatus("not-json"), null);
  assert.equal(
    parseAndroidJetsonNavigationStatus(JSON.stringify({
      type: "navigation",
      request_id: "",
      state: "planned",
    })),
    null,
  );
  assert.equal(
    parseAndroidJetsonNavigationStatus(JSON.stringify({
      type: "navigation",
      request_id: "android-navigation-1",
      state: "planned",
      task_id: "task-1",
    }))?.task_id,
    "task-1",
  );
});

test("Android 定距控制等待同 request_id 的 completed 终态", async () => {
  const server = await createServer((socket, command) => {
    socket.send(JSON.stringify({
      type: "control",
      request_id: "another-request",
      kind: "distance",
      state: "completed",
    }));
    setTimeout(() => socket.send(JSON.stringify({
      type: "control",
      request_id: command.request_id,
      kind: "distance",
      state: "completed",
      measured_distance_mm: 100.4,
      final_error_mm: -0.4,
    })), 15);
  });
  const client = testClient(server.url);
  try {
    const result = await client.executeClosedLoop({
      cmd: "move_distance",
      request_id: "android-distance-1",
      direction: "forward",
      distance_mm: 100,
      max_speed_mmps: 300,
      timeout_s: 2,
    });
    assert.equal(result.request_id, "android-distance-1");
    assert.equal(result.measured_distance_mm, 100.4);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Android 定角控制不会把 failed 回执包装成成功", async () => {
  const server = await createServer((socket, command) => {
    socket.send(JSON.stringify({
      type: "control",
      request_id: command.request_id,
      kind: "turn",
      state: "failed",
      error: "IMU 反馈超时",
    }));
  });
  const client = testClient(server.url);
  try {
    await assert.rejects(client.executeClosedLoop({
      cmd: "turn_angle",
      request_id: "android-turn-1",
      direction: "left",
      angle_deg: 90,
      max_speed_mmps: 300,
      timeout_s: 2,
    }), (error: unknown) => (
      error instanceof AndroidJetsonControlError
      && /IMU 反馈超时/.test(error.message)
    ));
  } finally {
    await client.close();
    await server.close();
  }
});

test("Android 限时移动真实发送 move 并等待 stop 回执", async () => {
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
  const client = testClient(server.url);
  try {
    const result = await client.executeTimedMove("forward", 30, 10);
    assert.equal(result.stopped.state, "stopped");
    assert.deepEqual(commands.map((command) => command.cmd), ["move", "stop"]);
    assert.deepEqual(commands[0]?.speeds, [90, -90, 90, -90]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Android 固定点导航按 plan、planned、start、同 request_id completed 闭环", async () => {
  const commands: Record<string, unknown>[] = [];
  const server = await createServer((socket, command) => {
    commands.push(command);
    if (command.cmd === "navigation_plan") {
      socket.send(JSON.stringify({
        type: "navigation",
        request_id: "another-navigation",
        state: "completed",
      }));
      socket.send(JSON.stringify({
        type: "navigation",
        request_id: command.request_id,
        state: "planned",
        task_id: "task-android-1",
        estimated_seconds: 1,
      }));
      return;
    }
    if (command.cmd === "navigation_start") {
      setTimeout(() => socket.send(JSON.stringify({
        type: "navigation",
        request_id: "android-navigation-1",
        state: "completed",
        task_id: "task-android-1",
        elapsed_ms: 42,
      })), 10);
    }
  });
  const client = testClient(server.url);
  try {
    const result = await client.executeNavigation({
      requestId: "android-navigation-1",
      mapRevision: 7,
      start: { x: 0.1, y: 0.2, headingDeg: 90 },
      goal: { x: 0.7, y: 0.8 },
    });
    assert.equal(result.state, "completed");
    assert.equal(result.request_id, "android-navigation-1");
    assert.deepEqual(commands.map((command) => command.cmd), [
      "navigation_plan",
      "navigation_start",
    ]);
    assert.deepEqual(commands[0], {
      cmd: "navigation_plan",
      request_id: "android-navigation-1",
      map_revision: 7,
      start: { x: 0.1, y: 0.2, heading_deg: 90 },
      goal: { x: 0.7, y: 0.8 },
    });
    assert.equal(commands[1]?.task_id, "task-android-1");
  } finally {
    await client.close();
    await server.close();
  }
});

test("Android 固定点导航不会把 planned 或其他 request_id 误报为到达", async () => {
  const server = await createServer((socket, command) => {
    if (command.cmd === "navigation_plan") {
      socket.send(JSON.stringify({
        type: "navigation",
        request_id: command.request_id,
        state: "planned",
        task_id: "task-android-2",
        estimated_seconds: 1,
      }));
      return;
    }
    if (command.cmd === "navigation_start") {
      socket.send(JSON.stringify({
        type: "navigation",
        request_id: String(command.request_id),
        state: "completed",
        task_id: "task-android-2",
      }));
      setTimeout(() => socket.send(JSON.stringify({
        type: "navigation",
        request_id: "android-navigation-2",
        state: "failed",
        task_id: "task-android-2",
        error: "路线被阻挡",
      })), 10);
      return;
    }
    if (command.cmd === "navigation_cancel") {
      socket.send(JSON.stringify({
        type: "navigation",
        request_id: "android-navigation-2",
        state: "cancelled",
        task_id: "task-android-2",
      }));
    }
  });
  const client = testClient(server.url);
  try {
    await assert.rejects(client.executeNavigation({
      requestId: "android-navigation-2",
      mapRevision: 1,
      start: { x: 0, y: 0, headingDeg: 0 },
      goal: { x: 1, y: 1 },
    }), (error: unknown) => (
      error instanceof AndroidJetsonControlError
      && /路线被阻挡/.test(error.message)
    ));
  } finally {
    await client.close();
    await server.close();
  }
});

test("Android 导航期间急停发送 navigation_cancel 并等待原任务取消回执", async () => {
  const commands: Record<string, unknown>[] = [];
  let navigationStartedResolve: (() => void) | null = null;
  const navigationStarted = new Promise<void>((resolve) => {
    navigationStartedResolve = resolve;
  });
  const server = await createServer((socket, command) => {
    commands.push(command);
    if (command.cmd === "navigation_plan") {
      socket.send(JSON.stringify({
        type: "navigation",
        request_id: command.request_id,
        state: "planned",
        task_id: "task-android-stop",
      }));
      return;
    }
    if (command.cmd === "navigation_start") {
      navigationStartedResolve?.();
      return;
    }
    if (command.cmd === "navigation_cancel") {
      socket.send(JSON.stringify({
        type: "navigation",
        request_id: "android-navigation-stop",
        state: "cancelled",
        task_id: "task-android-stop",
      }));
    }
  });
  const client = testClient(server.url);
  try {
    const navigation = client.executeNavigation({
      requestId: "android-navigation-stop",
      mapRevision: 2,
      start: { x: 0.2, y: 0.2, headingDeg: 0 },
      goal: { x: 0.8, y: 0.8 },
    });
    await navigationStarted;
    const stopped = await client.stop();
    assert.equal(stopped.state, "cancelled");
    await assert.rejects(navigation, /cancelled/);
    assert.deepEqual(commands.map((command) => command.cmd), [
      "navigation_plan",
      "navigation_start",
      "navigation_cancel",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Android 与网关使用相同的闭环默认超时", () => {
  assert.equal(defaultAndroidDistanceTimeout(100, 300), 6.666666666666666);
  assert.equal(defaultAndroidTurnTimeout(90), 23);
  assert.equal(defaultAndroidDistanceTimeout(50_000, 100), 2_505);
  assert.equal(defaultAndroidTurnTimeout(1_440), 293);
});

test("Android 切换 Jetson 地址时旧连接关闭不会误伤新回执", async () => {
  const firstCommands: Record<string, unknown>[] = [];
  const secondCommands: Record<string, unknown>[] = [];
  const responder = (commands: Record<string, unknown>[]) => (
    socket: WebSocket,
    command: Record<string, unknown>,
  ) => {
    commands.push(command);
    socket.send(JSON.stringify({
      type: "control",
      request_id: command.request_id,
      kind: "stop",
      state: "stopped",
    }));
  };
  const first = await createServer(responder(firstCommands));
  const second = await createServer(responder(secondCommands));
  let url = first.url;
  const client = new AndroidJetsonControlClient({
    settings: () => ({ enabled: true, wsUrl: url, maxWheelSpeed: 300 }),
    socket: (endpoint) => new WebSocket(endpoint) as never,
    connectionTimeoutMs: 500,
  });
  try {
    assert.equal((await client.stop()).state, "stopped");
    url = second.url;
    assert.equal((await client.stop()).state, "stopped");
    assert.equal(firstCommands.length, 1);
    assert.equal(secondCommands.length, 1);
  } finally {
    await client.close();
    await first.close();
    await second.close();
  }
});

function testClient(url: string) {
  return new AndroidJetsonControlClient({
    settings: () => ({ enabled: true, wsUrl: url, maxWheelSpeed: 300 }),
    socket: (endpoint) => new WebSocket(endpoint) as never,
    connectionTimeoutMs: 500,
  });
}

async function createServer(
  onCommand: (socket: WebSocket, command: Record<string, unknown>) => void,
) {
  const webSocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => webSocketServer.once("listening", resolve));
  webSocketServer.on("connection", (socket) => {
    socket.on("message", (raw) => {
      onCommand(socket, JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
  const address = webSocketServer.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Android Jetson 测试服务未分配端口");
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => webSocketServer.close(() => resolve())),
  };
}
