import type { Database } from "bun:sqlite";
import type { SourceRef } from "../../shared/contracts/evidence";
import { bodyRevision } from "../db/conversation-event-repository";
import { memoryRevision } from "../db/memory-content-repository";
import { readQqConversationSummary } from "../db/qq-summary-repository";
import { DEFAULT_USER_ID, type Orm } from "../db/repositories";

import type {
  BotEvidenceScope,
  ConversationEvidenceScope,
  WebEvidenceScope,
} from "./conversation-evidence";
export type EvidenceDomain = "history" | "summary";
export interface EvidenceStore {
  db: Database;
  orm: Orm;
}
export interface StoredEvidence {
  text: string;
  title: string;
  sources: SourceRef[];
  revision: string;
}
// Damaged/oversized records fail closed without materializing unlimited TEXT in JavaScript.
const BYTES = 262144,
  LINKS = 100,
  CORRECTIONS = 32;
const bounded = (column: string, bytes = BYTES) =>
  `CASE WHEN length(CAST(${column} AS BLOB))<=${bytes} THEN ${column} END`;
export const evidenceHash = (value: unknown) => bodyRevision(JSON.stringify(value));
const hash = evidenceHash;
const parse = (value: string | null): unknown => {
  try {
    return value === null ? null : JSON.parse(value);
  } catch {
    return null;
  }
};
function record(
  text: string,
  title: string,
  sources: SourceRef[],
  stamp: unknown,
): StoredEvidence | null {
  return Buffer.byteLength(text) <= BYTES
    ? { text, title, sources, revision: hash([text, sources, stamp]) }
    : null;
}
function expiry(now: string, values: (string | undefined | null)[]): string | null {
  const dates = values.map((value) => (value ? Date.parse(value) : NaN));
  return dates.length && dates.every((value) => Number.isFinite(value) && value > Date.parse(now))
    ? new Date(Math.min(...dates)).toISOString()
    : null;
}
export const VALID_TURN = `FROM turns t JOIN sessions s ON s.id=t.session_id
  JOIN messages u ON u.turn_id=t.id AND u.session_id=s.id AND u.role='user' AND u.status='completed'
  JOIN messages a ON a.turn_id=t.id AND a.session_id=s.id AND a.role='assistant' AND a.status='completed'
  WHERE s.user_id=? AND s.agent_id=? AND t.source_valid=1 AND t.context_valid=1
  AND t.generation_status='completed' AND t.cancel_requested=0 AND t.invalidated_at IS NULL`;
