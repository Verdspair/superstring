import { Ellipsis, type LucideIcon } from "lucide-react";
import { type ReactElement, type ReactNode, useRef } from "react";
import { Button } from "../../components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";

export type RecordAction = {
  label: string;
  icon: LucideIcon;
  run: () => void;
  disabled?: boolean;
  destructive?: boolean;
};
/** Keyboard, context and touch access share an action list, not an extra state owner. */
export function RecordActions({
  label,
  actions,
  children,
  disabled = false,
}: {
  label: string;
  actions: RecordAction[];
  children: (trigger: ReactNode) => ReactElement;
  disabled?: boolean;
}) {
  const invoked = useRef(false);
  const origin = useRef<HTMLElement | null>(null);
  const choose = (action: RecordAction) => {
    invoked.current = true;
    origin.current?.focus({ preventScroll: true });
    action.run();
  };
  const items = (kind: "context" | "dropdown") => {
    const Item = kind === "context" ? ContextMenuItem : DropdownMenuItem;
    return actions.map((action) => (
      <Item
        key={action.label}
        disabled={action.disabled}
        variant={action.destructive ? "destructive" : "default"}
        onSelect={() => choose(action)}
      >
        <action.icon />
        {action.label}
      </Item>
    ));
  };
  const trigger = disabled ? null : (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) invoked.current = false;
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          aria-label={label}
          onPointerDown={(e) => {
            origin.current = e.currentTarget;
          }}
          onKeyDown={(e) => {
            origin.current = e.currentTarget;
          }}
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(e) => {
          if (invoked.current) e.preventDefault();
        }}
      >
        {items("dropdown")}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) invoked.current = false;
      }}
    >
      <ContextMenuTrigger
        asChild
        disabled={disabled}
        onContextMenu={(e) => {
          origin.current = (e.target as HTMLElement).closest<HTMLElement>("button,[tabindex]");
        }}
        onKeyDown={(e) => {
          if (!disabled && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
            e.preventDefault();
            e.target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
          }
        }}
      >
        {children(trigger)}
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label={label}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (!invoked.current) origin.current?.focus({ preventScroll: true });
        }}
      >
        {items("context")}
      </ContextMenuContent>
    </ContextMenu>
  );
}
