import { PlugZap, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpServerConfig, McpStatusResponse } from "../../../shared/contracts/mcp";
import { ConfirmDialog } from "../../components/confirmation";
import { Field } from "../../components/form-field";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
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
import { Textarea } from "../../components/ui/textarea";
import {
  draftOf,
  emptyDraft,
  type McpDraftProblem,
  type McpServerDraft,
  removeServer,
  serverPayload,
  upsertServer,
} from "../../features/access/mcp-draft";
import { type ReadTask, startRead } from "../../services/read-task";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";

const stateBadge: Record<
  string,
  { key: string; variant: "secondary" | "outline" | "destructive" }
> = {
  connected: { key: "connections.mcp.state.connected", variant: "secondary" },
  pending: { key: "connections.mcp.state.pending", variant: "outline" },
  error: { key: "connections.mcp.state.error", variant: "destructive" },
  disabled: { key: "connections.mcp.state.disabled", variant: "outline" },
};
const problemKeys: Record<McpDraftProblem, string> = {
  id: "connections.mcp.problem.id",
  name: "connections.mcp.problem.name",
  command: "connections.mcp.problem.command",
  url: "connections.mcp.problem.url",
  args: "connections.mcp.problem.args",
  env: "connections.mcp.problem.env",
  numbers: "connections.mcp.problem.numbers",
};

