import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebAccessTestResult } from "../../api";
import { Field } from "../../components/form-field";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useSuperstringStore } from "../../store";

/**
 * 联网（web-access）：一处配置搜索通道（内置必应、可选 SearXNG 端点）并自检当前通道。
 * 总开关与助手授权不在本页：说明块给出路径，授权跳转走现成的 openSettingsRoute 守卫。
 */
export function WebAccessPanel() {
  const { t } = useTranslation();
  const snapshot = useSuperstringStore((s) => s.webAccessSnapshot);
  const loading = useSuperstringStore((s) => s.webAccessLoading);
  const saving = useSuperstringStore((s) => s.webAccessSaving);
  const testing = useSuperstringStore((s) => s.webAccessTesting);
  const error = useSuperstringStore((s) => s.webAccessError);
  const notice = useSuperstringStore((s) => s.webAccessNotice);
  const load = useSuperstringStore((s) => s.loadWebAccess);
  const save = useSuperstringStore((s) => s.saveWebAccess);
  const test = useSuperstringStore((s) => s.testWebAccess);
  const open = useSuperstringStore((s) => s.openSettingsRoute);
  // null＝跟随基线。一旦打字，草稿就保留到保存成功为止：读取（含冲突后的重新读取）
  // 不会丢掉它，成功后的基线（含服务端归一）才把输入收回来。
  const [draft, setDraft] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<WebAccessTestResult | null>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    void load();
  }, [load]);
  const baseline = snapshot?.config.searxngEndpoint ?? "";
  const value = draft ?? baseline;
  const dirty = draft !== null && draft.trim() !== baseline;
  const saveEndpoint = async () => {
    setVerdict(null);
    const trimmed = value.trim();
    const ok = await save(
      trimmed === "" ? { version: 1 } : { version: 1, searxngEndpoint: trimmed },
    );
    if (ok) {
      setDraft(null);
      return;
    }
    // 冲突/非法：草稿留在输入框里，焦点交给提示；显式刷新后再提交（对照执行设置的 409 处理）。
    const alert = alertRef.current;
    if (alert) {
      alert.focus({ preventScroll: true });
      alert.scrollIntoView({ block: "center" });
    }
  };
  return (
    <div className="mx-auto max-w-6xl space-y-8 px-6 py-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">{t("connections.web.title")}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("connections.web.description")}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={loading || saving || testing}
          onClick={() => void load()}
        >
          <RefreshCw />
          {t("connections.common.refresh")}
        </Button>
      </div>
      {error && (
        <p ref={alertRef} role="alert" tabIndex={-1} className="text-sm text-destructive">
          {error}
        </p>
      )}
      {verdict &&
        (verdict.ok ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("connections.web.testOk", {
              "0": t(`connections.web.channel.${verdict.channel}`),
              "1": verdict.elapsedMs,
            })}
          </p>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {t("connections.web.testFailed", { "0": verdict.error ?? "" })}
          </p>
        ))}
      {notice && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(notice)}
        </p>
      )}
      <section className="space-y-2 text-xs text-muted-foreground">
        <p>{t("connections.web.switchHint")}</p>
        <p>{t("connections.web.grantHint")}</p>
        <p>{t("connections.web.scopeHint")}</p>
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0"
          onClick={() => open("tool-grants")}
        >
          {t("connections.web.grantAction")}
        </Button>
      </section>
      <section className="space-y-4">
        <h3 className="font-semibold">{t("connections.web.channels")}</h3>
        <div className="divide-y rounded-lg border">
          <div className="p-4">
            <p className="font-medium">{t("connections.web.builtin")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("connections.web.builtinHint")}</p>
          </div>
          <div className="space-y-3 p-4">
            <Field label="connections.web.endpointLabel" info="connections.web.endpointHint">
              <Input
                value={value}
                disabled={saving || loading || !snapshot}
                placeholder="http://127.0.0.1:8888"
                onChange={(e) => setDraft(e.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!dirty || saving || loading || !snapshot}
                onClick={() => void saveEndpoint()}
              >
                {t("connections.web.save")}
              </Button>
              <Button
                variant="outline"
                disabled={testing || saving || loading || !snapshot}
                onClick={() => {
                  setVerdict(null);
                  void test().then((result) => {
                    if (result) setVerdict(result);
                  });
                }}
              >
                {testing ? t("connections.web.testRunning") : t("connections.web.test")}
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
