// 本群 Agent 配置的读写：一份记录 = 绑定 × Agent 的稀疏"方案差异" + 一组"本群停用"的系统能力。
// 读路径把差异与当前基础方案合并成生效方案（runtime 走 `readEffectiveQqScheme` 的行映射，界面走
// 共享契约里的 `mergeQqGroupScheme`）；写路径整份提交，在一个 IMMEDIATE 事务里做四重比较交换：
// 绑定修订、当前 Agent 身份、目标基础方案修订、配置修订；没有内容变化不写库、不涨修订。

import {
  mergeQqGroupScheme,
  normalizeQqGroupCapabilities,
  type QqGroupCapability,
  type QqGroupConfigResponse,
  QqGroupConfigResponseSchema,
  type QqGroupSchemeOverrides,
  type UpdateQqGroupConfigRequest,
} from "../../shared/contracts/qq-group-config";
import { fail } from "../errors";
import { type QqBinding, updateQqBinding } from "../services/qq-binding-contract";
import { parseQqSchemeStickerCollections } from "../services/qq-sticker-contract";
import {
  assertQqGroupStickerSubset,
  bindingResponse,
  parseQqGroupAgentConfigRow,
  type QqGroupAgentConfigView,
  readQqBinding,
  readQqGroupConfigRow,
  resolveQqGroupCapabilityRevisions,
  sameBindingTriggers,
  saveQqBindingRow,
  triggersFromOverrides,
  writeQqGroupAgentConfigRow,
} from "./qq-binding-repository";
import {
  effectiveQqTriggers,
  type QqSchemeRow,
  readQqScheme,
  schemeColumnsFromGroups,
  schemeResponse,
  schemeStickerCollectionIds,
} from "./qq-scheme-repository";
import type { Orm } from "./repositories";

/** 无记录＝虚拟默认：空差异、空停用、全部能力修订 0、revision 0。 */
function emptyConfig(): QqGroupAgentConfigView {
  return {
    overrides: {},
    disabled_capabilities: [],
    capability_revisions: resolveQqGroupCapabilityRevisions(new Map()),
    revision: 0,
  };
}

/**
 * 一个绑定 × 当前 Agent 保存的差异与能力停用项。私聊没有本群配置，回答虚拟默认而不是报错：
 * 读路径（含 runtime 的生效方案）不该因为会话是私聊而失败。
 */
export function readQqGroupAgentConfig(
  orm: Orm,
  binding: Pick<QqBinding, "id" | "agentId" | "kind">,
): QqGroupAgentConfigView {
  if (binding.kind !== "group") return emptyConfig();
  const row = readQqGroupConfigRow(orm, binding.id, binding.agentId);
  return row === null ? emptyConfig() : parseQqGroupAgentConfigRow(row);
}

/**
 * 全部已登记能力的生效修订映射（server-only，不进公共响应）：无记录、非群与从未翻转＝0。
 * 能力来源证据（`qq_group_capability`）用它判定失效：记录里修订一旦前进（含关闭再恢复），
 * 引用旧修订的证据就不再成立。
 */
export function readQqGroupCapabilityRevisions(
  orm: Orm,
  binding: Pick<QqBinding, "id" | "agentId" | "kind">,
): ReadonlyMap<QqGroupCapability, number> {
  return readQqGroupAgentConfig(orm, binding).capability_revisions;
}

/** 单个能力的生效修订（server-only）：语义同 `readQqGroupCapabilityRevisions`。 */
export function readQqGroupCapabilityRevision(
  orm: Orm,
  binding: Pick<QqBinding, "id" | "agentId" | "kind">,
  capability: QqGroupCapability,
): number {
  return readQqGroupCapabilityRevisions(orm, binding).get(capability) ?? 0;
}

/**
 * 生效方案行：基础行 + 本群差异的列覆盖。id/revision/created_at 保持基础方案不变，于是
 * runtime 既有的 schemeRhythm/schemeContext/... 与 effectiveQqTriggers 原样可用。
 * triggers 以绑定镜像优先（绑定的 effectiveQqTriggers 是既有唯一解析点；镜像与记录由
 * 写入点保持同值），其余分组与 `mergeQqGroupScheme` 的线形结果逐字段一致。
 */
