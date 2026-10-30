import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema } from "../../src/shared/contracts";
import { api } from "../../src/web/api";
import { ConfirmDialog } from "../../src/web/components/confirmation";
import { Field } from "../../src/web/components/form-field";
import { Button } from "../../src/web/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../../src/web/components/ui/dialog";
import { Input } from "../../src/web/components/ui/input";
import { Slider } from "../../src/web/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../src/web/components/ui/tooltip";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { CapabilitiesWorkspace } from "../../src/web/screens/connections/CapabilitiesWorkspace";
import { ContextMeter } from "../../src/web/screens/conversations/ContextMeter";
import { KnowledgeLibrary } from "../../src/web/screens/library/KnowledgeLibrary";
import { WorkspaceHelp } from "../../src/web/workspace/WorkspaceHelp";
import { fixtureStore as store } from "./helpers/chat-fixture";
import { document as libraryDocument, setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests();
});
afterEach(() => {
  cleanup();
  selectLocale("zh-CN");
});

describe("shared accessible form fields", () => {
  it("explicit Agent choice uses a unique visible label bound to the native select", async () => {
    const agent = AgentResponseSchema.parse({
      id: "A",
      name: "Agent A",
      model_name: "model",
      persona_intensity: 60,
      config_version: 1,
      created_at: "2026-10-28T00:00:00.000Z",
      updated_at: "2026-10-28T00:00:00.000Z",
    });
    store.getState().resetForTests({
      ...api,
      getToolDirectory: vi.fn(async () => ({ tools: [] })),
      getSkills: vi.fn(async () => ({ skills: [], problems: [] })),
    });
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "capability-memory",
      agents: [agent],
    });
    const view = render(<CapabilitiesWorkspace />);
    const select = screen.getByRole("combobox", { name: "选择要配置的 Agent" });
    const label = view.container.querySelector<HTMLLabelElement>(`label[for="${select.id}"]`)!;
    expect(label.control).toBe(select);
    await userEvent.click(label);
    expect(document.activeElement).toBe(select);
    expect(screen.getByRole("button", { name: "配置此 Agent 的资料读取" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.change(select, { target: { value: "A" } });
    expect(screen.getByRole("button", { name: "配置此 Agent 的资料读取" })).toHaveProperty(
      "disabled",
      false,
    );
  });
  it("gives the input one accessible label and lets clicking the label focus it", async () => {
    render(
      <Field label="models.name" info="models.secretHint">
        <Input />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: i18n.t("models.name") });
    // A labelled wrapper must not compete with its control for the same name.
    expect(screen.getAllByLabelText(i18n.t("models.name"))).toEqual([input]);
    await userEvent.click(screen.getByText(i18n.t("models.name")));
    expect(document.activeElement).toBe(input);
    const description = document.getElementById(input.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe(i18n.t("models.secretHint"));
  });
  it("keeps repeated controls uniquely associated with their own labels", async () => {
    render(
      <>
        <Field label="models.name">
          <Input defaultValue="First" />
        </Field>
        <Field label="models.name">
          <Input defaultValue="Second" />
        </Field>
      </>,
    );
    const inputs = screen.getAllByRole("textbox", { name: i18n.t("models.name") });
    expect(new Set(inputs.map((input) => input.id)).size).toBe(2);
    const labels = screen.getAllByText(i18n.t("models.name"));
    await userEvent.click(labels[1]);
    expect(document.activeElement).toBe(inputs[1]);
  });
  it("preserves an explicit control name and exposes slider semantics on the focusable thumb", async () => {
    const change = vi.fn();
    render(
      <>
        <Field label="models.name">
          <Input aria-label="Provider alias" />
        </Field>
        <Field label="workspace.context_usage">
          <Slider defaultValue={[20]} min={0} max={100} onValueChange={change} />
        </Field>
      </>,
    );
    expect(screen.getByRole("textbox", { name: "Provider alias" })).toBeTruthy();
    const thumb = screen.getByRole("slider", { name: i18n.t("workspace.context_usage") });
    expect(thumb.getAttribute("aria-valuenow")).toBe("20");
    thumb.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(change).toHaveBeenLastCalledWith([21]);
    expect(thumb.getAttribute("aria-valuenow")).toBe("21");
  });
  it("updates an existing control's accessible name when the language changes", () => {
    render(
      <Field label="models.name">
        <Input />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "名称" });
    act(() => selectLocale("en"));
    expect(screen.getByRole("textbox", { name: "Name" })).toBe(input);
  });
});

