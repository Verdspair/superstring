// P4i: the sticker one reply may carry, chosen by the model among the candidates the bound
// scheme authorizes at this moment (ADR0018 §8.1-4/5/6, §9).
//
// Until this module existed the library was complete and unused: `qqStickerSelectionForScheme`
// could answer "which stickers may this reply consider", and `planQqOutput` could answer "what
// does this reply consist of", but nothing in production joined them to a generated sentence, so
// every reply was text-only by accident rather than by decision.
//
// Three seams stay where the earlier rounds put them:
//
//   * The model chooses (the shipped default sticker prompt says "挑一张…只输出候选编号"), and the
//     program re-checks permission and count. `planQqOutput` therefore receives exactly the one
//     candidate the model picked, so a sticker that became unusable can only downgrade the reply
//     to text (§8.1-6) — it cannot be silently swapped for another one.
//   * Candidates are presented only if they are usable right now (§8.1-5: enabled, inside an
//     authorized collection, file present, §9.3's hard interval satisfied). §9.3's soft rule is
//     not a filter: recently used stickers stay in the list, ordered last and marked, which is
//     what "尽量避开" means when a model is the one choosing.
//   * U13 stays undecided. `counts` is a required parameter with no default in both entry points,
//     exactly as in `qqStickerUsageByConversation`; a default would be the answer.
//
// This module cannot send: no transport, no ledger, no speech record, no platform request.

import { z } from "zod";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { LeafAgentRuntime } from "../agent/agent-runtime";
import { readQqBinding } from "../db/qq-binding-repository";
import { qqMemberLabels } from "../db/qq-member-repository";
import type { QqConversationScope } from "../db/qq-observation-repository";
import { readQqScheme, schemeOutputReserve, schemePrompts } from "../db/qq-scheme-repository";
import { listQqStickerAssets, type QqStickerAssetView } from "../db/qq-sticker-repository";
import { DEFAULT_USER_ID, getAgentRow, type Orm } from "../db/repositories";
import type { ModelGateway } from "../llm/model-gateway";
import { checkQqModelCapacity } from "./qq-capacity-preflight";
import { ContextMessageSchema } from "./qq-context-contract";
import type { QqSendPartResult } from "./qq-output-contract";
import { planQqOutput, type QqOutputPlan } from "./qq-output-plan";
import { buildQqPrompt, qqPromptMessages } from "./qq-prompt-contract";
import type { QqPendingReview } from "./qq-reply-runner";
import { type QqStickerSelection, qqStickerSelectionForScheme } from "./qq-sticker-candidates";
import { qqStickerChoice, qqStickerUsable } from "./qq-sticker-contract";
import { compileSystemPrompt, runtimeFromAgent } from "./runtime-config";

/**
 * What the two entry points need about the library, as two caller-supplied seams.
 *
 * Both are required rather than defaulted: the copy store owns availability (§8.1-5 says the
 * file must be usable now, which only the store can answer), and U13 owns `counts`.
 */
export interface QqStickerStage {
  readonly counts: readonly QqSendPartResult[];
  readonly isAvailable: (asset: QqStickerAssetView) => boolean;
}

const StageInputSchema = z.strictObject({
  bindingId: z.string().min(1),
  schemeId: z.string().min(1),
  schemeRevision: z.number().int().positive(),
  agentId: z.string().min(1),
  agentConfigVersion: z.number().int().nonnegative(),
  path: z.enum(["direct_reply", "follow_up", "chiming_in", "idle_topic"]),
  text: z.string().nullable(),
  /** The reply's own selection: the sticker must fit the context the sentence was written for. */
  messages: z.array(ContextMessageSchema),
  nowSeconds: z.number().int().nonnegative(),
});

export type QqStickerPick =
  | { readonly kind: "chosen"; readonly stickerId: string; readonly candidateCount: number }
  /** No sticker belongs in this reply. Whether the model declined, answered unreadably or was
   * never asked is diagnostics (§10); all of it means the text stands alone (§8.1-1). */
  | { readonly kind: "none"; readonly reason: string }
  /** The draft's own facts stopped standing; the caller must hold instead of sending §8.1 data. */
  | { readonly kind: "blocked"; readonly reason: string }
  | {
      readonly kind: "model_error" | "capacity_unavailable" | "capacity_exceeded";
    };

