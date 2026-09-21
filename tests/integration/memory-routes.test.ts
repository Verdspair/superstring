// Memory (P4) route tests — `GET/PATCH /agents/:id/memory/**`, api-contract §1.4.
//
// These 13 routes are the governance surface for agent-owned memory: policy,
// source turns, entries, jobs and the three governance actions. The behaviours
// asserted here are the ones that silently corrupt data when they drift:
// governance-epoch invalidation, idempotent enqueue, "assert full resolution"
// on id selections, and purge's job cleanup.
//
// A live model is never called — the job worker is out of scope here (R4); these
// tests cover the *queue*, not the execution.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server/app";
import { memoryContent } from "../../src/server/db/memory-content-repository";
import { claim, enqueue, publish } from "../../src/server/db/memory-repository";
import {
  DEFAULT_USER_ID,
  getTurnByRequest,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { MemoryContentResponseSchema } from "../../src/shared/contracts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UNKNOWN = "99999999-9999-4999-8999-999999999999";

function makeApp() {
  const business = openBusinessDb();
  const app = createApp({ business });
  return { app, business };
}

type App = ReturnType<typeof makeApp>["app"];
type Orm = ReturnType<typeof makeApp>["business"]["orm"];

function json(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function call(app: App, path: string, init?: RequestInit): Promise<Response> {
  return app.request(`http://x${path}`, init);
}

/** Seed the built-in default agent via the documented path (GET /agents). */
async function seedAgent(app: App): Promise<string> {
  await call(app, "/agents");
  return "00000000-0000-0000-0000-000000000001";
}

/** Create a session bound to the default agent. */
async function newSession(app: App, title = "会话"): Promise<string> {
  const res = await call(app, "/sessions", json({ title }));
  return ((await res.json()) as { id: string }).id;
}

/**
 * Build a COMPLETED turn (both messages completed, generation completed) — the
 * only shape `memory_repository.turns` accepts as a memory source.
 */
function completedTurn(orm: Orm, sessionId: string, requestKey: string, text = "嗨") {
  const prep = prepareTurn(orm, sessionId, text, requestKey);
  const token = prep.generationToken;
  if (token === null) throw new Error("expected a fresh generation token");
  saveCompletedAssistantMessage(orm, sessionId, "你好", requestKey, token);
  const turn = getTurnByRequest(orm, sessionId, requestKey);
  if (!turn) throw new Error("expected the turn to exist");
  return turn;
}

/** Insert a memory entry backed by real, still-valid sources. */
function seedEntry(orm: Orm, agentId: string, turnId: string, name: string): string {
  const id = crypto.randomUUID();
  const messages = orm
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.turnId, turnId))
    .all();
  const userMsg = messages.find((m) => m.role === "user");
  const assistantMsg = messages.find((m) => m.role === "assistant");
  if (!userMsg || !assistantMsg) throw new Error("expected both messages");
  orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId,
      userId: DEFAULT_USER_ID,
      name,
      summary: "简介",
      tags: JSON.stringify(["t"]),
      kinds: JSON.stringify(["semantic"]),
      body: "正文",
      scope: "reality_user",
      scopeKey: agentId,
      status: "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
    })
    .run();
  orm
    .insert(schema.memorySources)
    .values({
      memoryId: id,
      turnId,
      userMessageId: userMsg.id,
      assistantMessageId: assistantMsg.id,
      sequenceNo: userMsg.sequenceNo,
    })
    .run();
  return id;
}

