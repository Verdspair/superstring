import { useLayoutEffect, useRef, useState } from "react";
import type { ConversationSummary } from "../../../shared/contracts/conversation";
import { ActionMenu } from "../../app/ActionMenu";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { AlertDialog } from "../../ui/AlertDialog";
import { sessionBusy } from "../chat/conversation-state";

type Target = { id: string; title: string };

export function ConversationList() {
  const t = useI18n();
  const ids = useSuperstringStore((state) => state.directoryIds);
  const summaries = useSuperstringStore((state) => state.summaryById);
  const currentId = useSuperstringStore((state) => state.currentConversationId);
  const load = useSuperstringStore((state) => state.loadConversations);
  const loading = useSuperstringStore((state) => state.directoryLoading);
  const error = useSuperstringStore((state) => state.directoryError);
  const cursor = useSuperstringStore((state) => state.directoryCursor);
  const rename = useSuperstringStore((state) => state.renameSession);
  const remove = useSuperstringStore((state) => state.deleteSessionById);
  const refresh = useSuperstringStore((state) => state.refreshSessionById);
  const [editing, setEditing] = useState<Target | null>(null);
  const [deleting, setDeleting] = useState<Target | null>(null);
  const sending = useSuperstringStore((state) => sessionBusy(state, deleting?.id ?? ""));
  const [title, setTitle] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const focusId = useRef<string | null>(null);
  const sessions = ids.map((id) => summaries[id]).filter(Boolean);
  const restoreFocus = () => {
    const buttons = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-source-id]") ?? []),
    ];
    (buttons.find((button) => button.dataset.sourceId === focusId.current) ?? buttons[0])?.focus({
      preventScroll: true,
    });
  };
  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  const finishEdit = () => {
    if (busyRef.current) return;
    setEditing(null);
    setNotice("");
    requestAnimationFrame(restoreFocus);
  };
  const run = async (action: () => Promise<boolean>, success: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice("");
    try {
      if (await action()) success();
      else setNotice(useSuperstringStore.getState().error ?? t("操作失败，请重试。"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const save = () => {
    if (!editing || !title.trim() || [...title.trim()].length > 200) return;
    void run(
      () => rename(editing.id, title),
      () => {
        setEditing(null);
        requestAnimationFrame(restoreFocus);
      },
    );
  };
  return (
    <>
      <div className="session-heading">{t("历史会话")}</div>
      <nav ref={listRef} className="session-list" aria-label={t("历史会话")}>
        {!sessions.length && <p className="sidebar-empty">{t("还没有会话，新建一个开始聊天")}</p>}
        {sessions.map((session) =>
          editing?.id === session.sourceId ? (
            <form
              key={session.id}
              className="session-rename"
              aria-label={t("重命名会话")}
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <input
                ref={inputRef}
                aria-label={t("会话名称")}
                value={title}
                disabled={busy}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    finishEdit();
                  }
                  if (event.key === "Enter" && event.nativeEvent.isComposing)
                    event.preventDefault();
                }}
              />
              <div className="session-rename-actions">
                <button type="button" disabled={busy} onClick={finishEdit}>
                  {t("取消")}
                </button>
                <button
                  type="submit"
                  disabled={busy || !title.trim() || [...title.trim()].length > 200}
                >
                  {busy ? t("正在保存…") : t("保存")}
                </button>
              </div>
              {[...title.trim()].length > 200 && <p role="alert">{t("名称须为 1–200 个字符。")}</p>}
            </form>
          ) : (
            <ConversationRow
              key={session.id}
              session={session}
              selected={session.id === currentId}
              disabled={busy || !!editing || !!deleting}
              onRename={() => {
                focusId.current = session.sourceId;
                setNotice("");
                setTitle(session.title);
                setEditing({ id: session.sourceId, title: session.title });
              }}
              onRefresh={() => {
                focusId.current = session.sourceId;
                void run(
                  () => refresh(session.sourceId),
                  () => {
                    setNotice(t("会话已刷新"));
                    requestAnimationFrame(restoreFocus);
                  },
                );
              }}
              onDelete={() => {
                focusId.current = session.sourceId;
                setNotice("");
                setDeleting({ id: session.sourceId, title: session.title });
              }}
            />
          ),
        )}
      </nav>
      {loading && <p role="status">{t("正在读取会话…")}</p>}
      {error && (
        <p role="alert" className="error">
          {translateNotice(error)}
        </p>
      )}
      <div className="conversation-directory-actions">
        <button type="button" disabled={loading} onClick={() => void load()}>
          {t("刷新会话目录")}
        </button>
        {cursor && (
          <button type="button" disabled={loading} onClick={() => void load("more")}>
            {t("加载更多会话")}
          </button>
        )}
      </div>
      {notice && !deleting && (
        <p className="session-notice" role="alert">
          {translateNotice(notice)}
        </p>
      )}
      {deleting && (
        <AlertDialog
          title={t("删除会话")}
          busy={busy}
          onCancel={() => {
            setDeleting(null);
            setNotice("");
            requestAnimationFrame(restoreFocus);
          }}
        >
          <p>{t("删除「{0}」及其全部消息？此操作无法撤销。", deleting.title)}</p>
          {notice && <p role="alert">{translateNotice(notice)}</p>}
          <div className="dialog-actions">
            <button
              type="button"
              data-dialog-cancel
              disabled={busy}
              onClick={() => {
                setDeleting(null);
                setNotice("");
                requestAnimationFrame(restoreFocus);
              }}
            >
              {t("取消")}
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy || sending}
              onClick={() =>
                void run(
                  () => remove(deleting.id),
                  () => {
                    setDeleting(null);
                    requestAnimationFrame(restoreFocus);
                  },
                )
              }
            >
              {busy ? t("正在删除…") : t("删除")}
            </button>
          </div>
        </AlertDialog>
      )}
    </>
  );
}

