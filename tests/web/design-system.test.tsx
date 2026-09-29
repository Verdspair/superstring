import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BrandLogo } from "../../src/web/design-system/BrandLogo";

afterEach(cleanup);

it("shares the canonical brand asset without adding an accessible duplicate name", () => {
  const { container } = render(<BrandLogo className="size-9 text-primary" />);
  const svg = container.querySelector("svg");
  expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
  expect(svg?.getAttribute("focusable")).toBe("false");
  expect(svg?.getAttribute("class")).toContain("text-primary");
  expect(svg?.querySelector("use")?.getAttribute("href")).toMatch(
    /superstring\.svg(?:\?[^#]*)?#mark$/,
  );
});
