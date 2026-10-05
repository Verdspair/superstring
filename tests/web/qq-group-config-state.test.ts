// 本群配置（真实 store + fake API）：状态与请求形状的断言——稀疏改写、三段 CAS、守卫与合并语义。
//
// 这些用例验证的是状态与请求形状，不是浏览器验收：页面接线由 UI 自身负责，fake 通过不代表界面通过。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QqBindingResponse, QqSchemeResponse } from "../../src/shared/contracts/qq";
import {
  type QqGroupConfigResponse,
  type QqGroupSchemeOverrides,
  type UpdateQqGroupConfigRequest,
  UpdateQqGroupConfigRequestSchema,
} from "../../src/shared/contracts/qq-group-config";
import { api, type SuperstringApi } from "../../src/web/api";
import { qqDraftChanges } from "../../src/web/features/qq/draft-state";
import {
  mergeQqGroupConfigEditor,
  qqGroupConfigChanges,
  qqGroupConfigDirty,
  qqGroupConfigEditorFrom,
  qqGroupConfigEffectiveScheme,
} from "../../src/web/features/qq/group-config-state";
import { hasUnsavedDrafts } from "../../src/web/state/unsaved-changes";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-30T00:00:00.000Z";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BINDING_ID = "11111111-1111-4111-8111-222222222222";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT_ID = "44444444-4444-4444-8444-555555555555";
const BASE_SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_SCHEME_ID = "33333333-3333-4333-8333-333333333333";
const COLLECTION_ID = "55555555-5555-4555-8555-555555555555";

/** 运行时差异是稀疏的（空组在契约归一化时被去掉）：夹具照运行时形态造，用一次显式收窄。 */
const overridesOf = (bag: Record<string, Record<string, unknown>>): QqGroupSchemeOverrides =>
  bag as unknown as QqGroupSchemeOverrides;

const qqScheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: BASE_SCHEME_ID,
  name: "默认方案",
  description: null,
  triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
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
  reply: { split_by_speaker: true },
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

const qqConfig = (overrides: Partial<QqGroupConfigResponse> = {}): QqGroupConfigResponse => {
  const base = qqScheme();
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

const fakeClient = (overrides: Partial<SuperstringApi>): SuperstringApi => ({
  ...api,
  ...overrides,
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const ready = (client: SuperstringApi, bindings: QqBindingResponse[] = [qqBinding()]) => {
  store.getState().resetForTests(client);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "scheme-bindings",
    qqBindings: bindings,
    qqBindingsLoaded: true,
  });
};

const editorOf = () => store.getState().qqGroupConfigEditor;

beforeEach(() => {
  store.getState().resetForTests();
});

it("打开本群配置读取答案；保存提交三段 CAS 与整份稀疏改动，成功后推进绑定行与基线", async () => {
  const get = vi.fn(async () => qqConfig());
  const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
    ...qqConfig({
      revision: 1,
      overrides: body.overrides,
      disabled_capabilities: body.disabled_capabilities,
    }),
    binding: qqBinding({ revision: 5 }),
  }));
  ready(fakeClient({ getQqGroupConfig: get, saveQqGroupConfig: save }));

  store.getState().openQqGroupConfig(BINDING_ID);
  await flush();
  expect(get).toHaveBeenCalledWith(BINDING_ID);
  expect(store.getState()).toMatchObject({
    settingsRoute: "qq-group-config",
    qqGroupConfigBindingId: BINDING_ID,
    pendingNavigation: null,
  });
  expect(store.getState().qqGroupConfigEditor?.source.revision).toBe(0);
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(false);

  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");
  store.getState().setQqGroupCapability("tasks", true);
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(true);

  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  // 只有本群：一次 PUT，Agent 与三段 revision 全部取打开时的快照；没有 scheme_id/scheme_change。
  expect(save).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledWith(BINDING_ID, {
    agent_id: AGENT_ID,
    expected_binding_revision: 4,
    expected_scheme_revision: 3,
    expected_revision: 0,
    // 稀疏提交：只带显式自定义的组，不补空组骨架。
    overrides: { rhythm: { merge_window_seconds: 45 } },
    disabled_capabilities: ["tasks"],
  });
  expect(UpdateQqGroupConfigRequestSchema.safeParse(save.mock.calls[0][1]).success).toBe(true);
  // 保存成功的行回写绑定目录（防旧卡片），编辑器基线跟随响应。
  expect(store.getState().qqBindings.find((row) => row.id === BINDING_ID)?.revision).toBe(5);
  expect(store.getState().qqGroupConfigEditor?.source.revision).toBe(1);
  expect(store.getState().qqGroupConfigEditor?.source.binding.revision).toBe(5);
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(false);
  expect(store.getState().feedback).toBe("已保存");
});

it("显式设成与基线同值也固定（数字/0/false/空集合/同文提示词）；只有 undefined 回到跟随", async () => {
  const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
    ...qqConfig({ revision: 1, overrides: body.overrides }),
    binding: qqBinding({ revision: 5 }),
  }));
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
  await store.getState().selectQqGroupConfig(BINDING_ID);
  const patch = store.getState().patchQqGroupOverride;

  patch("rhythm", "hourly_speech_limit", "200"); // 基线 200
  patch("rhythm", "active_hours_start_minutes", "0"); // 基线 0
  patch("rhythm", "active_hours_enabled", false); // 基线 false
  patch("triggers", "direct_reply", true); // 基线 true
  patch("sticker_collections", "collection_ids", []); // 基线空集合
  patch("prompts", "scene", "场景提示词"); // 基线同文
  expect(editorOf()?.overrides).toEqual({
    triggers: { direct_reply: true },
    rhythm: {
      hourly_speech_limit: 200,
      active_hours_start_minutes: 0,
      active_hours_enabled: false,
    },
    sticker_collections: { collection_ids: [] },
    prompts: { scene: "场景提示词" },
  });
  // 保存按钮必须有脏；统一草稿行也要出现。
  expect(qqGroupConfigDirty(editorOf())).toBe(true);
  expect(
    qqDraftChanges(store.getState()).some((row) => row.id === `group-config:${BINDING_ID}`),
  ).toBe(true);

  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  expect(save).toHaveBeenCalledWith(BINDING_ID, {
    agent_id: AGENT_ID,
    expected_binding_revision: 4,
    expected_scheme_revision: 3,
    expected_revision: 0,
    overrides: {
      triggers: { direct_reply: true },
      rhythm: {
        hourly_speech_limit: 200,
        active_hours_start_minutes: 0,
        active_hours_enabled: false,
      },
      sticker_collections: { collection_ids: [] },
      prompts: { scene: "场景提示词" },
    },
    disabled_capabilities: [],
  });
  expect(UpdateQqGroupConfigRequestSchema.safeParse(save.mock.calls[0][1]).success).toBe(true);
  // 记录=草稿：固定仍在（不因"与基线同值"被悄悄摘掉），保存按钮干净。
  expect(editorOf()?.overrides).toEqual({
    triggers: { direct_reply: true },
    rhythm: {
      hourly_speech_limit: 200,
      active_hours_start_minutes: 0,
      active_hours_enabled: false,
    },
    sticker_collections: { collection_ids: [] },
    prompts: { scene: "场景提示词" },
  });
  expect(qqGroupConfigDirty(editorOf())).toBe(false);

  // 取消固定只有 undefined 一条路；相对记录这是一条删除钉住的改动。
  store.getState().patchQqGroupOverride("triggers", "direct_reply", undefined);
  expect(editorOf()?.overrides).toEqual({
    rhythm: {
      hourly_speech_limit: 200,
      active_hours_start_minutes: 0,
      active_hours_enabled: false,
    },
    sticker_collections: { collection_ids: [] },
    prompts: { scene: "场景提示词" },
  });
  expect(qqGroupConfigDirty(editorOf())).toBe(true);
});

