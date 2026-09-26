import * as Tooltip from "@radix-ui/react-tooltip";
import type { ComponentProps } from "react";
import { Icon, type IconName } from "./Icon";

/** Icon-only controls always expose a name; the tooltip is supplementary. */
export function IconButton({
  label,
  icon,
  className = "",
  ...props
}: Omit<ComponentProps<"button">, "children" | "aria-label"> & { label: string; icon: IconName }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button type="button" {...props} aria-label={label} className={`icon-button ${className}`}>
          <Icon name={icon} />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="ui-tooltip" sideOffset={6}>
          {label}
          <Tooltip.Arrow className="ui-tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
