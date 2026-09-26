// P4d: sticker library eligibility and §8.1 output assembly (ADR0018).
//
// These suites exist because both halves are decisions someone would otherwise re-derive at
// the call site, and both have a rule that reads as a detail but is not:
//
//   * §8.1-6's downgrade is not a failure — nothing was submitted, so the reply is simply
//     text-only, and a caller that treats it as a failed send would resend with another
//     sticker. One test below fails if that downgrade turns into an attempt.
//   * §9.1 forbids an asset in two authorized collections from counting twice, so a join that
//     returns both memberships must not become two chances in the draw.
//
// Nothing here touches a database, a model or the platform.

import { describe, expect, it } from "bun:test";
import { planQqOutput, qqPlannedSendParts } from "../../src/server/services/qq-output-plan";
import {
  parseQqStickerCandidate,
  QQ_STICKER_LIBRARY_POLICY,
  qqStickerDedupPolicy,
  qqStickerUsable,
  resolveQqStickerLibrary,
} from "../../src/server/services/qq-sticker-contract";

const asset = (id: string, collectionIds: string[], overrides: Record<string, unknown> = {}) => ({
  id,
  enabled: true,
  available: true,
  collectionIds,
  ...overrides,
});

const candidate = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  enabled: true,
  authorized: true,
  available: true,
  lastUsedSecondsAgo: null,
  recentlyUsed: false,
  ...overrides,
});

describe("which library assets may be used", () => {
  it("offers an enabled, readable asset that sits in an authorized collection", () => {
    const view = resolveQqStickerLibrary({
      assets: [asset("a", ["c1"]), asset("b", ["c1", "c2"])],
      authorizedCollectionIds: ["c2"],
    });
    expect(view.candidates).toEqual([{ assetId: "b", viaCollectionIds: ["c2"] }]);
    expect(view.rejected).toEqual([{ assetId: "a", reason: "no_authorized_collection" }]);
  });

  it("makes authorization follow the collection, not the asset", () => {
    // The asset exists and is enabled, but nothing authorized holds it.
    const view = resolveQqStickerLibrary({
      assets: [asset("a", ["private"])],
      authorizedCollectionIds: [],
    });
    expect(view.candidates).toEqual([]);
    expect(view.rejected).toEqual([{ assetId: "a", reason: "no_authorized_collection" }]);
  });

  it("counts an asset in two authorized collections exactly once", () => {
    const view = resolveQqStickerLibrary({
      assets: [asset("a", ["c1", "c2"])],
      authorizedCollectionIds: ["c1", "c2"],
    });
    expect(view.candidates).toHaveLength(1);
    // Both memberships are reported, but they are one candidate: no extra weight in a draw.
    expect(view.candidates[0]?.viaCollectionIds).toEqual(["c1", "c2"]);
  });

  it("refuses a duplicate row rather than letting a join create a second chance", () => {
    const view = resolveQqStickerLibrary({
      assets: [asset("a", ["c1"]), asset("a", ["c1", "c2"])],
      authorizedCollectionIds: ["c1", "c2"],
    });
    expect(view.candidates.map((entry) => entry.assetId)).toEqual(["a"]);
    expect(view.rejected).toEqual([{ assetId: "a", reason: "duplicate" }]);
  });

  it("leaves out a disabled or unreadable asset whatever the authorization says", () => {
    const view = resolveQqStickerLibrary({
      assets: [
        asset("off", ["c1"], { enabled: false }),
        asset("missing", ["c1"], { available: false }),
        asset("ok", ["c1"]),
      ],
      authorizedCollectionIds: ["c1"],
    });
    expect(view.candidates.map((entry) => entry.assetId)).toEqual(["ok"]);
    expect(view.rejected).toEqual([
      { assetId: "off", reason: "disabled" },
      { assetId: "missing", reason: "file_unavailable" },
    ]);
  });

  it("keeps the caller's order, because this decides membership and not preference", () => {
    const view = resolveQqStickerLibrary({
      assets: [asset("z", ["c1"]), asset("a", ["c1"]), asset("m", ["c1"])],
      authorizedCollectionIds: ["c1"],
    });
    expect(view.candidates.map((entry) => entry.assetId)).toEqual(["z", "a", "m"]);
  });

  it("rejects input that does not match the contract", () => {
    expect(() => resolveQqStickerLibrary({ assets: [asset("a", ["c1"])] })).toThrow(TypeError);
    expect(() =>
      resolveQqStickerLibrary({
        assets: [asset("a", ["c1"])],
        authorizedCollectionIds: ["c1"],
        extra: true,
      }),
    ).toThrow(TypeError);
    expect(() =>
      resolveQqStickerLibrary({
        assets: [{ id: "", enabled: true, available: true, collectionIds: [] }],
        authorizedCollectionIds: [],
      }),
    ).toThrow(TypeError);
  });
});

