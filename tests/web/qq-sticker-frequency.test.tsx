import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentKnowledgeReadSettings } from "../../src/shared/contracts/knowledge";
import {
  type PermissionsResponse,
  PermissionsResponseSchema,
} from "../../src/shared/contracts/permissions";
import type { QqBindingResponse, QqSchemeResponse } from "../../src/shared/contracts/qq";
import type {
  QqGroupConfigResponse,
  QqGroupSchemeOverrides,
} from "../../src/shared/contracts/qq-group-config";
import { api, type SuperstringApi } from "../../src/web/api";
import {
  qqGroupConfigDirty,
  qqGroupConfigEditorFrom,
  qqGroupConfigHasInvalidInputs,
} from "../../src/web/features/qq/group-config-state";
import {
  QQ_SCHEME_ENUM_OPTION_LABELS,
  QQ_SCHEME_FIELD_LABELS,
  qqSchemeFieldSection,
  stickerFields,
} from "../../src/web/features/qq/scheme-field-metadata";
import { selectLocale } from "../../src/web/i18n";
import { QqGroupConfigPage } from "../../src/web/screens/connections/group-config";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { SystemComponents } from "../../src/web/screens/connections/system-components";
import { useSuperstringStore as store } from "../../src/web/store";
import { CAPABILITY_CATALOG, TOOL_HUMAN_LABELS } from "../../src/web/workspace/capability-catalog";

const NOW = "2026-10-11T00:00:00.000Z";
const BASE_SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";

const overridesOf = (bag: Record<string, Record<string, unknown>>): QqGroupSchemeOverrides =>
  bag as unknown as QqGroupSchemeOverrides;

const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: BASE_SCHEME_ID,
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
    max_sticker_count: 2, // 既有持久值 2，退役控件必须完整透传
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
  stickers: {
    sticker_min_repeat_minutes: 10,
    sticker_recent_avoid_count: 5,
    frequency: "medium",
  },
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
  input_anti_spam: { enabled: false },
  ...overrides,
});

const qqBinding = (overrides: Partial<QqBindingResponse> = {}): QqBindingResponse => ({
  id: BINDING_ID,
  account_id: "100",
  kind: "group",
  peer_id: "123456789",
  agent_id: AGENT_ID,
  scheme_id: BASE_SCHEME_ID,
  paused: false,
  triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
  share_web_memory: false,
  memory_batch_size: null,
  pending_observations: 0,
  revision: 4,
  authority_revision: 4,
  attention: { mode: "off", members: [] },
  task_limits: { mention_task_limit: null, ordinary_task_limit: null },
  input_anti_spam: { enabled: null },
  ...overrides,
});

const qqConfig = (overrides: Partial<QqGroupConfigResponse> = {}): QqGroupConfigResponse => {
  const base = scheme();
  return {
    binding: qqBinding(),
    base_scheme: base,
    effective_scheme: base,
    overrides: overridesOf({}),
    disabled_capabilities: [],
    revision: 0,
    ...overrides,
  };
};

const permissions = (): PermissionsResponse =>
  PermissionsResponseSchema.parse({
    policy: { version: 1, grants: [], execution: { modules: { mcp: true, skills: true } } },
    resources: [],
  });

