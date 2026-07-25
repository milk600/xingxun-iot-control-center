import type {
  AgentReasoningEffort,
  AgentThinkingMode,
  ClientRole,
} from "@/app/lib/ai/contracts";
import type { AnimatedSelectOption } from "@/app/features/ui/AnimatedSelect";

export const CLIENT_ROLE_OPTIONS = [
  { value: "display", label: "电脑显示端", description: "在当前电脑执行页面动作" },
  { value: "remote", label: "安卓遥控器", description: "向在线显示端发送控制请求" },
  { value: "standalone", label: "独立设备", description: "在当前设备内独立运行" },
] as const satisfies readonly AnimatedSelectOption<ClientRole>[];

export const THINKING_MODE_OPTIONS = [
  { value: "thinking", label: "思考模式", description: "提升复杂指令和动作规划准确性" },
  { value: "non-thinking", label: "非思考模式", description: "更快响应简单查询和操作" },
] as const satisfies readonly AnimatedSelectOption<AgentThinkingMode>[];

export const REASONING_EFFORT_OPTIONS = [
  { value: "high", label: "标准（high）", description: "兼顾响应速度与规划质量" },
  { value: "max", label: "最高（max）", description: "复杂分析与多步骤任务优先" },
] as const satisfies readonly AnimatedSelectOption<AgentReasoningEffort>[];
