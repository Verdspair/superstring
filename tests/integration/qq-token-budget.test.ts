import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import {
  ContextEngine,
  inputUnits,
  measureContextTokens,
} from "../../src/server/agent/context-engine";
import type { ModelContextBudget } from "../../src/server/agent/model-port";
import { ReservationLedger } from "../../src/server/agent/reservation-ledger";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, getAgentRow } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  loadTextTokenCounter,
  type TextTokenEncoding,
} from "../../src/server/llm/text-token-counter";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import { QQ_CONTEXT_DEFAULT } from "../../src/server/services/qq-context-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const readInput = () => ({ signal: new AbortController().signal, observations: [] });
async function fixture(
  encodings: { judge?: TextTokenEncoding; reply?: TextTokenEncoding },
  options: { capacity?: number; window?: number; legacy?: boolean } = {},
) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  const seconds = Math.floor(Date.now() / 1000),
    now = new Date(seconds * 1000).toISOString();
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "context",
    context: {
      ...QQ_CONTEXT_DEFAULT,
      reply_token_budget: options.window ?? 16384,
      judgement_token_budget: options.window ?? 16384,
    },
  });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("binding");
  const binding = insertQqBinding(h.orm, created.binding),
    capture = captureQqTask(binding, "reply");
  if (capture.kind !== "captured") throw new Error("snapshot");
  const row = getAgentRow(h.orm, DEFAULT_AGENT_ID);
  if (!row) throw new Error("agent");
  const runtime = runtimeFromAgent(row);
  runtime.p5_config.retrieval_mode = "off";
  runtime.p5_config.compression_enabled = false;
  if (options.legacy) delete runtime.resolved_model_contexts;
  else runtime.resolved_model_contexts = {};
  const journal = new ConversationEventRepository(h.db),
    outbox = new OutboundIntentRepository(h.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation");
  const capacity = options.capacity ?? 65536;
  let countOverride: ((text: string) => number) | undefined;
  const budgets = new Map<string, ModelContextBudget>();
  for (const [model, encoding] of [
    ["judge-model", encodings.judge],
    ["reply-model", encodings.reply],
  ] as const) {
    const counter = encoding ? await loadTextTokenCounter(encoding) : undefined;
    budgets.set(model, {
      model,
      capacity,
      ...(counter
        ? {
            tokenizerEncoding: counter.encoding,
            countText: (text: string) => countOverride?.(text) ?? counter.count(text),
          }
        : {}),
      assertCurrent() {},
    });
  }
  const probes: string[] = [],
    prepares: string[] = [];
  const gateway = {
    loadedContextCapacity: async (model: string) => {
      probes.push(model);
      return capacity;
    },
    prepareContextModel: async (model: string) => {
      prepares.push(model);
      const result = budgets.get(model);
      if (!result) throw new Error("model");
      return result;
    },
    complete: async () => "unused",
  };
  const agentRuntime = createAgentRuntime({ gateway, repository: new AgentRunRepository(h.db) });
  const spec: AgentSpec = {
    id: "test.bot",
    model: "judge-model",
    context: "conversation",
    instructions: "synthetic context",
    availableActions: [],
    limits: { steps: 16 },
  };
  const source = new BotContextSource({
    ...h,
    gateway,
    agentRuntime,
    journal,
    outbox,
    conversationId: conversation.id,
    binding,
    snapshot: capture.snapshot,
    scheme,
    runtime,
    spec,
    path: "direct_reply",
    decisionTier: "judgement",
    targets: () => [{ id: "alice", speakerId: "20002" }],
    assertCurrent() {},
    now: () => now,
  });
  const seed = (text: string, age = 0) => {
    const id = crypto.randomUUID();
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey: id,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        messageId: id,
        occurredAtSeconds: seconds - age,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: now,
      })
      .run();
    h.orm
      .insert(schema.qqObservationText)
      .values({
        eventKey: id,
        body: text,
        occurredAtSeconds: seconds - age,
        expiresAt: new Date((seconds + 3600) * 1000).toISOString(),
        recordedAt: now,
      })
      .run();
    journal.ingestOneBotEvent(id, binding.id);
    return id;
  };
  return {
    source,
    spec,
    runtime,
    budgets,
    prepares,
    probes,
    seed,
    setCountOverride: (count: (text: string) => number) => {
      countOverride = count;
    },
  };
}

