import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";

import { chatBusy, currentChat } from "./conversation-state";

const COMPONENTS = [
  ["instructions", "指令与人设"],
  ["recent_history", "近期原文"],
  ["summaries", "压缩摘要"],
  ["long_term_memory", "长期记忆"],
  ["knowledge", "知识库资料"],
  ["current_question", "本轮问题"],
  ["protocol", "协议开销"],
] as const;

function UsageRing({ percent, large = false }: { percent: number | null; large?: boolean }) {
  return (
    <svg
      className={`usage-ring${large ? " usage-ring-large" : ""}`}
      viewBox="0 0 40 40"
      aria-hidden="true"
    >
      <circle className="usage-ring-track" cx="20" cy="20" r="16" fill="none" strokeWidth="4" />
      {percent !== null && (
        <circle
          className="usage-ring-value"
          cx="20"
          cy="20"
          r="16"
          fill="none"
          strokeWidth="4"
          pathLength="100"
          strokeDasharray={`${Math.min(100, Math.max(0, percent))} 100`}
          transform="rotate(-90 20 20)"
        />
      )}
      {percent === null && (
        <text x="20" y="25" textAnchor="middle" className="usage-ring-unknown">
          ?
        </text>
      )}
    </svg>
  );
}

export function ContextUsagePanel() {
  const t = useI18n();
  const usage = useSuperstringStore((s) => currentChat(s).contextUsage);
  const sessionId = useSuperstringStore((s) => s.currentSessionId);
  const sending = useSuperstringStore((s) => chatBusy(currentChat(s)));
  const composer = useSuperstringStore((s) => currentChat(s).composer);
  const [openedSession, setOpenedSession] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const visible = open && openedSession === sessionId;
  const current = usage?.session_id === sessionId ? usage : null;
  const percent = current ? (current.input_units / current.capacity) * 100 : null;
  const percentText = percent === null ? "—" : `${percent.toFixed(1)}%`;
  const draftUnits = new TextEncoder().encode(composer.trim()).length;
  const parts = current
    ? [
        ...COMPONENTS.map(([key, label]) => ({
          key,
          label,
          value: current.components[key],
        })),
        { key: "output", label: "回复预留", value: current.output_reserved },
        { key: "safety", label: "安全余量", value: current.safety_reserved },
        { key: "remaining", label: "剩余空间", value: current.remaining },
      ]
    : [];
  const status = current
    ? t("已用约 {0} / {1}", current.input_units.toLocaleString(), current.capacity.toLocaleString())
    : sending
      ? t("正在准备上下文")
      : t("尚无请求统计");
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  useEffect(() => {
    if (!visible) return;
    closeRef.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [visible]);
  // Closing on a chat change prevents an old open state from reappearing on return.
  useEffect(() => {
    if (openedSession !== sessionId) setOpen(false);
  }, [openedSession, sessionId]);

  return (
    <div className="context-usage" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="context-usage-trigger"
        aria-label={t("上下文用量")}
        aria-haspopup="dialog"
        aria-expanded={visible}
        aria-controls={visible ? id : undefined}
        title={`${t("上下文用量")} · ${percentText} · ${status}`}
        onClick={() => {
          setOpenedSession(sessionId);
          setOpen(!visible);
        }}
      >
        <UsageRing percent={percent} />
        <span className="context-trigger-percent">{percentText}</span>
      </button>
      {visible && (
        <section
          id={id}
          role="dialog"
          aria-label={t("上下文用量")}
          className="context-usage-popover"
        >
          <div className="context-usage-heading">
            <h2>{t("上下文用量")}</h2>
            <button
              ref={closeRef}
              type="button"
              className="icon-button"
              aria-label={t("关闭上下文用量")}
              onClick={close}
            >
              <svg
                className="icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <div className="context-usage-summary">
            <UsageRing percent={percent} large />
            <div>
              <strong className="context-usage-percent">{percentText}</strong>
              <p>{status}</p>
              <small>{t("最近请求的输入占用")}</small>
            </div>
          </div>
          {current ? (
            <>
              <div
                className="context-usage-bar"
                role="img"
                aria-label={parts.map((p) => `${t(p.label)}: ${p.value}`).join("; ")}
              >
                {parts.map((part, index) => (
                  <span
                    key={part.key}
                    className={`context-part context-part-${index}`}
                    style={{
                      width: `${(part.value / current.capacity) * 100}%`,
                    }}
                    title={`${t(part.label)}: ${part.value}`}
                  />
                ))}
              </div>
              <ul className="context-usage-legend">
                {parts.map((part, index) => (
                  <li key={part.key} className={index === 7 ? "context-reserved-start" : undefined}>
                    <i className={`context-part context-part-${index}`} aria-hidden="true" />
                    <span>{t(part.label)}</span>
                    <b>{part.value.toLocaleString()}</b>
                    <small>{((part.value / current.capacity) * 100).toFixed(1)}%</small>
                  </li>
                ))}
              </ul>
              <p className="hint">{t("预留不计入已用输入；百分比以模型总容量为基准。")}</p>
              <p className="hint">
                {t("最近请求模型：{0}；不含本轮回复与待发送草稿。", current.model)}
              </p>
            </>
          ) : (
            <p className="hint">{t("发送后显示请求用量；未统计项为未知，不记为零。")}</p>
          )}
          <p className="hint">{t("按 UTF-8 字节和消息开销估算，非模型精确 token 数。")}</p>
          {draftUnits > 0 && (
            <p className="hint context-draft">
              {t("待发送草稿约 {0}，不计入上方请求。", draftUnits)}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
