import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { textMessage } from "../../src/server/agent/context-engine";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  buildQqPrompt,
  QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE,
  QQ_JUDGEMENT_RESPONSE_SCHEMA,
  QQ_PROMPT_DEFAULTS,
  QQ_REPLY_ENVELOPE_OUTPUT_RULE,
  qqPromptMessages,
  qqReplaceOutputRule,
  qqReplaceOutputRuleInText,
  TIER_OUTPUT_RULES,
} from "../../src/server/services/qq-prompt-contract";
import {
  AGENT_DECISION_JSON_SCHEMA,
  type parseAgentDecision,
} from "../../src/shared/contracts/agent-output";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const owner = { kind: "test_job", id: "job-1", userId: "u", agentId: "a" };
const spec: AgentSpec = {
  id: "main",
  model: "chat",
  instructions: "Persona",
  context: "conversation",
  availableActions: [],
  limits: { steps: 8 },
};

/**
 * 规格 §10（响应信封协议修）：每次模型调用的实际 responseSchema 必须与系统声明同源。
 * 本测试只走公开 engine/runtime 面，用受控 port 捕获完整 ModelRequest（含 responseSchema），
 * 不接真实宿主/网关。
 */

// 与 bot-host 的 QQ_DECISION_ENVELOPE_SCHEMA 同构造：决策 schema 的 oneOf 分支附加 media。
const TEST_DECISION_ENVELOPE_SCHEMA: Record<string, unknown> = {
  ...AGENT_DECISION_JSON_SCHEMA,
  oneOf: ((AGENT_DECISION_JSON_SCHEMA.oneOf as Record<string, unknown>[]) ?? []).map((branch) => ({
    ...branch,
    properties: {
      ...((branch.properties as Record<string, unknown>) ?? {}),
      media: { type: "array", items: { type: "object" } },
    },
  })),
};
const TEST_SCORE_ENVELOPE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["scoreResult"],
  properties: {
    scoreResult: { type: "object", properties: { score: { type: "integer" } } },
    media: { type: "array", items: { type: "object" } },
  },
};
const TEST_TEXT_ENVELOPE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string" },
    media: { type: "array", items: { type: "object" } },
  },
};

function setup(model: Partial<ModelPort>) {
  const h = openBusinessDb();
  handles.push(h);
  const repository = new AgentRunRepository(h.db);
  const requests: ModelRequest[] = [];
  const port: ModelPort = {
    async complete(request) {
      requests.push(request);
      return JSON.stringify({
        kind: "final",
        outputs: [{ kind: "inline", targetId: "web", text: "ok" }],
      });
    },
    async *streamText() {
      yield "unused";
    },
    async completeMultimodal() {
      return "vision";
    },
    ...model,
  };
  const runtime = new AgentRuntime({ model: port, repository });
  const base = {
    owner,
    authorizedTargets: ["web"],
    outputMode: "buffered" as const,
    context: {
      async read() {
        return { pending: [textMessage("user", "hello")] };
      },
    },
  };
  return { h, runtime, requests, base };
}

/** 系统消息里声明给模型的 outputSchema（engine.render / renderOutput 的 JSON 块）。 */
function declaredOutputSchema(messages: readonly ModelMessage[]): unknown {
  const system = messages[0];
  if (system === undefined || system.role !== "system") throw new Error("no system message");
  for (const part of system.content) {
    if (part.kind !== "text") continue;
    for (const segment of part.text.split("\n\n")) {
      const trimmed = segment.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if ("outputSchema" in parsed) return parsed.outputSchema;
      } catch {
        // 非 JSON 段（提示词文本）跳过
      }
    }
  }
  throw new Error("system declaration carries no outputSchema");
}

