// T04/T05 状态保真：受控引用目标状态读取（规格 §4.3「不可读状态分别表达」；P2 S14_2 缺口）。
//
// 覆盖新锁定接口 `loadQqMessageFactState(h, scope, platformMessageId, now)`：真实
// scope/授权路径与 `loadQqMessageFact` 完全同源，但把「不可读」拆成可分别表达的 tagged
// 状态——available / expired / revoked / legacy_unknown / missing——绝不回快照正文或过期
// 身份，跨 scope 永远 missing（连存在性都不证明）。`loadQqMessageFact` 的普通 facts
// 可读契约不放宽（失效仍 null，成对断言）。
//
// 同时钉住 `expandQqReplies` 的 `loadState` 消费端契约：同 scope 过期目标经状态接口表达为
// `expired`（旧 load-only 推断只能给 missing）；跨 scope、cycle、深度规则不变；register
// callback 携带当前 QqMessageFact（第二参数），Evidence 契约不加字段。

import { describe, expect, it } from "bun:test";
import {
  loadQqMessageFact,
  loadQqMessageFactState,
} from "../../src/server/channels/onebot11/message-projection";
import { expandQqReplies } from "../../src/server/channels/onebot11/reply-context";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { EvidenceStore } from "../../src/server/modules/conversation-evidence-store";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import type { Evidence } from "../../src/shared/contracts/evidence";
import type { QqConversationScope, QqMessageFact } from "../../src/shared/contracts/qq-message";

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

