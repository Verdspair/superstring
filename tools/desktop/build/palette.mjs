import fs from "node:fs";
import path from "node:path";

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
  const light = css.match(/:root\s*\{([^}]+)\}/)?.[1];
  const dark = css.match(/:root\.dark,\s*\.dark\s*\{([^}]+)\}/)?.[1];
  const system = css.match(/:root:not\(\.light\)\s*\{([^}]+)\}/)?.[1];
  const names = {
    Surface: "ac-surface",
    Text: "ac-text",
    Muted: "ac-muted",
    Deep: "superstring-tone-deep",
    Line: "superstring-tone-line",
    Soft: "superstring-tone-soft",
    Accent: "ac-accent",
  };
  function token(block, key) {
    const value = block?.match(new RegExp(`--${key}:\\s*(#[\\da-fA-F]{6})\\s*;`))?.[1];
    if (!value) throw new Error(`CSS token missing: ${key}`);
    return value;
  }
  for (const key of Object.values(names))
    if (token(dark, key) !== token(system, key)) throw new Error(`System/dark token drift: ${key}`);
  const base = (block) =>
    Object.entries(names)
      .map(([name, key]) => `${name} = ColorTranslator.FromHtml("${token(block, key)}")`)
      .join(",\n                ");
  const code = `// Generated from src/shared/appearance.ts and src/web/styles.css. Do not edit.\nusing System.Drawing;\nnamespace Superstring.Desktop\n{\n    internal static class DesktopPaletteData\n    {\n        internal static readonly string[,] Themes = new string[,]\n        {\n${themes.map((t) => `            { ${t.map((v) => JSON.stringify(v)).join(", ")} }`).join(",\n")}\n        };\n        internal static readonly string[] Modes = new string[] { ${modes.map((m) => JSON.stringify(m)).join(", ")} };\n        internal static DesktopAppearance.ResolvedPalette Base(bool dark)\n        {\n            return dark ? new DesktopAppearance.ResolvedPalette\n            {\n                ${base(dark)}, IsDark = true\n            } : new DesktopAppearance.ResolvedPalette\n            {\n                ${base(light)}, IsDark = false\n            };\n        }\n    }\n}\n`;
  const target = path.join(outDir, "DesktopPaletteData.g.cs");
  fs.writeFileSync(target, code);
  return target;
}
