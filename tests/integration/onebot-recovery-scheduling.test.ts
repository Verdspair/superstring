import { afterEach, describe, expect, it } from "bun:test";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});
const NOW = 2_000_000_000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const bindingId = "11111111-1111-4111-8111-111111111111";

function setup() {
  const handle = openBusinessDb({ path: ":memory:" });
  handles.push(handle);
  const { db, orm } = handle;
  ensureDefaults(orm, "synthetic");
  updateQqSettings(orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(orm, {
    name: "recovery scheduling",
    triggers: { direct_reply: true, follow_up: true, chiming_in: false, idle_topic: false },
  });
  db.query(`INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at)
    VALUES(?,'10001','group','30003',?,?,?,?)`).run(
    bindingId,
    DEFAULT_AGENT_ID,
    scheme.id,
    iso(NOW - 100),
    iso(NOW - 100),
  );
  const calls: string[] = [];
  class Journal extends ConversationEventRepository {
    override ingestOneBotEvent(
      ...args: Parameters<ConversationEventRepository["ingestOneBotEvent"]>
    ) {
      calls.push(args[0]);
      return super.ingestOneBotEvent(...args);
    }
  }
  const journal = new Journal(db),
    wakes = new WakeRepository(db);
  const clock = { seconds: NOW };
  const adapter = new OneBot11Adapter({ orm, journal, wakes, nowSeconds: () => clock.seconds });
  function seed(
    key: string,
    speaker: string | null,
    occurred: number,
    addressed: number | null = 0,
    expires = NOW + 86400,
  ) {
    db.query(`INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at,addressed)
      VALUES(?,'10001','group','30003',?,?,?,?,?,?,?)`).run(
      key,
      DEFAULT_AGENT_ID,
      key,
      occurred,
      speaker === null ? "anonymous" : "member",
      speaker,
      iso(NOW),
      addressed,
    );
    db.query(`INSERT INTO qq_observation_text(event_key,body,occurred_at_seconds,expires_at,recorded_at)
      VALUES(?,'synthetic',?,?,?)`).run(key, occurred, iso(expires), iso(NOW));
  }
  function media(key: string, id: string, expires = NOW + 86400) {
    db.query(`INSERT INTO qq_media_notes(id,event_key,segment_index,segment_kind,source_ref,note,note_model,attempts,expires_at,recorded_at,updated_at)
      VALUES(?,?,0,'image','synthetic.png',NULL,NULL,0,?,?,?)`).run(
      id,
      key,
      iso(expires),
      iso(NOW),
      iso(NOW),
    );
  }
  const rows = () =>
    db
      .query(
        "SELECT cause,status,through_seq,ready_at,dedupe_key FROM wake_signals ORDER BY through_seq,cause",
      )
      .all();
  const reference = () =>
    (
      db
        .query(`WITH ranked AS (
    SELECT event_key,occurred_at_seconds,speaker_id,speaker_kind,addressed,
      ROW_NUMBER() OVER(PARTITION BY speaker_id ORDER BY occurred_at_seconds DESC,rowid DESC) AS latest,
      ROW_NUMBER() OVER(PARTITION BY speaker_id,addressed ORDER BY occurred_at_seconds DESC,rowid DESC) AS latest_addressed
    FROM qq_events WHERE account_id='10001' AND conversation_kind='group' AND peer_id='30003' AND agent_id=?
      AND speaker_kind IN('member','anonymous'))
    SELECT event_key FROM ranked e WHERE (latest=1 OR (addressed=1 AND latest_addressed=1))
      AND (EXISTS(SELECT 1 FROM qq_observation_text t WHERE t.event_key=e.event_key AND t.expires_at>?)
        OR EXISTS(SELECT 1 FROM qq_media_notes m WHERE m.event_key=e.event_key AND m.expires_at>?))
    ORDER BY occurred_at_seconds,event_key`)
        .all(DEFAULT_AGENT_ID, iso(clock.seconds), iso(clock.seconds)) as { event_key: string }[]
    ).map((row) => row.event_key);
  return { db, orm, journal, wakes, adapter, calls, clock, seed, media, rows, reference };
}

describe("OneBot source recovery scheduling", () => {
  it("preserves the ranked identities before TTL and coverage filtering", () => {
    const h = setup();
    h.seed("a-addressed", "20001", NOW - 40, 1);
    h.seed("a-old", "20001", NOW - 30);
    h.seed("a-tie-first", "20001", NOW - 20);
    h.seed("a-tie-last", "20001", NOW - 20);
    h.seed("b-readable-old", "20002", NOW - 10);
    h.seed("b-expired-latest", "20002", NOW, 0, NOW);
    h.seed("anonymous-old", null, NOW - 5, 1);
    h.seed("anonymous-latest", null, NOW - 1, null);
    h.seed("null-addressed", "20003", NOW - 2, null);
    const expected = h.reference();
    expect(expected).toEqual([
      "a-addressed",
      "a-tie-last",
      "anonymous-old",
      "null-addressed",
      "anonymous-latest",
    ]);
    h.adapter.scanImmediate();
    expect(h.calls).toEqual(expected);
  });

  it("does not reingest already offered sources whose journal media references are complete", () => {
    const h = setup();
    for (let index = 0; index < 24; index++) h.seed(`source-${index}`, String(20000 + index), NOW);
    h.adapter.scanImmediate();
    const before = h.rows();
    expect(h.calls).toHaveLength(24);
    h.calls.length = 0;
    h.adapter.sweep();
    expect(h.rows()).toEqual(before);
    expect(h.calls).toEqual([]);
  });

  it("still ingests a missing journal source and offers it", () => {
    const h = setup();
    h.adapter.scanImmediate();
    h.seed("missed-callback", "20001", NOW, 1);
    h.adapter.scanImmediate();
    expect(h.calls).toEqual(["missed-callback"]);
    expect(h.rows()).toHaveLength(1);
  });

  it("merges a new media reference into an already offered source without another wake", () => {
    const h = setup();
    h.seed("source", "20001", NOW);
    h.adapter.scanImmediate();
    const before = h.rows();
    h.calls.length = 0;
    h.media("source", "new-media");
    h.adapter.scanImmediate();
    expect(h.calls).toEqual(["source"]);
    const conversation = h.journal.ensureOneBotActivation(bindingId)!;
    const event = h.journal
      .eventsAfter(conversation.id)
      .items.find((row) => row.source.id === "source")!;
    expect(
      event.sources.some((source) => source.kind === "qq_media" && source.id === "new-media"),
    ).toBe(true);
    expect(h.rows()).toEqual(before);
    h.calls.length = 0;
    h.adapter.scanImmediate();
    expect(h.calls).toEqual([]);
  });

  it("does not mistake another source kind for a matching expired media reference", () => {
    const h = setup();
    h.seed("source-kind", "20001", NOW);
    h.adapter.scanImmediate();
    const before = h.rows();
    const conversation = h.journal.ensureOneBotActivation(bindingId)!;
    const stored = h.db
      .query(
        "SELECT sources FROM conversation_events WHERE conversation_id=? AND source_id=? AND source_kind='qq_event'",
      )
      .get(conversation.id, "source-kind") as { sources: string };
    const refs = JSON.parse(stored.sources);
    refs.push({ kind: "qq_event", id: "same-id", revision: "1" });
    h.db
      .query(
        "UPDATE conversation_events SET sources=? WHERE conversation_id=? AND source_id=? AND source_kind='qq_event'",
      )
      .run(JSON.stringify(refs), conversation.id, "source-kind");
    h.media("source-kind", "same-id", NOW);
    h.calls.length = 0;
    h.adapter.scanImmediate();
    expect(h.calls).toEqual(["source-kind"]);
    const updated = h.db
      .query(
        "SELECT sources FROM conversation_events WHERE conversation_id=? AND source_id=? AND source_kind='qq_event'",
      )
      .get(conversation.id, "source-kind") as { sources: string };
    expect(JSON.parse(updated.sources)).toContainEqual({
      kind: "qq_media",
      id: "same-id",
      revision: "0",
      expiresAt: iso(NOW),
    });
    expect(h.rows()).toEqual(before);
    h.calls.length = 0;
    h.adapter.scanImmediate();
    expect(h.calls).toEqual([]);
  });

  it("recovers media-only readability on an unchanged permanent source", () => {
    const h = setup();
    h.seed("media-only", "20001", NOW, 1, NOW);
    h.adapter.scanImmediate();
    expect(h.rows()).toEqual([]);
    expect(h.calls).toEqual([]);
    h.media("media-only", "retained-media");
    h.adapter.scanImmediate();
    expect(h.calls).toEqual(["media-only"]);
    expect(h.rows()).toHaveLength(1);
  });

  it("reads current pause and resumes without requiring a new event", () => {
    const h = setup();
    h.db.query("UPDATE qq_bindings SET paused=1 WHERE id=?").run(bindingId);
    h.seed("paused", "20001", NOW);
    h.adapter.scanImmediate();
    expect(h.rows()).toEqual([]);
    h.db.query("UPDATE qq_bindings SET paused=0 WHERE id=?").run(bindingId);
    h.adapter.scanImmediate();
    expect(h.rows()).toHaveLength(1);
  });

  it("does not resurrect a covered terminal source after a trigger change", () => {
    const h = setup();
    h.seed("failed", "20001", NOW);
    h.adapter.scanImmediate();
    h.clock.seconds += 60;
    const claimed = h.wakes.claim({ at: iso(h.clock.seconds), leaseMs: 60000 })!;
    h.wakes.fail(claimed.id, claimed.leaseToken!, {
      at: iso(h.clock.seconds),
      errorCode: "MODEL_FAILED",
      maxAttempts: 1,
      retryDelayMs: 1000,
    });
    const before = h.rows();
    h.db
      .query("UPDATE qq_bindings SET trigger_follow_up=0,trigger_chiming_in=1 WHERE id=?")
      .run(bindingId);
    h.calls.length = 0;
    h.adapter.scanImmediate();
    expect(h.rows()).toEqual(before);
    expect(h.calls).toEqual([]);
  });
});
