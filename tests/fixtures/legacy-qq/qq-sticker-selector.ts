// Test-only pre-cutover selector oracle; never import from production.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { createAgentRuntime, type LeafAgentRuntime } from "../../../src/server/agent/agent-runtime";
import { AgentRunRepository } from "../../../src/server/db/agent-run-repository";
import { readQqBinding } from "../../../src/server/db/qq-binding-repository";
import {
  readEffectiveQqScheme,
  readQqGroupAgentConfig,
} from "../../../src/server/db/qq-group-config-repository";
import { qqMemberLabels } from "../../../src/server/db/qq-member-repository";
import type { QqConversationScope } from "../../../src/server/db/qq-observation-repository";
import {
  readQqScheme,
  schemeOutputReserve,
  schemePrompts,
} from "../../../src/server/db/qq-scheme-repository";
import { listQqStickerAssets } from "../../../src/server/db/qq-sticker-repository";
import { DEFAULT_USER_ID, getAgentRow, type Orm } from "../../../src/server/db/repositories";
import type { ModelGateway } from "../../../src/server/llm/model-gateway";
import type { QqBinding } from "../../../src/server/services/qq-binding-contract";
import { checkQqModelCapacity } from "../../../src/server/services/qq-capacity-preflight";
import { ContextMessageSchema } from "../../../src/server/services/qq-context-contract";
import { buildQqPrompt, qqPromptMessages } from "../../../src/server/services/qq-prompt-contract";
import {
  type QqStickerSelection,
  qqStickerSelectionForScheme,
} from "../../../src/server/services/qq-sticker-candidates";
import { qqStickerChoice, qqStickerUsable } from "../../../src/server/services/qq-sticker-contract";
import type { QqStickerStage } from "../../../src/server/services/qq-sticker-runner";
import { compileSystemPrompt, runtimeFromAgent } from "../../../src/server/services/runtime-config";
import type { SourceRef } from "../../../src/shared/contracts/evidence";

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
 * 本群停用「表情」后，素材不得再被使用——不是隐藏候选，而是模型调用与发送两个边界都不放行
 * （ADR0019 §13.3 D/H）。停用即时生效，不等下一轮：读取发生在每次使用时。
 */
function groupStickersDisabled(orm: Orm, binding: QqBinding): boolean {
  return readQqGroupAgentConfig(orm, binding).disabled_capabilities.includes("stickers");
}

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
  // 全局方案修订号仍是硬闸（本群差异不在这里判定）；生效值（提示词、预留、素材范围）随后读。
  const baseScheme = readQqScheme(orm, value.schemeId);
  if (!baseScheme || baseScheme.revision !== value.schemeRevision)
    return { kind: "blocked", reason: "scheme_changed" };
  // 生效方案读不到就不继续：基础方案不得替本群差异兜底（否则会放过本群已收紧的素材范围与参数）。
  const scheme = readEffectiveQqScheme(orm, binding);
  if (!scheme) return { kind: "blocked", reason: "scheme_changed" };
  const agent = getAgentRow(orm, value.agentId);
  if (agent?.isActive !== 1 || agent.configVersion !== value.agentConfigVersion)
    return { kind: "blocked", reason: "agent_changed" };
  // 本群停用后连挑一次都不做：不花模型调用去选一张不允许使用的素材。
  if (groupStickersDisabled(orm, binding)) return { kind: "none", reason: "capability_disabled" };

  const scope: QqConversationScope = {
    kind: "qq",
    accountId: binding.accountId,
    conversationKind: binding.kind,
    peerId: binding.peerId,
    agentId: binding.agentId,
  };
  const selection = qqStickerSelectionForScheme(orm, {
    schemeId: value.schemeId,
    // 显式带上本群绑定：候选按本群生效素材集合与表情参数裁剪，而不是按基础方案。
    binding,
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
    const agentRuntime =
      execution?.agentRuntime ??
      createAgentRuntime({
        gateway,
        repository: new AgentRunRepository((orm as Orm & { $client: Database }).$client),
      });
    raw = await agentRuntime.completeLeaf(
      { id: "onebot.sticker.select", model: runtime.model_name },
      {
        messages,
        signal: execution?.signal,
        owner: {
          kind: "qq_binding",
          id: binding.id,
          userId: DEFAULT_USER_ID,
          agentId: binding.agentId,
        },
        sources: [
          ...(execution?.sources ?? []),
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
    );
  } catch {
    execution?.signal?.throwIfAborted();
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
