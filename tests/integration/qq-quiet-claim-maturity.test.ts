import { expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import { cloneBusinessDb } from "../harness/business-db";

it("does not claim a quiet-preferred batch after new input postpones its pause", async () => {
  const h = cloneBusinessDb();
  ensureDefaults(h.orm, "quiet-probe");
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "claim-probe",
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      participation_timing: "quiet_preferred",
      initiative_batch_target_count: 15,
      initiative_batch_jitter_count: 5,
      initiative_time_target_seconds: 40,
      initiative_time_jitter_seconds: 20,
      merge_window_seconds: 15,
    },
  });
  const id = crypto.randomUUID(),
    now = () => new Date().toISOString(),
    seconds = Math.floor(Date.now() / 1000);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group','30003',?,?,?,?)",
    )
    .run(id, DEFAULT_AGENT_ID, scheme.id, now(), now());
  const journal = new ConversationEventRepository(h.db);
  let scores = 0;
  const model = {
    async complete(r: any) {
      if (r.responseSchema?.properties?.evaluations) {
        scores++;
        let batch: any;
        for (const m of r.messages)
          for (const p of m.content)
            if (p.kind === "text") {
              try {
                const x = JSON.parse(p.text);
                if (x.kind === "qq_batch_targets") batch = x;
              } catch {}
            }
        return JSON.stringify({
          evaluations: batch.targets.map((t: any) => ({
            targetId: t.targetId,
            score: 0,
            intent: "none",
            sourceSeqs: [],
          })),
        });
      }
      return '{"kind":"none"}';
    },
    async *streamText() {
      yield "";
    },
    async completeMultimodal() {
      return "";
    },
  };
  const rt = new AgentRuntime({ repository: new AgentRunRepository(h.db), model, now });
  const bot = createOneBotConversationRuntime({
    orm: h.orm,
    db: h.db,
    gateway: {
      async complete() {
        throw Error("NO_GATEWAY_CALL");
      },
      async loadedContextCapacity() {
        return 65536;
      },
    },
    agentRuntime: rt,
    host: new ConversationHost({ runtime: rt }),
    journal,
    store: new QqStickerStore({ directory: "synthetic-quiet-claim" }),
    port: {
      async send() {
        throw Error("NO_SEND");
      },
    },
    wake: () => {},
    policy: () => ({
      maxSteps: 20,
      deliveryTtlSeconds: 600,
      retryDelayMs: 1000,
      maxAttempts: 3,
      globalConcurrency: 4,
    }),
  });
  function receive(mid: string, t: number) {
    return recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: t,
          self_id: 10001,
          user_id: 20002,
          group_id: 30003,
          message_id: mid,
          message: [{ type: "text", data: { text: "ordinary" } }],
          sender: { nickname: "synthetic" },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: bot.adapter },
    );
  }
  receive("1", seconds - 25);
  bot.adapter.sweep(seconds);
  receive("2", seconds);
  const cid = journal.ensureOneBot(id)!.id;
  const facts = bot.adapter.chimingActivationFacts(cid, seconds);
  expect(facts).toBeNull();
  expect(await bot.scheduler.runOnce()).toBe(false);
  expect(scores).toBe(0);
  expect(h.db.query("SELECT id FROM qq_conversation_tasks").all()).toEqual([]);
  expect(h.db.query("SELECT status,attempts FROM wake_signals").all()).toEqual([
    { status: "pending", attempts: 0 },
  ]);
  bot.scheduler.stop();
  await bot.scheduler.waitForIdle();
  bot.delivery.stop();
  await bot.delivery.waitForIdle();
  bot.release();
  h.close();
});
