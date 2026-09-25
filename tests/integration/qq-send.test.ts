// P4c: send results for the assistant's own messages (ADR0018).
//
// The transport already answered per request (confirmed / failed / unknown / not_sent)
// and nothing consumed it: §8.2's rows existed only as prose, and the assistant's speech
// record had no production writer. This suite pins both halves — which row an attempt
// falls into, and what the ledger then does about it.
//
// The most important assertions here are the ones about what is NOT decided. §8.2 states
// that a successful send enters the no-reply rule; whether a failure or an unknown
// outcome consumes that slot is U13, so those outcomes must report "pending" rather than
// a boolean, and a failed attempt must not quietly become a speech record. Two tests
// below fail if anyone turns that silence into a decision.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { QqConversationScope } from "../../src/server/db/qq-observation-repository";
import {
  purgeExpiredQqSends,
  type QqSendPartInput,
  readQqSend,
  readQqSends,
  recordQqSend,
  storedQqSendOutcome,
} from "../../src/server/db/qq-send-repository";
import { lastQqInitiativeSeconds, lastQqSpeech } from "../../src/server/db/qq-speech-repository";
import { createSession, ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  QQ_SEND_IS_NOT_ATOMIC,
  QQ_WITHDRAWAL_POLICY,
  qqSendOutcomeEffect,
  qqSendSummary,
} from "../../src/server/services/qq-output-contract";
import { checkQqSpeechTrigger } from "../../src/server/services/qq-speaking-contract";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  createSession(business.orm, "会话", { modelName: MODEL });
  seedSticker(business.orm, STICKER);
  return { business, orm: business.orm, db: business.db };
}

/**
 * A real asset row, because the ledger references the library: with foreign keys enforced by the
 * runtime, a sticker part naming an asset that does not exist is refused (P4g). Seeded at the fixed
 * id the part helpers use, so the fixtures state the constraint instead of dodging it.
 */
function seedSticker(orm: Orm, id: string): void {
  orm
    .insert(schema.qqStickerAssets)
    .values({
      id,
      name: "素材.png",
      description: null,
      descriptionDraft: null,
      tags: null,
      usageNote: null,
      fileName: `${id}.png`,
      mediaType: "image",
      byteSize: 128,
      width: 64,
      height: 64,
      enabled: 0,
      createdAt: "2026-01-01T00:00:00.000000Z",
      updatedAt: "2026-01-01T00:00:00.000000Z",
    })
    .run();
}

function scope(overrides: Partial<Extract<QqConversationScope, object>> = {}): QqConversationScope {
  return {
    kind: "qq",
    accountId: "10001",
    conversationKind: "group",
    peerId: "20001",
    agentId: AGENT_ID,
    ...overrides,
  } as QqConversationScope;
}

// The send contract requires a sticker part to name the asset it carried (P4g), so the helpers
// supply one for every sticker part: §9.3's per-conversation history is built from this id.
const STICKER = "22222222-2222-4222-8222-222222222222";
const stickerId = (kind: "text" | "sticker") => (kind === "sticker" ? STICKER : null);

function confirmed(kind: "text" | "sticker", id: string): QqSendPartInput {
  return { kind, result: "confirmed", messageId: id, stickerId: stickerId(kind) };
}
function failed(kind: "text" | "sticker"): QqSendPartInput {
  return { kind, result: "failed", messageId: null, stickerId: stickerId(kind) };
}
function unknown(kind: "text" | "sticker"): QqSendPartInput {
  return { kind, result: "unknown", messageId: null, stickerId: stickerId(kind) };
}
function notSent(kind: "text" | "sticker"): QqSendPartInput {
  return { kind, result: "not_sent", messageId: null, stickerId: stickerId(kind) };
}

/** A second assistant, so the scope dimension can be tested with a real foreign key. */
function addAgent(orm: Orm, id: string) {
  const at = nowIso();
  orm
    .insert(schema.agents)
    .values({
      id,
      name: "另一个助手",
      systemPrompt: "",
      description: "",
      additionalInstructions: "",
      p5Config: "{}",
      modelName: MODEL,
      memoryConsolidationPrompt: "",
      memoryConsolidationAdditionalInstructions: "",
      memoryRetrievalPrompt: "",
      updatedAt: at,
      createdAt: at,
    })
    .run();
}

