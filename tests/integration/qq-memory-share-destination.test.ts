import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server/app";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { enqueue, validateEntrySources } from "../../src/server/db/memory-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import type { QqMemoryRouteSnapshot } from "../../src/server/services/memory-contract";
import { memoryJobScopes } from "../../src/server/services/memory-contract";
import { memoryRevision } from "../../src/server/services/memory-revision";
import { MemoryService } from "../../src/server/services/memory-service";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { qqMemoryScopeKey } from "../../src/server/services/qq-binding-contract";
import { enqueueQqMemory } from "../../src/server/services/qq-memory-enqueue";

class Gateway implements ModelGateway {
  config = { baseUrl: "http://unused", model: "synthetic", timeoutSeconds: 30 };
  async listModels() {
    return ["synthetic"];
  }
  async loadedContextCapacity() {
    return 32768;
  }
  async probeModelLoaded() {
    return true;
  }
  calls: Array<Parameters<ModelGateway["complete"]>[0]> = [];
  async complete(input: Parameters<ModelGateway["complete"]>[0]) {
    this.calls.push(input);
    return JSON.stringify({
      memory: { name: "n", summary: "s", tags: [], kinds: ["semantic"], body: "synthetic" },
    });
  }
  async *streamChat(): AsyncGenerator<string, void, unknown> {
    yield* [];
    throw new Error("unexpected stream");
  }
}
function setup(owner = true) {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic");
  const now = nowIso();
  const bindingId = crypto.randomUUID(),
    schemeId = crypto.randomUUID();
  h.orm
    .insert(schema.qqSchemes)
    .values({ id: schemeId, name: "synthetic", revision: 1, createdAt: now, updatedAt: now })
    .run();
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId: "90001",
      conversationKind: "private",
      peerId: "30001",
      agentId: DEFAULT_AGENT_ID,
      schemeId,
      paused: 0,
      shareWebMemory: 1,
      memoryBatchSize: null,
      ownerIdentityRevision: 1,
      revision: 1,
      authorityRevision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  if (owner)
    h.orm
      .insert(schema.qqOwnerIdentities)
      .values({ id: 1, accountId: "90001", peerId: "30001", revision: 1 })
      .run();
  const journal = new ConversationEventRepository(h.db);
  if (!journal.ensureOneBot(bindingId)) throw new Error("missing conversation");
  const message = normalizeOneBotMessage(
    {
      time: Math.floor(Date.now() / 1000),
      self_id: 90001,
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: 101,
      user_id: 30001,
      message: [{ type: "text", data: { text: "synthetic source" } }],
    },
    "90001",
  );
  if (message.kind !== "message") throw new Error("bad fixture");
  recordObservation(h.orm, message.observation, DEFAULT_AGENT_ID);
  journal.ingestOneBotEvent(message.observation.eventKey, bindingId);
  const scope = {
    kind: "qq" as const,
    accountId: "90001",
    conversationKind: "private" as const,
    peerId: "30001",
    agentId: DEFAULT_AGENT_ID,
  };
  const enqueue = () =>
    enqueueQqMemory(h.orm, { scope, requestKey: crypto.randomUUID().replace(/-/g, ""), limit: 1 });
  return { h, scope, bindingId, eventKey: message.observation.eventKey, enqueue };
}
function addObservation(f: ReturnType<typeof setup>, messageId: number) {
  const message = normalizeOneBotMessage(
    {
      time: Math.floor(Date.now() / 1000),
      self_id: 90001,
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: messageId,
      user_id: 30001,
      message: [{ type: "text", data: { text: `synthetic source ${messageId}` } }],
    },
    "90001",
  );
  if (message.kind !== "message") throw new Error("bad next observation");
  recordObservation(f.h.orm, message.observation, DEFAULT_AGENT_ID);
  new ConversationEventRepository(f.h.db).ingestOneBotEvent(
    message.observation.eventKey,
    f.bindingId,
  );
  return message.observation.eventKey;
}

