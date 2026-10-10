import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  QqBindingResponse,
  QqConversationListItem,
  QqSchemeResponse,
  UpdateQqBindingRequest,
} from "../../../shared/contracts/qq";

import {
  isEmptyQqGroupOverrides,
  type QqGroupSchemeOverrides,
} from "../../../shared/contracts/qq-group-config";
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
import { QQ_SCHEME_FIELD_LABELS, TRIGGER_LABELS } from "../../features/qq/scheme-field-metadata";
import { useQqInput } from "../../features/qq/use-qq-input";
import { msg, translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { BindingMemoryControls } from "../library/BindingMemoryControls";
import { AdminMembersEditor } from "./admin-members-editor";
import { SchemeFieldCard } from "./scheme-field-shared";

/** 预览值的中性文本：数组按集合去序、装配冗余按百分比，其余 String()。 */
const schemeChangeValueText = (group: string, name: string, value: unknown): string =>
  group === "compression" && name === "headroom_ratio" && typeof value === "number"
    ? `${Number((value * 100).toFixed(2))}%`
    : Array.isArray(value)
      ? value.map(String).sort().join("、")
      : String(value);

/** 换基础方案的逐字段预览：现有本群自定义值 → 目标基础方案值，全部差异都要出现。 */
function schemeChangeRows(overrides: QqGroupSchemeOverrides, target: QqSchemeResponse) {
  const targetBag = target as unknown as Record<string, Record<string, unknown> | undefined>;
  const rows: SchemeChangePreview["rows"] = [];
  for (const [group, fields] of Object.entries(overrides)) {
    if (!fields || typeof fields !== "object") continue;
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const nextValue = targetBag[group]?.[name];
      rows.push({
        key: `${group}.${name}`,
        label: QQ_SCHEME_FIELD_LABELS[`${group}.${name}`] ?? `${group}.${name}`,
        current: schemeChangeValueText(group, name, value),
        next: nextValue === undefined ? "—" : schemeChangeValueText(group, name, nextValue),
      });
    }
  }
  return rows;
}

type SchemeChangePatch = { agent_id: string; scheme_id: string } & Pick<
  UpdateQqBindingRequest,
  "scheme_change"
>;

