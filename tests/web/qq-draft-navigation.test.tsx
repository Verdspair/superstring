import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QqSchemeResponse, QqSettingsResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { qqDraftChanges } from "../../src/web/features/qq/draft-state";
import { qqSchemeDirty, qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { QqAppManagement } from "../../src/web/screens/connections/qq-app-management";
import { hasUnsavedDrafts } from "../../src/web/state/unsaved-changes";
import { useSuperstringStore as store } from "../../src/web/store";
import { NavigationGuard as NavigationConfirm } from "../../src/web/workspace/NavigationGuard";

const NOW = "2026-09-24T00:00:00.000Z";
const qqSchemeFixture = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
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

const settings: QqSettingsResponse = {
  enabled: true,
  account_id: "100",
  judgement_model_name: null,
  transport: { endpoint: "ws://localhost:3000", has_token: true },
  revision: 3,
};
const connection = (token = "") => ({
  source: settings,
  endpoint: "ws://localhost:4000",
  accountId: "100",
  token,
});
beforeEach(() => {
  store.getState().resetForTests({
    ...api,
    getQqSettings: async () => settings,
    getQqOwner: async () => ({
      configured: false,
      account_id: null,
      peer_id: null,
      revision: null,
    }),
    getQqStatus: async () => ({ connection: null }) as never,
    listQqConversations: async () => [],
    listQqBindings: async () => [],
    listQqSchemes: async () => [qqSchemeFixture()],
    getQqSchemeUsage: async () => ({ scheme_id: qqSchemeFixture().id, bindings: 0 }),
  });
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
    qqSchemeEditor: qqSchemeEditorFrom(qqSchemeFixture()),
    qqSettings: settings,
  });
});
afterEach(cleanup);

it("raw invalid scheme input survives cancelled navigation and cannot save the old valid number", async () => {
  const update = vi.fn();
  store.setState({
    apiClient: { ...store.getState().apiClient, updateQqScheme: update },
    qqInputs: { ...store.getState().qqInputs, schemeTexts: { "rhythm.hourly_speech_limit": "-" } },
  });
  store.getState().openSettingsRoute("qq-stickers");
  expect(store.getState().navigationConfirmOpen).toBe(true);
  expect(store.getState().settingsRoute).toBe("qq-scheme-config");
  await store.getState().confirmSaveAndContinue();
  expect(update).not.toHaveBeenCalled();
  expect(store.getState().navigationConfirmOpen).toBe(true);
  store.getState().cancelPendingNavigation();
  expect(store.getState().qqInputs.schemeTexts["rhythm.hourly_speech_limit"]).toBe("-");
  store.getState().openSettingsRoute("qq-stickers");
  await store.getState().confirmDiscardAndContinue();
  expect(store.getState().settingsRoute).toBe("qq-stickers");
  expect(store.getState().qqInputs.schemeTexts).toEqual({});
});

it("connection draft survives remount and server refresh while retaining its original revision", async () => {
  store.setState({
    qqInputs: { ...store.getState().qqInputs, connection: connection("replacement-secret") },
  });
  const view = render(<QqAppManagement view="connection" />);
  await act(async () => {});
  // 连接配置在 QQ 应用管理的「连接」任务里：字段直接可见。
  expect((screen.getByRole("textbox", { name: "WebSocket 地址" }) as HTMLInputElement).value).toBe(
    "ws://localhost:4000",
  );
  view.unmount();
  store.setState({
    apiClient: {
      ...store.getState().apiClient,
      getQqSettings: async () => ({
        ...settings,
        revision: 8,
        transport: { endpoint: "ws://elsewhere", has_token: true },
      }),
    },
  });
  render(<QqAppManagement view="connection" />);
  await act(async () => {});
  expect((screen.getByRole("textbox", { name: "WebSocket 地址" }) as HTMLInputElement).value).toBe(
    "ws://localhost:4000",
  );
  expect(store.getState().qqInputs.connection?.source.revision).toBe(3);
  expect(hasUnsavedDrafts(store.getState())).toBe(true);
});

