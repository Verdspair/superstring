import { describe, expect, it } from "bun:test";
import { loadQqMessageFact } from "../../src/server/channels/onebot11/message-projection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import {
  qqMessageFactSourceAccess,
  qqMessageFactSourceAccessMany,
  qqMessageFactSourceRevision,
  visibleFactState,
} from "../../src/server/services/qq-message-fact-sources";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";

const at = Math.floor(Date.now() / 1000);
const atIso = (offsetSeconds: number): string =>
  new Date((at + offsetSeconds) * 1000).toISOString().replace("Z", "000Z");
const now = atIso(0);

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

// 只数事实行读取，不改动其他查询；同时保留实际执行的 SQL 与绑定供查询计划核验。
function factRowReads(h: ReturnType<typeof setup>) {
  const original = h.db.query;
  const calls: { sql: string; args: string[] }[] = [];
  let count = 0;
  h.db.query = ((sql: string) => {
    const statement = original.call(h.db, sql);
    if (
      !/^\s*SELECT\b/i.test(sql) ||
      !/\b(?:from|join)\s+qq_message_facts\b/i.test(sql) ||
      !/\bevent_key\b/i.test(sql) ||
      !/\bbody\b/i.test(sql)
    )
      return statement;
    count += 1;
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "all")
          return (...args: string[]) => {
            calls.push({ sql, args });
            return value.apply(target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof h.db.query;
  return {
    count: () => count,
    calls: () => calls,
    reset: () => {
      count = 0;
      calls.length = 0;
    },
    restore: () => {
      h.db.query = original;
    },
  };
}

describe("qq_message_fact read work: one row read per access, unchanged visible state", () => {
  it("looks up requested event keys instead of scanning same-account history for each source proof", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const live = liveScope(h, conversation);
      const refs: SourceRef[] = [];
      for (let i = 0; i < 32; i += 1) {
        const observation = alinObservation(-1000 - i);
        recordWithJournal(h, journal, "binding", observation);
        const fact = loadQqMessageFact(h, live, String(-1000 - i), now);
        if (!fact) throw new Error("fact missing");
        refs.push(factRefOf(fact));
      }
      // These peers share the event index's account/kind/agent prefix, but no requested key.
      for (let peer = 0; peer < 4; peer += 1) {
        const bindingId = `unrelated-${peer}`;
        const peerId = 40000 + peer;
        bind(h, bindingId, String(peerId));
        for (let i = 0; i < 64; i += 1)
          recordWithJournal(
            h,
            journal,
            bindingId,
            alinObservation(-2000 - peer * 64 - i, "unrelated history", peerId),
          );
      }
      const reads = factRowReads(h);
      try {
        const first = refs[0];
        if (!first) throw new Error("fact reference missing");
        for (const requested of [[first], refs]) {
          reads.reset();
          expect(
            qqMessageFactSourceAccessMany(
              h.db,
              requested,
              ownerFor(live, "conversation"),
              { userId: DEFAULT_USER_ID },
              now,
            ),
          ).toEqual(requested.map(() => "available"));
          expect(reads.count()).toBe(1);
          expect(reads.calls()).toHaveLength(1);
          const call = reads.calls()[0];
          if (!call) throw new Error("fact query missing");
          const plan = h.db.query(`EXPLAIN QUERY PLAN ${call.sql}`).all(...call.args) as {
            detail: string;
          }[];
          // A batched query count alone cannot detect a broad event-index scan.
          const eventReads = plan.filter((row) => /\b(?:SCAN|SEARCH) e\b/.test(row.detail));
          expect(eventReads).toHaveLength(1);
          expect(eventReads.every((row) => /\bSEARCH e\b.*\(event_key=\?\)/.test(row.detail))).toBe(
            true,
          );
          const factLookup = plan.findIndex((row) =>
            /\bSEARCH f\b.*\(event_key=\?\)/.test(row.detail),
          );
          const eventLookup = plan.indexOf(eventReads[0]);
          const requestedScan = plan.findIndex((row) => /VIRTUAL TABLE/.test(row.detail));
          expect(requestedScan).toBeGreaterThanOrEqual(0);
          expect(factLookup).toBeGreaterThan(requestedScan);
          expect(eventLookup).toBeGreaterThan(factLookup);
        }
      } finally {
        reads.restore();
      }
    } finally {
      h.close();
    }
  });

  it("reads the fact row exactly once per access and reuses it for the visible-state derivation", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-102", now);
      if (!fact) throw new Error("fact missing");
      const ref = factRefOf(fact);
      const owner = ownerFor(live, "conversation");
      const principal = { userId: DEFAULT_USER_ID };
      const reads = factRowReads(h);
      expect(qqMessageFactSourceAccess(h.db, ref, owner, principal, now)).toBe("available");
      // 访问只用一次 row 读取：调用方已加载的行必须传入同一份可见态推导。
      expect(reads.count()).toBe(1);
      // 不存在的 id：同样只读一次，且 fail closed。
      reads.reset();
      expect(
        qqMessageFactSourceAccess(h.db, { ...ref, id: "onebot:-404:404" }, owner, principal, now),
      ).toBe("revoked");
      expect(reads.count()).toBe(1);
      reads.restore();
    } finally {
      h.close();
    }
  });

  it("keeps the minted revision: the exported visible state is the same derivation (unicode text intact)", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-103, "\u{20bb7}在南京\ud83d\ude42");
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-103", now);
      if (!fact) throw new Error("fact missing");
      const ref = factRefOf(fact);
      const reads = factRowReads(h);
      const state = visibleFactState(h.db, live, observation.eventKey, now);
      expect(reads.count()).toBe(1);
      reads.restore();
      expect(state).not.toBeNull();
      if (!state) return;
      expect(state.textConsistency).toBeNull();
      expect(state.bodyRevisionValue).not.toBeNull();
      // 与真实投影 mint 的 ref 逐字一致：同一可见态、同一正文修订。
      expect(
        qqMessageFactSourceRevision(live, state.fact, state.visibleParts, state.bodyRevisionValue),
      ).toBe(ref.revision);
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          ownerFor(live, "conversation"),
          { userId: DEFAULT_USER_ID },
          now,
        ),
      ).toBe("available");
    } finally {
      h.close();
    }
  });

  it("body mismatch: text-mismatch state downgrades parts and the same derivation revokes the ref", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-102", now);
      if (!fact) throw new Error("fact missing");
      const ref = factRefOf(fact);
      h.db
        .query("UPDATE qq_observation_text SET body=? WHERE event_key=?")
        .run("被改写过的正文", observation.eventKey);
      const reads = factRowReads(h);
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          ownerFor(live, "conversation"),
          { userId: DEFAULT_USER_ID },
          now,
        ),
      ).toBe("revoked");
      expect(reads.count()).toBe(1);
      reads.restore();
      const state = visibleFactState(h.db, live, observation.eventKey, now);
      if (!state) throw new Error("state missing");
      expect(state.textConsistency).toBe("text-mismatch");
      expect(state.visibleParts.some((p) => p.kind === "unavailable")).toBe(true);
      expect(
        qqMessageFactSourceRevision(live, state.fact, state.visibleParts, state.bodyRevisionValue),
      ).not.toBe(ref.revision);
    } finally {
      h.close();
    }
  });

  it("expired window: fact expiry decides before derivation, and the derivation itself is deterministic", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-102", now);
      if (!fact) throw new Error("fact missing");
      const ref = factRefOf(fact);
      const owner = ownerFor(live, "conversation");
      const principal = { userId: DEFAULT_USER_ID };
      // 同一时刻两次派生：纯函数，结果逐字段一致（无隐式缓存/顺序依赖）。
      const a = visibleFactState(h.db, live, observation.eventKey, now);
      const b = visibleFactState(h.db, live, observation.eventKey, now);
      expect(a).not.toBeNull();
      expect(b).toEqual(a);
      const reads = factRowReads(h);
      // 事实窗口已过：expired 先于可见态推导，row 只读一次。
      expect(qqMessageFactSourceAccess(h.db, ref, owner, principal, atIso(1584001))).toBe(
        "expired",
      );
      expect(reads.count()).toBe(1);
      reads.restore();
    } finally {
      h.close();
    }
  });

  it("foreign owner: revoked before any fact-row read", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-102", now);
      if (!fact) throw new Error("fact missing");
      const ref = factRefOf(fact);
      const reads = factRowReads(h);
      expect(
        qqMessageFactSourceAccess(
          h.db,
          ref,
          { ...ownerFor(live, "conversation"), agentId: "other-agent" },
          { userId: DEFAULT_USER_ID },
          now,
        ),
      ).toBe("revoked");
      expect(reads.count()).toBe(0);
      reads.restore();
    } finally {
      h.close();
    }
  });

  it("malformed stored parts: the derivation still throws instead of degrading silently", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordWithJournal(h, journal, "binding", observation);
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-102", now);
      if (!fact) throw new Error("fact missing");
      const ref = factRefOf(fact);
      // parts 列 CHECK 要求 JSON 数组：用 [null]（合法数组、元素非法）触发
      // 派生内 .kind 读取失败，而非绕过约束。
      h.db
        .query("UPDATE qq_message_facts SET parts='[null]' WHERE event_key=?")
        .run(observation.eventKey);
      expect(() =>
        qqMessageFactSourceAccess(
          h.db,
          ref,
          ownerFor(live, "conversation"),
          { userId: DEFAULT_USER_ID },
          now,
        ),
      ).toThrow();
      expect(() => visibleFactState(h.db, live, observation.eventKey, now)).toThrow();
    } finally {
      h.close();
    }
  });
});
