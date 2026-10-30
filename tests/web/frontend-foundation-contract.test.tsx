import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Field } from "../../src/web/components/form-field";
import { SettingsRow } from "../../src/web/components/settings-group";
import { Badge } from "../../src/web/components/ui/badge";
import { Button } from "../../src/web/components/ui/button";
import { Input } from "../../src/web/components/ui/input";
import {
  InputGroup,
  InputGroupInput,
  InputGroupTextarea,
} from "../../src/web/components/ui/input-group";
import { ScrollArea, ScrollBar } from "../../src/web/components/ui/scroll-area";
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

describe("shared grouped control focus", () => {
  it("keeps native input and textarea in their own groups and respects disabled focus", () => {
    render(
      <>
        <InputGroup>
          <InputGroupInput aria-label="Search directory" />
        </InputGroup>
        <InputGroup>
          <InputGroupTextarea aria-label="Message draft" />
        </InputGroup>
        <InputGroup>
          <InputGroupInput aria-label="Unavailable" disabled />
        </InputGroup>
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Search directory" });
    const textarea = screen.getByRole("textbox", { name: "Message draft" });
    const disabled = screen.getByRole("textbox", { name: "Unavailable" });
    expect(input.closest('[data-slot="input-group"]')).not.toBe(
      textarea.closest('[data-slot="input-group"]'),
    );
    expect(input.getAttribute("data-slot")).toBe("input-group-control");
    expect(textarea.getAttribute("data-slot")).toBe("input-group-control");
    input.focus();
    expect(document.activeElement).toBe(input);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    disabled.focus();
    expect(document.activeElement).toBe(textarea);
  });
});

describe("shared ScrollArea content sizing", () => {
  it("owns bounded generated content without replacing native controls or the root ref", () => {
    const ref = createRef<HTMLDivElement>();
    const view = render(
      <ScrollArea ref={ref} aria-label="Form reader" className="h-40" dir="rtl" type="always">
        <input aria-label="Retained form draft" defaultValue="saved" />
      </ScrollArea>,
    );
    const root = view.container.querySelector('[data-slot="scroll-area"]');
    const viewport = root?.querySelector('[data-slot="scroll-area-viewport"]');
    expect(ref.current).toBe(root);
    expect(root?.getAttribute("dir")).toBe("rtl");
    expect(root?.getAttribute("aria-label")).toBe("Form reader");
    expect(root?.className).toContain("h-40");
    expect(root?.getAttribute("data-content-sizing")).toBe("bounded");
    expect(viewport?.className).toContain("[&>div]:block!");
    expect(viewport?.className).toContain("[&>div]:w-full!");
    expect(viewport?.className).toContain("[&>div]:min-w-0!");
    const input = screen.getByRole("textbox", { name: "Retained form draft" });
    fireEvent.change(input, { target: { value: "unsaved" } });
    input.focus();
    view.rerender(
      <ScrollArea ref={ref} contentSizing="intrinsic" aria-label="Form reader" className="h-40">
        <input aria-label="Retained form draft" defaultValue="saved" />
      </ScrollArea>,
    );
    expect(ref.current).toBe(root);
    expect(screen.getByRole("textbox", { name: "Retained form draft" })).toBe(input);
    expect((input as HTMLInputElement).value).toBe("unsaved");
    expect(document.activeElement).toBe(input);
    expect(root?.getAttribute("data-content-sizing")).toBe("intrinsic");
    expect(viewport?.className).not.toContain("[&>div]:block!");
    expect(viewport?.className).not.toContain("[&>div]:w-full!");
    expect(viewport?.className).not.toContain("[&>div]:min-w-0!");
  });

  it("leaves an explicit intrinsic timeline and its horizontal scrollbar intact", () => {
    const { container } = render(
      <ScrollArea contentSizing="intrinsic" className="h-40" type="always">
        <section aria-label="Wide timeline" className="min-w-[42rem]">
          <button type="button">Last timeline step</button>
        </section>
        <ScrollBar orientation="horizontal" forceMount />
      </ScrollArea>,
    );
    const timeline = screen.getByRole("region", { name: "Wide timeline" });
    expect(timeline.className).toContain("min-w-[42rem]");
    const lastStep = screen.getByRole("button", { name: "Last timeline step" });
    lastStep.focus();
    expect(document.activeElement).toBe(lastStep);
    expect(
      container.querySelector('[data-slot="scroll-area-scrollbar"][data-orientation="horizontal"]'),
    ).toBeTruthy();
    expect(container.querySelector('[data-slot="scroll-area-viewport"]')?.className).not.toContain(
      "[&>div]:block!",
    );
  });
});

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

  it("keeps badge variants and child composition while allowing content-driven height", () => {
    const { rerender } = render(<Badge variant="outline">Accessible label</Badge>);
    const badge = screen.getByText("Accessible label");
    expect(badge.getAttribute("data-variant")).toBe("outline");
    rerender(
      <Badge asChild variant="secondary">
        <a href="#details">Details</a>
      </Badge>,
    );
    const link = screen.getByRole("link", { name: "Details" });
    expect(link.getAttribute("data-slot")).toBe("badge");
    expect(link.getAttribute("data-variant")).toBe("secondary");
    expect(link.getAttribute("href")).toBe("#details");
  });

  it.each([
    "所属模块已暂停；重新启用后仍需满足此资源的授权。",
    "The parent module is paused; its grants still apply when resumed.",
    "unbroken-status-identifier-without-spaces-0123456789",
  ])("wraps an explicitly opted-in badge without changing compact peers: %s", (label) => {
    const { rerender } = render(
      <>
        <Badge variant="secondary">12</Badge>
        <Badge wrap variant="outline">
          {label}
        </Badge>
      </>,
    );
    const counter = screen.getByText("12");
    const status = screen.getByText(label);
    expect(counter.getAttribute("data-wrap")).toBeNull();
    expect(counter.className).toContain("whitespace-nowrap");
    expect(status.getAttribute("data-wrap")).toBe("true");
    expect(status.textContent).toBe(label);
    expect(status.className).toContain("max-w-full");
    expect(status.className).toContain("whitespace-normal");
    expect(status.className).not.toContain("whitespace-nowrap");
    expect(status.className).toContain("h-auto");
    rerender(
      <Badge asChild wrap variant="outline" className="text-center">
        <a href="#status">{label}</a>
      </Badge>,
    );
    const link = screen.getByRole("link", { name: label });
    expect(link.getAttribute("data-wrap")).toBe("true");
    expect(link.getAttribute("data-variant")).toBe("outline");
    expect(link.getAttribute("href")).toBe("#status");
    expect(link.className).toContain("text-center");
    expect(link.className).not.toContain("text-left");
  });

  describe("R27 Radix tooltip contract for foundation components", () => {
    it("declares an explicit keyboard outline style on the shared Button and disabled explanation owner", () => {
      render(
        <TooltipProvider>
          <Button>Focusable</Button>
          <Button disabled disabledReason="Unavailable">
            Disabled
          </Button>
        </TooltipProvider>,
      );
      const button = screen.getByRole("button", { name: "Focusable" });
      const wrapper = screen.getByRole("group", { name: "Disabled" });
      expect(button.className).toContain("focus-visible:outline-solid");
      expect(wrapper.className).toContain("focus-visible:outline-solid");
      expect(button.className).toContain("outline-none");
      expect(wrapper.tabIndex).toBe(0);
    });
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

it("keeps the shared SettingsRow control lane at its default without an override", () => {
  render(
    <SettingsRow label={<label htmlFor="default-row-input">Default row</label>}>
      <Input aria-label="Default row control" id="default-row-input" />
    </SettingsRow>,
  );
  const input = screen.getByRole("textbox", { name: "Default row control" });
  const lane = input.parentElement;
  expect(lane).toBeTruthy();
  expect(lane?.className).toContain("sm:ml-auto");
  expect(lane?.className).not.toContain("sm:flex-1");
});
