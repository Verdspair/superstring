import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sheet, SheetContent } from "../../src/web/components/ui/sheet";
import { render } from "./helpers/render-with-providers";

// The caption inset reads window.superstringHost; nothing else in this suite
// touches the desktop bridge.
type DesktopWindow = Window & { superstringHost?: unknown };
const host = (value: unknown) => {
  Object.defineProperty(window, "superstringHost", { value, configurable: true });
};

afterEach(() => {
  cleanup();
  delete (window as DesktopWindow).superstringHost;
});

describe("SheetContent native caption reserve on the desktop host", () => {
  it.each(["right", "left", "top"] as const)(
    "fills the full window on %s and reserves the caption as internal padding",
    (side) => {
      host({ desktop: true });
      render(
        <Sheet open>
          <SheetContent side={side} data-testid="sheet" />
        </Sheet>,
      );
      const el = screen.getByTestId("sheet");
      expect(el.getAttribute("data-caption-inset")).toBe("true");
      // The panel background stays full height: no whole-panel top offset.
      expect(el.style.top).toBe("");
      expect(el.style.height).toBe("");
      // The caption height is reserved inside the panel.
      expect(el.style.paddingTop).toContain("calc(");
      expect(el.style.paddingTop).toContain("env(titlebar-area-height");
    },
  );

  it("keeps the panel close button below the caption", () => {
    host({ desktop: true });
    render(
      <Sheet open>
        <SheetContent data-testid="sheet" />
      </Sheet>,
    );
    const close = screen.getByTestId("sheet").querySelector('[data-slot="sheet-close"]');
    expect(close).toBeTruthy();
    expect((close as HTMLElement).style.top).toContain("env(titlebar-area-height");
    expect((close as HTMLElement).style.top).toContain("0.75rem");
  });

  it("does not reserve caption space above a bottom sheet", () => {
    host({ desktop: true });
    render(
      <Sheet open>
        <SheetContent side="bottom" data-testid="sheet" />
      </Sheet>,
    );
    const el = screen.getByTestId("sheet");
    expect(el.getAttribute("data-caption-inset")).toBeNull();
    expect(el.style.paddingTop).toBe("");
  });

  it("keeps web and non-desktop hosts free of caption styling", () => {
    host(undefined);
    render(
      <Sheet open>
        <SheetContent data-testid="sheet" />
      </Sheet>,
    );
    const el = screen.getByTestId("sheet");
    expect(el.getAttribute("data-caption-inset")).toBeNull();
    expect(el.style.paddingTop).toBe("");
    const close = el.querySelector('[data-slot="sheet-close"]');
    expect(close).toBeTruthy();
    expect((close as HTMLElement).style.top).toBe("");
  });

  it("lets caller style set other properties while the caption guard stays last", () => {
    host({ desktop: true });
    render(
      <Sheet open>
        <SheetContent data-testid="sheet" style={{ background: "rgb(1, 2, 3)" }} />
      </Sheet>,
    );
    const el = screen.getByTestId("sheet");
    expect(el.getAttribute("data-caption-inset")).toBe("true");
    expect(el.style.background).toContain("rgb(1, 2, 3)");
    expect(el.style.paddingTop).toContain("calc(");
  });

  it("keeps Escape closing the sheet itself, separate from the native window close", async () => {
    host({ desktop: true });
    const onOpenChange = vi.fn();
    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent data-testid="sheet" />
      </Sheet>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
