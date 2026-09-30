// 本群方案差异的公共契约：稀疏组、三态触发器与合并语义，纯函数不起库。

import { describe, expect, it } from "bun:test";
import { QQ_CONTEXT_DEFAULT } from "../../src/server/services/qq-context-contract";
import { QQ_PROMPT_DEFAULTS } from "../../src/server/services/qq-prompt-contract";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import {
  QQ_COMPRESSION_DEFAULT,
  QQ_MODEL_OUTPUT_RESERVE_DEFAULT,
  QQ_REPLY_DEFAULT,
  QQ_STICKER_DEDUP_DEFAULT,
  type QqSchemeResponse,
} from "../../src/shared/contracts/qq";
import {
  isEmptyQqGroupOverrides,
  mergeQqGroupScheme,
  normalizeQqGroupCapabilities,
  QqGroupSchemeOverridesSchema,
  UpdateQqGroupConfigRequestSchema,
} from "../../src/shared/contracts/qq-group-config";

const COLLECTION_A = "11111111-1111-4111-8111-111111111111";
const COLLECTION_B = "22222222-2222-4222-8222-222222222222";

/** 一份完整的基础方案：触发器的取值特意与差异用例相反，方便看谁盖过谁。 */
function baseScheme(): QqSchemeResponse {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    name: "基础方案",
    description: null,
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
    rhythm: { ...QQ_RHYTHM_DEFAULT },
    context: { ...QQ_CONTEXT_DEFAULT },
    compression: { ...QQ_COMPRESSION_DEFAULT },
    output_reserve: { ...QQ_MODEL_OUTPUT_RESERVE_DEFAULT },
    stickers: { ...QQ_STICKER_DEDUP_DEFAULT },
    sticker_collections: { collection_ids: [COLLECTION_A, COLLECTION_B] },
    prompts: { ...QQ_PROMPT_DEFAULTS },
    reply: { ...QQ_REPLY_DEFAULT },
    revision: 1,
    created_at: "2026-01-01T00:00:00.000000Z",
    updated_at: "2026-01-01T00:00:00.000000Z",
  };
}

