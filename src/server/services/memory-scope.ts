import { createHash } from "node:crypto";
import { and, eq, getTableColumns, inArray, or, sql } from "drizzle-orm";
import type { SourceRef } from "../../shared/contracts/evidence";
import {
  memoryPublicationSourceRevisions,
  memorySourceFactAssessment,
  retainedMemoryPublications,
} from "../db/memory-source-repository";
import type { Orm } from "../db/repositories";
import * as schema from "../db/schema";
import { memoryJobScopes } from "./memory-contract";
import { isCorrectionRetired, memoryMetadata, memoryRevision } from "./memory-revision";
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

/** Resolve the canonical Web conversation, never treating a session ID as a journal ID. */
export function memoryConversationForSession(
  orm: Orm,
  agentId: string,
  sessionId: string,
  userId: string,
): MemoryConversationAccess | null {
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const row = db
    .query(`SELECT id FROM conversations WHERE channel='web' AND source_id=?
    AND agent_id=? AND user_id=? AND closed_at IS NULL`)
    .get(sessionId, agentId, userId) as { id: string } | null;
  return row ? memoryConversationAccess(orm, row.id, agentId, userId) : null;
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
function memoryAccessEvidence(
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
      !isCorrectionRetired(row.configSnapshot) &&
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
  const ordinary = qualified.filter(
    (row) =>
      ownPrivateIds.has(row.id) &&
      row.visibility !== "public" &&
      row.visibility !== "agent_shared" &&
      !memoryJobScopes(memoryMetadata(row.configSnapshot)).route,
  );
  const ordinaryIds = new Set(ordinary.map((row) => row.id));
  const facts = memorySourceFactAssessment(orm, ordinary);
  const distributed = qualified.filter(
    (row) => row.visibility === "public" || row.visibility === "agent_shared",
  );
  const distributedIds = new Set(distributed.map((row) => row.id));
  const proofs = new Map(
    memoryPublicationSourceRevisions(
      orm,
      qualified.filter((row) => !ordinaryIds.has(row.id) && !distributedIds.has(row.id)),
      revisions,
      now,
    ),
  );
  for (const [id, proof] of retainedMemoryPublications(orm, distributed, now))
    proofs.set(id, proof);
  const webIds = [
    ...new Set(
      [...facts.webSources.values()]
        .flat()
        .flatMap((link) => [link.userMessageId, link.assistantMessageId]),
    ),
  ];
  const webBodies = new Map<string, string>();
  for (let offset = 0; offset < webIds.length; offset += 500) {
    for (const message of orm
      .select({
        id: schema.messages.id,
        content: sql<
          string | null
        >`CASE WHEN length(CAST(${schema.messages.content} AS BLOB))<=262144 THEN ${schema.messages.content} END`,
      })
      .from(schema.messages)
      .where(inArray(schema.messages.id, webIds.slice(offset, offset + 500)))
      .all())
      if (message.content !== null) webBodies.set(message.id, message.content);
  }
  for (const row of ordinary) {
    const fact = facts.revisions.get(row.id);
    if (facts.states.get(row.id) !== "valid" || !fact) continue;
    const links = facts.webSources.get(row.id) ?? [];
    const ids = [
      ...new Set(links.flatMap((link) => [link.userMessageId, link.assistantMessageId])),
    ].sort();
    if (ids.some((id) => !webBodies.has(id))) continue;
    const webRevision = ids.map((id) => [id, webBodies.get(id)]);
    proofs.set(
      row.id,
      createHash("sha256")
        .update(JSON.stringify(["ordinary-retained", fact, webRevision]))
        .digest("hex"),
    );
  }
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

/** Coarse candidate eligibility before any title/body projection; proof is revalidated below. */
export function runtimeCandidateCondition(access: MemoryConversationAccess) {
  const e = schema.memoryEntries;
  const ownSource =
    access.channel === "web"
      ? sql`EXISTS (SELECT 1 FROM memory_sources ms JOIN turns t ON t.id=ms.turn_id WHERE ms.memory_id=${e.id} AND t.session_id=${access.sourceId})
      AND NOT EXISTS (SELECT 1 FROM memory_sources ms LEFT JOIN turns t ON t.id=ms.turn_id WHERE ms.memory_id=${e.id} AND (t.id IS NULL OR t.session_id<>${access.sourceId} OR t.context_valid<>1 OR t.source_valid<>1 OR t.generation_status<>'completed'))
      AND NOT EXISTS (SELECT 1 FROM qq_memory_sources qs WHERE qs.memory_id=${e.id})`
      : sql`EXISTS (SELECT 1 FROM qq_memory_sources qs JOIN conversation_events ce ON ce.source_kind='qq_event' AND ce.source_id=qs.event_key WHERE qs.memory_id=${e.id} AND ce.conversation_id=${access.conversationId})
      AND NOT EXISTS (SELECT 1 FROM qq_memory_sources qs WHERE qs.memory_id=${e.id} AND NOT EXISTS (SELECT 1 FROM conversation_events ce WHERE ce.source_kind='qq_event' AND ce.source_id=qs.event_key AND ce.conversation_id=${access.conversationId}))
      AND NOT EXISTS (SELECT 1 FROM memory_sources ms WHERE ms.memory_id=${e.id})`;
  const own = and(eq(e.agentId, access.agentId), ownSource)!;
  if (access.mode !== "agent_shared") return own;
  const granted = sql`(${e.visibility}='public' OR (${e.visibility}='agent_shared' AND ${e.agentId}=${access.agentId}))
    AND EXISTS (SELECT 1 FROM memory_read_grants g WHERE g.memory_id=${e.id} AND g.agent_id=${access.agentId})`;
  return or(own, granted)!;
}

/** All private sources must match the canonical conversation; explicit publication uses its own proof. */
export function qualifyMemoryEntries(
  orm: Orm,
  access: MemoryConversationAccess,
  rows: readonly MemoryEntry[],
): ReadonlyMap<string, SourceRef> {
  if (!rows.length) return new Map();
  const owned = orm
    .select({ id: schema.memoryEntries.id })
    .from(schema.memoryEntries)
    .where(
      and(
        inArray(
          schema.memoryEntries.id,
          rows.map((row) => row.id),
        ),
        runtimeCandidateCondition({ ...access, mode: "current_conversation" }),
      ),
    )
    .all();
  return memoryAccessEvidence(
    orm,
    access,
    rows,
    new Set(owned.map((row) => row.id)),
    new Date().toISOString(),
  );
}

export function memoryAccessRefs(
  orm: Orm,
  access: MemoryConversationAccess,
  ids: readonly string[],
): ReadonlyMap<string, import("../../shared/contracts/evidence").SourceRef> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows: MemoryEntry[] = [];
  for (let offset = 0; offset < unique.length; offset += 500) {
    const selected = orm
      .select({
        ...getTableColumns(schema.memoryEntries),
        body: sql<string>`CASE WHEN length(CAST(${schema.memoryEntries.body} AS BLOB)) <= 64000 THEN ${schema.memoryEntries.body} ELSE '' END`,
        bodyBytes: sql<number>`length(CAST(${schema.memoryEntries.body} AS BLOB))`,
      })
      .from(schema.memoryEntries)
      .where(
        and(
          inArray(schema.memoryEntries.id, unique.slice(offset, offset + 500)),
          eq(schema.memoryEntries.userId, access.userId),
          eq(schema.memoryEntries.status, "active"),
          runtimeCandidateCondition(access),
        ),
      )
      .all();
    rows.push(...selected.filter((row) => row.bodyBytes <= 64000 && row.body.length <= 16000));
  }
  const refs = new Map<string, import("../../shared/contracts/evidence").SourceRef>();
  for (let offset = 0; offset < rows.length; offset += 300) {
    for (const [id, ref] of qualifyMemoryEntries(orm, access, rows.slice(offset, offset + 300)))
      refs.set(id, ref);
  }
  return refs;
}
