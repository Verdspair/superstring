// Task routes retain their visited panes while all navigation uses the shared draft guard.

import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type QqBindingResponse,
  QqBindingResponseSchema,
  type QqSchemeResponse,
} from "../../src/shared/contracts/qq";
import type { QqGroupConfigResponse } from "../../src/shared/contracts/qq-group-config";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

const ui = (key: string) => i18n.t(key) as string;

const NOW = "2026-09-30T00:00:00.000Z";
const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCHEME_A = "22222222-2222-4222-8222-222222222222";
const SCHEME_B = "33333333-3333-4333-8333-333333333333";
const BINDING_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BINDING_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: SCHEME_A,
  name: "默认方案",
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
    stages: { decision: true, evaluation: true, generation: true },
    max_images: 8,
    ordinary_still_max_dimension: null,
  },
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
  input_anti_spam: { enabled: false, burst_min_messages: 3, burst_window_seconds: 3 },
  ...overrides,
});

const bindingOf = (schemeId: string, id: string, peer: string): QqBindingResponse =>
  QqBindingResponseSchema.parse({
    id,
    account_id: "10001",
    kind: "group",
    peer_id: peer,
    agent_id: AGENT_ID,
    scheme_id: schemeId,
    paused: false,
    triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
    // 响应契约必填「重要的人」：mode off 必须带空名单。
    attention: { mode: "off", members: [] },
    share_web_memory: false,
    memory_batch_size: null,
    pending_observations: 0,
    revision: 1,
    authority_revision: 1,
    task_limits: { mention_task_limit: null, ordinary_task_limit: null },
    input_anti_spam: { enabled: null, burst_min_messages: null, burst_window_seconds: null },
  });

const agentOf = (id: string, name: string) =>
  ({
    id,
    name,
    description: "",
    additional_instructions: "",
    model_name: "model",
    temperature: 0.7,
    p5_config: {},
    is_active: true,
    config_version: 1,
    persona_intensity: 50,
    created_at: NOW,
    updated_at: NOW,
  }) as never;

const groupConfigOf = (binding: QqBindingResponse): QqGroupConfigResponse => {
  const base = scheme({ id: binding.scheme_id });
  return {
    binding,
    base_scheme: base,
    effective_scheme: base,
    overrides: {} as QqGroupConfigResponse["overrides"],
    disabled_capabilities: [],
    revision: 0,
  };
};

function client(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    getQqSettings: vi.fn().mockResolvedValue({
      enabled: false,
      account_id: "10001",
      judgement_model_name: null,
      transport: { endpoint: null, has_token: false },
      revision: 1,
    }),
    getQqStatus: vi.fn().mockResolvedValue({ connection: null }),
    listQqConversations: vi.fn().mockResolvedValue([]),
    listQqBindings: vi
      .fn()
      .mockResolvedValue([
        bindingOf(SCHEME_A, BINDING_A, "30003"),
        bindingOf(SCHEME_B, BINDING_B, "40004"),
      ]),
    listQqSchemes: vi
      .fn()
      .mockResolvedValue([scheme(), scheme({ id: SCHEME_B, name: "夜间方案" })]),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: SCHEME_A, bindings: 0 }),
    getQqGroupConfig: vi.fn(async (bindingId: string) =>
      groupConfigOf(bindingOf(SCHEME_A, bindingId, "30003")),
    ),
    getQqStorage: vi.fn().mockResolvedValue({
      observations: { messages: 0, text: 0, expired_text: 0 },
      speech: { records: 0, text: 0 },
      sends: { attempts: 0, parts: 0 },
      nicknames: { current: 0, expired: 0 },
      stickers: { collections: 0, assets: 0, enabled: 0, bytes: 0 },
      dispatch: { candidates: 0, ready_now: 0, lease_held: false },
      media: { segments: 0, described: 0, pending: 0 },
      sweep: { tracked: 0, last_swept_at_seconds: 0, entries: [] },
      retention: { days: 14 },
    }),
    getQqStorageSettings: vi
      .fn()
      .mockResolvedValue({ revision: 1, retention_days: 14, cleanup_mode: "manual" }),
    listQqStorageItems: vi.fn().mockResolvedValue({ items: [], next_cursor: null, total: 0 }),
    getAgentKnowledgeRead: vi.fn().mockResolvedValue({
      revision: 1,
      config: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
    }),
    ...overrides,
  } as unknown as typeof api;
}

