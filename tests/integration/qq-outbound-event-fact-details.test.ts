// T13 Step6 出站余项（318）：既有 `/v2/conversations/:id/events` 对 `delivery` 事件的
// `qqMessageFacts` 详情组。
//
// 真实链路：合成库 + 真实 qq binding/journal + 生产同序 commit（outbox.commit → journal
// 计划事件 'planned' → recordQqOutboundMessageFact 身份快照）→ 真实 OutboundDelivery +
// 合成端口回执 → conversationRoutes HTTP 读回，严格 `ConversationEventsSchema.parse`。
// 覆盖（规格 §3/§4/§6/§13.4）：
//   * 每个确认部件独立投影（自己的 part.id / 平台消息 ID / 仅该部件正文；program @ 与
//     CQ at 按真实线上顺序，字面 @ 不造 mention）；
//   * 事件时点语义：计划事件（revision='planned'）与中间态不冒"已发"；每个 delivery 事件
//     只显示它自己 revision 快照证明的 confirmed 子集（重复事件各自真实映射）；
//   * mixed / unknown / failed / stale / 缺 legacy authority / 外意图引用 / 重复平台 ID /
//     换绑旧纪元 / authority 推进 / 到期 / 正文漂移 / 缺事实 全部无详情；
//   * assistant 显示真实发送账号与当时双名快照（不是 Agent 配置名，不编 currentName）；
//   * sticker 部件只标存在（readable filter 不入详情组），不泄露 base64/路径；
//   * 分页归属不变。
// 不 mock loader 结果；破坏性负例只做必要的损坏性 UPDATE（注释注明）。

import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { conversationRoutes } from "../../src/server/api/conversations";
import { deliveryRoutes } from "../../src/server/api/deliveries";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  OutboundIntentRepository,
  type OutboundTarget,
} from "../../src/server/db/outbound-intent-repository";
import { recordQqOutboundMessageFact } from "../../src/server/db/qq-message-repository";
import {
  createQqStickerCollection,
  importQqSticker,
} from "../../src/server/db/qq-sticker-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { OneBotSendRequest } from "../../src/server/services/onebot-connection";
import {
  ConversationEventsSchema,
  DeliverySchema,
  type DeliveryStaleReason,
} from "../../src/shared/contracts/conversation";
import type { QqMessagePart } from "../../src/shared/contracts/qq-message";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const now = "2026-10-01T16:00:00.000000Z";
const far = "2033-01-01T00:00:00.000000Z";
const bindingA = "11111111-1111-4111-8111-111111111111";
const bindingB = "22222222-2222-4222-8222-222222222222";

type EventsPage = ReturnType<typeof ConversationEventsSchema.parse>;
type EventItem = EventsPage["items"][number];
type Fixture = ReturnType<typeof setup>;

function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "synthetic-model");
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(now, now);
  const journal = new ConversationEventRepository(h.db);
  const outbox = new OutboundIntentRepository(h.db);
  const addBinding = (id: string, peerId: string): string => {
    h.db
      .query(
        "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,?,?,?,'scheme',?,?)",
      )
      .run(id, "90001", "group", peerId, DEFAULT_AGENT_ID, now, now);
    const conversation = journal.ensureOneBot(id);
    if (!conversation) throw new Error(`fixture: ensureOneBot(${id}) returned null`);
    return conversation.id;
  };
  const conversation = addBinding(bindingA, "30003");
  return { h, journal, outbox, conversation, addBinding };
}

/**
 * 生产同序 commit（bot-host 等价播种）：outbox.commit → journal 计划事件 'planned' →
 * recordQqOutboundMessageFact 身份快照。不做任何"直接 UPDATE 伪 confirmed"。
 */
function commitOutbound(
  f: Fixture,
  conversationId: string,
  bindingId: string,
  intentId: string,
  parts: ({ kind: "text"; text: string } | { kind: "sticker"; stickerId: string })[],
  options: {
    target?: Partial<OutboundTarget>;
    seedFacts?: boolean;
    deliverBy?: string;
    expiresAt?: string;
    sourceThroughSeq?: number;
  } = {},
) {
  const runId = `run-${intentId}`;
  new AgentRunRepository(f.h.db).createRun({
    runId,
    specId: "main",
    specVersion: "1",
    owner: { kind: "conversation", id: conversationId },
    at: now,
  });
  const binding = f.h.db
    .query(
      "SELECT account_id AS accountId,conversation_kind AS conversationKind,peer_id AS peerId,authority_revision AS authorityRevision FROM qq_bindings WHERE id=?",
    )
    .get(bindingId) as {
    accountId: string;
    conversationKind: "group" | "private";
    peerId: string;
    authorityRevision: number;
  };
  const epoch = f.h.db
    .query("SELECT binding_epoch AS n FROM conversations WHERE id=?")
    .get(conversationId) as { n: number };
  const target: OutboundTarget = {
    accountId: binding.accountId,
    conversationKind: binding.conversationKind,
    peerId: binding.peerId,
    agentId: DEFAULT_AGENT_ID,
    bindingId,
    bindingEpoch: epoch.n,
    authorityRevision: binding.authorityRevision,
    ...options.target,
  };
  const intent = f.outbox.commit({
    id: intentId,
    runId,
    conversationId,
    ordinal: 0,
    target,
    speechKind: "direct_reply",
    sourceThroughSeq: options.sourceThroughSeq ?? 0,
    deliverBy: options.deliverBy ?? far,
    createdAt: now,
    expiresAt: options.expiresAt ?? far,
    parts,
  });
  f.journal.append({
    conversationId,
    eventKey: `output:${intent.id}`,
    kind: "delivery",
    source: { kind: "outbound_intent", id: intent.id, revision: "planned", expiresAt: far },
    occurredAt: now,
    runId,
    outputId: intent.id,
  });
  if (options.seedFacts !== false)
    recordQqOutboundMessageFact(
      f.h.orm,
      {
        intentId: intent.id,
        accountId: binding.accountId,
        agentId: DEFAULT_AGENT_ID,
        identity: {
          qq: binding.accountId,
          groupCard: "值班猫娘",
          personalNickname: null,
          legacyDisplayName: null,
          nameState: "known",
        },
        occurredAtSeconds: at,
      },
      6000,
    );
  return intent;
}

