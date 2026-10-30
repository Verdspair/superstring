import { cn } from "cn";
import { ChevronDownIcon } from "lucide-react";
import type * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> & {
  size?: "sm" | "default";
  selectClassName?: string;
  tooltip?: React.ReactNode;
};

function NativeSelect({
  className,
  selectClassName,
  tooltip,
  size = "default",
  ...props
}: NativeSelectProps) {
  const control = (
    <select
      data-slot="native-select"
      data-size={size}
      className={cn(
        "h-[38px] w-full min-w-0 appearance-none rounded-[8px] border border-border bg-card pr-[32px] pl-[12px] text-[13.5px] leading-normal text-foreground transition-colors outline-none select-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary disabled:pointer-events-none disabled:cursor-not-allowed aria-invalid:border-destructive aria-invalid:bg-destructive/10 aria-invalid:ring-1 aria-invalid:ring-destructive data-[size=sm]:h-[32px] data-[size=sm]:rounded-[8px] data-[size=sm]:px-2.5 data-[size=sm]:text-[12.5px]",
        selectClassName,
      )}
      {...props}
    />
  );
  return (
    <div
      className={cn(
        "group/native-select relative w-fit has-[select:disabled]:opacity-50",
        className,
      )}
      data-slot="native-select-wrapper"
      data-size={size}
    >
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild preserveTriggerState>
            {control}
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        control
      )}
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({ className, ...props }: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-card text-foreground", className)}
      {...props}
    />
  );
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-card text-foreground", className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
