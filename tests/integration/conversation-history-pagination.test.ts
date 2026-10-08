import { afterEach, describe, expect, it } from "bun:test";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

/** Synthetic pagination fixtures: direct conversation/conversation_events rows only,
 * mirroring the HISTORY-PERF probe metadata events. No real data, no QQ transport. */
function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "fixture");
  const journal = new ConversationEventRepository(h.db);
  const at = new Date().toISOString();
  const sourceId = crypto.randomUUID();
  let epochCounter = 0;
  const addEpoch = (agentId: string, eventCount: number) => {
    epochCounter += 1;
    // Rebinding seals the previous activation; the partial unique index keeps
    // exactly one open epoch per (channel, source_id) family.
    h.db
      .query(
        "UPDATE conversations SET closed_at=? WHERE channel='web' AND source_id=? AND closed_at IS NULL",
      )
      .run(at, sourceId);
    const id = crypto.randomUUID();
    h.db
      .query(
        `INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,binding_epoch,next_seq,consumed_seq,created_at,updated_at)
         VALUES(?,'web','direct',?,?,?,?,?,0,?,?)`,
      )
      .run(id, sourceId, agentId, DEFAULT_USER_ID, epochCounter, eventCount + 1, at, at);
    const insert = h.db.prepare(
      `INSERT INTO conversation_events(conversation_id,seq,event_key,kind,source_kind,source_id,source_revision,sources,addressing,occurred_at,recorded_at)
       VALUES(?,?,?,?,'fixture',?,'r1','[]','{}',?,?)`,
    );
    for (let seq = 1; seq <= eventCount; seq++)
      insert.run(
        id,
        seq,
        `ev-${epochCounter}-${seq}`,
        "inbound",
        `src-${epochCounter}-${seq}`,
        at,
        at,
      );
    return { id, count: eventCount };
  };
  // Foreign-agent epochs need a real agent row: conversations.agent_id references agents.
  h.db
    .query(
      `INSERT INTO agents SELECT 'agent-page-b',name,system_prompt,description,additional_instructions,p5_config,model_name,temperature,memory_consolidation_model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_model_name,memory_retrieval_prompt,context_compression_model_name,persona_intensity,is_active,config_version,updated_at,created_at FROM agents WHERE id=?`,
    )
    .run(DEFAULT_AGENT_ID);
  const seqs = (page: { items: { seq: number }[] }) => page.items.map((item) => item.seq);
  return { db: h.db, journal, at, addEpoch, seqs };
}

