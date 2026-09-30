// The automatic trigger: which QQ conversations should be organised right now.
//
// The user's decision (2026-09-22): organising is triggered by a message count, the
// number is per conversation and configurable, it can be switched off, and a manual
// "organise now" action exists alongside it. `qq_bindings.memory_batch_size` holds
// that number; `NULL` means off.
//
// This module is the automatic half. It decides nothing about pacing beyond comparing
// the configured count against what is pending, and it never invents a count.

import { and, asc, eq, isNotNull } from "drizzle-orm";
import { pendingObservationCount } from "../db/qq-observation-repository";
import { readQqSettings } from "../db/qq-settings-repository";
import { DEFAULT_USER_ID, getAgent, type Orm } from "../db/repositories";
import * as schema from "../db/schema";
import { AppError } from "../errors";
import { QqGroupCapabilityGuard } from "../permissions/qq-group-capabilities";
import { type QqConversationMemoryScope, qqConversationScopeOf } from "./qq-binding-contract";
import { enqueueQqMemory } from "./qq-memory-enqueue";

export interface QqMemoryScheduleResult {
  /** Conversations whose configured count had been reached. */
  readonly due: number;
  /** Jobs actually queued (`MEMORY_BUSY` and friends can still decline one). */
  readonly enqueued: number;
}

/** The DB row's side of the same derivation the contract binding uses (`qqConversationScope`). */
function scopeOf(binding: typeof schema.qqBindings.$inferSelect): QqConversationMemoryScope {
  return qqConversationScopeOf({
    accountId: binding.accountId,
    conversationKind: binding.conversationKind as "group" | "private",
    peerId: binding.peerId,
    agentId: binding.agentId,
  });
}

/**
 * Queue one organisation per conversation whose configured count has been reached.
 *
 * Gates, all of which fail closed:
 *   * the global third-party switch must be on — a disabled feature must not spend
 *     model calls on observations that arrived before it was turned off;
 *   * the binding must have a count configured (off means off) and must not be paused;
 *   * the assistant must still exist and be active;
 *   * 本群未停用「记忆整理」（ADR0019 §13.3 D/H）：停用的群在这里直接跳过，
 *     不只靠入队处的复验兜底。
 *
 * A conversation that a gate rejects is skipped without aborting the others, and
 * `MEMORY_BUSY` is expected rather than exceptional: the queue allows one active job
 * per assistant, so a second conversation of the same assistant simply waits for the
 * next cycle. Anything that is not an `AppError` propagates, because that is a real
 * fault rather than a declined attempt.
 */
export function scheduleQqMemory(orm: Orm, now?: string): QqMemoryScheduleResult {
  const settings = readQqSettings(orm);
  if (settings.enabled !== 1) return { due: 0, enqueued: 0 };

  const bindings = orm
    .select()
    .from(schema.qqBindings)
    .where(and(isNotNull(schema.qqBindings.memoryBatchSize), eq(schema.qqBindings.paused, 0)))
    .orderBy(asc(schema.qqBindings.createdAt), asc(schema.qqBindings.id))
    .all();

  let due = 0;
  let enqueued = 0;
  const guard = new QqGroupCapabilityGuard(orm);
  for (const binding of bindings) {
    const batchSize = binding.memoryBatchSize;
    if (batchSize === null) continue;
    try {
      const agent = getAgent(orm, binding.agentId);
      if (agent.isActive !== 1) continue;
      if (
        !guard.allowed(
          { kind: "qq_binding", id: binding.id, userId: DEFAULT_USER_ID, agentId: binding.agentId },
          "memory_organize",
        )
      )
        continue;
      const pending = pendingObservationCount(orm, scopeOf(binding), now);
      if (pending < batchSize) continue;
      due += 1;
      const job = enqueueQqMemory(orm, {
        scope: scopeOf(binding),
        requestKey: `qq_auto_${crypto.randomUUID().replace(/-/g, "")}`,
        limit: batchSize,
      });
      if (job !== null) enqueued += 1;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }
  }
  return { due, enqueued };
}
