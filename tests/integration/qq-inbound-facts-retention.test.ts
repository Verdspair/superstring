// 入站事实到期清理的在用保护。
//
// `purgeExpiredQqMessageFacts` 只删"已到期且不再被持有"的入站事实快照：非终态 run 的
// exact 上下文快照精确引用该事实（kind='qq_message_fact'，id=event_key）、或 agent task
// 的来源引用该事实且任务尚未安全（非终态，或仍有 running/waiting_approval/unknown 调用
// ——与 `TASK_PROTECTION_SQL` 同一口径）时一律保留。终态 run 不保：redact 已把过期/撤销
// 快照正文置 NULL，exact-only 保护与真实来源持有相称。到期即不可读不变：保护只延迟物理
// 删除，不复活读取——行在时统一 sourceAccess=expired（可区分、不猜），物理删后才是 revoked；
// 永久 qq_events 身份永不在此删除。

import { describe, expect, it } from "bun:test";
import { textMessage } from "../../src/server/agent/context-engine";
import { loadQqMessageFact } from "../../src/server/channels/onebot11/message-projection";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { purgeExpiredQqMessageFacts } from "../../src/server/db/qq-message-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { qqMessageFactSourceAccess } from "../../src/server/services/qq-message-fact-sources";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";

const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const now = "2026-10-01T16:00:00.000000Z";
const later = "2026-10-01T17:00:00.000000Z";
const expired = "2026-10-20T00:00:00.000000Z";

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

function bind(h: ReturnType<typeof setup>, id: string) {
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(now, now);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,?,?,?,'scheme',?,?)",
    )
    .run(id, "90001", "group", "30003", DEFAULT_AGENT_ID, now, now);
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(id);
  if (!conversation) throw new Error("binding conversation missing");
  return { journal, conversation };
}

