import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  MODEL_PROVIDER_MODEL_LIMIT,
  type ModelProviderModel,
  type ModelProviderResponse,
} from "../../../shared/contracts/models";
import { ConfirmDialog } from "../../components/confirmation";
import { Field } from "../../components/form-field";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { InputSuggestions } from "../../components/ui/input-suggestions";
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
import { LocalModelEncodings } from "../../features/models/LocalModelEncodings";
import {
  createProviderEditor,
  type ProviderEditor,
  providerPayload,
} from "../../features/models/provider-draft";
import { translateNotice } from "../../i18n";
import { type ReadTask, startRead } from "../../services/read-task";
import { useSuperstringStore } from "../../store";
import { WorkspacePageHeader } from "../../workspace/WorkspacePageHeader";

type ProviderHealth = {
  ok: boolean;
  count: number;
  error: string | null;
  models: string[];
};

function UsageEstimateField({
  model,
  saving,
  onTokenizer,
}: {
  model: ProviderEditor["models"][number];
  saving: boolean;
  onTokenizer: (value: ModelProviderModel["tokenizer_encoding"] | undefined) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(model.tokenizerEncoding !== undefined);
  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="rounded-md border border-border/70 bg-muted/20"
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
        {t("models.usageEstimateTitle")}
      </summary>
      <div className="space-y-3 px-3 pb-3">
        <p className="text-xs text-muted-foreground">{t("models.usageEstimateHint")}</p>
        <Field label="models.tokenizerEncoding" tooltip={t("models.tokenizerEncodingHint")}>
          <NativeSelect
            value={model.tokenizerEncoding ?? ""}
            disabled={saving}
            onChange={(event) =>
              onTokenizer(
                event.target.value === ""
                  ? undefined
                  : (event.target.value as ModelProviderModel["tokenizer_encoding"]),
              )
            }
          >
            <option value="">{t("models.tokenizerUnspecified")}</option>
            <option value="cl100k_base">cl100k_base</option>
            <option value="o200k_base">o200k_base</option>
          </NativeSelect>
        </Field>
      </div>
    </details>
  );
}