/** A recorded group message, written directly so the test controls the speaker. */
function insertMemberMessage(orm: Orm, eventKey: string, atSeconds: number) {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey,
      accountId: "10001",
      conversationKind: "group",
      peerId: "20001",
      agentId: AGENT_ID,
      messageId: eventKey,
      occurredAtSeconds: atSeconds,
      speakerKind: "member",
      speakerId: "30001",
      recordedAt: nowIso(),
    })
    .run();
}

describe("send outcome classification", () => {
  it("calls a fully confirmed reply sent and remembers the platform message", () => {
    const summary = qqSendSummary({ parts: [confirmed("text", "m1")] });
    expect(summary.outcome).toBe("sent");
    expect(summary.deliveryMessageId).toBe("m1");
    expect(summary).toMatchObject({
      partCount: 1,
      textParts: 1,
      stickerParts: 0,
      confirmedParts: 1,
    });
  });

  it("calls a reply whose later sticker failed partially_sent, keeping what arrived", () => {
    const summary = qqSendSummary({
      parts: [confirmed("text", "m1"), failed("sticker")],
    });
    expect(summary.outcome).toBe("partially_sent");
    expect(summary.deliveryMessageId).toBe("m1");
    expect(summary).toMatchObject({ confirmedParts: 1, failedParts: 1, stickerParts: 1 });
  });

  it("distinguishes a failed sticker-only reply from a failed text reply", () => {
    expect(qqSendSummary({ parts: [failed("sticker")] }).outcome).toBe("sticker_failed");
    expect(qqSendSummary({ parts: [failed("sticker"), failed("sticker")] }).outcome).toBe(
      "sticker_failed",
    );
    expect(qqSendSummary({ parts: [failed("text")] }).outcome).toBe("text_failed");
    expect(qqSendSummary({ parts: [failed("text"), failed("sticker")] }).outcome).toBe(
      "text_failed",
    );
  });

  it("treats an unanswered fate as unknown, and never as a failure", () => {
    expect(qqSendSummary({ parts: [unknown("text")] }).outcome).toBe("unknown");
    // Something may have been delivered, so an unknown part outranks "never submitted".
    expect(qqSendSummary({ parts: [notSent("text"), unknown("text")] }).outcome).toBe("unknown");
  });

  it("calls an attempt whose requests never left not_submitted", () => {
    const summary = qqSendSummary({ parts: [notSent("text"), notSent("sticker")] });
    expect(summary.outcome).toBe("not_submitted");
    expect(summary.deliveryMessageId).toBeNull();
    expect(summary.notSubmittedParts).toBe(2);
  });

  it("refuses an attempt with no parts, or with a platform id the platform never gave", () => {
    expect(() => qqSendSummary({ parts: [] })).toThrow(TypeError);
    // Confirmed without an id, and an id on a part that was not confirmed: both are
    // claims the platform did not make.
    expect(() =>
      qqSendSummary({ parts: [{ kind: "text", result: "confirmed", messageId: null }] }),
    ).toThrow(TypeError);
    expect(() =>
      qqSendSummary({ parts: [{ kind: "text", result: "unknown", messageId: "m1" }] }),
    ).toThrow(TypeError);
  });

  it("refuses parts it does not recognise instead of guessing an outcome", () => {
    expect(() =>
      qqSendSummary({ parts: [{ kind: "voice", result: "confirmed", messageId: "m1" }] }),
    ).toThrow(TypeError);
    expect(() =>
      qqSendSummary({ parts: [{ kind: "text", result: "maybe", messageId: null }] }),
    ).toThrow(TypeError);
    expect(() => qqSendSummary({ parts: [confirmed("text", "m1")], extra: true })).toThrow(
      TypeError,
    );
    expect(() => qqSendSummary(null)).toThrow(TypeError);
  });
});

