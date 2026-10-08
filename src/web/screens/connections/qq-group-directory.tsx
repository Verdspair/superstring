import { Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { filterQqGroupRows, projectQqGroupRows } from "../../features/qq/group-directory";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";

/**
 * QQ 应用级本群配置目录：展示所有已绑定的 QQ 群，跨方案列出。
 * 支持搜索群显示名、群号、账号、方案名、Agent 名；点击进入对应群的本群配置。
 */
export function QqGroupDirectory({ active = true }: { active?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");

  const state = useSuperstringStore(
    useShallow((s) => ({
      qqBindings: s.qqBindings,
      qqBindingsLoaded: s.qqBindingsLoaded,
      qqBindingsLoading: s.qqBindingsLoading,
      qqBindingsError: s.qqBindingsError,
      qqSchemes: s.qqSchemes,
      qqSchemesLoading: s.qqSchemesLoading,
      qqGroupConfigSaving: s.qqGroupConfigSaving,
      qqSchemeSaving: s.qqSchemeSaving,
      qqAccessSaving: s.qqAccessSaving,
      agents: s.agents,
      summaryById: s.summaryById,
      loadQqBindings: s.loadQqBindings,
      loadQqSchemes: s.loadQqSchemes,
      openQqGroupConfig: s.openQqGroupConfig,
      openSettingsRoute: s.openSettingsRoute,
    })),
  );

  const {
    qqBindings,
    qqBindingsLoaded,
    qqBindingsLoading,
    qqBindingsError,
    qqSchemes,
    qqSchemesLoading,
    qqGroupConfigSaving,
    qqSchemeSaving,
    qqAccessSaving,
    agents,
    summaryById,
    loadQqBindings,
    loadQqSchemes,
    openQqGroupConfig,
    openSettingsRoute,
  } = state;

  const busy =
    qqGroupConfigSaving ||
    qqSchemeSaving ||
    qqAccessSaving ||
    qqBindingsLoading ||
    qqSchemesLoading;

  useEffect(() => {
    if (!active) return;
    void loadQqBindings();
    void loadQqSchemes({ background: true, editor: false });
  }, [active, loadQqBindings, loadQqSchemes]);

  const allRows = useMemo(
    () => projectQqGroupRows({ qqBindings, qqSchemes, agents, summaryById }),
    [qqBindings, qqSchemes, agents, summaryById],
  );

  const visibleRows = useMemo(
    () => filterQqGroupRows(allRows, query, i18n.language),
    [allRows, query, i18n.language],
  );

  const refresh = async () => {
    if (busy) return;
    await Promise.all([
      loadQqBindings(true),
      loadQqSchemes({ refresh: true, background: true, editor: false }),
    ]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="relative min-w-52 max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            aria-label={t("schemes.qq.groups.search")}
            placeholder={t("schemes.qq.groups.searchPlaceholder")}
            value={query}
            disabled={busy}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw className="size-3.5" />
          {t("schemes.refresh")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => openSettingsRoute("scheme-bindings")}
        >
          <Plus className="size-3.5" />
          {t("schemes.bindings.entry")}
        </Button>
      </div>

      {!qqBindingsLoaded && qqBindingsLoading && (
        <div className="p-6">
          <p role="status" className="text-sm text-muted-foreground">
            {t("schemes.bindings.reading")}
          </p>
        </div>
      )}

      {!qqBindingsLoaded && !qqBindingsLoading && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="space-y-1">
            <p role="alert" className="text-sm text-destructive">
              {t("schemes.bindings.loadFailed")}
            </p>
            {qqBindingsError && (
              <p className="text-xs text-muted-foreground">{translateNotice(qqBindingsError)}</p>
            )}
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
            {t("capabilities.retry")}
          </Button>
        </div>
      )}

      {qqBindingsLoaded && (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6" data-workspace-scroll>
          {allRows.length === 0 && (
            <div className="flex flex-col items-start gap-3 rounded-xl border p-6">
              <p className="text-sm text-muted-foreground">{t("schemes.qq.groups.emptyNote")}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => openSettingsRoute("scheme-bindings")}
              >
                <Plus className="size-3.5" />
                {t("schemes.bindings.entry")}
              </Button>
            </div>
          )}

          {allRows.length > 0 && visibleRows.length === 0 && (
            <div className="rounded-xl border p-6">
              <p role="status" className="text-sm text-muted-foreground">
                {t("schemes.qq.groups.noMatch")}
              </p>
            </div>
          )}

          {visibleRows.length > 0 && (
            <ul className="divide-y overflow-hidden rounded-xl border">
              {visibleRows.map((row) => (
                <li key={row.bindingId}>
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {row.title && <span className="text-sm font-medium">{row.title}</span>}
                        <Badge variant="outline" className="font-mono text-xs">
                          {t("connections.group")} {row.peerId}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {t("schemes.qq.groupConfig.account")} {row.accountId}
                        </span>
                        {row.paused && <Badge variant="secondary">{t("connections.paused")}</Badge>}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>
                          {t("schemes.qq.groupConfig.baseScheme")}: {row.schemeName}
                        </span>
                        <span>·</span>
                        <span>
                          {t("schemes.qq.groupConfig.agent")}: {row.agentName}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      className="h-auto min-h-8 shrink-0 whitespace-normal"
                      onClick={() => openQqGroupConfig(row.bindingId)}
                    >
                      {t("schemes.qq.groupConfig.controls.configure")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
