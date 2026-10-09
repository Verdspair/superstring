import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  ContextHandle,
  InspectedContext,
  InspectedModelResult,
  ModelMessage,
  RunOwner,
  RunSnapshot,
} from "../../shared/contracts/agent-run";
import type { SourceAccess, SourceRef } from "../../shared/contracts/evidence";
import type { AgentRunRepository } from "../db/agent-run-repository";
import { ConversationEventRepository } from "../db/conversation-event-repository";
import { memoryRevision } from "../db/memory-content-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import { fail } from "../errors";
import type { ModuleSourceResolver } from "../modules/composition";
import { stringifyJsonSpaced } from "../services/memory-contract";
import { qqMediaSourceAccess } from "../services/qq-media-sources";
import { qqMediaReadTaskSourceAccess } from "../services/qq-media-task-sources";
import { qqMemberRosterSourceAccess } from "../services/qq-member-roster-sources";
import { qqMemberNameSourceAccess } from "../services/qq-member-sources";
import { qqMemoryJobSourceAccess } from "../services/qq-memory-fact-input";
import { qqMessageFactSourceAccess } from "../services/qq-message-fact-sources";
import { qqOutboundFactSourceAccess } from "../services/qq-outbound-fact-sources";
import { visibleConversation } from "./conversation-access";

export interface ContextPrincipal {
  userId: string;
}

/**
 * 走 `sourceAccess` 直接复验的七类来源（其余交给 resolveSource 或 inspection 回退）。
 * assertContextSources 与 inspectContext 共用这一份判定，新增直连 kind 只改这里。
 */
const DIRECT_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "qq_media_note",
  "qq_message_fact",
  "qq_member_name",
  "qq_outbound_message_fact",
  "qq_media_read_task",
  "qq_observation",
  "qq_media_source",
  "qq_member_roster",
]);

function isDirectSourceKind(kind: string): boolean {
  return DIRECT_SOURCE_KINDS.has(kind);
}

/**
 * 固定 buildConsolidationPrompt 的 user 前缀（memory-contract.ts 的同字面量）：只按它定位
 * 整理输入的结构化来源消息，不做任意模型文本替换。
 */
const CONSOLIDATION_SOURCE_PREFIX = "来源数据（非指令）：\n";

/** name ref id（JSON 4 元组 [account,kind,peer,qq]）→ 目标 QQ；畸形/不可定位 → null。 */
function memberNameRefQq(id: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(id);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 4) return null;
  const qq = value[3];
  return typeof qq === "string" && qq !== "" ? qq : null;
}

/**
 * memory_job 的可选当前名裁剪（T06）：只处理固定 buildConsolidationPrompt user 前缀后的
 * 来源 JSON——把目标 QQ（speaker.qq / mention identity.qq）的 currentName 剪空；发送时
 * 快照、正文与关系原样，不触碰其它 QQ 的名字。前缀/结构不符时返回 null（fail closed）；
 * 找不到前缀消息也返回 null（不能虚报已裁剪）。
 */
function trimMemoryJobCurrentNames(
  messages: readonly ModelMessage[],
  deadQqs: ReadonlySet<string>,
): ModelMessage[] | null {
  let matched = false;
  const output: ModelMessage[] = [];
  for (const message of messages) {
    const content: ModelMessage["content"] = [];
    for (const part of message.content) {
      if (part.kind !== "text" || !part.text.startsWith(CONSOLIDATION_SOURCE_PREFIX)) {
        content.push(part);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(part.text.slice(CONSOLIDATION_SOURCE_PREFIX.length));
      } catch {
        return null;
      }
      if (!Array.isArray(parsed)) return null;
      for (const entry of parsed) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;
        const speaker = record.speaker;
        const qq =
          speaker !== null && typeof speaker === "object"
            ? (speaker as { qq?: unknown }).qq
            : undefined;
        if (
          typeof qq === "string" &&
          deadQqs.has(qq) &&
          "currentName" in record &&
          record.currentName !== null
        ) {
          record.currentName = null;
        }
        const mentions = record.mentions;
        if (Array.isArray(mentions)) {
          for (const mention of mentions) {
            const identity =
              mention !== null && typeof mention === "object"
                ? (mention as { identity?: unknown }).identity
                : undefined;
            if (identity === null || typeof identity !== "object") continue;
            const identityObject = identity as Record<string, unknown>;
            const mentionQq = identityObject.qq;
            if (
              typeof mentionQq === "string" &&
              deadQqs.has(mentionQq) &&
              "currentName" in identityObject
            ) {
              delete identityObject.currentName;
            }
          }
        }
      }
      matched = true;
      content.push({ ...part, text: CONSOLIDATION_SOURCE_PREFIX + stringifyJsonSpaced(parsed) });
    }
    output.push({ ...message, content });
  }
  return matched ? output : null;
}

