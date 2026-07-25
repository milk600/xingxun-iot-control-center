import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_ACTION_RESULT_EVENT,
  createActionDispatchDetail,
  isActionReceiverReady,
  pageActionTimeoutMs,
  registerActionReceiver,
  reportActionError,
  reportActionSuccess,
  waitForActionReceiver,
} from "../app/lib/ai/action-events";
import type { AgentActionResultDetail } from "../app/lib/ai/contracts";

const metadata = {
  requestId: "request-1",
  planId: "plan-1",
  stepIndex: 3,
  actionExecutionId: "execution-1",
} as const;

test("页面动作派发完整携带四项关联标识", () => {
  const detail = createActionDispatchDetail(
    { name: "monitoring.set_tab", arguments: { tab: "analysis" } },
    metadata,
  );
  assert.equal(detail.name, "monitoring.set_tab");
  assert.equal(detail.requestId, metadata.requestId);
  assert.equal(detail.planId, metadata.planId);
  assert.equal(detail.stepIndex, metadata.stepIndex);
  assert.equal(detail.actionExecutionId, metadata.actionExecutionId);
});

test("页面成功与失败回执原样返回动作关联，晚回执可被严格过滤", () => {
  const previousWindow = globalThis.window;
  const target = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: target,
  });
  const results: AgentActionResultDetail[] = [];
  target.addEventListener(AI_ACTION_RESULT_EVENT, (event) => {
    results.push((event as CustomEvent<AgentActionResultDetail>).detail);
  });

  try {
    const success = createActionDispatchDetail(
      { name: "settings.save", arguments: {} },
      metadata,
    );
    reportActionSuccess(success, "保存成功");
    const failure = createActionDispatchDetail(
      { name: "ui.focus_region", arguments: { page: "monitoring", region: "live-chart" } },
      { ...metadata, actionExecutionId: "execution-2", stepIndex: 4 },
    );
    reportActionError(failure, new Error("目标区域不存在"));
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  }

  assert.deepEqual(results.map((result) => ({
    actionExecutionId: result.actionExecutionId,
    actionName: result.actionName,
    status: result.status,
    message: result.message,
    requestId: result.requestId,
    planId: result.planId,
    stepIndex: result.stepIndex,
  })), [
    {
      actionExecutionId: "execution-1",
      actionName: "settings.save",
      status: "success",
      message: "保存成功",
      requestId: "request-1",
      planId: "plan-1",
      stepIndex: 3,
    },
    {
      actionExecutionId: "execution-2",
      actionName: "ui.focus_region",
      status: "error",
      message: "目标区域不存在",
      requestId: "request-1",
      planId: "plan-1",
      stepIndex: 4,
    },
  ]);
});

test("页面动作只用超时看门狗且长任务按真实时长留足窗口", () => {
  assert.equal(
    pageActionTimeoutMs({
      name: "twin.orbit",
      arguments: {
        revolutions: 1,
        durationMs: 9_000,
        elevationDeg: 35,
        direction: "clockwise",
      },
    }),
    17_000,
  );
  assert.equal(
    pageActionTimeoutMs({ name: "monitoring.generate_analysis", arguments: {} }),
    210_000,
  );
  assert.equal(
    pageActionTimeoutMs({
      name: "ui.focus_region",
      arguments: { page: "monitoring", region: "correlation-matrix" },
    }),
    15_000,
  );
  assert.equal(
    pageActionTimeoutMs({ name: "monitoring.set_tab", arguments: { tab: "analysis" } }),
    15_000,
  );
  assert.ok(pageActionTimeoutMs({ name: "settings.save", arguments: {} }) >= 30_000);
});

test("跨页动作会等待目标页面接收器挂载，并在卸载后恢复未就绪状态", async () => {
  assert.equal(isActionReceiverReady("monitoring.set_tab"), false);
  const ready = waitForActionReceiver("monitoring.set_tab", 200);
  const unregister = registerActionReceiver([
    "monitoring.set_tab",
    "monitoring.set_tab",
  ]);
  assert.equal(await ready, true);
  assert.equal(isActionReceiverReady("monitoring.set_tab"), true);
  unregister();
  unregister();
  assert.equal(isActionReceiverReady("monitoring.set_tab"), false);
  assert.equal(await waitForActionReceiver("monitoring.set_tab", 1), false);
});
