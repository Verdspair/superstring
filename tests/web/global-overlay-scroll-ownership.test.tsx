import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertDialog } from "../../src/web/components/confirmation";
import { Button } from "../../src/web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../src/web/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../src/web/components/ui/sheet";
import { i18n } from "../../src/web/i18n/runtime";
import { render } from "./helpers/render-with-providers";

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it.each(["surface", "body", "none"] as const)(
  "forwards %s scroll ownership without losing close/focus semantics",
  async (scrollMode) => {
    const close = vi.fn();
    const { container } = render(
      <Dialog open onOpenChange={close}>
        <DialogContent scrollMode={scrollMode}>
          <DialogHeader>
            <DialogTitle>Task</DialogTitle>
          </DialogHeader>
          <div data-slot="dialog-body">Long task content</div>
          <DialogFooter>
            <Button>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("dialog").getAttribute("data-scroll-mode")).toBe(scrollMode);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(close).toHaveBeenCalledWith(false);
    expect(container).toBeTruthy();
  },
);
it("keeps one existing sheet body and a separate navigation viewport", () => {
  const { unmount } = render(
    <Sheet open>
      <SheetContent scrollMode="body">
        <SheetHeader>
          <SheetTitle>Editor</SheetTitle>
        </SheetHeader>
        <div data-slot="sheet-body">
          <input aria-label="Name" />
        </div>
      </SheetContent>
    </Sheet>,
  );
  const bodySheet = screen.getByRole("dialog");
  expect(bodySheet.getAttribute("data-scroll-mode")).toBe("body");
  expect(bodySheet.classList.contains("overflow-hidden")).toBe(true);
  expect(bodySheet.querySelectorAll('[data-slot="sheet-body"]')).toHaveLength(1);
  unmount();
  const surface = render(
    <Sheet open>
      <SheetContent scrollMode="surface">
        <SheetTitle>Scrollable settings</SheetTitle>
        <p>Settings content</p>
      </SheetContent>
    </Sheet>,
  );
  const surfaceSheet = screen.getByRole("dialog");
  expect(surfaceSheet.getAttribute("data-scroll-mode")).toBe("surface");
  expect(surfaceSheet.classList.contains("overflow-y-auto")).toBe(true);
  expect(surfaceSheet.classList.contains("overflow-hidden")).toBe(false);
  surface.unmount();
  render(
    <Sheet open>
      <SheetContent scrollMode="none">
        <SheetTitle>Navigation</SheetTitle>
        <nav aria-label="Index">Rows</nav>
      </SheetContent>
    </Sheet>,
  );
  const navigationSheet = screen.getByRole("dialog");
  expect(navigationSheet.getAttribute("data-scroll-mode")).toBe("none");
  expect(navigationSheet.classList.contains("overflow-hidden")).toBe(false);
  expect(navigationSheet.classList.contains("overflow-y-auto")).toBe(false);
  expect(screen.getByRole("navigation", { name: "Index" })).toBeTruthy();
});

