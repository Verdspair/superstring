import { AlertCircle, BookOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SkillDetailResponse } from "../../../shared/contracts/skill";
import { CatalogItem } from "../../components/catalog-item";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { useSkillsResource } from "../../services/connection-resources";
import { type ReadTask, startRead } from "../../services/read-task";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";
import { SKILL_HUMAN_LABELS } from "../../workspace/capability-catalog";

export function SkillsPanel({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const apiClient = useSuperstringStore((s) => s.apiClient);
  const target = useSuperstringStore((s) => s.componentTarget);
  const returnTarget = useSuperstringStore((s) => s.returnWorkspaceTarget);
  const hasReturn = useSuperstringStore((s) => s.workspaceReturns.length > 0);
  const {
    data: catalog,
    loading,
    error: readError,
    refresh,
  } = useSkillsResource(apiClient, active);
  const [detail, setDetail] = useState<SkillDetailResponse | null>(null);
  const [error, setError] = useState("");
  const pendingDetail = useRef<ReadTask | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: Replacing the API cancels detail reads from the previous client.
  useEffect(() => {
    if (!active) {
      pendingDetail.current?.cancel();
      pendingDetail.current = null;
    }
    return () => pendingDetail.current?.cancel();
  }, [active, apiClient]);
  const open = useCallback(
    (name: string) => {
      pendingDetail.current?.cancel();
      setError("");
      pendingDetail.current = startRead((signal) => apiClient.getSkill(name, signal), {
        success: setDetail,
        failure: (caught) => setError(errorText(caught)),
      });
    },
    [apiClient],
  );
  useEffect(() => {
    if (active && target?.kind === "skill") open(target.id);
  }, [active, target, open]);
  const metadata = Object.entries(detail?.metadata ?? {});
  return (
    <div className="w-full min-w-0 space-y-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <BookOpen className="size-5 text-primary" />
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {t("connections.skills.title")}
            </h2>
          </div>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {t("connections.skills.description")}
          </p>
        </div>
        <Button
          variant="outline"
          tooltip={t("hints.extensions.skills.refresh")}
          disabled={loading}
          onClick={refresh}
          className="gap-2 shrink-0"
        >
          <RefreshCw
            className={
              loading ? "size-4 animate-spin text-muted-foreground" : "size-4 text-muted-foreground"
            }
          />
          {t("connections.common.refresh")}
        </Button>
      </div>
      {(readError || error) && (
        <p role="alert" className="text-sm text-destructive">
          {readError || error}
        </p>
      )}
      <div className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground">
        <div className="divide-y divide-border/60">
          {[...(catalog?.skills ?? [])]
            .sort((a, b) => Number(b.globalEnabled) - Number(a.globalEnabled))
            .map((skill) => {
              const humanKey = SKILL_HUMAN_LABELS[skill.name];
              return (
                <div
                  key={skill.name}
                  data-skill-name={skill.name}
                  data-global-enabled={skill.globalEnabled}
                >
                  <CatalogItem
                    muted={!skill.globalEnabled}
                    open={expanded[skill.name] ?? false}
                    onOpenChange={(next) =>
                      setExpanded((previous) => ({ ...previous, [skill.name]: next }))
                    }
                    summary={
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          {humanKey && (
                            <span className="text-sm font-medium text-foreground">
                              {t(humanKey)}
                            </span>
                          )}
                          <span className="font-mono text-sm font-medium text-foreground">
                            {skill.name}
                          </span>
                          <Badge variant="outline">
                            {t(
                              skill.origin === "system"
                                ? "connections.components.system"
                                : "connections.skills.documentSkill",
                            )}
                          </Badge>
                          {!skill.globalEnabled && (
                            <span className="text-xs text-muted-foreground">
                              {t("connections.components.globalOff")}
                            </span>
                          )}
                        </div>
                      </div>
                    }
                    actions={
                      <Button
                        variant="ghost"
                        size="sm"
                        tooltip={t("hints.extensions.skills.view")}
                        onClick={() => open(skill.name)}
                      >
                        {t("connections.skills.view")}
                      </Button>
                    }
                  >
                    <p className="whitespace-normal break-words text-sm leading-relaxed">
                      {skill.origin === "system"
                        ? t(`connections.components.skillSummary.${skill.name}`, {
                            defaultValue: skill.description,
                          })
                        : skill.description}
                    </p>
                  </CatalogItem>
                </div>
              );
            })}
          {!loading && !catalog?.skills.length && (
            <div className="h-32 text-center text-sm leading-[8rem] text-muted-foreground">
              {t("connections.skills.empty")}
            </div>
          )}
          {loading && (
            <div className="h-32 text-center text-sm leading-[8rem] text-muted-foreground">
              {t("connections.common.loading")}
            </div>
          )}
        </div>
      </div>
      {!!catalog?.problems.length && (
        <section className="space-y-2.5 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-card-foreground">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <h3 className="text-sm font-medium">{t("connections.skills.problems")}</h3>
          </div>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {catalog.problems.map((problem) => (
              <li key={problem.skill}>
                <span className="font-mono">{problem.skill}</span>
                <span className="ml-2 text-xs">{problem.code}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("connections.skills.problemsHint")}</p>
        </section>
      )}

      <Sheet
        open={active && detail !== null}
        onOpenChange={(open) => {
          if (!open) {
            pendingDetail.current?.cancel();
            setDetail(null);
            if (hasReturn) {
              returnTarget();
              return;
            }
            if (useSuperstringStore.getState().componentTarget?.kind === "skill")
              useSuperstringStore.setState({ componentTarget: null });
          }
        }}
      >
        <SheetContent scrollMode="surface" className="w-full  sm:max-w-2xl">
          <SheetHeader className="border-b pb-4">
            <SheetTitle>{detail?.name}</SheetTitle>
            <SheetDescription>{t("connections.skills.detailHint")}</SheetDescription>
          </SheetHeader>
          {detail && (
            <div className="space-y-6 p-6">
              {detail.origin === "system" && (
                <p className="text-xs text-muted-foreground">
                  {t("connections.components.definitionLocked")}
                </p>
              )}
              <p className="text-sm leading-relaxed text-muted-foreground">{detail.description}</p>
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("connections.skills.instructions")}</h3>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/50 bg-muted/60 p-4 font-mono text-xs leading-relaxed">
                  {detail.instructions}
                </pre>
              </section>
              {detail.license?.trim() && (
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{t("connections.skills.license")}</h3>
                  <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {detail.license}
                  </p>
                </section>
              )}
              {detail.compatibility?.trim() && (
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{t("connections.skills.compatibility")}</h3>
                  <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {detail.compatibility}
                  </p>
                </section>
              )}
              {!!metadata.length && (
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{t("connections.skills.metadata")}</h3>
                  <dl className="space-y-2 text-sm">
                    {metadata.map(([key, value]) => (
                      <div key={key} className="space-y-1 whitespace-pre-wrap break-words">
                        <dt className="font-mono text-xs font-semibold text-foreground/80">
                          {key}
                        </dt>
                        <dd className="text-muted-foreground">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}
              {detail["allowed-tools"]?.trim() && (
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{t("connections.skills.allowedTools")}</h3>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/50 bg-muted/60 p-4 font-mono text-xs leading-relaxed">
                    {detail["allowed-tools"]}
                  </pre>
                  <p className="text-xs text-muted-foreground">
                    {t("connections.skills.allowedToolsHint")}
                  </p>
                </section>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