describe("decision phase: actual responseSchema == system declaration (§10)", () => {
  it("plain decision declares and sends AGENT_DECISION_JSON_SCHEMA", async () => {
    const { runtime, requests, base } = setup({});
    const result = await runtime.run(spec, base);
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0].responseSchema).toEqual(AGENT_DECISION_JSON_SCHEMA);
    expect(declaredOutputSchema(requests[0].messages)).toEqual(AGENT_DECISION_JSON_SCHEMA);
  });

  it("envelope decision declares and sends the same envelope schema, hook taken exactly once", async () => {
    let hookCalls = 0;
    const { runtime, requests, base } = setup({
      async complete(request) {
        requests.push(request);
        expect(request.responseSchema).toEqual(TEST_DECISION_ENVELOPE_SCHEMA);
        // inline final 决策（stickerIds 显式 []，与生产 envelope 形状一致）：none 会以
        // no_output 静默收场，断言不到 prepared 输出——这里证明的是 envelope 解析链
        // 通到可用输出，而非静默路径。
        return JSON.stringify({
          decision: {
            kind: "final",
            outputs: [{ kind: "inline", targetId: "web", text: "ok", stickerIds: [] }],
          },
          media: [],
        });
      },
    });
    const result = await runtime.run(spec, {
      ...base,
      decisionEnvelope: () => {
        hookCalls += 1;
        return {
          responseSchema: TEST_DECISION_ENVELOPE_SCHEMA,
          parse: (raw: string) =>
            (JSON.parse(raw) as { decision: ReturnType<typeof parseAgentDecision> }).decision,
        };
      },
    });
    expect(result.status).toBe("completed");
    expect(result.outputs).toMatchObject([{ targetId: "web", status: "prepared", text: "ok" }]);
    expect(hookCalls).toBe(1);
    expect(requests[0].responseSchema).toEqual(TEST_DECISION_ENVELOPE_SCHEMA);
    expect(declaredOutputSchema(requests[0].messages)).toEqual(TEST_DECISION_ENVELOPE_SCHEMA);
  });

  it("fallback messages keep the frozen envelope declaration and the same schema", async () => {
    const envelopeHook = () => ({
      responseSchema: TEST_DECISION_ENVELOPE_SCHEMA,
      parse: (raw: string) =>
        (JSON.parse(raw) as { decision: ReturnType<typeof parseAgentDecision> }).decision,
    });
    let attempt = 0;
    const { runtime, requests, base } = setup({
      async complete(request) {
        requests.push(request);
        attempt += 1;
        if (attempt === 1) {
          const error = new Error("model cannot read images");
          (error as { code?: string }).code = "MODEL_IMAGE_UNSUPPORTED";
          throw error;
        }
        // inline final 决策（同上）：none 的 no_output 静默路径与本例无关。
        return JSON.stringify({
          decision: {
            kind: "final",
            outputs: [{ kind: "inline", targetId: "web", text: "ok", stickerIds: [] }],
          },
          media: [],
        });
      },
    });
    const result = await runtime.run(spec, {
      ...base,
      decisionEnvelope: envelopeHook,
      onPhaseMediaUnsupported: async (input) => ({
        messages: [
          ...input.messages.filter((message) => message.role !== "user"),
          textMessage("user", "qq_media_notes"),
        ],
      }),
    });
    expect(result.status).toBe("completed");
    expect(result.outputs).toMatchObject([{ targetId: "web", status: "prepared", text: "ok" }]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.responseSchema).toEqual(TEST_DECISION_ENVELOPE_SCHEMA);
      expect(declaredOutputSchema(request.messages)).toEqual(TEST_DECISION_ENVELOPE_SCHEMA);
    }
    expect(requests[1].messages.at(-1)).toEqual(textMessage("user", "qq_media_notes"));
  });
});

describe("generation phase: buffered envelope declares the body JSON (§10)", () => {
  it("renderOutput declares the structured schema and the runtime sends the same schema", async () => {
    // 受控 stub 按调用序应答：第 1 次决策、第 2 次生成 envelope 正文（旧写法以
    // generateRequest===undefined 判相，第二次调用仍命中决策分支，生成相拿到决策 JSON，
    // structured.parse 的 text 为 undefined——joint3 三红之一的脚本错）。
    let calls = 0;
    let generateRequest: ModelRequest | undefined;
    const { runtime, base } = setup({
      async complete(request) {
        calls += 1;
        if (calls === 1) {
          return JSON.stringify({
            kind: "final",
            outputs: [{ kind: "generate", targetId: "web", instructions: "answer" }],
          });
        }
        generateRequest = request;
        return JSON.stringify({ text: "hello body", media: [] });
      },
    });
    // 真实 public 组合（context-source replyInstructions 同一公开函数链）产出 full
    // instruction 串，再按宿主同一 helper 整段替换——不手拼 plain 串；plain 要求缺失或
    // 重复时 InText helper 自身抛错（fail-closed），组合含规则的断言因此是强正。
    const plainReplyInstructions = qqPromptMessages(
      buildQqPrompt({
        tier: "reply",
        path: "direct_reply",
        persona: "助手人设",
        prompts: QQ_PROMPT_DEFAULTS,
        timeline: [],
        nowSeconds: 0,
      }),
    )
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const result = await runtime.run(spec, {
      ...base,
      async prepareGeneration() {
        return {
          instructions: qqReplaceOutputRuleInText(
            plainReplyInstructions,
            "reply",
            QQ_REPLY_ENVELOPE_OUTPUT_RULE,
          ),
          responseEnvelope: {
            responseSchema: TEST_TEXT_ENVELOPE_SCHEMA,
            parse: (raw: string) => ({ text: (JSON.parse(raw) as { text: string }).text }),
          },
        };
      },
    });
    expect(result.status).toBe("completed");
    expect(result.outputs).toMatchObject([
      { targetId: "web", status: "prepared", text: "hello body" },
    ]);
    expect(generateRequest).toBeDefined();
    expect(generateRequest?.responseSchema).toEqual(TEST_TEXT_ENVELOPE_SCHEMA);
    expect(declaredOutputSchema(generateRequest?.messages ?? [])).toEqual(
      TEST_TEXT_ENVELOPE_SCHEMA,
    );
    const systemText = (generateRequest?.messages[0]?.content ?? []).flatMap((part) =>
      part.kind === "text" ? [part.text] : [],
    )[0];
    expect(systemText).not.toContain("Write only the response body");
    // 宿主替换后的 envelope instruction 进了系统段：plain reply 要求不在，{text,media} 规则在。
    expect(systemText).not.toContain(TIER_OUTPUT_RULES.reply);
    expect(systemText).toContain(QQ_REPLY_ENVELOPE_OUTPUT_RULE);
  });
});