describe("QQ source and destination", () => {
  it("freezes QQ source and Web destination while keeping new entry private", async () => {
    const f = setup();
    try {
      const job = f.enqueue()!;
      const snapshot = JSON.parse(job.configSnapshot);
      expect(memoryJobScopes(snapshot)).toMatchObject({
        source: qqMemoryScopeKey(f.scope),
        destination: DEFAULT_AGENT_ID,
      });
      expect(snapshot.qq_route).toMatchObject({
        version: 1,
        source_scope_key: qqMemoryScopeKey(f.scope),
        destination_scope_key: DEFAULT_AGENT_ID,
        binding_id: f.bindingId,
        authority_revision: 1,
        owner_identity_revision: 1,
      });
      const service = new MemoryService({
        orm: f.h.orm,
        db: f.h.db,
        gateway: new Gateway(),
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2000,
      });
      await service.runJob(job.id);
      const done = f.h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, job.id))
        .get()!;
      expect(done.status).toBe("succeeded");
      const entry = f.h.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, done.resultId!))
        .get()!;
      expect(entry.scopeKey).toBe(DEFAULT_AGENT_ID);
      expect(entry.visibility).toBe("session_private");
      expect(
        f.h.orm
          .select()
          .from(schema.qqMemorySources)
          .where(eq(schema.qqMemorySources.memoryId, entry.id))
          .get()?.scopeKey,
      ).toBe(qqMemoryScopeKey(f.scope));
      expect(f.h.orm.select().from(schema.memoryReadGrants).all()).toEqual([]);
      expect(validateEntrySources(f.h.orm, [entry])).toEqual([]);
      f.h.db
        .query("UPDATE qq_message_facts SET expires_at='2020-01-01T00:00:00Z' WHERE event_key=?")
        .run(f.eventKey);
      expect(() => validateEntrySources(f.h.orm, [entry])).toThrow();
    } finally {
      f.h.close();
    }
  });
  it("rejects queued job after sharing authority changes", async () => {
    const f = setup();
    try {
      const job = f.enqueue()!;
      f.h.db
        .query(
          "UPDATE qq_bindings SET share_web_memory=0,owner_identity_revision=NULL,revision=revision+1,authority_revision=authority_revision+1 WHERE id=?",
        )
        .run(f.bindingId);
      f.h.db
        .query(
          "UPDATE qq_bindings SET share_web_memory=1,owner_identity_revision=1,revision=revision+1,authority_revision=authority_revision+1 WHERE id=?",
        )
        .run(f.bindingId);
      const service = new MemoryService({
        orm: f.h.orm,
        db: f.h.db,
        gateway: new Gateway(),
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2000,
      });
      await service.runJob(job.id);
      expect(
        f.h.orm.select().from(schema.memoryJobs).where(eq(schema.memoryJobs.id, job.id)).get()
          ?.status,
      ).toBe("failed");
      expect(f.h.orm.select().from(schema.memoryEntries).all()).toEqual([]);
    } finally {
      f.h.close();
    }
  });
  it("denies missing owner before marking sources processed", () => {
    const f = setup(false);
    try {
      expect(() => f.enqueue()).toThrow();
      expect(f.h.orm.select().from(schema.qqProcessedEvents).all()).toEqual([]);
    } finally {
      f.h.close();
    }
  });
  it.each(["suppress", "correct"] as const)(
    "keeps same QQ-source routed %s content blocked on the next job",
    async (action) => {
      const f = setup();
      try {
        const service = new MemoryService({
          orm: f.h.orm,
          db: f.h.db,
          gateway: new Gateway(),
          heartbeatIntervalMs: 5,
          jobTimeoutMs: 2000,
        });
        const first = f.enqueue()!;
        await service.runJob(first.id);
        const done = f.h.orm
          .select()
          .from(schema.memoryJobs)
          .where(eq(schema.memoryJobs.id, first.id))
          .get()!;
        expect(done.status).toBe("succeeded");
        if (!done.resultId) throw new Error("first routed memory missing");
        const firstEntry = f.h.orm
          .select()
          .from(schema.memoryEntries)
          .where(eq(schema.memoryEntries.id, done.resultId))
          .get()!;
        expect(firstEntry.scopeKey).toBe(DEFAULT_AGENT_ID);
        const app = createApp({ business: f.h, externalActions: () => [] });
        const path = `/agents/${DEFAULT_AGENT_ID}/memory`;
        const response =
          action === "suppress"
            ? await app.request(`${path}/govern`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "suppress", memory_ids: [firstEntry.id] }),
              })
            : await app.request(`${path}/entries/${firstEntry.id}/correct`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  expected_revision: memoryRevision(firstEntry),
                  name: "corrected",
                  summary: "corrected",
                  tags: [],
                  body: "corrected content",
                }),
              });
        const responseBody = await response.json();
        expect({ status: response.status, body: responseBody }).toMatchObject({
          status: action === "correct" ? 201 : 200,
        });
        addObservation(f, 102);
        const second = f.enqueue()!;
        await service.runJob(second.id);
        const after = f.h.orm
          .select()
          .from(schema.memoryJobs)
          .where(eq(schema.memoryJobs.id, second.id))
          .get()!;
        expect(after.status).toBe("succeeded");
        expect(after.resultId).toBeNull();
        expect(
          f.h.orm
            .select()
            .from(schema.memoryEntries)
            .all()
            .filter((entry) => entry.body === "synthetic" && entry.status === "active"),
        ).toHaveLength(0);
      } finally {
        f.h.close();
      }
    },
  );

  it.each(["expired", "binding-aba"] as const)(
    "denies correction of a routed entry after %s",
    async (kind) => {
      const f = setup();
      try {
        const service = new MemoryService({
          orm: f.h.orm,
          db: f.h.db,
          gateway: new Gateway(),
          heartbeatIntervalMs: 5,
          jobTimeoutMs: 2000,
        });
        const job = f.enqueue()!;
        await service.runJob(job.id);
        const done = f.h.orm
          .select()
          .from(schema.memoryJobs)
          .where(eq(schema.memoryJobs.id, job.id))
          .get()!;
        expect(done.status).toBe("succeeded");
        if (!done.resultId) throw new Error("missing routed result");
        const entry = f.h.orm
          .select()
          .from(schema.memoryEntries)
          .where(eq(schema.memoryEntries.id, done.resultId))
          .get()!;
        if (kind === "expired") {
          f.h.db
            .query(
              "UPDATE qq_message_facts SET expires_at='2020-01-01T00:00:00Z' WHERE event_key=?",
            )
            .run(f.eventKey);
        } else {
          f.h.db
            .query(
              "UPDATE qq_bindings SET share_web_memory=0,owner_identity_revision=NULL,revision=revision+1,authority_revision=authority_revision+1 WHERE id=?",
            )
            .run(f.bindingId);
          f.h.db
            .query(
              "UPDATE qq_bindings SET share_web_memory=1,owner_identity_revision=1,revision=revision+1,authority_revision=authority_revision+1 WHERE id=?",
            )
            .run(f.bindingId);
        }
        const app = createApp({ business: f.h, externalActions: () => [] });
        const response = await app.request(
          `/agents/${DEFAULT_AGENT_ID}/memory/entries/${entry.id}/correct`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expected_revision: memoryRevision(entry),
              name: "corrected",
              summary: "corrected",
              tags: [],
              body: "corrected",
            }),
          },
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "MEMORY_SOURCE_INVALID" } });
      } finally {
        f.h.close();
      }
    },
  );

  it("does not send another Web private blocked entry into QQ consolidation", async () => {
    const f = setup();
    try {
      f.h.orm
        .insert(schema.memoryEntries)
        .values({
          id: crypto.randomUUID(),
          agentId: DEFAULT_AGENT_ID,
          userId: DEFAULT_USER_ID,
          name: "blocked",
          summary: "PRIVATE-WEB-SECRET",
          tags: "[]",
          kinds: "[]",
          body: "PRIVATE-WEB-SECRET",
          scope: "reality_user",
          scopeKey: DEFAULT_AGENT_ID,
          status: "suppressed",
          configSnapshot: "{}",
          createdAt: nowIso(),
          visibility: "session_private",
        })
        .run();
      const job = f.enqueue()!;
      const gateway = new Gateway();
      const service = new MemoryService({
        orm: f.h.orm,
        db: f.h.db,
        gateway,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2000,
      });
      await service.runJob(job.id);
      expect(gateway.calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(gateway.calls)).not.toContain("PRIVATE-WEB-SECRET");
    } finally {
      f.h.close();
    }
  });
  it("rejects malformed routes at enqueue without marking observations processed", () => {
    const f = setup();
    try {
      const sourceKey = qqMemoryScopeKey(f.scope);
      const invalid = {
        version: 2,
        source_scope_key: sourceKey,
        destination_scope_key: DEFAULT_AGENT_ID,
        binding_id: f.bindingId,
        authority_revision: 1,
        owner_identity_revision: 1,
      };
      expect(() =>
        enqueue(f.h.orm, DEFAULT_AGENT_ID, "invalid_version", {
          kind: "manual",
          eventIds: [f.eventKey],
          scope: { scope: "reality_user", scopeKey: sourceKey },
          qqRoute: invalid as unknown as QqMemoryRouteSnapshot,
        }),
      ).toThrow();
      expect(() =>
        enqueue(f.h.orm, DEFAULT_AGENT_ID, "invalid_key", {
          kind: "manual",
          eventIds: [f.eventKey],
          scope: { scope: "reality_user", scopeKey: sourceKey },
          qqRoute: {
            ...invalid,
            version: 1,
            destination_scope_key: null,
          } as unknown as QqMemoryRouteSnapshot,
        }),
      ).toThrow();
      expect(f.h.orm.select().from(schema.memoryJobs).all()).toEqual([]);
      expect(f.h.orm.select().from(schema.qqProcessedEvents).all()).toEqual([]);
    } finally {
      f.h.close();
    }
  });
  it("preserves the legacy snapshot's original scope interpretation", () => {
    expect(memoryJobScopes({ scope_key: "old-key" })).toEqual({
      source: "old-key",
      destination: "old-key",
    });
  });
  it.each([false, true])(
    "runs an existing old QQ scope-only job with expired=%s",
    async (expired) => {
      const f = setup();
      try {
        const job = enqueue(f.h.orm, DEFAULT_AGENT_ID, `legacy_${expired}`, {
          kind: "manual",
          eventIds: [f.eventKey],
          scope: { scope: "reality_user", scopeKey: qqMemoryScopeKey(f.scope) },
        });
        expect(JSON.parse(job.configSnapshot).qq_route).toBeUndefined();
        if (expired)
          f.h.db
            .query(
              "UPDATE qq_message_facts SET expires_at='2020-01-01T00:00:00Z' WHERE event_key=?",
            )
            .run(f.eventKey);
        const service = new MemoryService({
          orm: f.h.orm,
          db: f.h.db,
          gateway: new Gateway(),
          heartbeatIntervalMs: 5,
          jobTimeoutMs: 2000,
        });
        await service.runJob(job.id);
        const done = f.h.orm
          .select()
          .from(schema.memoryJobs)
          .where(eq(schema.memoryJobs.id, job.id))
          .get()!;
        expect(done.status).toBe(expired ? "failed" : "succeeded");
        if (!expired) {
          const entry = f.h.orm
            .select()
            .from(schema.memoryEntries)
            .where(eq(schema.memoryEntries.id, done.resultId!))
            .get()!;
          expect(entry.scopeKey).toBe(qqMemoryScopeKey(f.scope));
        } else {
          expect(done.resultId).toBeNull();
          const retry = await createApp({
            business: f.h,
            gateway: new Gateway(),
            externalActions: () => [],
          }).request(`/agents/${DEFAULT_AGENT_ID}/memory/jobs/${job.id}/retry`, { method: "POST" });
          expect(retry.status).toBe(202);
          const retried = f.h.orm
            .select()
            .from(schema.memoryJobs)
            .where(eq(schema.memoryJobs.id, job.id))
            .get()!;
          expect(retried.configSnapshot).toBe(done.configSnapshot);
          await service.runJob(job.id);
          expect(
            f.h.orm.select().from(schema.memoryJobs).where(eq(schema.memoryJobs.id, job.id)).get()
              ?.status,
          ).toBe("failed");
        }
      } finally {
        f.h.close();
      }
    },
  );
  it("does not publish expired source", async () => {
    const f = setup();
    try {
      const job = f.enqueue()!;
      f.h.db
        .query("UPDATE qq_message_facts SET expires_at='2020-01-01T00:00:00Z' WHERE event_key=?")
        .run(f.eventKey);
      const service = new MemoryService({
        orm: f.h.orm,
        db: f.h.db,
        gateway: new Gateway(),
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2000,
      });
      await service.runJob(job.id);
      expect(
        f.h.orm.select().from(schema.memoryJobs).where(eq(schema.memoryJobs.id, job.id)).get()
          ?.status,
      ).toBe("failed");
      expect(f.h.orm.select().from(schema.memoryEntries).all()).toEqual([]);
    } finally {
      f.h.close();
    }
  });
});
