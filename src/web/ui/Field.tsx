import { Children, cloneElement, isValidElement, type ReactNode, useId } from "react";
import { Badge } from "../components/ui/badge";
import { Checkbox } from "../components/ui/checkbox";
import {
  FieldDescription,
  FieldLabel,
  FieldTitle,
  Field as FormField,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { Slider } from "../components/ui/slider";
import { Textarea } from "../components/ui/textarea";
import { useI18n } from "../i18n";

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
  children,
}: {
  label: string;
  info?: string;
  tag?: string;
  children: ReactNode;
}) {
  const t = useI18n();
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
      {tag && (
        <Badge variant="secondary" className="field-tag">
          {t(tag)}
        </Badge>
      )}
    </>
  );
  return (
    <FormField
      aria-labelledby={labelId}
      className="field min-w-0 [&>[data-slot=checkbox]]:w-4 [&>[data-slot=checkbox]]:self-start"
    >
      {id ? (
        <FieldLabel id={labelId} htmlFor={id} className="field-label">
          {title}
        </FieldLabel>
      ) : (
        <FieldTitle id={labelId} className="field-label">
          {title}
        </FieldTitle>
      )}
      {items.map((child) =>
        child === control && isValidElement<ControlProps>(child)
          ? cloneElement(child, {
              id,
              "aria-labelledby":
                child.props["aria-labelledby"] ?? (child.props["aria-label"] ? undefined : labelId),
              "aria-describedby":
                [child.props["aria-describedby"], info ? infoId : undefined]
                  .filter(Boolean)
                  .join(" ") || undefined,
            })
          : child,
      )}
      {info && <FieldDescription id={infoId}>{t(info)}</FieldDescription>}
    </FormField>
  );
}
