// QQ sticker library surface state (ADR0018 §9.2, P5d).
//
// The library is a QQ-GLOBAL resource (§11.1): it does not follow the assistant currently being
// configured, so this slice has no agent scope and no page-draft machinery. What it does have is
// one asset's editable content — and only the content: `enabled` is not part of the editor,
// because §9.2's "保存整理" must not be able to switch an asset on by accident.

import {
  QQ_RETENTION_MAX_DAYS,
  QQ_RETENTION_MIN_DAYS,
  type QqBindingResponse,
  type QqConversationListItem,
  type QqMemoryOrganiseResponse,
  type QqSchemeCompression,
  type QqSchemeContext,
  type QqSchemeMediaInput,
  type QqSchemeMessageSettings,
  type QqSchemeOutputReserve,
  type QqSchemePrompts,
  type QqSchemeReply,
  type QqSchemeResponse,
  type QqSchemeRhythm,
  type QqSchemeStickers,
  type QqSettingsResponse,
  type QqSpeechTriggers,
  type QqStatusResponse,
  type QqStickerAssetResponse,
  type QqStickerCollectionResponse,
  type QqStickerImpactResponse,
  type QqStorageUsageResponse,
} from "../../../shared/contracts/qq";
import type {
  QqConversationKind,
  QqStorageCategory,
  QqStorageCleanupRequest,
  QqStorageCleanupSelectionResponse,
  QqStorageItem,
  QqStorageSettingsResponse,
  QqStorageStatusFilter,
} from "../../../shared/contracts/qq-storage";

export interface QqStickerEditor {
  /** The row this editor was opened from; the save compares against it, not against the list. */
  source: QqStickerAssetResponse;
  name: string;
  description: string;
  /** Held as the field's text; §9.2's tags are a list, so it is split on save. */
  tags: string;
  usageNote: string;
  /** The whole membership set (§9.1), so removing a collection is expressible. */
  collectionIds: string[];
}

export function qqStickerEditorFrom(asset: QqStickerAssetResponse): QqStickerEditor {
  return {
    source: asset,
    name: asset.name,
    description: asset.description ?? "",
    tags: asset.tags.join("、"),
    usageNote: asset.usage_note ?? "",
    collectionIds: [...asset.collection_ids],
  };
}

/** Split the tag field; both comma styles are accepted because the input is free text. */
export function qqStickerEditorTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[、,，]/)
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ""),
    ),
  ];
}

export function qqStickerEditorDirty(editor: QqStickerEditor | null): boolean {
  if (!editor) return false;
  const source = editor.source;
  const sameSet =
    editor.collectionIds.length === source.collection_ids.length &&
    editor.collectionIds.every((id) => source.collection_ids.includes(id));
  return (
    editor.name.trim() !== source.name ||
    editor.description.trim() !== (source.description ?? "") ||
    qqStickerEditorTags(editor.tags).join("\u0000") !== source.tags.join("\u0000") ||
    editor.usageNote.trim() !== (source.usage_note ?? "") ||
    !sameSet
  );
}

/** One import's answer, kept in state so the page can say which reason applied (§9.2). */
export type QqStickerImportNotice =
  | { readonly kind: "imported"; readonly name: string }
  | {
      readonly kind: "rejected";
      readonly reason: "empty" | "unsupported_format" | "truncated_header" | "invalid_dimensions";
    };