describe("one candidate at send time", () => {
  it("accepts a sticker that is enabled, authorized, present and off cooldown", () => {
    expect(qqStickerUsable(candidate("a"), { minRepeatSeconds: null })).toEqual({ kind: "usable" });
  });

  it("names the reason a candidate cannot be used", () => {
    expect(qqStickerUsable(candidate("a", { enabled: false }), { minRepeatSeconds: null })).toEqual(
      {
        kind: "rejected",
        reason: "disabled",
      },
    );
    expect(
      qqStickerUsable(candidate("a", { authorized: false }), { minRepeatSeconds: null }),
    ).toEqual({ kind: "rejected", reason: "not_authorized" });
    expect(
      qqStickerUsable(candidate("a", { available: false }), { minRepeatSeconds: null }),
    ).toEqual({ kind: "rejected", reason: "file_unavailable" });
  });

  it("enforces the shortest repeat interval only when one is configured", () => {
    expect(
      qqStickerUsable(candidate("a", { lastUsedSecondsAgo: 5 }), { minRepeatSeconds: 60 }),
    ).toEqual({ kind: "rejected", reason: "too_soon" });
    expect(
      qqStickerUsable(candidate("a", { lastUsedSecondsAgo: 60 }), { minRepeatSeconds: 60 }),
    ).toEqual({ kind: "usable" });
    // No minimum spacing is not the same as a zero-second one, and the scheme can ask for it.
    expect(
      qqStickerUsable(candidate("a", { lastUsedSecondsAgo: 0 }), { minRepeatSeconds: null }),
    ).toEqual({ kind: "usable" });
  });

  it("never treats the soft avoidance as a prohibition", () => {
    expect(
      qqStickerUsable(candidate("a", { recentlyUsed: true }), { minRepeatSeconds: null }),
    ).toEqual({ kind: "usable" });
  });

  it("rejects input that does not match the contract", () => {
    expect(() =>
      qqStickerUsable(candidate("a", { recentlyUsed: "yes" }), { minRepeatSeconds: null }),
    ).toThrow(TypeError);
    expect(() => qqStickerUsable(candidate("a"), {})).toThrow(TypeError);
    expect(() => parseQqStickerCandidate({ ...candidate("a"), extra: 1 })).toThrow(TypeError);
  });

  it("states the destructive-looking operations as what they really do", () => {
    expect(QQ_STICKER_LIBRARY_POLICY).toEqual({
      removingFromCollectionRemovesMembershipOnly: true,
      disablingBlocksSelection: true,
      disablingBlocksUnsubmittedSend: true,
      deletingCopiesAutomatically: false,
      deletingOrphanAssetsAutomatically: false,
    });
  });
});

