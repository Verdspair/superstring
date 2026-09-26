import { Badge } from "../components/ui/badge";
import { Spinner } from "../components/ui/spinner";
import { useI18n } from "../i18n";
export function ProcessingStatus({ active }: { active: boolean }) {
  const t = useI18n();
  if (!active) return null;
  return (
    <Badge
      variant="secondary"
      className="processing-status fixed right-4 bottom-10 z-40 gap-2 border px-3 py-2 shadow-sm"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={t("正在处理")}
    >
      <Spinner className="superstring-loading-ring motion-reduce:animate-none" aria-hidden="true" />
      <span>{t("正在处理")}</span>
    </Badge>
  );
}
