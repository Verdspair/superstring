// 方案绑定视图：详情「使用会话」与全局「会话绑定」共用（行为断言，界面键经 i18n.t 取）。
//
// 覆盖：本方案绑定列表、管理编辑；添加会话草稿存 qqInputs.manual*（关闭不丢、成功才清、
// 缺 Agent 原地失败、放弃才清）；已绑定会话不静默覆盖；无方案先创建；显式方案不在目录时不回退；
// 搜索/类型筛选/最近消息；目录读失败可重试；连接页刷新重读设置与状态、失败不重复提示；
// 抽屉刷新保存基线：409 后草稿保留并以新 revision 重试，刷新失败不改草稿基线。

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema } from "../../src/shared/contracts";
import {
  type QqBindingResponse,
  QqBindingResponseSchema,
  type QqConversationListItem,
  type QqSchemeResponse,
} from "../../src/shared/contracts/qq";
import {
  mergeQqGroupScheme,
  type QqGroupConfigResponse,
  QqGroupConfigResponseSchema,
  type QqGroupSchemeOverrides,
} from "../../src/shared/contracts/qq-group-config";
import { api } from "../../src/web/api";
import { qqDraftChanges } from "../../src/web/features/qq/draft-state";
import { qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { selectLocale } from "../../src/web/i18n";
import { formatDate, i18n } from "../../src/web/i18n/runtime";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { SchemeBindingsView } from "../../src/web/screens/connections/scheme-bindings";
import { useSuperstringStore as store } from "../../src/web/store";

const ui = (key: string, values?: Record<string, unknown>) => i18n.t(key, values) as string;

const NOW = "2026-09-30T00:00:00.000Z";
const SCHEME_A = "22222222-2222-4222-8222-222222222222";
const SCHEME_B = "33333333-3333-4333-8333-333333333333";
const SCHEME_MISSING = "44444444-4444-4444-8444-444444444444";
const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BINDING_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BINDING_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: SCHEME_A,
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

const bindingOf = (
  schemeId: string,
  id: string,
  peer: string,
  kind: "group" | "private" = "group",
  agentId = AGENT_A,
): QqBindingResponse =>
  QqBindingResponseSchema.parse({
    id,
    account_id: "10001",
    kind,
    peer_id: peer,
    agent_id: agentId,
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

const conversation = (
  peer: string,
  kind: "group" | "private" = "group",
  bindingId: string | null = null,
  lastAt = 2_000_000_000,
): QqConversationListItem => ({
  account_id: "10001",
  kind,
  peer_id: peer,
  messages: 5,
  last_at_seconds: lastAt,
  binding_id: bindingId,
});

const agentOf = (id: string, name: string) =>
  AgentResponseSchema.parse({
    id,
    name,
    model_name: "model",
    config_version: 1,
    persona_intensity: 60,
    created_at: NOW,
    updated_at: NOW,
    p5_config: { recent_turns: 12 },
  });

const settings = {
  enabled: false,
  account_id: "10001",
  judgement_model_name: null,
  transport: { endpoint: null, has_token: false },
  revision: 1,
};

/** 本群配置的真实读取形状：绑定镜像 + 基础/生效方案 + 稀疏差异 + 能力停用 + 记录 revision。 */
const qqConfigOf = (
  binding: QqBindingResponse,
  overrides: QqGroupSchemeOverrides = {},
): QqGroupConfigResponse => {
  const base = scheme({ id: binding.scheme_id });
  return QqGroupConfigResponseSchema.parse({
    binding,
    base_scheme: base,
    effective_scheme: mergeQqGroupScheme(base, overrides),
    overrides,
    disabled_capabilities: [],
    revision: 0,
  });
};

function client(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    getQqSettings: vi.fn().mockResolvedValue(settings),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: SCHEME_A, bindings: 0 }),
    listQqSchemes: vi
      .fn()
      .mockResolvedValue([scheme(), scheme({ id: SCHEME_B, name: "夜间方案" })]),
    listQqBindings: vi.fn().mockResolvedValue([]),
    listQqConversations: vi.fn().mockResolvedValue([]),
    createQqBinding: vi.fn().mockResolvedValue(bindingOf(SCHEME_A, BINDING_A, "50005")),
    updateQqBinding: vi.fn().mockResolvedValue(bindingOf(SCHEME_A, BINDING_A, "30003")),
    updateQqScheme: vi.fn(),
    // 同 Agent 换方案会先真实读取本群配置再弹预览（空差异＝直接提交）；用例按需覆盖。
    getQqGroupConfig: vi
      .fn()
      .mockResolvedValue(qqConfigOf(bindingOf(SCHEME_A, BINDING_A, "30003"))),
    ...overrides,
  } as unknown as typeof api;
}

