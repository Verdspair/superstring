import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import {
  visibleConversation,
  visibleConversations,
} from "../../src/server/agent/conversation-access";
import { conversationRoutes } from "../../src/server/api/conversations";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { deleteQqBinding } from "../../src/server/db/qq-binding-removal";
import { insertQqBinding, saveQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  deleteSession,
  renameSession,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { createQqBinding, updateQqBinding } from "../../src/server/services/qq-binding-contract";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
function setup() {
  const h = openBusinessDb();
  handles.push(h);
  const session = createSession(h.orm, "initial", {
    modelName: "fixture",
    clientRequestId: "initial",
  });
  const journal = new ConversationEventRepository(h.db);
  const app = new Hono().route(
    "/v2/conversations",
    conversationRoutes(h.db, { includeShared: true }),
  );
  return { h, session, journal, app };
}

describe("conversation directory domain owner", () => {
  it("creates never-run canonical identities in source transactions and rolls both back", async () => {
    const { h, journal, app } = setup();
    const created = createSession(h.orm, "never run", {
      modelName: "fixture",
      clientRequestId: "never",
    });
    const row = h.db
      .query(
        "SELECT id FROM conversations WHERE channel='web' AND source_id=? AND closed_at IS NULL",
      )
      .get(created.id) as { id: string };
    expect(row).toBeTruthy();
    expect(
      createSession(h.orm, "never run", { modelName: "fixture", clientRequestId: "never" }).id,
    ).toBe(created.id);
    expect(
      h.db.query("SELECT count(*) AS n FROM conversations WHERE source_id=?").get(created.id),
    ).toEqual({ n: 1 });
    expect(() =>
      h.db.transaction(() => {
        createSession(h.orm, "rollback", { modelName: "fixture", clientRequestId: "rollback" });
        throw new Error("rollback fixture");
      })(),
    ).toThrow("rollback fixture");
    expect(
      h.db.query("SELECT count(*) AS n FROM sessions WHERE client_request_id='rollback'").get(),
    ).toEqual({ n: 0 });
    expect(
      h.db
        .query(
          "SELECT count(*) AS n FROM conversations WHERE source_id NOT IN (SELECT id FROM sessions) AND channel='web'",
        )
        .get(),
    ).toEqual({ n: 0 });
    renameSession(h.orm, created.id, "renamed");
    expect(visibleConversation(h.db, journal, row.id, { userId: DEFAULT_USER_ID })?.title).toBe(
      "renamed",
    );
    h.db.run("PRAGMA query_only=ON");
    try {
      const response = await app.request(`/v2/conversations?channel=web&sourceId=${created.id}`);
      expect(response.status).toBe(200);
      expect((await response.json()).items[0].id).toBe(row.id);
    } finally {
      h.db.run("PRAGMA query_only=OFF");
    }
    deleteSession(h.orm, created.id);
    expect(journal.row(row.id)?.closed_at).not.toBeNull();
    expect(visibleConversation(h.db, journal, row.id, { userId: DEFAULT_USER_ID })).toBeNull();
  });

  it("maintains QQ epochs on insert, rebind and revision-checked removal without a GET repair", () => {
    const { h, journal } = setup();
    const otherAgent = crypto.randomUUID();
    h.db
      .query(
        `INSERT INTO agents SELECT ?,name,system_prompt,description,additional_instructions,p5_config,model_name,temperature,memory_consolidation_model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_model_name,memory_retrieval_prompt,context_compression_model_name,persona_intensity,is_active,config_version,updated_at,created_at FROM agents WHERE id=?`,
      )
      .run(otherAgent, DEFAULT_AGENT_ID);
    const scheme = createQqScheme(h.orm, { name: "owner binding" });
    const draft = createQqBinding({
      id: crypto.randomUUID(),
      accountId: "10001",
      kind: "private",
      peerId: "20002",
      agentId: DEFAULT_AGENT_ID,
      schemeId: scheme.id,
      paused: false,
      shareWebMemory: false,
    });
    if (draft.kind !== "saved") throw new Error("fixture binding");
    expect(() =>
      h.db.transaction(() => {
        insertQqBinding(h.orm, draft.binding);
        throw new Error("rollback binding");
      })(),
    ).toThrow("rollback binding");
    expect(h.db.query("SELECT id FROM qq_bindings WHERE id=?").get(draft.binding.id)).toBeNull();
    expect(
      h.db.query("SELECT id FROM conversations WHERE source_id=?").get(draft.binding.id),
    ).toBeNull();
    const initial = insertQqBinding(h.orm, draft.binding);
    const first = journal.ensureOneBotActivation(initial.id)!;
    const changed = updateQqBinding(initial, { agentId: otherAgent }, initial.revision);
    if (changed.kind !== "saved") throw new Error("fixture rebind");
    const rebound = saveQqBinding(h.orm, {
      binding: changed.binding,
      expectedRevision: initial.revision,
    });
    const second = journal.ensureOneBotActivation(initial.id)!;
    expect(second.binding_epoch).toBe(first.binding_epoch + 1);
    expect(second.id).not.toBe(first.id);
    expect(journal.row(first.id)?.closed_at).not.toBeNull();
    expect(visibleConversation(h.db, journal, first.id, { userId: DEFAULT_USER_ID })).toBeNull();
    expect(() => deleteQqBinding(h.orm, initial.id, initial.revision)).toThrow();
    expect(journal.row(second.id)?.closed_at).toBeNull();
    deleteQqBinding(h.orm, initial.id, rebound.revision);
    expect(journal.row(second.id)?.closed_at).not.toBeNull();
    expect(visibleConversation(h.db, journal, second.id, { userId: DEFAULT_USER_ID })).toBeNull();
  });

  it("repairs historical sources at bootstrap without adding a write prefix to GET", async () => {
    const { h, journal } = setup();
    const source = crypto.randomUUID();
    h.db
      .query(`INSERT INTO sessions(id,user_id,agent_id,title,client_request_id,agent_config_snapshot,created_at,updated_at)
      VALUES(?,?,?,'legacy',?,'{}',?,?)`)
      .run(
        source,
        DEFAULT_USER_ID,
        DEFAULT_AGENT_ID,
        source,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    const app = new Hono().route("/v2/conversations", conversationRoutes(h.db));
    const row = h.db
      .query("SELECT id FROM conversations WHERE source_id=? AND closed_at IS NULL")
      .get(source) as { id: string };
    expect(row).toBeTruthy();
    h.db.run("PRAGMA query_only=ON");
    try {
      expect((await app.request(`/v2/conversations?channel=web&sourceId=${source}`)).status).toBe(
        200,
      );
      expect(visibleConversation(h.db, journal, row.id, { userId: DEFAULT_USER_ID })?.title).toBe(
        "legacy",
      );
    } finally {
      h.db.run("PRAGMA query_only=OFF");
    }
  });

  it("uses one authorized history projection for many IDs and keeps scalar adapters equivalent", () => {
    const { h, journal } = setup();
    const ids = Array.from({ length: 32 }, (_, n) => {
      const session = createSession(h.orm, `source ${n}`, { modelName: "fixture" });
      return journal.ensureWeb(session.id)!.id;
    });
    const scalar = ids.map((id) =>
      visibleConversation(h.db, journal, id, { userId: DEFAULT_USER_ID }),
    );
    const calls: string[] = [];
    const query = h.db.query.bind(h.db);
    const trace = spyOn(h.db, "query").mockImplementation(((sql: string) => {
      calls.push(sql);
      return query(sql);
    }) as typeof h.db.query);
    try {
      const batch = visibleConversations(h.db, journal, ids, { userId: DEFAULT_USER_ID });
      expect(ids.map((id) => batch.get(id) ?? null)).toEqual(scalar);
      expect(calls).toHaveLength(1);
    } finally {
      trace.mockRestore();
    }
    h.db
      .query("DELETE FROM sessions WHERE id=(SELECT source_id FROM conversations WHERE id=?)")
      .run(ids[0]);
    expect(visibleConversations(h.db, journal, ids, { userId: DEFAULT_USER_ID }).has(ids[0]!)).toBe(
      false,
    );
  });
});
