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
  useSuperstringStore
    .getState()
    .requestContextAllocation({ ...getContextAllocationTarget(), ...target });
}

export function returnFromContextAllocation(): void {
  const currentTarget = getContextAllocationTarget();
  const route = currentTarget.returnRoute;
  useSuperstringStore
    .getState()
    .requestContextAllocation(currentTarget, route ?? "scheme-library", true);
}
