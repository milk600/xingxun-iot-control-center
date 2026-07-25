import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const androidBridge = readFileSync(
  new URL("../android/app/src/main/java/com/xingxun/iotcontrol/AndroidCloudBridge.java", import.meta.url),
  "utf8",
);
const mainActivity = readFileSync(
  new URL("../android/app/src/main/java/com/xingxun/iotcontrol/MainActivity.java", import.meta.url),
  "utf8",
);
const nativeCloud = readFileSync(new URL("../offline/native-cloud.ts", import.meta.url), "utf8");
const aiControl = readFileSync(
  new URL("../app/features/ai/AiControlContext.tsx", import.meta.url),
  "utf8",
);
const devRunner = readFileSync(new URL("./dev-runner.ts", import.meta.url), "utf8");
const swipeProbe = readFileSync(
  new URL("../scripts/test-android-agent-swipe.mjs", import.meta.url),
  "utf8",
);

test("Android Fun-ASR 的所有并发入口受同一会话锁保护并有三阶段看门狗", () => {
  assert.match(androidBridge, /ASR_CONNECT_TIMEOUT_MS\s*=\s*10_000L/);
  assert.match(androidBridge, /ASR_START_TIMEOUT_MS\s*=\s*10_000L/);
  assert.match(androidBridge, /ASR_FINISH_TIMEOUT_MS\s*=\s*8_000L/);
  for (const method of [
    "open",
    "onOpen",
    "onMessage",
    "onFailure",
    "onClosed",
    "push",
    "finish",
    "finishNow",
    "complete",
    "fail",
    "cancelForLifecycle",
    "close",
  ]) {
    assert.match(androidBridge, new RegExp(`synchronized void ${method}\\(`));
  }
  assert.match(androidBridge, /terminalDispatched/);
  assert.match(androidBridge, /if \(!started && queuedAudio\.isEmpty\(\)\) \{\s*complete\(""\)/);
  assert.match(androidBridge, /latestTranscript/);
});

test("Android 亮屏由路由与 Agent 活跃阶段共同驱动并在后台清理", () => {
  assert.match(nativeCloud, /setAgentActivity\(phase: "recording" \| "planning" \| "executing" \| "vehicle", active: boolean\)/);
  assert.match(androidBridge, /public void setAgentActivity\(String phase, boolean active\)/);
  assert.match(mainActivity, /activeAgentActivities/);
  assert.match(mainActivity, /!activeAgentActivities\.isEmpty\(\)/);
  for (const phase of ["recording", "planning", "executing", "vehicle"]) {
    assert.match(mainActivity, new RegExp(`"${phase}"\\.equals\\(phase\\)`));
  }
  assert.match(mainActivity, /protected void onPause\(\)[\s\S]*activeAgentActivities\.clear\(\)[\s\S]*FLAG_KEEP_SCREEN_ON/);
  for (const phase of ["recording", "planning", "executing", "vehicle"]) {
    assert.match(aiControl, new RegExp(`setNativeAgentActivity\\("${phase}", native`));
    assert.match(aiControl, new RegExp(`setNativeAgentActivity\\("${phase}", false\\)`));
  }
});

test("源工程启动器监管防休眠进程并在任一子服务退出时联动关闭", () => {
  assert.match(devRunner, /delivery-keep-awake\.ps1/);
  assert.match(devRunner, /superviseService\("防休眠服务", keepAwake\)/);
  assert.match(devRunner, /for \(const child of children\) stopChild\(child\)/);
  assert.match(devRunner, /taskkill\.exe/);
  assert.match(devRunner, /\["\/PID", String\(child\.pid\), "\/T", "\/F"\]/);
  assert.match(devRunner, /process\.once\("SIGINT", \(\) => shutdown\(0\)\)/);
  assert.match(devRunner, /process\.once\("SIGTERM", \(\) => shutdown\(0\)\)/);
});

test("Android 下滑探针要求面板和按住说话胶囊一起滑出且动画保留", () => {
  assert.match(swipeProbe, /panelHiddenOrBelow/);
  assert.match(swipeProbe, /micCapsuleHiddenOrBelow/);
  assert.match(swipeProbe, /hostTransitionDuration/);
  assert.match(swipeProbe, /wakeVisible/);
  assert.doesNotMatch(swipeProbe, /barVisible/);
});
