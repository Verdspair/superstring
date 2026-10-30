import type { SettingsRoute } from "../workspace/settings-routes";

export type AllocationPurpose = "assistant" | "qq" | "reading" | "aux";
export interface ContextAllocationTarget {
  purpose: AllocationPurpose;
  agentId?: string | null;
  schemeId?: string | null;
  bindingId?: string | null;
  capacityModel?: string | null;
  returnRoute?: SettingsRoute | null;
  returnLabel?: string | null;
}
export const emptyContextAllocationTarget: ContextAllocationTarget = {
  purpose: "assistant",
  agentId: null,
  schemeId: null,
  bindingId: null,
  returnRoute: null,
  returnLabel: null,
};
export function mergeContextAllocationTarget(
  current: ContextAllocationTarget,
  target: Partial<ContextAllocationTarget>,
): ContextAllocationTarget {
  const purpose = target.purpose ?? current.purpose;
  const preserveAgent =
    target.agentId !== undefined
      ? target.agentId !== null
      : target.purpose
        ? target.purpose === current.purpose || target.purpose === "assistant"
        : true;
  return {
    ...current,
    ...target,
    purpose,
    agentId: preserveAgent ? (target.agentId ?? current.agentId) : null,
    schemeId: purpose === "qq" ? (target.schemeId ?? current.schemeId) : null,
    bindingId: purpose === "qq" ? (target.bindingId ?? current.bindingId) : null,
  };
}