/** 真实 wire 路径：normalize 一条群消息（card 全空格、reply+at+text 有序片段）。 */
function alinObservation(messageId: number, text = "你不是就在南京吗？") {
  const result = normalizeOneBotMessage(
    {
      time: at,
      self_id: 90001,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: messageId,
      user_id: 10001,
      group_id: 30003,
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

/** bind 后回填真实 conversation/binding 字段，构造当前有效 scope（不用占位假 ID）。 */
function liveScope(
  h: ReturnType<typeof setup>,
  conversation: { id: string; bindingEpoch: number },
  bindingId: string,
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

/**
 * 真实记录 + 真实 mint：recordObservation 同事务落身份/正文/事实，ingest 进 timeline，
 * 再经锁定投影入口 mint 出 qq_message_fact 来源引用（mint 与复验同一 revision 形状）。
 * 绑定已存在时复用（同绑定两条消息共享 conversations）。
 */
function recordAndMint(
  h: ReturnType<typeof setup>,
  bindingId: string,
  messageId: number,
  text?: string,
): { eventKey: string; factRef: SourceRef; scope: QqConversationScope } {
  const journal = new ConversationEventRepository(h.db);
  const exists = h.db.query("SELECT 1 FROM qq_bindings WHERE id=?").get(bindingId);
  const bound = exists
    ? { journal, conversation: journal.ensureOneBot(bindingId) }
    : bind(h, bindingId);
  const conv = bound.conversation;
  if (!conv) throw new Error("binding conversation missing");
  const observation = alinObservation(messageId, text);
  const recorded = recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
  expect(recorded.recorded).toBe(true);
  journal.ingestOneBotEvent(observation.eventKey, bindingId);
  const scope = liveScope(h, conv, bindingId);
  const minted = loadQqMessageFact(h, scope, String(messageId), now);
  if (!minted) throw new Error("live fact projection missing");
  const factRef = minted.sources.find((source) => source.kind === "qq_message_fact");
  if (!factRef) throw new Error("qq_message_fact source ref not minted");
  return { eventKey: observation.eventKey, factRef, scope };
}

function ownerOf(scope: QqConversationScope) {
  return {
    kind: "conversation" as const,
    id: scope.conversationId,
    userId: DEFAULT_USER_ID,
    agentId: scope.agentId,
  };
}

function factRow(h: ReturnType<typeof setup>, eventKey: string): Record<string, unknown> | null {
  return h.db.query("SELECT * FROM qq_message_facts WHERE event_key=?").get(eventKey) as Record<
    string,
    unknown
  > | null;
}

function factCount(h: ReturnType<typeof setup>): number {
  return (h.db.query("SELECT COUNT(*) AS n FROM qq_message_facts").get() as { n: number }).n;
}

describe("inbound fact retention protection", () => {
  it("keeps an expired fact while a nonterminal run's exact snapshot holds it, and the read side stays expired", () => {
    const h = setup();
    try {
      const { eventKey, factRef, scope } = recordAndMint(h, "binding-keep", -102);
      const runs = new AgentRunRepository(h.db);
      runs.createRun({
        runId: "run-keep",
        specId: "main",
        specVersion: "1",
        owner: ownerOf(scope),
        at: now,
      });
      runs.startStep({
        runId: "run-keep",
        stepId: "step-keep",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: now,
        messages: [textMessage("user", "整理这条消息")],
        sources: [factRef],
      });
      const before = { ...factRow(h, eventKey) };

      expect(purgeExpiredQqMessageFacts(h.orm, expired)).toBe(0);

      const after = factRow(h, eventKey);
      expect(after).not.toBeNull();
      if (!after) throw new Error("protected fact row missing");
      for (const key of Object.keys(before)) expect(after[key]).toBe(before[key]);
      // 到期即不可读且统一为 expired：保护中的物理行不复活读取（不是 available），
      // 也不因行还在就伪装成 revoked——过期（可区分）与物理删（revoked）保持区分。
      const access = qqMessageFactSourceAccess(
        h.db,
        factRef,
        ownerOf(scope),
        { userId: DEFAULT_USER_ID },
        expired,
      );
      expect(access).toBe("expired");
    } finally {
      h.close();
    }
  });

  it("releases the fact once the run reaches a terminal state, deletes exactly once, and keeps the permanent identity", () => {
    const h = setup();
    try {
      const { eventKey, factRef, scope } = recordAndMint(h, "binding-gone", -102);
      const runs = new AgentRunRepository(h.db);
      runs.createRun({
        runId: "run-gone",
        specId: "main",
        specVersion: "1",
        owner: ownerOf(scope),
        at: now,
      });
      runs.startStep({
        runId: "run-gone",
        stepId: "step-gone",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: now,
        messages: [textMessage("user", "整理这条消息")],
        sources: [factRef],
      });

      expect(purgeExpiredQqMessageFacts(h.orm, expired)).toBe(0);
      expect(factRow(h, eventKey)).not.toBeNull();

      // run 转终态后引用不再在用：真实删除，R16 计数准确，二次 purge 合法 0。
      runs.setStatus("run-gone", "completed", now);
      const eventsBefore = (
        h.db.query("SELECT COUNT(*) AS n FROM qq_events").get() as { n: number }
      ).n;
      expect(purgeExpiredQqMessageFacts(h.orm, expired)).toBe(1);
      expect(factRow(h, eventKey)).toBeNull();
      expect(factCount(h)).toBe(0);
      expect(purgeExpiredQqMessageFacts(h.orm, expired)).toBe(0);
      // 永久事件身份不随事实清理。
      expect((h.db.query("SELECT COUNT(*) AS n FROM qq_events").get() as { n: number }).n).toBe(
        eventsBefore,
      );
      // 物理删后同一引用才变成 revoked（过期→revoked 的分界就是物理行）。
      expect(
        qqMessageFactSourceAccess(h.db, factRef, ownerOf(scope), { userId: DEFAULT_USER_ID }, now),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("releases the fact once the holding snapshot is redacted while the run is still open", () => {
    const h = setup();
    try {
      const { eventKey, factRef, scope } = recordAndMint(h, "binding-redacted", -102);
      const runs = new AgentRunRepository(h.db);
      runs.createRun({
        runId: "run-redacted",
        specId: "main",
        specVersion: "1",
        owner: ownerOf(scope),
        at: now,
      });
      runs.startStep({
        runId: "run-redacted",
        stepId: "step-redacted",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: now,
        messages: [textMessage("user", "整理这条消息")],
        sources: [factRef],
      });
      // 快照被 redact（正文置 NULL、状态离 exact）：它不再持真实来源，保护随之释放。
      runs.redactContext({ runId: "run-redacted", stepId: "step-redacted" }, "expired");

      expect(purgeExpiredQqMessageFacts(h.orm, expired)).toBe(1);
      expect(factRow(h, eventKey)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the fact while a nonterminal agent task's sources reference it, then releases it", () => {
    const h = setup();
    try {
      const { eventKey, factRef, scope } = recordAndMint(h, "binding-task", -102);
      const tasks = new AgentTaskRepository(h.db);
      const task = tasks.enqueue({
        conversationId: scope.conversationId,
        agentId: scope.agentId,
        dedupeKey: "task-fact-keep",
        sources: [factRef],
        at: now,
        expiresAt: later,
        calls: [],
      });

      expect(purgeExpiredQqMessageFacts(h.orm, expired)).toBe(0);
      expect(factRow(h, eventKey)).not.toBeNull();

      tasks.settle(task.id, "completed", now);
      expect(purgeExpiredQqMessageFacts(h.orm, expired)).toBe(1);
      expect(factRow(h, eventKey)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the fact while a terminal task still holds an unknown call (TASK_PROTECTION same scope)", () => {
    const h = setup();
    try {
      const { eventKey, factRef, scope } = recordAndMint(h, "binding-task-unknown", -102);
      const tasks = new AgentTaskRepository(h.db);
      // 真实 interrupt 通路：running write 调用被置 unknown，任务落 unknown；再次真实
      // interrupt 后任务落终态 failed，而该 write 调用按「unknown 调用恒保」永久保持
      // unknown——终态任务仍持 unknown 调用时，其来源引用的事实不得被物理清。
      const task = tasks.enqueue({
        conversationId: scope.conversationId,
        agentId: scope.agentId,
        dedupeKey: "task-fact-unknown",
        sources: [factRef],
        at: now,
        expiresAt: later,
        calls: [{ name: "fixture.write", revision: "1", effect: "write", arguments: {} }],
      });
      const claimed = tasks.claim(now, 60000);
      if (!claimed || claimed.id !== task.id || !claimed.leaseToken)
        throw new Error("task not claimed");
      tasks.beginCall(task.id, claimed.leaseToken, 0, now);
      tasks.interrupt(task.id, now, "failed", "TASK_OUTCOME_UNKNOWN");
      expect(tasks.get(task.id)?.status).toBe("unknown");
      expect(tasks.get(task.id)?.calls[0]?.status).toBe("unknown");
      tasks.interrupt(task.id, now, "failed", "TASK_EXPIRED");
      const settled = tasks.get(task.id);
      expect(settled?.status).toBe("failed");
      expect(settled?.calls[0]?.status).toBe("unknown");

      expect(purgeExpiredQqMessageFacts(h.orm, expired)).toBe(0);
      expect(factRow(h, eventKey)).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it("deletes the fact for a terminal task with no held call", () => {
    const h = setup();
    try {
      const { eventKey, factRef, scope } = recordAndMint(h, "binding-task-terminal", -102);
      const tasks = new AgentTaskRepository(h.db);
      // 终态且无 unknown 调用的任务不再保全：引用所指向的事实行照常清理。
      const task = tasks.enqueue({
        conversationId: scope.conversationId,
        agentId: scope.agentId,
        dedupeKey: "task-fact-terminal",
        sources: [factRef],
        at: now,
        expiresAt: later,
        calls: [],
      });
      tasks.settle(task.id, "cancelled", now);

      expect(purgeExpiredQqMessageFacts(h.orm, expired)).toBe(1);
      expect(factRow(h, eventKey)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("does not let a held fact block an unrelated fact's deletion", () => {
    const h = setup();
    try {
      const held = recordAndMint(h, "binding-mixed", -102);
      const unrelated = recordAndMint(h, "binding-mixed", -104, "另一条消息");
      const runs = new AgentRunRepository(h.db);
      runs.createRun({
        runId: "run-mixed",
        specId: "main",
        specVersion: "1",
        owner: ownerOf(held.scope),
        at: now,
      });
      runs.startStep({
        runId: "run-mixed",
        stepId: "step-mixed",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: now,
        messages: [textMessage("user", "整理这条消息")],
        sources: [held.factRef],
      });

      expect(purgeExpiredQqMessageFacts(h.orm, expired)).toBe(1);

      expect(factRow(h, held.eventKey)).not.toBeNull();
      expect(factRow(h, unrelated.eventKey)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("leaves live facts untouched and refuses to mint a projection for an expired fact", () => {
    const h = setup();
    try {
      const { eventKey, scope } = recordAndMint(h, "binding-live", -102);

      expect(purgeExpiredQqMessageFacts(h.orm, now)).toBe(0);
      expect(factRow(h, eventKey)).not.toBeNull();

      // 到期时刻投影拒绝 mint（expired fact 不产来源引用），物理行不受 purge 影响。
      expect(loadQqMessageFact(h, scope, "-102", expired)).toBeNull();
      expect(factRow(h, eventKey)).not.toBeNull();
    } finally {
      h.close();
    }
  });
});
