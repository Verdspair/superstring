import type { Database } from "bun:sqlite";
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type {
  QqConversationTaskCause,
  QqConversationTaskClass,
  QqConversationTaskLimits,
  QqConversationTaskStatus,
  QqTaskExecutionSnapshot,
} from "../../shared/contracts/qq-task";
import {
  QQ_CONVERSATION_TASK_STATUS,
  QqTaskExecutionSnapshotSchema,
  resolveQqConversationTaskLimits,
} from "../../shared/contracts/qq-task";
import { newId, type Orm } from "./repositories";
import * as schema from "./schema";

export type QqConversationTaskRow = typeof schema.qqConversationTasks.$inferSelect;
export type QqConversationTaskOutcome = Extract<
  QqConversationTaskStatus,
  "completed" | "no_output" | "failed" | "cancelled" | "expired"
>;
export type QqConversationTaskSourceState = "valid" | "expired" | "revoked";
export type QqConversationTaskRecovery = "resume" | QqConversationTaskOutcome;

export type QqConversationTaskIdentity = {
  taskKey: string;
  conversationId: string;
  bindingEpoch: number;
  agentId: string;
  taskClass: QqConversationTaskClass;
  cause: QqConversationTaskCause;
  sourceFromSeq: number;
  sourceThroughSeq: number;
  originWakeId?: string | null;
  originEventKey?: string | null;
  platformMessageId?: string | null;
};

export type QqConversationTaskSourceGuard = (
  transaction: Orm,
  identity: Readonly<QqConversationTaskIdentity>,
) => QqConversationTaskSourceState;

export interface CreateQqConversationTaskInput extends QqConversationTaskIdentity {
  at?: string;
  sourceExpiresAt?: string | null;
  wakeLeaseToken?: string;
}

function clientOf(orm: Orm): Database {
  return (orm as unknown as { $client: Database }).$client;
}

function immediate<T>(orm: Orm, work: (transaction: Orm) => T): T {
  const db = clientOf(orm);
  return db.transaction(() => work(orm)).immediate();
}

function currentRow(orm: Orm, id: string): QqConversationTaskRow | null {
  return (
    orm
      .select()
      .from(schema.qqConversationTasks)
      .where(eq(schema.qqConversationTasks.id, id))
      .get() ?? null
  );
}

function identityOf(task: QqConversationTaskRow): QqConversationTaskIdentity {
  return {
    taskKey: task.taskKey,
    conversationId: task.conversationId,
    bindingEpoch: task.bindingEpoch,
    agentId: task.agentId,
    taskClass: task.taskClass as QqConversationTaskClass,
    cause: task.cause as QqConversationTaskCause,
    sourceFromSeq: task.sourceFromSeq,
    sourceThroughSeq: task.sourceThroughSeq,
    originWakeId: task.originWakeId,
    originEventKey: task.originEventKey,
    platformMessageId: task.platformMessageId,
  };
}

function requireSourceState(
  guard: QqConversationTaskSourceGuard,
  orm: Orm,
  identity: Readonly<QqConversationTaskIdentity>,
): QqConversationTaskSourceState {
  return guard(orm, identity);
}

function terminalizeSource(
  orm: Orm,
  task: QqConversationTaskRow,
  state: QqConversationTaskSourceState,
  at: string,
): QqConversationTaskRow | null {
  if (state === "valid") return task;
  const outcome = state === "expired" ? "expired" : "cancelled";
  return (
    orm
      .update(schema.qqConversationTasks)
      .set({
        status: outcome,
        leaseToken: null,
        leaseExpiresAt: null,
        cancellationRequested: 0,
        finishedAt: at,
        updatedAt: at,
        errorCode: state === "expired" ? "SOURCE_EXPIRED" : "SOURCE_AUTHORITY_REVOKED",
      })
      .where(
        and(
          eq(schema.qqConversationTasks.id, task.id),
          inArray(schema.qqConversationTasks.status, ["pending", "running"]),
        ),
      )
      .returning()
      .get() ?? null
  );
}

