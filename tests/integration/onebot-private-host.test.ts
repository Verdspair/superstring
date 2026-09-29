import { afterEach, describe, expect, it } from "bun:test";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { inspectContext, sourceAccess } from "../../src/server/agent/context-access";
import { inputUnits } from "../../src/server/agent/context-engine";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { AgentTaskService } from "../../src/server/agent/task-service";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import type { BotCompressionJob } from "../../src/server/channels/onebot11/background-compression";
import { OneBotHost } from "../../src/server/channels/onebot11/bot-host";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { WakeScheduler } from "../../src/server/conversation/wake-scheduler";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { createQqScheme, updateQqScheme } from "../../src/server/db/qq-scheme-repository";
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  createQqStickerCollection,
  editQqSticker,
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
import { ModelUnavailableError } from "../../src/server/errors";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { createSqliteQueryFactory } from "../../src/server/modules/composition";
import { PermissionService } from "../../src/server/permissions/service";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import {
  nextQqImmediateReplyTask,
  peekQqImmediateReplyTask,
} from "../../src/server/services/qq-dispatch";
import { recordInbound } from "../../src/server/services/qq-intake";
import { qqStickerSelectionForScheme } from "../../src/server/services/qq-sticker-candidates";
import { qqStickerUsable } from "../../src/server/services/qq-sticker-contract";
import type { PermissionPolicy } from "../../src/shared/contracts/permissions";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const bindingId = "11111111-1111-4111-8111-111111111111",
  nowSeconds = 2_000_000_000;
