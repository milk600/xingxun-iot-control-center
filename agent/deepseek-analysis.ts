import type {
  TelemetryAnalysisFinding,
  TelemetryAnalysisRecommendation,
  TelemetryAnalysisResult,
  TelemetryFact,
} from "../app/lib/iot/telemetry-history-contracts";
import type { TelemetrySlotId } from "../app/lib/iot/contracts";
import type { AgentModelPreferences } from "../app/lib/ai/contracts";
import type { AgentGatewayConfig } from "./config";
import { deepSeekThinkingParameters } from "./deepseek";
import { fetchDeepSeekWithRetry } from "./deepseek-http";

interface ModelFinding {
  title?: unknown;
  summary?: unknown;
  factIds?: unknown;
  severity?: unknown;
}

interface ModelRecommendation {
  title?: unknown;
  rationale?: unknown;
  factIds?: unknown;
}

interface ModelAnalysis {
  headline?: unknown;
  findings?: unknown;
  recommendations?: unknown;
  caveats?: unknown;
}

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: { type: "string", maxLength: 80 },
    findings: {
      type: "array",
      description: "第一部分：只描述观测到的问题、数据缺口与不确定性，不包含任何行动建议。",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", maxLength: 40 },
          summary: { type: "string", maxLength: 140, description: "仅陈述问题及其表现，禁止写核验、检查、调整或继续观察等行动。" },
          factIds: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
          severity: { type: "string", enum: ["info", "attention"] },
        },
        required: ["title", "summary", "factIds", "severity"],
      },
    },
    recommendations: {
      type: "array",
      description: "第二部分：在问题描述完成后，给出有事实依据的处理动作。",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", maxLength: 40 },
          rationale: { type: "string", maxLength: 140 },
          factIds: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
        },
        required: ["title", "rationale", "factIds"],
      },
    },
    caveats: { type: "array", maxItems: 3, items: { type: "string", maxLength: 100 } },
  },
  required: ["headline", "findings", "recommendations", "caveats"],
} as const;

const SYSTEM_PROMPT = `你是“危化智巡物联中枢”的环境数据分析编辑器。程序已经完成全部数值统计，你只负责用简洁中文先描述问题，再给出处理建议。
硬性规则：
1. 只能引用输入 facts 中的 factId，不得编造、外推或重新计算任何读数、阈值、比例、时间或因果关系。
2. 标题、概括与建议文本中不要书写阿拉伯数字；数值证据会由界面根据 factId 自动显示。
3. 不得作医疗、健康、安全或法规合规诊断；未提供阈值时不得使用“超标、达标、安全、健康”等表述。
4. 必须先填写 findings，再填写 recommendations。findings 只能描述观测到的问题、数据不足与不确定性，不得出现“建议、应当、应该、需要、优先、核验、检查、调整、补充采样、继续观察、复核、排查、确认”等行动表达。
5. recommendations 只填写处理动作及其依据，不要把整段问题描述重复一遍。
6. 设备上报零值时，findings 只能描述零值或平线；核验传感器只能写入 recommendations，不得据此判断环境优良。
7. 相关性只描述同步变化，不代表因果。
8. 样本不足或覆盖率偏低时，在 findings 描述数据限制，把补充采样只写入 recommendations。
9. 最终答案只返回符合 outputSchema 的 JSON 对象，不要使用 Markdown 代码块，不要输出说明文字，不展示思维过程。
`;

const ANALYSIS_OUTPUT_TOKENS = 4_096;
const ANALYSIS_REPAIR_OUTPUT_TOKENS = 8_192;
const ANALYSIS_REPAIR_PROMPT = "上一版结构化分析为空或因长度限制未完成。请基于同一组 facts 重新返回一份完整的严格 JSON；只输出最终 JSON，不要输出解释、Markdown 或思维过程。";

export type TelemetryAnalysisModelPhase = "analyzing" | "organizing";

