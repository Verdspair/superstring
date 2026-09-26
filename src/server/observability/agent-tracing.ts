import type { RunOwner } from "../../shared/contracts/agent-run";
import type { RuntimeTelemetry, TraceMetadata, TraceScope } from "./runtime-telemetry";

/** Optional diagnostics must never change the result of the observed operation. */
export function startAgentTrace(
  telemetry: RuntimeTelemetry | undefined,
  name: string,
  metadata: (telemetry: RuntimeTelemetry) => TraceMetadata,
): TraceScope | undefined {
  if (!telemetry) return;
  try {
    const scope = telemetry.start(name, metadata(telemetry));
    return {
      traceId: scope.traceId,
      spanId: scope.spanId,
      within: (work) => scope.within(work),
      update(next) {
        try {
          scope.update(next);
        } catch {
          /* Diagnostics have no business authority. */
        }
      },
      end(status, code) {
        try {
          scope.end(status, code);
        } catch {
          /* Diagnostics have no business authority. */
        }
      },
    };
  } catch {
    return undefined;
  }
}

export function traceErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  // Arbitrary provider messages/URLs must not become a searchable diagnostic code.
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : "AGENT_FAILED";
}

export async function withinAgentTrace<T>(
  scope: TraceScope | undefined,
  work: (scope: TraceScope | undefined) => Promise<T>,
): Promise<T> {
  const execute = async () => {
    try {
      const result = await work(scope);
      scope?.end();
      return result;
    } catch (error) {
      scope?.end(
        error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed",
        traceErrorCode(error),
      );
      throw error;
    }
  };
  return scope ? scope.within(execute) : execute();
}

/** Channel lookup is diagnostic only; it never creates/reopens a Bot execution epoch. */
export function resolveAgentTraceScope(
  telemetry: RuntimeTelemetry,
  owner: RunOwner,
  conversationId?: string,
): TraceMetadata {
  const inherited = telemetry.activeMetadata();
  const metadata: TraceMetadata = {
    channel:
      inherited?.channel ??
      (owner.kind.startsWith("qq_")
        ? "onebot11"
        : owner.kind === "web_turn"
          ? "web"
          : owner.kind === "memory_job"
            ? "memory"
            : owner.kind === "knowledge_job"
              ? "knowledge"
              : "system"),
    stage: "run",
    ...(owner.userId ? { userId: owner.userId } : {}),
    ...(owner.agentId ? { agentId: owner.agentId } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
  if (inherited?.conversationId || conversationId) return metadata;
  try {
    if (owner.kind === "web_turn") {
      const conversation = telemetry.db
        .query(`SELECT c.id,c.agent_id FROM turns t
        JOIN sessions s ON s.id=t.session_id JOIN conversations c ON c.source_id=s.id
        AND c.channel='web' AND c.agent_id=s.agent_id AND c.user_id=s.user_id AND c.closed_at IS NULL
        WHERE t.id=? AND (? IS NULL OR s.user_id=?)`)
        .get(owner.id, owner.userId ?? null, owner.userId ?? null) as {
        id: string;
        agent_id: string;
      } | null;
      if (conversation && (!owner.agentId || conversation.agent_id === owner.agentId))
        Object.assign(metadata, {
          conversationId: conversation.id,
          agentId: conversation.agent_id,
        });
    } else if (owner.kind === "qq_binding" || owner.kind === "qq_media") {
      const row =
        owner.kind === "qq_binding"
          ? telemetry.db
              .query(`SELECT c.id,c.agent_id FROM conversations c JOIN qq_bindings b ON b.id=c.source_id AND b.agent_id=c.agent_id
          WHERE c.channel='onebot11' AND c.closed_at IS NULL AND b.id=?`)
              .get(owner.id)
          : telemetry.db
              .query(`SELECT c.id,c.agent_id FROM qq_media_notes m JOIN qq_events e ON e.event_key=m.event_key
          JOIN qq_bindings b ON b.account_id=e.account_id AND b.conversation_kind=e.conversation_kind AND b.peer_id=e.peer_id AND b.agent_id=e.agent_id
          JOIN conversations c ON c.source_id=b.id AND c.agent_id=e.agent_id AND c.channel='onebot11' AND c.closed_at IS NULL
          WHERE m.id=? AND EXISTS (SELECT 1 FROM conversation_events ce WHERE ce.conversation_id=c.id
          AND ce.source_kind='qq_observation' AND ce.source_id=e.event_key)`)
              .get(owner.id);
      const conversation = row as { id: string; agent_id: string } | null;
      if (conversation && (!owner.agentId || conversation.agent_id === owner.agentId))
        Object.assign(metadata, {
          conversationId: conversation.id,
          agentId: conversation.agent_id,
        });
    }
  } catch {
    /* Missing diagnostic linkage does not reject a valid inference. */
  }
  return metadata;
}
