import type {
  QqBindingResponse,
  QqConversationListItem,
  QqSettingsResponse,
  QqStickerCollectionResponse,
} from "../../../shared/contracts/qq";
import type { QqGroupCapability } from "../../../shared/contracts/qq-group-config";
import { msg, translate } from "../../i18n";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";
import { permissionSettingsDirty } from "../access/permission-state";
import { webAccessDraftDirty } from "../access/web-access-state";
import { dirtyPages } from "../agents/page-drafts";
import { knowledgeModelDirty, knowledgeReadDirty, organizationDirty } from "../knowledge/types";
import {
  type QqGroupConfigEditor,
  qqGroupConfigChanges,
  qqGroupConfigDirty,
  qqGroupConfigHasInvalidInputs,
} from "./group-config-state";
import {
  type QqStorageSettingsDraft,
  qqSchemeChanges,
  qqSchemeDirty,
  qqStickerEditorDirty,
  qqStickerEditorFrom,
  qqStorageDaysChanged,
} from "./types";

export interface QqInputs {
  schemeTexts: Record<string, string>;
  schemeInvalid: Record<string, string>;
  schemeNewName: string;
  schemeCopyName: string;
  connection: {
    source: QqSettingsResponse;
    endpoint: string;
    accountId: string;
    token: string;
  } | null;
  /** 保留设置草稿；数字以原文保存（空/非法原文也要能表示），空闲时 null。 */
  storage: QqStorageSettingsDraft | null;
  choices: Record<string, { agentId: string; schemeId: string; source?: QqBindingResponse }>;
  attention: Record<
    string,
    { mode: QqBindingResponse["attention"]["mode"]; members: string; source: QqBindingResponse }
  >;
  manualKind: "group" | "private";
  manualPeer: string;
  /** 观察行选中的会话键；与 manualPeer 是同一份「添加会话」草稿的两个来源。 */
  manualPicked: string;
  manualAgentId: string;
  manualSchemeId: string;
  stickerNewCollection: string;
  /** 新建集合的简介原文；与名称一起构成一份草稿。 */
  stickerNewCollectionDescription: string;
  /**
   * 重命名草稿。`description` 缺省＝本次不改动（绝不把「没改」变成清空）；null 或空白＝清除。
   */
  stickerRenaming: {
    id: string;
    name: string;
    revision: number;
    description?: string | null;
  } | null;
  stickerBatchCollection: string;
  stickerBatchTag: string;
}
export const emptyQqInputs = (): QqInputs => ({
  schemeTexts: {},
  schemeInvalid: {},
  schemeNewName: "",
  schemeCopyName: "",
  connection: null,
  storage: null,
  choices: {},
  attention: {},
  manualKind: "group",
  manualPeer: "",
  manualPicked: "",
  manualAgentId: "",
  manualSchemeId: "",
  stickerNewCollection: "",
  stickerNewCollectionDescription: "",
  stickerRenaming: null,
  stickerBatchCollection: "",
  stickerBatchTag: "",
});
export interface QqDraftState {
  qqInputs: QqInputs;
  saveQqDrafts: () => Promise<boolean>;
  discardQqDrafts: () => void;
}

export const parseAttentionMembers = (text: string) =>
  text
    .split(/[\s,，、;；]+/)
    .map((part) => part.trim())
    .filter(Boolean);

/** 观察目录行与草稿里的选中值共用一种会话键。 */
export const qqConversationKey = (
  row: Pick<QqConversationListItem, "account_id" | "kind" | "peer_id">,
) => `${row.account_id}:${row.kind}:${row.peer_id}`;

/**
 * 「添加会话」草稿的目标：观察行优先、其次手工号码；两者都没有就是没有草稿。
 * 只做解析，不提供任何默认 Agent/方案——缺什么就报什么，让保存原地失败。
 */
export function manualBindingTarget(state: SuperstringState): {
  kind: "group" | "private";
  peer: string;
  agentId: string;
  schemeId: string;
  conversation: QqConversationListItem | null;
} | null {
  const { manualPicked, manualKind, manualPeer, manualAgentId, manualSchemeId } = state.qqInputs;
  const conversation = manualPicked
    ? (state.qqConversations.find((row) => qqConversationKey(row) === manualPicked) ?? null)
    : null;
  const picked = manualPicked ? manualPicked.split(":") : null;
  const peer = conversation?.peer_id ?? (picked ? (picked[2] ?? "") : manualPeer.trim());
  if (!peer) return null;
  return {
    kind:
      conversation?.kind ?? (picked ? (picked[1] === "private" ? "private" : "group") : manualKind),
    peer,
    agentId: manualAgentId,
    schemeId: manualSchemeId,
    conversation,
  };
}
const connectionDirty = (draft: QqInputs["connection"]) =>
  !!draft &&
  (draft.endpoint.trim() !== (draft.source.transport.endpoint ?? "") ||
    draft.accountId.trim() !== (draft.source.account_id ?? "") ||
    draft.token !== "");
