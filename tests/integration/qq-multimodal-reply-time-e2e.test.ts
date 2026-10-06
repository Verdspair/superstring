// 引用/窗口/时间整链强测试。
//
// 红线：整链一律走真实 OneBot→宿主→AgentRuntime（createOneBotHarness + scriptedModel），
// 不建第二 harness/第二模型链、不 import artifacts/、不假装 provider、不读真实数据/密钥。
// 跨 scope 负向必须**同库**（夹具一库一世界，两个 harness 各自 :memory: 库 ⇒ 跨库断言恒真），
// 故用「同一 harness 内插第二条真实 binding + 真实 recordObservation」构造，不用第二个 harness。
// 强负一律是可失败断言（字段级 state、正文出现次数、工具/调用计数、run errorCode），
// 不用「没抛异常」「引用不存在的 token」「?? 兜底成期望值」这类恒真式。

import { afterEach, expect, it } from "bun:test";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { DEFAULT_AGENT_ID } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { RuntimeSpanRepository } from "../../src/server/observability/span-repository";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";
import { decideGenerate, decideInline, decideInvoke, say } from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";

afterEach(() => {
  closeHarnesses();
});

// ---- 本文件内的小工具（不构成第二 harness/第二模型链） ------------------------------

/** 某次**真实 model request** 输入的全文拼接（动态端口据此读本轮装配出的 ref）。 */
const requestText = (request: ModelRequest): string =>
  (request.messages ?? [])
    .flatMap((message) =>
      message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
    )
    .join("\n");

/** 某次调用输入的全文拼接（模型可见材料）。 */
const callText = (h: OneBotHarness, index: number): string =>
  (h.model?.receivedMessages[index]?.messages ?? [])
    .flatMap((message) =>
      message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
    )
    .join("\n");

/** 全部调用输入的拼接（负断言「任何一次输入都不得含 X」用）。 */
const allText = (h: OneBotHarness): string => {
  const parts: string[] = [];
  for (let index = 0; index < (h.model?.calls.length ?? 0); index += 1)
    parts.push(callText(h, index));
  return parts.join("\n");
};

const phases = (h: OneBotHarness): string[] => (h.model?.calls ?? []).map((call) => call.phase);

/** 解出「QQ消息事实」信封的未转义渲染文本。 */
const factsSegments = (text: string): string[] => {
  const out: string[] = [];
  const pattern = /\{"facts":("(?:[^"\\]|\\.)*"),"kind":"qq_message_facts"/g;
  for (const match of text.matchAll(pattern)) {
    try {
      out.push(JSON.parse(match[1] ?? '""') as string);
    } catch {
      // 解不开的信封不伪造内容：跳过（外层断言自然失败并留现场）。
    }
  }
  return out;
};

const factsText = (h: OneBotHarness, index: number): string =>
  factsSegments(callText(h, index)).join("\n");

/** 出现次数（Step2 要求的计数式强负：「同一正文恰好供一次」）。 */
const occurrences = (text: string, marker: string): number => {
  let count = 0;
  let at = text.indexOf(marker);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(marker, at + marker.length);
  }
  return count;
};

interface QuoteRoot {
  from: string;
  target: string;
  state: string;
  depth: number;
  platformMessageId: string | null;
  occurredAtSeconds?: number;
  time?: string;
  text?: string;
  offset?: number;
  total?: number;
  nextOffset?: number | null;
  complete?: boolean;
  bodyRef?: string;
}

/** 取出模型输入里的 qq_reply_roots 资料段并解出每一行（不伪造：段不存在即 null）。 */
function quoteRoots(h: OneBotHarness, index: number): QuoteRoot[] | null {
  const text = callText(h, index);
  const match = text.match(/\{"kind":"qq_reply_roots","roots":\[.*?\],"trust":"data_only"\}/s);
  if (!match) return null;
  const parsed = JSON.parse(match[0]) as { roots: QuoteRoot[] };
  return parsed.roots;
}

/** 段原文（断言「引用区不携带正文」「正文只在窗口段」时需要）。 */
function quoteSegmentText(h: OneBotHarness, index: number): string {
  const text = callText(h, index);
  const match = text.match(/\{"kind":"qq_reply_roots","roots":\[.*?\],"trust":"data_only"\}/s);
  return match?.[0] ?? "";
}

/**
 * 某次调用输入里「近期群聊」时间线段（timeline）的原文。
 *
 * **仅作失败定位用**：正文重复发生时指出是哪一段多了一份，不参与通过/失败判定。
 * 契约判据是 `occurrences(callText(h, i), marker) === 1`（同一次调用整体一份）。
 */
function timelineText(h: OneBotHarness, index: number): string {
  const text = callText(h, index);
  const start = text.indexOf("## 近期群聊");
  if (start === -1) return "";
  const end = text.indexOf('{"facts":', start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

/** 引用段某根上**真实的** total 码点总数（生产**会**在 textPage 发布；与 nextOffset 分开取）。 */
function quoteRootTotal(text: string): number | null {
  const segment = text.match(/\{"kind":"qq_reply_roots","roots":\[.*?\],"trust":"data_only"\}/s);
  if (!segment) return null;
  const parsed = JSON.parse(segment[0]) as { roots: { total?: unknown; nextOffset?: unknown }[] };
  const values = parsed.roots
    .map((root) => root.total)
    .filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.max(...values) : null;
}

/** 引用段里各根**真实的** nextOffset（取前缀页分页信息，不造值；段缺失或无下一页则 null）。 */
function quoteNextOffset(text: string): number | null {
  const segment = text.match(/\{"kind":"qq_reply_roots","roots":\[.*?\],"trust":"data_only"\}/s);
  if (!segment) return null;
  const parsed = JSON.parse(segment[0]) as { roots: { nextOffset?: number | null }[] };
  const values = parsed.roots
    .map((root) => root.nextOffset)
    .filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.max(...values) : null;
}

/**
 * 从**真实模型输入**里解析**本轮**的 `history.read` 动作结果。
 *
 * 口径（严格按生产结构，不猜形状、不用正则截 JSON）：
 * `engine.render` 为**每个** observation 单独 push 一条 dataMessage，其 text part 是
 * **一整个完整 JSON 对象**：`JSON.stringify({kind:"action_observation", trust:"data_only", value: observation})`，
 * observation 内含 name/arguments/value/sources（value 里还有 items 等嵌套 JSON）。
 * 因此正确解析是：逐条 message 取 kind==="text" 的 part → `JSON.parse(part.text)` →
 * 校验 `kind === "action_observation"` → `value.name === "history.read"`。
 * 旧的非贪婪正则（`…value:\{[^}]*\}\}`）会在嵌套右花括号处截断而 parse 失败；
 * 对整份 messages 做 JSON.stringify 再找紧凑字面量也会因转义而不命中——两者都已废止。
 *
 * 另：必须 `value.arguments.bodyRef === 本次真实签发的 bodyRef`，否则算拿错 ref（不推进）；
 * 取**最后一条**匹配（最新一次调用结果），不取旧观察。
 */
interface HistoryReadPage {
  readonly text: string;
  /** 构造不变量：page 只在 wire item.offset 是真 number 时构造（缺 offset ⇒ page=null），故 offset 不是 number|null。 */
  readonly offset: number;
  readonly nextOffset: number | null;
}

interface HistoryReadObservation {
  readonly bodyRef: string;
  /** 本次调用在 arguments 里报的 offset/limit（原样透传，未经改名）。 */
  readonly argsOffset: number | null;
  readonly argsLimit: number | null;
  readonly status: string | null;
  readonly code: string | null;
  readonly page: HistoryReadPage | null;
  /** 码点长度（分页单位＝Unicode 码点，Array.from/spread 口径）。 */
  readonly textLength: number | null;
  /**
   * 生产**不发布** items[0].total（total 只存在于模块内 EvidenceTextPage，publish 前被丢弃），
   * 所以这里只在**终页**（nextOffset === null）由 offset + 码点长度推导；中间页为 null（未知）。
   */
  readonly total: number | null;
  /** 响应 items[0].bodyRef（必须与本次请求的 UUID 同一个）。 */
  readonly itemBodyRef: string | null;
  /** TAIL 是否落在**这一页的 text 内**（不是整份 request 文本里的任意位置）。 */
  readonly tailInPage: boolean;
}

/**
 * 取本轮**最新一条**匹配本次 (bodyRef, offset) 的 history.read 观察。
 *
 * 绑定两要素，缺一不认：
 * - `value.name === "history.read"`；
 * - `value.arguments.bodyRef === 本次真实签发的 UUID`；
 * - `value.arguments.offset === 本步请求所报的 offset`——同 run 内同 ref 的**旧观察**（不同 offset）
 *   绝不能用来推进分页。
 * 返回的页文本用于判定 TAIL 是否真在这一页里，以及码点长度自洽。
 */
function latestHistoryRead(
  messages: readonly ModelMessage[],
  forBodyRef: string,
  expectedOffset: number | null,
): HistoryReadObservation | null {
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) ? value : null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    for (const part of messages[index]?.content ?? []) {
      if (part.kind !== "text") continue;
      let envelope: {
        kind?: unknown;
        value?: {
          name?: unknown;
          arguments?: { bodyRef?: unknown; offset?: unknown; limit?: unknown };
          value?: unknown;
        };
      };
      try {
        envelope = JSON.parse(part.text) as typeof envelope;
      } catch {
        continue; // 非本信封（协议/时间线/资料段），跳过
      }
      if (envelope.kind !== "action_observation") continue;
      const inner = envelope.value;
      if (inner?.name !== "history.read") continue;
      const args = inner.arguments;
      if (!args || args.bodyRef !== forBodyRef) continue;
      const argsOffset = num(args.offset);
      if (expectedOffset !== null && argsOffset !== expectedOffset) continue;
      const result = (inner.value ?? {}) as {
        status?: unknown;
        code?: unknown;
        items?: { bodyRef?: unknown; text?: unknown; offset?: unknown; nextOffset?: unknown }[];
      };
      const items = Array.isArray(result.items) ? result.items : [];
      const item = items[items.length - 1];
      const pageText = typeof item?.text === "string" ? item.text : null;
      const pageOffset = item ? num(item.offset) : null;
      const nextOffset = item ? (item.nextOffset === null ? null : num(item.nextOffset)) : null;
      const length = pageText === null ? null : [...pageText].length;
      return {
        bodyRef: forBodyRef,
        argsOffset,
        argsLimit: num(args.limit),
        status: typeof result.status === "string" ? result.status : null,
        code: typeof result.code === "string" ? result.code : null,
        page:
          pageText === null || pageOffset === null
            ? null
            : { text: pageText, offset: pageOffset, nextOffset },
        textLength: length,
        itemBodyRef: typeof item?.bodyRef === "string" ? item.bodyRef : null,
        // 只在终页推导总量；生产不发布中间页 total。
        total:
          pageText !== null && pageOffset !== null && nextOffset === null && length !== null
            ? pageOffset + length
            : null,
        tailInPage: pageText?.includes(TAIL_MARKER) ?? false,
      };
    }
  }
  return null;
}

