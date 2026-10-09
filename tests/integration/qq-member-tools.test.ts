import { describe, expect, it } from "bun:test";
import type { ActionContext } from "../../src/server/agent/built-in-actions";
import {
  createQqMemberTools,
  type QqMemberPlatformRecord,
  type QqMemberReadPort,
} from "../../src/server/services/qq-member-tools";

const owner = {
  kind: "conversation" as const,
  id: "conversation-1",
  userId: "local-user",
  agentId: "agent-1",
};
const source = {
  kind: "qq_group_capability",
  id: JSON.stringify(["binding-1", "agent-1", "members_read"]),
  revision: "0",
};
const context = (runId: string, signal = new AbortController().signal): ActionContext => ({
  owner,
  runId,
  signal,
  assertAuthority() {},
});
const member = (
  user_id: string,
  extra: Partial<QqMemberPlatformRecord> = {},
): QqMemberPlatformRecord => ({ user_id, ...extra });
function harness(
  input: {
    members?: readonly QqMemberPlatformRecord[];
    detail?: QqMemberPlatformRecord;
    enabled?: () => boolean;
    revision?: () => string;
    fit?: (value: unknown) => Promise<boolean> | boolean;
  } = {},
) {
  let listCalls = 0;
  const detailCalls = new Map<string, number>();
  const port: QqMemberReadPort = {
    async list(groupId, signal) {
      listCalls++;
      signal.throwIfAborted();
      expect(groupId).toBe("123");
      return { kind: "ok", members: input.members ?? [] };
    },
    async read(groupId, userId, signal) {
      detailCalls.set(userId, (detailCalls.get(userId) ?? 0) + 1);
      signal.throwIfAborted();
      expect(groupId).toBe("123");
      return input.detail
        ? { kind: "ok", member: input.detail }
        : { kind: "unavailable", reason: "rejected" };
    },
  };
  const tools = createQqMemberTools({
    conversationId: "conversation-1",
    bindingId: "binding-1",
    agentId: "agent-1",
    accountId: "999",
    groupId: "123",
    bindingRevision: 3,
    bindingAuthorityRevision: 4,
    bindingEpoch: 2,
    platform: port,
    enabled: input.enabled ?? (() => true),
    policyRevision: input.revision ?? (() => "policy-1"),
    capabilitySource: () => [source],
    sourceExpiresAt: () => "2026-10-09T06:00:00.000Z",
    now: () => "2026-10-09T05:30:00.000Z",
    fit: async (_name, _args, value) => (input.fit ? await input.fit(value) : true),
    assertCurrent() {},
  });
  return { query: tools[0], read: tools[1], listCalls: () => listCalls, detailCalls };
}

