import { afterEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { textMessage } from "../../src/server/agent/context-engine";
import { createModelPort } from "../../src/server/agent/model-port";
import {
  parseModelEnvelope,
  parseModelScoreEnvelope,
  parseModelTextEnvelope,
} from "../../src/server/agent/model-response-envelope";
import {
  QQ_SCORE_ENVELOPE_SCHEMA,
  QQ_TEXT_ENVELOPE_SCHEMA,
} from "../../src/server/channels/onebot11/bot-host";
import {
  QQ_DECISION_ENVELOPE_SCHEMA,
  QQ_DECISION_JSON_SCHEMA,
} from "../../src/server/channels/onebot11/qq-reply-decision-contract";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { createLmStudioClient, type ModelTool } from "../../src/server/llm/model-gateway";
import {
  AGENT_DECISION_JSON_SCHEMA,
  AgentDecisionSchema,
} from "../../src/shared/contracts/agent-output";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

type FunctionTool = { type: string; function: ModelTool };
function setup(handler: (body: Record<string, unknown>) => Response, external = true) {
  const sent: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET") return Response.json({ data: [] });
      const body = (await request.json()) as Record<string, unknown>;
      sent.push(body);
      return handler(body);
    },
  });
  cleanups.push(() => server.stop(true));
  const baseUrl = `http://127.0.0.1:${server.port}/v1`;
  const gateway = createLmStudioClient(
    { baseUrl, model: "fixture", timeoutSeconds: 5 },
    external ? { externalModel: () => ({ baseUrl, apiKey: null, contextWindow: 8192 }) } : {},
  );
  return { gateway, sent };
}
function response(finish: string, name?: string, args = "{}", content: string | null = null) {
  return Response.json({
    choices: [
      {
        finish_reason: finish,
        message: {
          content,
          ...(name === undefined
            ? {}
            : { tool_calls: [{ type: "function", function: { name, arguments: args } }] }),
        },
      },
    ],
  });
}
const lookup: ModelTool = {
  name: "fixture.read",
  description: "Read a value",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};
const request = { messages: [{ role: "user", content: "synthetic input" }], tools: [lookup] };

function validate(schema: Record<string, unknown>, value: unknown) {
  return new Ajv2020({ strict: false }).compile(schema)(value);
}

describe("QQ decision schema and consumer agreement", () => {
  test.each([
    { kind: "none" },
    { kind: "invoke", calls: [{ name: "fixture.read", arguments: { query: "x" } }] },
    { kind: "final", outputs: [{ kind: "inline", targetId: "reply", text: "ok" }] },
    { kind: "final", outputs: [{ kind: "generate", targetId: "reply", instructions: "answer" }] },
  ])("advertises the nested envelope accepted by the real parser: %j", (decision) => {
    const body = { decision, media: [{ mediaId: "image-1", category: "ordinary" }] };
    expect(validate(QQ_DECISION_ENVELOPE_SCHEMA, body)).toBe(true);
    expect(parseModelEnvelope(body, new Set(["image-1"])).decision).toEqual(
      AgentDecisionSchema.parse(decision),
    );
    expect(validate(QQ_DECISION_JSON_SCHEMA, decision)).toBe(true);
    expect(validate(QQ_DECISION_ENVELOPE_SCHEMA, { ...decision, media: [] })).toBe(false);
  });
  test.each([
    { decision: { kind: "none" }, extra: true },
    { decision: { kind: "none" }, media: [{ mediaId: "image-1", category: "invalid" }] },
    {
      decision: { kind: "none" },
      media: [{ mediaId: "image-1", category: "ordinary", extra: true }],
    },
    { decision: { kind: "invoke", calls: [] } },
    { decision: { kind: "final", outputs: [] } },
  ])("schema and parser reject invalid envelopes: %j", (body) => {
    expect(validate(QQ_DECISION_ENVELOPE_SCHEMA, body)).toBe(false);
    expect(() => parseModelEnvelope(body, new Set(["image-1"]))).toThrow();
  });
});

describe("score and text schema media match the strict consumer", () => {
  const mediaId = "image-1";
  const sent = new Set([mediaId]);
  test.each([
    { mediaId },
    { category: "ordinary" },
    { mediaId, category: "invalid" },
    { mediaId: "", category: "ordinary" },
    { mediaId, category: "ordinary", extra: true },
  ])("both schemas and consumers reject an invalid classification: %j", (item) => {
    const score = { scoreResult: { score: 5 }, media: [item] };
    const text = { text: "ok", media: [item] };
    expect(validate(QQ_SCORE_ENVELOPE_SCHEMA, score)).toBe(false);
    expect(validate(QQ_TEXT_ENVELOPE_SCHEMA, text)).toBe(false);
    expect(() => parseModelScoreEnvelope(score, sent)).toThrow();
    expect(() => parseModelTextEnvelope(text, sent)).toThrow();
  });
  test.each(["ordinary", "expression", "unknown"])(
    "both schemas accept %s and absence without inventing classification",
    (category) => {
      for (const media of [undefined, [], [{ mediaId, category }]]) {
        const score = { scoreResult: { score: 5 }, ...(media === undefined ? {} : { media }) };
        const text = { text: "ok", ...(media === undefined ? {} : { media }) };
        expect(validate(QQ_SCORE_ENVELOPE_SCHEMA, score)).toBe(true);
        expect(validate(QQ_TEXT_ENVELOPE_SCHEMA, text)).toBe(true);
        expect(parseModelScoreEnvelope(score, sent).media).toEqual(media ?? []);
        expect(parseModelTextEnvelope(text, sent).media).toEqual(media ?? []);
      }
    },
  );
});

