import { runtimeFixtureBusiness } from "../harness/business-db";
// Dynamic query admission integration tests
//
// Verifies dynamic query admission with auto-mode history reclaim under declared-counter
// token mode, alongside fixed-mode prefix trimming and mandatory true overcap controls.
//
// Real surfaces only (ContextBuilder, WebContextSource, AgentRuntime); synthetic database only.
// Public tool execution only — no private property access or casts.

import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { evidenceCatalogEntry } from "../../src/server/agent/built-in-actions";
import { ContextEngine, textMessage } from "../../src/server/agent/context-engine";
import { ContextBuilder } from "../../src/server/agent/conversation-context";
import type { ModelContextBudget } from "../../src/server/agent/model-port";
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
import type { ModelGateway, ModelTool } from "../../src/server/llm/model-gateway";
import {
  measurePreparedRequest,
  nativeToolDeclarations,
  type PreparedRequestFormat,
} from "../../src/server/llm/request-format";
import {
  loadTextTokenCounter,
  type TextTokenCounter,
} from "../../src/server/llm/text-token-counter";
import type { RuntimeConfig } from "../../src/shared/contracts";
import { AGENT_DECISION_JSON_SCHEMA } from "../../src/shared/contracts/agent-output";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";

const MODEL = "qwen/qwen3-4b-2507";
const PAIR_TEXT = "历史上下文对话记录内容说明测试正文";

type CompleteCall = Parameters<ModelGateway["complete"]>[0];

class DynamicAdmissionGateway implements ModelGateway {
  readonly config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  readonly completeCalls: CompleteCall[] = [];
  capacity: number;
  scripted: string[] = [];
  counter?: TextTokenCounter;

  constructor(capacity: number, counter?: TextTokenCounter) {
    this.capacity = capacity;
    this.counter = counter;
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

  prepareContextModel = async (
    model: string,
    options?: { signal?: AbortSignal },
  ): Promise<ModelContextBudget> => {
    options?.signal?.throwIfAborted();
    if (!this.counter) {
      return {
        model,
        capacity: this.capacity,
        assertCurrent: () => {},
      };
    }
    return {
      model,
      capacity: this.capacity,
      tokenizerEncoding: "o200k_base" as const,
      countText: (text: string) => this.counter!.count(text),
      routeRevision: 3,
      assertCurrent: () => {},
    };
  };

  prepareRequestFormat = (input: {
    model: string;
    responseSchema?: Record<string, unknown>;
    tools?: readonly ModelTool[];
  }): PreparedRequestFormat => {
    const declared = input.tools ? nativeToolDeclarations(input.tools) : undefined;
    return Object.freeze({
      level: input.responseSchema ? "json_object" : "none",
      schema: input.responseSchema,
      tools: declared?.tools,
      wireNames: declared?.wireNames ?? new Map(),
    });
  };
}

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

function completedTurn(
  orm: Parameters<typeof prepareTurn>[0],
  sessionId: string,
  key: string,
  repeatCount = 30,
): { user: string; assistant: string } {
  const user = `u${key}-${PAIR_TEXT.repeat(repeatCount)}`;
  const assistant = `a${key}-${PAIR_TEXT.repeat(repeatCount)}`;
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
              value: { status: string; items: { id: string }[]; code?: string };
            },
          ]
        : [];
    } catch {
      return [];
    }
  });
}

const SAMPLE_TEXT = "知识库条目检索摘要数据内容说明";
const makeSummary = (len: number) =>
  SAMPLE_TEXT.repeat(Math.ceil(len / SAMPLE_TEXT.length)).slice(0, len);

