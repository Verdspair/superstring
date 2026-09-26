import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { type ReactElement, type ReactNode, useRef, useState } from "react";
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
  const container = anchor.current?.closest<HTMLElement>('[role="dialog"]') ?? undefined;
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
    const Item = kind === "context" ? ContextMenu.Item : DropdownMenu.Item;
    return items.map((item) => (
      <Item
        key={item.id}
        className={`action-menu-item${item.danger ? " danger" : ""}`}
        disabled={item.disabled}
        onSelect={() => choose(item)}
      >
        <Icon name={item.icon} />
        {item.label}
      </Item>
    ));
  };
  const trigger = disabled ? null : (
    <DropdownMenu.Root
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
      <DropdownMenu.Trigger asChild>
        <button type="button" className="action-menu-trigger" aria-label={triggerLabel}>
          <Icon name="more" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={container}>
        <DropdownMenu.Content
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
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
  return (
    <ContextMenu.Root
      open={contextOpen && !disabled}
      onOpenChange={(open) => {
        if (open) selected.current = false;
        setContextOpen(open);
      }}
    >
      <ContextMenu.Trigger
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
      </ContextMenu.Trigger>
      <ContextMenu.Portal container={container}>
        <ContextMenu.Content
          className="action-menu-content"
          aria-label={label}
          collisionPadding={8}
          onCloseAutoFocus={restore}
        >
          {content("context")}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
