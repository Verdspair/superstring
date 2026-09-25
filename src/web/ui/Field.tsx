import type { ReactNode } from "react";
import { useI18n } from "../i18n";

export function Field({
  label,
  info,
  tag,
  children,
}: {
  label: string;
  info?: string;
  /** A short marker next to the label (the scheme page marks edited fields this way). */
  tag?: string;
  children: ReactNode;
}) {
  const t = useI18n();
  return (
    <div className="field">
      <span className="field-label">
        {t(label)}
        {tag && <span className="field-tag">{t(tag)}</span>}
      </span>
      {children}
      {info && <small>{t(info)}</small>}
    </div>
  );
}
