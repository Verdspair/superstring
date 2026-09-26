import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BrandLogo } from "../../src/web/design-system/BrandLogo";
import { IconButton } from "../../src/web/design-system/IconButton";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";

afterEach(cleanup);

it("preserves the original product mark independently of the functional icon family", () => {
  const { container } = render(<BrandLogo />);
  expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
  expect([...container.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual([
    "M7.6 10h8.8a1.6 1.6 0 0 1 1.6 1.6V17a1.6 1.6 0 0 1-1.6 1.6h-6.9l-1.9 1.9v-1.9A1.6 1.6 0 0 1 6 17v-5.4A1.6 1.6 0 0 1 7.6 10Z",
    "M1.85 3.55c-.38 .57-.6175 1.1875-.7125 1.8525c.38-.0475 .7125-.266 .931-.57",
    "M3.7025 3.55c-.38 .57-.6175 1.1875-.7125 1.8525c.38-.0475 .7125-.266 .931-.57",
    "M20.2975 5.4025c.38-.57 .6175-1.1875 .7125-1.8525c-.38 .0475-.7125 .266-.931 .57",
    "M22.15 5.4025c.38-.57 .6175-1.1875 .7125-1.8525c-.38 .0475-.7125 .266-.931 .57",
    "M7.95 14.85C8.6 14.85 8.775 13.1 10.065 13.1C10.71 13.1 11.355 13.5 12 14.3C12.645 15.1 13.29 15.5 13.935 15.5C15.225 15.5 15.4 13.75 16.05 13.75",
  ]);
  expect(
    [...container.querySelectorAll("circle")].map((circle) => [
      circle.getAttribute("cx"),
      circle.getAttribute("cy"),
      circle.getAttribute("r"),
    ]),
  ).toEqual([
    ["10.065", "13.1", "1.6"],
    ["13.935", "15.5", "1.6"],
  ]);
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
