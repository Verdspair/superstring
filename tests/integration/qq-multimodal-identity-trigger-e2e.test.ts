// T15 P1 slice：身份与触发面补块。
//
// 覆盖矩阵 id 1,2,6,7,9,10,11,12（原计划 §T15 Step1 逐字；判定三态口径见
// artifacts/.../resume-t15-matrix-review.md，panel-A 的逐条补块要求见其 §P1 分区）。
//
// 块标题 → 矩阵 id（标题按内部 runner 的 [Sxx] 前缀协议，第二个数字是本切片内的子块序号；
// 协调方按下面的对照把子块对号到真实矩阵 id，runner 本身不解析 id）：
//   [S01_1] → id 1   普通成员双昵称
//   [S02_1] → id 2   空白 card fallback
//   [S06_1] → id 6   anonymous（渲染面）
//   [S06_2] → id 6   anonymous（触发面附加块：未被点名的匿名零调用）
//   [S07_1] → id 7   assistant QQ/name
//   [S09_1] → id 9   @他人在原位
//   [S10_1] → id 10  @全体成员
//   [S11_1] → id 11  @self 真触发 + 关闭直接回应零调用
//   [S12_1] → id 12  回复他人带原文
//
// 纪律（沿用批次约定）：
//   * 全部走真实 OneBot wire → intake → 宿主 → AgentRuntime → 投递（createOneBotHarness
//     + scriptedModel）。断言面是「模型可见材料」＋「真实库行」，不是「调用了某函数」就算；
//   * 每条至少一条真实可失败的强负（call counter / sends / addressing.reasons / 事实库逐字段
//     来源 / 目录 before-after），不用「没有抛异常」当负证据，也不断言产品里不存在的 token；
//   * 触发结论一律读真实 `conversation_events.addressing`、`qq_events.addressed` 与 wake cause，
//     不用夹具自带 addressed:true 遮蔽真实判定；
//   * 逐行断言（按 platformMessageId 索引）而不是整串 toContain，避免同名两条互相顶替；
//   * 不 import artifacts/（本文件自包含）；不改产品代码与 harness。
//
// 夹具接口（tests/harness/onebot.ts，本文件只读消费）：
//   ReceiveInput.anonymous?: boolean（group 时 wire sub_type="anonymous"）
//   ReceiveInput.omitPersonalNickname?: boolean（wire 完全省略 sender.nickname 键）

import { afterEach, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { loadQqOutboundMessageFact } from "../../src/server/channels/onebot11/message-projection";
import { readQqMemberNames } from "../../src/server/db/qq-member-repository";
import { DEFAULT_AGENT_ID } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { resolveQqDisplayName } from "../../src/server/services/qq-message-renderer";
import { batchScore, decideGenerate, say, scoreOf } from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";

afterEach(() => {
  closeHarnesses();
});

const GROUP_SCOPE = { accountId: "90001", conversationKind: "group", peerId: "30003" } as const;

// ---- 本文件内的小工具（不构成第二 harness／第二模型链） --------------------------------

/** 一次调用输入的全部文本。 */
const callText = (h: OneBotHarness, index: number): string =>
  (h.model?.receivedMessages[index]?.messages ?? [])
    .flatMap((message) =>
      message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
    )
    .join("\n");

/** 全部调用输入的拼接（负断言「任何一次输入都不得含 X」用）。 */
const allText = (h: OneBotHarness): string => {
  const parts: string[] = [];
  for (let index = 0; index < (h.model?.calls.length ?? 0); index++) parts.push(callText(h, index));
  return parts.join("\n");
};

const phases = (h: OneBotHarness): string[] => (h.model?.calls ?? []).map((call) => call.phase);

/** 唤醒结果的状态串（没有结果时是 missing，不伪造 completed）。 */
const statusOf = (result: unknown): string =>
  result !== null && typeof result === "object" && "status" in result
    ? String((result as { status: unknown }).status)
    : "missing";

/**
 * 解出「QQ消息事实」信封的未转义渲染文本。
 * 信封整行是一个 context dump（`contextDumps` 会把键排序，所以 facts 在前、kind 在后）。
 */
function factsSegments(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith('{"facts":"') || !line.includes('"kind":"qq_message_facts"')) continue;
    try {
      out.push((JSON.parse(line) as { facts: string }).facts);
    } catch {
      // 解不开的信封不伪造：跳过（外层断言自然失败并留现场）。
    }
  }
  return out;
}