describe("QQ model-token capacity with independent byte controls", () => {
  it("admits Chinese within model-token capacity without converting the configured window", async () => {
    const h = await fixture({ judge: "cl100k_base", reply: "cl100k_base" }, { capacity: 32768 });
    const body = "中".repeat(12000);
    h.seed(body);
    const material = await h.source.read(readInput());
    const rendered = new ContextEngine().render(h.spec, material, [], ["alice"]);
    const evaluated = await h.source.prepareEvaluation({
      signal: readInput().signal,
      target: null,
    });
    expect(inputUnits(rendered.messages)).toBeGreaterThan(evaluated.contextInputLimit!);
    expect(evaluated.contextBudget?.tokenizerEncoding).toBe("cl100k_base");
    expect(h.source.measurePhaseInput("evaluation", evaluated.messages)).toBeLessThan(
      evaluated.contextInputLimit!,
    );
    expect(
      rendered.messages
        .flatMap((m) => m.content.flatMap((p) => (p.kind === "text" ? [p.text] : [])))
        .join(""),
    ).toContain(body);
    expect(h.probes).toEqual([]);
    expect(h.prepares).toEqual(["judge-model"]);
    await h.source.prepareModelContext!("judge-model", readInput().signal);
    expect(h.prepares).toEqual(["judge-model"]);
  });
  it("still crops old messages by the original configured byte window", async () => {
    const h = await fixture({ judge: "o200k_base", reply: "o200k_base" }, { window: 1024 });
    h.seed("old-marker:" + "中".repeat(500), 1);
    h.seed("new-marker:" + "中".repeat(500));
    const material = await h.source.read(readInput());
    const text = new ContextEngine()
      .render(h.spec, material, [], ["alice"])
      .messages.flatMap((m) => m.content.flatMap((p) => (p.kind === "text" ? [p.text] : [])))
      .join("");
    expect(text).toContain("new-marker:");
    expect(text).not.toContain("old-marker:");
  });
  for (const encodings of [
    { judge: "cl100k_base", reply: "cl100k_base" },
    { judge: "cl100k_base", reply: "o200k_base" },
    { judge: "cl100k_base" },
    { reply: "o200k_base" },
  ] as const) {
    it(`keeps atomic reservations for ${JSON.stringify(encodings)}`, async () => {
      const h = await fixture(encodings);
      h.seed("question");
      const first = await h.source.actionResultFitter(
        "web.fetch",
        { url: "https://public.example/a" },
        readInput().signal,
        true,
      );
      const sibling = await h.source.actionResultFitter(
        "web.fetch",
        { url: "https://public.example/b" },
        readInput().signal,
        true,
      );
      expect(first({ status: "ok", text: "中".repeat(1000) }, [])).toBe(true);
      expect(sibling({ status: "ok", text: "small" }, [])).toBe(true);
      expect(first({ status: "ok", text: "中".repeat(100000) }, [])).toBe(false);
      expect(h.source.isTerminalDecision()).toBe(false);
      expect(sibling({ status: "ok", text: "small" }, [])).toBe(true);
      expect(h.prepares.sort()).toEqual(["judge-model", "reply-model"]);
      const reply = await h.source.prepareGeneration(
        { kind: "generate", targetId: "alice", instructions: "" },
        {
          context: new ContextEngine().render(h.spec, {}, [], ["alice"]),
          outputId: "output",
          signal: readInput().signal,
        },
      );
      expect(reply.model).toBe("reply-model");
    });
  }
  it("does not prepare a counter or add a capacity probe to an old runtime", async () => {
    const h = await fixture({ judge: "cl100k_base", reply: "o200k_base" }, { legacy: true });
    h.seed("question");
    expect(h.source.prepareModelContext).toBeUndefined();
    const evaluation = await h.source.prepareEvaluation({
      signal: readInput().signal,
      target: null,
    });
    expect(evaluation.contextBudget).toBeUndefined();
    expect(h.prepares).toEqual([]);
    expect(h.probes).toEqual(["judge-model"]);
    expect(h.runtime.resolved_model_contexts).toBeUndefined();
  });
  it("rejects stale frozen metadata and cancelled preparation before material use", async () => {
    const h = await fixture({ judge: "cl100k_base" });
    h.runtime.resolved_model_contexts = { "judge-model": { model: "judge-model", capacity: 1 } };
    await expect(
      h.source.prepareModelContext!("judge-model", readInput().signal),
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(h.source.prepareModelContext!("judge-model", controller.signal)).rejects.toThrow(
      "cancelled",
    );
  });
  it("counts complete schema requests using the real local encoding", async () => {
    const counter = await loadTextTokenCounter("cl100k_base");
    const messages = [
      { role: "user" as const, content: [{ kind: "text" as const, text: "中".repeat(20) }] },
    ];
    const options = {
      responseSchema: { type: "object", properties: { text: { type: "string" } } },
    };
    const plain = measureContextTokens(messages, counter),
      schema = measureContextTokens(messages, counter, options);
    expect(schema.textTokens).toBeGreaterThan(plain.textTokens);
    expect(schema.mediaState).toBe("none");
  });
});

describe("shared reservation ledger counting modes", () => {
  it("preserves default byte calls, separates groups, excludes self and clears both", () => {
    const ledger = new ReservationLedger(),
      a = Symbol(),
      b = Symbol();
    ledger.set(a, 20);
    ledger.set(a, 2, "tokens");
    ledger.set(b, 40);
    ledger.set(b, 7, "tokens");
    expect(ledger.reserved()).toBe(60);
    expect(ledger.reserved(undefined, "tokens")).toBe(9);
    expect(ledger.reserved(a)).toBe(40);
    expect(ledger.reserved(a, "tokens")).toBe(7);
    ledger.set(a, 3, "tokens");
    expect(ledger.reserved()).toBe(60);
    ledger.clear();
    expect(ledger.reserved()).toBe(0);
    expect(ledger.reserved(undefined, "tokens")).toBe(0);
  });
});

describe("QQ rejected observation pricing", () => {
  it("does not price an unchanged baseline after the candidate already fails", async () => {
    const h = await fixture({ judge: "cl100k_base", reply: "cl100k_base" });
    h.seed("question");
    const fit = await h.source.actionResultFitter("web.fetch", {}, readInput().signal);
    let baselineCalls = 0;
    h.setCountOverride((text) => {
      if (!text.includes("rejected-candidate-marker")) baselineCalls++;
      return 65536;
    });
    expect(fit({ status: "ok", text: "rejected-candidate-marker" }, [])).toBe(false);
    expect(baselineCalls).toBe(0);
    expect(h.source.isTerminalDecision()).toBe(false);
  });
});
