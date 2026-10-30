import type { SystemComponentTarget } from "../../shared/contracts/tool-directory";
import type { ContextAllocationTarget } from "../features/context-allocation";
import type { SettingsRoute } from "./settings-routes";

export interface WorkspaceReturnContext {
  route: SettingsRoute;
  agentId: string | null;
  componentTarget: SystemComponentTarget | null;
  allocation: ContextAllocationTarget;
  focus: string | null;
  scroll: number[];
}
export function captureWorkspacePosition(): Pick<WorkspaceReturnContext, "focus" | "scroll"> {
  const element = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const attribute = element?.id
    ? ["id", element.id]
    : element?.getAttribute("data-testid")
      ? ["data-testid", element.getAttribute("data-testid")]
      : element?.getAttribute("aria-label")
        ? ["aria-label", element.getAttribute("aria-label")]
        : null;
  return {
    focus: attribute ? `[${attribute[0]}=${JSON.stringify(attribute[1])}]` : null,
    scroll: [...document.querySelectorAll<HTMLElement>("[data-workspace-scroll]")].map(
      (node) => node.scrollTop,
    ),
  };
}
export function restoreWorkspacePosition(context: WorkspaceReturnContext): void {
  requestAnimationFrame(() => {
    const elements = document.querySelectorAll<HTMLElement>("[data-workspace-scroll]");
    context.scroll.forEach((top, index) => {
      const node = elements[index];
      if (node) node.scrollTop = top;
    });
    if (context.focus)
      document.querySelector<HTMLElement>(context.focus)?.focus({ preventScroll: true });
  });
}
