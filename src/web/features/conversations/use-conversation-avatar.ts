import { useCallback } from "react";
import type { ConversationSummary } from "../../../shared/contracts/conversation";
import type { GeneratedAvatar } from "../../../shared/contracts/conversation-avatar";
import { useSuperstringStore } from "../../store";

/** Avatar writes change presentation only; the directory remains the single metadata cache. */
export function useConversationAvatar(conversation: ConversationSummary | null) {
  const id = conversation?.id;
  const cached = useSuperstringStore((state) => (id ? state.summaryById[id] : undefined));
  const save = useCallback(
    async (selection: GeneratedAvatar | File | null) => {
      if (!id) return;
      const { apiClient } = useSuperstringStore.getState();
      // A directory request issued before the write must not restore the old avatar.
      useSuperstringStore.setState((state) => ({ directoryRevision: state.directoryRevision + 1 }));
      const avatar = await apiClient.saveConversationAvatar(id, selection);
      useSuperstringStore.setState((state) => {
        const current = state.summaryById[id];
        if (!current || state.apiClient !== apiClient) return state;
        return {
          directoryRevision: state.directoryRevision + 1,
          summaryById: { ...state.summaryById, [id]: { ...current, avatar } },
        };
      });
    },
    [id],
  );
  return { value: (cached ?? conversation)?.avatar ?? null, save };
}
