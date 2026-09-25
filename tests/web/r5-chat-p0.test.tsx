import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { P5ConfigSchema } from "../../src/shared/contracts";
import { ChatPage, Sidebar } from "../../src/web/App";
import type { SuperstringApi } from "../../src/web/api";
import { fixtureStore as useSuperstringStore } from "./helpers/chat-fixture";

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
  it("未新建会话时显示准确入口，不展示宣传语", () => {
    useSuperstringStore.setState({
      sessions: [],
      currentSessionId: null,
      messages: [],
    });
    render(<ChatPage />);
    expect(screen.getByRole("heading", { name: "开始一段对话" })).toBeTruthy();
    expect(screen.getByText("点击“新建任务”，开启与助手的对话。")).toBeTruthy();
    expect(screen.queryByText("对话与记忆，留在你的本地工作空间")).toBeNull();
    expect(screen.getByPlaceholderText("输入消息…")).toBeTruthy();
  });

  it("已有空会话时不再提示新建会话", () => {
    useSuperstringStore.setState({ messages: [] });
    render(<ChatPage />);
    expect(screen.getByRole("heading", { name: "开始对话" })).toBeTruthy();
    expect(screen.getByText("在下方输入消息，开始与助手交流。")).toBeTruthy();
    expect(screen.queryByText("点击“新建任务”，开启与助手的对话。")).toBeNull();
  });
});

describe("R5 聊天区 P0 交互", () => {
  it("按原版显示模型角色与聊天模式标题", () => {
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

    expect(screen.getByRole("heading", { name: "测试会话 · 测试助手 · 聊天" })).toBeTruthy();
    expect(screen.getByText(/模型 ·/)).toBeTruthy();
    expect(document.querySelector(".message-meta")?.textContent).not.toContain("助手 ·");
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
    expect(processing.querySelector(".superstring-loading-ring")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
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
    const listMessages = vi.fn().mockResolvedValue([]);
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
    expect(listMessages).toHaveBeenCalledWith(SESSION_ID);
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

  it("Escape 和外部 pointerdown 会关闭右键菜单", () => {
    render(<ChatPage />);
    const bubble = screen.getByText("需要删除的消息");
    fireEvent.contextMenu(bubble);
    expect(screen.getByRole("menu", { name: "消息操作" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "消息操作" })).toBeNull();

    fireEvent.contextMenu(bubble);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "消息操作" })).toBeNull();
  });
});
