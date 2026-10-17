import { afterEach, describe, expect, it } from "bun:test";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import {
  qqChimingBatchWindow,
  qqParticipationTimingOf,
} from "../../src/server/services/qq-chiming-time-window";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const time = 2_000_000_000;

/**
 * §5.5 停顿优先（quiet_preferred）批次的集成关注点。基准：X5/Y2（下界 3、上界 7）、
 * A40/B20（下界 20、上界 60）、M=15；各用例按需覆盖。模式在 fixture 里显式钉住
 * quiet_preferred，不随 QQ_RHYTHM_DEFAULT 的缺省值漂移。
 */
function setup(
  overrides: { rhythm?: Partial<typeof QQ_RHYTHM_DEFAULT>; admission?: boolean } = {},
) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "synthetic");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "participation-timing",
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      merge_window_seconds: 15,
      judgement_interval_turns: 1,
      initiative_batch_target_count: 5,
      initiative_batch_jitter_count: 2,
      initiative_time_target_seconds: 40,
      initiative_time_jitter_seconds: 20,
      participation_timing: "quiet_preferred",
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
  const receive = (id: string, speaker = 20002) =>
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
      { accountId: "10001", conversationIngress: adapter },
    );
  const receiveImage = (id: string, speaker = 20002) =>
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
          message: [{ type: "image", data: { file: `synthetic-${id}.png` } }],
          sender: { nickname: String(speaker) },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: adapter },
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
  const receiveFace = (id: string, speaker = 20002) =>
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
          message: [{ type: "face", data: { id: "13" } }],
          sender: { nickname: String(speaker) },
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
      attempts: number;
      source_from_seq: number | null;
      error_code: string | null;
    }[];
  const chimingRows = () => rows().filter((r) => r.cause === "chiming_in");
  return {
    ...h,
    bindingId,
    clock,
    journal,
    wakes,
    adapter,
    receive,
    receiveImage,
    receiveMention,
    receiveFace,
    now,
    rows,
    chimingRows,
    get notifications() {
      return notifications;
    },
  };
}

