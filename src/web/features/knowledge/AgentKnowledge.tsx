import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AgentKnowledge as AuthorizedDocument } from "../../../shared/contracts/knowledge";
import { translateNotice, useI18n } from "../../i18n";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";
import { knowledgeStatus } from "./KnowledgeSettings";

export function AgentKnowledge() {
  const t = useI18n();
  const agentId = useSuperstringStore((s) => s.editorAgentId);
  const api = useSuperstringStore((s) => s.apiClient);
  const navigate = useSuperstringStore((s) => s.requestPageNavigation);
  const [result, setResult] = useState<{
    agentId: string;
    items: AuthorizedDocument[];
    error: string | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (agentId === "__new__") return;
    void api
      .listAgentKnowledge(agentId)
      .then((items) => {
        if (active) setResult({ agentId, items, error: null });
      })
      .catch((error) => {
        if (active) setResult({ agentId, items: [], error: errorText(error) });
      });
    return () => {
      active = false;
    };
  }, [agentId, api]);
  const current = result?.agentId === agentId ? result : null;
  return (
    <div className="space-y-4">
      <p className="settings-note text-sm leading-relaxed text-muted-foreground">
        {t("当前助手的已授权资料；在知识库管理中修改。")}
      </p>
      {!current ? (
        <p className="hint text-sm leading-relaxed text-muted-foreground">{t("正在读取资料…")}</p>
      ) : current.error ? (
        <p role="alert">{translateNotice(current.error)}</p>
      ) : !current.items.length ? (
        <p className="hint text-sm leading-relaxed text-muted-foreground">
          {t("当前助手暂无已授权资料。")}
        </p>
      ) : (
        <ul className="knowledge-authorized divide-y [&>li]:py-3 [&_small]:mt-1 [&_small]:block [&_small]:text-xs [&_small]:text-muted-foreground">
          {current.items.map((item) => (
            <li key={item.id}>
              <strong>{item.name}</strong>
              <small>
                {t(knowledgeStatus[item.organization_status])} ·{" "}
                {t(item.content_mode === "original" ? "使用原文" : "使用整理稿")}
              </small>
              {item.summary && <p>{item.summary}</p>}
            </li>
          ))}
        </ul>
      )}
      <Button variant="outline" type="button" onClick={() => navigate("settings", "knowledge")}>
        {t("打开知识库详细配置")}
      </Button>
    </div>
  );
}
