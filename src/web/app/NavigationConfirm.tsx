import { useRef, useState } from "react";
import { translateNotice, useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { AlertDialog } from "../ui/AlertDialog";

export function NavigationConfirm() {
  const t = useI18n();
  const navigationConfirmMessage = useSuperstringStore((state) => state.navigationConfirmMessage);
  const confirmSaveAndContinue = useSuperstringStore((state) => state.confirmSaveAndContinue);
  const confirmDiscardAndContinue = useSuperstringStore((state) => state.confirmDiscardAndContinue);
  const cancelPendingNavigation = useSuperstringStore((state) => state.cancelPendingNavigation);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <AlertDialog
      title={t("当前分区有未保存修改")}
      className="navigation-confirm"
      onCancel={cancelPendingNavigation}
      escapeCloses={false}
      busy={busy}
    >
      <p>{translateNotice(navigationConfirmMessage)}</p>
      <p>{t("保存成功后继续；放弃将恢复已保存内容；取消保留当前草稿。")}</p>
      <div className="dialog-actions three">
        <button type="button" disabled={busy} onClick={() => void run(confirmSaveAndContinue)}>
          {t("保存并继续")}
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void run(confirmDiscardAndContinue)}
        >
          {t("放弃修改并继续")}
        </button>
        <button type="button" data-dialog-cancel disabled={busy} onClick={cancelPendingNavigation}>
          {t("取消离开")}
        </button>
      </div>
    </AlertDialog>
  );
}
