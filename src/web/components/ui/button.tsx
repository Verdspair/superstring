import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";
import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[6px] border border-transparent bg-clip-padding text-[13px] font-semibold whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform,translate] duration-[var(--motion-fast)] active:not-aria-[haspopup]:translate-y-px outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-[0.42] aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--button-primary-bg,var(--primary))] text-[var(--button-primary-fg,var(--primary-foreground))] border-[var(--button-primary-border,var(--primary))] hover:bg-[var(--button-primary-hover,var(--primary-hover,color-mix(in_oklch,var(--primary),black_10%)))] hover:border-[var(--button-primary-hover-border,var(--primary-hover,color-mix(in_oklch,var(--primary),black_10%)))]",
        outline:
          "border-border bg-card text-foreground hover:bg-muted hover:border-[var(--border-hover,var(--border))] aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary:
          "bg-card text-foreground border-[var(--border-strong,var(--border))] hover:bg-muted hover:border-[var(--border-hover,var(--border))] aria-expanded:bg-muted aria-expanded:text-foreground disabled:opacity-[0.38]",
        accent:
          "bg-accent text-accent-foreground border-accent hover:bg-[var(--accent-hover,color-mix(in_oklch,var(--accent),var(--foreground)_5%))] hover:border-[var(--accent-hover,color-mix(in_oklch,var(--accent),var(--foreground)_5%))]",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive border-transparent hover:bg-destructive/20 focus-visible:border-destructive focus-visible:ring-1 focus-visible:ring-destructive",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[38px] gap-[8px] px-[16px] text-[13px] font-semibold leading-[1.5]",
        xs: "h-6 gap-1 rounded-[4px] px-2 text-xs in-data-[slot=button-group]:rounded-[4px] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-[32px] gap-[6px] rounded-[6px] px-[12px] text-[12.5px] font-semibold leading-[1.5] in-data-[slot=button-group]:rounded-[6px] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-2 px-5 text-sm font-semibold",
        icon: "size-[38px] rounded-[6px]",
        "icon-xs":
          "size-6 rounded-[4px] in-data-[slot=button-group]:rounded-[4px] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 rounded-[6px] in-data-[slot=button-group]:rounded-[6px]",
        "icon-lg": "size-10 rounded-[6px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    tooltip?: React.ReactNode;
    disabledReason?: React.ReactNode;
  };

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "default",
    size = "default",
    asChild = false,
    tooltip,
    disabledReason,
    title,
    disabled,
    ...props
  },
  ref,
) {
  const Comp = asChild ? Slot.Root : "button";

  const effectiveTooltip = disabled && disabledReason ? disabledReason : tooltip;

  const buttonElement = (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled}
      title={effectiveTooltip ? undefined : title}
      {...props}
    />
  );

  if (!effectiveTooltip) {
    return buttonElement;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* biome-ignore lint/a11y/useSemanticElements: This inline group exposes a disabled control explanation without using a form fieldset. */}
        <span
          tabIndex={disabled ? 0 : undefined}
          className={cn(
            "inline-flex",
            disabled &&
              "cursor-not-allowed focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2",
          )}
          role="group"
          aria-label={
            disabled
              ? (props["aria-label"] ??
                (typeof props.children === "string" ? props.children : undefined))
              : undefined
          }
          aria-disabled={disabled || undefined}
        >
          {buttonElement}
        </span>
      </TooltipTrigger>
      <TooltipContent>{effectiveTooltip}</TooltipContent>
    </Tooltip>
  );
});

export { Button, buttonVariants };
