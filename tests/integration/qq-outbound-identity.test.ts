// T03b DDL 对齐片：出站身份快照列（0052 §13.4）。真实写入/读取路径——
// recordQqOutboundMessageFact insert + projectQqOutboundMessageFacts read，
// 不 mock row。nameState 从实际有效快照列推导：群名片或个人昵称非空＝known、
// 双空且 legacy 非空＝legacy、全空＝unknown（与 display 优先级一致，不借当前
// member/Agent 名，不伪称私聊群名片）。

import { describe, expect, it } from "bun:test";
import { projectQqOutboundMessageFacts } from "../../src/server/channels/onebot11/message-projection";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { recordQqOutboundMessageFact } from "../../src/server/db/qq-message-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const now = "2026-10-01T16:00:00.000000Z";
const later = "2026-10-01T17:00:00.000000Z";
const farFuture = "2026-11-01T00:00:00.000000Z";

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

function bind(
  h: ReturnType<typeof setup>,
  id: string,
): { journal: ConversationEventRepository; conversationId: string } {
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
  if (!conversation) throw new Error("conversation expected");
  return { journal, conversationId: conversation.id };
}

function commitIntent(
  h: ReturnType<typeof setup>,
  intentId: string,
  conversationId: string,
): string {
  new AgentRunRepository(h.db).createRun({
    runId: `run-${intentId}`,
    specId: "main",
    specVersion: "1",
    owner: { kind: "conversation", id: conversationId },
    at: now,
  });
  const delivery = new OutboundIntentRepository(h.db).commit({
    id: intentId,
    runId: `run-${intentId}`,
    conversationId,
    ordinal: 0,
    target: {
      accountId: "90001",
      conversationKind: "group",
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
      bindingId: `binding-${intentId}`,
      bindingEpoch: 1,
    },
    speechKind: "direct_reply",
    sourceThroughSeq: 0,
    deliverBy: later,
    createdAt: now,
    expiresAt: later,
    parts: [{ kind: "text", text: "第一段" }],
  });
  return delivery.id;
}

function recordIdentity(
  h: ReturnType<typeof setup>,
  intentId: string,
  identity: {
    groupCard: string | null;
    personalNickname: string | null;
    legacyDisplayName: string | null;
  },
): void {
  recordQqOutboundMessageFact(h.orm, {
    intentId,
    accountId: "90001",
    agentId: DEFAULT_AGENT_ID,
    identity: { qq: "90001", ...identity, nameState: "unknown" },
    occurredAtSeconds: at,
  });
}

describe("outbound identity nameState from stored snapshot columns", () => {
  it("group card or nickname non-null reads back known", () => {
    const h = setup();
    try {
      const { conversationId } = bind(h, "binding-known");
      const intentId = commitIntent(h, "intent-known", conversationId);
      recordIdentity(h, intentId, {
        groupCard: "群猫娘",
        personalNickname: null,
        legacyDisplayName: null,
      });
      const projected = projectQqOutboundMessageFacts(h.orm, intentId, now);
      expect(projected.identity).toMatchObject({
        qq: "90001",
        groupCard: "群猫娘",
        nameState: "known",
      });
    } finally {
      h.close();
    }
  });

  it("both dual names null with legacy display reads back legacy", () => {
    const h = setup();
    try {
      const { conversationId } = bind(h, "binding-legacy");
      const intentId = commitIntent(h, "intent-legacy", conversationId);
      recordIdentity(h, intentId, {
        groupCard: null,
        personalNickname: null,
        legacyDisplayName: "旧名",
      });
      const projected = projectQqOutboundMessageFacts(h.orm, intentId, now);
      expect(projected.identity).toMatchObject({
        groupCard: null,
        legacyDisplayName: "旧名",
        nameState: "legacy",
      });
    } finally {
      h.close();
    }
  });

  it("all names null reads back unknown and expired snapshot has no identity", () => {
    const h = setup();
    try {
      const { conversationId } = bind(h, "binding-null");
      const intentId = commitIntent(h, "intent-null", conversationId);
      recordIdentity(h, intentId, {
        groupCard: null,
        personalNickname: null,
        legacyDisplayName: null,
      });
      const projected = projectQqOutboundMessageFacts(h.orm, intentId, now);
      expect(projected.identity).toMatchObject({
        qq: "90001",
        groupCard: null,
        personalNickname: null,
        legacyDisplayName: null,
        nameState: "unknown",
      });
      expect(projected.expired).toBe(false);
      expect(projected.parts).toEqual([]);
      // 过期：身份/部件都不可读（§4.5/§13.4），明确 expired，不复活。
      const expiredAt = projectQqOutboundMessageFacts(h.orm, intentId, farFuture);
      expect(expiredAt).toEqual({ identity: null, parts: [], expired: true });
    } finally {
      h.close();
    }
  });
});
