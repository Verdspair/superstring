// 方案目录与详情外壳：应用分组、绑定计数未知语义、草稿标识、行点击导航、新建（含脏草稿三选）流程。

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QqBindingResponseSchema, type QqSchemeResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { selectLocale, translate } from "../../src/web/i18n";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-30T00:00:00.000Z";
const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCHEME_A = "22222222-2222-4222-8222-222222222222";
const SCHEME_B = "33333333-3333-4333-8333-333333333333";
const SCHEME_NEW = "55555555-5555-4555-8555-555555555555";

// resetForTests 不重建动作，替身注入只能自己保存/还原真实动作。
const realActions = {
  requestQqSchemeNavigation: store.getState().requestQqSchemeNavigation,
  refreshQqScheme: store.getState().refreshQqScheme,
};

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

const binding = (schemeId: string, id: string) =>
  QqBindingResponseSchema.parse({
    id,
    account_id: "10001",
    kind: "group",
    peer_id: "30003",
    agent_id: AGENT_ID,
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

function client(overrides: Partial<typeof api> = {}) {
  // 目录读与创建共用一份可变列表：真实服务端创建后即可见，详情挂载时的重读不能回退旧列表。
  const schemes = [scheme(), scheme({ id: SCHEME_B, name: "夜间方案", description: null })];
  return {
    ...api,
    listQqSchemes: vi.fn().mockImplementation(async () => [...schemes]),
    listQqBindings: vi.fn().mockResolvedValue([]),
    listQqConversations: vi.fn().mockResolvedValue([]),
    getQqSettings: vi.fn().mockResolvedValue({
      enabled: false,
      account_id: "10001",
      judgement_model_name: null,
      transport: { endpoint: null, has_token: false },
      revision: 1,
    }),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: SCHEME_A, bindings: 0 }),
    listQqStickerCollections: vi.fn().mockResolvedValue([]),
    listQqStickerAssets: vi.fn().mockResolvedValue([]),
    createQqScheme: vi.fn().mockImplementation(async (body: unknown) => {
      const created = scheme({
        id: SCHEME_NEW,
        name: (body as { name: string }).name,
        description: null,
        revision: 1,
      });
      schemes.push(created);
      return created;
    }),
    ...overrides,
  } as unknown as typeof api;
}

async function renderDirectory(overrides: Partial<typeof api> = {}) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "scheme-library" });
  render(<SchemesWorkspace />);
  await act(async () => {});
  return { fake };
}

async function renderDetail(overrides: Partial<typeof api> = {}) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
  });
  render(<SchemesWorkspace />);
  await act(async () => {});
  return { fake };
}

function makeDirtyEditor(name = "改过的名字") {
  const editor = qqSchemeEditorFrom(scheme());
  editor.name = name;
  act(() => store.setState({ qqSchemeEditor: editor }));
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  // 替身注入是浅合并、resetForTests 不会重建动作：每个用例后都还原真实动作。
  store.setState({ ...realActions });
});

it("按应用列出方案：共用标识、描述、绑定计数（读到后）与行属性", async () => {
  const { fake } = await renderDirectory({
    listQqBindings: vi
      .fn()
      .mockResolvedValue([
        binding(SCHEME_A, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"),
        binding(SCHEME_A, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2"),
      ]),
  });
  expect(fake.listQqSchemes).toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "方案" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "QQ" })).toBeTruthy();
  expect(screen.getByText("QQ 群与私聊共用的参与方案。")).toBeTruthy();
  expect(screen.getByText("默认方案")).toBeTruthy();
  expect(screen.getByText("群聊里的参与方式")).toBeTruthy();
  expect(screen.getAllByText("群与私聊共用")).toHaveLength(2);
  expect(screen.getByText("2 个会话绑定")).toBeTruthy();
  expect(screen.getByText("0 个会话绑定")).toBeTruthy();
  const firstRow = screen.getByRole("button", { name: /默认方案/ });
  expect(firstRow.getAttribute("data-scheme-open")).toBe(SCHEME_A);
  // 正常态也有可见的刷新入口，不再只在错误/未知态出现。
  expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("按使用情况筛选"), { target: { value: "unused" } });
  expect(screen.queryByText("默认方案")).toBeNull();
  expect(screen.getByText("夜间方案")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("按使用情况筛选"), { target: { value: "used" } });
  expect(screen.getByText("默认方案")).toBeTruthy();
  expect(screen.queryByText("夜间方案")).toBeNull();
});

