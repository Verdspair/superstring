import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { SourceRef } from "../../shared/contracts/evidence";
import { memoryPublicationSourceRevisions } from "../db/memory-source-repository";
import type { Orm } from "../db/repositories";
import * as schema from "../db/schema";
import { memoryRevision } from "./memory-revision";
import { type QqMemoryAccess, qqMemoryScopeKey } from "./qq-binding-contract";

// Legacy scope keys remain job and QQ binding identifiers; they are not Web
// runtime authority. Canonical conversation mode and provenance decide runtime access.
export type MemoryScopeKeys = readonly string[] | null;

export interface MemoryScopeKeyset {
  /** Scopes a read may draw from. `null` = agent-level (unscoped) read. */
  readonly read: MemoryScopeKeys;
  /** Single `scope_key` written for a new memory and frozen into the job snapshot. */
  readonly write: string;
  /** Digest input so a mid-scan scope change invalidates a catalog scan. */
  readonly fingerprintSeed: string;
}

function seedOf(keys: MemoryScopeKeys): string {
  return keys === null ? "agent" : JSON.stringify(keys);
}

/** Historical Web write key; runtime reads require current conversation eligibility. */
export function webMemoryScopeKeyset(agentId: string): MemoryScopeKeyset {
  return Object.freeze({ read: null, write: agentId, fingerprintSeed: seedOf(null) });
}

/** A QQ conversation reads its own scope and, only when sharing is on, the web scope. */
export function qqMemoryScopeKeyset(access: QqMemoryAccess): MemoryScopeKeyset {
  const read = Object.freeze(access.readScopes.map(qqMemoryScopeKey));
  return Object.freeze({
    read,
    write: qqMemoryScopeKey(access.writeScope),
    fingerprintSeed: seedOf(read),
  });
}

export interface MemoryConversationAccess {
  readonly conversationId: string;
  readonly agentId: string;
  readonly userId: string;
  readonly channel: "web" | "onebot11";
  readonly sourceId: string;
  readonly bindingEpoch: number;
  readonly authorityRevision: number;
  readonly mode: "current_conversation" | "agent_shared";
  readonly revision: number;
}

type MemoryEntry = typeof schema.memoryEntries.$inferSelect;

/** Resolve only an active canonical conversation belonging to the caller. */
export function memoryConversationAccess(
  orm: Orm,
  conversationId: string,
  agentId: string,
  userId: string,
): MemoryConversationAccess | null {
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const row = db
    .query(`SELECT c.id,c.agent_id,c.user_id,c.channel,c.source_id,c.binding_epoch,
    c.memory_read_mode,c.memory_config_revision,CASE WHEN c.channel='onebot11' THEN COALESCE((SELECT b.authority_revision FROM qq_bindings b WHERE b.id=c.source_id),0) ELSE 0 END AS authority_revision FROM conversations c
    WHERE c.id=? AND c.agent_id=? AND c.user_id=? AND c.closed_at IS NULL
      AND ((c.channel='web' AND EXISTS (SELECT 1 FROM sessions s WHERE s.id=c.source_id AND s.agent_id=c.agent_id AND s.user_id=c.user_id))
        OR (c.channel='onebot11' AND EXISTS (SELECT 1 FROM qq_bindings b WHERE b.id=c.source_id AND b.agent_id=c.agent_id)))`)
    .get(conversationId, agentId, userId) as {
    id: string;
    agent_id: string;
    user_id: string;
    channel: "web" | "onebot11";
    source_id: string;
    binding_epoch: number;
    authority_revision: number;
    memory_read_mode: "current_conversation" | "agent_shared";
    memory_config_revision: number;
  } | null;
  return row
    ? {
        conversationId: row.id,
        agentId: row.agent_id,
        userId: row.user_id,
        channel: row.channel,
        sourceId: row.source_id,
        bindingEpoch: row.binding_epoch,
        authorityRevision: row.authority_revision,
        mode: row.memory_read_mode,
        revision: row.memory_config_revision,
      }
    : null;
}

