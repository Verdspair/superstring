import { expect, it } from "bun:test";
import { createSession, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import type { ModuleComposition } from "../../src/server/modules/composition";
import type { KnowledgeSource, SourceEvent } from "../../src/server/modules/contracts";
import { createRuntime } from "../../src/server/runtime";

it("composes module lifecycle and consumes committed Web/document identities without copying their sources", async () => {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "fixture");
  const observed: SourceEvent[] = [],
    ingested: KnowledgeSource[] = [],
    lifecycle: string[] = [];
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "fixture", timeoutSeconds: 1 },
    listModels: async () => ["fixture"],
    loadedContextCapacity: async () => 65536,
    probeModelLoaded: async () => true,
    complete: async () =>
      JSON.stringify({
        kind: "final",
        outputs: [{ kind: "generate", targetId: "reply", instructions: "answer" }],
      }),
    async *streamChat() {
      yield "complete answer";
    },
  };
  const memory: ModuleComposition["memory"] = {
    query: async () => [],
    observe(event) {
      expect(
        business.db.query("SELECT generation_status FROM turns WHERE id=?").get(event.source.id),
      ).toEqual({ generation_status: "completed" });
      observed.push(event);
      return { source: event.source, created: false };
    },
  };
  const knowledge: ModuleComposition["knowledge"] = {
    query: async () => [],
    async ingest(source) {
      expect(
        business.db.query("SELECT id FROM knowledge_documents WHERE id=?").get(source.id),
      ).toEqual({ id: source.id });
      ingested.push(source);
      return {
        source: { kind: "custom_document", id: source.id, revision: source.revision },
        created: true,
      };
    },
  };
  const modules: ModuleComposition = {
    bind: () => ({ memory, knowledge }),
    memory,
    knowledge,
    start() {
      lifecycle.push("start");
    },
    async stop() {
      lifecycle.push("stop");
    },
  };
  const runtime = createRuntime({
    business,
    gateway,
    modules,
    browserStateSecret: "synthetic-module-test",
  });
  try {
    const session = createSession(business.orm, "module conversation", { modelName: "fixture" });
    const response = await runtime.app.request("/v2/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        message: "question",
        client_request_id: "module-1",
      }),
    });
    expect(await response.text()).toContain("event: completed");
    expect(observed).toHaveLength(1);
    expect(observed[0].source.kind).toBe("web_turn");
    const uploaded = await runtime.app.request("/knowledge/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category_id: "default",
        name: "rules",
        original_text: "Keep all existing functions.",
      }),
    });
    expect(uploaded.status).toBe(201);
    const document = await uploaded.json();
    expect(ingested).toHaveLength(1);
    expect(ingested[0].id).toBe(document.id);
    expect(business.db.query("SELECT id FROM knowledge_documents").all()).toHaveLength(1);
    runtime.start();
    runtime.start();
  } finally {
    await runtime.stop();
  }
  expect(lifecycle).toEqual(["start", "stop"]);
});
