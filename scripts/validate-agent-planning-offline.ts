/**
 * Calls only the shared DeepSeek planner and prints the resulting action plan.
 * It deliberately does not import the gateway or Jetson client, so no vehicle
 * command can be sent while exercising real model responses.
 */
import { readAgentGatewayConfig } from "../agent/config";
import { decideWithDeepSeek } from "../agent/deepseek";

const prompts = process.argv.slice(2);
if (!prompts.length) {
  throw new Error("请至少提供一条待验证的 Agent 提示词。");
}

const config = {
  ...readAgentGatewayConfig(),
  mockMode: false,
  vehicleEnabled: false,
};

const runtimeContext = [
  "目标屏幕当前位于小车遥控。",
  "当前客户端是已认证电脑显示端，AI 自主控制已开启。",
  "导航上下文更新时间为刚刚。",
  "目标客户端固定检查点目录：[\"油桶\"]。标定状态：已标定；当前位置：{\"x\":0.2,\"y\":0.3,\"headingDeg\":0}；Jetson 地图修订：1。模型选择检查点时只能使用目录中的名称，不得输出或猜测坐标。",
  "本工具只验证规划结果，不会连接 Jetson 或执行任何动作。",
].join("\n");

for (const prompt of prompts) {
  const decision = await decideWithDeepSeek(
    config,
    prompt,
    [],
    runtimeContext,
    undefined,
    { thinkingMode: "thinking", reasoningEffort: "high" },
  );
  process.stdout.write(`${JSON.stringify({
    prompt,
    semantic: decision.semantic.summary,
    planQuality: decision.planQuality ?? "verified",
    warnings: decision.warnings ?? [],
    actions: decision.actions,
  }, null, 2)}\n`);
}
