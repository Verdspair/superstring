import { cn } from "cn";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

export interface CatalogItemProps {
  /** Always-visible row header; its text is the trigger's accessible name. */
  summary: ReactNode;
  /** Separate action zone next to the trigger, never nested inside it. */
  actions?: ReactNode;
  /** Collapsed detail body; unmounted while the item is closed. */
  children: ReactNode;
  /** Dims the summary only; actions stay rendered and operable. */
  muted?: boolean;
  /** Controlled disclosure, e.g. a caller revealing rows that match a query. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function CatalogItem({
  summary,
  actions,
  children,
  muted = false,
  open,
  onOpenChange,
}: CatalogItemProps) {
  return (
    <Collapsible
      data-slot="catalog-item"
      className="group/catalog-item w-full"
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="flex min-w-0 flex-col items-stretch gap-1 sm:flex-row sm:items-start sm:gap-2">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="h-auto min-w-0 flex-1 shrink items-start justify-start gap-2 whitespace-normal px-2 py-1.5 text-left font-normal"
          >
            <ChevronDownIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-[var(--motion-fast)] ease-[var(--ease-standard)] group-data-[state=open]/catalog-item:rotate-180"
            />
            <span className={cn("min-w-0 flex-1", muted && "opacity-60")}>{summary}</span>
          </Button>
        </CollapsibleTrigger>
        {actions ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1 sm:shrink-0">
            {actions}
          </div>
        ) : null}
      </div>
      <CollapsibleContent>
        <div className="min-w-0 px-2 pb-2 [overflow-wrap:anywhere]">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
