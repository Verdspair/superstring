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
  isAppearanceMode,
  isThemeId,
  MODE_IDS,
  MODE_STORAGE_KEY,
  MODES,
  parseAppearanceMessage,
  resolveMode,
  resolveTheme,
  THEME_IDS,
  THEME_STORAGE_KEY,
  THEMES,
  type ThemeId,
} from "../shared/appearance";

import type { AppearanceMode, ThemeId } from "../shared/appearance";
import {
  MODE_STORAGE_KEY,
  resolveMode,
  resolveTheme,
  THEME_STORAGE_KEY,
} from "../shared/appearance";

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
  for (const property of ["--primary-foreground", "--sidebar-primary-foreground"])
    root.style.setProperty(property, "light-dark(#ffffff, #171717)");
}

export function selectTheme(id: ThemeId): boolean {
  applyTheme(id);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
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
    delete document.documentElement.dataset.modeUnsaved;
    return true;
  } catch {
    document.documentElement.dataset.modeUnsaved = "1";
    return false;
  }
}
