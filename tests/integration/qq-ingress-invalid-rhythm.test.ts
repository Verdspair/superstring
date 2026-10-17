// 回归（ingress-observation-repair，2026-10-16）：本群差异随基础方案变化后，生效节奏可能不再
// 满足 B<A 契约；回复机会的调度失败不得回滚已收到的观察，也不得把存储失败误报成 duplicate。
import { afterEach, describe, expect, it } from "bun:test";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import {
  readQqGroupAgentConfig,
  updateQqGroupConfig,
} from "../../src/server/db/qq-group-config-repository";
import {
  createQqScheme,
  readQqScheme,
  schemeRhythm,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { AppError } from "../../src/server/errors";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { cloneBusinessDb } from "../harness/business-db";

const ACCOUNT_ID = "10001";
const GROUP_ID = 30003;
const SPEAKER_ID = "20002";

const handles: ReturnType<typeof cloneBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

/**
 * 真实生产组成（无 AgentRuntime/无模型）：clone 库 + 真设置/绑定/方案 + 真 OneBot11Adapter，
 * 经 recordInbound 收一条群消息。无效生效节奏的产生路径与真实保存路径一致：
 * 先保存对当前基础方案合法的抖动差异（B=40 < A=60），再把基础方案时间窗中心改成 25，
 * 使生效值 A=25 < B=40 —— 写边界当时校验过、组合后失效，属真实可达状态。
 */
function setup(options: { invalidRhythm?: boolean } = {}) {
  const invalidRhythm = options.invalidRhythm ?? true;
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT_ID, enabled: true, expectedRevision: 1 });
  // 固定秒级时钟：同一用例内重投递不跨秒，event 身份不因 occurredAtSeconds 漂移。
  const clock = Math.floor(Date.now() / 1000);

  const scheme = createQqScheme(h.orm, {
    name: "ingress-invalid-rhythm",
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
  });
  const bindingId = crypto.randomUUID();
  const now = new Date().toISOString();
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group',?,?,?,?,?)",
    )
    .run(bindingId, String(GROUP_ID), DEFAULT_AGENT_ID, scheme.id, now, now);

  if (invalidRhythm) {
    // 第一步：对当前基础方案（target 60）合法的差异 B=40。
    const binding = readQqBinding(h.orm, bindingId);
    if (!binding) throw new Error("missing binding");
    const schemeRow = readQqScheme(h.orm, scheme.id);
    if (!schemeRow) throw new Error("missing scheme");
    const current = readQqGroupAgentConfig(h.orm, binding);
    updateQqGroupConfig(h.orm, {
      bindingId,
      payload: {
        agent_id: binding.agentId,
        expected_binding_revision: binding.revision,
        expected_scheme_revision: schemeRow.revision,
        expected_revision: current.revision,
        overrides: { rhythm: { initiative_time_jitter_seconds: 40 } },
        disabled_capabilities: [],
      },
    });

    // 第二步：基础方案时间窗中心改 25 → 生效 A=25 < B=40，契约失效。
    const afterSave = readQqScheme(h.orm, scheme.id);
    if (!afterSave) throw new Error("missing scheme after save");
    updateQqScheme(h.orm, scheme.id, {
      name: afterSave.name,
      expectedRevision: afterSave.revision,
      rhythm: { ...schemeRhythm(afterSave), initiative_time_target_seconds: 25 },
    });
  }

  const adapter = new OneBot11Adapter({
    orm: h.orm,
    journal: new ConversationEventRepository(h.db),
    wakes: new WakeRepository(h.db),
  });

  const wakes = () =>
    (h.db.query("SELECT COUNT(*) AS n FROM wake_signals").get() as { n: number }).n;

  const makeNormalized = (
    messageId: number,
    addressed: boolean,
    text = "ordinary human message",
  ) => {
    const normalized = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        time: clock,
        self_id: 10001,
        user_id: Number(SPEAKER_ID),
        group_id: GROUP_ID,
        message_id: messageId,
        message: [
          ...(addressed ? [{ type: "at", data: { qq: ACCOUNT_ID } }] : []),
          { type: "text", data: { text } },
        ],
        sender: { nickname: SPEAKER_ID },
      },
      ACCOUNT_ID,
    );
    expect(normalized.kind).toBe("message");
    return normalized;
  };

  const receive = (messageId: number, addressed: boolean) =>
    recordInbound(h.orm, makeNormalized(messageId, addressed), {
      accountId: ACCOUNT_ID,
      conversationIngress: adapter,
    });

  const persisted = () => ({
    events: (h.db.query("SELECT COUNT(*) AS n FROM qq_events").get() as { n: number }).n,
    journal: (
      h.db.query("SELECT COUNT(*) AS n FROM conversation_events WHERE kind='inbound'").get() as {
        n: number;
      }
    ).n,
  });

  return {
    db: h.db,
    orm: h.orm,
    adapter,
    bindingId,
    schemeId: scheme.id,
    makeNormalized,
    receive,
    persisted,
    wakes,
  };
}