function setup(
  model?: Partial<ModelPort>,
  options: {
    stickersAvailable?: boolean;
    onDiagnostic?: ConstructorParameters<typeof OneBotHost>[0]["onDiagnostic"];
    enqueueCompression?: ConstructorParameters<typeof OneBotHost>[0]["enqueueCompression"];
    externalActions?: ConstructorParameters<typeof OneBotHost>[0]["externalActions"];
    actionExecutor?: ActionExecutor;
    modules?: ConstructorParameters<typeof OneBotHost>[0]["modules"];
  } = {},
) {
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
    actionExecutor: options.actionExecutor,
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
  const host = new OneBotHost({
    orm: h.orm,
    journal,
    wakes,
    outbox,
    gateway,
    agentRuntime: runtime,
    modules: options.modules,
    stickers: { counts: ["confirmed"], isAvailable: () => options.stickersAvailable ?? false },
    onDiagnostic: options.onDiagnostic,
    enqueueCompression: options.enqueueCompression,
    externalActions: options.externalActions,
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
  it("releases the conversation wake while an external write waits for local approval", async () => {
    let performed = 0;
    let calls = 0;
    const action: BuiltInAction = {
      permission: { resource: "fixture.write", revision: "v1", approvalRequired: true },
      description: {
        name: "fixture.write",
        capability: "fixture",
        effect: "write",
        parameters: {},
        description: "write",
      },
      async execute() {
        performed += 1;
        return { value: { status: "ok" }, sources: [] };
      },
    };
    const permissions = new PermissionService({
      read: () => ({
        revision: "test",
        policy: {
          version: 1,
          grants: [{ resource: "fixture.write", revision: "v1", approved: false, directories: [] }],
        },
      }),
      replace() {
        throw new Error("not used");
      },
    });
    const executor = new ActionExecutor(permissions);
    const h = setup(
      {
        async complete() {
          return ++calls === 1
            ? JSON.stringify({ kind: "invoke", calls: [{ name: "fixture.write", arguments: {} }] })
            : '{"kind":"none"}';
        },
      },
      { actionExecutor: executor },
    );
    h.receive("123");
    const conversation = h.journal.ensureOneBot(bindingId);
    if (!conversation) throw new Error("missing conversation");
    const tasks = new AgentTaskService({
      repository: new AgentTaskRepository(h.db),
      orm: h.orm,
      executor,
      actions: () => [action],
      now: () => new Date(nowSeconds * 1000).toISOString(),
      resolveSource: (source, owner) => permissions.sourceAccess(source, owner),
    });
    const host = new OneBotHost({
      orm: h.orm,
      journal: h.journal,
      wakes: h.wakes,
      outbox: h.outbox,
      gateway: h.gateway,
      agentRuntime: h.runtime,
      tasks,
      resolveSource: (source, owner) => permissions.sourceAccess(source, owner),
      stickers: { counts: ["confirmed"], isAvailable: () => false },
      policy: () => ({ maxSteps: 12, deliveryTtlSeconds: 600, retentionDays: 14 }),
      now: () => new Date(nowSeconds * 1000).toISOString(),
    });
    const scheduler = new WakeScheduler({
      repository: h.wakes,
      policy: () => ({ leaseMs: 120000, renewMs: 30000, maxAttempts: 3, retryDelayMs: 1000 }),
      activate: (wake, signal) => host.activate(wake, signal),
      now: () => new Date(nowSeconds * 1000).toISOString(),
      onError: (error) => {
        throw error;
      },
    });
    await scheduler.runOnce();
    await tasks.runOnce();
    expect(tasks.list({ conversationId: conversation.id, limit: 50 }).items[0]?.status).toBe(
      "waiting_approval",
    );
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='leased'").get(),
    ).toEqual({ n: 0 });
    expect(performed).toBe(0);
    expect(h.outbox.list({ conversationId: conversation.id })).toEqual([]);
  });

  it("atomically journals intake and wake, runs decide/generate, commits intent before any send and preserves multipart", async () => {
    const h = setup();
    expect(h.receive("1")).toMatchObject({ kind: "recorded", recorded: true });
    h.receive("1");
    const conversation = h.journal.ensureOneBot(bindingId)!;
    expect(
      h.journal.eventsAfter(conversation.id).items.filter((e) => e.kind === "inbound"),
    ).toHaveLength(1);
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
    expect(h.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.main'").get()).toEqual({
      status: "completed",
    });
  });
  it("applies centralized revocation before a QQ tool call", async () => {
    let policy: PermissionPolicy = {
      version: 1,
      grants: [{ resource: "mcp.demo.read", approved: false, directories: [] }],
    };
    const permissions = new PermissionService({
      read: () => ({ revision: "1", policy }),
      replace() {
        throw new Error("unused");
      },
    });
    let executed = false;
    const h = setup(
      {
        complete: async (request) => {
          expect(request.tools?.some((tool) => tool.name === "mcp.demo.read")).toBe(true);
          policy = { version: 1, grants: [] };
          return JSON.stringify({
            kind: "invoke",
            calls: [{ name: "mcp.demo.read", arguments: {} }],
          });
        },
      },
      {
        actionExecutor: new ActionExecutor(permissions),
        externalActions: () => [
          {
            permission: { resource: "mcp.demo.read", revision: "v1", approvalRequired: false },
            description: {
              name: "mcp.demo.read",
              description: "read",
              parameters: {},
              capability: "mcp.demo",
              effect: "read",
            },
            async execute() {
              executed = true;
              return { value: "private", sources: [] };
            },
          },
        ],
      },
    );
    h.receive("1");
    await expect(activate(h)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(executed).toBe(false);
    expect(h.outbox.list({})).toHaveLength(0);
  });

  it("advertises and executes a registered external tool inside the wake", async () => {
    const executed: Record<string, unknown>[] = [];
    const seen: string[][] = [];
    let decisions = 0;
    const h = setup(
      {
        complete: async (request) => {
          seen.push((request.tools ?? []).map((tool) => tool.name));
          decisions += 1;
          if (decisions === 1)
            return JSON.stringify({
              kind: "invoke",
              name: "mcp.demo.echo",
              arguments: { text: "hi" },
            });
          // 第二次决策要能看到上一次调用留下的观测。
          expect(JSON.stringify(request.messages)).toContain("pong");
          return '{"kind":"none"}';
        },
      },
      {
        externalActions: () => [
          {
            description: {
              name: "mcp.demo.echo",
              description: "demo echo（外部服务）",
              parameters: { type: "object", properties: {} },
              capability: "mcp.demo",
              effect: "read",
            },
            async execute(arguments_) {
              executed.push(arguments_);
              return { value: { status: "ok", text: "pong" }, sources: [] };
            },
          },
        ],
      },
    );
    h.receive("1");
    await activate(h);
    // 外部工具进了广告面，并且真的被调用了一次。
    expect(seen[0]).toContain("mcp.demo.echo");
    expect(executed).toEqual([{ text: "hi" }]);
  });

  it("queues compression after committing the reply and releases it from the wake lease", async () => {
    let job: BotCompressionJob | undefined;
    let compressions = 0;
    const h = setup(
      {
        complete: async (request) => {
          if (request.responseSchema?.$defs) {
            compressions++;
            const part = request.messages[1].content.find((entry) => entry.kind === "text");
            const data = JSON.parse(part?.kind === "text" ? part.text : "{}");
            return JSON.stringify({
              facts: data.events.map((entry: { id: string; speaker: string }) => ({
                kind: "fact",
                speaker: entry.speaker,
                text: "old fact",
                source_ids: [entry.id],
              })),
            });
          }
          return '{"kind":"final","outputs":[{"kind":"inline","targetId":"20002","text":"answer","stickerIds":[]}]}';
        },
      },
      {
        enqueueCompression: (value) => {
          job = value;
        },
      },
    );
    h.db.query("UPDATE qq_schemes SET summary_watermark_trigger=1 WHERE id=?").run(h.scheme.id);
    h.clock.seconds -= 30000;
    h.receive("1", "old question");
    h.clock.seconds += 30000;
    h.receive("2", "new question");
    h.clock.seconds += 3;
    await activate(h);
    expect(compressions).toBe(0);
    expect(h.outbox.list({})).toHaveLength(1);
    if (!job) throw new Error("missing background job");
    await job.run(new AbortController().signal);
    expect(compressions).toBe(1);
    expect(h.db.query("SELECT through_seq FROM qq_conversation_summaries").get()).toEqual({
      through_seq: 1,
    });
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
  it.each(["confirmed", "unknown"] as const)(
    "stop settles an in-flight %s receipt and preserves unstarted outputs",
    async (status) => {
      const h = await prepared();
      const row = h.outbox.row(h.id)!;
      const second = h.outbox.commit({
        runId: row.run_id,
        conversationId: row.conversation_id,
        ordinal: 1,
        target: JSON.parse(row.target),
        speechKind: row.speech_kind,
        sourceThroughSeq: row.source_through_seq,
        deliverBy: row.deliver_by,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        parts: [{ kind: "text", text: "another recipient" }],
      });
      let settle!: (
        value: { kind: "confirmed"; messageId: string } | { kind: "unknown"; reason: "timeout" },
      ) => void;
      let began!: () => void;
      const sending = new Promise<void>((resolve) => {
        began = resolve;
      });
      let calls = 0;
      const common = {
        orm: h.orm,
        repository: h.outbox,
        journal: h.journal,
        stickerFile: () => null,
        authorize: () => true,
        now: () => stamp(),
      };
      const delivery = new OutboundDelivery({
        ...common,
        port: {
          async send() {
            calls++;
            began();
            return await new Promise((resolve) => {
              settle = resolve;
            });
          },
        },
      });
      const running = delivery.runOnce();
      await sending;
      delivery.stop();
      settle(
        status === "confirmed"
          ? { kind: "confirmed", messageId: "first" }
          : { kind: "unknown", reason: "timeout" },
      );
      await running;
      expect(calls).toBe(1);
      expect(h.outbox.get(h.id)!.parts.map((part) => part.status)).toEqual(
        status === "confirmed" ? ["confirmed", "planned"] : ["unknown", "not_sent"],
      );
      expect(h.outbox.get(second.id)?.status).toBe("planned");
      expect(await delivery.runOnce()).toBe(0);
      await delivery.deliver(second.id);
      expect(calls).toBe(1);
      const resumed = new OutboundDelivery({
        ...common,
        port: {
          async send() {
            calls++;
            return { kind: "confirmed", messageId: `next-${calls}` };
          },
        },
      });
      resumed.recover();
      await resumed.runOnce();
      expect(h.outbox.get(second.id)?.status).toBe("confirmed");
      expect(calls).toBe(status === "confirmed" ? 3 : 2);
      expect(h.outbox.get(h.id)?.status).toBe(status);
    },
  );
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
function modelData(request: ModelRequest, kind: string) {
  return request.messages
    .flatMap((message) => message.content)
    .flatMap((part) => {
      if (part.kind !== "text") return [];
      try {
        const data = JSON.parse(part.text);
        return data.kind === kind ? [data.value] : [];
      } catch {
        return [];
      }
    });
}
function stickerObservation(request: ModelRequest): {
  items: { id: string; name: string }[];
  nextCursor: string | null;
  status: string;
} {
  const matches = modelData(request, "action_observation").filter(
    (value) => value.name === "sticker.search",
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches.at(-1).value;
}
function actionObservation(request: ModelRequest, name: string) {
  const matches = modelData(request, "action_observation").filter((value) => value.name === name);
  expect(matches.length).toBeGreaterThan(0);
  return matches.at(-1) as {
    name: string;
    arguments?: Record<string, unknown>;
    value: {
      status: string;
      code?: string;
      items?: { id: string; title?: string; summary?: string; bodyRef?: string; text?: string }[];
      nextCursor?: string | null;
    };
  };
}
function pendingOutput(request: ModelRequest) {
  // pending_plan is itself a source-owned data envelope nested in a pending user message.
  const plans = modelData(request, "pending_plan");
  expect(plans).toHaveLength(1);
  return plans[0].outputs[0];
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
      conversationKey: JSON.stringify(["qq", "10001", "private", "20002"]),
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
    let decisions = 0;
    const h = setup(
      {
        complete: async (request) => {
          // 表情自动选择仍是叶子：没有决策 schema 的调用按候选编号回答。
          if (request.responseSchema === undefined) return "1";
          decisions++;
          if (decisions === 1)
            return '{"kind":"invoke","name":"memory.query","arguments":{"query":"apples"}}';
          if (decisions === 2) {
            const page = actionObservation(request, "memory.query");
            expect(page.value.status).toBe("ok");
            const item = page.value.items?.[0];
            if (!item?.bodyRef) throw new Error("missing memory bodyRef");
            return JSON.stringify({
              kind: "invoke",
              name: "memory.read",
              arguments: { bodyRef: item.bodyRef },
            });
          }
          return finalGenerate;
        },
        async *streamText() {
          yield "";
        },
      },
      { stickersAvailable: true },
    );
    const id = addSticker(h);
    setMemoryMode(h, "standard");
    const memoryId = addMemory(h);
    h.receive("1");
    const result = await activate(h);
    expect(result.status).toBe("completed");
    expect(decisions).toBe(3);
    expect(h.outbox.parts(h.outbox.list({})[0]!.id).map((p) => JSON.parse(p.payload!))).toEqual([
      { stickerId: id },
    ]);
    expect(
      h.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.sticker.select'").get(),
    ).toEqual({ status: "completed" });
    const snapshot = h.db
      .query(
        "SELECT s.run_id, c.step_id, c.source_refs FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id JOIN agent_runs r ON r.run_id=s.run_id WHERE r.spec_id='onebot.sticker.select'",
      )
      .get() as { run_id: string; step_id: string; source_refs: string };
    const refs = JSON.parse(snapshot.source_refs) as { kind: string; id: string }[];
    // 自动表情叶子继承的是"这一轮真正读过的来源"：观测 + 显式读入的记忆 + 候选表情。
    expect(refs.map((ref) => ref.kind)).toContain("qq_observation");
    expect(refs).toContainEqual(expect.objectContaining({ kind: "memory", id: memoryId }));
    expect(refs).toContainEqual(expect.objectContaining({ kind: "qq_sticker", id }));
    h.db.query("DELETE FROM memory_entries WHERE id=?").run(memoryId);
    // 撤权后必须经检查接口复验为 revoked，原文才不再保留（惰性脱敏）。
    expect(
      inspectContext(
        h.db,
        h.runs,
        { runId: snapshot.run_id, stepId: snapshot.step_id },
        { userId: DEFAULT_USER_ID },
        stamp(),
      ),
    ).toMatchObject({ status: "revoked" });
    expect(
      h.db
        .query(
          "SELECT c.protected_messages FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id JOIN agent_runs r ON r.run_id=s.run_id WHERE r.spec_id='onebot.sticker.select'",
        )
        .get(),
    ).toEqual({ protected_messages: null });
  });
  it("blank reply without usable sticker is corrected by an explicit none without an orphan output id", async () => {
    let calls = 0;
    const h = setup({
      complete: async (request) => {
        if (++calls === 1) return finalGenerate;
        expect(JSON.stringify(request.messages)).toContain("output_feedback");
        expect(JSON.stringify(request.messages)).toContain("EMPTY_OUTPUT");
        return '{"kind":"none"}';
      },
      async *streamText() {
        yield "";
      },
    });
    h.receive("1");
    const result = await activate(h);
    expect(result.status).toBe("no_output");
    expect(h.outbox.list({})).toEqual([]);
    expect(calls).toBe(2);
    expect(h.db.query("SELECT status FROM wake_signals").get()).toEqual({ status: "no_output" });
  });
  it("discovers a sticker through the model-visible action before explicitly selecting it", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async (request) => {
          if (++calls === 1) {
            expect(JSON.stringify(request.messages)).toContain("sticker.search");
            expect(JSON.stringify(request.messages)).not.toContain(id);
            return JSON.stringify({
              kind: "invoke",
              name: "sticker.search",
              arguments: { query: "wave", limit: 1 },
            });
          }
          const result = stickerObservation(request);
          expect(result.items).toHaveLength(1);
          return JSON.stringify({
            kind: "final",
            outputs: [
              {
                kind: "inline",
                targetId: "20002",
                text: "",
                stickerIds: [result.items[0].id],
              },
            ],
          });
        },
      },
      { stickersAvailable: true },
    );
    const id = addSticker(h);
    h.receive("1", "发个招手表情包");
    await activate(h);
    expect(calls).toBe(2);
    expect(h.outbox.parts(h.outbox.list({})[0]!.id).map((p) => JSON.parse(p.payload!))).toEqual([
      { stickerId: id },
    ]);
    expect(
      h.db
        .query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.sticker.select'")
        .get(),
    ).toEqual({ n: 0 });
  });
  for (const mode of ["off", "conservative", "standard", "broad", "full_catalog", "full_body"]) {
    it(`keeps ${mode} memory out of the initial context and reads it only on demand`, async () => {
      let id = "";
      let decisions = 0;
      const main: ModelRequest[] = [];
      const h = setup({
        complete: async (request) => {
          main.push(request);
          const tools = (request.tools ?? []).map((tool) => tool.name);
          decisions++;
          if (mode === "off") {
            expect(tools).not.toContain("memory.query");
            expect(tools).not.toContain("memory.read");
            expect(JSON.stringify(request.messages)).not.toContain("apples are green");
            return '{"kind":"none"}';
          }
          expect(tools).toContain("memory.query");
          expect(tools).toContain("memory.read");
          if (decisions === 1) {
            // 初始一步不得注入记忆正文：要正文必须显式 query + read。
            expect(JSON.stringify(request.messages)).not.toContain("apples are green");
            return '{"kind":"invoke","name":"memory.query","arguments":{"query":"apples"}}';
          }
          if (decisions === 2) {
            const page = actionObservation(request, "memory.query");
            expect(page.value.status).toBe("ok");
            expect(page.value.items?.map((item) => item.id)).toEqual([id]);
            // 目录只给摘要与引用，不给正文。
            expect(JSON.stringify(request.messages)).not.toContain("apples are green");
            const item = page.value.items?.[0];
            if (!item?.bodyRef) throw new Error("missing memory bodyRef");
            return JSON.stringify({
              kind: "invoke",
              name: "memory.read",
              arguments: { bodyRef: item.bodyRef },
            });
          }
          const page = actionObservation(request, "memory.read");
          expect(page.value.status).toBe("ok");
          expect(page.value.items?.[0]?.text).toContain("apples are green");
          expect(JSON.stringify(request.messages)).toContain("apples are green");
          return '{"kind":"none"}';
        },
      });
      setMemoryMode(h, mode);
      id = addMemory(h);
      h.receive("1", "apples");
      expect((await activate(h)).status).toBe("no_output");
      expect(decisions).toBe(mode === "off" ? 1 : 3);
      // 旧的独立 selector 已删除：没有请求走 selector 模型，也没有 ids 选择协议。
      for (const request of main) {
        expect(request.model).not.toBe("memory-selector");
        expect(
          (request.responseSchema?.properties as Record<string, unknown> | undefined)?.ids,
        ).toBeUndefined();
      }
      if (mode === "off") expect(JSON.stringify(main)).not.toContain("apples are green");
    });
  }
  it("source deletion while generating blocks commit and preserves source cursor", async () => {
    let remove = () => {};
    let id = "";
    let decisions = 0;
    const h = setup({
      complete: async (request) => {
        decisions++;
        if (decisions === 1)
          return '{"kind":"invoke","name":"memory.query","arguments":{"query":"apples"}}';
        if (decisions === 2) {
          const page = actionObservation(request, "memory.query");
          expect(page.value.items?.map((item) => item.id)).toEqual([id]);
          const item = page.value.items?.[0];
          if (!item?.bodyRef) throw new Error("missing memory bodyRef");
          return JSON.stringify({
            kind: "invoke",
            name: "memory.read",
            arguments: { bodyRef: item.bodyRef },
          });
        }
        return finalGenerate;
      },
      async *streamText() {
        remove();
        yield "uses deleted memory";
      },
    });
    setMemoryMode(h, "standard");
    id = addMemory(h);
    remove = () => {
      h.db.query("DELETE FROM memory_entries WHERE id=?").run(id);
    };
    h.receive("1", "apples");
    await expect(activate(h)).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(h.outbox.list({})).toEqual([]);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
    // 原文必须先被工具真正读进上下文，删除才是对"已读来源"的撤权，而不是对预取的清理。
    const snapshots = h.db
      .query(
        "SELECT s.run_id AS runId, c.step_id AS stepId FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id WHERE c.source_refs LIKE ?",
      )
      .all(`%${id}%`) as { runId: string; stepId: string }[];
    expect(snapshots.length).toBeGreaterThan(0);
    for (const handle of snapshots) {
      expect(
        inspectContext(h.db, h.runs, handle, { userId: DEFAULT_USER_ID }, stamp()),
      ).toMatchObject({ status: "revoked" });
    }
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
  it.each(["off", "full_body"])(
    "uses the global judgement model and respects %s in the score context",
    async (mode) => {
      let judgement: ModelRequest | undefined;
      const main: ModelRequest[] = [];
      const h = setup({
        complete: async (request) => {
          const properties = request.responseSchema?.properties as
            | Record<string, unknown>
            | undefined;
          if (properties?.ids) throw new Error("selector protocol is no longer expected");
          if (properties?.score) {
            judgement = request;
            return '{"score":0}';
          }
          main.push(request);
          if (main.length === 1) {
            // 初始零资料：正文必须靠显式 query/read 进入评分上下文，不能预取。
            expect(JSON.stringify(request.messages)).not.toContain("apples knowledge line");
            expect(JSON.stringify(request.messages)).not.toContain("apples are green");
            return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
          }
          if (main.length === 2) {
            const page = actionObservation(request, "knowledge.query");
            const item = page.value.items?.[0];
            if (!item?.bodyRef) throw new Error("missing knowledge bodyRef");
            return JSON.stringify({
              kind: "invoke",
              name: "knowledge.read",
              arguments: { bodyRef: item.bodyRef },
            });
          }
          if (mode !== "off") {
            if (main.length === 3)
              return '{"kind":"invoke","name":"memory.query","arguments":{"query":"apples"}}';
            if (main.length === 4) {
              const page = actionObservation(request, "memory.query");
              const item = page.value.items?.[0];
              if (!item?.bodyRef) throw new Error("missing memory bodyRef");
              return JSON.stringify({
                kind: "invoke",
                name: "memory.read",
                arguments: { bodyRef: item.bodyRef },
              });
            }
          }
          // 0.4.0 P4 §4.1：模型只产出意图，评分由程序在写正文之前发出（低于门槛＝静默结束）。
          return '{"kind":"final","outputs":[{"kind":"generate","targetId":"20002","instructions":"说点 apples 的事"}]}';
        },
      });
      setMemoryMode(h, mode);
      const memoryId = addMemory(h);
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
      expect(main).toHaveLength(mode === "off" ? 3 : 5);
      expect(judgement?.model).toBe("global-judge");
      const text = JSON.stringify(judgement?.messages);
      expect(text).toContain("apples knowledge line");
      expect(text.includes("apples are green")).toBe(mode !== "off");
      for (const request of main) {
        expect(request.model).not.toBe("memory-selector");
        expect(
          (request.responseSchema?.properties as Record<string, unknown> | undefined)?.ids,
        ).toBeUndefined();
      }
      expect(h.outbox.list({})).toEqual([]);
      const sources = h.db
        .query(
          "SELECT c.source_refs FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id JOIN agent_runs r ON r.run_id=s.run_id WHERE r.spec_id='onebot.initiative.evaluate'",
        )
        .get() as { source_refs: string };
      const refs = JSON.parse(sources.source_refs) as { kind: string; id: string }[];
      expect(refs.map((ref) => ref.kind)).toEqual(
        expect.arrayContaining([
          ...(mode === "off" ? [] : ["memory"]),
          "knowledge_document",
          "knowledge_grant",
          "qq_observation",
        ]),
      );
      expect(refs).toContainEqual(
        expect.objectContaining({ kind: "knowledge_document", id: doc.id }),
      );
      if (mode !== "off")
        expect(refs).toContainEqual(expect.objectContaining({ kind: "memory", id: memoryId }));
    },
  );
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
    expect(h.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.main'").get()).toEqual({
      status: "cancelled",
    });
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
  it.each([2200, 6500])(
    "bounds cumulative knowledge envelopes across repeated actions and reobservation at %s units",
    async (budget) => {
      const mainRequests: ModelRequest[] = [];
      let decisions = 0;
      let h: ReturnType<typeof setup>;
      h = setup({
        complete: async (request) => {
          if ((request.responseSchema?.properties as Record<string, unknown> | undefined)?.ids)
            throw new Error("selector protocol is no longer expected");
          mainRequests.push(request);
          decisions++;
          if (decisions <= 2)
            return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
          // The next read rebuilds initial material while keeping previous action observations.
          if (decisions === 3) h.receive("2", "apples additional detail");
          return '{"kind":"none"}';
        },
      });
      const library = new KnowledgeRepository(h.db);
      const body = "apples " + "Q".repeat(1000);
      const doc = library.importDocument({
        name: "apples",
        category_id: "default",
        original_text: body,
      });
      library.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
      h.db
        .query("UPDATE agent_knowledge_read_settings SET context_budget=? WHERE agent_id=?")
        .run(budget, DEFAULT_AGENT_ID);
      h.receive("1", "apples");
      expect((await activate(h)).status).toBe("no_output");
      expect(decisions).toBe(4);
      if (budget === 6500) {
        const finalMessages = mainRequests[mainRequests.length - 1].messages;
        expect(
          finalMessages.some((message) =>
            message.content.some((part) => {
              if (part.kind !== "text") return false;
              try {
                const data = JSON.parse(part.text);
                return data.kind === "action_observation" && data.value.value.items.length > 0;
              } catch {
                return false;
              }
            }),
          ),
        ).toBe(true);
      }
      // 初始零资料：查询动作由模型显式发起，首轮上下文既没有正文也没有资料目录。
      expect(JSON.stringify(mainRequests[0]!.messages)).not.toContain(body);
      expect(JSON.stringify(mainRequests[0]!.messages)).not.toContain(doc.id);
      let deliveredEnvelopes = 0;
      for (const request of mainRequests) {
        const knowledgeMessages = request.messages.filter((message) =>
          message.content.some((part) => {
            if (part.kind !== "text") return false;
            try {
              const data = JSON.parse(part.text);
              return (
                data.kind === "evidence" ||
                (data.kind === "action_observation" &&
                  data.value.name === "knowledge.query" &&
                  data.value.value.items.length > 0)
              );
            } catch {
              return false;
            }
          }),
        );
        // Count the messages actually delivered to the model, not backend estimates or bodies alone.
        expect(inputUnits(knowledgeMessages) - 3).toBeLessThanOrEqual(budget);
        // 重复 query 交付的是真实信封：目录项、来源与续读游标都由同一个预算覆盖。
        for (const message of knowledgeMessages)
          for (const part of message.content) {
            if (part.kind !== "text") continue;
            let data: {
              kind?: string;
              value?: {
                value?: { nextCursor?: string | null };
                sources?: { kind: string }[];
              };
            };
            try {
              data = JSON.parse(part.text);
            } catch {
              continue;
            }
            if (data.kind !== "action_observation") continue;
            deliveredEnvelopes++;
            expect(
              data.value?.value?.nextCursor === null ||
                typeof data.value?.value?.nextCursor === "string",
            ).toBe(true);
            expect(
              (data.value?.sources ?? []).some((source) => source.kind === "knowledge_grant"),
            ).toBe(true);
          }
      }
      expect(deliveredEnvelopes).toBeGreaterThan(0);
      const last = JSON.stringify(mainRequests.at(-1)!.messages);
      expect(last).toContain("apples additional detail");
      expect(last.match(/action_observation/g)).toHaveLength(2);
      expect(h.outbox.list({})).toHaveLength(0);
    },
  );
  for (const mode of ["disabled", "selected", "tiny_budget", "frozen"] as const)
    it(`applies ${mode} knowledge settings to initial and Agent action reads`, async () => {
      const seen: ModelRequest[] = [];
      let decisions = 0;
      let h: ReturnType<typeof setup>;
      h = setup({
        complete: async (request) => {
          if ((request.responseSchema?.properties as Record<string, unknown> | undefined)?.ids)
            throw new Error("selector protocol is no longer expected");
          seen.push(request);
          decisions++;
          if (mode === "disabled") return '{"kind":"none"}';
          if (decisions === 1) {
            if (mode === "frozen")
              h.db.exec(
                "UPDATE agent_knowledge_read_settings SET enabled=0, context_budget=1, document_ids='[]', revision=revision+1",
              );
            return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
          }
          if (decisions === 2) {
            const bodyRef = actionObservation(request, "knowledge.query").value.items?.[0]?.bodyRef;
            // tiny_budget 的信封里没有可读正文，模型拿不到 bodyRef 就只能停在这里。
            if (!bodyRef) return '{"kind":"none"}';
            return JSON.stringify({
              kind: "invoke",
              name: "knowledge.read",
              arguments: { bodyRef },
            });
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
      const observations = seen.flatMap((request) => modelData(request, "action_observation"));
      const query = observations.filter((value) => value.name === "knowledge.query").at(-1);
      if (mode === "disabled") {
        expect(text).not.toContain("knowledge.query");
        expect(observations).toHaveLength(0);
      } else {
        // 显式 query 取代了隐式预取/选择器：信封自带来源，续读只能靠 nextCursor。
        expect(query).toBeDefined();
        if (mode === "tiny_budget") {
          // 预算 1 连一个目录项都装不下：安全地回 unavailable，不伪造成"没有相关内容"。
          expect(query?.value).toMatchObject({ status: "unavailable", items: [] });
        } else {
          expect(query?.value?.status).toBe("ok");
          expect(query?.value?.items?.length).toBeGreaterThan(0);
          expect(JSON.stringify(query?.sources ?? [])).toContain(selected.id);
        }
      }
      // selected/frozen 继续按配置显式 read 出正文；disabled/tiny_budget 没有可读引用。
      const reads = observations.filter((value) => value.name === "knowledge.read");
      expect(reads.length > 0).toBe(mode === "selected" || mode === "frozen");
    });
});

it("把输出预留下发为 max_tokens：私聊决策与生成都用回复预留，方案改值后新轮生效", async () => {
  const seen: ModelRequest[] = [];
  const h = setup({
    complete: async (request) => {
      seen.push(request);
      return finalGenerate;
    },
    async *streamText(request) {
      seen.push(request);
      yield "answer";
    },
  });
  const textOf = (request: ModelRequest) =>
    request.messages
      .flatMap((message) =>
        message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
      )
      .join("\n");
  const find = (marker: string) => seen.find((request) => textOf(request).includes(marker));
  h.receive("1");
  expect((await activate(h)).status).toBe("completed");
  // 私聊没有独立判断档：决策与生成都按回复预留下发（默认 2048），与 available() 的预算口径一致。
  const decision = find("Return exactly one JSON decision");
  const generation = find("Write only the response body");
  expect(decision?.maxTokens).toBe(2048);
  expect(generation?.maxTokens).toBe(2048);
  seen.length = 0;
  updateQqScheme(h.orm, h.scheme.id, {
    name: h.scheme.name,
    outputReserve: { judgement_output_reserved: 640, reply_output_reserved: 896 },
    expectedRevision: h.scheme.revision,
  });
  h.clock.seconds += 2;
  h.receive("2");
  expect((await activate(h)).status).toBe("completed");
  expect(find("Return exactly one JSON decision")?.maxTokens).toBe(896);
  expect(find("Write only the response body")?.maxTokens).toBe(896);
});

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

describe("optional Bot retrieval failure", () => {
  it.each(["unavailable", "revoked", "cancelled"])(
    "%s retrieval preserves valid raw context without swallowing authority/cancellation",
    async (failure) => {
      const controller = new AbortController();
      let h: ReturnType<typeof setup>,
        decisions = 0;
      const main: ModelRequest[] = [];
      h = setup(
        {
          complete: async (request) => {
            if ((request.responseSchema?.properties as Record<string, unknown> | undefined)?.ids)
              throw new Error("selector protocol is no longer expected");
            main.push(request);
            return ++decisions === 1
              ? '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}'
              : '{"kind":"none"}';
          },
        },
        {
          // 只读检索现在直接走 composition 工厂：这里包一层 query 注入三种失败。
          modules: (binding) => {
            const modules = createSqliteQueryFactory({
              db: h.db,
              orm: h.orm,
              gateway: h.gateway,
              agentRuntime: h.runtime,
            })(binding);
            return {
              ...modules,
              knowledge: {
                query: async (input) => {
                  if (failure === "unavailable")
                    throw new ModelUnavailableError("MODEL_TIMEOUT", "本地模型响应超时，请重试");
                  if (failure === "cancelled") controller.abort();
                  const page = await modules.knowledge.query(input);
                  // 已经消费（拿到底稿候选）的来源在披露前被撤权：必须硬失败。
                  if (failure === "revoked") h.db.exec("DELETE FROM knowledge_grants");
                  return page;
                },
              },
            };
          },
        },
      );
      setMemoryMode(h, "off");
      const library = new KnowledgeRepository(h.db);
      const doc = library.importDocument({
        name: "apples",
        category_id: "default",
        original_text: "apples optional knowledge",
      });
      library.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
      h.receive("1", "valid raw question");
      const wake = h.wakes.claim({ at: stamp(h.clock.seconds), leaseMs: 120000 })!;
      const result = h.host.activate(wake, controller.signal);
      if (failure === "unavailable") {
        expect((await result).status).toBe("no_output");
        const text = JSON.stringify(main);
        expect(text).toContain("valid raw question");
        expect(text).toContain("retrieval_status");
        expect(text).toContain("MODEL_TIMEOUT");
        expect(text).not.toContain("apples optional knowledge");
        // 失败以安全信封回给模型（unavailable + 码），不是硬失败也不是"没搜到"。
        expect(main).toHaveLength(2);
        expect(actionObservation(main[1]!, "knowledge.query").value).toMatchObject({
          status: "unavailable",
          code: "MODEL_TIMEOUT",
          items: [],
        });
      } else {
        if (failure === "revoked")
          await expect(result).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
        else await expect(result).rejects.toBeDefined();
        expect(main).toHaveLength(1);
        expect(JSON.stringify(main)).toContain("valid raw question");
        expect(JSON.stringify(main)).not.toContain("apples optional knowledge");
        expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
      }
      expect(h.outbox.list({})).toHaveLength(0);
    },
  );
});

describe("model-visible sticker contract", () => {
  for (const kind of ["inline", "generate"] as const) {
    for (const intent of ["omitted", "auto", "none"] as const) {
      it(`${kind} preserves ${intent} sticker intent`, async () => {
        let calls = 0;
        const h = setup(
          {
            complete: async () => {
              if (++calls > 1) return "1";
              return JSON.stringify({
                kind: "final",
                outputs: [
                  {
                    kind,
                    targetId: "20002",
                    ...(kind === "inline" ? { text: "你好" } : { instructions: "answer" }),
                    ...(intent === "omitted" ? {} : { stickerIds: intent === "none" ? [] : null }),
                  },
                ],
              });
            },
            async *streamText() {
              yield "你好";
            },
          },
          { stickersAvailable: true },
        );
        const id = addSticker(h);
        h.receive("1");
        const result = await activate(h);
        expect(result.status).toBe("completed");
        const parts = h.outbox
          .parts(h.outbox.list({})[0]!.id)
          .map((part) => JSON.parse(part.payload!));
        expect(parts).toEqual(
          intent === "none" ? [{ text: "你好" }] : [{ text: "你好" }, { stickerId: id }],
        );
        expect(calls).toBe(intent === "none" ? 1 : 2);
      });
    }
  }
  it("corrects a nonexistent explicit ID using a discoverable candidate instead of silently doing nothing", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async (request) => {
          calls++;
          if (calls === 1)
            return JSON.stringify({
              kind: "final",
              outputs: [{ kind: "inline", targetId: "20002", text: "", stickerIds: ["smile"] }],
            });
          if (calls === 2) {
            expect(JSON.stringify(request.messages)).toContain("STICKER_SELECTION_UNAVAILABLE");
            return JSON.stringify({
              kind: "invoke",
              name: "sticker.search",
              arguments: { query: "" },
            });
          }
          return JSON.stringify({
            kind: "final",
            outputs: [
              {
                kind: "inline",
                targetId: "20002",
                text: "",
                stickerIds: [stickerObservation(request).items[0].id],
              },
            ],
          });
        },
      },
      { stickersAvailable: true },
    );
    const id = addSticker(h);
    h.receive("1", "为什么没有表情包");
    const result = await activate(h);
    expect(result.status).toBe("completed");
    expect(calls).toBe(3);
    expect(
      h.outbox.parts(h.outbox.list({})[0]!.id).map((part) => JSON.parse(part.payload!)),
    ).toEqual([{ stickerId: id }]);
  });
  it("fails an uncorrected empty plan at the configured step budget instead of recording normal silence", async () => {
    let calls = 0;
    const h = setup({
      complete: async (request) => {
        if (++calls > 1) expect(JSON.stringify(request.messages)).toContain("EMPTY_OUTPUT");
        return JSON.stringify({
          kind: "final",
          outputs: [{ kind: "inline", targetId: "20002", text: "", stickerIds: [] }],
        });
      },
    });
    h.receive("1");
    await expect(activate(h)).rejects.toMatchObject({ code: "AGENT_STEP_LIMIT" });
    expect(calls).toBe(12);
    expect(
      h.db.query("SELECT status,error_code FROM agent_runs WHERE spec_id='onebot.main'").get(),
    ).toEqual({ status: "failed", error_code: "AGENT_STEP_LIMIT" });
    expect(h.outbox.list({})).toEqual([]);
  });
  it("retains a selected sticker and its source in the pending plan after a new message", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async (request) => {
          calls++;
          if (calls === 1) return finalGenerate;
          if (calls === 2) {
            h.receive("2", "接着说");
            return "1";
          }
          const output = pendingOutput(request);
          expect(output.stickerIds).toHaveLength(1);
          expect(output.sources).toContainEqual({
            kind: "qq_sticker",
            id: output.stickerIds[0],
            revision: expect.any(String),
          });
          return JSON.stringify({
            kind: "final",
            outputs: [
              {
                kind: "inline",
                targetId: output.targetId,
                text: output.text,
                stickerIds: output.stickerIds,
              },
            ],
          });
        },
        async *streamText() {
          yield "你好";
        },
      },
      { stickersAvailable: true },
    );
    const id = addSticker(h);
    h.receive("1");
    await activate(h);
    expect(calls).toBe(3);
    const intent = h.outbox.list({})[0]!;
    expect(h.outbox.parts(intent.id).map((part) => JSON.parse(part.payload!))).toEqual([
      { text: "你好" },
      { stickerId: id },
    ]);
    const target = JSON.parse(h.outbox.row(intent.id)!.target);
    expect(target.sources).toContainEqual({ kind: "qq_sticker", id, revision: expect.any(String) });
    const context = h.db
      .query(
        "SELECT c.source_refs FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id WHERE s.run_id=? ORDER BY s.step_no DESC LIMIT 1",
      )
      .get(intent.runId) as { source_refs: string };
    expect(JSON.parse(context.source_refs)).toContainEqual({
      kind: "qq_sticker",
      id,
      revision: expect.any(String),
    });
  });
});

