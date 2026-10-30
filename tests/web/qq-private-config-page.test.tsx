// 私聊会话的共享配置页（真实 store + 假 API）：与群配置同一个 GET/PUT 编辑器与 CAS 修订，
// 但不出现群专属面（管理员、本群能力、reply.split_by_speaker 载荷）。
//
// 页面键文案沿用既有 groupConfig 键；这里只断言稳定可见事实与保存载荷。

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentKnowledgeReadSettings } from "../../src/shared/contracts/knowledge";
import {
  type PermissionGrant,
  type PermissionsResponse,
  PermissionsResponseSchema,
} from "../../src/shared/contracts/permissions";
import type { QqBindingResponse, QqSchemeResponse } from "../../src/shared/contracts/qq";
import type { QqGroupConfigResponse } from "../../src/shared/contracts/qq-group-config";
import { api, type SuperstringApi } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { QqGroupConfigPage } from "../../src/web/screens/connections/group-config";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

const NOW = "2026-09-30T00:00:00.000Z";
const BINDING_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const PRIVATE_PEER = "40004";

const qqScheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: SCHEME_ID,
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
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
  input_anti_spam: { enabled: false, burst_min_messages: 3, burst_window_seconds: 3 },
  ...overrides,
});

const privateBinding = (overrides: Partial<QqBindingResponse> = {}): QqBindingResponse => ({
  id: BINDING_ID,
  account_id: "10001",
  kind: "private",
  peer_id: PRIVATE_PEER,
  agent_id: AGENT_ID,
  scheme_id: SCHEME_ID,
  paused: false,
  triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
  share_web_memory: false,
  memory_batch_size: null,
  pending_observations: 0,
  revision: 4,
  authority_revision: 4,
  attention: { mode: "off", members: [] },
  task_limits: { mention_task_limit: null, ordinary_task_limit: null },
  input_anti_spam: { enabled: null, burst_min_messages: null, burst_window_seconds: null },
  ...overrides,
});

const privateConfig = (overrides: Partial<QqGroupConfigResponse> = {}): QqGroupConfigResponse => {
  const base = qqScheme();
  return {
    binding: privateBinding(),
    base_scheme: base,
    effective_scheme: base,
    overrides: {} as QqGroupConfigResponse["overrides"],
    disabled_capabilities: [],
    revision: 0,
    ...overrides,
  };
};

const permissions = (): PermissionsResponse =>
  PermissionsResponseSchema.parse({
    revision: "1",
    policy: {
      version: 1,
      grants: [] as PermissionGrant[],
      execution: { modules: { mcp: true, skills: true } },
    },
    resources: [],
  });

const knowledgeReadResponse = (): AgentKnowledgeReadSettings => ({
  revision: 1,
  config: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
});

function fakeClient(overrides: Partial<SuperstringApi>): SuperstringApi {
  return {
    ...api,
    getQqGroupConfig: vi.fn(async () => privateConfig()),
    saveQqGroupConfig: vi.fn(async () => privateConfig({ revision: 1 })),
    listQqSchemes: vi.fn(async () => [qqScheme()]),
    listQqStickerCollections: vi.fn(async () => []),
    listQqStickerAssets: vi.fn(async () => []),
    getPermissions: vi.fn(async () => permissions()),
    getAgentKnowledgeRead: vi.fn(async () => knowledgeReadResponse()),
    ...overrides,
  } as unknown as SuperstringApi;
}

async function renderPrivatePage(overrides: Partial<SuperstringApi> = {}) {
  const fake = fakeClient(overrides);
  store.getState().resetForTests(fake);
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "qq-group-config" });
  expect(await store.getState().selectQqGroupConfig(BINDING_ID)).toBe(true);
  const view = render(<QqGroupConfigPage />);
  await act(async () => {});
  return { fake, ...view };
}

