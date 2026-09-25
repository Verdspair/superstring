import { memoryScopeIdentity } from "../../../shared/memory-scope";
import type { useI18n } from "../../i18n";

export function memoryScopeLabel(
  key: string,
  agentId: string,
  t: ReturnType<typeof useI18n>,
): string {
  const identity = memoryScopeIdentity(key, agentId);
  if (identity.kind === "web") return t("网页记忆");
  if (identity.kind === "legacy") return t("历史分区（{0}）", key);
  return t(
    identity.conversationKind === "group" ? "QQ · 群 {0} · 账号 {1}" : "QQ · 私聊 {0} · 账号 {1}",
    identity.peerId,
    identity.accountId,
  );
}
