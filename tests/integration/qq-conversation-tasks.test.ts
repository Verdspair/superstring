import { afterEach, describe, expect, it } from "bun:test";
import { QqTaskScheduler } from "../../src/server/conversation/qq-task-scheduler";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  cancelQqConversationTask,
  claimNextQqConversationTask,
  createQqConversationTask,
  markQqConversationTaskJudgementDone,
  type QqConversationTaskSourceGuard,
  recoverQqConversationTaskLease,
  renewQqConversationTaskLease,
  settleQqConversationTask,
} from "../../src/server/db/qq-task-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import {
  type QqTaskExecutionSnapshot,
  QqTaskExecutionSnapshotSchema,
  qqConversationTaskKey,
} from "../../src/shared/contracts/qq-task";
import { cloneBusinessDb } from "../harness/business-db";

const nowIso = () => "2026-10-10T00:00:00.000Z";
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

function scope(
  h: ReturnType<typeof setup>,
  peerId: string,
  accountId = "10001",
  agentId = DEFAULT_AGENT_ID,
) {
  const schemeId = crypto.randomUUID();
  h.db
    .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES(?,?,?,?)")
    .run(schemeId, `scheme-${schemeId}`, nowIso(), nowIso());
  const bindingId = crypto.randomUUID();
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,'group',?,?,?, ?,?)",
    )
    .run(bindingId, accountId, peerId, agentId, schemeId, nowIso(), nowIso());
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(bindingId)!;
  return { bindingId, conversation, journal, accountId, peerId, agentId };
}

const platformIds = new Map<string, string>();
function numericMessageId(label: string): string {
  if (/^-?\d+$/.test(label)) return label;
  let id = platformIds.get(label);
  if (!id) {
    id = String(100000 + platformIds.size);
    platformIds.set(label, id);
  }
  return id;
}

function inbound(
  h: ReturnType<typeof setup>,
  s: ReturnType<typeof scope>,
  messageId: string,
  eventKey = `evt-${messageId}`,
) {
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

function wake(
  h: ReturnType<typeof setup>,
  s: ReturnType<typeof scope>,
  cause: string,
  throughSeq: number,
  key: string,
) {
  const id = crypto.randomUUID();
  h.db
    .query(
      "INSERT INTO wake_signals(id,conversation_id,cause,through_seq,dedupe_key,ready_at,priority,status,lease_token,lease_expires_at,created_at) VALUES(?,?,?,?,?,?,0,'leased',?,?,?)",
    )
    .run(
      id,
      s.conversation.id,
      cause,
      throughSeq,
      key,
      nowIso(),
      `wake-${key}`,
      "2099-01-01T00:00:00.000Z",
      nowIso(),
    );
  return id;
}

const limits = () => ({ mentionTaskLimit: 4, ordinaryTaskLimit: 1 });

function mentionInput(h: ReturnType<typeof setup>, s: ReturnType<typeof scope>, messageId: string) {
  messageId = numericMessageId(messageId);
  const eventKey = `evt-${s.bindingId}-${messageId}`;
  const event = inbound(h, s, messageId, eventKey);
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
    originEventKey: eventKey,
    platformMessageId: messageId,
  };
}

function ordinaryInput(
  h: ReturnType<typeof setup>,
  s: ReturnType<typeof scope>,
  cause: "direct_reply" | "follow_up" | "chiming_in" | "idle_topic",
  messageId: string,
) {
  const event = inbound(
    h,
    s,
    numericMessageId(messageId),
    `evt-${s.bindingId}-${numericMessageId(messageId)}`,
  );
  const wakeKey = `wake:${messageId}`;
  const wakeId = wake(h, s, cause, event.seq, wakeKey);
  return {
    taskKey: qqConversationTaskKey.ordinary({
      conversationId: s.conversation.id,
      bindingEpoch: s.conversation.bindingEpoch,
      agentId: s.agentId,
      wakeId,
    }),
    conversationId: s.conversation.id,
    bindingEpoch: s.conversation.bindingEpoch,
    agentId: s.agentId,
    taskClass: "ordinary" as const,
    cause,
    sourceFromSeq: event.seq,
    sourceThroughSeq: event.seq,
    originWakeId: wakeId,
    wakeLeaseToken: `wake-${wakeKey}`,
  };
}

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
  task: Parameters<
    NonNullable<Parameters<typeof claimNextQqConversationTask>[1]["freezeAtClaim"]>
  >[1],
  limits: Parameters<
    NonNullable<Parameters<typeof claimNextQqConversationTask>[1]["freezeAtClaim"]>
  >[2],
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

