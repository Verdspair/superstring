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
  const open = (name: string) => {
    pendingDetail.current?.cancel();
    setError("");
    pendingDetail.current = startRead((signal) => apiClient.getSkill(name, signal), {
      success: setDetail,
      failure: (caught) => setError(errorText(caught)),
    });
  };
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6 lg:px-8">
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
              <TableHead>{t("connections.skills.scripts")}</TableHead>
              <TableHead className="text-right">{t("connections.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(catalog?.skills ?? []).map((skill) => (
              <TableRow key={skill.name}>
                <TableCell className="font-mono text-sm">{skill.name}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{skill.description}</TableCell>
                <TableCell>
                  {skill.scriptCount ? (
                    <Badge variant="outline">
                      {t("connections.skills.scriptCount", { "0": skill.scriptCount })}
                    </Badge>
                  ) : (
                    <Badge variant="outline">{t("connections.skills.readOnly")}</Badge>
                  )}
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
              <p className="text-sm text-muted-foreground">{detail.description}</p>
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("connections.skills.instructions")}</h3>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">
                  {detail.instructions}
                </pre>
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-medium">{t("connections.skills.scripts")}</h3>
                {detail.scripts.length ? (
                  <div className="overflow-hidden rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("connections.skills.scriptName")}</TableHead>
                          <TableHead>{t("connections.skills.command")}</TableHead>
                          <TableHead>{t("connections.skills.limits")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.scripts.map((script) => (
                          <TableRow key={script.name}>
                            <TableCell className="align-top">
                              <div className="font-medium">{script.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {script.description}
                              </div>
                            </TableCell>
                            <TableCell className="max-w-72 align-top font-mono text-xs break-words">
                              {[script.command, ...script.args].join(" ")}
                              {!!script.resolvedDirectories.length && (
                                <div className="mt-1 text-muted-foreground">
                                  {script.resolvedDirectories.join(" · ")}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="align-top text-xs text-muted-foreground">
                              {t("connections.skills.limitValues", {
                                "0": script.timeoutMs,
                                "1": script.maxOutputChars,
                              })}
                              <div className="mt-1 font-mono">{script.resource}</div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("connections.skills.noScripts")}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">{t("connections.skills.grantHint")}</p>
              </section>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