describe("sticker search context and permissions", () => {
  function extra(
    h: ReturnType<typeof setup>,
    name: string,
    collectionIds: string[],
    id: string = crypto.randomUUID(),
  ) {
    importQqSticker(h.orm, {
      id,
      copy: { fileName: `${id}.png`, byteSize: 64, mediaType: "image" },
      name,
      width: 64,
      height: 64,
      collectionIds,
    });
    setQqStickerEnabled(h.orm, id, true);
    return id;
  }
  function collection(h: ReturnType<typeof setup>, id: string) {
    return (
      h.db
        .query("SELECT collection_id AS id FROM qq_sticker_collection_items WHERE asset_id=?")
        .get(id) as { id: string }
    ).id;
  }
  it("paginates disclosed candidates without exposing disabled or unauthorized assets", async () => {
    let calls = 0;
    const found: string[] = [];
    const h = setup(
      {
        complete: async (request) => {
          calls++;
          if (calls > 1) {
            const page = stickerObservation(request);
            expect(page.items).toHaveLength(1);
            found.push(page.items[0].id);
            expect(JSON.stringify(request.messages)).not.toContain(disabled);
            expect(JSON.stringify(request.messages)).not.toContain(unauthorized);
            if (!page.nextCursor) return '{"kind":"none"}';
            return JSON.stringify({
              kind: "invoke",
              name: "sticker.search",
              arguments: { query: "wave", limit: 1, cursor: page.nextCursor },
            });
          }
          return JSON.stringify({
            kind: "invoke",
            name: "sticker.search",
            arguments: { query: "wave", limit: 1 },
          });
        },
      },
      { stickersAvailable: true },
    );
    const first = addSticker(h);
    const second = extra(h, "wave second", [collection(h, first)]);
    const disabled = extra(h, "wave disabled", [collection(h, first)]);
    setQqStickerEnabled(h.orm, disabled, false);
    const unauthorized = extra(h, "wave unauthorized", []);
    h.receive("1");
    await activate(h);
    expect(found.sort()).toEqual([first, second].sort());
    expect(calls).toBe(3);
    expect(h.outbox.list({})).toEqual([]);
  });
  it("fits the actual search observation including IDs and sources into the configured model capacity", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async (request) => {
          expect(inputUnits(request.messages)).toBeLessThanOrEqual(16000 - 2048);
          if (++calls === 1)
            return JSON.stringify({
              kind: "invoke",
              name: "sticker.search",
              arguments: { query: "", limit: 1000 },
            });
          const page = stickerObservation(request);
          expect(page.items.length).toBeGreaterThan(0);
          expect(page.items.length).toBeLessThan(21);
          expect(page.nextCursor).not.toBeNull();
          return '{"kind":"none"}';
        },
      },
      { stickersAvailable: true },
    );
    h.gateway.loadedContextCapacity = async () => 16250;
    const first = addSticker(h);
    h.db
      .query("UPDATE qq_sticker_assets SET description=? WHERE id=?")
      .run("详细描述".repeat(500), first);
    const small = extra(
      h,
      "small first",
      [collection(h, first)],
      "00000000-0000-4000-8000-000000000000",
    );
    expect(small).toBe("00000000-0000-4000-8000-000000000000");
    for (let i = 0; i < 20; i++) {
      const id = extra(h, `wave ${i}`, [collection(h, first)]);
      h.db
        .query("UPDATE qq_sticker_assets SET description=? WHERE id=?")
        .run("详细描述".repeat(500), id);
    }
    h.receive("1");
    await activate(h);
    expect(calls).toBe(2);
  });
  it("skips oversized leading candidates on each page while preserving complete smaller assets and cursors", async () => {
    const firstSmall = "11111111-1111-4111-8111-111111111111";
    const secondSmall = "33333333-3333-4333-8333-333333333333";
    const descriptions = "详".repeat(2000);
    const pages: ReturnType<typeof stickerObservation>[] = [];
    let calls = 0;
    const h = setup(
      {
        complete: async (request) => {
          expect(inputUnits(request.messages)).toBeLessThanOrEqual(16300 - 2048);
          calls++;
          if (calls > 1) {
            const page = stickerObservation(request);
            pages.push(page);
            expect(page.status).toBe("available");
            expect(page.items).toHaveLength(1);
            expect(JSON.stringify(request.messages)).not.toContain(descriptions);
            if (page.nextCursor === null) return '{"kind":"none"}';
            return JSON.stringify({
              kind: "invoke",
              name: "sticker.search",
              arguments: { query: "", limit: 1, cursor: page.nextCursor },
            });
          }
          return JSON.stringify({
            kind: "invoke",
            name: "sticker.search",
            arguments: { query: "", limit: 1 },
          });
        },
      },
      { stickersAvailable: true },
    );
    // 0.4.0 P2 批调用与工具目录（query/read 动作描述）把固定协议基线抬到 ~11.8k；本用例考的是
    // 分页，不是容量边界，容量按实测最小值同步上调（生产默认容量远大于此）。
    h.gateway.loadedContextCapacity = async () => 16300;
    const anchor = addSticker(h);
    const collections = [collection(h, anchor)];
    setQqStickerEnabled(h.orm, anchor, false);
    const largeIds = [
      "00000000-0000-4000-8000-000000000000",
      "22222222-2222-4222-8222-222222222222",
    ];
    for (const id of largeIds) {
      extra(h, "large", collections, id);
      editQqSticker(h.orm, id, { description: descriptions });
    }
    extra(h, "first compact", collections, firstSmall);
    extra(h, "second compact", collections, secondSmall);
    h.receive("1");
    expect((await activate(h)).status).toBe("no_output");
    expect(calls).toBe(3);
    expect(pages.map((page) => page.items[0].id)).toEqual([firstSmall, secondSmall]);
    expect(pages.map((page) => page.nextCursor)).toEqual([firstSmall, null]);
    for (const id of largeIds)
      expect(h.db.query("SELECT description FROM qq_sticker_assets WHERE id=?").get(id)).toEqual({
        description: descriptions,
      });
  });
  it("reports a terminal budget-exhausted page only after no authorized whole item fits", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async (request) => {
          expect(inputUnits(request.messages)).toBeLessThanOrEqual(16300 - 2048);
          if (++calls === 1)
            return JSON.stringify({
              kind: "invoke",
              name: "sticker.search",
              arguments: { query: "" },
            });
          expect(stickerObservation(request)).toEqual({
            status: "budget_exhausted",
            items: [],
            nextCursor: null,
          });
          return '{"kind":"none"}';
        },
      },
      { stickersAvailable: true },
    );
    // 0.4.0 P2 批调用与工具目录（query/read 动作描述）把固定协议基线抬到 ~11.8k；本用例考的是
    // 分页，不是容量边界，容量按实测最小值同步上调（生产默认容量远大于此）。
    h.gateway.loadedContextCapacity = async () => 16300;
    const large = addSticker(h);
    editQqSticker(h.orm, large, { description: "详".repeat(2000) });
    h.receive("1");
    expect((await activate(h)).status).toBe("no_output");
    expect(calls).toBe(2);
    expect(h.outbox.list({})).toEqual([]);
  });
  it("does not use a disclosed candidate after its asset is disabled", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async (request) => {
          if (++calls === 1)
            return JSON.stringify({
              kind: "invoke",
              name: "sticker.search",
              arguments: { query: "" },
            });
          const id = stickerObservation(request).items[0].id;
          setQqStickerEnabled(h.orm, id, false);
          return JSON.stringify({
            kind: "final",
            outputs: [{ kind: "inline", targetId: "20002", text: "", stickerIds: [id] }],
          });
        },
      },
      { stickersAvailable: true },
    );
    addSticker(h);
    h.receive("1");
    await expect(activate(h)).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(h.outbox.list({})).toEqual([]);
  });
  it("exposes unavailable capability without fabricating candidate IDs", async () => {
    let calls = 0;
    const h = setup({
      complete: async (request) => {
        if (++calls === 1) {
          expect(JSON.stringify(request.messages)).toContain("disabled");
          return JSON.stringify({
            kind: "invoke",
            name: "sticker.search",
            arguments: { query: "" },
          });
        }
        expect(stickerObservation(request)).toEqual({
          status: "disabled",
          items: [],
          nextCursor: null,
        });
        return '{"kind":"none"}';
      },
    });
    h.receive("1");
    expect((await activate(h)).status).toBe("no_output");
    expect(calls).toBe(2);
  });
});