describe("qq ingress decouples reply scheduling from observation persistence", () => {
  it("records an invalid-rhythm ordinary message without any wake or autonomy activity", () => {
    const f = setup();
    const outcome = f.receive(70001, false);
    // 无效生效节奏只影响调度：观察照常落库，唤醒面没有任何活动。
    expect(outcome).toEqual({ kind: "recorded", recorded: true, hasText: true });
    expect(f.persisted()).toEqual({ events: 1, journal: 1 });
    expect(f.wakes()).toBe(0);
  });

  it("still offers a wake for a valid-config ordinary message", () => {
    // 合法组成（无无效节奏注入）：合法差异把批次名额降到 1，普通消息照常进入唤醒面。
    const plain = setup({ invalidRhythm: false });
    const binding = readQqBinding(plain.orm, plain.bindingId);
    if (!binding) throw new Error("missing binding");
    const schemeRow = readQqScheme(plain.orm, plain.schemeId);
    if (!schemeRow) throw new Error("missing scheme");
    const current = readQqGroupAgentConfig(plain.orm, binding);
    updateQqGroupConfig(plain.orm, {
      bindingId: plain.bindingId,
      payload: {
        agent_id: binding.agentId,
        expected_binding_revision: binding.revision,
        expected_scheme_revision: schemeRow.revision,
        expected_revision: current.revision,
        overrides: {
          rhythm: {
            initiative_batch_target_count: 1,
            initiative_batch_jitter_count: 0,
            initiative_time_window_enabled: false,
            merge_window_seconds: 0,
          },
        },
        disabled_capabilities: [],
      },
    });
    expect(plain.receive(71001, false)).toEqual({
      kind: "recorded",
      recorded: true,
      hasText: true,
    });
    expect(plain.wakes()).toBe(1);
  });

  it("reports a record-phase storage failure as failed, never duplicate, with no partial rows", () => {
    const f = setup();
    const calls: string[] = [];
    const outcome = recordInbound(f.orm, f.makeNormalized(72001, false, "storage failure"), {
      accountId: ACCOUNT_ID,
      conversationIngress: {
        beforeRecord: () => {
          throw new AppError("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
        },
        afterRecord: () => {
          calls.push("afterRecord");
        },
        afterMedia: () => {},
      },
      onEvent: (event) => calls.push(event.kind),
    });
    expect(outcome).toEqual({ kind: "failed", code: "DATABASE_UNAVAILABLE" });
    expect(f.persisted()).toEqual({ events: 0, journal: 0 });
    expect(calls).toContain("failed");
    expect(calls).not.toContain("afterRecord");
  });

  it("keeps committed observation rows when the post-commit offer fails", () => {
    // 合法组成：真实 offer 成功后才注入失败，证明 specific scheduling_failed 不是无效节奏。
    const f = setup({ invalidRhythm: false });
    const realAfterRecord = f.adapter.afterRecord.bind(f.adapter);
    const events: string[] = [];
    const outcome = recordInbound(f.orm, f.makeNormalized(73001, false, "post-commit failure"), {
      accountId: ACCOUNT_ID,
      conversationIngress: {
        beforeRecord: (bindingId) => f.adapter.beforeRecord(bindingId),
        afterRecord: (bindingId, observation) => {
          const post = realAfterRecord(bindingId, observation);
          return () => {
            if (typeof post === "function") post();
            throw new AppError("MEMORY_STATE_CONFLICT", "调度失败", 409);
          };
        },
        afterMedia: (bindingId, eventKey) => f.adapter.afterMedia(bindingId, eventKey),
      },
      onEvent: (event) => events.push(event.kind),
    });
    // 调度失败不改变 recorded：观察与 journal 都已提交。
    expect(outcome).toEqual({ kind: "recorded", recorded: true, hasText: true });
    expect(f.persisted()).toEqual({ events: 1, journal: 1 });
    expect(events).toContain("scheduling_failed");
  });

  it("runs the post-commit callback outside the observation transaction", () => {
    const f = setup({ invalidRhythm: false });
    const transactionStates: boolean[] = [];
    const outcome = recordInbound(f.orm, f.makeNormalized(74001, false, "tx visibility"), {
      accountId: ACCOUNT_ID,
      conversationIngress: {
        beforeRecord: (bindingId) => f.adapter.beforeRecord(bindingId),
        afterRecord: (bindingId, observation) => {
          const post = f.adapter.afterRecord(bindingId, observation);
          return () => {
            transactionStates.push(f.db.inTransaction);
            if (typeof post === "function") post();
          };
        },
        afterMedia: (bindingId, eventKey) => f.adapter.afterMedia(bindingId, eventKey),
      },
    });
    expect(outcome).toEqual({ kind: "recorded", recorded: true, hasText: true });
    expect(transactionStates).toEqual([false]);
    expect(f.persisted()).toEqual({ events: 1, journal: 1 });
  });

  it("rolls back journal and observation together when the record phase fails after journal append", () => {
    const f = setup();
    const realAfterRecord = f.adapter.afterRecord.bind(f.adapter);
    const events: string[] = [];
    const outcome = recordInbound(f.orm, f.makeNormalized(75001, false, "after-journal failure"), {
      accountId: ACCOUNT_ID,
      conversationIngress: {
        beforeRecord: (bindingId) => f.adapter.beforeRecord(bindingId),
        afterRecord: (bindingId, observation) => {
          // 真实 adapter 先完成 journal ingest，再在事务内抛出存储失败。
          realAfterRecord(bindingId, observation);
          throw new AppError("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
        },
        afterMedia: (bindingId, eventKey) => f.adapter.afterMedia(bindingId, eventKey),
      },
      onEvent: (event) => events.push(event.kind),
    });
    expect(outcome).toEqual({ kind: "failed", code: "DATABASE_UNAVAILABLE" });
    // 事务原子性：journal 已 append 也随观察一起回滚，没有任何部分提交。
    expect(f.persisted()).toEqual({ events: 0, journal: 0 });
    expect(events).toContain("failed");
  });

  it("stays idempotent on exact redelivery of the same message", () => {
    const f = setup();
    // 与无效生效节奏的原始形态对照：先注入差异再收同一条消息两次。
    const first = f.receive(70001, false);
    expect(first).toEqual({ kind: "recorded", recorded: true, hasText: true });
    const second = f.receive(70001, false);
    expect(second).toEqual({ kind: "recorded", recorded: false, hasText: false });
    expect(f.persisted()).toEqual({ events: 1, journal: 1 });
  });
});
