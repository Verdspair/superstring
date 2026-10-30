import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { conversationRoutes } from "../../src/server/api/conversations";
import { handleError } from "../../src/server/api/error-handler";
import {
  type ConversationChange,
  subscribeConversationChanges,
} from "../../src/server/conversation/conversation-changes";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { createSession, DEFAULT_AGENT_ID, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { parseSseFrames } from "../harness/sse";

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
    expect(changes).toEqual([
      { conversationId: conversation.id, seq: 2, bindingEpoch: 1, kind: "content" },
    ]);
    expect(Object.keys(changes[0]!).sort()).toEqual([
      "bindingEpoch",
      "conversationId",
      "kind",
      "seq",
    ]);
    unsubscribe();
    appendFixture(journal, conversation.id, 3);
    await tick();
    expect(changes).toHaveLength(1);
  });

  it("opens with ready, streams conversation_changed and unsubscribes on client abort", async () => {
    const { session, journal, app } = setup();
    await tick();
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

  it("streams a live session creation and a subsequent append after ready", async () => {
    const { business, journal, app } = setup();
    await tick();
    const controller = new AbortController();
    const response = await app.request("/v2/conversations/changes", {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      expect(parseSseFrames(decoder.decode((await reader.read()).value!))).toEqual([
        { event: "ready", data: { ready: true } },
      ]);
      const session = createSession(business.orm, "live creation", { modelName: "fixture" });
      const conversation = business.db
        .query(
          "SELECT id FROM conversations WHERE channel='web' AND source_id=? AND closed_at IS NULL",
        )
        .get(session.id) as { id: string } | null;
      expect(conversation).not.toBeNull();
      expect(parseSseFrames(decoder.decode((await reader.read()).value!))).toEqual([
        {
          event: "conversation_changed",
          data: { conversationId: conversation!.id, seq: 0, bindingEpoch: 1 },
        },
      ]);
      appendFixture(journal, conversation!.id, 1);
      expect(parseSseFrames(decoder.decode((await reader.read()).value!))).toEqual([
        {
          event: "conversation_changed",
          data: { conversationId: conversation!.id, seq: 1, bindingEpoch: 1 },
        },
      ]);
    } finally {
      controller.abort();
      await reader.cancel();
    }
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
      { conversationId: first.id, seq: 0, bindingEpoch: 1, kind: "content" },
      { conversationId: rebound.id, seq: 0, bindingEpoch: 2, kind: "content" },
    ]);
    unsubscribe();
  });

  it("delivers shared conversations when the app includes shared scope", async () => {
    const { business, journal, app } = setup(true);
    await tick();
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

  it("coalesces 1000 separate same-conversation hints while paused and retains a distinct conversation", async () => {
    const { business, session, journal, app } = setup();
    const first = journal.ensureWeb(session.id)!;
    const secondSession = createSession(business.orm, "other", { modelName: "fixture" });
    const second = journal.ensureWeb(secondSession.id)!;
    await tick();
    const abort = new AbortController();
    const response = await app.request("/v2/conversations/changes", { signal: abort.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (let n = 1; n <= 1000; n++) {
        appendFixture(journal, first.id, n);
        // Separate hub flushes, not one already-coalesced publisher burst.
        await Promise.resolve();
      }
      appendFixture(journal, second.id, 1001);
      await Promise.resolve();
      expect(parseSseFrames(decoder.decode((await reader.read()).value))).toEqual([
        { event: "ready", data: { ready: true } },
      ]);
      const seen: Array<{ conversationId: string; seq: number; bindingEpoch: number }> = [];
      while (!seen.some((change) => change.conversationId === second.id)) {
        const frames = parseSseFrames(decoder.decode((await reader.read()).value));
        for (const frame of frames) seen.push(frame.data as (typeof seen)[number]);
      }
      expect(seen.filter((change) => change.conversationId === first.id).at(-1)).toEqual({
        conversationId: first.id,
        seq: 1000,
        bindingEpoch: 1,
      });
      expect(seen.at(-1)).toEqual({ conversationId: second.id, seq: 1, bindingEpoch: 1 });
      expect(seen.length).toBeLessThanOrEqual(3);
    } finally {
      abort.abort();
      await reader.cancel();
    }
    appendFixture(journal, first.id, 1002);
    await tick();
  });

  it.each(["reader_cancel", "request_abort"] as const)(
    "disconnects %s before ready without a late change",
    async (ending) => {
      const { session, journal, app } = setup();
      const conversation = journal.ensureWeb(session.id)!;
      await tick();
      const abort = new AbortController();
      const response = await app.request("/v2/conversations/changes", { signal: abort.signal });
      const reader = response.body!.getReader();
      appendFixture(journal, conversation.id, 1);
      await Promise.resolve();
      if (ending === "reader_cancel") await reader.cancel();
      else {
        abort.abort();
        expect(parseSseFrames(new TextDecoder().decode((await reader.read()).value))).toEqual([
          { event: "ready", data: { ready: true } },
        ]);
        expect((await reader.read()).done).toBe(true);
      }
      appendFixture(journal, conversation.id, 2);
      await tick();
    },
  );

  it("keeps the latest complete epoch tuple under the same projected history id", async () => {
    const { business, session, journal, app } = setup();
    const first = journal.ensureWeb(session.id)!;
    appendFixture(journal, first.id, 1);
    await tick();
    const abort = new AbortController();
    const response = await app.request("/v2/conversations/changes", { signal: abort.signal });
    const reader = response.body!.getReader();
    try {
      appendFixture(journal, first.id, 2);
      await Promise.resolve();
      const otherAgentId = crypto.randomUUID();
      business.orm
        .insert(schema.agents)
        .values({
          id: otherAgentId,
          name: "epoch fixture",
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
      journal.ensureWeb(session.id);
      await Promise.resolve();
      business.db
        .query("UPDATE sessions SET agent_id=? WHERE id=?")
        .run(DEFAULT_AGENT_ID, session.id);
      const returned = journal.ensureWeb(session.id)!;
      appendFixture(journal, returned.id, 3);
      await Promise.resolve();
      const expected = journal.historySummary(returned.id)!;
      expect(expected.id).toBe(first.id);
      expect(expected.bindingEpoch).toBe(3);
      const decoder = new TextDecoder();
      expect(parseSseFrames(decoder.decode((await reader.read()).value))[0]?.event).toBe("ready");
      let latest: unknown;
      // A blocked hint, the distinct B history, and the latest A epoch can each be sent.
      for (let i = 0; i < 3; i++) {
        const frames = parseSseFrames(decoder.decode((await reader.read()).value));
        latest = frames.at(-1)?.data;
        if ((latest as { bindingEpoch?: number })?.bindingEpoch === 3) break;
      }
      expect(latest).toEqual({
        conversationId: expected.id,
        seq: expected.lastSeq,
        bindingEpoch: 3,
      });
    } finally {
      abort.abort();
      await reader.cancel();
    }
  });

  it("emits one content and one span-activity entry per conversation, coalescing a burst", async () => {
    const { business, session, journal } = setup();
    const { publishConversationActivity } = await import(
      "../../src/server/conversation/conversation-changes"
    );
    const changes: ConversationChange[] = [];
    const unsubscribe = subscribeConversationChanges(business.db, (change) => changes.push(change));
    const conversation = journal.ensureWeb(session.id)!;
    await tick();
    changes.length = 0;
    publishConversationActivity(business.db, conversation.id);
    publishConversationActivity(business.db, conversation.id);
    appendFixture(journal, conversation.id, 1);
    appendFixture(journal, conversation.id, 2);
    publishConversationActivity(business.db, conversation.id);
    await tick();
    expect(changes).toHaveLength(2);
    const byKind = new Map(changes.map((change) => [change.kind, change]));
    expect(byKind.get("content")).toEqual({
      conversationId: conversation.id,
      seq: 2,
      bindingEpoch: 1,
      kind: "content",
    });
    expect(byKind.get("activity")).toEqual({
      conversationId: conversation.id,
      seq: 2,
      bindingEpoch: 1,
      kind: "activity",
      activity: "span",
    });
    unsubscribe();
  });

  it("streams span activity as conversation_activity_changed under the same visibility guard", async () => {
    const { business, session, journal, app } = setup();
    const { publishConversationActivity } = await import(
      "../../src/server/conversation/conversation-changes"
    );
    const scheme = createQqScheme(business.orm, { name: "activity fixture" });
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
    const shared = journal.ensureOneBot(bindingId)!;
    const controller = new AbortController();
    const response = await app.request("/v2/conversations/changes", {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(parseSseFrames(decoder.decode((await reader.read()).value!))).toEqual([
      { event: "ready", data: { ready: true } },
    ]);
    const web = journal.ensureWeb(session.id)!;
    const { publishConversationChange } = await import(
      "../../src/server/conversation/conversation-changes"
    );
    publishConversationChange(business.db, web.id);
    await tick();
    expect(parseSseFrames(decoder.decode((await reader.read()).value!))).toEqual([
      { event: "conversation_changed", data: { conversationId: web.id, seq: 0, bindingEpoch: 1 } },
    ]);
    publishConversationActivity(business.db, web.id);
    expect(parseSseFrames(decoder.decode((await reader.read()).value!))).toEqual([
      {
        event: "conversation_activity_changed",
        data: { conversationId: web.id, seq: 0, bindingEpoch: 1, activity: "span" },
      },
    ]);
    // The same principal/visibility guard applies; shared activity must not leak.
    publishConversationActivity(business.db, shared.id);
    appendFixture(journal, web.id, 1);
    const frames: ReturnType<typeof parseSseFrames> = [];
    while (!frames.some((frame) => frame.event === "conversation_changed")) {
      frames.push(...parseSseFrames(decoder.decode((await reader.read()).value!)));
    }
    const leaked = frames.filter(
      (frame) => (frame.data as { conversationId?: string } | null)?.conversationId === shared.id,
    );
    expect(leaked).toHaveLength(0);
    controller.abort();
  });

  it("projects only authorized history metadata for each stream subscriber", async () => {
    const { business, session } = setup();
    const queries: string[] = [];
    const { publishConversationActivity } = await import(
      "../../src/server/conversation/conversation-changes"
    );
    const db = new Proxy(business.db, {
      get(target, key) {
        if (key === "query")
          return (sql: string) => {
            queries.push(sql);
            return target.query(sql);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const journal = new ConversationEventRepository(db);
    const first = journal.ensureWeb(session.id)!;
    appendFixture(journal, first.id, 1);
    let currentId = first.id;
    for (let epoch = 2; epoch <= 3; epoch++) {
      const previousId = currentId;
      currentId = crypto.randomUUID();
      db.query("UPDATE conversations SET closed_at=? WHERE id=?").run(nowIso(), previousId);
      db.query(`INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,binding_epoch,created_at,updated_at,source_watermark)
        SELECT ?,channel,topology,source_id,agent_id,user_id,?,created_at,updated_at,source_watermark FROM conversations WHERE id=?`).run(
        currentId,
        epoch,
        previousId,
      );
      appendFixture(journal, currentId, epoch);
    }
    await tick();
    const full = journal.historySummary(currentId)!;
    const expected = {
      conversationId: full.id,
      seq: full.lastSeq,
      bindingEpoch: full.bindingEpoch,
      activity: "span",
    };
    const app = new Hono().route("/v2/conversations", conversationRoutes(db));
    const abort = new AbortController();
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      for (let subscriber = 0; subscriber < 2; subscriber++) {
        const response = await app.request("/v2/conversations/changes", { signal: abort.signal });
        const reader = response.body!.getReader();
        readers.push(reader);
        expect(
          parseSseFrames(new TextDecoder().decode((await reader.read()).value))[0]?.event,
        ).toBe("ready");
      }
      queries.length = 0;
      for (let span = 0; span < 1000; span++) publishConversationActivity(db, currentId);
      await tick();
      for (const reader of readers)
        expect(parseSseFrames(new TextDecoder().decode((await reader.read()).value))).toEqual([
          { event: "conversation_activity_changed", data: expected },
        ]);
      expect(
        queries.filter((query) => /SELECT (?:title|name) FROM (?:sessions|agents)/i.test(query)),
      ).toEqual([]);
      expect(queries.length).toBeLessThanOrEqual(7);
      expect(journal.historySummary(currentId)).toEqual(full);
    } finally {
      abort.abort();
      for (const reader of readers) await reader.cancel();
    }
  });

  it.each(["closed", "foreign_user", "missing_session", "different_agent"] as const)(
    "does not stream metadata for a %s history",
    async (denied) => {
      const { business, session, journal, app } = setup();
      const target = journal.ensureWeb(session.id)!;
      const sentinelSession = createSession(business.orm, "visible sentinel", {
        modelName: "fixture",
      });
      const sentinel = journal.ensureWeb(sentinelSession.id)!;
      await tick();
      if (denied === "closed")
        business.db
          .query("UPDATE conversations SET closed_at=? WHERE id=?")
          .run(nowIso(), target.id);
      else if (denied === "missing_session")
        business.db.query("DELETE FROM sessions WHERE id=?").run(session.id);
      else if (denied === "foreign_user") {
        const foreign = crypto.randomUUID();
        business.orm
          .insert(schema.users)
          .values({ id: foreign, name: "foreign", createdAt: nowIso() })
          .run();
        business.db.query("UPDATE conversations SET user_id=? WHERE id=?").run(foreign, target.id);
      } else {
        const otherAgent = crypto.randomUUID();
        business.orm
          .insert(schema.agents)
          .values({
            id: otherAgent,
            name: "other assistant",
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
        business.db.query("UPDATE sessions SET agent_id=? WHERE id=?").run(otherAgent, session.id);
      }
      const abort = new AbortController();
      const response = await app.request("/v2/conversations/changes", { signal: abort.signal });
      const reader = response.body!.getReader();
      try {
        expect(
          parseSseFrames(new TextDecoder().decode((await reader.read()).value))[0]?.event,
        ).toBe("ready");
        const { publishConversationActivity } = await import(
          "../../src/server/conversation/conversation-changes"
        );
        publishConversationActivity(business.db, target.id);
        appendFixture(journal, sentinel.id, 1);
        const frames = parseSseFrames(new TextDecoder().decode((await reader.read()).value));
        expect(frames).toEqual([
          {
            event: "conversation_changed",
            data: {
              conversationId: sentinel.id,
              seq: 1,
              bindingEpoch: 1,
            },
          },
        ]);
      } finally {
        abort.abort();
        await reader.cancel();
      }
    },
  );

  it.each(["missing_binding", "missing_agent"] as const)(
    "does not stream QQ metadata after %s",
    async (denied) => {
      const { business, session, journal, app } = setup(true);
      const scheme = createQqScheme(business.orm, { name: "metadata scope" });
      const agentId = crypto.randomUUID();
      business.orm
        .insert(schema.agents)
        .values({
          id: agentId,
          name: "QQ assistant",
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
      const bindingId = crypto.randomUUID();
      business.orm
        .insert(schema.qqBindings)
        .values({
          id: bindingId,
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId,
          schemeId: scheme.id,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        .run();
      const target = journal.ensureOneBot(bindingId)!;
      const sentinel = journal.ensureWeb(session.id)!;
      await tick();
      if (denied === "missing_binding")
        business.db.query("DELETE FROM qq_bindings WHERE id=?").run(bindingId);
      else business.db.query("DELETE FROM agents WHERE id=?").run(agentId);
      const abort = new AbortController();
      const response = await app.request("/v2/conversations/changes", { signal: abort.signal });
      const reader = response.body!.getReader();
      try {
        expect(
          parseSseFrames(new TextDecoder().decode((await reader.read()).value))[0]?.event,
        ).toBe("ready");
        const { publishConversationActivity } = await import(
          "../../src/server/conversation/conversation-changes"
        );
        publishConversationActivity(business.db, target.id);
        appendFixture(journal, sentinel.id, 1);
        expect(parseSseFrames(new TextDecoder().decode((await reader.read()).value))).toEqual([
          {
            event: "conversation_changed",
            data: { conversationId: sentinel.id, seq: 1, bindingEpoch: 1 },
          },
        ]);
      } finally {
        abort.abort();
        await reader.cancel();
      }
    },
  );

  it("exports one shared union for content and span-only activity", async () => {
    const shared = (await import("../../src/shared/contracts/conversation")) as unknown as {
      ConversationChangeEventSchema?: {
        parse(value: unknown): { event: string; activity?: string };
      };
    };
    const schema = shared.ConversationChangeEventSchema;
    expect(typeof schema?.parse).toBe("function");
    expect(
      schema!.parse({
        event: "conversation_changed",
        conversationId: "c",
        seq: 1,
        bindingEpoch: 1,
      }),
    ).toMatchObject({ event: "conversation_changed", seq: 1 });
    expect(
      schema!.parse({
        event: "conversation_activity_changed",
        conversationId: "c",
        seq: 1,
        bindingEpoch: 1,
        activity: "span",
      }),
    ).toMatchObject({ event: "conversation_activity_changed", activity: "span" });
    expect(() =>
      schema!.parse({
        event: "conversation_activity_changed",
        conversationId: "c",
        seq: 1,
        bindingEpoch: 1,
        activity: "run",
      }),
    ).toThrow();
  });
});
