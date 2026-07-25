import assert from "node:assert/strict";
import test from "node:test";
import {
  androidAgentPanelDismissOffset,
  shouldDismissAndroidAgentPanel,
} from "../app/features/ai/android-agent-panel-gesture.ts";

test("Android 智能体面板仅在足够距离或明确快速下滑时收起", () => {
  assert.equal(shouldDismissAndroidAgentPanel(20, 40, 420), false);
  assert.equal(shouldDismissAndroidAgentPanel(50, 500, 420), false);
  assert.equal(shouldDismissAndroidAgentPanel(76, 500, 420), true);
  assert.equal(shouldDismissAndroidAgentPanel(30, 40, 420), true);
  assert.equal(shouldDismissAndroidAgentPanel(-80, 40, 420), false);
});

test("Android 智能体面板退出位移覆盖完整面板并保留最小动画距离", () => {
  assert.equal(androidAgentPanelDismissOffset(420), 448);
  assert.equal(androidAgentPanelDismissOffset(80), 220);
});