it("使用筛选后绑定刷新失败仍显示未知数量的方案，不把列表筛空", async () => {
  const bindings = vi
    .fn()
    .mockResolvedValue([binding(SCHEME_A, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1")]);
  await renderDirectory({ listQqBindings: bindings });
  fireEvent.change(screen.getByLabelText("按使用情况筛选"), { target: { value: "used" } });
  expect(screen.queryByText("夜间方案")).toBeNull();
  bindings.mockRejectedValueOnce(new Error("bindings refresh failed"));
  await act(async () => store.getState().loadQqBindings(true));
  expect(screen.getByText("默认方案")).toBeTruthy();
  expect(screen.getByText("夜间方案")).toBeTruthy();
  expect(screen.getAllByText("绑定数未知")).toHaveLength(2);
  expect(screen.queryByText("没有匹配的方案")).toBeNull();
});

it("当前编辑中的未保存草稿只在对应方案行上标记", async () => {
  await renderDirectory();
  const editor = qqSchemeEditorFrom(scheme());
  editor.name = "改过的名字";
  act(() => store.setState({ qqSchemeEditor: editor }));
  const row = screen.getByRole("button", { name: /默认方案/ });
  expect(within(row).getByText("有未保存草稿")).toBeTruthy();
  const other = screen.getByRole("button", { name: /夜间方案/ });
  expect(within(other).queryByText("有未保存草稿")).toBeNull();
});

it("绑定未读到显示未知、禁用使用筛选，刷新走 refreshQqScheme", async () => {
  const refresh = vi.fn();
  await renderDirectory({ listQqBindings: vi.fn().mockRejectedValue(new Error("bindings down")) });
  expect(store.getState().qqBindingsLoaded).toBe(false);
  expect(screen.getAllByText("绑定数未知")).toHaveLength(2);
  expect(screen.queryByText("0 个会话绑定")).toBeNull();
  expect((screen.getByLabelText("按使用情况筛选") as HTMLSelectElement).disabled).toBe(true);
  store.setState({ refreshQqScheme: refresh } as never);
  for (const button of screen.getAllByRole("button", { name: "刷新" })) fireEvent.click(button);
  expect(refresh).toHaveBeenCalled();
});

it("行点击把选中的方案交给 requestQqSchemeNavigation", async () => {
  const navigate = vi.fn();
  await renderDirectory();
  store.setState({ requestQqSchemeNavigation: navigate } as never);
  fireEvent.click(screen.getByRole("button", { name: /夜间方案/ }));
  expect(navigate).toHaveBeenCalledWith(SCHEME_B);
});

it("行点击经真实动作切换到该方案并停在详情路由", async () => {
  await renderDirectory();
  fireEvent.click(screen.getByRole("button", { name: /夜间方案/ }));
  expect(store.getState().settingsRoute).toBe("qq-scheme-config");
  expect(store.getState().qqSchemeEditor?.source.id).toBe(SCHEME_B);
});

it("行点击当前已选方案：仍经真实动作落到详情路由", async () => {
  await renderDirectory();
  fireEvent.click(screen.getByRole("button", { name: /默认方案/ }));
  expect(store.getState().qqSchemeEditor?.source.id).toBe(SCHEME_A);
  expect(store.getState().settingsRoute).toBe("qq-scheme-config");
});

it("目录新建：关闭对话框保留名称，成功后才导航到新方案", async () => {
  const { fake } = await renderDirectory();
  fireEvent.click(screen.getByRole("button", { name: "新建方案" }));
  fireEvent.change(screen.getByLabelText("方案名称"), { target: { value: "群聊方案" } });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(store.getState().qqInputs.schemeNewName).toBe("群聊方案");
  fireEvent.click(screen.getByRole("button", { name: "新建方案" }));
  expect((screen.getByLabelText("方案名称") as HTMLInputElement).value).toBe("群聊方案");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认" })));
  expect(fake.createQqScheme).toHaveBeenCalledWith({ name: "群聊方案", description: null });
  expect(store.getState().settingsRoute).toBe("qq-scheme-config");
  expect(store.getState().qqSchemeEditor?.source.id).toBe(SCHEME_NEW);
  expect(store.getState().qqInputs.schemeNewName).toBe("");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("创建失败保留对话框与名称，也不导航", async () => {
  const { fake } = await renderDirectory({
    createQqScheme: vi.fn().mockRejectedValue(new Error("boom")),
  });
  fireEvent.click(screen.getByRole("button", { name: "新建方案" }));
  fireEvent.change(screen.getByLabelText("方案名称"), { target: { value: "群聊方案" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认" })));
  expect(fake.createQqScheme).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect((screen.getByLabelText("方案名称") as HTMLInputElement).value).toBe("群聊方案");
  expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  expect(store.getState().settingsRoute).toBe("scheme-library");
});

it("有未保存草稿时新建先三选：保存成功后继续创建", async () => {
  const { fake } = await renderDirectory({
    updateQqScheme: vi.fn().mockResolvedValue(scheme({ name: "改过的名字", revision: 4 })),
  });
  makeDirtyEditor();
  fireEvent.click(screen.getByRole("button", { name: "新建方案" }));
  fireEvent.change(screen.getByLabelText("方案名称"), { target: { value: "群聊方案" } });
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  expect(fake.createQqScheme).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "保存并继续" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "放弃修改并继续" })).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存并继续" })));
  expect(fake.updateQqScheme).toHaveBeenCalledWith(
    SCHEME_A,
    expect.objectContaining({ name: "改过的名字", expected_revision: 3 }),
  );
  expect(fake.createQqScheme).toHaveBeenCalledWith({ name: "群聊方案", description: null });
  expect(store.getState().qqSchemeEditor?.source.id).toBe(SCHEME_NEW);
  expect(store.getState().qqInputs.schemeNewName).toBe("");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("脏草稿含无效输入：保存并继续禁用，取消保留名称与草稿", async () => {
  const { fake } = await renderDirectory();
  makeDirtyEditor();
  act(() =>
    store.setState((state) => ({
      qqInputs: {
        ...state.qqInputs,
        schemeTexts: { "rhythm.merge_window_seconds": "abc" },
        schemeInvalid: { "rhythm.merge_window_seconds": "abc" },
      },
    })),
  );
  fireEvent.click(screen.getByRole("button", { name: "新建方案" }));
  fireEvent.change(screen.getByLabelText("方案名称"), { target: { value: "群聊方案" } });
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  expect((screen.getByRole("button", { name: "保存并继续" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(fake.createQqScheme).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(store.getState().qqInputs.schemeNewName).toBe("群聊方案");
  expect(store.getState().qqSchemeEditor?.name).toBe("改过的名字");
});

it("保存失败：留在对话框、保留名称与旧草稿，不创建", async () => {
  const { fake } = await renderDirectory({
    updateQqScheme: vi.fn().mockRejectedValue(new Error("boom")),
  });
  makeDirtyEditor();
  fireEvent.click(screen.getByRole("button", { name: "新建方案" }));
  fireEvent.change(screen.getByLabelText("方案名称"), { target: { value: "群聊方案" } });
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存并继续" })));
  expect(fake.createQqScheme).not.toHaveBeenCalled();
  expect(screen.getAllByRole("dialog").length).toBe(1);
  expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  expect(store.getState().qqInputs.schemeNewName).toBe("群聊方案");
  expect(store.getState().qqSchemeEditor?.name).toBe("改过的名字");
});

it("脏草稿选择放弃修改并继续：直接创建并把编辑器换成新方案", async () => {
  const { fake } = await renderDirectory();
  makeDirtyEditor();
  fireEvent.click(screen.getByRole("button", { name: "新建方案" }));
  fireEvent.change(screen.getByLabelText("方案名称"), { target: { value: "群聊方案" } });
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "放弃修改并继续" })));
  expect(fake.createQqScheme).toHaveBeenCalledWith({ name: "群聊方案", description: null });
  expect(store.getState().qqSchemeEditor?.source.id).toBe(SCHEME_NEW);
  expect(store.getState().qqInputs.schemeNewName).toBe("");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("详情两种任务视图：默认方案设置，切到使用会话再回来不丢整案草稿", async () => {
  await renderDetail();
  const settingsTab = screen.getByRole("tab", { name: translate("schemes.bindings.viewSettings") });
  const bindingsTab = screen.getByRole("tab", { name: translate("schemes.bindings.viewBindings") });
  expect(settingsTab.getAttribute("aria-selected")).toBe("true");
  // 方案设置里的原四 Tab 仍在原位。
  for (const tabKey of [
    "connections.whenToParticipate",
    "connections.howToRespond",
    "connections.whatToRead",
    "connections.mediaAndExpression",
  ])
    expect(screen.getByRole("tab", { name: translate(tabKey) })).toBeTruthy();

  // 有未保存草稿时切视图不触发保存/放弃三选，草稿原文保留。
  const editor = qqSchemeEditorFrom(scheme());
  editor.name = "改过的名字";
  act(() => store.setState({ qqSchemeEditor: editor }));
  await userEvent.click(bindingsTab);
  await act(async () => {});
  expect(store.getState().qqSchemeView).toBe("bindings");
  expect(store.getState().navigationConfirmOpen).toBe(false);
  expect(store.getState().qqSchemeEditor?.name).toBe("改过的名字");
  await userEvent.click(settingsTab);
  await act(async () => {});
  expect(store.getState().qqSchemeView).toBe("settings");
  expect(store.getState().qqSchemeEditor?.name).toBe("改过的名字");
});

it("详情用法计数点击直达使用会话，不再开只读弹窗", async () => {
  await renderDetail();
  const usage = document.querySelector("[data-scheme-usage]") as HTMLButtonElement;
  expect(usage.textContent).toBe(translate("connections.usedByValueConversations", "0"));
  fireEvent.click(usage);
  await act(async () => {});
  expect(store.getState().qqSchemeView).toBe("bindings");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("目录提供全局会话绑定入口，落到与详情使用会话同一绑定视图", async () => {
  await renderDirectory();
  expect(screen.getByText(translate("schemes.bindings.entryHint"))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: translate("schemes.bindings.entry") }));
  expect(store.getState().settingsRoute).toBe("scheme-bindings");
});

it("QQ 标题与同排连接/数据同为 outline 32px 入口，忙碌禁用与连接目标不变", async () => {
  await renderDirectory();
  const title = screen.getByRole("button", { name: "QQ" });
  const connection = screen.getByRole("button", { name: "连接" });
  const data = screen.getByRole("button", { name: "数据与保留" });
  // 标题入口保留打开应用管理的属性，与连接/数据同为 outline 默认尺寸（min-h-8=32px）。
  expect(title.getAttribute("data-scheme-app-open")).toBe("qq");
  for (const button of [title, connection, data]) {
    expect(button.getAttribute("data-variant")).toBe("outline");
    expect(button.getAttribute("data-size")).toBe("default");
    expect(button.className).toContain("h-auto");
    expect(button.className).toContain("min-h-8");
    expect(button.className).toContain("whitespace-normal");
    expect(button.className).not.toContain("h-7");
  }
  // 忙碌时三个入口与同页操作一起禁用。
  act(() => store.setState({ qqSchemeSaving: true }));
  for (const button of [title, connection, data]) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
  act(() => store.setState({ qqSchemeSaving: false }));
  fireEvent.click(connection);
  expect(store.getState().settingsRoute).toBe("qq-connection");
});

it("进入 QQ 应用管理后目录只留 QQ，不再重复捷径入口", async () => {
  await renderDirectory();
  fireEvent.click(screen.getByRole("button", { name: "QQ" }));
  expect(store.getState().settingsRoute).toBe("qq-app-schemes");
  await act(async () => {});
  expect(screen.queryByLabelText(translate("schemes.appFilter"))).toBeNull();
  expect(screen.queryByRole("button", { name: "数据与保留" })).toBeNull();
  expect(screen.getByText("默认方案")).toBeTruthy();
});

it("详情面包屑的 QQ 回到应用目录，工具条的应用管理直达连接", async () => {
  await renderDetail();
  const nav = screen.getByRole("navigation", { name: translate("workspace.schemes") });
  fireEvent.click(within(nav).getByRole("button", { name: "QQ" }));
  expect(store.getState().settingsRoute).toBe("qq-app-schemes");
  cleanup();
  await renderDetail();
  fireEvent.click(screen.getByRole("button", { name: translate("schemes.appManagement") }));
  expect(store.getState().settingsRoute).toBe("qq-connection");
});

it("往应用管理的导航复用 QQ 草稿三选，取消保留草稿与原路由", async () => {
  await renderDetail();
  makeDirtyEditor();
  fireEvent.click(screen.getByRole("button", { name: translate("schemes.appManagement") }));
  expect(store.getState()).toMatchObject({
    settingsRoute: "qq-scheme-config",
    navigationConfirmOpen: true,
    pendingNavigation: {
      kind: "page",
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-connection",
    },
  });
  store.getState().cancelPendingNavigation();
  expect(store.getState().qqSchemeEditor?.name).toBe("改过的名字");
  expect(store.getState().settingsRoute).toBe("qq-scheme-config");
});

it("详情外壳：面包屑显示真实编辑对象、返回目录", async () => {
  await renderDetail();
  const nav = screen.getByRole("navigation", { name: "方案" });
  expect(within(nav).getByText("方案")).toBeTruthy();
  expect(within(nav).getByText("QQ")).toBeTruthy();
  const name = within(nav).getByText("默认方案");
  expect(name.className).not.toContain("truncate");
  fireEvent.click(screen.getByRole("button", { name: "返回方案目录" }));
  expect(store.getState().settingsRoute).toBe("scheme-library");
});

it("详情空态给出新建入口，不自动新建或分配", async () => {
  const { fake } = await renderDetail({ listQqSchemes: vi.fn().mockResolvedValue([]) });
  expect(screen.getByRole("button", { name: "新建方案" })).toBeTruthy();
  expect(fake.createQqScheme).not.toHaveBeenCalled();
});
