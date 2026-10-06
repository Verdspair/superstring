import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QqOwnerResponse } from "../../../shared/contracts/qq";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { startRead } from "../../services/read-task";
import { useSuperstringStore } from "../../store";

export function OwnerIdentity() {
  const { t } = useTranslation();
  const { apiClient, qqSettings } = useSuperstringStore();
  const [owner, setOwner] = useState<QqOwnerResponse | null>(null);
  const [peer, setPeer] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // 提示与原因通过稳定 id 挂到输入框 describedby，不新增状态或包装组件。
  const hintId = useId();
  const reasonId = useId();
  useEffect(() => {
    const task = startRead(() => apiClient.getQqOwner(), {
      success: setOwner,
      failure: (error) => setError(error instanceof Error ? error.message : String(error)),
    });
    return () => task.cancel();
  }, [apiClient]);
  const value = peer ?? owner?.peer_id ?? "";
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t("connections.owner.title")}</CardTitle>
        <CardDescription id={hintId}>{t("connections.owner.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Input
          value={value}
          inputMode="numeric"
          aria-label={t("connections.owner.title")}
          aria-describedby={qqSettings?.account_id ? hintId : `${hintId} ${reasonId}`}
          disabled={saving || !owner || !qqSettings?.account_id}
          onChange={(e) => setPeer(e.target.value)}
        />
        {!qqSettings?.account_id && (
          <p id={reasonId} className="text-xs text-muted-foreground">
            {t("connections.owner.accountRequired")}
          </p>
        )}
        <Button
          variant="outline"
          disabled={
            saving || !owner || !value.trim() || value === owner.peer_id || !qqSettings?.account_id
          }
          onClick={async () => {
            setSaving(true);
            setError("");
            try {
              const saved = await apiClient.updateQqOwner({
                peer_id: value.trim(),
                ...(owner?.revision ? { expected_revision: owner.revision } : {}),
              });
              setOwner(saved);
              setPeer(null);
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            } finally {
              setSaving(false);
            }
          }}
        >
          {t("connections.owner.save")}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
