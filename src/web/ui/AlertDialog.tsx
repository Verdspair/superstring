import * as Alert from "@radix-ui/react-alert-dialog";
import { type ReactNode, useRef, useState } from "react";

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
    <Alert.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <Alert.Portal>
        <Alert.Overlay className="dialog-backdrop" role="presentation">
          <Alert.Content
            ref={contentRef}
            className={`confirm-dialog${className ? ` ${className}` : ""}`}
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
            <Alert.Title asChild>
              <strong>{title}</strong>
            </Alert.Title>
            {children}
          </Alert.Content>
        </Alert.Overlay>
      </Alert.Portal>
    </Alert.Root>
  );
}