describe("本群方案差异的稀疏形状", () => {
  it("空差异与整组为空的提交都归一化成 {}，产出还能再次解析", () => {
    const empty = QqGroupSchemeOverridesSchema.parse({});
    expect(empty).toEqual({});
    expect(isEmptyQqGroupOverrides(empty)).toBe(true);
    // 回归：组一旦必填，“每个组都在但没有成员”的形态会把归一化产出变成解析不了的快照。
    const allGroupsEmpty = {
      triggers: {},
      rhythm: {},
      context: {},
      compression: {},
      output_reserve: {},
      stickers: {},
      prompts: {},
      reply: {},
    };
    const parsed = QqGroupSchemeOverridesSchema.parse(allGroupsEmpty);
    expect(parsed).toEqual({});
    expect(QqGroupSchemeOverridesSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual({});
  });

  it("triggers 只保留布尔成员：null 是跟随被丢掉，全 null 时整组消失", () => {
    const partial = QqGroupSchemeOverridesSchema.parse({
      triggers: { direct_reply: true, follow_up: null, chiming_in: null, idle_topic: false },
    });
    expect(partial).toEqual({ triggers: { direct_reply: true, idle_topic: false } });
    expect(partial.triggers !== undefined && "follow_up" in partial.triggers).toBe(false);
    const allNull = QqGroupSchemeOverridesSchema.parse({
      triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
    });
    expect(allNull).toEqual({});
  });

  it("false、0、空集合与显式等值覆盖都保留并盖过基础方案", () => {
    const overrides = QqGroupSchemeOverridesSchema.parse({
      triggers: { direct_reply: false },
      rhythm: { merge_window_seconds: 0, max_recompute_count: 0 },
      reply: { split_by_speaker: false },
      sticker_collections: { collection_ids: [] },
    });
    expect(overrides).toEqual({
      triggers: { direct_reply: false },
      rhythm: { merge_window_seconds: 0, max_recompute_count: 0 },
      reply: { split_by_speaker: false },
      sticker_collections: { collection_ids: [] },
    });
    const effective = mergeQqGroupScheme(baseScheme(), overrides);
    expect(effective.triggers.direct_reply).toBe(false);
    expect(effective.rhythm.merge_window_seconds).toBe(0);
    expect(effective.rhythm.max_recompute_count).toBe(0);
    expect(effective.reply.split_by_speaker).toBe(false);
    expect(effective.sticker_collections.collection_ids).toEqual([]);
    // 显式等值：与基础相同的值也留在差异里。
    const equal = QqGroupSchemeOverridesSchema.parse({
      rhythm: { merge_window_seconds: QQ_RHYTHM_DEFAULT.merge_window_seconds },
    });
    expect(equal.rhythm?.merge_window_seconds).toBe(QQ_RHYTHM_DEFAULT.merge_window_seconds);
  });

  it("未给的 prompt 槽位不带默认值：compress 只在显式写入时出现", () => {
    const sparse = QqGroupSchemeOverridesSchema.parse({ prompts: { scene: "自定义开场" } });
    expect(sparse.prompts).toEqual({ scene: "自定义开场" });
    expect(sparse.prompts?.compress).toBeUndefined();
    expect(mergeQqGroupScheme(baseScheme(), sparse).prompts.compress).toBe(
      QQ_PROMPT_DEFAULTS.compress,
    );
    const explicit = QqGroupSchemeOverridesSchema.parse({ prompts: { compress: "自定义压缩" } });
    expect(mergeQqGroupScheme(baseScheme(), explicit).prompts.compress).toBe("自定义压缩");
  });

  it("越界、未知与退役字段被拒绝", () => {
    const rejected: unknown[] = [
      { rhythm: { merge_window_seconds: 301 } },
      { context: { judgement_message_limit: 0 } },
      { rhythm: { judgement_interval_turns: 5 } },
      { context: { reply_message_limit: 60 } },
      { triggers: { direct_reply: "true" } },
      { triggers: { nope: true } },
      { nope: {} },
      { sticker_collections: { collection_ids: ["not-a-uuid"] } },
    ];
    for (const value of rejected) {
      expect(QqGroupSchemeOverridesSchema.safeParse(value).success).toBe(false);
    }
  });

  it("合并逐字段盖过基础方案，缺省跟随，且不改动基础对象", () => {
    const scheme = baseScheme();
    const overrides = QqGroupSchemeOverridesSchema.parse({
      triggers: { follow_up: true },
      rhythm: { merge_window_seconds: 5 },
      context: { judgement_token_budget: 1024 },
    });
    const effective = mergeQqGroupScheme(scheme, overrides);
    expect(effective.triggers.follow_up).toBe(true);
    expect(effective.triggers.direct_reply).toBe(true);
    expect(effective.rhythm.merge_window_seconds).toBe(5);
    expect(effective.rhythm.reply_cooldown_seconds).toBe(QQ_RHYTHM_DEFAULT.reply_cooldown_seconds);
    expect(effective.context.judgement_token_budget).toBe(1024);
    expect(effective.context.reply_token_budget).toBe(QQ_CONTEXT_DEFAULT.reply_token_budget);
    expect(effective.sticker_collections.collection_ids).toEqual(
      scheme.sticker_collections.collection_ids,
    );
    expect(scheme.triggers.follow_up).toBe(false);
  });

  it("能力停用是去重排序的集合，保存请求把 agent_id 当身份而不是可改字段", () => {
    expect(normalizeQqGroupCapabilities(["stickers", "memory_read", "stickers"])).toEqual([
      "memory_read",
      "stickers",
    ]);
    expect(normalizeQqGroupCapabilities([])).toEqual([]);
    const request = UpdateQqGroupConfigRequestSchema.parse({
      agent_id: "33333333-3333-4333-8333-333333333333",
      expected_binding_revision: 1,
      expected_scheme_revision: 2,
      expected_revision: 0,
      overrides: { triggers: { follow_up: null }, rhythm: {} },
      disabled_capabilities: ["stickers"],
    });
    expect(request.overrides).toEqual({});
    expect(request.scheme_change).toBeUndefined();
  });
});
