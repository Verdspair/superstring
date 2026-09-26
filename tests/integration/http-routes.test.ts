// HTTP contract tests for the R3 business routes.
// These assert the WIRE contract, not the repository internals: status codes
// JSON shape, and the exact error codes the contract produces. They run
// against a real in-memory SQLite database and a real Hono app via
// `app.request(...)`, so routing, validation, and the error envelope are all
// exercised together.
// Source of truth: docs/reference/api-contract.md and
// Nothing here touches the live model server — the gateway is a fake.

import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { BUSINESS_SCHEMA_VERSION, openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";

const DEFAULT_AGENT_ID = "00000000-0000-0000-0000-000000000001";

class FakeGateway implements ModelGateway {
  config = { baseUrl: "http://127.0.0.1:1234/v1", model: "qwen/qwen3-4b-2507", timeoutSeconds: 60 };
  models: string[] = ["qwen/qwen3-4b-2507", "qwen/qwen3-4b-2507"];
  capacity: number | null = 32768;
  async listModels(): Promise<string[]> {
    return this.models;
  }
  async loadedContextCapacity(): Promise<number | null> {
    return this.capacity;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async complete(): Promise<string> {
    return "ok";
  }
  async *streamChat(): AsyncGenerator<string, void, unknown> {
    yield "ok";
  }
}

/**
 * Build the app over a REAL initialised business database. Using
 * `openBusinessDb` (not a raw `db.exec(migration)`) matters: the migration
 * deliberately does not stamp `user_version` — the schema gate does — so a raw
 * exec would make `/health` report `schema: unavailable`.
 */
function makeApp(gateway = new FakeGateway()) {
  const business = openBusinessDb();
  const app = createApp({ business, gateway });
  return { app, business };
}

/** Seed the built-in default agent via the documented path (GET /agents). */
async function seedDefaults(app: ReturnType<typeof makeApp>["app"]): Promise<string> {
  await app.request("/agents");
  return DEFAULT_AGENT_ID;
}

function json(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

const UUID_A = "11111111-1111-4111-8111-111111111111";

describe("stored agent configuration integrity", () => {
  for (const stored of ["not-json", "", "null", "[]", '{"max_output_tokens":-1}']) {
    it(`rejects damaged stored P5 without writing: ${JSON.stringify(stored)}`, async () => {
      const { app, business } = makeApp();
      try {
        await seedDefaults(app);
        const created = await app.request("/sessions", json({ title: "Before corruption" }));
        const session = (await created.json()) as { id: string };
        expect(created.status).toBe(201);
        business.db
          .query("UPDATE agents SET p5_config = ? WHERE id = ?")
          .run(stored, DEFAULT_AGENT_ID);
        const before = business.db.query("SELECT * FROM agents WHERE id = ?").get(DEFAULT_AGENT_ID);
        const count = () => business.db.query("SELECT count(*) AS n FROM sessions").get();
        const sessionsBefore = count();
        for (const [url, init] of [
          ["/agents", undefined],
          [`/agents/${DEFAULT_AGENT_ID}`, undefined],
          [
            `/agents/${DEFAULT_AGENT_ID}`,
            json({ expected_version: 1, description: "must not save" }, "PATCH"),
          ],
          ["/sessions", json({ title: "Must not create" })],
          [`/sessions/${session.id}/runtime-config`, undefined],
        ] as const) {
          const response = await app.request(url, init);
          expect(response.status).toBe(409);
          const body = (await response.json()) as { error: { code: string } };
          expect(body.error.code).toBe("INVALID_SESSION_CONFIG");
        }
        expect(
          business.db.query("SELECT * FROM agents WHERE id = ?").get(DEFAULT_AGENT_ID),
        ).toEqual(before);
        expect(count()).toEqual(sessionsBefore);
        expect(business.db.query("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 0 });
      } finally {
        business.close();
      }
    });
  }
  it("accepts old missing fields and retired recall values without rewriting stored JSON", async () => {
    const { app, business } = makeApp();
    try {
      await seedDefaults(app);
      for (const stored of ["{}", '{"recall_max_tokens":1234}']) {
        business.db
          .query("UPDATE agents SET p5_config = ? WHERE id = ?")
          .run(stored, DEFAULT_AGENT_ID);
        const agent = await app.request(`/agents/${DEFAULT_AGENT_ID}`);
        expect(agent.status).toBe(200);
        expect(((await agent.json()) as { p5_config: unknown }).p5_config).toEqual(
          JSON.parse(stored),
        );
        const response = await app.request("/sessions", json({ title: "Compatible" }));
        expect(response.status).toBe(201);
        const session = (await response.json()) as { id: string };
        const runtime = await app.request(`/sessions/${session.id}/runtime-config`);
        expect(runtime.status).toBe(200);
        expect(
          business.db.query("SELECT p5_config FROM agents WHERE id = ?").get(DEFAULT_AGENT_ID),
        ).toEqual({ p5_config: stored });
      }
    } finally {
      business.close();
    }
  });
});

describe("agents routes", () => {
  it("GET /agents auto-creates and lists the default agent", async () => {
    const { app } = makeApp();
    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(DEFAULT_AGENT_ID);
    expect(body[0].is_active).toBe(true);
    expect(body[0].config_version).toBe(1);
    // p5_config must be an object on the wire, not a raw JSON string.
    expect(typeof body[0].p5_config).toBe("object");
  });

  it("POST /agents returns 201 with a persona row", async () => {
    const { app } = makeApp();
    const res = await app.request(
      "/agents",
      json({
        name: "小助手",
        model_name: "qwen/qwen3-4b-2507",
        persona: { core_identity: "你是助手" },
      }),
    );
    expect(res.status).toBe(201);
    const agent = (await res.json()) as Record<string, unknown>;
    expect(agent.name).toBe("小助手");
    expect(agent.persona_intensity).toBe(60);

    const personaRes = await app.request(`/agents/${agent.id}/persona`);
    expect(personaRes.status).toBe(200);
    const persona = (await personaRes.json()) as Record<string, unknown>;
    expect(persona.core_identity).toBe("你是助手");
    expect(persona.agent_id).toBe(agent.id);
    void UUID_A;
  });

  it("POST /agents rejects a body with unknown fields (extra=forbid → 422)", async () => {
    const { app } = makeApp();
    const res = await app.request("/agents", json({ name: "x", model_name: "m", nope: 1 }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("GET /agents/{unknown} is 404 AGENT_NOT_FOUND", async () => {
    const { app } = makeApp();
    const res = await app.request("/agents/22222222-2222-4222-8222-222222222222");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AGENT_NOT_FOUND");
  });

  it("GET /agents/{non-uuid} is 422, not 404", async () => {
    const { app } = makeApp();
    const res = await app.request("/agents/not-a-uuid");
    expect(res.status).toBe(422);
  });

  it("PUT persona overwrites in place and does not bump config_version", async () => {
    const { app } = makeApp();
    const id = await seedDefaults(app);

    const res = await app.request(
      `/agents/${id}/persona`,
      json(
        {
          core_identity: "新的身份",
          communication_style: "简洁",
          persona_intensity: 100,
        },
        "PUT",
      ),
    );
    expect(res.status).toBe(200);
    const persona = (await res.json()) as Record<string, unknown>;
    expect(persona.core_identity).toBe("新的身份");
    expect(persona.communication_style).toBe("简洁");

    const agent = (await (await app.request(`/agents/${id}`)).json()) as Record<string, unknown>;
    expect(agent.persona_intensity).toBe(100);
    // Persona edits never bump config_version — they are an in-place overwrite
    // (ADR 0008), not a config change.
    expect(agent.config_version).toBe(1);
  });

  it("PUT persona rejects an out-of-range intensity with 422 (ge=0, le=100)", async () => {
    // SavePersonaRequest constrains persona_intensity to 0..100
    // so the defensive clamp inside save_persona is
    // unreachable through this route.
    const { app } = makeApp();
    const id = await seedDefaults(app);
    const res = await app.request(
      `/agents/${id}/persona`,
      json({ core_identity: "x", persona_intensity: 150 }, "PUT"),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("treats a raw empty body as 422 on every body-required route (#90)", async () => {
    // Every handler declares a REQUIRED body, so a
    // missing body is a RequestValidationError → 422. The port used to turn a
    // blank body into `{}`, which silently let `PUT persona` wipe the persona.
    const { app } = makeApp();
    const id = await seedDefaults(app);
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const routes: Array<[string, string]> = [
      [`/agents/${id}/persona`, "PUT"],
      [`/agents/${id}`, "PATCH"],
      [`/sessions/${sessionId}`, "PATCH"],
      [`/agents/${id}/memory/policy`, "PATCH"],
      [`/agents/${id}/memory/sessions/${sessionId}/scope`, "PATCH"],
    ];
    for (const [path, method] of routes) {
      const res = await app.request(path, { method });
      expect([path, res.status]).toEqual([path, 422]);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "VALIDATION_ERROR",
      );
    }
  });

  it("accepts a literal JSON {} only where the contract model is fully defaulted (#90)", async () => {
    const { app } = makeApp();
    const id = await seedDefaults(app);
    const sessionId = "33333333-3333-4333-8333-333333333333";

    // SavePersonaRequest inherits PersonaContent, whose five fields all default
    // to "" → `{}` is a valid body that clears
    // the persona but leaves config_version and intensity alone.
    const before = (await (await app.request(`/agents/${id}`)).json()) as Record<string, unknown>;
    const personaRes = await app.request(`/agents/${id}/persona`, json({}, "PUT"));
    expect(personaRes.status).toBe(200);
    const persona = (await personaRes.json()) as Record<string, unknown>;
    expect(persona.core_identity).toBe("");
    expect(persona.communication_style).toBe("");
    const after = (await (await app.request(`/agents/${id}`)).json()) as Record<string, unknown>;
    expect(after.config_version).toBe(before.config_version);
    expect(after.persona_intensity).toBe(before.persona_intensity);

    // The other four require fields with no default, so `{}` is still 422.
    for (const [path, method] of [
      [`/agents/${id}`, "PATCH"],
      [`/sessions/${sessionId}`, "PATCH"],
      [`/agents/${id}/memory/policy`, "PATCH"],
      [`/agents/${id}/memory/sessions/${sessionId}/scope`, "PATCH"],
    ] as Array<[string, string]>) {
      const res = await app.request(path, json({}, method));
      expect([path, res.status]).toEqual([path, 422]);
    }
  });

  it("PUT persona rejects a compiled persona longer than 16000 chars", async () => {
    const { app } = makeApp();
    const id = await seedDefaults(app);
    const res = await app.request(
      `/agents/${id}/persona`,
      json({ core_identity: "字".repeat(16001) }, "PUT"),
    );
    expect(res.status).toBe(422);
  });

  it("PATCH bumps config_version and rejects a stale expected_version", async () => {
    const { app } = makeApp();
    const id = await seedDefaults(app);

    const ok = await app.request(
      `/agents/${id}`,
      json({ temperature: 1.2, expected_version: 1 }, "PATCH"),
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { config_version: number }).config_version).toBe(2);

    const stale = await app.request(
      `/agents/${id}`,
      json({ temperature: 0.5, expected_version: 1 }, "PATCH"),
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      "CONFIG_VERSION_CONFLICT",
    );
  });

  it("PATCH with unchanged values does not bump config_version", async () => {
    const { app } = makeApp();
    await seedDefaults(app);
    const before = (await (await app.request(`/agents/${DEFAULT_AGENT_ID}`)).json()) as {
      config_version: number;
      temperature: number;
    };
    const res = await app.request(
      `/agents/${DEFAULT_AGENT_ID}`,
      json({ temperature: before.temperature, expected_version: before.config_version }, "PATCH"),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { config_version: number }).config_version).toBe(
      before.config_version,
    );
  });

  it("PATCH carrying persona_intensity is 422 (extra=forbid quirk, reproduced faithfully)", async () => {
    const { app } = makeApp();
    await seedDefaults(app);
    const res = await app.request(
      `/agents/${DEFAULT_AGENT_ID}`,
      json({ persona_intensity: 80, expected_version: 1 }, "PATCH"),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("DELETE refuses the built-in default agent with 409", async () => {
    const { app } = makeApp();
    await seedDefaults(app);
    const res = await app.request(`/agents/${DEFAULT_AGENT_ID}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "DEFAULT_AGENT_DELETE_FORBIDDEN",
    );
  });

  it("DELETE refuses an agent bound to a session with 409 AGENT_IN_USE", async () => {
    const { app } = makeApp();
    const created = (await (
      await app.request("/agents", json({ name: "被使用", model_name: "qwen/qwen3-4b-2507" }))
    ).json()) as { id: string };

    await app.request("/sessions", json({ title: "会话", agent_id: created.id }));

    const res = await app.request(`/agents/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AGENT_IN_USE");
  });

  it("DELETE removes an unused custom agent with 204", async () => {
    const { app } = makeApp();
    const created = (await (
      await app.request("/agents", json({ name: "可删除", model_name: "qwen/qwen3-4b-2507" }))
    ).json()) as { id: string };

    const res = await app.request(`/agents/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await app.request(`/agents/${created.id}`)).status).toBe(404);
  });

  it("POST /agents/batch-delete reports per-id partial success without failing the request", async () => {
    const { app } = makeApp();
    await seedDefaults(app);
    const created = (await (
      await app.request("/agents", json({ name: "批删", model_name: "m" }))
    ).json()) as { id: string };

    const res = await app.request(
      "/agents/batch-delete",
      json({ agent_ids: [created.id, DEFAULT_AGENT_ID] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deleted_count: number;
      failed_count: number;
      results: Array<{ deleted: boolean; error_code: string | null }>;
    };
    expect(body.deleted_count).toBe(1);
    expect(body.failed_count).toBe(1);
    expect(body.results[0].deleted).toBe(true);
    expect(body.results[1].deleted).toBe(false);
    expect(body.results[1].error_code).toBe("DEFAULT_AGENT_DELETE_FORBIDDEN");
  });

  it("batch-delete route is matched before /{agent_id}", async () => {
    const { app } = makeApp();
    await seedDefaults(app);
    const res = await app.request("/agents/batch-delete", json({ agent_ids: [] }));
    // Empty list violates min(1) → 422. Crucially it is NOT parsed as a UUID
    // path param, which would also be 422 but for the wrong reason; assert the
    // validation error came from the body schema.
    expect(res.status).toBe(422);
  });

  it("POST /agents/{id}/disable flips is_active", async () => {
    const { app } = makeApp();
    const created = (await (
      await app.request("/agents", json({ name: "停用我", model_name: "m" }))
    ).json()) as { id: string };

    const res = await app.request(`/agents/${created.id}/disable`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { is_active: boolean }).is_active).toBe(false);
  });
});

describe("sessions and messages routes", () => {
  it("POST /sessions returns 201 and is idempotent on client_request_id", async () => {
    const { app } = makeApp();
    const first = await app.request("/sessions", json({ title: "会话", client_request_id: "r-1" }));
    expect(first.status).toBe(201);
    const a = (await first.json()) as { id: string; mode: string };
    expect(a.mode).toBe("chat");

    const second = await app.request(
      "/sessions",
      json({ title: "会话", client_request_id: "r-1" }),
    );
    expect((await second.json()) as { id: string }).toMatchObject({ id: a.id });
  });

  it("POST /sessions rejects mode=work with 409 MODE_NOT_AVAILABLE", async () => {
    const { app } = makeApp();
    const res = await app.request("/sessions", json({ title: "工作", mode: "work" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "MODE_NOT_AVAILABLE",
    );
  });

  it("GET/PATCH/DELETE /sessions/{id} behave per contract", async () => {
    const { app } = makeApp();
    const created = (await (await app.request("/sessions", json({ title: "旧标题" }))).json()) as {
      id: string;
    };

    const listed = (await (await app.request("/sessions")).json()) as Array<{ id: string }>;
    expect(listed.map((s) => s.id)).toContain(created.id);

    const patched = await app.request(
      `/sessions/${created.id}`,
      json({ title: "新标题" }, "PATCH"),
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { title: string }).title).toBe("新标题");

    const removed = await app.request(`/sessions/${created.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect((await app.request(`/sessions/${created.id}`)).status).toBe(404);
  });

  it("GET runtime-config returns the frozen agent snapshot", async () => {
    const { app } = makeApp();
    const created = (await (await app.request("/sessions", json({ title: "会话" }))).json()) as {
      id: string;
    };
    const res = await app.request(`/sessions/${created.id}/runtime-config`);
    expect(res.status).toBe(200);
    const runtime = (await res.json()) as Record<string, unknown>;
    expect(runtime.agent_id).toBe(DEFAULT_AGENT_ID);
    expect(runtime.mode).toBe("chat");
    expect(runtime.config_version).toBe(1);
  });

  it("GET messages returns an ordered list and is empty for a fresh session", async () => {
    const { app } = makeApp();
    const created = (await (await app.request("/sessions", json({ title: "会话" }))).json()) as {
      id: string;
    };
    const res = await app.request(`/sessions/${created.id}/messages`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("unknown session is 404 SESSION_NOT_FOUND", async () => {
    const { app } = makeApp();
    const res = await app.request("/sessions/33333333-3333-4333-8333-333333333333");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "SESSION_NOT_FOUND",
    );
  });

  it("DELETE message answers 204 with the three X-Superstring-Turn-* headers", async () => {
    const { app, business } = makeApp();
    const created = (await (await app.request("/sessions", json({ title: "会话" }))).json()) as {
      id: string;
    };
    // Seed one turn + two messages through the repository (POST /chat is R3-b).
    const { prepareTurn } = await import("../../src/server/db/repositories");
    prepareTurn(business.orm, created.id, "你好", "cg-1");
    const messages = (await (
      await app.request(`/sessions/${created.id}/messages`)
    ).json()) as Array<{ id: string; role: string }>;
    expect(messages).toHaveLength(2);

    const user = messages.find((m) => m.role === "user") as { id: string };
    const res = await app.request(`/sessions/${created.id}/messages/${user.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("X-Superstring-Turn-Context-Valid")).toBe("false");
    expect(res.headers.get("X-Superstring-Turn-Source-Valid")).toBe("false");
    expect(res.headers.get("X-Superstring-Turn-Id")).toBeTruthy();

    const after = (await (
      await app.request(`/sessions/${created.id}/messages`)
    ).json()) as unknown[];
    expect(after).toHaveLength(1);
  });
});

describe("UUID spelling on the wire (#92)", () => {
  // Every id is parsed into a UUID and then queried with
  // `str(uuid_value)`, so uppercase / unhyphenated spellings
  // reach the SAME row. A regex-only path check accepted them but looked up the
  // literal string, turning a valid request into a 404.
  it("GET resolves an agent addressed with an unhyphenated uppercase id", async () => {
    const { app } = makeApp();
    const created = (await (
      await app.request("/agents", json({ name: "变体", model_name: "qwen/qwen3-4b-2507" }))
    ).json()) as { id: string };

    const variant = created.id.replace(/-/g, "").toUpperCase();
    expect(variant).not.toBe(created.id);

    const res = await app.request(`/agents/${variant}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(created.id);
  });

  it("GET resolves a session addressed with an unhyphenated uppercase id", async () => {
    const { app } = makeApp();
    const created = (await (await app.request("/sessions", json({ title: "会话" }))).json()) as {
      id: string;
    };
    const variant = created.id.replace(/-/g, "").toUpperCase();
    const res = await app.request(`/sessions/${variant}/messages`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("accepts the braces and urn:uuid: spellings the contract accepts", async () => {
    const { app } = makeApp();
    const lettered = "ABCDEF12-3456-7890-ABCD-EF1234567890";
    for (const spelling of [lettered, `{${lettered}}`, `urn:uuid:${lettered}`]) {
      const res = await app.request(`/agents/${encodeURIComponent(spelling)}`);
      // 404 (not 422): the id is well-formed, it simply is not in
      // the database.
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "AGENT_NOT_FOUND",
      );
    }
  });

  it("rejects the spellings the contract rejects with 422 VALIDATION_ERROR", async () => {
    const { app } = makeApp();
    const lettered = "ABCDEF12-3456-7890-ABCD-EF1234567890";
    for (const spelling of [
      "not-a-uuid",
      `{${lettered.replace(/-/g, "")}}`,
      `urn:uuid:{${lettered}}`,
      `urn:uuid:${lettered.replace(/-/g, "")}`,
      `URN:UUID:${lettered}`,
      `${lettered}x`,
    ]) {
      const res = await app.request(`/agents/${encodeURIComponent(spelling)}`);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "VALIDATION_ERROR",
      );
    }
  });

  it("de-duplicates memory ids by value, not spelling (#92)", async () => {
    const { app } = makeApp();
    const agentId = await seedDefaults(app);
    const session = (await (await app.request("/sessions", json({ title: "会话" }))).json()) as {
      id: string;
    };
    const shared = "123E4567-E89B-12D3-A456-426614174000";
    const res = await app.request(
      `/agents/${agentId}/memory/consolidate`,
      json({
        request_key: "dup",
        session_id: session.id,
        // Same UUID three times: uppercase, canonical, unhyphenated. The contract
        // collapses them to one entry and then fails the "not enough turns"
        // check; here it must be the duplicate guard that rejects (422), never a
        // silent accept.
        turn_ids: [shared, shared.toLowerCase(), shared.replace(/-/g, "")],
      }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("health route", () => {
  it("reports ok when the schema version matches and the model is loaded", async () => {
    const { app } = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.database).toBe("ok");
    expect(body.schema).toBe("ok");
    expect(body.model_service).toBe("ok");
    expect(body.model_loaded).toBe(true);
    expect(body.version).toBe("0.2.1");
    expect(typeof body.instance_id).toBe("string");
  });

  it("reports degraded when the configured model is not loaded", async () => {
    const gateway = new FakeGateway();
    gateway.models = ["some-other-model"];
    const { app } = makeApp(gateway);
    const body = (await (await app.request("/health")).json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    expect(body.model_service).toBe("ok");
    expect(body.model_loaded).toBe(false);
    expect(BUSINESS_SCHEMA_VERSION).toBe(42);
  });

  it("reports degraded when the model service is unreachable", async () => {
    const gateway = new FakeGateway();
    gateway.listModels = async () => {
      throw new Error("ECONNREFUSED");
    };
    const { app } = makeApp(gateway);
    const body = (await (await app.request("/health")).json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    expect(body.model_service).toBe("unavailable");
    expect(body.model_loaded).toBe(false);
  });
});

describe("models routes", () => {
  it("GET /models/local de-duplicates ids and keeps them loaded", async () => {
    const { app } = makeApp();
    const res = await app.request("/models/local");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: string; status: string; models: string[] };
    expect(body.provider).toBe("lm_studio");
    expect(body.status).toBe("available");
    expect(body.models).toEqual(["qwen/qwen3-4b-2507"]);
  });

  it("GET /models/local reports empty when nothing is loaded", async () => {
    const gateway = new FakeGateway();
    gateway.models = [];
    const { app } = makeApp(gateway);
    const body = (await (await app.request("/models/local")).json()) as { status: string };
    expect(body.status).toBe("empty");
  });

  it("GET /models/capacity reports loaded / unknown", async () => {
    const { app } = makeApp();
    const loaded = (await (
      await app.request("/models/capacity?model=qwen/qwen3-4b-2507")
    ).json()) as Record<string, unknown>;
    expect(loaded.status).toBe("loaded");
    expect(loaded.context_length).toBe(32768);
  });

  it("GET /models/capacity folds a model error into status=unavailable", async () => {
    const gateway = new FakeGateway();
    gateway.loadedContextCapacity = async () => {
      const { ModelUnavailableError } = await import("../../src/server/errors");
      throw new ModelUnavailableError("MODEL_CAPACITY_UNAVAILABLE", "无法读取");
    };
    const { app } = makeApp(gateway);
    const res = await app.request("/models/capacity?model=qwen/qwen3-4b-2507");
    expect(res.status).toBe(200); // never a hard failure
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("unavailable");
    expect(body.context_length).toBeNull();
    expect(body.error_code).toBe("MODEL_CAPACITY_UNAVAILABLE");
  });

  it("GET /models/capacity rejects a missing/oversized model query with 422", async () => {
    const { app } = makeApp();
    expect((await app.request("/models/capacity")).status).toBe(422);
    expect((await app.request(`/models/capacity?model=${"x".repeat(201)}`)).status).toBe(422);
  });
});

describe("business application has no internal development routes", () => {
  it("returns 404 for internal endpoints while the business API remains available", async () => {
    const { app, business } = makeApp();
    try {
      for (const endpoint of ["/__dev/ready", "/__dev/probe"]) {
        expect((await app.request(endpoint)).status).toBe(404);
      }
      expect((await app.request("/sessions")).status).toBe(200);
    } finally {
      business.close();
    }
  });
});
