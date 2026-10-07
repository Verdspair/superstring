// 出站事实到期清理的在用保护。
//
// `purgeExpiredQqOutboundMessageFacts` 只删"已到期且不再被持有"的出站身份事实：
// intent 仍 planned/delivering/unknown、部件仍在 sending/unknown（fail-closed 保护真实
// part 账本，与已批 `sendProtected` 同一语义面）、非终态 run 的上下文快照精确引用该
// intent（outbound_intent kind 或精确到已确认部件的 qq_outbound_message_fact kind，二者
// 皆算持有）、或 agent task 的来源引用该 intent（同两 kind 面）且任务尚未安全（非终态，
// 或仍有 running/waiting_approval/unknown 调用——与 `TASK_PROTECTION_SQL` 同一口径）时
// 一律保留。到期即不可读不变：保护只延迟物理删除，不复活读取（投影对已到期行仍返回 null）。

import { describe, expect, it } from "bun:test";
import { textMessage } from "../../src/server/agent/context-engine";
import {
  loadQqOutboundMessageFact,
  projectQqOutboundMessageFacts,
} from "../../src/server/channels/onebot11/message-projection";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import {
  purgeExpiredQqOutboundMessageFacts,
  recordQqOutboundMessageFact,
} from "../../src/server/db/qq-message-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
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

function bind(h: ReturnType<typeof setup>, id: string, peerId = "30003") {
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(now, now);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,?,?,?,'scheme',?,?)",
    )
    .run(id, "90001", "group", peerId, DEFAULT_AGENT_ID, now, now);
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(id);
  if (!conversation) throw new Error("binding conversation missing");
  return { journal, conversation };
}

function commitIntent(
  h: ReturnType<typeof setup>,
  outbox: OutboundIntentRepository,
  conversation: { id: string },
  intentId: string,
) {
  new AgentRunRepository(h.db).createRun({
    runId: `run-${intentId}`,
    specId: "main",
    specVersion: "1",
    owner: { kind: "conversation", id: conversation.id },
    at: now,
  });
  return outbox.commit({
    id: intentId,
    runId: `run-${intentId}`,
    conversationId: conversation.id,
    ordinal: 0,
    target: {
      accountId: "90001",
      conversationKind: "group",
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
      bindingId: `binding-${conversation.id}`,
      bindingEpoch: 1,
    },
    speechKind: "direct_reply",
    sourceThroughSeq: 0,
    deliverBy: later,
    createdAt: now,
    expiresAt: later,
    parts: [
      { kind: "text", text: "第一段" },
      { kind: "text", text: "第二段" },
    ],
  });
}

function recordFact(h: ReturnType<typeof setup>, intentId: string): void {
  recordQqOutboundMessageFact(h.orm, {
    intentId,
    accountId: "90001",
    agentId: DEFAULT_AGENT_ID,
    identity: {
      qq: "90001",
      groupCard: null,
      personalNickname: "群猫娘",
      legacyDisplayName: null,
      nameState: "known",
    },
    occurredAtSeconds: at,
  });
}

function intentRef(id: string): SourceRef {
  return { kind: "outbound_intent", id, revision: "planned", expiresAt: later };
}

function factRow(h: ReturnType<typeof setup>, intentId: string): Record<string, unknown> | null {
  return h.db
    .query("SELECT * FROM qq_outbound_message_facts WHERE intent_id=?")
    .get(intentId) as Record<string, unknown> | null;
}

function factCount(h: ReturnType<typeof setup>): number {
  return (h.db.query("SELECT COUNT(*) AS n FROM qq_outbound_message_facts").get() as { n: number })
    .n;
}

/** 与 qq-outbound-fact-source-access.test.ts 同型的 scope 读取（绑定行 + 会话纪元）。 */
function liveScope(
  h: ReturnType<typeof setup>,
  conversation: ReturnType<typeof bind>["conversation"],
): QqConversationScope {
  const b = h.db
    .query(
      "SELECT account_id,conversation_kind,peer_id,agent_id,authority_revision FROM qq_bindings WHERE id=?",
    )
    .get(conversation.sourceId) as {
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
    bindingId: conversation.sourceId,
    bindingEpoch: conversation.bindingEpoch,
    authorityRevision: b.authority_revision,
  };
}

