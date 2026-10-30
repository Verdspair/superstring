import { cn } from "cn";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import type * as React from "react";

function ScrollArea({
  className,
  children,
  contentSizing = "bounded",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  contentSizing?: "bounded" | "intrinsic";
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      data-content-sizing={contentSizing}
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          // Radix's intrinsic table wrapper must not size forms wider than the viewport.
          contentSizing === "bounded" && "[&>div]:block! [&>div]:w-full! [&>div]:min-w-0!",
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none select-none bg-transparent p-[3px] transition-colors data-horizontal:h-[var(--scrollbar-size)] data-horizontal:flex-col data-vertical:h-full data-vertical:w-[var(--scrollbar-size)]",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-[var(--scrollbar-thumb)] hover:bg-[var(--scrollbar-thumb-hover)] [@media(forced-colors:active)]:bg-[ButtonText]"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
