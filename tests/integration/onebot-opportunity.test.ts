import { afterEach, describe, expect, it } from "bun:test";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { BotWorker } from "../../src/server/conversation/bot-worker";
import { WakeScheduler } from "../../src/server/conversation/wake-scheduler";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { recordQqSpeech } from "../../src/server/db/qq-speech-repository";
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
const time = 2_000_000_000;
function setup(
  follow = false,
  overrides: { rhythm?: Partial<typeof QQ_RHYTHM_DEFAULT>; admission?: boolean } = {},
) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "synthetic");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "opportunities",
    triggers: { direct_reply: true, follow_up: follow, chiming_in: !follow, idle_topic: false },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      merge_window_seconds: 15,
      judgement_interval_turns: 1,
      ...overrides.rhythm,
    },
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
      new Date(time * 1000).toISOString(),
      new Date(time * 1000).toISOString(),
    );
  const clock = { seconds: time },
    journal = new ConversationEventRepository(h.db),
    wakes = new WakeRepository(h.db);
  let notifications = 0;
  // 局部捕获：属性读不会把窄化带进闭包，const 才能让 available 在分支里是 boolean。
  const available = overrides.admission;
  const adapter = new OneBot11Adapter({
    orm: h.orm,
    journal,
    wakes,
    nowSeconds: () => clock.seconds,
    wake: () => {
      notifications++;
    },
    ...(available === undefined ? {} : { admission: { available: () => available } }),
  });
  const now = () => new Date(clock.seconds * 1000).toISOString();
  const receive = (id: string, speaker = 20002, ingress = true) =>
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: clock.seconds,
          self_id: 10001,
          user_id: speaker,
          group_id: 30003,
          message_id: id,
          message: [{ type: "text", data: { text: "synthetic" } }],
          sender: { nickname: "synthetic" },
        },
        "10001",
      ),
      { accountId: "10001", ...(ingress ? { conversationIngress: adapter } : {}) },
    );
  const receiveMention = (id: string, speaker = 20002) =>
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: clock.seconds,
          self_id: 10001,
          user_id: speaker,
          group_id: 30003,
          message_id: id,
          message: [
            { type: "at", data: { qq: "10001" } },
            { type: "text", data: { text: "synthetic" } },
          ],
          sender: { nickname: "synthetic" },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: adapter },
    );
  const rows = () =>
    h.db.query("SELECT * FROM wake_signals ORDER BY created_at,id").all() as {
      id: string;
      cause: string;
      status: string;
      through_seq: number;
      ready_at: string;
      dedupe_key: string;
      error_code: string | null;
      attempts: number;
    }[];
  return {
    ...h,
    bindingId,
    clock,
    journal,
    wakes,
    adapter,
    receive,
    receiveMention,
    now,
    rows,
    get notifications() {
      return notifications;
    },
  };
}

