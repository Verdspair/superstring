// 已确认助手出站 part 合流进主 context 与引用 load（计划 T04 Step3；规格 §4.3/§5）。
//
// 缺口（reports/space-message-fact-gaps-review.md §1，唯一 Important）：主 context 事实段
// 与引用展开的 load/loadState 原本只走入站 loader、只收 `qq_observation` source，于是助手
// 自己已确认送达的原话取不到——群友回复助手旧消息（必产生 replyTo）时目标就是助手 part，
// 恒得 missing；spec §5 hybrid「每位发言者最新一条**包括助手**用完整时间」对助手实际不成立。
//
// 本测试钉住接线后的语义：
//   1. **强正（主 context）**：真实 journal + 真实 OutboundDelivery 确认段生成的 confirmed part，
//      其原话进 `qq_message_facts` 资料段，身份是**真实发送账号**（不是 Agent UUID），
//      带真实 finishedAt 的完整时间（hybrid 对助手最新一条成立）。
//   2. **强正（引用回落）**：群友回复助手旧消息 → 引用展开经 load/loadState 拿到助手 part
//      原文（目标在窗口事实内，按 in_window 命中），不再 missing。
//   3. **强负**：**未确认**（unknown）出站部件一律不进上下文、引用也读不出。
//   4. **强负（不宣已发）**：未确认部件的正文整份材料里都不出现——partialSpeechSince 只载
//      confirmed 文本部件，未确认回执不产生 timeline 正文，也不进事实段。
//   5. **强负（过期/跨 scope）**：同 scope 过期的 confirmed part 表达 expired（不混 missing、
//      不泄正文）；stale epoch 的 scope 恒 missing，不泄存在。
//   6. **单条正文只出现一次**（§4.3）：已确认出站件的原话只由 `qq_message_facts` 承载，
//      附近期群聊时间线里不再重复一份。**本例当前为红**，等产品侧建立 speech 行 ↔ 出站
//      part 的精确身份关联（另一个写者按 `legacy_send_id` 做，无新表列）后转绿。
//
// fixture 全部走生产同序公开 API：outbox.commit → journal 计划事件 →
// recordQqOutboundMessageFact 身份快照 → **真实 OutboundDelivery** + 合成端口回执。
// **不做任何「直接 UPDATE 伪 confirmed」**；平台消息 ID 取回执返回的真实值（负数字符串合法）。
// 引用段经**公开 `bindRun`** 登记真实 (owner, runId)：生产就是这样接线的
// （`bot-host` 把 `currentRunId` 同时交给 `source.bindRun` 与 `outbox.commit`），
// 不调用它则 `replyScope` 恒 null、`expandQqReplies` 整段不跑。
// 断言一律按 **JSON.parse 后的真实结构**（事实段 `msg=` 行、引用段 `roots`），
// 不用 `JSON.stringify` 的转义子串——`contextDumps` 递归排序后 `facts` 排在 `kind`
// 之前，按 kind 标签切 substring 必然截掉正文（2026-10-04 joint2 实测 3 例红即此因）。
// 过期只经**生产合法的存储设置**（`updateQqStorageSettings`，最小 1 天）＋读时刻越帽造，
// 不给事实行塞私设的 0 天窗口。
// 不接真实 QQ/模型/网络，不读真实数据；不新增表/列，不改任何产品契约。

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { ActionContext } from "../../src/server/agent/built-in-actions";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import {
  loadQqOutboundMessageFactState,
  qqSpeechCarriedByOutboundFacts,
} from "../../src/server/channels/onebot11/message-projection";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  OutboundIntentRepository,
  type OutboundTarget,
} from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { recordQqOutboundMessageFact } from "../../src/server/db/qq-message-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  readQqSettings,
  updateQqSettings,
  updateQqStorageSettings,
} from "../../src/server/db/qq-settings-repository";
import { recordQqSpeech } from "../../src/server/db/qq-speech-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

/** 合成时钟：固定读时刻，所有期限判断以此为界。 */
const now = "2026-10-01T16:00:00.000000Z";
const far = "2033-01-01T00:00:00.000000Z";
const atSeconds = Math.floor(Date.parse(now) / 1000);
const accountId = "90001";
const peerId = "30003";
const assistantCard = "值班猫娘";
/** 送达时刻取在读时刻前 60 秒，确保落在窗口内。 */
const sentSeconds = atSeconds - 60;

/**
 * 合成时钟：默认读时刻。全部期限判断以此为界。
 *
 * `readAt` 可由用例覆盖（过期例要把读时刻推到保留帽之后），所以它是 `setup` 的入参而不是
 * 模块常量——产品读的是每次真实读时刻，测试不能把读时刻和被测期限写死成同一处。
 */
