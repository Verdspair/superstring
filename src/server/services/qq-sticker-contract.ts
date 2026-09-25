// Sticker library rules for QQ (ADR0018 P4d).
//
// §9 lists the library as part of this version's output path, and two of its rules are the
// ones an implementation gets wrong on its own:
//
//   * authorization follows the COLLECTION, not the asset — an asset that merely exists is
//     not selectable, and "新增并启用素材可用于旧方案旧绑定" only holds for assets that are
//     inside a collection the scheme already authorized; and
//   * one asset reachable through two authorized collections is still ONE candidate.
//     §9.1 forbids multi-membership from becoming extra weight in the draw, so the second
//     row for the same asset must not count twice.
//
// Both are facts about a library snapshot, so they are pinned here while the storage that
// would produce that snapshot waits for its own migration. Nothing here imports, disables or
// deletes anything: this module answers "what may be used", not "what happens to a file".
//
// §9.3's values are now decided and stored on the scheme (0020). They still arrive as
// parameters rather than being read from a table here, because this module must stay pure;
// `qqStickerDedupPolicy` is the one place that turns the stored group into them.

import { z } from "zod";
import {
  QqSchemeStickerCollectionsSchema,
  type QqSchemeStickers,
  QqSchemeStickersSchema,
} from "../../shared/contracts/qq";

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ sticker contract input");
  return result.data;
}

/** Validate a stored or assembled repetition group; storage maps rows through this. */
export function parseQqSchemeStickers(input: unknown): QqSchemeStickers {
  return Object.freeze(parse(QqSchemeStickersSchema, input));
}

/**
 * Validate a scheme's authorized collections (P4g); storage maps rows through this.
 *
 * The set is normalized to a deduplicated, sorted array because it IS a set: two rows naming the
 * same collection are one authorization, and §9.1's "同一素材只算一个候选" rests on that. Sorting
 * here rather than at each reader also means two schemes with the same authorizations compare
 * equal, so a save that only reorders them is not a change.
 */
export function parseQqSchemeStickerCollections(input: unknown): readonly string[] {
  const value = parse(QqSchemeStickerCollectionsSchema, input);
  return Object.freeze([...new Set(value.collection_ids)].sort());
}

const SECONDS_PER_MINUTE = 60;

export interface QqStickerDedup {
  /** §9.3's hard interval in seconds, or null when the scheme sets no minimum spacing. */
  readonly minRepeatSeconds: number | null;
  /** How many recent utterances count as recent; 0 when the soft rule is off. */
  readonly recentAvoidCount: number;
  /** The soft rule as the output plan wants it: a switch, not a count. */
  readonly avoidRecent: boolean;
}

/**
 * Turn the scheme's stored repetition rules into the two inputs the output plan takes.
 *
 * This exists because the stored unit is minutes and the plan's unit is seconds, and because
 * §9.3's "尽量避开" is a count of recent utterances while §8.1's plan only needs to know
 * whether to prefer unused stickers. Doing that conversion at each call site is how the two
 * halves drift apart — the same reason `token-estimate.ts` is the only estimator.
 *
 * `0` keeps its meaning across the conversion: minutes 0 → no minimum spacing (null, not
 * zero seconds, because those are the same thing only if the caller reads them the same way),
 * and count 0 → the soft rule is off.
 */
export function qqStickerDedupPolicy(input: unknown): QqStickerDedup {
  const value = parseQqSchemeStickers(input);
  return Object.freeze({
    minRepeatSeconds:
      value.sticker_min_repeat_minutes === 0
        ? null
        : value.sticker_min_repeat_minutes * SECONDS_PER_MINUTE,
    recentAvoidCount: value.sticker_recent_avoid_count,
    avoidRecent: value.sticker_recent_avoid_count > 0,
  });
}

/** Why an asset in the library is not selectable. Diagnostics only — nothing acts on it. */
export type QqStickerLibraryRejection =
  | "duplicate"
  | "disabled"
  | "file_unavailable"
  | "no_authorized_collection";

