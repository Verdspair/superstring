// Sticker library actions (ADR0018 §9.2, P5d).
//
// Everything here goes through the API client, and every write reloads or patches the two lists
// from the server's answer rather than from the form: §9.2's fields are shared with the reply
// path, so the surface must show what is stored, not what was typed. A failed call leaves the
// editor as it was and reports the error, the same discipline the rest of the settings surfaces
// follow.

import type { QqSchemeResponse, QqStickerAssetResponse } from "../../../shared/contracts/qq";
import type { StoreGet, StoreSet } from "../../state/types";
import { invalidSchemeInputs } from "./draft-state";
import {
  type QqAccessState,
  type QqSchemeEditor,
  type QqSchemeState,
  type QqStickerState,
  type QqStorageState,
  qqSchemeDirty,
  qqSchemeEditorFrom,
  qqStickerEditorFrom,
  qqStickerEditorTags,
} from "./types";

export function createQqStickerActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  QqStickerState,
  | "loadQqStickers"
  | "openQqStickerEditor"
  | "closeQqStickerEditor"
  | "patchQqStickerEditor"
  | "saveQqStickerEditor"
  | "setQqStickerEnabled"
  | "importQqStickerFile"
  | "annotateQqSticker"
  | "setQqStickerSelection"
  | "loadQqStickerBatchImpact"
  | "bulkUpdateQqStickers"
  | "createQqStickerCollection"
  | "renameQqStickerCollection"
  | "clearQqStickerImportNotice"