export interface QqStickerState {
  qqStickerCollections: QqStickerCollectionResponse[];
  qqStickerAssets: QqStickerAssetResponse[];
  qqStickerLoading: boolean;
  qqStickerSaving: boolean;
  /** A monotonically increasing read id, so a late response cannot overwrite a newer one. */
  qqStickerReadId: number;
  qqStickerEditor: QqStickerEditor | null;
  /** Who a saved selection or an enablement reaches (§9.1: the surface must show it). */
  qqStickerImpact: QqStickerImpactResponse | null;
  qqStickerImportNotice: QqStickerImportNotice | null;
  loadQqStickers: () => Promise<void>;
  openQqStickerEditor: (id: string) => void;
  closeQqStickerEditor: () => void;
  patchQqStickerEditor: (patch: Partial<Omit<QqStickerEditor, "source">>) => void;
  saveQqStickerEditor: (options?: { readonly enableAfterSave: boolean }) => Promise<boolean>;
  setQqStickerEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  importQqStickerFile: (file: File) => Promise<boolean>;
  /** §9.2's batch selection: ids only, cleared by a successful batch and by leaving the page. */
  qqStickerSelection: string[];
  setQqStickerSelection: (ids: string[]) => void;
  bulkUpdateQqStickers: (input: {
    readonly addCollectionIds?: readonly string[];
    readonly removeCollectionIds?: readonly string[];
    readonly tags?: { readonly add?: readonly string[]; readonly remove?: readonly string[] };
    readonly enabled?: boolean;
  }) => Promise<boolean>;
  /** §9.2's 生成说明和标签: one call, two drafts, and the verdict the page renders. */
  annotateQqSticker: (
    assetId: string,
  ) => Promise<
    { readonly kind: "annotated" } | { readonly kind: "rejected"; readonly reason: string }
  >;
  /** Scheme names the selected assets would reach; null until asked (§9.1's impact display). */
  qqStickerBatchImpact: string[] | null;
  loadQqStickerBatchImpact: () => Promise<void>;
  /**
   * `description` 是集合的可空简介（契约 `max(2000)`）。创建时缺省＝没有简介；
   * 修改时 `undefined`＝本次不改动（服务端保留已存值，绝不把「没改」变成清空），
   * `null` 或空白＝清除。
   */
  createQqStickerCollection: (name: string, description?: string | null) => Promise<boolean>;
  renameQqStickerCollection: (
    id: string,
    name: string,
    expectedRevision: number,
    description?: string | null,
  ) => Promise<boolean>;
  clearQqStickerImportNotice: () => void;
}

export const qqStickerInitial = {
  qqStickerCollections: [] as QqStickerCollectionResponse[],
  qqStickerAssets: [] as QqStickerAssetResponse[],
  qqStickerLoading: false,
  qqStickerSaving: false,
  qqStickerReadId: 0,
  qqStickerEditor: null as QqStickerEditor | null,
  qqStickerImpact: null as QqStickerImpactResponse | null,
  qqStickerImportNotice: null as QqStickerImportNotice | null,
  qqStickerSelection: [] as string[],
  qqStickerBatchImpact: null as string[] | null,
};

// ---- QQ 聊天方案 (ADR0018 §5.2/§11.2, P5f) ------------------------------------------------
//
// A scheme is a QQ-GLOBAL named resource, so this editor is one scheme's whole parameter set
// (§11.2: "修改多个分组（共用一份草稿）"). Every group travels together in the draft because
// saving half a scheme is a scheme nobody can reason about; the API's compare-and-swap on
// `revision` is what keeps a stale editor from overwriting someone else's save.

export interface QqSchemeEditor {
  source: QqSchemeResponse;
  name: string;
  description: string;
  triggers: QqSpeechTriggers;
  rhythm: QqSchemeRhythm;
  context: QqSchemeContext;
  compression: QqSchemeCompression;
  outputReserve: QqSchemeOutputReserve;
  stickers: QqSchemeStickers;
  stickerCollectionIds: string[];
  prompts: QqSchemePrompts;
  reply: QqSchemeReply;
  /** 0052 消息设置组（引用模式、层数、时间模式、时区）；API 持久键仍是 message_settings。 */
  messageSettings: QqSchemeMessageSettings;
  /** 0052 图片输入组（模式、阶段、图数、规格）；stages 深复制，API 持久键仍是 media_input。 */
  mediaInput: QqSchemeMediaInput;
}

