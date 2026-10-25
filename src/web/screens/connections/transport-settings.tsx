import { RefreshCw, Save } from "lucide-react";
import { useEffect, useId } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { executionPolicy } from "../../../shared/contracts/permissions";
import { Field } from "../../components/form-field";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import {
  type ExecutionFieldKey,
  type PermissionScope,
  permissionSettingsDirty,
} from "../../features/access/permission-state";
import { useQqInput } from "../../features/qq/use-qq-input";
import type { ExecutionDraft, ExecutionDraftKey } from "../../features/runs/execution-draft";
import { useSuperstringStore } from "../../store";
import { WorkspaceHelp } from "../../workspace/WorkspaceHelp";
import { OwnerIdentity } from "./owner-identity";

/**
 * QQ 投递参数与跨会话唤醒并发：QQ 通道专用执行限制，归 QQ 应用连接页保存。
 * 面板只拥有这 4 个数值键；3 个 QQ 模块开关仍由各自能力专页编辑，这里只给总览与定位。
 */
const QQ_LIMIT_KEYS: readonly ExecutionFieldKey[] = [
  "qqRetryDelaySeconds",
  "qqMaxAttempts",
  "qqDeliveryTtlSeconds",
  "loopConcurrency",
];
const QQ_SCOPE: PermissionScope = { executionKeys: [...QQ_LIMIT_KEYS] };
const qqModules = [
  { module: "qqMedia", route: "media-tools" },
  { module: "qqStickers", route: "media-tools" },
  { module: "qqMembers", route: "qq-member-tools" },
] as const;
const qqRetryFields: { key: ExecutionDraftKey; label: string; info: string }[] = [
  {
    key: "qqMaxAttempts",
    label: "connections.execution.qqMaxAttempts",
    info: "connections.execution.qqMaxAttemptsHint",
  },
  {
    key: "qqRetryDelaySeconds",
    label: "connections.execution.qqRetryDelaySeconds",
    info: "connections.execution.qqRetryDelaySecondsHint",
  },
];
const qqDeliveryFields: { key: ExecutionDraftKey; label: string; info: string }[] = [
  {
    key: "qqDeliveryTtlSeconds",
    label: "connections.execution.qqDeliveryTtlSeconds",
    info: "connections.execution.qqDeliveryTtlSecondsHint",
  },
  {
    key: "loopConcurrency",
    label: "connections.execution.loopConcurrency",
    info: "connections.execution.loopConcurrencyHint",
  },
];

export function QqBusinessSwitch() {
  const { t } = useTranslation();
  const { settings, connection, saving, save } = useSuperstringStore(
    useShallow((state) => ({
      settings: state.qqSettings,
      connection: state.qqConnection,
      saving: state.qqAccessSaving,
      save: state.saveQqSurface,
    })),
  );
  if (!settings) return null;
  return (
    <SettingsGroup>
      <SettingsRow
        label={t("connections.participateInExternalChats")}
        description={
          connection?.reason ?? t("connections.eachConversationSSchemeDeterminesHowTheAgentSpeaks")
        }
        action={
          <Checkbox
            aria-label={t("connections.enableQq")}
            checked={settings.enabled}
            disabled={saving}
            onCheckedChange={(checked) => void save({ enabled: checked === true })}
          />
        }
      />
    </SettingsGroup>
  );
}