describe("what may be done about each outcome", () => {
  it("records delivery and material history only for a reply that arrived intact", () => {
    expect(qqSendOutcomeEffect("sent")).toMatchObject({
      recordsDeliveryId: true,
      updatesMaterialHistory: true,
      entersUnresponded: true,
    });
    expect(qqSendOutcomeEffect("partially_sent")).toMatchObject({
      recordsDeliveryId: true,
      updatesMaterialHistory: false,
    });
    for (const outcome of ["sticker_failed", "text_failed", "unknown", "not_submitted"]) {
      expect(qqSendOutcomeEffect(outcome)).toMatchObject({
        recordsDeliveryId: false,
        updatesMaterialHistory: false,
      });
    }
  });

  it("never permits an automatic resend, a sticker swap, a rewrite or an explanation", () => {
    for (const outcome of [
      "sent",
      "partially_sent",
      "sticker_failed",
      "text_failed",
      "unknown",
      "not_submitted",
    ]) {
      const effect = qqSendOutcomeEffect(outcome);
      expect(effect.resendsAutomatically).toBe(false);
      expect(effect.replacesSticker).toBe(false);
      expect(effect.rewritesText).toBe(false);
      expect(effect.explainsFailure).toBe(false);
    }
  });

  it("does not assume a delivery for an unknown outcome", () => {
    expect(qqSendOutcomeEffect("unknown").assumesDelivery).toBe(false);
    for (const outcome of [
      "sent",
      "partially_sent",
      "sticker_failed",
      "text_failed",
      "not_submitted",
    ]) {
      expect(qqSendOutcomeEffect(outcome).assumesDelivery).toBe(true);
    }
  });

  it("leaves the undecided questions visible instead of answering them", () => {
    // §8.2 states the no-reply rule for a successful send. Whether a failed or
    // unknown attempt consumes that slot is U13, so anything else says "pending" —
    // a boolean here would be a decision nobody has made.
    expect(qqSendOutcomeEffect("sent").entersUnresponded).toBe(true);
    for (const outcome of [
      "partially_sent",
      "sticker_failed",
      "text_failed",
      "unknown",
      "not_submitted",
    ]) {
      expect(qqSendOutcomeEffect(outcome).entersUnresponded).toBe("pending");
    }
    expect(qqSendOutcomeEffect("text_failed").pending).toEqual(["manual_retry"]);
    expect(qqSendOutcomeEffect("unknown").pending).toEqual(["unknown_reconciliation"]);
    expect(qqSendOutcomeEffect("sent").pending).toEqual([]);
  });

  it("publishes the two standing policies as named answers", () => {
    expect(QQ_SEND_IS_NOT_ATOMIC).toBe(true);
    expect(QQ_WITHDRAWAL_POLICY).toEqual({
      recoversSubmittedRequest: false,
      autoRecallsDeliveredContent: false,
    });
  });
});