export function qqSchemeEditorFrom(scheme: QqSchemeResponse): QqSchemeEditor {
  return {
    source: scheme,
    name: scheme.name,
    description: scheme.description ?? "",
    triggers: { ...scheme.triggers },
    rhythm: { ...scheme.rhythm },
    context: { ...scheme.context },
    compression: { ...scheme.compression },
    outputReserve: { ...scheme.output_reserve },
    stickers: { ...scheme.stickers },
    stickerCollectionIds: [...scheme.sticker_collections.collection_ids],
    prompts: { ...scheme.prompts },
    reply: { ...scheme.reply },
    messageSettings: { ...scheme.message_settings },
    // stages 的三个布尔是嵌套对象：浅复制会让编辑写到目录行上，必须逐叶子新建。
    mediaInput: {
      ...scheme.media_input,
      stages: { ...scheme.media_input.stages },
    },
  };
}

export function qqSchemeDirty(editor: QqSchemeEditor | null): boolean {
  return qqSchemeChanges(editor).length > 0;
}

export interface QqSchemeChange {
  /** `group.field` — the page turns this into a label; the rule stays language-free. */
  readonly field: string;
  /** Text as stored; a boolean arrives as the language-neutral `true`/`false`. */
  readonly before: string;
  readonly after: string;
}

/**
 * What a save would change, field by field (§11.2's 预览变更).
 *
 * Only real differences are listed: a page that showed unchanged rows would turn "nothing to
 * save" into "everything is about to change" and make the preview useless.
 */
export function qqSchemeChanges(editor: QqSchemeEditor | null): readonly QqSchemeChange[] {
  if (!editor) return [];
  const changes: QqSchemeChange[] = [];
  // Language-neutral on purpose: a boolean reads as `true`/`false` here, and only the page knows
  // which fields really are switches — so only it renders on/off labels, and a text value that
  // happens to read "true" or "开" is never translated.
  const text = (value: unknown) => String(value);
  const compare = (field: string, before: unknown, after: unknown) => {
    if (text(before) !== text(after))
      changes.push({ field, before: text(before), after: text(after) });
  };
  compare("name", editor.source.name, editor.name.trim());
  compare("description", editor.source.description ?? "", editor.description.trim());
  for (const key of Object.keys(editor.triggers) as (keyof QqSpeechTriggers)[]) {
    compare(`triggers.${key}`, editor.source.triggers[key], editor.triggers[key]);
  }
  for (const key of Object.keys(editor.rhythm) as (keyof QqSchemeRhythm)[]) {
    compare(`rhythm.${key}`, editor.source.rhythm[key], editor.rhythm[key]);
  }
  for (const key of Object.keys(editor.context) as (keyof QqSchemeContext)[]) {
    compare(`context.${key}`, editor.source.context[key], editor.context[key]);
  }
  for (const key of Object.keys(editor.compression) as (keyof QqSchemeCompression)[]) {
    compare(`compression.${key}`, editor.source.compression[key], editor.compression[key]);
  }
  for (const key of Object.keys(editor.outputReserve) as (keyof QqSchemeOutputReserve)[]) {
    compare(`output_reserve.${key}`, editor.source.output_reserve[key], editor.outputReserve[key]);
  }
  for (const key of Object.keys(editor.stickers) as (keyof QqSchemeStickers)[]) {
    compare(`stickers.${key}`, editor.source.stickers[key], editor.stickers[key]);
  }
  compare(
    "sticker_collections.collection_ids",
    [...editor.source.sticker_collections.collection_ids].sort().join("、"),
    [...editor.stickerCollectionIds].sort().join("、"),
  );
  for (const key of Object.keys(editor.prompts) as (keyof QqSchemePrompts)[]) {
    compare(`prompts.${key}`, editor.source.prompts[key], editor.prompts[key].trim());
  }
  compare(
    "reply.split_by_speaker",
    editor.source.reply.split_by_speaker,
    editor.reply.split_by_speaker,
  );
  // 0052 两组：逐叶子比较，stages 的三个布尔逐项展开（不能 String(object) 比较）。
  compare(
    "message_settings.reply_mode",
    editor.source.message_settings.reply_mode,
    editor.messageSettings.reply_mode,
  );
  compare(
    "message_settings.reply_depth",
    editor.source.message_settings.reply_depth,
    editor.messageSettings.reply_depth,
  );
  compare(
    "message_settings.time_display",
    editor.source.message_settings.time_display,
    editor.messageSettings.time_display,
  );
  compare(
    "message_settings.timezone",
    editor.source.message_settings.timezone,
    editor.messageSettings.timezone,
  );
  compare("media_input.mode", editor.source.media_input.mode, editor.mediaInput.mode);
  for (const phase of ["decision", "evaluation", "generation"] as const) {
    compare(
      `media_input.stages.${phase}`,
      editor.source.media_input.stages[phase],
      editor.mediaInput.stages[phase],
    );
  }
  compare(
    "media_input.max_images",
    editor.source.media_input.max_images,
    editor.mediaInput.max_images,
  );
  compare(
    "media_input.ordinary_still_max_dimension",
    editor.source.media_input.ordinary_still_max_dimension,
    editor.mediaInput.ordinary_still_max_dimension,
  );
  compare(
    "media_input.expression_max_dimension",
    editor.source.media_input.expression_max_dimension,
    editor.mediaInput.expression_max_dimension,
  );
  compare(
    "media_input.expression_frame_count",
    editor.source.media_input.expression_frame_count,
    editor.mediaInput.expression_frame_count,
  );
  compare(
    "media_input.expression_frame_max_dimension",
    editor.source.media_input.expression_frame_max_dimension,
    editor.mediaInput.expression_frame_max_dimension,
  );
  return changes;
}

