import { z } from "zod";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { BuiltInAction } from "../agent/built-in-actions";
import { schemeStickerCollectionIds } from "../db/qq-scheme-repository";
import { listQqStickerAssets } from "../db/qq-sticker-repository";
import type { Orm } from "../db/repositories";
import {
  type QqStickerSelectionRequest,
  qqStickerSelectionForScheme,
} from "./qq-sticker-candidates";
import { qqStickerUsable } from "./qq-sticker-contract";

export function currentQqStickerCatalog(orm: Orm, request: QqStickerSelectionRequest) {
  const selection = qqStickerSelectionForScheme(orm, request);
  const usable = new Set(
    selection.maxStickerCount > 0
      ? selection.candidates
          .filter(
            (candidate) =>
              qqStickerUsable(candidate, { minRepeatSeconds: selection.minRepeatSeconds }).kind ===
              "usable",
          )
          .map((candidate) => candidate.id)
      : [],
  );
  const assets = listQqStickerAssets(orm)
    .filter((asset) => usable.has(asset.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    selection,
    assets,
    state:
      schemeStickerCollectionIds(orm, request.schemeId).length === 0
        ? ("disabled" as const)
        : assets.length
          ? ("available" as const)
          : ("no_candidates" as const),
  };
}

const SearchSchema = z.strictObject({
  query: z
    .string()
    .optional()
    .describe(
      "Keywords in name, description or tags; empty browses all authorized available assets.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Requested page size; actual results also fit the model context budget."),
  cursor: z
    .string()
    .nullable()
    .optional()
    .describe("nextCursor from the previous page with the same query."),
});

/** Scoped discovery is read-only. The model never supplies an account, scheme or permission. */
export function createQqStickerSearch(options: {
  orm: Orm;
  request: () => QqStickerSelectionRequest;
  assertCurrent: () => void;
  fit: (
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<(value: unknown, sources: readonly SourceRef[]) => boolean>;
}): BuiltInAction {
  return {
    description: {
      name: "sticker.search",
      capability: "sticker.read",
      description:
        "Search authorized usable stickers; empty query browses. Results fit context and paginate. Use returned IDs; prefer recentlyUsed=false.",
      parameters: z.toJSONSchema(SearchSchema),
    },
    async execute(arguments_, { signal }) {
      signal.throwIfAborted();
      options.assertCurrent();
      const input = SearchSchema.parse(arguments_);
      const catalog = currentQqStickerCatalog(options.orm, options.request());
      const terms = (input.query ?? "").toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const matches = catalog.assets.filter((asset) => {
        const text = [asset.name, asset.description ?? "", ...asset.tags]
          .join(" ")
          .toLocaleLowerCase();
        return (
          terms.every((term) => text.includes(term)) &&
          (!input.cursor || asset.id.localeCompare(input.cursor) > 0)
        );
      });
      const value: {
        status: typeof catalog.state | "budget_exhausted";
        items: {
          id: string;
          name: string;
          description: string | null;
          tags: readonly string[];
          recentlyUsed: boolean;
        }[];
        nextCursor: string | null;
      } = { status: catalog.state, items: [], nextCursor: null };
      const sources: SourceRef[] = [];
      const fits = await options.fit(arguments_, signal);
      if (!fits(value, sources)) throw new Error("STICKER_SEARCH_CONTEXT_LIMIT");
      const limit = input.limit ?? 12;
      let skippedForBudget = false;
      for (const [index, asset] of matches.entries()) {
        const item = {
          id: asset.id,
          name: asset.name,
          description: asset.description,
          tags: asset.tags,
          recentlyUsed:
            catalog.selection.candidates.find((candidate) => candidate.id === asset.id)
              ?.recentlyUsed ?? false,
        };
        const ref = { kind: "qq_sticker", id: asset.id, revision: asset.updatedAt };
        const nextCursor = index < matches.length - 1 ? asset.id : null;
        if (!fits({ ...value, items: [...value.items, item], nextCursor }, [...sources, ref])) {
          // A large first result must not hide smaller authorized assets after it.
          // Keep every disclosed item intact; a nonempty page still ends at its last ID,
          // so the next page can reconsider the remaining candidates with an empty result.
          if (value.items.length) break;
          skippedForBudget = true;
          continue;
        }
        value.items.push(item);
        sources.push(ref);
        value.nextCursor = nextCursor;
        if (value.items.length >= limit) break;
      }
      if (!value.items.length && skippedForBudget) value.status = "budget_exhausted";
      if (!fits(value, sources)) throw new Error("STICKER_SEARCH_CONTEXT_LIMIT");
      signal.throwIfAborted();
      options.assertCurrent();
      return { value, sources };
    },
  };
}
