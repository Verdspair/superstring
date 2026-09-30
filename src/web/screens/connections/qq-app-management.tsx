import { ChevronLeft, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { StorageInventory } from "./storage-inventory";
import { TransportSettings } from "./transport-settings";

export type QqAppView = "schemes" | "connection" | "data";

export function QqAppManagement({
  view,
  schemesView,
}: {
  view: QqAppView;
  schemesView?: ReactNode;
}) {
  const { t } = useTranslation();
  const s = useSuperstringStore();
  const busy = s.qqSchemeSaving || s.qqAccessSaving || s.qqStorageSaving || s.qqSchemesLoading;
  const back = () => s.openSettingsRoute("scheme-library");
  const openView = (next: string) =>
    s.openSettingsRoute(
      next === "connection" ? "qq-connection" : next === "data" ? "qq-storage" : "qq-app-schemes",
    );
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t("schemes.qq.appTitle")}
      data-qq-app-view={view}
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("schemes.backToCatalog")}
          disabled={busy}
          onClick={back}
        >
          <ChevronLeft />
        </Button>
        <h1 className="text-xl font-semibold tracking-tight">{t("schemes.qq.name")}</h1>
        <Tabs value={view} onValueChange={openView} className="ml-auto min-w-0 max-w-full">
          <TabsList className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-auto [&_[role=tab]]:min-h-8 [&_[role=tab]]:max-w-full [&_[role=tab]]:flex-none [&_[role=tab]]:whitespace-normal">
            <TabsTrigger value="schemes" disabled={busy}>
              {t("workspace.schemes")}
            </TabsTrigger>
            <TabsTrigger value="connection" disabled={busy}>
              {t("connections.transportPage.tab")}
            </TabsTrigger>
            <TabsTrigger value="data" disabled={busy}>
              {t("connections.dataRetention")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>
      {view !== "schemes" && (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          {t("schemes.qq.scopeNote")}
        </p>
      )}
      {view !== "schemes" && (s.error || s.feedback) && (
        <div className="border-b px-4 py-2">
          {s.error ? (
            <p role="alert" className="text-sm text-destructive">
              {translateNotice(s.error)}
            </p>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {translateNotice(s.feedback)}
            </p>
          )}
        </div>
      )}
      {view === "schemes" && <div className="flex min-h-0 flex-1 flex-col">{schemesView}</div>}
      {view === "connection" && <QqConnectionTab />}
      {view === "data" && (
        <div className="min-h-0 flex-1 overflow-y-auto" data-workspace-scroll>
          <StorageInventory />
        </div>
      )}
    </section>
  );
}

const connectionPhaseLabels: Record<string, string> = {
  unavailable: "connections.thisProcessHasNoTransportRuntime",
  idle: "connections.notConnected",
  connecting: "connections.connecting",
  verifying: "connections.verifying",
  ready: "connections.connected",
  closed: "connections.connectionClosed",
};

function QqConnectionTab() {
  const { t } = useTranslation();
  const s = useSuperstringStore();
  const { loadQqAccess } = s;
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await s.refreshQqConnection();
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => {
    // 整页读取是进入连接页的起载：只读设置与状态，绝不自动推进连接草稿的保存基线。
    void loadQqAccess();
  }, [loadQqAccess]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6" data-workspace-scroll>
      {s.qqSettings ? (
        <>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge variant={s.qqConnection?.phase === "ready" ? "secondary" : "outline"}>
                {s.qqConnection
                  ? t(connectionPhaseLabels[s.qqConnection.phase] ?? "connections.unknown")
                  : t("connections.unknown")}
              </Badge>
              <p className="text-sm text-muted-foreground">{t("connections.transportPage.hint")}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={s.qqAccessSaving || s.qqAccessLoading || refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw />
              {t("connections.refreshState")}
            </Button>
          </div>
          <TransportSettings />
        </>
      ) : s.qqAccessLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("connections.readingTheAccessState")}
        </p>
      ) : (
        // 读取失败不永远停在 loading：给出可重试入口；具体原因由页首统一显示。
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {t("connections.accessStateFailed")}
          </p>
          <Button variant="outline" size="sm" onClick={() => void loadQqAccess()}>
            {t("capabilities.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}