/** 续读目标：被裁正文末尾的唯一标记（只认落在匹配页 text 内）。 */
const TAIL_MARKER = "续读尾标记TAIL19";

/** 诊断记录：把一次请求里模型的选择与匹配到的观察完整落盘（全合成，无真实业务数据）。 */
interface ReadTrace {
  readonly requestIndex: number;
  readonly bodyRef: string | null;
  readonly chosenOffset: number | null;
  readonly chosenLimit: number | null;
  readonly stopReason: string | null;
  readonly observation: HistoryReadObservation | null;
}

/** 同一次调用整体：该正文出现几次（契约判据用这个，不是分槽计数）。 */
const bodyCopiesIn = (h: OneBotHarness, index: number, marker: string): number =>
  occurrences(callText(h, index), marker);

/** 某条 msg= 行的 JSON（消息层字段级断言用）。 */
function msgLine(facts: string, platformMessageId: string): Record<string, unknown> | null {
  const line = facts
    .split("\n")
    .find((l) => l.startsWith("msg=") && l.includes(`"platformMessageId":"${platformMessageId}"`));
  if (!line) return null;
  try {
    return JSON.parse(line.slice("msg=".length)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const statusOf = (result: unknown): string =>
  result !== null && typeof result === "object" && "status" in result
    ? String((result as { status: unknown }).status)
    : "missing";

/**
 * 在**同一个库**里插第二条绑定（同 accountId、不同 peerId、同 Agent）并落一条真实入站观察。
 *
 * 用途：跨 scope 负向必须能失败。夹具每建一个 harness 就开一个独立 :memory: 库，
 * 「用另一个 harness 造数据、再在本 harness 断言看不到」结构上恒真（数据根本不在同一库）。
 * 这里走与 intake 相同的 recordObservation 写入路径（不含 journal/唤醒——负向只关心投影面），
 * 并用**不同的 groupCard** 让「别群昵称零泄露」成为可失败断言。
 */
function seedSiblingScopeMessage(
  h: OneBotHarness,
  input: { peerId: string; messageId: string; speaker: string; text: string; groupCard: string },
): void {
  const bindingId = crypto.randomUUID();
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId: "90001",
      conversationKind: "group",
      peerId: input.peerId,
      agentId: DEFAULT_AGENT_ID,
      schemeId: h.scheme.id,
      createdAt: h.now(),
      updatedAt: h.now(),
    })
    .run();
  const seconds = Math.floor(Date.parse(h.now()) / 1000);
  recordObservation(
    h.orm,
    {
      accountId: "90001",
      conversation: {
        kind: "group",
        peerId: input.peerId,
        key: `["qq",90001,"group",${input.peerId}]`,
      },
      eventKey: JSON.stringify(["qq", 90001, "group", input.peerId, input.messageId]),
      messageId: input.messageId,
      occurredAtSeconds: seconds,
      subType: "normal",
      speaker: {
        kind: "member",
        id: input.speaker,
        groupCard: input.groupCard,
        personalNickname: `${input.groupCard}昵称`,
        nameSource: "wire",
        displayName: input.groupCard,
      },
      segments: [{ kind: "text", text: input.text }],
      text: input.text,
      mentionsSelf: false,
      replyToMessageId: null,
    },
    DEFAULT_AGENT_ID,
  );
}

/**
 * 真实签发的 bodyRef（从模型输入里取，**不造值**）。取不到返回 null，由用例断言失败暴露。
 */
function issuedBodyRef(text: string): string | null {
  return (text.match(/"bodyRef":"([0-9a-f-]{36})"/) ?? [])[1] ?? null;
}

/** 主 run 的 run 快照（按 startedAt 倒序，listRuns 的真实返回序）。 */
function mainRuns(h: OneBotHarness): {
  runId: string;
  status: string;
  errorCode: string | null;
  startedAt: string;
}[] {
  return h.runs
    .listRuns({ ownerKind: "conversation", ownerId: h.conversationId })
    .filter((run) => run.specId === "onebot.main")
    .map((run) => ({
      runId: run.runId,
      status: run.status,
      errorCode: run.errorCode,
      startedAt: run.startedAt,
    }));
}

// ============================================================================
// [S13_1] localoutsidewindow（矩阵 13）
//   补块：原块 `not.toContain("get_msg")` 断的是全仓不存在的工具名（恒真），换成真实可失败
//        断言。平台回源面的真实负证据是「正文一次都没进输入」＋「整轮零取数相」：
//        引用正文只经 product 的本地 load（只查本地 SQLite），不经任何 fetch/回源通道。
//        不用「工具声明里没有某工具」当证据——link/web 是已批准的工具通路，
//        不该因为引用模式被禁止声明。
// ============================================================================

it("[S13_1] one_then_on_demand: an out-of-window quote body is never auto-supplied and never fetched from the platform", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
  });
  h.receive({ id: "-221", text: `窗口外原文标记XYZ13${"很长的原始正文。".repeat(40)}` });
  for (let index = 0; index < 12; index += 1) {
    h.advance(3);
    h.receive({ id: `${-713 - index}`, text: `填充消息${index}` });
  }
  h.receive({ id: "-222", text: "问上面那条", replyTo: "-221", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);

  // 强负（可失败）：窗口外正文一次都没进模型输入——本模式的自动一层只给关系。
  // 删掉「不自动供正文」或让深层自动展开，这一条立即失败。
  expect(occurrences(allText(h), "窗口外原文标记XYZ13")).toBe(0);
  // 强负（可失败）：整轮没有任何取数动作发生。deep 模式才会给正文，所以「零取数相」
  // 与上面「零正文」互为对照：任何一次 history.read/query 都会多出一个 next 相。
  expect(phases(h)).toEqual(["next", "generate"]);
  // 强负（可失败）：未读取视觉面零次（本条纯文字，图不在这条链路上）。
  expect(h.visionCalls).toHaveLength(0);
});

it("[S13_2] configured_depth: an unrecorded quote target keeps its relation and never gains a body", async () => {
  // 「不自动供正文」≠「不列关系」：configured_depth 下引用段才渲染。引用一个**从不记录**的
  // 平台 ID：关系必须列出，且不带任何正文或读取引用。
  // 口径事实（实测冻结）：引用段只渲染 `root.message !== null` 的根（context-source.ts:1461
  // 的 quoteRoots 过滤），missing/expired/cycle 根因此不进入 wire——本块只钉「关系在事实层
  // 完整保留 + 任何输入里都没有该目标的正文」，不断言缺失状态在段内的字面量。
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
  });
  h.receive({ id: "-231", text: "引用一条不存在的", replyTo: "-99999", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);

  // 正：关系在消息事实层完整保留（replyTo 只给平台消息 ID，不猜作者/正文）。
  const line = msgLine(factsText(h, 0), "-231");
  expect(line?.replyTo).toEqual({ platformMessageId: "-99999" });
  // 正：引用段把该关系列成一条 state=missing 的根——不可读状态**分别表达**（§4.3），
  // 指向仍在、去重不丢指向。
  const roots = quoteRoots(h, 0);
  expect(roots).not.toBeNull();
  expect(roots ?? []).toHaveLength(1);
  expect((roots ?? [])[0]?.state).toBe("missing");
  expect((roots ?? [])[0]?.depth).toBe(1);
  expect((roots ?? [])[0]?.target).toBe("-99999");
  // 强负（可失败）：missing 根不带任何正文、不带受限读取引用（未记录就没有可续读的东西）。
  expect((roots ?? [])[0]?.text).toBeUndefined();
  expect((roots ?? [])[0]?.bodyRef).toBeUndefined();
  // 强负（可失败）：全输入里 -99999 只出现**两次**——事实层的 replyTo 与引用段的
  // missing 根各一次；不得凭空生成第三处（正文/身份/时间）。
  expect(occurrences(callText(h, 0), "99999")).toBe(2);
});

// ============================================================================
// [S14_*] expired/missingunknown（矩阵 14）
//   补块三处：① 跨 scope 负向改**同库**（原块用两个独立 :memory: 库 ⇒ 结构上恒真）；
//        ② expired 面去掉「引用段整段不渲染」这一与被测语义无关的混淆，改为
//           configured_depth 下过期/未过期两条同结构目标的对照；③ 删除面用事实层字段断言。
// ============================================================================

