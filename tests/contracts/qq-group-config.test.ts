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
  QqSchemeResponseSchema,
  QqSchemeRhythmSchema,
} from "../../src/shared/contracts/qq";
import {
  isBothTrueInteractionPair,
  isEmptyQqGroupOverrides,
  mergeQqGroupScheme,
  normalizeQqGroupCapabilities,
  type QqGroupSchemeOverrides,
  QqGroupSchemeOverridesSchema,
  resolveQqInteractionPair,
  UpdateQqGroupConfigRequestSchema,
} from "../../src/shared/contracts/qq-group-config";
import { QQ_MEDIA_INPUT_DEFAULT } from "../../src/shared/contracts/qq-media-input";
import { QQ_MESSAGE_SETTINGS_DEFAULT } from "../../src/shared/contracts/qq-message";

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
    message_settings: { ...QQ_MESSAGE_SETTINGS_DEFAULT },
    media_input: { ...QQ_MEDIA_INPUT_DEFAULT },
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
    // scheme 已开 chiming_in，本群又显式开 follow_up → 组合双 true（新写会被保存边界拒绝），
    // 但 merge 本身是纯读归一：生效对按 chiming_in 优先，continuous 不生效。
    expect(effective.triggers.follow_up).toBe(false);
    expect(effective.triggers.chiming_in).toBe(true);
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

