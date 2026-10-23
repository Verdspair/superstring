import { type ReactNode, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AlertDialogContent, AlertDialogTitle, AlertDialog as Root } from "./ui/alert-dialog";

/** Shared modal mechanics only; callers own actions and when successful work closes. */
export function AlertDialog({
  title,
  children,
  className = "",
  onCancel,
  escapeCloses = true,
  busy = false,
  open,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  onCancel: () => void;
  escapeCloses?: boolean;
  busy?: boolean;
  /** 常挂载：调用方把原条件作为 open，关闭动画期间内容由 Radix Presence 保留。 */
  open: boolean;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Root
      open={open}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <AlertDialogContent
        ref={contentRef}
        className={`max-h-[85dvh] overflow-y-auto ${className}`}
        aria-modal="true"
        aria-busy={busy}
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (busy || !escapeCloses) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          event.preventDefault();
          contentRef.current?.querySelector<HTMLElement>("[data-dialog-cancel]")?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus.current?.isConnected) returnFocus.current.focus();
        }}
      >
        <AlertDialogTitle asChild>
          <strong>{title}</strong>
        </AlertDialogTitle>
        {children}
      </AlertDialogContent>
    </Root>
  );
}

import { AlertDialogFooter } from "./ui/alert-dialog";
import { Button } from "./ui/button";

export function ConfirmDialog({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
  open,
}: {
  message: string;
  confirmLabel?: string;
  onConfirm: () => unknown;
  onCancel: () => void;
  busy?: boolean;
  /** 常挂载：调用方把原条件作为 open，关闭动画期间内容由 Radix Presence 保留。 */
  open: boolean;
}) {
  const { t } = useTranslation();
  // 常挂载后 pending/invoking 跨开合保留；只由当前调用的 finally 复位，避免新一轮打开提前放行。
  const [pending, setPending] = useState(false);
  const invoking = useRef(false);
  const confirm = async () => {
    if (busy || invoking.current) return;
    invoking.current = true;
    setPending(true);
    try {
      await onConfirm();
    } finally {
      invoking.current = false;
      setPending(false);
    }
  };
  return (
    <AlertDialog open={open} title={message} onCancel={onCancel} busy={busy || pending}>
      <AlertDialogFooter>
        <Button
          tooltip={<Trans i18nKey="hints.complete.cancel" />}
          type="button"
          variant="outline"
          data-dialog-cancel
          disabled={busy || pending}
          onClick={onCancel}
        >
          {t("connections.cancel")}
        </Button>
        <Button
          tooltip={<Trans i18nKey="hints.complete.confirm" />}
          type="button"
          variant="destructive"
          disabled={busy || pending}
          onClick={() => void confirm()}
        >
          {confirmLabel ?? t("connections.confirm")}
        </Button>
      </AlertDialogFooter>
    </AlertDialog>
  );
}
