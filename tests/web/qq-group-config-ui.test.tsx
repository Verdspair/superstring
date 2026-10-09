// 本群配置页（真实 store + fake API）：显式钉住、blur 报错、换方案预览、能力事实、409 与返回导航。
//
// 页面键文案随后由别的写者补进 locale：断言只看 data-* 标记、DOM 顺序与 store 状态，不依赖文案。

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResponse } from "../../src/shared/contracts/agent";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import type { AgentKnowledgeReadSettings } from "../../src/shared/contracts/knowledge";
import {
  type PermissionGrant,
  type PermissionsResponse,
  PermissionsResponseSchema,
} from "../../src/shared/contracts/permissions";
import type { QqBindingResponse, QqSchemeResponse } from "../../src/shared/contracts/qq";
import type { QqGroupConfigResponse } from "../../src/shared/contracts/qq-group-config";
import { api, type SuperstringApi } from "../../src/web/api";
import {
  type KnowledgeReadEditor,
  knowledgeReadDirty,
} from "../../src/web/features/knowledge/types";
import { qqGroupConfigDirty } from "../../src/web/features/qq/group-config-state";
import { selectLocale } from "../../src/web/i18n";
import { QqGroupConfigPage } from "../../src/web/screens/connections/group-config";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-30T00:00:00.000Z";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT_ID = "44444444-4444-4444-8444-555555555555";
const BASE_SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_SCHEME_ID = "33333333-3333-4333-8333-333333333333";

const qqScheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: BASE_SCHEME_ID,
  name: "默认方案",
  description: null,
  triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
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
  reply: { split_by_speaker: true },
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const qqBinding = (overrides: Partial<QqBindingResponse> = {}): QqBindingResponse => ({
  id: BINDING_ID,
  account_id: "100",
  kind: "group",
  peer_id: "123456789",
  agent_id: AGENT_ID,
  scheme_id: BASE_SCHEME_ID,
  paused: false,
  triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
  share_web_memory: false,
  memory_batch_size: null,
  pending_observations: 0,
  revision: 4,
  authority_revision: 4,
  attention: { mode: "off", members: [] },
  ...overrides,
});

const qqConfig = (overrides: Partial<QqGroupConfigResponse> = {}): QqGroupConfigResponse => {
  const base = qqScheme();
  return {
    binding: qqBinding(),
    base_scheme: base,
    effective_scheme: base,
    overrides: {} as QqGroupConfigResponse["overrides"],
    disabled_capabilities: [],
    revision: 0,
    ...overrides,
  };
};

/** 权限快照按真实契约解析（稀疏输入走默认值），避免手抄 ExecutionPolicy 全量字段。 */
const permissions = (
  grants: Array<Pick<PermissionGrant, "resource"> & Partial<PermissionGrant>>,
  resources: Array<{ resource: string; revision?: string; approvalRequired?: boolean }>,
): PermissionsResponse =>
  PermissionsResponseSchema.parse({
    revision: "1",
    policy: { version: 1, grants, execution: { modules: { mcp: true, skills: true } } },
    resources: resources.map((resource) => ({
      name: resource.resource,
      description: "",
      effect: "write",
      resource: resource.resource,
      revision: resource.revision ?? "rev-1",
      approvalRequired: resource.approvalRequired ?? true,
    })),
  });

/** 知识查询的已保存状态（页面只读投影的来源）：默认关闭，与旧用例的 knowledge_read「off」预期一致。 */
const knowledgeReadResponse = (enabled: boolean): AgentKnowledgeReadSettings => ({
  revision: 1,
  config: { enabled, context_budget: null, scope: "all", document_ids: [] },
});

const fakeClient = (overrides: Partial<SuperstringApi>): SuperstringApi =>
  ({
    ...api,
    getQqGroupConfig: vi.fn(async () => qqConfig()),
    saveQqGroupConfig: vi.fn(async () => qqConfig({ revision: 1 })),
    listQqSchemes: vi.fn(async () => [qqScheme()]),
    listQqStickerCollections: vi.fn(async () => []),
    listQqStickerAssets: vi.fn(async () => []),
    getPermissions: vi.fn(async () => permissions([], [])),
    getAgentKnowledgeRead: vi.fn(async () => knowledgeReadResponse(false)),
    ...overrides,
  }) as unknown as SuperstringApi;

async function renderPage(overrides: Partial<SuperstringApi> = {}) {
  const fake = fakeClient(overrides);
  store.getState().resetForTests(fake);
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "qq-group-config" });
  await store.getState().selectQqGroupConfig(BINDING_ID);
  const view = render(<QqGroupConfigPage />);
  await act(async () => {});
  return { fake, ...view };
}

type View = Awaited<ReturnType<typeof renderPage>>;

const fieldOf = (view: View, field: string) =>
  within(
    view.container
      .querySelector(`input[data-field="${field}"]`)
      ?.closest('[data-slot="field"]') as HTMLElement,
  );

const editorOf = () => store.getState().qqGroupConfigEditor;

const permissionEditorOf = () => {
  const editor = store.getState().permissionEditor;
  if (!editor) throw new Error("permission editor not loaded");
  return editor;
};

const saveButtonOf = (view: View) =>
  within(view.container.querySelector("footer") as HTMLElement)
    .getAllByRole("button")
    .at(-1) as HTMLButtonElement;

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

it("显式钉住与基线同值也保留；钉住从基线初始化，装配冗余按整数百分比；follow 才回到 undefined", async () => {
  const view = await renderPage();
  // 与基线同值（30）也是显式钉住：先改成 31 再改回 30，两次都是显式覆盖。
  const mergeInput = view.container.querySelector(
    'input[data-field="rhythm.merge_window_seconds"]',
  ) as HTMLInputElement;
  fireEvent.change(mergeInput, { target: { value: "31" } });
  expect(editorOf()?.overrides).toEqual({ rhythm: { merge_window_seconds: 31 } });
  fireEvent.change(mergeInput, { target: { value: "30" } });
  expect(editorOf()?.overrides).toEqual({ rhythm: { merge_window_seconds: 30 } });

  // 数字自定义从基线初始化（200），状态行明确显示 custom；改回 follow 即取消钉住。
  const hourlyInput = view.container.querySelector(
    'input[data-field="rhythm.hourly_speech_limit"]',
  ) as HTMLInputElement;
  const hourlyState = fieldOf(view, "rhythm.hourly_speech_limit").getByRole(
    "combobox",
  ) as HTMLSelectElement;
  fireEvent.change(hourlyState, { target: { value: "custom" } });
  expect(editorOf()?.overrides).toEqual({
    rhythm: { merge_window_seconds: 30, hourly_speech_limit: 200 },
  });
  expect(hourlyState.value).toBe("custom");
  expect((hourlyInput as HTMLInputElement).value).toBe("200");
  fireEvent.change(hourlyState, { target: { value: "follow" } });
  expect(editorOf()?.overrides).toEqual({ rhythm: { merge_window_seconds: 30 } });

  // 装配冗余钉住初始化成整数百分比（0.05 → 输入 5）。压缩装配归「历史压缩」组。
  await userEvent.click(screen.getByRole("tab", { name: "历史压缩" }));
  const headroomState = fieldOf(view, "compression.headroom_ratio").getByRole(
    "combobox",
  ) as HTMLSelectElement;
  fireEvent.change(headroomState, { target: { value: "custom" } });
  expect(editorOf()?.overrides).toEqual({
    rhythm: { merge_window_seconds: 30 },
    compression: { headroom_ratio: 0.05 },
  });
  expect(
    (
      view.container.querySelector(
        'input[data-field="compression.headroom_ratio"]',
      ) as HTMLInputElement
    ).value,
  ).toBe("5");
});

