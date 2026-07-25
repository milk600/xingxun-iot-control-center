import WebSocket from "ws";

const endpoint = process.env.ANDROID_WEBVIEW_CDP ?? "http://127.0.0.1:9222";
const prompt = process.env.ANDROID_AGENT_PROMPT ?? "打开数据监测页面";
const expectedPath = process.env.ANDROID_AGENT_EXPECT_PATH ?? "/monitoring";
const expectedTitle = process.env.ANDROID_AGENT_EXPECT_TITLE ?? "数据监测";
const expectedMarker = process.env.ANDROID_AGENT_EXPECT_MARKER ?? "实时趋势";
const expectedReplySetting = process.env.ANDROID_AGENT_EXPECT_REPLY ?? "正在打开数据监测。";
const expectedReply = expectedReplySetting === "none" ? "" : expectedReplySetting;
const timeoutMs = Number(process.env.ANDROID_AGENT_TIMEOUT_MS ?? 20000);
const requireModel = process.env.ANDROID_AGENT_REQUIRE_MODEL === "1";
const expectedReasoningEffort = process.env.ANDROID_AGENT_EXPECTED_EFFORT ?? "high";
const expectedModelRequestCount = process.env.ANDROID_AGENT_EXPECT_MODEL_REQUESTS === undefined
  ? null
  : Number(process.env.ANDROID_AGENT_EXPECT_MODEL_REQUESTS);
const maxElapsedMs = Number(process.env.ANDROID_AGENT_MAX_ELAPSED_MS ?? 0);
const simulateTelemetryHang = process.env.ANDROID_AGENT_SIMULATE_TELEMETRY_HANG === "1";
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

const expression = `(async () => {
  const startedAt = performance.now();
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const buttonWithLabel = (label) => [...document.querySelectorAll("button")]
    .find((button) => button.getAttribute("aria-label") === label);
  history.pushState({}, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
  const overviewDeadline = Date.now() + 12000;
  while (Date.now() < overviewDeadline) {
    if (location.pathname === "/" && document.title.includes("控制概览") && document.body.innerText.includes("房间 01")) break;
    await wait(120);
  }
  if (location.pathname !== "/" || !document.body.innerText.includes("房间 01")) {
    return { outcome: "overview-not-ready", path: location.pathname };
  }
  buttonWithLabel("显示 AI 智能中枢")?.click();
  await wait(120);
  buttonWithLabel("展开智能中枢")?.click();
  await wait(180);
  let input = document.querySelector('input[placeholder="也可以输入指令"]');
  if (!(input instanceof HTMLInputElement)) {
    buttonWithLabel("智能中枢设置")?.click();
    await wait(180);
    input = document.querySelector('input[placeholder="也可以输入指令"]');
  }
  const send = buttonWithLabel("发送文字指令");
  if (!(input instanceof HTMLInputElement) || !(send instanceof HTMLButtonElement)) {
    return { outcome: "controls-missing", path: location.pathname };
  }
  const modelRequests = [];
  const nativeFetch = window.fetch;
  const finish = (outcome, extra = {}) => {
    window.fetch = nativeFetch;
    return {
      outcome,
      elapsedMs: Math.round(performance.now() - startedAt),
      path: location.pathname,
      modelRequests,
      ...extra
    };
  };
  window.fetch = function observedAgentFetch(input, init) {
    const url = input instanceof Request ? input.url : String(input);
    const parsedUrl = new URL(url, location.href);
    if (${simulateTelemetryHang}
      && parsedUrl.origin === location.origin
      && parsedUrl.pathname === "/api/iot/snapshot") {
      return new Promise(() => {});
    }
    if (/\\/chat\\/completions(?:$|[?#])/.test(url)) {
      let body = {};
      try { body = JSON.parse(String(init?.body ?? "{}")); } catch {}
      modelRequests.push({
        model: body.model ?? null,
        thinking: body.thinking?.type ?? null,
        reasoningEffort: body.reasoning_effort ?? null,
        responseFormat: body.response_format?.type ?? null,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        maxTokens: body.max_tokens ?? null
      });
    }
    return nativeFetch.call(this, input, init);
  };
  const hasFullModelWorkflow = () => modelRequests.length >= 2
    && modelRequests.every((request) => request.model === "deepseek-v4-flash")
    && modelRequests.every((request) => request.thinking === "enabled")
    && modelRequests.every((request) => request.reasoningEffort === ${JSON.stringify(expectedReasoningEffort)})
    && modelRequests.some((request) => request.responseFormat === "json_object")
    && modelRequests.some((request) => request.toolCount > 0);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setValue?.call(input, ${JSON.stringify(prompt)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(80);
  send.click();
  const deadline = Date.now() + ${timeoutMs};
  while (Date.now() < deadline) {
    const agentHost = document.querySelector('[aria-label="AI 智能中枢"]');
    const agentText = agentHost?.textContent ?? "";
    const pageReady = document.title.includes(${JSON.stringify(expectedTitle)})
      && document.body.innerText.includes(${JSON.stringify(expectedMarker)});
    const replyReady = !${JSON.stringify(Boolean(expectedReply))}
      || agentText.includes(${JSON.stringify(expectedReply)});
    if (location.pathname === ${JSON.stringify(expectedPath)}
      && pageReady
      && replyReady
      && (${requireModel ? "hasFullModelWorkflow()" : "true"})) {
      await wait(1500);
      return finish("navigated", {
        title: document.title,
        markerVisible: true,
        replyVisible: replyReady
      });
    }
    const visibleError = [...(agentHost?.querySelectorAll('[role="alert"], p') ?? [])]
      .map((node) => node.textContent?.trim() || "")
      .find((text) => /AbortSignal|主证据无效|出现问题|无法|失败/.test(text));
    if (visibleError) return finish("ui-error", { error: visibleError.slice(0, 160) });
    await wait(500);
  }
  return finish("timeout");
})()`;

const result = await command("Runtime.evaluate", {
  expression,
  returnByValue: true,
  awaitPromise: true,
});
const value = result.result?.value;
console.log(JSON.stringify(value ?? null, null, 2));
cdp.close();
const modelWorkflowValid = !requireModel || (
  value?.modelRequests?.length >= 2
  && value.modelRequests.every((request) => request.model === "deepseek-v4-flash")
  && value.modelRequests.every((request) => request.thinking === "enabled")
  && value.modelRequests.every((request) => request.reasoningEffort === expectedReasoningEffort)
  && value.modelRequests.some((request) => request.responseFormat === "json_object")
  && value.modelRequests.some((request) => request.toolCount > 0)
);
const modelRequestCountValid = expectedModelRequestCount === null
  || value?.modelRequests?.length === expectedModelRequestCount;
const elapsedValid = maxElapsedMs <= 0 || (value?.elapsedMs ?? Number.POSITIVE_INFINITY) <= maxElapsedMs;
if (!value || value.outcome !== "navigated" || !modelWorkflowValid || !modelRequestCountValid || !elapsedValid) {
  process.exitCode = 1;
}
