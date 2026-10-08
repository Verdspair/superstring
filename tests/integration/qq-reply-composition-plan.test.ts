import { describe, expect, it } from "bun:test";
import { planQqOutput } from "../../src/server/services/qq-output-plan";

const candidate = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  enabled: true,
  authorized: true,
  available: true,
  lastUsedSecondsAgo: null,
  recentlyUsed: false,
  ...overrides,
});

const base = {
  text: null as string | null,
  requestedStickers: 0,
  maxStickerCount: 3,
  candidates: [] as ReturnType<typeof candidate>[],
  minRepeatSeconds: null as number | null,
  avoidRecent: false,
};

describe("QQ reply, mention, text, and sticker composition", () => {
  it("keeps the legacy no-quote text plan unchanged", () => {
    expect(planQqOutput({ ...base, text: "  hello  " })).toEqual({
      kind: "planned",
      shape: "text_only",
      parts: [{ kind: "text", text: "hello", mentions: [] }],
      requestedStickers: 0,
      chosenStickerIds: [],
      rejected: [],
      textOnlyBecauseStickersUnavailable: false,
    });
  });

  it("allows mention-only output as an empty-text carrier", () => {
    expect(planQqOutput({ ...base, mentions: ["member-1"] })).toMatchObject({
      kind: "planned",
      shape: "text_only",
      parts: [{ kind: "text", text: "", mentions: ["member-1"] }],
    });
  });

  it("rejects a quote-only plan instead of creating an empty reply carrier", () => {
    expect(planQqOutput({ ...base, replyToMessageId: "observed-message-1" })).toEqual({
      kind: "abandoned",
      reason: "empty_reply",
    });
  });

  it("attaches a quote to text without changing the text body", () => {
    expect(
      planQqOutput({
        ...base,
        text: "hello",
        replyToMessageId: "observed-message-1",
      }),
    ).toMatchObject({
      kind: "planned",
      parts: [
        {
          kind: "text",
          text: "hello",
          mentions: [],
          replyToMessageId: "observed-message-1",
        },
      ],
    });
  });

  it("composes quote, mention, and ordinary text in one first carrier", () => {
    expect(
      planQqOutput({
        ...base,
        text: "hi there",
        replyToMessageId: "observed-message-1",
        mentions: ["member-1", "member-2"],
      }),
    ).toMatchObject({
      kind: "planned",
      parts: [
        {
          kind: "text",
          text: "hi there",
          mentions: ["member-1", "member-2"],
          replyToMessageId: "observed-message-1",
        },
      ],
    });
  });

  it("keeps quote and mentions only on the first split text part", () => {
    const plan = planQqOutput({
      ...base,
      text: "first\nsecond\nthird\nfourth",
      replyToMessageId: "observed-message-1",
      mentions: ["member-1"],
    });
    expect(plan.kind).toBe("planned");
    if (plan.kind !== "planned") return;
    expect(plan.parts).toEqual([
      {
        kind: "text",
        text: "first",
        mentions: ["member-1"],
        replyToMessageId: "observed-message-1",
      },
      { kind: "text", text: "second", mentions: [] },
      { kind: "text", text: "third fourth", mentions: [] },
    ]);
  });

  it("attaches a quote to the first sticker without inventing a text message", () => {
    expect(
      planQqOutput({
        ...base,
        requestedStickers: 2,
        candidates: [candidate("sticker-1"), candidate("sticker-2")],
        replyToMessageId: "observed-message-1",
      }),
    ).toMatchObject({
      kind: "planned",
      shape: "sticker_only",
      parts: [
        { kind: "sticker", stickerId: "sticker-1", replyToMessageId: "observed-message-1" },
        { kind: "sticker", stickerId: "sticker-2" },
      ],
    });
  });

  it("carries quote and mentions on the first actual sticker for a sticker-only choice", () => {
    expect(
      planQqOutput({
        ...base,
        requestedStickers: 1,
        candidates: [candidate("sticker-1")],
        replyToMessageId: "observed-message-1",
        mentions: ["member-1"],
      }),
    ).toMatchObject({
      kind: "planned",
      shape: "sticker_only",
      parts: [
        {
          kind: "sticker",
          stickerId: "sticker-1",
          replyToMessageId: "observed-message-1",
          mentions: ["member-1"],
        },
      ],
    });
  });

  it("uses an empty-text carrier for mention-only output when the selected sticker is unavailable", () => {
    expect(
      planQqOutput({
        ...base,
        requestedStickers: 1,
        candidates: [candidate("sticker-1", { available: false })],
        replyToMessageId: "observed-message-1",
        mentions: ["member-1"],
      }),
    ).toMatchObject({
      kind: "planned",
      shape: "text_only",
      parts: [
        {
          kind: "text",
          text: "",
          mentions: ["member-1"],
          replyToMessageId: "observed-message-1",
        },
      ],
      textOnlyBecauseStickersUnavailable: true,
    });
  });

  it("keeps the quote on the ordinary-text fallback when a sticker is unavailable", () => {
    expect(
      planQqOutput({
        ...base,
        text: "still here",
        requestedStickers: 1,
        candidates: [candidate("sticker-1", { available: false })],
        replyToMessageId: "observed-message-1",
        mentions: ["member-1"],
      }),
    ).toMatchObject({
      kind: "planned",
      parts: [
        {
          kind: "text",
          text: "still here",
          mentions: ["member-1"],
          replyToMessageId: "observed-message-1",
        },
      ],
      textOnlyBecauseStickersUnavailable: true,
    });
  });

  it("rejects malformed optional metadata through the strict input contract", () => {
    expect(() => planQqOutput({ ...base, text: "x", replyToMessageId: "" })).toThrow(TypeError);
    expect(() => planQqOutput({ ...base, text: "x", mentions: [""] })).toThrow(TypeError);
    expect(() => planQqOutput({ ...base, text: "x", replyToMessageId: "m1", extra: true })).toThrow(
      TypeError,
    );
  });
});
