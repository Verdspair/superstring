// 本群控制（ADR0019 §13.1）：启停即时 PUT、状态如实呈现、事实读取只发生一次且绝不自动重试。
//
// 覆盖：同屏多卡只读一次整页事实；停用只发一个仅带 paused 的 PUT 且行跟随目录；写进行中与
// 本群配置保存进行中都不写；已知写结果推进本群配置编辑器基线且草稿原文不丢；Agent 不一致
// 不写也不放行入口；不可用原因按事实如实呈现；首次读取失败可重试且不自动重试；
//「本群配置」按行打开并读取该行真实的配置；群会话顶部控制行与身份栏分离且不随隐藏页签渲染，
// 私聊会话不渲染群控制。

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema } from "../../src/shared/contracts";
import {
  type ConversationSummary,
  ConversationSummarySchema,
} from "../../src/shared/contracts/conversation";
import {
  type QqBindingResponse,
  QqBindingResponseSchema,
  type QqSchemeResponse,
} from "../../src/shared/contracts/qq";
import {
  mergeQqGroupScheme,
  type QqGroupConfigResponse,
  QqGroupConfigResponseSchema,
  type QqGroupSchemeOverrides,
} from "../../src/shared/contracts/qq-group-config";
import { api } from "../../src/web/api";
import { qqGroupConfigEditorFrom } from "../../src/web/features/qq/group-config-state";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { ExternalConversation } from "../../src/web/screens/conversations/ExternalConversation";
import { QqGroupControls } from "../../src/web/screens/conversations/QqGroupControls";
import { useSuperstringStore as store } from "../../src/web/store";

const ui = (key: string, values?: Record<string, unknown>) => i18n.t(key, values) as string;
const ctrl = (key: string) => ui(`schemes.qq.groupConfig.controls.${key}`);

const NOW = "2026-09-30T00:00:00.000Z";
const SCHEME_A = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BINDING_ONE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BINDING_TWO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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
    initiative_batch_target_count: 15,
    initiative_batch_jitter_count: 5,
    initiative_queue_on_busy: true,
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
  id: string,
  peer: string,
  overrides: Partial<QqBindingResponse> = {},
): QqBindingResponse =>
  QqBindingResponseSchema.parse({
    id,
    account_id: "10001",
    kind: "group",
    peer_id: peer,
    agent_id: AGENT_A,
    scheme_id: SCHEME_A,
    paused: false,
    triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
    share_web_memory: false,
    memory_batch_size: null,
    pending_observations: 0,
    revision: 1,
    authority_revision: 1,
    attention: { mode: "off", members: [] },
    ...overrides,
  });

const agentOf = (id: string, active = true) =>
  AgentResponseSchema.parse({
    id,
    name: "小助手",
    model_name: "model",
    config_version: 1,
    persona_intensity: 60,
    created_at: NOW,
    updated_at: NOW,
    p5_config: { recent_turns: 12 },
    is_active: active,
  });

const settings = {
  enabled: true,
  account_id: "10001",
  judgement_model_name: null,
  transport: { endpoint: null, has_token: false },
  revision: 1,
};

const readyConnection = { phase: "ready", reason: null } as const;

const configOf = (
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

function fakeClient(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    getQqSettings: vi.fn().mockResolvedValue(settings),
    getQqStatus: vi.fn().mockResolvedValue({ connection: readyConnection }),
    listQqBindings: vi.fn().mockResolvedValue([bindingOf(BINDING_ONE, "30003")]),
    listQqConversations: vi.fn().mockResolvedValue([]),
    listQqSchemes: vi.fn().mockResolvedValue([scheme()]),
    updateQqBinding: vi.fn().mockResolvedValue(bindingOf(BINDING_ONE, "30003", { paused: true })),
    getQqGroupConfig: vi.fn().mockResolvedValue(configOf(bindingOf(BINDING_ONE, "30003"))),
    ...overrides,
  } as unknown as typeof api;
}