export type QqSchemeGroupKey =
  | "triggers"
  | "rhythm"
  | "context"
  | "compression"
  | "outputReserve"
  | "stickers"
  | "prompts"
  | "reply"
  /** 0052：消息设置组（引用模式、层数、时间模式、时区）。 */
  | "messageSettings"
  /** 0052：图片输入组（模式、stages、图数、规格）。 */
  | "mediaInput";
/**
 * A patch to one parameter group. Loose on purpose: the grids drive their patches from const
 * tables, so the alternative would be a cast at every field. A key the group does not have is
 * not silently ignored — the save sends the whole group and the contract rejects it.
 * 0052 的可空字段（普通静图长边）可传 null（＝钉住「原图」）。
 */
export type QqSchemeGroupPatch = Record<string, number | boolean | string | null>;

export interface QqSchemeState {
  qqSchemes: QqSchemeResponse[];
  qqSchemesLoading: boolean;
  qqSchemeSaving: boolean;
  qqSchemesReadId: number;
  /** 变更操作的代次：旧操作晚到的响应/错误/finally 据此判定自己是否已被替换。 */
  qqSchemeOperationId: number;
  /** 使用量读取的单调序号：旧失败或旧结果不得覆盖更新的读取。 */
  qqSchemeUsageReadId: number;
  qqSchemeEditor: QqSchemeEditor | null;
  /** How many conversations a delete would affect; read before the confirm, not after. */
  qqSchemeUsage: { readonly schemeId: string; readonly bindings: number } | null;
  /** 使用量读取失败的原因；显式刷新会重读使用量，界面据此给出可重试的说明。 */
  qqSchemeUsageError: string | null;
  loadQqSchemes: () => Promise<void>;
  /** 显式刷新保存基线：重读目录并按字段合并草稿（含非法原值），推进未改字段与 revision，不自动重试保存。 */
  refreshQqScheme: () => Promise<boolean>;
  createQqScheme: (name: string) => Promise<boolean>;
  selectQqScheme: (id: string) => void;
  patchQqScheme: (patch: Partial<Omit<QqSchemeEditor, "source">>) => void;
  patchQqSchemeGroup: (group: QqSchemeGroupKey, patch: QqSchemeGroupPatch) => void;
  saveQqScheme: () => Promise<boolean>;
  duplicateQqScheme: (name: string) => Promise<boolean>;
  deleteQqScheme: (id: string) => Promise<boolean>;
  discardQqSchemeChanges: () => void;
}

// ---- QQ 存储管理 (§11.1's 存储与诊断, P5h) ---------------------------------------------------
//
// 管理面由两块组成：保留设置（与 qq_settings 其余字段共用同一 revision 的比较交换）与手动清理
// 工作区（类别/筛选/游标分页 + 预览→确认→结果）。保留窗口只影响之后写入的记录；物理删除永远
// 只由显式确认的清理执行，所以这里没有自动策略开关。

