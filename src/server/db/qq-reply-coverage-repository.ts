import type { Database } from "bun:sqlite";
import {
  type QqTaskExecutionSnapshot,
  QqTaskExecutionSnapshotSchema,
} from "../../shared/contracts/qq-task";

export type QqReplyCoverageScope = {
  accountId: string;
  bindingId: string;
  bindingEpoch: number;
  agentId: string;
};

export function confirmedQqReplyCovers(
  db: Database,
  input: {
    conversationId: string;
    sourceSeq: number;
    participantId: string | null;
    excludeOwn?: { sourceThroughSeq: number; cause: string };
    scope?: QqReplyCoverageScope;
    roomOnly?: boolean;
  },
): boolean {
  const rows = db
    .query(`SELECT w.through_seq AS origin_through, w.cause AS origin_cause
      FROM outbound_intent_metadata i
      LEFT JOIN agent_runs ar ON ar.run_id=i.run_id AND ar.conversation_id=i.conversation_id
      LEFT JOIN wake_signals w ON w.id=ar.wake_id AND w.conversation_id=i.conversation_id
      WHERE i.conversation_id=? AND i.source_through_seq>=? AND i.status='confirmed'
        AND (i.participant_id IS NULL OR i.participant_id=?)
        AND EXISTS(SELECT 1 FROM outbound_parts p WHERE p.intent_id=i.intent_id
          AND p.attempted_at IS NOT NULL AND p.status='confirmed')
        AND (? IS NULL OR (i.account_id=?
          AND i.binding_id=?
          AND i.binding_epoch=?
          AND i.agent_id=?))
        AND (?=0 OR i.participant_id IS NULL)`)
    .all(
      input.conversationId,
      input.sourceSeq,
      input.participantId,
      input.scope ? 1 : null,
      input.scope?.accountId ?? null,
      input.scope?.bindingId ?? null,
      input.scope?.bindingEpoch ?? null,
      input.scope?.agentId ?? null,
      input.roomOnly ? 1 : 0,
    ) as { origin_through: number | null; origin_cause: string | null }[];
  return rows.some(({ origin_through, origin_cause }) =>
    input.excludeOwn &&
    origin_through === input.excludeOwn.sourceThroughSeq &&
    origin_cause === input.excludeOwn.cause
      ? false
      : true,
  );
}

export type ConfirmedQqDirectReply = {
  intentId: string;
  conversationId: string;
  sourceThroughSeq: number;
  scope: QqReplyCoverageScope;
};

export function readConfirmedQqDirectReply(
  db: Database,
  intentId: string,
): ConfirmedQqDirectReply | null {
  const row = db
    .query(`SELECT i.intent_id AS id,i.conversation_id,i.source_through_seq,
        i.account_id AS accountId,i.binding_id AS bindingId,i.binding_epoch AS bindingEpoch,i.agent_id AS agentId
      FROM outbound_intent_metadata i
      JOIN agent_runs r ON r.run_id=i.run_id AND r.conversation_id=i.conversation_id
      WHERE i.intent_id=? AND i.status='confirmed' AND i.speech_kind='direct_reply'
        AND r.owner_kind='conversation' AND r.owner_id=i.conversation_id
        AND r.agent_id=+i.agent_id
        AND r.observed_seq=COALESCE(i.observed_through_seq,i.source_through_seq)
        AND r.observed_seq>=i.source_through_seq
        AND EXISTS(SELECT 1 FROM outbound_parts p WHERE p.intent_id=i.intent_id
          AND p.attempted_at IS NOT NULL AND p.status='confirmed')
        AND NOT EXISTS(SELECT 1 FROM outbound_parts p WHERE p.intent_id=i.intent_id AND p.status<>'confirmed')`)
    .get(intentId) as {
    id: string;
    conversation_id: string;
    source_through_seq: number;
    accountId: unknown;
    bindingId: unknown;
    bindingEpoch: unknown;
    agentId: unknown;
  } | null;
  if (!row) return null;
  const original = db.query("SELECT target FROM outbound_intents WHERE id=?").get(intentId) as {
    target: string;
  } | null;
  if (!original) return null;
  let target: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(original.target);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    target = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const { accountId, bindingId, bindingEpoch, agentId } = target;
  if (
    typeof accountId !== "string" ||
    typeof bindingId !== "string" ||
    typeof bindingEpoch !== "number" ||
    !Number.isInteger(bindingEpoch) ||
    typeof agentId !== "string"
  )
    return null;
  return {
    intentId: row.id,
    conversationId: row.conversation_id,
    sourceThroughSeq: row.source_through_seq,
    scope: { accountId, bindingId, bindingEpoch, agentId },
  };
}

export type RunningQqChimingTask = {
  id: string;
  taskKey: string;
  sourceThroughSeq: number;
  cause: string;
  snapshot: QqTaskExecutionSnapshot;
};

export function readRunningQqChimingTasksSupersededBy(
  db: Database,
  reply: ConfirmedQqDirectReply,
): RunningQqChimingTask[] {
  const rows = db
    .query(`SELECT id,task_key,conversation_id,binding_epoch,agent_id,task_class,cause,
        source_from_seq,source_through_seq,execution_snapshot
      FROM qq_conversation_tasks
      WHERE conversation_id=? AND status='running' AND cancellation_requested=0
        AND task_class='ordinary' AND cause='chiming_in' AND source_through_seq<?
        AND NOT EXISTS(SELECT 1 FROM outbound_intent_metadata i
          WHERE i.conversation_id=qq_conversation_tasks.conversation_id
            AND i.qq_task_id=qq_conversation_tasks.id)`)
    .all(reply.conversationId, reply.sourceThroughSeq) as {
    id: string;
    task_key: string;
    conversation_id: string;
    binding_epoch: number;
    agent_id: string;
    task_class: string;
    cause: string;
    source_from_seq: number;
    source_through_seq: number;
    execution_snapshot: string | null;
  }[];
  const candidates: RunningQqChimingTask[] = [];
  for (const row of rows) {
    if (!row.execution_snapshot) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(row.execution_snapshot);
    } catch {
      continue;
    }
    const parsed = QqTaskExecutionSnapshotSchema.safeParse(raw);
    if (!parsed.success) continue;
    const snapshot = parsed.data;
    if (
      snapshot.conversationId !== row.conversation_id ||
      snapshot.taskKey !== row.task_key ||
      snapshot.bindingEpoch !== row.binding_epoch ||
      snapshot.agentId !== row.agent_id ||
      snapshot.taskClass !== row.task_class ||
      snapshot.cause !== row.cause ||
      snapshot.sourceFromSeq !== row.source_from_seq ||
      snapshot.sourceThroughSeq !== row.source_through_seq ||
      snapshot.accountId !== reply.scope.accountId ||
      snapshot.bindingId !== reply.scope.bindingId ||
      snapshot.bindingEpoch !== reply.scope.bindingEpoch ||
      snapshot.agentId !== reply.scope.agentId
    )
      continue;
    candidates.push({
      id: row.id,
      taskKey: row.task_key,
      sourceThroughSeq: row.source_through_seq,
      cause: row.cause,
      snapshot,
    });
  }
  return candidates;
}
