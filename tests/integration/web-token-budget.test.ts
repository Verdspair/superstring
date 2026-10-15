// Real Web token-budget integration: the public ContextBuilder and
// WebContextSource price one synthetic turn with a real gpt-tokenizer counter
// loaded through loadTextTokenCounter. No live model call and no network: the
// fake gateway answers capacity and prepare locally and records every request
// it is asked to price. The database is the same synthetic one the other
// integration tests create per process; no real user data is read.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { AgentRuntime, createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { ContextEngine, measureContextTokens } from "../../src/server/agent/context-engine";
import { ContextBuilder } from "../../src/server/agent/conversation-context";
import type { ModelContextBudget } from "../../src/server/agent/model-port";
import { WebContextSource } from "../../src/server/channels/web-context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  createSession,
  ensureDefaults,
  getTurnByRequest,
  type Orm,
  prepareTurn,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import {
  loadTextTokenCounter,
  type TextTokenCounter,
} from "../../src/server/llm/text-token-counter";
import {
  type ResolvedModelContext,
  ResolvedModelContextSchema,
  type RuntimeConfig,
} from "../../src/shared/contracts/agent";
import { ContextUsageSchema } from "../../src/shared/contracts/context-usage";

const MODEL = "qwen/qwen3-4b-2507";
const CAPACITY = 8192;
const OUTPUT_TOKENS = 512;
const SAFETY_RATIO = 0.1;
/** capacity - output_reserved - ceil(capacity * safety_margin_ratio) = 6860. */
const INPUT_LIMIT = CAPACITY - OUTPUT_TOKENS - Math.ceil(CAPACITY * SAFETY_RATIO);

const READING: ResolvedModelContext = {
  model: MODEL,
  capacity: CAPACITY,
  tokenizer_encoding: "o200k_base",
  route_revision: 3,
};

function staleRoute(): Error {
  return new Error("route is no longer current");
}

class TokenGateway implements ModelGateway {
  readonly config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  readonly completeCalls: unknown[] = [];
  readonly streamCalls: unknown[] = [];
  readonly capacityCalls: unknown[] = [];
  readonly prepareCalls: string[] = [];
  readonly counted: string[] = [];
  capacity: number | null = CAPACITY;
  declareEncoding = true;
  declareCounter = true;
  stale = false;
  /** Throws once this many whole requests have been priced (0 = from the start). */
  staleAfterCounted = 0;
  counter?: TextTokenCounter;

  private readonly countText = (text: string): number => {
    this.counted.push(text);
    if (!this.counter) throw new Error("counter is not loaded");
    return this.counter.count(text);
  };

  async listModels(): Promise<string[]> {
    return [MODEL];
  }

  async loadedContextCapacity(): Promise<number | null> {
    this.capacityCalls.push("probe");
    return this.capacity;
  }

  async probeModelLoaded(): Promise<boolean> {
    return true;
  }

  async complete(call: Parameters<ModelGateway["complete"]>[0]): Promise<string> {
    this.completeCalls.push(call);
    return JSON.stringify({ kind: "final", outputs: [] });
  }

  async *streamChat(call: Parameters<ModelGateway["streamChat"]>[0]): AsyncGenerator<string> {
    this.streamCalls.push(call);
    yield "unused";
  }

  prepareContextModel = async (
    model: string,
    options?: { signal?: AbortSignal },
  ): Promise<ModelContextBudget> => {
    this.prepareCalls.push(model);
    options?.signal?.throwIfAborted();
    return {
      model: MODEL,
      capacity: this.capacity,
      ...(this.declareEncoding ? { tokenizerEncoding: "o200k_base" as const } : {}),
      ...(this.declareCounter ? { countText: this.countText } : {}),
      routeRevision: 3,
      assertCurrent: () => {
        const staleByCount =
          this.staleAfterCounted > 0 && this.counted.length >= this.staleAfterCounted;
        if (this.stale || staleByCount) throw staleRoute();
      },
    };
  };
}

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  return { business, orm: business.orm, gateway: new TokenGateway() };
}

