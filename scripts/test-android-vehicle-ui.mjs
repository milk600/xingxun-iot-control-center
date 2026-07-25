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
  const buttonWithLabel = (label) => [...document.querySelectorAll("button")]
    .find((button) => button.getAttribute("aria-label") === label);
  const waitFor = async (probe, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = probe();
      if (value) return value;
      await wait(100);
    }
    return null;
  };

  await wait(4200);
  const agentHost = document.querySelector('section[aria-label="AI 智能中枢"]');
  const agentRect = agentHost?.getBoundingClientRect();
  const agentVisible = Boolean(agentHost)
    && agentHost.getAttribute("aria-hidden") !== "true"
    && Boolean(agentRect && agentRect.height >= 40 && agentRect.bottom > 0);

  history.pushState({}, "", "/vehicle");
  window.dispatchEvent(new PopStateEvent("popstate"));
  const cameraImage = await waitFor(() => {
    const image = document.querySelector('img[alt="车载摄像头实时画面"]');
    return image instanceof HTMLImageElement && image.naturalWidth > 0 ? image : null;
  });
  const captureButton = buttonWithLabel("拍照并保存当前车载摄像头画面");
  const forwardButton = buttonWithLabel("前进，按住移动，松开停止");
  if (!(cameraImage instanceof HTMLImageElement) || !(captureButton instanceof HTMLButtonElement)) {
    return {
      outcome: "vehicle-controls-missing",
      path: location.pathname,
      agentVisible,
      body: document.body.innerText.slice(0, 800),
    };
  }

  if (!(forwardButton instanceof HTMLButtonElement) || forwardButton.disabled) {
    return {
      outcome: "drive-unavailable",
      path: location.pathname,
      agentVisible,
      captureDisabled: captureButton.disabled,
    };
  }
  forwardButton.focus();
  forwardButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(550);
  forwardButton.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  await wait(350);

  if (captureButton.disabled) {
    return { outcome: "capture-disabled", path: location.pathname, agentVisible };
  }
  captureButton.click();
  await wait(1200);

  const cameraFooter = cameraImage.closest("section")?.innerText ?? "";
  return {
    outcome: "passed",
    path: location.pathname,
    agentVisible,
    imageWidth: cameraImage.naturalWidth,
    imageHeight: cameraImage.naturalHeight,
    captureDisabled: captureButton.disabled,
    feedbackVisible: cameraFooter.includes("已开始保存到本地"),
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
if (!value || value.outcome !== "passed" || value.agentVisible !== true) process.exitCode = 1;
