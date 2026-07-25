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
    const requestId = "native-deepseek-" + crypto.randomUUID();
    const startedAt = Date.now();
    return await new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        window.removeEventListener("xingxun:native-cloud", onResult);
        resolve({ ...value, elapsedMs: Date.now() - startedAt });
      };
      const timer = setTimeout(() => {
        window.XingXunCloud?.cancelRequest(requestId);
        finish({ outcome: "timeout" });
      }, 120000);
      const onResult = (event) => {
        const detail = event.detail;
        if (!detail || detail.requestId !== requestId) return;
        if (detail.error) {
          finish({ outcome: "error", status: detail.status ?? 0, error: detail.error });
          return;
        }
        let payload;
        try { payload = JSON.parse(detail.body); } catch { payload = {}; }
        finish({
          outcome: "ready",
          status: detail.status ?? 0,
          finishReason: payload.choices?.[0]?.finish_reason ?? null,
          contentLength: String(payload.choices?.[0]?.message?.content ?? "").length,
        });
      };
      window.addEventListener("xingxun:native-cloud", onResult);
      window.XingXunCloud?.requestDeepSeek(requestId, JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "只回复：连接正常" }],
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        max_tokens: 128,
      }));
    });
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
const value = result.result?.value;
console.log(JSON.stringify(value ?? null, null, 2));
cdp.close();
if (!value || value.outcome !== "ready" || value.status < 200 || value.status >= 300) process.exitCode = 1;
