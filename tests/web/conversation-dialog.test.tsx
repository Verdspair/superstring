import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentResponse } from "../../src/shared/contracts";
import { CreateConversation } from "../../src/web/screens/conversations/CreateConversation";
import { useSuperstringStore as store } from "../../src/web/store";

const realCreate = store.getState().createSession;
beforeEach(() => {
  store.getState().resetForTests();
  store.setState({
    agents: [{ id: "agent", name: "Assistant", is_active: true } as AgentResponse],
    selectedNewSessionAgentId: "agent",
  });
});
afterEach(() => {
  cleanup();
  store.setState({ createSession: realCreate });
});
it("new-conversation dialog presents the identity and optional name, and restores focus on Escape", async () => {
  render(<CreateConversation />);
  const trigger = screen.getByRole("button", { name: "新建对话" });
  await userEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "开始新的对话" })).toBeTruthy();
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("agent");
  expect((screen.getByRole("textbox", { name: "会话名称" }) as HTMLInputElement).value).toBe("");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});
it("empty name retains automatic naming, without editing the current conversation identity", async () => {
  const create = vi.fn().mockResolvedValue(true);
  store.setState({ createSession: create, editorAgentId: "different-agent" });
  render(<CreateConversation />);
  await userEvent.click(screen.getByRole("button", { name: "新建对话" }));
  await userEvent.click(screen.getByRole("button", { name: "开始对话" }));
  expect(create).toHaveBeenCalledWith(expect.stringMatching(/^新会话/));
  expect(store.getState().editorAgentId).toBe("different-agent");
});
it("IME does not create a conversation; submitted naming disables duplicate actions until completion", async () => {
  let finish!: (value: boolean) => void;
  const create = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  store.setState({ createSession: create });
  render(<CreateConversation />);
  await userEvent.click(screen.getByRole("button", { name: "新建对话" }));
  const input = screen.getByRole("textbox", { name: "会话名称" });
  fireEvent.change(input, { target: { value: "架构讨论" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(create).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(create).toHaveBeenCalledExactlyOnceWith("架构讨论");
  expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeTruthy();
  finish(true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("keyboard creation cannot bypass a missing assistant selection", async () => {
  const create = vi.fn();
  store.setState({ createSession: create, selectedNewSessionAgentId: null });
  render(<CreateConversation />);
  await userEvent.click(screen.getByRole("button", { name: "新建对话" }));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(create).not.toHaveBeenCalled();
});
