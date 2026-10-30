import { describe, expect, it, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  forgetQqIdleJudgementsExcept,
  readQqSweepVerdicts,
  recordQqIdleJudgement,
  recordQqSweepVerdicts,
} from "../../src/server/db/qq-dispatch-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { createQqScheme, readQqSchemes } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { recordQqSpeech } from "../../src/server/db/qq-speech-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { BUSINESS_SCHEMA_VERSION, openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { qqConversationKey } from "../../src/server/services/qq-binding-contract";
import { QQ_CONTEXT_DEFAULT as fixtureLegacyContext } from "../../src/server/services/qq-context-contract";
import { sweepQqIdleTopics } from "../../src/server/services/qq-dispatch";
import { QQ_RHYTHM_DEFAULT as fixtureLegacyRhythm } from "../../src/server/services/qq-rhythm-contract";
import { QQ_ALLOCATION_DEFAULT as fixtureLegacyAllocation } from "../../src/shared/contracts/context-allocation";
import * as fixtureLegacyQq from "../../src/shared/contracts/qq";
import { cloneBusinessDb } from "../harness/business-db";

const agentId = "00000000-0000-0000-0000-000000000001";
const bindingId = "11111111-1111-4111-8111-111111111111";
const otherBindingId = "22222222-2222-4222-8222-222222222222";
const now = 2_000_000_000;

function event(orm: Orm, key: string, at: number, text: string, peerId = "30003") {
  recordObservation(
    orm,
    {
      accountId: "10001",
      conversation: { kind: "group", peerId, key: "" },
      eventKey: key,
      messageId: key,
      occurredAtSeconds: at,
      subType: "normal",
      speaker: { kind: "member", id: "20002", displayName: null },
      segments: [{ kind: "text", text }],
      text,
      mentionsSelf: false,
    },
    agentId,
  );
}

/** Seed one account, one scheme and one binding per peer, plus the source events. */
function seedConversation(orm: Orm, peers: string[] = ["30003"]) {
  ensureDefaults(orm, "synthetic-model");
  updateQqSettings(orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(orm, {
    context: { ...fixtureLegacyContext },
    rhythm: { ...fixtureLegacyRhythm },
    compression: { ...fixtureLegacyQq.QQ_COMPRESSION_DEFAULT },
    outputReserve: { ...fixtureLegacyQq.QQ_MODEL_OUTPUT_RESERVE_DEFAULT },
    allocation: structuredClone(fixtureLegacyAllocation),
    stickers: { ...fixtureLegacyQq.QQ_STICKER_DEDUP_DEFAULT },
    mediaInput: structuredClone(fixtureLegacyQq.QQ_MEDIA_INPUT_SCHEME_DEFAULT),
    name: "synthetic",
    triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: true },
  });
  peers.forEach((peerId, index) => {
    orm
      .insert(schema.qqBindings)
      .values({
        id: index === 0 ? bindingId : otherBindingId,
        accountId: "10001",
        conversationKind: "group",
        peerId,
        agentId,
        schemeId: scheme.id,
        paused: 0,
        shareWebMemory: 0,
        memoryBatchSize: null,
        ownerIdentityRevision: null,
        revision: 1,
        authorityRevision: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    event(orm, `old-${peerId}`, now - 90, "旧消息", peerId);
    event(orm, `latest-${peerId}`, now - 40, "新消息", peerId);
  });
  return scheme;
}

function setup(options: { peers?: string[] } = {}) {
  const h = cloneBusinessDb();
  const scheme = seedConversation(h.orm, options.peers);
  return { h, scheme };
}

/**
 * An unprompted utterance by the assistant. Uses the real recorder so the fixture cannot drift
 * from the columns the rule actually reads (id, expiry included).
 */
function recordOwnSpeech(orm: Orm, peerId: string, spokeAtSeconds: number) {
  recordQqSpeech(orm, {
    scope: {
      kind: "qq",
      accountId: "10001",
      conversationKind: "group",
      peerId,
      agentId,
    },
    kind: "chiming_in",
    spokeAtSeconds,
    text: null,
  });
}

function sweepCurrentAdapter(orm: Orm, input: { nowSeconds: number }) {
  const db = (orm as Orm & { $client: ReturnType<typeof openBusinessDb>["db"] }).$client;
  const journal = new ConversationEventRepository(db);
  const wakes = new WakeRepository(db);
  return new OneBot11Adapter({ orm, journal, wakes, nowSeconds: () => input.nowSeconds }).sweep(
    input.nowSeconds,
  );
}
function idleWakes(orm: Orm) {
  const db = (orm as Orm & { $client: ReturnType<typeof openBusinessDb>["db"] }).$client;
  return db
    .query("SELECT * FROM wake_signals WHERE cause='idle_topic' AND status='pending' ORDER BY id")
    .all() as Array<{ id: string; ready_at: string; through_seq: number }>;
}

describe("the fast fixture matches the real migration chain", () => {
  it("clones the current schema version and still enforces foreign keys", () => {
    const h = cloneBusinessDb();
    try {
      expect(h.db.query("PRAGMA user_version").get()).toEqual({
        user_version: BUSINESS_SCHEMA_VERSION,
      });
      // Cloning must not turn the constraints into documentation: these tests rely on the
      // binding foreign key actually refusing an orphan candidate.
      expect(() =>
        h.db
          .query(
            "INSERT INTO qq_dispatch_candidates(conversation_key,binding_id,path,ready_at_seconds,observed_at_seconds,generation) VALUES('orphan','00000000-0000-4000-8000-000000000000','chiming_in',0,0,1)",
          )
          .run(),
      ).toThrow();
      const real = openBusinessDb();
      try {
        const select =
          "SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'qq_dispatch%' ORDER BY name";
        expect(h.db.query(select).all()).toEqual(real.db.query(select).all());
      } finally {
        real.close();
      }
    } finally {
      h.close();
    }
  });
});

describe("quiet-room sweep", () => {
  it("produces an idle-topic candidate once a member message has gone quiet long enough", () => {
    const { h } = setup();
    try {
      const at = now + 15 * 60;
      expect(sweepCurrentAdapter(h.orm, { nowSeconds: at })).toEqual({
        scheduled: [
          {
            kind: "scheduled",
            conversationKey: expect.any(String),
            path: "idle_topic",
            generation: expect.any(Number),
            readyAtSeconds: at,
          },
        ],
        skipped: [],
      });
      const rows = idleWakes(h.orm);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ready_at).toBe(new Date(at * 1000).toISOString());
    } finally {
      h.close();
    }
  });

  it("waits the scheme's quiet time before offering an opener", () => {
    const { h } = setup();
    try {
      const early = now + 14 * 60;
      expect(sweepCurrentAdapter(h.orm, { nowSeconds: early })).toEqual({
        scheduled: [],
        skipped: [{ conversationKey: expect.any(String), reason: "not_quiet_yet" }],
      });
      expect(idleWakes(h.orm)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("under the hard attention mode the quiet-room clock only counts the listed speakers", () => {
    const { h } = setup();
    try {
      // Both seeded messages are from 20002; with a list that does not include them there is
      // nobody this conversation listens to who has ever spoken, so the sweep says so instead of
      // opening a topic (0031: the same list narrows the basis, not only the reply).
      h.orm
        .update(schema.qqBindings)
        .set({ attentionMode: "hard", attentionMembers: JSON.stringify(["99999"]) })
        .where(eq(schema.qqBindings.id, bindingId))
        .run();
      expect(sweepCurrentAdapter(h.orm, { nowSeconds: now })).toEqual({
        scheduled: [],
        skipped: [{ conversationKey: expect.any(String), reason: "no_member_baseline" }],
      });
      // Naming the speaker who did talk makes the same fixture quiet-but-fresh instead.
      h.orm
        .update(schema.qqBindings)
        .set({ attentionMode: "hard", attentionMembers: JSON.stringify(["20002"]) })
        .where(eq(schema.qqBindings.id, bindingId))
        .run();
      expect(sweepCurrentAdapter(h.orm, { nowSeconds: now })).toEqual({
        scheduled: [],
        skipped: [{ conversationKey: expect.any(String), reason: "not_quiet_yet" }],
      });
    } finally {
      h.close();
    }
  });

  it("does not judge the same quiet episode twice, and re-judges once the room moves on", () => {
    const { h } = setup();
    try {
      // Quiet long enough (the scheme's window is 15 minutes): the first pass offers an opener.
      const at = now + 15 * 60;
      const first = sweepCurrentAdapter(h.orm, { nowSeconds: at });
      expect(first.skipped).toEqual([]);
      expect(first.scheduled).toHaveLength(1);
      const conversationKey = first.scheduled[0]?.conversationKey ?? "";
      expect(conversationKey).not.toBe("");
      // The judgement ran and stayed silent: the cycle remembers the basis it judged (0033).
      recordQqIdleJudgement(h.orm, { conversationKey, basisSeconds: now - 40, nowSeconds: at });
      h.db.query("UPDATE wake_signals SET status='no_output' WHERE cause='idle_topic'").run();
      // The timed sweep must NOT judge the same basis again — this used to be a model call per pass.
      const second = sweepCurrentAdapter(h.orm, { nowSeconds: at + 60 });
      expect(second.scheduled).toEqual([]);
      expect(second.skipped).toEqual([{ conversationKey, reason: "already_judged" }]);
      // A newer member message moves the basis, so the conversation may be judged again.
      event(h.orm, "newer-message", at + 30, "又有人说话了");
      const third = sweepCurrentAdapter(h.orm, { nowSeconds: at + 90 });
      expect(third.skipped.map((entry) => entry.reason)).not.toContain("already_judged");
    } finally {
      h.close();
    }
  });

  it("drops the judgement memory for conversations the sweep no longer tracks", () => {
    const { h } = setup();
    try {
      const kept = qqConversationKey({ accountId: "10001", kind: "group", peerId: "30003" });
      const gone = qqConversationKey({ accountId: "10001", kind: "group", peerId: "30004" });
      recordQqIdleJudgement(h.orm, { conversationKey: kept, basisSeconds: 100, nowSeconds: 200 });
      recordQqIdleJudgement(h.orm, { conversationKey: gone, basisSeconds: 100, nowSeconds: 200 });
      // The sweep reconciles against the conversations it just walked (its own call, same function).
      forgetQqIdleJudgementsExcept(h.orm, [kept]);
      expect(h.orm.select().from(schema.qqIdleJudgements).all()).toEqual([
        { conversationKey: kept, basisSeconds: 100, judgedAtSeconds: 200 },
      ]);
      // And when nothing is tracked, nothing is remembered.
      forgetQqIdleJudgementsExcept(h.orm, []);
      expect(h.orm.select().from(schema.qqIdleJudgements).all()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("treats a conversation nobody has ever spoken in as not quiet", () => {
    const h = cloneBusinessDb();
    try {
      // A freshly bound group: the binding exists, but no member has said anything.
      seedConversation(h.orm, []);
      const peerId = "30003";
      h.orm
        .insert(schema.qqBindings)
        .values({
          id: bindingId,
          accountId: "10001",
          conversationKind: "group",
          peerId,
          agentId,
          schemeId: readQqSchemes(h.orm)[0]?.id ?? "",
          paused: 0,
          shareWebMemory: 0,
          memoryBatchSize: null,
          ownerIdentityRevision: null,
          revision: 1,
          authorityRevision: 1,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        .run();
      // The assistant's own earlier speech is not a baseline either.
      recordOwnSpeech(h.orm, peerId, now - 600);
      const at = now + 60 * 60;
      expect(sweepCurrentAdapter(h.orm, { nowSeconds: at })).toEqual({
        scheduled: [],
        skipped: [{ conversationKey: expect.any(String), reason: "no_member_baseline" }],
      });
      expect(idleWakes(h.orm)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("does not chase a conversation after its own unprompted speech was ignored", () => {
    const { h } = setup();
    try {
      recordOwnSpeech(h.orm, "30003", now - 10);
      const at = now + 15 * 60;
      expect(sweepCurrentAdapter(h.orm, { nowSeconds: at })).toEqual({
        scheduled: [],
        skipped: [{ conversationKey: expect.any(String), reason: "awaiting_reply" }],
      });
    } finally {
      h.close();
    }
  });

  it("releases the no-reply rule as soon as a real partner speaks again", () => {
    const { h } = setup();
    try {
      recordOwnSpeech(h.orm, "30003", now - 10);
      event(h.orm, "after-own", now + 10, "有人接话了");
      const at = now + 10 + 15 * 60;
      expect(sweepCurrentAdapter(h.orm, { nowSeconds: at }).scheduled).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("reports every configuration reason instead of silently doing nothing", () => {
    for (const [mutate, reason] of [
      [
        (h: ReturnType<typeof setup>["h"]) =>
          updateQqSettings(h.orm, { enabled: false, expectedRevision: 2 }),
        "feature_off",
      ],
      [
        (h: ReturnType<typeof setup>["h"]) =>
          h.orm.update(schema.qqBindings).set({ paused: 1 }).run(),
        "conversation_paused",
      ],
      [
        (h: ReturnType<typeof setup>["h"]) =>
          h.orm.update(schema.qqSchemes).set({ triggerIdleTopic: 0 }).run(),
        "trigger_off",
      ],
    ] as const) {
      const { h } = setup();
      try {
        mutate(h);
        const at = now + 15 * 60;
        const result = sweepCurrentAdapter(h.orm, { nowSeconds: at });
        expect(result.scheduled).toEqual([]);
        expect(result.skipped.map((s) => s.reason)).toEqual([reason]);
      } finally {
        h.close();
      }
    }
  });

  it("honours the allowed hours when the scheme enables them", () => {
    // The gate derives the minute of the local day from the same clock the sweep is given, so
    // the fixture asks what minute that clock lands on instead of supplying a second one.
    const at = now + 15 * 60;
    const minuteOfDay = Math.floor(at / 60) % 1440;
    const outside = setup();
    try {
      outside.h.orm
        .update(schema.qqSchemes)
        .set({
          activeHoursEnabled: 1,
          activeHoursStartMinutes: (minuteOfDay + 60) % 1440,
          activeHoursEndMinutes: (minuteOfDay + 120) % 1440,
        })
        .run();
      expect(sweepCurrentAdapter(outside.h.orm, { nowSeconds: at }).skipped).toEqual([
        { conversationKey: expect.any(String), reason: "outside_active_hours" },
      ]);
      expect(idleWakes(outside.h.orm)).toEqual([]);
    } finally {
      outside.h.close();
    }
    const inside = setup();
    try {
      inside.h.orm
        .update(schema.qqSchemes)
        .set({
          activeHoursEnabled: 1,
          activeHoursStartMinutes: (minuteOfDay + 1439) % 1440,
          activeHoursEndMinutes: (minuteOfDay + 1) % 1440,
        })
        .run();
      expect(sweepCurrentAdapter(inside.h.orm, { nowSeconds: at }).scheduled).toHaveLength(1);
    } finally {
      inside.h.close();
    }
  });

  it("does not re-enqueue a conversation that already holds a candidate", () => {
    const { h } = setup();
    try {
      const at = now + 15 * 60;
      const first = sweepCurrentAdapter(h.orm, { nowSeconds: at });
      expect(first.scheduled).toHaveLength(1);
      // Sweeping again must not bump the generation: that would invalidate in-flight work and
      // push ready_at forward for ever, starving the task the sweep itself created.
      const second = sweepCurrentAdapter(h.orm, { nowSeconds: at + 60 });
      expect(second.scheduled).toEqual([]);
      expect(second.skipped.map((s) => s.reason)).toEqual(["candidate_pending"]);
      expect(idleWakes(h.orm)).toHaveLength(1);
      expect(idleWakes(h.orm)[0]?.ready_at).toBe(new Date(at * 1000).toISOString());
    } finally {
      h.close();
    }
  });

  it("uses a new member message as the quiet baseline, and its own clock for readiness", () => {
    const { h } = setup();
    try {
      // A fresh member message restarts the quiet window and replaces the earlier baseline.
      event(h.orm, "fresh", now + 100, "刚才有人说话");
      const early = now + 100 + 14 * 60;
      expect(sweepCurrentAdapter(h.orm, { nowSeconds: early }).skipped).toEqual([
        { conversationKey: expect.any(String), reason: "not_quiet_yet" },
      ]);
      const ready = now + 100 + 15 * 60;
      expect(sweepCurrentAdapter(h.orm, { nowSeconds: ready }).scheduled).toHaveLength(1);
      // The candidate records the message it grew out of, not the earlier one.
      expect(idleWakes(h.orm)[0]?.through_seq).toBeGreaterThan(0);
      expect(idleWakes(h.orm)[0]?.ready_at).toBe(new Date(ready * 1000).toISOString());
    } finally {
      h.close();
    }
  });

  it("rejects a malformed clock before consulting the scheduling callbacks", () => {
    const { h } = setup();
    let callbacks = 0;
    const options = {
      hasPending: () => {
        callbacks++;
        return false;
      },
      enqueue: () => {
        callbacks++;
        throw new Error("invalid clock must not enqueue");
      },
    };
    try {
      for (const input of [{ nowSeconds: -1 }, { nowSeconds: 1.5 }, {}]) {
        expect(() => sweepQqIdleTopics(h.orm, input as { nowSeconds: number }, options)).toThrow(
          TypeError,
        );
      }
      expect(callbacks).toBe(0);
      expect(idleWakes(h.orm)).toEqual([]);
    } finally {
      h.close();
    }
  });
});

// §11.1's 原因可追踪 (0030): the sweep's reasons are state, not just a return value.
describe("why a conversation stayed silent is written down", () => {
  it("stores the gate's own reason, its baseline and the time it will lift", () => {
    const { h } = setup();
    try {
      const early = now + 14 * 60;
      sweepCurrentAdapter(h.orm, { nowSeconds: early });
      const [row] = readQqSweepVerdicts(h.orm);
      expect(row).toMatchObject({
        conversationKind: "group",
        peerId: "30003",
        outcome: "skipped",
        reason: "not_quiet_yet",
        // The newest partner message the decision was based on, and the moment the quiet window
        // the scheme asks for (15 minutes) actually elapses.
        observedAtSeconds: now - 40,
        readyAtSeconds: now - 40 + 15 * 60,
        decidedAtSeconds: early,
      });
      // The next pass decides differently; the row is the LAST verdict, not a history.
      const ready = now + 15 * 60;
      sweepCurrentAdapter(h.orm, { nowSeconds: ready });
      const [after] = readQqSweepVerdicts(h.orm);
      expect(after).toMatchObject({
        outcome: "scheduled",
        reason: null,
        observedAtSeconds: now - 40,
        decidedAtSeconds: ready,
      });
      expect(readQqSweepVerdicts(h.orm)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("keeps one row per conversation and drops the ones no longer bound", () => {
    const { h } = setup({ peers: ["30003", "30004"] });
    try {
      // Still inside the quiet window, so the rows exist without a candidate (a candidate holds a
      // foreign key to its binding, which would make unbinding a delete-order problem).
      const early = now + 14 * 60;
      sweepCurrentAdapter(h.orm, { nowSeconds: early });
      expect(
        readQqSweepVerdicts(h.orm)
          .map((row) => row.peerId)
          .sort(),
      ).toEqual(["30003", "30004"]);
      h.orm.delete(schema.qqBindings).where(eq(schema.qqBindings.peerId, "30004")).run();
      sweepCurrentAdapter(h.orm, { nowSeconds: early + 1 });
      // A group the user disconnected must not keep a reason that reads as if it were live.
      expect(readQqSweepVerdicts(h.orm).map((row) => row.peerId)).toEqual(["30003"]);
      // With nothing bound at all the table empties rather than keeping orphans.
      h.orm.delete(schema.qqBindings).run();
      sweepCurrentAdapter(h.orm, { nowSeconds: early + 2 });
      expect(readQqSweepVerdicts(h.orm)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("refuses a skipped verdict with no reason, in the contract and in the table", () => {
    const { h } = setup();
    try {
      const base = {
        conversationKey: JSON.stringify(["qq", "10001", "group", "30003"]),
        kind: "group" as const,
        peerId: "30003",
        observedAtSeconds: now - 40,
        readyAtSeconds: null,
      };
      expect(() =>
        recordQqSweepVerdicts(h.orm, {
          nowSeconds: now,
          verdicts: [{ ...base, outcome: "skipped" as const, reason: null }],
        }),
      ).toThrow(TypeError);
      expect(() =>
        recordQqSweepVerdicts(h.orm, {
          nowSeconds: now,
          verdicts: [{ ...base, outcome: "scheduled" as const, reason: "trigger_off" }],
        }),
      ).toThrow(TypeError);
      // The table itself refuses it too, so a row written by some other path cannot lie.
      expect(() =>
        h.db
          .query(
            "INSERT INTO qq_sweep_verdicts (conversation_key, conversation_kind, peer_id, outcome, reason, decided_at_seconds) VALUES (?, 'group', '30003', 'skipped', NULL, ?)",
          )
          .run(base.conversationKey, now),
      ).toThrow();
      expect(readQqSweepVerdicts(h.orm)).toEqual([]);
    } finally {
      h.close();
    }
  });
});

/**
 * Captures the SQL a pass prepares, so a case can assert the SHAPE of what it wrote rather than
 * only the rows it left behind. The repository reaches SQLite through bun:sqlite's `prepare`, which
 * is also the seam the product's own query spy uses. Only the verdict table's statements are kept.
 */
function verdictStatements(h: ReturnType<typeof setup>["h"]) {
  const trace = spyOn(h.db, "prepare");
  return {
    sql: () =>
      (trace.mock.calls as unknown as [string, ...unknown[]][])
        .map((call) => String(call[0]).replace(/\s+/g, " ").trim())
        .filter((statement) => statement.includes("qq_sweep_verdicts")),
    clear: () => {
      trace.mockClear();
    },
    restore: () => {
      trace.mockRestore();
    },
  };
}

// S4: the sweep writes the DIFF, not the whole table. A pass that reaches the same verdicts must
// not delete-and-rewrite every row; only a verdict that moved, or the pass clock, is written.
describe("a sweep writes only what moved", () => {
  it("keeps a conversation's verdict and only refreshes the pass clock", () => {
    const { h } = setup();
    try {
      const at = now + 14 * 60;
      sweepCurrentAdapter(h.orm, { nowSeconds: at });
      const [before] = readQqSweepVerdicts(h.orm);
      expect(before).toMatchObject({ outcome: "skipped", reason: "not_quiet_yet" });
      const trace = verdictStatements(h);
      try {
        const next = at + 5;
        sweepCurrentAdapter(h.orm, { nowSeconds: next });
        const statements = trace.sql();
        // One read, then the single-column clock update: no delete, no insert, and no full-row
        // rewrite anywhere.
        expect(statements.filter((s) => s.startsWith("delete"))).toEqual([]);
        expect(statements.filter((s) => s.startsWith("insert"))).toEqual([]);
        expect(statements.filter((s) => s.startsWith('update "qq_sweep_verdicts"'))).toEqual([
          'update "qq_sweep_verdicts" set "decided_at_seconds" = ? where "qq_sweep_verdicts"."conversation_key" = ?',
        ]);
        expect(statements.filter((s) => s.startsWith("select"))).toHaveLength(1);
        const [after] = readQqSweepVerdicts(h.orm);
        expect(after).toEqual({ ...before, decidedAtSeconds: next });
        // Last-swept reads the newest decided_at_seconds, so the pass stays real-time instead of
        // freezing at the moment the verdict last changed.
        expect(readQqSweepVerdicts(h.orm)[0]?.decidedAtSeconds).toBe(next);
      } finally {
        trace.restore();
      }
    } finally {
      h.close();
    }
  });

  it("issues no write at all when the pass and its verdicts are identical", () => {
    const { h } = setup();
    try {
      const at = now + 14 * 60;
      const verdict = {
        conversationKey: JSON.stringify(["qq", "10001", "group", "30003"]),
        kind: "group" as const,
        peerId: "30003",
        outcome: "skipped" as const,
        reason: "not_quiet_yet" as const,
        observedAtSeconds: now - 40,
        readyAtSeconds: now + 860,
      };
      recordQqSweepVerdicts(h.orm, { nowSeconds: at, verdicts: [verdict] });
      const trace = verdictStatements(h);
      try {
        const totalChanges = () =>
          (h.db.query("SELECT total_changes() AS n").get() as { n: number }).n;
        const before = totalChanges();
        recordQqSweepVerdicts(h.orm, { nowSeconds: at, verdicts: [verdict] });
        expect(trace.sql().filter((s) => !s.startsWith("select"))).toEqual([]);
        // total_changes() would also count a delete that matched no row, so a zero delta is the
        // strongest form of "this pass wrote nothing".
        expect(totalChanges() - before).toBe(0);
        expect(readQqSweepVerdicts(h.orm)).toEqual([
          expect.objectContaining({ decidedAtSeconds: at }),
        ]);
      } finally {
        trace.restore();
      }
    } finally {
      h.close();
    }
  });

  it("rewrites a verdict whose reason and clocks changed", () => {
    const { h } = setup();
    try {
      const base = {
        conversationKey: JSON.stringify(["qq", "10001", "group", "30003"]),
        kind: "group" as const,
        peerId: "30003",
      };
      recordQqSweepVerdicts(h.orm, {
        nowSeconds: now,
        verdicts: [
          {
            ...base,
            outcome: "skipped",
            reason: "not_quiet_yet",
            observedAtSeconds: now - 40,
            readyAtSeconds: now + 860,
          },
        ],
      });
      const trace = verdictStatements(h);
      try {
        recordQqSweepVerdicts(h.orm, {
          nowSeconds: now + 1,
          verdicts: [
            {
              ...base,
              outcome: "skipped",
              reason: "cooling_down",
              observedAtSeconds: now - 10,
              readyAtSeconds: now + 900,
            },
          ],
        });
        const statements = trace.sql();
        expect(statements.filter((s) => s.startsWith("insert"))).toEqual([]);
        expect(statements.filter((s) => s.startsWith("delete"))).toEqual([]);
        const updates = statements.filter((s) => s.startsWith('update "qq_sweep_verdicts"'));
        expect(updates).toHaveLength(1);
        // A changed verdict rewrites the row, not only the clock column.
        expect(updates[0]).toContain('"reason" = ?');
        expect(updates[0]).toContain('"decided_at_seconds" = ?');
        expect(readQqSweepVerdicts(h.orm)[0]).toMatchObject({
          outcome: "skipped",
          reason: "cooling_down",
          observedAtSeconds: now - 10,
          readyAtSeconds: now + 900,
          decidedAtSeconds: now + 1,
        });
      } finally {
        trace.restore();
      }
    } finally {
      h.close();
    }
  });

  it("keeps the other conversations' rows when one is unbound and rebound", () => {
    const { h, scheme } = setup({ peers: ["30003", "30004"] });
    try {
      const early = now + 14 * 60;
      sweepCurrentAdapter(h.orm, { nowSeconds: early });
      const readRows = () => new Map(readQqSweepVerdicts(h.orm).map((row) => [row.peerId, row]));
      const rowFor = (rows: ReturnType<typeof readRows>, peerId: string) => {
        const row = rows.get(peerId);
        if (row === undefined) throw new Error(`no verdict row for ${peerId}`);
        return row;
      };
      const before = readRows();
      expect([...before.keys()].sort()).toEqual(["30003", "30004"]);
      const trace = verdictStatements(h);
      try {
        // Unbinding one group removes exactly its row; the untouched group only refreshes its clock.
        h.orm.delete(schema.qqBindings).where(eq(schema.qqBindings.peerId, "30004")).run();
        sweepCurrentAdapter(h.orm, { nowSeconds: early + 1 });
        const afterUnbind = trace.sql();
        expect(afterUnbind.filter((s) => s.startsWith("delete"))).toHaveLength(1);
        expect(afterUnbind.filter((s) => s.startsWith("insert"))).toEqual([]);
        expect(afterUnbind.filter((s) => s.startsWith('update "qq_sweep_verdicts"'))).toHaveLength(
          1,
        );
        expect([...readRows().keys()]).toEqual(["30003"]);
        expect(rowFor(readRows(), "30003")).toEqual({
          ...rowFor(before, "30003"),
          decidedAtSeconds: early + 1,
        });
        // Re-binding the same peer comes back as a fresh verdict, and the other group is still only
        // clock-refreshed: one conversation leaving cannot disturb its neighbours.
        h.orm
          .insert(schema.qqBindings)
          .values({
            id: otherBindingId,
            accountId: "10001",
            conversationKind: "group",
            peerId: "30004",
            agentId,
            schemeId: scheme.id,
            paused: 0,
            shareWebMemory: 0,
            memoryBatchSize: null,
            ownerIdentityRevision: null,
            revision: 1,
            authorityRevision: 1,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
          .run();
        trace.clear();
        sweepCurrentAdapter(h.orm, { nowSeconds: early + 2 });
        const afterRebind = trace.sql();
        expect(afterRebind.filter((s) => s.startsWith("delete"))).toEqual([]);
        expect(afterRebind.filter((s) => s.startsWith("insert"))).toHaveLength(1);
        expect(afterRebind.filter((s) => s.startsWith('update "qq_sweep_verdicts"'))).toHaveLength(
          1,
        );
        expect([...readRows().keys()].sort()).toEqual(["30003", "30004"]);
        expect(rowFor(readRows(), "30003")).toEqual({
          ...rowFor(before, "30003"),
          decidedAtSeconds: early + 2,
        });
        expect(rowFor(readRows(), "30004")).toEqual({
          ...rowFor(before, "30004"),
          decidedAtSeconds: early + 2,
        });
        // A skipped verdict still has to name its reason, including on the fresh-insert path.
        expect(() =>
          recordQqSweepVerdicts(h.orm, {
            nowSeconds: early + 3,
            verdicts: [
              {
                conversationKey: JSON.stringify(["qq", "10001", "group", "30005"]),
                kind: "group",
                peerId: "30005",
                outcome: "skipped",
                reason: null,
                observedAtSeconds: null,
                readyAtSeconds: null,
              },
            ],
          }),
        ).toThrow(TypeError);
      } finally {
        trace.restore();
      }
    } finally {
      h.close();
    }
  });
});
