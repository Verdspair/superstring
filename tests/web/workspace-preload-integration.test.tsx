// 启动数据预热：工作区前台消费集成（真实 store + 替身 API + 真实组件挂载）。
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import { ExecutionPolicySchema } from "../../src/shared/contracts/permissions";
import { QqBindingResponseSchema, type QqSchemeResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { selectLocale, translate } from "../../src/web/i18n";
import { CapabilitiesWorkspace } from "../../src/web/screens/connections/CapabilitiesWorkspace";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
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

const permSnapshot = (): PermissionsResponse => ({
  revision: "pr-1",
  policy: { version: 1, grants: [], execution: ExecutionPolicySchema.parse({}) },
  resources: [],
});

function schemeClient(overrides: Partial<typeof api> = {}) {
  const schemes = [scheme(), scheme({ id: SCHEME_B, name: "夜间方案", description: null })];
  const listQqSchemes = vi.fn().mockImplementation(async () => [...schemes]);
  const listQqBindings = vi
    .fn()
    .mockResolvedValue([binding(SCHEME_A, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1")]);
  const getQqSchemeUsage = vi.fn(async (id: string) => ({ scheme_id: id, bindings: 1 }));
  const fake = {
    ...api,
    listQqSchemes,
    listQqBindings,
    getQqSchemeUsage,
    ...overrides,
  } as unknown as typeof api;
  return { fake, listQqSchemes, listQqBindings, getQqSchemeUsage };
}

const registryEntry = (space: string) => {
  const entry = PRELOAD_REGISTRY.find((item) => item.space === space);
  expect(entry?.dataStatus).toBe("eligible");
  expect(typeof entry?.loadData).toBe("function");
  return entry;
};

beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("workspace first mount after prewarm", () => {
  it("方案：预热直出目录，前台首访消费走正常 usage，挂载复验一次且不循环", async () => {
    const { fake, listQqSchemes, listQqBindings, getQqSchemeUsage } = schemeClient();
    store.getState().resetForTests(fake);

    await registryEntry("schemes")?.loadData?.();
    // 预热只落目录：编辑器未抢占、usage 未触发。
    expect(listQqSchemes).toHaveBeenCalledTimes(1);
    expect(store.getState().qqSchemes).toHaveLength(2);
    expect(store.getState().qqSchemeEditor).toBeNull();
    expect(getQqSchemeUsage).not.toHaveBeenCalled();

    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "scheme-library",
    });
    render(<SchemesWorkspace />);
    // 预热就绪即直出：首次渲染已有目录内容，不闪空列表。
    expect(screen.getByText("默认方案")).toBeTruthy();
    await act(async () => {});

    // 前台首访消费：编辑器经公共 action 打开，usage 走正常读取（合法且只一次）。
    expect(store.getState().qqSchemeEditor?.source.id).toBe(SCHEME_A);
    expect(getQqSchemeUsage).toHaveBeenCalledTimes(1);
    expect(getQqSchemeUsage.mock.calls[0][0]).toBe(SCHEME_A);

    // 单次复验无循环：预热 1 次 + 挂载复验 1 次；绑定沿用 loaded 短路不重复发包。
    await act(async () => {});
    await act(async () => {});
    expect(listQqSchemes).toHaveBeenCalledTimes(2);
    expect(listQqBindings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("能力：预热事实直出不再显示未读取，挂载单次复验且不循环", async () => {
    const getPermissions = vi.fn().mockResolvedValue(permSnapshot());
    store.getState().resetForTests({ ...api, getPermissions } as unknown as typeof api);

    await registryEntry("capabilities")?.loadData?.();
    expect(store.getState().permissionEditor).not.toBeNull();
    expect(getPermissions).toHaveBeenCalledTimes(1);

    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    render(<CapabilitiesWorkspace />);
    // 预热就绪：首次渲染即按已读事实呈现，不出现“未读取”。
    expect(screen.queryByText(translate("capabilities.state.unread"))).toBeNull();
    await act(async () => {});

    // loaded 不永久跳过复验：挂载恰好补一次读取，且不重复轰炸。
    await act(async () => {});
    await act(async () => {});
    expect(getPermissions).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
