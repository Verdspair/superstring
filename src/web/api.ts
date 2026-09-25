import type { z } from "zod";
import {
  type AgentResponse,
  AgentResponseSchema,
  type BrowserStateConfig,
  BrowserStateConfigSchema,
  type CreateModelProviderRequest,
  type DeleteAgentsResponse,
  DeleteAgentsResponseSchema,
  type EntriesList,
  EntriesListSchema,
  ErrorEnvelopeSchema,
  LocalModelCatalogResponseSchema,
  type MemoryContentResponse,
  MemoryContentResponseSchema,
  type MemoryCorrection,
  type MemoryEntryResponse,
  MemoryEntryResponseSchema,
  type MemoryJobView,
  MemoryJobViewSchema,
  MemoryScopeViewSchema,
  type MemorySessionOption,
  MemorySessionOptionSchema,
  type MessageResponse,
  MessageResponseSchema,
  type ModelCapacityResponse,
  ModelCapacityResponseSchema,
  ModelProviderResponseSchema,
  ModelProviderTestResponseSchema,
  type PersonaResponse,
  PersonaResponseSchema,
  type PolicyView,
  PolicyViewSchema,
  type RuntimeConfig,
  RuntimeConfigSchema,
  type SessionResponse,
  SessionResponseSchema,
  type SseEvent,
  SseEventSchema,
  type TurnsList,
  TurnsListSchema,
  type UpdateModelProviderRequest,
} from "../shared/contracts";
import { DesktopSettingsSchema, type DesktopSettingsUpdate } from "../shared/contracts/desktop";
import {
  AgentKnowledgeReadSettingsSchema,
  type AgentKnowledgeReadUpdate,
  AgentKnowledgeSchema,
  type KnowledgeBatchGrant,
  KnowledgeCategorySchema,
  KnowledgeDocumentDetailSchema,
  KnowledgeDocumentSchema,
  type KnowledgeDocumentUpdate,
  type KnowledgeImport,
  KnowledgeSettingsSchema,
  type KnowledgeSettingsUpdate,
} from "../shared/contracts/knowledge";
import {
  OrganizationSettingsSchema,
  type OrganizationSettingsUpdate,
} from "../shared/contracts/organization";
import {
  type CreateQqBindingRequest,
  type CreateQqSchemeRequest,
  type CreateQqStickerCollectionRequest,
  QqBindingResponseSchema,
  QqConversationListItemSchema,
  type QqMemoryOrganiseResponse,
  QqMemoryOrganiseResponseSchema,
  QqOwnerResponseSchema,
  QqSchemeResponseSchema,
  QqSchemeUsageResponseSchema,
  QqSettingsResponseSchema,
  QqStatusResponseSchema,
  type QqStickerAnnotationResponse,
  QqStickerAnnotationResponseSchema,
  QqStickerAssetResponseSchema,
  type QqStickerBulkRequest,
  QqStickerBulkResponseSchema,
  QqStickerCollectionResponseSchema,
  QqStickerImpactResponseSchema,
  type QqStickerImportResponse,
  QqStickerImportResponseSchema,
  QqStorageCleanupResponseSchema,
  QqStorageUsageResponseSchema,
  type ReplaceQqStickerCollectionsRequest,
  type UpdateQqBindingRequest,
  type UpdateQqSchemeRequest,
  type UpdateQqSettingsRequest,
  type UpdateQqStickerCollectionRequest,
  type UpdateQqStickerRequest,
  type UpdateQqTransportRequest,
} from "../shared/contracts/qq";
import { msg } from "./i18n";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function responseError(response: Response): Promise<ApiError> {
  try {
    const parsed = ErrorEnvelopeSchema.safeParse(await response.json());
    if (parsed.success) {
      return new ApiError(response.status, parsed.data.error.code, parsed.data.error.message);
    }
  } catch {
    // Preserve the source status even when a proxy returned a non-JSON page.
  }
  return new ApiError(response.status, "HTTP_ERROR", msg("请求失败（{0}）", response.status));
}

