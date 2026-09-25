import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionResponse } from "../../src/shared/contracts";
import { api, type SuperstringApi } from "../../src/web/api";
import { ChatPage } from "../../src/web/features/chat/ChatPage";
import { ConversationList as SessionList } from "../../src/web/features/conversations/ConversationList";
import { GeneralSettings } from "../../src/web/features/general/GeneralSettings";
import { selectLocale } from "../../src/web/i18n";
import { fixtureStore as store } from "./helpers/chat-fixture";

const a: SessionResponse = {
  id: "a",
  title: "当前会话",
  agent_id: "agent",
  mode: "chat",
  config_version: 1,
  created_at: "2026-09-18T00:00:00.000Z",
  updated_at: "2026-09-18T00:00:00.000Z",
};
const b = { ...a, id: "b", title: "另一会话" };
const message = {
  id: "m",
  role: "user" as const,
  content: "当前原文",
  status: "completed" as const,
  errorCode: null,
  createdAt: a.created_at,
  completedAt: null,
};
function client(overrides: Partial<SuperstringApi>) {
  store.setState({ apiClient: { ...api, ...overrides } });
}
beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests();
  store.setState({
    sessions: [a, b],
    currentSessionId: a.id,
    messages: [message],
    composer: "未发送输入",
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectLocale("zh-CN");
});
function openOther() {
  fireEvent.contextMenu(screen.getByRole("button", { name: b.title }), {
    clientX: 120,
    clientY: 120,
  });
}
it("通用包含语言和外观，不再包含运行模式，返回设置中心可用", () => {
  store.setState({ page: "settings", settingsView: "general" });
  render(<GeneralSettings />);
  expect(screen.getByText("外观")).toBeTruthy();
  expect(document.querySelector(".general-settings")?.textContent).not.toContain("运行模式");
  expect(document.querySelectorAll(".theme-option")).toHaveLength(16);
  fireEvent.click(screen.getByRole("button", { name: "返回设置中心" }));
  expect(store.getState().settingsView).toBe("hub");
});
it("聊天页不再显示会话操作按钮和配置版本注释", () => {
  render(<ChatPage />);
  expect(screen.queryByRole("button", { name: "删除会话" })).toBeNull();
  expect(screen.queryByRole("button", { name: "刷新会话" })).toBeNull();
  expect(document.querySelector(".chat-header p")).toBeNull();
});
it("右击非当前会话不切换，重命名成功仅更新目标和记忆列表标题", async () => {
  const rename = vi.fn().mockResolvedValue({ ...b, title: "新名称" });
  client({ renameSession: rename });
  store.setState({ memorySessions: [{ id: b.id, title: b.title }] });
  render(<SessionList />);
  openOther();
  expect(store.getState().currentSessionId).toBe(a.id);
  expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
    "重命名",
    "刷新会话",
    "删除会话",
  ]);
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  const input = screen.getByRole("textbox", { name: "会话名称" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: " 新名称 " } });
  fireEvent.submit(screen.getByRole("form", { name: "重命名会话" }));
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  expect(rename).toHaveBeenCalledWith("b", "新名称");
  expect(store.getState().currentSessionId).toBe("a");
  expect(store.getState().messages).toEqual([message]);
  expect(store.getState().composer).toBe("未发送输入");
  expect(store.getState().memorySessions[0]?.title).toBe("新名称");
});
it("重命名失败保留输入，空白/超长不提交，Escape取消", async () => {
  const rename = vi.fn().mockRejectedValue(Error("合成失败"));
  client({ renameSession: rename });
  render(<SessionList />);
  openOther();
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: " " } });
  fireEvent.submit(screen.getByRole("form"));
  expect(rename).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "x".repeat(201) } });
  fireEvent.submit(screen.getByRole("form"));
  expect(rename).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "失败草稿" } });
  fireEvent.submit(screen.getByRole("form"));
  await screen.findByText("合成失败");
  expect((input as HTMLInputElement).value).toBe("失败草稿");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("textbox")).toBeNull();
});
it("刷新非当前会话不会切换或覆盖当前消息", async () => {
  const listMessages = vi.fn().mockResolvedValue([]),
    getSessionRuntime = vi.fn().mockResolvedValue(null);
  client({
    listSessions: vi.fn().mockResolvedValue([a, b]),
    listMessages,
    getSessionRuntime,
  });
  render(<SessionList />);
  openOther();
  fireEvent.click(screen.getByRole("menuitem", { name: "刷新会话" }));
  await screen.findByText("会话已刷新");
  expect(listMessages).toHaveBeenCalledWith("b");
  expect(store.getState().currentSessionId).toBe("a");
  expect(store.getState().messages).toEqual([message]);
});
it("删除非当前会话只删除目标，失败保持确认，成功关闭", async () => {
  const remove = vi.fn().mockRejectedValueOnce(Error("不能删除")).mockResolvedValue(undefined);
  client({ deleteSession: remove });
  render(<SessionList />);
  openOther();
  fireEvent.click(screen.getByRole("menuitem", { name: "删除会话" }));
  expect(screen.getByText(/删除「另一会话」/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^删除$/ }));
  await screen.findByText("不能删除");
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^删除$/ }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(remove).toHaveBeenLastCalledWith("b");
  expect(store.getState().currentSessionId).toBe("a");
  expect(store.getState().messages).toEqual([message]);
});
it("菜单支持键盘导航与Escape恢复焦点", () => {
  render(<SessionList />);
  const button = screen.getByRole("button", { name: b.title });
  button.focus();
  fireEvent.keyDown(button, { key: "F10", shiftKey: true });
  expect(document.activeElement?.textContent).toBe("重命名");
  fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
  expect(document.activeElement?.textContent).toBe("刷新会话");
  fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
  expect(document.activeElement).toBe(button);
  expect(screen.queryByRole("menu")).toBeNull();
});
it("忙碌保存防止重复提交", async () => {
  let resolve!: (value: SessionResponse) => void;
  const rename = vi.fn().mockImplementation(
    () =>
      new Promise<SessionResponse>((done) => {
        resolve = done;
      }),
  );
  client({ renameSession: rename });
  render(<SessionList />);
  openOther();
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "保存中" },
  });
  const form = screen.getByRole("form");
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(rename).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ ...b, title: "保存中" }));
});
it("动作拒绝空白和超长标题，生成期间拒绝刷新删除", async () => {
  const rename = vi.fn(),
    remove = vi.fn(),
    list = vi.fn();
  client({ renameSession: rename, deleteSession: remove, listSessions: list });
  expect(await store.getState().renameSession("b", " ")).toBe(false);
  expect(await store.getState().renameSession("b", "x".repeat(201))).toBe(false);
  store.setState({ sending: true });
  expect(await store.getState().deleteSessionById("a")).toBe(false);
  expect(await store.getState().refreshSessionById("a")).toBe(false);
  expect(rename).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});
it("删除最后一个会话清空选择和持久键", async () => {
  const write = vi.fn().mockResolvedValue(true);
  client({ deleteSession: vi.fn().mockResolvedValue(undefined) });
  store.setState({
    sessions: [a],
    browserStateStorage: { write } as unknown as NonNullable<
      ReturnType<typeof store.getState>["browserStateStorage"]
    >,
  });
  expect(await store.getState().deleteSessionById("a")).toBe(true);
  expect(store.getState().currentSessionId).toBeNull();
  expect(write).toHaveBeenCalledWith("superstring-session", null);
});
it("迟到的会话读取不覆盖新选择", async () => {
  let finish!: (value: []) => void;
  client({
    listMessages: vi.fn().mockImplementation(
      () =>
        new Promise<[]>((resolve) => {
          finish = resolve;
        }),
    ),
    getSessionRuntime: vi.fn().mockResolvedValue(null),
  });
  const pending = store.getState().selectSession("b");
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  store.setState({ currentSessionId: "a" });
  finish([]);
  await pending;
  expect(store.getState().messages).toEqual([message]);
});
