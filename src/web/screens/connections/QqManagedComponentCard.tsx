import { Bot, ExternalLink, Folder, LogIn, RefreshCw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  QqManagedAccounts,
  QqManagedResourceSnapshot,
  QqManagedStatus as SharedQqManagedStatus,
} from "../../../shared/contracts/qq-managed";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import { WorkspaceHelp } from "../../workspace/WorkspaceHelp";

type ReadyStatus = Extract<SharedQqManagedStatus, { apply: "ready" }>;
export type QqManagedPhase = ReadyStatus["phase"] | "unconfigured";
export type QqManagedOwnership = ReadyStatus["ownership"];
export type QqManagedNetworkApply = ReadyStatus["network_apply"];
export type QqManagedAccountItem = QqManagedAccounts["accounts"][number];
export type { QqManagedResourceSnapshot };

export interface QqManagedStatus {
  managedEnabled: boolean;
  phase: QqManagedPhase;
  accountId: string | null;
  qrPayload: string | null;
  runtimeGatePassed: boolean;
  diagnosticCode: string | null;
  ownership?: QqManagedOwnership;
  process?: ReadyStatus["process"];
  networkApply?: QqManagedNetworkApply;
}

export interface QqManagedCardProps {
  status: QqManagedStatus;
  resources?: QqManagedResourceSnapshot | null;
  resourceDraftRoot?: string | null;
  accounts?: QqManagedAccountItem[];
  selectedQuickLoginAccount?: string | null;
  loading?: boolean;
  saving?: boolean;
  onToggleManaged: (enabled: boolean) => void;
  onRefreshQr?: () => void;
  onSelectQuickLoginAccount?: (accountId: string) => void;
  onExecuteQuickLogin?: () => void;
  onPatchResourceDraftRoot?: (root: string) => void;
  onUpdateResourcePath?: (root: string) => void;
  onRetry?: () => void;
  footer?: ReactNode;
}

const phaseLabelKeys: Record<QqManagedPhase, string> = {
  unconfigured: "connections.managed.phase.unconfigured",
  stopped: "connections.managed.phase.stopped",
  starting: "connections.managed.phase.starting",
  waiting_scan: "connections.managed.phase.waiting_scan",
  waiting_confirm: "connections.managed.phase.waiting_confirm",
  core_online: "connections.managed.phase.core_online",
  configuration_required: "connections.managed.phase.configuration_required",
  applying_network: "connections.managed.phase.applying_network",
  transport_ready: "connections.managed.phase.transport_ready",
  challenge: "connections.managed.phase.challenge",
  error: "connections.managed.phase.error",
};

const networkApplyLabelKeys: Record<QqManagedNetworkApply, string> = {
  not_configured: "connections.managed.networkApply.not_configured",
  pending: "connections.managed.networkApply.pending",
  verified: "connections.managed.networkApply.verified",
  failed: "connections.managed.networkApply.failed",
  not_owned: "connections.managed.networkApply.not_owned",
};

const diagnosticLabelKeys: Record<string, string> = {
  process_crashed: "connections.managed.diag.process_crashed",
  spawn_failed: "connections.managed.diag.spawn_failed",
  stop_failed: "connections.managed.diag.stop_failed",
  handshake_timeout: "connections.managed.diag.handshake_timeout",
  control_unavailable: "connections.managed.diag.control_unavailable",
  challenge_required: "connections.managed.diag.challenge_required",
  account_mismatch: "connections.managed.diag.account_mismatch",
  runtime_not_selected: "connections.managed.diag.runtime_not_selected",
  runtime_resources_invalid: "connections.managed.diag.runtime_resources_invalid",
  network_configuration_required: "connections.managed.diag.network_configuration_required",
  network_apply_failed: "connections.managed.diag.network_apply_failed",
};

