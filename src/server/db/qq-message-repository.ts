// QQ 消息事实仓储（0052 `qq_message_facts` / `qq_outbound_message_facts`；规格 §13.2/13.4）。
//
// 职责（计划 T03 Step4–6）：
//   * 入站：按 event_key 落一份**可过期**的发送时事实——双昵称快照、有序片段、引用关系——
//     与永久去重身份（qq_events）分开生命周期；
//   * 幂等：同 event_key 同 facts 不刷新到期戳；同键不同事实仍拒绝（身份完整性）；
//   * backfill：历史补记先占位（revision=1），真实 live 观察可补齐**缺失**事实，但不得改写
//     已存在的冲突事实；补齐必须推进 revision，让旧 projection/source 失效（§4.5）；
//   * 出站：按 outbound_intent 存助手当前平台身份快照；发送确认后把平台 part 消息 ID 映射到
//     实际 part 正文（未确认不作为已发原文）。
//
// 事实行与正文同窗口（observationExpiresAt）：同一句话的各个部分同时到期，副本不比来源活得久。

import type { Database } from "bun:sqlite";
import { and, eq, lte, sql } from "drizzle-orm";
import type { QqMessagePart } from "../../shared/contracts/qq-message";
import { fail } from "../errors";
import { observationExpiresAt } from "../services/qq-retention";
import { readQqRetentionDays } from "./qq-settings-repository";
import { nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

export type QqMessageFactRow = typeof schema.qqMessageFacts.$inferSelect;
export type QqOutboundMessageFactRow = typeof schema.qqOutboundMessageFacts.$inferSelect;

/** facts JSON 的持久形状（片段数组原样存取；恢复渲染原顺序靠数组本身有序，§13.3）。 */
type StoredParts = QqMessagePart[];

function parseParts(json: string): StoredParts {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) fail("MEMORY_SOURCE_INVALID", "消息事实片段形状无效");
  return parsed as StoredParts;
}

export interface QqMessageFactInput {
  readonly eventKey: string;
  readonly groupCard: string | null;
  /**
   * F4（§3.1）：逐字段姓名证据来源。`'wire'`＝本次入站原值（含显式清空——值 null 但来源
   * 'wire' 是"已核清空"，与缺省不同）；`'local'`＝本次借本地目录有效值；`null`＝无证据
   * （历史未知，不伪造）。内部类型上可选（缺省即未知），真实 intake 调用方必须传。
   */
  readonly groupCardSource?: "wire" | "local" | null;
  readonly personalNickname: string | null;
  readonly personalNicknameSource?: "wire" | "local" | null;
  readonly legacyDisplayName: string | null;
  readonly nameState: "known" | "unknown" | "legacy";
  readonly parts: StoredParts;
  readonly replyToMessageId: string | null;
  readonly occurredAtSeconds: number;
}

/** 名字事实按"值＋来源"成对比较：同一名字不同来源是不同事实（§3.1 不重标）。 */
function namePairOf(input: QqMessageFactInput) {
  return {
    groupCardSource: input.groupCardSource ?? null,
    personalNicknameSource: input.personalNicknameSource ?? null,
  };
}

/** Two facts describe the same message only if every field matches; otherwise the key is refused. */
function sameFacts(
  existing: {
    groupCard: string | null;
    groupCardSource: string | null;
    personalNickname: string | null;
    personalNicknameSource: string | null;
    legacyDisplayName: string | null;
    nameState: string;
    parts: string;
    replyToMessageId: string | null;
  },
  input: QqMessageFactInput,
): boolean {
  const sources = namePairOf(input);
  return (
    existing.groupCard === input.groupCard &&
    existing.groupCardSource === sources.groupCardSource &&
    existing.personalNickname === input.personalNickname &&
    existing.personalNicknameSource === sources.personalNicknameSource &&
    existing.legacyDisplayName === input.legacyDisplayName &&
    existing.nameState === input.nameState &&
    existing.parts === JSON.stringify(input.parts) &&
    existing.replyToMessageId === input.replyToMessageId
  );
}

