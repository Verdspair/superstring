import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceAccess, SourceRef } from "../../shared/contracts/evidence";
import type { QqConversationScope } from "../../shared/contracts/qq-message";
import type { ContextPrincipal } from "../agent/context-access";
import { mediaReadTaskIdentityKey } from "../db/qq-media-task-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import { evidenceScopeExists } from "../modules/conversation-evidence";
import type { EvidenceStore } from "../modules/conversation-evidence-store";
import { inTimeline } from "../modules/conversation-evidence-store";
import { ownerScope } from "./qq-media-sources";

function isDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/** The real task row joined to its carrying media row and event, scoped in SQL. */
interface TaskProjection {
  taskId: string;
  mediaNoteId: string;
  assetSourceId: string | null;
  purpose: string;
  questionKey: string | null;
  modelName: string | null;
  policy: string;
  attempts: number;
  status: string;
  note: string | null;
  taskRevision: number;
  taskExpiresAt: string;
  taskRecordedAt: string;
  eventKey: string;
  segmentIndex: number;
  mediaKind: string;
  mediaSourceRef: string;
  mediaExpiresAt: string;
  linkId: string | null;
  linkExpiresAt: string | null;
  assetId: string | null;
  assetSha256: string | null;
  assetRevision: number | null;
  assetExpiresAt: string | null;
}

/**
 * The exact task row, scoped by the media row's carrying event. The link join
 * is keyed on the task's own `asset_source_id` AND the same media row — the
 * exact link the task consumed, never another row's link even in the same
 * scope — and the asset join additionally carries the scope predicates, so a
 * link pointing at another scope's asset never passes.
 */
function taskProjection(
  db: Database,
  scope: QqConversationScope,
  taskId: string,
): TaskProjection | null {
  const row =
    (db
      .query(
        `SELECT t.id AS taskId,t.media_note_id AS mediaNoteId,t.asset_source_id AS assetSourceId,
      t.purpose AS purpose,t.question_key AS questionKey,t.model_name AS modelName,
      t.policy AS policy,t.attempts AS attempts,t.status AS status,t.note AS note,
      t.revision AS taskRevision,t.expires_at AS taskExpiresAt,t.recorded_at AS taskRecordedAt,
      n.event_key AS eventKey,n.segment_index AS segmentIndex,n.segment_kind AS mediaKind,
      n.source_ref AS mediaSourceRef,n.expires_at AS mediaExpiresAt,
      s.id AS linkId,s.expires_at AS linkExpiresAt,
      a.id AS assetId,a.content_sha256 AS assetSha256,a.revision AS assetRevision,
      a.expires_at AS assetExpiresAt
      FROM qq_media_read_tasks t JOIN qq_media_notes n ON n.id=t.media_note_id
      JOIN qq_events e ON e.event_key=n.event_key
      LEFT JOIN qq_media_asset_sources s ON s.id=t.asset_source_id
        AND s.media_note_id=t.media_note_id
      LEFT JOIN qq_media_assets a ON a.id=s.asset_id
        AND a.account_id=? AND a.conversation_kind=? AND a.peer_id=? AND a.agent_id=?
      WHERE t.id=? AND e.account_id=? AND e.conversation_kind=? AND e.peer_id=? AND e.agent_id=?`,
      )
      .get(...taskProjectionArgs(scope, taskId)) as TaskProjection | null) ?? null;
  // A consumed link that does not resolve (deleted, or pointed at a link of a
  // DIFFERENT media row — the same-media predicate above drops the join row)
  // is an incomplete authorization: fail closed instead of borrowing whatever
  // is on the media row. The same applies to an asset that does not resolve in
  // this scope (it lives in another account/kind/peer/agent).
  if (
    row !== null &&
    ((row.assetSourceId !== null && row.linkId === null) ||
      (row.linkId !== null && row.assetId === null))
  )
    return null;
  return row;
}

/** The exact task row's bind args, scoped by the media row's carrying event. */
function taskProjectionArgs(scope: QqConversationScope, taskId: string): SQLQueryBindings[] {
  return [
    scope.accountId,
    scope.conversationKind,
    scope.peerId,
    scope.agentId,
    taskId,
    scope.accountId,
    scope.conversationKind,
    scope.peerId,
    scope.agentId,
  ];
}

