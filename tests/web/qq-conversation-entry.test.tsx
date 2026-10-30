import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema } from "../../src/shared/contracts";
import {
  type QqBindingResponse,
  QqBindingResponseSchema,
  type QqConversationListItem,
  type QqSchemeResponse,
} from "../../src/shared/contracts/qq";
import { ApiError, api } from "../../src/web/api";
import { qqDraftChanges } from "../../src/web/features/qq/draft-state";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { QqConversationEntry } from "../../src/web/screens/connections/QqConversationEntry";
import { ConversationEntryButton } from "../../src/web/screens/conversations/ConversationEntryButton";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

const ui = (key: string, values?: Record<string, unknown>) => i18n.t(key, values) as string;

const NOW = "2026-10-20T00:00:00.000Z";
const SCHEME_A = "22222222-2222-4222-8222-222222222222";
const SCHEME_B = "33333333-3333-4333-8333-333333333333";
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
    task_limits: { mention_task_limit: null, ordinary_task_limit: null },
    input_anti_spam: {
      enabled: null,
      burst_min_messages: null,
      burst_window_seconds: null,
    },
  });

const conversation = (
  peer: string,
  kind: "group" | "private" = "group",
  bindingId: string | null = null,
): QqConversationListItem => ({
  account_id: "10001",
  kind,
  peer_id: peer,
  messages: 5,
  last_at_seconds: 2_000_000_000,
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

/** 未启用、已配置账号：入口只能读目录，不能自动开启、共享或发送。 */
const settings = {
  enabled: false,
  account_id: "10001",
  judgement_model_name: null,
  transport: { endpoint: null, has_token: false },
  revision: 1,
};

function client(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    getQqSettings: vi.fn().mockResolvedValue(settings),
    listConversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: SCHEME_A, bindings: 0 }),
    listQqSchemes: vi
      .fn()
      .mockResolvedValue([scheme(), scheme({ id: SCHEME_B, name: "夜间方案" })]),
    listQqBindings: vi.fn().mockResolvedValue([]),
    listQqConversations: vi
      .fn()
      .mockResolvedValue([conversation("50005", "group"), conversation("60006", "private")]),
    createQqBinding: vi.fn().mockResolvedValue(bindingOf(SCHEME_A, BINDING_A, "50005")),
    updateQqBinding: vi.fn(),
    updateQqSettings: vi.fn(),
    updateQqTransport: vi.fn(),
    ...overrides,
  } as unknown as typeof api;
}

const qqReads = (fake: ReturnType<typeof client>) => [
  fake.getQqSettings,
  fake.listQqConversations,
  fake.listQqBindings,
  fake.listQqSchemes,
];

const expectNoQqReads = (fake: ReturnType<typeof client>) => {
  for (const read of qqReads(fake)) expect(read).not.toHaveBeenCalled();
};

const expectNoQqWrites = (fake: ReturnType<typeof client>) => {
  for (const write of [
    fake.createQqBinding,
    fake.updateQqBinding,
    fake.updateQqSettings,
    fake.updateQqTransport,
  ])
    expect(write).not.toHaveBeenCalled();
};

function setUp(overrides: Partial<typeof api> = {}) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({ agents: [agentOf(AGENT_A, "小助手"), agentOf(AGENT_B, "夜班助手")] });
  return fake;
}

/** 受控宿主：模拟菜单/详情页把 open 交给入口，取消时能真正关闭。 */
function Host({
  initialKind,
  schemeId = null,
}: {
  initialKind: "group" | "private";
  schemeId?: string | null;
}) {
  const [open, setOpen] = useState(true);
  return (
    <QqConversationEntry
      schemeId={schemeId}
      initialKind={initialKind}
      open={open}
      showTrigger={false}
      onOpenChange={setOpen}
    />
  );
}

const settle = async () => {
  await act(async () => {});
};

const openDialog = async () => {
  const dialog = await screen.findByRole("dialog");
  await settle();
  return dialog;
};

