const baseUrl = process.argv[2] ?? "http://127.0.0.1:3000";
const gatewayUrl = process.argv[3] ?? "ws://127.0.0.1:8766";
const routes = [
  "/",
  "/monitoring",
  "/vehicle",
  "/alerts",
  "/integrations",
  "/settings",
  "/digital-twin",
];
const modelPaths = [
  "/models/room-01/demo-room.ply",
  "/models/room-01/demo-room-framework.ply",
  "/models/room-01/demo-room-gap.ply",
];

for (const route of routes) {
  const response = await fetch(`${baseUrl}${route}`, { redirect: "manual" });
  console.log(`ROUTE ${route} ${response.status}`);
  if (response.status < 200 || response.status >= 400) {
    throw new Error(`路由不可访问：${route} (${response.status})`);
  }
  await response.body?.cancel();
}

for (const modelPath of modelPaths) {
  const response = await fetch(`${baseUrl}${modelPath}`, {
    method: "HEAD",
    redirect: "manual",
  });
  const length = response.headers.get("content-length") ?? "unknown";
  console.log(`MODEL ${modelPath} ${response.status} ${length}`);
  if (!response.ok) {
    throw new Error(`模型不可访问：${modelPath} (${response.status})`);
  }
}

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error("智能网关握手超时"));
  }, 5_000);
  const socket = new WebSocket(gatewayUrl);
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.type !== "gateway.hello") return;
      clearTimeout(timeout);
      console.log(`GATEWAY ${message.type} model=${message.payload?.model ?? "unknown"}`);
      socket.close();
      resolve();
    } catch (error) {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    }
  });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    reject(new Error("智能网关 WebSocket 连接失败"));
  });
});