interface FactLine {
  readonly platformMessageId: string;
  readonly id: string;
  readonly seq: number;
  readonly time: string;
  readonly speaker: {
    role: string;
    qq: string | null;
    displayName: string;
    nameState: string;
    readonly currentName?: { groupCard: string | null; personalNickname: string | null };
  };
  readonly parts: Array<Record<string, unknown>>;
  readonly mentions: Array<{ qq: string; identity: unknown }>;
  readonly replyTo?: { platformMessageId: string };
}

/** 把事实渲染解析成逐条消息行（按 platformMessageId 索引）。 */
function factLines(h: OneBotHarness, index: number): Map<string, FactLine> {
  const out = new Map<string, FactLine>();
  for (const segment of factsSegments(callText(h, index))) {
    for (const line of segment.split("\n")) {
      if (!line.startsWith("msg=")) continue;
      const parsed = JSON.parse(line.slice(4)) as FactLine;
      out.set(parsed.platformMessageId, parsed);
    }
  }
  return out;
}

/** 焦点行（本轮触发与应答，与消息行严格分开）。 */
function focusOf(
  h: OneBotHarness,
  index: number,
): {
  triggerMessageIds: string[];
  responseMessageIds: string[];
  responseQqs: string[];
  assistantQq: string;
} | null {
  for (const segment of factsSegments(callText(h, index))) {
    for (const line of segment.split("\n")) {
      if (line.startsWith("focus=")) return JSON.parse(line.slice(6));
    }
  }
  return null;
}

/** 引用展开段（只有 configured_depth 才渲染）解析。 */
function replyRoots(h: OneBotHarness, index: number): Array<Record<string, unknown>> | null {
  for (const message of h.model?.receivedMessages[index]?.messages ?? []) {
    for (const part of message.content) {
      if (part.kind !== "text") continue;
      const match = part.text.match(
        /\{"kind":"qq_reply_roots","roots":\[.*\],"trust":"data_only"\}/s,
      );
      if (!match) continue;
      return (JSON.parse(match[0]) as { roots: Array<Record<string, unknown>> }).roots;
    }
  }
  return null;
}

/** 某条入站消息在真实 journal 里的 addressing（触发判定的唯一真源）。 */
function addressingOf(
  h: OneBotHarness,
  platformMessageId: string,
): { reasons: string[]; mentionIds: string[]; addressed: number | null } | null {
  const row = h.db
    .query(
      `SELECT e.addressing FROM conversation_events e JOIN qq_events q ON q.event_key=e.source_id
      WHERE e.conversation_id=? AND e.source_kind='qq_event' AND q.message_id=?`,
    )
    .get(h.conversationId, platformMessageId) as { addressing: string } | undefined;
  if (!row) return null;
  const parsed = JSON.parse(row.addressing) as { reasons: string[]; mentionIds: string[] };
  const event = h.db
    .query("SELECT addressed FROM qq_events WHERE message_id=?")
    .get(platformMessageId) as { addressed: number | null } | undefined;
  return {
    reasons: parsed.reasons,
    mentionIds: parsed.mentionIds,
    addressed: event?.addressed ?? null,
  };
}

/** 本会话真实排出的 wake cause（不是夹具标签）。 */
function wakeCauses(h: OneBotHarness): string[] {
  return (
    h.db
      .query("SELECT DISTINCT cause FROM wake_signals WHERE conversation_id=? ORDER BY cause")
      .all(h.conversationId) as { cause: string }[]
  ).map((row) => row.cause);
}

/** 消息事实行的姓名快照与其逐字段来源（真实库）。 */
function factNameRow(
  h: OneBotHarness,
  platformMessageId: string,
): {
  groupCard: string | null;
  groupCardSource: string | null;
  personalNickname: string | null;
  personalNicknameSource: string | null;
  legacyDisplayName: string | null;
  nameState: string;
} | null {
  return (
    (h.db
      .query(
        `SELECT f.group_card AS groupCard,f.group_card_source AS groupCardSource,
        f.personal_nickname AS personalNickname,f.personal_nickname_source AS personalNicknameSource,
        f.legacy_display_name AS legacyDisplayName,f.name_state AS nameState
        FROM qq_message_facts f JOIN qq_events e ON e.event_key=f.event_key
        WHERE e.message_id=?`,
      )
      .get(platformMessageId) as ReturnType<typeof factNameRow>) ?? null
  );
}

