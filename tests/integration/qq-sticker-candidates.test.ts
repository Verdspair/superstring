// P4h: assembling a reply's sticker candidates from storage (ADR0018, §9.1/§9.3).
//
// Each piece of this already existed and none of them could see the whole: the scheme authorized
// collections (0022) and set how fast a sticker may come back (0020), the library knew which assets
// are enabled and where they sit, and the send ledger knew what this conversation had seen. What did
// not exist was the join — `resolveQqStickerLibrary` takes the authorized set as an input, and
// nothing produced it, so a complete and tested library was unusable by any scheme.
//
// The tests below hold three boundaries that are easy to lose in a join:
//
//   * the candidate carries FACTS, not permissions: membership in the library view is not restated
//     as "usable", so a candidate that should never have been emitted is still refused downstream;
//   * §9.3's "最近几次" counts distinct stickers, not sends — the hard interval is what handles "the
//     same one again";
//   * which part results mean "seen" is U13 and stays the caller's argument.

import { describe, expect, it } from "bun:test";
import type { QqConversationScope } from "../../src/server/db/qq-observation-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import {
  createQqStickerCollection,
  importQqSticker,
  readQqStickerAsset,
  setQqStickerEnabled,
} from "../../src/server/db/qq-sticker-repository";
import { ensureDefaults, type Orm } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import {
  assembleQqStickerCandidates,
  qqStickerSelectionForScheme,
} from "../../src/server/services/qq-sticker-candidates";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function tracked() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  return { business, orm: business.orm, db: business.db };
}