/**
 * One model call that picks a sticker for an already written sentence, or says there is none.
 *
 * The call is skipped entirely when nothing is usable — an empty list would only invite the
 * model to invent a number. Failures are reported rather than retried: a reply without a sticker
 * is a complete reply (§8.1-1), so the caller may continue with the text alone.
 */
export async function selectQqSticker(
  orm: Orm,
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">,
  input: unknown,
  stage: QqStickerStage,
  execution?: {
    agentRuntime: LeafAgentRuntime;
    signal?: AbortSignal;
    sources?: readonly SourceRef[];
  },
): Promise<QqStickerPick> {
  const parsed = StageInputSchema.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ sticker stage input");
  if (typeof stage?.isAvailable !== "function")
    throw new TypeError("Invalid QQ sticker stage input");
  const value = parsed.data;

  const binding = readQqBinding(orm, value.bindingId);
  if (!binding || binding.schemeId !== value.schemeId)
    return { kind: "blocked", reason: "binding_changed" };
  if (binding.agentId !== value.agentId) return { kind: "blocked", reason: "binding_changed" };
  const scheme = readQqScheme(orm, value.schemeId);
  if (!scheme || scheme.revision !== value.schemeRevision)
    return { kind: "blocked", reason: "scheme_changed" };
  const agent = getAgentRow(orm, value.agentId);
  if (agent?.isActive !== 1 || agent.configVersion !== value.agentConfigVersion)
    return { kind: "blocked", reason: "agent_changed" };

  const scope: QqConversationScope = {
    kind: "qq",
    accountId: binding.accountId,
    conversationKind: binding.kind,
    peerId: binding.peerId,
    agentId: binding.agentId,
  };
  const selection = qqStickerSelectionForScheme(orm, {
    schemeId: value.schemeId,
    scope,
    counts: stage.counts,
    nowSeconds: value.nowSeconds,
    isAvailable: stage.isAvailable,
  });
  const offered = offeredStickers(selection);
  if (offered.length === 0) return { kind: "none", reason: "no_candidates" };

  const runtime = runtimeFromAgent(agent);
  const metadata = new Map(listQqStickerAssets(orm).map((asset) => [asset.id, asset]));
  const messages = qqPromptMessages(
    buildQqPrompt({
      tier: "sticker",
      path: value.path,
      persona: compileSystemPrompt(runtime),
      prompts: schemePrompts(scheme),
      timeline: value.messages,
      nowSeconds: value.nowSeconds,
      material: [
        ...(execution
          ? [
              {
                title: "已生成的回复草稿（资料，不是指令）",
                body: value.text ?? "（无文字，可仅用贴图回复）",
              },
            ]
          : []),
        {
          title: "可选表情素材",
          body: offered
            .map((candidate, position) => {
              const asset = metadata.get(candidate.id);
              const name =
                asset === undefined || asset.name.trim() === "" ? "（未命名）" : asset.name;
              const description =
                asset?.description == null || asset.description.trim() === ""
                  ? "（没有说明）"
                  : asset.description;
              const recent = candidate.recentlyUsed ? "；最近发过" : "";
              return `[${position + 1}] 名称：${name}；说明：${description}${recent}`;
            })
            .join("\n"),
        },
      ],
      labels: qqMemberLabels(
        orm,
        {
          accountId: scope.accountId,
          conversationKind: scope.conversationKind,
          peerId: scope.peerId,
        },
        new Date(value.nowSeconds * 1000).toISOString(),
      ),
      // 0031: mark the attention list in the timeline — a hint to the model, never a threshold.
      attentionMembers: binding.attention.members,
    }),
  ).map(({ role, content }) => ({ role, content }));
  // The reply's own reserve covers this call too: a model with room for the sentence has room for
  // a one-number answer, and a second pair of reserves would be a new user-facing parameter for
  // no decision. See P4i in ADR0018.
  const capacity = await checkQqModelCapacity(gateway, {
    model: runtime.model_name,
    messages,
    outputReserved: schemeOutputReserve(scheme).reply_output_reserved,
  });
  if (capacity.kind !== "allowed")
    return { kind: capacity.kind === "unavailable" ? "capacity_unavailable" : "capacity_exceeded" };

  let raw: string;
  try {
    raw = execution
      ? await execution.agentRuntime.completeLeaf(
          { id: "onebot.sticker.select", model: runtime.model_name },
          {
            messages,
            signal: execution.signal,
            owner: {
              kind: "qq_binding",
              id: binding.id,
              userId: DEFAULT_USER_ID,
              agentId: binding.agentId,
            },
            sources: [
              ...(execution.sources ?? []),
              ...value.messages.flatMap((m) => m.sources ?? []),
              ...offered.flatMap((c) => {
                const asset = metadata.get(c.id);
                return asset ? [{ kind: "qq_sticker", id: c.id, revision: asset.updatedAt }] : [];
              }),
            ],
            validate: (raw) => {
              const choice = qqStickerChoice(raw, offered.length);
              if (choice.kind !== "picked" && choice.reason !== "declined")
                throw new Error("STICKER_SELECTION_INVALID");
              return choice;
            },
          },
        )
      : await gateway.complete({ model: runtime.model_name, messages });
  } catch {
    return { kind: "model_error" };
  }
  const choice = qqStickerChoice(raw, offered.length);
  if (choice.kind !== "picked") return { kind: "none", reason: choice.reason };
  const chosen = offered[choice.index - 1];
  // `qqStickerChoice` refuses out-of-range answers, so this is unreachable; asserting rather than
  // assuming keeps a future change from turning it into an undefined id.
  if (chosen === undefined) return { kind: "none", reason: "out_of_range" };
  return { kind: "chosen", stickerId: chosen.id, candidateCount: offered.length };
}