/** 发送面真收件人（结构化协议下 at 段排在正文之后；没有程序收件人时为 null）。 */
function sendRecipient(h: OneBotHarness): string | null {
  const at = h.sent[0]?.message.find((segment) => segment.type === "at");
  return at?.type === "at" ? at.data.qq : null;
}

const FULL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;

it("[S01_1] 双昵称不同：两个 wire 字段各存各的来源、显示名只取名片优先那一份", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    model: [decideGenerate("20003", "回答", []), say("合成回复正文")],
  });
  // 名片与个人昵称刻意不同（规格 §3.1 的双快照）。
  h.receive({
    id: "-701",
    speaker: "20002",
    text: "双名字那条",
    groupCard: "群名片X",
    personalNickname: "个人昵Y",
  });
  h.advance(5);
  // wire 两个姓名字段都不带（omitPersonalNickname：nickname 键整个不出现）＋card 缺省。
  h.receive({
    id: "-702",
    speaker: "20004",
    text: "wire 完全缺名那条",
    omitPersonalNickname: true,
  });
  h.receive({ id: "-703", speaker: "20003", text: "你们是谁", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  const lines = factLines(h, 0);
  const dual = lines.get("-701");
  expect(dual).toBeDefined();
  if (!dual) throw new Error("dual-nickname row missing");
  // 呈现面：显示名只取优先名（名片），另一份名字永不冒充显示名。
  expect(dual.speaker.displayName).toBe("群名片X");
  expect(dual.speaker.qq).toBe("20002");
  expect(dual.speaker.nameState).toBe("known");
  // 双快照：事实库两列都在，各自带来源（不压成一份显示名）。
  const dualRow = factNameRow(h, "-701");
  expect(dualRow?.groupCard).toBe("群名片X");
  expect(dualRow?.groupCardSource).toBe("wire");
  expect(dualRow?.personalNickname).toBe("个人昵Y");
  expect(dualRow?.personalNicknameSource).toBe("wire");

  // wire 完全缺名那条：显式未知，不借配置人设名、不借任何来源冒充。
  const missing = lines.get("-702");
  expect(missing).toBeDefined();
  if (!missing) throw new Error("missing-name row missing");
  expect(missing.speaker.displayName).toBe("昵称未知");
  expect(missing.speaker.nameState).toBe("unknown");
  const missingRow = factNameRow(h, "-702");
  expect(missingRow?.groupCard).toBeNull();
  expect(missingRow?.groupCardSource).toBeNull();
  expect(missingRow?.personalNickname).toBeNull();
  expect(missingRow?.personalNicknameSource).toBeNull();

  // 强负一：任何一次模型输入都不得出现第二个显示名（双昵称没有被压成两份名字）。
  expect(allText(h)).not.toContain('"displayName":"个人昵Y"');
  expect(allText(h)).not.toContain('"displayName":"本地助手"');
  expect(allText(h)).not.toContain('"nameState":"legacy"');
  // 强负二：wire 原值不得被本地补齐冒充（来源必须逐字段是 wire）。
  expect(factNameRow(h, "-701")?.groupCardSource).toBe("wire");
  expect(factNameRow(h, "-701")?.personalNicknameSource).toBe("wire");
  // 强负三：wire 缺省不是「本地有值」——来源为空，不伪造成 local 或 wire。
  expect(factNameRow(h, "-702")?.groupCardSource).not.toBe("local");
  expect(factNameRow(h, "-702")?.personalNicknameSource).not.toBe("local");
  // 强负四：目录里也没有凭这两个名字造出的记录。
  expect(readQqMemberNames(h.orm, GROUP_SCOPE, "20004", h.now())?.personalNickname).not.toBe(
    "个人昵Y",
  );
});

