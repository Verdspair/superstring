// P2f: the per-conversation trigger, its switches, and the manual action (ADR0018).
//
// The user's decision (2026-09-22): organising is triggered by a message count, the
// number is configurable per conversation, it can be switched off, and a manual
// "organise now" action exists beside it. These tests pin the consequences that
// matter: nothing is queued unless asked for, a paused or globally disabled setup
// queues nothing, and the manual action ignores the count but not the gates.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import type { QqConversationScope } from "../../src/server/db/qq-observation-repository";
import { pendingObservationCount } from "../../src/server/db/qq-observation-repository";
import { readQqSettings, updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { createSession, ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { QqObservation } from "../../src/server/services/onebot-protocol";
import {
  createQqBinding,
  type QqConversationIdentity,
  updateQqBinding,
} from "../../src/server/services/qq-binding-contract";
import { enqueueQqMemory, enqueueQqMemoryNow } from "../../src/server/services/qq-memory-enqueue";
import { scheduleQqMemory } from "../../src/server/services/qq-memory-scheduler";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MODEL = "qwen/qwen3-4b-2507";
const BINDING_A = "11111111-1111-4111-8111-111111111111";
const BINDING_B = "33333333-3333-4333-8333-333333333333";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const NOW_SECONDS = Math.floor(Date.parse("2026-09-22T12:00:00.000Z") / 1000);

const GROUP_A: QqConversationIdentity = {
  accountId: "10001",
  kind: "group",
  peerId: "20001",
};

/** Every binding in these tests names the same synthetic scheme. */
function insertScheme(orm: Orm, id = SCHEME_ID) {
  orm
    .insert(schema.qqSchemes)
    .values({ id, name: `方案 ${id}`, revision: 1, createdAt: nowIso(), updatedAt: nowIso() })
    .onConflictDoNothing()
    .run();
}

function scopeOf(identity: QqConversationIdentity): QqConversationScope {
  // `kind` is the scope discriminator ("qq"); the conversation's own kind goes in
  // `conversationKind`. Conflating the two makes every lookup match nothing.
  return {
    kind: "qq",
    accountId: identity.accountId,
    conversationKind: identity.kind,
    peerId: identity.peerId,
    agentId: AGENT_ID,
  };
}

function setup(options: { enabled?: boolean } = {}) {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const sessionId = createSession(business.orm, "会话", { modelName: MODEL }).id;
  if (options.enabled) {
    const current = readQqSettings(business.orm);
    updateQqSettings(business.orm, {
      enabled: true,
      accountId: "10001",
      expectedRevision: current.revision,
    });
  }
  return { business, orm: business.orm, sessionId };
}

/** Insert a binding row directly, since no route or UI exists yet (P2). */
function insertBinding(
  orm: Orm,
  id: string,
  identity: QqConversationIdentity,
  patch: { memoryBatchSize?: number | null; paused?: number } = {},
) {
  const now = nowIso();
  // A binding must name a real scheme; the table trigger enforces it.
  insertScheme(orm);
  orm
    .insert(schema.qqBindings)
    .values({
      id,
      accountId: identity.accountId,
      conversationKind: identity.kind,
      peerId: identity.peerId,
      agentId: AGENT_ID,
      schemeId: SCHEME_ID,
      paused: patch.paused ?? 0,
      shareWebMemory: 0,
      memoryBatchSize: patch.memoryBatchSize ?? null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function observe(
  orm: Orm,
  key: string,
  index: number,
  identity: QqConversationIdentity = GROUP_A,
): void {
  const observation: QqObservation = {
    accountId: identity.accountId,
    conversation: {
      kind: identity.kind,
      peerId: identity.peerId,
      key: JSON.stringify(["qq", identity.accountId, identity.kind, identity.peerId]),
    },
    eventKey: key,
    messageId: `-${index}`,
    occurredAtSeconds: NOW_SECONDS + index,
    subType: "normal",
    speaker: { kind: "member", id: "30001", displayName: "群友" },
    segments: [{ kind: "text", text: `消息${index}` }],
    text: `消息${index}`,
    mentionsSelf: false,
  };
  recordObservation(orm, observation, AGENT_ID);
}

/** Record `count` fresh observations starting at `start`, so keys never repeat. */
function observeMany(
  orm: Orm,
  count: number,
  start = 0,
  identity: QqConversationIdentity = GROUP_A,
): void {
  for (let i = start; i < start + count; i++) observe(orm, `evt_${i}`, i, identity);
}

function eventIdsOf(orm: Orm): string[] {
  const job = orm.select().from(schema.memoryJobs).get();
  return (
    (JSON.parse(job?.configSnapshot ?? "{}") as { source_event_ids?: string[] }).source_event_ids ??
    []
  );
}

describe("the batch size lives on the binding", () => {
  it("defaults to off, so a new binding queues nothing", () => {
    const created = createQqBinding({
      id: BINDING_A,
      ...GROUP_A,
      agentId: AGENT_ID,
      schemeId: SCHEME_ID,
      paused: false,
      shareWebMemory: false,
    });
    if (created.kind !== "saved") throw new Error("expected a saved binding");
    expect(created.binding.memoryBatchSize).toBeNull();
  });

  it("accepts a positive count, rejects zero, and bumps only the ordinary revision", () => {
    const created = createQqBinding({
      id: BINDING_A,
      ...GROUP_A,
      agentId: AGENT_ID,
      schemeId: SCHEME_ID,
      paused: false,
      shareWebMemory: false,
      memoryBatchSize: 20,
    });
    if (created.kind !== "saved") throw new Error("expected a saved binding");
    expect(created.binding.memoryBatchSize).toBe(20);

    const base = created.binding;
    // Zero and negatives are refused rather than quietly read as "off".
    expect(() => updateQqBinding(base, { memoryBatchSize: 0 }, base.revision)).toThrow();
    expect(() => updateQqBinding(base, { memoryBatchSize: -1 }, base.revision)).toThrow();

    const changed = updateQqBinding(base, { memoryBatchSize: 50 }, base.revision);
    if (changed.kind !== "saved") throw new Error("expected a saved binding");
    expect(changed.binding.memoryBatchSize).toBe(50);
    // A pacing change is NOT an authority change: it must not invalidate running work.
    expect(changed.binding.revision).toBe(base.revision + 1);
    expect(changed.binding.authorityRevision).toBe(base.authorityRevision);

    // Turning it off is a recorded change too.
    const off = updateQqBinding(
      changed.binding,
      { memoryBatchSize: null },
      changed.binding.revision,
    );
    if (off.kind !== "saved") throw new Error("expected a saved binding");
    expect(off.binding.memoryBatchSize).toBeNull();
    expect(off.binding.revision).toBe(changed.binding.revision + 1);

    // A patch that changes nothing keeps the revision, like every other no-op save.
    const noop = updateQqBinding(off.binding, { memoryBatchSize: null }, off.binding.revision);
    if (noop.kind !== "saved") throw new Error("expected a saved binding");
    expect(noop.binding.revision).toBe(off.binding.revision);
  });

  it("rejects a direct write of zero through the table CHECK", () => {
    const h = setup();
    try {
      expect(() => insertBinding(h.orm, BINDING_A, GROUP_A, { memoryBatchSize: 0 })).toThrow();
      insertBinding(h.orm, BINDING_A, GROUP_A, { memoryBatchSize: 5 });
      expect(h.orm.select().from(schema.qqBindings).all()).toHaveLength(1);
    } finally {
      h.business.close();
    }
  });
});

describe("automatic scheduling", () => {
  it("queues nothing while the global switch is off", () => {
    const h = setup();
    try {
      insertBinding(h.orm, BINDING_A, GROUP_A, { memoryBatchSize: 3 });
      observeMany(h.orm, 5);
      // The observations exist and the count is reached, but the feature is off.
      expect(pendingObservationCount(h.orm, scopeOf(GROUP_A), nowIso())).toBe(5);
      expect(scheduleQqMemory(h.orm)).toEqual({ due: 0, enqueued: 0 });
      expect(h.orm.select().from(schema.memoryJobs).all()).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("queues nothing when the binding is off or paused", () => {
    const h = setup({ enabled: true });
    try {
      insertBinding(h.orm, BINDING_A, GROUP_A, { memoryBatchSize: null });
      observeMany(h.orm, 5);
      expect(scheduleQqMemory(h.orm)).toEqual({ due: 0, enqueued: 0 });
      // Paused: a count is configured, but the conversation is paused.
      h.orm.update(schema.qqBindings).set({ memoryBatchSize: 3, paused: 1 }).run();
      expect(scheduleQqMemory(h.orm)).toEqual({ due: 0, enqueued: 0 });
      expect(h.orm.select().from(schema.memoryJobs).all()).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("waits for the configured count, then queues exactly that many", () => {
    const h = setup({ enabled: true });
    try {
      insertBinding(h.orm, BINDING_A, GROUP_A, { memoryBatchSize: 3 });
      observeMany(h.orm, 2);
      expect(scheduleQqMemory(h.orm)).toEqual({ due: 0, enqueued: 0 });
      observeMany(h.orm, 3, 2);
      expect(scheduleQqMemory(h.orm)).toEqual({ due: 1, enqueued: 1 });
      expect(eventIdsOf(h.orm)).toEqual(["evt_0", "evt_1", "evt_2"]);
      // The batch is marked offered, so the remaining two wait for the next cycle.
      expect(pendingObservationCount(h.orm, scopeOf(GROUP_A), nowIso())).toBe(2);
    } finally {
      h.business.close();
    }
  });

  it("refuses to queue a second conversation of the same assistant while one is active", () => {
    const h = setup({ enabled: true });
    try {
      const groupB: QqConversationIdentity = { accountId: "10001", kind: "group", peerId: "20002" };
      insertBinding(h.orm, BINDING_A, GROUP_A, { memoryBatchSize: 1 });
      insertBinding(h.orm, BINDING_B, groupB, { memoryBatchSize: 1 });
      observe(h.orm, "evt_a", 0, GROUP_A);
      observe(h.orm, "evt_b", 1, groupB);
      // Both are due, but the queue allows one active job per assistant: the first
      // wins and the other is reported as due-but-not-enqueued rather than lost.
      const result = scheduleQqMemory(h.orm);
      expect(result.due).toBe(2);
      expect(result.enqueued).toBe(1);
      expect(h.orm.select().from(schema.memoryJobs).all()).toHaveLength(1);
      // Nothing was marked offered for the declined conversation, so it can still run.
      expect(pendingObservationCount(h.orm, scopeOf(groupB), nowIso())).toBe(1);
    } finally {
      h.business.close();
    }
  });

  it("skips a conversation of an inactive assistant", () => {
    const h = setup({ enabled: true });
    try {
      insertBinding(h.orm, BINDING_A, GROUP_A, { memoryBatchSize: 1 });
      observeMany(h.orm, 1);
      h.orm.update(schema.agents).set({ isActive: 0 }).run();
      expect(scheduleQqMemory(h.orm)).toEqual({ due: 0, enqueued: 0 });
      expect(h.orm.select().from(schema.memoryJobs).all()).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("is idempotent across cycles while the previous job is still active", () => {
    const h = setup({ enabled: true });
    try {
      insertBinding(h.orm, BINDING_A, GROUP_A, { memoryBatchSize: 1 });
      observe(h.orm, "evt_0", 0);
      expect(scheduleQqMemory(h.orm).enqueued).toBe(1);
      observe(h.orm, "evt_1", 1);
      // A second cycle finds nothing pending at the threshold and the queue is busy.
      expect(scheduleQqMemory(h.orm)).toEqual({ due: 1, enqueued: 0 });
      expect(h.orm.select().from(schema.memoryJobs).all()).toHaveLength(1);
    } finally {
      h.business.close();
    }
  });
});

describe("the manual action", () => {
  it("organises everything pending regardless of the count", () => {
    const h = setup({ enabled: true });
    try {
      // The count is far above what is pending, so automatic would do nothing.
      insertBinding(h.orm, BINDING_A, GROUP_A, { memoryBatchSize: 100 });
      observeMany(h.orm, 3);
      expect(scheduleQqMemory(h.orm)).toEqual({ due: 0, enqueued: 0 });
      const job = enqueueQqMemoryNow(h.orm, {
        scope: scopeOf(GROUP_A),
        requestKey: "manual_1",
      });
      if (!job) throw new Error("expected the manual action to queue a job");
      expect(eventIdsOf(h.orm)).toEqual(["evt_0", "evt_1", "evt_2"]);
      // The setting is a pacing preference, not a cap, so pressing the button does
      // not rewrite it.
      expect(
        h.orm.select().from(schema.qqBindings).where(eq(schema.qqBindings.id, BINDING_A)).get()
          ?.memoryBatchSize,
      ).toBe(100);
      // Nothing left, so a second press reports nothing to do.
      expect(
        enqueueQqMemoryNow(h.orm, { scope: scopeOf(GROUP_A), requestKey: "manual_2" }),
      ).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("reports nothing to do when every observation is already offered", () => {
    const h = setup({ enabled: true });
    try {
      insertBinding(h.orm, BINDING_A, GROUP_A, { memoryBatchSize: 10 });
      observeMany(h.orm, 2);
      enqueueQqMemory(h.orm, { scope: scopeOf(GROUP_A), requestKey: "first", limit: 2 });
      expect(
        enqueueQqMemoryNow(h.orm, { scope: scopeOf(GROUP_A), requestKey: "again" }),
      ).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("works while automatic is switched off, because the press is the decision", () => {
    const h = setup({ enabled: true });
    try {
      insertBinding(h.orm, BINDING_A, GROUP_A, { memoryBatchSize: null });
      observeMany(h.orm, 2);
      expect(scheduleQqMemory(h.orm)).toEqual({ due: 0, enqueued: 0 });
      expect(
        enqueueQqMemoryNow(h.orm, { scope: scopeOf(GROUP_A), requestKey: "manual_off" }),
      ).not.toBeNull();
    } finally {
      h.business.close();
    }
  });
});
