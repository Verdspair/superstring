// P2b: observation-backed memory sources (ADR0018).
//
// A QQ group member's message is an observation, not a user/assistant turn, so a
// memory formed from one cannot use `memory_sources`. These tests pin the
// consequences that matter: such a memory is recallable and governable, it stores no
// message text, and observation evidence can never validate a web (agent-level)
// memory.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { catalog, memoryBodies } from "../../src/server/db/context-repository";
import { correctMemory, memoryContent } from "../../src/server/db/memory-content-repository";
import {
  claim,
  enqueue,
  entries,
  govern,
  policy,
  publish,
  validateEntrySources,
} from "../../src/server/db/memory-repository";
import {
  createSession,
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
  type Orm,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { qqMemoryScopeKeyset } from "../../src/server/services/memory-scope";
import type { QqMemoryAccess, QqMemoryScope } from "../../src/server/services/qq-binding-contract";
import { ContentSourceSchema } from "../../src/shared/contracts/content";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MODEL = "qwen/qwen3-4b-2507";

function groupScope(peerId: string): QqMemoryScope {
  return { kind: "qq", accountId: "10001", conversationKind: "group", peerId, agentId: AGENT_ID };
}
function access(peerId: string): QqMemoryAccess {
  const history = groupScope(peerId);
  return {
    conversationKey: JSON.stringify(["qq", "10001", "group", peerId]),
    historyScope: history,
    readScopes: [history],
    writeScope: history,
  };
}
const GROUP_A = access("20001");

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const sessionId = createSession(business.orm, "会话", { modelName: MODEL }).id;
  policy(business.orm, AGENT_ID);
  return { business, orm: business.orm, sessionId };
}

/**
 * Seed a dedup observation row and, optionally, a memory that cites it.
 * `speakerKind`/`speakerId` must agree, mirroring the table CHECK.
 */
function seedObservation(
  orm: Orm,
  eventKey: string,
  options: { speakerKind?: "member" | "anonymous" | "system"; speakerId?: string | null } = {},
) {
  const speakerKind = options.speakerKind ?? "member";
  const speakerId = options.speakerId === undefined ? "30001" : options.speakerId;
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey,
      accountId: "10001",
      conversationKind: "group",
      peerId: "20001",
      agentId: AGENT_ID,
      messageId: "-7",
      occurredAtSeconds: 123456,
      speakerKind,
      speakerId,
      recordedAt: nowIso(),
    })
    .run();
  return { speakerKind, speakerId: speakerId as string | null };
}

function seedMemory(
  orm: Orm,
  id: string,
  scopeKey: string,
  eventKeys: string[],
  options: { status?: string; orphan?: boolean } = {},
) {
  orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: `记忆 ${id}`,
      summary: "简介",
      tags: JSON.stringify(["t"]),
      kinds: JSON.stringify(["episodic"]),
      body: `正文 ${id}`,
      scope: "reality_user",
      scopeKey,
      status: options.status ?? "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
    })
    .run();
  for (const eventKey of eventKeys) {
    const event = orm
      .select()
      .from(schema.qqEvents)
      .where(eq(schema.qqEvents.eventKey, eventKey))
      .get();
    if (!event && !options.orphan) throw new Error("seed the observation first");
    orm
      .insert(schema.qqMemorySources)
      .values({
        memoryId: id,
        eventKey,
        scopeKey,
        conversationKey: GROUP_A.conversationKey,
        messageId: event?.messageId ?? "-7",
        occurredAtSeconds: event?.occurredAtSeconds ?? 123456,
        speakerKind: event?.speakerKind ?? "member",
        speakerId: event?.speakerId ?? "30001",
      })
      .run();
  }
  return id;
}