it("非法数字原文优先显示（空串不跳回旧值）；blur 才出现错误并拦住保存", async () => {
  const view = await renderPage();
  const input = view.container.querySelector(
    'input[data-field="rhythm.hourly_speech_limit"]',
  ) as HTMLInputElement;

  fireEvent.change(input, { target: { value: "3000" } });
  expect(input.value).toBe("3000");
  expect(editorOf()?.rawTexts).toEqual({ "rhythm.hourly_speech_limit": "3000" });
  expect(screen.queryAllByRole("alert")).toEqual([]);

  fireEvent.blur(input);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(saveButtonOf(view).disabled).toBe(true);

  // 空串同样以原文显示（不清回旧值），仍是非法输入。
  fireEvent.change(input, { target: { value: "" } });
  expect(input.value).toBe("");
  expect(editorOf()?.rawTexts).toEqual({ "rhythm.hourly_speech_limit": "" });
  fireEvent.blur(input);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(saveButtonOf(view).disabled).toBe(true);

  // 修正后原文清掉，可以保存。
  fireEvent.change(input, { target: { value: "250" } });
  fireEvent.blur(input);
  expect(editorOf()?.rawTexts).toEqual({});
  expect(editorOf()?.overrides).toEqual({ rhythm: { hourly_speech_limit: 250 } });
  expect(screen.queryAllByRole("alert")).toEqual([]);
  expect(saveButtonOf(view).disabled).toBe(false);
});

it("换基础方案先预览全部当前钉住与新方案值；选 keep 后整页改用目标基线，source 仍是 CAS 原基线", async () => {
  const target = qqScheme({
    id: TARGET_SCHEME_ID,
    name: "新方案",
    revision: 7,
    rhythm: { ...qqScheme().rhythm, merge_window_seconds: 70, hourly_speech_limit: 250 },
  });
  const view = await renderPage({ listQqSchemes: vi.fn(async () => [qqScheme(), target]) });
  act(() => store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45"));

  const select = view.container.querySelector(
    'select[data-field="scheme.switch"]',
  ) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: TARGET_SCHEME_ID } });

  const dialog = await screen.findByRole("dialog");
  const row = dialog.querySelector(
    '[data-switch-row="rhythm.merge_window_seconds"]',
  ) as HTMLElement;
  expect(row.textContent).toContain("45");
  expect(row.textContent).toContain("70");

  fireEvent.click(dialog.querySelector('[data-switch-action="keep"]') as HTMLElement);
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(editorOf()?.schemeId).toBe(TARGET_SCHEME_ID);
  expect(editorOf()?.source.base_scheme.id).toBe(BASE_SCHEME_ID);

  // 页面范围：选择器、页头名字与字段基线说明都显示目标方案。
  expect(
    (view.container.querySelector('select[data-field="scheme.switch"]') as HTMLSelectElement).value,
  ).toBe(TARGET_SCHEME_ID);
  expect(view.container.querySelector("header")?.textContent).toContain("新方案");
  const field = fieldOf(view, "rhythm.merge_window_seconds");
  expect((field.getByRole("spinbutton") as HTMLInputElement).value).toBe("45");
  // 未钉住的字段跟随目标基线：小时上限显示新方案的 250（原基线是 200）。
  expect(
    (
      view.container.querySelector(
        'input[data-field="rhythm.hourly_speech_limit"]',
      ) as HTMLInputElement
    ).value,
  ).toBe("250");
});

it("能力上层事实逐项来自真实来源：授权现状、审批与读取关闭，不拿模块开关冒充可用", async () => {
  const view = await renderPage({
    getPermissions: vi.fn(async () =>
      permissions(
        [{ resource: "mcp.alpha" }],
        [{ resource: "mcp.alpha", revision: "rev-2", approvalRequired: true }],
      ),
    ),
  });
  act(() => {
    store.setState({
      agents: [
        { id: AGENT_ID, name: "群助手", p5_config: { retrieval_mode: "off" } },
      ] as unknown as AgentResponse[],
    });
  });
  const tabs = screen.getAllByRole("tab");
  await userEvent.click(tabs.at(-1) as HTMLElement);
  await act(async () => {});

  const upperOf = (capability: string) =>
    view.container
      .querySelector(`[data-capability="${capability}"] [data-upper]`)
      ?.getAttribute("data-upper");
  // 模块开着、授权未批：MCP 显示「需审批」；知识查询按其已保存读取来源（默认关闭＝off，另见行内重试用例）。
  expect(upperOf("mcp")).toBe("approval");
  expect(upperOf("memory_read")).toBe("off");
  expect(upperOf("knowledge_read")).toBe("off");

  const snapshot = permissionEditorOf().snapshot;
  const withGrants = (grants: PermissionGrant[]) =>
    act(() =>
      store.setState({
        permissionEditor: {
          ...permissionEditorOf(),
          snapshot: { ...snapshot, policy: { ...snapshot.policy, grants } },
        },
      }),
    );
  withGrants([{ resource: "mcp.alpha", approved: true, revision: "rev-2", directories: [] }]);
  expect(upperOf("mcp")).toBe("on");
  withGrants([]);
  expect(upperOf("mcp")).toBe("unauthorized");
  act(() =>
    store.setState({
      permissionEditor: {
        ...permissionEditorOf(),
        snapshot: {
          ...permissionEditorOf().snapshot,
          resources: [],
          policy: { ...permissionEditorOf().snapshot.policy, grants: [] },
        },
      },
    }),
  );
  expect(upperOf("mcp")).toBe("noActions");
});

