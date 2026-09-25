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
import { memberExpiresAt, QQ_OBSERVATION_RETENTION_DAYS } from "../services/qq-retention";
import { nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

export type QqMemberRow = typeof schema.qqMembers.$inferSelect;

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
 * deliveries cannot establish that a rename happened and leave the row unchanged.
 */
export function rememberQqMember(
  orm: Orm,
  input: QqMemberInput,
  retentionDays: number = QQ_OBSERVATION_RETENTION_DAYS,
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
 * The labels to render a conversation's timeline with: stable QQ number to display name.
 *
 * Expired rows are excluded rather than trusted, so a name cannot outlive the messages that
 * refer to it even before the sweep runs. A missing entry is not an error — the renderer falls
 * back to the number, which is the identity and always correct.
 */
export function qqMemberLabels(
  orm: Orm,
  scope: QqMemberScope,
  now: string = nowIso(),
): ReadonlyMap<string, string> {
  const rows = orm
    .select({ userId: schema.qqMembers.userId, nickname: schema.qqMembers.nickname })
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
  return new Map(rows.map((row) => [row.userId, row.nickname]));
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
