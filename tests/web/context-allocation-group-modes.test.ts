import { beforeEach, expect, it, vi } from "vitest";
import type { QqBindingResponse, QqSchemeResponse } from "../../src/shared/contracts/qq";
import {
  mergeQqGroupScheme,
  type QqGroupConfigResponse,
  type QqGroupSchemeOverrides,
  type UpdateQqGroupConfigRequest,
} from "../../src/shared/contracts/qq-group-config";
import { api } from "../../src/web/api";
import {
  mergeQqGroupConfigEditor,
  qqGroupConfigDirty,
  qqGroupConfigEditorFrom,
  qqGroupConfigEffectiveScheme,
} from "../../src/web/features/qq/group-config-state";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-30T00:00:00.000Z";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const BASE_SCHEME_ID = "22222222-2222-4222-8222-222222222222";

/** 运行时差异是稀疏的（空组在契约归一化时被去掉）：夹具照运行时形态造，用一次显式收窄。 */
const overridesOf = (bag: Record<string, Record<string, unknown>>): QqGroupSchemeOverrides =>
  bag as unknown as QqGroupSchemeOverrides;

const qqScheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: BASE_SCHEME_ID,
  name: "默认方案",
  description: null,
  triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
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
  },
  reply: { split_by_speaker: true },
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  // 0059：两组响应必填；夹具代表既有已保存方案，防抖按旧列默认显式关（新建默认开）。
  task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
  input_anti_spam: { enabled: false, burst_min_messages: 3, burst_window_seconds: 3 },
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
  // 0059：本会话覆盖两组，全新会话全 null＝跟随方案。
  task_limits: { mention_task_limit: null, ordinary_task_limit: null },
  input_anti_spam: {
    enabled: null,
    burst_min_messages: null,
    burst_window_seconds: null,
  },
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

beforeEach(() => store.getState().resetForTests());
it("loads sparse per-tier modes, removes one inheritance pin, and saves only the group without changing the base", async () => {
  const base = qqScheme({ allocation: { judgement: { mode: "fixed" }, reply: { mode: "auto" } } });
  const overrides = { allocation: { judgement: { mode: "auto" as const } } };
  const response = qqConfig({
    base_scheme: base,
    effective_scheme: mergeQqGroupScheme(base, overrides),
    overrides,
  });
  const editor = qqGroupConfigEditorFrom(response);
  expect(editor.overrides).toEqual(overrides);
  expect(qqGroupConfigEffectiveScheme(editor)?.allocation).toEqual({
    judgement: { mode: "auto" },
    reply: { mode: "auto" },
  });
  expect(qqGroupConfigDirty(editor)).toBe(false);
  const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
    ...response,
    revision: 1,
    overrides: body.overrides,
    effective_scheme: mergeQqGroupScheme(base, body.overrides),
  }));
  store.getState().resetForTests({ ...api, saveQqGroupConfig: save });
  store.setState({
    qqGroupConfigEditor: editor,
    qqGroupConfigBindingId: BINDING_ID,
    qqBindings: [response.binding],
    qqSchemes: [base],
  });
  store.getState().patchQqGroupOverride("allocation", "reply.mode", "fixed");
  store.getState().patchQqGroupOverride("allocation", "judgement.mode", undefined);
  expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
    allocation: { reply: { mode: "fixed" } },
  });
  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][1].overrides).toEqual({ allocation: { reply: { mode: "fixed" } } });
  expect(store.getState().qqSchemes[0]).toEqual(base);
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(false);

  // 另一处写入后的显式刷新三路合并：本地没动过的档跟随最新答案，本地取消的钉住不复活，
  // 本地改过的档独立保留——两档互不连带。
  const fresh = qqConfig({
    binding: qqBinding({ revision: 7 }),
    overrides: overridesOf({
      allocation: { judgement: { mode: "auto" }, reply: { mode: "fixed" } },
    }),
    revision: 2,
  });
  const reload = vi.fn(async () => fresh);
  store.getState().resetForTests({ ...api, getQqGroupConfig: reload });
  store.setState({ qqGroupConfigEditor: editor, qqGroupConfigBindingId: BINDING_ID });
  store.getState().patchQqGroupOverride("allocation", "reply.mode", "auto");
  store.getState().patchQqGroupOverride("allocation", "judgement.mode", undefined);
  expect(await store.getState().refreshQqGroupConfig()).toBe(true);
  const merged = store.getState().qqGroupConfigEditor;
  expect(merged?.overrides).toEqual({ allocation: { reply: { mode: "auto" } } });
  expect(merged?.source.revision).toBe(2);
  // 生效值逐档独立：judgement 跟随基础方案 fixed，reply 保留本地改过的 auto。
  expect(qqGroupConfigEffectiveScheme(merged)?.allocation).toEqual({
    judgement: { mode: "fixed" },
    reply: { mode: "auto" },
  });
  expect(qqGroupConfigDirty(merged)).toBe(true);
});

