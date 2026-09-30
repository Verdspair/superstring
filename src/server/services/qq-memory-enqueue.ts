// The caller that turns a QQ conversation's observations into a consolidation job.
//
// This is the missing link between "a message arrived" and "the worker can organise
// it": it selects observations that still have text and have not been offered yet,
// and hands them to the queue as an observation-backed job.
//
// It deliberately takes the batch size from the caller instead of defaulting it. No
// threshold for "how many messages before the group's memory is organised" has been
// agreed (U-item), and inventing one here would silently decide the product's
// pacing. Everything else is fixed: the scope is derived from the conversation scope
// the caller resolved, so a call can never enqueue into another conversation.

import { enqueue, type MemoryJobRow } from "../db/memory-repository";
import { readBindingByConversation } from "../db/qq-binding-repository";
import {
  markObservationsProcessed,
  pendingObservationCount,
  pendingObservations,
  type QqConversationScope,
} from "../db/qq-observation-repository";
import { readQqSettings } from "../db/qq-settings-repository";
import { DEFAULT_USER_ID, type Orm } from "../db/repositories";
import { AppError, fail } from "../errors";
import { QqGroupCapabilityGuard } from "../permissions/qq-group-capabilities";
import { type QqBinding, qqConversationScope, qqMemoryScopeKey } from "./qq-binding-contract";

export interface QqMemoryCandidate {
  readonly eventKey: string;
  readonly body: string;
  readonly occurredAtSeconds: number;
}

/** Observations of this conversation that are ready to be organised, oldest first. */
export function qqMemoryCandidates(
  orm: Orm,
  scope: QqConversationScope,
  limit: number,
): QqMemoryCandidate[] {
  return pendingObservations(orm, scope, limit);
}

export interface EnqueueQqMemoryArgs {
  /** The resolved conversation scope; it becomes the job's memory scope. */
  scope: QqConversationScope;
  /** Unique key for idempotency, like every other enqueue path. */
  requestKey: string;
  /**
   * How many of the pending observations to organise. Required: it is the caller's
   * pacing decision, and there is no agreed default.
   */
  limit: number;
}

/**
 * 入队前的本群能力复验（ADR0019 §13.3 D/H）：本群停用「记忆整理」后不再新增整理任务。
 * 找不到绑定时不改判定——没有本群配置就没有本群停用（无绑定不属于任何群的能力域）。
 */
export function assertQqMemoryOrganizeAllowed(orm: Orm, scope: QqConversationScope): void {
  const binding = readBindingByConversation(orm, {
    accountId: scope.accountId,
    kind: scope.conversationKind,
    peerId: scope.peerId,
  });
  if (binding === null) return;
  new QqGroupCapabilityGuard(orm).assert(
    { kind: "qq_binding", id: binding.id, userId: DEFAULT_USER_ID, agentId: binding.agentId },
    "memory_organize",
  );
}

/**
 * Enqueue a consolidation job for the oldest pending observations of one conversation.
 * Returns `null` when there is nothing to organise, which is a normal outcome and not
 * an error (an empty group, or everything already processed).
 *
 * The batch is marked processed only after the enqueue succeeded: marking first would
 * silently drop the batch if the queue rejected it, and a rejected batch must remain
 * retryable.
 */
export function enqueueQqMemory(orm: Orm, args: EnqueueQqMemoryArgs): MemoryJobRow | null {
  const candidates = pendingObservations(orm, args.scope, args.limit);
  if (candidates.length === 0) return null;
  if (args.limit < candidates.length) {
    fail("MEMORY_SOURCE_INVALID", "观察批次超出请求数量");
  }
  // 自动与手动两条入口共用这里：能力停用必须在这里被拒，观察批次因此保持未消费、可重试。
  assertQqMemoryOrganizeAllowed(orm, args.scope);
  const eventIds = candidates.map((candidate) => candidate.eventKey);
  const job = enqueue(orm, args.scope.agentId, args.requestKey, {
    kind: "manual",
    eventIds,
    scope: { scope: "reality_user", scopeKey: qqMemoryScopeKey(args.scope) },
  });
  markObservationsProcessed(orm, eventIds);
  return job;
}

/**
 * The manual "organise now" action.
 *
 * It organises everything currently readable, ignoring the configured count — the
 * user pressing the button IS the decision to spend a model call, so the pacing
 * setting must not veto it. The count is not modified: it stays a pacing preference,
 * not a cap. Returns `null` when there is nothing to organise, which is a normal
 * outcome rather than an error.
 */
export function enqueueQqMemoryNow(
  orm: Orm,
  args: { scope: QqConversationScope; requestKey: string },
): MemoryJobRow | null {
  const pending = pendingObservationCount(orm, args.scope);
  if (pending === 0) return null;
  return enqueueQqMemory(orm, {
    scope: args.scope,
    requestKey: args.requestKey,
    limit: pending,
  });
}

/**
 * 「记忆整理 · 立即整理」for one bound conversation .
 *
 * Why this exists at all: the two halves of QQ memory both lacked an entrance — the automatic one
 * needed a per-conversation count no page could set, and `enqueueQqMemoryNow` above was written but
 * never called by anything, so a group could talk for days and still have zero memories.
 *
 * Every refusal is an outcome rather than an error, because each one is something the page can
 * state plainly: the third-party switch is off (a disabled feature must not spend model calls on
 * observations that arrived before it was switched off), the conversation is paused (pausing means
 * no new model tasks for it), the assistant is disabled, or the assistant already has an active job
 * (`MEMORY_BUSY` — the queue allows one per assistant, so "wait" is the honest answer).
 * The pending count comes back either way, so the page can show what is actually waiting.
 *
 * 唯一例外：本群停用「记忆整理」不是判决而是错误（`QQ_GROUP_CAPABILITY_DISABLED`，ADR0019 §13.3 D）——
 * 状态枚举没有"能力已停用"这一档、也不该加：停用是一个决定，不是一次可重试的尝试结果。
 */
export type QqMemoryOrganiseStatus =
  | "queued"
  | "nothing_to_organise"
  | "switch_off"
  | "paused"
  | "busy"
  | "agent_disabled";

export interface QqMemoryOrganiseOutcome {
  readonly status: QqMemoryOrganiseStatus;
  readonly jobId: string | null;
  readonly pending: number;
}

export function organiseQqMemoryNow(orm: Orm, binding: QqBinding): QqMemoryOrganiseOutcome {
  // 先判本群能力：停用即失败（不是判决），不让它落到任何状态分支上去。
  new QqGroupCapabilityGuard(orm).assert(
    { kind: "qq_binding", id: binding.id, userId: DEFAULT_USER_ID, agentId: binding.agentId },
    "memory_organize",
  );
  const scope = qqConversationScope(binding);
  const pending = pendingObservationCount(orm, scope);
  if (readQqSettings(orm).enabled !== 1) return { status: "switch_off", jobId: null, pending };
  if (binding.paused) return { status: "paused", jobId: null, pending };
  try {
    const job = enqueueQqMemoryNow(orm, {
      scope,
      requestKey: `qq_manual_${crypto.randomUUID().replace(/-/g, "")}`,
    });
    return job === null
      ? { status: "nothing_to_organise", jobId: null, pending }
      : { status: "queued", jobId: job.id, pending };
  } catch (error) {
    if (error instanceof AppError && error.code === "MEMORY_BUSY") {
      return { status: "busy", jobId: null, pending };
    }
    if (error instanceof AppError && error.code === "AGENT_DISABLED") {
      return { status: "agent_disabled", jobId: null, pending };
    }
    throw error;
  }
}
