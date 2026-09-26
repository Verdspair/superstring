import { Cpu, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CreateModelProviderRequestSchema,
  MODEL_PROVIDER_MODEL_LIMIT,
  type ModelProviderResponse,
} from "../../../shared/contracts/models";
import { ConfirmDialog } from "../../components/confirmation";
import { Field } from "../../components/form-field";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { translateNotice } from "../../i18n";
import { type ReadTask, startRead } from "../../services/read-task";
import { useSuperstringStore } from "../../store";
import { ModelDefaults } from "./model-defaults";

interface ProviderEditor {
  source: ModelProviderResponse | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: { key: string; name: string; window: string }[];
}
const editorOf = (source: ModelProviderResponse | null): ProviderEditor => ({
  source,
  name: source?.name ?? "",
  baseUrl: source?.base_url ?? "",
  apiKey: "",
  models:
    source?.models.map((model) => ({
      key: model.name,
      name: model.name,
      window: String(model.context_window),
    })) ?? [],
});

export function ModelServices() {
  const { t } = useTranslation();
  const { apiClient, refreshModels, modelStatus, loadedModelNames, settingsRoute } =
    useSuperstringStore();
  const [providers, setProviders] = useState<ModelProviderResponse[]>([]);
  const [health, setHealth] = useState<
    Record<string, { ok: boolean; count: number; error: string | null }>
  >({});
  const [editor, setEditor] = useState<ProviderEditor | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const mutationPending = useRef(false);
  const recheck = useRef<ReadTask | null>(null);
  const [testing, setTesting] = useState(false);
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState(settingsRoute === "external-api" ? "providers" : "defaults");
  const [pending, setPending] = useState<"close" | "delete" | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit refresh generation
  useEffect(() => {
    setLoading(true);
    const task = startRead((signal) => apiClient.listModelProviders(signal), {
      success: (rows) => {
        setProviders(rows);
        setError("");
      },
      failure: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
      settled: () => setLoading(false),
    });
    void refreshModels();
    return () => task.cancel();
  }, [apiClient, refreshModels, revision]);
  // Provider editing must remain available even while a remote health check is slow.
  useEffect(() => {
    setHealth({});
    setTesting(false);
    const tasks = providers.map((provider) =>
      startRead((signal) => apiClient.testModelProvider(provider.id, signal), {
        success: (result) =>
          setHealth((old) => ({
            ...old,
            [provider.id]: { ok: result.ok, count: result.models.length, error: result.error },
          })),
        failure: (caught) =>
          setHealth((old) => ({
            ...old,
            [provider.id]: {
              ok: false,
              count: 0,
              error: caught instanceof Error ? caught.message : String(caught),
            },
          })),
      }),
    );
    return () => {
      for (const task of tasks) task.cancel();
      recheck.current?.cancel();
      recheck.current = null;
    };
  }, [apiClient, providers]);
  const parsed = editor
    ? CreateModelProviderRequestSchema.safeParse({
        name: editor.name.trim(),
        base_url: editor.baseUrl.trim(),
        ...(editor.apiKey ? { api_key: editor.apiKey } : {}),
        models: editor.models.map((model) => ({
          name: model.name.trim(),
          context_window: Number(model.window),
        })),
      })
    : null;
  const dirty =
    editor !== null && JSON.stringify(editor) !== JSON.stringify(editorOf(editor.source));
  useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving]);
  const save = async (kind: "save" | "clear" | "delete") => {
    if (!editor || mutationPending.current) return;
    mutationPending.current = true;
    setSaving(true);
    setError("");
    try {
      if (kind === "delete" && editor.source) await apiClient.deleteModelProvider(editor.source.id);
      else if (kind === "clear" && editor.source) {
        const saved = await apiClient.updateModelProvider(editor.source.id, {
          api_key: null,
          expected_revision: editor.source.revision,
        });
        // Keep other unsaved fields when clearing a stored secret.
        setEditor({ ...editor, source: saved, apiKey: "" });
      } else if (parsed?.success) {
        if (editor.source)
          await apiClient.updateModelProvider(editor.source.id, {
            ...parsed.data,
            expected_revision: editor.source.revision,
          });
        else await apiClient.createModelProvider(parsed.data);
      } else return;
      if (kind !== "clear") setEditor(null);
      setRevision((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      mutationPending.current = false;
      setSaving(false);
      setPending(null);
    }
  };
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b px-6 py-5 lg:px-8">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Cpu className="size-5 text-muted-foreground" />
            {t("models.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("models.description")}</p>
        </div>
        <Button variant="outline" onClick={() => setRevision((v) => v + 1)} disabled={loading}>
          <RefreshCw />
          {t("models.refresh")}
        </Button>
      </header>
      {error && (
        <p role="alert" className="px-6 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
        <div className="border-b px-6 py-3 lg:px-8">
          <TabsList>
            <TabsTrigger value="providers">{t("models.providers")}</TabsTrigger>
            <TabsTrigger value="defaults">{t("models.defaults")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="providers" className="m-0 overflow-y-auto px-6 py-6 lg:px-8">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">{t("models.external")}</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                {t("models.externalHint")}
              </p>
            </div>
            <Button onClick={() => setEditor(editorOf(null))}>
              <Plus />
              {t("models.addProvider")}
            </Button>
          </div>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  {["name", "endpoint", "declared", "health", "actions"].map((key) => (
                    <TableHead key={key}>{t(`models.columns.${key}`)}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((provider) => (
                  <TableRow key={provider.id}>
                    <TableCell className="font-medium">{provider.name}</TableCell>
                    <TableCell className="max-w-80 truncate font-mono text-xs">
                      {provider.base_url}
                    </TableCell>
                    <TableCell>{provider.models.length}</TableCell>
                    <TableCell>
                      <Badge variant={health[provider.id]?.ok ? "secondary" : "outline"}>
                        {t(
                          health[provider.id]?.ok
                            ? "models.reachable"
                            : health[provider.id]
                              ? "models.unreachable"
                              : "models.checking",
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditor(editorOf(provider))}
                      >
                        {t("models.configure")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {!providers.length && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-36 text-center text-muted-foreground">
                      {t(loading ? "models.loading" : "models.noProviders")}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <section className="mt-8 border-t pt-6">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">{t("models.localProvider")}</h2>
              <Badge variant="outline">{t("models.local")}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{translateNotice(modelStatus)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {loadedModelNames.map((name) => (
                <Badge key={name} variant="secondary" className="font-mono">
                  {name}
                </Badge>
              ))}
            </div>
          </section>
        </TabsContent>
        <TabsContent value="defaults" className="m-0 overflow-y-auto">
          <ModelDefaults />
        </TabsContent>
      </Tabs>
      <Sheet
        open={editor !== null}
        onOpenChange={(open) => {
          if (open || saving) return;
          if (dirty) setPending("close");
          else setEditor(null);
        }}
      >
        <SheetContent
          className="w-full overflow-y-auto sm:max-w-2xl"
          onKeyDown={(event) => {
            // An unsaved local credential draft must close through this Sheet's discard guard.
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")
              event.stopPropagation();
          }}
        >
          <SheetHeader className="border-b">
            <SheetTitle>
              {t(editor?.source ? "models.editProvider" : "models.addProvider")}
            </SheetTitle>
            <SheetDescription>{t("models.secretHint")}</SheetDescription>
          </SheetHeader>
          {editor && (
            <div className="space-y-6 p-6">
              <Field label="models.name">
                <Input
                  value={editor.name}
                  disabled={saving}
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                />
              </Field>
              <Field label="models.baseUrl">
                <Input
                  value={editor.baseUrl}
                  disabled={saving}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => setEditor({ ...editor, baseUrl: e.target.value })}
                />
              </Field>
              <Field label="models.apiKey">
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={editor.apiKey}
                  disabled={saving}
                  placeholder={t(
                    editor.source?.has_api_key ? "models.keyStored" : "models.keyMissing",
                  )}
                  onChange={(e) => setEditor({ ...editor, apiKey: e.target.value })}
                />
                {editor.source?.has_api_key && (
                  <Button
                    className="justify-self-start"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => void save("clear")}
                  >
                    {t("models.clearKey")}
                  </Button>
                )}
              </Field>
              <section className="space-y-4 border-t pt-5">
                <h3 className="font-medium">{t("models.registeredModels")}</h3>
                <p className="text-xs text-muted-foreground">{t("models.windowHint")}</p>
                {editor.models.map((model) => (
                  <div
                    key={model.key}
                    className="grid grid-cols-[minmax(0,1fr)_8rem_auto] items-end gap-2"
                  >
                    <Field label="models.modelId">
                      <Input
                        value={model.name}
                        disabled={saving}
                        onChange={(e) =>
                          setEditor({
                            ...editor,
                            models: editor.models.map((item) =>
                              item.key === model.key ? { ...item, name: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Field label="models.contextWindow">
                      <Input
                        inputMode="numeric"
                        value={model.window}
                        disabled={saving}
                        onChange={(e) =>
                          setEditor({
                            ...editor,
                            models: editor.models.map((item) =>
                              item.key === model.key ? { ...item, window: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("models.removeModel", { "0": model.name })}
                      disabled={saving}
                      onClick={() =>
                        setEditor({
                          ...editor,
                          models: editor.models.filter((item) => item.key !== model.key),
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  disabled={saving || editor.models.length >= MODEL_PROVIDER_MODEL_LIMIT}
                  onClick={() =>
                    setEditor({
                      ...editor,
                      models: [
                        ...editor.models,
                        { key: crypto.randomUUID(), name: "", window: "" },
                      ],
                    })
                  }
                >
                  <Plus />
                  {t("models.addModel")}
                </Button>
              </section>
              {editor.source && (
                <div className="rounded-lg bg-muted p-4 text-sm">
                  <p>
                    {health[editor.source.id]?.error ??
                      t("models.detected", { "0": health[editor.source.id]?.count ?? 0 })}
                  </p>
                  <Button
                    variant="link"
                    className="mt-2 px-0"
                    disabled={saving || testing}
                    onClick={() => {
                      const id = editor.source?.id;
                      if (!id || testing) return;
                      setTesting(true);
                      recheck.current = startRead(
                        (signal) => apiClient.testModelProvider(id, signal),
                        {
                          success: (result) =>
                            setHealth((old) => ({
                              ...old,
                              [id]: {
                                ok: result.ok,
                                count: result.models.length,
                                error: result.error,
                              },
                            })),
                          failure: (caught) =>
                            setHealth((old) => ({
                              ...old,
                              [id]: {
                                ok: false,
                                count: 0,
                                error: caught instanceof Error ? caught.message : String(caught),
                              },
                            })),
                          settled: () => {
                            recheck.current = null;
                            setTesting(false);
                          },
                        },
                      );
                    }}
                  >
                    {t("models.testAgain")}
                  </Button>
                </div>
              )}
              <div className="flex gap-2 border-t pt-5">
                {editor.source && (
                  <Button variant="ghost" disabled={saving} onClick={() => setPending("delete")}>
                    <Trash2 />
                    {t("models.delete")}
                  </Button>
                )}
                <Button
                  className="ml-auto"
                  disabled={saving || !parsed?.success || !dirty}
                  onClick={() => void save("save")}
                >
                  {t("models.save")}
                </Button>
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
      {pending && (
        <ConfirmDialog
          busy={saving}
          message={t(pending === "delete" ? "models.deleteConfirm" : "models.discardConfirm")}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            if (pending === "delete") return save("delete");
            else {
              setEditor(null);
              setPending(null);
            }
          }}
        />
      )}
    </section>
  );
}