describe("memory policy", () => {
  it("auto-creates the policy on first GET with the documented defaults", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);

    const res = await call(app, `/agents/${id}/memory/policy`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      auto_enabled: false,
      every_turns: 20,
      target_chars: 1200,
      version: 1,
    });
  });

  it("404s for an unknown agent", async () => {
    const { app } = makeApp();
    const res = await call(app, `/agents/${UNKNOWN}/memory/policy`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AGENT_NOT_FOUND");
  });

  it("422s for a non-uuid agent id (FastAPI rejects the path first)", async () => {
    const { app } = makeApp();
    const res = await call(app, "/agents/not-a-uuid/memory/policy");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("PATCH bumps the version and echoes the new state", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);

    const res = await call(
      app,
      `/agents/${id}/memory/policy`,
      json({ auto_enabled: true, every_turns: 5, target_chars: 500, expected_version: 1 }, "PATCH"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      auto_enabled: true,
      every_turns: 5,
      target_chars: 500,
      version: 2,
    });
  });

  it("PATCH with a stale expected_version is 409 MEMORY_POLICY_CONFLICT and writes nothing", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);
    await call(app, `/agents/${id}/memory/policy`); // create at version 1

    const res = await call(
      app,
      `/agents/${id}/memory/policy`,
      json({ auto_enabled: true, every_turns: 5, target_chars: 500, expected_version: 7 }, "PATCH"),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "MEMORY_POLICY_CONFLICT",
    );

    const after = (await (await call(app, `/agents/${id}/memory/policy`)).json()) as {
      version: number;
      auto_enabled: boolean;
    };
    expect(after.version).toBe(1);
    expect(after.auto_enabled).toBe(false);
  });

  it("PATCH rejects out-of-range every_turns / target_chars with 422", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);
    const base = { auto_enabled: true, expected_version: 1 };
    for (const bad of [
      { every_turns: 0 },
      { every_turns: 201 },
      { target_chars: 49 },
      { target_chars: 4001 },
    ]) {
      const res = await call(
        app,
        `/agents/${id}/memory/policy`,
        json({ ...base, every_turns: 20, target_chars: 300, ...bad }, "PATCH"),
      );
      expect(res.status).toBe(422);
    }
  });
});

describe("memory sessions, turns and scope", () => {
  it("lists only the agent's own sessions", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);
    const s1 = await newSession(app, "第一");
    await newSession(app, "第二");

    // A session owned by a DIFFERENT agent must not appear. The agent has to be
    // real: `sessions.agent_id` is an enforced foreign key.
    const other = (await (
      await call(app, "/agents", json({ name: "另一个", model_name: "qwen/qwen3-4b-2507" }))
    ).json()) as { id: string };
    await call(app, "/sessions", json({ title: "别人的", agent_id: other.id }));

    const rows = (await (await call(app, `/agents/${id}/memory/sessions`)).json()) as Array<{
      id: string;
      title: string;
    }>;
    expect(rows.map((r) => r.title).sort()).toEqual(["第一", "第二"]);
    expect(rows.some((r) => r.id === s1)).toBe(true);
  });

  it("returns completed turns newest-first with processed=false and the default scope", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    completedTurn(business.orm, sessionId, "k1", "第一个问题");
    completedTurn(business.orm, sessionId, "k2", "第二个问题");

    const body = (await (
      await call(app, `/agents/${id}/memory/sessions/${sessionId}/turns`)
    ).json()) as { scope: string; turns: Array<Record<string, unknown>> };

    expect(body.scope).toBe("reality_user");
    expect(body.turns.map((t) => t.user)).toEqual(["第二个问题", "第一个问题"]);
    expect(body.turns.every((t) => t.processed === false)).toBe(true);
    expect(Object.keys(body.turns[0]).sort()).toEqual([
      "assistant",
      "id",
      "processed",
      "sequence_no",
      "user",
    ]);
  });

  it("honours the limit and 422s an out-of-range one", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    for (const k of ["k1", "k2", "k3"]) completedTurn(business.orm, sessionId, k);

    const limited = (await (
      await call(app, `/agents/${id}/memory/sessions/${sessionId}/turns?limit=2`)
    ).json()) as { turns: unknown[] };
    expect(limited.turns).toHaveLength(2);

    expect(
      (await call(app, `/agents/${id}/memory/sessions/${sessionId}/turns?limit=0`)).status,
    ).toBe(422);
    expect(
      (await call(app, `/agents/${id}/memory/sessions/${sessionId}/turns?limit=201`)).status,
    ).toBe(422);
    expect(
      (await call(app, `/agents/${id}/memory/sessions/${sessionId}/turns?limit=abc`)).status,
    ).toBe(422);
  });

  it("404s MEMORY_SOURCE_FORBIDDEN for a session the agent does not own", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);
    const res = await call(app, `/agents/${id}/memory/sessions/${UNKNOWN}/turns`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "MEMORY_SOURCE_FORBIDDEN",
    );
  });

  it("PATCH scope records the label and is reflected by a later read", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);

    const res = await call(
      app,
      `/agents/${id}/memory/sessions/${sessionId}/scope`,
      json({ scope: "roleplay_world" }, "PATCH"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scope: "roleplay_world" });

    const after = (await (
      await call(app, `/agents/${id}/memory/sessions/${sessionId}/turns`)
    ).json()) as { scope: string };
    expect(after.scope).toBe("roleplay_world");
  });

  it("PATCH scope rejects an illegal enum with 422", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const res = await call(
      app,
      `/agents/${id}/memory/sessions/${sessionId}/scope`,
      json({ scope: "global" }, "PATCH"),
    );
    expect(res.status).toBe(422);
  });
});

