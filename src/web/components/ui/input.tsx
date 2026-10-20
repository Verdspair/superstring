import { cn } from "cn";
import type * as React from "react";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-[38px] w-full min-w-0 rounded-[6px] border border-border bg-card px-[12px] text-[13.5px] leading-normal text-foreground transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-destructive aria-invalid:bg-destructive/10 aria-invalid:ring-1 aria-invalid:ring-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
