import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { useSuperstringStore } from "../../store";
import { ObservabilityWorkspace } from "../observability/ObservabilityWorkspace";
import { ExecutionSettings } from "./execution-settings";
import { TaskLedger } from "./task-ledger";

/** 运行空间：执行台账、任务与审批、执行设置三个目的地在同一外壳内切换。 */
export function RunsWorkspace() {
  const { t } = useTranslation();
  const route = useSuperstringStore((s) => s.settingsRoute);
  const view = useSuperstringStore((s) => s.settingsView);
  const open = useSuperstringStore((s) => s.openSettingsRoute);
  // 从侧栏进「运行」＝执行台账；页内 Tab 才切到任务或执行设置（与接入一致）。
  const tab =
    view === "observability"
      ? "ledger"
      : route === "task-ledger"
        ? "tasks"
        : route === "execution-settings"
          ? "execution"
          : "ledger";
  return (
    <section className="flex h-full min-h-0 flex-col">
      <Tabs
        value={tab}
        onValueChange={(value) =>
          open(
            value === "tasks"
              ? "task-ledger"
              : value === "execution"
                ? "execution-settings"
                : "execution-ledger",
          )
        }
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="border-b px-6 py-3 lg:px-8">
          <TabsList className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-7">
            <TabsTrigger value="ledger">{t("connections.runs.ledger")}</TabsTrigger>
            <TabsTrigger value="tasks">{t("connections.tasks.title")}</TabsTrigger>
            <TabsTrigger value="execution">{t("connections.execution.title")}</TabsTrigger>
          </TabsList>
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
        <TabsContent value="execution" className="m-0 min-h-0 flex-1 overflow-y-auto">
          <ExecutionSettings />
        </TabsContent>
      </Tabs>
    </section>
  );
}
