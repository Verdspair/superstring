import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertDialogContent, AlertDialogTitle, AlertDialog as Root } from "./ui/alert-dialog";

/** Shared modal mechanics only; callers own actions and when successful work closes. */
export function AlertDialog({
  title,
  children,
  className = "",
  onCancel,
  escapeCloses = true,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  onCancel: () => void;
  escapeCloses?: boolean;
  busy?: boolean;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  return (
    <Root
      open
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
          event.preventDefault();
          contentRef.current?.querySelector<HTMLElement>("[data-dialog-cancel]")?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus?.isConnected) returnFocus.focus();
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
}: {
  message: string;
  confirmLabel?: string;
  onConfirm: () => unknown;
  onCancel: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
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
    <AlertDialog title={message} onCancel={onCancel} busy={busy || pending}>
      <AlertDialogFooter>
        <Button
          type="button"
          variant="outline"
          data-dialog-cancel
          disabled={busy || pending}
          onClick={onCancel}
        >
          {t("connections.cancel")}
        </Button>
        <Button
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
