// 本群配置（真实 store + fake API）：导航身份与守卫的定向用例——
// 同 id 换 agent 视为新目标（仅显式打开才重读）、保存期间拦截、同页换群的确认/取消/放弃、
// 重置换 client 后同编号的迟到读取不落地，以及全局变更预览的资源/布尔文案。
//
// 只断言 store 状态与请求参数，不渲染页面；页面接线由 UI 自身负责。

import { beforeEach, expect, it, vi } from "vitest";
import type { QqBindingResponse, QqSchemeResponse } from "../../src/shared/contracts/qq";
import type {
  QqGroupConfigResponse,
  QqGroupSchemeOverrides,
} from "../../src/shared/contracts/qq-group-config";
import { api, type SuperstringApi } from "../../src/web/api";
import { qqDraftChanges } from "../../src/web/features/qq/draft-state";
import { qqGroupConfigEditorFrom } from "../../src/web/features/qq/group-config-state";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-30T00:00:00.000Z";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BINDING_ID = "11111111-1111-4111-8111-222222222222";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT_ID = "44444444-4444-4444-8444-555555555555";
const BASE_SCHEME_ID = "22222222-2222-4222-8222-222222222222";

const qqScheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
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
    max_sticker_count: 1,
    media_supplement_window_minutes: 10,
    media_frame_count: 3,
    media_max_dimension: 512,
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
  ...overrides,
});

const qqConfig = (binding: QqBindingResponse): QqGroupConfigResponse => {
  const base = qqScheme();
  return {
    binding,
    base_scheme: base,
    effective_scheme: base,
    // 运行时差异稀疏（空组在上游归一化时被去掉）。
    overrides: {} as unknown as QqGroupSchemeOverrides,
    disabled_capabilities: [],
    revision: 0,
  };
};

const fakeClient = (overrides: Partial<SuperstringApi>): SuperstringApi => ({
  ...api,
  ...overrides,
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const editorOf = () => store.getState().qqGroupConfigEditor;

beforeEach(() => {
  store.getState().resetForTests();
});

it("同 id 换 agent（编辑器干净）：显式打开按目录身份重读", async () => {
  const read = vi.fn(async (id: string) => qqConfig(qqBinding({ id, agent_id: OTHER_AGENT_ID })));
  store.getState().resetForTests(fakeClient({ getQqGroupConfig: read }));
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-group-config",
    qqBindings: [qqBinding({ agent_id: OTHER_AGENT_ID })],
    qqBindingsLoaded: true,
    qqGroupConfigBindingId: BINDING_ID,
    // 编辑器还是旧 agent 的答案。
    qqGroupConfigEditor: qqGroupConfigEditorFrom(qqConfig(qqBinding({ agent_id: AGENT_ID }))),
  });

  store.getState().openQqGroupConfig(BINDING_ID);
  expect(read).toHaveBeenCalledTimes(1);
  await flush();
  expect(read).toHaveBeenCalledWith(BINDING_ID);
  expect(editorOf()?.source.binding.id).toBe(BINDING_ID);
  expect(editorOf()?.source.binding.agent_id).toBe(OTHER_AGENT_ID);
});

it("同一身份重复打开：不重读、路由与草稿原样", async () => {
  const read = vi.fn(async (id: string) => qqConfig(qqBinding({ id })));
  store.getState().resetForTests(fakeClient({ getQqGroupConfig: read }));
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-group-config",
    qqBindings: [qqBinding()],
    qqBindingsLoaded: true,
    qqGroupConfigBindingId: BINDING_ID,
    qqGroupConfigEditor: qqGroupConfigEditorFrom(qqConfig(qqBinding())),
  });
  store.getState().patchQqGroupOverride("context", "reply_token_budget", "9000");
  const editor = editorOf();

  store.getState().openQqGroupConfig(BINDING_ID);
  await flush();
  expect(read).not.toHaveBeenCalled();
  expect(editorOf()).toBe(editor);
  expect(qqDraftChanges(store.getState())).toHaveLength(1);
  expect(store.getState().settingsRoute).toBe("qq-group-config");
  expect(store.getState().navigationConfirmOpen).toBe(false);
});

