// Browser appearance layer. Re-exports the DOM-free contract from
// ../shared/appearance so existing importers (App, main, tests) keep the same
// surface, and adds the localStorage-backed read / apply / select functions.
// The shared module stays DOM-free so the server can import it without pulling
// browser side effects into the process.

export {
  APPEARANCE_MESSAGE_MAX_BYTES,
  type AppearanceMode,
  type AppearanceSnapshot,
  encodeAppearanceMessage,
  FONT_IDS,
  FONT_STORAGE_KEY,
  FONTS,
  type FontId,
  INTERFACE_SIZE_IDS,
  INTERFACE_SIZE_STORAGE_KEY,
  INTERFACE_SIZES,
  type InterfaceSizeId,
  isAppearanceMode,
  isThemeId,
  MODE_IDS,
  MODE_STORAGE_KEY,
  MODES,
  parseAppearanceMessage,
  resolveMode,
  resolveTheme,
  SELECTABLE_THEMES,
  TEXT_SIZE_IDS,
  TEXT_SIZE_STORAGE_KEY,
  TEXT_SIZES,
  type TextSizeId,
  THEME_IDS,
  THEME_STORAGE_KEY,
  THEMES,
  type ThemeId,
} from "../shared/appearance";

import type {
  AppearanceMode,
  FontId,
  InterfaceSizeId,
  TextSizeId,
  ThemeId,
} from "../shared/appearance";
import {
  FONT_STORAGE_KEY,
  INTERFACE_SIZE_STORAGE_KEY,
  MODE_STORAGE_KEY,
  resolveFont,
  resolveInterfaceSize,
  resolveMode,
  resolveTextSize,
  resolveTheme,
  TEXT_SIZE_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "../shared/appearance";
import { persistDesktopPreference } from "./desktop-preferences";

const properties = [
  "--superstring-tone-deep",
  "--superstring-tone-light",
  "--superstring-tone-line",
  "--superstring-tone-soft",
  "--ac-accent",
  "--ac-accent-soft",
];

export function readTheme(): ThemeId {
  if (document.documentElement.dataset.themeUnsaved === "1")
    return resolveTheme(document.documentElement.dataset.theme).id;
  try {
    return resolveTheme(localStorage.getItem(THEME_STORAGE_KEY)).id;
  } catch {
    return resolveTheme(document.documentElement.dataset.theme).id;
  }
}

export function applyTheme(id: ThemeId) {
  const theme = resolveTheme(id);
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  for (const property of properties) root.style.removeProperty(property);
  // Brand colors occupy shadcn's primary roles. Its accent token remains a
  // neutral hover surface, so all sixteen palettes share the same readability.
  const primary = `light-dark(${theme.color}, ${theme.dark})`;
  for (const property of ["--primary", "--ring", "--sidebar-primary", "--sidebar-ring"])
    root.style.setProperty(property, primary);
  // Tonal palettes use their matching dark canvas as the action foreground.
  const darkFg =
    theme.id === "lavender"
      ? "#110e18"
      : theme.id === "fjord"
        ? "#0c1017"
        : theme.id === "birch"
          ? "#14100c"
          : theme.id === "sage"
            ? "#0e1511"
            : theme.id === "hearth"
              ? "#181012"
              : theme.id === "blossom"
                ? "#1e141d"
                : "#171717";
  for (const property of ["--primary-foreground", "--sidebar-primary-foreground"])
    root.style.setProperty(property, `light-dark(#ffffff, ${darkFg})`);
}

export function selectTheme(id: ThemeId): boolean {
  applyTheme(id);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
    void persistDesktopPreference(THEME_STORAGE_KEY, id);
    delete document.documentElement.dataset.themeUnsaved;
    return true;
  } catch {
    document.documentElement.dataset.themeUnsaved = "1";
    return false;
  }
}

export function readMode(): AppearanceMode {
  if (document.documentElement.dataset.modeUnsaved === "1")
    return resolveMode(document.documentElement.dataset.mode);
  try {
    return resolveMode(localStorage.getItem(MODE_STORAGE_KEY));
  } catch {
    return resolveMode(document.documentElement.dataset.mode);
  }
}

