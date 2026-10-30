import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Trash2 } from "lucide-react";
import { Profiler, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../src/web/components/confirmation";
import { Dialog, DialogContent, DialogTitle } from "../../src/web/components/ui/dialog";
import { ConversationIndex } from "../../src/web/screens/conversations/ConversationIndex";
import { RecordActions } from "../../src/web/screens/conversations/RecordActions";
import { useSuperstringStore } from "../../src/web/store";
import { NavigationGuard as NavigationConfirm } from "../../src/web/workspace/NavigationGuard";
import { summaryFixture } from "./helpers/chat-fixture";
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

it("programmatic Dialog and its explicit confirmation keep separate return-focus owners", async () => {
  function NestedConfirm() {
    const [open, setOpen] = useState(false);
    const [confirm, setConfirm] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open editor
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Editor</DialogTitle>
            <button type="button" onClick={() => setConfirm(true)}>
              Open confirmation
            </button>
            <ConfirmDialog
              open={confirm}
              message="Nested confirmation?"
              onCancel={() => setConfirm(false)}
              onConfirm={() => setConfirm(false)}
            />
          </DialogContent>
        </Dialog>
      </>
    );
  }
  render(<NestedConfirm />);
  const editor = screen.getByRole("button", { name: "Open editor" });
  await userEvent.click(editor);
  const trigger = screen.getByRole("button", { name: "Open confirmation" });
  await userEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(screen.getByRole("dialog", { name: "Editor" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(editor));
});

it("delayed confirmation retains its explicit action opener while preserving cancel-first", async () => {
  const pending = Promise.withResolvers<void>();
  const confirm = vi.fn();
  function Delayed() {
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);
    const opener = useRef<HTMLElement | null>(null);
    return (
      <>
        <button
          type="button"
          disabled={busy}
          onClick={(event) => {
            opener.current = event.currentTarget;
            setBusy(true);
            void pending.promise.then(() => {
              setBusy(false);
              setOpen(true);
            });
          }}
        >
          Delayed origin
        </button>
        <ConfirmDialog
          open={open}
          message="Delayed confirmation"
          returnFocusRef={opener}
          onCancel={() => setOpen(false)}
          onConfirm={confirm}
        />
      </>
    );
  }
  render(<Delayed />);
  const opener = screen.getByRole("button", { name: "Delayed origin" }) as HTMLButtonElement;
  await userEvent.click(opener);
  expect(opener.disabled).toBe(true);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await act(async () => pending.resolve());
  const cancel = screen.getByRole("button", { name: "取消" });
  expect(document.activeElement).toBe(cancel);
  await userEvent.click(cancel);
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(confirm).not.toHaveBeenCalled();
});

it("an explicit null confirmation origin is not replaced with the focused ambient button", async () => {
  function NoOrigin() {
    const [open, setOpen] = useState(false);
    const origin = useRef<HTMLElement | null>(null);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Ambient opener
        </button>
        <ConfirmDialog
          open={open}
          message="No explicit source"
          returnFocusRef={origin}
          onCancel={() => setOpen(false)}
          onConfirm={() => {}}
        />
      </>
    );
  }
  render(<NoOrigin />);
  const ambient = screen.getByRole("button", { name: "Ambient opener" });
  await userEvent.click(ambient);
  const focus = vi.spyOn(ambient, "focus");
  await userEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await act(async () => {});
  expect(focus).not.toHaveBeenCalled();
});

it("record menu passes durable origin to confirmation without changing zero-argument actions", async () => {
  const legacy = vi.fn();
  function MenuConfirmation() {
    const [open, setOpen] = useState(false);
    const source = useRef<HTMLElement | null>(null);
    return (
      <>
        <RecordActions
          label="Origin actions"
          actions={[
            { label: "Legacy action", tooltip: "Legacy", icon: Trash2, run: () => legacy() },
            {
              label: "Open confirmation",
              tooltip: "Confirm",
              icon: Trash2,
              run: (origin) => {
                source.current = origin;
                setOpen(true);
              },
            },
          ]}
        >
          {(trigger) => <article>{trigger}</article>}
        </RecordActions>
        <ConfirmDialog
          open={open}
          message="Menu confirmation"
          returnFocusRef={source}
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        />
      </>
    );
  }
  render(<MenuConfirmation />);
  const trigger = screen.getByRole("button", { name: "Origin actions" });
  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole("menuitem", { name: "Legacy action" }));
  expect(legacy).toHaveBeenCalledTimes(1);
  expect(legacy).toHaveBeenCalledWith();
  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole("menuitem", { name: "Open confirmation" }));
  await userEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("directory operation owner drops old API completion without closing a new target", async () => {
  const originalRename = useSuperstringStore.getState().renameSession;
  const row = summaryFixture("directory-owner", { title: "Directory owner" });
  const first = Promise.withResolvers<boolean>();
  const next = Promise.withResolvers<boolean>();
  const rename = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
  useSuperstringStore.getState().resetForTests();
  useSuperstringStore.setState({
    summaryById: { [row.id]: row },
    directoryIds: [row.id],
    renameSession: rename,
  });
  render(<ConversationIndex />);
  const open = async () => {
    await userEvent.click(screen.getByRole("button", { name: "会话操作：Directory owner" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    fireEvent.change(screen.getByRole("textbox", { name: "会话名称" }), {
      target: { value: "Changed" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "会话名称" }), { key: "Enter" });
  };
  await open();
  await act(async () =>
    useSuperstringStore.setState({ apiClient: { ...useSuperstringStore.getState().apiClient } }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await open();
  await act(async () => first.resolve(true));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "会话名称" }) as HTMLInputElement).disabled).toBe(
    true,
  );
  await act(async () => next.resolve(true));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  useSuperstringStore.setState({ renameSession: originalRename });
});
