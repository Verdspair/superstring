// P4a: media rules that hold without a model or a threshold (ADR0018).
//
// The upstream behaviour these tests assume was checked, not guessed: OneBot 11 sends
// media by reference (`file` + `url`, no base64 on the receiving side) and NapCat can turn
// a `file` into a downloadable object, converting audio formats on the way.
//
// What is pinned here is the part the plan already decided: a failure stays silent in the
// conversation, a non-@ failure is never retried, an @ failure gets exactly one more
// attempt after something related arrives, and nothing may claim to know a picture it
// could not read.

import { describe, expect, it } from "bun:test";
import {
  mediaNoteRow,
  purgeExpiredMediaNotes,
  recordMediaAttempt,
  recordMediaNote,
  recordMediaSegment,
} from "../../src/server/db/qq-media-repository";
import { createSession, ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  checkQqMediaRetry,
  parseQqAnimatedFrameRequest,
  parseQqMediaKind,
  QQ_MEDIA_MAX_ATTEMPTS,
  qqMediaFailureOutcome,
  qqMediaModelFor,
  qqMediaReading,
} from "../../src/server/services/qq-media-contract";

const retry = (
  attempts: number,
  addressedToAssistant: boolean,
  relatedSupplementArrived: boolean,
  kind = "image",
) => checkQqMediaRetry({ kind, attempts, addressedToAssistant, relatedSupplementArrived });

describe("read attempts", () => {
  it("allows the first read whether or not the assistant was addressed", () => {
    expect(retry(0, false, false)).toEqual({ kind: "allowed", attempt: 1 });
    expect(retry(0, true, false)).toEqual({ kind: "allowed", attempt: 1 });
  });

  it("never retries a failure nobody asked about", () => {
    // §7.2: a non-@ failure is not answered and gets no observation retry scheduled. It
    // stays refused even if something related happens to arrive.
    expect(retry(1, false, false)).toEqual({ kind: "blocked", reason: "not_addressed" });
    expect(retry(1, false, true)).toEqual({ kind: "blocked", reason: "not_addressed" });
  });

  it("keeps an addressed failure waiting until something related arrives", () => {
    expect(retry(1, true, false)).toEqual({ kind: "blocked", reason: "awaiting_supplement" });
    expect(retry(1, true, true)).toEqual({ kind: "allowed", attempt: 2 });
  });

  it("stops after the second failure, even when addressed and supplemented", () => {
    // §7.2: the second failure ends the wait; there is no loop.
    expect(QQ_MEDIA_MAX_ATTEMPTS).toBe(2);
    expect(retry(2, true, true)).toEqual({ kind: "blocked", reason: "attempts_exhausted" });
    expect(retry(5, true, true)).toEqual({ kind: "blocked", reason: "attempts_exhausted" });
  });

  it("works for every media kind, since the rule is about the message not the format", () => {
    for (const kind of ["image", "record", "video", "file"]) {
      expect(retry(1, true, true, kind)).toEqual({ kind: "allowed", attempt: 2 });
    }
  });

  it("rejects input that does not match the contract", () => {
    expect(() => retry(-1, true, false)).toThrow(TypeError);
    expect(() => retry(0.5, true, false)).toThrow(TypeError);
    expect(() =>
      checkQqMediaRetry({
        kind: "sticker",
        attempts: 0,
        addressedToAssistant: true,
        relatedSupplementArrived: false,
      }),
    ).toThrow(TypeError);
    expect(() =>
      checkQqMediaRetry({ kind: "image", attempts: 0, addressedToAssistant: true }),
    ).toThrow(TypeError);
    expect(() =>
      checkQqMediaRetry({
        kind: "image",
        attempts: 0,
        addressedToAssistant: true,
        relatedSupplementArrived: false,
        extra: 1,
      }),
    ).toThrow(TypeError);
  });
});