/** A real asset row: the library and the ledger both reference it, so it has to exist. */
function asset(orm: Orm, collectionIds: readonly string[] = []) {
  const id = crypto.randomUUID();
  return importQqSticker(orm, {
    id,
    copy: { fileName: `${id}.png`, byteSize: 128, mediaType: "image" },
    name: "素材.png",
    width: 64,
    height: 64,
    collectionIds,
  });
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

/** One sticker send in a conversation, which is what §9.3's history is made of. */
function used(
  orm: Orm,
  input: {
    scope?: QqConversationScope;
    assetId: string;
    at: number;
    result?: "confirmed" | "unknown";
  },
) {
  recordQqSend(orm, {
    scope: input.scope ?? scope(),
    kind: "chiming_in",
    sentAtSeconds: input.at,
    text: null,
    parts: [
      {
        kind: "sticker",
        result: input.result ?? "confirmed",
        messageId: (input.result ?? "confirmed") === "confirmed" ? `m${input.at}` : null,
        stickerId: input.assetId,
      },
    ],
  });
}

describe("a candidate carries the facts, not the permission", () => {
  it("restates an enabled, authorized, never-used sticker", () => {
    const assembled = assembleQqStickerCandidates({
      assets: [{ id: "a", enabled: true, available: true, collectionIds: ["c1"] }],
      authorizedCollectionIds: ["c1"],
      usage: [],
      recentAvoidCount: 5,
      nowSeconds: 1000,
    });
    expect(assembled.candidates).toEqual([
      {
        id: "a",
        enabled: true,
        authorized: true,
        available: true,
        lastUsedSecondsAgo: null,
        recentlyUsed: false,
      },
    ]);
    expect(assembled.rejected).toEqual([]);
  });

  it("keeps the library view's refusals, with their reasons", () => {
    const assembled = assembleQqStickerCandidates({
      assets: [
        { id: "off", enabled: false, available: true, collectionIds: ["c1"] },
        { id: "elsewhere", enabled: true, available: true, collectionIds: ["c2"] },
        { id: "gone", enabled: true, available: false, collectionIds: ["c1"] },
        { id: "free", enabled: true, available: true, collectionIds: [] },
      ],
      authorizedCollectionIds: ["c1"],
      usage: [],
      recentAvoidCount: 0,
      nowSeconds: 1000,
    });
    expect(assembled.candidates).toEqual([]);
    expect(assembled.rejected).toEqual([
      { assetId: "off", reason: "disabled" },
      { assetId: "elsewhere", reason: "no_authorized_collection" },
      { assetId: "gone", reason: "file_unavailable" },
      { assetId: "free", reason: "no_authorized_collection" },
    ]);
  });

  it("refuses malformed input instead of assembling something plausible", () => {
    const base = {
      assets: [],
      authorizedCollectionIds: [],
      usage: [],
      recentAvoidCount: 0,
      nowSeconds: 1000,
    };
    expect(() => assembleQqStickerCandidates({ ...base, nowSeconds: -1 })).toThrow(TypeError);
    expect(() => assembleQqStickerCandidates({ ...base, recentAvoidCount: 1.5 })).toThrow(
      TypeError,
    );
    expect(() => assembleQqStickerCandidates({ ...base, assets: [{ id: "a" }] })).toThrow(
      TypeError,
    );
    expect(() => assembleQqStickerCandidates({ ...base, extra: 1 })).toThrow(TypeError);
  });
});

describe("how long ago, and how recent", () => {
  const one = [{ id: "a", enabled: true, available: true, collectionIds: ["c1"] }];

  it("turns a last-used instant into an age", () => {
    const assembled = assembleQqStickerCandidates({
      assets: one,
      authorizedCollectionIds: ["c1"],
      usage: [{ assetId: "a", lastSentAtSeconds: 700, sent: 1 }],
      recentAvoidCount: 0,
      nowSeconds: 1000,
    });
    expect(assembled.candidates[0]?.lastUsedSecondsAgo).toBe(300);
  });

  it("floors an instant ahead of now at zero, because a negative age is not a smaller number", () => {
    // The caller's clock disagreeing with itself. 0 reads "just used", so §9.3's hard interval
    // refuses — the conservative direction — where a negative age is a shape the contract rejects.
    const assembled = assembleQqStickerCandidates({
      assets: one,
      authorizedCollectionIds: ["c1"],
      usage: [{ assetId: "a", lastSentAtSeconds: 5000, sent: 1 }],
      recentAvoidCount: 0,
      nowSeconds: 1000,
    });
    expect(assembled.candidates[0]?.lastUsedSecondsAgo).toBe(0);
  });

  it("counts the recent window in distinct stickers, not in sends", () => {
    const assets = [
      { id: "a", enabled: true, available: true, collectionIds: ["c1"] },
      { id: "b", enabled: true, available: true, collectionIds: ["c1"] },
    ];
    // `a` was sent five times, `b` once. A window of one recent sticker is `a` alone: the soft rule
    // is about variety seen, and the repetition of `a` is the hard interval's business.
    const assembled = assembleQqStickerCandidates({
      assets,
      authorizedCollectionIds: ["c1"],
      usage: [
        { assetId: "a", lastSentAtSeconds: 900, sent: 5 },
        { assetId: "b", lastSentAtSeconds: 800, sent: 1 },
      ],
      recentAvoidCount: 1,
      nowSeconds: 1000,
    });
    expect(assembled.candidates.map((entry) => [entry.id, entry.recentlyUsed])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("has nobody recent when the soft rule is off", () => {
    const assembled = assembleQqStickerCandidates({
      assets: one,
      authorizedCollectionIds: ["c1"],
      usage: [{ assetId: "a", lastSentAtSeconds: 900, sent: 1 }],
      recentAvoidCount: 0,
      nowSeconds: 1000,
    });
    // Off is not "nothing was used": the age is still reported.
    expect(assembled.candidates[0]?.recentlyUsed).toBe(false);
    expect(assembled.candidates[0]?.lastUsedSecondsAgo).toBe(100);
  });

  it("ignores history for an asset the library no longer offers", () => {
    // A disabled or deleted-from-the-collection asset keeps its ledger rows; the history must not
    // resurrect it as a candidate, and must not fail either.
    const assembled = assembleQqStickerCandidates({
      assets: [],
      authorizedCollectionIds: ["c1"],
      usage: [{ assetId: "gone", lastSentAtSeconds: 900, sent: 3 }],
      recentAvoidCount: 5,
      nowSeconds: 1000,
    });
    expect(assembled.candidates).toEqual([]);
    expect(assembled.rejected).toEqual([]);
  });
});

describe("the selection a scheme and a conversation produce", () => {
  const available = () => true;

  it("offers only what the scheme's authorized collections reach", () => {
    const h = tracked();
    try {
      const authorized = createQqStickerCollection(h.orm, { name: "常用" });
      const other = createQqStickerCollection(h.orm, { name: "节日" });
      const inside = asset(h.orm, [authorized.id]);
      const outside = asset(h.orm, [other.id]);
      setQqStickerEnabled(h.orm, inside.id, true);
      setQqStickerEnabled(h.orm, outside.id, true);
      const scheme = createQqScheme(h.orm, {
        name: "只用一个集合",
        stickerCollections: [authorized.id],
      });
      const selection = qqStickerSelectionForScheme(h.orm, {
        schemeId: scheme.id,
        scope: scope(),
        counts: ["confirmed"],
        nowSeconds: 1000,
        isAvailable: available,
      });
      expect(selection.candidates.map((entry) => entry.id)).toEqual([inside.id]);
      expect(selection.rejected).toEqual([
        { assetId: outside.id, reason: "no_authorized_collection" },
      ]);
    } finally {
      h.business.close();
    }
  });

  it("still refuses an enabled asset the user has not turned on", () => {
    const h = tracked();
    try {
      const collection = createQqStickerCollection(h.orm, { name: "常用" });
      const hidden = asset(h.orm, [collection.id]);
      const scheme = createQqScheme(h.orm, {
        name: "未启用",
        stickerCollections: [collection.id],
      });
      const selection = qqStickerSelectionForScheme(h.orm, {
        schemeId: scheme.id,
        scope: scope(),
        counts: ["confirmed"],
        nowSeconds: 1000,
        isAvailable: available,
      });
      expect(selection.candidates).toEqual([]);
      expect(selection.rejected).toEqual([{ assetId: hidden.id, reason: "disabled" }]);
      // §9.1's 用户审核 sits between import and use, and a reader is not a place to skip it: the
      // selection must leave the row exactly as it found it.
      expect(readQqStickerAsset(h.orm, hidden.id)?.enabled).toBe(false);
    } finally {
      h.business.close();
    }
  });

  it("reports an unreadable copy as file_unavailable rather than offering it", () => {
    const h = tracked();
    try {
      const collection = createQqStickerCollection(h.orm, { name: "常用" });
      const broken = asset(h.orm, [collection.id]);
      setQqStickerEnabled(h.orm, broken.id, true);
      const scheme = createQqScheme(h.orm, {
        name: "缺文件",
        stickerCollections: [collection.id],
      });
      const selection = qqStickerSelectionForScheme(h.orm, {
        schemeId: scheme.id,
        scope: scope(),
        counts: ["confirmed"],
        nowSeconds: 1000,
        isAvailable: () => false,
      });
      expect(selection.candidates).toEqual([]);
      expect(selection.rejected).toEqual([{ assetId: broken.id, reason: "file_unavailable" }]);
    } finally {
      h.business.close();
    }
  });

  it("reads the repetition rules and the ceiling from the same scheme", () => {
    const h = tracked();
    try {
      const collection = createQqStickerCollection(h.orm, { name: "常用" });
      const sticker = asset(h.orm, [collection.id]);
      setQqStickerEnabled(h.orm, sticker.id, true);
      const scheme = createQqScheme(h.orm, {
        name: "慢速方案",
        stickerCollections: [collection.id],
        stickers: { sticker_min_repeat_minutes: 10, sticker_recent_avoid_count: 5 },
        rhythm: { ...QQ_RHYTHM_DEFAULT, max_sticker_count: 3 },
      });
      const selection = qqStickerSelectionForScheme(h.orm, {
        schemeId: scheme.id,
        scope: scope(),
        counts: ["confirmed"],
        nowSeconds: 1000,
        isAvailable: available,
      });
      // Minutes become seconds in one place (`qqStickerDedupPolicy`), and the ceiling is the
      // rhythm group's — pairing them here is what keeps a caller from mixing two schemes.
      expect(selection.minRepeatSeconds).toBe(600);
      expect(selection.avoidRecent).toBe(true);
      expect(selection.maxStickerCount).toBe(3);
    } finally {
      h.business.close();
    }
  });

  it("keeps the repetition history inside one conversation", () => {
    const h = tracked();
    try {
      const collection = createQqStickerCollection(h.orm, { name: "常用" });
      const sticker = asset(h.orm, [collection.id]);
      setQqStickerEnabled(h.orm, sticker.id, true);
      const scheme = createQqScheme(h.orm, {
        name: "按群独立",
        stickerCollections: [collection.id],
      });
      used(h.orm, { assetId: sticker.id, at: 900 });
      const here = qqStickerSelectionForScheme(h.orm, {
        schemeId: scheme.id,
        scope: scope(),
        counts: ["confirmed"],
        nowSeconds: 1000,
        isAvailable: available,
      });
      const elsewhere = qqStickerSelectionForScheme(h.orm, {
        schemeId: scheme.id,
        scope: scope({ peerId: "20002" }),
        counts: ["confirmed"],
        nowSeconds: 1000,
        isAvailable: available,
      });
      expect(here.candidates[0]?.lastUsedSecondsAgo).toBe(100);
      expect(here.candidates[0]?.recentlyUsed).toBe(true);
      // §9.3: 历史按群独立. Another group has seen nothing.
      expect(elsewhere.candidates[0]?.lastUsedSecondsAgo).toBeNull();
      expect(elsewhere.candidates[0]?.recentlyUsed).toBe(false);
    } finally {
      h.business.close();
    }
  });

  it("leaves 'which results count as used' to the caller (U13)", () => {
    const h = tracked();
    try {
      const collection = createQqStickerCollection(h.orm, { name: "常用" });
      const sticker = asset(h.orm, [collection.id]);
      setQqStickerEnabled(h.orm, sticker.id, true);
      const scheme = createQqScheme(h.orm, {
        name: "未决计数",
        stickerCollections: [collection.id],
      });
      // An outcome nobody can vouch for: the platform may or may not have delivered it.
      used(h.orm, { assetId: sticker.id, at: 900, result: "unknown" });
      const confirmedOnly = qqStickerSelectionForScheme(h.orm, {
        schemeId: scheme.id,
        scope: scope(),
        counts: ["confirmed"],
        nowSeconds: 1000,
        isAvailable: available,
      });
      const countingUnknown = qqStickerSelectionForScheme(h.orm, {
        schemeId: scheme.id,
        scope: scope(),
        counts: ["confirmed", "unknown"],
        nowSeconds: 1000,
        isAvailable: available,
      });
      expect(confirmedOnly.candidates[0]?.lastUsedSecondsAgo).toBeNull();
      expect(countingUnknown.candidates[0]?.lastUsedSecondsAgo).toBe(100);
    } finally {
      h.business.close();
    }
  });

  it("treats a missing scheme as missing, not as an empty library", () => {
    const h = tracked();
    try {
      expect(() =>
        qqStickerSelectionForScheme(h.orm, {
          schemeId: "00000000-0000-4000-8000-0000000000ff",
          scope: scope(),
          counts: ["confirmed"],
          nowSeconds: 1000,
          isAvailable: available,
        }),
      ).toThrow();
    } finally {
      h.business.close();
    }
  });
});
