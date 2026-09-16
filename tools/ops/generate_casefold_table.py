"""Regenerate `src/server/services/casefold-table.ts` from CPython's real casefold data.

WHY THIS EXISTS
    `canonical()` in the source project is

        "".join(c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum())

    and the context keyword extractor also calls `str.casefold()`
    (services/context_builder.py:72-77,453-455).

    JavaScript only exposes `toLowerCase()`, which is NOT the same operation
    (`"\u03c2".casefold() == "\u03c3"` but `"\u03c2".toLowerCase() == "\u03c2"`).
    The replica therefore ships a frozen table of every code point where
    CPython's `casefold()` differs from `lower()`, including one-to-many folds.

USAGE
    python tools/ops/generate_casefold_table.py

    Run this whenever the pinned CPython / Unicode version changes, then re-run
    `node tools/verify/verify-all.mjs`. The drift test in
    `tests/integration/memory-worker.test.ts` pins the observable behaviour.

    The runtime NEVER calls Python: the table is baked into the generated TS
    module so a casefold difference can never be introduced silently by a host
    JS engine upgrade.
"""

import os
import sys
import unicodedata

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(REPO_ROOT, "src", "server", "services", "casefold-table.ts")


def collect() -> list[tuple[int, str]]:
    pairs: list[tuple[int, str]] = []
    for cp in range(0x110000):
        char = chr(cp)
        try:
            folded = char.casefold()
        except Exception:
            continue
        if folded != char.lower():
            pairs.append((cp, folded))
    return pairs


def render(pairs: list[tuple[int, str]]) -> str:
    encoded = ";".join(
        "%X:%s" % (cp, ",".join("%X" % ord(ch) for ch in folded)) for cp, folded in pairs
    )
    python_version = sys.version.split()[0]
    unicode_version = unicodedata.unidata_version
    max_cp = max(cp for cp, _ in pairs)

    header = f'''// Python-compatible Unicode casefold — GENERATED, DO NOT EDIT BY HAND.
//
// Regenerate with tools/ops/generate_casefold_table.py whenever the pinned
// CPython / Unicode version changes.
//
// WHY THIS FILE EXISTS
//   `canonical()` in the source project is
//     "".join(c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum())
//   (services/memory_contract.py:114-115) and the context keyword extractor also
//   calls `str.casefold()` (services/context_builder.py:72-77,453-455).
//   JavaScript only exposes `toLowerCase()`, which is NOT the same operation:
//     "\\u03c2".casefold() === "\\u03c3"   but   "\\u03c2".toLowerCase() === "\\u03c2"
//   Using `toLowerCase()` therefore produces different suppression
//   fingerprints and can publish a memory the source project would drop.
//
//   The table below stores every code point where CPython's casefold differs
//   from lower(), including one-to-many folds (e.g. "\\u00df" -> "ss").
//
// Generated from: CPython {python_version}
//   Unicode data version: {unicode_version}
//   entries: {len(pairs)}   (max code point U+{max_cp:X})
'''

    footer = f'''
let decoded: Map<number, string> | null = null;

function table(): Map<number, string> {{
  if (decoded) return decoded;
  const map = new Map<number, string>();
  for (const entry of ENCODED_FOLD.split(";")) {{
    const separator = entry.indexOf(":");
    const cp = Number.parseInt(entry.slice(0, separator), 16);
    const folded = entry
      .slice(separator + 1)
      .split(",")
      .map((hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .join("");
    map.set(cp, folded);
  }}
  decoded = map;
  return map;
}}

/**
 * Python `str.casefold()` for a single code point.
 *
 * Code points absent from the table fold exactly like `toLowerCase()`, which is
 * how CPython behaves for the other ~1.1M code points.
 */
export function caseFoldCodePoint(codePoint: number): string {{
  const tableHit = table().get(codePoint);
  if (tableHit !== undefined) return tableHit;
  return String.fromCodePoint(codePoint).toLowerCase();
}}

/** Python `str.casefold()` for a whole string (code-point iteration, not UTF-16). */
export function pythonCasefold(text: string): string {{
  let out = "";
  for (const char of text) out += caseFoldCodePoint(char.codePointAt(0) as number);
  return out;
}}

/** Number of frozen fold entries — used by the drift test. */
export const CASEFOLD_ENTRY_COUNT = {len(pairs)};

/** Unicode data version the table was generated from. */
export const CASEFOLD_UNICODE_VERSION = "{unicode_version}";
'''

    body = header + '\nconst ENCODED_FOLD =\n  "' + encoded + '";\n' + footer
    return body


def main() -> None:
    pairs = collect()
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(render(pairs))
    print(
        "wrote %s (%d entries, Unicode %s)" % (OUT, len(pairs), unicodedata.unidata_version)
    )


if __name__ == "__main__":
    main()
