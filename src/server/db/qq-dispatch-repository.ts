// Stored QQ scheduling settings, sweep verdicts and historical candidate cleanup.
// Active leases and execution belong to the conversation schedulers.

import { asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import {
  QQ_SWEEP_VERDICT_LIMIT,
  type QqIdleSweepSkipReason,
  QqIdleSweepSkipReasonSchema,
} from "../../shared/contracts/qq";
import { fail } from "../errors";
import type { Orm } from "./repositories";
import * as schema from "./schema";

export type QqDispatchSettingsRow = typeof schema.qqDispatchSettings.$inferSelect;
export type QqDispatchCandidateRow = typeof schema.qqDispatchCandidates.$inferSelect;
export type QqDispatchLeaseRow = typeof schema.qqDispatchLease.$inferSelect;
export type QqSweepVerdictRow = typeof schema.qqSweepVerdicts.$inferSelect;

export function readQqDispatchSettings(orm: Orm): QqDispatchSettingsRow {
  const row = orm
    .select()
    .from(schema.qqDispatchSettings)
    .where(eq(schema.qqDispatchSettings.id, 1))
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return row;
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
 * or rebound away) are dropped, and a conversation it did walk is compared with the row already
 * stored. A verdict whose identity and clocks are unchanged keeps its row, a changed verdict is
 * rewritten, and a new one is inserted — so the table describes the CURRENT set of bound
 * conversations and nothing else, without churning rows that did not move. The pass still stamps
 * `decided_at_seconds` on every walked row (a single-column update when only the clock moved),
 * because the storage summary dates the last sweep by the newest one.
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
      const existing = new Map(
        tx
          .select()
          .from(schema.qqSweepVerdicts)
          .all()
          .map((row) => [row.conversationKey, row]),
      );
      const keys = new Set(value.verdicts.map((verdict) => verdict.conversationKey));
      const dropped = [...existing.keys()].filter((key) => !keys.has(key));
      // The common idle pass drops nothing, so it issues no delete at all instead of a `NOT IN ()`
      // that SQLite cannot parse; a row is only removed once its conversation actually left.
      if (dropped.length > 0)
        tx.delete(schema.qqSweepVerdicts)
          .where(inArray(schema.qqSweepVerdicts.conversationKey, dropped))
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
        const stored = existing.get(verdict.conversationKey);
        if (stored === undefined) {
          tx.insert(schema.qqSweepVerdicts)
            .values({ conversationKey: verdict.conversationKey, ...row })
            .onConflictDoUpdate({
              target: schema.qqSweepVerdicts.conversationKey,
              set: row,
            })
            .run();
          continue;
        }
        const unchanged =
          stored.conversationKind === row.conversationKind &&
          stored.peerId === row.peerId &&
          stored.outcome === row.outcome &&
          stored.reason === row.reason &&
          stored.observedAtSeconds === row.observedAtSeconds &&
          stored.readyAtSeconds === row.readyAtSeconds;
        if (!unchanged) {
          tx.update(schema.qqSweepVerdicts)
            .set(row)
            .where(eq(schema.qqSweepVerdicts.conversationKey, verdict.conversationKey))
            .run();
        } else if (stored.decidedAtSeconds !== value.nowSeconds) {
          tx.update(schema.qqSweepVerdicts)
            .set({ decidedAtSeconds: value.nowSeconds })
            .where(eq(schema.qqSweepVerdicts.conversationKey, verdict.conversationKey))
            .run();
        }
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
