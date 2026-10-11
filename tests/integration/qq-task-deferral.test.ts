import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QqTaskScheduler } from "../../src/server/conversation/qq-task-scheduler";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  cancelQqConversationTask,
  claimNextQqConversationTask,
  createQqConversationTask,
  deferQqConversationTask,
  type QqConversationTaskSourceGuard,
  recoverQqConversationTaskLease,
  settleQqConversationTask,
} from "../../src/server/db/qq-task-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
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
  const event = inbound(h, s, messageId, `evt-${s.bindingId}-${messageId}`);
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
    maxSteps: 8,
    deliveryTtlSeconds: 900,
    mentionTaskLimit: limits.mentionTaskLimit,
    ordinaryTaskLimit: limits.ordinaryTaskLimit,
    taskKey: task.taskKey,
  });
}

describe("QQ conversation task deferral and cancel recovery", () => {
  it("defers a running task to a future ready_at and reclaims the same task with the frozen snapshot", () => {
    const h = setup();
    const s = scope(h, "20021");
    const created = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "701"), at: nowIso() },
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
    const claimed = claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "lease-defer-1",
      leaseExpiresAt: "2026-10-10T00:01:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezer,
    });
    expect(claimed?.task.id).toBe(created.task.id);
    expect(claimed?.task.claimedAt).toBe(nowIso());
    const frozenSnapshot = claimed?.task.executionSnapshot;
    expect(frozenSnapshot).not.toBeNull();

    expect(
      deferQqConversationTask(h.orm, {
        taskId: created.task.id,
        leaseToken: "lease-defer-1",
        at: nowIso(),
        readyAt: "2026-10-10T00:05:00.000Z",
        sourceState,
      }),
    ).toBe(true);

    const deferredRow = h.db
      .query(
        "SELECT status,ready_at,lease_token,lease_expires_at,claimed_at,execution_snapshot,cancellation_requested FROM qq_conversation_tasks WHERE id=?",
      )
      .get(created.task.id) as Record<string, unknown>;
    expect(deferredRow).toMatchObject({
      status: "pending",
      ready_at: "2026-10-10T00:05:00.000Z",
      lease_token: null,
      lease_expires_at: null,
      claimed_at: nowIso(),
      cancellation_requested: 0,
    });
    expect(deferredRow.execution_snapshot).toBe(frozenSnapshot);

    // before the deferred ready time the task must not be claimable
    expect(
      claimNextQqConversationTask(h.orm, {
        at: "2026-10-10T00:01:00.000Z",
        leaseToken: "lease-defer-early",
        leaseExpiresAt: "2026-10-10T00:02:00.000Z",
        limitsFor: limits,
        sourceState,
        freezeAtClaim: freezer,
      }),
    ).toBeNull();

    const reclaimed = claimNextQqConversationTask(h.orm, {
      at: "2026-10-10T00:06:00.000Z",
      leaseToken: "lease-defer-2",
      leaseExpiresAt: "2026-10-10T00:07:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezer,
    });
    expect(reclaimed?.task.id).toBe(created.task.id);
    expect(reclaimed?.task.status).toBe("running");
    expect(reclaimed?.task.leaseToken).toBe("lease-defer-2");
    expect(reclaimed?.task.claimedAt).toBe(nowIso());
    expect(reclaimed?.task.executionSnapshot).toBe(frozenSnapshot);
    const parsed = QqTaskExecutionSnapshotSchema.parse(JSON.parse(String(frozenSnapshot)));
    expect(parsed.maxSteps).toBe(8);
    expect(parsed.authorizedTargets).toStrictEqual(["same-sender"]);
    expect(parsed.taskKey).toBe(created.task.taskKey);
    expect(freezeCalls).toBe(1);
  });

  it("carries a deferred ready_at through a file-backed database restart on the current schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "qq-task-deferral-restart-"));
    const dbPath = join(dir, "business.db");
    const first = openBusinessDb({ path: dbPath });
    ensureDefaults(first.orm, "test-model");
    const s = scope(first, "20022");
    const created = createQqConversationTask(
      first.orm,
      { ...mentionInput(first, s, "702"), at: nowIso() },
      { validateSource: validateInput },
    );
    claimNextQqConversationTask(first.orm, {
      at: nowIso(),
      leaseToken: "lease-restart-1",
      leaseExpiresAt: "2026-10-10T00:01:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
    });
    expect(
      deferQqConversationTask(first.orm, {
        taskId: created.task.id,
        leaseToken: "lease-restart-1",
        at: nowIso(),
        readyAt: "2026-10-10T00:05:00.000Z",
        sourceState,
      }),
    ).toBe(true);
    const snapshotBefore = (
      first.db
        .query("SELECT execution_snapshot FROM qq_conversation_tasks WHERE id=?")
        .get(created.task.id) as { execution_snapshot: string }
    ).execution_snapshot;
    first.close();

    const reopened = openBusinessDb({ path: dbPath });
    const row = reopened.db
      .query(
        "SELECT status,ready_at,claimed_at,execution_snapshot FROM qq_conversation_tasks WHERE id=?",
      )
      .get(created.task.id) as Record<string, unknown>;
    expect(row).toMatchObject({
      status: "pending",
      ready_at: "2026-10-10T00:05:00.000Z",
      claimed_at: nowIso(),
    });
    expect(row.execution_snapshot).toBe(snapshotBefore);
    const reclaimed = claimNextQqConversationTask(reopened.orm, {
      at: "2026-10-10T00:06:00.000Z",
      leaseToken: "lease-restart-2",
      leaseExpiresAt: "2026-10-10T00:07:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
    });
    expect(reclaimed?.task.id).toBe(created.task.id);
    expect(reclaimed?.task.executionSnapshot).toBe(snapshotBefore);
    reopened.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps the temp dir briefly locked after close; the unique tmpdir is disposable.
    }
  });

  it("rejects a wrong lease, terminalizes a cancel-requested owner against deferral, and types invalid readyAt", () => {
    const h = setup();
    const s = scope(h, "20023");
    const created = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "703"), at: nowIso() },
      { validateSource: validateInput },
    );
    claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "lease-own",
      leaseExpiresAt: "2026-10-10T00:01:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
    });

    expect(
      deferQqConversationTask(h.orm, {
        taskId: created.task.id,
        leaseToken: "lease-wrong",
        at: nowIso(),
        readyAt: "2026-10-10T00:05:00.000Z",
        sourceState,
      }),
    ).toBe(false);

    let invalidReadyAt: unknown;
    expect(() => {
      invalidReadyAt = {
        taskId: created.task.id,
        leaseToken: "lease-own",
        at: nowIso(),
        readyAt: "not-a-timestamp",
        sourceState,
      };
      deferQqConversationTask(
        h.orm,
        invalidReadyAt as Parameters<typeof deferQqConversationTask>[1],
      );
    }).toThrow(TypeError);
    // A finite equal/past readyAt is accepted: the host clock may pass between prepare and the
    // defer CAS, so the exact deadline is preserved and the task is immediately claimable.
    expect(
      deferQqConversationTask(h.orm, {
        taskId: created.task.id,
        leaseToken: "lease-own",
        at: nowIso(),
        readyAt: nowIso(),
        sourceState,
      }),
    ).toBe(true);
    expect(
      h.db
        .query(
          "SELECT status,ready_at,lease_token,lease_expires_at FROM qq_conversation_tasks WHERE id=?",
        )
        .get(created.task.id),
    ).toMatchObject({
      status: "pending",
      ready_at: nowIso(),
      lease_token: null,
      lease_expires_at: null,
    });
    const reclaimedPast = claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "lease-own-past",
      leaseExpiresAt: "2026-10-10T00:01:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
    });
    expect(reclaimedPast?.task.id).toBe(created.task.id);

    expect(cancelQqConversationTask(h.orm, { taskId: created.task.id, at: nowIso() })).toBe(
      "requested",
    );
    expect(
      deferQqConversationTask(h.orm, {
        taskId: created.task.id,
        leaseToken: "lease-own-past",
        at: nowIso(),
        readyAt: "2026-10-10T00:05:00.000Z",
        sourceState,
      }),
    ).toBe(false);
    expect(
      h.db
        .query("SELECT status,cancellation_requested FROM qq_conversation_tasks WHERE id=?")
        .get(created.task.id),
    ).toMatchObject({ status: "running", cancellation_requested: 1 });
  });

  it("terminalizes an expired source before its deferred ready time even with a valid guard", () => {
    const h = setup();
    const s = scope(h, "20024");
    const created = createQqConversationTask(
      h.orm,
      {
        ...mentionInput(h, s, "704"),
        at: nowIso(),
        sourceExpiresAt: "2026-10-10T00:03:00.000Z",
      },
      { validateSource: validateInput },
    );
    expect(created.task.sourceExpiresAt).toBe("2026-10-10T00:03:00.000Z");
    claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "lease-ttl-1",
      leaseExpiresAt: "2026-10-10T00:01:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
    });
    expect(
      deferQqConversationTask(h.orm, {
        taskId: created.task.id,
        leaseToken: "lease-ttl-1",
        at: nowIso(),
        readyAt: "2026-10-10T00:10:00.000Z",
        sourceState,
      }),
    ).toBe(true);

    expect(
      claimNextQqConversationTask(h.orm, {
        at: "2026-10-10T00:04:00.000Z",
        leaseToken: "lease-ttl-2",
        leaseExpiresAt: "2026-10-10T00:05:00.000Z",
        limitsFor: limits,
        sourceState,
        freezeAtClaim: freezeSnapshot,
      }),
    ).toBeNull();
    expect(
      h.db
        .query("SELECT status,error_code,ready_at FROM qq_conversation_tasks WHERE id=?")
        .get(created.task.id),
    ).toMatchObject({
      status: "expired",
      error_code: "SOURCE_EXPIRED",
      ready_at: "2026-10-10T00:10:00.000Z",
    });
  });

  it("claims mention before ordinary FIFO across repeated claim and settle cycles without native finalize errors", () => {
    const h = setup();
    const first = scope(h, "20025");
    const second = scope(h, "20026");
    const mentionA = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, first, "705"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const mentionB = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, second, "706"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const ordinaryA = createQqConversationTask(
      h.orm,
      { ...ordinaryInput(h, first, "follow_up", "707"), at: nowIso() },
      { validateSource: validateInput },
    ).task;
    const ordinaryB = createQqConversationTask(
      h.orm,
      { ...ordinaryInput(h, second, "idle_topic", "708"), at: nowIso() },
      { validateSource: validateInput },
    ).task;

    const claimedIds: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const claimed = claimNextQqConversationTask(h.orm, {
        at: nowIso(),
        leaseToken: `lease-fifo-${round}`,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        limitsFor: limits,
        sourceState,
        freezeAtClaim: freezeSnapshot,
      });
      if (!claimed) break;
      claimedIds.push(claimed.task.id);
      expect(
        settleQqConversationTask(h.orm, {
          taskId: claimed.task.id,
          leaseToken: `lease-fifo-${round}`,
          at: nowIso(),
          outcome: "completed",
          sourceState,
        }),
      ).toBe("completed");
    }
    expect(claimedIds).toStrictEqual([mentionA.id, mentionB.id, ordinaryA.id, ordinaryB.id]);
    const statuses = h.db.query("SELECT id,status FROM qq_conversation_tasks").all() as {
      id: string;
      status: string;
    }[];
    for (const row of statuses) expect(row.status).toBe("completed");
  });

  it("recovers an expired lease with cancellation requested as terminal cancelled and never calls the resolver", () => {
    const h = setup();
    const s = scope(h, "20027");
    const created = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "709"), at: nowIso() },
      { validateSource: validateInput },
    );
    const claimed = claimNextQqConversationTask(h.orm, {
      at: nowIso(),
      leaseToken: "lease-cancel",
      leaseExpiresAt: "2026-10-10T00:01:00.000Z",
      limitsFor: limits,
      sourceState,
      freezeAtClaim: freezeSnapshot,
    });
    const snapshotBefore = claimed?.task.executionSnapshot;
    expect(cancelQqConversationTask(h.orm, { taskId: created.task.id, at: nowIso() })).toBe(
      "requested",
    );

    let resolverCalls = 0;
    expect(
      recoverQqConversationTaskLease(h.orm, {
        taskId: created.task.id,
        leaseToken: "lease-cancel",
        at: "2026-10-10T00:02:00.000Z",
        resolveExistingRunAndOutbox: () => {
          resolverCalls += 1;
          return "resume";
        },
      }),
    ).toBe("cancelled");
    expect(resolverCalls).toBe(0);
    expect(
      h.db
        .query(
          "SELECT status,cancellation_requested,lease_token,lease_expires_at,finished_at,execution_snapshot FROM qq_conversation_tasks WHERE id=?",
        )
        .get(created.task.id),
    ).toMatchObject({
      status: "cancelled",
      cancellation_requested: 0,
      lease_token: null,
      lease_expires_at: null,
      finished_at: "2026-10-10T00:02:00.000Z",
      execution_snapshot: snapshotBefore,
    });
    expect(
      claimNextQqConversationTask(h.orm, {
        at: "2026-10-10T00:03:00.000Z",
        leaseToken: "lease-after-cancel",
        leaseExpiresAt: "2026-10-10T00:04:00.000Z",
        limitsFor: limits,
        sourceState,
        freezeAtClaim: freezeSnapshot,
      }),
    ).toBeNull();
  });

  it("keeps a task pending with its exact ready_at when the host clock passes the deadline during activation", async () => {
    const h = setup();
    const s = scope(h, "20028");
    const created = createQqConversationTask(
      h.orm,
      { ...mentionInput(h, s, "710"), at: nowIso() },
      { validateSource: validateInput },
    );
    // Controlled clock: activation starts at :00.900, the deferred deadline is :01.000, and the
    // clock is :01.100 (past readyAt) by the time activate returns. No timer, no global patch.
    let nowMs = Date.parse("2026-10-10T00:00:00.900Z");
    const controlledNow = () => new Date(nowMs).toISOString();
    let freezeCalls = 0;
    let activations = 0;
    const scheduler = new QqTaskScheduler({
      orm: h.orm,
      policy: () => ({ leaseMs: 60_000, renewMs: 20_000 }),
      limitsFor: limits,
      sourceState,
      freezeAtClaim: (transaction, task, taskLimits) => {
        freezeCalls += 1;
        return freezeSnapshot(transaction, task, taskLimits);
      },
      activate: async () => {
        activations += 1;
        if (activations === 1) {
          nowMs = Date.parse("2026-10-10T00:00:01.100Z");
          return { status: "deferred", readyAt: "2026-10-10T00:00:01.000Z", reason: "not_yet_due" };
        }
        return { status: "completed" };
      },
      resolveExistingRunAndOutbox: () => "resume",
      now: controlledNow,
    });
    expect(await scheduler.runOnce()).toBe(true);
    expect(freezeCalls).toBe(1);
    expect(
      h.db
        .query(
          "SELECT status,ready_at,claimed_at,execution_snapshot,lease_token,error_code FROM qq_conversation_tasks WHERE id=?",
        )
        .get(created.task.id),
    ).toMatchObject({
      status: "pending",
      ready_at: "2026-10-10T00:00:01.000Z",
      claimed_at: "2026-10-10T00:00:00.900Z",
    });
    const row = h.db
      .query("SELECT execution_snapshot,claimed_at FROM qq_conversation_tasks WHERE id=?")
      .get(created.task.id) as { execution_snapshot: string; claimed_at: string };
    expect(row.execution_snapshot).not.toBeNull();
    expect(QqTaskExecutionSnapshotSchema.parse(JSON.parse(row.execution_snapshot)).taskKey).toBe(
      created.task.taskKey,
    );
    expect(scheduler.activeCount).toBe(0);
    expect(await scheduler.runOnce()).toBe(true);
    // the second claim reuses the snapshot frozen at first claim; no refreeze
    expect(freezeCalls).toBe(1);
    expect(activations).toBe(2);
    expect(
      h.db
        .query("SELECT status,claimed_at,finished_at FROM qq_conversation_tasks WHERE id=?")
        .get(created.task.id),
    ).toMatchObject({
      status: "completed",
      claimed_at: "2026-10-10T00:00:00.900Z",
      finished_at: "2026-10-10T00:00:01.100Z",
    });
    await scheduler.stop();
  });
});
