import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Field } from "../../src/web/components/form-field";
import { Button } from "../../src/web/components/ui/button";
import { Input } from "../../src/web/components/ui/input";
import { TooltipProvider } from "../../src/web/components/ui/tooltip";
import { translate } from "../../src/web/i18n";
import { ContentReader } from "../../src/web/screens/observability/ContentReader";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const web = join(root, "src/web");
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
afterEach(cleanup);

describe("frontend foundation boundaries", () => {
  it("has no remaining presentation files under the retired UI namespaces", () => {
    const retired = sources(web).filter(
      (path) => /\/web\/(app|features|ui)\//.test(path) && extname(path) === ".tsx",
    );
    expect(retired.map((path) => path.slice(root.length + 1))).toEqual([]);
  });
  it("retains mature interaction, async, internationalization and visualization foundations", () => {
    const { dependencies } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const dependency of [
      "radix-ui",
      "cmdk",
      "react-resizable-panels",
      "effect",
      "motion",
      "i18next",
      "react-i18next",
      "react-circular-progressbar",
      "@tanstack/react-table",
    ])
      expect(
        dependencies[dependency],
        `${dependency} must remain a declared runtime dependency`,
      ).toBeTruthy();
  });
  it("never interprets model, conversation or document text through React raw-HTML sinks", () => {
    const violations: string[] = [];
    for (const path of sources(web)) {
      const source = readFileSync(path, "utf8");
      if (/\bdangerouslySetInnerHTML\b|\.(?:innerHTML|outerHTML)\s*=/.test(source))
        violations.push(path.slice(root.length + 1));
    }
    expect(violations).toEqual([]);
  });
  it("renders hostile model text literally in the actual evidence reader", () => {
    const text = '<img src=x onerror="alert(1)"><script>execute()</script> & raw text';
    const { container } = render(
      <TooltipProvider>
        <ContentReader text={text} label="Actual model output" />
      </TooltipProvider>,
    );
    expect(container.textContent).toContain(text);
    expect(container.querySelector("img, script")).toBeNull();
  });

  describe("R27 Radix tooltip contract for foundation components", () => {
    it("renders standard Button without tooltip wrapper when no tooltip is provided", () => {
      const { container } = render(<Button>Plain Button</Button>);
      const button = screen.getByRole("button", { name: "Plain Button" });
      expect(button).toBeTruthy();
      expect(button.getAttribute("data-slot")).toBe("button");
      expect(container.querySelector("[data-slot=tooltip-trigger]")).toBeNull();
    });

    it("opens the supplemental Button tooltip on focus and closes it with Escape", async () => {
      render(
        <TooltipProvider delayDuration={350} skipDelayDuration={100}>
          <Button tooltip="Save retrieval rules">Save Rules</Button>
        </TooltipProvider>,
      );
      const button = screen.getByRole("button", { name: "Save Rules" });
      expect(button).toBeTruthy();
      fireEvent.focus(button);
      expect((await screen.findByRole("tooltip")).textContent).toBe("Save retrieval rules");
      fireEvent.keyDown(button, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    });

    it("renders disabled Button with accessible focusable wrapper and disabled reason", () => {
      let clicked = false;
      render(
        <TooltipProvider delayDuration={350} skipDelayDuration={100}>
          <Button
            disabled
            disabledReason="Form matches baseline; no unsaved edits present."
            onClick={() => {
              clicked = true;
            }}
          >
            Reset Edits
          </Button>
        </TooltipProvider>,
      );
      const wrapper = screen.getByRole("group", { name: "Reset Edits" });
      expect(screen.getAllByRole("button", { name: "Reset Edits" })).toHaveLength(1);
      expect(wrapper.getAttribute("aria-disabled")).toBe("true");
      expect(wrapper.tabIndex).toBe(0);

      // Verify disabled button inside does not trigger onClick
      fireEvent.click(wrapper);
      expect(clicked).toBe(false);
    });

    it("keeps the button node and native disabled guard while availability changes", () => {
      let clicks = 0;
      const button = (disabled: boolean) => (
        <TooltipProvider delayDuration={350} skipDelayDuration={100}>
          <Button disabled={disabled} tooltip="Save this draft" onClick={() => clicks++}>
            Save
          </Button>
        </TooltipProvider>
      );
      const view = render(button(true));
      const native = screen.getByRole("button", { name: "Save" });
      fireEvent.click(native);
      expect(clicks).toBe(0);
      view.rerender(button(false));
      expect(screen.getByRole("button", { name: "Save" })).toBe(native);
      expect(native.isConnected).toBe(true);
      fireEvent.click(native);
      expect(clicks).toBe(1);
      view.rerender(button(true));
      expect(screen.getByRole("button", { name: "Save" })).toBe(native);
      fireEvent.click(native);
      expect(clicks).toBe(1);
    });

    it("preserves Field visible description while allowing complementary tooltip in title", () => {
      render(
        <TooltipProvider delayDuration={350} skipDelayDuration={100}>
          <Field
            label="memory_retrieval_prompt"
            info="Non-blank 1 to 16,000 characters."
            tooltip="Detailed retrieval intent instructions."
          >
            <Input id="prompt-input" />
          </Field>
        </TooltipProvider>,
      );

      // Verify input id and aria associations
      const input = screen.getByRole("textbox");
      expect(input.id).toBe("prompt-input");
      expect(input.getAttribute("aria-describedby")).toContain("-description");

      // Verify visible description remains in document flow (not hidden in tooltip)
      expect(screen.getByText("Non-blank 1 to 16,000 characters.")).toBeTruthy();

      // Verify complementary tooltip trigger button exists
      const helpButton = screen.getByRole("button", {
        name: translate("hints.field.learnAbout", "memory_retrieval_prompt"),
      });
      expect(helpButton).toBeTruthy();
    });
  });
});