function setup(readAt: string = now) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { enabled: true, accountId, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, { name: `outbound-context-${crypto.randomUUID()}` });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId,
    kind: "group",
    peerId,
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved")
    throw new Error(`fixture: createQqBinding returned ${created.kind}`);
  const binding = insertQqBinding(h.orm, created.binding);
  const capture = captureQqTask(binding, "reply");
  if (capture.kind !== "captured") throw new Error("fixture: captureQqTask not captured");
  const agentRow = getAgentRow(h.orm, DEFAULT_AGENT_ID);
  if (!agentRow) throw new Error("fixture: default agent row missing");
  const runtime = runtimeFromAgent(agentRow);
  runtime.p5_config.retrieval_mode = "off";
  const journal = new ConversationEventRepository(h.db);
  const outbox = new OutboundIntentRepository(h.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("fixture: ensureOneBot returned null");

  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "synthetic-model", timeoutSeconds: 1 },
    listModels: async () => [],
    probeModelLoaded: async () => true,
    loadedContextCapacity: async () => 65536,
    async complete() {
      throw new Error("no model call expected in this suite");
    },
    // 本套件不触达模型（`complete` 会抛）；流式入口与既有夹具同形状，保持类型一致。
    async *streamChat() {
      yield "unused";
    },
  };
  const spec: AgentSpec = {
    id: "test.bot",
    model: "synthetic-model",
    context: "conversation",
    instructions: "test",
    availableActions: [],
    limits: { steps: 8 },
  };

  /**
   * 本轮真实的调用 owner（RunOwner，conversation 域）——与 `bot-host` 交给
   * `AgentRuntime.runConversation` 的形状同源：kind=conversation、id=本会话、当前用户与助手。
   * 引用段的证据注册（`registerEvidence`）按 (owner, runId) 命名空间记账，owner 造错就会
   * 与 registry 里的键对不上（`contextKey`），这里必须是真实可校验的 tuple。
   */
  const runOwner = {
    kind: "conversation" as const,
    id: conversation.id,
    userId: DEFAULT_USER_ID,
    agentId: binding.agentId,
  };

  /**
   * 真实 bindRun（生产接线点：`AgentRuntime` 在 `input.context.bindRun(actionContext)` 处
   * 登记一次）。不调用它则 `runId` 恒 undefined，`context-source` 的 `replyScope` 恒 null
   * ——`expandQqReplies` 整段不跑，引用区连 `qq_reply_roots` 都不会出现（本文件 2026-10-04
   * joint2 实测 3 例红即此因）。这里走公开方法，不改产品、不造内部字段。
   */
  const buildSource = (runId: string) => {
    const source = new BotContextSource({
      db: h.db,
      orm: h.orm,
      gateway,
      agentRuntime: createAgentRuntime({ gateway, repository: new AgentRunRepository(h.db) }),
      journal,
      outbox,
      conversationId: conversation.id,
      binding,
      snapshot: capture.snapshot,
      scheme,
      runtime,
      spec,
      path: "direct_reply",
      decisionTier: "reply",
      targets: () => [{ id: "alin", speakerId: "10001" }],
      assertCurrent() {},
      now: () => readAt,
    });
    const context: ActionContext = {
      owner: runOwner,
      signal: new AbortController().signal,
      runId,
      // 宿主在每次真实调用前复验当前授权；本套件的 assertCurrent 是空实现，给一个同义的空实现。
      assertAuthority() {},
    };
    source.bindRun(context);
    return source;
  };

  /** 一条真实入站群消息：normalize → recordObservation → journal ingest（真实 intake）。 */
  const say = (messageId: number, seconds: number, text: string, replyTo?: number) => {
    const segments: Array<{ type: string; data: Record<string, unknown> }> = [];
    if (replyTo !== undefined) segments.push({ type: "reply", data: { id: replyTo } });
    segments.push({ type: "text", data: { text } });
    const normalized = normalizeOneBotMessage(
      {
        time: seconds,
        self_id: Number(accountId),
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: messageId,
        user_id: 10001,
        group_id: Number(peerId),
        sender: { nickname: "阿林" },
        message: segments,
      },
      accountId,
    );
    if (normalized.kind !== "message") throw new Error("fixture: message expected");
    recordObservation(h.orm, normalized.observation, DEFAULT_AGENT_ID);
    journal.ingestOneBotEvent(normalized.observation.eventKey, binding.id);
    return normalized.observation.eventKey;
  };

  /**
   * 本轮唯一的真实 run：`bindRun` 的登记命名空间与出站意图的 `runId` 同一条。
   * 生产就是这样——`bot-host` 把 `currentRunId`（runtime 建的 run）同时交给
   * `source.bindRun` 与 `outbox.commit`，所以引用登记与出站事实归属同一轮。
   */
  const runId = `run-${crypto.randomUUID()}`;
  new AgentRunRepository(h.db).createRun({
    runId,
    specId: "main",
    specVersion: "1",
    owner: runOwner,
    at: readAt,
  });

  /**
   * 生产同序 commit：outbox.commit → journal 计划事件 → 身份快照（bot-host 等价播种，
   * 非手 SQL）。`occurredAtSeconds` 用真实送达时刻，投影与时间渲染都取它。
   */
  const commitOutbound = (intentId: string, text: string | readonly string[]) => {
    const texts = typeof text === "string" ? [text] : text;
    const row = h.db
      .query("SELECT authority_revision AS authorityRevision FROM qq_bindings WHERE id=?")
      .get(binding.id) as { authorityRevision: number };
    const epoch = h.db
      .query("SELECT binding_epoch AS n FROM conversations WHERE id=?")
      .get(conversation.id) as { n: number };
    const target: OutboundTarget = {
      accountId,
      conversationKind: "group",
      peerId,
      agentId: DEFAULT_AGENT_ID,
      bindingId: binding.id,
      bindingEpoch: epoch.n,
      authorityRevision: row.authorityRevision,
    };
    const intent = outbox.commit({
      id: intentId,
      runId,
      conversationId: conversation.id,
      ordinal: 0,
      target,
      speechKind: "direct_reply",
      sourceThroughSeq: 0,
      deliverBy: far,
      createdAt: new Date(sentSeconds * 1000).toISOString(),
      expiresAt: far,
      // 多部件输出按真实发送顺序建多个 text part（ordinal 0 带程序收件人，>=1 不带）。
      parts: texts.map((value) => ({ kind: "text" as const, text: value })),
    });
    journal.append({
      conversationId: conversation.id,
      eventKey: `output:${intent.id}`,
      kind: "delivery",
      source: { kind: "outbound_intent", id: intent.id, revision: "planned", expiresAt: far },
      occurredAt: new Date(sentSeconds * 1000).toISOString(),
      runId,
      outputId: intent.id,
    });
    recordQqOutboundMessageFact(h.orm, {
      intentId: intent.id,
      accountId,
      agentId: DEFAULT_AGENT_ID,
      identity: {
        qq: accountId,
        groupCard: assistantCard,
        personalNickname: null,
        legacyDisplayName: null,
        nameState: "known",
      },
      occurredAtSeconds: sentSeconds,
    });
    return intent;
  };

  /**
   * 把**存储**的保留窗口改成 1 天（`updateQqStorageSettings` 的最小合法值；`QQ_RETENTION_MIN_DAYS`
   * 就是 1，0 天既不合法也不可达）。
   *
   * "已确认件过期"只经这条生产合法的设置造，不再给 `recordQqOutboundMessageFact` 塞一个
   * 私设的 0 天窗口——那会让人造出"事实帽 0 天、旧 `qq_speech_text` 帽按存储 14 天"的分叉，
   * 而生产写不出这种分叉。改窗口后由 `setup(readAt)` 把读时刻推到帽之后。
   *
   * 注意这只让**事实/旧 speech 这一对**按同一窗口过期；intent 的期限锚在 commit 时刻、比事实
   * 更早，可读帽取 min(intent, fact)，所以"更早的那一维"仍由产品侧保证，不在本文件断言。
   */
  const setRetentionDays = (days: number) =>
    updateQqStorageSettings(h.orm, {
      retentionDays: days,
      expectedRevision: readQqSettings(h.orm).revision,
    });

  /** 真实投递：OutboundDelivery + 合成端口；confirmed 回执产生真实 confirmed part 与事实映射。 */
  const deliver = async (
    intentId: string,
    step:
      | { kind: "confirmed"; messageId: string }
      | { kind: "unknown" }
      /** 逐部件回执：多部件输出里一部分确认、一部分未知，用来造「部分承载」对照。 */
      | {
          kind: "perPart";
          results: ReadonlyArray<{ kind: "confirmed"; messageId: string } | { kind: "unknown" }>;
        },
  ) => {
    let partIndex = 0;
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: outbox,
      journal,
      stickerFile: () => null,
      authorize: () => true,
      // 真实送达时刻：让 finishedAt / delivery journal / attempted_at 落在一个可预期刻度。
      now: () => new Date(sentSeconds * 1000).toISOString(),
      port: {
        async send() {
          const result =
            step.kind === "perPart"
              ? (step.results[partIndex] ?? { kind: "unknown" as const })
              : step;
          partIndex += 1;
          if (result.kind === "confirmed")
            return { kind: "confirmed" as const, messageId: result.messageId };
          return { kind: "unknown" as const, reason: "timeout" as const };
        },
      },
    });
    await delivery.deliver(intentId);
  };

  return {
    h,
    journal,
    outbox,
    conversation,
    binding,
    runId,
    say,
    commitOutbound,
    deliver,
    buildSource,
    setRetentionDays,
  };
}

