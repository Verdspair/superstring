import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generatePalette, readCssPalette } from "../../tools/desktop/build/palette.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const currentCss = fs.readFileSync(path.join(root, "src/web/styles.css"), "utf8");

test("Windows generator consumes the current shadcn CSS and preserves all shared theme/mode entries", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "superstring-palette-"));
  try {
    const generated = fs.readFileSync(generatePalette(root, directory), "utf8");
    const appearance = fs.readFileSync(path.join(root, "src/shared/appearance.ts"), "utf8");
    const themes = [
      ...appearance.matchAll(
        /id: "([a-z]+)", name: "[^"]+", color: "(#[a-f\d]{6})", dark: "(#[a-f\d]{6})"/g,
      ),
    ];
    assert.equal(themes.length, 16);
    for (const [, id, light, dark] of themes) {
      assert.ok(
        generated.includes(`{ "${id}", "${light}", "${dark}" }`),
        `${id} keeps both shared accent variants`,
      );
    }
    assert.match(generated, /Modes = new string\[\] \{ "system", "light", "dark" \}/);
    assert.equal((generated.match(/IsDark = true/g) ?? []).length, 1);
    assert.equal((generated.match(/IsDark = false/g) ?? []).length, 1);
    assert.match(generated, /Surface = ColorTranslator.FromHtml\("#ffffff"\)/);
    assert.match(generated, /Surface = ColorTranslator.FromHtml\("#0a0a0a"\)/);
    assert.doesNotMatch(generated, /oklch\(|ac-surface|superstring-tone/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("dark translucent border is composited over the actual dark surface, never flattened to white", () => {
  const { light, dark } = readCssPalette(currentCss);
  assert.equal(light.Surface, "#ffffff");
  assert.equal(light.Text, "#0a0a0a");
  assert.equal(light.Line, "#e5e5e5");
  assert.equal(dark.Surface, "#0a0a0a");
  assert.equal(dark.Text, "#fafafa");
  assert.equal(dark.Line, "#232323");
  assert.equal(dark.Soft, "#262626");
  for (const mode of [light, dark]) {
    for (const color of Object.values(mode)) assert.match(color, /^#[a-f\d]{6}$/);
  }
});

test("PostCSS handles comments, grouped selectors and declaration overrides without reading component tokens", () => {
  const palette = readCssPalette(`
    /* A commented-out :root { --background: red; } is not a theme. */
    :root, .preview {
      --background: rgb(255 255 255);
      --foreground: #000;
      --muted-foreground: hsl(0 0% 50%);
      --primary: #123456;
      --ring: #abcdef;
      --muted: rgb(0 0 0 / 10%);
      --border: rgb(0 0 0 / 20%);
    }
    .dark {
      --background: #000;
      --border: oklch(1 0 0 / 10%);
      --muted: rgb(255 255 255 / 20%);
    }
    .card { --background: red; --border: green; }
    .dark { --foreground: white; }
  `);
  assert.equal(palette.light.Surface, "#ffffff");
  assert.equal(palette.light.Line, "#cccccc");
  assert.equal(palette.dark.Surface, "#000000");
  assert.equal(palette.dark.Text, "#ffffff");
  assert.equal(palette.dark.Line, "#191919");
  assert.equal(palette.dark.Soft, "#333333");
  assert.equal(palette.dark.Deep, "#123456");
  assert.equal(palette.dark.Accent, "#abcdef");
});

test("a missing or unrepresentable required token fails before writing generated C#", () => {
  assert.throws(
    () => readCssPalette(currentCss.replaceAll("--muted-foreground:", "--unused:")),
    /--muted-foreground/,
  );
  assert.throws(
    () =>
      readCssPalette(
        currentCss.replace("--background: oklch(1 0 0)", "--background: var(--unresolved)"),
      ),
    /--background/,
  );
  assert.throws(
    () =>
      readCssPalette(
        currentCss.replace("--background: oklch(1 0 0)", "--background: rgb(255 255 255 / 50%)"),
      ),
    /opaque/,
  );
  assert.throws(() => readCssPalette(":root { --background: white; }"), /light\/dark/);
});
