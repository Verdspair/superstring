import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { imageSize } from "image-size";
import { BRAND_FRAME_SIZES, renderBrandAssets } from "../../tools/desktop/build/brand-assets.mjs";

const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "superstring-brand-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("shared SVG desktop build assets", () => {
  it("preserves the original 24-unit geometry in the shared master", () => {
    const svg = readFileSync(
      path.resolve(import.meta.dir, "../../src/shared/brand/superstring.svg"),
      "utf8",
    );
    expect(svg).toContain('viewBox="0 0 24 24"');
    const mark = svg
      .slice(svg.indexOf('<g id="mark"'), svg.lastIndexOf("</svg>"))
      .replace(/\s+/g, " ")
      .trim();
    expect(createHash("sha256").update(mark).digest("hex")).toBe(
      "79d965ccfa297aeae761d6e0857fbbe98f1d5b787b1e57ea218d9be4227c094c",
    );
  });

  it("keeps the wordmark outlines and its light/dark colour rule in the shared asset", () => {
    const svg = readFileSync(
      path.resolve(import.meta.dir, "../../src/shared/brand/superstring-wordmark.svg"),
      "utf8",
    );
    expect(svg).toContain('viewBox="0 0 884 71"');
    expect(svg).toContain("@media (prefers-color-scheme: dark)");
    const outlines = svg
      .slice(svg.indexOf('<g fill="currentColor"'), svg.lastIndexOf("</svg>"))
      .replace(/\s+/g, " ")
      .trim();
    expect(createHash("sha256").update(outlines).digest("hex")).toBe(
      "ac15406408b7b0708eb849358dcdbcfc64ddbe0896369c33aab8f8898f08e240",
    );
  });

  it("renders all native icon resolutions directly from the shared brand source", () => {
    const frames = renderBrandAssets(path.resolve(import.meta.dir, "../.."), temporary());
    expect(frames.map((frame: { size: number }) => frame.size)).toEqual([
      16, 20, 24, 32, 40, 48, 64, 128, 256,
    ]);
    expect(frames).toHaveLength(BRAND_FRAME_SIZES.length);
    for (const frame of frames) {
      expect(imageSize(readFileSync(frame.file))).toMatchObject({
        width: frame.size,
        height: frame.size,
        type: "png",
      });
      expect(frame.resourceName).toBe(`Superstring.Desktop.Brand.${frame.size}.png`);
    }
  });

  it("regenerates resources when only the canonical SVG changes, without any native geometry source", () => {
    const root = temporary(),
      destination = temporary();
    const source = path.join(root, "src/shared/brand/superstring.svg");
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(
      source,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="8" cy="8" r="6"/></svg>',
    );
    const before = renderBrandAssets(root, destination).map((frame: { file: string }) =>
      readFileSync(frame.file),
    );
    writeFileSync(
      source,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="4" y="4" width="24" height="24"/></svg>',
    );
    const after = renderBrandAssets(root, destination);
    for (const [index, frame] of after.entries())
      expect(readFileSync(frame.file)).not.toEqual(before[index]);
    // A release cannot quietly use cached frames when its canonical source is absent.
    rmSync(source);
    expect(() => renderBrandAssets(root, destination)).toThrow();
  });
});