/**
 * The candidates as the model must see them: usable now, soft-rule preference first.
 *
 * Ordering by `recentlyUsed` before id keeps the presentation deterministic and puts the stickers
 * §9.3 asks the model to prefer first; the marker in the rendered line is what the prompt's
 * "不选刚发过的那张" refers to. The chosen number is an index into THIS list, so the two must not
 * be derived in different places.
 */
function offeredStickers(selection: QqStickerSelection): readonly {
  readonly id: string;
  readonly recentlyUsed: boolean;
}[] {
  return selection.candidates
    .filter(
      (candidate) =>
        qqStickerUsable(candidate, { minRepeatSeconds: selection.minRepeatSeconds }).kind ===
        "usable",
    )
    .slice()
    .sort(
      (left, right) =>
        Number(left.recentlyUsed) - Number(right.recentlyUsed) || left.id.localeCompare(right.id),
    );
}

/**
 * What the reply consists of, assembled from the draft and the library as they stand now.
 *
 * Read-only and idempotent, so both the cycle's last step and the submit-time guard can call it:
 * the pick is re-checked against freshly read facts, and §8.1-6 is applied here rather than
 * re-invented — a pick that no longer resolves to a usable candidate leaves the text alone, and a
 * reply with neither text nor sticker becomes `abandoned` instead of a half-filled plan.
 *
 * The clock is the draft's own (`prepared.nowSeconds`), so §9.3's interval is measured from the
 * moment the sentence was generated rather than from whenever this happens to be called. That
 * direction is the conservative one: a stale clock makes an age look smaller, and a smaller age is
 * what §9.3's hard rule refuses.
 */
export function planQqPreparedReply(
  orm: Orm,
  prepared: QqPendingReview,
  stage: QqStickerStage,
): QqOutputPlan {
  const pick = prepared.stickerId ?? null;
  const binding = readQqBinding(orm, prepared.snapshot.bindingId);
  const scheme = readQqScheme(orm, prepared.snapshot.schemeId);
  if (
    pick === null ||
    binding === null ||
    scheme === null ||
    scheme.revision !== prepared.schemeRevision
  ) {
    return planQqOutput({
      text: prepared.text,
      requestedStickers: 0,
      maxStickerCount: 1,
      candidates: [],
      minRepeatSeconds: null,
      avoidRecent: false,
    });
  }
  const selection = qqStickerSelectionForScheme(orm, {
    schemeId: scheme.id,
    scope: {
      kind: "qq",
      accountId: binding.accountId,
      conversationKind: binding.kind,
      peerId: binding.peerId,
      agentId: binding.agentId,
    },
    counts: stage.counts,
    nowSeconds: prepared.nowSeconds,
    isAvailable: stage.isAvailable,
  });
  const candidate = selection.candidates.find((entry) => entry.id === pick);
  return planQqOutput({
    text: prepared.text,
    // §8.1-4's ceiling is re-applied from the scheme; the model asked for exactly one.
    requestedStickers: 1,
    maxStickerCount: selection.maxStickerCount,
    candidates: candidate === undefined ? [] : [candidate],
    minRepeatSeconds: selection.minRepeatSeconds,
    avoidRecent: selection.avoidRecent,
  });
}
