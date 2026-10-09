import { createHash, randomUUID } from "node:crypto";
import { QQ_MEMBER_TOOL_DESCRIPTIONS } from "../../shared/contracts/agent-action-descriptions";
import type { SourceRef } from "../../shared/contracts/evidence";
import {
  QQ_MEMBER_QUERY_PAGE_DEFAULT,
  type QqMember,
  QqMemberQuerySchema,
  QqMemberReadSchema,
  QqMemberSchema,
} from "../../shared/contracts/qq-members";
import type { ActionContext, BuiltInAction } from "../agent/built-in-actions";
import { fail } from "../errors";
import { createQqMemberRosterSource, type QqMemberRosterScope } from "./qq-member-roster-sources";

export interface QqMemberPlatformRecord {
  user_id: string;
  nickname?: string;
  card?: string;
  role?: "owner" | "admin" | "member";
  title?: string;
  join_time?: number;
  last_sent_time?: number;
}
export interface QqMemberReadPort {
  list(
    groupId: string,
    signal: AbortSignal,
  ): Promise<
    | { kind: "ok"; members: readonly QqMemberPlatformRecord[] }
    | { kind: "unavailable"; reason: string }
  >;
  read(
    groupId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<
    { kind: "ok"; member: QqMemberPlatformRecord } | { kind: "unavailable"; reason: string }
  >;
}
export interface QqMemberToolOptions extends QqMemberRosterScope {
  readonly platform: QqMemberReadPort;
  readonly enabled: () => boolean;
  /** Hash of the current persisted permission-policy snapshot, not a fabricated grant. */
  readonly policyRevision: () => string;
  readonly capabilitySource: () => readonly SourceRef[];
  readonly sourceExpiresAt: () => string;
  readonly fit: (
    name: string,
    args: Record<string, unknown>,
    value: unknown,
    sources: readonly SourceRef[],
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly assertCurrent: () => void;
  readonly now?: () => string;
}

type RosterResult =
  | { kind: "ok"; members: readonly QqMember[]; capturedAt: string; sources: readonly SourceRef[] }
  | { kind: "unavailable"; reason: string };
interface RunSnapshot {
  readonly token: string;
  readonly policyRevision: string;
  readonly roster: Promise<RosterResult>;
}

function toMember(record: QqMemberPlatformRecord, accountId: string): QqMember {
  const positiveTime = (value: number | undefined) =>
    Number.isSafeInteger(value) && (value as number) > 0 ? value : undefined;
  return QqMemberSchema.parse({
    userId: String(record.user_id),
    ...(record.nickname === undefined ? {} : { nickname: record.nickname }),
    ...(record.card === undefined ? {} : { groupCard: record.card }),
    ...(record.role === undefined ? {} : { role: record.role }),
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(positiveTime(record.join_time) === undefined
      ? {}
      : { joinTimeSeconds: positiveTime(record.join_time) }),
    ...(positiveTime(record.last_sent_time) === undefined
      ? {}
      : { lastSentTimeSeconds: positiveTime(record.last_sent_time) }),
    isSelf: String(record.user_id) === accountId,
  });
}
function queryFingerprint(keyword: string, role: string | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify([keyword, role ?? null]))
    .digest("hex");
}
function cursorPayload(token: string, filter: string, offset: number): string {
  return JSON.stringify([token, filter, offset]);
}

export function createQqMemberTools(options: QqMemberToolOptions): BuiltInAction[] {
  let snapshot: RunSnapshot | undefined;
  let closed = false;
  const details = new Map<
    string,
    Promise<{ kind: "ok"; member: QqMember } | { kind: "unavailable"; reason: string }>
  >();
  const cursors = new Map<string, { filter: string; offset: number }>();
  const ensureOpen = (context: ActionContext) => {
    context.signal.throwIfAborted();
    if (closed) fail("CONTEXT_INVALID_SELECTION", "成员查询不属于仍有效的运行");
    context.assertAuthority?.();
    options.assertCurrent();
    if (!options.enabled()) throw new Error("QQ_MEMBER_MODULE_DISABLED");
  };
  const getSnapshot = (context: ActionContext): RunSnapshot => {
    ensureOpen(context);
    if (!snapshot) {
      const token = randomUUID();
      const policyRevision = options.policyRevision();
      const roster = options.platform
        .list(options.groupId, context.signal)
        .then((result): RosterResult => {
          context.signal.throwIfAborted();
          context.assertAuthority?.();
          options.assertCurrent();
          if (closed || !options.enabled() || options.policyRevision() !== policyRevision)
            throw new Error("QQ_MEMBER_MODULE_DISABLED");
          if (result.kind !== "ok") return result;
          const capturedAt = (options.now ?? (() => new Date().toISOString()))();
          const source = createQqMemberRosterSource(options, {
            token,
            capturedAt,
            expiresAt: options.sourceExpiresAt(),
          });
          return {
            kind: "ok",
            members: result.members.map((entry) => toMember(entry, options.accountId)),
            capturedAt,
            sources: [
              source,
              { kind: "execution_module", id: "qqMembers", revision: policyRevision },
              ...options.capabilitySource(),
            ],
          };
        });
      snapshot = { token, policyRevision, roster };
    } else {
      if (snapshot.policyRevision !== options.policyRevision())
        throw new Error("QQ_MEMBER_MODULE_DISABLED");
    }
    return snapshot;
  };
  const assertSnapshot = (context: ActionContext, current: RunSnapshot) => {
    ensureOpen(context);
    if (snapshot !== current || current.policyRevision !== options.policyRevision())
      throw new Error("QQ_MEMBER_MODULE_DISABLED");
  };
  const query: BuiltInAction = {
    description: QQ_MEMBER_TOOL_DESCRIPTIONS["qq.members.query"],
    sandboxCallable: false,
    assertAvailable: () => {
      if (closed || !options.enabled()) throw new Error("QQ_MEMBER_MODULE_DISABLED");
      options.assertCurrent();
    },
    release: () => {
      closed = true;
      snapshot = undefined;
      details.clear();
      cursors.clear();
    },
    async execute(args, context) {
      const input = QqMemberQuerySchema.parse(args);
      const keyword = input.keyword?.trim().toLocaleLowerCase() ?? "";
      const filter = queryFingerprint(keyword, input.role);
      let offset = 0;
      if (input.cursor !== undefined) {
        const issued = cursors.get(input.cursor);
        if (!issued || issued.filter !== filter)
          fail("CONTEXT_INVALID_SELECTION", "成员列表游标不属于本轮同一筛选");
        offset = issued.offset;
      }
      const current = getSnapshot(context);
      const rosterResult = await current.roster;
      assertSnapshot(context, current);
      if (rosterResult.kind !== "ok")
        return {
          value: {
            status: "unavailable",
            code: `QQ_MEMBER_${rosterResult.reason.toUpperCase()}`,
            members: [],
            nextCursor: null,
          },
          sources: [],
        };
      const { capturedAt, sources } = rosterResult;
      const filtered = rosterResult.members.filter((member) => {
        const roleMatch =
          input.role === undefined ||
          (input.role === "unknown" ? member.role === undefined : member.role === input.role);
        const haystack =
          `${member.userId} ${member.groupCard ?? ""} ${member.nickname ?? ""}`.toLocaleLowerCase();
        return roleMatch && (!keyword || haystack.includes(keyword));
      });
      if (offset > filtered.length) fail("CONTEXT_INVALID_SELECTION", "成员列表游标超出范围");
      const limit = input.limit ?? QQ_MEMBER_QUERY_PAGE_DEFAULT;
      const page = filtered.slice(offset, offset + limit);
      const valueFor = (items: readonly QqMember[]) => ({
        status: "ok",
        members: items,
        nextCursor:
          offset + items.length < filtered.length
            ? cursorPayload(current.token, filter, offset + items.length)
            : null,
        totalMemberCount: rosterResult.members.length,
        snapshotAt: capturedAt,
      });
      let count = page.length;
      while (
        count > 0 &&
        !(await options.fit(
          "qq.members.query",
          args,
          valueFor(page.slice(0, count)),
          sources,
          context.signal,
        ))
      )
        count = Math.floor(count / 2);
      if (page.length > 0 && count === 0) {
        assertSnapshot(context, current);
        return {
          value: {
            status: "unavailable",
            code: "CONTEXT_BUDGET_EXCEEDED",
            members: [],
            nextCursor: null,
            totalMemberCount: rosterResult.members.length,
            snapshotAt: capturedAt,
          },
          sources: [...sources],
        };
      }
      if (
        page.length === 0 &&
        !(await options.fit("qq.members.query", args, valueFor([]), sources, context.signal))
      ) {
        assertSnapshot(context, current);
        return {
          value: {
            status: "unavailable",
            code: "CONTEXT_BUDGET_EXCEEDED",
            members: [],
            nextCursor: null,
            totalMemberCount: rosterResult.members.length,
            snapshotAt: capturedAt,
          },
          sources: [...sources],
        };
      }
      assertSnapshot(context, current);
      const value = valueFor(page.slice(0, count));
      if (typeof value.nextCursor === "string")
        cursors.set(value.nextCursor, { filter, offset: offset + count });
      return { value, sources: [...sources] };
    },
  };
  const read: BuiltInAction = {
    description: QQ_MEMBER_TOOL_DESCRIPTIONS["qq.members.read"],
    sandboxCallable: false,
    assertAvailable: query.assertAvailable,
    release: query.release,
    async execute(args, context) {
      const input = QqMemberReadSchema.parse(args);
      const current = getSnapshot(context);
      const rosterResult = await current.roster;
      assertSnapshot(context, current);
      if (rosterResult.kind !== "ok")
        return {
          value: {
            status: "unavailable",
            code: `QQ_MEMBER_${rosterResult.reason.toUpperCase()}`,
            found: false,
          },
          sources: [],
        };
      const { capturedAt, sources } = rosterResult;
      const listed = rosterResult.members.find((member) => member.userId === input.userId);
      if (!listed) {
        const value = { status: "not_in_snapshot", found: false, snapshotAt: capturedAt };
        const accepted = await options.fit("qq.members.read", args, value, sources, context.signal);
        assertSnapshot(context, current);
        return {
          value: accepted
            ? value
            : { status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED", found: false },
          sources: [...sources],
        };
      }
      let detail = details.get(input.userId);
      if (!detail) {
        detail = (async () => {
          if (
            listed.title !== undefined &&
            listed.joinTimeSeconds !== undefined &&
            listed.lastSentTimeSeconds !== undefined
          )
            return { kind: "ok" as const, member: listed };
          const result = await options.platform.read(options.groupId, input.userId, context.signal);
          context.signal.throwIfAborted();
          context.assertAuthority?.();
          options.assertCurrent();
          if (closed || !options.enabled() || options.policyRevision() !== current.policyRevision)
            throw new Error("QQ_MEMBER_MODULE_DISABLED");
          if (result.kind !== "ok") return result;
          if (String(result.member.user_id) !== input.userId)
            return { kind: "unavailable" as const, reason: "scope_mismatch" };
          return { kind: "ok" as const, member: toMember(result.member, options.accountId) };
        })();
        details.set(input.userId, detail);
      }
      const result = await detail;
      assertSnapshot(context, current);
      const value =
        result.kind === "ok"
          ? { status: "ok", found: true, member: result.member, snapshotAt: capturedAt }
          : {
              status: "unavailable",
              code: `QQ_MEMBER_${result.reason.toUpperCase()}`,
              found: false,
              snapshotAt: capturedAt,
            };
      if (!(await options.fit("qq.members.read", args, value, sources, context.signal))) {
        assertSnapshot(context, current);
        return {
          value: {
            status: "unavailable",
            code: "CONTEXT_BUDGET_EXCEEDED",
            found: false,
            snapshotAt: capturedAt,
          },
          sources: [...sources],
        };
      }
      assertSnapshot(context, current);
      return { value, sources: [...sources] };
    },
  };
  return [query, read];
}
