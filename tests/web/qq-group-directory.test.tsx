import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import type { QqBindingResponse, QqSchemeResponse } from "../../src/shared/contracts/qq";
import type { QqGroupConfigResponse } from "../../src/shared/contracts/qq-group-config";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

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
  // 0059：两组响应必填；夹具代表既有已保存方案，防抖按旧列默认显式关（新建默认开）。
  task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
  input_anti_spam: { enabled: false, burst_min_messages: 3, burst_window_seconds: 3 },
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
  // 0059：本会话覆盖两组，全新会话全 null＝跟随方案。
  task_limits: { mention_task_limit: null, ordinary_task_limit: null },
  input_anti_spam: {
    enabled: null,
    burst_min_messages: null,
    burst_window_seconds: null,
  },
  ...overrides,
});

/** 只看 id/绑定/Agent/标题：摘要投影只提供显示名，按真实形状裁剪。 */
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
    // 统一目录读取 loadQqBindingDirectory = Promise.all(settings, conversations, bindings,
    // schemes)，任一失败整目录失败：四个读方法都必须是显式 fake，缺一个就落到真实 fetch。
    getQqSettings: vi.fn().mockResolvedValue({
      enabled: false,
      account_id: "10001",
      judgement_model_name: null,
      transport: { endpoint: null, has_token: false },
      revision: 1,
    }),
    listQqConversations: vi.fn().mockResolvedValue([]),
    listQqBindings: vi.fn().mockResolvedValue([]),
    listQqSchemes: vi
      .fn()
      .mockResolvedValue([qqScheme(), qqScheme({ id: OTHER_SCHEME_ID, name: "夜间方案" })]),
    getQqGroupConfig: vi.fn(async (bindingId: string) => groupConfig(qqBinding({ id: bindingId }))),
    getAgentKnowledgeRead: vi.fn().mockResolvedValue(knowledgeReadResponse),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: SCHEME_ID, bindings: 0 }),
    updateQqBinding: vi.fn(),
    createQqBinding: vi.fn(),
    ...overrides,
  } as unknown as typeof api;
}

/** 旧的 qq-app-groups 目录已并入统一绑定看板：同一路由落到全局 ALL 板。 */
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

const searchBox = () =>
  screen.getByLabelText(i18n.t("connections.searchConversationBindings")) as HTMLInputElement;

const kindFilter = () =>
  screen.getByLabelText(i18n.t("connections.conversationType")) as HTMLSelectElement;

/** 看板行以群号文本定位所在 li。 */
const rowOf = (peerId: string) => screen.getByText(peerId).closest("li") as HTMLElement;

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

it("全局看板跨方案群与私聊同列：行显显示名/账号/基础方案/Agent；类型筛选收窄", async () => {
  await renderDirectory({
    bindings: [
      qqBinding(),
      qqBinding({
        id: PAUSED_BINDING_ID,
        peer_id: "40004",
        account_id: "10002",
        agent_id: OTHER_AGENT_ID,
        scheme_id: OTHER_SCHEME_ID,
      }),
      qqBinding({ id: PRIVATE_BINDING_ID, kind: "private", peer_id: "20002" }),
    ],
    summaries: { right: summary("right", BINDING_ID, AGENT_ID, "晨会群") },
  });
  expect(rowOf("30003").textContent).toContain("晨会群");
  expect(rowOf("30003").textContent).toContain("默认方案");
  expect(rowOf("30003").textContent).toContain("本地助手");
  expect(rowOf("30003").textContent).toContain("10001");
  expect(rowOf("40004").textContent).toContain("夜间方案");
  expect(rowOf("40004").textContent).toContain("夜间助手");
  expect(rowOf("40004").textContent).toContain("10002");
  // 全局 ALL 不再默认第一个方案：私聊同列。
  expect(rowOf("20002").textContent).toContain(i18n.t("connections.privateChat"));
  // 会话类型筛选是真实的收窄，不是装饰。
  fireEvent.change(kindFilter(), { target: { value: "group" } });
  expect(rowOf("30003")).toBeTruthy();
  expect(screen.queryByText("20002")).toBeNull();
  fireEvent.change(kindFilter(), { target: { value: "private" } });
  expect(screen.queryByText("30003")).toBeNull();
  expect(rowOf("20002")).toBeTruthy();
});

it("显示名只来自同绑定同 Agent 的摘要：不借另一群的显示名；暂停徽标只标真实 paused", async () => {
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
  expect(within(rowOf("40004")).getByText(i18n.t("connections.paused"))).toBeTruthy();
  // 搜索同样只命中正确配对的摘要。
  fireEvent.change(searchBox(), { target: { value: "旧助手群名" } });
  expect(screen.queryByText("30003")).toBeNull();
  expect(screen.queryByText("40004")).toBeNull();
  expect(screen.getByText(i18n.t("connections.noMatchingConversations"))).toBeTruthy();
});

