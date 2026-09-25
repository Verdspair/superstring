import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { ContextBuilder } from "../../src/server/agent/conversation-context";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  ensureDefaults,
  getTurnByRequest,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { createSqliteModules } from "../../src/server/modules/composition";
import { turnSources } from "../../src/server/modules/provenance";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import type { RuntimeConfig } from "../../src/shared/contracts";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});
function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "test-model");
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "test-model", timeoutSeconds: 1 },
    listModels: async () => [],
    probeModelLoaded: async () => true,
    loadedContextCapacity: async () => 32768,
    complete: async () => JSON.stringify({ summary: "summary", tags: [], body: "organized" }),
    async *streamChat() {
      yield "unused";
    },
  };
  const runs = new AgentRunRepository(h.db);
  const agentRuntime = createAgentRuntime({ gateway, repository: runs });
  return {
    ...h,
    gateway,
    agentRuntime,
    runs,
    modules: createSqliteModules({ ...h, gateway, agentRuntime }),
  };
}
describe("concrete module composition", () => {
  it("ingests a document idempotently and maintains it through the existing durable organizer", async () => {
    const h = setup();
    const id = crypto.randomUUID();
    const repo = new KnowledgeRepository(h.db),
      settings = repo.settings();
    repo.updateSettings({ ...settings, expected_revision: settings.revision, auto_enabled: true });
    const source = {
      id,
      revision: "1",
      payload: {
        input: { category_id: "default", name: "rules", original_text: "Original condition." },
        importType: "md",
      },
    };
    const first = h.modules.knowledge.ingest(source);
    expect(first).not.toBeInstanceOf(Promise);
    expect(first.created).toBe(true);
    expect(first.document.id).toBe(id);
    expect(h.modules.knowledge.ingest(source).created).toBe(false);
    expect(h.db.query("SELECT id FROM knowledge_documents").all()).toHaveLength(1);
    expect(h.db.query("SELECT id FROM knowledge_jobs").all()).toHaveLength(1);
    expect(await h.modules.knowledge.maintain?.()).toEqual({ didWork: true });
    expect(repo.detail(id).draft?.body).toBe("organized");
    if (!first.document.latest_job_id) throw new Error("Missing job");
    expect(
      h.runs.listRuns({ ownerKind: "knowledge_job", ownerId: first.document.latest_job_id })[0]
        ?.status,
    ).toBe("completed");
    expect(() =>
      h.modules.knowledge.ingest({
        ...source,
        payload: {
          ...source.payload,
          input: { ...source.payload.input, original_text: "different" },
        },
      }),
    ).toThrow();
  });
  it("observes OneBot input synchronously with original dedup and hook rollback semantics", () => {
    const h = setup();
    const parsed = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        self_id: 10001,
        group_id: 30003,
        user_id: 20002,
        message_id: 123,
        time: Math.floor(Date.now() / 1000),
        message: [{ type: "text", data: { text: "hello" } }],
      },
      "10001",
    );
    if (parsed.kind !== "message") throw new Error("fixture");
    const event = {
      source: { kind: "qq_event", id: parsed.observation.eventKey, revision: "1" },
      payload: { kind: "onebot", observation: parsed.observation, agentId: DEFAULT_AGENT_ID },
    };
    expect(() =>
      h.modules.memory.observe({
        ...event,
        payload: {
          ...event.payload,
          hooks: {
            afterWrite() {
              throw new Error("journal failure");
            },
          },
        },
      }),
    ).toThrow("journal failure");
    expect(h.db.query("SELECT event_key FROM qq_events").all()).toHaveLength(0);
    const first = h.modules.memory.observe(event);
    expect(first).not.toBeInstanceOf(Promise);
    expect(first.metadata).toEqual({ recorded: true, hasText: true });
    expect(h.modules.memory.observe(event).metadata.recorded).toBe(false);
    const receipt = h.modules.memory.observe({
      source: first.source,
      payload: { kind: "qq_event", eventKey: first.source.id, agentId: DEFAULT_AGENT_ID },
    });
    expect(receipt.created).toBe(false);
    expect(receipt.metadata.hasText).toBe(true);
    expect(() =>
      h.modules.memory.observe({
        source: { ...first.source, revision: "stale" },
        payload: { kind: "qq_event", eventKey: first.source.id, agentId: DEFAULT_AGENT_ID },
      }),
    ).toThrow();
    expect(h.db.query("SELECT event_key FROM qq_events").all()).toHaveLength(1);
  });
  it("uses alternate memory and knowledge modules for the initial Web context without SQLite payload parsing", async () => {
    const h = setup();
    const session = createSession(h.orm, "custom modules", { modelName: "test-model" });
    const request = crypto.randomUUID();
    const prepared = prepareTurn(h.orm, session.id, "question", request);
    const turn = getTurnByRequest(h.orm, session.id, request);
    if (!turn || !prepared.generationToken) throw new Error("turn");
    const runtime = JSON.parse(turn.runtimeConfigSnapshot) as RuntimeConfig;
    runtime.p5_config.retrieval_mode = "full_body";
    let valid = true;
    const seen: string[] = [];
    const builder = new ContextBuilder({
      ...h,
      modules: () => ({
        memory: {
          query: async (input) => {
            seen.push(input.mode);
            return [
              {
                id: "remote-memory",
                text: "opaque memory material",
                sources: [{ kind: "external", id: "memory", revision: "1" }],
              },
            ];
          },
        },
        knowledge: {
          query: async () => {
            seen.push("knowledge");
            return [
              {
                id: "remote-knowledge",
                text: "opaque knowledge material",
                sources: [{ kind: "external", id: "knowledge", revision: "1" }],
              },
            ];
          },
        },
      }),
      resolveSource: (source) =>
        source.kind === "external" ? (valid ? "available" : "revoked") : undefined,
    });
    const result = await builder.build({
      sessionId: session.id,
      currentTurnId: turn.id,
      generationToken: prepared.generationToken,
      runtime,
    });
    expect(seen).toEqual(["full_body", "knowledge"]);
    expect(JSON.stringify(result)).toContain("opaque memory material");
    expect(JSON.stringify(result)).toContain("opaque knowledge material");
    expect(h.db.query("SELECT turn_id FROM turn_knowledge_snapshots").all()).toHaveLength(0);
    valid = false;
    expect(() => builder.assertKnowledgeAccess(turn.id, DEFAULT_AGENT_ID)).toThrow();
  });

  it("accepts only completed owned Web turns without duplicating their canonical source", () => {
    const h = setup();
    const session = createSession(h.orm, "chat", { modelName: "test-model" });
    const request = crypto.randomUUID();
    const prepared = prepareTurn(h.orm, session.id, "question", request);
    const turn = getTurnByRequest(h.orm, session.id, request);
    if (!turn || !prepared.generationToken) throw new Error("turn");
    const source = () => ({
      source: turnSources(h.orm, [turn.id])[0],
      payload: { kind: "web_turn", turnId: turn.id, agentId: DEFAULT_AGENT_ID },
    });
    expect(() => h.modules.memory.observe(source())).toThrow();
    saveCompletedAssistantMessage(h.orm, session.id, "answer", request, prepared.generationToken);
    expect(h.modules.memory.observe(source()).created).toBe(false);
    expect(h.modules.memory.observe(source()).created).toBe(false);
    expect(h.db.query("SELECT id FROM turns").all()).toHaveLength(1);
  });
});
