import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QqOwnerResponse } from "../../../shared/contracts/qq";
import { Field } from "../../components/form-field";
import { Button } from "../../components/ui/button";
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
  useEffect(() => {
    const task = startRead(() => apiClient.getQqOwner(), {
      success: setOwner,
      failure: (error) => setError(error instanceof Error ? error.message : String(error)),
    });
    return () => task.cancel();
  }, [apiClient]);
  const value = peer ?? owner?.peer_id ?? "";
  return (
    <section className="space-y-4 border-t pt-5">
      <Field label="connections.owner.title" info="connections.owner.hint">
        <Input
          value={value}
          inputMode="numeric"
          disabled={saving || !owner || !qqSettings?.account_id}
          onChange={(e) => setPeer(e.target.value)}
        />
      </Field>
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
    </section>
  );
}
