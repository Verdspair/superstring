import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationSummarySchema } from "../../src/shared/contracts/conversation";
import { ApiError, type SuperstringApi } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { dirtyPages } from "../../src/web/features/agents/page-drafts";
import { knowledgeReadDirty } from "../../src/web/features/knowledge/types";
import { selectLocale } from "../../src/web/i18n";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, agent, B, D, setupLibrary } from "./helpers/library-fixture";

// 第三身份：当前会话绑定 C，编辑对象 B，新会话默认 A，三者互不混。
const C = "66666666-6666-4666-8666-666666666666";
const CONV = "conv-c";
const boundSummary = ConversationSummarySchema.parse({
  id: CONV,
  channel: "web",
  topology: "direct",
  sourceId: "session-c",
  agentId: C,
  bindingEpoch: 1,
  title: "Conversation C",
  participants: [],
  updatedAt: "2026-10-18T00:00:00.000Z",
  lastSeq: 0,
  consumedSeq: 0,
});

function setupWorkspace() {
  const client = setupLibrary({
    saveAgentKnowledgeRead: vi.fn(
      async (_id: string, body: Parameters<SuperstringApi["saveAgentKnowledgeRead"]>[1]) => ({
        revision: body.expected_revision + 1,
        config: structuredClone(body.config),
      }),
    ),
    updateAgent: vi.fn(),
    savePersona: vi.fn(),
  });
  store.setState({
    agents: [agent, { ...agent, id: B, name: "Agent B" }, { ...agent, id: C, name: "Agent C" }],
    selectedNewSessionAgentId: null,
    currentConversationId: CONV,
    summaryById: { [CONV]: boundSummary },
  });
  return client;
}

function cardOf(name: string) {
  const card = screen.getByText(name).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error(`missing card for ${name}`);
  return card;
}

/** 打开 B 的工作室并真实点击进入 access tab，等首次读取基线完成。 */
async function openStudioAccessTab() {
  const user = userEvent.setup();
  await act(async () =>
    render(
      <DesignSystemProvider>
        <AssistantWorkspace active />
      </DesignSystemProvider>,
    ),
  );
  await act(async () => {});
  await user.click(screen.getByRole("button", { name: "所有 Agent" }));
  await user.click(within(cardOf("Agent B")).getByRole("button", { name: "打开工作室" }));
  await act(async () => {});
  expect(store.getState().pageEditor?.agent.id).toBe(B);
  await user.click(screen.getByRole("tab", { name: "资料读取" }));
  await act(async () => {});
  return user;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectLocale("zh-CN");
});

it("选当前Agent打开studio后access真实click选中持久；编辑对象/新会话默认/当前会话绑定三身份不混", async () => {
  const client = setupWorkspace();
  const user = userEvent.setup();
  await act(async () =>
    render(
      <DesignSystemProvider>
        <AssistantWorkspace active />
      </DesignSystemProvider>,
    ),
  );
  await act(async () => {});
  expect(store.getState().pageEditor?.agent.id).toBe(A);
  await user.click(screen.getByRole("button", { name: "所有 Agent" }));
  // 新会话默认是独立身份：点击不改编辑对象。
  await user.click(within(cardOf("Agent A")).getByRole("button", { name: "设为新对话默认" }));
  expect(store.getState().selectedNewSessionAgentId).toBe(A);
  expect(store.getState().pageEditor?.agent.id).toBe(A);
  // 打开 B 的工作室：编辑对象切到 B，另两个身份不被吸收。
  await user.click(within(cardOf("Agent B")).getByRole("button", { name: "打开工作室" }));
  await act(async () => {});
  expect(store.getState().pageEditor?.agent.id).toBe(B);
  expect(store.getState().selectedNewSessionAgentId).toBe(A);
  expect(store.getState().currentConversationId).toBe(CONV);
  expect(store.getState().summaryById[CONV]?.agentId).toBe(C);
  // access tab 真实 click 后选中持久，不被 identity 路由 effect 弹回。
  await user.click(screen.getByRole("tab", { name: "资料读取" }));
  expect(screen.getByRole("tab", { name: "资料读取" }).getAttribute("aria-selected")).toBe("true");
  await act(async () => {});
  expect(screen.getByRole("tab", { name: "资料读取" }).getAttribute("aria-selected")).toBe("true");
  // access 内容为真实复用组件：记忆读取摘要 + 知识访问编辑器，读取配置挂在编辑对象 B。
  expect(screen.getByRole("heading", { name: "Agent 配置 · Agent B" })).toBeTruthy();
  expect(screen.getByText("知识访问")).toBeTruthy();
  expect(store.getState().knowledgeReadEditor?.agentId).toBe(B);
  // 走一次 identity 路由 effect 路径：identity→access 往返仍不弹回。
  await user.click(screen.getByRole("tab", { name: "人设表达" }));
  await user.click(screen.getByRole("tab", { name: "资料读取" }));
  await act(async () => {});
  expect(screen.getByRole("tab", { name: "资料读取" }).getAttribute("aria-selected")).toBe("true");
  expect(store.getState().editorAgentId).toBe(B);
  expect(client.saveAgentKnowledgeRead).not.toHaveBeenCalled();
});

