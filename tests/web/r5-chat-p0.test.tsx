import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { P5ConfigSchema } from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";
import { ConversationIndex as Sidebar } from "../../src/web/screens/conversations/ConversationIndex";
import { DirectConversation as ChatPage } from "../../src/web/screens/conversations/DirectConversation";
import { useSuperstringStore as canonicalStore } from "../../src/web/store";
import { fixtureStore as useSuperstringStore } from "./helpers/chat-fixture";
import { render } from "./helpers/render-with-providers";

const NOW = "2026-09-12T03:00:00.000Z";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

function fakeClient(overrides: Partial<SuperstringApi> = {}): SuperstringApi {
  return overrides as SuperstringApi;
}

afterEach(() => cleanup());

beforeEach(() => {
  useSuperstringStore.getState().resetForTests(fakeClient());
  useSuperstringStore.setState({
    status: "ready",
    sessions: [
      {
        id: SESSION_ID,
        title: "测试会话",
        agent_id: "11111111-1111-4111-8111-111111111111",
        mode: "chat",
        config_version: 3,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    currentSessionId: SESSION_ID,
    messages: [
      {
        id: MESSAGE_ID,
        role: "user",
        content: "需要删除的消息",
        status: "completed",
        errorCode: null,
        createdAt: NOW,
        completedAt: NOW,
      },
    ],
    runtimeConfig: null,
  });
});

describe("聊天空白状态文案", () => {
  it("未选择会话时提供实际创建入口与助手目录", () => {
    useSuperstringStore.setState({
      sessions: [],
      currentSessionId: null,
      messages: [],
    });
    render(<ChatPage />);
    expect(screen.getByRole("button", { name: "新建对话" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "认识你的 Agent" })).toBeTruthy();
    expect(screen.queryByText("对话与记忆，留在你的本地工作空间")).toBeNull();
    expect(screen.getByRole("textbox", { name: "输入消息…" })).toBeTruthy();
  });

  it("已有空会话时不再提示新建会话", () => {
    useSuperstringStore.setState({ messages: [] });
    render(<ChatPage />);
    expect(screen.getByRole("heading", { name: "从一句话开始。" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "输入消息…" })).toBeTruthy();
    expect(screen.queryByText("点击“新建任务”，开启与 Agent 的对话。")).toBeNull();
  });
});

describe("R5 聊天区 P0 交互", () => {
  it("会话名称与绑定助手和模式分别呈现，消息保留角色", () => {
    useSuperstringStore.setState({
      runtimeConfig: {
        agent_id: "11111111-1111-4111-8111-111111111111",
        name: "测试助手",
        system_prompt: "",
        additional_instructions: "",
        model_name: "qwen/test",
        temperature: 0.7,
        memory_consolidation_model_name: "qwen/test",
        memory_consolidation_prompt: "整理",
        memory_consolidation_additional_instructions: "",
        memory_retrieval_model_name: "qwen/test",
        memory_retrieval_prompt: "检索",
        context_compression_model_name: "qwen/test",
        p5_config: P5ConfigSchema.parse({}),
        resolved_model_capacities: {},
        mode: "chat",
        config_version: 3,
        persona_intensity: 60,
      },
      messages: [
        {
          id: MESSAGE_ID,
          role: "assistant",
          content: "模型回复",
          status: "completed",
          errorCode: null,
          createdAt: NOW,
          completedAt: NOW,
        },
      ],
    });
    render(<ChatPage />);

    expect(screen.getByRole("heading", { name: "测试会话" })).toBeTruthy();
    expect(screen.getByText("Web · 私聊")).toBeTruthy();
    expect(screen.getAllByText("测试助手").length).toBeGreaterThan(0);
    expect(screen.getByText("聊天")).toBeTruthy();
    expect(screen.getByRole("article", { name: "消息 模型" })).toBeTruthy();
    expect(screen.getByText("qwen/test")).toBeTruthy();
  });

  it("无会话发送和删除均显示原版提示而不请求后端", async () => {
    const deleteSession = vi.fn();
    useSuperstringStore.setState({
      sessions: [],
      currentSessionId: null,
      composer: "你好",
      apiClient: fakeClient({ deleteSession }),
    });
    render(<ChatPage />);

    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.getByText("请先新建或选择会话")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除会话" })).toBeNull();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("生成期间显示独立且可访问的正在处理状态", () => {
    useSuperstringStore.setState({ sending: true });
    render(<ChatPage />);

    const processing = screen.getByRole("status", { name: "正在处理" });
    expect(processing.getAttribute("aria-live")).toBe("polite");
    expect(processing.getAttribute("aria-atomic")).toBe("true");
    expect(processing.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("其他异步操作期间也显示全局正在处理状态", () => {
    useSuperstringStore.setState({ pendingOperations: 1 });
    render(<ChatPage />);
    expect(screen.getByRole("status", { name: "正在处理" })).toBeTruthy();
  });

  it("非生成且无其他操作时不显示正在处理加载环", () => {
    render(<ChatPage />);
    expect(screen.queryByRole("status", { name: "正在处理" })).toBeNull();
  });

  it("只在右击消息后显示 menu/menuitem，并在取消确认后保留消息", async () => {
    const deleteMessage = vi.fn();
    useSuperstringStore.setState({ apiClient: fakeClient({ deleteMessage }) });
    render(<ChatPage />);

    expect(screen.queryByRole("menu", { name: "消息操作" })).toBeNull();
    fireEvent.contextMenu(screen.getByText("需要删除的消息"));
    expect(screen.getByRole("menu", { name: "消息操作" })).toBeTruthy();
    await userEvent.click(screen.getByRole("menuitem", { name: "删除消息" }));
    expect(screen.getByRole("alertdialog", { name: "确认删除这条消息？" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(screen.getByText("需要删除的消息")).toBeTruthy();
  });

  it("确认右键删除后调用当前会话消息 DELETE 并重新读取会话", async () => {
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    const listMessages = vi.fn().mockResolvedValue({ items: [], has_more: false });
    const getSessionRuntime = vi.fn().mockResolvedValue({
      agent_id: "11111111-1111-4111-8111-111111111111",
      name: "测试助手",
      system_prompt: "",
      additional_instructions: "",
      model_name: "qwen/test",
      temperature: 0.7,
      memory_consolidation_model_name: "qwen/test",
      memory_consolidation_prompt: "整理",
      memory_consolidation_additional_instructions: "",
      memory_retrieval_model_name: "qwen/test",
      memory_retrieval_prompt: "检索",
      context_compression_model_name: "qwen/test",
      p5_config: {},
      resolved_model_capacities: {},
      mode: "chat",
      config_version: 3,
      persona_intensity: 60,
    });
    useSuperstringStore.setState({
      apiClient: fakeClient({ deleteMessage, listMessages, getSessionRuntime }),
    });
    render(<ChatPage />);

    fireEvent.contextMenu(screen.getByText("需要删除的消息"));
    await userEvent.click(screen.getByRole("menuitem", { name: "删除消息" }));
    await userEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(deleteMessage).toHaveBeenCalledWith(SESSION_ID, MESSAGE_ID));
    expect(listMessages).toHaveBeenCalledWith(SESSION_ID, {});
  });

  it("会话菜单删除须确认目标，取消不请求后端", async () => {
    const deleteSession = vi.fn();
    useSuperstringStore.setState({ apiClient: fakeClient({ deleteSession }) });
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "测试会话" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "删除会话" }));
    expect(screen.getByRole("alertdialog", { name: "删除会话" })).toBeTruthy();
    expect(screen.getByText("删除「测试会话」及其全部消息？此操作无法撤销。")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("Escape 和外部 pointerdown 会关闭右键菜单", async () => {
    render(<ChatPage />);
    const bubble = screen.getByText("需要删除的消息");
    fireEvent.contextMenu(bubble);
    expect(screen.getByRole("menu", { name: "消息操作" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "消息操作" })).toBeNull();

    fireEvent.contextMenu(bubble);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "消息操作" })).toBeNull());
  });
});

describe("message menu confirmation origin", () => {
  it("pointer dropdown cancel returns to the exact original trigger with no DELETE", async () => {
    const deleteMessage = vi.fn();
    useSuperstringStore.setState({ apiClient: fakeClient({ deleteMessage }) });
    render(<ChatPage />);
    const article = screen.getByText("需要删除的消息").closest("article");
    if (!article) throw new Error("missing message article");
    const trigger = within(article).getByRole("button", { name: "消息操作" });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "删除消息" }));
    const dialog = await screen.findByRole("alertdialog", { name: "确认删除这条消息？" });
    await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.isConnected).toBe(true);
    expect(screen.getByText("需要删除的消息")).toBeTruthy();
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it.each(["ContextMenu", "{Shift>}{F10}{/Shift}"])(
    "keyboard %s cancellation returns to the actual context origin",
    async (key) => {
      const deleteMessage = vi.fn();
      useSuperstringStore.setState({ apiClient: fakeClient({ deleteMessage }) });
      render(<ChatPage />);
      const article = screen.getByText("需要删除的消息").closest("article");
      if (!article) throw new Error("missing message article");
      await userEvent.click(article);
      await userEvent.keyboard(key === "ContextMenu" ? "{ContextMenu}" : key);
      await userEvent.click(screen.getByRole("menuitem", { name: "删除消息" }));
      const dialog = await screen.findByRole("alertdialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
      await waitFor(() => expect(document.activeElement).toBe(article));
      expect(deleteMessage).not.toHaveBeenCalled();
    },
  );

  it("reopening another message changes only the origin and retains exact deletion identity", async () => {
    const deleteMessage = vi.fn();
    const secondId = "44444444-4444-4444-8444-444444444444";
    useSuperstringStore.setState({
      apiClient: fakeClient({ deleteMessage }),
      messages: [
        ...useSuperstringStore.getState().messages,
        {
          id: secondId,
          role: "assistant",
          content: "第二条消息",
          status: "completed",
          errorCode: null,
          createdAt: NOW,
          completedAt: NOW,
        },
      ],
    });
    render(<ChatPage />);
    for (const text of ["需要删除的消息", "第二条消息"]) {
      const article = screen.getByText(text).closest("article");
      if (!article) throw new Error("missing target article");
      const trigger = within(article).getByRole("button", { name: "消息操作" });
      await userEvent.click(trigger);
      await userEvent.click(screen.getByRole("menuitem", { name: "删除消息" }));
      await userEvent.click(screen.getByRole("button", { name: "取消" }));
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    }
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(screen.getByText("需要删除的消息")).toBeTruthy();
    expect(screen.getByText("第二条消息")).toBeTruthy();
  });
});

it.each(["session", "api", "inactive", "removed"] as const)(
  "message confirmation target and return origin do not survive %s replacement",
  async (change) => {
    const deleteMessage = vi.fn();
    useSuperstringStore.setState({ apiClient: fakeClient({ deleteMessage }) });
    const { rerender } = render(<ChatPage active />);
    const article = screen.getByText("需要删除的消息").closest("article");
    if (!article) throw new Error("missing message article");
    const trigger = within(article).getByRole("button", { name: "消息操作" });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "删除消息" }));
    await screen.findByRole("alertdialog");
    const focus = vi.spyOn(trigger, "focus");
    if (change === "inactive") rerender(<ChatPage active={false} />);
    else
      await act(async () => {
        if (change === "session")
          useSuperstringStore.setState({
            currentSessionId: "55555555-5555-4555-8555-555555555555",
            messages: [],
          });
        else if (change === "api")
          useSuperstringStore.setState({ apiClient: fakeClient({ deleteMessage: vi.fn() }) });
        else useSuperstringStore.setState({ messages: [] });
      });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await act(async () => {});
    expect(focus).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    if (change === "inactive") {
      rerender(<ChatPage active />);
      expect(screen.queryByRole("alertdialog")).toBeNull();
    }
  },
);