const choiceDirty = (draft: QqInputs["choices"][string]) =>
  !!draft.source &&
  (draft.agentId !== draft.source.agent_id || draft.schemeId !== draft.source.scheme_id);
const attentionDirty = (draft: QqInputs["attention"][string]) =>
  draft.mode !== draft.source.attention.mode ||
  (draft.mode !== "off" &&
    parseAttentionMembers(draft.members).sort().join(" ") !==
      [...draft.source.attention.members].sort().join(" "));
const storageDirty = (draft: QqInputs["storage"]) =>
  !!draft && qqStorageDaysChanged(draft.days, draft.source.retention_days);

/**
 * 重命名草稿相对集合行的改动行；`description` 为 undefined＝本次不改，绝不把「没改」变成清空。
 * 名称取 trim 后比较（单个空白名称会在保存前被显式拒绝）。
 */
export function qqStickerRenamingChanges(
  rename: QqInputs["stickerRenaming"],
  original: QqStickerCollectionResponse | undefined,
): string[] {
  if (!rename || !original) return [];
  const changes: string[] = [];
  if (rename.name.trim() !== original.name) changes.push(`${original.name} → ${rename.name}`);
  if (rename.description !== undefined) {
    const before = original.description ?? "";
    const after = (rename.description ?? "").trim();
    if (before !== after) changes.push(msg("简介: {0} → {1}", before, after));
  }
  return changes;
}

export function invalidSchemeInputs(state: SuperstringState) {
  const editor = state.qqSchemeEditor;
  return Object.entries(state.qqInputs.schemeTexts).filter(([field, raw]) => {
    const [group, key] = field.split(".");
    const value =
      editor?.[group as "rhythm" | "context" | "compression" | "outputReserve" | "stickers"];
    if (key === "active_hours_start_minutes" || key === "active_hours_end_minutes") return false;
    // 装配冗余在界面上是整数百分比，存的是比例：比之前先换算，越界自然会对不上而被判无效。
    const typed = key === "headroom_ratio" ? Number(raw) / 100 : Number(raw);
    return !raw.trim() || !value || typed !== (value as Record<string, unknown>)[key];
  });
}

/** 字段文案键：与 group-config 页 FIELD_LABELS 同批；缺项退回契约字段名，与页面 labelOf 一致。 */
const GROUP_FIELD_LABEL_KEYS: Record<string, string> = {
  "triggers.direct_reply": "connections.directReplies",
  "triggers.follow_up": "connections.ongoingConversation",
  "triggers.chiming_in": "connections.chimingIn",
  "triggers.idle_topic": "connections.openingAQuietRoom",
  "rhythm.initiative_min_score": "connections.unpromptedSpeechThreshold010",
  "rhythm.merge_window_seconds": "connections.mergeWindowSeconds",
  "rhythm.reply_cooldown_seconds": "connections.speechCooldownSeconds",
  "rhythm.hourly_speech_limit": "connections.hourlyCap",
  "rhythm.idle_quiet_minutes": "connections.quietRoomThresholdMinutes",
  "rhythm.max_recompute_count": "connections.maximumRecomputes",
  "rhythm.max_sticker_count": "connections.stickersPerReply",
  "rhythm.media_supplement_window_minutes":
    "connections.waitAfterMediaFailsOnADirectMentionMinutes",
  "rhythm.media_frame_count": "connections.animationFramesToSample",
  "rhythm.media_max_dimension": "connections.sampledFrameLongEdgePx",
  "rhythm.active_hours_enabled": "connections.allowedHours",
  "rhythm.active_hours_start_minutes": "connections.allowedHoursStart",
  "rhythm.active_hours_end_minutes": "connections.allowedHoursEnd",
  "stickers.sticker_min_repeat_minutes": "connections.shortestRepeatIntervalPerStickerMinutes",
  "stickers.sticker_recent_avoid_count": "connections.avoidTheLastFew",
  "context.judgement_message_limit": "connections.judgementRecentMessages",
  "context.judgement_window_minutes": "connections.judgementTimeWindowMinutes",
  "context.judgement_token_budget": "connections.judgementBudgetEstimatedBytes",
  "context.reply_window_minutes": "connections.replyTimeWindowMinutes",
  "context.reply_token_budget": "connections.replyBudgetEstimatedBytes",
  "compression.watermark_trigger": "connections.watermarkTriggerMessages",
  "compression.package_limit": "connections.watermarkPackageLimit",
  "compression.headroom_ratio": "connections.assemblyHeadroomPercent",
  "output_reserve.judgement_output_reserved": "connections.judgementOutputReserveEstimatedBytes",
  "output_reserve.reply_output_reserved": "connections.replyOutputReserveEstimatedBytes",
  "sticker_collections.collection_ids": "connections.authorizedCollections",
  "prompts.scene": "connections.sceneAndBehaviour",
  "prompts.judge": "connections.judgementTask",
  "prompts.reply": "connections.effectiveReplyTask",
  "prompts.review": "connections.reviewTask",
  "prompts.sticker": "connections.stickerTask",
  "prompts.media": "connections.mediaNoteTask",
  "prompts.compress": "connections.watermarkCompressionTask",
  "reply.split_by_speaker": "connections.answerEachSpeakerSeparately",
};

