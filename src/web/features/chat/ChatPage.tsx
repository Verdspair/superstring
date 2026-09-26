import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Textarea } from "@/components/ui/textarea";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Icon } from "../../ui/icons";
import { ProcessingStatus } from "../../ui/ProcessingStatus";
import { ConversationHeader } from "../conversations/ConversationHeader";
import {
  selectedConversation,
  currentSessionId as selectedSessionId,
} from "../conversations/directory-state";
import { RunLink } from "../runs/RunInspector";
import { ChatMessage } from "./ChatMessage";
import { ContextUsagePanel } from "./ContextUsagePanel";
import { chatBusy, currentChat } from "./conversation-state";

export function ChatPage() {
  const t = useI18n();
  const current = useSuperstringStore(selectedConversation);
  const currentSessionId = useSuperstringStore(selectedSessionId);
  const canonicalId = useSuperstringStore((state) => state.currentConversationId);
  const resolving = !!currentSessionId && !canonicalId;
  const chat = useSuperstringStore(currentChat);
  const {
    messages,
    runtimeConfig,
    runtimeConfigUnavailable,
    composer,
    failedChat,
    knowledgeResend,
  } = chat;
  const sending = chatBusy(chat);
  const reconcile = useSuperstringStore((state) => state.reconcileChat);
  const pendingOperations = useSuperstringStore((state) => state.pendingOperations);
  const error = useSuperstringStore((state) => currentChat(state).error ?? state.error);
  const feedback = useSuperstringStore((state) => currentChat(state).feedback || state.feedback);
  const setComposer = useSuperstringStore((state) => state.setComposer);
  const send = useSuperstringStore((state) => state.send);
  const retryChat = useSuperstringStore((state) => state.retryChat);
  const resendKnowledgeChat = useSuperstringStore((state) => state.resendKnowledgeChat);
  const cancelKnowledgeResend = useSuperstringStore((state) => state.cancelKnowledgeResend);
  const deleteMessageAction = useSuperstringStore((state) => state.deleteMessage);
  const modeLabel =
    runtimeConfig?.mode === "chat"
      ? t("聊天")
      : runtimeConfig?.mode === "work"
        ? t("工作")
        : runtimeConfig?.mode
          ? t("未知模式（{0}）", runtimeConfig.mode)
          : t("未知模式");
  const headingText = !current ? t("当前对话 · 请新建会话") : current.title;
  const [deleteMessageId, setDeleteMessageId] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A confirmation belongs to the selected conversation only.
  useEffect(() => {
    setDeleteMessageId(null);
  }, [currentSessionId]);

  const deleteMessage = (id: string) => deleteMessageAction(currentSessionId, id);
  return (
    <section className="page chat-page flex h-full min-h-0 flex-col">
      <ConversationHeader
        className="chat-header"
        title={headingText}
        detail={
          current ? (
            runtimeConfigUnavailable ? (
              t("会话信息暂不可用")
            ) : (
              <>
                {t("Web · 私聊")} · {runtimeConfig?.name ?? "Agent"} · {modeLabel}
              </>
            )
          ) : (
            t("本地工作空间")
          )
        }
        actions={chat.runId && <RunLink runId={chat.runId} />}
      />
      <div className="chat-content min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 md:px-6">
        {messages.length === 0 ? (
          <Empty className="empty-chat h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="chat" />
              </EmptyMedia>
              <EmptyTitle>
                <h2>{current ? t("开始对话") : t("开始一段对话")}</h2>
              </EmptyTitle>
              <EmptyDescription>
                {current
                  ? t("在下方输入消息，开始与助手交流。")
                  : t("点击“新建任务”，开启与助手的对话。")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="messages mx-auto flex w-full max-w-3xl flex-col gap-6">
            {messages
              .filter((message) => message.role !== "system")
              .map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  onDelete={() => setDeleteMessageId(message.id)}
                />
              ))}
          </div>
        )}
      </div>
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
      <div className="composer-region shrink-0 px-4 pb-4 md:px-6">
        <div className="composer-wrap mx-auto w-full max-w-3xl rounded-xl border bg-background p-3 shadow-sm">
          {(error || feedback) && (
            <div
              role={error ? "alert" : "status"}
              className={`status mb-3 text-sm ${error ? "error text-destructive" : "text-muted-foreground"}`}
            >
              {translateNotice(error ?? feedback)}
            </div>
          )}
          {chat.phase === "reconciling" && (
            <Button variant="outline" type="button" onClick={() => void reconcile()}>
              {t("核对服务端结果")}
            </Button>
          )}
          <Textarea
            className="min-h-20 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
            aria-label={t("输入消息…")}
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={t("输入消息…")}
            rows={2}
            disabled={sending || resolving}
          />
          <div className="composer-actions mt-2 flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto hidden text-[11px] text-muted-foreground sm:block">
              {t("Enter 发送 · Shift + Enter 换行")}
            </span>
            <ContextUsagePanel />
            {failedChat?.sessionId === currentSessionId && (
              <Button
                variant="outline"
                type="button"
                disabled={sending || resolving}
                onClick={() => void retryChat()}
              >
                {t("重试原请求")}
              </Button>
            )}
            <Button
              type="button"
              aria-label={sending ? t("生成中") : t("发送")}
              disabled={sending || resolving}
              onClick={() => void send()}
            >
              <Icon name={sending ? "clock" : "send"} />
              {sending ? t("生成中") : t("发送")}
            </Button>
          </div>
        </div>
      </div>
      <ProcessingStatus active={sending || pendingOperations > 0} />
    </section>
  );
}