it("message menu confirmation submits only its snapshotted message and session", async () => {
  const deleteMessage = vi.fn().mockResolvedValue(undefined);
  const secondId = "44444444-4444-4444-8444-444444444444";
  const originalMessages = useSuperstringStore.getState().messages;
  useSuperstringStore.setState({
    apiClient: fakeClient({
      deleteMessage,
      listMessages: vi.fn().mockResolvedValue({ items: [], has_more: false }),
      getSessionRuntime: vi.fn().mockRejectedValue(new Error("runtime unavailable")),
    }),
    messages: [
      ...originalMessages,
      {
        id: secondId,
        role: "assistant",
        content: "确认目标消息",
        status: "completed",
        errorCode: null,
        createdAt: NOW,
        completedAt: NOW,
      },
    ],
  });
  render(<ChatPage />);
  const article = screen.getByText("确认目标消息").closest("article");
  if (!article) throw new Error("missing target article");
  await userEvent.click(within(article).getByRole("button", { name: "消息操作" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "删除消息" }));
  await act(async () =>
    useSuperstringStore.setState({
      messages: [
        { ...originalMessages[0], content: "新消息更新不换目标" },
        {
          id: secondId,
          role: "assistant",
          content: "确认目标消息",
          status: "completed",
          errorCode: null,
          createdAt: NOW,
          completedAt: NOW,
        },
      ],
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "删除" }));
  await waitFor(() => expect(deleteMessage).toHaveBeenCalledWith(SESSION_ID, secondId));
  expect(deleteMessage).toHaveBeenCalledTimes(1);
});

