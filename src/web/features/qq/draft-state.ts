import type { QqBindingResponse, QqSettingsResponse } from "../../../shared/contracts/qq";
import { msg } from "../../i18n";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";
import { dirtyPages } from "../agents/page-drafts";
import { knowledgeModelDirty, knowledgeReadDirty, organizationDirty } from "../knowledge/types";
import { qqSchemeChanges, qqSchemeDirty, qqStickerEditorDirty, qqStickerEditorFrom } from "./types";

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
  choices: Record<string, { agentId: string; schemeId: string; source?: QqBindingResponse }>;
  attention: Record<
    string,
    { mode: QqBindingResponse["attention"]["mode"]; members: string; source: QqBindingResponse }
  >;
  manualKind: "group" | "private";
  manualPeer: string;
  manualAgentId: string;
  manualSchemeId: string;
  stickerNewCollection: string;
  stickerRenaming: { id: string; name: string; revision: number } | null;
  stickerBatchCollection: string;
  stickerBatchTag: string;
}
export const emptyQqInputs = (): QqInputs => ({
  schemeTexts: {},
  schemeInvalid: {},
  schemeNewName: "",
  schemeCopyName: "",
  connection: null,
  choices: {},
  attention: {},
  manualKind: "group",
  manualPeer: "",
  manualAgentId: "",
  manualSchemeId: "",
  stickerNewCollection: "",
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
  if (inputs.manualPeer.trim())
    rows.push({
      id: "manual-binding",
      resource: msg("手动绑定"),
      changes: [
        `${msg("手动绑定的类型")}: ${inputs.manualKind}`,
        `${msg("号码")}: ${inputs.manualPeer}`,
        `Agent: ${inputs.manualAgentId || state.agents[0]?.id || ""}`,
        `${msg("方案")}: ${inputs.manualSchemeId || state.qqSchemes[0]?.id || ""}`,
      ],
    });
  if (inputs.stickerNewCollection.trim())
    rows.push({
      id: "new-collection",
      resource: msg("新建集合"),
      changes: [inputs.stickerNewCollection],
    });
  if (inputs.stickerRenaming) {
    const original = state.qqStickerCollections.find(
      (item) => item.id === inputs.stickerRenaming?.id,
    );
    if (original && original.name !== inputs.stickerRenaming.name.trim())
      rows.push({
        id: `collection:${inputs.stickerRenaming.id}`,
        resource: msg("重命名集合"),
        changes: [`${original.name} → ${inputs.stickerRenaming.name}`],
      });
  }
  return rows;
}

export function settingsHaveDrafts(state: SuperstringState) {
  return (
    state.dirty ||
    state.memoryCorrectionDirty ||
    state.knowledgeDirty ||
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
      if (qqSchemeDirty(get().qqSchemeEditor) && !(await get().saveQqScheme())) return false;
      if (qqStickerEditorDirty(get().qqStickerEditor) && !(await get().saveQqStickerEditor()))
        return false;
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
      const inputs = get().qqInputs;
      if (inputs.manualPeer.trim()) {
        if (
          !(await get().bindQqPeerNumber({
            kind: inputs.manualKind,
            peerId: inputs.manualPeer.trim(),
            agentId: inputs.manualAgentId || get().agents[0]?.id || "",
            schemeId: inputs.manualSchemeId || get().qqSchemes[0]?.id || "",
          }))
        )
          return false;
        patchInputs({ manualPeer: "" });
      }
      if (get().qqInputs.stickerNewCollection.trim()) {
        if (!(await get().createQqStickerCollection(get().qqInputs.stickerNewCollection.trim())))
          return false;
        patchInputs({ stickerNewCollection: "" });
      }
      const rename = get().qqInputs.stickerRenaming;
      if (
        rename &&
        rename.name.trim() !==
          get().qqStickerCollections.find((item) => item.id === rename.id)?.name
      ) {
        if (
          !(await get().renameQqStickerCollection(rename.id, rename.name.trim(), rename.revision))
        )
          return false;
        patchInputs({ stickerRenaming: null });
      }
      return true;
    },
    discardQqDrafts: () => {
      get().discardQqSchemeChanges();
      set((state) => ({
        qqInputs: emptyQqInputs(),
        qqStickerEditor: state.qqStickerEditor
          ? qqStickerEditorFrom(state.qqStickerEditor.source)
          : null,
      }));
    },
  };
}
