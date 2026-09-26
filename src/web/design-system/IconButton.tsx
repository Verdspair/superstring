import type { ComponentProps } from "react";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { Icon, type IconName } from "./Icon";

/** Icon-only controls always expose a name; the tooltip is supplementary. */
export function IconButton({
  label,
  icon,
  className = "",
  ...props
}: Omit<ComponentProps<"button">, "children" | "aria-label"> & { label: string; icon: IconName }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          {...props}
          aria-label={label}
          className={`icon-button ${className}`}
        >
          <Icon name={icon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="ui-tooltip" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
