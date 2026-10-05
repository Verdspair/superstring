import { useTranslation } from "react-i18next";
import { renderQqMessageFacts } from "../../../server/services/qq-message-renderer";
import type {
  QqIdentity,
  QqMessageFact,
  QqMessageFocus,
  QqMessageSettings,
} from "../../../shared/contracts/qq-message";

export const QQ_MESSAGE_PREVIEW_NOW_SECONDS = Date.parse("2026-10-01T16:00:00Z") / 1000;

const member = (qq: string, groupCard: string, personalNickname: string): QqIdentity => ({
  role: "member",
  qq,
  groupCard,
  personalNickname,
  legacyDisplayName: null,
  nameState: "known",
});

const assistant: QqIdentity = {
  role: "assistant",
  qq: "90001",
  groupCard: "助手",
  personalNickname: null,
  legacyDisplayName: null,
  nameState: "known",
};

const alin = member("10001", "阿林", "林某");
const zhou = member("10002", "小周", "周同学");

export const QQ_MESSAGE_PREVIEW_MESSAGES: readonly QqMessageFact[] = [
  {
    id: "preview-a-old",
    platformMessageId: "9001",
    seq: 1,
    occurredAtSeconds: QQ_MESSAGE_PREVIEW_NOW_SECONDS - 300,
    speaker: alin,
    parts: [{ kind: "text", text: "晚上有人吗" }],
    mentions: [],
    replyTo: null,
    sources: [],
    completeness: "full",
  },
  {
    id: "preview-a-new",
    platformMessageId: "9002",
    seq: 2,
    occurredAtSeconds: QQ_MESSAGE_PREVIEW_NOW_SECONDS - 60,
    speaker: alin,
    parts: [{ kind: "text", text: "刚回来" }],
    mentions: [],
    replyTo: null,
    sources: [],
    completeness: "full",
  },
  {
    id: "preview-b-old",
    platformMessageId: "9003",
    seq: 3,
    occurredAtSeconds: QQ_MESSAGE_PREVIEW_NOW_SECONDS - 240,
    speaker: zhou,
    parts: [{ kind: "text", text: "这个好" }],
    mentions: [],
    replyTo: { platformMessageId: "9001" },
    sources: [],
    completeness: "full",
  },
  {
    id: "preview-s-old",
    platformMessageId: "9004",
    seq: 4,
    occurredAtSeconds: QQ_MESSAGE_PREVIEW_NOW_SECONDS - 120,
    speaker: assistant,
    parts: [{ kind: "text", text: "我在" }],
    mentions: [],
    replyTo: null,
    sources: [],
    completeness: "full",
  },
  {
    id: "preview-s-new",
    platformMessageId: "9005",
    seq: 5,
    occurredAtSeconds: QQ_MESSAGE_PREVIEW_NOW_SECONDS - 15,
    speaker: assistant,
    parts: [{ kind: "text", text: "刚处理完图片" }],
    mentions: [],
    replyTo: null,
    sources: [],
    completeness: "full",
  },
  {
    id: "preview-b-new",
    platformMessageId: "9006",
    seq: 6,
    occurredAtSeconds: QQ_MESSAGE_PREVIEW_NOW_SECONDS - 30,
    speaker: zhou,
    parts: [
      { kind: "mention", qq: "10001" },
      { kind: "text", text: "@阿林 来看" },
    ],
    mentions: [{ qq: "10001", identity: alin }],
    replyTo: null,
    sources: [],
    completeness: "full",
  },
] as const;

export const QQ_MESSAGE_PREVIEW_FOCUS: Readonly<QqMessageFocus> = Object.freeze({
  triggerMessageIds: ["preview-a-new"],
  responseMessageIds: ["preview-a-old"],
  responseQqs: ["10001"],
  assistantQq: "90001",
});

export function renderQqMessagePreview(settings: QqMessageSettings): string {
  return renderQqMessageFacts({
    messages: QQ_MESSAGE_PREVIEW_MESSAGES,
    focus: QQ_MESSAGE_PREVIEW_FOCUS,
    settings,
    nowSeconds: QQ_MESSAGE_PREVIEW_NOW_SECONDS,
  });
}

export function QqMessagePreview({ settings }: { settings: QqMessageSettings | null }) {
  const { t } = useTranslation();
  return (
    <section
      className="min-w-0 space-y-2"
      data-qq-message-preview
      aria-label={t("schemes.studio.messagePreviewAriaLabel")}
    >
      <p className="text-xs font-medium">{t("schemes.studio.messagePreview")}</p>
      {settings === null ? (
        <p className="text-xs text-muted-foreground">
          {t("schemes.studio.messagePreviewUnavailable")}
        </p>
      ) : (
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed text-foreground">
          {renderQqMessagePreview(settings)}
        </pre>
      )}
      <p className="text-xs text-muted-foreground">{t("schemes.studio.messagePreviewCaption")}</p>
    </section>
  );
}