const readInput = () => ({ signal: new AbortController().signal, observations: [] });

/**
 * 材料里每条消息的真实文本（`ModelMessage.content` 是**片段数组**，不是字符串）。
 *
 * `textMessage(role, text)` 产出 `{ role, content: [{ kind: "text", text }] }`，
 * 所以按 `typeof content === "string"` 读**永远读不到**——本文件 2026-10-04 joint3 的
 * case1/2/4/5/6 六红全部源于此：facts/roots 取段器恒返回空，断言在空集上失败。
 * 这里按真实形状取每个 text 片段并拼接，不做子串猜测。
 */
function messageTexts(material: unknown): string[] {
  const pending =
    material !== null && typeof material === "object"
      ? ((material as { pending?: unknown }).pending ?? [])
      : [];
  if (!Array.isArray(pending)) return [];
  return pending.flatMap((message) => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      const text = part as { kind?: unknown; text?: unknown };
      return text.kind === "text" && typeof text.text === "string" ? [text.text] : [];
    });
  });
}

/** 材料里每条消息按 `kind` 解析出来的资料段对象（`contextDumps` 的真实产物）。 */
function dataSections(material: unknown): Array<Record<string, unknown>> {
  return messageTexts(material).flatMap((text) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return [parsed as Record<string, unknown>];
  });
}

/**
 * 取出材料里真实存在的 `qq_message_facts` 资料段。
 *
 * 不能按子串切：生产渲染器 `contextDumps` 对键做**递归字典序排序**，`{kind,trust,facts}`
 * 排序后是 `facts,kind,trust`——`facts` 正文排在 `kind` 标签**之前**。从 `kind` 标签起切
 * 只会切到 `trust` 之后的尾巴，正文整段被截掉（joint2 实测 3 例红即此因）。
 */
