// P3b-1: the time gates the user's numbers drive (ADR0018).
//
// §5.2 listed the field groups but left every value pending, so these rules could not be
// built: "how quiet is quiet" and "how soon is too soon" are their entire content. The
// values were fixed on 2026-09-23 and now act here.
//
// The decision this suite protects most is a scope one, not a number: the four time gates
// bind unprompted speech only. A direct reply must be answerable at any hour and however
// recently the assistant last spoke — being addressed is the one case where an answer is
// unambiguously expected, and a cooldown that swallowed it would look like a bug to
// everyone except the person who set the number. Two tests below fail if anyone widens the
// gates to cover it.

import { describe, expect, it } from "bun:test";
import type { QqConversationScope } from "../../src/server/db/qq-observation-repository";
import { createQqScheme, schemeRhythm } from "../../src/server/db/qq-scheme-repository";
import {
  qqInitiativeSpeechesInWindow,
  recordQqSpeech,
} from "../../src/server/db/qq-speech-repository";
import { createSession, ensureDefaults, type Orm } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  checkQqInitiativeRhythm,
  parseQqSchemeRhythm,
  QQ_RHYTHM_DEFAULT,
  QQ_RHYTHM_HOUR_SECONDS,
  qqActiveHoursAllow,
  qqBatchVerdict,
  qqRecomputeVerdict,
  qqRhythmAppliesTo,
  qqStickerCount,
} from "../../src/server/services/qq-rhythm-contract";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  createSession(business.orm, "会话", { modelName: MODEL });
  return { business, orm: business.orm, db: business.db };
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

/** The gate input for a conversation, with the rhythm group supplied by the caller. */
function rhythmFor(
  overrides: Partial<{
    kind: string;
    rhythm: typeof QQ_RHYTHM_DEFAULT;
    nowSeconds: number;
    lastSpeechSeconds: number | null;
    speechesThisHour: number;
    newestMemberMessageSeconds: number | null;
  }> = {},
) {
  const nowSeconds = overrides.nowSeconds ?? 100_000;
  return {
    kind: overrides.kind ?? "idle_topic",
    rhythm: overrides.rhythm ?? QQ_RHYTHM_DEFAULT,
    nowSeconds,
    lastSpeechSeconds: overrides.lastSpeechSeconds ?? null,
    speechesThisHour: overrides.speechesThisHour ?? 0,
    // A day of silence by default, clamped at zero: a test that places "now" early in a
    // timeline must not produce a negative timestamp, which the contract refuses.
    newestMemberMessageSeconds:
      overrides.newestMemberMessageSeconds === undefined
        ? Math.max(0, nowSeconds - 24 * 60 * 60)
        : overrides.newestMemberMessageSeconds,
  };
}

describe("the decided defaults", () => {
  it("is exactly the table the user fixed", () => {
    expect(QQ_RHYTHM_DEFAULT).toEqual({
      merge_window_seconds: 30,
      reply_cooldown_seconds: 10,
      hourly_speech_limit: 200,
      // 0034 (user decision 2026-09-25): the interest score the judge must reach.
      initiative_min_score: 6,
      // 0036: 每 X 条群友消息才真跑一次判断（间隔内复用上次读数）。
      judgement_interval_turns: 3,
      idle_quiet_minutes: 15,
      active_hours_enabled: false,
      active_hours_start_minutes: 0,
      active_hours_end_minutes: 1439,
      max_recompute_count: 1,
      max_sticker_count: 1,
      media_supplement_window_minutes: 10,
      media_frame_count: 3,
      media_max_dimension: 512,
    });
    expect(QQ_RHYTHM_HOUR_SECONDS).toBe(3600);
  });

  it("refuses a stored group outside the decided ranges", () => {
    expect(() => parseQqSchemeRhythm({ ...QQ_RHYTHM_DEFAULT, merge_window_seconds: 301 })).toThrow(
      TypeError,
    );
    expect(() => parseQqSchemeRhythm({ ...QQ_RHYTHM_DEFAULT, hourly_speech_limit: 0 })).toThrow(
      TypeError,
    );
    expect(() => parseQqSchemeRhythm({ ...QQ_RHYTHM_DEFAULT, max_sticker_count: 4 })).toThrow(
      TypeError,
    );
    expect(() =>
      parseQqSchemeRhythm({ ...QQ_RHYTHM_DEFAULT, active_hours_start_minutes: 1440 }),
    ).toThrow(TypeError);
    expect(() => parseQqSchemeRhythm({ ...QQ_RHYTHM_DEFAULT, extra: 1 })).toThrow(TypeError);
  });

  it("names the paths the time gates apply to", () => {
    expect(qqRhythmAppliesTo("chiming_in")).toBe(true);
    expect(qqRhythmAppliesTo("idle_topic")).toBe(true);
    expect(qqRhythmAppliesTo("direct_reply")).toBe(false);
    expect(qqRhythmAppliesTo("follow_up")).toBe(false);
  });
});

