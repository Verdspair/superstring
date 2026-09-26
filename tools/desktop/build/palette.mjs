import fs from "node:fs";
import path from "node:path";
import { blend, converter, formatHex } from "culori";
import postcss from "postcss";

// These are native semantic roles, not a parallel color palette. Personal
// theme accents are applied from shared/appearance.ts by DesktopAppearance.
const roles = {
  Surface: "--background",
  Text: "--foreground",
  Muted: "--muted-foreground",
  Deep: "--primary",
  Line: "--border",
  Soft: "--muted",
  Accent: "--ring",
};
const rgb = converter("rgb");

/** Convert current shadcn CSS tokens into opaque GDI colors at build time. */
export function readCssPalette(css) {
  const document = postcss.parse(css);
  const light = new Map();
  const dark = new Map();
  document.each((rule) => {
    if (rule.type !== "rule") return;
    for (const [selector, values] of [
      [":root", light],
      [".dark", dark],
    ]) {
      if (!rule.selectors.includes(selector)) continue;
      rule.each((node) => {
        if (node.type === "decl" && node.prop.startsWith("--")) {
          values.set(node.prop, node.value);
        }
      });
    }
  });
  if (!light.size || !dark.size) throw new Error("CSS light/dark theme rules not found");
  const resolve = (values, mode) => {
    const color = (key) => {
      const value = values.get(key);
      const parsed = value && rgb(value);
      if (!parsed) throw new Error(`CSS color missing or unsupported: ${mode} ${key}`);
      return parsed;
    };
    const surface = color(roles.Surface);
    if ((surface.alpha ?? 1) !== 1) {
      throw new Error(`CSS background must be opaque: ${mode}`);
    }
    return Object.fromEntries(
      Object.entries(roles).map(([role, key]) => [
        role,
        // GDI ColorTranslator does not accept OKLCH or CSS alpha. Use Culori's
        // source-over compositing in sRGB, matching an element on this surface.
        formatHex(blend([surface, color(key)], "normal", "rgb")),
      ]),
    );
  };
  return { light: resolve(light, "light"), dark: resolve(new Map([...light, ...dark]), "dark") };
}

// Compile-time adapter, not a second hand-maintained palette. Fail closed if the
// web contract changes shape; generated C# is written into the caller's outDir
// (build.mjs passes artifacts/build/desktop) and is never hand-edited.
export function generatePalette(root, outDir) {
  const source = fs.readFileSync(path.join(root, "src/shared/appearance.ts"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/web/styles.css"), "utf8");
  const themeBlock = source.match(/export const THEMES = \[([\s\S]*?)\] as const;/)?.[1];
  const modeBlock = source.match(/export const MODES = \[([\s\S]*?)\] as const;/)?.[1];
  if (!themeBlock || !modeBlock) throw new Error("Shared appearance arrays not found");
  const themes = [
    ...themeBlock.matchAll(
      /\{\s*id:\s*"([a-z]+)",\s*name:\s*"[^"]+",\s*color:\s*"(#[\da-fA-F]{6})",\s*dark:\s*"(#[\da-fA-F]{6})"\s*\}/g,
    ),
  ].map((m) => m.slice(1));
  const modes = [...modeBlock.matchAll(/\{\s*id:\s*"([a-z]+)",\s*name:\s*"[^"]+"\s*\}/g)].map(
    (m) => m[1],
  );
  if (
    themes.length !== 16 ||
    new Set(themes.map((t) => t[0])).size !== 16 ||
    themes[0][0] !== "slate" ||
    modes.join(",") !== "system,light,dark"
  )
    throw new Error("Unexpected shared theme contract");
  // The web resolves system mode by applying .dark at runtime. There is no
  // duplicated prefers-color-scheme palette to scrape or keep in sync.
  const { light, dark } = readCssPalette(css);
  const base = (block) =>
    Object.entries(block)
      .map(([name, value]) => `${name} = ColorTranslator.FromHtml("${value}")`)
      .join(",\n                ");
  const code = `// Generated from src/shared/appearance.ts and src/web/styles.css. Do not edit.\nusing System.Drawing;\nnamespace Superstring.Desktop\n{\n    internal static class DesktopPaletteData\n    {\n        internal static readonly string[,] Themes = new string[,]\n        {\n${themes.map((t) => `            { ${t.map((v) => JSON.stringify(v)).join(", ")} }`).join(",\n")}\n        };\n        internal static readonly string[] Modes = new string[] { ${modes.map((m) => JSON.stringify(m)).join(", ")} };\n        internal static DesktopAppearance.ResolvedPalette Base(bool dark)\n        {\n            return dark ? new DesktopAppearance.ResolvedPalette\n            {\n                ${base(dark)}, IsDark = true\n            } : new DesktopAppearance.ResolvedPalette\n            {\n                ${base(light)}, IsDark = false\n            };\n        }\n    }\n}\n`;
  const target = path.join(outDir, "DesktopPaletteData.g.cs");
  fs.writeFileSync(target, code);
  return target;
}