/**
 * The earliest window the ref's consumption actually depends on: the task's own
 * window, the media row's window and — when the task consumed a link — that
 * link and asset's windows. Fixed-width ISO strings compare numerically; the
 * winning row's cap string is returned verbatim.
 */
function consumptionCap(row: TaskProjection): string | null {
  const caps: (string | null)[] = [row.taskExpiresAt, row.mediaExpiresAt];
  if (row.linkId !== null) caps.push(row.linkExpiresAt);
  if (row.assetId !== null) caps.push(row.assetExpiresAt);
  let min: string | null = null;
  for (const value of caps) {
    if (value === null || value === undefined || Number.isNaN(Date.parse(value))) return null;
    if (min === null || Date.parse(value) < Date.parse(min)) min = value;
  }
  return min;
}

/** The revision hash: full scope + real task/media/link/asset identity. */
function sourceRevision(scope: QqConversationScope, row: TaskProjection): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.conversationId,
        scope.accountId,
        scope.conversationKind,
        scope.peerId,
        scope.agentId,
        scope.bindingId,
        scope.bindingEpoch,
        scope.authorityRevision,
        row.taskId,
        row.mediaNoteId,
        row.assetSourceId,
        row.purpose,
        row.questionKey,
        row.modelName,
        row.policy,
        row.attempts,
        row.status,
        row.note,
        row.taskRevision,
        row.taskExpiresAt,
        row.taskRecordedAt,
        row.eventKey,
        row.segmentIndex,
        row.mediaKind,
        row.mediaSourceRef,
        row.mediaExpiresAt,
        row.linkId,
        row.linkExpiresAt,
        row.assetId,
        row.assetSha256,
        row.assetRevision,
        row.assetExpiresAt,
      ]),
    )
    .digest("hex");
}

/**
 * Mint the source ref for one real read task the caller's scope can see. The
 * task must be `succeeded` with a non-empty trimmed note and model, its
 * purpose/questionKey must be mutually consistent, the carrying event must sit
 * in the caller's scope AND in the conversation's journal timeline, and every
 * consumed window (task/media/link/asset) must still be live at the caller's
 * real `now` — an already-dead window never mints. Returns `null` — never a
 * guess — on any failure.
 */
export function createQqMediaReadTaskSourceRef(
  store: EvidenceStore,
  scope: QqConversationScope,
  taskId: string,
  now: string,
  options?: {
    /** Cross-carrier read-only consumption: the CURRENT carrier's media row.
     * `undefined` keeps the original single-carrier semantics byte-identical. */
    readonly carrierMediaNoteId: string;
  },
): SourceRef | null {
  if (taskId.trim().length === 0 || !isDate(now)) return null;
  if (options !== undefined) {
    return createCrossCarrierReadTaskRef(store, scope, taskId, now, options.carrierMediaNoteId);
  }
  const botScope = { channel: "onebot11" as const, ...scope };
  if (!evidenceScopeExists(store.db, botScope)) return null;
  const row = taskProjection(store.db, scope, taskId);
  if (!row) return null;
  if (row.status !== "succeeded" || row.note === null || row.modelName === null) return null;
  if (row.note.trim().length === 0 || row.modelName.trim().length === 0) return null;
  if ((row.purpose === "detail") !== (row.questionKey !== null && row.questionKey !== ""))
    return null;
  if (!inTimeline(store.db, botScope, "qq_media", row.mediaNoteId)) return null;
  const cap = consumptionCap(row);
  if (cap === null || Date.parse(cap) <= Date.parse(now)) return null;
  return {
    kind: "qq_media_read_task",
    id: taskId,
    revision: sourceRevision(scope, row),
    expiresAt: cap,
  };
}

/**
 * Re-verify a `qq_media_read_task` ref: owner authorization first (cross-owner
 * states stay hidden), then the task's own identity/scope/timeline recomputation,
 * then every consumed window, then the hash. `undefined` falls through for
 * other kinds. An invalid `now` fails closed (revoked), never available.
 */
