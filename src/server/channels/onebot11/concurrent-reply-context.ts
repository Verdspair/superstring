import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  ModelMessageSchema,
  ProtectedModelOutputSchema,
} from "../../../shared/contracts/agent-run";
import { type SourceRef, SourceRefSchema } from "../../../shared/contracts/evidence";
import { QqTaskExecutionSnapshotSchema } from "../../../shared/contracts/qq-task";
import { QQ_CONVERSATION_TASK_LIMIT_DEFAULTS } from "../../../shared/contracts/qq-task-limits";
import { AppError } from "../../errors";
import { parseQqBatchJudgement } from "../../services/qq-prompt-contract";
import { uniqueSources } from "../../services/source-refs";

/** 同会话、纪元与 Agent 的其他任务事实；重叠范围优先，省略冲突明确计数。
 * 已接受的评分意图仅从精确关联的受保护首步读取，并复验完整来源。原文、推理和工具参数不出投影。
 * 直接任务没有评分意图时保持未知。呈现有界，渲染与计量循环不查询；不新增缓存或台账。
 */

/** 投影呈现上限＝共享任务帽契约默认值之和（mention+ordinary），不是新造常量。 */
export const QQ_CONCURRENT_JOBS_LIMIT =
  QQ_CONVERSATION_TASK_LIMIT_DEFAULTS.mentionTaskLimit +
  QQ_CONVERSATION_TASK_LIMIT_DEFAULTS.ordinaryTaskLimit;

export type ConcurrentJobReplyFact = "planned" | "confirmed" | "partial" | "unknown" | "failed";

export interface RelatedReplyScope {
  conversationId: string;
  bindingEpoch: number;
  agentId: string;
  bindingId: string;
  accountId: string;
  conversationKind: string;
  peerId: string;
  authorityRevision: number;
  since: string;
  now: string;
  participantIds: readonly (string | null)[];
  ownTaskId?: string;
  ownRunId?: string;
}

/** Existing outbox facts inside this reader's window, never a second delivery ledger. */
export function readRelatedReplyDeliveries(
  db: Database,
  scope: RelatedReplyScope,
): {
  taskIds: string[];
  revision: string;
  omitted: number;
} {
  const rows = db
    .query(`WITH matching AS MATERIALIZED (
      SELECT i.intent_id AS id,i.status,i.qq_task_id AS taskId,i.created_at,i.output_ordinal
      FROM outbound_intent_metadata i
      WHERE i.conversation_id=? AND i.created_at>=? AND julianday(i.expires_at)>julianday(?)
        AND i.binding_id=?
        AND i.binding_epoch=?
        AND i.agent_id=?
        AND i.account_id=?
        AND i.conversation_kind=?
        AND i.peer_id=?
        AND i.authority_revision=?
        AND (? IS NULL OR i.qq_task_id IS NOT ?)
        AND (? IS NULL OR i.run_id<>?)
        AND (i.participant_id IS NULL
          OR EXISTS(SELECT 1 FROM json_each(?) a WHERE a.value IS NULL
            OR a.value=i.participant_id))
    ), candidates AS MATERIALIZED (
      SELECT * FROM matching ORDER BY created_at DESC,output_ordinal DESC,id DESC
      LIMIT ${QQ_CONCURRENT_JOBS_LIMIT}
    ) SELECT i.id,i.status,i.taskId,
      (SELECT COUNT(*) FROM matching) AS total,
      (SELECT MAX(e.seq) FROM conversation_events e INDEXED BY ix_conversation_events_source
        WHERE e.source_kind='outbound_intent' AND e.source_id=i.id
          AND e.conversation_id=? AND e.kind='delivery') AS deliverySeq,
      (SELECT json_group_array(json_array(p.id,p.status,p.platform_message_id))
        FROM (SELECT id,status,platform_message_id FROM outbound_parts
          WHERE intent_id=i.id ORDER BY ordinal) p) AS parts
    FROM candidates i ORDER BY i.created_at DESC,i.output_ordinal DESC,i.id DESC`)
    .all(
      scope.conversationId,
      scope.since,
      scope.now,
      scope.bindingId,
      scope.bindingEpoch,
      scope.agentId,
      scope.accountId,
      scope.conversationKind,
      scope.peerId,
      scope.authorityRevision,
      scope.ownTaskId ?? null,
      scope.ownTaskId ?? null,
      scope.ownRunId ?? null,
      scope.ownRunId ?? null,
      JSON.stringify(scope.participantIds),
      scope.conversationId,
    ) as {
    id: string;
    status: string;
    taskId: string | null;
    deliverySeq: number | null;
    parts: string;
    total: number;
  }[];
  const omitted = Math.max(0, (rows[0]?.total ?? 0) - rows.length);
  return {
    taskIds: [...new Set(rows.flatMap((row) => (row.taskId === null ? [] : [row.taskId])))],
    revision: JSON.stringify([
      omitted,
      ...rows.map(({ id, status, deliverySeq, parts }) => [id, status, deliverySeq, parts]),
    ]),
    omitted,
  };
}