export function McpPanel() {
  const { t } = useTranslation();
  const apiClient = useSuperstringStore((s) => s.apiClient);
  const [status, setStatus] = useState<McpStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"" | "save" | "reload">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState<McpDraftProblem | null>(null);
  const [editor, setEditor] = useState<{ draft: McpServerDraft; originalId: string | null } | null>(
    null,
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const mutation = useRef(false);
  const editorBaseline = useRef<McpServerDraft | null>(null);
  const dirty =
    editor !== null && JSON.stringify(editor.draft) !== JSON.stringify(editorBaseline.current);
  useEffect(() => {
    if (!dirty && busy === "") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);
  const pending = useRef<ReadTask | null>(null);
  const load = useCallback(() => {
    pending.current?.cancel();
    setLoading(true);
    pending.current = startRead((signal) => apiClient.getMcpServers(signal), {
      success: (value) => {
        setStatus(value);
        setError("");
      },
      failure: (caught) => setError(errorText(caught)),
      settled: () => setLoading(false),
    });
  }, [apiClient]);
  useEffect(() => {
    load();
    return () => pending.current?.cancel();
  }, [load]);

  const servers = (status?.servers ?? []).map((row) => row.config);
  const save = async (next: McpServerConfig[]) => {
    if (!status || loading || mutation.current) return;
    mutation.current = true;
    pending.current?.cancel();
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const saved = await apiClient.saveMcpServers({
        expectedRevision: status.revision,
        servers: next,
      });
      setStatus(saved);
      setEditor(null);
      setNotice(t("connections.mcp.saved"));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      mutation.current = false;
      setBusy("");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">{t("connections.mcp.title")}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("connections.mcp.description")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={loading || busy !== ""} onClick={load}>
            <RefreshCw />
            {t("connections.common.refresh")}
          </Button>
          <Button
            variant="outline"
            disabled={busy !== "" || loading}
            onClick={() => {
              if (mutation.current) return;
              mutation.current = true;
              pending.current?.cancel();
              setBusy("reload");
              setError("");
              setNotice("");
              pending.current = startRead(() => apiClient.reloadMcpServers(), {
                success: (value) => {
                  setStatus(value);
                  setNotice(t("connections.mcp.reloaded"));
                },
                failure: (caught) => setError(errorText(caught)),
                settled: () => {
                  mutation.current = false;
                  setBusy("");
                },
              });
            }}
          >
            <PlugZap />
            {t("connections.mcp.reload")}
          </Button>
          <Button
            disabled={busy !== "" || !status}
            onClick={() => {
              setProblem(null);
              editorBaseline.current = emptyDraft();
              setEditor({ draft: editorBaseline.current, originalId: null });
            }}
          >
            <Plus />
            {t("connections.mcp.add")}
          </Button>
        </div>
      </div>
      {status?.code && (
        <p role="alert" className="rounded-md border border-destructive/40 px-4 py-3 text-sm">
          {t("connections.mcp.configUnreadable", { "0": status.code })}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("connections.mcp.name")}</TableHead>
              <TableHead>{t("connections.mcp.transport")}</TableHead>
              <TableHead>{t("connections.mcp.stateColumn")}</TableHead>
              <TableHead>{t("connections.mcp.toolsColumn")}</TableHead>
              <TableHead className="text-right">{t("connections.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(status?.servers ?? []).map((row) => {
              const badge = stateBadge[row.state] ?? stateBadge.pending;
              return (
                <TableRow key={row.config.id}>
                  <TableCell className="font-medium">
                    {row.config.name}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {row.config.id}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {t(`connections.mcp.transport.${row.config.transport}`)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={badge.variant}>{t(badge.key)}</Badge>
                    {row.code && (
                      <span className="ml-2 font-mono text-xs text-destructive">{row.code}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.tools.length
                      ? t("connections.mcp.tools", { "0": row.tools.length })
                      : t("connections.mcp.noTools")}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== ""}
                      onClick={() => {
                        setProblem(null);
                        editorBaseline.current = draftOf(row.config);
                        setEditor({ draft: editorBaseline.current, originalId: row.config.id });
                      }}
                    >
                      {t("connections.manage")}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {!loading && !status?.servers.length && (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                  {t("connections.mcp.empty")}
                </TableCell>
              </TableRow>
            )}
            {loading && (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                  {t("connections.common.loading")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Sheet
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && busy === "") {
            if (dirty) setDiscarding(true);
            else setEditor(null);
          }
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader className="border-b">
            <SheetTitle>
              {editor?.originalId ? t("connections.mcp.edit") : t("connections.mcp.add")}
            </SheetTitle>
            <SheetDescription>{t("connections.mcp.credentialHint")}</SheetDescription>
          </SheetHeader>
          {editor && (
            <div className="space-y-6 p-6">
              <Field label="connections.mcp.serverId" info="connections.mcp.serverIdHint">
                <Input
                  value={editor.draft.id}
                  disabled={busy !== ""}
                  onChange={(e) =>
                    setEditor({ ...editor, draft: { ...editor.draft, id: e.target.value } })
                  }
                />
              </Field>
              <Field label="connections.mcp.name">
                <Input
                  value={editor.draft.name}
                  disabled={busy !== ""}
                  onChange={(e) =>
                    setEditor({ ...editor, draft: { ...editor.draft, name: e.target.value } })
                  }
                />
              </Field>
              <Field label="connections.mcp.transport">
                <NativeSelect
                  value={editor.draft.transport}
                  disabled={busy !== ""}
                  onChange={(e) =>
                    setEditor({
                      ...editor,
                      draft: {
                        ...editor.draft,
                        transport: e.target.value as McpServerDraft["transport"],
                      },
                    })
                  }
                >
                  <option value="stdio">{t("connections.mcp.transport.stdio")}</option>
                  <option value="http">{t("connections.mcp.transport.http")}</option>
                  <option value="sse">{t("connections.mcp.transport.sse")}</option>
                </NativeSelect>
              </Field>
              {editor.draft.transport === "stdio" ? (
                <>
                  <Field label="connections.mcp.command">
                    <Input
                      value={editor.draft.command}
                      disabled={busy !== ""}
                      onChange={(e) =>
                        setEditor({
                          ...editor,
                          draft: { ...editor.draft, command: e.target.value },
                        })
                      }
                    />
                  </Field>
                  <Field label="connections.mcp.args">
                    <Textarea
                      rows={3}
                      value={editor.draft.args}
                      disabled={busy !== ""}
                      onChange={(e) =>
                        setEditor({ ...editor, draft: { ...editor.draft, args: e.target.value } })
                      }
                    />
                  </Field>
                  <Field label="connections.mcp.env" info="connections.mcp.envHint">
                    <Textarea
                      rows={3}
                      value={editor.draft.env}
                      disabled={busy !== ""}
                      onChange={(e) =>
                        setEditor({ ...editor, draft: { ...editor.draft, env: e.target.value } })
                      }
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="connections.mcp.url">
                    <Input
                      value={editor.draft.url}
                      disabled={busy !== ""}
                      placeholder="https://example.test/mcp"
                      onChange={(e) =>
                        setEditor({ ...editor, draft: { ...editor.draft, url: e.target.value } })
                      }
                    />
                  </Field>
                  <Field
                    label="connections.mcp.authorizationEnv"
                    info="connections.mcp.authorizationEnvHint"
                  >
                    <Input
                      value={editor.draft.authorizationEnv}
                      disabled={busy !== ""}
                      onChange={(e) =>
                        setEditor({
                          ...editor,
                          draft: { ...editor.draft, authorizationEnv: e.target.value },
                        })
                      }
                    />
                  </Field>
                </>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="connections.mcp.timeoutMs">
                  <Input
                    inputMode="numeric"
                    value={editor.draft.timeoutMs}
                    disabled={busy !== ""}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        draft: { ...editor.draft, timeoutMs: e.target.value },
                      })
                    }
                  />
                </Field>
                <Field label="connections.mcp.maxResultChars">
                  <Input
                    inputMode="numeric"
                    value={editor.draft.maxResultChars}
                    disabled={busy !== ""}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        draft: { ...editor.draft, maxResultChars: e.target.value },
                      })
                    }
                  />
                </Field>
              </div>
              <Field label="connections.mcp.enabled" info="connections.mcp.enabledHint">
                <Checkbox
                  checked={editor.draft.enabled}
                  disabled={busy !== ""}
                  onCheckedChange={(checked) =>
                    setEditor({
                      ...editor,
                      draft: { ...editor.draft, enabled: checked === true },
                    })
                  }
                />
              </Field>
              {problem && (
                <p role="alert" className="text-sm text-destructive">
                  {t(problemKeys[problem])}
                </p>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap gap-2 border-t pt-5">
                {editor.originalId && (
                  <Button
                    variant="ghost"
                    disabled={busy !== ""}
                    onClick={() => setRemoving(editor.originalId)}
                  >
                    <Trash2 />
                    {t("connections.mcp.delete")}
                  </Button>
                )}
                <Button
                  className="ml-auto"
                  disabled={busy !== "" || loading}
                  onClick={() => {
                    const payload = serverPayload(editor.draft);
                    if (!payload.ok) {
                      setProblem(payload.problem);
                      return;
                    }
                    setProblem(null);
                    void save(upsertServer(servers, payload.server, editor.originalId));
                  }}
                >
                  {t("connections.mcp.save")}
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
      {discarding && (
        <ConfirmDialog
          message={t("models.discardConfirm")}
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            setDiscarding(false);
            setEditor(null);
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          busy={busy === "save"}
          message={t("connections.mcp.deleteConfirm", { "0": removing })}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void save(removeServer(servers, target));
          }}
        />
      )}
    </div>
  );
}
