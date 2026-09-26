import { useTranslation } from "react-i18next";
import { Field } from "../../components/form-field";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { useQqInput } from "../../features/qq/use-qq-input";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";

import { OwnerIdentity } from "./owner-identity";

export function TransportSettings({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const {
    qqSettings: settings,
    qqConnection: connection,
    qqAccessSaving: saving,
    saveQqSurface: save,
    error,
    feedback,
  } = useSuperstringStore();
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
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("connections.onebotConnection")}</DialogTitle>
          <DialogDescription>
            {t("connections.connectYourBotServiceCredentialsRemainOnThisMachine")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between rounded-lg bg-muted p-4">
          <div>
            <p className="font-medium">{t("connections.participateInExternalChats")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {connection?.reason ??
                t("connections.eachConversationSSchemeDeterminesHowTheAgentSpeaks")}
            </p>
          </div>
          <Checkbox
            aria-label={t("connections.enableQq")}
            checked={settings.enabled}
            disabled={saving}
            onCheckedChange={(checked) => void save({ enabled: checked === true })}
          />
        </div>
        <Field label="connections.assistantAccount">
          <Input
            inputMode="numeric"
            value={value.accountId}
            disabled={saving}
            onChange={(e) => patch("accountId", e.target.value)}
          />
        </Field>
        <Field
          label="connections.websocketAddress"
          info="connections.napcatSForwardWebsocketAddressLoopbackPreferredForExample"
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
          info="connections.neverEchoedBackOnceSavedLeavingItEmptyKeeps"
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={value.token}
            disabled={saving}
            onChange={(e) => patch("token", e.target.value)}
          />
          <div className="flex items-center justify-between">
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
                onClick={() => void save({ token: null })}
              >
                {t("connections.clearTheSavedToken")}
              </Button>
            )}
          </div>
        </Field>
        <OwnerIdentity />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {translateNotice(error)}
          </p>
        )}
        {feedback && !error && (
          <p role="status" className="text-sm text-muted-foreground">
            {translateNotice(feedback)}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("connections.close")}
          </Button>
          <Button
            disabled={saving}
            onClick={() =>
              void save(
                {
                  account_id: value.accountId.trim() || null,
                  endpoint: value.endpoint.trim() || null,
                  ...(value.token ? { token: value.token } : {}),
                },
                value.source.revision,
              ).then((ok) => {
                if (ok) {
                  setDraft(null);
                  onClose();
                }
              })
            }
          >
            {t("connections.saveAccessSettings")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