export function qqMediaReadTaskSourceAccess(
  db: Database,
  source: SourceRef,
  owner: RunOwner,
  principal: ContextPrincipal,
  now: string,
): SourceAccess | undefined {
  if (source.kind !== "qq_media_read_task") return undefined;
  if (!isDate(now)) return "revoked";
  // The cross-carrier consumption form carries its carrier in the revision
  // string ("c1:<carrierId>:<hash>"): dispatch there FIRST, strictly — a
  // malformed revision is fail-closed revoked, never reinterpreted as the
  // single-carrier form.
  if (parseCrossCarrierRevision(source.revision) !== null)
    return crossCarrierReadTaskAccess(db, source, owner, principal, now);
  // Owner authorization first: another owner never learns even the state of this ref.
  if (
    owner.userId === undefined ||
    owner.userId !== principal.userId ||
    principal.userId !== DEFAULT_USER_ID
  )
    return "revoked";
  const located = ownerScope(db, owner);
  if (located === "ambiguous") return "revoked";
  if (!located) return "revoked";
  const scope = located.scope;
  if (!owner.agentId || owner.agentId !== scope.agentId) return "revoked";
  if (!evidenceScopeExists(db, { channel: "onebot11", ...scope })) return "revoked";
  const row = taskProjection(db, scope, source.id);
  if (!row) return "revoked";
  if (!inTimeline(db, { channel: "onebot11", ...scope }, "qq_media", row.mediaNoteId))
    return "revoked";
  // Every consumed window must still be live. The ref's own cap only exists
  // when the mint set it — an optional missing cap is not an invalid cap. A
  // present but NULL/NaN window is rejected outright (fail closed) rather
  // than skipped, so a relaxed DDL can never silently lift a cap; an invalid
  // `now` never reaches here as available.
  const caps: (string | null | undefined)[] = [
    row.taskExpiresAt,
    row.mediaExpiresAt,
    ...(row.linkId !== null ? [row.linkExpiresAt] : []),
    ...(row.assetId !== null ? [row.assetExpiresAt] : []),
    ...(source.expiresAt !== undefined ? [source.expiresAt] : []),
  ];
  if (caps.some((value) => value === null || value === undefined || !isDate(value)))
    return "expired";
  const nowMs = Date.parse(now);
  if (caps.some((value) => Date.parse(value as string) <= nowMs)) return "expired";
  return sourceRevision(scope, row) === source.revision ? "available" : "revoked";
}

// ---- Cross-carrier read-only consumption (spec §8.1; the budget stays
// identity-layer-owned: this form NEVER writes a task row, never claims, never
// moves attempts) ----

/** The ledger row itself (its scope columns ARE the task's own scope truth):
 * no carrier join — a purged carrier must not hide a live ledger result. */
interface LedgerProjection {
  taskId: string;
  identityKey: string | null;
  purpose: string;
  questionKey: string | null;
  modelName: string | null;
  policy: string;
  attempts: number;
  status: string;
  note: string | null;
  taskRevision: number;
  taskExpiresAt: string;
  taskRecordedAt: string;
}

function ledgerProjection(
  db: Database,
  scope: QqConversationScope,
  taskId: string,
): LedgerProjection | null {
  const row = db
    .query(
      `SELECT t.id AS taskId,t.identity_key AS identityKey,t.purpose AS purpose,
    t.question_key AS questionKey,t.model_name AS modelName,t.policy AS policy,
    t.attempts AS attempts,t.status AS status,t.note AS note,t.revision AS taskRevision,
    t.expires_at AS taskExpiresAt,t.recorded_at AS taskRecordedAt
    FROM qq_media_read_tasks t
    WHERE t.id=? AND t.account_id=? AND t.conversation_kind=? AND t.peer_id=? AND t.agent_id=?`,
    )
    .get(
      taskId,
      scope.accountId,
      scope.conversationKind,
      scope.peerId,
      scope.agentId,
    ) as LedgerProjection | null;
  return row ?? null;
}

/** The CURRENT carrier's full consumption chain, scoped in SQL (same join shape
 * as the media source projection: one live link, the asset in-scope). */
interface CarrierProjection {
  segmentKind: string;
  eventKey: string;
  segmentIndex: number;
  mediaSourceRef: string;
  mediaExpiresAt: string;
  linkId: string;
  linkExpiresAt: string;
  assetId: string;
  assetSha256: string;
  assetRevision: number;
  assetExpiresAt: string;
}