it("[S02_1] 空白 card 回退个人昵称：全空格名片被 trim 成显式清空并真的清掉旧名片", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    model: [decideGenerate("20003", "回答", []), say("合成回复正文")],
  });
  // 先来一条有真名片的（目录与快照都要被它写上）。
  h.receive({
    id: "-711",
    speaker: "20002",
    text: "有名片那条",
    groupCard: "真名片",
    personalNickname: "林某",
  });
  h.advance(5);
  // 再来一条全空格名片：显式清空，不沿用旧名片，回退**本次 wire**个人昵称。
  // 本次昵称刻意 ≠ -711 的「林某」：证明回退取的是本次观察，不是旧快照昵称。
  h.receive({
    id: "-712",
    speaker: "20002",
    text: "名片被清空那条",
    groupCard: "   ",
    personalNickname: "林某乙",
  });
  h.receive({ id: "-713", speaker: "20003", text: "他叫什么", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  const lines = factLines(h, 0);
  const cleared = lines.get("-712");
  const earlier = lines.get("-711");
  expect(cleared).toBeDefined();
  if (!cleared) throw new Error("cleared-card row missing");
  // 全空格不是名字：显示名回退**本次**个人昵称（新名），不是旧快照的「林某」。
  expect(cleared.speaker.displayName).toBe("林某乙");
  expect(cleared.speaker.displayName).not.toBe("林某");
  expect(cleared.speaker.nameState).toBe("known");
  // 前一条的发送时快照不受影响（旧消息仍是旧名片＋旧个人昵称「林某」）。
  expect(earlier?.speaker.displayName).toBe("真名片");
  expect(factNameRow(h, "-711")?.groupCard).toBe("真名片");
  expect(factNameRow(h, "-711")?.personalNickname).toBe("林某");

  // 强负一：全空格的任何形态都不得显示，也不得挡住个人昵称回退。
  expect(allText(h)).not.toContain('"displayName":"   "');
  expect(allText(h)).not.toContain('"groupCard":"');
  expect(cleared.speaker.displayName).not.toBe("真名片");
  // 强负二：显式清空必须真的清掉当前目录的旧群名片，不得沿用（目录 before-after）。
  const current = readQqMemberNames(h.orm, GROUP_SCOPE, "20002", h.now());
  expect(current?.groupCard).toBeNull();
  expect(current?.personalNickname).toBe("林某乙");
  // 强负三：清空是 wire 已核实的空，不是不存在的字段（来源仍是 wire，不是 local）。
  const clearedRow = factNameRow(h, "-712");
  expect(clearedRow?.groupCard).toBeNull();
  expect(clearedRow?.groupCardSource).toBe("wire");
  expect(clearedRow?.groupCardSource).not.toBe("local");
});

it("[S06_1] anonymous：匿名不编 QQ 号、不同匿名发言不并成一个长期人物", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    // 两条匿名都没 @ 助手，所以本轮授权目标只有最后那条实名成员；匿名行仍进事实面。
    model: [decideGenerate("20003", "回答", []), say("合成回复正文")],
  });
  // 两条不同匿名消息（各自 message.id 不同）。
  h.receive({ id: "-721", speaker: "20002", text: "匿名第一条", anonymous: true });
  h.advance(5);
  h.receive({ id: "-722", speaker: "20002", text: "匿名第二条", anonymous: true });
  h.advance(5);
  h.receive({ id: "-723", speaker: "20003", text: "现在说话", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phases(h)).toEqual(["next", "generate"]);
  const lines = factLines(h, 0);
  const first = lines.get("-721");
  const second = lines.get("-722");
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  if (!first || !second) throw new Error("anonymous rows missing");
  // 匿名明确「QQ号不可用」：不编真实号、不显示任何名字。
  for (const row of [first, second]) {
    expect(row.speaker.role).toBe("anonymous");
    expect(row.speaker.qq).toBeNull();
    expect(row.speaker.displayName).toBe("匿名群友");
    expect(row.speaker.currentName).toBeUndefined();
  }
  // 强负一：全材料里匿名行不得带任何数字 qq（不编造真实号）。
  expect(allText(h)).not.toContain('"role":"anonymous","qq":"');
  expect(allText(h)).not.toContain('"displayName":"20002"');
  // 强负二：两条匿名不被并成一个长期人物——各自都是 hybrid full 集合里的独立一条
  // （渲染层按消息身份作 sender 键），所以两行都是各自的完整时间行、互不覆盖。
  expect(first.id).not.toBe(second.id);
  expect(first.seq).not.toBe(second.seq);
  expect(lines.size).toBe(3);
  // 强负三：事实库里匿名行的 speaker_id 为空（不是被伪造成某个 QQ），也不进 member 目录。
  const events = h.db
    .query(
      "SELECT message_id,speaker_kind,speaker_id FROM qq_events WHERE message_id IN('-721','-722') ORDER BY message_id",
    )
    .all() as { message_id: string; speaker_kind: string; speaker_id: string | null }[];
  expect(events).toHaveLength(2);
  for (const row of events) {
    expect(row.speaker_kind).toBe("anonymous");
    expect(row.speaker_id).toBeNull();
  }
  // 匿名发言根本不进 member 目录（不会造出一个只有号码的长期人物行）。
  expect(readQqMemberNames(h.orm, GROUP_SCOPE, "20002", h.now())).toBeNull();
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_members WHERE user_id='20002'").get()).toEqual({
    n: 0,
  });
});

