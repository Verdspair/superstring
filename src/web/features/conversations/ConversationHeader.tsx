import type { ReactNode } from "react";
import { HeadingIcon } from "../../ui/icons";

export function ConversationHeader({
  title,
  detail,
  actions,
  className = "",
}: {
  title: string;
  detail?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={`page-header conversation-header flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-4 md:px-6 ${className}`}
    >
      <div className="page-heading-copy min-w-0 flex-1">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight [&>svg]:size-5">
            <HeadingIcon name="chat" />
            <span className="truncate">{title}</span>
          </h1>
          {detail && (
            <p className="page-heading-description mt-1 truncate text-xs text-muted-foreground">
              {detail}
            </p>
          )}
        </div>
      </div>
      <div className="conversation-header-actions flex shrink-0 items-center gap-2">{actions}</div>
    </header>
  );
}
