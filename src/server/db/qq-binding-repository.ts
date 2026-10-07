// Binding persistence and the row -> contract mapping.
//
// The contract (`qq-binding-contract.ts`) is the authority on what a binding *means*;
// this module is only how it is stored. The mapping is therefore validated by the
// contract schema on the way out, so a row that somehow holds an impossible combination
// fails loudly instead of being handed to the memory machinery as if it were sound.
//
// 群绑定的四个开关列是当前 Agent 的 (binding, agent) 记录的镜像：列留给老调用方读，开关本身按
// Agent 保存；改绑恢复新 Agent 已存的值（无记录＝全部跟随），普通保存只在 agent/scheme/开关真的
// 移动时才碰新表。

import { and, eq } from "drizzle-orm";
import type { QqBindingResponse, QqBindingTriggers } from "../../shared/contracts/qq";
import {
  isBothTrueInteractionPair,
  isEmptyQqGroupOverrides,
  normalizeQqGroupCapabilities,
  QQ_GROUP_TRIGGERS_FOLLOW,
  type QqGroupCapability,
  QqGroupCapabilitySchema,
  type QqGroupSchemeOverrides,
  QqGroupSchemeOverridesSchema,
} from "../../shared/contracts/qq-group-config";
import { fail } from "../errors";
import type { QqBinding, QqConversationIdentity } from "../services/qq-binding-contract";
import { parseQqBinding, qqConversationScope } from "../services/qq-binding-contract";
import { stableStringify } from "./json-text";
import { pendingObservationCount } from "./qq-observation-repository";
import { readQqScheme, schemeStickerCollectionIds, schemeTriggers } from "./qq-scheme-repository";
import { newId, nowIso, type Orm } from "./repositories";
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

/**
 * The wire shape of a binding, plus the one derived number the page needs to make the memory
 * entry usable: how many observations of this conversation are readable and not yet offered to
 * consolidation — without it neither "还差几条" nor "立即整理有没有东西可整理" can be answered.
 */
