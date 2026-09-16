import { type ReactNode, useEffect, useRef, useState } from "react";
import type { PersonaResponse, RetrievalMode } from "../shared/contracts";
import { MODES, readMode, readTheme, selectMode, selectTheme, THEMES } from "./appearance";
import { broadcastAppearance } from "./desktop-lifecycle";
import type { AgentDraft, SectionKey } from "./store";
import { useSuperstringStore } from "./store";

const VERSION = "0.1.0alpha";

function localTime(value: string | Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(typeof value === "string" ? new Date(value) : value)
    .reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function ConfirmDialog({
  message,
  confirmLabel = "确认",
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onCancel]);
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={message}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <strong>{message}</strong>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const SECTION_META: Array<{ key: SectionKey; title: string; note?: string }> = [
  { key: "A", title: "名称与模型" },
  { key: "B", title: "记忆管理" },
  { key: "C", title: "上下文" },
  { key: "D", title: "性格与人设" },
  { key: "E", title: "情绪", note: "未开放" },
  { key: "F", title: "外部软件接入", note: "未开放" },
  { key: "G", title: "用户画像", note: "未开放" },
  { key: "H", title: "其他", note: "未开放" },
];

function Icon({
  name,
}: {
  name:
    | "brand"
    | "settings"
    | "chat"
    | "agent"
    | "memory"
    | "context"
    | "persona"
    | "emotion"
    | "plug"
    | "more"
    | "sliders"
    | "users"
    | "back"
    | "palette"
    | "profile"
    | "plus"
    | "instructions"
    | "chip"
    | "search"
    | "archive"
    | "clock"
    | "hand"
    | "compress"
    | "shield"
    | "scope";
}) {
  const paths: Record<typeof name, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    instructions: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 8h6M9 12h6M9 16h4" />
      </>
    ),
    chip: (
      <>
        <rect x="6" y="6" width="12" height="12" rx="2" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
        <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    archive: (
      <>
        <rect x="3" y="4" width="18" height="4" rx="1" />
        <path d="M5 8v12h14V8M10 12h4" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    hand: (
      <path d="M9 12V5a2 2 0 0 1 4 0v6l1-1a2 2 0 0 1 3 1l1-1a2 2 0 0 1 3 2v3a6 6 0 0 1-6 6h-2a5 5 0 0 1-4-2l-5-6a2 2 0 0 1 3-2l2 2" />
    ),
    compress: (
      <>
        <path d="M4 4l5 5M4 9h5V4M20 20l-5-5m0 5v-5h5M14 4h6v6M4 14v6h6" />
      </>
    ),
    shield: <path d="M12 3 4 6v5c0 5 4 8 8 10 4-2 8-5 8-10V6l-8-3Zm-4 9 3 3 5-6" />,
    scope: (
      <>
        <path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    brand: (
      <>
        <path
          strokeWidth="1.7"
          d="M7.6 10h8.8a1.6 1.6 0 0 1 1.6 1.6V17a1.6 1.6 0 0 1-1.6 1.6h-6.9l-1.9 1.9v-1.9A1.6 1.6 0 0 1 6 17v-5.4A1.6 1.6 0 0 1 7.6 10Z"
        />
        <g strokeWidth="1.3">
          <path d="M1.85 2.55c-.38 .57-.6175 1.1875-.7125 1.8525c.38-.0475 .7125-.266 .931-.57" />
          <path d="M3.7025 2.55c-.38 .57-.6175 1.1875-.7125 1.8525c.38-.0475 .7125-.266 .931-.57" />
          <path d="M20.2975 4.4025c.38-.57 .6175-1.1875 .7125-1.8525c-.38 .0475-.7125 .266-.931 .57" />
          <path d="M22.15 4.4025c.38-.57 .6175-1.1875 .7125-1.8525c-.38 .0475-.7125 .266-.931 .57" />
        </g>
        <path
          strokeWidth="1.4"
          d="M7.95 14.85C8.6 14.85 8.775 13.1 10.065 13.1C10.71 13.1 11.355 13.5 12 14.3C12.645 15.1 13.29 15.5 13.935 15.5C15.225 15.5 15.4 13.75 16.05 13.75"
        />
        <circle cx="10.065" cy="13.1" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="13.935" cy="15.5" r="1.6" fill="currentColor" stroke="none" />
      </>
    ),
    settings: (
      <>
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.73v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.73l.15-.1a2 2 0 0 0 .73-2.72l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
        <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      </>
    ),
    chat: (
      <>
        <path d="M4 5.5h16v11H9l-5 3v-14Z" />
        <path d="M8 10h8M8 13h5" />
      </>
    ),
    agent: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20v-1a7 7 0 0 1 14 0v1" />
      </>
    ),
    memory: (
      <>
        <path d="M5 6c0-2 3.1-3 7-3s7 1 7 3-3.1 3-7 3-7-1-7-3Z" />
        <path d="M5 6v6c0 2 3.1 3 7 3s7-1 7-3V6M5 12v6c0 2 3.1 3 7 3s7-1 7-3v-6" />
      </>
    ),
    context: (
      <>
        <path d="M4 5h16v12H9l-5 3V5Z" />
        <path d="M8 9h8M8 13h6" />
      </>
    ),
    persona: (
      <>
        <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
        <path d="M5 21a7 7 0 0 1 14 0" />
      </>
    ),
    emotion: (
      <>
        <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
        <path d="M8.5 10h.01M15.5 10h.01M8.5 15c2 1.5 5 1.5 7 0" />
      </>
    ),
    plug: (
      <>
        <path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-6 6v4M9 21h6" />
      </>
    ),
    more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
    sliders: (
      <>
        <path d="M4 7h4m4 0h8M4 17h8m4 0h4" />
        <circle cx="10" cy="7" r="2" />
        <circle cx="14" cy="17" r="2" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v1" />
      </>
    ),
    back: <path d="m10 6-6 6 6 6M4 12h16" />,
    palette: (
      <>
        <path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3 1.5 1.5 0 0 1 1.1-2.5H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z" />
        <circle cx="7.5" cy="11" r="0.7" />
        <circle cx="10" cy="7" r="0.7" />
        <circle cx="15" cy="7.5" r="0.7" />
      </>
    ),
    profile: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <circle cx="9" cy="10" r="2" />
        <path d="M5.5 16a3.5 3.5 0 0 1 7 0M15 9h3m-3 4h3" />
      </>
    ),
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function NewSessionButtonIcon() {
  return (
    <svg className="new-session-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function HeadingIcon({ name }: { name: Parameters<typeof Icon>[0]["name"] }) {
  return (
    <span className="heading-icon-host" aria-hidden="true">
      <Icon name={name} />
    </span>
  );
}

function NewSessionDialogIcon() {
  return (
    <span className="heading-icon-host" aria-hidden="true">
      <svg className="heading-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4h14v12H9l-4 4V4Z" />
        <path d="M12 7v6M9 10h6" />
      </svg>
    </span>
  );
}

function ProcessingStatus({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div
      className="processing-status"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label="正在处理"
    >
      <span className="superstring-loading-ring" aria-hidden="true" />
      <span>正在处理</span>
    </div>
  );
}

function Field({ label, info, children }: { label: string; info?: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
      {info && <small>{info}</small>}
    </div>
  );
}

function Chevron() {
  return (
    <svg className="icon chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

const CONFIG_LIST_ICONS = {
  基本信息: "profile",
  基础指令: "instructions",
  本地模型: "chip",
  "外部 API 模型接入": "plug",
  读取配置: "search",
  保守预设: "shield",
  标准预设: "sliders",
  宽泛预设: "scope",
  整理配置: "archive",
  自动整理: "clock",
  手动整理: "hand",
  记忆列表与治理: "memory",
  模型与预算: "chip",
  压缩策略: "compress",
  高级设置: "sliders",
  "人设（身份与边界）": "profile",
  "性格（表达风格）": "chat",
} as const satisfies Record<string, Parameters<typeof Icon>[0]["name"]>;

function Accordion({
  title,
  note,
  icon,
  open = false,
  children,
}: {
  title: string;
  note?: string;
  icon?: Parameters<typeof Icon>[0]["name"];
  open?: boolean;
  children: ReactNode;
}) {
  const label = title.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, "");
  const listIcon = !icon ? CONFIG_LIST_ICONS[label as keyof typeof CONFIG_LIST_ICONS] : undefined;
  return (
    <details className="group" open={open}>
      <summary className={icon ? "icon-summary" : undefined}>
        {icon && <Icon name={icon} />}
        <span className="summary-copy">
          <strong>
            {listIcon && (
              <span className="config-list-icon">
                <Icon name={listIcon} />
              </span>
            )}
            {listIcon ? label : title}
          </strong>
          {note && <small>{note}</small>}
        </span>
        <Chevron />
      </summary>
      <div className="group-body">{children}</div>
    </details>
  );
}

export function Sidebar() {
  const {
    agents,
    sessions,
    currentSessionId,
    feedback,
    error,
    selectSession,
    openSettings,
    createSession,
  } = useSuperstringStore();
  const [dialog, setDialog] = useState(false);
  const [custom, setCustom] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const activeAgents = agents.filter((agent) => agent.is_active);
  const noActiveAgent = activeAgents.length === 0;
  const openDialog = () => {
    setDialog(true);
    setCustom(false);
    setTitle("");
    useSuperstringStore.setState({ feedback: "", error: null });
  };
  const closeDialog = () => {
    if (creating) return;
    setDialog(false);
    setCustom(false);
    setTitle("");
  };
  const create = async (name: string) => {
    setCreating(true);
    const created = await createSession(name);
    setCreating(false);
    if (!created) return;
    setDialog(false);
    setCustom(false);
    setTitle("");
  };
  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <div className="brand">
          <HeadingIcon name="brand" />
          <strong>superstring</strong>
        </div>
        <div className="version">v{VERSION}</div>
        <p className="mode-note">聊天模式 · 本地工作空间</p>
        {noActiveAgent && (
          <p className="sidebar-empty">
            当前没有启用的助手，无法新建对话；请到设置中启用或新建助手。
          </p>
        )}
        <button
          className="primary new-session"
          type="button"
          disabled={creating}
          onClick={openDialog}
        >
          <NewSessionButtonIcon />
          <span>新建任务</span>
        </button>
        {dialog && (
          <div className="new-dialog">
            <strong className="new-dialog-title">
              <NewSessionDialogIcon />
              <span>新建任务</span>
            </strong>
            <span>请选择任务名称方式</span>
            {!custom ? (
              <>
                <button
                  type="button"
                  className="primary"
                  disabled={creating}
                  onClick={() => void create(`新会话 ${localTime()}`)}
                >
                  暂时使用默认名称
                </button>
                <button type="button" disabled={creating} onClick={() => setCustom(true)}>
                  使用自定义名称
                </button>
              </>
            ) : (
              <>
                <Field label="任务名称">
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="请输入任务名称"
                    disabled={creating}
                  />
                </Field>
                <button
                  type="button"
                  className="primary"
                  disabled={creating || !title.trim()}
                  onClick={() => void create(title)}
                >
                  {creating ? "正在创建…" : "确认创建"}
                </button>
              </>
            )}
            <button type="button" disabled={creating} onClick={closeDialog}>
              取消
            </button>
            {(feedback || error) && <div className="dialog-status">{error ?? feedback}</div>}
          </div>
        )}
        <div className="session-heading">历史会话</div>
        <nav className="session-list" aria-label="历史会话">
          {sessions.length === 0 && <p className="sidebar-empty">还没有会话，新建一个开始聊天</p>}
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={session.id === currentSessionId ? "active" : ""}
              onClick={() => void selectSession(session.id)}
            >
              {session.title}
            </button>
          ))}
        </nav>
      </div>
      <button
        className="settings-button"
        type="button"
        aria-label="设置"
        title="设置"
        onClick={openSettings}
      >
        <Icon name="settings" />
        <span className="visually-hidden">设置</span>
      </button>
    </aside>
  );
}

