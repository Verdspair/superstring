import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { OneBotHost } from "../../src/server/channels/onebot11/bot-host";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const bindingId = "11111111-1111-4111-8111-111111111111",
  time = 2_000_000_000;
function setup(
  model: Partial<ModelPort> = {},
  options: { split?: boolean; recomputes?: number; mergeSeconds?: number } = {},
) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  updateQqSettings(h.orm, {
    accountId: "10001",
    enabled: true,
    judgementModelName: "judge-model",
    expectedRevision: 1,
  });
  const scheme = createQqScheme(h.orm, {
    name: "group",
    reply: { split_by_speaker: options.split ?? true },
    triggers: { direct_reply: true, follow_up: true, chiming_in: true, idle_topic: true },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      merge_window_seconds: options.mergeSeconds ?? 2,
      max_recompute_count: options.recomputes ?? 1,
      judgement_interval_turns: 1,
    },
  });
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group','30003',?,?,?,?)",
    )
    .run(
      bindingId,
      DEFAULT_AGENT_ID,
      scheme.id,
      new Date(time * 1000).toISOString(),
      new Date(time * 1000).toISOString(),
    );
  const clock = { seconds: time };
  const now = () => new Date(clock.seconds * 1000).toISOString();
  const journal = new ConversationEventRepository(h.db),
    wakes = new WakeRepository(h.db),
    outbox = new OutboundIntentRepository(h.db),
    runs = new AgentRunRepository(h.db);
  const requests: ModelRequest[] = [];
  const runtime = new AgentRuntime({
    repository: runs,
    now,
    model: {
      complete: async (req) => {
        requests.push(req);
        return '{"kind":"none"}';
      },
      async *streamText(req) {
        requests.push(req);
        yield "reply\nfor target";
      },
      completeMultimodal: async () => "",
      ...model,
    },
  });
  const gateway = {
    complete: async () => {
      throw new Error("UNIFIED_RUNTIME_REQUIRED");
    },
    loadedContextCapacity: async () => 65536,
  };
  const adapter = new OneBot11Adapter({
    orm: h.orm,
    journal,
    wakes,
    nowSeconds: () => clock.seconds,
  });
  const host = new OneBotHost({
    orm: h.orm,
    journal,
    wakes,
    outbox,
    agentRuntime: runtime,
    gateway,
    stickers: { counts: ["confirmed"], isAvailable: () => false },
    policy: () => ({ maxSteps: 20, deliveryTtlSeconds: 600, retentionDays: 14 }),
    now,
  });
  const receive = (
    id: string,
    speaker = "20002",
    addressed = false,
    text = "hello",
    reply?: string,
  ) =>
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: clock.seconds,
          self_id: 10001,
          user_id: Number(speaker),
          group_id: 30003,
          message_id: id,
          message: [
            ...(reply ? [{ type: "reply", data: { id: reply } }] : []),
            ...(addressed ? [{ type: "at", data: { qq: "10001" } }] : []),
            { type: "text", data: { text } },
          ],
          sender: { nickname: speaker },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: adapter },
    );
  const activate = async (cause?: string) => {
    const wake = wakes.claim({ at: now(), leaseMs: 120000, cause })!;
    expect(wake).not.toBeNull();
    return host.activate(wake, new AbortController().signal);
  };
  return {
    ...h,
    journal,
    wakes,
    outbox,
    runs,
    requests,
    runtime,
    adapter,
    host,
    clock,
    now,
    receive,
    activate,
    scheme,
  };
}
const generate = (ids: string[]) =>
  JSON.stringify({
    kind: "final",
    outputs: ids.map((targetId) => ({ kind: "generate", targetId, instructions: "respond" })),
  });