it("navigation change preview never exposes the replacement token", () => {
  store.setState({
    qqInputs: { ...store.getState().qqInputs, connection: connection("replacement-secret") },
  });
  store.getState().openChat();
  render(<NavigationConfirm />);
  expect(screen.getByRole("alertdialog").textContent).not.toContain("replacement-secret");
  expect(screen.getByText("访问令牌将被替换（不显示内容）")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消离开" }));
  expect(store.getState().qqInputs.connection?.token).toBe("replacement-secret");
});

it("openChat 的守卫载荷携带消息/当前，保存成功后按目标视图落地", async () => {
  const update = vi.fn(async (_id, body) => ({ ...qqSchemeFixture(), ...body, revision: 4 }));
  store.setState({
    apiClient: { ...store.getState().apiClient, updateQqScheme: update },
    conversationView: "activity",
    conversationScope: "global",
  });
  store.getState().patchQqScheme({ name: "新方案名" });
  store.getState().openChat();
  expect(store.getState().pendingNavigation).toEqual({
    kind: "page",
    page: "chat",
    settingsView: "hub",
    conversationView: "messages",
    conversationScope: "current",
  });
  await store.getState().confirmSaveAndContinue();
  expect(update).toHaveBeenCalledOnce();
  expect(store.getState()).toMatchObject({
    page: "chat",
    conversationView: "messages",
    conversationScope: "current",
    pendingNavigation: null,
  });
});

it("partial save preserves completed scheme changes and retains the failed connection draft", async () => {
  const update = vi.fn(async (_id, body) => ({ ...qqSchemeFixture(), ...body, revision: 4 }));
  const failed = vi.fn().mockRejectedValue(new Error("connection conflict"));
  store.setState({
    apiClient: { ...store.getState().apiClient, updateQqScheme: update, updateQqSettings: failed },
    qqInputs: { ...store.getState().qqInputs, connection: connection() },
  });
  store.getState().patchQqScheme({ name: "新方案名" });
  store.getState().openChat();
  await store.getState().confirmSaveAndContinue();
  expect(update).toHaveBeenCalledOnce();
  expect(qqSchemeDirty(store.getState().qqSchemeEditor)).toBe(false);
  expect(store.getState().qqSchemeEditor?.name).toBe("新方案名");
  expect(store.getState().page).toBe("settings");
  expect(qqDraftChanges(store.getState()).map((row) => row.resource)).toEqual(["连接"]);
  await store.getState().confirmSaveAndContinue();
  expect(update).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledTimes(2);
});

it("connection save uses the draft revision and carries forward a successful first request", async () => {
  const update = vi.fn(async () => ({ ...settings, account_id: "101", revision: 4 }));
  const transport = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ ...settings, account_id: "101", revision: 6 });
  store.setState({
    qqSettings: { ...settings, revision: 9 },
    apiClient: {
      ...store.getState().apiClient,
      updateQqSettings: update,
      updateQqTransport: transport,
    },
    qqInputs: { ...store.getState().qqInputs, connection: { ...connection(), accountId: "101" } },
  });
  expect(await store.getState().saveQqDrafts()).toBe(false);
  expect(update).toHaveBeenCalledWith({ account_id: "101", expected_revision: 3 });
  expect(store.getState().qqInputs.connection?.source.revision).toBe(4);
  expect(store.getState().qqSettings?.account_id).toBe("101");
});

