import type { Database } from "bun:sqlite";
import type { ConversationSummary } from "../../shared/contracts/conversation";
import type { ConversationEventRepository } from "../db/conversation-event-repository";
import type { ContextPrincipal } from "./context-access";

/**
 * A history ID follows its assistant scope, not execution authority. It becomes
 * readable again only when that same assistant has a live activation and binding.
 * Never use this read guard to authorize a wake, source observation or send.
 */
export function visibleConversation(
  db: Database,
  repository: ConversationEventRepository,
  id: string,
  principal: ContextPrincipal,
  includeShared = false,
): ConversationSummary | null {
  const row = repository.row(id);
  if (!row || row.user_id !== principal.userId || (!includeShared && row.topology === "shared"))
    return null;
  const source =
    row.channel === "web"
      ? db
          .query("SELECT 1 FROM sessions WHERE id=? AND user_id=? AND agent_id=?")
          .get(row.source_id, principal.userId, row.agent_id)
      : db
          .query(`SELECT 1 FROM qq_bindings b JOIN agents a ON a.id=b.agent_id
        WHERE b.id=? AND b.agent_id=?`)
          .get(row.source_id, row.agent_id);
  return source ? repository.historySummary(id) : null;
}