describe("shared Bot model-controlled conversation", () => {
  it("keeps addressed target even when another speaker is newer; unrelated later events do not block delivery", async () => {
    let h: ReturnType<typeof setup>;
    let generated = 0;
    h = setup({
      complete: async () => generate(["20002"]),
      async *streamText(req) {
        expect(req.model).toBe("reply-model");
        generated++;
        h.receive("3", "20004", false, "unrelated during output");
        yield "answer\nline";
      },
    });
    h.receive("1", "20002", true);
    h.receive("2", "20003", false);
    const result = await h.activate("direct_reply");
    expect(result.status).toBe("completed");
    expect(generated).toBe(1);
    const intent = h.outbox.list({})[0]!;
    expect(intent.target).toEqual({ peerId: "30003", participantId: "20002" });
    const sends: unknown[] = [];
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      authorize: () => true,
      stickerFile: () => null,
      now: h.now,
      port: {
        async send(request) {
          sends.push(request);
          return { kind: "confirmed", messageId: "sent" };
        },
      },
    });
    await delivery.deliver(intent.id);
    expect(sends).toEqual([
      {
        kind: "group",
        peerId: "30003",
        message: [
          { type: "at", data: { qq: "20002" } },
          { type: "text", data: { text: "answer line" } },
        ],
      },
    ]);
  });
  it("ordinary group activity keeps participant opportunities and one Agent run evaluates and replies to the mature batch", async () => {
    let decisions = 0;
    const scoreModels: string[] = [];
    const generated: string[] = [];
    const h = setup({
      complete: async (req) => {
        if ((req.responseSchema?.properties as Record<string, unknown> | undefined)?.score) {
          scoreModels.push(req.model!);
          return '{"score":9}';
        }
        expect(req.model).toBe("judge-model");
        return ++decisions === 1
          ? '{"kind":"invoke","name":"speech.evaluate","arguments":{}}'
          : generate(["20002", "20003"]);
      },
      async *streamText(req) {
        generated.push(JSON.stringify(req.messages[0]));
        yield "separate\nmessage";
      },
    });
    h.receive("1", "20002");
    h.clock.seconds++;
    h.receive("2", "20003");
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 2 });
    expect(h.wakes.peek({ at: h.now() })).toBeNull();
    h.clock.seconds += 2;
    const result = await h.activate("chiming_in");
    expect(result.status).toBe("completed");
    expect(scoreModels).toEqual(["judge-model", "judge-model"]);
    expect(generated).toHaveLength(2);
    expect(generated[0]).toContain("20002");
    expect(generated[1]).toContain("20003");
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002", "20003"]);
    expect(h.outbox.list({}).map((d) => h.outbox.parts(d.id).length)).toEqual([1, 1]);
  });
  it("keeps shared replies unsplit with no forced recipient when the scheme switch is off", async () => {
    const h = setup({ complete: async () => generate(["30003", "30003"]) }, { split: false });
    h.receive("1", "20002", true);
    await h.activate("direct_reply");
    expect(h.outbox.list({})).toHaveLength(1);
    const intent = h.outbox.list({})[0]!;
    expect(intent.target).toEqual({ peerId: "30003", participantId: null });
    expect(h.outbox.parts(intent.id)).toHaveLength(2);
  });
  it("verified reply to an assistant receipt is addressed without fabricating a mention", () => {
    const h = setup();
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "100", stickerId: null }],
      text: "assistant",
      sentAtSeconds: time - 1,
    });
    h.receive("1", "20002", false, "reply", "100");
    const c = h.journal.ensureOneBot(bindingId)!;
    const message = h.journal.eventsAfter(c.id).items.find((e) => e.kind === "inbound")!;
    expect(message.addressing.reasons).toEqual(["reply_to_agent"]);
    expect(message.addressing.mentionIds).toEqual([]);
    expect(h.wakes.peek({ at: h.now() })?.cause).toBe("direct_reply");
  });
  it("a new unaddressed partner message after own speech becomes follow_up", async () => {
    const h = setup({ complete: async () => generate(["20002"]) });
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "100", stickerId: null }],
      text: "assistant",
      sentAtSeconds: time - 1,
    });
    h.receive("1");
    expect(h.wakes.peek({ at: h.now() })?.cause).toBe("follow_up");
    expect((await h.activate("follow_up")).status).toBe("completed");
  });
  for (const count of [0, 2])
    it(`bounds independent generation calls with configured recompute budget ${count}`, async () => {
      let h: ReturnType<typeof setup>;
      let generations = 0;
      h = setup(
        {
          complete: async (request) =>
            JSON.stringify(request.messages).includes("generation_budget_exhausted")
              ? '{"kind":"none"}'
              : generate(["20002"]),
          async *streamText() {
            generations++;
            if (generations <= 2) h.receive(String(generations + 1), "20002", true);
            yield "draft";
          },
        },
        { recomputes: count },
      );
      h.receive("1", "20002", true);
      if (count === 0) {
        expect((await h.activate()).status).toBe("no_output");
        expect(generations).toBe(1);
        expect(h.outbox.list({})).toEqual([]);
        expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBeGreaterThan(0);
      } else {
        expect((await h.activate()).status).toBe("completed");
        expect(generations).toBe(3);
        expect(h.outbox.list({})).toHaveLength(1);
      }
    });
  it("migrates a pending legacy candidate once without changing its ready time", () => {
    const h = setup();
    h.receive("1");
    const event = h.db.query("SELECT event_key FROM qq_events WHERE message_id='1'").get() as {
      event_key: string;
    };
    h.db.exec("DELETE FROM wake_signals");
    h.db
      .query(
        "INSERT INTO qq_dispatch_candidates(conversation_key,binding_id,event_key,path,ready_at_seconds,observed_at_seconds,generation) VALUES('legacy',?,?,'chiming_in',?,?,4)",
      )
      .run(bindingId, event.event_key, time + 10, time);
    expect(h.adapter.migrateLegacyCandidates()).toBe(1);
    expect(h.adapter.migrateLegacyCandidates()).toBe(0);
    expect(h.db.query("SELECT ready_at,through_seq FROM wake_signals").get()).toMatchObject({
      ready_at: new Date((time + 10) * 1000).toISOString(),
      through_seq: 1,
    });
    expect(h.db.query("SELECT * FROM qq_dispatch_candidates").all()).toEqual([]);
  });
});
describe("shared configuration and races", () => {
  for (const mode of ["hard", "soft"])
    it(`preserves ${mode} attention semantics on the actual new ingress`, async () => {
      const h = setup({ complete: async () => generate(["20003"]) });
      h.db
        .query("UPDATE qq_bindings SET attention_mode=?,attention_members='[\"20002\"]' WHERE id=?")
        .run(mode, bindingId);
      h.receive("1", "20003", true);
      if (mode === "hard") {
        expect(h.wakes.peek({ at: h.now() })).toBeNull();
        expect(
          h.journal
            .eventsAfter(h.journal.ensureOneBot(bindingId)!.id)
            .items.filter((e) => e.kind === "inbound"),
        ).toHaveLength(1);
      } else {
        expect((await h.activate()).status).toBe("completed");
        expect(h.outbox.list({})[0]!.target?.participantId).toBe("20003");
      }
    });
  it("continues another recipient after one generation fails and preserves both output statuses", async () => {
    let decisions = 0;
    const h = setup({
      complete: async (req) =>
        (req.responseSchema?.properties as Record<string, unknown> | undefined)?.score
          ? '{"score":9}'
          : ++decisions === 1
            ? '{"kind":"invoke","name":"speech.evaluate","arguments":{}}'
            : generate(["20002", "20003"]),
      async *streamText(req) {
        if (JSON.stringify(req.messages[0]).includes('authorizedTarget\\":\\"20002'))
          throw new Error("MODEL_FAILED");
        yield "second recipient survives";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const result = await h.activate();
    expect(result.status).toBe("completed");
    expect("outputs" in result ? result.outputs.map((o) => o.status) : []).toEqual([
      "failed",
      "prepared",
    ]);
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20003"]);
  });
  it("a related message buried under an unrelated latest message still causes a new decision", async () => {
    let h: ReturnType<typeof setup>;
    let generations = 0;
    h = setup({
      complete: async () => generate(["20002"]),
      async *streamText() {
        generations++;
        if (generations === 1) {
          h.receive("2", "20002", false, "related");
          h.receive("3", "20004", false, "unrelated latest");
        }
        yield "reply";
      },
    });
    h.receive("1", "20002", true);
    expect((await h.activate()).status).toBe("completed");
    expect(generations).toBe(2);
  });
  it("new addressed participant becomes an authorized target when re-deciding", async () => {
    let h: ReturnType<typeof setup>;
    let calls = 0;
    h = setup({
      complete: async (req) => {
        calls++;
        if (calls === 2) expect(JSON.stringify(req.messages[0])).toContain("20003");
        return generate(calls === 1 ? ["20002"] : ["20002", "20003"]);
      },
      async *streamText() {
        if (calls === 1) h.receive("2", "20003", true);
        yield "reply";
      },
    });
    h.receive("1", "20002", true);
    await h.activate();
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002", "20003"]);
  });
  it("new addressed message after final but before network marks the committed plan stale", async () => {
    const h = setup({ complete: async () => generate(["20002"]) });
    h.receive("1", "20002", true);
    await h.activate();
    const intent = h.outbox.list({})[0]!;
    h.receive("2", "20003", true);
    h.receive("3", "20004", false);
    let sends = 0;
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      authorize: () => true,
      stickerFile: () => null,
      now: h.now,
      port: {
        async send() {
          sends++;
          return { kind: "confirmed", messageId: "unexpected" };
        },
      },
    });
    await delivery.deliver(intent.id);
    expect(sends).toBe(0);
    expect(h.outbox.get(intent.id)!.status).toBe("stale");
  });
  it("idle initiative threshold and unanswered rule remain active under the same host", async () => {
    let stage = 0;
    const h = setup({
      complete: async (req) =>
        (req.responseSchema?.properties as Record<string, unknown> | undefined)?.score
          ? '{"score":0}'
          : ++stage === 1
            ? '{"kind":"invoke","name":"speech.evaluate","arguments":{}}'
            : '{"kind":"none"}',
    });
    h.receive("1");
    h.db.exec("UPDATE wake_signals SET status='no_output'");
    h.clock.seconds += 16 * 60;
    h.adapter.sweep();
    expect((await h.activate("idle_topic")).status).toBe("no_output");
    expect(h.outbox.list({})).toEqual([]);
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "idle_topic",
      parts: [{ kind: "text", result: "confirmed", messageId: "200", stickerId: null }],
      text: "opener",
      sentAtSeconds: h.clock.seconds,
    });
    h.clock.seconds += 16 * 60;
    h.adapter.sweep();
    expect(h.wakes.peek({ at: h.now(), cause: "idle_topic" })).toBeNull();
  });
});
describe("failed generation and observation epochs", () => {
  it("all failed generations fail the run and leave wake/source unacknowledged", async () => {
    const h = setup({
      complete: async () => generate(["20002"]),
      async *streamText() {
        yield await Promise.reject<string>(new Error("MODEL_FAILURE"));
      },
    });
    h.receive("1", "20002", true);
    await expect(h.activate()).rejects.toThrow("No output could be prepared");
    expect(h.outbox.list({})).toEqual([]);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
    expect(h.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.main'").get()).toEqual({
      status: "failed",
    });
  });
  it("new related input requires a score bound to the new observation epoch", async () => {
    let h: ReturnType<typeof setup>;
    let next = 0,
      scores = 0,
      generations = 0;
    const epochs: number[] = [];
    h = setup({
      complete: async (req) => {
        if ((req.responseSchema?.properties as Record<string, unknown> | undefined)?.score) {
          scores++;
          return '{"score":9}';
        }
        next++;
        const system = JSON.stringify(req.messages[0]);
        const epoch = Number(system.match(/当前观察序列：(\d+)/)?.[1]);
        epochs.push(epoch);
        return next === 1 || next === 3
          ? '{"kind":"invoke","name":"speech.evaluate","arguments":{}}'
          : generate(["20002"]);
      },
      async *streamText() {
        generations++;
        if (generations === 1) {
          h.receive("2", "20002", false, "new material");
          h.clock.seconds += 2;
        }
        yield "answer";
      },
    });
    h.receive("1");
    h.clock.seconds += 2;
    expect((await h.activate()).status).toBe("completed");
    expect(scores).toBe(2);
    expect(generations).toBe(2);
    expect(epochs[2]!).toBeGreaterThan(epochs[0]!);
    expect(h.outbox.list({})).toHaveLength(1);
  });
});

