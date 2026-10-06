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
}: {
  qqBindings: readonly QqBindingResponse[];
  qqSchemes: readonly QqSchemeResponse[];
  agents: readonly { id: string; name: string }[];
  summaryById: Readonly<Record<string, ConversationSummary>>;
}): QqGroupRow[] {
  const groupBindings = qqBindings.filter((binding) => binding.kind === "group");
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

/**
 * 按群显示名、群号、账号、方案名或 Agent 名过滤。
 */
export function filterQqGroupRows(
  rows: readonly QqGroupRow[],
  query: string,
  language?: string,
): QqGroupRow[] {
  const needle = query.trim().toLocaleLowerCase(language);
  if (!needle) return [...rows];
  return rows.filter((row) => {
    const text =
      `${row.title ?? ""} ${row.peerId} ${row.accountId} ${row.schemeName} ${row.agentName}`.toLocaleLowerCase(
        language,
      );
    return text.includes(needle);
  });
}
