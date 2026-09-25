// P3b-2: what the judgement and the reply each get to see (ADR0018).
//
// §6.1 requires the two to be configured separately, and forbids the failure mode this
// module exists to prevent: stuffing the whole group history into every judgement. The user
// fixed both tiers on 2026-09-23 and also asked for the assistant's own words to be kept,
// which is why this suite checks both halves — the selection rules, and the fact that the
// assistant can finally see its own last line.
//
// Two properties are structural rather than documented, and are asserted as such: a `system`
// notice cannot even be constructed into a timeline, and unread media is carried as a count
// so no later stage can quietly treat "a picture arrived" as "we know what it showed".

import { describe, expect, it } from "bun:test";
import { recordMediaNote, recordMediaSegment } from "../../src/server/db/qq-media-repository";
import type { QqConversationScope } from "../../src/server/db/qq-observation-repository";
import {
  conversationMessagesSince,
  storeObservationText,
} from "../../src/server/db/qq-observation-repository";
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import {
  ownSpeechSince,
  purgeExpiredQqSpeech,
  recordQqSpeech,
} from "../../src/server/db/qq-speech-repository";
import { createSession, ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  parseQqSchemeContext,
  QQ_CONTEXT_DEFAULT,
  QQ_CONTEXT_MESSAGE_OVERHEAD,
  qqBuildTimeline,
  qqContextLimits,
  qqSelectContext,
} from "../../src/server/services/qq-context-contract";
import { estimateTokens } from "../../src/server/services/token-estimate";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  createSession(business.orm, "会话", { modelName: MODEL });
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

/** One recorded group message: identity plus body, as the intake would write it. */
function say(
  orm: Orm,
  eventKey: string,
  atSeconds: number,
  body: string | null,
  options: { speakerKind?: "member" | "anonymous" | "system"; target?: QqConversationScope } = {},
) {
  const target = options.target ?? scope();
  const speakerKind = options.speakerKind ?? "member";
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey,
      accountId: target.accountId,
      conversationKind: target.conversationKind,
      peerId: target.peerId,
      agentId: target.agentId,
      messageId: eventKey,
      occurredAtSeconds: atSeconds,
      speakerKind,
      speakerId: speakerKind === "member" ? "30001" : null,
      recordedAt: nowIso(),
    })
    .run();
  if (body !== null) storeObservationText(orm, { eventKey, body, occurredAtSeconds: atSeconds });
}

function message(
  occurredAtSeconds: number,
  text: string | null,
  extra: Record<string, unknown> = {},
) {
  return {
    occurredAtSeconds,
    speaker: "member",
    speakerId: "30001",
    text,
    mediaNotes: [],
    mediaUnread: 0,
    ...extra,
  };
}

const MINUTE = 60;

