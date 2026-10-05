import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  assertContextSources,
  inspectContext,
  sourceAccess,
} from "../../src/server/agent/context-access";
import {
  loadQqMessageFact,
  projectQqMessageFacts,
} from "../../src/server/channels/onebot11/message-projection";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import {
  qqMessageFactConsumableCap,
  qqMessageFactSourceAccess,
} from "../../src/server/services/qq-message-fact-sources";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";

const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const now = "2026-10-01T16:00:00.000000Z";

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

function bind(h: ReturnType<typeof setup>, id = "binding", peerId = "30003", kind = "group") {
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(now, now);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,?,?,?,'scheme',?,?)",
    )
    .run(id, "90001", kind, peerId, DEFAULT_AGENT_ID, now, now);
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(id);
  if (!conversation) throw new Error("conversation fixture missing");
  return { journal, conversation };
}

function alinObservation(messageId: number, text = "你不是就在南京吗？", groupId = 30003) {
  const result = normalizeOneBotMessage(
    {
      time: at,
      self_id: 90001,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: messageId,
      user_id: 10001,
      group_id: groupId,
      sender: { card: "   ", nickname: "阿林" },
      message: [
        { type: "reply", data: { id: -101 } },
        { type: "at", data: { qq: 10002 } },
        { type: "text", data: { text } },
      ],
    },
    "90001",
  );
  if (result.kind !== "message") throw new Error("message expected");
  return result.observation;
}

function liveScope(
  h: ReturnType<typeof setup>,
  conversation: { id: string; bindingEpoch: number },
  bindingId = "binding",
): QqConversationScope {
  const c = h.db
    .query("SELECT binding_epoch FROM conversations WHERE id=?")
    .get(conversation.id) as { binding_epoch: number };
  const b = h.db
    .query(
      "SELECT account_id,conversation_kind,peer_id,agent_id,authority_revision FROM qq_bindings WHERE id=?",
    )
    .get(bindingId) as {
    account_id: string;
    conversation_kind: "group" | "private";
    peer_id: string;
    agent_id: string;
    authority_revision: number;
  };
  return {
    conversationId: conversation.id,
    accountId: b.account_id,
    conversationKind: b.conversation_kind,
    peerId: b.peer_id,
    agentId: b.agent_id,
    bindingId,
    bindingEpoch: c.binding_epoch,
    authorityRevision: b.authority_revision,
  };
}

function recordWithJournal(
  h: ReturnType<typeof setup>,
  journal: ConversationEventRepository,
  bindingId: string,
  observation: ReturnType<typeof alinObservation>,
) {
  recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
  return journal.ingestOneBotEvent(observation.eventKey, bindingId);
}

function ownerFor(
  scope: QqConversationScope,
  kind: "conversation" | "qq_binding",
  overrides: Partial<RunOwner> = {},
): RunOwner {
  return {
    kind,
    id: kind === "conversation" ? scope.conversationId : scope.bindingId,
    userId: DEFAULT_USER_ID,
    agentId: scope.agentId,
    ...overrides,
  };
}

function factRefOf(fact: NonNullable<ReturnType<typeof loadQqMessageFact>>): SourceRef {
  const ref = fact.sources.find((s) => s.kind === "qq_message_fact");
  if (!ref) throw new Error("qq_message_fact ref missing");
  return ref;
}

function bodyRefOf(fact: NonNullable<ReturnType<typeof loadQqMessageFact>>): SourceRef {
  const ref = fact.sources.find((s) => s.kind === "qq_observation");
  if (!ref) throw new Error("qq_observation ref missing");
  return ref;
}

