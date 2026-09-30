import { ArrowRight, MessageCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components/confirmation";
import { Button } from "../../components/ui/button";
import { BrandLogo } from "../../design-system/BrandLogo";
import { currentChat } from "../../features/chat/conversation-state";
import {
  currentSessionId,
  selectedConversation,
} from "../../features/conversations/directory-state";
import { useSuperstringStore } from "../../store";
import { openSpace } from "../../workspace/navigation";
import { RunLink } from "../runs/RunEntry";
import { ChatComposer } from "./ChatComposer";
import { ChatTranscript } from "./ChatTranscript";
import { ConversationIdentity } from "./ConversationIdentity";
import { CreateConversation } from "./CreateConversation";

export function DirectConversation({ active = true }: { active?: boolean }) {
  const { t } = useTranslation();
  const conversation = useSuperstringStore(selectedConversation);
  const session = useSuperstringStore(currentSessionId);
  const chat = useSuperstringStore(currentChat);
  const [deletion, setDeletion] = useState<{ session: string | null; message: string } | null>(
    null,
  );
  const remove = useSuperstringStore((s) => s.deleteMessage);
  const resend = useSuperstringStore((s) => s.resendKnowledgeChat);
  const cancelResend = useSuperstringStore((s) => s.cancelKnowledgeResend);
  const visibleDeletion = deletion?.session === session ? deletion : null;
  useEffect(() => {
    if (deletion && deletion.session !== session) setDeletion(null);
  }, [deletion, session]);
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      aria-label={t("workspace.current_conversation")}
    >
      {/* 消息页签隐藏时身份栏不参与渲染；消息正文保持挂载以保住草稿、滚动位置与在途发送。 */}
      {active && (
        <ConversationIdentity
          conversation={conversation}
          agentName={
            chat.runtimeConfigUnavailable
              ? t("workspace.chat_information_unavailable")
              : chat.runtimeConfig?.name
          }
          model={chat.runtimeConfig?.model_name}
          mode={chat.runtimeConfig?.mode}
          actions={chat.runId && <RunLink runId={chat.runId} />}
        />
      )}
      {chat.messages.some((item) => item.role !== "system") ? (
        <ChatTranscript
          session={session}
          messages={chat.messages}
          active={active}
          onDelete={(message) => setDeletion({ session, message })}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 py-10">
          <div className="w-full max-w-lg">
            <BrandLogo className="mb-7 size-16 text-primary" />
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              {t("brand.wordmark")}
            </p>
            <h2 className="text-3xl font-medium leading-tight tracking-tight md:text-4xl">
              {conversation
                ? t("workspace.begin_with_a_few_words")
                : t("workspace.every_connection_starts_with_a_conversation")}
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-7 text-muted-foreground">
              {conversation
                ? t("workspace.a_space_for_you_and_an_idea_a_question_or_simply_hello", {
                    "0": chat.runtimeConfig?.name ?? t("workspace.assistant"),
                  })
                : t(
                    "workspace.start_talking_with_an_assistant_or_follow_how_they_participate_in_your_c",
                  )}
            </p>
            {!conversation && (
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <CreateConversation>
                  <Button>
                    <MessageCircle />
                    {t("workspace.new_conversation")}
                  </Button>
                </CreateConversation>
                <Button variant="ghost" onClick={() => openSpace("assistants")}>
                  {t("workspace.meet_your_assistants")}
                  <ArrowRight />
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
      <ChatComposer />
      {/* 弹窗会挂到主文档之外，页签隐藏时先卸下，状态本身保留、返回消息页签再显示。 */}
      {active && visibleDeletion && (
        <ConfirmDialog
          message={t("workspace.delete_this_message")}
          confirmLabel={t("workspace.delete")}
          onCancel={() => setDeletion(null)}
          onConfirm={() => {
            setDeletion(null);
            void remove(visibleDeletion.session, visibleDeletion.message);
          }}
        />
      )}
      {active && chat.knowledgeResend?.sessionId === session && chat.knowledgeResend && (
        <ConfirmDialog
          message={t(
            "workspace.document_access_has_changed_the_earlier_request_cannot_be_retried_resend",
          )}
          confirmLabel={t("workspace.resend_with_current_access")}
          onCancel={cancelResend}
          onConfirm={() => void resend()}
        />
      )}
    </section>
  );
}