export interface QqStickerLibraryView {
  readonly candidates: readonly {
    readonly assetId: string;
    /** Authorized collections this asset is reachable through; any one is enough (§9.1). */
    readonly viaCollectionIds: readonly string[];
  }[];
  readonly rejected: readonly {
    readonly assetId: string;
    readonly reason: QqStickerLibraryRejection;
  }[];
}

const LibraryAssetSchema = z.strictObject({
  id: z.string().min(1),
  /** §9.1: an import saves an in-app copy and leaves it DISABLED until the user enables it. */
  enabled: z.boolean(),
  /** The in-app copy is present and readable right now. */
  available: z.boolean(),
  /** §9.1: membership is not exclusive — one asset may sit in several collections. */
  collectionIds: z.array(z.string().min(1)),
});

/**
 * Which assets a scheme may draw from, and why the others were left out.
 *
 * The caller's order is preserved, because this decides membership, not preference: which
 * sticker fits the conversation is a judgement made later, against the sentence being sent.
 */
export function resolveQqStickerLibrary(input: unknown): QqStickerLibraryView {
  const value = parse(
    z.strictObject({
      assets: z.array(LibraryAssetSchema),
      authorizedCollectionIds: z.array(z.string().min(1)),
    }),
    input,
  );
  const authorized = new Set(value.authorizedCollectionIds);
  const seen = new Set<string>();
  const candidates: { assetId: string; viaCollectionIds: string[] }[] = [];
  const rejected: { assetId: string; reason: QqStickerLibraryRejection }[] = [];

  for (const asset of value.assets) {
    // A second row for an asset already seen adds nothing. Reporting it as `duplicate`
    // instead of silently ignoring it is what keeps "two collections = two chances" from
    // reappearing through a different door (a join that returns both memberships).
    if (seen.has(asset.id)) {
      rejected.push({ assetId: asset.id, reason: "duplicate" });
      continue;
    }
    seen.add(asset.id);
    if (!asset.enabled) {
      rejected.push({ assetId: asset.id, reason: "disabled" });
      continue;
    }
    if (!asset.available) {
      rejected.push({ assetId: asset.id, reason: "file_unavailable" });
      continue;
    }
    const via = asset.collectionIds.filter((id) => authorized.has(id));
    if (via.length === 0) {
      rejected.push({ assetId: asset.id, reason: "no_authorized_collection" });
      continue;
    }
    candidates.push({ assetId: asset.id, viaCollectionIds: via });
  }
  return Object.freeze({
    candidates: Object.freeze(candidates.map((entry) => Object.freeze(entry))),
    rejected: Object.freeze(rejected.map((entry) => Object.freeze(entry))),
  });
}

/**
 * One candidate, as it stands at the moment a reply is assembled.
 *
 * `lastUsedSecondsAgo` is deliberately "how long ago", not "when": the module has no clock,
 * so a caller that wants a repeat interval must supply the elapsed time itself.
 */
export const QqStickerCandidateSchema = z.strictObject({
  id: z.string().min(1),
  /** §9.1 停用素材: globally barred from selection AND from an unsubmitted send. */
  enabled: z.boolean(),
  /** §9.1 授权随集合内容: true exactly when it is inside a scheme-authorized collection. */
  authorized: z.boolean(),
  /** §8.1-5: the candidate's file must be usable now. */
  available: z.boolean(),
  /** Seconds since this sticker was last used in this conversation, or null if never. */
  lastUsedSecondsAgo: z.number().int().nonnegative().nullable(),
  /** §9.3's soft avoidance: is it among the last few used here? */
  recentlyUsed: z.boolean(),
});
export type QqStickerCandidate = Readonly<z.output<typeof QqStickerCandidateSchema>>;

export type QqStickerRejection = "disabled" | "not_authorized" | "file_unavailable" | "too_soon";
export type QqStickerUsability =
  | { readonly kind: "usable" }
  | { readonly kind: "rejected"; readonly reason: QqStickerRejection };