it("同 id 换 agent（编辑器有草稿）：先守卫；放弃后换到新身份", async () => {
  const read = vi.fn(async (id: string) => qqConfig(qqBinding({ id, agent_id: OTHER_AGENT_ID })));
  store.getState().resetForTests(fakeClient({ getQqGroupConfig: read }));
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-group-config",
    qqBindings: [qqBinding({ agent_id: OTHER_AGENT_ID })],
    qqBindingsLoaded: true,
    qqGroupConfigBindingId: BINDING_ID,
    qqGroupConfigEditor: qqGroupConfigEditorFrom(qqConfig(qqBinding({ agent_id: AGENT_ID }))),
  });
  store.getState().patchQqGroupOverride("context", "reply_token_budget", "9000");

  store.getState().openQqGroupConfig(BINDING_ID);
  expect(read).not.toHaveBeenCalled();
  expect(store.getState()).toMatchObject({
    navigationConfirmOpen: true,
    pendingNavigation: { kind: "group-config", bindingId: BINDING_ID },
    qqGroupConfigBindingId: BINDING_ID,
  });

  await store.getState().confirmDiscardAndContinue();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(BINDING_ID);
  expect(editorOf()?.source.binding.agent_id).toBe(OTHER_AGENT_ID);
  expect(qqDraftChanges(store.getState())).toHaveLength(0);
  expect(store.getState()).toMatchObject({
    pendingNavigation: null,
    navigationConfirmOpen: false,
    qqGroupConfigBindingId: BINDING_ID,
  });
});

it("保存期间：换群入口与设置路由都被拦下", async () => {
  const read = vi.fn(async (id: string) =>
    qqConfig(qqBinding({ id, peer_id: id === BINDING_ID ? "123456789" : "987654321" })),
  );
  store.getState().resetForTests(fakeClient({ getQqGroupConfig: read }));
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-group-config",
    qqBindings: [qqBinding(), qqBinding({ id: OTHER_BINDING_ID, peer_id: "987654321" })],
    qqBindingsLoaded: true,
    qqGroupConfigBindingId: BINDING_ID,
    qqGroupConfigEditor: qqGroupConfigEditorFrom(qqConfig(qqBinding())),
    qqGroupConfigSaving: true,
  });

  store.getState().openQqGroupConfig(OTHER_BINDING_ID);
  store.getState().openSettingsRoute("qq-connection");
  expect(store.getState()).toMatchObject({
    settingsRoute: "qq-group-config",
    qqGroupConfigBindingId: BINDING_ID,
    pendingNavigation: null,
    navigationConfirmOpen: false,
  });
  expect(read).not.toHaveBeenCalled();

  // 解除保存后：同页换群直接落地（编辑器干净，无需确认）。
  store.setState({ qqGroupConfigSaving: false });
  store.getState().openQqGroupConfig(OTHER_BINDING_ID);
  await flush();
  expect(read).toHaveBeenCalledWith(OTHER_BINDING_ID);
  expect(editorOf()?.source.binding.id).toBe(OTHER_BINDING_ID);
  expect(store.getState()).toMatchObject({
    settingsRoute: "qq-group-config",
    qqGroupConfigBindingId: OTHER_BINDING_ID,
    pendingNavigation: null,
  });
});

it("重置换 client 后：同编号的旧读取晚到不覆盖新编辑器", async () => {
  const stale = deferred<QqGroupConfigResponse>();
  store.getState().resetForTests(fakeClient({ getQqGroupConfig: vi.fn(() => stale.promise) }));
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "scheme-bindings",
    qqBindings: [qqBinding()],
    qqBindingsLoaded: true,
  });
  store.getState().openQqGroupConfig(BINDING_ID);
  await flush();
  expect(store.getState().qqGroupConfigLoading).toBe(true);
  expect(store.getState().qqGroupConfigReadId).toBe(1);

  // 重置：store 计数清零（下一次读取又会拿到编号 1），模块令牌不回收；随后换新 client 重开。
  const fresh = qqConfig(qqBinding({ agent_id: OTHER_AGENT_ID }));
  store.getState().resetForTests(fakeClient({ getQqGroupConfig: vi.fn(async () => fresh) }));
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "scheme-bindings",
    qqBindings: [qqBinding({ agent_id: OTHER_AGENT_ID })],
    qqBindingsLoaded: true,
  });
  store.getState().openQqGroupConfig(BINDING_ID);
  await flush();
  expect(store.getState().qqGroupConfigReadId).toBe(1);
  expect(editorOf()?.source.binding.agent_id).toBe(OTHER_AGENT_ID);

  // 旧 client 的答案晚到（编号相同，但 api 身份已换）：不得覆盖新编辑器。
  stale.resolve(qqConfig(qqBinding({ agent_id: AGENT_ID })));
  await flush();
  expect(editorOf()?.source.binding.agent_id).toBe(OTHER_AGENT_ID);
  expect(store.getState()).toMatchObject({ qqGroupConfigLoading: false, error: null });
});