/** 该任务批量评分叶子里一个目标已声明的公开意图（受保护快照仍有效时的真实事实）。 */
export type ConcurrentJobDeclaredIntent = {
  targetId: string;
  score: number;
  intent: string;
};

export type ConcurrentReplyJob = {
  taskId: string;
  cause: string;
  taskClass: string;
  status:
    | "pending"
    | "running"
    | "cancel_requested"
    | "completed"
    | "no_output"
    | "failed"
    | "cancelled"
    | "expired";
  /** 仅当问题事件键在当前档时间线可见时给出；缺席＝本投影不知道原题，不假装知道。 */
  questionSeq?: number;
  reply?: ConcurrentJobReplyFact;
  /**
   * 仅当该任务自己的批量评分受保护输出仍 exact/已记录/未到期时给出；缺席＝尚未判定、
   * 已撤销/到期或读不出协议（unknown），不是“没有意图”的证明。
   */
  declaredIntents?: readonly ConcurrentJobDeclaredIntent[];
};

export type ConcurrentReplyContext = { runId: string; stepId: string; expiresAt: string | null };

export type ConcurrentReplyProjection = {
  jobs: ConcurrentReplyJob[];
  totalActive: number;
  omittedOverlapping: number;
  omittedRelatedReplies?: number;
  sources: SourceRef[];
  contexts: ConcurrentReplyContext[];
};

export type ConcurrentReplyFacts = ConcurrentReplyProjection & {
  /** Internal identity used only to project a selected window's visible questions. */
  questionEventKeys: ReadonlyMap<number, string>;
};

const ACTIVE_WHERE = `WHERE t.conversation_id=? AND t.binding_epoch=? AND t.agent_id=?
       AND t.status IN ('pending','running')
       AND t.id<>COALESCE(?, '')
       AND (t.source_expires_at IS NULL OR julianday(t.source_expires_at) > julianday(?))
       AND (t.status='pending' OR t.lease_expires_at IS NULL OR julianday(t.lease_expires_at) > julianday(?))`;

/** 单个出站意图按真实部件台账聚合出的投递事实。 */
function intentReplyFact(row: {
  confirmedParts: number;
  unknownParts: number;
  parts: number;
  plannedRows: number;
}): ConcurrentJobReplyFact {
  return row.unknownParts > 0
    ? "unknown"
    : row.confirmedParts === row.parts
      ? "confirmed"
      : row.confirmedParts > 0
        ? "partial"
        : row.plannedRows > 0
          ? "planned"
          : "failed";
}

