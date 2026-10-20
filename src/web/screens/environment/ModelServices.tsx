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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { openContextAllocation } from "../../features/context-allocation";
import { LocalModelEncodings } from "../../features/models/LocalModelEncodings";
import {
  createProviderEditor,
  type ProviderEditor,
  providerPayload,
} from "../../features/models/provider-draft";
import { TokenizerEncodingHelp } from "../../features/models/TokenizerEncodingHelp";
import { translateNotice } from "../../i18n";
import { type ReadTask, startRead } from "../../services/read-task";
import { useSuperstringStore } from "../../store";
import { ModelPurposes } from "./ModelPurposes";
import { ModelDefaults } from "./model-defaults";

export function ModelServices({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const capacityTarget = useSuperstringStore((s) => s.modelCapacityTarget);
  const { apiClient, refreshModels, modelStatus, loadedModelNames, modelProviders, settingsRoute } =
    useSuperstringStore(
      useShallow((state) => ({
        apiClient: state.apiClient,
        refreshModels: state.refreshModels,
        modelStatus: state.modelStatus,
        loadedModelNames: state.loadedModelNames,
        modelProviders: state.modelProviders,
        settingsRoute: state.settingsRoute,
      })),
    );
  // Bootstrap already fetched the registered providers: first paint reuses that snapshot,
  // then the authoritative read below corrects it (no second cache, no sync machinery).
  const [providers, setProviders] = useState<ModelProviderResponse[]>(modelProviders);
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
  const [defaultsRefreshing, setDefaultsRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState(settingsRoute === "external-api" ? "providers" : "defaults");
  const [visited, setVisited] = useState([
    settingsRoute === "external-api" ? "providers" : "defaults",
  ]);
  const [pending, setPending] = useState<"close" | "delete" | null>(null);
  // The route owns the visible tab: the external API entry opens providers, quick model management
  // opens defaults. This only retargets the tab — the provider editor lives in its own Sheet outside
  // the tab panels, so a route-driven tab change never closes it or discards an unsaved draft.
  useEffect(() => {
    const next = settingsRoute === "external-api" ? "providers" : "defaults";
    setTab(next);
    setVisited((previous) => (previous.includes(next) ? previous : [...previous, next]));
  }, [settingsRoute]);
  useEffect(() => {
    setVisited((previous) => (previous.includes(tab) ? previous : [...previous, tab]));
  }, [tab]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit refresh generation
  useEffect(() => {
    if (!active || tab !== "providers") return;
    setLoading(true);
    const task = startRead((signal) => apiClient.listModelProviders(signal), {
      success: (rows) => {
        setProviders(rows);
        setError("");
        void refreshModels(rows);
      },
      failure: (caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
        void refreshModels([]);
      },
      settled: () => setLoading(false),
    });
    return () => task.cancel();
  }, [active, apiClient, refreshModels, revision, tab]);
  useEffect(() => {
    if (!active || tab !== "providers" || loading || !capacityTarget) return;
    const target =
      document.querySelector<HTMLElement>(
        `[data-capacity-model="${CSS.escape(capacityTarget)}"]`,
      ) ?? document.getElementById("local-model-capacity");
    target?.scrollIntoView({ block: "center" });
    target?.focus({ preventScroll: true });
  }, [active, tab, loading, capacityTarget]);
  // Provider editing must remain available even while a remote health check is slow.
  // Probing waits for the authoritative read: never probe the stale bootstrap snapshot twice.
  useEffect(() => {
    if (!active || tab !== "providers" || loading) return;
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
  }, [active, apiClient, providers, loading, tab]);
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
  const handleHeaderRefresh = () => {
    if (tab === "defaults") {
      setDefaultsRefreshing(true);
      const state = useSuperstringStore.getState();
      void Promise.all([state.loadOrganization(true), state.loadKnowledgeModel(true)]).finally(
        () => {
          setDefaultsRefreshing(false);
        },
      );
    } else {
      setRevision((v) => v + 1);
    }
  };

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-[1160px] flex-col px-[36px] pt-[28px] pb-[64px] max-[768px]:px-[16px] max-[768px]:pt-[20px] max-[768px]:pb-[48px]">
      <header className="workspace-page-header mb-[24px] flex flex-wrap items-start justify-between gap-[14px]">
        <div className="min-w-0 flex-1">
          <p className="workspace-page-location">
            {t("brand.workspace", { "0": t("models.title") })}
          </p>
          <h1 className="workspace-page-title">{t("models.title")}</h1>
          <p className="workspace-page-description">{t("models.description")}</p>
        </div>
        <Button
          variant="outline"
          tooltip={t("hints.system.modelsRefresh")}
          onClick={handleHeaderRefresh}
          disabled={tab === "defaults" ? defaultsRefreshing : loading}
        >
          <RefreshCw />
          {t("models.refresh")}
        </Button>
      </header>
      {error && (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <Tabs
        value={tab}
        onValueChange={(next) => {
          useSuperstringStore
            .getState()
            .openSettingsRoute(next === "providers" ? "external-api" : "models");
        }}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="mb-[24px]">
          <TabsList className="h-[42px] group-data-horizontal/tabs:h-[42px] w-fit max-w-full justify-start gap-[6px] overflow-x-auto rounded-[10px] border border-border bg-muted p-[4px] [&_[role=tab]]:h-[32px] [&_[role=tab]]:flex-none [&_[role=tab]]:px-[14px] [&_[role=tab]]:text-[13px]">
            <TabsTrigger value="providers">{t("models.resources")}</TabsTrigger>
            <TabsTrigger value="defaults">{t("models.purposes")}</TabsTrigger>
          </TabsList>
        </div>
        {visited.includes("providers") && (
          <TabsContent
            value="providers"
            forceMount
            className="m-0 overflow-y-auto pb-[28px] data-[state=inactive]:hidden"
          >
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">{t("models.external")}</h2>
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
              <LocalModelEncodings
                active={active && tab === "providers"}
                apiClient={apiClient}
                loadedModels={loadedModelNames}
                externalModels={providers.flatMap((provider) =>
                  provider.models.map((model) => model.name),
                )}
              />
            </section>
          </TabsContent>
        )}
        {visited.includes("defaults") && (
          <TabsContent
            value="defaults"
            forceMount
            className="m-0 overflow-y-auto data-[state=inactive]:hidden"
          >
            <ModelPurposes
              active={active && tab === "defaults"}
              embedded
              sharedDefaults={
                <ModelDefaults
                  active={active && tab === "defaults" && settingsRoute === "models"}
                />
              }
            />
          </TabsContent>
        )}
      </Tabs>
      <Sheet
        open={editor !== null && active}
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
            <div className="flex items-center justify-between">
              <SheetTitle>
                {t(editor?.source ? "models.editProvider" : "models.addProvider")}
              </SheetTitle>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs"
                tooltip={t("hints.system.goToAllocation")}
                onClick={() =>
                  openContextAllocation({
                    returnRoute: "external-api",
                    returnLabel: t("workspace.external_model_api"),
                  })
                }
              >
                {t("schemes.allocation.goToCentralAllocation")}
              </Button>
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
                  <h3 className="font-medium">{t("models.registeredModels")}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{t("models.windowHint")}</p>
                </div>
                <TokenizerEncodingHelp />
                {editor.models.map((model) => (
                  <div key={model.key} className="space-y-4 rounded-md border p-4">
                    <div className="grid grid-cols-[minmax(0,1fr)_6rem_auto] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
                      <Field label="models.modelId" tooltip={t("hints.fieldExtra.providerModel")}>
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
                    <Field
                      label="models.tokenizerEncoding"
                      info="models.tokenizerEncodingHint"
                      tooltip={t("models.tokenizerEncodingHint")}
                    >
                      <NativeSelect
                        value={model.tokenizerEncoding ?? ""}
                        disabled={saving}
                        onChange={(e) =>
                          setEditor({
                            ...editor,
                            models: editor.models.map((item) =>
                              item.key === model.key
                                ? {
                                    ...item,
                                    tokenizerEncoding:
                                      e.target.value === ""
                                        ? undefined
                                        : (e.target
                                            .value as ModelProviderModel["tokenizer_encoding"]),
                                  }
                                : item,
                            ),
                          })
                        }
                      >
                        <option value="">{t("models.tokenizerUnspecified")}</option>
                        <option value="cl100k_base">cl100k_base</option>
                        <option value="o200k_base">o200k_base</option>
                      </NativeSelect>
                    </Field>
                    <fieldset
                      className="min-w-0 space-y-3"
                      aria-label={t("models.capabilitiesFor", { "0": model.name })}
                    >
                      <legend className="text-sm font-medium">{t("models.capabilities")}</legend>
                      <p className="text-xs text-muted-foreground">
                        {t("models.capabilitiesHint")}
                      </p>
                      <div className="grid gap-3 sm:grid-cols-3">
                        {(
                          [
                            ["toolCalling", "models.toolCalling", "models.toolCallingHint"],
                            [
                              "parallelToolCalls",
                              "models.parallelToolCalls",
                              "models.parallelToolCallsHint",
                            ],
                            ["codeExecution", "models.codeExecution", "models.codeExecutionHint"],
                          ] as const
                        ).map(([key, label, hint]) => (
                          <Field key={key} label={label} info={hint} tooltip={t(hint)}>
                            <Checkbox
                              checked={model.capabilities?.[key] ?? false}
                              disabled={saving}
                              onCheckedChange={(checked) =>
                                setEditor({
                                  ...editor,
                                  models: editor.models.map((item) =>
                                    item.key !== model.key
                                      ? item
                                      : {
                                          ...item,
                                          capabilities: {
                                            toolCalling: false,
                                            parallelToolCalls: false,
                                            codeExecution: false,
                                            ...item.capabilities,
                                            [key]: checked === true,
                                          },
                                        },
                                  ),
                                })
                              }
                            />
                          </Field>
                        ))}
                        <Field
                          label="models.vision"
                          info="models.visionHint"
                          tooltip={t("models.visionHint")}
                        >
                          <NativeSelect
                            value={
                              model.capabilities && "vision" in model.capabilities
                                ? model.capabilities.vision === true
                                  ? "supported"
                                  : "unsupported"
                                : "unknown"
                            }
                            disabled={saving}
                            onChange={(e) =>
                              setEditor({
                                ...editor,
                                models: editor.models.map((item) => {
                                  if (item.key !== model.key) return item;
                                  const next = e.target.value;
                                  if (next === "unknown") {
                                    // 未声明 ≠ false：选「未声明」只删除 vision 键，
                                    // 其余能力声明原样保留；删空后回到整体未声明。
                                    if (!item.capabilities) return item;
                                    const { vision: _vision, ...rest } = item.capabilities;
                                    return {
                                      ...item,
                                      capabilities: Object.keys(rest).length ? rest : undefined,
                                    };
                                  }
                                  return {
                                    ...item,
                                    capabilities: {
                                      toolCalling: false,
                                      parallelToolCalls: false,
                                      codeExecution: false,
                                      ...item.capabilities,
                                      vision: next === "supported",
                                    },
                                  };
                                }),
                              })
                            }
                          >
                            <option value="unknown">{t("models.visionUnknown")}</option>
                            <option value="supported">{t("models.visionSupported")}</option>
                            <option value="unsupported">{t("models.visionUnsupported")}</option>
                          </NativeSelect>
                        </Field>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t(
                          model.capabilities
                            ? "models.capabilitiesDeclared"
                            : "models.capabilitiesUndeclared",
                        )}
                      </p>
                      {model.capabilities && (
                        <Button
                          variant="ghost"
                          size="sm"
                          tooltip={t("hints.system.clearCapabilities")}
                          disabled={saving}
                          onClick={() =>
                            setEditor({
                              ...editor,
                              models: editor.models.map((item) =>
                                item.key !== model.key
                                  ? item
                                  : {
                                      key: item.key,
                                      name: item.name,
                                      window: item.window,
                                      ...(item.tokenizerEncoding === undefined
                                        ? {}
                                        : { tokenizerEncoding: item.tokenizerEncoding }),
                                    },
                              ),
                            })
                          }
                        >
                          {t("models.clearCapabilities")}
                        </Button>
                      )}
                    </fieldset>
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
                  <Button
                    variant="ghost"
                    tooltip={t("hints.system.deleteProvider")}
                    disabled={saving}
                    onClick={() => setPending("delete")}
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
      {active && pending && (
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
