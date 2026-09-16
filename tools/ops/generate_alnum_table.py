#!/usr/bin/env python
"""Freeze CPython's `str.isalnum()` code points into a TypeScript table.

Why this exists
---------------
`canonical()` in the source project is

    "".join(c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum())
    # services/memory_contract.py:114-115

The replica must reproduce that filter exactly, because `canonical()` decides
whether a new draft duplicates a blocked memory — a different set of retained
characters changes the number of suppression model calls and can publish a
memory the source project drops.

The obvious JS translation is `/[^\\p{L}\\p{N}]/gu`, but that is NOT the same set:
`\\p{L}\\p{N}` comes from the JavaScript engine's Unicode version, which is not
pinned and does not match CPython's. Measured on the development host:

    CPython 3.12.11  (Unicode 15.0.0)  isalnum()  137935 code points / 747 ranges
    Node 22.22.2     \\p{L}\\p{N}                  9661 EXTRA code points, none missing

i.e. the regex is a strict superset, so the replica would keep characters — e.g.
U+088F, U+1C89, newly assigned scripts added after Unicode 15.0.0 — that the
source project strips. Deriving the set from the runtime is therefore not
faithful; it has to be frozen here.

This is a DEVELOPMENT-ONLY tool. It reads the pinned interpreter and writes one
generated module. It is never part of the build, the runtime, or the tests.

Usage
-----
    python tools/ops/generate_alnum_table.py \\
        --python python3.12 \\
        --out src/server/services/alnum-table.ts
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import unicodedata  # noqa: F401  (documented above; the probe re-imports it)
from pathlib import Path

PROBE = (
    "import json,sys,unicodedata\n"
    "out=[cp for cp in range(0x110000) if chr(cp).isalnum()]\n"
    "ranges=[];start=prev=None\n"
    "for cp in out:\n"
    "    if start is None:\n"
    "        start=prev=cp;continue\n"
    "    if cp==prev+1:\n"
    "        prev=cp;continue\n"
    "    ranges.append((start,prev));start=prev=cp\n"
    "if start is not None: ranges.append((start,prev))\n"
    "print(json.dumps({'python':sys.version.split()[0],"
    "'unidata':unicodedata.unidata_version,'count':len(out),'ranges':ranges}))\n"
)

HEADER = """// CPython `str.isalnum()` code points — GENERATED, DO NOT EDIT BY HAND.
//
// Regenerate with tools/ops/generate_alnum_table.py whenever the pinned CPython
// / Unicode version changes.
//
// WHY THIS FILE EXISTS
//   `canonical()` in the source project filters with `c.isalnum()`
//   (services/memory_contract.py:114-115), and that filter decides whether a
//   draft counts as a duplicate of a blocked memory.
//
//   Character classes like \\p{L}\\p{N} are NOT equivalent: they follow the
//   JavaScript engine's Unicode version, which is newer than the pinned
//   CPython's and is a strict superset. Keeping the extra code points would make
//   the replica call the suppression model where the source project
//   short-circuits, and in the worst case publish a memory the source drops.
//
//   So the set is frozen here and `isPythonAlnum()` binary-searches it. The
//   result does not depend on the host engine's Unicode tables at all.
//
// Generated from: CPython __PYTHON__
//   Unicode data version: __UNIDATA__
//   code points: __COUNT__   ranges: __RANGES__
"""

BODY = """
/**
 * Encoded as `START-END` hex ranges, comma separated. A range whose start and
 * end are equal is written as a single value.
 */
const ENCODED_RANGES = `
__ENCODED__
`;

type Range = readonly [start: number, end: number];

let decoded: Range[] | null = null;

function table(): Range[] {
  if (decoded) return decoded;
  const ranges: Range[] = [];
  for (const token of ENCODED_RANGES.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const dash = trimmed.indexOf("-");
    if (dash === -1) {
      const only = Number.parseInt(trimmed, 16);
      ranges.push([only, only]);
      continue;
    }
    ranges.push([
      Number.parseInt(trimmed.slice(0, dash), 16),
      Number.parseInt(trimmed.slice(dash + 1), 16),
    ]);
  }
  ranges.sort((left, right) => left[0] - right[0]);
  decoded = ranges;
  return ranges;
}

/** CPython `str.isalnum()` for a single code point. */
export function isPythonAlnum(codePoint: number): boolean {
  const ranges = table();
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = ranges[mid];
    if (codePoint < start) {
      high = mid - 1;
    } else if (codePoint > end) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/** Number of frozen ranges — the drift guard in the tests reads this. */
export const PYTHON_ALNUM_RANGE_COUNT = __RANGES__;

/** Number of code points the frozen table accepts. */
export const PYTHON_ALNUM_CODE_POINT_COUNT = __COUNT__;
"""


def measure(python: str) -> tuple[str, str, int, list[tuple[int, int]]]:
    completed = subprocess.run([python, "-c", PROBE], capture_output=True, text=True, check=True)
    data = json.loads(completed.stdout.strip().splitlines()[-1])
    ranges = [(int(a), int(b)) for a, b in data["ranges"]]
    return str(data["python"]), str(data["unidata"]), int(data["count"]), ranges


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="the interpreter the replica is pinned to (read-only)",
    )
    parser.add_argument(
        "--out",
        default="src/server/services/alnum-table.ts",
        help="where to write the generated module",
    )
    args = parser.parse_args()

    python_version, unidata, count, ranges = measure(args.python)

    # One line per eight ranges keeps the diff readable when Unicode moves;
    # it costs nothing at runtime.
    encoded_lines = []
    for index in range(0, len(ranges), 8):
        chunk = ",".join(f"{start:X}-{end:X}" for start, end in ranges[index : index + 8])
        encoded_lines.append(f"  {chunk},")
    encoded = "\n".join(encoded_lines)

    header = (
        HEADER.replace("__PYTHON__", python_version)
        .replace("__UNIDATA__", unidata)
        .replace("__COUNT__", str(count))
        .replace("__RANGES__", str(len(ranges)))
    )
    body = (
        BODY.replace("__ENCODED__", encoded)
        .replace("__RANGES__", str(len(ranges)))
        .replace("__COUNT__", str(count))
    )

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = Path(__file__).resolve().parents[2] / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Pin the newline: without it Windows translates "\n" to "\r\n" and a
    # regeneration produces a whole-file diff that hides the real change.
    # (`generate_casefold_table.py` already passes newline="\n".)
    out_path.write_text(header + body, encoding="utf-8", newline="\n")

    print(
        f"wrote {out_path} — {len(ranges)} ranges, {count} code points "
        f"(CPython {python_version}, Unicode {unidata})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