it("数字字段按共享契约判合法：越界/非整数/空白不写 overrides，原文原样拦住保存，修正后恢复", async () => {
  const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
    ...qqConfig({ revision: 1, overrides: body.overrides }),
    binding: qqBinding({ revision: 5 }),
  }));
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
  await store.getState().selectQqGroupConfig(BINDING_ID);
  const patch = store.getState().patchQqGroupOverride;

  patch("rhythm", "hourly_speech_limit", "-1"); // 越界（min 1）
  patch("rhythm", "hourly_speech_limit", "3000"); // 越界（max 500），覆盖上一条原文
  patch("rhythm", "merge_window_seconds", "3.5"); // 必须整数
  patch("compression", "headroom_ratio", "60"); // 60% = 0.6 > 0.5
  patch("rhythm", "idle_quiet_minutes", "  "); // 空白原文原样保留，不 trim 成空串
  expect(editorOf()?.rawTexts).toEqual({
    "rhythm.hourly_speech_limit": "3000",
    "rhythm.merge_window_seconds": "3.5",
    "compression.headroom_ratio": "60",
    "rhythm.idle_quiet_minutes": "  ",
  });
  // 非法值不写 overrides：不会有半截钉住骗过保存。
  expect(editorOf()?.overrides).toEqual({});
  expect(await store.getState().saveQqGroupConfig()).toBe(false);
  expect(save).not.toHaveBeenCalled();
  expect(store.getState().error).toBe("请先修正方案中的无效数字，再保存。");

  // 合法原文（前后空格/前导零）按解析值写入，不占原文；非法字段修正后清除原文。
  patch("rhythm", "hourly_speech_limit", "250");
  patch("rhythm", "merge_window_seconds", " 45 ");
  patch("rhythm", "idle_quiet_minutes", "015");
  expect(editorOf()?.rawTexts).toEqual({ "compression.headroom_ratio": "60" });
  expect(editorOf()?.overrides).toEqual({
    rhythm: { hourly_speech_limit: 250, merge_window_seconds: 45, idle_quiet_minutes: 15 },
  });
  patch("compression", "headroom_ratio", "5"); // 5% = 0.05，与基线同值也固定
  expect(editorOf()?.rawTexts).toEqual({});
  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][1].overrides).toEqual({
    rhythm: { hourly_speech_limit: 250, merge_window_seconds: 45, idle_quiet_minutes: 15 },
    compression: { headroom_ratio: 0.05 },
  });
  expect(UpdateQqGroupConfigRequestSchema.safeParse(save.mock.calls[0][1]).success).toBe(true);
});

it("headroom 是整数百分比输入：小数原文原样拦住保存；修正为整数才写入比例", async () => {
  const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
    ...qqConfig({ revision: 1, overrides: body.overrides }),
    binding: qqBinding({ revision: 5 }),
  }));
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
  await store.getState().selectQqGroupConfig(BINDING_ID);
  const patch = store.getState().patchQqGroupOverride;

  // 界面只收整数百分比：5.5% 属非法输入，原文原样（含空格）进 rawTexts，不写半截比例。
  patch("compression", "headroom_ratio", " 5.5 ");
  expect(editorOf()?.rawTexts).toEqual({ "compression.headroom_ratio": " 5.5 " });
  expect(editorOf()?.overrides).toEqual({});
  expect(await store.getState().saveQqGroupConfig()).toBe(false);
  expect(save).not.toHaveBeenCalled();
  expect(store.getState().error).toBe("请先修正方案中的无效数字，再保存。");

  // 修正为整数百分比：原文清掉，按换算写入 0–0.5 比例（0.05 与基线同值也固定）。
  patch("compression", "headroom_ratio", "5");
  expect(editorOf()?.rawTexts).toEqual({});
  expect(editorOf()?.overrides).toEqual({ compression: { headroom_ratio: 0.05 } });
  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  expect(save.mock.calls[0][1].overrides).toEqual({ compression: { headroom_ratio: 0.05 } });
  expect(UpdateQqGroupConfigRequestSchema.safeParse(save.mock.calls[0][1]).success).toBe(true);
});

it("提示词空白按契约非法：原文原样保留、不静默改成默认；与基线同文照样固定", async () => {
  const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
    ...qqConfig({ revision: 1, overrides: body.overrides }),
    binding: qqBinding({ revision: 5 }),
  }));
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
  await store.getState().selectQqGroupConfig(BINDING_ID);

  store.getState().patchQqGroupOverride("prompts", "scene", "");
  expect(editorOf()?.rawTexts).toEqual({ "prompts.scene": "" });
  expect(editorOf()?.overrides).toEqual({});
  expect(await store.getState().saveQqGroupConfig()).toBe(false);
  expect(save).not.toHaveBeenCalled();

  store.getState().patchQqGroupOverride("prompts", "scene", "   ");
  expect(editorOf()?.rawTexts).toEqual({ "prompts.scene": "   " });
  store.getState().patchQqGroupOverride("prompts", "scene", "场景提示词"); // 与基线同文
  expect(editorOf()?.rawTexts).toEqual({});
  expect(editorOf()?.overrides).toEqual({ prompts: { scene: "场景提示词" } });
  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  expect(save.mock.calls[0][1].overrides).toEqual({ prompts: { scene: "场景提示词" } });
});

it("显式刷新合并：已自定义与非法原文保留，未改字段与三段 revision 跟随最新答案", async () => {
  const get = vi
    .fn()
    .mockResolvedValueOnce(qqConfig())
    .mockResolvedValueOnce(
      qqConfig({
        binding: qqBinding({ revision: 7 }),
        base_scheme: qqScheme({ revision: 6 }),
        overrides: overridesOf({ compression: { package_limit: 10 } }),
        revision: 1,
      }),
    );
  ready(fakeClient({ getQqGroupConfig: get }));
  store.getState().openQqGroupConfig(BINDING_ID);
  await flush();

  store.getState().patchQqGroupOverride("context", "reply_token_budget", "9000");
  store.getState().patchQqGroupOverride("rhythm", "hourly_speech_limit", "-");
  expect(store.getState().qqGroupConfigEditor?.rawTexts).toEqual({
    "rhythm.hourly_speech_limit": "-",
  });
  // 非法原文会把该字段从自定义里摘掉：修正前不写半截值。
  expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
    context: { reply_token_budget: 9000 },
  });

  expect(await store.getState().refreshQqGroupConfig()).toBe(true);
  const editor = store.getState().qqGroupConfigEditor;
  // 本地自定义保留；服务端新增的钉住字段跟随最新答案；非法原文原样保留。
  expect(editor?.overrides).toEqual({
    context: { reply_token_budget: 9000 },
    compression: { package_limit: 10 },
  });
  expect(editor?.rawTexts).toEqual({ "rhythm.hourly_speech_limit": "-" });
  expect(editor?.source.revision).toBe(1);
  expect(editor?.source.base_scheme.revision).toBe(6);
  expect(editor?.source.binding.revision).toBe(7);
  expect(store.getState().feedback).toBe("刷新不提交草稿；冲突后请核对最新值再保存。");
});