> {
  const replaceAsset = (asset: QqStickerAssetResponse) => {
    set((state) => ({
      qqStickerAssets: state.qqStickerAssets.map((row) => (row.id === asset.id ? asset : row)),
      qqStickerEditor:
        state.qqStickerEditor?.source.id === asset.id
          ? { ...state.qqStickerEditor, source: asset }
          : state.qqStickerEditor,
    }));
  };
  const loadImpact = async (id: string) => {
    try {
      const impact = await get().apiClient.getQqStickerImpact(id);
      if (get().qqStickerEditor?.source.id === id) set({ qqStickerImpact: impact });
    } catch {
      // The impact panel is informational; a failure to read it must not look like a failed save.
    }
  };
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    set({ error: message, feedback: "" });
  };
  return {
    loadQqStickers: async () => {
      if (get().qqStickerLoading) return;
      const id = get().qqStickerReadId + 1;
      set({ qqStickerReadId: id, qqStickerLoading: true, error: null });
      try {
        const [collections, assets] = await Promise.all([
          get().apiClient.listQqStickerCollections(),
          get().apiClient.listQqStickerAssets(),
        ]);
        if (get().qqStickerReadId !== id) return;
        set((state) => ({
          qqStickerCollections: collections,
          qqStickerAssets: assets,
          // A fresh read prunes the selection to what actually came back.
          qqStickerSelection: state.qqStickerSelection.filter((id) =>
            assets.some((asset) => asset.id === id),
          ),
          qqStickerBatchImpact: null,
        }));
      } catch (error) {
        if (get().qqStickerReadId !== id) return;
        report(error);
      } finally {
        if (get().qqStickerReadId === id) set({ qqStickerLoading: false });
      }
    },
    openQqStickerEditor: (id) => {
      const asset = get().qqStickerAssets.find((row) => row.id === id);
      if (!asset) return;
      set({
        qqStickerEditor: { ...qqStickerEditorFrom(asset) },
        qqStickerImpact: null,
        qqStickerImportNotice: null,
      });
      void loadImpact(id);
    },
    closeQqStickerEditor: () => set({ qqStickerEditor: null, qqStickerImpact: null }),
    patchQqStickerEditor: (patch) =>
      set((state) =>
        state.qqStickerEditor ? { qqStickerEditor: { ...state.qqStickerEditor, ...patch } } : {},
      ),
    saveQqStickerEditor: async (options) => {
      const editor = get().qqStickerEditor;
      if (!editor || get().qqStickerSaving) return false;
      set({ qqStickerSaving: true, error: null, feedback: "" });
      try {
        const api = get().apiClient;
        // Content first, then the membership set: both answers describe the same row, and the last
        // one read back is what the surface shows (the PUT answers with the saved content too).
        await api.updateQqStickerAsset(editor.source.id, {
          name: editor.name.trim(),
          description: editor.description.trim() === "" ? null : editor.description.trim(),
          tags: qqStickerEditorTags(editor.tags),
          usage_note: editor.usageNote.trim() === "" ? null : editor.usageNote.trim(),
        });
        const collected = await api.setQqStickerCollections(editor.source.id, {
          collection_ids: editor.collectionIds,
        });
        const final = options?.enableAfterSave
          ? await api.setQqStickerEnabled(editor.source.id, true)
          : collected;
        replaceAsset(final);
        set({
          qqStickerEditor: { ...qqStickerEditorFrom(final) },
          feedback: options?.enableAfterSave ? "已保存并启用" : "已保存素材整理",
        });
        await loadImpact(final.id);
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        set({ qqStickerSaving: false });
      }
    },
    setQqStickerEnabled: async (id, enabled) => {
      if (get().qqStickerSaving) return false;
      set({ qqStickerSaving: true, error: null });
      try {
        const asset = await get().apiClient.setQqStickerEnabled(id, enabled);
        replaceAsset(asset);
        set({ feedback: enabled ? "已启用素材" : "已停用素材" });
        if (enabled) await loadImpact(id);
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        set({ qqStickerSaving: false });
      }
    },
    importQqStickerFile: async (file) => {
      if (get().qqStickerSaving) return false;
      set({ qqStickerSaving: true, error: null, qqStickerImportNotice: null });
      try {
        // The picked file's own name is the default (§9.2); the surface only sends the bytes.
        const result = await get().apiClient.importQqStickerFile(file);
        if (result.kind === "rejected") {
          set({ qqStickerImportNotice: { kind: "rejected", reason: result.reason } });
          return false;
        }
        set((state) => ({
          qqStickerAssets: [...state.qqStickerAssets, result.asset],
          qqStickerImportNotice: { kind: "imported", name: result.asset.name },
          // A freshly imported asset is disabled (§9.1), so the surface opens it for the review
          // the user has to do next rather than pretending it became selectable.
          qqStickerEditor: { ...qqStickerEditorFrom(result.asset) },
          qqStickerImpact: null,
        }));
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        set({ qqStickerSaving: false });
      }
    },
    annotateQqSticker: async (assetId) => {
      if (get().qqStickerSaving) return { kind: "rejected", reason: "busy" };
      set({ qqStickerSaving: true, error: null, feedback: "" });
      try {
        const result = await get().apiClient.annotateQqSticker(assetId);
        if (result.kind === "rejected") return { kind: "rejected", reason: result.reason };
        replaceAsset(result.asset);
        set({ feedback: "已生成说明与标签草稿，审核后再保存" });
        return { kind: "annotated" };
      } catch (error) {
        report(error);
        return { kind: "rejected", reason: "model_error" };
      } finally {
        set({ qqStickerSaving: false });
      }
    },
    setQqStickerSelection: (ids) => set({ qqStickerSelection: [...new Set(ids)] }),
    loadQqStickerBatchImpact: async () => {
      const ids = get().qqStickerSelection;
      if (ids.length === 0) {
        set({ qqStickerBatchImpact: null });
        return;
      }
      try {
        const impacts = await Promise.all(ids.map((id) => get().apiClient.getQqStickerImpact(id)));
        set({
          qqStickerBatchImpact: [
            ...new Set(impacts.flatMap((row) => row.schemes.map((scheme) => scheme.name))),
          ],
        });
      } catch {
        // The union is informational; failing to read it must not look like a failed batch.
        set({ qqStickerBatchImpact: null });
      }
    },
    bulkUpdateQqStickers: async (input) => {
      const ids = get().qqStickerSelection;
      if (ids.length === 0 || get().qqStickerSaving) return false;
      set({ qqStickerSaving: true, error: null, feedback: "" });
      try {
        // Validate-then-execute is the server's rule; this side only reports what came back.
        const { assets } = await get().apiClient.bulkUpdateQqStickers({
          asset_ids: ids,
          ...(input.addCollectionIds === undefined
            ? {}
            : { add_collection_ids: [...input.addCollectionIds] }),
          ...(input.removeCollectionIds === undefined
            ? {}
            : { remove_collection_ids: [...input.removeCollectionIds] }),
          ...(input.tags === undefined
            ? {}
            : {
                tags: {
                  add: [...(input.tags.add ?? [])],
                  remove: [...(input.tags.remove ?? [])],
                },
              }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        });
        for (const asset of assets) replaceAsset(asset);
        // The selection is kept: nothing deletes assets (U11), so the same selection can take
        // the next batch operation, and a re-read is not needed to use it again.
        set({
          qqStickerBatchImpact: null,
          feedback: `已更新${assets.length}个素材`,
        });
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        set({ qqStickerSaving: false });
      }
    },
    createQqStickerCollection: async (name) => {
      if (get().qqStickerSaving) return false;
      set({ qqStickerSaving: true, error: null });
      try {
        const collection = await get().apiClient.createQqStickerCollection({ name });
        set((state) => ({
          qqStickerCollections: [...state.qqStickerCollections, collection],
          feedback: "已新建集合",
        }));
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        set({ qqStickerSaving: false });
      }
    },
    renameQqStickerCollection: async (id, name, expectedRevision) => {
      if (get().qqStickerSaving) return false;
      set({ qqStickerSaving: true, error: null });
      try {
        const collection = await get().apiClient.updateQqStickerCollection(id, {
          name,
          expected_revision: expectedRevision,
        });
        set((state) => ({
          qqStickerCollections: state.qqStickerCollections.map((row) =>
            row.id === id ? collection : row,
          ),
          feedback: "已保存集合名称",
        }));
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        set({ qqStickerSaving: false });
      }
    },
    clearQqStickerImportNotice: () => set({ qqStickerImportNotice: null }),
  };
}

