import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { conversationRoutes } from "../../src/server/api/conversations";
import { handleError } from "../../src/server/api/error-handler";
import { parseSseFrames } from "../../src/server/api/sse";
import {
  type ConversationChange,
  subscribeConversationChanges,
} from "../../src/server/conversation/conversation-changes";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { createSession, DEFAULT_AGENT_ID, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

/** Lets the deferred post-commit flush (a microtask) run before assertions. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(includeShared = false) {
  const business = openBusinessDb();
  handles.push(business);
  const session = createSession(business.orm, "arrival", { modelName: "fixture" });
  const journal = new ConversationEventRepository(business.db);
  const app = new Hono()
    .onError(handleError)
    .route("/v2/conversations", conversationRoutes(business.db, { includeShared }));
  return { business, session, journal, app };
}

const appendFixture = (journal: ConversationEventRepository, conversationId: string, n: number) =>
  journal.append({
    conversationId,
    eventKey: `fixture:${n}`,
    kind: "inbound",
    source: { kind: "fixture", id: String(n), revision: "1" },
    occurredAt: nowIso(),
  });

describe("conversation change notifications", () => {
  it("notifies appends without HTTP, coalesces a burst and carries scope metadata only", async () => {
    const { business, session, journal } = setup();
    const changes: ConversationChange[] = [];
    const unsubscribe = subscribeConversationChanges(business.db, (change) => changes.push(change));
    const conversation = journal.ensureWeb(session.id)!;
    // A different repository instance on the same database shares the same hub.
    const other = new ConversationEventRepository(business.db);
    appendFixture(other, conversation.id, 1);
    appendFixture(journal, conversation.id, 2);
    await tick();
    expect(changes).toEqual([{ conversationId: conversation.id, seq: 2, bindingEpoch: 1 }]);
    expect(Object.keys(changes[0]!).sort()).toEqual(["bindingEpoch", "conversationId", "seq"]);
    unsubscribe();
    appendFixture(journal, conversation.id, 3);
    await tick();
    expect(changes).toHaveLength(1);
  });

  it("opens with ready, streams conversation_changed and unsubscribes on client abort", async () => {
    const { session, journal, app } = setup();
    const controller = new AbortController();
    const response = await app.request("/v2/conversations/changes", {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const ready = await reader.read();
    expect(ready.done).toBe(false);
    expect(parseSseFrames(decoder.decode(ready.value!))).toEqual([
      { event: "ready", data: { ready: true } },
    ]);
    const conversation = journal.ensureWeb(session.id)!;
    appendFixture(journal, conversation.id, 1);
    const change = await reader.read();
    expect(parseSseFrames(decoder.decode(change.value!))).toEqual([
      {
        event: "conversation_changed",
        data: { conversationId: conversation.id, seq: 1, bindingEpoch: 1 },
      },
    ]);
    controller.abort();
    expect((await reader.read()).done).toBe(true);
    // The subscription is gone; late writes must not touch the dead stream.
    appendFixture(journal, conversation.id, 2);
    await tick();
  });

  it("filters shared conversations for the single-user principal", async () => {
    const { business, session, journal, app } = setup(false);
    const scheme = createQqScheme(business.orm, { name: "group fixture" });
    const bindingId = crypto.randomUUID();
    business.orm
      .insert(schema.qqBindings)
      .values({
        id: bindingId,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        schemeId: scheme.id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    const controller = new AbortController();
    const response = await app.request("/v2/conversations/changes", {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(parseSseFrames(decoder.decode((await reader.read()).value!))).toEqual([
      { event: "ready", data: { ready: true } },
    ]);
    const shared = journal.ensureOneBot(bindingId)!;
    expect(shared.topology).toBe("shared");
    const web = journal.ensureWeb(session.id)!;
    // One burst touching both; only the visible conversation reaches the stream.
    await tick();
    const frames = parseSseFrames(decoder.decode((await reader.read()).value!));
    expect(frames).toEqual([
      { event: "conversation_changed", data: { conversationId: web.id, seq: 0, bindingEpoch: 1 } },
    ]);
    const delivered = frames
      .map((frame) => frame.data)
      .filter(
        (data): data is { conversationId: string } =>
          typeof data === "object" && data !== null && "conversationId" in data,
      );
    expect(delivered.some((change) => change.conversationId === shared.id)).toBe(false);
    controller.abort();
  });

  it("publishes the new binding epoch under the successor conversation id", async () => {
    const { business, session, journal } = setup();
    const changes: ConversationChange[] = [];
    const unsubscribe = subscribeConversationChanges(business.db, (change) => changes.push(change));
    const first = journal.ensureWeb(session.id)!;
    const otherAgentId = crypto.randomUUID();
    business.orm
      .insert(schema.agents)
      .values({
        id: otherAgentId,
        name: "successor",
        systemPrompt: "s",
        description: "",
        additionalInstructions: "",
        p5Config: "{}",
        modelName: "fixture",
        memoryConsolidationPrompt: "p",
        memoryConsolidationAdditionalInstructions: "",
        memoryRetrievalPrompt: "p",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    business.db.query("UPDATE sessions SET agent_id=? WHERE id=?").run(otherAgentId, session.id);
    const rebound = journal.ensureWeb(session.id)!;
    expect(rebound.id).not.toBe(first.id);
    await tick();
    expect(changes).toEqual([
      { conversationId: first.id, seq: 0, bindingEpoch: 1 },
      { conversationId: rebound.id, seq: 0, bindingEpoch: 2 },
    ]);
    unsubscribe();
  });

  it("delivers shared conversations when the app includes shared scope", async () => {
    const { business, journal, app } = setup(true);
    const scheme = createQqScheme(business.orm, { name: "group fixture" });
    const bindingId = crypto.randomUUID();
    business.orm
      .insert(schema.qqBindings)
      .values({
        id: bindingId,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        schemeId: scheme.id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    const controller = new AbortController();
    const response = await app.request("/v2/conversations/changes", {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(parseSseFrames(decoder.decode((await reader.read()).value!))).toEqual([
      { event: "ready", data: { ready: true } },
    ]);
    const shared = journal.ensureOneBot(bindingId)!;
    await tick();
    expect(parseSseFrames(decoder.decode((await reader.read()).value!))).toEqual([
      {
        event: "conversation_changed",
        data: { conversationId: shared.id, seq: 0, bindingEpoch: 1 },
      },
    ]);
    controller.abort();
  });
});