export function TransportSettings({
  active = true,
  view,
}: {
  active?: boolean;
  view?: "connection" | "runtime";
} = {}) {
  const { t } = useTranslation();
  const {
    qqSettings: settings,
    qqAccessSaving: saving,
    saveQqSurface: save,
  } = useSuperstringStore(
    useShallow((state) => ({
      qqSettings: state.qqSettings,
      qqAccessSaving: state.qqAccessSaving,
      saveQqSurface: state.saveQqSurface,
    })),
  );
  const [draft, setDraft] = useQqInput("connection");
  if (!settings) return null;
  const value = draft ?? {
    source: settings,
    endpoint: settings.transport.endpoint ?? "",
    accountId: settings.account_id ?? "",
    token: "",
  };
  const patch = (key: "endpoint" | "accountId" | "token", next: string) =>
    setDraft({ ...value, [key]: next });
  const saveFields = () =>
    void save(
      {
        account_id: value.accountId.trim() || null,
        endpoint: value.endpoint.trim() || null,
        ...(value.token ? { token: value.token } : {}),
      },
      value.source.revision,
    ).then((ok) => {
      if (ok) setDraft(null);
    });
  return (
    <section className="space-y-6">
      {view !== "runtime" && (
        <>
          {view === undefined && <QqBusinessSwitch />}

          <SettingsGroup
            title={t("connections.onebotConnection")}
            action={
              <WorkspaceHelp
                title={t("connections.onebotConnection")}
                description={t("connections.connectYourBotServiceCredentialsRemainOnThisMachine")}
              />
            }
          >
            <div className="space-y-5 p-4 sm:p-5">
              <Field label="connections.assistantAccount" tooltip={t("hints.fieldExtra.qqAccount")}>
                <Input
                  inputMode="numeric"
                  value={value.accountId}
                  disabled={saving}
                  onChange={(e) => patch("accountId", e.target.value)}
                />
              </Field>
              <div className="space-y-5">
                <Field
                  label="connections.websocketAddress"
                  tooltip={t(
                    "connections.napcatSForwardWebsocketAddressLoopbackPreferredForExample",
                  )}
                >
                  <Input
                    value={value.endpoint}
                    disabled={saving}
                    placeholder={t("connections.endpointExample")}
                    onChange={(e) => patch("endpoint", e.target.value)}
                  />
                </Field>
                <Field
                  label="connections.accessToken"
                  tooltip={t("connections.neverEchoedBackOnceSavedLeavingItEmptyKeeps")}
                >
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={value.token}
                    disabled={saving}
                    onChange={(e) => patch("token", e.target.value)}
                  />
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <Badge variant="outline">
                      {t(
                        settings.transport.has_token
                          ? "connections.tokenSaved"
                          : "connections.noTokenSavedYet",
                      )}
                    </Badge>
                    {settings.transport.has_token && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={saving}
                        tooltip={t("hints.qq.tokenClear")}
                        onClick={() => void save({ token: null })}
                      >
                        {t("connections.clearTheSavedToken")}
                      </Button>
                    )}
                  </div>
                </Field>
              </div>
              <div className="flex justify-end pt-1">
                <Button disabled={saving} tooltip={t("hints.qq.accessSave")} onClick={saveFields}>
                  {t("connections.saveAccessSettings")}
                </Button>
              </div>
            </div>
          </SettingsGroup>
        </>
      )}
      {view !== "connection" && (
        <>
          <OwnerIdentity />
          <QqDeliveryLimits active={active} />
        </>
      )}
    </section>
  );
}

/**
 * QQ 通道专用执行限制：面板声明自己的保存 scope（4 个数值键），保存经原
 * permissionEditor/patchExecutionSettings/savePermissionSettings(scope) 走 CAS 基线合并；
 * scope 外的草稿（含非法数值）既不提交也不阻断本面板，保存/放弃只作用于这 4 个键。
 */
