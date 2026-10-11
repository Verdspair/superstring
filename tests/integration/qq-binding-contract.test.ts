import { describe, expect, it } from "bun:test";
import { scopeKey } from "../../src/server/services/memory-contract";
import {
  normalizeOneBotMessage,
  type QqObservation,
} from "../../src/server/services/onebot-protocol";
import {
  captureQqTask,
  checkQqTask,
  createQqBinding,
  createQqOwnerIdentity,
  type QqBinding,
  type QqBindingSave,
  type QqOwnerIdentity,
  qqConversationKey,
  qqMemoryScopeKey,
  qqObservationSource,
  resolveQqMemoryAccess,
  updateQqBinding,
  updateQqOwnerIdentity,
} from "../../src/server/services/qq-binding-contract";

const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
const SCHEME = "20000000-0000-4000-8000-000000000001";
const OTHER_SCHEME = "20000000-0000-4000-8000-000000000002";
const ID = "30000000-0000-4000-8000-000000000001";
function saved(result: QqBindingSave): QqBinding {
  if (result.kind !== "saved") throw Error(`Unexpected result: ${result.kind}`);
  return result.binding;
}
function input(patch: Record<string, unknown> = {}) {
  return {
    id: ID,
    accountId: "10001",
    kind: "group",
    peerId: "20001",
    agentId: A,
    schemeId: SCHEME,
    paused: false,
    ...patch,
  };
}
function binding(patch: Record<string, unknown> = {}, owner: QqOwnerIdentity | null = null) {
  return saved(createQqBinding(input(patch), owner));
}
function update(current: QqBinding, patch: unknown, owner: QqOwnerIdentity | null = null) {
  return saved(updateQqBinding(current, patch, current.revision, owner));
}
function ownerUpdate(current: QqOwnerIdentity, peerId: unknown): QqOwnerIdentity {
  const result = updateQqOwnerIdentity(current, peerId, current.revision);
  if (result.kind !== "saved") throw Error("Unexpected conflict");
  return result.owner;
}
function owner() {
  return ownerUpdate(createQqOwnerIdentity("10001"), "20001");
}
function access(current: QqBinding, identity: QqOwnerIdentity | null = null) {
  const result = resolveQqMemoryAccess(current, identity);
  if (result.kind !== "resolved") throw Error(`Unexpected denial: ${result.reason}`);
  return result.access;
}
function snapshot(
  current: QqBinding,
  purpose: "reply" | "organization" = "reply",
  identity: QqOwnerIdentity | null = null,
) {
  const result = captureQqTask(current, purpose, identity);
  if (result.kind !== "captured") throw Error(`Unexpected block: ${result.reason}`);
  return result.snapshot;
}
function observation(patch: Record<string, unknown> = {}): QqObservation {
  const result = normalizeOneBotMessage(
    {
      self_id: 10001,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      group_id: 20001,
      user_id: 30001,
      message_id: -7,
      time: 123456,
      message: [{ type: "text", data: { text: "synthetic" } }],
      ...patch,
    },
    "10001",
  );
  if (result.kind !== "message") throw Error("Expected normalized observation");
  return result.observation;
}

