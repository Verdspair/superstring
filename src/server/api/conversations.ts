import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { ConversationChannelSchema } from "../../shared/contracts/conversation";
import { visibleConversation } from "../agent/conversation-access";
import { projectConversationEvent } from "../conversation/conversation-view";
import { ConversationEventRepository } from "../db/conversation-event-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import { parseUuidParam, validationFailed } from "./validation";

const principal = { userId: DEFAULT_USER_ID };
export const conversationNotFound = {
  error: { code: "CONVERSATION_NOT_FOUND", message: "会话不存在或不可访问" },
};

export function pageNumber(raw: string | undefined, fallback: number, minimum = 0): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw validationFailed();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw validationFailed();
  return value;
}

function pageCursor(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString());
  } catch {
    throw validationFailed();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((part) => typeof part === "string")
  )
    throw validationFailed();
  return raw;
}

/** Read projections of source facts; no second copy of conversation plaintext. */
export function conversationRoutes(db: Database, options: { includeShared?: boolean } = {}): Hono {
  const router = new Hono();
  const repository = new ConversationEventRepository(db);
  router.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  router.get("/", (c) => {
    const rawChannel = c.req.query("channel");
    const parsed =
      rawChannel === undefined ? undefined : ConversationChannelSchema.safeParse(rawChannel);
    if (parsed && !parsed.success) throw validationFailed();
    const channel = parsed?.success ? parsed.data : undefined;
    const rawSourceId = c.req.query("sourceId");
    const sourceId = rawSourceId === undefined ? undefined : parseUuidParam(rawSourceId);
    const cursor = pageCursor(c.req.query("cursor"));
    const limit = pageNumber(c.req.query("limit"), 50, 1);
    // Existing/new Web sessions receive canonical identity before the first client send.
    if (channel === "web" && sourceId) repository.ensureWeb(sourceId, principal.userId);
    if (channel === "onebot11" && sourceId) {
      const ownBinding = db
        .query(`SELECT 1 FROM qq_bindings b JOIN agents a ON a.id=b.agent_id
          WHERE b.id=?`)
        .get(sourceId);
      if (ownBinding) repository.ensureOneBot(sourceId);
    }
    const result = repository.list({ userId: principal.userId, channel, sourceId, cursor, limit });
    return c.json({
      ...result,
      items: result.items.flatMap((item) => {
        const visible = visibleConversation(
          db,
          repository,
          item.id,
          principal,
          options.includeShared,
        );
        return visible ? [visible] : [];
      }),
    });
  });
  router.get("/:id", (c) => {
    const conversation = visibleConversation(
      db,
      repository,
      parseUuidParam(c.req.param("id")),
      principal,
      options.includeShared,
    );
    return conversation ? c.json(conversation) : c.json(conversationNotFound, 404);
  });
  router.get("/:id/events", (c) => {
    const id = parseUuidParam(c.req.param("id"));
    const conversation = visibleConversation(db, repository, id, principal, options.includeShared);
    if (!conversation) return c.json(conversationNotFound, 404);
    const after = pageNumber(c.req.query("afterSeq"), 0);
    const limit = pageNumber(c.req.query("limit"), 100, 1);
    const result = repository.historyAfter(id, after, limit);
    return c.json({
      ...result,
      items: result.items.map(({ event, seq }) => ({
        ...projectConversationEvent(db, event),
        conversationId: conversation.id,
        seq,
      })),
    });
  });
  return router;
}
