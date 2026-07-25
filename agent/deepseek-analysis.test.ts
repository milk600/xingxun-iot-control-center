import assert from "node:assert/strict";
import test from "node:test";
import type { TelemetryAnalysisResult } from "../app/lib/iot/telemetry-history-contracts";
import type { AgentGatewayConfig } from "./config";
import { analyzeTelemetryWithDeepSeek, validateModelAnalysis } from "./deepseek-analysis";

function deterministicResult(): TelemetryAnalysisResult {
  return {
    requestId: "analysis-1",
    status: "complete",
    generatedAt: "2026-07-20T01:00:00.000Z",
    dataVersion: "2026-07-20T01:00:00.000Z",
    basis: {
      provider: "huawei-cloud",
      isDemo: false,
      windowStart: "2026-07-20T00:00:00.000Z",
      windowEnd: "2026-07-20T01:00:00.000Z",
      sampleCount: 20,
      uniqueObservations: 20,
      coverage: 0.9,
      quality: "high",
    },
    headline: "本地统计已完成",
    facts: [{
      id: "fact-slot-1-range",
      kind: "range",
      slotIds: ["slot-1"],
      statement: "环境温度存在可观测变化",
      values: { minimum: 24, maximum: 28 },
      unit: "°C",
      windowStart: "2026-07-20T00:00:00.000Z",
      windowEnd: "2026-07-20T01:00:00.000Z",
    }],
    findings: [],
    recommendations: [],
    caveats: [],
  };
}

const analysisConfig = {
  mockMode: false,
  deepSeekApiKey: "test-only",
  deepSeekBaseUrl: "https://api.deepseek.com",
  telemetryAnalysisModel: "deepseek-v4-flash",
  telemetryAnalysisReasoningEffort: "high",
} as AgentGatewayConfig;

function validAnalysisJson(headline = "当前数据存在可观测变化") {
  return JSON.stringify({
    headline,
    findings: [],
    recommendations: [],
    caveats: [],
  });
}

test("结构化分析只保留已知事实引用并从事实推导相关数据位", () => {
  const result = validateModelAnalysis(deterministicResult(), {
    headline: "当前环境存在可观测变化",
    findings: [{
      title: "温度出现变化",
      summary: "当前区间的温度读数存在可观测变化",
      factIds: ["fact-slot-1-range", "unknown-fact"],
      severity: "attention",
    }],
    recommendations: [{
      title: "继续观察温度",
      rationale: "当前事实支持进一步复核",
      factIds: ["fact-slot-1-range"],
    }],
    caveats: ["相关变化不代表因果"],
  });

  assert.deepEqual(result.findings[0]?.factIds, ["fact-slot-1-range"]);
  assert.deepEqual(result.recommendations[0]?.relatedSlotIds, ["slot-1"]);
  assert.equal(result.caveats[0], "相关变化不代表因果");
});

test("问题描述拒绝行动建议并保留独立的处理建议", () => {
  const deterministic = deterministicResult();
  const result = validateModelAnalysis(deterministic, {
    headline: "当前环境存在可观测变化",
    findings: [{
      title: "建议检查温度",
      summary: "需要继续观察并核验传感器",
      factIds: ["fact-slot-1-range"],
      severity: "attention",
    }],
    recommendations: [{
      title: "继续观察温度",
      rationale: "当前事实支持进一步复核",
      factIds: ["fact-slot-1-range"],
    }],
    caveats: [],
  });

  assert.deepEqual(result.findings, deterministic.findings);
  assert.equal(result.recommendations[0]?.title, "继续观察温度");
  assert.deepEqual(result.recommendations[0]?.relatedSlotIds, ["slot-1"]);
});

test("拒绝包含模型自造数字的文字并回退确定性概括", () => {
  const deterministic = deterministicResult();
  const result = validateModelAnalysis(deterministic, {
    headline: "温度升高了 99 度",
    findings: [{
      title: "出现 99 度变化",
      summary: "这是模型虚构的数字",
      factIds: ["fact-slot-1-range"],
      severity: "attention",
    }],
    recommendations: [],
    caveats: [],
  });

  assert.equal(result.headline, deterministic.headline);
  assert.deepEqual(result.findings, deterministic.findings);
});

