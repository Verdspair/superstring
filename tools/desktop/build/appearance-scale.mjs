/**
 * Build-time appearance scaling, applied once to the compiled stylesheet.
 *
 * The two size preferences reach CSS as two numbers on <html> --app-text-scale
 * and --app-interface-scale (see src/web/styles.css). This pass is the only
 * place that turns those numbers into geometry, so a literal size written in
 * any file, including a future one, cannot bypass the text axis, and no
 * component needs a scaled shadow utility.
 *
 * What stays unscaled, and why:
 * - the root html font size: rem-derived spacing and control heights follow it,
 *   so scaling it would move the interface axis with the text axis;
 * - em, %, and relative sizes: they already track the scaled parent;
 * - line-height: Tailwind emits it as a unitless ratio, so it follows font-size.
 *
 * Viewport lengths are divided by the interface scale because that axis is a CSS
 * zoom on the document, and Chromium multiplies viewport-percentage lengths by
 * the effective zoom instead of leaving them alone (measured: 100dvh = 720px at
 * 0.9 and 880px at 1.1 on an 800px viewport). Dividing cancels that.
 */

const TEXT_SCALE = "var(--app-text-scale, 1)";
const INTERFACE_SCALE = "var(--app-interface-scale, 1)";

/** One absolute length, the only font-size shape the text axis rewrites. */
const ABSOLUTE_LENGTH = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem)$/i;

/** A Tailwind text token reference; other var() uses are left as they are. */
const TEXT_TOKEN = /^var\(\s*--text-[a-z0-9-]+\s*\)$/i;

/** Rules that style only the document element: its font size anchors rem. */
const ROOT_ONLY_SELECTOR = /^(?:html|:root|:host)(?:\s*,\s*(?:html|:root|:host))*$/;

/** Quoted text, url() and var() never carry a length to rewrite. */
const PROTECTED_SEGMENT = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\([^)]*\)|var\([^)]*\)/gi;

/** vh / vw / vmin / vmax with the s, l and d prefixes, minus e.g. "vhunits". */
const VIEWPORT_LENGTH =
  /(^|[^A-Za-z0-9_.-])((?:[+-]?\d+(?:\.\d+)?|[+-]?\.\d+)(?:[sld]?(?:vh|vw|vmin|vmax))(?![A-Za-z0-9_-]))/gi;

function isCustomProperty(prop) {
  return prop.startsWith("--");
}

function numericPart(value) {
  const match = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(value);
  return match ? Number.parseFloat(match[0]) : Number.NaN;
}

function insideFontFace(decl) {
  for (let node = decl.parent; node; node = node.parent) {
    if (node.type === "atrule" && node.name.toLowerCase() === "font-face") return true;
  }
  return false;
}

function stylesOnlyDocumentElement(decl) {
  const parent = decl.parent;
  if (!parent || parent.type !== "rule") return false;
  return parent.selectors.every((selector) => ROOT_ONLY_SELECTOR.test(selector.trim()));
}

function mapUnprotected(value, rewrite) {
  let out = "";
  let last = 0;
  for (const match of value.matchAll(PROTECTED_SEGMENT)) {
    out += rewrite(value.slice(last, match.index));
    out += match[0];
    last = match.index + match[0].length;
  }
  return out + rewrite(value.slice(last));
}

function scaleTextSize(decl) {
  const value = decl.value.trim();
  if (value.includes("--app-text-scale")) return;
  if (insideFontFace(decl) || stylesOnlyDocumentElement(decl)) return;
  const scaled = ABSOLUTE_LENGTH.test(value) || TEXT_TOKEN.test(value);
  if (!scaled || numericPart(value) === 0) return;
  decl.value = `calc(${value} * ${TEXT_SCALE})`;
}

function compensateViewportLengths(decl) {
  if (decl.value.includes("--app-interface-scale")) return;
  const rewritten = mapUnprotected(decl.value, (segment) =>
    segment.replace(
      VIEWPORT_LENGTH,
      (_all, lead, token) => `${lead}calc(${token} / ${INTERFACE_SCALE})`,
    ),
  );
  if (rewritten !== decl.value) decl.value = rewritten;
}

export default function appearanceScale() {
  return {
    postcssPlugin: "superstring-appearance-scale",
    Declaration(decl) {
      if (isCustomProperty(decl.prop)) return;
      if (decl.prop.toLowerCase() === "font-size") scaleTextSize(decl);
      compensateViewportLengths(decl);
    },
  };
}

appearanceScale.postcss = true;
