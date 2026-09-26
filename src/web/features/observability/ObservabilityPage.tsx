import { SettingsHeader } from "../../app/SettingsHeader";
import { SettingsBody } from "../../app/SettingsSidebar";
import { useI18n } from "../../i18n";
import { TraceExplorer } from "./TraceExplorer";
export function ObservabilityPage() {
  const t = useI18n();
  return (
    <section className="page settings-page">
      <SettingsHeader />
      <SettingsBody>
        <div className="observability-page mx-auto flex w-full max-w-[1800px] min-w-0 flex-col gap-4 p-4 md:p-6">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("追踪 Web、OneBot、记忆与知识任务的完整运行链路。")}
          </p>
          <TraceExplorer />
        </div>
      </SettingsBody>
    </section>
  );
}
