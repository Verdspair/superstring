import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeAppearanceMessage,
  FONT_IDS,
  FONT_STORAGE_KEY,
  isFontId,
  MODE_STORAGE_KEY,
  parseAppearanceMessage,
  resolveFont,
  THEME_STORAGE_KEY,
} from "../../src/shared/appearance";
import { applyFont, applyMode, applyTheme, readFont, selectFont } from "../../src/web/appearance";
import { selectLocale } from "../../src/web/i18n";
import enMessages from "../../src/web/i18n/locales/en/translation.json";
import zhMessages from "../../src/web/i18n/locales/zh-CN/translation.json";
import { Preferences } from "../../src/web/screens/environment/Preferences";
import { render } from "./helpers/render-with-providers";

// Fonts ride the existing appearance layer: the id set, the stored key and the
// html[data-font] attribute are the contract, and CSS owns the family stacks.
// Real glyph loading and layout are checked in a browser, so this file never
// asserts on stylesheet text and never fakes document.fonts.

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

/** Labels come from the locale resources, so the panel stays bilingual without hard-coded copy. */
function fontLabels(locale: "zh-CN" | "en", id: string): string[] {
  const table = locale === "en" ? en : zh;
  const keys = Object.keys(table).filter(
    (key) =>
      !key.startsWith("hints.") &&
      key.toLowerCase().includes("font") &&
      key.split(".").pop() === id,
  );
  if (keys.length === 0) throw new Error(`MISSING_FONT_LABEL_KEY:${id}`);
  return keys.map((key) => table[key]).filter((value) => value.length > 0);
}

function showsPreview(section: HTMLElement, locale: "zh-CN" | "en"): boolean {
  const label = locale === "en" ? "Font preview" : "字体预览";
  const preview = section.querySelector(`[aria-label="${label}"]`);
  return (
    !!preview?.textContent?.includes("The quick brown fox 0123456789") &&
    preview.textContent.includes("山海之间，灵感自来")
  );
}

