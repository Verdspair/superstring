// Own the business database, model gateway and memory-worker lifetime.
// Kept separate from socket binding so tests can exercise startup and shutdown.
import path from "node:path";
import type { Hono } from "hono";
import { type AgentRuntime, createAgentRuntime } from "./agent/agent-runtime";
import { ConversationHost } from "./agent/conversation-host";
import { createApp } from "./app";
import { browserStateSecret } from "./browser-state";
import {
  type BotConversationPolicy,
  createOneBotConversationRuntime,
} from "./channels/onebot11/create-runtime";
import { BotWorker } from "./conversation/bot-worker";
import { AgentRunRepository } from "./db/agent-run-repository";
import type { BusinessDbHandle } from "./db/connection";
import { ConversationEventRepository } from "./db/conversation-event-repository";
import { resolveModelProviderRoute } from "./db/model-provider-repository";
import { type BusinessMigrationSql, openBusinessDb } from "./db/schema-gate";
import { withCapacityCache } from "./llm/capacity-cache";
import {
  createLmStudioClient,
  type ModelGateway,
  resolveLmStudioConfig,
} from "./llm/model-gateway";
import { createLmStudioVisionClient } from "./llm/vision-client";
import {
  createSqliteModules,
  type ModuleComposition,
  type ModuleSourceResolver,
} from "./modules/composition";
import { DEFAULT_MODEL_PROVIDER_KEY_PATH } from "./secret-box";
import { MemoryService } from "./services/memory-service";
import { QqIntakeRuntime } from "./services/qq-intake";
import type { QqSendPort } from "./services/qq-send-transport";
import { DEFAULT_QQ_STICKER_DIRECTORY, QqStickerStore } from "./services/qq-sticker-store";

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
  modules?: ModuleComposition;
  resolveSource?: ModuleSourceResolver;
  /** Timer/lifecycle host; model work is exclusively owned by AgentRuntime. */
  botWorker?: BotWorker;
  /**
   * The inbound transport runtime (P5m). Tests inject a fake; production resolves the saved
   * endpoint and token itself, so it never takes a credential from its caller.
   */
  qqIntake?: QqIntakeRuntime;
  /**
   * Where the QQ transport token's key lives. The entrypoint passes the resolved layout path;
   * without one the dev default applies. It must travel with the runtime because the token is
   * sealed with it — a different path makes a saved token unreadable, which reads as
   * "not configured".
   */
  qqTransportKeyPath?: string;
  /** 外部模型 API 密钥的密钥文件（0032）；安装态由布局给出，开发态走默认路径。 */
  modelProviderKeyPath?: string;
  browserStateSecret?: string;
  browserStateSecretPath?: string;
  /** Imported sticker copies; the entrypoint passes the resolved layout path. */
  qqStickerDirectory?: string;
  businessMigrationSql?: BusinessMigrationSql;
  botConversationPolicy?: Partial<BotConversationPolicy>;
}

export interface SuperstringRuntime {
  app: Hono;
  business: BusinessDbHandle;
  gateway: ModelGateway;
  memoryService: MemoryService;
  modules: ModuleComposition;
  agentRuntime: AgentRuntime;
  botWorker: BotWorker;
  qqIntake: QqIntakeRuntime;
  start(): void;
  stop(): Promise<void>;
}

/** Transport budgets. Generous, because a stalled socket is worse than a slow answer. */
export const QQ_CONNECT_TIMEOUT_MS = 10_000;
export const QQ_REQUEST_TIMEOUT_MS = 20_000;

