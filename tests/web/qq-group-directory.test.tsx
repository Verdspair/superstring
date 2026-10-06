import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import type { QqBindingResponse, QqSchemeResponse } from "../../src/shared/contracts/qq";
import type { QqGroupConfigResponse } from "../../src/shared/contracts/qq-group-config";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-30T00:00:00.000Z";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT_ID = "44444444-4444-4444-8444-555555555555";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_SCHEME_ID = "33333333-3333-4333-8333-333333333333";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const PAUSED_BINDING_ID = "55555555-5555-4555-8555-555555555555";
const PRIVATE_BINDING_ID = "66666666-6666-4666-8666-666666666666";

const qqScheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: SCHEME_ID,
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

const qqBinding = (overrides: Partial<QqBindingResponse> = {}): QqBindingResponse => ({
  id: BINDING_ID,
  account_id: "10001",
  kind: "group",
  peer_id: "30003",
  agent_id: AGENT_ID,
  scheme_id: SCHEME_ID,
  paused: false,
  triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
  attention: { mode: "off", members: [] },
  share_web_memory: false,
  memory_batch_size: null,
  pending_observations: 0,
  revision: 1,
  authority_revision: 1,
  ...overrides,
});

/** 只看 id/绑定/Agent/标题：目录投影不读别的字段，按真实形状裁剪。 */
const summary = (
  id: string,
  sourceId: string,
  agentId: string,
  title: string,
): ConversationSummary =>
  ({
    id,
    sourceId,
    agentId,
    title,
    bindingEpoch: 1,
    lastSeq: 0,
    consumedSeq: 0,
  }) as unknown as ConversationSummary;

const agentResponse = (id: string, name: string) =>
  ({
    id,
    name,
    description: "",
    additional_instructions: "",
    model_name: "qwen/qwen3-4b-2507",
    temperature: 0.7,
    p5_config: {},
    is_active: true,
    config_version: 1,
    persona_intensity: 50,
    created_at: NOW,
    updated_at: NOW,
  }) as never;

const groupConfig = (binding: QqBindingResponse): QqGroupConfigResponse => {
  const base = qqScheme();
  return {
    binding,
    base_scheme: base,
    effective_scheme: base,
    overrides: {} as QqGroupConfigResponse["overrides"],
    disabled_capabilities: [],
    revision: 0,
  };
};

const knowledgeReadResponse = {
  revision: 1,
  config: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
};

function client(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    listQqBindings: vi.fn().mockResolvedValue([]),
    listQqSchemes: vi
      .fn()
      .mockResolvedValue([qqScheme(), qqScheme({ id: OTHER_SCHEME_ID, name: "夜间方案" })]),
    getQqGroupConfig: vi.fn(async (bindingId: string) => groupConfig(qqBinding({ id: bindingId }))),
    getAgentKnowledgeRead: vi.fn().mockResolvedValue(knowledgeReadResponse),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: SCHEME_ID, bindings: 0 }),
    ...overrides,
  } as unknown as typeof api;
}

async function renderDirectory({
  bindings = [],
  summaries = {},
  overrides = {},
}: {
  bindings?: QqBindingResponse[];
  summaries?: Record<string, ConversationSummary>;
  overrides?: Partial<typeof api>;
} = {}) {
  const fake = client({ listQqBindings: vi.fn().mockResolvedValue(bindings), ...overrides });
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-app-groups",
    agents: [agentResponse(AGENT_ID, "本地助手"), agentResponse(OTHER_AGENT_ID, "夜间助手")],
    summaryById: summaries,
  });
  render(<SchemesWorkspace />);
  await act(async () => {});
  return fake;
}

const searchBox = () => screen.getByLabelText(i18n.t("schemes.qq.groups.search"));

/** 群号在「群 30003」徽标里与「群」同元素；按整段文本定位徽标所在行。 */
const groupBadge = (peerId: string) => (_content: string, element: Element | null) =>
  element !== null &&
  element.children.length === 0 &&
  element.textContent === `${i18n.t("connections.group")} ${peerId}`;

const rowOf = (peerId: string) => screen.getByText(groupBadge(peerId)).closest("li") as HTMLElement;

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

it("跨方案已绑定的群都进目录；私聊不混入群列表", async () => {
  await renderDirectory({
    bindings: [
      qqBinding(),
      qqBinding({
        id: PAUSED_BINDING_ID,
        peer_id: "40004",
        agent_id: OTHER_AGENT_ID,
        scheme_id: OTHER_SCHEME_ID,
      }),
      qqBinding({ id: PRIVATE_BINDING_ID, kind: "private", peer_id: "20002" }),
    ],
  });
  expect(rowOf("30003").textContent).toContain("默认方案");
  expect(rowOf("40004").textContent).toContain("夜间方案");
  expect(rowOf("40004").textContent).toContain("夜间助手");
  expect(screen.queryByText(groupBadge("20002"))).toBeNull();
});

it("群显示名只来自同绑定同 Agent 的摘要：没有摘要只显示群号；暂停徽标只标真实 paused", async () => {
  await renderDirectory({
    bindings: [
      qqBinding(),
      qqBinding({
        id: PAUSED_BINDING_ID,
        peer_id: "40004",
        agent_id: OTHER_AGENT_ID,
        paused: true,
      }),
    ],
    summaries: {
      right: summary("right", BINDING_ID, AGENT_ID, "晨会群"),
      // 只剩旧 Agent 的群摘要：不借作另一群的显示名。
      stale: summary("stale", PAUSED_BINDING_ID, AGENT_ID, "旧助手群名"),
    },
  });
  expect(within(rowOf("30003")).getByText("晨会群")).toBeTruthy();
  expect(within(rowOf("30003")).queryByText(i18n.t("connections.paused"))).toBeNull();
  expect(screen.queryByText("旧助手群名")).toBeNull();
  expect(rowOf("40004").textContent).toContain("40004");
  expect(within(rowOf("40004")).getByText(i18n.t("connections.paused"))).toBeTruthy();
});

