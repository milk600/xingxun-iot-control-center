import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  belongsToCurrentAgentRequest,
  clearRetryableAgentRequest,
  createAgentRequestAttempt,
  retryableAgentRequest,
  retryableVoiceInstruction,
  shouldOfferAgentRetry,
  shouldRetryAfterVehiclePendingCleared,
} from "../app/lib/ai/request-retry";

const aiContextSource = readFileSync(
  new URL("../app/features/ai/AiControlContext.tsx", import.meta.url),
  "utf8",
);
const aiVoiceBarSource = readFileSync(
  new URL("../app/features/ai/AiVoiceBar.tsx", import.meta.url),
  "utf8",
);

test("重试同一条指令会生成全新 requestId", () => {
  const ids = ["request-first", "request-retry"];
  const createId = () => ids.shift() ?? "unexpected";
  const first = createAgentRequestAttempt("  前往油桶检查  ", createId);
  const retry = createAgentRequestAttempt(first?.text ?? "", createId);

  assert.deepEqual(first, {
    requestId: "request-first",
    text: "前往油桶检查",
  });
  assert.deepEqual(retry, {
    requestId: "request-retry",
    text: "前往油桶检查",
  });
  assert.notEqual(first?.requestId, retry?.requestId);
});

test("只把进入理解阶段的完整语音转写保存为可重试指令", () => {
  assert.equal(retryableVoiceInstruction("listening", "前往油"), null);
  assert.equal(retryableVoiceInstruction("understanding", "  前往油桶检查  "), "前往油桶检查");
  assert.equal(retryableVoiceInstruction("understanding", "   "), null);
});

test("最近一次失败槽不会被其他请求的成功结果清空", () => {
  const failed = retryableAgentRequest("request-old", "检查油桶");
  assert.deepEqual(failed, {
    requestId: "request-old",
    instruction: "检查油桶",
  });
  assert.equal(clearRetryableAgentRequest(failed, "request-new"), failed);
  assert.equal(clearRetryableAgentRequest(failed, "request-old"), null);
});

test("失败槽在新任务执行期间保留但不允许触发替换", () => {
  assert.equal(shouldOfferAgentRetry({
    hasRetryableRequest: true,
    requestInFlight: false,
  }), true);
  assert.equal(shouldOfferAgentRetry({
    hasRetryableRequest: true,
    requestInFlight: true,
  }), false);
  assert.equal(shouldOfferAgentRetry({
    hasRetryableRequest: false,
    requestInFlight: false,
  }), false);
});

test("新 requestId 严格隔离旧回执和缺少关联标识的回执", () => {
  assert.equal(belongsToCurrentAgentRequest("request-new", "request-new"), true);
  assert.equal(belongsToCurrentAgentRequest("request-new", "request-old"), false);
  assert.equal(belongsToCurrentAgentRequest("request-new", ""), false);
  assert.equal(belongsToCurrentAgentRequest("", "request-first"), true);
});

test("待确认车辆任务取消、超时、替换或断开后可重试，确认成功不创建失败槽", () => {
  assert.equal(shouldRetryAfterVehiclePendingCleared("用户取消"), true);
  assert.equal(shouldRetryAfterVehiclePendingCleared("确认超时"), true);
  assert.equal(shouldRetryAfterVehiclePendingCleared("被新任务替换"), true);
  assert.equal(shouldRetryAfterVehiclePendingCleared("发起设备已断开"), true);
  assert.equal(shouldRetryAfterVehiclePendingCleared("已确认"), false);
  assert.equal(shouldRetryAfterVehiclePendingCleared(null), false);
});

test("替换取消先写入旧任务失败槽，再隔离旧任务的界面回执", () => {
  const cancelledStart = aiContextSource.indexOf('if (message.type === "agent.cancelled")');
  const cancelledEnd = aiContextSource.indexOf('if (message.type === "agent.plan"', cancelledStart);
  assert.ok(cancelledStart >= 0 && cancelledEnd > cancelledStart);
  const cancelledBlock = aiContextSource.slice(cancelledStart, cancelledEnd);
  const markIndex = cancelledBlock.indexOf("markRequestRetryable(messageRequestId)");
  const guardIndex = cancelledBlock.indexOf("if (!belongsToCurrentPlanningRequest) return");
  assert.ok(markIndex >= 0 && guardIndex > markIndex);

  assert.match(aiContextSource, /clearRequestRetryable\(messageRequestId\)/);
  assert.match(aiContextSource, /belongsToCurrentAgentRequest\([\s\S]{0,100}messageRequestId/);
});

test("重试从最近失败槽取原指令，消费旧槽后全量提交新请求", () => {
  assert.match(aiContextSource, /const retryable = retryableRequestRef\.current/);
  assert.match(aiContextSource, /replaceRetryableRequest\(null\)/);
  assert.match(aiContextSource, /submitAgentRequest\(retryable\.instruction\)/);
  assert.match(aiContextSource, /rememberRequestInstruction\(requestId, cleanText\)/);
  assert.match(aiContextSource, /createAgentRequestAttempt\(text\)/);
});

test("取消待确认车辆任务和连接中断都会登记对应原请求", () => {
  assert.match(
    aiContextSource,
    /const cancelledRequestId = pendingVehicleRequestIdRef\.current[\s\S]{0,180}markRequestRetryable\(cancelledRequestId\)/,
  );
  assert.match(
    aiContextSource,
    /shouldRetryAfterVehiclePendingCleared\(payload\.reason\)[\s\S]{0,100}markRequestRetryable\(pendingRequestId\)/,
  );
  assert.match(
    aiContextSource,
    /const interruptedRequestId = interruptedAgentRequest[\s\S]{0,520}markRequestRetryable\(interruptedRequestId\)/,
  );
});

test("页面动作失败和真实完成回执超时都会把当前整条任务设为可重试", () => {
  assert.match(
    aiContextSource,
    /if \(result\.status === "error"\)[\s\S]{0,100}markRequestRetryable\(\)/,
  );
  assert.match(
    aiContextSource,
    /actionTimerRef\.current = window\.setTimeout\([\s\S]{0,260}settleActionExecution\(\{[\s\S]{0,180}status: "error"/,
  );
});

test("网页与 Android 共用的 Agent 栏在展开和收起状态都保留重试入口", () => {
  assert.match(aiContextSource, /hasRetryableRequest:\s*boolean/);
  assert.match(aiContextSource, /retryLastRequest:\s*\(\)\s*=>\s*void/);
  assert.match(aiVoiceBarSource, /ai\.hasRetryableRequest/);
  assert.match(aiVoiceBarSource, /className=\{styles\.retryPrompt\}/);
  assert.match(aiVoiceBarSource, /className=\{styles\.retryBarButton\}/);
  assert.match(aiVoiceBarSource, /disabled=\{!ai\.canRetryLastRequest\}/);
  assert.match(aiVoiceBarSource, /ai\.retryLastRequest\(\)/);
});