it("[S14_1] a quote target in another scope of the same database leaks neither body nor identity", async () => {
  // 同库两 scope：本群（peerId 30004）引用别群（peerId 30003）的平台 ID。别群那条**真实
  // 落库**（走 recordObservation），所以这条负向可失败——去掉 SQL 的 scope 过滤即在此失败。
  // 原块用两个独立 :memory: 库，别群数据根本不在本库，属恒真。
  const h = createOneBotHarness({
    accountId: "90001",
    member: "20009",
    peerId: "30004",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    model: [decideGenerate("20009", "回答", []), say("合成回复正文")],
  });
  seedSiblingScopeMessage(h, {
    peerId: "30003",
    messageId: "-234",
    speaker: "20002",
    text: "别群机密SECRETTEXT14",
    groupCard: "别群名片CARD14",
  });
  // 前置事实：别群那条**确实**在本库里（否则下面的负向又是伪证）。
  const siblingEvent = h.db
    .query("SELECT COUNT(*) AS n FROM qq_events WHERE peer_id='30003' AND message_id='-234'")
    .get() as { n: number };
  expect(siblingEvent.n).toBe(1);
  const siblingBody = h.db
    .query("SELECT COUNT(*) AS n FROM qq_observation_text WHERE body LIKE '%SECRETTEXT14%'")
    .get() as { n: number };
  expect(siblingBody.n).toBe(1);

  h.receive({
    id: "-235",
    speaker: "20009",
    text: "引用别群试试",
    addressed: true,
    replyTo: "-234",
  });
  await h.activate("direct_reply");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  // 强负（可失败）：别群正文与昵称零泄露——任何泄露路径（去掉 scope 过滤、跨 scope load、
  // 跨群 bodyRef）都会让这两条失败。
  expect(occurrences(allText(h), "SECRETTEXT14")).toBe(0);
  expect(occurrences(allText(h), "别群名片CARD14")).toBe(0);
  // 正：本群这条的关系照常列出。
  expect(msgLine(factsText(h, 0), "-235")?.replyTo).toEqual({ platformMessageId: "-234" });
  // 正：跨范围拒绝**不得泄露别群是否存在**（§4.3 末句），所以这里用 missing 表达是正确的
  // fail-closed 口径——与同 scope 过期不同：那条能证明消息在本库存在过，故应说 expired；
  // 跨 scope 连存在性都不能暴露，只能说 missing。本块断的是**状态 + 零身份/零正文**，
  // 不断「跨 scope 也该说 expired」——那反而会泄露存在性。
  const roots = quoteRoots(h, 0);
  expect(roots).not.toBeNull();
  expect((roots ?? [])[0]?.state).toBe("missing");
  expect((roots ?? [])[0]?.target).toBe("-234");
  expect((roots ?? [])[0]?.text).toBeUndefined();
  // 强负：缺失根不得携带别群的任何身份 metadata（只有 from/target/state/depth）。
  expect(Object.keys((roots ?? [])[0] ?? {}).sort()).toEqual(["depth", "from", "state", "target"]);
});

it("[S14_2] an expired body is refused while a same-shaped live body stays available", async () => {
  // 过期 vs 未过期的对照：两条同结构、同形态的引用目标，只有生命周期不同。
  // 夹具时钟固定 2_000_000_000（2033-05-18）；观察正文保留期 14 天，故推进 15 天即过期。
  const expired = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
  });
  expired.receive({
    id: "-232",
    text: `过期原文标记EXPIRED14${"早就该被清理的正文。".repeat(20)}`,
  });
  expired.advance(15 * 24 * 60 * 60);
  expired.receive({ id: "-233", text: "引用过期消息", replyTo: "-232", addressed: true });
  await expired.activate("direct_reply");
  await expired.deliver();
  expect(phases(expired)).toEqual(["next", "generate"]);
  // 强负（可失败）：过期正文在**任何一次**模型输入里都不出现。
  expect(occurrences(allText(expired), "过期原文标记EXPIRED14")).toBe(0);
  // 正（规格 §4.3「不可读状态分别表达：未记录、**已过期**、已删除/撤权、旧关系缺失…」）：
  // 同 scope、有效 owner 的过期目标必须表达为 **expired**，与「未记录」的 missing 区分开。
  //
  // **这是真实 RED（spec 缺口）**，本轮按「真实状态缺口测试应 RED 保强要求」保留，不为绿认可实现：
  // loader `message-projection.ts:204` 在事实快照过期时 `return null`，于是
  // `expandQqReplies` 的 `load()` 拿到 null → 走「保持 missing」分支（reply-context.ts:250），
  // 真正的 `expired` 判定（reply-context.ts:223/253）对同 scope 过期目标**不可达**。
  // 实测边界（probes/tmp-probe-edge.ts）：13 天 → available（正文可读）；14/15/16 天 → missing。
  // 目标：产品让 loader 把「已过期」与「未记录」区分（或让 expand 侧能判过期）后本条转绿。
  const expiredRoots = quoteRoots(expired, 0);
  expect(expiredRoots).not.toBeNull();
  expect((expiredRoots ?? [])[0]?.state).toBe("expired");
  expect((expiredRoots ?? [])[0]?.target).toBe("-232");
  // 强负（可失败）：无论状态如何，过期正文与读取引用都不得出现（隐私面已成立）。
  expect((expiredRoots ?? [])[0]?.text).toBeUndefined();
  expect((expiredRoots ?? [])[0]?.bodyRef).toBeUndefined();

  // 对照组：同结构但未过期 → 正文真实可读。这让上面那条对「过期」敏感：若实现整体不供
  // 引用正文，它也会过；若实现忽略过期直接供，上面那条会失败。
  const live = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
  });
  live.receive({ id: "-232", text: `过期原文标记EXPIRED14${"早就该被清理的正文。".repeat(20)}` });
  for (let index = 0; index < 12; index += 1) {
    live.advance(3);
    live.receive({ id: `${-733 - index}`, text: `填充消息${index}` });
  }
  live.receive({ id: "-233", text: "引用未过期消息", replyTo: "-232", addressed: true });
  await live.activate("direct_reply");
  await live.deliver();
  expect(phases(live)).toEqual(["next", "generate"]);
  // 对照成立：同样的目标、同样 configured_depth，未过期时正文**确实**被自动供入一次
  // （决策相：引用段一次 + 事实段零次——窗外的根不进窗口事实）。
  expect(occurrences(callText(live, 0), "过期原文标记EXPIRED14")).toBe(1);
  expect((quoteRoots(live, 0) ?? [])[0]?.state).toBe("available");
  // 强负：过期那条不产生任何可读引用段行。
  expect(quoteSegmentText(expired, 0)).not.toContain("EXPIRED14");
});

it("[S14_3] a deleted body is never restored from the surviving fact snapshot", async () => {
  // 删除语义：正文行（qq_observation_text）被删后，快照里仍存着 text——不得借快照 parts 复活。
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
  });
  h.receive({ id: "-331", text: "已删正文标记DELETED14" });
  h.db.query("DELETE FROM qq_observation_text WHERE body LIKE '%DELETED14%'").run();
  const factStillHasText = h.db
    .query(
      "SELECT f.parts AS p FROM qq_message_facts f JOIN qq_events e ON e.event_key=f.event_key WHERE e.message_id='-331'",
    )
    .get() as { p: string };
  // 前置：快照里确实还留着 text（否则「不得复活」这条断言无意义）。
  expect(factStillHasText.p).toContain("DELETED14");
  h.receive({ id: "-332", text: "引用已删消息", replyTo: "-331", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  // 强负（可失败）：已删正文不得从快照 parts 复活。
  expect(occurrences(allText(h), "DELETED14")).toBe(0);
  // 正：不可读状态在引用段里**分别表达**——与 missing 区分开（实测：正文被删 ⇒ revoked）。
  const roots = quoteRoots(h, 0);
  expect(roots).not.toBeNull();
  expect((roots ?? [])[0]?.state).toBe("revoked");
  expect((roots ?? [])[0]?.target).toBe("-331");
  expect((roots ?? [])[0]?.text).toBeUndefined();
  // 强负：不得把已删正文当可读内容供出。
  expect(quoteSegmentText(h, 0)).not.toContain("DELETED14");
  // 关系仍在（不可读 ≠ 丢关系）。
  expect(msgLine(factsText(h, 0), "-332")?.replyTo).toEqual({ platformMessageId: "-331" });
});

// ============================================================================
// [S15_1] quotescycle（矩阵 15）
//   补块：原块根本没造出环（`:641` 的自引消息**没有 replyTo**），两条断言只是 toContain ID。
//        这里造**真实闭环**并断段内真状态：A(-250) 自引自身、B(-251 引 A)、焦点 C(-252 引 B)。
//        30 条填充把 A、B 挤出窗口 ⇒ BFS 走 C→B(d1)→A(d2)→A(d3 自引已在路径祖先) ⇒ cycle。
//   实测口径：cycle 根在 wire 上是 depth 3、`state:"cycle"`、`platformMessageId:null`
//        （环边指向路径祖先，不解析成具体目标），且不带 text/bodyRef。
// ============================================================================