/** 能力文案键：与 group-config 页 CAPABILITY_LABELS 同批。 */
const GROUP_CAPABILITY_LABEL_KEYS: Record<QqGroupCapability, string> = {
  memory_read: "schemes.qq.groupConfig.capability.memoryRead",
  memory_organize: "schemes.qq.groupConfig.capability.memoryOrganize",
  knowledge_read: "schemes.qq.groupConfig.capability.knowledgeRead",
  web: "schemes.qq.groupConfig.capability.web",
  media: "schemes.qq.groupConfig.capability.media",
  stickers: "schemes.qq.groupConfig.capability.stickers",
  tasks: "schemes.qq.groupConfig.capability.tasks",
  research: "schemes.qq.groupConfig.capability.research",
  code: "schemes.qq.groupConfig.capability.code",
  mcp: "schemes.qq.groupConfig.capability.mcp",
  skills: "schemes.qq.groupConfig.capability.skills",
  history_summary: "schemes.qq.groupConfig.capability.historySummary",
};

const groupFieldLabel = (group: string, field: string): string =>
  translate(GROUP_FIELD_LABEL_KEYS[`${group}.${field}`] ?? `${group}.${field}`);

/** 布尔字段沿用页面「开/关」文案；其余原样（数字/百分比/文本/集合）。 */
const groupValueText = (
  editor: QqGroupConfigEditor,
  group: string,
  field: string,
  raw: string,
): string => {
  const baseGroup = (
    editor.source.base_scheme as unknown as Record<string, Record<string, unknown> | undefined>
  )[group];
  return typeof baseGroup?.[field] === "boolean"
    ? translate(raw === "true" ? "connections.on" : "connections.off")
    : raw;
};

