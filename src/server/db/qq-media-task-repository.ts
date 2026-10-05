// Typed media read tasks (T08; spec §8.1/§12, migration 0052).
//
// The 0012 ledger had one attempts counter per media row; §8.1 replaces it with
// one task per (media, purpose, question) and two attempts per task. The task's
// stable identity is the media's identity + purpose (baseline | detail) + the
// normalized question for details — deliberately NOT the model or policy: those
// are result-cache matching dimensions, and switching either must not reset the
// attempts a task has already spent.
//
// Content identity (T08 resume): every claim carries the bytes' sha256. The
// identity key hashes the scope + segment kind + purpose + question + content
// sha, so re-deliveries of the SAME bytes under a DIFFERENT source/URL/carrier
// row keep the SAME budget row — attempts accumulate on the ledger, never on
// the carrier. The carrier column is nullable (ON DELETE SET NULL): purging a
// carrier clears its private text/bytes but never the ledger's budget. Rows
// with identity_key = NULL are history rows whose content could not be
// confirmed under controlled fetch; they keep row-level identity and never get
// a forged key.
//
// Questions are normalized before they become keys: punctuation, surrounding
// whitespace and case are not new questions, so a model's random rewording or a
// restart cannot fork unlimited fresh task budgets.
//
// Claim protocol (the CAS discipline every consumer must follow):
//   1. `attemptMediaReadTask` claims ONE attempt atomically. On success it
//      returns the consumed attempt number AND a `claimToken` minted from the
//      task's revision at claim time.
//   2. `recordMediaReadTaskResult` publishes only onto the EXACT running
//      attempt (status='running' AND attempts=expectedAttempt AND
//      revision=revisionsAtClaim) and requires the claim token. A late result
//      for a superseded attempt is refused, never merged.
//   3. `failMediaReadTask` marks only the exact claimed attempt failed, with
//      the same token; a stale failure callback cannot clobber a newer claim
//      or a newer task state.
// A running task is in-flight: a second claim on the same task fails closed
// (`awaiting_supplement`) — the second attempt only exists after the first has
// resolved as failed AND a genuinely later related supplement arrives, proved
// by the host through `proveSupplementLaterThan` (a host-evidence callback;
// the input boolean alone is never host evidence).

import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { fail } from "../errors";
import { nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

export type QqMediaReadTaskRow = typeof schema.qqMediaReadTasks.$inferSelect;
export type QqMediaReadPurpose = "baseline" | "detail";
export type QqMediaReadTaskStatus = "pending" | "running" | "succeeded" | "failed";

export const QQ_MEDIA_READ_TASK_MAX_ATTEMPTS = 2;

/**
 * Host-side source revalidation, run with the LIVE transaction handle at every
 * claim / publication / failure boundary: the host re-reads whatever state it
 * froze when the task opened (conversation binding, agent, capability/source
 * epoch) through that same transaction and throws when it moved. Required, not
 * optional — the store never treats a missing callback as source authorization;
 * the full scope + capability/sourceEpoch freeze is the host's (T08b) duty, the
 * store does not duplicate a second permission query.
 */
export type MediaTaskSourceGuard = (transaction: Orm) => void;

function runSourceGuard(guard: MediaTaskSourceGuard, tx: Orm): void {
  // Thrown as-is: authority failures keep their code (CONTEXT_SOURCE_INVALID);
  // anything else is a host programming error and propagates unchanged.
  guard(tx);
}

function requireWholeTaskInput(input: {
  mediaNoteId: string;
  purpose: QqMediaReadPurpose;
  questionKey?: string | null;
}): void {
  if (input.mediaNoteId.trim().length === 0)
    throw new TypeError("Invalid QQ media read task input");
  if (
    input.purpose === "detail" &&
    (input.questionKey === undefined ||
      input.questionKey === null ||
      input.questionKey.trim().length === 0)
  ) {
    throw new TypeError("A detail read task must name its question");
  }
  if (
    input.purpose === "baseline" &&
    input.questionKey !== undefined &&
    input.questionKey !== null
  ) {
    throw new TypeError("A baseline read task never names a question");
  }
}

/**
 * The content-identity key for one read task: scope (account, kind, peer,
 * agent) + segment kind + purpose + normalized question + the bytes' sha256.
 * Same scope + same bytes + same question is ONE budget row regardless of
 * which source URL or carrier row delivered the bytes; a different scope is a
 * different budget. Model and policy never enter the key.
 */
export function mediaReadTaskIdentityKey(input: {
  accountId: string;
  conversationKind: string;
  peerId: string;
  agentId: string;
  segmentKind: string;
  purpose: QqMediaReadPurpose;
  questionKey?: string | null;
  contentSha256: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.accountId,
        input.conversationKind,
        input.peerId,
        input.agentId,
        input.segmentKind,
        input.purpose,
        input.purpose === "detail" ? (input.questionKey ?? "") : "",
      ]) +
        "\n" +
        input.contentSha256,
    )
    .digest("hex");
}

/**
 * The stable question key: trimmed, case-folded, punctuation and internal
 * whitespace collapsed. Two wordings that only differ in punctuation, spacing
 * or letter case are the same question; a genuinely different information need
 * still normalizes to a different key. This is a deterministic textual
 * normalization only — it does NOT claim semantic equivalence; the host binds
 * the normalized original question to real message/media IDs (spec §8.1).
 */
