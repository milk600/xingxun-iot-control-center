import assert from "node:assert/strict";
import test from "node:test";
import type { AgentPlan } from "../app/lib/ai/contracts";
import { projectPlanForActionTarget } from "./plan-projection";

function plan(steps: AgentPlan["steps"]): AgentPlan {
  return {
    id: "plan-1",
    requestId: "request-1",
    summary: "测试计划",
    planningMode: "thinking",
    createdAt: new Date(0).toISOString(),
    steps,
  };
}

test("纯网关动作不向显示端发布无法完成的空计划", () => {
  const projected = projectPlanForActionTarget(plan([
    { index: 1, label: "读取数据", action: { name: "telemetry.read_current", arguments: { slotId: "slot-1" } } },
  ]));
  assert.equal(projected, null);
});

test("跨屏计划只保留显示端实际执行的动作并重新编号", () => {
  const projected = projectPlanForActionTarget(plan([
    { index: 1, label: "读取数据", action: { name: "telemetry.read_current", arguments: {} } },
    { index: 2, label: "打开监测", action: { name: "ui.navigate", arguments: { page: "monitoring" } } },
    { index: 3, label: "查看热力", action: { name: "ui.focus_region", arguments: { page: "monitoring", region: "daily-heatmap" } } },
  ]));
  assert.deepEqual(projected?.steps.map((step) => [step.index, step.action.name]), [
    [1, "ui.navigate"],
    [2, "ui.focus_region"],
  ]);
});

test("网关直连 Jetson 后车辆动作不再投影给显示端伪执行", () => {
  const projected = projectPlanForActionTarget(plan([
    { index: 1, label: "准备车辆任务", action: { name: "vehicle.propose_move", arguments: { motion: "forward", speedPercent: 10, durationMs: 500 } } },
    { index: 2, label: "停止车辆", action: { name: "vehicle.stop", arguments: {} } },
  ]));
  assert.equal(projected, null);
});

test("网关持久化的告警工单动作不投影给显示端造成进度悬挂", () => {
  const projected = projectPlanForActionTarget(plan([
    {
      index: 1,
      label: "开始处理工单",
      action: {
        name: "alerts.begin_processing",
        arguments: { alertId: "alert-1", expectedVersion: 1 },
      },
    },
    {
      index: 2,
      label: "完成工单",
      action: {
        name: "alerts.complete_work_order",
        arguments: {
          alertId: "alert-1",
          expectedVersion: 2,
          action: "site-inspection",
          note: "现场检查完成，确认设备运行状态正常。",
        },
      },
    },
  ]));
  assert.equal(projected, null);
});
