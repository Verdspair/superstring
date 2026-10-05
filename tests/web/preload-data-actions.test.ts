// 启动数据预热：纯读动作的预热语义与真实竞态回归（真实 store + 替身 API）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import { ExecutionPolicySchema } from "../../src/shared/contracts/permissions";
import { QqBindingResponseSchema, type QqSchemeResponse } from "../../src/shared/contracts/qq";
import { ApiError, api } from "../../src/web/api";
import { qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { PRELOAD_REGISTRY } from "../../src/web/state/preload-registry";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-30T00:00:00.000Z";
const SCHEME_A = "22222222-2222-4222-8222-222222222222";
const SCHEME_B = "33333333-3333-4333-8333-333333333333";

const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: SCHEME_A,
  name: "默认方案",
  description: "群聊里的参与方式",
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

const binding = (schemeId: string, id: string) =>
  QqBindingResponseSchema.parse({
    id,
    account_id: "10001",
    kind: "group",
    peer_id: "30003",
    agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    scheme_id: schemeId,
    paused: false,
    triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
    share_web_memory: false,
    memory_batch_size: null,
    pending_observations: 0,
    revision: 1,
    authority_revision: 1,
    attention: { mode: "off", members: [] },
  });

const permSnapshot = (revision: string): PermissionsResponse => ({
  revision,
  policy: { version: 1, grants: [], execution: ExecutionPolicySchema.parse({}) },
  resources: [],
});

function schemeClient(overrides: Partial<typeof api> = {}) {
  const schemes = [scheme(), scheme({ id: SCHEME_B, name: "夜间方案", description: null })];
  return {
    ...api,
    listQqSchemes: vi.fn().mockImplementation(async () => [...schemes]),
    listQqBindings: vi
      .fn()
      .mockResolvedValue([binding(SCHEME_A, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1")]),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: SCHEME_A, bindings: 1 }),
    ...overrides,
  } as unknown as typeof api;
}

const desktopMeta = () => document.querySelector('meta[name="desktop-mode"]');

beforeEach(() => {
  store.getState().resetForTests();
  desktopMeta()?.remove();
});

afterEach(() => {
  desktopMeta()?.remove();
  vi.restoreAllMocks();
});

describe("startup prewarm data actions", () => {
  it("方案预热只落目录与绑定：不碰编辑器、usage 与既有脏草稿，也不清其他全局错误", async () => {
    const fake = schemeClient();
    store.getState().resetForTests(fake);
    const editor = qqSchemeEditorFrom(scheme());
    editor.name = "改过的名字";
    store.setState({ qqSchemeEditor: editor, error: "既有无关错误" });

    await store.getState().loadQqSchemes({ background: true, editor: false });
    await store.getState().loadQqBindings({ background: true });

    expect(fake.listQqSchemes).toHaveBeenCalledTimes(1);
    expect(fake.getQqSchemeUsage).not.toHaveBeenCalled();
    expect(store.getState().qqSchemes.map((row) => row.id)).toEqual([SCHEME_A, SCHEME_B]);
    expect(store.getState().qqSchemesLoaded).toBe(true);
    expect(store.getState().qqBindingsLoaded).toBe(true);
    expect(store.getState().qqBindings).toHaveLength(1);
    // 脏草稿不被合并、不被重置，也不产生刷新提示。
    expect(store.getState().qqSchemeEditor?.name).toBe("改过的名字");
    expect(store.getState().feedback).toBe("");
    // 预热成功不得清掉与预热无关的既有全局错误（error 默认 null/字符串，不按空串断言）。
    expect(store.getState().error).toBe("既有无关错误");
  });

  it("预热在途中前台共享同一请求：一次发包、不提前空返回；落定后允许一次前台权威读", async () => {
    const deferred = Promise.withResolvers<QqSchemeResponse[]>();
    const listQqSchemes = vi.fn().mockImplementation(() => deferred.promise);
    const fake = schemeClient({ listQqSchemes } as unknown as typeof api);
    store.getState().resetForTests(fake);

    const warm = store.getState().loadQqSchemes({ background: true, editor: false });
    let foregroundSettled = false;
    const foreground = store
      .getState()
      .loadQqSchemes()
      .then(() => {
        foregroundSettled = true;
      });
    expect(listQqSchemes).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    // 共享预热在途 Promise：前台调用必须等数据落地，不得先空手返回。
    expect(foregroundSettled).toBe(false);
    expect(store.getState().qqSchemes).toHaveLength(0);

    deferred.resolve([scheme(), scheme({ id: SCHEME_B, name: "夜间方案" })]);
    await foreground;
    expect(store.getState().qqSchemes).toHaveLength(2);
    await warm;
    // 共享的是预热分支：不开编辑器、不触发 usage。
    expect(fake.getQqSchemeUsage).not.toHaveBeenCalled();

    // 落定后在途共享结束：前台复验允许真实重读一次。
    await store.getState().loadQqSchemes();
    expect(listQqSchemes).toHaveBeenCalledTimes(2);
  });

  it("方案 403 撤权按真实 ApiError status 判定清目录，不靠错误文案匹配", async () => {
    const listQqSchemes = vi
      .fn()
      .mockRejectedValue(new ApiError(403, "QQ_SCHEME_READ_DENIED", "无权读取方案"));
    store.getState().resetForTests(schemeClient({ listQqSchemes } as unknown as typeof api));

    await store.getState().loadQqSchemes({ background: true, editor: false });
    // 撤权目录不得保留；后台预热保持静默，不写全局错误。
    expect(store.getState().qqSchemes).toEqual([]);
    expect(store.getState().qqSchemesLoaded).toBe(false);
    expect(store.getState().error).toBeNull();
  });

  it("权限后台复验保脏草稿且失败静默：保留已显示快照，不写全局错误", async () => {
    const getPermissions = vi
      .fn()
      .mockResolvedValueOnce(permSnapshot("pr-1"))
      .mockResolvedValueOnce(permSnapshot("pr-2"))
      .mockRejectedValueOnce(new Error("network down"));
    store.getState().resetForTests({ ...api, getPermissions } as unknown as typeof api);

    await store.getState().loadPermissionSettings({ background: true });
    store.getState().patchExecutionSettings({ loopMaxSteps: "20" });

    await store.getState().loadPermissionSettings({ background: true, refresh: true });
    expect(store.getState().permissionEditor?.execution.loopMaxSteps).toBe("20");
    expect(store.getState().permissionEditor?.snapshot.revision).toBe("pr-2");

    await store.getState().loadPermissionSettings({ background: true, refresh: true });
    expect(store.getState().permissionEditor?.execution.loopMaxSteps).toBe("20");
    expect(store.getState().permissionEditor?.snapshot.revision).toBe("pr-2");
    expect(store.getState().permissionError).toBe("");
  });

  it("权限在途请求随 API 客户端切换作废：不共享旧 pending，旧响应不落地", async () => {
    const deferred = Promise.withResolvers<PermissionsResponse>();
    const aGet = vi.fn().mockImplementation(() => deferred.promise);
    const bGet = vi.fn().mockResolvedValue(permSnapshot("pb-2"));
    store.getState().resetForTests({ ...api, getPermissions: aGet } as unknown as typeof api);
    const warm = store.getState().loadPermissionSettings({ background: true });

    store.getState().resetForTests({ ...api, getPermissions: bGet } as unknown as typeof api);
    const next = store.getState().loadPermissionSettings({ background: true });
    expect(aGet).toHaveBeenCalledTimes(1);
    expect(bGet).toHaveBeenCalledTimes(1);

    deferred.resolve(permSnapshot("pa-stale"));
    await warm;
    await next;
    expect(store.getState().permissionEditor?.snapshot.revision).toBe("pb-2");
  });

  it("偏好预热沿用既有桌面判定：浏览器模式不发 GET，桌面模式一次读取后按已载入复用", async () => {
    const getDesktopSettings = vi
      .fn()
      .mockResolvedValue({ close_action: "background", revision: 1 });
    store.getState().resetForTests({ ...api, getDesktopSettings } as unknown as typeof api);
    const preferences = PRELOAD_REGISTRY.find((entry) => entry.space === "preferences");
    expect(preferences?.dataStatus).toBe("eligible");
    expect(typeof preferences?.loadData).toBe("function");

    // 浏览器模式（无 desktop-mode meta）：预热绝不拉桌面设置。
    await preferences?.loadData?.();
    expect(getDesktopSettings).not.toHaveBeenCalled();

    // 桌面模式与 Preferences 同一判定（meta 注入）：允许一次读取并落地既有字段。
    document.head.insertAdjacentHTML("beforeend", '<meta name="desktop-mode" content="1">');
    await preferences?.loadData?.();
    expect(getDesktopSettings).toHaveBeenCalledTimes(1);
    expect(store.getState().desktopCloseAction).toBe("background");
    expect(store.getState().desktopCloseRevision).toBe(1);

    // loaded 复用既有字段短路，不引入新旗标也不重复发包。
    await preferences?.loadData?.();
    expect(getDesktopSettings).toHaveBeenCalledTimes(1);
  });

  it("桌面预热与保存竞态：保存成功后旧预热响应迟到不得覆盖新值", async () => {
    const warmDeferred = Promise.withResolvers<{
      close_action: "background" | "exit";
      revision: number;
    }>();
    const getDesktopSettings = vi.fn().mockImplementation(() => warmDeferred.promise);
    const updateDesktopSettings = vi
      .fn()
      .mockImplementation(async (input: { close_action: "background" | "exit" }) => ({
        close_action: input.close_action,
        revision: 2,
      }));
    store.getState().resetForTests({
      ...api,
      getDesktopSettings,
      updateDesktopSettings,
    } as unknown as typeof api);

    const warm = store.getState().loadDesktopSettings({ background: true });
    expect(await store.getState().updateDesktopCloseAction("exit")).toBe(true);
    expect(store.getState().desktopCloseAction).toBe("exit");
    expect(store.getState().desktopCloseRevision).toBe(2);

    warmDeferred.resolve({ close_action: "background", revision: 1 });
    await warm;
    // 旧预热响应迟到：新保存的 action/revision 不得被覆盖，pending 正常清理。
    expect(store.getState().desktopCloseAction).toBe("exit");
    expect(store.getState().desktopCloseRevision).toBe(2);
    expect(store.getState().desktopSettingsLoading).toBe(false);
  });
});