/**
 * Scheme actions (§5.2/§11.2, P5f).
 *
 * The save path is compare-and-swap on the loaded revision, and every write replaces the editor's
 * `source` with what the server stored: a scheme's parameters are read by running conversations,
 * so an editor that kept showing the draft after a save would be describing something that is not
 * in effect. `另存为新方案` sends the draft's groups under a new name, which is §11.2's flow (edit
 * the groups, then save as a new scheme rather than overwriting the old one).
 */
export function createQqSchemeActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  QqSchemeState,
  | "loadQqSchemes"
  | "createQqScheme"
  | "selectQqScheme"
  | "patchQqScheme"
  | "patchQqSchemeGroup"
  | "saveQqScheme"
  | "duplicateQqScheme"
  | "deleteQqScheme"
  | "discardQqSchemeChanges"
> {
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    set({ error: message, feedback: "" });
  };
  const loadUsage = async (id: string) => {
    try {
      const usage = await get().apiClient.getQqSchemeUsage(id);
      if (get().qqSchemeEditor?.source.id === id) {
        set({ qqSchemeUsage: { schemeId: id, bindings: usage.bindings } });
      }
    } catch {
      // The count is informational; failing to read it must not look like a failed save.
    }
  };
  const openEditor = (scheme: QqSchemeResponse) => {
    set({
      qqSchemeEditor: qqSchemeEditorFrom(scheme),
      qqInputs: { ...get().qqInputs, schemeTexts: {}, schemeInvalid: {} },
      qqSchemeUsage: null,
      error: null,
      feedback: "",
    });
    void loadUsage(scheme.id);
  };
  const replaceScheme = (scheme: QqSchemeResponse) =>
    set((state) => ({
      qqSchemes: state.qqSchemes.map((row) => (row.id === scheme.id ? scheme : row)),
    }));
  return {
    loadQqSchemes: async () => {
      if (get().qqSchemesLoading) return;
      const id = get().qqSchemesReadId + 1;
      set({ qqSchemesReadId: id, qqSchemesLoading: true, error: null });
      try {
        const schemes = await get().apiClient.listQqSchemes();
        if (get().qqSchemesReadId !== id) return;
        set({ qqSchemes: schemes });
        const current = get().qqSchemeEditor?.source.id;
        const next = schemes.find((row) => row.id === current) ?? schemes[0];
        if (
          next &&
          !qqSchemeDirty(get().qqSchemeEditor) &&
          !Object.keys(get().qqInputs.schemeTexts).length
        )
          openEditor(next);
        else if (next) void loadUsage(next.id);
        else set({ qqSchemeEditor: null, qqSchemeUsage: null });
      } catch (error) {
        if (get().qqSchemesReadId !== id) return;
        report(error);
      } finally {
        if (get().qqSchemesReadId === id) set({ qqSchemesLoading: false });
      }
    },
    createQqScheme: async (name) => {
      if (get().qqSchemeSaving) return false;
      set({ qqSchemeSaving: true, error: null, feedback: "" });
      try {
        // A new scheme starts with the project's defaults: every trigger off (§11.1) and the
        // defaults the plan fixed. The repository owns them; this only supplies the name.
        const scheme = await get().apiClient.createQqScheme({ name, description: null });
        set((state) => ({ qqSchemes: [...state.qqSchemes, scheme] }));
        openEditor(scheme);
        set({ feedback: "已新建方案" });
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        set({ qqSchemeSaving: false });
      }
    },
    selectQqScheme: (id) => {
      const scheme = get().qqSchemes.find((row) => row.id === id);
      if (scheme) openEditor(scheme);
    },
    patchQqScheme: (patch) =>
      set((state) =>
        state.qqSchemeEditor ? { qqSchemeEditor: { ...state.qqSchemeEditor, ...patch } } : {},
      ),
    patchQqSchemeGroup: (group, patch) =>
      set((state) => {
        const editor = state.qqSchemeEditor;
        if (!editor) return {};
        return {
          qqSchemeEditor: {
            ...editor,
            [group]: { ...editor[group], ...patch },
          } as QqSchemeEditor,
        };
      }),
    saveQqScheme: async () => {
      const editor = get().qqSchemeEditor;
      if (!editor || get().qqSchemeSaving) return false;
      if (Object.keys(get().qqInputs.schemeInvalid).length || invalidSchemeInputs(get()).length) {
        set({ error: "请先修正方案中的无效数字，再保存。" });
        return false;
      }
      set({ qqSchemeSaving: true, error: null, feedback: "" });
      try {
        const saved = await get().apiClient.updateQqScheme(editor.source.id, {
          name: editor.name.trim(),
          description: editor.description.trim() === "" ? null : editor.description.trim(),
          triggers: editor.triggers,
          rhythm: editor.rhythm,
          context: editor.context,
          output_reserve: editor.outputReserve,
          stickers: editor.stickers,
          sticker_collections: { collection_ids: editor.stickerCollectionIds },
          prompts: editor.prompts,
          reply: editor.reply,
          expected_revision: editor.source.revision,
        });
        replaceScheme(saved);
        set({
          qqSchemeEditor: qqSchemeEditorFrom(saved),
          qqInputs: { ...get().qqInputs, schemeTexts: {}, schemeInvalid: {} },
          feedback: "已保存方案",
        });
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        set({ qqSchemeSaving: false });
      }
    },
    duplicateQqScheme: async (name) => {
      const editor = get().qqSchemeEditor;
      if (!editor || get().qqSchemeSaving) return false;
      set({ qqSchemeSaving: true, error: null, feedback: "" });
      try {
        const created = await get().apiClient.createQqScheme({
          name,
          description: editor.description.trim() === "" ? null : editor.description.trim(),
          triggers: editor.triggers,
          rhythm: editor.rhythm,
          context: editor.context,
          output_reserve: editor.outputReserve,
          stickers: editor.stickers,
          sticker_collections: { collection_ids: editor.stickerCollectionIds },
          prompts: editor.prompts,
          reply: editor.reply,
        });
        set((state) => ({ qqSchemes: [...state.qqSchemes, created] }));
        openEditor(created);
        set({ feedback: "已另存为新方案" });
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        set({ qqSchemeSaving: false });
      }
    },
    deleteQqScheme: async (id) => {
      if (get().qqSchemeSaving) return false;
      set({ qqSchemeSaving: true, error: null, feedback: "" });
      try {
        await get().apiClient.deleteQqScheme(id);
        const remaining = get().qqSchemes.filter((row) => row.id !== id);
        set({ qqSchemes: remaining, feedback: "已删除方案" });
        const next = remaining[0];
        if (next) openEditor(next);
        else set({ qqSchemeEditor: null, qqSchemeUsage: null });
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        set({ qqSchemeSaving: false });
      }
    },
    discardQqSchemeChanges: () => {
      const editor = get().qqSchemeEditor;
      if (editor) openEditor(editor.source);
    },
  };
}

