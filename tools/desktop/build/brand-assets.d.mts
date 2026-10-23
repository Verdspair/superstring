export const BRAND_FRAME_SIZES: readonly [16, 20, 24, 32, 40, 48, 64, 128, 256];

/** Windows ladder for the transparent desktop icon; IconBuilder packs exactly these rendered frames. */
export const WINDOWS_ICON_FRAME_SIZES: readonly [
  16,
  20,
  24,
  30,
  32,
  36,
  40,
  42,
  48,
  64,
  96,
  128,
  256,
];

/** OS-only raster ink; Windows cannot follow the master's light/dark colour rule. */
export const BRAND_ICON_INK: string;

/** Resolve the master into the transparent, self-contained OS icon. */
export function deriveBrandIconSvg(masterSvg: string): string;

/** Which shared brand SVG to rasterise: "master" is the themed glyph, "icon" the transparent OS icon. */
export type BrandAssetSource = "master" | "icon";

export interface BrandFrame {
  size: number;
  file: string;
  resourceName: string;
}

export interface BrandAssetOptions {
  /** Defaults to "master", the frames the retiring C# shell embeds. */
  source?: BrandAssetSource;
}

/**
 * Render the shared brand source into `<outputDirectory>/brand` (master) or
 * `<outputDirectory>/icon` (transparent OS icon) and return native embedding metadata.
 * The icon frames are derived from the master at build time.
 */
export function renderBrandAssets(
  root: string,
  outputDirectory: string,
  options?: BrandAssetOptions,
): BrandFrame[];
