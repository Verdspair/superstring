// Code-point string primitives, shared by the contract layer.
//
// The contracts must reproduce the validator ORDER, not just its limits: the
// length bounds run against the RAW input, and the post-validator that strips
// runs afterwards. JavaScript's
// `String.prototype.trim()` is the wrong tool for that second step — its
// whitespace set differs from the contract's strip in both directions:
//
//   contract only : U+001C–U+001F, U+0085      (JS would keep these)
//   JS only       : U+FEFF                     (JS would strip this)
//
// So a whitespace-only value built from U+0085 is blank for the contract and not
// for JS, and one built from U+FEFF is the other way round. Both are reachable
// from an HTTP body, which makes this contract-visible.
//
// Pure functions only — no I/O, no server imports.

/**
 * Exactly the characters the contract treats as whitespace — the set `strip()`
 * removes. Deliberately excludes U+FEFF.
 */
export const UNICODE_WHITESPACE =
  "\t\n\v\f\r\u001c\u001d\u001e\u001f \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

const STRIP_START = new RegExp(`^[${UNICODE_WHITESPACE}]+`);
const STRIP_END = new RegExp(`[${UNICODE_WHITESPACE}]+$`);

/** Strip with no argument — NOT `String.prototype.trim()`. */
export function unicodeStrip(value: string): string {
  return value.replace(STRIP_START, "").replace(STRIP_END, "");
}

/** Truthiness of the stripped value: is it blank? */
export function isBlank(value: string): boolean {
  return unicodeStrip(value) === "";
}

/** Counts code points, not UTF-16 code units. */
export function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

/** Slice by code point: `str[:n]`. */
export function codePointSlice(value: string, end: number): string {
  if (end <= 0) return "";
  let index = 0;
  let out = "";
  for (const ch of value) {
    if (index >= end) break;
    out += ch;
    index++;
  }
  return out;
}

/**
 * Rounding for non-negative finite x: nearest, ties to even, evaluated
 * on the exact binary value. `Math.round` would differ on exact .5 ties, which
 * changes the compiled persona for e.g. len=5, intensity=50.
 */
export function halfEvenRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
