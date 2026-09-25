// Which stickers one reply may draw from, as the stored state sees it (ADR0018 P4h, §9.1/§9.3).
//
// Three modules each knew a piece of this and none could see the whole: the scheme holds which
// collections it authorizes (0022) and how fast a sticker may come back (0020); the library holds
// which assets exist, whether they are enabled and where they sit; the send ledger holds what this
// conversation has already seen. `resolveQqStickerLibrary` takes the authorized set as an INPUT, and
// nothing produced that input — so the library was complete, tested, and unusable by any scheme.
// This module is that join, and it exists so the join happens once.
//
// Three seams stay exactly where they were:
//
//   * It does not decide whether a candidate may be used. `qqStickerUsable` and `planQqOutput` do
//     that, and they stay pure. What is handed over here is the FACTS (enabled, available,
//     authorized, how long ago, among the recent), restated from storage rather than asserted from
//     the membership check — so a candidate that should never have been emitted is still refused
//     downstream rather than taken on faith.
//   * It does not answer U13. Whether a failed or unknown send counts as "this conversation has
//     seen it" is a CALLER parameter with no default, exactly as it is in
//     `qqStickerUsageByConversation`; a default would be the answer.
//   * It does not read the clock. `nowSeconds` arrives from the caller, so §9.3's hard interval can
//     be checked at a chosen instant instead of against whatever the machine thinks today is.

import { z } from "zod";
import type { QqConversationScope } from "../db/qq-observation-repository";
import {
  readQqScheme,
  schemeRhythm,
  schemeStickerCollectionIds,
  schemeStickers,
} from "../db/qq-scheme-repository";
import { qqStickerUsageByConversation } from "../db/qq-send-repository";
import { type QqStickerAssetView, qqStickerLibrarySnapshot } from "../db/qq-sticker-repository";
import type { Orm } from "../db/repositories";
import { fail } from "../errors";
import type { QqSendPartResult } from "./qq-output-contract";
import {
  type QqStickerCandidate,
  type QqStickerLibraryRejection,
  qqStickerDedupPolicy,
  resolveQqStickerLibrary,
} from "./qq-sticker-contract";

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ sticker candidate input");
  return result.data;
}

const SecondsSchema = z.number().int().nonnegative();

const AssetSchema = z.strictObject({
  id: z.string().min(1),
  enabled: z.boolean(),
  available: z.boolean(),
  collectionIds: z.array(z.string().min(1)),
});

const UsageSchema = z.strictObject({
  assetId: z.string().min(1),
  lastSentAtSeconds: SecondsSchema,
  sent: z.number().int().nonnegative(),
});

const AssemblyInputSchema = z.strictObject({
  /** The whole library, as `qqStickerLibrarySnapshot` reports it. */
  assets: z.array(AssetSchema),
  /** The scheme's authorized collections, as `schemeStickerCollectionIds` reports them. */
  authorizedCollectionIds: z.array(z.string().min(1)),
  /** What this conversation has seen, as `qqStickerUsageByConversation` reports it. */
  usage: z.array(UsageSchema),
  /** §9.3's soft rule: how many of the most recently used stickers count as "recent". 0 = off. */
  recentAvoidCount: z.number().int().nonnegative(),
  nowSeconds: SecondsSchema,
});

export interface QqStickerCandidateAssembly {
  readonly candidates: readonly QqStickerCandidate[];
  readonly rejected: readonly {
    readonly assetId: string;
    readonly reason: QqStickerLibraryRejection;
  }[];
}

/**
 * Join the library, the scheme's authorization and this conversation's history into the candidates
 * a reply may consider.
 *
 * Two interpretations are pinned here rather than left to each caller, because both are the kind of
 * detail that two implementations get different answers to:
 *
 *   * §9.3's "最近几次" counts DISTINCT stickers, not sends. One sticker used five times back to
 *     back occupies one of the five, not all of them: the soft rule is about how much variety the
 *     conversation has seen, and the hard interval is already what handles "the same one again".
 *   * A ledger timestamp ahead of `nowSeconds` floors the age at 0 rather than going negative. That
 *     is the caller's clock disagreeing with itself, not a sticker used in the future; 0 reads
 *     "just used", which makes the hard interval refuse. A negative age is not a smaller number, it
 *     is a shape the candidate contract rejects outright.
 */