it("知识查询只按绑定 Agent 读只读接口：失败＝未读取（不是 off）且行内可重试，成功后回到已保存状态", async () => {
  const read = vi
    .fn(async () => knowledgeReadResponse(true))
    .mockRejectedValueOnce(new Error("知识读取失败"));
  const view = await renderPage({ getAgentKnowledgeRead: read });
  await userEvent.click(screen.getAllByRole("tab").at(-1) as HTMLElement);
  await act(async () => {});

  const upperOf = (capability: string) =>
    view.container
      .querySelector(`[data-capability="${capability}"] [data-upper]`)
      ?.getAttribute("data-upper");
  const row = view.container.querySelector('[data-capability="knowledge_read"]') as HTMLElement;
  expect(upperOf("knowledge_read")).toBe("unread");
  expect(read).toHaveBeenCalledWith(AGENT_ID);
  expect(read).toHaveBeenCalledTimes(1);
  // 未知不是 off：重试按钮与失败原因都挂在知识查询这一行。
  expect(row.querySelector("[data-capability-retry]")).toBeTruthy();
  expect(within(row).getByRole("alert").textContent).toContain("知识读取失败");

  await act(async () => {
    fireEvent.click(row.querySelector("[data-capability-retry]") as HTMLElement);
  });
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith(AGENT_ID);
  expect(upperOf("knowledge_read")).toBe("on");
  expect(row.querySelector("[data-capability-retry]")).toBeNull();
});

it("只读投影绝不落到全局知识编辑器：不选中也不弄脏别的 Agent 的草稿", async () => {
  const read = vi.fn(async () => knowledgeReadResponse(true));
  await renderPage({ getAgentKnowledgeRead: read });
  const otherDraft: KnowledgeReadEditor = {
    token: {},
    agentId: OTHER_AGENT_ID,
    source: knowledgeReadResponse(true),
    draft: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
    documents: [],
    globalBudget: 0,
  };
  act(() => store.setState({ knowledgeReadEditor: otherDraft }));
  await userEvent.click(screen.getAllByRole("tab").at(-1) as HTMLElement);
  await act(async () => {});

  expect(read).toHaveBeenCalledWith(AGENT_ID);
  expect(read).not.toHaveBeenCalledWith(OTHER_AGENT_ID);
  // 全局编辑器对象原样保留且仍是脏的：页面读取没有碰它（选中别人会毁掉这份草稿）。
  expect(store.getState().knowledgeReadEditor).toBe(otherDraft);
  expect(knowledgeReadDirty(store.getState().knowledgeReadEditor)).toBe(true);
});

it("mcp 事实逐项镜像服务端判定：Agent 范围不匹配＝未授权；无需审批且 revision 兼容＝可用；revision 不匹配＝未授权", async () => {
  const view = await renderPage({
    getPermissions: vi.fn(async () =>
      permissions([], [{ resource: "mcp.alpha", revision: "rev-2", approvalRequired: false }]),
    ),
  });
  await userEvent.click(screen.getAllByRole("tab").at(-1) as HTMLElement);
  await act(async () => {});

  const upperOf = (capability: string) =>
    view.container
      .querySelector(`[data-capability="${capability}"] [data-upper]`)
      ?.getAttribute("data-upper");
  const setGrants = (grants: PermissionGrant[]) =>
    act(() =>
      store.setState({
        permissionEditor: {
          ...permissionEditorOf(),
          snapshot: {
            ...permissionEditorOf().snapshot,
            policy: { ...permissionEditorOf().snapshot.policy, grants },
          },
        },
      }),
    );

  // 授权只给别的 Agent，本群绑定的 Agent 不在范围内：未授权。
  setGrants([
    {
      resource: "mcp.alpha",
      approved: true,
      revision: "rev-2",
      agentIds: [OTHER_AGENT_ID],
      directories: [],
    },
  ]);
  expect(upperOf("mcp")).toBe("unauthorized");
  // 资源本身不要求审批：未批但 revision 兼容＝可用。
  setGrants([{ resource: "mcp.alpha", approved: false, revision: "rev-2", directories: [] }]);
  expect(upperOf("mcp")).toBe("on");
  // 资源说 rev-2、授权说 rev-old：不承诺可用。
  setGrants([{ resource: "mcp.alpha", approved: true, revision: "rev-old", directories: [] }]);
  expect(upperOf("mcp")).toBe("unauthorized");
});

it("保存 409 保住草稿且错误只显示一次；读取失败页只出现一条错误", async () => {
  const view = await renderPage({
    saveQqGroupConfig: vi.fn(async () => {
      throw new Error("本群配置已在别处修改，请刷新后重试。");
    }),
  });
  act(() => store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45"));
  await act(async () => {
    fireEvent.click(saveButtonOf(view));
  });
  const alerts = screen.getAllByRole("alert");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toContain("本群配置已在别处修改");
  expect(editorOf()?.overrides).toEqual({ rhythm: { merge_window_seconds: 45 } });

  cleanup();
  const failing = fakeClient({
    getQqGroupConfig: vi.fn(async () => {
      throw new Error("本群配置读取失败");
    }),
  });
  store.getState().resetForTests(failing);
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "qq-group-config" });
  await store.getState().selectQqGroupConfig(BINDING_ID);
  render(<QqGroupConfigPage />);
  await act(async () => {});
  const readAlerts = screen.getAllByRole("alert");
  expect(readAlerts).toHaveLength(1);
  expect(readAlerts[0]?.textContent).toContain("本群配置读取失败");
});

