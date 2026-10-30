import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { visibleConversation } from "../../src/server/agent/conversation-access";
import { conversationRoutes } from "../../src/server/api/conversations";
import { handleError } from "../../src/server/api/error-handler";
import { createApp } from "../../src/server/app";
import { ConversationAvatarRepository } from "../../src/server/db/conversation-avatar-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const at = "2026-01-01T00:00:00.000Z";
const later = "2026-02-01T00:00:00.000Z";
const id = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const secondAgent = id(9, 1);
const gateway: ModelGateway = {
  config: { baseUrl: "http://synthetic.invalid", model: "fixture", timeoutSeconds: 1 },
  async loadedContextCapacity() {
    return 100_000;
  },
  async listModels() {
    return ["fixture"];
  },
  async probeModelLoaded() {
    return true;
  },
  async complete() {
    throw new Error("directory must not invoke a model");
  },
  streamChat() {
    throw new Error("directory must not invoke a model");
  },
};

function fixture(size: number) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "fixture");
  const scheme = createQqScheme(h.orm, { name: "directory fixture" });
  h.db
    .query(`INSERT INTO agents(id,name,system_prompt,description,additional_instructions,
    p5_config,model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,
    memory_retrieval_prompt,created_at,updated_at) VALUES(?,'other','s','','','{}','fixture','p','','p',?,?)`)
    .run(secondAgent, at, at);
  const journal = new ConversationEventRepository(h.db);
  const avatars = new ConversationAvatarRepository(h.db);
  const session = (n: number, agentId = DEFAULT_AGENT_ID) => {
    const source = id(1, n);
    h.db
      .query(`INSERT INTO sessions(id,user_id,agent_id,title,client_request_id,
      agent_config_snapshot,created_at,updated_at) VALUES(?,?,?,?,?,'{}',?,?)`)
      .run(source, DEFAULT_USER_ID, agentId, `web ${n}`, source, at, at);
    return source;
  };
  const binding = (n: number, kind = "group") => {
    const source = id(2, n);
    h.db
      .query(`INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,
      scheme_id,paused,created_at,updated_at) VALUES(?,'100',?,?,?,?,?,?,?)`)
      .run(source, kind, String(20000 + n), DEFAULT_AGENT_ID, scheme.id, n % 2, at, at);
    return source;
  };
  const conversation = (
    n: number,
    source: string,
    channel = "web",
    topology = "direct",
    epoch = 1,
    agentId = DEFAULT_AGENT_ID,
    closed: string | null = null,
  ) => {
    const conversationId = id(channel === "web" ? 3 : 4, n);
    h.db
      .query(`INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,
      binding_epoch,next_seq,consumed_seq,created_at,updated_at,closed_at)
      VALUES(?,?,?,?,?,?,?,7,3,?,?,?)`)
      .run(
        conversationId,
        channel,
        topology,
        source,
        agentId,
        DEFAULT_USER_ID,
        epoch,
        at,
        at,
        closed,
      );
    return conversationId;
  };
  for (let n = 1; n <= size; n++) {
    conversation(n, session(n));
    if (n % 2 === 0) {
      const kind = n % 4 === 0 ? "private" : "group";
      const source = binding(n, kind);
      const current = conversation(n, source, "onebot11", kind === "group" ? "shared" : "direct");
      if (kind === "group" && n % 6 !== 0)
        h.db
          .query(`INSERT INTO qq_group_names(account_id,group_id,qq_name,custom_name,updated_at)
          VALUES('100',?,?,?,?)`)
          .run(
            String(20000 + n),
            n % 8 ? `original ${n}` : null,
            n % 10 ? null : `custom ${n}`,
            at,
          );
      if (n % 6 === 0) {
        h.db.query("UPDATE conversations SET binding_epoch=2 WHERE id=?").run(current);
        const anchor = conversation(
          size + n,
          source,
          "onebot11",
          kind === "group" ? "shared" : "direct",
          1,
          DEFAULT_AGENT_ID,
          at,
        );
        avatars.save(anchor, { kind: "generated", style: "shapes", seed: `anchor ${n}` });
        if (n % 12 === 0) {
          h.db.query("UPDATE conversations SET binding_epoch=3 WHERE id=?").run(current);
          conversation(
            size * 2 + n,
            source,
            "onebot11",
            kind === "group" ? "shared" : "direct",
            2,
            DEFAULT_AGENT_ID,
            at,
          );
        }
      } else if (n % 4 === 0) {
        avatars.save(current, {
          bytes: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
          width: 1,
          height: 1,
          revision: `upload-${n}`,
        });
      }
    }
  }
  // Source guard: a retained unbound row must never become a directory item.
  conversation(size + 1, id(2, size + 1), "onebot11", "shared");
  const app = createApp({ business: h, gateway });
  return { h, journal, avatars, session, binding, conversation, app };
}

type Fixture = ReturnType<typeof fixture>;
// Freeze the existing single-id projection before the request under test. No private
// summary composition is copied; epoch and avatar authority stay with their owners.
function frozenProjection(
  f: Fixture,
  query: { channel?: "web" | "onebot11"; sourceId?: string; cursor?: string; limit?: number } = {},
  includeShared = true,
) {
  const page = f.journal.list({ userId: DEFAULT_USER_ID, ...query });
  return JSON.parse(
    JSON.stringify({
      ...page,
      items: page.items.flatMap((item) => {
        const visible = visibleConversation(
          f.h.db,
          f.journal,
          item.id,
          { userId: DEFAULT_USER_ID },
          includeShared,
        );
        return visible ? [{ ...visible, avatar: f.avatars.metadata(visible.id) }] : [];
      }),
    }),
  );
}