it("[S15_1] a real quote cycle is marked cycle, every relation stays listed and each body is supplied once", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 4 },
    model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
  });
  h.receive({
    id: "-250",
    speaker: "20002",
    text: "环根A正文A250",
    groupCard: "甲",
    replyTo: "-250",
  });
  h.advance(1);
  h.receive({
    id: "-251",
    speaker: "20003",
    text: "环中B正文B251",
    groupCard: "乙",
    replyTo: "-250",
  });
  for (let index = 0; index < 30; index += 1) {
    h.advance(2);
    h.receive({ id: `${-1961 - index}`, speaker: "20020", text: `填充${index}` });
  }
  h.advance(2);
  h.receive({ id: "-252", speaker: "20002", text: "问环", addressed: true, replyTo: "-251" });
  const result = await h.activate("direct_reply");
  await h.deliver();
  expect(statusOf(result)).toBe("completed");
  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);

  const roots = quoteRoots(h, 0) ?? [];
  // 正：环被检出并**标成 cycle**——深度 3、无目标平台 ID、无正文、无读取引用。
  // 去掉防循环逻辑（或把它当普通根展开）这条立即失败。
  const cycle = roots.find((root) => root.state === "cycle");
  expect(cycle).toBeDefined();
  expect(cycle?.depth).toBe(3);
  // 环边不解析成具体目标：段内不带 platformMessageId/occurredAtSeconds（无目标元数据）。
  expect(cycle?.platformMessageId).toBeUndefined();
  expect(cycle?.occurredAtSeconds).toBeUndefined();
  expect(cycle?.text).toBeUndefined();
  expect(cycle?.bodyRef).toBeUndefined();
  // 强负（可失败，防无限展开）：环之外最多两层——不得因为成环就继续展开。
  expect(Math.max(...roots.map((root) => root.depth))).toBe(3);
  // 正：环上的两层照常供出正文（可读层不受环影响）。
  expect(roots.find((root) => root.platformMessageId === "-251")?.state).toBe("available");
  expect(roots.find((root) => root.platformMessageId === "-250")?.state).toBe("available");
  // 强负（可失败，规格 §4.3「同一消息最多供一次正文」）：**同一次调用整体**里 A、B 各恰一份。
  // 判据是整次调用输入的正文计数，不是分槽计数——分槽各一份也仍然是重复供正文。
  // （A、B 已被挤出窗口 ⇒ 正文应只由引用段供一份，时间线与事实段都不得再带。）
  expect(bodyCopiesIn(h, 0, "环中B正文B251")).toBe(1);
  expect(bodyCopiesIn(h, 0, "环根A正文A250")).toBe(1);
  // 诊断定位（不参与判定）：指出多出来的那一份在哪个段。
  expect(occurrences(timelineText(h, 0), "环根A正文A250")).toBe(0);
  expect(occurrences(factsText(h, 0), "环根A正文A250")).toBe(0);
  expect(occurrences(quoteSegmentText(h, 0), "环根A正文A250")).toBe(1);
  // 强负（可失败）：焦点消息自己的关系在事实层完整列出（去重不得因成环丢指向）。
  expect(msgLine(factsText(h, 0), "-252")?.replyTo).toEqual({ platformMessageId: "-251" });
});

// ============================================================================
// [S16_*] custom8depth（矩阵 16）
//   补块：原块的夹具算术不自洽（链为 -413→…→-405 是第 8 层，却断 depth8 ⇒ -402），
//        且无「正文不重复」断言。这里用**实测自洽**的金字塔：16 层链 + 14 条填充把链挤到
//        窗外，焦点引用链尾 ⇒ 深度阶梯恰好 1..8，第 9 层及更早四者全部不在 roots 内。
// ============================================================================

/** 造一条 N 层引用链（层 i 引层 i-1），再补 filler 把链挤到窗口外，最后焦点引链尾。 */
function buildDeepChain(h: OneBotHarness, length: number, filler: number): string[] {
  const ids = Array.from({ length }, (_, index) => String(-(701 + index)));
  ids.forEach((id, index) => {
    h.receive({
      id,
      speaker: `200${(index % 8) + 2}`,
      text: `层${index + 1}唯一正文MARK${index + 1}END`,
      groupCard: `成员${index + 1}`,
      ...(index === 0 ? {} : { replyTo: ids[index - 1] }),
    });
  });
  for (let index = 0; index < filler; index += 1) {
    h.advance(2);
    h.receive({ id: `${-1900 - index}`, speaker: "20020", text: `填充${index}` });
  }
  h.advance(2);
  h.receive({
    id: "-999",
    speaker: "20012",
    text: "问深链",
    addressed: true,
    replyTo: ids[length - 1],
  });
  return ids;
}

it("[S16_1] configured_depth=8 expands the chain exactly to depth 8 and stops", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 8 },
    model: [decideGenerate("20012", "回答", []), say("合成回复正文")],
  });
  const ids = buildDeepChain(h, 16, 14);
  await h.activate("direct_reply");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);

  const roots = quoteRoots(h, 0);
  expect(roots).not.toBeNull();
  // 正：深度阶梯自洽——第 8 层恰为链上第 8 跳，且最大深度恰为配置值 8。
  const byDepth = new Map<number, string[]>();
  for (const root of roots ?? []) {
    byDepth.set(root.depth, [...(byDepth.get(root.depth) ?? []), root.platformMessageId ?? ""]);
  }
  expect(Math.max(...(byDepth.keys() ?? [0]))).toBe(8);
  // 深度阶梯的**完整有序 golden**（实测冻结，链长 14、焦点引链尾 ids[13]）：
  // 窗口占最近 6 条链消息（ids[8..13]）⇒ depth1 的窗外目标从 ids[7] 起算，
  // 于是 depth d（d≥2）落在 ids[15 - d - 2] …… 即 d=2→ids[9]、d=8→ids[3]。
  // 逐条钉死，避免只断一个点而让中间层漂移（原块就是这样没约束住行为）。
  const ladder: [number, string][] = [
    [2, ids[9] ?? "none"],
    [3, ids[8] ?? "none"],
    [4, ids[7] ?? "none"],
    [5, ids[6] ?? "none"],
    [6, ids[5] ?? "none"],
    [7, ids[4] ?? "none"],
    [8, ids[3] ?? "none"],
  ];
  for (const [depth, platformId] of ladder) {
    expect(byDepth.get(depth) ?? []).toContain(platformId);
  }
  // 强负（可失败）：第 9 层及更早（ids[2]/ids[1]/ids[0]）**不得**出现在任何一根里。
  // 放开深度上限即失败——这就是「custom 8 depth」的真边界。
  const allIds = new Set((roots ?? []).map((root) => root.platformMessageId));
  for (const index of [2, 1, 0]) {
    expect(allIds.has(ids[index] ?? "none")).toBe(false);
  }
  // 强负（可失败，「同一消息最多供一次正文」）：被展开的每一层正文在消息事实段恰好一次
  // （窗外层由引用段供、窗内层由事实段供；任何一层被供两次即失败）。
  for (const [, platformId] of ladder) {
    const layer = ids.indexOf(platformId) + 1;
    // 强负（可失败，§4.3）：同一次调用整体里该层正文恰一份（窗外层由引用段供）。
    expect(bodyCopiesIn(h, 0, `MARK${layer}END`)).toBe(1);
    // 诊断定位（不参与判定）。
    expect(occurrences(quoteSegmentText(h, 0), `MARK${layer}END`)).toBe(1);
    expect(occurrences(timelineText(h, 0), `MARK${layer}END`)).toBe(0);
    expect(occurrences(factsText(h, 0), `MARK${layer}END`)).toBe(0);
  }
});

it("[S16_2] reply_depth=1 keeps only the first layer and reads no deeper", async () => {
  // 边界对照：reply_depth=1 ⇒ 深度阶梯上限为 1，深层链**一条都不展开**。
  // 这让 S16_1 的 depth 断言对「配置值真的生效」敏感，而不是恒真。
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 1 },
    model: [decideGenerate("20012", "回答", []), say("合成回复正文")],
  });
  buildDeepChain(h, 16, 14);
  await h.activate("direct_reply");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "generate"]);
  const roots = quoteRoots(h, 0) ?? [];
  expect(roots.length).toBeGreaterThan(0);
  // 强负（可失败）：没有任何 depth≥2 的根。
  expect(roots.some((root) => root.depth >= 2)).toBe(false);
  // 强负（可失败）：深度上限 1 ⇒ 窗外那些链层正文**一次都不供**
  // （depth=8 时它们各自供一次；这里全为 0，证明配置值真的裁住了展开）。
  for (let layer = 1; layer <= 9; layer += 1) {
    expect(occurrences(allText(h), `MARK${layer}END`)).toBe(0);
  }
  // 窗内层（最近 6 条）照常供一次——不因裁深度丢窗口消息。判据同 §4.3：整次调用内恰一份。
  expect(bodyCopiesIn(h, 0, `MARK14END`)).toBe(1);
});

// ============================================================================
// [S17_1] windowdedup（矩阵 17）
//   补块：原块只查了 roots 段不含正文。本块把「只供一次」升级为**每个数据槽内恰好一份**
//   （时间线槽一份 ＋ 事实段槽一份 ＋ 引用段零份；槽内多一份才算重复供正文）。
// ============================================================================

it("[S17_1] two quotes of the same in-window target supply its body exactly once and add no tool call", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 4 },
    model: [decideGenerate("20004", "回答", []), say("合成回复正文")],
  });
  h.receive({ id: "-261", speaker: "20002", text: "共享目标正文L17", groupCard: "甲" });
  h.receive({ id: "-262", speaker: "20003", text: "甲引用", groupCard: "乙", replyTo: "-261" });
  h.receive({
    id: "-263",
    speaker: "20004",
    text: "我也引用",
    addressed: true,
    groupCard: "丙",
    replyTo: "-261",
  });
  await h.activate("direct_reply");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);

  // 正：两个根都在，且都标 in_window（正文由窗口本体供一次，引用区只指向它）。
  const roots = quoteRoots(h, 0);
  expect(roots).not.toBeNull();
  expect(roots ?? []).toHaveLength(2);
  for (const root of roots ?? []) expect(root.state).toBe("in_window");
  // 强负（可失败，规格 §4.3「原消息已完整在本轮窗口中：正文只供一次」）：**同一次调用整体**
  // 里共享目标正文恰一份。两条引用不得让任一段多出一份；分槽各一份同样是重复。
  expect(bodyCopiesIn(h, 0, "共享目标正文L17")).toBe(1);
  // 强负：引用区（metadata-only）不携带第二份正文。
  expect(quoteSegmentText(h, 0)).not.toContain("共享目标正文L17");
  // 强负：正文只来自消息事实段（窗口消息本体）。旧 `## 近期群聊` 时间线**不再重复正文**
  // （统一 renderer 正文源），所以那一段必须是 0 份；正文若再被复制一份，这里就会 ≠ 1。
  expect(occurrences(factsText(h, 0), "共享目标正文L17")).toBe(1);
  expect(occurrences(timelineText(h, 0), "共享目标正文L17")).toBe(0);
  // 强负：正文不经取数工具取得——相位数恰为二（任何 history.read/query 多一个 next 相）。
  expect(phases(h)).toEqual(["next", "generate"]);
});

// ============================================================================
// [S18_1] deepprune（矩阵 18）
//   补块：原块只有「深层被裁」一半，缺「先删最深最早」的排序对照。这里造浅层/深层抢预算
//        的对照：直接层完整保留（complete=true），深层被裁成受限页——按 spec §4.4 的
//        「先保浅层直接原消息、深层/最早先裁」钉死。
// ============================================================================

