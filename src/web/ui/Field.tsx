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

export function NumberField({
  value,
  min,
  max,
  step = 1,
  disabled = false,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
}
