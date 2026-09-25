// 界面中英对应 (product policy-7): every key the interface asks for must exist in English.
//
// A source scan rather than a render test, because the gaps this catches are invisible to a
// component test: an English pass over 存储与诊断 (2026-09-25) found three kinds at once — a nav note
// rendered through `t()` that was never added, a sentence composed from three untranslated
// fragments (`t("其中带正文") + n + t("条")`), and a retention note built from a template literal that
// skipped `t()` entirely. `t()` returns an unknown key unchanged, so all three fail silently and
// only show up as Chinese text in the English interface.
//
// Dynamic labels are deliberately out of scope: `t(label)` where the value is computed (for example
// the composed 「群 30003」) has no literal to check, and passing it through is the intended
// behaviour. Only literals are asserted.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENGLISH_DICTIONARY = resolve(projectRoot, "src/web/i18n/en.ts");
const WEB_ROOT = resolve(projectRoot, "src/web");

/** Both `"quoted key"` and bare `识别符` forms: the dictionary uses each where it reads better. */
function dictionaryKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^ {2}("(?:[^"\\]|\\.)*"|[^:\s][^:]*?)\s*:/.exec(line);
    if (!match) continue;
    const raw = match[1].trim();
    keys.add(raw.startsWith('"') ? (JSON.parse(raw) as string) : raw);
  }
  return keys;
}

function webSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...webSources(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe("English dictionary coverage", () => {
  it("defines every key the interface asks for", () => {
    const keys = dictionaryKeys(readFileSync(ENGLISH_DICTIONARY, "utf8"));
    const missing: string[] = [];
    for (const file of webSources(WEB_ROOT)) {
      if (resolve(file) === ENGLISH_DICTIONARY) continue;
      const text = readFileSync(file, "utf8");
      const where = relative(projectRoot, file).replace(/\\/g, "/");
      for (const match of text.matchAll(/\bt\(\s*"((?:[^"\\\n]|\\.)*)"\s*[,)]/g)) {
        if (!keys.has(match[1])) missing.push(`${where}: ${match[1]}`);
      }
    }
    // The sidebar renders each route's title and note through `t()`, and those are plain object
    // fields rather than call arguments — the shape that let two of them go untranslated.
    const routes = readFileSync(resolve(projectRoot, "src/web/app/settings-routes.ts"), "utf8");
    for (const match of routes.matchAll(/^ {4}(?:title|note): "((?:[^"\\]|\\.)*)",$/gm)) {
      if (!keys.has(match[1])) missing.push(`src/web/app/settings-routes.ts: ${match[1]}`);
    }
    expect(missing).toEqual([]);
  });
});