const saveButtonOf = (view: Awaited<ReturnType<typeof renderPrivatePage>>) =>
  within(view.container.querySelector("footer") as HTMLElement)
    .getAllByRole("button")
    .at(-1) as HTMLButtonElement;

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("私聊绑定复用同一配置页：GET 读同一编辑器，字段改动按 CAS PUT，载荷不含群专属能力/管理员面/split_by_speaker", async () => {
  const view = await renderPrivatePage();
  const get = view.fake.getQqGroupConfig as unknown as ReturnType<typeof vi.fn>;
  expect(get).toHaveBeenCalledWith(BINDING_ID);

  // 页头身份按绑定如实显示：私聊 + 对端号码，不是群名。
  const header = view.container.querySelector("header") as HTMLElement;
  const context = view.container.querySelector("[data-group-context]") as HTMLElement;
  expect(header.textContent).toContain("私聊");
  expect(context.textContent).toContain(PRIVATE_PEER);
  expect(context.textContent).toContain("10001");
  expect(view.container.querySelectorAll("h1")).toHaveLength(1);

  // 群专属面不出现：管理员入口、本群能力页签。
  expect(screen.queryByRole("button", { name: "管理员" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "本群能力" })).toBeNull();

  // 同一编辑器状态：字段改动进入 store 草稿。
  const input = view.container.querySelector(
    'input[data-field="rhythm.merge_window_seconds"]',
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "31" } });
  expect(store.getState().qqGroupConfigEditor?.overrides).toEqual({
    rhythm: { merge_window_seconds: 31 },
  });
  expect(saveButtonOf(view).disabled).toBe(false);

  await act(async () => {
    fireEvent.click(saveButtonOf(view));
  });

  const save = view.fake.saveQqGroupConfig as ReturnType<typeof vi.fn>;
  expect(save).toHaveBeenCalledTimes(1);
  const [id, payload] = save.mock.calls[0] as [
    string,
    {
      agent_id: string;
      expected_binding_revision: number;
      expected_scheme_revision: number;
      expected_revision: number;
      overrides: Record<string, unknown>;
      disabled_capabilities: string[];
      scheme_id?: string;
      scheme_change?: string;
    },
  ];
  expect(id).toBe(BINDING_ID);
  // 三段 CAS 与打开时的基线一致；私聊同样只提交本层稀疏差异。
  expect(payload.agent_id).toBe(AGENT_ID);
  expect(payload.expected_binding_revision).toBe(4);
  expect(payload.expected_scheme_revision).toBe(3);
  expect(payload.expected_revision).toBe(0);
  expect(payload.overrides).toEqual({ rhythm: { merge_window_seconds: 31 } });
  // 群专属内容不随私聊 PUT 出行：没有能力停用、没有 split_by_speaker、没有换方案语义。
  expect(payload.disabled_capabilities).toEqual([]);
  expect(payload.overrides.reply).toBeUndefined();
  expect(payload.scheme_id).toBeUndefined();
  expect(payload.scheme_change).toBeUndefined();
});

it("私聊实际方案预览取消返回同一个按钮，保留未存方案与稀疏差异", async () => {
  const targetId = "33333333-3333-4333-8333-333333333333";
  const target = qqScheme({ id: targetId, name: "私聊目标方案", revision: 7 });
  const view = await renderPrivatePage({ listQqSchemes: vi.fn(async () => [qqScheme(), target]) });
  act(() => store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45"));
  const select = view.container.querySelector(
    'select[data-field="scheme.switch"]',
  ) as HTMLSelectElement;
  await userEvent.selectOptions(select, targetId);
  const switching = await screen.findByRole("dialog");
  await userEvent.click(switching.querySelector('[data-switch-action="keep"]') as HTMLElement);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const draft = structuredClone(store.getState().qqGroupConfigEditor?.overrides);
  const trigger = screen.getByRole("button", { name: "预览变更" });
  await userEvent.click(trigger);
  const preview = await screen.findByRole("dialog");
  await userEvent.click(within(preview).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(trigger.isConnected).toBe(true);
  expect(select.value).toBe(targetId);
  expect(store.getState().qqGroupConfigEditor?.overrides).toEqual(draft);
  expect(view.fake.saveQqGroupConfig).not.toHaveBeenCalled();
});

it("私聊原生方案选择取消与keep/reset返回同一选择框，保私域草稿且零PUT", async () => {
  const targetId = "33333333-3333-4333-8333-333333333333";
  const target = qqScheme({ id: targetId, name: "私聊选择目标", revision: 7 });
  const view = await renderPrivatePage({ listQqSchemes: vi.fn(async () => [qqScheme(), target]) });
  act(() => store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45"));
  const select = view.container.querySelector(
    'select[data-field="scheme.switch"]',
  ) as HTMLSelectElement;
  const baseline = structuredClone(store.getState().qqGroupConfigEditor?.overrides);
  for (const choice of ["cancel", "escape", "keep", "reset"] as const) {
    await userEvent.click(select);
    await userEvent.selectOptions(select, targetId);
    const dialog = await screen.findByRole("dialog");
    if (choice === "escape") await userEvent.keyboard("{Escape}");
    else if (choice === "cancel")
      await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    else
      await userEvent.click(
        dialog.querySelector(`[data-switch-action="${choice}"]`) as HTMLElement,
      );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(select));
    expect(select.isConnected).toBe(true);
    expect(select.value).toBe(choice === "cancel" || choice === "escape" ? SCHEME_ID : targetId);
    expect(store.getState().qqGroupConfigEditor?.source.base_scheme.id).toBe(SCHEME_ID);
    expect(store.getState().qqGroupConfigEditor?.overrides).toEqual(
      choice === "reset" ? {} : baseline,
    );
    expect(view.fake.saveQqGroupConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: "本群能力" })).toBeNull();
    if (choice === "keep") act(() => store.getState().patchQqGroupConfigScheme(undefined));
  }
});
