import { useSuperstringStore } from "../store";
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

export function getContextAllocationTarget(): ContextAllocationTarget {
  return useSuperstringStore.getState().contextAllocationTarget;
}

export function setContextAllocationTarget(target: Partial<ContextAllocationTarget>): void {
  useSuperstringStore.setState((state) => ({
    contextAllocationTarget: { ...state.contextAllocationTarget, ...target },
  }));
}

export function resetContextAllocationTarget(): void {
  useSuperstringStore.setState({
    contextAllocationTarget: {
      purpose: "assistant",
      agentId: null,
      schemeId: null,
      bindingId: null,
      returnRoute: null,
      returnLabel: null,
    },
  });
}

export function openContextAllocation(target: Partial<ContextAllocationTarget> = {}): void {
  const current = getContextAllocationTarget();
  // 仅在目标仍为 QQ purpose 时保留 QQ 专属实体身份；切换至非 QQ purpose 时清理无关的 bindingId 与 schemeId，
  // 避免在 performNavigation 中被 binding?.agent_id 误改写目标助手身份；但合法来源 returnRoute 与 returnLabel 照常保留
  const isQqPurpose = (target.purpose ?? current.purpose) === "qq";
  const shouldPreserveAgent =
    target.agentId !== undefined
      ? target.agentId !== null
      : target.purpose
        ? target.purpose === current.purpose || target.purpose === "assistant"
        : true;
  const merged: ContextAllocationTarget = {
    returnRoute: current.returnRoute,
    returnLabel: current.returnLabel,
    ...current,
    ...target,
    schemeId: isQqPurpose
      ? target.schemeId !== undefined
        ? target.schemeId
        : current.schemeId
      : null,
    bindingId: isQqPurpose
      ? target.bindingId !== undefined
        ? target.bindingId
        : current.bindingId
      : null,
    agentId: shouldPreserveAgent ? (target.agentId ?? current.agentId) : null,
  };
  useSuperstringStore.getState().requestContextAllocation(merged);
}

export function returnFromContextAllocation(): void {
  const currentTarget = getContextAllocationTarget();
  const route = currentTarget.returnRoute;
  useSuperstringStore
    .getState()
    .requestContextAllocation(currentTarget, route ?? "scheme-library", true);
}
