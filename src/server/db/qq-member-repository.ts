// Member display names, one latest value per person per conversation (ADR0018 P3c).
//
// The timeline a judgement reads carries a stable QQ number for every named member, so a
// judgement can already tell that two different people spoke. What it could not do is know who
// they were, which is why a reply had to avoid addressing anyone. This module stores the
// display name that goes with that number.
//
// Three rules it keeps:
//   * the identity is the number, never the name — the row is keyed by the number and the
//     caller renders both, so a rename cannot turn one person into two speakers;
//   * latest-seen, not history — a rename overwrites, and only `first_seen` remembers when
//     this conversation first showed us that person; and
//   * scoped to the conversation, not to the assistant — two assistants observing one group
//     must not hold two different names for the same person.

import { and, eq, gt, lte } from "drizzle-orm";
import { fail } from "../errors";
import { memberExpiresAt } from "../services/qq-retention";
import { readQqRetentionDays } from "./qq-settings-repository";
import { nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

export type QqMemberRow = typeof schema.qqMembers.$inferSelect;

/** The current two-name directory shape (0052). `null` = cleared/absent, never a guess. */
export interface QqMemberNameSnapshot {
  readonly groupCard: string | null;
  readonly personalNickname: string | null;
  /**
   * 旧目录单昵称证据的只读载体（F3）：仅 `legacy` 行非空（值为原 nickname 列），
   * known/unknown 恒为 null。它不是显示回退，只标注证据来源（§13.5：不伪造两份历史名字）。
   */
  readonly legacyDisplayName: string | null;
  readonly nameState: "known" | "unknown" | "legacy";
}

/**
 * The three fields a member belongs to. Deliberately narrower than a conversation scope: the
 * full scope carries `agentId`, and accepting it here would suggest the name is per-assistant.
 */
export interface QqMemberScope {
  readonly accountId: string;
  readonly conversationKind: string;
  readonly peerId: string;
}

export interface QqMemberInput {
  readonly scope: QqMemberScope;
  /** The stable QQ number. The nickname is only ever a label for it. */
  readonly userId: string;
  readonly nickname: string;
  readonly seenAtSeconds: number;
}

const NICKNAME_MAX = 64;

function validate(scope: QqMemberScope, userId: string, nickname: string, at: number): string {
  if (scope.conversationKind !== "group" && scope.conversationKind !== "private") {
    throw new TypeError("Invalid QQ member conversation kind");
  }
  if (scope.accountId === "" || scope.peerId === "" || userId === "") {
    throw new TypeError("Invalid QQ member identity");
  }
  const trimmed = nickname.trim();
  // A name of spaces is not a name, and storing one would make the timeline read
  // `群友 (12345)`. The column refuses it too.
  if (trimmed === "" || [...trimmed].length > NICKNAME_MAX) {
    throw new TypeError("Invalid QQ member nickname");
  }
  if (!Number.isInteger(at) || at < 0) throw new TypeError("Invalid QQ member clock");
  return trimmed;
}

/**
 * Record or refresh one member's display name.
 *
 * Only a strictly newer observation can update the name and expiry. Older or same-second
 * deliveries cannot establish that a rename happened and leave the row unchanged. The
 * window defaults to the stored setting (read per write).
 */
export function rememberQqMember(
  orm: Orm,
  input: QqMemberInput,
  retentionDays: number = readQqRetentionDays(orm),
): QqMemberRow {
  const nickname = validate(input.scope, input.userId, input.nickname, input.seenAtSeconds);
  const key = and(
    eq(schema.qqMembers.accountId, input.scope.accountId),
    eq(schema.qqMembers.conversationKind, input.scope.conversationKind),
    eq(schema.qqMembers.peerId, input.scope.peerId),
    eq(schema.qqMembers.userId, input.userId),
  );
  const existing = orm.select().from(schema.qqMembers).where(key).get();

  if (existing === undefined) {
    const row = orm
      .insert(schema.qqMembers)
      .values({
        accountId: input.scope.accountId,
        conversationKind: input.scope.conversationKind,
        peerId: input.scope.peerId,
        userId: input.userId,
        nickname,
        firstSeenAtSeconds: input.seenAtSeconds,
        lastSeenAtSeconds: input.seenAtSeconds,
        expiresAt: memberExpiresAt(input.seenAtSeconds, retentionDays),
      })
      .returning()
      .get();
    if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
    return row;
  }

  // Seconds are the platform's full precision: an older or tied delivery cannot prove a rename.
  if (input.seenAtSeconds <= existing.lastSeenAtSeconds) return existing;
  const lastSeen = input.seenAtSeconds;
  const row = orm
    .update(schema.qqMembers)
    .set({
      nickname,
      lastSeenAtSeconds: lastSeen,
      expiresAt: memberExpiresAt(lastSeen, retentionDays),
    })
    .where(key)
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return row;
}

/**
 * The current two-name record for one member, or `null` when the directory has no usable
 * row (never observed, or expired — an expired name is unreadable, §10). Callers use it
 * to fill ABSENT wire fields; an explicit blank card is a clearing and bypasses this read.
 *
 * `legacyDisplayName` is the read-side carrier for §13.5's single legacy evidence: it is
 * non-null ONLY for a `legacy` row (the pre-0052 single-nickname column), and null for
 * known/unknown rows. It is not a display fallback — it labels the evidence's origin.
 */
export function readQqMemberNames(
  orm: Orm,
  scope: QqMemberScope,
  userId: string,
  now: string = nowIso(),
): QqMemberNameSnapshot | null {
  const row = orm
    .select({
      groupCard: schema.qqMembers.groupCard,
      personalNickname: schema.qqMembers.personalNickname,
      nickname: schema.qqMembers.nickname,
      nameState: schema.qqMembers.nameState,
      expiresAt: schema.qqMembers.expiresAt,
    })
    .from(schema.qqMembers)
    .where(
      and(
        eq(schema.qqMembers.accountId, scope.accountId),
        eq(schema.qqMembers.conversationKind, scope.conversationKind),
        eq(schema.qqMembers.peerId, scope.peerId),
        eq(schema.qqMembers.userId, userId),
      ),
    )
    .get();
  if (!row || row.expiresAt <= now) return null;
  if (row.nameState !== "legacy") {
    return {
      groupCard: row.groupCard,
      personalNickname: row.personalNickname,
      legacyDisplayName: null,
      nameState: row.nameState === "known" ? "known" : "unknown",
    };
  }
  // 旧目录（0052 之前的行）只有一份 legacy 显示证据：不能冒充群名片或个人昵称（§13.5），
  // 两个当前字段都按缺失处理，证据单独走 legacyDisplayName（来源明确是旧目录单名）。
  return {
    groupCard: null,
    personalNickname: null,
    legacyDisplayName: row.nickname,
    nameState: "legacy",
  };
}

/**
 * Advance the CURRENT two-name directory from one delivery (§3.1). Rules:
 *   * only a strictly newer observation updates the row (乱序/同秒不回退当前目录);
 *   * an explicit blank card CLEARS the current card (the row falls back to the nickname);
 *   * an absent field keeps the stored value (缺省 ≠ 清空).
 * The legacy `nickname` column keeps its latest-seen display evidence for old renderers.
 */
export function rememberQqMemberNames(
  orm: Orm,
  input: {
    readonly scope: QqMemberScope;
    readonly userId: string;
    readonly names: {
      /** `undefined`＝本次未提供（沿用本地）；`null`＝显式清空；`string`＝本次原值。 */
      readonly groupCard?: string | null;
      readonly personalNickname?: string | null;
    };
    readonly seenAtSeconds: number;
  },
  retentionDays: number = readQqRetentionDays(orm),
): QqMemberRow | null {
  if (input.scope.conversationKind !== "group" && input.scope.conversationKind !== "private") {
    throw new TypeError("Invalid QQ member conversation kind");
  }
  if (input.scope.accountId === "" || input.scope.peerId === "" || input.userId === "") {
    throw new TypeError("Invalid QQ member identity");
  }
  if (!Number.isInteger(input.seenAtSeconds) || input.seenAtSeconds < 0) {
    throw new TypeError("Invalid QQ member clock");
  }
  const key = and(
    eq(schema.qqMembers.accountId, input.scope.accountId),
    eq(schema.qqMembers.conversationKind, input.scope.conversationKind),
    eq(schema.qqMembers.peerId, input.scope.peerId),
    eq(schema.qqMembers.userId, input.userId),
  );
  const existing = orm.select().from(schema.qqMembers).where(key).get();
  const trimName = (value: string | null | undefined): string | null => {
    if (value === undefined || value === null) return null;
    const trimmed = value.trim();
    if (trimmed === "" || [...trimmed].length > NICKNAME_MAX) return null;
    return trimmed;
  };
  const nextCard = trimName(input.names.groupCard);
  const nextNickname = trimName(input.names.personalNickname);
  // 行不存在且本次没有任何可用名字：不造一行只有号码的目录（时间线本就按号码兜底，
  // §3.1 的"昵称未知"是渲染层结论，不是一条目录行）。
  if (!existing) {
    const nickname = nextCard ?? nextNickname;
    if (nickname === null) return null;
    const row = orm
      .insert(schema.qqMembers)
      .values({
        accountId: input.scope.accountId,
        conversationKind: input.scope.conversationKind,
        peerId: input.scope.peerId,
        userId: input.userId,
        nickname,
        groupCard: nextCard,
        personalNickname: nextNickname,
        nameState: "known",
        firstSeenAtSeconds: input.seenAtSeconds,
        lastSeenAtSeconds: input.seenAtSeconds,
        expiresAt: memberExpiresAt(input.seenAtSeconds, retentionDays),
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
    return row;
  }
  if (input.seenAtSeconds <= existing.lastSeenAtSeconds) return existing;
  // F1 side-effect guard: a legacy row (pre-0052 single-nickname evidence) is not touched
  // by a delivery that carries NO name observation at all (both fields absent). Demoting it
  // to `unknown` would erase the only legacy evidence and change what the NEXT message's
  // snapshot reads. Only an explicit clearing (null) or a real name advances a legacy row.
  if (
    existing.nameState === "legacy" &&
    input.names.groupCard === undefined &&
    input.names.personalNickname === undefined
  ) {
    return existing;
  }
  // 显式 null 是清空（§3.1），不是缺省——不能 ?? 旧值把清空吞掉。缺省（undefined）才沿用本地。
  const clearedCard = input.names.groupCard === null;
  const clearedNickname = input.names.personalNickname === null;
  const groupCard = clearedCard ? null : (nextCard ?? existing.groupCard);
  const personalNickname = clearedNickname ? null : (nextNickname ?? existing.personalNickname);
  const nameState: "known" | "unknown" = groupCard || personalNickname ? "known" : "unknown";
  // legacy nickname 列保留最后一次可核实的显示证据（NOT NULL）；当前双名字已清空时它不再
  // 代表"当前名"，读取方按 nameState 判断。无法置空是列约束，不是沿用旧当前值的语义。
  const nickname = groupCard ?? personalNickname ?? existing.nickname;
  const row = orm
    .update(schema.qqMembers)
    .set({
      nickname,
      groupCard,
      personalNickname,
      nameState,
      lastSeenAtSeconds: input.seenAtSeconds,
      expiresAt: memberExpiresAt(input.seenAtSeconds, retentionDays),
    })
    .where(key)
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return row;
}

/**
 * The labels to render a conversation's timeline with: stable QQ number to display name.
 *
 * Expired rows are excluded rather than trusted, so a name cannot outlive the messages that
 * refer to it even before the sweep runs. A missing entry is not an error — the renderer falls
 * back to the number, which is the identity and always correct.
 *
 * F2: the legacy `nickname` column keeps its last-seen evidence even after the current dual
 * names were explicitly cleared (the column is NOT NULL). An `unknown` row therefore no longer
 * represents a current name, and the label is withheld — the timeline falls back to the QQ
 * number instead of rendering a stale nickname. `legacy` rows keep their original nickname:
 * the single nickname there IS the real evidence (a stray groupCard on such a row is not).
 * Known rows read the real dual names — a non-blank trimmed groupCard wins, then the personal
 * nickname — so a known row's label no longer depends on the write-side keeping the legacy
 * `nickname` column in sync (fix2).
 */
export function qqMemberLabels(
  orm: Orm,
  scope: QqMemberScope,
  now: string = nowIso(),
): ReadonlyMap<string, string> {
  const rows = orm
    .select({
      userId: schema.qqMembers.userId,
      nickname: schema.qqMembers.nickname,
      groupCard: schema.qqMembers.groupCard,
      personalNickname: schema.qqMembers.personalNickname,
      nameState: schema.qqMembers.nameState,
    })
    .from(schema.qqMembers)
    .where(
      and(
        eq(schema.qqMembers.accountId, scope.accountId),
        eq(schema.qqMembers.conversationKind, scope.conversationKind),
        eq(schema.qqMembers.peerId, scope.peerId),
        gt(schema.qqMembers.expiresAt, now),
      ),
    )
    .all();
  const labels = new Map<string, string>();
  for (const row of rows) {
    // unknown＝当前双名已无有效值（可能是显式清空）：旧 nickname 列不代表当前名。
    if (row.nameState === "unknown") continue;
    if (row.nameState === "legacy") {
      // §13.5：legacy 行只有原单昵称这一份证据；groupCard/personalNickname 对 legacy 行
      // 不是名字事实，不参与优先选择。
      labels.set(row.userId, row.nickname);
      continue;
    }
    // known：label=card||nick；两者皆空与 unknown 同语义（旧 nickname 列不代表当前名）。
    const card = row.groupCard?.trim() ?? "";
    const nick = row.personalNickname?.trim() ?? "";
    if (card === "" && nick === "") continue;
    labels.set(row.userId, card !== "" ? card : nick);
  }
  return labels;
}

/** Retention sweep, on the same window as message text (qq-retention.ts). */
export function purgeExpiredQqMembers(orm: Orm, now: string = nowIso()): number {
  const expired = orm
    .select({ userId: schema.qqMembers.userId })
    .from(schema.qqMembers)
    .where(lte(schema.qqMembers.expiresAt, now))
    .all();
  if (expired.length === 0) return 0;
  orm.delete(schema.qqMembers).where(lte(schema.qqMembers.expiresAt, now)).run();
  return expired.length;
}