async function renderBoards(overrides: Partial<typeof api> = {}) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
    agents: [agentOf(AGENT_A, "小助手"), agentOf(AGENT_B, "夜班助手")],
  });
  render(<SchemeBindingsView schemeId={SCHEME_A} />);
  await act(async () => {});
  return { fake };
}

const openAdd = async () => {
  await userEvent.click(screen.getByRole("button", { name: ui("schemes.bindings.add") }));
  return screen.getByRole("dialog");
};

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("使用会话绑定视图", () => {
  it("只列本方案的绑定，管理入口打开 BindingEditor 且不写任何绑定", async () => {
    const { fake } = await renderBoards({
      listQqBindings: vi
        .fn()
        .mockResolvedValue([
          bindingOf(SCHEME_A, BINDING_A, "30003"),
          bindingOf(SCHEME_B, BINDING_B, "40004"),
        ]),
      listQqConversations: vi.fn().mockResolvedValue([conversation("30003", "group", BINDING_A)]),
    });
    expect(screen.getByText("30003")).toBeTruthy();
    expect(screen.queryByText("40004")).toBeNull();
    expect(screen.getByText("小助手")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: ui("connections.manage") }));
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("群 30003")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: ui("connections.saveBinding") })).toBeTruthy();
    expect(fake.updateQqBinding).not.toHaveBeenCalled();
    expect(fake.createQqBinding).not.toHaveBeenCalled();
  });

  it("读取失败停在可重试的失败态，不展示缓存旧列表", async () => {
    const listBindings = vi
      .fn()
      .mockRejectedValueOnce(new Error("目录离线"))
      .mockResolvedValue([bindingOf(SCHEME_A, BINDING_A, "30003")]);
    await renderBoards({ listQqBindings: listBindings });
    expect(screen.getByRole("alert").textContent).toContain(ui("schemes.bindings.loadFailed"));
    expect(screen.queryByText("30003")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: ui("capabilities.retry") }));
    await act(async () => {});
    expect(listBindings).toHaveBeenCalledTimes(2);
    expect(screen.getByText("30003")).toBeTruthy();
  });

  it("显式方案不在目录时不回退到第一个方案，也不展示别的绑定", async () => {
    await renderBoards({
      listQqBindings: vi
        .fn()
        .mockResolvedValue([
          bindingOf(SCHEME_A, BINDING_A, "30003"),
          bindingOf(SCHEME_B, BINDING_B, "40004"),
        ]),
    });
    cleanup();
    const fake = client({
      listQqBindings: vi
        .fn()
        .mockResolvedValue([
          bindingOf(SCHEME_A, BINDING_A, "30003"),
          bindingOf(SCHEME_B, BINDING_B, "40004"),
        ]),
    });
    store.getState().resetForTests(fake);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-scheme-config",
      agents: [agentOf(AGENT_A, "小助手")],
    });
    render(<SchemeBindingsView schemeId={SCHEME_MISSING} />);
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain(ui("schemes.bindings.schemeMissing"));
    expect(screen.queryByText("30003")).toBeNull();
    expect(screen.queryByText("40004")).toBeNull();
    expect(screen.queryByRole("button", { name: ui("schemes.bindings.add") })).toBeNull();
  });

  it("没有方案时（全局入口）先提示创建，不提供添加会话入口", async () => {
    const fake = client({ listQqSchemes: vi.fn().mockResolvedValue([]) });
    store.getState().resetForTests(fake);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "scheme-bindings",
      agents: [agentOf(AGENT_A, "小助手")],
    });
    render(<SchemesWorkspace />);
    await act(async () => {});
    expect(screen.getByText(ui("schemes.bindings.needScheme"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: ui("schemes.bindings.add") })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: ui("schemes.bindings.createFirst") }));
    expect(store.getState().settingsRoute).toBe("scheme-library");
  });

  it("按号码、Agent 搜索并可按群/私聊筛选，最近消息按观察行显示", async () => {
    await renderBoards({
      listQqBindings: vi
        .fn()
        .mockResolvedValue([
          bindingOf(SCHEME_A, BINDING_A, "30003"),
          bindingOf(SCHEME_A, BINDING_B, "20002", "private", AGENT_B),
        ]),
      listQqConversations: vi
        .fn()
        .mockResolvedValue([
          conversation("30003", "group", BINDING_A, 2_000_000_000),
          conversation("20002", "private", null, 0),
        ]),
    });
    expect(screen.getByText("30003")).toBeTruthy();
    expect(screen.getByText("20002")).toBeTruthy();
    // 最近消息：有观察行显示时间；没有观察行如实标注。
    expect(screen.getByText(ui("connections.latestMessage"), { exact: false })).toBeTruthy();
    expect(
      screen.getByText(
        `${ui("connections.latestMessage")} ${formatDate(2_000_000_000 * 1000, i18n.language, {
          dateStyle: "short",
          timeStyle: "short",
        })}`,
      ),
    ).toBeTruthy();
    expect(screen.getAllByText(ui("connections.nothingObservedYet")).length).toBe(1);
    const kindFilter = screen.getByLabelText(ui("connections.conversationType"));
    fireEvent.change(kindFilter, { target: { value: "private" } });
    expect(screen.queryByText("30003")).toBeNull();
    expect(screen.getByText("20002")).toBeTruthy();
    fireEvent.change(kindFilter, { target: { value: "all" } });
    const search = screen.getByLabelText(ui("connections.searchConversationBindings"));
    fireEvent.change(search, { target: { value: "夜班" } });
    expect(screen.queryByText("30003")).toBeNull();
    expect(screen.getByText("20002")).toBeTruthy();
    fireEvent.change(search, { target: { value: "不存在" } });
    expect(screen.getByText(ui("connections.noMatchingConversations"))).toBeTruthy();
  });
});

