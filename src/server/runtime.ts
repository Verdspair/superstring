// Own the business database, model gateway and memory-worker lifetime.
// Kept separate from socket binding so tests can exercise startup and shutdown.
import path from "node:path";
import type { Hono } from "hono";
import { createApp } from "./app";
import { browserStateSecret } from "./browser-state";
import type { BusinessDbHandle } from "./db/connection";
import { type BusinessMigrationSql, openBusinessDb } from "./db/schema-gate";
import {
  createLmStudioClient,
  type ModelGateway,
  resolveLmStudioConfig,
} from "./llm/model-gateway";
import { KnowledgeOrganizer } from "./services/knowledge-organizer";
import { MemoryService } from "./services/memory-service";

export const DEFAULT_BUSINESS_DB_PATH = path.resolve("data/superstring.sqlite");

export function resolveBusinessDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = (env.SUPERSTRING_DB_PATH ?? "").trim();
  if (configured === "") return DEFAULT_BUSINESS_DB_PATH;
  if (configured === ":memory:") return configured;
  return path.resolve(configured);
}

export interface RuntimeOptions {
  /** Tests pass `:memory:`; the executable uses resolveBusinessDbPath(). */
  businessDbPath?: string;
  gateway?: ModelGateway;
  business?: BusinessDbHandle;
  memoryService?: MemoryService;
  browserStateSecret?: string;
  browserStateSecretPath?: string;
  businessMigrationSql?: BusinessMigrationSql;
}

export interface SuperstringRuntime {
  app: Hono;
  business: BusinessDbHandle;
  gateway: ModelGateway;
  memoryService: MemoryService;
  start(): void;
  stop(): Promise<void>;
}

export function createRuntime(options: RuntimeOptions = {}): SuperstringRuntime {
  const business =
    options.business ??
    openBusinessDb({
      path: options.businessDbPath ?? ":memory:",
      migrationSql: options.businessMigrationSql,
    });
  let gateway: ModelGateway;
  let memoryService: MemoryService;
  let app: Hono;
  let knowledgeOrganizer: KnowledgeOrganizer;
  try {
    gateway = options.gateway ?? createLmStudioClient(resolveLmStudioConfig());
    memoryService =
      options.memoryService ?? new MemoryService({ orm: business.orm, db: business.db, gateway });
    knowledgeOrganizer = new KnowledgeOrganizer({ db: business.db, gateway });
    app = createApp({
      business,
      gateway,
      browserStateSecret:
        options.browserStateSecret ?? browserStateSecret(options.browserStateSecretPath),
    });
  } catch (error) {
    business.close();
    throw error;
  }

  let started = false;
  let stopped = false;
  return {
    app,
    business,
    gateway,
    memoryService,
    start(): void {
      if (started || stopped) return;
      started = true;
      memoryService.start();
      knowledgeOrganizer.start();
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (started) await Promise.all([memoryService.stop(), knowledgeOrganizer.stop()]);
      business.close();
    },
  };
}
