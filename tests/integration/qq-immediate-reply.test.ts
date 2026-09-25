// 直接回应与连续交谈（ADR0018 P5s, §F03）。
//
// Two things are being pinned here. First, the SHAPE of the two paths: being called is the
// decision, so no judgement model call happens — the chain goes straight to the sentence, and a
// partner speaking after the assistant did is what makes a continuation. Second, the discipline
// around them: they run under the same global slot as everything else, an answered or already
// attempted message is never answered twice, and a message that has gone stale is dropped rather
// than answered late.

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { type BusinessDbHandle, toOrmHandle } from "../../src/server/db/connection";
import {
  claimQqDispatchLease,
  claimQqImmediateLease,
  releaseQqDispatchLease,
} from "../../src/server/db/qq-dispatch-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { recordQqSpeech } from "../../src/server/db/qq-speech-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  nextQqImmediateReplyTask,
  QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS,
} from "../../src/server/services/qq-dispatch";
import { runQqImmediateReplyCycle } from "../../src/server/services/qq-dispatch-cycle";

const agentId = "00000000-0000-0000-0000-000000000001";
const bindingId = "11111111-1111-4111-8111-111111111111";
const now = 2_000_000_000;

/** The stage a production host passes: no sticker copies exist in these fixtures. */
const stage = { counts: ["confirmed"] as const, isAvailable: () => false };

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

/** One account, one scheme with every trigger on, one bound group, one bound private chat. */
function setup(options: { directReply?: boolean } = {}) {
  const h = cloneBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "synthetic",
    triggers: {
      direct_reply: options.directReply ?? true,
      follow_up: true,
      chiming_in: true,
      idle_topic: true,
    },
  });
  for (const [id, kind, peer] of [
    [bindingId, "group", "30003"],
    ["33333333-3333-4333-8333-333333333333", "private", "20002"],
  ] as const) {
    h.orm
      .insert(schema.qqBindings)
      .values({
        id,
        accountId: "10001",
        conversationKind: kind,
        peerId: peer,
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
  }
  return { h, schemeId: scheme.id };
}

/** A message from a partner, with the addressed bit the intake would have written. */
function event(
  orm: Orm,
  key: string,
  at: number,
  options: { addressed?: boolean; peerId?: string; kind?: "group" | "private" } = {},
) {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey: key,
      accountId: "10001",
      conversationKind: options.kind ?? "group",
      peerId: options.peerId ?? "30003",
      agentId,
      messageId: key,
      occurredAtSeconds: at,
      speakerKind: "member",
      speakerId: "20002",
      addressed: options.addressed ? 1 : 0,
      recordedAt: nowIso(),
    })
    .run();
}

/** The assistant's own delivered line in that conversation. */
function ownSpeech(orm: Orm, at: number, peerId = "30003") {
  recordQqSpeech(orm, {
    scope: { kind: "qq", accountId: "10001", conversationKind: "group", peerId, agentId },
    kind: "chiming_in",
    spokeAtSeconds: at,
    text: "我说的",
  });
}

/** A counting gateway: the reply path must call it exactly once (no judgement call happens). */
function gateway() {
  const calls: string[] = [];
  return {
    calls,
    loadedContextCapacity: async () => 65536,
    complete: async () => {
      calls.push("complete");
      return "在的，怎么了？";
    },
  };
}

function senderOf() {
  const delivered: string[] = [];
  return {
    delivered,
    send: async ({ prepared }: { prepared: { text: string | null } }) => {
      delivered.push(prepared.text ?? "");
      return null;
    },
  };
}