it("搜索命中显示名、群号、账号、方案名或 Agent 名", async () => {
  await renderDirectory({
    bindings: [
      qqBinding(),
      qqBinding({
        id: PAUSED_BINDING_ID,
        peer_id: "40004",
        account_id: "10002",
        agent_id: OTHER_AGENT_ID,
        scheme_id: OTHER_SCHEME_ID,
      }),
    ],
    summaries: { right: summary("right", BINDING_ID, AGENT_ID, "晨会群") },
  });
  fireEvent.change(searchBox(), { target: { value: "晨会" } });
  expect(screen.getByText("30003")).toBeTruthy();
  expect(screen.queryByText("40004")).toBeNull();
  fireEvent.change(searchBox(), { target: { value: "40004" } });
  expect(screen.queryByText("30003")).toBeNull();
  expect(screen.getByText("40004")).toBeTruthy();
  fireEvent.change(searchBox(), { target: { value: "10002" } });
  expect(screen.getByText("40004")).toBeTruthy();
  expect(screen.queryByText("30003")).toBeNull();
  fireEvent.change(searchBox(), { target: { value: "夜间方案" } });
  expect(screen.getByText("40004")).toBeTruthy();
  fireEvent.change(searchBox(), { target: { value: "本地助手" } });
  expect(screen.getByText("30003")).toBeTruthy();
  expect(screen.queryByText("40004")).toBeNull();
  fireEvent.change(searchBox(), { target: { value: "没有这个群" } });
  expect(screen.getByText(i18n.t("connections.noMatchingConversations"))).toBeTruthy();
});

it("群行管理员入口打开唯一编辑器并直接定位管理员分区，不写任何绑定", async () => {
  const fake = await renderDirectory({
    bindings: [qqBinding()],
  });
  fireEvent.click(
    within(rowOf("30003")).getByRole("button", { name: i18n.t("connections.administrators") }),
  );
  const sheet = screen.getByRole("dialog");
  expect(within(sheet).getByText("群 30003")).toBeTruthy();
  expect(sheet.querySelector('[data-section="administrators"]')).toBeTruthy();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(fake.updateQqBinding).not.toHaveBeenCalled();
  expect(fake.createQqBinding).not.toHaveBeenCalled();
});

it("群行级「本群配置」直入：真实行按钮直达对应群配置页（与管理员定位同级行内入口）", async () => {
  await renderDirectory({ bindings: [qqBinding()] });
  // 行内直入按钮来自 QqGroupControls（kind=group 常显），不依赖管理抽屉间接路径。
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

it("目录为空时如实给出 ALL 空态，不伪装成方案过滤结果", async () => {
  await renderDirectory();
  expect(screen.getByText(i18n.t("schemes.bindings.allEmpty"))).toBeTruthy();
  expect(screen.getByRole("button", { name: i18n.t("schemes.bindings.add") })).toBeTruthy();
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
  expect(screen.getByText("30003")).toBeTruthy();
  expect(fake.listQqBindings).toHaveBeenCalledTimes(2);
});

it("挂载恰好读一次目录；显式刷新才重读且不动草稿", async () => {
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
  });
  render(<SchemesWorkspace />);
  await act(async () => {});
  // 统一看板是该分区的唯一读主：挂载恰好一次，不双读。
  expect(listBindings).toHaveBeenCalledTimes(1);
  expect(listSchemes).toHaveBeenCalledTimes(1);
  expect(screen.getByText("30003")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("schemes.bindings.refresh") }));
  await act(async () => {});
  expect(listBindings.mock.calls.length).toBe(2);
  expect(listSchemes.mock.calls.length).toBe(2);
  expect(schemeUsage).not.toHaveBeenCalled();
  // 目录读不产生本群配置草稿，也不留导航确认。
  expect(store.getState().qqGroupConfigEditor).toBeNull();
  expect(store.getState().navigationConfirmOpen).toBe(false);
});

it("选中查看的方案被删：停在显式 missing，不回退全部方案", async () => {
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
  });
  const picker = screen.getByLabelText(
    i18n.t("schemes.bindings.chooseScheme"),
  ) as HTMLSelectElement;
  await act(async () => {
    fireEvent.change(picker, { target: { value: OTHER_SCHEME_ID } });
  });
  expect(screen.getByText("40004")).toBeTruthy();
  expect(screen.queryByText("30003")).toBeNull();
  // 该方案从目录删除：列表收窄为空并显式提示 missing，绝不把全部方案的行兜底回来。
  act(() => store.setState({ qqSchemes: [qqScheme()] }));
  expect(screen.queryByText("40004")).toBeNull();
  expect(screen.queryByText("30003")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe(i18n.t("schemes.bindings.schemeMissing"));
  expect(
    within(
      screen.getByLabelText(i18n.t("schemes.bindings.chooseScheme")).closest("div") as HTMLElement,
    ).queryByText(i18n.t("schemes.bindings.schemeMissing")),
  ).toBeTruthy();
});