describe("quiet_preferred window (pure)", () => {
  const quietRhythm = {
    ...QQ_RHYTHM_DEFAULT,
    initiative_batch_target_count: 5,
    initiative_batch_jitter_count: 2,
    initiative_time_target_seconds: 40,
    initiative_time_jitter_seconds: 20,
  };
  it("waits for the later of resource lower bound and speech gap, not their sum", () => {
    const base = {
      rhythm: quietRhythm,
      count: 1,
      firstEligibleSeconds: 100,
      judgedAtSeconds: null,
      participationTiming: "quiet_preferred" as const,
    };
    // 下界 120 vs 停顿 100+30=130：取较晚，不串联成 150。
    expect(
      qqChimingBatchWindow({ ...base, latestHumanSeconds: 100, nowSeconds: 110 }),
    ).toMatchObject({ kind: "waiting", readyAtSeconds: 130, upperAtSeconds: 160, expired: false });
    // 下界 120 vs 停顿 118+30=148。
    expect(
      qqChimingBatchWindow({ ...base, latestHumanSeconds: 118, nowSeconds: 110 }),
    ).toMatchObject({ kind: "waiting", readyAtSeconds: 148 });
  });
  it("M=0 does not add a speech-gap wait beyond the resource window", () => {
    const base = {
      rhythm: { ...quietRhythm, merge_window_seconds: 0 },
      count: 3,
      firstEligibleSeconds: 100,
      judgedAtSeconds: null,
      participationTiming: "quiet_preferred" as const,
      latestHumanSeconds: 100,
    };
    expect(qqChimingBatchWindow({ ...base, nowSeconds: 110 })).toMatchObject({
      kind: "ready",
      condition: "count",
      upperAtSeconds: 160,
      expired: false,
    });
    // 对照：M=15 时同一时刻还在等话语停顿。条数已到下界，等待期限**只**是停顿门
    // （100+15=115），不与仍在未来的资源下界（120）取晚——count OR time 是原始口径。
    expect(
      qqChimingBatchWindow({
        ...base,
        rhythm: { ...base.rhythm, merge_window_seconds: 15 },
        nowSeconds: 110,
      }),
    ).toMatchObject({ kind: "waiting", readyAtSeconds: 115 });
  });
  it("the count upper readies now and overrides the merge gate", () => {
    const result = qqChimingBatchWindow({
      rhythm: { ...quietRhythm, merge_window_seconds: 300 },
      count: 7,
      firstEligibleSeconds: 100,
      judgedAtSeconds: null,
      latestHumanSeconds: 100,
      participationTiming: "quiet_preferred",
      nowSeconds: 105,
    });
    expect(result).toMatchObject({ kind: "ready", condition: "count", expired: true });
  });
  it("the time upper allows one judgement even when the merge gate is still open", () => {
    const result = qqChimingBatchWindow({
      rhythm: { ...quietRhythm, merge_window_seconds: 300 },
      count: 1,
      firstEligibleSeconds: 100,
      judgedAtSeconds: null,
      latestHumanSeconds: 100,
      participationTiming: "quiet_preferred",
      nowSeconds: 160,
    });
    expect(result).toMatchObject({ kind: "ready", condition: "time", expired: true });
  });
  it("time OFF counts only, still behind the merge gate; below the count lower bound there is no window", () => {
    const rhythm = {
      ...quietRhythm,
      initiative_time_window_enabled: false,
      merge_window_seconds: 15,
    };
    const base = {
      rhythm,
      count: 3,
      firstEligibleSeconds: 100,
      judgedAtSeconds: null,
      latestHumanSeconds: 100,
      participationTiming: "quiet_preferred" as const,
    };
    expect(qqChimingBatchWindow({ ...base, nowSeconds: 110 })).toMatchObject({
      kind: "waiting",
      readyAtSeconds: 115,
      upperAtSeconds: null,
    });
    expect(qqChimingBatchWindow({ ...base, nowSeconds: 115 })).toMatchObject({
      kind: "ready",
      condition: "count",
      upperAtSeconds: null,
    });
    expect(qqChimingBatchWindow({ ...base, count: 2, nowSeconds: 600 })).toMatchObject({
      kind: "none",
    });
  });
  it("a missing human-activity fact is never faked as a zero source", () => {
    // 合格输入存在但没有活动事实（调用面不可达）：停顿门按未过处理，绝不当作 M=0。
    const result = qqChimingBatchWindow({
      rhythm: { ...quietRhythm, merge_window_seconds: 0 },
      count: 3,
      firstEligibleSeconds: 100,
      judgedAtSeconds: null,
      latestHumanSeconds: null,
      participationTiming: "quiet_preferred",
      nowSeconds: 110,
    });
    expect(result.kind).toBe("waiting");
    expect(result).not.toHaveProperty("latestHumanSeconds");
    // 活动事实缺失＝停顿期限未知：期限退回当前时刻持续重评（不虚构，也不判 ready）。
    expect(result).toMatchObject({ readyAtSeconds: 110 });
  });
  it("a count-mature batch waits only for the quiet gate, not the future resource lower bound", () => {
    // 首条 100、最新 104（条数已到下界 3）、M=15：期限 119，而不是与时间下界 120 取晚。
    const result = qqChimingBatchWindow({
      rhythm: { ...quietRhythm, merge_window_seconds: 15 },
      count: 3,
      firstEligibleSeconds: 100,
      judgedAtSeconds: null,
      latestHumanSeconds: 104,
      participationTiming: "quiet_preferred",
      nowSeconds: 105,
    });
    expect(result).toMatchObject({ kind: "waiting", readyAtSeconds: 119, upperAtSeconds: 160 });
  });
  it("the quiet upper anchors at batch age and readies before the speech gap closes", () => {
    const base = {
      rhythm: { ...quietRhythm, merge_window_seconds: 15 },
      count: 1,
      firstEligibleSeconds: 100,
      judgedAtSeconds: null,
      latestHumanSeconds: 159,
      participationTiming: "quiet_preferred" as const,
    };
    // 上界锚 = max(firstEligible, judgedAt) = 100 → 上界 160，与最新活动无关。
    expect(qqChimingBatchWindow({ ...base, nowSeconds: 155 })).toMatchObject({
      kind: "waiting",
      readyAtSeconds: 160,
      upperAtSeconds: 160,
    });
    // 批次年龄到上界（160）即忙群一次判断可判，尽管停顿门要到 174。
    expect(qqChimingBatchWindow({ ...base, nowSeconds: 160 })).toMatchObject({
      kind: "ready",
      condition: "time",
      expired: true,
      upperAtSeconds: 160,
    });
  });
  it("no eligible material means no window even when humans are active", () => {
    expect(
      qqChimingBatchWindow({
        rhythm: quietRhythm,
        count: 0,
        firstEligibleSeconds: null,
        judgedAtSeconds: null,
        latestHumanSeconds: 100,
        participationTiming: "quiet_preferred",
        nowSeconds: 200,
      }),
    ).toMatchObject({ kind: "none" });
  });
  it("resource_window keeps its literal output shape without quiet fields", () => {
    const waiting = qqChimingBatchWindow({
      rhythm: quietRhythm,
      count: 1,
      firstEligibleSeconds: 100,
      judgedAtSeconds: null,
      nowSeconds: 110,
    });
    expect(waiting).toMatchObject({ kind: "waiting", readyAtSeconds: 120, upperAtSeconds: 160 });
    expect(waiting).not.toHaveProperty("latestHumanSeconds");
    const ready = qqChimingBatchWindow({
      rhythm: quietRhythm,
      count: 3,
      firstEligibleSeconds: 100,
      judgedAtSeconds: null,
      nowSeconds: 110,
    });
    expect(ready).toMatchObject({ kind: "ready", condition: "count" });
    expect(ready).not.toHaveProperty("latestHumanSeconds");
  });
  it("reads the mode off the rhythm with a legacy resource_window fallback", () => {
    expect(qqParticipationTimingOf({})).toBe("resource_window");
    expect(qqParticipationTimingOf({ participation_timing: "quiet_preferred" })).toBe(
      "quiet_preferred",
    );
    expect(() => qqParticipationTimingOf({ participation_timing: "bogus" })).toThrow(
      "participation_timing",
    );
  });
});

