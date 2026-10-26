import { runtimeFixtureBusiness } from "../harness/business-db";
// Web context allocation modes (0068) — history boundary + tool-result fit boundary.
//
// Allocation contract:
// p5_config.allocation { mode: fixed | auto }, absent = fixed (old protected fallback).
// Auto: (1) history candidates are measured against the real full request — the
// fixed-mode trigger policy (compression_trigger_ratio pushing history down even
// while the whole request fits) must not truncate fitting history; (2) when a later
// tool result does not fit, the assembly flow may reclaim still-selectable old
// history (oldest first, never the current question, the protocol, or accepted
// observations), then re-verify the full candidate and the same-batch joint
// reservation. Fixed mode keeps today's behavior verbatim in both boundaries.
//
// Both modes share the same sizing math: the oversized knowledge payload is
// computed once per fixture from that fixture's own remaining room, so the
// fixed golden is exercised by a genuinely oversized result, not a zero-byte one.

import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { evidenceCatalogEntry } from "../../src/server/agent/built-in-actions";
import { ContextEngine } from "../../src/server/agent/context-engine";
import { ContextBuilder } from "../../src/server/agent/conversation-context";
import { WebContextSource } from "../../src/server/channels/web-context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  createSession,
  DEFAULT_USER_ID,
  ensureDefaults,
  getTurnByRequest,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import type { RuntimeConfig } from "../../src/shared/contracts";

const MODEL = "qwen/qwen3-4b-2507";
const PAIR_BYTES = 2300; // one history pair ~ 4.6k estimator units

type CompleteCall = Parameters<ModelGateway["complete"]>[0];

