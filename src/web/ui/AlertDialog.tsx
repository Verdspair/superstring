import { type ReactNode, useRef, useState } from "react";
import {
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialog as Root,
} from "../components/ui/alert-dialog";

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
        className={`confirm-dialog max-h-[85dvh] overflow-y-auto ${className}`}
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
