import type { ReactNode } from "react";
import { WorkspaceHelp } from "./WorkspaceHelp";

/**
 * Shared root-workspace page header. Presentation only: the location line, a
 * title row with the page help tooltip and page actions, plus a 24px gap before
 * the page body. The page description lives in the tooltip, not in the body.
 */
export function WorkspacePageHeader({
  location,
  title,
  description,
  actions,
  backAction,
}: {
  location: string;
  title: string;
  description: string;
  actions?: ReactNode;
  backAction?: ReactNode;
}) {
  return (
    <header className="workspace-page-header mb-[24px]">
      <div className="workspace-page-location flex flex-wrap items-center gap-1.5">
        {backAction}
        {backAction && <span aria-hidden="true">›</span>}
        <p className="m-0 leading-[20px]">{location}</p>
      </div>
      <div className="flex min-h-[42px] flex-wrap items-center gap-2">
        <h1 className="workspace-page-title min-w-0 break-words">{title}</h1>
        <WorkspaceHelp title={title} description={description} />
        {actions && <div className="ml-auto flex shrink-0 items-center gap-[8px]">{actions}</div>}
      </div>
    </header>
  );
}