function observation(
  messageId: number,
  text = "你不是就在南京吗？",
  replyTo?: number,
  groupId = 30003,
) {
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
        ...(replyTo ? [{ type: "reply", data: { id: replyTo } }] : []),
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

/** 入站写 + journal 派生（真实接线顺序：adapter.afterRecord 的 ingest），与既有投影夹具一致。 */
function record(h: ReturnType<typeof setup>, obs: ReturnType<typeof observation>) {
  recordObservation(h.orm, obs, DEFAULT_AGENT_ID);
  const journal = new ConversationEventRepository(h.db);
  const binding = h.db
    .query(
      "SELECT id FROM qq_bindings WHERE account_id=? AND conversation_kind=? AND peer_id=? ORDER BY id LIMIT 1",
    )
    .get(obs.accountId, obs.conversation.kind, obs.conversation.peerId) as { id: string } | null;
  if (!binding) throw new Error("binding fixture missing");
  journal.ingestOneBotEvent(obs.eventKey, binding.id);
}

/** 真实宿主形状的 expand 输入：window 事实取自真实投影，loadState 走状态接口。 */
function expandInput(
  store: EvidenceStore,
  scope: QqConversationScope,
  window: QqMessageFact[],
  loadState: (id: string) => ReturnType<typeof loadQqMessageFactState>,
) {
  const registered: Evidence[] = [];
  const projection = expandQqReplies({
    scope,
    window,
    focus: { triggerMessageIds: [], responseMessageIds: [], responseQqs: [], assistantQq: "90001" },
    settings: {
      reply_mode: "configured_depth",
      reply_depth: 8,
      time_display: "hybrid",
      timezone: "Asia/Shanghai",
    },
    now,
    remainingTextUnits: 1000,
    load: (id) => loadQqMessageFact(store, scope, id, now) ?? null,
    loadState,
    register: (evidence) => {
      registered.push(evidence);
      return "registered-test-ref";
    },
    fits: () => true,
  });
  return { roots: projection.roots, sources: projection.sources, registered };
}

describe("controlled target state read (loadQqMessageFactState)", () => {
  it("reads a live same-scope target as available with current sources and full body", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      record(h, observation(-101, "今天南京多少度？"));
      const scope = liveScope(h, conversation);
      const read = loadQqMessageFactState(h, scope, "-101", now);
      expect(read.state).toBe("available");
      expect(read.fact).not.toBeNull();
      expect(read.fact!.platformMessageId).toBe("-101");
      expect(read.fact!.completeness).toBe("full");
      expect(read.fact!.parts.some((p) => p.kind === "text" && p.text === "今天南京多少度？")).toBe(
        true,
      );
      // 来源当前且配对：fact 快照来源 + 独立窗口的正文来源。
      expect(read.fact!.sources.map((s) => s.kind)).toEqual(["qq_message_fact", "qq_observation"]);
      // 普通可读契约不放宽：live 目标 load 仍非空（成对）。
      expect(loadQqMessageFact(h, scope, "-101", now)).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it("reports an unrecorded platform id as missing without identity or body", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      record(h, observation(-101, "存在的一条"));
      const scope = liveScope(h, conversation);
      const read = loadQqMessageFactState(h, scope, "-999", now);
      expect(read).toEqual({ state: "missing", fact: null });
      expect(loadQqMessageFact(h, scope, "-999", now)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps a same platform id in another scope always missing, never proving existence", () => {
    const h = setup();
    try {
      const a = bind(h, "bindingA", "30003");
      record(h, observation(-101, "甲群的秘密正文", undefined, 30003));
      const scopeA = liveScope(h, a.conversation, "bindingA");
      // 乙群是真实存在的第二个 scope（同库）。
      const b = bind(h, "bindingB", "30004");
      record(h, observation(-201, "乙群自己的消息", undefined, 30004));
      const scopeB = liveScope(h, b.conversation, "bindingB");
      // 乙群读甲群的平台 ID：missing，fact=null（无身份/正文/存在性证据）。
      expect(loadQqMessageFactState(h, scopeB, "-101", now)).toEqual({
        state: "missing",
        fact: null,
      });
      // 甲群自己读：available（合法与拒绝完全成对）。
      expect(loadQqMessageFactState(h, scopeA, "-101", now).state).toBe("available");
    } finally {
      h.close();
    }
  });

  it("reports an expired fact snapshot in the same scope as expired with no body or identity", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      record(h, observation(-101, "即将过期的正文"));
      const scope = liveScope(h, conversation);
      // 事实快照整体到期（同 scope 可证明曾存在 → expired；不是跨 scope 的 missing）。
      h.db.query("UPDATE qq_message_facts SET expires_at='2026-10-01T15:00:00.000000Z'").run();
      const read = loadQqMessageFactState(h, scope, "-101", now);
      expect(read).toEqual({ state: "expired", fact: null });
      // 普通可读契约不放宽：失效仍 null（成对断言）。
      expect(loadQqMessageFact(h, scope, "-101", now)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps a closed-and-reopened binding epoch from learning an old fact's existence", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      record(h, observation(-101, "旧会话的过期消息"));
      const scopeA = liveScope(h, conversation, "binding");
      // 同 conversation 合法 owner：timeline 在场 → expired（安全存在性表达）。
      h.db
        .query(
          "UPDATE qq_message_facts SET expires_at='2026-10-01T15:00:00.000000Z' WHERE event_key IN (SELECT event_key FROM qq_events WHERE message_id='-101')",
        )
        .run();
      expect(loadQqMessageFactState(h, scopeA, "-101", now)).toEqual({
        state: "expired",
        fact: null,
      });
      // 关闭 → 重开：binding epoch 推进、新 conversation 无该事件的 journal 来源。
      h.db.query("UPDATE conversations SET closed_at=? WHERE id=?").run(now, conversation.id);
      const reopened = journal.ensureOneBot("binding")!;
      expect(reopened.id).not.toBe(conversation.id);
      expect(reopened.bindingEpoch).toBe(conversation.bindingEpoch + 1);
      const carried = h.db
        .query(
          "SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id=? AND source_kind='qq_event'",
        )
        .get(reopened.id) as { n: number };
      expect(carried.n).toBe(0); // 不人工造空行；journal 真实无来源
      const scopeB = liveScope(h, reopened, "binding");
      // 同 scope 四维匹配（lookup 无 conversationId），但新 epoch 无 journal 来源 → missing，
      // 不得凭快照到期向新会话泄露旧事实存在；fact=null 两边都不出正文/姓名。
      expect(loadQqMessageFactState(h, scopeB, "-101", now)).toEqual({
        state: "missing",
        fact: null,
      });
      expect(loadQqMessageFact(h, scopeB, "-101", now)).toBeNull();
      expect(JSON.stringify(loadQqMessageFactState(h, scopeB, "-101", now))).not.toContain(
        "旧会话",
      );
    } finally {
      h.close();
    }
  });

  it("reports a deleted body as revoked without snapshot text, even with current names", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      record(h, observation(-101, "被手动清理的正文"));
      const scope = liveScope(h, conversation);
      // 当前昵称目录存在（不能借 currentName 补失效正文/身份外泄）。
      h.db
        .query(
          "UPDATE qq_members SET nickname='当前新名', group_card='新群名片', personal_nickname='当前昵称', name_state='known' WHERE account_id='90001' AND conversation_kind='group' AND peer_id='30003' AND user_id='10001'",
        )
        .run();
      // 正文被物理删除：事实快照仍在，但正文不可复活。
      h.db.exec("DELETE FROM qq_observation_text WHERE event_key IS NOT NULL");
      const read = loadQqMessageFactState(h, scope, "-101", now);
      expect(read.state).toBe("revoked");
      expect(read.fact).toBeNull();
      expect(loadQqMessageFact(h, scope, "-101", now)?.completeness).toBe("unavailable");
    } finally {
      h.close();
    }
  });

  it("reports a body expired before the fact snapshot as revoked (independent body window)", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      record(h, observation(-101, "正文先行到期"));
      const scope = liveScope(h, conversation);
      // 正文窗口早于事实快照窗口到期：正文独立期限，先到先失效。
      h.db.query("UPDATE qq_observation_text SET expires_at='2026-10-01T15:00:00.000000Z'").run();
      const read = loadQqMessageFactState(h, scope, "-101", now);
      expect(read.state).toBe("revoked");
      expect(read.fact).toBeNull();
      // 快照 fact 仍在 load 下可读（身份/关系有效），但正文为空且不可复活。
      const fact = loadQqMessageFact(h, scope, "-101", now);
      expect(fact).not.toBeNull();
      expect(fact!.parts.some((p) => p.kind === "text" && p.text.length > 0)).toBe(false);
    } finally {
      h.close();
    }
  });

  it("reports a rewritten body (revision drift) as revoked", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      record(h, observation(-101, "原始正文"));
      const scope = liveScope(h, conversation);
      h.db.query("UPDATE qq_observation_text SET body='被改写的正文'").run();
      const read = loadQqMessageFactState(h, scope, "-101", now);
      expect(read.state).toBe("revoked");
      expect(read.fact).toBeNull();
      // 旧快照正文不出现在任何返回里（revoked 无 fact）。
      expect(JSON.stringify(read)).not.toContain("原始正文");
    } finally {
      h.close();
    }
  });

  it("reports a legacy single-name fact as legacy_unknown without body", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      record(h, observation(-101, "旧数据正文"));
      const scope = liveScope(h, conversation);
      h.db
        .query(
          "UPDATE qq_message_facts SET name_state='legacy', personal_nickname=NULL, personal_nickname_source=NULL, legacy_display_name='旧显示名' WHERE reply_to_message_id IS NULL",
        )
        .run();
      const read = loadQqMessageFactState(h, scope, "-101", now);
      expect(read.state).toBe("legacy_unknown");
      expect(read.fact).toBeNull();
    } finally {
      h.close();
    }
  });
});

