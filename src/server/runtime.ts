// Own the business database, model gateway and memory-worker lifetime.
// Kept separate from socket binding so tests can exercise startup and shutdown.
import path from "node:path";
import type { Hono } from "hono";
import { executionPolicy } from "../shared/contracts/permissions";
import { ActionExecutor } from "./agent/action-executor";
import { type AgentRuntime, createAgentRuntime } from "./agent/agent-runtime";
import type { CodeRunner } from "./agent/code-runner";
import { ConversationHost } from "./agent/conversation-host";
import { createQuickJsCodeRunner } from "./agent/quickjs-runner";
import { AgentTaskService } from "./agent/task-service";
import { createApp } from "./app";
import { browserStateSecret } from "./browser-state";
import {
  type BotConversationPolicy,
  createOneBotConversationRuntime,
  DEFAULT_BOT_CONVERSATION_POLICY,
} from "./channels/onebot11/create-runtime";
import { BotWorker } from "./conversation/bot-worker";
import { AgentRunRepository } from "./db/agent-run-repository";
import { AgentTaskRepository } from "./db/agent-task-repository";
import type { BusinessDbHandle } from "./db/connection";
import { ConversationEventRepository } from "./db/conversation-event-repository";
import { readModelProviders, resolveModelProviderRoute } from "./db/model-provider-repository";
import { type BusinessMigrationSql, openBusinessDb } from "./db/schema-gate";
import { withCapacityCache } from "./llm/capacity-cache";
import {
  createLmStudioClient,
  type ModelGateway,
  resolveLmStudioConfig,
} from "./llm/model-gateway";
import { createLmStudioVisionClient } from "./llm/vision-client";
import { McpToolHost } from "./mcp/host";
import { createMcpManagement } from "./mcp/management";
import {
  createSqliteModules,
  type ModuleComposition,
  type ModuleSourceResolver,
} from "./modules/composition";
import { RuntimeTelemetry } from "./observability/runtime-telemetry";
import {
  FilePermissionStore,
  PermissionService,
  unconfiguredPermissions,
} from "./permissions/service";
import { DEFAULT_MODEL_PROVIDER_KEY_PATH } from "./secret-box";
import { MemoryService } from "./services/memory-service";
import { QqIntakeRuntime } from "./services/qq-intake";
import type { QqSendPort } from "./services/qq-send-transport";
import { DEFAULT_QQ_STICKER_DIRECTORY, QqStickerStore } from "./services/qq-sticker-store";
import { createSkillActions } from "./skills/actions";
import { skillSourceAccess } from "./skills/sources";

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
  /** MCP 服务器登记文件（0.4.0 P6）；缺省＝不启用 MCP（行为与不加这个功能一致）。 */
  mcpConfigPath?: string;
  permissionConfigPath?: string;
  skillRoot?: string;
  codeRunner?: CodeRunner;
  businessMigrationSql?: BusinessMigrationSql;
  botConversationPolicy?: Partial<BotConversationPolicy> | (() => Partial<BotConversationPolicy>);
}

