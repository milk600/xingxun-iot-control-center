import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.PORT ?? 8765);
const host = process.env.HOST?.trim() || "127.0.0.1";
const jpegBase64 = "/9j/2Q==";
const server = new WebSocketServer({ host, port });
let sequence = 0;

function write(event) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

server.on("listening", () => write({ event: "listening", host, port, frameBytes: jpegBase64.length }));
server.on("connection", (socket, request) => {
  write({ event: "connected", remote: request.socket.remoteAddress });
  let wheelSpeeds = [0, 0, 0, 0];
  let controlTimer = null;
  let activeControl = null;

  const sendControl = (state, requestId, kind, details = {}) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: "control",
      version: 1,
      ts: Date.now() / 1000,
      request_id: requestId,
      kind,
      state,
      ...details,
    }));
  };

  const finishClosedLoop = (message, kind) => {
    if (controlTimer !== null) clearTimeout(controlTimer);
    const requestId = typeof message.request_id === "string"
      ? message.request_id
      : `android-test-${++sequence}`;
    activeControl = { requestId, kind };
    sendControl("started", requestId, kind, {
      direction: message.direction,
    });
    controlTimer = setTimeout(() => {
      wheelSpeeds = [0, 0, 0, 0];
      sendControl("completed", requestId, kind, {
        direction: message.direction,
        ...(kind === "distance"
          ? {
              target_distance_mm: Number(message.distance_mm),
              measured_distance_mm: Number(message.distance_mm),
              final_error_mm: 0,
            }
          : {
              target_angle_deg: Number(message.angle_deg),
              measured_angle_deg: Number(message.angle_deg),
              final_error_deg: 0,
            }),
      });
      activeControl = null;
      controlTimer = null;
    }, 180);
  };

  const sendFrame = () => {
    if (socket.readyState !== WebSocket.OPEN) return;
    sequence += 1;
    const now = new Date().toISOString();
    socket.send(JSON.stringify({
      type: "odom",
      version: 2,
      seq: sequence,
      observedAt: now,
      data: {
        M1: wheelSpeeds[0],
        M2: wheelSpeeds[1],
        M3: wheelSpeeds[2],
        M4: wheelSpeeds[3],
        xMm: sequence * 2,
        yMm: 120,
        headingDeg: 8,
      },
    }));
    socket.send(JSON.stringify({ type: "video", seq: sequence, observedAt: now, data: jpegBase64 }));
  };

  sendFrame();
  const timer = setInterval(sendFrame, 300);
  socket.on("message", (payload) => {
    const raw = payload.toString();
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      write({ event: "invalid-command", raw });
      return;
    }
    if (message?.cmd === "move" && Array.isArray(message.speeds) && message.speeds.length === 4) {
      wheelSpeeds = message.speeds.map(Number);
    } else if (message?.cmd === "stop") {
      if (controlTimer !== null) clearTimeout(controlTimer);
      controlTimer = null;
      activeControl = null;
      wheelSpeeds = [0, 0, 0, 0];
      sendControl(
        "stopped",
        typeof message.request_id === "string" ? message.request_id : `android-test-${++sequence}`,
        "stop",
        { reason: "stop_command" },
      );
    } else if (message?.cmd === "move_distance") {
      const speed = Math.max(75, Math.min(300, Number(message.max_speed_mmps) || 80));
      wheelSpeeds = message.direction === "backward"
        ? [-speed, speed, -speed, speed]
        : [speed, -speed, speed, -speed];
      finishClosedLoop(message, "distance");
    } else if (message?.cmd === "turn_angle") {
      const speed = Math.max(75, Math.min(300, Number(message.max_speed_mmps) || 75));
      wheelSpeeds = message.direction === "right"
        ? [speed, speed, -speed, -speed]
        : [-speed, -speed, speed, speed];
      finishClosedLoop(message, "turn");
    } else if (message?.cmd === "imu_zero") {
      sendControl(
        "completed",
        typeof message.request_id === "string" ? message.request_id : `android-test-${++sequence}`,
        "imu_zero",
        { zero_revision: 1 },
      );
    }
    write({ event: "command", message });
  });
  socket.on("close", () => {
    clearInterval(timer);
    if (controlTimer !== null) clearTimeout(controlTimer);
    if (activeControl) {
      write({ event: "control-aborted", ...activeControl });
    }
    write({ event: "disconnected" });
  });
  socket.on("error", (error) => write({ event: "socket-error", message: error.message }));
});

function close() {
  write({ event: "closing" });
  for (const client of server.clients) client.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
