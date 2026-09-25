import type { RunEvent, RunSnapshot } from "../../../shared/contracts/agent-run";
import type { StoreGet, StoreSet } from "../../state/types";
import { mergeRunSnapshot, type RunById, reduceRunEvent, runOwnerKey } from "./run-state";

export interface RunState {
  runById: RunById;
  runIdsByOwner: Record<string, string[]>;
  receiveRunEvent: (event: RunEvent) => void;
  receiveRunSnapshot: (snapshot: RunSnapshot) => void;
  loadOwnerRuns: (kind: string, id: string, signal?: AbortSignal) => Promise<RunSnapshot[]>;
}
export const initialRunState = {
  runById: {} as RunById,
  runIdsByOwner: {} as Record<string, string[]>,
};

export function createRunActions(
  set: StoreSet,
  get: StoreGet,
): Omit<RunState, keyof typeof initialRunState> {
  return {
    receiveRunEvent: (event) => set((state) => ({ runById: reduceRunEvent(state.runById, event) })),
    receiveRunSnapshot: (snapshot) =>
      set((state) => ({ runById: mergeRunSnapshot(state.runById, snapshot) })),
    async loadOwnerRuns(kind, id, signal) {
      const { runs } = await get().apiClient.listRuns(kind, id, signal);
      if (signal?.aborted) return [];
      const ordered = [...runs].sort(
        (a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId),
      );
      set((state) => ({
        runById: ordered.reduce(mergeRunSnapshot, state.runById),
        runIdsByOwner: {
          ...state.runIdsByOwner,
          [runOwnerKey(kind, id)]: ordered.map((run) => run.runId),
        },
      }));
      return ordered;
    },
  };
}