describe("the decided context budgets", () => {
  it("is exactly the table the user fixed", () => {
    expect(QQ_CONTEXT_DEFAULT).toEqual({
      judgement_message_limit: 20,
      judgement_window_minutes: 60,
      judgement_token_budget: 2000,
      reply_message_limit: 60,
      reply_window_minutes: 360,
      reply_token_budget: 6000,
    });
  });

  it("hands each tier its own three knobs", () => {
    expect(qqContextLimits(QQ_CONTEXT_DEFAULT, "judgement")).toEqual({
      messageLimit: 20,
      windowMinutes: 60,
      tokenBudget: 2000,
    });
    expect(qqContextLimits(QQ_CONTEXT_DEFAULT, "reply")).toEqual({
      messageLimit: 60,
      windowMinutes: 360,
      tokenBudget: 6000,
    });
    expect(() => qqContextLimits(QQ_CONTEXT_DEFAULT, "summary" as never)).toThrow(TypeError);
  });

  it("refuses a stored group outside the decided ranges", () => {
    expect(() =>
      parseQqSchemeContext({ ...QQ_CONTEXT_DEFAULT, judgement_message_limit: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      parseQqSchemeContext({ ...QQ_CONTEXT_DEFAULT, reply_window_minutes: 20161 }),
    ).toThrow(TypeError);
    expect(() => parseQqSchemeContext({ ...QQ_CONTEXT_DEFAULT, reply_token_budget: 255 })).toThrow(
      TypeError,
    );
    expect(() => parseQqSchemeContext({ ...QQ_CONTEXT_DEFAULT, extra: 1 })).toThrow(TypeError);
  });
});

describe("building the timeline", () => {
  it("puts the assistant's own words in their place in time", () => {
    const timeline = qqBuildTimeline({
      messages: [message(300, "第二个"), message(100, "第一个")],
      ownSpeech: [{ occurredAtSeconds: 200, text: "我先说了一句" }],
    });
    expect(timeline.map((entry) => [entry.occurredAtSeconds, entry.speaker, entry.text])).toEqual([
      [100, "member", "第一个"],
      [200, "assistant", "我先说了一句"],
      [300, "member", "第二个"],
    ]);
    expect(timeline[1]?.speakerId).toBeNull();
  });

  it("cannot represent a system notice at all", () => {
    // Someone joining is not conversation content. Refusing it here means no later stage can
    // pass one in by accident, which is the same rule the no-reply check already follows.
    expect(() =>
      qqBuildTimeline({
        messages: [message(100, "有人入群", { speaker: "system", speakerId: null })],
        ownSpeech: [],
      }),
    ).toThrow(TypeError);
  });

  it("refuses a speaker identity that does not match the speaker kind", () => {
    expect(() =>
      qqBuildTimeline({
        messages: [message(100, "匿名", { speaker: "anonymous", speakerId: "30001" })],
        ownSpeech: [],
      }),
    ).toThrow(TypeError);
    expect(() =>
      qqBuildTimeline({ messages: [message(100, "无身份", { speakerId: null })], ownSpeech: [] }),
    ).toThrow(TypeError);
    expect(() =>
      qqBuildTimeline({ messages: [], ownSpeech: [{ occurredAtSeconds: 1, text: "" }] }),
    ).toThrow(TypeError);
    expect(() => qqBuildTimeline(null)).toThrow(TypeError);
  });
});

describe("selecting from the timeline", () => {
  const limits = { messageLimit: 3, windowMinutes: 10, tokenBudget: 10_000 };

  it("drops what is outside the window and says how much", () => {
    const selection = qqSelectContext({
      timeline: [message(0, "很久以前"), message(600, "刚才"), message(660, "现在")],
      limits,
      nowSeconds: 660,
    });
    expect(selection.messages.map((entry) => entry.text)).toEqual(["刚才", "现在"]);
    expect(selection.droppedByWindow).toBe(1);
    expect(selection.included).toBe(2);
  });

  it("keeps the newest messages when there are more than the count allows", () => {
    const selection = qqSelectContext({
      timeline: [message(600, "一"), message(620, "二"), message(640, "三"), message(660, "四")],
      limits,
      nowSeconds: 660,
    });
    expect(selection.messages.map((entry) => entry.text)).toEqual(["二", "三", "四"]);
    expect(selection.droppedByCount).toBe(1);
  });

  it("returns the selection in reading order, oldest first", () => {
    const selection = qqSelectContext({
      timeline: [message(100, "早"), message(200, "中"), message(300, "晚")],
      limits,
      nowSeconds: 300,
    });
    expect(selection.messages.map((entry) => entry.text)).toEqual(["早", "中", "晚"]);
  });

  it("drops from the oldest end when the budget runs out, leaving no gap", () => {
    const body = "中".repeat(20);
    const perMessage =
      QQ_CONTEXT_MESSAGE_OVERHEAD + estimateTokens(body) + estimateTokens("member") * 0;
    // Two messages fit; the third would exceed.
    const selection = qqSelectContext({
      timeline: [message(100, body), message(200, body), message(300, body)],
      limits: { messageLimit: 10, windowMinutes: 10, tokenBudget: perMessage * 2 + 1 },
      nowSeconds: 300,
    });
    expect(selection.messages.map((entry) => entry.occurredAtSeconds)).toEqual([200, 300]);
    expect(selection.droppedByBudget).toBe(1);
  });

  it("counts media notes as part of the cost", () => {
    const note = "一只橘猫趴在键盘上";
    const withNote = qqSelectContext({
      timeline: [message(100, null, { mediaNotes: [note] })],
      limits: { messageLimit: 1, windowMinutes: 10, tokenBudget: 10_000 },
      nowSeconds: 100,
    });
    expect(withNote.bytes).toBe(QQ_CONTEXT_MESSAGE_OVERHEAD + estimateTokens(note));
  });

  it("keeps the newest message even when it alone exceeds the budget, and says so", () => {
    const selection = qqSelectContext({
      timeline: [message(100, "旧"), message(200, "新".repeat(500))],
      limits: { messageLimit: 5, windowMinutes: 10, tokenBudget: 100 },
      nowSeconds: 200,
    });
    expect(selection.messages.map((entry) => entry.occurredAtSeconds)).toEqual([200]);
    expect(selection.newestExceedsBudget).toBe(true);
    expect(selection.droppedByBudget).toBe(1);
  });

  it("carries unread media as a count, so nothing can pretend to have seen it", () => {
    const selection = qqSelectContext({
      timeline: [
        message(100, null, { mediaUnread: 2 }),
        message(200, "配文", { mediaNotes: ["截图"], mediaUnread: 1 }),
      ],
      limits,
      nowSeconds: 200,
    });
    expect(selection.mediaUnread).toBe(3);
    expect(selection.messages[0]?.text).toBeNull();
  });

  it("answers an empty timeline with an empty selection", () => {
    const selection = qqSelectContext({ timeline: [], limits, nowSeconds: 500 });
    expect(selection.messages).toEqual([]);
    expect(selection).toMatchObject({
      bytes: 0,
      included: 0,
      droppedByWindow: 0,
      droppedByCount: 0,
      droppedByBudget: 0,
      mediaUnread: 0,
      newestExceedsBudget: false,
    });
  });

  it("refuses malformed selection input instead of guessing", () => {
    expect(() => qqSelectContext({ timeline: [], limits, nowSeconds: -1 })).toThrow(TypeError);
    expect(() =>
      qqSelectContext({ timeline: [], limits: { ...limits, messageLimit: 0 }, nowSeconds: 1 }),
    ).toThrow(TypeError);
    expect(() =>
      qqSelectContext({ timeline: [message(1, "x")], limits, nowSeconds: 1, extra: 1 }),
    ).toThrow(TypeError);
  });
});

describe("reading a conversation out of storage", () => {
  it("skips system notices and keeps what people actually said", () => {
    const h = setup();
    try {
      say(h.orm, "e1", 100, "大家好");
      say(h.orm, "e2", 200, "有人入群", { speakerKind: "system" });
      say(h.orm, "e3", 300, null, { speakerKind: "anonymous" });
      const rows = conversationMessagesSince(h.orm, scope(), { sinceSeconds: 0, limit: 10 });
      expect(rows.map((row) => [row.eventKey, row.speaker, row.speakerId])).toEqual([
        ["e3", "anonymous", null],
        ["e1", "member", "30001"],
      ]);
      expect(rows[0]?.text).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("groups media into notes and unread counts, one message at a time", () => {
    const h = setup();
    try {
      say(h.orm, "e1", 100, "看这个");
      recordMediaSegment(h.orm, {
        eventKey: "e1",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "pic.jpg",
        occurredAtSeconds: 100,
        addressed: true,
      });
      recordMediaSegment(h.orm, {
        eventKey: "e1",
        segmentIndex: 1,
        kind: "record",
        sourceRef: "voice.amr",
        occurredAtSeconds: 100,
        addressed: true,
      });
      const [row] = conversationMessagesSince(h.orm, scope(), { sinceSeconds: 0, limit: 10 });
      expect(row?.mediaNotes).toEqual([]);
      expect(row?.mediaUnread).toBe(2);
    } finally {
      h.business.close();
    }
  });

  it("keeps the description's model identity separate from member text", () => {
    const h = setup();
    try {
      say(h.orm, "e1", 100, "看图");
      recordMediaSegment(h.orm, {
        eventKey: "e1",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "pic.jpg",
        occurredAtSeconds: 100,
        addressed: true,
      });
      recordMediaNote(h.orm, {
        eventKey: "e1",
        segmentIndex: 0,
        note: "橘猫",
        noteModel: "vision-local",
      });
      const [row] = conversationMessagesSince(h.orm, scope(), { sinceSeconds: 0, limit: 10 });
      expect(row?.text).toBe("看图");
      expect(row?.mediaNotes).toEqual(["[vision-local] 橘猫"]);
      expect(row?.mediaUnread).toBe(0);
    } finally {
      h.business.close();
    }
  });

  it("respects the window, the limit, the conversation and the assistant", () => {
    const h = setup();
    try {
      say(h.orm, "e1", 100, "旧");
      say(h.orm, "e2", 500, "新");
      say(h.orm, "e3", 600, "别的会话", { target: scope({ peerId: "29999" }) });
      expect(
        conversationMessagesSince(h.orm, scope(), { sinceSeconds: 400, limit: 10 }).map(
          (r) => r.text,
        ),
      ).toEqual(["新"]);
      expect(
        conversationMessagesSince(h.orm, scope(), { sinceSeconds: 0, limit: 1 }).map((r) => r.text),
      ).toEqual(["新"]);
      expect(() =>
        conversationMessagesSince(h.orm, scope(), { sinceSeconds: -1, limit: 5 }),
      ).toThrow(TypeError);
      expect(() =>
        conversationMessagesSince(h.orm, scope(), { sinceSeconds: 0, limit: 0 }),
      ).toThrow(TypeError);
    } finally {
      h.business.close();
    }
  });

  it("keeps an expired body out but leaves the message in place", () => {
    const h = setup();
    try {
      say(h.orm, "e1", 100, null);
      const [row] = conversationMessagesSince(h.orm, scope(), { sinceSeconds: 0, limit: 10 });
      expect(row?.text).toBeNull();
      expect(row?.eventKey).toBe("e1");
    } finally {
      h.business.close();
    }
  });

  it("reads back the assistant's own words, newest first, and only the ones with words", () => {
    const h = setup();
    try {
      recordQqSpeech(h.orm, {
        scope: scope(),
        kind: "chiming_in",
        spokeAtSeconds: 100,
        text: "第一句",
      });
      // A sticker-only utterance: no words, so nothing to place in a conversation.
      recordQqSpeech(h.orm, {
        scope: scope(),
        kind: "chiming_in",
        spokeAtSeconds: 200,
        text: null,
      });
      recordQqSpeech(h.orm, {
        scope: scope(),
        kind: "follow_up",
        spokeAtSeconds: 300,
        text: "第二句",
      });
      const rows = ownSpeechSince(h.orm, scope(), { sinceSeconds: 0, limit: 10 });
      expect(rows).toEqual([
        { occurredAtSeconds: 300, text: "第二句" },
        { occurredAtSeconds: 100, text: "第一句" },
      ]);
      expect(() => ownSpeechSince(h.orm, scope(), { sinceSeconds: -1, limit: 5 })).toThrow(
        TypeError,
      );
    } finally {
      h.business.close();
    }
  });

  it("refuses an empty body rather than writing one", () => {
    const h = setup();
    try {
      expect(() =>
        recordQqSpeech(h.orm, {
          scope: scope(),
          kind: "chiming_in",
          spokeAtSeconds: 100,
          text: "   ",
        }),
      ).toThrow(TypeError);
      expect(h.db.query("SELECT count(*) AS n FROM qq_speech_text").get()).toEqual({ n: 0 });
    } finally {
      h.business.close();
    }
  });

  it("stores what a delivered reply said, and nothing for a sticker-only one", () => {
    const h = setup();
    try {
      recordQqSend(h.orm, {
        scope: scope(),
        kind: "chiming_in",
        sentAtSeconds: 100,
        text: "接一句",
        parts: [{ kind: "text", result: "confirmed", messageId: "m1" }],
      });
      // The ledger names the library asset a sticker part carried, and the foreign key is enforced:
      // a part referencing an asset that does not exist would be refused (P4g).
      seedSticker(h.orm, "22222222-2222-4222-8222-222222222222");
      recordQqSend(h.orm, {
        scope: scope(),
        kind: "chiming_in",
        sentAtSeconds: 400,
        text: null,
        parts: [
          {
            kind: "sticker",
            result: "confirmed",
            messageId: "m2",
            stickerId: "22222222-2222-4222-8222-222222222222",
          },
        ],
      });
      expect(ownSpeechSince(h.orm, scope(), { sinceSeconds: 0, limit: 10 })).toEqual([
        { occurredAtSeconds: 100, text: "接一句" },
      ]);
    } finally {
      h.business.close();
    }
  });

  it("forgets a body with the window, without losing the record that it was said", () => {
    const h = setup();
    try {
      const now = Math.floor(Date.parse(nowIso()) / 1000);
      const fresh = recordQqSpeech(h.orm, {
        scope: scope(),
        kind: "chiming_in",
        spokeAtSeconds: now,
        text: "还新鲜",
      });
      recordQqSpeech(h.orm, {
        scope: scope(),
        kind: "chiming_in",
        spokeAtSeconds: now - 20 * 24 * 60 * 60,
        text: "早就过期",
      });
      expect(purgeExpiredQqSpeech(h.orm)).toBe(1);
      expect(h.db.query("SELECT count(*) AS n FROM qq_speech_text").get()).toEqual({ n: 1 });
      expect(h.db.query("SELECT speech_id AS id FROM qq_speech_text").get()).toEqual({
        id: fresh.id,
      });
      expect(ownSpeechSince(h.orm, scope(), { sinceSeconds: 0, limit: 10 })).toEqual([
        { occurredAtSeconds: now, text: "还新鲜" },
      ]);
    } finally {
      h.business.close();
    }
  });
});

describe("a whole conversation, end to end", () => {
  it("gives the judgement both sides of the conversation, within its own budget", () => {
    const h = setup();
    try {
      const now = 10_000;
      say(h.orm, "e1", now - 5 * MINUTE, "今晚吃什么");
      say(h.orm, "e2", now - 4 * MINUTE, "随便");
      recordQqSpeech(h.orm, {
        scope: scope(),
        kind: "chiming_in",
        spokeAtSeconds: now - 3 * MINUTE,
        text: "火锅怎么样",
      });
      say(h.orm, "e3", now - 2 * MINUTE, null);
      recordMediaSegment(h.orm, {
        eventKey: "e3",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "menu.jpg",
        occurredAtSeconds: now - 2 * MINUTE,
        addressed: true,
      });
      say(h.orm, "e4", now - MINUTE, "那张图里是什么");

      const timeline = qqBuildTimeline({
        messages: conversationMessagesSince(h.orm, scope(), {
          sinceSeconds: now - 60 * MINUTE,
          limit: 20,
        }).map((row) => ({
          occurredAtSeconds: row.occurredAtSeconds,
          speaker: row.speaker,
          speakerId: row.speakerId,
          text: row.text,
          mediaNotes: row.mediaNotes,
          mediaUnread: row.mediaUnread,
        })),
        ownSpeech: ownSpeechSince(h.orm, scope(), {
          sinceSeconds: now - 60 * MINUTE,
          limit: 20,
        }).map((row) => ({ occurredAtSeconds: row.occurredAtSeconds, text: row.text })),
      });
      const selection = qqSelectContext({
        timeline,
        limits: qqContextLimits(QQ_CONTEXT_DEFAULT, "judgement"),
        nowSeconds: now,
      });

      expect(selection.messages.map((entry) => [entry.speaker, entry.text])).toEqual([
        ["member", "今晚吃什么"],
        ["member", "随便"],
        // The assistant can see its own line, which is the whole point of P3b-2.
        ["assistant", "火锅怎么样"],
        ["member", null],
        ["member", "那张图里是什么"],
      ]);
      // Something arrived that was never read, and the selection says so rather than
      // presenting an empty message.
      expect(selection.mediaUnread).toBe(1);
      expect(selection.bytes).toBeGreaterThan(0);
      expect(selection.included).toBe(5);
    } finally {
      h.business.close();
    }
  });
});
