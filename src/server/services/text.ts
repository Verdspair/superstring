// Python-compatible string / number primitives.
//
// The replica must reproduce the SOURCE project's observable behaviour, and the
// source is Python. Two primitives differ from their JavaScript counterparts in
// ways that change output:
//
//  1. `str.strip()` / `str.isspace()` — Python's whitespace set is NOT the same
//     as JavaScript's `\s`:
//       Python strips:  \t \n \v \f \r \x1c \x1d \x1e \x1f \x20 \x85 \xa0
//                       \u1680 \u2000-\u200a \u2028 \u2029 \u202f \u205f \u3000
//       JS `\s` also matches \ufeff (NOT whitespace in Python) but does NOT
//       match \x1c-\x1f or \x85. Using `.trim()` would therefore both strip
//       characters Python keeps and keep characters Python strips.
//       Every text field in the API goes through `.strip()` (api/schemas.py:21-25,
//       services/agent_config.py:60-86), so this is contract-visible.
//
//  2. `round()` uses banker's rounding (round-half-to-even) on the exact binary
//     value. `_scale_character_text` (services/agent_config.py:128) computes
//     `max(1, round(len(text) * intensity / 100))`; for `len=5, intensity=50`
//     Python yields 2 while `Math.round` yields 3, which changes the compiled
//     persona and therefore the snapshot.
//
// String LENGTH and SLICING are also code-point based in Python but UTF-16 code
// unit based in JS. `[...text]` (via `toCodePoints`) restores Python semantics.

/** Exactly the characters Python's `str.isspace()` reports as True. */
const PY_WHITESPACE =
  "\t\n\v\f\r\u001c\u001d\u001e\u001f \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

const PY_STRIP_START = new RegExp(`^[${PY_WHITESPACE}]+`);
const PY_STRIP_END = new RegExp(`[${PY_WHITESPACE}]+$`);

/** Python `str.strip()` with no argument. */
export function pyStrip(value: string): string {
  return value.replace(PY_STRIP_START, "").replace(PY_STRIP_END, "");
}

/** Python `len(str)` — counts code points, not UTF-16 code units. */
export function pyLen(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

/** Python `str[:n]` — slices by code point. */
export function pySlice(value: string, end: number): string {
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
 * Python `round(x)` for non-negative finite x: nearest, ties to even, evaluated
 * on the exact binary value (which is what Python does).
 */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  // Exact tie: choose the even neighbour.
  return floor % 2 === 0 ? floor : floor + 1;
}

// Python `str.casefold()` is exported from the generated table module. A
// hand-written subset is NOT enough: the same fold is used both by the context
// keyword extractor (context_builder.py:72-77) and by the suppression
// fingerprint `canonical()` (memory_contract.py:114-115). The latter keeps every
// Unicode letter/digit, so a partial map silently changes which memories are
// treated as duplicates of a blocked one (#96).
export {
  CASEFOLD_ENTRY_COUNT,
  CASEFOLD_UNICODE_VERSION,
  pythonCasefold,
} from "./casefold-table";
