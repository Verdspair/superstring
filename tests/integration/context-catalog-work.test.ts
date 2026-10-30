import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  memoryBodiesByScopeKeys,
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
  it("prefilters selected bodies in SQL, retains duplicates/order and rejects unavailable selections identically", () => {
    const { h, seed } = fixture();
    for (let i = 0; i < 80; i++) seed(`row-${i}`);
    seed("outside", "outside", "private", "other-scope");
    const expected = new Map(
      entries(h.orm, DEFAULT_AGENT_ID, undefined, { scopeKeys: [scope] }).map((row) => [
        row.id,
        row.body,
      ]),
    );
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
      const selected = memoryBodiesByScopeKeys(h.orm, DEFAULT_AGENT_ID, ids, [scope]);
      expect(selected.map((item) => item.id)).toEqual(ids);
      expect(selected.map((item) => item.body)).toEqual(ids.map((id) => expected.get(id)));
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
});
