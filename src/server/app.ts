import { Hono } from "hono";
import type { BrowserStateConfig } from "../shared/contracts";
import { ActionExecutor } from "./agent/action-executor";
import { type AgentRuntime, createAgentRuntime } from "./agent/agent-runtime";
import type { BuiltInAction } from "./agent/built-in-actions";
import { ConversationHost } from "./agent/conversation-host";
import type { AgentTaskService } from "./agent/task-service";
import { agentRoutes } from "./api/agents";
import { chatV2Routes } from "./api/chat-v2";
import { conversationRoutes } from "./api/conversations";
import { deliveryRoutes } from "./api/deliveries";
import { desktopRoutes } from "./api/desktop";
import { handleError } from "./api/error-handler";
import { healthRoutes } from "./api/health";
import { knowledgeRoutes } from "./api/knowledge";
import { mcpRoutes } from "./api/mcp";
import { memoryRoutes } from "./api/memories";
import { modelRoutes } from "./api/models";
import { observabilityRoutes } from "./api/observability";
import { permissionRoutes } from "./api/permissions";
import { qqRoutes } from "./api/qq";
import { runRoutes } from "./api/runs";
import { sessionRoutes } from "./api/sessions";
import { skillsRoutes } from "./api/skills";
import { webAccessRoutes } from "./api/web-access";
import { AgentRunRepository } from "./db/agent-run-repository";
import type { BusinessDbHandle } from "./db/connection";
import { ConversationEventRepository } from "./db/conversation-event-repository";
import { createLmStudioClient, type ModelGateway } from "./llm/model-gateway";
import { createLmStudioVisionClient } from "./llm/vision-client";
import type { McpManagement } from "./mcp/management";
import {
  createSqliteModules,
  type ModuleComposition,
  type ModuleSourceResolver,
} from "./modules/composition";
import { conversationEvidenceSourceAccess } from "./modules/conversation-evidence";
import { QqGroupCapabilityGuard } from "./permissions/qq-group-capabilities";
import { type PermissionService, unconfiguredPermissions } from "./permissions/service";
import {
  createQqStickerAnnotator,
  type QqStickerAnnotator,
} from "./services/qq-sticker-annotation";
import type { WebAccessConfigStore } from "./web-access/config";

export interface CreateAppOptions {
  /** Mount business routes over an already-opened database. */
  business?: BusinessDbHandle;
  /** Override the LM Studio gateway (tests inject a fake). */
  gateway?: ModelGateway;
  agentRuntime?: AgentRuntime;
  modules?: ModuleComposition;
  resolveSource?: ModuleSourceResolver;
  conversationHost?: ConversationHost;
  conversationJournal?: ConversationEventRepository;
  /** Stable per-installation browser-state secret, never logged or persisted client-side. */
  browserStateSecret?: string;
  /**
   * Key file for the stored QQ transport token. Injectable for tests, which must not write
   * the app's own state directory.
   */
  qqTransportKeyPath?: string;
  /** 外部模型 API 密钥的密钥文件（0032）；缺省走服务端默认路径。 */
  modelProviderKeyPath?: string;
  /** 已接好外部路由的视觉客户端（0032 后续）；缺省时由本函数按本地配置新建。 */
  vision?: ReturnType<typeof createLmStudioVisionClient>;
  /**
   * Directory for imported sticker copies. Injectable for the same reason; the caller that
   * resolved the app layout passes its own path.
   */
  qqStickerDirectory?: string;
  /** The multimodal transport for sticker annotation; tests inject a fake, production uses LM Studio. */
  qqStickerAnnotator?: QqStickerAnnotator;
  /** The live QQ transport state, so the settings page can report connected / not connected. */
  qqConnectionState?: () => { readonly phase: string; readonly reason?: string };
  /** 外部（MCP）动作：每轮现取；没有登记时返回空表。 */
  externalActions?: () => readonly BuiltInAction[];
  permissions?: PermissionService;
  tasks?: AgentTaskService;
  /** 联网配置存储（web-access 单元）：给了就挂 `/v2/web-access` 的读取、保存与自检。 */
  webAccess?: WebAccessConfigStore;
  /** MCP 管理端口（P7-b）：读写登记与重连都经同一宿主；缺省＝不挂管理路由。 */
  mcpManagement?: McpManagement;
  /** 技能目录根（P7-b）：给了就挂 `/v2/skills` 的目录与详情读取。 */
  skillsRoot?: string;
  /** Web 会话的主循环步数（P7-c 执行配置）；函数形式＝每轮重新读取。 */
  webMaxSteps?: () => number;
  /** 有效追踪保留天数（执行配置）；只影响新 trace，存储页据此显示当前值。 */
  telemetryRetentionDays?: () => number;
}

