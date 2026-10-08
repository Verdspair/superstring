// Sticker library actions (ADR0018 §9.2, P5d).
//
// Everything here goes through the API client, and every write reloads or patches the two lists
// from the server's answer rather than from the form: §9.2's fields are shared with the reply
// path, so the surface must show what is stored, not what was typed. A failed call leaves the
// editor as it was and reports the error, the same discipline the rest of the settings surfaces
// follow.

import type {
  QqBindingResponse,
  QqConversationListItem,
  QqSchemeResponse,
  QqSettingsResponse,
  QqStickerAssetResponse,
} from "../../../shared/contracts/qq";
import type {
  QqStorageCleanupRequest,
  QqStorageSettingsResponse,
} from "../../../shared/contracts/qq-storage";
import { ApiError, type SuperstringApi } from "../../api";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";
import { invalidSchemeInputs, invalidSchemeTimezone, parseAttentionMembers } from "./draft-state";
import {
  QQ_STORAGE_PAGE_SIZE,
  type QqAccessState,
  type QqBindingsReadOptions,
  type QqSchemeEditor,
  type QqSchemeState,
  type QqSchemesReadOptions,
  type QqStickerState,
  type QqStorageItemsQuery,
  type QqStorageState,
  qqSchemeChanges,
  qqSchemeDirty,
  qqSchemeEditorFrom,
  qqStickerEditorFrom,
  qqStickerEditorTags,
  qqStorageDaysChanged,
  qqStorageDaysValid,
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
  /** 集合简介的客户端规范化：null 与空白都发 null（清除/未填），其余去掉首尾空白；上限随契约 max(2000)。 */
  const normaliseDescription = (description: string | null) =>
    description === null || description.trim() === "" ? null : description.trim();
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
        set((state) => {
          const isCurrent = state.qqStickerEditor === editor;
          return {
            qqStickerAssets: state.qqStickerAssets.map((row) =>
              row.id === final.id ? final : row,
            ),
            qqStickerEditor: isCurrent ? { ...qqStickerEditorFrom(final) } : state.qqStickerEditor,
            ...(isCurrent
              ? { feedback: options?.enableAfterSave ? "已保存并启用" : "已保存素材整理" }
              : {}),
          };
        });
        void loadImpact(final.id);
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
    createQqStickerCollection: async (name, description) => {
      if (get().qqStickerSaving) return false;
      set({ qqStickerSaving: true, error: null });
      try {
        const collection = await get().apiClient.createQqStickerCollection({
          name,
          // 新建时留空＝没有简介：显式发 null（服务端对缺省也按 null 处理，这里只发一种写法）。
          description: normaliseDescription(description ?? null),
        });
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
    renameQqStickerCollection: async (id, name, expectedRevision, description) => {
      if (get().qqStickerSaving) return false;
      set({ qqStickerSaving: true, error: null });
      try {
        const collection = await get().apiClient.updateQqStickerCollection(id, {
          name,
          // 未携带简介＝本次不改动：整个字段省去，服务端保留已存值——「没改」绝不会变成清空。
          ...(description === undefined ? {} : { description: normaliseDescription(description) }),
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
 * 方案目录读取的唯一落地路径（方案页与绑定目录读取共用）：
 * 目录行替换后，编辑器有草稿（含非法输入原文）时按字段合并——已改字段保留草稿、未改字段
 * 连同 revision 跟随新基线；方案已不在目录时保留草稿供另存，不自动切走。
 * 调用方必须先做代次/API 身份校验，保存进行中的旧读取不得走到这里。
 */
function createSchemeDirectorySync(set: StoreSet, get: StoreGet) {
  let usageInFlight: { id: string; readId: number } | null = null;
  const loadUsage = async (id: string, force = false) => {
    if (!force && (usageInFlight?.id === id || get().qqSchemeUsage?.schemeId === id)) return;
    const api = get().apiClient;
    const readId = get().qqSchemeUsageReadId + 1;
    usageInFlight = { id, readId };
    set({ qqSchemeUsageReadId: readId });
    try {
      const usage = await api.getQqSchemeUsage(id);
      if (get().apiClient !== api || get().qqSchemeUsageReadId !== readId) return;
      if (get().qqSchemeEditor?.source.id !== id) return;
      set({
        qqSchemeUsage: { schemeId: id, bindings: usage.bindings },
        qqSchemeUsageError: null,
      });
    } catch (error) {
      // 次数只是提示：读不到时留下「未知」而不是沿用旧计数（旧值可能是 0，会误放行删除）。
      if (get().apiClient !== api || get().qqSchemeUsageReadId !== readId) return;
      if (get().qqSchemeEditor?.source.id !== id) return;
      set({ qqSchemeUsage: null, qqSchemeUsageError: errorText(error) });
    } finally {
      if (usageInFlight?.readId === readId) {
        usageInFlight = null;
      }
    }
  };
  const openEditor = (scheme: QqSchemeResponse) => {
    set({
      qqSchemeEditor: qqSchemeEditorFrom(scheme),
      qqInputs: { ...get().qqInputs, schemeTexts: {}, schemeInvalid: {} },
      qqSchemeUsage: null,
      qqSchemeUsageError: null,
      error: null,
      feedback: "",
    });
    void loadUsage(scheme.id);
  };
  const schemeInputsLive = () =>
    Object.keys(get().qqInputs.schemeTexts).length > 0 ||
    Object.keys(get().qqInputs.schemeInvalid).length > 0;
  const mergeFreshSource = (editor: QqSchemeEditor, fresh: QqSchemeResponse): QqSchemeEditor => {
    const changed = new Set(qqSchemeChanges(editor).map((row) => row.field));
    const next = qqSchemeEditorFrom(fresh);
    if (!changed.size) return next;
    const carry = (prefix: string, draft: object, target: object) => {
      const values = draft as Record<string, unknown>;
      const destination = target as Record<string, unknown>;
      for (const key of Object.keys(values))
        if (changed.has(`${prefix}.${key}`)) destination[key] = values[key];
    };
    if (changed.has("name")) next.name = editor.name;
    if (changed.has("description")) next.description = editor.description;
    carry("triggers", editor.triggers, next.triggers);
    carry("rhythm", editor.rhythm, next.rhythm);
    carry("context", editor.context, next.context);
    carry("compression", editor.compression, next.compression);
    carry("output_reserve", editor.outputReserve, next.outputReserve);
    carry("stickers", editor.stickers, next.stickers);
    if (changed.has("sticker_collections.collection_ids"))
      next.stickerCollectionIds = [...editor.stickerCollectionIds];
    carry("prompts", editor.prompts, next.prompts);
    if (changed.has("reply.split_by_speaker"))
      next.reply = { ...next.reply, split_by_speaker: editor.reply.split_by_speaker };
    // 0052 两组：已改叶子保留草稿（含 stages 嵌套逐叶子与可空原图），未改叶子跟随新答案。
    carry("message_settings", editor.messageSettings, next.messageSettings);
    carry("media_input", editor.mediaInput, next.mediaInput);
    // 0052 stages 逐叶子 carry：三相位是契约固定布尔，只把已改的相位从草稿编辑器带过来。
    const draftStages = editor.mediaInput.stages;
    const nextStages = { ...next.mediaInput.stages };
    for (const phase of ["decision", "evaluation", "generation"] as const)
      if (changed.has(`media_input.stages.${phase}`)) nextStages[phase] = draftStages[phase];
    next.mediaInput = { ...next.mediaInput, stages: nextStages };
    return next;
  };
  const applyDirectoryRead = (
    schemes: QqSchemeResponse[],
    refreshEditor = true,
    forceUsage = false,
  ) => {
    set({ qqSchemes: schemes });
    const editor = get().qqSchemeEditor;
    const fresh = editor ? schemes.find((row) => row.id === editor.source.id) : undefined;
    if (!refreshEditor) {
      if (editor && fresh) void loadUsage(fresh.id, forceUsage);
      else if (editor) set({ qqSchemeUsage: null });
      return;
    }
    if (editor && fresh && (qqSchemeDirty(editor) || schemeInputsLive())) {
      set({
        qqSchemeEditor: mergeFreshSource(editor, fresh),
        feedback: msg("刷新不提交草稿；冲突后请核对最新值再保存。"),
      });
      void loadUsage(fresh.id, forceUsage);
      return;
    }
    if (editor && !fresh && (qqSchemeDirty(editor) || schemeInputsLive())) {
      // 当前方案已不在目录里（别处删除或失去可见性）：保留原草稿供核对或另存复制，不自动切到
      // 第一个——切换会丢掉未保存内容，而保存会被服务端 404 明确拒绝，草稿仍可复制出去。
      set({
        qqSchemeUsage: null,
        feedback: msg("刷新不提交草稿；冲突后请核对最新值再保存。"),
      });
      return;
    }
    if (fresh) openEditor(fresh);
    else if (schemes[0]) openEditor(schemes[0]);
    else set({ qqSchemeEditor: null, qqSchemeUsage: null, qqSchemeUsageError: null });
  };
  return { loadUsage, openEditor, applyDirectoryRead };
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
  | "refreshQqScheme"
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
  // 变更操作的模块级令牌：`resetForTests` 会把 store 里的代次清零，单靠代次无法区分
  // 「重置后新操作恰好拿到同一编号」��令牌不随重置回收，与代次一起判定「仍是当前操作」。
  let operationToken = 0;
  let schemesInFlight: { promise: Promise<boolean>; readId: number; api: SuperstringApi } | null =
    null;
  /**
   * 变更开始：记录 API、编辑器引用与操作代次，并作废在途的目录读取。
   * 响应、错误与 finally 都据此判定自己是否仍属于当前操作，旧操作不得写入新状态。
   */
  const beginOperation = () => {
    schemesInFlight = null;
    const state = get();
    operationToken += 1;
    const operation = {
      api: state.apiClient,
      editor: state.qqSchemeEditor,
      id: state.qqSchemeOperationId + 1,
      token: operationToken,
    };
    set({
      qqSchemeSaving: true,
      qqSchemeOperationId: operation.id,
      // 变更开始即作废在途的目录读取：旧列表晚到不得覆盖刚写入的结果，也不再占着 loading。
      qqSchemesReadId: state.qqSchemesReadId + 1,
      qqSchemesLoading: false,
      error: null,
      feedback: "",
    });
    return operation;
  };
  const isCurrentOperation = (operation: ReturnType<typeof beginOperation>) =>
    get().qqSchemeOperationId === operation.id && operationToken === operation.token;
  /** 只有同一个 API 客户端上的当前操作才允许写状态（换客户端即弃。finally 只认操作代次）。 */
  const isCurrentApi = (operation: ReturnType<typeof beginOperation>) =>
    get().apiClient === operation.api && isCurrentOperation(operation);
  const schemeDirectory = createSchemeDirectorySync(set, get);
  const readDirectory = async (readOptions?: {
    background?: boolean;
    editor?: boolean;
    quiet?: boolean;
    forceUsage?: boolean;
  }): Promise<boolean> => {
    // 保存进行中：目录读取不得与写入交错（旧列表晚到会盖掉刚保存的行）；与界面 busy 禁用一致。
    if (get().qqSchemeSaving) return false;
    const api = get().apiClient;
    const readId = get().qqSchemesReadId + 1;
    if (!readOptions?.quiet && !readOptions?.background) {
      set({ qqSchemesReadId: readId, qqSchemesLoading: true, error: null });
    } else if (!readOptions?.quiet) {
      set({ qqSchemesReadId: readId, qqSchemesLoading: true });
    } else {
      set({ qqSchemesReadId: readId });
    }
    try {
      const schemes = await api.listQqSchemes();
      if (get().qqSchemesReadId !== readId || get().apiClient !== api) return false;
      set({ qqSchemes: schemes, qqSchemesLoaded: true });
      if (readOptions?.editor !== false && !readOptions?.background) {
        schemeDirectory.applyDirectoryRead(schemes, !readOptions?.quiet, !!readOptions?.forceUsage);
      }
      return true;
    } catch (error) {
      if (get().qqSchemesReadId !== readId || get().apiClient !== api) return false;
      if (error instanceof ApiError && error.status === 403) {
        set({ qqSchemes: [], qqSchemesLoaded: false });
      }
      if (!readOptions?.background && !readOptions?.quiet) {
        report(error);
      }
      return false;
    } finally {
      if (get().qqSchemesReadId === readId && get().apiClient === api) {
        set({ qqSchemesLoading: false });
      }
      if (schemesInFlight?.readId === readId) {
        schemesInFlight = null;
      }
    }
  };
  const replaceScheme = (scheme: QqSchemeResponse) =>
    set((state) => ({
      qqSchemes: state.qqSchemes.map((row) => (row.id === scheme.id ? scheme : row)),
    }));
  return {
    loadQqSchemes: async (options?: boolean | QqSchemesReadOptions) => {
      const refresh = typeof options === "boolean" ? options : !!options?.refresh;
      const background = typeof options === "object" && !!options?.background;
      const editor =
        typeof options === "object" && options.editor !== undefined ? options.editor : !background;
      const api = get().apiClient;

      if (get().qqSchemeSaving) return false;
      if (!refresh && schemesInFlight && schemesInFlight.api === api) {
        return schemesInFlight.promise;
      }

      const alreadyLoaded = get().qqSchemesLoaded;
      if (!refresh && alreadyLoaded && background) return true;

      const isQuietRevalidate = !refresh && alreadyLoaded;

      const promise = readDirectory({ background, editor, quiet: isQuietRevalidate });
      schemesInFlight = { promise, readId: get().qqSchemesReadId, api };
      return promise;
    },
    refreshQqScheme: async () => {
      if (get().qqSchemesLoading) return false;
      return readDirectory({ editor: true, forceUsage: true });
    },
    createQqScheme: async (name) => {
      if (get().qqSchemeSaving) return false;
      const operation = beginOperation();
      try {
        // A new scheme starts with the project's defaults: every trigger off (§11.1) and the
        // defaults the plan fixed. The repository owns them; this only supplies the name.
        const scheme = await operation.api.createQqScheme({ name, description: null });
        if (!isCurrentApi(operation)) return false;
        set((state) => ({ qqSchemes: [...state.qqSchemes, scheme] }));
        // 等待期间编辑器被切走（含同 id 重选）：新方案仍在目录里可选，但不抢当前会话。
        if (get().qqSchemeEditor === operation.editor) schemeDirectory.openEditor(scheme);
        set({ feedback: "已新建方案" });
        return true;
      } catch (error) {
        if (isCurrentApi(operation)) report(error);
        return false;
      } finally {
        if (isCurrentOperation(operation)) set({ qqSchemeSaving: false });
      }
    },
    selectQqScheme: (id) => {
      const scheme = get().qqSchemes.find((row) => row.id === id);
      if (scheme) schemeDirectory.openEditor(scheme);
    },
    patchQqScheme: (patch) => {
      if (get().qqSchemeSaving) return;
      set((state) =>
        state.qqSchemeEditor ? { qqSchemeEditor: { ...state.qqSchemeEditor, ...patch } } : {},
      );
    },
    patchQqSchemeGroup: (group, patch) => {
      if (get().qqSchemeSaving) return;
      set((state) => {
        const editor = state.qqSchemeEditor;
        if (!editor) return {};
        return {
          qqSchemeEditor: {
            ...editor,
            [group]: { ...editor[group], ...patch },
          } as QqSchemeEditor,
        };
      });
    },
    saveQqScheme: async () => {
      const editor = get().qqSchemeEditor;
      if (!editor || get().qqSchemeSaving) return false;
      if (Object.keys(get().qqInputs.schemeInvalid).length || invalidSchemeInputs(get()).length) {
        set({ error: msg("请先修正方案中的无效数字，再保存。") });
        return false;
      }
      // 0052 时区：非法 IANA 原文拦页内保存（与服务端契约同一判定）。
      if (invalidSchemeTimezone(get())) {
        set({ error: msg("请填写真实的 IANA 时区名称，再保存。") });
        return false;
      }
      const schemeId = editor.source.id;
      const operation = beginOperation();
      try {
        const saved = await operation.api.updateQqScheme(schemeId, {
          name: editor.name.trim(),
          description: editor.description.trim() === "" ? null : editor.description.trim(),
          triggers: editor.triggers,
          rhythm: editor.rhythm,
          context: editor.context,
          compression: editor.compression,
          output_reserve: editor.outputReserve,
          stickers: editor.stickers,
          sticker_collections: { collection_ids: editor.stickerCollectionIds },
          prompts: editor.prompts,
          reply: editor.reply,
          message_settings: editor.messageSettings,
          media_input: editor.mediaInput,
          expected_revision: editor.source.revision,
        });
        if (!isCurrentApi(operation)) return false;
        replaceScheme(saved);
        // 响应晚到且编辑器已被替换（含同 id 重选）：只更新目录行，绝不覆盖新编辑器会话。
        if (get().qqSchemeEditor === editor) {
          set({
            qqSchemeEditor: qqSchemeEditorFrom(saved),
            qqInputs: { ...get().qqInputs, schemeTexts: {}, schemeInvalid: {} },
            feedback: "已保存方案",
          });
        }
        return true;
      } catch (error) {
        if (isCurrentApi(operation)) report(error);
        return false;
      } finally {
        if (isCurrentOperation(operation)) set({ qqSchemeSaving: false });
      }
    },
    duplicateQqScheme: async (name) => {
      const editor = get().qqSchemeEditor;
      if (!editor || get().qqSchemeSaving) return false;
      if (Object.keys(get().qqInputs.schemeInvalid).length || invalidSchemeInputs(get()).length) {
        // 复制走的是 create 通道：不先校验的话会绕过界面把非法原值洗成默认值。
        set({ error: msg("请先修正方案中的无效数字，再保存。") });
        return false;
      }
      // 复制同样不能带非法时区出去（create 没有兜底校验，洗过去就是坏数据）。
      if (invalidSchemeTimezone(get())) {
        set({ error: msg("请填写真实的 IANA 时区名称，再保存。") });
        return false;
      }
      const operation = beginOperation();
      try {
        const created = await operation.api.createQqScheme({
          name,
          description: editor.description.trim() === "" ? null : editor.description.trim(),
          triggers: editor.triggers,
          rhythm: editor.rhythm,
          context: editor.context,
          compression: editor.compression,
          output_reserve: editor.outputReserve,
          stickers: editor.stickers,
          sticker_collections: { collection_ids: editor.stickerCollectionIds },
          prompts: editor.prompts,
          reply: editor.reply,
          // create 通道没有「未提供＝保持现值」：两组不带上会让另存为新方案静默丢自定义。
          message_settings: editor.messageSettings,
          media_input: editor.mediaInput,
        });
        if (!isCurrentApi(operation)) return false;
        set((state) => ({ qqSchemes: [...state.qqSchemes, created] }));
        // 与保存同一条边界：编辑器已被替换（含同 id 重选）时不抢当前会话。
        if (get().qqSchemeEditor === editor) schemeDirectory.openEditor(created);
        set({ feedback: "已另存为新方案" });
        return true;
      } catch (error) {
        if (isCurrentApi(operation)) report(error);
        return false;
      } finally {
        if (isCurrentOperation(operation)) set({ qqSchemeSaving: false });
      }
    },
    deleteQqScheme: async (id) => {
      if (get().qqSchemeSaving) return false;
      const operation = beginOperation();
      try {
        await operation.api.deleteQqScheme(id);
        if (!isCurrentApi(operation)) return false;
        const remaining = get().qqSchemes.filter((row) => row.id !== id);
        const wasCurrent = get().qqSchemeEditor?.source.id === id;
        set({ qqSchemes: remaining });
        // 只有删的是当前方案才换选中：删别的方案不该把编辑器抢走；提示最后设置，免得被 openEditor 清掉。
        if (wasCurrent) {
          if (remaining[0]) schemeDirectory.openEditor(remaining[0]);
          else set({ qqSchemeEditor: null, qqSchemeUsage: null, qqSchemeUsageError: null });
        }
        set({ feedback: "已删除方案" });
        return true;
      } catch (error) {
        if (isCurrentApi(operation)) report(error);
        return false;
      } finally {
        if (isCurrentOperation(operation)) set({ qqSchemeSaving: false });
      }
    },
    discardQqSchemeChanges: () => {
      const editor = get().qqSchemeEditor;
      if (editor) schemeDirectory.openEditor(editor.source);
    },
  };
}

/**
 * Storage management actions (§11.1's 存储与诊断, P5h).
 *
 * Two surfaces, one busy flag: the retention card writes through the same `qq_settings` revision
 * chain the access page uses (so two tabs editing different fields still detect each other), and
 * the cleanup workspace previews before it deletes. Nothing here decides a retention window — the
 * window only applies to records written afterwards, and physical deletion is always an explicit,
 * confirmed cleanup.
 */
export function createQqStorageActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  QqStorageState,
  | "loadQqStorage"
  | "refreshQqStorage"
  | "saveQqStorageSettings"
  | "loadQqStorageItems"
  | "previewQqStorageCleanup"
  | "runQqStorageCleanupSelection"
  | "clearQqStorageCleanup"
> {
  const report = (error: unknown) =>
    set({ error: error instanceof Error ? error.message : String(error), feedback: "" });
  // 读取的模块级令牌（与方案/接入模块同一模式）：`resetForTests` 会把 store 代次清零，
  // 单靠代次无法区分「重置后新读取恰好拿到同一编号」；令牌不随重置回收。
  let storageReadToken = 0;
  const beginStorageRead = () => {
    const state = get();
    storageReadToken += 1;
    const operation = {
      api: state.apiClient,
      id: state.qqStorageReadId + 1,
      token: storageReadToken,
    };
    set({ qqStorageReadId: operation.id });
    return operation;
  };
  const isCurrentStorageRead = (operation: ReturnType<typeof beginStorageRead>) =>
    get().qqStorageReadId === operation.id && storageReadToken === operation.token;
  const isCurrentStorageApi = (operation: ReturnType<typeof beginStorageRead>) =>
    get().apiClient === operation.api && isCurrentStorageRead(operation);
  /** 写入开始即作废在途读取：旧设置晚到不得盖掉刚保存的值，也不留悬空的 loading。 */
  const invalidateStorageReads = () =>
    set({ qqStorageReadId: get().qqStorageReadId + 1, qqStorageLoading: false });
  /** 摘要与设置的一体读取；保存进行中不开始（与界面 busy 禁用一致）。 */
  const readUsageAndSettings = async (): Promise<QqStorageSettingsResponse | null> => {
    if (get().qqStorageSaving) return null;
    const operation = beginStorageRead();
    set({ qqStorageLoading: true, error: null });
    try {
      const [usage, settings] = await Promise.all([
        operation.api.getQqStorage(),
        operation.api.getQqStorageSettings(),
      ]);
      if (!isCurrentStorageApi(operation)) return null;
      set({ qqStorageUsage: usage, qqStorageSettings: settings });
      return settings;
    } catch (error) {
      if (isCurrentStorageApi(operation)) report(error);
      return null;
    } finally {
      if (isCurrentStorageRead(operation)) set({ qqStorageLoading: false });
    }
  };
  /** 显式刷新合并保留草稿：已改天数（含非法原文）保留，未改字段与 revision 跟随新基线。 */
  const mergeStorageDraft = (fresh: QqStorageSettingsResponse) => {
    const draft = get().qqInputs.storage;
    if (!draft) return;
    set((state) => ({
      qqInputs: {
        ...state.qqInputs,
        storage: {
          source: fresh,
          days: qqStorageDaysChanged(draft.days, draft.source.retention_days)
            ? draft.days
            : String(fresh.retention_days),
        },
      },
    }));
  };
  // 清理操作的模块级令牌：预览与执行共用一个代次，关闭/卸载后旧响应与旧错误不得落地。
  let cleanupToken = 0;
  const beginCleanup = () => {
    cleanupToken += 1;
    const operation = {
      api: get().apiClient,
      id: get().qqStorageCleanupOperationId + 1,
      token: cleanupToken,
    };
    set({
      qqStorageCleanupOperationId: operation.id,
      qqStorageSaving: true,
      qqStorageCleanupError: null,
      error: null,
      feedback: "",
    });
    return operation;
  };
  const isCurrentCleanup = (operation: ReturnType<typeof beginCleanup>) =>
    get().qqStorageCleanupOperationId === operation.id && cleanupToken === operation.token;
  const isCurrentCleanupApi = (operation: ReturnType<typeof beginCleanup>) =>
    get().apiClient === operation.api && isCurrentCleanup(operation);
  return {
    loadQqStorage: async () => {
      if (get().qqStorageLoading) return;
      // 隐式读取绝不推进保留草稿基线（与连接页同一纪律）。
      await readUsageAndSettings();
    },
    refreshQqStorage: async () => {
      if (get().qqStorageLoading) return;
      const settings = await readUsageAndSettings();
      if (settings) mergeStorageDraft(settings);
    },
    saveQqStorageSettings: async () => {
      const draft = get().qqInputs.storage;
      if (!draft || get().qqStorageSaving) return false;
      if (!qqStorageDaysValid(draft.days)) {
        set({ error: "请填写 1–3650 之间的整数天数，再保存。", feedback: "" });
        return false;
      }
      set({ qqStorageSaving: true, error: null, feedback: "" });
      invalidateStorageReads();
      try {
        const saved = await get().apiClient.updateQqStorageSettings({
          retention_days: Number(draft.days),
          expected_revision: draft.source.revision,
        });
        set((state) => {
          // 保存成功后 revision 推进到新值，数字原文保留（用户可继续改）。
          const storageKept =
            state.qqInputs.storage?.source.revision === draft.source.revision
              ? { ...state.qqInputs, storage: { source: saved, days: draft.days } }
              : state.qqInputs;
          const connection = storageKept.connection;
          return {
            qqStorageSettings: saved,
            // 摘要里的保留天数本地推进；其余统计保持原值，等下一次读取刷新。
            qqStorageUsage: state.qqStorageUsage
              ? {
                  ...state.qqStorageUsage,
                  retention: { ...state.qqStorageUsage.retention, days: saved.retention_days },
                }
              : state.qqStorageUsage,
            // 共享同一条 qq_settings 修订链：本次 PUT 成功即已知的自身推进（新 revision 来自响应）。
            // 全局快照与连接草稿只推进 revision——草稿输入与旧 source 的其余字段保留供脏比较；
            // 基线对不上的快照不动，由下一次 CAS 如实报告冲突。
            qqSettings:
              state.qqSettings && state.qqSettings.revision === draft.source.revision
                ? { ...state.qqSettings, revision: saved.revision }
                : state.qqSettings,
            qqInputs: {
              ...storageKept,
              connection:
                connection && connection.source.revision === draft.source.revision
                  ? { ...connection, source: { ...connection.source, revision: saved.revision } }
                  : connection,
            },
            feedback: "已保存保留设置",
          };
        });
        return true;
      } catch (error) {
        // 冲突（409）或失败：草稿原样保留，界面提示刷新后可重试。
        report(error);
        return false;
      } finally {
        set({ qqStorageSaving: false });
      }
    },
    loadQqStorageItems: async (query: QqStorageItemsQuery, options) => {
      const api = get().apiClient;
      const readId = get().qqStorageItemsReadId + 1;
      set({ qqStorageItemsReadId: readId, qqStorageItemsLoading: true, qqStorageItemsError: null });
      try {
        const page = await api.listQqStorageItems(
          {
            category: query.category,
            status: query.status,
            limit: QQ_STORAGE_PAGE_SIZE,
            ...(query.kind ? { kind: query.kind } : {}),
            ...(query.peerId.trim() ? { peer_id: query.peerId.trim() } : {}),
            ...(query.cursor ? { cursor: query.cursor } : {}),
          },
          options?.signal,
        );
        if (get().qqStorageItemsReadId !== readId || get().apiClient !== api) return;
        set({
          qqStorageItems: page.items,
          qqStorageItemsTotal: page.total,
          qqStorageItemsNextCursor: page.next_cursor,
        });
      } catch (error) {
        // 卸载时主动中止的请求不是错误：迟到结果不落地，也不显示失败。
        if (options?.signal?.aborted) return;
        if (get().qqStorageItemsReadId !== readId || get().apiClient !== api) return;
        set({ qqStorageItemsError: errorText(error) });
      } finally {
        if (get().qqStorageItemsReadId === readId && get().apiClient === api)
          set({ qqStorageItemsLoading: false });
      }
    },
    previewQqStorageCleanup: async (request: QqStorageCleanupRequest) => {
      if (get().qqStorageSaving) return false;
      // 冻结请求快照：确认执行的必须是预览的这一份，而不是届时可能已变的勾选。
      const snapshot: QqStorageCleanupRequest = {
        category: request.category,
        ...(request.ids ? { ids: [...request.ids] } : {}),
      };
      const operation = beginCleanup();
      set({
        qqStorageCleanupRequest: snapshot,
        qqStorageCleanupPreview: null,
        qqStorageCleanupResult: null,
      });
      try {
        const preview = await operation.api.previewQqStorageCleanup(snapshot);
        if (!isCurrentCleanupApi(operation)) return false;
        set({ qqStorageCleanupPreview: preview });
        return true;
      } catch (error) {
        if (isCurrentCleanupApi(operation)) set({ qqStorageCleanupError: errorText(error) });
        return false;
      } finally {
        if (isCurrentCleanup(operation)) set({ qqStorageSaving: false });
      }
    },
    runQqStorageCleanupSelection: async () => {
      const request = get().qqStorageCleanupRequest;
      const preview = get().qqStorageCleanupPreview;
      if (!request || !preview || get().qqStorageSaving) return false;
      const operation = beginCleanup();
      try {
        const result = await operation.api.runQqStorageSelectionCleanup(request);
        if (!isCurrentCleanupApi(operation)) return false;
        set({ qqStorageCleanupResult: result, feedback: "已清理所选内容" });
      } catch (error) {
        // 失败保留 request 与 preview，界面据此给出原样重试。
        if (isCurrentCleanupApi(operation)) set({ qqStorageCleanupError: errorText(error) });
        return false;
      } finally {
        if (isCurrentCleanup(operation)) set({ qqStorageSaving: false });
      }
      // 成功且未被取代：busy 归零后再重读摘要（删除后统计已变；读取失败由摘要自己的错误态呈现）。
      void get().loadQqStorage();
      return true;
    },
    clearQqStorageCleanup: () => {
      cleanupToken += 1;
      set((state) => ({
        qqStorageCleanupOperationId: state.qqStorageCleanupOperationId + 1,
        qqStorageCleanupRequest: null,
        qqStorageCleanupPreview: null,
        qqStorageCleanupResult: null,
        qqStorageCleanupError: null,
        // 卸载/关闭不得让 busy 卡住导航；在途保存的 finally 会再次归零。
        qqStorageSaving: false,
      }));
    },
  };
}

// ---- 第三方App接入 (§11.1, P5q) ---------------------------------------------------------------

/** 名单输入是自由文本：按解析后的集合判断改没改（与 attentionDirty 同一口径）。 */
const sameAttentionMembers = (text: string, members: readonly string[]) => {
  const parsed = parseAttentionMembers(text);
  return (
    parsed.length === members.length &&
    [...parsed].sort().join(" ") === [...members].sort().join(" ")
  );
};

/**
 * 显式「刷新保存基线」唯一的草稿合并：只合并被点名绑定的 choices/attention/记忆整理条数草稿。
 * 已改字段保留（含非法/空输入原文），未改字段与 revision 跟随新基线；隐式目录读取走不到这里。
 */
function mergeExplicitBindingDraft(
  state: SuperstringState,
  bindingId: string,
  fresh: QqBindingResponse,
): Pick<SuperstringState, "qqInputs" | "qqMemoryBatchDrafts"> | null {
  const choice = state.qqInputs.choices[bindingId];
  const attention = state.qqInputs.attention[bindingId];
  const batch = state.qqMemoryBatchDrafts[bindingId];
  if (!choice?.source && !attention && !batch) return null;
  const choices = { ...state.qqInputs.choices };
  if (choice?.source) {
    choices[bindingId] = {
      agentId: choice.agentId !== choice.source.agent_id ? choice.agentId : fresh.agent_id,
      schemeId: choice.schemeId !== choice.source.scheme_id ? choice.schemeId : fresh.scheme_id,
      source: fresh,
    };
  }
  const attentionNext = { ...state.qqInputs.attention };
  if (attention) {
    const base = attention.source.attention;
    attentionNext[bindingId] = {
      source: fresh,
      mode: attention.mode === base.mode ? fresh.attention.mode : attention.mode,
      members: sameAttentionMembers(attention.members, base.members)
        ? fresh.attention.members.join(" ")
        : attention.members,
    };
  }
  const batchNext = { ...state.qqMemoryBatchDrafts };
  // 用户显式刷新同一个绑定范围：输入保留、revision 推进，保存重试才可能通过 CAS。
  if (batch) batchNext[bindingId] = { value: batch.value, revision: fresh.revision };
  return {
    qqInputs: { ...state.qqInputs, choices, attention: attentionNext },
    qqMemoryBatchDrafts: batchNext,
  };
}

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
  | "loadQqBindingDirectory"
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
  const schemeDirectory = createSchemeDirectorySync(set, get);
  let bindingsInFlight: { promise: Promise<void>; readId: number; api: SuperstringApi } | null =
    null;
  // 访问侧读取的模块级令牌（与方案模块同一模式）：`resetForTests` 会把 store 里的代次清零，
  // 单靠代次无法区分「重置后新读取恰好拿到同一编号」；令牌不随重置回收。
  let accessReadToken = 0;
  const beginAccessRead = () => {
    const state = get();
    accessReadToken += 1;
    const operation = {
      api: state.apiClient,
      id: state.qqBindingsReadId + 1,
      token: accessReadToken,
    };
    set({ qqBindingsReadId: operation.id });
    return operation;
  };
  const isCurrentAccessRead = (operation: ReturnType<typeof beginAccessRead>) =>
    get().qqBindingsReadId === operation.id && accessReadToken === operation.token;
  const isCurrentAccessApi = (operation: ReturnType<typeof beginAccessRead>) =>
    get().apiClient === operation.api && isCurrentAccessRead(operation);
  /** 写入开始即作废在途读取：旧列表/旧设置晚到不得盖掉刚写入的结果，也不留悬空的 loading。 */
  const invalidateAccessReads = () => {
    bindingsInFlight = null;
    set({ qqBindingsReadId: get().qqBindingsReadId + 1, qqBindingsLoading: false });
  };
  /** 绑定写入成功后当前方案的使用量可能已变：清为未知再真实重读，旧计数 0 不得放行删除。 */
  const refreshSchemeUsage = () => {
    const editor = get().qqSchemeEditor;
    if (!editor) return;
    set({ qqSchemeUsage: null });
    void schemeDirectory.loadUsage(editor.source.id, true);
  };
  /** 显式刷新连接时合并连接草稿：已改字段保留输入，未改字段跟随新基线，revision 推进到刷新值。 */
  const mergeConnectionDraft = (fresh: QqSettingsResponse) => {
    const draft = get().qqInputs.connection;
    if (!draft) return;
    const endpoint =
      draft.endpoint.trim() !== (draft.source.transport.endpoint ?? "")
        ? draft.endpoint
        : (fresh.transport.endpoint ?? "");
    const accountId =
      draft.accountId.trim() !== (draft.source.account_id ?? "")
        ? draft.accountId
        : (fresh.account_id ?? "");
    set((state) => ({
      qqInputs: {
        ...state.qqInputs,
        connection: { source: fresh, endpoint, accountId, token: draft.token },
      },
    }));
  };
  const reload = async () => {
    // Schemes come along because a binding names one: the page's select needs the list, and
    // fetching it here keeps the row from offering an empty choice that cannot be saved.
    const operation = beginAccessRead();
    const schemeReadId = get().qqSchemesReadId;
    set({ qqBindingsLoading: true });
    let rows: [
      QqSettingsResponse,
      QqConversationListItem[],
      QqBindingResponse[],
      QqSchemeResponse[],
    ];
    try {
      rows = await Promise.all([
        operation.api.getQqSettings(),
        operation.api.listQqConversations(),
        operation.api.listQqBindings(),
        operation.api.listQqSchemes(),
      ]);
    } catch (error) {
      if (isCurrentAccessApi(operation)) {
        set({
          qqBindingsLoading: false,
          qqBindingsLoaded: false,
          qqBindingsError: errorText(error),
          qqSchemeUsage: null,
          qqSchemeUsageReadId: get().qqSchemeUsageReadId + 1,
        });
        throw error;
      }
      return;
    }
    if (!isCurrentAccessApi(operation)) return;
    const [settings, conversations, bindings, schemes] = rows;
    set({
      qqSettings: settings,
      qqConversations: conversations,
      qqBindings: bindings,
      qqBindingsLoaded: true,
      qqBindingsError: null,
      qqBindingsLoading: false,
    });
    // 方案目录行经方案模块的同一合并路径落地；读取期间发生的方案保存已推进代次，旧列表直接丢弃。
    if (get().qqSchemesReadId === schemeReadId) schemeDirectory.applyDirectoryRead(schemes, false);
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
    invalidateAccessReads();
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
      refreshSchemeUsage();
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
      // 本群配置保存进行中不开始整页读取：它的结果只会与同一条写入竞争，等保存方完成后重读。
      if (get().qqGroupConfigSaving) return;
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
    // hint). 无参保持缓存语义：读成功过就不再请求，失败保持安静（提示宁可不显示，也不重试轰炸）。
    // 显式刷新（refresh = true，目录刷新与使用量会话）绕开缓存真实重读；失败时把「未知」与原因
    // 留下（qqBindingsLoaded = false + qqBindingsError），不写全局 error，别的页面保持安静。
    loadQqBindings: async (options?: boolean | QqBindingsReadOptions) => {
      const refresh = typeof options === "boolean" ? options : !!options?.refresh;
      const background = typeof options === "object" && !!options?.background;
      const api = get().apiClient;

      if (!refresh && bindingsInFlight && bindingsInFlight.api === api) {
        return bindingsInFlight.promise;
      }
      const alreadyLoaded = get().qqBindingsLoaded;
      if (!refresh && alreadyLoaded) return;

      const isQuietRevalidate = !refresh && alreadyLoaded;

      const operation = beginAccessRead();
      if (!isQuietRevalidate && !background) {
        set({
          qqBindingsLoading: true,
          ...(refresh ? { qqBindingsLoaded: false, qqBindingsError: null } : {}),
        });
      } else if (!isQuietRevalidate) {
        set({ qqBindingsLoading: true });
      }

      const execute = async () => {
        try {
          const bindings = await operation.api.listQqBindings();
          if (!isCurrentAccessApi(operation)) return;
          set({
            qqBindings: bindings,
            qqBindingsLoaded: true,
            ...(background ? {} : { qqBindingsError: null }),
            qqBindingsLoading: false,
          });
        } catch (error) {
          if (!isCurrentAccessApi(operation)) return;
          if (error instanceof ApiError && error.status === 403) {
            set({ qqBindings: [], qqBindingsLoaded: false });
          }
          if (refresh) {
            set({
              qqBindingsLoaded: false,
              qqBindingsError: errorText(error),
              qqBindingsLoading: false,
            });
          } else {
            // 静默读失败：保持原样，不制造错误提示。
            set({ qqBindingsLoading: false });
          }
        } finally {
          if (isCurrentAccessApi(operation)) {
            set({ qqBindingsLoading: false });
          }
          if (bindingsInFlight?.readId === operation.id) {
            bindingsInFlight = null;
          }
        }
      };

      const promise = execute();
      bindingsInFlight = { promise, readId: operation.id, api };
      return promise;
    },
    loadQqBindingDirectory: async (bindingId?: string) => {
      // 保存进行中不开始读取：结果只会与刚写入的内容竞争，等保存方完成后自己重读。
      if (get().qqSchemeSaving || get().qqAccessSaving || get().qqGroupConfigSaving) return;
      const operation = beginAccessRead();
      const schemeReadId = get().qqSchemesReadId;
      set({
        qqBindingsLoading: true,
        qqBindingsLoaded: false,
        qqBindingsError: null,
        qqSchemeUsage: null,
        qqSchemeUsageReadId: get().qqSchemeUsageReadId + 1,
      });
      try {
        const [settings, conversations, bindings, schemes] = await Promise.all([
          operation.api.getQqSettings(),
          operation.api.listQqConversations(),
          operation.api.listQqBindings(),
          operation.api.listQqSchemes(),
        ]);
        if (!isCurrentAccessApi(operation)) return;
        set({
          qqSettings: settings,
          qqConversations: conversations,
          qqBindings: bindings,
          qqBindingsLoaded: true,
          qqBindingsError: null,
          qqBindingsLoading: false,
        });
        // 方案目录行不直接落地：经方案模块同一保护/合并路径，在途方案保存或更新读取优先。
        if (get().qqSchemesReadId === schemeReadId)
          schemeDirectory.applyDirectoryRead(schemes, false);
        // 只有显式点名（「刷新保存基线」）才合并该绑定草稿；隐式读取绝不自动刷新保存基线。
        if (bindingId) {
          const fresh = bindings.find((row) => row.id === bindingId);
          if (fresh) {
            const patch = mergeExplicitBindingDraft(get(), bindingId, fresh);
            if (patch) set(patch);
          }
          set({ error: null, feedback: msg("刷新不提交草稿；冲突后请核对最新值再保存。") });
        }
      } catch (error) {
        if (!isCurrentAccessApi(operation)) return;
        // 失败按「未知」呈现：由视图给出可重试的失败态，不拿缓存列表继续操作。
        set({
          qqBindingsLoaded: false,
          qqBindingsError: errorText(error),
          qqBindingsLoading: false,
        });
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
      invalidateAccessReads();
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
      // 连接页唯一刷新：重读设置与连接状态；草稿的已改字段保留、未改字段跟随新基线并推进
      // revision，这样一次冲突（409）后直接刷新即可重试；失败保留草稿与旧状态并可重试。
      const operation = beginAccessRead();
      try {
        const [settings, status] = await Promise.all([
          operation.api.getQqSettings(),
          operation.api.getQqStatus(),
        ]);
        if (!isCurrentAccessApi(operation)) return;
        set({ qqSettings: settings, qqConnection: status.connection });
        mergeConnectionDraft(settings);
      } catch (error) {
        if (isCurrentAccessApi(operation)) report(error);
      }
    },
    saveQqSurface: async (patch, expectedRevision) => {
      const settings = get().qqSettings;
      if (!settings || get().qqAccessSaving) return false;
      set({ qqAccessSaving: true, error: null, feedback: "" });
      invalidateAccessReads();
      /**
       * 共享同一条 qq_settings 修订链的另一个草稿（保留设置）：每个成功步都把它的基线 revision
       * 推进到写入后的值——天数原文与旧 source 其余字段保留供脏比较；部分成功也留下有效基线。
       * 基线对不上就不动，由下一次 CAS 如实报告冲突。
       */
      const advanceStorageBaseline = (from: number, to: number) =>
        set((state) => {
          const storage = state.qqInputs.storage;
          if (!storage || storage.source.revision !== from) return {};
          return {
            qqInputs: {
              ...state.qqInputs,
              storage: { ...storage, source: { ...storage.source, revision: to } },
            },
          };
        });
      try {
        // Two requests, one revision chain: the settings call may bump the revision, so the
        // transport call uses whatever came back rather than the revision the page started with.
        let current = { ...settings, revision: expectedRevision ?? settings.revision };
        const baseRevision = current.revision;
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
                state.qqInputs.connection.source.revision === baseRevision
                  ? { ...state.qqInputs.connection, source: current }
                  : state.qqInputs.connection,
            },
          }));
          advanceStorageBaseline(baseRevision, current.revision);
        }
        if (patch.endpoint !== undefined || patch.token !== undefined) {
          const before = current.revision;
          current = await get().apiClient.updateQqTransport({
            ...(patch.endpoint === undefined ? {} : { endpoint: patch.endpoint }),
            ...(patch.token === undefined ? {} : { token: patch.token }),
            expected_revision: current.revision,
          });
          advanceStorageBaseline(before, current.revision);
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
    // The manual entry: a conversation nobody has spoken in yet has no observation
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
      // 本群配置保存进行中同样不开始：两个写会落在同一行绑定上，让保存方先落地，
      // 冲突留给 CAS 与显式刷新如实呈现。
      if (get().qqAccessSaving || get().qqGroupConfigSaving) return false;
      set({ qqAccessSaving: true, error: null, feedback: "" });
      invalidateAccessReads();
      try {
        // 方案切换的显式决定（keep/reset, ADR0019 §13.2 G）与绑定补丁走同一个 PUT；字段已是
        // 真实 public 类型，缺省不携带＝这不是一次「移动到其他方案」的保存，不伪造决定。
        const saved = await get().apiClient.updateQqBinding(binding.id, {
          ...patch,
          ...(patch.scheme_change ? { scheme_change: patch.scheme_change } : {}),
          expected_revision: binding.revision,
        });
        // 已知自身的写结果：只推进本群配置编辑器持有的 binding 基线（行/Agent/方案未变时），
        // 不重读、不覆盖未保存的草稿；换方案/改绑由 sync 自己拒绝，留给 CAS 如实冲突后显式刷新。
        get().syncQqGroupConfigBinding(saved);
        await reload();
        refreshSchemeUsage();
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
      invalidateAccessReads();
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
