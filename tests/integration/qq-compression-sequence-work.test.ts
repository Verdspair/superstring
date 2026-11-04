import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import {
  BotContextSource,
  type BotContextSourceOptions,
} from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, getAgentRow } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import {
  QQ_CONTEXT_DEFAULT,
  type QqContextMessage,
} from "../../src/server/services/qq-context-contract";
import { QQ_MEDIA_RULE } from "../../src/server/services/qq-prompt-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import { QQ_ALLOCATION_DEFAULT } from "../../src/shared/contracts/context-allocation";
import {
  QQ_COMPRESSION_DEFAULT,
  QQ_MODEL_OUTPUT_RESERVE_DEFAULT,
} from "../../src/shared/contracts/qq";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
function setup(
  input: {
    decisionTier?: "judgement" | "reply";
    disabled?: boolean;
    watermarkTrigger?: number;
  } = {},
) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  const seconds = Math.floor(Date.now() / 1000),
    now = new Date(seconds * 1000).toISOString();
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "context",
    context: { ...QQ_CONTEXT_DEFAULT },
    compression: {
      ...QQ_COMPRESSION_DEFAULT,
      ...(input.watermarkTrigger ? { watermark_trigger: input.watermarkTrigger } : {}),
    },
    outputReserve: { ...QQ_MODEL_OUTPUT_RESERVE_DEFAULT },
    allocation: structuredClone(QQ_ALLOCATION_DEFAULT),
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
  const binding = insertQqBinding(h.orm, created.binding);
  const capture = captureQqTask(binding, "reply");
  if (capture.kind !== "captured") throw new Error("snapshot");
  const row = getAgentRow(h.orm, DEFAULT_AGENT_ID);
  if (!row) throw new Error("agent");
  const runtime = runtimeFromAgent(row);
  runtime.p5_config.max_output_tokens = 4096;
  runtime.p5_config.summary_max_tokens = 4096;
  runtime.p5_config.allocation = { mode: "fixed" };
  delete runtime.p5_config.memory_read;
  runtime.p5_config.retrieval_mode = "off";
  runtime.p5_config.compression_enabled = !input.disabled;
  runtime.p5_config.recent_turns = 1;
  const journal = new ConversationEventRepository(h.db),
    outbox = new OutboundIntentRepository(h.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation");
  const calls: Parameters<ModelGateway["complete"]>[0][] = [];
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "reply-model", timeoutSeconds: 1 },
    listModels: async () => [],
    probeModelLoaded: async () => true,
    loadedContextCapacity: async () => 65536,
    async complete(request) {
      calls.push(request);
      const first = request.messages?.[1]?.content;
      if (typeof first !== "string") throw new Error("text content expected");
      const data = JSON.parse(first);
      if (data.events)
        return JSON.stringify({
          facts: [
            ...(data.previous_overview?.facts ?? []),
            ...data.events.map((event: { id: string; speaker: string }) => ({
              kind: "fact",
              speaker: event.speaker,
              text: "old fact",
              source_ids: [event.id],
            })),
          ],
        });
      return JSON.stringify({
        ids: data.candidates.map((candidate: { id: string }) => candidate.id),
      });
    },
    async *streamChat() {
      yield "unused";
    },
  };
  const runs = new AgentRunRepository(h.db),
    agentRuntime = createAgentRuntime({ gateway, repository: runs });
  const spec: AgentSpec = {
    id: "test.bot",
    model: input.decisionTier === "judgement" ? "judge-model" : "reply-model",
    context: "conversation",
    instructions: QQ_MEDIA_RULE,
    availableActions: [],
    limits: { steps: 16 },
  };
  const diagnostics: unknown[] = [];
  const buildSource = (overrides: Partial<BotContextSourceOptions> = {}) =>
    new BotContextSource({
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
      decisionTier: input.decisionTier ?? "reply",
      targets: () => [
        { id: "alice", speakerId: "20002" },
        { id: "bob", speakerId: "20003" },
      ],
      assertCurrent() {},
      now: () => now,
      onDiagnostic: (event) => diagnostics.push(event),
      ...overrides,
    });
  const source = buildSource();
  spec.availableActions = source.actions.map((action) => action.description);
  const seed = (text: string, age = 0, peer = "30003") => {
    const id = crypto.randomUUID();
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey: id,
        accountId: "10001",
        conversationKind: "group",
        peerId: peer,
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
    if (peer === "30003") journal.ingestOneBotEvent(id, binding.id);
    return id;
  };
  return { ...h, source, journal, conversation, seed, now, seconds, calls };
}

