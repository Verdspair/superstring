import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { sourceAccess } from "../../src/server/agent/context-access";
import { inputUnits, textMessage } from "../../src/server/agent/context-engine";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { OneBotPrivateHost } from "../../src/server/channels/onebot11/private-host";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { WakeScheduler } from "../../src/server/conversation/wake-scheduler";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { createQqScheme, updateQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  createQqStickerCollection,
  importQqSticker,
  setQqStickerEnabled,
} from "../../src/server/db/qq-sticker-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import {
  nextQqImmediateReplyTask,
  peekQqImmediateReplyTask,
} from "../../src/server/services/qq-dispatch";
import { recordInbound } from "../../src/server/services/qq-intake";
import { qqStickerSelectionForScheme } from "../../src/server/services/qq-sticker-candidates";
import { qqStickerUsable } from "../../src/server/services/qq-sticker-contract";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const bindingId = "11111111-1111-4111-8111-111111111111",
  nowSeconds = 2_000_000_000;
function setup(model?: Partial<ModelPort>, options: { stickersAvailable?: boolean } = {}) {
  const clock = { seconds: nowSeconds };
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "chat-model");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "test",
    reply: { split_by_speaker: false },
    triggers: { direct_reply: true, follow_up: true, chiming_in: true, idle_topic: true },
  });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId: "10001",
      conversationKind: "private",
      peerId: "20002",
      agentId: DEFAULT_AGENT_ID,
      schemeId: scheme.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  const journal = new ConversationEventRepository(h.db),
    wakes = new WakeRepository(h.db),
    outbox = new OutboundIntentRepository(h.db),
    runs = new AgentRunRepository(h.db);
  const requests: ModelRequest[] = [];
  const runtime = new AgentRuntime({
    repository: runs,
    now: () => new Date(clock.seconds * 1000).toISOString(),
    model: {
      complete: async (req) => {
        requests.push(req);
        return '{"kind":"final","outputs":[{"kind":"generate","targetId":"20002","instructions":"answer"}]}';
      },
      async *streamText(req) {
        requests.push(req);
        yield "first\nsecond";
      },
      completeMultimodal: async () => "",
      ...model,
    },
  });
  const gateway = {
    loadedContextCapacity: async () => 65536,
    complete: async () => {
      throw new Error("DIRECT_GATEWAY_FORBIDDEN");
    },
  } as unknown as ModelGateway;
  const adapter = new OneBot11Adapter({
    orm: h.orm,
    journal,
    wakes,
    nowSeconds: () => clock.seconds,
  });
  const host = new OneBotPrivateHost({
    orm: h.orm,
    journal,
    wakes,
    outbox,
    gateway,
    agentRuntime: runtime,
    stickers: { counts: ["confirmed"], isAvailable: () => options.stickersAvailable ?? false },
    policy: () => ({ maxSteps: 12, deliveryTtlSeconds: 600, retentionDays: 14 }),
    now: () => new Date(clock.seconds * 1000).toISOString(),
  });
  const receive = (id: string, text = "hello") =>
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "private",
          sub_type: "friend",
          time: clock.seconds,
          self_id: 10001,
          user_id: 20002,
          message_id: id,
          message: [{ type: "text", data: { text } }],
          sender: { nickname: "Peer" },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: adapter },
    );
  return {
    ...h,
    clock,
    gateway,
    journal,
    wakes,
    outbox,
    runs,
    runtime,
    requests,
    adapter,
    host,
    receive,
    scheme,
  };
}
describe("OneBot private common host", () => {
  it("atomically journals intake and wake, runs decide/generate, commits intent before any send and preserves multipart", async () => {
    const h = setup();
    expect(h.receive("1")).toMatchObject({ kind: "recorded", recorded: true });
    h.receive("1");
    const conversation = h.journal.ensureOneBot(bindingId)!;
    expect(h.journal.eventsAfter(conversation.id).items).toHaveLength(1);
    const scheduler = new WakeScheduler({
      repository: h.wakes,
      policy: () => ({ leaseMs: 120000, renewMs: 30000, maxAttempts: 3, retryDelayMs: 1000 }),
      activate: (w, s) => h.host.activate(w, s),
      now: () => new Date(nowSeconds * 1000).toISOString(),
      onError: (e) => {
        throw e;
      },
    });
    expect(await scheduler.runOnce()).toBe(true);
    const intents = h.outbox.list({ conversationId: conversation.id });
    expect(intents).toHaveLength(1);
    expect(h.outbox.parts(intents[0]!.id).map((p) => JSON.parse(p.payload!))).toEqual([
      { text: "first" },
      { text: "second" },
    ]);
    expect(h.journal.get(conversation.id)!.consumedSeq).toBe(1);
    expect(h.db.query("SELECT * FROM qq_send_log").all()).toEqual([]);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[0]!.messages[0]!.content).not.toEqual(h.requests[1]!.messages[0]!.content);
    expect(
      h.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.private.main'").get(),
    ).toEqual({ status: "completed" });
  });
  it("re-enters deciding for a same-second inbound message during generation", async () => {
    let receive: ReturnType<typeof setup>["receive"];
    let decisions = 0,
      generations = 0;
    const h = setup({
      complete: async () => {
        decisions++;
        return '{"kind":"final","outputs":[{"kind":"generate","targetId":"20002","instructions":"answer"}]}';
      },
      async *streamText() {
        generations++;
        if (generations === 1) receive("2", "new same second");
        yield generations === 1 ? "old draft" : "new draft";
      },
    });
    receive = h.receive;
    receive("1");
    const wake = h.wakes.claim({ at: new Date(nowSeconds * 1000).toISOString(), leaseMs: 120000 })!;
    await h.host.activate(wake, new AbortController().signal);
    expect(decisions).toBe(2);
    expect(generations).toBe(2);
    expect(h.outbox.list({})).toHaveLength(1);
    expect(JSON.parse(h.outbox.parts(h.outbox.list({})[0]!.id)[0]!.payload!)).toEqual({
      text: "new draft",
    });
  });
  it("group-only legacy selection cannot consume a private wake", () => {
    const h = setup();
    h.receive("1");
    expect(peekQqImmediateReplyTask(h.orm, { nowSeconds }, ["group"])).toBeNull();
    expect(nextQqImmediateReplyTask(h.orm, { nowSeconds }, ["group"])).toBeNull();
    expect(
      h.wakes.peek({ at: new Date(nowSeconds * 1000).toISOString(), topology: "direct" })?.cause,
    ).toBe("direct_reply");
  });
  it("rolls back observation when journal/queue write fails", () => {
    const h = setup();
    h.db.exec(
      "CREATE TRIGGER fixture_fail BEFORE INSERT ON wake_signals BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    expect(h.receive("1")).toMatchObject({ kind: "discarded" });
    expect(h.db.query("SELECT * FROM qq_events").all()).toEqual([]);
    expect(h.db.query("SELECT * FROM conversation_events").all()).toEqual([]);
  });
});
describe("durable per-part delivery", () => {
  async function prepared() {
    const h = setup();
    h.receive("1");
    const wake = h.wakes.claim({ at: new Date(nowSeconds * 1000).toISOString(), leaseMs: 120000 })!;
    await h.host.activate(wake, new AbortController().signal);
    return { ...h, id: h.outbox.list({})[0]!.id };
  }
  it("writes sending before network, projects receipts once, appends delivery revisions", async () => {
    const h = await prepared();
    let sends = 0;
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      stickerFile: () => null,
      authorize: () => true,
      now: () => new Date(nowSeconds * 1000).toISOString(),
      port: {
        async send() {
          sends++;
          expect(h.outbox.parts(h.id).filter((p) => p.status === "sending")).toHaveLength(1);
          return { kind: "confirmed", messageId: String(sends) };
        },
      },
    });
    await delivery.deliver(h.id);
    await delivery.deliver(h.id);
    expect(sends).toBe(2);
    expect(h.outbox.get(h.id)!.status).toBe("confirmed");
    expect(h.db.query("SELECT COUNT(*) AS n FROM qq_send_log").get()).toEqual({ n: 1 });
    expect(h.db.query("SELECT body FROM qq_speech_text").get()).toEqual({ body: "first\nsecond" });
    expect(
      h.journal
        .eventsAfter(h.outbox.get(h.id)!.conversationId)
        .items.filter((e) => e.kind === "delivery").length,
    ).toBeGreaterThan(2);
  });
  it("unknown receipt never sends later parts or resends after restart", async () => {
    const h = await prepared();
    let sends = 0;
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      stickerFile: () => null,
      authorize: () => true,
      now: () => new Date(nowSeconds * 1000).toISOString(),
      port: {
        async send() {
          sends++;
          return { kind: "unknown", reason: "timeout" };
        },
      },
    });
    await delivery.deliver(h.id);
    delivery.recover();
    await delivery.runOnce();
    expect(sends).toBe(1);
    expect(h.outbox.get(h.id)!.parts.map((p) => p.status)).toEqual(["unknown", "not_sent"]);
    expect(h.db.query("SELECT * FROM qq_speech_text").all()).toEqual([]);
  });
  it("crash between parts retains confirmed text and makes obsolete unsent tail stale", async () => {
    const h = await prepared();
    const at = new Date(nowSeconds * 1000).toISOString();
    const first = h.outbox.claimPart(h.id, at)!;
    h.outbox.settlePart(first.part.id, { status: "confirmed", messageId: "delivered" }, at);
    let sends = 0,
      stale = 0;
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      stickerFile: () => null,
      authorize: () => true,
      onStale: () => {
        stale++;
      },
      now: () => new Date((nowSeconds + 601) * 1000).toISOString(),
      port: {
        async send() {
          sends++;
          return { kind: "confirmed", messageId: "should-not-send" };
        },
      },
    });
    delivery.recover();
    await delivery.runOnce();
    expect(sends).toBe(0);
    expect(stale).toBe(1);
    expect(h.outbox.get(h.id)!.parts.map((p) => p.status)).toEqual(["confirmed", "stale"]);
    expect(h.db.query("SELECT body FROM qq_speech_text").get()).toBeNull();
    expect(
      h.outbox.partialSpeechSince(h.outbox.get(h.id)!.conversationId, {
        sinceSeconds: nowSeconds - 1,
        limit: 10,
        at,
      }),
    ).toMatchObject([{ text: "first" }]);
    await delivery.runOnce();
    expect(h.db.query("SELECT COUNT(*) AS n FROM qq_send_log").get()).toEqual({ n: 1 });
  });
});