describe("0052 消息设置与图片输入组的稀疏差异（T01 Step5）", () => {
  /**
   * 合并结果总是完整方案（生效值不允许缺席组）；契约在迁移间隙保持 optional，
   * 测试用一次显式 parse ＋缺组即抛错把「完整」钉成运行时事实，避免散落的非空断言。
   */
  function mergeEffective(
    base: QqSchemeResponse,
    overrides: QqGroupSchemeOverrides,
  ): QqSchemeResponse & {
    message_settings: NonNullable<QqSchemeResponse["message_settings"]>;
    media_input: NonNullable<QqSchemeResponse["media_input"]>;
  } {
    const merged = QqSchemeResponseSchema.parse(mergeQqGroupScheme(base, overrides));
    if (merged.message_settings === undefined || merged.media_input === undefined) {
      throw new Error("合并结果必须携带完整的消息设置与图片输入组");
    }
    return merged as QqSchemeResponse & {
      message_settings: NonNullable<QqSchemeResponse["message_settings"]>;
      media_input: NonNullable<QqSchemeResponse["media_input"]>;
    };
  }

  it("media_input.stages 逐字段覆盖：只关 evaluation，decision/generation 保持基础方案", () => {
    // 计划 T12 Step7 的合并语义锚点（行为落地在 T12，合并纯函数在共享契约先钉死）。
    const overrides = QqGroupSchemeOverridesSchema.parse({
      media_input: { stages: { evaluation: false } },
    });
    expect(overrides.media_input).toEqual({ stages: { evaluation: false } });
    const effective = mergeEffective(baseScheme(), overrides);
    expect(effective.media_input.stages).toEqual({
      decision: true,
      evaluation: false,
      generation: true,
    });
    // 单独关 generation 也一样：缺席成员永远是逐字段继承，不是整组替换。
    const onlyGeneration = QqGroupSchemeOverridesSchema.parse({
      media_input: { stages: { generation: false } },
    });
    expect(mergeEffective(baseScheme(), onlyGeneration).media_input.stages).toEqual({
      decision: true,
      evaluation: true,
      generation: false,
    });
    // stages 缺席时三阶段全部保持基础方案。
    const modeOnly = QqGroupSchemeOverridesSchema.parse({ media_input: { mode: "description" } });
    const merged = mergeEffective(baseScheme(), modeOnly);
    expect(merged.media_input.mode).toBe("description");
    expect(merged.media_input.stages).toEqual(QQ_MEDIA_INPUT_DEFAULT.stages);
  });

  it("stages 的 false 是实打实的覆盖；允许全 false（图片开关开但不自动发，仅按需）", () => {
    const allFalse = QqGroupSchemeOverridesSchema.parse({
      media_input: { stages: { decision: false, evaluation: false, generation: false } },
    });
    const effective = mergeEffective(baseScheme(), allFalse);
    expect(effective.media_input.stages).toEqual({
      decision: false,
      evaluation: false,
      generation: false,
    });
  });

  it("ordinary_still_max_dimension: null 合并后就是 null（原图），不是跟随基础方案", () => {
    const overrides = QqGroupSchemeOverridesSchema.parse({
      media_input: { ordinary_still_max_dimension: null },
    });
    expect(overrides.media_input?.ordinary_still_max_dimension).toBeNull();
    expect(mergeEffective(baseScheme(), overrides).media_input.ordinary_still_max_dimension).toBe(
      null,
    );
    // 数值覆盖照常生效；0 不是合法尺寸（64–2048），不是「跟随」的写法。
    const sized = QqGroupSchemeOverridesSchema.parse({
      media_input: { ordinary_still_max_dimension: 1024 },
    });
    expect(mergeEffective(baseScheme(), sized).media_input.ordinary_still_max_dimension).toBe(1024);
    expect(
      QqGroupSchemeOverridesSchema.safeParse({
        media_input: { ordinary_still_max_dimension: 0 },
      }).success,
    ).toBe(false);
  });

  it("message_settings 逐字段稀疏覆盖，其余字段保持基础方案", () => {
    const overrides = QqGroupSchemeOverridesSchema.parse({
      message_settings: { time_display: "full" },
    });
    expect(overrides.message_settings).toEqual({ time_display: "full" });
    const effective = mergeEffective(baseScheme(), overrides);
    expect(effective.message_settings.time_display).toBe("full");
    expect(effective.message_settings.timezone).toBe(QQ_MESSAGE_SETTINGS_DEFAULT.timezone);
    expect(effective.message_settings.reply_mode).toBe(QQ_MESSAGE_SETTINGS_DEFAULT.reply_mode);
    expect(effective.message_settings.reply_depth).toBe(QQ_MESSAGE_SETTINGS_DEFAULT.reply_depth);
    // depth=9 越界拒绝；时区沿用同一 IANA 验证。
    expect(
      QqGroupSchemeOverridesSchema.safeParse({ message_settings: { reply_depth: 9 } }).success,
    ).toBe(false);
    expect(
      QqGroupSchemeOverridesSchema.safeParse({ message_settings: { timezone: "Not/AZone" } })
        .success,
    ).toBe(false);
  });

  it("两组的额外字段与空组归一化语义与其他组一致", () => {
    expect(QqGroupSchemeOverridesSchema.safeParse({ media_input: { nope: 1 } }).success).toBe(
      false,
    );
    expect(QqGroupSchemeOverridesSchema.safeParse({ message_settings: { nope: 1 } }).success).toBe(
      false,
    );
    expect(
      QqGroupSchemeOverridesSchema.safeParse({ media_input: { stages: { nope: true } } }).success,
    ).toBe(false);
    const empty = QqGroupSchemeOverridesSchema.parse({
      message_settings: {},
      media_input: { stages: {} },
    });
    expect(empty).toEqual({});
  });
});

