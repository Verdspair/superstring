import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { conversationRoutes } from "../../src/server/api/conversations";
import { handleError } from "../../src/server/api/error-handler";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, DEFAULT_USER_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";

function appFor(db: ReturnType<typeof openBusinessDb>["db"]) {
  const app = new Hono();
  app.route("/", conversationRoutes(db));
  app.onError(handleError);
  return app;
}

describe("conversation memory read mode management", () => {
  it("gets and CAS-updates independent Web conversation modes without invoking a model", async () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "synthetic");
      const a = createSession(business.orm, "A", { modelName: "synthetic" }).id;
      const b = createSession(business.orm, "B", { modelName: "synthetic" }).id;
      const journal = new ConversationEventRepository(business.db);
      const ca = journal.ensureWeb(a, DEFAULT_USER_ID);
      const cb = journal.ensureWeb(b, DEFAULT_USER_ID);
      if (!ca || !cb) throw new Error("missing canonical conversations");
      const app = appFor(business.db);
      const initial = await app.request(`http://local/${ca.id}/memory-read-mode`);
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual({
        conversation_id: ca.id,
        mode: "current_conversation",
        revision: 1,
      });
      const saved = await app.request(`http://local/${ca.id}/memory-read-mode`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "agent_shared", expected_revision: 1 }),
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({
        conversation_id: ca.id,
        mode: "agent_shared",
        revision: 2,
      });
      const noOp = await app.request(`http://local/${ca.id}/memory-read-mode`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "agent_shared", expected_revision: 2 }),
      });
      expect(noOp.status).toBe(200);
      expect(await noOp.json()).toEqual({
        conversation_id: ca.id,
        mode: "agent_shared",
        revision: 2,
      });
      const back = await app.request(`http://local/${ca.id}/memory-read-mode`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "current_conversation", expected_revision: 2 }),
      });
      expect(back.status).toBe(200);
      expect(await back.json()).toEqual({
        conversation_id: ca.id,
        mode: "current_conversation",
        revision: 3,
      });
      const oldExpected = await app.request(`http://local/${ca.id}/memory-read-mode`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "agent_shared", expected_revision: 1 }),
      });
      expect(oldExpected.status).toBe(409);
      const other = await app.request(`http://local/${cb.id}/memory-read-mode`);
      expect(await other.json()).toEqual({
        conversation_id: cb.id,
        mode: "current_conversation",
        revision: 1,
      });
    } finally {
      business.close();
    }
  });

  it("rejects stale CAS and denies foreign or closed canonical conversations", async () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "synthetic");
      const session = createSession(business.orm, "A", { modelName: "synthetic" }).id;
      const foreignSession = createSession(business.orm, "B", { modelName: "synthetic" }).id;
      const journal = new ConversationEventRepository(business.db);
      const conversation = journal.ensureWeb(session, DEFAULT_USER_ID);
      const foreign = journal.ensureWeb(foreignSession, DEFAULT_USER_ID);
      if (!conversation || !foreign || conversation.id === foreign.id)
        throw new Error("fixture identity mismatch");
      const app = appFor(business.db);
      const foreignGet = await app.request(`http://local/${foreign.id}/memory-read-mode`);
      expect(foreignGet.status).toBe(200);
      const stale = await app.request(`http://local/${conversation.id}/memory-read-mode`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "agent_shared", expected_revision: 99 }),
      });
      expect(stale.status).toBe(409);
      business.db
        .query("UPDATE conversations SET closed_at=? WHERE id=?")
        .run(new Date().toISOString(), conversation.id);
      const closedGet = await app.request(`http://local/${conversation.id}/memory-read-mode`);
      expect(closedGet.status).toBe(404);
      const closedPut = await app.request(`http://local/${conversation.id}/memory-read-mode`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "agent_shared", expected_revision: 1 }),
      });
      expect(closedPut.status).toBe(404);
    } finally {
      business.close();
    }
  });
});
