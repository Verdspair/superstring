import type {
  AgentKnowledge,
  AgentKnowledgeReadConfig,
  AgentKnowledgeReadSettings,
  KnowledgeCategory,
  KnowledgeDocument,
  KnowledgeDocumentDetail,
  KnowledgeDocumentsQuery,
  KnowledgeOrganizationStatus,
  KnowledgeSettings,
} from "../../../shared/contracts/knowledge";

/** 资料列表每页条数：服务端默认同为 50（1..100），界面翻页固定按此有界取页。 */
export const KNOWLEDGE_PAGE_SIZE = 50;
/** 资料列表的服务端过滤；空搜索与 "all" 分类/状态都不发过滤字段。 */
export interface KnowledgeListFilters {
  search: string;
  category: string;
  status: string;
}
export const emptyKnowledgeListFilters: KnowledgeListFilters = {
  search: "",
  category: "all",
  status: "all",
};
/** 列表请求只带实际生效的条件：cursor 仅翻页时出现，limit 固定有界。 */
export function knowledgeListQuery(
  filters: KnowledgeListFilters,
  cursor: string | null,
): Partial<KnowledgeDocumentsQuery> {
  return {
    ...(filters.search ? { search: filters.search } : {}),
    ...(filters.category !== "all" ? { category: filters.category } : {}),
    // 状态下拉只提供契约内的枚举值；"all" 在上面已经过滤掉。
    ...(filters.status !== "all" ? { status: filters.status as KnowledgeOrganizationStatus } : {}),
    ...(cursor ? { cursor } : {}),
    limit: KNOWLEDGE_PAGE_SIZE,
  };
}

export type KnowledgeTarget =
  | { kind: "document" | "grants"; id: string }
  | { kind: "import" | "settings" | "category-new" | "none" }
  | { kind: "category"; id: string }
  | { kind: "batch"; ids: string[] };
export type KnowledgeEditor =
  | {
      kind: "import";
      name: string;
      category_id: string;
      original_text: string;
      file: File | null;
    }
  | {
      kind: "document";
      source: KnowledgeDocumentDetail;
      name: string;
      category_id: string;
      original_text: string;
      content_mode: "original" | "draft";
    }
  | { kind: "grants"; source: KnowledgeDocumentDetail; agent_ids: string[] }
  | {
      kind: "settings";
      source: KnowledgeSettings;
      auto_enabled: boolean;
      model_name: string;
      /** 预算不再由资料设置持有（归系统能力→知识查询的全局分组）；仅为旧调用方保留读取形状。 */
      context_budget?: number;
    }
  | { kind: "category-new"; name: string }
  | { kind: "category"; source: KnowledgeCategory; name: string }
  | {
      kind: "batch";
      documents: KnowledgeDocument[];
      agent_id: string;
      granted: boolean;
    };
export interface KnowledgeModelEditor {
  token: object;
  source: KnowledgeSettings;
  modelName: string | null;
  autoEnabled?: boolean;
  contextBudget?: number;
}
/** 保存范围：all 整份草稿；model 仅模型；rules 保留原义（自动整理+预算）；budget 仅预算。 */
export type KnowledgeSaveScope = "all" | "model" | "rules" | "budget";
export function knowledgeModelDirty(
  editor: KnowledgeModelEditor | null,
  scope: KnowledgeSaveScope = "all",
): boolean {
  if (!editor) return false;
  const model = editor.modelName !== editor.source.model_name;
  const auto = (editor.autoEnabled ?? editor.source.auto_enabled) !== editor.source.auto_enabled;
  const budget =
    (editor.contextBudget ?? editor.source.context_budget) !== editor.source.context_budget;
  return scope === "model"
    ? model
    : scope === "rules"
      ? auto || budget
      : scope === "budget"
        ? budget
        : model || auto || budget;
}

