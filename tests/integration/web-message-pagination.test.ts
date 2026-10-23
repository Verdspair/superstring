import { expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createApp } from "../../src/server/app";
import { createSession, getTurnByRequest, prepareTurn } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";

const gateway = {
  config: { baseUrl: "http://localhost.invalid/v1", model: "synthetic", timeoutSeconds: 60 },
  listModels: async () => ["synthetic"],
  loadedContextCapacity: async () => 32768,
  probeModelLoaded: async () => true,
  complete: async () => "unused",
  async *streamChat() {
    yield "unused";
  },
} as ModelGateway;
type Page = {
  items: { id: string; sequence_no: number; turn_id: string; role: string }[];
  has_more: boolean;
};

function fixture(count = 260) {
  const business = openBusinessDb();
  const session = createSession(business.orm, "Synthetic history", { modelName: "synthetic" });
  prepareTurn(business.orm, session.id, "First question", "request-first");
  const first = getTurnByRequest(business.orm, session.id, "request-first");
  if (!first) throw Error("Synthetic turn missing");
  const turn = business.db.query("SELECT * FROM turns WHERE id = ?").get(first.id) as {
    runtime_config_snapshot: string;
    created_at: string;
  };
  business.db
    .query("UPDATE messages SET status = 'completed' WHERE session_id = ?")
    .run(session.id);
  const insertTurn = business.db.query(
    "INSERT INTO turns (id,session_id,client_request_id,runtime_config_snapshot,created_at) VALUES (?,?,?,?,?)",
  );
  const insertMessage = business.db.query(
    "INSERT INTO messages (id,session_id,turn_id,sequence_no,role,content,status,client_request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  business.db.transaction(() => {
    for (let seq = 3; seq <= count; seq += 2) {
      const id = crypto.randomUUID(),
        request = `request-${seq}`;
      insertTurn.run(id, session.id, request, turn.runtime_config_snapshot, turn.created_at);
      insertMessage.run(
        crypto.randomUUID(),
        session.id,
        id,
        seq,
        "user",
        `Question ${seq}`,
        "completed",
        request,
        turn.created_at,
      );
      if (seq + 1 <= count)
        insertMessage.run(
          crypto.randomUUID(),
          session.id,
          id,
          seq + 1,
          "assistant",
          `Answer ${seq + 1}`,
          "completed",
          request,
          turn.created_at,
        );
    }
  })();
  const queries: string[] = [];
  const queryParams: unknown[][] = [];
  const orm = drizzle(business.db, {
    schema,
    logger: {
      logQuery(query: string, params: unknown[]) {
        queries.push(query);
        queryParams.push(params);
      },
    },
  });
  const app = createApp({ business: { ...business, orm }, gateway });
  const page = async (query = "", id = session.id): Promise<Page> => {
    const response = await app.request(`/sessions/${id}/messages${query}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Page;
  };
  return { business, session, first, queries, queryParams, app, page };
}

it("reads only latest100 with an indexed LIMIT101 probe, rather than materializing full history", async () => {
  const f = fixture(2400);
  try {
    f.queries.length = 0;
    f.queryParams.length = 0;
    const page = await f.page();
    expect(page.items).toHaveLength(100);
    expect(page.items.map((item) => item.sequence_no)).toEqual(
      Array.from({ length: 100 }, (_, i) => 2301 + i),
    );
    expect(page.has_more).toBe(true);
    const messageReads = f.queries.filter((query) => /from ["`]messages["`]/i.test(query));
    expect(messageReads).toHaveLength(1);
    expect(messageReads[0]).toMatch(/order by .*sequence_no.*desc.*limit/i);
    expect(f.queryParams[f.queries.indexOf(messageReads[0])]).toContain(101);
    const plan = f.business.db
      .query(
        "EXPLAIN QUERY PLAN SELECT * FROM messages WHERE session_id = ? ORDER BY sequence_no DESC LIMIT 101",
      )
      .all(f.session.id) as { detail: string }[];
    expect(plan.some((row) => /SEARCH messages USING INDEX/.test(row.detail))).toBe(true);
    expect(plan.some((row) => /TEMP B-TREE/.test(row.detail))).toBe(false);
  } finally {
    f.business.close();
  }
});