describe("immediate opportunity coverage", () => {
  function previousSpeech(h: ReturnType<typeof setup>) {
    recordQqSend(
      h.orm,
      {
        scope: {
          kind: "qq",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
        },
        kind: "direct_reply",
        parts: [{ kind: "text", result: "confirmed", messageId: "previous" }],
        text: "previous",
        sentAtSeconds: time - 10,
      },
      undefined,
      h.db,
    );
  }
  function transport(h: ReturnType<typeof setup>, status: "confirmed" | "failed" | "unknown") {
    return new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      now: h.now,
      stickerFile: () => null,
      authorize: () => true,
      port: {
        async send() {
          return status === "confirmed"
            ? { kind: "confirmed", messageId: "receipt" }
            : status === "unknown"
              ? { kind: "unknown", reason: "timeout" }
              : { kind: "failed", retcode: 500 };
        },
      },
    });
  }
  it.each(["confirmed", "failed", "unknown"] as const)(
    "does not repeat covered same-person input after a %s direct attempt",
    async (status) => {
      const h = setup({ complete: async () => generate(["20002"]) });
      previousSpeech(h);
      h.receive("1", "20002", false);
      h.clock.seconds++;
      h.receive("2", "20002", true);
      await h.activate("direct_reply");
      await transport(h, status).runOnce();
      const c = h.journal.ensureOneBot(bindingId)!;
      const idle = h.wakes.enqueue({
        conversationId: c.id,
        cause: "idle_topic",
        throughSeq: h.journal.sourceThroughSeq(c.id),
        dedupeKey: "unrelated-idle",
        readyAt: h.now(),
        at: h.now(),
        priority: 0,
      });
      expect(await h.activate("follow_up")).toMatchObject({
        status: "no_output",
        reason: status === "confirmed" ? "already_replied" : "already_attempted",
      });
      expect(
        h.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.main'").get(),
      ).toEqual({ n: 1 });
      expect(h.wakes.get(idle.id)?.status).toBe("pending");
      h.clock.seconds++;
      h.receive("3", "20002", false, "a genuinely new input");
      expect((await h.activate("follow_up")).status).toBe("completed");
      expect(h.outbox.list({})).toHaveLength(2);
    },
  );
  it("does not consume another participant merely because the first reply observed their input", async () => {
    let decisions = 0;
    const h = setup({ complete: async () => generate([++decisions === 1 ? "20003" : "20002"]) });
    previousSpeech(h);
    h.receive("1", "20002", false);
    h.clock.seconds++;
    h.receive("2", "20003", true);
    await h.activate("direct_reply");
    await transport(h, "confirmed").runOnce();
    expect((await h.activate("follow_up")).status).toBe("completed");
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20003", "20002"]);
  });
});