describe("observation-backed memory sources", () => {
  it("stores provenance without any message text", () => {
    const h = setup();
    try {
      seedObservation(h.orm, "evt_1");
      seedMemory(h.orm, "m_qq", qqMemoryScopeKeyset(GROUP_A).write, ["evt_1"]);
      const row = h.orm.select().from(schema.qqMemorySources).all()[0];
      expect(row).toBeDefined();
      // Nothing in the provenance table can hold a message body.
      expect(Object.keys(row ?? {})).not.toContain("content");
      expect(Object.keys(row ?? {})).not.toContain("body");
      expect(row?.conversationKey).toBe(GROUP_A.conversationKey);
    } finally {
      h.business.close();
    }
  });

  it("makes the memory recallable and valid, and exposes it as a typed source", () => {
    const h = setup();
    try {
      seedObservation(h.orm, "evt_1");
      seedMemory(h.orm, "m_qq", qqMemoryScopeKeyset(GROUP_A).write, ["evt_1"]);
      const items = catalog(h.orm, AGENT_ID, h.sessionId, {
        allEntries: true,
        scopeKeys: qqMemoryScopeKeyset(GROUP_A).read,
      });
      expect(items.map((item) => item.id)).toEqual(["m_qq"]);
      const source = items[0]?.sources[0];
      expect(source?.type).toBe("qq_observation");
      // The shared content contract must accept what the repository produced. Only
      // the sources are validated here: a catalog item also carries `createdAt`, which
      // the strict content item deliberately does not allow.
      expect(ContentSourceSchema.safeParse(source).success).toBe(true);
      expect(memoryBodies(h.orm, AGENT_ID, h.sessionId, ["m_qq"])[0]?.id).toBe("m_qq");
    } finally {
      h.business.close();
    }
  });

  it("rejects observation evidence for a web memory", () => {
    const h = setup();
    try {
      seedObservation(h.orm, "evt_1");
      // A web (agent-level) memory may not claim an observation.
      seedMemory(h.orm, "m_web", AGENT_ID, ["evt_1"]);
      expect(entries(h.orm, AGENT_ID, ["m_web"])).toHaveLength(1);
      expect(() => validateEntrySources(h.orm, entries(h.orm, AGENT_ID, ["m_web"]))).toThrow();
    } finally {
      h.business.close();
    }
  });

  it("cannot even create provenance for an event that does not exist", () => {
    const h = setup();
    try {
      // The foreign key to `qq_events` is the first line of defence: an orphaned
      // source row cannot be written in the first place.
      expect(() =>
        seedMemory(h.orm, "m_qq", qqMemoryScopeKeyset(GROUP_A).write, ["evt_missing"], {
          orphan: true,
        }),
      ).toThrow();
      expect(h.orm.select().from(schema.qqMemorySources).all()).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("still rejects an orphan written with foreign keys disabled", () => {
    const h = setup();
    try {
      seedMemory(h.orm, "m_qq", qqMemoryScopeKeyset(GROUP_A).write, []);
      // Simulate a damaged database: write the provenance with FK enforcement off.
      h.business.db.run("PRAGMA foreign_keys = OFF");
      h.business.db
        .query(
          `INSERT INTO qq_memory_sources (memory_id, event_key, scope_key, conversation_key,
            message_id, occurred_at_seconds, speaker_kind, speaker_id)
           VALUES ('m_qq', 'evt_missing', ?, ?, '-7', 1, 'member', '30001')`,
        )
        .run(qqMemoryScopeKeyset(GROUP_A).write, GROUP_A.conversationKey);
      h.business.db.run("PRAGMA foreign_keys = ON");
      // Validation is the second line of defence and must not trust the row.
      expect(() => validateEntrySources(h.orm, entries(h.orm, AGENT_ID, ["m_qq"]))).toThrow();
      expect(
        catalog(h.orm, AGENT_ID, h.sessionId, {
          allEntries: true,
          scopeKeys: qqMemoryScopeKeyset(GROUP_A).read,
        }),
      ).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("detects provenance that no longer matches its dedup row", () => {
    const h = setup();
    try {
      seedObservation(h.orm, "evt_1");
      seedMemory(h.orm, "m_qq", qqMemoryScopeKeyset(GROUP_A).write, ["evt_1"]);
      expect(validateEntrySources(h.orm, entries(h.orm, AGENT_ID, ["m_qq"]))).toEqual([]);
      // Rewriting the dedup row's speaker leaves the memory citing a different claim.
      h.orm
        .update(schema.qqEvents)
        .set({ speakerId: "30002" })
        .where(eq(schema.qqEvents.eventKey, "evt_1"))
        .run();
      expect(() => validateEntrySources(h.orm, entries(h.orm, AGENT_ID, ["m_qq"]))).toThrow();
    } finally {
      h.business.close();
    }
  });

  it("keeps observation provenance through a correction", () => {
    const h = setup();
    try {
      seedObservation(h.orm, "evt_1");
      seedMemory(h.orm, "m_qq", qqMemoryScopeKeyset(GROUP_A).write, ["evt_1"]);
      const before = memoryContent(h.orm, AGENT_ID, "m_qq");
      expect(before.content.validity).toBe("valid");
      // A QQ memory has no original transcript to recap.
      expect(before.source_messages).toEqual([]);
      const after = correctMemory(h.orm, AGENT_ID, "m_qq", {
        expected_revision: before.content.revision,
        name: "改名",
        summary: "改简介",
        tags: ["t"],
        body: "改正文",
      });
      expect(after.content.name).toBe("改名");
      expect(after.content.validity).toBe("valid");
      // The replacement carries the same observation source.
      expect(after.content.sources.map((source) => source.type)).toEqual(["qq_observation"]);
      expect(validateEntrySources(h.orm, entries(h.orm, AGENT_ID))).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("suppresses and purges an observation-backed memory", () => {
    const h = setup();
    try {
      seedObservation(h.orm, "evt_1");
      seedMemory(h.orm, "m_qq", qqMemoryScopeKeyset(GROUP_A).write, ["evt_1"]);
      govern(h.orm, AGENT_ID, ["m_qq"], "suppress");
      expect(entries(h.orm, AGENT_ID, undefined, { status: "active" })).toEqual([]);
      govern(h.orm, AGENT_ID, ["m_qq"], "purge");
      expect(h.orm.select().from(schema.memoryEntries).all()).toEqual([]);
      // The dedup row survives on purpose: it is the identity, not a copy of the content.
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(1);
    } finally {
      h.business.close();
    }
  });

  it("keeps an observation-backed memory out of an unrelated group's recall", () => {
    const h = setup();
    try {
      seedObservation(h.orm, "evt_1");
      seedMemory(h.orm, "m_qq", qqMemoryScopeKeyset(GROUP_A).write, ["evt_1"]);
      const other = access("20002");
      expect(
        catalog(h.orm, AGENT_ID, h.sessionId, {
          allEntries: true,
          scopeKeys: qqMemoryScopeKeyset(other).read,
        }),
      ).toEqual([]);
      // No scope at all is still the whole agent, i.e. today's governance behaviour.
      expect(catalog(h.orm, AGENT_ID, h.sessionId, { allEntries: true })).toHaveLength(1);
    } finally {
      h.business.close();
    }
  });

  it("refuses to mix a QQ job's scope with another group's memory", () => {
    const h = setup();
    try {
      seedObservation(h.orm, "evt_1");
      seedMemory(h.orm, "m_qq", qqMemoryScopeKeyset(GROUP_A).write, ["evt_1"]);
      const other = access("20002");
      expect(() =>
        enqueue(h.orm, AGENT_ID, "req_cross_group", {
          kind: "merge",
          memoryIds: ["m_qq"],
          scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(other).write },
        }),
      ).toThrow();
      const job = enqueue(h.orm, AGENT_ID, "req_same_group", {
        kind: "merge",
        memoryIds: ["m_qq"],
        scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
      });
      expect((JSON.parse(job.configSnapshot) as { scope_key: string }).scope_key).toBe(
        qqMemoryScopeKeyset(GROUP_A).write,
      );
    } finally {
      h.business.close();
    }
  });

  it("publishes observation provenance for an observation-backed job", () => {
    const h = setup();
    try {
      seedObservation(h.orm, "evt_1");
      const job = enqueue(h.orm, AGENT_ID, "req_publish", {
        kind: "manual",
        eventIds: ["evt_1"],
        scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
      });
      const claimed = claim(h.orm, job.id);
      if (!claimed?.token) throw new Error("expected a claimable job");
      publish(h.orm, AGENT_ID, job.id, claimed.token, {
        name: "群友偏好",
        summary: "群友提到喜欢某物",
        tags: ["群"],
        kinds: ["episodic"],
        body: "群友说喜欢某物。",
      });
      const entry = h.orm.select().from(schema.memoryEntries).get();
      if (!entry) throw new Error("expected the published memory");
      expect(entry.scopeKey).toBe(qqMemoryScopeKeyset(GROUP_A).write);
      const rows = h.orm.select().from(schema.qqMemorySources).all();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error("expected one provenance row");
      expect(row.memoryId).toBe(entry.id);
      expect(row.eventKey).toBe("evt_1");
      expect(row.conversationKey).toBe(GROUP_A.conversationKey);
      // Provenance is complete, so the memory is immediately reusable.
      expect(validateEntrySources(h.orm, entries(h.orm, AGENT_ID, [entry.id]))).toEqual([]);
      // A turn job never writes observation rows.
      expect(h.orm.select().from(schema.memorySources).all()).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("carries observation provenance through a merge instead of orphaning the child", () => {
    const h = setup();
    try {
      seedObservation(h.orm, "evt_1");
      seedObservation(h.orm, "evt_2");
      seedMemory(h.orm, "m_one", qqMemoryScopeKeyset(GROUP_A).write, ["evt_1"]);
      seedMemory(h.orm, "m_two", qqMemoryScopeKeyset(GROUP_A).write, ["evt_2"]);
      policy(h.orm, AGENT_ID);
      const job = enqueue(h.orm, AGENT_ID, "req_merge_obs", {
        kind: "merge",
        memoryIds: ["m_one", "m_two"],
        scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
      });
      const claimed = claim(h.orm, job.id);
      if (!claimed?.token) throw new Error("expected a claimable job");
      publish(h.orm, AGENT_ID, job.id, claimed.token, {
        name: "合并",
        summary: "两条合成一条",
        tags: ["群"],
        kinds: ["episodic"],
        body: "合并后的正文。",
      });
      const merged = entries(h.orm, AGENT_ID, undefined, { status: "active" }).filter(
        (entry) => entry.id !== "m_one" && entry.id !== "m_two",
      );
      expect(merged).toHaveLength(1);
      const child = merged[0];
      if (!child) throw new Error("expected the merged memory");
      const rows = h.orm.select().from(schema.qqMemorySources).all();
      const forChild = rows.filter((row) => row.memoryId === child.id);
      // Both parents' events are attached to the child, so it stays usable.
      expect(forChild.map((row) => row.eventKey).sort()).toEqual(["evt_1", "evt_2"]);
      expect(validateEntrySources(h.orm, entries(h.orm, AGENT_ID, [child.id]))).toEqual([]);
    } finally {
      h.business.close();
    }
  });
});
