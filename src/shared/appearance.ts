// Shared, DOM-free appearance contract for both the browser (src/web) and the
// server (src/server). This module MUST NOT import anything browser-only
// (localStorage, document, window) — otherwise the server would pull DOM side
// effects into the process. The native desktop launcher reads the persisted
// JSON (see src/server/desktop-appearance.ts); the THEMES / MODES data here is
// the single source of truth for the 16 theme ids and 3 mode ids.

export const THEME_STORAGE_KEY = "superstring-appearance";
export const MODE_STORAGE_KEY = "superstring-appearance-mode";

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
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export const THEME_IDS: readonly ThemeId[] = THEMES.map((theme) => theme.id);

export const MODES = [
  { id: "system", name: "跟随系统" },
  { id: "light", name: "浅色" },
  { id: "dark", name: "深色" },
] as const;

export type AppearanceMode = (typeof MODES)[number]["id"];
export const MODE_IDS: readonly AppearanceMode[] = MODES.map((mode) => mode.id);

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

// --- WebSocket appearance frame -------------------------------------------------
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
