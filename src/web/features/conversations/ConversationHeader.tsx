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
    <header className={`page-header conversation-header ${className}`}>
      <div>
        <h1>
          <HeadingIcon name="chat" />
          <span>{title}</span>
        </h1>
        {detail && <p>{detail}</p>}
      </div>
      <div className="conversation-header-actions">{actions}</div>
    </header>
  );
}