const knowledgeRead = (enabled = false): AgentKnowledgeReadSettings => ({
  revision: 1,
  config: { enabled, context_budget: null, scope: "all", document_ids: [] },
});

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("QQ Sticker Frequency & Composable Tools UI", () => {
  it("capability catalog registers reply.text and reply.sticker in TOOL_HUMAN_LABELS", () => {
    expect(TOOL_HUMAN_LABELS["reply.text"]).toBe("capabilities.labels.replyText");
    expect(TOOL_HUMAN_LABELS["reply.sticker"]).toBe("capabilities.labels.replySticker");
  });

  it("scheme field metadata maps stickers.frequency to sticker_sending and retires max_sticker_count from stickerFields", () => {
    expect(qqSchemeFieldSection("stickers.frequency")).toBe("sticker_sending");
    expect(QQ_SCHEME_FIELD_LABELS["stickers.frequency"]).toBe("connections.stickerFrequency");
    expect(QQ_SCHEME_ENUM_OPTION_LABELS["stickers.frequency"]).toEqual({
      low: "connections.stickerFrequencyLow",
      medium: "connections.stickerFrequencyMedium",
      high: "connections.stickerFrequencyHigh",
    });
    // stickerFields 不含 max_sticker_count，防止数值控件渲染
    const names = stickerFields.map(([, name]) => name);
    expect(names).not.toContain("max_sticker_count");
    expect(names).toContain("sticker_min_repeat_minutes");
    expect(names).toContain("sticker_recent_avoid_count");
  });

  it("Scheme Studio renders frequency RadioGroup on sticker_sending tab, saves chosen frequency, and preserves max_sticker_count", async () => {
    const fakeApi = {
      ...api,
      listQqSchemes: vi.fn().mockResolvedValue([scheme()]),
      getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: BASE_SCHEME_ID, bindings: 1 }),
      listQqStickerCollections: vi.fn().mockResolvedValue([]),
      listQqStickerAssets: vi.fn().mockResolvedValue([]),
      updateQqScheme: vi
        .fn()
        .mockImplementation(async (_id: string, body: unknown) =>
          scheme({ ...(body as object), revision: 4 }),
        ),
    } as unknown as typeof api;

    store.getState().resetForTests(fakeApi);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-scheme-config",
    });

    render(<SchemeStudio />);
    await act(async () => {});

    // 切换到表情发送
    await userEvent.click(screen.getByRole("tab", { name: "表情发送" }));

    // 验证退役控件：不应该有 max_sticker_count 的数值输入框（每条回复最多几张表情）
    expect(screen.queryByLabelText("每条回复最多几张表情")).toBeNull();

    // 验证 RadioGroup 存在，且默认是 medium（平衡选择）
    const lowRadio = screen.getByRole("radio", { name: /较少使用/ });
    const mediumRadio = screen.getByRole("radio", { name: /平衡选择/ });
    const highRadio = screen.getByRole("radio", { name: /积极考虑/ });

    expect(mediumRadio.getAttribute("data-state")).toBe("checked");
    expect(lowRadio.getAttribute("data-state")).toBe("unchecked");
    expect(highRadio.getAttribute("data-state")).toBe("unchecked");

    // 点击切换为低倾向（low）
    await userEvent.click(lowRadio);
    expect(lowRadio.getAttribute("data-state")).toBe("checked");

    // 保存方案
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存方案" }));
    });

    // 校验 PUT 请求：frequency 是 low，且 rhythm.max_sticker_count 保持原值 2（完整透传）
    expect(fakeApi.updateQqScheme).toHaveBeenCalledWith(
      BASE_SCHEME_ID,
      expect.objectContaining({
        stickers: expect.objectContaining({
          frequency: "low",
        }),
        rhythm: expect.objectContaining({
          max_sticker_count: 2,
        }),
      }),
    );
  });

  it("Group Config state handles stickers.frequency override, dirty comparison, raw text, and onFollow reset", () => {
    const config = qqConfig();
    store.getState().resetForTests(api);
    store.setState({
      qqGroupConfigEditor: qqGroupConfigEditorFrom(config),
    });

    let editor = store.getState().qqGroupConfigEditor;
    expect(editor).not.toBeNull();
    // 初始状态：干净（not dirty）
    expect(qqGroupConfigDirty(editor)).toBe(false);

    // 覆盖为 low
    store.getState().patchQqGroupOverride("stickers", "frequency", "low");
    editor = store.getState().qqGroupConfigEditor;
    expect(editor?.overrides.stickers?.frequency).toBe("low");
    expect(qqGroupConfigDirty(editor)).toBe(true);

    // 若 source.overrides 本身已存 low，则此时应为 not dirty
    const savedLowConfig = qqConfig({
      overrides: overridesOf({ stickers: { frequency: "low" } }),
    });
    store.setState({
      qqGroupConfigEditor: qqGroupConfigEditorFrom(savedLowConfig),
    });
    editor = store.getState().qqGroupConfigEditor;
    expect(qqGroupConfigDirty(editor)).toBe(false);

    // 恢复跟随（传入 undefined）
    store.setState({
      qqGroupConfigEditor: qqGroupConfigEditorFrom(config),
    });
    store.getState().patchQqGroupOverride("stickers", "frequency", "low");
    store.getState().patchQqGroupOverride("stickers", "frequency", undefined);
    editor = store.getState().qqGroupConfigEditor;
    expect(editor?.overrides.stickers?.frequency).toBeUndefined();
    expect(qqGroupConfigDirty(editor)).toBe(false);

    // 非法值输入拦截：比如非法字符串
    store.getState().patchQqGroupOverride("stickers", "frequency", "invalid_enum");
    editor = store.getState().qqGroupConfigEditor;
    expect(editor?.rawTexts["stickers.frequency"]).toBe("invalid_enum");
    expect(editor?.overrides.stickers?.frequency).toBeUndefined();
    expect(qqGroupConfigDirty(editor)).toBe(true);
    expect(qqGroupConfigHasInvalidInputs(editor)).toBe(true);
  });

  it("Group Config UI renders frequency RadioGroup, saves sparse frequency override, and clears on follow", async () => {
    const base = scheme();
    const config = qqConfig();
    const fakeApi = {
      ...api,
      getQqGroupConfig: vi.fn(async () => config),
      saveQqGroupConfig: vi.fn(async (_id: string, req: unknown) =>
        qqConfig({
          overrides: (req as { overrides: QqGroupConfigResponse["overrides"] }).overrides,
          revision: 1,
        }),
      ),
      listQqSchemes: vi.fn(async () => [base]),
      listQqStickerCollections: vi.fn(async () => []),
      listQqStickerAssets: vi.fn(async () => []),
      getPermissions: vi.fn(async () => permissions()),
      getAgentKnowledgeRead: vi.fn(async () => knowledgeRead(false)),
      updateQqGroupConfig: vi.fn().mockResolvedValue({}),
    } as unknown as SuperstringApi;

    store.getState().resetForTests(fakeApi);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-group-config",
    });
    await store.getState().selectQqGroupConfig(BINDING_ID);

    render(<QqGroupConfigPage />);
    await act(async () => {});

    // 切换到表情发送
    await userEvent.click(screen.getByRole("tab", { name: "表情发送" }));

    // 验证退役控件不渲染
    expect(screen.queryByLabelText("每条回复最多几张表情")).toBeNull();

    // 验证频率 RadioGroup 渲染，默认选中 medium（平衡选择）
    const mediumRadio = screen.getByRole("radio", { name: /平衡选择/ });
    expect(mediumRadio.getAttribute("data-state")).toBe("checked");

    // 点击切换为 high（积极考虑）
    const highRadio = screen.getByRole("radio", { name: /积极考虑/ });
    await userEvent.click(highRadio);
    expect(highRadio.getAttribute("data-state")).toBe("checked");

    // 点击保存，验证实际 saveQqGroupConfig 调用的 payload
    const saveButton = screen.getByRole("button", { name: "保存本群配置" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(fakeApi.saveQqGroupConfig).toHaveBeenCalledWith(
      BINDING_ID,
      expect.objectContaining({
        overrides: expect.objectContaining({
          stickers: expect.objectContaining({
            frequency: "high",
          }),
        }),
      }),
    );

    // 恢复跟随：通过字段状态选择框切回 "跟随方案"
    const fieldStateSelect = screen.getByLabelText("表情发送倾向: 字段使用方式");
    await userEvent.selectOptions(fieldStateSelect, "follow");

    // 再次保存，验证 payload 中 stickers 不再携带 frequency 覆盖（稀疏清除）
    await act(async () => {
      fireEvent.click(saveButton);
    });

    const secondCallPayload = (fakeApi.saveQqGroupConfig as ReturnType<typeof vi.fn>).mock
      .calls[1]?.[1] as { overrides: QqGroupSchemeOverrides };
    expect(secondCallPayload.overrides.stickers?.frequency).toBeUndefined();
  });

  it("Group Config UI preserves dirty frequency override across refresh baseline", async () => {
    const base = scheme();
    const config = qqConfig();
    const fakeApi = {
      ...api,
      getQqGroupConfig: vi.fn(async () => config),
      saveQqGroupConfig: vi.fn(async () => qqConfig({ revision: 1 })),
      listQqSchemes: vi.fn(async () => [base]),
      listQqStickerCollections: vi.fn(async () => []),
      listQqStickerAssets: vi.fn(async () => []),
      getPermissions: vi.fn(async () => permissions()),
      getAgentKnowledgeRead: vi.fn(async () => knowledgeRead(false)),
      updateQqGroupConfig: vi.fn().mockResolvedValue({}),
    } as unknown as SuperstringApi;

    store.getState().resetForTests(fakeApi);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-group-config",
    });
    await store.getState().selectQqGroupConfig(BINDING_ID);

    render(<QqGroupConfigPage />);
    await act(async () => {});

    // 切换到表情发送，设置覆盖为 low
    await userEvent.click(screen.getByRole("tab", { name: "表情发送" }));
    const lowRadio = screen.getByRole("radio", { name: /较少使用/ });
    await userEvent.click(lowRadio);

    expect(store.getState().qqGroupConfigEditor?.overrides.stickers?.frequency).toBe("low");
    expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(true);

    // 点击刷新保存基线
    const refreshButton = screen.getByRole("button", { name: "刷新保存基线" });
    await act(async () => {
      fireEvent.click(refreshButton);
    });

    // 三路合并：本地在途脏草稿 low 仍然保留，不被服务端的默认 medium 冲掉
    expect(store.getState().qqGroupConfigEditor?.overrides.stickers?.frequency).toBe("low");
    expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(true);
  });

  it("Group Config UI displays raw error and aria-describedby when invalid raw frequency exists, blocking save", async () => {
    const base = scheme();
    const config = qqConfig();
    const fakeApi = {
      ...api,
      getQqGroupConfig: vi.fn(async () => config),
      saveQqGroupConfig: vi.fn(async () => qqConfig({ revision: 1 })),
      listQqSchemes: vi.fn(async () => [base]),
      listQqStickerCollections: vi.fn(async () => []),
      listQqStickerAssets: vi.fn(async () => []),
      getPermissions: vi.fn(async () => permissions()),
      getAgentKnowledgeRead: vi.fn(async () => knowledgeRead(false)),
      updateQqGroupConfig: vi.fn().mockResolvedValue({}),
    } as unknown as SuperstringApi;

    store.getState().resetForTests(fakeApi);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-group-config",
    });
    await store.getState().selectQqGroupConfig(BINDING_ID);

    render(<QqGroupConfigPage />);
    await act(async () => {});

    // 切换到表情发送
    await userEvent.click(screen.getByRole("tab", { name: "表情发送" }));

    // 注入非法原文
    act(() => {
      store.getState().patchQqGroupOverride("stickers", "frequency", "invalid_enum");
    });

    // 验证 RadioGroup 带有 aria-invalid 和 aria-describedby
    const radiogroup = screen.getByRole("radiogroup");
    expect(radiogroup.getAttribute("aria-invalid")).toBe("true");
    const errorId = radiogroup.getAttribute("aria-describedby");
    expect(errorId).toBeTruthy();

    // 验证错误提示段落
    const errorAlert = screen.getByRole("alert");
    expect(errorAlert.id).toBe(errorId);
    expect(errorAlert.textContent).toBe("invalid_enum");

    // 验证保存按钮被禁用
    const saveButton = screen.getByRole("button", { name: "保存本群配置" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it("SystemComponents renders QQ runtime tools (reply.text, reply.sticker) instead of speech.reply, and shows global off reason for stickers", async () => {
    const qqReplyEntry = CAPABILITY_CATALOG.find((e) => e.id === "qq-reply");
    if (!qqReplyEntry) throw new Error("qq-reply entry not found");
    const fakeApi = {
      ...api,
      getToolDirectory: vi.fn().mockResolvedValue({
        tools: [
          {
            name: "sticker.search",
            description: "Search stickers",
            parameters: {},
            capability: "stickers",
            effect: "read",
            sandboxCallable: true,
            origin: "system",
            globalEnabled: false, // 全局关闭表情
            functionId: "media-stickers",
            resource: null,
            revision: null,
            approvalRequired: false,
            directories: [],
          },
        ],
      }),
      listSkills: vi.fn().mockResolvedValue({ skills: [] }),
    } as unknown as typeof api;

    store.getState().resetForTests(fakeApi);
    render(<SystemComponents entry={qqReplyEntry} />);
    await act(async () => {});

    // 断言不应该存在旧硬编码 speech.reply
    expect(screen.queryByText("speech.reply")).toBeNull();

    // 应该显示 reply.text 和 reply.sticker
    expect(screen.getByText("reply.text")).toBeDefined();
    expect(screen.getByText("reply.sticker")).toBeDefined();

    // reply.sticker 旁边应该有 (全局已关闭)
    expect(screen.getByText(/全局已关闭/)).toBeDefined();
  });
});