interface SchemeChangePreview {
  row: QqBindingResponse;
  schemeId: string;
  schemeName: string;
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
  const { agents, qqSchemes, qqAccessSaving } = useSuperstringStore();
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field label="connections.assistant">
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
      <Field label="connections.schemes">
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
}: {
  conversation: QqConversationListItem;
  binding: QqBindingResponse | null;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
  initialSection?: "administrators";
}) {
  const { t } = useTranslation();
  const state = useSuperstringStore();
  const [choices, setChoices] = useQqInput("choices");
  const [attention, setAttention] = useQqInput("attention");
  const adminSectionRef = useRef<HTMLDivElement | null>(null);
  const key = binding?.id ?? `${conversation.kind}:${conversation.peer_id}`;
  const choice = choices[key] ?? {
    agentId: binding?.agent_id ?? state.agents[0]?.id ?? "",
    schemeId: binding?.scheme_id ?? state.qqSchemes[0]?.id ?? "",
    source: binding ?? undefined,
  };
  const saving = state.qqAccessSaving;
  const [preview, setPreview] = useState<SchemeChangePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const clearChoice = () =>
    setChoices((old) => {
      const next = { ...old };
      delete next[key];
      return next;
    });
  const commitBinding = (row: QqBindingResponse, patch: SchemeChangePatch) => {
    void state.updateQqBindingRow(row, patch).then((ok) => {
      if (ok) clearChoice();
    });
  };
  const confirmSchemeChange = (schemeChange: "keep" | "reset") => {
    if (!preview) return;
    commitBinding(preview.row, {
      agent_id: preview.row.agent_id,
      scheme_id: preview.schemeId,
      scheme_change: schemeChange,
    });
    setPreview(null);
  };
  const save = async () => {
    if (!choice.agentId || !choice.schemeId) return;
    if (!binding) {
      void state.bindQqConversation({ conversation, ...choice }).then((ok) => {
        if (ok) clearChoice();
      });
      return;
    }
    const row = choice.source ?? binding;
    if (
      row.kind === "group" &&
      row.agent_id === choice.agentId &&
      row.scheme_id !== choice.schemeId
    ) {
      setPreviewBusy(true);
      setPreviewError(null);
      try {
        const config = await state.apiClient.getQqGroupConfig(row.id);
        const current = useSuperstringStore.getState();
        const latest = current.qqBindings.find((item) => item.id === row.id);
        // 读回的记录必须仍对应正在编辑的这行（绑定身份未变），晚到或错行的答案不进预览。
        if (
          config.binding.id !== row.id ||
          config.binding.agent_id !== row.agent_id ||
          config.binding.scheme_id !== row.scheme_id ||
          !latest ||
          latest.agent_id !== row.agent_id ||
          latest.scheme_id !== row.scheme_id
        ) {
          setPreviewError(
            msg("读取配置已被其他操作修改；草稿已保留。请刷新保存基线，核对后再次保存。"),
          );
          return;
        }
        if (isEmptyQqGroupOverrides(config.overrides)) {
          commitBinding(row, { agent_id: row.agent_id, scheme_id: choice.schemeId });
          return;
        }
        const target = current.qqSchemes.find((item) => item.id === choice.schemeId);
        if (!target) {
          setPreviewError(msg("操作失败，请重试。"));
          return;
        }
        setPreview({
          row,
          schemeId: choice.schemeId,
          schemeName: target.name,
          rows: schemeChangeRows(config.overrides, target),
        });
      } catch (error) {
        setPreviewError(error instanceof Error ? error.message : String(error));
      } finally {
        setPreviewBusy(false);
      }
      return;
    }
    commitBinding(row, { agent_id: choice.agentId, scheme_id: choice.schemeId });
  };
  const attentionValue = binding
    ? (attention[binding.id] ?? {
        source: binding,
        mode: binding.attention.mode,
        members: binding.attention.members.join(" "),
      })
    : null;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-xl"
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
        <SheetHeader className="border-b pb-6">
          <SheetTitle>
            {t(conversation.kind === "group" ? "connections.group" : "connections.privateChat")}{" "}
            {conversation.peer_id}
          </SheetTitle>
          <SheetDescription>{t("connections.conversationBindingAndOverrides")}</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 p-6">
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
          <SchemeFieldCard
            title={t("schemes.bindings.assignment.title")}
            description="schemes.bindings.assignment.hint"
          >
            <Assignment
              agentId={choice.agentId}
              schemeId={choice.schemeId}
              onChange={(patch) =>
                setChoices((old) => ({ ...old, [key]: { ...choice, ...patch } }))
              }
            />
            {/* 编辑方案直达的是共享方案本体：文案先说明会影响使用它的会话。 */}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {t("connections.aSharedSchemeMayAffectSeveralConversationsReviewIts")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={saving || state.qqSchemeSaving || !choice.schemeId}
                  onClick={() => state.requestQqSchemeNavigation(choice.schemeId, "settings")}
                >
                  {t("schemes.studio.editScheme")}
                </Button>
                {binding?.kind === "group" && (
                  <Button
                    variant="outline"
                    disabled={saving || state.qqGroupConfigSaving}
                    onClick={() => state.openQqGroupConfig(binding.id)}
                  >
                    {t("schemes.qq.groupConfig.controls.configure")}
                  </Button>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={
                  saving ||
                  state.qqGroupConfigSaving ||
                  previewBusy ||
                  !choice.agentId ||
                  !choice.schemeId
                }
                onClick={() => void save()}
              >
                {t(binding ? "connections.saveBinding" : "connections.bind")}
              </Button>
              {binding && (
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() =>
                    void state.updateQqBindingRow(binding, { paused: !binding.paused })
                  }
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
                  onClick={() => void state.loadQqBindingDirectory(binding.id)}
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
                description="schemes.bindings.triggers.hint"
              >
                {Object.entries(TRIGGER_LABELS).map(([key, label]) => {
                  const trigger = key as keyof typeof TRIGGER_LABELS;
                  const value = binding.triggers[trigger];
                  return (
                    <Field key={key} label={label}>
                      <NativeSelect
                        aria-label={t("connections.switchForValue", { "0": t(label) })}
                        disabled={saving}
                        value={value === null ? "inherit" : value ? "on" : "off"}
                        onChange={(e) => {
                          const val = e.target.value === "inherit" ? null : e.target.value === "on";
                          let nextTriggers = {
                            ...binding.triggers,
                            [key]: val,
                          };
                          if (key === "follow_up" && val === true) {
                            nextTriggers = { ...nextTriggers, follow_up: true, chiming_in: false };
                          } else if (key === "chiming_in" && val === true) {
                            nextTriggers = { ...nextTriggers, chiming_in: true, follow_up: false };
                          } else if (
                            (key === "follow_up" || key === "chiming_in") &&
                            val === null
                          ) {
                            nextTriggers = { ...nextTriggers, follow_up: null, chiming_in: null };
                          }
                          if (nextTriggers.follow_up === true && nextTriggers.chiming_in === true) {
                            nextTriggers = { ...nextTriggers, follow_up: false, chiming_in: true };
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
                <p className="mt-3 text-xs text-muted-foreground">
                  {t("connections.triggersMutualExclusionHint")}
                </p>
              </SchemeFieldCard>
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
                        state.agents.find((a) => a.id === choice.agentId)?.name ?? choice.agentId;
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
                            <span className="text-[11px] text-muted-foreground">
                              ({t("connections.scopeHint")})
                            </span>
                          </div>
                          <Field label="connections.attentionMode">
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
                              <option value="hard">{t("connections.onlyReplyToTheList")}</option>
                            </NativeSelect>
                          </Field>
                          <Field
                            label="connections.attentionList"
                            info="connections.softPriorityHint"
                          >
                            <Input
                              value={attentionValue.members}
                              disabled={saving || attentionValue.mode === "off"}
                              placeholder={t("connections.qqNumbersSeparatedByCommasOrSpaces")}
                              onChange={(e) =>
                                setAttention((old) => ({
                                  ...old,
                                  [binding.id]: { ...attentionValue, members: e.target.value },
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
                          <Button
                            disabled={!canSaveAttention}
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
                        </>
                      );
                    })()}
                </SchemeFieldCard>
              </div>
              <SchemeFieldCard
                title={t("connections.memoryOrganising")}
                description="schemes.bindings.memory.hint"
              >
                <BindingMemoryControls
                  binding={{ ...binding, enabled: state.qqSettings?.enabled === true }}
                  pending={binding.pending_observations}
                  disabled={saving}
                  onChanged={() => void state.loadQqBindingDirectory()}
                />
                <Button
                  variant="link"
                  onClick={() => {
                    onClose();
                    state.openSettingsRoute("long-memory");
                  }}
                >
                  {t("connections.goToLongTermMemory")}
                </Button>
              </SchemeFieldCard>
            </>
          )}
          {preview && (
            <Dialog
              open
              onOpenChange={(open) => {
                if (!open) setPreview(null);
              }}
            >
              <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>
                    {t("schemes.qq.groupConfig.scheme.confirmTitle", {
                      "0": preview.schemeName,
                    })}
                  </DialogTitle>
                  <DialogDescription>
                    {t("schemes.qq.groupConfig.scheme.confirmBody")}
                  </DialogDescription>
                </DialogHeader>
                <ul className="space-y-2 text-sm">
                  {preview.rows.map((row) => (
                    <li
                      key={row.key}
                      className="flex flex-wrap items-center justify-between gap-2 border-b pb-1.5 last:border-b-0"
                    >
                      <span className="text-muted-foreground">{t(row.label)}</span>
                      <span className="font-mono text-xs">
                        {row.current} → {row.next}
                      </span>
                    </li>
                  ))}
                </ul>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setPreview(null)}>
                    {t("connections.cancel")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={saving}
                    onClick={() => confirmSchemeChange("reset")}
                  >
                    {t("schemes.qq.groupConfig.scheme.resetLabel")}
                  </Button>
                  <Button disabled={saving} onClick={() => confirmSchemeChange("keep")}>
                    {t("schemes.qq.groupConfig.scheme.keepLabel")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