describe("turning the scheme's repetition rules into the plan's inputs", () => {
  it("converts the stored minutes into seconds", () => {
    expect(
      qqStickerDedupPolicy({ sticker_min_repeat_minutes: 10, sticker_recent_avoid_count: 5 }),
    ).toEqual({ minRepeatSeconds: 600, recentAvoidCount: 5, avoidRecent: true });
  });

  it("keeps 0 meaning 'no such limit' through the conversion", () => {
    // A zero-minute interval is not "no sooner than zero seconds" written differently: it is
    // the scheme saying there is no spacing rule, which the plan spells as null.
    expect(
      qqStickerDedupPolicy({ sticker_min_repeat_minutes: 0, sticker_recent_avoid_count: 0 }),
    ).toEqual({ minRepeatSeconds: null, recentAvoidCount: 0, avoidRecent: false });
  });

  it("turns the soft rule off rather than refusing every sticker when its count is zero", () => {
    const policy = qqStickerDedupPolicy({
      sticker_min_repeat_minutes: 1,
      sticker_recent_avoid_count: 0,
    });
    expect(policy.avoidRecent).toBe(false);
    const plan = planQqOutput({
      text: "哈",
      requestedStickers: 1,
      maxStickerCount: 3,
      candidates: [candidate("recent", { recentlyUsed: true })],
      minRepeatSeconds: policy.minRepeatSeconds,
      avoidRecent: policy.avoidRecent,
    });
    expect(plan).toMatchObject({ chosenStickerIds: ["recent"] });
  });

  it("drives the plan's own interval from the stored value", () => {
    const policy = qqStickerDedupPolicy({
      sticker_min_repeat_minutes: 2,
      sticker_recent_avoid_count: 5,
    });
    const justUsed = planQqOutput({
      text: "嗯",
      requestedStickers: 1,
      maxStickerCount: 3,
      candidates: [candidate("a", { lastUsedSecondsAgo: 119 })],
      minRepeatSeconds: policy.minRepeatSeconds,
      avoidRecent: policy.avoidRecent,
    });
    expect(justUsed).toMatchObject({
      chosenStickerIds: [],
      textOnlyBecauseStickersUnavailable: true,
      rejected: [{ stickerId: "a", reason: "too_soon" }],
    });
  });

  it("rejects a group outside the decided ranges", () => {
    expect(() =>
      qqStickerDedupPolicy({ sticker_min_repeat_minutes: 1441, sticker_recent_avoid_count: 5 }),
    ).toThrow(TypeError);
    expect(() =>
      qqStickerDedupPolicy({ sticker_min_repeat_minutes: -1, sticker_recent_avoid_count: 5 }),
    ).toThrow(TypeError);
    expect(() =>
      qqStickerDedupPolicy({ sticker_min_repeat_minutes: 10, sticker_recent_avoid_count: 21 }),
    ).toThrow(TypeError);
    expect(() => qqStickerDedupPolicy({ sticker_min_repeat_minutes: 10 })).toThrow(TypeError);
    expect(() =>
      qqStickerDedupPolicy({
        sticker_min_repeat_minutes: 10,
        sticker_recent_avoid_count: 5,
        extra: 1,
      }),
    ).toThrow(TypeError);
  });
});