describe.each(["sheet", "dialog"] as const)("%s shared return-focus policy", (kind) => {
  const Overlay = kind === "sheet" ? Sheet : Dialog;
  const OverlayContent = kind === "sheet" ? SheetContent : DialogContent;
  const OverlayTitle = kind === "sheet" ? SheetTitle : DialogTitle;
  const OverlayTrigger = kind === "sheet" ? SheetTrigger : DialogTrigger;
  const contentSlot = kind === "sheet" ? "sheet-content" : "dialog-content";
  it.each([false, true])("retains exact opener return with reduced-motion=%s", async (reduced) => {
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      const media = matchMedia(query);
      return query === "(prefers-reduced-motion: reduce)"
        ? {
            matches: reduced,
            media: query,
            onchange: null,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(() => true),
          }
        : media;
    });
    render(<ProgrammaticSheet />);
    const opener = screen.getByRole("button", { name: "Open sheet" });
    await userEvent.click(opener);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  function ProgrammaticSheet({
    customClose,
    customOpen,
    invalid,
    navigate = false,
  }: {
    customClose?: (event: Event) => void;
    customOpen?: (event: Event) => void;
    invalid?: "removed" | "hidden" | "disabled" | "inert";
    navigate?: boolean;
  }) {
    const [open, setOpen] = useState(false);
    const [opened, setOpened] = useState(false);
    const destination = useRef<HTMLButtonElement>(null);
    useLayoutEffect(() => {
      if (opened && !open && navigate) destination.current?.focus();
    }, [opened, open, navigate]);
    return (
      <>
        {!(opened && invalid === "removed") && (
          <button
            type="button"
            hidden={opened && invalid === "hidden"}
            disabled={opened && invalid === "disabled"}
            inert={opened && invalid === "inert"}
            onClick={() => {
              setOpen(true);
              setOpened(true);
            }}
          >
            Open sheet
          </button>
        )}
        <button type="button" ref={destination}>
          Destination
        </button>
        <Overlay open={open} onOpenChange={setOpen}>
          <OverlayContent onOpenAutoFocus={customOpen} onCloseAutoFocus={customClose}>
            <OverlayTitle>Programmatic</OverlayTitle>
            <input aria-label="Inside" />
            <button type="button" onClick={() => setOpen(false)}>
              Finish
            </button>
          </OverlayContent>
        </Overlay>
      </>
    );
  }
  it.each(["escape", "close"] as const)(
    "returns a no-Trigger sheet to its opening button after %s",
    async (mode) => {
      render(<ProgrammaticSheet />);
      const opener = screen.getByRole("button", { name: "Open sheet" });
      await userEvent.click(opener);
      await userEvent.click(screen.getByRole("textbox", { name: "Inside" }));
      if (mode === "escape") await userEvent.keyboard("{Escape}");
      else
        await userEvent.click(
          screen.getByRole("button", { name: kind === "sheet" ? "关闭面板" : "关闭弹窗" }),
        );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(opener));
      await userEvent.click(opener);
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(document.activeElement).toBe(opener));
    },
  );
  it("does not replace explicit open and close autofocus ownership", async () => {
    const open = vi.fn((event: Event) => event.preventDefault());
    const close = vi.fn((event: Event) => {
      event.preventDefault();
      screen.getByRole("button", { name: "Destination" }).focus();
    });
    render(<ProgrammaticSheet customOpen={open} customClose={close} />);
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    expect(open).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Destination" }));
  });
  it.each(["removed", "hidden", "disabled", "inert"] as const)(
    "does not restore an opener that became %s",
    async (invalid) => {
      render(<ProgrammaticSheet invalid={invalid} />);
      const opener = screen.getByRole("button", { name: "Open sheet" });
      await userEvent.click(opener);
      const focus = vi.spyOn(opener, "focus");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await act(async () => {});
      expect(focus).not.toHaveBeenCalled();
    },
  );
  it("does not steal focus from a navigation destination selected while closing", async () => {
    render(<ProgrammaticSheet navigate />);
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Destination" })),
    );
  });
  it("keeps the actual Radix SheetTrigger return-focus path", async () => {
    render(
      <Overlay>
        <OverlayTrigger asChild>
          <button type="button">Real trigger</button>
        </OverlayTrigger>
        <OverlayContent>
          <OverlayTitle>Triggered</OverlayTitle>
          <input aria-label="Triggered input" />
        </OverlayContent>
      </Overlay>,
    );
    const trigger = screen.getByRole("button", { name: "Real trigger" });
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it("returns a nested programmatic sheet to its parent opener before the parent returns to the page", async () => {
    function Nested() {
      const [parent, setParent] = useState(false),
        [child, setChild] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setParent(true)}>
            Page opener
          </button>
          <Overlay open={parent} onOpenChange={setParent}>
            <OverlayContent>
              <OverlayTitle>Parent</OverlayTitle>
              <button type="button" onClick={() => setChild(true)}>
                Child opener
              </button>
              <Overlay open={child} onOpenChange={setChild}>
                <OverlayContent>
                  <OverlayTitle>Child</OverlayTitle>
                  <input aria-label="Child input" />
                </OverlayContent>
              </Overlay>
            </OverlayContent>
          </Overlay>
        </>
      );
    }
    render(<Nested />);
    const page = screen.getByRole("button", { name: "Page opener" });
    await userEvent.click(page);
    const child = screen.getByRole("button", { name: "Child opener" });
    await userEvent.click(child);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(child));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(page));
  });

  it("does not install a fallback after an explicit consumer close handler that leaves the default event alone", async () => {
    const close = vi.fn();
    render(<ProgrammaticSheet customClose={close} />);
    const opener = screen.getByRole("button", { name: "Open sheet" });
    await userEvent.click(opener);
    const focus = vi.spyOn(opener, "focus");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(focus).not.toHaveBeenCalled();
  });
  it("restores focus through Presence only after the sheet exit animation finishes", async () => {
    if (!globalThis.CSS)
      Object.defineProperty(globalThis, "CSS", { configurable: true, value: {} });
    if (!globalThis.CSS.escape)
      Object.defineProperty(globalThis.CSS, "escape", {
        configurable: true,
        value: (value: string) => value,
      });
    const styles: CSSStyleDeclaration[] = [];
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = computed(element, pseudo);
      if (element.getAttribute("data-slot") === contentSlot) styles.push(style);
      return style;
    });
    render(<ProgrammaticSheet />);
    const opener = screen.getByRole("button", { name: "Open sheet" });
    await userEvent.click(opener);
    await waitFor(() => expect(styles.length).toBeGreaterThan(0));
    for (const style of styles) {
      style.setProperty("animation-name", "sheet-exit");
      Object.defineProperty(style, "animationName", { configurable: true, value: "sheet-exit" });
    }
    await userEvent.keyboard("{Escape}");
    const closing = screen.getByRole("dialog");
    expect(closing.getAttribute("data-state")).toBe("closed");
    expect(document.activeElement).not.toBe(opener);
    const end = new Event("animationend", { bubbles: true });
    Object.defineProperty(end, "animationName", { value: "sheet-exit" });
    fireEvent(closing, end);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("captures the new opening element when the same controlled sheet opens from a second button", async () => {
    function TwoOpeners() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            First opener
          </button>
          <button type="button" onClick={() => setOpen(true)}>
            Second opener
          </button>
          <Overlay open={open} onOpenChange={setOpen}>
            <OverlayContent>
              <OverlayTitle>Shared sheet</OverlayTitle>
              <input aria-label="Shared input" />
            </OverlayContent>
          </Overlay>
        </>
      );
    }
    render(<TwoOpeners />);
    const first = screen.getByRole("button", { name: "First opener" }),
      second = screen.getByRole("button", { name: "Second opener" });
    await userEvent.click(first);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(first));
    await userEvent.click(second);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(second));
  });

  it("does not record blocked outside focus while the sheet is still open as a close destination", async () => {
    render(<ProgrammaticSheet />);
    const opener = screen.getByRole("button", { name: "Open sheet" });
    await userEvent.click(opener);
    const destination = screen.getByText("Destination");
    act(() => destination.focus());
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

it.each(["sheet", "dialog"] as const)(
  "nested %s uses its own opener without stealing its parent",
  async (parentKind) => {
    const Parent = parentKind === "sheet" ? Sheet : Dialog;
    const ParentContent = parentKind === "sheet" ? SheetContent : DialogContent;
    const ParentTitle = parentKind === "sheet" ? SheetTitle : DialogTitle;
    const Child = parentKind === "sheet" ? Dialog : Sheet;
    const ChildContent = parentKind === "sheet" ? DialogContent : SheetContent;
    const ChildTitle = parentKind === "sheet" ? DialogTitle : SheetTitle;
    function Mixed() {
      const [parent, setParent] = useState(false);
      const [child, setChild] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setParent(true)}>
            Mixed page opener
          </button>
          <Parent open={parent} onOpenChange={setParent}>
            <ParentContent>
              <ParentTitle>Mixed parent</ParentTitle>
              <button type="button" onClick={() => setChild(true)}>
                Mixed child opener
              </button>
              <Child open={child} onOpenChange={setChild}>
                <ChildContent>
                  <ChildTitle>Mixed child</ChildTitle>
                  <input aria-label="Mixed child input" />
                </ChildContent>
              </Child>
            </ParentContent>
          </Parent>
        </>
      );
    }
    render(<Mixed />);
    const page = screen.getByRole("button", { name: "Mixed page opener" });
    await userEvent.click(page);
    const child = screen.getByRole("button", { name: "Mixed child opener" });
    await userEvent.click(child);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(child));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(page));
  },
);

