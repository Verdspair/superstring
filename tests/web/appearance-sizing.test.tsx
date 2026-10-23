import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeAppearanceMessage,
  FONT_STORAGE_KEY,
  INTERFACE_SIZE_IDS,
  INTERFACE_SIZE_STORAGE_KEY,
  INTERFACE_SIZES,
  isInterfaceSizeId,
  isTextSizeId,
  MODE_STORAGE_KEY,
  parseAppearanceMessage,
  resolveInterfaceSize,
  resolveTextSize,
  TEXT_SIZE_IDS,
  TEXT_SIZE_STORAGE_KEY,
  TEXT_SIZES,
  THEME_STORAGE_KEY,
} from "../../src/shared/appearance";
import {
  applyInterfaceSize,
  applyMode,
  applyTextSize,
  applyTheme,
  readInterfaceSize,
  readTextSize,
  selectInterfaceSize,
  selectTextSize,
} from "../../src/web/appearance";
import { selectLocale } from "../../src/web/i18n";
import enMessages from "../../src/web/i18n/locales/en/translation.json";
import zhMessages from "../../src/web/i18n/locales/zh-CN/translation.json";
import { Preferences } from "../../src/web/screens/environment/Preferences";
import { render } from "./helpers/render-with-providers";

// Text size and interface size are two independent preference axes. The JS
// layer only names ids and moves html[data-text-size] / html[data-interface-size];
// every scale number is owned by CSS and checked by Root's browser matrix, so
// this file never asserts on stylesheet text, zoom level or pixel geometry.

function flatten(messages: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(messages)) {
    if (value && typeof value === "object") Object.assign(out, flatten(value as never, `${key}.`));
    else if (typeof value === "string") out[`${prefix}${key}`] = value;
  }
  return out;
}

const zh = flatten(zhMessages as Record<string, unknown>);
const en = flatten(enMessages as Record<string, unknown>);

function clearAppearanceFrame() {
  const root = document.documentElement;
  for (const name of [
    "font",
    "fontUnsaved",
    "theme",
    "themeUnsaved",
    "mode",
    "modeUnsaved",
    "textSize",
    "textSizeUnsaved",
    "interfaceSize",
    "interfaceSizeUnsaved",
  ])
    delete root.dataset[name];
}

beforeEach(() => {
  localStorage.clear();
  clearAppearanceFrame();
  delete window.superstringPreferences;
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  clearAppearanceFrame();
  localStorage.clear();
  delete window.superstringPreferences;
  vi.restoreAllMocks();
});

describe("shared size contract", () => {
  it("offers exactly three approved ids per axis on their own storage keys", () => {
    expect(TEXT_SIZE_IDS).toEqual(["small", "medium", "large"]);
    expect(INTERFACE_SIZE_IDS).toEqual(["compact", "standard", "comfortable"]);
    expect(TEXT_SIZES.map((size) => size.name)).toEqual(["小", "标准", "大"]);
    expect(INTERFACE_SIZES.map((size) => size.name)).toEqual(["紧凑", "标准", "宽松"]);
    expect(TEXT_SIZE_STORAGE_KEY).toBe("superstring-appearance-text-size");
    expect(INTERFACE_SIZE_STORAGE_KEY).toBe("superstring-appearance-interface-size");
    const keys = [
      THEME_STORAGE_KEY,
      MODE_STORAGE_KEY,
      FONT_STORAGE_KEY,
      TEXT_SIZE_STORAGE_KEY,
      INTERFACE_SIZE_STORAGE_KEY,
    ];
    expect(new Set(keys).size).toBe(keys.length);
    for (const id of TEXT_SIZE_IDS) expect(isTextSizeId(id)).toBe(true);
    for (const id of INTERFACE_SIZE_IDS) expect(isInterfaceSizeId(id)).toBe(true);
    expect(isTextSizeId("standard")).toBe(false);
    expect(isInterfaceSizeId("medium")).toBe(false);
    expect(isTextSizeId(undefined)).toBe(false);
    expect(isInterfaceSizeId(null)).toBe(false);
    // Root ruling: the CSS pipeline owns every multiplier; JS keeps names only.
    for (const size of TEXT_SIZES) expect(Object.keys(size)).toEqual(["id", "name"]);
    for (const size of INTERFACE_SIZES) expect(Object.keys(size)).toEqual(["id", "name"]);
  });

  it("resolves a missing or corrupt id back to the unchanged default", () => {
    for (const value of [undefined, null, "", "   ", "MEDIUM", "normal", 42, {}, [], "huge"])
      expect(resolveTextSize(value).id).toBe("medium");
    for (const value of [undefined, null, "", "   ", "STANDARD", "spacious", 42, {}, [], "wide"])
      expect(resolveInterfaceSize(value).id).toBe("standard");
    for (const id of TEXT_SIZE_IDS) expect(resolveTextSize(id).id).toBe(id);
    for (const id of INTERFACE_SIZE_IDS) expect(resolveInterfaceSize(id).id).toBe(id);
  });

  it("keeps the strict desktop appearance frame at exactly three keys", () => {
    const frame = encodeAppearanceMessage({ theme: "fjord", mode: "dark" });
    expect(Object.keys(JSON.parse(frame)).sort()).toEqual(["mode", "theme", "type"]);
    expect(parseAppearanceMessage(frame)).toEqual({ theme: "fjord", mode: "dark" });
    // Sizes stay local preferences and never join the WebSocket contract.
    for (const extra of [{ textSize: "large" }, { interfaceSize: "compact" }]) {
      const widened = JSON.stringify({
        type: "appearance",
        theme: "fjord",
        mode: "dark",
        ...extra,
      });
      expect(parseAppearanceMessage(widened)).toBeNull();
    }
  });
});

