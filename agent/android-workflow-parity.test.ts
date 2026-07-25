import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const androidRuntime = readFileSync(
  new URL("../offline/local-agent-runtime.ts", import.meta.url),
  "utf8",
);
const sharedPlanner = readFileSync(new URL("./deepseek.ts", import.meta.url), "utf8");
const desktopGateway = readFileSync(new URL("./gateway.ts", import.meta.url), "utf8");

test("Android 与网页端共用规划器：纯页面导航走共享白名单，其余请求走完整 DeepSeek 两阶段规划", () => {
  assert.match(androidRuntime, /const decision = await decideWithDeepSeek\(\s*config,/);
  assert.doesNotMatch(androidRuntime, /localFastPath|isDeterministicDeviceCommand|mockMode:\s*true/);
  assert.doesNotMatch(androidRuntime, /deterministicEvidencePlanning|localSemanticEvidencePlanning/);
  assert.doesNotMatch(androidRuntime, /modelRequestTimeoutMs|modelRepairTimeoutMs/);
  assert.match(androidRuntime, /model:\s*"deepseek-v4-flash"/);
  assert.match(androidRuntime, /telemetryAnalysisModel:\s*"deepseek-v4-flash"/);
  assert.match(androidRuntime, /telemetryAnalysisReasoningEffort:\s*"high"/);
  assert.match(androidRuntime, /mockMode:\s*false/);
  assert.match(androidRuntime, /reasoningMode:\s*"always"/);
  assert.match(androidRuntime, /private thinkingMode: AgentThinkingMode = "thinking"/);
  assert.match(androidRuntime, /private reasoningEffort: AgentReasoningEffort = "high"/);
  assert.match(androidRuntime, /thinkingMode: this\.thinkingMode/);
  assert.match(androidRuntime, /reasoningEffort: this\.reasoningEffort/);

  assert.match(sharedPlanner, /deterministicImmediateNavigationDecision\(input\)/);
  assert.match(sharedPlanner, /if \(immediateNavigation\) \{/);
  assert.match(sharedPlanner, /const NAVIGATION_ROUTES:/);
  assert.match(sharedPlanner, /matches\.length === 1/);
  assert.match(sharedPlanner, /requestDeepSeekSemanticBrief\(config,/);
  assert.match(sharedPlanner, /requestDeepSeekPlan\(\s*config,/);
  assert.match(sharedPlanner, /thinking:\s*\{\s*type:\s*"enabled"/);
  assert.match(sharedPlanner, /thinking:\s*\{\s*type:\s*"disabled"/);
  assert.match(sharedPlanner, /reasoning_effort:\s*preferences\.reasoningEffort/);
});

test("网页与 Android 的即时导航和车辆急停都在读取遥测上下文前判定", () => {
  for (const runtime of [desktopGateway, androidRuntime]) {
    assert.match(runtime, /deterministicImmediateNavigationDecision/);
    assert.match(runtime, /isExplicitVehicleEmergencyStop/);
    assert.match(runtime, /const skipsTelemetryContext =/);
    assert.match(runtime, /skipsTelemetryContext[\s\S]{0,300}\?[\s\S]{0,200}本次请求是不依赖遥测数据的即时动作/);
  }
  assert.match(sharedPlanner, /if \(isExplicitVehicleEmergencyStop\(input\)\) \{/);
  assert.match(sharedPlanner, /车辆急停无需模型规划或二次确认/);
});

test("Android 独立端透传规划质量并为固定点导航与到点检测使用本机执行器", () => {
  assert.match(androidRuntime, /navigationContext\?: unknown/);
  assert.match(
    androidRuntime,
    /parseAndroidNavigationContext\(\s*payload\.navigationContext/,
  );
  assert.match(
    androidRuntime,
    /planQuality:\s*planWarnings\.length\s*\?\s*"best-effort"\s*:\s*decision\.planQuality\s*\?\?\s*"verified"/,
  );
  assert.match(
    androidRuntime,
    /const planWarnings =[\s\S]{0,240}compiledPlan\.warnings/,
  );
  assert.match(
    androidRuntime,
    /action\.name === "vehicle\.navigate_to_checkpoint"[\s\S]{0,180}executeCheckpointNavigation/,
  );
  assert.match(
    androidRuntime,
    /action\.name === "telemetry\.inspect_current"[\s\S]{0,180}inspectCurrentTelemetry/,
  );
  assert.match(
    androidRuntime,
    /executeCheckpointNavigation[\s\S]*executeNavigation\(\{/,
  );
  assert.match(
    androidRuntime,
    /inspectCurrentTelemetry[\s\S]*waitForFreshLiveTelemetry\(\{/,
  );
  assert.match(
    androidRuntime,
    /AndroidCheckpointInspectionError[\s\S]*error\.lastSnapshot[\s\S]*本次不判定为正常或异常/,
  );
  assert.match(
    androidRuntime,
    /this\.send\("action\.dispatch",\s*\{[\s\S]{0,180}actionExecutionId/,
  );
  assert.match(androidRuntime, /case "action\.result":/);
  assert.match(
    androidRuntime,
    /payload\.actionExecutionId[\s\S]{0,500}waiter\.resolve\(null\)/,
  );
  assert.match(
    androidRuntime,
    /\{ id: "execution", label: "执行动作", status: "pending"/,
  );
  assert.match(
    androidRuntime,
    /update\(\s*"execution",\s*"active"[\s\S]{0,900}update\(\s*"execution",\s*"complete"/,
  );
});

test("Android 与网页端使用同一页面动作超时，并在逐图讲解期间暂停完成回执计时", () => {
  assert.match(
    androidRuntime,
    /import \{ pageActionTimeoutMs \} from "@\/app\/lib\/ai\/action-events";/,
  );
  assert.match(androidRuntime, /case "action\.execution-state":/);
  assert.match(
    androidRuntime,
    /payload\.executionState !== "queued"[\s\S]*payload\.executionState !== "started"[\s\S]*payload\.executionState !== "cancelled"/,
  );
  assert.match(
    androidRuntime,
    /waitingForGuide \? 30 \* 60_000 : waiter\.actionTimeoutMs/,
  );
  assert.match(
    androidRuntime,
    /PagePresentationCancelledError[\s\S]*已按你的选择结束本次证据讲解，其余可视步骤未执行/,
  );
  assert.doesNotMatch(
    androidRuntime,
    /function pageActionTimeoutMs\(action: AgentAction\)/,
  );
});