it("a programmatic opener moved to another document is not restored", async () => {
  function MovingOpener() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Move opener
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Moving</DialogTitle>
            <input aria-label="Moving input" />
          </DialogContent>
        </Dialog>
      </>
    );
  }
  render(<MovingOpener />);
  const opener = screen.getByRole("button", { name: "Move opener" });
  await userEvent.click(opener);
  const parent = opener.parentElement;
  if (!parent) throw new Error("missing opener parent");
  const other = document.implementation.createHTMLDocument("other");
  other.body.appendChild(opener);
  const focus = vi.spyOn(opener, "focus");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await act(async () => {});
  expect(opener.ownerDocument).toBe(other);
  expect(focus).not.toHaveBeenCalled();
  parent.appendChild(opener);
});

it.each([false, true])(
  "explicit return source is snapshotted at open and invalid=%s is never replaced",
  async (invalid) => {
    const source = document.createElement("button");
    source.textContent = "Explicit origin";
    document.body.appendChild(source);
    const substitute = document.createElement("button");
    substitute.textContent = "Later ref value";
    document.body.appendChild(substitute);
    const target = { current: source as HTMLElement | null };
    function ExplicitSource() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Different opener
          </button>
          <AlertDialog
            open={open}
            title="Explicit source"
            onCancel={() => setOpen(false)}
            returnFocusRef={target}
          >
            <button type="button" data-dialog-cancel onClick={() => setOpen(false)}>
              Cancel explicit
            </button>
          </AlertDialog>
        </>
      );
    }
    render(<ExplicitSource />);
    await userEvent.click(screen.getByRole("button", { name: "Different opener" }));
    target.current = substitute;
    if (invalid) source.disabled = true;
    const originalFocus = vi.spyOn(source, "focus");
    const replacementFocus = vi.spyOn(substitute, "focus");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await act(async () => {});
    if (invalid) expect(originalFocus).not.toHaveBeenCalled();
    else await waitFor(() => expect(document.activeElement).toBe(source));
    expect(replacementFocus).not.toHaveBeenCalled();
    source.remove();
    substitute.remove();
  },
);

