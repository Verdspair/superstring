import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { conversationRoutes } from "../../src/server/api/conversations";
import { publishConversationActivity } from "../../src/server/conversation/conversation-changes";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, DEFAULT_USER_ID, nowIso } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { parseSseFrames } from "../harness/sse";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function setup() {
  const h = openBusinessDb();
  handles.push(h);
  const sessions = Array.from({ length: 4 }, (_, n) =>
    createSession(h.orm, `batch ${n}`, { modelName: "fixture" }),
  );
  const journal = new ConversationEventRepository(h.db);
  const ids = sessions.map((s) => journal.ensureWeb(s.id)!.id);
  const app = new Hono().route("/v2/conversations", conversationRoutes(h.db));
  return { h, journal, sessions, ids, app };
}
function append(journal: ConversationEventRepository, id: string, n: number) {
  journal.append({
    conversationId: id,
    eventKey: `event:${n}`,
    kind: "inbound",
    source: { kind: "fixture", id: String(n), revision: "1" },
    occurredAt: nowIso(),
  });
}
const frames = (value: Uint8Array | undefined) => parseSseFrames(new TextDecoder().decode(value));
describe("conversation notification batch owner", () => {
  it("shares one live metadata query across writable subscribers and keeps content/activity distinct", async () => {
    const { h, journal, ids, app } = setup();
    await tick();
    const abort = new AbortController();
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let n = 0; n < 2; n++) {
      const response = await app.request("/v2/conversations/changes", { signal: abort.signal });
      const reader = response.body!.getReader();
      readers.push(reader);
      expect(frames((await reader.read()).value)).toEqual([
        { event: "ready", data: { ready: true } },
      ]);
    }
    const queries: string[] = [];
    const query = h.db.query.bind(h.db);
    const trace = spyOn(h.db, "query").mockImplementation(((sql: string) => {
      queries.push(sql);
      return query(sql);
    }) as typeof h.db.query);
    try {
      for (const id of ids) {
        append(journal, id, 1);
        publishConversationActivity(h.db, id);
      }
      await tick();
      for (const reader of readers) {
        const delivered = frames((await reader.read()).value);
        expect(delivered).toHaveLength(ids.length * 2);
        expect(delivered.filter((frame) => frame.event === "conversation_changed")).toHaveLength(
          ids.length,
        );
        expect(
          delivered.filter((frame) => frame.event === "conversation_activity_changed"),
        ).toHaveLength(ids.length);
      }
      expect(queries.filter((sql) => sql.startsWith("WITH epochs AS"))).toHaveLength(1);
    } finally {
      trace.mockRestore();
      abort.abort();
      for (const reader of readers) await reader.cancel();
    }
  });

  it("rechecks the subject after backpressure and never sends a revoked pending tuple", async () => {
    const { h, journal, sessions, ids, app } = setup();
    await tick();
    const abort = new AbortController();
    const response = await app.request("/v2/conversations/changes", { signal: abort.signal });
    const reader = response.body!.getReader();
    try {
      expect(frames((await reader.read()).value)[0]?.event).toBe("ready");
      append(journal, ids[0]!, 1);
      await tick(); // The first frame occupies the transport queue.
      append(journal, ids[0]!, 2);
      append(journal, ids[1]!, 1);
      await tick();
      h.db
        .query("DELETE FROM sessions WHERE id=? AND user_id=?")
        .run(sessions[0]!.id, DEFAULT_USER_ID);
      expect(frames((await reader.read()).value)[0]?.data).toMatchObject({
        conversationId: ids[0],
        seq: 1,
      });
      const next = frames((await reader.read()).value);
      expect(next).toEqual([
        {
          event: "conversation_changed",
          data: { conversationId: ids[1], seq: 1, bindingEpoch: 1 },
        },
      ]);
    } finally {
      abort.abort();
      await reader.cancel();
    }
  });
  it("reconnects with ready and releases an aborted subscriber without interrupting its peer", async () => {
    const { journal, ids, app } = setup();
    await tick();
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = (
      await app.request("/v2/conversations/changes", { signal: firstAbort.signal })
    ).body!.getReader();
    const second = (
      await app.request("/v2/conversations/changes", { signal: secondAbort.signal })
    ).body!.getReader();
    expect(frames((await first.read()).value)[0]?.event).toBe("ready");
    expect(frames((await second.read()).value)[0]?.event).toBe("ready");
    firstAbort.abort();
    await first.cancel();
    append(journal, ids[0]!, 1);
    expect(frames((await second.read()).value)).toEqual([
      { event: "conversation_changed", data: { conversationId: ids[0], seq: 1, bindingEpoch: 1 } },
    ]);
    const reconnectedAbort = new AbortController();
    const reconnected = (
      await app.request("/v2/conversations/changes", { signal: reconnectedAbort.signal })
    ).body!.getReader();
    expect(frames((await reconnected.read()).value)).toEqual([
      { event: "ready", data: { ready: true } },
    ]);
    reconnectedAbort.abort();
    secondAbort.abort();
    await reconnected.cancel();
    await second.cancel();
  });
});