describe("failure output", () => {
  it("never explains the failure in the conversation, only in the admin record", () => {
    const outcome = qqMediaFailureOutcome({
      kind: "image",
      attempts: 1,
      addressedToAssistant: false,
    });
    // Literal types, so a caller cannot decide to post an error message.
    expect(outcome.announceInConversation).toBe(false);
    expect(outcome.recordInAdminLog).toBe(true);
  });

  it("keeps waiting only when addressed and not yet exhausted", () => {
    expect(
      qqMediaFailureOutcome({ kind: "record", attempts: 1, addressedToAssistant: true }),
    ).toEqual({
      announceInConversation: false,
      recordInAdminLog: true,
      awaitSupplement: true,
      giveUp: false,
    });
    expect(
      qqMediaFailureOutcome({ kind: "record", attempts: 1, addressedToAssistant: false })
        .awaitSupplement,
    ).toBe(false);
  });

  it("gives up rather than waiting forever after the last attempt", () => {
    const outcome = qqMediaFailureOutcome({
      kind: "image",
      attempts: 2,
      addressedToAssistant: true,
    });
    expect(outcome.giveUp).toBe(true);
    expect(outcome.awaitSupplement).toBe(false);
  });

  it("rejects input that does not match the contract", () => {
    expect(() =>
      qqMediaFailureOutcome({ kind: "image", attempts: -1, addressedToAssistant: true }),
    ).toThrow(TypeError);
    expect(() => qqMediaFailureOutcome({ kind: "image", attempts: 1 })).toThrow(TypeError);
  });
});

describe("what may be used before a description exists", () => {
  it("uses the description once it exists", () => {
    expect(
      qqMediaReading({
        note: "一只橘猫坐在键盘上",
        caption: null,
        quotedText: null,
        topicText: null,
      }),
    ).toEqual({
      kind: "described",
      note: "一只橘猫坐在键盘上",
    });
  });

  it("falls back to caption, then quote, then topic", () => {
    expect(
      qqMediaReading({ note: null, caption: "看这个", quotedText: "引用", topicText: "话题" }),
    ).toEqual({
      kind: "unread",
      usableText: "看这个",
      knowsVisualContent: false,
    });
    expect(
      qqMediaReading({ note: null, caption: null, quotedText: "引用", topicText: "话题" }).kind,
    ).toBe("unread");
    const quoted = qqMediaReading({
      note: null,
      caption: null,
      quotedText: "引用",
      topicText: "话题",
    });
    expect(quoted.kind === "unread" ? quoted.usableText : null).toBe("引用");
  });

  it("never claims to know the picture when there is no description", () => {
    const reading = qqMediaReading({
      note: null,
      caption: null,
      quotedText: null,
      topicText: null,
    });
    expect(reading).toEqual({ kind: "unread", usableText: null, knowsVisualContent: false });
  });

  it("treats a blank description as no description", () => {
    expect(
      qqMediaReading({ note: "   ", caption: "配文", quotedText: null, topicText: null }),
    ).toEqual({
      kind: "unread",
      usableText: "配文",
      knowsVisualContent: false,
    });
  });

  it("rejects input that does not match the contract", () => {
    expect(() => qqMediaReading({ note: null, caption: null, quotedText: null })).toThrow(
      TypeError,
    );
    expect(() =>
      qqMediaReading({ note: 5, caption: null, quotedText: null, topicText: null }),
    ).toThrow(TypeError);
  });
});

describe("animation sampling", () => {
  it("accepts a fully specified request", () => {
    expect(
      parseQqAnimatedFrameRequest({ frames: 4, maxDimension: 768, budgetTokens: 2048 }),
    ).toEqual({
      frames: 4,
      maxDimension: 768,
      budgetTokens: 2048,
    });
  });

  it("refuses to fill in any of the pending numbers by itself", () => {
    // §7.1 makes frames / size / budget adjustable; none has an agreed value, so a missing
    // field is an error rather than a silent default.
    expect(() => parseQqAnimatedFrameRequest({ frames: 4, maxDimension: 768 })).toThrow(TypeError);
    expect(() =>
      parseQqAnimatedFrameRequest({ frames: 0, maxDimension: 768, budgetTokens: 1 }),
    ).toThrow(TypeError);
    expect(() =>
      parseQqAnimatedFrameRequest({ frames: 2.5, maxDimension: 768, budgetTokens: 1 }),
    ).toThrow(TypeError);
    expect(() => parseQqAnimatedFrameRequest({})).toThrow(TypeError);
  });
});

