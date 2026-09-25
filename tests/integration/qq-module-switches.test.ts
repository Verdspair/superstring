// 群级模块开关（ADR0018 §0.6/F05, 0029, P5t）。
//
// The plan allows a conversation to switch a module off for itself while the detailed parameters
// stay on the scheme. What matters for review is that the switch is REAL: every gate that decides
// whether something may be prepared, generated, reviewed or sent has to read the same resolved
// answer, or a group that switched a module off would still end up speaking.

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { type BusinessDbHandle, toOrmHandle } from "../../src/server/db/connection";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { nextQqImmediateReplyTask } from "../../src/server/services/qq-dispatch";
import { prepareQqJudgement } from "../../src/server/services/qq-judgement-preparation";
import type { QqBindingResponse } from "../../src/shared/contracts/qq";

const agentId = "00000000-0000-0000-0000-000000000001";
const bindingId = "11111111-1111-4111-8111-111111111111";
const now = 2_000_000_000;

const migratedImage = (() => {
  const h = openBusinessDb();
  const image = h.db.serialize();
  h.close();
  return image;
})();

function cloneBusinessDb(): BusinessDbHandle {
  const db = Database.deserialize(migratedImage);
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  return toOrmHandle(db);
}

function setup(options: { schemeTriggers?: Partial<Record<string, boolean>> } = {}) {
  const h = cloneBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "synthetic",
    triggers: {
      direct_reply: true,
      follow_up: true,
      chiming_in: true,
      idle_topic: true,
      ...options.schemeTriggers,
    },
  });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId,
      schemeId: scheme.id,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  return { h, schemeId: scheme.id };
}

/** Set this conversation's own switches; null members follow the scheme. */
function setBindingTriggers(
  orm: Orm,
  triggers: {
    direct_reply: boolean | null;
    follow_up: boolean | null;
    chiming_in: boolean | null;
    idle_topic: boolean | null;
  },
) {
  orm
    .update(schema.qqBindings)
    .set({
      triggerDirectReply: triggers.direct_reply === null ? null : triggers.direct_reply ? 1 : 0,
      triggerFollowUp: triggers.follow_up === null ? null : triggers.follow_up ? 1 : 0,
      triggerChimingIn: triggers.chiming_in === null ? null : triggers.chiming_in ? 1 : 0,
      triggerIdleTopic: triggers.idle_topic === null ? null : triggers.idle_topic ? 1 : 0,
    })
    .run();
}

const ALL_NULL = { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null };

function event(orm: Orm, key: string, at: number, addressed = false) {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey: key,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId,
      messageId: key,
      occurredAtSeconds: at,
      speakerKind: "member",
      speakerId: "20002",
      addressed: addressed ? 1 : 0,
      recordedAt: nowIso(),
    })
    .run();
}

describe("the switches resolve per conversation, not per scheme", () => {
  it("lets a conversation switch a module OFF that its scheme allows", () => {
    const { h } = setup();
    try {
      event(h.orm, "evt-1", now - 10, true);
      // The scheme allows direct replies, and the fresh binding follows it.
      expect(
        prepareQqJudgement(h.orm, { bindingId, path: "direct_reply", nowSeconds: now }).kind,
      ).toBe("prepared");
      setBindingTriggers(h.orm, { ...ALL_NULL, direct_reply: false });
      expect(
        prepareQqJudgement(h.orm, { bindingId, path: "direct_reply", nowSeconds: now }),
      ).toEqual({ kind: "blocked", reason: "trigger_off" });
      // The immediate finder reads the same answer: no direct reply is even proposed.
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).toBeNull();
    } finally {
      h.close();
    }
  });

  it("lets a conversation switch a module ON that its scheme disabled", () => {
    const { h } = setup({ schemeTriggers: { direct_reply: false } });
    try {
      event(h.orm, "evt-1", now - 10, true);
      expect(
        prepareQqJudgement(h.orm, { bindingId, path: "direct_reply", nowSeconds: now }),
      ).toEqual({ kind: "blocked", reason: "trigger_off" });
      setBindingTriggers(h.orm, { ...ALL_NULL, direct_reply: true });
      expect(
        prepareQqJudgement(h.orm, { bindingId, path: "direct_reply", nowSeconds: now }).kind,
      ).toBe("prepared");
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).toMatchObject({
        path: "direct_reply",
      });
    } finally {
      h.close();
    }
  });

  it("keeps the other three modules on the scheme while one is overridden", () => {
    const { h } = setup();
    try {
      event(h.orm, "evt-1", now - 10, true);
      setBindingTriggers(h.orm, { ...ALL_NULL, chiming_in: false });
      // A continuation still prepares: only chiming-in was switched off here.
      h.orm
        .insert(schema.qqSpeechLog)
        .values({
          id: "55555555-5555-4555-8555-555555555555",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId,
          kind: "chiming_in",
          spokeAtSeconds: now - 60,
          expiresAt: "2030-01-01T00:00:00.000000Z",
          recordedAt: nowIso(),
        })
        .run();
      expect(
        prepareQqJudgement(h.orm, { bindingId, path: "follow_up", nowSeconds: now }).kind,
      ).toBe("prepared");
      expect(prepareQqJudgement(h.orm, { bindingId, path: "chiming_in", nowSeconds: now })).toEqual(
        { kind: "blocked", reason: "trigger_off" },
      );
    } finally {
      h.close();
    }
  });

  it("round-trips the switches over HTTP, and a fresh binding follows its scheme", async () => {
    const { h, schemeId } = setup();
    const app = createApp({
      business: h,
      gateway: {
        config: { baseUrl: "http://x/v1", model: "m", timeoutSeconds: 5 },
        listModels: async () => ["m"],
      } as never,
    });
    try {
      // The fixture already bound this conversation, so the surface reads that row: a fresh
      // binding is the same shape, and the point here is the round trip.
      const [created] = (await (await app.request("/qq/bindings")).json()) as QqBindingResponse[];
      if (!created) throw new Error("expected the fixture's binding");
      expect(created.scheme_id).toBe(schemeId);
      expect(created.triggers).toEqual(ALL_NULL);

      const patched = (await (
        await app.request(`/qq/bindings/${created.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            triggers: { ...ALL_NULL, idle_topic: false },
            expected_revision: created.revision,
          }),
        })
      ).json()) as QqBindingResponse;
      expect(patched.triggers).toEqual({ ...ALL_NULL, idle_topic: false });
      expect(patched.revision).toBe(created.revision + 1);

      // A no-op patch (the same switches) must not look like a change.
      const noop = (await (
        await app.request(`/qq/bindings/${created.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            triggers: { ...ALL_NULL, idle_topic: false },
            expected_revision: patched.revision,
          }),
        })
      ).json()) as QqBindingResponse;
      expect(noop.revision).toBe(patched.revision);
    } finally {
      h.close();
    }
  });
});