describe("the send ledger", () => {
  it("stores an attempt with its parts in send order", () => {
    const h = setup();
    try {
      const at = 1_000;
      const record = recordQqSend(h.orm, {
        scope: scope(),
        kind: "direct_reply",
        sentAtSeconds: at,
        text: null,
        parts: [confirmed("text", "m1"), failed("sticker")],
      });
      expect(record.outcome).toBe("partially_sent");
      expect(record.log.deliveryMessageId).toBe("m1");
      expect(storedQqSendOutcome(record.log)).toBe("partially_sent");
      const stored = readQqSend(h.orm, record.log.id);
      expect(stored?.parts.map((part) => [part.partIndex, part.partKind, part.result])).toEqual([
        [0, "text", "confirmed"],
        [1, "sticker", "failed"],
      ]);
      expect(stored?.parts[0]?.platformMessageId).toBe("m1");
      expect(stored?.parts[1]?.platformMessageId).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("rolls back a confirmed attempt if its speech text is invalid", () => {
    const h = setup();
    try {
      expect(() =>
        recordQqSend(h.orm, {
          scope: scope(),
          kind: "chiming_in",
          sentAtSeconds: 2_000,
          text: "   ",
          parts: [confirmed("text", "m-rollback")],
        }),
      ).toThrow(TypeError);
      expect(readQqSends(h.orm, scope())).toEqual([]);
      expect(lastQqSpeech(h.orm, scope())).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("turns a delivered utterance into the speech record the no-reply rule reads", () => {
    const h = setup();
    try {
      const record = recordQqSend(h.orm, {
        scope: scope(),
        kind: "idle_topic",
        sentAtSeconds: 2_000,
        text: null,
        parts: [confirmed("text", "m1")],
      });
      expect(record.unrespondedRecord).toEqual({ kind: "recorded" });
      expect(lastQqInitiativeSeconds(h.orm, scope())).toBe(2_000);
      // ...and the rule now holds the assistant back until somebody answers.
      const blocked = checkQqSpeechTrigger({
        kind: "idle_topic",
        featureEnabled: true,
        conversationPaused: false,
        disabledKinds: [],
        lastInitiativeSeconds: lastQqInitiativeSeconds(h.orm, scope()),
        newestMemberMessageSeconds: null,
      });
      expect(blocked).toEqual({ kind: "blocked", reason: "awaiting_reply" });
      insertMemberMessage(h.orm, "e1", 2_001);
      const released = checkQqSpeechTrigger({
        kind: "idle_topic",
        featureEnabled: true,
        conversationPaused: false,
        disabledKinds: [],
        lastInitiativeSeconds: lastQqInitiativeSeconds(h.orm, scope()),
        newestMemberMessageSeconds: 2_001,
      });
      expect(released).toEqual({ kind: "allowed" });
    } finally {
      h.business.close();
    }
  });

  it("does not turn a failed attempt into a speech record, and says why", () => {
    const h = setup();
    try {
      const record = recordQqSend(h.orm, {
        scope: scope(),
        kind: "chiming_in",
        sentAtSeconds: 3_000,
        text: null,
        parts: [failed("text")],
      });
      expect(record.outcome).toBe("text_failed");
      // The ledger keeps the attempt...
      expect(readQqSends(h.orm, scope())).toHaveLength(1);
      // ...but the no-reply rule is untouched: whether a failure consumes that slot
      // is U13, and this reports the open question rather than deciding it.
      expect(record.unrespondedRecord).toEqual({ kind: "pending_decision", item: "U13" });
      expect(lastQqInitiativeSeconds(h.orm, scope())).toBeNull();
      expect(lastQqSpeech(h.orm, scope())).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("keeps an unknown outcome out of the no-reply rule as well", () => {
    const h = setup();
    try {
      const record = recordQqSend(h.orm, {
        scope: scope(),
        kind: "chiming_in",
        sentAtSeconds: 4_000,
        text: null,
        parts: [unknown("text")],
      });
      expect(record.outcome).toBe("unknown");
      expect(record.unrespondedRecord).toEqual({ kind: "pending_decision", item: "U13" });
      expect(lastQqInitiativeSeconds(h.orm, scope())).toBeNull();
      expect(readQqSend(h.orm, record.log.id)?.log.deliveryMessageId).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("records a delivered answer without making it an initiative", () => {
    const h = setup();
    try {
      recordQqSend(h.orm, {
        scope: scope(),
        kind: "direct_reply",
        sentAtSeconds: 5_000,
        text: null,
        parts: [confirmed("text", "m1")],
      });
      expect(lastQqSpeech(h.orm, scope())).toEqual({
        kind: "direct_reply",
        spokeAtSeconds: 5_000,
      });
      // Answering being addressed is not speaking into silence.
      expect(lastQqInitiativeSeconds(h.orm, scope())).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("reads attempts newest first and only within their own conversation", () => {
    const h = setup();
    try {
      const second = "00000000-0000-0000-0000-000000000002";
      addAgent(h.orm, second);
      recordQqSend(h.orm, {
        scope: scope(),
        kind: "follow_up",
        sentAtSeconds: 6_000,
        text: null,
        parts: [confirmed("text", "m1")],
      });
      recordQqSend(h.orm, {
        scope: scope(),
        kind: "follow_up",
        sentAtSeconds: 6_100,
        text: null,
        parts: [confirmed("text", "m2")],
      });
      recordQqSend(h.orm, {
        scope: scope({ peerId: "29999" }),
        kind: "follow_up",
        sentAtSeconds: 6_200,
        text: null,
        parts: [confirmed("text", "m3")],
      });
      recordQqSend(h.orm, {
        scope: scope({ conversationKind: "private" }),
        kind: "follow_up",
        sentAtSeconds: 6_300,
        text: null,
        parts: [confirmed("text", "m4")],
      });
      recordQqSend(h.orm, {
        scope: scope({ agentId: second }),
        kind: "follow_up",
        sentAtSeconds: 6_400,
        text: null,
        parts: [confirmed("text", "m5")],
      });
      const mine = readQqSends(h.orm, scope());
      expect(mine.map((row) => row.deliveryMessageId)).toEqual(["m2", "m1"]);
      expect(readQqSends(h.orm, scope(), 1)).toHaveLength(1);
      expect(readQqSends(h.orm, scope({ agentId: second }))).toHaveLength(1);
      expect(() => readQqSends(h.orm, scope(), 0)).toThrow(TypeError);
    } finally {
      h.business.close();
    }
  });

  it("refuses impossible rows even when written straight to the database", () => {
    const h = setup();
    try {
      const at = 7_000;
      const record = recordQqSend(h.orm, {
        scope: scope(),
        kind: "follow_up",
        sentAtSeconds: at,
        text: null,
        parts: [confirmed("text", "m1")],
      });
      // A sent reply must name its platform message.
      expect(() =>
        h.db.run("UPDATE qq_send_log SET delivery_message_id = NULL WHERE id = ?", [record.log.id]),
      ).toThrow();
      // A non-delivered outcome may not name one either.
      expect(() =>
        h.db.run("UPDATE qq_send_log SET outcome = 'unknown' WHERE id = ?", [record.log.id]),
      ).toThrow();
      expect(() =>
        h.db.run("UPDATE qq_send_log SET outcome = 'invented' WHERE id = ?", [record.log.id]),
      ).toThrow();
      // A part's platform id exists exactly when that part was confirmed.
      expect(() =>
        h.db.run(
          "UPDATE qq_send_part SET platform_message_id = NULL WHERE send_id = ? AND part_index = 0",
          [record.log.id],
        ),
      ).toThrow();
      expect(() =>
        h.db.run(
          "UPDATE qq_send_part SET result = 'not_sent' WHERE send_id = ? AND part_index = 0",
          [record.log.id],
        ),
      ).toThrow();
    } finally {
      h.business.close();
    }
  });

  it("rejects invalid input before writing anything", () => {
    const h = setup();
    try {
      const send = (parts: QqSendPartInput[], sentAtSeconds = 8_000) =>
        recordQqSend(h.orm, {
          scope: scope(),
          kind: "follow_up",
          sentAtSeconds,
          text: null,
          parts,
        });
      expect(() => send([confirmed("text", "m1")], -1)).toThrow(TypeError);
      expect(() => send([confirmed("text", "m1")], 1.5)).toThrow(TypeError);
      expect(() => send([{ kind: "text", result: "confirmed", messageId: null }])).toThrow(
        TypeError,
      );
      expect(() => send([])).toThrow(TypeError);
      expect(() =>
        recordQqSend(h.orm, {
          scope: scope(),
          kind: "shout" as never,
          sentAtSeconds: 8_000,
          text: null,
          parts: [confirmed("text", "m1")],
        }),
      ).toThrow(TypeError);
      expect(readQqSends(h.orm, scope())).toHaveLength(0);
    } finally {
      h.business.close();
    }
  });

  it("drops an expired attempt together with its parts", () => {
    const h = setup();
    try {
      const now = Math.floor(Date.parse(nowIso()) / 1000);
      const fresh = recordQqSend(h.orm, {
        scope: scope(),
        kind: "follow_up",
        sentAtSeconds: now,
        text: null,
        parts: [confirmed("text", "m1")],
      });
      const old = recordQqSend(h.orm, {
        scope: scope(),
        kind: "follow_up",
        sentAtSeconds: now - 20 * 24 * 60 * 60,
        text: null,
        parts: [confirmed("text", "m2")],
      });
      expect(purgeExpiredQqSends(h.orm)).toBe(1);
      expect(purgeExpiredQqSends(h.orm)).toBe(0);
      expect(readQqSend(h.orm, old.log.id)).toBeNull();
      expect(h.db.query("SELECT count(*) AS n FROM qq_send_part").get()).toEqual({ n: 1 });
      expect(readQqSend(h.orm, fresh.log.id)?.parts).toHaveLength(1);
    } finally {
      h.business.close();
    }
  });

  it("removes an assistant's send records with the assistant", () => {
    const h = setup();
    try {
      const second = "00000000-0000-0000-0000-000000000002";
      addAgent(h.orm, second);
      for (const peerId of ["20001", "20002"]) {
        recordQqSend(h.orm, {
          scope: scope({ peerId, agentId: second }),
          kind: "follow_up",
          sentAtSeconds: 9_000,
          text: null,
          parts: [confirmed("text", "m1")],
        });
      }
      recordQqSend(h.orm, {
        scope: scope(),
        kind: "follow_up",
        sentAtSeconds: 9_100,
        text: null,
        parts: [confirmed("text", "m2")],
      });
      expect(h.db.query("SELECT count(*) AS n FROM qq_send_log").get()).toEqual({ n: 3 });
      h.orm.delete(schema.agents).where(eq(schema.agents.id, second)).run();
      // That assistant's attempts and their parts go with it; the other's survive.
      expect(h.db.query("SELECT count(*) AS n FROM qq_send_log").get()).toEqual({ n: 1 });
      expect(h.db.query("SELECT count(*) AS n FROM qq_send_part").get()).toEqual({ n: 1 });
    } finally {
      h.business.close();
    }
  });
});
