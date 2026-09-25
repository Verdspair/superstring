import type { Evidence, SourceRef } from "../../shared/contracts/evidence";
import type { MemoryScopeKeys } from "../services/memory-scope";

export type MemoryReadMode =
  | "off"
  | "conservative"
  | "standard"
  | "broad"
  | "full_catalog"
  | "full_body";

/** Public query contracts carry intent and authority, not one backend's Agent configuration. */
export interface MemoryQuery {
  agentId: string;
  mode: MemoryReadMode;
  sessionId?: string;
  scopes: MemoryScopeKeys;
  query: string;
  budget: number;
  owner: { kind: string; id: string; userId?: string; agentId?: string };
  signal?: AbortSignal;
  sources?: SourceRef[];
}
export interface KnowledgeQuery {
  agentId: string;
  query: string;
  budget: number;
  owner: MemoryQuery["owner"];
  signal?: AbortSignal;
  sources?: SourceRef[];
}
export interface SourceEvent {
  source: SourceRef;
  payload: unknown;
}
export interface KnowledgeSource {
  id: string;
  revision: string;
  payload: unknown;
}
export interface MaintenanceResult {
  didWork: boolean;
}

/** Query is the only mandatory capability: a read-only backend has no fake mutation methods. */
export interface MemoryModule {
  query(input: MemoryQuery): Promise<readonly Evidence[]>;
  observe?(source: SourceEvent): Promise<void>;
  maintain?(target?: string): Promise<MaintenanceResult>;
}
export interface KnowledgeModule {
  query(input: KnowledgeQuery): Promise<readonly Evidence[]>;
  ingest?(source: KnowledgeSource): Promise<void>;
  maintain?(target?: string): Promise<MaintenanceResult>;
}