export function readEffectiveQqScheme(orm: Orm, binding: QqBinding): QqSchemeRow | null {
  const base = readQqScheme(orm, binding.schemeId);
  if (base === null) return null;
  const config = readQqGroupAgentConfig(orm, binding);
  const merged = mergeQqGroupScheme(schemeResponse(orm, base), config.overrides);
  return {
    ...base,
    ...schemeColumnsFromGroups({
      triggers: effectiveQqTriggers(binding, base),
      rhythm: merged.rhythm,
      context: merged.context,
      compression: merged.compression,
      outputReserve: merged.output_reserve,
      stickers: merged.stickers,
      prompts: merged.prompts,
      reply: merged.reply,
      // 0052 的两组随差异落列：runtime 的既有读出口（schemeMessageSettings/schemeMediaInput）
      // 从这两列解析，没有列覆盖的差异就不会生效。
      messageSettings: merged.message_settings,
      mediaInput: merged.media_input,
    }),
  };
}

/**
 * 本群生效的素材集合：有差异就是差异里整组替换的集合，否则跟随基础方案。
 * 返回前与基础方案取交集兜底——记录可能写在基础方案缩小授权之前，生效值不能超过授权。
 */
export function effectiveQqStickerCollectionIds(orm: Orm, binding: QqBinding): string[] {
  const base = readQqScheme(orm, binding.schemeId);
  if (base === null) return [];
  const selected = readQqGroupAgentConfig(orm, binding).overrides.sticker_collections
    ?.collection_ids;
  if (selected === undefined) return schemeStickerCollectionIds(orm, base.id);
  const authorized = new Set(schemeStickerCollectionIds(orm, base.id));
  return selected.filter((id) => authorized.has(id));
}

function requireGroupBinding(orm: Orm, bindingId: string): QqBinding {
  const binding = readQqBinding(orm, bindingId);
  if (binding === null) fail("MEMORY_NOT_FOUND", "QQ绑定不存在", 404);
  if (binding.kind !== "group") fail("MEMORY_NOT_FOUND", "只有群聊才有本群配置", 404);
  return binding;
}

/** 配置页的读取：基础方案、差异、停用项与合并后的生效方案。 */
export function readQqGroupConfig(orm: Orm, bindingId: string): QqGroupConfigResponse {
  const binding = requireGroupBinding(orm, bindingId);
  const base = readQqScheme(orm, binding.schemeId);
  if (base === null) fail("MEMORY_NOT_FOUND", "方案不存在", 404);
  const config = readQqGroupAgentConfig(orm, binding);
  const baseScheme = schemeResponse(orm, base);
  const effective = mergeQqGroupScheme(baseScheme, config.overrides);
  return QqGroupConfigResponseSchema.parse({
    binding: bindingResponse(orm, binding),
    base_scheme: baseScheme,
    // 生效素材集合取授权交集（与 runtime 同一个判据），overrides 保留原始选择，界面据此提示受阻项。
    effective_scheme: {
      ...effective,
      sticker_collections: {
        collection_ids: effectiveQqStickerCollectionIds(orm, binding),
      },
    },
    overrides: config.overrides,
    disabled_capabilities: config.disabled_capabilities,
    revision: config.revision,
  });
}

/** 素材集合是整体替换的一个字段：按集合语义去重排序，同一集合的两种顺序不算变化。 */
function normalizeStickerOverride(overrides: QqGroupSchemeOverrides): QqGroupSchemeOverrides {
  const selected = overrides.sticker_collections?.collection_ids;
  if (selected === undefined) return overrides;
  return {
    ...overrides,
    sticker_collections: {
      collection_ids: [...parseQqSchemeStickerCollections({ collection_ids: selected })],
    },
  };
}