it("绑定已改绑其他 Agent：页内只说一次、保存禁用；放弃旧草稿后可显式重开读新 Agent 的配置", async () => {
  const read = vi
    .fn(async () => qqConfig({ binding: qqBinding({ agent_id: OTHER_AGENT_ID, revision: 9 }) }))
    .mockResolvedValueOnce(qqConfig());
  const view = await renderPage({ getQqGroupConfig: read });
  act(() => store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", "45"));
  await act(async () => {
    await store.getState().refreshQqGroupConfig();
  });

  // 改绑后旧草稿没有合法保存对象：钉住原样保留、保存禁用、页内只有一条告知。
  expect(editorOf()?.identityConflict).toBe(true);
  expect(editorOf()?.overrides).toEqual({ rhythm: { merge_window_seconds: 45 } });
  expect(screen.getAllByText("当前绑定已改绑其他 Agent")).toHaveLength(1);
  expect(saveButtonOf(view).disabled).toBe(true);
  const reopen = view.container.querySelector("[data-reopen-config]") as HTMLButtonElement;
  expect(reopen).toBeTruthy();

  // 放弃草稿：冲突标记留着（旧基线不会因此变新），但草稿清空，重开不再被守卫拦下。
  fireEvent.click(screen.getByRole("button", { name: "放弃改动" }));
  expect(editorOf()?.identityConflict).toBe(true);
  expect(qqGroupConfigDirty(editorOf())).toBe(false);

  // 目录里同一 id 已指向别的 Agent：显式重开清指针后重读，得到没有冲突标记的新编辑器。
  act(() =>
    store.setState({
      qqBindingsLoaded: true,
      qqBindings: [qqBinding({ agent_id: OTHER_AGENT_ID, revision: 9 })],
    }),
  );
  await act(async () => {
    fireEvent.click(reopen);
  });
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(3);
  expect(editorOf()?.identityConflict).toBeUndefined();
  expect(editorOf()?.source.binding.agent_id).toBe(OTHER_AGENT_ID);
});

it("变更预览：布尔显示为开/关、不暴露 true/false 与机器字段名；钉住/取消的差别由徽标标出", async () => {
  await renderPage({
    getQqGroupConfig: vi.fn(async () =>
      qqConfig({ overrides: { rhythm: { merge_window_seconds: 30 } } }),
    ),
  });
  act(() => {
    // 取消钉住（回到跟随）与布尔显式钉住：值都可能与基线相同，差别要用徽标看清。
    store.getState().patchQqGroupOverride("rhythm", "merge_window_seconds", undefined);
    store.getState().patchQqGroupOverride("triggers", "direct_reply", false);
  });
  fireEvent.click(screen.getByRole("button", { name: "预览变更" }));

  const dialog = await screen.findByRole("dialog");
  const pins = [...dialog.querySelectorAll("[data-pin-state]")].map((node) =>
    node.getAttribute("data-pin-state"),
  );
  expect(pins).toContain("follow");
  expect(pins).toContain("custom");

  const text = dialog.textContent ?? "";
  expect(text).toContain("开");
  expect(text).toContain("关");
  expect(text).not.toContain("true");
  expect(text).not.toContain("false");
  expect(text).not.toContain("rhythm.merge_window_seconds");
  expect(text).not.toContain("triggers.direct_reply");
});

it("0052 新两组接入：枚举/数字/时区与嵌套 stages 钉住进真实 store 载荷，follow 才取消", async () => {
  const view = await renderPage();
  await userEvent.click(screen.getByRole("tab", { name: "消息读取" }));

  const depth = view.container.querySelector(
    'input[data-field="message_settings.reply_depth"]',
  ) as HTMLInputElement;
  expect(depth).toBeTruthy();
  fireEvent.change(depth, { target: { value: "4" } });
  expect(editorOf()?.overrides).toEqual({ message_settings: { reply_depth: 4 } });
  // 与基线同值（2）也是显式钉住：仍然 dirty。
  fireEvent.change(depth, { target: { value: "2" } });
  expect(editorOf()?.overrides).toEqual({ message_settings: { reply_depth: 2 } });
  expect(qqGroupConfigDirty(editorOf())).toBe(true);

  const timeSelect = view.container.querySelector(
    'select[data-field="message_settings.time_display"]',
  ) as HTMLSelectElement;
  expect(timeSelect).toBeTruthy();
  fireEvent.change(timeSelect, { target: { value: "full" } });
  expect(editorOf()?.overrides.message_settings).toMatchObject({
    reply_depth: 2,
    time_display: "full",
  });

  const timezone = view.container.querySelector(
    'input[data-field="message_settings.timezone"]',
  ) as HTMLInputElement;
  expect(timezone).toBeTruthy();
  fireEvent.change(timezone, { target: { value: "Asia/Tokyo" } });
  expect(editorOf()?.overrides.message_settings).toMatchObject({ timezone: "Asia/Tokyo" });

  // 嵌套 stages：图片理解组里逐阶段钉住；follow 只取消这一个阶段。
  await userEvent.click(screen.getByRole("tab", { name: "图片理解" }));
  const mode = view.container.querySelector(
    'select[data-field="media_input.mode"]',
  ) as HTMLSelectElement;
  expect(mode).toBeTruthy();
  fireEvent.change(mode, { target: { value: "description" } });
  const stage = view.container.querySelector(
    'select[data-field="media_input.stages.evaluation"]',
  ) as HTMLSelectElement;
  expect(stage).toBeTruthy();
  fireEvent.change(stage, { target: { value: "off" } });
  expect(editorOf()?.overrides.media_input).toMatchObject({
    mode: "description",
    stages: { evaluation: false },
  });
  const maxImages = view.container.querySelector(
    'input[data-field="media_input.max_images"]',
  ) as HTMLInputElement;
  expect(maxImages).toBeTruthy();
  fireEvent.change(maxImages, { target: { value: "6" } });
  expect(editorOf()?.overrides.media_input).toMatchObject({ max_images: 6 });
  fireEvent.change(stage, { target: { value: "inherit" } });
  expect(editorOf()?.overrides.media_input?.stages).toBeUndefined();
  expect(editorOf()?.overrides.media_input).toMatchObject({ mode: "description" });
});

it("普通静图规格：null 是显式钉住原图（与基线同值也 dirty）、0 拒绝留原文拦保存、follow 才取消", async () => {
  const view = await renderPage();
  await userEvent.click(screen.getByRole("tab", { name: "图片理解" }));
  const choice = view.container.querySelector(
    'select[data-field="media_input.ordinary_still_max_dimension.choice"]',
  ) as HTMLSelectElement;
  expect(choice).toBeTruthy();
  const input = view.container.querySelector(
    'input[data-field="media_input.ordinary_still_max_dimension"]',
  ) as HTMLInputElement;
  expect(input).toBeTruthy();
  // 基线是 null（原图）：选「限制长边」从契约下限起步（不是 0）。
  fireEvent.change(choice, { target: { value: "limited" } });
  expect(editorOf()?.overrides.media_input).toMatchObject({ ordinary_still_max_dimension: 64 });
  // 0 不是原图的编码：非法原文留底、拦保存。
  fireEvent.change(input, { target: { value: "0" } });
  expect(editorOf()?.rawTexts).toEqual({ "media_input.ordinary_still_max_dimension": "0" });
  expect(saveButtonOf(view).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "800" } });
  expect(editorOf()?.overrides.media_input).toMatchObject({ ordinary_still_max_dimension: 800 });
  expect(editorOf()?.rawTexts).toEqual({});
  // 选「原图」＝显式 null 钉住（不是 undefined 取消）；与基线同值也 dirty。
  fireEvent.change(choice, { target: { value: "original" } });
  expect(editorOf()?.overrides.media_input).toMatchObject({ ordinary_still_max_dimension: null });
  expect(qqGroupConfigDirty(editorOf())).toBe(true);
  // follow 才是取消钉住：字段从 overrides 消失，没有其他钉住时不 dirty。
  const fieldEl = view.container
    .querySelector('input[data-field="media_input.ordinary_still_max_dimension"]')
    ?.closest('[data-slot="field"]') as HTMLElement;
  const stateSelect = [...fieldEl.querySelectorAll("select")].find(
    (node) => node.getAttribute("data-field-state") !== null,
  ) as HTMLSelectElement;
  fireEvent.change(stateSelect, { target: { value: "follow" } });
  expect(editorOf()?.overrides.media_input?.ordinary_still_max_dimension).toBeUndefined();
  expect(qqGroupConfigDirty(editorOf())).toBe(false);
});