function ready(fake: typeof api) {
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
    agents: [agentOf(AGENT_A)],
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("本群控制的读取与状态", () => {
  it("同屏两张卡片只读一次整页事实，各自呈现运行中", async () => {
    const fake = fakeClient({
      listQqBindings: vi
        .fn()
        .mockResolvedValue([bindingOf(BINDING_ONE, "30003"), bindingOf(BINDING_TWO, "40004")]),
    });
    ready(fake);
    render(
      <>
        <QqGroupControls bindingId={BINDING_ONE} />
        <QqGroupControls bindingId={BINDING_TWO} />
      </>,
    );
    await act(async () => {});
    expect(fake.getQqSettings).toHaveBeenCalledTimes(1);
    expect(fake.getQqStatus).toHaveBeenCalledTimes(1);
    expect(fake.listQqBindings).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(ctrl("enabled")).length).toBe(2);
  });

  it("首次事实读取失败：按未知呈现并可重试，失败不会自动重试", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("目录离线"))
      .mockResolvedValue([bindingOf(BINDING_ONE, "30003")]);
    const fake = fakeClient({ listQqBindings: list });
    ready(fake);
    render(<QqGroupControls bindingId={BINDING_ONE} />);
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByText(ctrl("unknown"))).toBeTruthy();
    // 半路失败不再继续读连接，也不会自己重发读取。
    expect(fake.getQqStatus).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: ui("capabilities.retry") }));
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
    expect(fake.getQqStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByText(ctrl("enabled"))).toBeTruthy();
  });

  it("不可用原因按事实如实呈现：总开关/连接/Agent 停用，缺失则未知", async () => {
    const fake = fakeClient();
    ready(fake);
    render(<QqGroupControls bindingId={BINDING_ONE} />);
    await act(async () => {});
    expect(screen.getByText(ctrl("enabled"))).toBeTruthy();

    act(() => store.setState({ qqSettings: { ...settings, enabled: false } }));
    expect(screen.getByText(ctrl("globalOff"))).toBeTruthy();

    act(() =>
      store.setState({
        qqSettings: { ...settings },
        qqConnection: { phase: "connecting", reason: null },
      }),
    );
    expect(screen.getByText(ctrl("disconnected"))).toBeTruthy();

    act(() =>
      store.setState({
        qqConnection: { phase: "ready", reason: null },
        agents: [agentOf(AGENT_A, false)],
      }),
    );
    expect(screen.getByText(ctrl("agentOff"))).toBeTruthy();

    // 连接事实缺失：呈现未知而不是空；已尝试过就不再自动回读。
    act(() => store.setState({ qqConnection: null }));
    expect(screen.getByText(ctrl("unknown"))).toBeTruthy();
    await act(async () => {});
    expect(fake.getQqSettings).toHaveBeenCalledTimes(1);
    expect(fake.listQqBindings).toHaveBeenCalledTimes(1);
  });

  it("Agent 不一致：状态指出改绑，三个入口都按住且不发 PUT", async () => {
    const fake = fakeClient();
    ready(fake);
    store.setState({
      qqBindings: [bindingOf(BINDING_ONE, "30003", { paused: true })],
      qqBindingsLoaded: true,
      qqSettings: { ...settings },
      qqConnection: { phase: "ready", reason: null },
    });
    render(<QqGroupControls bindingId={BINDING_ONE} expectedAgentId={AGENT_B} />);
    await act(async () => {});
    // 暂停与改绑同屏时先指出改绑：旧视图不该被暗示成「已停用」。
    expect(screen.getByText(ctrl("wrongAgent"))).toBeTruthy();
    expect(screen.queryByText(ctrl("paused"))).toBeNull();
    for (const name of [ctrl("enable"), ctrl("disable"), ctrl("configure")]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByRole("button", { name: ctrl("disable") }));
    expect(fake.updateQqBinding).not.toHaveBeenCalled();
    expect(fake.getQqGroupConfig).not.toHaveBeenCalled();
    // 事实都在：一个自读都不该发生。
    expect(fake.listQqBindings).not.toHaveBeenCalled();
  });
});