it("刷新三路合并：本地改过（含删除钉住）的保留，没动过的跟随新答案，不复活对方取消的钉住", async () => {
  const fresh = qqConfig({
    binding: qqBinding({ revision: 7 }),
    base_scheme: qqScheme({ revision: 6 }),
    overrides: overridesOf({
      rhythm: { merge_window_seconds: 50 },
      stickers: { sticker_min_repeat_minutes: 7 },
    }),
    revision: 2,
  });
  const get = vi
    .fn()
    .mockResolvedValueOnce(
      qqConfig({
        overrides: overridesOf({
          rhythm: { merge_window_seconds: 45 },
          context: { reply_token_budget: 9000 },
        }),
        revision: 1,
      }),
    )
    .mockResolvedValueOnce(fresh);
  ready(fakeClient({ getQqGroupConfig: get }));
  await store.getState().selectQqGroupConfig(BINDING_ID);

  // 本地：改掉 rhythm 的钉住值；把 context 的钉住删掉（跟随即删除）。
  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "46");
  store.getState().patchQqGroupOverride("context", "reply_token_budget", undefined);
  expect(await store.getState().refreshQqGroupConfig()).toBe(true);
  expect(editorOf()?.overrides).toEqual({
    rhythm: { merge_window_seconds: 46 },
    stickers: { sticker_min_repeat_minutes: 7 },
  });
  expect(editorOf()?.source).toBe(fresh);

  // 直接过合并函数：没动过的字段完全跟新答案——对方取消的钉住不复活、对方新增的跟随。
  const record = qqConfig({
    overrides: overridesOf({ rhythm: { merge_window_seconds: 45 } }),
    revision: 1,
  });
  const untouched = qqGroupConfigEditorFrom(record);
  const merged = mergeQqGroupConfigEditor(
    untouched,
    qqConfig({
      overrides: overridesOf({ stickers: { sticker_min_repeat_minutes: 7 } }),
      revision: 2,
    }),
  );
  expect(merged.overrides).toEqual({ stickers: { sticker_min_repeat_minutes: 7 } });
  expect(merged.source.binding.id).toBe(BINDING_ID);
});

it("刷新发现绑定身份已变：保旧草稿与旧基线并标记冲突，保存仍按旧 Agent 提交由服务端判冲突", async () => {
  const get = vi
    .fn()
    .mockResolvedValueOnce(qqConfig())
    .mockResolvedValueOnce(
      qqConfig({ binding: qqBinding({ agent_id: OTHER_AGENT_ID, revision: 6 }) }),
    );
  const save = vi.fn(async () => qqConfig({ revision: 1 }));
  ready(fakeClient({ getQqGroupConfig: get, saveQqGroupConfig: save }));
  await store.getState().selectQqGroupConfig(BINDING_ID);

  expect(await store.getState().refreshQqGroupConfig()).toBe(true);
  expect(editorOf()?.identityConflict).toBe(true);
  expect(editorOf()?.source.binding.agent_id).toBe(AGENT_ID);
  expect(editorOf()?.source.binding.revision).toBe(4);
  expect(store.getState().feedback).toBe("刷新不提交草稿；冲突后请核对最新值再保存。");

  // 冲突标记不拦编辑，也不换基线：保存仍用旧身份（服务端据此拒绝给新 Agent）。
  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");
  expect(editorOf()?.identityConflict).toBe(true);
  await store.getState().saveQqGroupConfig();
  expect(save).toHaveBeenCalledWith(
    BINDING_ID,
    expect.objectContaining({ agent_id: AGENT_ID, expected_binding_revision: 4 }),
  );

  // 账号/会话对端/类型任一变化同样只标记、不合并。
  const pure = qqGroupConfigEditorFrom(qqConfig());
  for (const binding of [
    qqBinding({ kind: "private" }),
    qqBinding({ account_id: "999" }),
    qqBinding({ peer_id: "987654321" }),
  ]) {
    const merged = mergeQqGroupConfigEditor(pure, qqConfig({ binding }));
    expect(merged.identityConflict).toBe(true);
    expect(merged.source).toBe(pure.source);
    expect(merged.overrides).toBe(pure.overrides);
  }
});

it("待切换基础方案时预览按目标方案合并；source 基线不被推进（三段 CAS 不变）", async () => {
  const base = qqScheme();
  const target = qqScheme({
    id: TARGET_SCHEME_ID,
    name: "新方案",
    revision: 7,
    rhythm: { ...base.rhythm, merge_window_seconds: 70 },
  });
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig() }));
  store.setState({ qqSchemes: [base, target] });
  await store.getState().selectQqGroupConfig(BINDING_ID);

  store.getState().patchQqGroupOverride("context", "reply_token_budget", "9000");
  store.getState().patchQqGroupConfigScheme(TARGET_SCHEME_ID, "keep");
  const editor = editorOf();
  // 不传目标：仍按打开时的旧基线合成（保存前页面不该悄悄对齐到目标）。
  expect(qqGroupConfigEffectiveScheme(editor)?.rhythm.merge_window_seconds).toBe(30);
  // 传目标：预览反映目标方案，本群钉住照常生效。
  const effective = qqGroupConfigEffectiveScheme(editor, target);
  expect(effective?.rhythm.merge_window_seconds).toBe(70);
  expect(effective?.context.reply_token_budget).toBe(9000);
  expect(editorOf()?.source.base_scheme.id).toBe(BASE_SCHEME_ID);
  expect(editorOf()?.schemeId).toBe(TARGET_SCHEME_ID);
});

