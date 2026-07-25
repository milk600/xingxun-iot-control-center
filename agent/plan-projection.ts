import type { AgentAction, AgentPlan } from "../app/lib/ai/contracts";

const GATEWAY_ACTIONS = new Set<AgentAction["name"]>([
  "telemetry.read_current",
  "telemetry.inspect_current",
  "vehicle.propose_move",
  "vehicle.move_distance",
  "vehicle.turn_angle",
  "vehicle.navigate_to_checkpoint",
  "vehicle.confirm",
  "vehicle.cancel",
  "vehicle.stop",
  "alerts.begin_processing",
  "alerts.complete_work_order",
]);

export function isClientExecutedAction(action: AgentAction) {
  return !GATEWAY_ACTIONS.has(action.name);
}

export function projectPlanForActionTarget(plan: AgentPlan): AgentPlan | null {
  const steps = plan.steps
    .filter((step) => isClientExecutedAction(step.action))
    .map((step, index) => ({ ...step, index: index + 1 }));
  return steps.length ? { ...plan, steps } : null;
}
