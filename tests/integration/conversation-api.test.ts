import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { sourceAccess } from "../../src/server/agent/context-access";
import { conversationRoutes } from "../../src/server/api/conversations";
import { deliveryRoutes } from "../../src/server/api/deliveries";
import { handleError } from "../../src/server/api/error-handler";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  deleteMessage,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import {
  ConversationEventsSchema,
  ConversationListSchema,
  DeliverySchema,
} from "../../src/shared/contracts/conversation";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function setup(includeShared = false) {
  const business = openBusinessDb();
  handles.push(business);
  const session = createSession(business.orm, "canonical", { modelName: "fixture" });
  const journal = new ConversationEventRepository(business.db);
  const app = new Hono()
    .onError(handleError)
    .route("/v2/conversations", conversationRoutes(business.db, { includeShared }))
    .route("/v2/deliveries", deliveryRoutes(business.db, { includeShared }));
  return { business, session, journal, app };
}

describe("canonical conversation read APIs", () => {
  it("discovers empty Web and shared sources, paginates their canonical IDs and reflects source edits", async () => {
    const { app, business, session } = setup(true);
    const another = createSession(business.orm, "never opened", { modelName: "fixture" });
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
    const pages = [];
    let cursor: string | null = null;
    do {
      const page = ConversationListSchema.parse(
        await (
          await app.request(`/v2/conversations?limit=1${cursor ? `&cursor=${cursor}` : ""}`)
        ).json(),
      );
      pages.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(pages.map((item) => item.sourceId))).toEqual(
      new Set([session.id, another.id, bindingId]),
    );
    const group = pages.find((item) => item.sourceId === bindingId)!;
    expect(group.topology).toBe("shared");
    expect(group.participants).toEqual([
      { id: DEFAULT_AGENT_ID, label: group.participants[0].label, role: "agent" },
    ]);
    expect((await app.request(`/v2/conversations/${group.id}/events`)).status).toBe(200);
    business.db
      .query("UPDATE sessions SET title='renamed',updated_at='2099-01-01T00:00:00.000Z' WHERE id=?")
      .run(another.id);
    const updated = ConversationListSchema.parse(
      await (await app.request("/v2/conversations")).json(),
    );
    expect(updated.items[0]).toMatchObject({ sourceId: another.id, title: "renamed" });
    expect(updated.items[0].id).toBe(pages.find((item) => item.sourceId === another.id)!.id);
    expect(business.db.query("SELECT COUNT(*) AS n FROM agent_runs").get()).toEqual({ n: 0 });
  });

  it("projects current wake state and only links an actually associated run", async () => {
    const { app, business, session, journal } = setup(true);
    const conversation = journal.ensureWeb(session.id)!;
    const now = nowIso();
    const wakes = new WakeRepository(business.db);
    const wake = wakes.enqueue({
      conversationId: conversation.id,
      cause: "fixture",
      throughSeq: 0,
      dedupeKey: "fixture",
      priority: 0,
      readyAt: now,
    });
    journal.append({
      conversationId: conversation.id,
      eventKey: `wake:${wake.id}`,
      kind: "wake",
      source: { kind: "wake", id: wake.id, revision: "1" },
      occurredAt: now,
    });
    const read = async () =>
      ConversationEventsSchema.parse(
        await (await app.request(`/v2/conversations/${conversation.id}/events`)).json(),
      ).items[0];
    expect(await read()).toMatchObject({
      wake: { status: "pending", cause: "fixture" },
      runId: null,
    });
    const runId = crypto.randomUUID();
    new AgentRunRepository(business.db).createRun({
      runId,
      specId: "fixture",
      specVersion: "1",
      owner: {
        kind: "conversation",
        id: conversation.id,
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      },
      at: now,
    });
    business.db
      .query("UPDATE agent_runs SET wake_id=?,conversation_id=? WHERE run_id=?")
      .run(wake.id, conversation.id, runId);
    business.db.query("UPDATE wake_signals SET status='no_output' WHERE id=?").run(wake.id);
    expect(await read()).toMatchObject({ wake: { status: "no_output" }, runId, text: null });
  });
  it("resolves a Web session before the first send and preserves that identity", async () => {
    const { app, session } = setup();
    const url = `/v2/conversations?channel=web&sourceId=${session.id}`;
    const first = await app.request(url);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const body = ConversationListSchema.parse(await first.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      sourceId: session.id,
      topology: "direct",
      channel: "web",
      lastSeq: 0,
    });
    expect((await (await app.request(url)).json()).items[0].id).toBe(body.items[0].id);
    expect((await app.request("/v2/conversations?cursor=not-json")).status).toBe(422);
    expect((await app.request("/v2/conversations?limit=0")).status).toBe(422);
    expect((await app.request("/v2/conversations?channel=invalid")).status).toBe(422);
  });

  it("advances across source tombstones without returning deleted conversation text", async () => {
    const { app, business, session, journal } = setup();
    const prepared = prepareTurn(business.orm, session.id, "original user", "request");
    if (!prepared.generationToken) throw new Error("Missing fixture lease");
    saveCompletedAssistantMessage(
      business.orm,
      session.id,
      "original assistant",
      "request",
      prepared.generationToken,
    );
    journal.backfill();
    const conversation = journal.ensureWeb(session.id);
    if (!conversation) throw new Error("Missing conversation");
    const first = ConversationEventsSchema.parse(
      await (await app.request(`/v2/conversations/${conversation.id}/events?limit=1`)).json(),
    );
    expect(first.items.map((e) => e.text)).toEqual(["original user"]);
    expect(first.hasMore).toBe(true);
    const second = ConversationEventsSchema.parse(
      await (
        await app.request(`/v2/conversations/${conversation.id}/events?afterSeq=${first.nextSeq}`)
      ).json(),
    );
    expect(second.items.map((e) => e.text)).toEqual(["original assistant"]);
    const userMessage = business.db
      .query("SELECT id FROM messages WHERE session_id=? AND role='user'")
      .get(session.id) as { id: string };
    deleteMessage(business.orm, session.id, userMessage.id);
    const redacted = ConversationEventsSchema.parse(
      await (await app.request(`/v2/conversations/${conversation.id}/events`)).json(),
    );
    expect(redacted.items.map((e) => ({ text: e.text, contentState: e.contentState }))).toEqual([
      { text: null, contentState: "revoked" },
      { text: "original assistant", contentState: "active" },
    ]);
    expect(redacted.nextSeq).toBe(second.nextSeq);
    expect(
      (await app.request(`/v2/conversations/${conversation.id}/events?afterSeq=-1`)).status,
    ).toBe(422);
  });

  it("hides retired and deleted source conversations even when their IDs are known", async () => {
    const { app, business, session, journal } = setup();
    const conversation = journal.ensureWeb(session.id);
    if (!conversation) throw new Error("Missing conversation");
    business.db
      .query("UPDATE conversations SET closed_at=? WHERE id=?")
      .run(nowIso(), conversation.id);
    expect((await app.request(`/v2/conversations/${conversation.id}`)).status).toBe(404);
    expect((await app.request(`/v2/conversations/${conversation.id}/events`)).status).toBe(404);
    const next = journal.ensureWeb(session.id);
    if (!next) throw new Error("Missing current conversation");
    business.db.query("DELETE FROM sessions WHERE id=?").run(session.id);
    expect((await app.request(`/v2/conversations/${next.id}`)).status).toBe(404);
  });

  it("returns per-part delivery metadata without exposing payloads, and hides unbound records", async () => {
    const { app, business, journal } = setup();
    updateQqSettings(business.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
    const scheme = createQqScheme(business.orm, { name: "fixture" });
    const bindingId = crypto.randomUUID();
    const now = nowIso();
    business.orm
      .insert(schema.qqBindings)
      .values({
        id: bindingId,
        accountId: "10001",
        conversationKind: "private",
        peerId: "20002",
        agentId: DEFAULT_AGENT_ID,
        schemeId: scheme.id,
        paused: 0,
        shareWebMemory: 0,
        revision: 1,
        authorityRevision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const conversation = journal.ensureOneBot(bindingId);
    if (!conversation) throw new Error("Missing conversation");
    const runId = crypto.randomUUID();
    new AgentRunRepository(business.db).createRun({
      runId,
      specId: "conversation",
      specVersion: "1",
      owner: {
        kind: "qq_binding",
        id: bindingId,
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      },
      at: now,
    });
    const outbox = new OutboundIntentRepository(business.db);
    const intent = outbox.commit({
      runId,
      conversationId: conversation.id,
      ordinal: 0,
      target: {
        accountId: "10001",
        conversationKind: "private",
        peerId: "20002",
        agentId: DEFAULT_AGENT_ID,
        bindingId,
        bindingEpoch: conversation.bindingEpoch,
      },
      speechKind: "direct_reply",
      sourceThroughSeq: 0,
      createdAt: now,
      deliverBy: now,
      expiresAt: "2099-01-01T00:00:00.000Z",
      parts: [{ kind: "text", text: "private outgoing body" }],
    });
    const response = await app.request(`/v2/deliveries/${intent.id}`);
    const text = await response.text();
    expect(text).not.toContain("private outgoing body");
    const parsed = DeliverySchema.parse(JSON.parse(text));
    expect(parsed.parts[0].status).toBe("planned");
    expect(parsed.target).toEqual({ peerId: "20002", participantId: null });
    expect(
      (await (await app.request(`/v2/deliveries?conversationId=${conversation.id}`)).json()).items,
    ).toHaveLength(1);
    const part = outbox.claimPart(intent.id, now);
    if (!part) throw new Error("Missing planned part");
    outbox.settlePart(part.part.id, { status: "confirmed", messageId: "receipt" }, now);
    const source = {
      kind: "outbound_intent",
      id: intent.id,
      revision: createHash("sha256").update("private outgoing body").digest("hex"),
    };
    const owner = {
      kind: "conversation",
      id: conversation.id,
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    };
    expect(sourceAccess(business.db, source, owner, { userId: DEFAULT_USER_ID }, now)).toBe(
      "available",
    );
    business.db.query("DELETE FROM qq_bindings WHERE id=?").run(bindingId);
    expect(sourceAccess(business.db, source, owner, { userId: DEFAULT_USER_ID }, now)).toBe(
      "revoked",
    );
    expect((await app.request(`/v2/deliveries/${intent.id}`)).status).toBe(404);
  });
});
