import { AlertDialogFooter } from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { useI18n } from "../i18n";
import { AlertDialog } from "./AlertDialog";

export function ConfirmDialog({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useI18n();
  return (
    <AlertDialog title={message} onCancel={onCancel}>
      <AlertDialogFooter className="dialog-actions">
        <Button type="button" variant="outline" data-dialog-cancel onClick={onCancel}>
          {t("取消")}
        </Button>
        <Button type="button" variant="destructive" onClick={onConfirm}>
          {confirmLabel ?? t("确认")}
        </Button>
      </AlertDialogFooter>
    </AlertDialog>
  );
}
