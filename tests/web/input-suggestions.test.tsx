import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import "../../src/web/i18n";
import {
  type InputSuggestion,
  InputSuggestions,
} from "../../src/web/components/ui/input-suggestions";
import { render } from "./helpers/render-with-providers";

afterEach(cleanup);

const suggestions: InputSuggestion[] = [
  { value: "qwen2.5", description: "loaded" },
  { value: "deepseek-v3", description: "external" },
  { value: "llama-3.1", description: "loaded" },
];

function Harness({
  initial = "",
  disabled = false,
  onChange = () => {},
}: {
  initial?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <InputSuggestions
      id="model-id"
      aria-label="Model id"
      suggestions={suggestions}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

function field() {
  return screen.getByRole("combobox", { name: "Model id" }) as HTMLInputElement;
}

it("retains the clipped command label and caller accessibility when suggestions open", async () => {
  const { container } = render(<Harness />);
  const input = field();
  const command = input.closest("[cmdk-root]");
  const label = command?.querySelector<HTMLLabelElement>("label[cmdk-label]");
  expect(command).toBeTruthy();
  expect(label).toBeTruthy();
  expect(label!.id).not.toBe("");
  expect(document.getElementById(label!.id)).toBe(label);
  expect(label!.textContent).toBe("Model id");
  expect(label!.style.position).toBe("absolute");
  expect(label!.style.width).toBe("1px");
  expect(label!.style.height).toBe("1px");
  expect(label!.style.overflow).toBe("hidden");
  expect(label!.style.clip).not.toBe("");
  expect(getComputedStyle(label!).display).not.toBe("none");
  expect(getComputedStyle(label!).visibility).not.toBe("hidden");
  expect(input.id).toBe("model-id");
  expect(input.getAttribute("aria-label")).toBe("Model id");
  expect(container.querySelectorAll("[cmdk-label]")).toHaveLength(1);

  await userEvent.click(input);
  expect(screen.getByRole("listbox", { name: "Model id" })).toBeTruthy();
  expect(command!.querySelector("[cmdk-label]")).toBe(label);
  expect(field()).toBe(input);
});

it("keeps freeform typing as the value and leaves the field editable", async () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  const input = field();
  await userEvent.type(input, "custom/model-42");
  expect(input.value).toBe("custom/model-42");
  expect(input.readOnly).toBe(false);
  expect(onChange).toHaveBeenLastCalledWith("custom/model-42");
});

it("shows the full catalog when opened with a complete selected model", async () => {
  render(<Harness initial="qwen2.5" />);
  await userEvent.click(field());
  expect(screen.getAllByRole("option")).toHaveLength(3);
  expect(screen.getByRole("option", { name: /deepseek-v3/ })).toBeTruthy();
  expect(screen.getByRole("option", { name: /llama-3.1/ })).toBeTruthy();
});

it("filters only from typed text and stays freeform when nothing matches", async () => {
  render(<Harness />);
  const input = field();
  await userEvent.type(input, "deep");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await userEvent.clear(input);
  await userEvent.type(input, "zzz-not-a-model");
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  expect(screen.getByRole("status").textContent).toContain("可直接输入");
  expect(input.value).toBe("zzz-not-a-model");
  expect(input.readOnly).toBe(false);
});

it("calls onValueChange once per choice from the keyboard and from the pointer", async () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  const input = field();

  await userEvent.click(input);
  await waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBeTruthy());
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onChange.mock.calls).toEqual([["deepseek-v3"]]);
  expect(input.value).toBe("deepseek-v3");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(document.activeElement).toBe(input);

  await userEvent.click(input);
  await userEvent.click(screen.getByRole("option", { name: /qwen2.5/ }));
  expect(onChange.mock.calls).toEqual([["deepseek-v3"], ["qwen2.5"]]);
  expect(input.value).toBe("qwen2.5");
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("closes on Escape without losing the typed text or focus", async () => {
  render(<Harness />);
  const input = field();
  await userEvent.type(input, "custom-id");
  expect(screen.getByRole("listbox")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(input.value).toBe("custom-id");
  expect(document.activeElement).toBe(input);
});

it("never opens while disabled and closes when it becomes disabled", async () => {
  const { rerender } = render(<Harness />);
  const input = field();
  await userEvent.click(input);
  expect(screen.getByRole("listbox")).toBeTruthy();

  rerender(<Harness disabled />);
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(field().disabled).toBe(true);

  cleanup();
  render(<Harness disabled />);
  const disabledInput = field();
  fireEvent.focus(disabledInput);
  fireEvent.click(disabledInput);
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("exposes combobox, listbox and options with the caller label", async () => {
  render(<Harness />);
  const input = field();
  expect(input.id).toBe("model-id");
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect(input.getAttribute("aria-autocomplete")).toBe("list");

  await userEvent.click(input);
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("listbox", { name: "Model id" })).toBeTruthy();
  const options = screen.getAllByRole("option");
  expect(options).toHaveLength(3);
  await waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id));
});

it("does not choose an option on Enter during IME composition", async () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  const input = field();
  await userEvent.click(input);

  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "qwen" } });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });

  expect(onChange.mock.calls).toEqual([["qwen"]]);
  expect(input.value).toBe("qwen");
  expect(screen.getByRole("listbox")).toBeTruthy();
  fireEvent.compositionEnd(input);
  expect(input.value).toBe("qwen");
});

it("closes on an ancestor scroll without closing when the suggestion list scrolls", async () => {
  const view = render(
    <div data-testid="scroll-host">
      <Harness />
    </div>,
  );
  await userEvent.click(field());
  const list = screen.getByRole("listbox");
  fireEvent.scroll(list);
  expect(screen.getByRole("listbox")).toBeTruthy();
  const host = view.getByTestId("scroll-host");
  fireEvent.scroll(host);
  expect(screen.getByRole("listbox")).toBeTruthy();
  host.scrollTop = 140;
  fireEvent.scroll(host);
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(field().value).toBe("");
});

it("keeps suggestions open when focus returns to the editable anchor", async () => {
  render(<Harness />);
  const input = field();
  await userEvent.click(input);
  await userEvent.click(screen.getByRole("option", { name: /qwen2.5/ }));
  await userEvent.click(input);
  const list = screen.getByRole("listbox");
  list.focus();
  fireEvent.focusIn(input);
  await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("true"));
  expect(screen.getByRole("listbox")).toBeTruthy();
});

it("never keeps an active descendant pointing at a filtered-out option", async () => {
  render(<Harness />);
  const input = field();
  await userEvent.click(input);
  await waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBeTruthy());
  await userEvent.type(input, "llama");
  const remaining = screen.getByRole("option", { name: /llama-3.1/ });
  await waitFor(() => {
    const active = input.getAttribute("aria-activedescendant");
    expect(active === null || active === remaining.id).toBe(true);
  });
  await userEvent.type(input, "-unknown");
  await waitFor(() => expect(input.hasAttribute("aria-activedescendant")).toBe(false));
});
