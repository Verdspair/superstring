// 已知业务失败保留错误码；未知错误不泄露细节，取消原因仍优先。

import { afterEach, describe, expect, it } from "bun:test";
import { QqTaskScheduler } from "../../src/server/conversation/qq-task-scheduler";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  createQqConversationTask,
  type QqConversationTaskRow,
  type QqConversationTaskSourceGuard,
} from "../../src/server/db/qq-task-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { AppError } from "../../src/server/errors";
import {
  type QqConversationTaskLimits,
  type QqTaskExecutionSnapshot,
  QqTaskExecutionSnapshotSchema,
  qqConversationTaskKey,
} from "../../src/shared/contracts/qq-task";
import { cloneBusinessDb } from "../harness/business-db";

const nowIso = () => "2026-10-16T00:00:00.000Z";
const handles: BusinessDbHandle[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function setup() {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "test-model");
  return h;
}

function scope(h: ReturnType<typeof setup>, peerId: string, accountId = "10001") {
  const schemeId = crypto.randomUUID();
  h.db
    .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES(?,?,?,?)")
    .run(schemeId, `scheme-${schemeId}`, nowIso(), nowIso());
  const bindingId = crypto.randomUUID();
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,'group',?,?,?, ?,?)",
    )
    .run(bindingId, accountId, peerId, DEFAULT_AGENT_ID, schemeId, nowIso(), nowIso());
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(bindingId)!;
  return { bindingId, conversation, journal, accountId, peerId, agentId: DEFAULT_AGENT_ID };
}

function inbound(h: ReturnType<typeof setup>, s: ReturnType<typeof scope>, messageId: string) {
  const eventKey = `evt-${s.bindingId}-${messageId}`;
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at,addressed) VALUES(?,?,'group',?,?,?,1,'member','same-sender',?,1)",
    )
    .run(eventKey, s.accountId, s.peerId, s.agentId, messageId, nowIso());
  return s.journal.ingestOneBotEvent(eventKey, s.bindingId, {
    reasons: ["mention"],
    mentionIds: [s.agentId],
  })!;
}

function mentionInput(h: ReturnType<typeof setup>, s: ReturnType<typeof scope>, messageId: string) {
  const event = inbound(h, s, messageId);
  return {
    taskKey: qqConversationTaskKey.mention({
      accountId: s.accountId,
      conversationId: s.conversation.id,
      bindingEpoch: s.conversation.bindingEpoch,
      platformMessageId: messageId,
      agentId: s.agentId,
    }),
    conversationId: s.conversation.id,
    bindingEpoch: s.conversation.bindingEpoch,
    agentId: s.agentId,
    taskClass: "mention" as const,
    cause: "direct_reply" as const,
    sourceFromSeq: event.seq,
    sourceThroughSeq: event.seq,
    originEventKey: `evt-${s.bindingId}-${messageId}`,
    platformMessageId: messageId,
  };
}

const limits = () => ({ mentionTaskLimit: 4, ordinaryTaskLimit: 1 });

const validateInput: QqConversationTaskSourceGuard = (transaction, identity) => {
  const db = (transaction as typeof transaction & { $client: BusinessDbHandle["db"] }).$client;
  const current = db
    .query(
      "SELECT 1 AS ok FROM conversations c JOIN qq_bindings b ON b.id=c.source_id WHERE c.id=? AND c.binding_epoch=? AND c.agent_id=? AND c.closed_at IS NULL AND b.agent_id=c.agent_id",
    )
    .get(identity.conversationId, identity.bindingEpoch, identity.agentId);
  if (!current) return "revoked";
  const source = db
    .query(
      "SELECT 1 AS ok FROM conversation_events ce JOIN qq_events e ON e.event_key=ce.source_id JOIN conversations c ON c.id=ce.conversation_id JOIN qq_bindings b ON b.id=c.source_id WHERE ce.conversation_id=? AND ce.source_kind='qq_event' AND e.agent_id=? AND b.account_id=e.account_id AND b.peer_id=e.peer_id AND ce.seq=?",
    )
    .get(identity.conversationId, identity.agentId, identity.sourceThroughSeq);
  return source ? "valid" : "revoked";
};
const sourceState = validateInput;

function freezeSnapshot(
  transaction: Parameters<QqConversationTaskSourceGuard>[0],
  task: Readonly<QqConversationTaskRow>,
  limits: Readonly<QqConversationTaskLimits>,
): QqTaskExecutionSnapshot {
  const db = (transaction as typeof transaction & { $client: BusinessDbHandle["db"] }).$client;
  const row = db
    .query(`SELECT b.id AS binding_id,b.account_id,b.revision AS binding_revision,
      b.authority_revision,b.peer_id,b.conversation_kind,s.id AS scheme_id,s.revision AS scheme_revision,
      a.config_version FROM conversations c JOIN qq_bindings b ON b.id=c.source_id
      JOIN qq_schemes s ON s.id=b.scheme_id JOIN agents a ON a.id=b.agent_id WHERE c.id=?`)
    .get(task.conversationId) as {
    binding_id: string;
    account_id: string;
    binding_revision: number;
    authority_revision: number;
    peer_id: string;
    conversation_kind: string;
    scheme_id: string;
    scheme_revision: number;
    config_version: number;
  };
  const target =
    task.taskClass === "mention"
      ? (db
          .query("SELECT speaker_id FROM qq_events WHERE event_key=?")
          .get(task.originEventKey ?? null) as { speaker_id: string | null } | null)
      : null;
  const targetId = target?.speaker_id ?? row.peer_id;
  return QqTaskExecutionSnapshotSchema.parse({
    accountId: row.account_id,
    conversationId: task.conversationId,
    bindingId: row.binding_id,
    bindingEpoch: task.bindingEpoch,
    agentId: task.agentId,
    schemeId: row.scheme_id,
    bindingRevision: row.binding_revision,
    authorityRevision: row.authority_revision,
    schemeRevision: row.scheme_revision,
    agentConfigVersion: row.config_version,
    taskClass: task.taskClass,
    cause: task.cause,
    sourceFromSeq: task.sourceFromSeq,
    sourceThroughSeq: task.sourceThroughSeq,
    sourceExpiresAt: task.sourceExpiresAt,
    authorizedTargets: [targetId],
    targetParticipants: [{ targetId, speakerId: target?.speaker_id ?? null }],
    maxSteps: 12,
    deliveryTtlSeconds: 900,
    mentionTaskLimit: limits.mentionTaskLimit,
    ordinaryTaskLimit: limits.ordinaryTaskLimit,
    taskKey: task.taskKey,
  });
}

