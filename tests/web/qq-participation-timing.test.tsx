// QQ 接话时机评估模式 (participation_timing) 界面与草稿生命周期测试
// 验证：人类友好选项展示、保存载荷、字段保持、单群继承与稀疏覆盖、409 冲突保稿、数值与枚举校验隔离。

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResponse } from "../../src/shared/contracts/agent";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import { PermissionsResponseSchema } from "../../src/shared/contracts/permissions";
import type { QqBindingResponse, QqSchemeResponse } from "../../src/shared/contracts/qq";
import type { QqGroupConfigResponse } from "../../src/shared/contracts/qq-group-config";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { QqGroupConfigPage } from "../../src/web/screens/connections/group-config";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

const NOW = "2026-10-15T00:00:00.000Z";
const BASE_SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";

const mockScheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: BASE_SCHEME_ID,
  name: "测试时机方案",
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
    stages: { decision: true, evaluation: true, generation: false },
    max_images: 4,
    ordinary_still_max_dimension: 1024,
  },
  task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
  input_anti_spam: { enabled: false, burst_min_messages: 3, burst_window_seconds: 3 },
  created_at: NOW,
  updated_at: NOW,
  revision: 1,
  ...overrides,
});

const mockAgent: AgentResponse = {
  id: AGENT_ID,
  name: "测试助手",
  created_at: NOW,
  updated_at: NOW,
  p5_config: {
    vision_model_name: null,
    retrieval_mode: "on",
    recent_turns: 10,
  },
} as unknown as AgentResponse;

const mockBinding: QqBindingResponse = {
  id: BINDING_ID,
  agent_id: AGENT_ID,
  account_id: "123456",
  kind: "group",
  peer_id: "987654",
  scheme_id: BASE_SCHEME_ID,
  share_web_memory: false,
  memory_batch_size: 10,
  pending_observations: 0,
  authority_revision: 1,
  paused: false,
  triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
  attention: { mode: "all", members: [] },
  created_at: NOW,
  updated_at: NOW,
  revision: 1,
} as unknown as QqBindingResponse;

const mockGroupConfig = (overrides = {}): QqGroupConfigResponse => ({
  binding: mockBinding,
  base_scheme: mockScheme(),
  effective_scheme: mockScheme(),
  overrides,
  disabled_capabilities: [],
  revision: 1,
});

function schemeClient(overrides: Partial<typeof api> = {}) {
  const current = mockScheme();
  return {
    ...api,
    listQqSchemes: vi.fn().mockResolvedValue([current]),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: current.id, bindings: 1 }),
    listQqStickerCollections: vi.fn().mockResolvedValue([]),
    listQqStickerAssets: vi.fn().mockResolvedValue([]),
    updateQqScheme: vi
      .fn()
      .mockImplementation(async (_id: string, body: unknown) =>
        mockScheme({ ...(body as object), revision: 2 }),
      ),
    createQqScheme: vi.fn().mockImplementation(async (body: unknown) =>
      mockScheme({
        id: "33333333-3333-4333-8333-333333333333",
        ...(body as object),
        revision: 1,
      }),
    ),
    deleteQqScheme: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as typeof api;
}

function groupConfigClient(overrides: Partial<typeof api> = {}) {
  const config = mockGroupConfig();
  return {
    ...api,
    listQqBindings: vi.fn(async () => [mockBinding]),
    listQqSchemes: vi.fn(async () => [mockScheme()]),
    listAgents: vi.fn(async () => [mockAgent]),
    listConversations: vi.fn(async () => [] as ConversationSummary[]),
    getQqGroupConfig: vi.fn(async () => config),
    saveQqGroupConfig: vi.fn(async (_id: string, body: { overrides: object }) => ({
      ...config,
      overrides: (body as { overrides: object }).overrides,
      revision: config.revision + 1,
    })),
    getAgentPermissions: vi.fn(async () =>
      PermissionsResponseSchema.parse({
        agent_id: AGENT_ID,
        grants: [],
        requests: [],
        revision: 1,
      }),
    ),
    ...overrides,
  } as unknown as typeof api;
}

