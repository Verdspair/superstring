import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebAccessTestResult } from "../../api";
import { Field } from "../../components/form-field";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { webAccessDraftDirty } from "../../features/access/web-access-state";
import { useSuperstringStore } from "../../store";
import { CapabilityPolicyPanel } from "./capability-policy-panel";
import { ToolGrantsPanel } from "./tool-grants-panel";

// 端点草稿持久在 store：跨路由保留，离开设置页时参与保存/放弃守卫。
export function WebAccessPanel({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const snapshot = useSuperstringStore((s) => s.webAccessSnapshot);
  const loading = useSuperstringStore((s) => s.webAccessLoading);
  const saving = useSuperstringStore((s) => s.webAccessSaving);
  const testing = useSuperstringStore((s) => s.webAccessTesting);
  const error = useSuperstringStore((s) => s.webAccessError);
  const notice = useSuperstringStore((s) => s.webAccessNotice);
  const draft = useSuperstringStore((s) => s.webAccessDraft);
  const load = useSuperstringStore((s) => s.loadWebAccess);
  const saveDraft = useSuperstringStore((s) => s.saveWebAccessDraft);
  const patchDraft = useSuperstringStore((s) => s.patchWebAccessDraft);
  const discardDraft = useSuperstringStore((s) => s.discardWebAccessDraft);
  const test = useSuperstringStore((s) => s.testWebAccess);
  const [verdict, setVerdict] = useState<WebAccessTestResult | null>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  const revision = snapshot?.revision ?? "";
  // 自检结论只对发起时的已保存配置有效：配置换代后不呈现旧成功。
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision 只作触发条件，effect 体无需读取它。
  useEffect(() => {
    setVerdict(null);
  }, [revision]);
  const baseline = snapshot?.config.searxngEndpoint ?? "";
  const value = draft ?? baseline;
  const dirty = webAccessDraftDirty(snapshot, draft);
  // 自检期间冻结端点编辑/保存/丢弃，避免出现可点但被存储层拒绝的按钮。
  const busy = saving || testing || loading || !snapshot;
  const saveEndpoint = async () => {
    setVerdict(null);
    if (await saveDraft()) return;
    // 冲突/非法：草稿留在输入框里，焦点交给提示；显式刷新后再提交（对照执行设置的 409 处理）。
    const alert = alertRef.current;
    if (alert) {
      alert.focus({ preventScroll: true });
      alert.scrollIntoView({ block: "center" });
    }
  };
  return (
    <div className="w-full min-w-0 space-y-8 px-4 py-6">
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
      <CapabilityPolicyPanel modules={["web"]} active={active} />
      <ToolGrantsPanel scope={["web"]} embedded active={active} />
      <section className="space-y-4">
        <h3 className="font-semibold">{t("connections.web.channels")}</h3>
        <p className="text-xs text-muted-foreground">{t("connections.web.scopeHint")}</p>
        <div className="divide-y rounded-lg border">
          <div className="p-4">
            <p className="font-medium">{t("connections.web.builtin")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("connections.web.builtinHint")}</p>
          </div>
          <div className="space-y-3 p-4">
            <Field label="connections.web.endpointLabel" info="connections.web.endpointHint">
              <Input
                value={value}
                disabled={busy}
                placeholder="http://127.0.0.1:8888"
                onChange={(e) => {
                  setVerdict(null);
                  patchDraft(e.target.value);
                }}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!dirty || busy} onClick={() => void saveEndpoint()}>
                {t("connections.web.save")}
              </Button>
              <Button
                variant="outline"
                disabled={!dirty || busy}
                onClick={() => {
                  setVerdict(null);
                  discardDraft();
                }}
              >
                {t("library.discard.changes")}
              </Button>
              <Button
                variant="outline"
                disabled={busy || dirty}
                onClick={() => {
                  setVerdict(null);
                  void test().then((result) => {
                    if (result && alive.current) setVerdict(result);
                  });
                }}
              >
                {testing ? t("connections.web.testRunning") : t("connections.web.test")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("capabilities.policy.webTestHint")}</p>
          </div>
        </div>
      </section>
    </div>
  );
}
