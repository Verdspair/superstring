// 方案分组的纯规则测试：field→section 的唯一真源在 features/qq/scheme-field-metadata。
// 不挂 store、不渲染组件：只断言真实可编辑字段键的归属、6 个 section 的声明与别名定位。
// 与旧 4-Tab 无关：section id 由设计重定（context_reading/history_compression/...），
// 错误定位经 schemeFieldTask 消费同一份映射。

import { describe, expect, it } from "vitest";
import {
  QQ_SCHEME_FIELD_LABELS,
  QQ_SCHEME_SECTIONS,
  qqSchemeFieldSection,
} from "../../src/web/features/qq/scheme-field-metadata";
import { schemeFieldTask } from "../../src/web/screens/connections/scheme-fields";

const SECTION_IDS = [
  "participation",
  "response",
  "context_reading",
  "history_compression",
  "image_understanding",
  "sticker_sending",
] as const;

/** 真实可编辑字段键（canonical 持久键）→ 期望分组；与 LEAF-COVERAGE 的 scheme 编辑面一致。 */
const EXPECTED_SECTION: Readonly<Record<string, string>> = {
  // 发言时机
  "triggers.direct_reply": "participation",
  "triggers.follow_up": "participation",
  "triggers.chiming_in": "participation",
  "triggers.idle_topic": "participation",
  "rhythm.initiative_min_score": "participation",
  "rhythm.merge_window_seconds": "participation",
  "rhythm.reply_cooldown_seconds": "participation",
  "rhythm.hourly_speech_limit": "participation",
  "rhythm.idle_quiet_minutes": "participation",
  "rhythm.active_hours_enabled": "participation",
  "rhythm.active_hours_start_minutes": "participation",
  "rhythm.active_hours_end_minutes": "participation",
  "prompts.judge": "participation",
  // 回复方式
  "reply.split_by_speaker": "response",
  "prompts.scene": "response",
  "prompts.reply": "response",
  "prompts.review": "response",
  "rhythm.max_recompute_count": "response",
  // 消息读取
  "message_settings.reply_mode": "context_reading",
  "message_settings.reply_depth": "context_reading",
  "message_settings.time_display": "context_reading",
  "message_settings.timezone": "context_reading",
  "context.judgement_message_limit": "context_reading",
  "context.judgement_window_minutes": "context_reading",
  "context.judgement_token_budget": "context_reading",
  "output_reserve.judgement_output_reserved": "context_reading",
  "context.reply_window_minutes": "context_reading",
  "context.reply_token_budget": "context_reading",
  "output_reserve.reply_output_reserved": "context_reading",
  // 历史压缩
  "compression.watermark_trigger": "history_compression",
  "compression.package_limit": "history_compression",
  "compression.headroom_ratio": "history_compression",
  "prompts.compress": "history_compression",
  // 图片理解
  "media_input.mode": "image_understanding",
  "media_input.stages.decision": "image_understanding",
  "media_input.stages.evaluation": "image_understanding",
  "media_input.stages.generation": "image_understanding",
  "media_input.max_images": "image_understanding",
  "media_input.ordinary_still_max_dimension": "image_understanding",
  "media_input.expression_max_dimension": "image_understanding",
  "media_input.expression_frame_count": "image_understanding",
  "media_input.expression_frame_max_dimension": "image_understanding",
  "rhythm.media_supplement_window_minutes": "image_understanding",
  "rhythm.media_frame_count": "image_understanding",
  "rhythm.media_max_dimension": "image_understanding",
  "prompts.media": "image_understanding",
  // 表情发送
  "rhythm.max_sticker_count": "sticker_sending",
  "stickers.sticker_min_repeat_minutes": "sticker_sending",
  "stickers.sticker_recent_avoid_count": "sticker_sending",
  "sticker_collections.collection_ids": "sticker_sending",
  "prompts.sticker": "sticker_sending",
};

describe("scheme sections metadata", () => {
  it("declares exactly the six section ids with localized label keys", () => {
    expect(QQ_SCHEME_SECTIONS.map((s) => s.id)).toEqual([...SECTION_IDS]);
    expect(QQ_SCHEME_SECTIONS.map((s) => s.labelKey)).toEqual([
      "schemes.sections.participation",
      "schemes.sections.response",
      "schemes.sections.contextReading",
      "schemes.sections.historyCompression",
      "schemes.sections.imageUnderstanding",
      "schemes.sections.stickerSending",
    ]);
  });

  it("maps every real editable field key to the designed section", () => {
    for (const [field, section] of Object.entries(EXPECTED_SECTION)) {
      expect(qqSchemeFieldSection(field), field).toBe(section);
    }
    // 覆盖真实可编辑面：每个映射键都在字段文案映射里有 label，防止挪组时丢 label。
    for (const field of Object.keys(EXPECTED_SECTION)) {
      expect(QQ_SCHEME_FIELD_LABELS[field], field).toBeTruthy();
    }
  });

  it("locates editor camelCase aliases to the same section as canonical keys", () => {
    expect(qqSchemeFieldSection("outputReserve.reply_output_reserved")).toBe("context_reading");
    expect(qqSchemeFieldSection("messageSettings.timezone")).toBe("context_reading");
    expect(qqSchemeFieldSection("mediaInput.stages.decision")).toBe("image_understanding");
    expect(qqSchemeFieldSection("outputReserve.judgement_output_reserved")).toBe(
      qqSchemeFieldSection("output_reserve.judgement_output_reserved"),
    );
    expect(qqSchemeFieldSection("messageSettings.reply_mode")).toBe(
      qqSchemeFieldSection("message_settings.reply_mode"),
    );
    expect(qqSchemeFieldSection("mediaInput.mode")).toBe(qqSchemeFieldSection("media_input.mode"));
  });

  it("consumes the same mapping for error location (schemeFieldTask)", () => {
    for (const [field, section] of Object.entries(EXPECTED_SECTION)) {
      expect(schemeFieldTask(field), field).toBe(section);
    }
  });

  it("falls back to the participation section for unknown fields without throwing", () => {
    expect(qqSchemeFieldSection("unknown.field")).toBe("participation");
    expect(qqSchemeFieldSection("")).toBe("participation");
    expect(schemeFieldTask("something.else")).toBe("participation");
  });

  it("keeps max_recompute_count out of participation and in response", () => {
    // 该字段是"回复草稿再生成次数"，不是主动发言门槛：不能留在发言时机组。
    expect(qqSchemeFieldSection("rhythm.max_recompute_count")).toBe("response");
    expect(qqSchemeFieldSection("rhythm.initiative_min_score")).toBe("participation");
  });
});