it("seeks older pages without duplicate IDs despite deleted sequence gaps; after pages refresh only the loaded range", async () => {
  const f = fixture();
  try {
    f.business.db
      .query("DELETE FROM messages WHERE session_id = ? AND sequence_no IN (60,170)")
      .run(f.session.id);
    const latest = await f.page();
    const older = await f.page(`?before_sequence_no=${latest.items[0].sequence_no}`);
    const oldest = await f.page(`?before_sequence_no=${older.items[0].sequence_no}`);
    const all = [...oldest.items, ...older.items, ...latest.items];
    expect(all).toHaveLength(258);
    expect(new Set(all.map((item) => item.id)).size).toBe(258);
    expect(all.map((item) => item.sequence_no)).toEqual(
      Array.from({ length: 260 }, (_, i) => i + 1).filter((seq) => seq !== 60 && seq !== 170),
    );
    expect(oldest.has_more).toBe(false);
    const refreshed = await f.page("?after_sequence_no=59");
    expect(refreshed.items[0].sequence_no).toBe(61);
    expect(refreshed.items).toHaveLength(100);
    expect(refreshed.has_more).toBe(true);
    const tail = await f.page("?after_sequence_no=260");
    expect(tail).toEqual({ items: [], has_more: false });
  } finally {
    f.business.close();
  }
});

it("keeps system rows in page cursors and retrieves offpage turn/request pairs only within their session", async () => {
  const f = fixture();
  try {
    const last = f.business.db
      .query("SELECT turn_id FROM messages WHERE session_id = ? ORDER BY sequence_no DESC LIMIT 1")
      .get(f.session.id) as { turn_id: string };
    f.business.db
      .query(
        "INSERT INTO messages (id,session_id,turn_id,sequence_no,role,content,status,client_request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        crypto.randomUUID(),
        f.session.id,
        last.turn_id,
        261,
        "system",
        "Hidden metadata",
        "completed",
        "system",
        "2026-10-01T00:00:00Z",
      );
    const latest = await f.page();
    expect(latest.items).toHaveLength(100);
    expect(latest.items.at(-1)?.role).toBe("system");
    for (const query of [`?turn_id=${f.first.id}`, "?client_request_id=request-first"]) {
      const pair = await f.page(query);
      expect(pair.items.map((item) => item.sequence_no)).toEqual([1, 2]);
      expect(pair.has_more).toBe(false);
    }
    const other = createSession(f.business.orm, "Other", { modelName: "synthetic" });
    expect(await f.page(`?turn_id=${f.first.id}`, other.id)).toEqual({
      items: [],
      has_more: false,
    });
    expect(await f.page("?client_request_id=request-first", other.id)).toEqual({
      items: [],
      has_more: false,
    });
  } finally {
    f.business.close();
  }
});

it("rejects invalid or mixed cursor and recovery parameters through the existing validation envelope", async () => {
  const f = fixture(2);
  try {
    for (const query of [
      "?after_sequence_no=",
      "?after_sequence_no=1e2",
      "?before_sequence_no=0",
      "?after_sequence_no=-1",
      "?before_sequence_no=1.5",
      "?after_sequence_no=9007199254740992",
      "?before_sequence_no=2&after_sequence_no=0",
      "?turn_id=bad",
      "?client_request_id=",
      "?limit=1000",
      "?turn_id=11111111-1111-4111-8111-111111111111&client_request_id=request-first",
    ]) {
      const response = await f.app.request(`/sessions/${f.session.id}/messages${query}`);
      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "VALIDATION_ERROR",
      );
    }
  } finally {
    f.business.close();
  }
});