function factsSections(material: unknown): string[] {
  return dataSections(material)
    .filter((section) => section.kind === "qq_message_facts" && typeof section.facts === "string")
    .map((section) => section.facts as string);
}

/** 同上，取出 `qq_reply_roots` 段的根行（引用关系/状态元数据的真实结构）。 */
function replyRootSections(material: unknown): Array<Record<string, unknown>> {
  return dataSections(material).flatMap((section) =>
    section.kind === "qq_reply_roots" && Array.isArray(section.roots)
      ? section.roots.filter(
          (root): root is Record<string, unknown> =>
            root !== null && typeof root === "object" && !Array.isArray(root),
        )
      : [],
  );
}

/** 近期群聊时间线段（`buildQqPrompt` 的真实渲染文本），用于"正文只供一次"的唯一性检查。 */
function timelineSection(material: unknown): string[] {
  return messageTexts(material).filter((text) => text.startsWith("## 近期群聊"));
}

/**
 * 统计一段正文在整份材料里出现的次数（跨所有 pending 段的真实文本）。
 * 用于「同一消息最多供一次正文」的跨段计数，防「剥了时间线却在别处再印一份」。
 */
function dumpRawCount(material: unknown, needle: string): number {
  return messageTexts(material).reduce((total, text) => total + (text.split(needle).length - 1), 0);
}

interface FactMessage {
  id: string;
  platformMessageId: string;
  seq: number;
  occurredAtSeconds: number;
  time: string;
  speaker: { role: string; qq: string | null; displayName: string | null; nameState: string };
  parts: Array<Record<string, unknown>>;
  /** `full` / `partial` / `unavailable`（渲染器的真实字段，不省略）。 */
  completeness?: string;
  replyTo?: { platformMessageId: string };
}

/**
 * 解析事实段里 `msg=` 开头的单行 JSON（渲染器 `renderQqMessageFacts` 的真实形状）。
 * 返回解析后的对象数组——按行首标记取，不按转义子串取。
 */
function factMessages(factsText: string): FactMessage[] {
  return factsText
    .split("\n")
    .filter((line) => line.startsWith("msg="))
    .map((line) => JSON.parse(line.slice("msg=".length)) as FactMessage);
}

/** 事实段里第一条满足判据的消息（解析后的真实结构，不做子串猜测）。 */
function findFactMessage(
  factsText: string,
  predicate: (message: FactMessage) => boolean,
): FactMessage | null {
  return factMessages(factsText).find(predicate) ?? null;
}

/**
 * 断言前把真实材料落盘——**纯可选诊断，默认零写**。
 *
 * 诊断目的地由环境变量 `SUPERSTRING_OUTBOUND_TRACE_DIR` 指定：未设就完全不写（本套件跑在
 * 任何环境下都不产生文件），设了才写进那个目录，文件名带独有 UTC 时间戳，只装本套件的合成
 * 材料。不再从 `import.meta.dir` 拼 `artifacts/...` 硬编码路径：发布测试不该知道本轮证据目录。
 *
 * 只新增文件，从不删改既有原件。
 */
