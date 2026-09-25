import type { Dispatch, SetStateAction } from "react";
import { useSuperstringStore } from "../../store";
import type { QqInputs } from "./draft-state";

/** Concrete page inputs live beside their resource drafts; no callbacks are registered in state. */
export function useQqInput<K extends keyof QqInputs>(
  key: K,
): [QqInputs[K], Dispatch<SetStateAction<QqInputs[K]>>] {
  const value = useSuperstringStore((state) => state.qqInputs[key]);
  return [
    value,
    (update) =>
      useSuperstringStore.setState((state) => ({
        qqInputs: {
          ...state.qqInputs,
          [key]:
            typeof update === "function"
              ? (update as (previous: QqInputs[K]) => QqInputs[K])(state.qqInputs[key])
              : update,
        },
      })),
  ];
}