export interface SuperstringRuntime {
  app: Hono;
  business: BusinessDbHandle;
  gateway: ModelGateway;
  memoryService: MemoryService;
  modules: ModuleComposition;
  agentRuntime: AgentRuntime;
  tasks: AgentTaskService;
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
  const telemetry = new RuntimeTelemetry(business.db);
  const permissions = options.permissionConfigPath
    ? new PermissionService(new FilePermissionStore(options.permissionConfigPath))
    : unconfiguredPermissions;
  // 有效执行配置（P7-c）：开关与数值分组都从这里读；消费方在各自的新 run/新任务/新领取时取值。
  const execution = () => executionPolicy(permissions.snapshot().policy);
  /** QQ 通道的有效策略：配置给缺省，显式注入（测试与固定入口）优先。 */
  const botLimits = (): Partial<BotConversationPolicy> => {
    const effective = execution();
    const injected =
      typeof options.botConversationPolicy === "function"
        ? options.botConversationPolicy()
        : options.botConversationPolicy;
    return {
      maxSteps: effective.loop.maxSteps,
      globalConcurrency: effective.loop.concurrency,
      modelCallConcurrency: effective.loop.modelConcurrency,
      retryDelayMs: effective.qq.retryDelayMs,
      maxAttempts: effective.qq.maxAttempts,
      deliveryTtlSeconds: effective.qq.deliveryTtlSeconds,
      ...injected,
    };
  };
  const actionExecutor = new ActionExecutor(permissions, () => execution().loop.readBatch);
  const resolveDomainSource: ModuleSourceResolver = (source, owner, at) =>
    permissions.sourceAccess(source, owner) ??
    skillSourceAccess(options.skillRoot, source) ??
    options.resolveSource?.(source, owner, at);
  const resolveSource: ModuleSourceResolver = (source, owner, at) =>
    tasks.sourceAccess(source, owner) ?? resolveDomainSource(source, owner, at);
  // MCP 宿主（0.4.0 P6）：只有给了登记文件才建。没有配置文件＝没有 MCP，行为与不加这个功能一致。
  const mcpConfigPath = options.mcpConfigPath;
  const mcpHost = mcpConfigPath
    ? new McpToolHost({
        configPath: mcpConfigPath,
        onDiagnostic: (event) =>
          telemetry.record("mcp.host", {
            channel: "system",
            stage: "action",
            status: "failed",
            code: event.code,
            details: { serverId: event.serverId },
          }),
      })
    : undefined;
  // 管理面（P7-b）：与宿主同源——保存写入后由它重新发现，不另起客户端。
  const mcpManagement =
    mcpHost && mcpConfigPath
      ? createMcpManagement({ configPath: mcpConfigPath, host: mcpHost })
      : undefined;
  const externalActions = () => [
    ...(mcpHost?.current() ?? []),
    ...(options.skillRoot ? createSkillActions(options.skillRoot) : []),
  ];
  const tasks = new AgentTaskService({
    repository: new AgentTaskRepository(business.db),
    orm: business.orm,
    executor: actionExecutor,
    actions: externalActions,
    execution,
    resolveSource: resolveDomainSource,
    telemetry,
    limits: () => {
      const { tasks: taskLimits } = execution();
      return {
        concurrency: taskLimits.concurrency,
        retentionMs: Math.round(taskLimits.retentionHours * 3_600_000),
        leaseMs: taskLimits.leaseSeconds * 1000,
        pollMs: taskLimits.pollMs,
      };
    },
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
      if (route === null) return null;
      // 能力声明是传输开关，每次调用现读：填过声明的模型按声明执行，从未填过的维持现状。
      const declared = readModelProviders(business.orm)
        .flatMap((provider) => provider.models)
        .find((entry) => entry.name === model);
      const capabilities = declared?.capabilities;
      return {
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        contextWindow: route.contextWindow,
        ...(capabilities === undefined ? {} : { toolCalling: capabilities.toolCalling }),
      };
    };
    gateway = options.gateway ?? createLmStudioClient(resolveLmStudioConfig(), { externalModel });
    const visionClient =
      options.gateway === undefined
        ? createLmStudioVisionClient(resolveLmStudioConfig(), fetch, { externalModel })
        : createLmStudioVisionClient(gateway.config, fetch, { externalModel });
    const runRepository = new AgentRunRepository(business.db);
    runRepository.expireContexts();
    runRepository.recoverInterrupted();
    telemetry.expire();
    telemetry.recover();
    agentRuntime = createAgentRuntime({
      gateway,
      vision: visionClient,
      repository: runRepository,
      telemetry,
      actionExecutor,
      researchEnabled: () => execution().research === true,
      researchLimits: () => execution().researchLimits,
      noProgressLimit: () => execution().loop.noProgress,
      codeMode: {
        runner: options.codeRunner ?? createQuickJsCodeRunner(),
        enabled: () => execution().code === true,
        limits: () => execution().codeLimits,
        allowsModel: (model) =>
          readModelProviders(business.orm).some((provider) =>
            provider.models.some(
              (entry) => entry.name === model && entry.capabilities?.codeExecution === true,
            ),
          ),
      },
      // 跨会话可以并发，但模型流量单独封顶：本地单卡安装等于"一条在飞"，外部服务可调大；
      // 服务级名额在整机帽之下再加一层（B09），同一登记服务的调用不会互相插队。
      modelCallConcurrency: () =>
        botLimits().modelCallConcurrency ?? DEFAULT_BOT_CONVERSATION_POLICY.modelCallConcurrency,
      providerConcurrency: () => execution().loop.providerConcurrency,
      providerKey: (model) => {
        if (!model) return "local";
        const provider = readModelProviders(business.orm).find((entry) =>
          entry.models.some((declared) => declared.name === model),
        );
        return provider ? `provider:${provider.id}` : "local";
      },
    });
    const journal = new ConversationEventRepository(business.db);
    journal.backfill();
    const host = new ConversationHost({ runtime: agentRuntime });
    memoryService =
      options.memoryService ??
      new MemoryService({
        orm: business.orm,
        db: business.db,
        gateway,
        agentRuntime,
        telemetry,
        enabled: () => execution().modules.memoryJobs,
        jobTimeoutMs: () => execution().maintenance.memoryTimeoutSeconds * 1000,
      });
    modules =
      options.modules ??
      createSqliteModules({
        db: business.db,
        orm: business.orm,
        gateway,
        agentRuntime,
        memoryWorker: memoryService,
        telemetry,
        knowledgeJobEnabled: () => execution().modules.knowledgeJobs,
        knowledgeJobTimeoutMs: () => execution().maintenance.knowledgeTimeoutSeconds * 1000,
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
      telemetry,
      policy: botLimits,
      modules: modules.bind,
      resolveSource,
      externalActions,
      tasks,
      stickersEnabled: () => execution().modules.qqStickers,
    });
    botWorker =
      options.botWorker ??
      new BotWorker({
        nextReadyAt: () => bot.scheduler.nextReadyAt(),
        canAdvance: () => qqIntake.state.phase === "ready",
        sweep: (nowSeconds) => {
          bot.adapter.sweep(nowSeconds);
        },
        async advance() {
          if (stopping) return;
          await bot.delivery.runOnce();
          // 车道数 = 跨会话并发上限。每条车道各自"领一条跑一条"：能不能领由数据库决定
          // （同一会话已有租约时不发第二条），车道只是把本进程的并发度用满。
          const lanes = Math.max(1, bot.scheduler.concurrencyLimit);
          await Promise.all(
            Array.from({ length: lanes }, async () => {
              while (
                !stopping &&
                qqIntake.state.phase === "ready" &&
                (await bot.scheduler.runOnce())
              ) {
                // The scheduler supplies priority, coalescing and durable leases for all topologies.
              }
            }),
          );
          await bot.delivery.runOnce();
          void bot.compression.runOnce();
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
        mediaEnabled: () => execution().modules.qqMedia,
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
      resolveSource: (source, owner, at) =>
        skillSourceAccess(options.skillRoot, source) ?? options.resolveSource?.(source, owner, at),
      qqTransportKeyPath: options.qqTransportKeyPath,
      modelProviderKeyPath: options.modelProviderKeyPath,
      // The page reads the transport's own state; nothing is inferred from a saved endpoint.
      qqConnectionState: () => qqIntake.state,
      qqStickerDirectory: options.qqStickerDirectory,
      externalActions,
      tasks,
      permissions: options.permissionConfigPath ? permissions : undefined,
      mcpManagement,
      skillsRoot: options.skillRoot,
      webMaxSteps: () => execution().loop.maxSteps,
      browserStateSecret:
        options.browserStateSecret ?? browserStateSecret(options.browserStateSecretPath),
    });
  } catch (error) {
    void telemetry.close();
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
    tasks,
    botWorker,
    qqIntake,
    start(): void {
      if (started || stopped) return;
      started = true;
      contextSweep = setInterval(() => {
        new AgentRunRepository(business.db).expireContexts();
        bot.delivery.housekeep();
        telemetry.expire();
      }, 60_000);
      contextSweep.unref();
      modules.start();
      botWorker.start();
      // Restore queued tools only after discovery has reconstructed their executable catalog.
      if (mcpHost)
        void mcpHost
          .start()
          .then(() => tasks.start())
          .catch(() => {});
      else tasks.start();
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
      await Promise.all([botWorker.stop(), bot.compression.stop(), tasks.stop()]);
      await mcpHost?.stop();
      if (started) await modules.stop();
      await telemetry.close();
      business.close();
    },
  };
}