function dumpRaw(name: string, material: unknown): void {
  const dir = process.env.SUPERSTRING_OUTBOUND_TRACE_DIR;
  if (!dir || dir.trim() === "") return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/${name}-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}.json`,
      JSON.stringify({ name, writtenAt: new Date().toISOString(), material }, null, 2),
      "utf8",
    );
  } catch {
    // 落盘失败不改变被测语义：原始材料仍在断言输出里。
  }
}

describe("confirmed assistant outbound parts reach the shared context", () => {
  it("carries the confirmed part's own words and real sending account into the fact dump", async () => {
    const f = setup();
    const assistantLine = "昨天那家店十点开门";
    const intent = f.commitOutbound("intent-confirmed", assistantLine);
    await f.deliver(intent.id, { kind: "confirmed", messageId: "-7001" });
    // 群友随后说话（窗口里必须有入站消息，事实段才组装）。
    f.say(-8001, atSeconds - 10, "那明天几点");

    const material = await f.buildSource(f.runId).read(readInput());
    // 按完整 JSON.parse 取段：`contextDumps` 递归排序后 facts 排在 kind 之前，
    // 按子串切必然截掉正文。断言前先把真实材料落盘（本目录 A/…raw.json），
    // 失败时看得到实际 material/outSources/roots，不用只留一行 expectation。
    dumpRaw("case1-fact-dump", material);
    const factsText = factsSections(material).join("\n");
    expect(factsText.length).toBeGreaterThan(0);
    // 已确认部件的原话进了事实资料段。
    expect(factsText).toContain(assistantLine);
    // 身份是真实发送账号（§3.2：Agent UUID 绝不充当 QQ 号）：按结构断言，不按子串猜。
    const assistant = findFactMessage(factsText, (line) => line.speaker.role === "assistant");
    expect(assistant).not.toBeNull();
    expect(assistant?.speaker.qq).toBe(accountId);
    expect(JSON.stringify(assistant)).not.toContain(DEFAULT_AGENT_ID);
    // 平台消息 ID 是回执返回的真实值（负数字符串合法）。
    expect(assistant?.platformMessageId).toBe("-7001");
    expect(assistant?.parts).toEqual([{ kind: "text", text: assistantLine }]);
    // 成员那条在事实段里同样在场（证明不是只塞了助手这一条）。
    const member = findFactMessage(factsText, (line) => line.speaker.role === "member");
    expect(member?.speaker.qq).toBe("10001");
    expect(member?.parts).toEqual([{ kind: "text", text: "那明天几点" }]);
    // hybrid 完整时间（规格 §5）：助手这条（真实 finishedAt=atSeconds-60，Asia/Shanghai=UTC+8
    // → 2026-10-01 23:59:00）是该 speaker 最新一条，给完整 "YYYY-MM-DD HH:MM:SS"，
    // 不是相对标签。断言按解析出的字段，不按 dump() 的转义形。
    expect(assistant?.occurredAtSeconds).toBe(sentSeconds);
    expect(assistant?.time).toBe("2026-10-01 23:59:00");
  });

  it("resolves a member reply pointing at the assistant's own part through load and loadState", async () => {
    const f = setup();
    const assistantLine = "我是这么想的";
    const intent = f.commitOutbound("intent-reply-target", assistantLine);
    await f.deliver(intent.id, { kind: "confirmed", messageId: "-7101" });
    // 群友明确引用助手刚发的这条（replyTo = 助手 part 的真实平台消息 ID）。
    f.say(-8101, atSeconds - 10, "为什么这么说", -7101);

    const material = await f.buildSource(f.runId).read(readInput());
    dumpRaw("case2-reply-roots", material);
    // 助手原话在事实段里可读（不只是只剩一个 missing 关系）。
    const factsText = factsSections(material).join("\n");
    const assistant = findFactMessage(factsText, (line) => line.speaker.role === "assistant");
    expect(assistant?.parts).toEqual([{ kind: "text", text: assistantLine }]);
    // 引用段真的渲染出来了：`bindRun` 登记了真实 run 之后 `replyScope` 才成立，
    // 否则 `expandQqReplies` 整段不跑、连 `qq_reply_roots` 都不出现。
    const targetPart = f.h.db
      .query(
        "SELECT id, platform_message_id AS platformMessageId FROM outbound_parts WHERE intent_id=?",
      )
      .get(intent.id) as { id: string; platformMessageId: string };
    expect(targetPart.platformMessageId).toBe("-7101");
    expect(assistant?.platformMessageId).toBe("-7101");
    expect(assistant?.id).toBe(targetPart.id);

    const roots = replyRootSections(material);
    expect(roots.length).toBe(1);
    const [root] = roots;
    if (!root) throw new Error("fixture: reply root missing after length assertion");
    // 目标等于从实际 assistant fact 与真实 outbound_parts 读取的内部事实 id（in_window 契约）
    expect(root.target).toBe(targetPart.id);
    expect(root.target).toBe(assistant?.id);
    // 目标在本档窗口事实里（outboundFacts 进了 reply window）→ in_window，不是 missing。
    expect(root.state).toBe("in_window");
    expect(root.depth).toBe(1);
    expect(root.from).toBeTruthy();
    // 不可读状态不得出现（本例全部可读）。
    for (const other of roots) expect(other.state).not.toBe("missing");
  });

  it("keeps an unconfirmed part out of the context and reads nothing back for it", async () => {
    const f = setup();
    const assistantLine = "这条没送达";
    const intent = f.commitOutbound("intent-unknown", assistantLine);
    await f.deliver(intent.id, { kind: "unknown" });
    f.say(-8201, atSeconds - 10, "在吗");

    const material = await f.buildSource(f.runId).read(readInput());
    dumpRaw("case3-unconfirmed", material);
    // 台账里它确实不是 confirmed（是投递回执决定的，不是夹具造数据）。
    const part = f.h.db
      .query("SELECT status FROM outbound_parts WHERE intent_id=?")
      .get(intent.id) as { status: string };
    expect(part.status).toBe("unknown");
    // 未确认部件绝不进事实段（未确认不作为已发原文，§13.4）：按解析出的消息列表判，
    // 不用转义子串（`factsText` 已是解出来的正文，不是 dump 串）。
    const factsText = factsSections(material).join("\n");
    expect(factsText).not.toContain(assistantLine);
    for (const message of factMessages(factsText))
      expect(message.speaker.role).not.toBe("assistant");
    // 整份材料里都不出现（不宣已发，§13.4）：`partialSpeechSince` 只载 confirmed 文本部件，
    // 未确认回执既不进事实段，也不产生 timeline 正文——逐段查，不只查 facts 段。
    for (const section of [...factsSections(material), ...timelineSection(material)])
      expect(section).not.toContain(assistantLine);
  });

  it("reports an expired confirmed part as expired, never missing, and keeps its body unreadable", async () => {
    // 过期只经**生产合法的存储设置**造：把保留窗口设成最小合法值 1 天，再把读时刻推到
    // 送达 1 天之后。旧写法给 `recordQqOutboundMessageFact` 塞 0 天，那既不合法
    // （`QQ_RETENTION_MIN_DAYS=1`）也不可达，且会造出"事实帽 0 天、旧 speech 帽 14 天"
    // 的人造分叉——那种分叉生产写不出来，用它当证据等于自造 RED。
    const expiredReadAt = new Date((sentSeconds + 24 * 60 * 60 + 120) * 1000).toISOString();
    const f = setup(expiredReadAt);
    f.setRetentionDays(1);
    const assistantLine = "这条已经过期";
    const intent = f.commitOutbound("intent-expired", assistantLine);
    await f.deliver(intent.id, { kind: "confirmed", messageId: "-7301" });
    // 群友明确引用这条已过期的助手 part。成员消息必须同时**在窗口内且未过期**，
    // 否则整档没有可读事实，展开根本走不到状态判定，断言就成了空断言。
    f.say(-8301, sentSeconds + 23 * 60 * 60, "还在吗", -7301);

    const material = await f.buildSource(f.runId).read(readInput());
    dumpRaw("case4-expired", material);
    // 同 scope 过期保状态表达 expired（不给正文/身份），不把过期混为 missing：按根结构断言。
    const roots = replyRootSections(material);
    const expiredRoot = roots.find((root) => root.target === "-7301");
    expect(expiredRoot).toBeDefined();
    expect(expiredRoot?.state).toBe("expired");
    expect(expiredRoot?.state).not.toBe("missing");
    // 过期根不带正文/身份字段（只给关系与状态，§4.3）。
    expect(expiredRoot?.text).toBeUndefined();
    expect(expiredRoot?.speaker).toBeUndefined();
    // 过期部件的原话不进事实段（窗口投影走事实读，到期即 null）。
    const factsText = factsSections(material).join("\n");
    expect(factsText).not.toContain(assistantLine);
    for (const message of factMessages(factsText))
      expect(message.speaker.role).not.toBe("assistant");
  });

  /**
   * 规格 §4.3「同一消息最多供一次正文」：一条已确认出站件的原话**只**出现在
   * `qq_message_facts` 资料段，附近期群聊时间线里不再重复一份。
   *
   * 关联是精确 id，不是内容或时刻猜测：发送通路在**同一事务**里把 `qq_send_log` 的行 id
   * 交给 `recordQqSpeech` 当 `qq_speech_log.id`，而 `outbound_intents.legacy_send_id` 指向
   * 同一行，于是 `qq_speech` source id 就是该出站意图的 `legacy_send_id`。本例先把这个等式
   * 断言下来（不是靠它通过，而是证明去重确实建立在真实关联上），再断言正文只出现一次。
   *
   * 修复前这条是红的：时间线去重按 `outbound_intent` source 匹配，对已确认意图是死代码
   * （已确认意图的时间线条目来自 `ownSpeechSince`，sources 只有 `qq_speech`）。2026-10-04
   * joint2 log 第 2 例 received 值可证：同一条"我是这么想的"同时出现在时间线与 facts 段。
   * 期望值不因修复而放宽。
   */
  it("carries one confirmed message body exactly once, never duplicated in the timeline", async () => {
    const f = setup();
    const assistantLine = "只该出现一次的正文";
    const intent = f.commitOutbound("intent-dedup", assistantLine);
    await f.deliver(intent.id, { kind: "confirmed", messageId: "-7501" });
    f.say(-8501, atSeconds - 10, "再说一句");

    // 真实关联成立：speech.source.id === intent.legacy_send_id（同一发送行 id）。
    const legacySendId = f.h.db
      .query("SELECT legacy_send_id AS id FROM outbound_intents WHERE id=?")
      .get(intent.id) as { id: string | null };
    expect(legacySendId.id).toBeTruthy();
    if (legacySendId.id === null) throw new Error("fixture: legacy_send_id not set by delivery");
    const speechId = legacySendId.id;
    const speechRow = f.h.db.query("SELECT id FROM qq_speech_log WHERE id=?").get(speechId) as
      | { id: string }
      | undefined;
    expect(speechRow?.id).toBe(speechId);
    // 该 speech source 确实进了本档时间线（有它才谈得上"剥掉重复的一份"）。
    const material = await f.buildSource(f.runId).read(readInput());
    dumpRaw("case5-body-once", material);
    const sources = (material as { sources?: Array<{ kind: string; id: string }> }).sources ?? [];
    expect(sources.some((s) => s.kind === "qq_speech" && s.id === speechId)).toBe(true);

    const factsText = factsSections(material).join("\n");
    // 强正：事实段确实承载了这条正文（否则下面的"只一次"会因为 0 次而假绿）。
    expect(factsText).toContain(assistantLine);
    // 强断：附近期群聊时间线里不能再出现同一份正文（正文只供一次，§4.3）。
    for (const timeline of timelineSection(material)) expect(timeline).not.toContain(assistantLine);
    // 整份材料里也只出现一次（跨段计数，防「换个段再印一份」）。
    expect(dumpRawCount(material, assistantLine)).toBe(1);
  });

  /**
   * 「混合投递」走 partial intent 而非 legacy speech：一次多部件发送里只有一部分被确认时，
   * entersUnresponded=pending 依既有未知送达政策不写入 qq_speech 行；已确认部分经 outbox
   * partialSpeechSince 正确读取，并在 facts 段完整承载；时间线正文依 outbound_intent 来源
   * 精确去重，未确认部件正文永不入材料（§13.4）。
   */
  it("routes a mixed delivery via partial intent rather than legacy speech: carries confirmed part and leaves unconfirmed absent", async () => {
    const f = setup();
    const confirmedLine = "确认送达的第一段";
    const unconfirmedLine = "没送出去的第二段";
    const intent = f.commitOutbound("intent-mixed", [confirmedLine, unconfirmedLine]);
    await f.deliver(intent.id, {
      kind: "perPart",
      results: [{ kind: "confirmed", messageId: "-7601" }, { kind: "unknown" }],
    });
    f.say(-8701, atSeconds - 10, "在听吗");

    // 前置事实：确实只有一个部件 confirmed，未确认部件保持 unknown。
    const parts = f.h.db
      .query(
        "SELECT status,platform_message_id AS platformMessageId FROM outbound_parts WHERE intent_id=? ORDER BY ordinal",
      )
      .all(intent.id) as Array<{ status: string; platformMessageId: string | null }>;
    expect(parts.map((p) => p.status)).toEqual(["confirmed", "unknown"]);
    // 混合回执（entersUnresponded = pending）不写 qq_speech 行（原批准未知送达政策，不冒写 speech）。
    const speechRow = f.h.db
      .query(
        "SELECT t.body AS body FROM qq_speech_text t JOIN outbound_intents i ON i.legacy_send_id=t.speech_id WHERE i.id=?",
      )
      .get(intent.id) as { body: string } | null;
    expect(speechRow).toBeNull();
    // 真实出箱公共读取：混合回执经 partialSpeechSince 正确产出已确认部件的文本，未确认��件不出现。
    const partial = f.outbox.partialSpeechSince(f.conversation.id, {
      sinceSeconds: atSeconds - 3600,
      limit: 10,
      at: now,
    });
    expect(partial.length).toBeGreaterThan(0);
    const mixedItem = partial.find((item) =>
      item.sources.some((s) => s.kind === "outbound_intent" && s.id === intent.id),
    );
    expect(mixedItem).toBeDefined();
    expect(mixedItem?.text).toBe(confirmedLine);
    expect(mixedItem?.text).not.toContain(unconfirmedLine);

    const material = await f.buildSource(f.runId).read(readInput());
    dumpRaw("case6-mixed-delivery", material);
    // 来源确实带有 outbound_intent 来源，证明正文来自 partialSpeechSince 而不是 legacy speech。
    const sources = (material as { sources?: Array<{ kind: string; id: string }> }).sources ?? [];
    expect(sources.some((s) => s.kind === "outbound_intent" && s.id === intent.id)).toBe(true);

    const factsText = factsSections(material).join("\n");
    // 强正一：已确认那一份**完整**进事实段（身份／完整时间／正文都在）。
    const assistant = findFactMessage(factsText, (line) => line.speaker.role === "assistant");
    expect(assistant).not.toBeNull();
    expect(assistant?.speaker.qq).toBe(accountId);
    expect(assistant?.platformMessageId).toBe("-7601");
    expect(assistant?.time).toBe("2026-10-01 23:59:00");
    expect(assistant?.parts).toEqual([{ kind: "text", text: confirmedLine }]);
    expect(assistant?.completeness).toBe("full");
    // 强正二：门槛按「已确认文本部件」判定——只有 1 个且它已投影，由 facts 段独家承载：
    // 时间线那份正文被去重剥掉（置 null），不重复出现。
    for (const timeline of timelineSection(material)) expect(timeline).not.toContain(confirmedLine);
    // 强断：已确认那段的正文全材料恰出现一次；未确认那段一次都不出现（§13.4）。
    expect(dumpRawCount(material, confirmedLine)).toBe(1);
    expect(dumpRawCount(material, unconfirmedLine)).toBe(0);
  });

  /**
   * 辅助层契约测试（**非宿主整链**）：直接对 `qqSpeechCarriedByOutboundFacts` 断言
   * 「两个已确认文本部件、只有一个进入投影」时它给出的是**部分承载**，以及它返回的
   * partly part id 精确到 `outbound_parts.id`。
   *
   * 整链里「一个已确认部件没进本档 facts」需要真实窗口/期限条件把该 part 排除在候选外，
   * 那属于宿主整链取证（joint3）的范围，不在本文件冒充。辅助层用同一公开函数 + 同一真实
   * 台账（真实两次 confirmed 回执、真实 `legacy_send_id` 关联）构造，不手改 confirmed、
   * 不用非法保留期、不按正文或时刻猜。
   */
  it("helper contract: two confirmed parts with one projected is partly carried", async () => {
    const f = setup();
    const firstLine = "第一段上线了";
    const secondLine = "第二段也上线了";
    const intent = f.commitOutbound("intent-two-confirmed", [firstLine, secondLine]);
    await f.deliver(intent.id, {
      kind: "perPart",
      results: [
        { kind: "confirmed", messageId: "-7801" },
        { kind: "confirmed", messageId: "-7802" },
      ],
    });
    f.say(-8801, atSeconds - 10, "两句都收到了吗");

    // 真实台账：两个部件都 confirmed，两个真实平台消息 ID，speech 正文是二者换行拼接。
    const parts = f.h.db
      .query(
        "SELECT id,status,platform_message_id AS platformMessageId FROM outbound_parts WHERE intent_id=? ORDER BY ordinal",
      )
      .all(intent.id) as Array<{ id: string; status: string; platformMessageId: string | null }>;
    expect(parts.map((p) => p.status)).toEqual(["confirmed", "confirmed"]);
    const [first, second] = parts;
    if (!first || !second) throw new Error("fixture: two confirmed parts expected");
    const speechId = f.h.db
      .query("SELECT legacy_send_id AS id FROM outbound_intents WHERE id=?")
      .get(intent.id) as { id: string | null };
    if (speechId.id === null) throw new Error("fixture: legacy_send_id not set");
    const speechBody = f.h.db
      .query("SELECT body FROM qq_speech_text WHERE speech_id=?")
      .get(speechId.id) as { body: string } | undefined;
    // 拼接正文真的含两段——所以「只投影一段」时不完整，speech 那份必须留。
    expect(speechBody?.body).toContain(firstLine);
    expect(speechBody?.body).toContain(secondLine);

    const store = { db: f.h.db, orm: f.h.orm };
    const scope = {
      conversationId: f.conversation.id,
      accountId,
      conversationKind: "group" as const,
      peerId,
      agentId: DEFAULT_AGENT_ID,
      bindingId: f.binding.id,
      bindingEpoch: (
        f.h.db
          .query("SELECT binding_epoch AS n FROM conversations WHERE id=?")
          .get(f.conversation.id) as { n: number }
      ).n,
      authorityRevision: f.binding.authorityRevision,
    };
    // 只把第一个部件放进「已投影」表：第二个已确认部件没进 → 部分承载。
    const partial = qqSpeechCarriedByOutboundFacts({
      speechSourceIds: [speechId.id],
      projectedByPlatformMessageId: new Map([[first.platformMessageId as string, first.id]]),
      store,
      scope,
      now,
    });
    expect(partial.fullyCarriedSpeechIds.has(speechId.id)).toBe(false);
    expect(partial.partlyCarriedSpeechIds.has(speechId.id)).toBe(true);
    // 返回的 partly part id 精确到 outbound_parts.id（本例两个已确认文本部件都属该意图）。
    expect([...partial.partlyCarriedPartIds].sort()).toEqual([first.id, second.id].sort());
    // 反向：两个都投影 → 完整承载，speech 可剥。
    const complete = qqSpeechCarriedByOutboundFacts({
      speechSourceIds: [speechId.id],
      projectedByPlatformMessageId: new Map([
        [first.platformMessageId as string, first.id],
        [second.platformMessageId as string, second.id],
      ]),
      store,
      scope,
      now,
    });
    expect(complete.fullyCarriedSpeechIds.has(speechId.id)).toBe(true);
    expect(complete.partlyCarriedSpeechIds.has(speechId.id)).toBe(false);
    // 精确 part 身份：同一条线上消息 ID 由**别的部件**的 id 顶替，不算已投影。
    const forged = qqSpeechCarriedByOutboundFacts({
      speechSourceIds: [speechId.id],
      projectedByPlatformMessageId: new Map([
        [first.platformMessageId as string, second.id],
        [second.platformMessageId as string, first.id],
      ]),
      store,
      scope,
      now,
    });
    expect(forged.fullyCarriedSpeechIds.has(speechId.id)).toBe(false);
    expect(forged.partlyCarriedSpeechIds.has(speechId.id)).toBe(false);
  });

  /**
   * 未映射的独立旧 speech（没有 `legacy_send_id` 指向的出站意图）原文字**照旧保留**：
   * 去重只在能证明「这份正文已被 facts 完整承载」时发生，不整段删历史、不迁旧 ID、不按
   * 内容猜。这里用一条与任何出站意图无关的真实 speech 记录（`recordQqSpeech` 的独立调用），
   * 它没有 part 身份，事实段承载不了它，所以时间线必须仍有它的原话。
   */
  it("keeps an unmapped standalone legacy assistant line exactly as it was", async () => {
    const f = setup();
    const legacyLine = "没有出站身份的老助手原话";
    // 独立 speech 记录：没有 intent、没有 part、没有 platform id（生产同形状的旧写法）。
    recordQqSpeech(
      f.h.orm,
      {
        scope: {
          kind: "qq",
          accountId,
          conversationKind: "group",
          peerId,
          agentId: DEFAULT_AGENT_ID,
        },
        kind: "chiming_in",
        spokeAtSeconds: sentSeconds - 30,
        text: legacyLine,
      },
      undefined,
    );
    f.say(-8601, atSeconds - 10, "有人吗");

    const material = await f.buildSource(f.runId).read(readInput());
    dumpRaw("case6-unmapped-legacy", material);
    // 强正：这条原话仍在时间线里，一个字都没丢。
    const timelines = timelineSection(material).join("\n");
    expect(timelines).toContain(legacyLine);
    // 强断：它也没有被重复印进事实段（它不是已确认出站件，事实段不该出现这条正文）。
    expect(factsSections(material).join("\n")).not.toContain(legacyLine);
  });

  it("reads nothing back for a stale-epoch scope and never leaks existence", async () => {
    const f = setup();
    const intent = f.commitOutbound("intent-stale-epoch", "跨scope不泄存在");
    await f.deliver(intent.id, { kind: "confirmed", messageId: "-7401" });
    const row = f.h.db
      .query("SELECT authority_revision AS authorityRevision FROM qq_bindings WHERE id=?")
      .get(f.binding.id) as { authorityRevision: number };
    const epoch = f.h.db
      .query("SELECT binding_epoch AS n FROM conversations WHERE id=?")
      .get(f.conversation.id) as { n: number };
    // 同一会话、旧 binding epoch：scope 八维先决失败，恒 missing，不泄部件存在。
    const state = loadQqOutboundMessageFactState(
      { db: f.h.db, orm: f.h.orm },
      {
        conversationId: f.conversation.id,
        accountId,
        conversationKind: "group",
        peerId,
        agentId: DEFAULT_AGENT_ID,
        bindingId: f.binding.id,
        bindingEpoch: epoch.n + 1,
        authorityRevision: row.authorityRevision,
      },
      "-7401",
      now,
    );
    expect(state.state).toBe("missing");
    expect(state.fact).toBeNull();
  });
});
