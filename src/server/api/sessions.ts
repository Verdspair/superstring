import type { AgentRuntime } from "../agent/agent-runtime";
// Session, message and health routes. Behaviours that must not drift:
// - `POST /sessions` is idempotent on `client_request_id` and answers 201.
// - `DELETE /sessions/{id}/messages/{mid}` answers 204 with the three
// `X-Superstring-Turn-*` headers, not a JSON body.
// - `GET /sessions/{id}/messages` returns messages ordered by `sequence_no`.
// - `DELETE /sessions/{id}` also cancels any in-flight generation before the
// session row disappears.

import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { RuntimeConfig } from "../../shared/contracts";
import {
  ChatRequestSchema,
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
} from "../../shared/contracts";
import type { WebChannelOptions } from "../channels/web-channel";
import {
  createSession,
  deleteMessage as deleteMessageRow,
  deleteSession,
  getRuntimeConfig,
  getSession,
  listMessages as listMessageRows,
  listSessions as listSessionRows,
  type Orm,
  renameSession,
} from "../db/repositories";
import { DatabaseUnavailableError, isAppError } from "../errors";
import type { ModelGateway } from "../llm/model-gateway";
import { DirectService } from "../services/direct-service";
import { isDatabaseError } from "./error-handler";
import { createSseResponse } from "./sse";
import { parseBody, parseUuidParam, readJsonBody } from "./validation";

function toSessionResponse(row: {
  id: string;
  title: string;
  agentId: string;
  mode: string;
  configVersion: number;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: row.id,
    title: row.title,
    agent_id: row.agentId,
    mode: row.mode,
    config_version: row.configVersion,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function toMessageResponse(row: {
  id: string;
  role: string;
  content: string;
  status: string;
  errorCode: string | null;
  sequenceNo: number;
  turnId: string;
  createdAt: string;
  completedAt: string | null;
}) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    error_code: row.errorCode,
    sequence_no: row.sequenceNo,
    turn_id: row.turnId,
    created_at: row.createdAt,
    completed_at: row.completedAt,
  };
}

/**
 * Session deletion refuses to drop a session that still
 * has an active generation only implicitly; here the repository delete already
 * cascades. Exposed separately so the chat service can reuse it.
 */
