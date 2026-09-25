import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { AlertDialog } from "../../ui/AlertDialog";
import { Icon } from "../../ui/icons";
import { sessionBusy } from "./conversation-state";
import { menuPosition } from "./menu-position";

type Target = { id: string; title: string };
type Menu = Target & { x: number; y: number };

export function SessionList() {
  const t = useI18n();
  const sessions = useSuperstringStore((state) => state.sessions);
  const currentId = useSuperstringStore((state) => state.currentSessionId);
  const openChat = useSuperstringStore((state) => state.openChat);
  const botSelected = useSuperstringStore((state) => !!state.selectedBotConversation);
  const select = useSuperstringStore((state) => state.selectSession);
  const rename = useSuperstringStore((state) => state.renameSession);
  const remove = useSuperstringStore((state) => state.deleteSessionById);
  const refresh = useSuperstringStore((state) => state.refreshSessionById);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [editing, setEditing] = useState<Target | null>(null);
  const [deleting, setDeleting] = useState<Target | null>(null);
  const sending = useSuperstringStore((state) =>
    sessionBusy(state, menu?.id ?? deleting?.id ?? ""),
  );
  const [title, setTitle] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [location, setLocation] = useState({ left: 8, top: 8 });
  const menuLabel = t("会话操作");
  const restoreFocus = () => {
    if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
    else listRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: locale changes the measured menu width.
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    setLocation(
      menuPosition(menu, menuRef.current.getBoundingClientRect(), {
        width: innerWidth,
        height: innerHeight,
      }),
    );
    menuRef.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu, menuLabel]);
  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const close = () => setMenu(null);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);
  const openMenu = (
    event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>,
    session: Target,
  ) => {
    event.preventDefault();
    if (busyRef.current || editing || deleting) return;
    triggerRef.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    setMenu({
      ...session,
      x: pointer ? event.clientX : rect.right - 8,
      y: pointer ? event.clientY : rect.bottom - 8,
    });
    setNotice("");
  };
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
        {sessions.length === 0 && (
          <p className="sidebar-empty">{t("还没有会话，新建一个开始聊天")}</p>
        )}
        {sessions.map((session) => (
          <div className="session-row" key={session.id}>
            <button
              type="button"
              className={session.id === currentId && !botSelected ? "active" : ""}
              aria-current={session.id === currentId && !botSelected ? "page" : undefined}
              aria-haspopup="menu"
              title={session.title}
              hidden={editing?.id === session.id}
              disabled={busy || editing !== null}
              onClick={() => {
                void select(session.id);
                openChat();
              }}
              onContextMenu={(event) => openMenu(event, session)}
              onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
                  openMenu(event, session);
              }}
            >
              {session.title}
            </button>
            <SessionActivity sessionId={session.id} />
            {editing?.id === session.id && (
              <form
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
                {[...title.trim()].length > 200 && (
                  <p role="alert">{t("名称须为 1–200 个字符。")}</p>
                )}
              </form>
            )}
          </div>
        ))}
      </nav>
      {notice && !deleting && (
        <p className="session-notice" role="alert">
          {translateNotice(notice)}
        </p>
      )}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className="session-menu"
            role="menu"
            aria-label={menuLabel}
            style={location}
            onKeyDown={(event) => {
              const buttons = [
                ...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ??
                  []),
              ];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              } else if (event.key === "Escape" || event.key === "Tab") {
                if (event.key === "Escape") event.preventDefault();
                setMenu(null);
                restoreFocus();
              }
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setEditing(menu);
                setTitle(menu.title);
                setMenu(null);
              }}
            >
              <Icon name="edit" />
              {t("重命名")}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={sending}
              onClick={() => {
                const id = menu.id;
                setMenu(null);
                restoreFocus();
                void run(
                  () => refresh(id),
                  () => setNotice(t("会话已刷新")),
                );
              }}
            >
              <Icon name="refresh" />
              {t("刷新会话")}
            </button>
            <hr className="menu-separator" />
            <button
              type="button"
              role="menuitem"
              className="danger"
              disabled={sending}
              onClick={() => {
                restoreFocus();
                setDeleting(menu);
                setMenu(null);
              }}
            >
              <Icon name="trash" />
              {t("删除会话")}
            </button>
          </div>,
          document.body,
        )}
      {deleting && (
        <AlertDialog
          title={t("删除会话")}
          busy={busy}
          onCancel={() => {
            setDeleting(null);
            setNotice("");
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

function SessionActivity({ sessionId }: { sessionId: string }) {
  const t = useI18n();
  const phase = useSuperstringStore(
    (s) => s.conversationById[s.sessionConversationIds[sessionId]]?.phase,
  );
  if (!phase || phase === "idle") return null;
  return (
    <span className="session-activity" role="status">
      {t(phase === "failed" ? "运行失败" : phase === "reconciling" ? "结果待确认" : "正在处理")}
    </span>
  );
}