describe("expandQqReplies consumes the state read (host pairing)", () => {
  it("surfaces a same-scope expired target as expired via loadState while load-only yields missing", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      record(h, observation(-101, "过期的引用原文"));
      record(h, observation(-102, "窗口触发", -101));
      const scope = liveScope(h, conversation);
      // 只过期目标 -101 的事实快照（窗口事实 -102 保持有效）。
      h.db
        .query(
          "UPDATE qq_message_facts SET expires_at='2026-10-01T15:00:00.000000Z' WHERE event_key IN (SELECT event_key FROM qq_events WHERE message_id='-101')",
        )
        .run();
      const windowFact = loadQqMessageFact(h, scope, "-102", now);
      expect(windowFact).not.toBeNull();
      // 状态接口：同 scope 过期 → expired（安全关系状态，无正文/身份）。
      const withState = expandInput(h, scope, [windowFact!], (id) =>
        loadQqMessageFactState(h, scope, id, now),
      );
      expect(withState.roots[0]).toMatchObject({
        targetMessageId: "-101",
        state: "expired",
        depth: 1,
        message: null,
        textPage: null,
        bodyRef: null,
      });
      expect(withState.sources).toHaveLength(0);
      // 旧 load-only 推断（缺口原状）：只能 missing —— 状态接口正是闭合这个缺口。
      const withoutState = expandQqReplies({
        scope,
        window: [windowFact!],
        focus: {
          triggerMessageIds: [],
          responseMessageIds: [],
          responseQqs: [],
          assistantQq: "90001",
        },
        settings: {
          reply_mode: "configured_depth",
          reply_depth: 8,
          time_display: "hybrid",
          timezone: "Asia/Shanghai",
        },
        now,
        remainingTextUnits: 1000,
        load: (id) => loadQqMessageFact(h, scope, id, now) ?? null,
        register: () => "registered-test-ref",
        fits: () => true,
      });
      expect(withoutState.roots[0]?.state).toBe("missing");
    } finally {
      h.close();
    }
  });

  it("keeps a cross-scope target missing through loadState without identity or loaded text", () => {
    const h = setup();
    try {
      bind(h, "bindingA", "30003");
      record(h, observation(-101, "甲群原文", undefined, 30003));
      const b = bind(h, "bindingB", "30004");
      record(h, observation(-202, "乙群窗口触发", -101, 30004));
      record(h, observation(-201, "乙群自己的消息", undefined, 30004));
      const scopeB = liveScope(h, b.conversation, "bindingB");
      const windowFact = loadQqMessageFact(h, scopeB, "-202", now);
      expect(windowFact).not.toBeNull();
      const result = expandInput(h, scopeB, [windowFact!], (id) =>
        loadQqMessageFactState(h, scopeB, id, now),
      );
      expect(result.roots[0]).toMatchObject({
        targetMessageId: "-101",
        state: "missing",
        message: null,
        textPage: null,
        bodyRef: null,
      });
      expect(result.sources).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain("甲群原文");
    } finally {
      h.close();
    }
  });

  it("pairs a live source with an expired one: only the live root consumes sources", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      record(h, observation(-101, "活着的原文"));
      record(h, observation(-102, "窗口触发甲", -101));
      record(h, observation(-201, "已过期的原文"));
      record(h, observation(-202, "窗口触发乙", -201));
      const scope = liveScope(h, conversation);
      h.db
        .query(
          "UPDATE qq_message_facts SET expires_at='2026-10-01T15:00:00.000000Z' WHERE event_key IN (SELECT event_key FROM qq_events WHERE message_id='-201')",
        )
        .run();
      const windowA = loadQqMessageFact(h, scope, "-102", now);
      const windowB = loadQqMessageFact(h, scope, "-202", now);
      expect(windowA).not.toBeNull();
      expect(windowB).not.toBeNull();
      const result = expandInput(h, scope, [windowA!, windowB!], (id) =>
        loadQqMessageFactState(h, scope, id, now),
      );
      // 可读根 target=目标内部 eventKey（正文页完整）；过期根无 fact → target 保持平台 ID。
      const liveRoot = result.roots.find((r) => r.state === "available");
      expect(liveRoot).toBeDefined();
      expect(liveRoot!.textPage).toMatchObject({ complete: true });
      expect(liveRoot!.message?.platformMessageId).toBe("-101");
      const expiredRoot = result.roots.find((r) => r.targetMessageId === "-201");
      expect(expiredRoot).toBeDefined();
      expect(expiredRoot!.state).toBe("expired");
      expect(expiredRoot!.message).toBeNull();
      // 来源只来自 available 根；expired 根不并入。
      expect(result.sources.every((s) => s.id !== windowB!.id)).toBe(true);
      expect(result.sources.length).toBeGreaterThan(0);
    } finally {
      h.close();
    }
  });

  it("hands the current QqMessageFact to the register callback as the second argument", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      record(h, observation(-101, "需要受限读取的一段非常长的合成正文"));
      record(h, observation(-102, "窗口触发", -101));
      const scope = liveScope(h, conversation);
      const windowFact = loadQqMessageFact(h, scope, "-102", now);
      expect(windowFact).not.toBeNull();
      const seenFacts: Array<QqMessageFact | undefined> = [];
      const projection = expandQqReplies({
        scope,
        window: [windowFact!],
        focus: {
          triggerMessageIds: [],
          responseMessageIds: [],
          responseQqs: [],
          assistantQq: "90001",
        },
        settings: {
          reply_mode: "configured_depth",
          reply_depth: 8,
          time_display: "hybrid",
          timezone: "Asia/Shanghai",
        },
        now,
        remainingTextUnits: 2, // 正文必然超预算 → 直接层前缀页 + 登记。
        load: () => null,
        loadState: (id) => loadQqMessageFactState(h, scope, id, now),
        register: (evidence, fact) => {
          seenFacts.push(fact);
          return `ref:${evidence.id}`;
        },
        fits: () => true,
      });
      expect(projection.roots[0]?.textPage?.complete).toBe(false);
      expect(seenFacts).toHaveLength(1);
      expect(seenFacts[0]!.platformMessageId).toBe("-101");
      expect(seenFacts[0]!.completeness).toBe("full");
      expect(projection.roots[0]?.bodyRef).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps cycle and depth rules unchanged when loadState is provided", () => {
    const facts = new Map<string, QqMessageFact>();
    const factOf = (
      id: string,
      platformMessageId: string,
      text: string,
      replyTo?: string,
      seq = 1,
    ): QqMessageFact => ({
      id,
      platformMessageId,
      seq,
      occurredAtSeconds: 1790920780,
      speaker: {
        role: "member",
        qq: "10001",
        groupCard: "阿林",
        personalNickname: "周同学",
        legacyDisplayName: null,
        nameState: "known",
      },
      parts: [{ kind: "text", text }],
      mentions: [],
      replyTo: replyTo ? { platformMessageId: replyTo } : null,
      sources: [],
      completeness: "full",
    });
    facts.set("-301", factOf("f301", "-301", "第一环", "-302"));
    facts.set("-302", factOf("f302", "-302", "第二环", "-301"));
    facts.set("-401", factOf("f401", "-401", "第二层正文", "-402"));
    facts.set("-402", factOf("f402", "-402", "第三层正文", "-403"));
    facts.set("-403", factOf("f403", "-403", "第四层正文"));
    facts.set("-0", factOf("m1", "-0", "窗口触发环", "-301", 1));
    facts.set("-5", factOf("m2", "-5", "窗口触发链", "-401", 2));
    const scope: QqConversationScope = {
      conversationId: "synthetic-conversation",
      accountId: "90001",
      conversationKind: "group",
      peerId: "30003",
      agentId: "00000000-0000-0000-0000-000000000001",
      bindingId: "synthetic-binding",
      bindingEpoch: 1,
      authorityRevision: 1,
    };
    const stateOf = (id: string) =>
      facts.has(id)
        ? { state: "available" as const, fact: facts.get(id)! }
        : { state: "missing" as const, fact: null };
    const projection = expandQqReplies({
      scope,
      window: [facts.get("-0")!, facts.get("-5")!],
      focus: {
        triggerMessageIds: [],
        responseMessageIds: [],
        responseQqs: [],
        assistantQq: "90001",
      },
      settings: {
        reply_mode: "configured_depth",
        reply_depth: 8,
        time_display: "hybrid",
        timezone: "Asia/Shanghai",
      },
      now,
      remainingTextUnits: 1000,
      load: (id) => facts.get(id) ?? null,
      loadState: stateOf,
      register: () => "registered-test-ref",
      fits: () => true,
    });
    const byTarget = new Map(projection.roots.map((r) => [r.targetMessageId, r]));
    // 深度阶梯与旧纯规则一致：链逐层 available，深度递增（可读根 target=内部 fact id）。
    expect(byTarget.get("f401")?.state).toBe("available");
    expect(byTarget.get("f401")?.depth).toBe(1);
    expect(byTarget.get("f402")?.state).toBe("available");
    expect(byTarget.get("f402")?.depth).toBe(2);
    expect(byTarget.get("f403")?.state).toBe("available");
    expect(byTarget.get("f403")?.depth).toBe(3);
    // 环：第三层检出 cycle，前两层仍 available，关系全列。
    expect(byTarget.get("f301")?.state).toBe("available");
    expect(byTarget.get("f302")?.state).toBe("available");
    const cycleRoot = projection.roots.find((r) => r.state === "cycle");
    expect(cycleRoot).toBeDefined();
    expect(cycleRoot!.depth).toBe(3);
    expect(cycleRoot!.message).toBeNull();
  });
});