type DeliveryStep =
  | { kind: "confirmed"; messageId: string }
  | { kind: "unknown" }
  | { kind: "failed" };

async function deliverIntent(
  f: Fixture,
  intentId: string,
  script: DeliveryStep[],
): Promise<Array<{ request: OneBotSendRequest; step: DeliveryStep | undefined }>> {
  let index = 0;
  const captured: Array<{ request: OneBotSendRequest; step: DeliveryStep | undefined }> = [];
  const delivery = new OutboundDelivery({
    orm: f.h.orm,
    repository: f.outbox,
    journal: f.journal,
    stickerFile: () => "base64://synthetic-sticker",
    authorize: () => true,
    now: () => now,
    port: {
      async send(request: OneBotSendRequest) {
        const step = script[index++];
        captured.push({ request, step });
        if (step?.kind === "confirmed") return { kind: "confirmed", messageId: step.messageId };
        if (step?.kind === "failed") return { kind: "failed", retcode: -1 };
        return { kind: "unknown", reason: "timeout" };
      },
    },
  });
  await delivery.deliver(intentId);
  return captured;
}

function appFor(f: Fixture) {
  return new Hono().route("/v2/conversations", conversationRoutes(f.h.db, { includeShared: true }));
}

async function readEvents(app: Hono, conversationId: string, query = "") {
  const response = await app.request(`/v2/conversations/${conversationId}/events${query}`);
  expect(response.status).toBe(200);
  const raw = await response.text();
  return { page: ConversationEventsSchema.parse(JSON.parse(raw)) as EventsPage, raw };
}

function partIdOf(f: Fixture, intentId: string, ordinal: number): string {
  const row = f.h.db
    .query("SELECT id FROM outbound_parts WHERE intent_id=? AND ordinal=?")
    .get(intentId, ordinal) as { id: string };
  return row.id;
}

function intentRevisionItems(page: EventsPage, intentId: string): EventItem[] {
  return page.items.filter(
    (item) => item.kind === "delivery" && item.eventKey.startsWith(`delivery:${intentId}:`),
  );
}

/** delivery revision 快照（OutboundDelivery.revision 写入的 [status, platformMessageId] 对）。 */
function confirmedOf(item: EventItem): string[] {
  const parsed = JSON.parse(item.source.revision) as Array<[string, string | null]>;
  return parsed
    .filter(([status, platformId]) => status === "confirmed" && platformId !== null)
    .map(([, platformId]) => platformId as string);
}

function toParts(message: OneBotSendRequest["message"]): QqMessagePart[] {
  const parts: QqMessagePart[] = [];
  for (const segment of message) {
    if (segment.type === "at") parts.push({ kind: "mention", qq: segment.data.qq });
    else if (segment.type === "text") parts.push({ kind: "text", text: segment.data.text });
  }
  return parts;
}

