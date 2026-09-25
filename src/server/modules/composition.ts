import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { RuntimeConfig } from "../../shared/contracts";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import {
  type KnowledgeDocumentDetail,
  KnowledgeImportSchema,
} from "../../shared/contracts/knowledge";
import type { LeafAgentRuntime } from "../agent/agent-runtime";
import { KnowledgeRepository } from "../db/knowledge-repository";
import { type RecordedObservation, recordObservation } from "../db/qq-observation-intake";
import { DEFAULT_USER_ID, getAgentRow, type Orm } from "../db/repositories";
import { fail } from "../errors";
import type { ModelGateway } from "../llm/model-gateway";
import { KnowledgeOrganizer } from "../services/knowledge-organizer";
import { MemoryService } from "../services/memory-service";
import type { QqObservation } from "../services/onebot-protocol";
import { scheduleQqMemory } from "../services/qq-memory-scheduler";
import { runtimeFromAgent } from "../services/runtime-config";
import type {
  KnowledgeModule,
  KnowledgeSource,
  MemoryModule,
  SourceEvent,
  SourceReceipt,
} from "./contracts";
import {
  type BotInitialMemoryQuery,
  sqliteBotInitialMemory,
  sqliteWebInitialEvidence,
  type WebInitialEvidenceFactory,
} from "./initial-evidence";
import { SqliteKnowledgeModule } from "./knowledge-module";
import { SqliteMemoryModule } from "./memory-module";
import { turnSources } from "./provenance";

export interface ModuleQueries {
  memory: MemoryModule;
  knowledge: KnowledgeModule;
  /** Optional preservation of a backend's existing Web frozen-read policy. */
  webInitial?: WebInitialEvidenceFactory;
  botMemory?: BotInitialMemoryQuery;
}
/** Unknown kinds fall through to the application's existing source resolver; never auto-authorize. */
export type ModuleSourceResolver = (
  source: SourceRef,
  owner: RunOwner,
  at: string,
) => "available" | "expired" | "revoked" | undefined;
export interface ModuleQueryBinding {
  runtime: RuntimeConfig;
  assertSources?: (sources: readonly SourceRef[]) => void;
}
/** A single composition function, not a registry or a backend-specific context contract. */
export type ModuleQueryFactory = (binding: ModuleQueryBinding) => ModuleQueries;
export interface ModuleComposition {
  bind: ModuleQueryFactory;
  memory: MemoryModule;
  knowledge: KnowledgeModule;
  start(): void;
  stop(): Promise<void>;
}
export type SqliteObservation =
  | {
      kind: "onebot";
      observation: QqObservation;
      agentId: string;
      hooks?: { beforeWrite?: () => void; afterWrite?: (result: RecordedObservation) => void };
    }
  | { kind: "web_turn"; turnId: string; agentId: string }
  | { kind: "qq_event"; eventKey: string; agentId: string };
export interface SqliteObservationReceipt extends SourceReceipt {
  metadata: { recorded: boolean; hasText: boolean };
}
export interface SqliteKnowledgeReceipt extends SourceReceipt {
  document: KnowledgeDocumentDetail;
}
export interface SqliteModules extends ModuleComposition {
  memory: Omit<MemoryModule, "observe"> & {
    observe(source: SourceEvent): SqliteObservationReceipt;
  };
  knowledge: Omit<KnowledgeModule, "ingest"> & {
    ingest(source: KnowledgeSource): SqliteKnowledgeReceipt;
  };
}

export function createSqliteQueryFactory(options: {
  db: Database;
  orm: Orm;
  gateway: Pick<ModelGateway, "loadedContextCapacity">;
  agentRuntime: LeafAgentRuntime;
}): ModuleQueryFactory {
  return ({ runtime, assertSources }) => ({
    memory: new SqliteMemoryModule({ ...options, runtime: () => runtime, assertSources }),
    knowledge: new SqliteKnowledgeModule({ ...options, runtime: () => runtime, assertSources }),
    webInitial: (input) => sqliteWebInitialEvidence({ ...options, assertSources }, input),
    botMemory: sqliteBotInitialMemory({ ...options, runtime: () => runtime, assertSources }),
  });
}