describe("qq_message_fact source access (owner-first, unified revision)", () => {
  it("mints via real projection and verifies available for both owner shapes through the same service", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-102", now);
      expect(fact).not.toBeNull();
      if (!fact) return;
      const ref = factRefOf(fact);
      expect(ref.id).toBe(observation.eventKey);
      // 真实投影 mint 与新服务 access 共用同一 revision 函数：两个 owner 形态都 available。
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          ownerFor(live, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          ownerFor(live, "qq_binding"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      // 统一入口 sourceAccess 经 kind delegate 走同一函数。
      expect(
        sourceAccess(h.db, ref, ownerFor(live, "conversation"), { userId: DEFAULT_USER_ID }, now),
      ).toBe("available");
    } finally {
      h.close();
    }
  });

  it("owner authorization is four-dimensional: wrong user / no agent / wrong agent / foreign conversation / foreign eventKey all revoked", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(h, journal, "binding", alinObservation(-102));
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-102", now);
      if (!fact) throw new Error("fact missing");
      const ref = factRefOf(fact);
      const principal = { userId: DEFAULT_USER_ID };
      // 基线：完整四维 owner available。
      expect(
        qqMessageFactSourceAccess(h.db, ref, ownerFor(live, "conversation"), principal, nowIso()),
      ).toBe("available");
      // principal 与 owner.userId 不一致 → revoked。
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          { ...ownerFor(live, "conversation"), userId: "someone-else" },
          { userId: "someone-else" },
          nowIso(),
        ),
      ).toBe("revoked");
      // 非 DEFAULT_USER_ID principal → revoked。
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          ownerFor(live, "conversation"),
          { userId: "someone-else" },
          nowIso(),
        ),
      ).toBe("revoked");
      // 无显式 agentId（R21 四维）→ revoked。
      const noAgent = ownerFor(live, "conversation");
      delete (noAgent as { agentId?: string }).agentId;
      expect(qqMessageFactSourceAccess(h.db, ref, noAgent, principal, nowIso())).toBe("revoked");
      // agentId 错 → revoked。
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          { ...ownerFor(live, "conversation"), agentId: "other-agent" },
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // owner 指向别间会话 → revoked。
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          { ...ownerFor(live, "conversation"), id: "other-conversation" },
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // 外群 eventKey 的伪造 ref：revoked（scope SQL 全过滤，不泄露存在性）。
      expect(
        qqMessageFactSourceAccess(
          h.db,
          { ...ref, id: "onebot:-999:999" },
          ownerFor(live, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // 未知 owner kind → revoked。
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          { kind: "web_turn", id: "t1", userId: DEFAULT_USER_ID },
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("epoch/authority change and closed conversation revoke old refs; a new conversation of the same binding does not revive them", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-102", now);
      if (!fact) throw new Error("fact missing");
      const ref = factRefOf(fact);
      const principal = { userId: DEFAULT_USER_ID };
      expect(
        qqMessageFactSourceAccess(h.db, ref, ownerFor(live, "qq_binding"), principal, nowIso()),
      ).toBe("available");
      // 权限纪元前进（换绑/提权）：scope 现值变化 → evidenceScopeExists 失败 → revoked；
      // 投影按新 scope 也读不到（旧 epoch 的 ref 不复活）。
      h.orm
        .update(schema.qqBindings)
        .set({ revision: 2, authorityRevision: 2 })
        .where(eq(schema.qqBindings.id, live.bindingId))
        .run();
      const liveAfter = liveScope(h, conversation);
      expect(liveAfter.authorityRevision).toBe(2);
      // 当前权限持有者以新 scope 投影仍可读（scope 由调用方提供并复验），但旧 ref 的
      // revision 冻结了旧 authorityRevision，复算不等 → revoked（不能复活旧纪元 ref）。
      expect(loadQqMessageFact(h, liveAfter, "-102", now)).not.toBeNull();
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          ownerFor(liveAfter, "qq_binding"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("fact expiry reads expired for the right owner; cross-owner never learns the expired state (R21 order)", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-102", now);
      if (!fact) throw new Error("fact missing");
      const ref = factRefOf(fact);
      const principal = { userId: DEFAULT_USER_ID };
      // 正确 owner、窗口外：expired（不是 revoked，也不是 available）。
      const past = "2026-10-20T00:00:01.000000Z";
      expect(
        qqMessageFactSourceAccess(h.db, ref, ownerFor(live, "conversation"), principal, past),
      ).toBe("expired");
      // ref 自带帽过期同样 expired。
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          ownerFor(live, "conversation"),
          principal,
          "2026-10-19T00:00:00.000000Z",
        ),
      ).toBe("expired");
      // 错误 owner 同一时刻：revoked（不得探得 expired 态）。
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          { ...ownerFor(live, "conversation"), agentId: "other-agent" },
          principal,
          past,
        ),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("facts revision / body rewrite and delete / expiry: fact ref turns revoked or expired, body never revives from parts", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-102", now);
      if (!fact) throw new Error("fact missing");
      const ref = factRefOf(fact);
      const bodyRef = bodyRefOf(fact);
      const principal = { userId: DEFAULT_USER_ID };
      const owner = ownerFor(live, "conversation");
      expect(qqMessageFactSourceAccess(h.db, ref, owner, principal, nowIso())).toBe("available");
      // facts revision 前进（backfill 补齐推进）：旧 fact ref 复算不等 → revoked。
      h.db
        .query("UPDATE qq_message_facts SET revision=revision+1 WHERE event_key=?")
        .run(observation.eventKey);
      expect(qqMessageFactSourceAccess(h.db, ref, owner, principal, nowIso())).toBe("revoked");
      // body 独立改写：qq_observation ref 经统一 sourceAccess 复算不等 → revoked
      // （正文只经自己来源可读；qq_observation 走既有 case，不走 fact delegate）。
      h.db
        .query("UPDATE qq_observation_text SET body='被改写过的正文' WHERE event_key=?")
        .run(observation.eventKey);
      expect(sourceAccess(h.db, bodyRef, owner, principal, now)).toBe("revoked");
      // body 删除：fact ref 因 hash 内 body 项为 null 翻 revoked（fail closed，
      // 正文不从 parts 复活）。qq_observation ref 的删除态走既有 case 语义（行没了
      // expires_at 为 NULL → expired），本轮不改它。
      h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(observation.eventKey);
      expect(sourceAccess(h.db, bodyRef, owner, principal, now)).toBe("expired");
      const mintedAfterDelete = loadQqMessageFact(h, live, "-102", now);
      expect(mintedAfterDelete).not.toBeNull();
      if (!mintedAfterDelete) return;
      expect(mintedAfterDelete.parts.some((p) => p.kind === "text" && p.text.length > 0)).toBe(
        false,
      );
      // body 过期（未删除）：qq_observation 通用口径 expired（统一 sourceAccess）；
      // fact ref 的 hash 覆盖 body 修订，到期 body 不再进 hash → 新 mint 的 fact ref
      // 只剩事实窗口（另测）。
      const later = "2026-10-16T16:00:01.000000Z";
      expect(sourceAccess(h.db, bodyRef, owner, principal, later)).toBe("expired");
      // fact 快照到期：expired（正确 owner），且不被永久事件身份或 currentName 复活。
      expect(
        qqMessageFactSourceAccess(
          h.db,
          { ...ref, expiresAt: "2026-10-20T00:00:00.000000Z" },
          owner,
          principal,
          "2026-10-20T00:00:01.000000Z",
        ),
      ).toBe("expired");
    } finally {
      h.close();
    }
  });

  it("unlinked timeline: a fact row outside the conversation journal reads revoked", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      const observation = alinObservation(-102);
      // 只落库（recordObservation），不 ingest journal → 事件不在 timeline。
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-102", now);
      expect(fact).toBeNull();
      // 手工构造 ref 形状（无真实 mint：投影已拒绝）→ access 也 revoked。
      const ref: SourceRef = {
        kind: "qq_message_fact",
        id: observation.eventKey,
        revision: "0".repeat(64),
        expiresAt: "2026-10-20T00:00:00.000000Z",
      };
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          ownerFor(live, "conversation"),
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("media-only fact without a body is available in full; assertContextSources/inspectContext keep the direct-domain kind authoritative", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-105, "");
      observation.segments = [{ kind: "image", file: "picture" }];
      observation.text = "";
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-105", now);
      expect(fact).not.toBeNull();
      if (!fact) return;
      expect(fact.completeness).toBe("full");
      const ref = factRefOf(fact);
      const owner = ownerFor(live, "conversation");
      const principal = { userId: DEFAULT_USER_ID };
      expect(qqMessageFactSourceAccess(h.db, ref, owner, principal, nowIso())).toBe("available");
      // assertContextSources：qq_message_fact 不被 optional resolver 覆盖——外部解析器
      // 返回 available 也不能翻掉直接域 revoked（恶意/越权 resolver 不可绕过）。
      h.db
        .query("UPDATE qq_message_facts SET revision=revision+1 WHERE event_key=?")
        .run(observation.eventKey);
      expect(() =>
        assertContextSources({
          db: h.db,
          sources: [ref],
          owner,
          now: nowIso(),
          resolveSource: () => "available",
          memoryRevisions: () => new Map(),
          messages: { memory: "memory changed", other: "source invalid" },
        }),
      ).toThrow("source invalid");
      // inspectContext：真实持久 run 里新 facts ref 可 available，body 删除后 redact。
      const repository = new AgentRunRepository(h.db);
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      const handle = { runId, stepId };
      repository.createRun({
        runId,
        specId: "test",
        specVersion: "1",
        owner,
        at: nowIso(),
      });
      const fresh = loadQqMessageFact(h, live, "-105", now);
      if (!fresh) throw new Error("fresh fact missing");
      const freshRef = factRefOf(fresh);
      // 该消息本就 media-only：fact ref 不含 body 项，body 删除前后 revision 相同。
      repository.startStep({
        runId,
        stepId,
        stepNo: 1,
        model: "synthetic-model",
        phase: "generate",
        at: nowIso(),
        messages: [{ role: "user", content: [{ kind: "text", text: "图片问题" }] }],
        sources: [freshRef],
      });
      expect(inspectContext(h.db, repository, handle, principal)?.status).toBe("exact");
      // 可选 resolver 返回 available 也不能把直接域判定的 revoked 翻回来。
      h.db
        .query("UPDATE qq_message_facts SET revision=revision+1 WHERE event_key=?")
        .run(observation.eventKey);
      expect(inspectContext(h.db, repository, handle, principal)?.status).toBe("revoked");
      expect(repository.getContext(handle)?.messages).toBeNull();
    } finally {
      h.close();
    }
  });

  it("projection and service share one revision: a stale projected fact ref never verifies after facts change", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-102", now);
      if (!fact) throw new Error("fact missing");
      const ref = factRefOf(fact);
      // 同一 eventKey 的批量投影产出同一 ref（同一 revision 函数）。
      const projected = projectQqMessageFacts(h, live, [observation.eventKey], now);
      expect(projected).toHaveLength(1);
      const projectedFact = projected[0];
      if (!projectedFact) return;
      expect(factRefOf(projectedFact)).toEqual(ref);
      const principal = { userId: DEFAULT_USER_ID };
      const owner = ownerFor(live, "qq_binding");
      expect(qqMessageFactSourceAccess(h.db, ref, owner, principal, nowIso())).toBe("available");
      // 会话换纪元后（新 epoch 会话），旧 epoch 的 ref：ownerScope 定位到新会话，
      // ref revision 冻结旧 epoch → 复算不等 → revoked；新 scope 投影为新 ref。
      h.db
        .query("UPDATE conversations SET closed_at=? WHERE id=?")
        .run(nowIso(), live.conversationId);
      const conversation2 = journal.ensureOneBot("binding");
      if (!conversation2) throw new Error("conversation fixture missing");
      if (conversation2.id === live.conversationId) throw new Error("expected new conversation");
      const live2 = liveScope(h, conversation2);
      // 新纪元会话的水位拒收旧事件（旧 ref 不可跨 epoch 复活）。
      expect(loadQqMessageFact(h, live2, "-102", now)).toBeNull();
      expect(projectQqMessageFacts(h, live2, [observation.eventKey], now)).toEqual([]);
      expect(
        qqMessageFactSourceAccess(h.db, ref, ownerFor(live2, "qq_binding"), principal, nowIso()),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("consumable cap: body earlier than fact caps the minted ref at the body window; ambiguous owner fails closed", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      // 正文窗口早于事实窗口：把 qq_observation_text.expires_at 提前（fact 行期不动）。
      const earlyBodyCap = "2026-10-05T00:00:00.000000Z";
      h.db
        .query("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?")
        .run(earlyBodyCap, observation.eventKey);
      const fact = loadQqMessageFact(h, live, "-102", now);
      if (!fact) throw new Error("fact missing");
      const ref = factRefOf(fact);
      // mint 的 qq_message_fact 帽 = fact/body 实际可消费最早值（返回行帽原字符串）。
      expect(ref.expiresAt).toBe(earlyBodyCap);
      expect(
        qqMessageFactConsumableCap(
          h.db,
          live,
          observation.eventKey,
          factExpiresOf(h, observation.eventKey),
          now,
        ),
      ).toBe(earlyBodyCap);
      const principal = { userId: DEFAULT_USER_ID };
      const owner = ownerFor(live, "conversation");
      // 帽内 available；帽后 fact ref 已 expired（旧 ref 到期不复活，帽不延长）。
      expect(qqMessageFactSourceAccess(h.db, ref, owner, principal, now)).toBe("available");
      expect(
        qqMessageFactSourceAccess(h.db, ref, owner, principal, "2026-10-05T00:00:01.000000Z"),
      ).toBe("expired");
      // 帽后新投影：正文行已过帽（不可消费）→ 新 mint 的帽回到 fact 自身窗口
      // （实际可消费正文为空，不虚构更晚的 body 帽），parts 降级、正文不复活。
      const lateMint = loadQqMessageFact(h, live, "-102", "2026-10-05T00:00:02.000000Z");
      expect(lateMint).not.toBeNull();
      if (lateMint) {
        expect(factRefOf(lateMint).expiresAt).toBe(factExpiresOf(h, observation.eventKey));
        expect(lateMint.sources.some((s) => s.kind === "qq_observation")).toBe(false);
        expect(lateMint.completeness).toBe("unavailable");
      }
      // 事实窗口早于正文窗口：fact 行帽提前（body 行期不动）。
      const earlyFactCap = "2026-10-03T00:00:00.000000Z";
      h.db
        .query("UPDATE qq_message_facts SET expires_at=? WHERE event_key=?")
        .run(earlyFactCap, observation.eventKey);
      const earlyCapped = loadQqMessageFact(h, live, "-102", now);
      expect(earlyCapped).not.toBeNull();
      if (earlyCapped) {
        // 最早值取 fact 帽（早于 body 帽与原 fact 值）。
        expect(factRefOf(earlyCapped).expiresAt).toBe(earlyFactCap);
      }
      // 无正文行（media-only）：只有 fact 帽，不虚构 body 帽。
      const mediaOnly = alinObservation(-106, "");
      mediaOnly.segments = [{ kind: "image", file: "picture" }];
      mediaOnly.text = "";
      recordWithJournal(h, journal, "binding", mediaOnly);
      const mediaOnlyFact = loadQqMessageFact(h, live, "-106", now);
      if (!mediaOnlyFact) throw new Error("media-only fact missing");
      expect(mediaOnlyFact.completeness).toBe("full");
      expect(factRefOf(mediaOnlyFact).expiresAt).toBe(factExpiresOf(h, mediaOnly.eventKey));
      // 歧义 owner：同一绑定两间开放会话（正常 DDL 下部分唯一索引不允许；本用例内
      // 已先 drop 该索引造出歧义行）：fail closed，不用 LIMIT 1 猜——revoked 先于
      // 任何期限判定。
      h.db.query("DROP INDEX uq_conversations_current_source").run();
      h.db
        .query(
          "INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,binding_epoch,source_watermark,next_seq,consumed_seq,created_at,updated_at) SELECT 'dup-'||substr(id,1,8)||? ,channel,topology,source_id,agent_id,user_id,binding_epoch+1,0,1,0,?,? FROM conversations WHERE id=?",
        )
        .run(crypto.randomUUID().slice(0, 4), now, now, live.conversationId);
      const dupCount = h.db
        .query(
          "SELECT count(*) AS n FROM conversations WHERE channel='onebot11' AND source_id=? AND closed_at IS NULL",
        )
        .get(live.bindingId) as { n: number };
      expect(dupCount.n).toBe(2);
      expect(
        qqMessageFactSourceAccess(h.db, ref, ownerFor(live, "qq_binding"), principal, now),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("mint and access expose the same visible state; frozen ref cap never extends after window tightening", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      // 先收紧正文窗口再 mint：投影与 access 读同一 stored/visible/bodyRevision/
      // consistency 状态——同一时刻两侧判定一致。
      const tightBodyCap = "2026-10-06T00:00:00.000000Z";
      h.db
        .query("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?")
        .run(tightBodyCap, observation.eventKey);
      const fact = loadQqMessageFact(h, live, "-102", now);
      if (!fact) throw new Error("fact missing");
      const ref = factRefOf(fact);
      const principal = { userId: DEFAULT_USER_ID };
      const owner = ownerFor(live, "conversation");
      expect(ref.expiresAt).toBe(tightBodyCap);
      expect(qqMessageFactSourceAccess(h.db, ref, owner, principal, now)).toBe("available");
      // 冻结 ref：帽已写进 ref。此后即便 fact 行到期被推后（放宽），旧 ref 帽不延长，
      // 帽后仍是 expired（不复活）。
      const laterFactCap = "2026-11-01T00:00:00.000000Z";
      h.db
        .query("UPDATE qq_message_facts SET expires_at=? WHERE event_key=?")
        .run(laterFactCap, observation.eventKey);
      expect(
        qqMessageFactSourceAccess(h.db, ref, owner, principal, "2026-10-06T00:00:01.000000Z"),
      ).toBe("expired");
      // 同一 stored 状态下 mint 与 access 一致：正文删除后两侧同时翻 revoked，
      // 投影 parts 降级、access 复算不等。
      h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(observation.eventKey);
      expect(qqMessageFactSourceAccess(h.db, ref, owner, principal, now)).toBe("revoked");
      const afterDelete = loadQqMessageFact(h, live, "-102", now);
      expect(afterDelete).not.toBeNull();
      if (afterDelete) {
        expect(afterDelete.completeness).toBe("unavailable");
        expect(afterDelete.parts.some((p) => p.kind === "unavailable")).toBe(true);
      }
    } finally {
      h.close();
    }
  });
});

function factExpiresOf(h: ReturnType<typeof setup>, eventKey: string): string {
  const row = h.db
    .query("SELECT expires_at FROM qq_message_facts WHERE event_key=?")
    .get(eventKey) as { expires_at: string };
  return row.expires_at;
}