it("非法时区保稿并拒保存、修正后可保存；one_then_on_demand 层数禁用但保稿，切回按层数恢复可编辑", async () => {
  const view = await renderPage();
  await userEvent.click(screen.getByRole("tab", { name: "消息读取" }));
  const timezone = view.container.querySelector(
    'input[data-field="message_settings.timezone"]',
  ) as HTMLInputElement;
  fireEvent.change(timezone, { target: { value: "Mars/Olympus" } });
  expect(editorOf()?.rawTexts).toEqual({ "message_settings.timezone": "Mars/Olympus" });
  expect(screen.queryAllByRole("alert")).toEqual([]);
  fireEvent.blur(timezone);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(saveButtonOf(view).disabled).toBe(true);
  fireEvent.change(timezone, { target: { value: "Asia/Tokyo" } });
  expect(editorOf()?.rawTexts).toEqual({});
  expect(editorOf()?.overrides.message_settings).toMatchObject({ timezone: "Asia/Tokyo" });
  expect(saveButtonOf(view).disabled).toBe(false);

  // 基线 one_then_on_demand：层数不用于自动展开＝输入禁用，但钉住的配置值保留。
  const depth = view.container.querySelector(
    'input[data-field="message_settings.reply_depth"]',
  ) as HTMLInputElement;
  expect(depth.disabled).toBe(true);
  fireEvent.change(depth, { target: { value: "4" } });
  expect(depth.value).toBe("4");
  expect(editorOf()?.overrides.message_settings).toMatchObject({
    reply_depth: 4,
    timezone: "Asia/Tokyo",
  });
  const replyMode = view.container.querySelector(
    'select[data-field="message_settings.reply_mode"]',
  ) as HTMLSelectElement;
  fireEvent.change(replyMode, { target: { value: "configured_depth" } });
  const depthAfter = view.container.querySelector(
    'input[data-field="message_settings.reply_depth"]',
  ) as HTMLInputElement;
  expect(depthAfter.disabled).toBe(false);
});

it("刷新保稿：0052 新两组本地钉住按三路合并保留，不被服务端旧值回退", async () => {
  const read = vi.fn(async () => qqConfig());
  const view = await renderPage({ getQqGroupConfig: read });
  await userEvent.click(screen.getByRole("tab", { name: "消息读取" }));
  act(() => {
    store.getState().patchQqGroupOverride("media_input", "mode", "description");
    store.getState().patchQqGroupOverride("message_settings", "reply_depth", "3");
  });
  // 服务端出现了别的改动（别人钉了 6 层）：本地动过的字段保留本地值。
  read.mockImplementation(async () =>
    qqConfig({ overrides: { message_settings: { reply_depth: 6 } }, revision: 2 }),
  );
  await act(async () => {
    await store.getState().refreshQqGroupConfig();
  });
  expect(editorOf()?.overrides.message_settings).toMatchObject({ reply_depth: 3 });
  expect(editorOf()?.overrides.media_input).toMatchObject({ mode: "description" });
  const depth = view.container.querySelector(
    'input[data-field="message_settings.reply_depth"]',
  ) as HTMLInputElement;
  expect(depth.value).toBe("3");
});

it("变更预览：0052 字段人话显示——阶段布尔开/关、枚举选项名、null 原图；不暴露机器值", async () => {
  await renderPage();
  act(() => {
    store.getState().patchQqGroupOverride("media_input", "stages.evaluation", false);
    store.getState().patchQqGroupOverride("media_input", "mode", "description");
    store.getState().patchQqGroupOverride("media_input", "ordinary_still_max_dimension", null);
    store.getState().patchQqGroupOverride("message_settings", "reply_mode", "configured_depth");
  });
  fireEvent.click(screen.getByRole("button", { name: "预览变更" }));
  const dialog = await screen.findByRole("dialog");
  const text = dialog.textContent ?? "";
  expect(text).toContain("评估阶段");
  expect(text).toContain("关");
  expect(text).toContain("文字描述缓存");
  expect(text).toContain("原图");
  expect(text).toContain("按层数自动展开引用");
  expect(text).not.toContain("true");
  expect(text).not.toContain("false");
  expect(text).not.toContain("null");
});