describe("QQ binding memory addresses", () => {
  it("defaults sharing off and does not create a new web session scope", () => {
    const value = binding();
    const resolved = access(value);
    expect(value.shareWebMemory).toBe(false);
    expect(value.ownerIdentityRevision).toBeNull();
    expect(value.revision).toBe(1);
    expect(value.authorityRevision).toBe(1);
    expect(resolved.conversationKey).toBe('["qq","10001","group","20001"]');
    expect(qqMemoryScopeKey(resolved.historyScope)).toBe(`["qq","10001","group","20001","${A}"]`);
    expect(resolved.readScopes).toEqual([resolved.historyScope]);
    expect(resolved.writeScope).toEqual(resolved.historyScope);
    expect(scopeKey("session_only", "web-session-1", A)).toBe(A);
    expect(scopeKey("roleplay_world", "web-session-2", A)).toBe(A);
  });

  it("isolates account, group, private peer and agent while web stays agent-scoped", () => {
    const scopes = [
      binding(),
      binding({ accountId: "10002" }),
      binding({ peerId: "20002" }),
      binding({ kind: "private" }),
      binding({ agentId: B }),
    ].map((value) => qqMemoryScopeKey(access(value).writeScope));
    scopes.push(qqMemoryScopeKey({ kind: "web", agentId: A }));
    expect(new Set(scopes).size).toBe(6);
  });

  it("normalizes identity spellings without losing large string IDs", () => {
    const value = binding({
      accountId: "00010001",
      peerId: "900719925474099312345",
      agentId: A.replaceAll("-", ""),
    });
    expect(value.accountId).toBe("10001");
    expect(value.agentId).toBe(A);
    expect(
      qqConversationKey({ accountId: value.accountId, kind: value.kind, peerId: value.peerId }),
    ).toBe('["qq","10001","group","900719925474099312345"]');
  });

  for (const patch of [
    { accountId: Number.MAX_SAFE_INTEGER + 1 },
    { peerId: "-1" },
    { peerId: "0" },
    { kind: "channel" },
    { agentId: "not-a-uuid" },
    { paused: "false" },
    { shareWebMemory: null },
    { token: "secret-input" },
  ]) {
    it(`rejects malformed binding field ${Object.keys(patch)[0]}`, () => {
      expect(() => createQqBinding(input(patch))).toThrow("Invalid QQ binding contract input");
    });
  }

  it("changing scheme or pause retains history; switching back to A recovers A's address", () => {
    const a = binding();
    const edited = update(a, { schemeId: OTHER_SCHEME, paused: true });
    const b = update(edited, { agentId: B });
    const again = update(b, { agentId: A });
    expect(access(edited).historyScope).toEqual(access(a).historyScope);
    expect(access(b).historyScope).not.toEqual(access(a).historyScope);
    expect(access(again).historyScope).toEqual(access(a).historyScope);
    expect(again.authorityRevision).toBe(3);
  });
});

describe("explicit owner identity and sharing", () => {
  it("has no owner until explicitly saved and rejects stale identity updates", () => {
    const empty = createQqOwnerIdentity(10001);
    expect(empty).toEqual({ accountId: "10001", peerId: null, revision: 1 });
    const me = ownerUpdate(empty, "00020001");
    expect(me).toEqual({ accountId: "10001", peerId: "20001", revision: 2 });
    expect(ownerUpdate(me, 20001)).toEqual(me);
    expect(updateQqOwnerIdentity(me, "20002", 1)).toEqual({ kind: "conflict" });
  });

  it("does not grant sharing from owner identity alone", () => {
    const value = binding({ kind: "private" }, owner());
    expect(access(value, owner()).writeScope.kind).toBe("qq");
  });

  it("allows explicit two-way sharing only for the matching owner private chat", () => {
    const me = owner();
    const value = binding({ kind: "private", shareWebMemory: true }, me);
    const resolved = access(value, me);
    expect(resolved.writeScope).toEqual({ kind: "web", agentId: A });
    expect(resolved.readScopes).toEqual([resolved.historyScope, { kind: "web", agentId: A }]);
    expect(resolved.historyScope.kind).toBe("qq");
    expect(value.ownerIdentityRevision).toBe(me.revision);
  });

  it("rejects group, missing owner, wrong account and another person's private chat", () => {
    expect(createQqBinding(input({ shareWebMemory: true }), owner())).toEqual({
      kind: "denied",
      reason: "private_only",
    });
    for (const me of [
      null,
      createQqOwnerIdentity("10001"),
      { accountId: "10002", peerId: "20001", revision: 2 },
      { accountId: "10001", peerId: "20002", revision: 2 },
    ]) {
      expect(createQqBinding(input({ kind: "private", shareWebMemory: true }), me)).toEqual({
        kind: "denied",
        reason: "owner_identity_required",
      });
    }
  });

  it("turning sharing off changes future access without moving old data", () => {
    const me = owner();
    const isolated = binding({ kind: "private" });
    const shared = update(isolated, { shareWebMemory: true }, me);
    const before = access(shared, me);
    const closed = update(shared, { shareWebMemory: false });
    expect(access(closed)).toEqual(access(isolated));
    expect(before.writeScope).toEqual({ kind: "web", agentId: A });
    expect(shared.shareWebMemory).toBe(true);
    expect(closed.ownerIdentityRevision).toBeNull();
  });

  it("agent replacement removes its grant unless explicitly reauthorized for the new agent", () => {
    const me = owner();
    const shared = binding({ kind: "private", shareWebMemory: true }, me);
    const changed = update(shared, { agentId: B });
    expect(changed.shareWebMemory).toBe(false);
    expect(access(changed).writeScope).toMatchObject({ kind: "qq", agentId: B });
    const authorized = update(shared, { agentId: B, shareWebMemory: true }, me);
    expect(access(authorized, me).writeScope).toEqual({ kind: "web", agentId: B });
  });

  it("revoked and restored owner identity cannot resurrect a prior grant", () => {
    const me = owner();
    const value = binding({ kind: "private", shareWebMemory: true }, me);
    const revoked = ownerUpdate(me, null);
    const restored = ownerUpdate(revoked, me.peerId);
    for (const identity of [revoked, restored, null]) {
      expect(resolveQqMemoryAccess(value, identity)).toEqual({
        kind: "denied",
        reason: "owner_identity_required",
      });
    }
    const refreshed = update(value, { shareWebMemory: true }, restored);
    expect(refreshed.authorityRevision).toBe(value.authorityRevision + 1);
    expect(access(refreshed, restored).writeScope.kind).toBe("web");
  });

  it("ordinary saving cannot silently renew a stale owner grant", () => {
    const me = owner();
    const value = binding({ kind: "private", shareWebMemory: true }, me);
    const changedOwner = ownerUpdate(ownerUpdate(me, "20002"), me.peerId);
    const changedScheme = update(value, { schemeId: OTHER_SCHEME }, changedOwner);
    expect(changedScheme.ownerIdentityRevision).toBe(me.revision);
    expect(resolveQqMemoryAccess(changedScheme, changedOwner).kind).toBe("denied");
    expect(access(update(changedScheme, { shareWebMemory: false })).writeScope.kind).toBe("qq");
  });
});

