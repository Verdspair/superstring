import { vi } from "vitest";
import {
  AgentResponseSchema,
  type MemoryContentResponse,
  type MemoryEntryResponse,
  PersonaResponseSchema,
} from "../../../src/shared/contracts";
import type { KnowledgeDocumentDetail } from "../../../src/shared/contracts/knowledge";
import type { QqBindingResponse, QqStickerAssetResponse } from "../../../src/shared/contracts/qq";
import { api } from "../../../src/web/api";
import { newPageEditor } from "../../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../../src/web/i18n";
import { useSuperstringStore as store } from "../../../src/web/store";
export const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  D = "33333333-3333-4333-8333-333333333333",
  M = "44444444-4444-4444-8444-444444444444",
  S = "55555555-5555-4555-8555-555555555555";
const now = "2026-09-25T00:00:00.000Z";
export const agent = AgentResponseSchema.parse({
  id: A,
  name: "Agent A",
  model_name: "model-a",
  config_version: 1,
  persona_intensity: 60,
  created_at: now,
  updated_at: now,
});
export const persona = PersonaResponseSchema.parse({
  id: B,
  agent_id: A,
  core_identity: "",
  communication_style: "",
  interaction_boundaries: "",
  example_dialogues: "",
  advanced_instructions: "",
  created_at: now,
  updated_at: now,
});
export const policy = { auto_enabled: true, every_turns: 20, target_chars: 1200, version: 1 };
export const memory: MemoryEntryResponse = {
  id: M,
  name: "Memory one",
  summary: "Apple preference",
  tags: ["food"],
  kinds: [],
  body: "Original memory",
  status: "active",
  scope: "reality_user",
  scope_key: A,
  created_at: now,
  config_snapshot: { model: "model-a" },
};
export const memoryContent: MemoryContentResponse = {
  content: {
    id: M,
    source_type: "memory",
    content_origin: "derived",
    name: memory.name,
    summary: memory.summary,
    tags: memory.tags,
    body: memory.body,
    revision: "a".repeat(64),
    sources: [],
    validity: "valid",
  },
  status: "active",
  corrected: false,
  retired: false,
  source_messages: [],
};
export const document: KnowledgeDocumentDetail = {
  id: D,
  category_id: "default",
  name: "Reference",
  import_type: "md",
  content_mode: "original",
  content_version: 1,
  revision: 3,
  created_at: now,
  updated_at: now,
  agent_ids: [A],
  summary: "Reference summary",
  tags: ["guide"],
  organization_status: "succeeded",
  error_code: null,
  original_text: "# Exact original\r\n",
  draft: null,
  content: {
    id: D,
    source_type: "knowledge",
    content_origin: "original",
    name: "Reference",
    summary: "Reference summary",
    tags: [],
    body: "# Exact original\r\n",
    revision: "v1",
    sources: [],
    validity: "valid",
  },
};
export const sticker: QqStickerAssetResponse = {
  id: S,
  name: "Smile",
  description: "A warm smile",
  description_draft: null,
  tags: ["happy"],
  tags_draft: [],
  usage_note: null,
  media_type: "image",
  byte_size: 1024,
  width: 64,
  height: 64,
  enabled: false,
  collection_ids: [D],
  created_at: now,
  updated_at: now,
};
export const binding: QqBindingResponse = {
  id: B,
  account_id: "10001",
  kind: "private",
  peer_id: "20002",
  agent_id: A,
  scheme_id: D,
  paused: false,
  triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
  share_web_memory: false,
  memory_batch_size: 20,
  pending_observations: 4,
  revision: 2,
  authority_revision: 1,
  attention: { mode: "off", members: [] },
};
export const scopeKey = JSON.stringify([
  "qq",
  binding.account_id,
  binding.kind,
  binding.peer_id,
  A,
]);
export function setupLibrary(overrides: Partial<typeof api> = {}) {
  const client = {
    ...api,
    getAgent: vi.fn().mockImplementation(async (id: string) => ({
      ...agent,
      id,
      name: id === A ? "Agent A" : "Agent B",
    })),
    getPersona: vi.fn().mockResolvedValue(persona),
    listAgents: vi.fn().mockResolvedValue([agent]),
    getPolicy: vi.fn().mockResolvedValue(policy),
    listMemorySessions: vi.fn().mockResolvedValue([{ id: S, title: "Conversation one" }]),
    listMemoryJobs: vi.fn().mockResolvedValue([]),
    listMemoryTurns: vi.fn().mockResolvedValue({
      scope: "reality_user",
      turns: [{ id: D, sequence_no: 1, user: "Question", assistant: "Answer", processed: false }],
    }),
    listMemoryEntries: vi.fn().mockResolvedValue({ items: [memory], total: 1 }),
    getMemoryEntry: vi.fn().mockResolvedValue(memory),
    getMemoryContent: vi.fn().mockResolvedValue(memoryContent),
    correctMemory: vi.fn().mockResolvedValue({ ...memoryContent, corrected: true }),
    listMemoryScopes: vi.fn().mockResolvedValue([
      {
        scope_key: A,
        count: 1,
        active_count: 1,
        read_scope_keys: [A],
        write_scope_key: A,
        pending: null,
        binding: null,
        latest_job: null,
      },
      {
        scope_key: scopeKey,
        count: 1,
        active_count: 1,
        read_scope_keys: [scopeKey],
        write_scope_key: scopeKey,
        pending: 4,
        binding: { id: B, revision: 2, memory_batch_size: 20, paused: false, enabled: true },
        latest_job: null,
      },
    ]),
    getQqOwner: vi
      .fn()
      .mockResolvedValue({ configured: true, account_id: "10001", peer_id: "20002", revision: 1 }),
    listQqBindings: vi.fn().mockResolvedValue([binding]),
    updateQqBinding: vi.fn().mockResolvedValue({ ...binding, revision: 3 }),
    getQqSettings: vi.fn().mockResolvedValue(null),
    getQqStatus: vi.fn().mockResolvedValue(null),
    listQqConversations: vi.fn().mockResolvedValue([]),
    listQqSchemes: vi.fn().mockResolvedValue([]),
    organiseQqMemory: vi.fn().mockResolvedValue({ status: "queued", job_id: D, pending: 4 }),
    getAgentKnowledgeRead: vi.fn().mockResolvedValue({
      revision: 1,
      config: { enabled: true, context_budget: null, scope: "all", document_ids: [] },
    }),
    listAgentKnowledge: vi.fn().mockResolvedValue([document]),
    getKnowledgeSettings: vi.fn().mockResolvedValue({
      revision: 1,
      auto_enabled: true,
      model_name: null,
      context_budget: 2048,
    }),
    listKnowledgeCategories: vi
      .fn()
      .mockResolvedValue([{ id: "default", name: "General", revision: 1, document_count: 1 }]),
    listKnowledgeDocuments: vi.fn().mockResolvedValue([document]),
    getKnowledgeDocument: vi.fn().mockResolvedValue(document),
    updateKnowledgeDocument: vi.fn().mockResolvedValue(document),
    saveKnowledgeGrants: vi.fn().mockResolvedValue(document),
    listQqStickerAssets: vi.fn().mockResolvedValue([sticker]),
    listQqStickerCollections: vi
      .fn()
      .mockResolvedValue([
        { id: D, name: "Reactions", description: null, revision: 1, asset_count: 1 },
      ]),
    getQqStickerImpact: vi
      .fn()
      .mockResolvedValue({ asset_id: S, collection_ids: [D], schemes: [], bindings: [] }),
    updateQqStickerAsset: vi
      .fn()
      .mockImplementation(async (_id, body) => ({ ...sticker, ...body })),
    setQqStickerCollections: vi.fn().mockResolvedValue(sticker),
    setQqStickerEnabled: vi
      .fn()
      .mockImplementation(async (_id, enabled) => ({ ...sticker, enabled })),
    getDesktopSettings: vi.fn().mockResolvedValue({ close_action: "background", revision: 1 }),
    updateDesktopSettings: vi.fn().mockResolvedValue({ close_action: "exit", revision: 2 }),
    getOrganizationSettings: vi.fn().mockResolvedValue({
      revision: 1,
      model_name: "default-model",
      vision_model_name: null,
      transcription_model_name: null,
    }),
    ...overrides,
  };
  store.getState().resetForTests(client);
  selectLocale("zh-CN");
  store.setState({
    status: "ready",
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "basic",
    agents: [agent, { ...agent, id: B, name: "Agent B" }],
    editorAgentId: A,
    pageEditor: newPageEditor(agent, persona, policy),
    editorDraft: { ...newPageEditor(agent, persona, policy).draft },
    persona,
    policy,
    modelNames: ["model-a", "model-b"],
    loadedModelNames: ["model-a"],
    refreshModels: vi.fn().mockResolvedValue(undefined),
    refreshCapacityPreview: vi.fn().mockResolvedValue(undefined),
    qqBindings: [binding],
  });
  return client;
}
