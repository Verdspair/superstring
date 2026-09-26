import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Chevron, Icon } from "../ui/icons";
import { APP_SECTIONS, openAppSection } from "./app-routes";
import { SettingsHeader } from "./SettingsHeader";
import { SettingsBody } from "./SettingsSidebar";

export function SettingsHub() {
  const t = useI18n();
  const entries = APP_SECTIONS.filter((section) => section.id !== "conversations").map(
    (section) => ({
      ...section,
      action: () => openAppSection(useSuperstringStore.getState(), section.id),
    }),
  );
  return (
    <section className="page settings-page flex h-full min-h-0 flex-col">
      <SettingsHeader />
      <SettingsBody>
        <div className="settings-content settings-hub space-y-4">
          <h2 className="text-sm font-medium">{t("功能设置")}</h2>
          <nav className="settings-list grid gap-4 md:grid-cols-2" aria-label={t("功能设置")}>
            {entries.map((entry) => (
              <Card key={entry.title} className="py-0 shadow-none">
                <CardContent className="p-0">
                  <Button
                    variant="ghost"
                    type="button"
                    className="settings-entry h-auto min-h-24 w-full justify-start gap-4 px-5 py-4 text-left whitespace-normal [&>svg]:size-5"
                    aria-label={t(entry.title)}
                    onClick={entry.action}
                  >
                    <Icon name={entry.icon} />
                    <span className="settings-entry-copy flex min-w-0 flex-1 flex-col gap-1">
                      <strong>{t(entry.title)}</strong>
                      <small className="font-normal leading-relaxed text-muted-foreground">
                        {t(entry.note)}
                      </small>
                    </span>
                    <span className="entry-arrow text-muted-foreground" aria-hidden="true">
                      <Chevron />
                    </span>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </nav>
        </div>
      </SettingsBody>
    </section>
  );
}
