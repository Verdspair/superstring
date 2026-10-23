import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  catalogByScopeKeys,
  memoryBodiesByScopeKeys,
  memoryFingerprintByScopeKeys,
  scanMemoryCandidates,
} from "../../src/server/db/context-repository";
import { correctMemory, memoryContent } from "../../src/server/db/memory-content-repository";
import { entries, policy } from "../../src/server/db/memory-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import * as casefold from "../../src/server/services/casefold-table";
import { AGENT_LEVEL_SCOPE_KEY } from "../../src/server/services/memory-contract";
import { qqMemoryScopeKey } from "../../src/server/services/qq-binding-contract";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const now = "2030-01-01T00:00:00.000Z";
const scope = qqMemoryScopeKey({
  kind: "qq",
  accountId: "100",
  conversationKind: "group",
  peerId: "200",
  agentId: DEFAULT_AGENT_ID,
});
function fixture() {
  const h = openBusinessDb({ path: ":memory:" });
  handles.push(h);
  ensureDefaults(h.orm, "synthetic");
  policy(h.orm, DEFAULT_AGENT_ID);
  h.orm
    .insert(schema.qqEvents)
    .values({
      eventKey: "event",
      accountId: "100",
      conversationKind: "group",
      peerId: "200",
      agentId: DEFAULT_AGENT_ID,
      messageId: "7",
      occurredAtSeconds: 1,
      speakerKind: "member",
      speakerId: "300",
      recordedAt: now,
    })
    .run();
  const seed = (id: string, name = id, body = "Straße Σς 𠮷", scopeKey = scope) => {
    h.orm
      .insert(schema.memoryEntries)
      .values({
        id,
        agentId: DEFAULT_AGENT_ID,
        userId: DEFAULT_USER_ID,
        name,
        summary: "İ ﬃ",
        tags: '["标签"]',
        kinds: '["semantic"]',
        body,
        scope: "reality_user",
        scopeKey,
        status: "active",
        configSnapshot: "{}",
        createdAt: now,
      })
      .run();
    h.orm
      .insert(schema.qqMemorySources)
      .values({
        memoryId: id,
        eventKey: "event",
        scopeKey,
        conversationKey: '["qq","100","group","200"]',
        messageId: "7",
        occurredAtSeconds: 1,
        speakerKind: "member",
        speakerId: "300",
      })
      .run();
  };
  return { h, seed };
}
function captureError(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected invalid selection");
}

