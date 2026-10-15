import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import { cloneBusinessDb } from "../harness/business-db";

const ACCOUNT_ID = "10001";
type Task = {
  id: string;
  status: string;
  error_code: string | null;
  source_through_seq: number;
  execution_snapshot: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
};
const tasks = (db: BusinessDbHandle["db"]): Task[] =>
  db
    .query(
      "SELECT id,status,error_code,source_through_seq,execution_snapshot,lease_token,lease_expires_at FROM qq_conversation_tasks ORDER BY rowid",
    )
    .all() as Task[];
const authorizedTarget = (request: ModelRequest): string =>
  JSON.stringify(request.messages)
    .replace(/\\/g, "")
    .match(/authorizedTargets":\["(\d+)/)?.[1] ?? "20002";

const composed: ReturnType<typeof createOneBotConversationRuntime>[] = [];
const handles: BusinessDbHandle[] = [];
const pendingGates: (() => void)[] = [];
afterEach(async () => {
  for (const release of pendingGates.splice(0)) release();
  for (const bot of composed.splice(0)) {
    bot.scheduler.stop();
    await bot.scheduler.waitForIdle().catch(() => {});
    bot.delivery.stop();
    await bot.delivery.waitForIdle().catch(() => {});
    bot.release();
  }
  for (const handle of handles.splice(0)) handle.close();
});

function setup(model: ModelPort, autonomous = false) {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT_ID, enabled: true, expectedRevision: 1 });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const journal = new ConversationEventRepository(h.db);
  const wakes = new WakeRepository(h.db);
  const outbox = new OutboundIntentRepository(h.db);
  const runs = new AgentRunRepository(h.db);
  const adapter = new OneBot11Adapter({
    orm: h.orm,
    journal,
    wakes,
    nowSeconds: () => nowSeconds,
  });
  const scheme = createQqScheme(h.orm, {
    name: "ordinary-config-snapshot",
    description: "description before claim",
    triggers: { direct_reply: true, follow_up: false, chiming_in: autonomous, idle_topic: false },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      initiative_batch_target_count: 1,
      initiative_batch_jitter_count: 0,
      initiative_time_window_enabled: false,
      merge_window_seconds: 0,
      reply_cooldown_seconds: 1,
      judgement_interval_turns: 1,
    },
    reply: { split_by_speaker: true },
  });
  const bindingId = crypto.randomUUID();
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group','30003',?,?,?,?)",
    )
    .run(
      bindingId,
      DEFAULT_AGENT_ID,
      scheme.id,
      new Date(nowSeconds * 1000).toISOString(),
      new Date(nowSeconds * 1000).toISOString(),
    );
  const receive = (messageId: string, text: string) => {
    const normalized = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        time: nowSeconds,
        self_id: 10001,
        user_id: 20002,
        group_id: 30003,
        message_id: messageId,
        message: [
          ...(!autonomous ? [{ type: "at", data: { qq: "10001" } }] : []),
          { type: "text", data: { text } },
        ],
        sender: { nickname: "20002" },
      },
      ACCOUNT_ID,
    );
    expect(normalized.kind).toBe("message");
    return recordInbound(h.orm, normalized, {
      accountId: ACCOUNT_ID,
      conversationIngress: adapter,
    });
  };
  const sends: unknown[] = [];
  const runtime = new AgentRuntime({
    repository: runs,
    now: () => new Date().toISOString(),
    model,
  });
  const gateway = {
    complete: async () => {
      throw new Error("UNIFIED_RUNTIME_REQUIRED");
    },
    loadedContextCapacity: async () => 65536,
  };
  const bot = createOneBotConversationRuntime({
    orm: h.orm,
    db: h.db,
    gateway,
    agentRuntime: runtime,
    host: new ConversationHost({ runtime }),
    journal,
    store: new QqStickerStore({ directory: "synthetic-qq-stickers" }),
    port: {
      async send(request) {
        sends.push(request);
        return { kind: "confirmed", messageId: String(100000 + sends.length) };
      },
    },
    wake: () => {},
    policy: () => ({
      maxSteps: 20,
      deliveryTtlSeconds: 600,
      retryDelayMs: 1000,
      maxAttempts: 3,
      globalConcurrency: 4,
      modelCallConcurrency: 1,
    }),
  });
  composed.push(bot);
  return { h, scheme, receive, bot, outbox, sends };
}

