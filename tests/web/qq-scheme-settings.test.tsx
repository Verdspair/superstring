// QQ 聊天方案页 (§5.2/§11.2, ADR0018 P5f).
//
// The cases follow the page's promises: one shared draft for the whole parameter set, a save that
// carries it under compare-and-swap, `另存为新方案` that leaves the original alone, a delete that
// says how many conversations would be affected, and the two things §11.1 keeps OFF this page —
// model selection and rebinding — asserted by absence.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema } from "../../src/shared/contracts";
import {
  QQ_REPLY_DEFAULT_PROMPT,
  QQ_REPLY_SPLIT_PROMPT,
  QqBindingResponseSchema,
  type QqSchemeResponse,
} from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { useSuperstringStore as store } from "../../src/web/store";
import { NavigationGuard as NavigationConfirm } from "../../src/web/workspace/NavigationGuard";

const NOW = "2026-09-24T00:00:00.000Z";
const COLLECTION = "11111111-1111-4111-8111-111111111111";
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
    // 0036: 每 X 条群友消息才真跑一次判断（间隔内复用上次读数）。
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
  // 0052：响应契约收紧后两组必填，夹具照完整响应形状造。
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

function client(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    listQqSchemes: vi.fn().mockResolvedValue([scheme()]),
    getQqSchemeUsage: vi.fn().mockResolvedValue({
      scheme_id: scheme().id,
      bindings: 2,
    }),
    listQqStickerCollections: vi.fn().mockResolvedValue([
      {
        id: COLLECTION,
        name: "日常",
        description: null,
        revision: 1,
        asset_count: 1,
      },
    ]),
    listQqStickerAssets: vi.fn().mockResolvedValue([]),
    updateQqScheme: vi
      .fn()
      .mockImplementation(async (_id: string, body: unknown) =>
        scheme({ ...(body as object), revision: 4 }),
      ),
    createQqScheme: vi
      .fn()
      .mockImplementation(async (body: unknown) =>
        scheme({ id: "55555555-5555-4555-8555-555555555555", ...(body as object), revision: 1 }),
      ),
    deleteQqScheme: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as typeof api;
}