interface Turn {
  id: string;
  sessionId: string;
  userId: string;
  assistantId: string;
  seq: number;
  revision: string;
  bodyHash: string;
}
function turn(db: Database, agent: string, id: string): Turn | null {
  const row = db
    .query(`SELECT t.id,t.session_id AS sessionId,u.id AS userId,a.id AS assistantId,
    ${bounded("u.content")} AS user,${bounded("a.content")} AS assistant,
    u.sequence_no AS seq,COALESCE(t.generation_token,'completed') AS revision ${VALID_TURN} AND t.id=?`)
    .get(DEFAULT_USER_ID, agent, id) as
    | (Omit<Turn, "bodyHash"> & { user: string | null; assistant: string | null })
    | null;
  if (!row || row.user === null || row.assistant === null) return null;
  const { user, assistant, ...metadata } = row;
  return { ...metadata, bodyHash: hash([user, assistant]) };
}
interface Link {
  turn_id: string;
  user_message_id: string;
  assistant_message_id: string;
  sequence_no: number;
}
function linkedTurn(db: Database, agent: string, link: Link): Turn | null {
  const t = turn(db, agent, link.turn_id);
  return t &&
    t.userId === link.user_message_id &&
    t.assistantId === link.assistant_message_id &&
    t.seq === link.sequence_no
    ? t
    : null;
}
interface Correction {
  id: string;
  body: string;
  revision: string;
  source_ids: string[];
}
function corrections(db: Database, agent: string, ids: string[]): Correction[] | null {
  if (!ids.length) return [];
  const rows = db
    .query(`SELECT id,${bounded("name")} AS name,${bounded("summary")} AS summary,
    ${bounded("tags")} AS tags,${bounded("body")} AS body,status,${bounded("config_snapshot")} AS configSnapshot
    FROM memory_entries m WHERE m.agent_id=? AND m.user_id=? AND m.status IN ('active','suppressed')
    AND CASE WHEN json_valid(m.config_snapshot) THEN json_type(m.config_snapshot,'$.content_correction.replaces')='text' ELSE 0 END
    AND EXISTS(SELECT 1 FROM memory_sources l WHERE l.memory_id=m.id AND l.turn_id IN (${ids.map(() => "?").join(",")}))
    ORDER BY m.created_at DESC,m.id LIMIT ?`)
    .all(agent, DEFAULT_USER_ID, ...ids, CORRECTIONS + 1) as Array<
    Parameters<typeof memoryRevision>[0]
  >;
  if (rows.length > CORRECTIONS) return null;
  const result: Correction[] = [];
  for (const row of rows) {
    if (Object.values(row).some((v) => v === null)) return null;
    const metadata = parse(row.configSnapshot) as { correction_retired?: unknown } | null;
    if (!metadata) return null;
    if (metadata.correction_retired === true) continue;
    if (row.status !== "active") return null;
    const links = db
      .query(
        "SELECT turn_id,user_message_id,assistant_message_id,sequence_no FROM memory_sources WHERE memory_id=? ORDER BY turn_id LIMIT ?",
      )
      .all(row.id, LINKS + 1) as Link[];
    // Never expose raw, rejected claims because one of a correction's parents disappeared.
    if (!links.length || links.length > LINKS || links.some((l) => !linkedTurn(db, agent, l)))
      return null;
    result.push({
      id: row.id,
      body: row.body,
      revision: memoryRevision(row),
      source_ids: links.filter((l) => ids.includes(l.turn_id)).map((l) => l.turn_id),
    });
  }
  return Buffer.byteLength(JSON.stringify(result)) <= BYTES ? result : null;
}
const correctionSources = (items: Correction[]): SourceRef[] =>
  items.map((c) => ({ kind: "memory", id: c.id, revision: c.revision }));
