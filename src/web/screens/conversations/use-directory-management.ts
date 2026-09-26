import { useRef, useState } from "react";
import type { ConversationSummary } from "../../../shared/contracts/conversation";
import { useSuperstringStore } from "../../store";

export function useDirectoryManagement() {
  const [editing, setEditing] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const operate = async (work: () => Promise<boolean>, success: () => void) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      if (await work()) success();
      else {
        const state = useSuperstringStore.getState();
        setNotice(state.error || state.feedback);
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return {
    editing,
    deleting,
    name,
    setName,
    notice,
    busy,
    rename: (item: ConversationSummary) => {
      setName(item.title);
      setNotice("");
      setEditing(item);
    },
    remove: (item: ConversationSummary) => {
      setNotice("");
      setDeleting(item);
    },
    cancel: () => {
      if (!pending.current) {
        setEditing(null);
        setDeleting(null);
        setNotice("");
      }
    },
    save: () =>
      editing &&
      operate(
        () => useSuperstringStore.getState().renameSession(editing.sourceId, name),
        () => setEditing(null),
      ),
    confirmDelete: () =>
      deleting &&
      operate(
        () => useSuperstringStore.getState().deleteSessionById(deleting.sourceId),
        () => setDeleting(null),
      ),
    refresh: (item: ConversationSummary) =>
      operate(
        () => useSuperstringStore.getState().refreshSessionById(item.sourceId),
        () => setNotice(useSuperstringStore.getState().feedback),
      ),
  };
}
