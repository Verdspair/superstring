import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSuperstringStore } from "@/store";
import type { QqBindingResponse, QqMemoryOrganiseResponse } from "../../../shared/contracts/qq";
import { JobRunLink } from "../runs/RunEntry";

const verdicts = {
  queued: "library.organization.queued",
  nothing_to_organise: "library.nothing.to.organize",
  switch_off: "library.connection.is.off.organization.unavailable",
  paused: "library.this.conversation.is.paused",
  busy: "library.this.agent.already.has.an.organization.job",
  agent_disabled: "library.this.agent.is.disabled",
} as const;
export function BindingMemoryControls({
  binding,
  pending,
  disabled = false,
  onChanged,
}: {
  binding: QqBindingResponse & { enabled?: boolean };
  pending?: number;
  disabled?: boolean;
  onChanged: () => void;
}) {
  const s = useSuperstringStore(),
    t = useTranslation().t,
    [verdict, setVerdict] = useState<QqMemoryOrganiseResponse | null>(null);
  const draft = s.qqMemoryBatchDrafts[binding.id],
    value = draft?.value ?? String(binding.memory_batch_size ?? "");
  const busy = disabled || s.qqMemoryBatchSaving || s.qqAccessSaving;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">
          {t("library.value.waiting", { "0": pending ?? binding.pending_observations })}
        </Badge>
        {binding.memory_batch_size && (
          <span className="text-xs text-muted-foreground">
            {t("library.value.more.observations.until.automatic.organization", {
              "0": Math.max(
                0,
                binding.memory_batch_size - (pending ?? binding.pending_observations),
              ),
            })}
          </span>
        )}
      </div>
      <Field label="library.automatic.batch.size.blank.to.disable">
        <Input
          type="number"
          min={1}
          value={value}
          disabled={busy}
          onChange={(e) =>
            s.patchQqMemoryBatchDraft(
              binding.id,
              e.target.value === String(binding.memory_batch_size ?? "")
                ? null
                : { value: e.target.value, revision: binding.revision },
            )
          }
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || !draft}
          onClick={() => {
            void s.saveQqMemoryBatchDrafts([binding.id]).then((ok) => {
              if (ok) onChanged();
            });
          }}
        >
          {t("library.save.batch.size")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            void s.organiseQqMemoryRow(binding).then((result) => {
              setVerdict(result);
              if (result?.status === "queued") onChanged();
            });
          }}
        >
          {t("library.organise.now")}
        </Button>
        {draft && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => s.patchQqMemoryBatchDraft(binding.id, null)}
          >
            {t("library.discard.changes")}
          </Button>
        )}
      </div>
      {verdict && (
        <div role="status" className="space-y-1 text-sm">
          <p>{t(verdicts[verdict.status])}</p>
          {verdict.job_id && <JobRunLink ownerKind="memory_job" ownerId={verdict.job_id} />}
        </div>
      )}
    </div>
  );
}