describe("binding revisions and in-flight guards", () => {
  it("rejects stale saves and immutable identity patches, while no-op saves preserve revisions", () => {
    const value = binding();
    expect(updateQqBinding(value, { paused: true }, 9)).toEqual({ kind: "conflict" });
    expect(update(value, {})).toEqual(value);
    expect(update(value, { schemeId: SCHEME, paused: false })).toEqual(value);
    for (const patch of [{ accountId: "10002" }, { id: B }, { authorityRevision: 0 }]) {
      expect(() => update(value, patch)).toThrow("Invalid QQ binding contract input");
    }
  });

  it("keeps frozen snapshots independent from later edits", () => {
    const value = binding();
    const task = snapshot(value);
    update(value, { agentId: B, schemeId: OTHER_SCHEME });
    expect(task.agentId).toBe(A);
    expect(task.schemeId).toBe(SCHEME);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(task)).toBe(true);
    expect(Object.isFrozen(task.access)).toBe(true);
    expect(Object.isFrozen(task.access.readScopes)).toBe(true);
    expect(task.access.readScopes.every(Object.isFrozen)).toBe(true);
  });

  it("blocks new/queued tasks and sending during pause but permits running organization publish", () => {
    const value = binding();
    const reply = snapshot(value);
    const organization = snapshot(value, "organization");
    const paused = update(value, { paused: true });
    expect(captureQqTask(paused, "reply")).toEqual({ kind: "blocked", reason: "paused" });
    expect(captureQqTask(paused, "organization")).toEqual({ kind: "blocked", reason: "paused" });
    expect(checkQqTask(reply, paused, "send")).toEqual({ kind: "blocked", reason: "paused" });
    expect(checkQqTask(organization, paused, "start")).toEqual({
      kind: "blocked",
      reason: "paused",
    });
    expect(checkQqTask(organization, paused, "publish")).toEqual({ kind: "allowed" });
  });

  it("pause then resume does not revive old queued replies or organization work", () => {
    const value = binding();
    const resumed = update(update(value, { paused: true }), { paused: false });
    expect(checkQqTask(snapshot(value), resumed, "send")).toEqual({
      kind: "blocked",
      reason: "binding_changed",
    });
    expect(checkQqTask(snapshot(value, "organization"), resumed, "start").kind).toBe("blocked");
    expect(checkQqTask(snapshot(resumed), resumed, "send")).toEqual({ kind: "allowed" });
    expect(checkQqTask(snapshot(value, "organization"), resumed, "publish")).toEqual({
      kind: "allowed",
    });
  });

  it("scheme replacement stops old replies but does not change a running organization snapshot", () => {
    const value = binding();
    const edited = update(value, { schemeId: OTHER_SCHEME });
    expect(edited.authorityRevision).toBe(value.authorityRevision);
    expect(checkQqTask(snapshot(value), edited, "send").kind).toBe("blocked");
    expect(checkQqTask(snapshot(value, "organization"), edited, "publish")).toEqual({
      kind: "allowed",
    });
  });

  it("A to B to A cannot revive old organization results", () => {
    const value = binding();
    const changed = update(value, { agentId: B });
    const restored = update(changed, { agentId: A });
    const task = snapshot(value, "organization");
    expect(checkQqTask(task, changed, "publish").kind).toBe("blocked");
    expect(checkQqTask(task, restored, "publish")).toEqual({
      kind: "blocked",
      reason: "authority_changed",
    });
  });

  it("sharing off then on cannot revive old shared results even with identical final scopes", () => {
    const me = owner();
    const value = binding({ kind: "private", shareWebMemory: true }, me);
    const task = snapshot(value, "organization", me);
    const closed = update(value, { shareWebMemory: false });
    const restored = update(closed, { shareWebMemory: true }, me);
    expect(access(restored, me)).toEqual(task.access);
    for (const current of [closed, restored]) {
      expect(checkQqTask(task, current, "publish", me)).toEqual({
        kind: "blocked",
        reason: "authority_changed",
      });
    }
  });

  it("identity revocation stops shared start, send and publish without a binding edit", () => {
    const me = owner();
    const value = binding({ kind: "private", shareWebMemory: true }, me);
    const revoked = ownerUpdate(me, null);
    const reply = snapshot(value, "reply", me);
    const organization = snapshot(value, "organization", me);
    expect(checkQqTask(reply, value, "start", revoked).kind).toBe("blocked");
    expect(checkQqTask(reply, value, "send", revoked).kind).toBe("blocked");
    expect(checkQqTask(organization, value, "publish", revoked).kind).toBe("blocked");
    expect(captureQqTask(value, "reply", revoked).kind).toBe("blocked");
  });

  it("rejects missing/recreated/foreign bindings and crossed task purposes", () => {
    const value = binding();
    const reply = snapshot(value);
    for (const current of [
      null,
      binding({ id: B }),
      binding({ peerId: "20002" }),
      binding({ accountId: "10002" }),
    ]) {
      expect(checkQqTask(reply, current, "send")).toEqual({
        kind: "blocked",
        reason: "binding_changed",
      });
    }
    expect(checkQqTask(reply, value, "publish")).toEqual({
      kind: "blocked",
      reason: "wrong_purpose",
    });
    expect(checkQqTask(snapshot(value, "organization"), value, "send")).toEqual({
      kind: "blocked",
      reason: "wrong_purpose",
    });
  });

  it("rejects revision overflow instead of reusing a prior value", () => {
    const max = { ...binding(), revision: Number.MAX_SAFE_INTEGER };
    expect(() => update(max, { paused: true })).toThrow("QQ binding revision exhausted");
    expect(() => ownerUpdate({ ...owner(), revision: Number.MAX_SAFE_INTEGER }, null)).toThrow(
      "QQ binding revision exhausted",
    );
    expect(() => access({ ...binding(), revision: 0 })).toThrow(
      "Invalid QQ binding contract input",
    );
  });
});