function carrierProjection(
  db: Database,
  scope: QqConversationScope,
  mediaNoteId: string,
): CarrierProjection | null {
  const row = db
    .query(
      `SELECT n.segment_kind AS segmentKind,n.event_key AS eventKey,n.segment_index AS segmentIndex,
    n.source_ref AS mediaSourceRef,n.expires_at AS mediaExpiresAt,
    s.id AS linkId,s.expires_at AS linkExpiresAt,
    a.id AS assetId,a.content_sha256 AS assetSha256,a.revision AS assetRevision,a.expires_at AS assetExpiresAt
    FROM qq_media_notes n JOIN qq_events e ON e.event_key=n.event_key
    JOIN qq_media_asset_sources s ON s.media_note_id=n.id
    JOIN qq_media_assets a ON a.id=s.asset_id
      AND a.account_id=? AND a.conversation_kind=? AND a.peer_id=? AND a.agent_id=?
    WHERE n.id=? AND e.account_id=? AND e.conversation_kind=? AND e.peer_id=? AND e.agent_id=?`,
    )
    .get(
      scope.accountId,
      scope.conversationKind,
      scope.peerId,
      scope.agentId,
      mediaNoteId,
      scope.accountId,
      scope.conversationKind,
      scope.peerId,
      scope.agentId,
    ) as CarrierProjection | null;
  return row ?? null;
}

/** The composite revision: "c1:<carrierId>:<hash>". The carrier id is a real
 * row id, but it is still parsed strictly — a forged or malformed payload
 * fails closed. The hash freezes the ledger result (identity_key, note,
 * revision, expiry, model, policy, attempts, status, recordedAt) AND the
 * current carrier's whole chain (event, segment, source ref, link, asset,
 * content sha) AND the task's own scope, so any rewrite of the note, any
 * source-chain move, or any scope drift revokes the ref. */
function crossCarrierRevision(
  scope: QqConversationScope,
  ledger: LedgerProjection,
  carrier: CarrierProjection,
  carrierMediaNoteId: string,
): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        scope.conversationId,
        scope.accountId,
        scope.conversationKind,
        scope.peerId,
        scope.agentId,
        scope.bindingId,
        scope.bindingEpoch,
        scope.authorityRevision,
        carrierMediaNoteId,
        ledger.taskId,
        ledger.identityKey,
        ledger.purpose,
        ledger.questionKey,
        ledger.modelName,
        ledger.policy,
        ledger.attempts,
        ledger.status,
        ledger.note,
        ledger.taskRevision,
        ledger.taskExpiresAt,
        ledger.taskRecordedAt,
        carrier.segmentKind,
        carrier.eventKey,
        carrier.segmentIndex,
        carrier.mediaSourceRef,
        carrier.mediaExpiresAt,
        carrier.linkId,
        carrier.linkExpiresAt,
        carrier.assetId,
        carrier.assetSha256,
        carrier.assetRevision,
        carrier.assetExpiresAt,
      ]),
    )
    .digest("hex");
  return `c1:${carrierMediaNoteId}:${hash}`;
}

function parseCrossCarrierRevision(revision: string): { carrierId: string; hash: string } | null {
  const parts = revision.split(":");
  if (parts.length !== 3 || parts[0] !== "c1") return null;
  const [tag, carrierId, hash] = parts;
  if (tag !== "c1" || !/^[0-9a-fA-F-]{36}$/.test(carrierId) || !/^[0-9a-f]{64}$/.test(hash))
    return null;
  return { carrierId, hash };
}

