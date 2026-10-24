// Removing one conversation binding (DELETE /qq/bindings/:bindingId).
//
// The binding is the only thing that makes a QQ conversation ours: observation intake looks it
// up by (account, kind, peer), so removing it makes the conversation inaccessible while the
// retained material (source bodies, canonical events, assistant, scheme) stays exactly as it is,
// and a later binding for the same peer starts a fresh binding epoch.
//
// Order inside the one IMMEDIATE transaction: every check that can refuse the request runs before
// the first write, so a 409 leaves the row and everything around it untouched. All binding epochs
// are inspected, not only the open one, because a closed epoch can still hold in-flight work.

import type { Database } from "bun:sqlite";
import { fail } from "../errors";
import { OutboundIntentRepository } from "./outbound-intent-repository";
import { readQqBindingLiveWork } from "./qq-binding-work-guard";
import { removeQqDispatchCandidate } from "./qq-dispatch-repository";
import { cancelQqConversationTask } from "./qq-task-repository";
import { nowIso, type Orm } from "./repositories";
import { WakeRepository } from "./wake-repository";

type BindingRow = { id: string; revision: number };

type ConversationId = { id: string };

/** The raw connection behind the ORM, as the other QQ repositories in this folder do it. */
function clientOf(orm: Orm): Database {
  return (orm as unknown as { $client: Database }).$client;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

/**
 * Delete one binding under a revision-checked write. `expectedRevision` is the revision the caller
 * last read; a different one is a conflict, because another surface saved the binding in between.
 */
export function deleteQqBinding(orm: Orm, id: string, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    fail("VALIDATION_ERROR", "请求参数不合法", 422);
  }
  const db = clientOf(orm);
  const at = nowIso();

  db.transaction(() => {
    const binding = db
      .query("SELECT id,revision FROM qq_bindings WHERE id=?")
      .get(id) as BindingRow | null;
    if (!binding) fail("MEMORY_NOT_FOUND", "QQ绑定不存在", 404);
    if (binding.revision !== expectedRevision) {
      fail("MEMORY_STATE_CONFLICT", "QQ绑定已变化，请重新加载后删除");
    }

    const conversationIds = (
      db
        .query("SELECT id FROM conversations WHERE channel='onebot11' AND source_id=?")
        .all(id) as ConversationId[]
    ).map((row) => row.id);
    const inConversations =
      conversationIds.length === 0 ? null : placeholders(conversationIds.length);

    const liveWork = readQqBindingLiveWork(db, conversationIds);
    if (liveWork === "task") {
      fail("MEMORY_STATE_CONFLICT", "该会话仍有正在进行的QQ任务，请稍后再删除");
    }
    if (liveWork === "run") {
      fail("MEMORY_STATE_CONFLICT", "该会话仍有未完成的Agent运行，请稍后再删除");
    }
    if (liveWork === "wake") {
      fail("MEMORY_STATE_CONFLICT", "该会话仍有进行中的唤醒，请稍后再删除");
    }
    if (liveWork === "outbound") {
      fail("MEMORY_STATE_CONFLICT", "该会话仍有消息在发送或发送结果未知，请稍后再删除");
    }

    // No refusal can happen from here on: settle the queued work first, delete the binding last.
    if (inConversations) {
      const pendingTaskIds = (
        db
          .query(
            `SELECT id FROM qq_conversation_tasks
             WHERE status='pending' AND conversation_id IN (${inConversations})`,
          )
          .all(...conversationIds) as ConversationId[]
      ).map((row) => row.id);
      const cancelled: string[] = [];
      for (const taskId of pendingTaskIds) {
        if (cancelQqConversationTask(orm, { taskId, at }) === "cancelled") cancelled.push(taskId);
      }
      if (cancelled.length > 0) {
        // A plain stored reason, not a transport error code: the binding is gone, so this task
        // was never going to run.
        db.query(
          `UPDATE qq_conversation_tasks SET error_code='binding_removed'
           WHERE error_code IS NULL AND status='cancelled'
             AND id IN (${placeholders(cancelled.length)})`,
        ).run(...cancelled);
      }

      const wakes = new WakeRepository(db);
      for (const wake of db
        .query(
          `SELECT id,through_seq FROM wake_signals
           WHERE status='pending' AND conversation_id IN (${inConversations})`,
        )
        .all(...conversationIds) as { id: string; through_seq: number }[]) {
        wakes.skipPending(wake.id, {
          at,
          throughSeq: wake.through_seq,
          errorCode: "binding_removed",
        });
      }

      const outbound = new OutboundIntentRepository(db);
      for (const intent of db
        .query(
          `SELECT id FROM outbound_intents
           WHERE status IN ('planned','delivering') AND conversation_id IN (${inConversations})`,
        )
        .all(...conversationIds) as ConversationId[]) {
        outbound.stale(intent.id, at, "DELIVERY_AUTHORITY_CHANGED");
      }
    }

    // The candidate references the binding row (FK without a cascade) and the lease references the
    // candidate, so the existing helper removes both in the right order.
    for (const candidate of db
      .query("SELECT conversation_key FROM qq_dispatch_candidates WHERE binding_id=?")
      .all(id) as { conversation_key: string }[]) {
      removeQqDispatchCandidate(orm, candidate.conversation_key);
    }

    // CAS delete: the revision check above plus the affected-rows count is the compare-and-swap.
    const removed = db
      .query("DELETE FROM qq_bindings WHERE id=? AND revision=?")
      .run(id, expectedRevision).changes;
    if (removed === 0) fail("MEMORY_STATE_CONFLICT", "QQ绑定已变化，请重新加载后删除");
  }).immediate();
}
