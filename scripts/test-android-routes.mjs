import WebSocket from "ws";

const endpoint = process.env.ANDROID_WEBVIEW_CDP ?? "http://127.0.0.1:9222";
const targets = await fetch(`${endpoint}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
if (!target) throw new Error("未找到可调试的 Android WebView 页面");

const cdp = new WebSocket(target.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
cdp.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  if (!message.id) return;
  const callback = pending.get(message.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.error) callback.reject(new Error(message.error.message));
  else callback.resolve(message.result);
});
await new Promise((resolve, reject) => {
  cdp.once("open", resolve);
  cdp.once("error", reject);
});

function command(method, params = {}) {
  const id = ++sequence;
  cdp.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const expression = `(async () => {
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const routes = [
    ["/", "控制概览", "房间 01"],
    ["/monitoring", "数据监测", "实时趋势"],
    ["/alerts", "告警管理", "告警概况"],
    ["/integrations", "连接管理", "华为云 IoTDA"],
    ["/settings", "系统设置", "账户与安全"],
    ["/vehicle", "小车遥控", "手动驾驶"],
    ["/digital-twin", "空间孪生", "空间孪生"],
  ];
  const results = [];
  for (const [path, title, marker] of routes) {
    history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    const timeout = path === "/digital-twin" ? 45000 : 12000;
    const deadline = Date.now() + timeout;
    let ready = false;
    while (Date.now() < deadline) {
      const text = document.body.innerText;
      if (document.title.includes(title) && text.includes(marker)) {
        ready = true;
        break;
      }
      await wait(120);
    }
    await wait(path === "/digital-twin" ? 2500 : 300);
    const bodyText = document.body.innerText;
    const canvas = path === "/digital-twin" ? document.querySelector("canvas") : null;
    results.push({
      path,
      ready,
      title: document.title,
      marker,
      markerVisible: bodyText.includes(marker),
      fatalText: /应用加载失败|页面加载失败|无法启动|AbortSignal\.timeout is not a function/.test(bodyText),
      canvas: canvas instanceof HTMLCanvasElement
        ? { width: canvas.width, height: canvas.height, visible: canvas.getBoundingClientRect().height > 0 }
        : null,
    });
  }

  const indexedDbCount = await new Promise((resolve) => {
    const request = indexedDB.open("xingxun-android-runtime");
    request.onerror = () => resolve(-1);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("snapshots")) {
        resolve(0);
        return;
      }
      const countRequest = database.transaction("snapshots", "readonly").objectStore("snapshots").count();
      countRequest.onerror = () => resolve(-1);
      countRequest.onsuccess = () => resolve(countRequest.result);
    };
  });
  return {
    outcome: results.every((item) => item.ready && !item.fatalText) ? "passed" : "failed",
    results,
    indexedDbCount,
    androidBridge: typeof window.XingXunCloud?.getRuntimeConfig === "function",
    localAgentSocket: typeof window.WebSocket === "function",
  };
})()`;

const result = await command("Runtime.evaluate", {
  expression,
  returnByValue: true,
  awaitPromise: true,
});
const value = result.result?.value;
console.log(JSON.stringify(value ?? null, null, 2));
cdp.close();
if (!value || value.outcome !== "passed" || value.indexedDbCount < 1 || value.androidBridge !== true) process.exitCode = 1;
