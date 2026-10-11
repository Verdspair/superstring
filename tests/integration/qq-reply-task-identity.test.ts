// Synthetic production-composition coverage for valid reply-to-assistant task identity.
// One preliminary launcher probe failed before Bun execution (command not found); its evidence is
// retained alongside this scoped native run and is not a product RED.
// The assistant message is created by the runtime and persisted only after the fake transport
// returns a confirmed receipt; reply inputs then reference that returned platform message ID.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import { cloneBusinessDb } from "../harness/business-db";
import { scriptedModel } from "../harness/model";

const ACCOUNT_ID = "10001";
type TaskRow = {
  task_class: string;
  status: string;
  platform_message_id: string | null;
  source_through_seq: number;
};
const taskRows = (db: Database): TaskRow[] =>
  db
    .query(`SELECT task_class,status,platform_message_id,source_through_seq
    FROM qq_conversation_tasks ORDER BY rowid`)
    .all() as TaskRow[];
const isDecisionRequest = (request: ModelRequest): boolean => {
  const schema = request.responseSchema as { oneOf?: unknown } | undefined;
  return Array.isArray(schema?.oneOf);
};
const authorizedTargetOf = (request: ModelRequest): string =>
  JSON.stringify(request.messages)
    .replace(/\\/g, "")
    .match(/authorizedTargets":\["(\d+)/)?.[1] ?? "20002";
const inlineFinal = (targetId: string, text: string) =>
  JSON.stringify({ kind: "final", outputs: [{ kind: "inline", targetId, text }] });

const handles: BusinessDbHandle[] = [];
const runtimes: ReturnType<typeof createOneBotConversationRuntime>[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.scheduler.stop();
    await runtime.scheduler.waitForIdle().catch(() => {});
    runtime.delivery.stop();
    await runtime.delivery.waitForIdle().catch(() => {});
    runtime.release();
  }
  for (const handle of handles.splice(0)) handle.close();
});

function setup() {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT_ID, enabled: true, expectedRevision: 1 });
  const clock = { seconds: Math.floor(Date.now() / 1000) };
  const journal = new ConversationEventRepository(h.db);
  const wakes = new WakeRepository(h.db);
  const runs = new AgentRunRepository(h.db);
  const adapter = new OneBot11Adapter({
    orm: h.orm,
    journal,
    wakes,
    nowSeconds: () => clock.seconds,
  });
  const scheme = createQqScheme(h.orm, {
    name: `reply-task-identity-${crypto.randomUUID()}`,
    triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: false },
    reply: { split_by_speaker: true },
    taskLimits: { mention_task_limit: 2, ordinary_task_limit: 1 },
  });
  const bindingId = crypto.randomUUID();
  h.db
    .query(`INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at)
    VALUES(?,'10001','group','30003',?,?,?,?)`)
    .run(
      bindingId,
      DEFAULT_AGENT_ID,
      scheme.id,
      new Date(clock.seconds * 1000).toISOString(),
      new Date(clock.seconds * 1000).toISOString(),
    );
  const receive = (messageId: string, speakerId: number, segments: unknown[]) => {
    const normalized = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        time: clock.seconds,
        self_id: 10001,
        user_id: speakerId,
        group_id: 30003,
        message_id: messageId,
        message: segments,
        sender: { nickname: String(speakerId) },
      },
      ACCOUNT_ID,
    );
    expect(normalized.kind).toBe("message");
    return recordInbound(h.orm, normalized, {
      accountId: ACCOUNT_ID,
      conversationIngress: adapter,
    });
  };
  const sends: { peerId: string; request: unknown }[] = [];
  const sentPlatformIds: string[] = [];
  const runtimeModel: ModelPort = {
    complete: async (request) => {
      if (!isDecisionRequest(request)) return scriptedModel([]).port.complete(request);
      return inlineFinal(authorizedTargetOf(request), "confirmed assistant response");
    },
    streamText: async function* () {},
    completeMultimodal: async () => "",
  };
  const agentRuntime = new AgentRuntime({
    repository: runs,
    now: () => new Date().toISOString(),
    model: runtimeModel,
  });
  const runtime = createOneBotConversationRuntime({
    orm: h.orm,
    db: h.db,
    gateway: {
      complete: async () => {
        throw new Error("UNIFIED_RUNTIME_REQUIRED");
      },
      loadedContextCapacity: async () => 65536,
    },
    agentRuntime,
    host: new ConversationHost({ runtime: agentRuntime }),
    journal,
    store: new QqStickerStore({ directory: "synthetic-qq-stickers" }),
    port: {
      async send(request) {
        const messageId = String(100000 + sentPlatformIds.length + 1);
        sends.push({ peerId: request.peerId, request });
        sentPlatformIds.push(messageId);
        return { kind: "confirmed", messageId };
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
  runtimes.push(runtime);
  return { h, receive, runtime, sends, sentPlatformIds };
}

describe("QQ reply-to-assistant task identity", () => {
  it("registers two valid reply-only inputs immediately as independent mention tasks and dedupes replay", async () => {
    const f = setup();
    f.receive("-9701", 20002, [
      { type: "at", data: { qq: ACCOUNT_ID } },
      { type: "text", data: { text: "seed a confirmed assistant message" } },
    ]);
    expect(await f.runtime.scheduler.dispatchOnce()).toBe(true);
    await f.runtime.scheduler.waitForIdle();
    expect(f.sentPlatformIds).toHaveLength(1);
    const confirmedAssistantMessageId = f.sentPlatformIds[0]!;
    expect(
      f.h.db.query("SELECT status FROM outbound_intents ORDER BY created_at LIMIT 1").get(),
    ).toEqual({ status: "confirmed" });

    f.receive("-9702", 20002, [
      { type: "reply", data: { id: confirmedAssistantMessageId } },
      { type: "text", data: { text: "first reply-only request" } },
    ]);
    f.receive("-9703", 20002, [
      { type: "reply", data: { id: confirmedAssistantMessageId } },
      { type: "text", data: { text: "second reply-only request" } },
    ]);

    const replyTasks = taskRows(f.h.db).filter((row) =>
      ["-9702", "-9703"].includes(row.platform_message_id ?? ""),
    );
    expect(replyTasks.map((row) => [row.platform_message_id, row.task_class, row.status])).toEqual([
      ["-9702", "mention", "pending"],
      ["-9703", "mention", "pending"],
    ]);
    expect(
      taskRows(f.h.db).filter(
        (row) =>
          ["-9702", "-9703"].includes(row.platform_message_id ?? "") &&
          row.task_class === "ordinary",
      ),
    ).toHaveLength(0);

    f.receive("-9702", 20002, [
      { type: "reply", data: { id: confirmedAssistantMessageId } },
      { type: "text", data: { text: "first reply-only request" } },
    ]);
    expect(
      taskRows(f.h.db).filter((row) => ["-9702", "-9703"].includes(row.platform_message_id ?? "")),
    ).toHaveLength(2);
    expect(f.sends).toHaveLength(1);
  });

  it("does not treat a reply to an unconfirmed or unknown platform message as a mention task", () => {
    const f = setup();
    f.receive("-9710", 20002, [
      { type: "reply", data: { id: "999999" } },
      { type: "text", data: { text: "reply to unknown target" } },
    ]);
    expect(taskRows(f.h.db)).toEqual([]);
    expect(f.h.db.query("SELECT COUNT(*) AS n FROM wake_signals").get()).toEqual({ n: 0 });
  });
});