export function ModelServices({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const capacityTarget = useSuperstringStore((s) => s.modelCapacityTarget);
  const { apiClient, refreshModels, modelStatus, loadedModelNames, modelProviders } =
    useSuperstringStore(
      useShallow((state) => ({
        apiClient: state.apiClient,
        refreshModels: state.refreshModels,
        modelStatus: state.modelStatus,
        loadedModelNames: state.loadedModelNames,
        modelProviders: state.modelProviders,
      })),
    );
  // Bootstrap already fetched the registered providers: first paint reuses that snapshot,
  // then the authoritative read below corrects it (no second cache, no sync machinery).
  const [providers, setProviders] = useState<ModelProviderResponse[]>(modelProviders);
  const [health, setHealth] = useState<Record<string, ProviderHealth>>({});
  const [editor, setEditor] = useState<ProviderEditor | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const mutationPending = useRef(false);
  const recheck = useRef<ReadTask | null>(null);
  const [testing, setTesting] = useState(false);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<"close" | "delete" | null>(null);
  const lastPending = useRef<"close" | "delete">("close");
  const requestPending = (value: "close" | "delete") => {
    lastPending.current = value;
    setPending(value);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit refresh generation
  useEffect(() => {
    if (!active) return;
    setLoading(true);
    // 保留原始读取 Promise：读取失败时把原拒绝交给共享发现结算，
    // 不把失败伪装成健康的空清单。
    let read: Promise<ModelProviderResponse[]>;
    const task = startRead(
      (signal) => {
        read = apiClient.listModelProviders(signal);
        return read;
      },
      {
        success: (rows) => {
          setProviders(rows);
          setError("");
          void refreshModels(rows);
        },
        failure: (caught) => {
          setError(caught instanceof Error ? caught.message : String(caught));
          void refreshModels(read);
        },
        settled: () => setLoading(false),
      },
    );
    return () => task.cancel();
  }, [active, apiClient, refreshModels, revision]);
  useEffect(() => {
    if (!active || loading || !capacityTarget) return;
    const target =
      document.querySelector<HTMLElement>(
        `[data-capacity-model="${CSS.escape(capacityTarget)}"]`,
      ) ?? document.getElementById("local-model-capacity");
    target?.scrollIntoView({ block: "center" });
    target?.focus({ preventScroll: true });
  }, [active, loading, capacityTarget]);
  // Provider editing must remain available even while a remote health check is slow.
  // Probing waits for the authoritative read: never probe the stale bootstrap snapshot twice.
  useEffect(() => {
    if (!active || loading) return;
    setHealth({});
    setTesting(false);
    const tasks = providers.map((provider) =>
      startRead((signal) => apiClient.testModelProvider(provider.id, signal), {
        success: (result) =>
          setHealth((old) => ({
            ...old,
            [provider.id]: {
              ok: result.ok,
              count: result.models.length,
              error: result.error,
              models: result.models,
            },
          })),
        failure: (caught) =>
          setHealth((old) => ({
            ...old,
            [provider.id]: {
              ok: false,
              count: 0,
              error: caught instanceof Error ? caught.message : String(caught),
              models: [],
            },
          })),
      }),
    );
    return () => {
      for (const task of tasks) task.cancel();
      recheck.current?.cancel();
      recheck.current = null;
    };
  }, [active, apiClient, providers, loading]);
  const parsed = useMemo(() => (editor ? providerPayload(editor) : null), [editor]);
  const dirty = useMemo(
    () =>
      editor !== null &&
      JSON.stringify(editor) !== JSON.stringify(createProviderEditor(editor.source)),
    [editor],
  );
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
  const handleHeaderRefresh = () => setRevision((value) => value + 1);
  const providerModelIds = editor?.source ? (health[editor.source.id]?.models ?? []) : [];
  const uniqueProviderModelIds = [...new Set(providerModelIds)];
  const modelIdSuggestions = uniqueProviderModelIds.map((id) => ({ value: id }));

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-[1160px] flex-col px-[36px] pt-[28px] pb-[64px] max-[768px]:px-[16px] max-[768px]:pt-[20px] max-[768px]:pb-[48px]">
      <WorkspacePageHeader
        location={t("brand.workspace", { "0": t("models.title") })}
        title={t("models.title")}
        description={t("models.description")}
        actions={
          <Button
            variant="outline"
            aria-label={t("models.refresh")}
            tooltip={t("hints.system.modelsRefresh")}
            onClick={handleHeaderRefresh}
            disabled={loading}
            className="max-[480px]:size-9 max-[480px]:p-0"
          >
            <RefreshCw />
            <span className="max-[480px]:hidden">{t("models.refresh")}</span>
          </Button>
        }
      />
      {error && (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-[28px]">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="workspace-section-title">{t("models.external")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("models.externalHint")}</p>
          </div>
          <Button
            tooltip={t("hints.system.addProvider")}
            onClick={() => setEditor(createProviderEditor(null))}
          >
            <Plus />
            {t("models.addProvider")}
          </Button>
        </div>
        <div className="rounded-lg border">
          <Table>
            <TableHeader className="hidden sm:table-header-group">
              <TableRow>
                {["name", "endpoint", "declared", "health", "actions"].map((key) => (
                  <TableHead key={key}>{t(`models.columns.${key}`)}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y sm:divide-y-0">
              {providers.map((provider) => (
                <TableRow
                  key={provider.id}
                  tabIndex={-1}
                  data-capacity-model={
                    provider.models.some((model) => model.name === capacityTarget)
                      ? capacityTarget
                      : undefined
                  }
                  className="flex flex-col gap-2 p-4 sm:table-row sm:p-0"
                >
                  <TableCell className="font-medium p-0 sm:p-2">{provider.name}</TableCell>
                  <TableCell className="max-w-80 truncate font-mono text-xs text-muted-foreground sm:text-foreground p-0 sm:p-2">
                    {provider.base_url}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground sm:text-sm sm:text-foreground p-0 sm:p-2">
                    <span className="sm:hidden text-muted-foreground">
                      {t("models.columns.declared")}:{" "}
                    </span>
                    {provider.models.length}
                  </TableCell>
                  <TableCell className="p-0 sm:p-2">
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
                  <TableCell className="p-0 pt-2 sm:p-2 sm:pt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-center sm:w-auto"
                      tooltip={t("hints.system.configureProvider", { "0": provider.name })}
                      onClick={() => setEditor(createProviderEditor(provider))}
                    >
                      {t("models.configure")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!providers.length && (
                <TableRow className="sm:table-row">
                  <TableCell
                    colSpan={5}
                    className="h-36 text-center text-muted-foreground p-4 sm:p-2"
                  >
                    {t(loading ? "models.loading" : "models.noProviders")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <section id="local-model-capacity" tabIndex={-1} className="mt-8 border-t pt-6">
          <div className="flex items-center gap-2">
            <h2 className="workspace-section-title">{t("models.localProvider")}</h2>
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
          <LocalModelEncodings
            active={active}
            apiClient={apiClient}
            loadedModels={loadedModelNames}
            externalModels={providers.flatMap((provider) =>
              provider.models.map((model) => model.name),
            )}
          />
        </section>
      </div>
      <Sheet
        open={editor !== null && active}
        onOpenChange={(open) => {
          if (open || saving) return;
          if (dirty) requestPending("close");
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
            <div className="flex items-center justify-between">
              <SheetTitle>
                {t(editor?.source ? "models.editProvider" : "models.addProvider")}
              </SheetTitle>
            </div>
            <SheetDescription>{t("models.secretHint")}</SheetDescription>
          </SheetHeader>
          {editor && (
            <div className="space-y-6 p-6">
              <section className="space-y-4">
                <Field label="models.name" tooltip={t("hints.fieldExtra.providerName")}>
                  <Input
                    value={editor.name}
                    disabled={saving}
                    onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                  />
                </Field>
                <Field label="models.baseUrl" tooltip={t("hints.fieldExtra.providerUrl")}>
                  <Input
                    value={editor.baseUrl}
                    disabled={saving}
                    placeholder="https://api.example.com/v1"
                    onChange={(e) => setEditor({ ...editor, baseUrl: e.target.value })}
                  />
                </Field>
                <Field label="models.apiKey" tooltip={t("hints.fieldExtra.providerKey")}>
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
                      tooltip={t("hints.system.clearKey")}
                      disabled={saving}
                      onClick={() => void save("clear")}
                    >
                      {t("models.clearKey")}
                    </Button>
                  )}
                </Field>
              </section>
              <section className="space-y-4 border-t pt-5">
                <div>
                  <h3 className="workspace-card-title">{t("models.registeredModels")}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{t("models.modelsHint")}</p>
                </div>
                {editor.models.map((model) => (
                  <div key={model.key} className="space-y-3 rounded-md border p-4">
                    <div className="grid grid-cols-[minmax(0,1fr)_6rem_auto] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
                      <Field label="models.modelId" tooltip={t("hints.fieldExtra.providerModel")}>
                        <InputSuggestions
                          value={model.name}
                          suggestions={modelIdSuggestions}
                          disabled={saving}
                          onValueChange={(value) =>
                            setEditor({
                              ...editor,
                              models: editor.models.map((item) =>
                                item.key === model.key ? { ...item, name: value } : item,
                              ),
                            })
                          }
                        />
                      </Field>
                      <Field
                        label="models.contextWindow"
                        tooltip={t("hints.fieldExtra.providerWindow")}
                      >
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
                        tooltip={t("hints.system.removeModel")}
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
                    <UsageEstimateField
                      model={model}
                      saving={saving}
                      onTokenizer={(value) =>
                        setEditor({
                          ...editor,
                          models: editor.models.map((item) =>
                            item.key === model.key ? { ...item, tokenizerEncoding: value } : item,
                          ),
                        })
                      }
                    />
                  </div>
                ))}
                <Button
                  variant="outline"
                  tooltip={
                    editor.models.length >= MODEL_PROVIDER_MODEL_LIMIT
                      ? t("hints.system.addModelLimit")
                      : t("hints.system.addModel")
                  }
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
                    tooltip={t("hints.system.testAgain")}
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
                                models: result.models,
                              },
                            })),
                          failure: (caught) =>
                            setHealth((old) => ({
                              ...old,
                              [id]: {
                                ok: false,
                                count: 0,
                                error: caught instanceof Error ? caught.message : String(caught),
                                models: [],
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
                  <Button
                    variant="ghost"
                    tooltip={t("hints.system.deleteProvider")}
                    disabled={saving}
                    onClick={() => requestPending("delete")}
                  >
                    <Trash2 />
                    {t("models.delete")}
                  </Button>
                )}
                <Button
                  className="ml-auto"
                  tooltip={
                    parsed?.success
                      ? t("hints.system.saveProvider")
                      : t("hints.system.saveProviderInvalid")
                  }
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
      <ConfirmDialog
        open={active && pending !== null}
        busy={saving}
        message={t(
          (pending ?? lastPending.current) === "delete"
            ? "models.deleteConfirm"
            : "models.discardConfirm",
        )}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const action = pending ?? lastPending.current;
          if (action === "delete") return save("delete");
          setEditor(null);
          setPending(null);
        }}
      />
    </section>
  );
}