describe("browser size layer", () => {
  it("reads the stored id, defaults when nothing was saved and ignores corrupt values", () => {
    expect(readTextSize()).toBe("medium");
    expect(readInterfaceSize()).toBe("standard");
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "large");
    localStorage.setItem(INTERFACE_SIZE_STORAGE_KEY, "compact");
    expect(readTextSize()).toBe("large");
    expect(readInterfaceSize()).toBe("compact");
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "removed-size-id");
    localStorage.setItem(INTERFACE_SIZE_STORAGE_KEY, "removed-size-id");
    expect(readTextSize()).toBe("medium");
    expect(readInterfaceSize()).toBe("standard");
  });

  it("apply writes only its own html data attribute and leaves colours and classes alone", () => {
    applyTheme("fjord");
    applyMode("dark");
    const style = document.documentElement.getAttribute("style");
    const classes = document.documentElement.className;
    applyTextSize("large");
    expect(document.documentElement.dataset.textSize).toBe("large");
    expect(document.documentElement.getAttribute("style")).toBe(style);
    expect(document.documentElement.className).toBe(classes);
    expect(document.documentElement.style.fontSize).toBe("");
    applyTextSize("not-a-size" as never);
    expect(document.documentElement.dataset.textSize).toBe("medium");
    applyInterfaceSize("comfortable");
    expect(document.documentElement.dataset.interfaceSize).toBe("comfortable");
    expect(document.documentElement.getAttribute("style")).toBe(style);
    expect(document.documentElement.className).toBe(classes);
    applyInterfaceSize("not-a-size" as never);
    expect(document.documentElement.dataset.interfaceSize).toBe("standard");
  });

  it("select persists each axis and forwards one exact desktop-bridge key", () => {
    applyTheme("fjord");
    applyMode("dark");
    const save = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({}),
      save,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    expect(selectTextSize("large")).toBe(true);
    expect(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe("large");
    expect(document.documentElement.dataset.textSize).toBe("large");
    expect("textSizeUnsaved" in document.documentElement.dataset).toBe(false);
    expect(selectInterfaceSize("compact")).toBe(true);
    expect(localStorage.getItem(INTERFACE_SIZE_STORAGE_KEY)).toBe("compact");
    expect(document.documentElement.dataset.interfaceSize).toBe("compact");
    expect("interfaceSizeUnsaved" in document.documentElement.dataset).toBe(false);
    expect(save.mock.calls).toEqual([
      [{ [TEXT_SIZE_STORAGE_KEY]: "large" }],
      [{ [INTERFACE_SIZE_STORAGE_KEY]: "compact" }],
    ]);
    // A size choice is not a theme, mode or font write.
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBe("fjord");
    expect(document.documentElement.dataset.mode).toBe("dark");
  });

  it("keeps a failed text-size save applied but unsaved and isolated", () => {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "medium");
    applyTheme("fjord");
    applyMode("dark");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setItem.mockImplementation(() => {
      throw new Error("quota");
    });
    expect(selectTextSize("small")).toBe(false);
    setItem.mockRestore();
    expect(document.documentElement.dataset.textSize).toBe("small");
    expect(document.documentElement.dataset.textSizeUnsaved).toBe("1");
    expect(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe("medium");
    expect(readTextSize()).toBe("small");
    expect("interfaceSizeUnsaved" in document.documentElement.dataset).toBe(false);
    expect(document.documentElement.dataset.theme).toBe("fjord");
    expect("themeUnsaved" in document.documentElement.dataset).toBe(false);
    delete document.documentElement.dataset.textSizeUnsaved;
    expect(readTextSize()).toBe("medium");
  });

  it("keeps a failed interface-size save applied but unsaved and isolated", () => {
    localStorage.setItem(INTERFACE_SIZE_STORAGE_KEY, "standard");
    applyTextSize("large");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setItem.mockImplementation(() => {
      throw new Error("quota");
    });
    expect(selectInterfaceSize("comfortable")).toBe(false);
    setItem.mockRestore();
    expect(document.documentElement.dataset.interfaceSize).toBe("comfortable");
    expect(document.documentElement.dataset.interfaceSizeUnsaved).toBe("1");
    expect(localStorage.getItem(INTERFACE_SIZE_STORAGE_KEY)).toBe("standard");
    expect(readInterfaceSize()).toBe("comfortable");
    expect(document.documentElement.dataset.textSize).toBe("large");
    expect("textSizeUnsaved" in document.documentElement.dataset).toBe(false);
    delete document.documentElement.dataset.interfaceSizeUnsaved;
    expect(readInterfaceSize()).toBe("standard");
  });
});

