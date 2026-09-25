import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { type BusinessDbHandle, toOrmHandle } from "../../src/server/db/connection";
import {
  claimQqDispatchLease,
  forgetQqIdleJudgementsExcept,
  listQqDispatchCandidates,
  QQ_DISPATCH_LEASE_DEFAULT_SECONDS,
  QQ_DISPATCH_PENDING_GOVERNANCE,
  qqDispatchLeaseIsHeld,
  qqDispatchLeaseView,
  qqDispatchRenewSeconds,
  readQqDispatchCandidate,
  readQqDispatchLease,
  readQqDispatchSettings,
  readQqSweepVerdicts,
  reapExpiredQqDispatchLease,
  recordQqIdleJudgement,
  recordQqSweepVerdicts,
  releaseQqDispatchLease,
  removeQqDispatchCandidate,
  updateQqDispatchSettings,
  upsertQqDispatchCandidate,
} from "../../src/server/db/qq-dispatch-repository";
import { createQqScheme, readQqSchemes } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { recordQqSpeech } from "../../src/server/db/qq-speech-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { BUSINESS_SCHEMA_VERSION, openBusinessDb } from "../../src/server/db/schema-gate";
import { qqConversationKey } from "../../src/server/services/qq-binding-contract";
import {
  enqueueQqDispatchFromEvent,
  finishQqDispatchTask,
  nextQqDispatchTask,
  renewQqDispatchTask,
  sweepQqIdleTopics,
} from "../../src/server/services/qq-dispatch";
import { runQqDispatchCycle } from "../../src/server/services/qq-dispatch-cycle";

// The sticker stage's two seams, pinned to "no library copies": these cases are about the text
// path, so no sticker call may appear (P4i). `counts` is explicit because U13 has no default.
const stickerStage = { counts: ["confirmed"] as const, isAvailable: () => false };

/**
 * Best-effort temp cleanup. Windows can still hold the SQLite `-wal`/`-shm` files for a
 * moment after `close()`, and a leftover directory under the OS temp dir is not a test
 * failure — so retry briefly and then move on.
 */
function cleanup(dir: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(25);
    }
  }
}

const agentId = "00000000-0000-0000-0000-000000000001";
const bindingId = "11111111-1111-4111-8111-111111111111";
const otherBindingId = "22222222-2222-4222-8222-222222222222";
const now = 2_000_000_000;

function event(orm: Orm, key: string, at: number, text: string, peerId = "30003") {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey: key,
      accountId: "10001",
      conversationKind: "group",
      peerId,
      agentId,
      messageId: key,
      occurredAtSeconds: at,
      speakerKind: "member",
      speakerId: "20002",
      recordedAt: nowIso(),
    })
    .run();
  orm
    .insert(schema.qqObservationText)
    .values({
      eventKey: key,
      body: text,
      occurredAtSeconds: at,
      expiresAt: new Date((at + 3600) * 1000).toISOString(),
      recordedAt: nowIso(),
    })
    .run();
}

