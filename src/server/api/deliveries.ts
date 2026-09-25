import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { visibleConversation } from "../agent/conversation-access";
import { ConversationEventRepository } from "../db/conversation-event-repository";
import { OutboundIntentRepository } from "../db/outbound-intent-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import { conversationNotFound } from "./conversations";
import { parseUuidParam, validationFailed } from "./validation";

export function deliveryRoutes(db: Database, options: { includeShared?: boolean } = {}): Hono {
  const router = new Hono();
  const conversations = new ConversationEventRepository(db);
  const deliveries = new OutboundIntentRepository(db);
  const visible = (id: string) =>
    visibleConversation(db, conversations, id, { userId: DEFAULT_USER_ID }, options.includeShared);
  router.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  router.get("/", (c) => {
    const raw = c.req.query("conversationId");
    if (!raw) throw validationFailed();
    const conversationId = parseUuidParam(raw);
    const conversation = visible(conversationId);
    if (!conversation) return c.json(conversationNotFound, 404);
    return c.json({
      items: deliveries
        .list({
          conversationIds: conversations.historyRows(conversationId).map((row) => row.id),
        })
        .map((delivery) => ({ ...delivery, conversationId: conversation.id })),
    });
  });
  router.get("/:id", (c) => {
    const delivery = deliveries.get(parseUuidParam(c.req.param("id")));
    const conversation = delivery ? visible(delivery.conversationId) : null;
    if (!delivery || !conversation)
      return c.json(
        { error: { code: "DELIVERY_NOT_FOUND", message: "投递记录不存在或不可访问" } },
        404,
      );
    return c.json({ ...delivery, conversationId: conversation.id });
  });
  return router;
}