it("storage and connection share one revision chain: the first save advances the other draft's baseline", async () => {
  const storageSave = vi.fn(
    async (body: { retention_days: number; expected_revision: number }) => ({
      revision: body.expected_revision + 1,
      retention_days: body.retention_days,
      cleanup_mode: "manual" as const,
    }),
  );
  const settingsSave = vi.fn(
    async (body: { account_id?: string | null; expected_revision: number }) => ({
      ...settings,
      account_id: body.account_id === undefined ? settings.account_id : body.account_id,
      revision: body.expected_revision + 1,
    }),
  );
  const transportSave = vi.fn(
    async (body: { endpoint?: string | null; expected_revision: number }) => ({
      ...settings,
      transport: {
        endpoint: body.endpoint === undefined ? settings.transport.endpoint : body.endpoint,
        has_token: true,
      },
      revision: body.expected_revision + 1,
    }),
  );
  store.setState({
    apiClient: {
      ...store.getState().apiClient,
      updateQqStorageSettings: storageSave,
      updateQqSettings: settingsSave,
      updateQqTransport: transportSave,
    },
    qqSettings: settings,
    qqInputs: {
      ...store.getState().qqInputs,
      storage: {
        source: { revision: 3, retention_days: 14, cleanup_mode: "manual" as const },
        days: "30",
      },
      connection: connection("replacement-secret"),
    },
  });
  expect(await store.getState().saveQqDrafts()).toBe(true);
  // 先写的 storage（3→4）把共享基线推进给连接草稿：连接保存从 4 出发，而不是拿旧 3 自撞 409。
  expect(storageSave).toHaveBeenCalledWith({ retention_days: 30, expected_revision: 3 });
  expect(settingsSave).toHaveBeenCalledWith({ account_id: "100", expected_revision: 4 });
  expect(transportSave).toHaveBeenCalledWith({
    endpoint: "ws://localhost:4000",
    token: "replacement-secret",
    expected_revision: 5,
  });
  expect(store.getState().qqSettings?.revision).toBe(6);
  expect(store.getState().qqInputs.storage).toBeNull();
  expect(store.getState().qqInputs.connection).toBeNull();
});

it("an external revision conflict still fails without advancing the other baseline or retrying", async () => {
  const conflict = vi
    .fn()
    .mockRejectedValue(new Error("QQ 接入设置已在别处被修改，请刷新后重试。"));
  const settingsSave = vi.fn();
  store.setState({
    apiClient: {
      ...store.getState().apiClient,
      updateQqStorageSettings: conflict,
      updateQqSettings: settingsSave,
    },
    qqSettings: settings,
    qqInputs: {
      ...store.getState().qqInputs,
      storage: {
        source: { revision: 3, retention_days: 14, cleanup_mode: "manual" as const },
        days: "30",
      },
      connection: connection("replacement-secret"),
    },
  });
  expect(await store.getState().saveQqDrafts()).toBe(false);
  // 外部 CAS 冲突不是「自己刚写过的推进」：只失败一次，不猜修订、不继续写连接、不自动重试。
  expect(conflict).toHaveBeenCalledTimes(1);
  expect(settingsSave).not.toHaveBeenCalled();
  expect(store.getState().error).toBe("QQ 接入设置已在别处被修改，请刷新后重试。");
  expect(store.getState().qqInputs.storage?.days).toBe("30");
  expect(store.getState().qqInputs.connection?.source.revision).toBe(3);
});

it("QQ automatic organization drafts participate in the same unload decision", () => {
  expect(hasUnsavedDrafts(store.getState())).toBe(false);
  store.getState().patchQqMemoryBatchDraft("binding", { value: "", revision: 2 });
  expect(hasUnsavedDrafts(store.getState())).toBe(true);
});

it("a failed transport save stays visible on the connection page and retains the draft", async () => {
  const save = vi.fn().mockRejectedValue(Error("TRANSPORT_TEST_FAILURE"));
  store.setState({
    apiClient: { ...store.getState().apiClient, updateQqSettings: save },
    qqInputs: { ...store.getState().qqInputs, connection: connection() },
  });
  render(<QqAppManagement view="connection" />);
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存接入设置" })));
  expect(save).toHaveBeenCalledTimes(1);
  // 页首状态提示与内联表单都会显示同一条失败原因（都在文档流里，不是浮层）。
  expect(
    screen
      .getAllByRole("alert")
      .some((node) => node.textContent?.includes("TRANSPORT_TEST_FAILURE")),
  ).toBe(true);
  expect((screen.getByRole("textbox", { name: "WebSocket 地址" }) as HTMLInputElement).value).toBe(
    "ws://localhost:4000",
  );
});