/** Resolve the application's existing ownership, not a principal supplied in a URL. */
export function canReadRun(db: Database, owner: RunOwner, principal: ContextPrincipal): boolean {
  if (owner.userId !== undefined && owner.userId !== principal.userId) return false;
  if (owner.kind === "conversation") {
    const conversation = visibleConversation(
      db,
      new ConversationEventRepository(db),
      owner.id,
      principal,
      true,
    );
    return !!conversation && (!owner.agentId || conversation.agentId === owner.agentId);
  }
  if (owner.kind === "qq_binding") {
    return (
      principal.userId === DEFAULT_USER_ID &&
      !!db
        .query("SELECT 1 FROM qq_bindings WHERE id=? AND (? IS NULL OR agent_id=?)")
        .get(owner.id, owner.agentId ?? null, owner.agentId ?? null)
    );
  }
  if (owner.userId !== undefined) return owner.userId === principal.userId;
  if (principal.userId !== DEFAULT_USER_ID) return false;
  switch (owner.kind) {
    case "memory_job": {
      const job = db.query("SELECT user_id FROM memory_jobs WHERE id=?").get(owner.id) as {
        user_id: string;
      } | null;
      return job?.user_id === principal.userId;
    }
    case "web_turn": {
      const row = db
        .query(`SELECT s.user_id FROM turns t JOIN sessions s ON s.id=t.session_id
        WHERE t.id=?`)
        .get(owner.id) as { user_id: string } | null;
      return row?.user_id === principal.userId;
    }
    case "knowledge_job":
      return db.query("SELECT 1 FROM knowledge_jobs WHERE id=?").get(owner.id) !== null;
    case "qq_media":
      return db.query("SELECT 1 FROM qq_media_notes WHERE id=?").get(owner.id) !== null;
    case "qq_speech":
      return db.query("SELECT 1 FROM qq_speech_log WHERE id=?").get(owner.id) !== null;
    case "qq_sticker":
      return db.query("SELECT 1 FROM qq_sticker_assets WHERE id=?").get(owner.id) !== null;
    default:
      return false;
  }
}