/** 保留设置草稿：`days` 是输入框的数字原文，`source` 是最近一次读取/保存的保存基线。 */
export interface QqStorageSettingsDraft {
  source: QqStorageSettingsResponse;
  days: string;
}

/** 管理列表一页 50 条；与服务端默认一致，翻页只用服务端游标。 */
export const QQ_STORAGE_PAGE_SIZE = 50;

/** 保留天数输入：1..3650 的整数原文（空/小数/越界都无效）。 */
export function qqStorageDaysValid(days: string): boolean {
  if (!/^\d+$/.test(days)) return false;
  const value = Number(days);
  return value >= QQ_RETENTION_MIN_DAYS && value <= QQ_RETENTION_MAX_DAYS;
}

/** 草稿相对基线改没改；非法输入算改动（保存前必须先修正，不得当作未改而跟随基线）。 */
export function qqStorageDaysChanged(days: string, baseline: number): boolean {
  return !qqStorageDaysValid(days) || Number(days) !== baseline;
}

/** 清理工作区的列表查询：类别/状态/会话过滤，`cursor` 为服务端游标（null＝第一页）。 */
export interface QqStorageItemsQuery {
  category: QqStorageCategory;
  status: QqStorageStatusFilter;
  kind: QqConversationKind | null;
  peerId: string;
  cursor: string | null;
}

/** 可勾选清理的行：已到期且未被保全规则保护；其余行不可选。 */
export function qqStorageItemCleanable(item: QqStorageItem): boolean {
  return item.expired && !item.protected;
}