describe("QQ member read actions", () => {
  it("filters and pages one run-local full roster, binds cursors to the filter, and normalizes IDs/self", async () => {
    const h = harness({
      members: [
        member("1", { nickname: "Alice", role: "owner" }),
        member("2", { card: "Alice", role: "admin" }),
        member("999", { nickname: "Bot" }),
      ],
    });
    const first = await h.query.execute({ keyword: "ali", limit: 1 }, context("run-1"));
    expect((first.value as any).members.map((item: any) => item.userId)).toEqual(["1"]);
    const cursor = (first.value as any).nextCursor;
    expect(typeof cursor).toBe("string");
    expect(cursor.length).toBeLessThan(128);
    await expect(
      h.query.execute({ keyword: "different", cursor }, context("run-1")),
    ).rejects.toThrow();
    const second = await h.query.execute({ keyword: "ali", limit: 1, cursor }, context("run-1"));
    expect((second.value as any).members.map((item: any) => item.userId)).toEqual(["2"]);
    const self = await h.query.execute({ keyword: "bot" }, context("run-1"));
    expect((self.value as any).members[0]).toMatchObject({ userId: "999", isSelf: true });
    expect(h.listCalls()).toBe(1);
  });

  it("binds cursors to this run without loading a second list", async () => {
    const h = harness({ members: [member("1"), member("2")] });
    const first = await h.query.execute({ limit: 1 }, context("run-a"));
    const cursor = (first.value as any).nextCursor;
    const other = harness({ members: [member("1"), member("2")] });
    await expect(other.query.execute({ cursor }, context("run-b"))).rejects.toThrow();
    expect(other.listCalls()).toBe(0);
  });

  it("uses a fixed source snapshot and does not revive after global off/on revision change", async () => {
    let enabled = true;
    let revision = "policy-1";
    const h = harness({ members: [member("1")], enabled: () => enabled, revision: () => revision });
    const first = await h.query.execute({}, context("run-1"));
    const refs = first.sources;
    expect(refs.some((item) => item.kind === "qq_member_roster")).toBe(true);
    expect(
      refs.some(
        (item) =>
          item.kind === "execution_module" &&
          item.id === "qqMembers" &&
          item.revision === "policy-1",
      ),
    ).toBe(true);
    enabled = false;
    revision = "policy-2";
    enabled = true;
    await expect(h.query.execute({}, context("run-1"))).rejects.toThrow(
      "QQ_MEMBER_MODULE_DISABLED",
    );
    expect(h.listCalls()).toBe(1);
  });

  it("shrinks to a cursor-bearing page under result fitting instead of dropping unreturned entries", async () => {
    const h = harness({
      members: [member("1"), member("2"), member("3")],
      fit: (value) => (value as any).members.length <= 1,
    });
    const result = await h.query.execute({ limit: 3 }, context("run-1"));
    expect((result.value as any).members.map((item: any) => item.userId)).toEqual(["1"]);
    const next = (result.value as any).nextCursor;
    expect(typeof next).toBe("string");
    const rest = await h.query.execute({ cursor: next, limit: 3 }, context("run-1"));
    expect((rest.value as any).members.map((item: any) => item.userId)).toEqual(["2"]);
  });

  it("does not report a budget-rejected nonempty page as an empty successful page", async () => {
    const h = harness({
      members: [member("1"), member("2")],
      fit: (value) => (value as any).members.length === 0,
    });
    const result = await h.query.execute({ limit: 1 }, context("run-1"));
    expect(result.value).toMatchObject({
      status: "unavailable",
      code: "CONTEXT_BUDGET_EXCEEDED",
      members: [],
      nextCursor: null,
    });
  });

  it("fits a truly empty filtered result without inventing an unread cursor", async () => {
    const h = harness({ members: [member("1")], fit: () => true });
    const result = await h.query.execute({ keyword: "not present" }, context("run-1"));
    expect(result.value).toMatchObject({ status: "ok", members: [], nextCursor: null });
  });

  it("reads detail only on demand, shares one in-flight detail per ID, and labels missing list IDs as snapshot-only", async () => {
    const h = harness({
      members: [member("1234", { nickname: "Alice", role: "member" })],
      detail: member("1234", {
        nickname: "Alice",
        role: "member",
        title: "helper",
        join_time: 123,
      }),
    });
    const [a, b] = await Promise.all([
      h.read.execute({ userId: "1234" }, context("run-1")),
      h.read.execute({ userId: "1234" }, context("run-1")),
    ]);
    expect((a.value as any).member.title).toBe("helper");
    expect((b.value as any).member.title).toBe("helper");
    expect(h.detailCalls.get("1234")).toBe(1);
    const absent = await h.read.execute({ userId: "7" }, context("run-1"));
    expect(absent.value).toMatchObject({ status: "not_in_snapshot", found: false });
    expect(h.detailCalls.has("7")).toBe(false);
    expect(h.listCalls()).toBe(1);
  });

  it("releases run-local data and permanently closes both actions", async () => {
    const h = harness({ members: [member("1")] });
    await h.query.execute({}, context("run-1"));
    h.query.release?.({ owner, runId: "run-1" });
    await expect(h.read.execute({ userId: "1" }, context("run-1"))).rejects.toThrow("仍有效的运行");
    expect(h.listCalls()).toBe(1);
  });
});