function createCrossCarrierReadTaskRef(
  store: EvidenceStore,
  scope: QqConversationScope,
  taskId: string,
  now: string,
  carrierMediaNoteId: string,
): SourceRef | null {
  const botScope = { channel: "onebot11" as const, ...scope };
  if (!evidenceScopeExists(store.db, botScope)) return null;
  if (!isDate(now)) return null;
  const ledger = ledgerProjection(store.db, scope, taskId);
  if (!ledger) return null;
  // The same-content proof: the CURRENT carrier's live asset content sha, the
  // task's own purpose/question and the task's own scope MUST recompute to the
  // ledger row's identity key. A NULL identity (legacy history row) never
  // mints; the same scope alone NEVER proves same content (picture A's note is
  // never signed for picture B).
  if (ledger.identityKey === null || ledger.identityKey.trim().length === 0) return null;
  const carrier = carrierProjection(store.db, scope, carrierMediaNoteId);
  if (!carrier) return null;
  const recomputed = mediaReadTaskIdentityKey({
    accountId: scope.accountId,
    conversationKind: scope.conversationKind,
    peerId: scope.peerId,
    agentId: scope.agentId,
    segmentKind: carrier.segmentKind,
    purpose: ledger.purpose === "detail" ? "detail" : "baseline",
    questionKey: ledger.questionKey,
    contentSha256: carrier.assetSha256,
  });
  if (recomputed !== ledger.identityKey) return null;
  if (ledger.status !== "succeeded" || ledger.note === null || ledger.modelName === null)
    return null;
  if (ledger.note.trim().length === 0 || ledger.modelName.trim().length === 0) return null;
  if ((ledger.purpose === "detail") !== (ledger.questionKey !== null && ledger.questionKey !== ""))
    return null;
  if (!inTimeline(store.db, botScope, "qq_media", carrierMediaNoteId)) return null;
  // The consumption cap: the ledger's own window AND the current carrier's
  // media/link/asset windows — the OLD carrier's window is never borrowed and
  // never extends anything.
  const caps = [
    ledger.taskExpiresAt,
    carrier.mediaExpiresAt,
    carrier.linkExpiresAt,
    carrier.assetExpiresAt,
  ];
  let cap: string | null = null;
  for (const value of caps) {
    if (!isDate(value)) return null;
    if (cap === null || Date.parse(value) < Date.parse(cap)) cap = value;
  }
  if (cap === null || Date.parse(cap) <= Date.parse(now)) return null;
  return {
    kind: "qq_media_read_task",
    id: taskId,
    revision: crossCarrierRevision(scope, ledger, carrier, carrierMediaNoteId),
    expiresAt: cap,
  };
}

function crossCarrierReadTaskAccess(
  db: Database,
  source: SourceRef,
  owner: RunOwner,
  principal: ContextPrincipal,
  now: string,
): "available" | "expired" | "revoked" {
  // Owner authorization first (R21 order): a cross-owner never learns even the
  // state of this ref.
  if (
    owner.userId === undefined ||
    owner.userId !== principal.userId ||
    principal.userId !== DEFAULT_USER_ID
  )
    return "revoked";
  const located = ownerScope(db, owner);
  if (located === "ambiguous" || !located) return "revoked";
  const scope = located.scope;
  if (!owner.agentId || owner.agentId !== scope.agentId) return "revoked";
  if (!evidenceScopeExists(db, { channel: "onebot11", ...scope })) return "revoked";
  const parsed = parseCrossCarrierRevision(source.revision);
  if (!parsed) return "revoked";
  const ledger = ledgerProjection(db, scope, source.id);
  if (!ledger) return "revoked";
  const carrier = carrierProjection(db, scope, parsed.carrierId);
  if (!carrier) return "revoked";
  if (ledger.identityKey === null || ledger.identityKey.trim().length === 0) return "revoked";
  const recomputed = mediaReadTaskIdentityKey({
    accountId: scope.accountId,
    conversationKind: scope.conversationKind,
    peerId: scope.peerId,
    agentId: scope.agentId,
    segmentKind: carrier.segmentKind,
    purpose: ledger.purpose === "detail" ? "detail" : "baseline",
    questionKey: ledger.questionKey,
    contentSha256: carrier.assetSha256,
  });
  if (recomputed !== ledger.identityKey) return "revoked";
  if (!inTimeline(db, { channel: "onebot11", ...scope }, "qq_media", parsed.carrierId))
    return "revoked";
  // Window verdicts come BEFORE the hash compare (same order as the
  // single-carrier form): a moved or dead window is an expiry fact, not a
  // tampering fact — the caps are recomputed from the live rows.
  const caps = [
    ledger.taskExpiresAt,
    carrier.mediaExpiresAt,
    carrier.linkExpiresAt,
    carrier.assetExpiresAt,
    ...(source.expiresAt !== undefined ? [source.expiresAt] : []),
  ];
  if (caps.some((value) => !isDate(value))) return "expired";
  const nowMs = Date.parse(now);
  if (caps.some((value) => Date.parse(value) <= nowMs)) return "expired";
  const expected = crossCarrierRevision(scope, ledger, carrier, parsed.carrierId);
  if (expected !== source.revision) return "revoked";
  return "available";
}
