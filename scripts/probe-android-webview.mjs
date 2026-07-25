import WebSocket from "ws";

const endpoint = process.env.ANDROID_WEBVIEW_CDP ?? "http://127.0.0.1:9222";
const targets = await fetch(`${endpoint}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
if (!target) throw new Error("未找到可调试的 Android WebView 页面");

const socket = new WebSocket(target.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();

socket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  if (!message.id) return;
  const callback = pending.get(message.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.error) callback.reject(new Error(message.error.message));
  else callback.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

function command(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const expression = `(async () => {
  const safeConfig = (() => {
    try { return JSON.parse(window.XingXunCloud?.getRuntimeConfig?.() || "{}"); }
    catch { return {}; }
  })();
  const values = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !/ai|preference|auth/i.test(key)) continue;
    values[key] = localStorage.getItem(key);
  }
  let snapshot;
  try {
    const payload = await fetch("/api/iot/snapshot").then((response) => response.json());
    const slots = Object.values(payload.slots || {});
    snapshot = {
      provider: payload.provider,
      availableSlots: slots.filter((slot) => typeof slot?.value === "number").length,
      states: [...new Set(slots.map((slot) => slot?.state))],
      partialErrors: (payload.partialErrors || []).map((item) => item?.message).filter(Boolean),
    };
  } catch (error) {
    snapshot = { error: error instanceof Error ? error.message : String(error) };
  }
  return {
    url: location.href,
    title: document.title,
    nativeCloudBridge: typeof window.XingXunCloud === "object",
    nativeAuthBridge: typeof window.XingXunAuth === "object",
    webSocketConstructor: String(window.WebSocket).slice(0, 120),
    agentText: document.querySelector('section[aria-label="AI 智能中枢"]')?.innerText?.slice(0, 1200) ?? "",
    runtime: safeConfig,
    snapshot,
    visibleButtons: [...document.querySelectorAll("button")]
      .filter((button) => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      })
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          text: button.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) || "",
          aria: button.getAttribute("aria-label") || "",
          pressed: button.getAttribute("aria-pressed"),
          title: button.getAttribute("title") || "",
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          zIndex: getComputedStyle(button).zIndex,
        };
      }),
    storage: values,
  };
})()`;

const evaluated = await command("Runtime.evaluate", {
  expression,
  returnByValue: true,
  awaitPromise: true,
});
console.log(JSON.stringify(evaluated.result?.value ?? null, null, 2));
socket.close();
