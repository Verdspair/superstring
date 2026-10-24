import type { ConversationSummary } from "../../../shared/contracts/conversation";
import type { QqBindingResponse, QqSchemeResponse } from "../../../shared/contracts/qq";

export interface QqGroupRow {
  bindingId: string;
  accountId: string;
  peerId: string;
  agentId: string;
  agentName: string;
  schemeId: string;
  schemeName: string;
  paused: boolean;
  title: string | null;
  conversationId: string | null;
}

/**
 * 将已载入绑定中的 QQ 群映射为展示行，组合同 binding 与同 Agent 摘要。
 */
export function projectQqGroupRows({
  qqBindings,
  qqSchemes,
  agents,
  summaryById,
  kind = "group",
}: {
  qqBindings: readonly QqBindingResponse[];
  qqSchemes: readonly QqSchemeResponse[];
  agents: readonly { id: string; name: string }[];
  summaryById: Readonly<Record<string, ConversationSummary>>;
  kind?: "group" | "private" | "all";
}): QqGroupRow[] {
  const groupBindings = qqBindings.filter((binding) => kind === "all" || binding.kind === kind);
  const summaries = Object.values(summaryById);

  return groupBindings.map((binding) => {
    const summary = summaries.find(
      (row) => row.sourceId === binding.id && row.agentId === binding.agent_id,
    );
    const agent = agents.find((row) => row.id === binding.agent_id);
    const scheme = qqSchemes.find((row) => row.id === binding.scheme_id);

    return {
      bindingId: binding.id,
      accountId: binding.account_id,
      peerId: binding.peer_id,
      agentId: binding.agent_id,
      agentName: agent?.name ?? binding.agent_id,
      schemeId: binding.scheme_id,
      schemeName: scheme?.name ?? binding.scheme_id,
      paused: binding.paused,
      title: summary?.title ?? null,
      conversationId: summary?.id ?? null,
    };
  });
}