describe("直接回应", () => {
  it("answers a message that was aimed at the assistant, without a judgement call", async () => {
    const { h } = setup();
    try {
      event(h.orm, "evt-1", now - 10, { addressed: true });
      // The finder CLAIMS the slot (same discipline as the queued task finder), so a test that
      // wants to run the cycle hands it back first.
      const task = nextQqImmediateReplyTask(h.orm, { nowSeconds: now });
      expect(task).toMatchObject({ bindingId, path: "direct_reply" });
      if (!task) throw new Error("expected a task");
      releaseQqDispatchLease(h.orm, task.token);

      const model = gateway();
      const sender = senderOf();
      const result = await runQqImmediateReplyCycle(
        h.orm,
        model,
        { nowSeconds: now },
        stage,
        sender.send,
      );
      expect(result).toMatchObject({ kind: "authorized", path: "direct_reply" });
      // ONE model call: the reply. A judgement call would answer "should I speak?" about a message
      // that already asked.
      expect(model.calls).toEqual(["complete"]);
      expect(sender.delivered).toEqual(["在的，怎么了？"]);
    } finally {
      h.close();
    }
  });

  it("answers any message in a private chat", async () => {
    const { h } = setup();
    try {
      event(h.orm, "evt-p", now - 5, { kind: "private", peerId: "20002" });
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).toMatchObject({
        conversationKey: expect.stringContaining("20002"),
        path: "direct_reply",
      });
    } finally {
      h.close();
    }
  });

  it("does not answer the same message twice", async () => {
    const { h } = setup();
    try {
      event(h.orm, "evt-1", now - 10, { addressed: true });
      await runQqImmediateReplyCycle(
        h.orm,
        gateway(),
        { nowSeconds: now },
        stage,
        async () => null,
      );
      // A delivered reply is a speech record, which is what makes the message "behind us".
      ownSpeech(h.orm, now - 1);
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).toBeNull();
    } finally {
      h.close();
    }
  });

  it("does not retry an attempt that already failed", async () => {
    const { h } = setup();
    try {
      event(h.orm, "evt-1", now - 10, { addressed: true });
      recordQqSend(h.orm, {
        scope: {
          kind: "qq",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId,
        },
        kind: "direct_reply",
        parts: [{ kind: "text", result: "failed", messageId: null }],
        sentAtSeconds: now - 5,
        text: "在的",
      });
      // §8.2: a failure is recorded, not resent. Whether it consumes the no-reply slot is U13;
      // what is decided is that the SAME message does not earn a second automatic attempt.
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).toBeNull();
    } finally {
      h.close();
    }
  });

  it("drops a message that has gone stale instead of answering it late", async () => {
    const { h } = setup();
    try {
      event(h.orm, "evt-old", now - QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS - 1, { addressed: true });
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).toBeNull();
    } finally {
      h.close();
    }
  });

  it("respects the scheme's direct-reply trigger switch", async () => {
    const { h } = setup({ directReply: false });
    try {
      event(h.orm, "evt-1", now - 5, { addressed: true });
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).toBeNull();
    } finally {
      h.close();
    }
  });
});

describe("连续交谈", () => {
  it("continues an exchange a partner picked up after the assistant spoke", async () => {
    const { h } = setup();
    try {
      ownSpeech(h.orm, now - 60);
      event(h.orm, "evt-after", now - 10);
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).toMatchObject({
        path: "follow_up",
      });
    } finally {
      h.close();
    }
  });

  it("leaves a message in a room the assistant never spoke in to the initiative sweep", async () => {
    const { h } = setup();
    try {
      // Nobody was addressed and the assistant has said nothing here: that is a chiming-in
      // candidate, not a continuation.
      event(h.orm, "evt-plain", now - 10);
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).toBeNull();
    } finally {
      h.close();
    }
  });

  it("prefers the newest of several waiting messages", async () => {
    const { h } = setup();
    try {
      event(h.orm, "evt-older", now - 100, { addressed: true });
      event(h.orm, "evt-newer", now - 20, { kind: "private", peerId: "20002" });
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })?.eventKey).toBe("evt-newer");
    } finally {
      h.close();
    }
  });
});

describe("the global slot", () => {
  it("waits while another chain holds the slot, and takes it the moment it frees", () => {
    const { h } = setup();
    try {
      event(h.orm, "evt-1", now - 5, { addressed: true });
      const held = claimQqImmediateLease(h.orm, {
        token: "someone-else",
        conversationKey: "their-room",
        nowSeconds: now,
        leaseSeconds: 120,
      });
      expect(held).toBe(true);
      // The plan keeps one QQ model chain running at a time; the message waits, and because the
      // decision is re-derived from storage the wait costs nothing and survives a restart.
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).toBeNull();
      releaseQqDispatchLease(h.orm, "someone-else");
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).toMatchObject({
        path: "direct_reply",
      });
    } finally {
      h.close();
    }
  });

  it("takes over a lapsed lease rather than waiting for its owner", () => {
    const { h } = setup();
    try {
      event(h.orm, "evt-1", now - 5, { addressed: true });
      claimQqImmediateLease(h.orm, {
        token: "dead-owner",
        conversationKey: "their-room",
        nowSeconds: now - 300,
        leaseSeconds: 120,
      });
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).toMatchObject({
        path: "direct_reply",
      });
    } finally {
      h.close();
    }
  });

  it("keeps a held candidate's claim intact when an immediate reply takes an expired slot", () => {
    const { h } = setup();
    try {
      // A queued candidate exists and its lease lapsed; taking the slot for an immediate reply must
      // clear the stale claim marker, or the queued task would look claimed by a dead owner.
      event(h.orm, "evt-1", now - 5, { addressed: true });
      h.orm
        .insert(schema.qqDispatchCandidates)
        .values({
          conversationKey: "some-room",
          bindingId,
          eventKey: null,
          path: "chiming_in",
          readyAtSeconds: now - 600,
          observedAtSeconds: now - 600,
          generation: 1,
          claimedGeneration: 1,
        })
        .run();
      claimQqDispatchLease(h.orm, {
        token: "dead-owner",
        conversationKey: "some-room",
        generation: 1,
        nowSeconds: now - 600,
        leaseSeconds: 120,
      });
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).not.toBeNull();
      const row = h.orm.select().from(schema.qqDispatchCandidates).all()[0];
      expect(row?.claimedGeneration).toBeNull();
    } finally {
      h.close();
    }
  });
});