function QqDeliveryLimits({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const editor = useSuperstringStore((s) => s.permissionEditor);
  const loading = useSuperstringStore((s) => s.permissionLoading);
  const saving = useSuperstringStore((s) => s.permissionSaving);
  const problem = useSuperstringStore((s) => s.permissionProblem);
  const error = useSuperstringStore((s) => s.permissionError);
  const errorScope = useSuperstringStore((s) => s.permissionErrorScope);
  const notice = useSuperstringStore((s) =>
    s.permissionNotice === "connections.execution.saved" ? s.permissionNotice : "",
  );
  const load = useSuperstringStore((s) => s.loadPermissionSettings);
  const save = useSuperstringStore((s) => s.savePermissionSettings);
  const discard = useSuperstringStore((s) => s.discardPermissionSettings);
  const update = useSuperstringStore((s) => s.patchExecutionSettings);
  const rootRef = useId();
  const draft = editor?.execution;
  const savedModules = editor ? executionPolicy(editor.snapshot.policy).modules : null;
  const dirty = permissionSettingsDirty(editor, QQ_SCOPE);
  // 只提示本面板能处理的问题：授权域（grants）与别页数值键的越界错误不在这里重复。
  const showError =
    !!error &&
    errorScope !== "grants" &&
    !(errorScope === "execution" && problem !== null && !QQ_LIMIT_KEYS.includes(problem));
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  const patch = (key: keyof ExecutionDraft, value: string | boolean) => update({ [key]: value });
  const handleSave = async () => {
    if (await save(QQ_SCOPE)) return;
    const root = document.getElementById(rootRef);
    const target =
      root?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      root?.querySelector<HTMLElement>('[role="alert"]');
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center" });
  };
  return (
    <div id={rootRef} className="space-y-4">
      <SettingsGroup
        className="[&>div:first-child]:flex-col sm:[&>div:first-child]:flex-row [&>div:first-child]:items-stretch sm:[&>div:first-child]:items-start [&>div:first-child>div:last-child]:w-full sm:[&>div:first-child>div:last-child]:w-auto"
        title={t("connections.execution.qqRetryGroup")}
        description={t("connections.execution.qqRetryGroupHint")}
        action={
          <div className="flex w-full max-w-full flex-wrap items-center gap-2 justify-start sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || saving}
              tooltip={t("hints.qq.executionReload")}
              onClick={() => void load(true)}
            >
              <RefreshCw />
              {t("connections.common.refresh")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!dirty || saving}
              tooltip={t("hints.qq.executionDiscard")}
              onClick={() => discard(QQ_SCOPE)}
            >
              {t("library.discard.changes")}
            </Button>
            <Button
              size="sm"
              disabled={!dirty || saving || loading}
              tooltip={t("hints.qq.executionSave")}
              onClick={() => void handleSave()}
            >
              <Save />
              {t("connections.execution.save")}
            </Button>
          </div>
        }
      >
        {draft ? (
          <div className="divide-y divide-border/60">
            {qqRetryFields.map((field) => (
              <div
                key={field.key}
                className="px-4 py-3 [&>[data-slot=field]]:sm:grid [&>[data-slot=field]]:sm:grid-cols-[minmax(0,1fr)_minmax(10rem,16rem)] [&_[data-slot=field-description]]:sm:col-start-1 [&_input]:sm:col-start-2 [&_input]:sm:row-span-2"
              >
                <Field label={field.label} info={field.info} tooltip={t(field.info)}>
                  <Input
                    inputMode="decimal"
                    aria-invalid={problem === field.key}
                    disabled={saving}
                    value={draft[field.key]}
                    className={
                      problem === field.key
                        ? "border-destructive focus-visible:ring-destructive"
                        : undefined
                    }
                    onChange={(e) => patch(field.key, e.target.value)}
                  />
                </Field>
              </div>
            ))}
          </div>
        ) : (
          // 读取失败不是「没有配置」：给真实原因与重试，不显示一组看起来未设置的空白输入框。
          <div className="flex flex-wrap items-center gap-3 p-4">
            {showError ? (
              <>
                <p role="alert" tabIndex={-1} className="text-sm text-destructive">
                  {t(error)}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  tooltip={t("hints.qq.executionRetry")}
                  onClick={() => void load(true)}
                >
                  {t("capabilities.retry")}
                </Button>
              </>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {t("connections.common.loading")}
              </p>
            )}
          </div>
        )}
      </SettingsGroup>

      {draft && (
        <SettingsGroup
          title={t("connections.execution.qqDeliveryGroup")}
          description={t("connections.execution.qqDeliveryGroupHint")}
        >
          <div className="divide-y divide-border/60">
            {qqDeliveryFields.map((field) => (
              <div
                key={field.key}
                className="px-4 py-3 [&>[data-slot=field]]:sm:grid [&>[data-slot=field]]:sm:grid-cols-[minmax(0,1fr)_minmax(10rem,16rem)] [&_[data-slot=field-description]]:sm:col-start-1 [&_input]:sm:col-start-2 [&_input]:sm:row-span-2"
              >
                <Field label={field.label} info={field.info} tooltip={t(field.info)}>
                  <Input
                    inputMode="decimal"
                    aria-invalid={problem === field.key}
                    disabled={saving}
                    value={draft[field.key]}
                    className={
                      problem === field.key
                        ? "border-destructive focus-visible:ring-destructive"
                        : undefined
                    }
                    onChange={(e) => patch(field.key, e.target.value)}
                  />
                </Field>
              </div>
            ))}
          </div>
        </SettingsGroup>
      )}
      {draft && showError && (
        <p role="alert" tabIndex={-1} className="text-sm text-destructive">
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
      <SettingsGroup description={t("capabilities.policy.globalScope")}>
        {qqModules.map((entry) => (
          <SettingsRow
            key={entry.module}
            label={t(`connections.execution.modules.${entry.module}`)}
            description={t(`connections.execution.modules.${entry.module}Hint`)}
            action={
              <>
                <Badge
                  variant="outline"
                  className="h-auto max-w-full whitespace-normal break-words text-left"
                >
                  {t(
                    savedModules
                      ? savedModules[entry.module]
                        ? "capabilities.state.on"
                        : "capabilities.state.off"
                      : "capabilities.state.unread",
                  )}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  tooltip={t("hints.qq.moduleConfigure")}
                  onClick={() => useSuperstringStore.getState().openSettingsRoute(entry.route)}
                >
                  {t("connections.tools.configureFunction")}
                </Button>
              </>
            }
          />
        ))}
      </SettingsGroup>
    </div>
  );
}