it("同页换群（有草稿）：取消保留草稿与原群；放弃后换群落地", async () => {
  const read = vi.fn(async (id: string) =>
    qqConfig(qqBinding({ id, peer_id: id === BINDING_ID ? "123456789" : "987654321" })),
  );
  store.getState().resetForTests(fakeClient({ getQqGroupConfig: read }));
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "scheme-bindings",
    qqBindings: [qqBinding(), qqBinding({ id: OTHER_BINDING_ID, peer_id: "987654321" })],
    qqBindingsLoaded: true,
  });
  store.getState().openQqGroupConfig(BINDING_ID);
  await flush();
  store.getState().patchQqGroupOverride("context", "reply_token_budget", "9000");
  expect(qqDraftChanges(store.getState())).toHaveLength(1);

  store.getState().openQqGroupConfig(OTHER_BINDING_ID);
  expect(store.getState()).toMatchObject({
    settingsRoute: "qq-group-config",
    qqGroupConfigBindingId: BINDING_ID,
    navigationConfirmOpen: true,
    pendingNavigation: { kind: "group-config", bindingId: OTHER_BINDING_ID },
  });
  expect(read).toHaveBeenCalledTimes(1);

  store.getState().cancelPendingNavigation();
  expect(store.getState()).toMatchObject({
    pendingNavigation: null,
    navigationConfirmOpen: false,
    qqGroupConfigBindingId: BINDING_ID,
  });
  expect(qqDraftChanges(store.getState())).toHaveLength(1);

  store.getState().openQqGroupConfig(OTHER_BINDING_ID);
  await store.getState().confirmDiscardAndContinue();
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith(OTHER_BINDING_ID);
  expect(editorOf()?.source.binding.id).toBe(OTHER_BINDING_ID);
  expect(qqDraftChanges(store.getState())).toHaveLength(0);
  expect(store.getState()).toMatchObject({
    settingsRoute: "qq-group-config",
    qqGroupConfigBindingId: OTHER_BINDING_ID,
    pendingNavigation: null,
    navigationConfirmOpen: false,
  });
});

it("确认保存并继续遇非法原文：保存被拦、不调 API、确认框留在原地且草稿与目标不变", async () => {
  const read = vi.fn(async (id: string) =>
    qqConfig(qqBinding({ id, peer_id: id === BINDING_ID ? "123456789" : "987654321" })),
  );
  const groupSave = vi.fn();
  const schemeSave = vi.fn();
  store.getState().resetForTests(
    fakeClient({
      getQqGroupConfig: read,
      saveQqGroupConfig: groupSave,
      updateQqScheme: schemeSave,
    }),
  );
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "scheme-bindings",
    qqBindings: [qqBinding(), qqBinding({ id: OTHER_BINDING_ID, peer_id: "987654321" })],
    qqBindingsLoaded: true,
  });
  store.getState().openQqGroupConfig(BINDING_ID);
  await flush();
  // 界面只收整数百分比：5.5% 是非法原文，统一保存必须先要求修正。
  store.getState().patchQqGroupOverride("compression", "headroom_ratio", "5.5");
  expect(qqDraftChanges(store.getState())).toHaveLength(1);

  store.getState().openQqGroupConfig(OTHER_BINDING_ID);
  expect(store.getState()).toMatchObject({
    navigationConfirmOpen: true,
    pendingNavigation: { kind: "group-config", bindingId: OTHER_BINDING_ID },
  });

  await store.getState().confirmSaveAndContinue();
  expect(groupSave).not.toHaveBeenCalled();
  expect(schemeSave).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
  expect(store.getState()).toMatchObject({
    navigationConfirmOpen: true,
    pendingNavigation: { kind: "group-config", bindingId: OTHER_BINDING_ID },
    settingsRoute: "qq-group-config",
    qqGroupConfigBindingId: BINDING_ID,
    error: "请先修正方案中的无效数字，再保存。",
  });
  expect(editorOf()?.rawTexts).toEqual({ "compression.headroom_ratio": "5.5" });
});

it("全局变更预览：群行用「群 · peer」，布尔字段用开/关而不是 true/false", async () => {
  const read = vi.fn(async (id: string) => qqConfig(qqBinding({ id })));
  store.getState().resetForTests(fakeClient({ getQqGroupConfig: read }));
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "scheme-bindings",
    qqBindings: [qqBinding()],
    qqBindingsLoaded: true,
  });
  store.getState().openQqGroupConfig(BINDING_ID);
  await flush();

  store.getState().patchQqGroupOverride("triggers", "direct_reply", false);
  const rows = qqDraftChanges(store.getState());
  expect(rows).toHaveLength(1);
  expect(rows[0].resource).toBe("群 · 123456789");
  expect(rows[0].changes).toEqual(["「直接回应」：开 → 关"]);
});

it("未选群：无本群草稿行，核心设置路由照常切换", () => {
  store.getState().resetForTests(fakeClient({}));
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "scheme-bindings",
    qqBindings: [],
    qqBindingsLoaded: true,
  });
  expect(store.getState()).toMatchObject({
    qqGroupConfigEditor: null,
    qqGroupConfigBindingId: null,
    qqGroupConfigReadId: 0,
  });
  expect(qqDraftChanges(store.getState())).toEqual([]);

  store.getState().openSettingsRoute("qq-connection");
  expect(store.getState()).toMatchObject({
    settingsRoute: "qq-connection",
    navigationConfirmOpen: false,
  });
});