describe("which model reads what", () => {
  const configured = { visionModelName: "local-llava", transcriptionModelName: "whisper" };

  it("picks the vision model for pictures and frames, the transcriber for voice", () => {
    expect(qqMediaModelFor("image", configured)).toEqual({
      kind: "configured",
      model: "local-llava",
    });
    expect(qqMediaModelFor("video", configured)).toEqual({
      kind: "configured",
      model: "local-llava",
    });
    expect(qqMediaModelFor("record", configured)).toEqual({ kind: "configured", model: "whisper" });
  });

  it("never reads a document, since the input capability is pictures, animations and voice", () => {
    expect(qqMediaModelFor("file", configured)).toEqual({ kind: "not_configured" });
  });

  it("treats an unset or blank model as unreadable instead of falling back", () => {
    // Falling back to the conversation model would have a text-only model invent a picture.
    expect(
      qqMediaModelFor("image", { visionModelName: null, transcriptionModelName: "whisper" }),
    ).toEqual({ kind: "not_configured" });
    expect(
      qqMediaModelFor("image", { visionModelName: "   ", transcriptionModelName: null }),
    ).toEqual({ kind: "not_configured" });
    expect(
      qqMediaModelFor("record", { visionModelName: "local-llava", transcriptionModelName: null }),
    ).toEqual({ kind: "not_configured" });
  });

  it("never uses the other purpose's model, and trims the one it does use", () => {
    expect(
      qqMediaModelFor("record", {
        visionModelName: "local-llava",
        transcriptionModelName: " whisper ",
      }),
    ).toEqual({ kind: "configured", model: "whisper" });
  });

  it("rejects input that does not match the contract", () => {
    expect(() => qqMediaModelFor("sticker", configured)).toThrow(TypeError);
    expect(() => qqMediaModelFor("image", { visionModelName: null })).toThrow(TypeError);
    expect(parseQqMediaKind("video")).toBe("video");
    expect(() => parseQqMediaKind(3)).toThrow(TypeError);
  });
});

