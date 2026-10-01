import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useSuperstringStore } from "../../store";
import { type CapabilityEntry, capabilityComponents } from "../../workspace/capability-catalog";

export function SystemComponents({ entry }: { entry: CapabilityEntry }) {
  const { t } = useTranslation();
  const open = useSuperstringStore((s) => s.openSystemComponent);
  return (
    <section
      className="space-y-3 rounded-lg border p-4"
      aria-label={t("connections.components.title")}
    >
      <h2 className="text-sm font-medium">{t("connections.components.title")}</h2>
      <div className="flex flex-wrap gap-2">
        {capabilityComponents(entry).map((component) => (
          <Button
            key={`${component.kind}:${component.id}`}
            variant="outline"
            size="sm"
            onClick={() => open(component)}
          >
            <Badge variant="outline" className="text-[10px]">
              {t(
                component.kind === "tool"
                  ? "connections.components.tools"
                  : "connections.components.skills",
              )}
            </Badge>
            <span className="font-mono text-xs">{component.id}</span>
          </Button>
        ))}
      </div>
    </section>
  );
}