it("没有改动不发 PUT：直接返回成功；先钉住再取消回到记录同样不算改动", async () => {
  const save = vi.fn();
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
  await store.getState().selectQqGroupConfig(BINDING_ID);

  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  expect(save).not.toHaveBeenCalled();
  expect(store.getState().qqGroupConfigSaving).toBe(false);

  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");
  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", undefined);
  expect(qqGroupConfigDirty(editorOf())).toBe(false);
  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

it("同群重开不隐式重读脏基线；换群即使同 route 也走统一守卫，保存/放弃后按目标落地", async () => {
  const other = qqBinding({ id: OTHER_BINDING_ID, peer_id: "987654321" });
  const get = vi.fn(async (bindingId: string) =>
    bindingId === OTHER_BINDING_ID
      ? qqConfig({ binding: other, overrides: overridesOf({ reply: { split_by_speaker: false } }) })
      : qqConfig(),
  );
  const save = vi.fn(async () => qqConfig({ revision: 1 }));
  ready(fakeClient({ getQqGroupConfig: get, saveQqGroupConfig: save }), [qqBinding(), other]);

  store.getState().openQqGroupConfig(BINDING_ID);
  await flush();
  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");
  const draftSource = store.getState().qqGroupConfigEditor?.source;

  // 同群重开：不重读、不改脏基线（重读只能由显式刷新合并）。
  store.getState().openQqGroupConfig(BINDING_ID);
  await flush();
  expect(get).toHaveBeenCalledTimes(1);
  expect(store.getState().qqGroupConfigEditor?.source).toBe(draftSource);

  // 同 route 换群：草稿未决，先确认；取消不换编辑器。
  store.getState().openQqGroupConfig(OTHER_BINDING_ID);
  expect(store.getState()).toMatchObject({
    settingsRoute: "qq-group-config",
    navigationConfirmOpen: true,
    pendingNavigation: { kind: "group-config", bindingId: OTHER_BINDING_ID },
  });
  expect(store.getState().qqGroupConfigEditor?.source.binding.id).toBe(BINDING_ID);
  store.getState().cancelPendingNavigation();
  expect(store.getState().qqGroupConfigEditor?.source.binding.id).toBe(BINDING_ID);

  // 确认保存：本群先保存，再落地目标群的编辑器。
  store.getState().openQqGroupConfig(OTHER_BINDING_ID);
  await store.getState().confirmSaveAndContinue();
  expect(save).toHaveBeenCalledOnce();
  expect(get).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenLastCalledWith(OTHER_BINDING_ID);
  expect(store.getState()).toMatchObject({
    navigationConfirmOpen: false,
    pendingNavigation: null,
    qqGroupConfigBindingId: OTHER_BINDING_ID,
  });
  expect(store.getState().qqGroupConfigEditor?.source.binding.id).toBe(OTHER_BINDING_ID);
});

it("跨群打开失败：保留稳定绑定 id 供原位重试，不吃上一群的编辑器；refresh 后成功加载", async () => {
  const other = qqBinding({ id: OTHER_BINDING_ID, peer_id: "987654321" });
  const get = vi
    .fn()
    .mockResolvedValueOnce(qqConfig())
    .mockRejectedValueOnce(new Error("本群配置读取失败"))
    .mockResolvedValueOnce(qqConfig({ binding: other }));
  ready(fakeClient({ getQqGroupConfig: get }), [qqBinding(), other]);

  store.getState().openQqGroupConfig(BINDING_ID);
  await flush();
  store.getState().openQqGroupConfig(OTHER_BINDING_ID);
  await flush();
  expect(store.getState()).toMatchObject({
    qqGroupConfigBindingId: OTHER_BINDING_ID,
    qqGroupConfigEditor: null,
    error: "本群配置读取失败",
  });

  expect(await store.getState().refreshQqGroupConfig()).toBe(true);
  expect(get).toHaveBeenLastCalledWith(OTHER_BINDING_ID);
  expect(store.getState().qqGroupConfigEditor?.source.binding.id).toBe(OTHER_BINDING_ID);
  expect(store.getState().error).toBeNull();
});

it("reset 后晚到的旧读取不落地（模块令牌 + 读取代次一起判定）", async () => {
  const pending = deferred<QqGroupConfigResponse>();
  const client = fakeClient({ getQqGroupConfig: vi.fn(() => pending.promise) });
  ready(client);
  const selection = store.getState().selectQqGroupConfig(BINDING_ID);
  await store.getState().resetForTests(client);
  store.setState({ qqBindingsLoaded: true, qqBindings: [qqBinding()] });
  pending.resolve(qqConfig());
  expect(await selection).toBe(false);
  expect(store.getState().qqGroupConfigEditor).toBeNull();
});

it("409 与非法输入都保住整份草稿；非法输入还会拦住统一保存的每一步", async () => {
  const conflict = vi.fn().mockRejectedValue(new Error("本群配置已在别处修改，请刷新后重试。"));
  const schemeSave = vi.fn();
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: conflict }));
  await store.getState().selectQqGroupConfig(BINDING_ID);
  store.getState().patchQqGroupOverride("context", "reply_token_budget", "9000");
  store.setState({
    apiClient: { ...store.getState().apiClient, updateQqScheme: schemeSave },
  });

  expect(await store.getState().saveQqGroupConfig()).toBe(false);
  expect(conflict).toHaveBeenCalledOnce();
  expect(store.getState().error).toBe("本群配置已在别处修改，请刷新后重试。");
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(true);
  expect(hasUnsavedDrafts(store.getState())).toBe(true);

  // 非法原文：本群保存与统一保存都先要求修正，且不先写别的草稿。
  store.getState().patchQqGroupOverride("rhythm", "hourly_speech_limit", "-");
  expect(await store.getState().saveQqGroupConfig()).toBe(false);
  expect(conflict).toHaveBeenCalledOnce();
  expect(store.getState().error).toBe("请先修正方案中的无效数字，再保存。");
  store.setState({
    qqSchemeEditor: null,
    qqInputs: { ...store.getState().qqInputs, schemeTexts: {} },
  });
  expect(await store.getState().saveQqDrafts()).toBe(false);
  expect(schemeSave).not.toHaveBeenCalled();
  expect(conflict).toHaveBeenCalledOnce();
});

it("即时启停的保存结果可推进本编辑的绑定基线（保草稿）；改绑 Agent 的结果一律不采用", async () => {
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig() }));
  await store.getState().selectQqGroupConfig(BINDING_ID);
  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");

  store.getState().syncQqGroupConfigBinding(qqBinding({ revision: 5, paused: true }));
  const editor = store.getState().qqGroupConfigEditor;
  expect(editor?.source.binding.revision).toBe(5);
  expect(editor?.source.binding.paused).toBe(true);
  expect(editor?.overrides).toEqual({ rhythm: { merge_window_seconds: 45 } });
  expect(qqGroupConfigDirty(editor)).toBe(true);

  // 改绑到别的 Agent：不采用（否则旧编辑会保存给新 Agent）；下一次保存按 CAS 如实冲突。
  store.getState().syncQqGroupConfigBinding(qqBinding({ revision: 6, agent_id: OTHER_AGENT_ID }));
  expect(store.getState().qqGroupConfigEditor?.source.binding.revision).toBe(5);
  expect(store.getState().qqGroupConfigEditor?.source.binding.agent_id).toBe(AGENT_ID);

  // 落后或收回的 revision 也不采用。
  store.getState().syncQqGroupConfigBinding(qqBinding({ revision: 4, paused: true }));
  expect(store.getState().qqGroupConfigEditor?.source.binding.revision).toBe(5);
});