it("[S18_1] over-budget: the shallow direct root stays complete while the deep root is cut to a limited page", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 4 },
    model: [decideGenerate("20004", "回答", []), say("合成回复正文")],
  });
  // 直接层（-272，正文中等）与深层（-271，正文极大）同时抢引用段预算。
  h.receive({
    id: "-271",
    speaker: "20002",
    text: `深层根正文M18${"很深很长的引用正文。".repeat(3000)}`,
    groupCard: "甲",
  });
  h.advance(1);
  h.receive({
    id: "-272",
    speaker: "20003",
    text: `中链M18${"中链的引用正文。".repeat(1200)}`,
    groupCard: "乙",
    replyTo: "-271",
  });
  for (let index = 0; index < 14; index += 1) {
    h.advance(2);
    h.receive({ id: `${-1950 - index}`, speaker: "20005", text: `填充${index}` });
  }
  h.advance(2);
  h.receive({ id: "-274", speaker: "20004", text: "问深层", addressed: true, replyTo: "-272" });
  await h.activate("direct_reply");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);

  const roots = quoteRoots(h, 0) ?? [];
  const shallow = roots.find((root) => root.platformMessageId === "-272");
  const deep = roots.find((root) => root.platformMessageId === "-271");
  expect(shallow).toBeDefined();
  expect(deep).toBeDefined();
  // 正：浅层直接根完整保留（complete=true，全文进段）。
  expect(shallow?.state).toBe("available");
  expect(shallow?.complete).toBe(true);
  // 强负（可失败，先删最深）：深层根被裁——标 budget_limited 且**没有正文页**。
  // 深层整段超余量时按 §4.4 直接裁掉（不占名额、不冒充空原消息）；关系行仍在。
  expect(deep?.state).toBe("budget_limited");
  expect(deep?.text).toBeUndefined();
  expect(deep?.platformMessageId).toBe("-271");
  // 强负：深层正文整篇未进输入（被裁的只是页，不是全文）。
  expect(occurrences(allText(h), "很深很长的引用正文。".repeat(3000))).toBe(0);
  // 强负：窗口消息保留（超预算不得删窗口消息）。
  expect(callText(h, 0)).toContain("-272");
  expect(callText(h, 0)).toContain("-274");
});

// ============================================================================
// [S19_1] directpartial（矩阵 19 前半：按 Unicode 前缀页 + 关系 + 受限读取引用）
//   补块：原块在 configured_depth 下「自动供入」污染了续读断言，且根本没断 bodyRef。
//        这里只验规格可执行的半边：直接层超预算 ⇒ 前缀页（complete=false、offset/nextOffset/
//        total、Unicode 边界）+ 关系与 bodyRef 在位 + 尾部标记不在场（真被裁，不冒充全文）。
// ============================================================================

it("[S19_1] an over-budget direct quote yields a unicode prefix page plus a registered bodyRef and keeps the relation", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    model: [decideInline("20002", "基于引用的回答")],
  });
  const body = `续读正文标记XYZ19${"被引用的原始正文。".repeat(2000)}续读尾标记TAIL19`;
  h.receive({ id: "-281", text: body });
  for (let index = 0; index < 12; index += 1) {
    h.advance(3);
    h.receive({ id: `${-820 - index}`, text: `填充消息${index}` });
  }
  h.receive({ id: "-282", text: "问一下上面那条", replyTo: "-281", addressed: true });
  const result = await h.activate("direct_reply");
  await h.deliver();
  expect(statusOf(result)).toBe("completed");
  expect(h.sent).toHaveLength(1);

  const roots = quoteRoots(h, 0);
  expect(roots).not.toBeNull();
  const root = (roots ?? [])[0];
  // 正：直接层关系在位。
  expect(root?.depth).toBe(1);
  expect(root?.platformMessageId).toBe("-281");
  // 正：预算未完整提供 ⇒ 标 budget_limited、complete=false，并给出分页三件套。
  expect(root?.state).toBe("budget_limited");
  expect(root?.complete).toBe(false);
  expect(root?.offset).toBe(0);
  expect(typeof root?.total).toBe("number");
  expect(root?.total).toBe([...body].length);
  expect(typeof root?.nextOffset).toBe("number");
  expect(root?.nextOffset).toBe(root?.text?.length);
  // 正：受限读取引用真实签发（UUID），不是占位串。
  expect(typeof root?.bodyRef).toBe("string");
  expect(root?.bodyRef).toMatch(/^[0-9a-f-]{36}$/);
  // 强负（可失败）：真的被裁了——尾部标记不在场（不是全文冒充前缀页）。
  expect(occurrences(callText(h, 0), "续读尾标记TAIL19")).toBe(0);
  // 强负（可失败）：正文只供预算内那段；重复供同一正文会突破前缀页长度。
  expect(occurrences(quoteSegmentText(h, 0), "续读正文标记XYZ19")).toBe(1);
  // 强负（可失败）：不冒充空原消息——页内容非空。
  expect(root?.text?.length ?? 0).toBeGreaterThan(0);
  // 强负（可失败）：不把整轮打死。
  expect(phases(h)).toEqual(["next"]);
});

// ============================================================================
// [S19_2] history 续读（同 run history.read）
//   形态：单次 activate ＋ 动态端口——在**第一次 request**（刚渲染出被裁前缀页的那次装配）里
//   读到本轮真实签发的 bodyRef，就地返回 history.read invoke；Runtime 执行动作后**同一 run**
//   再发下一次决策。续读按真实分页：history.read 的 limit 上限 4096（模块内
//   `Math.min(input.limit, 4096)`），所以要用**前缀页的 nextOffset 继续往后翻页**才能取到文末，
//   不能靠一次大 limit。跨 run 复用 ref 必须被拒（由 S20_1 覆盖），本块只管同 run 成功续读。
//   产品侧桥（已落地并核实于当前源码）：register 回调用 `fact.platformMessageId` 调 locateHistory
//   铸造合法 history tuple Evidence（context-source.ts:1493-1502），不再用不可读的 plain id。
// ============================================================================

