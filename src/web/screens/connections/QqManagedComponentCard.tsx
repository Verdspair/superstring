import { Bot, RefreshCw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";

export type QqManagedPhase =
  | "unconfigured"
  | "stopped"
  | "starting"
  | "waiting_scan"
  | "waiting_confirm"
  | "core_online"
  | "transport_ready"
  | "challenge"
  | "error";

export interface QqManagedStatus {
  managedEnabled: boolean;
  phase: QqManagedPhase;
  accountId: string | null;
  qrPayload: string | null;
  runtimeGatePassed: boolean;
  diagnosticCode: string | null;
}

export interface QqManagedCardProps {
  status: QqManagedStatus;
  loading?: boolean;
  saving?: boolean;
  onToggleManaged: (enabled: boolean) => void;
  onRefreshQr?: () => void;
  onRetry?: () => void;
}

const phaseLabelKeys: Record<QqManagedPhase, string> = {
  unconfigured: "connections.managed.phase.unconfigured",
  stopped: "connections.managed.phase.stopped",
  starting: "connections.managed.phase.starting",
  waiting_scan: "connections.managed.phase.waiting_scan",
  waiting_confirm: "connections.managed.phase.waiting_confirm",
  core_online: "connections.managed.phase.core_online",
  transport_ready: "connections.managed.phase.transport_ready",
  challenge: "connections.managed.phase.challenge",
  error: "connections.managed.phase.error",
};

const diagnosticLabelKeys: Record<string, string> = {
  process_crashed: "connections.managed.diag.process_crashed",
  spawn_failed: "connections.managed.diag.spawn_failed",
  handshake_timeout: "connections.managed.diag.handshake_timeout",
  challenge_required: "connections.managed.diag.challenge_required",
};

export function QqManagedComponentCard({
  status,
  loading = false,
  saving = false,
  onToggleManaged,
  onRefreshQr,
  onRetry,
}: QqManagedCardProps) {
  const { t } = useTranslation();

  const isBusy = loading || saving;
  const disableToggle = isBusy || (!status.managedEnabled && !status.runtimeGatePassed);

  const safeDiagnosticCode =
    status.diagnosticCode && Object.hasOwn(diagnosticLabelKeys, status.diagnosticCode)
      ? status.diagnosticCode
      : "unknown";

  return (
    <SettingsGroup
      title={t("connections.managed.title")}
      description={t("connections.managed.description")}
      icon={Bot}
    >
      <SettingsRow
        label={t("connections.managed.enable")}
        description={t("connections.managed.enableHint")}
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

      <SettingsRow
        label={t("connections.managed.statusTitle")}
        description={
          status.accountId ? (
            <span className="text-xs text-muted-foreground">
              {t("connections.managed.currentAccount", { account: status.accountId })}
            </span>
          ) : undefined
        }
        action={
          <Badge
            variant={status.phase === "transport_ready" ? "secondary" : "outline"}
            data-phase={status.phase}
            role={status.phase === "error" ? undefined : "status"}
            aria-live={status.phase === "error" ? undefined : "polite"}
            className="rounded-md px-2 py-0.5 font-medium"
          >
            {t(phaseLabelKeys[status.phase] ?? "connections.managed.phase.unconfigured")}
          </Badge>
        }
      />

      {status.phase === "waiting_scan" && status.qrPayload && (
        <div className="flex flex-col items-center gap-3 border-t border-border p-4 sm:p-5">
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
              className="h-7 text-xs"
            >
              {t("connections.managed.retry")}
            </Button>
          </div>
        </div>
      )}
    </SettingsGroup>
  );
}