it("[S06_2] 未被点名的匿名不进任何机会：零模型调用、零发送、零待发意图", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    initiativeMinScore: 6,
    model: [decideGenerate("anonymous", "回答", []), scoreOf(6), say("不该被调用")],
  });
  h.receive({ id: "-731", speaker: "20002", text: "匿名没人理", anonymous: true });
  h.advance(31);
  // 真实触发判定：匿名未 @ 助手 → 不排机会。
  expect(statusOf(await h.activate("chiming_in"))).toBe("missing");
  expect(phases(h)).toEqual([]);
  expect(h.sent).toHaveLength(0);
  expect(h.outbox.list({ conversationId: h.conversationId })).toHaveLength(0);
  expect(wakeCauses(h)).toEqual([]);
  // 但消息本身仍被如实记录（证明上面不是「消息没进来」）。
  const events = h.db
    .query("SELECT speaker_kind,speaker_id,addressed FROM qq_events WHERE message_id='-731'")
    .get() as { speaker_kind: string; speaker_id: string | null; addressed: number | null };
  expect(events.speaker_kind).toBe("anonymous");
  expect(events.speaker_id).toBeNull();
  expect(events.addressed).toBe(0);
});

it("[S07_1] assistantQQ/name：出站身份是真实发送账号的平台快照，不是 Agent UUID 也不是配置人设名", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    model: [decideGenerate("20002", "回答", []), say("助手出站正文")],
  });
  h.receive({ id: "-741", speaker: "20002", text: "你是谁", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);

  // 出站事实：真实发送账号 90001，不是 Agent UUID。
  const outbound = h.db
    .query(
      `SELECT f.account_id AS accountId,f.agent_id AS agentId,f.group_card AS groupCard,
      f.personal_nickname AS personalNickname,f.legacy_display_name AS legacyDisplayName
      FROM qq_outbound_message_facts f JOIN outbound_intents i ON i.id=f.intent_id
      WHERE i.conversation_id=?`,
    )
    .get(h.conversationId) as
    | {
        accountId: string;
        agentId: string;
        groupCard: string | null;
        personalNickname: string | null;
        legacyDisplayName: string | null;
      }
    | undefined;
  expect(outbound).toBeDefined();
  if (!outbound) throw new Error("outbound identity snapshot missing");
  expect(outbound.accountId).toBe("90001");
  expect(outbound.agentId).toBe(DEFAULT_AGENT_ID);
  // 强负一：Agent UUID 不得充当 QQ 号。
  expect(outbound.accountId).not.toBe(DEFAULT_AGENT_ID);
  expect(allText(h)).not.toContain(DEFAULT_AGENT_ID);
  // 强负二：配置人设名不得被当成平台个人昵称（助手不在本群 member 目录里 → 两列皆空）。
  expect(outbound.groupCard).toBeNull();
  expect(outbound.personalNickname).toBeNull();
  expect(outbound.legacyDisplayName).toBeNull();

  // 生产读入口：确认送达的部件投回事实面时，speaker 是 assistant＋真实账号。
  const part = h.db
    .query(
      `SELECT p.platform_message_id AS platformMessageId FROM outbound_parts p
      JOIN outbound_intents i ON i.id=p.intent_id
      WHERE i.conversation_id=? AND p.status='confirmed' AND p.kind='text'`,
    )
    .get(h.conversationId) as { platformMessageId: string } | undefined;
  expect(part?.platformMessageId).toBeDefined();
  if (!part) throw new Error("confirmed outbound part missing");
  const conversation = h.journal.get(h.conversationId);
  const binding = h.orm
    .select()
    .from(schema.qqBindings)
    .where(eq(schema.qqBindings.id, h.bindingId))
    .get();
  if (!conversation || !binding) throw new Error("harness scope missing");
  // 运行时事实窄化：conversationKind 是 text 列（string），DB check 约束只是辅助；
  // 用真实 if 检查把当前值收窄到 union 再构 scope，不用 as 假类型绕过边界。
  if (binding.conversationKind !== "group" && binding.conversationKind !== "private") {
    throw new Error(`unexpected binding.conversationKind: ${binding.conversationKind}`);
  }
  const fact = loadQqOutboundMessageFact(
    { db: h.db, orm: h.orm },
    {
      conversationId: h.conversationId,
      accountId: binding.accountId,
      conversationKind: binding.conversationKind,
      peerId: binding.peerId,
      agentId: binding.agentId,
      bindingId: binding.id,
      bindingEpoch: conversation.bindingEpoch,
      authorityRevision: binding.authorityRevision,
    },
    part.platformMessageId,
    h.now(),
  );
  expect(fact).not.toBeNull();
  if (!fact) throw new Error("outbound fact projection missing");
  expect(fact.speaker.role).toBe("assistant");
  expect(fact.speaker.qq).toBe("90001");
  // 强负三：呈现面上也不得出现 UUID 或配置人设名冒充平台昵称。
  expect(resolveQqDisplayName(fact.speaker)).toBe("昵称未知");
  expect(JSON.stringify(fact.speaker)).not.toContain(DEFAULT_AGENT_ID);
  expect(JSON.stringify(fact.speaker)).not.toContain("本地助手");
});

