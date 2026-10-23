import type { Plugin } from "postcss";

/**
 * PostCSS plugin that multiplies compiled font-size lengths by
 * --app-text-scale and divides viewport lengths by --app-interface-scale.
 * Wired in vite.config.ts; behaviour is pinned by
 * tests/contracts/appearance-scale.test.ts.
 */
export default function appearanceScale(): Plugin;
