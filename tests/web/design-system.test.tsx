import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BrandLogo } from "../../src/web/design-system/BrandLogo";
import { IconButton } from "../../src/web/design-system/IconButton";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";

afterEach(cleanup);

it("shares the canonical brand asset without adding an accessible duplicate name", () => {
  const { container } = render(<BrandLogo className="size-9 text-primary" />);
  const svg = container.querySelector("svg");
  expect(svg?.getAttribute("viewBox")).toBe("0 0 32 32");
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
  expect(svg?.getAttribute("focusable")).toBe("false");
  expect(svg?.getAttribute("class")).toContain("text-primary");
  expect(svg?.querySelector("use")?.getAttribute("href")).toMatch(
    /superstring\.svg(?:\?[^#]*)?#mark$/,
  );
});

it("keeps icon-only actions named and functional without waiting for a tooltip", () => {
  const action = vi.fn();
  render(
    <DesignSystemProvider>
      <IconButton label="Refresh activity" icon="refresh" onClick={action} />
    </DesignSystemProvider>,
  );
  const button = screen.getByRole("button", { name: "Refresh activity" });
  fireEvent.click(button);
  expect(action).toHaveBeenCalledOnce();
  expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
});
