import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { QqTaskScheduler } from "../../src/server/conversation/qq-task-scheduler";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults } from "../../src/server/db/repositories";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { createRuntime } from "../../src/server/runtime";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { runtimeFixtureBusiness } from "../harness/business-db";

afterEach(() => mock.restore());

it("lets timer callbacks run while the production runtime dispatches wakes without awaiting models", async () => {
  let dispatched = 0;
  spyOn(QqTaskScheduler.prototype, "dispatchOnce").mockImplementation(async () => {
    dispatched += 1;
    return dispatched <= 3;
  });
  const runtime = await createRuntime({
    business: runtimeFixtureBusiness(),
    browserStateSecret: "synthetic-yield-fixture-secret",
  });
  Object.defineProperty(runtime.qqIntake, "state", {
    value: { phase: "ready" },
    configurable: true,
  });
  let timer!: ReturnType<typeof setTimeout>;
  const observed = new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(dispatched), 0);
  });
  try {
    await runtime.botWorker.runCycle();
    // 计时器回调在派发车道让出 I/O 时就跑到了：短 tick 没有被后台车道堵死。
    const duringCycle = await observed;
    expect(duringCycle).toBeLessThan(dispatched);
    expect(dispatched).toBeGreaterThanOrEqual(3);
    // 结算通知后的下一轮短 tick 仍只派发不等模型。
    await runtime.botWorker.runCycle();
    expect(dispatched).toBeGreaterThan(duringCycle);
  } finally {
    clearTimeout(timer);
    await runtime.stop();
  }
});

it("keeps committed intake and ordinary HTTP reads independent of a held model activation", async () => {
  const held = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<void>();
  const runtime = await createRuntime({
    business: runtimeFixtureBusiness(),
    browserStateSecret: "synthetic-held-model-secret",
    gateway: {
      config: { baseUrl: "http://unused.invalid", model: "fixture", timeoutSeconds: 1 },
      async listModels() {
        return ["fixture"];
      },
      async loadedContextCapacity() {
        return 65536;
      },
      async probeModelLoaded() {
        return true;
      },
      async complete() {
        entered.resolve();
        return held.promise;
      },
      async *streamChat() {
        yield "unused";
      },
    },
  });
  const { db, orm } = runtime.business;
  ensureDefaults(orm, "fixture");
  const agent = db.query("SELECT id FROM agents ORDER BY created_at,id LIMIT 1").get() as {
    id: string;
  } | null;
  if (!agent) throw new Error("runtime agent fixture missing");
  const journal = new ConversationEventRepository(db);
  const adapter = new OneBot11Adapter({ orm, journal, wakes: new WakeRepository(db) });
  updateQqSettings(orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(orm, {
    name: "held model intake",
    triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: false },
  });
  const bindingId = crypto.randomUUID();
  db.query(`INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at)
    VALUES(?,'10001','private','20002',?,?,?,?)`).run(
    bindingId,
    agent.id,
    scheme.id,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  const receive = (messageId: string) =>
    recordInbound(
      orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "private",
          sub_type: "friend",
          time: Math.floor(Date.now() / 1000),
          self_id: 10001,
          user_id: 20002,
          message_id: messageId,
          message: [{ type: "text", data: { text: "synthetic arrival" } }],
          sender: { nickname: "fixture" },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: adapter },
    );
  Object.defineProperty(runtime.qqIntake, "state", {
    value: { phase: "ready" },
    configurable: true,
  });
  try {
    expect(receive("100001")).toMatchObject({ kind: "recorded", recorded: true });
    const cycle = runtime.botWorker.runCycle();
    await entered.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(receive("100002")).toMatchObject({ kind: "recorded", recorded: true });
    const conversation = journal.ensureOneBot(bindingId)!;
    expect(
      journal.historyAfter(conversation.id).items.filter(({ event }) => event.kind === "inbound"),
    ).toHaveLength(2);
    expect((await runtime.app.request("/nonexistent-held-model-fixture")).status).toBe(404);
    await cycle;
  } finally {
    held.resolve(JSON.stringify({ kind: "none", reason: "fixture complete" }));
    await runtime.stop();
  }
});