function clearAppearanceFrame() {
  const root = document.documentElement;
  for (const name of ["font", "fontUnsaved", "theme", "themeUnsaved", "mode", "modeUnsaved"])
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

describe("shared font contract", () => {
  it("offers exactly three font ids on a key separate from theme and mode", () => {
    expect(FONT_IDS).toEqual(["default", "elegant", "cute"]);
    expect(new Set(FONT_IDS).size).toBe(FONT_IDS.length);
    expect(FONT_STORAGE_KEY).toBe("superstring-appearance-font");
    expect(FONT_STORAGE_KEY).not.toBe(THEME_STORAGE_KEY);
    expect(FONT_STORAGE_KEY).not.toBe(MODE_STORAGE_KEY);
    for (const id of FONT_IDS) expect(isFontId(id)).toBe(true);
    expect(isFontId("system")).toBe(false);
    expect(isFontId(undefined)).toBe(false);
  });

  it("resolves a missing or corrupt id back to the untouched system default", () => {
    for (const value of [undefined, null, "", "   ", "DEFAULT", 42, {}, [], "elegant-serif"]) {
      expect(resolveFont(value).id).toBe("default");
    }
    for (const id of FONT_IDS) expect(resolveFont(id).id).toBe(id);
  });

  it("keeps the strict desktop appearance frame at three keys", () => {
    const frame = encodeAppearanceMessage({ theme: "fjord", mode: "dark" });
    expect(Object.keys(JSON.parse(frame)).sort()).toEqual(["mode", "theme", "type"]);
    expect(parseAppearanceMessage(frame)).toEqual({ theme: "fjord", mode: "dark" });
    // The font never joins the WebSocket contract, so an older server stays valid.
    const withFont = JSON.stringify({
      type: "appearance",
      theme: "fjord",
      mode: "dark",
      font: "cute",
    });
    expect(parseAppearanceMessage(withFont)).toBeNull();
  });
});

describe("browser font layer", () => {
  it("reads the stored id, defaults when nothing was saved and ignores corrupt values", () => {
    expect(readFont()).toBe("default");
    localStorage.setItem(FONT_STORAGE_KEY, "cute");
    expect(readFont()).toBe("cute");
    localStorage.setItem(FONT_STORAGE_KEY, "removed-font-id");
    expect(readFont()).toBe("default");
  });

  it("applyFont only moves html data-font, leaving colours and classes alone", () => {
    applyTheme("fjord");
    applyMode("dark");
    const style = document.documentElement.getAttribute("style");
    const classes = document.documentElement.className;
    applyFont("elegant");
    expect(document.documentElement.dataset.font).toBe("elegant");
    expect(document.documentElement.getAttribute("style")).toBe(style);
    expect(document.documentElement.className).toBe(classes);
    expect(document.documentElement.style.fontFamily).toBe("");
    applyFont("not-a-font" as never);
    expect(document.documentElement.dataset.font).toBe("default");
  });

  it("selectFont persists locally and forwards through the existing desktop bridge", () => {
    applyTheme("fjord");
    applyMode("dark");
    const save = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({}),
      save,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    expect(selectFont("cute")).toBe(true);
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBe("cute");
    expect(document.documentElement.dataset.font).toBe("cute");
    expect("fontUnsaved" in document.documentElement.dataset).toBe(false);
    expect(save.mock.calls).toEqual([[{ [FONT_STORAGE_KEY]: "cute" }]]);
    // Choosing a font is not a theme or mode write.
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBe("fjord");
    expect(document.documentElement.dataset.mode).toBe("dark");
  });

  it("keeps a failed save applied but unsaved, and keeps reading the applied font", () => {
    localStorage.setItem(FONT_STORAGE_KEY, "default");
    localStorage.setItem(THEME_STORAGE_KEY, "fjord");
    localStorage.setItem(MODE_STORAGE_KEY, "dark");
    applyTheme("fjord");
    applyMode("dark");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setItem.mockImplementation(() => {
      throw new Error("quota");
    });
    expect(selectFont("elegant")).toBe(false);
    setItem.mockRestore();
    expect(document.documentElement.dataset.font).toBe("elegant");
    expect(document.documentElement.dataset.fontUnsaved).toBe("1");
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBe("default");
    expect(readFont()).toBe("elegant");
    // The failure is contained to the font: theme and mode stay saved and unsaved-free.
    expect(document.documentElement.dataset.theme).toBe("fjord");
    expect(document.documentElement.dataset.mode).toBe("dark");
    expect("themeUnsaved" in document.documentElement.dataset).toBe(false);
    expect("modeUnsaved" in document.documentElement.dataset).toBe(false);
    delete document.documentElement.dataset.fontUnsaved;
    expect(readFont()).toBe("default");
  });
});

function appearanceSection(): HTMLElement {
  const heading = screen.getByRole("heading", { level: 2, name: zh["library.appearance"] });
  const section = heading.closest("section");
  if (!section) throw new Error("FONT_CONTROL_OUTSIDE_SETTINGS_GROUP");
  return section as HTMLElement;
}

function fontSelect(section: HTMLElement): HTMLSelectElement {
  const selects = Array.from(
    section.querySelectorAll<HTMLSelectElement>('select[data-slot="native-select"]'),
  );
  const select = selects.find(
    (item) =>
      Array.from(item.options)
        .map((option) => option.value)
        .join(",") === FONT_IDS.join(","),
  );
  if (!select) throw new Error("FONT_CONTROL_MISSING");
  expect(Array.from(select.options).map((option) => option.value)).toEqual([...FONT_IDS]);
  return select;
}

describe("Preferences font control", () => {
  it("presents three fonts as one labelled native select inside the appearance group", () => {
    render(<Preferences />);
    const section = appearanceSection();
    const select = fontSelect(section);
    // Reuse, not a second visual system: no per-font card and no extra pressed
    // button competing with the theme and mode rows.
    expect(section.querySelectorAll('[data-slot="card"]')).toHaveLength(0);
    for (const id of FONT_IDS) {
      const option = Array.from(select.options).find((item) => item.value === id);
      if (!option) throw new Error(`MISSING_FONT_OPTION:${id}`);
      expect(fontLabels("zh-CN", id)).toContain(option.textContent ?? "");
      expect(option.textContent).not.toBe(id);
    }
    const labelledBy = select.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)?.textContent).not.toBe("");
    expect(select.value).toBe(readFont());
  });

  it("applies the chosen font live without touching theme or mode", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "fjord");
    localStorage.setItem(MODE_STORAGE_KEY, "dark");
    applyTheme("fjord");
    applyMode("dark");
    render(<Preferences />);
    const section = appearanceSection();
    expect(showsPreview(section, "zh-CN")).toBe(true);
    await userEvent.selectOptions(fontSelect(section), "cute");
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBe("cute");
    expect(document.documentElement.dataset.font).toBe("cute");
    expect(fontSelect(section).value).toBe("cute");
    expect(document.documentElement.dataset.theme).toBe("fjord");
    expect(document.documentElement.dataset.mode).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("fjord");
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe("dark");
    const themeButton = screen.getByRole("button", { name: zh["preferences.theme.fjord"] });
    const modeButton = screen.getByRole("button", { name: zh["preferences.mode.dark"] });
    expect(themeButton.getAttribute("aria-pressed")).toBe("true");
    expect(modeButton.getAttribute("aria-pressed")).toBe("true");
    expect(showsPreview(section, "zh-CN")).toBe(true);
  });

  it("reports an applied-but-unsaved font choice and keeps the selection live", async () => {
    render(<Preferences />);
    const section = appearanceSection();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setItem.mockImplementation(() => {
      throw new Error("quota");
    });
    await userEvent.selectOptions(fontSelect(section), "elegant");
    setItem.mockRestore();
    expect(document.documentElement.dataset.font).toBe("elegant");
    expect(document.documentElement.dataset.fontUnsaved).toBe("1");
    expect(fontSelect(section).value).toBe("elegant");
    expect(readFont()).toBe("elegant");
    expect(screen.getByRole("status").textContent).toBe(
      zh["library.appearance.applied.but.could.not.be.saved.in.this"],
    );
  });

  it("follows a cross-tab font change and re-labels the panel in the active language", async () => {
    render(<Preferences />);
    const section = appearanceSection();
    localStorage.setItem(FONT_STORAGE_KEY, "cute");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: FONT_STORAGE_KEY, newValue: "cute" }),
      );
    });
    expect(fontSelect(section).value).toBe("cute");
    expect(readFont()).toBe("cute");
    await act(async () => {
      selectLocale("en");
    });
    const heading = screen.getByRole("heading", { level: 2, name: en["library.appearance"] });
    const englishSection = heading.closest("section") as HTMLElement;
    const select = fontSelect(englishSection);
    for (const id of FONT_IDS) {
      const option = Array.from(select.options).find((item) => item.value === id);
      if (!option) throw new Error(`MISSING_FONT_OPTION:${id}`);
      expect(fontLabels("en", id)).toContain(option.textContent ?? "");
    }
    expect(showsPreview(englishSection, "en")).toBe(true);
  });
});
