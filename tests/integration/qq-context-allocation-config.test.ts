// 统一上下文分配（0068）：模式契约、方案请求/响应、本群稀疏覆盖与仓储行读取的行为契约。

import { describe, expect, it } from "bun:test";
import { type QqSchemeRow, schemeAllocation } from "../../src/server/db/qq-scheme-repository";
import {
  AuxiliaryAllocationProfileSchema,
  contextAllocationMode,
} from "../../src/shared/contracts/context-allocation";
import {
  CreateQqSchemeRequestSchema,
  QqSchemeResponseSchema,
  UpdateQqSchemeRequestSchema,
} from "../../src/shared/contracts/qq";
import {
  mergeQqGroupScheme,
  type QqGroupSchemeOverrides,
} from "../../src/shared/contracts/qq-group-config";

describe("QQ scheme allocation contract (0068)", () => {
  it("create/update scheme requests accept the allocation group", () => {
    const allocation = { judgement: { mode: "auto" as const }, reply: { mode: "fixed" as const } };
    const created = CreateQqSchemeRequestSchema.safeParse({ name: "n", allocation });
    expect(created.success).toBe(true);
    const updated = UpdateQqSchemeRequestSchema.safeParse({
      name: "n",
      allocation,
      expected_revision: 1,
    });
    expect(updated.success).toBe(true);
  });

  it("old DTO compatibility: a scheme response without allocation still parses; null stays invalid", () => {
    const scheme = QqSchemeResponseSchema.parse({
      id: "01960000-0000-7000-8000-000000000001",
      name: "夹具方案",
      description: null,
      triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: false },
      rhythm: {
        participation_timing: "resource_window",
        merge_window_seconds: 30,
        reply_cooldown_seconds: 60,
        hourly_speech_limit: 20,
        initiative_min_score: 6,
        judgement_interval_turns: 1,
        idle_quiet_minutes: 30,
        active_hours_enabled: false,
        active_hours_start_minutes: 480,
        active_hours_end_minutes: 1380,
        max_recompute_count: 1,
        max_sticker_count: 1,
        media_frame_count: 3,
        media_max_dimension: 512,
        initiative_batch_target_count: 15,
        initiative_batch_jitter_count: 5,
        initiative_queue_on_busy: true,
        initiative_time_window_enabled: false,
        initiative_time_target_seconds: 60,
        initiative_time_jitter_seconds: 10,
      },
      context: {
        judgement_message_limit: 20,
        judgement_window_minutes: 60,
        judgement_token_budget: 2000,
        reply_message_limit: 60,
        reply_window_minutes: 360,
        reply_token_budget: 6000,
      },
      compression: { watermark_trigger: 200, package_limit: 8, headroom_ratio: 0.05 },
      output_reserve: { judgement_output_reserved: 512, reply_output_reserved: 2048 },
      stickers: {
        sticker_min_repeat_minutes: 10,
        sticker_recent_avoid_count: 5,
        frequency: "medium",
      },
      sticker_collections: { collection_ids: [] },
      prompts: {
        scene: "s",
        judge: "j",
        reply: "r",
        review: "v",
        sticker: "k",
        media: "m",
        compress: "默认压缩任务占位文本，满足非空校验的最小长度要求即可",
      },
      reply: { split_by_speaker: true },
      message_settings: {
        reply_mode: "configured_depth",
        reply_depth: 1,
        time_display: "hybrid",
        timezone: "Asia/Shanghai",
      },
      media_input: {
        mode: "native",
        stages: { decision: true, evaluation: false, generation: true },
        max_images: 3,
        ordinary_still_max_dimension: null,
      },
      task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
      input_anti_spam: { enabled: true, burst_min_messages: 3, burst_window_seconds: 3 },
      revision: 1,
      created_at: "2026-01-01T00:00:00.000000Z",
      updated_at: "2026-01-01T00:00:00.000000Z",
    });
    expect("allocation" in scheme).toBe(false);
    expect(QqSchemeResponseSchema.safeParse(scheme).success).toBe(true);
    expect(QqSchemeResponseSchema.safeParse({ ...scheme, allocation: null }).success).toBe(false);
  });

  it("group override merges per leaf and never obliterates the other mode", () => {
    const base = QqSchemeResponseSchema.parse({
      id: "01960000-0000-7000-8000-000000000002",
      name: "合并基准",
      description: null,
      triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: false },
      rhythm: {
        participation_timing: "resource_window",
        merge_window_seconds: 30,
        reply_cooldown_seconds: 60,
        hourly_speech_limit: 20,
        initiative_min_score: 6,
        judgement_interval_turns: 1,
        idle_quiet_minutes: 30,
        active_hours_enabled: false,
        active_hours_start_minutes: 480,
        active_hours_end_minutes: 1380,
        max_recompute_count: 1,
        max_sticker_count: 1,
        media_frame_count: 3,
        media_max_dimension: 512,
        initiative_batch_target_count: 15,
        initiative_batch_jitter_count: 5,
        initiative_queue_on_busy: true,
        initiative_time_window_enabled: false,
        initiative_time_target_seconds: 60,
        initiative_time_jitter_seconds: 10,
      },
      context: {
        judgement_message_limit: 20,
        judgement_window_minutes: 60,
        judgement_token_budget: 2000,
        reply_message_limit: 60,
        reply_window_minutes: 360,
        reply_token_budget: 6000,
      },
      compression: { watermark_trigger: 200, package_limit: 8, headroom_ratio: 0.05 },
      output_reserve: { judgement_output_reserved: 512, reply_output_reserved: 2048 },
      stickers: {
        sticker_min_repeat_minutes: 10,
        sticker_recent_avoid_count: 5,
        frequency: "medium",
      },
      sticker_collections: { collection_ids: [] },
      prompts: {
        scene: "s",
        judge: "j",
        reply: "r",
        review: "v",
        sticker: "k",
        media: "m",
        compress: "默认压缩任务占位文本，满足非空校验的最小长度要求即可",
      },
      reply: { split_by_speaker: true },
      message_settings: {
        reply_mode: "configured_depth",
        reply_depth: 1,
        time_display: "hybrid",
        timezone: "Asia/Shanghai",
      },
      media_input: {
        mode: "native",
        stages: { decision: true, evaluation: false, generation: true },
        max_images: 3,
        ordinary_still_max_dimension: null,
      },
      task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
      input_anti_spam: { enabled: true, burst_min_messages: 3, burst_window_seconds: 3 },
      revision: 1,
      created_at: "2026-01-01T00:00:00.000000Z",
      updated_at: "2026-01-01T00:00:00.000000Z",
      allocation: { judgement: { mode: "fixed" }, reply: { mode: "auto" } },
    });
    const overrides = {
      allocation: { judgement: { mode: "auto" } },
    } as unknown as QqGroupSchemeOverrides;
    const merged = mergeQqGroupScheme(base, overrides);
    // 判断档被本群覆盖为 auto；回复档保持方案的 auto——浅合并会把它冲掉。
    expect(merged.allocation).toEqual({
      judgement: { mode: "auto" },
      reply: { mode: "auto" },
    });
    // 空覆盖＝完全跟随方案。
    const untouched = mergeQqGroupScheme(base, {} as QqGroupSchemeOverrides);
    expect(untouched.allocation).toEqual(base.allocation);
  });
});