export async function analyzeTelemetryWithDeepSeek(
  config: AgentGatewayConfig,
  deterministic: TelemetryAnalysisResult,
  onPhase?: (phase: TelemetryAnalysisModelPhase) => void,
  modelPreferences?: Partial<AgentModelPreferences>,
): Promise<TelemetryAnalysisResult> {
  if (config.mockMode) throw new Error("模拟模式不调用 DeepSeek 分析");
  if (!config.deepSeekApiKey) throw new Error("尚未配置 DEEPSEEK_API_KEY");
  if (!deterministic.facts.length) return deterministic;

  onPhase?.("analyzing");
  const effectiveModelPreferences: AgentModelPreferences = {
    thinkingMode: modelPreferences?.thinkingMode === "non-thinking" ? "non-thinking" : "thinking",
    reasoningEffort: modelPreferences?.reasoningEffort === "high"
      ? "high"
      : modelPreferences?.reasoningEffort === "max"
        ? "max"
        : config.telemetryAnalysisReasoningEffort,
  };
  const structuredOutput = await requestStructuredTelemetryAnalysis(
    config,
    deterministic,
    effectiveModelPreferences,
  );
  onPhase?.("organizing");

  let raw: ModelAnalysis;
  try {
    raw = JSON.parse(normalizeJsonObject(structuredOutput)) as ModelAnalysis;
  } catch {
    throw new Error("DeepSeek 返回的分析格式无效");
  }
  return validateModelAnalysis(deterministic, raw);
}