it("replacing an explicit return source invalidates an older opening target", async () => {
  const origin = document.createElement("button");
  origin.textContent = "Old explicit source";
  document.body.appendChild(origin);
  function ReplaceSource() {
    const [open, setOpen] = useState(false);
    const [source, setSource] = useState({ current: origin as HTMLElement | null });
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Start explicit opening
        </button>
        <AlertDialog
          open={open}
          title="Replace explicit source"
          returnFocusRef={source}
          onCancel={() => {
            setSource({ current: null });
            setOpen(false);
          }}
        >
          <button
            type="button"
            data-dialog-cancel
            onClick={() => {
              setSource({ current: null });
              setOpen(false);
            }}
          >
            Invalidate origin
          </button>
        </AlertDialog>
      </>
    );
  }
  render(<ReplaceSource />);
  await userEvent.click(screen.getByRole("button", { name: "Start explicit opening" }));
  const focus = vi.spyOn(origin, "focus");
  await userEvent.click(screen.getByRole("button", { name: "Invalidate origin" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await act(async () => {});
  expect(focus).not.toHaveBeenCalled();
  origin.remove();
});

it.each(["valid", "disabled", "hidden", "inert", "removed", "null"] as const)(
  "DialogContent explicit select origin %s uses shared eligibility without ambient replacement",
  async (condition) => {
    const select = document.createElement("select");
    const option = document.createElement("option");
    option.value = "original";
    option.textContent = "Explicit selection origin";
    select.appendChild(option);
    document.body.appendChild(select);
    const target = { current: condition === "null" ? null : (select as HTMLElement | null) };
    function ExplicitSelection() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Ambient dialog opener
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent returnFocusRef={target}>
              <DialogTitle>Select origin</DialogTitle>
              <input aria-label="Origin detail" />
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<ExplicitSelection />);
    const ambient = screen.getByRole("button", { name: "Ambient dialog opener" });
    await userEvent.click(ambient);
    if (condition === "disabled") select.disabled = true;
    if (condition === "hidden") select.hidden = true;
    if (condition === "inert") select.setAttribute("inert", "");
    if (condition === "removed") select.remove();
    const focus = vi.spyOn(select, "focus");
    const ambientFocus = vi.spyOn(ambient, "focus");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {});
    if (condition === "valid") await waitFor(() => expect(document.activeElement).toBe(select));
    else expect(focus).not.toHaveBeenCalled();
    expect(ambientFocus).not.toHaveBeenCalled();
    expect(select.value).toBe("original");
    select.remove();
  },
);
