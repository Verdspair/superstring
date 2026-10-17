// Web context assembly measurement reuse (H2 backend performance review).
//
// Facts under test (src/server/agent/conversation-context.ts, point-in-time
// hashes in WEB-ASSEMBLY-RED-READY.json): the initial compression gate calls
// costOf(assemble()) and then fits(assemble()) on the SAME assembled
// candidate, and the compression-loop condition calls fits(assemble()) and
// costOf(assemble()) on the same candidate within one evaluation. Each
// measured call runs this.priced -> measureContextTokens, which re-serializes
// the whole request and counts it. One unchanged-selection build must measure
// a given candidate once per gate evaluation: the gate's fits/costOf pair
// shares one measurement of that candidate; the final fits verification and
// the usage publication each measure their own fresh candidate. Guards are
// never cached: assertCurrent() runs on every fits() call, buildFits is
// evaluated per call, and a changed selection always assembles a new candidate
// and is re-measured. No global or cross-build measurement cache is allowed.
//
// The descriptor's counter here is deterministic (UTF-8 byte length) with a
// declared encoding, so the fixture sizes the history to land strictly between
// the compression trigger and the input limit without tokenizer-version drift;
// real-tokenizer pricing behavior is covered by web-token-budget.test.ts.
// This test instruments the measured path's call count, not timings, and
// asserts no magic strings.