/** 跨意图合并取最保守：unknown 恒压过一切；confirmed 混任何未确认态＝partial。 */
function mergeReplyFacts(facts: readonly ConcurrentJobReplyFact[]): ConcurrentJobReplyFact {
  if (facts.includes("unknown")) return "unknown";
  if (facts.includes("partial")) return "partial";
  const confirmed = facts.filter((fact) => fact === "confirmed").length;
  if (confirmed > 0 && confirmed < facts.length) return "partial";
  if (confirmed === facts.length) return "confirmed";
  if (facts.includes("planned")) return "planned";
  return "failed";
}

function readReplyFacts(
  db: Database,
  conversationId: string,
  taskIds: readonly string[],
): Map<string, ConcurrentJobReplyFact> {
  if (taskIds.length === 0) return new Map();
  const rows = db
    .query(
      `SELECT i.qq_task_id AS taskId,
        SUM(CASE WHEN p.status='confirmed' THEN 1 ELSE 0 END) AS confirmedParts,
        SUM(CASE WHEN p.status='unknown' THEN 1 ELSE 0 END) AS unknownParts,
        COUNT(p.id) AS parts,
        SUM(CASE WHEN i.status IN ('planned','delivering') OR p.status IN ('planned','sending')
          THEN 1 ELSE 0 END) AS plannedRows
      FROM outbound_intent_metadata i LEFT JOIN outbound_parts p ON p.intent_id=i.intent_id
      WHERE i.conversation_id=?
        AND i.qq_task_id IN (SELECT value FROM json_each(?))
      GROUP BY i.intent_id`,
    )
    .all(conversationId, JSON.stringify(taskIds)) as {
    taskId: string | null;
    confirmedParts: number;
    unknownParts: number;
    parts: number;
    plannedRows: number;
  }[];
  const perTask = new Map<string, ConcurrentJobReplyFact[]>();
  for (const row of rows) {
    if (row.taskId === null || row.parts === 0) continue;
    const list = perTask.get(row.taskId);
    const fact = intentReplyFact(row);
    if (list) list.push(fact);
    else perTask.set(row.taskId, [fact]);
  }
  return new Map([...perTask].map(([taskId, facts]) => [taskId, mergeReplyFacts(facts)]));
}

/** 普通任务没有 origin_event_key：问题 seq → 真实事件键按 journal 精确解析，不猜。 */
function questionEventKeys(
  db: Database,
  conversationId: string,
  tasks: readonly { questionSeq: number; originEventKey: string | null }[],
): Map<number, string> {
  const keys = new Map<number, string>();
  const missing = tasks.filter((task) => task.originEventKey === null).map((t) => t.questionSeq);
  for (const task of tasks)
    if (task.originEventKey !== null) keys.set(task.questionSeq, task.originEventKey);
  if (missing.length === 0) return keys;
  const rows = db
    .query(
      `SELECT e.seq,e.source_id FROM json_each(?) requested
       CROSS JOIN conversation_events e
       WHERE e.conversation_id=? AND e.seq=requested.value
         AND e.kind='inbound' AND e.source_kind='qq_event'`,
    )
    .all(JSON.stringify([...new Set(missing)]), conversationId) as {
    seq: number;
    source_id: string;
  }[];
  for (const row of rows) keys.set(row.seq, row.source_id);
  return keys;
}

/**
 * 已声明意图的批量读取：每个普通任务自己的批量评分受保护输出，身份与恢复读取同一规则
 * （spec='onebot.initiative.evaluate_batch' × wake × observed_seq × completed run，取
 * started_at 最新的一条；首个 completed step；快照 exact + output_recorded + 非空 + 未到期）。
 * 两段有界查询（run 身份 → 快照正文），行数以投影上限为界，无 N+1、无缓存。快照撤销/到期
 * 由 redactContext/expireContexts 物理清空 + expires_at 按真实时刻（julianday）比较承担；
 * unreadable/空输出＝缺席，不冒认意图。operational SQL 失败原样抛出，不吞成“安全为空”。
 */