test("拒绝模型生成的健康、阈值和因果结论", () => {
  const deterministic = deterministicResult();
  const result = validateModelAnalysis(deterministic, {
    headline: "当前环境已经达标",
    findings: [{
      title: "存在健康风险",
      summary: "温度变化导致其他指标变化",
      factIds: ["fact-slot-1-range"],
      severity: "attention",
    }],
    recommendations: [],
    caveats: [],
  });

  assert.equal(result.headline, deterministic.headline);
  assert.deepEqual(result.findings, deterministic.findings);
});

test("遥测建议使用 V4 Flash 思考模式且只公开处理阶段", async (context) => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          reasoning_content: "不应进入产品界面的隐藏推理",
          content: JSON.stringify({
            headline: "当前数据存在可观测变化",
            findings: [],
            recommendations: [],
            caveats: [],
          }),
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const config = {
    mockMode: false,
    deepSeekApiKey: "test-only",
    deepSeekBaseUrl: "https://api.deepseek.com",
    telemetryAnalysisModel: "deepseek-v4-flash",
    telemetryAnalysisReasoningEffort: "high",
  } as AgentGatewayConfig;
  const phases: string[] = [];
  const result = await analyzeTelemetryWithDeepSeek(config, deterministicResult(), (phase) => phases.push(phase));

  const capturedBody = requestBody as unknown as Record<string, unknown>;
  assert.equal(capturedBody.model, "deepseek-v4-flash");
  assert.deepEqual(capturedBody.thinking, { type: "enabled" });
  assert.equal(capturedBody.reasoning_effort, "high");
  assert.equal("temperature" in capturedBody, false);
  assert.deepEqual(capturedBody.response_format, { type: "json_object" });
  assert.equal(capturedBody.max_tokens, 4_096);
  assert.equal("tools" in capturedBody, false);
  assert.equal("tool_choice" in capturedBody, false);
  assert.deepEqual(phases, ["analyzing", "organizing"]);
  assert.equal(result.headline, "当前数据存在可观测变化");
  assert.equal(JSON.stringify(result).includes("隐藏推理"), false);
});

test("遥测建议遵循非思考模式并省略推理强度", async (context) => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            headline: "当前数据存在可观测变化",
            findings: [],
            recommendations: [],
            caveats: [],
          }),
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await analyzeTelemetryWithDeepSeek({
    mockMode: false,
    deepSeekApiKey: "test-only",
    deepSeekBaseUrl: "https://api.deepseek.com",
    telemetryAnalysisModel: "deepseek-v4-flash",
    telemetryAnalysisReasoningEffort: "max",
  } as AgentGatewayConfig, deterministicResult(), undefined, {
    thinkingMode: "non-thinking",
    reasoningEffort: "max",
  });

  const capturedBody = requestBody as unknown as Record<string, unknown>;
  assert.deepEqual(capturedBody.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in capturedBody, false);
});

test("官方返回最终 content JSON 时仍能安全解析结构化分析", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: {
        content: `\`\`\`json\n${JSON.stringify({
          headline: "当前数据存在可观测变化",
          findings: [{
            title: "温度出现变化",
            summary: "当前区间的温度读数存在可观测变化",
            factIds: ["fact-slot-1-range"],
            severity: "attention",
          }],
          recommendations: [],
          caveats: [],
        })}\n\`\`\``,
        reasoning_content: "这是不应进入结果的隐藏推理",
      },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  const result = await analyzeTelemetryWithDeepSeek({
    mockMode: false,
    deepSeekApiKey: "test-only",
    deepSeekBaseUrl: "https://api.deepseek.com",
    telemetryAnalysisModel: "deepseek-v4-flash",
    telemetryAnalysisReasoningEffort: "high",
  } as AgentGatewayConfig, deterministicResult());

  assert.equal(result.headline, "当前数据存在可观测变化");
  assert.equal(result.findings[0]?.title, "温度出现变化");
  assert.equal(JSON.stringify(result).includes("隐藏推理"), false);
});