/**
 * 逐字段合并（§4.5 backfill 规则）：冲突即拒，缺失才补；姓名按"值＋来源"pair 处理（F4）。
 *   * 已存在的非空事实（名字/legacy/片段/关系）遇到不同的补记值 → 拒绝，不是静默跳过；
 *   * 已核清空（值 null＋来源 'wire'）是已记录的事实：补记字符串不能再复活它；
 *   * 已记录的名字带非 null 来源永不覆盖/重标——同值 wire 重放不把 local 改成 wire；
 *   * 值已记录但来源 NULL（F4 之前的 unknown-source 行）只接受同值的来源核补，不同值仍拒；
 *   * 本次缺省（值 null＋来源 NULL）不参与冲突，也不改变任何已记录事实；
 *   * 旧 legacy 行（name_state='legacy'）的单 nickname 是唯一历史证据：不补当前双名字
 *     （不能冒充历史群名片或个人昵称，§13.5），只补缺失的片段与关系。
 */
function mergeBackfill(
  existing: QqMessageFactRow,
  input: QqMessageFactInput,
): {
  groupCard: string | null;
  groupCardSource: string | null;
  personalNickname: string | null;
  personalNicknameSource: string | null;
  legacyDisplayName: string | null;
  nameState: "known" | "unknown" | "legacy";
  parts: string;
  replyToMessageId: string | null;
} {
  const inputPartsJson = JSON.stringify(input.parts);
  const hasExistingText = existing.parts !== "[]";
  if (hasExistingText && inputPartsJson !== "[]" && inputPartsJson !== existing.parts) {
    fail("MEMORY_SOURCE_INVALID", "已存在的消息片段不允许被回填改写");
  }
  const source = namePairOf(input);
  // 名字 pair 冲突矩阵：haveValue/givenValue × haveSource/givenSource。
  const mergeName = (
    existingValue: string | null,
    existingSource: string | null,
    givenValue: string | null,
    givenSource: string | null,
  ): { value: string | null; source: string | null } => {
    if (givenValue === null && givenSource === null) {
      // 本次缺省：不参与冲突，也不核补来源。
      return { value: existingValue, source: existingSource };
    }
    if (existingValue !== null) {
      if (givenValue !== null && givenValue !== existingValue) {
        fail("MEMORY_SOURCE_INVALID", "已存在的消息姓名事实不允许被回填改写");
      }
      if (givenValue === null && givenSource !== null) {
        fail("MEMORY_SOURCE_INVALID", "已存在的消息姓名事实不允许被本次清空声明覆盖");
      }
      if (givenValue !== null && givenSource !== null && existingSource === null) {
        // 值已记录但来源未知（历史行）：同值 wire 核补落来源，不是改写。
        return { value: existingValue, source: givenSource };
      }
      // 已有明确来源（或补记来源缺失）：永不覆盖/重标；同值不推进。
      return { value: existingValue, source: existingSource };
    }
    if (existingValue === null && existingSource !== null) {
      // 已核清空（值 null＋来源明确）：字符串补记不得复活它。
      if (givenValue !== null) {
        fail("MEMORY_SOURCE_INVALID", "已核实的名字清空不允许被回填复活");
      }
      return { value: null, source: existingSource };
    }
    // 真缺失（值与来源都 NULL）：本次 wire/local 带来的事实补上。
    return { value: givenValue, source: givenSource };
  };
  const groupCard = mergeName(
    existing.groupCard,
    existing.groupCardSource,
    input.groupCard,
    source.groupCardSource,
  );
  const personalNickname = mergeName(
    existing.personalNickname,
    existing.personalNicknameSource,
    input.personalNickname,
    source.personalNicknameSource,
  );
  if (
    existing.legacyDisplayName !== null &&
    input.legacyDisplayName !== null &&
    input.legacyDisplayName !== existing.legacyDisplayName
  ) {
    fail("MEMORY_SOURCE_INVALID", "已存在的消息姓名事实不允许被回填改写");
  }
  if (
    existing.replyToMessageId !== null &&
    input.replyToMessageId !== null &&
    input.replyToMessageId !== existing.replyToMessageId
  ) {
    fail("MEMORY_SOURCE_INVALID", "已存在的引用关系不允许被回填改写");
  }
  if (existing.nameState === "legacy") {
    // legacy 行不采用补记的双名字/双来源：单昵称仍是唯一历史证据（§13.5）。
    return {
      groupCard: existing.groupCard,
      groupCardSource: existing.groupCardSource,
      personalNickname: existing.personalNickname,
      personalNicknameSource: existing.personalNicknameSource,
      legacyDisplayName: existing.legacyDisplayName,
      nameState: "legacy",
      parts: hasExistingText ? existing.parts : inputPartsJson,
      replyToMessageId: existing.replyToMessageId ?? input.replyToMessageId,
    };
  }
  const nameState: "known" | "unknown" | "legacy" =
    groupCard.value || personalNickname.value ? "known" : "unknown";
  return {
    groupCard: groupCard.value,
    groupCardSource:
      groupCard.value === null && groupCard.source === "wire" ? "wire" : groupCard.source,
    personalNickname: personalNickname.value,
    personalNicknameSource:
      personalNickname.value === null && personalNickname.source === "wire"
        ? "wire"
        : personalNickname.source,
    legacyDisplayName: existing.legacyDisplayName ?? input.legacyDisplayName,
    nameState,
    parts: hasExistingText ? existing.parts : inputPartsJson,
    replyToMessageId: existing.replyToMessageId ?? input.replyToMessageId,
  };
}