function pendingPlan(
  request: ModelRequest,
):
  | { outputs: { text?: string; targetId: string }[]; generationBudget: { remaining: number }[] }
  | undefined {
  for (const message of request.messages)
    for (const part of message.content) {
      if (part.kind !== "text") continue;
      try {
        const data = JSON.parse(part.text);
        if (data.kind === "pending_plan") return data.value;
      } catch {}
    }
}
describe("Agent-directed recovery", () => {
  it.each(["malformed", "model_error"])(
    "isolates one target's %s score and reports it to the Agent",
    async (failure) => {
      let scores = 0,
        decisions = 0;
      const h = setup({
        complete: async (request) => {
          if ((request.responseSchema?.properties as Record<string, unknown> | undefined)?.score) {
            scores++;
            if (scores === 1) {
              if (failure === "model_error") throw new Error("MODEL_FAILED");
              return "invalid";
            }
            return '{"score":9}';
          }
          if (++decisions === 1) return '{"kind":"invoke","name":"speech.evaluate","arguments":{}}';
          const text = JSON.stringify(request.messages);
          expect(text).toContain(
            failure === "model_error" ? "MODEL_FAILED" : "JUDGEMENT_UNREADABLE",
          );
          return generate(["20003"]);
        },
      });
      h.receive("1", "20002");
      h.receive("2", "20003");
      h.clock.seconds += 2;
      expect((await h.activate()).status).toBe("completed");
      expect(scores).toBe(2);
      expect(h.outbox.list({}).map((output) => output.target?.participantId)).toEqual(["20003"]);
    },
  );
  it.each(["keep", "revise", "defer"])(
    "Agent can %s a pending draft after new input even with zero regeneration budget",
    async (choice) => {
      let h: ReturnType<typeof setup>;
      let decisions = 0,
        generations = 0;
      h = setup(
        {
          complete: async (request) => {
            if (++decisions === 1) return generate(["20002"]);
            const plan = pendingPlan(request);
            expect(plan?.outputs[0]?.text).toBe("original draft");
            expect(plan?.generationBudget[0]?.remaining).toBe(0);
            expect(JSON.stringify(request.messages)).toContain("additional detail");
            return choice === "defer"
              ? '{"kind":"none"}'
              : JSON.stringify({
                  kind: "final",
                  outputs: [
                    {
                      kind: "inline",
                      targetId: "20002",
                      text: choice === "keep" ? plan!.outputs[0]!.text : "revised draft",
                      stickerIds: [],
                    },
                  ],
                });
          },
          async *streamText() {
            generations++;
            h.receive("2", "20002", true, "additional detail");
            yield "original draft";
          },
        },
        { recomputes: 0 },
      );
      h.receive("1", "20002", true);
      const result = await h.activate();
      expect(result.status).toBe(choice === "defer" ? "no_output" : "completed");
      expect(generations).toBe(1);
      expect(decisions).toBe(2);
      const intents = h.outbox.list({});
      expect(intents).toHaveLength(choice === "defer" ? 0 : 1);
      if (choice !== "defer")
        expect(JSON.parse(h.outbox.parts(intents[0]!.id)[0]!.payload!).text).toBe(
          choice === "keep" ? "original draft" : "revised draft",
        );
    },
  );
  it("cannot reuse a pending draft after its source leaves the raw window and is deleted", async () => {
    let h: ReturnType<typeof setup>,
      decisions = 0;
    h = setup(
      {
        complete: async (request) => {
          if (++decisions === 1) return generate(["20002"]);
          expect(pendingPlan(request)?.outputs[0]?.text).toBe("original secret");
          h.db.exec(
            "DELETE FROM qq_observation_text WHERE event_key IN (SELECT event_key FROM qq_events WHERE message_id='1')",
          );
          return JSON.stringify({
            kind: "final",
            outputs: [
              { kind: "inline", targetId: "20002", text: "original secret", stickerIds: [] },
            ],
          });
        },
        async *streamText() {
          h.clock.seconds++;
          h.receive("2", "20002", true, "new input");
          yield "original secret";
        },
      },
      { recomputes: 0 },
    );
    h.db.exec("UPDATE qq_schemes SET judgement_message_limit=1, reply_message_limit=1");
    h.receive("1", "20002", true, "sensitive old source");
    await expect(h.activate()).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(h.outbox.list({})).toHaveLength(0);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
  });
});