describe("T13 outbound delivery event fact details via existing events projection", () => {
  it("projects each confirmed part with its own id/platform id/text and the real program@CQ wire order", async () => {
    const f = setup();
    const intent = commitOutbound(
      f,
      f.conversation,
      bindingA,
      "intent-out-two",
      [
        { kind: "text", text: "回复 [CQ:at,qq=30001] 收到了" },
        { kind: "text", text: "第二条 @30002" },
      ],
      { target: { participantId: "20002" } },
    );
    const captured = await deliverIntent(f, intent.id, [
      { kind: "confirmed", messageId: "-9001" },
      { kind: "confirmed", messageId: "-9002" },
    ]);
    const app = appFor(f);
    const { page, raw } = await readEvents(app, f.conversation);

    // 计划事件（revision='planned'）不冒"已发"详情。
    const commitItem = page.items.find((item) => item.eventKey === `output:${intent.id}`);
    expect(commitItem?.qqMessageFacts).toBeUndefined();

    // 每个 delivery 事件只显示它自己 revision 快照证明的 confirmed 子集（重复事件各自真实映射）。
    const revisionItems = intentRevisionItems(page, intent.id);
    expect(revisionItems.length).toBe(4);
    for (const item of revisionItems) {
      expect((item.qqMessageFacts ?? []).map((fact) => fact.platformMessageId)).toEqual(
        confirmedOf(item),
      );
    }
    const firstConfirmed = page.items.find(
      (item) =>
        item.eventKey ===
        `delivery:${intent.id}:${JSON.stringify([
          ["confirmed", "-9001"],
          ["planned", null],
        ])}`,
    );
    expect(firstConfirmed?.qqMessageFacts?.map((fact) => fact.platformMessageId)).toEqual([
      "-9001",
    ]);

    const finalItem = revisionItems.find((item) => (item.qqMessageFacts?.length ?? 0) === 2);
    if (!finalItem?.qqMessageFacts) throw new Error("final details missing");
    const [first, second] = finalItem.qqMessageFacts;
    if (!first || !second) throw new Error("two facts expected");
    const firstSend = captured[0];
    const secondSend = captured[1];
    if (!firstSend || !secondSend) throw new Error("two sends expected");

    expect(first.id).toBe(partIdOf(f, intent.id, 0));
    expect(first.platformMessageId).toBe("-9001");
    expect(first.parts).toEqual(toParts(firstSend.request.message));
    expect(second.id).toBe(partIdOf(f, intent.id, 1));
    expect(second.platformMessageId).toBe("-9002");
    expect(second.parts).toEqual(toParts(secondSend.request.message));
    // program @ 在 ordinal 0 首位；CQ at 转真实 mention 且保序；字面 @30002 不造 mention。
    expect(first.parts[0]).toEqual({ kind: "mention", qq: "20002" });
    expect(first.mentions).toEqual([
      { qq: "20002", identity: null },
      { qq: "30001", identity: null },
    ]);
    expect(second.parts).toEqual([{ kind: "text", text: "第二条 @30002" }]);
    expect(second.mentions).toEqual([]);
    // assistant 平台身份 = 真实发送账号 + 发送时双名快照；不是 Agent 配置名，不编 currentName。
    expect(first.speaker).toMatchObject({
      role: "assistant",
      qq: "90001",
      groupCard: "值班猫娘",
      personalNickname: null,
      nameState: "known",
    });
    expect(first.speaker.qq).not.toBe(DEFAULT_AGENT_ID);
    expect(first.speaker.currentName).toBeUndefined();
    // 来源只证精确部件（qq_outbound_message_fact，id = outbound_parts.id）。
    expect(first.sources[0]).toMatchObject({
      kind: "qq_outbound_message_fact",
      id: partIdOf(f, intent.id, 0),
    });
    expect(second.sources[0]).toMatchObject({
      kind: "qq_outbound_message_fact",
      id: partIdOf(f, intent.id, 1),
    });
    // 字面渲染不泄露 base64/路径。
    expect(raw.includes("base64")).toBe(false);
    f.h.close();
  });

  it("mixed intent: first confirmed, second unknown — only the confirmed part is detailed", async () => {
    const f = setup();
    const intent = commitOutbound(f, f.conversation, bindingA, "intent-out-mixed", [
      { kind: "text", text: "第一段" },
      { kind: "text", text: "第二段" },
    ]);
    await deliverIntent(f, intent.id, [
      { kind: "confirmed", messageId: "-9101" },
      { kind: "unknown" },
    ]);
    expect(f.outbox.get(intent.id)).toMatchObject({ status: "unknown" });
    const app = appFor(f);
    const { page, raw } = await readEvents(app, f.conversation);
    const revisionItems = intentRevisionItems(page, intent.id);
    for (const item of revisionItems) {
      expect((item.qqMessageFacts ?? []).map((fact) => fact.platformMessageId)).toEqual(
        confirmedOf(item),
      );
      expect(confirmedOf(item).includes("-9102")).toBe(false);
    }
    const detailed = revisionItems.filter((item) => (item.qqMessageFacts?.length ?? 0) > 0);
    expect(detailed.length).toBeGreaterThan(0);
    for (const item of detailed)
      expect(item.qqMessageFacts?.[0]?.parts).toEqual([{ kind: "text", text: "第一段" }]);
    expect(raw.includes("第二段")).toBe(false);
    f.h.close();
  });

  it("planned/unconfirmed/stale/missing-facts intents carry no details", async () => {
    const f = setup();
    const app = appFor(f);
    // 1) 计划 commit，从未投递。
    commitOutbound(f, f.conversation, bindingA, "intent-plan", [{ kind: "text", text: "计划中" }]);
    // 2) 全 unknown/failed：无 confirmed。
    const unknownIntent = commitOutbound(f, f.conversation, bindingA, "intent-unknown", [
      { kind: "text", text: "未发一" },
      { kind: "text", text: "未发二" },
    ]);
    await deliverIntent(f, unknownIntent.id, [{ kind: "unknown" }, { kind: "failed" }]);
    // 3) stale：deliverBy 已过。
    const staleIntent = commitOutbound(
      f,
      f.conversation,
      bindingA,
      "intent-stale",
      [{ kind: "text", text: "过期计划" }],
      { deliverBy: "2026-10-01T15:00:00.000000Z" },
    );
    await deliverIntent(f, staleIntent.id, [{ kind: "confirmed", messageId: "-9200" }]);
    // 4) 旧意图缺出站事实行（commit 时未播种）。
    const legacyIntent = commitOutbound(
      f,
      f.conversation,
      bindingA,
      "intent-legacy-facts",
      [{ kind: "text", text: "缺事实" }],
      { seedFacts: false },
    );
    await deliverIntent(f, legacyIntent.id, [{ kind: "confirmed", messageId: "-9300" }]);
    const { page, raw } = await readEvents(app, f.conversation);
    expect(page.items.length).toBeGreaterThanOrEqual(5);
    expect(page.items.every((item) => item.qqMessageFacts === undefined)).toBe(true);
    expect(raw.includes("未发")).toBe(false);
    // 既有行为边界：legacy 缺 facts 的已确认正文仍经普通 outbound 台账投影展示
    // （qq_send_log 路径），这里只断言不冒"出站事实详情组"，不断言正文不出现。
    f.h.close();
  });

  it("forged sibling/ghost intent references are refused without detail", async () => {
    const f = setup();
    const conversationB = f.addBinding(bindingB, "30004");
    const intentB = commitOutbound(f, conversationB, bindingB, "intent-out-b", [
      { kind: "text", text: "B会话正文" },
    ]);
    await deliverIntent(f, intentB.id, [{ kind: "confirmed", messageId: "-9400" }]);
    // A 的 journal 伪造引用 B 的真实 intent 与不存在的 intent（破坏性负例：真实 API 追加）。
    f.journal.append({
      conversationId: f.conversation,
      eventKey: "forged:sibling",
      kind: "delivery",
      source: {
        kind: "outbound_intent",
        id: intentB.id,
        revision: JSON.stringify([["confirmed", "-9400"]]),
        expiresAt: far,
      },
      occurredAt: now,
    });
    f.journal.append({
      conversationId: f.conversation,
      eventKey: "forged:ghost",
      kind: "delivery",
      source: {
        kind: "outbound_intent",
        id: "intent-ghost",
        revision: JSON.stringify([["confirmed", "-9999"]]),
        expiresAt: far,
      },
      occurredAt: now,
    });
    const app = appFor(f);
    const { page, raw } = await readEvents(app, f.conversation);
    for (const forged of ["forged:sibling", "forged:ghost"]) {
      const item = page.items.find((candidate) => candidate.eventKey === forged);
      expect(item).toBeDefined();
      expect(item?.qqMessageFacts).toBeUndefined();
      expect(item?.text).toBeNull();
      expect(item?.deliveryStatus).toBeNull();
      expect(item?.deliveryStaleReason).toBeNull();
      expect(item?.media).toEqual([]);
    }
    expect(raw).not.toContain("B会话正文");
    // 对照：B 会话自己的事件有详情。
    const { page: pageB } = await readEvents(app, conversationB);
    const factsB = pageB.items.flatMap((item) => item.qqMessageFacts ?? []);
    expect(factsB.map((fact) => fact.platformMessageId)).toEqual(["-9400"]);
    const staleB = commitOutbound(f, conversationB, bindingB, crypto.randomUUID(), [
      { kind: "text", text: "B expired draft" },
    ]);
    f.outbox.stale(staleB.id, now, "DELIVERY_AUTHORITY_CHANGED");
    f.journal.append({
      conversationId: f.conversation,
      eventKey: "forged:expired-metadata",
      kind: "delivery",
      source: {
        kind: "outbound_intent",
        id: staleB.id,
        revision: "stale",
        expiresAt: "2026-10-01T15:00:00.000000Z",
      },
      occurredAt: now,
    });
    const foreign = (await readEvents(app, f.conversation)).page.items.find(
      (event) => event.eventKey === "forged:expired-metadata",
    );
    expect(foreign?.text).toBeNull();
    expect(foreign?.deliveryStatus).toBeNull();
    expect(foreign?.deliveryStaleReason).toBeNull();
    f.h.close();
  });

  it("duplicate platform message id across intents refuses details (ambiguous)", async () => {
    const f = setup();
    const first = commitOutbound(f, f.conversation, bindingA, "intent-dup-a", [
      { kind: "text", text: "重复内容" },
    ]);
    await deliverIntent(f, first.id, [{ kind: "confirmed", messageId: "-9500" }]);
    const app = appFor(f);
    {
      // 对照：单个意图时详情存在。
      const { page } = await readEvents(app, f.conversation);
      expect(page.items.flatMap((item) => item.qqMessageFacts ?? []).length).toBe(1);
    }
    const second = commitOutbound(f, f.conversation, bindingA, "intent-dup-b", [
      { kind: "text", text: "重复内容" },
    ]);
    await deliverIntent(f, second.id, [{ kind: "confirmed", messageId: "-9500" }]);
    const { page } = await readEvents(app, f.conversation);
    expect(page.items.every((item) => item.qqMessageFacts === undefined)).toBe(true);
    f.h.close();
  });

  it("closed epoch after rebind: remapped reads expose no outbound details", async () => {
    const f = setup();
    const intent = commitOutbound(f, f.conversation, bindingA, "intent-out-epoch", [
      { kind: "text", text: "旧纪元出站" },
    ]);
    await deliverIntent(f, intent.id, [{ kind: "confirmed", messageId: "-9600" }]);
    const app = appFor(f);
    {
      const { page } = await readEvents(app, f.conversation);
      expect(page.items.flatMap((item) => item.qqMessageFacts ?? []).length).toBe(1);
    }
    // 换绑到助手 B，再换回同一助手 A：旧纪元会话关闭，历史 remap 到新 epoch。
    f.h.db
      .query(
        "INSERT INTO agents SELECT 'agent-b',name,system_prompt,description,additional_instructions,p5_config,model_name,temperature,memory_consolidation_model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_model_name,memory_retrieval_prompt,context_compression_model_name,persona_intensity,is_active,config_version,updated_at,created_at FROM agents WHERE id=?",
      )
      .run(DEFAULT_AGENT_ID);
    f.h.db.query("UPDATE qq_bindings SET agent_id='agent-b' WHERE id=?").run(bindingA);
    f.journal.ensureOneBot(bindingA);
    f.h.db.query("UPDATE qq_bindings SET agent_id=? WHERE id=?").run(DEFAULT_AGENT_ID, bindingA);
    const rebound = f.journal.ensureOneBot(bindingA);
    if (!rebound) throw new Error("rebound fixture missing");
    expect(rebound.id).not.toBe(f.conversation);
    const { page } = await readEvents(app, rebound.id);
    const oldDelivery = page.items.filter((item) =>
      item.eventKey.startsWith(`delivery:${intent.id}:`),
    );
    expect(oldDelivery.length).toBeGreaterThan(0);
    expect(oldDelivery.every((item) => item.qqMessageFacts === undefined)).toBe(true);
    f.h.close();
  });

  it("legacy authority, expiry and authority advance refuse outbound details", async () => {
    const f = setup();
    const app = appFor(f);
    // 缺 authorityRevision 的旧 target（legacy）。
    const legacy = commitOutbound(
      f,
      f.conversation,
      bindingA,
      "intent-out-legacy-auth",
      [{ kind: "text", text: "旧授权" }],
      { target: { authorityRevision: undefined } },
    );
    await deliverIntent(f, legacy.id, [{ kind: "confirmed", messageId: "-9700" }]);
    // 当前 authority 的正常件（对照）。
    const ok = commitOutbound(f, f.conversation, bindingA, "intent-out-ok", [
      { kind: "text", text: "正常件" },
    ]);
    await deliverIntent(f, ok.id, [{ kind: "confirmed", messageId: "-9701" }]);
    {
      const { page } = await readEvents(app, f.conversation);
      const facts = page.items.flatMap((item) => item.qqMessageFacts ?? []);
      expect(facts.map((fact) => fact.platformMessageId)).toEqual(["-9701"]);
    }
    // intent 到期（破坏性负例：把窗口改到过去）。
    f.h.db
      .query("UPDATE outbound_intents SET expires_at='2000-01-01T00:00:00.000000Z' WHERE id=?")
      .run(ok.id);
    {
      const { page } = await readEvents(app, f.conversation);
      expect(page.items.every((item) => item.qqMessageFacts === undefined)).toBe(true);
    }
    // 新件 + facts 行到期。
    const factsExpired = commitOutbound(f, f.conversation, bindingA, "intent-out-facts-expired", [
      { kind: "text", text: "事实到期" },
    ]);
    await deliverIntent(f, factsExpired.id, [{ kind: "confirmed", messageId: "-9702" }]);
    f.h.db
      .query(
        "UPDATE qq_outbound_message_facts SET expires_at='2000-01-01T00:00:00.000000Z' WHERE intent_id=?",
      )
      .run(factsExpired.id);
    {
      const { page } = await readEvents(app, f.conversation);
      expect(page.items.every((item) => item.qqMessageFacts === undefined)).toBe(true);
    }
    // authority 推进：全部拒绝，且不泄露私文。
    f.h.db.query("UPDATE qq_bindings SET revision=2,authority_revision=2 WHERE id=?").run(bindingA);
    {
      const { page, raw } = await readEvents(app, f.conversation);
      expect(page.items.every((item) => item.qqMessageFacts === undefined)).toBe(true);
      expect(raw.includes("正常件")).toBe(false);
    }
    f.h.close();
  });

  it("facts text drift refuses details and never leaks the tampered body", async () => {
    const f = setup();
    const intent = commitOutbound(f, f.conversation, bindingA, "intent-out-drift", [
      { kind: "text", text: "原始正文" },
    ]);
    await deliverIntent(f, intent.id, [{ kind: "confirmed", messageId: "-9800" }]);
    const app = appFor(f);
    {
      const { page } = await readEvents(app, f.conversation);
      expect(page.items.flatMap((item) => item.qqMessageFacts ?? []).length).toBe(1);
    }
    // 破坏性负例：facts 快照正文与真实 payload 不一致。
    f.h.db
      .query("UPDATE qq_outbound_message_facts SET parts=? WHERE intent_id=?")
      .run(
        JSON.stringify([{ kind: "text", ordinal: 0, platformMessageId: "-9800", text: "被改写" }]),
        intent.id,
      );
    const { page, raw } = await readEvents(app, f.conversation);
    expect(page.items.every((item) => item.qqMessageFacts === undefined)).toBe(true);
    expect(raw.includes("被改写")).toBe(false);
    f.h.close();
  });

  it("pagination attribution: paged reads carry the same per-event facts as the full read", async () => {
    const f = setup();
    const a = commitOutbound(f, f.conversation, bindingA, "intent-page-a", [
      { kind: "text", text: "分页甲" },
    ]);
    const b = commitOutbound(f, f.conversation, bindingA, "intent-page-b", [
      { kind: "text", text: "分页乙" },
    ]);
    await deliverIntent(f, a.id, [{ kind: "confirmed", messageId: "-9901" }]);
    await deliverIntent(f, b.id, [{ kind: "confirmed", messageId: "-9902" }]);
    const app = appFor(f);
    const { page: full } = await readEvents(app, f.conversation);
    const factsKey = (items: EventItem[]) =>
      items
        .map((item) => [item.eventKey, JSON.stringify(item.qqMessageFacts ?? null)] as const)
        .sort(([x], [y]) => x.localeCompare(y));
    let cursor = 0;
    const collected: EventItem[] = [];
    for (let guard = 0; guard < 100; guard++) {
      const { page } = await readEvents(app, f.conversation, `?afterSeq=${cursor}&limit=2`);
      collected.push(...page.items);
      cursor = page.nextSeq;
      if (!page.hasMore) break;
    }
    expect(factsKey(collected)).toEqual(factsKey(full.items));
    for (const item of collected) {
      expect(item.conversationId).toBe(f.conversation);
      for (const fact of item.qqMessageFacts ?? []) {
        if (item.eventKey.startsWith("delivery:intent-page-a:")) {
          expect(fact.parts).toEqual([{ kind: "text", text: "分页甲" }]);
          expect(fact.platformMessageId).toBe("-9901");
        }
        if (item.eventKey.startsWith("delivery:intent-page-b:")) {
          expect(fact.parts).toEqual([{ kind: "text", text: "分页乙" }]);
          expect(fact.platformMessageId).toBe("-9902");
        }
      }
    }
    f.h.close();
  });

  it("sticker parts mark existence only and never leak bytes into the detail group", async () => {
    const f = setup();
    const collection = createQqStickerCollection(f.h.orm, { name: "coll-out-sticker" });
    importQqSticker(f.h.orm, {
      id: "sticker-out-1",
      copy: { fileName: "sticker-out-1.png", byteSize: 64, mediaType: "image" },
      name: "wave-out",
      width: 64,
      height: 64,
      collectionIds: [collection.id],
    });
    const mixed = commitOutbound(f, f.conversation, bindingA, "intent-sticker-mixed", [
      { kind: "text", text: "带表情正文" },
      { kind: "sticker", stickerId: "sticker-out-1" },
    ]);
    await deliverIntent(f, mixed.id, [
      { kind: "confirmed", messageId: "-9950" },
      { kind: "confirmed", messageId: "-9951" },
    ]);
    const stickerOnly = commitOutbound(f, f.conversation, bindingA, "intent-sticker-only", [
      { kind: "sticker", stickerId: "sticker-out-1" },
    ]);
    await deliverIntent(f, stickerOnly.id, [{ kind: "confirmed", messageId: "-9952" }]);
    const app = appFor(f);
    const { page, raw } = await readEvents(app, f.conversation);
    // mixed 的终态事件：文本件进入详情组，sticker 件（completeness=unavailable）不进入。
    const finalRevision = JSON.stringify([
      ["confirmed", "-9950"],
      ["confirmed", "-9951"],
    ]);
    const finalItem = page.items.find(
      (item) => item.eventKey === `delivery:${mixed.id}:${finalRevision}`,
    );
    expect(finalItem?.qqMessageFacts?.map((fact) => fact.platformMessageId)).toEqual(["-9950"]);
    expect(finalItem?.qqMessageFacts?.[0]?.parts).toEqual([{ kind: "text", text: "带表情正文" }]);
    // 纯 sticker 事件：详情组为空，但事件基投影的 media 仍标存在可读。
    const stickerRevision = JSON.stringify([["confirmed", "-9952"]]);
    const stickerItem = page.items.find(
      (item) => item.eventKey === `delivery:${stickerOnly.id}:${stickerRevision}`,
    );
    expect(stickerItem?.qqMessageFacts).toBeUndefined();
    expect(
      stickerItem?.media.some(
        (media) => media.kind === "sticker" && media.availability === "available",
      ),
    ).toBe(true);
    // sticker 平台 ID 从不进入详情组。
    expect(
      page.items
        .flatMap((item) => item.qqMessageFacts ?? [])
        .every((fact) => fact.platformMessageId !== "-9951" && fact.platformMessageId !== "-9952"),
    ).toBe(true);
    expect(raw.includes("base64")).toBe(false);
    f.h.close();
  });
});