describe("memory catalog work and unchanged legacy reads", () => {
  it("scores each valid row once and matches the scalar Unicode ordering", () => {
    const { h, seed } = fixture();
    for (let i = 0; i < 96; i++)
      seed(
        `m-${i}`,
        i % 3 ? `name-${i}` : `Straße-${i}`,
        `${i % 5 ? "other" : "ﬃ"} ${"文".repeat(500)} ${i}`,
      );
    const words = ["STRASSE", "FFI", "σ"];
    const rows = entries(h.orm, DEFAULT_AGENT_ID, undefined, {
      status: "active",
      scopeKeys: [scope],
    });
    const folded = words.map(casefold.fullCasefold);
    const score = (row: (typeof rows)[number]) =>
      folded.reduce(
        (sum, word) =>
          sum +
          Number(
            [row.name, row.summary, row.body]
              .map(casefold.fullCasefold)
              .some((text) => text.includes(word)),
          ),
        0,
      );
    const expected = rows
      .toSorted(
        (a, b) =>
          score(b) - score(a) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      )
      .slice(0, 17)
      .map((row) => row.id);
    const original = casefold.fullCasefold;
    const fold = spyOn(casefold, "fullCasefold").mockImplementation(original);
    try {
      const actual = catalogByScopeKeys(h.orm, DEFAULT_AGENT_ID, [scope], {
        keywords: words,
        limit: 17,
      });
      expect(actual.map((item) => item.id)).toEqual(expected);
      expect(fold.mock.calls.length).toBe(words.length + rows.length * 3);
    } finally {
      fold.mockRestore();
    }
  });

  it("prefilters selected bodies in SQL, retains duplicates/order and rejects unavailable selections identically", () => {
    const { h, seed } = fixture();
    for (let i = 0; i < 80; i++) seed(`row-${i}`);
    seed("outside", "outside", "private", "other-scope");
    const expected = catalogByScopeKeys(h.orm, DEFAULT_AGENT_ID, [scope], {
      allEntries: true,
      limit: 100,
    });
    const original = h.db.prepare;
    const prepare = original.bind(h.db);
    const returned: number[] = [];
    h.db.prepare = ((sql: string, ...rest: unknown[]) => {
      const statement = Reflect.apply(prepare, h.db, [sql, ...rest]);
      if (!/from "memory_entries"/i.test(sql)) return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === "values" || key === "all")
            return (...args: unknown[]) => {
              const rows = Reflect.apply(value, target, args) as unknown[];
              returned.push(rows.length);
              return rows;
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof h.db.prepare;
    try {
      const ids = ["row-73", "row-2", "row-73"];
      expect(memoryBodiesByScopeKeys(h.orm, DEFAULT_AGENT_ID, ids, [scope])).toEqual(
        ids.map((id) => expected.find((item) => item.id === id)!),
      );
      expect(returned).toEqual([2]);
    } finally {
      h.db.prepare = original;
    }
    for (const ids of [["missing"], ["outside"], ["row-2", "missing"]]) {
      expect(
        captureError(() => memoryBodiesByScopeKeys(h.orm, DEFAULT_AGENT_ID, ids, [scope])),
      ).toMatchObject({ code: "CONTEXT_SOURCE_INVALID", statusCode: 409 });
    }
    expect(memoryBodiesByScopeKeys(h.orm, DEFAULT_AGENT_ID, [], [scope])).toEqual([]);
    h.orm
      .update(schema.memoryEntries)
      .set({ status: "suppressed" })
      .where(eq(schema.memoryEntries.id, "row-2"))
      .run();
    expect(
      captureError(() => memoryBodiesByScopeKeys(h.orm, DEFAULT_AGENT_ID, ["row-2"], [scope])),
    ).toMatchObject({ code: "CONTEXT_SOURCE_INVALID", statusCode: 409 });
  });

  it("keeps legacy QQ validity separate from stricter bounded tool checks and revalidates corrections", () => {
    const { h, seed } = fixture();
    seed("legacy", "legacy", "body", "legacy-scope");
    expect(
      memoryBodiesByScopeKeys(h.orm, DEFAULT_AGENT_ID, ["legacy"], ["legacy-scope"]),
    ).toHaveLength(1);
    expect(
      scanMemoryCandidates(h.orm, DEFAULT_AGENT_ID, ["legacy-scope"], { limit: 10 }).items,
    ).toEqual([]);
    seed("current");
    const before = memoryContent(h.orm, DEFAULT_AGENT_ID, "current");
    const corrected = correctMemory(h.orm, DEFAULT_AGENT_ID, "current", {
      expected_revision: before.content.revision,
      name: "corrected",
      summary: "fixed",
      tags: [],
      body: "new body",
    });
    expect(
      captureError(() => memoryBodiesByScopeKeys(h.orm, DEFAULT_AGENT_ID, ["current"], [scope])),
    ).toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    const selected = memoryBodiesByScopeKeys(
      h.orm,
      DEFAULT_AGENT_ID,
      [corrected.content.id],
      [scope],
    );
    expect(selected[0]).toMatchObject({
      revision: corrected.content.revision,
      content_origin: "manual_correction",
      body: "new body",
    });
    h.orm
      .update(schema.qqEvents)
      .set({ speakerId: "changed" })
      .where(eq(schema.qqEvents.eventKey, "event"))
      .run();
    expect(
      captureError(() =>
        memoryBodiesByScopeKeys(h.orm, DEFAULT_AGENT_ID, [corrected.content.id], [scope]),
      ),
    ).toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
  });

  it("retains complete valid catalogs, UTF-16 afterId filtering, locale ordering and metadata fingerprint bytes", () => {
    const { h, seed } = fixture();
    for (const id of ["a", "A", "ä", "z", "𠮷", "😀"]) seed(id);
    seed("invalid");
    h.orm
      .update(schema.memoryEntries)
      .set({ configSnapshot: '{"correction_retired":true}' })
      .where(eq(schema.memoryEntries.id, "invalid"))
      .run();
    seed("outside", "outside", "body", "other");
    const rows = entries(h.orm, DEFAULT_AGENT_ID, undefined, {
      status: "active",
      scopeKeys: [scope],
    })
      .filter((row) => row.id !== "invalid")
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(
      catalogByScopeKeys(h.orm, DEFAULT_AGENT_ID, [scope], {
        allEntries: true,
        afterId: "z",
        limit: 100,
      }).map((item) => item.id),
    ).toEqual(rows.filter((row) => row.id > "z").map((row) => row.id));
    const digest = createHash("sha256")
      .update(`${DEFAULT_AGENT_ID}:${AGENT_LEVEL_SCOPE_KEY}`)
      .update(`:${JSON.stringify([scope])}`);
    for (const row of rows)
      digest
        .update(
          JSON.stringify([
            row.id,
            row.name,
            row.summary,
            JSON.parse(row.tags),
            row.createdAt,
            row.status,
          ]),
        )
        .update("\n");
    const before = memoryFingerprintByScopeKeys(h.orm, DEFAULT_AGENT_ID, [scope]);
    expect(before).toBe(digest.digest("hex"));
    const revision = memoryBodiesByScopeKeys(h.orm, DEFAULT_AGENT_ID, ["a"], [scope])[0].revision;
    h.orm
      .update(schema.memoryEntries)
      .set({ body: "body changed" })
      .where(eq(schema.memoryEntries.id, "a"))
      .run();
    expect(memoryFingerprintByScopeKeys(h.orm, DEFAULT_AGENT_ID, [scope])).toBe(before);
    expect(memoryBodiesByScopeKeys(h.orm, DEFAULT_AGENT_ID, ["a"], [scope])[0].revision).not.toBe(
      revision,
    );
    expect(
      catalogByScopeKeys(h.orm, DEFAULT_AGENT_ID, [], { allEntries: true, limit: 100 }),
    ).toEqual([]);
    expect(
      catalogByScopeKeys(h.orm, DEFAULT_AGENT_ID, null, { allEntries: true, limit: 100 }),
    ).toHaveLength(rows.length + 1);
  });
});