function receiveBatch(h: ReturnType<typeof setup>, count: number, startId = 1, ingress = true) {
  for (let i = 0; i < count; i += 1)
    h.receive(String(startId + i), 20000 + ((i % 13) + 1), ingress);
}
describe("source-backed participant opportunities", () => {
  it("restoration is idempotent and never extends the deadline or re-notifies unchanged source", () => {
    // 恢复扫描本身与两维窗口无关：这里关掉时间窗，只证明"同一来源不重复通知"。
    const h = setup(false, { rhythm: { initiative_time_window_enabled: false } });
    receiveBatch(h, 10);
    const original = h.rows();
    for (const offset of [1, 8, 15, 100]) {
      h.clock.seconds = time + offset;
      h.adapter.sweep();
    }
    expect(h.rows()).toEqual(original);
    expect(h.notifications).toBe(1);
    expect(h.wakes.claim({ at: h.now(), leaseMs: 120000 })?.id).toBe(original[0]!.id);
  });
  it("terminal failure of a merged source is not resurrected by scanning its later event key", () => {
    const h = setup();
    receiveBatch(h, 10);
    h.clock.seconds += 20;
    const claimed = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    h.wakes.fail(claimed.id, claimed.leaseToken!, {
      at: h.now(),
      errorCode: "MODEL_FAILED",
      maxAttempts: 1,
      retryDelayMs: 15000,
    });
    const before = h.rows(),
      notifications = h.notifications;
    for (let i = 0; i < 5; i++) {
      h.clock.seconds += 30;
      h.adapter.sweep();
    }
    expect(h.rows()).toEqual(before);
    expect(h.notifications).toBe(notifications);
    h.receive("11");
    expect(h.rows().filter((r) => r.status === "pending")).toHaveLength(1);
  });
  it("a terminal source is not reclassified into a fresh initiative after later assistant speech", () => {
    const h = setup(true);
    const scope = {
      kind: "qq" as const,
      accountId: "10001",
      conversationKind: "group" as const,
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
    };
    recordQqSpeech(h.orm, { scope, kind: "direct_reply", spokeAtSeconds: time - 1, text: "old" });
    h.receive("1");
    // 连续交谈按人滚动：本人最后到达 + merge 才成熟，不再即时。
    h.clock.seconds += 15;
    const claimed = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    expect(claimed.cause).toBe("follow_up");
    h.wakes.fail(claimed.id, claimed.leaseToken!, {
      at: h.now(),
      errorCode: "MODEL_FAILED",
      maxAttempts: 1,
      retryDelayMs: 15000,
    });
    h.clock.seconds++;
    recordQqSpeech(h.orm, {
      scope,
      kind: "direct_reply",
      spokeAtSeconds: h.clock.seconds,
      text: "someone else",
    });
    const before = h.rows();
    h.adapter.sweep();
    expect(h.rows()).toEqual(before);
    expect(h.notifications).toBe(1);
  });
  it("restoration preserves retry backoff rather than reopening the same source early", () => {
    const h = setup();
    receiveBatch(h, 10);
    h.clock.seconds += 15;
    const claimed = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    h.wakes.fail(claimed.id, claimed.leaseToken!, {
      at: h.now(),
      errorCode: "MODEL_FAILED",
      maxAttempts: 3,
      retryDelayMs: 60000,
    });
    const original = h.rows();
    h.clock.seconds += 20;
    h.adapter.sweep();
    expect(h.rows()).toEqual(original);
    expect(h.wakes.claim({ at: h.now(), leaseMs: 120000 })).toBeNull();
  });
  it.each([false, true])(
    "historical speech chooses enabled continuation=%s without hiding initiative",
    (follow) => {
      const h = setup(follow);
      recordQqSpeech(h.orm, {
        scope: {
          kind: "qq",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
        },
        kind: "direct_reply",
        spokeAtSeconds: time - 100,
        text: "past",
      });
      if (follow) h.receive("1");
      else receiveBatch(h, 10);
      expect(h.rows().map((r) => r.cause)).toEqual([follow ? "follow_up" : "chiming_in"]);
    },
  );
  it("chiming batch coalesces later arrivals into the one pending opportunity without postponing it", () => {
    const h = setup();
    receiveBatch(h, 10, 1);
    const before = h.rows();
    h.clock.seconds += 14;
    h.receive("11", 20003);
    h.receive("12", 20004);
    // 会话级合并：始终只有一条未领取机会，readyAt 不被后到消息顺延，throughSeq 只增。
    expect(h.rows()).toHaveLength(1);
    const batch = h.rows()[0]!;
    expect(batch.id).toBe(before[0]!.id);
    expect(batch.ready_at).toBe(before[0]!.ready_at);
    expect(batch.through_seq).toBe(
      h.journal.sourceThroughSeq(h.journal.ensureOneBot(h.bindingId)!.id),
    );
    const claimed = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    h.wakes.complete(
      claimed.id,
      claimed.leaseToken!,
      "no_output",
      h.journal.sourceThroughSeq(claimed.conversationId),
      h.now(),
    );
    // 结算后的新事件形成新机会，旧批次不挡。
    h.clock.seconds += 1;
    h.receive("13", 20013);
    expect(h.rows().filter((r) => r.status === "pending")).toHaveLength(1);
  });
  it("recovery coalesces each participant's latest retained source into the batch opportunity", () => {
    const h = setup();
    receiveBatch(h, 10, 1, false);
    h.clock.seconds++;
    h.adapter.sweep();
    expect(h.rows()).toHaveLength(1);
    expect(h.wakes.claim({ at: h.now(), leaseMs: 120000 })).not.toBeNull();
    const original = h.rows();
    h.adapter.sweep();
    expect(h.rows()).toEqual(original);
  });
  it("a later arrival during a leased batch forms its own segment instead of merging", () => {
    const h = setup();
    receiveBatch(h, 10, 1);
    h.clock.seconds += 15;
    const one = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    h.clock.seconds += 1;
    h.receive("11", 20004);
    expect(h.rows().filter((r) => r.status === "pending")).toHaveLength(1);
    expect(h.rows().find((r) => r.id !== one.id)!.through_seq).toBe(
      h.journal.sourceThroughSeq(h.journal.ensureOneBot(h.bindingId)!.id),
    );
    h.wakes.complete(
      one.id,
      one.leaseToken!,
      "no_output",
      h.journal.sourceThroughSeq(one.conversationId),
      h.now(),
    );
    expect(h.wakes.claim({ at: h.now(), leaseMs: 120000 })?.throughSeq).toBe(
      h.journal.sourceThroughSeq(h.journal.ensureOneBot(h.bindingId)!.id),
    );
  });
  it("completing a batch never silently consumes sources beyond its frozen through_seq", () => {
    const h = setup();
    receiveBatch(h, 10, 1);
    h.clock.seconds += 15;
    const one = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    h.wakes.complete(
      one.id,
      one.leaseToken!,
      "no_output",
      h.journal.sourceThroughSeq(one.conversationId),
      h.now(),
    );
    // 结算后同会话新到达：新事件键、新批次机会（旧 dedupe 键不挡）。
    h.clock.seconds += 1;
    h.receive("11", 20004);
    expect(h.rows().filter((r) => r.status === "pending")).toHaveLength(1);
  });
  it("expired sources do not become newly restored opportunities", () => {
    const h = setup();
    receiveBatch(h, 10, 1, false);
    h.db.exec("UPDATE qq_observation_text SET expires_at='2000-01-01T00:00:00.000Z'");
    h.adapter.sweep();
    expect(h.rows()).toEqual([]);
    expect(h.notifications).toBe(0);
  });
});