it("sync 只推进「除 paused 外逐字段等价」的写结果：触发条件变化或保存进行中都不动基线", async () => {
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig() }));
  await store.getState().selectQqGroupConfig(BINDING_ID);
  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");

  // 同 Agent、同方案、revision 前进，但触发条件被另一处改过：不推进，留给 CAS 如实冲突。
  store.getState().syncQqGroupConfigBinding(
    qqBinding({
      revision: 5,
      triggers: { direct_reply: false, follow_up: null, chiming_in: null, idle_topic: null },
    }),
  );
  expect(editorOf()?.source.binding.revision).toBe(4);

  // 保存进行中：在途请求用的基线不得被任何同步推进。
  store.setState({ qqGroupConfigSaving: true });
  store.getState().syncQqGroupConfigBinding(qqBinding({ revision: 5, paused: true }));
  expect(editorOf()?.source.binding.revision).toBe(4);
  expect(editorOf()?.source.binding.paused).toBe(false);
  store.setState({ qqGroupConfigSaving: false });

  // 仅 paused 前进的已知写结果：推进，草稿字段不动。
  store.getState().syncQqGroupConfigBinding(qqBinding({ revision: 5, paused: true }));
  expect(editorOf()?.source.binding.revision).toBe(5);
  expect(editorOf()?.source.binding.paused).toBe(true);
  expect(editorOf()?.overrides).toEqual({ rhythm: { merge_window_seconds: 45 } });
});

it("统一草稿：行预览列出 group/field 的 base→本群值与能力停用；保存与放弃都覆盖本次改动", async () => {
  const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
    ...qqConfig({
      revision: 1,
      overrides: body.overrides,
      disabled_capabilities: body.disabled_capabilities,
    }),
    binding: qqBinding({ revision: 5 }),
  }));
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
  await store.getState().selectQqGroupConfig(BINDING_ID);
  store.getState().patchQqGroupOverride("context", "reply_token_budget", "9000");
  store.getState().setQqGroupCapability("tasks", true);

  const row = qqDraftChanges(store.getState()).find((item) => item.id.startsWith("group-config:"));
  expect(row).toMatchObject({
    id: `group-config:${BINDING_ID}`,
    resource: "群 · 123456789",
  });
  expect(row?.changes).toEqual([
    "「回复：预算（估算字节）」：6000 → 9000",
    "停用「任务与执行限制」",
  ]);
  expect(hasUnsavedDrafts(store.getState())).toBe(true);

  expect(await store.getState().saveQqDrafts()).toBe(true);
  expect(save).toHaveBeenCalledOnce();
  expect(qqDraftChanges(store.getState())).toEqual([]);
  expect(hasUnsavedDrafts(store.getState())).toBe(false);

  store.getState().patchQqGroupOverride("output_reserve", "reply_output_reserved", "4096");
  store.getState().discardQqDrafts();
  // 放弃回到"已存记录"而不是回到空：上一次保存的钉住仍在，本次未保存的改动被撤销。
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(false);
  expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
    context: { reply_token_budget: 9000 },
  });
  expect(hasUnsavedDrafts(store.getState())).toBe(false);
});

it("换基础方案 keep：带目标方案 revision、方案 id 与处置；保存后编辑器采用新基线", async () => {
  const target = qqScheme({ id: TARGET_SCHEME_ID, name: "新方案", revision: 7 });
  const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
    ...qqConfig({ revision: 1, overrides: body.overrides }),
    base_scheme: target,
    binding: qqBinding({ revision: 5, scheme_id: TARGET_SCHEME_ID }),
  }));
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
  store.setState({ qqSchemes: [qqScheme(), target] });
  await store.getState().selectQqGroupConfig(BINDING_ID);
  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");

  store.getState().patchQqGroupConfigScheme(TARGET_SCHEME_ID, "keep");
  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  expect(save).toHaveBeenLastCalledWith(BINDING_ID, {
    agent_id: AGENT_ID,
    expected_binding_revision: 4,
    expected_scheme_revision: 7,
    expected_revision: 0,
    overrides: { rhythm: { merge_window_seconds: 45 } },
    disabled_capabilities: [],
    scheme_id: TARGET_SCHEME_ID,
    scheme_change: "keep",
  });
  expect(UpdateQqGroupConfigRequestSchema.safeParse(save.mock.calls[0][1]).success).toBe(true);
  // 保存成功：编辑器基线换成响应里的新方案，本地自定义原样保留。
  expect(store.getState().qqGroupConfigEditor?.source.base_scheme.id).toBe(TARGET_SCHEME_ID);
  expect(store.getState().qqGroupConfigEditor?.source.binding.scheme_id).toBe(TARGET_SCHEME_ID);
  expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
    rhythm: { merge_window_seconds: 45 },
  });
});

it("换基础方案 reset：清空本群自定义、能力停用不重置；取消待办后保存不写 scheme_id", async () => {
  const target = qqScheme({ id: TARGET_SCHEME_ID, name: "新方案", revision: 7 });
  const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
    ...qqConfig({
      revision: 1,
      overrides: body.overrides,
      disabled_capabilities: body.disabled_capabilities,
    }),
    base_scheme: target,
    binding: qqBinding({ revision: 5, scheme_id: TARGET_SCHEME_ID }),
  }));
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
  store.setState({ qqSchemes: [qqScheme(), target] });
  await store.getState().selectQqGroupConfig(BINDING_ID);
  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");
  store.getState().setQqGroupCapability("tasks", true);

  // reset：本群自定义全部跟随新方案（原文一起清），能力停用不随换方案重置。
  store.getState().patchQqGroupConfigScheme(TARGET_SCHEME_ID, "reset");
  expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({});
  expect(store.getState().qqGroupConfigEditor?.disabledCapabilities).toEqual(["tasks"]);
  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  expect(save).toHaveBeenLastCalledWith(BINDING_ID, {
    agent_id: AGENT_ID,
    expected_binding_revision: 4,
    expected_scheme_revision: 7,
    expected_revision: 0,
    overrides: {},
    disabled_capabilities: ["tasks"],
    scheme_id: TARGET_SCHEME_ID,
    scheme_change: "reset",
  });
  expect(UpdateQqGroupConfigRequestSchema.safeParse(save.mock.calls[0][1]).success).toBe(true);

  // 取消待办：清掉方案切换，其余草稿照常保存，请求里不再出现 scheme_id。
  store.getState().patchQqGroupConfigScheme(undefined);
  store.getState().patchQqGroupOverride("context", "reply_token_budget", "8000");
  expect(store.getState().qqGroupConfigEditor?.schemeId).toBeUndefined();
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(true);
  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  expect(save).toHaveBeenLastCalledWith(BINDING_ID, {
    agent_id: AGENT_ID,
    expected_binding_revision: 5,
    expected_scheme_revision: 7,
    expected_revision: 1,
    overrides: { context: { reply_token_budget: 8000 } },
    disabled_capabilities: ["tasks"],
  });
  expect(UpdateQqGroupConfigRequestSchema.safeParse(save.mock.calls[1][1]).success).toBe(true);
});