it("marks the real activation source as data without replacing it with unrelated older history", async () => {
  const h = setup({
    complete: async (request) => {
      const trigger = modelData(request, "activation_trigger")[0];
      expect(trigger).toMatchObject({
        cause: "direct_reply",
        participantId: "20002",
        text: "为什么没有表情包",
        contentState: "in_selected_context",
      });
      expect(
        h.db.query("SELECT message_id FROM qq_events WHERE event_key=?").get(trigger.sourceId),
      ).toEqual({ message_id: "1" });
      return '{"kind":"none"}';
    },
  });
  h.receive("1", "为什么没有表情包");
  expect((await activate(h)).status).toBe("no_output");
});

it("sticker search respects the configured per-conversation repeat interval", async () => {
  let calls = 0;
  const h = setup(
    {
      complete: async (request) => {
        if (++calls === 1)
          return JSON.stringify({
            kind: "invoke",
            name: "sticker.search",
            arguments: { query: "" },
          });
        expect(stickerObservation(request)).toEqual({
          status: "no_candidates",
          items: [],
          nextCursor: null,
        });
        return '{"kind":"none"}';
      },
    },
    { stickersAvailable: true },
  );
  const id = addSticker(h);
  recordQqSend(h.orm, {
    scope: {
      kind: "qq",
      accountId: "10001",
      conversationKind: "private",
      peerId: "20002",
      agentId: DEFAULT_AGENT_ID,
    },
    kind: "direct_reply",
    sentAtSeconds: nowSeconds - 10,
    text: null,
    parts: [{ kind: "sticker", result: "confirmed", messageId: "old-sticker", stickerId: id }],
  });
  h.receive("1");
  await activate(h);
  expect(calls).toBe(2);
  expect(h.outbox.list({})).toEqual([]);
});