type SequenceAccess = {
  compressionSequences(messages: readonly QqContextMessage[]): (number | null)[];
};
const sequence = (source: BotContextSource, messages: readonly QqContextMessage[]) =>
  (source as unknown as SequenceAccess).compressionSequences(messages);
const message = (sources: QqContextMessage["sources"]): QqContextMessage => ({
  occurredAtSeconds: 1,
  speaker: "assistant",
  speakerId: null,
  text: "synthetic",
  mediaNotes: [],
  mediaUnread: 0,
  sources,
});

function trackSql(h: ReturnType<typeof setup>) {
  const original = h.db.query;
  const originalPrepare = h.db.prepare;
  const calls: { sql: string; args: unknown[] }[] = [];
  const wrap = (sql: string, statement: ReturnType<typeof h.db.query>) =>
    new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "all" || key === "get" || key === "values")
          return (...parameters: unknown[]) => {
            calls.push({ sql, args: parameters });
            return Reflect.apply(value, target, parameters);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  h.db.query = ((sql: string, ...args: unknown[]) =>
    wrap(sql, Reflect.apply(original, h.db, [sql, ...args]))) as typeof h.db.query;
  h.db.prepare = ((sql: string, ...args: unknown[]) =>
    wrap(sql, Reflect.apply(originalPrepare, h.db, [sql, ...args]))) as typeof h.db.prepare;
  return {
    calls,
    restore: () => {
      h.db.query = original;
      h.db.prepare = originalPrepare;
    },
  };
}