test("结构化分析达到长度限制后仅重试一次，并使用有界高预算 JSON Output", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (requestBodies.length === 1) {
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "length",
          message: {
            content: validAnalysisJson("这份正文即使完整也因截断标记而不能采用"),
            reasoning_content: "隐藏推理不得进入结果",
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          content: validAnalysisJson("修复后的环境分析"),
          reasoning_content: "修复阶段的隐藏推理也不得进入结果",
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const phases: string[] = [];
  const result = await analyzeTelemetryWithDeepSeek(
    analysisConfig,
    deterministicResult(),
    (phase) => phases.push(phase),
  );

  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].max_tokens, 4_096);
  assert.equal(requestBodies[1].max_tokens, 8_192);
  assert.deepEqual(requestBodies[0].response_format, { type: "json_object" });
  assert.deepEqual(requestBodies[1].response_format, { type: "json_object" });
  const repairMessages = requestBodies[1].messages as Array<{ role?: string; content?: string }>;
  assert.match(repairMessages.at(-1)?.content ?? "", /上一版结构化分析为空或因长度限制未完成/);
  assert.deepEqual(phases, ["analyzing", "organizing"]);
  assert.equal(result.headline, "修复后的环境分析");
  assert.equal(JSON.stringify(result).includes("隐藏推理"), false);
});

test("stop 但最终 content 为空时会修复一次，绝不读取 reasoning_content", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: {
            content: null,
            reasoning_content: validAnalysisJson("隐藏推理伪装的分析"),
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { content: validAnalysisJson("空正文修复后的分析") },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const result = await analyzeTelemetryWithDeepSeek(analysisConfig, deterministicResult());

  assert.equal(callCount, 2);
  assert.equal(result.headline, "空正文修复后的分析");
  assert.doesNotMatch(JSON.stringify(result), /隐藏推理伪装/);
});

test("第二次仍达到长度限制时明确失败且不会发起第三次请求", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { content: "{\"headline\":" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await assert.rejects(
    analyzeTelemetryWithDeepSeek(analysisConfig, deterministicResult()),
    /结构化分析未完成（输出达到长度限制）/,
  );
  assert.equal(callCount, 2);
});

test("stop 返回非空但无效 JSON 时直接报告格式错误，不触发修复请求", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "{not-json" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await assert.rejects(
    analyzeTelemetryWithDeepSeek(analysisConfig, deterministicResult()),
    /返回的分析格式无效/,
  );
  assert.equal(callCount, 1);
});

test("内容过滤不会被当作空正文修复，也不会解析返回内容", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "content_filter",
        message: {
          content: validAnalysisJson("不得采用的过滤结果"),
          reasoning_content: "不得读取",
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await assert.rejects(
    analyzeTelemetryWithDeepSeek(analysisConfig, deterministicResult()),
    /结构化分析被内容过滤中止/,
  );
  assert.equal(callCount, 1);
});

test("非 stop 的其他结束原因不会被当作空正文重试", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "tool_calls", message: { content: null } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await assert.rejects(
    analyzeTelemetryWithDeepSeek(analysisConfig, deterministicResult()),
    /结构化分析异常中止（tool_calls）/,
  );
  assert.equal(callCount, 1);
});

test("不会把 reasoning_content 当作结构化分析解析", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          content: "",
          reasoning_content: JSON.stringify({
            headline: "隐藏推理不得暴露",
            findings: [],
            recommendations: [],
            caveats: [],
          }),
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await assert.rejects(
    analyzeTelemetryWithDeepSeek({
      mockMode: false,
      deepSeekApiKey: "test-only",
      deepSeekBaseUrl: "https://api.deepseek.com",
      telemetryAnalysisModel: "deepseek-v4-flash",
      telemetryAnalysisReasoningEffort: "high",
    } as AgentGatewayConfig, deterministicResult()),
    (error: unknown) => error instanceof Error
      && error.message === "DeepSeek 未返回结构化分析"
      && !error.message.includes("隐藏推理"),
  );
  assert.equal(callCount, 2);
});