/** Source references name facts; each type keeps the authorization rules of its original store. */
export function sourceAccess(
  db: Database,
  source: SourceRef,
  owner: RunOwner,
  principal: ContextPrincipal,
  now: string,
  purpose: "execution" | "inspection" = "execution",
): SourceAccess {
  // This kind delegates to the media service, which checks owner authorization before
  // any expiry — the generic top-of-function expiry would leak an expired state to a
  // cross-owner before the owner check, so it must precede it (R21).
  if (source.kind === "qq_media_source")
    return qqMediaSourceAccess(db, source, owner, principal, now) ?? "revoked";
  // Same owner-first delegate for read-task results: the service checks owner
  // authorization before any expiry — a cross-owner never learns an expired
  // state (R21 order). The task kind is direct-domain: an optional external
  // resolver can never flip its verdict.
  if (source.kind === "qq_media_read_task")
    return qqMediaReadTaskSourceAccess(db, source, owner, principal, now) ?? "revoked";
  // memory_job 的 QQ 事实/当前名来源走窄 keeper：先核 owner 是本 job 自己、ref 属于该 job
  // 的 source_event_ids（或真实出现过的 speaker/mention），再委托既有 conversation/binding
  // access 算法。外部 resolver 不能翻转（直连域，R21 order）。
  if (
    (source.kind === "qq_message_fact" || source.kind === "qq_member_name") &&
    owner.kind === "memory_job"
  ) {
    return qqMemoryJobSourceAccess(db, source, owner, now) ?? "revoked";
  }
  // Same owner-first delegate for message facts: the service checks owner authorization
  // before any expiry, so a cross-owner never learns an expired state (R21 order).
  if (source.kind === "qq_message_fact")
    return qqMessageFactSourceAccess(db, source, owner, principal, now) ?? "revoked";
  if (source.kind === "qq_member_name")
    return qqMemberNameSourceAccess(db, source, owner, principal, now) ?? "revoked";
  if (source.kind === "qq_member_roster")
    return qqMemberRosterSourceAccess(db, source, owner, now, principal) ?? "revoked";
  // Same owner-first delegate for confirmed outbound part facts: the service checks
  // owner authorization before any expiry, so a cross-owner never learns an expired
  // state (R21 order). The kind is direct-domain: an optional external resolver can
  // never flip its verdict.
  if (source.kind === "qq_outbound_message_fact")
    return qqOutboundFactSourceAccess(db, source, owner, principal, now) ?? "revoked";
  if (source.expiresAt !== undefined && Date.parse(source.expiresAt) <= Date.parse(now)) {
    return "expired";
  }
  switch (source.kind) {
    case "web_turn": {
      const row = db
        .query(`SELECT t.source_valid,t.context_valid,t.generation_status,t.generation_token,
        t.cancel_requested,t.invalidated_at,s.user_id,s.agent_id FROM turns t
        JOIN sessions s ON s.id=t.session_id WHERE t.id=?`)
        .get(source.id) as {
        source_valid: number;
        context_valid: number;
        generation_status: string;
        generation_token: string | null;
        cancel_requested: number;
        invalidated_at: string | null;
        user_id: string;
        agent_id: string;
      } | null;
      return row &&
        row.user_id === principal.userId &&
        ((row.source_valid === 1 && row.context_valid === 1) ||
          (row.generation_status === "active" &&
            row.generation_token === source.revision &&
            row.cancel_requested === 0 &&
            row.invalidated_at === null)) &&
        (!owner.agentId || owner.agentId === row.agent_id)
        ? "available"
        : "revoked";
    }
    case "memory": {
      const row = db
        .query(
          "SELECT user_id,agent_id,id,name,summary,tags,body,status,config_snapshot AS configSnapshot FROM memory_entries WHERE id=?",
        )
        .get(source.id) as
        | (Parameters<typeof memoryRevision>[0] & { user_id: string; agent_id: string })
        | null;
      return row &&
        row.user_id === principal.userId &&
        row.status !== "invalid" &&
        memoryRevision(row) === source.revision &&
        (!owner.agentId || owner.agentId === row.agent_id)
        ? "available"
        : "revoked";
    }
    case "knowledge_document": {
      const row = db
        .query("SELECT content_version FROM knowledge_documents WHERE id=?")
        .get(source.id) as { content_version: number } | null;
      return principal.userId === DEFAULT_USER_ID &&
        row &&
        String(row.content_version) === source.revision
        ? "available"
        : "revoked";
    }
    case "knowledge_grant": {
      const identity: unknown = JSON.parse(source.id);
      if (
        !Array.isArray(identity) ||
        identity.length !== 2 ||
        !identity.every((part) => typeof part === "string")
      )
        return "revoked";
      if (owner.agentId && owner.agentId !== identity[1]) return "revoked";
      const grant = db
        .query("SELECT token FROM knowledge_grants WHERE document_id=? AND agent_id=?")
        .get(identity[0], identity[1]) as { token: string } | null;
      return principal.userId === DEFAULT_USER_ID && grant?.token === source.revision
        ? "available"
        : "revoked";
    }
    case "qq_observation": {
      const row = db
        .query(`SELECT e.agent_id,t.body,t.expires_at FROM qq_events e
        LEFT JOIN qq_observation_text t ON t.event_key=e.event_key WHERE e.event_key=?`)
        .get(source.id) as {
        agent_id: string;
        body: string | null;
        expires_at: string | null;
      } | null;
      if (
        !row ||
        principal.userId !== DEFAULT_USER_ID ||
        (owner.agentId && row.agent_id !== owner.agentId)
      )
        return "revoked";
      return !row.expires_at || Date.parse(row.expires_at) <= Date.parse(now)
        ? "expired"
        : row.body !== null &&
            createHash("sha256").update(row.body).digest("hex") === source.revision
          ? "available"
          : "revoked";
    }
    case "qq_media_note": {
      const row = db
        .query(`SELECT n.note,n.note_model,n.attempts,n.event_key,n.expires_at,
        e.agent_id,e.account_id,e.conversation_kind,e.peer_id FROM qq_media_notes n
        JOIN qq_events e ON e.event_key=n.event_key WHERE n.id=?`)
        .get(source.id) as {
        note: string | null;
        note_model: string | null;
        attempts: number;
        event_key: string;
        expires_at: string;
        agent_id: string;
        account_id: string;
        conversation_kind: string;
        peer_id: string;
      } | null;
      if (!row || row.note === null || row.note_model === null) return "revoked";
      if (principal.userId !== DEFAULT_USER_ID || owner.agentId !== row.agent_id) return "revoked";
      if (Date.parse(row.expires_at) <= Date.parse(now)) return "expired";
      const binding =
        owner.kind === "conversation"
          ? db
              .query(`SELECT b.id FROM conversations c JOIN qq_bindings b ON b.id=c.source_id
          WHERE c.id=? AND c.channel='onebot11' AND c.closed_at IS NULL AND c.agent_id=?
          AND b.agent_id=? AND b.account_id=? AND b.conversation_kind=? AND b.peer_id=?`)
              .get(
                owner.id,
                row.agent_id,
                row.agent_id,
                row.account_id,
                row.conversation_kind,
                row.peer_id,
              )
          : owner.kind === "qq_binding"
            ? db
                .query(
                  `SELECT id FROM qq_bindings WHERE id=? AND agent_id=? AND account_id=? AND conversation_kind=? AND peer_id=?`,
                )
                .get(owner.id, row.agent_id, row.account_id, row.conversation_kind, row.peer_id)
            : null;
      const revision = createHash("sha256")
        .update(JSON.stringify([row.note, row.note_model, row.attempts, row.event_key]))
        .digest("hex");
      return binding && revision === source.revision ? "available" : "revoked";
    }
    case "qq_media": {
      const row = db
        .query(`SELECT n.expires_at,n.attempts,e.agent_id FROM qq_media_notes n
        JOIN qq_events e ON e.event_key=n.event_key WHERE n.id=?`)
        .get(source.id) as {
        expires_at: string;
        agent_id: string;
        attempts: number;
      } | null;
      if (!row) return "expired";
      if (principal.userId !== DEFAULT_USER_ID || (owner.agentId && owner.agentId !== row.agent_id))
        return "revoked";
      return Date.parse(row.expires_at) <= Date.parse(now)
        ? "expired"
        : String(row.attempts) === source.revision
          ? "available"
          : "revoked";
    }
    case "qq_media_asset": {
      // Raw asset refs have no production minter: image reads mint scoped
      // `qq_media_source` refs instead (id = the exact media row). The old case
      // was a wide grant — any live link revived a ref with no owner/scope
      // check — so it stays closed; a same-sha asset never re-authorizes.
      return "revoked";
    }
    case "qq_speech": {
      const row = db
        .query(`SELECT s.agent_id,t.body,t.expires_at FROM qq_speech_log s
        LEFT JOIN qq_speech_text t ON t.speech_id=s.id WHERE s.id=?`)
        .get(source.id) as {
        agent_id: string;
        body: string | null;
        expires_at: string | null;
      } | null;
      if (
        !row ||
        principal.userId !== DEFAULT_USER_ID ||
        (owner.agentId && owner.agentId !== row.agent_id)
      )
        return "revoked";
      return !row.expires_at || Date.parse(row.expires_at) <= Date.parse(now)
        ? "expired"
        : row.body !== null &&
            createHash("sha256").update(row.body).digest("hex") === source.revision
          ? "available"
          : "revoked";
    }
    case "outbound_intent": {
      const row = db
        .query(`SELECT i.target,i.expires_at,i.conversation_id,c.user_id,c.closed_at
        FROM outbound_intents i JOIN conversations c ON c.id=i.conversation_id WHERE i.id=?`)
        .get(source.id) as {
        target: string;
        expires_at: string;
        conversation_id: string;
        user_id: string;
        closed_at: string | null;
      } | null;
      if (!row || row.user_id !== principal.userId) return "revoked";
      if (row.closed_at && (purpose !== "inspection" || !canReadRun(db, owner, principal)))
        return "revoked";
      if (Date.parse(row.expires_at) <= Date.parse(now)) return "expired";
      const target = JSON.parse(row.target) as { agentId: string; bindingId: string };
      if (
        (owner.agentId && owner.agentId !== target.agentId) ||
        (owner.kind === "conversation" && owner.id !== row.conversation_id) ||
        (owner.kind === "qq_binding" && owner.id !== target.bindingId) ||
        !db
          .query("SELECT 1 FROM qq_bindings WHERE id=? AND agent_id=?")
          .get(target.bindingId, target.agentId)
      )
        return "revoked";
      const parts = db
        .query(
          "SELECT payload FROM outbound_parts WHERE intent_id=? AND kind='text' AND status='confirmed' ORDER BY ordinal",
        )
        .all(source.id) as { payload: string | null }[];
      if (!parts.length || parts.some((part) => part.payload === null)) return "expired";
      const body = parts
        .map((part) => (JSON.parse(part.payload as string) as { text: string }).text)
        .join("\n");
      return createHash("sha256").update(body).digest("hex") === source.revision
        ? "available"
        : "revoked";
    }
    case "qq_sticker": {
      const asset = db
        .query("SELECT enabled,updated_at FROM qq_sticker_assets WHERE id=?")
        .get(source.id) as { enabled: number; updated_at: string } | null;
      return principal.userId === DEFAULT_USER_ID &&
        asset !== null &&
        asset.enabled === 1 &&
        asset.updated_at === source.revision
        ? "available"
        : "revoked";
    }
    default:
      return "revoked";
  }
}

