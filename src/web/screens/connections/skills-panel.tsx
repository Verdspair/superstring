import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SkillCatalogResponse, SkillDetailResponse } from "../../../shared/contracts/skill";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { type ReadTask, startRead } from "../../services/read-task";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";

export function SkillsPanel() {
  const { t } = useTranslation();
  const apiClient = useSuperstringStore((s) => s.apiClient);
  const target = useSuperstringStore((s) => s.componentTarget);
  const [catalog, setCatalog] = useState<SkillCatalogResponse | null>(null);
  const [detail, setDetail] = useState<SkillDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pending = useRef<ReadTask | null>(null);
  const pendingDetail = useRef<ReadTask | null>(null);
  const load = useCallback(() => {
    pending.current?.cancel();
    setLoading(true);
    pending.current = startRead((signal) => apiClient.getSkills(signal), {
      success: (value) => {
        setCatalog(value);
        setError("");
      },
      failure: (caught) => setError(errorText(caught)),
      settled: () => setLoading(false),
    });
  }, [apiClient]);
  useEffect(() => {
    load();
    return () => {
      pending.current?.cancel();
      pendingDetail.current?.cancel();
    };
  }, [load]);
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
    if (target?.kind === "skill") open(target.id);
  }, [target, open]);
  const metadata = Object.entries(detail?.metadata ?? {});
  return (
    <div className="w-full space-y-6 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">{t("connections.skills.title")}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("connections.skills.description")}
          </p>
        </div>
        <Button variant="outline" disabled={loading} onClick={load}>
          <RefreshCw />
          {t("connections.common.refresh")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("connections.skills.name")}</TableHead>
              <TableHead>{t("connections.skills.descriptionColumn")}</TableHead>
              <TableHead>{t("connections.skills.type")}</TableHead>
              <TableHead className="text-right">{t("connections.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(catalog?.skills ?? []).map((skill) => (
              <TableRow
                key={skill.name}
                data-skill-name={skill.name}
                data-global-enabled={skill.globalEnabled}
                className={skill.globalEnabled ? undefined : "bg-muted/30 text-muted-foreground"}
              >
                <TableCell className="font-mono text-sm">{skill.name}</TableCell>
                <TableCell className="max-w-xl whitespace-normal break-words text-sm leading-relaxed text-muted-foreground">
                  {skill.origin === "system"
                    ? t(`connections.components.skillSummary.${skill.name}`, {
                        defaultValue: skill.description,
                      })
                    : skill.description}
                </TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <Badge variant="outline">
                      {t(
                        skill.origin === "system"
                          ? "connections.components.system"
                          : "connections.skills.documentSkill",
                      )}
                    </Badge>
                    {!skill.globalEnabled && (
                      <p className="text-xs">{t("connections.components.globalOff")}</p>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => open(skill.name)}>
                    {t("connections.skills.view")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!loading && !catalog?.skills.length && (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                  {t("connections.skills.empty")}
                </TableCell>
              </TableRow>
            )}
            {loading && (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                  {t("connections.common.loading")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {!!catalog?.problems.length && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("connections.skills.problems")}</h3>
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
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) {
            pendingDetail.current?.cancel();
            setDetail(null);
            if (useSuperstringStore.getState().componentTarget?.kind === "skill")
              useSuperstringStore.setState({ componentTarget: null });
          }
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader className="border-b">
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
              <p className="text-sm text-muted-foreground">{detail.description}</p>
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("connections.skills.instructions")}</h3>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">
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
                        <dt className="font-mono text-xs">{key}</dt>
                        <dd className="text-muted-foreground">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}
              {detail["allowed-tools"]?.trim() && (
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{t("connections.skills.allowedTools")}</h3>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">
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
