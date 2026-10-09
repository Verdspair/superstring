// Own the business database, model gateway and memory-worker lifetime.
// Kept separate from socket binding so tests can exercise startup and shutdown.
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Hono } from "hono";
import { executionPolicy } from "../shared/contracts/permissions";
import { ActionExecutor } from "./agent/action-executor";
import { type AgentRuntime, createAgentRuntime } from "./agent/agent-runtime";
import type { CodeRunner } from "./agent/code-runner";
import { sourceAccess } from "./agent/context-access";
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
import {
  createQqMediaInputService,
  type QqMediaInputService,
} from "./channels/onebot11/media-input-service";
import { BotWorker } from "./conversation/bot-worker";
import { AgentRunRepository } from "./db/agent-run-repository";
import { AgentTaskRepository } from "./db/agent-task-repository";
import type { BusinessDbHandle } from "./db/connection";
import { ConversationEventRepository } from "./db/conversation-event-repository";
import { readModelProviders, resolveModelProviderRoute } from "./db/model-provider-repository";
import { readOrganizationSettings } from "./db/organization-repository";
import { schemePrompts, schemeRhythm } from "./db/qq-scheme-repository";
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
import { conversationEvidenceSourceAccess } from "./modules/conversation-evidence";
import { RuntimeTelemetry } from "./observability/runtime-telemetry";
import { QqGroupCapabilityGuard } from "./permissions/qq-group-capabilities";
import {
  FilePermissionStore,
  PermissionService,
  unconfiguredPermissions,
} from "./permissions/service";
import { DEFAULT_MODEL_PROVIDER_KEY_PATH } from "./secret-box";
import { MemoryService } from "./services/memory-service";
import { QqIntakeRuntime } from "./services/qq-intake";
import { createQqMediaAdapter } from "./services/qq-media-adapter";
import { qqMediaPolicyRevision } from "./services/qq-media-contract";
import { createQqMediaSourceFetcher } from "./services/qq-media-source";
import { qqExecutionModuleSourceAccess } from "./services/qq-member-roster-sources";
import type { QqSendPort } from "./services/qq-send-transport";
import { DEFAULT_QQ_STICKER_DIRECTORY, QqStickerStore } from "./services/qq-sticker-store";
import { createSkillActions } from "./skills/actions";
import { skillSourceAccess } from "./skills/sources";
import { createWebActions } from "./web-access/actions";
import { FileWebAccessConfigStore } from "./web-access/config";

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
  /** 联网配置（web-access 单元）：端点文件；缺省＝工具只走必应、管理路由不挂载。 */
  webAccessConfigPath?: string;
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
  stop(requestDrain?: Promise<unknown>): Promise<void>;
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
  const permissions = options.permissionConfigPath
    ? new PermissionService(new FilePermissionStore(options.permissionConfigPath))
    : unconfiguredPermissions;
  // 有效执行配置（P7-c）：开关与数值分组都从这里读；消费方在各自的新 run/新任务/新领取时取值。
  const execution = () => executionPolicy(permissions.snapshot().policy);
  // 追踪保留天数在**新 trace 开始时**读取一次并冻结；已写入的 trace 不随之后的设置变化。
  const telemetry = new RuntimeTelemetry(business.db, {
    retentionDays: () => execution().telemetry.retentionDays,
  });
  const webAccess = options.webAccessConfigPath
    ? new FileWebAccessConfigStore(options.webAccessConfigPath)
    : undefined;
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
  // 本群能力停用的唯一判定面（ADR0019 §13.3）：执行、任务与来源复验共用这一个 guard。
  const qqGroupGuard = new QqGroupCapabilityGuard(business.orm);
  const actionExecutor = new ActionExecutor(
    permissions,
    () => execution().loop.readBatch,
    qqGroupGuard,
  );
  // 权限优先；本群能力其次（停用即时生效）；会话证据在技能与外部注入解析器之前，用持久存储复验。
  const resolveDomainSource: ModuleSourceResolver = (source, owner, at) =>
    qqExecutionModuleSourceAccess(
      source,
      owner,
      permissions.snapshot().revision,
      execution().modules.qqMembers,
    ) ??
    qqGroupGuard.sourceAccess(source, owner) ??
    permissions.sourceAccess(source, owner) ??
    conversationEvidenceSourceAccess(business, source, owner, at) ??
    (source.kind === "qq_media_note"
      ? sourceAccess(business.db, source, owner, { userId: owner.userId ?? "" }, at)
      : undefined) ??
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
  // 通道自带动作的唯一装配点：MCP、技能与联网工具都在这里现取一次，Web 与 QQ 两通道、
  // 任务服务与 /v2/permissions 资源投影共用这份清单；模块开关与授权在各自消费点过滤。
  const externalActions = () => [
    ...(mcpHost?.current() ?? []),
    ...createSkillActions(options.skillRoot),
    ...createWebActions(webAccess ? { config: () => webAccess.read().config } : {}),
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
        // 能力三态与修订号透传（T11）：vision 走网关的发前闸（undefined 缺席 ≠ false），
        // providerRevision 是"拒绝过图片"负缓存的指纹——声明翻转/修订后旧观察不再拦新声明。
        ...(route.vision === undefined ? {} : { vision: route.vision }),
        providerRevision: route.providerRevision,
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
      // 叶子运行（媒体/压缩/记忆整理/召回）的中央边界：绑定与停用状态由 guard 现读现判。
      assertLeaf: (owner, specId) => qqGroupGuard.assertLeaf(owner, specId),
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
      // 执行配置保存成功后的 drain：订阅权限保存通知，唤醒准入队列重判；CAS 失败不触发。
      onPolicyChange: (listener) => permissions.subscribe(listener),
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
      // 短领取后模型仍在跑：结算到达时叫醒计时循环复查别的会话 deadline，
      // 不阻塞本轮 advance，也不构成第二准入。
      onWakeSettled: () => botWorker.wake(),
      telemetry,
      policy: botLimits,
      modules: modules.bind,
      resolveSource,
      externalActions,
      tasks,
      stickersEnabled: () => execution().modules.qqStickers,
      mediaEnabled: () => execution().modules.qqMedia,
      memberTools: {
        enabled: () => execution().modules.qqMembers,
        policyRevision: () => permissions.snapshot().revision,
        sourceExpiresAt: () =>
          new Date(Date.now() + execution().telemetry.retentionDays * 86_400_000).toISOString(),
        platform: {
          list: (groupId, signal) =>
            qqIntake.connection?.getGroupMembers(groupId, signal) ??
            Promise.resolve({ kind: "unavailable" as const, reason: "not_ready" }),
          read: (groupId, userId, signal) =>
            qqIntake.connection?.getGroupMember(groupId, userId, signal) ??
            Promise.resolve({ kind: "unavailable" as const, reason: "not_ready" }),
        },
      },
      // 配置保存通知：投递车道按新发送上限 drain（与模型准入同一订阅源）。
      onPolicyChange: (listener) => permissions.subscribe(listener),
      mediaAdapter: (scheme) =>
        createQqMediaAdapter({
          prompt: schemePrompts(scheme).media,
          frames: schemeRhythm(scheme).media_frame_count,
          maxDimension: schemeRhythm(scheme).media_max_dimension,
          agentRuntime,
          fetchSource: createQqMediaSourceFetcher({
            resolveSource: (request) => qqIntake.resolveMediaSource(request),
          }),
        }),
      // T11 B 同源注入：媒体准备服务与 mediaAdapter 同侧同源——同一 agentRuntime、同一受控
      // fetchSource、同一方案 prompt；baselinePolicy 与宿主 createQqMediaTools 的
      // policyRevision 走 services/qq-media-contract.ts 的 qqMediaPolicyRevision 单一真源，
      // 本层不自算第二套策略键。
      mediaInputService: (scheme): QqMediaInputService => {
        const prompt = schemePrompts(scheme).media;
        const policyRevision = qqMediaPolicyRevision({
          prompt,
          frames: schemeRhythm(scheme).media_frame_count,
          maxDimension: schemeRhythm(scheme).media_max_dimension,
        });
        const purposes = readOrganizationSettings(business.orm);
        const sourceFetcher = createQqMediaSourceFetcher({
          resolveSource: (request) => qqIntake.resolveMediaSource(request),
        });
        return createQqMediaInputService({
          store: { db: business.db, orm: business.orm },
          fetchSource: ({ sourceRef, signal }) =>
            sourceFetcher({ kind: "image", sourceRef, signal }),
          agentRuntime,
          prompt,
          modelConfig: {
            visionModelName: purposes.vision_model_name,
            transcriptionModelName: purposes.transcription_model_name,
          },
          baselinePolicy: `baseline/v1/${policyRevision}`,
        });
      },
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
          // 短调度 tick：本轮只把最多「车道数」条唤醒启动起来，每次启动后立刻让出 I/O，
          // 于是计时器与 socket 回调不会被后台车道堵住。它不把刚启动的唤醒跑完，也不为了
          // 填满车道而连续补派——能不能领由数据库与准入决定（同一会话已有租约时不发第二条，
          // 自主接话还要看模型名额），没抢到就 break，下一轮由 onSettled／到达的通知再来。
          // 后台结算照旧走 scheduler 的租约与 onSettled，所以启动与收尾不改变并发与租约语义。
          const lanes = Math.max(1, bot.scheduler.concurrencyLimit);
          let dispatched = 0;
          for (let lane = 0; lane < lanes; lane += 1) {
            if (stopping || qqIntake.state.phase !== "ready") break;
            if (!(await bot.scheduler.dispatchOnce())) break;
            dispatched += 1;
            // 刚启动的唤醒在后台跑；此处让出一次 I/O，计时器与取消回调才能及时推进。
            await setImmediate();
          }
          if (dispatched) await bot.delivery.runOnce();
          void bot.compression.runOnce();
        },
        // 停机时先由 scheduler 同步中止在飞，再由这里等真正结算完（见 stop()）。
        drain: () => bot.scheduler.waitForIdle(),
        onError: () => console.warn("bot worker cycle failed; retrying next check"),
      });
    qqIntake =
      options.qqIntake ??
      new QqIntakeRuntime({
        orm: business.orm,
        transportKeyPath: options.qqTransportKeyPath,
        connectTimeoutMs: QQ_CONNECT_TIMEOUT_MS,
        requestTimeoutMs: QQ_REQUEST_TIMEOUT_MS,
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
        qqExecutionModuleSourceAccess(
          source,
          owner,
          permissions.snapshot().revision,
          execution().modules.qqMembers,
        ) ??
        skillSourceAccess(options.skillRoot, source) ??
        options.resolveSource?.(source, owner, at),
      qqTransportKeyPath: options.qqTransportKeyPath,
      modelProviderKeyPath: options.modelProviderKeyPath,
      // The page reads the transport's own state; nothing is inferred from a saved endpoint.
      qqConnectionState: () => qqIntake.state,
      qqStickerDirectory: options.qqStickerDirectory,
      externalActions,
      tasks,
      permissions: options.permissionConfigPath ? permissions : undefined,
      telemetryRetentionDays: () => execution().telemetry.retentionDays,
      webAccess,
      mcpManagement,
      skillsRoot: options.skillRoot,
      skillsEnabled: () => execution().modules.skills,
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
  let stopPromise: Promise<void> | null = null;
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
          .then(() => {
            if (!stopping) tasks.start();
          })
          .catch(() => {});
      else tasks.start();
      // Refuses on its own while the third-party switch is off or the saved configuration is
      // incomplete, so an unconfigured installation produces no traffic and no login.
      void qqIntake.start().catch(() => {});
    },
    stop(requestDrain: Promise<unknown> = Promise.resolve()): Promise<void> {
      if (stopPromise) return stopPromise;
      stopped = true;
      stopping = true;
      if (contextSweep !== null) clearInterval(contextSweep);
      bot.delivery.stop();
      qqIntake.stop();
      // scheduler.stop() 是同步 abort（取消在飞）；worker 的 stop() 同时停掉计时循环并等
      // scheduler.waitForIdle()（BotWorker.drain），所以在飞唤醒真正结算完才算停机。
      bot.scheduler.stop();
      // 退订模型名额通知：停机后不再有复查通知，也不留活过 runtime 的订阅。
      bot.release();
      const settling = [
        botWorker.stop(),
        bot.compression.stop(),
        tasks.stop(),
        mcpHost?.stop() ?? Promise.resolve(),
        ...(started ? [modules.stop()] : []),
        requestDrain,
      ];
      stopPromise = (async () => {
        await Promise.allSettled(settling);
        await telemetry.close();
        business.close();
      })();
      return stopPromise;
    },
  };
}
