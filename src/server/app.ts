import { Hono } from "hono";
import type { BrowserStateConfig } from "../shared/contracts";
import { agentRoutes } from "./api/agents";
import { handleError } from "./api/error-handler";
import { healthRoutes } from "./api/health";
import { knowledgeRoutes } from "./api/knowledge";
import { memoryRoutes } from "./api/memories";
import { modelRoutes } from "./api/models";
import { sessionRoutes } from "./api/sessions";
import type { BusinessDbHandle } from "./db/connection";
import { createLmStudioClient, type ModelGateway } from "./llm/model-gateway";

export interface CreateAppOptions {
  /** Mount business routes over an already-opened database. */
  business?: BusinessDbHandle;
  /** Override the LM Studio gateway (tests inject a fake). */
  gateway?: ModelGateway;
  /** Stable per-installation browser-state secret, never logged or persisted client-side. */
  browserStateSecret?: string;
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
    app.route("/models", modelRoutes(gateway));
    app.route("/", memoryRoutes(business.orm));
    app.route("/", knowledgeRoutes(business));
    app.route("/", healthRoutes(business.db, gateway));
    app.route("/", sessionRoutes(business.orm, business.db, gateway.config.model, gateway));
  }

  return app;
}