describe("attachment storage", () => {
  const MODEL = "qwen/qwen3-4b-2507";
  const AGENT_ID = "00000000-0000-0000-0000-000000000001";

  function setup() {
    const business = openBusinessDb();
    ensureDefaults(business.orm, MODEL);
    createSession(business.orm, "会话", { modelName: MODEL });
    return { business, orm: business.orm, db: business.db };
  }

  function insertEvent(orm: Orm, eventKey: string, occurredAtSeconds = 1_000) {
    orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: "10001",
        conversationKind: "group",
        peerId: "20001",
        agentId: AGENT_ID,
        messageId: eventKey,
        occurredAtSeconds,
        speakerKind: "member",
        speakerId: "30001",
        recordedAt: nowIso(),
      })
      .run();
  }

  function addSegment(
    orm: Orm,
    eventKey: string,
    segmentIndex = 0,
    sourceRef = "a.jpg",
    occurredAtSeconds = Math.floor(Date.now() / 1000),
  ) {
    return recordMediaSegment(orm, {
      eventKey,
      segmentIndex,
      kind: "image",
      sourceRef,
      occurredAtSeconds,
      addressed: true,
    });
  }

  it("records a segment once, however often the message is re-delivered", () => {
    const h = setup();
    try {
      insertEvent(h.orm, "e1");
      const first = addSegment(h.orm, "e1");
      const again = addSegment(h.orm, "e1");
      expect(again.id).toBe(first.id);
      expect(h.orm.select().from(schema.qqMediaNotes).all()).toHaveLength(1);
      // Nothing has been read yet, so there is no note and no attempt.
      expect(first.note).toBeNull();
      expect(first.attempts).toBe(0);
    } finally {
      h.business.close();
    }
  });

  it("refuses to re-describe one position as a different thing", () => {
    const h = setup();
    try {
      insertEvent(h.orm, "e1");
      addSegment(h.orm, "e1");
      expect(() =>
        recordMediaSegment(h.orm, {
          eventKey: "e1",
          segmentIndex: 0,
          kind: "record",
          sourceRef: "a.jpg",
          occurredAtSeconds: 1_000,
          addressed: true,
        }),
      ).toThrow();
      expect(() => addSegment(h.orm, "e1", 0, "b.jpg")).toThrow();
      expect(() => addSegment(h.orm, "e1", 0, "   ")).toThrow(TypeError);
    } finally {
      h.business.close();
    }
  });

  it("keeps several segments of one message apart", () => {
    const h = setup();
    try {
      insertEvent(h.orm, "e1");
      addSegment(h.orm, "e1", 0, "a.jpg");
      addSegment(h.orm, "e1", 1, "b.jpg");
      expect(mediaNoteRow(h.orm, "e1", 0)?.sourceRef).toBe("a.jpg");
      expect(mediaNoteRow(h.orm, "e1", 1)?.sourceRef).toBe("b.jpg");
      expect(mediaNoteRow(h.orm, "e1", 2)).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("stores a note with the model that produced it, and refuses an unattributed one", () => {
    const h = setup();
    try {
      insertEvent(h.orm, "e1");
      addSegment(h.orm, "e1");
      const noted = recordMediaNote(h.orm, {
        eventKey: "e1",
        segmentIndex: 0,
        note: "一只橘猫坐在键盘上",
        noteModel: "local-llava",
      });
      expect(noted.note).toBe("一只橘猫坐在键盘上");
      expect(noted.noteModel).toBe("local-llava");
      expect(() =>
        recordMediaNote(h.orm, {
          eventKey: "e1",
          segmentIndex: 0,
          note: " ",
          noteModel: "local-llava",
        }),
      ).toThrow(TypeError);
      expect(() =>
        recordMediaNote(h.orm, {
          eventKey: "e1",
          segmentIndex: 1,
          note: "无此位置",
          noteModel: "m",
        }),
      ).toThrow();
      // The table refuses a description without a model. Clearing the model in the same
      // statement is what actually tests the CHECK: it is about the resulting row, not about
      // which column the statement mentions.
      expect(() =>
        h.db.run("UPDATE qq_media_notes SET note = '无来源描述', note_model = NULL"),
      ).toThrow();
    } finally {
      h.business.close();
    }
  });

  it("refuses an invalid authorization callback without writing a note", () => {
    const h = setup();
    try {
      insertEvent(h.orm, "e1");
      addSegment(h.orm, "e1");
      recordMediaAttempt(h.orm, { eventKey: "e1", segmentIndex: 0 });
      expect(() =>
        recordMediaNote(h.orm, {
          eventKey: "e1",
          segmentIndex: 0,
          note: "橘猫",
          noteModel: "vision",
          expectedAttempts: 1,
          validateBeforeWrite: () => false,
        }),
      ).toThrow();
      expect(mediaNoteRow(h.orm, "e1", 0)?.note).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("does not spend a media attempt after authorization changes during claiming", () => {
    const h = setup();
    try {
      insertEvent(h.orm, "e1", Math.floor(Date.now() / 1000));
      recordMediaSegment(h.orm, {
        eventKey: "e1",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "a.jpg",
        occurredAtSeconds: Math.floor(Date.now() / 1000),
        addressed: true,
      });
      expect(() =>
        recordMediaAttempt(h.orm, {
          eventKey: "e1",
          segmentIndex: 0,
          expectedAttempts: 0,
          validateBeforeClaim: () => false,
        }),
      ).toThrow();
      expect(mediaNoteRow(h.orm, "e1", 0)?.attempts).toBe(0);
    } finally {
      h.business.close();
    }
  });

  it("rejects a stale retry baseline rather than silently spending the second attempt", () => {
    const h = setup();
    try {
      insertEvent(h.orm, "e1", Math.floor(Date.now() / 1000));
      recordMediaSegment(h.orm, {
        eventKey: "e1",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "a.jpg",
        occurredAtSeconds: Math.floor(Date.now() / 1000),
        addressed: true,
      });
      expect(
        recordMediaAttempt(h.orm, { eventKey: "e1", segmentIndex: 0, expectedAttempts: 0 })
          .attempts,
      ).toBe(1);
      expect(() =>
        recordMediaAttempt(h.orm, { eventKey: "e1", segmentIndex: 0, expectedAttempts: 0 }),
      ).toThrow();
      expect(mediaNoteRow(h.orm, "e1", 0)?.attempts).toBe(1);
    } finally {
      h.business.close();
    }
  });

  it("refuses to claim an expired reference even if it has never been read", () => {
    const h = setup();
    try {
      insertEvent(h.orm, "e1");
      addSegment(h.orm, "e1", 0, "a.jpg", 1_000);
      expect(() => recordMediaAttempt(h.orm, { eventKey: "e1", segmentIndex: 0 })).toThrow();
      expect(mediaNoteRow(h.orm, "e1", 0)?.attempts).toBe(0);
    } finally {
      h.business.close();
    }
  });

  it("claims successive attempts with an atomic conditional database update", () => {
    const h = setup();
    try {
      insertEvent(h.orm, "e1");
      addSegment(h.orm, "e1");
      const a = recordMediaAttempt(h.orm, { eventKey: "e1", segmentIndex: 0 });
      const b = recordMediaAttempt(h.orm, { eventKey: "e1", segmentIndex: 0 });
      expect([a.attempts, b.attempts]).toEqual([1, 2]);
      expect(() => recordMediaAttempt(h.orm, { eventKey: "e1", segmentIndex: 0 })).toThrow();
    } finally {
      h.business.close();
    }
  });

  it("does not claim another read after a description is already saved", () => {
    const h = setup();
    try {
      insertEvent(h.orm, "e1");
      addSegment(h.orm, "e1");
      recordMediaAttempt(h.orm, { eventKey: "e1", segmentIndex: 0 });
      recordMediaNote(h.orm, {
        eventKey: "e1",
        segmentIndex: 0,
        note: "一张图",
        noteModel: "vision",
      });
      expect(() => recordMediaAttempt(h.orm, { eventKey: "e1", segmentIndex: 0 })).toThrow();
      expect(mediaNoteRow(h.orm, "e1", 0)?.attempts).toBe(1);
    } finally {
      h.business.close();
    }
  });

  it("counts attempts up to the plan's limit and refuses a third", () => {
    const h = setup();
    try {
      insertEvent(h.orm, "e1");
      addSegment(h.orm, "e1");
      expect(recordMediaAttempt(h.orm, { eventKey: "e1", segmentIndex: 0 }).attempts).toBe(1);
      expect(recordMediaAttempt(h.orm, { eventKey: "e1", segmentIndex: 0 }).attempts).toBe(2);
      // §7.2 allows exactly two reads; the table makes a third impossible rather than
      // letting a loop start quietly.
      expect(() => recordMediaAttempt(h.orm, { eventKey: "e1", segmentIndex: 0 })).toThrow();
      expect(mediaNoteRow(h.orm, "e1", 0)?.attempts).toBe(2);
      expect(() => recordMediaAttempt(h.orm, { eventKey: "e1", segmentIndex: 5 })).toThrow();
    } finally {
      h.business.close();
    }
  });

  it("sweeps expired attachments on the message's own window", () => {
    const h = setup();
    try {
      insertEvent(h.orm, "old", 1_000);
      addSegment(h.orm, "old", 0, "a.jpg", 1_000);
      const now = Math.floor(Date.parse(nowIso()) / 1000);
      insertEvent(h.orm, "fresh", now);
      recordMediaSegment(h.orm, {
        eventKey: "fresh",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "b.jpg",
        occurredAtSeconds: now,
        addressed: true,
      });
      expect(purgeExpiredMediaNotes(h.orm)).toBe(1);
      expect(mediaNoteRow(h.orm, "old", 0)).toBeNull();
      expect(mediaNoteRow(h.orm, "fresh", 0)).not.toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("goes away with the message identity it hangs off", () => {
    const h = setup();
    try {
      insertEvent(h.orm, "e1");
      addSegment(h.orm, "e1");
      h.db.run("DELETE FROM qq_events WHERE event_key = 'e1'");
      expect(mediaNoteRow(h.orm, "e1", 0)).toBeNull();
    } finally {
      h.business.close();
    }
  });
});
