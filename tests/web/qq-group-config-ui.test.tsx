// 本群配置页（真实 store + fake API）：显式钉住、blur 报错、换方案预览、能力事实、409 与返回导航。
//
// 页面键文案随后由别的写者补进 locale：断言只看 data-* 标记、DOM 顺序与 store 状态，不依赖文案。

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

  // 装配冗余钉住初始化成整数百分比（0.05 → 输入 5）。
  await userEvent.click(screen.getByRole("tab", { name: "读取什么" }));
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

it("返回会话只认同一绑定、同一助手的摘要；页脚保存按钮允许换行且不矮于 32px", async () => {
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

  fireEvent.click(view.container.querySelector("header button") as HTMLElement);
  expect(nav).toHaveBeenCalledWith("right");
  expect(nav).not.toHaveBeenCalledWith("wrong");
  expect(openChat).not.toHaveBeenCalled();

  // 只剩旧助手的摘要时宁可回总入口，也不进错会话。
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
  fireEvent.click(view.container.querySelector("header button") as HTMLElement);
  expect(openChat).toHaveBeenCalledTimes(1);
  expect(nav).toHaveBeenCalledTimes(1);

  const save = saveButtonOf(view);
  expect(save.className).toContain("min-h-8");
  expect(save.className).toContain("whitespace-normal");
});