const addMenuItems = async () => {
  await userEvent.click(screen.getByRole("button", { name: ui("conversation.entry.trigger") }));
  const menu = await screen.findByRole("menu");
  return within(menu).getAllByRole("menuitem");
};

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("会话新建入口的打开边界", () => {
  it("菜单三项；菜单、隐藏入口与网页创建都不读 QQ 目录", async () => {
    const fake = setUp();
    render(
      <>
        <ConversationEntryButton />
        <QqConversationEntry
          initialKind="group"
          open={false}
          showTrigger={false}
          onOpenChange={() => {}}
        />
      </>,
    );
    expectNoQqReads(fake);
    const items = await addMenuItems();
    expect(items).toHaveLength(3);
    expectNoQqReads(fake);
    // 第一项是网页新建：沿用现有对话框，不触发任何 QQ 目录读取。
    await userEvent.click(items[0]);
    expect(
      await screen.findByRole("dialog", { name: ui("workspace.start_a_new_conversation") }),
    ).toBeTruthy();
    expectNoQqReads(fake);
    expectNoQqWrites(fake);
  });

  it("选择 QQ 群聊后才经现有目录读四个 GET 各一次，不写任何设置", async () => {
    const fake = setUp();
    render(<ConversationEntryButton />);
    const items = await addMenuItems();
    await userEvent.click(items[1]);
    await openDialog();
    await waitFor(() => expect(fake.listQqBindings).toHaveBeenCalledTimes(1));
    for (const read of qqReads(fake)) expect(read).toHaveBeenCalledTimes(1);
    expect(store.getState().qqBindingsLoaded).toBe(true);
    expect(store.getState().qqInputs.manualKind).toBe("group");
    expectNoQqWrites(fake);
  });
});