const turnSource = (t: Turn): SourceRef => ({ kind: "web_turn", id: t.id, revision: t.revision });
function webHistory(db: Database, scope: WebEvidenceScope, id: string): StoredEvidence | null {
  const m = db
    .query(`SELECT id,turn_id,sequence_no,role,${bounded("content")} AS content
    FROM messages WHERE id=? AND session_id=? AND status='completed' AND role IN ('user','assistant')`)
    .get(id, scope.sessionId) as {
    id: string;
    turn_id: string;
    sequence_no: number;
    role: string;
    content: string | null;
  } | null;
  if (!m || m.content === null || m.turn_id === scope.currentTurnId) return null;
  const t = turn(db, scope.agentId, m.turn_id);
  if (!t || t.sessionId !== scope.sessionId) return null;
  // With retrieval disabled the raw message is served: corrections are neither read nor attached.
  const fixes = scope.retrievalEnabled ? corrections(db, scope.agentId, [t.id]) : [];
  if (!fixes) return null;
  // The raw message is not a usable fact once corrected. Return the constraints instead,
  // so every independently read page is safe even when a long correction spans pages.
  const text = fixes.length
    ? `人工纠正（替代历史原文）：\n${fixes.map((c) => c.body).join("\n\n")}`
    : m.content;
  return record(
    text,
    `${m.role} #${m.sequence_no}${fixes.length ? " · corrected" : ""}`,
    [turnSource(t), ...correctionSources(fixes)],
    [m, fixes, t],
  );
}
function webSummary(db: Database, scope: WebEvidenceScope, id: string): StoredEvidence | null {
  const row = db
    .query(`SELECT id,source_count,${bounded("content")} AS content,
    ${bounded("config_snapshot")} AS config_snapshot,created_at FROM session_summaries
    WHERE id=? AND session_id=? AND agent_id=? AND user_id=? AND is_valid=1 AND invalidated_at IS NULL`)
    .get(id, scope.sessionId, scope.agentId, DEFAULT_USER_ID) as {
    id: string;
    source_count: number;
    content: string | null;
    config_snapshot: string | null;
    created_at: string;
  } | null;
  if (!row?.content || !row.config_snapshot || row.source_count < 1 || row.source_count > LINKS)
    return null;
  const links = db
    .query(
      "SELECT turn_id,user_message_id,assistant_message_id,sequence_no FROM summary_sources WHERE summary_id=? ORDER BY sequence_no,turn_id LIMIT ?",
    )
    .all(id, LINKS + 1) as Link[];
  if (links.length !== row.source_count) return null;
  const parents = links.map((l) => linkedTurn(db, scope.agentId, l));
  if (parents.some((t) => !t || t.sessionId !== scope.sessionId || t.id === scope.currentTurnId))
    return null;
  // Disabled retrieval reads no corrections and requires the snapshot to carry the empty set
  // (saveSummary stores [] when retrieval is off), matching the context repository.
  const fixes = scope.retrievalEnabled
    ? corrections(
        db,
        scope.agentId,
        links.map((l) => l.turn_id),
      )
    : [];
  const config = parse(row.config_snapshot) as { memory_corrections?: unknown } | null;
  if (
    !fixes ||
    !config ||
    JSON.stringify(config.memory_corrections ?? []) !== JSON.stringify(fixes)
  )
    return null;
  const content = parse(row.content) as { facts?: { text: string; source_ids: string[] }[] } | null;
  if (
    !Array.isArray(content?.facts) ||
    content.facts.length > LINKS ||
    content.facts.some(
      (f) =>
        !f ||
        typeof f.text !== "string" ||
        !Array.isArray(f.source_ids) ||
        !f.source_ids.length ||
        f.source_ids.some((s) => !links.some((l) => l.turn_id === s)),
    )
  )
    return null;
  return record(
    row.content,
    "Session summary",
    [...parents.flatMap((t) => (t ? [turnSource(t)] : [])), ...correctionSources(fixes)],
    [row, links, fixes, parents],
  );
}
function inTimeline(db: Database, scope: BotEvidenceScope, kind: string, id: string): boolean {
  return !!db
    .query(`SELECT 1 FROM conversation_events e WHERE e.conversation_id=? AND
    e.kind IN ('inbound','outbound') AND (e.source_kind<>'qq_send' OR EXISTS(
      SELECT 1 FROM qq_send_log l WHERE l.id=e.source_id AND l.outcome='sent')) AND
    ((e.source_id=? AND (e.source_kind=? OR (?='qq_observation' AND e.source_kind='qq_event'))) OR
    EXISTS(SELECT 1 FROM json_each(CASE WHEN length(e.sources)<=65536 AND json_valid(e.sources)
      THEN e.sources ELSE '[]' END) s WHERE s.type='object'
      AND json_extract(s.value,'$.kind')=? AND json_extract(s.value,'$.id')=?)) LIMIT 1`)
    .get(scope.conversationId, id, kind, kind, kind, id);
}
function qqBody(
  db: Database,
  scope: BotEvidenceScope,
  kind: string,
  id: string,
  now: string,
): { text: string; source: SourceRef } | null {
  if (!inTimeline(db, scope, kind, id)) return null;
  const args = [id, scope.accountId, scope.conversationKind, scope.peerId, scope.agentId];
  if (kind === "qq_media") {
    const row = db
      .query(`SELECT n.attempts,n.expires_at FROM qq_media_notes n JOIN qq_events e ON e.event_key=n.event_key
      WHERE n.id=? AND e.account_id=? AND e.conversation_kind=? AND e.peer_id=? AND e.agent_id=? AND n.note IS NOT NULL`)
      .get(...args) as { attempts: number; expires_at: string } | null;
    return row && expiry(now, [row.expires_at])
      ? {
          text: "",
          source: { kind, id, revision: String(row.attempts), expiresAt: row.expires_at },
        }
      : null;
  }
  if (kind === "qq_observation" || kind === "qq_speech") {
    const incoming = kind === "qq_observation",
      table = incoming ? "qq_events" : "qq_speech_log";
    const textTable = incoming ? "qq_observation_text" : "qq_speech_text",
      key = incoming ? "event_key" : "id",
      fk = incoming ? "event_key" : "speech_id";
    const row = db
      .query(`SELECT ${bounded("t.body")} AS body,t.expires_at,${incoming ? "t.expires_at" : "e.expires_at"} AS log_expiry
      FROM ${table} e JOIN ${textTable} t ON t.${fk}=e.${key} WHERE e.${key}=?
      AND e.account_id=? AND e.conversation_kind=? AND e.peer_id=? AND e.agent_id=?`)
      .get(...args) as { body: string | null; expires_at: string; log_expiry: string } | null;
    const until = row && expiry(now, [row.expires_at, row.log_expiry]);
    return row?.body && until
      ? { text: row.body, source: { kind, id, revision: bodyRevision(row.body), expiresAt: until } }
      : null;
  }
  if (kind !== "outbound_intent") return null;
  const row = db
    .query(`SELECT ${bounded("target")} AS target,expires_at FROM outbound_intents
    WHERE id=? AND conversation_id=? AND status='confirmed'`)
    .get(id, scope.conversationId) as { target: string | null; expires_at: string } | null;
  if (!row || !expiry(now, [row.expires_at])) return null;
  const target = parse(row.target) as Record<string, unknown> | null;
  if (
    !target ||
    ["agentId", "bindingId", "bindingEpoch", "accountId", "conversationKind", "peerId"].some(
      (k) => target[k] !== scope[k as keyof BotEvidenceScope],
    )
  )
    return null;
  const parts = db
    .query(
      `SELECT ${bounded("payload")} AS payload,status FROM outbound_parts WHERE intent_id=? AND kind='text' ORDER BY ordinal LIMIT ?`,
    )
    .all(id, LINKS + 1) as { payload: string | null; status: string }[];
  if (
    !parts.length ||
    parts.length > LINKS ||
    parts.some((p) => p.status !== "confirmed" || !p.payload)
  )
    return null;
  const texts = parts.map((p) => (parse(p.payload) as { text?: unknown } | null)?.text);
  if (texts.some((t) => typeof t !== "string")) return null;
  const text = texts.join("\n");
  return Buffer.byteLength(text) <= BYTES
    ? { text, source: { kind, id, revision: bodyRevision(text), expiresAt: row.expires_at } }
    : null;
}
function botHistory(
  db: Database,
  scope: BotEvidenceScope,
  key: number,
  now: string,
): StoredEvidence | null {
  const event = db
    .query(`SELECT kind,source_kind,source_id,source_expires_at,${bounded("sources", 65536)} AS sources
    FROM conversation_events WHERE conversation_id=? AND seq=?`)
    .get(scope.conversationId, key) as {
    kind: string;
    source_kind: string;
    source_id: string;
    source_expires_at: string | null;
    sources: string | null;
  } | null;
  if (!event || (event.source_expires_at && !expiry(now, [event.source_expires_at]))) return null;
  let kind = event.source_kind,
    id = event.source_id;
  if (event.kind === "inbound" && (kind === "qq_event" || kind === "qq_observation"))
    kind = "qq_observation";
  else if (event.kind === "outbound" && kind === "qq_send") {
    const send = db
      .query(`SELECT sent_at_seconds,kind,expires_at FROM qq_send_log WHERE id=? AND outcome='sent'
      AND account_id=? AND conversation_kind=? AND peer_id=? AND agent_id=?`)
      .get(id, scope.accountId, scope.conversationKind, scope.peerId, scope.agentId) as {
      sent_at_seconds: number;
      kind: string;
      expires_at: string;
    } | null;
    const refs = parse(event.sources) as SourceRef[] | null;
    const speech =
      Array.isArray(refs) && refs.length <= LINKS
        ? refs.find((s) => s?.kind === "qq_speech")
        : null;
    if (
      !send ||
      !expiry(now, [send.expires_at]) ||
      !speech ||
      !db
        .query("SELECT 1 FROM qq_speech_log WHERE id=? AND spoke_at_seconds=? AND kind=?")
        .get(speech.id, send.sent_at_seconds, send.kind)
    )
      return null;
    kind = "qq_speech";
    id = speech.id;
  } else if (!(event.kind === "outbound" && ["qq_speech", "outbound_intent"].includes(kind)))
    return null;
  const body = qqBody(db, scope, kind, id, now);
  if (!body) return null;
  return record(body.text, `${event.kind} #${key}`, [body.source], event);
}
export function storedPackages(store: EvidenceStore, scope: BotEvidenceScope) {
  // readQqConversationSummary is the existing stored-package reader, not the compressor.
  if (
    !store.db
      .query(`SELECT 1 FROM qq_conversation_summaries WHERE conversation_id=? AND agent_id=?
    AND length(CAST(content AS BLOB))<=1048576 AND length(CAST(config_snapshot AS BLOB))<=262144`)
      .get(scope.conversationId, scope.agentId)
  )
    return null;
  try {
    const summary = readQqConversationSummary(store.orm, scope.conversationId, scope.agentId);
    return summary && summary.packages.length <= LINKS ? summary : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError"))
      return null;
    throw error;
  }
}
function botSummary(
  store: EvidenceStore,
  scope: BotEvidenceScope,
  key: string,
  now: string,
): StoredEvidence | null {
  const stored = storedPackages(store, scope),
    item = stored?.packages.find((p) => hash(p) === key);
  if (
    !item?.sources?.length ||
    item.sources.length > LINKS ||
    !Array.isArray(item.facts) ||
    item.facts.length > LINKS
  )
    return null;
  const sources: SourceRef[] = [];
  for (const s of item.sources) {
    if (s.expiresAt && !expiry(now, [s.expiresAt])) return null;
    const source = qqBody(store.db, scope, s.kind, s.id, now)?.source;
    if (!source || source.revision !== s.revision) return null;
    sources.push({
      ...source,
      expiresAt: expiry(now, [source.expiresAt, s.expiresAt ?? source.expiresAt]) ?? undefined,
    });
  }
  if (
    item.facts.some(
      (f) =>
        !f ||
        typeof f.text !== "string" ||
        !Array.isArray(f.source_ids) ||
        !f.source_ids.length ||
        f.source_ids.some((id) => {
          const tuples = typeof id === "string" ? parse(id) : null;
          return (
            !Array.isArray(tuples) ||
            !tuples.length ||
            tuples.some(
              (t) =>
                !Array.isArray(t) ||
                t.length !== 3 ||
                !sources.some((s) => s.kind === t[0] && s.id === t[1] && s.revision === t[2]),
            )
          );
        }),
    )
  )
    return null;
  return record(
    JSON.stringify(item.facts),
    `QQ summary #${item.fromSeq}–${item.throughSeq}`,
    sources,
    stored,
  );
}
export function loadConversationEvidence(
  store: EvidenceStore,
  scope: ConversationEvidenceScope,
  domain: EvidenceDomain,
  key: string | number,
  now: string,
): StoredEvidence | null {
  if (scope.channel === "web")
    return typeof key !== "string"
      ? null
      : domain === "history"
        ? webHistory(store.db, scope, key)
        : webSummary(store.db, scope, key);
  if (domain === "history")
    return typeof key === "number" ? botHistory(store.db, scope, key, now) : null;
  return typeof key === "string" ? botSummary(store, scope, key, now) : null;
}