describe("QQ compression journal sequence work", () => {
  it("keeps the earliest secondary speech association, including duplicates", () => {
    const h = setup();
    const send = recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      sentAtSeconds: h.seconds,
      text: "synthetic send",
      parts: [{ kind: "text", result: "confirmed", messageId: "synthetic-receipt" }],
    }).log;
    h.journal.backfill();
    const alias = h.journal
      .eventsAfter(h.conversation.id, 0, 100)
      .items.find((e) => e.eventKey === `send:${send.id}`);
    if (!alias) throw new Error("backfill did not produce send alias");
    const speech = alias.sources.find((ref) => ref.kind === "qq_speech");
    expect(alias.source.kind).toBe("qq_send");
    if (!speech) throw new Error("backfill did not associate speech");
    const direct = h.journal.append({
      conversationId: h.conversation.id,
      eventKey: `direct:${speech.id}`,
      kind: "outbound",
      source: speech,
      occurredAt: h.now,
      recordedAt: h.now,
    });
    expect(direct.seq).toBeGreaterThan(alias.seq);
    const duplicateSource = { kind: "fixture", id: `duplicate:${speech.id}`, revision: "1" };
    const duplicate = h.journal.append({
      conversationId: h.conversation.id,
      eventKey: `duplicate:${speech.id}`,
      kind: "outbound",
      source: duplicateSource,
      sources: [duplicateSource, speech, speech],
      occurredAt: h.now,
      recordedAt: h.now,
    });
    expect(duplicate.seq).toBeGreaterThan(direct.seq);
    expect(
      sequence(h.source, [
        message([speech]),
        message([speech, speech]),
        message([alias.source, speech]),
        message([]),
      ]),
    ).toEqual([alias.seq, alias.seq, alias.seq, null]);
  });

  it("preserves generic secondary associations, including an earlier qq_event reference", () => {
    const h = setup();
    const primary = { kind: "fixture", id: "generic-carrier", revision: "1" };
    const secondary = { kind: "custom_provenance", id: "generic-target", revision: "old" };
    const eventKey = crypto.randomUUID();
    const eventRef = { kind: "qq_event", id: eventKey, revision: "1" };
    const earliest = h.journal.append({
      conversationId: h.conversation.id,
      eventKey: "generic-carrier",
      kind: "inbound",
      source: primary,
      sources: [primary, secondary, secondary, eventRef],
      occurredAt: h.now,
      recordedAt: h.now,
    });
    const direct = h.journal.append({
      conversationId: h.conversation.id,
      eventKey: "generic-direct",
      kind: "inbound",
      source: secondary,
      occurredAt: h.now,
      recordedAt: h.now,
    });
    const eventDirect = h.journal.append({
      conversationId: h.conversation.id,
      eventKey: "event-direct",
      kind: "inbound",
      source: eventRef,
      occurredAt: h.now,
      recordedAt: h.now,
    });
    expect(direct.seq).toBeGreaterThan(earliest.seq);
    expect(eventDirect.seq).toBeGreaterThan(earliest.seq);
    expect(
      sequence(h.source, [
        message([secondary]),
        message([secondary, secondary]),
        message([eventRef]),
      ]),
    ).toEqual([earliest.seq, earliest.seq, earliest.seq]);
  });

  it("avoids preparing buffer records when a cold reply is below the watermark", async () => {
    const h = setup({ watermarkTrigger: 2 });
    const old = h.seed("old buffer", 31000);
    h.seed("current selected");
    const trace = trackSql(h);
    try {
      const material = await h.source.read({
        signal: new AbortController().signal,
        observations: [],
      });
      expect(JSON.stringify(material.history)).toContain("current selected");
      expect(JSON.stringify(material.history)).not.toContain("old buffer");
      expect(h.source.takeCompressionJob()).toBeUndefined();
      const sequenceReads = trace.calls.filter(({ sql }) =>
        /json_each\s*\(\s*e\.sources\s*\)/i.test(sql),
      );
      expect(sequenceReads).toHaveLength(1);
      const bufferProjectionReads = trace.calls.filter(
        ({ sql, args }) =>
          /\bqq_message_facts\b/i.test(sql) &&
          args.some((value) => typeof value === "string" && value.includes(old)),
      );
      expect(bufferProjectionReads).toEqual([]);
    } finally {
      trace.restore();
    }
  });

  it("still prepares and commits the original records when the watermark fills", async () => {
    const h = setup({ watermarkTrigger: 2 });
    h.seed("old first", 31000);
    h.seed("old second", 30000);
    h.seed("current selected");
    const material = await h.source.read({
      signal: new AbortController().signal,
      observations: [],
    });
    expect(JSON.stringify(material.history)).toContain("current selected");
    const job = h.source.takeCompressionJob();
    if (!job) throw new Error("expected watermark compression job");
    await job.run(new AbortController().signal);
    const row = h.orm.select().from(schema.qqConversationSummaries).get();
    if (!row) throw new Error("expected compression summary");
    expect(row.throughSeq).toBe(2);
    expect(row.coveredSeq).toBe(2);
    const call = h.calls.find((entry) =>
      entry.messages?.some(
        (message) => typeof message.content === "string" && message.content.includes("old first"),
      ),
    );
    expect(call).toBeDefined();
    expect(JSON.stringify(call?.messages)).toContain("old second");
    expect(JSON.stringify(call?.messages)).not.toContain("current selected");
  });

  it("does not read compression tables on disabled or judgement reads", async () => {
    for (const options of [{ disabled: true }, { decisionTier: "judgement" as const }]) {
      const h = setup(options);
      h.seed("current");
      const trace = trackSql(h);
      try {
        await h.source.read({ signal: new AbortController().signal, observations: [] });
        expect(
          trace.calls.filter(({ sql }) =>
            /qq_conversation_summaries|json_each\s*\(\s*e\.sources\s*\)/i.test(sql),
          ),
        ).toEqual([]);
      } finally {
        trace.restore();
      }
    }
  });
});