function partIdOf(h: ReturnType<typeof setup>, intentId: string, ordinal: number): string {
  const row = h.db
    .query("SELECT id FROM outbound_parts WHERE intent_id=? AND ordinal=?")
    .get(intentId, ordinal) as { id: string };
  return row.id;
}

/** 真实 scope 目标 + 真实部件文本的意图提交（mint 需要 target 与 scope 逐维一致）。 */
function commitPartIntent(
  h: ReturnType<typeof setup>,
  outbox: OutboundIntentRepository,
  conversation: ReturnType<typeof bind>["conversation"],
  intentId: string,
  texts: string[],
) {
  const scope = liveScope(h, conversation);
  new AgentRunRepository(h.db).createRun({
    runId: `run-${intentId}`,
    specId: "main",
    specVersion: "1",
    owner: { kind: "conversation", id: conversation.id },
    at: now,
  });
  return outbox.commit({
    id: intentId,
    runId: `run-${intentId}`,
    conversationId: conversation.id,
    ordinal: 0,
    target: {
      accountId: scope.accountId,
      conversationKind: scope.conversationKind,
      peerId: scope.peerId,
      agentId: scope.agentId,
      bindingId: scope.bindingId,
      bindingEpoch: scope.bindingEpoch,
      authorityRevision: scope.authorityRevision,
    },
    speechKind: "direct_reply",
    sourceThroughSeq: 0,
    deliverBy: later,
    createdAt: now,
    expiresAt: later,
    parts: texts.map((text) => ({ kind: "text" as const, text })),
  });
}

/** 真实确认部件 → 真实 minted ref（loadQqOutboundMessageFact，不手拼）。 */
function mintedPartRef(
  h: ReturnType<typeof setup>,
  conversation: ReturnType<typeof bind>["conversation"],
  platformMessageId: string,
): SourceRef {
  const fact = loadQqOutboundMessageFact(h, liveScope(h, conversation), platformMessageId, now);
  if (!fact) throw new Error("fixture: confirmed part fact missing");
  const ref = fact.sources.find((source) => source.kind === "qq_outbound_message_fact");
  if (!ref) throw new Error("fixture: qq_outbound_message_fact ref missing");
  return ref;
}

type DeliveryStep =
  | { kind: "confirmed"; messageId: string }
  | { kind: "unknown" }
  | { kind: "failed" };

/** 真实 OutboundDelivery + 合成端口（同 qq-outbound-fact-source-access.test.ts）。 */
async function deliver(
  h: ReturnType<typeof setup>,
  journal: ConversationEventRepository,
  outbox: OutboundIntentRepository,
  intentId: string,
  script: DeliveryStep[],
) {
  let index = 0;
  const delivery = new OutboundDelivery({
    orm: h.orm,
    repository: outbox,
    journal,
    stickerFile: () => "base64://synthetic-sticker",
    authorize: () => true,
    now: () => now,
    port: {
      async send() {
        const step = script[index++];
        if (step?.kind === "confirmed") return { kind: "confirmed", messageId: step.messageId };
        if (step?.kind === "failed") return { kind: "failed", retcode: -1 };
        return { kind: "unknown", reason: "timeout" };
      },
    },
  });
  return delivery.deliver(intentId);
}

