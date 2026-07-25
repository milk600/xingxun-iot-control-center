import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  isExpectedNativeCloudCancellation,
  readHuaweiShadow,
} from "../offline/native-cloud";

interface FakeCloudBridge {
  getRuntimeConfig(): string;
  setActiveRoute(path: string): void;
  setAgentActivity(phase: "recording" | "planning" | "executing" | "vehicle", active: boolean): void;
  saveDataUrl(dataUrl: string, requestedName: string): void;
  saveTextFile(content: string, requestedName: string, mimeType: string): void;
  readIotShadow(requestId: string): void;
  requestDeepSeek(requestId: string, body: string): void;
  cancelRequest(requestId: string): void;
  startAsr(sessionId: string): void;
  sendAsrAudio(sessionId: string, base64Audio: string): void;
  finishAsr(sessionId: string): void;
}

function installFakeAndroidWindow(
  context: TestContext,
  callbacks: {
    read(requestId: string): void;
    cancel?(requestId: string): void;
  },
) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const bridge: FakeCloudBridge = {
    getRuntimeConfig: () => "{}",
    setActiveRoute: () => undefined,
    setAgentActivity: () => undefined,
    saveDataUrl: () => undefined,
    saveTextFile: () => undefined,
    readIotShadow: callbacks.read,
    requestDeepSeek: () => undefined,
    cancelRequest: (requestId) => callbacks.cancel?.(requestId),
    startAsr: () => undefined,
    sendAsrAudio: () => undefined,
    finishAsr: () => undefined,
  };
  const fakeWindow = Object.assign(new EventTarget(), { XingXunCloud: bridge });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: fakeWindow,
  });
  context.after(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  });
  return fakeWindow;
}

test("原生生命周期取消会作为 AbortError 传播，而不是普通云端错误", async (context) => {
  let requestId = "";
  const fakeWindow = installFakeAndroidWindow(context, {
    read: (value) => { requestId = value; },
  });

  const request = readHuaweiShadow();
  assert.match(requestId, /^iot-shadow-/);
  const rejection = assert.rejects(
    request,
    (error: unknown) => error instanceof DOMException
      && error.name === "AbortError"
      && error.message === "应用已进入后台，请返回后重试",
  );
  fakeWindow.dispatchEvent(new CustomEvent("xingxun:native-cloud", {
    detail: {
      requestId,
      status: 0,
      body: "",
      error: "应用已进入后台，请返回后重试",
      cancelled: true,
    },
  }));
  await rejection;
});

test("页面 AbortSignal 取消会通知原生桥并保持 AbortError", async (context) => {
  let requestId = "";
  let cancelledRequestId = "";
  installFakeAndroidWindow(context, {
    read: (value) => { requestId = value; },
    cancel: (value) => { cancelledRequestId = value; },
  });
  const controller = new AbortController();
  const request = readHuaweiShadow(controller.signal);
  const rejection = assert.rejects(
    request,
    (error: unknown) => error instanceof DOMException
      && error.name === "AbortError"
      && error.message === "页面已隐藏，暂停数据读取",
  );

  controller.abort(new DOMException("页面已隐藏，暂停数据读取", "AbortError"));
  await rejection;
  assert.equal(cancelledRequestId, requestId);
});

test("真实原生网络失败仍是可记录的普通 Error", async (context) => {
  let requestId = "";
  const fakeWindow = installFakeAndroidWindow(context, {
    read: (value) => { requestId = value; },
  });
  const request = readHuaweiShadow();
  const rejection = assert.rejects(
    request,
    (error: unknown) => error instanceof Error
      && error.name === "Error"
      && error.message === "云端请求失败",
  );

  fakeWindow.dispatchEvent(new CustomEvent("xingxun:native-cloud", {
    detail: {
      requestId,
      status: 0,
      body: "",
      error: "云端请求失败",
    },
  }));
  await rejection;
  assert.equal(isExpectedNativeCloudCancellation(new Error("云端请求失败")), false);
  assert.equal(
    isExpectedNativeCloudCancellation(new DOMException("请求已取消", "AbortError")),
    true,
  );
});