it("[S09_1] @他人在原位：平台 at 段按 wire 顺序原位重放，正文字面 @ 不产生收件人也不改变触发", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    model: [decideGenerate("20002", "回答", [], undefined, ["20002"]), say("合成回复正文")],
  });
  h.receive({
    id: "-751",
    speaker: "20002",
    text: "@20004 字面at在吗",
    addressed: true,
    mentions: ["20003", "all"],
  });
  await h.activate("direct_reply");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);

  const row = factLines(h, 0).get("-751");
  expect(row).toBeDefined();
  if (!row) throw new Error("mention row missing");
  // 原位：平台 at 段按 wire 顺序排在正文之前，字面 @ 只是正文数据。
  expect(row.parts.map((part) => part.kind)).toEqual(["mention", "mention", "mention", "text"]);
  expect(row.parts[0]).toEqual({ kind: "mention", qq: "90001", identity: null });
  expect(row.parts[1]).toEqual({ kind: "mention", qq: "20003", identity: null });
  expect(row.parts[2]).toEqual({ kind: "mention", qq: "all" });
  const textPart = row.parts[3];
  if (typeof textPart?.text !== "string") throw new Error("text part missing");
  expect(textPart.text).toBe("@20004 字面at在吗");
  // 强负一：正文里的字面 @ 不产生真实收件人（parts 与 mentions 两侧都没有 20004）。
  expect(JSON.stringify(row.parts)).not.toContain('"qq":"20004"');
  expect(JSON.stringify(row.mentions)).not.toContain("20004");
  // 发送面真 target：程序收件人是被点名的发言人，不是正文里那个号。
  expect(sendRecipient(h)).toBe("20002");
  h.close();

  // 强负二：只有字面 @、没有平台 at 的消息不改变触发（不排直接回应机会）。
  const literal = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    initiativeMinScore: 6,
    // 阶段一批量评分的候选数收窄 X1/Y0：未点名的群消息走真实 chiming_in 唤醒。
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  literal.receive({ id: "-752", speaker: "20002", text: "@20004 在吗" });
  literal.advance(31);
  expect(statusOf(await literal.activate("direct_reply"))).toBe("missing");
  // 新 chiming_in 形状：阶段一批量评分（phase=next）→ 回复决策 → 生成。
  literal.model?.push([
    batchScore([
      { targetId: "20002", score: 6, intent: "想接话", sourceSeqs: [literal.lastEventSeq] },
    ]),
    decideGenerate("20002", "回答", [], undefined, ["20002"]),
    say("接话正文"),
  ]);
  const literalAddressing = addressingOf(literal, "-752");
  expect(literalAddressing?.reasons).toEqual([]);
  expect(literalAddressing?.mentionIds).toEqual([]);
  expect(literalAddressing?.addressed).toBe(0);
  // 它走的是「没被点名」的接话路径，不是直接回应。
  expect(wakeCauses(literal)).toEqual(["chiming_in"]);
  expect(statusOf(await literal.activate("chiming_in"))).toBe("completed");
  await literal.deliver();
  expect(phases(literal)).toEqual(["next", "next", "generate"]);
  expect(literal.sent).toHaveLength(1);
  expect(sendRecipient(literal)).toBe("20002");
});

