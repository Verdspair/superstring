// Conversation compression budgets against the actual model: when the turn snapshot declares
// frozen model contexts and the gateway can prepare a budget descriptor, the whole request
// (messages + response schema) is counted by that model's own counter and the leaf gets the
// descriptor plus the input limit. Every old path — no descriptor, no declared encoding, a
// legacy snapshot that never declared the field — keeps the byte estimate unchanged.

import { describe, expect, it } from "bun:test";
import {
  type CompressionRecord,
  ConversationCompressor,
} from "../../src/server/agent/conversation-compression";
import type { ModelContextBudget } from "../../src/server/agent/model-port";
import { loadTextTokenCounter } from "../../src/server/llm/text-token-counter";

type CompressorOptions = ConstructorParameters<typeof ConversationCompressor>[0];

const COMPRESSION_MODEL = "compress-model";

function runtimeConfig(contexts: Record<string, unknown> | undefined): unknown {
  return {
    agent_id: "agent-1",
    name: "bot",
    system_prompt: "",
    additional_instructions: "",
    model_name: "main-model",
    temperature: 0,
    memory_consolidation_model_name: "memory-model",
    memory_consolidation_prompt: "p",
    memory_consolidation_additional_instructions: "",
    memory_retrieval_model_name: "retrieval-model",
    memory_retrieval_prompt: "p",
    memory_retrieval_additional_instructions: "",
    context_compression_model_name: COMPRESSION_MODEL,
    p5_config: {
      auxiliary_timeout_seconds: 30,
      summary_max_tokens: 2048,
      safety_margin_ratio: 0.1,
    },
    resolved_model_capacities: {},
    ...(contexts === undefined ? {} : { resolved_model_contexts: contexts }),
    mode: "chat",
    config_version: 1,
  };
}

function records(count: number, text: string): CompressionRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `event-${index + 1}`,
    seq: index + 1,
    speaker: "member:20002",
    text: `${text}${index}`,
    sources: [{ kind: "qq_observation", id: `obs-${index + 1}`, revision: "rev" }],
  }));
}

const OWNER = {
  kind: "qq_binding",
  id: "binding-1",
  userId: "user-1",
  agentId: "agent-1",
} as const;

interface LeafCall {
  spec: Record<string, unknown>;
  messages: readonly { role: string; content: unknown }[];
}

interface Harness {
  compressor: ConversationCompressor;
  leafCalls: LeafCall[];
  leafInputs: Record<string, unknown>[];
  prepareCalls: string[];
  capacityCalls: number;
  assertCalls: number;
  snapshot: Record<string, unknown>;
}

/** The model answers with one fact per sent event, so validation passes without extra fixtures. */
function setup(input: {
  contexts?: Record<string, unknown>;
  descriptor?: (model: string) => Promise<ModelContextBudget>;
  legacySnapshot?: boolean;
}): Harness {
  const leafCalls: LeafCall[] = [];
  const leafInputs: Record<string, unknown>[] = [];
  const prepareCalls: string[] = [];
  const state = { capacityCalls: 0, assertCalls: 0 };
  const snapshot = runtimeConfig(
    input.legacySnapshot === true ? undefined : (input.contexts ?? {}),
  ) as Record<string, unknown>;
  const gateway: Record<string, unknown> = {
    loadedContextCapacity: async () => {
      state.capacityCalls += 1;
      return 65536;
    },
    ...(input.descriptor === undefined
      ? {}
      : {
          prepareContextModel: async (model: string) => {
            prepareCalls.push(model);
            return input.descriptor?.(model);
          },
        }),
  };
  const agentRuntime = {
    completeLeaf: async (spec: Record<string, unknown>, leafInput: Record<string, unknown>) => {
      leafCalls.push({ spec, messages: leafInput.messages as LeafCall["messages"] });
      leafInputs.push(leafInput);
      const payload = JSON.parse(
        (leafInput.messages as { content: string }[])[1]?.content ?? "{}",
      ) as { events?: { id: string; speaker: string }[] };
      const raw = JSON.stringify({
        facts: (payload.events ?? []).map((event) => ({
          kind: "fact",
          speaker: event.speaker,
          text: "old fact",
          source_ids: [event.id],
        })),
      });
      (leafInput.validate as (text: string) => unknown)(raw);
      return raw;
    },
  };
  const compressor = new ConversationCompressor({
    runtime: snapshot,
    agentRuntime,
    gateway,
    owner: OWNER,
    assertSources: () => {
      state.assertCalls += 1;
    },
  } as unknown as CompressorOptions);
  return {
    compressor,
    leafCalls,
    leafInputs,
    prepareCalls,
    snapshot,
    get capacityCalls() {
      return state.capacityCalls;
    },
    get assertCalls() {
      return state.assertCalls;
    },
  };
}

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  return (caught as { code?: string })?.code;
}

