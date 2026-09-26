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
        <div className="observability-page">
          <h2>{t("运行观测")}</h2>
          <p className="hint">{t("追踪 Web、OneBot、记忆与知识任务的完整运行链路。")}</p>
          <TraceExplorer />
        </div>
      </SettingsBody>
    </section>
  );
}