describe("score phase: plain output rule is replaced, never appended against (§10)", () => {
  it("QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE states the envelope shape and drops the plain-only ban", () => {
    expect(QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE).toContain("scoreResult");
    expect(QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE).toContain("media");
    expect(QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE).not.toContain("不要添加其他字段");
  });

  it("qqReplaceOutputRule swaps the judgement rule in place and keeps other text byte-identical", () => {
    const systemText = `## 输出要求\n${TIER_OUTPUT_RULES.judgement}`;
    const messages: ModelMessage[] = [
      { role: "system", content: [{ kind: "text", text: systemText }] },
      { role: "user", content: [{ kind: "text", text: "时间线" }] },
    ];
    const replaced = qqReplaceOutputRule(messages, "judgement", QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE);
    expect(replaced).toHaveLength(2);
    expect(replaced[0].role).toBe("system");
    const text = replaced[0].content.flatMap((part) =>
      part.kind === "text" ? [part.text] : [],
    )[0];
    expect(text).not.toContain(TIER_OUTPUT_RULES.judgement);
    expect(text).toContain(QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE);
    expect(text.startsWith("## 输出要求\n")).toBe(true);
    expect(replaced[1]).toEqual(messages[1]);
  });

  it("score leaf sends the envelope schema with the replaced system rule on one shared choice", async () => {
    const seen: ModelRequest[] = [];
    const h = openBusinessDb();
    handles.push(h);
    const repository = new AgentRunRepository(h.db);
    const runtime = new AgentRuntime({
      model: {
        async complete(request) {
          seen.push(request);
          return JSON.stringify({ scoreResult: { score: 7 }, media: [] });
        },
        async *streamText() {
          yield "unused";
        },
        async completeMultimodal() {
          return "vision";
        },
      },
      repository,
    });
    const judgementMessages: ModelMessage[] = [
      {
        role: "system",
        content: [{ kind: "text", text: `## 输出要求\n${TIER_OUTPUT_RULES.judgement}` }],
      },
      { role: "user", content: [{ kind: "text", text: "评分材料" }] },
    ];
    await runtime.completeMessageLeaf(
      {
        id: "onebot.initiative.evaluate",
        model: "score-model",
        responseSchema: TEST_SCORE_ENVELOPE_SCHEMA,
      },
      {
        owner,
        messages: qqReplaceOutputRule(
          judgementMessages,
          "judgement",
          QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE,
        ),
        usage: { calls: 0, inputUnits: 0 },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].responseSchema).toEqual(TEST_SCORE_ENVELOPE_SCHEMA);
    const text = (seen[0].messages[0]?.content ?? []).flatMap((part) =>
      part.kind === "text" ? [part.text] : [],
    )[0];
    expect(text).toContain(QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE);
    expect(text).not.toContain(TIER_OUTPUT_RULES.judgement);
  });

  it("plain score keeps QQ_JUDGEMENT_RESPONSE_SCHEMA and the untouched plain rule", () => {
    expect(QQ_JUDGEMENT_RESPONSE_SCHEMA).toBeDefined();
    expect(TIER_OUTPUT_RULES.judgement).toContain("不要添加其他字段");
  });
});

describe("qqReplaceOutputRuleInText fail-closed (§10)", () => {
  it("replaces the plain reply rule exactly once in a real full instruction string", () => {
    const instructions = `助手人设\n\n## QQ场景行为\n行为段\n\n## 输出要求\n${TIER_OUTPUT_RULES.reply}`;
    const replaced = qqReplaceOutputRuleInText(
      instructions,
      "reply",
      QQ_REPLY_ENVELOPE_OUTPUT_RULE,
    );
    expect(replaced).not.toContain(TIER_OUTPUT_RULES.reply);
    expect(replaced).toContain(QQ_REPLY_ENVELOPE_OUTPUT_RULE);
    expect(replaced.startsWith("助手人设\n\n## QQ场景行为\n行为段\n\n## 输出要求\n")).toBe(true);
    expect(QQ_REPLY_ENVELOPE_OUTPUT_RULE).toContain("text");
    expect(QQ_REPLY_ENVELOPE_OUTPUT_RULE).toContain("media");
  });

  it("throws on unknown system text instead of silently keeping a conflicting declaration", () => {
    expect(() =>
      qqReplaceOutputRuleInText(
        "没有输出要求的未知系统文本",
        "reply",
        QQ_REPLY_ENVELOPE_OUTPUT_RULE,
      ),
    ).toThrow(/not found/);
  });

  it("throws when the plain rule appears more than once", () => {
    const duplicated = `## 输出要求\n${TIER_OUTPUT_RULES.reply}\n${TIER_OUTPUT_RULES.reply}`;
    expect(() =>
      qqReplaceOutputRuleInText(duplicated, "reply", QQ_REPLY_ENVELOPE_OUTPUT_RULE),
    ).toThrow(/exactly one/);
  });
});
