import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { ActionObservation } from "../../src/server/agent/context-engine";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { recordQqMessageFact } from "../../src/server/db/qq-message-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import { QQ_CONTEXT_DEFAULT } from "../../src/server/services/qq-context-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import {
  QQ_COMPRESSION_DEFAULT,
  QQ_MESSAGE_SETTINGS_SCHEME_DEFAULT,
} from "../../src/shared/contracts/qq";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function setup() {
  const handle = openBusinessDb();
  handles.push(handle);
  const { db, orm } = handle;
  ensureDefaults(orm, "reply-model");
  updateQqSettings(orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(orm, {
    name: "reply-disclosure",
    context: { ...QQ_CONTEXT_DEFAULT, reply_token_budget: 16384 },
    messageSettings: { ...QQ_MESSAGE_SETTINGS_SCHEME_DEFAULT, reply_mode: "configured_depth" },
    compression: { ...QQ_COMPRESSION_DEFAULT },
  });
  const bindingDraft = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (bindingDraft.kind !== "saved") throw new Error("binding fixture");
  const binding = insertQqBinding(orm, bindingDraft.binding);
  const captured = captureQqTask(binding, "reply");
  if (captured.kind !== "captured") throw new Error("binding snapshot fixture");
  const row = getAgentRow(orm, DEFAULT_AGENT_ID);
  if (!row) throw new Error("agent fixture");
  const runtime = runtimeFromAgent(row);
  runtime.p5_config.retrieval_mode = "off";
  runtime.p5_config.recent_turns = 10;
  const journal = new ConversationEventRepository(db);
  const outbox = new OutboundIntentRepository(db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation fixture");
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "reply-model", timeoutSeconds: 1 },
    listModels: async () => [],
    probeModelLoaded: async () => true,
    loadedContextCapacity: async () => 65536,
    complete: async () => {
      throw new Error("unused model fixture");
    },
    async *streamChat() {
      yield "unused";
    },
  };
  const agentRuntime = createAgentRuntime({ gateway, repository: new AgentRunRepository(db) });
  const spec: AgentSpec = {
    id: "test.qq.reply-disclosure",
    model: "reply-model",
    context: "conversation",
    instructions: "test",
    availableActions: [],
    limits: { steps: 16 },
  };
  const source = new BotContextSource({
    ...handle,
    gateway,
    agentRuntime,
    journal,
    outbox,
    conversationId: conversation.id,
    binding,
    snapshot: captured.snapshot,
    scheme,
    runtime,
    spec,
    path: "direct_reply",
    decisionTier: "reply",
    targets: () => [{ id: "target", speakerId: "20002" }],
    assertCurrent() {},
    now: () => "2026-10-08T06:00:00.000Z",
  });
  const seed = (
    id: string,
    platformId: string,
    text: string,
    replyToMessageId: string | null = null,
  ) => {
    const occurredAtSeconds = 2_000_000_000;
    orm
      .insert(schema.qqEvents)
      .values({
        eventKey: id,
        accountId: binding.accountId,
        conversationKind: binding.kind,
        peerId: binding.peerId,
        agentId: binding.agentId,
        messageId: platformId,
        occurredAtSeconds,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: "2026-10-08T06:00:00.000Z",
      })
      .run();
    orm
      .insert(schema.qqObservationText)
      .values({
        eventKey: id,
        body: text,
        occurredAtSeconds,
        expiresAt: "2026-10-09T06:00:00.000Z",
        recordedAt: "2026-10-08T06:00:00.000Z",
      })
      .run();
    recordQqMessageFact(orm, {
      eventKey: id,
      groupCard: "Member",
      groupCardSource: "wire",
      personalNickname: null,
      personalNicknameSource: null,
      legacyDisplayName: null,
      nameState: "known",
      parts: [{ kind: "text", text }],
      replyToMessageId,
      occurredAtSeconds,
    });
    journal.ingestOneBotEvent(id, binding.id);
    return {
      id,
      platformId,
      sources: [
        { kind: "qq_observation", id, revision: "1", expiresAt: "2026-10-09T06:00:00.000Z" },
      ],
    };
  };
  return { source, seed, binding, conversation, db, orm };
}

async function readView(source: BotContextSource) {
  return source.read({ signal: new AbortController().signal, observations: [] });
}

function expectSourceInvalid(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect((error as { code?: string }).code).toBe("CONTEXT_SOURCE_INVALID");
    return;
  }
  throw new Error("expected an invalid or undisclosed source to be rejected");
}

