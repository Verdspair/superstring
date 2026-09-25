import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sidebar } from "../../src/web/app/Sidebar";
import { useSuperstringStore as store } from "../../src/web/store";

const realCreate = store.getState().createSession;
beforeEach(() => store.getState().resetForTests());
afterEach(() => {
  cleanup();
  store.setState({ createSession: realCreate });
});
it("new-session dialog preserves name choices, focuses custom input, and restores trigger on Escape", async () => {
  render(<Sidebar version="test" />);
  const trigger = screen.getByRole("button", { name: "新建任务" });
  await userEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "新建任务" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "暂时使用默认名称" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "使用自定义名称" }));
  const input = screen.getByRole("textbox", { name: "任务名称" });
  expect(document.activeElement).toBe(input);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it("IME does not create a session; submitted naming disables duplicate actions until completion", async () => {
  let finish!: (value: boolean) => void;
  const create = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  store.setState({ createSession: create });
  render(<Sidebar version="test" />);
  await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
  await userEvent.click(screen.getByRole("button", { name: "使用自定义名称" }));
  const input = screen.getByRole("textbox", { name: "任务名称" });
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