export interface QqStorageState {
  qqStorageUsage: QqStorageUsageResponse | null;
  qqStorageSettings: QqStorageSettingsResponse | null;
  qqStorageLoading: boolean;
  qqStorageSaving: boolean;
  /** 摘要+设置读取的单调序号：旧响应或旧失败不得覆盖更新的读取。 */
  qqStorageReadId: number;
  /** 管理列表（当前查询）的条目与分页信息。 */
  qqStorageItems: QqStorageItem[];
  qqStorageItemsTotal: number;
  qqStorageItemsNextCursor: string | null;
  qqStorageItemsLoading: boolean;
  qqStorageItemsError: string | null;
  /** 管理列表读取的单调序号：旧页面晚到不得覆盖新查询。 */
  qqStorageItemsReadId: number;
  /** 清理工作区：预览时冻结的请求快照（确认执行的正是这一份），以及预览/结果/错误。 */
  qqStorageCleanupRequest: QqStorageCleanupRequest | null;
  qqStorageCleanupPreview: QqStorageCleanupSelectionResponse | null;
  qqStorageCleanupResult: QqStorageCleanupSelectionResponse | null;
  qqStorageCleanupError: string | null;
  /** 清理操作的代次：卸载或换查询后，旧响应/旧错误不得落地。 */
  qqStorageCleanupOperationId: number;
  /** 隐式读取：只读摘要与设置，绝不自动推进保留设置草稿的保存基线。 */
  loadQqStorage: () => Promise<void>;
  /** 显式刷新：重读摘要与设置，并按字段合并草稿——已改天数保留原文，未改字段与 revision 跟随新基线。 */
  refreshQqStorage: () => Promise<void>;
  /** 独立保存保留设置：只发 storage 的 PUT，不携带方案/连接等其他草稿；409 时草稿原样保留。 */
  saveQqStorageSettings: () => Promise<boolean>;
  /** 管理列表读取；组件卸载时经 AbortSignal 取消，迟到响应不落地。 */
  loadQqStorageItems: (
    query: QqStorageItemsQuery,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<void>;
  /** 预览（零写入）：冻结请求快照并读 matched/expired/protected/removable。 */
  previewQqStorageCleanup: (request: QqStorageCleanupRequest) => Promise<boolean>;
  /** 执行：用预览时冻结的快照，恰好确认一次；成功后重读摘要，失败保留预览以便原样重试。 */
  runQqStorageCleanupSelection: () => Promise<boolean>;
  /** 关闭/卸载：作废在途清理操作并清空request/预览/结果/错误。 */
  clearQqStorageCleanup: () => void;
}

export const qqStorageInitial = {
  qqStorageUsage: null as QqStorageUsageResponse | null,
  qqStorageSettings: null as QqStorageSettingsResponse | null,
  qqStorageLoading: false,
  qqStorageSaving: false,
  qqStorageReadId: 0,
  qqStorageItems: [] as QqStorageItem[],
  qqStorageItemsTotal: 0,
  qqStorageItemsNextCursor: null as string | null,
  qqStorageItemsLoading: false,
  qqStorageItemsError: null as string | null,
  qqStorageItemsReadId: 0,
  qqStorageCleanupRequest: null as QqStorageCleanupRequest | null,
  qqStorageCleanupPreview: null as QqStorageCleanupSelectionResponse | null,
  qqStorageCleanupResult: null as QqStorageCleanupSelectionResponse | null,
  qqStorageCleanupError: null as string | null,
  qqStorageCleanupOperationId: 0,
};

export const qqSchemeInitial = {
  qqSchemes: [] as QqSchemeResponse[],
  qqSchemesLoading: false,
  qqSchemeSaving: false,
  qqSchemesReadId: 0,
  qqSchemeOperationId: 0,
  qqSchemeUsageReadId: 0,
  qqSchemeEditor: null as QqSchemeEditor | null,
  qqSchemeUsage: null as { readonly schemeId: string; readonly bindings: number } | null,
  qqSchemeUsageError: null as string | null,
};

// 第三方App接入 (§11.1, P5q): the connection, the conversations the intake has actually seen, and
// the bindings that tie a conversation to an assistant and a scheme. The switch lives here as a
// quick field AND on 运行模式 as the master one — one value, two surfaces, both compare-and-swap.
export interface QqAccessState {
  qqSettings: QqSettingsResponse | null;
  qqConnection: QqStatusResponse["connection"] | null;
  qqConversations: QqConversationListItem[];
  qqBindings: QqBindingResponse[];
  /** Whether the bindings list has been read at least once (the 长期记忆 hint reads it too). */
  qqBindingsLoaded: boolean;
  /** 绑定读取的单调序号：晚到的旧读取不得覆盖更新的读取。 */
  qqBindingsReadId: number;
  /** 绑定读取进行中；显式刷新会把它抬起来供目录显示。 */
  qqBindingsLoading: boolean;
  /** 显式刷新绑定的失败原因；null＝最近一次读取成功或尚未显式刷新过。 */
  qqBindingsError: string | null;
  qqAccessLoading: boolean;
  qqAccessSaving: boolean;
  loadQqAccess: () => Promise<void>;
  /**
   * Bindings only, without the rest of the access page (2026-09-25). The 长期记忆 page needs to
   * know whether the assistant being edited is bound to any QQ conversation, and pulling the whole
   * page's four requests for one hint would be the wrong trade.
   *
   * No argument keeps the cache behavior: a successful read is reused (no refetch) and a failed
   * read stays silent. `refresh = true` forces a real list request for the 目录刷新 and the usage
   * session; on failure it records `qqBindingsError` with `qqBindingsLoaded = false`, so counts
   * read as unknown rather than 0.
   */
  loadQqBindings: (refresh?: boolean) => Promise<void>;
  /**
   * 绑定目录最小读取：设置、会话、绑定与方案一次读齐，不读连接状态。绑定管理视图（方案详情的
   * 「使用会话」与全局会话绑定页）用这一条，而不是 loadQqAccess 的整页读取。保存进行中不开始
   * 读取；带 API 身份、读取代次与重置令牌校验，旧响应不得落地；失败按「未知」呈现
   * （Loaded=false + Error）以便重试，不让缓存列表继续参与操作。方案目录行经方案模块的
   * 合并/保护路径落地，不直接覆盖正在保存的目录。
   *
   * `bindingId` 只在显式「刷新保存基线」（绑定编辑抽屉的按钮）时给出：读取成功后按字段合并该
   * 绑定的编辑草稿——choices/attention/记忆整理条数的已改字段保留（含非法/空输入原文），未改
   * 字段与 revision 跟随新基线；不传参数时绝不刷新任何草稿基线。
   */
  loadQqBindingDirectory: (bindingId?: string) => Promise<void>;
  /**
   * Settings only, without the rest of the access page (2026-09-25). The default-model page shows
   * the QQ judgement model, and pulling the access page's four requests for one select would be the
   * wrong trade. Unlike the bindings read this one always refetches: it is a surface the user can
   * save from, so a stale revision is a real failure mode rather than a quiet hint.
   */
  loadQqSettings: () => Promise<void>;
  /**
   * The QQ-global judgement model (0038, ): one choice for the whole QQ side,
   * saved immediately because it is a single select rather than a page of fields.
   */
  saveQqJudgementModel: (modelName: string | null) => Promise<boolean>;
  /**
   * 连接页的唯一刷新：重读接入设置与连接状态。草稿已改字段保留输入、未改字段跟随新基线并推进
   * revision，冲突（409）后刷新即可重试；失败保留草稿与旧状态，页面给出可重试的失败态。
   */
  refreshQqConnection: () => Promise<void>;
  saveQqSurface: (
    patch: {
      enabled?: boolean;
      account_id?: string | null;
      endpoint?: string | null;
      token?: string | null;
    },
    expectedRevision?: number,
  ) => Promise<boolean>;
  bindQqConversation: (input: {
    conversation: QqConversationListItem;
    agentId: string;
    schemeId: string;
  }) => Promise<boolean>;
  /**
   * The manual binding entry (2026-09-25): bind a group or private chat by its number, without an
   * observation. It exists because an unbound conversation's messages are not recorded, so the
   * observed list can never offer the first binding of a conversation nobody has spoken in yet.
   */
  bindQqPeerNumber: (input: {
    kind: QqBindingResponse["kind"];
    peerId: string;
    agentId: string;
    schemeId: string;
  }) => Promise<boolean>;
  updateQqBindingRow: (
    binding: QqBindingResponse,
    patch: {
      agent_id?: string;
      scheme_id?: string;
      paused?: boolean;
      /** §0.6/F05's module switches; the whole group travels, null means "follow the scheme". */
      triggers?: QqBindingResponse["triggers"];
      /** 「重要的人」(0031): the whole list travels; `off` clears mode and members together. */
      attention?: QqBindingResponse["attention"];
      /** 记忆整理（2026-09-25）：攒够多少条观察自动整理一次；`null`＝关。 */
      memory_batch_size?: number | null;
      /**
       * 改绑且目标方案自带本群覆盖时的显式决定（ADR0019 §13.2 G）：`keep` 保留覆盖、`reset`
       * 回到方案基线；缺省＝这不是一次「移动到其他方案」的保存，服务端不做方案切换处理。
       */
      scheme_change?: "keep" | "reset";
    },
  ) => Promise<boolean>;
  /**
   * 「立即整理」(2026-09-25): ask the server to organise this conversation's pending observations
   * now, and say what actually happened (the verdict is not an error). Returns the verdict so the
   * row can show its own line instead of a global toast.
   */
  organiseQqMemoryRow: (binding: QqBindingResponse) => Promise<QqMemoryOrganiseResponse | null>;
}

export const qqAccessInitial = {
  qqSettings: null as QqSettingsResponse | null,
  qqConnection: null as QqStatusResponse["connection"] | null,
  qqConversations: [] as QqConversationListItem[],
  qqBindings: [] as QqBindingResponse[],
  qqBindingsLoaded: false,
  qqBindingsReadId: 0,
  qqBindingsLoading: false,
  qqBindingsError: null as string | null,
  qqAccessLoading: false,
  qqAccessSaving: false,
};

// ---- 本群配置 ------------------------------------------------------------------------------
// 编辑态、稀疏改写的合并与动作都在 group-config-state.ts（含 initial）；这里转出类型，
// 供单 store 装配与页面引用同一份契约。
export type {
  QqGroupConfigChange,
  QqGroupConfigEditor,
  QqGroupConfigGroupKey,
  QqGroupConfigPatchValue,
  QqGroupConfigState,
} from "./group-config-state";