describe("assembling §8.1's reply", () => {
  it("sends text alone when the model asked for no sticker", () => {
    const plan = planQqOutput({
      text: "  今天风挺大  ",
      requestedStickers: 0,
      maxStickerCount: 3,
      candidates: [candidate("a")],
      minRepeatSeconds: null,
      avoidRecent: false,
    });
    expect(plan).toEqual({
      kind: "planned",
      shape: "text_only",
      parts: [{ kind: "text", text: "今天风挺大" }],
      requestedStickers: 0,
      chosenStickerIds: [],
      rejected: [],
      textOnlyBecauseStickersUnavailable: false,
    });
  });

  it("sends a sticker alone when there are no words", () => {
    const plan = planQqOutput({
      text: null,
      requestedStickers: 1,
      maxStickerCount: 3,
      candidates: [candidate("a")],
      minRepeatSeconds: null,
      avoidRecent: false,
    });
    expect(plan).toMatchObject({
      kind: "planned",
      shape: "sticker_only",
      parts: [{ kind: "sticker", stickerId: "a" }],
      chosenStickerIds: ["a"],
    });
  });

  it("keeps text and stickers in one reply, text first", () => {
    const plan = planQqOutput({
      text: "看这个",
      requestedStickers: 2,
      maxStickerCount: 3,
      candidates: [candidate("a"), candidate("b")],
      minRepeatSeconds: null,
      avoidRecent: false,
    });
    expect(plan).toMatchObject({
      kind: "planned",
      shape: "mixed",
      // The order is also the part order §8.2 will record, so a partial send reads the same
      // in both places.
      parts: [
        { kind: "text", text: "看这个" },
        { kind: "sticker", stickerId: "a" },
        { kind: "sticker", stickerId: "b" },
      ],
      chosenStickerIds: ["a", "b"],
    });
  });

  it("treats the scheme's count as a ceiling and never pads up to it", () => {
    const one = planQqOutput({
      text: "嗯",
      requestedStickers: 1,
      maxStickerCount: 3,
      candidates: [candidate("a"), candidate("b"), candidate("c")],
      minRepeatSeconds: null,
      avoidRecent: false,
    });
    expect(one).toMatchObject({ chosenStickerIds: ["a"] });
    const capped = planQqOutput({
      text: "嗯",
      requestedStickers: 3,
      maxStickerCount: 1,
      candidates: [candidate("a"), candidate("b")],
      minRepeatSeconds: null,
      avoidRecent: false,
    });
    expect(capped).toMatchObject({
      chosenStickerIds: ["a"],
      rejected: [{ stickerId: "b", reason: "over_ceiling" }],
    });
  });

  it("says why each candidate was left out", () => {
    const plan = planQqOutput({
      text: "文字还在",
      requestedStickers: 2,
      maxStickerCount: 3,
      candidates: [
        candidate("off", { enabled: false }),
        candidate("foreign", { authorized: false }),
        candidate("gone", { available: false }),
        candidate("early", { lastUsedSecondsAgo: 1 }),
        candidate("ok"),
      ],
      minRepeatSeconds: 60,
      avoidRecent: false,
    });
    expect(plan).toMatchObject({
      kind: "planned",
      rejected: [
        { stickerId: "off", reason: "disabled" },
        { stickerId: "foreign", reason: "not_authorized" },
        { stickerId: "gone", reason: "file_unavailable" },
        { stickerId: "early", reason: "too_soon" },
      ],
      chosenStickerIds: ["ok"],
    });
  });

  it("prefers an unused sticker without refusing a recently used one", () => {
    const preferred = planQqOutput({
      text: "哈",
      requestedStickers: 1,
      maxStickerCount: 3,
      candidates: [candidate("recent", { recentlyUsed: true }), candidate("fresh")],
      minRepeatSeconds: null,
      avoidRecent: true,
    });
    expect(preferred).toMatchObject({ chosenStickerIds: ["fresh"] });
    const onlyRecent = planQqOutput({
      text: "哈",
      requestedStickers: 1,
      maxStickerCount: 3,
      candidates: [candidate("recent", { recentlyUsed: true })],
      minRepeatSeconds: null,
      avoidRecent: true,
    });
    // §9.3's "尽量避开" is an intention, not a prohibition: with nothing else left, the
    // sticker still goes out rather than the reply silently losing it.
    expect(onlyRecent).toMatchObject({ chosenStickerIds: ["recent"] });
  });

  it("downgrades to text alone when the sticker became unusable", () => {
    const plan = planQqOutput({
      text: "算了，就这样吧",
      requestedStickers: 1,
      maxStickerCount: 3,
      candidates: [candidate("a", { available: false })],
      minRepeatSeconds: null,
      avoidRecent: false,
    });
    // §8.1-6: nothing was submitted, so this is a downgrade and not a failed attempt. The
    // plan carries no attempt, no delivery id and no failure flag — there is nothing a
    // caller could mistake for "we tried and it broke".
    expect(plan).toEqual({
      kind: "planned",
      shape: "text_only",
      parts: [{ kind: "text", text: "算了，就这样吧" }],
      requestedStickers: 1,
      chosenStickerIds: [],
      rejected: [{ stickerId: "a", reason: "file_unavailable" }],
      textOnlyBecauseStickersUnavailable: true,
    });
  });

  it("abandons the reply when the sticker is unusable and there is no text", () => {
    // §8.1-6's second half: without words there is nothing to fall back to, so this reply is
    // given up — still not a failure, and still nothing to resend.
    expect(
      planQqOutput({
        text: "   ",
        requestedStickers: 1,
        maxStickerCount: 3,
        candidates: [candidate("a", { enabled: false })],
        minRepeatSeconds: null,
        avoidRecent: false,
      }),
    ).toEqual({ kind: "abandoned", reason: "sticker_unavailable_and_no_text" });
  });

  it("abandons an empty reply, which is not the same as a failed one", () => {
    expect(
      planQqOutput({
        text: null,
        requestedStickers: 0,
        maxStickerCount: 3,
        candidates: [],
        minRepeatSeconds: null,
        avoidRecent: false,
      }),
    ).toEqual({ kind: "abandoned", reason: "empty_reply" });
  });

  it("rejects input that does not match the contract", () => {
    const base = {
      text: "x",
      requestedStickers: 0,
      maxStickerCount: 3,
      candidates: [],
      minRepeatSeconds: null,
      avoidRecent: false,
    };
    expect(() => planQqOutput({ ...base, maxStickerCount: 0 })).toThrow(TypeError);
    expect(() => planQqOutput({ ...base, maxStickerCount: 4 })).toThrow(TypeError);
    expect(() => planQqOutput({ ...base, requestedStickers: -1 })).toThrow(TypeError);
    expect(() => planQqOutput({ ...base, minRepeatSeconds: -1 })).toThrow(TypeError);
    expect(() => planQqOutput({ ...base, avoidRecent: "no" })).toThrow(TypeError);
    expect(() => planQqOutput({ ...base, candidates: [{ id: "a" }] })).toThrow(TypeError);
    expect(() => planQqOutput({ ...base, extra: 1 })).toThrow(TypeError);
  });
});