describe("the merge window", () => {
  it("waits out the window, then judges", () => {
    const input = { lastMessageSeconds: 1_000, mergeWindowSeconds: 30 };
    expect(qqBatchVerdict({ ...input, nowSeconds: 1_029 })).toEqual({
      kind: "waiting",
      readyAtSeconds: 1_030,
    });
    // The boundary is inclusive: at readyAt the batch is ready, not one second later.
    expect(qqBatchVerdict({ ...input, nowSeconds: 1_030 })).toEqual({ kind: "ready" });
    expect(qqBatchVerdict({ ...input, nowSeconds: 1_500 })).toEqual({ kind: "ready" });
  });

  it("restarts with every new message, which is what makes it a merge", () => {
    const first = qqBatchVerdict({
      lastMessageSeconds: 1_000,
      nowSeconds: 1_029,
      mergeWindowSeconds: 30,
    });
    const second = qqBatchVerdict({
      lastMessageSeconds: 1_020,
      nowSeconds: 1_029,
      mergeWindowSeconds: 30,
    });
    expect(first).toEqual({ kind: "waiting", readyAtSeconds: 1_030 });
    expect(second).toEqual({ kind: "waiting", readyAtSeconds: 1_050 });
  });

  it("judges each message at once when the window is zero", () => {
    expect(
      qqBatchVerdict({ lastMessageSeconds: 1_000, nowSeconds: 1_000, mergeWindowSeconds: 0 }),
    ).toEqual({ kind: "ready" });
    expect(() =>
      qqBatchVerdict({ lastMessageSeconds: -1, nowSeconds: 0, mergeWindowSeconds: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      qqBatchVerdict({ lastMessageSeconds: 1.5, nowSeconds: 2, mergeWindowSeconds: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      qqBatchVerdict({ lastMessageSeconds: 0, nowSeconds: 10, mergeWindowSeconds: 301 }),
    ).toThrow(TypeError);
  });
});

describe("allowed hours", () => {
  it("does not limit anything while it is switched off", () => {
    expect(
      qqActiveHoursAllow({ minuteOfDay: 180, enabled: false, startMinutes: 540, endMinutes: 1380 }),
    ).toBe(true);
  });

  it("is half-open, so a window never counts its last minute twice", () => {
    const window = { enabled: true, startMinutes: 540, endMinutes: 1380 };
    expect(qqActiveHoursAllow({ ...window, minuteOfDay: 539 })).toBe(false);
    expect(qqActiveHoursAllow({ ...window, minuteOfDay: 540 })).toBe(true);
    expect(qqActiveHoursAllow({ ...window, minuteOfDay: 1379 })).toBe(true);
    expect(qqActiveHoursAllow({ ...window, minuteOfDay: 1380 })).toBe(false);
  });

  it("reads a window that crosses midnight as two spans, not an empty one", () => {
    const window = { enabled: true, startMinutes: 22 * 60, endMinutes: 7 * 60 };
    expect(qqActiveHoursAllow({ ...window, minuteOfDay: 23 * 60 })).toBe(true);
    expect(qqActiveHoursAllow({ ...window, minuteOfDay: 2 * 60 })).toBe(true);
    expect(qqActiveHoursAllow({ ...window, minuteOfDay: 12 * 60 })).toBe(false);
  });

  it("treats start equal to end as all day rather than as never", () => {
    // Half-open semantics would make this an empty window, i.e. "never speak" — not what
    // anyone means by typing the same number twice.
    expect(
      qqActiveHoursAllow({ minuteOfDay: 0, enabled: true, startMinutes: 60, endMinutes: 60 }),
    ).toBe(true);
    expect(
      qqActiveHoursAllow({ minuteOfDay: 1439, enabled: true, startMinutes: 60, endMinutes: 60 }),
    ).toBe(true);
  });
});

describe("the initiative gates", () => {
  it("leaves direct replies and continuations alone, whatever the clocks say", () => {
    // Both answers to "should this go out" must be the same: an assistant that goes quiet
    // because it spoke a moment ago, or because it is late, looks broken when addressed.
    const blocked = rhythmFor({
      kind: "direct_reply",
      nowSeconds: 100_000,
      lastSpeechSeconds: 99_999,
      speechesThisHour: QQ_RHYTHM_DEFAULT.hourly_speech_limit,
      rhythm: {
        ...QQ_RHYTHM_DEFAULT,
        active_hours_enabled: true,
        active_hours_start_minutes: 540,
        active_hours_end_minutes: 1380,
      },
      newestMemberMessageSeconds: 100_000,
    });
    expect(checkQqInitiativeRhythm(blocked)).toEqual({ kind: "allowed" });
    expect(checkQqInitiativeRhythm({ ...blocked, kind: "follow_up" })).toEqual({ kind: "allowed" });
  });

  it("holds an unprompted utterance back until the cooldown expires", () => {
    const base = { kind: "chiming_in", lastSpeechSeconds: 100_000 } as const;
    expect(checkQqInitiativeRhythm(rhythmFor({ ...base, nowSeconds: 100_009 }))).toEqual({
      kind: "blocked",
      reason: "cooling_down",
      readyAtSeconds: 100_010,
    });
    expect(checkQqInitiativeRhythm(rhythmFor({ ...base, nowSeconds: 100_010 }))).toEqual({
      kind: "allowed",
    });
  });

  it("stops unprompted speech at the hourly cap", () => {
    const limit = QQ_RHYTHM_DEFAULT.hourly_speech_limit;
    expect(
      checkQqInitiativeRhythm(rhythmFor({ kind: "chiming_in", speechesThisHour: limit - 1 })),
    ).toEqual({ kind: "allowed" });
    // The cap lifts by the oldest utterance ageing out, which this module cannot see, so it
    // promises no ready time.
    expect(
      checkQqInitiativeRhythm(rhythmFor({ kind: "chiming_in", speechesThisHour: limit })),
    ).toEqual({ kind: "blocked", reason: "hourly_limit", readyAtSeconds: null });
  });

  it("keeps unprompted speech inside the allowed hours when they are switched on", () => {
    const rhythm = {
      ...QQ_RHYTHM_DEFAULT,
      active_hours_enabled: true,
      active_hours_start_minutes: 9 * 60,
      active_hours_end_minutes: 23 * 60,
    };
    // 03:00 local: 3 * 60 = 180 minutes since midnight.
    expect(
      checkQqInitiativeRhythm(rhythmFor({ kind: "chiming_in", rhythm, nowSeconds: 180 * 60 })),
    ).toEqual({ kind: "blocked", reason: "outside_active_hours", readyAtSeconds: null });
    expect(
      checkQqInitiativeRhythm(rhythmFor({ kind: "chiming_in", rhythm, nowSeconds: 600 * 60 })),
    ).toEqual({ kind: "allowed" });
  });

  it("makes an opener wait for the conversation to actually go quiet", () => {
    const base = { kind: "idle_topic", nowSeconds: 100_000 } as const;
    // 15 minutes of quiet by default: 14 minutes in is too soon.
    expect(
      checkQqInitiativeRhythm(
        rhythmFor({ ...base, newestMemberMessageSeconds: 100_000 - 14 * 60 }),
      ),
    ).toEqual({ kind: "blocked", reason: "not_quiet_yet", readyAtSeconds: 100_000 + 60 });
    expect(
      checkQqInitiativeRhythm(
        rhythmFor({ ...base, newestMemberMessageSeconds: 100_000 - 15 * 60 }),
      ),
    ).toEqual({ kind: "allowed" });
    // Chiming in is exactly the opposite situation: people are talking.
    expect(
      checkQqInitiativeRhythm(
        rhythmFor({ kind: "chiming_in", nowSeconds: 100_000, newestMemberMessageSeconds: 99_999 }),
      ),
    ).toEqual({ kind: "allowed" });
  });

  it("does not invent quiet for a conversation that has never spoken", () => {
    expect(
      checkQqInitiativeRhythm(
        rhythmFor({ kind: "idle_topic", newestMemberMessageSeconds: null, nowSeconds: 100_000 }),
      ),
    ).toEqual({ kind: "allowed" });
  });

  it("reports the nearest reason first, so the message the user sees is actionable", () => {
    const rhythm = {
      ...QQ_RHYTHM_DEFAULT,
      active_hours_enabled: true,
      active_hours_start_minutes: 9 * 60,
      active_hours_end_minutes: 23 * 60,
    };
    // Cooling down AND outside hours: the cooldown is the one that expires on its own clock.
    expect(
      checkQqInitiativeRhythm(
        rhythmFor({
          kind: "chiming_in",
          rhythm,
          nowSeconds: 180 * 60,
          lastSpeechSeconds: 180 * 60 - 2,
        }),
      ),
    ).toEqual({ kind: "blocked", reason: "cooling_down", readyAtSeconds: 180 * 60 + 8 });
  });

  it("refuses malformed gate input instead of defaulting it", () => {
    expect(() => checkQqInitiativeRhythm({ ...rhythmFor(), kind: "shout" })).toThrow(TypeError);
    expect(() => checkQqInitiativeRhythm({ ...rhythmFor(), nowSeconds: -1 })).toThrow(TypeError);
    expect(() => checkQqInitiativeRhythm({ ...rhythmFor(), speechesThisHour: -1 })).toThrow(
      TypeError,
    );
    expect(() => checkQqInitiativeRhythm({ ...rhythmFor(), extra: true })).toThrow(TypeError);
  });
});

describe("the two counts", () => {
  it("trims stickers to the scheme's ceiling without refusing the reply", () => {
    expect(qqStickerCount({ requested: 5, maxStickerCount: 3 })).toBe(3);
    expect(qqStickerCount({ requested: 1, maxStickerCount: 3 })).toBe(1);
    expect(qqStickerCount({ requested: 0, maxStickerCount: 3 })).toBe(0);
    expect(() => qqStickerCount({ requested: -1, maxStickerCount: 3 })).toThrow(TypeError);
    expect(() => qqStickerCount({ requested: 1, maxStickerCount: 0 })).toThrow(TypeError);
  });

  it("allows exactly the recomputes §5.1 budgeted", () => {
    expect(qqRecomputeVerdict({ used: 0, maxRecomputeCount: 1 })).toEqual({ kind: "allowed" });
    expect(qqRecomputeVerdict({ used: 1, maxRecomputeCount: 1 })).toEqual({
      kind: "blocked",
      reason: "recompute_budget",
    });
    expect(qqRecomputeVerdict({ used: 0, maxRecomputeCount: 0 })).toEqual({
      kind: "blocked",
      reason: "recompute_budget",
    });
    expect(() => qqRecomputeVerdict({ used: 1.5, maxRecomputeCount: 1 })).toThrow(TypeError);
  });
});

describe("counting what was already said", () => {
  function say(orm: Orm, kind: string, atSeconds: number, target: QqConversationScope = scope()) {
    recordQqSpeech(orm, {
      scope: target,
      kind: kind as never,
      spokeAtSeconds: atSeconds,
    });
  }

  it("counts only this conversation's delivered initiatives inside the window", () => {
    const h = setup();
    try {
      const now = 200_000;
      say(h.orm, "chiming_in", now - 10);
      say(h.orm, "idle_topic", now - 20);
      // Answering and continuing are not unprompted, so they do not spend the cap.
      say(h.orm, "direct_reply", now - 30);
      say(h.orm, "follow_up", now - 40);
      // Outside the window.
      say(h.orm, "chiming_in", now - QQ_RHYTHM_HOUR_SECONDS - 1);
      // Another conversation is another budget.
      say(h.orm, "chiming_in", now - 5, scope({ peerId: "29999" }));
      expect(qqInitiativeSpeechesInWindow(h.orm, scope(), { nowSeconds: now })).toBe(2);
      expect(
        qqInitiativeSpeechesInWindow(h.orm, scope(), { nowSeconds: now, windowSeconds: 15 }),
      ).toBe(1);
    } finally {
      h.business.close();
    }
  });

  it("refuses a malformed count instead of counting something else", () => {
    const h = setup();
    try {
      expect(() => qqInitiativeSpeechesInWindow(h.orm, scope(), { nowSeconds: -1 })).toThrow(
        TypeError,
      );
      expect(() =>
        qqInitiativeSpeechesInWindow(h.orm, scope(), { nowSeconds: 10, windowSeconds: 0 }),
      ).toThrow(TypeError);
    } finally {
      h.business.close();
    }
  });

  it("walks a scheme's numbers all the way to a verdict", () => {
    const h = setup();
    try {
      const scheme = createQqScheme(h.orm, { name: "安静方案" });
      const rhythm = schemeRhythm(scheme);
      const now = 300_000;
      // Delivered a moment ago in this conversation.
      say(h.orm, "chiming_in", now - 2);
      const verdict = checkQqInitiativeRhythm({
        kind: "chiming_in",
        rhythm,
        nowSeconds: now,
        lastSpeechSeconds: now - 2,
        speechesThisHour: qqInitiativeSpeechesInWindow(h.orm, scope(), { nowSeconds: now }),
        newestMemberMessageSeconds: now - 3,
      });
      expect(verdict).toEqual({
        kind: "blocked",
        reason: "cooling_down",
        readyAtSeconds: now - 2 + rhythm.reply_cooldown_seconds,
      });
      // The same instant, addressed directly: allowed.
      expect(
        checkQqInitiativeRhythm({
          kind: "direct_reply",
          rhythm,
          nowSeconds: now,
          lastSpeechSeconds: now - 2,
          speechesThisHour: 0,
          newestMemberMessageSeconds: now - 3,
        }),
      ).toEqual({ kind: "allowed" });
    } finally {
      h.business.close();
    }
  });
});

describe("the store's side of the contract", () => {
  it("accepts a stored scheme's rhythm and rejects a corrupted one", () => {
    const h = setup();
    try {
      const scheme = createQqScheme(h.orm, { name: "方案" });
      expect(schemeRhythm(scheme)).toEqual(QQ_RHYTHM_DEFAULT);
      // Writing past the range straight to the database is refused by the CHECK, which is
      // what keeps schemeRhythm from ever seeing such a row.
      expect(() =>
        h.db.run("UPDATE qq_schemes SET merge_window_seconds = 301 WHERE id = ?", [scheme.id]),
      ).toThrow();
      expect(() =>
        h.db.run("UPDATE qq_schemes SET max_sticker_count = 0 WHERE id = ?", [scheme.id]),
      ).toThrow();
      expect(() =>
        h.db.run("UPDATE qq_schemes SET active_hours_enabled = 2 WHERE id = ?", [scheme.id]),
      ).toThrow();
      // P5m's supplement window: 0 is legal (do not wait), a day is the ceiling.
      h.db.run("UPDATE qq_schemes SET media_supplement_window_minutes = 0 WHERE id = ?", [
        scheme.id,
      ]);
      expect(() =>
        h.db.run("UPDATE qq_schemes SET media_supplement_window_minutes = 1441 WHERE id = ?", [
          scheme.id,
        ]),
      ).toThrow();
    } finally {
      h.business.close();
    }
  });
});