describe("memory entries", () => {
  it("returns an empty page for a fresh agent", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);
    expect(await (await call(app, `/agents/${id}/memory/entries`)).json()).toEqual({
      total: 0,
      items: [],
    });
  });

  it("lists entries and paginates AFTER the ordered full list", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    seedEntry(business.orm, id, turn.id, "甲");
    seedEntry(business.orm, id, turn.id, "乙");
    seedEntry(business.orm, id, turn.id, "丙");

    const all = (await (await call(app, `/agents/${id}/memory/entries`)).json()) as {
      total: number;
      items: Array<Record<string, unknown>>;
    };
    expect(all.total).toBe(3);
    expect(all.items[0].tags).toEqual(["t"]);
    expect(all.items[0].kinds).toEqual(["semantic"]);

    const page = (await (
      await call(app, `/agents/${id}/memory/entries?offset=1&limit=1`)
    ).json()) as { total: number; items: unknown[] };
    expect(page.total).toBe(3); // total is the UNPAGINATED count
    expect(page.items).toHaveLength(1);
  });

  it("returns entry detail with body and config_snapshot", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    const memoryId = seedEntry(business.orm, id, turn.id, "甲");

    const detail = (await (
      await call(app, `/agents/${id}/memory/entries/${memoryId}`)
    ).json()) as Record<string, unknown>;
    expect(detail.name).toBe("甲");
    expect(detail.body).toBe("正文");
    expect(detail.config_snapshot).toEqual({});
    expect(Object.keys(detail).sort()).toEqual([
      "body",
      "config_snapshot",
      "created_at",
      "id",
      "kinds",
      "name",
      "scope",
      "scope_key",
      "status",
      "summary",
      "tags",
    ]);
  });

  it("404s MEMORY_NOT_FOUND for an unknown entry id", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);
    const res = await call(app, `/agents/${id}/memory/entries/${UNKNOWN}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MEMORY_NOT_FOUND");
  });
});

describe("consolidate (manual) jobs", () => {
  it("enqueues a queued manual job with 202 and a full job_view", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");

    const res = await call(
      app,
      `/agents/${id}/memory/consolidate`,
      json({ request_key: "req-1", session_id: sessionId, turn_ids: [turn.id] }),
    );
    expect(res.status).toBe(202);
    const job = (await res.json()) as Record<string, unknown>;
    expect(job.status).toBe("queued");
    expect(job.kind).toBe("manual");
    expect(job.session_id).toBe(sessionId);
    expect(job.result_id).toBeNull();
    expect(job.finished_at).toBeNull();
    expect(Object.keys(job).sort()).toEqual([
      "created_at",
      "error_code",
      "finished_at",
      "id",
      "kind",
      "result_id",
      "session_id",
      "status",
    ]);
  });

  it("replays the SAME job for a repeated request_key with an identical payload", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    const body = { request_key: "req-1", session_id: sessionId, turn_ids: [turn.id] };

    const first = (await (
      await call(app, `/agents/${id}/memory/consolidate`, json(body))
    ).json()) as {
      id: string;
    };
    const second = (await (
      await call(app, `/agents/${id}/memory/consolidate`, json(body))
    ).json()) as {
      id: string;
    };
    expect(second.id).toBe(first.id);
  });

  it("409s MEMORY_REQUEST_CONFLICT for the same key with a different payload", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const t1 = completedTurn(business.orm, sessionId, "k1");
    const t2 = completedTurn(business.orm, sessionId, "k2");

    await call(
      app,
      `/agents/${id}/memory/consolidate`,
      json({ request_key: "req-1", session_id: sessionId, turn_ids: [t1.id] }),
    );
    const res = await call(
      app,
      `/agents/${id}/memory/consolidate`,
      json({ request_key: "req-1", session_id: sessionId, turn_ids: [t2.id] }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "MEMORY_REQUEST_CONFLICT",
    );
  });

  it("409s MEMORY_BUSY while another job is still queued", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");

    await call(
      app,
      `/agents/${id}/memory/consolidate`,
      json({ request_key: "req-1", session_id: sessionId, turn_ids: [turn.id] }),
    );
    const res = await call(
      app,
      `/agents/${id}/memory/consolidate`,
      json({ request_key: "req-2", session_id: sessionId, turn_ids: [turn.id] }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MEMORY_BUSY");
  });

  it("409s MEMORY_SOURCE_INVALID when any selected turn is not a valid completed pair", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");

    const res = await call(
      app,
      `/agents/${id}/memory/consolidate`,
      json({ request_key: "req-1", session_id: sessionId, turn_ids: [turn.id, UNKNOWN] }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "MEMORY_SOURCE_INVALID",
    );
  });

  it("422s on duplicate turn_ids (contract-level de-duplication)", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    const res = await call(
      app,
      `/agents/${id}/memory/consolidate`,
      json({ request_key: "req-1", session_id: sessionId, turn_ids: [turn.id, turn.id] }),
    );
    expect(res.status).toBe(422);
  });

  it("422s on a request_key with illegal characters or an empty turn list", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    for (const body of [
      { request_key: "bad key", session_id: sessionId, turn_ids: [turn.id] },
      { request_key: "req", session_id: sessionId, turn_ids: [] },
    ]) {
      expect((await call(app, `/agents/${id}/memory/consolidate`, json(body))).status).toBe(422);
    }
  });
});

describe("merge jobs", () => {
  it("enqueues a merge with session_id NULL (regression: nullable job session)", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    const a = seedEntry(business.orm, id, turn.id, "甲");
    const b = seedEntry(business.orm, id, turn.id, "乙");

    const res = await call(
      app,
      `/agents/${id}/memory/merge`,
      json({ request_key: "m-1", memory_ids: [a, b] }),
    );
    expect(res.status).toBe(202);
    const job = (await res.json()) as Record<string, unknown>;
    expect(job.kind).toBe("merge");
    expect(job.session_id).toBeNull();
  });

  it("422s with fewer than two memory_ids", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);
    const res = await call(
      app,
      `/agents/${id}/memory/merge`,
      json({ request_key: "m-1", memory_ids: [UUID_A] }),
    );
    expect(res.status).toBe(422);
  });

  it("404s MEMORY_NOT_FOUND when a selected entry does not exist", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);
    const res = await call(
      app,
      `/agents/${id}/memory/merge`,
      json({ request_key: "m-1", memory_ids: [UUID_A, UUID_B] }),
    );
    expect(res.status).toBe(404);
  });

  it("409s MEMORY_STATE_CONFLICT when a selected entry is not active", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    const a = seedEntry(business.orm, id, turn.id, "甲");
    const b = seedEntry(business.orm, id, turn.id, "乙");
    business.orm
      .update(schema.memoryEntries)
      .set({ status: "suppressed" })
      .where(eq(schema.memoryEntries.id, b))
      .run();

    const res = await call(
      app,
      `/agents/${id}/memory/merge`,
      json({ request_key: "m-1", memory_ids: [a, b] }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "MEMORY_STATE_CONFLICT",
    );
  });
});

describe("govern", () => {
  it("suppresses entries and reports the affected count", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    const a = seedEntry(business.orm, id, turn.id, "甲");
    const b = seedEntry(business.orm, id, turn.id, "乙");

    const res = await call(
      app,
      `/agents/${id}/memory/govern`,
      json({ memory_ids: [a, b], action: "suppress" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ affected: 2, action: "suppress" });

    const items = (await (await call(app, `/agents/${id}/memory/entries`)).json()) as {
      items: Array<{ status: string }>;
    };
    expect(items.items.every((i) => i.status === "suppressed")).toBe(true);
  });

  it("re-enables a suppressed entry", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    const a = seedEntry(business.orm, id, turn.id, "甲");

    await call(app, `/agents/${id}/memory/govern`, json({ memory_ids: [a], action: "suppress" }));
    const res = await call(
      app,
      `/agents/${id}/memory/govern`,
      json({ memory_ids: [a], action: "enable" }),
    );
    expect(res.status).toBe(200);
    const detail = (await (await call(app, `/agents/${id}/memory/entries/${a}`)).json()) as {
      status: string;
    };
    expect(detail.status).toBe("active");
  });

  it("fails queued jobs with MEMORY_GOVERNANCE_CHANGED when facts move", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    const a = seedEntry(business.orm, id, turn.id, "甲");

    await call(
      app,
      `/agents/${id}/memory/consolidate`,
      json({ request_key: "req-1", session_id: sessionId, turn_ids: [turn.id] }),
    );
    await call(app, `/agents/${id}/memory/govern`, json({ memory_ids: [a], action: "suppress" }));

    const jobs = (await (await call(app, `/agents/${id}/memory/jobs`)).json()) as Array<{
      status: string;
      error_code: string | null;
    }>;
    expect(jobs[0].status).toBe("failed");
    expect(jobs[0].error_code).toBe("MEMORY_GOVERNANCE_CHANGED");
  });

  it("purge requires confirm_permanent=true (422) and then hard-deletes", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    const a = seedEntry(business.orm, id, turn.id, "甲");

    const refused = await call(
      app,
      `/agents/${id}/memory/govern`,
      json({ memory_ids: [a], action: "purge" }),
    );
    expect(refused.status).toBe(422);

    const ok = await call(
      app,
      `/agents/${id}/memory/govern`,
      json({ memory_ids: [a], action: "purge", confirm_permanent: true }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ affected: 1, action: "purge" });

    // Hard delete removes the entry and its sources (FK cascade) but the
    // completed turn itself survives.
    expect(
      business.orm.select().from(schema.memoryEntries).where(eq(schema.memoryEntries.id, a)).get(),
    ).toBeUndefined();
    expect(
      business.orm
        .select()
        .from(schema.memorySources)
        .where(eq(schema.memorySources.memoryId, a))
        .all(),
    ).toHaveLength(0);
    expect(
      business.orm.select().from(schema.turns).where(eq(schema.turns.id, turn.id)).get(),
    ).toBeDefined();
  });

  it("422s when memory_ids is missing (field is required, not defaulted)", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);
    const res = await call(app, `/agents/${id}/memory/govern`, json({ action: "suppress" }));
    expect(res.status).toBe(422);
  });
});

describe("job inspection and retry", () => {
  it("lists jobs newest-first", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    expect(await (await call(app, `/agents/${id}/memory/jobs`)).json()).toEqual([]);

    await call(
      app,
      `/agents/${id}/memory/consolidate`,
      json({ request_key: "req-1", session_id: sessionId, turn_ids: [turn.id] }),
    );
    const jobs = (await (await call(app, `/agents/${id}/memory/jobs`)).json()) as unknown[];
    expect(jobs).toHaveLength(1);
  });

  it("404s MEMORY_JOB_NOT_FOUND for an unknown job", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);
    const res = await call(app, `/agents/${id}/memory/jobs/${UNKNOWN}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "MEMORY_JOB_NOT_FOUND",
    );
  });

  it("409s MEMORY_STATE_CONFLICT when retrying a job that is not failed", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    const job = (await (
      await call(
        app,
        `/agents/${id}/memory/consolidate`,
        json({ request_key: "req-1", session_id: sessionId, turn_ids: [turn.id] }),
      )
    ).json()) as { id: string };

    const res = await call(app, `/agents/${id}/memory/jobs/${job.id}/retry`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "MEMORY_STATE_CONFLICT",
    );
  });

  it("retries a FAILED job back to queued with 202 and clears error_code/finished_at", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    const job = (await (
      await call(
        app,
        `/agents/${id}/memory/consolidate`,
        json({ request_key: "req-1", session_id: sessionId, turn_ids: [turn.id] }),
      )
    ).json()) as { id: string };

    // Drive it to failed WITHOUT moving the governance epoch.
    business.orm
      .update(schema.memoryJobs)
      .set({ status: "failed", errorCode: "MEMORY_TIMEOUT", finishedAt: nowIso() })
      .where(eq(schema.memoryJobs.id, job.id))
      .run();

    const res = await call(app, `/agents/${id}/memory/jobs/${job.id}/retry`, { method: "POST" });
    expect(res.status).toBe(202);
    const retried = (await res.json()) as Record<string, unknown>;
    expect(retried.status).toBe("queued");
    expect(retried.error_code).toBeNull();
    expect(retried.finished_at).toBeNull();
  });

  it("409s MEMORY_SOURCE_CHANGED when governance moved after the failure", async () => {
    const { app, business } = makeApp();
    const id = await seedAgent(app);
    const sessionId = await newSession(app);
    const turn = completedTurn(business.orm, sessionId, "k1");
    const entryId = seedEntry(business.orm, id, turn.id, "甲");
    const job = (await (
      await call(
        app,
        `/agents/${id}/memory/consolidate`,
        json({ request_key: "req-1", session_id: sessionId, turn_ids: [turn.id] }),
      )
    ).json()) as { id: string };

    // A governance action bumps the epoch AND fails the queued job.
    await call(
      app,
      `/agents/${id}/memory/govern`,
      json({ memory_ids: [entryId], action: "suppress" }),
    );

    const res = await call(app, `/agents/${id}/memory/jobs/${job.id}/retry`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "MEMORY_SOURCE_CHANGED",
    );
  });
});

