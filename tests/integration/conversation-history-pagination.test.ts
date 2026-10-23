import { afterEach, describe, expect, it } from "bun:test";
import { projectConversationEvent } from "../../src/server/conversation/conversation-view";
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

  it("latest page keeps normal messages visible when stale undescribed media revisions crowd older seqs", () => {
    const h = setup();
    const epoch = h.addEpoch(DEFAULT_AGENT_ID, 150);
    const insertRevision = h.db.prepare(
      `INSERT INTO conversation_events(conversation_id,seq,event_key,kind,source_kind,source_id,source_revision,sources,addressing,occurred_at,recorded_at)
       VALUES(?,?,?,?,'qq_media',?,?,'[]','{}',?,?)`,
    );
    const at = h.at;
    // Real backfill shape: every stored media revision carries its parent inbound row
    // (seq 1..150 here) and its note row; 97 of them are the initial undescribed state
    // (attempts=0, note=NULL) that produced the crowded latest page.
    for (let i = 0; i < 97; i++)
      insertRevision.run(
        epoch.id,
        151 + i,
        `media-empty-${i}`,
        "media_revision",
        `note-empty-${i}`,
        "0",
        at,
        at,
      );
    // Legacy shape kept visible: 0 attempts WITH a stored note is a real revision.
    insertRevision.run(epoch.id, 248, "media-note-0", "media_revision", "note-legacy", "0", at, at);
    // A consumed attempt (attempts>0, no note) is a meaningful failure: still visible.
    insertRevision.run(epoch.id, 249, "media-fail", "media_revision", "note-fail", "1", at, at);
    h.db
      .query(
        "INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at) VALUES('evt-page','90001','group','30003',?,'msg-page',0,'member','10001',?)",
      )
      .run(DEFAULT_AGENT_ID, at);
    for (let i = 0; i < 97; i++)
      h.db
        .query(
          "INSERT INTO qq_media_notes(id,event_key,segment_index,segment_kind,source_ref,note,note_model,attempts,expires_at,recorded_at,updated_at) VALUES(?,?,?,'image','ref',NULL,NULL,0,'2099-01-01T00:00:00.000Z',?,?)",
        )
        .run(`note-empty-${i}`, "evt-page", i, at, at);
    for (const [id, note, attempts, segment] of [
      ["note-legacy", "旧描述", 0, 97],
      ["note-fail", null, 1, 98],
    ] as const)
      h.db
        .query(
          "INSERT INTO qq_media_notes(id,event_key,segment_index,segment_kind,source_ref,note,note_model,attempts,expires_at,recorded_at,updated_at) VALUES(?,?,?,'image','ref',?,? ,?,'2099-01-01T00:00:00.000Z',?,?)",
        )
        .run(id, "evt-page", segment, note, note === null ? null : "fixture", attempts, at, at);
    h.db.query("UPDATE conversations SET next_seq=250 WHERE id=?").run(epoch.id);
    // Raw rows stay stored; the display page skips exactly the 97 non-update rows.
    expect(
      (
        h.db
          .query("SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id=?")
          .get(epoch.id) as { n: number }
      ).n,
    ).toBe(249);
    const latest = h.journal.historyBefore(epoch.id, Number.MAX_SAFE_INTEGER, 100);
    expect(h.seqs(latest)).toEqual([...Array.from({ length: 98 }, (_, i) => 53 + i), 248, 249]);
    expect(latest.hasMore).toBe(true);
    // Cursor arithmetic stays canonical: the strict boundary page keeps its exact rows.
    expect(h.seqs(h.journal.historyBefore(epoch.id, 200, 100))).toEqual(
      Array.from({ length: 100 }, (_, i) => 51 + i),
    );
    const forward = h.journal.historyAfter(epoch.id, 190, 100);
    expect(h.seqs(forward)).toEqual([248, 249]);
    expect(forward.hasMore).toBe(false);
    // Eligibility follows the note's CURRENT state, not a frozen snapshot: describing
    // note-empty-0 through the legacy write path re-admits its rev-0 row immediately.
    h.db
      .query("UPDATE qq_media_notes SET note='补上了',note_model='fixture' WHERE id='note-empty-0'")
      .run();
    expect(h.seqs(h.journal.historyAfter(epoch.id, 150, 100))).toEqual([151, 248, 249]);
    // Execution reads are untouched: eventsAfter still yields every raw row in order.
    expect(h.journal.eventsAfter(epoch.id, 245).items.map((e) => e.seq)).toEqual([
      246, 247, 248, 249,
    ]);
    // Watermarks stay put; reading never acks or resequences.
    expect(
      h.db.query("SELECT next_seq,consumed_seq FROM conversations WHERE id=?").get(epoch.id),
    ).toEqual({ next_seq: 250, consumed_seq: 0 });
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

  it("keeps raw media revisions eligible by current revision state, independent of expiry", () => {
    const h = setup();
    const epoch = h.addEpoch(DEFAULT_AGENT_ID, 3);
    const insertRevision = h.db.prepare(
      `INSERT INTO conversation_events(conversation_id,seq,event_key,kind,source_kind,source_id,source_revision,sources,addressing,occurred_at,recorded_at)
       VALUES(?,?,?,?,'qq_media',?,?,'[]','{}',?,?)`,
    );
    const at = h.at;
    h.db
      .query(
        "INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at) VALUES('evt-boundary','90001','group','30003',?,'msg-boundary',0,'member','10001',?)",
      )
      .run(DEFAULT_AGENT_ID, at);
    // note-purged has no qq_media_notes row any more (its revision row predates the purge);
    // note-expired keeps a current revision whose note TTL already lapsed; note-alpha is
    // still at the initial 0-attempt state. attempts stays inside the schema 0..2 check and
    // note_model satisfies the "note NULL OR note_model NOT NULL" constraint.
    const insertNote = h.db.prepare(
      "INSERT INTO qq_media_notes(id,event_key,segment_index,segment_kind,source_ref,note,note_model,attempts,expires_at,recorded_at,updated_at) VALUES(?,?,?,'image','ref',?,?,?,?,?,?)",
    );
    insertNote.run(
      "note-expired",
      "evt-boundary",
      0,
      "过期描述",
      "fixture",
      1,
      "2020-01-01T00:00:00.000Z",
      at,
      at,
    );
    insertNote.run(
      "note-alpha",
      "evt-boundary",
      1,
      null,
      null,
      0,
      "2099-01-01T00:00:00.000Z",
      at,
      at,
    );
    insertRevision.run(
      epoch.id,
      4,
      "media:note-purged:1",
      "media_revision",
      "note-purged",
      "1",
      at,
      at,
    );
    insertRevision.run(
      epoch.id,
      5,
      "media:note-expired:1",
      "media_revision",
      "note-expired",
      "1",
      at,
      at,
    );
    insertRevision.run(
      epoch.id,
      6,
      "media:note-alpha:0",
      "media_revision",
      "note-alpha",
      "0",
      at,
      at,
    );
    h.db.query("UPDATE conversations SET next_seq=7 WHERE id=?").run(epoch.id);
    // Purged note and expired note: both raw rows stay display-eligible, and only the
    // 0-attempt/no-note revision is hidden.
    const latest = h.journal.historyBefore(epoch.id, Number.MAX_SAFE_INTEGER, 100);
    expect(h.seqs(latest)).toEqual([1, 2, 3, 4, 5]);
    expect(latest.hasMore).toBe(false);
    expect(
      (
        h.db
          .query("SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id=?")
          .get(epoch.id) as { n: number }
      ).n,
    ).toBe(6);
    expect(h.journal.eventsAfter(epoch.id, 3).items.map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(
      h.db.query("SELECT next_seq,consumed_seq FROM conversations WHERE id=?").get(epoch.id),
    ).toEqual({ next_seq: 7, consumed_seq: 0 });
    // Projection resolves the same raw rows against the live note table: the purged note
    // and the expired current note both report expiry while history keeps listing them.
    const projAt = "2026-10-22T00:00:00.000Z";
    const event = (seq: number) => h.journal.eventsAfter(epoch.id, seq - 1).items[0]!;
    expect(projectConversationEvent(h.db, event(4), projAt).contentState).toBe("expired");
    expect(projectConversationEvent(h.db, event(5), projAt)).toMatchObject({
      contentState: "expired",
      text: null,
    });
    // The stored 0-attempt row has no display fact until the note is described: the same
    // revision re-admits in place, and the projection turns active with the note text.
    expect(projectConversationEvent(h.db, event(6), projAt)).toMatchObject({
      contentState: "unavailable",
      text: null,
    });
    h.db
      .query("UPDATE qq_media_notes SET note='补充描述',note_model='fixture' WHERE id='note-alpha'")
      .run();
    expect(h.seqs(h.journal.historyAfter(epoch.id, 5, 100))).toEqual([6]);
    expect(projectConversationEvent(h.db, event(6), projAt)).toMatchObject({
      contentState: "active",
      text: "补充描述",
    });
    // A consumed attempt supersedes rev 0: the stale row hides, the rev-1 row matching the
    // note's actual current revision takes its place, and the stale row projects unavailable.
    h.db.query("UPDATE qq_media_notes SET note='读后描述',attempts=1 WHERE id='note-alpha'").run();
    insertRevision.run(
      epoch.id,
      7,
      "media:note-alpha:1",
      "media_revision",
      "note-alpha",
      "1",
      at,
      at,
    );
    h.db.query("UPDATE conversations SET next_seq=8 WHERE id=?").run(epoch.id);
    expect(h.seqs(h.journal.historyAfter(epoch.id, 5, 100))).toEqual([7]);
    expect(projectConversationEvent(h.db, event(6), projAt).contentState).toBe("unavailable");
    expect(projectConversationEvent(h.db, event(7), projAt)).toMatchObject({
      contentState: "active",
      text: "读后描述",
    });
    // Raw retention is untouched by the display filter: every revision row and watermark
    // stays exactly as written.
    expect(
      (
        h.db
          .query("SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id=?")
          .get(epoch.id) as { n: number }
      ).n,
    ).toBe(7);
    expect(h.journal.eventsAfter(epoch.id, 3).items.map((e) => e.seq)).toEqual([4, 5, 6, 7]);
    expect(
      h.db.query("SELECT next_seq,consumed_seq FROM conversations WHERE id=?").get(epoch.id),
    ).toEqual({ next_seq: 8, consumed_seq: 0 });
  });

  it("preserves offset cursors when hidden initial media sits in an older sealed epoch", () => {
    const h = setup();
    const first = h.addEpoch(DEFAULT_AGENT_ID, 3);
    const insertRevision = h.db.prepare(
      `INSERT INTO conversation_events(conversation_id,seq,event_key,kind,source_kind,source_id,source_revision,sources,addressing,occurred_at,recorded_at)
       VALUES(?,?,?,?,'qq_media',?,'0','[]','{}',?,?)`,
    );
    const at = h.at;
    // Initial undescribed media (attempts=0, note=NULL) in the oldest epoch: display-hidden
    // but still counting toward every later cursor's offset.
    insertRevision.run(first.id, 4, "media-init", "media_revision", "note-init", at, at);
    h.db
      .query(
        "INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at) VALUES('evt-offset','90001','group','30003',?,'msg-offset',0,'member','10001',?)",
      )
      .run(DEFAULT_AGENT_ID, at);
    h.db
      .query(
        "INSERT INTO qq_media_notes(id,event_key,segment_index,segment_kind,source_ref,note,note_model,attempts,expires_at,recorded_at,updated_at) VALUES('note-init','evt-offset',0,'image','ref',NULL,NULL,0,'2099-01-01T00:00:00.000Z',?,?)",
      )
      .run(at, at);
    h.db.query("UPDATE conversations SET next_seq=5 WHERE id=?").run(first.id);
    const second = h.addEpoch(DEFAULT_AGENT_ID, 2);
    const third = h.addEpoch(DEFAULT_AGENT_ID, 1);
    // Global seqs: first 1..4 (4 hidden), second 5..6, third 7. Backward from the newest
    // epoch still honors the hidden row's offset: no gap and no shift.
    const before = h.journal.historyBefore(third.id, Number.MAX_SAFE_INTEGER, 100);
    expect(h.seqs(before)).toEqual([1, 2, 3, 5, 6, 7]);
    expect(before.hasMore).toBe(false);
    expect(before.items.map((item) => item.event.conversationId)).toEqual([
      first.id,
      first.id,
      first.id,
      second.id,
      second.id,
      third.id,
    ]);
    expect(JSON.stringify(before)).not.toContain("media-init");
    expect(
      (
        h.db
          .query("SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id=?")
          .get(first.id) as { n: number }
      ).n,
    ).toBe(4);
    // Forward: a cursor inside the hidden gap keeps the strict boundary and hasMore truth.
    const fromInside = h.journal.historyAfter(second.id, 2, 2);
    expect(h.seqs(fromInside)).toEqual([3, 5]);
    expect(fromInside.hasMore).toBe(true);
    expect(h.seqs(h.journal.historyAfter(second.id, 4, 2))).toEqual([5, 6]);
    expect(h.journal.historyAfter(second.id, 4, 2).hasMore).toBe(true);
    expect(h.seqs(h.journal.historyAfter(second.id, 6, 2))).toEqual([7]);
    expect(h.journal.historyAfter(second.id, 6, 2).hasMore).toBe(false);
    // Backward strict boundary across the hidden row from the newest epoch.
    const across = h.journal.historyBefore(third.id, 7, 3);
    expect(h.seqs(across)).toEqual([3, 5, 6]);
    expect(across.hasMore).toBe(true);
    expect(h.seqs(h.journal.historyBefore(third.id, across.firstSeq, 3))).toEqual([1, 2]);
    expect(h.seqs(h.journal.historyBefore(third.id, 8, 100))).toEqual([1, 2, 3, 5, 6, 7]);
    // Execution reads are untouched by the display filter in both epochs.
    expect(h.journal.eventsAfter(first.id, 2).items.map((e) => e.seq)).toEqual([3, 4]);
    expect(h.journal.eventsAfter(second.id, 0).items.map((e) => e.seq)).toEqual([1, 2]);
    // Watermarks stay put across the family; reading never acks or resequences.
    expect(
      h.db.query("SELECT id,next_seq,consumed_seq FROM conversations ORDER BY binding_epoch").all(),
    ).toEqual([
      { id: first.id, next_seq: 5, consumed_seq: 0 },
      { id: second.id, next_seq: 3, consumed_seq: 0 },
      { id: third.id, next_seq: 2, consumed_seq: 0 },
    ]);
  });
});