it("[S19_2] the same run continues reading a partial quote body through the bodyRef it was issued", async () => {
  // 单 run：动态端口在**第一次 request**（刚装配出被裁前缀页的那次）里读到本轮真实签发的
  // bodyRef（真 UUID），从根上**真实的 nextOffset** 起按 history.read 的真实分页续读。
  // 观察解析严格按生产 ActionObservation/contextDumps 形状：只认
  // kind=action_observation 且 value.name="history.read" 且 value.arguments.bodyRef=本次 bodyRef
  // 的**最新**一条，取其 value 内真实 status/code/items[0] 的 text 长度/offset/nextOffset/total。
  // 找不到匹配观察 ≠ 读完：那属于「不可用/不前进」，可以 final 收口但**后续强断必须失败**，
  // 不把 completed 当续读成功。
  // 终止条件有界：每次 invoke 都是本 run 内一个真实工具 step（受既有总步骤预算约束），
  // 不抬 maxSteps/容量、不改 schema；不前进或不可用即收口。
  let step = 0;
  let requested: string | null = null;
  let offset: number | null = null;
  /** 首 request 根上的**真实** total（码点）与 nextOffset，冻结后不再改动——终页自洽的独立锚。 */
  let rootTotal: number | null = null;
  let rootNextOffsetAtStart: number | null = null;
  // 端口侧计数：模型**选择**发 invoke 的次数。与 executor 真实执行数分开对账（见下）。
  let chosenInvocations = 0;
  let matchedPages = 0;
  let stopReason: string | null = null;
  /** 本块局部：避免跨 test 的全局污染。 */
  const readTrace: ReadTrace[] = [];
  /** 每次 invoke 的原始请求/返回记录（供离线重放解析）。 */
  const invokeJournal: {
    requestIndex: number;
    requestedBodyRef: string | null;
    sentArguments: Record<string, unknown> | null;
    responseTextParts: readonly string[];
  }[] = [];
  /**
   * **本块局部**的逐次完整 request text 捕获：本用例传的是**对象端口**（非 steps 数组），
   * 夹具不会建 scriptedModel，故 `h.model === null`，`h.model?.receivedMessages` 是空面。
   * 这里直接从端口自身逐次调用捕获完整 request.messages 的全部 text part 原文
   * （不取 calls[].text 的 4000 截断摘要，也不做摘要/正则），供首 request 负断、
   * 尾到达正断与落盘回放共用同一个真实面。
   */
  const callTextParts: string[][] = [];
  const port: Partial<ModelPort> = {
    async complete(request) {
      step += 1;
      const requestIndex = step;
      // 每次调用都捕获（含首 request），全量不截断。
      callTextParts.push(
        (request.messages ?? []).flatMap((message) =>
          message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
        ),
      );
      if (step > 1) {
        // 记录本次请求的**每个 text part 原文**（全量，不截断），供离线重放。
        invokeJournal.push({
          requestIndex,
          requestedBodyRef: requested,
          sentArguments: { bodyRef: requested, offset: offset ?? 0, limit: 4096 },
          responseTextParts: (request.messages ?? []).flatMap((message) =>
            message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
          ),
        });
      }
      // 只认本步请求所报 offset 对应的那条观察：同 ref 的旧观察不得用来推进。
      const observation =
        requested === null ? null : latestHistoryRead(request.messages ?? [], requested, offset);
      // 终页成功（①）：用**首 request 冻结的 rootTotal** 作独立锚，不用「自己等自己」的同表达式。
      // 另需：item.bodyRef 与本次 UUID 同一个、item.offset === arguments.offset === 本步请求的 offset。
      const terminalEnd =
        observation !== null &&
        observation.page !== null &&
        observation.page.nextOffset === null &&
        // page 非 null ⇒ offset 必是真 number（构造不变量），缺 offset 页不得按 0 冒充终页自洽。
        observation.page.offset + (observation.textLength ?? -1) === rootTotal;
      const tailOk =
        observation !== null &&
        observation.status === "ok" &&
        observation.page !== null &&
        observation.page.nextOffset === null &&
        observation.tailInPage &&
        terminalEnd &&
        observation.itemBodyRef === requested &&
        observation.page.offset === observation.argsOffset &&
        observation.argsOffset === offset;
      if (step === 1) {
        requested = issuedBodyRef(requestText(request));
        offset = quoteNextOffset(requestText(request));
        rootTotal = quoteRootTotal(requestText(request));
        rootNextOffsetAtStart = offset;
        chosenInvocations += 1;
        readTrace.push({
          requestIndex,
          bodyRef: requested,
          chosenOffset: offset,
          chosenLimit: 4096,
          stopReason: null,
          observation: null,
        });
        return JSON.stringify({
          kind: "invoke",
          name: "history.read",
          arguments: { bodyRef: requested ?? "unset", offset: offset ?? 0, limit: 4096 },
        });
      }
      // 尾命中：必须是 status ok、nextOffset 为 null、TAIL 落在**该页 text 内**且该页自洽。
      // 整份 request 文本里出现 TAIL（含自动引用前缀带来的）**不算**成功。
      if (tailOk) {
        stopReason = "tail_reached";
        readTrace.push({
          requestIndex,
          bodyRef: requested,
          chosenOffset: offset,
          chosenLimit: null,
          stopReason,
          observation,
        });
        return JSON.stringify({
          kind: "final",
          outputs: [{ kind: "inline", targetId: "20002", text: "读完了", stickerIds: [] }],
        });
      }
      // 中间页可用：status ok、有页、nextOffset 非 null 且严格前进。
      const usable =
        observation !== null &&
        observation.status === "ok" &&
        observation.page !== null &&
        observation.page.nextOffset !== null &&
        observation.page.nextOffset === observation.page.offset + (observation.textLength ?? -1) &&
        observation.page.nextOffset > (offset ?? 0);
      if (!usable) {
        stopReason =
          observation === null
            ? "no_matching_observation"
            : observation.status !== "ok"
              ? `unavailable:${observation.code ?? "no_code"}`
              : observation.page === null
                ? "no_page"
                : observation.page.nextOffset === null
                  ? "terminal_page_without_tail"
                  : "no_advance";
        readTrace.push({
          requestIndex,
          bodyRef: requested,
          chosenOffset: offset,
          chosenLimit: null,
          stopReason,
          observation,
        });
        return JSON.stringify({
          kind: "final",
          outputs: [{ kind: "inline", targetId: "20002", text: "读完了", stickerIds: [] }],
        });
      }
      offset = observation.page.nextOffset ?? offset;
      chosenInvocations += 1;
      matchedPages += 1;
      readTrace.push({
        requestIndex,
        bodyRef: requested,
        chosenOffset: offset,
        chosenLimit: 4096,
        stopReason: null,
        observation,
      });
      return JSON.stringify({
        kind: "invoke",
        name: "history.read",
        arguments: {
          bodyRef: requested ?? "unset",
          offset: observation.page.nextOffset,
          limit: 4096,
        },
      });
    },
  };

  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    // 真实观测面（既有 opt-in 选项，不改 harness 源码）：AgentRuntime 用它发 agent.action span，
    // span 经 RuntimeSpanRepository 落 runtime_spans，可按 runId 读回**真实动作计数**。
    telemetry: true,
    model: port,
  });
  h.receive({
    id: "-281",
    text: `续读正文标记XYZ19${"被引用的原始正文。".repeat(2000)}续读尾标记TAIL19`,
  });
  for (let index = 0; index < 12; index += 1) {
    h.advance(3);
    h.receive({ id: `${-820 - index}`, text: `填充消息${index}` });
  }
  h.receive({ id: "-282", text: "问一下上面那条", replyTo: "-281", addressed: true });

  let result: unknown = null;
  let thrown: unknown = null;
  let delivered: unknown = null;
  try {
    try {
      result = await h.activate("direct_reply");
    } catch (error) {
      thrown = error;
    }
    // deliver 的异常单独留痕（不与 activate 的混在一起），且不吞：它会让本 test 真红。
    try {
      await h.deliver();
    } catch (error) {
      delivered = error;
    }
  } finally {
    // ---- ③ raw capture：在**任何 assert 之前**、且 activate/deliver 任一抛都照落 ----
    // 放在 finally 里，保证硬失败路径也有对象证据；写盘自身抛出会覆盖原错误（不掩盖失败）。
    const tracePath = process.env.S19_TRACE_PATH;
    if (tracePath) {
      const snapshotRun =
        (mainRuns(h)[0]?.runId ?? null) !== null
          ? h.runs.getRun(mainRuns(h)[0]?.runId ?? "")
          : null;
      // 时钟域说明：span 的 expires_at 由真实墙钟冻结（runtime-telemetry.ts），而 page 的
      // now 默认也是墙钟。**不传第三参**，避免用 harness 业务时钟（nowSeconds≈2033）去比墙钟 TTL
      // （2026），那会把刚写的 span 全当过期滤掉。业务消息/reader/supplement 面仍用 h.now()。
      const snapshotSpans =
        h.telemetry !== null && snapshotRun?.runId
          ? new RuntimeSpanRepository(h.db).page({ runId: snapshotRun.runId, limit: 200 }).items
          : [];
      await Bun.write(
        tracePath,
        JSON.stringify(
          {
            requested,
            stopReason,
            chosenInvocations,
            matchedPages,
            rootTotal,
            rootNextOffsetAtStart: rootNextOffsetAtStart,
            offsetAtEnd: offset,
            activateError: thrown === null ? null : String(thrown),
            deliverError: delivered === null ? null : String(delivered),
            // executor 侧真实 span（RuntimeTelemetry 落 runtime_spans，按 runId 读回）
            spans: snapshotSpans.map((span) => ({
              name: span.name,
              stage: span.stage,
              status: span.status,
              code: span.code,
              runId: span.runId,
              finishedAt: span.finishedAt,
              details: span.details,
            })),
            runSteps: (snapshotRun?.steps ?? []).map((step) => ({
              stepId: step.stepId,
              stepNo: step.stepNo,
              phase: step.phase,
              status: step.status,
              errorCode: step.errorCode ?? null,
            })),
            runStatus: snapshotRun?.status ?? null,
            runErrorCode: snapshotRun?.errorCode ?? null,
            // 端口逐步选择与匹配页
            trace: readTrace,
            // 每次 invoke 的原始 text part 全文（全量，不截断）
            invokeJournal,
            // 端口自身逐次捕获的**完整** request text part 原文（首 request 在内）：
            // 本用例是对象端口，夹具不建 scriptedModel ⇒ h.model === null，
            // 故不读 h.model?.receivedMessages（那会是空面、断言恒真）。
            allCallTextParts: callTextParts.map((textParts, callIndex) => ({
              callIndex,
              textParts,
            })),
          },
          null,
          2,
        ),
      );
    }
  }

  // ---- 强断：先「真实次数 / 页面自洽 / executor 对账」，再断尾到达 ----
  // 前置：第一次 request 带的是本轮真实签发的 ref（真 UUID，不是平台消息 ID）。
  expect(requested).not.toBeNull();
  expect(requested).toMatch(/^[0-9a-f-]{36}$/);
  expect(requested).not.toBe("-281");
  expect(rootTotal).not.toBeNull();
  expect(rootNextOffsetAtStart ?? 0).toBeGreaterThan(0);
  // 前置：首轮只有前缀页，尾标记**在首 request 全文内**也不在场。
  // 读**端口自身**捕获的首 request 完整 text part（不用 4000 截断摘要面、不用 h.model 空面）。
  expect(occurrences((callTextParts[0] ?? []).join("\n"), TAIL_MARKER)).toBe(0);
  // 硬失败必须消失（activate 与 deliver 任一抛都真红；deliver 的错误不留痕吞掉）。
  expect(thrown).toBeNull();
  expect(delivered).toBeNull();
  expect(statusOf(result)).toBe("completed");
  // 真实 run 只有一条、errorCode null、steps >= 2（不靠二次 activate，不抬 maxSteps）。
  const runs = mainRuns(h);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.status).toBe("completed");
  expect(runs[0]?.errorCode).toBeNull();
  const runId = runs[0]?.runId ?? null;
  expect(runId).not.toBeNull();
  expect(h.runs.getRun(runId ?? "")?.steps.length ?? 0).toBeGreaterThanOrEqual(2);

  // ② executor 侧真实执行记录：**RuntimeTelemetry 落的 agent.action span**。
  // runtime 在 executeBatch 外包 this.trace(active,"agent.action",{stage:"action",
  // details:{actions: planned.map(name).join(",")}}, …{actionCount,readCount})。
  // 不碰 agent_steps（只有 phase/status/error_code、无动作名），也不用 run_events 代替执行面。
  expect(h.telemetry).not.toBeNull();
  // 时钟域说明：page 的第三参 now 只用于 expires_at 可见性过滤，而 span 的 expires_at 按真实
  // 墙钟冻结；传 h.now()（harness 业务时钟 nowSeconds≈2033）会把墙钟 TTL（2026）的 span 全滤掉。
  // 故这里**不传第三参**，用 page 自己的墙钟默认，业务消息/reader/supplement 面仍走 h.now()。
  const spans = new RuntimeSpanRepository(h.db).page({ runId: runId ?? "", limit: 200 }).items;
  const actionSpans = spans.filter(
    (span) => span.name === "agent.action" && span.stage === "action",
  );
  // 本场景每次 invoke 恰一个动作 ⇒ 每 span actionCount=readCount=1。
  // span 面缺失或对不上即**如实失败**并报缺口，不放宽成 >=、不拿 steps 总数冒充执行数。
  expect(actionSpans.length).toBe(chosenInvocations);
  const spanActionTotal = actionSpans.reduce(
    (sum, span) =>
      sum + (typeof span.details.actionCount === "number" ? span.details.actionCount : 0),
    0,
  );
  const spanReadTotal = actionSpans.reduce(
    (sum, span) => sum + (typeof span.details.readCount === "number" ? span.details.readCount : 0),
    0,
  );
  expect(spanActionTotal).toBe(chosenInvocations);
  expect(spanReadTotal).toBe(chosenInvocations);
  for (const span of actionSpans) {
    expect(span.details.actions).toBe("history.read");
    expect(span.details.actionCount).toBe(1);
    expect(span.details.readCount).toBe(1);
    expect(span.runId).toBe(runId);
    // 成功语义断 status（真实契约：ended span 的 status 转 completed），finishedAt 只是时间戳。
    expect(span.status).toBe("completed");
    expect(span.finishedAt).not.toBeNull();
  }
  // 端口选择发 invoke 的次数：≥1 且有界（既有总步骤预算内，不抬上限）。
  expect(chosenInvocations).toBeGreaterThanOrEqual(1);
  expect(chosenInvocations).toBeLessThanOrEqual(8);
  const okPages = readTrace.flatMap((entry) =>
    entry.observation?.status === "ok" ? [entry.observation] : [],
  );
  // 页面自洽（只对 status=ok 的匹配页）：
  // item.bodyRef 同本次 UUID；item.offset === arguments.offset；中间页 nextOffset **精确等于**
  // offset+本页码点长度；终页页尾 === 首 request 冻结的 rootTotal（独立锚，非同表达式自证）。
  for (const observation of okPages) {
    expect(observation.itemBodyRef).toBe(requested);
    // ok 页必须有真实 page/offset：缺失直接硬失败并落记录，不用 ?? 0 默认值冒充真实 offset。
    expect(observation.page).not.toBeNull();
    if (!observation.page) throw new Error("ok observation missing real page (no real offset)");
    // arguments 侧 offset 也必须是真实 number：null 直接硬失败，不用 ?? 0 冒充。
    expect(observation.argsOffset).not.toBeNull();
    if (observation.argsOffset === null) {
      throw new Error("ok observation missing real argsOffset (no real request offset)");
    }
    expect(observation.page.offset).toBe(observation.argsOffset);
    expect(observation.textLength ?? 0).toBeGreaterThan(0);
    if (observation.page.nextOffset !== null) {
      expect(observation.page.nextOffset).toBe(
        observation.page.offset + (observation.textLength ?? -1),
      );
    } else {
      expect(rootTotal).not.toBeNull();
      if (rootTotal === null) throw new Error("rootTotal missing at terminal page");
      expect(observation.page.offset + (observation.textLength ?? -1)).toBe(rootTotal);
    }
  }
  // 收口原因必须被记录：TAIL 命中才是「续读完成」。
  expect(stopReason).not.toBeNull();
  if (stopReason !== "tail_reached") {
    throw new Error(
      `history.read did not reach the tail: stopReason=${stopReason} ` +
        `chosenInvocations=${chosenInvocations} matchedPages=${matchedPages} ` +
        `executorActionSpans=${actionSpans.length} spanActionTotal=${spanActionTotal} ` +
        `trace=${JSON.stringify(readTrace)}`,
    );
  }
  // ④ 尾到达强断：TAIL 必须真落在**该匹配页的 text 内**（该页 text 由解析器从真实
  // action_observation 的 items[0].text 逐字取回，不用摘要/正则/截断面），
  // 且终页页尾 === 首 request 冻结的 rootTotal（独立锚，见上）。
  const lastPage = okPages.at(-1);
  expect(lastPage?.tailInPage).toBe(true);
  expect(lastPage?.page?.nextOffset).toBeNull();
  expect(lastPage?.itemBodyRef).toBe(requested);
  expect(occurrences(lastPage?.page?.text ?? "", TAIL_MARKER)).toBeGreaterThan(0);
  // 端口自身捕获的**最后一次** request 全文里也必须见得到 TAIL（同一真实面，
  // 不经 h.model?.receivedMessages，避免对象端口下空面恒真）。
  expect(occurrences((callTextParts.at(-1) ?? []).join("\n"), TAIL_MARKER)).toBeGreaterThan(0);
  // 强负：一次发送，续读不多发。
  expect(h.sent).toHaveLength(1);
});