describe("添加会话", () => {
  it("默认预选当前方案、Agent 必须显式选择，绑定已观察未绑定行走原绑定通道", async () => {
    const { fake } = await renderBoards({
      listQqConversations: vi.fn().mockResolvedValue([conversation("50005")]),
    });
    const dialog = await openAdd();
    const schemeSelect = within(dialog).getByLabelText(
      ui("connections.schemes"),
    ) as HTMLSelectElement;
    expect(schemeSelect.value).toBe(SCHEME_A);
    const agentSelect = within(dialog).getByLabelText(
      ui("connections.assistant"),
    ) as HTMLSelectElement;
    expect(agentSelect.value).toBe("");
    const bind = within(dialog).getByRole("button", {
      name: ui("connections.bind"),
    }) as HTMLButtonElement;
    expect(bind.disabled).toBe(true);

    const picker = within(dialog).getByLabelText(ui("schemes.bindings.pickConversation"));
    await userEvent.selectOptions(picker, "10001:group:50005");
    await userEvent.selectOptions(agentSelect, AGENT_A);
    expect(bind.disabled).toBe(false);
    await userEvent.click(bind);
    await act(async () => {});
    expect(fake.createQqBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "10001",
        kind: "group",
        peer_id: "50005",
        agent_id: AGENT_A,
        scheme_id: SCHEME_A,
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // 成功才清目标草稿。
    expect(store.getState().qqInputs.manualPeer).toBe("");
    expect(store.getState().qqInputs.manualPicked).toBe("");
  });

  it("手工号码支持原号码绑定，失败保留对话框与输入，成功才清草稿", async () => {
    const { fake } = await renderBoards({
      createQqBinding: vi
        .fn()
        .mockRejectedValueOnce(new Error("bind failed"))
        .mockResolvedValue(bindingOf(SCHEME_A, BINDING_A, "60006")),
    });
    let dialog = await openAdd();
    const number = within(dialog).getByLabelText(ui("connections.number")) as HTMLInputElement;
    fireEvent.change(number, { target: { value: "60006" } });
    const agentSelect = within(dialog).getByLabelText(
      ui("connections.assistant"),
    ) as HTMLSelectElement;
    await userEvent.selectOptions(agentSelect, AGENT_B);
    await userEvent.click(within(dialog).getByRole("button", { name: ui("connections.bind") }));
    await act(async () => {});
    expect(fake.createQqBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "10001",
        kind: "group",
        peer_id: "60006",
        agent_id: AGENT_B,
        scheme_id: SCHEME_A,
      }),
    );
    // 失败：对话框、输入与草稿都还在。
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("alert").textContent).toContain("bind failed");
    expect(
      (within(dialog).getByLabelText(ui("connections.number")) as HTMLInputElement).value,
    ).toBe("60006");
    expect(store.getState().qqInputs.manualPeer).toBe("60006");
    expect(store.getState().qqInputs.manualAgentId).toBe(AGENT_B);
    // 重试成功后才关闭并清草稿。
    await userEvent.click(within(dialog).getByRole("button", { name: ui("connections.bind") }));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.createQqBinding).toHaveBeenCalledTimes(2);
    expect(store.getState().qqInputs.manualPeer).toBe("");
    expect(store.getState().qqInputs.manualAgentId).toBe("");
  });

  it("关闭与取消都不提交也不丢草稿：重开后目标与 Agent 仍在，守卫按解析结果列行", async () => {
    await renderBoards({
      listQqConversations: vi.fn().mockResolvedValue([conversation("50005")]),
    });
    let dialog = await openAdd();
    // 打开即预选当前方案，但不产生脏草稿。
    expect(store.getState().qqInputs.manualSchemeId).toBe(SCHEME_A);
    expect(qqDraftChanges(store.getState())).toEqual([]);
    fireEvent.change(within(dialog).getByLabelText(ui("connections.number")), {
      target: { value: "60006" },
    });
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.assistant")),
      AGENT_B,
    );
    await userEvent.click(within(dialog).getByRole("button", { name: ui("connections.cancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.getState().qqInputs.manualPeer).toBe("60006");
    const rows = qqDraftChanges(store.getState());
    expect(rows.map((row) => row.id)).toEqual(["manual-binding"]);
    expect(rows[0]?.resource).toContain("60006");
    const changes = rows[0]?.changes.join("\n") ?? "";
    expect(changes).toContain("60006");
    expect(changes).toContain(AGENT_B);
    expect(changes).toContain(SCHEME_A);
    // 重开（含观察行选择）草稿仍在。
    dialog = await openAdd();
    expect(
      (within(dialog).getByLabelText(ui("connections.number")) as HTMLInputElement).value,
    ).toBe("60006");
    expect(
      (within(dialog).getByLabelText(ui("connections.assistant")) as HTMLSelectElement).value,
    ).toBe(AGENT_B);
  });

  it("观察行选中同样落在草稿里，重开后按该目标绑定", async () => {
    const { fake } = await renderBoards({
      listQqConversations: vi.fn().mockResolvedValue([conversation("50005")]),
    });
    let dialog = await openAdd();
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("schemes.bindings.pickConversation")),
      "10001:group:50005",
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.assistant")),
      AGENT_A,
    );
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.getState().qqInputs.manualPicked).toBe("10001:group:50005");
    expect(qqDraftChanges(store.getState())[0]?.changes.join("\n")).toContain("50005");
    dialog = await openAdd();
    expect(
      (within(dialog).getByLabelText(ui("schemes.bindings.pickConversation")) as HTMLSelectElement)
        .value,
    ).toBe("10001:group:50005");
    await userEvent.click(within(dialog).getByRole("button", { name: ui("connections.bind") }));
    await act(async () => {});
    expect(fake.createQqBinding).toHaveBeenCalledWith(
      expect.objectContaining({ peer_id: "50005", agent_id: AGENT_A, scheme_id: SCHEME_A }),
    );
    expect(store.getState().qqInputs.manualPicked).toBe("");
  });

  it("已绑定其他方案的会话只指出位置并给管理入口，不静默覆盖或搬走", async () => {
    const { fake } = await renderBoards({
      listQqBindings: vi.fn().mockResolvedValue([bindingOf(SCHEME_B, BINDING_B, "40004")]),
      listQqConversations: vi
        .fn()
        .mockResolvedValue([conversation("40004", "group", BINDING_B), conversation("50005")]),
    });
    const dialog = await openAdd();
    const picker = within(dialog).getByLabelText(ui("schemes.bindings.pickConversation"));
    await userEvent.selectOptions(picker, "10001:group:40004");
    expect(
      within(dialog).getByText(ui("schemes.bindings.boundElsewhere", { "0": "夜间方案" })),
    ).toBeTruthy();
    const agentSelect = within(dialog).getByLabelText(
      ui("connections.assistant"),
    ) as HTMLSelectElement;
    await userEvent.selectOptions(agentSelect, AGENT_A);
    expect(
      (
        within(dialog).getByRole("button", {
          name: ui("connections.bind"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(fake.createQqBinding).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: ui("schemes.bindings.manageExisting") }),
    );
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: ui("connections.saveBinding") })).toBeTruthy();
    expect(fake.updateQqBinding).not.toHaveBeenCalled();
    expect(qqDraftChanges(store.getState())).toEqual([]);
  });

  it("已选观察行消失时保留目标但不回退到手工号码提交", async () => {
    const { fake } = await renderBoards({
      listQqConversations: vi.fn().mockResolvedValue([conversation("50005")]),
    });
    const dialog = await openAdd();
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("schemes.bindings.pickConversation")),
      "10001:group:50005",
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.assistant")),
      AGENT_A,
    );
    act(() => store.setState({ qqConversations: [] }));
    expect(
      (within(dialog).getByRole("button", { name: ui("connections.bind") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(qqDraftChanges(store.getState())[0]?.changes.join("\n")).toContain("50005");
    expect(await store.getState().saveQqDrafts()).toBe(false);
    expect(fake.createQqBinding).not.toHaveBeenCalled();
    expect(store.getState().qqInputs.manualPicked).toBe("10001:group:50005");
  });

  it("添加草稿的方案失效时不静默改绑到入口方案", async () => {
    const { fake } = await renderBoards();
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText(ui("connections.number")), {
      target: { value: "60006" },
    });
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.assistant")),
      AGENT_A,
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.schemes")),
      SCHEME_B,
    );
    act(() => store.setState({ qqSchemes: [scheme()] }));
    expect(
      (within(dialog).getByLabelText(ui("connections.schemes")) as HTMLSelectElement).value,
    ).toBe(SCHEME_B);
    expect(
      (within(dialog).getByRole("button", { name: ui("connections.bind") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(fake.createQqBinding).not.toHaveBeenCalled();
    expect(store.getState().qqInputs.manualSchemeId).toBe(SCHEME_B);
  });

  it("手工号码撞上已有绑定时同样不覆盖", async () => {
    await renderBoards({
      listQqBindings: vi.fn().mockResolvedValue([bindingOf(SCHEME_B, BINDING_B, "40004")]),
    });
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText(ui("connections.number")), {
      target: { value: "40004" },
    });
    expect(
      within(dialog).getByText(ui("schemes.bindings.boundElsewhere", { "0": "夜间方案" })),
    ).toBeTruthy();
  });
});

describe("草稿的保存与放弃", () => {
  it("缺 Agent 时保存并继续原地失败：不写绑定、不改路由、草稿保留；放弃才清", async () => {
    const { fake } = await renderBoards();
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText(ui("connections.number")), {
      target: { value: "60006" },
    });
    await userEvent.click(within(dialog).getByRole("button", { name: ui("connections.cancel") }));
    store.getState().openSettingsRoute("qq-stickers");
    expect(store.getState().navigationConfirmOpen).toBe(true);
    await store.getState().confirmSaveAndContinue();
    expect(fake.createQqBinding).not.toHaveBeenCalled();
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
    expect(store.getState().qqInputs.manualPeer).toBe("60006");
    expect(store.getState().error).toBeTruthy();
    // 补齐 Agent 后保存并继续成功落地并清草稿。
    store.setState((state) => ({
      qqInputs: { ...state.qqInputs, manualAgentId: AGENT_A },
    }));
    await store.getState().confirmSaveAndContinue();
    expect(fake.createQqBinding).toHaveBeenCalledWith(
      expect.objectContaining({ peer_id: "60006", agent_id: AGENT_A, scheme_id: SCHEME_A }),
    );
    expect(store.getState().settingsRoute).toBe("qq-stickers");
    expect(store.getState().qqInputs.manualPeer).toBe("");
    expect(store.getState().qqInputs.manualAgentId).toBe("");
  });

  it("放弃确实清掉手工草稿与观察选中目标", async () => {
    await renderBoards({
      listQqConversations: vi.fn().mockResolvedValue([conversation("50005")]),
    });
    const dialog = await openAdd();
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("schemes.bindings.pickConversation")),
      "10001:group:50005",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: ui("connections.cancel") }));
    expect(qqDraftChanges(store.getState()).length).toBe(1);
    store.getState().openSettingsRoute("qq-stickers");
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().settingsRoute).toBe("qq-stickers");
    expect(store.getState().qqInputs.manualPeer).toBe("");
    expect(store.getState().qqInputs.manualPicked).toBe("");
    expect(store.getState().qqInputs.manualAgentId).toBe("");
    expect(qqDraftChanges(store.getState())).toEqual([]);
  });

  it("私聊更换方案沿用绑定保存，不读取群聊专属配置", async () => {
    const row = bindingOf(SCHEME_A, BINDING_A, "30003", "private");
    const { fake } = await renderBoards({
      listQqBindings: vi.fn().mockResolvedValue([row]),
      listQqConversations: vi.fn().mockResolvedValue([conversation("30003", "private", BINDING_A)]),
      getQqGroupConfig: vi.fn().mockRejectedValue(new Error("GROUP_ONLY")),
    });
    await userEvent.click(screen.getByRole("button", { name: ui("connections.manage") }));
    const sheet = screen.getByRole("dialog");
    await userEvent.selectOptions(
      within(sheet).getByLabelText(ui("connections.schemes")),
      SCHEME_B,
    );
    await userEvent.click(
      within(sheet).getByRole("button", { name: ui("connections.saveBinding") }),
    );
    await act(async () => {});
    expect(fake.getQqGroupConfig).not.toHaveBeenCalled();
    expect(fake.updateQqBinding).toHaveBeenCalledWith(BINDING_A, {
      agent_id: AGENT_A,
      scheme_id: SCHEME_B,
      expected_revision: 1,
    });
  });

  it("在编辑里选择另一方案改绑正常保存，且不夹带方案草稿", async () => {
    const { fake } = await renderBoards({
      listQqBindings: vi.fn().mockResolvedValue([bindingOf(SCHEME_A, BINDING_A, "30003")]),
      listQqConversations: vi.fn().mockResolvedValue([conversation("30003", "group", BINDING_A)]),
      // 目标方案带本群覆盖：保存先真实读取本群配置，由用户在预览里显式决定保留/重置。
      getQqGroupConfig: vi.fn().mockResolvedValue(
        qqConfigOf(bindingOf(SCHEME_A, BINDING_A, "30003"), {
          context: { reply_token_budget: 8000 },
        }),
      ),
    });
    // 详情里另有未保存的方案草稿：绑定保存不得顺带提交它。
    const draft = qqSchemeEditorFrom(scheme());
    draft.name = "改过的方案名";
    act(() => store.setState({ qqSchemeEditor: draft }));
    await userEvent.click(screen.getByRole("button", { name: ui("connections.manage") }));
    const sheet = screen.getByRole("dialog");
    const schemeSelect = within(sheet).getByLabelText(
      ui("connections.schemes"),
    ) as HTMLSelectElement;
    const previewTitle = ui("schemes.qq.groupConfig.scheme.confirmTitle", { "0": "夜间方案" });
    await userEvent.selectOptions(schemeSelect, SCHEME_B);
    await userEvent.click(
      within(sheet).getByRole("button", { name: ui("connections.saveBinding") }),
    );
    // 取消：不写任何绑定，草稿与目标都原样保留。
    const preview = await screen.findByRole("dialog", { name: previewTitle });
    await userEvent.click(within(preview).getByRole("button", { name: ui("connections.cancel") }));
    await act(async () => {});
    expect(fake.updateQqBinding).not.toHaveBeenCalled();
    expect(fake.getQqGroupConfig).toHaveBeenCalledTimes(1);
    // 重新保存并选择「保留本群自定义」：显式决定随同一 PUT 提交。
    await userEvent.click(
      within(sheet).getByRole("button", { name: ui("connections.saveBinding") }),
    );
    const keepPreview = await screen.findByRole("dialog", { name: previewTitle });
    await userEvent.click(
      within(keepPreview).getByRole("button", {
        name: ui("schemes.qq.groupConfig.scheme.keepLabel"),
      }),
    );
    await act(async () => {});
    expect(fake.updateQqBinding).toHaveBeenNthCalledWith(1, BINDING_A, {
      agent_id: AGENT_A,
      scheme_id: SCHEME_B,
      scheme_change: "keep",
      expected_revision: 1,
    });
    // 同一入口再次选择并「全部跟随新方案」：第二个显式决定同样如实提交。
    await userEvent.selectOptions(schemeSelect, SCHEME_B);
    await userEvent.click(
      within(sheet).getByRole("button", { name: ui("connections.saveBinding") }),
    );
    const resetPreview = await screen.findByRole("dialog", { name: previewTitle });
    await userEvent.click(
      within(resetPreview).getByRole("button", {
        name: ui("schemes.qq.groupConfig.scheme.resetLabel"),
      }),
    );
    await act(async () => {});
    expect(fake.updateQqBinding).toHaveBeenNthCalledWith(2, BINDING_A, {
      agent_id: AGENT_A,
      scheme_id: SCHEME_B,
      scheme_change: "reset",
      expected_revision: 1,
    });
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(store.getState().qqSchemeEditor?.name).toBe("改过的方案名");
  });
});

