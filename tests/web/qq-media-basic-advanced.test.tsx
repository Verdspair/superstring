// 图片输入基本区与高级折叠区的真实界面用例（0052/0059 之后的统一静图规格形态）：
// 基本区 = 输入方式单选（由三阶段布尔派生）+ 图数 + 统一静图规格；
// 高级区 = 本地折叠（forceMount 隐藏），含输入模式、逐阶段开关、动图规格与媒体提示词。
// 这些用例只通过界面与 store 观察行为：打开/收起折叠不是草稿改动，保存只发契约里存在的键。

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";
import { selectLocale } from "../../src/web/i18n";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { useSuperstringStore as store } from "../../src/web/store";
import { NavigationGuard as NavigationConfirm } from "../../src/web/workspace/NavigationGuard";

const NOW = "2026-10-10T00:00:00.000Z";
const OTHER = "33333333-3333-4333-8333-333333333333";
const CREATED = "55555555-5555-4555-8555-555555555555";

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
  message_settings: {
    reply_mode: "one_then_on_demand",
    reply_depth: 2,
    time_display: "hybrid",
    timezone: "Asia/Shanghai",
  },
  media_input: {
    mode: "native",
    stages: { decision: true, evaluation: false, generation: true },
    max_images: 8,
    ordinary_still_max_dimension: 512,
  },
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
  input_anti_spam: { enabled: false },
  ...overrides,
});

function client(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...store.getState().apiClient,
    listQqSchemes: vi.fn().mockResolvedValue([scheme()]),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: scheme().id, bindings: 0 }),
    listQqStickerCollections: vi.fn().mockResolvedValue([]),
    listQqStickerAssets: vi.fn().mockResolvedValue([]),
    updateQqScheme: vi
      .fn()
      .mockImplementation(async (_id: string, body: unknown) =>
        scheme({ ...(body as object), id: scheme().id, revision: 4 }),
      ),
    createQqScheme: vi
      .fn()
      .mockImplementation(async (body: unknown) =>
        scheme({ id: CREATED, ...(body as object), revision: 1 }),
      ),
    ...overrides,
  };
}

async function renderPage(overrides: Record<string, unknown> = {}) {
  const fake = client(overrides);
  store.getState().resetForTests(fake as never);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
  });
  render(<SchemeStudio />);
  await act(async () => {});
  return {
    fake: fake as {
      updateQqScheme: ReturnType<typeof vi.fn>;
      createQqScheme: ReturnType<typeof vi.fn>;
    },
  };
}

const openAdvanced = async () => {
  await userEvent.click(screen.getByRole("button", { name: "展开高级设置" }));
};

