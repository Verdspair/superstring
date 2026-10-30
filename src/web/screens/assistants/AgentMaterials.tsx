import { BookOpen, Brain, FileText } from "lucide-react";
import { useCallback, useId } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Field } from "@/components/form-field";
import { SettingsGroup } from "@/components/settings-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { translateNotice } from "@/i18n";
import { useForegroundRead } from "@/services/use-foreground-read";
import { useSuperstringStore } from "@/store";
import { AgentKnowledgeReadConfigSchema } from "../../../shared/contracts/knowledge";
import {
  MemoryReadSettingsSchema,
  resolveMemoryReadSettings,
} from "../../../shared/contracts/memory";
import { knowledgeGrantIdsEqual, knowledgeReadDirty } from "../../features/knowledge/types";

function DocumentSelectionRow({
  document,
  checked,
  disabled,
  onCheckedChange,
}: {
  document: { id: string; name: string; summary: string };
  checked: boolean;
  disabled: boolean;
  onCheckedChange(checked: boolean): void;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  return (
    <div className="flex items-start gap-3 rounded-lg p-2 hover:bg-muted">
      <Checkbox
        id={id}
        aria-label={document.name}
        aria-describedby={descriptionId}
        disabled={disabled}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <label htmlFor={id} className="min-w-0 cursor-pointer text-sm">
        {document.name}
        <span id={descriptionId} className="block text-xs text-muted-foreground">
          {document.summary}
        </span>
      </label>
    </div>
  );
}

/** The materials task owns presentation; domain actions own drafts, transport and saving. */
export function AgentMaterials({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const s = useSuperstringStore(
    useShallow((state) => ({
      api: state.apiClient,
      editor: state.pageEditor,
      agentId: state.editorAgentId,
      editorLoading: state.editorLoading,
      saving: state.settingsSaving,
      read: state.knowledgeReadEditor,
      loading: state.knowledgeReadLoading,
      readError: state.knowledgeReadError,
      global: state.knowledgeSettings,
      invalid: state.allocationInvalidInputs,
      load: state.loadKnowledgeRead,
      cancel: state.cancelKnowledgeRead,
      patchRead: state.patchKnowledgeRead,
      patchAgent: state.patchPageAgent,
      navigate: state.openWorkspaceTarget,
      openAllocation: state.openContextAllocation,
      permissionEditor: state.permissionEditor,
    })),
  );
  const editorToken = s.editor?.token;
  const inheritId = useId();
  const knowledgeBudgetId = useId();
  const load = useCallback(() => {
    const current = useSuperstringStore.getState();
    if (
      current.apiClient !== s.api ||
      current.editorAgentId !== s.agentId ||
      current.pageEditor?.token !== editorToken
    )
      return;
    void s.load();
  }, [s.api, s.agentId, editorToken, s.load]);
  useForegroundRead(load, s.cancel, {
    enabled: s.agentId !== "__new__" && !!s.editor,
    paused: !active,
    intervalMs: null,
    retainOnHide: true,
    onSuspend: s.cancel,
  });
  const editor = s.editor;
  if (!editor) return null;
  const memory = resolveMemoryReadSettings(editor.draft.p5_config);
  const read = s.read?.agentId === editor.agent.id ? s.read : null;
  const busy = s.saving || s.editorLoading || s.loading;
  const memoryKey = `agent:${editor.agent.id}:reading:memory:bytes`;
  const knowledgeKey = `agent:${editor.agent.id}:reading:knowledgeAgent`;
  const numberInput = (
    key: string,
    raw: string,
    validate: (value: number) => boolean,
    commit: (value: number) => void,
  ) => {
    const value = Number(raw);
    const valid = raw.trim() !== "" && validate(value);
    useSuperstringStore.setState((state) => {
      const invalid = { ...state.allocationInvalidInputs };
      if (valid) delete invalid[key];
      else invalid[key] = raw;
      return { allocationInvalidInputs: invalid };
    });
    if (valid) commit(value);
  };
  const patchMemory = (patch: { enabled?: boolean; max_bytes?: number }) =>
    s.patchAgent("memory-tools", {
      p5_config: {
        ...editor.draft.p5_config,
        memory_read: { enabled: memory.enabled, max_bytes: memory.maxBytes, ...patch },
      },
    });
  const inherit = read?.draft.context_budget === null && s.invalid[knowledgeKey] === undefined;
  const globalBytes = s.global?.context_budget ?? read?.globalBudget;
  const compare = knowledgeReadDirty(read);
  const selectionChanged =
    !!read &&
    (read.draft.scope !== read.source.config.scope ||
      !knowledgeGrantIdsEqual(read.draft.document_ids, read.source.config.document_ids));
  return (
    <div className="space-y-6" data-testid="agent-materials">
      <SettingsGroup
        title={
          <span className="flex items-center gap-2">
            <Brain className="size-4" />
            {t("agent.materials.memory")}
          </span>
        }
        containerClassName="space-y-4 divide-y-0 settings-content-padding"
      >
        <div className="space-y-4">
          <Field label="agent.materials.memoryEnabled" tooltip={t("agent.materials.memoryHelp")}>
            <Checkbox
              checked={memory.enabled}
              disabled={busy}
              onCheckedChange={(value) => patchMemory({ enabled: value === true })}
            />
          </Field>
          <Field
            label="agent.materials.memoryBytes"
            unit="Bytes"
            tooltip={t("agent.materials.bytesHelp")}
          >
            <Input
              aria-label={t("agent.materials.memoryBytes")}
              inputMode="numeric"
              disabled={busy}
              value={s.invalid[memoryKey] ?? String(memory.maxBytes)}
              aria-invalid={s.invalid[memoryKey] !== undefined || undefined}
              onChange={(event) =>
                numberInput(
                  memoryKey,
                  event.target.value,
                  (value) => MemoryReadSettingsSchema.shape.max_bytes.safeParse(value).success,
                  (max_bytes) => patchMemory({ max_bytes }),
                )
              }
            />
            {s.invalid[memoryKey] !== undefined && (
              <p role="alert" className="text-xs text-destructive">
                {t("agent.materials.invalidBytes")}
              </p>
            )}
          </Field>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("agent.materials.scope")}
          </p>
          <Button
            variant="outline"
            className="h-auto min-h-8 max-w-full whitespace-normal break-words"
            disabled={busy}
            onClick={() => s.navigate("long-memory", editor.agent.id)}
          >
            <BookOpen />
            {t("agent.materials.manageMemory")}
          </Button>
        </div>
      </SettingsGroup>
      <SettingsGroup
        title={
          <span className="flex items-center gap-2">
            <FileText className="size-4" />
            {t("agent.materials.knowledge")}
          </span>
        }
        containerClassName="space-y-4 divide-y-0 settings-content-padding"
      >
        {s.readError && (
          <p role="alert" className="text-sm text-destructive">
            {translateNotice(s.readError)}
          </p>
        )}
        {!read ? (
          <div className="flex items-center justify-between gap-2">
            <p role="status">
              {t(s.loading ? "library.loading" : "agent.materials.readUnavailable")}
            </p>
            <Button variant="outline" disabled={busy} onClick={() => void s.load()}>
              {t("capabilities.retry")}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {compare && (
              <section
                aria-label={t("materials.savedBaseline")}
                className="space-y-2 rounded-lg border bg-muted/20 p-3 text-sm"
              >
                <h3 className="font-medium">
                  {t("materials.savedBaseline")} ·{" "}
                  {t("common.revision", { "0": read.source.revision })}
                </h3>
                <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[auto_1fr]">
                  {read.draft.enabled !== read.source.config.enabled && (
                    <>
                      <dt>{t("library.enable.knowledge.reading")}</dt>
                      <dd>
                        {t(read.source.config.enabled ? "materials.enabled" : "materials.disabled")}
                      </dd>
                    </>
                  )}
                  {selectionChanged && (
                    <>
                      <dt>{t("library.reading.scope")}</dt>
                      <dd>
                        {t(
                          read.source.config.scope === "all"
                            ? "library.all.authorized.documents"
                            : "library.selected.documents.only",
                        )}
                      </dd>
                    </>
                  )}
                  {read.draft.context_budget !== read.source.config.context_budget && (
                    <>
                      <dt>{t("agent.materials.knowledgeBytes")}</dt>
                      <dd>
                        {read.source.config.context_budget === null
                          ? t("materials.inheritedBytes", { bytes: globalBytes ?? "?" })
                          : `${read.source.config.context_budget} Bytes`}
                      </dd>
                    </>
                  )}
                  {selectionChanged && read.source.config.scope === "selected" && (
                    <>
                      <dt>{t("library.selected.documents.only")}</dt>
                      <dd>
                        <ul className="space-y-1 break-words">
                          {read.source.config.document_ids.map((id) => (
                            <li key={id}>
                              {read.documents.find((document) => document.id === id)?.name ??
                                t("materials.unknownDocument", { id })}
                            </li>
                          ))}
                          {!read.source.config.document_ids.length && (
                            <li>
                              {t("library.no.documents.selected.this.mode.will.not.read.any")}
                            </li>
                          )}
                        </ul>
                      </dd>
                    </>
                  )}
                </dl>
              </section>
            )}
            {compare && <h3 className="text-sm font-medium">{t("materials.localDraft")}</h3>}
            <Field label="library.enable.knowledge.reading">
              <Checkbox
                checked={read.draft.enabled}
                disabled={busy}
                onCheckedChange={(value) => s.patchRead({ enabled: value === true })}
              />
            </Field>
            <Field label="library.reading.scope">
              <NativeSelect
                aria-label={t("library.reading.scope")}
                value={read.draft.scope}
                disabled={busy}
                onChange={(event) =>
                  s.patchRead({
                    scope: event.target.value as "all" | "selected",
                    document_ids: event.target.value === "all" ? [] : read.draft.document_ids,
                  })
                }
              >
                <option value="all">{t("library.all.authorized.documents")}</option>
                <option value="selected">{t("library.selected.documents.only")}</option>
              </NativeSelect>
            </Field>
            {read.draft.scope === "selected" && (
              <div className="space-y-2">
                {read.documents.map((document) => (
                  <DocumentSelectionRow
                    key={document.id}
                    document={document}
                    disabled={busy}
                    checked={read.draft.document_ids.includes(document.id)}
                    onCheckedChange={(checked) =>
                      s.patchRead({
                        document_ids: checked
                          ? [...read.draft.document_ids, document.id]
                          : read.draft.document_ids.filter((id) => id !== document.id),
                      })
                    }
                  />
                ))}
                {read.draft.document_ids
                  .filter((id) => !read.documents.some((doc) => doc.id === id))
                  .map((id) => (
                    <div key={id} className="flex flex-wrap items-center gap-2">
                      <Badge variant="destructive">{t("library.authorization.expired")}</Badge>
                      <code>{id}</code>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          s.patchRead({
                            document_ids: read.draft.document_ids.filter((other) => other !== id),
                          })
                        }
                      >
                        {t("library.remove")}
                      </Button>
                    </div>
                  ))}
                {!read.draft.document_ids.length && (
                  <p className="text-xs text-muted-foreground">
                    {t("library.no.documents.selected.this.mode.will.not.read.any")}
                  </p>
                )}
              </div>
            )}
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={inheritId}
                  checked={inherit}
                  disabled={busy}
                  onCheckedChange={(checked) => {
                    useSuperstringStore.setState((state) => {
                      const invalid = { ...state.allocationInvalidInputs };
                      delete invalid[knowledgeKey];
                      if (checked !== true && globalBytes === undefined) invalid[knowledgeKey] = "";
                      return { allocationInvalidInputs: invalid };
                    });
                    s.patchRead({
                      context_budget: checked === true ? null : (globalBytes ?? null),
                    });
                  }}
                />
                <label htmlFor={inheritId} className="cursor-pointer">
                  {t("schemes.allocation.reading.followGlobalDefault")}
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("agent.materials.savedGlobalBytes", { bytes: globalBytes ?? "?" })}
              </p>
              {!inherit && (
                <Field label="agent.materials.knowledgeBytes" unit="Bytes">
                  <Input
                    id={knowledgeBudgetId}
                    data-testid="reading-knowledge-agent-budget-input"
                    aria-label={t("agent.materials.knowledgeBytes")}
                    disabled={busy}
                    inputMode="numeric"
                    value={s.invalid[knowledgeKey] ?? String(read.draft.context_budget ?? "")}
                    aria-invalid={s.invalid[knowledgeKey] !== undefined || undefined}
                    onChange={(event) =>
                      numberInput(
                        knowledgeKey,
                        event.target.value,
                        (value) =>
                          AgentKnowledgeReadConfigSchema.shape.context_budget
                            .unwrap()
                            .unwrap()
                            .safeParse(value).success,
                        (context_budget) => s.patchRead({ context_budget }),
                      )
                    }
                  />
                </Field>
              )}
              {s.invalid[knowledgeKey] !== undefined && (
                <p role="alert" className="text-xs text-destructive">
                  {t("agent.materials.invalidBytes")}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="h-auto min-h-8 max-w-full whitespace-normal break-words"
                disabled={busy}
                onClick={() => s.navigate("knowledge-config")}
              >
                <FileText />
                {t("capabilities.resources.openKnowledgeDocuments")}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  s.openAllocation({
                    purpose: "reading",
                    agentId: null,
                    returnRoute: "knowledge-tools",
                    returnLabel: t("agent.materials.knowledge"),
                  })
                }
              >
                {t("library.knowledge.global.budget")}
              </Button>
            </div>
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}