async function renderSchemePage(overrides: Partial<typeof api> = {}) {
  const fake = schemeClient(overrides);
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

async function renderGroupConfigPage(overrides: Partial<typeof api> = {}) {
  const fake = groupConfigClient(overrides);
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-group-config",
  });
  await store.getState().selectQqGroupConfig(BINDING_ID);
  const view = render(<QqGroupConfigPage />);
  await act(async () => {});
  return { view, fake };
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("QQ Participation Timing Mode (participation_timing)", () => {
  const openParticipationTab = async () =>
    userEvent.click(screen.getByRole("tab", { name: "发言时机" }));

  it("Scheme Studio: renders timing mode selector with human-friendly options without 4.B or legacy labels", async () => {
    await renderSchemePage();
    await openParticipationTab();

    const select = screen.getByLabelText("自主发言评估时机") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe("resource_window");

    // 人性化文案校验：包含"窗口成熟即评估"与"停顿优先"，不含内部 4.B 或传统遗留营销词
    const options = Array.from(select.options).map((opt) => opt.text);
    expect(options).toContain("窗口成熟即评估");
    expect(options).toContain("停顿优先");
    expect(options.some((text) => /4\.B|legacy|traditional/i.test(text))).toBe(false);

    // 默认展示计算派生区间：消息数 [10, 20]，时间 [40, 80]
    const derivedCard = screen.getByTestId("scheme-rhythm-derived-intervals");
    expect(derivedCard).toBeTruthy();
    expect(derivedCard.textContent).toContain("窗口成熟即评估");
    expect(derivedCard.textContent).toContain("消息数 10 ~ 20 条");
    expect(derivedCard.textContent).toContain("时间 40 ~ 80 秒");
  });

  it("Scheme Studio: switching mode preserves the merge window and message/time target values", async () => {
    await renderSchemePage();
    await openParticipationTab();

    const select = screen.getByLabelText("自主发言评估时机") as HTMLSelectElement;
    const mergeInput = screen.getByLabelText("合并窗口（秒）") as HTMLInputElement;
    const targetCount = screen.getByLabelText("目标消息数") as HTMLInputElement;
    const jitterCount = screen.getByLabelText("浮动消息数") as HTMLInputElement;
    const targetSeconds = screen.getByLabelText("目标时间（秒）") as HTMLInputElement;
    const jitterSeconds = screen.getByLabelText("浮动时间（秒）") as HTMLInputElement;

    // 先修改几个必要字段
    fireEvent.change(mergeInput, { target: { value: "45" } });
    fireEvent.change(targetCount, { target: { value: "20" } });
    fireEvent.change(jitterCount, { target: { value: "6" } });
    fireEvent.change(targetSeconds, { target: { value: "100" } });
    fireEvent.change(jitterSeconds, { target: { value: "25" } });

    expect(mergeInput.value).toBe("45");
    expect(targetCount.value).toBe("20");
    expect(jitterCount.value).toBe("6");
    expect(targetSeconds.value).toBe("100");
    expect(jitterSeconds.value).toBe("25");

    // 切换为停顿优先模式
    fireEvent.change(select, { target: { value: "quiet_preferred" } });
    expect(select.value).toBe("quiet_preferred");
    expect(store.getState().qqSchemeEditor?.rhythm.participation_timing).toBe("quiet_preferred");

    // 关键断言：切换模式绝不清空、重置或丢失现有字段值
    expect(mergeInput.value).toBe("45");
    expect(targetCount.value).toBe("20");
    expect(jitterCount.value).toBe("6");
    expect(targetSeconds.value).toBe("100");
    expect(jitterSeconds.value).toBe("25");
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(45);
    expect(store.getState().qqSchemeEditor?.rhythm.initiative_batch_target_count).toBe(20);
    expect(store.getState().qqSchemeEditor?.rhythm.initiative_batch_jitter_count).toBe(6);

    // 派生区间卡片动态更新为新计算值 [14 ~ 26 条]，[75 ~ 125 秒]，并显示停顿优先常规与上界说明
    const derivedCard = screen.getByTestId("scheme-rhythm-derived-intervals");
    expect(derivedCard.textContent).toContain("停顿优先");
    expect(derivedCard.textContent).toContain("消息数 14 ~ 26 条");
    expect(derivedCard.textContent).toContain("时间 75 ~ 125 秒");
    expect(derivedCard.textContent).toContain("最新人类发言已停顿 M（45 秒）");
    expect(derivedCard.textContent).toContain("≥ 26 条");
  });

  it("Scheme Studio: save payload includes participation_timing with revision CAS", async () => {
    const { fake } = await renderSchemePage();
    await openParticipationTab();

    const select = screen.getByLabelText("自主发言评估时机") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "quiet_preferred" } });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));

    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      BASE_SCHEME_ID,
      expect.objectContaining({
        expected_revision: 1,
        rhythm: expect.objectContaining({
          participation_timing: "quiet_preferred",
          initiative_batch_target_count: 15,
          initiative_batch_jitter_count: 5,
        }),
      }),
    );
  });

  it("Scheme Studio: 409 conflict keeps draft participation_timing across refresh and retry", async () => {
    const fresh = mockScheme({ revision: 5 });
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("方案已变化，请重新加载"))
      .mockResolvedValueOnce(
        mockScheme({
          revision: 6,
          rhythm: { ...mockScheme().rhythm, participation_timing: "quiet_preferred" },
        }),
      );

    const { fake } = await renderSchemePage({
      updateQqScheme: update,
      listQqSchemes: vi.fn().mockResolvedValueOnce([mockScheme()]).mockResolvedValue([fresh]),
    });
    await openParticipationTab();

    const select = screen.getByLabelText("自主发言评估时机") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "quiet_preferred" } });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(screen.getByRole("alert").textContent).toContain("方案已变化");

    // 冲突后刷新并保留本地草稿中的 quiet_preferred
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新" })));
    const editor = store.getState().qqSchemeEditor;
    expect(editor?.source.revision).toBe(5);
    expect(editor?.rhythm.participation_timing).toBe("quiet_preferred");

    // 重试提交以更新后的 revision 5 通过 CAS
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存方案" })));
    expect(fake.updateQqScheme).toHaveBeenLastCalledWith(
      BASE_SCHEME_ID,
      expect.objectContaining({
        expected_revision: 5,
        rhythm: expect.objectContaining({
          participation_timing: "quiet_preferred",
        }),
      }),
    );
  });

  it("Group Config: inherits timing mode from base scheme and shows follow state badge", async () => {
    const { view } = await renderGroupConfigPage();
    await openParticipationTab();

    const select = view.container.querySelector(
      'select[data-field="rhythm.participation_timing"]',
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe("resource_window");

    // 检查字段状态下拉：默认是跟随方案
    const stateSelect = view.container.querySelector(
      'select[aria-label="自主发言评估时机: 字段使用方式"]',
    ) as HTMLSelectElement;
    expect(stateSelect).toBeTruthy();
    expect(stateSelect.value).toBe("follow");

    // 群配置页展示生效派生区间卡片
    const groupDerivedCard = screen.getByTestId("group-rhythm-derived-intervals");
    expect(groupDerivedCard).toBeTruthy();
    expect(groupDerivedCard.textContent).toContain("窗口成熟即评估");
  });

  it("Group Config: overrides timing mode to quiet_preferred and restores follow without affecting others", async () => {
    const { view, fake } = await renderGroupConfigPage();
    await openParticipationTab();

    const select = view.container.querySelector(
      'select[data-field="rhythm.participation_timing"]',
    ) as HTMLSelectElement;

    // 切换为自定义停顿优先
    fireEvent.change(select, { target: { value: "quiet_preferred" } });
    const editor = store.getState().qqGroupConfigEditor;
    expect(editor?.overrides.rhythm?.participation_timing).toBe("quiet_preferred");

    // 检查状态下拉变为 custom
    const stateSelect = view.container.querySelector(
      'select[aria-label="自主发言评估时机: 字段使用方式"]',
    ) as HTMLSelectElement;
    expect(stateSelect.value).toBe("custom");

    // 保存并验证 overrides 包含 participation_timing
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存本群配置" })));
    expect(fake.saveQqGroupConfig).toHaveBeenCalledWith(
      BINDING_ID,
      expect.objectContaining({
        overrides: expect.objectContaining({
          rhythm: expect.objectContaining({
            participation_timing: "quiet_preferred",
          }),
        }),
      }),
    );

    // 恢复为跟随
    fireEvent.change(stateSelect, { target: { value: "follow" } });
    expect(
      store.getState().qqGroupConfigEditor?.overrides.rhythm?.participation_timing,
    ).toBeUndefined();
  });

  it("Rhythm enum is excluded from numeric editing and does not trigger Number() conversion errors", async () => {
    await renderSchemePage();
    await openParticipationTab();

    // 确认 invalidSchemeInputs 没有因 participation_timing 是非数值字符串而判定非法
    const editor = store.getState().qqSchemeEditor;
    expect(editor).toBeTruthy();
    expect(editor?.rhythm.participation_timing).toBe("resource_window");

    fireEvent.change(screen.getByLabelText("自主发言评估时机"), {
      target: { value: "quiet_preferred" },
    });
    const saveButton = screen.getByRole("button", { name: "保存方案" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
  });
});
