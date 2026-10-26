import { describe, expect, test } from "bun:test";
import {
  type InspectedContext,
  InspectedContextSchema,
  ModelResponseMetadataSchema,
  type ProtectedModelOutput,
  ProtectedModelOutputSchema,
} from "../../src/shared/contracts/agent-run";

test("model response metadata keeps raw, null and missing finish reasons distinct", () => {
  expect(
    ModelResponseMetadataSchema.parse({ transport: "complete", httpStatus: 200, finishReasons: [] })
      .finishReasons,
  ).toEqual([]);
  expect(
    ModelResponseMetadataSchema.parse({
      transport: "complete",
      httpStatus: 200,
      finishReasons: [null, "stop", "VENDOR_REASON"],
    }).finishReasons,
  ).toEqual([null, "stop", "VENDOR_REASON"]);
  expect(
    ModelResponseMetadataSchema.parse({
      transport: "stream",
      finishReasons: [],
      doneMarker: false,
    }),
  ).not.toHaveProperty("httpStatus");
  expect(
    ModelResponseMetadataSchema.safeParse({ transport: "stream", finishReasons: [123] }).success,
  ).toBe(false);
  expect(
    ModelResponseMetadataSchema.safeParse({
      transport: "complete",
      finishReasons: [],
      message: "not metadata",
    }).success,
  ).toBe(false);
});

test("old protected outputs stay valid without fabricated response metadata", () => {
  const old: ProtectedModelOutput = { text: "old body", format: "text", complete: true };
  expect(ProtectedModelOutputSchema.parse(old)).toEqual(old);
  const metadataOnly: ProtectedModelOutput = {
    text: "",
    format: "json",
    complete: false,
    hasText: false,
    responses: [{ transport: "complete", httpStatus: 200, finishReasons: ["content_filter"] }],
  };
  expect(ProtectedModelOutputSchema.parse(metadataOnly)).toEqual(metadataOnly);
  const context: InspectedContext = {
    status: "exact",
    layout: [],
    sourceVersions: [],
    result: { status: "unavailable", reason: "no_response", responses: metadataOnly.responses },
  };
  expect(InspectedContextSchema.parse(context)).toEqual(context);
});

// Optional usage metadata contract: counters are independently optional,
// every valid provider-reported value is preserved on its own, nothing is
// derived (totalTokens is never summed from the others), explicit 0 is a
// reported value, and cacheState is reported/unreported/invalid. Acceptance
// Acceptance cases verify parsed fields; rejection cases reject malformed payloads.
describe("optional usage metadata contract (schema-direct)", () => {
  const base = { transport: "complete" as const, finishReasons: ["stop"] };

  test("accepts a full valid usage object and preserves every field", () => {
    expect(
      ModelResponseMetadataSchema.parse({
        ...base,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cacheReadInputTokens: 80,
          cacheState: "reported",
        },
      }),
    ).toEqual({
      ...base,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cacheReadInputTokens: 80,
        cacheState: "reported",
      },
    });
  });

  test("accepts partial usage: a real cached=80 survives without totals", () => {
    const parsed = ModelResponseMetadataSchema.parse({
      ...base,
      usage: { cacheReadInputTokens: 80, cacheState: "reported" },
    });
    expect((parsed as { usage?: unknown }).usage).toEqual({
      cacheReadInputTokens: 80,
      cacheState: "reported",
    });
  });

  test("explicit zero counters are reported, not rewritten to missing", () => {
    const parsed = ModelResponseMetadataSchema.parse({
      ...base,
      usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheState: "reported" },
    });
    expect((parsed as { usage?: unknown }).usage).toEqual({
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheState: "reported",
    });
  });

  test("rejects malformed numeric usage fields (negative, fractional, unsafe)", () => {
    for (const bad of [-1, 1.5, "12", Number.NaN, 2 ** 53]) {
      expect(
        ModelResponseMetadataSchema.safeParse({
          ...base,
          usage: { inputTokens: bad, cacheState: "reported" },
        }).success,
      ).toBe(false);
      expect(
        ModelResponseMetadataSchema.safeParse({
          ...base,
          usage: { cacheReadInputTokens: bad, cacheState: "reported" },
        }).success,
      ).toBe(false);
    }
  });

  test("rejects an unknown cacheState value", () => {
    expect(
      ModelResponseMetadataSchema.safeParse({
        ...base,
        usage: { inputTokens: 5, cacheState: "assumed" },
      }).success,
    ).toBe(false);
  });

  test("old metadata without usage stays valid and strict", () => {
    expect(ModelResponseMetadataSchema.parse(base)).toEqual(base);
    expect(ModelResponseMetadataSchema.safeParse({ ...base, note: "extra" }).success).toBe(false);
  });
});
