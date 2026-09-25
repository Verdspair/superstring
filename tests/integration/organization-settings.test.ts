import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../../src/server/app";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { enqueue } from "../../src/server/db/memory-repository";
import {
  readOrganizationSettings,
  updateOrganizationSettings,
} from "../../src/server/db/organization-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  ensureDefaults,
  getTurnByRequest,
  prepareTurn,
  saveCompletedAssistantMessage,
  saveFailedAssistantMessage,
} from "../../src/server/db/repositories";
import {
  BUSINESS_MIGRATION_FILES,
  ensureBusinessSchema,
  openBusinessDb,
} from "../../src/server/db/schema-gate";

let h: BusinessDbHandle;
beforeEach(() => {
  h = openBusinessDb();
  ensureDefaults(h.orm, "chat-model");
});
afterEach(() => h.close());
const setDefault = (model_name: string | null) =>
  updateOrganizationSettings(h.orm, {
    model_name,
    expected_revision: readOrganizationSettings(h.orm).revision,
  });
const turn = () => {
  const session = createSession(h.orm, "fixture", { modelName: "chat-model" });
  const request = crypto.randomUUID();
  const prepared = prepareTurn(h.orm, session.id, "fixture", request);
  return { session, request, prepared };
};

describe("shared organization default", () => {
  it("keeps the old fallback and changes only consolidation for new turns", () => {
    expect(readOrganizationSettings(h.orm)).toEqual({
      model_name: null,
      vision_model_name: null,
      transcription_model_name: null,
      revision: 1,
    });
    expect(turn().prepared.runtime.memory_consolidation_model_name).toBe("chat-model");
    setDefault("organizer");
    const runtime = turn().prepared.runtime;
    expect(runtime.memory_consolidation_model_name).toBe("organizer");
    expect(runtime.model_name).toBe("chat-model");
    expect(runtime.memory_retrieval_model_name).toBe("chat-model");
    expect(runtime.context_compression_model_name).toBe("chat-model");
    expect(
      h.db
        .query("SELECT memory_consolidation_model_name FROM agents WHERE id = ?")
        .get(DEFAULT_AGENT_ID),
    ).toEqual({ memory_consolidation_model_name: null });
  });
  it("preserves explicit overrides above the shared default", () => {
    h.db
      .query("UPDATE agents SET memory_consolidation_model_name = 'explicit' WHERE id = ?")
      .run(DEFAULT_AGENT_ID);
    setDefault("organizer");
    expect(turn().prepared.runtime.memory_consolidation_model_name).toBe("explicit");
    setDefault(null);
    expect(turn().prepared.runtime.memory_consolidation_model_name).toBe("explicit");
  });
  it("does not alter same-request retry snapshots after changing the default", () => {
    setDefault("before");
    const { session, request, prepared } = turn();
    if (!prepared.generationToken) throw new Error("missing token");
    saveFailedAssistantMessage(h.orm, session.id, request, "MODEL_ERROR", prepared.generationToken);
    const before = getTurnByRequest(h.orm, session.id, request)?.runtimeConfigSnapshot;
    setDefault("after");
    expect(
      prepareTurn(h.orm, session.id, "fixture", request).runtime.memory_consolidation_model_name,
    ).toBe("before");
    expect(getTurnByRequest(h.orm, session.id, request)?.runtimeConfigSnapshot).toBe(before);
    expect(turn().prepared.runtime.memory_consolidation_model_name).toBe("after");
  });
  it("freezes memory jobs on enqueue and keeps idempotent requests unchanged", () => {
    const { session, request, prepared } = turn();
    if (!prepared.generationToken) throw new Error("missing token");
    saveCompletedAssistantMessage(h.orm, session.id, "answer", request, prepared.generationToken);
    const row = getTurnByRequest(h.orm, session.id, request);
    if (!row) throw new Error("missing turn");
    setDefault("queued-default");
    const args = { kind: "manual" as const, sessionId: session.id, turnIds: [row.id] };
    const job = enqueue(h.orm, DEFAULT_AGENT_ID, "job-key", args);
    expect(JSON.parse(job.configSnapshot).model).toBe("queued-default");
    setDefault("later-default");
    expect(enqueue(h.orm, DEFAULT_AGENT_ID, "job-key", args).configSnapshot).toBe(
      job.configSnapshot,
    );
  });
  it("uses independent optimistic revisions and rejects malformed API updates", async () => {
    const app = createApp({ business: h });
    const put = (body: unknown) =>
      app.request("/organization/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const before = h.db
      .query("SELECT config_version FROM agents WHERE id = ?")
      .get(DEFAULT_AGENT_ID);
    expect(await (await app.request("/organization/settings")).json()).toEqual({
      model_name: null,
      vision_model_name: null,
      transcription_model_name: null,
      revision: 1,
    });
    expect((await put({ model_name: "helper", expected_revision: 1 })).status).toBe(200);
    expect((await put({ model_name: "lost", expected_revision: 1 })).status).toBe(409);
    for (const body of [
      { model_name: "", expected_revision: 2 },
      { model_name: "helper", expected_revision: 2, extra: true },
      { model_name: 42, expected_revision: 2 },
    ])
      expect((await put(body)).status).toBe(422);
    expect(readOrganizationSettings(h.orm)).toEqual({
      model_name: "helper",
      vision_model_name: null,
      transcription_model_name: null,
      revision: 2,
    });
    expect(
      h.db.query("SELECT config_version FROM agents WHERE id = ?").get(DEFAULT_AGENT_ID),
    ).toEqual(before);
  });
});

describe("schema4 additive migration", () => {
  const migrations = BUSINESS_MIGRATION_FILES.map((file) =>
    readFileSync(path.join(import.meta.dir, "../../migrations/versions", file), "utf8"),
  ) as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  it("upgrades exact v3 without overwriting existing overrides", () => {
    const db = new Database(":memory:");
    try {
      db.exec(migrations.slice(0, 3).join("\n"));
      db.exec(
        "PRAGMA user_version = 3; UPDATE knowledge_settings SET model_name = 'existing-model';",
      );
      const before = db.query("SELECT * FROM knowledge_settings").all();
      ensureBusinessSchema(db);
      expect(db.query("SELECT * FROM knowledge_settings").all()).toEqual(before);
      expect(db.query("SELECT * FROM organization_settings").get()).toEqual({
        id: 1,
        model_name: null,
        revision: 1,
        vision_model_name: null,
        transcription_model_name: null,
      });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 38 });
    } finally {
      db.close();
    }
  });
  it("rolls back a failing fourth migration on existing data", () => {
    const db = new Database(":memory:");
    try {
      db.exec(migrations.slice(0, 3).join("\n"));
      db.exec(
        "PRAGMA user_version = 3; UPDATE knowledge_settings SET model_name = 'existing-model';",
      );
      const bad = [...migrations] as typeof migrations;
      bad[3] +=
        "\nINSERT INTO knowledge_settings(id, auto_enabled, context_budget, revision) SELECT 1,1,4096,1 FROM knowledge_settings WHERE model_name IS NOT NULL;";
      expect(() => ensureBusinessSchema(db, bad)).toThrow();
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      expect(
        db.query("SELECT name FROM sqlite_master WHERE name = 'organization_settings'").all(),
      ).toEqual([]);
      expect(db.query("SELECT model_name FROM knowledge_settings").get()).toEqual({
        model_name: "existing-model",
      });
    } finally {
      db.close();
    }
  });
});