it("换方案预览：嵌套 stage 展开成逐阶段人话行、目标基线走同一嵌套路径；keep 后载荷 stage 仍 false，reset 丢 override，取消零 PUT", async () => {
  const target = qqScheme({
    id: TARGET_SCHEME_ID,
    name: "新方案",
    revision: 7,
    media_input: {
      ...qqScheme().media_input,
      stages: { decision: false, evaluation: true, generation: false },
    },
  });
  const { fake, container } = await renderPage({
    listQqSchemes: vi.fn(async () => [qqScheme(), target]),
  });
  await userEvent.click(screen.getByRole("tab", { name: "图片理解" }));
  const stage = container.querySelector(
    'select[data-field="media_input.stages.evaluation"]',
  ) as HTMLSelectElement;
  fireEvent.change(stage, { target: { value: "off" } });
  const select = container.querySelector('select[data-field="scheme.switch"]') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: TARGET_SCHEME_ID } });

  const dialog = await screen.findByRole("dialog");
  // 没有 stages 对象父行；只有真实钉住的叶子阶段行，人话显示（钉住关 → 目标开）。
  expect(dialog.querySelector('[data-switch-row="media_input.stages"]')).toBeNull();
  const row = dialog.querySelector(
    '[data-switch-row="media_input.stages.evaluation"]',
  ) as HTMLElement;
  expect(row).toBeTruthy();
  expect(row.textContent).toContain("评估阶段");
  expect(row.textContent).toContain("关 → 开");
  expect(dialog.textContent ?? "").not.toContain("[object Object]");

  // 取消：预览零 PUT，草稿里的 stage 钉住原样保留。
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fake.saveQqGroupConfig).not.toHaveBeenCalled();
  expect(editorOf()?.overrides.media_input?.stages).toMatchObject({ evaluation: false });

  // keep：保存载荷里 stage 仍是真实 false，没有 media_input.stages 空对象父行。
  fireEvent.change(select, { target: { value: TARGET_SCHEME_ID } });
  const keepDialog = await screen.findByRole("dialog");
  fireEvent.click(keepDialog.querySelector('[data-switch-action="keep"]') as HTMLElement);
  await act(async () => {
    await store.getState().saveQqGroupConfig();
  });
  const payload = (fake.saveQqGroupConfig as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
    overrides: { media_input?: { stages?: Record<string, unknown> } };
  };
  expect(payload?.overrides?.media_input?.stages).toEqual({ evaluation: false });

  // reset：本群 override 丢失（stage 回到跟随目标基线）。
  fireEvent.change(stage, { target: { value: "off" } });
  fireEvent.change(select, { target: { value: TARGET_SCHEME_ID } });
  const resetDialog = await screen.findByRole("dialog");
  fireEvent.click(resetDialog.querySelector('[data-switch-action="reset"]') as HTMLElement);
  expect(editorOf()?.overrides.media_input?.stages).toBeUndefined();
});

it("数字字段错误提示有 id 且输入框 aria-describedby 指向该真实错误 DOM", async () => {
  const view = await renderPage();
  const input = view.container.querySelector(
    'input[data-field="rhythm.hourly_speech_limit"]',
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "3000" } });
  fireEvent.blur(input);
  const fieldEl = input.closest('[data-slot="field"]') as HTMLElement;
  const alert = within(fieldEl).getByRole("alert");
  expect(alert.id).not.toBe("");
  // Field 组件会把自己 info 描述的 id 追加在后面；错误 DOM 的 id 必须真实出现在关联列表里。
  expect((input.getAttribute("aria-describedby") ?? "").split(" ")).toContain(alert.id);
});

it("普通静图规格：Field 标题以 htmlFor 关联选择框，数值框独立 aria-label 且错误 describedby 指真实 DOM", async () => {
  const view = await renderPage();
  await userEvent.click(screen.getByRole("tab", { name: "图片理解" }));
  const choice = view.container.querySelector(
    'select[data-field="media_input.ordinary_still_max_dimension.choice"]',
  ) as HTMLSelectElement;
  expect(choice).toBeTruthy();
  // Field 标题（普通静图规格）用 label[for] 关联选择框。
  const title = [...view.container.querySelectorAll("label")].find(
    (node) => node.htmlFor === choice.id && node.textContent?.includes("普通静图规格"),
  );
  expect(title).toBeTruthy();
  // 数值框保留独立 aria-label「普通静图长边上限」。
  const input = view.container.querySelector(
    'input[data-field="media_input.ordinary_still_max_dimension"]',
  ) as HTMLInputElement;
  expect(input.getAttribute("aria-label")).toBe("普通静图长边上限");
  // 0 非法 → blur 后错误出现，aria-describedby 指向该错误 DOM。
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.blur(input);
  const alert = within(input.closest('[data-slot="field"]') as HTMLElement).getByRole("alert");
  expect(input.getAttribute("aria-describedby")).toBe(alert.id);
});

it("模型输入示例按生效值渲染，随本群时区改写与恢复跟随更新且只读", async () => {
  const view = await renderPage();
  await userEvent.click(screen.getByRole("tab", { name: "消息读取" }));
  // 基础方案默认 hybrid/Asia/Shanghai：示例存在且只读，头部是该时区与冻结 now。
  const preview = () =>
    view.container.querySelector("[data-qq-message-preview] pre")?.textContent ?? "";
  expect(preview()).toContain("now=2026-10-02 00:00:00，timezone=Asia/Shanghai");
  const block = view.container.querySelector("[data-qq-message-preview]") as HTMLElement;
  expect(block.querySelector("input, textarea, select, button")).toBeNull();

  // 本群改写时区为 Asia/Tokyo：示例按**合并后的生效值**更新（不是未 merge 的原 base）。
  const timezone = view.container.querySelector(
    'input[data-field="message_settings.timezone"]',
  ) as HTMLInputElement;
  fireEvent.change(timezone, { target: { value: "Asia/Tokyo" } });
  expect(preview()).toContain("timezone=Asia/Tokyo");
  // follow 回基础方案：示例回到基础方案的时区。
  fireEvent.change(timezone, { target: { value: "Asia/Shanghai" } });
  const stateSelect = [
    ...(timezone.closest('[data-slot="field"]') as HTMLElement).querySelectorAll("select"),
  ].find((node) => node.getAttribute("data-field-state") !== null) as HTMLSelectElement;
  fireEvent.change(stateSelect, { target: { value: "follow" } });
  expect(preview()).toContain("timezone=Asia/Shanghai");
});

it("页首返回群目录；查看会话是显式按钮且只认同一绑定、同一助手的摘要", async () => {
  const view = await renderPage();
  const nav = vi.fn(async () => {});
  const openChat = vi.fn();
  act(() => {
    store.setState({
      requestConversationNavigation: nav,
      openChat,
      summaryById: {
        wrong: {
          id: "wrong",
          sourceId: BINDING_ID,
          agentId: OTHER_AGENT_ID,
          title: "旧助手会话",
        } as unknown as ConversationSummary,
        right: {
          id: "right",
          sourceId: BINDING_ID,
          agentId: AGENT_ID,
          title: "本群会话",
        } as unknown as ConversationSummary,
      },
    });
  });

  // 页首左侧返回动作落到群目录。
  fireEvent.click(view.container.querySelector("header button") as HTMLElement);
  expect(store.getState().settingsRoute).toBe("qq-app-groups");

  // 查看会话是显式按钮：目标只落在同一绑定、同一助手的摘要上。
  const header = view.container.querySelector("header") as HTMLElement;
  const viewButton = () => within(header).getByRole("button", { name: "查看会话" });
  fireEvent.click(viewButton());
  expect(nav).toHaveBeenCalledWith("right");
  expect(nav).not.toHaveBeenCalledWith("wrong");
  expect(openChat).not.toHaveBeenCalled();

  // 只剩旧助手的摘要：不渲染按钮，也没有 openChat 兜底假目标。
  act(() =>
    store.setState({
      summaryById: {
        wrong: {
          id: "wrong",
          sourceId: BINDING_ID,
          agentId: OTHER_AGENT_ID,
          title: "旧助手会话",
        } as unknown as ConversationSummary,
      },
    }),
  );
  expect(within(header).queryByRole("button", { name: "查看会话" })).toBeNull();
  expect(openChat).not.toHaveBeenCalled();
  // 没有新导航：只有第一阶段的合法 "right" 那一次。
  expect(nav).toHaveBeenCalledTimes(1);

  const save = saveButtonOf(view);
  expect(save.className).toContain("min-h-8");
  expect(save.className).toContain("whitespace-normal");
});

