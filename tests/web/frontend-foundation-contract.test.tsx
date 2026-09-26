import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContentReader } from "../../src/web/screens/observability/ContentReader";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const web = join(root, "src/web");
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
afterEach(cleanup);

describe("frontend foundation boundaries", () => {
  it("has no remaining presentation files under the retired UI namespaces", () => {
    const retired = sources(web).filter(
      (path) => /\/web\/(app|features|ui)\//.test(path) && extname(path) === ".tsx",
    );
    expect(retired.map((path) => path.slice(root.length + 1))).toEqual([]);
  });
  it("retains mature interaction, async, internationalization and visualization foundations", () => {
    const { dependencies } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const dependency of [
      "radix-ui",
      "cmdk",
      "react-resizable-panels",
      "effect",
      "motion",
      "i18next",
      "react-i18next",
      "react-circular-progressbar",
      "@tanstack/react-table",
    ])
      expect(
        dependencies[dependency],
        `${dependency} must remain a declared runtime dependency`,
      ).toBeTruthy();
  });
  it("never interprets model, conversation or document text through React raw-HTML sinks", () => {
    const violations: string[] = [];
    for (const path of sources(web)) {
      const source = readFileSync(path, "utf8");
      if (/\bdangerouslySetInnerHTML\b|\.(?:innerHTML|outerHTML)\s*=/.test(source))
        violations.push(path.slice(root.length + 1));
    }
    expect(violations).toEqual([]);
  });
  it("renders hostile model text literally in the actual evidence reader", () => {
    const text = '<img src=x onerror="alert(1)"><script>execute()</script> & raw text';
    const { container } = render(<ContentReader text={text} label="Actual model output" />);
    expect(container.textContent).toContain(text);
    expect(container.querySelector("img, script")).toBeNull();
  });
});
