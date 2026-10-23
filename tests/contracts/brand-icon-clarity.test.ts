// The transparent OS icon reuses the master geometry with one fixed raster ink.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { BRAND_ICON_INK } from "../../tools/desktop/build/brand-assets.mjs";

const brandDirectory = path.resolve(import.meta.dir, "../../src/shared/brand");
const master = readFileSync(path.join(brandDirectory, "superstring.svg"), "utf8");
const icon = readFileSync(path.join(brandDirectory, "superstring-icon.svg"), "utf8");

const tag = (svg: string, pattern: RegExp) => svg.match(pattern)?.[0] ?? "";
const attribute = (element: string, name: string) =>
  element.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] ?? "";
const pathsOf = (svg: string) =>
  [...svg.matchAll(/<path\b[^>]*>/g)].map((element) => attribute(element[0], "d"));
const nodesOf = (svg: string) =>
  [...svg.matchAll(/<circle\b[^>]*>/g)].map((element) =>
    ["cx", "cy", "r"].map((name) => attribute(element[0], name)),
  );
const widthsOf = (svg: string) =>
  [...svg.matchAll(/stroke-width="([\d.]+)"/g)].map((width) => Number(width[1]));

const channel = (value: number) =>
  value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const luminance = (rgb: number[]) =>
  0.2126 * channel(rgb[0] ?? 0) + 0.7152 * channel(rgb[1] ?? 0) + 0.0722 * channel(rgb[2] ?? 0);
const hex = (value: string) => [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16));
const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(hex(a)), luminance(hex(b))].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

const iconMark = tag(icon, /<g\b[^>]*id="icon-mark"[^>]*>/);
const ink = attribute(iconMark, "stroke").replace("#", "").toLowerCase();

const render = (size: number) => {
  const image = new Resvg(icon, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: false },
  }).render();
  return { width: image.width, height: image.height, pixels: image.pixels };
};
const rgbaAt = (pixels: Buffer, size: number, x: number, y: number) => {
  const at = (y * size + x) * 4;
  return [pixels[at] ?? 0, pixels[at + 1] ?? 0, pixels[at + 2] ?? 0, pixels[at + 3] ?? 0];
};
const countAlpha = (pixels: Buffer, size: number, floor: number) => {
  let count = 0;
  for (let index = 0; index < size * size; index += 1)
    if ((pixels[index * 4 + 3] ?? 0) >= floor) count += 1;
  return count;
};
const inkBounds = (pixels: Buffer, size: number) => {
  let minX = size;
  let maxX = -1;
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1)
      if ((pixels[(y * size + x) * 4 + 3] ?? 0) > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
  return { minX, maxX };
};

describe("transparent brand icon", () => {
  it("keeps the master as the only shape source", () => {
    expect(master).toContain("currentColor");
    expect(master).toContain("@media (prefers-color-scheme: dark)");
    expect(master).not.toContain("<rect");
    expect(icon).not.toContain("<rect");
    expect(pathsOf(icon)).toHaveLength(6);
    expect(nodesOf(icon)).toHaveLength(2);
    expect(pathsOf(icon)).toEqual(pathsOf(master));
    expect(nodesOf(icon)).toEqual(nodesOf(master));
    expect(widthsOf(icon)).toEqual(widthsOf(master));
  });

  it("uses one OS ink with contrast on light and dark taskbars", () => {
    expect(ink).toBe(BRAND_ICON_INK.slice(1).toLowerCase());
    const colours = [...icon.matchAll(/#[0-9a-fA-F]{6}/g)].map((colour) =>
      colour[0].slice(1).toLowerCase(),
    );
    expect([...new Set(colours)]).toEqual([BRAND_ICON_INK.slice(1).toLowerCase()]);
    expect(contrast(ink, "f3f3f3")).toBeGreaterThanOrEqual(3);
    expect(contrast(ink, "202020")).toBeGreaterThanOrEqual(3);
    expect(master.match(/color:\s*#([0-9a-fA-F]{6})/g)).toHaveLength(2);
  });

  it("stays self-contained: no font, external reference or theme dependency", () => {
    expect(icon).not.toMatch(/href=|url\(|<style|<text|<image|currentColor|@media/);
    expect(new Resvg(icon, { font: { loadSystemFonts: false } }).imagesToResolve()).toEqual([]);
  });

  it("renders transparent frames with a solid ink core and uncropped mark width", () => {
    for (const size of [16, 24, 30, 36, 48, 256]) {
      const { width, height, pixels } = render(size);
      expect([width, height]).toEqual([size, size]);
      expect(pixels.length).toBe(size * size * 4);
      const corners: [number, number][] = [
        [0, 0],
        [size - 1, 0],
        [0, size - 1],
        [size - 1, size - 1],
      ];
      for (const [x, y] of corners) expect(rgbaAt(pixels, size, x, y)[3]).toBe(0);
      expect(countAlpha(pixels, size, 64)).toBeGreaterThan(0);
      expect(countAlpha(pixels, size, 250)).toBeGreaterThan(0);
      const { minX, maxX } = inkBounds(pixels, size);
      expect(maxX - minX + 1).toBeGreaterThanOrEqual(Math.ceil(size * 0.9));
    }
  });
});