const DeclaredIntentAudienceSchema = z.strictObject({
  kind: z.literal("qq_batch_targets"),
  trust: z.literal("data_only"),
  sourceSeqs: z.array(z.number().int().nonnegative()),
  targets: z
    .array(
      z.strictObject({
        targetId: z.string().min(1),
        speakerId: z.string().nullable(),
        sourceSeqs: z.array(z.number().int().nonnegative()).optional(),
      }),
    )
    .min(1),
});

function readDeclaredIntents(
  db: Database,
  input: {
    conversationId: string;
    agentId: string;
    now: string;
    assertSources?: (sources: readonly SourceRef[]) => void;
  },
  tasks: readonly TaskRow[],
): {
  intents: Map<string, ConcurrentJobDeclaredIntent[]>;
  sources: SourceRef[];
  contexts: ConcurrentReplyContext[];
} {
  const result = {
    intents: new Map<string, ConcurrentJobDeclaredIntent[]>(),
    sources: [] as SourceRef[],
    contexts: [] as ConcurrentReplyContext[],
  };
  if (!input.assertSources) return result;
  const judged = tasks.filter(
    (task) =>
      task.originWakeId !== null &&
      (task.cause === "idle_topic" || (task.cause === "chiming_in" && task.judgementDone === 1)),
  );
  if (judged.length === 0) return result;
  const rows = db
    .query(`SELECT t.id AS taskId,t.source_from_seq AS sourceFromSeq,
      t.source_through_seq AS sourceThroughSeq,t.execution_snapshot AS executionSnapshot,
      s.run_id AS runId,s.step_id AS stepId,c.status,c.output_recorded AS outputRecorded,
      c.protected_output AS output,c.protected_messages AS messages,c.source_refs AS sources,
      c.expires_at AS expiresAt
    FROM qq_conversation_tasks t
    JOIN conversations scope ON scope.id=t.conversation_id AND scope.binding_epoch=t.binding_epoch
      AND scope.agent_id=t.agent_id AND scope.closed_at IS NULL
    JOIN agent_runs r ON r.run_id=(SELECT candidate.run_id FROM agent_runs candidate
      WHERE candidate.spec_id='onebot.initiative.evaluate_batch'
        AND candidate.conversation_id=t.conversation_id AND candidate.agent_id=t.agent_id
        AND candidate.owner_kind='qq_binding' AND candidate.owner_id=scope.source_id
        AND (candidate.user_id IS NULL OR candidate.user_id=scope.user_id)
        AND candidate.status='completed' AND candidate.wake_id=t.origin_wake_id
        AND candidate.observed_seq=t.source_through_seq
      ORDER BY candidate.started_at DESC LIMIT 1)
    JOIN agent_steps s ON s.step_id=(SELECT first.step_id FROM agent_steps first
      WHERE first.run_id=r.run_id AND first.status='completed' ORDER BY first.step_no LIMIT 1)
    JOIN context_snapshots c ON c.step_id=s.step_id
    WHERE t.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(judged.map((task) => task.id))) as {
    taskId: string;
    sourceFromSeq: number;
    sourceThroughSeq: number;
    executionSnapshot: string | null;
    runId: string;
    stepId: string;
    status: string;
    outputRecorded: number;
    output: string | null;
    messages: string | null;
    sources: string;
    expiresAt: string | null;
  }[];
  for (const row of rows) {
    if (
      row.status !== "exact" ||
      row.outputRecorded !== 1 ||
      !row.output ||
      !row.messages ||
      (row.expiresAt !== null && !(Date.parse(row.expiresAt) > Date.parse(input.now)))
    )
      continue;
    const output = ProtectedModelOutputSchema.safeParse(JSON.parse(row.output));
    if (
      !output.success ||
      !output.data.complete ||
      output.data.hasText === false ||
      output.data.text === ""
    )
      continue;
    const messages = z.array(ModelMessageSchema).safeParse(JSON.parse(row.messages));
    const sources = z.array(SourceRefSchema).safeParse(JSON.parse(row.sources));
    if (!messages.success || !sources.success) continue;
    let position = messages.data.length - 1;
    while (
      position >= 0 &&
      messages.data[position].role === "user" &&
      messages.data[position].content.length > 0 &&
      messages.data[position].content.every((part) => part.kind === "image")
    )
      position--;
    const terminal = messages.data[position];
    if (
      terminal?.role !== "user" ||
      terminal.content.length !== 1 ||
      terminal.content[0].kind !== "text"
    )
      continue;
    let envelopeValue: unknown;
    try {
      envelopeValue = JSON.parse(terminal.content[0].text);
    } catch {
      continue;
    }
    const envelope = DeclaredIntentAudienceSchema.safeParse(envelopeValue);
    if (!envelope.success) continue;
    const seqs = new Set(envelope.data.sourceSeqs);
    const targets = new Map(envelope.data.targets.map((target) => [target.targetId, target]));
    if (
      seqs.size !== envelope.data.sourceSeqs.length ||
      targets.size !== envelope.data.targets.length ||
      [...seqs].some((seq) => seq < row.sourceFromSeq || seq > row.sourceThroughSeq) ||
      envelope.data.targets.some(
        (target) =>
          target.sourceSeqs !== undefined &&
          (new Set(target.sourceSeqs).size !== target.sourceSeqs.length ||
            target.sourceSeqs.some((seq) => !seqs.has(seq))),
      )
    )
      continue;
    if (row.executionSnapshot !== null) {
      const frozen = QqTaskExecutionSnapshotSchema.safeParse(JSON.parse(row.executionSnapshot));
      if (
        !frozen.success ||
        frozen.data.conversationId !== input.conversationId ||
        frozen.data.agentId !== input.agentId ||
        envelope.data.targets.some(
          (target) =>
            !frozen.data.authorizedTargets.includes(target.targetId) ||
            !frozen.data.targetParticipants.some(
              (participant) =>
                participant.targetId === target.targetId &&
                participant.speakerId === target.speakerId,
            ),
        )
      )
        continue;
    }
    const outcome = parseQqBatchJudgement(output.data.text);
    if (outcome.kind !== "evaluations" || outcome.evaluations.length !== targets.size) continue;
    const evaluated = new Set(outcome.evaluations.map((evaluation) => evaluation.targetId));
    if (
      evaluated.size !== targets.size ||
      outcome.evaluations.some(
        (evaluation) =>
          !targets.has(evaluation.targetId) || evaluation.sourceSeqs.some((seq) => !seqs.has(seq)),
      )
    )
      continue;
    try {
      input.assertSources(sources.data);
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === "CONTEXT_SOURCE_INVALID" || error.code === "QQ_GROUP_CAPABILITY_DISABLED")
      )
        continue;
      throw error;
    }
    result.intents.set(
      row.taskId,
      outcome.evaluations.map(({ targetId, score, intent }) => ({ targetId, score, intent })),
    );
    result.sources.push(...sources.data);
    result.contexts.push({ runId: row.runId, stepId: row.stepId, expiresAt: row.expiresAt });
  }
  return result;
}

type TaskRow = {
  id: string;
  cause: string;
  taskClass: string;
  status: string;
  cancelRequested: number;
  sourceFromSeq: number;
  questionSeq: number;
  originEventKey: string | null;
  originWakeId: string | null;
  judgementDone: number;
};

export function readConcurrentReplyFacts(
  db: Database,
  input: {
    conversationId: string;
    bindingEpoch: number;
    agentId: string;
    now: string;
    /** 本任务自己的行：投影里排除，自己不算“其他任务”。 */
    ownTaskId?: string;
    /** Window-scoped outbox candidates, selected by the same context reader. */
    relatedTaskIds?: readonly string[];
    omittedRelatedReplies?: number;
    /** 当前任务冻结输入范围；与它相交的其他任务＝已知重叠冲突，SQL 内优先保留。 */
    focusFromSeq?: number;
    focusThroughSeq?: number;
    assertSources?: (sources: readonly SourceRef[]) => void;
  },
): ConcurrentReplyFacts {
  const nowIso = new Date(Date.parse(input.now)).toISOString();
  const scope = [
    input.conversationId,
    input.bindingEpoch,
    input.agentId,
    input.ownTaskId ?? null,
    nowIso,
    nowIso,
  ] as const;
  // 已知重叠冲突在取行上限**之前**用 SQL ORDER BY 优先（不用取行后再过滤，避免冲突被
  // 上限截掉）；范围参数缺省＝无重叠优先，直接按 seq 新→旧。
  const overlapParams =
    input.focusFromSeq === undefined || input.focusThroughSeq === undefined
      ? [null, null, null]
      : [input.focusThroughSeq, input.focusThroughSeq, input.focusFromSeq];
  const rows = db
    .query(
      `SELECT t.id,t.cause,t.task_class AS taskClass,t.status,
        t.cancellation_requested AS cancelRequested,
        t.source_from_seq AS sourceFromSeq,t.source_through_seq AS questionSeq,
        t.origin_event_key AS originEventKey,t.origin_wake_id AS originWakeId,t.judgement_done AS judgementDone,
        (CASE WHEN ? IS NULL THEN 1
              WHEN t.source_from_seq<=? AND t.source_through_seq>=? THEN 0 ELSE 1 END) AS prio
     FROM qq_conversation_tasks t
     ${ACTIVE_WHERE}
     ORDER BY prio ASC, t.source_through_seq DESC
     LIMIT ${QQ_CONCURRENT_JOBS_LIMIT}`,
    )
    .all(...overlapParams, ...scope) as (TaskRow & { prio: number })[];
  const totals = db
    .query(`SELECT COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN ? IS NOT NULL AND t.source_from_seq<=?
        AND t.source_through_seq>=? THEN 1 ELSE 0 END),0) AS overlapping
      FROM qq_conversation_tasks t ${ACTIVE_WHERE}`)
    .get(...overlapParams, ...scope) as { n: number; overlapping: number };
  const terminalRows = input.relatedTaskIds?.length
    ? (db
        .query(`SELECT t.id,t.cause,t.task_class AS taskClass,t.status,
        t.cancellation_requested AS cancelRequested,t.source_from_seq AS sourceFromSeq,
        t.source_through_seq AS questionSeq,t.origin_event_key AS originEventKey,
        t.origin_wake_id AS originWakeId,t.judgement_done AS judgementDone
      FROM qq_conversation_tasks t
      WHERE t.id IN (SELECT value FROM json_each(?)) AND t.conversation_id=?
        AND t.binding_epoch=? AND t.agent_id=? AND t.id<>COALESCE(?, '')
        AND t.status NOT IN ('pending','running')
        AND (t.source_expires_at IS NULL OR julianday(t.source_expires_at)>julianday(?))`)
        .all(JSON.stringify(input.relatedTaskIds), ...scope.slice(0, 5)) as TaskRow[])
    : [];
  const priority = (row: TaskRow) =>
    input.focusFromSeq !== undefined &&
    input.focusThroughSeq !== undefined &&
    row.sourceFromSeq <= input.focusThroughSeq &&
    row.questionSeq >= input.focusFromSeq
      ? 0
      : 1;
  const combined = [...rows.map(({ prio: _prio, ...row }) => row), ...terminalRows].sort(
    (a, b) =>
      priority(a) - priority(b) || b.questionSeq - a.questionSeq || a.id.localeCompare(b.id),
  );
  const totalActive = totals.n + terminalRows.length;
  const included = combined.slice(0, QQ_CONCURRENT_JOBS_LIMIT);
  const omittedOverlapping = Math.max(
    0,
    totals.overlapping +
      terminalRows.filter((row) => priority(row) === 0).length -
      included.filter((row) => priority(row) === 0).length,
  );
  const replyFacts = readReplyFacts(
    db,
    input.conversationId,
    included.map((row) => row.id),
  );
  const eventKeys = questionEventKeys(
    db,
    input.conversationId,
    included.map((row) => ({ questionSeq: row.questionSeq, originEventKey: row.originEventKey })),
  );
  const declared = readDeclaredIntents(db, input, included);
  const jobs: ConcurrentReplyJob[] = included.map((row) => {
    const key = eventKeys.get(row.questionSeq);
    return {
      taskId: row.id,
      cause: row.cause,
      taskClass: row.taskClass,
      status:
        row.cancelRequested === 1 && (row.status === "running" || row.status === "pending")
          ? "cancel_requested"
          : (row.status as ConcurrentReplyJob["status"]),
      ...(key !== undefined ? { questionSeq: row.questionSeq } : {}),
      ...(replyFacts.has(row.id) ? { reply: replyFacts.get(row.id)! } : {}),
      ...(declared.intents.get(row.id) ? { declaredIntents: declared.intents.get(row.id)! } : {}),
    };
  });
  return {
    jobs,
    totalActive,
    omittedOverlapping,
    ...(input.omittedRelatedReplies ? { omittedRelatedReplies: input.omittedRelatedReplies } : {}),
    sources: uniqueSources(declared.sources),
    contexts: declared.contexts,
    questionEventKeys: eventKeys,
  };
}

/** Project only question visibility; facts and their authorization were read by the caller. */
export function projectConcurrentReplyQuestions(
  facts: ConcurrentReplyFacts,
  visibleEventKeys: ReadonlySet<string>,
): ConcurrentReplyProjection {
  const { questionEventKeys, ...projection } = facts;
  return {
    ...projection,
    jobs: facts.jobs.map((job) => {
      if (
        job.questionSeq === undefined ||
        visibleEventKeys.has(questionEventKeys.get(job.questionSeq) ?? "")
      )
        return job;
      const { questionSeq: _, ...hidden } = job;
      return hidden;
    }),
  };
}

export function readConcurrentReplyJobs(
  db: Database,
  input: Parameters<typeof readConcurrentReplyFacts>[1] & { visibleEventKeys: ReadonlySet<string> },
): ConcurrentReplyProjection {
  return projectConcurrentReplyQuestions(
    readConcurrentReplyFacts(db, input),
    input.visibleEventKeys,
  );
}

/** data_only 投影值；guidance 是固定字面量，prompt 前缀稳定（不按任务内容变化）。 */
export const QQ_CONCURRENT_JOBS_GUIDANCE =
  "同一会话其他并发任务的最小状态投影：它们的问题是那些任务自己的背景与责任来源，不是本任务的新主输入；本任务只围绕自己的授权目标判断新增价值。已给出的 declaredIntents 是那些任务批量评分时逐目标声明的公开意图；未给出的字段（原题正文、对方意图、隐藏推理）本投影不知道，不代表已回答或允许新答案。";

export function concurrentJobsDumpValue(
  projection: ConcurrentReplyProjection,
): Record<string, unknown> {
  return {
    kind: "qq_concurrent_jobs",
    trust: "data_only",
    guidance: QQ_CONCURRENT_JOBS_GUIDANCE,
    jobs: projection.jobs,
    ...(projection.omittedRelatedReplies
      ? { omittedRelatedReplies: projection.omittedRelatedReplies }
      : {}),
    ...(projection.omittedOverlapping > 0
      ? { omittedOverlapping: projection.omittedOverlapping }
      : {}),
    ...(projection.jobs.length < projection.totalActive
      ? { omitted: projection.totalActive - projection.jobs.length }
      : {}),
  };
}
