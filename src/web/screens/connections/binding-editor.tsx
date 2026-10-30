import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  isQqPrivateSelfTarget,
  type QqBindingResponse,
  type QqConversationListItem,
  type UpdateQqBindingRequest,
} from "../../../shared/contracts/qq";
import { isEmptyQqGroupOverrides } from "../../../shared/contracts/qq-group-config";
import { Field } from "../../components/form-field";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { parseAdminMembers } from "../../features/qq/draft-state";
import { qqGroupSchemeChangeRows } from "../../features/qq/group-config-state";
import { QQ_SCHEME_FIELD_LABELS, TRIGGER_LABELS } from "../../features/qq/scheme-field-metadata";
import { useQqInput } from "../../features/qq/use-qq-input";
import { msg, translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { WorkspaceHelp } from "../../workspace/WorkspaceHelp";
import { BindingMemoryControls } from "../library/BindingMemoryControls";
import { AdminMembersEditor } from "./admin-members-editor";
import { SchemeFieldCard } from "./scheme-field-shared";

type SchemeChangePatch = {
  agent_id: string;
  scheme_id: string;
  task_limits?: QqBindingResponse["task_limits"];
  input_anti_spam?: QqBindingResponse["input_anti_spam"];
} & Pick<UpdateQqBindingRequest, "scheme_change" | "scheme_change_baseline">;

interface SchemeChangePreview {
  schemeName: string;
  commit: (decision: "keep" | "reset") => void;
  rows: { key: string; label: string; current: string; next: string }[];
}

function Assignment({
  agentId,
  schemeId,
  onChange,
}: {
  agentId: string;
  schemeId: string;
  onChange: (patch: { agentId?: string; schemeId?: string }) => void;
}) {
  const { t } = useTranslation();
  const { agents, qqSchemes, qqAccessSaving } = useSuperstringStore(
    useShallow((s) => ({
      agents: s.agents,
      qqSchemes: s.qqSchemes,
      qqAccessSaving: s.qqAccessSaving,
    })),
  );
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field label="connections.assistant" tooltip={t("hints.fieldExtra.bindingAgent")}>
        <NativeSelect
          value={agentId}
          disabled={qqAccessSaving}
          onChange={(e) => onChange({ agentId: e.target.value })}
        >
          {!agents.length && <option value="">{t("connections.noAgentsYet")}</option>}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="connections.schemes" tooltip={t("hints.fieldExtra.bindingScheme")}>
        <NativeSelect
          value={schemeId}
          disabled={qqAccessSaving}
          onChange={(e) => onChange({ schemeId: e.target.value })}
        >
          {!qqSchemes.length && <option value="">{t("connections.noSchemesYet")}</option>}
          {qqSchemes.map((scheme) => (
            <option key={scheme.id} value={scheme.id}>
              {scheme.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </div>
  );
}

export function BindingEditor({
  conversation,
  binding,
  onClose,
  onCloseAutoFocus,
  initialSection,
  navigationConfirmation = false,
  onSaved,
}: {
  conversation: QqConversationListItem;
  binding: QqBindingResponse | null;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
  initialSection?: "administrators";
  navigationConfirmation?: boolean;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const state = useSuperstringStore(
    useShallow((s) => ({
      agents: s.agents,
      apiClient: s.apiClient,
      bindQqConversation: s.bindQqConversation,
      error: s.error,
      feedback: s.feedback,
      loadQqBindingDirectory: s.loadQqBindingDirectory,
      openQqGroupConfig: s.openQqGroupConfig,
      openSettingsRoute: s.openSettingsRoute,
      qqAccessSaving: s.qqAccessSaving,
      qqBindingsLoading: s.qqBindingsLoading,
      qqGroupConfigSaving: s.qqGroupConfigSaving,
      qqMemoryBatchSaving: s.qqMemoryBatchSaving,
      qqSchemeSaving: s.qqSchemeSaving,
      qqSchemes: s.qqSchemes,
      qqSettings: s.qqSettings,
      bindingSchemeConfirmationId: s.qqInputs.bindingSchemeConfirmationId,
      requestQqSchemeNavigation: s.requestQqSchemeNavigation,
      updateQqBindingRow: s.updateQqBindingRow,
    })),
  );
  const [choices, setChoices] = useQqInput("choices");
  const [attention, setAttention] = useQqInput("attention");
  const adminSectionRef = useRef<HTMLDivElement | null>(null);
  const key = binding?.id ?? `${conversation.kind}:${conversation.peer_id}`;
  const choice = choices[key] ?? {
    agentId: binding?.agent_id ?? state.agents[0]?.id ?? "",
    schemeId: binding?.scheme_id ?? state.qqSchemes[0]?.id ?? "",
    source: binding ?? undefined,
    task_limits: binding ? { ...binding.task_limits } : undefined,
    input_anti_spam: binding ? { ...binding.input_anti_spam } : undefined,
  };
  const effectiveLimits =
    choice.task_limits ??
    (binding ? binding.task_limits : { mention_task_limit: null, ordinary_task_limit: null });
  const effectiveAntiSpam =
    choice.input_anti_spam ??
    (binding
      ? binding.input_anti_spam
      : { enabled: null, burst_min_messages: null, burst_window_seconds: null });
  const rawMention = choice.task_limits_raw?.mention_task_limit;
  const rawOrdinary = choice.task_limits_raw?.ordinary_task_limit;
  const hasInvalidLimits = rawMention !== undefined || rawOrdinary !== undefined;
  const choiceTaskLimitsDirty =
    !!binding &&
    choice.task_limits !== undefined &&
    (choice.task_limits.mention_task_limit !== binding.task_limits.mention_task_limit ||
      choice.task_limits.ordinary_task_limit !== binding.task_limits.ordinary_task_limit);
  const choiceInputAntiSpamDirty =
    !!binding &&
    choice.input_anti_spam !== undefined &&
    (choice.input_anti_spam.enabled !== binding.input_anti_spam.enabled ||
      choice.input_anti_spam.burst_min_messages !== binding.input_anti_spam.burst_min_messages ||
      choice.input_anti_spam.burst_window_seconds !== binding.input_anti_spam.burst_window_seconds);
  const rawMinMessages = choice.input_anti_spam_raw?.burst_min_messages;
  const rawWindowSeconds = choice.input_anti_spam_raw?.burst_window_seconds;
  const hasInvalidAntiSpam = rawMinMessages !== undefined || rawWindowSeconds !== undefined;
  const saving = state.qqAccessSaving;
  const [preview, setPreview] = useState<SchemeChangePreview | null>(null);
  // 常挂载确认弹窗在关闭动画期间仍会渲染：目标取最近一次预览快照。
  const previewRef = useRef<SchemeChangePreview | null>(null);
  if (preview) previewRef.current = preview;
  const previewView = preview ?? previewRef.current;
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const operationId = useRef(0);
  const editorIdentity = useRef({ key, api: state.apiClient });
  editorIdentity.current = { key, api: state.apiClient };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Replacing the binding, API or confirmation owner must invalidate its pending preview work, even when the effect body only changes local state and refs.
  useEffect(() => {
    setPreviewBusy(false);
    return () => {
      operationId.current += 1;
    };
  }, [key, state.apiClient, state.bindingSchemeConfirmationId]);
  const cancelPreview = () => {
    operationId.current += 1;
    setPreview(null);
    setPreviewBusy(false);
  };
  const closeEditor = () => {
    cancelPreview();
    onClose();
  };
  const confirmSchemeChange = (decision: "keep" | "reset") => {
    preview?.commit(decision);
    setPreview(null);
  };
  const save = async () => {
    if (!choice.agentId || !choice.schemeId) return;
    const id = ++operationId.current;
    const api = state.apiClient;
    const submittedChoice = useSuperstringStore.getState().qqInputs.choices[key];
    const ownsChoice = () =>
      operationId.current === id &&
      editorIdentity.current.key === key &&
      editorIdentity.current.api === api &&
      useSuperstringStore.getState().apiClient === api &&
      (navigationConfirmation ||
        useSuperstringStore.getState().qqInputs.bindingSchemeConfirmationId !== key) &&
      useSuperstringStore.getState().qqInputs.choices[key] === submittedChoice;
    const clearSubmittedChoice = () => {
      if (!ownsChoice()) return;
      setChoices((old) => {
        if (old[key] !== submittedChoice) return old;
        const next = { ...old };
        delete next[key];
        return next;
      });
      onSaved?.();
    };
    if (!binding) {
      const ok = await state.bindQqConversation({ conversation, ...choice });
      if (ok) clearSubmittedChoice();
      return;
    }
    const row = choice.source ?? binding;
    const patch: SchemeChangePatch = {
      agent_id: choice.agentId,
      scheme_id: choice.schemeId,
      ...(choiceTaskLimitsDirty ? { task_limits: choice.task_limits } : {}),
      ...(choiceInputAntiSpamDirty ? { input_anti_spam: choice.input_anti_spam } : {}),
    };
    const target = state.qqSchemes.find((item) => item.id === choice.schemeId);
    const isCurrent = () => {
      const current = useSuperstringStore.getState();
      const latest = current.qqBindings.find((item) => item.id === row.id);
      return (
        ownsChoice() &&
        !!latest &&
        latest.agent_id === row.agent_id &&
        latest.scheme_id === row.scheme_id &&
        latest.revision === row.revision &&
        (!target ||
          current.qqSchemes.some(
            (item) => item.id === target.id && item.revision === target.revision,
          ))
      );
    };
    const commit = async (input: SchemeChangePatch) => {
      if (!isCurrent()) {
        if (ownsChoice())
          setPreviewError(
            msg("读取配置已被其他操作修改；草稿已保留。请刷新保存基线，核对后再次保存。"),
          );
        return;
      }
      const ok = await state.updateQqBindingRow(row, input);
      if (ok) clearSubmittedChoice();
    };
    if (row.agent_id === choice.agentId && row.scheme_id !== choice.schemeId) {
      if (!target) {
        setPreviewError(msg("操作失败，请重试。"));
        return;
      }
      setPreviewBusy(true);
      setPreviewError(null);
      try {
        const config = await api.getQqGroupConfig(row.id);
        if (!ownsChoice()) return;
        if (
          !isCurrent() ||
          config.binding.id !== row.id ||
          config.binding.agent_id !== row.agent_id ||
          config.binding.scheme_id !== row.scheme_id ||
          config.binding.revision !== row.revision
        ) {
          setPreviewError(
            msg("读取配置已被其他操作修改；草稿已保留。请刷新保存基线，核对后再次保存。"),
          );
          return;
        }
        const input = {
          ...patch,
          scheme_change_baseline: {
            config_revision: config.revision,
            scheme_revision: target.revision,
          },
        };
        if (isEmptyQqGroupOverrides(config.overrides)) {
          await commit(input);
          return;
        }
        setPreview({
          schemeName: target.name,
          rows: qqGroupSchemeChangeRows(config.overrides, target).map((row) => ({
            ...row,
            label: QQ_SCHEME_FIELD_LABELS[row.key] ?? row.key,
          })),
          commit: (decision) => void commit({ ...input, scheme_change: decision }),
        });
      } catch (error) {
        if (ownsChoice()) setPreviewError(error instanceof Error ? error.message : String(error));
      } finally {
        if (operationId.current === id) setPreviewBusy(false);
      }
      return;
    }
    await commit(patch);
  };
  const attentionValue = binding
    ? (attention[binding.id] ?? {
        source: binding,
        mode: binding.attention.mode,
        members: binding.attention.members.join(" "),
      })
    : null;
  // The navigation handoff uses this same editor; its previous host is not a second visible sheet.
  if (!navigationConfirmation && state.bindingSchemeConfirmationId === key) return null;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !saving) closeEditor();
      }}
    >
      <SheetContent
        scrollMode="surface"
        className="w-full min-w-0  sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          if (initialSection === "administrators" && adminSectionRef.current) {
            event.preventDefault();
            const prefersReducedMotion =
              typeof window !== "undefined" &&
              window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
            adminSectionRef.current.scrollIntoView({
              behavior: prefersReducedMotion ? "auto" : "smooth",
              block: "start",
            });
            const firstControl =
              adminSectionRef.current.querySelector<HTMLElement>("select, input, button");
            firstControl?.focus();
          }
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <SheetHeader className="border-b px-6 py-4">
          <div className="flex min-w-0 items-start gap-3 pr-6">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary font-mono text-sm font-semibold">
              {conversation.kind === "group" ? "Q" : "P"}
            </div>
            <div className="space-y-0.5 min-w-0">
              <SheetTitle className="tracking-tight text-foreground">
                {t(conversation.kind === "group" ? "connections.group" : "connections.privateChat")}{" "}
                {conversation.peer_id}
              </SheetTitle>
              <SheetDescription className="text-xs text-muted-foreground leading-relaxed">
                {t("schemes.qq.groupConfig.account")} {conversation.account_id}
              </SheetDescription>
            </div>
            <WorkspaceHelp
              title={t("connections.conversationBindingAndOverrides")}
              description={t(
                conversation.kind === "private"
                  ? "qq.entry.private.bindingDescription"
                  : "connections.conversationBindingAndOverrides",
              )}
            />
          </div>
        </SheetHeader>
        <div className="min-w-0 space-y-6 p-6">
          {binding &&
            binding.kind === "private" &&
            isQqPrivateSelfTarget(binding.account_id, binding.peer_id) && (
              <p role="alert" className="text-sm text-destructive">
                {t("qq.entry.existingSelfTarget")}
              </p>
            )}
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {translateNotice(state.error)}
            </p>
          )}
          {state.feedback && !state.error && (
            <p role="status" className="text-sm text-muted-foreground">
              {translateNotice(state.feedback)}
            </p>
          )}
          {navigationConfirmation && (
            <p role="status" className="text-sm text-muted-foreground">
              {t("schemes.bindings.assignment.navigationConfirmation")}
            </p>
          )}
          <SchemeFieldCard
            title={t("schemes.bindings.assignment.title")}
            description="schemes.bindings.assignment.hint"
          >
            <Assignment
              agentId={choice.agentId}
              schemeId={choice.schemeId}
              onChange={(patch) => {
                cancelPreview();
                setChoices((old) => ({ ...old, [key]: { ...choice, ...patch } }));
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t("schemes.bindings.assignment.saveScope")}
            </p>
            {/* 共享方案影响多个会话；在跳转操作前明确范围。 */}
            <div className="space-y-1.5 pt-1">
              <p className="text-xs text-muted-foreground">
                {t("connections.aSharedSchemeMayAffectSeveralConversationsReviewIts")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={saving || state.qqSchemeSaving || !choice.schemeId}
                  tooltip={t("hints.qq.editSharedScheme")}
                  onClick={() => state.requestQqSchemeNavigation(choice.schemeId, "settings")}
                >
                  {t("schemes.studio.editScheme")}
                </Button>
                {binding && (
                  <Button
                    variant="outline"
                    disabled={saving || state.qqGroupConfigSaving}
                    tooltip={t("hints.qq.openGroupConfig")}
                    onClick={() => state.openQqGroupConfig(binding.id)}
                  >
                    {t(
                      binding.kind === "private"
                        ? "qq.conversation.privateConfig"
                        : "schemes.qq.groupConfig.controls.configure",
                    )}
                  </Button>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
              <Button
                disabled={
                  saving ||
                  state.qqGroupConfigSaving ||
                  previewBusy ||
                  !choice.agentId ||
                  !choice.schemeId ||
                  hasInvalidLimits ||
                  hasInvalidAntiSpam
                }
                tooltip={t("hints.qq.saveBinding")}
                onClick={() => void save()}
                className="h-8 rounded-lg"
              >
                {t(binding ? "connections.saveBinding" : "connections.bind")}
              </Button>
              {binding && (
                <Button
                  variant="outline"
                  disabled={saving}
                  tooltip={t("hints.qq.togglePause")}
                  onClick={() =>
                    void state.updateQqBindingRow(binding, { paused: !binding.paused })
                  }
                  className="h-8 rounded-lg"
                >
                  {t(binding.paused ? "connections.resume" : "connections.pauseSpeech")}
                </Button>
              )}
              {/* 冲突（409）后显式刷新保存基线：合并本绑定草稿、推进 revision，不提交不改业务默认。 */}
              {binding && (
                <Button
                  variant="outline"
                  disabled={
                    saving ||
                    state.qqSchemeSaving ||
                    state.qqMemoryBatchSaving ||
                    state.qqBindingsLoading
                  }
                  tooltip={t("hints.qq.refreshBaseline")}
                  onClick={() => void state.loadQqBindingDirectory(binding.id)}
                  className="h-8 rounded-lg"
                >
                  {t("capabilities.resources.refreshBaseline")}
                </Button>
              )}
            </div>
          </SchemeFieldCard>
          {previewError && (
            <p role="alert" className="text-sm text-destructive">
              {translateNotice(previewError)}
            </p>
          )}
          {binding && (
            <>
              <SchemeFieldCard
                title={t("schemes.bindings.triggers.title")}
                description={
                  conversation.kind === "private"
                    ? "qq.entry.private.triggers.hint"
                    : "schemes.bindings.triggers.hint"
                }
              >
                <p className="text-xs text-muted-foreground">
                  {t("schemes.bindings.triggers.immediateSave")}
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {Object.entries(TRIGGER_LABELS).map(([key, label]) => {
                    const trigger = key as keyof typeof TRIGGER_LABELS;
                    const value = binding.triggers[trigger];
                    const labelKey =
                      conversation.kind === "private" ? `qq.entry.private.trigger.${key}` : label;
                    return (
                      <Field
                        key={key}
                        label={labelKey}
                        tooltip={t(
                          conversation.kind === "private"
                            ? `qq.entry.private.triggerHint.${key}`
                            : `strict.qq.trigger.${key}`,
                        )}
                      >
                        <NativeSelect
                          aria-label={t("connections.switchForValue", { "0": t(labelKey) })}
                          disabled={saving}
                          value={value === null ? "inherit" : value ? "on" : "off"}
                          onChange={(e) => {
                            const val =
                              e.target.value === "inherit" ? null : e.target.value === "on";
                            let nextTriggers = {
                              ...binding.triggers,
                              [key]: val,
                            };
                            if (key === "follow_up" && val === true) {
                              nextTriggers = {
                                ...nextTriggers,
                                follow_up: true,
                                chiming_in: false,
                              };
                            } else if (key === "chiming_in" && val === true) {
                              nextTriggers = {
                                ...nextTriggers,
                                chiming_in: true,
                                follow_up: false,
                              };
                            } else if (
                              (key === "follow_up" || key === "chiming_in") &&
                              val === null
                            ) {
                              nextTriggers = { ...nextTriggers, follow_up: null, chiming_in: null };
                            }
                            if (
                              nextTriggers.follow_up === true &&
                              nextTriggers.chiming_in === true
                            ) {
                              nextTriggers = {
                                ...nextTriggers,
                                follow_up: false,
                                chiming_in: true,
                              };
                            }
                            void state.updateQqBindingRow(binding, {
                              triggers: nextTriggers,
                            });
                          }}
                        >
                          <option value="inherit">{t("connections.followTheScheme")}</option>
                          <option value="on">{t("connections.on")}</option>
                          <option value="off">{t("connections.off")}</option>
                        </NativeSelect>
                      </Field>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("connections.triggersMutualExclusionHint")}
                </p>
              </SchemeFieldCard>
              <SchemeFieldCard
                title={t("connections.taskLimitsTitle")}
                description="schemes.bindings.taskLimits.hint"
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label={
                      conversation.kind === "private"
                        ? "qq.entry.private.mentionTaskLimit"
                        : "connections.mentionTaskLimit"
                    }
                    info="connections.mentionTaskLimitBindingHint"
                    tooltip={t("connections.mentionTaskLimitBindingHint")}
                  >
                    <Input
                      type="number"
                      min={1}
                      max={64}
                      placeholder={t("connections.followTheScheme")}
                      disabled={saving}
                      value={
                        rawMention !== undefined
                          ? rawMention
                          : effectiveLimits.mention_task_limit !== null
                            ? String(effectiveLimits.mention_task_limit)
                            : ""
                      }
                      onChange={(e) => {
                        const raw = e.target.value;
                        const trimmed = raw.trim();
                        const isInvalid =
                          trimmed !== "" &&
                          (!/^\d+$/.test(trimmed) || Number(trimmed) < 1 || Number(trimmed) > 64);
                        const currentLimits = choice.task_limits ?? { ...binding.task_limits };
                        const nextRaw = { ...choice.task_limits_raw };
                        if (isInvalid) {
                          nextRaw.mention_task_limit = raw;
                        } else {
                          delete nextRaw.mention_task_limit;
                        }
                        const nextLimits = {
                          ...currentLimits,
                          mention_task_limit: isInvalid
                            ? currentLimits.mention_task_limit
                            : trimmed === ""
                              ? null
                              : Number(trimmed),
                        };
                        setChoices((old) => ({
                          ...old,
                          [key]: {
                            ...choice,
                            task_limits: nextLimits,
                            task_limits_raw: Object.keys(nextRaw).length ? nextRaw : undefined,
                          },
                        }));
                      }}
                    />
                    {rawMention !== undefined && (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {t("connections.enterAValidIntegerWithinTheAllowedRange")}
                      </p>
                    )}
                  </Field>
                  <Field
                    label="connections.ordinaryTaskLimit"
                    info="connections.ordinaryTaskLimitBindingHint"
                    tooltip={t("connections.ordinaryTaskLimitBindingHint")}
                  >
                    <Input
                      type="number"
                      min={1}
                      max={64}
                      placeholder={t("connections.followTheScheme")}
                      disabled={saving}
                      value={
                        rawOrdinary !== undefined
                          ? rawOrdinary
                          : effectiveLimits.ordinary_task_limit !== null
                            ? String(effectiveLimits.ordinary_task_limit)
                            : ""
                      }
                      onChange={(e) => {
                        const raw = e.target.value;
                        const trimmed = raw.trim();
                        const isInvalid =
                          trimmed !== "" &&
                          (!/^\d+$/.test(trimmed) || Number(trimmed) < 1 || Number(trimmed) > 64);
                        const currentLimits = choice.task_limits ?? { ...binding.task_limits };
                        const nextRaw = { ...choice.task_limits_raw };
                        if (isInvalid) {
                          nextRaw.ordinary_task_limit = raw;
                        } else {
                          delete nextRaw.ordinary_task_limit;
                        }
                        const nextLimits = {
                          ...currentLimits,
                          ordinary_task_limit: isInvalid
                            ? currentLimits.ordinary_task_limit
                            : trimmed === ""
                              ? null
                              : Number(trimmed),
                        };
                        setChoices((old) => ({
                          ...old,
                          [key]: {
                            ...choice,
                            task_limits: nextLimits,
                            task_limits_raw: Object.keys(nextRaw).length ? nextRaw : undefined,
                          },
                        }));
                      }}
                    />
                    {rawOrdinary !== undefined && (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {t("connections.enterAValidIntegerWithinTheAllowedRange")}
                      </p>
                    )}
                  </Field>
                </div>
              </SchemeFieldCard>
              <SchemeFieldCard
                title={t("connections.inputAntiSpam")}
                description={
                  conversation.kind === "private"
                    ? "qq.entry.private.inputAntiSpam.hint"
                    : "schemes.bindings.inputAntiSpam.hint"
                }
              >
                <Field label="connections.inputAntiSpam" tooltip={t("hints.qqBinding.antiSpam")}>
                  <NativeSelect
                    aria-label={t("connections.inputAntiSpam")}
                    disabled={saving}
                    value={
                      effectiveAntiSpam.enabled === null
                        ? "inherit"
                        : effectiveAntiSpam.enabled
                          ? "on"
                          : "off"
                    }
                    onChange={(e) => {
                      const val = e.target.value === "inherit" ? null : e.target.value === "on";
                      setChoices((old) => ({
                        ...old,
                        [key]: {
                          ...choice,
                          input_anti_spam: { ...effectiveAntiSpam, enabled: val },
                        },
                      }));
                    }}
                  >
                    <option value="inherit">{t("connections.followTheScheme")}</option>
                    <option value="on">{t("connections.on")}</option>
                    <option value="off">{t("connections.off")}</option>
                  </NativeSelect>
                </Field>
                <div className="grid gap-4 pl-3 border-l-2 border-muted/60 sm:grid-cols-2 sm:pl-4">
                  {(
                    [
                      ["burst_min_messages", "inputAntiSpamBurstMinMessages", 2, 20],
                      ["burst_window_seconds", "inputAntiSpamBurstWindowSeconds", 1, 30],
                    ] as const
                  ).map(([field, labelKey, min, max]) => {
                    const raw = field === "burst_min_messages" ? rawMinMessages : rawWindowSeconds;
                    const value = effectiveAntiSpam[field];
                    return (
                      <Field
                        key={field}
                        label={`connections.${labelKey}`}
                        info={`connections.${labelKey}Hint`}
                        tooltip={t(`connections.${labelKey}Hint`)}
                      >
                        <Input
                          type="number"
                          min={min}
                          max={max}
                          step={1}
                          placeholder={t("connections.followTheScheme")}
                          aria-label={t(`connections.binding.${labelKey}`)}
                          disabled={saving}
                          value={raw ?? (value === null ? "" : String(value))}
                          onChange={(event) => {
                            const text = event.target.value;
                            const trimmed = text.trim();
                            const valid =
                              /^\d+$/.test(trimmed) &&
                              Number(trimmed) >= min &&
                              Number(trimmed) <= max;
                            const nextRaw = { ...choice.input_anti_spam_raw };
                            if (valid || trimmed === "") delete nextRaw[field];
                            else nextRaw[field] = text;
                            const nextValue = valid
                              ? Number(trimmed)
                              : trimmed === ""
                                ? null
                                : value;
                            setChoices((old) => ({
                              ...old,
                              [key]: {
                                ...choice,
                                input_anti_spam: { ...effectiveAntiSpam, [field]: nextValue },
                                input_anti_spam_raw: Object.keys(nextRaw).length
                                  ? nextRaw
                                  : undefined,
                              },
                            }));
                          }}
                        />
                        {raw !== undefined && (
                          <p role="alert" className="mt-1 text-xs text-destructive">
                            {t("connections.enterAValidIntegerWithinTheAllowedRange")}
                          </p>
                        )}
                      </Field>
                    );
                  })}
                </div>
              </SchemeFieldCard>
              {conversation.kind === "group" && (
                <>
                  <div ref={adminSectionRef} data-section="administrators">
                    <SchemeFieldCard
                      title={t("connections.importantPeople")}
                      description="schemes.bindings.attention.hint"
                    >
                      {attentionValue &&
                        (() => {
                          const savedAgent = state.agents.find((a) => a.id === binding?.agent_id);
                          const savedAgentName = savedAgent?.name ?? binding?.agent_id ?? "";
                          const hasPendingAgentChange =
                            choice.agentId && choice.agentId !== binding?.agent_id;
                          const pendingAgentName =
                            state.agents.find((a) => a.id === choice.agentId)?.name ??
                            choice.agentId;
                          const parsedAttention = parseAdminMembers(attentionValue.members);
                          const canSaveAttention =
                            !saving &&
                            (attentionValue.mode === "off" ||
                              (parsedAttention.canonicalCount > 0 &&
                                !parsedAttention.hasInvalid &&
                                !parsedAttention.isOverLimit));

                          return (
                            <>
                              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground pb-2 border-b">
                                <span>{t("connections.scopeNote")}:</span>
                                <Badge variant="outline">{conversation.peer_id}</Badge>
                                <span>·</span>
                                <span>
                                  {t("schemes.qq.groupConfig.agent")}: {savedAgentName}
                                </span>
                                {hasPendingAgentChange && (
                                  <span className="text-muted-foreground font-normal">
                                    （
                                    {t("connections.pendingAgentChangeNote", {
                                      "0": pendingAgentName,
                                    })}
                                    ）
                                  </span>
                                )}
                                <span className="text-xs text-muted-foreground">
                                  ({t("connections.scopeHint")})
                                </span>
                              </div>
                              <Field
                                label="connections.attentionMode"
                                tooltip={t("hints.qqBinding.attention")}
                              >
                                <NativeSelect
                                  value={attentionValue.mode}
                                  disabled={saving}
                                  onChange={(e) =>
                                    setAttention((old) => ({
                                      ...old,
                                      [binding.id]: {
                                        ...attentionValue,
                                        mode: e.target.value as "off" | "soft" | "hard",
                                      },
                                    }))
                                  }
                                >
                                  <option value="off">{t("connections.off2")}</option>
                                  <option value="soft">{t("connections.softPriority")}</option>
                                  <option value="hard">
                                    {t("connections.onlyReplyToTheList")}
                                  </option>
                                </NativeSelect>
                              </Field>
                              <div className="space-y-4 pl-3 border-l-2 border-muted/60 sm:pl-4">
                                <Field
                                  label="connections.attentionList"
                                  info="connections.qqNumbersSeparatedByCommasOrSpaces"
                                  tooltip={t("connections.softPriorityHint")}
                                >
                                  <Input
                                    value={attentionValue.members}
                                    disabled={saving || attentionValue.mode === "off"}
                                    placeholder={t("connections.qqNumbersPlaceholder")}
                                    onChange={(e) =>
                                      setAttention((old) => ({
                                        ...old,
                                        [binding.id]: {
                                          ...attentionValue,
                                          members: e.target.value,
                                        },
                                      }))
                                    }
                                  />
                                </Field>
                                <AdminMembersEditor
                                  value={attentionValue.members}
                                  disabled={saving || attentionValue.mode === "off"}
                                  onChange={(next) =>
                                    setAttention((old) => ({
                                      ...old,
                                      [binding.id]: { ...attentionValue, members: next },
                                    }))
                                  }
                                />
                              </div>
                              <div className="border-t border-border/60 pt-3 flex items-center justify-start">
                                <Button
                                  disabled={!canSaveAttention}
                                  tooltip={t("hints.qq.saveAttentionList")}
                                  className="h-8 rounded-lg"
                                  onClick={() =>
                                    void state
                                      .updateQqBindingRow(attentionValue.source, {
                                        attention:
                                          attentionValue.mode === "off"
                                            ? { mode: "off", members: [] }
                                            : {
                                                mode: attentionValue.mode,
                                                members: parsedAttention.validCanonicalMembers,
                                              },
                                      })
                                      .then((ok) => {
                                        if (ok)
                                          setAttention((old) => {
                                            const next = { ...old };
                                            delete next[binding.id];
                                            return next;
                                          });
                                      })
                                  }
                                >
                                  {t("connections.saveList")}
                                </Button>
                              </div>
                            </>
                          );
                        })()}
                    </SchemeFieldCard>
                  </div>
                </>
              )}
              <SchemeFieldCard title={t("connections.memoryOrganising")}>
                <p className="text-xs text-muted-foreground">{t("schemes.bindings.memory.hint")}</p>
                <BindingMemoryControls
                  binding={{ ...binding, enabled: state.qqSettings?.enabled === true }}
                  pending={binding.pending_observations}
                  disabled={saving}
                  onChanged={() => void state.loadQqBindingDirectory()}
                />
                <div className="border-t pt-2 flex items-center justify-start">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-auto min-h-8 whitespace-normal"
                    tooltip={t("hints.qq.openLongMemory")}
                    onClick={() => {
                      closeEditor();
                      state.openSettingsRoute("long-memory");
                    }}
                  >
                    {t("connections.goToLongTermMemory")}
                  </Button>
                </div>
              </SchemeFieldCard>
            </>
          )}
          <Dialog
            open={preview !== null}
            onOpenChange={(open) => {
              if (!open) cancelPreview();
            }}
          >
            <DialogContent scrollMode="surface" className="max-h-[85dvh]  sm:max-w-lg rounded-xl">
              <DialogHeader>
                <DialogTitle className="tracking-tight">
                  {t("schemes.qq.groupConfig.scheme.confirmTitle", {
                    "0": previewView?.schemeName ?? "",
                  })}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground leading-relaxed">
                  {t("schemes.qq.groupConfig.scheme.confirmBody")}
                </DialogDescription>
              </DialogHeader>
              {previewView && (
                <ul className="divide-y divide-border/60 rounded-lg border border-border/70 bg-muted/20 p-2 text-sm">
                  {previewView.rows.map((row) => (
                    <li
                      key={row.key}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 px-1 text-xs"
                    >
                      <span className="text-muted-foreground">{t(row.label)}</span>
                      <span className="font-mono font-medium text-foreground">
                        {row.current} → {row.next}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <DialogFooter className="gap-2 sm:gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-lg"
                  tooltip={t("hints.qq.previewCancel")}
                  onClick={cancelPreview}
                >
                  {t("connections.cancel")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-lg"
                  disabled={saving}
                  tooltip={t("hints.qq.schemeChangeReset")}
                  onClick={() => confirmSchemeChange("reset")}
                >
                  {t("schemes.qq.groupConfig.scheme.resetLabel")}
                </Button>
                <Button
                  size="sm"
                  className="h-8 rounded-lg"
                  disabled={saving}
                  tooltip={t("hints.qq.schemeChangeKeep")}
                  onClick={() => confirmSchemeChange("keep")}
                >
                  {t("schemes.qq.groupConfig.scheme.keepLabel")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </SheetContent>
    </Sheet>
  );
}