describe("QQ conversation business-task foundation", () => {
  it("idempotently registers a repeated platform event but keeps distinct same-sender messages", () => {
    const h = setup();
    const s = scope(h, "20001");
    const first = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "101"), at: nowIso() },
      { validateSource: validateInput },
    );
    const replay = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "101"), at: nowIso() },
      { validateSource: validateInput },
    );
    const second = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "102"), at: nowIso() },
      { validateSource: validateInput },
    );
    expect(first.created).toBe(true);
    expect(first.task.sourceExpiresAt).toBeNull();
    expect(replay.created).toBe(false);
    expect(replay.task.id).toBe(first.task.id);
    expect(second.task.id).not.toBe(first.task.id);
    expect(h.db.query("SELECT COUNT(*) AS n FROM qq_conversation_tasks").get()).toEqual({ n: 2 });
  });

  it("separates task identity by account, physical conversation, epoch, and target Agent", () => {
    const h = setup();
    const a = scope(h, "20002", "10001");
    const b = scope(h, "20002", "10002");
    const base = {
      conversationId: a.conversation.id,
      bindingEpoch: a.conversation.bindingEpoch,
      platformMessageId: "1234",
    };
    const keys = [
      qqConversationTaskKey.mention({ ...base, accountId: a.accountId, agentId: a.agentId }),
      qqConversationTaskKey.mention({
        ...base,
        accountId: b.accountId,
        conversationId: b.conversation.id,
        agentId: b.agentId,
      }),
      qqConversationTaskKey.mention({
        ...base,
        accountId: a.accountId,
        bindingEpoch: a.conversation.bindingEpoch + 1,
        agentId: a.agentId,
      }),
      qqConversationTaskKey.mention({
        ...base,
        accountId: a.accountId,
        agentId: crypto.randomUUID(),
      }),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it("maps follow-up and idle-topic tasks into ordinary capacity and skips a full conversation", () => {
    const h = setup();
    const first = scope(h, "20003");
    const other = scope(h, "20004");
    const follow = createQqConversationTask(
      h.orm,
      { ...ordinaryInput(h, first, "follow_up", "201"), at: nowIso() },
      { validateSource: validateInput },
    );
    const idle = createQqConversationTask(
      h.orm,
      { ...ordinaryInput(h, first, "idle_topic", "202"), at: nowIso() },
      { validateSource: validateInput },
    );
    createQqConversationTask(
      h.orm,
      { ...ordinaryInput(h, other, "follow_up", "203"), at: nowIso() },
      { validateSource: validateInput },
    );
    const running = claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "lease-1",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
    });
    expect(running?.task.id).toBe(follow.task.id);
    const next = claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "lease-2",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
    });
    expect(next?.conversationId).toBe(other.conversation.id);
    expect(idle.task.cause).toBe("idle_topic");
  });

  it("keeps judgement as a phase marker while the parent consumes its ordinary cap", () => {
    const h = setup();
    const s = scope(h, "20005");
    const firstInput = ordinaryInput(h, s, "chiming_in", "301");
    const first = createQqConversationTask(
      h.orm,
      { ...firstInput, at: nowIso() },
      { validateSource: validateInput },
    );
    const secondInput = ordinaryInput(h, s, "chiming_in", "302");
    const second = createQqConversationTask(
      h.orm,
      { ...secondInput, at: nowIso() },
      { validateSource: validateInput },
    );
    const claimed = claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "judge-lease",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
    });
    expect(claimed?.task.id).toBe(first.task.id);
    const capOne = () => ({ mentionTaskLimit: 4, ordinaryTaskLimit: 1 });
    expect(
      claimNextQqConversationTask(h.orm, {
        at: nowIso(),
        leaseToken: "blocked-1",
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        limitsFor: capOne,
        sourceState,
        freezeAtClaim: freezeSnapshot,
      }),
    ).toBeNull();
    expect(
      markQqConversationTaskJudgementDone(h.orm, {
        taskId: first.task.id,
        leaseToken: "judge-lease",
        at: nowIso(),
        sourceState,
        markJudged: () =>
          s.journal.markChimingInJudged(s.conversation.id, firstInput.sourceThroughSeq, nowIso()),
      }),
    ).toBe(true);
    expect(
      h.db
        .query("SELECT status,judgement_done FROM qq_conversation_tasks WHERE id=?")
        .get(first.task.id),
    ).toEqual({ status: "running", judgement_done: 1 });
    expect(
      claimNextQqConversationTask(h.orm, {
        at: nowIso(),
        leaseToken: "blocked-2",
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        limitsFor: capOne,
        sourceState,
        freezeAtClaim: freezeSnapshot,
      }),
    ).toBeNull();
    const capTwo = () => ({ mentionTaskLimit: 4, ordinaryTaskLimit: 2 });
    expect(
      claimNextQqConversationTask(h.orm, {
        at: nowIso(),
        leaseToken: "judge-lease-2",
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        limitsFor: capTwo,
        sourceState,
        freezeAtClaim: freezeSnapshot,
      })?.task.id,
    ).toBe(second.task.id);
  });

  it("cancels pending work, requests cancellation for a running owner, and settles by lease CAS", () => {
    const h = setup();
    const s = scope(h, "20006");
    const pending = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "401"), at: nowIso() },
      { validateSource: validateInput },
    );
    expect(cancelQqConversationTask(h.orm, { taskId: pending.task.id, at: nowIso() })).toEqual(
      "cancelled",
    );
    const input = mentionInput(h, s, "402");
    const task = createQqConversationTask(
      h.orm,
      { ...input, at: nowIso() },
      { validateSource: validateInput },
    );
    claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "cancel-lease",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
    });
    expect(cancelQqConversationTask(h.orm, { taskId: task.task.id, at: nowIso() })).toEqual(
      "requested",
    );
    expect(
      renewQqConversationTaskLease(h.orm, {
        taskId: task.task.id,
        leaseToken: "cancel-lease",
        at: nowIso(),
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        sourceState,
      }),
    ).toEqual({ status: "lost", reason: "cancel_requested" });
    expect(
      settleQqConversationTask(h.orm, {
        taskId: task.task.id,
        leaseToken: "cancel-lease",
        outcome: "completed",
        at: nowIso(),
        sourceState,
      }),
    ).toBe("cancelled");
    expect(
      settleQqConversationTask(h.orm, {
        taskId: task.task.id,
        leaseToken: "cancel-lease",
        outcome: "completed",
        at: nowIso(),
        sourceState,
      }),
    ).toBe(false);
  });

  it("reports the precise lease-renewal loss reason in the repository transaction", () => {
    const h = setup();
    const missing = renewQqConversationTaskLease(h.orm, {
      taskId: "missing-task",
      leaseToken: "owner",
      at: nowIso(),
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      sourceState,
    });
    expect(missing).toEqual({ status: "lost", reason: "task_missing" });

    const pendingScope = scope(h, "renew-pending");
    const pending = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, pendingScope, "renew-pending"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    expect(
      renewQqConversationTaskLease(h.orm, {
        taskId: pending.id,
        leaseToken: "owner",
        at: nowIso(),
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        sourceState,
      }),
    ).toEqual({ status: "lost", reason: "not_running" });

    const validScope = scope(h, "renew-valid");
    const validTask = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, validScope, "renew-valid"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    h.db
      .query(
        "UPDATE qq_conversation_tasks SET status='running',lease_token='valid-owner',lease_expires_at='2099-01-01T00:00:00.000Z' WHERE id=?",
      )
      .run(validTask.id);
    expect(
      renewQqConversationTaskLease(h.orm, {
        taskId: validTask.id,
        leaseToken: "valid-owner",
        at: nowIso(),
        leaseExpiresAt: "2099-01-01T00:01:00.000Z",
        sourceState,
      }),
    ).toEqual({ status: "renewed" });
    expect(
      h.db.query("SELECT lease_expires_at FROM qq_conversation_tasks WHERE id=?").get(validTask.id),
    ).toEqual({ lease_expires_at: "2099-01-01T00:01:00.000Z" });

    const scenarios = [
      "token_mismatch",
      "lease_expired",
      "cancel_requested",
      "source_expired",
      "source_revoked",
    ] as const;
    for (const scenario of scenarios) {
      const s = scope(h, `renew-${scenario}`);
      const task = createQqConversationTask(
        h.orm,
        {
          ...mentionInput(h, s, `renew-${scenario}`),
          at: nowIso(),
          ...(scenario === "source_expired" ? { sourceExpiresAt: "2026-10-10T00:00:01.000Z" } : {}),
        },
        { validateSource: validateInput },
      ).task;
      const leaseToken = `owner-${scenario}`;
      h.db
        .query(
          "UPDATE qq_conversation_tasks SET status='running',lease_token=?,lease_expires_at=?,cancellation_requested=? WHERE id=?",
        )
        .run(
          leaseToken,
          scenario === "lease_expired" ? "2026-10-09T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
          scenario === "cancel_requested" ? 1 : 0,
          task.id,
        );
      const result = renewQqConversationTaskLease(h.orm, {
        taskId: task.id,
        leaseToken: scenario === "token_mismatch" ? "wrong-owner" : leaseToken,
        at: nowIso(),
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        sourceState:
          scenario === "source_expired"
            ? () => "expired"
            : scenario === "source_revoked"
              ? () => "revoked"
              : sourceState,
      });
      expect(result).toEqual({ status: "lost", reason: scenario });
      if (scenario === "source_expired" || scenario === "source_revoked")
        expect(
          h.db
            .query("SELECT status,lease_token FROM qq_conversation_tasks WHERE id=?")
            .get(task.id),
        ).toEqual({
          status: scenario === "source_expired" ? "expired" : "cancelled",
          lease_token: null,
        });
      else
        h.db
          .query(
            "UPDATE qq_conversation_tasks SET status='completed',lease_token=NULL,lease_expires_at=NULL WHERE id=?",
          )
          .run(task.id);
    }
  });

  it("expires stale pending work and fails closed on expired lease recovery without replay", () => {
    const h = setup();
    const s = scope(h, "20007");
    const expired = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "501"), at: nowIso() },
      { validateSource: validateInput },
    );
    const expiredResult = claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "expired-source",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      limitsFor: limits,
      sourceState: () => "expired",
      freezeAtClaim: freezeSnapshot,
    });
    expect(expiredResult).toBeNull();
    expect(
      h.db.query("SELECT status FROM qq_conversation_tasks WHERE id=?").get(expired.task.id),
    ).toEqual({ status: "expired" });
    const input = mentionInput(h, s, "502");
    const running = createQqConversationTask(
      h.orm,
      { ...input, at: nowIso() },
      { validateSource: validateInput },
    );
    claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "crash-lease",
      leaseExpiresAt: "2026-10-10T00:01:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
    });
    expect(
      recoverQqConversationTaskLease(h.orm, {
        taskId: running.task.id,
        leaseToken: "crash-lease",
        at: "2026-10-10T00:02:00.000Z",
        resolveExistingRunAndOutbox: () => "failed",
      }),
    ).toBe("failed");
    expect(
      h.db
        .query("SELECT status,lease_token FROM qq_conversation_tasks WHERE id=?")
        .get(running.task.id),
    ).toEqual({ status: "failed", lease_token: null });
    expect(
      recoverQqConversationTaskLease(h.orm, {
        taskId: running.task.id,
        leaseToken: "crash-lease",
        at: "2026-10-10T00:02:00.000Z",
        resolveExistingRunAndOutbox: () => "completed",
      }),
    ).toBe(false);
  });

  it("uses persisted source expiry and refuses an expired owner's commit and renewal", () => {
    const h = setup();
    const s = scope(h, "20008");
    const expiring = createQqConversationTask(
      h.orm,
      {
        ...mentionInput(h, s, "601"),
        at: nowIso(),
        sourceExpiresAt: "2026-10-10T00:01:00.000Z",
      },
      { validateSource: validateInput },
    );
    expect(expiring.task.sourceExpiresAt).toBe("2026-10-10T00:01:00.000Z");
    expect(
      claimNextQqConversationTask(h.orm, {
        at: "2026-10-10T00:02:00.000Z",
        leaseToken: "expired-source",
        leaseExpiresAt: "2026-10-10T00:03:00.000Z",
        limitsFor: limits,
        sourceState,
        freezeAtClaim: freezeSnapshot,
      }),
    ).toBeNull();
    const task = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "602"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "short",
      leaseExpiresAt: "2026-10-10T00:01:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
    });
    expect(
      renewQqConversationTaskLease(h.orm, {
        taskId: task.id,
        leaseToken: "short",
        at: "2026-10-10T00:02:00.000Z",
        leaseExpiresAt: "2026-10-10T00:03:00.000Z",
        sourceState,
      }),
    ).toEqual({ status: "lost", reason: "lease_expired" });
    expect(
      settleQqConversationTask(h.orm, {
        taskId: task.id,
        leaseToken: "short",
        at: "2026-10-10T00:02:00.000Z",
        outcome: "completed",
        sourceState,
      }),
    ).toBe(false);
  });

  it("prioritizes mention work and keeps registration FIFO at the same timestamp", () => {
    const h = setup();
    const s = scope(h, "20009");
    const ordinary = createQqConversationTask(
      h.orm,
      { ...ordinaryInput(h, s, "follow_up", "701"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const first = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "702"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const second = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "703"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const claim = (leaseToken: string) =>
      claimNextQqConversationTask(h.orm, {
        at: nowIso(),
        leaseToken,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        limitsFor: limits,
        sourceState,
        freezeAtClaim: freezeSnapshot,
      });
    expect(claim("fifo-1")?.task.id).toBe(first.id);
    expect(claim("fifo-2")?.task.id).toBe(second.id);
    expect(claim("fifo-3")?.task.id).toBe(ordinary.id);
  });

  it("retains task identity when referenced input or wake history is purged", () => {
    const h = setup();
    const s = scope(h, "20010");
    const mention = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "801"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const ordinary = createQqConversationTask(
      h.orm,
      { ...ordinaryInput(h, s, "idle_topic", "802"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    h.db.query("DELETE FROM qq_events WHERE event_key=?").run(mention.originEventKey);
    h.db.query("DELETE FROM wake_signals WHERE id=?").run(ordinary.originWakeId);
    expect(
      h.db
        .query("SELECT task_key,origin_event_key FROM qq_conversation_tasks WHERE id=?")
        .get(mention.id),
    ).toEqual({ task_key: mention.taskKey, origin_event_key: null });
    expect(
      h.db
        .query("SELECT task_key,origin_wake_id FROM qq_conversation_tasks WHERE id=?")
        .get(ordinary.id),
    ).toEqual({ task_key: ordinary.taskKey, origin_wake_id: null });
    expect(h.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("freezes a strict execution snapshot atomically and reuses it on lease recovery", () => {
    const h = setup();
    const s = scope(h, "20012");
    const created = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "902"), at: nowIso() },
      { validateSource: validateInput },
    );
    let freezeCalls = 0;
    const freezer = (
      transaction: Parameters<typeof freezeSnapshot>[0],
      task: Parameters<typeof freezeSnapshot>[1],
      taskLimits: Parameters<typeof freezeSnapshot>[2],
    ) => {
      freezeCalls += 1;
      return freezeSnapshot(transaction, task, taskLimits);
    };
    const first = claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "snapshot-lease-1",
      leaseExpiresAt: "2026-10-10T00:01:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezer,
    });
    expect(first?.task.executionSnapshot).not.toBeNull();
    expect(first?.task.claimedAt).toBe(nowIso());
    const original = first?.task.executionSnapshot;
    expect(freezeCalls).toBe(1);
    expect(() =>
      QqTaskExecutionSnapshotSchema.parse({
        ...JSON.parse(original!),
        providerApiKey: "not-allowed",
      }),
    ).toThrow();
    expect(
      recoverQqConversationTaskLease(h.orm, {
        taskId: created.task.id,
        leaseToken: "snapshot-lease-1",
        at: "2026-10-10T00:02:00.000Z",
        resolveExistingRunAndOutbox: () => "resume",
      }),
    ).toBe("resume");
    expect(
      h.db
        .query("SELECT status,execution_snapshot,claimed_at FROM qq_conversation_tasks WHERE id=?")
        .get(created.task.id),
    ).toMatchObject({ status: "pending", execution_snapshot: original, claimed_at: nowIso() });
    let sourceChecks = 0;
    let limitChecks = 0;
    const reclaimed = claimNextQqConversationTask(h.orm, {
      at: "2026-10-10T00:02:00.000Z",
      leaseToken: "snapshot-lease-2",
      leaseExpiresAt: "2026-10-10T00:03:00.000Z",
      limitsFor: () => {
        limitChecks += 1;
        return { mentionTaskLimit: 4, ordinaryTaskLimit: 1 };
      },
      sourceState: ((transaction, identity) => {
        sourceChecks += 1;
        return sourceState(transaction, identity);
      }) as QqConversationTaskSourceGuard,
      freezeAtClaim: freezer,
    });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.task.status).toBe("running");
    expect(reclaimed?.task.executionSnapshot).toBe(original);
    expect(reclaimed?.task.claimedAt).toBe(nowIso());
    expect(freezeCalls).toBe(1);
  });

  it("runs independent same-sender mention tasks concurrently and aborts only the cancelled owner", async () => {
    const h = setup();
    const s = scope(h, "20013");
    const first = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "903"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const second = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "904"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const started: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const scheduler = new QqTaskScheduler({
      orm: h.orm,
      policy: () => ({ leaseMs: 60_000, renewMs: 20_000 }),
      limitsFor: () => ({ mentionTaskLimit: 2, ordinaryTaskLimit: 1 }),
      sourceState,
      freezeAtClaim: freezeSnapshot,
      async activate(task, _snapshot, _lease, signal) {
        started.push(task.taskKey);
        signals.set(task.id, signal);
        return await new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
        });
      },
      resolveExistingRunAndOutbox: () => "failed",
      now: nowIso,
    });
    expect(await scheduler.dispatchOnce()).toBe(true);
    expect(await scheduler.dispatchOnce()).toBe(true);
    expect(started).toEqual([first.taskKey, second.taskKey]);
    expect(scheduler.activeCount).toBe(2);
    expect(scheduler.cancel(first.id)).toBe("requested");
    expect(signals.get(first.id)?.aborted).toBe(true);
    expect(signals.get(second.id)?.aborted).toBe(false);
    expect(scheduler.cancel(second.id)).toBe("requested");
    await scheduler.waitForIdle();
    expect(h.db.query("SELECT id,status FROM qq_conversation_tasks ORDER BY id").all()).toEqual(
      [
        { id: first.id, status: "cancelled" },
        { id: second.id, status: "cancelled" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(scheduler.activeCount).toBe(0);
  });

  it("preserves lease failure attribution without changing generic errors or terminal row states", async () => {
    const h = setup();
    const s = scope(h, "20014");
    const telemetry = new RuntimeTelemetry(h.db);
    try {
      for (const scenario of ["ordinary", "lease", "cancelled", "expired"] as const) {
        const task = createQqConversationTask(
          h.orm,
          { ...mentionInput(h, s, `reason-${scenario}`), at: nowIso() },
          { validateSource: validateInput },
        ).task;
        let expired = false;
        const errors: string[] = [];
        const scheduler = new QqTaskScheduler({
          orm: h.orm,
          telemetry,
          policy: () => ({ leaseMs: 60_000, renewMs: 20_000 }),
          limitsFor: limits,
          sourceState: (tx, identity) => (expired ? "expired" : sourceState(tx, identity)),
          freezeAtClaim: freezeSnapshot,
          async activate(_task, _snapshot, _lease, signal) {
            if (scenario === "cancelled") {
              return await new Promise<never>((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => reject(new DOMException("aborted", "AbortError")),
                  { once: true },
                );
              });
            }
            expired = scenario === "expired";
            if (scenario === "ordinary") throw new Error("unexpected activation failure");
            throw Object.assign(new Error("owner guard rejected the lease"), {
              code: "QQ_TASK_LEASE_LOST",
            });
          },
          resolveExistingRunAndOutbox: () => "failed",
          onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
          now: nowIso,
        });
        try {
          expect(await scheduler.dispatchOnce()).toBe(true);
          if (scenario === "cancelled") expect(scheduler.cancel(task.id)).toBe("requested");
          await scheduler.waitForIdle();
          const status = scenario === "cancelled" || scenario === "expired" ? scenario : "failed";
          const code =
            scenario === "lease"
              ? "QQ_TASK_LEASE_LOST"
              : scenario === "expired"
                ? "OPPORTUNITY_EXPIRED"
                : scenario === "cancelled"
                  ? "QQ_TASK_CANCELLED"
                  : "QQ_TASK_FAILED";
          expect(
            h.db
              .query("SELECT status,error_code,lease_token FROM qq_conversation_tasks WHERE id=?")
              .get(task.id),
          ).toEqual({
            status,
            error_code:
              scenario === "expired" ? "SOURCE_EXPIRED" : status === "failed" ? code : null,
            lease_token: null,
          });
          expect(
            h.db
              .query(
                "SELECT status,code FROM runtime_spans WHERE name='bot.task.activate' AND json_extract(details,'$.taskId')=?",
              )
              .get(task.id),
          ).toEqual({
            status: scenario === "expired" ? "skipped" : status,
            code,
          });
          expect(errors).toEqual(status === "failed" ? [code] : []);
          expect(scheduler.activeCount).toBe(0);
        } finally {
          scheduler.stop();
          await scheduler.waitForIdle();
        }
      }
    } finally {
      await telemetry.close();
    }
  });

  it("attributes a generic AbortError rejection to the cancellation reason without leaking messages", async () => {
    const h = setup();
    const s = scope(h, "20016");
    const task = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "abort-reason-lease"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const telemetry = new RuntimeTelemetry(h.db);
    const errors: string[] = [];
    const scheduler = new QqTaskScheduler({
      orm: h.orm,
      telemetry,
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
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
      now: nowIso,
    });
    try {
      expect(await scheduler.dispatchOnce()).toBe(true);
      expect(scheduler.cancel(task.id)).toBe("requested");
      await scheduler.waitForIdle();
      expect(
        h.db
          .query("SELECT status,error_code,lease_token FROM qq_conversation_tasks WHERE id=?")
          .get(task.id),
      ).toEqual({
        status: "cancelled",
        error_code: null,
        lease_token: null,
      });
      expect(
        h.db
          .query(
            "SELECT status,code FROM runtime_spans WHERE name='bot.task.activate' AND json_extract(details,'$.taskId')=?",
          )
          .get(task.id),
      ).toEqual({
        status: "cancelled",
        code: "QQ_TASK_CANCELLED",
      });
      expect(errors).toEqual([]);
      expect(scheduler.activeCount).toBe(0);
    } finally {
      scheduler.stop();
      await scheduler.waitForIdle();
      await telemetry.close();
    }
  });

  it("records renewal loss reason and duration before aborting the owner", async () => {
    const h = setup();
    const s = scope(h, "renewal-span");
    const task = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "renewal-span"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const telemetry = new RuntimeTelemetry(h.db);
    let abortReason: unknown;
    const scheduler = new QqTaskScheduler({
      orm: h.orm,
      telemetry,
      policy: () => ({ leaseMs: 60_000, renewMs: 1 }),
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
      async activate(_task, _snapshot, _lease, signal) {
        h.db
          .query("UPDATE qq_conversation_tasks SET lease_token='other-owner' WHERE id=?")
          .run(task.id);
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              abortReason = signal.reason;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      resolveExistingRunAndOutbox: () => "failed",
      now: nowIso,
    });
    try {
      expect(await scheduler.dispatchOnce()).toBe(true);
      await scheduler.waitForIdle();
      const row = h.db
        .query(
          "SELECT status,code,details FROM runtime_spans WHERE name='bot.task.activate' AND json_extract(details,'$.taskId')=?",
        )
        .get(task.id) as { status: string; code: string; details: string };
      const details = JSON.parse(row.details);
      expect(row.status).toBe("failed");
      expect(row.code).toBe("QQ_TASK_LEASE_LOST");
      expect(details).toMatchObject({
        leaseRenewals: 0,
        leaseRenewalAttempts: 1,
        lastReason: "token_mismatch",
      });
      expect(typeof details.lastDurationMs).toBe("number");
      expect(details.lastDurationMs).toBeGreaterThanOrEqual(0);
      expect(abortReason).toMatchObject({
        message: "QQ_TASK_LEASE_LOST",
        code: "QQ_TASK_LEASE_LOST",
        details: { reason: "token_mismatch" },
      });
      expect(scheduler.activeCount).toBe(0);
    } finally {
      scheduler.stop();
      await scheduler.waitForIdle();
      await telemetry.close();
    }
  });

  it("records zero renewal successes and attempts when activation fails before the first tick", async () => {
    const h = setup();
    const s = scope(h, "20015");
    const task = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "before-renewal-tick"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const telemetry = new RuntimeTelemetry(h.db);
    let initialDetails: Record<string, unknown> | undefined;
    let sinkPresent = false;
    let measured = 0;
    const scheduler = new QqTaskScheduler({
      orm: h.orm,
      telemetry,
      policy: () => ({ leaseMs: 60_000, renewMs: 20_000 }),
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
      async activate(
        ...args: [
          ...Parameters<ConstructorParameters<typeof QqTaskScheduler>[0]["activate"]>,
          ((timings: { authorityLeaseChecks?: number; authorityLeaseMs?: number }) => void)?,
        ]
      ) {
        const sink = args[4];
        sinkPresent = typeof sink === "function";
        const row = h.db
          .query(
            "SELECT details FROM runtime_spans WHERE name='bot.task.activate' AND json_extract(details,'$.taskId')=?",
          )
          .get(task.id) as { details: string };
        initialDetails = JSON.parse(row.details);
        const started = performance.now();
        try {
          await Promise.resolve();
        } finally {
          measured = performance.now() - started;
          sink?.({ authorityLeaseChecks: 1, authorityLeaseMs: measured });
        }
        throw new Error("failed before renewal tick");
      },
      resolveExistingRunAndOutbox: () => "failed",
      now: nowIso,
    });
    try {
      expect(await scheduler.runOnce()).toBe(true);
      await scheduler.waitForIdle();
      expect(initialDetails).toMatchObject({ leaseRenewals: 0, leaseRenewalAttempts: 0 });
      const row = h.db
        .query(
          "SELECT status,code,details FROM runtime_spans WHERE name='bot.task.activate' AND json_extract(details,'$.taskId')=?",
        )
        .get(task.id) as { status: string; code: string; details: string };
      expect(row.status).toBe("failed");
      expect(row.code).toBe("QQ_TASK_FAILED");
      expect(JSON.parse(row.details)).toMatchObject({
        leaseRenewals: 0,
        leaseRenewalAttempts: 0,
        state: "failed",
      });
      expect(scheduler.activeCount).toBe(0);
      expect(sinkPresent).toBe(true);
      const metrics = JSON.parse(row.details) as Record<string, unknown>;
      expect(metrics.authorityLeaseChecks).toBe(1);
      expect(metrics.authorityLeaseMs).toBe(measured);
      expect(Number.isFinite(metrics.authorityLeaseMs)).toBe(true);
      expect(Number(metrics.authorityLeaseMs)).toBeGreaterThanOrEqual(0);
      expect(metrics.authorityConfigurationChecks).toBeUndefined();
      expect(metrics.authorityDetailChecks).toBeUndefined();
    } finally {
      scheduler.stop();
      await scheduler.waitForIdle();
      await telemetry.close();
    }
  });

  it("rolls back the judged marker when committing the judgement fails", () => {
    const h = setup();
    const s = scope(h, "20011");
    const task = createQqConversationTask(
      h.orm,
      { ...ordinaryInput(h, s, "chiming_in", "901"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "judge-atomic",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
    });
    expect(() =>
      markQqConversationTaskJudgementDone(h.orm, {
        taskId: task.id,
        leaseToken: "judge-atomic",
        at: nowIso(),
        sourceState,
        markJudged: () => {
          s.journal.markChimingInJudged(s.conversation.id, task.sourceThroughSeq, nowIso());
          throw new Error("commit rejected");
        },
      }),
    ).toThrow("commit rejected");
    expect(
      h.db.query("SELECT judgement_done FROM qq_conversation_tasks WHERE id=?").get(task.id),
    ).toEqual({ judgement_done: 0 });
    expect(
      h.db
        .query("SELECT chiming_in_observed_seq FROM conversations WHERE id=?")
        .get(s.conversation.id),
    ).toEqual({ chiming_in_observed_seq: 0 });
  });
});