export function normalizeQuestionKey(question: string): string {
  return (
    question
      .normalize("NFKC")
      .toLowerCase()
      // Whitespace runs (and the punctuation they follow) collapse: "什么字？" and
      // "什么字 。" are the same key.
      .replace(/[\s\p{P}\p{S}]+/gu, " ")
      .trim()
  );
}

/**
 * The content-identity ledger row, window-blind: the (identity_key)-unique row
 * is the budget book — expiry never erases it and never resets its attempts.
 * Returns the row regardless of status/window; callers decide serviceability
 * (windows) and budget (attempts).
 */
function ledgerTaskFor(orm: Orm, identityKey: string): QqMediaReadTaskRow | null {
  const row = orm
    .select()
    .from(schema.qqMediaReadTasks)
    .where(eq(schema.qqMediaReadTasks.identityKey, identityKey))
    .get();
  return row ?? null;
}

/** The live, non-expired task for one identity, if one exists. */
function taskFor(
  orm: Orm,
  input: { mediaNoteId: string; purpose: QqMediaReadPurpose; questionKey?: string | null },
  at: string,
): QqMediaReadTaskRow | null {
  const row = orm
    .select()
    .from(schema.qqMediaReadTasks)
    .where(
      and(
        eq(schema.qqMediaReadTasks.mediaNoteId, input.mediaNoteId),
        eq(schema.qqMediaReadTasks.purpose, input.purpose),
        input.purpose === "detail"
          ? eq(schema.qqMediaReadTasks.questionKey, input.questionKey ?? "")
          : isNull(schema.qqMediaReadTasks.questionKey),
        // Task expiry never exceeds the media's own window (0052 DDL takes the
        // media row's expiry at import; new tasks are bounded by their caller).
        gt(schema.qqMediaReadTasks.expiresAt, at),
      ),
    )
    .get();
  return row ?? null;
}

/**
 * A claim token binds a consumer to the exact task state it saw when claiming:
 * sha256(taskId, revision, attempts). Publishing or failing without the token
 * minted at claim time is refused — a stale callback cannot act on a task
 * whose state has since moved (new claim, published result, expiry).
 */
function claimTokenOf(task: Pick<QqMediaReadTaskRow, "id" | "revision" | "attempts">): string {
  return createHash("sha256")
    .update(JSON.stringify([task.id, task.revision, task.attempts]))
    .digest("hex");
}

function requireClaimToken(task: QqMediaReadTaskRow, provided: string | undefined): void {
  if (provided === undefined || provided !== claimTokenOf(task)) {
    fail("MEMORY_SOURCE_INVALID", "读取任务领取凭据不匹配，不能操作该任务");
  }
}

/**
 * Find-or-create the task for one identity. The (media, purpose, question)
 * partial unique indexes are the identity: a second call with a different
 * model or policy lands on the SAME row — the model/policy fields describe
 * result matching, not task identity, and attempts accumulate across them.
 */
