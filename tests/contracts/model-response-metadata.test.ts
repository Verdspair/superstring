import { expect, test } from "bun:test";
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
