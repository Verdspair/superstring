// Own the business database, model gateway and memory-worker lifetime.
// Kept separate from socket binding so tests can exercise startup and shutdown.
import path from "node:path";
import type { Hono } from "hono";
import { createApp } from "./app";
import { browserStateSecret } from "./browser-state";
import type { BusinessDbHandle } from "./db/connection";
import { resolveModelProviderRoute } from "./db/model-provider-repository";
import { type BusinessMigrationSql, openBusinessDb } from "./db/schema-gate";
import { withCapacityCache } from "./llm/capacity-cache";
import {
  createLmStudioClient,
  type ModelGateway,
  resolveLmStudioConfig,
} from "./llm/model-gateway";
import { createLmStudioVisionClient } from "./llm/vision-client";
import { DEFAULT_MODEL_PROVIDER_KEY_PATH } from "./secret-box";
import { KnowledgeOrganizer } from "./services/knowledge-organizer";
import { MemoryService } from "./services/memory-service";
import { QqIntakeRuntime } from "./services/qq-intake";
import { QqRuntime, qqDispatchRunner, qqImmediateRunner } from "./services/qq-runtime";
import { qqReplySender } from "./services/qq-send-transport";
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
  /** The QQ state-machine host (sweep + dispatch). Tests inject a fake to pin start/stop. */
  qqRuntime?: QqRuntime;
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
}

export interface SuperstringRuntime {
  app: Hono;
  business: BusinessDbHandle;
  gateway: ModelGateway;
  memoryService: MemoryService;
  qqRuntime: QqRuntime;
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
  let qqRuntime: QqRuntime;
  let qqIntake: QqIntakeRuntime;
  let app: Hono;
  let knowledgeOrganizer: KnowledgeOrganizer;
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
    memoryService =
      options.memoryService ?? new MemoryService({ orm: business.orm, db: business.db, gateway });
    knowledgeOrganizer = new KnowledgeOrganizer({ db: business.db, gateway });
    const stickerStore = new QqStickerStore({
      directory: options.qqStickerDirectory ?? DEFAULT_QQ_STICKER_DIRECTORY,
    });
    const sender = qqReplySender({
      orm: business.orm,
      store: stickerStore,
      ports: {
        send: (request) =>
          qqIntake.connection?.send(request) ??
          Promise.resolve({ kind: "not_sent" as const, reason: "not_ready" as const }),
      },
    });
    qqRuntime =
      options.qqRuntime ??
      new QqRuntime({
        orm: business.orm,
        // The chain runs only while a QQ connection is live: without one an authorized draft has
        // nowhere to go, and the model calls behind it would be spent on nothing (P5o).
        canAdvance: () => qqIntake.state.phase === "ready",
        dispatch: qqDispatchRunner({
          orm: business.orm,
          // 一轮里同一个模型的容量只探一次（2026-09-25）：判断、写回复、选图、复核各问一次，
          // 本地模型每次都是一条 HTTP。缓存只包住 QQ 这两条链，网页那侧保持原样。
          gateway: withCapacityCache(gateway),
          store: stickerStore,
          sender,
        }),
        // The immediate paths (被@直接回应 / 连续交谈) run under the same slot and the same gate.
        immediate: qqImmediateRunner({
          orm: business.orm,
          gateway: withCapacityCache(gateway),
          store: stickerStore,
          sender,
        }),
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
        media: { vision: visionClient },
        // 「被 @ 了别等轮询」（2026-09-25）：入站路径记下一条冲着她来的消息就叫醒宿主跑一轮。
        onAddressedMessage: () => qqRuntime.wake(),
      });
    app = createApp({
      business,
      gateway,
      vision: visionClient,
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

  let started = false;
  let stopped = false;
  return {
    app,
    business,
    gateway,
    memoryService,
    qqRuntime,
    qqIntake,
    start(): void {
      if (started || stopped) return;
      started = true;
      memoryService.start();
      knowledgeOrganizer.start();
      qqRuntime.start();
      // Refuses on its own while the third-party switch is off or the saved configuration is
      // incomplete, so an unconfigured installation produces no traffic and no login.
      void qqIntake.start().catch(() => {});
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      qqIntake.stop();
      if (started)
        await Promise.all([memoryService.stop(), knowledgeOrganizer.stop(), qqRuntime.stop()]);
      business.close();
    },
  };
}