/** Bind a runtime owner to the exact canonical conversation before reading metadata. */
export function memoryAccessOwnerMatches(
  orm: Orm,
  access: MemoryConversationAccess,
  owner: { kind: string; id: string; userId?: string; agentId?: string },
  sessionId?: string,
): boolean {
  if (owner.userId !== access.userId || owner.agentId !== access.agentId) return false;
  if (owner.kind === "web_turn") {
    if (access.channel !== "web" || sessionId !== access.sourceId) return false;
    const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
    const turn = db.query("SELECT session_id FROM turns WHERE id=?").get(owner.id) as {
      session_id: string;
    } | null;
    return turn?.session_id === access.sourceId;
  }
  if (owner.kind === "qq_binding")
    return access.channel === "onebot11" && owner.id === access.sourceId && sessionId === undefined;
  return (
    owner.kind === "conversation" && owner.id === access.conversationId && sessionId === undefined
  );
}

/** Bind cursors to the currently explicit recipient set without retaining permissions. */
export function memoryGrantFingerprint(orm: Orm, access: MemoryConversationAccess): string {
  if (access.mode !== "agent_shared") return "private";
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const grants = db
    .query("SELECT memory_id,token FROM memory_read_grants WHERE agent_id=? ORDER BY memory_id")
    .all(access.agentId);
  return createHash("sha256").update(JSON.stringify(grants)).digest("hex");
}

/** Current-session private and explicitly granted shared/public entries use one access ref. */
export function memoryAccessEvidence(
  orm: Orm,
  access: MemoryConversationAccess,
  rows: readonly MemoryEntry[],
  ownPrivateIds: ReadonlySet<string>,
  now: string,
): ReadonlyMap<string, SourceRef> {
  if (rows.length === 0) return new Map();
  const eligible = rows.filter(
    (row) =>
      row.userId === access.userId &&
      row.status === "active" &&
      (ownPrivateIds.has(row.id) ||
        (access.mode === "agent_shared" &&
          (row.visibility === "public" ||
            (row.visibility === "agent_shared" && row.agentId === access.agentId)))),
  );
  if (eligible.length === 0) return new Map();
  const tokenById = new Map<string, string>();
  for (let offset = 0; offset < eligible.length; offset += 500) {
    const ids = eligible.slice(offset, offset + 500).map((row) => row.id);
    const grants = orm
      .select()
      .from(schema.memoryReadGrants)
      .where(inArray(schema.memoryReadGrants.memoryId, ids))
      .all();
    for (const grant of grants)
      if (grant.agentId === access.agentId) tokenById.set(grant.memoryId, grant.token);
  }
  const qualified = eligible.filter((row) => ownPrivateIds.has(row.id) || tokenById.has(row.id));
  const revisions = new Map(qualified.map((row) => [row.id, memoryRevision(row)]));
  const proofs = memoryPublicationSourceRevisions(orm, qualified, revisions, now);
  const result = new Map<string, SourceRef>();
  for (const row of qualified) {
    const proof = proofs.get(row.id);
    if (!proof || (!ownPrivateIds.has(row.id) && proof !== row.publicationSourceRevision)) continue;
    const id = JSON.stringify([access.agentId, access.conversationId, row.id]);
    const revision = createHash("sha256")
      .update(
        JSON.stringify([
          access.revision,
          access.bindingEpoch,
          access.authorityRevision,
          revisions.get(row.id),
          row.visibilityRevision,
          ownPrivateIds.has(row.id) ? null : tokenById.get(row.id),
          proof,
        ]),
      )
      .digest("hex");
    result.set(row.id, { kind: "memory_access", id, revision });
  }
  return result;
}

/** True when a stored `scope_key` is visible to the given read scope. */
export function scopeKeyVisible(scopeKey: string, keys: MemoryScopeKeys): boolean {
  return keys === null ? true : keys.includes(scopeKey);
}
