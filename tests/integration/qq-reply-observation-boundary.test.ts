import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
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
const finalReply = (target: string, text: string) =>
  JSON.stringify({ kind: "final", outputs: [{ kind: "inline", targetId: target, text }] });

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

function setup(model: ModelPort) {
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
    triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: false },
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
  const receive = (messageId: string, text: string, addressed = true) => {
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
          ...(addressed ? [{ type: "at", data: { qq: "10001" } }] : []),
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

describe("QQ shared reply observation boundary", () => {
  it("keeps the @ source as intent identity but stamps the ordinary input observed during generation", async () => {
    let started!: () => void;
    const generationStarted = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
      pendingGates.push(release);
    });
    let decisions = 0;
    const model: ModelPort = {
      complete: async (request) => {
        decisions += 1;
        if (decisions > 1) return finalReply(authorizedTarget(request), "fresh after observation");
        return JSON.stringify({
          kind: "final",
          outputs: [
            {
              kind: "generate",
              targetId: authorizedTarget(request),
              instructions: "respond",
              stickerIds: [],
            },
          ],
        });
      },
      async *streamText() {
        started();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            gate,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("GENERATION_GATE_TIMEOUT")), 4000);
            }),
          ]);
          yield "fresh after observation";
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
      completeMultimodal: async () => "",
    };
    const f = setup(model);
    const first = f.receive("95101", "initial addressed request");
    expect(first.kind).toBe("recorded");
    const task = tasks(f.h.db)[0]!;
    const inputSeq = task.source_through_seq;
    expect(task.status).toBe("pending");

    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await generationStarted;
    const later = f.receive("95102", "same speaker ordinary input", false);
    expect(later.kind).toBe("recorded");
    const newSeq = (
      f.h.db
        .query(
          "SELECT MAX(seq) AS seq FROM conversation_events WHERE kind='inbound' AND source_kind='qq_event'",
        )
        .get() as { seq: number }
    ).seq;
    expect(newSeq).toBeGreaterThan(inputSeq);
    release();
    await f.bot.scheduler.waitForIdle();
    await f.bot.delivery.waitForIdle();

    const intent = f.h.db
      .query("SELECT source_through_seq,target,status FROM outbound_intents")
      .get() as {
      source_through_seq: number;
      target: string;
      status: string;
    } | null;
    expect(intent).not.toBeNull();
    expect(intent!.source_through_seq).toBe(inputSeq);
    expect(JSON.parse(intent!.target)).toMatchObject({ observedThroughSeq: newSeq });
    expect(intent!.status).toBe("confirmed");
    expect(decisions).toBe(2);
    expect(f.sends).toHaveLength(1);
    const run = f.h.db
      .query(
        "SELECT observed_seq FROM agent_runs WHERE spec_id='onebot.main' ORDER BY started_at DESC,rowid DESC LIMIT 1",
      )
      .get() as { observed_seq: number | null } | null;
    expect(run?.observed_seq).toBeGreaterThanOrEqual(newSeq);
    expect(tasks(f.h.db)[0]).toMatchObject({ status: "completed", source_through_seq: inputSeq });
  });
  it("still rejects an input arriving after the stored observation boundary and keeps legacy checks", async () => {
    const model: ModelPort = {
      complete: async () => JSON.stringify({ kind: "none" }),
      async *streamText() {
        yield "";
      },
      completeMultimodal: async () => "",
    };
    const f = setup(model);
    expect(f.receive("95111", "initial direct source").kind).toBe("recorded");
    const journal = new ConversationEventRepository(f.h.db);
    const conversation = f.h.db
      .query("SELECT id,source_id,binding_epoch FROM conversations WHERE channel='onebot11'")
      .get() as { id: string; source_id: string; binding_epoch: number };
    const sourceSeq = tasks(f.h.db)[0]!.source_through_seq;
    expect(f.receive("95112", "already observed ordinary input", false).kind).toBe("recorded");
    const observedSeq = journal.sourceThroughSeq(conversation.id);
    expect(observedSeq).toBeGreaterThan(sourceSeq);
    const runId = crypto.randomUUID();
    new AgentRunRepository(f.h.db).createRun({
      runId,
      specId: "freshness-guard",
      specVersion: "1",
      owner: { kind: "conversation", id: conversation.id, agentId: DEFAULT_AGENT_ID },
      at: new Date().toISOString(),
    });
    const target = {
      accountId: ACCOUNT_ID,
      conversationKind: "group" as const,
      peerId: "30003",
      participantId: "20002",
      agentId: DEFAULT_AGENT_ID,
      bindingId: conversation.source_id,
      bindingEpoch: conversation.binding_epoch,
    };
    const commit = (id: string, observedThroughSeq?: number) =>
      f.outbox.commit({
        id,
        runId,
        conversationId: conversation.id,
        ordinal: 0,
        target: { ...target, ...(observedThroughSeq === undefined ? {} : { observedThroughSeq }) },
        speechKind: "direct_reply",
        sourceThroughSeq: sourceSeq,
        deliverBy: "2099-01-01T00:00:00Z",
        expiresAt: "2099-01-01T00:00:00Z",
        createdAt: new Date().toISOString(),
        parts: [{ kind: "text", text: "must stay unsent" }],
      });
    const legacy = commit(crypto.randomUUID());
    let sent = 0;
    const delivery = new OutboundDelivery({
      orm: f.h.orm,
      repository: f.outbox,
      journal,
      stickerFile: () => null,
      authorize: () => true,
      port: {
        async send() {
          sent += 1;
          return { kind: "confirmed", messageId: "95113" };
        },
      },
    });
    await delivery.deliver(legacy.id);
    expect(f.outbox.get(legacy.id)).toMatchObject({
      status: "stale",
      staleReason: "CONVERSATION_CHANGED",
    });
    const current = commit(crypto.randomUUID(), observedSeq);
    expect(f.receive("95114", "new input after observation", false).kind).toBe("recorded");
    await delivery.deliver(current.id);
    expect(f.outbox.get(current.id)).toMatchObject({
      status: "stale",
      staleReason: "CONVERSATION_CHANGED",
    });
    expect(sent).toBe(0);
    expect(f.outbox.parts(current.id)[0]).toMatchObject({ status: "stale", attempted_at: null });
  });
});
