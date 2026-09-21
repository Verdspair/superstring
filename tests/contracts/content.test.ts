import { describe, expect, it } from "bun:test";
import { contentBlocks } from "../../src/server/services/content-format";
import {
  ContentItemSchema,
  ContentSourceSchema,
  MemoryCorrectionSchema,
} from "../../src/shared/contracts";

const id = "11111111-1111-4111-8111-111111111111";
const catalog = {
  id,
  source_type: "knowledge",
  content_origin: "original",
  name: "资料",
  summary: "简介",
  tags: [],
  revision: "1",
  sources: [{ type: "document", document_id: id, version: 1, start: 0, end: 3, valid: true }],
  validity: "valid",
};

describe("shared content contract", () => {
  it("distinguishes a catalog from a loaded body", () => {
    expect(ContentItemSchema.parse(catalog).body).toBeUndefined();
    expect(ContentItemSchema.parse({ ...catalog, body: "正文" }).body).toBe("正文");
  });
  it("rejects unknown fields and invalid original-source intervals", () => {
    expect(ContentItemSchema.safeParse({ ...catalog, executable: true }).success).toBe(false);
    expect(ContentSourceSchema.safeParse({ ...catalog.sources[0], end: -1 }).success).toBe(false);
    expect(ContentSourceSchema.safeParse({ ...catalog.sources[0], start: 4 }).success).toBe(false);
  });
  it("accepts paired draft ranges and rejects incomplete or empty mappings", () => {
    const source = catalog.sources[0];
    expect(ContentSourceSchema.safeParse({ ...source, draft_start: 0, draft_end: 2 }).success).toBe(
      true,
    );
    for (const range of [
      { draft_start: 0 },
      { draft_end: 2 },
      { draft_start: 1, draft_end: 1 },
      { draft_start: 2, draft_end: 1 },
    ]) {
      expect(ContentSourceSchema.safeParse({ ...source, ...range }).success).toBe(false);
    }
  });
  it("projects only necessary content and provenance to the model", () => {
    const blocks = contentBlocks([ContentItemSchema.parse({ ...catalog, body: "只作为资料" })]);
    expect(blocks[0]).toEqual({
      id,
      source_type: "knowledge",
      content_origin: "original",
      body: "只作为资料",
      sources: [{ type: "document", document_id: id, version: 1, start: 0, end: 3 }],
    });
    expect(JSON.stringify(blocks)).not.toContain("revision");
  });
  it("requires a revision and refuses whitespace corrections", () => {
    const input = {
      expected_revision: "a".repeat(64),
      name: "name",
      summary: "summary",
      tags: [],
      body: "body",
    };
    expect(MemoryCorrectionSchema.safeParse(input).success).toBe(true);
    expect(MemoryCorrectionSchema.safeParse({ ...input, expected_revision: "" }).success).toBe(
      false,
    );
    expect(MemoryCorrectionSchema.safeParse({ ...input, body: "\n " }).success).toBe(false);
  });
});