/** Seed one account, one scheme and one binding per peer, plus the source events. */
function seedConversation(orm: Orm, peers: string[] = ["30003"]) {
  ensureDefaults(orm, "synthetic-model");
  updateQqSettings(orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(orm, {
    name: "synthetic",
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: true },
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

/**
 * A migrated in-memory image, cloned per case.
 *
 * Every case below needs a fully migrated database and the business chain is 23 files, so the
 * whole file would otherwise spend ~12 s replaying migrations. Cloning the image of one
 * migrated database keeps the same schema, the same constraints and the same enforcement while
 * skipping the replay.
 *
 * `PRAGMA foreign_keys` is per CONNECTION and is NOT carried by the image, so it is re-applied
 * on every clone exactly as `connection.ts` does — the ordering guarantees in these tests rely
 * on it being ON.
 */
const migratedImage = (() => {
  const h = openBusinessDb();
  const image = h.db.serialize();
  h.close();
  return image;
})();

function cloneBusinessDb(): BusinessDbHandle {
  const db = Database.deserialize(migratedImage);
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  return toOrmHandle(db);
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

const enqueue = (overrides: Record<string, unknown> = {}) => ({
  bindingId,
  conversationKind: "group" as const,
  speaker: "member" as const,
  mentionsSelf: false,
  observedAtSeconds: now - 40,
  nowSeconds: now,
  mergeWindowSeconds: 30,
  ...overrides,
});

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
        upsertQqDispatchCandidate(h.orm, {
          conversationKey: "orphan",
          bindingId: "00000000-0000-4000-8000-000000000000",
          path: "chiming_in",
          readyAtSeconds: 0,
          observedAtSeconds: 0,
        }),
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

describe("P3 dispatch settings", () => {
  it("seeds the decided default lease and guards it with a revision", () => {
    const h = cloneBusinessDb();
    try {
      expect(readQqDispatchSettings(h.orm)).toEqual({
        id: 1,
        leaseSeconds: QQ_DISPATCH_LEASE_DEFAULT_SECONDS,
        revision: 1,
      });
      const updated = updateQqDispatchSettings(h.orm, { leaseSeconds: 300, expectedRevision: 1 });
      expect(updated).toEqual({ id: 1, leaseSeconds: 300, revision: 2 });
      expect(updateQqDispatchSettings(h.orm, { leaseSeconds: 300, expectedRevision: 2 })).toEqual(
        updated,
      );
      expect(() =>
        updateQqDispatchSettings(h.orm, { leaseSeconds: 60, expectedRevision: 1 }),
      ).toThrow();
      for (const leaseSeconds of [29, 601, 0, -1]) {
        expect(() =>
          updateQqDispatchSettings(h.orm, { leaseSeconds, expectedRevision: 2 }),
        ).toThrow();
      }
    } finally {
      h.close();
    }
  });

  it("renews at a quarter of the lease, capped at 30 s and floored at 1 s", () => {
    expect(qqDispatchRenewSeconds(120)).toBe(30);
    expect(qqDispatchRenewSeconds(600)).toBe(30);
    expect(qqDispatchRenewSeconds(60)).toBe(15);
    expect(qqDispatchRenewSeconds(30)).toBe(7);
    expect(qqDispatchRenewSeconds(3)).toBe(1);
  });
});

describe("conservative event-driven enqueue", () => {
  it("keeps a direct @ on the immediate path instead of the queue", () => {
    const { h } = setup();
    try {
      expect(enqueueQqDispatchFromEvent(h.orm, enqueue({ mentionsSelf: true }))).toEqual({
        kind: "not_scheduled",
        reason: "handled_directly",
      });
      expect(listQqDispatchCandidates(h.orm)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("turns a plain group message into a single chiming-in candidate", () => {
    const { h } = setup();
    try {
      const result = enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      expect(result).toEqual({
        kind: "scheduled",
        conversationKey: expect.any(String),
        path: "chiming_in",
        generation: 1,
        readyAtSeconds: now + 30,
      });
      const rows = listQqDispatchCandidates(h.orm);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.claimedGeneration).toBeNull();
    } finally {
      h.close();
    }
  });

  it("under the hard attention mode only the listed speakers become candidates", () => {
    const { h } = setup();
    try {
      // 0031: the list is the gate, and the speaker is matched by their stable id.
      h.orm
        .update(schema.qqBindings)
        .set({ attentionMode: "hard", attentionMembers: JSON.stringify(["20002"]) })
        .where(eq(schema.qqBindings.id, bindingId))
        .run();
      expect(
        enqueueQqDispatchFromEvent(
          h.orm,
          enqueue({ eventKey: "latest-30003", speakerId: "99999" }),
        ),
      ).toEqual({ kind: "not_scheduled", reason: "attention_filtered" });
      expect(listQqDispatchCandidates(h.orm)).toEqual([]);
      // The listed speaker is unaffected, and the soft mode would never filter at all.
      expect(
        enqueueQqDispatchFromEvent(
          h.orm,
          enqueue({ eventKey: "latest-30003", speakerId: "20002" }),
        ),
      ).toEqual({
        kind: "scheduled",
        conversationKey: expect.any(String),
        path: "chiming_in",
        generation: 1,
        readyAtSeconds: now + 30,
      });
    } finally {
      h.close();
    }
  });

  it("classifies a private message as a direct reply and ignores system speech", () => {
    const { h } = setup();
    try {
      expect(enqueueQqDispatchFromEvent(h.orm, enqueue({ conversationKind: "private" }))).toEqual({
        kind: "not_scheduled",
        reason: "handled_directly",
      });
      expect(enqueueQqDispatchFromEvent(h.orm, enqueue({ speaker: "system" }))).toEqual({
        kind: "not_scheduled",
        reason: "system_message",
      });
      expect(enqueueQqDispatchFromEvent(h.orm, enqueue({ speaker: "anonymous" }))).toEqual({
        kind: "not_scheduled",
        reason: "not_classified",
      });
    } finally {
      h.close();
    }
  });

  it("does not queue a follow-up the reply chain cannot run yet", () => {
    const { h } = setup();
    try {
      expect(
        enqueueQqDispatchFromEvent(
          h.orm,
          enqueue({ conversationKind: "group", followsAssistant: true }),
        ),
      ).toEqual({ kind: "not_scheduled", reason: "follow_up_unwired" });
    } finally {
      h.close();
    }
  });

  it("accepts a verified quiet-room candidate and rejects a missing binding", () => {
    const { h } = setup();
    try {
      expect(enqueueQqDispatchFromEvent(h.orm, enqueue({ initiativePath: "idle_topic" }))).toEqual({
        kind: "scheduled",
        conversationKey: expect.any(String),
        path: "idle_topic",
        generation: 1,
        readyAtSeconds: now + 30,
      });
      expect(
        enqueueQqDispatchFromEvent(
          h.orm,
          enqueue({ bindingId: "33333333-3333-4333-8333-333333333333" }),
        ),
      ).toEqual({ kind: "not_scheduled", reason: "binding_missing" });
    } finally {
      h.close();
    }
  });

  it("keeps one latest candidate per conversation and never lets the window shorten", () => {
    const { h } = setup();
    try {
      enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      const second = enqueueQqDispatchFromEvent(
        h.orm,
        enqueue({ eventKey: "latest-30003", nowSeconds: now + 10, mergeWindowSeconds: 30 }),
      );
      expect(second).toMatchObject({ kind: "scheduled", generation: 2, readyAtSeconds: now + 40 });
      const third = enqueueQqDispatchFromEvent(
        h.orm,
        enqueue({ eventKey: "latest-30003", nowSeconds: now + 5, mergeWindowSeconds: 300 }),
      );
      expect(third).toMatchObject({ kind: "scheduled", generation: 3 });
      expect(listQqDispatchCandidates(h.orm)).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

describe("global single-task lease", () => {
  it("waits for ready_at, then hands out exactly one task", () => {
    const { h } = setup();
    try {
      enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      expect(nextQqDispatchTask(h.orm, now)).toBeNull();
      const task = nextQqDispatchTask(h.orm, now + 30);
      expect(task).toMatchObject({
        conversationKey: expect.any(String),
        bindingId,
        path: "chiming_in",
        generation: 1,
        leaseSeconds: QQ_DISPATCH_LEASE_DEFAULT_SECONDS,
      });
      expect(task?.token.length).toBeGreaterThan(0);
      // A live lease blocks every other conversation until it is released.
      expect(nextQqDispatchTask(h.orm, now + 31)).toBeNull();
      expect(qqDispatchLeaseIsHeld(readQqDispatchLease(h.orm), now + 31)).toBe(true);
      expect(releaseQqDispatchLease(h.orm, task?.token ?? "")).toBe(true);
      expect(nextQqDispatchTask(h.orm, now + 31)?.token).not.toBe(task?.token);
    } finally {
      h.close();
    }
  });

  it("refuses a claim for a generation that was replaced meanwhile", () => {
    const { h } = setup();
    try {
      const scheduled = enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      if (scheduled.kind !== "scheduled") throw new Error("scheduled");
      const stale = claimQqDispatchLease(h.orm, {
        token: "stale-token",
        conversationKey: scheduled.conversationKey,
        generation: scheduled.generation,
        nowSeconds: now + 30,
        leaseSeconds: 120,
      });
      expect(stale).toBe(true);
      enqueueQqDispatchFromEvent(
        h.orm,
        enqueue({ eventKey: "latest-30003", nowSeconds: now + 31 }),
      );
      expect(
        readQqDispatchCandidate(h.orm, scheduled.conversationKey)?.claimedGeneration,
      ).toBeNull();
      releaseQqDispatchLease(h.orm, "stale-token");
    } finally {
      h.close();
    }
  });

  it("renews only its own live lease and never after it lapsed", () => {
    const { h } = setup();
    try {
      enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      const task = nextQqDispatchTask(h.orm, now + 30);
      if (!task) throw new Error("task");
      const expiresBefore = readQqDispatchLease(h.orm).expiresAtSeconds ?? 0;
      expect(renewQqDispatchTask(h.orm, { token: "not-mine", nowSeconds: now + 40 })).toBe(false);
      expect(renewQqDispatchTask(h.orm, { token: task.token, nowSeconds: now + 40 })).toBe(true);
      expect(readQqDispatchLease(h.orm).expiresAtSeconds ?? 0).toBe(now + 40 + task.leaseSeconds);
      expect(readQqDispatchLease(h.orm).expiresAtSeconds ?? 0).toBeGreaterThan(expiresBefore);
      // Past the expiry the lease belongs to nobody and must not be revived.
      expect(
        renewQqDispatchTask(h.orm, {
          token: task.token,
          nowSeconds: now + 40 + task.leaseSeconds,
        }),
      ).toBe(false);
      // Releasing is still allowed: the row names this token, so this process does own the slot.
      expect(releaseQqDispatchLease(h.orm, task.token)).toBe(true);
    } finally {
      h.close();
    }
  });

  it("scraps a lapsed lease and re-offers the candidate to the next caller", () => {
    const { h } = setup();
    try {
      enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      const first = nextQqDispatchTask(h.orm, now + 30);
      if (!first) throw new Error("task");
      const expiry = readQqDispatchLease(h.orm).expiresAtSeconds ?? 0;
      expect(reapExpiredQqDispatchLease(h.orm, expiry - 1)).toBeNull();
      expect(nextQqDispatchTask(h.orm, expiry - 1)).toBeNull();
      const second = nextQqDispatchTask(h.orm, expiry);
      expect(second?.token).not.toBe(first.token);
      // Same generation: the interrupted work was scrapped, not resumed, but the candidate is
      // still the conversation's latest event so it is judged again from current facts.
      expect(second?.generation).toBe(first.generation);
      expect(readQqDispatchCandidate(h.orm, first.conversationKey)?.claimedGeneration).toBe(
        first.generation,
      );
    } finally {
      h.close();
    }
  });

  it("lets a second process take over only after the first one's lease lapses", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ss-dispatch-"));
    const filename = path.join(dir, "dispatch.sqlite");
    const a = openBusinessDb({ path: filename });
    seedConversation(a.orm);
    const b = openBusinessDb({ path: filename });
    try {
      enqueueQqDispatchFromEvent(a.orm, enqueue({ eventKey: "latest-30003" }));
      const first = nextQqDispatchTask(a.orm, now + 30);
      if (!first) throw new Error("task");
      expect(nextQqDispatchTask(b.orm, now + 30)).toBeNull();
      const expiry = readQqDispatchLease(b.orm).expiresAtSeconds ?? 0;
      const second = nextQqDispatchTask(b.orm, expiry);
      expect(second?.token).not.toBe(first.token);
      expect(second?.conversationKey).toBe(first.conversationKey);
      expect(renewQqDispatchTask(a.orm, { token: first.token, nowSeconds: expiry })).toBe(false);
    } finally {
      a.close();
      b.close();
      cleanup(dir);
    }
  });
});

describe("atomic submit guard", () => {
  it("authorises a current task, consumes it and releases the slot in one step", () => {
    const { h } = setup();
    try {
      const scheduled = enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      if (scheduled.kind !== "scheduled") throw new Error("scheduled");
      const task = nextQqDispatchTask(h.orm, now + 30);
      if (!task) throw new Error("task");
      let rechecks = 0;
      const commit = finishQqDispatchTask(h.orm, { ...task, nowSeconds: now + 31 }, () => {
        rechecks += 1;
        return { kind: "checks_passed" as const };
      });
      expect(commit).toEqual({ kind: "authorized" });
      expect(rechecks).toBe(1);
      expect(readQqDispatchCandidate(h.orm, scheduled.conversationKey)).toBeNull();
      expect(readQqDispatchLease(h.orm).token).toBeNull();
      expect(
        finishQqDispatchTask(h.orm, { ...task, nowSeconds: now + 32 }, () => ({
          kind: "checks_passed" as const,
        })),
      ).toEqual({ kind: "superseded", reason: "lease_lost" });
    } finally {
      h.close();
    }
  });

  it("blocks and consumes when the live facts changed, without retrying a stale draft", () => {
    const { h } = setup();
    try {
      const scheduled = enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      if (scheduled.kind !== "scheduled") throw new Error("scheduled");
      const task = nextQqDispatchTask(h.orm, now + 30);
      if (!task) throw new Error("task");
      const commit = finishQqDispatchTask(h.orm, { ...task, nowSeconds: now + 31 }, () => ({
        kind: "blocked" as const,
        reason: "binding_changed",
      }));
      expect(commit).toEqual({ kind: "blocked", reason: "binding_changed" });
      expect(readQqDispatchCandidate(h.orm, scheduled.conversationKey)).toBeNull();
      expect(readQqDispatchLease(h.orm).token).toBeNull();
    } finally {
      h.close();
    }
  });

  it("supersedes instead of authorising once a newer event replaced the candidate", () => {
    const { h } = setup();
    try {
      const scheduled = enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      if (scheduled.kind !== "scheduled") throw new Error("scheduled");
      const task = nextQqDispatchTask(h.orm, now + 30);
      if (!task) throw new Error("task");
      enqueueQqDispatchFromEvent(
        h.orm,
        enqueue({ eventKey: "latest-30003", nowSeconds: now + 31 }),
      );
      let rechecks = 0;
      const commit = finishQqDispatchTask(h.orm, { ...task, nowSeconds: now + 32 }, () => {
        rechecks += 1;
        return { kind: "checks_passed" as const };
      });
      expect(commit).toEqual({ kind: "superseded", reason: "candidate_moved" });
      // The live-fact probe never runs for a replaced candidate.
      expect(rechecks).toBe(0);
      expect(readQqDispatchCandidate(h.orm, scheduled.conversationKey)?.generation).toBe(2);
      releaseQqDispatchLease(h.orm, task.token);
    } finally {
      h.close();
    }
  });

  it("supersedes an expired lease and lets the re-judged candidate run", () => {
    const { h } = setup();
    try {
      enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      const task = nextQqDispatchTask(h.orm, now + 30);
      if (!task) throw new Error("task");
      const expiry = task.leaseSeconds + now + 30;
      expect(
        finishQqDispatchTask(h.orm, { ...task, nowSeconds: expiry }, () => ({
          kind: "checks_passed" as const,
        })),
      ).toEqual({ kind: "superseded", reason: "lease_expired" });
      const retried = nextQqDispatchTask(h.orm, expiry);
      expect(retried?.conversationKey).toBe(task.conversationKey);
    } finally {
      h.close();
    }
  });

  it("refuses a commit whose live-fact probe still wants a review", () => {
    const { h } = setup();
    try {
      enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      const task = nextQqDispatchTask(h.orm, now + 30);
      if (!task) throw new Error("task");
      expect(
        finishQqDispatchTask(h.orm, { ...task, nowSeconds: now + 31 }, () => ({
          kind: "review_required" as const,
        })),
      ).toEqual({ kind: "blocked", reason: "review_required" });
    } finally {
      h.close();
    }
  });
});

describe("dispatch cycle", () => {
  it("reports idle when nothing is ready", async () => {
    const { h } = setup();
    try {
      const result = await runQqDispatchCycle(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":3}' },
        { nowSeconds: now },
        stickerStage,
      );
      expect(result).toEqual({ kind: "idle" });
    } finally {
      h.close();
    }
  });

  it("runs the classified initiative under the lease and still never sends", async () => {
    const { h } = setup();
    let calls = 0;
    try {
      enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      const result = await runQqDispatchCycle(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => {
            calls += 1;
            return calls === 1 ? '{"score":8}' : "纯文字草稿";
          },
        },
        { nowSeconds: now + 30 },
        stickerStage,
      );
      expect(result).toMatchObject({ kind: "authorized", path: "chiming_in" });
      expect(calls).toBe(2);
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
      expect(listQqDispatchCandidates(h.orm)).toEqual([]);
      expect(readQqDispatchLease(h.orm).token).toBeNull();
    } finally {
      h.close();
    }
  });

  it("consumes the candidate on a silent judgement without retrying it", async () => {
    const { h } = setup();
    try {
      enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      const result = await runQqDispatchCycle(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":3}' },
        { nowSeconds: now + 30 },
        stickerStage,
      );
      expect(result).toEqual({ kind: "held", reason: "silent" });
      expect(listQqDispatchCandidates(h.orm)).toEqual([]);
      expect(readQqDispatchLease(h.orm).token).toBeNull();
    } finally {
      h.close();
    }
  });

  it("hands an authorized draft to the injected sender, and only then", async () => {
    const { h } = setup();
    const delivered: Array<{ text: string | null; shape: string; partCount: number }> = [];
    try {
      enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      let calls = 0;
      const result = await runQqDispatchCycle(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => {
            calls += 1;
            return calls === 1 ? '{"score":8}' : "纯文字草稿";
          },
        },
        { nowSeconds: now + 30 },
        stickerStage,
        async ({ prepared, plan }) => {
          delivered.push({
            text: prepared.text,
            shape: plan.kind === "planned" ? plan.shape : plan.kind,
            partCount: plan.kind === "planned" ? plan.parts.length : 0,
          });
          // The sender owns delivery; this stub reports "nothing was delivered".
          return null;
        },
      );
      // 0037: 一轮可能有好几条（每人一条），所以结果是 `deliveries` 列表；本夹具只有一个发言人。
      expect(result).toMatchObject({ kind: "authorized", deliveries: [null] });
      // No sticker was chosen (the stage reports everything unavailable), so the plan is the
      // text alone — the draft's own words, not a rewritten version.
      expect(delivered).toEqual([{ text: "纯文字草稿", shape: "text_only", partCount: 1 }]);
    } finally {
      h.close();
    }
  });

  it("never calls the sender for a task that was not authorized", async () => {
    const { h } = setup();
    let called = 0;
    try {
      enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      const result = await runQqDispatchCycle(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":3}' },
        { nowSeconds: now + 30 },
        stickerStage,
        async () => {
          called += 1;
          return null;
        },
      );
      expect(result).toEqual({ kind: "held", reason: "silent" });
      expect(called).toBe(0);
    } finally {
      h.close();
    }
  });

  it("renews the lease while a slow model call is still running", async () => {
    const { h } = setup();
    try {
      enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      let calls = 0;
      const result = await runQqDispatchCycle(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => {
            calls += 1;
            if (calls === 1) {
              await new Promise((resolve) => setTimeout(resolve, 1200));
              return '{"score":8}';
            }
            return "纯文字草稿";
          },
        },
        { nowSeconds: now + 30, clockSeconds: () => now + 31, renewIntervalMs: 250 },
        stickerStage,
      );
      expect(result).toMatchObject({ kind: "authorized" });
      expect((result as { renewals: number }).renewals).toBeGreaterThan(0);
    } finally {
      h.close();
    }
  });

  it("refuses the whole task when the scheme switch closes mid-run", async () => {
    const { h } = setup();
    try {
      enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      let calls = 0;
      const result = await runQqDispatchCycle(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => {
            // The scheme stops allowing chiming-in while the draft is being produced.
            h.orm.update(schema.qqSchemes).set({ triggerChimingIn: 0 }).run();
            calls += 1;
            return calls === 1 ? '{"score":8}' : "纯文字草稿";
          },
        },
        { nowSeconds: now + 30 },
        stickerStage,
      );
      expect(result).toMatchObject({ kind: "held" });
      expect(listQqDispatchCandidates(h.orm)).toEqual([]);
      expect(readQqDispatchLease(h.orm).token).toBeNull();
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
      expect(sweepQqIdleTopics(h.orm, { nowSeconds: at })).toEqual({
        scheduled: [
          {
            kind: "scheduled",
            conversationKey: expect.any(String),
            path: "idle_topic",
            generation: 1,
            readyAtSeconds: at,
          },
        ],
        skipped: [],
      });
      const rows = listQqDispatchCandidates(h.orm);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.path).toBe("idle_topic");
      expect(rows[0]?.eventKey).toBeNull();
      expect(rows[0]?.observedAtSeconds).toBe(now - 40);
    } finally {
      h.close();
    }
  });

  it("waits the scheme's quiet time before offering an opener", () => {
    const { h } = setup();
    try {
      const early = now + 14 * 60;
      expect(sweepQqIdleTopics(h.orm, { nowSeconds: early })).toEqual({
        scheduled: [],
        skipped: [{ conversationKey: expect.any(String), reason: "not_quiet_yet" }],
      });
      expect(listQqDispatchCandidates(h.orm)).toEqual([]);
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
      expect(sweepQqIdleTopics(h.orm, { nowSeconds: now })).toEqual({
        scheduled: [],
        skipped: [{ conversationKey: expect.any(String), reason: "no_member_baseline" }],
      });
      // Naming the speaker who did talk makes the same fixture quiet-but-fresh instead.
      h.orm
        .update(schema.qqBindings)
        .set({ attentionMode: "hard", attentionMembers: JSON.stringify(["20002"]) })
        .where(eq(schema.qqBindings.id, bindingId))
        .run();
      expect(sweepQqIdleTopics(h.orm, { nowSeconds: now })).toEqual({
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
      const first = sweepQqIdleTopics(h.orm, { nowSeconds: at });
      expect(first.skipped).toEqual([]);
      expect(first.scheduled).toHaveLength(1);
      const conversationKey = first.scheduled[0]?.conversationKey ?? "";
      expect(conversationKey).not.toBe("");
      // The judgement ran and stayed silent: the cycle remembers the basis it judged (0033).
      recordQqIdleJudgement(h.orm, { conversationKey, basisSeconds: now - 40, nowSeconds: at });
      removeQqDispatchCandidate(h.orm, conversationKey);
      // The timed sweep must NOT judge the same basis again — this used to be a model call per pass.
      const second = sweepQqIdleTopics(h.orm, { nowSeconds: at + 60 });
      expect(second.scheduled).toEqual([]);
      expect(second.skipped).toEqual([{ conversationKey, reason: "already_judged" }]);
      // A newer member message moves the basis, so the conversation may be judged again.
      event(h.orm, "newer-message", at + 30, "又有人说话了");
      const third = sweepQqIdleTopics(h.orm, { nowSeconds: at + 90 });
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
      expect(sweepQqIdleTopics(h.orm, { nowSeconds: at })).toEqual({
        scheduled: [],
        skipped: [{ conversationKey: expect.any(String), reason: "no_member_baseline" }],
      });
      expect(listQqDispatchCandidates(h.orm)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("does not chase a conversation after its own unprompted speech was ignored", () => {
    const { h } = setup();
    try {
      recordOwnSpeech(h.orm, "30003", now - 10);
      const at = now + 15 * 60;
      expect(sweepQqIdleTopics(h.orm, { nowSeconds: at })).toEqual({
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
      expect(sweepQqIdleTopics(h.orm, { nowSeconds: at }).scheduled).toHaveLength(1);
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
        const result = sweepQqIdleTopics(h.orm, { nowSeconds: at });
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
      expect(sweepQqIdleTopics(outside.h.orm, { nowSeconds: at }).skipped).toEqual([
        { conversationKey: expect.any(String), reason: "outside_active_hours" },
      ]);
      expect(listQqDispatchCandidates(outside.h.orm)).toEqual([]);
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
      expect(sweepQqIdleTopics(inside.h.orm, { nowSeconds: at }).scheduled).toHaveLength(1);
    } finally {
      inside.h.close();
    }
  });

  it("does not re-enqueue a conversation that already holds a candidate", () => {
    const { h } = setup();
    try {
      const at = now + 15 * 60;
      const first = sweepQqIdleTopics(h.orm, { nowSeconds: at });
      expect(first.scheduled).toHaveLength(1);
      // Sweeping again must not bump the generation: that would invalidate in-flight work and
      // push ready_at forward for ever, starving the task the sweep itself created.
      const second = sweepQqIdleTopics(h.orm, { nowSeconds: at + 60 });
      expect(second.scheduled).toEqual([]);
      expect(second.skipped.map((s) => s.reason)).toEqual(["candidate_pending"]);
      expect(listQqDispatchCandidates(h.orm)[0]?.generation).toBe(1);
      expect(listQqDispatchCandidates(h.orm)[0]?.readyAtSeconds).toBe(at);
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
      expect(sweepQqIdleTopics(h.orm, { nowSeconds: early }).skipped).toEqual([
        { conversationKey: expect.any(String), reason: "not_quiet_yet" },
      ]);
      const ready = now + 100 + 15 * 60;
      expect(sweepQqIdleTopics(h.orm, { nowSeconds: ready }).scheduled).toHaveLength(1);
      // The candidate records the message it grew out of, not the earlier one.
      expect(listQqDispatchCandidates(h.orm)[0]?.observedAtSeconds).toBe(now + 100);
      expect(listQqDispatchCandidates(h.orm)[0]?.readyAtSeconds).toBe(ready);
    } finally {
      h.close();
    }
  });

  it("rejects a malformed clock instead of guessing one", () => {
    const { h } = setup();
    try {
      expect(() => sweepQqIdleTopics(h.orm, { nowSeconds: -1 })).toThrow();
      expect(() =>
        sweepQqIdleTopics(h.orm, { nowSeconds: 1.5 } as { nowSeconds: number }),
      ).toThrow();
      expect(() => sweepQqIdleTopics(h.orm, {} as unknown as { nowSeconds: number })).toThrow();
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
      sweepQqIdleTopics(h.orm, { nowSeconds: early });
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
      sweepQqIdleTopics(h.orm, { nowSeconds: ready });
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
      sweepQqIdleTopics(h.orm, { nowSeconds: early });
      expect(
        readQqSweepVerdicts(h.orm)
          .map((row) => row.peerId)
          .sort(),
      ).toEqual(["30003", "30004"]);
      h.orm.delete(schema.qqBindings).where(eq(schema.qqBindings.peerId, "30004")).run();
      sweepQqIdleTopics(h.orm, { nowSeconds: early + 1 });
      // A group the user disconnected must not keep a reason that reads as if it were live.
      expect(readQqSweepVerdicts(h.orm).map((row) => row.peerId)).toEqual(["30003"]);
      // With nothing bound at all the table empties rather than keeping orphans.
      h.orm.delete(schema.qqBindings).run();
      sweepQqIdleTopics(h.orm, { nowSeconds: early + 2 });
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

describe("the undecided silence accounting stays absent", () => {
  it("records U13 as undecided and exposes no counter for it", () => {
    expect(QQ_DISPATCH_PENDING_GOVERNANCE.item).toBe("U13");
    expect([...QQ_DISPATCH_PENDING_GOVERNANCE.undecided]).toEqual([
      "failure_counts_against_silence",
      "unknown_counts_against_silence",
    ]);
    const source = readFileSync(
      path.join(import.meta.dir, "../../src/server/services/qq-dispatch.ts"),
      "utf8",
    );
    expect(source).not.toContain("failureCount");
    expect(source).not.toContain("noResponse");
  });

  it("keeps the token out of the diagnostic view", () => {
    const { h } = setup();
    try {
      enqueueQqDispatchFromEvent(h.orm, enqueue({ eventKey: "latest-30003" }));
      const task = nextQqDispatchTask(h.orm, now + 30);
      if (!task) throw new Error("task");
      const view = qqDispatchLeaseView(h.orm, now + 31);
      expect(view.held).toBe(true);
      expect(Object.keys(view)).not.toContain("token");
    } finally {
      h.close();
    }
  });
});

// A guard against a helper drifting back to an in-memory-only claim.
describe("the lease is real state, not process memory", () => {
  it("keeps the claim across a fresh database handle", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ss-dispatch2-"));
    const filename = path.join(dir, "dispatch.sqlite");
    const a = openBusinessDb({ path: filename });
    seedConversation(a.orm);
    try {
      enqueueQqDispatchFromEvent(a.orm, enqueue({ eventKey: "latest-30003" }));
      const task = nextQqDispatchTask(a.orm, now + 30);
      if (!task) throw new Error("task");
      const b = openBusinessDb({ path: filename });
      try {
        expect(readQqDispatchLease(b.orm).token).toBe(task.token);
        expect(readQqDispatchCandidate(b.orm, task.conversationKey)?.claimedGeneration).toBe(
          task.generation,
        );
        expect(
          finishQqDispatchTask(b.orm, { ...task, nowSeconds: now + 31 }, () => ({
            kind: "checks_passed" as const,
          })),
        ).toEqual({ kind: "authorized" });
      } finally {
        b.close();
      }
    } finally {
      a.close();
      cleanup(dir);
    }
  });
});

// The helper above is only meaningful if a raw connection agrees.
describe("dispatch tables are ordinary SQLite state", () => {
  it("an unrelated connection sees the candidate row", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ss-dispatch3-"));
    const filename = path.join(dir, "dispatch.sqlite");
    const a = openBusinessDb({ path: filename });
    seedConversation(a.orm);
    try {
      enqueueQqDispatchFromEvent(a.orm, enqueue({ eventKey: "latest-30003" }));
      const raw = new Database(filename, { readonly: true });
      try {
        const row = raw.query("SELECT count(*) AS n FROM qq_dispatch_candidates").get() as {
          n: number;
        };
        expect(row.n).toBe(1);
      } finally {
        raw.close();
      }
    } finally {
      a.close();
      cleanup(dir);
    }
  });
});