describe("0.2.1 immutable memory correction", () => {
  async function fixture() {
    const ctx = makeApp();
    const agentId = await seedAgent(ctx.app);
    const sessionId = await newSession(ctx.app);
    const turn = completedTurn(ctx.business.orm, sessionId, "correction", "餐费上限80元");
    const id = seedEntry(ctx.business.orm, agentId, turn.id, "错误记忆");
    const url = `/agents/${agentId}/memory/entries/${id}`;
    const detail = MemoryContentResponseSchema.parse(
      await (await call(ctx.app, `${url}/content`)).json(),
    );
    const input = {
      expected_revision: detail.content.revision,
      name: "餐费",
      summary: "上限80元",
      tags: ["报销"],
      body: "餐费上限80元。",
    };
    return { ...ctx, agentId, sessionId, turn, id, url, detail, input };
  }

  it("returns true source messages, creates a new revision and rejects stale saves without writes", async () => {
    const f = await fixture();
    try {
      expect(f.detail.source_messages[0].user).toBe("餐费上限80元");
      expect(f.detail.source_messages[0].assistant).toBe("你好");
      const saved = await call(f.app, `${f.url}/correct`, json(f.input));
      expect(saved.status).toBe(201);
      const revision = MemoryContentResponseSchema.parse(await saved.json());
      expect(revision.content.id).not.toBe(f.id);
      expect(revision.content.content_origin).toBe("manual_correction");
      expect(revision.content.sources).toEqual(f.detail.content.sources);
      expect(memoryContent(f.business.orm, f.agentId, f.id).status).toBe("replaced");
      const before = f.business.db.serialize();
      expect((await call(f.app, `${f.url}/correct`, json(f.input))).status).toBe(409);
      expect(f.business.db.serialize()).toEqual(before);
      expect(
        (
          await call(
            f.app,
            `/agents/${f.agentId}/memory/govern`,
            json({ memory_ids: [f.id], action: "enable" }),
          )
        ).status,
      ).toBe(409);
      expect(
        f.business.orm
          .select()
          .from(schema.messages)
          .all()
          .map((m) => m.content),
      ).toContain("餐费上限80元");
    } finally {
      f.business.close();
    }
  });

  it("retires recursive derivatives and prevents late worker publication", async () => {
    const f = await fixture();
    try {
      const child = seedEntry(f.business.orm, f.agentId, f.turn.id, "派生");
      const grandchild = seedEntry(f.business.orm, f.agentId, f.turn.id, "再派生");
      f.business.orm
        .insert(schema.memoryLinks)
        .values([
          { parentId: f.id, childId: child },
          { parentId: child, childId: grandchild },
        ])
        .run();
      const job = enqueue(f.business.orm, f.agentId, "late", {
        kind: "manual",
        sessionId: f.sessionId,
        turnIds: [f.turn.id],
      });
      const running = claim(f.business.orm, job.id);
      expect(running?.token).toBeTruthy();
      expect((await call(f.app, `${f.url}/correct`, json(f.input))).status).toBe(201);
      for (const id of [child, grandchild]) {
        expect(memoryContent(f.business.orm, f.agentId, id).status).toBe("suppressed");
        expect(
          (
            await call(
              f.app,
              `/agents/${f.agentId}/memory/govern`,
              json({ memory_ids: [id], action: "enable" }),
            )
          ).status,
        ).toBe(409);
      }
      expect(() =>
        publish(f.business.orm, f.agentId, job.id, running?.token ?? "", null),
      ).toThrow();
      expect(
        f.business.orm
          .select()
          .from(schema.memoryJobs)
          .where(eq(schema.memoryJobs.id, job.id))
          .get()?.errorCode,
      ).toBe("MEMORY_GOVERNANCE_CHANGED");
    } finally {
      f.business.close();
    }
  });

  it("refuses missing sources and does not leak another agent's messages through damaged links", async () => {
    const f = await fixture();
    try {
      const other = (await (
        await call(f.app, "/agents", json({ name: "other", model_name: "test" }))
      ).json()) as { id: string };
      const session = (await (
        await call(f.app, "/sessions", json({ title: "private", agent_id: other.id }))
      ).json()) as { id: string };
      const privateTurn = completedTurn(f.business.orm, session.id, "private", "private-secret");
      const messages = f.business.orm
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.turnId, privateTurn.id))
        .all();
      f.business.orm
        .update(schema.memorySources)
        .set({
          turnId: privateTurn.id,
          userMessageId: messages.find((m) => m.role === "user")?.id,
          assistantMessageId: messages.find((m) => m.role === "assistant")?.id,
        })
        .where(eq(schema.memorySources.memoryId, f.id))
        .run();
      const detail = await (await call(f.app, `${f.url}/content`)).json();
      expect(JSON.stringify(detail)).not.toContain("private-secret");
      expect(MemoryContentResponseSchema.parse(detail).content.validity).toBe("invalid");
      expect((await call(f.app, `${f.url}/correct`, json(f.input))).status).toBe(409);
      expect((await call(f.app, `/agents/${other.id}/memory/entries/${f.id}/content`)).status).toBe(
        404,
      );
      f.business.orm
        .delete(schema.memorySources)
        .where(eq(schema.memorySources.memoryId, f.id))
        .run();
      expect((await call(f.app, `${f.url}/correct`, json(f.input))).status).toBe(409);
    } finally {
      f.business.close();
    }
  });

  it("keeps a corrected suppressed memory suppressed, and rejects injected fields", async () => {
    const f = await fixture();
    try {
      expect(
        (await call(f.app, `${f.url}/correct`, json({ ...f.input, agent_id: UNKNOWN }))).status,
      ).toBe(422);
      expect(
        (await call(f.app, `${f.url}/correct`, json({ ...f.input, body: "   " }))).status,
      ).toBe(422);
      await call(
        f.app,
        `/agents/${f.agentId}/memory/govern`,
        json({ memory_ids: [f.id], action: "suppress" }),
      );
      const detail = memoryContent(f.business.orm, f.agentId, f.id);
      const saved = MemoryContentResponseSchema.parse(
        await (
          await call(
            f.app,
            `${f.url}/correct`,
            json({ ...f.input, expected_revision: detail.content.revision }),
          )
        ).json(),
      );
      expect(saved.status).toBe("suppressed");
    } finally {
      f.business.close();
    }
  });
});

describe("memory routes coexist with the rest of the API", () => {
  it("does not shadow /agents/:id or /agents/batch-delete", async () => {
    const { app } = makeApp();
    const id = await seedAgent(app);

    // /agents/:agentId (GET) still resolves.
    const agent = await call(app, `/agents/${id}`);
    expect(agent.status).toBe(200);

    // /agents/:agentId/memory/policy is its own route, not a sub-path of the above.
    expect((await call(app, `/agents/${id}/memory/policy`)).status).toBe(200);

    // A literal segment still wins over the param route.
    const batch = await call(app, "/agents/batch-delete", json({ agent_ids: [id] }));
    expect(batch.status).toBe(200);
  });
});
