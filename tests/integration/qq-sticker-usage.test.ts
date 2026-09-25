// P4g: which sticker a conversation has already seen (ADR0018, §9.3).
//
// §9.3's two repetition rules are "同一素材最短重复间隔" and "最近几次表情尽量避开", and both say
// the history is per conversation ("历史按群独立"). The send ledger recorded that a sticker went
// out but never WHICH asset, so that history could not be computed at all — this round adds the
// column and the read that answers the question.
//
// Two boundaries are deliberately held here:
//
//   * the send contract requires a sticker part to name its asset (a part that cannot name one
//     would silently drop out of the history), and forbids a text part from naming one;
//   * WHICH part results count as "used" is U13 and undecided, so the query takes them as an
//     argument instead of choosing. A failure that may or may not have been delivered is exactly
//     the case §8.2 says not to decide on its behalf.

import { describe, expect, it } from "bun:test";
import type { QqConversationScope } from "../../src/server/db/qq-observation-repository";
import { qqStickerUsageByConversation, recordQqSend } from "../../src/server/db/qq-send-repository";
import { ensureDefaults, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { qqSendSummary } from "../../src/server/services/qq-output-contract";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_AGENT_ID = "00000000-0000-0000-0000-000000000002";
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  seedSticker(business.orm, FIRST);
  seedSticker(business.orm, SECOND);
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

describe("a sticker part must name the asset it carried", () => {
  it("accepts a sticker with an id and a text part with none", () => {
    expect(
      qqSendSummary({
        parts: [
          { kind: "text", result: "confirmed", messageId: "m1", stickerId: null },
          { kind: "sticker", result: "confirmed", messageId: "m2", stickerId: FIRST },
        ],
      }).outcome,
    ).toBe("sent");
  });

  it("refuses a sticker part that cannot say which asset it was", () => {
    // Without the id the send would be invisible to §9.3, which is the one thing this column
    // exists for — so it is refused at the contract, not discovered later as a missing history.
    expect(() =>
      qqSendSummary({ parts: [{ kind: "sticker", result: "failed", messageId: null }] }),
    ).toThrow(TypeError);
    expect(() =>
      qqSendSummary({
        parts: [{ kind: "sticker", result: "failed", messageId: null, stickerId: null }],
      }),
    ).toThrow(TypeError);
  });

  it("refuses a text part that names a sticker", () => {
    expect(() =>
      qqSendSummary({
        parts: [{ kind: "text", result: "confirmed", messageId: "m1", stickerId: FIRST }],
      }),
    ).toThrow(TypeError);
  });
});

describe("the record keeps the asset, not just the fact that a sticker went out", () => {
  it("stores the asset id of every sticker part", () => {
    const h = setup();
    try {
      recordQqSend(h.orm, {
        scope: scope(),
        kind: "direct_reply",
        sentAtSeconds: 500,
        text: "看这个",
        parts: [
          { kind: "text", result: "confirmed", messageId: "m1", stickerId: null },
          { kind: "sticker", result: "failed", messageId: null, stickerId: SECOND },
        ],
      });
      const parts = h.orm.select().from(schema.qqSendPart).all();
      expect(parts.map((part) => [part.partKind, part.stickerId]).sort()).toEqual([
        ["sticker", SECOND],
        ["text", null],
      ]);
    } finally {
      h.business.close();
    }
  });

  it("refuses a text part carrying a sticker id even when the repository is bypassed", () => {
    const h = setup();
    try {
      recordQqSend(h.orm, {
        scope: scope(),
        kind: "direct_reply",
        sentAtSeconds: 500,
        text: "只有文字",
        parts: [{ kind: "text", result: "confirmed", messageId: "m1", stickerId: null }],
      });
      expect(() => h.db.run("UPDATE qq_send_part SET sticker_id = 'x'")).toThrow();
    } finally {
      h.business.close();
    }
  });
});

describe("the per-conversation history is per conversation", () => {
  it("reports the last time each sticker was seen, newest first", () => {
    const h = setup();
    try {
      const send = (assetId: string, sentAtSeconds: number) =>
        recordQqSend(h.orm, {
          scope: scope(),
          kind: "chiming_in",
          sentAtSeconds,
          text: null,
          parts: [
            {
              kind: "sticker",
              result: "confirmed",
              messageId: `m${sentAtSeconds}`,
              stickerId: assetId,
            },
          ],
        });
      send(FIRST, 100);
      send(SECOND, 300);
      send(FIRST, 500);
      expect(qqStickerUsageByConversation(h.orm, scope(), ["confirmed"])).toEqual([
        { assetId: FIRST, lastSentAtSeconds: 500, sent: 2 },
        { assetId: SECOND, lastSentAtSeconds: 300, sent: 1 },
      ]);
      // Another conversation's history must not leak in: §9.3's "各群独立" is what makes the
      // repetition rules per group rather than global.
      expect(
        qqStickerUsageByConversation(h.orm, scope({ peerId: "20099" }), ["confirmed"]),
      ).toEqual([]);
      expect(
        qqStickerUsageByConversation(h.orm, scope({ agentId: OTHER_AGENT_ID }), ["confirmed"]),
      ).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("includes a part only when the caller says that outcome counts", () => {
    const h = setup();
    try {
      recordQqSend(h.orm, {
        scope: scope(),
        kind: "chiming_in",
        sentAtSeconds: 100,
        text: null,
        parts: [{ kind: "sticker", result: "confirmed", messageId: "m1", stickerId: FIRST }],
      });
      recordQqSend(h.orm, {
        scope: scope(),
        kind: "chiming_in",
        sentAtSeconds: 200,
        text: null,
        parts: [{ kind: "sticker", result: "unknown", messageId: null, stickerId: SECOND }],
      });
      // §8.2 / U13: whether an unknown fate means "used" is not decided, so the caller chooses and
      // the storage does not guess on its behalf.
      expect(
        qqStickerUsageByConversation(h.orm, scope(), ["confirmed"]).map((entry) => entry.assetId),
      ).toEqual([FIRST]);
      expect(
        qqStickerUsageByConversation(h.orm, scope(), ["confirmed", "unknown"]).map(
          (entry) => entry.assetId,
        ),
      ).toEqual([SECOND, FIRST]);
      expect(qqStickerUsageByConversation(h.orm, scope(), [])).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("ignores a sticker part with no asset id instead of inventing one", () => {
    const h = setup();
    try {
      recordQqSend(h.orm, {
        scope: scope(),
        kind: "chiming_in",
        sentAtSeconds: 100,
        text: "有话说",
        parts: [{ kind: "text", result: "confirmed", messageId: "m1", stickerId: null }],
      });
      // A part written before this round genuinely has no id — the weaker fact is what the ledger
      // has, and the history reports nothing rather than attributing it to some asset.
      h.db.run(
        "INSERT INTO qq_send_part (send_id, part_index, part_kind, result, platform_message_id, sticker_id) SELECT id, 1, 'sticker', 'confirmed', 'm2', NULL FROM qq_send_log",
      );
      expect(qqStickerUsageByConversation(h.orm, scope(), ["confirmed"])).toEqual([]);
    } finally {
      h.business.close();
    }
  });
});
