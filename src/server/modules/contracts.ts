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
export interface EvidenceQueryPage {
  readonly status: "ok" | "unavailable";
  readonly code?: string;
  readonly items: readonly Evidence[];
  readonly nextCursor?: string | null;
}
export type EvidenceQueryResponse = readonly Evidence[] | EvidenceQueryPage;
export interface EvidenceTextPage {
  readonly text: string;
  readonly offset: number;
  readonly total: number;
  readonly nextOffset: number | null;
}

export interface MemoryQuery {
  agentId: string;
  mode: MemoryReadMode;
  sessionId?: string;
  scopes: MemoryScopeKeys;
  query: string;
  budget: number;
  limit?: number;
  cursor?: string;
  projection?: "catalog";
  owner: { kind: string; id: string; userId?: string; agentId?: string };
  signal?: AbortSignal;
  sources?: SourceRef[];
}
export interface KnowledgeQuery {
  agentId: string;
  query: string;
  budget: number;
  limit?: number;
  cursor?: string;
  projection?: "catalog";
  owner: MemoryQuery["owner"];
  signal?: AbortSignal;
  sources?: SourceRef[];
}
export interface EvidenceReadInput {
  agentId: string;
  evidence: Evidence;
  offset: number;
  limit: number;
  owner: MemoryQuery["owner"];
  signal?: AbortSignal;
  sources?: SourceRef[];
}
export interface MemoryReadInput extends EvidenceReadInput {
  sessionId?: string;
  scopes: MemoryScopeKeys;
}

export function evidenceQueryPage(result: EvidenceQueryResponse): EvidenceQueryPage {
  return Array.isArray(result) ? { status: "ok", items: result } : (result as EvidenceQueryPage);
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
export interface SourceReceipt {
  source: SourceRef;
  created: boolean;
}
export interface MaintenanceResult {
  didWork: boolean;
}

/** Query is the only mandatory capability: a read-only backend has no fake mutation methods. */
export interface MemoryModule {
  query(input: MemoryQuery): Promise<EvidenceQueryResponse>;
  read?(input: MemoryReadInput): Promise<EvidenceTextPage>;
  observe?(source: SourceEvent): SourceReceipt | Promise<SourceReceipt>;
  maintain?(target?: string): Promise<MaintenanceResult>;
}
export interface KnowledgeModule {
  query(input: KnowledgeQuery): Promise<EvidenceQueryResponse>;
  read?(input: EvidenceReadInput): Promise<EvidenceTextPage>;
  ingest?(source: KnowledgeSource): SourceReceipt | Promise<SourceReceipt>;
  maintain?(target?: string): Promise<MaintenanceResult>;
}