describe("quiet_preferred participation timing (X5/Y2, A40/B20, M15)", () => {
  it("waits for the speech gap taking the later deadline, and the sweep re-anchors the earliest coalesced wake", () => {
    const h = setup();
    h.receive("1", 20002);
    // 一条静止消息：资源下界 t+20 晚于停顿门 t+15，ready_at 取较晚的 t+20（不是相加的 t+35）。
    expect(h.chimingRows()[0]!.ready_at).toBe(new Date((time + 20) * 1000).toISOString());
    // 另一成员在 t+10 到达：停顿顺延到 t+25，但合并取最早，ready_at 仍是 t+20。
    h.clock.seconds = time + 10;
    h.receive("2", 20003);
    expect(h.chimingRows()).toHaveLength(1);
    expect(h.chimingRows()[0]!.ready_at).toBe(new Date((time + 20) * 1000).toISOString());
    // 扫尾按当前窗口重排：coalesce-earliest 留下的旧 deadline 被纠正到较晚的停顿门。
    h.clock.seconds = time + 11;
    h.adapter.sweep(h.clock.seconds);
    expect(h.chimingRows()[0]!.ready_at).toBe(new Date((time + 25) * 1000).toISOString());
    expect(
      h.wakes.claim({ at: new Date((time + 24) * 1000).toISOString(), leaseMs: 60000 }),
    ).toBeNull();
    h.clock.seconds = time + 25;
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })?.cause).toBe("chiming_in");
  });
  it("M=0 does not wait out a speech gap", () => {
    const h = setup({ rhythm: { merge_window_seconds: 0 } });
    h.receive("1", 20002);
    expect(h.chimingRows()[0]!.ready_at).toBe(new Date((time + 20) * 1000).toISOString());
    expect(
      h.wakes.claim({ at: new Date((time + 19) * 1000).toISOString(), leaseMs: 60000 }),
    ).toBeNull();
    h.clock.seconds = time + 20;
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })?.cause).toBe("chiming_in");
  });
  it("a pure expression postpones the deadline but never counts into eligibility", () => {
    const h = setup({ rhythm: { initiative_time_window_enabled: false } });
    h.receive("1", 20002);
    h.clock.seconds = time + 1;
    h.receiveFace("2", 20003);
    h.clock.seconds = time + 2;
    h.receive("3", 20004);
    // 纯表情被剔除：合格输入只有 2 条（< 下界 3），没有窗口。
    expect(h.chimingRows()).toEqual([]);
    h.clock.seconds = time + 3;
    h.receive("4", 20005);
    // 第 3 条合格输入就位：条数成熟，但停顿门按最新人类活动（t+3 的文本）计——t+18。
    expect(h.chimingRows()).toHaveLength(1);
    expect(h.chimingRows()[0]!.ready_at).toBe(new Date((time + 18) * 1000).toISOString());
  });
  it("an addressed member message is human activity even when direct owns it exclusively", () => {
    const h = setup();
    h.receive("1", 20002);
    h.clock.seconds = time + 10;
    h.receiveMention("2", 20003);
    // 被指名的 direct 行不计名额，但它是真实人类活动：停顿门顺延到 t+25，扫尾后生效。
    h.clock.seconds = time + 11;
    h.adapter.sweep(h.clock.seconds);
    expect(h.chimingRows()).toHaveLength(1);
    expect(h.chimingRows()[0]!.ready_at).toBe(new Date((time + 25) * 1000).toISOString());
    expect(h.rows().some((r) => r.cause === "direct_reply")).toBe(true);
  });
  it("own outbound speech does not reset the quiet clock", () => {
    const h = setup();
    h.receive("1", 20002);
    const conversation = h.journal.ensureOneBot(h.bindingId)!;
    h.clock.seconds = time + 10;
    // 与生产 outbound 事件同形的合成行（qq_speech source + agent participant）。
    h.journal.append({
      conversationId: conversation.id,
      eventKey: "outbound-probe:1",
      kind: "outbound",
      source: { kind: "qq_speech", id: crypto.randomUUID(), revision: "1" },
      participant: { id: DEFAULT_AGENT_ID, label: "synthetic", role: "agent" },
      occurredAt: h.now(),
      recordedAt: h.now(),
    });
    h.clock.seconds = time + 11;
    h.adapter.sweep(h.clock.seconds);
    expect(h.chimingRows()[0]!.ready_at).toBe(new Date((time + 20) * 1000).toISOString());
    h.clock.seconds = time + 20;
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })?.cause).toBe("chiming_in");
  });
  it("a media revision does not reset the quiet clock", () => {
    const h = setup();
    h.receiveImage("901", 20002);
    expect(h.chimingRows()[0]!.ready_at).toBe(new Date((time + 20) * 1000).toISOString());
    const { event_key: eventKey } = h.db
      .query("SELECT event_key FROM qq_events WHERE message_id='901'")
      .get() as { event_key: string };
    // 媒体重处理发生在 t+10：media_revision 行的 occurred_at 取 note 的 updated_at。
    h.clock.seconds = time + 10;
    h.db
      .query(
        "UPDATE qq_media_notes SET note='synthetic',note_model='fixture',updated_at=? WHERE event_key=?",
      )
      .run(h.now(), eventKey);
    const note = h.db.query("SELECT id FROM qq_media_notes WHERE event_key=?").get(eventKey) as {
      id: string;
    };
    h.journal.ingestMedia(note.id, h.bindingId);
    h.clock.seconds = time + 11;
    h.adapter.sweep(h.clock.seconds);
    expect(h.chimingRows()[0]!.ready_at).toBe(new Date((time + 20) * 1000).toISOString());
    h.clock.seconds = time + 20;
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })?.cause).toBe("chiming_in");
  });
  it("the count upper readies now and overrides the merge gate", () => {
    const h = setup({
      rhythm: { initiative_time_window_enabled: false, merge_window_seconds: 300 },
    });
    for (let i = 1; i <= 7; i += 1) h.receive(String(i), 20000 + ((i % 13) + 1));
    // 第 7 条到上界（7）：即使话语停顿门远未到（t+300），上界允许现在就判。
    expect(h.chimingRows()).toHaveLength(1);
    expect(h.chimingRows()[0]!.ready_at).toBe(h.now());
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })?.cause).toBe("chiming_in");
  });
  it("busy ON keeps the expired quiet wake without forcing a call", () => {
    const h = setup({
      rhythm: { initiative_time_window_enabled: false, merge_window_seconds: 300 },
      admission: false,
    });
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
    for (let i = 1; i <= 7; i += 1) h.receive(String(i), 20000 + ((i % 13) + 1));
    // 扫尾按同一窗口重查上界到期：准入被问到判断模型并返回不可用，繁忙 ON 保留机会，
    // 不消费边界、不强制调用——judgeModelAsked 在这里被捕获。
    bounded.sweep(h.clock.seconds);
    const conversation = h.journal.ensureOneBot(h.bindingId)!;
    expect(h.chimingRows()).toHaveLength(1);
    expect(h.chimingRows()[0]!.status).toBe("pending");
    expect(judgeModelAsked).toBe("synthetic");
    expect(h.journal.chimingInObservedSeq(conversation.id)).toBe(0);
    expect(h.notifications).toBeGreaterThan(0);
  });
  it("busy OFF at the quiet time upper skips and consumes the single cursor", () => {
    const h = setup({ rhythm: { merge_window_seconds: 300 } });
    h.db.exec("UPDATE qq_schemes SET initiative_queue_on_busy=0");
    const offers: { code: string; status: string }[] = [];
    const bounded = new OneBot11Adapter({
      orm: h.orm,
      journal: h.journal,
      wakes: h.wakes,
      nowSeconds: () => h.clock.seconds,
      admission: { available: () => false },
      telemetry: {
        record: (name: string, metadata: Record<string, unknown>) => {
          if (name === "bot.wake.offer")
            offers.push({ code: String(metadata.code), status: String(metadata.status) });
        },
        start: (() => undefined) as never,
      } as never,
    });
    h.receive("1", 20002);
    expect(h.chimingRows()[0]!.status).toBe("pending");
    // 停顿门（t+300）远未到，但时间上界（最新活动 t + 60）已过：忙群一次判断的名额到了，
    // 无名额且 queue OFF → 显式跳过并消费同一条游标；跳过不是判定，judged_at 不写。
    h.clock.seconds = time + 60;
    bounded.sweep(h.clock.seconds);
    const settled = h.chimingRows()[0]!;
    expect(settled.status).toBe("no_output");
    expect(settled.error_code).toBe("BATCH_SKIPPED_BUSY");
    const conversation = h.journal.ensureOneBot(h.bindingId)!;
    expect(h.journal.chimingInObservedSeq(conversation.id)).toBe(
      h.journal.sourceThroughSeq(conversation.id),
    );
    expect(h.journal.chimingInJudgedAt(conversation.id)).toBeNull();
    expect(offers.some((o) => o.code === "BATCH_SKIPPED_BUSY")).toBe(true);
  });
  it("both dimensions maturing at the same instant ready exactly one batch", () => {
    const h = setup({ rhythm: { merge_window_seconds: 20 } });
    h.receive("1", 20002);
    // 下界（t+20）与停顿门（t+20）同时成熟：一次就绪、一条机会，不出现第二个判定分支。
    expect(h.chimingRows()).toHaveLength(1);
    expect(h.chimingRows()[0]!.ready_at).toBe(new Date((time + 20) * 1000).toISOString());
    expect(
      h.wakes.claim({ at: new Date((time + 19) * 1000).toISOString(), leaseMs: 60000 }),
    ).toBeNull();
    h.clock.seconds = time + 20;
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })?.cause).toBe("chiming_in");
  });
  it("a count-mature batch waits only for the quiet gate, not the future resource lower bound", () => {
    const h = setup();
    // t/t+2/t+4 三条到下界（3），最新活动 t+4：期限 = t+4+15 = t+19，不被时间下界 t+20 压后。
    h.receive("1", 20002);
    h.clock.seconds = time + 2;
    h.receive("2", 20003);
    h.clock.seconds = time + 4;
    h.receive("3", 20004);
    expect(h.chimingRows()).toHaveLength(1);
    expect(h.chimingRows()[0]!.ready_at).toBe(new Date((time + 19) * 1000).toISOString());
    h.clock.seconds = time + 19;
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })?.cause).toBe("chiming_in");
  });
  it("the quiet upper anchors at batch age and readies before the speech gap closes", () => {
    const h = setup();
    // 首条 t（批次年龄锚），t+59 一条：上界 = t+60，停顿门 = t+59+15 = t+74。上界先到先判。
    h.receive("1", 20002);
    expect(h.chimingRows()[0]!.ready_at).toBe(new Date((time + 20) * 1000).toISOString());
    h.clock.seconds = time + 59;
    h.receive("2", 20003);
    // coalesce-earliest 先保留更早的占位；扫尾按当前窗口重排到上界。
    h.clock.seconds = time + 59;
    h.adapter.sweep(h.clock.seconds);
    expect(h.chimingRows()[0]!.ready_at).toBe(new Date((time + 60) * 1000).toISOString());
    expect(
      h.wakes.claim({ at: new Date((time + 59) * 1000).toISOString(), leaseMs: 60000 }),
    ).toBeNull();
    h.clock.seconds = time + 60;
    expect(h.wakes.claim({ at: h.now(), leaseMs: 60000 })?.cause).toBe("chiming_in");
  });
  it("a frozen claimed retry keeps its range; new input forms the next batch", () => {
    const h = setup({ rhythm: { initiative_time_window_enabled: false, merge_window_seconds: 0 } });
    for (let i = 1; i <= 3; i += 1) h.receive(String(i), 20000 + ((i % 13) + 1));
    const claimed = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    expect(claimed.cause).toBe("chiming_in");
    h.wakes.fail(claimed.id, claimed.leaseToken!, {
      at: h.now(),
      errorCode: "MODEL_FAILED",
      maxAttempts: 3,
      retryDelayMs: 15000,
    });
    const frozen = h.chimingRows().find((r) => r.id === claimed.id)!;
    expect(frozen.status).toBe("pending");
    expect(frozen.attempts).toBe(1);
    expect(frozen.source_from_seq).not.toBeNull();
    // 新输入绝不改写已冻结的重试范围：through_seq 与 attempts 原样，另起一条新机会。
    h.clock.seconds = time + 20;
    h.receive("4", 20014);
    const after = h.chimingRows();
    expect(after.find((r) => r.id === claimed.id)!.through_seq).toBe(claimed.throughSeq);
    expect(after.find((r) => r.id === claimed.id)!.attempts).toBe(1);
    expect(after.find((r) => r.id === claimed.id)!.source_from_seq).toBe(frozen.source_from_seq);
    const next = after.find((r) => r.id !== claimed.id)!;
    expect(next.status).toBe("pending");
    expect(next.ready_at).toBe(h.now());
  });
});