/** Existing repositories and workers retain their transactions, cursors, leases and parsing. */
export function createSqliteModules(options: {
  db: Database;
  orm: Orm;
  gateway: ModelGateway;
  agentRuntime: LeafAgentRuntime;
  memoryWorker?: MemoryService;
  knowledgeWorker?: KnowledgeOrganizer;
}): SqliteModules {
  const memoryWorker = options.memoryWorker ?? new MemoryService(options);
  const knowledgeWorker = options.knowledgeWorker ?? new KnowledgeOrganizer(options);
  const knowledgeRepository = new KnowledgeRepository(options.db);
  const bind = createSqliteQueryFactory(options);
  const runtimeFor = (agentId: string): RuntimeConfig => {
    const agent = getAgentRow(options.orm, agentId);
    if (!agent) fail("AGENT_NOT_FOUND", "助手不存在", 404);
    return runtimeFromAgent(agent);
  };
  return {
    bind,
    memory: {
      query: (input) => bind({ runtime: runtimeFor(input.agentId) }).memory.query(input),
      observe(source) {
        const payload = source.payload as SqliteObservation;
        if (payload.kind === "qq_event") {
          const row = options.db
            .query(
              "SELECT e.recorded_at,e.agent_id,t.event_key AS text_id FROM qq_events e LEFT JOIN qq_observation_text t ON t.event_key=e.event_key WHERE e.event_key=?",
            )
            .get(payload.eventKey) as {
            recorded_at: string;
            agent_id: string;
            text_id: string | null;
          } | null;
          if (
            source.source.kind !== "qq_event" ||
            source.source.id !== payload.eventKey ||
            !row ||
            row.agent_id !== payload.agentId ||
            source.source.revision !== row.recorded_at
          )
            fail("MEMORY_SOURCE_INVALID", "QQ记忆来源不是当前已提交的受权观察");
          scheduleQqMemory(options.orm);
          return {
            source: source.source,
            created: false,
            metadata: { recorded: false, hasText: row.text_id !== null },
          };
        }
        if (payload.kind === "onebot") {
          if (
            source.source.kind !== "qq_event" ||
            source.source.id !== payload.observation.eventKey
          )
            fail("MEMORY_SOURCE_INVALID", "观察身份与原始事件不一致");
          const result = recordObservation(
            options.orm,
            payload.observation,
            payload.agentId,
            payload.hooks,
          );
          const row = options.db
            .query("SELECT recorded_at FROM qq_events WHERE event_key=?")
            .get(result.eventKey) as { recorded_at: string };
          return {
            source: { kind: "qq_event", id: result.eventKey, revision: row.recorded_at },
            created: result.recorded,
            metadata: { recorded: result.recorded, hasText: result.hasText },
          };
        }
        if (
          payload.kind !== "web_turn" ||
          source.source.kind !== "web_turn" ||
          source.source.id !== payload.turnId
        )
          fail("MEMORY_SOURCE_INVALID", "记忆模块不支持这个来源事件");
        const turn = options.db
          .query(
            `SELECT t.id FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.id=? AND s.agent_id=? AND s.user_id=? AND t.source_valid=1 AND t.generation_status='completed'`,
          )
          .get(payload.turnId, payload.agentId, DEFAULT_USER_ID);
        if (!turn) fail("MEMORY_SOURCE_INVALID", "网页记忆来源不是已完成的受权轮次");
        const ref = turnSources(options.orm, [payload.turnId])[0];
        if (!ref || ref.revision !== source.source.revision)
          fail("MEMORY_SOURCE_INVALID", "网页记忆来源版本已变化");
        // The completed turn is already the canonical source; do not copy it into another table.
        memoryWorker.scheduleAuto();
        return { source: ref, created: false, metadata: { recorded: false, hasText: true } };
      },
      async maintain(target) {
        if (target) {
          const queued = options.db
            .query("SELECT id FROM memory_jobs WHERE id=? AND status='queued'")
            .get(target);
          if (!queued) return { didWork: false };
          await memoryWorker.runJob(target);
          return { didWork: true };
        }
        return { didWork: await memoryWorker.runCycle() };
      },
    },
    knowledge: {
      query: (input) => bind({ runtime: runtimeFor(input.agentId) }).knowledge.query(input),
      ingest(source) {
        const id = z.uuid().parse(source.id);
        const payload = z
          .object({
            input: KnowledgeImportSchema,
            importType: z.enum(["text", "txt", "md"]).default("text"),
          })
          .parse(source.payload);
        if (source.revision !== "1") fail("KNOWLEDGE_REVISION_CONFLICT", "新文档摄入需要初始版本1");
        const existing = options.db
          .query(
            "SELECT name, category_id, original_text, import_type FROM knowledge_documents WHERE id=?",
          )
          .get(id) as {
          name: string;
          category_id: string;
          original_text: string;
          import_type: string;
        } | null;
        if (
          existing &&
          (existing.name !== payload.input.name ||
            existing.category_id !== payload.input.category_id ||
            existing.original_text !== payload.input.original_text ||
            existing.import_type !== payload.importType)
        )
          fail("KNOWLEDGE_REVISION_CONFLICT", "重复来源身份描述了不同文档");
        const document = existing
          ? knowledgeRepository.detail(id)
          : knowledgeRepository.importDocument(payload.input, payload.importType, id);
        return {
          source: { kind: "knowledge_document", id, revision: String(document.content_version) },
          created: !existing,
          document,
        };
      },
      async maintain(target) {
        if (target !== undefined)
          throw new TypeError(
            "SQLite knowledge maintenance consumes its ordered durable queue; omit target",
          );
        return { didWork: await knowledgeWorker.runCycle() };
      },
    },
    start() {
      memoryWorker.start();
      knowledgeWorker.start();
    },
    async stop() {
      await Promise.all([memoryWorker.stop(), knowledgeWorker.stop()]);
    },
  };
}