async function measured(f: Fixture, url: string) {
  const calls: string[] = [];
  const original = f.h.db.query.bind(f.h.db);
  const trace = spyOn(f.h.db, "query").mockImplementation(((sql: string) => {
    const statement = original(sql);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (
            key === "get" ||
            key === "all" ||
            key === "run" ||
            key === "values" ||
            key === "iterate"
          )
            calls.push(sql);
          return Reflect.apply(value, target, args);
        };
      },
    });
  }) as typeof f.h.db.query);
  const start = performance.now();
  try {
    const response = await f.app.request(url);
    const body = await response.json();
    return {
      status: response.status,
      body,
      ms: performance.now() - start,
      statements: calls.length,
      writes: calls.filter((sql) => /^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql)).length,
    };
  } finally {
    trace.mockRestore();
  }
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

describe("canonical directory bounded read work", () => {
  for (const size of [10, 100, 500]) {
    it(`measures ${size} sessions and keeps steady-state GET read-only`, async () => {
      const f = fixture(size);
      const url = "/v2/conversations?limit=25";
      const expected = frozenProjection(f, { limit: 25 });
      const samples = [];
      for (let n = 0; n < 5; n++) {
        const sample = await measured(f, url);
        expect(sample.status).toBe(200);
        expect(sample.body).toEqual(expected);
        samples.push(sample);
      }
      console.info(
        JSON.stringify({
          directoryReadWork: {
            size,
            bindings: Math.floor(size / 2),
            limit: 25,
            statements: samples.map((s) => s.statements),
            writes: samples.map((s) => s.writes),
            medianMs: median(samples.map((s) => s.ms)),
            projection: expected,
          },
        }),
      );
      // Unlike total_changes, query_only also rejects attempted no-op UPDATEs.
      f.h.db.run("PRAGMA query_only=ON");
      try {
        const safe = await measured(f, url);
        expect(safe.status).toBe(200);
        expect(safe.body).toEqual(expected);
        expect(safe.writes).toBe(0);
      } finally {
        f.h.db.run("PRAGMA query_only=OFF");
      }
      expect(samples.every((s) => s.writes === 0)).toBe(true);
      expect(samples.every((s) => s.statements <= 3)).toBe(true);
    });
  }

  it("preserves filters, cursors, shared visibility, history roots and fresh authority", async () => {
    const f = fixture(30);
    const first = frozenProjection(f, { limit: 7 });
    const queries = [
      { limit: 7 },
      { limit: 7, cursor: first.nextCursor },
      { channel: "web" as const, limit: 50 },
      { channel: "onebot11" as const, limit: 50 },
      { channel: "web" as const, sourceId: id(1, 1), limit: 10 },
      { channel: "onebot11" as const, sourceId: id(2, 6), limit: 10 },
    ];
    for (const query of queries) {
      const expected = frozenProjection(f, query);
      const response = await f.app.request(
        `/v2/conversations?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
    }
    const restricted = new Hono()
      .onError(handleError)
      .route("/v2/conversations", conversationRoutes(f.h.db));
    expect(await (await restricted.request("/v2/conversations?limit=50")).json()).toEqual(
      frozenProjection(f, { limit: 50 }, false),
    );
    const anchor = id(4, 36);
    expect((await (await f.app.request(`/v2/conversations/${anchor}`)).json()).lastSeq).toBe(12);
    f.h.db.query("DELETE FROM qq_bindings WHERE id=?").run(id(2, 6));
    expect((await f.app.request(`/v2/conversations/${anchor}`)).status).toBe(404);
    expect(await (await f.app.request("/v2/conversations?limit=50")).json()).toEqual(
      frozenProjection(f, { limit: 50 }),
    );
  });

  it("repairs legacy never-run sources before reads, rebinds, and advances only Web source activity", async () => {
    const f = fixture(10);
    const missingWeb = f.session(101);
    const missingQq = f.binding(102, "private");
    f.h.db.query("UPDATE sessions SET agent_id=? WHERE id=?").run(secondAgent, id(1, 1));
    f.h.db.query("UPDATE sessions SET updated_at=? WHERE id=?").run(later, id(1, 2));
    f.h.db.query("UPDATE conversations SET updated_at=? WHERE id=?").run(later, id(3, 3));
    const qqBefore = f.journal.row(id(4, 2))!;
    f.journal.reconcileSources(DEFAULT_USER_ID);
    const response = await f.app.request("/v2/conversations?limit=100");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.some((item: { sourceId: string }) => item.sourceId === missingWeb)).toBe(
      true,
    );
    expect(body.items.some((item: { sourceId: string }) => item.sourceId === missingQq)).toBe(true);
    expect(f.journal.row(id(3, 1))!.closed_at).not.toBeNull();
    const rebound = f.journal.ensureWeb(id(1, 1))!;
    expect(rebound.agentId).toBe(secondAgent);
    expect(rebound.bindingEpoch).toBe(2);
    expect(f.journal.row(rebound.id)!.source_watermark).toBe(0);
    expect(f.journal.row(id(3, 2))!.updated_at).toBe(later);
    expect(f.journal.row(id(3, 3))!.updated_at).toBe(later);
    expect(f.journal.row(id(4, 2))).toEqual(qqBefore);
    expect(body).toEqual(frozenProjection(f, { limit: 100 }));
  });
});
