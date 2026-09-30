// 嵌入能力专页：只编辑调用方声明的模块，未列出草稿不提交不阻断；错误与提示按归属过滤。

import { RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "../../components/form-field";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  type PermissionScope,
  permissionSettingsDirty,
} from "../../features/access/permission-state";
import type { ExecutionDraft } from "../../features/runs/execution-draft";
import { useSuperstringStore } from "../../store";

export function CapabilityPolicyPanel({
  modules,
}: {
  modules: (keyof ExecutionDraft["modules"])[];
}) {
  const { t } = useTranslation();
  const editor = useSuperstringStore((s) => s.permissionEditor);
  const loading = useSuperstringStore((s) => s.permissionLoading);
  const saving = useSuperstringStore((s) => s.permissionSaving);
  const error = useSuperstringStore((s) => s.permissionError);
  const errorScope = useSuperstringStore((s) => s.permissionErrorScope);
  const notice = useSuperstringStore((s) =>
    s.permissionNotice === "connections.execution.saved" ? s.permissionNotice : "",
  );
  const load = useSuperstringStore((s) => s.loadPermissionSettings);
  const save = useSuperstringStore((s) => s.savePermissionSettings);
  const discard = useSuperstringStore((s) => s.discardPermissionSettings);
  const update = useSuperstringStore((s) => s.patchExecutionSettings);
  useEffect(() => {
    void load();
  }, [load]);
  const scope: PermissionScope = { modules };
  const draft = editor?.execution;
  const dirty = permissionSettingsDirty(editor, scope);
  // 数值越界错误由执行设置页就地提示（那里才能修正）；其余可修复错误不因去重被隐藏。
  const numericInvalid = error === "connections.execution.invalid";
  const showError = !!error && !numericInvalid && errorScope !== "grants";
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            <SlidersHorizontal className="size-4 text-muted-foreground" />
            {t("connections.execution.switches")}
          </h3>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            {t("connections.execution.timing")}
          </p>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            {t("capabilities.policy.globalScope")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={loading || saving} onClick={() => void load(true)}>
            <RefreshCw />
            {t("connections.common.refresh")}
          </Button>
          <Button variant="outline" disabled={!dirty || saving} onClick={() => discard(scope)}>
            {t("library.discard.changes")}
          </Button>
          <Button
            disabled={!dirty || saving || loading || !editor}
            onClick={() => void save(scope)}
          >
            <Save />
            {t("connections.execution.save")}
          </Button>
        </div>
      </div>
      {showError && (
        <p role="alert" className="text-sm text-destructive">
          {t(error)}
        </p>
      )}
      {dirty && (
        <p className="text-xs text-muted-foreground">{t("connections.execution.unsaved")}</p>
      )}
      {!dirty && notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(notice)}
        </p>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        {modules.map((module) => (
          <Field
            key={module}
            label={`connections.execution.modules.${module}`}
            info={`connections.execution.modules.${module}Hint`}
          >
            <Checkbox
              checked={draft?.modules[module] ?? false}
              disabled={saving || !draft}
              onCheckedChange={(checked) =>
                draft && update({ modules: { ...draft.modules, [module]: checked === true } })
              }
            />
          </Field>
        ))}
      </div>
    </section>
  );
}
