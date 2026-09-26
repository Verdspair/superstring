import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelRequest } from "../../src/server/agent/model-port";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { enqueue } from "../../src/server/db/memory-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { recordQqSpeech } from "../../src/server/db/qq-speech-repository";
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
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { KnowledgeOrganizer } from "../../src/server/services/knowledge-organizer";
import { MemoryService } from "../../src/server/services/memory-service";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
type Span = {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  channel: string;
  stage: string;
  status: string;
  code: string;
  wake_id: string | null;
  run_id: string | null;
  output_id: string | null;
  details: string;
  expires_at: string;
  finished_at: string | null;
};
const secret = "NEVER_LOG_SOURCE_OR_MODEL_TEXT";
function setup(complete: (r: ModelRequest) => Promise<string>) {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "synthetic");
  const telemetry = new RuntimeTelemetry(business.db);
  cleanup.push(async () => {
    await telemetry.close();
    business.close();
  });
  const runtime = new AgentRuntime({
    repository: new AgentRunRepository(business.db),
    telemetry,
    model: {
      complete,
      async *streamText() {
        yield "answer";
      },
      completeMultimodal: async () => "description",
    },
  });
  const gateway = {
    config: { model: "synthetic", baseUrl: "http://synthetic.invalid/v1", timeoutSeconds: 1 },
    complete: async () => {
      throw new Error("UNIFIED_RUNTIME_REQUIRED");
    },
    loadedContextCapacity: async () => 65536,
    listModels: async () => [],
    probeModelLoaded: async () => true,
    async *streamChat() {
      yield "unused";
    },
  } as ModelGateway;
  const rows = () => business.db.query("SELECT * FROM runtime_spans ORDER BY id").all() as Span[];
  return { ...business, telemetry, runtime, gateway, rows };
}
function bot(h: ReturnType<typeof setup>, group = false, enabled = true) {
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "synthetic",
    triggers: { direct_reply: enabled, follow_up: false, chiming_in: enabled, idle_topic: false },
    rhythm: { ...QQ_RHYTHM_DEFAULT, merge_window_seconds: 0 },
    reply: { split_by_speaker: false },
  });
  const id = crypto.randomUUID(),
    kind = group ? "group" : "private",
    peerId = group ? "30003" : "20002",
    now = new Date().toISOString();
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001',?,?,?,?,?,?)",
    )
    .run(id, kind, peerId, DEFAULT_AGENT_ID, scheme.id, now, now);
  let sends = 0;
  const app = createOneBotConversationRuntime({
    db: h.db,
    orm: h.orm,
    gateway: h.gateway,
    agentRuntime: h.runtime,
    host: new ConversationHost({ runtime: h.runtime }),
    journal: new ConversationEventRepository(h.db),
    telemetry: h.telemetry,
    store: new QqStickerStore({ directory: "/tmp/superstring-telemetry-no-sticker-files" }),
    wake: () => {},
    port: {
      send: async () =>
        ++sends === 1
          ? { kind: "confirmed", messageId: "receipt" }
          : { kind: "unknown", reason: "timeout" },
    },
  });
  cleanup.push(async () => {
    app.scheduler.stop();
    app.delivery.stop();
  });
  const receive = () =>
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: kind,
          sub_type: group ? "normal" : "friend",
          time: Math.floor(Date.now() / 1000),
          self_id: 10001,
          user_id: 20002,
          ...(group ? { group_id: 30003 } : {}),
          message_id: "1",
          message: [{ type: "text", data: { text: secret } }],
          sender: { nickname: secret },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: app.adapter },
    );
  return { ...app, receive, id, kind, peerId, sendCount: () => sends };
}
function memoryJob(h: ReturnType<typeof setup>) {
  const session = createSession(h.orm, "synthetic", { modelName: "synthetic" });
  const turn = prepareTurn(h.orm, session.id, secret, "request");
  saveCompletedAssistantMessage(h.orm, session.id, secret, "request", turn.generationToken!);
  return enqueue(h.orm, DEFAULT_AGENT_ID, crypto.randomUUID(), {
    kind: "manual",
    sessionId: session.id,
    turnIds: [getTurnByRequest(h.orm, session.id, "request")!.id],
  });
}
const memoryReply = JSON.stringify({
  memory: { name: "preference", summary: "brief", tags: [], kinds: ["semantic"], body: secret },
});
const knowledgeReply = JSON.stringify({ summary: "summary", tags: [], body: secret });

