import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

export function buildBrand(root, directory, platform, run) {
  const svg = fs.readFileSync(path.join(root, "src/shared/brand/superstring.svg"));
  const render = (size, destination) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(
      destination,
      new Resvg(svg, {
        fitTo: { mode: "width", value: size },
        font: { loadSystemFonts: false },
      })
        .render()
        .asPng(),
    );
  };
  render(1024, path.join(directory, "icon.png"));
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    render(size, path.join(directory, "icons", `${size}x${size}.png`));
  }
  if (platform === "darwin") {
    const iconset = path.join(directory, "icon.iconset");
    for (const size of [16, 32, 128, 256, 512]) {
      render(size, path.join(iconset, `icon_${size}x${size}.png`));
      render(size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`));
    }
    run("iconutil", ["--convert", "icns", iconset, "--output", path.join(directory, "icon.icns")]);
  }
}