describe("QQ reply and mention source disclosure", () => {
  it("resolves only facts actually rendered into the current model view", async () => {
    const fixture = setup();
    const old = fixture.seed("event-old", "-101", "older message");
    const shown = fixture.seed("event-shown", "-102", "current message");
    const material = await readView(fixture.source);
    expect(
      material.pending?.some((message) =>
        message.content.some(
          (part) => part.kind === "text" && part.text.includes("current message"),
        ),
      ),
    ).toBe(true);
    expect(fixture.source.resolveReplyToMessage(shown.platformId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "qq_message_fact", id: shown.id }),
        expect.objectContaining({ kind: "qq_observation", id: shown.id }),
      ]),
    );
    expect(fixture.source.resolveReplyToMessage(old.platformId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "qq_message_fact", id: old.id })]),
    );
    const pending = material.pending;
    const olderFactsMessage = pending?.find((message) =>
      message.content.some((part) => part.kind === "text" && part.text.includes("older message")),
    );
    expect(olderFactsMessage).toBeDefined();
    if (!pending || !olderFactsMessage)
      throw new Error("expected the rendered older-facts message");
    const writablePending = pending as unknown as typeof pending & {
      splice(start: number, count: number): void;
    };
    writablePending.splice(pending.indexOf(olderFactsMessage), 1);
    expectSourceInvalid(() => fixture.source.resolveReplyToMessage(old.platformId));
  });

  it("grants a history source only after a successful scoped history.read body observation", async () => {
    const fixture = setup();
    const seeded = fixture.seed("event-history", "-301", "historical raw body");
    const context = {
      owner: {
        kind: "qq_binding",
        id: fixture.binding.id,
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      },
      runId: "test-run-history-read",
      signal: new AbortController().signal,
    };
    fixture.source.bindRun(context);
    const query = fixture.source.actions.find(
      (action) => action.description.name === "history.query",
    );
    const read = fixture.source.actions.find(
      (action) => action.description.name === "history.read",
    );
    if (!query || !read) throw new Error("history actions missing");
    const found = await query.execute({ query: "historical raw body" }, context);
    const item = (found.value as { items: { id: string; bodyRef: string }[] }).items[0];
    expect(item).toBeDefined();
    const page = await read.execute({ bodyRef: item.bodyRef, limit: 100 }, context);
    expect(page.value).toMatchObject({
      status: "ok",
      items: [{ id: item.id, text: "historical raw body" }],
    });
    await readView(fixture.source);
    const queryObservation: ActionObservation = {
      id: "history-query-observation",
      name: "history.query",
      value: found.value,
      sources: found.sources,
    };
    const queryView = await fixture.source.read({
      signal: new AbortController().signal,
      observations: [queryObservation],
    });
    const queryFacts = queryView.pending?.find((message) =>
      message.content.some(
        (part) => part.kind === "text" && part.text.includes("qq_message_facts"),
      ),
    );
    if (!queryView.pending || !queryFacts) throw new Error("expected current facts message");
    const writableQueryPending = queryView.pending as unknown as typeof queryView.pending & {
      splice(start: number, count: number): void;
    };
    writableQueryPending.splice(queryView.pending.indexOf(queryFacts), 1);
    expectSourceInvalid(() => fixture.source.resolveReplyToMessage(seeded.platformId));
    const observation: ActionObservation = {
      id: "history-read-observation",
      name: "history.read",
      value: page.value,
      sources: page.sources,
    };
    const withRead = await fixture.source.read({
      signal: new AbortController().signal,
      observations: [observation],
    });
    const refs = fixture.source.resolveReplyToMessage(seeded.platformId);
    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation_evidence",
          revision: page.sources.find((ref) => ref.kind === "conversation_evidence")?.revision,
        }),
      ]),
    );
    const invalidated = refs.map((ref) => ({ ...ref, revision: "stale-original-revision" }));
    try {
      await fixture.source.read({
        signal: new AbortController().signal,
        observations: [{ ...observation, sources: invalidated }],
      });
    } catch (error) {
      expect((error as { code?: string }).code).toBe("CONTEXT_SOURCE_INVALID");
    }
    expectSourceInvalid(() => fixture.source.resolveReplyToMessage(seeded.platformId));
    expect(withRead).toBeDefined();
  });

  it("accepts only numeric members from disclosed facts or the explicit authorized targets", async () => {
    const fixture = setup();
    fixture.seed("event-member", "-201", "member message");
    await readView(fixture.source);
    expect(fixture.source.resolveMentionIds(["20002", "20003"], ["20003"])).toEqual([
      "20002",
      "20003",
    ]);
    for (const ids of [["99999"], ["all"], ["20x"], ["+20002"]])
      expectSourceInvalid(() => fixture.source.resolveMentionIds(ids, ["20003"]));
    fixture.db
      .query("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?")
      .run("2026-10-08T05:59:00.000Z", "event-member");
    expectSourceInvalid(() => fixture.source.resolveMentionIds(["20002"], []));
  });
});