/**
 * Storage actions (§11.1's 存储与诊断, P5h).
 *
 * The page reads what exists and offers one action: remove what has expired. Nothing here decides a
 * retention window — the server's cleanup reads the expiry columns, which were written from the one
 * definition in `qq-retention.ts`.
 */
export function createQqStorageActions(
  set: StoreSet,
  get: StoreGet,
): Pick<QqStorageState, "loadQqStorage" | "runQqStorageCleanup"> {
  return {
    loadQqStorage: async () => {
      if (get().qqStorageLoading) return;
      set({ qqStorageLoading: true, error: null });
      try {
        const usage = await get().apiClient.getQqStorage();
        set({ qqStorageUsage: usage });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error), feedback: "" });
      } finally {
        set({ qqStorageLoading: false });
      }
    },
    runQqStorageCleanup: async () => {
      if (get().qqStorageSaving) return false;
      set({ qqStorageSaving: true, error: null, feedback: "" });
      try {
        const removed = await get().apiClient.runQqStorageCleanup();
        set({ qqStorageRemoved: removed, feedback: "已清理过期内容" });
        // Re-read so the numbers describe the state the cleanup produced.
        set({ qqStorageLoading: false });
        const usage = await get().apiClient.getQqStorage();
        set({ qqStorageUsage: usage });
        return true;
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error), feedback: "" });
        return false;
      } finally {
        set({ qqStorageSaving: false });
      }
    },
  };
}

