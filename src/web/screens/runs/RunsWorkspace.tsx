import { Settings2 } from "lucide-react";
import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { useSuperstringStore } from "../../store";
import { ObservabilityWorkspace } from "../observability/ObservabilityWorkspace";
import { TaskLedger } from "./task-ledger";

/** 运行空间：执行台账与任务与审批；执行设置只在系统能力中编辑，这里保留直达链接。 */
export function RunsWorkspace() {
  const { t } = useTranslation();
  const route = useSuperstringStore((s) => s.settingsRoute);
  const view = useSuperstringStore((s) => s.settingsView);
  const open = useSuperstringStore((s) => s.openSettingsRoute);
  // 从侧栏进「运行」＝执行台账；页内 Tab 才切到任务（与接入一致）。
  const tab = view === "observability" ? "ledger" : route === "task-ledger" ? "tasks" : "ledger";
  return (
    <section className="flex h-full min-h-0 flex-col">
      <Tabs
        value={tab}
        onValueChange={(value) => open(value === "tasks" ? "task-ledger" : "execution-ledger")}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <TabsList className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-7">
            <TabsTrigger value="ledger">{t("connections.runs.ledger")}</TabsTrigger>
            <TabsTrigger value="tasks">{t("connections.tasks.title")}</TabsTrigger>
          </TabsList>
          <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {t("capabilities.runs.moveNote")}
            <Button variant="outline" size="sm" onClick={() => open("execution-settings")}>
              <Settings2 />
              {t("connections.execution.title")}
            </Button>
          </span>
        </div>
        <TabsContent
          value="ledger"
          className="m-0 min-h-0 flex-1 overflow-y-auto"
          data-workspace-scroll
        >
          <Suspense fallback={null}>
            <ObservabilityWorkspace />
          </Suspense>
        </TabsContent>
        <TabsContent value="tasks" className="m-0 min-h-0 flex-1 overflow-y-auto">
          <TaskLedger />
        </TabsContent>
      </Tabs>
    </section>
  );
}
