import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { QqBindingResponse, QqConversationListItem } from "../../../shared/contracts/qq";
import { Field } from "../../components/form-field";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { parseAttentionMembers } from "../../features/qq/draft-state";
import { useQqInput } from "../../features/qq/use-qq-input";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { BindingMemoryControls } from "../library/BindingMemoryControls";

export const TRIGGER_LABELS = {
  direct_reply: "connections.directReplies",
  follow_up: "connections.ongoingConversation",
  chiming_in: "connections.chimingIn",
  idle_topic: "connections.openingAQuietRoom",
} as const;

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
}: {
  conversation: QqConversationListItem;
  binding: QqBindingResponse | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const state = useSuperstringStore();
  const [tab, setTab] = useState("participation");
  const [choices, setChoices] = useQqInput("choices");
  const [attention, setAttention] = useQqInput("attention");
  const key = binding?.id ?? `${conversation.kind}:${conversation.peer_id}`;
  const choice = choices[key] ?? {
    agentId: binding?.agent_id ?? state.agents[0]?.id ?? "",
    schemeId: binding?.scheme_id ?? state.qqSchemes[0]?.id ?? "",
    source: binding ?? undefined,
  };
  const saving = state.qqAccessSaving;
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
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
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
          <Assignment
            agentId={choice.agentId}
            schemeId={choice.schemeId}
            onChange={(patch) => setChoices((old) => ({ ...old, [key]: { ...choice, ...patch } }))}
          />
          {/* 直达不隐式保存改绑，未保存字段由导航守卫保护；目标是该方案的设置视图。 */}
          <div>
            <Button
              variant="outline"
              disabled={saving || state.qqSchemeSaving || !choice.schemeId}
              onClick={() => state.requestQqSchemeNavigation(choice.schemeId, "settings")}
            >
              {t("schemes.studio.editScheme")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={saving || !choice.agentId || !choice.schemeId}
              onClick={() => {
                const request = binding
                  ? state.updateQqBindingRow(choice.source ?? binding, {
                      agent_id: choice.agentId,
                      scheme_id: choice.schemeId,
                    })
                  : state.bindQqConversation({ conversation, ...choice });
                void request.then((ok) => {
                  if (ok)
                    setChoices((old) => {
                      const next = { ...old };
                      delete next[key];
                      return next;
                    });
                });
              }}
            >
              {t(binding ? "connections.saveBinding" : "connections.bind")}
            </Button>
            {binding && (
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => void state.updateQqBindingRow(binding, { paused: !binding.paused })}
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
          {binding && (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-auto [&_[role=tab]]:min-h-8 [&_[role=tab]]:max-w-full [&_[role=tab]]:flex-none [&_[role=tab]]:whitespace-normal">
                <TabsTrigger value="participation">{t("connections.participation")}</TabsTrigger>
                <TabsTrigger value="attention">{t("connections.importantPeople")}</TabsTrigger>
                <TabsTrigger value="memory">{t("connections.memoryOrganising")}</TabsTrigger>
              </TabsList>
              <TabsContent value="participation" className="space-y-5 pt-5">
                <p className="text-sm text-muted-foreground">
                  {t("connections.theseOverridesApplyOnlyToThisConversationDetailedParameters")}
                </p>
                {Object.entries(TRIGGER_LABELS).map(([key, label]) => {
                  const trigger = key as keyof typeof TRIGGER_LABELS;
                  const value = binding.triggers[trigger];
                  return (
                    <Field key={key} label={label}>
                      <NativeSelect
                        aria-label={t("connections.switchForValue", { "0": t(label) })}
                        disabled={saving}
                        value={value === null ? "inherit" : value ? "on" : "off"}
                        onChange={(e) =>
                          void state.updateQqBindingRow(binding, {
                            triggers: {
                              ...binding.triggers,
                              [key]: e.target.value === "inherit" ? null : e.target.value === "on",
                            },
                          })
                        }
                      >
                        <option value="inherit">{t("connections.followTheScheme")}</option>
                        <option value="on">{t("connections.on")}</option>
                        <option value="off">{t("connections.off")}</option>
                      </NativeSelect>
                    </Field>
                  );
                })}
              </TabsContent>
              <TabsContent value="attention" className="space-y-5 pt-5">
                {attentionValue && (
                  <>
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
                    <Field label="connections.attentionList" info="connections.softPriorityHint">
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
                    <Button
                      disabled={
                        saving ||
                        (attentionValue.mode !== "off" &&
                          !parseAttentionMembers(attentionValue.members).length)
                      }
                      onClick={() =>
                        void state
                          .updateQqBindingRow(attentionValue.source, {
                            attention:
                              attentionValue.mode === "off"
                                ? { mode: "off", members: [] }
                                : {
                                    mode: attentionValue.mode,
                                    members: parseAttentionMembers(attentionValue.members),
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
                )}
              </TabsContent>
              <TabsContent value="memory" className="space-y-5 pt-5">
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
              </TabsContent>
            </Tabs>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