async function renderAt(route: string, overrides: Partial<typeof api> = {}) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: route as never,
    agents: [agentOf(AGENT_ID, "本地助手")],
  });
  render(<SchemesWorkspace />);
  await act(async () => {});
  return fake;
}

const taskButton = (key: string) =>
  screen.getByRole("button", { name: ui(key) }) as HTMLButtonElement;
const backToCatalog = () => userEvent.click(taskButton("schemes.backToCatalog"));

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("unified scheme workspace shell", () => {
  it("根目录三项等权任务可见，详情不显示全局任务，返回保留已访问目录", async () => {
    await renderAt("scheme-library");
    const schemesNode = document.querySelector('[data-qq-retained-scroll="schemes"]');
    const actions = [
      "schemes.workspace.bindings",
      "schemes.qq.connectionTitle",
      "connections.dataRetention",
    ].map(taskButton);
    expect(new Set(actions.map((button) => button.getAttribute("data-variant"))).size).toBe(1);
    expect(screen.queryByRole("tab", { name: ui("schemes.workspace.schemes") })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /夜间方案/ }));
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
    expect(screen.getByRole("heading", { name: "夜间方案", level: 1 })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: ui("schemes.backToCatalog") })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: ui("schemes.workspace.bindings") })).toBeNull();
    await backToCatalog();
    await userEvent.click(taskButton("schemes.workspace.bindings"));
    expect(store.getState().settingsRoute).toBe("scheme-bindings");
    expect(screen.getByLabelText(ui("connections.searchConversationBindings"))).toBeTruthy();
    await backToCatalog();
    await userEvent.click(taskButton("schemes.qq.connectionTitle"));
    expect(store.getState().settingsRoute).toBe("qq-connection");
    expect(screen.getByLabelText(ui("connections.websocketAddress"))).toBeTruthy();
    await backToCatalog();
    expect(document.querySelector('[data-qq-retained-scroll="schemes"]')).toBe(schemesNode);
    expect(screen.getByRole("button", { name: /默认方案/ })).toBeTruthy();
  });

  it("详情对象离开再回：对象 pane 保持挂载，同一 DOM 子树与同一编辑器对象，草稿不被重入覆盖", async () => {
    await renderAt("scheme-library");
    await userEvent.click(screen.getByRole("button", { name: /夜间方案/ }));
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
    const editorBefore = store.getState().qqSchemeEditor;
    expect(editorBefore?.source.id).toBe(SCHEME_B);
    // 详情设置视图的六组任务 tablist 与面包屑：对象 pane 内容子树的稳定 DOM 标记。
    const studioTabs = screen
      .getAllByRole("tablist")
      .find((node) => within(node).getAllByRole("tab").length === 6);
    expect(studioTabs).toBeTruthy();
    const crumb = screen.getByRole("heading", { name: "夜间方案", level: 1 });
    expect(crumb).toBeTruthy();

    // 经 primary nav 离开到方案分区：对象 pane 不被卸载（隐藏保留，NB5）。
    await backToCatalog();
    expect(store.getState().settingsRoute).toBe("scheme-library");
    expect(crumb).toBeTruthy();
    expect(crumb.closest("[hidden]")).toBeTruthy();

    // 同一对象重入：面包屑与 studio 子树是同一 DOM 实例，编辑器是同一对象。
    await userEvent.click(screen.getByRole("button", { name: /夜间方案/ }));
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
    expect(screen.getByRole("heading", { name: "夜间方案", level: 1 })).toBe(crumb);
    expect(
      screen.getAllByRole("tablist").find((node) => within(node).getAllByRole("tab").length === 6),
    ).toBe(studioTabs);
    expect(store.getState().qqSchemeEditor).toBe(editorBefore);

    // 重入后写的草稿落在同一编辑器对象上；同方案切「使用会话」不触发三选、不丢草稿。
    act(() => {
      store.getState().patchQqScheme({ name: "改过的名字" });
    });
    await userEvent.click(
      screen.getByRole("tab", { name: new RegExp(`^${ui("schemes.bindings.viewBindings")}`) }),
    );
    expect(store.getState().qqSchemeView).toBe("bindings");
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(store.getState().qqSchemeEditor?.name).toBe("改过的名字");
  });

  it("数据深链不挂载连接，返回目录再开连接仍保留数据pane", async () => {
    await renderAt("qq-storage");
    await screen.findByRole("heading", { name: ui("connections.dataRetention"), level: 1 });
    expect(screen.queryByLabelText(ui("connections.websocketAddress"))).toBeNull();
    const storageNode = document.querySelector('[data-qq-retained-scroll="data"]');
    await backToCatalog();
    await userEvent.click(taskButton("schemes.qq.connectionTitle"));
    expect(store.getState().settingsRoute).toBe("qq-connection");
    await screen.findByLabelText(ui("connections.websocketAddress"));
    expect(document.querySelector('[data-qq-retained-scroll="data"]')).toBe(storageNode);
    expect(storageNode?.closest("[hidden]")).toBeTruthy();
  });

  it("群配置路由经真实行级直入转换不抛 hooks 错误，返回时回到绑定分区", async () => {
    await renderAt("qq-app-groups");
    // 行级「本群配置」直入按钮（QqGroupControls, kind=group）直达对应群配置页。
    const row = screen.getByText("30003").closest("li") as HTMLElement;
    fireEvent.click(
      within(row).getByRole("button", {
        name: ui("schemes.qq.groupConfig.controls.configure"),
      }),
    );
    await act(async () => {});
    expect(store.getState().settingsRoute).toBe("qq-group-config");
    expect(store.getState().qqGroupConfigBindingId).toBe(BINDING_A);
    // <section aria-label> 的隐式 role 是 region：按可访问名定位，不自造 role。
    expect(screen.getByRole("region", { name: ui("schemes.qq.groupConfigTitle") })).toBeTruthy();

    // 对象页返回：canonical 目的地是绑定分区（全局看板），不再是旧应用外壳。
    fireEvent.click(
      screen.getByRole("button", { name: ui("schemes.qq.groupConfig.returnToOrigin") }),
    );
    await act(async () => {});
    expect(store.getState().settingsRoute).toBe("scheme-bindings");
    expect(screen.getByLabelText(ui("connections.searchConversationBindings"))).toBeTruthy();
  });

  it("10 个路由 ID 全部有效：别名归一到 canonical pane，无死路由", async () => {
    const cases: Array<[string, () => Promise<void>]> = [
      ["scheme-library", async () => expect(screen.getByText("默认方案")).toBeTruthy()],
      ["qq-app-schemes", async () => expect(screen.getByText("默认方案")).toBeTruthy()],
      [
        "scheme-bindings",
        async () =>
          expect(
            await screen.findByLabelText(ui("connections.searchConversationBindings")),
          ).toBeTruthy(),
      ],
      [
        "qq-app-groups",
        async () =>
          expect(
            await screen.findByLabelText(ui("connections.searchConversationBindings")),
          ).toBeTruthy(),
      ],
      [
        "qq-connection",
        async () =>
          expect(await screen.findByLabelText(ui("connections.websocketAddress"))).toBeTruthy(),
      ],
      [
        "qq-events",
        async () =>
          expect(
            (await screen.findByRole("tab", { name: ui("schemes.qq.eventsTitle") })).getAttribute(
              "aria-selected",
            ),
          ).toBe("true"),
      ],
      [
        "qq-runtime",
        async () =>
          expect(
            (await screen.findByRole("tab", { name: ui("schemes.qq.runtimeTitle") })).getAttribute(
              "aria-selected",
            ),
          ).toBe("true"),
      ],
      [
        "qq-storage",
        async () =>
          expect(
            await screen.findByRole("heading", { name: ui("connections.dataRetention"), level: 1 }),
          ).toBeTruthy(),
      ],
      [
        "qq-scheme-config",
        async () =>
          expect(
            await screen.findByRole("tab", { name: ui("schemes.bindings.viewSettings") }),
          ).toBeTruthy(),
      ],
      [
        "qq-group-config",
        async () =>
          expect(
            await screen.findByRole("region", { name: ui("schemes.qq.groupConfigTitle") }),
          ).toBeTruthy(),
      ],
    ];
    for (const [route, assertPane] of cases) {
      cleanup();
      if (route === "qq-group-config") {
        // 对象路由经真实入口动作携带对象进入：看板行级「本群配置」直入。
        await renderAt("qq-app-groups");
        const row = screen.getByText("30003").closest("li") as HTMLElement;
        fireEvent.click(
          within(row).getByRole("button", {
            name: ui("schemes.qq.groupConfig.controls.configure"),
          }),
        );
        await act(async () => {});
      } else if (route === "qq-scheme-config") {
        // 详情同样经真实行点击进入：目录行 requestQqSchemeNavigation 携带方案。
        await renderAt("scheme-library");
        await userEvent.click(screen.getByRole("button", { name: /夜间方案/ }));
      } else {
        await renderAt(route);
      }
      expect(store.getState().settingsRoute).toBe(route);
      await assertPane();
    }
  });
});