/** Pure Hono factory: does not open databases, start workers or bind sockets. */
export function createApp(opts: CreateAppOptions): Hono {
  const { business } = opts;
  const permissions = opts.permissions ?? unconfiguredPermissions;
  // 本群能力停用与生产共用同一个 guard；它是来源复验的第一层，只认 qq_group_capability，
  // 其余 kind 返回 undefined 继续原链；外部注入解析器仍在最后，不能把内置撤权改判为可用。
  const guard = business ? new QqGroupCapabilityGuard(business.orm) : undefined;
  // 权限与任务优先；会话证据在外部注入解析器之前，用持久存储复验。
  const resolveSource: ModuleSourceResolver = (source, owner, at) =>
    guard?.sourceAccess(source, owner) ??
    opts.tasks?.sourceAccess(source, owner) ??
    permissions.sourceAccess(source, owner) ??
    (business ? conversationEvidenceSourceAccess(business, source, owner, at) : undefined) ??
    opts.resolveSource?.(source, owner, at);
  const app = new Hono();
  app.onError(handleError);

  if (opts.browserStateSecret) {
    app.get("/browser-state/config", (c) => {
      const body: BrowserStateConfig = {
        secret: opts.browserStateSecret as string,
        storage_keys: {
          session: "superstring-session",
          agent: "superstring-agent",
        },
      };
      return c.json(body, 200, { "cache-control": "no-store" });
    });
  }

  if (business) {
    const gateway = opts.gateway ?? createLmStudioClient();
    app.route("/agents", agentRoutes(business.orm, gateway.config.model));
    app.route("/models", modelRoutes(business.orm, gateway, opts.modelProviderKeyPath));
    // The picture call goes through the vision client, which is the one place that knows how an
    // image travels to the model service (U05's decision, 2026-09-24). The sticker annotation is
    // its first caller; the media reader's adapter is the next one.
    const vision = opts.vision ?? createLmStudioVisionClient(gateway.config);
    const runRepository = new AgentRunRepository(business.db);
    const agentRuntime =
      opts.agentRuntime ??
      createAgentRuntime({
        gateway,
        vision,
        repository: runRepository,
        // 默认执行器与默认叶子边界注入同一个 guard；调用方注入的 runtime 保持原样。
        actionExecutor: new ActionExecutor(opts.permissions, undefined, guard),
        assertLeaf: guard ? (owner, specId) => guard.assertLeaf(owner, specId) : undefined,
      });
    const modules =
      opts.modules ??
      createSqliteModules({ db: business.db, orm: business.orm, gateway, agentRuntime });
    const journal = opts.conversationJournal ?? new ConversationEventRepository(business.db);
    const host = opts.conversationHost ?? new ConversationHost({ runtime: agentRuntime });
    app.route("/v2/runs", runRoutes(business.db, runRepository, { resolveSource }));
    app.route(
      "/v2/conversations",
      conversationRoutes(business.db, {
        includeShared: true,
        connectionPhase: () => opts.qqConnectionState?.().phase ?? "unavailable",
      }),
    );
    app.route(
      "/v2/observability",
      observabilityRoutes(business.db, { retentionDays: opts.telemetryRetentionDays }),
    );
    app.route("/v2/deliveries", deliveryRoutes(business.db, { includeShared: true }));
    if (opts.permissions)
      app.route(
        "/v2/permissions",
        permissionRoutes(opts.permissions, opts.externalActions ?? (() => []), opts.tasks),
      );
    if (opts.webAccess) app.route("/v2/web-access", webAccessRoutes(opts.webAccess));
    if (opts.mcpManagement) app.route("/v2/mcp", mcpRoutes(opts.mcpManagement));
    if (opts.skillsRoot) app.route("/v2/skills", skillsRoutes(opts.skillsRoot));
    app.route(
      "/",
      chatV2Routes({
        orm: business.orm,
        db: business.db,
        gateway,
        agentRuntime,
        host,
        journal,
        modules: modules.bind,
        memory: modules.memory,
        resolveSource,
        externalActions: opts.externalActions,
        tasks: opts.tasks,
        maxSteps: opts.webMaxSteps,
      }),
    );
    app.route(
      "/qq",
      qqRoutes(business.orm, {
        connectionState: opts.qqConnectionState,
        transportKeyPath: opts.qqTransportKeyPath,
        stickerDirectory: opts.qqStickerDirectory,
        gateway,
        annotator: opts.qqStickerAnnotator ?? createQqStickerAnnotator(agentRuntime),
      }),
    );
    app.route("/", desktopRoutes(business));
    app.route("/", memoryRoutes(business.orm));
    app.route("/", knowledgeRoutes(business, modules.knowledge));
    app.route("/", healthRoutes(business.db, gateway));
    app.route(
      "/",
      sessionRoutes(business.orm, business.db, gateway.config.model, gateway, agentRuntime, {
        host,
        journal,
        modules: modules.bind,
        memory: modules.memory,
        resolveSource,
        externalActions: opts.externalActions,
        tasks: opts.tasks,
      }),
    );
  }

  return app;
}