describe("directory menu modal origins", () => {
  it.each(["重命名", "删除会话"])(
    "directory %s cancellation returns to its exact dropdown without selecting the operated row",
    async (action) => {
      const renameSession = vi.fn();
      const deleteSession = vi.fn();
      const other = "66666666-6666-4666-8666-666666666666";
      const state = useSuperstringStore.getState();
      useSuperstringStore.setState({
        apiClient: fakeClient({ renameSession, deleteSession }),
        sessions: [
          ...state.sessions.map((item) => ({
            ...item,
            mode: "chat" as const,
            config_version: 1,
            created_at: NOW,
            updated_at: NOW,
          })),
          {
            id: other,
            title: "另一个会话",
            agent_id: "11111111-1111-4111-8111-111111111111",
            mode: "chat",
            config_version: 1,
            created_at: NOW,
            updated_at: NOW,
          },
        ],
      });
      render(<Sidebar />);
      const trigger = screen.getByRole("button", { name: "会话操作：另一个会话" });
      await userEvent.click(trigger);
      await userEvent.click(screen.getByRole("menuitem", { name: action }));
      const dialog = await screen.findByRole(action === "重命名" ? "dialog" : "alertdialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(useSuperstringStore.getState().currentSessionId).toBe(SESSION_ID);
      expect(renameSession).not.toHaveBeenCalled();
      expect(deleteSession).not.toHaveBeenCalled();
    },
  );

  it.each(["api", "hidden", "removed"] as const)(
    "directory rename closes when its %s owner ends",
    async (change) => {
      const renameSession = vi.fn();
      useSuperstringStore.setState({ apiClient: fakeClient({ renameSession }) });
      const { rerender } = render(<Sidebar active />);
      const trigger = screen.getByRole("button", { name: "会话操作：测试会话" });
      await userEvent.click(trigger);
      await userEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
      await screen.findByRole("dialog");
      const focus = vi.spyOn(trigger, "focus");
      if (change === "hidden") rerender(<Sidebar active={false} />);
      else
        await act(async () => {
          if (change === "api")
            useSuperstringStore.setState({ apiClient: fakeClient({ renameSession: vi.fn() }) });
          else
            canonicalStore.setState((state) => {
              const id = state.sessionConversationIds[SESSION_ID];
              return {
                summaryById: Object.fromEntries(
                  Object.entries(state.summaryById).filter(([key]) => key !== id),
                ),
                directoryIds: state.directoryIds.filter((key) => key !== id),
                sessionConversationIds: Object.fromEntries(
                  Object.entries(state.sessionConversationIds).filter(
                    ([source]) => source !== SESSION_ID,
                  ),
                ),
              };
            });
        });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      if (change === "removed") {
        expect(canonicalStore.getState().summaryById[`test:${SESSION_ID}`]).toBeUndefined();
        expect(canonicalStore.getState().directoryIds).not.toContain(`test:${SESSION_ID}`);
      }
      await act(async () => {});
      expect(focus).not.toHaveBeenCalled();
      expect(renameSession).not.toHaveBeenCalled();
    },
  );
});

describe("directory post-delete focus continuation", () => {
  it.each(["success", "old-api-success", "old-api-failure", "hidden"] as const)(
    "header destination belongs only to %s deletion",
    async (mode) => {
      const gate = Promise.withResolvers<void>();
      const deleteSession = vi.fn().mockReturnValue(gate.promise);
      useSuperstringStore.setState({ apiClient: fakeClient({ deleteSession }) });
      canonicalStore.setState({ currentConversationId: null });
      const { rerender } = render(<Sidebar active />);
      const header = screen.getByRole("heading", { name: "对话", hidden: true });
      const headerFocus = vi.spyOn(header, "focus");
      await userEvent.click(screen.getByRole("button", { name: "会话操作：测试会话" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "删除会话" }));
      const dialog = await screen.findByRole("alertdialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
      expect(deleteSession).toHaveBeenCalledWith(SESSION_ID);
      if (mode.startsWith("old-api"))
        await act(async () =>
          canonicalStore.setState({
            apiClient: fakeClient(),
            summaryById: {},
            directoryIds: [],
            sessionConversationIds: {},
          }),
        );
      if (mode === "hidden") rerender(<Sidebar active={false} />);
      await act(async () => {
        if (mode === "old-api-failure") gate.reject(new Error("old deletion failure"));
        else gate.resolve();
      });
      if (mode === "success") {
        await waitFor(() => expect(headerFocus).toHaveBeenCalledTimes(1));
        expect(document.activeElement).toBe(header);
      } else {
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        await act(async () => {});
        expect(headerFocus).not.toHaveBeenCalled();
      }
    },
  );

  it("an obsolete deletion completion cannot focus the header while another target modal is open", async () => {
    const gate = Promise.withResolvers<void>();
    const deleteSession = vi.fn().mockReturnValue(gate.promise);
    useSuperstringStore.setState({ apiClient: fakeClient({ deleteSession }) });
    canonicalStore.setState({ currentConversationId: null });
    render(<Sidebar />);
    const headerFocus = vi.spyOn(
      screen.getByRole("heading", { name: "对话", hidden: true }),
      "focus",
    );
    await userEvent.click(screen.getByRole("button", { name: "会话操作：测试会话" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "删除会话" }));
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除" }),
    );
    const replacement = {
      ...canonicalStore.getState().summaryById[`test:${SESSION_ID}`],
      id: "new-row",
      sourceId: "new-session",
      title: "新目标",
    };
    await act(async () =>
      canonicalStore.setState({
        apiClient: fakeClient(),
        summaryById: { [replacement.id]: replacement },
        directoryIds: [replacement.id],
        sessionConversationIds: { [replacement.sourceId]: replacement.id },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "会话操作：新目标" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "会话名称" });
    await act(async () => gate.resolve());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(headerFocus).not.toHaveBeenCalled();
  });
});

it.each(["summary-only", "canonical-source"] as const)(
  "an external %s removal during a pending Web deletion cannot acquire the success header destination",
  async (removal) => {
    const gate = Promise.withResolvers<void>();
    useSuperstringStore.setState({
      apiClient: fakeClient({ deleteSession: vi.fn().mockReturnValue(gate.promise) }),
    });
    canonicalStore.setState({ currentConversationId: null });
    render(<Sidebar />);
    const headerFocus = vi.spyOn(
      screen.getByRole("heading", { name: "对话", hidden: true }),
      "focus",
    );
    await userEvent.click(screen.getByRole("button", { name: "会话操作：测试会话" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "删除会话" }));
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除" }),
    );
    await act(async () =>
      canonicalStore.setState(() => ({
        summaryById: {},
        directoryIds: [],
        ...(removal === "canonical-source" ? { sessionConversationIds: {} } : {}),
      })),
    );
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(headerFocus).not.toHaveBeenCalled();
  },
);
