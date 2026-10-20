import { HelpCircle } from "lucide-react";
import { Children, cloneElement, isValidElement, type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "./ui/badge";
import { Checkbox } from "./ui/checkbox";
import { FieldDescription, FieldLabel, FieldTitle, Field as FormField } from "./ui/field";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Slider } from "./ui/slider";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const controls = new Set<unknown>([
  "input",
  "textarea",
  "select",
  Input,
  Textarea,
  NativeSelect,
  Checkbox,
  Slider,
]);
type ControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

/** Label a single field control; compound editors keep their own individual labels. */
export function Field({
  label,
  info,
  tag,
  tooltip,
  labelAside,
  unit,
  children,
}: {
  label: string;
  info?: string;
  tag?: string;
  tooltip?: ReactNode;
  labelAside?: ReactNode;
  unit?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const uid = useId();
  const labelId = `${uid}-label`;
  const infoId = `${uid}-description`;
  const items = Children.toArray(children);
  const control = items.find(
    (child) => isValidElement<ControlProps>(child) && controls.has(child.type),
  );
  const id = isValidElement<ControlProps>(control) ? (control.props.id ?? uid) : undefined;
  const title = (
    <>
      {t(label)}
      {tag && <Badge variant="secondary">{t(tag)}</Badge>}
    </>
  );
  const help = tooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          aria-label={t("hints.field.learnAbout", { "0": t(label) })}
        >
          <HelpCircle className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  ) : null;
  return (
    <FormField
      aria-labelledby={id ? undefined : labelId}
      className="min-w-0 gap-2 [&>[data-slot=checkbox]]:w-4 [&>[data-slot=checkbox]]:self-start"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] font-semibold leading-[1.5] text-foreground">
        {id ? (
          <FieldLabel
            id={labelId}
            htmlFor={id}
            className="text-[13px] font-semibold leading-normal text-foreground"
          >
            {title}
          </FieldLabel>
        ) : (
          <FieldTitle
            id={labelId}
            className="text-[13px] font-semibold leading-normal text-foreground"
          >
            {title}
          </FieldTitle>
        )}
        {help}
        {labelAside && (
          <span className="ml-auto text-[11.5px] font-normal text-[var(--text-tertiary)] tabular-nums">
            {labelAside}
          </span>
        )}
      </div>
      {items.map((child) =>
        child === control && isValidElement<ControlProps>(child)
          ? (() => {
              const input = cloneElement(child, {
                id,
                "aria-labelledby":
                  child.props["aria-labelledby"] ??
                  (child.props["aria-label"] ? undefined : labelId),
                "aria-describedby":
                  [child.props["aria-describedby"], info ? infoId : undefined]
                    .filter(Boolean)
                    .join(" ") || undefined,
              });
              return unit ? (
                <div key={child.key} className="relative min-w-0">
                  {input}
                  <span className="pointer-events-none absolute top-1/2 right-[12px] -translate-y-1/2 text-[12px] font-medium text-[var(--text-tertiary)]">
                    {unit}
                  </span>
                </div>
              ) : (
                input
              );
            })()
          : child,
      )}
      {info && (
        <FieldDescription id={infoId} className="text-[12.5px] leading-[1.6] text-muted-foreground">
          {t(info)}
        </FieldDescription>
      )}
    </FormField>
  );
}
