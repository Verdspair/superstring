// QQ 群自定义名称（小功能）：会话目录菜单复用重命名 Dialog，保存走群名接口并回写目录；
// 空输入清除备注恢复默认；原 Web 重命名路径不变；保存失败保留输入并显示错误，不假成功。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import type { SuperstringApi } from "../../src/web/api";
import { ConversationIdentity } from "../../src/web/screens/conversations/ConversationIdentity";
import { ConversationIndex } from "../../src/web/screens/conversations/ConversationIndex";
import { useSuperstringStore as store } from "../../src/web/store";
import { summaryFixture } from "./helpers/chat-fixture";

const group = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  ...summaryFixture("binding-group"),
  id: "conv-group",
  channel: "onebot11",
  topology: "shared",
  title: "同事群",
  qqGroup: { number: "123456789", originalName: "同事群", customName: null },
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  store.getState().resetForTests({
    listMessages: async () => [],
    getSessionRuntime: async () => null,
  } as unknown as SuperstringApi);
});
afterEach(cleanup);

async function openRename(item: ConversationSummary) {
  store.getState().rememberConversation(item);
  render(<ConversationIndex />);
  fireEvent.contextMenu(screen.getByRole("button", { name: item.title }), {
    clientX: 10,
    clientY: 10,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
}

it("QQ群默认显示QQ群名与独立群号：目录卡片与顶部 Identity 恒显群号", async () => {
  const item = group({
    title: "同事群",
    qqGroup: { number: "123456789", originalName: "同事群", customName: null },
  });
  store.getState().rememberConversation(item);
  const { unmount } = render(<ConversationIndex />);
  expect(screen.getByText("同事群")).toBeTruthy();
  expect(screen.getByText("123456789")).toBeTruthy();
  unmount();

  render(<ConversationIdentity conversation={item} agentName="智能助手" />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("同事群");
  expect(screen.getByText("123456789")).toBeTruthy();
  expect(screen.getByText("智能助手")).toBeTruthy();
});

it("QQ群菜单可重命名：保存走群名接口回写目录，标题显示备注且群号独立保留", async () => {
  const item = group();
  const rename = vi.fn().mockResolvedValue({
    ...item,
    title: "开会群",
    qqGroup: { number: "123456789", originalName: "同事群", customName: "开会群" },
  });
  store.setState({
    apiClient: { ...store.getState().apiClient, renameConversationGroup: rename },
  });
  await openRename(item);
  expect(screen.getByText("123456789")).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "会话名称" }) as HTMLInputElement;
  expect(input.value).toBe("同事群");
  fireEvent.change(input, { target: { value: "开会群" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "会话名称" })).toBeNull());
  expect(rename).toHaveBeenCalledWith("conv-group", "开会群");
  expect(store.getState().summaryById["conv-group"]?.title).toBe("开会群");
  expect(store.getState().summaryById["conv-group"]?.qqGroup?.customName).toBe("开会群");
  expect(screen.getByText("123456789")).toBeTruthy();
});

it("QQ群空输入清除备注恢复默认：提交 null 并回落QQ原名，保存按钮不因空输入禁用", async () => {
  const item = group({
    title: "开会群",
    qqGroup: { number: "123456789", originalName: "同事群", customName: "开会群" },
  });
  const rename = vi.fn().mockResolvedValue({
    ...item,
    title: "同事群",
    qqGroup: { number: "123456789", originalName: "同事群", customName: null },
  });
  store.setState({
    apiClient: { ...store.getState().apiClient, renameConversationGroup: rename },
  });
  await openRename(item);
  const input = screen.getByRole("textbox", { name: "会话名称" }) as HTMLInputElement;
  expect(input.value).toBe("开会群");
  fireEvent.change(input, { target: { value: "  " } });
  const save = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "会话名称" })).toBeNull());
  expect(rename).toHaveBeenCalledWith("conv-group", null);
  expect(store.getState().summaryById["conv-group"]?.title).toBe("同事群");
  expect(store.getState().summaryById["conv-group"]?.qqGroup?.customName).toBeNull();
});

it("Web会话重命名仍走原 renameSession，不经群名接口", async () => {
  const web = summaryFixture("web-session", { title: "随笔" });
  const renameSession = vi.fn().mockResolvedValue(true);
  const renameConversationGroup = vi.fn();
  store.setState({
    renameSession,
    apiClient: { ...store.getState().apiClient, renameConversationGroup },
  });
  await openRename(web);
  const input = screen.getByRole("textbox", { name: "会话名称" });
  fireEvent.change(input, { target: { value: "新名字" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "会话名称" })).toBeNull());
  expect(renameSession).toHaveBeenCalledWith("web-session", "新名字");
  expect(renameConversationGroup).not.toHaveBeenCalled();
});

it("群名保存失败保留输入并显示错误，目录标题不假更新", async () => {
  const item = group();
  const rename = vi.fn().mockRejectedValue(new Error("群名保存失败"));
  store.setState({
    apiClient: { ...store.getState().apiClient, renameConversationGroup: rename },
  });
  await openRename(item);
  const input = screen.getByRole("textbox", { name: "会话名称" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "开会群" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("群名保存失败"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "会话名称" }) as HTMLInputElement).value).toBe(
    "开会群",
  );
  expect(store.getState().summaryById["conv-group"]?.title).toBe("同事群");
});
