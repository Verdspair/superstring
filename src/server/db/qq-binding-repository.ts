// Binding persistence and the row -> contract mapping.
//
// The contract (`qq-binding-contract.ts`) is the authority on what a binding *means*;
// this module is only how it is stored. The mapping is therefore validated by the
// contract schema on the way out, so a row that somehow holds an impossible combination
// fails loudly instead of being handed to the memory machinery as if it were sound.

import { and, eq } from "drizzle-orm";
import { fail } from "../errors";
import type { QqBinding, QqConversationIdentity } from "../services/qq-binding-contract";
import { parseQqBinding } from "../services/qq-binding-contract";
import { nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

export type QqBindingRow = typeof schema.qqBindings.$inferSelect;

/**
 * Stored integers become the contract's booleans, and `conversation_kind` becomes the
 * contract's `kind`. The result goes through the contract parser, so the CHECK
 * constraints in SQL and the refinements in the contract have to agree — a silent
 * divergence here would let a paused binding behave as unpaused.
 */
export function toContractQqBinding(row: QqBindingRow): QqBinding {
  return parseQqBinding({
    id: row.id,
    accountId: row.accountId,
    kind: row.conversationKind,
    peerId: row.peerId,
    agentId: row.agentId,
    schemeId: row.schemeId,
    paused: row.paused === 1,
    shareWebMemory: row.shareWebMemory === 1,
    memoryBatchSize: row.memoryBatchSize,
    // Nullable columns are three-state: NULL follows the scheme, 0/1 override it (0029).
    triggers: {
      direct_reply: row.triggerDirectReply === null ? null : row.triggerDirectReply === 1,
      follow_up: row.triggerFollowUp === null ? null : row.triggerFollowUp === 1,
      chiming_in: row.triggerChimingIn === null ? null : row.triggerChimingIn === 1,
      idle_topic: row.triggerIdleTopic === null ? null : row.triggerIdleTopic === 1,
    },
    ownerIdentityRevision: row.ownerIdentityRevision,
    revision: row.revision,
    authorityRevision: row.authorityRevision,
    // 0031: NULL mode and NULL members are the stored form of "no list at all"; the column CHECK
    // only guarantees valid JSON, so the contract is what refuses a half-written pair.
    attention: attentionFromColumns(row),
  });
}

/** The JSON column back to the contract's list. A corrupt column must fail, not be "repaired". */
function attentionFromColumns(row: QqBindingRow): QqBinding["attention"] {
  if (row.attentionMode === null) return { mode: "off", members: [] };
  if (row.attentionMembers === null) {
    // Reachable only by writing SQL directly: the contract refuses mode-without-members.
    fail("MEMORY_SOURCE_INVALID", "重要的人名单缺少成员，拒绝使用这条绑定");
  }
  return {
    mode: row.attentionMode === "hard" ? "hard" : "soft",
    members: JSON.parse(row.attentionMembers) as string[],
  };
}

/** The two columns, from the contract's attention group. `off` clears both. */
function attentionColumns(attention: QqBinding["attention"]) {
  return {
    attentionMode: attention.mode === "off" ? null : attention.mode,
    attentionMembers: attention.mode === "off" ? null : JSON.stringify([...attention.members]),
  };
}

/** The four nullable columns, from the contract's three-state group. */
function triggerColumns(triggers: QqBinding["triggers"]) {
  const column = (value: boolean | null) => (value === null ? null : value ? 1 : 0);
  return {
    triggerDirectReply: column(triggers.direct_reply),
    triggerFollowUp: column(triggers.follow_up),
    triggerChimingIn: column(triggers.chiming_in),
    triggerIdleTopic: column(triggers.idle_topic),
  };
}

export function readQqBinding(orm: Orm, id: string): QqBinding | null {
  const row = orm.select().from(schema.qqBindings).where(eq(schema.qqBindings.id, id)).get();
  return row ? toContractQqBinding(row) : null;
}

/**
 * The binding for one conversation. At most one can exist: the table has a unique
 * constraint on (account, kind, peer). A missing binding is a normal answer — an
 * unbound conversation is simply not ours to record — so it returns `null` rather
 * than throwing.
 */
export function readBindingByConversation(
  orm: Orm,
  identity: QqConversationIdentity,
): QqBinding | null {
  const row = orm
    .select()
    .from(schema.qqBindings)
    .where(
      and(
        eq(schema.qqBindings.accountId, identity.accountId),
        eq(schema.qqBindings.conversationKind, identity.kind),
        eq(schema.qqBindings.peerId, identity.peerId),
      ),
    )
    .get();
  return row ? toContractQqBinding(row) : null;
}

/** Every binding, oldest first, for a settings or diagnostics surface. */
export function readQqBindings(orm: Orm): QqBinding[] {
  return orm
    .select()
    .from(schema.qqBindings)
    .orderBy(schema.qqBindings.createdAt, schema.qqBindings.id)
    .all()
    .map(toContractQqBinding);
}

export interface SaveQqBindingArgs {
  binding: QqBinding;
  /** The revision the caller read; a mismatch is a conflict, not an overwrite. */
  expectedRevision: number;
}

/**
 * Persist a binding the contract just created.
 *
 * A conversation has at most one binding, so a second one is reported as a conflict rather
 * than as a raw constraint error: the user's fix is "edit the existing binding", not
 * "you typed something invalid".
 */
export function insertQqBinding(orm: Orm, binding: QqBinding): QqBinding {
  const existing = readBindingByConversation(orm, {
    accountId: binding.accountId,
    kind: binding.kind,
    peerId: binding.peerId,
  });
  if (existing) fail("MEMORY_STATE_CONFLICT", "该会话已有绑定，请改为修改这条绑定");
  const row = orm
    .insert(schema.qqBindings)
    .values({
      id: binding.id,
      accountId: binding.accountId,
      conversationKind: binding.kind,
      peerId: binding.peerId,
      agentId: binding.agentId,
      schemeId: binding.schemeId,
      paused: binding.paused ? 1 : 0,
      ...triggerColumns(binding.triggers),
      ...attentionColumns(binding.attention),
      shareWebMemory: binding.shareWebMemory ? 1 : 0,
      memoryBatchSize: binding.memoryBatchSize,
      ownerIdentityRevision: binding.ownerIdentityRevision,
      revision: binding.revision,
      authorityRevision: binding.authorityRevision,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return toContractQqBinding(row);
}

/**
 * Persist a binding produced by the contract, with compare-and-swap on `revision`.
 * The caller carries the whole decision (including whether this was an authority
 * change), so this function never recomputes revisions — it only refuses to clobber a
 * row that moved underneath the caller.
 */
export function saveQqBinding(orm: Orm, args: SaveQqBindingArgs): QqBinding {
  const current = readQqBinding(orm, args.binding.id);
  if (current === null) fail("MEMORY_NOT_FOUND", "QQ绑定不存在", 404);
  if (current.revision !== args.expectedRevision) {
    fail("MEMORY_STATE_CONFLICT", "QQ绑定已变化，请重新加载后保存");
  }
  const updated = orm
    .update(schema.qqBindings)
    .set({
      agentId: args.binding.agentId,
      schemeId: args.binding.schemeId,
      paused: args.binding.paused ? 1 : 0,
      // The module switches travel with every save: the contract already merged them, so writing
      // them here is what keeps "the whole group travels" true (0029).
      ...triggerColumns(args.binding.triggers),
      // The attention list travels the same way (0031): absent in the patch means the contract
      // carried the old value forward, so writing it is a no-op rather than a loss.
      ...attentionColumns(args.binding.attention),
      shareWebMemory: args.binding.shareWebMemory ? 1 : 0,
      memoryBatchSize: args.binding.memoryBatchSize,
      ownerIdentityRevision: args.binding.ownerIdentityRevision,
      revision: args.binding.revision,
      authorityRevision: args.binding.authorityRevision,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.qqBindings.id, args.binding.id))
    .returning()
    .get();
  if (!updated) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return toContractQqBinding(updated);
}
