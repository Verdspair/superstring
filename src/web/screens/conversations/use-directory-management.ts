import { useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "../../../shared/contracts/conversation";
import { msg } from "../../i18n";
import { useSuperstringStore } from "../../store";

export function useDirectoryManagement(active = true) {
  const api = useSuperstringStore((state) => state.apiClient);
  const summaries = useSuperstringStore((state) => state.summaryById);
  const [target, setTarget] = useState<{
    api: typeof api;
    item: ConversationSummary;
    kind: "rename" | "delete";
  } | null>(null);
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ target?: NonNullable<typeof target> } | null>(null);
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const currentActive = useRef(active);
  currentActive.current = active;
  const present = (item: ConversationSummary) => {
    const row = useSuperstringStore.getState().summaryById[item.id];
    return (
      !!row &&
      row.sourceId === item.sourceId &&
      row.agentId === item.agentId &&
      row.channel === item.channel &&
      row.bindingEpoch === item.bindingEpoch
    );
  };
  const visible =
    active && target?.api === api && target && summaries[target.item.id] && present(target.item)
      ? target
      : null;
  useEffect(() => {
    if (target && !visible && currentTarget.current === target) {
      const state = useSuperstringStore.getState();
      const removedSource =
        target.item.channel === "onebot11"
          ? !state.qqBindings.some((binding) => binding.id === target.item.sourceId)
          : !state.sessionConversationIds[target.item.sourceId];
      // The action publishes deletion before its Promise settles. Its own result still decides success.
      if (
        active &&
        target.api === api &&
        target.kind === "delete" &&
        pending.current?.target === target &&
        removedSource
      )
        return;
      pending.current = null;
      setBusy(false);
      setNotice("");
      setTarget((value) => (value === target ? null : value));
    }
  }, [target, visible, active, api]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Pending directory actions belong to the API and active view that started them.
  useEffect(() => {
    pending.current = null;
    setBusy(false);
    setNotice("");
  }, [api, active]);
  useEffect(
    () => () => {
      pending.current = null;
      currentActive.current = false;
    },
    [],
  );
  const matches = (captured: NonNullable<typeof target>) =>
    currentActive.current &&
    currentTarget.current === captured &&
    useSuperstringStore.getState().apiClient === captured.api &&
    present(captured.item);
  const operate = async (captured: NonNullable<typeof target>, work: () => Promise<boolean>) => {
    if (pending.current || !matches(captured)) return false;
    const operation = { target: captured };
    pending.current = operation;
    setBusy(true);
    setNotice("");
    try {
      const saved = await work();
      if (
        pending.current !== operation ||
        currentTarget.current !== captured ||
        !currentActive.current ||
        useSuperstringStore.getState().apiClient !== captured.api
      )
        return false;
      if (saved || !present(captured.item))
        setTarget((value) => (value === captured ? null : value));
      if (!saved && present(captured.item)) {
        const state = useSuperstringStore.getState();
        setNotice(state.error || state.feedback);
      }
      return saved;
    } catch (error) {
      if (pending.current === operation && !present(captured.item))
        setTarget((value) => (value === captured ? null : value));
      if (pending.current === operation && matches(captured))
        setNotice(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  const open = (item: ConversationSummary, kind: "rename" | "delete") => {
    if (!active || pending.current || !present(item)) return;
    setNotice("");
    if (kind === "rename") setName(item.title);
    setTarget({ api, item, kind });
  };
  const editing = visible?.kind === "rename" ? visible.item : null;
  const deleting = visible?.kind === "delete" ? visible.item : null;
  return {
    editing,
    deleting,
    name,
    setName,
    notice,
    busy,
    isQq: deleting?.channel === "onebot11",
    rename: (item: ConversationSummary) => open(item, "rename"),
    remove: (item: ConversationSummary) => open(item, "delete"),
    cancel: () => {
      if (!pending.current) {
        setTarget(null);
        setNotice("");
      }
    },
    save: () => {
      const captured = visible;
      if (!captured || captured.kind !== "rename") return;
      const item = captured.item;
      return operate(captured, async () => {
        if (item.channel === "onebot11" && item.topology === "shared" && item.qqGroup) {
          try {
            const summary = await captured.api.renameConversationGroup(
              item.id,
              name.trim() || null,
            );
            if (!matches(captured)) return false;
            useSuperstringStore.getState().rememberConversation(summary);
            return true;
          } catch (error) {
            if (matches(captured)) throw error;
            return false;
          }
        }
        return useSuperstringStore.getState().renameSession(item.sourceId, name);
      });
    },
    confirmDelete: () => {
      const captured = visible;
      if (!captured || captured.kind !== "delete" || !matches(captured)) return;
      const item = captured.item;
      if (item.channel !== "onebot11")
        return operate(captured, () =>
          useSuperstringStore.getState().deleteSessionById(item.sourceId),
        );
      const state = useSuperstringStore.getState();
      const binding = state.qqBindings.find((row) => row.id === item.sourceId);
      if (!binding || binding.agent_id !== item.agentId) {
        setNotice(msg("操作失败，请重试。"));
        return;
      }
      return operate(captured, () => state.removeQqConversation(binding.id, binding.revision));
    },
    refresh: async (item: ConversationSummary) => {
      if (pending.current || !active || !present(item)) return;
      const operation = {};
      const owner = api;
      pending.current = operation;
      setBusy(true);
      setNotice("");
      try {
        await useSuperstringStore.getState().refreshSessionById(item.sourceId);
        if (
          pending.current === operation &&
          currentActive.current &&
          useSuperstringStore.getState().apiClient === owner
        )
          setNotice(useSuperstringStore.getState().feedback);
      } finally {
        if (pending.current === operation) {
          pending.current = null;
          setBusy(false);
        }
      }
    },
  };
}