describe("刷新保存基线", () => {
  it("真实 409 后刷新：已选改绑保留，同一草稿以新 revision 重试成功", async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("绑定已被其他窗口修改"))
      .mockResolvedValue(
        QqBindingResponseSchema.parse({ ...bindingOf(SCHEME_B, BINDING_A, "30003"), revision: 9 }),
      );
    const list = vi
      .fn()
      .mockResolvedValueOnce([bindingOf(SCHEME_A, BINDING_A, "30003")])
      .mockResolvedValue([
        QqBindingResponseSchema.parse({ ...bindingOf(SCHEME_A, BINDING_A, "30003"), revision: 9 }),
      ]);
    const { fake } = await renderBoards({ listQqBindings: list, updateQqBinding: update });
    await userEvent.click(screen.getByRole("button", { name: ui("connections.manage") }));
    let sheet = screen.getByRole("dialog");
    await userEvent.selectOptions(
      within(sheet).getByLabelText(ui("connections.schemes")),
      SCHEME_B,
    );
    await userEvent.click(
      within(sheet).getByRole("button", { name: ui("connections.saveBinding") }),
    );
    await act(async () => {});
    // 真实 409：草稿还在，但保存继续用旧 revision。
    expect(fake.updateQqBinding).toHaveBeenNthCalledWith(1, BINDING_A, {
      agent_id: AGENT_A,
      scheme_id: SCHEME_B,
      expected_revision: 1,
    });
    expect(store.getState().qqInputs.choices[BINDING_A]?.source?.revision).toBe(1);
    // 抽屉里的「刷新保存基线」：草稿不丢，baseline 推进。
    await userEvent.click(
      screen.getByRole("button", { name: ui("capabilities.resources.refreshBaseline") }),
    );
    await act(async () => {});
    sheet = await screen.findByRole("dialog");
    expect(
      (within(sheet).getByLabelText(ui("connections.schemes")) as HTMLSelectElement).value,
    ).toBe(SCHEME_B);
    // 刷新只重建基线：不自动提交，反馈说明草稿仍待用户核对保存。
    expect(fake.updateQqBinding).toHaveBeenCalledTimes(1);
    expect(store.getState().feedback).toContain("刷新不提交草稿");
    // 同一已选改绑再次保存：以刷新后的 revision 通过 CAS。
    await userEvent.click(
      within(sheet).getByRole("button", { name: ui("connections.saveBinding") }),
    );
    await act(async () => {});
    expect(fake.updateQqBinding).toHaveBeenNthCalledWith(2, BINDING_A, {
      agent_id: AGENT_A,
      scheme_id: SCHEME_B,
      expected_revision: 9,
    });
  });

  it("刷新保存基线失败：目录按未知呈现，已选改绑与旧基线原样保留", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([bindingOf(SCHEME_A, BINDING_A, "30003")])
      .mockRejectedValueOnce(new Error("REFRESH_DOWN"))
      .mockResolvedValue([bindingOf(SCHEME_A, BINDING_A, "30003")]);
    const { fake } = await renderBoards({
      listQqBindings: list,
      updateQqBinding: vi.fn().mockRejectedValue(new Error("绑定已被其他窗口修改")),
    });
    await userEvent.click(screen.getByRole("button", { name: ui("connections.manage") }));
    const sheet = screen.getByRole("dialog");
    await userEvent.selectOptions(
      within(sheet).getByLabelText(ui("connections.schemes")),
      SCHEME_B,
    );
    await userEvent.click(
      within(sheet).getByRole("button", { name: ui("connections.saveBinding") }),
    );
    await act(async () => {});
    await userEvent.click(
      screen.getByRole("button", { name: ui("capabilities.resources.refreshBaseline") }),
    );
    await act(async () => {});
    // 刷新失败：不拿缓存列表继续，草稿与旧 revision 原样保留。
    await screen.findByText(ui("schemes.bindings.loadFailed"));
    expect(store.getState().qqBindingsLoaded).toBe(false);
    expect(store.getState().qqInputs.choices[BINDING_A]?.schemeId).toBe(SCHEME_B);
    expect(store.getState().qqInputs.choices[BINDING_A]?.source?.revision).toBe(1);
    // 重试读取恢复目录并重开抽屉，但隐式读取绝不自动推进保存基线。
    await userEvent.click(screen.getByRole("button", { name: ui("capabilities.retry") }));
    await act(async () => {});
    const reopened = await screen.findByRole("dialog");
    expect(
      (within(reopened).getByLabelText(ui("connections.schemes")) as HTMLSelectElement).value,
    ).toBe(SCHEME_B);
    expect(store.getState().qqInputs.choices[BINDING_A]?.source?.revision).toBe(1);
    expect(fake.updateQqBinding).toHaveBeenCalledTimes(1);
  });
});