export function ChatPage() {
  const {
    sessions,
    currentSessionId,
    messages,
    runtimeConfig,
    runtimeConfigUnavailable,
    composer,
    sending,
    pendingOperations,
    error,
    feedback,
    setComposer,
    send,
    refreshSession,
    deleteCurrentSession,
    apiClient,
  } = useSuperstringStore();
  const current = sessions.find((item) => item.id === currentSessionId);
  const modeLabel =
    runtimeConfig?.mode === "chat"
      ? "聊天"
      : runtimeConfig?.mode === "work"
        ? "工作"
        : runtimeConfig?.mode
          ? `未知模式（${runtimeConfig.mode}）`
          : "未知模式";
  const headingText = !current
    ? "当前对话 · 请新建会话"
    : runtimeConfigUnavailable
      ? "会话信息暂不可用"
      : `${current.title} · ${runtimeConfig?.name ?? "Agent"} · ${modeLabel}`;
  const [messageMenu, setMessageMenu] = useState<{
    messageId: string;
    left: number;
    top: number;
  } | null>(null);
  const [deleteMessageId, setDeleteMessageId] = useState<string | null>(null);
  const [confirmSessionDelete, setConfirmSessionDelete] = useState(false);
  const messageMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!messageMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!messageMenuRef.current?.contains(event.target as Node)) setMessageMenu(null);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMessageMenu(null);
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

  const openMessageMenu = (event: React.MouseEvent<HTMLElement>, messageId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 112;
    const height = 42;
    const gap = 8;
    let left = rect.right + gap;
    if (left + width > window.innerWidth - gap) left = rect.left - width - gap;
    left = Math.max(gap, Math.min(left, window.innerWidth - width - gap));
    let top = rect.top + (rect.height - height) / 2;
    top = Math.max(gap, Math.min(top, window.innerHeight - height - gap));
    setMessageMenu({ messageId, left: Math.round(left), top: Math.round(top) });
  };

  const deleteMessage = async (id: string) => {
    if (!currentSessionId) {
      useSuperstringStore.setState({ feedback: "当前没有会话，无法删除消息" });
      return;
    }
    try {
      await apiClient.deleteMessage(currentSessionId, id);
      await useSuperstringStore.getState().selectSession(currentSessionId);
    } catch (deleteError) {
      useSuperstringStore.setState({
        error: null,
        feedback: `删除消息失败：${deleteError instanceof Error ? deleteError.message : "请检查后端服务"}`,
      });
    }
  };
  return (
    <section className="page chat-page">
      <header className="page-header chat-header">
        <div>
          <h1>
            <HeadingIcon name="chat" />
            <span>{headingText}</span>
          </h1>
          {current && !runtimeConfigUnavailable && (
            <p>
              配置版本 {runtimeConfig?.config_version ?? current.config_version} ·
              右击消息可打开操作菜单
            </p>
          )}
        </div>
        <div className="header-actions">
          <button type="button" onClick={() => void refreshSession()}>
            刷新会话
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (!currentSessionId) {
                useSuperstringStore.setState({
                  error: null,
                  feedback: "当前没有可删除的会话。",
                });
                return;
              }
              setConfirmSessionDelete(true);
            }}
          >
            删除会话
          </button>
        </div>
      </header>
      <div className="chat-content">
        {messages.length === 0 ? (
          <div className="empty-chat">
            <h2>{current ? "开始对话" : "开始一段对话"}</h2>
            <p>
              {current ? "在下方输入消息，开始与助手交流。" : "点击“新建任务”，开启与助手的对话。"}
            </p>
          </div>
        ) : (
          <div className="messages">
            {messages
              .filter((message) => message.role !== "system")
              .map((message) => (
                <article
                  key={message.id}
                  className={`message ${message.role} ${message.status}`}
                  onContextMenu={(event) =>
                    !message.id.startsWith("optimistic-") &&
                    message.status !== "pending" &&
                    openMessageMenu(event, message.id)
                  }
                >
                  <div className="bubble">
                    {message.content || (message.status === "pending" ? "正在生成…" : "")}
                    {message.status === "failed" && "\n\n[生成失败]"}
                    {message.status === "cancelled" && "\n\n[生成已取消]"}
                  </div>
                  <small className="message-meta">
                    {message.role === "user" ? "用户" : "模型"} ·{" "}
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
          aria-label="消息操作"
          style={{ left: messageMenu.left, top: messageMenu.top }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setDeleteMessageId(messageMenu.messageId);
              setMessageMenu(null);
            }}
          >
            删除
          </button>
        </div>
      )}
      {deleteMessageId && (
        <ConfirmDialog
          message="确认删除这条消息？"
          confirmLabel="删除"
          onCancel={() => setDeleteMessageId(null)}
          onConfirm={() => {
            const id = deleteMessageId;
            setDeleteMessageId(null);
            void deleteMessage(id);
          }}
        />
      )}
      {confirmSessionDelete && (
        <ConfirmDialog
          message="确认删除当前会话及其全部消息？"
          confirmLabel="删除会话"
          onCancel={() => setConfirmSessionDelete(false)}
          onConfirm={() => {
            setConfirmSessionDelete(false);
            void deleteCurrentSession();
          }}
        />
      )}
      <div className="composer-wrap">
        <textarea
          value={composer}
          onChange={(event) => setComposer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="输入消息…"
          rows={2}
          disabled={sending}
        />
        <div className="composer-actions">
          <span>Enter 发送 · Shift + Enter 换行</span>
          <button type="button" className="primary" disabled={sending} onClick={() => void send()}>
            {sending ? "生成中" : "发送"}
          </button>
        </div>
      </div>
      <ProcessingStatus active={sending || pendingOperations > 0} />
      {(error || feedback) && (
        <div className={error ? "status error" : "status"}>{error ?? feedback}</div>
      )}
    </section>
  );
}

function SettingsHeader({ onBack }: { onBack?: () => void }) {
  const { openChat } = useSuperstringStore();
  return (
    <header className="page-header settings-header">
      {onBack ? (
        <nav aria-label="设置导航">
          <button
            className="settings-back"
            type="button"
            aria-label="返回设置中心"
            onClick={onBack}
          >
            <Icon name="back" />
            <span>设置中心</span>
          </button>
        </nav>
      ) : (
        <h1>
          <Icon name="settings" />
          设置中心
        </h1>
      )}
      <button type="button" onClick={openChat}>
        返回对话
      </button>
    </header>
  );
}

function SettingsHub() {
  const { openAgentSettings, requestPageNavigation } = useSuperstringStore();
  return (
    <section className="page settings-page">
      <SettingsHeader />
      <div className="settings-content settings-hub">
        <h2>功能设置</h2>
        <nav className="settings-list" aria-label="功能设置">
          <button
            type="button"
            className="settings-entry"
            aria-label="助手设置"
            onClick={openAgentSettings}
          >
            <Icon name="agent" />
            <span className="settings-entry-copy">
              <strong>助手设置</strong>
              <small>模型、记忆与性格人设；各分区独立保存。</small>
            </span>
            <span className="entry-arrow" aria-hidden="true">
              <Chevron />
            </span>
          </button>
          <button
            type="button"
            className="settings-entry"
            aria-label="外观"
            onClick={() => requestPageNavigation("settings", "appearance")}
          >
            <Icon name="palette" />
            <span className="settings-entry-copy">
              <strong>外观</strong>
              <small>选择主题颜色，调整界面配色。</small>
            </span>
            <span className="entry-arrow" aria-hidden="true">
              <Chevron />
            </span>
          </button>
        </nav>
      </div>
    </section>
  );
}

export function AppearanceSettings() {
  const { requestPageNavigation } = useSuperstringStore();
  const [themeId, setThemeId] = useState(readTheme);
  const [notice, setNotice] = useState("");
  const [modeId, setModeId] = useState(readMode);
  const [modeNotice, setModeNotice] = useState("");

  // Minimal cross-tab consistency: when another tab changes appearance, refresh
  // the local pressed/aria state so this page's controls reflect reality. No
  // layout change. (This tab's own changes are announced via broadcastAppearance
  // from the click handlers below; a writer tab never receives its own event.)
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === "superstring-appearance" ||
        event.key === "superstring-appearance-mode"
      ) {
        setThemeId(readTheme());
        setModeId(readMode());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return (
    <section className="page settings-page">
      <SettingsHeader onBack={() => requestPageNavigation("settings", "hub")} />
      <div className="settings-content appearance-settings">
        <h2>外观</h2>
        <p className="settings-note">点击色圆立即切换并自动保存；浅色与深色跟随系统。</p>
        <Accordion title="推荐外观" note="16 种配色，点击色圆立即切换。" icon="palette" open>
          <fieldset className="theme-options">
            <legend className="visually-hidden">主题颜色</legend>
            {THEMES.map((theme) => (
              <button
                type="button"
                key={theme.id}
                className="theme-option"
                aria-label={`${theme.name}主题${theme.id === "slate" ? "（默认）" : ""}`}
                aria-pressed={theme.id === themeId}
                title={theme.name}
                onClick={() => {
                  const saved = selectTheme(theme.id);
                  setThemeId(theme.id);
                  broadcastAppearance({ theme: theme.id, mode: readMode() });
                  setNotice(
                    saved
                      ? `已切换为${theme.name}`
                      : `已切换为${theme.name}，但浏览器未允许保存；刷新后可能恢复默认。`,
                  );
                }}
              >
                <span
                  className="theme-swatch"
                  style={{ backgroundColor: theme.color }}
                  aria-hidden="true"
                >
                  {theme.id === themeId && (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m6 12 4 4 8-8" />
                    </svg>
                  )}
                </span>
                <span className="theme-label">
                  {theme.name}
                  {theme.id === "slate" && <small>默认</small>}
                </span>
              </button>
            ))}
          </fieldset>
          <p className="hint" role="status" aria-live="polite">
            <span className="theme-dot" aria-hidden="true" />
            {notice || `当前主题：${THEMES.find((theme) => theme.id === themeId)?.name}`}
          </p>
        </Accordion>
        <Accordion title="明暗模式" note="跟随系统，或固定浅色／深色。" icon="sliders" open>
          <fieldset className="mode-options">
            <legend className="visually-hidden">明暗模式</legend>
            {MODES.map((mode) => (
              <button
                type="button"
                key={mode.id}
                className="mode-option"
                aria-pressed={mode.id === modeId}
                onClick={() => {
                  const saved = selectMode(mode.id);
                  setModeId(mode.id);
                  broadcastAppearance({ theme: readTheme(), mode: mode.id });
                  setModeNotice(
                    saved ? "" : `已切换为${mode.name}，但浏览器未允许保存；刷新后可能恢复默认。`,
                  );
                }}
              >
                {mode.name}
              </button>
            ))}
          </fieldset>
          <p className="hint" aria-live="polite">
            {modeNotice || `当前：${MODES.find((mode) => mode.id === modeId)?.name}`}
          </p>
        </Accordion>
        <Accordion title="自定义外观" note="未开放" icon="sliders">
          <p className="hint">自定义颜色与更多外观选项暂未开放。</p>
        </Accordion>
      </div>
    </section>
  );
}

function ModelSelect({
  value,
  models,
  onChange,
}: {
  value: string | null;
  models: string[];
  onChange: (value: string | null) => void;
}) {
  return (
    <select
      value={value ?? "__follow__"}
      onChange={(event) =>
        onChange(event.target.value === "__follow__" ? null : event.target.value)
      }
    >
      <option value="__follow__">跟随当前模型</option>
      {models.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
    </select>
  );
}

function NumberField({
  value,
  min,
  max,
  step = 1,
  disabled = false,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
}

function SectionA({
  draft,
  patch,
  models,
}: {
  draft: AgentDraft;
  patch: (patch: Partial<AgentDraft>) => void;
  models: string[];
}) {
  const { modelStatus, refreshModels, editorAgentId } = useSuperstringStore();
  return (
    <div className="config-section">
      <h3>A · 名称与模型</h3>
      <p>模型与指令保存后从下一轮生效，不影响正在生成的回复。</p>
      <Accordion
        title="① 基本信息"
        note="名称、描述与启用状态。"
        open={editorAgentId === "__new__"}
      >
        <Field label="助手名称">
          <input
            aria-label="助手名称"
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>
        <Field label="描述" info="仅供识别，不影响回复。">
          <textarea
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
            rows={3}
          />
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.is_active}
            onChange={(event) => patch({ is_active: event.target.checked })}
          />
          <span>
            <strong>启用当前 Agent</strong>
            <small>取消勾选并保存后，新会话不能再选择该 Agent；已有会话不受影响。</small>
          </span>
        </label>
      </Accordion>
      <Accordion title="② 基础指令" note="对该助手回复的补充要求。">
        <Field label="补充指令" info="追加到人设与性格之后，影响该助手的回复。">
          <textarea
            rows={5}
            value={draft.additional_instructions}
            onChange={(event) => patch({ additional_instructions: event.target.value })}
          />
        </Field>
      </Accordion>
      <Accordion title="③ 本地模型" note="选择对话模型，调整回复随机度。">
        <Field label="对话模型" info="来自 LM Studio 当前可用的模型。">
          <select
            value={draft.model_name}
            onChange={(event) => patch({ model_name: event.target.value })}
          >
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
            {!models.includes(draft.model_name) && (
              <option value={draft.model_name}>{draft.model_name}</option>
            )}
          </select>
        </Field>
        <button type="button" onClick={() => void refreshModels()}>
          刷新模型列表
        </button>
        <p className="hint">{modelStatus}</p>
        <Field label="回复随机度" info="越低越稳定，越高越多样。对应 temperature，默认 0.7。">
          <div className="range-row">
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={draft.temperature}
              onChange={(event) => patch({ temperature: Number(event.target.value) })}
            />
            <output>{draft.temperature.toFixed(2)}</output>
          </div>
        </Field>
      </Accordion>
      <Accordion title="④ 外部 API 模型接入">
        <div className="unavailable">
          <strong>状态：暂未开放</strong>
          <Field label="服务地址">
            <input disabled placeholder="例如：https://api.example.com/v1" />
          </Field>
          <Field label="API Key">
            <input disabled type="password" placeholder="启用安全存储后再配置" />
          </Field>
          <Field label="模型名称">
            <input disabled placeholder="例如：provider-model-name" />
          </Field>
        </div>
      </Accordion>
    </div>
  );
}

const MODE_OPTIONS: Array<[RetrievalMode, string]> = [
  ["off", "关闭（本轮不读取长期记忆）"],
  ["conservative", "保守（只用直接相关记忆）"],
  ["standard", "标准（兼顾直接相关和必要背景）"],
  ["broad", "宽泛（允许有帮助的间接背景）"],
  ["full_catalog", "全目录检索（逐批筛选全部记忆）"],
  ["full_body", "全部正文注入（不做相关性筛选）"],
];

export function SectionB({
  draft,
  patch,
  models,
}: {
  draft: AgentDraft;
  patch: (patch: Partial<AgentDraft>) => void;
  models: string[];
}) {
  const {
    policy,
    memorySessions,
    memoryTurns,
    memoryEntries,
    memoryEntryDetail,
    feedback,
    loadMemoryTurns,
    loadMemoryPage,
    loadMemoryEntryDetail,
    manualConsolidate,
    updatePolicy,
    editorAgentId,
    apiClient,
  } = useSuperstringStore();
  const p5 = draft.p5_config;
  const patchP5 = (next: Partial<typeof p5>) => patch({ p5_config: { ...p5, ...next } });
  const [sourceSessionId, setSourceSessionId] = useState("");
  const [recentTurnCount, setRecentTurnCount] = useState(20);
  const [selectedTurns, setSelectedTurns] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [selectedMemories, setSelectedMemories] = useState<string[]>([]);
  const [purgeConfirmed, setPurgeConfirmed] = useState(false);

  const resetMemorySelection = () => {
    setSelectedMemories([]);
    setPurgeConfirmed(false);
    useSuperstringStore.setState({ memoryEntryDetail: null });
  };
  const govern = async (action: "suppress" | "enable" | "purge") => {
    if (editorAgentId === "__new__" || selectedMemories.length === 0) {
      useSuperstringStore.setState({ feedback: "请选择记忆" });
      return;
    }
    if (action === "purge" && !purgeConfirmed) {
      setPurgeConfirmed(false);
      useSuperstringStore.setState({ feedback: "永久删除需要明确确认" });
      return;
    }
    try {
      await apiClient.govern(editorAgentId, {
        memory_ids: selectedMemories,
        action,
        confirm_permanent: action === "purge",
      });
      resetMemorySelection();
      useSuperstringStore.setState({
        feedback: "操作完成，请重新加载记忆列表。",
        error: null,
      });
    } catch (error) {
      setPurgeConfirmed(false);
      useSuperstringStore.setState({
        feedback: `操作未完成：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
  const merge = async () => {
    if (editorAgentId === "__new__" || selectedMemories.length === 0) {
      useSuperstringStore.setState({ feedback: "请选择记忆" });
      return;
    }
    try {
      await apiClient.merge(editorAgentId, {
        request_key: crypto.randomUUID().replaceAll("-", ""),
        memory_ids: selectedMemories,
      });
      resetMemorySelection();
      useSuperstringStore.setState({
        feedback: "整合任务已排队；成功后原条目被替代，新条目生效。",
        error: null,
      });
    } catch (error) {
      setPurgeConfirmed(false);
      useSuperstringStore.setState({
        feedback: `操作未完成：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
  const localTime = (value: string) => {
    const parts = new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date(value))
      .reduce<Record<string, string>>((result, part) => {
        result[part.type] = part.value;
        return result;
      }, {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  };
  const detailText = memoryEntryDetail
    ? `${memoryEntryDetail.name}\n存储时间：${localTime(memoryEntryDetail.created_at)}\n${memoryEntryDetail.summary}\n\n${memoryEntryDetail.body}`
    : "";
  const statusLabel = {
    active: "生效",
    suppressed: "已屏蔽",
    replaced: "已被替代",
    invalid: "来源失效",
  } as const;

  return (
    <div className="config-section">
      <h3>B · 记忆管理</h3>
      <h4 className="config-group-heading">记忆配置</h4>
      <Accordion title="① 读取配置" note="设置回答时如何查找和使用记忆。">
        <Field
          label="记忆读取功能使用的 LLM 配置"
          info="可跟随当前对话模型，也可选择 LM Studio 当前可使用的其他模型。"
        >
          <ModelSelect
            value={draft.memory_retrieval_model_name}
            models={models}
            onChange={(value) => patch({ memory_retrieval_model_name: value })}
          />
        </Field>
        <Field label="相关性判断规则" info="告诉模型如何判断一条记忆是否与当前问题相关。">
          <textarea
            rows={5}
            value={draft.memory_retrieval_prompt}
            onChange={(event) => patch({ memory_retrieval_prompt: event.target.value })}
          />
        </Field>
        <Field
          label="默认读取强度"
          info="关闭：不读取；保守/标准/宽泛：按下方预设筛选；全目录：分批检查全部目录；全部正文：在预算允许时注入全部正文。"
        >
          <select
            value={p5.retrieval_mode}
            onChange={(event) => patchP5({ retrieval_mode: event.target.value as RetrievalMode })}
          >
            {MODE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <p className="hint">
          每档依次设置：候选目录数（先交给模型筛选的目录条数）、最终记忆数（筛选后注入正文的条数）、正文预算（这些正文合计最多占用的
          token）和相关性要求。
        </p>
        {(["conservative", "standard", "broad"] as const).map((key, index) => {
          const preset = p5.retrieval_presets[key];
          return (
            <Accordion
              key={key}
              title={`${["①", "②", "③"][index]} ${key === "conservative" ? "保守" : key === "standard" ? "标准" : "宽泛"}预设`}
            >
              <div className="field-grid">
                <Field label="候选目录数">
                  <NumberField
                    min={1}
                    max={10000}
                    value={preset.candidate_limit}
                    onChange={(value) =>
                      patchP5({
                        retrieval_presets: {
                          ...p5.retrieval_presets,
                          [key]: { ...preset, candidate_limit: value },
                        },
                      })
                    }
                  />
                </Field>
                <Field label="最终记忆数">
                  <NumberField
                    min={1}
                    max={10000}
                    value={preset.max_entries}
                    onChange={(value) =>
                      patchP5({
                        retrieval_presets: {
                          ...p5.retrieval_presets,
                          [key]: { ...preset, max_entries: value },
                        },
                      })
                    }
                  />
                </Field>
                <Field label="正文预算（token）">
                  <NumberField
                    min={1}
                    max={1048576}
                    value={preset.max_tokens}
                    onChange={(value) =>
                      patchP5({
                        retrieval_presets: {
                          ...p5.retrieval_presets,
                          [key]: { ...preset, max_tokens: value },
                        },
                      })
                    }
                  />
                </Field>
              </div>
              <Field label="相关性要求">
                <input
                  value={preset.relevance_instruction}
                  onChange={(event) =>
                    patchP5({
                      retrieval_presets: {
                        ...p5.retrieval_presets,
                        [key]: {
                          ...preset,
                          relevance_instruction: event.target.value,
                        },
                      },
                    })
                  }
                />
              </Field>
            </Accordion>
          );
        })}
      </Accordion>
      <Accordion title="② 整理配置" note="设置生成记忆使用的模型与规则。">
        <Field
          label="记忆整理功能使用的 LLM 配置"
          info="负责把选中的完整对话轮次提炼为结构化长期记忆；也可选择其他可用模型。"
        >
          <ModelSelect
            value={draft.memory_consolidation_model_name}
            models={models}
            onChange={(value) => patch({ memory_consolidation_model_name: value })}
          />
        </Field>
        <Field
          label="整理规则"
          info="定义哪些信息值得长期保留，以及如何生成名称、简介、标签和正文。"
        >
          <textarea
            rows={5}
            value={draft.memory_consolidation_prompt}
            onChange={(event) => patch({ memory_consolidation_prompt: event.target.value })}
          />
        </Field>
        <Field label="补充整理要求（可留空）" info="只填写当前 Agent 特有的额外要求。">
          <textarea
            rows={4}
            value={draft.memory_consolidation_additional_instructions}
            onChange={(event) =>
              patch({
                memory_consolidation_additional_instructions: event.target.value,
              })
            }
          />
        </Field>
      </Accordion>
      <p className="hint">读取与整理配置修改后，点击底部“保存当前分区配置”。</p>
      <h4 className="config-group-heading separated">记忆管理</h4>
      <Accordion title="① 自动整理" note="按完整对话轮数自动整理；选项修改后立即保存。">
        <label className="check">
          <input
            type="checkbox"
            disabled={!policy}
            checked={policy?.auto_enabled ?? false}
            onChange={(event) =>
              policy &&
              void updatePolicy({
                auto_enabled: event.target.checked,
                every_turns: policy.every_turns,
                target_chars: policy.target_chars,
              })
            }
          />
          <span>
            <strong>启用自动整理</strong>
            <small>
              每隔指定完整轮数整理一次；以下字段改动后立即保存，不需要再点底部的保存按钮。
            </small>
          </span>
        </label>
        <div className="field-grid two">
          <Field label="触发间隔（完整轮数）" info="范围 1—200，默认每 20 轮。">
            <NumberField
              min={1}
              max={200}
              disabled={!policy}
              value={policy?.every_turns ?? 20}
              onChange={(value) =>
                policy &&
                void updatePolicy({
                  auto_enabled: policy.auto_enabled,
                  every_turns: value,
                  target_chars: policy.target_chars,
                })
              }
            />
          </Field>
          <Field label="单条记忆正文长度（字符）" info="范围 50—4000，控制整理结果正文长度。">
            <NumberField
              min={50}
              max={4000}
              disabled={!policy}
              value={policy?.target_chars ?? 300}
              onChange={(value) =>
                policy &&
                void updatePolicy({
                  auto_enabled: policy.auto_enabled,
                  every_turns: policy.every_turns,
                  target_chars: value,
                })
              }
            />
          </Field>
        </div>
      </Accordion>
      <Accordion title="② 手动整理" note="从某个会话里挑出完整轮次，手动整理成长期记忆。">
        <p className="hint">
          记忆统一归属于当前助手，它可以在任意会话中随时调取。已整理过的轮次可以重新选择再次整理，这不会重置自动整理进度。
        </p>
        <Field label="第 1 步：来源会话">
          <select
            value={sourceSessionId}
            onChange={(event) => {
              setSourceSessionId(event.target.value);
              setSelectedTurns([]);
              useSuperstringStore.setState({ memoryTurns: [] });
            }}
          >
            <option value="">请选择会话</option>
            {memorySessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
        </Field>
        <div className="field-grid two">
          <Field label="第 2 步：查看最近多少轮">
            <NumberField min={1} max={200} value={recentTurnCount} onChange={setRecentTurnCount} />
          </Field>
          <button
            type="button"
            className="align-field"
            onClick={() =>
              sourceSessionId
                ? void loadMemoryTurns(sourceSessionId, recentTurnCount)
                : useSuperstringStore.setState({ feedback: "请选择会话" })
            }
          >
            加载可选择的轮次
          </button>
        </div>
        <fieldset className="choice-group">
          <legend>第 3 步：勾选需要整理的完整轮次</legend>
          {memoryTurns.map((turn) => (
            <label key={turn.id} className="memory-row">
              <input
                type="checkbox"
                checked={selectedTurns.includes(turn.id)}
                onChange={(event) =>
                  setSelectedTurns((items) =>
                    event.target.checked
                      ? [...items, turn.id]
                      : items.filter((id) => id !== turn.id),
                  )
                }
              />
              <span>
                序号 {turn.sequence_no} · {turn.processed ? "已整理" : "未整理"} · 用户：
                {turn.user.slice(0, 100)} / 回复：
                {turn.assistant.slice(0, 100)}
              </span>
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className="primary"
          onClick={() =>
            sourceSessionId && selectedTurns.length
              ? void manualConsolidate(sourceSessionId, selectedTurns)
              : useSuperstringStore.setState({ feedback: "请选择会话并勾选轮次" })
          }
        >
          第 4 步：开始整理所选轮次
        </button>
      </Accordion>
      <Accordion title="③ 记忆列表与治理" note="查看、整合、屏蔽、启用或永久删除已生成的记忆。">
        <div className="field-grid two">
          <Field label="列表页码" info="每页最多 100 条。">
            <NumberField min={1} value={page} onChange={setPage} />
          </Field>
          <button
            type="button"
            className="align-field"
            onClick={() => {
              resetMemorySelection();
              void loadMemoryPage(page);
            }}
          >
            加载记忆列表
          </button>
        </div>
        <fieldset className="choice-group">
          <legend>勾选需要查看或治理的记忆</legend>
          {memoryEntries.map((entry) => (
            <label key={entry.id} className="memory-row">
              <input
                type="checkbox"
                checked={selectedMemories.includes(entry.id)}
                onChange={(event) => {
                  setSelectedMemories((items) =>
                    event.target.checked
                      ? [...items, entry.id]
                      : items.filter((id) => id !== entry.id),
                  );
                  setPurgeConfirmed(false);
                  useSuperstringStore.setState({ memoryEntryDetail: null });
                }}
              />
              <span>
                {statusLabel[entry.status]} · {localTime(entry.created_at)} · {entry.name} —{" "}
                {entry.summary}
              </span>
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          onClick={() =>
            selectedMemories.length
              ? void loadMemoryEntryDetail(selectedMemories[0])
              : useSuperstringStore.setState({ feedback: "请选择记忆" })
          }
        >
          查看第一条已选记忆的详情
        </button>
        <Field label="记忆详情（只读）">
          <textarea rows={10} readOnly value={detailText} />
        </Field>
        <h4>常用治理操作</h4>
        <div className="memory-toolbar">
          <button type="button" onClick={() => void merge()}>
            整合为新记忆
          </button>
          <button type="button" onClick={() => void govern("suppress")}>
            屏蔽（停止使用）
          </button>
          <button type="button" onClick={() => void govern("enable")}>
            重新启用
          </button>
        </div>
        <p className="danger-note">
          <strong>危险操作：</strong>
          永久删除只删除所选记忆条目且不可恢复；派生记忆、摘要和原聊天保留。
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={purgeConfirmed}
            onChange={(event) => setPurgeConfirmed(event.target.checked)}
          />
          <span>我确认永久删除当前勾选的记忆条目</span>
        </label>
        <button type="button" className="danger" onClick={() => void govern("purge")}>
          永久删除所选条目
        </button>
      </Accordion>
      <div className="memory-feedback">
        {feedback ||
          (editorAgentId === "__new__" ? "请先创建或选择一个 Agent，这里会显示它的记忆设置。" : "")}
      </div>
    </div>
  );
}

function SectionC({
  draft,
  patch,
  models,
}: {
  draft: AgentDraft;
  patch: (patch: Partial<AgentDraft>) => void;
  models: string[];
}) {
  const { capacityPreview, refreshCapacityPreview } = useSuperstringStore();
  const p5 = draft.p5_config;
  const actualContextLimitMatch = capacityPreview.match(/聊天：实际 (\d+)/);
  const actualContextLimit = actualContextLimitMatch
    ? Number(actualContextLimitMatch[1])
    : undefined;
  const update = (next: Partial<typeof p5>) => patch({ p5_config: { ...p5, ...next } });
  useEffect(() => {
    // Entering C (or changing any of the three models) must re-probe the real
    // loaded capacity, because the source refreshes its controls on every model
    // change (gradio_app.py:2369-2381) and the custom-budget input is bounded by
    // the probe result. The effect depends on the model names rather than the
    // whole draft so that typing in an unrelated field does not re-probe, and it
    // hands them to the store explicitly so the probe cannot drift from the
    // draft being edited.
    void refreshCapacityPreview([
      draft.model_name,
      draft.memory_retrieval_model_name,
      draft.context_compression_model_name,
    ]);
  }, [
    draft.model_name,
    draft.memory_retrieval_model_name,
    draft.context_compression_model_name,
    refreshCapacityPreview,
  ]);
  return (
    <div className="config-section">
      <h3>C · 上下文</h3>
      <p>默认跟随模型加载容量。保存后从下一轮生效，重试沿用原轮预算。</p>
      <Accordion title="① 模型与预算" note="设置摘要模型、上下文容量与回复预留。">
        <Field
          label="上下文摘要与压缩功能使用的 LLM 配置"
          info="可跟随当前对话模型，也可选择其他可用模型；不会自动加载或重载模型。"
        >
          <ModelSelect
            value={draft.context_compression_model_name}
            models={models}
            onChange={(value) => patch({ context_compression_model_name: value })}
          />
        </Field>
        <Field label="聊天上下文预算">
          <select
            value={p5.context_window === null ? "follow" : "custom"}
            onChange={(event) =>
              update({
                context_window: event.target.value === "follow" ? null : 32768,
              })
            }
          >
            <option value="follow">跟随模型实际容量（推荐）</option>
            <option value="custom">自定义预算</option>
          </select>
        </Field>
        <Field
          label={`自定义上下文预算（实际上限：${actualContextLimit ?? "未知"}）`}
          info="只有选择自定义预算时可编辑，且不能超过模型实际容量。"
        >
          <NumberField
            min={1024}
            max={actualContextLimit}
            value={p5.context_window ?? 32768}
            disabled={p5.context_window === null}
            onChange={(value) => update({ context_window: value })}
          />
        </Field>
        <div className="field-grid">
          <Field label="回复预留（token）">
            <NumberField
              min={1}
              value={p5.max_output_tokens}
              onChange={(value) => update({ max_output_tokens: value })}
            />
          </Field>
          <Field label="安全余量比例">
            <NumberField
              min={0}
              max={0.99}
              step={0.01}
              value={p5.safety_margin_ratio}
              onChange={(value) => update({ safety_margin_ratio: value })}
            />
          </Field>
        </div>
        <Field label="容量预览（只读）">
          <textarea rows={3} readOnly value={capacityPreview} />
        </Field>
        <button type="button" onClick={() => void refreshCapacityPreview()}>
          刷新容量预览
        </button>
      </Accordion>
      <Accordion title="② 压缩策略" note="达到触发比例后，将较早的完整轮次压缩为摘要。">
        <label className="check">
          <input
            type="checkbox"
            checked={p5.compression_enabled}
            onChange={(event) => update({ compression_enabled: event.target.checked })}
          />
          <span>
            <strong>启用上下文压缩</strong>
            <small>原消息仍保留，并记录摘要来源。</small>
          </span>
        </label>
        <div className="field-grid">
          <Field label="压缩触发比例">
            <NumberField
              min={0.01}
              max={1}
              step={0.01}
              value={p5.compression_trigger_ratio}
              onChange={(value) => update({ compression_trigger_ratio: value })}
            />
          </Field>
          <Field label="近期原文目标（轮）">
            <NumberField
              min={1}
              value={p5.recent_turns}
              onChange={(value) => update({ recent_turns: value })}
            />
          </Field>
        </div>
        <h4>摘要与原文回查</h4>
        <div className="field-grid">
          <Field label="摘要目标（token）">
            <NumberField
              min={1}
              value={p5.summary_target_tokens}
              onChange={(value) => update({ summary_target_tokens: value })}
            />
          </Field>
          <Field label="摘要硬上限（token）">
            <NumberField
              min={1}
              value={p5.summary_max_tokens}
              onChange={(value) => update({ summary_max_tokens: value })}
            />
          </Field>
          <Field label="单次原文回查（token）">
            <NumberField
              min={1}
              value={p5.recall_max_tokens}
              onChange={(value) => update({ recall_max_tokens: value })}
            />
          </Field>
        </div>
      </Accordion>
      <Accordion title="③ 高级设置" note="只有全目录检索过慢或辅助任务超时时再调整。">
        <div className="field-grid">
          <Field label="辅助任务超时（秒）">
            <NumberField
              min={0.1}
              max={3600}
              value={p5.auxiliary_timeout_seconds}
              onChange={(value) => update({ auxiliary_timeout_seconds: value })}
            />
          </Field>
          <Field label="全目录最大批数">
            <NumberField
              min={1}
              value={p5.max_catalog_batches}
              onChange={(value) => update({ max_catalog_batches: value })}
            />
          </Field>
          <Field label="每批目录条数">
            <NumberField
              min={1}
              value={p5.catalog_batch_size}
              onChange={(value) => update({ catalog_batch_size: value })}
            />
          </Field>
        </div>
      </Accordion>
      <p className="hint">预算采用保守估算；摘要是有损压缩，但会保留原文来源。</p>
    </div>
  );
}

function SectionD({ draft }: { draft: AgentDraft }) {
  const { persona, patchPersona, saveCurrentSection } = useSuperstringStore();
  const editablePersona =
    persona ??
    ({
      id: "",
      agent_id: "",
      core_identity: "",
      communication_style: "",
      interaction_boundaries: "",
      example_dialogues: "",
      advanced_instructions: "",
      created_at: "",
      updated_at: "",
    } satisfies PersonaResponse);
  const field = (key: keyof PersonaResponse) => String(editablePersona[key] ?? "");
  const updatePersona = (patch: Partial<PersonaResponse>) => {
    patchPersona(patch);
  };
  return (
    <div className="config-section">
      <h3>D · 性格与人设</h3>
      <p>留空字段不写入提示词。保存后覆盖原内容，不产生版本号。</p>
      <Accordion title="① 人设（身份与边界）" note="决定 Agent 是谁、不能做什么，优先级最高。" open>
        <Field
          label="核心身份"
          info="这个 Agent 是谁、扮演什么角色、服务什么目标。建议 100—400 字。"
        >
          <textarea
            rows={5}
            value={field("core_identity")}
            onChange={(event) => updatePersona({ core_identity: event.target.value })}
            placeholder="例如：你是「小助」，一位长期陪伴用户的本地中文助理，说话直接、不绕弯子。"
          />
        </Field>
        <Field label="互动边界" info="明确不能做的事、必须拒绝的请求、以及遇到边界时怎么回应。">
          <textarea
            rows={5}
            value={field("interaction_boundaries")}
            onChange={(event) => updatePersona({ interaction_boundaries: event.target.value })}
          />
        </Field>
        <Field label="高级指令" info="对全部行为都生效的补充规则。">
          <textarea
            rows={5}
            value={field("advanced_instructions")}
            onChange={(event) => updatePersona({ advanced_instructions: event.target.value })}
          />
        </Field>
      </Accordion>
      <Accordion title="② 性格（表达风格）" note="只影响怎么说，不改变身份与边界。" open>
        <Field label="沟通风格" info="语气、节奏、用词习惯、称呼方式。">
          <textarea
            rows={4}
            value={field("communication_style")}
            onChange={(event) => updatePersona({ communication_style: event.target.value })}
          />
        </Field>
        <Field label="示例对话" info="示范语气与节奏；系统禁止复用样例里的人名、事实和话题。">
          <textarea
            rows={6}
            value={field("example_dialogues")}
            onChange={(event) => updatePersona({ example_dialogues: event.target.value })}
          />
        </Field>
        <Field
          label="性格强度"
          info="0 = 完全不注入性格；100 = 完整注入。人设与边界不受此开关影响。"
        >
          <div className="range-row">
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={draft.persona_intensity}
              onChange={(event) =>
                useSuperstringStore
                  .getState()
                  .patchDraft({ persona_intensity: Number(event.target.value) })
              }
            />
            <output>{draft.persona_intensity}</output>
          </div>
        </Field>
      </Accordion>
      <button
        type="button"
        className="primary internal-save"
        onClick={() => void saveCurrentSection()}
      >
        保存当前分区配置
      </button>
    </div>
  );
}

function UnavailableSection({ section }: { section: "E" | "F" | "G" | "H" }) {
  const text =
    section === "E"
      ? ["情绪", "当前无需设置。"]
      : section === "F"
        ? ["外部软件接入", "外部软件接入暂不可用；现有本地聊天不受影响。"]
        : section === "G"
          ? ["用户画像", "用户画像暂未开放，当前无需设置。"]
          : ["其他", "这里将收纳其他助手设置，当前无需操作。"];
  return (
    <div className="config-section unavailable-section">
      <h3>
        {section} · {text[0]}
      </h3>
      <p>{text[1]}</p>
      <button type="button" disabled>
        暂未开放
      </button>
    </div>
  );
}

function NavigationConfirm() {
  const {
    navigationConfirmMessage,
    confirmSaveAndContinue,
    confirmDiscardAndContinue,
    cancelPendingNavigation,
  } = useSuperstringStore();
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        className="confirm-dialog navigation-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="navigation-confirm-title"
      >
        <strong id="navigation-confirm-title">当前分区有未保存修改</strong>
        <p>{navigationConfirmMessage}</p>
        <p>保存成功后继续；放弃将恢复已保存内容；取消保留当前草稿。</p>
        <div className="dialog-actions three">
          <button type="button" onClick={() => void confirmSaveAndContinue()}>
            保存并继续
          </button>
          <button type="button" className="danger" onClick={() => void confirmDiscardAndContinue()}>
            放弃修改并继续
          </button>
          <button type="button" onClick={cancelPendingNavigation}>
            取消离开
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentSettings() {
  const {
    agents,
    editorAgentId,
    editorDraft,
    activeSection,
    detailOpen,
    modelNames,
    selectedNewSessionAgentId,
    setNewSessionAgent,
    navigationConfirmOpen,
    feedback,
    error,
    closeAgentSettings,
    requestAgentNavigation,
    requestSectionNavigation,
    setDetailOpen,
    patchDraft,
    saveCurrentSection,
    deleteEditorAgent,
    deleteAgents,
  } = useSuperstringStore();
  const [selectedBatchAgents, setSelectedBatchAgents] = useState<string[]>([]);
  const [confirmSingleDelete, setConfirmSingleDelete] = useState(false);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const activeAgents = agents.filter((agent) => agent.is_active);
  const section = SECTION_META.find((item) => item.key === activeSection) ?? SECTION_META[0];
  const editorAgent = agents.find((agent) => agent.id === editorAgentId);
  const hasDraft = editorDraft !== null;
  const creating = editorAgentId === "__new__" && hasDraft;
  const editorAgentLabel = creating ? "新建助手" : (editorAgent?.name ?? "选择助手");
  const selectorRef = useRef<HTMLDetailsElement>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (editorAgentId && hasDraft && selectorRef.current) selectorRef.current.open = false;
  }, [editorAgentId, hasDraft]);
  const chooseAgent = (id: string) => {
    if (id === editorAgentId && editorDraft && selectorRef.current)
      selectorRef.current.open = false;
    requestAgentNavigation(id);
  };
  const content = !editorDraft ? (
    <p className="empty-panel">请选择已有助手，或点击“新建助手”。</p>
  ) : activeSection === "A" ? (
    <SectionA draft={editorDraft} patch={patchDraft} models={modelNames} />
  ) : activeSection === "B" ? (
    <SectionB draft={editorDraft} patch={patchDraft} models={modelNames} />
  ) : activeSection === "C" ? (
    <SectionC draft={editorDraft} patch={patchDraft} models={modelNames} />
  ) : activeSection === "D" ? (
    <SectionD draft={editorDraft} />
  ) : (
    <UnavailableSection section={activeSection as "E" | "F" | "G" | "H"} />
  );
  return (
    <section className="page settings-page">
      <SettingsHeader onBack={closeAgentSettings} />
      <div className="agent-settings">
        <div className="agent-settings-heading">
          <h2>助手设置</h2>
          <button
            type="button"
            className="new-agent-button"
            disabled={creating || saving}
            onClick={() => chooseAgent("__new__")}
          >
            <Icon name="plus" />
            新建助手
          </button>
        </div>
        <p className="settings-note">
          各分区独立保存。新一轮使用已保存配置，失败重试沿用原轮配置。
        </p>
        <details className="agent-selector" ref={selectorRef}>
          <summary>
            <Icon name="agent" />
            <span className="selector-identity">
              <strong>{editorAgentLabel}</strong>
              <small>{creating ? "正在创建 · 未保存" : "当前助手"}</small>
            </span>
            <Chevron />
          </summary>
          <div className="agent-editor-list">
            {agents.length === 0 && <p className="hint">还没有助手，完成下方基础配置即可创建。</p>}
            {agents.map((agent) => (
              <button
                type="button"
                key={agent.id}
                className={editorAgentId === agent.id ? "active" : ""}
                aria-pressed={editorAgentId === agent.id}
                aria-controls="superstring-agent-workspace"
                onClick={() => chooseAgent(agent.id)}
              >
                <span>
                  {agent.name}
                  {agent.is_active ? "" : "（停用）"}
                </span>
                <small>{editorAgentId === agent.id ? "当前" : "选择"}</small>
              </button>
            ))}
          </div>
          <div className="selector-extra">
            {activeAgents.length === 0 ? (
              <p className="hint">当前没有启用的助手，新对话无法创建；请先启用或新建助手。</p>
            ) : (
              <Field
                label="新会话使用的助手"
                info="只影响之后新建的对话；已有对话仍使用创建时绑定的助手。"
              >
                <select
                  aria-label="新会话使用的助手"
                  value={selectedNewSessionAgentId ?? ""}
                  onChange={(event) => setNewSessionAgent(event.target.value || null)}
                >
                  {activeAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          {editorAgentId !== "__new__" && (
            <button
              type="button"
              className="danger delete-agent"
              onClick={() => setConfirmSingleDelete(true)}
            >
              删除当前 Agent
            </button>
          )}
        </details>
        <details
          className="detail-config"
          open={detailOpen}
          onToggle={(event) => setDetailOpen(event.currentTarget.open)}
        >
          <summary className="icon-summary">
            <Icon name="sliders" />
            <span className="settings-summary">
              <strong>详细配置</strong>
              <small>模型、记忆、上下文与性格人设</small>
            </span>
            <Chevron />
          </summary>
          <div className="detail-body" id="superstring-agent-workspace" aria-busy={saving}>
            {creating && (
              <p className="hint creation-note">
                填写名称并选择模型，点击“创建助手”。创建后可继续设置记忆、上下文与人设。
              </p>
            )}
            <details className="section-selector">
              <summary>
                <span className="section-selector-label">
                  <Icon
                    name={
                      activeSection === "A"
                        ? "agent"
                        : activeSection === "B"
                          ? "memory"
                          : activeSection === "C"
                            ? "context"
                            : activeSection === "D"
                              ? "persona"
                              : activeSection === "E"
                                ? "emotion"
                                : activeSection === "F"
                                  ? "plug"
                                  : activeSection === "G"
                                    ? "profile"
                                    : "more"
                    }
                  />
                  <span>
                    配置分区 · 当前：{activeSection} · {section.title}
                  </span>
                </span>
                <span className="section-selector-action">
                  <span className="section-selector-closed">展开 A—H</span>
                  <span className="section-selector-open">收起</span>
                  <Chevron />
                </span>
              </summary>
              <nav className="section-nav" aria-label="配置分区（A—H）">
                {SECTION_META.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={item.key === activeSection ? "active" : ""}
                    aria-pressed={item.key === activeSection}
                    disabled={creating && item.key !== "A"}
                    title={creating && item.key !== "A" ? "创建助手后可配置" : undefined}
                    onClick={() => requestSectionNavigation(item.key)}
                  >
                    <span className="section-row-head">
                      <Icon
                        name={
                          item.key === "A"
                            ? "agent"
                            : item.key === "B"
                              ? "memory"
                              : item.key === "C"
                                ? "context"
                                : item.key === "D"
                                  ? "persona"
                                  : item.key === "E"
                                    ? "emotion"
                                    : item.key === "F"
                                      ? "plug"
                                      : item.key === "G"
                                        ? "profile"
                                        : "more"
                        }
                      />
                      <strong>
                        {item.key} · {item.title}
                      </strong>
                    </span>
                    {item.note && <small>{item.note}</small>}
                  </button>
                ))}
              </nav>
            </details>
            <div className="section-content">{content}</div>
            {["A", "B", "C"].includes(activeSection) && (
              <button
                type="button"
                className="primary save-section"
                disabled={!editorDraft || saving}
                onClick={async () => {
                  if (saving) return;
                  setSaving(true);
                  try {
                    await saveCurrentSection();
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving
                  ? creating
                    ? "创建中…"
                    : "保存中…"
                  : creating
                    ? "创建助手"
                    : "保存当前分区配置"}
              </button>
            )}
          </div>
        </details>
        <Accordion title="批量管理" note="选择多个助手，批量删除。" icon="users">
          <p className="hint">选择多个 Agent 后可统一删除；不能删除的项目会保留并反馈原因。</p>
          <Field label="选择 Agent">
            <select
              multiple
              value={selectedBatchAgents}
              onChange={(event) =>
                setSelectedBatchAgents(
                  Array.from(event.currentTarget.selectedOptions, (option) => option.value),
                )
              }
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.is_active ? "" : "（停用）"}
                </option>
              ))}
            </select>
          </Field>
          <div className="memory-toolbar">
            <button
              type="button"
              onClick={() =>
                setSelectedBatchAgents((selected) => {
                  if (selected.length === agents.length) {
                    useSuperstringStore.setState({ feedback: "已取消全选" });
                    return [];
                  }
                  useSuperstringStore.setState({
                    feedback: `已选择 ${agents.length} 个 Agent`,
                  });
                  return agents.map((agent) => agent.id);
                })
              }
            >
              全选 / 取消全选
            </button>
            <button
              type="button"
              className="danger"
              onClick={() =>
                selectedBatchAgents.length
                  ? setConfirmBatchDelete(true)
                  : useSuperstringStore.setState({
                      feedback: "请至少选择一个 Agent。",
                    })
              }
            >
              删除所选
            </button>
          </div>
        </Accordion>
        {confirmSingleDelete && (
          <ConfirmDialog
            message="确认删除当前 Agent？已被历史会话使用或属于内置默认配置时不会删除。"
            confirmLabel="删除 Agent"
            onCancel={() => setConfirmSingleDelete(false)}
            onConfirm={() => {
              setConfirmSingleDelete(false);
              void deleteEditorAgent();
            }}
          />
        )}
        {confirmBatchDelete && (
          <ConfirmDialog
            message={`确认删除选中的 ${selectedBatchAgents.length} 个 Agent？已被历史会话使用或属于内置默认配置的项目会保留并反馈原因。`}
            confirmLabel="删除所选"
            onCancel={() => setConfirmBatchDelete(false)}
            onConfirm={() => {
              const ids = selectedBatchAgents;
              setConfirmBatchDelete(false);
              setSelectedBatchAgents([]);
              void deleteAgents(ids);
            }}
          />
        )}
        {navigationConfirmOpen && <NavigationConfirm />}
        {(feedback || error) && (
          <div className={error ? "status error" : "status"}>{error ?? feedback}</div>
        )}
      </div>
    </section>
  );
}

function App() {
  const { status, page, settingsView, bootstrap } = useSuperstringStore();
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
  if (status === "loading" || status === "idle")
    return (
      <div className="loading-page">
        <div className="loading-brand">
          <Icon name="brand" />
          <strong>superstring</strong>
        </div>
        <h1>正在加载本地工作空间</h1>
        <p>正在连接本地服务并读取会话与 Agent 配置…</p>
      </div>
    );
  return (
    <div id="superstring-shell">
      <Sidebar />
      <main className="main-area">
        {page === "chat" ? (
          <ChatPage />
        ) : settingsView === "hub" ? (
          <SettingsHub />
        ) : settingsView === "appearance" ? (
          <AppearanceSettings />
        ) : (
          <AgentSettings />
        )}
      </main>
    </div>
  );
}

export default App;
