import { describe, expect, test } from "bun:test";
import {
  type KnowledgeDocument,
  KnowledgeDocumentCursorSchema,
  KnowledgeDocumentsPageSchema,
  KnowledgeDocumentsQuerySchema as Query,
} from "../../src/shared/contracts/knowledge";

const documentId = "11111111-1111-4111-8111-111111111111";
const readable: KnowledgeDocument = {
  id: documentId,
  category_id: "default",
  name: "资料",
  import_type: "text",
  content_mode: "original",
  content_version: 1,
  revision: 1,
  created_at: "2026-09-30T00:00:00.000000Z",
  updated_at: "2026-09-30T00:00:00.000000Z",
  agent_ids: [],
  summary: "",
  tags: [],
  organization_status: "queued",
  error_code: null,
};

describe("knowledge document list query contract", () => {
  test("defaults limit to 50 and keeps all/absence as explicit no-filter values", () => {
    expect(Query.parse({})).toEqual({ limit: 50 });
    expect(Query.parse({ search: "", category: "all", status: "all" })).toEqual({
      search: "",
      category: "all",
      status: "all",
      limit: 50,
    });
    expect(Query.parse({ limit: "50" }).limit).toBe(50);
  });

  test("accepts every organization status plus string limits inside 1..100", () => {
    for (const status of [
      "pending",
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "disabled",
    ] as const) {
      expect(Query.parse({ status }).status).toBe(status);
    }
    expect(Query.parse({ limit: "1" }).limit).toBe(1);
    expect(Query.parse({ limit: "100" }).limit).toBe(100);
    expect(Query.parse({ category: "default" }).category).toBe("default");
    expect(Query.parse({ category: documentId }).category).toBe(documentId);
    expect(Query.parse({ search: "a".repeat(200) }).search).toHaveLength(200);
    expect(Query.parse({ cursor: "a".repeat(200) }).cursor).toHaveLength(200);
  });

  test("rejects out-of-range limits, unknown filters and unknown keys", () => {
    for (const limit of ["0", "101", "-1", "1.5", "abc", ""]) {
      expect(Query.safeParse({ limit }).success).toBe(false);
    }
    expect(Query.safeParse({ status: "failed-ish" }).success).toBe(false);
    expect(Query.safeParse({ status: "" }).success).toBe(false);
    expect(Query.safeParse({ category: "not-a-category" }).success).toBe(false);
    expect(Query.safeParse({ category: "" }).success).toBe(false);
    expect(Query.safeParse({ search: "a".repeat(201) }).success).toBe(false);
    expect(Query.safeParse({ cursor: "a".repeat(201) }).success).toBe(false);
    expect(Query.safeParse({ unknown: "1" }).success).toBe(false);
  });

  test("cursor payload is strict and canonicalises UUID spellings", () => {
    const created_at = "2026-09-30T00:00:00.000000Z";
    expect(
      KnowledgeDocumentCursorSchema.parse({ created_at, id: documentId.toUpperCase() }),
    ).toEqual({ created_at, id: documentId });
    expect(KnowledgeDocumentCursorSchema.safeParse({}).success).toBe(false);
    expect(KnowledgeDocumentCursorSchema.safeParse({ created_at: "" }).success).toBe(false);
    expect(KnowledgeDocumentCursorSchema.safeParse({ created_at, id: "not-a-uuid" }).success).toBe(
      false,
    );
    expect(
      KnowledgeDocumentCursorSchema.safeParse({ created_at, id: documentId, extra: 1 }).success,
    ).toBe(false);
    expect(
      KnowledgeDocumentCursorSchema.safeParse({ created_at: "a".repeat(65), id: documentId })
        .success,
    ).toBe(false);
  });

  test("page shape carries strict items, opaque cursor and filtered total", () => {
    expect(
      KnowledgeDocumentsPageSchema.parse({ items: [readable], next_cursor: null, total: 1 }),
    ).toEqual({ items: [readable], next_cursor: null, total: 1 });
    expect(
      KnowledgeDocumentsPageSchema.parse({ items: [], next_cursor: "opaque", total: 0 }),
    ).toEqual({ items: [], next_cursor: "opaque", total: 0 });
    for (const page of [
      { items: [], next_cursor: null, total: -1 },
      { items: [], next_cursor: null, total: 1.5 },
      { items: [], next_cursor: 5, total: 0 },
      { items: [], total: 0 },
      { items: [], next_cursor: null, total: 0, extra: 1 },
      { items: [{ ...readable, organization_status: "unknown" }], next_cursor: null, total: 1 },
    ]) {
      expect(KnowledgeDocumentsPageSchema.safeParse(page).success).toBe(false);
    }
  });
});
