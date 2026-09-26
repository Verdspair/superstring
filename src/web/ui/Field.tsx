import type { ReactNode } from "react";
import { Badge } from "../components/ui/badge";
import { FieldDescription, FieldTitle, Field as FormField } from "../components/ui/field";
import { useI18n } from "../i18n";

/** Business field labels compose the registry's field and badge primitives. */
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
  return (
    <FormField className="field min-w-0 [&>[data-slot=checkbox]]:w-4 [&>[data-slot=checkbox]]:self-start">
      <FieldTitle className="field-label">
        {t(label)}
        {tag && (
          <Badge variant="secondary" className="field-tag">
            {t(tag)}
          </Badge>
        )}
      </FieldTitle>
      {children}
      {info && <FieldDescription>{t(info)}</FieldDescription>}
    </FormField>
  );
}