export function bindingResponse(orm: Orm, binding: QqBinding): QqBindingResponse {
  return {
    id: binding.id,
    account_id: binding.accountId,
    kind: binding.kind,
    peer_id: binding.peerId,
    agent_id: binding.agentId,
    scheme_id: binding.schemeId,
    paused: binding.paused,
    share_web_memory: binding.shareWebMemory,
    memory_batch_size: binding.memoryBatchSize,
    pending_observations: pendingObservationCount(orm, qqConversationScope(binding)),
    triggers: binding.triggers,
    attention: binding.attention,
    revision: binding.revision,
    authority_revision: binding.authorityRevision,
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
  /**
   * 群聊换基础方案时的显式决定：`keep` 保留本群方案差异，`reset` 清空差异（能力停用不重置）。
   * 同一 Agent 带着差异换方案而不给决定时拒绝保存；换 Agent 时按新 Agent 已保存的差异恢复。
   */
  schemeChange?: "keep" | "reset";
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
  const writeRow = (tx: Orm): QqBinding => {
    const row = tx
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
  };
  // A group binding born with explicit switches starts with a record holding them, so the mirror
  // and the record agree from the first write on — otherwise the first rebinding would lose them.
  if (binding.kind !== "group" || allNullTriggers(binding.triggers)) return writeRow(orm);
  return orm.transaction(
    (tx) => {
      const created = writeRow(tx);
      writeQqGroupAgentConfigRow(tx, {
        bindingId: created.id,
        agentId: created.agentId,
        overrides: overridesWithTriggers({}, created.triggers),
        disabledCapabilities: [],
        expectedRevision: 0,
      });
      return created;
    },
    { behavior: "immediate" },
  );
}

/**
 * Persist a binding produced by the contract, with compare-and-swap on `revision`; a group
 * binding also applies its cross-table effects in one IMMEDIATE transaction.
 */
export function saveQqBinding(orm: Orm, args: SaveQqBindingArgs): QqBinding {
  const before = readQqBinding(orm, args.binding.id);
  if (before === null) fail("MEMORY_NOT_FOUND", "QQ绑定不存在", 404);
  assertBindingInteractionPair(orm, before, args.binding);
  if (!needsGroupEffects(before, args.binding)) return saveQqBindingRow(orm, args);
  return orm.transaction(
    (tx) => {
      const current = readQqBinding(tx, args.binding.id);
      if (current === null) fail("MEMORY_NOT_FOUND", "QQ绑定不存在", 404);
      if (current.revision !== args.expectedRevision) {
        fail("MEMORY_STATE_CONFLICT", "QQ绑定已变化，请重新加载后保存");
      }
      return writeQqBindingRow(tx, applyGroupEffects(tx, current, args), args.expectedRevision);
    },
    { behavior: "immediate" },
  );
}

/** CAS + row write only (no cross-table effects); the group-config save composes its own record writes in the same transaction. */
export function saveQqBindingRow(orm: Orm, args: SaveQqBindingArgs): QqBinding {
  const current = readQqBinding(orm, args.binding.id);
  if (current === null) fail("MEMORY_NOT_FOUND", "QQ绑定不存在", 404);
  if (current.revision !== args.expectedRevision) {
    fail("MEMORY_STATE_CONFLICT", "QQ绑定已变化，请重新加载后保存");
  }
  assertBindingInteractionPair(orm, current, args.binding);
  return writeQqBindingRow(orm, args.binding, args.expectedRevision);
}

/**
 * 模式互斥的绑定保存边界（原始组合校验，不用 legacy 归一后的读值）：
 *  - 请求显式把两个开关同时写成 true —— 原始拒绝；
 *  - 触发器或基础方案变化后，raw 组合解析出的生效对双 true（如 follow_up=true 且方案
 *    chiming_in=true）—— 拒绝。
 * 读取路径的 legacy 双 true 解释（chiming_in 优先）不在写边界重演，也不强迫无关保存
 * 先归一历史行。
 */
function assertBindingInteractionPair(orm: Orm, before: QqBinding, next: QqBinding): void {
  // 只有连续/自主这对开关本身变化、或换了基础方案才进入互斥校验；direct_reply/
  // idle_topic 的单独变更不是 pair 修改，legacy raw 双 true 的无关保存不强迫归一。
  const pairMoved =
    before.triggers.follow_up !== next.triggers.follow_up ||
    before.triggers.chiming_in !== next.triggers.chiming_in ||
    before.schemeId !== next.schemeId;
  if (!pairMoved) return;
  if (isBothTrueInteractionPair(next.triggers)) {
    fail("MEMORY_SOURCE_INVALID", "连续交谈与自主接话互斥，开启一项时另一项必须关闭");
  }
  const scheme = readQqScheme(orm, next.schemeId);
  if (scheme === null) return;
  const base = schemeTriggers(scheme);
  const rawEffective = {
    follow_up: next.triggers.follow_up ?? base.follow_up,
    chiming_in: next.triggers.chiming_in ?? base.chiming_in,
  };
  if (isBothTrueInteractionPair(rawEffective)) {
    fail("MEMORY_SOURCE_INVALID", "连续交谈与自主接话互斥，开启一项时另一项必须关闭");
  }
}

/** The row write itself; the read revision travels into the WHERE clause, and an unchanged save writes nothing. */
function writeQqBindingRow(orm: Orm, binding: QqBinding, expectedRevision: number): QqBinding {
  if (binding.revision === expectedRevision) {
    const current = readQqBinding(orm, binding.id);
    if (current === null) fail("MEMORY_NOT_FOUND", "QQ绑定不存在", 404);
    return current;
  }
  const updated = orm
    .update(schema.qqBindings)
    .set({
      agentId: binding.agentId,
      schemeId: binding.schemeId,
      paused: binding.paused ? 1 : 0,
      // The module switches travel with every save: the contract already merged them, so writing
      // them here is what keeps "the whole group travels" true (0029).
      ...triggerColumns(binding.triggers),
      // The attention list travels the same way (0031): absent in the patch means the contract
      // carried the old value forward, so writing it is a no-op rather than a loss.
      ...attentionColumns(binding.attention),
      shareWebMemory: binding.shareWebMemory ? 1 : 0,
      memoryBatchSize: binding.memoryBatchSize,
      ownerIdentityRevision: binding.ownerIdentityRevision,
      revision: binding.revision,
      authorityRevision: binding.authorityRevision,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(eq(schema.qqBindings.id, binding.id), eq(schema.qqBindings.revision, expectedRevision)),
    )
    .returning()
    .get();
  if (!updated) fail("MEMORY_STATE_CONFLICT", "QQ绑定已变化，请重新加载后保存");
  return toContractQqBinding(updated);
}

// ---- 本群 Agent 配置的记录：`triggers` 组与绑定四列是同一份值的两种读法，两个写入口保持同步。 ----

export type QqGroupAgentConfigRow = typeof schema.qqGroupAgentConfigs.$inferSelect;

/** 解析后的记录。revision 0 是"还没有记录"的虚拟默认，不存在对应的行。 */
export interface QqGroupAgentConfigView {
  readonly overrides: QqGroupSchemeOverrides;
  readonly disabled_capabilities: QqGroupCapability[];
  /**
   * 每项能力的生效修订：未登记的能力＝0（从未翻转）；无记录/非群也是全 0。
   * 证据失效判定用——能力每次跟随↔停用翻转都让它的修订单调 +1，关闭再恢复不回落。
   */
  readonly capability_revisions: ReadonlyMap<QqGroupCapability, number>;
  readonly revision: number;
}

/** 列里的 JSON 过不了契约时失败，而不是被"修复"成默认值（与重要的人名单同一纪律）。 */
function parseJsonColumn(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    fail("MEMORY_SOURCE_INVALID", "本群配置记录损坏，拒绝使用");
  }
}

function parseOverridesColumn(text: string): QqGroupSchemeOverrides {
  const result = QqGroupSchemeOverridesSchema.safeParse(parseJsonColumn(text));
  if (!result.success) fail("MEMORY_SOURCE_INVALID", "本群配置记录损坏，拒绝使用");
  return result.data;
}

function parseCapabilitiesColumn(text: string): QqGroupCapability[] {
  const result = QqGroupCapabilitySchema.array().safeParse(parseJsonColumn(text));
  if (!result.success) fail("MEMORY_SOURCE_INVALID", "本群配置记录损坏，拒绝使用");
  return normalizeQqGroupCapabilities(result.data);
}

/**
 * 能力修订列的语义校验：表上的 CHECK 只保证 JSON object；这里要求每个键都是**已登记**能力、
 * 每个值都是非负整数。任一破损都失败而不是"修复"——行的合法性来自系统边界，读坏数据不能装好。
 */
function parseCapabilityRevisionsColumn(text: string): ReadonlyMap<QqGroupCapability, number> {
  const value = parseJsonColumn(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("MEMORY_SOURCE_INVALID", "本群能力修订记录损坏，拒绝使用");
  }
  const revisions = new Map<QqGroupCapability, number>();
  for (const [key, epoch] of Object.entries(value)) {
    const capability = QqGroupCapabilitySchema.safeParse(key);
    if (!capability.success || typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
      fail("MEMORY_SOURCE_INVALID", "本群能力修订记录损坏，拒绝使用");
    }
    revisions.set(capability.data, epoch);
  }
  return revisions;
}

/** 全登记能力的修订视图：记录里没有的能力＝隐式 0（从未翻转）。 */
export function resolveQqGroupCapabilityRevisions(
  stored: ReadonlyMap<QqGroupCapability, number>,
): ReadonlyMap<QqGroupCapability, number> {
  const revisions = new Map<QqGroupCapability, number>();
  for (const capability of QqGroupCapabilitySchema.options) {
    revisions.set(capability, stored.get(capability) ?? 0);
  }
  return revisions;
}

export function parseQqGroupAgentConfigRow(row: QqGroupAgentConfigRow): QqGroupAgentConfigView {
  return {
    overrides: parseOverridesColumn(row.schemeOverrides),
    disabled_capabilities: parseCapabilitiesColumn(row.disabledCapabilities),
    capability_revisions: resolveQqGroupCapabilityRevisions(
      parseCapabilityRevisionsColumn(row.capabilityRevisions),
    ),
    revision: row.revision,
  };
}

/** One (binding, agent) record as stored, or `null` when there is none. */
export function readQqGroupConfigRow(
  orm: Orm,
  bindingId: string,
  agentId: string,
): QqGroupAgentConfigRow | null {
  return (
    orm
      .select()
      .from(schema.qqGroupAgentConfigs)
      .where(
        and(
          eq(schema.qqGroupAgentConfigs.bindingId, bindingId),
          eq(schema.qqGroupAgentConfigs.agentId, agentId),
        ),
      )
      .get() ?? null
  );
}

export interface QqGroupAgentConfigWrite {
  readonly bindingId: string;
  readonly agentId: string;
  readonly overrides: QqGroupSchemeOverrides;
  readonly disabledCapabilities: readonly QqGroupCapability[];
  /** 0 = the caller saw no record; anything else is the revision the caller read. */
  readonly expectedRevision: number;
}

/**
 * 每项能力「跟随 ↔ 停用」的翻转计数：两个方向都 +1，没翻的能力原值保留；已存的行不可能把
 * 修订降回去或删掉——恢复停用过的能力后，之前签发的证据引用的旧修订不会重新成立。
 * 无记录＝全部跟随：首次记录里此刻停用的能力从隐式 0 翻到 1。
 */
function capabilityRevisionsAfterChange(
  stored: ReadonlyMap<QqGroupCapability, number>,
  previous: readonly QqGroupCapability[],
  next: readonly QqGroupCapability[],
): Map<QqGroupCapability, number> {
  const before = new Set(previous);
  const after = new Set(next);
  const revisions = new Map(stored);
  for (const capability of new Set([...before, ...after])) {
    if (before.has(capability) === after.has(capability)) continue;
    revisions.set(capability, (revisions.get(capability) ?? 0) + 1);
  }
  return revisions;
}

/** Same content is a no-op; a stale revision is a conflict; an existing row is never deleted, so its revision never falls back to 0. */
export function writeQqGroupAgentConfigRow(orm: Orm, args: QqGroupAgentConfigWrite): void {
  const row = readQqGroupConfigRow(orm, args.bindingId, args.agentId);
  if ((row?.revision ?? 0) !== args.expectedRevision) {
    fail("MEMORY_STATE_CONFLICT", "本群配置已变化，请重新加载后保存");
  }
  const overrides = normalizeOverridesForStorage(args.overrides);
  const capabilities = normalizeQqGroupCapabilities(args.disabledCapabilities);
  if (row === null && isEmptyQqGroupOverrides(overrides) && capabilities.length === 0) return;
  if (
    row !== null &&
    sameStoredOverrides(row.schemeOverrides, overrides) &&
    sameStoredJson(row.disabledCapabilities, capabilities)
  ) {
    return;
  }
  const overridesJson = stableStringify(overrides);
  const capabilitiesJson = stableStringify(capabilities);
  if (row === null) {
    // 首次记录：此刻停用的能力＝第一次翻转，修订 1；其余保持隐式 0，不落键。
    const revisions = capabilityRevisionsAfterChange(new Map(), [], capabilities);
    orm
      .insert(schema.qqGroupAgentConfigs)
      .values({
        id: newId(),
        bindingId: args.bindingId,
        agentId: args.agentId,
        schemeOverrides: overridesJson,
        disabledCapabilities: capabilitiesJson,
        capabilityRevisions: stableStringify(Object.fromEntries(revisions)),
        revision: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    return;
  }
  const revisions = capabilityRevisionsAfterChange(
    parseCapabilityRevisionsColumn(row.capabilityRevisions),
    parseCapabilitiesColumn(row.disabledCapabilities),
    capabilities,
  );
  const updated = orm
    .update(schema.qqGroupAgentConfigs)
    .set({
      schemeOverrides: overridesJson,
      disabledCapabilities: capabilitiesJson,
      capabilityRevisions: stableStringify(Object.fromEntries(revisions)),
      revision: row.revision + 1,
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(schema.qqGroupAgentConfigs.bindingId, args.bindingId),
        eq(schema.qqGroupAgentConfigs.agentId, args.agentId),
        eq(schema.qqGroupAgentConfigs.revision, row.revision),
      ),
    )
    .returning()
    .get();
  if (!updated) fail("MEMORY_STATE_CONFLICT", "本群配置已变化，请重新加载后保存");
}

/** 差异先过一遍共享契约再落库：库里永远是归一化的稀疏 JSON，回读不再需要二次收缩。 */
function normalizeOverridesForStorage(value: QqGroupSchemeOverrides): QqGroupSchemeOverrides {
  const result = QqGroupSchemeOverridesSchema.safeParse(value);
  if (!result.success) fail("MEMORY_SOURCE_INVALID", "本群方案差异非法，拒绝保存");
  return result.data;
}

function sameStoredOverrides(text: string, value: QqGroupSchemeOverrides): boolean {
  try {
    return (
      stableStringify(QqGroupSchemeOverridesSchema.parse(JSON.parse(text))) ===
      stableStringify(value)
    );
  } catch {
    return false;
  }
}

function sameStoredJson(text: string, value: unknown): boolean {
  try {
    return stableStringify(JSON.parse(text)) === stableStringify(value);
  } catch {
    return false;
  }
}

export function sameBindingTriggers(left: QqBindingTriggers, right: QqBindingTriggers): boolean {
  return (
    left.direct_reply === right.direct_reply &&
    left.follow_up === right.follow_up &&
    left.chiming_in === right.chiming_in &&
    left.idle_topic === right.idle_topic
  );
}

function allNullTriggers(triggers: QqBindingTriggers): boolean {
  return (
    triggers.direct_reply === null &&
    triggers.follow_up === null &&
    triggers.chiming_in === null &&
    triggers.idle_topic === null
  );
}

/** 记录 `triggers` 组 → 绑定四列（缺成员＝跟随）。 */
export function triggersFromOverrides(overrides: QqGroupSchemeOverrides): QqBindingTriggers {
  const group = overrides.triggers;
  return {
    direct_reply: group?.direct_reply ?? null,
    follow_up: group?.follow_up ?? null,
    chiming_in: group?.chiming_in ?? null,
    idle_topic: group?.idle_topic ?? null,
  };
}

/** 四个开关 → 记录里的 `triggers` 组；全 null 不是覆盖，组被去掉。 */
function overridesWithTriggers(
  base: QqGroupSchemeOverrides,
  triggers: QqBindingTriggers,
): QqGroupSchemeOverrides {
  const next: QqGroupSchemeOverrides = { ...base };
  if (allNullTriggers(triggers)) delete next.triggers;
  else next.triggers = { ...triggers };
  return next;
}

/** 素材集合不能借本群配置扩大授权：所选必须是基础方案已授权集合的子集。 */
export function assertQqGroupStickerSubset(
  orm: Orm,
  schemeId: string,
  overrides: QqGroupSchemeOverrides,
): void {
  const selected = overrides.sticker_collections?.collection_ids;
  if (selected === undefined) return;
  const authorized = new Set(schemeStickerCollectionIds(orm, schemeId));
  if (selected.some((id) => !authorized.has(id))) {
    fail("MEMORY_SOURCE_INVALID", "本群选择的素材集合超出基础方案授权，不能借此扩大授权");
  }
}

function needsGroupEffects(before: QqBinding, after: QqBinding): boolean {
  if (before.kind !== "group") return false;
  return (
    before.agentId !== after.agentId ||
    before.schemeId !== after.schemeId ||
    !sameBindingTriggers(before.triggers, after.triggers)
  );
}

/**
 * The cross-table part of a group save. `current` is the stored binding; the result is the
 * binding to persist — normally `args.binding`, except on rebinding, where the new agent's
 * saved switches are restored.
 */
function applyGroupEffects(orm: Orm, current: QqBinding, args: SaveQqBindingArgs): QqBinding {
  const target = args.binding;
  const agentChanged = current.agentId !== target.agentId;
  const schemeChanged = current.schemeId !== target.schemeId;
  const triggersChanged = !sameBindingTriggers(current.triggers, target.triggers);
  const record = readQqGroupConfigRow(
    orm,
    current.id,
    agentChanged ? target.agentId : current.agentId,
  );
  const view = record === null ? null : parseQqGroupAgentConfigRow(record);

  if (agentChanged) {
    // 改绑：本群的开关属于 Agent。恢复新 Agent 已保存的差异（无记录＝全部跟随）；请求里带的
    // 触发器补丁描述的是旧 Agent 的镜像，不适用。旧 Agent 的记录原样保留，切回时恢复；恢复出来
    // 的素材集合可能已超出现行授权（期间被撤权、用户没重新授权），运行时按交集生效，不硬失败。
    return {
      ...target,
      triggers:
        view === null ? { ...QQ_GROUP_TRIGGERS_FOLLOW } : triggersFromOverrides(view.overrides),
    };
  }

  if (schemeChanged) {
    const hasOverrides = view !== null && !isEmptyQqGroupOverrides(view.overrides);
    if (hasOverrides && args.schemeChange === undefined) {
      fail("MEMORY_STATE_CONFLICT", "本群已有方案差异，换方案需要明确保留还是重置");
    }
    if (args.schemeChange === "reset") {
      // 全部跟随新方案：清空全部方案差异（含本次请求带的四个开关），能力停用不重置。
      writeQqGroupAgentConfigRow(orm, {
        bindingId: current.id,
        agentId: current.agentId,
        overrides: {},
        disabledCapabilities: view?.disabled_capabilities ?? [],
        expectedRevision: view?.revision ?? 0,
      });
      return { ...target, triggers: { ...QQ_GROUP_TRIGGERS_FOLLOW } };
    }
    // keep（或本来就没有差异）：差异原样保留；素材集合超界交给运行时交集，不在这里硬失败。
    if (triggersChanged) syncTriggers(orm, current, view, target.triggers);
    return target;
  }

  if (triggersChanged) syncTriggers(orm, current, view, target.triggers);
  return target;
}

/** 镜像四列 → 记录的 triggers 组：只动这一组，其余差异与能力停用原样保留。 */
function syncTriggers(
  orm: Orm,
  binding: QqBinding,
  view: QqGroupAgentConfigView | null,
  triggers: QqBindingTriggers,
): void {
  writeQqGroupAgentConfigRow(orm, {
    bindingId: binding.id,
    agentId: binding.agentId,
    overrides: overridesWithTriggers(view?.overrides ?? {}, triggers),
    disabledCapabilities: view?.disabled_capabilities ?? [],
    expectedRevision: view?.revision ?? 0,
  });
}
