import { useRef, useState } from "react";
import type { ConversationSummary } from "../../../shared/contracts/conversation";
import { msg } from "../../i18n";
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
  const isQq = deleting?.channel === "onebot11";
  return {
    isQq,
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
    confirmDelete: () => {
      if (!deleting) return;
      if (!isQq)
        return operate(
          () => useSuperstringStore.getState().deleteSessionById(deleting.sourceId),
          () => setDeleting(null),
        );
      // QQ 删除按「会话摘要 → 当前绑定」逐项核对：同一绑定 id、同一 Agent，且用绑定当前
      // revision 走 CAS；目录行过期（已解绑或改绑）时只报错，不推测目标。
      const state = useSuperstringStore.getState();
      const binding = state.qqBindings.find((row) => row.id === deleting.sourceId);
      if (!binding || binding.agent_id !== deleting.agentId) {
        setNotice(msg("操作失败，请重试。"));
        return;
      }
      return operate(
        () => state.removeQqConversation(binding.id, binding.revision),
        () => setDeleting(null),
      );
    },
    refresh: (item: ConversationSummary) =>
      operate(
        () => useSuperstringStore.getState().refreshSessionById(item.sourceId),
        () => setNotice(useSuperstringStore.getState().feedback),
      ),
  };
}