it.each(["revoked", "cancelled"])(
  "does not isolate %s authority as an ordinary target scoring failure",
  async (failure) => {
    const controller = new AbortController();
    let h: ReturnType<typeof setup>,
      scores = 0;
    h = setup({
      complete: async (request) => {
        if ((request.responseSchema?.properties as Record<string, unknown> | undefined)?.score) {
          scores++;
          if (failure === "cancelled") controller.abort();
          else h.db.exec("DELETE FROM qq_observation_text");
          throw new Error("MODEL_FAILED");
        }
        return '{"kind":"invoke","name":"speech.evaluate","arguments":{}}';
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    const result = h.host.activate(wake, controller.signal);
    if (failure === "revoked")
      await expect(result).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    else await expect(result).rejects.toBeDefined();
    expect(scores).toBe(1);
    expect(h.outbox.list({})).toHaveLength(0);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
  },
);

describe("durable participant windows across actual Host and delivery", () => {
  it("A at 0 is answered at 15; B at 14 remains pending and is answered at 29 after A's confirmed delivery", async () => {
    let decisions = 0;
    let h: ReturnType<typeof setup>;
    h = setup(
      {
        complete: async (req) => {
          if ((req.responseSchema?.properties as Record<string, unknown> | undefined)?.score)
            return '{"score":9}';
          return ++decisions % 2 === 1
            ? '{"kind":"invoke","name":"speech.evaluate","arguments":{}}'
            : generate([h.clock.seconds === time + 15 ? "20002" : "20003"]);
        },
      },
      { mergeSeconds: 15 },
    );
    h.receive("1", "20002");
    h.clock.seconds = time + 14;
    h.receive("2", "20003");
    h.clock.seconds = time + 15;
    expect((await h.activate("chiming_in")).status).toBe("completed");
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002"]);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 1 });
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      authorize: () => true,
      stickerFile: () => null,
      now: h.now,
      port: { send: async () => ({ kind: "confirmed", messageId: "receipt-a" }) },
    });
    await delivery.deliver(h.outbox.list({})[0]!.id);
    expect(h.outbox.list({})[0]!.status).toBe("confirmed");
    h.adapter.sweep();
    h.clock.seconds = time + 29;
    expect((await h.activate("chiming_in")).status).toBe("completed");
    expect(
      h.outbox
        .list({})
        .map((d) => d.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.main'").get(),
    ).toEqual({ n: 2 });
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 0 });
  });
  it("an unpaired legacy or room-wide initiative still preserves the unanswered gate", async () => {
    const h = setup({}, { mergeSeconds: 15 });
    h.receive("1", "20002");
    h.clock.seconds = time + 15;
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "chiming_in",
      parts: [{ kind: "text", result: "confirmed", messageId: "legacy", stickerId: null }],
      sentAtSeconds: time + 1,
      text: "room topic",
    });
    const result = await h.activate("chiming_in");
    expect(result.status).toBe("no_output");
    expect(result).toHaveProperty("reason", "awaiting_reply");
    expect(h.requests).toHaveLength(0);
  });
  it("Agent none resolves only its mature participants, preserving the later participant", async () => {
    const h = setup({}, { mergeSeconds: 15 });
    h.receive("1", "20002");
    h.clock.seconds = time + 14;
    h.receive("2", "20003");
    h.clock.seconds = time + 15;
    expect((await h.activate("chiming_in")).status).toBe("no_output");
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 1 });
    h.clock.seconds = time + 29;
    expect((await h.activate("chiming_in")).status).toBe("no_output");
    expect(h.requests).toHaveLength(2);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 0 });
  });
  it("split off keeps one logical room reply while resolving both explicitly mature opportunities", async () => {
    let decisions = 0;
    const h = setup(
      {
        complete: async (req) => {
          if ((req.responseSchema?.properties as Record<string, unknown> | undefined)?.score)
            return '{"score":9}';
          return ++decisions === 1
            ? '{"kind":"invoke","name":"speech.evaluate","arguments":{}}'
            : generate(["30003"]);
        },
      },
      { split: false, mergeSeconds: 15 },
    );
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 15;
    expect((await h.activate("chiming_in")).status).toBe("completed");
    expect(h.outbox.list({})).toHaveLength(1);
    expect(h.outbox.list({})[0]!.target).toEqual({ peerId: "30003", participantId: null });
    expect(h.outbox.parts(h.outbox.list({})[0]!.id)).toHaveLength(2);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='completed'").get(),
    ).toEqual({ n: 2 });
  });
  it("a failed leased recipient is retained as failed while another successful recipient completes", async () => {
    let decisions = 0;
    const h = setup({
      complete: async (req) => {
        if ((req.responseSchema?.properties as Record<string, unknown> | undefined)?.score)
          return '{"score":9}';
        return ++decisions === 1
          ? '{"kind":"invoke","name":"speech.evaluate","arguments":{}}'
          : generate(["20002", "20003"]);
      },
      async *streamText(req) {
        if (JSON.stringify(req.messages[0]).includes("20002")) throw new Error("MODEL_A_FAILED");
        yield "B reply";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const c = h.journal.ensureOneBot(bindingId)!;
    const a = h.wakes
      .readyParticipants({ conversationId: c.id, cause: "chiming_in", at: h.now() })
      .find((p) => p.participantId === "20002")!.wake;
    const lease = h.wakes.claim({ at: h.now(), leaseMs: 120000, wakeId: a.id })!;
    expect((await h.host.activate(lease, new AbortController().signal)).status).toBe("completed");
    expect(h.wakes.get(a.id)?.status).toBe("failed");
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20003"]);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='completed'").get(),
    ).toEqual({ n: 1 });
  });
});