it("reset 预览只是待办：取消/改选 keep 还原此前的自定义与非法原文；同基线恢复全部跟随仍直接清空", async () => {
  const target = qqScheme({ id: TARGET_SCHEME_ID, name: "新方案", revision: 7 });
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig() }));
  store.setState({ qqSchemes: [qqScheme(), target] });
  await store.getState().selectQqGroupConfig(BINDING_ID);
  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");
  store.getState().patchQqGroupOverride("rhythm", "hourly_speech_limit", "-");

  store.getState().patchQqGroupConfigScheme(TARGET_SCHEME_ID, "reset");
  // 预览：body 与非法原文一起清空，但内容留在编辑器的留底里。
  expect(editorOf()?.overrides).toEqual({});
  expect(editorOf()?.rawTexts).toEqual({});
  expect(editorOf()?.schemeChange).toBe("reset");

  // 取消待办：草稿原样回来，方案切换不留痕迹。
  store.getState().patchQqGroupConfigScheme(undefined);
  expect(editorOf()?.schemeId).toBeUndefined();
  expect(editorOf()?.schemeChange).toBeUndefined();
  expect(editorOf()?.overrides).toEqual({ rhythm: { merge_window_seconds: 45 } });
  expect(editorOf()?.rawTexts).toEqual({ "rhythm.hourly_speech_limit": "-" });

  // 再预览一次 reset 后改选 keep：同样还原，只保留「换目标」待办。
  store.getState().patchQqGroupConfigScheme(TARGET_SCHEME_ID, "reset");
  expect(editorOf()?.overrides).toEqual({});
  store.getState().patchQqGroupConfigScheme(TARGET_SCHEME_ID, "keep");
  expect(editorOf()?.schemeId).toBe(TARGET_SCHEME_ID);
  expect(editorOf()?.schemeChange).toBe("keep");
  expect(editorOf()?.overrides).toEqual({ rhythm: { merge_window_seconds: 45 } });
  expect(editorOf()?.rawTexts).toEqual({ "rhythm.hourly_speech_limit": "-" });

  // 「恢复全部跟随」（同基线 reset）是明确清空：不留还原，之后的取消也回不来。
  store.getState().patchQqGroupConfigScheme(undefined, "reset");
  expect(editorOf()?.overrides).toEqual({});
  expect(editorOf()?.rawTexts).toEqual({});
  store.getState().patchQqGroupConfigScheme(undefined);
  expect(editorOf()?.overrides).toEqual({});
  expect(editorOf()?.rawTexts).toEqual({});
  expect(qqGroupConfigDirty(editorOf())).toBe(false);
});

it("reset 预览后的首次字段改写改按 keep 保存：新字段写入、清掉的旧 body 不复活", async () => {
  const target = qqScheme({ id: TARGET_SCHEME_ID, name: "新方案", revision: 7 });
  const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
    ...qqConfig({
      revision: 1,
      overrides: body.overrides,
      disabled_capabilities: body.disabled_capabilities,
    }),
    base_scheme: target,
    binding: qqBinding({ revision: 5, scheme_id: TARGET_SCHEME_ID }),
  }));
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
  store.setState({ qqSchemes: [qqScheme(), target] });
  await store.getState().selectQqGroupConfig(BINDING_ID);
  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");
  store.getState().patchQqGroupConfigScheme(TARGET_SCHEME_ID, "reset");

  store.getState().patchQqGroupOverride("context", "reply_token_budget", "8000");
  expect(editorOf()?.schemeChange).toBe("keep");
  expect(editorOf()?.overrides).toEqual({ context: { reply_token_budget: 8000 } });

  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  expect(save).toHaveBeenCalledWith(BINDING_ID, {
    agent_id: AGENT_ID,
    expected_binding_revision: 4,
    expected_scheme_revision: 7,
    expected_revision: 0,
    overrides: { context: { reply_token_budget: 8000 } },
    disabled_capabilities: [],
    scheme_id: TARGET_SCHEME_ID,
    scheme_change: "keep",
  });
  expect(UpdateQqGroupConfigRequestSchema.safeParse(save.mock.calls[0][1]).success).toBe(true);
});

it("与基线同值的钉住/取消在全局预览里用「跟随↔自定义」文案；换方案行也用人话", async () => {
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig() }));
  await store.getState().selectQqGroupConfig(BINDING_ID);
  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "30"); // 基线 30
  let row = qqDraftChanges(store.getState()).find((item) => item.id.startsWith("group-config:"));
  expect(row?.changes).toEqual(["「合并窗口（秒）」：跟随方案 → 本群已自定义"]);

  store.setState({
    qqSchemes: [qqScheme({ id: TARGET_SCHEME_ID, name: "新方案", revision: 7 })],
  });
  store.getState().patchQqGroupConfigScheme(TARGET_SCHEME_ID, "keep");
  row = qqDraftChanges(store.getState()).find((item) => item.id.startsWith("group-config:"));
  expect(row?.changes).toEqual([
    "「合并窗口（秒）」：跟随方案 → 本群已自定义",
    "基础方案改为「新方案」：保留本群自定义",
  ]);

  // 反向：已存记录里钉着与基线同值，取消钉住 → 自定义回到跟随。
  ready(
    fakeClient({
      getQqGroupConfig: async () =>
        qqConfig({ overrides: overridesOf({ rhythm: { merge_window_seconds: 30 } }) }),
    }),
  );
  await store.getState().selectQqGroupConfig(BINDING_ID);
  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", undefined);
  row = qqDraftChanges(store.getState()).find((item) => item.id.startsWith("group-config:"));
  expect(row?.changes).toEqual(["「合并窗口（秒）」：本群已自定义 → 跟随方案"]);
});

it("守卫与忙碌边界：保存中拒绝打开/导航；目录已载入而绑定不存在时显式报错不动路由", () => {
  ready(fakeClient({ getQqGroupConfig: vi.fn(async () => qqConfig()) }));
  store.setState({ qqGroupConfigSaving: true });
  store.getState().openQqGroupConfig(OTHER_BINDING_ID);
  store.getState().openChat();
  expect(store.getState()).toMatchObject({
    qqGroupConfigBindingId: null,
    settingsRoute: "scheme-bindings",
    pendingNavigation: null,
    page: "settings",
  });
  expect(store.getState().apiClient.getQqGroupConfig).not.toHaveBeenCalled();

  store.setState({ qqGroupConfigSaving: false });
  store.getState().openQqGroupConfig("99999999-9999-4999-8999-999999999999");
  expect(store.getState()).toMatchObject({
    settingsRoute: "scheme-bindings",
    pendingNavigation: null,
    error: "操作失败，请重试。",
  });
});

it("直接 select 同 id 换 Agent：脏草稿保留并标记冲突（不隐式重读），干净才按目录身份重读", async () => {
  const read = vi.fn(async (id: string) =>
    qqConfig({ binding: qqBinding({ id, agent_id: OTHER_AGENT_ID }) }),
  );
  ready(fakeClient({ getQqGroupConfig: read }), [qqBinding({ agent_id: OTHER_AGENT_ID })]);
  store.setState({
    qqGroupConfigBindingId: BINDING_ID,
    qqGroupConfigEditor: qqGroupConfigEditorFrom(
      qqConfig({ binding: qqBinding({ agent_id: AGENT_ID }) }),
    ),
  });
  store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");

  expect(await store.getState().selectQqGroupConfig(BINDING_ID)).toBe(false);
  expect(read).not.toHaveBeenCalled();
  expect(editorOf()?.identityConflict).toBe(true);
  expect(editorOf()?.source.binding.agent_id).toBe(AGENT_ID);
  expect(editorOf()?.overrides).toEqual({ rhythm: { merge_window_seconds: 45 } });

  // 干净编辑器：同一 id 的显式打开按目录身份重读。
  store.setState({
    qqGroupConfigEditor: qqGroupConfigEditorFrom(
      qqConfig({ binding: qqBinding({ agent_id: AGENT_ID }) }),
    ),
  });
  expect(await store.getState().selectQqGroupConfig(BINDING_ID)).toBe(true);
  expect(read).toHaveBeenCalledTimes(1);
  expect(editorOf()?.source.binding.agent_id).toBe(OTHER_AGENT_ID);
});