describe("conversation history pagination over rebinding epochs", () => {
  it("pages a 50k-event single epoch through the indexed local-seq plan", () => {
    const h = setup();
    const epoch = h.addEpoch(DEFAULT_AGENT_ID, 50_000);
    const latest = h.journal.historyBefore(epoch.id, Number.MAX_SAFE_INTEGER, 100);
    expect(h.seqs(latest)).toEqual(Array.from({ length: 100 }, (_, i) => 49901 + i));
    expect(latest.nextSeq).toBe(50_000);
    expect(latest.hasMore).toBe(true);
    const older = h.journal.historyBefore(epoch.id, 25_000, 100);
    expect(h.seqs(older)).toEqual(Array.from({ length: 100 }, (_, i) => 24900 + i));
    expect(older.firstSeq).toBe(24_900);
    expect(older.hasMore).toBe(true);
    const tail = h.journal.historyAfter(epoch.id, 49_900, 100);
    expect(h.seqs(tail)).toEqual(Array.from({ length: 100 }, (_, i) => 49901 + i));
    expect(tail.hasMore).toBe(false);
  });

  it("keeps the strict cursor boundary and hasMore at exactly limit+1 remaining", () => {
    const h = setup();
    const epoch = h.addEpoch(DEFAULT_AGENT_ID, 250);
    // 150 events remain after the cursor: one page of 149 must report hasMore.
    const oneShort = h.journal.historyAfter(epoch.id, 100, 149);
    expect(h.seqs(oneShort)).toEqual(Array.from({ length: 149 }, (_, i) => 101 + i));
    expect(oneShort.hasMore).toBe(true);
    const exact = h.journal.historyAfter(epoch.id, 100, 150);
    expect(h.seqs(exact)).toEqual(Array.from({ length: 150 }, (_, i) => 101 + i));
    expect(exact.hasMore).toBe(false);
    const before = h.journal.historyBefore(epoch.id, 101, 100);
    expect(h.seqs(before)).toEqual(Array.from({ length: 100 }, (_, i) => 1 + i));
    expect(before.hasMore).toBe(false);
    // The cursor row itself is excluded in both directions.
    expect(h.seqs(h.journal.historyAfter(epoch.id, 101, 5))[0]).toBe(102);
    const strictBefore = h.journal.historyBefore(epoch.id, 101, 5);
    expect(h.seqs(strictBefore)).toEqual([96, 97, 98, 99, 100]);
    expect(strictBefore.firstSeq).toBe(96);
    expect(strictBefore.nextSeq).toBe(100);
  });

  it("crosses epoch boundaries with continuous global cursors in both directions", () => {
    const h = setup();
    const a = h.addEpoch(DEFAULT_AGENT_ID, 10);
    const b = h.addEpoch(DEFAULT_AGENT_ID, 5);
    const c = h.addEpoch(DEFAULT_AGENT_ID, 3);
    const full = h.journal.historyBefore(c.id, Number.MAX_SAFE_INTEGER, 100);
    expect(h.seqs(full)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(full.hasMore).toBe(false);
    // Global seq 11 lives in epoch b: the item keeps the physical epoch id while
    // the projected cursor stays continuous.
    expect(full.items[10]).toMatchObject({ seq: 11 });
    expect(full.items[10].event.conversationId).toBe(b.id);
    expect(full.items[10].event.eventKey).toBe("ev-2-1");
    expect(h.seqs(h.journal.historyBefore(c.id, 12, 4))).toEqual([8, 9, 10, 11]);
    expect(h.seqs(h.journal.historyAfter(c.id, 10, 3))).toEqual([11, 12, 13]);
    const intoCurrent = h.journal.historyAfter(a.id, 10, 100);
    expect(h.seqs(intoCurrent)).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
    expect(intoCurrent.items.at(-1)!.event.conversationId).toBe(c.id);
  });

  it("filters foreign-agent epochs and skips zero-event epochs in the offset walk", () => {
    const h = setup();
    const a1 = h.addEpoch(DEFAULT_AGENT_ID, 5);
    h.addEpoch("agent-page-b", 4); // foreign agent on the same channel/source/user
    const empty = h.addEpoch(DEFAULT_AGENT_ID, 0); // zero-event epoch contributes no offset
    const a2 = h.addEpoch(DEFAULT_AGENT_ID, 3);
    expect(h.journal.historyRows(a2.id).map((row) => row.id)).toEqual([a1.id, empty.id, a2.id]);
    const page = h.journal.historyBefore(a2.id, Number.MAX_SAFE_INTEGER, 100);
    expect(h.seqs(page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(JSON.stringify(page)).not.toContain("ev-2-");
    // Pagination resumes across the empty epoch without a gap or duplicate.
    expect(h.seqs(h.journal.historyAfter(a2.id, 5, 2))).toEqual([6, 7]);
    // A family with no events at all keeps the empty-page contract.
    const h2 = setup();
    const alone = h2.addEpoch(DEFAULT_AGENT_ID, 0);
    expect(h2.journal.historyBefore(alone.id, Number.MAX_SAFE_INTEGER, 100)).toEqual({
      items: [],
      firstSeq: 0,
      nextSeq: 0,
      hasMore: false,
    });
  });

  it("keeps history reads cursor-only: closed epochs reject appends and reads never ack", () => {
    const h = setup();
    const old = h.addEpoch(DEFAULT_AGENT_ID, 3);
    const current = h.addEpoch(DEFAULT_AGENT_ID, 2);
    h.db.query("UPDATE conversations SET closed_at=? WHERE id=?").run(h.at, old.id);
    expect(() =>
      h.journal.append({
        conversationId: old.id,
        eventKey: "late",
        kind: "inbound",
        source: { kind: "fixture", id: "late", revision: "1" },
        occurredAt: h.at,
      }),
    ).toThrow("CONVERSATION_CLOSED");
    expect(h.seqs(h.journal.historyBefore(current.id, Number.MAX_SAFE_INTEGER, 100))).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(h.seqs(h.journal.historyAfter(current.id, 0, 100))).toEqual([1, 2, 3, 4, 5]);
    // Reading must not move any execution watermark: next_seq/consumed_seq stay put.
    expect(
      h.db.query("SELECT id,next_seq,consumed_seq FROM conversations ORDER BY binding_epoch").all(),
    ).toEqual([
      { id: old.id, next_seq: 4, consumed_seq: 0 },
      { id: current.id, next_seq: 3, consumed_seq: 0 },
    ]);
    // Execution still uses local seq on the current epoch, never a global cursor.
    expect(h.journal.eventsAfter(current.id).items.map((e) => e.seq)).toEqual([1, 2]);
  });
});
