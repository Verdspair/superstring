import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertDialog, ConfirmDialog } from "../../src/web/components/confirmation";
import { i18n } from "../../src/web/i18n/runtime";
import { render } from "./helpers/render-with-providers";

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  // Radix Presence 在 animationend 里使用 CSS.escape；jsdom 未提供该命名空间。
  if (!globalThis.CSS) {
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: {} });
  }
  if (!globalThis.CSS.escape) {
    Object.defineProperty(globalThis.CSS, "escape", {
      configurable: true,
      value: (value: string) => value,
    });
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness({ onConfirm = () => {} }: { onConfirm?: () => unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span>caller-stays-mounted</span>
      <button type="button" onClick={() => setOpen(true)}>
        打开确认
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        外部关闭
      </button>
      <ConfirmDialog
        open={open}
        message="确认操作？"
        onCancel={() => setOpen(false)}
        onConfirm={onConfirm}
      />
    </>
  );
}

describe("confirmation exit presence", () => {
  it("keeps the caller and closing content mounted until the exit animation ends, then restores focus", async () => {
    const computed: CSSStyleDeclaration[] = [];
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudoElement) => {
      const style = realGetComputedStyle(element, pseudoElement);
      if (element.getAttribute("data-slot") === "alert-dialog-content") computed.push(style);
      return style;
    });

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "打开确认" });
    await userEvent.click(opener);
    expect(screen.getByRole("alertdialog", { name: "确认操作？" })).toBeTruthy();
    await waitFor(() => expect(computed.length).toBeGreaterThan(0));
    // jsdom 没有样式表动画；让 Presence 读到退出动画，再由 animationend 结束保持段。
    for (const style of computed) {
      style.setProperty("animation-name", "dialog-exit");
      Object.defineProperty(style, "animationName", { configurable: true, value: "dialog-exit" });
    }

    fireEvent.click(screen.getByText("外部关闭"));
    const closing = screen.getByRole("alertdialog", { name: "确认操作？" });
    expect(closing.getAttribute("data-state")).toBe("closed");
    expect(screen.getByText("caller-stays-mounted")).toBeTruthy();
    expect(screen.getByText("确认操作？")).toBeTruthy();

    const end = new Event("animationend", { bubbles: true });
    Object.defineProperty(end, "animationName", { value: "dialog-exit" });
    fireEvent(closing, end);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("renders only while the caller's explicit open prop is true", () => {
    const cancel = vi.fn();
    const { rerender } = render(
      <AlertDialog open title="受控打开" onCancel={cancel}>
        <button type="button" data-dialog-cancel onClick={cancel}>
          取消
        </button>
      </AlertDialog>,
    );
    expect(screen.getByRole("alertdialog", { name: "受控打开" })).toBeTruthy();
    rerender(
      <AlertDialog open={false} title="受控打开" onCancel={cancel}>
        <button type="button" data-dialog-cancel onClick={cancel}>
          取消
        </button>
      </AlertDialog>,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("blocks cancel while pending and does not reset the guard when reopened before the promise settles", async () => {
    let resolve!: () => void;
    const confirm = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const cancel = vi.fn();
    function PendingHarness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            重开
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            外部关闭
          </button>
          <ConfirmDialog
            open={open}
            message="待处理确认"
            onCancel={() => {
              cancel();
              setOpen(false);
            }}
            onConfirm={confirm}
          />
        </>
      );
    }

    render(<PendingHarness />);
    const confirmButton = screen.getByRole("button", { name: "确认" }) as HTMLButtonElement;
    await userEvent.click(confirmButton);
    expect(confirm).toHaveBeenCalledTimes(1);
    fireEvent.click(confirmButton);
    expect(confirm).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "待处理确认" })).toBeTruthy();

    fireEvent.click(screen.getByText("外部关闭"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(screen.getByText("重开"));
    await waitFor(() =>
      expect(screen.getByRole("alertdialog", { name: "待处理确认" })).toBeTruthy(),
    );
    expect((screen.getByRole("button", { name: "确认" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(confirm).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve();
    });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "确认" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
