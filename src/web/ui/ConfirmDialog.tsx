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
      <div className="dialog-actions">
        <button type="button" data-dialog-cancel onClick={onCancel}>
          {t("取消")}
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          {confirmLabel ?? t("确认")}
        </button>
      </div>
    </AlertDialog>
  );
}