async function renderPage(overrides: Partial<typeof api> = {}) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
  });
  render(<SchemeStudio />);
  await act(async () => {});
  return { fake };
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("Shared scheme studio", () => {
  const task = async (name: string) => userEvent.click(screen.getByRole("tab", { name }));
  it("shares one versioned draft across participation, reply, context and media tasks", async () => {
    const { fake } = await renderPage();
    fireEvent.change(screen.getByLabelText("合并窗口（秒）"), { target: { value: "15" } });
    await task("回复方式");
    fireEvent.change(screen.getByLabelText("场景与行为"), { target: { value: "New scene" } });
    await task("消息读取");
    fireEvent.change(screen.getByLabelText("回复：预算（估算字节）"), {
      target: { value: "7000" },
    });
    await task("表情发送");
    await userEvent.click(screen.getByRole("checkbox", { name: /日常/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        expected_revision: 3,
        rhythm: expect.objectContaining({ merge_window_seconds: 15 }),
        context: expect.objectContaining({ reply_token_budget: 7000 }),
        prompts: expect.objectContaining({ scene: "New scene" }),
        sticker_collections: { collection_ids: [COLLECTION] },
      }),
    );
  });
  it("keeps invalid numeric input visible and blocks saving instead of clamping it", async () => {
    const { fake } = await renderPage();
    const input = screen.getByLabelText("合并窗口（秒）");
    fireEvent.change(input, { target: { value: "900" } });
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe("900");
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(30);
    expect((screen.getByRole("button", { name: "保存方案" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
  });
  it("guards switching away from unsaved scheme changes", async () => {
    await renderPage({
      listQqSchemes: vi
        .fn()
        .mockResolvedValue([
          scheme(),
          scheme({ id: "33333333-3333-4333-8333-333333333333", name: "Other" }),
        ]),
    });
    fireEvent.change(screen.getByLabelText("合并窗口（秒）"), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText("选择聊天方案"), {
      target: { value: "33333333-3333-4333-8333-333333333333" },
    });
    // 切换守卫改由 store 的三选一承担（屏幕只发起请求）：弹窗由导航守卫组件渲染。
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().pendingNavigation).toEqual({
      kind: "scheme",
      id: "33333333-3333-4333-8333-333333333333",
    });
    render(<NavigationConfirm />);
    fireEvent.click(screen.getByRole("button", { name: "取消离开" }));
    expect(store.getState().pendingNavigation).toBeNull();
    expect(store.getState().qqSchemeEditor?.source.id).toBe(scheme().id);
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(15);
  });
  it("keeps an in-use scheme undeletable instead of confirming the delete", async () => {
    const { fake } = await renderPage();
    const remove = screen.getByRole("button", { name: "删除方案" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.click(remove);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fake.deleteQqScheme).not.toHaveBeenCalled();
  });
  it("deletes an unused scheme only after the confirm", async () => {
    const { fake } = await renderPage({
      getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: scheme().id, bindings: 0 }),
    });
    fireEvent.click(screen.getByRole("button", { name: "删除方案" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(fake.deleteQqScheme).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认" })));
    expect(fake.deleteQqScheme).toHaveBeenCalledWith(scheme().id);
  });
  /**
   * 这一栏从只读改成可配置——没改过时仍按「按发言人分开回答」派生（开关照样改
   * 文案），一改就写进方案的 prompt_reply 并照写的用（开关此后只决定回几条），服务端取的是同一个
   * 函数的结果。
   */
  it("lets the effective reply task be edited, and derives it only while untouched", async () => {
    const { fake } = await renderPage({
      listQqSchemes: vi
        .fn()
        .mockResolvedValue([
          scheme({ prompts: { ...scheme().prompts, reply: QQ_REPLY_DEFAULT_PROMPT } }),
        ]),
    });
    await task("回复方式");
    const prompt = screen.getByLabelText("当前生效的回复任务") as HTMLTextAreaElement;
    expect(prompt.readOnly).toBe(false);
    // 未改过：跟随开关（方案里 split_by_speaker 默认开）。
    expect(prompt.value).toBe(QQ_REPLY_SPLIT_PROMPT);
    await userEvent.click(screen.getByRole("checkbox", { name: "按发言人分开回答" }));
    expect(prompt.value).toBe(QQ_REPLY_DEFAULT_PROMPT);
    expect(store.getState().qqSchemeEditor?.reply.split_by_speaker).toBe(false);

    // 改过：照写的用，开关不再改文案。
    fireEvent.change(prompt, { target: { value: "只写一句，带喵。" } });
    expect(store.getState().qqSchemeEditor?.prompts.reply).toBe("只写一句，带喵。");
    await userEvent.click(screen.getByRole("checkbox", { name: "按发言人分开回答" }));
    expect(prompt.value).toBe("只写一句，带喵。");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({ prompts: expect.objectContaining({ reply: "只写一句，带喵。" }) }),
    );
  });
  /**
   * 第二版：压缩与装配是方案自己的三栏（水位触发条数、水位包上限、装配冗余），
   * 冗余在界面里按整数百分比录入、存的是比例；水位压缩任务是一个可编辑的提示词槽位。
   */
  it("edits the compression and assembly group, entering the headroom as a percent", async () => {
    const { fake } = await renderPage();
    await task("历史压缩");
    fireEvent.change(screen.getByLabelText("水位触发条数"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("水位包上限"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("装配冗余百分比"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("水位压缩任务"), { target: { value: "压事实" } });
    expect(store.getState().qqSchemeEditor?.compression).toEqual({
      watermark_trigger: 50,
      package_limit: 4,
      headroom_ratio: 0.1,
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        compression: { watermark_trigger: 50, package_limit: 4, headroom_ratio: 0.1 },
        prompts: expect.objectContaining({ compress: "压事实" }),
      }),
    );
  });
  /**
   * 回复档的条数跟随**绑定助手**的「保留最近轮数」，所以那一栏是只读的：
   * 没有绑定就直说，值一致就显示该值。
   */
  it("shows the bound assistant's retained turns read-only instead of a scheme field", async () => {
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await renderPage({
      listQqBindings: vi.fn().mockResolvedValue([
        QqBindingResponseSchema.parse({
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          account_id: "10001",
          kind: "group",
          peer_id: "30003",
          agent_id: agentId,
          scheme_id: scheme().id,
          paused: false,
          triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
          share_web_memory: false,
          memory_batch_size: null,
          pending_observations: 0,
          revision: 1,
          authority_revision: 1,
          attention: { mode: "off", members: [] },
        }),
      ]),
    });
    store.setState({
      agents: [
        AgentResponseSchema.parse({
          id: agentId,
          name: "小助手",
          model_name: "model",
          config_version: 1,
          persona_intensity: 60,
          created_at: NOW,
          updated_at: NOW,
          p5_config: { recent_turns: 12 },
        }),
      ],
    });
    await task("消息读取");
    // 那一栏仍在原位，但不再是可输入的字段（只读显示绑定助手的值）。
    expect(screen.queryByRole("spinbutton", { name: "回复：最近条数" })).toBeNull();
    expect(screen.getByText("12")).toBeTruthy();
  });
  it("converts local active hours into the contract UTC minutes", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("checkbox", { name: "允许时段" }));
    fireEvent.change(screen.getByLabelText("允许时段开始"), { target: { value: "22:30" } });
    expect(store.getState().qqSchemeEditor?.rhythm.active_hours_start_minutes).toBe(
      (22 * 60 + 30 + new Date().getTimezoneOffset() + 1440) % 1440,
    );
  });
  it("saves a copy without overwriting the source scheme", async () => {
    const { fake } = await renderPage();
    fireEvent.change(screen.getByLabelText("合并窗口（秒）"), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "另存为" }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    fireEvent.change(input, { target: { value: "Copied" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认" })));
    expect(fake.createQqScheme).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Copied",
        rhythm: expect.objectContaining({ merge_window_seconds: 15 }),
      }),
    );
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
  });

  /**
   * 0052（T13）：方案「上下文」新增「消息关系与时间」组，「媒体与表达」新增「图片输入」组。
   * 全部走同一份草稿与同一保存通道；普通动图不重复持久化（沿用 rhythm 既有真源）。
   */
  it("edits message settings (quote mode/depth, time display, timezone) on the context tab", async () => {
    const { fake } = await renderPage();
    await task("消息读取");
    fireEvent.change(screen.getByLabelText("引用展开层数"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("时区"), { target: { value: "Asia/Tokyo" } });
    fireEvent.change(screen.getByLabelText("引用模式"), { target: { value: "configured_depth" } });
    expect(store.getState().qqSchemeEditor?.messageSettings).toEqual({
      reply_mode: "configured_depth",
      reply_depth: 4,
      time_display: "hybrid",
      timezone: "Asia/Tokyo",
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        message_settings: {
          reply_mode: "configured_depth",
          reply_depth: 4,
          time_display: "hybrid",
          timezone: "Asia/Tokyo",
        },
      }),
    );
  });

  /**
   * one_then_on_demand 下层数不参与运行：控件禁用但配置保留（不洗成默认值），
   * 切回按层数即恢复原值；保存载荷带真实两组值。
   */
  it("disables quote depth under on-demand mode, keeps the value and restores it on configured depth", async () => {
    const { fake } = await renderPage();
    await task("消息读取");
    // 夹具默认 one_then_on_demand：层数禁用，但显示已存值。
    const depth = screen.getByLabelText("引用展开层数") as HTMLInputElement;
    expect(depth.disabled).toBe(true);
    expect(depth.value).toBe("2");
    expect(store.getState().qqSchemeEditor?.messageSettings.reply_depth).toBe(2);
    // 切到按层数：控件恢复可用，值仍是原来的。
    fireEvent.change(screen.getByLabelText("引用模式"), {
      target: { value: "configured_depth" },
    });
    expect(depth.disabled).toBe(false);
    expect(depth.value).toBe("2");
    fireEvent.change(depth, { target: { value: "5" } });
    expect(store.getState().qqSchemeEditor?.messageSettings).toEqual({
      reply_mode: "configured_depth",
      reply_depth: 5,
      time_display: "hybrid",
      timezone: "Asia/Shanghai",
    });
    // 切回按需：层数再次禁用，配置不丢。
    fireEvent.change(screen.getByLabelText("引用模式"), {
      target: { value: "one_then_on_demand" },
    });
    expect(depth.disabled).toBe(true);
    expect(depth.value).toBe("5");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        message_settings: {
          reply_mode: "one_then_on_demand",
          reply_depth: 5,
          time_display: "hybrid",
          timezone: "Asia/Shanghai",
        },
      }),
    );
  });

  it("keeps an invalid timezone raw in the draft and blocks page save, copy and unified save", async () => {
    const { fake } = await renderPage();
    await task("消息读取");
    const input = screen.getByLabelText("时区");
    fireEvent.change(input, { target: { value: "Mars/Olympus" } });
    fireEvent.blur(input);
    // 原文保留在输入框，保存被禁。
    expect((input as HTMLInputElement).value).toBe("Mars/Olympus");
    expect((screen.getByRole("button", { name: "保存方案" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole("alert").textContent).toContain("IANA");
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    // 统一保存（导航守卫的保存路径）同样被拦。
    expect(await store.getState().saveQqDrafts()).toBe(false);
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    // 复制（create 通道没有服务端兜底）也被拦：UI 层按钮禁用，store 层动作同样拒绝。
    expect((screen.getByRole("button", { name: "另存为" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(await store.getState().duplicateQqScheme("副本")).toBe(false);
    expect(fake.createQqScheme).not.toHaveBeenCalled();
  });

  it("edits media input (mode, stages, max images, specs) on the media tab with null = original", async () => {
    const { fake } = await renderPage();
    await task("图片理解");
    // 模式切换。
    fireEvent.change(screen.getByLabelText("图片输入模式"), { target: { value: "description" } });
    // 阶段：关掉评估阶段（另两个保持开）。
    await userEvent.click(screen.getByRole("checkbox", { name: "评估阶段" }));
    // 图数与规格。
    fireEvent.change(screen.getByLabelText("每次调用自动图片上限"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("表情静图长边上限"), { target: { value: "256" } });
    fireEvent.change(screen.getByLabelText("表情动图采样帧数"), { target: { value: "5" } });
    const editor = () => store.getState().qqSchemeEditor;
    expect(editor()?.mediaInput.mode).toBe("description");
    expect(editor()?.mediaInput.stages).toEqual({
      decision: true,
      evaluation: false,
      generation: true,
    });
    expect(editor()?.mediaInput.max_images).toBe(4);
    expect(editor()?.mediaInput.expression_max_dimension).toBe(256);
    expect(editor()?.mediaInput.expression_frame_count).toBe(5);
    // 普通静图：原图（null）与数值双向可切，null 由显式选择写入而不是 0。
    const choice = screen.getByLabelText("普通静图规格");
    const ordinary = screen.getByLabelText("普通静图长边上限") as HTMLInputElement;
    expect((choice as HTMLSelectElement).value).toBe("original");
    expect(ordinary.disabled).toBe(true);
    fireEvent.change(choice, { target: { value: "limited" } });
    expect(editor()?.mediaInput.ordinary_still_max_dimension).toBe(64);
    fireEvent.change(ordinary, { target: { value: "1024" } });
    expect(editor()?.mediaInput.ordinary_still_max_dimension).toBe(1024);
    // 切回原图：显式选择写 null（不是 0），数值输入随之禁用。
    fireEvent.change(choice, { target: { value: "original" } });
    expect(editor()?.mediaInput.ordinary_still_max_dimension).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        media_input: {
          mode: "description",
          stages: { decision: true, evaluation: false, generation: true },
          max_images: 4,
          ordinary_still_max_dimension: null,
          expression_max_dimension: 256,
          expression_frame_count: 5,
          expression_frame_max_dimension: 512,
        },
      }),
    );
    // 普通动图只由 rhythm.media_frame_count 这一个真源决定帧数：同名「动图」帧数输入仅一处
    // （抽帧张数），表情动图帧数是独立规格、各有明确标签。
    expect(screen.queryByRole("spinbutton", { name: "表情动图采样帧数" })).toBeTruthy();
    expect(screen.getAllByRole("spinbutton", { name: "动图抽帧张数" })).toHaveLength(1);
  });

  it("rejects an ordinary still limit of 0: the raw stays, the scheme value does not move and all saves are blocked", async () => {
    const { fake } = await renderPage();
    await task("图片理解");
    // 从原图切到限制长边，再输入 0（0 不在契约 64–2048 内，也不是「原图」的编码）。
    const choice = screen.getByLabelText("普通静图规格");
    fireEvent.change(choice, { target: { value: "limited" } });
    const ordinary = screen.getByLabelText("普通静图长边上限") as HTMLInputElement;
    fireEvent.change(ordinary, { target: { value: "0" } });
    // 原文保留在输入框、编辑器不写半截值（保持 64 起步值，不变 null 也不变 0）。
    expect(ordinary.value).toBe("0");
    expect(store.getState().qqSchemeEditor?.mediaInput.ordinary_still_max_dimension).toBe(64);
    fireEvent.blur(ordinary);
    expect(screen.getByRole("alert").textContent).toContain("64");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(await store.getState().saveQqDrafts()).toBe(false);
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
  });

  it("previews the two new groups with localized labels and on/off stage text", async () => {
    await renderPage();
    await task("图片理解");
    await userEvent.click(screen.getByRole("checkbox", { name: "评估阶段" }));
    fireEvent.click(screen.getByRole("button", { name: "预览变更" }));
    const dialog = screen.getByRole("dialog");
    const text = dialog.textContent ?? "";
    // 人话标签 + 布尔按开/关渲染，不出现机器字段名或 true/false。
    expect(text).toContain("评估阶段");
    expect(text).toContain("关");
    expect(text).not.toContain("media_input");
    expect(text).not.toContain("true");
    expect(text).not.toContain("false");
  });

  it("enforces mutual exclusivity between ongoing conversation and chiming in", async () => {
    await renderPage();
    await task("发言时机");
    const followUp = screen.getByRole("checkbox", { name: /^连续交谈/ });
    const chimingIn = screen.getByRole("checkbox", { name: /^自主接话/ });

    // 默认方案中 chiming_in 为 true, follow_up 为 false
    expect(chimingIn.getAttribute("aria-checked")).toBe("true");
    expect(followUp.getAttribute("aria-checked")).toBe("false");

    // 勾选连续交谈：自主接话自动关闭
    await userEvent.click(followUp);
    expect(followUp.getAttribute("aria-checked")).toBe("true");
    expect(chimingIn.getAttribute("aria-checked")).toBe("false");
    expect(store.getState().qqSchemeEditor?.triggers.follow_up).toBe(true);
    expect(store.getState().qqSchemeEditor?.triggers.chiming_in).toBe(false);

    // 勾选自主接话：连续交谈自动关闭
    await userEvent.click(chimingIn);
    expect(chimingIn.getAttribute("aria-checked")).toBe("true");
    expect(followUp.getAttribute("aria-checked")).toBe("false");
    expect(store.getState().qqSchemeEditor?.triggers.chiming_in).toBe(true);
    expect(store.getState().qqSchemeEditor?.triggers.follow_up).toBe(false);
  });

  it("blocks saving when rhythm jitter count is greater than or equal to target count", async () => {
    const { fake } = await renderPage();
    await task("发言时机");
    const targetInput = screen.getByLabelText("目标消息数") as HTMLInputElement;
    const jitterInput = screen.getByLabelText("浮动消息数") as HTMLInputElement;

    fireEvent.change(targetInput, { target: { value: "10" } });
    fireEvent.change(jitterInput, { target: { value: "10" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(await store.getState().saveQqDrafts()).toBe(false);

    // 修正为 jitter < target (5 < 10) 后允许保存
    fireEvent.change(jitterInput, { target: { value: "5" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenCalled();
  });

  it("edits autonomous time window controls and validates jitter seconds < target seconds", async () => {
    const { fake } = await renderPage();
    await task("发言时机");

    const timeSwitch = screen.getByRole("checkbox", { name: /启用时间窗口/ });
    const targetSeconds = screen.getByLabelText("目标时间（秒）") as HTMLInputElement;
    const jitterSeconds = screen.getByLabelText("浮动时间（秒）") as HTMLInputElement;

    expect(timeSwitch.getAttribute("aria-checked")).toBe("true");
    expect(targetSeconds.value).toBe("60");
    expect(jitterSeconds.value).toBe("20");

    // 切换开关
    await userEvent.click(timeSwitch);
    expect(timeSwitch.getAttribute("aria-checked")).toBe("false");
    expect(store.getState().qqSchemeEditor?.rhythm.initiative_time_window_enabled).toBe(false);

    // 设置 jitter >= target (60 >= 60) 阻止保存
    fireEvent.change(jitterSeconds, { target: { value: "60" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(await store.getState().saveQqDrafts()).toBe(false);

    // 修正为 15 < 60 允许保存
    fireEvent.change(jitterSeconds, { target: { value: "15" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenCalled();
  });
});