it("[S10_1] @全体成员不得被当作 @助手：只有 all 时 addressing 为空、收件人只有 all", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    initiativeMinScore: 6,
    // @all-only 消息不进合格接话计数：局部节奏收窄 X1/Y0，让真实 chiming_in 唤醒在本夹具触发。
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  // 只有 @全体，没有 @助手（不给 addressed）。
  h.receive({ id: "-761", speaker: "20002", text: "大家好", mentions: ["all"] });
  h.advance(31);
  // 新 chiming_in 形状：阶段一批量评分（phase=next）→ 回复决策 → 生成。
  h.model?.push([
    batchScore([{ targetId: "20002", score: 6, intent: "想接话", sourceSeqs: [h.lastEventSeq] }]),
    decideGenerate("20002", "回答", [], undefined, ["20002"]),
    say("合成回复正文"),
  ]);
  expect(statusOf(await h.activate("chiming_in"))).toBe("completed");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "next", "generate"]);
  expect(h.sent).toHaveLength(1);

  const row = factLines(h, 0).get("-761");
  expect(row).toBeDefined();
  if (!row) throw new Error("@all row missing");
  // 强负一：@全体不得被当成 @助手——收件人只有 all 一个，没有助手自己。
  const mentionParts = row.parts.filter((part) => part.kind === "mention");
  expect(mentionParts).toEqual([{ kind: "mention", qq: "all" }]);
  expect(JSON.stringify(row.parts)).not.toContain('"qq":"90001"');
  // 强负二：触发面也没有 mention（真实 addressing 为空、事件行未被点名、路径是接话）。
  const addressing = addressingOf(h, "-761");
  expect(addressing?.reasons).toEqual([]);
  expect(addressing?.mentionIds).toEqual(["all"]);
  expect(addressing?.addressed).toBe(0);
  expect(wakeCauses(h)).toEqual(["chiming_in"]);
  // 强负三：焦点行把「问谁」与「谁是助手」分开，all 不进应答对象列表。
  const focus = focusOf(h, 0);
  expect(focus?.assistantQq).toBe("90001");
  expect(focus?.responseQqs).not.toContain("all");
  expect(focus?.responseQqs).toContain("20002");
  // 强负四：发送面也没有把全体当收件人（程序收件人是发言人本人）。
  expect(sendRecipient(h)).toBe("20002");
});

it("[S11_1] @self 真触发，且关闭直接回应后该条零模型调用（@识别与触发开关分开）", async () => {
  const direct = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    model: [decideGenerate("20002", "回答", [], undefined, ["20002"]), say("合成回复正文")],
  });
  direct.receive({ id: "-771", speaker: "20002", text: "在吗", addressed: true });
  await direct.activate("direct_reply");
  await direct.deliver();
  // 真触发：平台 at 段命中 → 直接回应 → 决策＋生成两相、恰好一条发送。
  expect(phases(direct)).toEqual(["next", "generate"]);
  expect(direct.sent).toHaveLength(1);
  const addressed = addressingOf(direct, "-771");
  expect(addressed?.reasons).toEqual(["mention"]);
  expect(addressed?.mentionIds).toEqual(["90001"]);
  expect(addressed?.addressed).toBe(1);
  expect(wakeCauses(direct)).toEqual(["direct_reply"]);
  // 发送面真 target：程序收件人是被点名的那个发言人。
  expect(sendRecipient(direct)).toBe("20002");
  direct.close();

  // 强负：关闭直接回应后同一条 @self 零模型调用、零发送、零待发意图。
  const off = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    triggers: { direct_reply: false },
    model: [decideGenerate("20002", "回答", []), scoreOf(6), say("不该被调用")],
  });
  off.receive({ id: "-772", speaker: "20002", text: "在吗", addressed: true });
  expect(statusOf(await off.activate("direct_reply"))).toBe("missing");
  expect(phases(off)).toEqual([]);
  expect(off.sent).toHaveLength(0);
  expect(off.outbox.list({ conversationId: off.conversationId })).toHaveLength(0);
  // 关键区分：@self 被识别到了（addressing 仍带 mention、事件行 addressed=1），只是触发被关掉。
  const offAddressing = addressingOf(off, "-772");
  expect(offAddressing?.reasons).toEqual(["mention"]);
  expect(offAddressing?.addressed).toBe(1);
  expect(wakeCauses(off)).toEqual([]);
  // 强负：改走别的触发路径也一样不开口（开关只关这一条触发，不改写事实）。
  off.advance(31);
  expect(statusOf(await off.activate("chiming_in"))).toBe("missing");
  expect(phases(off)).toEqual([]);
  expect(off.sent).toHaveLength(0);
});

