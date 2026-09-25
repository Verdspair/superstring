import type { Database } from "bun:sqlite";
import type {
  ContextHandle,
  InspectedContext,
  RunOwner,
  RunSnapshot,
} from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { AgentRunRepository } from "../db/agent-run-repository";
import { DEFAULT_USER_ID } from "../db/repositories";

export interface ContextPrincipal {
  userId: string;
}

type SourceAccess = "available" | "expired" | "revoked";

/** Resolve the application's existing ownership, not a principal supplied in a URL. */
export function canReadRun(db: Database, owner: RunOwner, principal: ContextPrincipal): boolean {
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
    case "qq_binding":
      return db.query("SELECT 1 FROM qq_bindings WHERE id=?").get(owner.id) !== null;
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
        .query("SELECT user_id,agent_id,status FROM memory_entries WHERE id=?")
        .get(source.id) as { user_id: string; agent_id: string; status: string } | null;
      return row &&
        row.user_id === principal.userId &&
        row.status !== "invalid" &&
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
        .query(`SELECT e.agent_id,t.expires_at FROM qq_events e
        LEFT JOIN qq_observation_text t ON t.event_key=e.event_key WHERE e.event_key=?`)
        .get(source.id) as { agent_id: string; expires_at: string | null } | null;
      if (
        !row ||
        principal.userId !== DEFAULT_USER_ID ||
        (owner.agentId && row.agent_id !== owner.agentId)
      )
        return "revoked";
      return !row.expires_at || Date.parse(row.expires_at) <= Date.parse(now)
        ? "expired"
        : "available";
    }
    case "qq_media": {
      const row = db
        .query(`SELECT n.expires_at,e.agent_id FROM qq_media_notes n
        JOIN qq_events e ON e.event_key=n.event_key WHERE n.id=?`)
        .get(source.id) as {
        expires_at: string;
        agent_id: string;
      } | null;
      if (!row) return "expired";
      if (principal.userId !== DEFAULT_USER_ID || (owner.agentId && owner.agentId !== row.agent_id))
        return "revoked";
      return Date.parse(row.expires_at) <= Date.parse(now) ? "expired" : "available";
    }
    case "qq_speech": {
      const row = db
        .query(`SELECT s.agent_id,t.expires_at FROM qq_speech_log s
        LEFT JOIN qq_speech_text t ON t.speech_id=s.id WHERE s.id=?`)
        .get(source.id) as {
        agent_id: string;
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
        : "available";
    }
    case "qq_sticker":
      return principal.userId === DEFAULT_USER_ID &&
        db.query("SELECT 1 FROM qq_sticker_assets WHERE id=?").get(source.id) !== null
        ? "available"
        : "revoked";
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
): InspectedContext | null {
  const run = repository.getRun(handle.runId);
  if (!run || !canReadRun(db, run.owner, principal)) return null;
  const stored = repository.getContext(handle);
  if (!stored) return null;
  let status = stored.status;
  if (status === "exact") {
    const states = stored.sources.map((source) =>
      sourceAccess(db, source, run.owner, principal, now),
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
  if (status !== "exact" || !stored.messages) return { ...metadata, status };
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