describe("independent QQ observation provenance", () => {
  it("keeps protocol event identity, paused observations and agent-scoped history without a Turn", () => {
    const event = observation();
    const source = qqObservationSource(binding({ paused: true }), event);
    expect(source).toEqual({
      type: "qq_observation",
      scopeKey: `["qq","10001","group","20001","${A}"]`,
      conversationKey: event.conversation.key,
      eventKey: event.eventKey,
      messageId: "-7",
      occurredAtSeconds: 123456,
      speakerKind: "member",
      speakerId: "30001",
    });
    expect(Object.keys(source)).not.toContain("turn_id");
    expect(qqObservationSource(binding({ agentId: B }), event).scopeKey).not.toBe(source.scopeKey);
  });

  it("does not attribute anonymous or system observations to a stable member", () => {
    for (const sub_type of ["anonymous", "notice"]) {
      const source = qqObservationSource(binding(), observation({ sub_type }));
      expect(source.speakerId).toBeNull();
    }
  });

  it("retains private provenance when new long-term memory is shared with web", () => {
    const value = binding({ kind: "private", shareWebMemory: true }, owner());
    const event = observation({ message_type: "private", user_id: 20001, sub_type: "friend" });
    expect(qqObservationSource(value, event).scopeKey).toBe(
      `["qq","10001","private","20001","${A}"]`,
    );
    expect(access(value, owner()).writeScope).toEqual({ kind: "web", agentId: A });
  });

  it("rejects foreign conversations and forged source keys or speakers", () => {
    const event = observation();
    for (const bad of [
      { ...event, eventKey: "fake" },
      { ...event, conversation: { ...event.conversation, key: "fake" } },
      { ...event, messageId: "-0" },
      { ...event, speaker: { ...event.speaker, id: "10001" } },
      { ...event, speaker: { ...event.speaker, kind: "anonymous" as const } },
      { ...event, occurredAtSeconds: Number.NaN },
    ])
      expect(() => qqObservationSource(binding(), bad)).toThrow();
    expect(() => qqObservationSource(binding({ accountId: "10002" }), event)).toThrow();
    expect(() => qqObservationSource(binding({ peerId: "20002" }), event)).toThrow();
    expect(() => qqObservationSource(binding({ kind: "private" }), event)).toThrow();
  });
});

