import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";
import {
  invalidSchemeInputs,
  invalidSchemeTimezone,
  qqDraftChanges,
} from "../../src/web/features/qq/draft-state";
import {
  qqSchemeChanges,
  qqSchemeDirty,
  qqSchemeEditorFrom,
} from "../../src/web/features/qq/types";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-10-02T00:00:00.000Z";
const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: "22222222-2222-4222-8222-222222222222",
  name: "默认方案",
  description: null,
  triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
  reply: { split_by_speaker: true },
  rhythm: {
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
    media_supplement_window_minutes: 10,
    media_frame_count: 3,
    media_max_dimension: 512,
    initiative_batch_target_count: 15,
    initiative_batch_jitter_count: 5,
    initiative_queue_on_busy: true,
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
  stickers: { sticker_min_repeat_minutes: 10, sticker_recent_avoid_count: 5 },
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
    expression_max_dimension: 512,
    expression_frame_count: 3,
    expression_frame_max_dimension: 512,
  },
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

describe("0052 两组进方案编辑器（T13）", () => {
  it("editor 复制完整 messageSettings/mediaInput 及 stages 深复制；编辑不写回 source", () => {
    const source = scheme();
    const editor = qqSchemeEditorFrom(source);
    expect(editor.messageSettings).toEqual(source.message_settings);
    expect(editor.mediaInput).toEqual(source.media_input);
    // 深复制：改编辑器不污染目录行对象。
    editor.mediaInput.stages.evaluation = false;
    editor.messageSettings.reply_depth = 4;
    editor.mediaInput.ordinary_still_max_dimension = 512;
    expect(source.media_input.stages.evaluation).toBe(true);
    expect(source.message_settings.reply_depth).toBe(2);
    expect(source.media_input.ordinary_still_max_dimension).toBeNull();
  });

  it("null 原图与 undefined/跟随区分：null 是真实值，逐叶子比较不把 null 混成对象差异", () => {
    const editor = qqSchemeEditorFrom(scheme());
    expect(qqSchemeDirty(editor)).toBe(false);
    // null 原图钉住到 512 是改动。
    editor.mediaInput.ordinary_still_max_dimension = 512;
    expect(qqSchemeChanges(editor)).toContainEqual({
      field: "media_input.ordinary_still_max_dimension",
      before: "null",
      after: "512",
    });
    editor.mediaInput.ordinary_still_max_dimension = null;
    expect(qqSchemeDirty(editor)).toBe(false);
  });

  it("stages 三个布尔逐项比较：改 evaluation 不把另外两项变脏", () => {
    const editor = qqSchemeEditorFrom(scheme());
    editor.mediaInput.stages.evaluation = false;
    expect(qqSchemeChanges(editor)).toEqual([
      { field: "media_input.stages.evaluation", before: "true", after: "false" },
    ]);
    editor.mediaInput.stages.evaluation = true;
    expect(qqSchemeDirty(editor)).toBe(false);
  });

  it("message_settings 逐叶子比较（含时区与枚举），draft 无多余改动行", () => {
    const editor = qqSchemeEditorFrom(scheme());
    editor.messageSettings.timezone = "Asia/Tokyo";
    editor.messageSettings.time_display = "full_relative";
    editor.messageSettings.reply_mode = "configured_depth";
    expect(qqSchemeChanges(editor)).toEqual([
      {
        field: "message_settings.reply_mode",
        before: "one_then_on_demand",
        after: "configured_depth",
      },
      { field: "message_settings.time_display", before: "hybrid", after: "full_relative" },
      { field: "message_settings.timezone", before: "Asia/Shanghai", after: "Asia/Tokyo" },
    ]);
  });

  it("media_input 标量逐叶子比较：max_images / expression 规格", () => {
    const editor = qqSchemeEditorFrom(scheme());
    editor.mediaInput.max_images = 4;
    editor.mediaInput.expression_frame_count = 5;
    const fields = qqSchemeChanges(editor).map((change) => change.field);
    expect(fields).toContain("media_input.max_images");
    expect(fields).toContain("media_input.expression_frame_count");
    expect(fields).not.toContain("media_input.stages");
  });
});