function ConversationRow({
  session,
  selected,
  disabled,
  onRename,
  onRefresh,
  onDelete,
}: {
  session: ConversationSummary;
  selected: boolean;
  disabled: boolean;
  onRename: () => void;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const t = useI18n();
  const select = useSuperstringStore((state) => state.requestConversationNavigation);
  const sending = useSuperstringStore((state) => sessionBusy(state, session.sourceId));
  const phase = useSuperstringStore(
    (state) => state.conversationById[state.sessionConversationIds[session.sourceId]]?.phase,
  );
  return (
    <ActionMenu
      label={t("会话操作")}
      triggerLabel={t("会话操作：{0}", session.title)}
      disabled={disabled || session.channel !== "web"}
      items={[
        { id: "rename", label: t("重命名"), icon: "edit", onSelect: onRename },
        {
          id: "refresh",
          label: t("刷新会话"),
          icon: "refresh",
          disabled: sending,
          onSelect: onRefresh,
        },
        {
          id: "delete",
          label: t("删除会话"),
          icon: "trash",
          danger: true,
          disabled: sending,
          onSelect: onDelete,
        },
      ]}
    >
      {(trigger) => (
        <div className="session-row">
          <button
            type="button"
            data-source-id={session.sourceId}
            className={selected ? "active" : ""}
            aria-current={selected ? "page" : undefined}
            title={session.title}
            aria-label={session.title}
            aria-describedby={`channel-${session.id}`}
            disabled={disabled}
            onClick={() => select(session.id)}
          >
            <span className="session-title">{session.title}</span>
            <small id={`channel-${session.id}`} className="conversation-channel">
              {t(
                session.channel === "web"
                  ? "Web · 私聊"
                  : session.topology === "shared"
                    ? "OneBot · 群聊"
                    : "OneBot · 私聊",
              )}
            </small>
            {phase && phase !== "idle" && (
              <span className="session-activity" role="status">
                {t(
                  phase === "failed"
                    ? "运行失败"
                    : phase === "reconciling"
                      ? "结果待确认"
                      : "正在处理",
                )}
              </span>
            )}
          </button>
          {trigger}
        </div>
      )}
    </ActionMenu>
  );
}