describe("0054 自主接话批量参数的稀疏覆盖与互斥解析", () => {
  it("三个批量字段逐字段覆盖，缺席＝跟随基础方案；关系在合并后的完整节奏上校验", () => {
    const base = baseScheme();
    const overrides = QqGroupSchemeOverridesSchema.parse({
      rhythm: { initiative_batch_target_count: 30, initiative_batch_jitter_count: 20 },
    });
    const merged = mergeQqGroupScheme(base, overrides);
    expect(merged.rhythm.initiative_batch_target_count).toBe(30);
    expect(merged.rhythm.initiative_batch_jitter_count).toBe(20);
    expect(merged.rhythm.initiative_queue_on_busy).toBe(base.rhythm.initiative_queue_on_busy);

    const singleY = QqGroupSchemeOverridesSchema.parse({
      rhythm: { initiative_batch_jitter_count: 3 },
    });
    const mergedY = mergeQqGroupScheme(base, singleY);
    expect(mergedY.rhythm.initiative_batch_target_count).toBe(
      base.rhythm.initiative_batch_target_count,
    );
    expect(mergedY.rhythm.initiative_batch_jitter_count).toBe(3);
  });

  it("Y < X 在契约层拒绝：差异单值与基础方案组合后违约同样拒绝", () => {
    const base = baseScheme();
    // 基础 X=15；差异 Y=20 → 合并后违约。
    const bad = { rhythm: { initiative_batch_jitter_count: 20 } };
    const merged = mergeQqGroupScheme(base, QqGroupSchemeOverridesSchema.parse(bad));
    expect(QqSchemeRhythmSchema.safeParse(merged.rhythm).success).toBe(false);
    // 稀疏差异自身不携带完整关系（X/Y 可分别来自两层），(5,5) 在差异层可解析；
    // 违约在合并后的完整节奏上必现，由保存边界（repo）据此拒绝。
    const selfConflict = QqGroupSchemeOverridesSchema.parse({
      rhythm: { initiative_batch_target_count: 5, initiative_batch_jitter_count: 5 },
    });
    const conflictMerged = mergeQqGroupScheme(base, selfConflict);
    expect(QqSchemeRhythmSchema.safeParse(conflictMerged.rhythm).success).toBe(false);
  });

  it("queue_on_busy 剥默认后可选：显式 false 是真实覆盖，缺席是跟随", () => {
    const base = baseScheme();
    const off = mergeQqGroupScheme(
      base,
      QqGroupSchemeOverridesSchema.parse({ rhythm: { initiative_queue_on_busy: false } }),
    );
    expect(off.rhythm.initiative_queue_on_busy).toBe(false);
    const follow = mergeQqGroupScheme(base, QqGroupSchemeOverridesSchema.parse({ rhythm: {} }));
    expect(follow.rhythm.initiative_queue_on_busy).toBe(base.rhythm.initiative_queue_on_busy);
  });

  it("时间窗口三字段同样逐字段覆盖，缺席＝跟随基础方案", () => {
    const base = baseScheme();
    const overrides = QqGroupSchemeOverridesSchema.parse({
      rhythm: {
        initiative_time_window_enabled: false,
        initiative_time_target_seconds: 200,
        initiative_time_jitter_seconds: 30,
      },
    });
    const merged = mergeQqGroupScheme(base, overrides);
    expect(merged.rhythm.initiative_time_window_enabled).toBe(false);
    expect(merged.rhythm.initiative_time_target_seconds).toBe(200);
    expect(merged.rhythm.initiative_time_jitter_seconds).toBe(30);
    // 只覆盖 A 时 B 跟随基础方案，不是缺省 20——这一群的时间窗因此不会因半次编辑变形。
    const onlyTarget = mergeQqGroupScheme(
      base,
      QqGroupSchemeOverridesSchema.parse({ rhythm: { initiative_time_target_seconds: 200 } }),
    );
    expect(onlyTarget.rhythm.initiative_time_target_seconds).toBe(200);
    expect(onlyTarget.rhythm.initiative_time_jitter_seconds).toBe(
      base.rhythm.initiative_time_jitter_seconds,
    );
    expect(onlyTarget.rhythm.initiative_time_window_enabled).toBe(
      base.rhythm.initiative_time_window_enabled,
    );
  });

  it("时间窗口的 B<A 在合并后的完整节奏上校验：单值覆盖违约必现", () => {
    const base = baseScheme();
    // 基础 A=60；本群只把 B 改成 70 → 合并后 B>A。
    const bad = QqGroupSchemeOverridesSchema.parse({
      rhythm: { initiative_time_jitter_seconds: 70 },
    });
    const merged = mergeQqGroupScheme(base, bad);
    expect(QqSchemeRhythmSchema.safeParse(merged.rhythm).success).toBe(false);
    // 差异自身不携带完整关系（(10,10) 在稀疏层可解析），违约只可能在合并后判定，
    // 由保存边界（qq-group-config-repository）据此拒绝。
    const selfConflict = QqGroupSchemeOverridesSchema.parse({
      rhythm: { initiative_time_target_seconds: 10, initiative_time_jitter_seconds: 10 },
    });
    expect(
      QqSchemeRhythmSchema.safeParse(mergeQqGroupScheme(base, selfConflict).rhythm).success,
    ).toBe(false);
    // 越界在稀疏层就被拒，不必等合并；B<A 属于合并后的关系，稀疏层不判（与计数窗口同理）。
    expect(
      QqGroupSchemeOverridesSchema.safeParse({
        rhythm: { initiative_time_target_seconds: 1801 },
      }).success,
    ).toBe(false);
    expect(
      QqGroupSchemeOverridesSchema.safeParse({ rhythm: { initiative_time_jitter_seconds: 1800 } })
        .success,
    ).toBe(false);
  });

  it("resolveQqInteractionPair：三层覆盖、旧双真读作只自主、两项全关合法", () => {
    const scheme = { follow_up: false, chiming_in: true };
    expect(
      resolveQqInteractionPair({ scheme, binding: { follow_up: null, chiming_in: null } }),
    ).toEqual({ continuous: false, chimingIn: true });
    // 组合出的双 true 只可能是存量（新写已被保存边界拒绝），读取按 chiming_in 优先。
    expect(
      resolveQqInteractionPair({ scheme, binding: { follow_up: true, chiming_in: null } }),
    ).toEqual({ continuous: false, chimingIn: true });
    expect(
      resolveQqInteractionPair({
        scheme: { follow_up: false, chiming_in: false },
        binding: { follow_up: true, chiming_in: null },
        group: { follow_up: null, chiming_in: false },
      }),
    ).toEqual({ continuous: true, chimingIn: false });
    // 存量双 true：读取按 chiming_in 优先，不报错。
    expect(
      resolveQqInteractionPair({ scheme, binding: { follow_up: true, chiming_in: true } }),
    ).toEqual({ continuous: false, chimingIn: true });
    // 两项全关也是合法状态。
    expect(
      resolveQqInteractionPair({ scheme, binding: { follow_up: false, chiming_in: false } }),
    ).toEqual({ continuous: false, chimingIn: false });
  });

  it("isBothTrueInteractionPair 只对显式双 true 为真，null 不算", () => {
    expect(isBothTrueInteractionPair({ follow_up: true, chiming_in: true })).toBe(true);
    expect(isBothTrueInteractionPair({ follow_up: true, chiming_in: null })).toBe(false);
    expect(isBothTrueInteractionPair({ follow_up: null, chiming_in: true })).toBe(false);
  });
});