// Keep the stored preference separate from the resolved color scheme. Tailwind
// dark variants and native form controls must also follow OS changes in system mode.
export function applyMode(mode: AppearanceMode) {
  const root = document.documentElement;
  const dark =
    mode === "dark" ||
    (mode === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", mode === "light");
  root.style.colorScheme = dark ? "dark" : "light";
  root.dataset.mode = mode;
}

export function observeSystemAppearance(): () => void {
  const query = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!query) return () => {};
  const update = () => {
    if (document.documentElement.dataset.mode === "system") applyMode("system");
  };
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
}

export function selectMode(mode: AppearanceMode): boolean {
  applyMode(mode);
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
    void persistDesktopPreference(MODE_STORAGE_KEY, mode);
    delete document.documentElement.dataset.modeUnsaved;
    return true;
  } catch {
    document.documentElement.dataset.modeUnsaved = "1";
    return false;
  }
}

export function readFont(): FontId {
  if (document.documentElement.dataset.fontUnsaved === "1")
    return resolveFont(document.documentElement.dataset.font).id;
  try {
    return resolveFont(localStorage.getItem(FONT_STORAGE_KEY)).id;
  } catch {
    return resolveFont(document.documentElement.dataset.font).id;
  }
}

// CSS owns the family stacks: this only selects html[data-font=...]. A missing
// attribute and the "default" id both fall back to the original system stack.
export function applyFont(id: FontId) {
  document.documentElement.dataset.font = resolveFont(id).id;
}

export function selectFont(id: FontId): boolean {
  applyFont(id);
  try {
    localStorage.setItem(FONT_STORAGE_KEY, id);
    void persistDesktopPreference(FONT_STORAGE_KEY, id);
    delete document.documentElement.dataset.fontUnsaved;
    return true;
  } catch {
    document.documentElement.dataset.fontUnsaved = "1";
    return false;
  }
}

export function readTextSize(): TextSizeId {
  if (document.documentElement.dataset.textSizeUnsaved === "1")
    return resolveTextSize(document.documentElement.dataset.textSize).id;
  try {
    return resolveTextSize(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).id;
  } catch {
    return resolveTextSize(document.documentElement.dataset.textSize).id;
  }
}

// CSS owns every scale number: this only selects html[data-text-size=...]. A
// missing attribute and the "medium" id both render today's sizes unchanged.
export function applyTextSize(id: TextSizeId) {
  document.documentElement.dataset.textSize = resolveTextSize(id).id;
}

export function selectTextSize(id: TextSizeId): boolean {
  applyTextSize(id);
  try {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, id);
    void persistDesktopPreference(TEXT_SIZE_STORAGE_KEY, id);
    delete document.documentElement.dataset.textSizeUnsaved;
    return true;
  } catch {
    document.documentElement.dataset.textSizeUnsaved = "1";
    return false;
  }
}

export function readInterfaceSize(): InterfaceSizeId {
  if (document.documentElement.dataset.interfaceSizeUnsaved === "1")
    return resolveInterfaceSize(document.documentElement.dataset.interfaceSize).id;
  try {
    return resolveInterfaceSize(localStorage.getItem(INTERFACE_SIZE_STORAGE_KEY)).id;
  } catch {
    return resolveInterfaceSize(document.documentElement.dataset.interfaceSize).id;
  }
}

// Same rule as the text axis: html[data-interface-size=...] selects a CSS block,
// and "standard" plus a missing attribute both keep the current geometry.
export function applyInterfaceSize(id: InterfaceSizeId) {
  document.documentElement.dataset.interfaceSize = resolveInterfaceSize(id).id;
}

export function selectInterfaceSize(id: InterfaceSizeId): boolean {
  applyInterfaceSize(id);
  try {
    localStorage.setItem(INTERFACE_SIZE_STORAGE_KEY, id);
    void persistDesktopPreference(INTERFACE_SIZE_STORAGE_KEY, id);
    delete document.documentElement.dataset.interfaceSizeUnsaved;
    return true;
  } catch {
    document.documentElement.dataset.interfaceSizeUnsaved = "1";
    return false;
  }
}