describe("scheme-bindings 路由", () => {
  it("先选方案，再显示该方案的绑定；切方案保留未保存的添加草稿目标", async () => {
    const fake = client({
      listQqBindings: vi
        .fn()
        .mockResolvedValue([
          bindingOf(SCHEME_A, BINDING_A, "30003"),
          bindingOf(SCHEME_B, BINDING_B, "40004"),
        ]),
    });
    store.getState().resetForTests(fake);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "scheme-bindings",
      agents: [agentOf(AGENT_A, "小助手")],
    });
    render(<SchemesWorkspace />);
    await act(async () => {});
    expect(screen.getByText("30003")).toBeTruthy();
    expect(screen.queryByText("40004")).toBeNull();
    const picker = screen.getByLabelText(ui("schemes.bindings.chooseScheme"));
    // 先为一个方案写下手工草稿再关闭，切换查看方案不隐式改写草稿目标。
    await userEvent.click(screen.getByRole("button", { name: ui("schemes.bindings.add") }));
    let addDialog = screen.getByRole("dialog");
    fireEvent.change(within(addDialog).getByLabelText(ui("connections.number")), {
      target: { value: "60006" },
    });
    await userEvent.click(
      within(addDialog).getByRole("button", { name: ui("connections.cancel") }),
    );
    await userEvent.selectOptions(picker, SCHEME_B);
    expect(screen.getByText("40004")).toBeTruthy();
    expect(screen.queryByText("30003")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: ui("schemes.bindings.add") }));
    addDialog = screen.getByRole("dialog");
    expect(
      (within(addDialog).getByLabelText(ui("connections.schemes")) as HTMLSelectElement).value,
    ).toBe(SCHEME_A);
    expect(
      (within(addDialog).getByLabelText(ui("connections.number")) as HTMLInputElement).value,
    ).toBe("60006");
  });
});