it("页首选群器列出全部已绑定群（同绑定摘要标题+群号），换群走统一守卫；取消保留原草稿", async () => {
  const view = await renderPage();
  const otherId = "77777777-7777-4777-8777-777777777777";
  const otherBinding = { ...qqBinding(), id: otherId, peer_id: "987654321" };
  act(() => {
    store.setState({
      // 选群器共用目录投影：目录必须处于已预热（loaded）状态。
      qqBindings: [qqBinding(), otherBinding],
      qqBindingsLoaded: true,
      summaryById: {
        s1: {
          id: "s1",
          sourceId: BINDING_ID,
          agentId: AGENT_ID,
          title: "本群会话",
        } as unknown as ConversationSummary,
      },
    });
  });
  const header = view.container.querySelector("header") as HTMLElement;
  const switcher = within(header).getByLabelText("切换群") as HTMLSelectElement;
  const optionTexts = () => [...switcher.options].map((option) => option.textContent);
  expect(optionTexts().join("\n")).toContain("本群会话 (123456789)");
  expect(optionTexts().join("\n")).toContain("987654321");

  // 换群同样过统一守卫：草稿未决不换编辑器，确认框挂着待选目标。
  const mergeInput = view.container.querySelector(
    'input[data-field="rhythm.merge_window_seconds"]',
  ) as HTMLInputElement;
  fireEvent.change(mergeInput, { target: { value: "33" } });
  expect(editorOf()?.overrides).toEqual({ rhythm: { merge_window_seconds: 33 } });
  fireEvent.change(switcher, { target: { value: otherId } });
  await act(async () => {});
  expect(store.getState().navigationConfirmOpen).toBe(true);
  expect(store.getState().pendingNavigation).toMatchObject({
    kind: "group-config",
    bindingId: otherId,
  });
  act(() => store.getState().cancelPendingNavigation());
  expect(editorOf()?.source.binding.id).toBe(BINDING_ID);
  expect(store.getState().qqGroupConfigBindingId).toBe(BINDING_ID);
  expect(store.getState().navigationConfirmOpen).toBe(false);
});

describe("性能阶段补测：窄订阅行为保持（FE-P1, group-config）", () => {
  it("与本页无关的 store 更新不重渲染本群配置页；本页读取字段更新仍正常刷新", async () => {
    const view = await renderPage();
    // 无关更新：memoryCorrectionSaving 不是本页读取字段 → 窄订阅不得重渲染。
    const htmlBefore = document.body.innerHTML;
    await act(async () => {
      store.setState({ memoryCorrectionSaving: true });
    });
    expect(document.body.innerHTML).toBe(htmlBefore);
    // 本页读取字段更新：qqSchemes 变化 → 换方案预览下拉必须反映新方案。
    const extra = qqScheme({ id: "88888888-8888-4888-8888-888888888888", name: "新到基线方案" });
    await act(async () => {
      store.setState({ qqSchemes: [qqScheme(), extra] });
    });
    const options = [...document.querySelectorAll("select option")].map((o) => o.textContent);
    expect(options).toContain("新到基线方案");
    // 覆盖输入仍即时生效（必要 UI 更新保持）。
    const mergeInput = view.container.querySelector(
      'input[data-field="rhythm.merge_window_seconds"]',
    ) as HTMLInputElement;
    fireEvent.change(mergeInput, { target: { value: "33" } });
    expect(editorOf()?.overrides).toEqual({ rhythm: { merge_window_seconds: 33 } });
  });
});

it("回复方式组的 max_recompute_count（再生成预算）可钉住进本群覆盖，follow 取消；字段在 response 分组渲染", async () => {
  const view = await renderPage();
  // 回复方式组：max_recompute_count 由 responseFields 渲染（不再是参与组的主动门槛）。
  await userEvent.click(screen.getByRole("tab", { name: "回复方式" }));
  const recompute = view.container.querySelector(
    'input[data-field="rhythm.max_recompute_count"]',
  ) as HTMLInputElement;
  expect(recompute).toBeTruthy();
  const state = fieldOf(view, "rhythm.max_recompute_count").getByRole(
    "combobox",
  ) as HTMLSelectElement;
  fireEvent.change(state, { target: { value: "custom" } });
  expect((recompute as HTMLInputElement).value).toBe("1");
  expect(editorOf()?.overrides).toEqual({ rhythm: { max_recompute_count: 1 } });
  fireEvent.change(state, { target: { value: "follow" } });
  expect(editorOf()?.overrides).toEqual({});
});