export function sessionRoutes(
  orm: Orm,
  db: Database,
  defaultModelName: string,
  gateway: ModelGateway,
  agentRuntime?: AgentRuntime,
  conversation?: Pick<
    WebChannelOptions,
    "host" | "journal" | "maxSteps" | "modules" | "resolveSource" | "memory"
  >,
): Hono {
  const router = new Hono();

  // 234
  router.post("/sessions", async (c) => {
    const body = parseBody(CreateSessionRequestSchema, await readJsonBody(c.req.raw));
    const row = createSession(orm, body.title, {
      agentId: body.agent_id,
      mode: body.mode,
      clientRequestId: body.client_request_id,
      // the seeded default agent takes the configured
      // conversation model, never an empty string.
      modelName: defaultModelName,
    });
    return c.json(toSessionResponse(row), 201);
  });

  // 242
  router.get("/sessions", (c) => c.json(listSessionRows(orm).map(toSessionResponse)));

  // 247
  router.get("/sessions/:sessionId", (c) =>
    c.json(toSessionResponse(getSession(orm, parseUuidParam(c.req.param("sessionId"))))),
  );

  // 257
  router.patch("/sessions/:sessionId", async (c) => {
    const sessionId = parseUuidParam(c.req.param("sessionId"));
    const body = parseBody(UpdateSessionRequestSchema, await readJsonBody(c.req.raw));
    return c.json(toSessionResponse(renameSession(orm, sessionId, body.title)));
  });

  // 262
  router.get("/sessions/:sessionId/runtime-config", (c) => {
    const sessionId = parseUuidParam(c.req.param("sessionId"));
    const runtime: RuntimeConfig = getRuntimeConfig(orm, sessionId);
    return c.json(runtime);
  });

  // 269
  router.delete("/sessions/:sessionId", (c) => {
    deleteSession(orm, parseUuidParam(c.req.param("sessionId")));
    return c.body(null, 204);
  });

  // headers carry the turn invalidation result.
  router.delete("/sessions/:sessionId/messages/:messageId", (c) => {
    const sessionId = parseUuidParam(c.req.param("sessionId"));
    const messageId = parseUuidParam(c.req.param("messageId"));
    const result = deleteMessageRow(orm, sessionId, messageId);
    c.header("X-Superstring-Turn-Id", result.turnId);
    c.header("X-Superstring-Turn-Context-Valid", "false");
    c.header("X-Superstring-Turn-Source-Valid", "false");
    return c.body(null, 204);
  });

  // 302
  router.get("/sessions/:sessionId/messages", (c) => {
    const sessionId = parseUuidParam(c.req.param("sessionId"));
    return c.json(listMessageRows(orm, sessionId).map(toMessageResponse));
  });

  /**
   * `POST /chat`. The legacy streaming contract, also used for retries.
   * Error handling has three distinct exits, and they are NOT interchangeable:
   * - an `AppError` raised while streaming → SSE `error` carrying its code;
   * - a storage failure → SSE `error` carrying DATABASE_UNAVAILABLE;
   * - the stream ending without a `done` and without an error → the
   * `MESSAGE_PERSISTENCE_ERROR` fallback, which exists so a client can
   * never be left believing an unsaved answer succeeded.
   */
  router.post("/chat", async (c) => {
    const body = parseBody(ChatRequestSchema, await readJsonBody(c.req.raw));
    const requestId = crypto.randomUUID();
    // Production path: injecting `db` activates ContextBuilder. Omitting it is
    // reserved for DirectService's explicit low-level fixture fallback.
    let sendContext:
      | ((usage: import("../../shared/contracts/context-usage").ContextUsage) => void)
      | undefined;
    const service = new DirectService({
      ...conversation,
      orm,
      db,
      gateway,
      agentRuntime,
      onContextUsage: (usage) => sendContext?.(usage),
    });

    // Awaited BEFORE opening the stream, so a rejected turn
    // SESSION_NOT_FOUND, IDEMPOTENCY_CONFLICT, GENERATION_ALREADY_ACTIVE
    // SESSION_GENERATION_BUSY, MODE_NOT_AVAILABLE — surfaces as a normal JSON
    // HTTP error rather than an SSE `error` inside a 200 response.
    const clientAbort = new AbortController();
    const reply = await service.openReply({
      sessionId: body.session_id,
      message: body.message,
      clientRequestId: body.client_request_id,
      signal: clientAbort.signal,
    });

    return createSseResponse(
      { requestSignal: c.req.raw.signal, onDisconnect: () => clientAbort.abort() },
      async (stream) => {
        const send = stream.send;
        sendContext = (usage) => {
          if (c.req.header("X-Superstring-Context-Usage") === "1")
            send("context", { request_id: requestId, usage });
        };
        send("start", { request_id: requestId, session_id: body.session_id });
        let terminal = false;
        try {
          for await (const event of reply) {
            if (event.kind === "delta") {
              send("delta", { request_id: requestId, text: event.text });
            } else {
              terminal = true;
              send("done", {
                request_id: requestId,
                message_id: event.messageId,
                created_at: event.createdAt,
                completed_at: event.completedAt,
              });
              break;
            }
          }
        } catch (error) {
          terminal = true;
          if (stream.cancelled) {
            // DirectService already persisted CLIENT_DISCONNECTED. No terminal
            // event can be delivered to a disconnected consumer.
          } else if (isAppError(error)) {
            send("error", {
              request_id: requestId,
              code: error.code,
              message: error.message,
            });
          } else if (isDatabaseError(error)) {
            const dbError = new DatabaseUnavailableError();
            send("error", {
              request_id: requestId,
              code: dbError.code,
              message: dbError.message,
            });
          } else {
            send("error", {
              request_id: requestId,
              code: "MESSAGE_PERSISTENCE_ERROR",
              message: "助手消息未能确认保存，请重试",
            });
          }
        }
        if (!terminal) {
          // A stream that simply stops must never look like saved success.
          send("error", {
            request_id: requestId,
            code: "MESSAGE_PERSISTENCE_ERROR",
            message: "助手消息未能确认保存，请重试",
          });
        }
      },
    );
  });

  return router;
}