const editor = () => {
  const current = store.getState().qqSchemeEditor;
  if (!current) throw new Error("scheme editor not loaded");
  return current;
};

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("QQ 图片输入基本区与高级折叠（实际界面）", () => {
  it("打开页面即呈现混合阶段的派生「自定义」，不改任何值：source 三布尔与静图规格原样显示", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "图片理解" }));
    // 派生单选：混合阶段 = 自定义选中；自动/按需未选中。
    const radios = screen.getAllByRole("radio");
    // Radix 单选是 button[role=radio]，值在 value 属性上。
    expect(radios.map((node) => (node as HTMLButtonElement).value)).toEqual([
      "auto",
      "ondemand",
      "custom",
    ]);
    expect(radios[2]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[0]?.getAttribute("aria-checked")).toBe("false");
    // source 值原样：图数与统一静图规格照夹具显示，未被派生逻辑改写。
    expect(editor().mediaInput.stages).toEqual({
      decision: true,
      evaluation: false,
      generation: true,
    });
    const maxImages = screen.getByLabelText("每次调用自动图片上限") as HTMLInputElement;
    expect(maxImages.value).toBe("8");
    const still = screen.getByLabelText("静图长边上限") as HTMLInputElement;
    expect(still.value).toBe("512");
    expect((still as HTMLInputElement).disabled).toBe(false);
    // 混合阶段不产生任何草稿改动，页面也没有非法项。
    expect(store.getState().qqInputs.schemeTexts).toEqual({});
    expect((screen.getByRole("button", { name: "保存方案" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("选择自动/仅按需原子更新全部三个阶段布尔并变脏；保存只发契约现有键的 media_input", async () => {
    const { fake } = await renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "图片理解" }));
    const radios = screen.getAllByRole("radio");
    // 自定义 → 自动：三个阶段布尔一起开，其它组不动。
    await userEvent.click(radios[0]);
    expect(editor().mediaInput.stages).toEqual({
      decision: true,
      evaluation: true,
      generation: true,
    });
    // 自动 → 仅按需：三个阶段布尔一起关。
    await userEvent.click(screen.getAllByRole("radio")[1]);
    expect(editor().mediaInput.stages).toEqual({
      decision: false,
      evaluation: false,
      generation: false,
    });
    // 同时改图数：保存载荷 media_input 只含 mode/stages/max_images/ordinary_still 四个键。
    fireEvent.change(screen.getByLabelText("每次调用自动图片上限"), { target: { value: "5" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenCalledTimes(1);
    const sent = fake.updateQqScheme.mock.calls[0][1] as Record<string, unknown>;
    expect(sent.media_input).toEqual({
      mode: "native",
      stages: { decision: false, evaluation: false, generation: false },
      max_images: 5,
      ordinary_still_max_dimension: 512,
    });
    expect(Object.keys(sent.media_input as object).sort()).toEqual([
      "max_images",
      "mode",
      "ordinary_still_max_dimension",
      "stages",
    ]);
    // 退役键不复活，动图帧数仍由 rhythm 真源携带。
    expect(sent.rhythm).toMatchObject({ media_frame_count: 3, media_max_dimension: 512 });
  });

  it("展开/收起高级设置不是草稿改动、不重置已填值；导航守卫照常拦住带草稿的方案切换", async () => {
    await renderPage({
      listQqSchemes: vi.fn().mockResolvedValue([scheme(), scheme({ id: OTHER, name: "其他方案" })]),
    });
    await userEvent.click(screen.getByRole("tab", { name: "图片理解" }));
    // 带草稿：改图数。
    fireEvent.change(screen.getByLabelText("每次调用自动图片上限"), { target: { value: "6" } });
    expect(editor().mediaInput.max_images).toBe(6);
    // 展开高级设置：mode/stages 控件出现在可访问面；折叠开关本身不改草稿。
    await openAdvanced();
    expect(screen.getByLabelText("图片输入模式")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "评估阶段" })).toBeTruthy();
    expect(editor().mediaInput.max_images).toBe(6);
    expect((screen.getByRole("button", { name: "保存方案" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    // 收起：控件重新隐藏（forceMount 内容仍在 DOM，只是不可见），草稿原样保留。
    await userEvent.click(screen.getByRole("button", { name: "收起高级设置" }));
    expect(screen.getByLabelText("图片输入模式", { selector: "*" })).toBeTruthy();
    expect(editor().mediaInput.max_images).toBe(6);
    // 带草稿切换方案：共享导航守卫接管，编辑器与草稿都原地保留。
    fireEvent.change(screen.getByLabelText("选择聊天方案"), { target: { value: OTHER } });
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().pendingNavigation).toEqual({ kind: "scheme", id: OTHER });
    render(<NavigationConfirm />);
    fireEvent.click(screen.getByRole("button", { name: "取消离开" }));
    expect(store.getState().pendingNavigation).toBeNull();
    expect(editor().source.id).toBe(scheme().id);
    expect(editor().mediaInput.max_images).toBe(6);
  });

  it("另存副本携带当前派生阶段与图数：media_input 只有静态 canonical 四键，不新增持久键", async () => {
    const { fake } = await renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "图片理解" }));
    // 从混合阶段切到自动，再改静图规格为限制长边 1024。
    await userEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.change(screen.getByLabelText("静图规格"), { target: { value: "limited" } });
    fireEvent.change(screen.getByLabelText("静图长边上限"), { target: { value: "1024" } });
    fireEvent.change(screen.getByLabelText("每次调用自动图片上限"), { target: { value: "7" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "另存为" })));
    const dialog = screen.getByRole("dialog");
    const nameInput = within(dialog).getByRole("textbox");
    fireEvent.change(nameInput, { target: { value: "副本" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认" })));
    expect(fake.createQqScheme).toHaveBeenCalledTimes(1);
    const sent = fake.createQqScheme.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.media_input).toEqual({
      mode: "native",
      stages: { decision: true, evaluation: true, generation: true },
      max_images: 7,
      ordinary_still_max_dimension: 1024,
    });
    expect(Object.keys(sent.media_input as object)).toHaveLength(4);
    // 派生字段不另立持久键：载荷里没有 input_method/ordinary_frame_* 等新键。
    expect(Object.keys(sent)).not.toContain("input_method");
    expect(Object.keys(sent)).not.toContain("ordinary_frame_count");
    expect(Object.keys(sent)).not.toContain("ordinary_frame_max_dimension");
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
  });

  it("模式说明跟随选择切换（描述缓存/原生各有各的提示），配置读取不发起任何模型调用", async () => {
    const { fake } = await renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "图片理解" }));
    await openAdvanced();
    const mode = screen.getByLabelText("图片输入模式");
    // native 的说明。
    expect(screen.getByText("使用当前会话实际模型直接读取图片画面。")).toBeTruthy();
    fireEvent.change(mode, { target: { value: "description" } });
    expect(editor().mediaInput.mode).toBe("description");
    expect(screen.getByText("使用组织级视觉配置先写文字描述并缓存，更省视觉预算。")).toBeTruthy();
    expect(screen.queryByText("使用当前会话实际模型直接读取图片画面。")).toBeNull();
    // 切模式只写本地草稿：除夹具的目录/用量读取外，没有任何写请求或模型端点。
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(fake.createQqScheme).not.toHaveBeenCalled();
  });
});
