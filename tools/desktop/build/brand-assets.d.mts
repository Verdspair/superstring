export const BRAND_FRAME_SIZES: readonly [16, 20, 24, 32, 40, 48, 64, 128, 256];

export interface BrandFrame {
  size: number;
  file: string;
  resourceName: string;
}

/** Render the shared SVG into the output directory and return native embedding metadata. */
export function renderBrandAssets(root: string, outputDirectory: string): BrandFrame[];