function validateInput(input: CreateQqConversationTaskInput): QqConversationTaskIdentity {
  if (!Number.isFinite(Date.parse(input.at ?? new Date().toISOString()))) {
    throw new TypeError("Invalid QQ conversation task timestamp");
  }
  if (
    input.sourceExpiresAt !== undefined &&
    input.sourceExpiresAt !== null &&
    !Number.isFinite(Date.parse(input.sourceExpiresAt))
  ) {
    throw new TypeError("Invalid QQ conversation task source expiry");
  }
  if (
    !Number.isSafeInteger(input.bindingEpoch) ||
    input.bindingEpoch < 1 ||
    !Number.isSafeInteger(input.sourceFromSeq) ||
    input.sourceFromSeq < 0 ||
    !Number.isSafeInteger(input.sourceThroughSeq) ||
    input.sourceThroughSeq < input.sourceFromSeq ||
    !input.taskKey.trim() ||
    !input.conversationId.trim() ||
    !input.agentId.trim()
  ) {
    throw new TypeError("Invalid QQ conversation task identity");
  }
  if (input.taskClass === "mention") {
    if (
      input.cause !== "direct_reply" ||
      !input.originEventKey?.trim() ||
      !input.platformMessageId?.trim() ||
      input.originWakeId
    ) {
      throw new TypeError("A mention task requires one direct-reply platform event");
    }
    const keyParts = input.taskKey.startsWith("qq-task:")
      ? (JSON.parse(input.taskKey.slice("qq-task:".length)) as unknown)
      : null;
    if (
      !Array.isArray(keyParts) ||
      keyParts.length !== 6 ||
      keyParts[0] !== "mention" ||
      keyParts[2] !== input.conversationId ||
      keyParts[3] !== String(input.bindingEpoch) ||
      keyParts[4] !== input.platformMessageId ||
      keyParts[5] !== input.agentId ||
      typeof keyParts[1] !== "string" ||
      !keyParts[1].trim()
    ) {
      throw new TypeError("Invalid QQ mention task key");
    }
  } else if (
    !input.originWakeId?.trim() ||
    !input.wakeLeaseToken?.trim() ||
    input.originEventKey ||
    input.platformMessageId
  ) {
    throw new TypeError("An ordinary task requires its leased wake handoff");
  }
  return {
    taskKey: input.taskKey,
    conversationId: input.conversationId,
    bindingEpoch: input.bindingEpoch,
    agentId: input.agentId,
    taskClass: input.taskClass,
    cause: input.cause,
    sourceFromSeq: input.sourceFromSeq,
    sourceThroughSeq: input.sourceThroughSeq,
    originWakeId: input.originWakeId ?? null,
    originEventKey: input.originEventKey ?? null,
    platformMessageId: input.platformMessageId ?? null,
  };
}

function scopeIsCurrent(orm: Orm, identity: Readonly<QqConversationTaskIdentity>): boolean {
  const row = clientOf(orm)
    .query(`SELECT 1 AS ok FROM conversations c
    JOIN qq_bindings b ON b.id=c.source_id
    WHERE c.id=? AND c.channel='onebot11' AND c.binding_epoch=? AND c.agent_id=?
      AND c.closed_at IS NULL AND b.agent_id=c.agent_id`)
    .get(identity.conversationId, identity.bindingEpoch, identity.agentId) as { ok: number } | null;
  return row !== null;
}

function sourceStateOrTerminalize(
  orm: Orm,
  task: QqConversationTaskRow,
  guard: QqConversationTaskSourceGuard,
  at: string,
): { task: QqConversationTaskRow | null; state: QqConversationTaskSourceState } {
  const identity = identityOf(task);
  if (!scopeIsCurrent(orm, identity))
    return { task: terminalizeSource(orm, task, "revoked", at), state: "revoked" };
  const state = requireSourceState(guard, orm, identity);
  return { task: terminalizeSource(orm, task, state, at), state };
}