// ============================================================================
// [S20_1] forgeref/crossrun（矩阵 20）
//   补块三处：① 删掉原块 `errorCode ?? "CONTEXT_INVALID_SELECTION"` 恒真兜底，按 startedAt
//        精确锁定**第二轮**那条 run；② 真跨 run：第一轮真实签发的 bodyRef 在第二轮被拒；
//        ③ 伪造一个「形状合法但本轮从未披露」的 ref，同样被拒（旧正文不复活）。
// ============================================================================

it("[S20_1] a bodyRef issued in an earlier run is refused with an explicit code and the old body never revives", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    model: [decideInline("20002", "第一轮回答")],
  });
  h.receive({ id: "-291", text: `跨轮正文标记XYZ20${"第一轮的原始正文。".repeat(2000)}` });
  for (let index = 0; index < 12; index += 1) {
    h.advance(3);
    h.receive({ id: `${-830 - index}`, text: `填充消息${index}` });
  }
  h.receive({ id: "-292", text: "问一下上面那条", replyTo: "-291", addressed: true });
  const first = await h.activate("direct_reply");
  await h.deliver();
  expect(statusOf(first)).toBe("completed");
  expect(h.sent).toHaveLength(1);
  // 第一轮真实签发的 bodyRef（从第一轮输入里取，不造值）。
  const realRef = issuedBodyRef(callText(h, 0));
  expect(realRef).not.toBeNull();
  const firstRunStartedAt = mainRuns(h)[0]?.startedAt ?? "";
  expect(firstRunStartedAt).not.toBe("");

  // 第二轮：复用第一轮的 ref。必须硬失败并带**明确 code**。
  h.advance(5);
  h.receive({ id: "-293", text: "再来一次", addressed: true });
  h.model?.push([
    decideInvoke("history.read", { bodyRef: realRef ?? "unset", offset: 0, limit: 2048 }),
  ]);
  let result: unknown = null;
  let thrown: unknown = null;
  try {
    result = await h.activate("direct_reply");
  } catch (error) {
    thrown = error;
  }
  const failed = thrown !== null || statusOf(result) === "failed";
  expect(failed).toBe(true);

  // 明确 code：**先锁定第二轮那条 run**（startedAt 严格晚于第一轮），再断它的 errorCode。
  // 不再用 `?? "CONTEXT_INVALID_SELECTION"` 兜底（原块那行无论真实码是什么都会过）。
  const runs = mainRuns(h);
  expect(runs.length).toBeGreaterThanOrEqual(2);
  const secondRun = runs.find((run) => run.startedAt > firstRunStartedAt);
  expect(secondRun).toBeDefined();
  expect(secondRun?.status).toBe("failed");
  expect(secondRun?.errorCode).toBe("CONTEXT_INVALID_SELECTION");
  // 强负（可失败，「旧正文不复活」的准确口径）：第二轮那条 run **没有走到任何一次模型
  // 续读调用**——history.read 在取回任何内容之前就被拒了，所以第二轮唯一那次决策输入
  // 里不得出现「history.read 的返回体」（旧正文经受限引用读回的那一份）。
  // 注意口径：第二轮决策输入**仍会**合法地再次引用同一条仍可读的窗口外消息（那是本轮
  // 独立授权的自动展开，不是旧正文复活），故断点取「动作观察里的续读结果」而非标记本身。
  // 断点：第二轮只发生**一次**模型调用（决策相），且在动作执行阶段即被拒，
  // 因此没有任何「续读结果」进入上下文——动作观察要等下一次决策才被拼进输入，
  // 而这次 run 根本没有下一次决策。工具*声明*在场是正常的（每轮都声明），
  // 断的是**观察**（返回值）。
  expect(h.model?.calls.length ?? 0).toBe(2); // 第一轮 next + 第二轮 next（被拒即止）
  expect(occurrences(callText(h, 1), '"kind":"action_observation"')).toBe(0);
  // 强负（可失败）：不重发——第二轮零发送，仍只有第一轮那一条。
  expect(h.sent).toHaveLength(1);
  expect(JSON.stringify(h.sent[0]?.message)).toContain("第一轮回答");
});

it("[S20_2] a well-shaped bodyRef that was never disclosed in this run is refused with the same code", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    model: [decideInline("20002", "回答")],
  });
  h.receive({ id: "-295", text: "普通一句", addressed: true });
  const first = await h.activate("direct_reply");
  await h.deliver();
  expect(statusOf(first)).toBe("completed");
  const before = mainRuns(h);
  const firstStartedAt = before[0]?.startedAt ?? "";

  // 形状合法（真 UUID）、但本轮/历史轮都从未披露过。
  h.advance(5);
  h.receive({ id: "-296", text: "猜一个引用", addressed: true });
  h.model?.push([
    decideInvoke("history.read", { bodyRef: crypto.randomUUID(), offset: 0, limit: 2048 }),
  ]);
  let result: unknown = null;
  let thrown: unknown = null;
  try {
    result = await h.activate("direct_reply");
  } catch (error) {
    thrown = error;
  }
  expect(thrown !== null || statusOf(result) === "failed").toBe(true);
  const secondRun = mainRuns(h).find((run) => run.startedAt > firstStartedAt);
  expect(secondRun?.errorCode).toBe("CONTEXT_INVALID_SELECTION");
  // 强负：伪造 ref 不产生任何正文，零额外发送。
  expect(h.sent).toHaveLength(1);
});

// ============================================================================
// [S21_1] hybrid：每位发言者最新一条用完整时间，焦点用完整时间，更早上文用相对时长
//   补块：原块只断「最新两条在」+「焦点 platformMessageId 在」，没有断**时间形态**，
//        也没有 self 面。规格 §5：hybrid 的 full 集合＝每位发言者（含助手）最新一条
//        ＋本轮应回应消息；其他上文相对时长。这里逐条钉死。
// ============================================================================