for (const mode of ["throw", "reject"] as const) {
  it(`keeps sticker completion independent from diagnostics that ${mode}`, async () => {
    let calls = 0;
    const events: Parameters<
      NonNullable<ConstructorParameters<typeof OneBotHost>[0]["onDiagnostic"]>
    >[0][] = [];
    const h = setup(
      {
        complete: async () =>
          ++calls === 1
            ? JSON.stringify({
                kind: "final",
                outputs: [
                  {
                    kind: "inline",
                    targetId: "20002",
                    text: "private reply content",
                    stickerIds: null,
                  },
                ],
              })
            : "1",
      },
      {
        stickersAvailable: true,
        onDiagnostic: (event) => {
          events.push(event);
          if (mode === "throw") throw new Error("observer unavailable");
          return Promise.reject(new Error("observer unavailable"));
        },
      },
    );
    const id = addSticker(h);
    h.receive("1", "private input content");
    expect((await activate(h)).status).toBe("completed");
    expect(events).toContainEqual(
      expect.objectContaining({
        stage: "sticker",
        status: "selected",
        targetId: "20002",
        details: { stickerId: id },
      }),
    );
    expect(JSON.stringify(events)).not.toContain("private input content");
    expect(JSON.stringify(events)).not.toContain("private reply content");
    expect(h.outbox.list({})).toHaveLength(1);
  });
}