function assertSameIdentity(
  row: QqConversationTaskRow,
  identity: QqConversationTaskIdentity,
): void {
  const current = identityOf(row);
  const fields: (keyof QqConversationTaskIdentity)[] = [
    "taskKey",
    "conversationId",
    "bindingEpoch",
    "agentId",
    "taskClass",
    "cause",
    "sourceFromSeq",
    "sourceThroughSeq",
    "originWakeId",
    "originEventKey",
    "platformMessageId",
  ];
  if (fields.some((field) => current[field] !== identity[field])) {
    throw new Error("QQ_TASK_IDENTITY_CONFLICT");
  }
}

export function createQqConversationTask(
  orm: Orm,
  input: CreateQqConversationTaskInput,
  options: { validateSource: QqConversationTaskSourceGuard },
): { readonly task: QqConversationTaskRow; readonly created: boolean } {
  const identity = validateInput(input);
  const at = input.at ?? new Date().toISOString();
  if (!options?.validateSource) throw new TypeError("QQ task source validation is required");
  return immediate(orm, (tx) => {
    if (!scopeIsCurrent(tx, identity)) throw new Error("QQ_TASK_SCOPE_STALE");
    const state = requireSourceState(options.validateSource, tx, identity);
    if (state !== "valid")
      throw new Error(state === "expired" ? "QQ_TASK_SOURCE_EXPIRED" : "QQ_TASK_SOURCE_REVOKED");
    if (input.sourceExpiresAt && Date.parse(input.sourceExpiresAt) <= Date.parse(at))
      throw new Error("QQ_TASK_SOURCE_EXPIRED");
    const existing = tx
      .select()
      .from(schema.qqConversationTasks)
      .where(eq(schema.qqConversationTasks.taskKey, identity.taskKey))
      .get();
    if (existing) {
      assertSameIdentity(existing, identity);
      return { task: existing, created: false };
    }
    if (identity.taskClass === "mention") {
      const parts = JSON.parse(identity.taskKey.slice("qq-task:".length)) as string[];
      const event = clientOf(tx)
        .query(`SELECT e.message_id,e.account_id,e.peer_id,e.agent_id
        FROM qq_events e JOIN conversations c ON c.id=? JOIN qq_bindings b ON b.id=c.source_id
        JOIN conversation_events ce ON ce.conversation_id=c.id AND ce.source_kind='qq_event' AND ce.source_id=e.event_key
        WHERE e.event_key=? AND e.message_id=? AND e.agent_id=? AND e.account_id=b.account_id
          AND e.account_id=? AND e.peer_id=b.peer_id AND e.conversation_kind=b.conversation_kind
          AND ce.seq=?`)
        .get(
          identity.conversationId,
          identity.originEventKey ?? null,
          identity.platformMessageId ?? null,
          identity.agentId,
          parts[1],
          identity.sourceThroughSeq,
        );
      if (!event) throw new Error("QQ_TASK_MENTION_SOURCE_MISMATCH");
    } else {
      const wake = clientOf(tx)
        .query(`SELECT 1 AS ok FROM wake_signals w
        WHERE w.id=? AND w.conversation_id=? AND w.cause=? AND w.through_seq>=?
          AND w.status='leased' AND w.lease_token=? AND w.transferred_task_id IS NULL`)
        .get(
          identity.originWakeId ?? null,
          identity.conversationId,
          identity.cause,
          identity.sourceThroughSeq,
          input.wakeLeaseToken ?? null,
        );
      if (!wake) throw new Error("QQ_TASK_WAKE_NOT_TRANSFERRED");
    }
    const row = tx
      .insert(schema.qqConversationTasks)
      .values({
        id: newId(),
        ...identity,
        sourceExpiresAt: input.sourceExpiresAt ?? null,
        status: "pending",
        judgementDone: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        cancellationRequested: 0,
        createdAt: at,
        updatedAt: at,
        finishedAt: null,
        errorCode: null,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (row) {
      if (identity.taskClass === "ordinary") {
        const transferred = clientOf(tx)
          .query(`UPDATE wake_signals SET status='completed',lease_token=NULL,lease_expires_at=NULL,completed_at=?,transferred_task_id=?
          WHERE id=? AND status='leased' AND lease_token=? AND transferred_task_id IS NULL`)
          .run(at, row.id, identity.originWakeId ?? null, input.wakeLeaseToken ?? null).changes;
        if (transferred !== 1) throw new Error("QQ_TASK_WAKE_TRANSFER_LOST");
      }
      return { task: row, created: true };
    }
    const raced = tx
      .select()
      .from(schema.qqConversationTasks)
      .where(eq(schema.qqConversationTasks.taskKey, identity.taskKey))
      .get();
    if (!raced) throw new Error("QQ_TASK_REGISTRATION_FAILED");
    assertSameIdentity(raced, identity);
    return { task: raced, created: false };
  });
}

export function claimNextQqConversationTask(
  orm: Orm,
  input: {
    at: string;
    leaseToken: string;
    leaseExpiresAt: string;
    limitsFor: (identity: Readonly<QqConversationTaskIdentity>) => QqConversationTaskLimits;
    sourceState: QqConversationTaskSourceGuard;
    resourceGate?: (task: Readonly<QqConversationTaskRow>) => boolean;
    freezeAtClaim: (
      transaction: Orm,
      task: Readonly<QqConversationTaskRow>,
      limits: Readonly<QqConversationTaskLimits>,
    ) => QqTaskExecutionSnapshot;
  },
): {
  readonly task: QqConversationTaskRow;
  readonly conversationId: string;
  readonly leaseToken: string;
} | null {
  if (
    !Number.isFinite(Date.parse(input.at)) ||
    !Number.isFinite(Date.parse(input.leaseExpiresAt)) ||
    Date.parse(input.leaseExpiresAt) <= Date.parse(input.at) ||
    input.leaseToken.trim().length === 0
  ) {
    throw new TypeError("Invalid QQ conversation task lease");
  }
  if (!input.limitsFor || !input.sourceState || !input.freezeAtClaim)
    throw new TypeError("QQ task claim guards and snapshot freezer are required");
  return immediate(orm, (tx) => {
    const limitsByConversation = new Map<string, QqConversationTaskLimits>();
    // ready_at NULL=initial ready；future-ready 未到期不扫，仅 source TTL 已过的才及时进入
    // 收敛（进入循环后先 terminalize expired）；cancellation_requested=1 的 pending 不启动。
    const candidateStatement = clientOf(tx).prepare<
      { id: string },
      [string, string]
    >(`SELECT id FROM qq_conversation_tasks
      WHERE status='pending' AND cancellation_requested=0
        AND (ready_at IS NULL OR ready_at<=?
        OR (source_expires_at IS NOT NULL AND source_expires_at<=?))
      ORDER BY CASE WHEN task_class='mention' THEN 0 ELSE 1 END,rowid`);
    const candidates = candidateStatement.iterate(input.at, input.at);
    try {
      for (const { id } of candidates) {
        const candidate = tx
          .select()
          .from(schema.qqConversationTasks)
          .where(eq(schema.qqConversationTasks.id, id))
          .get();
        if (candidate?.status !== "pending" || candidate.cancellationRequested !== 0) continue;
        if (
          candidate.sourceExpiresAt &&
          Date.parse(candidate.sourceExpiresAt) <= Date.parse(input.at)
        ) {
          tx.update(schema.qqConversationTasks)
            .set({
              status: "expired",
              updatedAt: input.at,
              finishedAt: input.at,
              errorCode: "SOURCE_EXPIRED",
            })
            .where(
              and(
                eq(schema.qqConversationTasks.id, candidate.id),
                eq(schema.qqConversationTasks.status, "pending"),
              ),
            )
            .run();
          continue;
        }
        const { task, state } = sourceStateOrTerminalize(
          tx,
          candidate,
          input.sourceState,
          input.at,
        );
        if (!task || state !== "valid") continue;
        if (input.resourceGate && !input.resourceGate(task)) continue;
        let limits = limitsByConversation.get(candidate.conversationId);
        if (!limits) {
          limits = resolveQqConversationTaskLimits(input.limitsFor(identityOf(candidate)));
          limitsByConversation.set(candidate.conversationId, limits);
        }
        const running = clientOf(tx)
          .query(`SELECT COUNT(*) AS n FROM qq_conversation_tasks
          WHERE conversation_id=? AND task_class=? AND status='running'`)
          .get(candidate.conversationId, candidate.taskClass) as { n: number };
        if (
          running.n >=
          limits[candidate.taskClass === "mention" ? "mentionTaskLimit" : "ordinaryTaskLimit"]
        )
          continue;
        if (candidate.cause === "chiming_in" && candidate.judgementDone === 0) {
          const held = clientOf(tx)
            .query(`SELECT 1 AS yes FROM qq_conversation_tasks
            WHERE conversation_id=? AND cause='chiming_in' AND task_class='ordinary'
              AND status='running' AND judgement_done=0 LIMIT 1`)
            .get(candidate.conversationId);
          if (held) continue;
        }
        const frozen = candidate.executionSnapshot
          ? QqTaskExecutionSnapshotSchema.parse(JSON.parse(candidate.executionSnapshot))
          : QqTaskExecutionSnapshotSchema.parse(input.freezeAtClaim(tx, candidate, limits));
        const identity = identityOf(candidate);
        if (
          frozen.taskKey !== identity.taskKey ||
          frozen.conversationId !== identity.conversationId ||
          frozen.bindingEpoch !== identity.bindingEpoch ||
          frozen.agentId !== identity.agentId ||
          frozen.taskClass !== identity.taskClass ||
          frozen.cause !== identity.cause ||
          frozen.sourceFromSeq !== identity.sourceFromSeq ||
          frozen.sourceThroughSeq !== identity.sourceThroughSeq ||
          frozen.sourceExpiresAt !== candidate.sourceExpiresAt
        )
          throw new Error("QQ_TASK_EXECUTION_SNAPSHOT_IDENTITY_MISMATCH");
        const claimed = tx
          .update(schema.qqConversationTasks)
          .set({
            status: "running",
            leaseToken: input.leaseToken,
            leaseExpiresAt: input.leaseExpiresAt,
            executionSnapshot: candidate.executionSnapshot ?? JSON.stringify(frozen),
            claimedAt: candidate.claimedAt ?? input.at,
            updatedAt: input.at,
          })
          .where(
            and(
              eq(schema.qqConversationTasks.id, candidate.id),
              eq(schema.qqConversationTasks.status, "pending"),
            ),
          )
          .returning()
          .get();
        if (claimed)
          return {
            task: claimed,
            conversationId: claimed.conversationId,
            leaseToken: input.leaseToken,
          };
      }
    } finally {
      candidates.return?.();
      candidateStatement.finalize();
    }
    return null;
  });
}

export function markQqConversationTaskJudgementDone(
  orm: Orm,
  input: {
    taskId: string;
    leaseToken: string;
    at: string;
    markJudged: (transaction: Orm, task: QqConversationTaskRow) => void;
    sourceState: QqConversationTaskSourceGuard;
  },
): boolean {
  if (!input.markJudged || !input.sourceState)
    throw new TypeError("QQ judgement commit guards are required");
  return immediate(orm, (tx) => {
    const task = currentRow(tx, input.taskId);
    if (
      task?.status !== "running" ||
      task.leaseToken !== input.leaseToken ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt <= input.at ||
      task.cause !== "chiming_in" ||
      task.judgementDone !== 0 ||
      task.cancellationRequested !== 0
    )
      return false;
    const state = sourceStateOrTerminalize(tx, task, input.sourceState, input.at);
    if (!state.task || state.state !== "valid") return false;
    input.markJudged(tx, task);
    return (
      tx
        .update(schema.qqConversationTasks)
        .set({ judgementDone: 1, updatedAt: input.at })
        .where(
          and(
            eq(schema.qqConversationTasks.id, task.id),
            eq(schema.qqConversationTasks.status, "running"),
            eq(schema.qqConversationTasks.leaseToken, input.leaseToken),
            gt(schema.qqConversationTasks.leaseExpiresAt, input.at),
            eq(schema.qqConversationTasks.judgementDone, 0),
            eq(schema.qqConversationTasks.cancellationRequested, 0),
          ),
        )
        .returning()
        .get() !== undefined
    );
  });
}

export function attachQqConversationTaskRun(
  orm: Orm,
  input: { taskId: string; leaseToken: string; runId: string; at: string },
): boolean {
  const updated = orm
    .update(schema.qqConversationTasks)
    .set({ originRunId: input.runId, updatedAt: input.at })
    .where(
      and(
        eq(schema.qqConversationTasks.id, input.taskId),
        eq(schema.qqConversationTasks.status, "running"),
        eq(schema.qqConversationTasks.leaseToken, input.leaseToken),
        gt(schema.qqConversationTasks.leaseExpiresAt, input.at),
        or(
          isNull(schema.qqConversationTasks.originRunId),
          eq(schema.qqConversationTasks.originRunId, input.runId),
        ),
      ),
    )
    .returning()
    .get();
  return updated !== undefined;
}

export function hasDistinctQqMentionTaskOwnerForEvent(
  orm: Orm,
  input: {
    conversationId: string;
    sourceThroughSeq: number;
    eventSeq: number;
    eventSourceId: string;
    bindingEpoch: number;
    agentId: string;
    owner:
      | { readonly kind: "task"; readonly id: string }
      | { readonly kind: "run"; readonly id: string };
  },
): boolean {
  const taskId = input.owner.kind === "task" ? input.owner.id : "";
  const runId = input.owner.kind === "run" ? input.owner.id : "";
  return (
    clientOf(orm)
      .query(`SELECT 1 AS ok
        FROM qq_conversation_tasks source
        JOIN qq_conversation_tasks owner
          ON owner.conversation_id=source.conversation_id
          AND owner.binding_epoch=source.binding_epoch
          AND owner.agent_id=source.agent_id
          AND owner.task_class='mention'
          AND owner.source_through_seq=?
          AND owner.origin_event_key=?
          AND owner.id<>source.id
        JOIN conversation_events ce
          ON ce.conversation_id=owner.conversation_id
          AND ce.seq=owner.source_through_seq
          AND ce.kind='inbound'
          AND ce.source_kind='qq_event'
          AND ce.source_id=owner.origin_event_key
        WHERE source.conversation_id=? AND source.binding_epoch=? AND source.agent_id=?
          AND source.source_through_seq=? AND source.task_class='mention'
          AND ((source.id=? AND ?<>'') OR source.origin_run_id=?)
        LIMIT 1`)
      .get(
        input.eventSeq,
        input.eventSourceId,
        input.conversationId,
        input.bindingEpoch,
        input.agentId,
        input.sourceThroughSeq,
        taskId,
        taskId,
        runId,
      ) !== null
  );
}

export function ownsQqConversationTaskLease(
  orm: Orm,
  input: {
    taskId: string;
    leaseToken: string;
    at: string;
    sourceState: QqConversationTaskSourceGuard;
  },
): boolean {
  return immediate(orm, (tx) => {
    const task = currentRow(tx, input.taskId);
    if (
      task?.status !== "running" ||
      task.leaseToken !== input.leaseToken ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt <= input.at ||
      task.cancellationRequested !== 0
    )
      return false;
    const { task: current, state } = sourceStateOrTerminalize(
      tx,
      task,
      input.sourceState,
      input.at,
    );
    return current?.status === "running" && state === "valid";
  });
}

export function renewQqConversationTaskLease(
  orm: Orm,
  input: {
    taskId: string;
    leaseToken: string;
    at: string;
    leaseExpiresAt: string;
    sourceState: QqConversationTaskSourceGuard;
  },
): boolean {
  return immediate(orm, (tx) => {
    const task = currentRow(tx, input.taskId);
    if (
      task?.status !== "running" ||
      task.leaseToken !== input.leaseToken ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt <= input.at ||
      task.cancellationRequested !== 0
    )
      return false;
    const state = sourceStateOrTerminalize(tx, task, input.sourceState, input.at);
    if (
      !state.task ||
      state.state !== "valid" ||
      Date.parse(input.leaseExpiresAt) <= Date.parse(input.at)
    )
      return false;
    return (
      tx
        .update(schema.qqConversationTasks)
        .set({ leaseExpiresAt: input.leaseExpiresAt, updatedAt: input.at })
        .where(
          and(
            eq(schema.qqConversationTasks.id, task.id),
            eq(schema.qqConversationTasks.status, "running"),
            eq(schema.qqConversationTasks.leaseToken, input.leaseToken),
            gt(schema.qqConversationTasks.leaseExpiresAt, input.at),
            eq(schema.qqConversationTasks.cancellationRequested, 0),
          ),
        )
        .returning()
        .get() !== undefined
    );
  });
}

export function cancelQqConversationTask(
  orm: Orm,
  input: { taskId: string; at: string },
): "cancelled" | "requested" | false {
  return immediate(orm, (tx) => {
    const task = currentRow(tx, input.taskId);
    if (!task || (task.status !== "pending" && task.status !== "running")) return false;
    if (task.status === "running" && (!task.leaseExpiresAt || task.leaseExpiresAt <= input.at))
      return false;
    if (task.status === "pending") {
      const row = tx
        .update(schema.qqConversationTasks)
        .set({
          status: "cancelled",
          cancellationRequested: 0,
          updatedAt: input.at,
          finishedAt: input.at,
        })
        .where(
          and(
            eq(schema.qqConversationTasks.id, task.id),
            eq(schema.qqConversationTasks.status, "pending"),
          ),
        )
        .returning()
        .get();
      return row ? "cancelled" : false;
    }
    const row = tx
      .update(schema.qqConversationTasks)
      .set({ cancellationRequested: 1, updatedAt: input.at })
      .where(
        and(
          eq(schema.qqConversationTasks.id, task.id),
          eq(schema.qqConversationTasks.status, "running"),
          eq(schema.qqConversationTasks.leaseToken, task.leaseToken ?? ""),
        ),
      )
      .returning()
      .get();
    return row ? "requested" : false;
  });
}

export function settleQqConversationTask(
  orm: Orm,
  input: {
    taskId: string;
    leaseToken: string;
    outcome: QqConversationTaskOutcome;
    at: string;
    sourceState: QqConversationTaskSourceGuard;
    errorCode?: string | null;
  },
): QqConversationTaskOutcome | false {
  if (!QQ_CONVERSATION_TASK_STATUS.includes(input.outcome))
    throw new TypeError("Invalid QQ task outcome");
  return immediate(orm, (tx) => {
    const task = currentRow(tx, input.taskId);
    if (
      task?.status !== "running" ||
      task.leaseToken !== input.leaseToken ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt <= input.at
    )
      return false;
    const { task: current } = sourceStateOrTerminalize(tx, task, input.sourceState, input.at);
    if (current?.status !== "running")
      return current?.status === "expired" ? "expired" : "cancelled";
    const outcome = current.cancellationRequested === 1 ? "cancelled" : input.outcome;
    const updated = tx
      .update(schema.qqConversationTasks)
      .set({
        status: outcome,
        leaseToken: null,
        leaseExpiresAt: null,
        cancellationRequested: 0,
        finishedAt: input.at,
        updatedAt: input.at,
        errorCode: outcome === "failed" ? (input.errorCode ?? null) : null,
      })
      .where(
        and(
          eq(schema.qqConversationTasks.id, current.id),
          eq(schema.qqConversationTasks.status, "running"),
          eq(schema.qqConversationTasks.leaseToken, input.leaseToken),
          gt(schema.qqConversationTasks.leaseExpiresAt, input.at),
        ),
      )
      .returning()
      .get();
    return updated ? outcome : false;
  });
}

/**
 * 把一个 lease 仍有效的 running 任务按冻结预算 defer 回 pending：不重铸预算，不重冻结
 * snapshot，不改 claimedAt/judgementDone/originRunId；ready_at 是它下次可被 claim 的最早时刻。
 * lease 不活、源失效/到期或已请求取消的 running 任务一律不可 defer（后者终态 cancelled）。
 */
export function deferQqConversationTask(
  orm: Orm,
  input: {
    taskId: string;
    leaseToken: string;
    at: string;
    readyAt: string;
    sourceState: QqConversationTaskSourceGuard;
  },
): boolean {
  if (!Number.isFinite(Date.parse(input.at)) || !Number.isFinite(Date.parse(input.readyAt))) {
    throw new TypeError("Invalid QQ conversation task deferral readyAt");
  }
  return immediate(orm, (tx) => {
    const task = currentRow(tx, input.taskId);
    if (
      task?.status !== "running" ||
      task.leaseToken !== input.leaseToken ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt <= input.at ||
      task.cancellationRequested !== 0
    )
      return false;
    const { task: current } = sourceStateOrTerminalize(tx, task, input.sourceState, input.at);
    if (current?.status !== "running" || current.cancellationRequested !== 0) return false;
    if (current.sourceExpiresAt && Date.parse(current.sourceExpiresAt) <= Date.parse(input.at)) {
      terminalizeSource(tx, current, "expired", input.at);
      return false;
    }
    return (
      tx
        .update(schema.qqConversationTasks)
        .set({
          status: "pending",
          readyAt: input.readyAt,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: input.at,
        })
        .where(
          and(
            eq(schema.qqConversationTasks.id, current.id),
            eq(schema.qqConversationTasks.status, "running"),
            eq(schema.qqConversationTasks.leaseToken, input.leaseToken),
            gt(schema.qqConversationTasks.leaseExpiresAt, input.at),
            eq(schema.qqConversationTasks.cancellationRequested, 0),
          ),
        )
        .returning()
        .get() !== undefined
    );
  });
}

export function recoverQqConversationTaskLease(
  orm: Orm,
  input: {
    taskId: string;
    leaseToken: string;
    at: string;
    resolveExistingRunAndOutbox: (
      transaction: Orm,
      task: QqConversationTaskRow,
    ) => QqConversationTaskRecovery;
  },
): QqConversationTaskRecovery | false {
  return immediate(orm, (tx) => {
    const task = currentRow(tx, input.taskId);
    if (
      task?.status !== "running" ||
      task.leaseToken !== input.leaseToken ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt > input.at
    )
      return false;
    if (task.cancellationRequested !== 0) {
      const cancelled = tx
        .update(schema.qqConversationTasks)
        .set({
          status: "cancelled",
          leaseToken: null,
          leaseExpiresAt: null,
          cancellationRequested: 0,
          finishedAt: input.at,
          updatedAt: input.at,
        })
        .where(
          and(
            eq(schema.qqConversationTasks.id, task.id),
            eq(schema.qqConversationTasks.status, "running"),
            eq(schema.qqConversationTasks.leaseToken, input.leaseToken),
            lte(schema.qqConversationTasks.leaseExpiresAt, input.at),
            eq(schema.qqConversationTasks.cancellationRequested, 1),
          ),
        )
        .returning()
        .get();
      return cancelled ? "cancelled" : false;
    }
    const resolved = input.resolveExistingRunAndOutbox(tx, task);
    if (resolved === "resume") {
      const row = tx
        .update(schema.qqConversationTasks)
        .set({ status: "pending", leaseToken: null, leaseExpiresAt: null, updatedAt: input.at })
        .where(
          and(
            eq(schema.qqConversationTasks.id, task.id),
            eq(schema.qqConversationTasks.status, "running"),
            eq(schema.qqConversationTasks.leaseToken, input.leaseToken),
            lte(schema.qqConversationTasks.leaseExpiresAt, input.at),
          ),
        )
        .returning()
        .get();
      return row ? "resume" : false;
    }
    const row = tx
      .update(schema.qqConversationTasks)
      .set({
        status: resolved,
        leaseToken: null,
        leaseExpiresAt: null,
        cancellationRequested: 0,
        finishedAt: input.at,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(schema.qqConversationTasks.id, task.id),
          eq(schema.qqConversationTasks.status, "running"),
          eq(schema.qqConversationTasks.leaseToken, input.leaseToken),
          lte(schema.qqConversationTasks.leaseExpiresAt, input.at),
        ),
      )
      .returning()
      .get();
    return row ? resolved : false;
  });
}
