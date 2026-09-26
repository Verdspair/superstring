import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

/** Keep the icon frame sizes compatible with IconBuilder's existing DIB encoder. */
export const BRAND_FRAME_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/** Build-time SVG adaptation only; all geometry lives in the shared brand source. */
export function renderBrandAssets(root, outputDirectory) {
  const svg = fs.readFileSync(path.join(root, "src/shared/brand/superstring.svg"));
  const directory = path.join(outputDirectory, "brand");
  fs.mkdirSync(directory, { recursive: true });
  return BRAND_FRAME_SIZES.map((size) => {
    const renderer = new Resvg(svg, {
      fitTo: { mode: "width", value: size },
      font: { loadSystemFonts: false },
    });
    const file = path.join(directory, `glyph-${size}.png`);
    fs.writeFileSync(file, renderer.render().asPng());
    return { size, file, resourceName: `Superstring.Desktop.Brand.${size}.png` };
  });
}