describe("连接页", () => {
  const renderConnection = async (overrides: Partial<typeof api> = {}) => {
    const fake = client({
      getQqStatus: vi.fn().mockResolvedValue({ connection: null }),
      ...overrides,
    });
    store.getState().resetForTests(fake);
    store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "qq-connection" });
    render(<SchemesWorkspace />);
    await act(async () => {});
    return fake;
  };

  it("读取失败不永远停在 loading：给出可重试入口，重试成功后显示连接表单", async () => {
    const getSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("settings down"))
      .mockResolvedValue(settings);
    await renderConnection({ getQqSettings: getSettings });
    expect(
      screen
        .getAllByRole("alert")
        .some((node) => node.textContent?.includes(ui("connections.accessStateFailed"))),
    ).toBe(true);
    expect(screen.queryByText(ui("connections.readingTheAccessState"))).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: ui("capabilities.retry") }));
    await act(async () => {});
    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText(ui("connections.websocketAddress"))).toBeTruthy();
  });

  it("页首刷新重读设置与状态，保留已改字段并推进 revision", async () => {
    const getSettings = vi.fn().mockResolvedValue(settings);
    const getStatus = vi.fn().mockResolvedValue({ connection: null });
    await renderConnection({ getQqSettings: getSettings, getQqStatus: getStatus });
    const endpoint = screen.getByLabelText(ui("connections.websocketAddress")) as HTMLInputElement;
    fireEvent.change(endpoint, { target: { value: "ws://localhost:4000" } });
    getSettings.mockResolvedValue({
      ...settings,
      revision: 8,
      transport: { endpoint: "ws://elsewhere", has_token: true },
    });
    await userEvent.click(screen.getByRole("button", { name: ui("connections.refreshState") }));
    await act(async () => {});
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(
      (screen.getByLabelText(ui("connections.websocketAddress")) as HTMLInputElement).value,
    ).toBe("ws://localhost:4000");
    expect(store.getState().qqSettings?.revision).toBe(8);
    expect(store.getState().qqInputs.connection?.source.revision).toBe(8);
  });

  it("保存失败的原因只显示一次（页首与表单不重复）", async () => {
    await renderConnection({
      updateQqSettings: vi.fn().mockRejectedValue(new Error("TRANSPORT_FAIL_X")),
    });
    fireEvent.change(screen.getByLabelText(ui("connections.websocketAddress")), {
      target: { value: "ws://localhost:4000" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: ui("connections.saveAccessSettings") }),
    );
    await act(async () => {});
    expect(store.getState().error).toContain("TRANSPORT_FAIL_X");
    expect(
      screen.getAllByRole("alert").filter((node) => node.textContent?.includes("TRANSPORT_FAIL_X"))
        .length,
    ).toBe(1);
    expect(
      (screen.getByLabelText(ui("connections.websocketAddress")) as HTMLInputElement).value,
    ).toBe("ws://localhost:4000");
  });
});