const finalGenerate =
  '{"kind":"final","outputs":[{"kind":"generate","targetId":"20002","instructions":"answer"}]}';
const stamp = (seconds = nowSeconds) => new Date(seconds * 1000).toISOString();
async function activate(h: ReturnType<typeof setup>) {
  const wake = h.wakes.claim({ at: stamp(h.clock.seconds), leaseMs: 120000 })!;
  return h.host.activate(wake, new AbortController().signal);
}
function addSticker(h: ReturnType<typeof setup>) {
  const collection = createQqStickerCollection(h.orm, { name: "test" });
  const id = crypto.randomUUID();
  importQqSticker(h.orm, {
    id,
    copy: { fileName: `${id}.png`, byteSize: 64, mediaType: "image" },
    name: "wave",
    width: 64,
    height: 64,
    collectionIds: [collection.id],
  });
  setQqStickerEnabled(h.orm, id, true);
  updateQqScheme(h.orm, h.scheme.id, {
    name: h.scheme.name,
    stickerCollections: [collection.id],
    expectedRevision: h.scheme.revision,
  });
  return id;
}
function setMemoryMode(h: ReturnType<typeof setup>, mode: string) {
  const row = h.db.query("SELECT p5_config FROM agents WHERE id=?").get(DEFAULT_AGENT_ID) as {
    p5_config: string;
  };
  const cfg = JSON.parse(row.p5_config);
  cfg.retrieval_mode = mode;
  h.db
    .query("UPDATE agents SET p5_config=?,memory_retrieval_model_name='memory-selector' WHERE id=?")
    .run(JSON.stringify(cfg), DEFAULT_AGENT_ID);
}
function addMemory(h: ReturnType<typeof setup>, body = "apples are green") {
  const id = crypto.randomUUID();
  h.orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: "apples",
      summary: "apples",
      tags: '["apples"]',
      kinds: '["semantic"]',
      body,
      scope: "reality_user",
      scopeKey: JSON.stringify(["qq", "10001", "private", "20002", DEFAULT_AGENT_ID]),
      configSnapshot: "{}",
      createdAt: stamp(),
    })
    .run();
  h.receive("900", "apples");
  const event = h.db.query("SELECT event_key FROM qq_events WHERE message_id=?").get("900") as {
    event_key: string;
  };
  h.orm
    .insert(schema.qqMemorySources)
    .values({
      memoryId: id,
      eventKey: event.event_key,
      scopeKey: JSON.stringify(["qq", "10001", "private", "20002", DEFAULT_AGENT_ID]),
      conversationKey: JSON.stringify(["10001", "private", "20002"]),
      messageId: "900",
      occurredAtSeconds: nowSeconds,
      speakerKind: "member",
      speakerId: "20002",
    })
    .run();
  return id;
}
describe("private feature preservation", () => {
  it("preserves a sticker-only generated reply and inherited source references", async () => {
    let count = 0;
    const h = setup(
      {
        complete: async () => (++count === 1 ? finalGenerate : "1"),
        async *streamText() {
          yield "";
        },
      },
      { stickersAvailable: true },
    );
    const id = addSticker(h);
    setMemoryMode(h, "full_body");
    const memoryId = addMemory(h);
    h.receive("1");
    const result = await activate(h);
    expect(result.status).toBe("completed");
    expect(h.outbox.parts(h.outbox.list({})[0]!.id).map((p) => JSON.parse(p.payload!))).toEqual([
      { stickerId: id },
    ]);
    expect(
      h.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.sticker.select'").get(),
    ).toEqual({ status: "completed" });
    const snapshot = h.db
      .query(
        "SELECT c.source_refs FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id JOIN agent_runs r ON r.run_id=s.run_id WHERE r.spec_id='onebot.sticker.select'",
      )
      .get() as { source_refs: string };
    expect(JSON.parse(snapshot.source_refs).map((r: { kind: string }) => r.kind)).toContain(
      "qq_observation",
    );
    expect(JSON.parse(snapshot.source_refs).some((r: { id: string }) => r.id === memoryId)).toBe(
      true,
    );
    h.db.query("DELETE FROM memory_entries WHERE id=?").run(memoryId);
    expect(
      h.db
        .query(
          "SELECT c.protected_messages FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id JOIN agent_runs r ON r.run_id=s.run_id WHERE r.spec_id='onebot.sticker.select'",
        )
        .get(),
    ).toEqual({ protected_messages: null });
  });
  it("blank reply without usable sticker completes no_output without an orphan output id", async () => {
    const h = setup({
      async *streamText() {
        yield "";
      },
    });
    h.receive("1");
    const result = await activate(h);
    expect(result.status).toBe("no_output");
    expect(h.outbox.list({})).toEqual([]);
    expect(h.requests).toHaveLength(1);
    expect(h.db.query("SELECT status FROM wake_signals").get()).toEqual({ status: "no_output" });
  });
  it("honors explicit inline sticker id and never substitutes an automatic choice", async () => {
    let id = "",
      calls = 0;
    const h = setup(
      {
        complete: async () => {
          calls++;
          return JSON.stringify({
            kind: "final",
            outputs: [{ kind: "inline", targetId: "20002", text: "", stickerIds: [id] }],
          });
        },
      },
      { stickersAvailable: true },
    );
    id = addSticker(h);
    h.receive("1");
    await activate(h);
    expect(calls).toBe(1);
    expect(h.outbox.parts(h.outbox.list({})[0]!.id).map((p) => JSON.parse(p.payload!))).toEqual([
      { stickerId: id },
    ]);
  });
  for (const mode of ["off", "conservative", "standard", "broad", "full_catalog", "full_body"]) {
    it(`preserves initial memory ${mode} mode and selector routing`, async () => {
      let id = "",
        selectors = 0;
      let mainContext = "";
      const h = setup({
        complete: async (req) => {
          if ((req.responseSchema?.properties as Record<string, unknown> | undefined)?.ids) {
            selectors++;
            expect(req.model).toBe("memory-selector");
            return JSON.stringify({ ids: [id] });
          }
          mainContext = JSON.stringify(req.messages);
          return '{"kind":"none"}';
        },
      });
      setMemoryMode(h, mode);
      id = addMemory(h);
      h.receive("1", "apples");
      await activate(h);
      expect(mainContext.includes("apples are green")).toBe(mode !== "off");
      expect(selectors > 0).toBe(!["off", "full_body"].includes(mode));
    });
  }
  it("source deletion while generating blocks commit and preserves source cursor", async () => {
    let remove = () => {};
    const h = setup({
      async *streamText() {
        remove();
        yield "uses deleted memory";
      },
    });
    setMemoryMode(h, "full_body");
    const id = addMemory(h);
    remove = () => {
      h.db.query("DELETE FROM memory_entries WHERE id=?").run(id);
    };
    h.receive("1", "apples");
    await expect(activate(h)).rejects.toThrow("CONTEXT_SOURCE_INVALID");
    expect(h.outbox.list({})).toEqual([]);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
    expect(
      h.db
        .query(
          "SELECT COUNT(*) AS n FROM context_snapshots WHERE protected_messages IS NOT NULL AND source_refs LIKE ?",
        )
        .get(`%${id}%`),
    ).toEqual({ n: 0 });
  });
  it("expired direct wake never calls model and never consumes a different idle cause", async () => {
    const h = setup();
    h.receive("1");
    const c = h.journal.ensureOneBot(bindingId)!;
    h.wakes.enqueue({
      conversationId: c.id,
      cause: "idle_topic",
      throughSeq: c.lastSeq,
      dedupeKey: "idle",
      readyAt: stamp(nowSeconds + 601),
      at: stamp(),
      priority: 0,
    });
    h.clock.seconds += 601;
    const result = await activate(h);
    expect(result.status).toBe("expired");
    expect(h.requests).toEqual([]);
    expect(h.wakes.peek({ at: stamp(h.clock.seconds) })?.cause).toBe("idle_topic");
  });
  it("stop is terminal and does not claim a new wake", async () => {
    const h = setup();
    h.receive("1");
    let calls = 0;
    const scheduler = new WakeScheduler({
      repository: h.wakes,
      policy: () => ({ leaseMs: 1000, renewMs: 200, retryDelayMs: 100, maxAttempts: 3 }),
      activate: async () => {
        calls++;
      },
      now: () => stamp(),
    });
    scheduler.stop();
    expect(await scheduler.runOnce()).toBe(false);
    expect(calls).toBe(0);
    expect(h.wakes.peek({ at: stamp() })?.status).toBe("pending");
  });
  it("offline housekeeping removes expired pending payloads and redacts partial snapshots", async () => {
    const h = setup();
    h.receive("1");
    await activate(h);
    const intent = h.outbox.list({})[0]!;
    const first = h.outbox.claimPart(intent.id, stamp())!;
    h.outbox.settlePart(first.part.id, { status: "confirmed", messageId: "first" }, stamp());
    const speech = h.outbox.partialSpeechSince(intent.conversationId, {
      sinceSeconds: nowSeconds - 1,
      limit: 10,
      at: stamp(),
    })[0]!;
    expect(
      sourceAccess(
        h.db,
        speech.sources[0]!,
        {
          kind: "conversation",
          id: intent.conversationId,
          userId: DEFAULT_USER_ID,
          agentId: DEFAULT_AGENT_ID,
        },
        { userId: DEFAULT_USER_ID },
        stamp(),
      ),
    ).toBe("available");
    await h.runtime.completeLeaf(
      { id: "fixture.partial" },
      {
        owner: {
          kind: "conversation",
          id: intent.conversationId,
          userId: DEFAULT_USER_ID,
          agentId: DEFAULT_AGENT_ID,
        },
        messages: [{ role: "user", content: speech.text }],
        sources: speech.sources,
      },
    );
    h.outbox.purgeExpired(stamp(nowSeconds + 15 * 86400));
    expect(h.outbox.get(intent.id)!.parts.map((p) => p.status)).toEqual(["confirmed", "stale"]);
    expect(h.outbox.parts(intent.id).every((p) => p.payload === null)).toBe(true);
    expect(
      h.db
        .query(
          "SELECT c.protected_messages FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id JOIN agent_runs r ON r.run_id=s.run_id WHERE r.spec_id='fixture.partial'",
        )
        .get(),
    ).toEqual({ protected_messages: null });
  });
  it("delayed disabled sticker is skipped while confirmed text and CQ mention survive", async () => {
    let count = 0;
    const h = setup(
      {
        complete: async () => (++count === 1 ? finalGenerate : "1"),
        async *streamText() {
          yield "[CQ:at,qq=20002] hello";
        },
      },
      { stickersAvailable: true },
    );
    const stickerId = addSticker(h);
    h.receive("1");
    await activate(h);
    const intent = h.outbox.list({})[0]!;
    setQqStickerEnabled(h.orm, stickerId, false);
    const requests: unknown[] = [];
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      stickerFile: () => "base64://file",
      authorize: () => true,
      now: () => stamp(),
      stickerAvailable: (id, target, at) => {
        const selected = qqStickerSelectionForScheme(h.orm, {
          schemeId: target.schemeId!,
          scope: {
            kind: "qq",
            accountId: target.accountId,
            conversationKind: target.conversationKind,
            peerId: target.peerId,
            agentId: target.agentId,
          },
          counts: ["confirmed"],
          nowSeconds: Date.parse(at) / 1000,
          isAvailable: () => true,
        });
        return selected.candidates.some(
          (c) =>
            c.id === id &&
            qqStickerUsable(c, { minRepeatSeconds: selected.minRepeatSeconds }).kind === "usable",
        );
      },
      port: {
        async send(request) {
          requests.push(request);
          return { kind: "confirmed", messageId: "confirmed" };
        },
      },
    });
    await delivery.deliver(intent.id);
    expect(requests).toEqual([
      {
        kind: "private",
        peerId: "20002",
        message: [
          { type: "at", data: { qq: "20002" } },
          { type: "text", data: { text: " hello" } },
        ],
      },
    ]);
    expect(h.outbox.get(intent.id)!.parts.map((p) => p.status)).toEqual(["confirmed", "not_sent"]);
  });
});

