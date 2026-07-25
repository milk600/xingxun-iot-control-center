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
  const sessionId = "emulator-asr-probe-" + crypto.randomUUID();
  return await new Promise((resolve) => {
    const finish = (result) => {
      window.removeEventListener("xingxun:native-asr", onEvent);
      try { window.XingXunCloud?.finishAsr(sessionId); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ outcome: "timeout" }), 20000);
    const onEvent = (event) => {
      const detail = event.detail;
      if (!detail || detail.sessionId !== sessionId) return;
      if (detail.type === "ready" || detail.type === "error") {
        clearTimeout(timer);
        finish({ outcome: detail.type, error: detail.error || null });
      }
    };
    window.addEventListener("xingxun:native-asr", onEvent);
    window.XingXunCloud?.startAsr(sessionId);
  });
})()`;

const result = await command("Runtime.evaluate", {
  expression,
  returnByValue: true,
  awaitPromise: true,
});
const value = result.result?.value;
console.log(JSON.stringify(value ?? null, null, 2));
cdp.close();
if (!value || value.outcome !== "ready") process.exitCode = 1;