describe("模式互斥：绑定合同的显式 triggers 写入", () => {
  it("createQqBinding 显式双 true 拒绝；缺省（全跟随）不受影响", () => {
    expect(() =>
      createQqBinding(
        input({
          triggers: { direct_reply: null, follow_up: true, chiming_in: true, idle_topic: null },
        }),
      ),
    ).toThrow("连续交谈与自主接话互斥");
    const fresh = saved(createQqBinding(input()));
    expect(fresh.triggers.follow_up).toBeNull();
    expect(fresh.triggers.chiming_in).toBeNull();
  });

  it("updateQqBinding 显式补丁携带双 true 拒绝（含与存量相同值）；无 triggers 补丁放行", () => {
    // 存量 raw 双 true 行不能经由合同新建（create 已拒），作为 legacy fixture 直接构造。
    const legacy: QqBinding = {
      ...saved(createQqBinding(input())),
      triggers: { direct_reply: true, follow_up: true, chiming_in: true, idle_topic: false },
    };
    // 存量 raw 双 true；补丁重写相同双 true → 拒。
    expect(() => update(legacy, { triggers: { ...legacy.triggers } })).toThrow(
      "连续交谈与自主接话互斥",
    );
    // 无 triggers 补丁（paused 翻转）→ 放行。
    const savedPatch = update(legacy, { paused: true });
    expect(savedPatch.triggers.follow_up).toBe(true);
    expect(savedPatch.triggers.chiming_in).toBe(true);
    expect(savedPatch.paused).toBe(true);
  });
});

// ---- 0059：并行任务上限与输入防抖的本会话覆盖 ----
//
// 两组与 triggers 覆盖同一三态语义：null＝跟随方案，非 null＝本会话覆盖；整组来或整组不动。
// 修订口径与既有普通修改一致：真的变了才 +1 revision，authorityRevision 不动——飞行中任务的
// 判据仍是 plain revision/authorityRevision 数值，不因新组扩成第二套权限修订。

const ALL_INHERIT_TASK_LIMITS = { mention_task_limit: null, ordinary_task_limit: null };
const ALL_INHERIT_ANTI_SPAM = { enabled: null };