it("[S12_1] 回复他人：真实 addressing 不含 reply_to_agent，原文经引用展开带原作者与时间", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    initiativeMinScore: 6,
    model: [],
  });
  h.receive({ id: "-781", speaker: "20002", text: "根消息原文BODY12", groupCard: "小周" });
  for (let index = 0; index < 26; index++) {
    h.advance(3);
    h.receive({ id: `${-800 - index}`, speaker: "20003", text: `填充消息${index}` });
  }
  // 20003 回复 20002：不是问助手（不给 addressed），但关系必须记全。
  h.receive({
    id: "-799",
    speaker: "20003",
    text: "回复你刚才那条",
    groupCard: "小王",
    replyTo: "-781",
  });
  h.advance(31);
  // 新 chiming_in 形状：阶段一批量评分（phase=next，逐候选完整 evaluations）→ 回复决策 → 生成。
  h.model?.push([
    // 非分发言人房间：本批冻结候选与参与者不同，按真实 qq_batch_targets 逐人输出全部 evaluations
    // （本轮冻结集合只有 20003 一个候选，不能固定猜 20002）。
    batchScore([
      { targetId: "20003", score: 6, intent: "回复他人想接话", sourceSeqs: [h.lastEventSeq] },
    ]),
    decideGenerate("20003", "打算接话", [], undefined, ["20003"]),
    say("合成回复正文"),
  ]);
  expect(statusOf(await h.activate("chiming_in"))).toBe("completed");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "next", "generate"]);
  expect(h.sent).toHaveLength(1);

  // 强负一：真实 addressing 不含 reply_to_agent（本助手从没发过 -781），也不是直接问助手。
  // 断言面是 journal 的真实 reasons，不是某个产品里不存在的 camelCase token。
  const addressing = addressingOf(h, "-799");
  expect(addressing?.reasons).toEqual([]);
  expect(addressing?.mentionIds).toEqual([]);
  expect(addressing?.addressed).toBe(0);
  expect(wakeCauses(h)).toEqual(["chiming_in"]);
  // 强负二：回复关系本身必须记全（不是靠窗口巧合）。
  const replyRow = factLines(h, 0).get("-799");
  expect(replyRow?.replyTo).toEqual({ platformMessageId: "-781" });
  // 强负三：任何一次模型输入都不得出现「回助手」的标记串。
  expect(allText(h)).not.toContain("replyToAgent");
  expect(allText(h)).not.toContain("reply_to_agent");

  // 引用展开：根消息带原作者、平台 ID、完整时间，正文只经展开供一次。
  const roots = replyRoots(h, 2);
  expect(roots).not.toBeNull();
  const rootLine = roots?.find((root) => root.platformMessageId === "-781");
  expect(rootLine).toBeDefined();
  if (!rootLine) throw new Error("quote root missing");
  expect(rootLine.state).toBe("available");
  expect(rootLine.depth).toBe(1);
  const speaker = rootLine.speaker as {
    role: string;
    qq: string | null;
    displayName: string;
    nameState: string;
  };
  expect(speaker.role).toBe("member");
  expect(speaker.qq).toBe("20002");
  expect(speaker.displayName).toBe("小周");
  expect(FULL_TIME.test(String(rootLine.time))).toBe(true);
  expect(rootLine.text).toBe("根消息原文BODY12");
  // 正文完整供出 ⇒ 不再发受限读取引用（不重复提供同一正文）。
  expect(rootLine.bodyRef).toBeUndefined();
  expect(rootLine.textPage).toBeUndefined();
  // 焦点行：应答对象是被回复的人与在场发言人，不是助手自己（§4.1 第 3 项 ≠ 第 4 项）。
  const focus = focusOf(h, 2);
  expect(focus?.assistantQq).toBe("90001");
  expect(focus?.responseQqs).toContain("20003");
  expect(focus?.responseQqs).not.toContain("90001");
  // 发送面真 target：程序收件人是被回复链上的发言人，不是助手。
  expect(sendRecipient(h)).toBe("20003");
});
