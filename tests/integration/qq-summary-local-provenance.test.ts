import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { sourceAccess } from "../../src/server/agent/context-access";
import type { CompressionRecord } from "../../src/server/agent/conversation-compression";
import { createBotCompressionJob } from "../../src/server/channels/onebot11/background-compression";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { contextDumps } from "../../src/server/db/json-text";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import { readQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  compactQqSummaryRecordId,
  readQqConversationSummary,
  resolveQqSummaryProvenance,
} from "../../src/server/db/qq-summary-repository";
import { DEFAULT_AGENT_ID, DEFAULT_USER_ID, getAgentRow } from "../../src/server/db/repositories";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { captureQqTask } from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

afterEach(closeHarnesses);
const TARGET = 2048;
const TEXT = "保留金额123、原条件与否定，不增加事实。";
function facts(ids: readonly string[]) {
  return Array.from({ length: 4 }, (_, index) => ({
    kind: "fact" as const,
    speaker: "20002",
    text: TEXT.repeat(2),
    source_ids: ids.slice(index * 10, (index + 1) * 10),
  }));
}

describe("QQ summary local provenance", () => {
  it("publishes complete facts and all forty source groups within the unchanged whole JSON cap", async () => {
    const h = createOneBotHarness();
    for (let index = 0; index < 40; index++)
      h.receive({ id: String(90000 + index), text: `synthetic source ${index}`, speaker: "20002" });
    const owner = {
      kind: "conversation",
      id: h.conversationId,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
    };
    const rows = h.db
      .query(`SELECT e.event_key AS id,t.body AS body,t.expires_at AS expiresAt,
      ce.seq AS seq FROM qq_events e JOIN qq_observation_text t ON t.event_key=e.event_key
      JOIN conversation_events ce ON ce.source_id=e.event_key AND ce.source_kind='qq_event'
      WHERE ce.conversation_id=? ORDER BY ce.seq`)
      .all(h.conversationId) as { id: string; body: string; expiresAt: string; seq: number }[];
    expect(rows).toHaveLength(40);
    const records: CompressionRecord[] = rows.map((row) => {
      const revision = new Bun.CryptoHasher("sha256").update(row.body).digest("hex");
      const source: SourceRef = {
        kind: "qq_observation",
        id: row.id,
        revision,
        expiresAt: row.expiresAt,
      };
      return {
        id: contextDumps([[source.kind, source.id, source.revision]]),
        seq: row.seq,
        speaker: "20002",
        text: row.body,
        sources: [source],
      };
    });
    const oldFacts = facts(records.map((record) => compactQqSummaryRecordId(record.id)));
    expect(Buffer.byteLength(contextDumps({ facts: oldFacts }))).toBeGreaterThan(TARGET);
    const calls: Parameters<ModelGateway["complete"]>[0][] = [];
    const gateway: ModelGateway = {
      config: { baseUrl: "http://unused.invalid", model: "synthetic", timeoutSeconds: 5 },
      async listModels() {
        return ["synthetic"];
      },
      async probeModelLoaded() {
        return true;
      },
      async loadedContextCapacity() {
        return 65536;
      },
      async complete(request) {
        calls.push(request);
        const text = request.messages?.[1]?.content;
        if (typeof text !== "string") throw new Error("text request missing");
        const data = JSON.parse(text) as { events: { id: string }[] };
        return JSON.stringify({ facts: facts(data.events.map((event) => event.id)) });
      },
      async *streamChat() {
        yield "unused";
      },
    };
    const agent = getAgentRow(h.orm, DEFAULT_AGENT_ID);
    if (!agent) throw new Error("synthetic agent missing");
    const runtime = runtimeFromAgent(agent);
    const job = createBotCompressionJob({
      orm: h.orm,
      gateway,
      runtime,
      owner,
      conversationId: h.conversationId,
      agentId: DEFAULT_AGENT_ID,
      agentRuntime: createAgentRuntime({ gateway, repository: new AgentRunRepository(h.db) }),
      expected: null,
      records,
      throughSeq: Math.max(...rows.map((row) => row.seq)),
      coveredSeq: Math.max(...rows.map((row) => row.seq)),
      recordSeconds: rows.map(() => h.clock.seconds),
      sources: [],
      target: TARGET,
      packageLimit: 4,
      task: "Preserve all supplied source associations.",
      assertCurrent() {},
      now: h.now,
      assertSources(sources) {
        for (const source of sources)
          expect(sourceAccess(h.db, source, owner, { userId: DEFAULT_USER_ID }, h.now())).toBe(
            "available",
          );
      },
      onFailure(code) {
        throw new Error(code);
      },
    });
    await expect(job.run(new AbortController().signal)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxTokens).toBe(TARGET);
    const stored = readQqConversationSummary(h.orm, h.conversationId, DEFAULT_AGENT_ID);
    if (!stored) throw new Error("summary not published");
    expect(stored.packages).toHaveLength(1);
    const pkg = stored.packages[0]!;
    expect(Buffer.byteLength(contextDumps({ facts: pkg.facts }))).toBeLessThanOrEqual(TARGET);
    expect(pkg.sources).toHaveLength(40);
    expect(Object.keys(pkg.provenance ?? {})).toHaveLength(40);
    const resolved = resolveQqSummaryProvenance(pkg);
    expect(resolved).toEqual(facts(records.map((record) => record.id)));
    expect(stored.throughSeq).toBe(Math.max(...rows.map((row) => row.seq)));
    const binding = readQqBinding(h.orm, h.bindingId);
    const scheme = readQqScheme(h.orm, h.scheme.id);
    if (!binding || !scheme) throw new Error("synthetic config missing");
    const snapshot = captureQqTask(binding, "reply");
    if (snapshot.kind !== "captured") throw new Error("synthetic snapshot missing");
    runtime.p5_config.recent_turns = 1;
    const spec = {
      id: "test.summary.local",
      context: "conversation" as const,
      model: "synthetic",
      instructions: "Read source-bound facts.",
      availableActions: [],
      limits: { steps: 4 },
    };
    const source = new BotContextSource({
      db: h.db,
      orm: h.orm,
      gateway,
      runtime,
      spec,
      binding,
      scheme,
      agentRuntime: createAgentRuntime({ gateway, repository: new AgentRunRepository(h.db) }),
      journal: h.journal,
      outbox: h.outbox,
      conversationId: h.conversationId,
      snapshot: snapshot.snapshot,
      path: "direct_reply",
      decisionTier: "reply",
      targets: () => [{ id: "20002", speakerId: "20002" }],
      assertCurrent() {},
      now: h.now,
    });
    const actionContext = {
      owner,
      runId: "synthetic-summary-reader",
      signal: new AbortController().signal,
    };
    source.bindRun(actionContext);
    const material = await source.read({ signal: actionContext.signal, observations: [] });
    const packageMessage = material.history
      ?.flatMap((message) => message.content)
      .find((part) => part.kind === "text" && part.text.includes('"kind":"qq_context_packages"'));
    if (packageMessage?.kind !== "text") throw new Error("initial package projection missing");
    const initial = JSON.parse(packageMessage.text) as { packages: { facts: unknown }[] };
    expect(initial.packages[0]?.facts).toEqual(pkg.facts);
    const query = source.actions.find((action) => action.description.name === "summary.query");
    const read = source.actions.find((action) => action.description.name === "summary.read");
    if (!query || !read) throw new Error("summary tools missing");
    const catalog = await query.execute({ query: "", limit: 1 }, actionContext);
    const item = (catalog.value as { items: { bodyRef: string }[] }).items[0];
    if (!item) throw new Error("summary catalog item missing");
    const page = await read.execute(
      { bodyRef: item.bodyRef, offset: 0, limit: 4096 },
      actionContext,
    );
    const text = (page.value as { items: { text: string }[] }).items[0]?.text;
    if (!text) throw new Error("summary body missing");
    expect(JSON.parse(text)).toEqual(pkg.facts);
    expect(page.sources.filter((ref) => ref.kind === "qq_observation")).toHaveLength(40);
  });

  it("validates a local map completely while retaining strict existing hash and raw formats", () => {
    const source: SourceRef = {
      kind: "qq_observation",
      id: "synthetic-event",
      revision: "revision",
    };
    const raw = contextDumps([[source.kind, source.id, source.revision]]);
    const fact = { kind: "fact" as const, speaker: "20002", text: "x", source_ids: ["s0"] };
    const local = { facts: [fact], sources: [source], provenance: { s0: raw } };
    expect(resolveQqSummaryProvenance(local)).toEqual([{ ...fact, source_ids: [raw] }]);
    expect(() => resolveQqSummaryProvenance({ ...local, provenance: {} })).toThrow();
    expect(() =>
      resolveQqSummaryProvenance({ ...local, provenance: { s0: raw, s1: raw } }),
    ).toThrow();
    expect(() =>
      resolveQqSummaryProvenance({
        ...local,
        provenance: { s0: contextDumps([[source.kind, "foreign", source.revision]]) },
      }),
    ).toThrow();
    const hash = compactQqSummaryRecordId(raw);
    const hashed = {
      facts: [{ ...fact, source_ids: [hash] }],
      sources: [source],
      provenance: { [hash]: raw },
    };
    expect(resolveQqSummaryProvenance(hashed)).toEqual([{ ...fact, source_ids: [raw] }]);
    expect(() =>
      resolveQqSummaryProvenance({
        ...hashed,
        provenance: { [hash]: contextDumps([[source.kind, "foreign", source.revision]]) },
      }),
    ).toThrow();
    expect(
      resolveQqSummaryProvenance({ facts: [{ ...fact, source_ids: [raw] }], sources: [source] }),
    ).toEqual([{ ...fact, source_ids: [raw] }]);
  });
});

it("allows more than one hundred overlapping source groups without inventing a group cap", () => {
  const sources: SourceRef[] = Array.from({ length: 7 }, (_, index) => ({
    kind: "qq_observation",
    id: `source-${index}`,
    revision: "r",
  }));
  const provenance: Record<string, string> = {};
  const ids: string[] = [];
  for (let mask = 1; mask <= 101; mask++) {
    const id = `s${(mask - 1).toString(36)}`;
    ids.push(id);
    provenance[id] = contextDumps(
      sources
        .filter((_, index) => mask & (1 << index))
        .map((source) => [source.kind, source.id, source.revision]),
    );
  }
  const decoded = resolveQqSummaryProvenance({
    facts: [{ kind: "fact", speaker: "20002", text: "overlapping groups", source_ids: ids }],
    sources,
    provenance,
  });
  expect(decoded[0]?.source_ids).toEqual(ids.map((id) => provenance[id]!));
});