function appearanceSection(): HTMLElement {
  const heading = screen.getByRole("heading", { level: 2, name: zh["library.appearance"] });
  const section = heading.closest("section");
  if (!section) throw new Error("SIZE_CONTROL_OUTSIDE_SETTINGS_GROUP");
  return section as HTMLElement;
}

function sizeSelect(section: HTMLElement, ids: readonly string[]): HTMLSelectElement {
  const selects = Array.from(
    section.querySelectorAll<HTMLSelectElement>('select[data-slot="native-select"]'),
  );
  const match = selects.find(
    (select) =>
      Array.from(select.options)
        .map((option) => option.value)
        .join(",") === ids.join(","),
  );
  if (!match) throw new Error(`MISSING_SIZE_SELECT:${ids.join("/")}`);
  return match;
}

function accessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy)
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  return element.getAttribute("aria-label") ?? "";
}

function sizeLabel(table: Record<string, string>, prefix: string, id: string): string {
  const key = `${prefix}.${id}`;
  if (!(key in table)) throw new Error(`MISSING_SIZE_LABEL_KEY:${key}`);
  return table[key];
}

/** Option copy comes from the locale resources, so the panel stays bilingual. */
function expectReadableOptions(
  select: HTMLSelectElement,
  ids: readonly string[],
  prefix: string,
  table: Record<string, string>,
) {
  expect(Array.from(select.options).map((option) => option.value)).toEqual([...ids]);
  for (const option of Array.from(select.options)) {
    expect(option.textContent, `${prefix}:${option.value}`).toBe(
      sizeLabel(table, prefix, option.value),
    );
    expect(option.textContent).not.toBe(option.value);
  }
}

