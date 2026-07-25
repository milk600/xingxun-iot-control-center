import WebSocket from "ws";

const endpoint = process.env.ANDROID_WEBVIEW_CDP ?? "http://127.0.0.1:9222";
const prompt = process.env.ANDROID_AGENT_PROMPT ?? "打开数据监测页面";
const timeoutMs = Number(process.env.ANDROID_AGENT_TIMEOUT_MS ?? 15000);
const requireModel = process.env.ANDROID_AGENT_REQUIRE_MODEL === "1";
const expectedReasoningEffort = process.env.ANDROID_AGENT_EXPECTED_EFFORT ?? "high";
const expectedModelRequestCount = process.env.ANDROID_AGENT_EXPECT_MODEL_REQUESTS === undefined
  ? null
  : Number(process.env.ANDROID_AGENT_EXPECT_MODEL_REQUESTS);
const maxElapsedMs = Number(process.env.ANDROID_AGENT_MAX_ELAPSED_MS ?? 0);
const expectedAction = process.env.ANDROID_AGENT_EXPECT_ACTION ?? "ui.navigate";
const expectedActionPage = process.env.ANDROID_AGENT_EXPECT_ACTION_PAGE ?? "monitoring";
const targets = await fetch(`${endpoint}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page"
  && item.webSocketDebuggerUrl
  && String(item.url).startsWith("https://xingxun.local/"))
  ?? targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
if (!target) throw new Error("未找到可调试的 Android WebView 页面");
const requestId = `emulator-agent-probe-${crypto.randomUUID()}`;

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
  const received = [];
  const modelRequests = [];
  const modelResponses = [];
  const nativeFetch = window.fetch;
  window.fetch = function observedAgentFetch(input, init) {
    const url = input instanceof Request ? input.url : String(input);
    const isModelRequest = /\\/chat\\/completions(?:$|[?#])/.test(url);
    if (isModelRequest) {
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
    return nativeFetch.call(this, input, init).then((response) => {
      if (isModelRequest) {
        void response.clone().json().then((payload) => {
          const choice = payload?.choices?.[0];
          const content = choice?.message?.content;
          modelResponses.push({
            status: response.status,
            finishReason: choice?.finish_reason ?? null,
            contentLength: typeof content === "string" ? content.length : 0,
            toolCallCount: Array.isArray(choice?.message?.tool_calls)
              ? choice.message.tool_calls.length
              : 0,
            error: typeof payload?.error?.message === "string"
              ? payload.error.message.slice(0, 160)
              : null
          });
        }).catch(() => {
          modelResponses.push({
            status: response.status,
            finishReason: null,
            contentLength: 0,
            toolCallCount: 0,
            error: "response-json-unavailable"
          });
        });
      }
      return response;
    });
  };
  const socket = new WebSocket("ws://xingxun.local/agent");
  return await new Promise((resolve) => {
    const finish = (outcome) => {
      try { socket.close(1000, "probe-complete"); } catch {}
      window.fetch = nativeFetch;
      resolve({
        outcome,
        elapsedMs: Math.round(performance.now() - startedAt),
        received,
        modelRequests,
        modelResponses
      });
    };
    const timer = setTimeout(() => finish("timeout"), ${timeoutMs});
    socket.onerror = () => {
      clearTimeout(timer);
      finish("socket-error");
    };
    socket.onopen = () => socket.send(JSON.stringify({
      type: "client.hello",
      payload: {
        page: "overview",
        realVehicleEnabled: false,
        alertWorkOrderAutomationEnabled: false
      }
    }));
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const summary = { type: message.type };
      if (message.type === "gateway.ready") summary.standalone = message.payload?.standalone === true;
      if (message.type === "agent.trace") summary.stages = message.payload?.trace?.stages?.map((stage) => ({ id: stage.id, status: stage.status, detail: stage.detail }));
      if (message.type === "agent.plan") {
        summary.requestIdMatches = message.payload?.plan?.requestId === ${JSON.stringify(requestId)};
        summary.actionCount = message.payload?.plan?.steps?.length ?? -1;
      }
      if (message.type === "action.dispatch") {
        summary.requestIdMatches = message.payload?.requestId === ${JSON.stringify(requestId)};
        summary.actionName = message.payload?.action?.name ?? null;
        summary.actionPage = message.payload?.action?.arguments?.page ?? null;
        const executionId = message.payload?.actionExecutionId;
        if (typeof executionId === "string" && executionId) {
          socket.send(JSON.stringify({
            type: "action.result",
            payload: {
              requestId: message.payload?.requestId ?? null,
              planId: message.payload?.planId ?? null,
              stepIndex: Number.isSafeInteger(message.payload?.stepIndex)
                ? message.payload.stepIndex
                : 0,
              actionExecutionId: executionId,
              actionName: message.payload?.action?.name,
              status: "success",
              message: "Android 探针已确认页面动作真实完成。",
              completedAt: new Date().toISOString()
            }
          }));
        }
      }
      if (message.type === "agent.reply") {
        summary.requestIdMatches = message.payload?.requestId === ${JSON.stringify(requestId)};
        summary.replyLength = String(message.payload?.text ?? "").length;
      }
      if (message.type === "agent.error") summary.error = String(message.payload?.message ?? "");
      if (message.type === "voice.state") summary.phase = message.payload?.phase;
      received.push(summary);
      if (message.type === "gateway.ready") {
        socket.send(JSON.stringify({
          type: "agent.ask",
          payload: { requestId: ${JSON.stringify(requestId)}, text: ${JSON.stringify(prompt)}, page: "overview" }
        }));
      }
      if (message.type === "agent.reply" || message.type === "agent.error") {
        clearTimeout(timer);
        finish(message.type);
      }
    };
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
const traces = value?.received?.filter((message) => message.type === "agent.trace") ?? [];
const finalStages = traces.at(-1)?.stages ?? [];
const traceValid = ["understand", "context", "plan", "validate", "execution"].every((id) =>
  finalStages.some((stage) => stage.id === id && stage.status === "complete"));
const planValid = value?.received?.some((message) =>
  message.type === "agent.plan" && message.requestIdMatches && message.actionCount === 1);
const actionValid = value?.received?.some((message) =>
  message.type === "action.dispatch"
  && message.requestIdMatches
  && message.actionName === expectedAction
  && (expectedActionPage === "" || message.actionPage === expectedActionPage));
const replyValid = value?.received?.some((message) =>
  message.type === "agent.reply" && message.requestIdMatches && message.replyLength > 0);
if (!value
  || value.outcome !== "agent.reply"
  || !modelWorkflowValid
  || !modelRequestCountValid
  || !elapsedValid
  || !traceValid
  || !planValid
  || !actionValid
  || !replyValid) {
  process.exitCode = 1;
}
