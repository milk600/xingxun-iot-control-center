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
  const waitFor = async (probe, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = probe();
      if (value) return value;
      await wait(100);
    }
    return null;
  };
  const navigate = async (path) => {
    history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await wait(250);
  };
  const tab = (label) => [...document.querySelectorAll('button[role="tab"]')]
    .find((button) => button.textContent?.trim().startsWith(label));
  const buttonText = (label) => [...document.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === label);

  await navigate("/monitoring");
  tab("历史数据")?.click();
  const historySummary = await waitFor(() => document.querySelector('[aria-label="历史区间统计"]'));
  const historyText = historySummary?.textContent ?? "";
  tab("事件")?.click();
  const eventTimeline = await waitFor(() => document.body.innerText.includes("事件时间线"));

  const keys = [
    "xingxun:android-alert-orders:v1",
    "xingxun:android-alert-rule-state:v1",
    "xingxun:android-alert-ignored-before:v1",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)]));
  const fixtureId = "android-ui-workorder-test";
  const now = new Date().toISOString();
  const fixture = {
    id: fixtureId,
    sourceType: "threshold",
    sourceEventId: null,
    telemetryEventType: "threshold",
    slotId: "slot-1",
    title: "Android 端工单链路验证",
    detail: "仅在模拟器验收期间创建，结束后恢复原本机数据。",
    severity: "warning",
    sourceState: "active",
    createdAt: now,
    recoveredAt: null,
    status: "pending",
    assignee: null,
    startedAt: null,
    completedAt: null,
    action: null,
    note: null,
    version: 1,
    evidence: { value: 25, upperLimit: 20, unit: "℃" },
    timeline: [{ id: "fixture-created", type: "created", timestamp: now, actor: null, detail: "模拟器链路验收" }],
  };

  let alertResult = { passed: false, reason: "not-started" };
  try {
    localStorage.setItem(keys[0], JSON.stringify([fixture]));
    localStorage.removeItem(keys[1]);
    localStorage.removeItem(keys[2]);
    window.dispatchEvent(new Event("xingxun:android-alerts-changed"));
    await navigate("/alerts");

    const itemButton = await waitFor(() => [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes(fixture.title)));
    if (!(itemButton instanceof HTMLButtonElement)) throw new Error("未显示本机告警工单");
    itemButton.click();
    const begin = await waitFor(() => buttonText("开始处理"));
    if (!(begin instanceof HTMLButtonElement) || begin.disabled) throw new Error("开始处理按钮不可用");
    begin.click();

    const processingTab = await waitFor(() => tab("处理中"));
    processingTab?.click();
    const processingItem = await waitFor(() => [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes(fixture.title)));
    processingItem?.click();
    const note = await waitFor(() => document.querySelector('textarea[placeholder="记录已完成的检查或处理"]'));
    if (!(note instanceof HTMLTextAreaElement)) throw new Error("处理中工单表单未显示");
    const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setText?.call(note, "已完成 Android 独立工单链路验收");
    note.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(80);
    const complete = buttonText("确认完成");
    if (!(complete instanceof HTMLButtonElement) || complete.disabled) throw new Error("确认完成按钮不可用");
    complete.click();

    const completedTab = await waitFor(() => tab("已完成"));
    completedTab?.click();
    const completedItem = await waitFor(() => [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes(fixture.title)));
    completedItem?.click();
    const completedUi = await waitFor(() => document.body.innerText.includes("已完成 Android 独立工单链路验收"));
    const stored = JSON.parse(localStorage.getItem(keys[0]) ?? "[]").find((item) => item.id === fixtureId);
    alertResult = {
      passed: Boolean(completedUi) && stored?.status === "completed" && stored?.version === 3,
      status: stored?.status ?? null,
      version: stored?.version ?? null,
      timelineEntries: stored?.timeline?.length ?? 0,
      note: stored?.note ?? null,
    };
  } catch (error) {
    alertResult = { passed: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    window.dispatchEvent(new Event("xingxun:android-alerts-changed"));
  }

  return {
    outcome: historySummary && eventTimeline && alertResult.passed ? "passed" : "failed",
    history: { loaded: Boolean(historySummary), text: historyText },
    events: { loaded: Boolean(eventTimeline) },
    alert: alertResult,
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
if (!value || value.outcome !== "passed") process.exitCode = 1;