function textContribution(target: string) {
  return JSON.stringify({
    kind: "invoke",
    calls: [
      {
        name: "reply.text",
        arguments: {
          outputs: [{ kind: "inline", targetId: target, text: "corrected synthetic reply" }],
        },
      },
    ],
  });
}

describe("QQ invalid decision feedback", () => {
  it("corrects an empty first decision through the shared bounded runtime loop", async () => {
    let calls = 0;
    const model: ModelPort = {
      complete: async (request) => {
        calls += 1;
        return calls === 1 ? "" : textContribution(authorizedTarget(request));
      },
      async *streamText() {
        yield "";
      },
      completeMultimodal: async () => "",
    };
    const f = setup(model);
    expect(f.receive("95201", "empty decision then correction").kind).toBe("recorded");
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await f.bot.scheduler.waitForIdle();
    await f.bot.delivery.waitForIdle();

    expect(calls).toBe(2);
    expect(tasks(f.h.db)[0]).toMatchObject({ status: "completed", error_code: null });
    expect(f.h.db.query("SELECT status FROM outbound_intents").all()).toEqual([
      { status: "confirmed" },
    ]);
    expect(f.h.db.query("SELECT kind,payload FROM outbound_parts").all()).toEqual([
      {
        kind: "text",
        payload: expect.stringContaining("corrected synthetic reply"),
      },
    ]);
    expect(f.sends).toHaveLength(1);
  });
  it("uses the same correction path for autonomous replies after scoring", async () => {
    let decisions = 0;
    const model: ModelPort = {
      complete: async (request) => {
        const schema = request.responseSchema as { properties?: Record<string, unknown> };
        if (schema.properties?.evaluations) {
          let targets: { targetId: string }[] = [];
          for (const message of request.messages)
            for (const part of message.content) {
              if (part.kind !== "text") continue;
              try {
                const value = JSON.parse(part.text) as {
                  kind?: string;
                  targets?: { targetId: string }[];
                };
                if (value.kind === "qq_batch_targets") targets = value.targets ?? [];
              } catch {}
            }
          return JSON.stringify({
            evaluations: targets.map((target) => ({
              targetId: target.targetId,
              score: 10,
              intent: "synthetic participation",
              sourceSeqs: [],
            })),
          });
        }
        decisions += 1;
        return decisions === 1 ? "" : textContribution(authorizedTarget(request));
      },
      async *streamText() {
        yield "";
      },
      completeMultimodal: async () => "",
    };
    const f = setup(model, true);
    expect(f.receive("95202", "autonomous empty decision then correction").kind).toBe("recorded");
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await f.bot.scheduler.waitForIdle();
    await f.bot.delivery.waitForIdle();
    expect(decisions).toBe(2);
    expect(tasks(f.h.db)[0]).toMatchObject({ status: "completed", error_code: null });
    expect(f.h.db.query("SELECT speech_kind,status FROM outbound_intents").all()).toEqual([
      { speech_kind: "chiming_in", status: "confirmed" },
    ]);
    expect(f.sends).toHaveLength(1);
  });
  it("ends repeated empty decisions at the existing budget without sending", async () => {
    let calls = 0;
    const model: ModelPort = {
      complete: async () => {
        calls += 1;
        return "";
      },
      async *streamText() {
        yield "";
      },
      completeMultimodal: async () => "",
    };
    const f = setup(model);
    expect(f.receive("95203", "repeated empty decisions").kind).toBe("recorded");
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await f.bot.scheduler.waitForIdle();
    expect(calls).toBe(20);
    expect(tasks(f.h.db)[0]).toMatchObject({ status: "failed", error_code: "QQ_TASK_FAILED" });
    expect(f.h.db.query("SELECT id FROM outbound_intents").all()).toEqual([]);
    expect(f.sends).toHaveLength(0);
  });
});