describe("dynamic query admission integration", () => {
  it("Web declared-counter token mode: auto history reclaim admits query items instead of premature fitsDecision rejection", async () => {
    const business = runtimeFixtureBusiness(openBusinessDb(), MODEL);
    handles.push(business);
    ensureDefaults(business.orm, MODEL);
    const counter = await loadTextTokenCounter("o200k_base");
    const gateway = new DynamicAdmissionGateway(8192, counter);
    const orm = business.orm;
    const sessionId = createSession(orm, "web-token-auto", { modelName: MODEL }).id;

    // 4 turns of history
    for (let i = 1; i <= 4; i++) {
      completedTurn(orm, sessionId, `t${i}`, 25);
    }
    const current = prepareTurn(orm, sessionId, "请查询知识库内容", "current-token");
    if (!current.generationToken) throw new Error("missing token");
    const currentTurn = getTurnByRequest(orm, sessionId, "current-token")!;

    const base = current.runtime;
    const runtime: RuntimeConfig = {
      ...base,
      p5_config: {
        ...base.p5_config,
        context_window: 8192,
        max_output_tokens: 512,
        safety_margin_ratio: 0.1,
        retrieval_mode: "standard",
        compression_enabled: false,
        recent_turns: 1,
        allocation: { mode: "auto" },
      },
      resolved_model_contexts: {
        [MODEL]: {
          model: MODEL,
          capacity: 8192,
          tokenizer_encoding: "o200k_base",
          route_revision: 3,
        },
      },
    };
    if (!runtime.knowledge_read) throw new Error("missing knowledge_read");
    runtime.knowledge_read = { ...runtime.knowledge_read, budget: 1_000_000 };
    runtime.p5_config.retrieval_presets.standard = {
      ...runtime.p5_config.retrieval_presets.standard,
      max_tokens: 1_000_000,
    };

    const itemBytes = { value: 0 };
    let backendCalls = 0;

    const agentRuntime = createAgentRuntime({
      gateway,
      repository: new AgentRunRepository(business.db),
    });

    const builder = new ContextBuilder({ orm, db: business.db, gateway });
    const adapter = new WebContextSource({
      db: business.db,
      orm,
      gateway,
      agentRuntime,
      builder,
      runtime,
      sessionId,
      turnId: currentTurn.id,
      generationToken: current.generationToken,
      maxSteps: 16,
      modules: () => ({
        memory: { query: async () => [] },
        knowledge: {
          query: async () => {
            backendCalls += 1;
            return [
              {
                id: "k1",
                text: "body",
                sources: [],
                preview: { title: "k1", summary: makeSummary(itemBytes.value) },
              },
              {
                id: "k2",
                text: "body",
                sources: [],
                preview: { title: "k2", summary: makeSummary(itemBytes.value) },
              },
            ];
          },
        },
      }),
    });

    // 1. Verify default production wrapper executes (custom modules wrapped by constructor this.query)
    expect(adapter.actions.some((a) => a.description.name === "knowledge.query")).toBe(true);

    const material = await adapter.read({ signal: new AbortController().signal, observations: [] });
    const limit = adapter.spec.limits.inputUnits;
    if (limit === undefined) throw new Error("missing Web input limit");

    const budget = await adapter.prepareModelContext(MODEL, new AbortController().signal);
    if (!budget?.countText) throw new Error("budget countText missing");

    const format = gateway.prepareRequestFormat({
      model: MODEL,
      responseSchema: AGENT_DECISION_JSON_SCHEMA,
      tools: adapter.spec.availableActions,
    });

    const engine = new ContextEngine();
    const tokensOf = (messages: readonly ModelMessage[]) => {
      const measured = measurePreparedRequest(messages, budget, format);
      if (!measured) throw new Error("measurePreparedRequest failed");
      return measured.textTokens;
    };

    const baseTokens = tokensOf(
      engine.render(adapter.spec, material, [], ["reply"], "stream").messages,
    );
    const roomTokens = limit - baseTokens;

    // Build catalog entries with fixed bodyRef for a given explicit summary size:
    const buildProbeEntries = (size: number) => [
      evidenceCatalogEntry("knowledge", {
        id: "k1",
        text: "body",
        sources: [],
        preview: { title: "k1", summary: makeSummary(size) },
      }),
      evidenceCatalogEntry("knowledge", {
        id: "k2",
        text: "body",
        sources: [],
        preview: { title: "k2", summary: makeSummary(size) },
      }),
    ];

    // Render observation messages using exact bare array shape as WebContextSource line 742:
    const renderProbeMessages = (entries: ReturnType<typeof buildProbeEntries>, count: number) =>
      engine.render(
        adapter.spec,
        material,
        [
          {
            id: "00000000-0000-0000-0000-000000000000",
            name: "knowledge.query",
            arguments: { query: "apples" },
            value: entries.slice(0, count),
            sources: [],
          },
        ],
        ["reply"],
        "stream",
      ).messages;

    // Search with robust margin (+-64 tokens) to avoid boundary jitter from randomUUIDs:
    // probe(1) <= roomTokens - 64 && probe(2) > roomTokens + 64
    const MARGIN = 64;
    let foundEntries: ReturnType<typeof buildProbeEntries> | undefined;
    let foundSize: number | undefined;
    for (let cur = 50; cur <= 10_000; cur += 20) {
      const candidate = buildProbeEntries(cur);
      const cost2 = tokensOf(renderProbeMessages(candidate, 2)) - baseTokens;
      if (cost2 > roomTokens + MARGIN) {
        for (let s = Math.max(1, cur - 40); s <= cur + 20; s += 2) {
          const testEntries = buildProbeEntries(s);
          const c1 = tokensOf(renderProbeMessages(testEntries, 1)) - baseTokens;
          const c2 = tokensOf(renderProbeMessages(testEntries, 2)) - baseTokens;
          if (c1 <= roomTokens - MARGIN && c2 > roomTokens + MARGIN) {
            foundEntries = testEntries;
            foundSize = s;
            break;
          }
        }
        if (foundEntries !== undefined) break;
      }
    }
    if (!foundEntries || foundSize === undefined) {
      throw new Error(
        `No witness found satisfying probe(1) <= ${roomTokens - MARGIN} and probe(2) > ${roomTokens + MARGIN}`,
      );
    }
    itemBytes.value = foundSize;

    // Frozen messages exact equality re-test: verify same messages produce strictly deterministic cost
    const frozen1 = renderProbeMessages(foundEntries, 1);
    const frozen2 = renderProbeMessages(foundEntries, 2);
    const cost1First = tokensOf(frozen1) - baseTokens;
    const cost1Second = tokensOf(frozen1) - baseTokens;
    expect(cost1First).toBe(cost1Second);
    const cost2First = tokensOf(frozen2) - baseTokens;
    const cost2Second = tokensOf(frozen2) - baseTokens;
    expect(cost2First).toBe(cost2Second);

    expect(cost1First).toBeLessThanOrEqual(roomTokens - MARGIN);
    expect(cost2First).toBeGreaterThan(roomTokens + MARGIN);

    // 2. Prove that after legal history reclaim, both items fit under the same limit with mandatory current question intact
    const reselect = builder.reselectFor(currentTurn.id, runtime.agent_id);
    expect(reselect).toBeDefined();
    const proposal = reselect!(({ historyTurnIds, summaryIds }) => ({
      historyTurnIds: historyTurnIds.slice(1),
      summaryIds,
    }));
    expect(proposal).not.toBeNull();
    const nonSystem = proposal!.messages.filter((m) => m.role !== "system");
    const asChannel = (m: (typeof nonSystem)[number]) =>
      textMessage(m.role === "assistant" ? "assistant" : "user", m.content);
    const reclaimedMaterial = {
      ...material,
      sources: proposal!.sources,
      history: nonSystem.slice(0, -1).map(asChannel),
      pending: nonSystem.slice(-1).map(asChannel),
    };
    const reclaimedTokens = tokensOf(
      engine.render(
        adapter.spec,
        reclaimedMaterial,
        [
          {
            id: "00000000-0000-0000-0000-000000000000",
            name: "knowledge.query",
            arguments: { query: "apples" },
            value: foundEntries,
            sources: [],
          },
        ],
        ["reply"],
        "stream",
      ).messages,
    );
    expect(reclaimedTokens).toBeLessThanOrEqual(limit - MARGIN);

    gateway.scripted = [
      JSON.stringify({
        kind: "invoke",
        calls: [{ name: "knowledge.query", arguments: { query: "apples" } }],
      }),
      JSON.stringify({
        kind: "final",
        outputs: [{ kind: "generate", targetId: "reply", instructions: "done" }],
      }),
    ];

    const result = await agentRuntime.run(adapter.spec, {
      owner: {
        kind: "web_turn",
        id: currentTurn.id,
        userId: DEFAULT_USER_ID,
        agentId: runtime.agent_id,
      },
      context: adapter,
      actions: adapter.actions,
      authorizedTargets: ["reply"],
      outputMode: "stream",
      signal: new AbortController().signal,
      requestId: "req-web-token-auto",
    });

    expect(result.status).toBe("completed");
    expect(backendCalls).toBe(1);

    const decisionCall = gateway.completeCalls.at(-1)!;
    const knowledgeObs = actionObservations(decisionCall).find((o) => o.name === "knowledge.query");
    expect(knowledgeObs).toBeDefined();

    const admitted = knowledgeObs!.value.items.map((item) => item.id);

    // On current production code: premature fitsDecision at line 734 rejects the whole 2-item page
    // because un-reclaimed probe(2) > roomTokens, returning status: "unavailable" and admitted: [].
    // Required behavior under auto allocation: reselectFor reclaims history and admits both items.
    expect(knowledgeObs!.value.status).toBe("ok");
    expect(admitted).toEqual(["k1", "k2"]);
  });

  it("fixed mode preserves stored limits without reclaiming history, trimming oversized items to fitting prefix", async () => {
    const business = runtimeFixtureBusiness(openBusinessDb(), MODEL);
    handles.push(business);
    ensureDefaults(business.orm, MODEL);
    const gateway = new DynamicAdmissionGateway(65536);
    const orm = business.orm;
    const sessionId = createSession(orm, "fixed-control", { modelName: MODEL }).id;

    for (let i = 1; i <= 4; i++) {
      completedTurn(orm, sessionId, `f${i}`, 20);
    }
    const current = prepareTurn(orm, sessionId, "固定模式问题", "current-fixed");
    if (!current.generationToken) throw new Error("missing token");
    const currentTurn = getTurnByRequest(orm, sessionId, "current-fixed")!;

    const base = current.runtime;
    const runtime: RuntimeConfig = {
      ...base,
      p5_config: {
        ...base.p5_config,
        context_window: 65536,
        max_output_tokens: 4096,
        safety_margin_ratio: 0.1,
        retrieval_mode: "standard",
        compression_enabled: false,
        recent_turns: 1,
        // Fixed mode (absent allocation)
      },
    };
    if (!runtime.knowledge_read) throw new Error("missing knowledge_read");
    runtime.knowledge_read = { ...runtime.knowledge_read, budget: 1_000_000 };

    const agentRuntime = createAgentRuntime({
      gateway,
      repository: new AgentRunRepository(business.db),
    });

    const itemBytes = { value: 0 };
    const items = [
      { id: "k1", text: "body", sources: [], preview: { title: "k1", summary: "" } },
      { id: "k2", text: "body", sources: [], preview: { title: "k2", summary: "" } },
    ];

    const adapter = new WebContextSource({
      db: business.db,
      orm,
      gateway,
      agentRuntime,
      builder: new ContextBuilder({ orm, db: business.db, gateway }),
      runtime,
      sessionId,
      turnId: currentTurn.id,
      generationToken: current.generationToken,
      maxSteps: 16,
      modules: () => ({
        memory: { query: async () => [] },
        knowledge: {
          query: async () =>
            items.map((i) => ({
              ...i,
              preview: { title: i.id, summary: makeSummary(itemBytes.value) },
            })),
        },
      }),
    });

    const material = await adapter.read({ signal: new AbortController().signal, observations: [] });
    const limit = adapter.spec.limits.inputUnits;
    if (limit === undefined) throw new Error("missing Web input limit");

    const engine = new ContextEngine();
    const baseUnits = engine.render(adapter.spec, material, [], ["reply"], "stream").units;
    const room = limit - baseUnits;

    // Calibrate itemBytes using the full byte envelope of the observation value
    // { status: "ok", items: [...], nextCursor: ... } matching built-in-actions publish format
    const probeBytes = (count: number) => {
      const entries = items.slice(0, count).map((i) =>
        evidenceCatalogEntry("knowledge", {
          ...i,
          preview: { title: i.id, summary: makeSummary(itemBytes.value) },
        }),
      );
      return (
        engine.render(
          adapter.spec,
          material,
          [
            {
              id: "00000000-0000-0000-0000-000000000000",
              name: "knowledge.query",
              arguments: { query: "fixed" },
              value: {
                status: "ok",
                items: entries,
                nextCursor: count < items.length ? "00000000-0000-0000-0000-000000000001" : null,
              },
              sources: [],
            },
          ],
          ["reply"],
          "stream",
        ).units - baseUnits
      );
    };

    let low = 1;
    let high = 50_000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      itemBytes.value = mid;
      if (probeBytes(2) <= room) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    itemBytes.value = low;

    expect(probeBytes(1)).toBeLessThanOrEqual(room);
    expect(probeBytes(2)).toBeGreaterThan(room);

    gateway.scripted = [
      JSON.stringify({
        kind: "invoke",
        calls: [{ name: "knowledge.query", arguments: { query: "fixed" } }],
      }),
      JSON.stringify({
        kind: "final",
        outputs: [{ kind: "generate", targetId: "reply", instructions: "done" }],
      }),
    ];

    const result = await agentRuntime.run(adapter.spec, {
      owner: {
        kind: "web_turn",
        id: currentTurn.id,
        userId: DEFAULT_USER_ID,
        agentId: runtime.agent_id,
      },
      context: adapter,
      actions: adapter.actions,
      authorizedTargets: ["reply"],
      outputMode: "stream",
      signal: new AbortController().signal,
      requestId: "req-fixed-control",
    });

    expect(result.status).toBe("completed");
    const decisionCall = gateway.completeCalls.at(-1)!;
    const obs = actionObservations(decisionCall).find((o) => o.name === "knowledge.query");
    expect(obs).toBeDefined();
    // In fixed mode, history is never reclaimed; oversized items are trimmed to fitting prefix (1 item)
    expect(obs!.value.status).toBe("ok");
    expect(obs!.value.items.length).toBe(1);
  });

  it("mandatory true overcap is refused even under auto mode when single item exceeds context capacity", async () => {
    const business = runtimeFixtureBusiness(openBusinessDb(), MODEL);
    handles.push(business);
    ensureDefaults(business.orm, MODEL);
    const gateway = new DynamicAdmissionGateway(16384);
    const orm = business.orm;
    const sessionId = createSession(orm, "true-overcap", { modelName: MODEL }).id;

    completedTurn(orm, sessionId, "oc1", 5);
    const current = prepareTurn(orm, sessionId, "超限问题", "current-overcap");
    if (!current.generationToken) throw new Error("missing token");
    const currentTurn = getTurnByRequest(orm, sessionId, "current-overcap")!;

    const base = current.runtime;
    const runtime: RuntimeConfig = {
      ...base,
      p5_config: {
        ...base.p5_config,
        context_window: 16384,
        max_output_tokens: 2048,
        safety_margin_ratio: 0.1,
        retrieval_mode: "standard",
        compression_enabled: false,
        recent_turns: 1,
        allocation: { mode: "auto" },
      },
    };
    if (!runtime.knowledge_read) throw new Error("missing knowledge_read");
    runtime.knowledge_read = { ...runtime.knowledge_read, budget: 1_000_000 };

    // Single item alone is 200,000 bytes > 16384 context window! True overcap.
    const massiveItem = {
      id: "giant1",
      text: "body",
      sources: [],
      preview: { title: "giant1", summary: makeSummary(200_000) },
    };

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
      generationToken: current.generationToken,
      maxSteps: 16,
      modules: () => ({
        memory: { query: async () => [] },
        knowledge: { query: async () => [massiveItem] },
      }),
    });

    gateway.scripted = [
      JSON.stringify({
        kind: "invoke",
        calls: [{ name: "knowledge.query", arguments: { query: "giant" } }],
      }),
      JSON.stringify({
        kind: "final",
        outputs: [{ kind: "generate", targetId: "reply", instructions: "done" }],
      }),
    ];

    const result = await agentRuntime.run(adapter.spec, {
      owner: {
        kind: "web_turn",
        id: currentTurn.id,
        userId: DEFAULT_USER_ID,
        agentId: runtime.agent_id,
      },
      context: adapter,
      actions: adapter.actions,
      authorizedTargets: ["reply"],
      outputMode: "stream",
      signal: new AbortController().signal,
      requestId: "req-true-overcap",
    });

    expect(result.status).toBe("completed");
    const decisionCall = gateway.completeCalls.at(-1)!;
    const obs = actionObservations(decisionCall).find((o) => o.name === "knowledge.query");
    expect(obs).toBeDefined();
    // True overcap must refuse with CONTEXT_BUDGET_EXCEEDED
    expect(obs!.value.status).toBe("unavailable");
    expect(obs!.value.code).toBe("CONTEXT_BUDGET_EXCEEDED");
  });
  it("Web byte mode (no-counter): auto history reclaim admits query items within domain quota instead of starving query budget to un-reclaimed room", async () => {
    const business = runtimeFixtureBusiness(openBusinessDb(), MODEL);
    handles.push(business);
    ensureDefaults(business.orm, MODEL);
    const gateway = new DynamicAdmissionGateway(65536);
    const orm = business.orm;
    const sessionId = createSession(orm, "web-byte-auto", { modelName: MODEL }).id;

    for (let i = 1; i <= 4; i++) {
      completedTurn(orm, sessionId, `b${i}`, 25);
    }
    const current = prepareTurn(orm, sessionId, "查询知识库字节自动模式", "current-byte-token");
    if (!current.generationToken) throw new Error("missing token");
    const currentTurn = getTurnByRequest(orm, sessionId, "current-byte-token")!;

    const base = current.runtime;
    const runtime: RuntimeConfig = {
      ...base,
      p5_config: {
        ...base.p5_config,
        context_window: 50000,
        max_output_tokens: 4096,
        safety_margin_ratio: 0.1,
        retrieval_mode: "standard",
        compression_enabled: false,
        recent_turns: 1,
        allocation: { mode: "auto" },
      },
    };
    if (!runtime.knowledge_read) throw new Error("missing knowledge_read");
    runtime.knowledge_read = { ...runtime.knowledge_read, budget: 1_000_000 };

    const agentRuntime = createAgentRuntime({
      gateway,
      repository: new AgentRunRepository(business.db),
    });

    const itemBytes = { value: 0 };
    const items = [
      { id: "k1", text: "body", sources: [], preview: { title: "k1", summary: "" } },
      { id: "k2", text: "body", sources: [], preview: { title: "k2", summary: "" } },
    ];

    let probeBytes: (count: number) => number;

    const builder = new ContextBuilder({ orm, db: business.db, gateway });
    const adapter = new WebContextSource({
      db: business.db,
      orm,
      gateway,
      agentRuntime,
      builder,
      runtime,
      sessionId,
      turnId: currentTurn.id,
      generationToken: current.generationToken,
      maxSteps: 16,
      modules: () => ({
        memory: { query: async () => [] },
        knowledge: {
          query: async (input: { budget: number }) => {
            const candidates = items.map((i) => ({
              ...i,
              preview: { title: i.id, summary: makeSummary(itemBytes.value) },
            }));
            let fittingCount = 0;
            for (let count = 1; count <= candidates.length; count++) {
              if (probeBytes(count) <= input.budget) {
                fittingCount = count;
              } else {
                break;
              }
            }
            if (fittingCount === 0) {
              return { status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED", items: [] };
            }
            return {
              status: "ok",
              items: candidates.slice(0, fittingCount),
              nextCursor:
                fittingCount < candidates.length ? "00000000-0000-0000-0000-000000000001" : null,
            };
          },
        },
      }),
    });

    const material = await adapter.read({ signal: new AbortController().signal, observations: [] });
    const limit = adapter.spec.limits.inputUnits;
    if (limit === undefined) throw new Error("missing Web input limit");

    const engine = new ContextEngine();
    const baseUnits = engine.render(adapter.spec, material, [], ["reply"], "stream").units;
    const room = limit - baseUnits;

    // Verify initial whole base before query fits comfortably within the limit
    expect(baseUnits).toBeLessThanOrEqual(limit);

    probeBytes = (count: number) => {
      const entries = items.slice(0, count).map((i) =>
        evidenceCatalogEntry("knowledge", {
          ...i,
          preview: { title: i.id, summary: makeSummary(itemBytes.value) },
        }),
      );
      return (
        engine.render(
          adapter.spec,
          material,
          [
            {
              id: "00000000-0000-0000-0000-000000000000",
              name: "knowledge.query",
              arguments: { query: "byte-auto" },
              value: {
                status: "ok",
                items: entries,
                nextCursor: count < items.length ? "00000000-0000-0000-0000-000000000001" : null,
              },
              sources: [],
            },
          ],
          ["reply"],
          "stream",
        ).units - baseUnits
      );
    };

    const MARGIN = 64;
    let low = 1;
    let high = 50_000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      itemBytes.value = mid;
      if (probeBytes(2) <= room + MARGIN) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    itemBytes.value = low;

    expect(probeBytes(1)).toBeLessThanOrEqual(room - MARGIN);
    expect(probeBytes(2)).toBeGreaterThan(room + MARGIN);

    // Prove that after legal history reclaim, both items fit comfortably under the same ceiling:
    const reselect = builder.reselectFor(currentTurn.id, runtime.agent_id);
    expect(reselect).toBeDefined();
    const proposal = reselect!(({ historyTurnIds, summaryIds }) => ({
      historyTurnIds: historyTurnIds.slice(1),
      summaryIds,
    }));
    expect(proposal).not.toBeNull();
    const nonSystem = proposal!.messages.filter((m) => m.role !== "system");
    const asChannel = (m: (typeof nonSystem)[number]) =>
      textMessage(m.role === "assistant" ? "assistant" : "user", m.content);
    const reclaimedMaterial = {
      ...material,
      sources: proposal!.sources,
      history: nonSystem.slice(0, -1).map(asChannel),
      pending: nonSystem.slice(-1).map(asChannel),
    };
    const reclaimedUnits = engine.render(
      adapter.spec,
      reclaimedMaterial,
      [
        {
          id: "00000000-0000-0000-0000-000000000000",
          name: "knowledge.query",
          arguments: { query: "byte-auto" },
          value: {
            status: "ok",
            items: items.map((i) =>
              evidenceCatalogEntry("knowledge", {
                ...i,
                preview: { title: i.id, summary: makeSummary(itemBytes.value) },
              }),
            ),
            nextCursor: null,
          },
          sources: [],
        },
      ],
      ["reply"],
      "stream",
    ).units;
    expect(reclaimedUnits).toBeLessThanOrEqual(limit - MARGIN);

    gateway.scripted = [
      JSON.stringify({
        kind: "invoke",
        calls: [{ name: "knowledge.query", arguments: { query: "byte-auto" } }],
      }),
      JSON.stringify({
        kind: "final",
        outputs: [{ kind: "generate", targetId: "reply", instructions: "done" }],
      }),
    ];

    const result = await agentRuntime.run(adapter.spec, {
      owner: {
        kind: "web_turn",
        id: currentTurn.id,
        userId: DEFAULT_USER_ID,
        agentId: runtime.agent_id,
      },
      context: adapter,
      actions: adapter.actions,
      authorizedTargets: ["reply"],
      outputMode: "stream",
      signal: new AbortController().signal,
      requestId: "req-byte-auto",
    });

    expect(result.status).toBe("completed");
    const decisionCall = gateway.completeCalls.at(-1)!;
    const obs = actionObservations(decisionCall).find((o) => o.name === "knowledge.query");
    expect(obs).toBeDefined();
    // Under auto allocation, history reclaim should allow admitting both items within domain quota.
    // On current source, query budget is starved to un-reclaimed room, so obs.value only gets 1 item instead of both.
    expect(obs!.value.status).toBe("ok");
    expect(obs!.value.items.map((i) => i.id)).toEqual(["k1", "k2"]);
  });

  for (const declaredCounter of [false, true]) {
    it(`Web ${declaredCounter ? "declared token" : "byte"} admission prices the sent observation without dropping internal grants`, async () => {
      const business = runtimeFixtureBusiness(openBusinessDb(), MODEL);
      handles.push(business);
      ensureDefaults(business.orm, MODEL);
      const counter = declaredCounter
        ? { encoding: "o200k_base" as const, count: (text: string) => [...text].length }
        : undefined;
      const gateway = new DynamicAdmissionGateway(65536, counter);
      const sessionId = createSession(business.orm, "authority-model-view", {
        modelName: MODEL,
      }).id;
      const current = prepareTurn(
        business.orm,
        sessionId,
        "Read the supplied source",
        `authority-${declaredCounter}`,
      );
      if (!current.generationToken) throw new Error("missing generation token");
      const turn = getTurnByRequest(business.orm, sessionId, `authority-${declaredCounter}`)!;
      const runtime: RuntimeConfig = {
        ...current.runtime,
        p5_config: {
          ...current.runtime.p5_config,
          context_window: 65536,
          max_output_tokens: 4096,
          safety_margin_ratio: 0.1,
          compression_enabled: false,
          allocation: { mode: "auto" },
        },
      };
      if (!runtime.knowledge_read) throw new Error("missing knowledge rule");
      const grant = {
        kind: "knowledge_grant",
        id: "synthetic-document-grant",
        revision: "g".repeat(4096),
      };
      const origin = {
        kind: "future_document_source",
        id: "document-source",
        revision: "content-1",
      };
      const sourceChecks: string[] = [];
      let live = true;
      const agentRuntime = createAgentRuntime({
        gateway,
        repository: new AgentRunRepository(business.db),
      });
      const source = new WebContextSource({
        db: business.db,
        orm: business.orm,
        gateway,
        agentRuntime,
        builder: new ContextBuilder({ orm: business.orm, db: business.db, gateway }),
        runtime,
        sessionId,
        turnId: turn.id,
        generationToken: current.generationToken,
        maxSteps: 16,
        resolveSource: (ref) => {
          sourceChecks.push(ref.kind);
          if (ref.kind === grant.kind && ref.id === grant.id) return live ? "available" : "revoked";
          return ref.kind === origin.kind ? "available" : undefined;
        },
        modules: () => ({
          memory: { query: async () => [] },
          knowledge: {
            query: async () => [
              {
                id: "document-item",
                text: "Original source text",
                sources: [grant, origin],
                preview: { title: "Document", summary: "Source-supported summary" },
              },
            ],
          },
        }),
      });
      gateway.scripted = [
        '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"source"}}',
        '{"kind":"final","outputs":[{"kind":"generate","targetId":"reply","instructions":"Use the result"}]}',
      ];
      const contexts: import("../../src/server/agent/context-engine").RenderedContext[] = [];
      const result = await agentRuntime.run(source.spec, {
        owner: {
          kind: "web_turn",
          id: turn.id,
          userId: DEFAULT_USER_ID,
          agentId: runtime.agent_id,
        },
        context: source,
        actions: source.actions,
        authorizedTargets: ["reply"],
        outputMode: "stream",
        onContext(context) {
          contexts.push(structuredClone(context));
        },
      });
      expect(result.status).toBe("completed");
      expect(gateway.completeCalls).toHaveLength(2);
      const call = gateway.completeCalls[1];
      const observationMessage = call.messages.find((message) => {
        if (typeof message.content !== "string") return false;
        try {
          return JSON.parse(message.content).kind === "action_observation";
        } catch {
          return false;
        }
      });
      if (typeof observationMessage?.content !== "string")
        throw new Error("missing actual observation");
      const observation = JSON.parse(observationMessage.content).value;
      expect(observation.value.items).toHaveLength(1);
      expect(observation.sources).toEqual([origin]);
      const internal = contexts.find((context) =>
        context.sources.some((ref) => ref.id === grant.id),
      );
      if (!internal) throw new Error("missing internal grant");
      expect(internal.sources).toContainEqual(grant);
      expect(sourceChecks).toContain(grant.kind);
      const actualBytes = new TextEncoder().encode(JSON.stringify(call.messages)).length;
      const withGrant = call.messages.map((message) =>
        message !== observationMessage
          ? message
          : {
              ...message,
              content: JSON.stringify({
                ...JSON.parse(observationMessage.content as string),
                value: { ...observation, sources: [grant, origin] },
              }),
            },
      );
      expect(actualBytes).toBeLessThan(new TextEncoder().encode(JSON.stringify(withGrant)).length);
      const prepared = await gateway.prepareContextModel(MODEL);
      const format = gateway.prepareRequestFormat({
        model: MODEL,
        responseSchema: call.responseSchema,
        tools: call.tools,
      });
      expect(internal.messages).toEqual(
        call.messages.map((message) =>
          textMessage(
            message.role === "assistant"
              ? "assistant"
              : message.role === "system"
                ? "system"
                : "user",
            typeof message.content === "string" ? message.content : "",
          ),
        ),
      );
      const finalMeasure = measurePreparedRequest(internal.messages, prepared, format);
      if (declaredCounter) {
        expect(finalMeasure?.textTokens).toBe(internal.tokenMeasure?.textTokens);
      } else {
        expect(internal.tokenMeasure).toBeUndefined();
      }
      expect(source.spec.limits.inputUnits).toBeDefined();
      if (declaredCounter) {
        expect(internal.tokenMeasure?.textTokens).toBeLessThanOrEqual(
          source.spec.limits.inputUnits!,
        );
      } else {
        expect(internal.units).toBeLessThanOrEqual(source.spec.limits.inputUnits!);
      }
      live = false;
      expect(() => source.assertSources([grant])).toThrow();
    });
  }
});