it("renders rhythm batch fields and queue on busy three-state override in participation group", async () => {
  const view = await renderPage();
  await userEvent.click(screen.getByRole("tab", { name: "发言时机" }));

  // initiative_queue_on_busy 作为三态开关
  const queueSelect = view.container.querySelector(
    'select[data-field="rhythm.initiative_queue_on_busy"]',
  ) as HTMLSelectElement;
  expect(queueSelect).toBeTruthy();
  expect(queueSelect.value).toBe("inherit");

  // 切换为自定义开启
  fireEvent.change(queueSelect, { target: { value: "on" } });
  expect(editorOf()?.overrides.rhythm?.initiative_queue_on_busy).toBe(true);

  // 切换为跟随方案
  fireEvent.change(queueSelect, { target: { value: "inherit" } });
  expect(editorOf()?.overrides.rhythm?.initiative_queue_on_busy).toBeUndefined();

  // 目标消息数与浮动消息数数字输入框就位
  const targetInput = view.container.querySelector(
    'input[data-field="rhythm.initiative_batch_target_count"]',
  ) as HTMLInputElement;
  const jitterInput = view.container.querySelector(
    'input[data-field="rhythm.initiative_batch_jitter_count"]',
  ) as HTMLInputElement;
  expect(targetInput).toBeTruthy();
  expect(jitterInput).toBeTruthy();

  // initiative_time_window_enabled 三态开关：基线为开启时跟随基线不展示未启用提示
  const timeWindowSelect = view.container.querySelector(
    'select[data-field="rhythm.initiative_time_window_enabled"]',
  ) as HTMLSelectElement;
  expect(timeWindowSelect).toBeTruthy();
  expect(timeWindowSelect.value).toBe("inherit");
  expect(screen.queryByText(/时间窗口未启用，以下数值保存但不触发判定/)).toBeNull();

  // 显式覆盖为关闭：展示未启用提示，但目标/浮动时间输入框依然可编辑（支持预配置）且未被禁用
  fireEvent.change(timeWindowSelect, { target: { value: "off" } });
  expect(editorOf()?.overrides.rhythm?.initiative_time_window_enabled).toBe(false);
  expect(screen.getByText(/时间窗口未启用，以下数值保存但不触发判定/)).toBeTruthy();

  // 目标时间与浮动时间输入框就位且未被禁用
  const targetTimeInput = view.container.querySelector(
    'input[data-field="rhythm.initiative_time_target_seconds"]',
  ) as HTMLInputElement;
  const jitterTimeInput = view.container.querySelector(
    'input[data-field="rhythm.initiative_time_jitter_seconds"]',
  ) as HTMLInputElement;
  expect(targetTimeInput).toBeTruthy();
  expect(jitterTimeInput).toBeTruthy();
  expect(targetTimeInput.disabled).toBe(false);
  expect(jitterTimeInput.disabled).toBe(false);

  // 显式覆盖为开启：提示消失
  fireEvent.change(timeWindowSelect, { target: { value: "on" } });
  expect(screen.queryByText(/时间窗口未启用，以下数值保存但不触发判定/)).toBeNull();

  // 切回跟随基线：基线为开启，提示保持不展示
  fireEvent.change(timeWindowSelect, { target: { value: "inherit" } });
  expect(screen.queryByText(/时间窗口未启用，以下数值保存但不触发判定/)).toBeNull();
});

it("displays disabled notice when group inherits a scheme with time window disabled", async () => {
  const disabledBaseScheme = qqScheme({
    rhythm: { ...qqScheme().rhythm, initiative_time_window_enabled: false },
  });
  const view = await renderPage({
    getQqGroupConfig: vi.fn(async () =>
      qqConfig({
        base_scheme: disabledBaseScheme,
        effective_scheme: disabledBaseScheme,
      }),
    ),
  });
  await userEvent.click(screen.getByRole("tab", { name: "发言时机" }));

  const timeWindowSelect = view.container.querySelector(
    'select[data-field="rhythm.initiative_time_window_enabled"]',
  ) as HTMLSelectElement;
  expect(timeWindowSelect.value).toBe("inherit");
  // 基线为关闭时，跟随基线必须展示未启用提示
  expect(screen.getByText(/时间窗口未启用，以下数值保存但不触发判定/)).toBeTruthy();

  // 显式开启：覆盖基线后提示消失
  fireEvent.change(timeWindowSelect, { target: { value: "on" } });
  expect(screen.queryByText(/时间窗口未启用，以下数值保存但不触发判定/)).toBeNull();

  // 显式关闭：依然展示未启用提示
  fireEvent.change(timeWindowSelect, { target: { value: "off" } });
  expect(screen.getByText(/时间窗口未启用，以下数值保存但不触发判定/)).toBeTruthy();
});

it("does not show time window disabled notice when inheriting unread scheme, but shows on explicit off", async () => {
  const view = await renderPage();
  await userEvent.click(screen.getByRole("tab", { name: "发言时机" }));

  // 切换待选目标方案未读取（schemeId 存在但不在 state.qqSchemes 中）：
  // pendingTarget 为 null，baseScheme/baseBag 为 null（即 base === null，基线为“未读”）
  act(() => {
    store.getState().patchQqGroupConfigScheme("unloaded-scheme-id", "keep");
  });

  const timeWindowSelect = view.container.querySelector(
    'select[data-field="rhythm.initiative_time_window_enabled"]',
  ) as HTMLSelectElement;
  expect(timeWindowSelect).toBeTruthy();
  expect(timeWindowSelect.value).toBe("inherit");

  // 基线为未读 (base === null) 且处于跟随 (inherit) 时，继承 UNKNOWN 不应提示时间窗口未启用
  expect(screen.queryByText(/时间窗口未启用，以下数值保存但不触发判定/)).toBeNull();

  // 显式覆盖为关闭：即便基线未读，明确选择关闭仍须展示未启用提示
  fireEvent.change(timeWindowSelect, { target: { value: "off" } });
  expect(screen.getByText(/时间窗口未启用，以下数值保存但不触发判定/)).toBeTruthy();

  // 显式覆盖为开启：提示不展示
  fireEvent.change(timeWindowSelect, { target: { value: "on" } });
  expect(screen.queryByText(/时间窗口未启用，以下数值保存但不触发判定/)).toBeNull();

  // 切回跟随：回到基线未读状态，提示再次隐藏
  fireEvent.change(timeWindowSelect, { target: { value: "inherit" } });
  expect(screen.queryByText(/时间窗口未启用，以下数值保存但不触发判定/)).toBeNull();
});

it("enforces mutual exclusivity between follow_up and chiming_in switches in group config", async () => {
  const view = await renderPage();
  await userEvent.click(screen.getByRole("tab", { name: "发言时机" }));

  const followUpSelect = view.container.querySelector(
    'select[data-field="triggers.follow_up"]',
  ) as HTMLSelectElement;
  const chimingInSelect = view.container.querySelector(
    'select[data-field="triggers.chiming_in"]',
  ) as HTMLSelectElement;

  // 开启连续交谈：自动将自主接话置为 off
  fireEvent.change(followUpSelect, { target: { value: "on" } });
  expect(editorOf()?.overrides.triggers).toEqual({
    follow_up: true,
    chiming_in: false,
  });

  // 开启自主接话：自动将连续交谈置为 off
  fireEvent.change(chimingInSelect, { target: { value: "on" } });
  expect(editorOf()?.overrides.triggers).toEqual({
    follow_up: false,
    chiming_in: true,
  });

  // 恢复跟随：成对恢复
  fireEvent.change(chimingInSelect, { target: { value: "inherit" } });
  expect(editorOf()?.overrides.triggers?.follow_up).toBeUndefined();
  expect(editorOf()?.overrides.triggers?.chiming_in).toBeUndefined();
});