async function requestJson<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw await responseError(response);
  return schema.parse(await response.json());
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const api = {
  getOrganizationSettings: () => requestJson("/organization/settings", OrganizationSettingsSchema),
  saveOrganizationSettings: (body: OrganizationSettingsUpdate) =>
    requestJson("/organization/settings", OrganizationSettingsSchema, json("PUT", body)),
  getAgentKnowledgeRead: (id: string) =>
    requestJson(`/agents/${id}/knowledge-read-settings`, AgentKnowledgeReadSettingsSchema),
  saveAgentKnowledgeRead: (id: string, body: AgentKnowledgeReadUpdate) =>
    requestJson(
      `/agents/${id}/knowledge-read-settings`,
      AgentKnowledgeReadSettingsSchema,
      json("PUT", body),
    ),
  getKnowledgeSettings: () => requestJson("/knowledge/settings", KnowledgeSettingsSchema),
  saveKnowledgeSettings: (body: KnowledgeSettingsUpdate) =>
    requestJson("/knowledge/settings", KnowledgeSettingsSchema, json("PUT", body)),
  listKnowledgeCategories: () =>
    requestJson("/knowledge/categories", KnowledgeCategorySchema.array()),
  createKnowledgeCategory: (name: string) =>
    requestJson("/knowledge/categories", KnowledgeCategorySchema, json("POST", { name })),
  renameKnowledgeCategory: (id: string, name: string, expected_revision: number) =>
    requestJson(
      `/knowledge/categories/${id}`,
      KnowledgeCategorySchema,
      json("PATCH", { name, expected_revision }),
    ),
  async deleteKnowledgeCategory(
    id: string,
    expected_revision: number,
    move_to?: string,
  ): Promise<void> {
    const response = await fetch(
      `/knowledge/categories/${id}`,
      json("DELETE", { expected_revision, move_to }),
    );
    if (!response.ok) throw await responseError(response);
  },
  listKnowledgeDocuments: () =>
    requestJson("/knowledge/documents", KnowledgeDocumentSchema.array()),
  getKnowledgeDocument: (id: string) =>
    requestJson(`/knowledge/documents/${id}`, KnowledgeDocumentDetailSchema),
  importKnowledgeText: (body: KnowledgeImport) =>
    requestJson("/knowledge/documents", KnowledgeDocumentDetailSchema, json("POST", body)),
  importKnowledgeFile(file: File, categoryId: string, name: string) {
    const body = new FormData();
    body.set("file", file);
    body.set("category_id", categoryId);
    body.set("name", name);
    return requestJson("/knowledge/import", KnowledgeDocumentDetailSchema, {
      method: "POST",
      body,
    });
  },
  updateKnowledgeDocument: (id: string, body: KnowledgeDocumentUpdate) =>
    requestJson(`/knowledge/documents/${id}`, KnowledgeDocumentDetailSchema, json("PATCH", body)),
  saveKnowledgeGrants: (id: string, expected_revision: number, agent_ids: string[]) =>
    requestJson(
      `/knowledge/documents/${id}/grants`,
      KnowledgeDocumentDetailSchema,
      json("PUT", { expected_revision, agent_ids }),
    ),
  batchKnowledgeGrants: (body: KnowledgeBatchGrant) =>
    requestJson("/knowledge/grants/batch", KnowledgeDocumentSchema.array(), json("POST", body)),
  async deleteKnowledgeDocument(id: string, expected_revision: number): Promise<void> {
    const response = await fetch(
      `/knowledge/documents/${id}`,
      json("DELETE", { expected_revision }),
    );
    if (!response.ok) throw await responseError(response);
  },
  listAgentKnowledge: (id: string) =>
    requestJson(`/agents/${id}/knowledge`, AgentKnowledgeSchema.array()),
  getBrowserStateConfig(): Promise<BrowserStateConfig> {
    return requestJson("/browser-state/config", BrowserStateConfigSchema);
  },
  listAgents(): Promise<AgentResponse[]> {
    return requestJson("/agents", AgentResponseSchema.array());
  },
  getAgent(id: string): Promise<AgentResponse> {
    return requestJson(`/agents/${id}`, AgentResponseSchema);
  },
  createAgent(body: unknown): Promise<AgentResponse> {
    return requestJson("/agents", AgentResponseSchema, json("POST", body));
  },
  updateAgent(id: string, body: unknown): Promise<AgentResponse> {
    return requestJson(`/agents/${id}`, AgentResponseSchema, json("PATCH", body));
  },
  async deleteAgent(id: string): Promise<void> {
    const response = await fetch(`/agents/${id}`, { method: "DELETE" });
    if (!response.ok) throw await responseError(response);
  },
  deleteAgents(agentIds: string[]): Promise<DeleteAgentsResponse> {
    return requestJson(
      "/agents/batch-delete",
      DeleteAgentsResponseSchema,
      json("POST", { agent_ids: agentIds }),
    );
  },
  getPersona(id: string): Promise<PersonaResponse> {
    return requestJson(`/agents/${id}/persona`, PersonaResponseSchema);
  },
  savePersona(id: string, body: unknown): Promise<PersonaResponse> {
    return requestJson(`/agents/${id}/persona`, PersonaResponseSchema, json("PUT", body));
  },
  listSessions(): Promise<SessionResponse[]> {
    return requestJson("/sessions", SessionResponseSchema.array());
  },
  createSession(body: unknown): Promise<SessionResponse> {
    return requestJson("/sessions", SessionResponseSchema, json("POST", body));
  },
  renameSession(id: string, title: string): Promise<SessionResponse> {
    return requestJson(`/sessions/${id}`, SessionResponseSchema, json("PATCH", { title }));
  },
  getSessionRuntime(id: string): Promise<RuntimeConfig> {
    return requestJson(`/sessions/${id}/runtime-config`, RuntimeConfigSchema);
  },
  async deleteSession(id: string): Promise<void> {
    const response = await fetch(`/sessions/${id}`, { method: "DELETE" });
    if (!response.ok) throw await responseError(response);
  },
  listMessages(sessionId: string): Promise<MessageResponse[]> {
    return requestJson(`/sessions/${sessionId}/messages`, MessageResponseSchema.array());
  },
  async deleteMessage(sessionId: string, messageId: string): Promise<void> {
    const response = await fetch(`/sessions/${sessionId}/messages/${messageId}`, {
      method: "DELETE",
    });
    if (!response.ok) throw await responseError(response);
  },
  listModels() {
    return requestJson("/models/local", LocalModelCatalogResponseSchema);
  },
  listModelProviders() {
    return requestJson("/models/providers", ModelProviderResponseSchema.array());
  },
  createModelProvider(body: CreateModelProviderRequest) {
    return requestJson("/models/providers", ModelProviderResponseSchema, json("POST", body));
  },
  updateModelProvider(id: string, body: UpdateModelProviderRequest) {
    return requestJson(`/models/providers/${id}`, ModelProviderResponseSchema, json("PATCH", body));
  },
  async deleteModelProvider(id: string): Promise<void> {
    const response = await fetch(`/models/providers/${id}`, { method: "DELETE" });
    if (!response.ok) throw await responseError(response);
  },
  testModelProvider(id: string) {
    return requestJson(
      `/models/providers/${id}/test`,
      ModelProviderTestResponseSchema,
      json("POST", {}),
    );
  },
  getModelCapacity(model: string): Promise<ModelCapacityResponse> {
    return requestJson(
      `/models/capacity?model=${encodeURIComponent(model)}`,
      ModelCapacityResponseSchema,
    );
  },
  getPolicy(agentId: string): Promise<PolicyView> {
    return requestJson(`/agents/${agentId}/memory/policy`, PolicyViewSchema);
  },
  updatePolicy(agentId: string, body: unknown): Promise<PolicyView> {
    return requestJson(`/agents/${agentId}/memory/policy`, PolicyViewSchema, json("PATCH", body));
  },
  listMemorySessions(agentId: string): Promise<MemorySessionOption[]> {
    return requestJson(`/agents/${agentId}/memory/sessions`, MemorySessionOptionSchema.array());
  },
  listMemoryTurns(agentId: string, sessionId: string, limit: number): Promise<TurnsList> {
    return requestJson(
      `/agents/${agentId}/memory/sessions/${sessionId}/turns?limit=${limit}`,
      TurnsListSchema,
    );
  },
  listMemoryScopes: (agentId: string) =>
    requestJson(`/agents/${agentId}/memory/scopes`, MemoryScopeViewSchema.array()),
  listMemoryEntries(
    agentId: string,
    offset = 0,
    limit = 100,
    filters: { scope_key?: string; search?: string; status?: string } = {},
  ): Promise<EntriesList> {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    for (const [key, value] of Object.entries(filters))
      if (value !== undefined) query.set(key, value);
    return requestJson(`/agents/${agentId}/memory/entries?${query}`, EntriesListSchema);
  },
  getMemoryEntry(agentId: string, memoryId: string): Promise<MemoryEntryResponse> {
    return requestJson(`/agents/${agentId}/memory/entries/${memoryId}`, MemoryEntryResponseSchema);
  },
  getMemoryContent(agentId: string, memoryId: string): Promise<MemoryContentResponse> {
    return requestJson(
      `/agents/${agentId}/memory/entries/${memoryId}/content`,
      MemoryContentResponseSchema,
    );
  },
  correctMemory(
    agentId: string,
    memoryId: string,
    body: MemoryCorrection,
  ): Promise<MemoryContentResponse> {
    return requestJson(
      `/agents/${agentId}/memory/entries/${memoryId}/correct`,
      MemoryContentResponseSchema,
      json("POST", body),
    );
  },
  listMemoryJobs(agentId: string): Promise<MemoryJobView[]> {
    return requestJson(`/agents/${agentId}/memory/jobs`, MemoryJobViewSchema.array());
  },
  getMemoryJob(agentId: string, jobId: string): Promise<MemoryJobView> {
    return requestJson(`/agents/${agentId}/memory/jobs/${jobId}`, MemoryJobViewSchema);
  },
  consolidate(agentId: string, body: unknown): Promise<MemoryJobView> {
    return requestJson(
      `/agents/${agentId}/memory/consolidate`,
      MemoryJobViewSchema,
      json("POST", body),
    );
  },
  merge(agentId: string, body: unknown): Promise<MemoryJobView> {
    return requestJson(`/agents/${agentId}/memory/merge`, MemoryJobViewSchema, json("POST", body));
  },
  async govern(agentId: string, body: unknown): Promise<void> {
    const response = await fetch(`/agents/${agentId}/memory/govern`, json("POST", body));
    if (!response.ok) throw await responseError(response);
  },
  listQqStickerCollections: () =>
    requestJson("/qq/sticker-collections", QqStickerCollectionResponseSchema.array()),
  createQqStickerCollection: (body: CreateQqStickerCollectionRequest) =>
    requestJson("/qq/sticker-collections", QqStickerCollectionResponseSchema, json("POST", body)),
  updateQqStickerCollection: (id: string, body: UpdateQqStickerCollectionRequest) =>
    requestJson(
      `/qq/sticker-collections/${id}`,
      QqStickerCollectionResponseSchema,
      json("PUT", body),
    ),
  listQqStickerAssets: () => requestJson("/qq/stickers", QqStickerAssetResponseSchema.array()),
  /**
   * One multipart import. Both answers are successful responses (§9.2's verdict shape), so the
   * caller branches on `kind`, not on the status.
   */
  async importQqStickerFile(file: File, name?: string): Promise<QqStickerImportResponse> {
    const form = new FormData();
    form.set("file", file);
    if (name !== undefined) form.set("name", name);
    const response = await fetch("/qq/stickers/import", { method: "POST", body: form });
    if (!response.ok) throw await responseError(response);
    return QqStickerImportResponseSchema.parse(await response.json());
  },
  updateQqStickerAsset: (id: string, body: UpdateQqStickerRequest) =>
    requestJson(`/qq/stickers/${id}`, QqStickerAssetResponseSchema, json("PATCH", body)),
  setQqStickerEnabled: (id: string, enabled: boolean) =>
    requestJson(
      `/qq/stickers/${id}/enabled`,
      QqStickerAssetResponseSchema,
      json("PUT", { enabled }),
    ),
  setQqStickerCollections: (id: string, body: ReplaceQqStickerCollectionsRequest) =>
    requestJson(`/qq/stickers/${id}/collections`, QqStickerAssetResponseSchema, json("PUT", body)),
  annotateQqSticker: (id: string): Promise<QqStickerAnnotationResponse> =>
    requestJson(`/qq/stickers/${id}/annotate`, QqStickerAnnotationResponseSchema, {
      method: "POST",
    }),
  bulkUpdateQqStickers: (body: QqStickerBulkRequest) =>
    requestJson("/qq/stickers/bulk", QqStickerBulkResponseSchema, json("POST", body)),
  getQqStickerImpact: (id: string) =>
    requestJson(`/qq/stickers/${id}/impact`, QqStickerImpactResponseSchema),
  /**
   * §12's close preference. It matters only in desktop mode, but the route is mounted everywhere —
   * the settings page is what hides it when there is no desktop host to obey it.
   */
  getDesktopSettings: () => requestJson("/desktop/settings", DesktopSettingsSchema),
  updateDesktopSettings: (body: DesktopSettingsUpdate) =>
    requestJson("/desktop/settings", DesktopSettingsSchema, json("PUT", body)),
  /**
   * The 第三方App接入 surface (P5q). Everything here already had a route; the page is what reads
   * it, so the client is where the wire names are pinned.
   */
  getQqSettings: () => requestJson("/qq/settings", QqSettingsResponseSchema),
  updateQqSettings: (body: UpdateQqSettingsRequest) =>
    requestJson("/qq/settings", QqSettingsResponseSchema, json("PUT", body)),
  updateQqTransport: (body: UpdateQqTransportRequest) =>
    requestJson("/qq/transport", QqSettingsResponseSchema, json("PUT", body)),
  getQqStatus: () => requestJson("/qq/status", QqStatusResponseSchema),
  listQqConversations: () => requestJson("/qq/conversations", QqConversationListItemSchema.array()),
  listQqBindings: () => requestJson("/qq/bindings", QqBindingResponseSchema.array()),
  createQqBinding: (body: CreateQqBindingRequest) =>
    requestJson("/qq/bindings", QqBindingResponseSchema, json("POST", body)),
  updateQqBinding: (id: string, body: UpdateQqBindingRequest) =>
    requestJson(`/qq/bindings/${id}`, QqBindingResponseSchema, json("PUT", body)),
  /**
   * 「立即整理」(2026-09-25): organise this conversation's pending observations now. The answer is a
   * verdict — `nothing_to_organise`, `switch_off`, `paused`, `busy`, `agent_disabled` — not an error.
   */
  organiseQqMemory: (id: string): Promise<QqMemoryOrganiseResponse> =>
    requestJson(`/qq/bindings/${id}/memory`, QqMemoryOrganiseResponseSchema, { method: "POST" }),
  getQqOwner: () => requestJson("/qq/owner", QqOwnerResponseSchema),
  getQqStorage: () => requestJson("/qq/storage", QqStorageUsageResponseSchema),
  runQqStorageCleanup: () =>
    requestJson("/qq/storage/cleanup", QqStorageCleanupResponseSchema, { method: "POST" }),
  listQqSchemes: () => requestJson("/qq/schemes", QqSchemeResponseSchema.array()),
  createQqScheme: (body: CreateQqSchemeRequest) =>
    requestJson("/qq/schemes", QqSchemeResponseSchema, json("POST", body)),
  updateQqScheme: (id: string, body: UpdateQqSchemeRequest) =>
    requestJson(`/qq/schemes/${id}`, QqSchemeResponseSchema, json("PUT", body)),
  async deleteQqScheme(id: string): Promise<void> {
    const response = await fetch(`/qq/schemes/${id}`, { method: "DELETE" });
    if (!response.ok) throw await responseError(response);
  },
  getQqSchemeUsage: (id: string) =>
    requestJson(`/qq/schemes/${id}/usage`, QqSchemeUsageResponseSchema),
};

function parseFrame(frame: string): SseEvent | null {
  let event = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!event || !data) return null;
  return SseEventSchema.parse({ event, ...JSON.parse(data) });
}

export async function streamChat(
  body: { session_id: string; message: string; client_request_id: string },
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/chat", {
    ...json("POST", body),
    headers: {
      "content-type": "application/json",
      "X-Superstring-Context-Usage": "1",
    },
    signal,
  });
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new ApiError(502, "MODEL_STREAM_INTERRUPTED", msg("模型流中断"));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const parsed = parseFrame(frame);
      if (parsed) onEvent(parsed);
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const parsed = parseFrame(buffer);
    if (parsed) onEvent(parsed);
  }
}

export type SuperstringApi = typeof api;
