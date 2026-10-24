import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

/** Keep the icon frame sizes compatible with IconBuilder's existing DIB encoder. */
export const BRAND_FRAME_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/** Windows ladder for the transparent OS icon; IconBuilder packs exactly these rendered frames. */
export const WINDOWS_ICON_FRAME_SIZES = [16, 20, 24, 30, 32, 36, 40, 42, 48, 64, 96, 128, 256];

/**
 * The one OS raster ink. Windows composites a single static bitmap onto either a light or a
 * dark taskbar and cannot follow the master's light/dark rule, so this is the mid tone of the
 * two brand colours: 3.76:1 on #f3f3f3 and 3.90:1 on #202020.
 */
export const BRAND_ICON_INK = "#717d8f";

const STYLE_BLOCK = /^[ \t]*<style[\s\S]*?<\/style>[ \t]*\r?\n/m;

/**
 * Derive the transparent OS icon from the master: drop the standalone style block and
 * resolve the theme-bound colour to the fixed raster ink. Paths, circles and stroke widths
 * are copied unchanged. The checked-in icon file is written from this function.
 */
export function deriveBrandIconSvg(masterSvg) {
  return masterSvg
    .replace(STYLE_BLOCK, "")
    .replaceAll("currentColor", BRAND_ICON_INK)
    .replace('id="mark"', 'id="icon-mark"');
}

/**
 * The two shared brand sources and where their frames land. Icon frames get their own
 * directory so the desktop build can point IconBuilder at them without also matching the
 * plain glyph frames written under the same output root. Both sources rasterise the master;
 * `superstring-icon.svg` is only the checked-in generated copy.
 */
const BRAND_SOURCES = [
  {
    source: "master",
    svg: "superstring.svg",
    directory: "brand",
    prefix: "glyph",
    resource: "Superstring.Desktop.Brand",
    sizes: BRAND_FRAME_SIZES,
  },
  {
    source: "icon",
    svg: "superstring.svg",
    derive: deriveBrandIconSvg,
    directory: "icon",
    prefix: "icon",
    resource: "Superstring.Desktop.Icon",
    sizes: WINDOWS_ICON_FRAME_SIZES,
  },
];

/**
 * Build-time SVG adaptation only; all geometry lives in the shared brand source.
 * `source` defaults to the plain master glyph; pass "icon" for OS icon frames.
 */
export function renderBrandAssets(root, outputDirectory, { source = "master" } = {}) {
  const brand = BRAND_SOURCES.find((candidate) => candidate.source === source);
  if (!brand) {
    const known = BRAND_SOURCES.map((entry) => entry.source).join(" or ");
    throw new Error(`Unknown brand source "${source}"; expected ${known}`);
  }
  const master = fs.readFileSync(path.join(root, "src/shared/brand", brand.svg));
  const svg = brand.derive ? brand.derive(master.toString("utf8")) : master;
  const directory = path.join(outputDirectory, brand.directory);
  fs.mkdirSync(directory, { recursive: true });
  return brand.sizes.map((size) => {
    const renderer = new Resvg(svg, {
      fitTo: { mode: "width", value: size },
      font: { loadSystemFonts: false },
    });
    const file = path.join(directory, `${brand.prefix}-${size}.png`);
    fs.writeFileSync(file, renderer.render().asPng());
    return { size, file, resourceName: `${brand.resource}.${size}.png` };
  });
}