describe("actual peripheral execution traces", () => {
  it("connects ingress, durable wake, main Agent and separate confirmed/unknown delivery parts without replay noise", async () => {
    const h = setup(async () =>
      JSON.stringify({
        kind: "final",
        outputs: [{ kind: "inline", targetId: "20002", text: "first\nsecond", stickerIds: [] }],
      }),
    );
    const app = bot(h);
    app.receive();
    const before = h.rows().length;
    app.adapter.sweep();
    app.adapter.sweep();
    expect(h.rows()).toHaveLength(before);
    expect(await app.scheduler.runOnce()).toBe(true);
    const rows = h.rows(),
      ingress = rows.find((r) => r.name === "bot.ingress")!;
    expect(rows.some((r) => r.name === "agent.run")).toBe(true);
    expect(rows.filter((r) => r.name === "bot.delivery.part").map((r) => r.status)).toEqual([
      "completed",
      "unknown",
    ]);
    expect(new Set(rows.map((r) => r.trace_id))).toEqual(new Set([ingress.trace_id]));
    expect(rows.find((r) => r.name === "bot.wake.activate")?.wake_id).toBeTruthy();
    const part = rows.find((r) => r.name === "bot.delivery.part")!;
    expect(part.parent_span_id).toBe(rows.find((r) => r.name === "bot.delivery")?.span_id ?? null);
    expect(part.output_id).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
  it.each(["settle", "legacy", "revision"] as const)(
    "closes a delivered part trace when %s persistence fails without consuming its unknown receipt",
    async (phase) => {
      const h = setup(async () =>
        JSON.stringify({
          kind: "final",
          outputs: [{ kind: "inline", targetId: "20002", text: "reply", stickerIds: [] }],
        }),
      );
      const app = bot(h);
      const runDelivery = app.delivery.runOnce.bind(app.delivery);
      // Commit a genuine host output before the independent delivery pump runs.
      app.delivery.runOnce = async () => 0;
      app.receive();
      expect(await app.scheduler.runOnce()).toBe(true);
      app.delivery.runOnce = runDelivery;
      const intent = app.outbox.pending()[0]!;
      const failureTrigger =
        phase === "settle"
          ? "BEFORE UPDATE OF status ON outbound_parts WHEN NEW.status='confirmed'"
          : phase === "legacy"
            ? "BEFORE INSERT ON qq_send_log"
            : "BEFORE INSERT ON conversation_events WHEN NEW.kind='delivery' AND EXISTS(SELECT 1 FROM outbound_parts WHERE intent_id=NEW.output_id AND status='confirmed')";
      h.db.exec(
        `CREATE TRIGGER synthetic_settlement_failure ${failureTrigger} BEGIN SELECT RAISE(ABORT, 'synthetic settlement failure'); END`,
      );
      await expect(app.delivery.deliver(intent.id)).rejects.toThrow("synthetic settlement failure");
      const part = h.rows().find((r) => r.name === "bot.delivery.part")!;
      expect(part.status).toBe("unknown");
      expect(part.code).toBe("DELIVERY_PART_SETTLEMENT_FAILED");
      expect(part.finished_at).not.toBeNull();
      expect(app.outbox.get(intent.id)!.parts[0]!.status).toBe("sending");
      expect(app.sendCount()).toBe(1);
      expect(JSON.stringify(h.rows())).not.toContain("synthetic settlement failure");
      h.db.exec("DROP TRIGGER synthetic_settlement_failure");
      app.delivery.recover();
      expect(app.outbox.get(intent.id)!.parts[0]!.status).toBe("unknown");
      await app.delivery.runOnce();
      expect(app.sendCount()).toBe(1);
    },
  );
  it("distinguishes an expired opportunity from a model no-output while preserving its durable state", async () => {
    let calls = 0;
    const h = setup(async () => {
      calls++;
      return '{"kind":"none"}';
    });
    const app = bot(h);
    app.receive();
    h.db.exec("UPDATE qq_events SET occurred_at_seconds=occurred_at_seconds-601");
    expect(await app.scheduler.runOnce()).toBe(true);
    const activation = h.rows().find((r) => r.name === "bot.wake.activate")!;
    expect(activation.status).toBe("skipped");
    expect(activation.code).toBe("OPPORTUNITY_EXPIRED");
    expect(activation.finished_at).not.toBeNull();
    expect(
      h.db.query("SELECT status FROM wake_signals WHERE id=?").get(activation.wake_id),
    ).toEqual({ status: "no_output" });
    expect(calls).toBe(0);
  });
  it("shows disabled admission and cadence deferral even when no model starts", async () => {
    let calls = 0;
    const h = setup(async () => {
      calls++;
      return '{"kind":"none"}';
    });
    const off = bot(h, false, false);
    off.receive();
    expect(h.rows().some((r) => r.code === "TRIGGER_OFF" && r.status === "skipped")).toBe(true);
    expect(await off.scheduler.runOnce()).toBe(false);
    // A second fixture isolates the global transport settings revision.
    const g = setup(async () => {
        calls++;
        return '{"kind":"none"}';
      }),
      app = bot(g, true);
    app.receive();
    recordQqSpeech(g.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      spokeAtSeconds: Math.floor(Date.now() / 1000),
      text: secret,
    });
    expect(await app.scheduler.runOnce()).toBe(true);
    expect(
      g
        .rows()
        .some(
          (r) =>
            r.name === "bot.wake.activate" && r.status === "deferred" && r.code === "COOLING_DOWN",
        ),
    ).toBe(true);
    expect(calls).toBe(0);
    expect(JSON.stringify([...h.rows(), ...g.rows()])).not.toContain(secret);
  });
  it("records actual scheduler failures with stable codes and the originating wake parent", async () => {
    const h = setup(async () => {
        throw new Error(secret);
      }),
      app = bot(h);
    app.receive();
    expect(await app.scheduler.runOnce()).toBe(true);
    const spans = h.rows(),
      activation = spans.find((r) => r.name === "bot.wake.activate")!;
    expect(activation.status).toBe("failed");
    expect(activation.parent_span_id).toBe(spans.find((r) => r.name === "bot.wake.offer")!.span_id);
    expect(JSON.stringify(spans)).not.toContain(secret);
  });
  it.each([false, true])(
    "keeps memory model, publication or rejected publication in the claimed job trace; invalidated=%s",
    async (invalidated) => {
      let h: ReturnType<typeof setup>;
      h = setup(async () => {
        if (invalidated)
          h.db.exec("UPDATE memory_jobs SET token='successor' WHERE status='running'");
        return memoryReply;
      });
      const job = memoryJob(h),
        worker = new MemoryService({
          db: h.db,
          orm: h.orm,
          gateway: h.gateway,
          agentRuntime: h.runtime,
          telemetry: h.telemetry,
        });
      await worker.runJob(job.id);
      const spans = h.rows(),
        parent = spans.find((r) => r.name === "memory.job")!;
      expect(parent.status).toBe(invalidated ? "failed" : "completed");
      expect(
        spans.some(
          (r) => r.name === "memory.publish" && r.status === (invalidated ? "failed" : "completed"),
        ),
      ).toBe(true);
      expect(spans.some((r) => r.stage === "model")).toBe(true);
      expect(new Set(spans.map((r) => r.trace_id))).toEqual(new Set([parent.trace_id]));
      expect(JSON.stringify(spans)).not.toContain(secret);
    },
  );
  it.each([false, true])(
    "keeps knowledge model and source invalidation/publication in the claimed job trace; invalidated=%s",
    async (invalidated) => {
      let h: ReturnType<typeof setup>;
      h = setup(async () => {
        if (invalidated)
          h.db.exec("UPDATE knowledge_documents SET content_version=content_version+1");
        return knowledgeReply;
      });
      const repo = new KnowledgeRepository(h.db),
        settings = repo.settings();
      repo.updateSettings({
        ...settings,
        auto_enabled: true,
        expected_revision: settings.revision,
      });
      repo.importDocument({ category_id: "default", name: "synthetic", original_text: secret });
      const worker = new KnowledgeOrganizer({
        db: h.db,
        gateway: h.gateway,
        agentRuntime: h.runtime,
        telemetry: h.telemetry,
      });
      expect(await worker.runCycle()).toBe(true);
      await worker.stop();
      const spans = h.rows(),
        parent = spans.find((r) => r.name === "knowledge.job")!;
      expect(parent.status).toBe(invalidated ? "cancelled" : "completed");
      expect(spans.some((r) => r.stage === "model")).toBe(true);
      expect(new Set(spans.map((r) => r.trace_id))).toEqual(new Set([parent.trace_id]));
      expect(h.db.query("SELECT COUNT(*) AS n FROM knowledge_drafts").get()).toEqual({
        n: invalidated ? 0 : 1,
      });
      expect(JSON.stringify(spans)).not.toContain(secret);
    },
  );
});