describe("0059 binding override groups: task limits and input anti-spam", () => {
  it("a fresh group or private binding follows its scheme for both groups", () => {
    for (const kind of ["group", "private"] as const) {
      const value = binding({ kind });
      expect(value.taskLimits).toEqual(ALL_INHERIT_TASK_LIMITS);
      expect(value.inputAntiSpam).toEqual(ALL_INHERIT_ANTI_SPAM);
    }
  });

  it("create travels explicit groups whole, group and private on the same binding path", () => {
    for (const kind of ["group", "private"] as const) {
      const value = binding({
        kind,
        taskLimits: { mention_task_limit: 8, ordinary_task_limit: 2 },
        inputAntiSpam: { enabled: false },
      });
      expect(value.taskLimits).toEqual({ mention_task_limit: 8, ordinary_task_limit: 2 });
      expect(value.inputAntiSpam).toEqual({ enabled: false });
    }
  });

  it("an omitted patch keeps the stored groups; an explicit null restores inherit", () => {
    const value = binding({
      taskLimits: { mention_task_limit: 8, ordinary_task_limit: 2 },
      inputAntiSpam: { enabled: false },
    });
    const kept = update(value, { paused: true });
    expect(kept.taskLimits).toEqual({ mention_task_limit: 8, ordinary_task_limit: 2 });
    expect(kept.inputAntiSpam).toEqual({ enabled: false });
    const restored = update(kept, {
      taskLimits: ALL_INHERIT_TASK_LIMITS,
      inputAntiSpam: ALL_INHERIT_ANTI_SPAM,
    });
    expect(restored.taskLimits).toEqual(ALL_INHERIT_TASK_LIMITS);
    expect(restored.inputAntiSpam).toEqual(ALL_INHERIT_ANTI_SPAM);
  });

  it("a real change bumps the revision once and never the authority revision", () => {
    const value = binding();
    const changed = update(value, {
      taskLimits: { mention_task_limit: 6, ordinary_task_limit: 1 },
    });
    expect(changed.revision).toBe(value.revision + 1);
    expect(changed.authorityRevision).toBe(value.authorityRevision);
    // 同值重存是不变化：不改 revision，也不落库（repository 的 no-op 纪律在行写入侧复核）。
    const same = update(changed, { taskLimits: { mention_task_limit: 6, ordinary_task_limit: 1 } });
    expect(same.revision).toBe(changed.revision);
  });

  it("a stale expected revision is a conflict, not an overwrite", () => {
    const value = binding();
    // 存量 revision=1；调用方拿着别人推进到的 revision=2 保存 → 冲突，不是覆盖。
    const moved = update(value, { paused: true });
    const result = updateQqBinding(
      value,
      { taskLimits: { mention_task_limit: 6, ordinary_task_limit: 1 } },
      moved.revision,
    );
    expect(result.kind).toBe("conflict");
  });

  it("rejects out-of-range caps and extra fields in both groups", () => {
    for (const bad of [
      { taskLimits: { mention_task_limit: 0, ordinary_task_limit: 1 } },
      { taskLimits: { mention_task_limit: 65, ordinary_task_limit: 1 } },
      { taskLimits: { mention_task_limit: 4, ordinary_task_limit: 1.5 } },
      { taskLimits: { mention_task_limit: 4, extra: 1 } },
      { inputAntiSpam: { enabled: "yes" } },
      { inputAntiSpam: { enabled: null, extra: 1 } },
    ]) {
      expect(() => createQqBinding(input(bad))).toThrow();
      expect(() => update(binding(), bad)).toThrow();
    }
  });

  it("flight checks stay on plain revisions: new groups ride the existing snapshot, not a second framework", () => {
    const value = binding();
    const before = snapshot(value);
    const changed = update(value, { inputAntiSpam: { enabled: false } });
    // 普通修改推进 revision：start 阶段的旧快照按既有 binding_changed 拒绝。
    expect(checkQqTask(before, changed, "start")).toEqual({
      kind: "blocked",
      reason: "binding_changed",
    });
    // organization 的 publish 阶段按既有规则不因 revision 变化失效，authority 数值未动。
    const org = snapshot(value, "organization");
    expect(checkQqTask(org, changed, "publish")).toEqual({ kind: "allowed" });
  });
});
