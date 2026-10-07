import { afterEach, describe, expect, it } from "bun:test";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const at = "2026-09-26T01:00:00.000Z";

function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "model");
  const journal = new ConversationEventRepository(h.db);
  const wake = new WakeRepository(h.db);
  const session = createSession(h.orm, "chat", { modelName: "model" });
  return { ...h, journal, wake, session };
}

function onebotConversation(h: ReturnType<typeof setup>, id: string, n: number) {
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(at, at);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'100','private',?,?,'scheme',?,?)",
    )
    .run(id, `200${n}`, DEFAULT_AGENT_ID, at, at);
  return h.journal.ensureOneBot(id)!;
}

describe("wake busy-skip settlement (OFF busy upper bound)", () => {
  it("skipPending settles an unclaimed pending wake to no_output with the reason, without an attempt", () => {
    const h = setup();
    const c = onebotConversation(h, "b1", 1);
    const w = h.wake.enqueue({
      conversationId: c.id,
      cause: "chiming_in",
      throughSeq: 3,
      dedupeKey: "d1",
      readyAt: at,
      priority: 1,
      at,
    });
    expect(w.status).toBe("pending");
    expect(w.attempts).toBe(0);

    expect(h.wake.skipPending(w.id, { at, throughSeq: 5, errorCode: "BATCH_SKIPPED_BUSY" })).toBe(
      true,
    );
    const settled = h.wake.get(w.id)!;
    expect(settled.status).toBe("no_output");
    expect(settled.errorCode).toBe("BATCH_SKIPPED_BUSY");
    expect(settled.attempts).toBe(0);
    expect(settled.leaseToken).toBeNull();
    // The settled row carries the boundary actually skipped and completed_at (row-only).
    expect(
      h.db
        .query("SELECT completed_at AS at, through_seq AS seq FROM wake_signals WHERE id=?")
        .get(w.id),
    ).toEqual({ at, seq: 5 });

    // Settling again is a no-op: the wake is no longer pending.
    expect(h.wake.skipPending(w.id, { at, throughSeq: 5, errorCode: "BATCH_SKIPPED_BUSY" })).toBe(
      false,
    );
  });

  it("skipPending refuses a leased wake and a source boundary behind the wake's own", () => {
    const h = setup();
    const c = onebotConversation(h, "b2", 2);
    const w = h.wake.enqueue({
      conversationId: c.id,
      cause: "chiming_in",
      throughSeq: 7,
      dedupeKey: "d2",
      readyAt: at,
      priority: 1,
      at,
    });
    const claimed = h.wake.claim({ at, leaseMs: 60_000 });
    expect(claimed?.id).toBe(w.id);
    expect(h.wake.skipPending(w.id, { at, throughSeq: 8, errorCode: "BATCH_SKIPPED_BUSY" })).toBe(
      false,
    );
    expect(h.wake.get(w.id)!.status).toBe("leased");

    const w2 = h.wake.enqueue({
      conversationId: c.id,
      cause: "follow_up",
      throughSeq: 4,
      dedupeKey: "d3",
      readyAt: at,
      priority: 1,
      at,
    });
    expect(() =>
      h.wake.skipPending(w2.id, { at, throughSeq: 3, errorCode: "BATCH_SKIPPED_BUSY" }),
    ).toThrow("CONVERSATION_SEQUENCE_INVALID");
  });

  it("pendingCandidates lists claimable wakes in peek order and the caller settles in its own transaction", () => {
    const h = setup();
    const c1 = onebotConversation(h, "b3", 3);
    const c2 = onebotConversation(h, "b4", 4);
    const wLow = h.wake.enqueue({
      conversationId: c1.id,
      cause: "chiming_in",
      throughSeq: 2,
      dedupeKey: "d4",
      readyAt: at,
      priority: 1,
      at,
    });
    const wHigh = h.wake.enqueue({
      conversationId: c2.id,
      cause: "chiming_in",
      throughSeq: 2,
      dedupeKey: "d5",
      readyAt: at,
      priority: 5,
      at,
    });
    // A not-yet-ready wake stays out; a leased one blocks only its own conversation.
    h.wake.enqueue({
      conversationId: c1.id,
      cause: "follow_up",
      throughSeq: 3,
      dedupeKey: "d6",
      readyAt: "2026-09-26T09:00:00.000Z",
      priority: 9,
      at,
    });

    const candidates = h.wake.pendingCandidates({ at });
    expect(candidates.map((w) => w.id)).toEqual([wHigh.id, wLow.id]);

    // The settlement pattern: skip the first candidate and advance the observation
    // boundary in the same transaction flow as the caller would.
    expect(
      h.wake.skipPending(wHigh.id, { at, throughSeq: 6, errorCode: "BATCH_SKIPPED_BUSY" }),
    ).toBe(true);
    h.journal.advanceChimingInObservedSeq(c2.id, 6);
    expect(h.journal.chimingInObservedSeq(c2.id)).toBe(6);
    expect(h.wake.pendingCandidates({ at }).map((w) => w.id)).toEqual([wLow.id]);
  });
});
