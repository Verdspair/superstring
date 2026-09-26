import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../src/web/components/confirmation";
import { Field } from "../../src/web/components/form-field";
import { Input } from "../../src/web/components/ui/input";
import { Slider } from "../../src/web/components/ui/slider";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { ContextMeter } from "../../src/web/screens/conversations/ContextMeter";
import { fixtureStore as store } from "./helpers/chat-fixture";

beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests();
});
afterEach(() => {
  cleanup();
  selectLocale("zh-CN");
});

describe("shared accessible form fields", () => {
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
    render(<ConfirmDialog message="Remove this provider?" onConfirm={confirm} onCancel={cancel} />);
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