describe("private initiative and cancellation", () => {
  it("uses the global judgement model with memory and granted knowledge in the original score prompt", async () => {
    let stage = 0;
    let judgement: ModelRequest | undefined;
    const h = setup({
      complete: async (req) => {
        if ((req.responseSchema?.properties as Record<string, unknown> | undefined)?.score) {
          judgement = req;
          return '{"score":0}';
        }
        return ++stage === 1
          ? '{"kind":"invoke","name":"speech.evaluate","arguments":{}}'
          : '{"kind":"none"}';
      },
    });
    setMemoryMode(h, "off");
    addMemory(h);
    const repo = new KnowledgeRepository(h.db);
    const doc = repo.importDocument({
      name: "apples manual",
      category_id: "default",
      original_text: "apples knowledge line",
    });
    repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
    updateQqSettings(h.orm, { judgementModelName: "global-judge", expectedRevision: 2 });
    h.receive("1", "apples");
    h.db.exec("UPDATE wake_signals SET status='no_output'");
    h.clock.seconds += 16 * 60;
    const c = h.journal.ensureOneBot(bindingId)!;
    h.wakes.enqueue({
      conversationId: c.id,
      cause: "idle_topic",
      throughSeq: c.lastSeq,
      dedupeKey: "idle-eval",
      readyAt: stamp(h.clock.seconds),
      at: stamp(h.clock.seconds),
      priority: 0,
    });
    const result = await activate(h);
    expect(result.status).toBe("no_output");
    expect(judgement?.model).toBe("global-judge");
    const text = JSON.stringify(judgement?.messages);
    expect(text).toContain("apples are green");
    expect(text).toContain("apples knowledge line");
    expect(h.outbox.list({})).toEqual([]);
    const sources = h.db
      .query(
        "SELECT c.source_refs FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id JOIN agent_runs r ON r.run_id=s.run_id WHERE r.spec_id='onebot.initiative.evaluate'",
      )
      .get() as { source_refs: string };
    expect(JSON.parse(sources.source_refs).map((r: { kind: string }) => r.kind)).toEqual(
      expect.arrayContaining(["memory", "knowledge_document", "knowledge_grant", "qq_observation"]),
    );
  });
  it("cancellation during generation records a cancelled run without advancing source cursor", async () => {
    const controller = new AbortController();
    const h = setup({
      async *streamText(req) {
        controller.abort(new DOMException("cancelled", "AbortError"));
        req.signal?.throwIfAborted();
        yield "not visible";
      },
    });
    h.receive("1");
    const wake = h.wakes.claim({ at: stamp(), leaseMs: 120000 })!;
    await expect(h.host.activate(wake, controller.signal)).rejects.toThrow();
    expect(h.outbox.list({})).toEqual([]);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
    expect(
      h.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.private.main'").get(),
    ).toEqual({ status: "cancelled" });
  });
  it("retention during an in-flight send erases payload but still accepts the eventual receipt", async () => {
    const h = setup();
    h.receive("1");
    await activate(h);
    const intent = h.outbox.list({})[0]!;
    const first = h.outbox.claimPart(intent.id, stamp())!;
    h.outbox.purgeExpired(stamp(nowSeconds + 15 * 86400));
    expect(h.outbox.parts(intent.id).every((p) => p.payload === null)).toBe(true);
    expect(h.outbox.get(intent.id)!.parts.map((p) => p.status)).toEqual(["sending", "stale"]);
    h.outbox.settlePart(
      first.part.id,
      { status: "confirmed", messageId: "late-receipt" },
      stamp(nowSeconds + 15 * 86400),
    );
    expect(h.outbox.get(intent.id)!.parts[0]!.platformMessageId).toBe("late-receipt");
  });
});