describe("confirmation and contextual information", () => {
  it("keeps an asynchronous confirmation open, disables repeat actions and blocks Escape until settled", async () => {
    let finish!: () => void;
    const confirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const cancel = vi.fn();
    render(
      <ConfirmDialog open message="Remove this provider?" onConfirm={confirm} onCancel={cancel} />,
    );
    const dialog = screen.getByRole("alertdialog", { name: "Remove this provider?" });
    const cancelButton = within(dialog).getByRole("button", { name: i18n.t("connections.cancel") });
    const confirmButton = within(dialog).getByRole("button", {
      name: i18n.t("connections.confirm"),
    });
    expect(document.activeElement).toBe(cancelButton);
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirmButton).toHaveProperty("disabled", true);
    expect(cancelButton).toHaveProperty("disabled", true);
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(confirmButton).toHaveProperty("disabled", false));
    await userEvent.keyboard("{Escape}");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("does not announce an unknown circular reading as zero and opens its explanation by keyboard", async () => {
    store.setState({ currentSessionId: "session", contextUsage: null, sending: false });
    render(<ContextMeter />);
    const trigger = screen.getByRole("button", { name: i18n.t("workspace.context_usage") });
    expect(trigger.textContent).toContain("—");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(trigger.textContent).not.toContain("0.0%");
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const popover = screen.getByRole("dialog", { name: i18n.t("workspace.context_usage") });
    expect(within(popover).getByText(/尚无请求统计/)).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

it.each([
  ["zh-CN", "import"],
  ["en", "import"],
  ["zh-CN", "document"],
  ["en", "document"],
] as const)(
  "%s %s category label focuses the real control and saves its selected ID",
  async (locale, kind) => {
    const categoryId = "66666666-6666-4666-8666-666666666666";
    const importKnowledgeText = vi.fn(async () => libraryDocument);
    const updateKnowledgeDocument = vi.fn(async () => libraryDocument);
    setupLibrary({
      importKnowledgeText,
      updateKnowledgeDocument,
      listKnowledgeCategories: vi.fn(async () => [
        { id: "default", name: "General", revision: 1, document_count: 1 },
        { id: categoryId, name: "Research", revision: 1, document_count: 0 },
      ]),
    });
    selectLocale(locale);
    store.setState({ settingsRoute: "knowledge-config" });
    const view = render(<KnowledgeLibrary />);
    await screen.findByRole("button", { name: libraryDocument.name });
    await act(async () => {
      store
        .getState()
        .requestKnowledgeEditor(kind === "document" ? { kind, id: libraryDocument.id } : { kind });
    });
    const dialog = await screen.findByRole("dialog", {
      name: i18n.t(kind === "import" ? "library.import.document" : "library.document.workbench"),
    });
    const category = within(dialog).getByRole("combobox", { name: i18n.t("library.category") });
    const label = view.baseElement.querySelector<HTMLLabelElement>(`label[for="${category.id}"]`)!;
    expect(label.control).toBe(category);
    expect(view.baseElement.querySelectorAll(`[id="${category.id}"]`)).toHaveLength(1);
    await userEvent.click(label);
    expect(document.activeElement).toBe(category);
    await userEvent.selectOptions(category, categoryId);
    if (kind === "import") {
      await userEvent.type(
        within(dialog).getByRole("textbox", { name: i18n.t("library.name") }),
        "Imported reference",
      );
      await userEvent.type(
        within(dialog).getByRole("textbox", { name: i18n.t("library.original.text") }),
        "Exact pasted source",
      );
    }
    await userEvent.click(within(dialog).getByRole("button", { name: i18n.t("library.save") }));
    await waitFor(() => expect(store.getState().knowledgeEditor).toBeNull());
    if (kind === "import") {
      expect(importKnowledgeText).toHaveBeenCalledWith({
        name: "Imported reference",
        category_id: categoryId,
        original_text: "Exact pasted source",
      });
      expect(updateKnowledgeDocument).not.toHaveBeenCalled();
    } else {
      expect(updateKnowledgeDocument).toHaveBeenCalledWith(libraryDocument.id, {
        expected_revision: libraryDocument.revision,
        name: libraryDocument.name,
        category_id: categoryId,
        original_text: libraryDocument.original_text,
        content_mode: libraryDocument.content_mode,
      });
      expect(importKnowledgeText).not.toHaveBeenCalled();
    }
  },
);

describe("shared tooltip pointer and help access", () => {
  it.each(["direct", "wrapped"] as const)(
    "%s trigger keeps tooltip content out of the primary pointer gesture",
    async (kind) => {
      const invoke = vi.fn();
      const focus = vi.fn();
      render(
        kind === "wrapped" ? (
          <Button tooltip="Open the assistant workspace" onClick={invoke} onFocus={focus}>
            Assistant
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={invoke} onFocus={focus}>
                Assistant
              </button>
            </TooltipTrigger>
            <TooltipContent>Open the assistant workspace</TooltipContent>
          </Tooltip>
        ),
      );
      const trigger = screen.getByRole("button", { name: "Assistant" });
      // jsdom has no layout hit testing; this checks event ordering, not the Edge hit target.
      fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0, pointerId: 1 });
      act(() => trigger.focus());
      expect(focus).toHaveBeenCalledTimes(1);
      const duringPress = screen.queryByRole("tooltip");
      if (duringPress) expect(duringPress.style.pointerEvents).toBe("none");
      fireEvent.pointerUp(trigger, { pointerType: "mouse", button: 0, pointerId: 1 });
      if (duringPress?.isConnected) expect(duringPress.style.pointerEvents).toBe("none");
      fireEvent.click(trigger);
      expect(invoke).toHaveBeenCalledTimes(1);
      act(() => trigger.blur());
      act(() => trigger.focus());
      expect(await screen.findByRole("tooltip")).toHaveProperty(
        "textContent",
        "Open the assistant workspace",
      );
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
      expect(document.activeElement).toBe(trigger);
    },
  );

  it("retains hoverable tooltip content without invoking the described control", async () => {
    const invoke = vi.fn();
    render(
      <Button tooltip="Selectable explanatory text" onClick={invoke}>
        Action
      </Button>,
    );
    const trigger = screen.getByRole("button", { name: "Action" });
    await userEvent.hover(trigger);
    const content = await screen.findByRole("tooltip");
    expect(content.style.pointerEvents).not.toBe("none");
    expect(content.className.split(/\s+/)).not.toContain("pointer-events-none");
    await userEvent.hover(content);
    expect(screen.getByRole("tooltip")).toBe(content);
    expect(invoke).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("keeps a disabled reason reachable by keyboard without enabling its action", async () => {
    const invoke = vi.fn();
    render(
      <Button disabled tooltip="Save" disabledReason="No changes to save" onClick={invoke}>
        Save
      </Button>,
    );
    const trigger = screen.getByRole("group", { name: "Save" });
    trigger.focus();
    expect(await screen.findByRole("tooltip")).toHaveProperty("textContent", "No changes to save");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    await userEvent.keyboard("{Enter}");
    expect(invoke).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("keeps field help keyboard access and the real input label independent", async () => {
    render(
      <Field label="models.name" tooltip="Use a recognizable provider name">
        <Input />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: i18n.t("models.name") });
    const help = screen.getByRole("button", {
      name: i18n.t("hints.field.learnAbout", { "0": i18n.t("models.name") }),
    });
    help.focus();
    expect(await screen.findByRole("tooltip")).toHaveProperty(
      "textContent",
      "Use a recognizable provider name",
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    await userEvent.click(screen.getByText(i18n.t("models.name")));
    expect(document.activeElement).toBe(input);
  });

  it.each(["touch", "keyboard"] as const)(
    "%s can pin existing workspace help without opening a new surface",
    async (input) => {
      render(
        <WorkspaceHelp title="Agent tools" description="Grants remain scoped to this Agent" />,
      );
      const trigger = screen.getByRole("button", {
        name: i18n.t("hints.field.learnAbout", { "0": "Agent tools" }),
      });
      if (input === "touch") {
        fireEvent.pointerDown(trigger, { pointerType: "touch", pointerId: 2 });
        fireEvent.pointerUp(trigger, { pointerType: "touch", pointerId: 2 });
        fireEvent.click(trigger);
      } else {
        trigger.focus();
        await userEvent.keyboard("{Enter}");
      }
      expect(await screen.findByRole("tooltip")).toHaveProperty(
        "textContent",
        "Grants remain scoped to this Agent",
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
      if (input === "keyboard") expect(document.activeElement).toBe(trigger);
    },
  );
  it("dismisses the highest tooltip on Escape without closing its containing dialog", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Inspection</DialogTitle>
          <button type="button">First control</button>
          <Button tooltip="Inspect the selected item">Inspect</Button>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Inspection" });
    const first = within(dialog).getByRole("button", { name: "First control" });
    first.focus();
    await userEvent.tab();
    const inspect = within(dialog).getByRole("button", { name: "Inspect" });
    expect(document.activeElement).toBe(inspect);
    await screen.findByRole("tooltip");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Inspection" })).toBe(dialog);
    expect(document.activeElement).toBe(inspect);
  });
});

describe("tooltip press arbitration", () => {
  it.each(["capture", "cancel"] as const)(
    "preserves controlled %s open state while protecting the trigger's release target",
    async (ending) => {
      const capture = vi.fn();
      const bubble = vi.fn();
      const click = vi.fn();
      const ref = { current: null as HTMLButtonElement | null };
      function ControlledHelp() {
        const [open, setOpen] = useState(false);
        const pinned = useRef(false);
        return (
          <Tooltip
            open={open}
            onOpenChange={(next) => {
              if (!pinned.current) setOpen(next);
            }}
          >
            <TooltipTrigger asChild preserveTriggerState>
              <button
                ref={ref}
                type="button"
                data-state="selected"
                onPointerDownCapture={(event) => {
                  capture();
                  event.preventDefault();
                  setOpen(true);
                }}
                onPointerDown={bubble}
                onClick={() => {
                  click();
                  pinned.current = true;
                  setOpen(true);
                }}
              >
                Help
              </button>
            </TooltipTrigger>
            <TooltipContent>Controlled explanation</TooltipContent>
          </Tooltip>
        );
      }
      render(<ControlledHelp />);
      const trigger = screen.getByRole("button", { name: "Help" });
      expect(ref.current).toBe(trigger);
      const accepted = fireEvent.pointerDown(trigger, {
        pointerType: "mouse",
        pointerId: 3,
        button: 0,
      });
      expect(accepted).toBe(false);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(bubble).toHaveBeenCalledTimes(1);
      expect(trigger.getAttribute("data-state")).toBe("selected");
      const explanation = await screen.findByRole("tooltip");
      expect(explanation.style.pointerEvents).toBe("none");
      if (ending === "cancel") {
        fireEvent.pointerCancel(trigger, { pointerId: 3 });
        expect(explanation.style.pointerEvents).not.toBe("none");
      } else {
        fireEvent.pointerUp(trigger, { pointerId: 3 });
        expect(explanation.style.pointerEvents).toBe("none");
      }
      fireEvent.click(trigger);
      expect(explanation.style.pointerEvents).not.toBe("none");
      expect(click).toHaveBeenCalledTimes(1);
      expect(await screen.findByRole("tooltip")).toHaveProperty(
        "textContent",
        "Controlled explanation",
      );
    },
  );

  it("preserves defaultOpen and reports a normal keyboard dismissal once", async () => {
    const change = vi.fn();
    render(
      <Tooltip defaultOpen onOpenChange={change}>
        <TooltipTrigger>Explain</TooltipTrigger>
        <TooltipContent>Initially open explanation</TooltipContent>
      </Tooltip>,
    );
    expect(await screen.findByRole("tooltip")).toHaveProperty(
      "textContent",
      "Initially open explanation",
    );
    expect(change).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(change).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps an ordinary controlled tooltip's click-close callback after the consumer click", async () => {
    const calls: string[] = [];
    function ControlledTooltip() {
      const [open, setOpen] = useState(false);
      return (
        <Tooltip
          open={open}
          onOpenChange={(next) => {
            calls.push(`open:${next}`);
            setOpen(next);
          }}
        >
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                calls.push("click");
                setOpen(true);
              }}
            >
              Unpinned help
            </button>
          </TooltipTrigger>
          <TooltipContent>Ordinary explanation</TooltipContent>
        </Tooltip>
      );
    }
    render(<ControlledTooltip />);
    const trigger = screen.getByRole("button", { name: "Unpinned help" });
    act(() => trigger.focus());
    await screen.findByRole("tooltip");
    calls.length = 0;
    fireEvent.click(trigger);
    expect(calls).toEqual(["click", "open:false"]);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    act(() => trigger.blur());
    act(() => trigger.focus());
    expect(await screen.findByRole("tooltip")).toHaveProperty(
      "textContent",
      "Ordinary explanation",
    );
  });

  it("restores consumer pointer styling after an outside release with no trigger click", async () => {
    render(
      <Tooltip open>
        <TooltipTrigger>Press origin</TooltipTrigger>
        <TooltipContent style={{ pointerEvents: "auto", userSelect: "text" }}>
          Copy this explanation
        </TooltipContent>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Press origin" });
    const content = await screen.findByRole("tooltip");
    fireEvent.pointerDown(trigger, { pointerId: 4, pointerType: "mouse", button: 0 });
    expect(content.style.pointerEvents).toBe("none");
    fireEvent.pointerUp(document.body, { pointerId: 4 });
    expect(content.style.pointerEvents).toBe("auto");
    expect(content.style.userSelect).toBe("text");
    fireEvent.pointerDown(content, { pointerId: 5, pointerType: "mouse", button: 0 });
    expect(content.style.pointerEvents).toBe("auto");
  });

  it("releases only after a stopped trigger click has run its original handler", async () => {
    let pointerStyleAtClick = "";
    render(
      <Tooltip open>
        <TooltipTrigger
          onClick={(event) => {
            pointerStyleAtClick = screen.getByRole("tooltip").style.pointerEvents;
            event.stopPropagation();
          }}
        >
          Press origin
        </TooltipTrigger>
        <TooltipContent>Retained explanation</TooltipContent>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Press origin" });
    const content = await screen.findByRole("tooltip");
    fireEvent.pointerDown(trigger, { pointerId: 6, pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(trigger, { pointerId: 6 });
    fireEvent.click(trigger);
    expect(pointerStyleAtClick).toBe("none");
    await act(async () => {});
    expect(content.style.pointerEvents).not.toBe("none");
  });

  it("marks only the pressed tooltip's generated positioning wrapper until the click settles", async () => {
    const selector =
      '[data-radix-popper-content-wrapper]:has(> [data-slot="tooltip-content"][data-trigger-press="true"])';
    const css = readFileSync("src/web/styles.css", "utf8");
    const rule = css.match(
      /\[data-radix-popper-content-wrapper\]:has\(\s*>\s*\[data-slot="tooltip-content"\]\[data-trigger-press="true"\]\s*\)\s*\{([^}]*)\}/,
    );
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/^\s*pointer-events\s*:\s*none\s*;\s*$/);
    render(
      <>
        <Tooltip open>
          <TooltipTrigger>First origin</TooltipTrigger>
          <TooltipContent style={{ pointerEvents: "auto", userSelect: "text" }}>
            First explanation
          </TooltipContent>
        </Tooltip>
        <Tooltip open>
          <TooltipTrigger>Second origin</TooltipTrigger>
          <TooltipContent>Second explanation</TooltipContent>
        </Tooltip>
      </>,
    );
    const first = await screen.findByRole("tooltip", { name: "First explanation" });
    const second = screen.getByRole("tooltip", { name: "Second explanation" });
    const wrapper = first.parentElement!;
    expect(wrapper.hasAttribute("data-radix-popper-content-wrapper")).toBe(true);
    expect(second.parentElement?.hasAttribute("data-radix-popper-content-wrapper")).toBe(true);
    expect(document.querySelectorAll(selector)).toHaveLength(0);
    const trigger = screen.getByRole("button", { name: "First origin" });
    fireEvent.pointerDown(trigger, { pointerId: 7, pointerType: "mouse", button: 0 });
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)).toBe(wrapper);
    expect(first.style.pointerEvents).toBe("none");
    expect(second.getAttribute("data-trigger-press")).toBeNull();
    fireEvent.pointerUp(trigger, { pointerId: 7 });
    expect(wrapper.matches(selector)).toBe(true);
    fireEvent.click(trigger);
    expect(wrapper.matches(selector)).toBe(false);
    expect(document.querySelectorAll(selector)).toHaveLength(0);
    expect(first.style.pointerEvents).toBe("auto");
    expect(first.style.userSelect).toBe("text");
    fireEvent.pointerDown(first, { pointerId: 8, pointerType: "mouse", button: 0 });
    expect(wrapper.matches(selector)).toBe(false);
  });
});