describe("OpenAI function transport names", () => {
  test("sends only valid unique names, retains parameter schemas, and restores the advertised host action", async () => {
    const names: string[] = [];
    const tools = [
      lookup,
      { ...lookup, name: "fixture_read" },
      { ...lookup, name: "ss_action_0" },
      { ...lookup, name: "x".repeat(100) },
    ];
    const f = setup((body) => {
      const declarations = body.tools as FunctionTool[];
      names.push(...declarations.map((tool) => tool.function.name));
      if (names.some((name) => !/^[A-Za-z0-9_-]{1,64}$/.test(name)))
        return response("malformed_function_call");
      return response("tool_calls", names[0], '{"query":"x"}');
    });
    const result = JSON.parse(
      await f.gateway.complete({ ...request, tools, responseSchema: AGENT_DECISION_JSON_SCHEMA }),
    );
    expect(result).toEqual({
      kind: "invoke",
      calls: [{ name: lookup.name, arguments: { query: "x" } }],
    });
    expect(new Set(names).size).toBe(tools.length);
    expect(names[1]).toBe("fixture_read");
    expect(names[2]).toBe("ss_action_0");
    expect((f.sent[0]!.tools as FunctionTool[]).map((tool) => tool.function.parameters)).toEqual(
      tools.map((tool) => tool.parameters),
    );
    expect(f.sent).toHaveLength(1);
  });

  test("restores every member of a parallel batch without renaming arguments", async () => {
    const tools = [lookup, { ...lookup, name: "fixture.other" }];
    const f = setup((body) =>
      Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: (body.tools as FunctionTool[]).map((tool, index) => ({
                function: {
                  name: tool.function.name,
                  arguments: JSON.stringify({ query: tools[index]!.name }),
                },
              })),
            },
          },
        ],
      }),
    );
    const result = JSON.parse(await f.gateway.complete({ ...request, tools }));
    expect(result.calls).toEqual(
      tools.map((tool) => ({ name: tool.name, arguments: { query: tool.name } })),
    );
  });

  test("does not accept an unadvertised wire name", async () => {
    const f = setup(() => response("tool_calls", "unadvertised", '{"query":"x"}'));
    const result = await f.gateway.complete(request);
    expect(result).toBe("");
    expect(f.sent).toHaveLength(1);
  });

  test("keeps local JSON decision declarations unchanged and sends no native tools", async () => {
    const f = setup(() => response("stop", undefined, "{}", '{"kind":"none"}'), false);
    expect(
      await f.gateway.complete({ ...request, responseSchema: QQ_DECISION_ENVELOPE_SCHEMA }),
    ).toBe('{"kind":"none"}');
    expect(f.sent[0]!.tools).toBeUndefined();
    expect(
      (f.sent[0]!.response_format as { json_schema: { schema: unknown } }).json_schema.schema,
    ).toEqual(QQ_DECISION_ENVELOPE_SCHEMA);
  });
});

