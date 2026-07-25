import WebSocket from "ws";

const endpoint = process.env.ANDROID_WEBVIEW_CDP ?? "http://127.0.0.1:9222";
const timeoutMs = Number(process.env.ANDROID_AGENT_SWIPE_TIMEOUT_MS ?? 10_000);
const targets = await fetch(`${endpoint}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page"
  && item.webSocketDebuggerUrl
  && String(item.url).startsWith("https://xingxun.local/"))
  ?? targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
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

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Android WebView 表达式执行失败");
  }
  return result.result?.value;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(expression, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await wait(80);
  }
  throw new Error(`等待${label}超时`);
}

async function touch(type, x, y) {
  await command("Input.dispatchTouchEvent", {
    type,
    touchPoints: type === "touchEnd" || type === "touchCancel"
      ? []
      : [{ x, y, radiusX: 4, radiusY: 4, force: 1 }],
  });
}

await evaluate(`(() => {
  const button = [...document.querySelectorAll("button")]
    .find((item) => item.getAttribute("aria-label") === "展开智能中枢");
  button?.click();
  return true;
})()`);

const initial = await waitFor(`(() => {
  const handle = [...document.querySelectorAll("button")]
    .find((item) => item.getAttribute("aria-label") === "向下滑动收起智能中枢");
  const surface = handle?.closest("div[style*='--ai-panel-drag-y']");
  const panel = handle?.closest("div")?.parentElement?.querySelector("[class*='panel']");
  const host = handle?.closest("section[aria-label='AI 智能中枢']");
  const mic = host?.querySelector("button[aria-label='按住说话']");
  if (!(handle instanceof HTMLElement) || !(surface instanceof HTMLElement)) return null;
  const rect = handle.getBoundingClientRect();
  const surfaceStyle = getComputedStyle(surface);
  const panelStyle = panel instanceof HTMLElement ? getComputedStyle(panel) : null;
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    transitionDuration: surfaceStyle.transitionDuration,
    animationDuration: panelStyle?.animationDuration ?? "",
    hostTransitionDuration: host instanceof HTMLElement ? getComputedStyle(host).transitionDuration : "",
    micVisible: mic instanceof HTMLElement && mic.getBoundingClientRect().height > 0,
    expanded: [...document.querySelectorAll("button")]
      .find((item) => item.getAttribute("aria-label") === "收起智能中枢")
      ?.getAttribute("aria-expanded") ?? null
  };
})()`, "智能体下滑手柄");

await touch("touchStart", initial.x, initial.y);
await wait(90);
await touch("touchMove", initial.x, initial.y + 18);
await wait(90);
await touch("touchEnd", initial.x, initial.y + 18);
await wait(360);

const rebound = await evaluate(`(() => {
  const handle = [...document.querySelectorAll("button")]
    .find((item) => item.getAttribute("aria-label") === "向下滑动收起智能中枢");
  const surface = handle?.closest("div[style*='--ai-panel-drag-y']");
  return {
    handleVisible: handle instanceof HTMLElement && handle.getBoundingClientRect().height > 0,
    transform: surface instanceof HTMLElement ? getComputedStyle(surface).transform : null
  };
})()`);

await touch("touchStart", initial.x, initial.y);
await wait(35);
await touch("touchMove", initial.x, initial.y + 48);
await wait(35);
await touch("touchMove", initial.x, initial.y + 126);
await wait(25);
await touch("touchEnd", initial.x, initial.y + 126);

await waitFor(`(() => {
  const host = document.querySelector("section[aria-label='AI 智能中枢']");
  const wake = document.querySelector("button[aria-label='显示 AI 智能中枢']");
  return host instanceof HTMLElement
    && host.getAttribute("aria-hidden") === "true"
    && getComputedStyle(host).visibility === "hidden"
    && wake instanceof HTMLElement
    && getComputedStyle(wake).visibility === "visible";
})()`, "智能体面板和语音胶囊动画滑出");

const collapsed = await evaluate(`(() => {
  const host = document.querySelector("section[aria-label='AI 智能中枢']");
  const panel = host?.querySelector("[class*='panel']");
  const mic = host?.querySelector("button[aria-label='按住说话']");
  const bar = mic?.closest("div[role='toolbar']");
  const wake = document.querySelector("button[aria-label='显示 AI 智能中枢']");
  const viewportBottom = window.innerHeight;
  const hiddenOrBelow = (item) => item instanceof HTMLElement
    && (getComputedStyle(item).visibility === "hidden"
      || item.getBoundingClientRect().top >= viewportBottom);
  return {
    hostHidden: host instanceof HTMLElement
      && host.getAttribute("aria-hidden") === "true"
      && getComputedStyle(host).opacity === "0",
    panelHiddenOrBelow: hiddenOrBelow(panel),
    micCapsuleHiddenOrBelow: hiddenOrBelow(bar),
    wakeVisible: wake instanceof HTMLElement
      && getComputedStyle(wake).visibility === "visible"
      && wake.getBoundingClientRect().height > 0
  };
})()`);

await evaluate(`(() => {
  const button = [...document.querySelectorAll("button")]
    .find((item) => item.getAttribute("aria-label") === "显示 AI 智能中枢");
  button?.click();
  return true;
})()`);
const restored = await waitFor(`(() => {
  const host = document.querySelector("section[aria-label='AI 智能中枢']");
  const handle = [...document.querySelectorAll("button")]
    .find((item) => item.getAttribute("aria-label") === "向下滑动收起智能中枢");
  const mic = host?.querySelector("button[aria-label='按住说话']");
  const collapse = [...document.querySelectorAll("button")]
    .find((item) => item.getAttribute("aria-label") === "收起智能中枢"
      && item.getAttribute("aria-expanded") === "true");
  return host instanceof HTMLElement
    && host.getAttribute("aria-hidden") !== "true"
    && getComputedStyle(host).visibility === "visible"
    && handle instanceof HTMLElement
    && handle.getBoundingClientRect().height > 0
    && mic instanceof HTMLElement
    && mic.getBoundingClientRect().height > 0
    && collapse instanceof HTMLElement;
})()`, "智能体面板和语音胶囊重新展开");

const result = {
  outcome: "passed",
  initial,
  rebound,
  collapsed,
  restored: Boolean(restored),
};
console.log(JSON.stringify(result, null, 2));
cdp.close();

const animated = initial.transitionDuration !== "0s"
  && initial.animationDuration !== "0s"
  && initial.hostTransitionDuration !== "0s";
const reboundAtRest = rebound.handleVisible
  && (rebound.transform === "none" || rebound.transform === "matrix(1, 0, 0, 1, 0, 0)");
if (!animated
  || initial.expanded !== "true"
  || !initial.micVisible
  || !reboundAtRest
  || !collapsed.hostHidden
  || !collapsed.panelHiddenOrBelow
  || !collapsed.micCapsuleHiddenOrBelow
  || !collapsed.wakeVisible
  || !restored) {
  process.exitCode = 1;
}