describe("QQ 入口搜索说明与筛选", () => {
  it.each([
    ["zh-CN", "名称或号码"],
    ["en", "Name or number"],
  ] as const)("%s 保留字段名称和完整可访问说明", async (locale, placeholder) => {
    selectLocale(locale);
    setUp();
    render(<Host initialKind="group" />);
    const dialog = await openDialog();
    const search = await within(dialog).findByRole("textbox", {
      name: ui("qq.entry.search"),
      description: ui("qq.entry.searchHint"),
    });
    expect(search.getAttribute("placeholder")).toBe(placeholder);
    expect(search.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("按名称或号码筛选，保留选中项并在切换类型时清空查询", async () => {
    const binding = bindingOf(SCHEME_A, BINDING_A, "50005");
    setUp({
      listQqBindings: vi.fn().mockResolvedValue([binding]),
      listQqConversations: vi
        .fn()
        .mockResolvedValue([
          conversation("50005", "group", BINDING_A),
          conversation("50006", "group"),
          conversation("60006", "private"),
        ]),
    });
    render(<Host initialKind="group" />);
    const dialog = await openDialog();
    const search = await within(dialog).findByRole("textbox", { name: ui("qq.entry.search") });
    const picker = within(dialog).getByLabelText(
      ui("schemes.bindings.pickConversation"),
    ) as HTMLSelectElement;
    act(() => {
      store.setState((state) => ({
        summaryById: {
          ...state.summaryById,
          searchFixture: {
            id: "searchFixture",
            channel: "onebot11",
            topology: "direct",
            sourceId: BINDING_A,
            agentId: AGENT_A,
            bindingEpoch: 1,
            title: "Alpha Group",
            participants: [],
            updatedAt: NOW,
            lastSeq: 0,
            consumedSeq: 0,
          },
        },
      }));
    });
    const values = () => Array.from(picker.options).map((option) => option.value);
    await userEvent.type(search, "alpha");
    expect(values()).toContain("10001:group:50005");
    expect(values()).not.toContain("10001:group:50006");
    expect(values()).not.toContain("10001:private:60006");
    await userEvent.selectOptions(picker, "10001:group:50005");
    await userEvent.clear(search);
    await userEvent.type(search, "50006");
    expect(values()).toContain("10001:group:50005");
    expect(values()).toContain("10001:group:50006");
    await userEvent.clear(search);
    expect(values()).toContain("10001:group:50005");
    expect(values()).toContain("10001:group:50006");
    await userEvent.type(search, "50006");
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.conversationType")),
      "private",
    );
    expect((search as HTMLInputElement).value).toBe("");
    expect(values()).toContain("10001:private:60006");
    expect(values()).not.toContain("10001:group:50005");
    expect(store.getState().qqInputs.manualPicked).toBe("");
    expect(within(dialog).getByLabelText(ui("qq.entry.privateNumber"))).toBeTruthy();
  });
});

describe("QQ 入口的草稿语义", () => {
  it("群/私聊只预填 qqInputs；已有手工目标不被改写，取消后草稿原样保留", async () => {
    setUp();
    const first = render(<Host initialKind="private" schemeId={SCHEME_A} />);
    await openDialog();
    await waitFor(() => expect(store.getState().qqInputs.manualKind).toBe("private"));
    expect(store.getState().qqInputs.manualSchemeId).toBe(SCHEME_A);
    first.unmount();

    // 已有目标（群 + 号码 + Agent + 方案）时，私聊入口不得把类型或方案改成自己的值。
    store.setState((state) => ({
      qqInputs: {
        ...state.qqInputs,
        manualKind: "group",
        manualPeer: "60006",
        manualAgentId: AGENT_B,
        manualSchemeId: SCHEME_B,
      },
    }));
    render(<Host initialKind="private" schemeId={SCHEME_A} />);
    await openDialog();
    expect(store.getState().qqInputs).toMatchObject({
      manualKind: "group",
      manualPeer: "60006",
      manualAgentId: AGENT_B,
      manualSchemeId: SCHEME_B,
    });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(store.getState().qqInputs).toMatchObject({
      manualKind: "group",
      manualPeer: "60006",
      manualAgentId: AGENT_B,
      manualSchemeId: SCHEME_B,
    });
    const manualRow = qqDraftChanges(store.getState()).find((row) => row.id === "manual-binding");
    expect(manualRow?.changes.join("\n")).toContain("60006");
  });

  it("已观察会话按类型筛选；选中与手工号码都只写现有 qqInputs", async () => {
    const fake = setUp();
    const first = render(<Host initialKind="group" schemeId={SCHEME_A} />);
    let dialog = await openDialog();
    await waitFor(() => expect(fake.listQqConversations).toHaveBeenCalled());
    const picker = within(dialog).getByLabelText(
      ui("schemes.bindings.pickConversation"),
    ) as HTMLSelectElement;
    const groupValues = Array.from(picker.options).map((option) => option.value);
    expect(groupValues).toContain("10001:group:50005");
    expect(groupValues).not.toContain("10001:private:60006");
    await userEvent.selectOptions(picker, "10001:group:50005");
    expect(store.getState().qqInputs.manualPicked).toBe("10001:group:50005");
    first.unmount();
    // 换私聊入口前清掉已观察选中，避免把群会话当作私聊筛选里的“失效选中”回显。
    store.setState((state) => ({
      qqInputs: { ...state.qqInputs, manualPicked: "", manualPeer: "" },
    }));

    render(<Host initialKind="private" schemeId={SCHEME_A} />);
    dialog = await openDialog();
    const privatePicker = within(dialog).getByLabelText(
      ui("schemes.bindings.pickConversation"),
    ) as HTMLSelectElement;
    const privateValues = Array.from(privatePicker.options).map((option) => option.value);
    expect(privateValues).toContain("10001:private:60006");
    expect(privateValues).not.toContain("10001:group:50005");
    // 手工号码是显式二次选择：清掉已观察选中后再落到同一份草稿。
    await userEvent.selectOptions(privatePicker, "");
    const number = within(dialog).getByLabelText(ui("qq.entry.privateNumber")) as HTMLInputElement;
    await userEvent.clear(number);
    await userEvent.type(number, "70007");
    expect(store.getState().qqInputs.manualPeer).toBe("70007");
    expect(store.getState().qqInputs.manualPicked).toBe("");
  });
});

describe("私聊自身目标防护", () => {
  it("私聊手工填机器人账号时提示并禁用绑定；群号同数字不被误拦", async () => {
    const create = vi.fn().mockResolvedValue(bindingOf(SCHEME_A, BINDING_A, "50005"));
    const fake = setUp({ createQqBinding: create });
    render(<Host initialKind="private" schemeId={SCHEME_A} />);
    const dialog = await openDialog();
    await waitFor(() => expect(fake.listQqBindings).toHaveBeenCalled());
    const number = within(dialog).getByLabelText(ui("qq.entry.privateNumber")) as HTMLInputElement;
    await userEvent.type(number, "10001");
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.assistant")),
      AGENT_A,
    );
    expect(within(dialog).getByRole("alert").textContent).toBe(ui("qq.entry.selfTarget"));
    expect(number.getAttribute("aria-invalid")).toBe("true");
    expect(number.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: ui("connections.bind") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(create).not.toHaveBeenCalled();

    // 同一数字在群聊命名空间是合法的群号，不能因等于机器人账号而拦截。
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.conversationType")),
      "group",
    );
    await userEvent.type(within(dialog).getByLabelText(ui("qq.entry.groupNumber")), "10001");
    expect(within(dialog).queryByText(ui("qq.entry.selfTarget"))).toBeNull();
    const bind = within(dialog).getByRole("button", {
      name: ui("connections.bind"),
    }) as HTMLButtonElement;
    expect(bind.disabled).toBe(false);
    await userEvent.click(bind);
    await settle();
    expect(create).toHaveBeenCalledExactlyOnceWith({
      account_id: "10001",
      kind: "group",
      peer_id: "10001",
      agent_id: AGENT_A,
      scheme_id: SCHEME_A,
      paused: false,
      memory_batch_size: null,
      share_web_memory: false,
    });
  });

  it("已观察的私聊自身目标同样提示并禁用绑定，不发 POST", async () => {
    const create = vi.fn();
    const fake = setUp({
      createQqBinding: create,
      listQqConversations: vi
        .fn()
        .mockResolvedValue([conversation("10001", "private"), conversation("60006", "private")]),
    });
    render(<Host initialKind="private" schemeId={SCHEME_A} />);
    const dialog = await openDialog();
    await waitFor(() => expect(fake.listQqConversations).toHaveBeenCalled());
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("schemes.bindings.pickConversation")),
      "10001:private:10001",
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.assistant")),
      AGENT_A,
    );
    expect(within(dialog).getByRole("alert").textContent).toBe(ui("qq.entry.selfTarget"));
    expect(
      (within(dialog).getByRole("button", { name: ui("connections.bind") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("重复、失败与成功", () => {
  it("在添加窗口新建方案后直接选中，保留号码和 Agent，并说明参与方式尚未开启", async () => {
    const created = scheme({
      id: SCHEME_B,
      name: "私聊新方案",
      triggers: { direct_reply: false, follow_up: false, chiming_in: false, idle_topic: false },
    });
    const fake = setUp({
      listQqSchemes: vi.fn().mockResolvedValue([scheme()]),
      createQqScheme: vi.fn().mockResolvedValue(created),
    });
    render(<Host initialKind="private" schemeId={SCHEME_A} />);
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText(ui("qq.entry.privateNumber")), "60006");
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.assistant")),
      AGENT_A,
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: ui("connections.newScheme") }),
    );
    await userEvent.type(within(dialog).getByLabelText(ui("connections.schemeName")), "私聊新方案");
    await userEvent.click(
      within(dialog).getByRole("button", { name: ui("qq.entry.createAndUse") }),
    );
    await waitFor(() => expect(store.getState().qqInputs.manualSchemeId).toBe(SCHEME_B));
    expect(store.getState().qqInputs.manualPeer).toBe("60006");
    expect(store.getState().qqInputs.manualAgentId).toBe(AGENT_A);
    expect(fake.createQqScheme).toHaveBeenCalledExactlyOnceWith({
      name: "私聊新方案",
      description: null,
    });
    expect(within(dialog).getByText(ui("qq.entry.schemeInactive"))).toBeTruthy();
    expect(fake.createQqBinding).not.toHaveBeenCalled();
  });

  it("私聊绑定后可重试刷新对话目录并查看空会话，不重复创建绑定", async () => {
    const saved = bindingOf(SCHEME_A, BINDING_A, "60006", "private");
    const summary = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      channel: "onebot11" as const,
      topology: "direct" as const,
      sourceId: saved.id,
      agentId: AGENT_A,
      bindingEpoch: 1,
      title: "私聊 60006",
      participants: [],
      updatedAt: NOW,
      lastSeq: 0,
      consumedSeq: 0,
    };
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("directory unavailable"))
      .mockResolvedValue({ items: [summary], nextCursor: null });
    const fake = setUp({
      createQqBinding: vi.fn().mockResolvedValue(saved),
      listConversations: list,
    });
    render(<Host initialKind="private" schemeId={SCHEME_A} />);
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText(ui("qq.entry.privateNumber")), "60006");
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.assistant")),
      AGENT_A,
    );
    await userEvent.click(within(dialog).getByRole("button", { name: ui("connections.bind") }));
    await screen.findByRole("dialog", { name: ui("qq.entry.successTitle") });
    expect(fake.createQqBinding).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ channel: "onebot11", sourceId: saved.id });
    expect(screen.getByText(ui("qq.entry.directoryPending"))).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: ui("qq.entry.refreshConversation") }));
    await screen.findByRole("button", { name: ui("qq.entry.view") });
    expect(fake.createQqBinding).toHaveBeenCalledTimes(1);
    expect(store.getState().directoryIds).toContain(summary.id);
    expect(store.getState().summaryById[summary.id]).toEqual(summary);
    expect(screen.getByText(ui("qq.entry.emptyConversation"))).toBeTruthy();
    expect(fake.updateQqSettings).not.toHaveBeenCalled();
  });

  it("已绑定会话只提供管理入口：不覆盖、不新建、不写绑定", async () => {
    const existing = bindingOf(SCHEME_B, BINDING_B, "40004");
    const fake = setUp({
      listQqBindings: vi.fn().mockResolvedValue([existing]),
      listQqConversations: vi
        .fn()
        .mockResolvedValue([conversation("40004", "group", BINDING_B), conversation("50005")]),
    });
    render(<Host initialKind="group" />);
    const dialog = await openDialog();
    await waitFor(() => expect(fake.listQqBindings).toHaveBeenCalled());
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("schemes.bindings.pickConversation")),
      "10001:group:40004",
    );
    expect(
      within(dialog).getByText(ui("schemes.bindings.boundElsewhere", { "0": "夜间方案" })),
    ).toBeTruthy();
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.assistant")),
      AGENT_A,
    );
    expect(
      (
        within(dialog).getByRole("button", {
          name: ui("connections.bind"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await userEvent.click(
      within(dialog).getByRole("button", { name: ui("schemes.bindings.manageExisting") }),
    );
    await settle();
    // 管理入口打开既有绑定编辑器；没有任何写请求，绑定保持服务端原值。
    expect(screen.getByRole("button", { name: ui("connections.saveBinding") })).toBeTruthy();
    expect(fake.createQqBinding).not.toHaveBeenCalled();
    expect(fake.updateQqBinding).not.toHaveBeenCalled();
    expect(store.getState().qqBindings).toEqual([existing]);
  });

  it("目录读取失败停在未知并可重试，不拿缓存继续", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("目录离线"))
      .mockResolvedValue([conversation("50005")]);
    const fake = setUp({ listQqBindings: list });
    render(<Host initialKind="group" />);
    expect(await screen.findByText(ui("schemes.bindings.loadFailed"))).toBeTruthy();
    expect(store.getState().qqBindingsLoaded).toBe(false);
    await userEvent.click(screen.getAllByRole("button", { name: ui("capabilities.retry") })[0]);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await settle();
    expect(store.getState().qqBindingsLoaded).toBe(true);
    expect(fake.createQqBinding).not.toHaveBeenCalled();
  });

  it("缺 Agent 时不可提交且守卫保留草稿；真实 409 保留对话框与全部原输入", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "CONFIG_VERSION_CONFLICT", "绑定已被其他窗口修改"))
      .mockResolvedValue(bindingOf(SCHEME_A, BINDING_A, "60006", "private"));
    setUp({ createQqBinding: create });
    store.setState({ agents: [] });
    const first = render(<Host initialKind="private" schemeId={SCHEME_A} />);
    let dialog = await openDialog();
    await settle();
    expect(within(dialog).queryByLabelText(ui("qq.entry.privateNumber"))).toBeNull();
    expect(within(dialog).getByRole("button", { name: ui("qq.entry.createAgent") })).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: ui("connections.bind") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // An older target draft still belongs to the existing navigation guard.
    store.setState((state) => ({ qqInputs: { ...state.qqInputs, manualPeer: "60006" } }));
    store.getState().openSettingsRoute("scheme-library");
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().qqInputs.manualPeer).toBe("60006");
    expect(create).not.toHaveBeenCalled();
    first.unmount();
    store.setState({
      agents: [agentOf(AGENT_A, "小助手")],
      navigationConfirmOpen: false,
      pendingNavigation: null,
    });

    render(<Host initialKind="private" schemeId={SCHEME_A} />);
    dialog = await openDialog();
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.assistant")),
      AGENT_A,
    );
    await userEvent.click(within(dialog).getByRole("button", { name: ui("connections.bind") }));
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen
        .getAllByRole("alert")
        .some((alert) => alert.textContent?.includes("绑定已被其他窗口修改")),
    ).toBe(true);
    expect(store.getState().qqInputs.manualPeer).toBe("60006");
    expect(store.getState().qqInputs.manualAgentId).toBe(AGENT_A);
  });

  it("绑定成功只用服务端返回的绑定：不自动启停/共享/发送，也不伪造会话", async () => {
    const saved = bindingOf(SCHEME_A, BINDING_A, "50005");
    const fake = setUp({ createQqBinding: vi.fn().mockResolvedValue(saved) });
    const before = {
      page: store.getState().page,
      summaries: store.getState().summaryById,
    };
    render(<Host initialKind="group" schemeId={SCHEME_A} />);
    const dialog = await openDialog();
    await waitFor(() => expect(fake.listQqBindings).toHaveBeenCalled());
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("schemes.bindings.pickConversation")),
      "10001:group:50005",
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText(ui("connections.assistant")),
      AGENT_A,
    );
    await userEvent.click(within(dialog).getByRole("button", { name: ui("connections.bind") }));
    await settle();
    expect(fake.createQqBinding).toHaveBeenCalledTimes(1);
    expect(fake.createQqBinding).toHaveBeenCalledWith({
      account_id: "10001",
      kind: "group",
      peer_id: "50005",
      agent_id: AGENT_A,
      scheme_id: SCHEME_A,
      paused: false,
      memory_batch_size: null,
      share_web_memory: false,
    });
    // 成功路径不自动开启 QQ、不开启网页记忆共享、不发送消息、不改路由。
    for (const write of [fake.updateQqBinding, fake.updateQqSettings, fake.updateQqTransport])
      expect(write).not.toHaveBeenCalled();
    expect(store.getState().qqSettings?.enabled).toBe(false);
    expect(store.getState().qqSettings).toEqual(settings);
    expect(store.getState().page).toBe(before.page);
    // 绑定来自服务端返回；没有伪造会话摘要。
    expect(store.getState().qqBindings).toContainEqual(saved);
    expect(store.getState().summaryById).toEqual(before.summaries);
    // 成功态留在入口内，供用户显式查看或继续配置；不直接进入会话。
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });
});
