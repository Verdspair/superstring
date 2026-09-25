import { Hono } from "hono";
import type { BrowserStateConfig } from "../shared/contracts";
import { agentRoutes } from "./api/agents";
import { desktopRoutes } from "./api/desktop";
import { handleError } from "./api/error-handler";
import { healthRoutes } from "./api/health";
import { knowledgeRoutes } from "./api/knowledge";
import { memoryRoutes } from "./api/memories";
import { modelRoutes } from "./api/models";
import { qqRoutes } from "./api/qq";
import { sessionRoutes } from "./api/sessions";
import type { BusinessDbHandle } from "./db/connection";
import { createLmStudioClient, type ModelGateway } from "./llm/model-gateway";
import { createLmStudioVisionClient } from "./llm/vision-client";
import {
  QQ_STICKER_ANNOTATION_RESPONSE_SCHEMA,
  type QqStickerAnnotator,
} from "./services/qq-sticker-annotation";

export interface CreateAppOptions {
  /** Mount business routes over an already-opened database. */
  business?: BusinessDbHandle;
  /** Override the LM Studio gateway (tests inject a fake). */
  gateway?: ModelGateway;
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
}

/** Pure Hono factory: does not open databases, start workers or bind sockets. */
export function createApp(opts: CreateAppOptions): Hono {
  const { business } = opts;
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
    app.route(
      "/qq",
      qqRoutes(business.orm, {
        connectionState: opts.qqConnectionState,
        transportKeyPath: opts.qqTransportKeyPath,
        stickerDirectory: opts.qqStickerDirectory,
        gateway,
        annotator:
          opts.qqStickerAnnotator ??
          ((input) =>
            vision.annotate({ ...input, responseSchema: QQ_STICKER_ANNOTATION_RESPONSE_SCHEMA })),
      }),
    );
    app.route("/", desktopRoutes(business));
    app.route("/", memoryRoutes(business.orm));
    app.route("/", knowledgeRoutes(business));
    app.route("/", healthRoutes(business.db, gateway));
    app.route("/", sessionRoutes(business.orm, business.db, gateway.config.model, gateway));
  }

  return app;
}
