import { describe, expect, it } from "bun:test";
import {
  MemoryReadablePageSchema,
  MemorySourcePreviewListSchema,
  MemorySourcePreviewPageSchema,
  MemoryVisibilityUpdateSchema,
} from "../../src/shared/contracts/memory";

const id = "11111111-1111-4111-8111-111111111111";
describe("readonly memory and source preview DTO", () => {
  it("does not expose owner snapshots or raw references in recipient derived pages", () => {
    const page = {
      id,
      owner_agent_id: id,
      reader_agent_id: id,
      conversation_id: id,
      name: "name",
      summary: "summary",
      tags: [],
      content_origin: "derived",
      revision: "revision",
      text: "text 🦄",
      offset: 0,
      total: 6,
      nextOffset: null,
    };
    expect(MemoryReadablePageSchema.safeParse(page).success).toBe(true);
    expect(
      MemoryReadablePageSchema.safeParse({ ...page, config_snapshot: { prompt: "private" } })
        .success,
    ).toBe(false);
    expect(
      MemoryReadablePageSchema.safeParse({ ...page, sources: [{ kind: "web_turn", id }] }).success,
    ).toBe(false);
  });
  it("represents denied sources without locators or identities and distinguishes valid empty text", () => {
    const sources = {
      memory_id: id,
      entry_revision: "entry",
      source_validity: "valid",
      raw_preview: "unavailable",
      checked_sources: 1,
      total: 1,
      nextOffset: null,
      items: [
        {
          source_key: null,
          channel: "unknown",
          state: "unavailable",
          reason: "forbidden",
          conversation_id: null,
          revision: null,
          expires_at: null,
          participant: null,
          occurred_at: null,
        },
      ],
    };
    expect(MemorySourcePreviewListSchema.safeParse(sources).success).toBe(true);
    expect(
      MemorySourcePreviewPageSchema.safeParse({
        memory_id: id,
        source_key: "locator",
        conversation_id: id,
        revision: "body",
        expires_at: null,
        content_origin: "original",
        corrected: false,
        text: "",
        offset: 0,
        total: 0,
        nextOffset: null,
      }).success,
    ).toBe(true);
  });
  it("accepts only the explicit typed revalidation flag on the existing visibility request", () => {
    const body = { expected_revision: 1, visibility: "public", recipient_agent_ids: [id] };
    expect(MemoryVisibilityUpdateSchema.parse(body).revalidate_publication).toBeUndefined();
    expect(
      MemoryVisibilityUpdateSchema.parse({ ...body, revalidate_publication: true })
        .revalidate_publication,
    ).toBe(true);
    expect(
      MemoryVisibilityUpdateSchema.safeParse({ ...body, revalidate_publication: "true" }).success,
    ).toBe(false);
    expect(
      MemoryVisibilityUpdateSchema.safeParse({
        ...body,
        revalidate_publication: true,
        manifest: "private",
      }).success,
    ).toBe(false);
  });
});
