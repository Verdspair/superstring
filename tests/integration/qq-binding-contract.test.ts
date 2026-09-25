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