/**
 * Record the per-message fact snapshot. Callers write it inside the same transaction as
 * the permanent identity and the body (recordObservation), so "who spoke" can never be
 * separated from "what they said" by a crash.
 *
 * Idempotency: a re-delivery carrying identical facts returns the existing row and does
 * NOT refresh the expiry (the window was fixed at the message's own time). A reused key
 * with different facts is refused — a later delivery must not rewrite the snapshot the
 * first one preserved.
 */
export function recordQqMessageFact(
  orm: Orm,
  input: QqMessageFactInput,
  retentionDays: number = readQqRetentionDays(orm),
): QqMessageFactRow {
  const event = orm
    .select()
    .from(schema.qqEvents)
    .where(eq(schema.qqEvents.eventKey, input.eventKey))
    .get();
  if (!event) fail("MEMORY_SOURCE_INVALID", "观察去重身份不存在，不能保存消息事实");
  const partsJson = JSON.stringify(input.parts);
  const sources = namePairOf(input);
  const existing = orm
    .select()
    .from(schema.qqMessageFacts)
    .where(eq(schema.qqMessageFacts.eventKey, input.eventKey))
    .get();
  if (existing) {
    if (!sameFacts(existing, input)) {
      fail("MEMORY_SOURCE_INVALID", "同一消息键描述了不同事实，拒绝覆盖");
    }
    return existing;
  }
  const row = orm
    .insert(schema.qqMessageFacts)
    .values({
      eventKey: input.eventKey,
      groupCard: input.groupCard,
      groupCardSource: sources.groupCardSource,
      personalNickname: input.personalNickname,
      personalNicknameSource: sources.personalNicknameSource,
      legacyDisplayName: input.legacyDisplayName,
      nameState: input.nameState,
      parts: partsJson,
      replyToMessageId: input.replyToMessageId,
      revision: 1,
      expiresAt: observationExpiresAt(input.occurredAtSeconds, retentionDays),
      recordedAt: nowIso(),
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return row;
}

/**
 * Backfill one historical fact row (§4.5): the journal append may have claimed the event
 * key first, so the snapshot can be missing while the identity exists. A live observation
 * may fill MISSING facts, but a field already present is never overwritten — a conflict
 * between backfill and reality stays as recorded, not "repaired".
 *
 * Filling advances `revision` so projections and sources derived from the placeholder stop
 * being available (the placeholder and the filled row are different revisions).
 */
export function backfillQqMessageFact(
  orm: Orm,
  input: QqMessageFactInput,
  retentionDays: number = readQqRetentionDays(orm),
): QqMessageFactRow {
  const existing = orm
    .select()
    .from(schema.qqMessageFacts)
    .where(eq(schema.qqMessageFacts.eventKey, input.eventKey))
    .get();
  if (existing) {
    if (sameFacts(existing, input)) return existing;
    // 逐字段缺失合并（§4.5）：非空字段永不改写，冲突拒绝；只补缺失并推进 revision。
    const merged = mergeBackfill(existing, input);
    const changed =
      merged.groupCard !== existing.groupCard ||
      merged.groupCardSource !== existing.groupCardSource ||
      merged.personalNickname !== existing.personalNickname ||
      merged.personalNicknameSource !== existing.personalNicknameSource ||
      merged.legacyDisplayName !== existing.legacyDisplayName ||
      merged.nameState !== existing.nameState ||
      merged.parts !== existing.parts ||
      merged.replyToMessageId !== existing.replyToMessageId;
    if (!changed) return existing;
    // 精确 CAS：revision 仍是从读到的值起步，防止并发补记双跳。
    const row = orm
      .update(schema.qqMessageFacts)
      .set({
        groupCard: merged.groupCard,
        groupCardSource: merged.groupCardSource,
        personalNickname: merged.personalNickname,
        personalNicknameSource: merged.personalNicknameSource,
        legacyDisplayName: merged.legacyDisplayName,
        nameState: merged.nameState,
        parts: merged.parts,
        replyToMessageId: merged.replyToMessageId,
        revision: existing.revision + 1,
        recordedAt: nowIso(),
      })
      .where(
        and(
          eq(schema.qqMessageFacts.eventKey, input.eventKey),
          eq(schema.qqMessageFacts.revision, existing.revision),
        ),
      )
      .returning()
      .get();
    if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
    return row;
  }
  return recordQqMessageFact(orm, input, retentionDays);
}

/**
 * The one inbound-fact protection predicate, shared by the retention purge and the storage
 * management category (T14 manual cleanup): an expired fact stays physically deletable only
 * when nothing still holds it. Parameterised by the SQL alias the caller uses for
 * `qq_message_facts` so the purge, the list's protected flag, the preview counts and the
 * DELETE all compile the same text — one definition, not copies.
 *
 * A fact is protected when a nonterminal run whose exact context snapshot references it
 * (`qq_message_fact`, id = event_key), or an agent task whose sources reference it and is
 * not yet safe — nonterminal, or still holding a `running`/`waiting_approval`/`unknown`
 * call even in a terminal state (same scope as `TASK_PROTECTION_SQL`: an interrupted write
 * call keeps its unknown outcome forever, so the task payload evidence it anchors must not
 * lose its source). Terminal runs hold nothing: redaction has already removed their
 * snapshot bodies (expired/revoked snapshots store NULL), so an exact-only check is
 * proportionate to real source holding. All references are matched on exact kind + id: a
 * kind this predicate does not name can never protect a row.
 */
export function qqMessageFactProtected(alias: string): string {
  return `(
    EXISTS (SELECT 1 FROM context_snapshots c
      JOIN agent_steps st ON st.step_id = c.step_id
      JOIN agent_runs r ON r.run_id = st.run_id
      WHERE c.status = 'exact' AND r.status NOT IN ('completed','no_output','failed','cancelled')
      AND EXISTS (SELECT 1 FROM json_each(c.source_refs) j
        WHERE json_extract(j.value,'$.kind') = 'qq_message_fact'
        AND json_extract(j.value,'$.id') = ${alias}.event_key))
    OR EXISTS (SELECT 1 FROM agent_tasks t
      WHERE (t.status NOT IN ('completed','failed','cancelled')
        OR EXISTS (SELECT 1 FROM agent_task_calls bc
          WHERE bc.task_id = t.id
          AND bc.status IN ('running','waiting_approval','unknown')))
      AND EXISTS (SELECT 1 FROM json_each(t.sources) j
        WHERE json_extract(j.value,'$.kind') = 'qq_message_fact'
        AND json_extract(j.value,'$.id') = ${alias}.event_key))
  )`;
}

/**
 * Expired inbound facts are purged only when nothing still holds them (the shared
 * {@link qqMessageFactProtected} predicate). Expiry already makes the row unreadable
 * (`qqMessageFactSourceAccess` answers `expired` while the row exists, `revoked` only once
 * it is physically gone); protection only defers the physical delete. The permanent
 * `qq_events` identity is never deleted here. Returns the rows actually deleted (0 is a
 * legal no-op, R16).
 */
export function purgeExpiredQqMessageFacts(orm: Orm, now: string = nowIso()): number {
  const deleted = orm
    .delete(schema.qqMessageFacts)
    .where(
      and(
        lte(schema.qqMessageFacts.expiresAt, now),
        sql.raw(`NOT ${qqMessageFactProtected("qq_message_facts")}`),
      ),
    )
    .returning({ eventKey: schema.qqMessageFacts.eventKey })
    .all();
  return deleted.length;
}

// ---- 出站事实（§13.4） -----------------------------------------------------------------

export interface QqOutboundIdentity {
  /** 助手真实发送账号（QQ 号）；Agent UUID 不充当 QQ 号（§3.2）。 */
  readonly qq: string;
  readonly groupCard: string | null;
  readonly personalNickname: string | null;
  readonly legacyDisplayName: string | null;
  readonly nameState: "known" | "unknown" | "legacy";
}

/** One ordered part of a multi-part output, with its platform message ID once confirmed. */
export interface QqOutboundPartFact {
  readonly kind: "text" | "sticker";
  readonly ordinal: number;
  /** 已确认发送才有平台消息 ID；未确认不作为已发原文（§13.4）。 */
  readonly platformMessageId: string | null;
  readonly text: string | null;
}

/**
 * Store the assistant's platform identity snapshot at commit time (§3.2/§13.4). The
 * identity is a fact of the moment of sending: the real sending account plus the
 * preferred name then in force — never the Agent UUID, and for private chats never a
 * group card invented from the login name.
 */
export function recordQqOutboundMessageFact(
  orm: Orm,
  input: {
    readonly intentId: string;
    readonly accountId: string;
    readonly agentId: string;
    readonly identity: QqOutboundIdentity;
    readonly occurredAtSeconds: number;
  },
  retentionDays: number = readQqRetentionDays(orm),
): QqOutboundMessageFactRow {
  const existing = orm
    .select()
    .from(schema.qqOutboundMessageFacts)
    .where(eq(schema.qqOutboundMessageFacts.intentId, input.intentId))
    .get();
  if (existing) return existing;
  const row = orm
    .insert(schema.qqOutboundMessageFacts)
    .values({
      intentId: input.intentId,
      accountId: input.accountId,
      agentId: input.agentId,
      groupCard: input.identity.groupCard,
      personalNickname: input.identity.personalNickname,
      legacyDisplayName: input.identity.legacyDisplayName,
      parts: "[]",
      revision: 1,
      expiresAt: observationExpiresAt(input.occurredAtSeconds, retentionDays),
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return row;
}

/**
 * Map a confirmed platform part message ID onto the actual part text (§13.4). The
 * mapping happens only after the send receipt confirmed that part; an unconfirmed or
 * unknown part never becomes "sent原文". Idempotent per ordinal: re-confirming the same
 * part with the same facts keeps the row unchanged (no revision churn).
 *
 * The optional `transactionDb` joins a caller-owned outer transaction (the delivery
 * settles the receipt and maps the part atomically), mirroring `recordQqSend`.
 */
export function confirmQqOutboundPart(
  orm: Orm,
  input: {
    readonly intentId: string;
    readonly platformMessageId: string;
    readonly kind: "text" | "sticker";
    readonly ordinal: number;
    readonly text: string | null;
  },
  transactionDb?: Database,
): QqOutboundMessageFactRow {
  const map = (): QqOutboundMessageFactRow => {
    const existing = orm
      .select()
      .from(schema.qqOutboundMessageFacts)
      .where(eq(schema.qqOutboundMessageFacts.intentId, input.intentId))
      .get();
    if (!existing) fail("MEMORY_SOURCE_INVALID", "出站事实不存在，不能确认部件");
    const parts = parseParts(existing.parts) as QqOutboundPartFact[];
    const previous = parts.find((p) => p.ordinal === input.ordinal);
    if (
      previous &&
      previous.platformMessageId === input.platformMessageId &&
      previous.text === input.text &&
      previous.kind === input.kind
    ) {
      return existing;
    }
    if (previous && previous.platformMessageId !== null) {
      fail("MEMORY_SOURCE_INVALID", "同一出站部件已确认到不同平台消息，拒绝覆盖");
    }
    const next = [
      ...parts.filter((p) => p.ordinal !== input.ordinal),
      {
        kind: input.kind,
        ordinal: input.ordinal,
        platformMessageId: input.platformMessageId,
        text: input.text,
      } satisfies QqOutboundPartFact,
    ].sort((a, b) => a.ordinal - b.ordinal);
    const row = orm
      .update(schema.qqOutboundMessageFacts)
      .set({ parts: JSON.stringify(next), revision: existing.revision + 1 })
      .where(eq(schema.qqOutboundMessageFacts.intentId, input.intentId))
      .returning()
      .get();
    if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
    return row;
  };
  return transactionDb ? transactionDb.transaction(() => map()).immediate() : map();
}

/**
 * The one outbound-fact protection predicate, shared by the retention purge and the storage
 * management category (T14 manual cleanup), parameterised by the caller's SQL alias for
 * `qq_outbound_message_facts`. A fact is protected when:
 *  1. its intent's ledger has not settled (`planned`/`delivering`/`unknown`, the same face
 *     as `sendProtected`);
 *  2. a part is still `sending`/`unknown` (fail-closed on the real part ledger even if the
 *     intent's own status disagrees);
 *  3. a nonterminal run's exact context snapshot references the intent (either as
 *     `outbound_intent` or as an exact `qq_outbound_message_fact` part ref whose id is one
 *     of the intent's real parts — the confirmed-part source kind protects at part
 *     granularity);
 *  4. an agent task whose sources reference it the same way is not yet safe — nonterminal,
 *     or still holding a `running`/`waiting_approval`/`unknown` call even in a terminal
 *     state (same scope as `TASK_PROTECTION_SQL`: an interrupted write call keeps its
 *     unknown outcome forever, so the task payload evidence it anchors must not lose its
 *     source).
 * Expiry already makes the row unreadable; protection only defers the physical delete.
 */
export function qqOutboundMessageFactProtected(alias: string): string {
  return `(
    EXISTS (SELECT 1 FROM outbound_intents i
      WHERE i.id = ${alias}.intent_id
      AND i.status IN ('planned','delivering','unknown'))
    OR EXISTS (SELECT 1 FROM outbound_parts p
      WHERE p.intent_id = ${alias}.intent_id
      AND p.status IN ('sending','unknown'))
    OR EXISTS (SELECT 1 FROM context_snapshots c
      JOIN agent_steps st ON st.step_id = c.step_id
      JOIN agent_runs r ON r.run_id = st.run_id
      WHERE c.status = 'exact' AND r.status NOT IN ('completed','no_output','failed','cancelled')
      AND (EXISTS (SELECT 1 FROM json_each(c.source_refs) j
          WHERE json_extract(j.value,'$.kind') = 'outbound_intent'
          AND json_extract(j.value,'$.id') = ${alias}.intent_id)
        OR EXISTS (SELECT 1 FROM json_each(c.source_refs) j
          WHERE json_extract(j.value,'$.kind') = 'qq_outbound_message_fact'
          AND EXISTS (SELECT 1 FROM outbound_parts p
            WHERE p.intent_id = ${alias}.intent_id
            AND p.id = json_extract(j.value,'$.id')))))
    OR EXISTS (SELECT 1 FROM agent_tasks t
      WHERE (t.status NOT IN ('completed','failed','cancelled')
        OR EXISTS (SELECT 1 FROM agent_task_calls bc
          WHERE bc.task_id = t.id
          AND bc.status IN ('running','waiting_approval','unknown')))
      AND (EXISTS (SELECT 1 FROM json_each(t.sources) j
        WHERE json_extract(j.value,'$.kind') = 'outbound_intent'
        AND json_extract(j.value,'$.id') = ${alias}.intent_id)
      OR EXISTS (SELECT 1 FROM json_each(t.sources) j
        WHERE json_extract(j.value,'$.kind') = 'qq_outbound_message_fact'
        AND EXISTS (SELECT 1 FROM outbound_parts p
          WHERE p.intent_id = ${alias}.intent_id
          AND p.id = json_extract(j.value,'$.id')))))
  )`;
}

/**
 * Expired outbound facts are purged only when nothing still holds them (the shared
 * {@link qqOutboundMessageFactProtected} predicate). Returns the rows actually deleted
 * (0 is a legal no-op, R16).
 */
export function purgeExpiredQqOutboundMessageFacts(orm: Orm, now: string = nowIso()): number {
  const deleted = orm
    .delete(schema.qqOutboundMessageFacts)
    .where(
      and(
        lte(schema.qqOutboundMessageFacts.expiresAt, now),
        sql.raw(`NOT ${qqOutboundMessageFactProtected("qq_outbound_message_facts")}`),
      ),
    )
    .returning({ intentId: schema.qqOutboundMessageFacts.intentId })
    .all();
  return deleted.length;
}

/**
 * The fact row for a platform message ID, scoped by the conversation the caller is allowed
 * to see. The scope filter runs in SQL so a cross-conversation lookup cannot even read the
 * row (a rejected lookup reveals nothing, §4.3).
 */
export function readQqMessageFactsByPlatformMessageId(
  orm: Orm,
  input: {
    readonly accountId: string;
    readonly conversationKind: string;
    readonly peerId: string;
    readonly agentId: string;
    readonly platformMessageId: string;
  },
): QqMessageFactRow[] {
  return orm
    .select({ fact: schema.qqMessageFacts })
    .from(schema.qqEvents)
    .innerJoin(schema.qqMessageFacts, eq(schema.qqMessageFacts.eventKey, schema.qqEvents.eventKey))
    .where(
      and(
        eq(schema.qqEvents.accountId, input.accountId),
        eq(schema.qqEvents.conversationKind, input.conversationKind),
        eq(schema.qqEvents.peerId, input.peerId),
        eq(schema.qqEvents.agentId, input.agentId),
        eq(schema.qqEvents.messageId, input.platformMessageId),
      ),
    )
    .all()
    .map((r) => r.fact);
}
