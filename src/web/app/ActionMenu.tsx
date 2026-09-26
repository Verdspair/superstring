import { type ReactElement, type ReactNode, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "../ui/icons";

type MenuAction = {
  id: string;
  label: string;
  icon: Parameters<typeof Icon>[0]["name"];
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
};

/** One action model supplies pointer, keyboard and visible touch-friendly entry points. */
export function ActionMenu({
  label,
  triggerLabel = label,
  items,
  disabled = false,
  children,
}: {
  label: string;
  triggerLabel?: string;
  items: MenuAction[];
  disabled?: boolean;
  children: (trigger: ReactNode) => ReactElement;
}) {
  const anchor = useRef<HTMLElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const selected = useRef(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const choose = (item: MenuAction) => {
    selected.current = true;
    origin.current?.focus({ preventScroll: true });
    item.onSelect();
  };
  const restore = (event: Event) => {
    // An action may have opened a dialog or an inline editor that owns its next focus.
    event.preventDefault();
    if (!selected.current) origin.current?.focus({ preventScroll: true });
  };
  const content = (kind: "context" | "dropdown") => {
    const Item = kind === "context" ? ContextMenuItem : DropdownMenuItem;
    return items.map((item) => (
      <Item
        key={item.id}
        variant={item.danger ? "destructive" : "default"}
        disabled={item.disabled}
        onSelect={() => choose(item)}
      >
        <Icon name={item.icon} />
        {item.label}
      </Item>
    ));
  };
  const trigger = disabled ? null : (
    <DropdownMenu
      open={dropdownOpen}
      onOpenChange={(open) => {
        if (open) {
          selected.current = false;
          origin.current =
            anchor.current?.querySelector<HTMLButtonElement>(".action-menu-trigger") ??
            (document.activeElement as HTMLElement);
        }
        setDropdownOpen(open);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="action-menu-trigger shrink-0 text-muted-foreground"
          aria-label={triggerLabel}
        >
          <Icon name="more" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="action-menu-content"
        aria-label={label}
        align="end"
        sideOffset={6}
        collisionPadding={8}
        onCloseAutoFocus={(event) => {
          if (selected.current) event.preventDefault();
        }}
      >
        {content("dropdown")}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <ContextMenu
      open={contextOpen && !disabled}
      onOpenChange={(open) => {
        if (open) selected.current = false;
        setContextOpen(open);
      }}
    >
      <ContextMenuTrigger
        asChild
        disabled={disabled}
        ref={(node) => {
          anchor.current = node;
        }}
        onContextMenu={(event) => {
          const target = event.target as HTMLElement;
          origin.current = target.closest<HTMLElement>("button,[tabindex]") ?? anchor.current;
        }}
        onKeyDown={(event) => {
          if (disabled || !(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)))
            return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          event.target.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              clientX: rect.right,
              clientY: rect.bottom,
            }),
          );
        }}
      >
        {children(trigger)}
      </ContextMenuTrigger>

      <ContextMenuContent
        className="action-menu-content"
        aria-label={label}
        collisionPadding={8}
        onCloseAutoFocus={restore}
      >
        {content("context")}
      </ContextMenuContent>
    </ContextMenu>
  );
}