export function recordMediaReadTask(
  orm: Orm,
  input: {
    mediaNoteId: string;
    purpose: QqMediaReadPurpose;
    questionKey?: string | null;
    modelName?: string | null;
    policy: string;
    /** Upper bound: never later than the media row's own expiry. */
    expiresAt: string;
    /**
     * The controlled bytes' sha256: REQUIRED for identity. The reader derives
     * it from a live asset (zero fetch) or the adapter's fetchBytes (the same
     * controlled download chain); a caller without bytes is refused — silently
     * falling back to row-level identity would let the same picture regain
     * budget on a new URL, which §8.1 forbids.
     */
    contentSha256: string;
    at?: string;
  },
): { readonly task: QqMediaReadTaskRow; readonly created: boolean } {
  requireWholeTaskInput(input);
  const policy = input.policy.trim();
  if (policy.length === 0) throw new TypeError("Invalid QQ media read task input");
  const contentSha256 = input.contentSha256?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/.test(contentSha256)) {
    throw new TypeError("A media read task requires the controlled bytes' sha256");
  }
  const at = input.at ?? nowIso();
  // The media row is both the task's initial carrier and the scope source: a
  // task cannot outlive the picture it reads, and its budget belongs to the
  // carrier's four-dimensional scope.
  const media = orm
    .select()
    .from(schema.qqMediaNotes)
    .where(eq(schema.qqMediaNotes.id, input.mediaNoteId))
    .get();
  if (!media) fail("MEMORY_SOURCE_INVALID", "媒体位置不存在，不能创建读取任务");
  const event = orm
    .select()
    .from(schema.qqEvents)
    .where(eq(schema.qqEvents.eventKey, media.eventKey))
    .get();
  if (!event) fail("MEMORY_SOURCE_INVALID", "媒体归属事件不存在，不能创建读取任务");
  const identityKey = mediaReadTaskIdentityKey({
    accountId: event.accountId,
    conversationKind: event.conversationKind,
    peerId: event.peerId,
    agentId: event.agentId,
    segmentKind: media.segmentKind,
    purpose: input.purpose,
    questionKey: input.purpose === "detail" ? (input.questionKey ?? null) : null,
    contentSha256,
  });
  // Identity ledger first (window-blind): the same bytes in the same scope hit
  // the SAME row wherever a new carrier row or URL delivered them.
  const ledger = ledgerTaskFor(orm, identityKey);
  if (ledger) {
    // The ledger row IS the budget: whether its window is live or expired is
    // the claim's decision. A dead-window ledger row is returned window-blind;
    // the claim CAS re-derives the window and re-points the carrier.
    return { task: ledger, created: false };
  }
  const expiresAt =
    Date.parse(media.expiresAt) <= Date.parse(input.expiresAt) ? media.expiresAt : input.expiresAt;
  if (Date.parse(expiresAt) <= Date.parse(at)) {
    fail("MEMORY_SOURCE_INVALID", "媒体已过期，不能创建读取任务");
  }
  const row = orm
    .insert(schema.qqMediaReadTasks)
    .values({
      id: crypto.randomUUID(),
      mediaNoteId: input.mediaNoteId,
      accountId: event.accountId,
      conversationKind: event.conversationKind,
      peerId: event.peerId,
      agentId: event.agentId,
      identityKey,
      purpose: input.purpose,
      questionKey: input.purpose === "detail" ? (input.questionKey ?? "") : null,
      modelName: input.modelName ?? null,
      policy,
      attempts: 0,
      status: "pending",
      note: null,
      revision: 1,
      expiresAt,
      recordedAt: at,
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (row) return { task: row, created: true };
  const raced = ledgerTaskFor(orm, identityKey) ?? taskFor(orm, input, at);
  if (!raced) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return { task: raced, created: false };
}

export function findMediaReadTask(
  orm: Orm,
  input: { mediaNoteId: string; purpose: QqMediaReadPurpose; questionKey?: string | null },
): QqMediaReadTaskRow | null {
  requireWholeTaskInput(input);
  return taskFor(orm, input, nowIso());
}

/**
 * The window-blind content-identity ledger row: the budget book for one
 * (scope, bytes, purpose, question). Host metadata surfaces (tool list
 * described/attempts) read THIS row so a re-delivered same-bytes carrier shows
 * the real spent budget instead of a per-carrier reset. Window serviceability
 * is the caller's decision — this lookup deliberately ignores expiry.
 */
export function findMediaReadTaskByIdentity(
  orm: Orm,
  input: {
    accountId: string;
    conversationKind: string;
    peerId: string;
    agentId: string;
    segmentKind: string;
    purpose: QqMediaReadPurpose;
    questionKey?: string | null;
    contentSha256: string;
  },
): QqMediaReadTaskRow | null {
  return ledgerTaskFor(
    orm,
    mediaReadTaskIdentityKey({
      ...input,
      questionKey: input.purpose === "detail" ? (input.questionKey ?? null) : null,
    }),
  );
}

/**
 * The controlled READ-ONLY consumption lookup for cross-carrier cache reuse
 * (spec §8.1; the caller's own carrier authorization has already been
 * re-verified in ITS transaction — this function only decides whether the
 * identity ledger row can serve ITS cached result to this read):
 *   a. the taskId returned IS the unique ledger row under this exact identity
 *      (lookup is by the identity key itself, never by carrier);
 *   b. model + policy match the CURRENT adapter choice (legacy rows: model
 *      only, exactly like the typed tools' cache rule);
 *   c. the ledger row's own window is still live at `now` — a dead window is
 *      not servable here (serving is a window decision, unlike the blind
 *      budget lookup above).
 * succeeded + non-empty note is implied by the typed CHECK (a succeeded row
 * always has note/model) but verified again here because this result IS the
 * delivered text. Zero writes: no claim, no attempt, no status change, no row
 * copy — the ledger's budget stays identity-layer-owned. Rows with a NULL
 * identity_key (legacy history) never participate: their lookup key can only
 * come from controlled bytes, which they do not have.
 */
export function findServableMediaReadTaskByIdentity(
  orm: Orm,
  input: {
    accountId: string;
    conversationKind: string;
    peerId: string;
    agentId: string;
    segmentKind: string;
    purpose: QqMediaReadPurpose;
    questionKey?: string | null;
    contentSha256: string;
    modelName: string;
    policy: string;
    now: string;
  },
): QqMediaReadTaskRow | null {
  const row = findMediaReadTaskByIdentity(orm, input);
  if (row === null || row.identityKey === null) return null;
  if (row.status !== "succeeded" || row.note === null || row.note.trim().length === 0) return null;
  if (row.modelName === null || row.modelName !== input.modelName) return null;
  const legacy = row.policy === "legacy" && row.id.startsWith("legacy-");
  if (legacy) return Date.parse(row.expiresAt) > Date.parse(input.now) ? row : null;
  if (row.policy !== input.policy.trim()) return null;
  return Date.parse(row.expiresAt) > Date.parse(input.now) ? row : null;
}

/**
 * The same servable-result verdict as `findServableMediaReadTaskByIdentity`,
 * keyed by an ALREADY identity-proven taskId instead: the reader's cache path
 * has just answered with a ledger row (identityKey non-NULL, model/policy
 * matched) and the caller re-verifies that exact row before delivering — same
 * checks, same fail-closed verdicts, zero writes. Legacy rows
 * (policy='legacy' with the id prefix) follow the identical model-only rule.
 */
export function findServableMediaReadTaskById(
  orm: Orm,
  input: {
    taskId: string;
    modelName: string;
    policy: string;
    now: string;
  },
): QqMediaReadTaskRow | null {
  const row = orm
    .select()
    .from(schema.qqMediaReadTasks)
    .where(eq(schema.qqMediaReadTasks.id, input.taskId))
    .get();
  if (!row || row.identityKey === null || row.identityKey.trim().length === 0) return null;
  if (row.status !== "succeeded" || row.note === null || row.note.trim().length === 0) return null;
  if (row.modelName === null || row.modelName !== input.modelName) return null;
  const legacy = row.policy === "legacy" && row.id.startsWith("legacy-");
  if (!legacy && row.policy !== input.policy.trim()) return null;
  return Date.parse(row.expiresAt) > Date.parse(input.now) ? row : null;
}

/**
 * Enumerate EVERY ledger row under one content identity (the same controlled
 * bytes' sha in this scope, across ALL purposes and questions) — the gate's
 * truth source for running/failed/blocked states, not just servable successes.
 * Candidates are the scope's own task rows; each row's real purpose/question is
 * re-keyed through the ONE identity function, so no caller ever assembles a
 * budget hash itself. Returns the REAL rows (never anonymous scopes), including
 * identity-NULL legacy rows ONLY when their row-level carrier identity cannot
 * match a content sha — i.e. legacy rows are never returned here (they have no
 * same-content proof). Zero writes.
 */
export function findMediaReadTasksForContent(
  orm: Orm,
  input: {
    accountId: string;
    conversationKind: string;
    peerId: string;
    agentId: string;
    segmentKind: string;
    contentSha256: string;
  },
): QqMediaReadTaskRow[] {
  const candidates = orm
    .select()
    .from(schema.qqMediaReadTasks)
    .where(
      and(
        eq(schema.qqMediaReadTasks.accountId, input.accountId),
        eq(schema.qqMediaReadTasks.conversationKind, input.conversationKind),
        eq(schema.qqMediaReadTasks.peerId, input.peerId),
        eq(schema.qqMediaReadTasks.agentId, input.agentId),
        sql`${schema.qqMediaReadTasks.identityKey} IS NOT NULL`, // identity rows only; legacy stays a boundary
      ),
    )
    .all();
  return candidates.filter(
    (row) =>
      row.identityKey ===
      mediaReadTaskIdentityKey({
        accountId: input.accountId,
        conversationKind: input.conversationKind,
        peerId: input.peerId,
        agentId: input.agentId,
        segmentKind: input.segmentKind,
        purpose: row.purpose === "detail" ? "detail" : "baseline",
        questionKey: row.purpose === "detail" ? row.questionKey : null,
        contentSha256: input.contentSha256,
      }),
  );
}

/**
 * Source-death result transition (link-purge coordination; this module is the
 * ONLY writer of this transition): when a consumed source link row is about to
 * be deleted (its window died and nothing protects it), every task bound to it
 * via `asset_source_id` loses the consumed result's deliverable surface — the
 * note/model the dead source justified — while the BUDGET identity survives
 * untouched: identity_key, attempts, lastAttemptAt, the scope columns, the
 * carrier and recordedAt. Status moves succeeded → failed (the only enum-legal
 * state without a note/model pair) and revision advances, which revokes every
 * ref frozen before the transition. A later same-identity read then follows
 * the ordinary failed-task reclaim rules (remaining attempt, supplement gate)
 * — the budget is never reset and a note-NULL "success" can never deadlock.
 * The caller MUST run this inside the purge's immediate transaction; running
 * tasks are unreachable here because the purge's protection predicate never
 * deletes a source a running task still consumes.
 */
export function revokeMediaReadTaskResultsForSources(
  orm: Orm,
  sourceIds: readonly string[],
  at: string,
): number {
  if (sourceIds.length === 0 || !at) return 0;
  const rows = orm
    .update(schema.qqMediaReadTasks)
    .set({
      status: "failed",
      note: null,
      modelName: null,
      // The result's authorization ended with the consumed source: the ledger's
      // window ends at the transition, so the remaining attempt re-opens under a
      // FUTURE carrier's current window through the ordinary expired-row reclaim
      // (never the failed-attempt supplement gate, which would make the cleared
      // result's budget unreadable).
      expiresAt: sql`min(${schema.qqMediaReadTasks.expiresAt}, ${at})`,
      revision: sql`${schema.qqMediaReadTasks.revision} + 1`,
    })
    .where(
      and(
        inArray(schema.qqMediaReadTasks.assetSourceId, [...sourceIds]),
        eq(schema.qqMediaReadTasks.status, "succeeded"),
      ),
    )
    .returning({ id: schema.qqMediaReadTasks.id })
    .all();
  return rows.length;
}

/**
 * Legacy association (spec §8.1; NO network backfill): controlled bytes have
 * just confirmed a content identity in this scope. History rows with a NULL
 * identity whose carrier carries the SAME source_ref belong to this budget —
 * attach the identity to the oldest row with the SATURATED sum of their
 * attempts (min(2, Σ)), never a fresh 0-attempt budget beside old failures.
 *
 * Runs in its OWN immediate transaction (not the claim's): the association is
 * a fact proven by the bytes and must survive a refused claim — an exhausted
 * legacy row that stayed unassociated would let a new carrier regain budget.
 * Rows whose original bytes are unidentifiable (a different source_ref) are an
 * information boundary: they stay NULL, are never silently merged, and never
 * block a new identity budget (reported, not hidden).
 *
 * Returns the associated ledger row, or null when no legacy row matched (the
 * caller then proceeds with a fresh identity budget through the normal claim).
 */
export function associateLegacyMediaReadTask(
  orm: Orm,
  input: {
    mediaNoteId: string;
    mediaSegmentKind: string;
    mediaSourceRef: string;
    accountId: string;
    conversationKind: string;
    peerId: string;
    agentId: string;
    purpose: QqMediaReadPurpose;
    questionKey?: string | null;
    contentSha256: string;
    at?: string;
  },
): QqMediaReadTaskRow | null {
  return orm.transaction(
    (tx) => {
      const identityKey = mediaReadTaskIdentityKey({
        accountId: input.accountId,
        conversationKind: input.conversationKind,
        peerId: input.peerId,
        agentId: input.agentId,
        segmentKind: input.mediaSegmentKind,
        purpose: input.purpose,
        questionKey: input.purpose === "detail" ? (input.questionKey ?? null) : null,
        contentSha256: input.contentSha256,
      });
      // A live ledger row already owns the identity: nothing to merge.
      const existing = tx
        .select()
        .from(schema.qqMediaReadTasks)
        .where(eq(schema.qqMediaReadTasks.identityKey, identityKey))
        .get();
      if (existing) return null;
      // The association needs the carrier to be the SAME source_ref (the only
      // controlled identity the ledger can prove without a network backfill).
      const carrier = tx
        .select({ sourceRef: schema.qqMediaNotes.sourceRef })
        .from(schema.qqMediaNotes)
        .where(eq(schema.qqMediaNotes.id, input.mediaNoteId))
        .get();
      if (!carrier || carrier.sourceRef !== input.mediaSourceRef) return null;
      const legacyRows = tx
        .select()
        .from(schema.qqMediaReadTasks)
        .where(
          and(
            isNull(schema.qqMediaReadTasks.identityKey),
            eq(schema.qqMediaReadTasks.purpose, input.purpose),
            input.purpose === "detail"
              ? eq(schema.qqMediaReadTasks.questionKey, input.questionKey ?? "")
              : isNull(schema.qqMediaReadTasks.questionKey),
            eq(schema.qqMediaReadTasks.accountId, input.accountId),
            eq(schema.qqMediaReadTasks.conversationKind, input.conversationKind),
            eq(schema.qqMediaReadTasks.peerId, input.peerId),
            eq(schema.qqMediaReadTasks.agentId, input.agentId),
            sql`EXISTS (SELECT 1 FROM ${schema.qqMediaNotes} lm
              WHERE lm.id = ${schema.qqMediaReadTasks.mediaNoteId}
                AND lm.source_ref = ${input.mediaSourceRef})`,
          ),
        )
        .all()
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
      if (legacyRows.length === 0) return null;
      // Saturating merge: min(2, Σ attempts) onto the OLDEST row; the newer
      // merged rows keep their history but their attempts moved into the
      // identity ledger and are never re-counted (the identity slot now exists,
      // so a later pass finds `existing` and stops).
      const total = Math.min(
        QQ_MEDIA_READ_TASK_MAX_ATTEMPTS,
        legacyRows.reduce((sum, row) => sum + row.attempts, 0),
      );
      const primary = legacyRows[0];
      const merged = tx
        .update(schema.qqMediaReadTasks)
        .set({
          identityKey,
          attempts: total,
          mediaNoteId: input.mediaNoteId,
          revision: sql`${schema.qqMediaReadTasks.revision} + 1`,
        })
        .where(
          and(
            eq(schema.qqMediaReadTasks.id, primary.id),
            isNull(schema.qqMediaReadTasks.identityKey),
          ),
        )
        .returning()
        .get();
      return merged ?? null;
    },
    { behavior: "immediate" },
  );
}

/**
 * The typed task rejection. An `authority` rejection is a source/authorization
 * failure: callers must surface it, never swallow it into a continueable
 * "unavailable" tool result (spec §12 — authority failures fail loudly).
 */
export class MediaReadTaskRejectedError extends Error {
  readonly reason:
    | "awaiting_supplement"
    | "not_addressed"
    | "attempts_exhausted"
    | "already_succeeded"
    | "task_expired"
    | "authority_failure";

  constructor(
    reason: MediaReadTaskRejectedError["reason"],
    readonly authority: boolean = false,
  ) {
    super(`QQ media read task rejected: ${reason}`);
    this.name = "MediaReadTaskRejectedError";
    this.reason = reason;
  }
}

/**
 * Host-evidence callback: prove that a related supplement genuinely postdates
 * the consumed attempt (the host knows real message/event times; the caller's
 * boolean cannot substitute for it — T08b wires this to the actual supplement
 * query). Returning `false` (or omitting the callback while more attempts are
 * sought) keeps the task blocked.
 */
export type SupplementEvidence = () => boolean;

/**
 * Claim one attempt atomically (§8.1's two-attempt budget per task).
 *
 * The claim is a conditional UPDATE inside an immediate transaction, so racing
 * consumers cannot both take the same attempt number. The asymmetry from §7.2
 * carries over: a first failure waits for a related supplement; the model and
 * policy may change between attempts, the budget does not.
 *
 * Second-attempt gate: the same task claim is refused while an attempt is still
 * running (fail closed), and after a failed first attempt it requires the host
 * to prove a genuinely later related supplement through
 * `proveSupplementLaterThan`. `relatedSupplementArrived` alone records the
 * caller's assertion for attempt 1→2 selection but is never sufficient
 * evidence by itself — the callback must confirm it.
 *
 * The returned `claimToken` is required by `recordMediaReadTaskResult` /
 * `failMediaReadTask` to act on this attempt.
 */
export async function attemptMediaReadTask(
  orm: Orm,
  input: {
    mediaNoteId: string;
    purpose: QqMediaReadPurpose;
    questionKey?: string | null;
    modelName?: string | null;
    policy: string;
    /** The controlled bytes' sha256 (see recordMediaReadTask). Required. */
    contentSha256: string;
    /**
     * Optional caller window cap (defaults to the recordMediaReadTask bound):
     * the claim's window is min(current carrier expiry, this cap) — never the
     * old row value.
     */
    expiresAt?: string;
    relatedSupplementArrived?: boolean;
    /** Host evidence: a related supplement postdating the consumed attempt. */
    proveSupplementLaterThan?: SupplementEvidence;
    /**
     * Required host checkpoint: revalidate the frozen source state with the
     * live transaction handle before the claim's CAS write. Throwing (e.g. an
     * authority failure) refuses the claim and spends no attempt.
     */
    assertCurrent: MediaTaskSourceGuard;
    at?: string;
    /**
     * The source link row the claim's controlled bytes were just persisted
     * against (reader cache chain): the claim binds it as the task's REAL
     * consumed source — the result's cap then truly depends on a live, expiring
     * link instead of an unbound NULL. Optional: callers without a freshly
     * persisted chain omit it and the existing row value stands.
     */
    consumedAssetSourceId?: string;
  },
): Promise<{
  readonly claimed: true;
  readonly attempt: number;
  readonly claimToken: string;
  readonly task: QqMediaReadTaskRow;
}> {
  requireWholeTaskInput(input);
  const at = input.at ?? nowIso();
  // One immediate transaction owns the whole claim: a guard or gate throw must
  // leave no task row and no spent attempt behind.
  const claimed = orm.transaction(
    (tx) => {
      // Guard-first: the host re-proves the frozen source state on the SAME
      // transaction that will spend the attempt, before anything is created.
      runSourceGuard(input.assertCurrent, tx);
      // Find-or-create keeps the media row's own expiry (the conservative bound);
      // the gates and CAS below act on the row the claim actually read.
      const { task } = recordMediaReadTask(tx, {
        ...input,
        expiresAt: "9999-12-31T23:59:59.000000Z",
        at,
      });
      const windowDead = Date.parse(task.expiresAt) <= Date.parse(at);
      if (task.status === "succeeded") {
        // Live succeeded = the cache IS the answer: refuse (the reader serves it
        // as a cache hit, never through a claim). The refusal never resets the
        // budget. An EXPIRED succeeded row serves no body, but the ledger keeps
        // its spent attempts and the re-claim below may spend the remaining ones
        // under the CURRENT window — never a reset, never a new identity.
        if (!windowDead) throw new MediaReadTaskRejectedError("already_succeeded");
      } else if (windowDead) {
        // The window is dead but the ledger is not: the ledger keeps its spent
        // attempts and — when the budget remains — the re-claim re-opens the row
        // under the CURRENT authorization window (THIS read's carrier, live,
        // narrowed by the caller's cap), never the old expired value.
        const carrier = tx
          .select({ expiresAt: schema.qqMediaNotes.expiresAt })
          .from(schema.qqMediaNotes)
          .where(eq(schema.qqMediaNotes.id, input.mediaNoteId))
          .get();
        if (!carrier || Date.parse(carrier.expiresAt) <= Date.parse(at)) {
          throw new MediaReadTaskRejectedError("task_expired");
        }
      }
      if (task.attempts >= QQ_MEDIA_READ_TASK_MAX_ATTEMPTS) {
        throw new MediaReadTaskRejectedError("attempts_exhausted");
      }
      if (task.attempts === 1) {
        // Fail closed while in-flight; attempt 2 on a failed first attempt
        // exists only after host-proven genuinely-later supplement evidence.
        // An EXPIRED succeeded row is the other path to its remaining attempt:
        // the supplement gate is a failed-attempt rule (spec §8.1), and the
        // expired row's re-open already re-proves the current authorization in
        // this transaction — never a reset, never a body revival.
        if (task.status === "running") {
          throw new MediaReadTaskRejectedError("awaiting_supplement");
        }
        if (task.status === "failed" && !windowDead) {
          const proven = (input.proveSupplementLaterThan?.() ?? false) === true;
          if (!proven) throw new MediaReadTaskRejectedError("awaiting_supplement");
        }
      }
      // The CAS re-derives the window from the CURRENT carrier (never widens the
      // old expired value): cap = min(carrier expiry, caller cap). A carrier
      // purge (media_note_id NULL) keeps the ledger but cannot re-open a window
      // — a window needs a live carrier.
      // The window is re-derived from THIS read's carrier (the ledger follows
      // the carrier being consumed): min(current carrier expiry, caller cap).
      // Never the old row value — a dead old window is never prolonged, a live
      // current authorization is never widened beyond its real cap.
      const carrier = tx
        .select({ expiresAt: schema.qqMediaNotes.expiresAt })
        .from(schema.qqMediaNotes)
        .where(eq(schema.qqMediaNotes.id, input.mediaNoteId))
        .get();
      if (!carrier) fail("MEMORY_SOURCE_INVALID", "媒体位置不存在，不能创建读取任务");
      // The claim's own cap is the recordMediaReadTask bound ("9999…" = carrier
      // only); a caller-supplied earlier cap narrows it further.
      const callerCap = input.expiresAt ?? "9999-12-31T23:59:59.000000Z";
      const windowCap =
        Date.parse(carrier.expiresAt) <= Date.parse(callerCap) ? carrier.expiresAt : callerCap;
      const updated = tx
        .update(schema.qqMediaReadTasks)
        .set({
          attempts: sql`${schema.qqMediaReadTasks.attempts} + 1`,
          status: "running",
          // The attempt clock: stamped by the SAME CAS that consumes the attempt
          // — never by the result/failure publications below (their revision
          // bump must not move the "later than the attempt" boundary).
          lastAttemptAt: at,
          modelName: input.modelName ?? task.modelName,
          policy: input.policy.trim() || task.policy,
          // The claim re-points the ledger's carrier to THIS read's carrier (§8.1:
          // the ledger follows the real carrier being consumed — a purge leaves it
          // NULL and the next claim reattaches). Revision moves with it, so refs
          // minted against the old carrier die — 来源每次精确授权.
          ...(task.mediaNoteId !== input.mediaNoteId ? { mediaNoteId: input.mediaNoteId } : {}),
          ...(input.consumedAssetSourceId !== undefined
            ? { assetSourceId: input.consumedAssetSourceId }
            : {}),
          expiresAt: windowCap,
          revision: sql`${schema.qqMediaReadTasks.revision} + 1`,
        })
        .where(
          and(
            eq(schema.qqMediaReadTasks.id, task.id),
            // The CAS guard: attempts, status and revision must still be exactly
            // what we just read, and the task must not be succeeded or in-flight.
            eq(schema.qqMediaReadTasks.attempts, task.attempts),
            eq(schema.qqMediaReadTasks.status, task.status),
            eq(schema.qqMediaReadTasks.revision, task.revision),
            lte(schema.qqMediaReadTasks.attempts, QQ_MEDIA_READ_TASK_MAX_ATTEMPTS - 1),
            // The exact read-state guard above already pins the status; an
            // expired succeeded row legitimately re-opens (spend the remaining
            // budget), so no blanket succeeded ban here — a LIVE succeeded row
            // was refused above and never reaches this CAS.
            sql`${schema.qqMediaReadTasks.status} <> 'running'`,
            // NOTE: no "old window must be live" condition here — an expired
            // ledger row legitimately re-opens and this same CAS writes its new
            // current-authorization window. Race safety comes from the exact
            // read-state pins above; a dead CURRENT carrier was already refused
            // by the gate before the CAS.
          ),
        )
        .returning()
        .get();
      if (!updated) throw new MediaReadTaskRejectedError("attempts_exhausted");
      return updated;
    },
    { behavior: "immediate" },
  );
  return {
    claimed: true,
    attempt: claimed.attempts,
    claimToken: claimTokenOf(claimed),
    task: claimed,
  };
}

/**
 * Publish one finished attempt. The write and the media-row revalidation share
 * one immediate transaction: a source that expired / was rebound while the
 * model was reading refuses the result, and the task falls back to `failed`
 * with its attempt consumed (the failure evidence stays).
 *
 * Strict CAS: `expectedAttempts` and the `claimToken` from
 * `attemptMediaReadTask` are REQUIRED — the publication only lands on the exact
 * running attempt it claims (status='running', attempts and revision exactly
 * as claimed). A late result for a superseded attempt is refused, never merged
 * into a newer claim.
 *
 * The success carries the actual model that produced it and — for detail tasks
 * — the question key it answers; the caller cannot stamp a different task.
 */
export function recordMediaReadTaskResult(
  orm: Orm,
  input: {
    mediaNoteId: string;
    purpose: QqMediaReadPurpose;
    questionKey?: string | null;
    note: string;
    modelName: string;
    /** The exact attempt claimed by `attemptMediaReadTask`. Required. */
    expectedAttempts: number;
    /** The claim token returned with that attempt. Required. */
    claimToken: string;
    /**
     * Required host checkpoint: revalidate the frozen source state with the
     * live transaction handle before any status/CAS write. A moved binding,
     * agent, capability or source epoch refuses the result (authority code) —
     * nothing is written, and the caller decides the failure path.
     */
    assertCurrent: MediaTaskSourceGuard;
    at?: string;
  },
): QqMediaReadTaskRow {
  requireWholeTaskInput(input);
  const note = input.note.trim();
  const modelName = input.modelName.trim();
  if (note.length === 0 || modelName.length === 0) {
    throw new TypeError("Invalid QQ media read task result");
  }
  const at = input.at ?? nowIso();
  return orm.transaction(
    (tx) => {
      // Source authorization boundary first: a result whose frozen source
      // state moved is refused wholesale, never published and never quietly
      // rewritten into a failure.
      runSourceGuard(input.assertCurrent, tx);
      const media = tx
        .select({ expiresAt: schema.qqMediaNotes.expiresAt })
        .from(schema.qqMediaNotes)
        .where(eq(schema.qqMediaNotes.id, input.mediaNoteId))
        .get();
      if (!media || Date.parse(media.expiresAt) <= Date.parse(at)) {
        fail("MEMORY_SOURCE_INVALID", "媒体授权已变化，不能保存描述");
      }
      const task = taskFor(tx, input, at);
      if (!task || task.status === "succeeded") {
        fail("MEMORY_SOURCE_INVALID", "读取任务不存在或已完成，不能保存描述");
      }
      if (task.status !== "running" || task.attempts !== input.expectedAttempts) {
        fail("MEMORY_SOURCE_INVALID", "读取任务状态已变化，不能保存描述");
      }
      requireClaimToken(task, input.claimToken);
      // The UPDATE itself re-checks the CAS triple: a concurrent writer that
      // moved status/attempts/revision between the read and this write makes
      // the update a no-op, and the result is refused rather than merged.
      const updated = tx
        .update(schema.qqMediaReadTasks)
        .set({
          note,
          modelName,
          status: "succeeded",
          revision: sql`${schema.qqMediaReadTasks.revision} + 1`,
        })
        .where(
          and(
            eq(schema.qqMediaReadTasks.id, task.id),
            eq(schema.qqMediaReadTasks.status, "running"),
            eq(schema.qqMediaReadTasks.attempts, input.expectedAttempts),
            eq(schema.qqMediaReadTasks.revision, task.revision),
          ),
        )
        .returning()
        .get();
      if (!updated) fail("MEMORY_SOURCE_INVALID", "读取任务状态已变化，不能保存描述");
      return updated;
    },
    { behavior: "immediate" },
  );
}

/**
 * Mark the EXACT claimed attempt failed after it was consumed (the CAS claim
 * already counted it). Requires the claimed attempt number and the claim token:
 * a stale failure callback for a superseded attempt — or against a task that
 * has since been claimed again, succeeded, or expired — is refused instead of
 * clobbering newer state. T08b calls this from the model-call failure path
 * with the values `attemptMediaReadTask` returned; there is no best-effort
 * pseudo-publication exit.
 */
export function failMediaReadTask(
  orm: Orm,
  input: {
    mediaNoteId: string;
    purpose: QqMediaReadPurpose;
    questionKey?: string | null;
    /** The exact attempt claimed by `attemptMediaReadTask`. Required. */
    expectedAttempt: number;
    /** The task revision observed at claim time. Required. */
    revisionAtClaim: number;
    /** The claim token returned with that attempt. Required. */
    claimToken: string;
    /**
     * Required host checkpoint: revalidate the frozen source state with the
     * live transaction handle before the failure write. A moved binding,
     * agent, capability or source epoch refuses even the failure publication.
     */
    assertCurrent: MediaTaskSourceGuard;
    at?: string;
  },
): void {
  requireWholeTaskInput(input);
  const at = input.at ?? nowIso();
  orm.transaction(
    (tx) => {
      // Source authorization boundary: even a failure publication needs the
      // frozen source state to still be current.
      runSourceGuard(input.assertCurrent, tx);
      // A missing or already-resolved task refuses the stale callback like
      // every other strict write — it is never silently swallowed.
      const task = taskFor(tx, input, at);
      if (!task || task.status === "succeeded") {
        fail("MEMORY_SOURCE_INVALID", "读取任务不存在或已完成，失败结果不发布");
      }
      if (
        task.status !== "running" ||
        task.attempts !== input.expectedAttempt ||
        task.revision !== input.revisionAtClaim
      ) {
        fail("MEMORY_SOURCE_INVALID", "读取任务状态已变化，失败结果不发布");
      }
      requireClaimToken(task, input.claimToken);
      const updated = tx
        .update(schema.qqMediaReadTasks)
        .set({ status: "failed", revision: sql`${schema.qqMediaReadTasks.revision} + 1` })
        .where(
          and(
            eq(schema.qqMediaReadTasks.id, task.id),
            eq(schema.qqMediaReadTasks.status, "running"),
            eq(schema.qqMediaReadTasks.attempts, input.expectedAttempt),
            eq(schema.qqMediaReadTasks.revision, task.revision),
          ),
        )
        .returning()
        .get();
      if (!updated) fail("MEMORY_SOURCE_INVALID", "读取任务状态已变化，失败结果不发布");
    },
    { behavior: "immediate" },
  );
}

/**
 * 「试过但没读出」on real task state: a task that is running or failed inside
 * its window still blocks the initiative gates; a succeeded task no longer
 * does, and legacy attempts imported by 0052 count without ever being zeroed.
 */
export function failedMediaReadTaskCount(
  orm: Orm,
  mediaNoteIds: readonly string[],
  at: string,
): number {
  if (mediaNoteIds.length === 0) return 0;
  const rows = orm
    .select({
      status: schema.qqMediaReadTasks.status,
    })
    .from(schema.qqMediaReadTasks)
    .where(
      and(
        inArray(schema.qqMediaReadTasks.mediaNoteId, [...mediaNoteIds]),
        sql`${schema.qqMediaReadTasks.status} IN ('running', 'failed')`,
        gt(schema.qqMediaReadTasks.expiresAt, at),
      ),
    )
    .all();
  return rows.length;
}
