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
  if (theme.id === "slate") return;
  // A theme changes accent roles only. Neutral surfaces and borders belong to the
  // design system, so every color remains readable in both appearance modes.
  root.style.setProperty("--ac-accent", `light-dark(${theme.color}, ${theme.dark})`);
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

// 固定明暗只切 html 上的 .light / .dark：基础令牌、主题色的 light-dark() 与
// 表单控件的 color-scheme 都随之解析，不需要复制一套颜色。
export function applyMode(mode: AppearanceMode) {
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  root.classList.toggle("light", mode === "light");
  root.dataset.mode = mode;
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
