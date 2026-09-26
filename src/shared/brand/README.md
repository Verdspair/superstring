# Superstring mark

`superstring.svg` is the only editable master. The refined mark preserves the original
quotation marks, conversation bubble, vibrating string and two connected nodes.
Its 32-unit grid enlarges the main shape, draws the quotation marks closer together,
and uses a consistent 2-unit outline. The full artwork occupies a 28-unit square.

- Web: `BrandLogo` references `#mark` with SVG `use`. Vite emits a shared asset;
  `?no-inline` keeps fragment references out of data URLs. The host supplies
  `currentColor` so all user themes work without separate logo variants.
- Favicon: the same SVG, with a standalone light/dark foreground rule.
- Desktop: `tools/desktop/build/brand-assets.mjs` uses resvg to render nine PNG
  sizes at build time. Both the icon builder and launcher embed these frames.
  System.Drawing performs standard frame selection and tinting; it does not parse SVG.

Keep generated PNG/ICO files in build output. Do not draw a separate desktop mark,
replace the brand with a functional icon, or duplicate the geometry in TSX/C#.
This is project-owned brand artwork; generic UI controls still use the component registry.