it("能力停用是集合差集：停用再启用回到基线即无草稿；恢复基线中被停用项产生 enable 行", async () => {
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig({ disabled_capabilities: ["mcp"] }) }));
  await store.getState().selectQqGroupConfig(BINDING_ID);

  store.getState().setQqGroupCapability("tasks", true);
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(true);
  store.getState().setQqGroupCapability("tasks", false);
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(false);

  store.getState().setQqGroupCapability("mcp", false);
  const row = qqDraftChanges(store.getState()).find((item) => item.id.startsWith("group-config:"));
  expect(row?.changes).toEqual(["启用「MCP」"]);
  store.getState().setQqGroupCapability("mcp", true);
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(false);
});

it("素材集合整体提交（契约严格形状）；选回基线集合仍是固定，只有 undefined 取消钉住", async () => {
  const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
    ...qqConfig({ revision: 1, overrides: body.overrides }),
    binding: qqBinding({ revision: 5 }),
  }));
  ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
  await store.getState().selectQqGroupConfig(BINDING_ID);

  store.getState().patchQqGroupOverride("sticker_collections", "collection_ids", [COLLECTION_ID]);
  expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
    sticker_collections: { collection_ids: [COLLECTION_ID] },
  });
  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  const sent = save.mock.calls[0][1];
  expect(sent.overrides).toEqual({
    sticker_collections: { collection_ids: [COLLECTION_ID] },
  });
  expect(UpdateQqGroupConfigRequestSchema.safeParse(sent).success).toBe(true);

  // 显式选回基线集合（空集）＝仍是固定，不是取消；相对已存记录是一条待写改动。
  store.getState().patchQqGroupOverride("sticker_collections", "collection_ids", []);
  expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
    sticker_collections: { collection_ids: [] },
  });
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(true);

  // 取消钉住只有 undefined 一条路；放弃草稿回到已存记录。
  store.getState().patchQqGroupOverride("sticker_collections", "collection_ids", undefined);
  expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({});
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(true);
  store.getState().discardQqGroupConfigChanges();
  expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
    sticker_collections: { collection_ids: [COLLECTION_ID] },
  });
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(false);
});

// ---- 0052：两组设置进本群草稿 ------------------------------------------------------------

