import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QqSchemeAllocation } from "../../src/shared/contracts/context-allocation";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";
import { qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-10-18T00:00:00.000Z";

const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: "22222222-2222-4222-8222-222222222222",
  name: "默认方案",
  description: null,
  triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
  reply: { split_by_speaker: true },
  rhythm: {
    participation_timing: "resource_window",
    merge_window_seconds: 30,
    reply_cooldown_seconds: 10,
    hourly_speech_limit: 200,
    initiative_min_score: 6,
    judgement_interval_turns: 3,
    idle_quiet_minutes: 15,
    active_hours_enabled: false,
    active_hours_start_minutes: 0,
    active_hours_end_minutes: 1439,
    max_recompute_count: 1,
    max_sticker_count: 1,
    media_frame_count: 3,
    media_max_dimension: 512,
    initiative_batch_target_count: 15,
    initiative_batch_jitter_count: 5,
    initiative_queue_on_busy: true,
    initiative_time_window_enabled: true,
    initiative_time_target_seconds: 60,
    initiative_time_jitter_seconds: 20,
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
  stickers: { sticker_min_repeat_minutes: 10, sticker_recent_avoid_count: 5, frequency: "medium" },
  sticker_collections: { collection_ids: [] },
  prompts: {
    scene: "场景提示词",
    judge: "判断提示词",
    reply: "回复提示词",
    review: "复核提示词",
    sticker: "选图提示词",
    media: "媒体提示词",
    compress: "压缩提示词",
  },
  message_settings: {
    reply_mode: "one_then_on_demand",
    reply_depth: 2,
    time_display: "hybrid",
    timezone: "Asia/Shanghai",
  },
  media_input: {
    mode: "native",
    stages: { decision: true, evaluation: true, generation: true },
    max_images: 8,
    ordinary_still_max_dimension: null,
  },
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
  input_anti_spam: { enabled: false, burst_min_messages: 3, burst_window_seconds: 3 },
  allocation: { judgement: { mode: "fixed" }, reply: { mode: "fixed" } },
  ...overrides,
});

// create 通道省略未提供的组，服务端按默认值落库。fake 与服务端同一规矩：
// 载荷没有 allocation 时，新方案回读就是 fixed/fixed。
function resetForScheme(overrides: Partial<QqSchemeResponse> = {}) {
  const row = scheme(overrides);
  const fake = {
    listQqSchemes: vi.fn(async () => [row]),
    getQqSchemeUsage: vi.fn(async (id: string) => ({ scheme_id: id, bindings: 0 })),
    updateQqScheme: vi.fn(async (id: string, body: unknown) =>
      scheme({ ...(body as Partial<QqSchemeResponse>), id, revision: 4 }),
    ),
    createQqScheme: vi.fn(async (body: unknown) =>
      scheme({
        id: "55555555-5555-4555-8555-555555555555",
        ...(body as Partial<QqSchemeResponse>),
        revision: 1,
      }),
    ),
  };
  store.getState().resetForTests(fake as never);
  store.setState({ qqSchemes: [row], qqSchemeEditor: qqSchemeEditorFrom(row) });
  return fake;
}

const editorOf = () => {
  const editor = store.getState().qqSchemeEditor;
  if (!editor) throw new Error("scheme editor not loaded");
  return editor;
};

describe("QQ 方案另存保留上下文分配模式", () => {
  beforeEach(() => {
    store.getState().resetForTests();
  });

  it("判断 auto、回复 fixed 的已存方案：create 载荷与原值一致，新方案编辑器不回退 fixed", async () => {
    const allocation: QqSchemeAllocation = {
      judgement: { mode: "auto" },
      reply: { mode: "fixed" },
    };
    const fake = resetForScheme({ allocation });
    const sourceContext = editorOf().source.context;

    expect(await store.getState().duplicateQqScheme("副本")).toBe(true);

    const sent = fake.createQqScheme.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.allocation).toEqual({ judgement: { mode: "auto" }, reply: { mode: "fixed" } });
    expect(sent.context).toEqual(sourceContext);

    // 载荷省略 allocation 时服务端会落成 fixed/fixed；另存后的编辑器必须仍显示源方案的模式。
    const created = editorOf();
    expect(created.source.allocation).toEqual({
      judgement: { mode: "auto" },
      reply: { mode: "fixed" },
    });
    expect(created.allocation).toEqual({
      judgement: { mode: "auto" },
      reply: { mode: "fixed" },
    });
  });

  it("判断与回复都 auto 的已存方案：改了其他草稿后另存，allocation 仍两档 auto 且 context 草稿一并带上", async () => {
    const allocation: QqSchemeAllocation = {
      judgement: { mode: "auto" },
      reply: { mode: "auto" },
    };
    const fake = resetForScheme({ allocation });
    const editor = editorOf();
    store.setState({
      qqSchemeEditor: {
        ...editor,
        context: { ...editor.context, reply_token_budget: 7777 },
      },
    });

    expect(await store.getState().duplicateQqScheme("副本")).toBe(true);

    const sent = fake.createQqScheme.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.allocation).toEqual({ judgement: { mode: "auto" }, reply: { mode: "auto" } });
    expect(sent.context).toMatchObject({ reply_token_budget: 7777 });
    expect(editorOf().allocation).toEqual({
      judgement: { mode: "auto" },
      reply: { mode: "auto" },
    });
  });
});