/** 全局设置可能同时被资料设置页与默认模型/预算编辑器打开：合并时取修订最新的共享基线。 */
export function latestKnowledgeSettings(
  candidates: (KnowledgeSettings | null | undefined)[],
): KnowledgeSettings | null {
  let best: KnowledgeSettings | null = null;
  for (const item of candidates) if (item && (!best || item.revision > best.revision)) best = item;
  return best;
}
export interface OrganizationEditor {
  token: object;
  source: import("../../../shared/contracts/organization").OrganizationSettings;
  modelName: string | null;
  /** §7.1's media purposes; unset means "cannot understand", never a fallback (P4b). */
  visionModelName: string | null;
  transcriptionModelName: string | null;
}
export function organizationDirty(editor: OrganizationEditor | null): boolean {
  return (
    !!editor &&
    (editor.modelName !== editor.source.model_name ||
      editor.visionModelName !== editor.source.vision_model_name ||
      editor.transcriptionModelName !== editor.source.transcription_model_name)
  );
}
export interface KnowledgeReadEditor {
  token: object;
  agentId: string;
  source: AgentKnowledgeReadSettings;
  draft: AgentKnowledgeReadConfig;
  documents: AgentKnowledge[];
  globalBudget: number;
}
export function knowledgeReadDirty(editor: KnowledgeReadEditor | null): boolean {
  if (!editor) return false;
  const {
    draft,
    source: { config },
  } = editor;
  return (
    draft.enabled !== config.enabled ||
    draft.context_budget !== config.context_budget ||
    draft.scope !== config.scope ||
    JSON.stringify([...draft.document_ids].sort()) !==
      JSON.stringify([...config.document_ids].sort())
  );
}
export interface KnowledgeState {
  organizationEditor: OrganizationEditor | null;
  organizationLoading: boolean;
  organizationError: string | null;
  loadOrganization: (refresh?: boolean) => Promise<void>;
  patchOrganization: (modelName: string | null) => void;
  /** The two media purposes, patched together because they sit in one group on the page. */
  patchOrganizationPurposes: (patch: {
    readonly visionModelName?: string | null;
    readonly transcriptionModelName?: string | null;
  }) => void;
  saveOrganization: () => Promise<boolean>;
  discardOrganization: () => void;
  knowledgeReadEditor: KnowledgeReadEditor | null;
  knowledgeReadLoading: boolean;
  loadKnowledgeRead: () => Promise<void>;
  refreshKnowledgeRead: () => Promise<void>;
  patchKnowledgeRead: (patch: Partial<AgentKnowledgeReadConfig>) => void;
  saveKnowledgeRead: () => Promise<boolean>;
  discardKnowledgeRead: () => void;
  knowledgeModelEditor: KnowledgeModelEditor | null;
  knowledgeModelLoading: boolean;
  loadKnowledgeModel: (refresh?: boolean) => Promise<void>;
  patchKnowledgeModel: (modelName: string | null) => void;
  patchKnowledgeGlobal: (patch: { autoEnabled?: boolean; contextBudget?: number }) => void;
  saveKnowledgeModel: (scope?: KnowledgeSaveScope) => Promise<boolean>;
  /** scope "budget" 只还原预算字段，保留模型与整理草稿；缺省清空整份编辑器。 */
  discardKnowledgeModel: (scope?: "budget") => void;
  knowledgeCategories: KnowledgeCategory[];
  knowledgeDocuments: KnowledgeDocument[];
  /** 列表过滤（搜索/分类/状态）；翻页与刷新沿用，改了过滤即回到第一页。 */
  knowledgeFilters: KnowledgeListFilters;
  /** 已访问页的 keyset cursor 栈：末位即当前页（null = 第一页），上一页出栈。 */
  knowledgeCursors: (string | null)[];
  knowledgeNextCursor: string | null;
  /** 服务端按当前过滤返回的真实总数，不是当前页条数。 */
  knowledgeTotal: number;
  knowledgeSettings: KnowledgeSettings | null;
  knowledgeEditor: KnowledgeEditor | null;
  knowledgeDirty: boolean;
  knowledgeBusy: boolean;
  knowledgeLoading: boolean;
  knowledgeReadId: number;
  /** 不传过滤＝按现有过滤刷新并回第一页；传入则合并过滤、重置游标后取第一页。 */
  loadKnowledge: (filters?: Partial<KnowledgeListFilters>) => Promise<boolean>;
  /** 键集翻页：next 用服务端 next_cursor，prev 出栈回上一页；成功后交回 true。 */
  loadKnowledgePage: (direction: "next" | "prev") => Promise<boolean>;
  requestKnowledgeEditor: (target: KnowledgeTarget) => void;
  openKnowledgeEditor: (target: KnowledgeTarget) => Promise<boolean>;
  updateKnowledgeEditor: (editor: KnowledgeEditor) => void;
  saveKnowledgeEditor: () => Promise<boolean>;
  discardKnowledgeEditor: () => void;
  deleteKnowledgeItem: (
    kind: "document" | "category",
    id: string,
    revision: number,
    moveTo?: string,
  ) => Promise<boolean>;
  setKnowledgeMode: (id: string, mode: "draft" | "original") => Promise<boolean>;
}
export const knowledgeInitial = {
  organizationEditor: null as OrganizationEditor | null,
  organizationLoading: false,
  organizationError: null as string | null,
  knowledgeReadEditor: null as KnowledgeReadEditor | null,
  knowledgeReadLoading: false,
  knowledgeModelEditor: null as KnowledgeModelEditor | null,
  knowledgeModelLoading: false,
  knowledgeCategories: [] as KnowledgeCategory[],
  knowledgeDocuments: [] as KnowledgeDocument[],
  knowledgeFilters: { ...emptyKnowledgeListFilters },
  knowledgeCursors: [null] as (string | null)[],
  knowledgeNextCursor: null as string | null,
  knowledgeTotal: 0,
  knowledgeSettings: null as KnowledgeSettings | null,
  knowledgeEditor: null as KnowledgeEditor | null,
  knowledgeDirty: false,
  knowledgeBusy: false,
  knowledgeLoading: false,
  knowledgeReadId: 0,
};
