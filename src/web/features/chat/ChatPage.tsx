import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { HeadingIcon, Icon } from "../../ui/icons";
import { localTime } from "../../ui/local-time";
import { ProcessingStatus } from "../../ui/ProcessingStatus";
import { ContextUsagePanel } from "./ContextUsagePanel";
import { menuPosition } from "./menu-position";

export function ChatPage() {
  const t = useI18n();
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(120);
  useLayoutEffect(() => {
    const element = composerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      setComposerHeight(element.getBoundingClientRect().height),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const sessions = useSuperstringStore((state) => state.sessions);
  const currentSessionId = useSuperstringStore((state) => state.currentSessionId);
  const messages = useSuperstringStore((state) => state.messages);
  const runtimeConfig = useSuperstringStore((state) => state.runtimeConfig);
  const runtimeConfigUnavailable = useSuperstringStore((state) => state.runtimeConfigUnavailable);
  const composer = useSuperstringStore((state) => state.composer);
  const sending = useSuperstringStore((state) => state.sending);
  const pendingOperations = useSuperstringStore((state) => state.pendingOperations);
  const error = useSuperstringStore((state) => state.error);
  const feedback = useSuperstringStore((state) => state.feedback);
  const setComposer = useSuperstringStore((state) => state.setComposer);
  const send = useSuperstringStore((state) => state.send);
  const failedChat = useSuperstringStore((state) => state.failedChat);
  const knowledgeResend = useSuperstringStore((state) => state.knowledgeResend);
  const retryChat = useSuperstringStore((state) => state.retryChat);
  const resendKnowledgeChat = useSuperstringStore((state) => state.resendKnowledgeChat);
  const cancelKnowledgeResend = useSuperstringStore((state) => state.cancelKnowledgeResend);
  const deleteMessageAction = useSuperstringStore((state) => state.deleteMessage);
  const current = sessions.find((item) => item.id === currentSessionId);
  const modeLabel =
    runtimeConfig?.mode === "chat"
      ? t("聊天")
      : runtimeConfig?.mode === "work"
        ? t("工作")
        : runtimeConfig?.mode
          ? t("未知模式（{0}）", runtimeConfig.mode)
          : t("未知模式");
  const headingText = !current
    ? t("当前对话 · 请新建会话")
    : runtimeConfigUnavailable
      ? t("会话信息暂不可用")
      : `${current.title} · ${runtimeConfig?.name ?? "Agent"} · ${modeLabel}`;
  const [messageMenu, setMessageMenu] = useState<{
    messageId: string;
    x: number;
    y: number;
  } | null>(null);
  const [deleteMessageId, setDeleteMessageId] = useState<string | null>(null);
  const messageMenuRef = useRef<HTMLDivElement | null>(null);

  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const [menuLocation, setMenuLocation] = useState({ left: 8, top: 8 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: translated label changes the measured menu width.
  useLayoutEffect(() => {
    if (!messageMenu || !messageMenuRef.current) return;
    const rect = messageMenuRef.current.getBoundingClientRect();
    setMenuLocation(
      menuPosition(messageMenu, rect, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
    messageMenuRef.current
      .querySelector<HTMLButtonElement>("button")
      ?.focus({ preventScroll: true });
  }, [messageMenu, t("删除消息")]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: close stale operations when the active chat changes.
  useEffect(() => {
    setMessageMenu(null);
    setDeleteMessageId(null);
  }, [currentSessionId]);
  useEffect(() => {
    if (!messageMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!messageMenuRef.current?.contains(event.target as Node)) setMessageMenu(null);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") event.preventDefault();
        setMessageMenu(null);
        menuTriggerRef.current?.focus({ preventScroll: true });
      }
    };
    const close = () => setMessageMenu(null);
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeEscape, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeEscape, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [messageMenu]);

  const openMessageMenu = (
    event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
    messageId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    menuTriggerRef.current = event.currentTarget;
    const bubble = event.currentTarget.querySelector(".bubble") ?? event.currentTarget;
    const rect = bubble.getBoundingClientRect();
    const pointer = "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    setMessageMenu({
      messageId,
      x: pointer ? event.clientX : rect.right - 8,
      y: pointer ? event.clientY : rect.bottom - 8,
    });
  };

  const deleteMessage = (id: string) => deleteMessageAction(currentSessionId, id);
  return (
    <section
      className="page chat-page"
      style={{ "--composer-space": `${composerHeight + 30}px` } as CSSProperties}
    >
      <header className="page-header chat-header">
        <div>
          <h1>
            <HeadingIcon name="chat" />
            <span>{headingText}</span>
          </h1>
        </div>
      </header>
      <div className="chat-content">
        {messages.length === 0 ? (
          <div className="empty-chat">
            <h2>{current ? t("开始对话") : t("开始一段对话")}</h2>
            <p>
              {current
                ? t("在下方输入消息，开始与助手交流。")
                : t("点击“新建任务”，开启与助手的对话。")}
            </p>
          </div>
        ) : (
          <div className="messages">
            {messages
              .filter((message) => message.role !== "system")
              .map((message) => (
                <article
                  key={message.id}
                  tabIndex={
                    message.status !== "pending" && !message.id.startsWith("optimistic-")
                      ? 0
                      : undefined
                  }
                  aria-label={t("消息 {0}", message.role === "user" ? t("用户") : t("模型"))}
                  onKeyDown={(event) => {
                    if (
                      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) &&
                      message.status !== "pending" &&
                      !message.id.startsWith("optimistic-")
                    )
                      openMessageMenu(event, message.id);
                  }}
                  className={`message ${message.role} ${message.status}`}
                  onContextMenu={(event) =>
                    !message.id.startsWith("optimistic-") &&
                    message.status !== "pending" &&
                    openMessageMenu(event, message.id)
                  }
                >
                  <div className="bubble">
                    {message.content || (message.status === "pending" ? t("正在生成…") : "")}
                    {message.status === "failed" && `\n\n${t("[生成失败]")}`}
                    {message.status === "cancelled" && `\n\n${t("[生成已取消]")}`}
                  </div>
                  <small className="message-meta">
                    {message.role === "user" ? t("用户") : t("模型")} ·{" "}
                    {localTime(message.completedAt ?? message.createdAt)}
                    {message.errorCode ? ` · ${message.errorCode}` : ""}
                  </small>
                </article>
              ))}
          </div>
        )}
      </div>
      {messageMenu && (
        <div
          ref={messageMenuRef}
          className="message-menu is-open"
          role="menu"
          aria-label={t("消息操作")}
          style={menuLocation}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              menuTriggerRef.current?.focus({ preventScroll: true });
              setDeleteMessageId(messageMenu.messageId);
              setMessageMenu(null);
            }}
          >
            <Icon name="trash" />
            {t("删除消息")}
          </button>
        </div>
      )}
      {deleteMessageId && (
        <ConfirmDialog
          message={t("确认删除这条消息？")}
          confirmLabel={t("删除")}
          onCancel={() => setDeleteMessageId(null)}
          onConfirm={() => {
            const id = deleteMessageId;
            setDeleteMessageId(null);
            void deleteMessage(id);
          }}
        />
      )}
      {knowledgeResend && knowledgeResend.sessionId === currentSessionId && (
        <ConfirmDialog
          message={t("资料权限已变化，原请求不能重试。是否按最新权限重新发送？这将创建新请求。")}
          confirmLabel={t("按最新权限重新发送")}
          onCancel={cancelKnowledgeResend}
          onConfirm={() => void resendKnowledgeChat()}
        />
      )}
      <div className="composer-wrap" ref={composerRef}>
        {(error || feedback) && (
          <div className={error ? "status error" : "status"}>
            {translateNotice(error ?? feedback)}
          </div>
        )}
        <textarea
          value={composer}
          onChange={(event) => setComposer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={t("输入消息…")}
          rows={2}
          disabled={sending}
        />
        <div className="composer-actions">
          <span>{t("Enter 发送 · Shift + Enter 换行")}</span>
          <ContextUsagePanel />
          {failedChat?.sessionId === currentSessionId && (
            <button type="button" disabled={sending} onClick={() => void retryChat()}>
              {t("重试原请求")}
            </button>
          )}
          <button
            type="button"
            className="primary"
            aria-label={sending ? t("生成中") : t("发送")}
            disabled={sending}
            onClick={() => void send()}
          >
            {sending ? t("生成中") : t("发送")}
          </button>
        </div>
      </div>
      <ProcessingStatus active={sending || pendingOperations > 0} />
    </section>
  );
}