type Setup = ReturnType<typeof setup>;

function activeQuestion(ctx: Setup, key: string, question: string) {
  const sessionId = createSession(ctx.orm, "会话", { modelName: MODEL }).id;
  const prepared = prepareTurn(ctx.orm, sessionId, question, key);
  if (prepared.generationToken === null) throw new Error("fresh token expected");
  const turn = getTurnByRequest(ctx.orm, sessionId, key);
  if (!turn) throw new Error("turn missing");
  return {
    sessionId,
    turnId: turn.id,
    generationToken: prepared.generationToken,
    runtime: prepared.runtime,
  };
}

/** Same turn snapshot, token mode switched on: declared encoding, capacity and ratio. */
function tokenRuntime(base: RuntimeConfig): RuntimeConfig {
  return {
    ...base,
    p5_config: {
      ...base.p5_config,
      context_window: CAPACITY,
      max_output_tokens: OUTPUT_TOKENS,
      safety_margin_ratio: SAFETY_RATIO,
      compression_enabled: false,
      retrieval_mode: "off",
    },
    resolved_model_contexts: { [MODEL]: READING },
  };
}

function legacyRuntime(base: RuntimeConfig): RuntimeConfig {
  const { resolved_model_contexts: _absent, ...rest } = tokenRuntime(base);
  return rest;
}

function source(ctx: Setup, turn: ReturnType<typeof activeQuestion>, runtime: RuntimeConfig) {
  return new WebContextSource({
    db: ctx.business.db,
    orm: ctx.orm,
    gateway: ctx.gateway,
    agentRuntime: createAgentRuntime({
      gateway: ctx.gateway,
      repository: new AgentRunRepository(ctx.business.db),
    }),
    builder: new ContextBuilder({ orm: ctx.orm, db: ctx.business.db, gateway: ctx.gateway }),
    runtime,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    generationToken: turn.generationToken,
    maxSteps: 6,
  });
}

function snapshotOf(orm: Orm, turnId: string): Record<string, unknown> {
  const turn = orm.select().from(schema.turns).where(eq(schema.turns.id, turnId)).get();
  if (!turn) throw new Error("turn missing");
  return JSON.parse(turn.runtimeConfigSnapshot) as Record<string, unknown>;
}

function replaceSnapshot(orm: Orm, turnId: string, value: Record<string, unknown>): void {
  orm
    .update(schema.turns)
    .set({ runtimeConfigSnapshot: JSON.stringify(value) })
    .where(eq(schema.turns.id, turnId))
    .run();
}

/** Serialized requests that carry the decision schema and the advertised actions. */
function decisionTexts(counted: readonly string[]): string[] {
  return counted.filter((text) => {
    const value = JSON.parse(text) as Record<string, unknown>;
    const format = value.response_format as { json_schema?: unknown } | undefined;
    return format?.json_schema !== undefined && Array.isArray(value.tools);
  });
}

/**
 * A Chinese request with a long order-id list: its UTF-8 size is above the byte
 * ceiling, while the declared tokenizer prices it inside the token limit.
 */