describe("Bot production knowledge reading settings", () => {
  for (const mode of ["disabled", "selected", "tiny_budget", "frozen"] as const)
    it(`applies ${mode} knowledge settings to Agent action reads`, async () => {
      const seen: ModelRequest[] = [];
      let decisions = 0;
      let h: ReturnType<typeof setup>;
      h = setup({
        complete: async (request) => {
          seen.push(request);
          if ((request.responseSchema?.properties as Record<string, unknown> | undefined)?.ids) {
            const part = request.messages[1]!.content.find((part) => part.kind === "text");
            const data = JSON.parse(part?.kind === "text" ? part.text : "{}");
            return JSON.stringify({ ids: data.candidates.map((item: { id: string }) => item.id) });
          }
          decisions++;
          if (decisions === 1 && mode !== "disabled") {
            if (mode === "frozen")
              h.db.exec(
                "UPDATE agent_knowledge_read_settings SET enabled=0, context_budget=1, document_ids='[]', revision=revision+1",
              );
            return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
          }
          return '{"kind":"none"}';
        },
      });
      const library = new KnowledgeRepository(h.db);
      const selected = library.importDocument({
        name: "apples selected",
        category_id: "default",
        original_text: "apples ALLOWED_KNOWLEDGE",
      });
      const excluded = library.importDocument({
        name: "apples excluded",
        category_id: "default",
        original_text: "apples EXCLUDED_KNOWLEDGE",
      });
      for (const doc of [selected, excluded])
        library.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
      h.db
        .query(
          "UPDATE agent_knowledge_read_settings SET enabled=?, context_budget=?, scope='selected', document_ids=? WHERE agent_id=?",
        )
        .run(
          mode === "disabled" ? 0 : 1,
          mode === "tiny_budget" ? 1 : 4096,
          JSON.stringify([selected.id]),
          DEFAULT_AGENT_ID,
        );
      h.receive("1", "apples");
      expect((await activate(h)).status).toBe("no_output");
      const text = JSON.stringify(seen.map((request) => request.messages));
      expect(text).not.toContain("EXCLUDED_KNOWLEDGE");
      expect(text.includes("ALLOWED_KNOWLEDGE")).toBe(mode === "selected" || mode === "frozen");
      const selectors = seen.filter(
        (request) =>
          (request.responseSchema?.properties as Record<string, unknown> | undefined)?.ids,
      );
      expect(selectors.length > 0).toBe(mode === "selected" || mode === "frozen");
      if (mode === "disabled") expect(text).not.toContain("knowledge.query");
      if (mode === "frozen") expect(selectors).toHaveLength(1);
    });
});