describe("outbound fact retention protection", () => {
  it("keeps an expired fact while its intent is still planned, and the read side stays unreadable", () => {
    const h = setup();
    try {
      const { conversation } = bind(h, "binding-keep");
      const outbox = new OutboundIntentRepository(h.db);
      commitIntent(h, outbox, conversation, "intent-keep");
      recordFact(h, "intent-keep");
      const before = { ...factRow(h, "intent-keep") };

      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(0);

      const after = factRow(h, "intent-keep");
      expect(after).not.toBeNull();
      if (!after) throw new Error("protected fact row missing");
      for (const key of Object.keys(before)) expect(after[key]).toBe(before[key]);
      // 到期即不可读：物理行被保护，但投影不复活身份或部件。
      const projection = projectQqOutboundMessageFacts(h.orm, "intent-keep", expired);
      expect(projection.identity).toBeNull();
      expect(projection.parts).toEqual([]);
      expect(projection.expired).toBe(true);
    } finally {
      h.close();
    }
  });

  it("keeps the fact while a part is sending or unknown, fail-closed on the part ledger", () => {
    const h = setup();
    try {
      const { conversation } = bind(h, "binding-parts");
      const outbox = new OutboundIntentRepository(h.db);
      // 真实在途：claim 后部件 sending、intent delivering——attempt 状态清理前后不变。
      commitIntent(h, outbox, conversation, "intent-sending");
      recordFact(h, "intent-sending");
      const claim = outbox.claimPart("intent-sending", now);
      if (!claim) throw new Error("claim missing");
      expect(claim.part.status).toBe("sending");

      // 同一 conversation 的因果 claim 会挡住后面的 intent，未知态改用独立会话隔离——
      // 两个会话之间不存在先后，各自照常领取。
      const { conversation: unknownConversation } = bind(h, "binding-parts-unknown", "30005");
      // fail-closed：part unknown 而意图账本被标成已结算的分歧态（真实路径会把 intent 同步
      // 成 unknown；这里手工错开两者），仍按真实 part 账本保护。
      commitIntent(h, outbox, unknownConversation, "intent-unknown");
      recordFact(h, "intent-unknown");
      const unknownClaim = outbox.claimPart("intent-unknown", now);
      if (!unknownClaim) throw new Error("unknown claim missing");
      outbox.settlePart(unknownClaim.part.id, { status: "unknown" }, now);
      h.db.query("UPDATE outbound_intents SET status='confirmed' WHERE id=?").run("intent-unknown");

      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(0);

      const sendingPart = h.db
        .query("SELECT status,attempted_at,finished_at FROM outbound_parts WHERE id=?")
        .get(claim.part.id) as { status: string; attempted_at: string; finished_at: string | null };
      expect(sendingPart.status).toBe("sending");
      expect(sendingPart.attempted_at).toBe(now);
      expect(sendingPart.finished_at).toBeNull();
      const unknownParts = h.db
        .query("SELECT status FROM outbound_parts WHERE intent_id=?")
        .all("intent-unknown") as { status: string }[];
      expect(unknownParts.map((p) => p.status)).toEqual(["unknown", "not_sent"]);
    } finally {
      h.close();
    }
  });

  it("deletes a terminal expired fact once and returns the real deleted count", () => {
    const h = setup();
    try {
      const { conversation } = bind(h, "binding-gone");
      const outbox = new OutboundIntentRepository(h.db);
      commitIntent(h, outbox, conversation, "intent-gone");
      recordFact(h, "intent-gone");
      for (;;) {
        const claim = outbox.claimPart("intent-gone", now);
        if (!claim) break;
        outbox.settlePart(
          claim.part.id,
          { status: "confirmed", messageId: `m-${claim.part.ordinal}` },
          now,
        );
      }
      expect(
        (
          h.db.query("SELECT status FROM outbound_intents WHERE id=?").get("intent-gone") as {
            status: string;
          }
        ).status,
      ).toBe("confirmed");

      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(1);
      expect(factCount(h)).toBe(0);
      // R16：无候选删 0 行，返回 0 合法。
      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(0);
    } finally {
      h.close();
    }
  });

  it("does not let a protected fact block an unrelated fact's deletion", () => {
    const h = setup();
    try {
      const { conversation } = bind(h, "binding-mixed");
      const outbox = new OutboundIntentRepository(h.db);
      commitIntent(h, outbox, conversation, "intent-protected");
      recordFact(h, "intent-protected");
      // 被保护的 intent 会挡住同一 conversation 的后一个 planned；unrelated 放独立会话，
      // 才能真正投递并到期删除，验证保护范围不越界到别的会话。
      const { conversation: unrelatedConversation } = bind(h, "binding-mixed-unrelated", "30006");
      commitIntent(h, outbox, unrelatedConversation, "intent-unrelated");
      recordFact(h, "intent-unrelated");
      for (;;) {
        const claim = outbox.claimPart("intent-unrelated", now);
        if (!claim) break;
        outbox.settlePart(
          claim.part.id,
          { status: "confirmed", messageId: `m-${claim.part.ordinal}` },
          now,
        );
      }

      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(1);

      expect(factRow(h, "intent-protected")).toBeDefined();
      expect(factRow(h, "intent-unrelated")).toBeNull();
    } finally {
      h.close();
    }
  });

  it("leaves live facts untouched", () => {
    const h = setup();
    try {
      const { conversation } = bind(h, "binding-live");
      const outbox = new OutboundIntentRepository(h.db);
      commitIntent(h, outbox, conversation, "intent-live");
      recordFact(h, "intent-live");

      expect(purgeExpiredQqOutboundMessageFacts(h.orm, now)).toBe(0);
      expect(factRow(h, "intent-live")).toBeDefined();
    } finally {
      h.close();
    }
  });

  it("keeps the fact while a nonterminal run's context sources reference the intent, then releases it", () => {
    const h = setup();
    try {
      const { conversation } = bind(h, "binding-run");
      const outbox = new OutboundIntentRepository(h.db);
      const runs = new AgentRunRepository(h.db);
      commitIntent(h, outbox, conversation, "intent-run");
      recordFact(h, "intent-run");
      for (;;) {
        const claim = outbox.claimPart("intent-run", now);
        if (!claim) break;
        outbox.settlePart(
          claim.part.id,
          { status: "confirmed", messageId: `m-${claim.part.ordinal}` },
          now,
        );
      }
      // 非终态 run 的真实上下文快照精确引用该 intent（exact 快照 + 精确 kind/id）。
      runs.createRun({
        runId: "run-snapshot",
        specId: "main",
        specVersion: "1",
        owner: { kind: "conversation", id: conversation.id },
        at: now,
      });
      runs.startStep({
        runId: "run-snapshot",
        stepId: "step-snapshot",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: now,
        messages: [textMessage("user", "整理这段输出")],
        sources: [intentRef("intent-run")],
      });

      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(0);
      expect(factRow(h, "intent-run")).toBeDefined();

      // run 转终态后引用不再在用：同一行真实删除。
      runs.setStatus("run-snapshot", "completed", now);
      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(1);
      expect(factRow(h, "intent-run")).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the fact while a nonterminal agent task's sources reference the intent", () => {
    const h = setup();
    try {
      const { conversation } = bind(h, "binding-task");
      const outbox = new OutboundIntentRepository(h.db);
      const tasks = new AgentTaskRepository(h.db);
      commitIntent(h, outbox, conversation, "intent-task");
      recordFact(h, "intent-task");
      for (;;) {
        const claim = outbox.claimPart("intent-task", now);
        if (!claim) break;
        outbox.settlePart(
          claim.part.id,
          { status: "confirmed", messageId: `m-${claim.part.ordinal}` },
          now,
        );
      }
      const task = tasks.enqueue({
        conversationId: conversation.id,
        agentId: DEFAULT_AGENT_ID,
        dedupeKey: "task-intent-task",
        sources: [intentRef("intent-task")],
        at: now,
        expiresAt: later,
        calls: [],
      });

      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(0);
      expect(factRow(h, "intent-task")).toBeDefined();

      tasks.settle(task.id, "completed", now);
      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(1);
      expect(factRow(h, "intent-task")).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the fact while a terminal task still holds an unknown call (TASK_PROTECTION same scope)", () => {
    const h = setup();
    try {
      const { conversation } = bind(h, "binding-task-unknown");
      const outbox = new OutboundIntentRepository(h.db);
      const tasks = new AgentTaskRepository(h.db);
      commitIntent(h, outbox, conversation, "intent-task-unknown");
      recordFact(h, "intent-task-unknown");
      for (;;) {
        const claim = outbox.claimPart("intent-task-unknown", now);
        if (!claim) break;
        outbox.settlePart(
          claim.part.id,
          { status: "confirmed", messageId: `m-${claim.part.ordinal}` },
          now,
        );
      }
      // 真实 interrupt 通路：running write 调用被置 unknown，任务落 unknown；再次真实
      // interrupt（与到期巡检对同一任务重复判定的形态一致）后任务落终态 failed，而该
      // write 调用按「unknown 调用恒保」永久保持 unknown——终态任务仍持 unknown 调用。
      const task = tasks.enqueue({
        conversationId: conversation.id,
        agentId: DEFAULT_AGENT_ID,
        dedupeKey: "task-intent-task-unknown",
        sources: [intentRef("intent-task-unknown")],
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

      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(0);
      expect(factRow(h, "intent-task-unknown")).toBeDefined();
    } finally {
      h.close();
    }
  });

  it("deletes the fact for a terminal task with no unknown call", () => {
    const h = setup();
    try {
      const { conversation } = bind(h, "binding-task-terminal");
      const outbox = new OutboundIntentRepository(h.db);
      const tasks = new AgentTaskRepository(h.db);
      commitIntent(h, outbox, conversation, "intent-task-terminal");
      recordFact(h, "intent-task-terminal");
      for (;;) {
        const claim = outbox.claimPart("intent-task-terminal", now);
        if (!claim) break;
        outbox.settlePart(
          claim.part.id,
          { status: "confirmed", messageId: `m-${claim.part.ordinal}` },
          now,
        );
      }
      // 终态且无 unknown 调用的任务不再保全：引用所指向的事实行照常清理。
      const task = tasks.enqueue({
        conversationId: conversation.id,
        agentId: DEFAULT_AGENT_ID,
        dedupeKey: "task-intent-task-terminal",
        sources: [intentRef("intent-task-terminal")],
        at: now,
        expiresAt: later,
        calls: [],
      });
      tasks.settle(task.id, "cancelled", now);

      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(1);
      expect(factRow(h, "intent-task-terminal")).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the fact while a nonterminal run references the exact confirmed part (new kind), then releases it", async () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h, "binding-part-run");
      const outbox = new OutboundIntentRepository(h.db);
      const runs = new AgentRunRepository(h.db);
      commitPartIntent(h, outbox, conversation, "intent-part-run", ["first", "second"]);
      recordFact(h, "intent-part-run");
      await deliver(h, journal, outbox, "intent-part-run", [
        { kind: "confirmed", messageId: "-9001" },
        { kind: "confirmed", messageId: "-9002" },
      ]);
      // 真实 minted ref：id 必须等于该部件的真实 outbound_parts.id（不猜 part id）。
      const ref = mintedPartRef(h, conversation, "-9001");
      expect(ref.id).toBe(partIdOf(h, "intent-part-run", 0));
      runs.createRun({
        runId: "run-part-snapshot",
        specId: "main",
        specVersion: "1",
        owner: { kind: "conversation", id: conversation.id },
        at: now,
      });
      runs.startStep({
        runId: "run-part-snapshot",
        stepId: "step-part-snapshot",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: now,
        messages: [textMessage("user", "整理这条已确认部件")],
        sources: [ref],
      });

      // 非终态 run 持新 kind 精确 part 引用：保行（产品未改时本断言红——旧谓词只认
      // outbound_intent kind，部件级引用漏保护）。
      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(0);
      expect(factRow(h, "intent-part-run")).not.toBeNull();
      // 到期读取仍不可用：保护只延迟物理删除，不复活投影。
      const projection = projectQqOutboundMessageFacts(h.orm, "intent-part-run", expired);
      expect(projection.identity).toBeNull();
      expect(projection.parts).toEqual([]);
      expect(projection.expired).toBe(true);

      // run 转终态后释放：同一行真实删除。
      runs.setStatus("run-part-snapshot", "completed", now);
      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(1);
      expect(factRow(h, "intent-part-run")).toBeNull();
      // R16：无候选再删 0 行。
      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(0);
      expect(factCount(h)).toBe(0);
    } finally {
      h.close();
    }
  });

  it("keeps the fact while an agent task holds the exact confirmed-part ref, then releases after a safe settle", async () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h, "binding-part-task");
      const outbox = new OutboundIntentRepository(h.db);
      const tasks = new AgentTaskRepository(h.db);
      commitPartIntent(h, outbox, conversation, "intent-part-task", ["part"]);
      recordFact(h, "intent-part-task");
      await deliver(h, journal, outbox, "intent-part-task", [
        { kind: "confirmed", messageId: "-9200" },
      ]);
      const ref = mintedPartRef(h, conversation, "-9200");
      const task = tasks.enqueue({
        conversationId: conversation.id,
        agentId: DEFAULT_AGENT_ID,
        dedupeKey: "task-part-ref",
        sources: [ref],
        at: now,
        expiresAt: later,
        calls: [],
      });

      // 非终态任务持精确 part 引用：保行（产品未改时为红）。
      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(0);
      expect(factRow(h, "intent-part-task")).not.toBeNull();

      // 安全终态（completed、无 unknown 调用）后释放：同一行真实删除。
      tasks.settle(task.id, "completed", now);
      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(1);
      expect(factRow(h, "intent-part-task")).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the fact while a terminal task still holds an unknown call through the exact part ref (real two interrupts)", async () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h, "binding-part-task-unknown");
      const outbox = new OutboundIntentRepository(h.db);
      const tasks = new AgentTaskRepository(h.db);
      commitPartIntent(h, outbox, conversation, "intent-part-task-unknown", ["part"]);
      recordFact(h, "intent-part-task-unknown");
      await deliver(h, journal, outbox, "intent-part-task-unknown", [
        { kind: "confirmed", messageId: "-9300" },
      ]);
      const ref = mintedPartRef(h, conversation, "-9300");
      const task = tasks.enqueue({
        conversationId: conversation.id,
        agentId: DEFAULT_AGENT_ID,
        dedupeKey: "task-part-ref-unknown",
        sources: [ref],
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

      // 终态仍持 unknown 调用（TASK_PROTECTION 同口径）：精确 part 引用照旧保行。
      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(0);
      expect(factRow(h, "intent-part-task-unknown")).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it("wrong kind, foreign part, no real part and terminal holders do not protect the fact", async () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h, "binding-part-negative");
      const outbox = new OutboundIntentRepository(h.db);
      const runs = new AgentRunRepository(h.db);
      const tasks = new AgentTaskRepository(h.db);
      // 目标 intent 与一个外部件 intent：各自真实两部件、全确认（intent 结算为 confirmed，
      // 只剩引用面可保护）。
      commitPartIntent(h, outbox, conversation, "intent-neg-target", ["t1", "t2"]);
      commitPartIntent(h, outbox, conversation, "intent-neg-foreign", ["f1", "f2"]);
      recordFact(h, "intent-neg-target");
      recordFact(h, "intent-neg-foreign");
      // 同 conversation 按 created_at→output_ordinal→id 定因果序：foreign 的 id 更早，
      // 先结算它 target 才能领取，不能两个 planned 并列并发发。
      await deliver(h, journal, outbox, "intent-neg-foreign", [
        { kind: "confirmed", messageId: "-9403" },
        { kind: "confirmed", messageId: "-9404" },
      ]);
      await deliver(h, journal, outbox, "intent-neg-target", [
        { kind: "confirmed", messageId: "-9401" },
        { kind: "confirmed", messageId: "-9402" },
      ]);
      const exact = mintedPartRef(h, conversation, "-9401");
      const foreign = mintedPartRef(h, conversation, "-9403");
      expect(foreign.id).toBe(partIdOf(h, "intent-neg-foreign", 0));
      // 非终态 run 持三类不精确引用 + 终态 run 持精确引用：
      //  * wrongkind：kind 不是两个出站 kind（qq_message_fact 指 part id）；
      //  * foreignpart：qq_outbound_message_fact 指另一 intent 的真实部件；
      //  * noexact：qq_outbound_message_fact 指不存在的部件 id。
      runs.createRun({
        runId: "run-neg-mixed",
        specId: "main",
        specVersion: "1",
        owner: { kind: "conversation", id: conversation.id },
        at: now,
      });
      runs.startStep({
        runId: "run-neg-mixed",
        stepId: "step-neg-mixed",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: now,
        messages: [textMessage("user", "四类非持有引用")],
        sources: [
          { kind: "qq_message_fact", id: exact.id, revision: "x" },
          foreign,
          { kind: "qq_outbound_message_fact", id: "no-such-part", revision: "x" },
        ],
      });
      runs.createRun({
        runId: "run-neg-terminal",
        specId: "main",
        specVersion: "1",
        owner: { kind: "conversation", id: conversation.id },
        at: now,
      });
      runs.startStep({
        runId: "run-neg-terminal",
        stepId: "step-neg-terminal",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: now,
        messages: [textMessage("user", "终态持有")],
        sources: [exact],
      });
      runs.setStatus("run-neg-terminal", "completed", now);
      const safeTask = tasks.enqueue({
        conversationId: conversation.id,
        agentId: DEFAULT_AGENT_ID,
        dedupeKey: "task-neg-safe",
        sources: [exact],
        at: now,
        expiresAt: later,
        calls: [],
      });
      tasks.settle(safeTask.id, "completed", now);
      // 目标行无人精确持有 → 照常删除；外部件行被 run-neg-mixed 的 foreign ref 保护
      // （同一谓词只保护自己 intent 的部件，不越界到目标行）。
      expect(purgeExpiredQqOutboundMessageFacts(h.orm, expired)).toBe(1);
      expect(factRow(h, "intent-neg-target")).toBeNull();
      expect(factRow(h, "intent-neg-foreign")).not.toBeNull();
    } finally {
      h.close();
    }
  });
});
