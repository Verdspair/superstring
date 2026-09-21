import type { ReactNode } from "react";
import { useI18n } from "../i18n";

export function Field({
  label,
  info,
  children,
}: {
  label: string;
  info?: string;
  children: ReactNode;
}) {
  const t = useI18n();
  return (
    <div className="field">
      <span className="field-label">{t(label)}</span>
      {children}
      {info && <small>{t(info)}</small>}
    </div>
  );
}