describe("生效对归一：mergeQqGroupScheme 与 raw 存量双 true", () => {
  it("基础方案 raw 双 true 时 effective triggers 按 chiming_in 优先，raw base 不被改写", () => {
    const base = baseScheme();
    // 显式构造 raw 双 true 的存量方案形状。
    const legacyBase = {
      ...base,
      triggers: { direct_reply: true, follow_up: true, chiming_in: true, idle_topic: false },
    };
    const merged = mergeQqGroupScheme(legacyBase, QqGroupSchemeOverridesSchema.parse({}));
    // 生效对归一：自主优先，连续不生效。
    expect(merged.triggers.follow_up).toBe(false);
    expect(merged.triggers.chiming_in).toBe(true);
    // 输入的 raw base 不被改写。
    expect(legacyBase.triggers.follow_up).toBe(true);
    expect(legacyBase.triggers.chiming_in).toBe(true);
    // 本群差异单开 follow_up，chiming_in 跟随 legacy 双 true → 组合双 true → 仍归一为只自主。
    const merged2 = mergeQqGroupScheme(
      legacyBase,
      QqGroupSchemeOverridesSchema.parse({ triggers: { follow_up: true, chiming_in: null } }),
    );
    expect(merged2.triggers.follow_up).toBe(false);
    expect(merged2.triggers.chiming_in).toBe(true);
  });
});
