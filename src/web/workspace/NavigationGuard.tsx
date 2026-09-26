import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertDialog } from "../components/confirmation";
import { Button } from "../components/ui/button";
import { qqDraftChanges } from "../features/qq/draft-state";
import { translateNotice } from "../i18n";
import { useSuperstringStore } from "../store";

export function NavigationGuard() {
  const { t } = useTranslation();
  const state = useSuperstringStore();
  const [pending, setPending] = useState(false);
  if (!state.navigationConfirmOpen) return null;
  const run = async (operation: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    try {
      await operation();
    } finally {
      setPending(false);
    }
  };
  return (
    <AlertDialog
      title={t("workspace.this_section_has_unsaved_changes")}
      onCancel={state.cancelPendingNavigation}
      busy={pending}
      escapeCloses={false}
    >
      <p className="text-sm leading-relaxed">{translateNotice(state.navigationConfirmMessage)}</p>
      <p className="text-sm text-muted-foreground">
        {t("workspace.save_to_continue_discard_to_restore_saved_content_cancel_to_keep_your_dr")}
      </p>
      {qqDraftChanges(state).map((resource) => (
        <details key={resource.id} className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            {translateNotice(resource.resource)} ·{" "}
            {t("workspace.changes", { "0": resource.changes.length })}
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {resource.changes.map((change) => (
              <li key={change}>{translateNotice(change)}</li>
            ))}
          </ul>
        </details>
      ))}
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {translateNotice(state.error)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          data-dialog-cancel
          disabled={pending}
          onClick={state.cancelPendingNavigation}
        >
          {t("workspace.stay_here")}
        </Button>
        <Button
          variant="destructive"
          disabled={pending}
          onClick={() => void run(state.confirmDiscardAndContinue)}
        >
          {t("workspace.discard_and_continue")}
        </Button>
        <Button disabled={pending} onClick={() => void run(state.confirmSaveAndContinue)}>
          {t("workspace.save_and_continue")}
        </Button>
      </div>
    </AlertDialog>
  );
}
