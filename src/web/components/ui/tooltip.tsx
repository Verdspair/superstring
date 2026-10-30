"use client";

import { cn } from "cn";
import { Slot, Tooltip as TooltipPrimitive } from "radix-ui";
import * as React from "react";

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

const TooltipPressContext = React.createContext<{
  pressed: boolean;
  begin(event: React.PointerEvent<HTMLElement>): void;
} | null>(null);

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [pressed, setPressed] = React.useState(false);
  const release = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => release.current?.(), []);
  const begin = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (release.current) return;
    const trigger = event.currentTarget;
    const document = trigger.ownerDocument;
    const pointerId = event.pointerId;
    setPressed(true);
    const finish = () => {
      document.removeEventListener("click", finish);
      document.removeEventListener("click", afterClick, true);
      document.removeEventListener("pointerup", pointerUp);
      document.removeEventListener("pointercancel", pointerCancel);
      document.defaultView?.removeEventListener("blur", finish);
      if (release.current === finish) release.current = null;
      setPressed(false);
    };
    const afterClick = () => {
      // A stopped bubble still releases after the original target's click handlers finish.
      queueMicrotask(() => {
        if (release.current === finish) finish();
      });
    };
    const pointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      // Releasing outside the trigger cannot activate its original click target.
      if (event.target instanceof Node && !trigger.contains(event.target)) finish();
    };
    const pointerCancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finish();
    };
    release.current = finish;
    document.addEventListener("click", finish);
    document.addEventListener("click", afterClick, true);
    document.addEventListener("pointerup", pointerUp);
    document.addEventListener("pointercancel", pointerCancel);
    document.defaultView?.addEventListener("blur", finish);
  }, []);
  const gesture = React.useMemo(() => ({ pressed, begin }), [pressed, begin]);
  return (
    <TooltipPressContext.Provider value={gesture}>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipPressContext.Provider>
  );
}

const TooltipStateSlot = React.forwardRef<HTMLElement, React.ComponentProps<typeof Slot.Root>>(
  function TooltipStateSlot(props, ref) {
    const { "data-state": tooltipState, ...triggerProps } = props as React.ComponentProps<
      typeof Slot.Root
    > & { "data-state"?: string };
    return <Slot.Root {...triggerProps} ref={ref} />;
  },
);

function TooltipTrigger({
  onFocus,
  onPointerDownCapture,
  preserveTriggerState = false,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger> & { preserveTriggerState?: boolean }) {
  const gesture = React.useContext(TooltipPressContext);
  const content =
    props.asChild && React.isValidElement<React.HTMLAttributes<HTMLElement>>(children)
      ? React.cloneElement(children, {
          // Slot composes child handlers first; register the press before that child can open help.
          onPointerDownCapture: (event) => {
            gesture?.begin(event);
            children.props.onPointerDownCapture?.(event);
          },
        })
      : children;
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onPointerDownCapture={(event) => {
        gesture?.begin(event);
        onPointerDownCapture?.(event);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        const surface = event.currentTarget.closest('[role="dialog"], [role="alertdialog"]');
        // Surface autofocus must not open a second dismissable layer before the user interacts.
        if (
          surface &&
          !(event.relatedTarget instanceof Node && surface.contains(event.relatedTarget))
        )
          event.preventDefault();
      }}
    >
      {preserveTriggerState ? <TooltipStateSlot>{content}</TooltipStateSlot> : content}
    </TooltipPrimitive.Trigger>
  );
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  style,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const gesture = React.useContext(TooltipPressContext);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm duration-[var(--motion-fast)] ease-[var(--ease-standard)] data-closed:ease-[var(--ease-exit)] data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0 data-[state=instant-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
        data-trigger-press={gesture?.pressed ? "true" : undefined}
        style={gesture?.pressed ? { ...style, pointerEvents: "none" } : style}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
