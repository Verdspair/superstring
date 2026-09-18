import { useI18n } from "../i18n";
export function ProcessingStatus({ active }: { active: boolean }) {
  const t = useI18n();
  if (!active) return null;
  return (
    <div
      className="processing-status"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={t("正在处理")}
    >
      <span className="superstring-loading-ring" aria-hidden="true" />
      <span>{t("正在处理")}</span>
    </div>
  );
}