export function qqDraftChanges(
  state: SuperstringState,
): { id: string; resource: string; changes: string[] }[] {
  const inputs = state.qqInputs;
  const rows: { id: string; resource: string; changes: string[] }[] = [];
  if (
    qqSchemeDirty(state.qqSchemeEditor) ||
    Object.keys(inputs.schemeInvalid).length ||
    invalidSchemeInputs(state).length
  )
    rows.push({
      id: `scheme:${state.qqSchemeEditor?.source.id}`,
      resource: state.qqSchemeEditor?.name || msg("聊天方案"),
      changes: [
        ...qqSchemeChanges(state.qqSchemeEditor).map(
          (change) => `${change.field}: ${change.before} → ${change.after}`,
        ),
        ...invalidSchemeInputs(state).map(([field, raw]) => `${field}: ${raw}`),
        ...Object.entries(inputs.schemeInvalid).map(([field, error]) => `${field}: ${error}`),
      ],
    });
  const groupEditor = state.qqGroupConfigEditor;
  if (groupEditor && qqGroupConfigDirty(groupEditor))
    rows.push({
      id: `group-config:${groupEditor.source.binding.id}`,
      resource: `${msg("群")} · ${groupEditor.source.binding.peer_id}`,
      changes: qqGroupConfigChanges(
        groupEditor,
        (id) => state.qqSchemes.find((row) => row.id === id)?.name,
      ).map((change) => {
        if (change.kind === "override") {
          const label = groupFieldLabel(change.group, change.field);
          if (change.before === change.after) {
            // 与基线同值的钉住/取消：说「跟随↔自定义」，不渲染 X → X 这种读不出方向的等值行。
            const pinned =
              (
                groupEditor.overrides as unknown as Record<
                  string,
                  Record<string, unknown> | undefined
                >
              )[change.group]?.[change.field] !== undefined;
            return translate(
              "schemes.qq.groupConfig.change.override",
              label,
              translate(
                pinned
                  ? "schemes.qq.groupConfig.followBadge"
                  : "schemes.qq.groupConfig.customBadge",
              ),
              translate(
                pinned
                  ? "schemes.qq.groupConfig.customBadge"
                  : "schemes.qq.groupConfig.followBadge",
              ),
            );
          }
          return translate(
            "schemes.qq.groupConfig.change.override",
            label,
            groupValueText(groupEditor, change.group, change.field, change.before),
            groupValueText(groupEditor, change.group, change.field, change.after),
          );
        }
        if (change.kind === "raw")
          return translate(
            "schemes.qq.groupConfig.change.raw",
            groupFieldLabel(change.group, change.field),
            change.raw,
          );
        if (change.kind === "capability")
          return translate(
            change.disabled
              ? "schemes.qq.groupConfig.change.capabilityOff"
              : "schemes.qq.groupConfig.change.capabilityOn",
            translate(GROUP_CAPABILITY_LABEL_KEYS[change.capability]),
          );
        // scheme 是 union 的最后一种：显式收束成返回，不设兜底分支。
        return translate(
          "schemes.qq.groupConfig.change.scheme",
          change.schemeName,
          translate(
            change.reset
              ? "schemes.qq.groupConfig.scheme.resetLabel"
              : "schemes.qq.groupConfig.scheme.keepLabel",
          ),
        );
      }),
    });
  if (state.qqStickerEditor && qqStickerEditorDirty(state.qqStickerEditor)) {
    const editor = state.qqStickerEditor;
    const source = qqStickerEditorFrom(editor.source);
    const changes = (Object.keys(source) as (keyof typeof source)[])
      .filter(
        (key) => key !== "source" && JSON.stringify(source[key]) !== JSON.stringify(editor[key]),
      )
      .map((key) => `${key}: ${String(source[key])} → ${String(editor[key])}`);
    rows.push({
      id: `sticker:${editor.source.id}`,
      resource: `${msg("表情素材")} · ${editor.name}`,
      changes,
    });
  }
  if (inputs.connection && connectionDirty(inputs.connection)) {
    const draft = inputs.connection;
    rows.push({
      id: "connection",
      resource: msg("连接"),
      changes: [
        ...(draft.accountId.trim() !== (draft.source.account_id ?? "")
          ? [`${msg("助手账号")}: ${draft.source.account_id ?? ""} → ${draft.accountId}`]
          : []),
        ...(draft.endpoint.trim() !== (draft.source.transport.endpoint ?? "")
          ? [
              `${msg("WebSocket 地址")}: ${draft.source.transport.endpoint ?? ""} → ${draft.endpoint}`,
            ]
          : []),
        ...(draft.token ? [msg("访问令牌将被替换（不显示内容）")] : []),
      ],
    });
  }
  if (storageDirty(inputs.storage) && inputs.storage)
    rows.push({
      id: "storage",
      resource: msg("数据与保留"),
      changes: [
        msg("保留天数: {0} → {1}", inputs.storage.source.retention_days, inputs.storage.days),
      ],
    });
  for (const [id, draft] of Object.entries(inputs.choices))
    if (draft.source && choiceDirty(draft))
      rows.push({
        id: `binding:${id}`,
        resource: `${msg("保存改绑")} · ${draft.source.peer_id}`,
        changes: [
          `Agent: ${draft.source.agent_id} → ${draft.agentId}`,
          `${msg("方案")}: ${draft.source.scheme_id} → ${draft.schemeId}`,
          id,
        ],
      });
  for (const draft of Object.values(inputs.attention))
    if (attentionDirty(draft))
      rows.push({
        id: `attention:${draft.source.id}`,
        resource: `${msg("重要的人")} · ${draft.source.peer_id}`,
        changes: [
          `${draft.source.attention.mode} → ${draft.mode}`,
          `${draft.source.attention.members.join(" ")} → ${draft.members}`,
        ],
      });
  const manual = manualBindingTarget(state);
  if (manual)
    rows.push({
      id: "manual-binding",
      resource: `${msg("手动绑定")} · ${manual.peer}`,
      changes: [
        `${msg("手动绑定的类型")}: ${manual.kind}`,
        `${msg("号码")}: ${manual.peer}`,
        `Agent: ${manual.agentId}`,
        `${msg("方案")}: ${manual.schemeId}`,
      ],
    });
  const newCollectionName = inputs.stickerNewCollection.trim();
  const newCollectionDescription = inputs.stickerNewCollectionDescription.trim();
  if (newCollectionName || newCollectionDescription)
    rows.push({
      id: "new-collection",
      resource: msg("新建集合"),
      changes: [
        ...(newCollectionName ? [newCollectionName] : []),
        ...(newCollectionDescription
          ? [msg("简介: {0} → {1}", "—", newCollectionDescription)]
          : []),
      ],
    });
  const rename = inputs.stickerRenaming;
  if (rename) {
    const original = state.qqStickerCollections.find((item) => item.id === rename.id);
    const changes = qqStickerRenamingChanges(rename, original);
    if (changes.length)
      rows.push({
        id: `collection:${rename.id}`,
        resource: msg("重命名集合"),
        changes,
      });
  }
  return rows;
}

