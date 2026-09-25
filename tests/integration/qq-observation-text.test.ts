// P2d: observation text, the two-week retention window, and the QQ -> consolidation
// caller (ADR0018 / U03).
//
// The decision under test (user, 2026-09-22): QQ message text is kept two weeks by
// default and the media cache follows the same clock. The invariant that must survive
// it: expiring a body never invalidates a memory, because the dedup identity and the
// memory's provenance are separate rows with separate lifetimes.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  claim,
  entries,
  policy,
  publish,
  validateEntrySources,
} from "../../src/server/db/memory-repository";
import {
  markObservationsProcessed,
  observationText,
  pendingObservationCount,
  purgeExpiredObservationText,
  storeObservationText,
} from "../../src/server/db/qq-observation-repository";
import { createSession, DEFAULT_USER_ID, ensureDefaults } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { MemoryService } from "../../src/server/services/memory-service";
import {
  type QqMemoryScope,
  qqMemoryScopeKey,
} from "../../src/server/services/qq-binding-contract";
import { enqueueQqMemory, qqMemoryCandidates } from "../../src/server/services/qq-memory-enqueue";
import {
  isObservationExpired,
  mediaCacheExpiresAt,
  observationExpiresAt,
  QQ_OBSERVATION_RETENTION_DAYS,
} from "../../src/server/services/qq-retention";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MODEL = "qwen/qwen3-4b-2507";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Deterministic clock so "two weeks" is an assertion, not a hope. */
const NOW_MS = Date.parse("2026-09-22T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const NOW = `${new Date(NOW_MS).toISOString().slice(0, 19)}.000000Z`;

function groupScope(peerId: string): QqMemoryScope & { kind: "qq" } {
  return {
    kind: "qq",
    accountId: "10001",
    conversationKind: "group",
    peerId,
    agentId: AGENT_ID,
  } as QqMemoryScope & { kind: "qq" };
}
const GROUP_A = groupScope("20001");
const GROUP_B = groupScope("20002");

class ScriptedGateway implements ModelGateway {
  config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  prompts: string[] = [];
  replies: string[] = [];
  async listModels(): Promise<string[]> {
    return [MODEL];
  }
  async loadedContextCapacity(): Promise<number | null> {
    return 32768;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async complete(options: { messages: Array<{ role: string; content: string }> }): Promise<string> {
    this.prompts.push(options.messages.map((message) => message.content).join("\n"));
    return this.replies[this.prompts.length - 1] ?? JSON.stringify({ memory: null });
  }
  async *streamChat(): AsyncGenerator<string, void, unknown> {
    yield "unused";
  }
}

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const sessionId = createSession(business.orm, "会话", { modelName: MODEL }).id;
  policy(business.orm, AGENT_ID);
  const gateway = new ScriptedGateway();
  const service = new MemoryService({
    orm: business.orm,
    db: business.db,
    gateway,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 5,
    jobTimeoutMs: 2_000,
  });
  return { business, orm: business.orm, sessionId, gateway, service };
}
type Setup = ReturnType<typeof setup>;

/** A dedup row plus its body, i.e. one observed QQ message. */
function observe(
  h: Setup,
  eventKey: string,
  body: string,
  options: { peerId?: string; occurredAtSeconds?: number; accountId?: string } = {},
) {
  const peerId = options.peerId ?? "20001";
  const occurredAtSeconds = options.occurredAtSeconds ?? NOW_SECONDS;
  h.orm
    .insert(schema.qqEvents)
    .values({
      eventKey,
      accountId: options.accountId ?? "10001",
      conversationKind: "group",
      peerId,
      agentId: AGENT_ID,
      messageId: `-${eventKey}`,
      occurredAtSeconds,
      speakerKind: "member",
      speakerId: "30001",
      recordedAt: NOW,
    })
    .run();
  storeObservationText(h.orm, { eventKey, body, occurredAtSeconds });
  return { eventKey, body, occurredAtSeconds };
}

describe("observation text retention", () => {
  it("keeps a body for two weeks from when the message was sent", () => {
    const h = setup();
    try {
      const { eventKey } = observe(h, "evt_1", "群友说喜欢某物");
      const row = h.orm
        .select()
        .from(schema.qqObservationText)
        .where(eq(schema.qqObservationText.eventKey, eventKey))
        .get();
      expect(row?.expiresAt).toBe(observationExpiresAt(NOW_SECONDS));
      // The window is the agreed default, measured from the send time.
      expect(Date.parse(row?.expiresAt ?? "") - NOW_SECONDS * 1000).toBe(
        QQ_OBSERVATION_RETENTION_DAYS * DAY_MS,
      );
      expect(isObservationExpired(row?.expiresAt ?? "", NOW)).toBe(false);
      // Media follows the same clock, so it cannot outlive its message.
      expect(mediaCacheExpiresAt(NOW_SECONDS)).toBe(observationExpiresAt(NOW_SECONDS));
    } finally {
      h.business.close();
    }
  });

  it("stamps a late store with the send time, so a delayed observation does not extend the window", () => {
    const h = setup();
    try {
      const sent = NOW_SECONDS - 13 * 24 * 60 * 60;
      observe(h, "evt_old", "十三天前的消息", { occurredAtSeconds: sent });
      const row = h.orm.select().from(schema.qqObservationText).get();
      expect(row?.expiresAt).toBe(observationExpiresAt(sent));
      // Thirteen days after it was sent, one day of the window is left — not a
      // fresh two weeks counted from the late store.
      expect(Date.parse(row?.expiresAt ?? "") - NOW_MS).toBe(DAY_MS);
    } finally {
      h.business.close();
    }
  });

  it("purges expired bodies while leaving the dedup identity and memories intact", () => {
    const h = setup();
    try {
      observe(h, "evt_fresh", "新消息");
      observe(h, "evt_expired", "过期消息", { occurredAtSeconds: NOW_SECONDS - 15 * 24 * 3600 });
      // A memory whose only source is the expired message.
      h.orm
        .insert(schema.memoryEntries)
        .values({
          id: "m_old",
          agentId: AGENT_ID,
          userId: DEFAULT_USER_ID,
          name: "旧记忆",
          summary: "来自已过期消息",
          tags: JSON.stringify(["群"]),
          kinds: JSON.stringify(["episodic"]),
          body: "群友当时提到的事。",
          scope: "reality_user",
          scopeKey: qqMemoryScopeKey(GROUP_A),
          status: "active",
          configSnapshot: "{}",
          createdAt: NOW,
        })
        .run();
      h.orm
        .insert(schema.qqMemorySources)
        .values({
          memoryId: "m_old",
          eventKey: "evt_expired",
          scopeKey: qqMemoryScopeKey(GROUP_A),
          conversationKey: '["qq","10001","group","20001"]',
          messageId: "-evt_expired",
          occurredAtSeconds: NOW_SECONDS - 15 * 24 * 3600,
          speakerKind: "member",
          speakerId: "30001",
        })
        .run();

      const purged = purgeExpiredObservationText(h.orm, NOW);
      expect(purged).toBe(1);
      // Only the body is gone; the identity and the memory's evidence survive.
      expect(h.orm.select().from(schema.qqObservationText).all()).toHaveLength(1);
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(2);
      const entry = entries(h.orm, AGENT_ID, ["m_old"])[0];
      if (!entry) throw new Error("expected the memory to survive retention");
      expect(validateEntrySources(h.orm, [entry])).toEqual([]);
      // It is simply no longer re-readable.
      expect(observationText(h.orm, ["evt_expired"], NOW).size).toBe(0);
      expect(observationText(h.orm, ["evt_fresh"], NOW).get("evt_fresh")).toBe("新消息");
    } finally {
      h.business.close();
    }
  });

  it("refuses a body without a dedup identity or with blank text", () => {
    const h = setup();
    try {
      expect(() =>
        storeObservationText(h.orm, {
          eventKey: "missing",
          body: "x",
          occurredAtSeconds: NOW_SECONDS,
        }),
      ).toThrow();
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: "evt_1",
          accountId: "10001",
          conversationKind: "group",
          peerId: "20001",
          agentId: AGENT_ID,
          messageId: "-1",
          occurredAtSeconds: NOW_SECONDS,
          speakerKind: "member",
          speakerId: "30001",
          recordedAt: NOW,
        })
        .run();
      expect(() =>
        storeObservationText(h.orm, {
          eventKey: "evt_1",
          body: "   ",
          occurredAtSeconds: NOW_SECONDS,
        }),
      ).toThrow();
    } finally {
      h.business.close();
    }
  });
});

