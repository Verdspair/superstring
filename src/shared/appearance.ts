// Shared, DOM-free appearance contract for both the browser (src/web) and the
// server (src/server). This module MUST NOT import anything browser-only
// (localStorage, document, window) — otherwise the server would pull DOM side
// effects into the process. The native desktop launcher reads the persisted
// JSON (see src/server/desktop-appearance.ts); the THEMES / MODES / FONTS /
// TEXT_SIZES / INTERFACE_SIZES data here is the single source of truth for
// saved theme ids, the three appearance modes and the three ids of each size
// dimension.

export const THEME_STORAGE_KEY = "superstring-appearance";
export const MODE_STORAGE_KEY = "superstring-appearance-mode";
export const FONT_STORAGE_KEY = "superstring-appearance-font";

export const THEMES = [
  { id: "slate", name: "深蓝灰", color: "#26364a", dark: "#d7e1f0" },
  { id: "blue", name: "海蓝", color: "#2458a6", dark: "#a6c8ff" },
  { id: "indigo", name: "靛蓝", color: "#454b9c", dark: "#bfc2ff" },
  { id: "violet", name: "紫罗兰", color: "#71509b", dark: "#d7bafa" },
  { id: "plum", name: "梅紫", color: "#87476d", dark: "#efb5d8" },
  { id: "rose", name: "玫瑰", color: "#a13e60", dark: "#ffb3cb" },
  { id: "red", name: "枣红", color: "#983b40", dark: "#ffb5b8" },
  { id: "terracotta", name: "陶土", color: "#a04a32", dark: "#ffbd9f" },
  { id: "amber", name: "琥珀", color: "#895b17", dark: "#f2cf8d" },
  { id: "olive", name: "橄榄", color: "#65652b", dark: "#d5d69b" },
  { id: "forest", name: "松绿", color: "#306b4c", dark: "#a2dcb7" },
  { id: "jade", name: "翡翠", color: "#267364", dark: "#9cdecf" },
  { id: "teal", name: "青碧", color: "#246b78", dark: "#a0dae6" },
  { id: "ocean", name: "湖蓝", color: "#306485", dark: "#aad3f1" },
  { id: "coffee", name: "咖啡", color: "#735744", dark: "#dec5af" },
  { id: "graphite", name: "石墨", color: "#4d535c", dark: "#cbd1db" },
  { id: "lavender", name: "淡紫", color: "#5e4e84", dark: "#9e8cc6" },
  { id: "fjord", name: "峡湾", color: "#34587c", dark: "#6b94be" },
  { id: "birch", name: "白桦", color: "#764f28", dark: "#b88b58" },
  { id: "sage", name: "鼠尾草", color: "#426451", dark: "#90b29b" },
  { id: "hearth", name: "暖玫", color: "#8e3a50", dark: "#d68b9c" },
  { id: "blossom", name: "樱粉", color: "#a34375", dark: "#e4a1c5" },
] as const;

// Retired palettes remain readable for saved preferences, but are not offered anew.
export const SELECTABLE_THEMES = THEMES.filter((theme) =>
  ["lavender", "fjord", "birch", "sage", "hearth", "blossom"].includes(theme.id),
);

export type ThemeId = (typeof THEMES)[number]["id"];
export const THEME_IDS: readonly ThemeId[] = THEMES.map((theme) => theme.id);

export const MODES = [
  { id: "system", name: "跟随系统" },
  { id: "light", name: "浅色" },
  { id: "dark", name: "深色" },
] as const;

export type AppearanceMode = (typeof MODES)[number]["id"];
export const MODE_IDS: readonly AppearanceMode[] = MODES.map((mode) => mode.id);

// Font choice is a separate preference dimension, not part of the theme/mode
// appearance frame. The actual family stacks live in src/web/styles.css.
export const FONTS = [
  { id: "default", name: "默认" },
  { id: "elegant", name: "典雅衬线" },
  { id: "cute", name: "可爱圆体" },
] as const;

export type FontId = (typeof FONTS)[number]["id"];
export const FONT_IDS: readonly FontId[] = FONTS.map((font) => font.id);