/**
 * Re-validate every retained source against its own store: a resolver may claim it, memory
 * revisions come from the caller's own scope, and everything else falls back to `sourceAccess`.
 * `memoryRevisions` only runs for memory refs the resolver did not claim, and `skip` lets a
 * channel leave its own in-flight source alone — both match the channels' established order.
 */
export function assertContextSources(options: {
  db: Database;
  sources: readonly SourceRef[];
  owner: RunOwner;
  now: string;
  resolveSource?: ModuleSourceResolver;
  memoryRevisions(ids: string[]): ReadonlyMap<string, string>;
  skip?(source: SourceRef): boolean;
  messages: { memory: string; other: string };
}): void {
  const { db, sources, owner, now } = options;
  const resolved = new Map(
    sources.map((source) => [
      source,
      isDirectSourceKind(source.kind)
        ? sourceAccess(db, source, owner, { userId: DEFAULT_USER_ID }, now)
        : options.resolveSource?.(source, owner, now),
    ]),
  );
  const refs = sources.filter(
    (source) => source.kind === "memory" && resolved.get(source) === undefined,
  );
  const memory = options.memoryRevisions(refs.map((ref) => ref.id));
  for (const source of sources) {
    if (source.expiresAt !== undefined && Date.parse(source.expiresAt) <= Date.parse(now))
      fail("CONTEXT_SOURCE_INVALID", options.messages.other);
    if (options.skip?.(source)) continue;
    if (
      source.kind === "memory" &&
      resolved.get(source) === undefined &&
      memory.get(source.id) !== source.revision
    )
      fail("CONTEXT_SOURCE_INVALID", options.messages.memory);
    if (
      (resolved.get(source) ??
        sourceAccess(db, source, owner, { userId: DEFAULT_USER_ID }, now)) !== "available"
    )
      fail("CONTEXT_SOURCE_INVALID", options.messages.other);
  }
}