/** onError 归因读法：带 string code 的错误按 code 归因，否则按 message（与现行观察者形态兼容）。 */
function attributed(errors: unknown[]): string[] {
  return errors.map((error) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string") return code;
    return error instanceof Error ? error.message : String(error);
  });
}

const taskRow = (h: ReturnType<typeof setup>, id: string) =>
  h.db
    .query("SELECT status,error_code,lease_token FROM qq_conversation_tasks WHERE id=?")
    .get(id) as { status: string; error_code: string | null; lease_token: string | null };

const fullRowJson = (h: ReturnType<typeof setup>, id: string) => {
  const row = h.db.query("SELECT * FROM qq_conversation_tasks WHERE id=?").get(id);
  return JSON.stringify(row);
};

describe("qq task failure attribution", () => {
  it("persists the exact approved AppError code from activate onto the task and onError", async () => {
    const h = setup();
    const s = scope(h, "failure-attribution-app");
    const detail = "private activation detail: context assembly overran the budget for speaker X";
    const task = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "91001"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const errors: unknown[] = [];
    const scheduler = new QqTaskScheduler({
      orm: h.orm,
      policy: () => ({ leaseMs: 60_000, renewMs: 20_000 }),
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
      async activate() {
        throw new AppError("CONTEXT_BUDGET_EXCEEDED", detail, 409);
      },
      resolveExistingRunAndOutbox: () => "failed",
      onError: (error) => errors.push(error),
      now: nowIso,
    });
    try {
      expect(await scheduler.runOnce()).toBe(true);
      await scheduler.waitForIdle();
      expect(taskRow(h, task.id)).toEqual({
        status: "failed",
        error_code: "CONTEXT_BUDGET_EXCEEDED",
        lease_token: null,
      });
      // 只有批准的 code 落库；AppError 的 message 文本不得持久化。
      expect(fullRowJson(h, task.id)).not.toContain(detail);
      expect(attributed(errors)).toEqual(["CONTEXT_BUDGET_EXCEEDED"]);
      expect(scheduler.activeCount).toBe(0);
    } finally {
      scheduler.stop();
      await scheduler.waitForIdle();
    }
  });

  it("keeps untyped errors generic without leaking contents and keeps cancellation precedence", async () => {
    const h = setup();
    const s = scope(h, "failure-attribution-generic");

    // 任意无类型错误：通用 QQ_TASK_FAILED 掩蔽，错误内容不落库、不上观察者。
    const secret = "secret private activation context: user X said Y";
    const generic = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "91002"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const genericErrors: unknown[] = [];
    const genericScheduler = new QqTaskScheduler({
      orm: h.orm,
      policy: () => ({ leaseMs: 60_000, renewMs: 20_000 }),
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
      async activate() {
        throw new Error(secret);
      },
      resolveExistingRunAndOutbox: () => "failed",
      onError: (error) => genericErrors.push(error),
      now: nowIso,
    });
    try {
      expect(await genericScheduler.runOnce()).toBe(true);
      await genericScheduler.waitForIdle();
      expect(taskRow(h, generic.id)).toEqual({
        status: "failed",
        error_code: "QQ_TASK_FAILED",
        lease_token: null,
      });
      expect(fullRowJson(h, generic.id)).not.toContain("secret private");
      expect(attributed(genericErrors)).toEqual(["QQ_TASK_FAILED"]);

      // 取消原因优先级保持现状：取消请求压过任意激活错误，行按 cancelled 收尾且不报 onError。
      const cancelled = createQqConversationTask(
        h.orm,
        { ...mentionInput(h, s, "91003"), at: nowIso() },
        { validateSource: validateInput },
      ).task;
      const cancelledErrors: unknown[] = [];
      const cancelledScheduler = new QqTaskScheduler({
        orm: h.orm,
        policy: () => ({ leaseMs: 60_000, renewMs: 20_000 }),
        limitsFor: limits,
        sourceState,
        freezeAtClaim: freezeSnapshot,
        async activate(_task, _snapshot, _lease, signal) {
          return await new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        },
        resolveExistingRunAndOutbox: () => "failed",
        onError: (error) => cancelledErrors.push(error),
        now: nowIso,
      });
      try {
        expect(await cancelledScheduler.dispatchOnce()).toBe(true);
        expect(cancelledScheduler.cancel(cancelled.id)).toBe("requested");
        await cancelledScheduler.waitForIdle();
        expect(taskRow(h, cancelled.id)).toEqual({
          status: "cancelled",
          error_code: null,
          lease_token: null,
        });
        expect(cancelledErrors).toEqual([]);
      } finally {
        cancelledScheduler.stop();
        await cancelledScheduler.waitForIdle();
      }
    } finally {
      genericScheduler.stop();
      await genericScheduler.waitForIdle();
    }
  });
});