function orderQuestion(): string {
  return "请核对账单金额并保留来源。".repeat(220);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe("Web token budget on the real builder and source", () => {
  it("reports the generation measurement rather than pricing another decision envelope", async () => {
    const ctx = setup();
    try {
      ctx.gateway.counter = await loadTextTokenCounter("o200k_base");
      const turn = activeQuestion(ctx, "generation-usage", "请检查生成阶段用量。");
      const web = source(ctx, turn, tokenRuntime(turn.runtime));
      const material = await web.read({ signal: new AbortController().signal, observations: [] });
      const engine = new ContextEngine();
      const rendered = engine.render(web.spec, material, [], ["reply"], "stream");
      const messages = engine.renderOutput(web.spec, rendered, {
        kind: "generate",
        targetId: "reply",
        instructions: "简短回答。",
      });
      const measure = measureContextTokens(messages, ctx.gateway.counter);
      const usage = web.contextUsage({ ...rendered, messages, tokenMeasure: measure });
      expect(usage?.model_tokens?.input_tokens).toBe(measure.textTokens);
      expect(usage?.model_tokens?.media_state).toBe(measure.mediaState);
    } finally {
      ctx.business.close();
    }
  });

  it("carries a measured Web context through Runtime without applying the byte capacity gate again", async () => {
    const ctx = setup();
    try {
      ctx.gateway.counter = await loadTextTokenCounter("o200k_base");
      const question = orderQuestion();
      const turn = activeQuestion(ctx, "runtime-token-integration", question);
      const web = source(ctx, turn, tokenRuntime(turn.runtime));
      const sent: import("../../src/server/agent/model-port").ModelRequest[] = [];
      const model: import("../../src/server/agent/model-port").ModelPort = {
        defaultModel: MODEL,
        complete: async (request) => {
          sent.push(request);
          return '{"kind":"none"}';
        },
        async *streamText() {
          yield "unused";
        },
        completeMultimodal: async () => "unused",
      };
      const repository = new AgentRunRepository(ctx.business.db);
      const runtime = new AgentRuntime({ model, repository });
      const usage = { calls: 0, inputUnits: 0 };
      const result = await runtime.run(web.spec, {
        owner: { kind: "web_turn", id: turn.turnId },
        context: web,
        actions: web.actions,
        authorizedTargets: ["reply"],
        outputMode: "buffered",
        usage,
      });
      expect(result.status).toBe("no_output");
      expect(sent).toHaveLength(1);
      expect(sent[0].contextBudget?.model).toBe(MODEL);
      expect(sent[0].contextInputLimit).toBe(INPUT_LIMIT);
      expect(JSON.stringify(sent[0].messages)).toContain(question);
      expect(usage.inputUnits).toBeGreaterThan(INPUT_LIMIT);
      expect(usage.calls).toBe(1);
      expect(ctx.gateway.prepareCalls).toHaveLength(1);
    } finally {
      ctx.business.close();
    }
  });

  it("honours the configured context ceiling below provider capacity", async () => {
    const ctx = setup();
    try {
      ctx.gateway.counter = await loadTextTokenCounter("o200k_base");
      const turn = activeQuestion(ctx, "manual-ceiling", "请检查上下文限制。");
      const runtime = tokenRuntime(turn.runtime);
      runtime.p5_config.context_window = 6144;
      const web = source(ctx, turn, runtime);
      const material = await web.read({ signal: new AbortController().signal, observations: [] });
      const usage = web.contextUsage(
        new ContextEngine().render(web.spec, material, [], ["reply"], "stream"),
      );
      expect(usage?.model_tokens?.input_limit).toBe(
        6144 - OUTPUT_TOKENS - Math.ceil(6144 * SAFETY_RATIO),
      );
      expect(ctx.gateway.prepareCalls).toHaveLength(1);
      await expect(
        web.prepareModelContext("different/model", new AbortController().signal),
      ).rejects.toThrow("different requested model");
      expect(ctx.gateway.prepareCalls).toHaveLength(1);
    } finally {
      ctx.business.close();
    }
  });

  it("keeps a Chinese question the byte unit rejects and reports the whole priced request", async () => {
    const ctx = setup();
    try {
      const counter = await loadTextTokenCounter("o200k_base");
      ctx.gateway.counter = counter;
      const question = orderQuestion();
      const turn = activeQuestion(ctx, "token-mode", question);
      const web = source(ctx, turn, tokenRuntime(turn.runtime));
      const material = await web.read({ signal: new AbortController().signal, observations: [] });
      // The whole question survives the read; nothing was trimmed to fit a byte ceiling.
      expect(material.pending ?? []).toHaveLength(1);
      expect(JSON.stringify(material.pending)).toContain(question);
      const usage = ContextUsageSchema.parse(
        web.contextUsage(new ContextEngine().render(web.spec, material, [], ["reply"], "stream")),
      );
      // One prepared descriptor per turn, and only primitives frozen in the snapshot.
      expect(ctx.gateway.prepareCalls).toEqual([MODEL]);
      expect(snapshotOf(ctx.orm, turn.turnId).resolved_model_contexts).toEqual({
        [MODEL]: READING,
      });
      expect(snapshotOf(ctx.orm, turn.turnId).resolved_model_capacities).toEqual({
        [MODEL]: CAPACITY,
      });
      // Token mode never probes the legacy capacity path and never sends a model call.
      expect(ctx.gateway.capacityCalls).toHaveLength(0);
      expect(ctx.gateway.completeCalls).toHaveLength(0);
      expect(ctx.gateway.streamCalls).toHaveLength(0);
      expect(usage.capacity).toBe(CAPACITY);
      expect(usage.output_reserved).toBe(OUTPUT_TOKENS);
      expect(usage.model_tokens?.encoding).toBe("o200k_base");
      expect(usage.model_tokens?.input_limit).toBe(INPUT_LIMIT);
      expect(usage.model_tokens?.input_tokens).toBeGreaterThan(0);
      expect(usage.model_tokens?.input_tokens).toBeLessThanOrEqual(INPUT_LIMIT);
      // Same input, other unit: this very question is above the byte ceiling,
      // while the declared tokenizer prices the whole rendered request inside it.
      expect(utf8Bytes(question)).toBeGreaterThan(INPUT_LIMIT);
      expect(usage.input_limit).toBe(INPUT_LIMIT);
      expect(usage.input_units).toBeGreaterThan(INPUT_LIMIT);
      expect(usage.estimator).toBe("utf8_bytes_plus_message_overhead");
      // Every real priced request carried the complete question, and the decision
      // requests carried this turn's advertised actions plus the declared schema.
      expect(ctx.gateway.counted.length).toBeGreaterThan(0);
      expect(ctx.gateway.counted.every((text) => text.includes(question))).toBe(true);
      const texts = decisionTexts(ctx.gateway.counted);
      expect(texts.length).toBeGreaterThan(0);
      const request = JSON.parse(texts[0]) as {
        tools: { function: { name: string } }[];
        response_format: { json_schema: { schema: unknown } };
      };
      expect(request.tools.map((tool) => tool.function.name)).toEqual(
        web.spec.availableActions.map((action) => action.name),
      );
      expect(request.response_format.json_schema.schema).toBeDefined();
      expect(counter.count(texts[0])).toBeGreaterThan(0);
      expect(counter.encoding).toBe("o200k_base");
    } finally {
      ctx.business.close();
    }
  });

  it("keeps the legacy byte unit and prepares nothing when the snapshot has no reading", async () => {
    const ctx = setup();
    try {
      const counter = await loadTextTokenCounter("o200k_base");
      ctx.gateway.counter = counter;
      const question = "验证旧快照保持原字节计量。";
      const turn = activeQuestion(ctx, "legacy-unit", question);
      ctx.gateway.capacity = 32768;
      const runtime = legacyRuntime(turn.runtime);
      runtime.p5_config.context_window = 32768;
      replaceSnapshot(ctx.orm, turn.turnId, runtime as unknown as Record<string, unknown>);
      const web = source(ctx, turn, runtime);
      const material = await web.read({ signal: new AbortController().signal, observations: [] });
      const usage = web.contextUsage(
        new ContextEngine().render(web.spec, material, [], ["reply"], "stream"),
      );
      expect(ctx.gateway.prepareCalls).toHaveLength(0);
      expect(ctx.gateway.counted).toHaveLength(0);
      // Legacy mode still probes the loaded capacity once and reads the whole question.
      expect(ctx.gateway.capacityCalls.length).toBeGreaterThan(0);
      expect(ctx.gateway.completeCalls).toHaveLength(0);
      expect(JSON.stringify(material.pending)).toContain(question);
      expect(usage?.model_tokens).toBeUndefined();
      expect(usage?.input_units).toBeGreaterThan(0);
      // The reading stays absent; only the legacy capacity entry exists for it.
      expect(snapshotOf(ctx.orm, turn.turnId).resolved_model_contexts).toBeUndefined();
    } finally {
      ctx.business.close();
    }
  });

  it("never calls the counter when the route declares no encoding or no counter", async () => {
    for (const variant of ["encoding", "counter"]) {
      const ctx = setup();
      try {
        const counter = await loadTextTokenCounter("o200k_base");
        ctx.gateway.counter = counter;
        if (variant === "encoding") ctx.gateway.declareEncoding = false;
        else ctx.gateway.declareCounter = false;
        const question = "验证未声明编码时不调用计数器。";
        const turn = activeQuestion(ctx, `no-${variant}`, question);
        ctx.gateway.capacity = 32768;
        const runtime = tokenRuntime(turn.runtime);
        runtime.p5_config.context_window = 32768;
        runtime.resolved_model_contexts = {};
        replaceSnapshot(ctx.orm, turn.turnId, runtime as unknown as Record<string, unknown>);
        const web = source(ctx, turn, runtime);
        const material = await web.read({ signal: new AbortController().signal, observations: [] });
        const usage = web.contextUsage(
          new ContextEngine().render(web.spec, material, [], ["reply"], "stream"),
        );
        expect(ctx.gateway.prepareCalls.length).toBeGreaterThan(0);
        expect(ctx.gateway.counted).toHaveLength(0);
        expect(usage?.model_tokens).toBeUndefined();
        expect(JSON.stringify(material.pending)).toContain(question);
        expect(ctx.gateway.completeCalls).toHaveLength(0);
      } finally {
        ctx.business.close();
      }
    }
  });

  it("stops on an unknown model capacity before it queries or sends anything", async () => {
    const ctx = setup();
    try {
      const counter = await loadTextTokenCounter("o200k_base");
      ctx.gateway.counter = counter;
      ctx.gateway.capacity = null;
      const turn = activeQuestion(ctx, "capacity-null", orderQuestion());
      const web = source(ctx, turn, tokenRuntime(turn.runtime));
      await expect(
        web.read({ signal: new AbortController().signal, observations: [] }),
      ).rejects.toMatchObject({ code: "CONTEXT_CAPACITY_UNKNOWN" });
      expect(ctx.gateway.completeCalls).toHaveLength(0);
      expect(ctx.gateway.capacityCalls).toHaveLength(0);
      expect(snapshotOf(ctx.orm, turn.turnId).resolved_model_contexts).toEqual({});
    } finally {
      ctx.business.close();
    }
  });

  it("rejects a turn whose frozen capacity disagrees with the descriptor", async () => {
    const ctx = setup();
    try {
      const counter = await loadTextTokenCounter("o200k_base");
      ctx.gateway.counter = counter;
      const turn = activeQuestion(ctx, "capacity-mismatch", orderQuestion());
      const seeded = snapshotOf(ctx.orm, turn.turnId);
      seeded.resolved_model_capacities = { [MODEL]: 32768 };
      replaceSnapshot(ctx.orm, turn.turnId, seeded);
      const before = JSON.stringify(seeded);
      const web = source(ctx, turn, tokenRuntime(turn.runtime));
      await expect(
        web.read({ signal: new AbortController().signal, observations: [] }),
      ).rejects.toMatchObject({ code: "CONTEXT_CAPACITY_INSUFFICIENT" });
      expect(ctx.gateway.completeCalls).toHaveLength(0);
      expect(JSON.stringify(snapshotOf(ctx.orm, turn.turnId))).toBe(before);
    } finally {
      ctx.business.close();
    }
  });

  it("does nothing at all when the turn is cancelled before preparation", async () => {
    const ctx = setup();
    try {
      const counter = await loadTextTokenCounter("o200k_base");
      ctx.gateway.counter = counter;
      const turn = activeQuestion(ctx, "cancelled", orderQuestion());
      const web = source(ctx, turn, tokenRuntime(turn.runtime));
      const controller = new AbortController();
      controller.abort();
      await expect(web.read({ signal: controller.signal, observations: [] })).rejects.toThrow();
      expect(ctx.gateway.prepareCalls).toHaveLength(0);
      expect(ctx.gateway.capacityCalls).toHaveLength(0);
      expect(ctx.gateway.counted).toHaveLength(0);
      expect(ctx.gateway.completeCalls).toHaveLength(0);
    } finally {
      ctx.business.close();
    }
  });

  it("rejects a stale route before any material is built", async () => {
    const ctx = setup();
    try {
      const counter = await loadTextTokenCounter("o200k_base");
      ctx.gateway.counter = counter;
      ctx.gateway.stale = true;
      const turn = activeQuestion(ctx, "stale-early", orderQuestion());
      const web = source(ctx, turn, tokenRuntime(turn.runtime));
      await expect(
        web.read({ signal: new AbortController().signal, observations: [] }),
      ).rejects.toThrow("route is no longer current");
      expect(ctx.gateway.counted).toHaveLength(0);
      expect(ctx.gateway.completeCalls).toHaveLength(0);
      expect(snapshotOf(ctx.orm, turn.turnId).resolved_model_contexts).toEqual({});
    } finally {
      ctx.business.close();
    }
  });

  it("rejects a route that goes stale while the request is being priced", async () => {
    const ctx = setup();
    try {
      const counter = await loadTextTokenCounter("o200k_base");
      ctx.gateway.counter = counter;
      ctx.gateway.staleAfterCounted = 1;
      const turn = activeQuestion(ctx, "stale-late", orderQuestion());
      const web = source(ctx, turn, tokenRuntime(turn.runtime));
      const before = JSON.stringify(snapshotOf(ctx.orm, turn.turnId));
      await expect(
        web.read({ signal: new AbortController().signal, observations: [] }),
      ).rejects.toThrow("route is no longer current");
      // One whole request was priced and then refused: no usage record, no model call.
      expect(ctx.gateway.counted.length).toBeGreaterThan(0);
      expect(ctx.gateway.completeCalls).toHaveLength(0);
      expect(snapshotOf(ctx.orm, turn.turnId).resolved_model_contexts).toEqual({
        [MODEL]: READING,
      });
      expect(JSON.stringify(snapshotOf(ctx.orm, turn.turnId))).toBe(
        JSON.stringify({
          ...JSON.parse(before),
          resolved_model_contexts: { [MODEL]: READING },
          resolved_model_capacities: { [MODEL]: CAPACITY },
        }),
      );
    } finally {
      ctx.business.close();
    }
  });
});

describe("usage contract around the token unit", () => {
  it("keeps a byte-only usage record valid and free of a token claim", () => {
    const parsed = ContextUsageSchema.parse({
      session_id: "s",
      turn_id: "t",
      model: MODEL,
      estimator: "utf8_bytes_plus_message_overhead",
      capacity: CAPACITY,
      input_units: 900,
      input_limit: INPUT_LIMIT,
      output_reserved: OUTPUT_TOKENS,
      safety_reserved: Math.ceil(CAPACITY * SAFETY_RATIO),
      remaining: INPUT_LIMIT - 900,
      components: {
        instructions: 100,
        recent_history: 200,
        summaries: 0,
        long_term_memory: 0,
        knowledge: 0,
        current_question: 400,
        protocol: 3,
      },
    });
    expect(parsed.model_tokens).toBeUndefined();
    expect(parsed.input_units).toBe(900);
    expect(Object.keys(parsed)).not.toContain("token_units");
  });

  it("stores only primitives for the frozen reading", () => {
    const parsed = ResolvedModelContextSchema.parse(READING);
    expect(parsed.tokenizer_encoding).toBe("o200k_base");
    expect(parsed.route_revision).toBe(3);
    for (const extra of [{ baseUrl: "http://127.0.0.1:1234/v1" }, { countText: () => 1 }])
      expect(ResolvedModelContextSchema.safeParse({ ...READING, ...extra }).success).toBe(false);
  });
});