it.each([2000, 1])(
  "caps cumulative knowledge action observations within frozen budget %i",
  async (budget) => {
    const main: ModelRequest[] = [];
    let decisions = 0;
    const h = setup({
      complete: async (request) => {
        if ((request.responseSchema?.properties as Record<string, unknown> | undefined)?.ids) {
          const part = request.messages[1]!.content.find((part) => part.kind === "text");
          const data = JSON.parse(part?.kind === "text" ? part.text : "{}");
          return JSON.stringify({ ids: data.candidates.map((item: { id: string }) => item.id) });
        }
        main.push(request);
        return ++decisions <= 3
          ? '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}'
          : '{"kind":"none"}';
      },
    });
    const library = new KnowledgeRepository(h.db);
    const doc = library.importDocument({
      name: "apples",
      category_id: "default",
      original_text: "apples " + "a".repeat(500),
    });
    library.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
    h.db
      .query("UPDATE agent_knowledge_read_settings SET context_budget=? WHERE agent_id=?")
      .run(budget, DEFAULT_AGENT_ID);
    h.receive("1", "apples");
    expect((await activate(h)).status).toBe("no_output");
    const observations = main.at(-1)!.messages.flatMap((message) =>
      message.content.flatMap((part) => {
        if (part.kind !== "text") return [];
        try {
          const data = JSON.parse(part.text);
          return data.kind === "action_observation" && data.value.name === "knowledge.query"
            ? [data.value]
            : [];
        } catch {
          return [];
        }
      }),
    );
    expect(observations).toHaveLength(3);
    expect(observations[0].value).toHaveLength(budget === 2000 ? 1 : 0);
    expect(observations[1].value).toHaveLength(0);
    expect(observations[2].value).toHaveLength(0);
    expect(
      inputUnits(
        observations
          .filter((observation) => observation.value.length > 0)
          .map((observation) =>
            textMessage(
              "user",
              JSON.stringify({
                kind: "action_observation",
                trust: "data_only",
                value: observation,
              }),
            ),
          ),
      ) - 3,
    ).toBeLessThanOrEqual(budget);
  },
);

