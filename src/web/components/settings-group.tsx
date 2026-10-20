import { cn } from "cn";
import type { ComponentType, ReactNode } from "react";

export interface SettingsGroupProps {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  children: ReactNode;
  className?: string;
  containerClassName?: string;
}

export function SettingsGroup({
  title,
  description,
  action,
  icon: Icon,
  children,
  className,
  containerClassName,
}: SettingsGroupProps) {
  return (
    <section className={cn("space-y-4", className)}>
      {(title || description || action) && (
        <div className="flex flex-wrap items-start justify-between gap-4 px-0.5">
          <div className="min-w-0 flex-1 space-y-2">
            {title && (
              <div className="flex items-center gap-2">
                {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
                <h2 className="text-[15px] font-bold tracking-tight text-foreground">{title}</h2>
              </div>
            )}
            {description && (
              <p className="text-[12.5px] text-muted-foreground leading-[1.6]">{description}</p>
            )}
          </div>
          {action && <div className="min-w-0 max-w-full pt-0.5">{action}</div>}
        </div>
      )}
      <div
        className={cn(
          "overflow-hidden rounded-[10px] border border-border bg-card text-card-foreground divide-y divide-border",
          containerClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

export interface SettingsRowProps {
  label?: ReactNode;
  description?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function SettingsRow({
  label,
  description,
  icon: Icon,
  action,
  children,
  className,
}: SettingsRowProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5",
        className,
      )}
    >
      {(label || description || Icon) && (
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {Icon && (
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-muted text-muted-foreground">
              <Icon className="size-4" />
            </div>
          )}
          <div className="min-w-0 space-y-1.5">
            {label && <div className="text-[13.5px] font-medium text-foreground">{label}</div>}
            {description && (
              <div className="text-xs text-muted-foreground leading-[1.6]">{description}</div>
            )}
          </div>
        </div>
      )}
      {(children || action) && (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3 sm:ml-auto">
          {children}
          {action}
        </div>
      )}
    </div>
  );
}