it("access内编辑knowledgeRead并真实save不夹Agent identity dirty；CAS失败草稿保留", async () => {
  const client = setupWorkspace();
  await openStudioAccessTab();
  const user = userEvent.setup();
  const state = () => store.getState();
  const editor = () => state().knowledgeReadEditor;
  expect(editor()?.agentId).toBe(B);
  // 真实控件：启用开关 + 读取范围 + 指定资料勾选。
  await user.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
  fireEvent.change(screen.getByLabelText("读取范围"), { target: { value: "selected" } });
  await user.click(screen.getByRole("checkbox", { name: "Reference" }));
  expect(editor()?.draft).toEqual({
    enabled: false,
    context_budget: null,
    scope: "selected",
    document_ids: [D],
  });
  // 不夹 Agent identity dirty：identity/persona 页干净，全局 dirty 徽标不亮。
  const pageEditor = state().pageEditor;
  if (!pageEditor) throw new Error("missing pageEditor");
  expect(dirtyPages(pageEditor)).not.toContain("identity");
  expect(state().dirty).toBe(false);
  expect(screen.queryByText("有未保存的修改")).toBeNull();
  expect(client.updateAgent).not.toHaveBeenCalled();
  expect(client.savePersona).not.toHaveBeenCalled();
  // 真实 save：只提交 knowledgeRead，revision CAS 前进。
  await user.click(screen.getByRole("button", { name: "保存知识规则" }));
  await act(async () => {});
  expect(client.saveAgentKnowledgeRead).toHaveBeenCalledTimes(1);
  expect(client.saveAgentKnowledgeRead).toHaveBeenCalledWith(B, {
    expected_revision: 1,
    config: { enabled: false, context_budget: null, scope: "selected", document_ids: [D] },
  });
  expect(knowledgeReadDirty(editor())).toBe(false);
  // CAS 失败：409 revision conflict → 错误明示草稿保留，draft 与基线原样。
  vi.mocked(client.saveAgentKnowledgeRead).mockRejectedValueOnce(
    new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "conflict"),
  );
  await user.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
  expect(knowledgeReadDirty(editor())).toBe(true);
  await user.click(screen.getByRole("button", { name: "保存知识规则" }));
  await act(async () => {});
  expect(
    screen
      .getAllByRole("alert")
      .some((alert) => alert.textContent?.includes("读取配置已被其他操作修改")),
  ).toBe(true);
  expect(editor()?.draft.enabled).toBe(true);
  expect(editor()?.draft.scope).toBe("selected");
  expect(editor()?.draft.document_ids).toEqual([D]);
  expect(editor()?.source.revision).toBe(2);
  expect(knowledgeReadDirty(editor())).toBe(true);
});

it("取消切换保留access活动视图与草稿；identity往返不重读读取保存基线（当前实际行为）", async () => {
  const client = setupWorkspace();
  await openStudioAccessTab();
  const user = userEvent.setup();
  const state = () => store.getState();
  const editor = () => state().knowledgeReadEditor;
  // 首次进入 access 恰好读一次基线（对象 B）。
  expect(vi.mocked(client.getAgentKnowledgeRead).mock.calls).toEqual([[B]]);
  await user.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
  expect(knowledgeReadDirty(editor())).toBe(true);
  // 读取草稿未决时切换 Agent 走统一守卫；取消后保留 access 活动视图与草稿。
  act(() => state().requestAgentNavigation(A));
  expect(state().navigationConfirmOpen).toBe(true);
  expect(state().pendingNavigation).toMatchObject({ kind: "agent", id: A });
  act(() => state().cancelPendingNavigation());
  expect(state().navigationConfirmOpen).toBe(false);
  expect(state().pendingNavigation).toBeNull();
  expect(state().editorAgentId).toBe(B);
  expect(screen.getByRole("tab", { name: "资料读取" }).getAttribute("aria-selected")).toBe("true");
  const enable = screen.getByRole("checkbox", { name: "启用知识读取" });
  expect(enable.getAttribute("aria-checked")).toBe("false");
  // identity→access 往返（当前实际行为，read-actions load）：脏草稿保留保存基线，
  // 不重发 getAgentKnowledgeRead；授权列表照常刷新；草稿值原样。
  await user.click(screen.getByRole("tab", { name: "人设表达" }));
  await user.click(screen.getByRole("tab", { name: "资料读取" }));
  await act(async () => {});
  expect(vi.mocked(client.getAgentKnowledgeRead).mock.calls).toEqual([[B]]);
  expect(client.listAgentKnowledge).toHaveBeenCalledTimes(2);
  expect(editor()?.agentId).toBe(B);
  expect(editor()?.draft.enabled).toBe(false);
  expect(knowledgeReadDirty(editor())).toBe(true);
  // identity 面板按 visited forceMount 保留在 DOM。
  expect(screen.getByRole("checkbox", { name: "启用 Agent" })).toBeTruthy();
});
