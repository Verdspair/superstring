import { cn } from "cn";
import type * as React from "react";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-[76px] w-full rounded-[6px] border border-border bg-card px-[12px] py-[10px] text-[13.5px] leading-[1.5] text-foreground transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-destructive aria-invalid:bg-destructive/10 aria-invalid:ring-1 aria-invalid:ring-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
