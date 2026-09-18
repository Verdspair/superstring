import type { z } from "zod";
import {
  type AgentResponse,
  AgentResponseSchema,
  type BrowserStateConfig,
  BrowserStateConfigSchema,
  type DeleteAgentsResponse,
  DeleteAgentsResponseSchema,
  type EntriesList,
  EntriesListSchema,
  ErrorEnvelopeSchema,
  LocalModelCatalogResponseSchema,
  type MemoryEntryResponse,
  MemoryEntryResponseSchema,
  type MemoryJobView,
  MemoryJobViewSchema,
  type MemorySessionOption,
  MemorySessionOptionSchema,
  type MessageResponse,
  MessageResponseSchema,
  type ModelCapacityResponse,
  ModelCapacityResponseSchema,
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
} from "../shared/contracts";
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
  listMemoryEntries(agentId: string, offset = 0, limit = 100): Promise<EntriesList> {
    return requestJson(
      `/agents/${agentId}/memory/entries?offset=${offset}&limit=${limit}`,
      EntriesListSchema,
    );
  },
  getMemoryEntry(agentId: string, memoryId: string): Promise<MemoryEntryResponse> {
    return requestJson(`/agents/${agentId}/memory/entries/${memoryId}`, MemoryEntryResponseSchema);
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