// Text size and interface size are two more preference dimensions on the same
// appearance frame, and are deliberately NOT part of the desktop WebSocket
// snapshot. Every scale number lives in src/web/styles.css under
// html[data-text-size=...] / html[data-interface-size=...]; this module only
// names the ids, so no saved value can ever select an unknown attribute and no
// number is duplicated on the JavaScript side.
export const TEXT_SIZE_STORAGE_KEY = "superstring-appearance-text-size";
export const INTERFACE_SIZE_STORAGE_KEY = "superstring-appearance-interface-size";

export const TEXT_SIZES = [
  { id: "small", name: "小" },
  { id: "medium", name: "标准" },
  { id: "large", name: "大" },
] as const;

export type TextSizeId = (typeof TEXT_SIZES)[number]["id"];
export const TEXT_SIZE_IDS: readonly TextSizeId[] = TEXT_SIZES.map((size) => size.id);

// "medium" and "standard" are the untouched rendering: choosing them, or having
// no stored preference at all, must look exactly like a fresh install.
export const INTERFACE_SIZES = [
  { id: "compact", name: "紧凑" },
  { id: "standard", name: "标准" },
  { id: "comfortable", name: "宽松" },
] as const;

export type InterfaceSizeId = (typeof INTERFACE_SIZES)[number]["id"];
export const INTERFACE_SIZE_IDS: readonly InterfaceSizeId[] = INTERFACE_SIZES.map(
  (size) => size.id,
);

export function resolveTheme(id: unknown): (typeof THEMES)[number] {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

export function resolveMode(value: unknown): AppearanceMode {
  return MODES.find((mode) => mode.id === value)?.id ?? "system";
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return typeof value === "string" && (MODE_IDS as readonly string[]).includes(value);
}

export function resolveFont(id: unknown): (typeof FONTS)[number] {
  return FONTS.find((font) => font.id === id) ?? FONTS[0];
}

export function isFontId(value: unknown): value is FontId {
  return typeof value === "string" && (FONT_IDS as readonly string[]).includes(value);
}

// The second entry of each size list is the default (medium / standard), so a
// missing or corrupt stored value resolves to the unchanged rendering.
export function resolveTextSize(id: unknown): (typeof TEXT_SIZES)[number] {
  return TEXT_SIZES.find((size) => size.id === id) ?? TEXT_SIZES[1];
}

export function isTextSizeId(value: unknown): value is TextSizeId {
  return typeof value === "string" && (TEXT_SIZE_IDS as readonly string[]).includes(value);
}

export function resolveInterfaceSize(id: unknown): (typeof INTERFACE_SIZES)[number] {
  return INTERFACE_SIZES.find((size) => size.id === id) ?? INTERFACE_SIZES[1];
}

export function isInterfaceSizeId(value: unknown): value is InterfaceSizeId {
  return typeof value === "string" && (INTERFACE_SIZE_IDS as readonly string[]).includes(value);
}

// WebSocket appearance frame
// The desktop liveness socket carries a single, strictly-shaped appearance
// snapshot: { type: "appearance", theme, mode }. Themes / modes are whitelisted
// (16 ids / 3 modes) and the whole frame is byte-bounded so a hostile or corrupt
// client cannot exhaust the server. Invalid or oversized frames are dropped
// silently and NEVER escalate to a shutdown.

export interface AppearanceSnapshot {
  theme: ThemeId;
  mode: AppearanceMode;
}

/** Hard ceiling on the encoded frame in UTF-8 bytes (the valid frame is ~45B). */
export const APPEARANCE_MESSAGE_MAX_BYTES = 256;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function encodeAppearanceMessage(snapshot: AppearanceSnapshot): string {
  // Callers should pass validated values; re-validate defensively so a bad
  // in-memory value can never produce an out-of-contract frame.
  const theme = isThemeId(snapshot.theme) ? snapshot.theme : "slate";
  const mode = isAppearanceMode(snapshot.mode) ? snapshot.mode : "system";
  return JSON.stringify({ type: "appearance", theme, mode });
}

export function parseAppearanceMessage(raw: unknown): AppearanceSnapshot | null {
  if (typeof raw !== "string") return null;
  if (utf8ByteLength(raw) > APPEARANCE_MESSAGE_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).length !== 3) return null;
  if (obj.type !== "appearance") return null;
  if (!isThemeId(obj.theme)) return null;
  if (!isAppearanceMode(obj.mode)) return null;
  return { theme: obj.theme, mode: obj.mode };
}