describe("0052 两组进本群稀疏覆盖（T12）", () => {
  it("stages 逐字段钉住：钉 evaluation:false 不丢 decision/generation 的跟随；阶段整组可同钉", async () => {
    const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
      ...qqConfig({ revision: 1, overrides: body.overrides }),
      binding: qqBinding({ revision: 5 }),
    }));
    ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
    await store.getState().selectQqGroupConfig(BINDING_ID);
    const patch = store.getState().patchQqGroupOverride;

    // stages 逐字段：只钉 evaluation=false。
    patch("media_input", "stages.evaluation", false);
    expect(editorOf()?.overrides).toEqual({
      media_input: { stages: { evaluation: false } },
    });
    expect(await store.getState().saveQqGroupConfig()).toBe(true);
    const sent = save.mock.calls[0][1];
    expect(sent.overrides).toEqual({ media_input: { stages: { evaluation: false } } });
    expect(UpdateQqGroupConfigRequestSchema.safeParse(sent).success).toBe(true);

    // 阶段可以独立再钉、独立恢复；undefined 只摘掉这一个阶段的钉住。
    patch("media_input", "stages.decision", false);
    expect(editorOf()?.overrides).toEqual({
      media_input: { stages: { evaluation: false, decision: false } },
    });
    patch("media_input", "stages.decision", undefined);
    expect(editorOf()?.overrides).toEqual({
      media_input: { stages: { evaluation: false } },
    });
    // 整组清空（恢复全部跟随）后 media_input 组消失。
    patch("media_input", "stages.evaluation", undefined);
    expect(editorOf()?.overrides).toEqual({});
    // 取消钉住相对记录（保存后记录里有 evaluation:false 的钉住）是改动：
    // 比较基准是记录不是基线，与既有「先钉住再取消回到记录同样不算改动」语义一致。
    expect(qqGroupConfigChanges(editorOf())).toEqual([
      {
        kind: "override",
        group: "media_input",
        field: "stages.evaluation",
        before: "false",
        after: "true",
      },
    ]);
    expect(qqGroupConfigDirty(editorOf())).toBe(true);
  });

  it("media_input 的标量字段：0/false/null 都是真实钉住值，undefined 才回跟随", async () => {
    const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
      ...qqConfig({ revision: 1, overrides: body.overrides }),
      binding: qqBinding({ revision: 5 }),
    }));
    ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
    await store.getState().selectQqGroupConfig(BINDING_ID);
    const patch = store.getState().patchQqGroupOverride;

    patch("media_input", "mode", "description");
    patch("media_input", "max_images", "4");
    patch("media_input", "ordinary_still_max_dimension", ""); // 空原文 → 回跟随？否：非法原文拦保存
    expect(editorOf()?.rawTexts["media_input.ordinary_still_max_dimension"]).toBe("");
    expect(editorOf()?.overrides).toEqual({ media_input: { mode: "description", max_images: 4 } });
    expect(await store.getState().saveQqGroupConfig()).toBe(false);
    expect(save).not.toHaveBeenCalled();

    // 合法数字：钉住；与基线同值也固定。
    patch("media_input", "max_images", "8");
    expect(editorOf()?.overrides.media_input?.max_images).toBe(8);
    // null（原图）是真实设置值：可钉住、可保存，不是「跟随」。
    patch("media_input", "ordinary_still_max_dimension", null);
    expect(editorOf()?.overrides).toEqual({
      media_input: { mode: "description", max_images: 8, ordinary_still_max_dimension: null },
    });
    expect(qqGroupConfigDirty(editorOf())).toBe(true);
    expect(await store.getState().saveQqGroupConfig()).toBe(true);
    const sent = save.mock.calls[0][1];
    expect(sent.overrides).toEqual({
      media_input: { mode: "description", max_images: 8, ordinary_still_max_dimension: null },
    });
    expect(UpdateQqGroupConfigRequestSchema.safeParse(sent).success).toBe(true);
    // 非法原文清掉后保存成功。
    expect(editorOf()?.rawTexts).toEqual({});
  });

  it("message_settings 逐字段钉住；时区非法进 rawTexts 拦保存；非法原文刷新保留", async () => {
    const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
      ...qqConfig({ revision: 1, overrides: body.overrides }),
      binding: qqBinding({ revision: 5 }),
    }));
    ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
    await store.getState().selectQqGroupConfig(BINDING_ID);
    const patch = store.getState().patchQqGroupOverride;

    patch("message_settings", "reply_mode", "configured_depth");
    patch("message_settings", "reply_depth", "6");
    patch("message_settings", "timezone", "Not/AZone");
    expect(editorOf()?.rawTexts).toEqual({ "message_settings.timezone": "Not/AZone" });
    expect(editorOf()?.overrides).toEqual({
      message_settings: { reply_mode: "configured_depth", reply_depth: 6 },
    });
    expect(await store.getState().saveQqGroupConfig()).toBe(false);
    expect(save).not.toHaveBeenCalled();

    // 修正为真实 IANA 名称：原文清掉，钉住与基线同值也固定。
    patch("message_settings", "timezone", "Asia/Shanghai");
    expect(editorOf()?.rawTexts).toEqual({});
    expect(editorOf()?.overrides).toEqual({
      message_settings: {
        reply_mode: "configured_depth",
        reply_depth: 6,
        timezone: "Asia/Shanghai",
      },
    });
    expect(await store.getState().saveQqGroupConfig()).toBe(true);
    expect(UpdateQqGroupConfigRequestSchema.safeParse(save.mock.calls[0][1]).success).toBe(true);

    // 与基线同值的 reply_mode 也算钉住（显式自定义），undefined 取消。
    patch("message_settings", "reply_mode", undefined);
    expect(editorOf()?.overrides).toEqual({
      message_settings: { reply_depth: 6, timezone: "Asia/Shanghai" },
    });
    expect(qqGroupConfigDirty(editorOf())).toBe(true);
  });

  it("刷新三路合并覆盖两组：本地改过（含取消 stages 单字段）保留，未改字段跟随新答案", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(
        qqConfig({
          overrides: overridesOf({
            media_input: { stages: { evaluation: false }, max_images: 4 },
          }),
          revision: 1,
        }),
      )
      .mockResolvedValueOnce(
        qqConfig({
          binding: qqBinding({ revision: 7 }),
          base_scheme: qqScheme({ revision: 6 }),
          overrides: overridesOf({
            media_input: { max_images: 2 },
            message_settings: { reply_depth: 4 },
          }),
          revision: 2,
        }),
      );
    ready(fakeClient({ getQqGroupConfig: get }));
    await store.getState().selectQqGroupConfig(BINDING_ID);

    // 本地：改掉已钉住的 max_images；取消 evaluation 的钉住（跟随）。
    store.getState().patchQqGroupOverride("media_input", "max_images", "5");
    store.getState().patchQqGroupOverride("media_input", "stages.evaluation", undefined);
    expect(await store.getState().refreshQqGroupConfig()).toBe(true);
    // 本地改过的 max_images 保留 5；未动过的 message_settings.reply_depth 跟随新答案；
    // evaluation 的钉住已取消 → 不复活。
    expect(editorOf()?.overrides).toEqual({
      media_input: { max_images: 5 },
      message_settings: { reply_depth: 4 },
    });
    expect(editorOf()?.source.revision).toBe(2);
  });

  it("统一草稿预览覆盖两组字段的 base→本群值；保存与放弃都覆盖本次改动", async () => {
    const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
      ...qqConfig({ revision: 1, overrides: body.overrides }),
      binding: qqBinding({ revision: 5 }),
    }));
    ready(fakeClient({ getQqGroupConfig: async () => qqConfig(), saveQqGroupConfig: save }));
    await store.getState().selectQqGroupConfig(BINDING_ID);
    store.getState().patchQqGroupOverride("media_input", "max_images", "6");
    store.getState().patchQqGroupOverride("media_input", "stages.evaluation", false);
    store.getState().patchQqGroupOverride("message_settings", "timezone", "Asia/Tokyo");

    const row = qqDraftChanges(store.getState()).find((item) =>
      item.id.startsWith("group-config:"),
    );
    expect(row).toBeDefined();
    const changes = row?.changes ?? [];
    expect(changes.some((text) => text.includes("6") && text.includes("8"))).toBe(true);
    // 布尔阶段字段按布尔文案渲染（groupValueText 能解析嵌套 stages 的基线值）：开 → 关。
    expect(changes.some((text) => text.includes("开") && text.includes("关"))).toBe(true);
    expect(
      changes.some((text) => text.includes("Asia/Shanghai") && text.includes("Asia/Tokyo")),
    ).toBe(true);

    expect(await store.getState().saveQqDrafts()).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(qqDraftChanges(store.getState())).toEqual([]);

    // 放弃回到已存记录。
    store.getState().patchQqGroupOverride("message_settings", "reply_depth", "1");
    store.getState().discardQqDrafts();
    expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(false);
    expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
      media_input: { max_images: 6, stages: { evaluation: false } },
      message_settings: { timezone: "Asia/Tokyo" },
    });
  });

  // draft-state 的钉住判定/取值要能解析 `stages.<phase>` 点路径到 overrides 的嵌套
  // 位置（overrides.media_input.stages.<phase>），否则同值钉住的方向文案会反。
  // draft-state 的字段标签映射已含两组人话标签——stage 行标签从回退键
  // `media_input.stages.evaluation` 变为本地化文案「评估阶段」（页面控件用同一标签）。
  it("stage 点路径的同值钉住/取消在全局预览里同样用「跟随↔自定义」文案（不读错键）", async () => {
    ready(fakeClient({ getQqGroupConfig: async () => qqConfig() }));
    await store.getState().selectQqGroupConfig(BINDING_ID);
    // 与基线同值（基线 stages.evaluation=true）钉住：方向＝跟随方案 → 本群已自定义。
    store.getState().patchQqGroupOverride("media_input", "stages.evaluation", true);
    let row = qqDraftChanges(store.getState()).find((item) => item.id.startsWith("group-config:"));
    expect(row?.changes).toContain("「评估阶段」：跟随方案 → 本群已自定义");

    // 非同值钉住：布尔基线按「开/关」文案渲染（与标量字段同一 groupValueText 分支）。
    store.getState().patchQqGroupOverride("media_input", "stages.evaluation", false);
    row = qqDraftChanges(store.getState()).find((item) => item.id.startsWith("group-config:"));
    expect(row?.changes).toContain("「评估阶段」：开 → 关");

    // 反向：已存记录里钉着与基线同值，取消钉住 → 自定义回到跟随。
    ready(
      fakeClient({
        getQqGroupConfig: async () =>
          qqConfig({
            overrides: overridesOf({ media_input: { stages: { evaluation: true } } }),
          }),
      }),
    );
    await store.getState().selectQqGroupConfig(BINDING_ID);
    store.getState().patchQqGroupOverride("media_input", "stages.evaluation", undefined);
    row = qqDraftChanges(store.getState()).find((item) => item.id.startsWith("group-config:"));
    expect(row?.changes).toContain("「评估阶段」：本群已自定义 → 跟随方案");
  });
});