async function requestStructuredTelemetryAnalysis(
  config: AgentGatewayConfig,
  deterministic: TelemetryAnalysisResult,
  modelPreferences: AgentModelPreferences,
  repairAttempt = false,
): Promise<string> {
  const response = await fetchDeepSeekWithRetry(`${config.deepSeekBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.deepSeekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.telemetryAnalysisModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            basis: deterministic.basis,
            facts: deterministic.facts,
            existingCaveats: deterministic.caveats,
            outputSchema: ANALYSIS_SCHEMA,
          }),
        },
        ...(repairAttempt ? [{ role: "system", content: ANALYSIS_REPAIR_PROMPT }] : []),
      ],
      response_format: { type: "json_object" },
      ...deepSeekThinkingParameters(modelPreferences),
      max_tokens: repairAttempt ? ANALYSIS_REPAIR_OUTPUT_TOKENS : ANALYSIS_OUTPUT_TOKENS,
    }),
  }, repairAttempt ? 90_000 : 60_000);

  const payload = await response.json() as {
    error?: { message?: string };
    choices?: Array<{
      finish_reason?: string | null;
      message?: {
        content?: string | null;
      };
    }>;
  };
  if (!response.ok) throw new Error(payload.error?.message || `DeepSeek 分析请求失败（${response.status}）`);
  const choice = payload.choices?.[0];
  if (choice?.finish_reason === "content_filter") {
    throw new Error("DeepSeek 结构化分析被内容过滤中止");
  }
  if (choice?.finish_reason === "insufficient_system_resource") {
    throw new Error("DeepSeek 结构化分析暂时不可用（推理资源不足）");
  }
  if (choice?.finish_reason === "length") {
    if (!repairAttempt) return requestStructuredTelemetryAnalysis(config, deterministic, modelPreferences, true);
    throw new Error("DeepSeek 结构化分析未完成（输出达到长度限制）");
  }
  if (choice?.finish_reason && choice.finish_reason !== "stop") {
    throw new Error(`DeepSeek 结构化分析异常中止（${choice.finish_reason}）`);
  }
  // JSON Output places the validated candidate in the final content. Thinking
  // text is deliberately absent from this type and is never inspected.
  const structuredOutput = choice?.message?.content?.trim();
  if (!structuredOutput) {
    if (!repairAttempt) return requestStructuredTelemetryAnalysis(config, deterministic, modelPreferences, true);
    throw new Error("DeepSeek 未返回结构化分析");
  }
  return structuredOutput;
}

export function validateModelAnalysis(
  deterministic: TelemetryAnalysisResult,
  raw: ModelAnalysis,
): TelemetryAnalysisResult {
  const factMap = new Map(deterministic.facts.map((fact) => [fact.id, fact]));
  const headline = safeFindingText(raw.headline, 80) ?? deterministic.headline;
  const findings = Array.isArray(raw.findings)
    ? raw.findings.slice(0, 3).flatMap((item, index) => {
        const parsed = validateFinding(item as ModelFinding, index, factMap);
        return parsed ? [parsed] : [];
      })
    : [];
  const recommendations = Array.isArray(raw.recommendations)
    ? raw.recommendations.slice(0, 3).flatMap((item, index) => {
        const parsed = validateRecommendation(item as ModelRecommendation, index, factMap);
        return parsed ? [parsed] : [];
      })
    : [];
  const modelCaveats = Array.isArray(raw.caveats)
    ? raw.caveats.flatMap((item) => {
        const text = safeModelText(item, 100);
        return text ? [text] : [];
      }).slice(0, 3)
    : [];

  return {
    ...deterministic,
    status: deterministic.status === "insufficient-data" ? "insufficient-data" : "complete",
    headline,
    findings: findings.length ? findings : deterministic.findings,
    recommendations: recommendations.length ? recommendations : deterministic.recommendations,
    caveats: [...new Set([...deterministic.caveats, ...modelCaveats])].slice(0, 5),
    generatedAt: new Date().toISOString(),
  };
}

function validateFinding(
  raw: ModelFinding,
  index: number,
  factMap: Map<string, TelemetryFact>,
): TelemetryAnalysisFinding | null {
  const title = safeFindingText(raw.title, 40);
  const summary = safeFindingText(raw.summary, 140);
  const factIds = validFactIds(raw.factIds, factMap);
  if (!title || !summary || !factIds.length) return null;
  return {
    id: `ai-finding-${index + 1}`,
    title,
    summary,
    factIds,
    severity: raw.severity === "attention" ? "attention" : "info",
  };
}

function validateRecommendation(
  raw: ModelRecommendation,
  index: number,
  factMap: Map<string, TelemetryFact>,
): TelemetryAnalysisRecommendation | null {
  const title = safeModelText(raw.title, 40);
  const rationale = safeModelText(raw.rationale, 140);
  const factIds = validFactIds(raw.factIds, factMap);
  if (!title || !rationale || !factIds.length) return null;
  const relatedSlotIds = [...new Set(factIds.flatMap((id) => factMap.get(id)?.slotIds ?? []))] as TelemetrySlotId[];
  return {
    id: `ai-recommendation-${index + 1}`,
    title,
    rationale,
    factIds,
    relatedSlotIds,
  };
}

function validFactIds(value: unknown, factMap: Map<string, TelemetryFact>) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && factMap.has(id)))].slice(0, 4);
}

function safeModelText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().slice(0, maxLength);
  if (
    !text
    || /\d/.test(text)
    || /(?:百分之|[零〇一二两三四五六七八九十百千万亿]+(?:个|次|组|路|项|天|小时|分钟|秒|点|度|％|%))/.test(text)
    || /(?:医疗|医学|诊断|致病|健康风险|安全结论|危险|超标|达标|法规|合规|导致|引起|证明.*因果)/.test(text)
  ) return null;
  return text;
}

function safeFindingText(value: unknown, maxLength: number) {
  const text = safeModelText(value, maxLength);
  if (
    !text
    || /(?:建议|应当|应该|需要|需先|需补充|请|优先|核验|检查|调整|采取|补充采样|继续观察|复核|排查|确认|增加采样|减少采样)/u.test(text)
  ) return null;
  return text;
}

function normalizeJsonObject(value: string) {
  const raw = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return raw;
  return raw.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
}
