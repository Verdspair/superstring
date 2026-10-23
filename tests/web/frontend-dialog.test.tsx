import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../src/web/components/confirmation";
import { useSuperstringStore } from "../../src/web/store";
import { NavigationGuard as NavigationConfirm } from "../../src/web/workspace/NavigationGuard";
import { render } from "./helpers/render-with-providers";

afterEach(cleanup);
function Example() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开确认
      </button>
      <ConfirmDialog
        open={open}
        message="确认操作？"
        onCancel={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
      />
    </>
  );
}
describe("Radix确认弹窗", () => {
  it("初始聚焦取消，Tab循环且Escape关闭后恢复焦点", async () => {
    const user = userEvent.setup();
    render(<Example />);
    const opener = screen.getByRole("button", { name: "打开确认" });
    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "确认" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
    if (screen.queryByRole("tooltip")) {
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
      expect(screen.getByRole("alertdialog")).toBeTruthy();
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
  it("点击遮罩不取消确认", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "打开确认" }));
    fireEvent.pointerDown(
      document.querySelector('[data-slot="alert-dialog-overlay"]') as HTMLElement,
    );
    expect(screen.getByRole("alertdialog", { name: "确认操作？" })).toBeTruthy();
  });
  it("导航确认保留显式取消策略，请求中禁止重复动作，结束后解除禁用", async () => {
    const old = useSuperstringStore.getState();
    let resolve!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const cancel = vi.fn();
    useSuperstringStore.setState({
      navigationConfirmOpen: true,
      confirmSaveAndContinue: save,
      cancelPendingNavigation: cancel,
    });
    try {
      render(<NavigationConfirm />);
      await userEvent.keyboard("{Escape}");
      expect(cancel).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "保存并继续" }));
      for (const button of screen.getAllByRole("button"))
        expect((button as HTMLButtonElement).disabled).toBe(true);
      await userEvent.keyboard("{Escape}");
      expect(save).toHaveBeenCalledOnce();
      expect(cancel).not.toHaveBeenCalled();
      await act(async () => {
        resolve();
      });
      expect(
        (
          screen.getByRole("button", {
            name: "保存并继续",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
      await userEvent.click(screen.getByRole("button", { name: "取消离开" }));
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      useSuperstringStore.setState({
        confirmSaveAndContinue: old.confirmSaveAndContinue,
        cancelPendingNavigation: old.cancelPendingNavigation,
      });
    }
  });
  it("关闭状态下非相关状态变更不触发重新渲染", async () => {
    const old = useSuperstringStore.getState();
    const oldNavigationConfirmOpen = old.navigationConfirmOpen;
    const oldFeedback = old.feedback;
    useSuperstringStore.setState({
      navigationConfirmOpen: false,
      feedback: "",
    });
    try {
      const onRender = vi.fn();
      render(
        <Profiler id="NavigationConfirm" onRender={onRender}>
          <NavigationConfirm />
        </Profiler>,
      );
      expect(onRender).toHaveBeenCalledTimes(1);
      act(() => {
        useSuperstringStore.setState({ feedback: "feedback-update-1" });
      });
      act(() => {
        useSuperstringStore.setState({ feedback: "feedback-update-2" });
      });
      act(() => {
        useSuperstringStore.setState({ feedback: "feedback-update-3" });
      });
      expect(onRender).toHaveBeenCalledTimes(1);
    } finally {
      useSuperstringStore.setState({
        navigationConfirmOpen: oldNavigationConfirmOpen,
        feedback: oldFeedback,
      });
    }
  });
});