// ---- 第三方App接入 (§11.1, P5q) ---------------------------------------------------------------

/**
 * The access surface: read the saved state, write the two credentials-bearing fields, and manage
 * bindings. Everything goes through compare-and-swap with the revision the page read, so two open
 * windows cannot silently overwrite each other's answer.
 */
export function createQqAccessActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  QqAccessState,
  | "loadQqAccess"
  | "loadQqBindings"
  | "loadQqSettings"
  | "saveQqJudgementModel"
  | "refreshQqConnection"
  | "saveQqSurface"
  | "bindQqConversation"
  | "bindQqPeerNumber"
  | "updateQqBindingRow"
  | "organiseQqMemoryRow"
> {
  const report = (error: unknown) =>
    set({ error: error instanceof Error ? error.message : String(error), feedback: "" });
  const reload = async () => {
    // Schemes come along because a binding names one: the page's select needs the list, and
    // fetching it here keeps the row from offering an empty choice that cannot be saved.
    const [settings, conversations, bindings, schemes] = await Promise.all([
      get().apiClient.getQqSettings(),
      get().apiClient.listQqConversations(),
      get().apiClient.listQqBindings(),
      get().apiClient.listQqSchemes(),
    ]);
    set({
      qqSettings: settings,
      qqConversations: conversations,
      qqBindings: bindings,
      qqBindingsLoaded: true,
      qqSchemes: schemes,
    });
  };
  // One request serves both binding entries — an observed row and a typed number — because the
  // payload is the same and only the source of the conversation identity differs.
  const bindConversation = async (input: {
    accountId: string;
    kind: "group" | "private";
    peerId: string;
    agentId: string;
    schemeId: string;
  }): Promise<boolean> => {
    set({ qqAccessSaving: true, error: null, feedback: "" });
    try {
      await get().apiClient.createQqBinding({
        account_id: input.accountId,
        kind: input.kind,
        peer_id: input.peerId,
        agent_id: input.agentId,
        scheme_id: input.schemeId,
        paused: false,
        memory_batch_size: null,
        share_web_memory: false,
      });
      await reload();
      set({ feedback: "已绑定会话" });
      return true;
    } catch (error) {
      report(error);
      return false;
    } finally {
      set({ qqAccessSaving: false });
    }
  };
  return {
    loadQqAccess: async () => {
      if (get().qqAccessLoading) return;
      set({ qqAccessLoading: true, error: null });
      try {
        await reload();
        set({ qqConnection: (await get().apiClient.getQqStatus()).connection });
      } catch (error) {
        report(error);
      } finally {
        set({ qqAccessLoading: false });
      }
    },
    // One request, for the pages that only need to know which conversations exist (the 长期记忆
    // hint). A failed read leaves the flag set, so the hint stays quiet instead of retrying on
    // every render; the access page's own load reports the error when it is actually visited.
    loadQqBindings: async () => {
      if (get().qqBindingsLoaded) return;
      try {
        set({ qqBindings: await get().apiClient.listQqBindings(), qqBindingsLoaded: true });
      } catch {
        // Silence is deliberate: this read only decides whether a hint is shown.
      }
    },
    // Settings only, for the surfaces that need nothing else from the access page (the
    // default-model page's judgement select, 0038). Always refetches: this one can be saved from,
    // so carrying a stale revision forward would turn a real conflict into a confusing error.
    loadQqSettings: async () => {
      set({ qqAccessLoading: true, error: null });
      try {
        set({ qqSettings: await get().apiClient.getQqSettings() });
      } catch (error) {
        report(error);
      } finally {
        set({ qqAccessLoading: false });
      }
    },
    saveQqJudgementModel: async (modelName) => {
      const settings = get().qqSettings;
      if (!settings || get().qqAccessSaving) return false;
      set({ qqAccessSaving: true, error: null, feedback: "" });
      try {
        set({
          qqSettings: await get().apiClient.updateQqSettings({
            judgement_model_name: modelName,
            expected_revision: settings.revision,
          }),
          feedback: "已保存判断模型",
        });
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        set({ qqAccessSaving: false });
      }
    },
    refreshQqConnection: async () => {
      try {
        set({ qqConnection: (await get().apiClient.getQqStatus()).connection });
      } catch (error) {
        report(error);
      }
    },
    saveQqSurface: async (patch, expectedRevision) => {
      const settings = get().qqSettings;
      if (!settings || get().qqAccessSaving) return false;
      set({ qqAccessSaving: true, error: null, feedback: "" });
      try {
        // Two requests, one revision chain: the settings call may bump the revision, so the
        // transport call uses whatever came back rather than the revision the page started with.
        let current = { ...settings, revision: expectedRevision ?? settings.revision };
        if (patch.enabled !== undefined || patch.account_id !== undefined) {
          current = await get().apiClient.updateQqSettings({
            ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
            ...(patch.account_id === undefined ? {} : { account_id: patch.account_id }),
            expected_revision: current.revision,
          });
          set((state) => ({
            qqSettings: current,
            qqInputs: {
              ...state.qqInputs,
              connection:
                state.qqInputs.connection &&
                state.qqInputs.connection.source.revision ===
                  (expectedRevision ?? settings.revision)
                  ? { ...state.qqInputs.connection, source: current }
                  : state.qqInputs.connection,
            },
          }));
        }
        if (patch.endpoint !== undefined || patch.token !== undefined) {
          current = await get().apiClient.updateQqTransport({
            ...(patch.endpoint === undefined ? {} : { endpoint: patch.endpoint }),
            ...(patch.token === undefined ? {} : { token: patch.token }),
            expected_revision: current.revision,
          });
        }
        set({ qqSettings: current, feedback: "已保存接入设置" });
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        set({ qqAccessSaving: false });
      }
    },
    bindQqConversation: async ({ conversation, agentId, schemeId }) => {
      if (!get().qqSettings || get().qqAccessSaving) return false;
      return bindConversation({
        accountId: conversation.account_id,
        kind: conversation.kind,
        peerId: conversation.peer_id,
        agentId,
        schemeId,
      });
    },
    // The manual entry (2026-09-25): a conversation nobody has spoken in yet has no observation
    // row, and an unbound conversation's messages are not recorded at all — so the list alone can
    // never offer the first binding. The account comes from the saved settings, because there is
    // no observation to take it from.
    bindQqPeerNumber: async ({ kind, peerId, agentId, schemeId }) => {
      const settings = get().qqSettings;
      if (!settings || get().qqAccessSaving) return false;
      if (settings.account_id === null) {
        set({ error: "请先配置助手账号，再绑定会话", feedback: "" });
        return false;
      }
      return bindConversation({
        accountId: settings.account_id,
        kind,
        peerId,
        agentId,
        schemeId,
      });
    },
    updateQqBindingRow: async (binding, patch) => {
      if (get().qqAccessSaving) return false;
      set({ qqAccessSaving: true, error: null, feedback: "" });
      try {
        await get().apiClient.updateQqBinding(binding.id, {
          ...patch,
          expected_revision: binding.revision,
        });
        await reload();
        set({ feedback: "已更新绑定" });
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        set({ qqAccessSaving: false });
      }
    },
    // 「立即整理」: the answer is a verdict, so it is returned rather than written into the shared
    // feedback line — several rows can be on screen, and the sentence belongs to the row clicked.
    organiseQqMemoryRow: async (binding) => {
      if (get().qqAccessSaving) return null;
      set({ qqAccessSaving: true, error: null, feedback: "" });
      try {
        const verdict = await get().apiClient.organiseQqMemory(binding.id);
        // A queued job consumes the observations the row just counted, so the list is read again
        // rather than patched from the verdict's `pending`.
        if (verdict.status === "queued") await reload();
        return verdict;
      } catch (error) {
        report(error);
        return null;
      } finally {
        set({ qqAccessSaving: false });
      }
    },
  };
}