/** ContextHandle is an address. The caller must still own its run and every retained source. */
export function inspectContext(
  db: Database,
  repository: AgentRunRepository,
  handle: ContextHandle,
  principal: ContextPrincipal,
  now = new Date().toISOString(),
  resolveSource?: ModuleSourceResolver,
): InspectedContext | null {
  const run = repository.getRun(handle.runId);
  if (!run || !canReadRun(db, run.owner, principal)) return null;
  const stored = repository.getContext(handle);
  if (!stored) return null;
  let status = stored.status;
  let trimmedMessages: ModelMessage[] | null = null;
  if (status === "exact") {
    const states = stored.sources.map((source) =>
      isDirectSourceKind(source.kind)
        ? sourceAccess(db, source, run.owner, principal, now, "inspection")
        : (resolveSource?.(source, run.owner, now) ??
          sourceAccess(db, source, run.owner, principal, now, "inspection")),
    );
    // T06 memory_job：失效的 qq_member_name 只把 currentName 剪空（可选资料），事实快照/
    // 正文/关系照旧出示——name refs 不参与整体失效聚合，也不取消仍合法的 fact/body。其余
    // ref 仍按原样 revoked/expired。ref id 畸形或裁剪不能真实发生（固定前缀消息缺失/结构
    // 不可解析）都 fail closed 整体 revoked。
    const memoryJob = run.owner.kind === "memory_job";
    const deadNames = new Set<string>();
    let malformedNameRef = false;
    if (memoryJob) {
      stored.sources.forEach((source, index) => {
        if (source.kind !== "qq_member_name" || states[index] === "available") return;
        const qq = memberNameRefQq(source.id);
        if (qq === null) malformedNameRef = true;
        else deadNames.add(qq);
      });
    }
    const governing = states.filter(
      (_, index) => !(memoryJob && stored.sources[index].kind === "qq_member_name"),
    );
    if (malformedNameRef) status = "revoked";
    else if (governing.includes("revoked")) status = "revoked";
    else if (
      governing.includes("expired") ||
      (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.parse(now))
    )
      status = "expired";
    if (status !== "exact") repository.redactContext(handle, status);
    else if (deadNames.size > 0) {
      const trimmed = trimMemoryJobCurrentNames(stored.messages ?? [], deadNames);
      if (trimmed === null) {
        status = "revoked";
        repository.redactContext(handle, status);
      } else {
        trimmedMessages = trimmed;
      }
    }
  }
  const metadata = {
    layout: stored.layout,
    sourceVersions: stored.sources.map(({ id, revision }) => ({ id, revision })),
  };
  const result: InspectedModelResult =
    status !== "exact"
      ? { status }
      : stored.output
        ? {
            status: stored.output.complete ? "exact" : "partial",
            text: stored.output.text,
            format: stored.output.format,
          }
        : {
            status: "unavailable",
            reason:
              run.steps.find((step) => step.stepId === handle.stepId)?.status === "running"
                ? "pending"
                : stored.outputRecorded
                  ? "no_response"
                  : "not_recorded",
          };
  if (status !== "exact" || !stored.messages) return { ...metadata, status, result };
  const unavailableMedia = stored.messages.flatMap((message) =>
    message.content.flatMap((part) =>
      part.kind === "image"
        ? [
            {
              sourceId: part.sourceId,
              sha256: part.sha256,
              reason: "media_unavailable" as const,
            },
          ]
        : [],
    ),
  );
  return {
    ...metadata,
    status: unavailableMedia.length ? "partial" : "exact",
    exactMessages: trimmedMessages ?? stored.messages,
    result,
    ...(unavailableMedia.length ? { unavailableMedia } : {}),
  };
}

export function visibleRun(
  db: Database,
  repository: AgentRunRepository,
  id: string,
  principal: ContextPrincipal,
): RunSnapshot | null {
  const run = repository.getRun(id);
  return run && canReadRun(db, run.owner, principal) ? run : null;
}
