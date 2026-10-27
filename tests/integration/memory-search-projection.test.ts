import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { correctMemory, memoryContent } from "../../src/server/db/memory-content-repository";
import {
  claim,
  enqueue,
  entries,
  govern,
  publish,
  rebuildMemorySearchProjection,
} from "../../src/server/db/memory-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  ensureDefaults,
  getTurnByRequest,
  immediate,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  MEMORY_SEARCH_FOLD_VERSION,
  memorySearchProjection,
} from "../../src/server/services/memory-contract";

const MODEL = "synthetic";

describe("memory folded search projection", () => {
  it("folds Unicode and retains independent field boundaries", () => {
    const projected = memorySearchProjection({
      id: "ID",
      name: "Straße",
      summary: "ΟΣ",
      tags: '["İ"]',
      body: "🪴尾",
    });
    const fields = JSON.parse(projected) as string[];
    expect(fields).toEqual(["id", "strasse", "οσ", '["i̇"]', "🪴尾"]);
    expect(fields.some((field) => field.includes("sseο"))).toBe(false);
    expect(MEMORY_SEARCH_FOLD_VERSION).toBe(1);
  });

  it("recomputes on real publish, immutable correction and merge, and purges with its row", () => {
    const business = openBusinessDb();
    const { orm, db } = business;
    try {
      ensureDefaults(orm, MODEL);
      const sessionId = createSession(orm, "synthetic", { modelName: MODEL }).id;
      const prepared = prepareTurn(orm, sessionId, "question", "source");
      if (!prepared.generationToken) throw new Error("missing generation token");
      saveCompletedAssistantMessage(orm, sessionId, "answer", "source", prepared.generationToken);
      const turn = getTurnByRequest(orm, sessionId, "source");
      if (!turn) throw new Error("missing turn");
      const job = immediate(db, () =>
        enqueue(orm, DEFAULT_AGENT_ID, "publish", {
          kind: "manual",
          sessionId,
          turnIds: [turn.id],
        }),
      );
      const running = immediate(db, () => claim(orm, job.id));
      if (!running?.token) throw new Error("job was not claimed");
      const token = running.token;
      immediate(db, () =>
        publish(orm, DEFAULT_AGENT_ID, job.id, token, {
          name: "Straße",
          summary: "OLD",
          tags: ["İ"],
          kinds: ["semantic"],
          body: "OLD body",
        }),
      );
      const original = entries(orm, DEFAULT_AGENT_ID)[0];
      if (!original) throw new Error("publication missing");
      expect(original.foldVersion).toBe(MEMORY_SEARCH_FOLD_VERSION);
      expect(original.foldedSearch).toBe(memorySearchProjection(original));
      orm
        .update(schema.memoryEntries)
        .set({ foldedSearch: null, foldVersion: null })
        .where(eq(schema.memoryEntries.id, original.id))
        .run();
      let checks = 0;
      const lateAbort = {
        throwIfAborted: () => {
          if (++checks === 3) throw new Error("cancel after write");
        },
      } as AbortSignal;
      expect(() =>
        immediate(db, () =>
          rebuildMemorySearchProjection(orm, DEFAULT_AGENT_ID, { limit: 1, signal: lateAbort }),
        ),
      ).toThrow();
      expect(entries(orm, DEFAULT_AGENT_ID, [original.id])[0]?.foldedSearch).toBeNull();
      const abort = new AbortController();
      abort.abort();
      expect(() =>
        immediate(db, () =>
          rebuildMemorySearchProjection(orm, DEFAULT_AGENT_ID, { limit: 1, signal: abort.signal }),
        ),
      ).toThrow();
      expect(
        immediate(db, () => rebuildMemorySearchProjection(orm, DEFAULT_AGENT_ID, { limit: 1 }))
          .rebuilt,
      ).toBe(1);
      const fixed = immediate(db, () =>
        correctMemory(orm, DEFAULT_AGENT_ID, original.id, {
          expected_revision: memoryContent(orm, DEFAULT_AGENT_ID, original.id).content.revision,
          name: "FRESH",
          summary: "new",
          tags: ["新"],
          body: "new body",
        }),
      );
      const corrected = entries(orm, DEFAULT_AGENT_ID, [fixed.content.id])[0];
      if (!corrected) throw new Error("correction missing");
      expect(corrected.foldVersion).toBe(MEMORY_SEARCH_FOLD_VERSION);
      expect(corrected.foldedSearch).toBe(memorySearchProjection(corrected));
      expect(corrected.foldedSearch).not.toContain("old body");
      const merge = immediate(db, () =>
        enqueue(orm, DEFAULT_AGENT_ID, "merge", { kind: "merge", memoryIds: [corrected.id] }),
      );
      const claimed = immediate(db, () => claim(orm, merge.id));
      if (!claimed?.token) throw new Error("merge was not claimed");
      const mergeToken = claimed.token;
      immediate(db, () =>
        publish(orm, DEFAULT_AGENT_ID, merge.id, mergeToken, {
          name: "MERGED",
          summary: "final",
          tags: [],
          kinds: ["semantic"],
          body: "merged body",
        }),
      );
      const merged = entries(orm, DEFAULT_AGENT_ID, undefined, { status: "active" }).find(
        (item) => item.name === "MERGED",
      );
      if (!merged) throw new Error("merge publication missing");
      expect(merged.foldVersion).toBe(MEMORY_SEARCH_FOLD_VERSION);
      expect(merged.foldedSearch).toBe(memorySearchProjection(merged));
      immediate(db, () => govern(orm, DEFAULT_AGENT_ID, [merged.id], "purge"));
      expect(entries(orm, DEFAULT_AGENT_ID).some((item) => item.id === merged.id)).toBe(false);
    } finally {
      business.close();
    }
  });
});