export function settingsHaveDrafts(state: SuperstringState) {
  return (
    state.dirty ||
    state.memoryCorrectionDirty ||
    state.knowledgeDirty ||
    permissionSettingsDirty(state.permissionEditor) ||
    webAccessDraftDirty(state.webAccessSnapshot, state.webAccessDraft) ||
    dirtyPages(state.pageEditor).length > 0 ||
    organizationDirty(state.organizationEditor) ||
    knowledgeModelDirty(state.knowledgeModelEditor) ||
    knowledgeReadDirty(state.knowledgeReadEditor) ||
    Object.keys(state.qqMemoryBatchDrafts).length > 0 ||
    qqDraftChanges(state).length > 0
  );
}

export function createQqDraftActions(
  set: StoreSet,
  get: StoreGet,
): Pick<QqDraftState, "saveQqDrafts" | "discardQqDrafts"> {
  const patchInputs = (patch: Partial<QqInputs>) =>
    set((state) => ({ qqInputs: { ...state.qqInputs, ...patch } }));
  return {
    saveQqDrafts: async () => {
      if (Object.keys(get().qqInputs.schemeInvalid).length || invalidSchemeInputs(get()).length) {
        set({ error: msg("请先修正方案中的无效数字，再保存。") });
        return false;
      }
      // 本群配置的非法数字与方案同一条前置：修正前统一保存不写任何一步。
      if (qqGroupConfigHasInvalidInputs(get().qqGroupConfigEditor)) {
        set({ error: msg("请先修正方案中的无效数字，再保存。") });
        return false;
      }
      const schemeWasDirty = qqSchemeDirty(get().qqSchemeEditor);
      if (schemeWasDirty && !(await get().saveQqScheme())) return false;
      if (schemeWasDirty) {
        // 同一次保存里刚写过的方案：本群配置的基线若正是它，把已知写结果推进给它
        // （已自定义字段保留、未改字段跟随新值），否则本群保存会拿旧 revision 自撞 409。
        const savedScheme = get().qqSchemeEditor?.source;
        if (savedScheme)
          set((state) => {
            const editor = state.qqGroupConfigEditor;
            return editor && editor.source.base_scheme.id === savedScheme.id
              ? {
                  qqGroupConfigEditor: {
                    ...editor,
                    source: { ...editor.source, base_scheme: savedScheme },
                  },
                }
              : {};
          });
      }
      if (qqStickerEditorDirty(get().qqStickerEditor) && !(await get().saveQqStickerEditor()))
        return false;
      // 保留设置是独立 PUT：只发 storage 字段，不携带方案/连接等其他草稿。
      if (storageDirty(get().qqInputs.storage)) {
        if (!(await get().saveQqStorageSettings())) return false;
        patchInputs({ storage: null });
      }
      const connection = get().qqInputs.connection;
      if (connectionDirty(connection) && connection) {
        if (
          !(await get().saveQqSurface(
            {
              account_id: connection.accountId.trim() || null,
              endpoint: connection.endpoint.trim() || null,
              ...(connection.token ? { token: connection.token } : {}),
            },
            connection.source.revision,
          ))
        )
          return false;
        patchInputs({ connection: null });
      }
      for (const [id, draft] of Object.entries(get().qqInputs.choices)) {
        if (!choiceDirty(draft) || !draft.source) continue;
        if (
          !(await get().updateQqBindingRow(draft.source, {
            agent_id: draft.agentId,
            scheme_id: draft.schemeId,
          }))
        )
          return false;
        const { [id]: _saved, ...choices } = get().qqInputs.choices;
        const binding = get().qqBindings.find((item) => item.id === id);
        const attention = get().qqInputs.attention;
        patchInputs({
          choices,
          attention:
            binding && attention[id]
              ? { ...attention, [id]: { ...attention[id], source: binding } }
              : attention,
        });
      }
      for (const [id, draft] of Object.entries(get().qqInputs.attention)) {
        if (!attentionDirty(draft)) continue;
        const members = draft.mode === "off" ? [] : parseAttentionMembers(draft.members);
        if (draft.mode !== "off" && !members.length) {
          set({ error: msg("请填写重要人物名单，或关闭此模式。") });
          return false;
        }
        // A prior successful edit in this same save may have advanced the binding revision.
        const binding = draft.source;
        if (
          !(await get().updateQqBindingRow(binding, { attention: { mode: draft.mode, members } }))
        )
          return false;
        const { [id]: _saved, ...attention } = get().qqInputs.attention;
        patchInputs({ attention });
      }
      const manual = manualBindingTarget(get());
      if (manual) {
        if (get().qqInputs.manualPicked && !manual.conversation) {
          set({ error: msg("操作失败，请重试。") });
          return false;
        }
        if (!manual.agentId) {
          set({ error: msg("请至少选择一个 Agent。") });
          return false;
        }
        if (!manual.schemeId) {
          set({ error: msg("还没有方案：先到聊天方案页建一个，才能绑定会话。") });
          return false;
        }
        const ok = manual.conversation
          ? await get().bindQqConversation({
              conversation: manual.conversation,
              agentId: manual.agentId,
              schemeId: manual.schemeId,
            })
          : await get().bindQqPeerNumber({
              kind: manual.kind,
              peerId: manual.peer,
              agentId: manual.agentId,
              schemeId: manual.schemeId,
            });
        if (!ok) return false;
        // 只有写成功才清掉目标草稿；失败保留，用户可原地修正或重试。
        patchInputs({ manualPeer: "", manualPicked: "", manualAgentId: "" });
      }
      const newCollectionName = get().qqInputs.stickerNewCollection.trim();
      const newCollectionDescription = get().qqInputs.stickerNewCollectionDescription.trim();
      if (newCollectionName || newCollectionDescription) {
        if (!newCollectionName) {
          set({ error: "请填写集合名称，再保存。" });
          return false;
        }
        if (!(await get().createQqStickerCollection(newCollectionName, newCollectionDescription)))
          return false;
        patchInputs({ stickerNewCollection: "", stickerNewCollectionDescription: "" });
      }
      const rename = get().qqInputs.stickerRenaming;
      if (rename) {
        const original = get().qqStickerCollections.find((item) => item.id === rename.id);
        if (original && qqStickerRenamingChanges(rename, original).length) {
          const name = rename.name.trim();
          if (!name) {
            set({ error: "请填写集合名称，再保存。" });
            return false;
          }
          // undefined＝本次不改动；null 或空白＝清除（服务端对空白同样按 null 规范化）。
          if (
            !(await get().renameQqStickerCollection(
              rename.id,
              name,
              rename.revision,
              rename.description === undefined ? undefined : (rename.description ?? ""),
            ))
          )
            return false;
          patchInputs({ stickerRenaming: null });
        }
      }
      // 本群配置是独立 PUT：只发这间群的稀疏改写与能力停用，不携带方案/模型/其他草稿；
      // 409 时整份草稿原样保留，显式刷新后再试。
      if (qqGroupConfigDirty(get().qqGroupConfigEditor) && !(await get().saveQqGroupConfig()))
        return false;
      return true;
    },
    discardQqDrafts: () => {
      get().discardQqSchemeChanges();
      get().discardQqGroupConfigChanges();
      set((state) => ({
        qqInputs: emptyQqInputs(),
        qqStickerEditor: state.qqStickerEditor
          ? qqStickerEditorFrom(state.qqStickerEditor.source)
          : null,
      }));
    },
  };
}