describe("native decisions retain envelope and finish semantics", () => {
  test("a native invoke reaches the nested envelope consumer with real classifications retained", async () => {
    const f = setup((body) =>
      response(
        "tool_calls",
        (body.tools as FunctionTool[])[0]!.function.name,
        '{"query":"x"}',
        JSON.stringify({ media: [{ mediaId: "image-1", category: "ordinary" }] }),
      ),
    );
    const raw = await f.gateway.complete({
      ...request,
      responseSchema: QQ_DECISION_ENVELOPE_SCHEMA,
    });
    const envelope = parseModelEnvelope(JSON.parse(raw), new Set(["image-1"]));
    expect(envelope).toEqual({
      decision: { kind: "invoke", calls: [{ name: lookup.name, arguments: { query: "x" } }] },
      media: [{ mediaId: "image-1", category: "ordinary" }],
    });
  });

  test("a bodyless native invoke does not fabricate a classification", async () => {
    const f = setup((body) =>
      response("tool_calls", (body.tools as FunctionTool[])[0]!.function.name, '{"query":"x"}'),
    );
    const raw = await f.gateway.complete({
      ...request,
      responseSchema: QQ_DECISION_ENVELOPE_SCHEMA,
    });
    expect(parseModelEnvelope(JSON.parse(raw), new Set(["image-1"])).media).toEqual([]);
  });

  test.each(["length", "content_filter", "malformed_function_call", "vendor_terminal"])(
    "refuses %s even when tool arguments are readable",
    async (finish) => {
      const f = setup((body) =>
        response(finish, (body.tools as FunctionTool[])[0]!.function.name, '{"query":"x"}'),
      );
      await expect(f.gateway.complete(request)).rejects.toMatchObject({
        code: finish === "length" ? "MODEL_OUTPUT_LIMIT" : "MODEL_FINISH_UNSUPPORTED",
      });
      expect(f.sent).toHaveLength(1);
    },
  );

  test.each(["not json", "[]", "null"])(
    "does not discard unreadable envelope content: %s",
    async (content) => {
      const f = setup((body) =>
        response(
          "tool_calls",
          (body.tools as FunctionTool[])[0]!.function.name,
          '{"query":"x"}',
          content,
        ),
      );
      const raw = await f.gateway.complete({
        ...request,
        responseSchema: QQ_DECISION_ENVELOPE_SCHEMA,
      });
      expect(() => parseModelEnvelope(JSON.parse(raw), new Set())).toThrow();
      expect(f.sent).toHaveLength(1);
    },
  );

  test("a tool_calls finish without actual calls remains a failed completion", async () => {
    const f = setup(() => response("tool_calls", undefined, "{}", '{"kind":"none"}'));
    await expect(f.gateway.complete(request)).rejects.toMatchObject({
      code: "MODEL_FINISH_UNSUPPORTED",
    });
  });

  test("the final wire budget includes the alias declaration and guide", async () => {
    let observed = "";
    const f = setup(() => response("stop", undefined, "{}", '{"kind":"none"}'));
    await expect(
      f.gateway.complete({
        ...request,
        contextBudget: {
          model: "fixture",
          capacity: 100,
          tokenizerEncoding: "cl100k_base",
          countText: (text) => {
            observed = text;
            return text.length;
          },
          assertCurrent() {},
        },
        contextInputLimit: 1,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_BUDGET_EXCEEDED" });
    const measured = JSON.parse(observed) as { tools: FunctionTool[] };
    expect(measured.tools[0]!.function.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(measured.tools[0]!.function.description).toContain(lookup.name);
    expect(f.sent).toHaveLength(0);
  });

  test("source revocation before send still refuses the request", async () => {
    const revoked = new Error("synthetic source revoked");
    const f = setup(() => response("stop", undefined, "{}", '{"kind":"none"}'));
    await expect(
      f.gateway.complete({
        ...request,
        assertPreparedCurrent: () => {
          throw revoked;
        },
      }),
    ).rejects.toBe(revoked);
    expect(f.sent).toHaveLength(0);
  });

  test("keeps forged classifications and extra fields visible to the strict consumer", async () => {
    const f = setup((body) =>
      response(
        "tool_calls",
        (body.tools as FunctionTool[])[0]!.function.name,
        '{"query":"x"}',
        JSON.stringify({ media: [{ mediaId: "forged", category: "ordinary" }], extra: true }),
      ),
    );
    const raw = await f.gateway.complete({
      ...request,
      responseSchema: QQ_DECISION_ENVELOPE_SCHEMA,
    });
    expect(() => parseModelEnvelope(JSON.parse(raw), new Set(["image-1"]))).toThrow();
  });
});

test("runtime native action then terminal output uses canonical names and does not replay actions", async () => {
  let executed = 0;
  let sends = 0;
  const action: BuiltInAction = {
    description: { ...lookup, capability: "fixture", effect: "read" },
    execute: async () => {
      executed += 1;
      return { value: "value", sources: [] };
    },
  };
  const f = setup((body) => {
    const tool = (body.tools as FunctionTool[])[0]!;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.function.name))
      return response("malformed_function_call");
    if (++sends === 1) return response("tool_calls", tool.function.name, '{"query":"x"}');
    return response(
      "stop",
      undefined,
      "{}",
      JSON.stringify({
        decision: { kind: "final", outputs: [{ kind: "inline", targetId: "reply", text: "done" }] },
        media: [],
      }),
    );
  });
  const h = openBusinessDb();
  cleanups.push(() => h.close());
  const runtime = new AgentRuntime({
    repository: new AgentRunRepository(h.db),
    model: createModelPort({ gateway: f.gateway }),
    actions: [action],
  });
  const usage = { calls: 0, inputUnits: 0 };
  const result = await runtime.run(
    {
      id: "native-root",
      model: "fixture",
      context: "conversation",
      availableActions: [action.description],
      limits: { steps: 4 },
    },
    {
      owner: { kind: "test", id: "native-root", userId: "u" },
      authorizedTargets: ["reply"],
      outputMode: "buffered",
      usage,
      context: { read: async () => ({ pending: [textMessage("user", "synthetic input")] }) },
      decisionEnvelope: () => ({
        responseSchema: QQ_DECISION_ENVELOPE_SCHEMA,
        parse: (raw) => parseModelEnvelope(JSON.parse(raw), new Set()).decision,
      }),
    },
  );
  expect(result.status).toBe("completed");
  expect(executed).toBe(1);
  expect(usage.calls).toBe(2);
  expect(f.sent).toHaveLength(2);
  expect(result.outputs[0]?.text).toBe("done");
});