import { describe, expect, it } from "bun:test";
import { ContextBuilder } from "../../src/server/agent/conversation-context";
import type { ModelContextBudget } from "../../src/server/agent/model-port";
import {
  createSession,
  ensureDefaults,
  getTurnByRequest,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import type { ResolvedModelContext, RuntimeConfig } from "../../src/shared/contracts/agent";

const MODEL = "qwen/qwen3-4b-2507";
const CAPACITY = 32768;
const OUTPUT_TOKENS = 4096;
const SAFETY_RATIO = 0.1;
const TRIGGER_RATIO = 0.8;
/** capacity - output_reserved - ceil(capacity * safety_margin_ratio) = 25395. */
const INPUT_LIMIT = CAPACITY - OUTPUT_TOKENS - Math.ceil(CAPACITY * SAFETY_RATIO);
/** Math.trunc(INPUT_LIMIT * TRIGGER_RATIO) = 20316. */
const TRIGGER = Math.trunc(INPUT_LIMIT * TRIGGER_RATIO);
const HISTORY_TURNS = 5;
const PAIR_BYTES = 2280;

const READING: ResolvedModelContext = {
  model: MODEL,
  capacity: CAPACITY,
  tokenizer_encoding: "o200k_base",
  route_revision: 1,
};

type CompleteCall = Parameters<ModelGateway["complete"]>[0];

/** Measured-path gateway: deterministic counter plus a record of every counted request. */
class MeasuringGateway implements ModelGateway {
  readonly config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  readonly completeCalls: CompleteCall[] = [];
  /** Every whole request handed to the measured path's counter, in order. */
  readonly counted: string[] = [];

  private readonly countText = (text: string): number => {
    this.counted.push(text);
    return Buffer.byteLength(text);
  };

  async listModels(): Promise<string[]> {
    return [MODEL];
  }
  async loadedContextCapacity(): Promise<number | null> {
    return CAPACITY;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async complete(call: CompleteCall): Promise<string> {
    this.completeCalls.push(call);
    throw new Error("no model call is expected in this fixture");
  }
  async *streamChat(): AsyncGenerator<string> {
    yield "unused";
  }
  prepareContextModel = async (
    _model: string,
    options?: {
      signal?: AbortSignal;
    },
  ): Promise<ModelContextBudget> => {
    options?.signal?.throwIfAborted();
    return {
      model: MODEL,
      capacity: CAPACITY,
      tokenizerEncoding: "o200k_base" as const,
      countText: this.countText,
      routeRevision: 1,
      assertCurrent: () => {},
    };
  };
}

const handles: ReturnType<typeof openBusinessDb>[] = [];

function completedTurn(
  orm: Parameters<typeof prepareTurn>[0],
  sessionId: string,
  key: string,
): { user: string; assistant: string } {
  const user = `u${key}-${"x".repeat(PAIR_BYTES)}`;
  const assistant = `a${key}-${"y".repeat(PAIR_BYTES)}`;
  const prepared = prepareTurn(orm, sessionId, user, key);
  if (prepared.generationToken === null) throw new Error("fresh token expected");
  saveCompletedAssistantMessage(orm, sessionId, assistant, key, prepared.generationToken);
  const turn = getTurnByRequest(orm, sessionId, key);
  if (!turn) throw new Error("turn missing");
  return { user, assistant };
}

async function setup(mode: "auto" | "fixed", turns: number) {
  const business = openBusinessDb();
  handles.push(business);
  ensureDefaults(business.orm, MODEL);
  const gateway = new MeasuringGateway();
  const orm = business.orm;
  const sessionId = createSession(orm, "assembly-work", { modelName: MODEL }).id;
  const history: { user: string; assistant: string }[] = [];
  for (let index = 1; index <= turns; index += 1) {
    history.push(completedTurn(orm, sessionId, `h${index}`));
  }
  const current = prepareTurn(orm, sessionId, "现在问题", "current");
  if (current.generationToken === null) throw new Error("fresh token expected");
  const currentTurn = getTurnByRequest(orm, sessionId, "current");
  if (!currentTurn) throw new Error("current turn missing");
  const base = current.runtime;
  const p5 = {
    ...base.p5_config,
    context_window: CAPACITY,
    max_output_tokens: OUTPUT_TOKENS,
    safety_margin_ratio: SAFETY_RATIO,
    compression_trigger_ratio: TRIGGER_RATIO,
    retrieval_mode: "off" as const,
    recent_turns: 1,
    ...(mode === "auto" ? { allocation: { mode: "auto" as const } } : {}),
  };
  const runtime = {
    ...base,
    p5_config: p5,
    resolved_model_contexts: { [MODEL]: READING },
  } as RuntimeConfig;
  const builder = new ContextBuilder({ orm, db: business.db, gateway });
  return { gateway, sessionId, history, current, currentTurn, runtime, builder };
}

async function buildHistory(ctx: Awaited<ReturnType<typeof setup>>) {
  return ctx.builder.build({
    sessionId: ctx.sessionId,
    currentTurnId: ctx.currentTurn.id,
    runtime: ctx.runtime,
    generationToken: ctx.current.generationToken,
  });
}

/**
 * The serialized whole request: the candidate carrying every history pair.
 * The protected system+question baseline carries no history marker, so it is
 * excluded; the detector never keys on the current question.
 */
function fullRequestCount(ctx: Awaited<ReturnType<typeof setup>>): { text: string; count: number } {
  const markers = ctx.history.map((_, index) => `uh${index + 1}-`);
  const marked = ctx.gateway.counted.filter((text) =>
    markers.every((marker) => text.includes(marker)),
  );
  const texts = [...new Set(marked)];
  if (texts.length !== 1) {
    throw new Error(
      `expected exactly one distinct full-request serialization, got ${texts.length}`,
    );
  }
  const text = texts[0];
  return { text, count: ctx.gateway.counted.filter((entry) => entry === text).length };
}

describe("web context assembly measurement reuse (integration)", () => {
  it("auto keeps fitting history and measures one unchanged candidate once per gate", async () => {
    const ctx = await setup("auto", HISTORY_TURNS);
    try {
      const messages = await buildHistory(ctx);
      // Healthy control: the whole request fits the real limit, so auto mode
      // keeps every history pair and never calls the model.
      expect(messages[0]?.role).toBe("system");
      expect(messages.slice(1, -1).map((m) => m.content)).toEqual(
        ctx.history.flatMap((t) => [t.user, t.assistant]),
      );
      expect(messages.at(-1)).toEqual({ role: "user", content: "现在问题" });
      expect(ctx.gateway.completeCalls).toHaveLength(0);
      // Fixture precondition: the candidate sits strictly between the trigger
      // and the limit, so the gate really evaluates both costOf and fits.
      const { text, count } = fullRequestCount(ctx);
      expect(Buffer.byteLength(text)).toBeGreaterThan(TRIGGER);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(INPUT_LIMIT);
      // One shared gate measurement + one final fits verification + one usage
      // publication for an unchanged selection; never two measurements of the
      // same candidate inside one gate evaluation.
      expect(count).toBeLessThanOrEqual(3);
    } finally {
      handles.pop()?.close();
    }
  });

  it("small auto history stays uncompressed and bounded without regressing", async () => {
    const ctx = await setup("auto", 1);
    try {
      const messages = await buildHistory(ctx);
      expect(messages[0]?.role).toBe("system");
      expect(messages.slice(1, -1).map((m) => m.content)).toEqual([
        ctx.history[0].user,
        ctx.history[0].assistant,
      ]);
      expect(messages.at(-1)).toEqual({ role: "user", content: "现在问题" });
      expect(ctx.gateway.completeCalls).toHaveLength(0);
      const { text, count } = fullRequestCount(ctx);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TRIGGER);
      expect(count).toBeLessThanOrEqual(3);
    } finally {
      handles.pop()?.close();
    }
  });
});