export function QqManagedComponentCard({
  status,
  resources,
  resourceDraftRoot,
  accounts,
  selectedQuickLoginAccount,
  loading = false,
  saving = false,
  onToggleManaged,
  onRefreshQr,
  onSelectQuickLoginAccount,
  onExecuteQuickLogin,
  onPatchResourceDraftRoot,
  onUpdateResourcePath,
  onRetry,
  footer,
}: QqManagedCardProps) {
  const { t } = useTranslation();
  const [localPath, setLocalPath] = useState(resources?.root ?? "");
  const [resourceExpanded, setResourceExpanded] = useState(false);
  const resourcePanelId = useId();

  const isControlled = resourceDraftRoot !== undefined;
  const currentPath = isControlled ? (resourceDraftRoot ?? "") : localPath;

  const isBusy = loading || saving;
  const disableToggle = isBusy || (!status.managedEnabled && !status.runtimeGatePassed);

  const safeDiagnosticCode =
    status.diagnosticCode && Object.hasOwn(diagnosticLabelKeys, status.diagnosticCode)
      ? status.diagnosticCode
      : "unknown";

  const resourceSetupRequired = !status.runtimeGatePassed || resources?.status !== "ready";
  const showResourceSetup = resourceSetupRequired || resourceExpanded;
  const resourceReadOnly = isBusy || !resources || status.ownership === "external";
  const showQuickLogin =
    accounts &&
    accounts.length > 0 &&
    status.ownership !== "external" &&
    (status.phase === "waiting_scan" || status.phase === "stopped");
  const canQuickLogin =
    status.runtimeGatePassed &&
    status.ownership === "owned" &&
    status.process === "running" &&
    status.phase === "waiting_scan" &&
    resources?.status === "ready";

  const handlePathChange = (val: string) => {
    if (isControlled && onPatchResourceDraftRoot) {
      onPatchResourceDraftRoot(val);
    } else {
      setLocalPath(val);
    }
  };

  return (
    <SettingsGroup
      title={t("connections.managed.title")}
      action={
        <WorkspaceHelp
          title={t("connections.managed.title")}
          description={t("connections.managed.description")}
        />
      }
      icon={Bot}
    >
      <SettingsRow
        label={
          <span className="inline-flex items-center gap-2">
            {t("connections.managed.enable")}
            <WorkspaceHelp
              title={t("connections.managed.enable")}
              description={t("connections.managed.enableHint")}
            />
          </span>
        }
        action={
          <Checkbox
            aria-label={t("connections.managed.enable")}
            checked={status.managedEnabled}
            disabled={disableToggle}
            onCheckedChange={(checked) => onToggleManaged(checked === true)}
          />
        }
      />

      {!status.runtimeGatePassed && (
        <div
          role="status"
          className="border-t border-destructive/20 bg-destructive/5 px-4 py-2.5 text-xs text-destructive"
        >
          {t("connections.managed.gateNotice")}
        </div>
      )}

      {onUpdateResourcePath && (
        <div className="border-t border-border px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {t("connections.managed.resources.title")}
              </span>
              <Badge variant="outline">
                {t(
                  resources?.status === "ready"
                    ? "connections.managed.resources.valid"
                    : "connections.managed.phase.unconfigured",
                )}
              </Badge>
              <WorkspaceHelp
                title={t("connections.managed.resources.title")}
                description={t("connections.managed.resources.description")}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-expanded={showResourceSetup}
              aria-controls={resourcePanelId}
              disabled={isBusy || resourceSetupRequired}
              onClick={() => setResourceExpanded((expanded) => !expanded)}
            >
              <Folder />
              {t("connections.managed.resources.configure")}
            </Button>
          </div>
          <div
            id={resourcePanelId}
            hidden={!showResourceSetup}
            className="mt-3 space-y-3 [&[hidden]]:hidden"
          >
            <a
              href="https://github.com/NapNeko/NapCatQQ/releases"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-2 hover:opacity-80"
            >
              {t("connections.managed.resources.officialLink")}
              <ExternalLink className="size-3.5" />
            </a>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Input
                aria-label={t("connections.managed.resources.title")}
                placeholder={t("connections.managed.resources.inputPlaceholder")}
                value={currentPath}
                disabled={resourceReadOnly}
                onChange={(event) => handlePathChange(event.target.value)}
                className="min-w-0 flex-1 basis-48 font-mono"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={resourceReadOnly || !currentPath.trim()}
                onClick={() => onUpdateResourcePath(currentPath.trim())}
              >
                <Folder />
                {t("connections.managed.resources.saveButton")}
              </Button>
            </div>
          </div>
        </div>
      )}

      <SettingsRow
        label={t("connections.managed.statusTitle")}
        description={
          status.ownership === "external" ? (
            <span className="text-xs text-muted-foreground">
              {t("connections.managed.ownership.externalHint")}
            </span>
          ) : status.accountId ? (
            <span className="text-xs text-muted-foreground">
              {t("connections.managed.currentAccount", { account: status.accountId })}
            </span>
          ) : undefined
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            {status.ownership === "external" && (
              <Badge
                variant="outline"
                className="rounded-md border-border px-2 py-0.5 font-medium text-muted-foreground"
              >
                {t("connections.managed.ownership.external")}
              </Badge>
            )}
            <Badge
              variant={status.phase === "transport_ready" ? "secondary" : "outline"}
              data-phase={status.phase}
              role={status.phase === "error" ? undefined : "status"}
              aria-live={status.phase === "error" ? undefined : "polite"}
              className="rounded-md px-2 py-0.5 font-medium"
            >
              {t(phaseLabelKeys[status.phase] ?? "connections.managed.phase.unconfigured")}
            </Badge>
            {status.networkApply && status.networkApply !== "not_owned" && (
              <Badge
                variant={status.networkApply === "verified" ? "secondary" : "outline"}
                data-network-apply={status.networkApply}
                className="rounded-md px-2 py-0.5 text-xs font-medium"
              >
                {t(networkApplyLabelKeys[status.networkApply] ?? status.networkApply)}
              </Badge>
            )}
          </div>
        }
      />

      {showQuickLogin && onSelectQuickLoginAccount && onExecuteQuickLogin && (
        <div className="border-t border-border px-4 py-3 sm:px-5">
          <div className="flex flex-col gap-2">
            <span className="text-[13.5px] font-medium text-foreground">
              {t("connections.managed.quickLogin.title", "本机快捷登录")}
            </span>
            {!canQuickLogin && (
              <p className="text-sm text-muted-foreground">
                {t("connections.managed.quickLogin.notReady")}
              </p>
            )}
            {status.phase === "stopped" &&
              status.managedEnabled &&
              status.runtimeGatePassed &&
              onRetry && (
                <Button variant="outline" size="sm" disabled={isBusy} onClick={onRetry}>
                  {t("connections.managed.retry")}
                </Button>
              )}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <NativeSelect
                size="sm"
                value={selectedQuickLoginAccount ?? ""}
                disabled={isBusy}
                onChange={(e) => onSelectQuickLoginAccount(e.target.value)}
                className="min-w-0 max-w-full flex-1 basis-48 font-mono"
              >
                <option value="" disabled>
                  {t("connections.managed.quickLogin.selectPlaceholder", "选择已登录账号...")}
                </option>
                {accounts.map((acc) => (
                  <option key={acc.account_id} value={acc.account_id}>
                    {acc.account_id} {acc.display_name ? `(${acc.display_name})` : ""}
                  </option>
                ))}
              </NativeSelect>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  isBusy ||
                  !canQuickLogin ||
                  !accounts.some((account) => account.account_id === selectedQuickLoginAccount)
                }
                onClick={() => onExecuteQuickLogin()}
                className="shrink-0"
              >
                <LogIn className="mr-1.5 size-3.5" />
                {t("connections.managed.quickLogin.loginButton", "快速登录")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {status.phase === "waiting_scan" && (
        <div className="flex flex-col items-center gap-3 border-t border-border p-4 sm:p-5">
          {status.qrPayload ? (
            <>
              {/* High-contrast white background is strictly an optical exception for camera scanning readability */}
              <div className="rounded-lg border border-border bg-white p-3 shadow-xs">
                <QRCodeSVG
                  value={status.qrPayload}
                  size={160}
                  level="M"
                  aria-label={t("connections.managed.scanWithMobileQq")}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t("connections.managed.scanWithMobileQq")}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("connections.managed.phase.waiting_scan")}
            </p>
          )}
          <Button
            tooltip={t("connections.managed.refreshQr")}
            variant="outline"
            size="sm"
            disabled={isBusy || !onRefreshQr}
            onClick={() => onRefreshQr?.()}
            className="h-8 rounded-lg"
          >
            <RefreshCw className="mr-1.5 size-3.5" />
            {t("connections.managed.refreshQr")}
          </Button>
        </div>
      )}

      {status.phase === "error" && (
        <div
          role="alert"
          data-diagnostic-code={safeDiagnosticCode}
          className="border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {t(
                Object.hasOwn(diagnosticLabelKeys, safeDiagnosticCode)
                  ? diagnosticLabelKeys[safeDiagnosticCode]
                  : "connections.managed.diag.unknown",
              )}
            </span>
            <Button
              tooltip={t("connections.managed.retry")}
              variant="outline"
              size="sm"
              disabled={isBusy || !onRetry}
              onClick={() => onRetry?.()}
              className="min-h-8"
            >
              {t("connections.managed.retry")}
            </Button>
          </div>
        </div>
      )}
      {footer && (
        <div className="flex flex-wrap items-center justify-end gap-2 p-4 sm:p-5">{footer}</div>
      )}
    </SettingsGroup>
  );
}