it("[S21_1] hybrid shows the latest message per speaker and the focus with full time while older context stays relative", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    messageSettings: { time_display: "hybrid", timezone: "Asia/Shanghai" },
    model: [decideGenerate("20003", "回答", []), say("合成回复正文")],
  });
  h.receive({ id: "-301", speaker: "20002", text: "小周第一条", groupCard: "小周" });
  h.advance(60);
  h.receive({ id: "-302", speaker: "20003", text: "小王第一条", groupCard: "小王" });
  h.advance(60);
  h.receive({ id: "-303", speaker: "20002", text: "小周第二条", groupCard: "小周" });
  h.advance(60);
  h.receive({ id: "-304", speaker: "20003", text: "小王问题", groupCard: "小王", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  const facts = factsText(h, 0);

  // 正：每位发言者的**最新一条**用完整时间（每人一条，不是全部）。
  expect(String(msgLine(facts, "-303")?.time)).toBe("2033-05-18 11:35:20");
  expect(String(msgLine(facts, "-304")?.time)).toBe("2033-05-18 11:36:20");
  // 强负（可失败）：同一位发言者的**更早**一条不得也是完整时间——它不是 latest，
  // 必须走相对时长。若实现把 full 集合写成「全部消息」，这条立即失败。
  expect(String(msgLine(facts, "-301")?.time)).toBe("3分钟前");
  expect(String(msgLine(facts, "-302")?.time)).toBe("2分钟前");
  // 强负（可失败）：相对时长形态确实是相对标签，不是完整时间串。
  expect(String(msgLine(facts, "-301")?.time)).not.toContain("2033-");
  expect(String(msgLine(facts, "-301")?.time)).toMatch(/前$/);
  // 强负（可失败）：头部 now 唯一且与焦点同刻（同一 step 内不逐行读不同 now）。
  const nowHeaders = facts.match(/now=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/g) ?? [];
  expect(nowHeaders).toHaveLength(1);
  expect(nowHeaders[0]).toContain("2033-05-18 11:36:20");
  // 强负：原始 UTC 秒仍是事实（时区换算只在渲染层）。
  expect(msgLine(facts, "-304")?.occurredAtSeconds).toBe(2_000_000_180);
});

it("[S21_2] hybrid treats each anonymous message as its own sender and never invents a QQ number", async () => {
  // 匿名（规格 §3.2/§5）：两条匿名消息是**两个独立 sender**（按 message 身份），
  // 不归并成一个人、也不被并掉一条；不编造 QQ 号。
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    messageSettings: { time_display: "hybrid", timezone: "Asia/Shanghai" },
    model: [decideGenerate("20003", "回答", []), say("合成回复正文")],
  });
  h.receive({
    id: "-351",
    speaker: "20002",
    text: "匿名甲R351",
    anonymous: true,
    omitPersonalNickname: true,
  });
  h.advance(60);
  h.receive({
    id: "-352",
    speaker: "20002",
    text: "匿名乙R352",
    anonymous: true,
    omitPersonalNickname: true,
  });
  h.advance(60);
  h.receive({ id: "-353", speaker: "20003", text: "焦点R353", groupCard: "小王", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  const facts = factsText(h, 0);

  // 正：匿名明确「QQ号不可用」，且不携带双名字。
  for (const id of ["-351", "-352"]) {
    const speaker = msgLine(facts, id)?.speaker as Record<string, unknown>;
    expect(speaker.role).toBe("anonymous");
    expect(speaker.qq).toBeNull();
    expect(speaker.displayName).toBe("匿名群友");
    expect(speaker.nameState).toBe("unknown");
    // 强负（可失败）：匿名不得带出任何群名片/个人昵称。
    expect(speaker.groupCard).toBeUndefined();
    expect(speaker.personalNickname).toBeUndefined();
  }
  // 强负（可失败）：wire 里的 user_id（20002）**不得**被编造成匿名行的 QQ 号。
  // 两条匿名都来自同一 user_id 20002，若实现按 user_id 归并/赋号，这里会命中 20002。
  expect(occurrences(facts, '"qq":"20002"')).toBe(0);
  // 正：两条匿名各自参与 latest 判定（按消息身份）⇒ 两条都用完整时间，
  // 而非「同一人只保留最新一条」把 -351 降成相对时长。
  expect(String(msgLine(facts, "-352")?.time)).toBe("2033-05-18 11:34:20");
  expect(String(msgLine(facts, "-351")?.time)).toBe("2033-05-18 11:33:20");
  // 强负（可失败）：两条匿名内容都在（不被归并掉一条）。
  expect(occurrences(facts, "匿名甲R351")).toBe(1);
  expect(occurrences(facts, "匿名乙R352")).toBe(1);
});

// ============================================================================
// [S22_1] crossdaytimezone（矩阵 22 补强）
//   补块：原块只断了一个跨日换算 + 契约层非法时区拒绝。本块补三件事：
//        ① 三个 time_display 模式在同一夹具下的逐条时间串 golden（full / full_relative /
//           hybrid）；② 引用段元数据的**完整时间**（规格 §5「直接引用元数据始终带完整时间」）；
//        ③ 非法 IANA 时区名必须被拒。
// ============================================================================

it("[S22_1] a real IANA zone converts across the day boundary and quote metadata always carries full time", async () => {
  // 夹具时钟固定 2_000_000_000 = UTC 2033-05-18 03:33:20；
  // Asia/Shanghai 为 05-18 11:33:20，America/New_York 为 05-17 23:33:20（跨日 + DST 窗口）。
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    messageSettings: {
      reply_mode: "configured_depth",
      reply_depth: 2,
      timezone: "America/New_York",
    },
    model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
  });
  h.receive({ id: "-361", text: `被引原文XYZ22${"跨日引用正文。".repeat(30)}` });
  for (let index = 0; index < 12; index += 1) {
    h.advance(3);
    h.receive({ id: `${-940 - index}`, text: `填充${index}` });
  }
  h.receive({ id: "-362", text: "问上面那条", replyTo: "-361", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();
  expect(phases(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  const facts = factsText(h, 0);
  // 正：头部标注时区 + 完整 now。夹具时钟 2_000_000_000 + 12×3 秒填充 = 2_000_000_036
  // = UTC 2033-05-18 03:33:36 ⇒ 纽约 **05-17** 23:33:56（跨日 + DST 窗口）。
  expect(facts).toContain("timezone=America/New_York");
  expect(facts).toContain("now=2033-05-17 23:33:56");
  // 强负（可失败）：换算不得塌成 UTC——UTC 侧是 05-18 03:33:36。
  expect(facts).not.toContain("2033-05-18 03:33:36");
  // 强负（可失败）：不得用默认时区（上海）——上海侧会是 05-18 11:33:56。
  expect(facts).not.toContain("2033-05-18 11:33:56");
  // 正（规格 §5）：直接引用元数据**始终**带完整时间，且是该条消息**自己**的发送时刻
  // （2_000_000_000 ⇒ 纽约 05-17 23:33:20），不是 now、不是相对时长。
  const roots = quoteRoots(h, 0);
  expect(roots).not.toBeNull();
  expect((roots ?? [])[0]?.time).toBe("2033-05-17 23:33:20");
  // 强负（可失败）：引用元数据不得用相对时长形态，也不得直接抄 now。
  expect(String((roots ?? [])[0]?.time)).not.toMatch(/前$/);
  expect(String((roots ?? [])[0]?.time)).not.toBe("2033-05-17 23:33:56");
  // 强负（可失败）：原始 UTC 秒仍是事实，转换只发生在渲染层。
  expect(msgLine(facts, "-362")?.occurredAtSeconds).toBe(2_000_000_036);
  expect((roots ?? [])[0]?.occurredAtSeconds).toBe(2_000_000_000);
});

it("[S22_2] time_display full and full_relative render distinct, per-row time strings from one frozen now", async () => {
  // 同一夹具（同一批消息）跑三种模式，逐条钉死时间串 golden。
  const build = (timeDisplay: "full" | "full_relative" | "hybrid") => {
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      messageSettings: { time_display: timeDisplay, timezone: "Asia/Shanghai" },
      model: [decideGenerate("20003", "回答", []), say("合成回复正文")],
    });
    h.receive({ id: "-371", speaker: "20002", text: "早一条", groupCard: "甲" });
    h.advance(60);
    h.receive({ id: "-372", speaker: "20003", text: "焦点一条", groupCard: "乙", addressed: true });
    return h;
  };

  const full = build("full");
  await full.activate("direct_reply");
  await full.deliver();
  const fullFacts = factsText(full, 0);
  // full：全部行都是完整时间。
  expect(String(msgLine(fullFacts, "-371")?.time)).toBe("2033-05-18 11:33:20");
  expect(String(msgLine(fullFacts, "-372")?.time)).toBe("2033-05-18 11:34:20");
  // 强负：full 模式不得出现相对时长。
  expect(String(msgLine(fullFacts, "-371")?.time)).not.toContain("前");

  const relative = build("full_relative");
  await relative.activate("direct_reply");
  await relative.deliver();
  const relativeFacts = factsText(relative, 0);
  // full_relative：完整时间＋相对时长，形态是「完整（相对）」。
  expect(String(msgLine(relativeFacts, "-371")?.time)).toBe("2033-05-18 11:33:20（1分钟前）");
  expect(String(msgLine(relativeFacts, "-372")?.time)).toBe("2033-05-18 11:34:20（0秒前）");
  // 强负：full_relative 不得丢相对时长那半边。
  expect(String(msgLine(relativeFacts, "-371")?.time)).not.toBe("2033-05-18 11:33:20");
  return relative;
});

it("[S22_3] an invalid IANA timezone name is refused", async () => {
  // 强负（可失败）：非法 IANA 名必须在方案创建时被拒（不是落库后渲染时才炸）。
  // 「非空字符串就算过」的实现会让这条失败。
  let rejected = false;
  try {
    createOneBotHarness({
      accountId: "90001",
      member: "10001",
      messageSettings: { timezone: "Mars/Olympus_Mons" },
      model: [],
    });
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
});