function sameCollectionIds(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** 选择没变就不校验（可能已超界，运行时按交集生效）；这次真的换了选择才要求落在授权之内。 */
function assertQqGroupStickerSelection(
  orm: Orm,
  schemeId: string,
  previous: QqGroupSchemeOverrides,
  next: QqGroupSchemeOverrides,
): void {
  const before = previous.sticker_collections?.collection_ids;
  const selected = next.sticker_collections?.collection_ids;
  if (selected !== undefined && sameCollectionIds(before, selected)) return;
  assertQqGroupStickerSubset(orm, schemeId, next);
}

export interface UpdateQqGroupConfigArgs {
  bindingId: string;
  payload: UpdateQqGroupConfigRequest;
}

/**
 * 保存本群配置（整份状态提交 + 比较交换）。
 *
 * 四个期望值缺一不可：绑定修订、当前 Agent 身份（请求里的 `agent_id` 是身份而不是目标）、
 * 目标基础方案修订、配置修订（0＝还没有记录）。`scheme_change`：`reset` 清空方案差异
 * （能力停用不重置）并让绑定镜像回到全部跟随；`keep` 使用提交的差异。`scheme_id` 变化时
 * 必须显式给出其中之一。内容没变不写库、不涨修订；素材集合不得超出目标方案的授权。
 */
export function updateQqGroupConfig(
  orm: Orm,
  args: UpdateQqGroupConfigArgs,
): QqGroupConfigResponse {
  const payload = args.payload;
  return orm.transaction(
    (tx) => {
      const binding = requireGroupBinding(tx, args.bindingId);
      if (binding.revision !== payload.expected_binding_revision) {
        fail("MEMORY_STATE_CONFLICT", "QQ绑定已变化，请重新加载后保存");
      }
      // `agent_id` 是身份不是目标：它必须等于绑定当前的助手，否则提交的是另一个 Agent 的草稿。
      if (binding.agentId !== payload.agent_id) {
        fail("MEMORY_STATE_CONFLICT", "本群配置属于另一个助手，请重新加载后保存");
      }
      const schemeId = payload.scheme_id ?? binding.schemeId;
      const scheme = readQqScheme(tx, schemeId);
      if (scheme === null) fail("MEMORY_NOT_FOUND", "方案不存在", 404);
      if (scheme.revision !== payload.expected_scheme_revision) {
        fail("MEMORY_STATE_CONFLICT", "方案已变化，请重新加载后保存");
      }
      const schemeChanged = schemeId !== binding.schemeId;
      if (schemeChanged && payload.scheme_change === undefined) {
        fail("MEMORY_STATE_CONFLICT", "换方案需要明确保留还是重置本群方案差异");
      }

      const current = readQqGroupAgentConfig(tx, binding);
      if (current.revision !== payload.expected_revision) {
        fail("MEMORY_STATE_CONFLICT", "本群配置已变化，请重新加载后保存");
      }

      // 目标差异：整份提交。reset ＝ 全部跟随新方案（清空差异，能力停用不重置）；
      // 其余情况提交的差异就是目标值。
      const overrides: QqGroupSchemeOverrides =
        payload.scheme_change === "reset" ? {} : normalizeStickerOverride(payload.overrides);
      const capabilities = normalizeQqGroupCapabilities(payload.disabled_capabilities);
      assertQqGroupStickerSelection(tx, schemeId, current.overrides, overrides);

      // 记录是唯一来源，绑定四列跟随：只有真的不同才写绑定（no-op 不涨修订）。
      const mirror = triggersFromOverrides(overrides);
      const patch: Record<string, unknown> = {};
      if (schemeChanged) patch.schemeId = schemeId;
      if (!sameBindingTriggers(binding.triggers, mirror)) patch.triggers = mirror;
      if (Object.keys(patch).length > 0) {
        const result = updateQqBinding(binding, patch, binding.revision, null);
        if (result.kind !== "saved") {
          fail("MEMORY_STATE_CONFLICT", "QQ绑定已变化，请重新加载后保存");
        }
        saveQqBindingRow(tx, { binding: result.binding, expectedRevision: binding.revision });
      }

      writeQqGroupAgentConfigRow(tx, {
        bindingId: binding.id,
        agentId: binding.agentId,
        overrides,
        disabledCapabilities: capabilities,
        expectedRevision: current.revision,
      });

      // 事务内重读：回的就是落库后的状态（含绑定与配置两个修订）。
      return readQqGroupConfig(tx, binding.id);
    },
    { behavior: "immediate" },
  );
}
