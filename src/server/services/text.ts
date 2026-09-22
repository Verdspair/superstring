// Code-point-accurate string / number primitives.
// Two primitives differ from their JavaScript counterparts in ways that change
// output, and every text field in the API passes through them:
// 1. `strip()` / `isWhitespace()` — the contract's whitespace set is NOT the
// same as JavaScript's `\s`.
// Contract strips: \t \n \v \f \r \x1c \x1d \x1e \x1f \x20 \x85 \xa0
// \u1680 \u2000-\u200a \u2028 \u2029 \u202f \u205f \u3000
// JS `\s` also matches \ufeff (NOT whitespace here) but does NOT
// match \x1c-\x1f or \x85. Using `.trim()` would therefore both strip
// characters the contract keeps and keep characters the contract strips,
// which is contract-visible on every text field in the API.
// 2. `round()` uses banker's rounding (round-half-to-even) on the exact binary
// value. Persona scaling computes
// `max(1, round(len(text) * intensity / 100))`; for `len=5, intensity=50`
// the contract yields 2 while `Math.round` yields 3, which changes the compiled
// persona and therefore the snapshot.
// String LENGTH and SLICING are also code-point based here, not UTF-16 code
// unit based. `[...text]` (via `toCodePoints`) restores those semantics.

/** Exactly the characters the contract treats as whitespace. */
const UNICODE_WHITESPACE =
  "\t\n\v\f\r\u001c\u001d\u001e\u001f \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

const STRIP_START = new RegExp(`^[${UNICODE_WHITESPACE}]+`);
const STRIP_END = new RegExp(`[${UNICODE_WHITESPACE}]+$`);

/** Strip with no argument, using the contract's whitespace set. */
export function unicodeStrip(value: string): string {
  return value.replace(STRIP_START, "").replace(STRIP_END, "");
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
 * on the exact binary value.
 */
export function halfEvenRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  // Exact tie: choose the even neighbour.
  return floor % 2 === 0 ? floor : floor + 1;
}

// Full casefold is exported from the generated table module. A
// hand-written subset is NOT enough: the same fold is used both by the context
// keyword extractor and by the suppression
// fingerprint `canonical()`. The latter keeps every
// Unicode letter/digit, so a partial map silently changes which memories are
// treated as duplicates of a blocked one (#96).
export {
  CASEFOLD_ENTRY_COUNT,
  CASEFOLD_UNICODE_VERSION,
  fullCasefold,
} from "./casefold-table";