// 旧快照回归：0068 之前的方案没有 allocation 组，DTO 兜底成 fixed——本群的显式模式覆盖
// 不得因为基础方案整组缺席而被清洗/合并丢掉。
it("keeps group mode overrides when the legacy base scheme omits allocation", () => {
  const legacyBase = qqScheme();
  const overrides = overridesOf({ allocation: { judgement: { mode: "auto" as const } } });
  const record = qqConfig({
    base_scheme: legacyBase,
    effective_scheme: mergeQqGroupScheme(legacyBase, overrides),
    overrides,
  });
  const editor = qqGroupConfigEditorFrom(record);
  // 清洗不丢：旧基线整组缺席也保留合法档覆盖。
  expect(editor.overrides).toEqual({ allocation: { judgement: { mode: "auto" } } });
  expect(qqGroupConfigEffectiveScheme(editor)?.allocation).toEqual({
    judgement: { mode: "auto" },
    reply: { mode: "fixed" },
  });
  expect(qqGroupConfigDirty(editor)).toBe(false);

  // 显式刷新同样不丢：另一处没有动 allocation 时，本地档覆盖原样保留。
  const fresh = qqConfig({
    binding: qqBinding({ revision: 7 }),
    base_scheme: legacyBase,
    effective_scheme: mergeQqGroupScheme(legacyBase, overrides),
    overrides,
    revision: 2,
  });
  const merged = mergeQqGroupConfigEditor(editor, fresh);
  expect(merged.overrides).toEqual({ allocation: { judgement: { mode: "auto" } } });
  expect(merged.identityConflict).toBeUndefined();
});

// 本地整份没动过：没钉的 judgement 跟随对方新钉的 auto，已钉的 reply 跟随对方的取消——
// 两档互不连带，也不能因为对象引用不同判成"本地改过"。
it("refresh three-way merge follows fresh judgement pin and reply unpin per tier", () => {
  const base = qqScheme({ allocation: { judgement: { mode: "fixed" }, reply: { mode: "fixed" } } });
  const record = qqConfig({
    base_scheme: base,
    effective_scheme: mergeQqGroupScheme(
      base,
      overridesOf({ allocation: { reply: { mode: "auto" as const } } }),
    ),
    overrides: overridesOf({ allocation: { reply: { mode: "auto" as const } } }),
    revision: 1,
  });
  const editor = qqGroupConfigEditorFrom(record);
  // 本地零改动：reply 钉着 auto（与记录一致），judgement 没钉。
  expect(editor.overrides).toEqual({ allocation: { reply: { mode: "auto" } } });

  const fresh = qqConfig({
    binding: qqBinding({ revision: 7 }),
    base_scheme: base,
    effective_scheme: mergeQqGroupScheme(
      base,
      overridesOf({ allocation: { judgement: { mode: "auto" as const } } }),
    ),
    overrides: overridesOf({ allocation: { judgement: { mode: "auto" as const } } }),
    revision: 2,
  });
  const merged = mergeQqGroupConfigEditor(editor, fresh);
  // judgement：本地没动过 → 跟随对方新钉的 auto；reply：本地没动过 → 跟随对方取消钉住。
  expect(merged.overrides).toEqual({ allocation: { judgement: { mode: "auto" } } });
  expect(merged.source.revision).toBe(2);
  expect(qqGroupConfigEffectiveScheme(merged)?.allocation).toEqual({
    judgement: { mode: "auto" },
    reply: { mode: "fixed" },
  });

  // 反向：本地真的改过 judgement（auto → fixed），对方钉的是 auto——本地改过优先独立保留；
  // reply 本地仍未动过，跟随对方的钉住。
  const localEdited = mergeQqGroupConfigEditor(
    { ...editor, overrides: overridesOf({ allocation: { judgement: { mode: "fixed" } } }) },
    fresh,
  );
  expect(localEdited.overrides).toEqual({ allocation: { judgement: { mode: "fixed" } } });
});

// 规范相等：同值钉住不产生假草稿——显式保存成与基线同值后，重开的编辑器必须是干净的。
it("canonical equality: a pinned mode identical to the base is not false dirty", async () => {
  const base = qqScheme({ allocation: { judgement: { mode: "fixed" }, reply: { mode: "auto" } } });
  const save = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
    ...qqConfig({
      base_scheme: base,
      effective_scheme: mergeQqGroupScheme(base, body.overrides),
      overrides: body.overrides,
      revision: 1,
    }),
    binding: qqBinding({ revision: 5 }),
  }));
  store.getState().resetForTests({ ...api, saveQqGroupConfig: save });
  const overrides = overridesOf({ allocation: { reply: { mode: "auto" as const } } });
  const response = qqConfig({
    base_scheme: base,
    effective_scheme: mergeQqGroupScheme(base, overrides),
    overrides,
  });
  const editor = qqGroupConfigEditorFrom(response);
  store.setState({
    qqGroupConfigEditor: editor,
    qqGroupConfigBindingId: BINDING_ID,
    qqSchemes: [base],
  });
  // 钉住 judgement=fixed，与基线同值：是真实覆盖，也是真实改动行。
  store.getState().patchQqGroupOverride("allocation", "judgement.mode", "fixed");
  expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
    allocation: { judgement: { mode: "fixed" }, reply: { mode: "auto" } },
  });
  expect(qqGroupConfigDirty(store.getState().qqGroupConfigEditor)).toBe(true);
  expect(await store.getState().saveQqGroupConfig()).toBe(true);
  expect(save.mock.calls[0][1].overrides).toEqual({
    allocation: { judgement: { mode: "fixed" }, reply: { mode: "auto" } },
  });
  // 保存后的基线含同值钉住：重开编辑器必须干净（sameValue 语义不得用引用相等判对象）。
  const saved = await save.mock.results[0].value;
  const reopened = qqGroupConfigEditorFrom(saved);
  expect(qqGroupConfigDirty(reopened)).toBe(false);
  expect(reopened.overrides).toEqual({
    allocation: { judgement: { mode: "fixed" }, reply: { mode: "auto" } },
  });
});
