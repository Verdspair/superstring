// 本群配置：待切换目标方案时的刷新基线与 CAS 修订同步
// 验证当存在待切换目标方案（pending target switch）时，刷新保存基线必须同步刷新目标方案的修订版本，
// 避免保存时使用已过期的 catalog revision 导致后端报 [MEMORY_STATE_CONFLICT] 方案已变化。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QqBindingResponse, QqSchemeResponse } from "../../src/shared/contracts/qq";
import type {
  QqGroupConfigResponse,
  QqGroupSchemeOverrides,
  UpdateQqGroupConfigRequest,
} from "../../src/shared/contracts/qq-group-config";
import { api, type SuperstringApi } from "../../src/web/api";
import { qqGroupConfigDirty } from "../../src/web/features/qq/group-config-state";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-10-17T00:00:00.000Z";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BINDING_ID = "11111111-1111-4111-8111-222222222222";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const BASE_SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_SCHEME_ID = "33333333-3333-4333-8333-333333333333";

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
  revision: 1,
  created_at: NOW,
  updated_at: NOW,
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

const fakeClient = (overrides: Partial<SuperstringApi>): SuperstringApi => ({
  ...api,
  ...overrides,
});

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

describe("qq-group-config 待切换方案刷新与 CAS 修订同步", () => {
  it("待切换目标方案时，刷新基线应同步刷新目录最新方案修订，保存时发送最新的 expected_scheme_revision", async () => {
    const schemeA = qqScheme({ id: BASE_SCHEME_ID, name: "方案A", revision: 1 });
    const schemeB_initial = qqScheme({ id: TARGET_SCHEME_ID, name: "方案B", revision: 2 });
    const schemeB_updated = qqScheme({ id: TARGET_SCHEME_ID, name: "方案B", revision: 3 });

    let targetSchemeInCatalog = schemeB_initial;
    const listQqSchemes = vi.fn(async () => [schemeA, targetSchemeInCatalog]);
    const save = vi.fn(async (_id: string, _payload: UpdateQqGroupConfigRequest) =>
      qqConfig({
        binding: qqBinding({ revision: 5, scheme_id: TARGET_SCHEME_ID }),
        base_scheme: schemeB_updated,
      }),
    );

    ready(
      fakeClient({
        getQqGroupConfig: async () =>
          qqConfig({
            binding: qqBinding({ revision: 4, scheme_id: BASE_SCHEME_ID }),
            base_scheme: schemeA,
          }),
        listQqSchemes,
        saveQqGroupConfig: save,
      }),
    );

    store.setState({ qqSchemes: [schemeA, schemeB_initial], qqSchemesLoaded: true });
    await store.getState().selectQqGroupConfig(BINDING_ID);

    store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");
    store.getState().patchQqGroupConfigScheme(TARGET_SCHEME_ID, "keep");

    expect(editorOf()?.schemeId).toBe(TARGET_SCHEME_ID);
    expect(editorOf()?.schemeChange).toBe("keep");
    expect(qqGroupConfigDirty(editorOf())).toBe(true);

    targetSchemeInCatalog = schemeB_updated;

    const refreshed = await store.getState().refreshQqGroupConfig();
    expect(refreshed).toBe(true);

    expect(editorOf()?.schemeId).toBe(TARGET_SCHEME_ID);
    expect(editorOf()?.schemeChange).toBe("keep");
    expect(editorOf()?.overrides.rhythm?.merge_window_seconds).toBe(45);

    const savedOk = await store.getState().saveQqGroupConfig();
    expect(savedOk).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);

    expect(save).toHaveBeenLastCalledWith(
      BINDING_ID,
      expect.objectContaining({
        scheme_id: TARGET_SCHEME_ID,
        scheme_change: "keep",
        expected_scheme_revision: 3,
        overrides: expect.objectContaining({
          rhythm: expect.objectContaining({ merge_window_seconds: 45 }),
        }),
      }),
    );
  });

  it("对照用例：不换方案时，刷新基线保留本地草稿并推进 base_scheme 修订基线", async () => {
    const schemeA_v1 = qqScheme({ id: BASE_SCHEME_ID, name: "方案A", revision: 1 });
    const schemeA_v2 = qqScheme({ id: BASE_SCHEME_ID, name: "方案A", revision: 2 });

    let serverSchemeA = schemeA_v1;
    const save = vi.fn(async (_id: string, _payload: UpdateQqGroupConfigRequest) =>
      qqConfig({
        binding: qqBinding({ revision: 4, scheme_id: BASE_SCHEME_ID }),
        base_scheme: schemeA_v2,
      }),
    );

    ready(
      fakeClient({
        getQqGroupConfig: async () =>
          qqConfig({
            binding: qqBinding({ revision: 4, scheme_id: BASE_SCHEME_ID }),
            base_scheme: serverSchemeA,
          }),
        saveQqGroupConfig: save,
      }),
    );

    store.setState({ qqSchemes: [schemeA_v1], qqSchemesLoaded: true });
    await store.getState().selectQqGroupConfig(BINDING_ID);

    store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");
    expect(qqGroupConfigDirty(editorOf())).toBe(true);
    expect(editorOf()?.source.base_scheme.revision).toBe(1);

    serverSchemeA = schemeA_v2;

    const refreshed = await store.getState().refreshQqGroupConfig();
    expect(refreshed).toBe(true);

    expect(editorOf()?.overrides.rhythm?.merge_window_seconds).toBe(45);
    expect(editorOf()?.source.base_scheme.revision).toBe(2);
    expect(editorOf()?.schemeId).toBeUndefined();

    const savedOk = await store.getState().saveQqGroupConfig();
    expect(savedOk).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith(
      BINDING_ID,
      expect.objectContaining({
        expected_scheme_revision: 2,
        overrides: expect.objectContaining({
          rhythm: expect.objectContaining({ merge_window_seconds: 45 }),
        }),
      }),
    );
    expect(save.mock.calls[0]?.[1]).not.toHaveProperty("scheme_id");
  });

  it("异常场景：目标方案目录刷新失败时不发布新基线且保留草稿", async () => {
    const schemeA = qqScheme({ id: BASE_SCHEME_ID, name: "方案A", revision: 1 });
    const schemeB = qqScheme({ id: TARGET_SCHEME_ID, name: "方案B", revision: 2 });

    const listQqSchemes = vi.fn(async () => {
      throw new Error("Network timeout");
    });

    ready(
      fakeClient({
        getQqGroupConfig: async () =>
          qqConfig({
            binding: qqBinding({ revision: 4, scheme_id: BASE_SCHEME_ID }),
            base_scheme: schemeA,
          }),
        listQqSchemes,
      }),
    );

    store.setState({ qqSchemes: [schemeA, schemeB], qqSchemesLoaded: true });
    await store.getState().selectQqGroupConfig(BINDING_ID);

    store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45");
    store.getState().patchQqGroupConfigScheme(TARGET_SCHEME_ID, "keep");

    const refreshed = await store.getState().refreshQqGroupConfig();
    expect(refreshed).toBe(false);

    expect(store.getState().error).toBeTruthy();
    expect(editorOf()?.schemeId).toBe(TARGET_SCHEME_ID);
    expect(editorOf()?.schemeChange).toBe("keep");
    expect(editorOf()?.overrides.rhythm?.merge_window_seconds).toBe(45);
    expect(editorOf()?.source.base_scheme.revision).toBe(1);
    expect(editorOf()?.source.binding.id).toBe(BINDING_ID);
  });

  it("乱序保护：旧读取晚到不覆盖较新的切换或导航", async () => {
    const schemeA = qqScheme({ id: BASE_SCHEME_ID, name: "方案A", revision: 1 });
    const schemeOther = qqScheme({
      id: "99999999-9999-4999-8999-999999999999",
      name: "方案Other",
      revision: 5,
    });
    const bindingA = qqBinding({ id: BINDING_ID });
    const otherBinding = qqBinding({
      id: OTHER_BINDING_ID,
      peer_id: "987654321",
      scheme_id: schemeOther.id,
    });

    let resolveSecondCall!: (value: QqGroupConfigResponse) => void;
    let callCount = 0;
    const mockGet = vi.fn(async (_id: string) => {
      callCount += 1;
      if (callCount === 1) {
        return qqConfig({ binding: bindingA, base_scheme: schemeA });
      }
      if (callCount === 2) {
        return new Promise<QqGroupConfigResponse>((resolve) => {
          resolveSecondCall = resolve;
        });
      }
      return qqConfig({ binding: otherBinding, base_scheme: schemeOther });
    });

    ready(fakeClient({ getQqGroupConfig: mockGet }), [bindingA, otherBinding]);

    await store.getState().selectQqGroupConfig(BINDING_ID);
    expect(editorOf()?.source.binding.id).toBe(BINDING_ID);

    const refreshPromise = store.getState().refreshQqGroupConfig();

    await store.getState().selectQqGroupConfig(OTHER_BINDING_ID);
    expect(store.getState().qqGroupConfigBindingId).toBe(OTHER_BINDING_ID);
    expect(editorOf()?.source.binding.id).toBe(OTHER_BINDING_ID);

    resolveSecondCall(qqConfig({ binding: bindingA, base_scheme: schemeA }));

    const refreshed = await refreshPromise;
    expect(refreshed).toBe(false);

    expect(store.getState().qqGroupConfigBindingId).toBe(OTHER_BINDING_ID);
    expect(editorOf()?.source.binding.id).toBe(OTHER_BINDING_ID);
    expect(editorOf()?.source.base_scheme.id).toBe(schemeOther.id);
  });
});