describe("recorded delivery invalidation reasons", () => {
  const readDelivery = async (f: Fixture, id: string) => {
    const app = new Hono().route("/v2/deliveries", deliveryRoutes(f.h.db, { includeShared: true }));
    const response = await app.request(`/v2/deliveries/${id}`);
    expect(response.status).toBe(200);
    return DeliverySchema.parse(await response.json());
  };
  const checkProjection = async (f: Fixture, id: string, reason: DeliveryStaleReason | null) => {
    expect((await readDelivery(f, id)).staleReason).toBe(reason);
    const { page } = await readEvents(appFor(f), f.conversation);
    const items = page.items.filter((event) => event.outputId === id);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((event) => event.deliveryStaleReason === reason)).toBe(true);
  };
  const deliveryFor = (f: Fixture, authorize = true) =>
    new OutboundDelivery({
      orm: f.h.orm,
      repository: f.outbox,
      journal: f.journal,
      stickerFile: () => null,
      authorize: () => authorize,
      now: () => now,
      port: {
        async send() {
          throw new Error("unexpected send");
        },
      },
    });

  for (const reason of [
    "DELIVERY_TTL_EXPIRED",
    "CONVERSATION_CHANGED",
    "DELIVERY_AUTHORITY_CHANGED",
    "SOURCE_EXPIRED",
  ] as const) {
    it(`persists ${reason} through delivery and timeline routes`, async () => {
      const f = setup();
      const intent = commitOutbound(
        f,
        f.conversation,
        bindingA,
        crypto.randomUUID(),
        [{ kind: "text", text: "unconfirmed synthetic body" }],
        {
          deliverBy: reason === "DELIVERY_TTL_EXPIRED" ? "2026-10-01T15:00:00.000000Z" : far,
          expiresAt: reason === "SOURCE_EXPIRED" ? "2026-10-01T15:30:00.000000Z" : far,
        },
      );
      const delivery = deliveryFor(f, reason !== "DELIVERY_AUTHORITY_CHANGED");
      if (reason === "CONVERSATION_CHANGED") {
        f.journal.append({
          conversationId: f.conversation,
          eventKey: "new-related-input",
          kind: "inbound",
          source: { kind: "qq_event", id: "synthetic-input", revision: "1" },
          participant: { id: "50001", label: "Member", role: "member" },
          addressing: { reasons: ["mention"], mentionIds: [] },
          occurredAt: now,
        });
      }
      if (reason === "SOURCE_EXPIRED") delivery.housekeep();
      else await delivery.deliver(intent.id);
      expect(f.outbox.get(intent.id)?.status).toBe("stale");
      expect(new OutboundIntentRepository(f.h.db).get(intent.id)?.staleReason).toBe(reason);
      await checkProjection(f, intent.id, reason);
      delivery.housekeep();
      expect(f.outbox.get(intent.id)?.staleReason).toBe(reason);
      if (reason === "SOURCE_EXPIRED") expect(f.outbox.parts(intent.id)[0]?.payload).toBeNull();
      const { raw } = await readEvents(appFor(f), f.conversation);
      expect(raw).not.toContain("unconfirmed synthetic body");
    });
  }

  it("keeps unrecorded historical reasons unknown and preserves an already recorded reason", async () => {
    const f = setup();
    const legacy = commitOutbound(f, f.conversation, bindingA, crypto.randomUUID(), [
      { kind: "text", text: "legacy draft" },
    ]);
    expect(f.outbox.stale(legacy.id, now)).toBe(true);
    await checkProjection(f, legacy.id, null);
    expect(f.outbox.stale(legacy.id, now, "DELIVERY_TTL_EXPIRED")).toBe(false);
    expect(f.outbox.get(legacy.id)?.staleReason).toBeNull();
    const ttl = commitOutbound(
      f,
      f.conversation,
      bindingA,
      crypto.randomUUID(),
      [{ kind: "text", text: "recorded draft" }],
      {
        deliverBy: "2026-10-01T15:00:00.000000Z",
        expiresAt: "2026-10-01T16:30:00.000000Z",
      },
    );
    await deliveryFor(f).deliver(ttl.id);
    f.outbox.purgeExpired("2026-10-01T17:00:00.000000Z");
    expect(f.outbox.get(ttl.id)?.staleReason).toBe("DELIVERY_TTL_EXPIRED");
  });

  it("exposes null on non-stale records and clears residual reasons when replacing a planned draft", async () => {
    const f = setup();
    const intent = commitOutbound(f, f.conversation, bindingA, crypto.randomUUID(), [
      { kind: "text", text: "first draft" },
    ]);
    // A valid but inconsistent stored reason must not override the actual status.
    f.h.db
      .query("UPDATE outbound_intents SET stale_reason='DELIVERY_TTL_EXPIRED' WHERE id=?")
      .run(intent.id);
    await checkProjection(f, intent.id, null);
    const row = f.outbox.row(intent.id)!;
    const replacementRunId = crypto.randomUUID();
    new AgentRunRepository(f.h.db).createRun({
      runId: replacementRunId,
      specId: "main",
      specVersion: "1",
      owner: { kind: "conversation", id: f.conversation },
      at: now,
    });
    f.outbox.commit({
      id: intent.id,
      runId: replacementRunId,
      conversationId: f.conversation,
      ordinal: 0,
      target: JSON.parse(row.target),
      speechKind: "direct_reply",
      sourceThroughSeq: 0,
      deliverBy: far,
      createdAt: now,
      expiresAt: far,
      parts: [{ kind: "text", text: "replacement draft" }],
    });
    expect(f.outbox.row(intent.id)?.stale_reason).toBeNull();
    await deliverIntent(f, intent.id, [{ kind: "confirmed", messageId: "-9960" }]);
    f.h.db
      .query("UPDATE outbound_intents SET stale_reason='SOURCE_EXPIRED' WHERE id=?")
      .run(intent.id);
    await checkProjection(f, intent.id, null);
  });

  it("retains authorized confirmed partial text until its content retention expires", async () => {
    const f = setup();
    const intent = commitOutbound(f, f.conversation, bindingA, crypto.randomUUID(), [
      { kind: "text", text: "confirmed partial body" },
      { kind: "text", text: "unconfirmed tail body" },
    ]);
    const claimed = f.outbox.claimPart(intent.id, now)!;
    f.outbox.settlePart(claimed.part.id, { status: "confirmed", messageId: "-9961" }, now);
    expect(f.outbox.stale(intent.id, now, "DELIVERY_AUTHORITY_CHANGED")).toBe(true);
    await checkProjection(f, intent.id, "DELIVERY_AUTHORITY_CHANGED");
    let page = await readEvents(appFor(f), f.conversation);
    expect(page.page.items.find((event) => event.outputId === intent.id)?.text).toBe(
      "confirmed partial body",
    );
    expect(page.raw).not.toContain("unconfirmed tail body");
    expect(f.outbox.parts(intent.id).map((part) => part.status)).toEqual(["confirmed", "stale"]);
    // An older event cap can expire before the current intent retention cap.
    f.journal.append({
      conversationId: f.conversation,
      eventKey: "expired-output-metadata",
      kind: "delivery",
      source: {
        kind: "outbound_intent",
        id: intent.id,
        revision: "expired-cap",
        expiresAt: "2026-10-01T15:00:00.000000Z",
      },
      occurredAt: now,
      runId: intent.runId,
      outputId: intent.id,
    });
    const cappedPage = await readEvents(appFor(f), f.conversation);
    const capped = cappedPage.page.items.find(
      (event) => event.eventKey === "expired-output-metadata",
    );
    expect(capped?.text).toBeNull();
    expect(capped?.deliveryStaleReason).toBe("DELIVERY_AUTHORITY_CHANGED");

    // Expiration hides the body without changing the recorded invalidation cause or receipt.
    f.h.db
      .query("UPDATE outbound_intents SET expires_at='2026-10-01T15:00:00.000000Z' WHERE id=?")
      .run(intent.id);
    deliveryFor(f).housekeep();
    page = await readEvents(appFor(f), f.conversation);
    expect(page.page.items.find((event) => event.outputId === intent.id)?.text).toBeNull();
    expect(f.outbox.parts(intent.id).every((part) => part.payload === null)).toBe(true);
    expect(f.outbox.get(intent.id)?.staleReason).toBe("DELIVERY_AUTHORITY_CHANGED");
    expect(f.outbox.parts(intent.id)[0]?.platform_message_id).toBe("-9961");
  });

  it("does not replace in-flight or unknown receipt states with a stale cause", () => {
    const f = setup();
    const intent = commitOutbound(
      f,
      f.conversation,
      bindingA,
      crypto.randomUUID(),
      [{ kind: "text", text: "in-flight body" }],
      { expiresAt: "2026-10-01T15:30:00.000000Z" },
    );
    const claim = f.outbox.claimPart(intent.id, now)!;
    expect(f.outbox.stale(intent.id, now, "DELIVERY_TTL_EXPIRED")).toBe(false);
    f.outbox.purgeExpired(now);
    expect(f.outbox.get(intent.id)?.status).toBe("delivering");
    expect(f.outbox.get(intent.id)?.staleReason).toBeNull();
    f.outbox.settlePart(claim.part.id, { status: "unknown" }, now);
    f.outbox.purgeExpired(now);
    expect(f.outbox.get(intent.id)?.status).toBe("unknown");
    expect(f.outbox.get(intent.id)?.staleReason).toBeNull();
  });
});
