// P3 durable QQ dispatch (`qq_dispatch_*`, migration 0023).
//
// What this module is: the persistence half of "one global QQ model task at a time,
// one latest candidate per conversation". A single-row lease table bounds concurrency
// across processes; candidate rows hold only identities and clocks.
//
// What it is not: it never composes a prompt, calls a model or touches a transport, and
// it never records reply text or a platform request. `claim`/`commit` decide *who may
// run*; whether a message may be sent stays with `checkQqTextPreflight` and the scheme
// switches, and no decision here is permission to use OneBot.
//
// Atomicity: every read-decide-write sequence runs inside `BEGIN IMMEDIATE` on this
// single-writer local database, so two processes cannot both observe a free lease.

import { asc, desc, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import {
  QQ_SWEEP_VERDICT_LIMIT,
  type QqIdleSweepSkipReason,
  QqIdleSweepSkipReasonSchema,
} from "../../shared/contracts/qq";
import { fail } from "../errors";
import { newId, type Orm } from "./repositories";
import * as schema from "./schema";

export type QqDispatchSettingsRow = typeof schema.qqDispatchSettings.$inferSelect;
export type QqDispatchCandidateRow = typeof schema.qqDispatchCandidates.$inferSelect;
export type QqDispatchLeaseRow = typeof schema.qqDispatchLease.$inferSelect;
export type QqSweepVerdictRow = typeof schema.qqSweepVerdicts.$inferSelect;

/**
 * The lease bounds the user chose on 2026-09-24: default 120 s, editable 30–600 s, and a
 * renewal every quarter of the lease capped at 30 s. A long model call keeps renewing, so
 * only a process that actually disappeared lets the lease lapse.
 */
export const QQ_DISPATCH_LEASE_DEFAULT_SECONDS = 120;
export const QQ_DISPATCH_LEASE_MIN_SECONDS = 30;
export const QQ_DISPATCH_LEASE_MAX_SECONDS = 600;
export const QQ_DISPATCH_RENEW_MAX_SECONDS = 30;

/** Quarter of the lease, never above 30 s and never below 1 s. */
export function qqDispatchRenewSeconds(leaseSeconds: number): number {
  return Math.min(QQ_DISPATCH_RENEW_MAX_SECONDS, Math.max(1, Math.floor(leaseSeconds / 4)));
}

/**
 * U13 (what a failed or unanswered attempt counts as) is explicitly undecided in the plan.
 * Trying to answer it here would silently change the user's own pacing numbers, so it is
 * recorded as absent data and a test asserts no such surface exists.
 */
export const QQ_DISPATCH_PENDING_GOVERNANCE = Object.freeze({
  item: "U13",
  undecided: Object.freeze([
    "failure_counts_against_silence",
    "unknown_counts_against_silence",
  ] as const),
});

/** The lease paths the queue may carry. Direct `@` replies stay on the immediate path. */
export const QQ_DISPATCH_QUEUE_PATHS = Object.freeze(["chiming_in", "idle_topic"] as const);
const StoredPath = z.enum(["direct_reply", "follow_up", "chiming_in", "idle_topic"]);

export function readQqDispatchSettings(orm: Orm): QqDispatchSettingsRow {
  const row = orm
    .select()
    .from(schema.qqDispatchSettings)
    .where(eq(schema.qqDispatchSettings.id, 1))
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return row;
}

export interface QqDispatchSettingsUpdate {
  leaseSeconds: number;
  expectedRevision: number;
}

/** Compare-and-swap on the single row, same revision discipline as every other settings surface. */
export function updateQqDispatchSettings(
  orm: Orm,
  input: QqDispatchSettingsUpdate,
): QqDispatchSettingsRow {
  const parsed = z
    .strictObject({
      leaseSeconds: z
        .number()
        .int()
        .min(QQ_DISPATCH_LEASE_MIN_SECONDS)
        .max(QQ_DISPATCH_LEASE_MAX_SECONDS),
      expectedRevision: z.number().int().positive(),
    })
    .safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ dispatch settings input");
  const current = readQqDispatchSettings(orm);
  if (current.revision !== parsed.data.expectedRevision) {
    fail("MEMORY_STATE_CONFLICT", "设置已变化，请重新加载后保存");
  }
  if (current.leaseSeconds === parsed.data.leaseSeconds) return current;
  const row = orm
    .update(schema.qqDispatchSettings)
    .set({ leaseSeconds: parsed.data.leaseSeconds, revision: current.revision + 1 })
    .where(eq(schema.qqDispatchSettings.id, 1))
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return row;
}

export function readQqDispatchCandidate(
  orm: Orm,
  conversationKey: string,
): QqDispatchCandidateRow | null {
  return (
    orm
      .select()
      .from(schema.qqDispatchCandidates)
      .where(eq(schema.qqDispatchCandidates.conversationKey, conversationKey))
      .get() ?? null
  );
}

/** Ready candidates first, oldest `ready_at` first, then by key so the order is total. */
export function listQqDispatchCandidates(orm: Orm): QqDispatchCandidateRow[] {
  return orm
    .select()
    .from(schema.qqDispatchCandidates)
    .orderBy(
      asc(schema.qqDispatchCandidates.readyAtSeconds),
      asc(schema.qqDispatchCandidates.conversationKey),
    )
    .all();
}

export interface QqDispatchEnqueue {
  conversationKey: string;
  bindingId: string;
  eventKey?: string | null;
  path: z.infer<typeof StoredPath>;
  readyAtSeconds: number;
  observedAtSeconds: number;
}

/**
 * Write the conversation's single latest candidate.
 *
 * A new event REPLACES the previous one: `generation` increments and the claim marker is
 * cleared, so whatever the previous generation was doing can no longer commit. If the
 * conversation is already inside its merge window the not-before time only moves forward.
 */
export function upsertQqDispatchCandidate(
  orm: Orm,
  input: QqDispatchEnqueue,
): QqDispatchCandidateRow {
  const parsed = z
    .strictObject({
      conversationKey: z.string().trim().min(1),
      bindingId: z.uuid(),
      eventKey: z.string().trim().min(1).nullable().optional(),
      path: StoredPath,
      readyAtSeconds: z.number().int().nonnegative(),
      observedAtSeconds: z.number().int().nonnegative(),
    })
    .safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ dispatch candidate input");
  const value = parsed.data;
  return orm.transaction(
    (tx) => {
      const existing = tx
        .select()
        .from(schema.qqDispatchCandidates)
        .where(eq(schema.qqDispatchCandidates.conversationKey, value.conversationKey))
        .get();
      if (!existing) {
        const inserted = tx
          .insert(schema.qqDispatchCandidates)
          .values({
            conversationKey: value.conversationKey,
            bindingId: value.bindingId,
            eventKey: value.eventKey ?? null,
            path: value.path,
            readyAtSeconds: value.readyAtSeconds,
            observedAtSeconds: value.observedAtSeconds,
            generation: 1,
            claimedGeneration: null,
          })
          .returning()
          .get();
        if (!inserted) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
        return inserted;
      }
      const updated = tx
        .update(schema.qqDispatchCandidates)
        .set({
          bindingId: value.bindingId,
          eventKey: value.eventKey ?? null,
          path: value.path,
          readyAtSeconds: Math.max(existing.readyAtSeconds, value.readyAtSeconds),
          observedAtSeconds: value.observedAtSeconds,
          generation: existing.generation + 1,
          claimedGeneration: null,
        })
        .where(eq(schema.qqDispatchCandidates.conversationKey, value.conversationKey))
        .returning()
        .get();
      if (!updated) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
      return updated;
    },
    { behavior: "immediate" },
  );
}

/**
 * Drop a conversation's candidate. The lease row names the candidate it points at, so any
 * lease still pointing here is cleared first — the foreign key is ON and deleting a
 * referenced row is refused otherwise.
 */
export function removeQqDispatchCandidate(orm: Orm, conversationKey: string): boolean {
  return orm.transaction(
    (tx) => {
      const held = tx
        .select()
        .from(schema.qqDispatchLease)
        .where(eq(schema.qqDispatchLease.id, 1))
        .get();
      if (held?.conversationKey === conversationKey) {
        tx.update(schema.qqDispatchLease)
          .set({ token: null, conversationKey: null, generation: null, expiresAtSeconds: null })
          .where(eq(schema.qqDispatchLease.id, 1))
          .run();
      }
      const removed = tx
        .delete(schema.qqDispatchCandidates)
        .where(eq(schema.qqDispatchCandidates.conversationKey, conversationKey))
        .returning()
        .all();
      return removed.length > 0;
    },
    { behavior: "immediate" },
  );
}

export function readQqDispatchLease(orm: Orm): QqDispatchLeaseRow {
  const row = orm
    .select()
    .from(schema.qqDispatchLease)
    .where(eq(schema.qqDispatchLease.id, 1))
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return row;
}

/** A lease is "held" while a live owner exists; `expiresAtSeconds === now` already lapsed. */
export function qqDispatchLeaseIsHeld(row: QqDispatchLeaseRow, nowSeconds: number): boolean {
  return row.token !== null && row.expiresAtSeconds !== null && row.expiresAtSeconds > nowSeconds;
}

export interface QqDispatchClaim {
  token: string;
  conversationKey: string;
  generation: number;
  nowSeconds: number;
  leaseSeconds: number;
}

/**
 * Take the global slot for one candidate generation, or refuse.
 *
 * Refused when the candidate was replaced since the caller read it, is not ready yet, or
 * another live lease is still running. An expired lease is taken over here — the plan's
 * decision is that a lapsed task is scrapped and re-judged rather than resumed.
 */
export function claimQqDispatchLease(orm: Orm, input: QqDispatchClaim): boolean {
  const parsed = z
    .strictObject({
      token: z.string().trim().min(1),
      conversationKey: z.string().trim().min(1),
      generation: z.number().int().positive(),
      nowSeconds: z.number().int().nonnegative(),
      leaseSeconds: z
        .number()
        .int()
        .min(QQ_DISPATCH_LEASE_MIN_SECONDS)
        .max(QQ_DISPATCH_LEASE_MAX_SECONDS),
    })
    .safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ dispatch claim input");
  const value = parsed.data;
  return orm.transaction(
    (tx) => {
      const candidate = tx
        .select()
        .from(schema.qqDispatchCandidates)
        .where(eq(schema.qqDispatchCandidates.conversationKey, value.conversationKey))
        .get();
      if (!candidate || candidate.generation !== value.generation) return false;
      if (candidate.readyAtSeconds > value.nowSeconds) return false;
      const held = tx
        .select()
        .from(schema.qqDispatchLease)
        .where(eq(schema.qqDispatchLease.id, 1))
        .get();
      if (!held) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
      if (qqDispatchLeaseIsHeld(held, value.nowSeconds)) return false;
      // Taking over an expired lease also clears the claim marker the dead owner left behind,
      // so a stale `claimed_generation` cannot be mistaken for a live claim later.
      if (held.conversationKey !== null && held.conversationKey !== value.conversationKey) {
        tx.update(schema.qqDispatchCandidates)
          .set({ claimedGeneration: null })
          .where(eq(schema.qqDispatchCandidates.conversationKey, held.conversationKey))
          .run();
      }
      const claimed = tx
        .update(schema.qqDispatchLease)
        .set({
          token: value.token,
          conversationKey: value.conversationKey,
          generation: value.generation,
          expiresAtSeconds: value.nowSeconds + value.leaseSeconds,
        })
        .where(eq(schema.qqDispatchLease.id, 1))
        .returning()
        .get();
      if (!claimed) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
      tx.update(schema.qqDispatchCandidates)
        .set({ claimedGeneration: value.generation })
        .where(eq(schema.qqDispatchCandidates.conversationKey, value.conversationKey))
        .run();
      return true;
    },
    { behavior: "immediate" },
  );
}

/**
 * Take the global slot for an IMMEDIATE reply (P5s).
 *
 * A direct reply or a continuation is not a queued candidate — the plan keeps those out of the
 * candidate list — but it still runs under the same global rule ("one QQ model chain at a time"),
 * so it claims the same slot without owning a candidate generation. The takeover semantics are
 * identical: an expired lease is scrapped rather than resumed.
 */
export function claimQqImmediateLease(
  orm: Orm,
  input: { token: string; conversationKey: string; nowSeconds: number; leaseSeconds: number },
): boolean {
  const parsed = z
    .strictObject({
      token: z.string().trim().min(1),
      conversationKey: z.string().trim().min(1),
      nowSeconds: z.number().int().nonnegative(),
      leaseSeconds: z
        .number()
        .int()
        .min(QQ_DISPATCH_LEASE_MIN_SECONDS)
        .max(QQ_DISPATCH_LEASE_MAX_SECONDS),
    })
    .safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ immediate claim input");
  const value = parsed.data;
  return orm.transaction(
    (tx) => {
      const held = tx
        .select()
        .from(schema.qqDispatchLease)
        .where(eq(schema.qqDispatchLease.id, 1))
        .get();
      if (!held) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
      if (qqDispatchLeaseIsHeld(held, value.nowSeconds)) return false;
      if (held.conversationKey !== null && held.conversationKey !== value.conversationKey) {
        tx.update(schema.qqDispatchCandidates)
          .set({ claimedGeneration: null })
          .where(eq(schema.qqDispatchCandidates.conversationKey, held.conversationKey))
          .run();
      }
      const claimed = tx
        .update(schema.qqDispatchLease)
        .set({
          token: value.token,
          conversationKey: value.conversationKey,
          generation: null,
          expiresAtSeconds: value.nowSeconds + value.leaseSeconds,
        })
        .where(eq(schema.qqDispatchLease.id, 1))
        .returning()
        .get();
      if (!claimed) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
      return true;
    },
    { behavior: "immediate" },
  );
}

/**
 * The submit-time guard for an immediate reply: the same lease re-checks as the queued path, minus
 * the candidate (there is none), and with the caller's live-fact probe run inside the transaction.
 */
export function commitQqImmediateTask(
  orm: Orm,
  input: { token: string; conversationKey: string; nowSeconds: number },
  recheck: () => QqDispatchFactDecision,
): QqDispatchCommit {
  return orm.transaction(
    (tx) => {
      const held = tx
        .select()
        .from(schema.qqDispatchLease)
        .where(eq(schema.qqDispatchLease.id, 1))
        .get();
      if (!held || held.token === null || held.token !== input.token) {
        return { kind: "superseded", reason: "lease_lost" };
      }
      if (held.expiresAtSeconds === null || held.expiresAtSeconds <= input.nowSeconds) {
        return { kind: "superseded", reason: "lease_expired" };
      }
      if (held.conversationKey !== input.conversationKey) {
        return { kind: "superseded", reason: "lease_moved" };
      }
      const decision = recheck();
      // The lease row references the candidate, so it stops naming anything before the task is
      // considered done — an immediate reply has no candidate to consume.
      tx.update(schema.qqDispatchLease)
        .set({ token: null, conversationKey: null, generation: null, expiresAtSeconds: null })
        .where(eq(schema.qqDispatchLease.id, 1))
        .run();
      if (decision.kind === "checks_passed") return { kind: "authorized" };
      return {
        kind: "blocked",
        reason: decision.kind === "blocked" ? decision.reason : "review_required",
      };
    },
    { behavior: "immediate" },
  );
}

/**
 * Extend the caller's own lease. Refused when the row no longer names this token, or when it
 * already lapsed — a lapsed lease means the task was scrapped, and reviving it would let a
 * stale draft compete with the re-judged one.
 */
export function renewQqDispatchLease(
  orm: Orm,
  input: { token: string; nowSeconds: number; leaseSeconds: number },
): boolean {
  return orm.transaction(
    (tx) => {
      const held = tx
        .select()
        .from(schema.qqDispatchLease)
        .where(eq(schema.qqDispatchLease.id, 1))
        .get();
      if (!held || held.token === null || held.token !== input.token) return false;
      if (!qqDispatchLeaseIsHeld(held, input.nowSeconds)) return false;
      tx.update(schema.qqDispatchLease)
        .set({ expiresAtSeconds: input.nowSeconds + input.leaseSeconds })
        .where(eq(schema.qqDispatchLease.id, 1))
        .run();
      return true;
    },
    { behavior: "immediate" },
  );
}

/** Hand the global slot back. A no-op when the lease has already moved on. */
export function releaseQqDispatchLease(orm: Orm, token: string): boolean {
  return orm.transaction(
    (tx) => {
      const held = tx
        .select()
        .from(schema.qqDispatchLease)
        .where(eq(schema.qqDispatchLease.id, 1))
        .get();
      if (!held || held.token !== token) return false;
      tx.update(schema.qqDispatchLease)
        .set({ token: null, conversationKey: null, generation: null, expiresAtSeconds: null })
        .where(eq(schema.qqDispatchLease.id, 1))
        .run();
      if (held.conversationKey !== null) {
        tx.update(schema.qqDispatchCandidates)
          .set({ claimedGeneration: null })
          .where(eq(schema.qqDispatchCandidates.conversationKey, held.conversationKey))
          .run();
      }
      return true;
    },
    { behavior: "immediate" },
  );
}

export interface QqDispatchReaped {
  conversationKey: string;
  generation: number;
}

/**
 * Clear a lease whose owner disappeared. Returns what was dropped, or `null` when nothing was
 * due. The candidate itself is kept: the plan re-judges it from current facts rather than
 * resuming the interrupted work.
 */
export function reapExpiredQqDispatchLease(orm: Orm, nowSeconds: number): QqDispatchReaped | null {
  return orm.transaction(
    (tx) => {
      const held = tx
        .select()
        .from(schema.qqDispatchLease)
        .where(eq(schema.qqDispatchLease.id, 1))
        .get();
      if (!held || held.token === null || held.expiresAtSeconds === null) return null;
      if (held.expiresAtSeconds > nowSeconds) return null;
      const reaped: QqDispatchReaped = {
        conversationKey: held.conversationKey ?? "",
        generation: held.generation ?? 0,
      };
      tx.update(schema.qqDispatchLease)
        .set({ token: null, conversationKey: null, generation: null, expiresAtSeconds: null })
        .where(eq(schema.qqDispatchLease.id, 1))
        .run();
      if (held.conversationKey !== null) {
        tx.update(schema.qqDispatchCandidates)
          .set({ claimedGeneration: null })
          .where(eq(schema.qqDispatchCandidates.conversationKey, held.conversationKey))
          .run();
      }
      return reaped;
    },
    { behavior: "immediate" },
  );
}

export interface QqDispatchCommitInput {
  token: string;
  conversationKey: string;
  generation: number;
  nowSeconds: number;
}

export type QqDispatchFactDecision =
  | { readonly kind: "checks_passed" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "review_required" };

export type QqDispatchCommit =
  | { readonly kind: "authorized" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "superseded"; readonly reason: string };

/**
 * The submit-time guard: re-read the live facts and consume the task in ONE write transaction.
 *
 * `recheck` must read through `orm` (the same connection), so it sees this transaction's
 * snapshot; it is called after the lease and generation are re-verified, which is what makes
 * "the draft was still current when it was accepted" a single atomic step instead of a
 * read that another process can invalidate afterwards.
 *
 * `authorized` means "this task was current and its facts still stand" — it is still not a
 * send instruction: nothing here touches a platform, and the caller owns that decision.
 */
export function commitQqDispatchTask(
  orm: Orm,
  input: QqDispatchCommitInput,
  recheck: () => QqDispatchFactDecision,
): QqDispatchCommit {
  return orm.transaction(
    (tx) => {
      const held = tx
        .select()
        .from(schema.qqDispatchLease)
        .where(eq(schema.qqDispatchLease.id, 1))
        .get();
      if (!held || held.token === null || held.token !== input.token) {
        return { kind: "superseded", reason: "lease_lost" };
      }
      if (held.expiresAtSeconds === null || held.expiresAtSeconds <= input.nowSeconds) {
        return { kind: "superseded", reason: "lease_expired" };
      }
      if (held.conversationKey !== input.conversationKey) {
        return { kind: "superseded", reason: "lease_moved" };
      }
      if (held.generation !== input.generation) {
        return { kind: "superseded", reason: "generation_moved" };
      }
      const candidate = tx
        .select()
        .from(schema.qqDispatchCandidates)
        .where(eq(schema.qqDispatchCandidates.conversationKey, input.conversationKey))
        .get();
      if (!candidate) return { kind: "superseded", reason: "candidate_gone" };
      if (
        candidate.generation !== input.generation ||
        candidate.claimedGeneration !== input.generation
      ) {
        return { kind: "superseded", reason: "candidate_moved" };
      }
      const decision = recheck();
      // Order matters: the lease row references the candidate, so it must stop naming it
      // before the candidate can be deleted at all.
      tx.update(schema.qqDispatchLease)
        .set({ token: null, conversationKey: null, generation: null, expiresAtSeconds: null })
        .where(eq(schema.qqDispatchLease.id, 1))
        .run();
      tx.delete(schema.qqDispatchCandidates)
        .where(eq(schema.qqDispatchCandidates.conversationKey, input.conversationKey))
        .run();
      if (decision.kind === "checks_passed") return { kind: "authorized" };
      // A blocked task is consumed too: the plan re-judges on the next real event instead of
      // retrying a draft whose facts changed, so a transient block cannot loop.
      return {
        kind: "blocked",
        reason: decision.kind === "blocked" ? decision.reason : "review_required",
      };
    },
    { behavior: "immediate" },
  );
}

/** Build the lease token for a task. Exposed so a scheduler can be tested with a fixed token. */
export function newQqDispatchToken(): string {
  return newId();
}

/**
 * One conversation's verdict from the quiet-room sweep (0030, §11.1's 原因可追踪).
 *
 * The identity half comes from the binding the sweep walked, not from parsing the conversation key
 * back apart: the sweep already holds both, and the page needs a label it can show.
 */
export interface QqSweepVerdictInput {
  readonly conversationKey: string;
  readonly kind: "group" | "private";
  readonly peerId: string;
  readonly outcome: "scheduled" | "skipped";
  readonly reason: QqIdleSweepSkipReason | null;
  readonly observedAtSeconds: number | null;
  readonly readyAtSeconds: number | null;
}

const SweepVerdictSchema = z
  .strictObject({
    conversationKey: z.string().trim().min(1),
    kind: z.enum(["group", "private"]),
    peerId: z.string().trim().min(1),
    outcome: z.enum(["scheduled", "skipped"]),
    reason: QqIdleSweepSkipReasonSchema.nullable(),
    observedAtSeconds: z.number().int().nonnegative().nullable(),
    readyAtSeconds: z.number().int().nonnegative().nullable(),
  })
  // "Why is there no sound" is the whole point of the row, so a skipped verdict without a reason
  // is refused here as well as by the table's CHECK. An error naming the missing reason beats a
  // constraint failure from three layers down.
  .refine(
    (verdict) => (verdict.outcome === "skipped") === (verdict.reason !== null),
    "a skipped verdict must name its reason, and a scheduled one must not",
  );

/**
 * Replace the stored verdicts with the ones this pass reached.
 *
 * One transaction for the whole pass: the rows of conversations the sweep no longer walks (unbound
 * or rebound away) are dropped, and every conversation it did walk gets its row rewritten — so the
 * table describes the CURRENT set of bound conversations and nothing else. A conversation that
 * leaves never keeps a reason behind for a user to read as live.
 */
export function recordQqSweepVerdicts(
  orm: Orm,
  input: { nowSeconds: number; verdicts: readonly QqSweepVerdictInput[] },
): void {
  const parsed = z
    .strictObject({
      nowSeconds: z.number().int().nonnegative(),
      verdicts: z.array(SweepVerdictSchema),
    })
    .safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ sweep verdict input");
  const value = parsed.data;
  orm.transaction(
    (tx) => {
      const keys = value.verdicts.map((verdict) => verdict.conversationKey);
      // `NOT IN ()` is not valid SQL, so "nothing is bound" is its own statement rather than an
      // empty list handed to the same predicate.
      if (keys.length === 0) tx.delete(schema.qqSweepVerdicts).run();
      else
        tx.delete(schema.qqSweepVerdicts)
          .where(notInArray(schema.qqSweepVerdicts.conversationKey, keys))
          .run();
      for (const verdict of value.verdicts) {
        const row = {
          conversationKind: verdict.kind,
          peerId: verdict.peerId,
          outcome: verdict.outcome,
          reason: verdict.outcome === "skipped" ? verdict.reason : null,
          observedAtSeconds: verdict.observedAtSeconds,
          readyAtSeconds: verdict.readyAtSeconds,
          decidedAtSeconds: value.nowSeconds,
        };
        tx.insert(schema.qqSweepVerdicts)
          .values({ conversationKey: verdict.conversationKey, ...row })
          .onConflictDoUpdate({
            target: schema.qqSweepVerdicts.conversationKey,
            set: row,
          })
          .run();
      }
    },
    { behavior: "immediate" },
  );
}

/** The newest verdicts, newest decision first. Read-only: nothing decides anything from this. */
export function readQqSweepVerdicts(
  orm: Orm,
  limit: number = QQ_SWEEP_VERDICT_LIMIT,
): QqSweepVerdictRow[] {
  const parsed = z.number().int().positive().max(QQ_SWEEP_VERDICT_LIMIT).safeParse(limit);
  if (!parsed.success) throw new TypeError("Invalid QQ sweep verdict limit");
  return orm
    .select()
    .from(schema.qqSweepVerdicts)
    .orderBy(
      desc(schema.qqSweepVerdicts.decidedAtSeconds),
      asc(schema.qqSweepVerdicts.conversationKey),
    )
    .limit(parsed.data)
    .all();
}

/** Diagnostics for the lease row without exposing the token (it is a capability, not data). */
export function qqDispatchLeaseView(orm: Orm, nowSeconds: number) {
  const row = readQqDispatchLease(orm);
  return {
    held: qqDispatchLeaseIsHeld(row, nowSeconds),
    conversationKey: row.conversationKey,
    generation: row.generation,
    expiresAtSeconds: row.expiresAtSeconds,
    remainingSeconds:
      row.expiresAtSeconds === null ? 0 : Math.max(0, row.expiresAtSeconds - nowSeconds),
  };
}

/**
 * 冷场判断的记忆（0033）。
 *
 * "Silence" is a judgement outcome, and until now it lived only in memory: the speech log records
 * delivered utterances only and the candidate is consumed by the task that judged it, so the next
 * timed sweep judged the SAME basis again — one model call per pass, forever, until somebody spoke.
 * This row is that missing memory: the basis a conversation's quiet episode was last judged at.
 */
export interface QqIdleJudgementRow {
  readonly conversationKey: string;
  readonly basisSeconds: number;
  readonly judgedAtSeconds: number;
}

/** Upsert on the conversation: the newest basis replaces the older one. */
export function recordQqIdleJudgement(
  orm: Orm,
  input: { conversationKey: string; basisSeconds: number; nowSeconds: number },
): void {
  const row = z
    .strictObject({
      conversationKey: z.string().min(1),
      basisSeconds: z.number().int().nonnegative(),
      nowSeconds: z.number().int().nonnegative(),
    })
    .safeParse(input);
  if (!row.success) throw new TypeError("Invalid QQ idle judgement input");
  orm
    .insert(schema.qqIdleJudgements)
    .values({
      conversationKey: row.data.conversationKey,
      basisSeconds: row.data.basisSeconds,
      judgedAtSeconds: row.data.nowSeconds,
    })
    .onConflictDoUpdate({
      target: schema.qqIdleJudgements.conversationKey,
      set: { basisSeconds: row.data.basisSeconds, judgedAtSeconds: row.data.nowSeconds },
    })
    .run();
}

export function readQqIdleJudgement(orm: Orm, conversationKey: string): QqIdleJudgementRow | null {
  const row = orm
    .select()
    .from(schema.qqIdleJudgements)
    .where(eq(schema.qqIdleJudgements.conversationKey, conversationKey))
    .get();
  return row === undefined ? null : Object.freeze({ ...row });
}

/** Drop memories for conversations no longer bound — the sweep's reconciliation, like the verdicts'. */
export function forgetQqIdleJudgementsExcept(orm: Orm, conversationKeys: readonly string[]): void {
  const keep = [...conversationKeys];
  if (keep.length === 0) {
    orm.delete(schema.qqIdleJudgements).run();
    return;
  }
  orm
    .delete(schema.qqIdleJudgements)
    .where(notInArray(schema.qqIdleJudgements.conversationKey, keep))
    .run();
}