export function assembleQqStickerCandidates(input: unknown): QqStickerCandidateAssembly {
  const value = parse(AssemblyInputSchema, input);
  const library = resolveQqStickerLibrary({
    assets: value.assets,
    authorizedCollectionIds: value.authorizedCollectionIds,
  });
  const assetById = new Map(value.assets.map((asset) => [asset.id, asset]));
  const usageById = new Map(value.usage.map((entry) => [entry.assetId, entry]));

  // Ties broken by id so the same inputs always pick the same "recent" set: an unordered slice here
  // would make the soft rule — and any test of it — depend on row order.
  const recentIds = new Set(
    [...usageById.values()]
      .sort(
        (left, right) =>
          right.lastSentAtSeconds - left.lastSentAtSeconds ||
          left.assetId.localeCompare(right.assetId),
      )
      .slice(0, value.recentAvoidCount)
      .map((entry) => entry.assetId),
  );

  const candidates: QqStickerCandidate[] = [];
  for (const candidate of library.candidates) {
    const asset = assetById.get(candidate.assetId);
    // Every candidate comes from `assets`, so this is unreachable; asserting rather than forcing
    // keeps it from becoming a silent `undefined` if that ever stops being true.
    if (asset === undefined) throw new TypeError("Invalid QQ sticker candidate input");
    const seen = usageById.get(candidate.assetId);
    candidates.push(
      Object.freeze({
        id: candidate.assetId,
        enabled: asset.enabled,
        authorized: candidate.viaCollectionIds.length > 0,
        available: asset.available,
        lastUsedSecondsAgo:
          seen === undefined ? null : Math.max(0, value.nowSeconds - seen.lastSentAtSeconds),
        // With `recentAvoidCount` 0 no sticker is "recent" — that is the soft rule being off, not a
        // claim that nothing was used.
        recentlyUsed: recentIds.has(candidate.assetId),
      }),
    );
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    rejected: library.rejected,
  });
}

export interface QqStickerSelectionRequest {
  readonly schemeId: string;
  readonly scope: QqConversationScope;
  /**
   * Which part results mean "this conversation has seen that sticker".
   *
   * Required with no default: a failed or unknown send is U13 and is undecided, so choosing here
   * would answer it inside a reader.
   */
  readonly counts: readonly QqSendPartResult[];
  readonly nowSeconds: number;
  /** The copy store's owner answers this; this module never touches the filesystem. */
  readonly isAvailable: (asset: QqStickerAssetView) => boolean;
}

export interface QqStickerSelection {
  readonly candidates: readonly QqStickerCandidate[];
  readonly rejected: QqStickerCandidateAssembly["rejected"];
  /** §9.3's hard interval in seconds, or null when the scheme sets no minimum spacing. */
  readonly minRepeatSeconds: number | null;
  /** §9.3's soft rule as the plan wants it: a switch, not a count. */
  readonly avoidRecent: boolean;
  /** §8.1-4's per-reply ceiling (U01: default 1, max 3). */
  readonly maxStickerCount: number;
}

/**
 * The selection for one bound scheme in one conversation, read from storage.
 *
 * Everything `planQqOutput` needs about stickers comes out of this one call, so a caller cannot
 * pair a scheme's authorization with another scheme's ceiling or another conversation's history.
 * It reads only: no enablement, no send, no write.
 */
export function qqStickerSelectionForScheme(
  orm: Orm,
  request: QqStickerSelectionRequest,
): QqStickerSelection {
  const scheme = readQqScheme(orm, request.schemeId);
  if (scheme === null) fail("MEMORY_NOT_FOUND", "方案不存在", 404);
  const dedup = qqStickerDedupPolicy(schemeStickers(scheme));
  const assembled = assembleQqStickerCandidates({
    assets: qqStickerLibrarySnapshot(orm, request.isAvailable).assets,
    authorizedCollectionIds: schemeStickerCollectionIds(orm, request.schemeId),
    usage: qqStickerUsageByConversation(orm, request.scope, request.counts),
    recentAvoidCount: dedup.recentAvoidCount,
    nowSeconds: request.nowSeconds,
  });
  return Object.freeze({
    candidates: assembled.candidates,
    rejected: assembled.rejected,
    minRepeatSeconds: dedup.minRepeatSeconds,
    avoidRecent: dedup.avoidRecent,
    maxStickerCount: schemeRhythm(scheme).max_sticker_count,
  });
}