describe("Preferences size controls", () => {
  it("presents both axes as labelled native selects with the exact readable names", () => {
    render(<Preferences />);
    const section = appearanceSection();
    // Font plus one select per size axis; no extra card or duplicate preview.
    expect(section.querySelectorAll('select[data-slot="native-select"]')).toHaveLength(3);
    const text = sizeSelect(section, TEXT_SIZE_IDS);
    const ui = sizeSelect(section, INTERFACE_SIZE_IDS);
    expect(zh["preferences.textSize.label"]).toBe("字号");
    expect(zh["preferences.interfaceSize.label"]).toBe("界面大小");
    expectReadableOptions(text, TEXT_SIZE_IDS, "preferences.textSize", zh);
    expectReadableOptions(ui, INTERFACE_SIZE_IDS, "preferences.interfaceSize", zh);
    expect(accessibleName(text)).toBe(zh["preferences.textSize.label"]);
    expect(accessibleName(ui)).toBe(zh["preferences.interfaceSize.label"]);
    expect(text.value).toBe(readTextSize());
    expect(ui.value).toBe(readInterfaceSize());
    // The existing font sample is extended with real controls, not a second preview.
    const previews = section.querySelectorAll("figure");
    expect(previews).toHaveLength(1);
    expect(previews[0].querySelector("button[disabled]")).not.toBeNull();
    expect(previews[0].querySelector("input[readonly]")).not.toBeNull();
  });

  it("applies each axis live without touching the other preferences", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "fjord");
    localStorage.setItem(MODE_STORAGE_KEY, "dark");
    applyTheme("fjord");
    applyMode("dark");
    render(<Preferences />);
    const section = appearanceSection();
    await userEvent.selectOptions(sizeSelect(section, TEXT_SIZE_IDS), "large");
    expect(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe("large");
    expect(document.documentElement.dataset.textSize).toBe("large");
    expect(sizeSelect(section, TEXT_SIZE_IDS).value).toBe("large");
    expect(sizeSelect(section, INTERFACE_SIZE_IDS).value).toBe("standard");
    await userEvent.selectOptions(sizeSelect(section, INTERFACE_SIZE_IDS), "comfortable");
    expect(localStorage.getItem(INTERFACE_SIZE_STORAGE_KEY)).toBe("comfortable");
    expect(document.documentElement.dataset.interfaceSize).toBe("comfortable");
    expect(sizeSelect(section, INTERFACE_SIZE_IDS).value).toBe("comfortable");
    expect(sizeSelect(section, TEXT_SIZE_IDS).value).toBe("large");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("fjord");
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("fjord");
    expect(document.documentElement.dataset.mode).toBe("dark");
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
  });

  it("reports an applied-but-unsaved size choice and keeps the selection live", async () => {
    render(<Preferences />);
    const section = appearanceSection();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setItem.mockImplementation(() => {
      throw new Error("quota");
    });
    await userEvent.selectOptions(sizeSelect(section, TEXT_SIZE_IDS), "small");
    setItem.mockRestore();
    expect(document.documentElement.dataset.textSize).toBe("small");
    expect(document.documentElement.dataset.textSizeUnsaved).toBe("1");
    expect(sizeSelect(section, TEXT_SIZE_IDS).value).toBe("small");
    expect(readTextSize()).toBe("small");
    expect(screen.getByRole("status").textContent).toBe(
      zh["library.appearance.applied.but.could.not.be.saved.in.this"],
    );
    expect("interfaceSizeUnsaved" in document.documentElement.dataset).toBe(false);
  });

  it("follows a cross-tab size change and keeps the axes independent", async () => {
    render(<Preferences />);
    const section = appearanceSection();
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "large");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: TEXT_SIZE_STORAGE_KEY, newValue: "large" }),
      );
    });
    expect(sizeSelect(section, TEXT_SIZE_IDS).value).toBe("large");
    expect(readTextSize()).toBe("large");
    expect(sizeSelect(section, INTERFACE_SIZE_IDS).value).toBe("standard");
    localStorage.setItem(INTERFACE_SIZE_STORAGE_KEY, "compact");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: INTERFACE_SIZE_STORAGE_KEY, newValue: "compact" }),
      );
    });
    expect(sizeSelect(section, INTERFACE_SIZE_IDS).value).toBe("compact");
    expect(readInterfaceSize()).toBe("compact");
    expect(sizeSelect(section, TEXT_SIZE_IDS).value).toBe("large");
  });

  it("keeps both selects readable after switching to English", async () => {
    render(<Preferences />);
    await act(async () => {
      selectLocale("en");
    });
    const heading = screen.getByRole("heading", { level: 2, name: en["library.appearance"] });
    const englishSection = heading.closest("section") as HTMLElement;
    expect(englishSection.querySelectorAll('select[data-slot="native-select"]')).toHaveLength(3);
    const text = sizeSelect(englishSection, TEXT_SIZE_IDS);
    const ui = sizeSelect(englishSection, INTERFACE_SIZE_IDS);
    expectReadableOptions(text, TEXT_SIZE_IDS, "preferences.textSize", en);
    expectReadableOptions(ui, INTERFACE_SIZE_IDS, "preferences.interfaceSize", en);
    expect(accessibleName(text)).toBe(en["preferences.textSize.label"]);
    expect(accessibleName(ui)).toBe(en["preferences.interfaceSize.label"]);
  });
});