it("搜索命中群显示名、群号、方案名或 Agent 名；无命中给提示", async () => {
  await renderDirectory({
    bindings: [
      qqBinding(),
      qqBinding({
        id: PAUSED_BINDING_ID,
        peer_id: "40004",
        agent_id: OTHER_AGENT_ID,
        scheme_id: OTHER_SCHEME_ID,
      }),
    ],
    summaries: { right: summary("right", BINDING_ID, AGENT_ID, "晨会群") },
  });
  fireEvent.change(searchBox(), { target: { value: "晨会" } });
  expect(screen.getByText(groupBadge("30003"))).toBeTruthy();
  expect(screen.queryByText(groupBadge("40004"))).toBeNull();
  fireEvent.change(searchBox(), { target: { value: "40004" } });
  expect(screen.queryByText(groupBadge("30003"))).toBeNull();
  fireEvent.change(searchBox(), { target: { value: "夜间方案" } });
  expect(screen.getByText(groupBadge("40004"))).toBeTruthy();
  fireEvent.change(searchBox(), { target: { value: "本地助手" } });
  expect(screen.getByText(groupBadge("30003"))).toBeTruthy();
  fireEvent.change(searchBox(), { target: { value: "没有这个群" } });
  expect(screen.queryByText(groupBadge("30003"))).toBeNull();
  expect(screen.queryByText(groupBadge("40004"))).toBeNull();
  expect(screen.getByText(i18n.t("schemes.qq.groups.noMatch"))).toBeTruthy();
});

it("目录为空时引导先绑定，入口落在会话绑定视图", async () => {
  await renderDirectory();
  expect(screen.getByText(i18n.t("schemes.qq.groups.emptyNote"))).toBeTruthy();
  // 工具栏与空态各有真实入口：点空态范围内的引导按钮。
  const emptyCard = screen.getByText(i18n.t("schemes.qq.groups.emptyNote"))
    .parentElement as HTMLElement;
  fireEvent.click(
    within(emptyCard).getByRole("button", { name: i18n.t("schemes.bindings.entry") }),
  );
  expect(store.getState().settingsRoute).toBe("scheme-bindings");
});

it("读取失败给失败与重试；重试成功后出列表", async () => {
  const fake = await renderDirectory({
    overrides: {
      listQqBindings: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue([qqBinding()]),
    },
  });
  expect(screen.getByText(i18n.t("schemes.bindings.loadFailed"))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("capabilities.retry") }));
  await act(async () => {});
  expect(screen.getByText(groupBadge("30003"))).toBeTruthy();
  expect(fake.listQqBindings).toHaveBeenCalledTimes(2);
});

it("已预热（loaded）再进目录不重复 GET；显式刷新才重读且不动草稿", async () => {
  // mock 句柄保存在类型转换前，断言读句柄而不是读 typed API 形参上的 .mock。
  const listBindings = vi.fn().mockResolvedValue([qqBinding()]);
  const listSchemes = vi.fn().mockResolvedValue([qqScheme()]);
  const schemeUsage = vi.fn().mockResolvedValue({ scheme_id: SCHEME_ID, bindings: 0 });
  const fake = client({
    listQqBindings: listBindings,
    listQqSchemes: listSchemes,
    getQqSchemeUsage: schemeUsage,
  });
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-app-groups",
    agents: [agentResponse(AGENT_ID, "本地助手")],
    qqBindings: [qqBinding()],
    qqBindingsLoaded: true,
    qqSchemes: [qqScheme()],
    qqSchemesLoaded: true,
  });
  render(<SchemesWorkspace />);
  await act(async () => {});
  expect(listBindings).not.toHaveBeenCalled();
  expect(listSchemes).not.toHaveBeenCalled();
  expect(screen.getByText(groupBadge("30003"))).toBeTruthy();
  const bindingsReads = listBindings.mock.calls.length;
  const schemeReads = listSchemes.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: i18n.t("schemes.refresh") }));
  await act(async () => {});
  // 显式刷新强制重读两个目录；原生 API 只收读取请求，不带 store 层 force 标记。
  expect(listBindings.mock.calls.length).toBe(bindingsReads + 1);
  expect(listSchemes.mock.calls.length).toBe(schemeReads + 1);
  expect(schemeUsage).not.toHaveBeenCalled();
  // 目录读不产生本群配置草稿，也不留导航确认。
  expect(store.getState().qqGroupConfigEditor).toBeNull();
  expect(store.getState().navigationConfirmOpen).toBe(false);
});

it("点群的配置进对应群的本群配置页", async () => {
  await renderDirectory({
    bindings: [
      qqBinding(),
      qqBinding({ id: PAUSED_BINDING_ID, peer_id: "40004", agent_id: OTHER_AGENT_ID }),
    ],
  });
  fireEvent.click(
    within(rowOf("30003")).getByRole("button", {
      name: i18n.t("schemes.qq.groupConfig.controls.configure"),
    }),
  );
  await act(async () => {});
  expect(store.getState().settingsRoute).toBe("qq-group-config");
  expect(store.getState().qqGroupConfigBindingId).toBe(BINDING_ID);
  expect(store.getState().qqGroupConfigEditor?.source.binding.id).toBe(BINDING_ID);
});