async function knownDescriptor(capacity: number): Promise<ModelContextBudget> {
  const counter = await loadTextTokenCounter("cl100k_base");
  return {
    model: COMPRESSION_MODEL,
    capacity,
    tokenizerEncoding: counter.encoding,
    countText: counter.count,
    assertCurrent: () => {},
  };
}

const CHINESE = "压缩预算必须按实际模型计数而不是按字节数估算，否则中文消息会被提前拒绝。";

describe("compression token budget", () => {
  it("counts the whole request with the actual model counter and hands the leaf the descriptor", async () => {
    const capacity = 8192;
    const descriptor = await knownDescriptor(capacity);
    const h = setup({
      contexts: {
        [COMPRESSION_MODEL]: {
          model: COMPRESSION_MODEL,
          capacity,
          tokenizer_encoding: descriptor.tokenizerEncoding,
        },
      },
      descriptor: async () => descriptor,
    });
    // Chinese text is several UTF-8 bytes per model token, so this batch cannot fit the
    // legacy byte budget while it still fits the model's own token budget.
    const evidence = await h.compressor.summarize({
      records: records(10, CHINESE.repeat(5)),
      target: 2048,
      signal: new AbortController().signal,
    });
    expect(evidence).not.toBeNull();
    expect(h.prepareCalls).toEqual([COMPRESSION_MODEL]);
    expect(h.capacityCalls).toBe(0);
    expect(h.assertCalls).toBeGreaterThan(0);
    const call = h.leafCalls[0];
    if (!call) throw new Error("leaf not called");
    // output reserve stays the historical numeric policy (summary_max_tokens vs target):
    // capacity - output - ceil(capacity * safety_margin_ratio).
    const limit = capacity - 2048 - Math.ceil(capacity * 0.1);
    expect(h.leafInputs[0].contextBudget).toBe(descriptor);
    expect(h.leafInputs[0].contextInputLimit).toBe(limit);
    expect(call.spec.model).toBe(COMPRESSION_MODEL);
    expect(call.spec.maxTokens).toBe(2048);
    expect(call.spec.responseSchema).toBeDefined();
    const bytes =
      new TextEncoder().encode(JSON.stringify(call.messages)).length +
      new TextEncoder().encode(JSON.stringify(call.spec.responseSchema)).length;
    expect(bytes).toBeGreaterThan(limit);
    // Sources, the summary target and the published evidence are unchanged.
    const text = JSON.stringify(evidence);
    expect(text).toContain("qq_observation");
    expect(text).toContain("obs-1");
  });

  it("rejects an oversized request before the leaf runs and keeps every source", async () => {
    const descriptor = await knownDescriptor(4096);
    const h = setup({ descriptor: async () => descriptor });
    const code = await codeOf(() =>
      h.compressor.summarize({
        records: records(1, "订单A01,B02,C03 ".repeat(12000)),
        target: 2048,
        signal: new AbortController().signal,
      }),
    );
    expect(code).toBe("CONTEXT_AUX_BUDGET");
    expect(h.leafCalls).toHaveLength(0);
    expect(h.assertCalls).toBeGreaterThan(0);
  });

  it("fails closed when the descriptor cannot confirm a capacity", async () => {
    const h = setup({
      descriptor: async () => ({
        model: COMPRESSION_MODEL,
        capacity: null,
        assertCurrent: () => {},
      }),
    });
    const code = await codeOf(() =>
      h.compressor.summarize({
        records: records(2, CHINESE),
        target: 2048,
        signal: new AbortController().signal,
      }),
    );
    expect(code).toBe("CONTEXT_CAPACITY_UNKNOWN");
    expect(h.leafCalls).toHaveLength(0);
    expect(h.capacityCalls).toBe(0);
  });

  it("refuses a descriptor that disagrees with this turn's frozen reading", async () => {
    const descriptor = await knownDescriptor(32768);
    const h = setup({
      contexts: {
        [COMPRESSION_MODEL]: {
          model: COMPRESSION_MODEL,
          capacity: 16384,
          tokenizer_encoding: "cl100k_base",
        },
      },
      descriptor: async () => descriptor,
    });
    const before = JSON.stringify(h.snapshot);
    const code = await codeOf(() =>
      h.compressor.summarize({
        records: records(2, CHINESE),
        target: 2048,
        signal: new AbortController().signal,
      }),
    );
    expect(code).toBe("CONTEXT_CAPACITY_INSUFFICIENT");
    expect(h.leafCalls).toHaveLength(0);
    expect(JSON.stringify(h.snapshot)).toBe(before);
  });

  it("keeps the original abort reason before preparing anything", async () => {
    const descriptor = await knownDescriptor(32768);
    const h = setup({ descriptor: async () => descriptor });
    const reason = new Error("stale signal");
    const signal = AbortSignal.abort(reason);
    let caught: unknown;
    try {
      await h.compressor.summarize({
        records: records(2, CHINESE),
        target: 2048,
        signal,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
    expect(h.prepareCalls).toHaveLength(0);
    expect(h.leafCalls).toHaveLength(0);
  });

  it("falls back to the byte path when the route declares no encoding", async () => {
    const h = setup({
      descriptor: async () => ({
        model: COMPRESSION_MODEL,
        capacity: 32768,
        assertCurrent: () => {},
      }),
    });
    await h.compressor.summarize({
      records: records(2, CHINESE),
      target: 2048,
      signal: new AbortController().signal,
    });
    expect(h.prepareCalls).toHaveLength(1);
    const call = h.leafCalls[0];
    if (!call) throw new Error("leaf not called");
    expect(call.spec.contextBudget).toBeUndefined();
    expect(call.spec.contextInputLimit).toBeUndefined();
  });

  it("preserves a prepared route descriptor even when no tokenizer is declared", async () => {
    const budget: ModelContextBudget = {
      model: COMPRESSION_MODEL,
      capacity: 32768,
      assertCurrent: () => {},
    };
    const h = setup({ descriptor: async () => budget });
    await h.compressor.summarize({
      records: records(2, CHINESE),
      target: 2048,
      signal: new AbortController().signal,
    });
    expect(h.leafInputs[0]?.contextBudget).toBe(budget);
    expect(h.leafInputs[0]?.contextInputLimit).toBeUndefined();
    expect(h.prepareCalls).toHaveLength(1);
    expect(h.capacityCalls).toBe(0);
  });

  it("keeps the old gateway path free of prepare calls", async () => {
    const h = setup({});
    await h.compressor.summarize({
      records: records(2, CHINESE),
      target: 2048,
      signal: new AbortController().signal,
    });
    expect(h.prepareCalls).toHaveLength(0);
    expect(h.capacityCalls).toBe(1);
    const call = h.leafCalls[0];
    if (!call) throw new Error("leaf not called");
    expect(call.spec.contextBudget).toBeUndefined();
  });

  it("never touches a legacy snapshot that never declared the field", async () => {
    const descriptor = await knownDescriptor(32768);
    const h = setup({ legacySnapshot: true, descriptor: async () => descriptor });
    await h.compressor.summarize({
      records: records(2, CHINESE),
      target: 2048,
      signal: new AbortController().signal,
    });
    expect(h.prepareCalls).toHaveLength(0);
    expect(h.capacityCalls).toBe(1);
    expect("resolved_model_contexts" in h.snapshot).toBe(false);
  });

  it("serves the second identical call from the existing cache without a new request", async () => {
    const descriptor = await knownDescriptor(32768);
    const h = setup({ descriptor: async () => descriptor });
    const input = {
      records: records(4, CHINESE),
      target: 2048,
      signal: new AbortController().signal,
    };
    const first = await h.compressor.summarize(input);
    const second = await h.compressor.summarize(input);
    expect(second).toEqual(first);
    expect(h.leafCalls).toHaveLength(1);
    expect(h.prepareCalls).toHaveLength(1);
  });
});