describe("性能阶段补测：窄订阅行为保持（FE-P1）", () => {
  it("与本页无关的 store 更新不重渲染绑定视图；本页读取字段更新仍正常刷新", async () => {
    await renderBoards({
      listQqBindings: vi.fn().mockResolvedValue([bindingOf(SCHEME_A, BINDING_A, "30003")]),
      listQqConversations: vi.fn().mockResolvedValue([]),
    });
    expect(screen.getByText("30003")).toBeTruthy();
    // 无关更新：notice 不是本页读取字段 → 窄订阅不得引发重渲染。
    const textBefore = document.querySelector("ul")?.textContent ?? "";
    await act(async () => {
      store.setState({ memoryCorrectionSaving: true });
    });
    expect(document.querySelector("ul")?.textContent ?? "").toBe(textBefore);
    // 本页读取字段更新：绑定目录变化 → 行列表必须反映新值（不能因窄订阅漏刷新）。
    const refreshed = [
      bindingOf(SCHEME_A, BINDING_A, "30003"),
      bindingOf(SCHEME_A, BINDING_B, "30004"),
    ];
    await act(async () => {
      store.setState({ qqBindings: refreshed });
    });
    expect(screen.getByText("30003")).toBeTruthy();
    expect(screen.getByText("30004")).toBeTruthy();
  });
});
