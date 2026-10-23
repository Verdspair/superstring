import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Checkbox } from "../../src/web/components/ui/checkbox";
import { render as renderWithProviders } from "./helpers/render-with-providers";

afterEach(cleanup);

function ControlledCheckbox({ initial = false }: { initial?: boolean | "indeterminate" }) {
  const [checked, setChecked] = useState(initial);
  return <Checkbox aria-label="Agree" checked={checked} onCheckedChange={setChecked} />;
}

describe("checkbox persistent indicator", () => {
  it("keeps the indicator node through pointer toggles and exposes the checked state", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ControlledCheckbox />);
    const root = screen.getByRole("checkbox", { name: "Agree" });
    const indicator = root.querySelector('[data-slot="checkbox-indicator"]');
    expect(indicator).not.toBeNull();
    expect(root.getAttribute("aria-checked")).toBe("false");
    expect(indicator?.getAttribute("data-state")).toBe("unchecked");
    await user.click(root);
    expect(root.getAttribute("aria-checked")).toBe("true");
    expect(indicator?.getAttribute("data-state")).toBe("checked");
    await user.click(root);
    expect(root.getAttribute("aria-checked")).toBe("false");
    expect(indicator?.getAttribute("data-state")).toBe("unchecked");
    expect(root.querySelector('[data-slot="checkbox-indicator"]')).toBe(indicator);
  });

  it("keeps indeterminate and keyboard semantics", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ControlledCheckbox initial="indeterminate" />);
    const root = screen.getByRole("checkbox", { name: "Agree" });
    const indicator = root.querySelector('[data-slot="checkbox-indicator"]');
    expect(root.getAttribute("aria-checked")).toBe("mixed");
    expect(indicator?.getAttribute("data-state")).toBe("indeterminate");
    await user.tab();
    await user.keyboard(" ");
    expect(root.getAttribute("aria-checked")).toBe("true");
    await user.keyboard(" ");
    expect(root.getAttribute("aria-checked")).toBe("false");
    await user.keyboard("{Enter}");
    expect(root.getAttribute("aria-checked")).toBe("false");
    expect(root.querySelector('[data-slot="checkbox-indicator"]')).toBe(indicator);
  });

  it("keeps native form value and required validity tied to the real checkbox state", async () => {
    const user = userEvent.setup();
    render(
      <form>
        <Checkbox aria-label="Consent" name="consent" value="yes" required />
      </form>,
    );
    const root = screen.getByRole("checkbox", { name: "Consent" });
    const form = root.closest("form");
    if (!form) throw new Error("Missing checkbox form");
    expect(form.checkValidity()).toBe(false);
    expect(new FormData(form).get("consent")).toBeNull();
    await user.click(root);
    expect(form.checkValidity()).toBe(true);
    expect(new FormData(form).get("consent")).toBe("yes");
    await user.click(root);
    expect(form.checkValidity()).toBe(false);
    expect(new FormData(form).get("consent")).toBeNull();
  });
});
