import type {
  AgentKnowledge,
  AgentKnowledgeReadConfig,
  AgentKnowledgeReadSettings,
  KnowledgeCategory,
  KnowledgeDocument,
  KnowledgeDocumentDetail,
  KnowledgeSettings,
} from "../../../shared/contracts/knowledge";

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
      context_budget: number;
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
export type KnowledgeSaveScope = "all" | "model" | "rules";
export function knowledgeModelDirty(
  editor: KnowledgeModelEditor | null,
  scope: KnowledgeSaveScope = "all",
): boolean {
  if (!editor) return false;
  const model = editor.modelName !== editor.source.model_name;
  const rules =
    (editor.autoEnabled ?? editor.source.auto_enabled) !== editor.source.auto_enabled ||
    (editor.contextBudget ?? editor.source.context_budget) !== editor.source.context_budget;
  return scope === "model" ? model : scope === "rules" ? rules : model || rules;
}
export interface OrganizationEditor {
  token: object;
  source: import("../../../shared/contracts/organization").OrganizationSettings;
  modelName: string | null;
}
export function organizationDirty(editor: OrganizationEditor | null): boolean {
  return !!editor && editor.modelName !== editor.source.model_name;
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
  discardKnowledgeModel: () => void;
  knowledgeCategories: KnowledgeCategory[];
  knowledgeDocuments: KnowledgeDocument[];
  knowledgeSettings: KnowledgeSettings | null;
  knowledgeEditor: KnowledgeEditor | null;
  knowledgeDirty: boolean;
  knowledgeBusy: boolean;
  knowledgeLoading: boolean;
  knowledgeReadId: number;
  loadKnowledge: () => Promise<void>;
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
  knowledgeSettings: null as KnowledgeSettings | null,
  knowledgeEditor: null as KnowledgeEditor | null,
  knowledgeDirty: false,
  knowledgeBusy: false,
  knowledgeLoading: false,
  knowledgeReadId: 0,
};
