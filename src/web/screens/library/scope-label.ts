import type { TFunction } from "i18next";
import { memoryScopeIdentity } from "../../../shared/memory-scope";
export function memoryScopeLabel(key: string, agentId: string, t: TFunction): string {
  const identity = memoryScopeIdentity(key, agentId);
  if (identity.kind === "web") return t("library.scope.web");
  if (identity.kind === "legacy") return t("library.scope.legacy", { "0": key });
  return t(
    identity.conversationKind === "group" ? "library.scope.group" : "library.scope.private",
    { "0": identity.peerId, "1": identity.accountId },
  );
}