class AllocationGateway implements ModelGateway {
  readonly config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  readonly completeCalls: CompleteCall[] = [];
  capacity: number;
  scripted: string[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  async listModels(): Promise<string[]> {
    return [MODEL];
  }
  async loadedContextCapacity(): Promise<number | null> {
    return this.capacity;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async complete(call: CompleteCall): Promise<string> {
    this.completeCalls.push(call);
    const decisionContent = call.messages[0]?.content;
    if (
      typeof decisionContent === "string" &&
      decisionContent.includes("Return exactly one JSON decision")
    ) {
      return this.scripted.shift() ?? '{"kind":"none"}';
    }
    return JSON.stringify({ facts: [] });
  }
  async *streamChat(): AsyncGenerator<string> {
    yield "完成";
  }
}

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

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

function actionObservations(request: CompleteCall) {
  return request.messages.flatMap((message) => {
    try {
      if (typeof message.content !== "string") return [];
      const data = JSON.parse(message.content) as { kind?: string; value?: unknown };
      return data.kind === "action_observation"
        ? [
            data.value as {
              name: string;
              value: { status: string; items: { id: string }[] };
            },
          ]
        : [];
    } catch {
      return [];
    }
  });
}

// ---- History boundary -----------------------------------------------------------------

const HISTORY_TURNS = 5;

// Byte math with the single estimator (utf8_bytes_plus_message_overhead):
// limit = 32768 - 4096 - ceil(32768 * 0.1) = 25395; trigger = floor(25395 * 0.8) = 20316.
// 5 pairs at 2300+2300 payload bytes land the full assemble() at ~23.3k:
// above the trigger (fixed compresses) but under the real limit (auto must keep it).
async function setupHistory(mode: "auto" | "absent") {
  const business = runtimeFixtureBusiness(openBusinessDb(), MODEL);
  handles.push(business);
  ensureDefaults(business.orm, MODEL);
  const gateway = new AllocationGateway(32768);
  const orm = business.orm;
  const sessionId = createSession(orm, "auto-history", { modelName: MODEL }).id;
  const turns = [];
  for (let index = 1; index <= HISTORY_TURNS; index += 1) {
    turns.push(completedTurn(orm, sessionId, `h${index}`));
  }
  const current = prepareTurn(orm, sessionId, "现在问题", "current");
  if (current.generationToken === null) throw new Error("fresh token expected");
  const currentTurn = getTurnByRequest(orm, sessionId, "current");
  if (!currentTurn) throw new Error("current turn missing");
  const base = current.runtime;
  const p5 = {
    ...base.p5_config,
    retrieval_mode: "off" as const,
    recent_turns: 1,
    ...(mode === "auto" ? { allocation: { mode: "auto" as const } } : {}),
  };
  const runtime = { ...base, p5_config: p5 } as RuntimeConfig;
  const builder = new ContextBuilder({ orm, db: business.db, gateway });
  return { gateway, sessionId, turns, current, currentTurn, runtime, builder };
}

describe("web context allocation modes (integration)", () => {
  it("auto keeps the full fitting history instead of trigger-compressing it", async () => {
    const ctx = await setupHistory("auto");
    const messages = await ctx.builder.build({
      sessionId: ctx.sessionId,
      currentTurnId: ctx.currentTurn.id,
      runtime: ctx.runtime,
      generationToken: ctx.current.generationToken,
    });
    // Auto: instructions + all 5 history pairs + the current question, no
    // auxiliary summarize call, because the whole request fits the real limit.
    expect(messages[0]?.role).toBe("system");
    const history = messages.slice(1, -1);
    expect(history.map((m) => m.content)).toEqual(ctx.turns.flatMap((t) => [t.user, t.assistant]));
    expect(messages.at(-1)).toEqual({ role: "user", content: "现在问题" });
    expect(ctx.gateway.completeCalls).toHaveLength(0);
  });

  it("absent allocation stays fixed: trigger compression behaves as today (4 turns retained)", async () => {
    const ctx = await setupHistory("absent");
    const messages = await ctx.builder.build({
      sessionId: ctx.sessionId,
      currentTurnId: ctx.currentTurn.id,
      runtime: ctx.runtime,
      generationToken: ctx.current.generationToken,
    });
    // Fixed golden (today's behavior): the full 5-pair assemble is over the trigger,
    // one oldest pair is summarized away (empty facts render no summary message) and
    // the remaining 4-pair request is back under the trigger, so compression stops.
    expect(messages[0]?.role).toBe("system");
    expect(messages.slice(1, -1).map((m) => m.content)).toEqual(
      ctx.turns.slice(1).flatMap((t) => [t.user, t.assistant]),
    );
    expect(messages.at(-1)).toEqual({ role: "user", content: "现在问题" });
  });
});

// ---- Tool-result fit boundary ----------------------------------------------------------

const FIT_HISTORY_TURNS = 4;

async function setupFit(mode: "auto" | "absent") {
  const business = runtimeFixtureBusiness(openBusinessDb(), MODEL);
  handles.push(business);
  ensureDefaults(business.orm, MODEL);
  const gateway = new AllocationGateway(65536);
  const orm = business.orm;
  const sessionId = createSession(orm, "auto-fit", { modelName: MODEL }).id;
  const turns = [];
  for (let index = 1; index <= FIT_HISTORY_TURNS; index += 1) {
    turns.push(completedTurn(orm, sessionId, `h${index}`));
  }
  const current = prepareTurn(orm, sessionId, "现在的问题", "current");
  if (current.generationToken === null) throw new Error("fresh token expected");
  const currentTurn = getTurnByRequest(orm, sessionId, "current");
  if (!currentTurn) throw new Error("current turn missing");
  const base = current.runtime;
  const p5 = {
    ...base.p5_config,
    retrieval_mode: "standard" as const,
    compression_enabled: false,
    recent_turns: 1,
    ...(mode === "auto" ? { allocation: { mode: "auto" as const } } : {}),
  };
  const runtime = { ...base, p5_config: p5 } as RuntimeConfig;
  if (!runtime.knowledge_read) throw new Error("missing knowledge settings");
  runtime.knowledge_read = { ...runtime.knowledge_read, budget: 1_000_000 };
  runtime.p5_config.retrieval_presets.standard = {
    ...runtime.p5_config.retrieval_presets.standard,
    max_tokens: 1_000_000,
  };
  // Knowledge item payload size, sized once per fixture from its own remaining room
  // AFTER the first read — identical math in both modes, so the fixed golden sees
  // the same genuinely oversized result the auto case reclaims history for.
  const itemBytes = { value: 0 };
  const evidence = (id: string) => ({
    id,
    text: "body",
    sources: [],
    preview: { title: id, summary: "k".repeat(itemBytes.value) },
  });
  const agentRuntime = createAgentRuntime({
    gateway,
    repository: new AgentRunRepository(business.db),
  });
  const adapter = new WebContextSource({
    db: business.db,
    orm,
    gateway,
    agentRuntime,
    builder: new ContextBuilder({ orm, db: business.db, gateway }),
    runtime,
    sessionId,
    turnId: currentTurn.id,
    generationToken: current.generationToken ?? "missing",
    maxSteps: 16,
    modules: () => ({
      memory: { query: async () => [] },
      knowledge: { query: async () => [evidence("k1"), evidence("k2")] },
    }),
  });
  const material = await adapter.read({ signal: new AbortController().signal, observations: [] });
  const limit = adapter.spec.limits.inputUnits;
  if (limit === undefined) throw new Error("missing Web input limit");
  // Same-unit probe as the fitter: U(observations + [probe]) - U(observations).
  const engine = new ContextEngine();
  const baseUnits = engine.render(adapter.spec, material, [], ["reply"], "stream").units;
  const room = limit - baseUnits;
  const probe = (count: number) => {
    const items = [evidenceOf(itemBytes, "k1"), evidenceOf(itemBytes, "k2")].slice(0, count);
    return (
      engine.render(
        adapter.spec,
        material,
        [
          {
            id: "00000000-0000-0000-0000-000000000000",
            name: "knowledge.query",
            arguments: { query: "apples" },
            value: { status: "ok", items },
            sources: [],
          },
        ],
        ["reply"],
        "stream",
      ).units - baseUnits
    );
  };
  itemBytes.value = Math.max(200, Math.floor(room * 0.55));
  const one = probe(1);
  const two = probe(2);
  expect(one).toBeLessThanOrEqual(room);
  expect(two).toBeGreaterThan(room);
  expect(two - room).toBeLessThanOrEqual(PAIR_BYTES * 2 + 100); // one pair reclaim (~4.65k units) suffices
  return {
    gateway,
    sessionId,
    current,
    currentTurn,
    runtime,
    agentRuntime,
    adapter,
    itemBytes,
    turns,
  };
}

function evidenceOf(
  itemBytes: { value: number },
  id: string,
): ReturnType<typeof evidenceCatalogEntry> {
  return evidenceCatalogEntry("knowledge", {
    id,
    text: "body",
    sources: [],
    preview: { title: id, summary: "k".repeat(itemBytes.value) },
  });
}

async function runTurn(fixture: Awaited<ReturnType<typeof setupFit>>, requestId: string) {
  const { adapter } = fixture;
  fixture.gateway.scripted = [
    JSON.stringify({
      kind: "invoke",
      calls: [{ name: "knowledge.query", arguments: { query: "apples" } }],
    }),
    JSON.stringify({
      kind: "final",
      outputs: [{ kind: "generate", targetId: "reply", instructions: "answer" }],
    }),
  ];
  const result = await fixture.agentRuntime.run(adapter.spec, {
    owner: {
      kind: "web_turn",
      id: fixture.currentTurn.id,
      userId: DEFAULT_USER_ID,
      agentId: fixture.runtime.agent_id,
    },
    context: adapter,
    actions: adapter.actions,
    authorizedTargets: ["reply"],
    outputMode: "stream" as const,
    signal: new AbortController().signal,
    requestId,
  });
  expect(result.status).toBe("completed");
  const finalCall = fixture.gateway.completeCalls.at(-1);
  if (!finalCall) throw new Error("final decision call missing");
  const knowledge = actionObservations(finalCall).find((entry) => entry.name === "knowledge.query");
  if (!knowledge) throw new Error("knowledge observation missing");
  return knowledge.value.items.map((item) => item.id);
}

describe("web auto tool-result fit boundary (integration)", () => {
  it("auto reclaims still-selectable history so a fitting-result pair is fully admitted", async () => {
    const fixture = await setupFit("auto");
    const admitted = await runTurn(fixture, "auto-fit");
    // Auto: reclaim the oldest optional pair instead of trimming the result, so
    // both items are admitted and the next render still fits.
    expect(admitted).toEqual(["k1", "k2"]);
  });

  it("absent allocation stays fixed: oversized result is trimmed, no history reclaim", async () => {
    const fixture = await setupFit("absent");
    const admitted = await runTurn(fixture, "fixed-fit");
    // Fixed golden (today's behavior): the same oversized result is trimmed to the
    // largest fitting prefix and no history is reclaimed.
    expect(admitted).toEqual(["k1"]);
  });
});
