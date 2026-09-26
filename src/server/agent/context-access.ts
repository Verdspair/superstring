import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  ContextHandle,
  InspectedContext,
  InspectedModelResult,
  RunOwner,
  RunSnapshot,
} from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { AgentRunRepository } from "../db/agent-run-repository";
import { ConversationEventRepository } from "../db/conversation-event-repository";
import { memoryRevision } from "../db/memory-content-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import type { ModuleSourceResolver } from "../modules/composition";
import { visibleConversation } from "./conversation-access";

export interface ContextPrincipal {
  userId: string;
}

type SourceAccess = "available" | "expired" | "revoked";

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
  if (status === "exact") {
    const states = stored.sources.map(
      (source) =>
        resolveSource?.(source, run.owner, now) ??
        sourceAccess(db, source, run.owner, principal, now, "inspection"),
    );
    if (states.includes("revoked")) status = "revoked";
    else if (
      states.includes("expired") ||
      (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.parse(now))
    )
      status = "expired";
    if (status !== "exact") repository.redactContext(handle, status);
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
    exactMessages: stored.messages,
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
