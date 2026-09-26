import { useEffect, useRef, useState } from "react";
import { ContextRing } from "@/components/context-ring";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { Icon } from "../../ui/icons";
import { currentSessionId as selectedSessionId } from "../conversations/directory-state";

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

export function ContextUsagePanel() {
  const t = useI18n();
  const usage = useSuperstringStore((s) => currentChat(s).contextUsage);
  const sessionId = useSuperstringStore(selectedSessionId);
  const sending = useSuperstringStore((s) => chatBusy(currentChat(s)));
  const composer = useSuperstringStore((s) => currentChat(s).composer);
  const [openedSession, setOpenedSession] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
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
  // Closing on a chat change prevents an old open state from reappearing on return.
  useEffect(() => {
    if (openedSession !== sessionId) setOpen(false);
  }, [openedSession, sessionId]);

  return (
    <Popover
      open={visible}
      onOpenChange={(next) => {
        setOpenedSession(sessionId);
        setOpen(next);
      }}
    >
      <div className="context-usage">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="context-usage-trigger"
            aria-label={t("上下文用量")}
            title={`${t("上下文用量")} · ${percentText} · ${status}`}
          >
            <ContextRing percent={percent} />
            <span className="context-trigger-percent font-mono text-xs">{percentText}</span>
          </Button>
        </PopoverTrigger>

        <PopoverContent
          aria-label={t("上下文用量")}
          className="context-usage-popover w-[min(24rem,calc(100vw-2rem))] max-h-[min(80svh,38rem)] overflow-auto p-4"
          align="end"
          side="top"
          sideOffset={12}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            closeRef.current?.focus();
          }}
        >
          <div className="context-usage-heading flex items-center justify-between gap-3 font-medium">
            <h2>{t("上下文用量")}</h2>

            <Button
              variant="ghost"
              size="sm"
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              className="size-7 p-0"
              aria-label={t("关闭上下文用量")}
            >
              <Icon name="close" />
            </Button>
          </div>
          <div className="context-usage-summary rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
            <div>
              <strong className="context-usage-percent text-2xl font-semibold tabular-nums text-foreground">
                {percentText}
              </strong>
              <p>{status}</p>
              <small>{t("最近请求的输入占用")}</small>
            </div>
          </div>
          {current ? (
            <>
              <Progress
                className="context-usage-bar h-2"
                value={Math.min(100, Math.max(0, percent ?? 0))}
                aria-label={t("上下文用量")}
              />
              <ul className="context-usage-legend space-y-2 text-xs">
                {parts.map((part, index) => (
                  <li
                    key={part.key}
                    className={`grid grid-cols-[1fr_auto_3.5rem] items-center gap-2 ${index === 7 ? "context-reserved-start border-t pt-2" : ""}`}
                  >
                    <span>{t(part.label)}</span>
                    <b className="font-mono font-medium tabular-nums">
                      {part.value.toLocaleString()}
                    </b>
                    <small className="text-right font-mono tabular-nums text-muted-foreground">
                      {((part.value / current.capacity) * 100).toFixed(1)}%
                    </small>
                  </li>
                ))}
              </ul>
              <p className="hint text-xs leading-relaxed text-muted-foreground">
                {t("预留不计入已用输入；百分比以模型总容量为基准。")}
              </p>
              <p className="hint text-xs leading-relaxed text-muted-foreground">
                {t("最近请求模型：{0}；不含本轮回复与待发送草稿。", current.model)}
              </p>
            </>
          ) : (
            <p className="hint text-xs leading-relaxed text-muted-foreground">
              {t("发送后显示请求用量；未统计项为未知，不记为零。")}
            </p>
          )}
          <p className="hint text-xs leading-relaxed text-muted-foreground">
            {t("按 UTF-8 字节和消息开销估算，非模型精确 token 数。")}
          </p>
          {draftUnits > 0 && (
            <p className="hint context-draft border-t pt-2 text-xs text-muted-foreground">
              {t("待发送草稿约 {0}，不计入上方请求。", draftUnits)}
            </p>
          )}
        </PopoverContent>
      </div>
    </Popover>
  );
}
