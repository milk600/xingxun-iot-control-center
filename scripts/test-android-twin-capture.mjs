import WebSocket from "ws";

const targets = await fetch("http://127.0.0.1:9222/json").then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
if (!target) throw new Error("未找到可调试的 Android WebView 页面");
const cdp = new WebSocket(target.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
cdp.on("message", (raw) => {
  const message = JSON.parse(String(raw));
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
const result = await command("Runtime.evaluate", {
  expression: `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    history.pushState({}, "", "/digital-twin");
    window.dispatchEvent(new PopStateEvent("popstate"));
    const deadline = Date.now() + 45000;
    let capture;
    while (Date.now() < deadline) {
      capture = [...document.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "保存当前三维画面");
      if (capture instanceof HTMLButtonElement && !capture.disabled) break;
      await wait(150);
    }
    const canvas = document.querySelector("canvas");
    if (!(capture instanceof HTMLButtonElement) || capture.disabled || !(canvas instanceof HTMLCanvasElement)) {
      return { outcome: "unavailable", title: document.title };
    }
    capture.click();
    await wait(1200);
    return { outcome: "passed", width: canvas.width, height: canvas.height };
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
const value = result.result?.value;
console.log(JSON.stringify(value ?? null, null, 2));
cdp.close();
if (!value || value.outcome !== "passed") process.exitCode = 1;