describe("handing the plan to the send ledger", () => {
  const mixed = planQqOutput({
    text: "看这个",
    requestedStickers: 1,
    maxStickerCount: 3,
    candidates: [candidate("a")],
    minRepeatSeconds: null,
    avoidRecent: false,
  });

  it("pairs the planned parts with the platform's answers, in send order", () => {
    if (mixed.kind !== "planned") throw new Error("fixture must plan");
    // The sticker's asset id travels into the ledger too (P4g): "a sticker went out" is not
    // enough to answer §9.3's "was this one used recently in this conversation".
    expect(
      qqPlannedSendParts(mixed, [
        { result: "confirmed", messageId: "m1" },
        { result: "failed", messageId: null },
      ]),
    ).toEqual([
      { kind: "text", result: "confirmed", messageId: "m1", stickerId: null },
      { kind: "sticker", result: "failed", messageId: null, stickerId: "a" },
    ]);
  });

  it("refuses a count that does not match what was planned", () => {
    if (mixed.kind !== "planned") throw new Error("fixture must plan");
    // Claiming one request for a two-part reply is how a ledger ends up describing a reply
    // nobody assembled.
    expect(() => qqPlannedSendParts(mixed, [{ result: "confirmed", messageId: "m1" }])).toThrow(
      TypeError,
    );
    expect(() =>
      qqPlannedSendParts(mixed, [
        { result: "confirmed", messageId: "m1" },
        { result: "confirmed", messageId: "m2" },
        { result: "confirmed", messageId: "m3" },
      ]),
    ).toThrow(TypeError);
  });

  it("refuses a platform id the platform never gave, through the ledger's own rule", () => {
    if (mixed.kind !== "planned") throw new Error("fixture must plan");
    expect(() =>
      qqPlannedSendParts(mixed, [
        { result: "confirmed", messageId: null },
        { result: "failed", messageId: null },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      qqPlannedSendParts(mixed, [
        { result: "unknown", messageId: "m1" },
        { result: "confirmed", messageId: "m2" },
      ]),
    ).toThrow(TypeError);
  });

  it("refuses an abandoned plan, which never reached a platform", () => {
    const abandoned = planQqOutput({
      text: null,
      requestedStickers: 1,
      maxStickerCount: 3,
      candidates: [candidate("a", { enabled: false })],
      minRepeatSeconds: null,
      avoidRecent: false,
    });
    if (abandoned.kind !== "abandoned") throw new Error("fixture must abandon");
    expect(() => qqPlannedSendParts(abandoned as never, [])).toThrow(TypeError);
  });
});

describe("一条主题一条消息", () => {
  const plan = (text: string) => {
    const built = planQqOutput({
      text,
      requestedStickers: 0,
      maxStickerCount: 1,
      candidates: [],
      minRepeatSeconds: null,
      avoidRecent: false,
    });
    if (built.kind !== "planned") throw new Error("expected a planned reply");
    return built.parts.map((part) => (part.kind === "text" ? part.text : `[图 ${part.stickerId}]`));
  };

  it("换行分开的每一行各成为一条消息，顺序不变", () => {
    expect(plan("在的喵\n午饭我投盖饭\n那个正则少了个反斜杠")).toEqual([
      "在的喵",
      "午饭我投盖饭",
      "那个正则少了个反斜杠",
    ]);
  });

  it("超过上限（3 条）时把多出来的并进最后一条，不丢内容", () => {
    expect(plan("一\n二\n三\n四")).toEqual(["一", "二", "三 四"]);
  });

  it("单行的旧形状原样是一条（不改变既有行为）", () => {
    expect(plan("就这一句")).toEqual(["就这一句"]);
  });

  it("空行不产生空消息", () => {
    expect(plan("一\n\n二")).toEqual(["一", "二"]);
  });
});
