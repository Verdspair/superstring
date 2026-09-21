import type { AgentKnowledgeReadConfig } from "./contracts/knowledge";

/** Resolve validated settings only; available context remains a runtime constraint. */
export function resolveKnowledgeReadBudget(
  config: AgentKnowledgeReadConfig,
  globalBudget: number,
): { enabled: boolean; budget: number; source: "global" | "assistant" } {
  return {
    enabled: config.enabled,
    budget: config.context_budget ?? globalBudget,
    source: config.context_budget === null ? "global" : "assistant",
  };
}

/** Input must already be authorized. Selection can only remove rows, never add grants. */
export function filterKnowledgeReadScope<T extends { id: string }>(
  authorized: readonly T[],
  config: AgentKnowledgeReadConfig,
): T[] {
  if (!config.enabled) return [];
  const selected = new Set(config.document_ids);
  return authorized.filter((item) => config.scope === "all" || selected.has(item.id));
}