export function createRuntime(options: RuntimeOptions = {}): SuperstringRuntime {
  const business =
    options.business ??
    openBusinessDb({
      path: options.businessDbPath ?? ":memory:",
      migrationSql: options.businessMigrationSql,
    });
  let gateway: ModelGateway;
  let memoryService: MemoryService;
  let agentRuntime: AgentRuntime;
  let botWorker: BotWorker;
  let qqIntake: QqIntakeRuntime;
  let app: Hono;
  let modules: ModuleComposition;
  let bot: ReturnType<typeof createOneBotConversationRuntime>;
  let stopping = false;
  try {
    // The external-provider resolver is bound to this database and its key file (0032): a model
    // name declared on the 外部模型API page routes to that provider, everything else stays local.
    // One resolver for every model call, vision included: a model name declared on the
    // 外部模型API page routes there, and everything else stays on the local service.
    const externalModel = (model: string) => {
      const route = resolveModelProviderRoute(
        business.orm,
        model,
        options.modelProviderKeyPath ?? DEFAULT_MODEL_PROVIDER_KEY_PATH,
      );
      return route === null
        ? null
        : { baseUrl: route.baseUrl, apiKey: route.apiKey, contextWindow: route.contextWindow };
    };
    gateway = options.gateway ?? createLmStudioClient(resolveLmStudioConfig(), { externalModel });
    const visionClient =
      options.gateway === undefined
        ? createLmStudioVisionClient(resolveLmStudioConfig(), fetch, { externalModel })
        : createLmStudioVisionClient(gateway.config, fetch, { externalModel });
    const runRepository = new AgentRunRepository(business.db);
    runRepository.expireContexts();
    runRepository.recoverInterrupted();
    agentRuntime = createAgentRuntime({ gateway, vision: visionClient, repository: runRepository });
    const journal = new ConversationEventRepository(business.db);
    journal.backfill();
    const host = new ConversationHost({ runtime: agentRuntime });
    memoryService =
      options.memoryService ??
      new MemoryService({ orm: business.orm, db: business.db, gateway, agentRuntime });
    modules =
      options.modules ??
      createSqliteModules({
        db: business.db,
        orm: business.orm,
        gateway,
        agentRuntime,
        memoryWorker: memoryService,
      });
    const stickerStore = new QqStickerStore({
      directory: options.qqStickerDirectory ?? DEFAULT_QQ_STICKER_DIRECTORY,
    });
    const port: QqSendPort = {
      send: (request) =>
        qqIntake.connection?.send(request) ??
        Promise.resolve({ kind: "not_sent" as const, reason: "not_ready" as const }),
    };
    bot = createOneBotConversationRuntime({
      orm: business.orm,
      db: business.db,
      gateway: withCapacityCache(gateway),
      agentRuntime,
      host,
      journal,
      store: stickerStore,
      port,
      wake: () => botWorker.wake(),
      policy: options.botConversationPolicy,
      modules: modules.bind,
      resolveSource: options.resolveSource,
    });
    botWorker =
      options.botWorker ??
      new BotWorker({
        canAdvance: () => qqIntake.state.phase === "ready",
        sweep: (nowSeconds) => {
          bot.adapter.sweep(nowSeconds);
        },
        async advance() {
          if (stopping) return;
          await bot.delivery.runOnce();
          while (!stopping && qqIntake.state.phase === "ready" && (await bot.scheduler.runOnce())) {
            // The scheduler supplies priority, coalescing and durable leases for all topologies.
          }
        },
        onError: () => console.warn("bot worker cycle failed; retrying next check"),
      });
    qqIntake =
      options.qqIntake ??
      new QqIntakeRuntime({
        orm: business.orm,
        transportKeyPath: options.qqTransportKeyPath,
        connectTimeoutMs: QQ_CONNECT_TIMEOUT_MS,
        requestTimeoutMs: QQ_REQUEST_TIMEOUT_MS,
        // The media seam. The vision client is the same one the sticker annotation uses; giving
        // it to the intake runtime is what turns "media is recorded" into "media is understood".
        media: { vision: visionClient, agentRuntime },
        conversationIngress: bot.adapter,
        memory: modules.memory,
        // 「被 @ 了别等轮询」（2026-09-25）：入站路径记下一条冲着她来的消息就叫醒宿主跑一轮。
        onAddressedMessage: () => botWorker.wake(),
      });
    app = createApp({
      business,
      gateway,
      vision: visionClient,
      agentRuntime,
      conversationHost: host,
      conversationJournal: journal,
      modules,
      resolveSource: options.resolveSource,
      qqTransportKeyPath: options.qqTransportKeyPath,
      modelProviderKeyPath: options.modelProviderKeyPath,
      // The page reads the transport's own state; nothing is inferred from a saved endpoint.
      qqConnectionState: () => qqIntake.state,
      qqStickerDirectory: options.qqStickerDirectory,
      browserStateSecret:
        options.browserStateSecret ?? browserStateSecret(options.browserStateSecretPath),
    });
  } catch (error) {
    business.close();
    throw error;
  }

  let contextSweep: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let stopped = false;
  return {
    app,
    business,
    gateway,
    memoryService,
    modules,
    agentRuntime,
    botWorker,
    qqIntake,
    start(): void {
      if (started || stopped) return;
      started = true;
      contextSweep = setInterval(() => {
        new AgentRunRepository(business.db).expireContexts();
        bot.delivery.housekeep();
      }, 60_000);
      contextSweep.unref();
      modules.start();
      botWorker.start();
      // Refuses on its own while the third-party switch is off or the saved configuration is
      // incomplete, so an unconfigured installation produces no traffic and no login.
      void qqIntake.start().catch(() => {});
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      stopping = true;
      if (contextSweep !== null) clearInterval(contextSweep);
      bot.delivery.stop();
      qqIntake.stop();
      bot.scheduler.stop();
      await botWorker.stop();
      if (started) await modules.stop();
      business.close();
    },
  };
}