describe("chiming time window (A60/B20 alongside count X15/Y5)", () => {
  const timeOn = { initiative_time_window_enabled: true } as const;
  /** 冷场安静门槛压到 1 分钟，好让「已经安静」与「自主窗口还没到下界」同时成立。 */
  const quietEnough = { initiative_time_window_enabled: true } as const;
  /** 下界 100s：t+60 已安静但时间窗未成熟，t+100 已成熟，两次观察同一个占位。 */
  const slowTimeOn = {
    initiative_time_window_enabled: true,
    initiative_time_target_seconds: 120,
    initiative_time_jitter_seconds: 20,
  } as const;
  it("time alone readies the batch at the lower bound without reaching the count lower bound", () => {
    const h = setup(false, { rhythm: timeOn });
    h.receive("1", 20002);
    const [armed] = h.rows();
    // 一条远低于条数下界(10)，但时间窗下界(40s)把它排进同一个合并机会。
    expect(armed).toBeDefined();
    expect(armed!.cause).toBe("chiming_in");
    expect(armed!.ready_at).toBe(new Date((time + 40) * 1000).toISOString());
    expect(
      h.wakes.claim({ at: new Date((time + 39) * 1000).toISOString(), leaseMs: 60000 }),
    ).toBeNull();
    h.clock.seconds = time + 40;
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })?.id).toBe(armed!.id);
  });
  it("a mature time window readies the batch with no new inbound message", () => {
    const h = setup(false, { rhythm: timeOn });
    h.receive("1", 20002);
    const armed = h.rows()[0]!;
    // 判定时刻与边界在领取时推进；此处只证明"到点可判"不依赖又一条入站消息。
    h.clock.seconds = time + 40;
    const claimed = h.wakes.claim({ at: h.now(), leaseMs: 60000 })!;
    const conversation = h.journal.ensureOneBot(h.bindingId)!;
    h.journal.markChimingInJudged(conversation.id, claimed.throughSeq, h.now());
    h.wakes.complete(claimed.id, claimed.leaseToken!, "no_output", claimed.throughSeq, h.now());
    h.receive("2", 20003);
    const next = h.rows().find((r) => r.id !== armed.id)!;
    // 刚判完的这一轮不能因为时间已过去 40s 立刻再判：锚取较晚的那个（判定时刻）。
    expect(next.ready_at).toBe(new Date((time + 40 + 40) * 1000).toISOString());
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })).toBeNull();
  });
  it("time OFF keeps the pre-0055 behaviour: a low count never readies a judgement", () => {
    const h = setup(false, { rhythm: { initiative_time_window_enabled: false } });
    h.receive("1", 20002);
    expect(h.rows()).toEqual([]);
    h.clock.seconds = time + 600;
    h.adapter.sweep();
    expect(h.rows()).toEqual([]);
    receiveBatch(h, 9, 2);
    const [armed] = h.rows();
    expect(armed!.ready_at).toBe(h.now());
  });
  it("count maturity readies the same wake earlier than the time lower bound", () => {
    const h = setup(false, { rhythm: timeOn });
    receiveBatch(h, 10);
    const [armed] = h.rows();
    expect(armed!.cause).toBe("chiming_in");
    // 条数已够就立刻可领，不因为时间窗还没到下界而压后。
    expect(armed!.ready_at).toBe(h.now());
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })?.id).toBe(armed!.id);
  });
  it("the upper bound with no model slot skips the batch without waiting for new input", () => {
    const h = setup(false, { rhythm: timeOn });
    h.db.exec("UPDATE qq_schemes SET initiative_queue_on_busy=0");
    const busyAdapter = new OneBot11Adapter({
      orm: h.orm,
      journal: h.journal,
      wakes: h.wakes,
      nowSeconds: () => h.clock.seconds,
      admission: { available: () => false },
    });
    const receiveWith = (id: string, seconds: number, speaker: number) => {
      h.clock.seconds = seconds;
      recordInbound(
        h.orm,
        normalizeOneBotMessage(
          {
            post_type: "message",
            message_type: "group",
            sub_type: "normal",
            time: seconds,
            self_id: 10001,
            user_id: speaker,
            group_id: 30003,
            message_id: id,
            message: [{ type: "text", data: { text: "synthetic" } }],
            sender: { nickname: "synthetic" },
          },
          "10001",
        ),
        { accountId: "10001", conversationIngress: busyAdapter },
      );
    };
    receiveWith("1", time, 20002);
    expect(h.rows()[0]!.status).toBe("pending");
    // 到上界(80s)仍无名额，且期间没有新消息：扫尾按同一策略显式跳过并消费边界。
    h.clock.seconds = time + 80;
    busyAdapter.sweep();
    const settled = h.rows()[0]!;
    expect(settled.status).toBe("no_output");
    expect(settled.error_code).toBe("BATCH_SKIPPED_BUSY");
    const conversation = h.journal.ensureOneBot(h.bindingId)!;
    expect(h.journal.chimingInObservedSeq(conversation.id)).toBe(
      h.journal.sourceThroughSeq(conversation.id),
    );
    // 跳过不是有效判定：判定时刻不写，时间窗因此不从此刻重计。
    expect(h.journal.chimingInJudgedAt(conversation.id)).toBeNull();
  });
  it("only a mature autonomous opportunity is a pending candidate that blocks the idle sweep", () => {
    const h = setup(false, { rhythm: slowTimeOn });
    h.receive("1", 20002);
    const armed = h.rows()[0]!;
    // 120±20 的下界是 t+100。
    expect(armed.ready_at).toBe(new Date((time + 100) * 1000).toISOString());
    h.db.exec("UPDATE qq_schemes SET trigger_idle_topic=1,idle_quiet_minutes=1");
    // t+61：会话已安静 1 分钟（冷场前提成立），但自主窗口还差 39 秒才成熟。此时那条占位
    // 不是真实待办，不能把这间会话判成 candidate_pending。
    h.clock.seconds = time + 61;
    const early = h.adapter.sweep(h.clock.seconds)!;
    expect(early.skipped.find((s) => s.conversationKey.includes("30003"))?.reason).not.toBe(
      "candidate_pending",
    );
    expect(early.scheduled.some((s) => s.conversationKey.includes("30003"))).toBe(true);
    expect(h.rows().some((r) => r.cause === "idle_topic")).toBe(true);
    // t+100：同一条占位已到判定时刻，它就是真实待办，冷场应当让位。
    h.clock.seconds = time + 100;
    const mature = h.adapter.sweep(h.clock.seconds)!;
    expect(mature.skipped.find((s) => s.conversationKey.includes("30003"))?.reason).toBe(
      "candidate_pending",
    );
    expect(quietEnough.initiative_time_window_enabled).toBe(true);
  });
  it("a valid judgement re-anchors the next unarmed window so the same messages are not judged twice", () => {
    const h = setup(false, { rhythm: timeOn });
    const conversation = h.journal.ensureOneBot(h.bindingId)!;
    // 稀疏群：一条消息就由时间窗排出一批（条数远未到下界）。
    h.receive("1", 20002);
    const first = h.rows()[0]!;
    expect(first.ready_at).toBe(new Date((time + 40) * 1000).toISOString());
    h.clock.seconds = time + 40;
    const claimed = h.wakes.claim({ at: h.now(), leaseMs: 60000 })!;
    // 判定途中又到一条：下一批 arm 时锚还是最早那条合格消息，ready_at 因此已经过期。
    h.clock.seconds = time + 45;
    h.receive("2", 20003);
    const armed = h.rows().find((r) => r.status === "pending")!;
    expect(armed.id).not.toBe(claimed.id);
    // 第一批的有效判定发生在下一批的旧 deadline 之后：游标与判定时刻同事务推进，
    // 随后本批按原语义结算（会话内串行由租约保证，同一时刻只有一条在飞）。
    const judgedAtSeconds = time + 100;
    h.clock.seconds = judgedAtSeconds;
    h.journal.markChimingInJudged(conversation.id, claimed.throughSeq, h.now());
    // 租约在领取后 60s 到期，所以这批的结算必须落在租约内；判定时刻仍是 tJ。
    h.clock.seconds = judgedAtSeconds - 1;
    h.wakes.complete(claimed.id, claimed.leaseToken!, "no_output", claimed.throughSeq, h.now());
    h.clock.seconds = judgedAtSeconds;
    // 扫尾按当前锚重排：等待中的机会顺延到判定时刻 + 下界，不会被旧 deadline 立刻领走。
    h.adapter.sweep(h.clock.seconds);
    const rearmed = h.rows().find((r) => r.status === "pending")!;
    expect(rearmed.id).toBe(armed.id);
    expect(rearmed.ready_at).toBe(new Date((judgedAtSeconds + 40) * 1000).toISOString());
    expect(
      h.wakes.claim({ at: new Date((judgedAtSeconds + 39) * 1000).toISOString(), leaseMs: 60000 }),
    ).toBeNull();
    h.clock.seconds = judgedAtSeconds + 40;
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })?.id).toBe(armed.id);
  });
  it("the count dimension still preempts a re-anchored time window", () => {
    const h = setup(false, { rhythm: timeOn });
    const conversation = h.journal.ensureOneBot(h.bindingId)!;
    h.receive("1", 20002);
    h.clock.seconds = time + 40;
    const claimed = h.wakes.claim({ at: h.now(), leaseMs: 60000 })!;
    h.clock.seconds = time + 45;
    h.receive("2", 20003);
    const judgedAtSeconds = time + 100;
    h.clock.seconds = judgedAtSeconds;
    h.journal.markChimingInJudged(conversation.id, claimed.throughSeq, h.now());
    h.clock.seconds = judgedAtSeconds - 1;
    h.wakes.complete(claimed.id, claimed.leaseToken!, "no_output", claimed.throughSeq, h.now());
    h.clock.seconds = judgedAtSeconds;
    // 判定之后又攒够条数（下界 10）：条数窗成熟就不再等时间下界，扫尾不得把它推后。
    receiveBatch(h, 10, 20);
    h.adapter.sweep(h.clock.seconds);
    const ready = h.rows().filter((r) => r.status === "pending");
    // 判定后的那条输入已经自己 arm 了一条新机会（它属于下一批），所以这里要按它自己的
    // 锚判断是否条数成熟，而不是假设旧那条被复用。
    expect(ready.length).toBeGreaterThan(0);
    expect(ready.every((r) => Date.parse(r.ready_at) <= h.clock.seconds * 1000)).toBe(true);
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })).not.toBeNull();
  });
  it("count-only mode does not judge below the count lower bound after a valid judgement reset", () => {
    // X3/Y0 + 时间窗关闭：只有条数这一维，所以「低于下界」必须真的不能判。
    const h = setup(false, {
      rhythm: {
        initiative_time_window_enabled: false,
        initiative_batch_target_count: 3,
        initiative_batch_jitter_count: 0,
      },
    });
    const conversation = h.journal.ensureOneBot(h.bindingId)!;
    receiveBatch(h, 3);
    const first = h.wakes.claim({ at: h.now(), leaseMs: 60000 })!;
    expect(first.cause).toBe("chiming_in");
    // 第一批判定期间又到一条：它借用旧批次的计数，立刻形成一条 ready 的下一批。
    h.clock.seconds = time + 5;
    h.receive("4", 20004);
    const armed = h.rows().find((r) => r.status === "pending")!;
    expect(armed.id).not.toBe(first.id);
    expect(armed.ready_at).toBe(h.now());
    const judgedAtSeconds = time + 20;
    h.clock.seconds = judgedAtSeconds;
    h.journal.markChimingInJudged(conversation.id, first.throughSeq, h.now());
    h.wakes.complete(
      first.id,
      first.leaseToken!,
      "no_output",
      first.throughSeq,
      new Date((judgedAtSeconds - 1) * 1000).toISOString(),
    );
    // 判定之后实际只剩 1 条未判消息，低于下界 3：扫尾必须让它退出可领集合。
    expect(h.journal.chimingInObservedSeq(conversation.id)).toBe(first.throughSeq);
    h.adapter.sweep(h.clock.seconds);
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })).toBeNull();
    // 关闭不是判定也不是消费：游标与判定时刻都没动，那条消息仍然计入。
    expect(h.journal.chimingInObservedSeq(conversation.id)).toBe(first.throughSeq);
    expect(h.journal.chimingInJudgedAt(conversation.id)).toBe(
      new Date(judgedAtSeconds * 1000).toISOString(),
    );
    const closed = h.rows().find((r) => r.id === armed.id)!;
    expect(closed.status).toBe("no_output");
    expect(closed.error_code).toBe("BATCH_WAITING_FOR_COUNT");
    // 再来两条：计数重新累加到下界，形成且仅形成一条成熟机会。
    receiveBatch(h, 2, 5);
    const mature = h.rows().filter((r) => r.status === "pending");
    expect(mature).toHaveLength(1);
    expect(mature[0]!.id).not.toBe(armed.id);
    expect(mature[0]!.ready_at).toBe(h.now());
    const claimed = h.wakes.claim({ at: h.now(), leaseMs: 60000 })!;
    expect(claimed.id).toBe(mature[0]!.id);
    expect(h.rows().filter((r) => r.status === "leased")).toHaveLength(1);
  });
  it("an immature count-only opportunity is never claimable while the time window is off", () => {
    const h = setup(false, {
      rhythm: {
        initiative_time_window_enabled: false,
        initiative_batch_target_count: 3,
        initiative_batch_jitter_count: 0,
      },
    });
    receiveBatch(h, 2);
    expect(h.rows()).toEqual([]);
    h.clock.seconds += 600;
    h.adapter.sweep();
    expect(h.rows()).toEqual([]);
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })).toBeNull();
  });
});
describe("continuous rolling windows", () => {
  it("a member message rolls its own deadline to arrival+merge without requiring earlier assistant speech", () => {
    const h = setup(true);
    h.receive("1", 20002);
    const rows = h.rows();
    expect(rows.map((r) => r.cause)).toEqual(["follow_up"]);
    expect(rows[0]!.ready_at).toBe(new Date((time + 15) * 1000).toISOString());
  });
  it("another member's later message does not postpone an existing window; the same member extends it", () => {
    const h = setup(true);
    h.receive("1", 20002);
    const before = h.rows();
    h.clock.seconds += 14;
    h.receive("2", 20003);
    h.receive("3", 20004);
    const after = h.rows();
    const first = after.find((r) => r.id === before[0]!.id)!;
    // 20003/20004 的到达不推迟 20002 自己的窗口。
    expect(first.ready_at).toBe(before[0]!.ready_at);
    // 20002 自己在 time+20 的新到达把他的窗口顺延到 20+15。
    h.clock.seconds += 6;
    h.receive("4", 20002);
    const own = h.rows().find((r) => r.id === before[0]!.id)!;
    expect(own.dedupe_key).toBe(before[0]!.dedupe_key);
    expect(own.ready_at).toBe(new Date((time + 20 + 15) * 1000).toISOString());
    expect(h.wakes.nextReadyAt()).toBe(new Date((time + 14 + 15) * 1000).toISOString());
  });
  it("an addressed event with direct_reply off merges into continuous instead of being dropped", () => {
    const h = setup(true);
    h.receive("1", 20002);
    h.db.exec(`UPDATE qq_bindings SET trigger_direct_reply=0 WHERE id='${h.bindingId}'`);
    h.clock.seconds += 1;
    h.receiveMention("2", 20002);
    const rows = h.rows();
    expect(rows.map((r) => r.cause)).toEqual(["follow_up"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ready_at).toBe(new Date((time + 1 + 15) * 1000).toISOString());
    expect(rows[0]!.through_seq).toBe(h.journal.ensureOneBot(h.bindingId)!.lastSeq);
  });
});

describe("chiming batch gating (production X15/Y5)", () => {
  it("below lower(10) no judge opportunity; reaching lower forms one coalesced wake", () => {
    const h = setup(false, { rhythm: { initiative_time_window_enabled: false } });
    receiveBatch(h, 9);
    expect(h.rows()).toEqual([]);
    receiveBatch(h, 1, 10);
    const rows = h.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cause).toBe("chiming_in");
    expect(rows[0]!.status).toBe("pending");
    // 合并机会的 throughSeq 是最后一条合格事件的 journal seq，不是条数。
    const c = h.journal.ensureOneBot(h.bindingId)!;
    expect(rows[0]!.through_seq).toBe(h.journal.sourceThroughSeq(c.id));
  });
  it("addressed events belong to direct reply and never count into the batch", () => {
    const h = setup(false, { rhythm: { initiative_time_window_enabled: false } });
    receiveBatch(h, 9);
    h.receiveMention("99", 20008);
    // 9 条普通 + 1 条指名 = 指名那条不计数（direct 独占），仍未到下界。
    expect(h.rows().filter((r) => r.cause === "chiming_in")).toEqual([]);
    receiveBatch(h, 1, 10);
    expect(h.rows().filter((r) => r.cause === "chiming_in")).toHaveLength(1);
  });
  it("direct off: addressed events stay eligible and count toward the batch lower bound", () => {
    const h = setup(false, { rhythm: { initiative_time_window_enabled: false } });
    h.db.exec(`UPDATE qq_bindings SET trigger_direct_reply=0 WHERE id='${h.bindingId}'`);
    receiveBatch(h, 9);
    h.receiveMention("99", 20008);
    // direct 关闭：被指名事件不被直接回应处理，计入自主批计数 → 第 10 条合格事件到达下界。
    expect(h.rows().filter((r) => r.cause === "chiming_in")).toHaveLength(1);
  });
  it("a direct_handled source never counts even when direct is off afterwards", () => {
    const h = setup(false, { rhythm: { initiative_time_window_enabled: false } });
    // direct 先开启：9 条普通 + 1 条指名（direct 机会真实存在），再关闭 direct。
    receiveBatch(h, 9);
    h.receiveMention("99", 20008);
    expect(h.rows().filter((r) => r.cause === "direct_reply")).toHaveLength(1);
    h.db.exec(`UPDATE qq_bindings SET trigger_direct_reply=0 WHERE id='${h.bindingId}'`);
    receiveBatch(h, 1, 10);
    // 指名那条已有 direct 机会覆盖（handled 事实），不计入自主批 → 计数仍 9+1(新普通)=10? 不：
    // 9 普通 + 新 1 普通 = 10 → 达下界；被 direct 覆盖的指名事件不计。等等：10 = 9 + 1 新 → 达标。
    const rows = h.rows().filter((r) => r.cause === "chiming_in");
    expect(rows).toHaveLength(1);
  });

  it("busy ON keeps an unclaimed coalesced wake; the resource gate blocks claim until admission frees", async () => {
    const h = setup(false, { rhythm: { initiative_time_window_enabled: false } });
    let judgeModelAsked: string | undefined;
    const bounded = new OneBot11Adapter({
      orm: h.orm,
      journal: h.journal,
      wakes: h.wakes,
      nowSeconds: () => h.clock.seconds,
      admission: {
        available: (model) => {
          judgeModelAsked = model;
          return false;
        },
      },
    });
    receiveBatch(h, 19);
    h.clock.seconds += 1;
    // 第 20 条（上界）经「无名额」入口到达：gate 提示按判断模型取——settings 未设判断模型
    // 且助手行无模型名时为 undefined（provider key 由准入侧 keyOf 归一，不在这里猜）。
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: h.clock.seconds,
          self_id: 10001,
          user_id: 20014,
          group_id: 30003,
          message_id: "20",
          message: [{ type: "text", data: { text: "synthetic" } }],
          sender: { nickname: "synthetic" },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: bounded },
    );
    const rows = h.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    // 上界无名额：边界不消费，机会保持未领取。
    const c = h.journal.ensureOneBot(h.bindingId)!;
    expect(h.journal.chimingInObservedSeq(c.id)).toBe(0);
    expect(judgeModelAsked).toBe("synthetic");
    // scheduler 的资源闸在领取前拦下 chiming，不烧 attempts。
    const scheduler = new WakeScheduler({
      repository: h.wakes,
      policy: () => ({ leaseMs: 60000, renewMs: 15000, retryDelayMs: 1000, maxAttempts: 3 }),
      now: h.now,
      resourceGate: (wake) => wake.cause !== "chiming_in",
      activate: async () => {
        throw new Error("must not activate while gated");
      },
    });
    expect(await scheduler.runOnce()).toBe(false);
    expect(h.rows()[0]!.status).toBe("pending");
    // 闸放开后同一条机会可以被领取。
    const schedulerOpen = new WakeScheduler({
      repository: h.wakes,
      policy: () => ({ leaseMs: 60000, renewMs: 15000, retryDelayMs: 1000, maxAttempts: 3 }),
      now: h.now,
      resourceGate: () => true,
      activate: async () => ({}),
    });
    expect(await schedulerOpen.runOnce()).toBe(true);
    expect(h.rows()[0]!.status).toBe("leased");
  });
  it("busy OFF at the upper bound consumes the boundary in the offer transaction", () => {
    const h = setup(false, { rhythm: { initiative_time_window_enabled: false } });
    h.db.exec("UPDATE qq_schemes SET initiative_queue_on_busy=0");
    const offers: { code: string; status: string; details?: Record<string, unknown> }[] = [];
    const bounded = new OneBot11Adapter({
      orm: h.orm,
      journal: h.journal,
      wakes: h.wakes,
      nowSeconds: () => h.clock.seconds,
      admission: { available: () => false },
      telemetry: {
        record: (name: string, metadata: Record<string, unknown>) => {
          if (name === "bot.wake.offer")
            offers.push({
              code: String(metadata.code),
              status: String(metadata.status),
              details: metadata.details as Record<string, unknown> | undefined,
            });
        },
        start: (() => undefined) as never,
      } as never,
    });
    receiveBatch(h, 19);
    h.clock.seconds += 1;
    // 第 20 条（上界）经「无名额」入口到达：OFF 在 offer 事务内显式消费本批边界。
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: h.clock.seconds,
          self_id: 10001,
          user_id: 20014,
          group_id: 30003,
          message_id: "20",
          message: [{ type: "text", data: { text: "synthetic" } }],
          sender: { nickname: "synthetic" },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: bounded },
    );
    const c = h.journal.ensureOneBot(h.bindingId)!;
    // 显式跳过并消费本批边界：同事务 coalesce→skipPending→advance。
    expect(h.journal.chimingInObservedSeq(c.id)).toBe(h.journal.sourceThroughSeq(c.id));
    const skip = offers.find((o) => o.code === "BATCH_SKIPPED_BUSY");
    expect(skip?.status).toBe("skipped");
    // 持久台账：原 pending 机会结算为 no_output+BATCH_SKIPPED_BUSY，attempts 不增，无残留 pending。
    const settled = h.rows().filter((r) => r.cause === "chiming_in");
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe("no_output");
    expect(settled[0]!.error_code).toBe("BATCH_SKIPPED_BUSY");
    expect(settled[0]!.attempts).toBe(0);
    expect(settled[0]!.through_seq).toBe(h.journal.sourceThroughSeq(c.id));
  });
  it("a busy provider does not block another conversation whose judge provider is free (no HOL)", async () => {
    const h = setup(false, { rhythm: { initiative_time_window_enabled: false } });
    // 第二个绑定/会话：独立 scheme 命名，同一 account。
    receiveBatch(h, 10);
    receiveBatch(h, 10, 100);
    // 两个会话各有一条 pending chiming；gate 只放行 conversation id 字典序较大的那条
    //（模拟 A 会话 provider 繁忙、B 会话空闲），scheduler 必须跳过被闸者精确领放行者。
    const cids = [...new Set(h.rows().map((r) => JSON.stringify([r.cause, r.status])))];
    expect(cids).toEqual([JSON.stringify(["chiming_in", "pending"])]);
    // 两个会话需要两个 binding；setup 只建一个，这里直接为第二会话复制一条 binding+conversation。
    const h2bindingId = crypto.randomUUID();
    h.db
      .query(
        "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group','30004',?,?,?,?)",
      )
      .run(
        h2bindingId,
        DEFAULT_AGENT_ID,
        (
          h.db.query("SELECT scheme_id FROM qq_bindings WHERE id=?").get(h.bindingId) as {
            scheme_id: string;
          }
        ).scheme_id,
        new Date(time * 1000).toISOString(),
        new Date(time * 1000).toISOString(),
      );
    const firstConversationId = h.journal.ensureOneBot(h.bindingId)!.id;
    const secondConversationId = h.journal.ensureOneBot(h2bindingId)!.id;
    // 第二会话也攒满一批。
    for (let i = 1; i <= 10; i += 1)
      recordInbound(
        h.orm,
        normalizeOneBotMessage(
          {
            post_type: "message",
            message_type: "group",
            sub_type: "normal",
            time: h.clock.seconds,
            self_id: 10001,
            user_id: 20000 + ((i % 13) + 1),
            group_id: 30004,
            message_id: String(300 + i),
            message: [{ type: "text", data: { text: "synthetic" } }],
            sender: { nickname: "synthetic" },
          },
          "10001",
        ),
        { accountId: "10001", conversationIngress: h.adapter },
      );
    expect(h.rows().filter((r) => r.status === "pending")).toHaveLength(2);
    // gate：只放行第二会话的 chiming（其判断 provider 空闲）。
    const scheduler = new WakeScheduler({
      repository: h.wakes,
      policy: () => ({ leaseMs: 60000, renewMs: 15000, retryDelayMs: 1000, maxAttempts: 3 }),
      now: h.now,
      resourceGate: (wake) => wake.conversationId === secondConversationId,
      activate: async () => ({}),
    });
    expect(await scheduler.runOnce()).toBe(true);
    const leased = h.rows().filter((r) => r.status === "leased");
    expect(leased).toHaveLength(1);
    expect(leased[0]!.dedupe_key).toContain(secondConversationId);
    // 被闸的第一会话机会保持 pending，不烧 attempts。
    const gatedPending = h
      .rows()
      .filter((r) => r.status === "pending" && r.dedupe_key.includes(firstConversationId));
    expect(gatedPending).toHaveLength(1);
    expect(gatedPending[0]!.attempts).toBe(0);
  });
  it("a direct reply's consumed cursor does not swallow another member's pending continuous source", () => {
    const h = setup(true);
    h.receive("1", 20002);
    h.clock.seconds += 15;
    const first = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    expect(first.cause).toBe("follow_up");
    h.wakes.complete(
      first.id,
      first.leaseToken!,
      "no_output",
      h.journal.sourceThroughSeq(first.conversationId),
      h.now(),
    );
    // 暂停期间到达的事件只入 journal、不形成机会；恢复后其 source 仍欠一次连续应答。
    h.db.exec(`UPDATE qq_bindings SET paused=1 WHERE id='${h.bindingId}'`);
    h.receive("2", 20003);
    h.receive("3", 20004);
    h.db.exec(`UPDATE qq_bindings SET paused=0 WHERE id='${h.bindingId}'`);
    // 另一人随后的 direct 结算把全局 consumed cursor 推过被跳过的 seq。
    h.clock.seconds += 1;
    h.receiveMention("4", 20005);
    h.clock.seconds += 15;
    const direct = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    expect(direct.cause).toBe("direct_reply");
    h.wakes.complete(
      direct.id,
      direct.leaseToken!,
      "no_output",
      h.journal.sourceThroughSeq(direct.conversationId),
      h.now(),
    );
    // 恢复扫描：20003 的连续源没有自己的 wake，也不该被全局 cursor 吞掉。
    h.adapter.sweep();
    const resumed = h.rows().filter((r) => r.cause === "follow_up" && r.status === "pending");
    expect(resumed.length).toBeGreaterThanOrEqual(1);
  });
});

it("even repeated producer notifications yield to timers while the transport is offline", async () => {
  let worker: BotWorker,
    cycles = 0,
    timerRan = false;
  let stopped: Promise<void> | undefined;
  const done = new Promise<void>((resolve) =>
    setTimeout(() => {
      timerRan = true;
      void worker.stop().then(resolve);
    }, 0),
  );
  worker = new BotWorker({
    canAdvance: () => false,
    sweep() {
      worker.wake();
      if (++cycles === 100) stopped = worker.stop();
    },
    advance: async () => {},
  });
  worker.start();
  await done;
  await stopped;
  expect(timerRan).toBe(true);
  expect(cycles).toBeLessThan(100);
});
