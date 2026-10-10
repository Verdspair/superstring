import { describe, expect, it } from "bun:test";
import { normalizeOneBotAccountId as normalizeFromServer } from "../../src/server/services/onebot-protocol";
import {
  normalizeOneBotAccountId,
  OneBotAccountIdSchema,
  OneBotWireIdSchema,
} from "../../src/shared/contracts/onebot-identity";

/**
 * Boundary cases for the wire-id grammar, extracted verbatim from
 * onebot-protocol.ts. The contract test pins the EXISTING behaviour —
 * including quirks (e.g. "1e4" is rejected, boolean true becomes "1",
 * an integer-valued float 12.0 passes) — instead of inventing a
 * "safer" grammar. If a case here changes, that is a wire-behaviour
 * change and needs its own approved decision.
 */
const WIRE_ID_CASES: Array<[unknown, string | null]> = [
  // numbers: integers pass, everything else follows the original grammar
  [0, "0"],
  [-0, "0"], // String(-0) === "0"
  [12, "12"],
  [-12, "-12"],
  [12.0, "12"], // float that is an integer value passes z.number().int()
  [1.2, null],
  [Number.NaN, null],
  [Number.POSITIVE_INFINITY, null],
  [Number.NEGATIVE_INFINITY, null],
  [Number.MAX_SAFE_INTEGER + 1, null], // z.number().int() rejects unsafe magnitudes
  ["012", "12"],
  ["-00", "0"],
  // strings: optional leading -, digits only, leading zeros stripped
  ["0", "0"],
  ["-0", "0"], // negative zero string canonicalises to "0"
  ["-01", "-1"],
  ["010001", "10001"],
  ["-00012", "-12"],
  ["9007199254740993", "9007199254740993"], // big ids stay exact as strings
  ["-9007199254740993", "-9007199254740993"],
  ["", null],
  [" ", null], // whitespace is not trimmed away
  [" 10001", null],
  ["1e4", null],
  ["+1", null],
  ["1.0", null],
  ["--1", null],
  ["1-2", null],
  // other types: zod v4 does NOT coerce — booleans/objects/arrays all reject
  [true, null],
  [false, null],
  [null, null],
  [undefined, null],
  [["1"], null],
  [{}, null],
];

const ACCOUNT_CASES: Array<[unknown, string | null]> = [
  ["10001", "10001"],
  ["010001", "10001"],
  [10001, "10001"],
  ["0", null],
  [0, null],
  ["-0", null],
  ["-1", null],
  [-1, null],
  ["001", "1"],
];

describe("OneBot shared identity contract (extracted grammar)", () => {
  it("keeps the exact wire-id canonicalisation for every pinned boundary", () => {
    for (const [input, expected] of WIRE_ID_CASES) {
      const parsed = OneBotWireIdSchema.safeParse(input);
      expect(parsed.success).toBe(expected !== null);
      if (expected !== null && parsed.success) expect(parsed.data).toBe(expected);
      expect(normalizeOneBotAccountId(input)).toBe(
        // the function form additionally requires a strictly positive id
        expected !== null && OneBotAccountIdSchema.safeParse(input).success ? expected : null,
      );
    }
  });

  it("keeps the exact account rule: strictly positive, canonical form", () => {
    for (const [input, expected] of ACCOUNT_CASES) {
      const parsed = OneBotAccountIdSchema.safeParse(input);
      expect(parsed.success).toBe(expected !== null);
      if (expected !== null && parsed.success) expect(parsed.data).toBe(expected);
      expect(normalizeOneBotAccountId(input)).toBe(expected);
    }
  });

  it("allows negative and zero platform message ids, positive accounts only", () => {
    // message ids: negative and 0 are valid wire ids
    expect(OneBotWireIdSchema.parse(-42)).toBe("-42");
    expect(OneBotWireIdSchema.parse(0)).toBe("0");
    expect(OneBotWireIdSchema.parse("-00042")).toBe("-42");
    // accounts: the same values are rejected
    expect(OneBotAccountIdSchema.safeParse(-42).success).toBe(false);
    expect(OneBotAccountIdSchema.safeParse(0).success).toBe(false);
  });

  it("keeps server re-export and shared contract as one and the same function", () => {
    // The server module re-exports the shared function, so both import paths
    // must be literally the same binding — not two implementations to keep in step.
    expect(normalizeFromServer).toBe(normalizeOneBotAccountId);
  });

  it("normalises a real OneBot observation field through the shared schema", () => {
    // Representative wire values from the golden integration fixture:
    // self_id/group ids arrive as numbers or zero-padded strings and must
    // canonicalise identically; the message id may be negative.
    const event = {
      time: 123,
      self_id: "010001",
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: -12,
      user_id: 20002,
      group_id: "030003",
      message: [{ type: "text", data: { text: "你好" } }],
    };
    expect(OneBotAccountIdSchema.parse(event.self_id)).toBe("10001");
    expect(OneBotAccountIdSchema.parse(event.group_id)).toBe("30003");
    expect(OneBotAccountIdSchema.parse(event.user_id)).toBe("20002");
    expect(OneBotWireIdSchema.parse(event.message_id)).toBe("-12");
  });
});