export function parseQqStickerCandidate(input: unknown): QqStickerCandidate {
  return Object.freeze(parse(QqStickerCandidateSchema, input));
}

/**
 * May this sticker be used right now?
 *
 * `minRepeatSeconds` is §9.3's hard rule ("同一素材最短重复间隔") and is nullable because a
 * scheme may set no minimum spacing at all: with null there is no configured limit, and an
 * asset that was never used passes either way. `recentlyUsed` is NOT consulted here —
 * "最近几次尽量避开" is a soft preference (§9.3), so refusing a sticker over it would turn an
 * intention into a prohibition.
 */
export function qqStickerUsable(candidate: unknown, policy: unknown): QqStickerUsability {
  const value = parse(QqStickerCandidateSchema, candidate);
  const { minRepeatSeconds } = parse(
    z.strictObject({ minRepeatSeconds: z.number().int().nonnegative().nullable() }),
    policy,
  );
  const rejected = (reason: QqStickerRejection): QqStickerUsability =>
    Object.freeze({ kind: "rejected", reason });
  if (!value.enabled) return rejected("disabled");
  if (!value.authorized) return rejected("not_authorized");
  if (!value.available) return rejected("file_unavailable");
  if (
    minRepeatSeconds !== null &&
    value.lastUsedSecondsAgo !== null &&
    value.lastUsedSecondsAgo < minRepeatSeconds
  ) {
    return rejected("too_soon");
  }
  return Object.freeze({ kind: "usable" });
}

/**
 * Read the sticker stage's answer: one candidate number, or 0 for "none" (P4i).
 *
 * A bare integer rather than JSON, because the scheme's editable default prompt already promises
 * "只输出候选编号" and the program-owned constraint line adds the 0 sentinel — a JSON shape would
 * contradict the text the user can see and edit.
 *
 * Everything that is not a whole number in 1..`candidateCount` becomes "no sticker". That is the
 * safe direction: a number that cannot be read would otherwise be turned into a guess, and
 * §8.1-5 forbids selecting a candidate the caller never offered, so an out-of-range answer is
 * refused rather than clamped. The reasons are diagnostics (§10); none of them is permission.
 */
export type QqStickerChoice =
  | { readonly kind: "picked"; readonly index: number }
  | {
      readonly kind: "none";
      readonly reason: "declined" | "empty" | "out_of_range" | "unreadable";
    };

export function qqStickerChoice(raw: unknown, candidateCount: unknown): QqStickerChoice {
  const count = parse(z.number().int().positive(), candidateCount);
  if (typeof raw !== "string") return Object.freeze({ kind: "none", reason: "unreadable" });
  const text = raw.trim();
  if (text === "") return Object.freeze({ kind: "none", reason: "empty" });
  if (!/^\d+$/.test(text)) return Object.freeze({ kind: "none", reason: "unreadable" });
  const value = Number(text);
  if (value === 0) return Object.freeze({ kind: "none", reason: "declined" });
  if (value > count) return Object.freeze({ kind: "none", reason: "out_of_range" });
  return Object.freeze({ kind: "picked", index: value });
}

/**
 * §9.1's destructive-looking operations, stated as what they actually do, so a later
 * "clean up the library" change has one place to contradict rather than a field to guess at.
 *
 * 移出集合 only removes that membership (other collections may still authorize the asset);
 * 停用 bars selection globally and also intercepts a send that was prepared before it; and
 * nothing here deletes a copy or an unrelated collection — §9.1 says deletion is undecided,
 * so a default of "silently tidy up" would be inventing a decision.
 */
export const QQ_STICKER_LIBRARY_POLICY = Object.freeze({
  removingFromCollectionRemovesMembershipOnly: true,
  disablingBlocksSelection: true,
  disablingBlocksUnsubmittedSend: true,
  deletingCopiesAutomatically: false,
  deletingOrphanAssetsAutomatically: false,
});
