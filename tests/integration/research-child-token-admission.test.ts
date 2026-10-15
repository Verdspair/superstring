import { afterEach, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { measureContextTokens, textMessage } from "../../src/server/agent/context-engine";
import type { ModelRequest } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { loadTextTokenCounter } from "../../src/server/llm/text-token-counter";
import { AGENT_DECISION_JSON_SCHEMA } from "../../src/shared/contracts/agent-output";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});
for (const encoding of ["cl100k_base", "o200k_base"] as const) {
  it(`fits concurrent research observations with the actual ${encoding} counter`, async () => {
    const counter = await loadTextTokenCounter(encoding);
    const h = openBusinessDb();
    handles.push(h);
    const requests: ModelRequest[] = [];
    const fullText = "中".repeat(4000);
    const ref = { kind: "test_source", id: "authorized", revision: "one" };
    const action: BuiltInAction = {
      description: {
        name: "web.fixture",
        description: "read an isolated page",
        capability: "web",
        effect: "read",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
      async execute() {
        return { value: { status: "ok", text: fullText }, sources: [ref] };
      },
      fitResult(value, sources, arguments_, context) {
        if (!context.fitReadResult) throw new Error("missing child admission");
        return context.fitReadResult("web.fixture", arguments_, value, sources);
      },
    };
    let parentRounds = 0;
    let childRounds = 0;
    let publications = 0;
    const runtime = new AgentRuntime({
      repository: new AgentRunRepository(h.db),
      researchEnabled: () => true,
      model: {
        async complete(request) {
          requests.push(request);
          if (JSON.stringify(request.messages[0]).includes("Research only the supplied question")) {
            if (++childRounds === 1)
              return JSON.stringify({
                kind: "invoke",
                calls: [
                  { name: "web.fixture", arguments: { query: "first full query" } },
                  { name: "web.fixture", arguments: { query: "second full query" } },
                ],
              });
            return JSON.stringify({
              kind: "final",
              outputs: [
                { kind: "generate", targetId: "research", instructions: "summarize facts" },
              ],
            });
          }
          return ++parentRounds === 1
            ? JSON.stringify({
                kind: "invoke",
                calls: [{ name: "research.run", arguments: { question: "short question" } }],
              })
            : '{"kind":"none"}';
        },
        async *streamText() {
          yield "bounded conclusion";
        },
        async completeMultimodal() {
          return "unused";
        },
      },
    });
    const spec: AgentSpec = {
      id: "parent-token",
      model: "fixture",
      context: "conversation",
      availableActions: [action.description],
      limits: { steps: 8, inputUnits: 8192 },
    };
    const descriptor = {
      model: "fixture",
      capacity: 131072,
      tokenizerEncoding: encoding,
      countText: counter.count,
      assertCurrent() {},
    };
    const result = await runtime.run(spec, {
      owner: { kind: "test", id: encoding },
      authorizedTargets: ["reply"],
      outputMode: "buffered",
      actions: [action],
      context: {
        prepareModelContext: async () => descriptor,
        read: async () => ({ pending: [textMessage("user", "parent input")] }),
        assertSources(sources) {
          expect(
            sources.every(
              (source) =>
                source.kind === ref.kind &&
                source.id === ref.id &&
                source.revision === ref.revision,
            ),
          ).toBe(true);
        },
      },
      async commitOutputs(outputs) {
        publications += outputs.length;
      },
    });
    expect(result.status).toBe("no_output");
    expect(parentRounds).toBe(2);
    expect(childRounds).toBe(2);
    expect(publications).toBe(0);
    const child = requests.filter((request) =>
      JSON.stringify(request.messages[0]).includes("Research only the supplied question"),
    );
    expect(child).toHaveLength(2);
    for (const request of child) {
      expect(request.contextBudget?.tokenizerEncoding).toBe(encoding);
      const tokens = measureContextTokens(request.messages, counter, {
        responseSchema: request.responseSchema ?? AGENT_DECISION_JSON_SCHEMA,
        tools: request.tools,
      }).textTokens;
      expect(tokens).toBeLessThanOrEqual(8192);
    }
    const observations = child[1]!.messages
      .flatMap((message) => message.content)
      .filter((part) => part.kind === "text")
      .flatMap((part) => {
        try {
          const envelope = JSON.parse(part.text);
          return envelope.kind === "action_observation" ? [envelope.value] : [];
        } catch {
          return [];
        }
      });
    expect(observations).toHaveLength(2);
    expect(observations.map((observation) => observation.arguments.query)).toEqual([
      "first full query",
      "second full query",
    ]);
    expect(
      observations.every(
        (observation) => JSON.stringify(observation.sources) === JSON.stringify([ref]),
      ),
    ).toBe(true);
    expect(observations.filter((observation) => observation.value.status === "ok")).toHaveLength(1);
    expect(observations.find((observation) => observation.value.status === "ok").value.text).toBe(
      fullText,
    );
    expect(
      observations.find((observation) => observation.value.status === "unavailable").value,
    ).toEqual({ status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED" });
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain(fullText);
  });
}

for (const boundary of ["cancel", "revoke"] as const) {
  it(`does not admit a late research read after ${boundary}`, async () => {
    const counter = await loadTextTokenCounter("o200k_base");
    const h = openBusinessDb();
    handles.push(h);
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abort = new AbortController();
    const reason = Object.assign(new Error("original caller cancelled"), {
      code: "CALLER_CANCELLED",
    });
    let revoked = false;
    let parentCalls = 0;
    let childCalls = 0;
    let admitted = 0;
    let generations = 0;
    const ref = { kind: "test_source", id: "authorized", revision: "one" };
    const check = () => {
      if (revoked)
        throw Object.assign(new Error("source revoked"), { code: "CONTEXT_SOURCE_INVALID" });
    };
    const action: BuiltInAction = {
      description: {
        name: "web.late",
        capability: "web",
        description: "delayed read",
        effect: "read",
        parameters: { type: "object", properties: {} },
      },
      async execute() {
        entered();
        await gate;
        return { value: { status: "ok", text: "late data" }, sources: [ref] };
      },
      fitResult(value, sources, arguments_, context) {
        if (!context.fitReadResult) throw new Error("missing executing child admission");
        const result = context.fitReadResult("web.late", arguments_, value, sources);
        admitted++;
        return result;
      },
    };
    const runtime = new AgentRuntime({
      repository: new AgentRunRepository(h.db),
      researchEnabled: () => true,
      model: {
        async complete(request) {
          if (JSON.stringify(request.messages[0]).includes("Research only the supplied question")) {
            childCalls++;
            return JSON.stringify({ kind: "invoke", calls: [{ name: "web.late", arguments: {} }] });
          }
          parentCalls++;
          return JSON.stringify({
            kind: "invoke",
            calls: [{ name: "research.run", arguments: { question: "question" } }],
          });
        },
        async *streamText() {
          generations++;
          yield "unexpected generation";
        },
        async completeMultimodal() {
          return "unused";
        },
      },
    });
    const running = runtime
      .run(
        {
          id: "late-child",
          context: "conversation",
          model: "fixture",
          availableActions: [action.description],
          limits: { steps: 4, inputUnits: 8192 },
        },
        {
          owner: { kind: "test", id: boundary },
          authorizedTargets: ["reply"],
          outputMode: "buffered",
          signal: abort.signal,
          actions: [action],
          context: {
            assertCurrent: check,
            assertSources: check,
            prepareModelContext: async () => ({
              model: "fixture",
              capacity: 131072,
              tokenizerEncoding: "o200k_base",
              countText: counter.count,
              assertCurrent: check,
            }),
            read: async () => ({ pending: [textMessage("user", "parent question")] }),
          },
        },
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await ready;
    if (boundary === "cancel") abort.abort(reason);
    else revoked = true;
    release();
    const result = await running;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("late read unexpectedly admitted");
    if (boundary === "cancel") expect(result.error).toBe(reason);
    else expect(result.error).toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(parentCalls).toBe(1);
    expect(childCalls).toBe(1);
    expect(admitted).toBe(0);
    expect(generations).toBe(0);
  });
}