describe("QQ to consolidation caller", () => {
  it("lists only this conversation's pending observations, oldest first", () => {
    const h = setup();
    try {
      observe(h, "evt_b", "第二条", { occurredAtSeconds: NOW_SECONDS - 10 });
      observe(h, "evt_a", "第一条", { occurredAtSeconds: NOW_SECONDS - 20 });
      observe(h, "evt_other", "别的群", { peerId: "20002" });
      const candidates = qqMemoryCandidates(h.orm, GROUP_A, 10);
      expect(candidates.map((candidate) => candidate.body)).toEqual(["第一条", "第二条"]);
      expect(pendingObservationCount(h.orm, GROUP_A, NOW)).toBe(2);
      expect(pendingObservationCount(h.orm, GROUP_B, NOW)).toBe(1);
      // A limit truncates from the oldest end.
      expect(qqMemoryCandidates(h.orm, GROUP_A, 1).map((c) => c.body)).toEqual(["第一条"]);
    } finally {
      h.business.close();
    }
  });

  it("enqueues a batch, marks it offered, and does not re-offer it", () => {
    const h = setup();
    try {
      observe(h, "evt_1", "第一条");
      observe(h, "evt_2", "第二条");
      const job = enqueueQqMemory(h.orm, { scope: GROUP_A, requestKey: "req_1", limit: 10 });
      if (!job) throw new Error("expected a job");
      expect(job.kind).toBe("manual");
      const snapshot = JSON.parse(job.configSnapshot) as {
        scope_key: string;
        source_event_ids: string[];
      };
      expect(snapshot.scope_key).toBe(qqMemoryScopeKey(GROUP_A));
      expect(snapshot.source_event_ids).toEqual(["evt_1", "evt_2"]);
      // The batch is no longer pending, and a second call finds nothing.
      expect(qqMemoryCandidates(h.orm, GROUP_A, 10)).toEqual([]);
      expect(enqueueQqMemory(h.orm, { scope: GROUP_A, requestKey: "req_2", limit: 10 })).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("does not offer another conversation's messages, and reports an empty group as null", () => {
    const h = setup();
    try {
      observe(h, "evt_b", "B群的消息", { peerId: "20002" });
      // Group A has nothing, so there is no job — and none is invented.
      expect(enqueueQqMemory(h.orm, { scope: GROUP_A, requestKey: "req_a", limit: 10 })).toBeNull();
      expect(h.orm.select().from(schema.memoryJobs).all()).toEqual([]);
      // Group B's own call picks up its message and leaves A's pending count alone.
      const job = enqueueQqMemory(h.orm, { scope: GROUP_B, requestKey: "req_b", limit: 10 });
      expect(
        (JSON.parse(job?.configSnapshot ?? "{}") as { source_event_ids: string[] })
          .source_event_ids,
      ).toEqual(["evt_b"]);
      expect(h.orm.select().from(schema.qqProcessedEvents).all()).toHaveLength(1);
    } finally {
      h.business.close();
    }
  });

  it("skips observations whose text already expired instead of citing them", () => {
    const h = setup();
    try {
      observe(h, "evt_expired", "过期消息", { occurredAtSeconds: NOW_SECONDS - 20 * 24 * 3600 });
      observe(h, "evt_fresh", "新消息", { occurredAtSeconds: NOW_SECONDS - 60 });
      const candidates = qqMemoryCandidates(h.orm, GROUP_A, 10);
      expect(candidates.map((candidate) => candidate.eventKey)).toEqual(["evt_fresh"]);
    } finally {
      h.business.close();
    }
  });
});

describe("worker organises observation text", () => {
  it("summarises the message bodies it was given", async () => {
    const h = setup();
    try {
      observe(h, "evt_1", "群友说喜欢猫");
      h.gateway.replies = [
        JSON.stringify({
          memory: {
            name: "群友偏好",
            summary: "群友喜欢猫",
            tags: ["群"],
            kinds: ["episodic"],
            body: "群友提到自己喜欢猫。",
          },
        }),
      ];
      const job = enqueueQqMemory(h.orm, { scope: GROUP_A, requestKey: "req_ok", limit: 10 });
      if (!job) throw new Error("expected a job");
      await h.service.runCycle();
      // The message text reached the model, and the memory was published with an
      // observation source rather than a turn source.
      expect(h.gateway.prompts.join("\n")).toContain("群友说喜欢猫");
      const after = h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, job.id))
        .get();
      expect(after?.status).toBe("succeeded");
      const entry = h.orm.select().from(schema.memoryEntries).get();
      expect(entry?.scopeKey).toBe(qqMemoryScopeKey(GROUP_A));
      expect(h.orm.select().from(schema.qqMemorySources).all()).toHaveLength(1);
      expect(h.orm.select().from(schema.memorySources).all()).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("fails closed if the text expired between enqueue and load", async () => {
    const h = setup();
    try {
      observe(h, "evt_1", "马上要过期的消息");
      const job = enqueueQqMemory(h.orm, { scope: GROUP_A, requestKey: "req_race", limit: 10 });
      if (!job) throw new Error("expected a job");
      // Retention catches up before the worker loads its inputs.
      h.orm.delete(schema.qqObservationText).run();
      await h.service.runCycle();
      const after = h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, job.id))
        .get();
      expect(after?.status).toBe("failed");
      expect(after?.errorCode).toBe("MEMORY_SOURCE_INVALID");
      expect(h.orm.select().from(schema.memoryEntries).all()).toEqual([]);
      // No model call: refusing must not cost a generation.
      expect(h.gateway.prompts).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("keeps an observation batch out of a web job's blocked list", () => {
    const h = setup();
    try {
      observe(h, "evt_1", "群里的消息");
      policy(h.orm, AGENT_ID);
      markObservationsProcessed(h.orm, ["evt_1"]);
      // Marking is idempotent and survives the text's lifetime.
      markObservationsProcessed(h.orm, ["evt_1"]);
      expect(h.orm.select().from(schema.qqProcessedEvents).all()).toHaveLength(1);
      expect(qqMemoryCandidates(h.orm, GROUP_A, 10)).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("publishes observation provenance directly from a claim", () => {
    const h = setup();
    try {
      observe(h, "evt_1", "群友提到的事");
      const job = enqueueQqMemory(h.orm, { scope: GROUP_A, requestKey: "req_direct", limit: 10 });
      if (!job) throw new Error("expected a job");
      const claimed = claim(h.orm, job.id);
      if (!claimed?.token) throw new Error("expected a claimable job");
      publish(h.orm, AGENT_ID, job.id, claimed.token, {
        name: "群事",
        summary: "群友提到的事",
        tags: ["群"],
        kinds: ["episodic"],
        body: "群友提到某件事。",
      });
      expect(h.orm.select().from(schema.qqMemorySources).all()).toHaveLength(1);
      const entry = h.orm.select().from(schema.memoryEntries).get();
      if (!entry) throw new Error("expected the memory");
      expect(validateEntrySources(h.orm, entries(h.orm, AGENT_ID, [entry.id]))).toEqual([]);
    } finally {
      h.business.close();
    }
  });
});