describe("本群控制的写入", () => {
  it("点击停用只发一个仅带 paused 的 PUT，写成功后行跟随目录呈现已停用", async () => {
    const fake = fakeClient({
      listQqBindings: vi
        .fn()
        .mockResolvedValueOnce([bindingOf(BINDING_ONE, "30003")])
        .mockResolvedValue([bindingOf(BINDING_ONE, "30003", { paused: true })]),
    });
    ready(fake);
    render(<QqGroupControls bindingId={BINDING_ONE} />);
    await act(async () => {});
    expect(screen.getByText(ctrl("enabled"))).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: ctrl("disable") }));
    await act(async () => {});
    expect(fake.updateQqBinding).toHaveBeenCalledTimes(1);
    expect(fake.updateQqBinding).toHaveBeenCalledWith(BINDING_ONE, {
      paused: true,
      expected_revision: 1,
    });
    expect(screen.getByText(ctrl("paused"))).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: ctrl("enable") }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("写进行中与本群配置保存进行中都不再发 PUT", async () => {
    const pending = deferred<QqBindingResponse>();
    const fake = fakeClient({
      listQqBindings: vi
        .fn()
        .mockResolvedValueOnce([bindingOf(BINDING_ONE, "30003")])
        .mockResolvedValue([bindingOf(BINDING_ONE, "30003", { paused: true })]),
      updateQqBinding: vi.fn(() => pending.promise),
    });
    ready(fake);
    render(<QqGroupControls bindingId={BINDING_ONE} />);
    await act(async () => {});
    await userEvent.click(screen.getByRole("button", { name: ctrl("disable") }));
    expect(fake.updateQqBinding).toHaveBeenCalledTimes(1);
    // 写进行中：按钮按住，重复点击不产生第二个写。
    expect(
      (screen.getByRole("button", { name: ctrl("disable") }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: ctrl("disable") }));
    expect(fake.updateQqBinding).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(bindingOf(BINDING_ONE, "30003", { paused: true, revision: 2 }));
    });
    expect(
      (screen.getByRole("button", { name: ctrl("enable") }) as HTMLButtonElement).disabled,
    ).toBe(false);
    // 本群配置保存进行中：同一行的启停入口同样按住。
    act(() => store.setState({ qqGroupConfigSaving: true }));
    expect(
      (screen.getByRole("button", { name: ctrl("enable") }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: ctrl("enable") }));
    expect(fake.updateQqBinding).toHaveBeenCalledTimes(1);
    act(() => store.setState({ qqGroupConfigSaving: false }));
    expect(
      (screen.getByRole("button", { name: ctrl("enable") }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("暂停写成功推进本群配置编辑器基线，草稿改写与非法原文都不丢", async () => {
    const saved = bindingOf(BINDING_ONE, "30003", { paused: true, revision: 5 });
    const fake = fakeClient({ updateQqBinding: vi.fn().mockResolvedValue(saved) });
    ready(fake);
    const editor = qqGroupConfigEditorFrom(
      configOf(bindingOf(BINDING_ONE, "30003"), { context: { reply_token_budget: 8000 } }),
    );
    editor.rawTexts = { "rhythm.merge_window_seconds": "abc" };
    store.setState({ qqGroupConfigBindingId: BINDING_ONE, qqGroupConfigEditor: editor });
    render(<QqGroupControls bindingId={BINDING_ONE} />);
    await act(async () => {});
    await userEvent.click(screen.getByRole("button", { name: ctrl("disable") }));
    await act(async () => {});
    const after = store.getState().qqGroupConfigEditor;
    expect(after?.source.binding.revision).toBe(5);
    expect(after?.source.binding.paused).toBe(true);
    expect(after?.overrides).toEqual({ context: { reply_token_budget: 8000 } });
    expect(after?.rawTexts).toEqual({ "rhythm.merge_window_seconds": "abc" });
  });

  it("「本群配置」按行打开：读取并指向该行真实的配置", async () => {
    const second = bindingOf(BINDING_TWO, "40004");
    const fake = fakeClient({
      listQqBindings: vi.fn().mockResolvedValue([bindingOf(BINDING_ONE, "30003"), second]),
      getQqGroupConfig: vi.fn().mockResolvedValue(configOf(second)),
    });
    ready(fake);
    render(
      <>
        <QqGroupControls bindingId={BINDING_ONE} />
        <QqGroupControls bindingId={BINDING_TWO} />
      </>,
    );
    await act(async () => {});
    const configure = screen.getAllByRole("button", { name: ctrl("configure") });
    await userEvent.click(configure[1] as HTMLElement);
    await act(async () => {});
    expect(fake.getQqGroupConfig).toHaveBeenCalledWith(BINDING_TWO);
    expect(store.getState().qqGroupConfigBindingId).toBe(BINDING_TWO);
    expect(store.getState().qqGroupConfigEditor?.source.binding.id).toBe(BINDING_TWO);
    expect(store.getState().settingsRoute).toBe("qq-group-config");
  });
});

// —— 群会话顶部布局（窄屏溢出修复）：群控制移出身份栏 actions，位于身份栏之后的独立全宽行
// （min-w-0 + border-b + px-4 py-2；控件自身 w-full min-w-0 且 flex-wrap），窄屏可整行换行；
// 隐藏页签与私聊不渲染该行，身份栏的刷新入口照旧。这里按真实 ExternalConversation 验证结构，
// 真实像素观感由视觉验收负责。

const conversationOf = (overrides: Partial<ConversationSummary> = {}): ConversationSummary =>
  ConversationSummarySchema.parse({
    id: "bot",
    sourceId: BINDING_ONE,
    channel: "onebot11",
    topology: "shared",
    agentId: AGENT_A,
    title: "小林和后援团的群",
    bindingEpoch: 1,
    participants: [{ id: "member-1", label: "小林", role: "member" }],
    updatedAt: NOW,
    lastSeq: 0,
    consumedSeq: 0,
    ...overrides,
  });

const emptyHistory = () => ({ items: [], nextSeq: 0, hasMore: false });

const seedGroupFacts = () =>
  store.setState({
    qqBindings: [bindingOf(BINDING_ONE, "30003")],
    qqBindingsLoaded: true,
    qqSettings: { ...settings },
    qqConnection: { phase: "ready", reason: null },
  });

describe("群会话顶部：控制行与身份栏分离", () => {
  it("群控制位于身份栏之后的独立全宽行，身份栏保留标题、头像与刷新", async () => {
    const events = vi.fn().mockResolvedValue(emptyHistory());
    const fake = fakeClient({ getConversationEvents: events });
    ready(fake);
    seedGroupFacts();
    const conversation = conversationOf();
    const { container } = render(<ExternalConversation conversation={conversation} />);
    await act(async () => {});
    // 历史读取走既有方法和既有首读形状：整页最新一页、带中止信号；事实已齐则群控制不再自读整页。
    expect(events).toHaveBeenCalledTimes(1);
    expect(events.mock.calls[0]?.[0]).toBe(conversation.id);
    expect(events.mock.calls[0]?.[1]).toEqual({ direction: "latest" });
    expect(events.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(fake.listQqBindings).not.toHaveBeenCalled();

    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    // 身份栏保留真实 h1 标题、头像入口、助手名与刷新。
    expect(within(header as HTMLElement).getByRole("heading", { level: 1 }).textContent).toBe(
      conversation.title,
    );
    expect(
      within(header as HTMLElement).getByRole("button", {
        name: ui("avatar.edit_named", { "0": conversation.title }),
      }),
    ).toBeTruthy();
    expect(within(header as HTMLElement).getByText("小助手")).toBeTruthy();
    expect(
      within(header as HTMLElement).getByRole("button", { name: ui("workspace.refresh_history") }),
    ).toBeTruthy();

    // 群控制不是身份栏后代；它是紧随身份栏的独立行，整行承载、自身可换行。
    const controls = screen.getByRole("group", { name: ctrl("label") });
    expect(header?.contains(controls)).toBe(false);
    const row = controls.parentElement as HTMLElement;
    expect(header?.nextElementSibling).toBe(row);
    for (const token of ["min-w-0", "shrink-0", "border-b", "px-4", "py-2", "md:px-7"])
      expect(row.classList.contains(token)).toBe(true);
    for (const token of ["w-full", "min-w-0", "flex-wrap"])
      expect(controls.classList.contains(token)).toBe(true);
    expect(within(controls).getByText(ctrl("enabled"))).toBeTruthy();
  });

  it("页签未激活：控制行与身份栏不渲染，历史读取停止且视口隐藏", async () => {
    const events = vi.fn().mockResolvedValue(emptyHistory());
    const fake = fakeClient({ getConversationEvents: events });
    ready(fake);
    const { container } = render(
      <ExternalConversation conversation={conversationOf()} active={false} />,
    );
    await act(async () => {});
    expect(container.querySelector("header")).toBeNull();
    expect(screen.queryByRole("group", { name: ctrl("label") })).toBeNull();
    expect(screen.queryByRole("button", { name: ctrl("disable") })).toBeNull();
    expect(screen.queryByRole("button", { name: ui("workspace.refresh_history") })).toBeNull();
    // 隐藏页签与失焦同语义：不发起历史读取，视口留在文档中但标记 hidden。
    expect(events).not.toHaveBeenCalled();
    expect(container.querySelector('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(true);
  });

  it("私聊会话不渲染群控制，身份栏刷新照旧", async () => {
    const events = vi.fn().mockResolvedValue(emptyHistory());
    const fake = fakeClient({ getConversationEvents: events });
    ready(fake);
    render(<ExternalConversation conversation={conversationOf({ topology: "direct" })} />);
    await act(async () => {});
    expect(screen.queryByRole("group", { name: ctrl("label") })).toBeNull();
    expect(screen.queryByRole("button", { name: ctrl("disable") })).toBeNull();
    // 群控制没有被挂载：一次事实自读都不该发生。
    expect(fake.listQqBindings).not.toHaveBeenCalled();
    const header = screen.getByRole("heading", { level: 1 }).closest("header");
    expect(header).not.toBeNull();
    expect(
      within(header as HTMLElement).getByRole("button", { name: ui("workspace.refresh_history") }),
    ).toBeTruthy();
  });
});