it("private conversation commits one logical output while retaining all transport parts", async () => {
  const h = setup({
    complete: async () =>
      JSON.stringify({
        kind: "final",
        outputs: [
          { kind: "generate", targetId: "20002", instructions: "first" },
          { kind: "inline", targetId: "20002", text: "duplicate", stickerIds: [] },
        ],
      }),
  });
  h.receive("1");
  const result = await activate(h);
  expect(result.status).toBe("completed");
  expect("outputs" in result ? result.outputs.map((output) => output.status) : []).toEqual([
    "prepared",
    "blocked",
  ]);
  const intents = h.outbox.list({});
  expect(intents).toHaveLength(1);
  expect(h.outbox.parts(intents[0]!.id).map((part) => JSON.parse(part.payload!).text)).toEqual([
    "first",
    "second",
  ]);
});

it("keeps a failed private generation failed without consuming the wake or source cursor", async () => {
  const h = setup({
    async *streamText() {
      yield "unfinished partial";
      throw new Error("MODEL_UNAVAILABLE");
    },
  });
  h.receive("1");
  const conversation = h.journal.ensureOneBot(bindingId)!;
  await expect(activate(h)).rejects.toMatchObject({ code: "AGENT_OUTPUT_FAILED" });
  expect(h.outbox.list({})).toHaveLength(0);
  expect(h.journal.get(conversation.id)!.consumedSeq).toBe(0);
  expect(
    h.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.private.main'").get(),
  ).toEqual({ status: "failed" });
  expect(h.db.query("SELECT status FROM wake_signals").get()).toEqual({ status: "leased" });
});