function resetForScheme(overrides: Partial<QqSchemeResponse> = {}, apiOverrides: object = {}) {
  const row = scheme(overrides);
  const fake = {
    listQqSchemes: vi.fn(async () => [row]),
    getQqSchemeUsage: vi.fn(async (id: string) => ({ scheme_id: id, bindings: 0 })),
    updateQqScheme: vi.fn(async (id: string, body: unknown) =>
      scheme({ ...(body as object), id, revision: 4 }),
    ),
    createQqScheme: vi.fn(async (body: unknown) =>
      scheme({ id: "55555555-5555-4555-8555-555555555555", ...(body as object), revision: 1 }),
    ),
    ...apiOverrides,
  };
  store.getState().resetForTests(fake as never);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
    qqSchemes: [row],
    qqSchemeEditor: qqSchemeEditorFrom(row),
  });
  return fake as {
    updateQqScheme: ReturnType<typeof vi.fn>;
    createQqScheme: ReturnType<typeof vi.fn>;
  };
}

const editorOf = () => {
  const editor = store.getState().qqSchemeEditor;
  if (!editor) throw new Error("scheme editor not loaded");
  return editor;
};

describe("0052 两组的真实保存链路（T13）", () => {
  beforeEach(() => {
    store.getState().resetForTests();
  });

  it("保存载荷带两组（含 stages 深复制与 null 原图）", async () => {
    const fake = resetForScheme();
    // 直接改编辑器（模拟页内 patchQqSchemeGroup 的效果）。
    const editor = editorOf();
    store.setState({
      qqSchemeEditor: {
        ...editor,
        mediaInput: {
          ...editor.mediaInput,
          stages: { ...editor.mediaInput.stages, evaluation: false },
          max_images: 4,
        },
        messageSettings: { ...editor.messageSettings, timezone: "Asia/Tokyo" },
      },
    });
    expect(await store.getState().saveQqScheme()).toBe(true);
    const sent = fake.updateQqScheme.mock.calls[0][1] as Record<string, unknown>;
    expect(sent.message_settings).toEqual({
      reply_mode: "one_then_on_demand",
      reply_depth: 2,
      time_display: "hybrid",
      timezone: "Asia/Tokyo",
    });
    expect(sent.media_input).toEqual({
      mode: "native",
      stages: { decision: true, evaluation: false, generation: true },
      max_images: 4,
      ordinary_still_max_dimension: null,
      expression_max_dimension: 512,
      expression_frame_count: 3,
      expression_frame_max_dimension: 512,
    });
  });

  it("另存为新方案（create 通道）带两组，不静默丢自定义", async () => {
    const fake = resetForScheme();
    const editor = editorOf();
    store.setState({
      qqSchemeEditor: {
        ...editor,
        mediaInput: {
          ...editor.mediaInput,
          max_images: 6,
          ordinary_still_max_dimension: 1024,
        },
        messageSettings: { ...editor.messageSettings, reply_mode: "configured_depth" },
      },
    });
    expect(await store.getState().duplicateQqScheme("副本")).toBe(true);
    const sent = fake.createQqScheme.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.message_settings).toMatchObject({ reply_mode: "configured_depth" });
    expect(sent.media_input).toMatchObject({
      max_images: 6,
      ordinary_still_max_dimension: 1024,
    });
  });

  it("显式刷新保稿：已改叶子保留（含 stages 单项与 null 原图），未改叶子跟随新答案", async () => {
    const fresh = scheme({
      revision: 9,
      message_settings: {
        reply_mode: "configured_depth",
        reply_depth: 5,
        time_display: "full",
        timezone: "Asia/Tokyo",
      },
      media_input: {
        mode: "description",
        stages: { decision: false, evaluation: true, generation: true },
        max_images: 3,
        ordinary_still_max_dimension: 2048,
        expression_max_dimension: 256,
        expression_frame_count: 2,
        expression_frame_max_dimension: 128,
      },
    });
    resetForScheme();
    // refreshQqScheme 读目录：返回 [当前, fresh]，mergeFreshSource 按 id 匹配当前编辑器。
    // fresh 的 id 必须与当前编辑器一致（同 id 的新基线），否则 find 会匹配到旧行。
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        listQqSchemes: vi.fn(async () => [fresh]),
        getQqSchemeUsage: vi.fn(async (id: string) => ({ scheme_id: id, bindings: 0 })),
      },
    } as never);
    // 本地改动：改 max_images、generation、普通静图原图值（有改动）；其余不动。
    const editor = editorOf();
    store.setState({
      qqSchemeEditor: {
        ...editor,
        mediaInput: {
          ...editor.mediaInput,
          max_images: 6,
          stages: { ...editor.mediaInput.stages, generation: false },
          ordinary_still_max_dimension: 1024,
        },
      },
    });
    expect(await store.getState().refreshQqScheme()).toBe(true);
    const next = editorOf();
    // 已改叶子保留草稿。
    expect(next.mediaInput.max_images).toBe(6);
    expect(next.mediaInput.stages.generation).toBe(false);
    expect(next.mediaInput.ordinary_still_max_dimension).toBe(1024);
    // 未改叶子跟随新基线（含 message_settings 整组未改 → 全跟）。
    expect(next.messageSettings).toEqual(fresh.message_settings);
    expect(next.mediaInput.mode).toBe("description");
    expect(next.mediaInput.stages.decision).toBe(false);
    expect(next.mediaInput.expression_frame_count).toBe(2);
    expect(next.source.revision).toBe(9);
  });

  it("显式刷新保留非法时区原文；修正后保存才通过", async () => {
    resetForScheme();
    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        schemeTexts: { "message_settings.timezone": "Not/AZone" },
      },
    });
    const fresh = scheme({ revision: 9, name: "别处改过" });
    store.setState({
      qqSchemes: [scheme(), fresh],
    });
    const fakeList = vi.fn(async () => [scheme(), fresh]);
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        listQqSchemes: fakeList,
        getQqSchemeUsage: vi.fn(async (id: string) => ({ scheme_id: id, bindings: 0 })),
      },
    } as never);
    expect(await store.getState().refreshQqScheme()).toBe(true);
    expect(store.getState().qqInputs.schemeTexts["message_settings.timezone"]).toBe("Not/AZone");
    expect(invalidSchemeTimezone(store.getState())).toBe("message_settings.timezone");
    // 全局草稿预览把非法时区当草稿行（导航守卫据此拦住未决导航）。
    expect(
      qqDraftChanges(store.getState()).some((row) =>
        row.changes.some((text) => text.includes("Not/AZone")),
      ),
    ).toBe(true);
    // 页内保存被拦。
    expect(await store.getState().saveQqScheme()).toBe(false);
  });

  it("非法时区拦统一保存与复制（导航确认里的保存路径）", async () => {
    const fake = resetForScheme();
    const editor = editorOf();
    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        schemeTexts: { "message_settings.timezone": "Mars/Olympus" },
      },
      qqSchemeEditor: {
        ...editor,
        // 方案同时有真实改动：非法时区必须先拦，unified/save 不能带着它发任何请求。
        mediaInput: { ...editor.mediaInput, max_images: 5 },
        messageSettings: {
          ...editor.messageSettings,
          timezone: "Asia/Shanghai",
        },
      },
    });
    expect(await store.getState().saveQqDrafts()).toBe(false);
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(await store.getState().duplicateQqScheme("副本")).toBe(false);
    expect(fake.createQqScheme).not.toHaveBeenCalled();
    expect(await store.getState().saveQqScheme()).toBe(false);
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
  });

  it("显式刷新：三个 stage 叶子独立 carry，未改相位跟 fresh", async () => {
    const fresh = scheme({
      revision: 11,
      media_input: {
        ...scheme().media_input,
        stages: { decision: false, evaluation: false, generation: false },
      },
    });
    resetForScheme();
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        listQqSchemes: vi.fn(async () => [fresh]),
        getQqSchemeUsage: vi.fn(async (id: string) => ({ scheme_id: id, bindings: 0 })),
      },
    } as never);
    // 三个相位全部本地改动并各自翻转：刷新后全部保留草稿值，不跟 fresh。
    const editor = editorOf();
    store.setState({
      qqSchemeEditor: {
        ...editor,
        mediaInput: {
          ...editor.mediaInput,
          stages: {
            ...editor.mediaInput.stages,
            decision: false,
            evaluation: false,
            generation: false,
          },
        },
      },
    });
    expect(await store.getState().refreshQqScheme()).toBe(true);
    const carried = editorOf();
    expect(carried.mediaInput.stages).toEqual({
      decision: false,
      evaluation: false,
      generation: false,
    });
    expect(carried.source.revision).toBe(11);
    // 反向：stages 与当前 source 相同（无 stage 改动），再换一份 stages 不同的 fresh：
    // 三个相位都未改 → 全部跟随新基线。
    const reset = editorOf();
    store.setState({
      qqSchemeEditor: {
        ...reset,
        mediaInput: { ...reset.mediaInput, stages: { ...reset.source.media_input.stages } },
      },
    });
    const fresh2 = scheme({
      revision: 12,
      media_input: {
        ...scheme().media_input,
        stages: { decision: true, evaluation: false, generation: true },
      },
    });
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        listQqSchemes: vi.fn(async () => [fresh2]),
        getQqSchemeUsage: vi.fn(async (id: string) => ({ scheme_id: id, bindings: 0 })),
      },
    } as never);
    expect(await store.getState().refreshQqScheme()).toBe(true);
    const followed = editorOf();
    expect(followed.mediaInput.stages).toEqual(fresh2.media_input.stages);
    expect(followed.source.revision).toBe(12);
  });

  // ---- T13a 收尾：canonical 两组 raw key 的解析与严格 schema 边界 -----------------------

  it("RED: 合法时区原文允许保存（不是只测非法拒）", async () => {
    const fake = resetForScheme();
    // T13b 约定：canonical key 写 schemeTexts，合法原文随 blur 写入编辑器并清除原文。
    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        schemeTexts: {},
      },
      qqSchemeEditor: {
        ...editorOf(),
        messageSettings: { ...editorOf().messageSettings, timezone: "Asia/Tokyo" },
      },
    });
    expect(invalidSchemeTimezone(store.getState())).toBeNull();
    expect(invalidSchemeInputs(store.getState())).toEqual([]);
    expect(await store.getState().saveQqScheme()).toBe(true);
    const sent = fake.updateQqScheme.mock.calls[0][1] as Record<string, unknown>;
    expect((sent.message_settings as { timezone: string }).timezone).toBe("Asia/Tokyo");
  });

  it("RED: 编辑器本身非法的相同时区字符串不能靠字符串相等逃过校验", () => {
    resetForScheme();
    // 构造一个非法字符串直接写进编辑器（绕过页面输入链路，模拟异常或外部写入）。
    const editor = editorOf();
    store.setState({
      qqSchemeEditor: {
        ...editor,
        messageSettings: { ...editor.messageSettings, timezone: "Mars/Olympus" },
      },
      qqInputs: { ...store.getState().qqInputs, schemeTexts: {} },
    });
    // raw 不存在时不拦（没有未决原文）；一旦用户触碰原文，即使 current == raw 也要按 schema 拒。
    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        schemeTexts: { "message_settings.timezone": "Mars/Olympus" },
      },
    });
    expect(invalidSchemeTimezone(store.getState())).toBe("message_settings.timezone");
  });

  it("RED: 时区原文不再被 Number() 当无效数字；新 canonical 数值字段可解析到编辑器", () => {
    const editor = qqSchemeEditorFrom(scheme());
    const state = {
      qqSchemeEditor: editor,
      qqInputs: { schemeTexts: { "message_settings.timezone": "Asia/Tokyo" } },
    } as unknown as Parameters<typeof invalidSchemeInputs>[0];
    // timezone 是字符串：绝不能进 Number() 被判无效。
    expect(invalidSchemeInputs(state)).toEqual([]);
    // 新 canonical 数值字段：合法数字解析到编辑器对应叶子，不判无效。
    const numericState = {
      qqSchemeEditor: qqSchemeEditorFrom(
        scheme({ media_input: { ...scheme().media_input, max_images: 4 } }),
      ),
      qqInputs: { schemeTexts: { "media_input.max_images": "4" } },
    } as unknown as Parameters<typeof invalidSchemeInputs>[0];
    expect(invalidSchemeInputs(numericState)).toEqual([]);
    // 非法数字（与编辑器不一致）：保留原文并拦。
    const invalidState = {
      qqSchemeEditor: editor,
      qqInputs: { schemeTexts: { "media_input.max_images": "3.5" } },
    } as unknown as Parameters<typeof invalidSchemeInputs>[0];
    expect(invalidSchemeInputs(invalidState)).toEqual([["media_input.max_images", "3.5"]]);
  });

  it("RED: 0 仍是非法的 ordinary_still_max_dimension 原文（不用 0 编码 null 原图）", () => {
    const editor = qqSchemeEditorFrom(scheme());
    const state = {
      qqSchemeEditor: editor,
      qqInputs: { schemeTexts: { "media_input.ordinary_still_max_dimension": "0" } },
    } as unknown as Parameters<typeof invalidSchemeInputs>[0];
    expect(invalidSchemeInputs(state)).toEqual([["media_input.ordinary_still_max_dimension", "0"]]);
  });

  it("RED: 小数/空原文保留 raw 且 page/duplicate/unified 全部 0 请求", async () => {
    const fake = resetForScheme();
    const editor = editorOf();
    store.setState({
      qqSchemeEditor: editor,
      qqInputs: {
        ...store.getState().qqInputs,
        schemeTexts: { "media_input.expression_frame_count": "" },
        schemeInvalid: { "media_input.expression_frame_count": "需要 1–10 之间的整数" },
      },
    });
    expect((await store.getState().saveQqScheme()) === false).toBe(true);
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(await store.getState().duplicateQqScheme("副本")).toBe(false);
    expect(fake.createQqScheme).not.toHaveBeenCalled();
    expect(await store.getState().saveQqDrafts()).toBe(false);
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(fake.createQqScheme).not.toHaveBeenCalled();
  });

  it("RED: null 原图载荷原样发出（显式 null，不是 0/undefined）", async () => {
    const fake = resetForScheme();
    const editor = editorOf();
    // 从数值改回 null（原图），再保存：payload 里必须是显式 null。
    store.setState({
      qqSchemeEditor: {
        ...editor,
        mediaInput: { ...editor.mediaInput, ordinary_still_max_dimension: null },
      },
    });
    expect(await store.getState().saveQqScheme()).toBe(true);
    const sent = fake.updateQqScheme.mock.calls[0][1] as Record<string, unknown>;
    const media = sent.media_input as Record<string, unknown>;
    expect(media.ordinary_still_max_dimension).toBeNull();
    expect("ordinary_still_max_dimension" in media).toBe(true);
  });

  it("RED: deep stage 编辑不污染目录行 source（qqSchemeChanges 不把 stages 当对象差异）", () => {
    const source = scheme();
    const editor = qqSchemeEditorFrom(source);
    editor.mediaInput.stages.decision = false;
    const fields = qqSchemeChanges(editor).map((change) => change.field);
    expect(fields).toContain("media_input.stages.decision");
    expect(source.media_input.stages.decision).toBe(true);
  });

  // ---- T13a fix1：canonical reply_depth schema 映射与编辑器终验边界 ----

  it("fix1: 合法 reply_depth 原文（raw '4'）不判无效；save/duplicate/unified 全放行且载荷正确", async () => {
    const fake = resetForScheme();
    const editor = editorOf();
    store.setState({
      qqSchemeEditor: {
        ...editor,
        // 合法 raw 聚焦未 blur：页面 onChange 已写编辑器（4），raw 留在 schemeTexts。
        messageSettings: {
          ...editor.messageSettings,
          reply_mode: "configured_depth",
          reply_depth: 4,
        },
      },
      qqInputs: {
        ...store.getState().qqInputs,
        schemeTexts: { "message_settings.reply_depth": "4" },
      },
    });
    expect(invalidSchemeInputs(store.getState())).toEqual([]);
    expect(await store.getState().saveQqScheme()).toBe(true);
    const sent = fake.updateQqScheme.mock.calls[0][1] as Record<string, unknown>;
    expect(sent.message_settings).toMatchObject({ reply_mode: "configured_depth", reply_depth: 4 });
    // duplicate 与 unified 同守卫：合法 raw 不拦任何一路。
    const fake2 = resetForScheme();
    store.setState({
      qqSchemeEditor: {
        ...editorOf(),
        messageSettings: { ...editorOf().messageSettings, reply_depth: 4 },
      },
      qqInputs: {
        ...store.getState().qqInputs,
        schemeTexts: { "message_settings.reply_depth": "4" },
      },
    });
    expect(await store.getState().duplicateQqScheme("副本")).toBe(true);
    expect(
      (fake2.createQqScheme.mock.calls[0][0] as Record<string, unknown>).message_settings,
    ).toMatchObject({ reply_depth: 4 });
    const fake3 = resetForScheme();
    store.setState({
      qqSchemeEditor: {
        ...editorOf(),
        messageSettings: { ...editorOf().messageSettings, reply_depth: 4 },
      },
      qqInputs: {
        ...store.getState().qqInputs,
        schemeTexts: { "message_settings.reply_depth": "4" },
      },
    });
    expect(await store.getState().saveQqDrafts()).toBe(true);
    expect(fake3.updateQqScheme).toHaveBeenCalledTimes(1);
  });

  it("fix1: 非法 reply_depth 原文（0/9/1.5/空）保留 raw 且 page/duplicate/unified 全 0 请求", async () => {
    const fake = resetForScheme();
    for (const raw of ["0", "9", "1.5", "", " "]) {
      const editor = editorOf();
      store.setState({
        qqSchemeEditor: {
          ...editor,
          messageSettings: { ...editor.messageSettings, reply_mode: "configured_depth" },
        },
        qqInputs: {
          ...store.getState().qqInputs,
          schemeTexts: { "message_settings.reply_depth": raw },
        },
      });
      expect(invalidSchemeInputs(store.getState())).toEqual([
        ["message_settings.reply_depth", raw],
      ]);
    }
    const blocking = editorOf();
    store.setState({
      qqSchemeEditor: {
        ...blocking,
        messageSettings: { ...blocking.messageSettings, reply_mode: "configured_depth" },
      },
      qqInputs: {
        ...store.getState().qqInputs,
        schemeTexts: { "message_settings.reply_depth": "9" },
      },
    });
    expect(await store.getState().saveQqScheme()).toBe(false);
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(await store.getState().duplicateQqScheme("副本")).toBe(false);
    expect(fake.createQqScheme).not.toHaveBeenCalled();
    expect(await store.getState().saveQqDrafts()).toBe(false);
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(fake.createQqScheme).not.toHaveBeenCalled();
  });

  it("fix1: 编辑器本身越界的 reply_depth（无 raw）也拦 page/duplicate/unified", async () => {
    const fake = resetForScheme();
    const editor = editorOf();
    store.setState({
      qqSchemeEditor: {
        ...editor,
        messageSettings: {
          ...editor.messageSettings,
          reply_depth: 9,
          reply_mode: "configured_depth",
        },
      },
      qqInputs: { ...store.getState().qqInputs, schemeTexts: {} },
    });
    expect(await store.getState().saveQqScheme()).toBe(false);
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(await store.getState().duplicateQqScheme("副本")).toBe(false);
    expect(fake.createQqScheme).not.toHaveBeenCalled();
    expect(await store.getState().saveQqDrafts()).toBe(false);
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(fake.createQqScheme).not.toHaveBeenCalled();
  });
});