describe("QQ scheme allocation repository read (0068)", () => {
  it("NULL column falls back to both-fixed (legacy protected absence)", () => {
    const row = { allocation: null } as unknown as QqSchemeRow;
    expect(schemeAllocation(row)).toEqual({
      judgement: { mode: "fixed" },
      reply: { mode: "fixed" },
    });
  });

  it("a present but invalid stored value throws, never falls back", () => {
    expect(() =>
      schemeAllocation({ allocation: '{"judgement":{"mode":"bogus"}}' } as unknown as QqSchemeRow),
    ).toThrow(TypeError);
    expect(() =>
      schemeAllocation({ allocation: '{"judgement":{"mode":"auto"}}' } as unknown as QqSchemeRow),
    ).toThrow(TypeError);
    expect(() => schemeAllocation({ allocation: "not-json" } as unknown as QqSchemeRow)).toThrow(
      TypeError,
    );
  });

  it("a valid stored value round-trips strictly", () => {
    expect(
      schemeAllocation({
        allocation: '{"judgement":{"mode":"auto"},"reply":{"mode":"auto"}}',
      } as unknown as QqSchemeRow),
    ).toEqual({ judgement: { mode: "auto" }, reply: { mode: "auto" } });
  });
});

describe("allocation mode helper and aux profile contract (0068)", () => {
  it("contextAllocationMode treats absence as fixed and passes validated modes through", () => {
    expect(contextAllocationMode(undefined)).toBe("fixed");
    expect(contextAllocationMode(null)).toBe("fixed");
    expect(contextAllocationMode({ mode: "auto" })).toBe("auto");
    expect(contextAllocationMode({ mode: "fixed" })).toBe("fixed");
  });

  it("aux profile accepts hard limits and explicit null, rejects unknown keys and bogus modes", () => {
    expect(
      AuxiliaryAllocationProfileSchema.safeParse({
        mode: "auto",
        input_limit: 4096,
        output_reserved: null,
      }).success,
    ).toBe(true);
    expect(AuxiliaryAllocationProfileSchema.safeParse({ mode: "fixed" }).success).toBe(true);
    expect(
      AuxiliaryAllocationProfileSchema.safeParse({ mode: "bogus", input_limit: 1 }).success,
    ).toBe(false);
    expect(AuxiliaryAllocationProfileSchema.safeParse({ mode: "auto", extra: 1 }).success).toBe(
      false,
    );
  });
});
