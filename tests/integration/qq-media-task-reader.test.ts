// Typed media read task reader: `readQqMediaTaskOnce` only.
import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { sourceAccess } from "../../src/server/agent/context-access";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { mediaNoteRow, recordMediaSegment } from "../../src/server/db/qq-media-repository";
import {
  type MediaTaskSourceGuard,
  normalizeQuestionKey,
} from "../../src/server/db/qq-media-task-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_USER_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import type { QqMediaTaskReadInput } from "../../src/server/services/qq-media-reader";
import {
  type QqMediaReadAdapter,
  readQqMediaTaskOnce,
} from "../../src/server/services/qq-media-reader";
import type { SourceRef } from "../../src/shared/contracts/evidence";

/** The real wire eventKey the production-ingest fixture records. */
function ingestedEventKey(): string {
  const result = normalizeOneBotMessage(
    {
      time: 0,
      self_id: 10001,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: 77,
      user_id: 20002,
      group_id: 30003,
      sender: { nickname: "阿林" },
      message: [{ type: "image", data: { file: "upstream-ref" } }],
    },
    "10001",
  );
  if (result.kind !== "message") throw new Error("message expected");
  return result.observation.eventKey;
}

const SHA = "d".repeat(64);
const base = {
  eventKey: ingestedEventKey(),
  segmentIndex: 0,
  policy: "test-policy-1",
  contentSha256: SHA,
  modelConfig: { visionModelName: "vision-local", transcriptionModelName: null },
  owner: {
    kind: "qq_binding" as const,
    id: "11111111-1111-4111-8111-111111111111",
    userId: DEFAULT_USER_ID,
    agentId: "00000000-0000-0000-0000-000000000001",
  },
} satisfies Partial<QqMediaTaskReadInput>;

function setup(kind: "image" | "record" | "video" | "file" = "image") {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, { name: "media-task-reader-test" });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: "11111111-1111-4111-8111-111111111111",
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId: "00000000-0000-0000-0000-000000000001",
      schemeId: scheme.id,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  // Real conversation row through the production journal entry (onebot11/default user).
  new ConversationEventRepository(h.db).ensureOneBot("11111111-1111-4111-8111-111111111111");
  // Production ingest path for the original media row: real wire normalization +
  // recordObservation (media row in the same transaction), then the journal
  // derives its own inbound event. No fabricated extra inbound authorization.
  const observation = normalizeOneBotMessage(
    {
      time: Math.floor(Date.now() / 1000),
      self_id: 10001,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: 77,
      user_id: 20002,
      group_id: 30003,
      sender: { nickname: "阿林" },
      message: [{ type: kind, data: { file: "upstream-ref" } }],
    },
    "10001",
  );
  if (observation.kind !== "message") throw new Error("message expected");
  recordObservation(h.orm, observation.observation, "00000000-0000-0000-0000-000000000001");
  new ConversationEventRepository(h.db).ingestOneBotEvent(
    observation.observation.eventKey,
    "11111111-1111-4111-8111-111111111111",
  );
  return h;
}

/** This fixture's real open onebot11 conversation id (through ensureOneBot). */
function realConversationId(h: BusinessDbHandle): string {
  const row = h.orm
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(eq(schema.conversations.sourceId, "11111111-1111-4111-8111-111111111111"))
    .get();
  if (!row) throw new Error("fixture conversation missing");
  return row.id;
}

/**
 * A real foreign conversation: second binding of the SAME account+agent (a
 * different group), activated through the same production ensureOneBot path —
 * so the row exists, is onebot11, open, default-user — but it belongs to
 * another conversation, never this event's.
 */
function foreignConversationId(h: BusinessDbHandle): string {
  const scheme = h.orm.select({ id: schema.qqSchemes.id }).from(schema.qqSchemes).get();
  if (!scheme) throw new Error("fixture scheme missing");
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: "22222222-2222-4222-8222-222222222222",
      accountId: "10001",
      conversationKind: "group",
      peerId: "40004",
      agentId: "00000000-0000-0000-0000-000000000001",
      schemeId: scheme.id,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  const foreign = new ConversationEventRepository(h.db).ensureOneBot(
    "22222222-2222-4222-8222-222222222222",
  );
  if (!foreign) throw new Error("foreign conversation fixture missing");
  return foreign.id;
}

function adapter(
  calls: { count: number },
  note = "合成的图片描述",
  seenOwners: unknown[] = [],
): QqMediaReadAdapter {
  return {
    capabilities: ["image"] as const,
    read: async (input) => {
      calls.count++;
      seenOwners.push(input.owner);
      return note;
    },
  };
}

const guardOk: MediaTaskSourceGuard = () => {};

describe("typed QQ media task reader", () => {
  it("reads a baseline media once through the typed task ledger and records model+purpose", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const result = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(result).toMatchObject({
        kind: "described",
        purpose: "baseline",
        source: "task",
        attempt: 1,
      });
      if (result.kind === "described") {
        expect(result.taskId).toBeTruthy();
        expect(result.note).toBe("合成的图片描述");
        expect(result.model).toBe("vision-local");
      }
      expect(calls.count).toBe(1);
      // 旧行级 attempts 不被 typed 路径动：typed 任务是唯一账本。
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
      // 结果只进 typed 任务，旧行 note 不被 typed 结果覆盖。
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
      const tasks = h.orm.select().from(schema.qqMediaReadTasks).all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ status: "succeeded", note: "合成的图片描述" });
    } finally {
      h.close();
    }
  });

  it("passes the host-supplied RunOwner through to the adapter unchanged", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const seenOwners: unknown[] = [];
      const owner = {
        kind: "qq_binding" as const,
        id: "11111111-1111-4111-8111-111111111111",
        userId: DEFAULT_USER_ID,
        agentId: "00000000-0000-0000-0000-000000000001",
      };
      const result = await readQqMediaTaskOnce(
        h.orm,
        adapter(calls, "合成的图片描述", seenOwners),
        { ...base, purpose: "baseline", addressedToAssistant: true, assertCurrent: guardOk, owner },
      );
      expect(result.kind).toBe("described");
      expect(calls.count).toBe(1);
      // The adapter receives the caller's owner verbatim — not a fabricated
      // qq_media pseudo-owner.
      expect(seenOwners[0]).toEqual(owner);
    } finally {
      h.close();
    }
  });

  it("rejects an invalid owner (wrong kind / missing id / wrong user or agent) before any task", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const badOwners: unknown[] = [
        // Fake conversation kind with a group id — not a real conversation scope.
        {
          kind: "qq_conversation",
          id: "30003",
          userId: DEFAULT_USER_ID,
          agentId: "00000000-0000-0000-0000-000000000001",
        },
        // Missing id.
        {
          kind: "qq_binding",
          userId: DEFAULT_USER_ID,
          agentId: "00000000-0000-0000-0000-000000000001",
        },
        // Empty id.
        {
          kind: "qq_binding",
          id: "",
          userId: DEFAULT_USER_ID,
          agentId: "00000000-0000-0000-0000-000000000001",
        },
        // Missing userId.
        {
          kind: "qq_binding",
          id: "11111111-1111-4111-8111-111111111111",
          agentId: "00000000-0000-0000-0000-000000000001",
        },
        // Cross-agent: the binding's real agent differs.
        {
          kind: "qq_binding",
          id: "11111111-1111-4111-8111-111111111111",
          userId: DEFAULT_USER_ID,
          agentId: "99999999-9999-4999-8999-999999999999",
        },
        // Missing agentId.
        { kind: "qq_binding", id: "11111111-1111-4111-8111-111111111111", userId: DEFAULT_USER_ID },
        // Foreign same-agent binding: a REAL binding row of the same account and
        // agent, but another conversation's binding — never this event's scope.
        {
          kind: "qq_binding",
          id: "22222222-2222-4222-8222-222222222222",
          userId: DEFAULT_USER_ID,
          agentId: "00000000-0000-0000-0000-000000000001",
        },
        // Fabricated conversation id: no real conversations row exists.
        {
          kind: "conversation",
          id: "00000000-0000-4000-8000-00000000dead",
          userId: DEFAULT_USER_ID,
          agentId: "00000000-0000-0000-0000-000000000001",
        },
        // Real conversation row but owner agent differs from the event's agent.
        {
          kind: "conversation",
          id: realConversationId(h),
          userId: DEFAULT_USER_ID,
          agentId: "99999999-9999-4999-8999-999999999999",
        },
        // Real conversation row of a DIFFERENT binding (foreign actual
        // conversation): channel/topology/agent match but sourceId belongs to
        // another binding, so it is not this event's conversation.
        {
          kind: "conversation",
          id: foreignConversationId(h),
          userId: DEFAULT_USER_ID,
          agentId: "00000000-0000-0000-0000-000000000001",
        },
      ];
      for (const owner of badOwners) {
        await expect(
          readQqMediaTaskOnce(h.orm, adapter(calls), {
            ...base,
            purpose: "baseline",
            addressedToAssistant: true,
            assertCurrent: guardOk,
            owner,
          } as never),
        ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      }
      expect(calls.count).toBe(0);
      expect(h.orm.select().from(schema.qqMediaReadTasks).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("gives the adapter a raw media ref whose revision matches the row's real attempts", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const seenRefs: (SourceRef | undefined)[] = [];
      const capturing = {
        capabilities: ["image"] as const,
        read: async (input: { source?: SourceRef }) => {
          calls.count++;
          seenRefs.push(input.source);
          return "合成的图片描述";
        },
      };
      const result = await readQqMediaTaskOnce(h.orm, capturing, {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(result.kind).toBe("described");
      expect(calls.count).toBe(1);
      // The raw ref names the original media (kind qq_media = the original
      // media row, not the task), and its revision is the row's REAL attempts
      // counter (0 on a fresh row) — exactly what context-access re-verifies.
      const ref = seenRefs[0];
      expect(ref).toMatchObject({
        kind: "qq_media",
        id: mediaNoteRow(h.orm, base.eventKey, 0)?.id,
        revision: "0",
      });
      // The ref is actually available through sourceAccess under the real
      // owner: revision String(row.attempts) matches, owner is the real
      // binding's default-user/agent.
      expect(
        sourceAccess(h.db, ref as SourceRef, base.owner, { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("available");
      // The task's claim count does not move the raw ref's revision semantics:
      // after a consumed attempt the row still carries its own counter, and a
      // second (supplement-proven) read keeps minting refs from row.attempts.
    } finally {
      h.close();
    }
  });

  it("serves a matching succeeded task from cache without a new call or attempt", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const first = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(first.kind).toBe("described");
      // Same model + policy: cached described, zero extra model calls.
      const second = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(second).toMatchObject({ kind: "described", source: "cache", attempt: 1 });
      if (second.kind === "described" && first.kind === "described") {
        expect(second.taskId).toBe(first.taskId);
        expect(second.note).toBe(first.note);
      }
      expect(calls.count).toBe(1);
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
    } finally {
      h.close();
    }
  });

  it("refuses a cache mismatch (different policy) as unreadable, no reset, no reuse", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const first = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(first.kind).toBe("described");
      // Different policy on the same task identity: the result cache does not
      // match, the attempt budget is not reset, and no new task is forked.
      const second = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        policy: "test-policy-2",
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(second).toEqual({ kind: "unreadable", reason: "cache_mismatch" });
      expect(calls.count).toBe(1);
    } finally {
      h.close();
    }
  });

  it("requires a question anchor guard for detail reads and none for baseline", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      // detail without the host anchor guard: rejected before any claim.
      await expect(
        readQqMediaTaskOnce(h.orm, adapter(calls), {
          ...base,
          purpose: "detail",
          questionKey: normalizeQuestionKey("图里写了什么字？"),
          addressedToAssistant: true,
          assertCurrent: guardOk,
        } as never),
      ).rejects.toThrow();
      expect(calls.count).toBe(0);
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
      // baseline with a question guard is a contract violation too (the type
      // union forbids it statically; this checks the runtime defense).
      await expect(
        readQqMediaTaskOnce(h.orm, adapter(calls), {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: guardOk,
          assertQuestionCurrent: guardOk,
        } as never),
      ).rejects.toThrow();
      expect(calls.count).toBe(0);
    } finally {
      h.close();
    }
  });

  it("runs a detail read with the anchor guard merged into the claim transaction", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      let anchorChecked = 0;
      const anchorGuard: MediaTaskSourceGuard = () => {
        anchorChecked++;
      };
      const result = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        purpose: "detail",
        questionKey: normalizeQuestionKey("图里写了什么字？"),
        assertQuestionCurrent: anchorGuard,
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(result).toMatchObject({ kind: "described", purpose: "detail", source: "task" });
      expect(anchorChecked).toBeGreaterThan(0);
      expect(calls.count).toBe(1);
    } finally {
      h.close();
    }
  });

  it("matches only a real 0052 legacy succeeded task as the baseline legacy cache", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      // Legacy success as migration 0052 imported it: a real task row with
      // policy='legacy', the historical model, and the note on the media row.
      const row0 = mediaNoteRow(h.orm, base.eventKey, 0);
      h.orm
        .update(schema.qqMediaNotes)
        .set({ note: "旧成功描述", noteModel: "vision-old", updatedAt: nowIso() })
        .run();
      h.orm
        .insert(schema.qqMediaReadTasks)
        .values({
          id: `legacy-${row0?.id}`,
          mediaNoteId: row0?.id ?? "",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId: "00000000-0000-0000-0000-000000000001",
          purpose: "baseline",
          questionKey: null,
          modelName: "vision-old",
          policy: "legacy",
          attempts: 1,
          status: "succeeded",
          note: "旧成功描述",
          revision: 1,
          expiresAt: row0?.expiresAt ?? nowIso(),
          recordedAt: nowIso(),
        })
        .run();
      const result = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        modelConfig: { visionModelName: "vision-old", transcriptionModelName: null },
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      // The legacy task is served as cache when the configured model matches
      // the historical model; no new call, no new task, no attempt spend.
      expect(result).toMatchObject({
        kind: "described",
        source: "legacy",
        model: "vision-old",
        note: "旧成功描述",
      });
      expect(calls.count).toBe(0);
      // legacy 缓存命中不动旧行：note/attempts 逐字保持。
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBe("旧成功描述");
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.noteModel).toBe("vision-old");
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
      // A different configured model is a cache mismatch (no reset, no reuse,
      // no new task identity) — per RED requirement "cachedmodelpolicymismatch
      // 拒 noreset".
      const second = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        modelConfig: { visionModelName: "vision-local", transcriptionModelName: null },
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(second).toEqual({ kind: "unreadable", reason: "cache_mismatch" });
      expect(calls.count).toBe(0);
    } finally {
      h.close();
    }
  });

  it("does not serve a taskless legacy note as typed cache and does not import it as a task", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      // A note with no attempts and no task row: not a real 0052 legacy import
      // (that requires attempts > 0). The typed entry does not treat it as a
      // cache, does not mint a success task for it, and reads normally.
      h.orm
        .update(schema.qqMediaNotes)
        .set({ note: "复用链描述", noteModel: "vision-local", updatedAt: nowIso() })
        .run();
      const result = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(result).toMatchObject({ kind: "described", source: "task", attempt: 1 });
      expect(calls.count).toBe(1);
      // No fabricated imported task: the only task row is the real new read.
      const tasks = h.orm.select().from(schema.qqMediaReadTasks).all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id.startsWith("legacy-")).toBe(false);
      expect(tasks[0]).toMatchObject({ policy: "test-policy-1", status: "succeeded" });
      // 旧行 note 与 attempts 原样保持，不被新 typed 读取覆盖。
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBe("复用链描述");
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
    } finally {
      h.close();
    }
  });

  it("refuses legacy_task_missing instead of resetting consumed attempts", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      // A row with consumed attempts but no legacy task row: not a state a
      // real 0052 migration produces. The typed entry refuses instead of
      // opening a fresh task that would silently reset the consumed budget.
      h.orm.update(schema.qqMediaNotes).set({ attempts: 1, updatedAt: nowIso() }).run();
      const result = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(result).toEqual({ kind: "unreadable", reason: "legacy_task_missing" });
      expect(calls.count).toBe(0);
      expect(h.orm.select().from(schema.qqMediaReadTasks).all()).toHaveLength(0);
      // The consumed attempt evidence on the row is untouched.
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(1);
    } finally {
      h.close();
    }
  });

  it("imports a real 0052 baseline row: legacy model/policy/attempts/status/cap preserved", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      // The real 0052 import: a consumed baseline row (attempts>0) gets exactly
      // one legacy task with the row's historical model, real attempts, and
      // expiry, status failed (no note). Nothing is zeroed.
      h.orm
        .update(schema.qqMediaNotes)
        .set({ attempts: 1, updatedAt: nowIso(), expiresAt: "2099-01-01T00:00:00.000Z" })
        .run();
      const row0 = mediaNoteRow(h.orm, base.eventKey, 0);
      h.orm
        .insert(schema.qqMediaReadTasks)
        .values({
          id: `legacy-${row0?.id}`,
          mediaNoteId: row0?.id ?? "",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId: "00000000-0000-0000-0000-000000000001",
          purpose: "baseline",
          questionKey: null,
          modelName: "vision-old",
          policy: "legacy",
          attempts: 1,
          status: "failed",
          note: null,
          revision: 1,
          expiresAt: row0?.expiresAt ?? nowIso(),
          recordedAt: nowIso(),
        })
        .run();
      // A baseline read on the consumed row with a different configured model:
      // the legacy task IS the baseline identity — its consumed failed attempt
      // counts (never reset by a model change), so the next claim is attempt 2
      // and requires host-proven supplement evidence. Zero calls, zero new
      // tasks, the row's consumed evidence is untouched.
      const mismatched = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(mismatched).toEqual({ kind: "unreadable", reason: "awaiting_supplement" });
      expect(calls.count).toBe(0);
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(1);
      const tasks = h.orm.select().from(schema.qqMediaReadTasks).all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ status: "failed", attempts: 1, policy: "legacy" });
    } finally {
      h.close();
    }
  });

  it("allows a fresh detail read on a legacy-consumed row whose real baseline exists", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      let anchorChecked = 0;
      const anchorGuard: MediaTaskSourceGuard = () => {
        anchorChecked++;
      };
      const seenRefs: (SourceRef | undefined)[] = [];
      // Real 0052 state: baseline consumed once (legacy task imported), then a
      // brand-new detail question — the detail read must NOT be gated by the
      // baseline row's consumed attempts (spec §8.1: separate readTask).
      h.orm.update(schema.qqMediaNotes).set({ attempts: 1, updatedAt: nowIso() }).run();
      const row0 = mediaNoteRow(h.orm, base.eventKey, 0);
      h.orm
        .insert(schema.qqMediaReadTasks)
        .values({
          id: `legacy-${row0?.id}`,
          mediaNoteId: row0?.id ?? "",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId: "00000000-0000-0000-0000-000000000001",
          purpose: "baseline",
          questionKey: null,
          modelName: "vision-old",
          policy: "legacy",
          attempts: 1,
          status: "failed",
          note: null,
          revision: 1,
          expiresAt: row0?.expiresAt ?? nowIso(),
          recordedAt: nowIso(),
        })
        .run();
      const capturing = {
        capabilities: ["image"] as const,
        read: async (input: { source?: SourceRef }) => {
          calls.count++;
          seenRefs.push(input.source);
          return "合成的图片描述";
        },
      };
      const result = await readQqMediaTaskOnce(h.orm, capturing, {
        ...base,
        purpose: "detail",
        questionKey: normalizeQuestionKey("图里写了什么字？"),
        assertQuestionCurrent: anchorGuard,
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(result).toMatchObject({ kind: "described", purpose: "detail", source: "task" });
      expect(calls.count).toBe(1);
      // The legacy baseline row and its task are untouched; the consumed
      // baseline budget is not zeroed by the detail read.
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(1);
      expect(anchorChecked).toBeGreaterThan(0);
      // On the consumed row the raw ref revision matches the row's REAL
      // attempts (1) — not the task's claim attempt — and re-verifies available.
      expect(seenRefs[0]).toMatchObject({ kind: "qq_media", id: row0?.id, revision: "1" });
      expect(
        sourceAccess(
          h.db,
          seenRefs[0] as SourceRef,
          base.owner,
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      const tasks = h.orm
        .select()
        .from(schema.qqMediaReadTasks)
        .where(eq(schema.qqMediaReadTasks.purpose, "detail"))
        .all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ status: "succeeded", purpose: "detail" });
      // Same question again is a detail cache hit — no new task, no new call.
      const second = await readQqMediaTaskOnce(h.orm, capturing, {
        ...base,
        purpose: "detail",
        questionKey: normalizeQuestionKey("图里写了什么字？"),
        assertQuestionCurrent: anchorGuard,
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(second).toMatchObject({ kind: "described", source: "cache" });
      expect(calls.count).toBe(1);
      expect(
        h.orm
          .select()
          .from(schema.qqMediaReadTasks)
          .where(eq(schema.qqMediaReadTasks.purpose, "detail"))
          .all(),
      ).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("blocks the second attempt without a host-proven supplement and allows it with one", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const failing = {
        capabilities: ["image"] as const,
        read: async () => {
          calls.count++;
          throw new Error("transport down");
        },
      };
      const first = await readQqMediaTaskOnce(h.orm, failing, {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(first).toMatchObject({ kind: "failed", attempt: 1, awaitSupplement: true });
      expect(calls.count).toBe(1);
      // No supplement proof: blocked before any new claim.
      const blocked = await readQqMediaTaskOnce(h.orm, failing, {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        relatedSupplementArrived: true,
        assertCurrent: guardOk,
      });
      expect(blocked).toEqual({ kind: "unreadable", reason: "awaiting_supplement" });
      expect(calls.count).toBe(1);
      // Host evidence callback proves a genuinely later supplement: attempt 2.
      const second = await readQqMediaTaskOnce(h.orm, failing, {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        relatedSupplementArrived: true,
        proveSupplementLaterThan: () => true,
        assertCurrent: guardOk,
      });
      expect(second).toMatchObject({ kind: "failed", attempt: 2 });
      expect(calls.count).toBe(2);
      // Budget exhausted: further calls refuse without touching the model.
      const exhausted = await readQqMediaTaskOnce(h.orm, failing, {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        relatedSupplementArrived: true,
        proveSupplementLaterThan: () => true,
        assertCurrent: guardOk,
      });
      expect(exhausted).toEqual({ kind: "unreadable", reason: "attempts_exhausted" });
      expect(calls.count).toBe(2);
    } finally {
      h.close();
    }
  });

  it("refuses a second attempt when addressedToAssistant is false, before any claim", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const failing = {
        capabilities: ["image"] as const,
        read: async () => {
          calls.count++;
          throw new Error("transport down");
        },
      };
      const first = await readQqMediaTaskOnce(h.orm, failing, {
        ...base,
        purpose: "baseline",
        addressedToAssistant: false,
        assertCurrent: guardOk,
      });
      expect(first).toMatchObject({ kind: "failed", attempt: 1 });
      const blocked = await readQqMediaTaskOnce(h.orm, failing, {
        ...base,
        purpose: "baseline",
        addressedToAssistant: false,
        relatedSupplementArrived: true,
        proveSupplementLaterThan: () => true,
        assertCurrent: guardOk,
      });
      expect(blocked).toEqual({ kind: "unreadable", reason: "not_addressed" });
      expect(calls.count).toBe(1);
    } finally {
      h.close();
    }
  });

  it("propagates a moved-source authority failure from the claim guard without writing anything", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const rejectingGuard: MediaTaskSourceGuard = () => {
        throw Object.assign(new Error("authority moved"), { code: "CONTEXT_SOURCE_INVALID" });
      };
      await expect(
        readQqMediaTaskOnce(h.orm, adapter(calls), {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: rejectingGuard,
        }),
      ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(calls.count).toBe(0);
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
    } finally {
      h.close();
    }
  });

  it("rejects a late description after cancellation and preserves the consumed attempt as failed", async () => {
    const h = setup();
    try {
      const controller = new AbortController();
      const pending = readQqMediaTaskOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            controller.abort();
            return "迟到的描述";
          },
        },
        {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: guardOk,
        },
        controller.signal,
      );
      await expect(pending).rejects.toThrow();
      // The attempt was claimed, so it is recorded failed (consumed) — and no
      // late cache/note is written.
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
      const tasks = h.orm.select().from(schema.qqMediaReadTasks).all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ attempts: 1, status: "failed" });
    } finally {
      h.close();
    }
  });

  it("propagates the exact abort reason object after a claimed cancellation", async () => {
    const h = setup();
    try {
      const controller = new AbortController();
      const reason = new Error("user cancelled the read");
      const pending = readQqMediaTaskOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            controller.abort(reason);
            return "迟到的描述";
          },
        },
        {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: guardOk,
        },
        controller.signal,
      );
      await expect(pending).rejects.toBe(reason);
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
    } finally {
      h.close();
    }
  });

  it("refuses a foreign same-agent owner on the cache consumption path too", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const first = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(first.kind).toBe("described");
      // A foreign same-agent owner (real binding of another conversation) never
      // consumes this conversation's cache — the owner boundary runs on the
      // cache path exactly as on the claim path.
      const foreignOwner = {
        kind: "qq_binding" as const,
        id: "22222222-2222-4222-8222-222222222222",
        userId: DEFAULT_USER_ID,
        agentId: "00000000-0000-0000-0000-000000000001",
      };
      foreignConversationId(h); // ensure the foreign binding/conversation really exist
      await expect(
        readQqMediaTaskOnce(h.orm, adapter(calls), {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: guardOk,
          owner: foreignOwner,
        } as never),
      ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(calls.count).toBe(1);
      // The cache task is untouched (still the only row, still succeeded).
      const tasks = h.orm.select().from(schema.qqMediaReadTasks).all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ status: "succeeded" });
    } finally {
      h.close();
    }
  });

  it("rolls back zero task rows when the claim guard aborts inside its transaction", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const controller = new AbortController();
      const reason = new Error("abort inside claim guard");
      // Signal-only guard: it aborts and returns normally. The reader's checked
      // guard must re-check the signal INSIDE the immediate claim transaction —
      // the guard's own throw would not exercise that.
      const abortOnlyGuard: MediaTaskSourceGuard = () => {
        controller.abort(reason);
      };
      await expect(
        readQqMediaTaskOnce(
          h.orm,
          adapter(calls),
          {
            ...base,
            purpose: "baseline",
            addressedToAssistant: true,
            assertCurrent: abortOnlyGuard,
          },
          controller.signal,
        ),
      ).rejects.toBe(reason);
      expect(calls.count).toBe(0);
      expect(h.orm.select().from(schema.qqMediaReadTasks).all()).toHaveLength(0);
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
    } finally {
      h.close();
    }
  });

  it("surfaces the exact abort reason when the guard aborts on the cache consumption path", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const first = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
      });
      expect(first.kind).toBe("described");
      const controller = new AbortController();
      const reason = new Error("abort at cache guard");
      // Signal-only: the guard aborts and returns normally — the cache
      // consumption must still refuse (never serve the cached described result
      // to an already-cancelled caller).
      const abortOnlyGuard: MediaTaskSourceGuard = () => {
        controller.abort(reason);
      };
      // Cache hit path: the checked guard runs before the cached result is
      // served — the abort reason propagates as-is, nothing else is consumed.
      await expect(
        readQqMediaTaskOnce(
          h.orm,
          adapter(calls),
          {
            ...base,
            purpose: "baseline",
            addressedToAssistant: true,
            assertCurrent: abortOnlyGuard,
          },
          controller.signal,
        ),
      ).rejects.toBe(reason);
      expect(calls.count).toBe(1);
      const tasks = h.orm.select().from(schema.qqMediaReadTasks).all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ status: "succeeded" });
    } finally {
      h.close();
    }
  });

  it("propagates the exact abort reason after a result-transaction cancellation and publishes the consumed attempt as failed", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const controller = new AbortController();
      const reason = new Error("abort at result guard");
      // First guard call (claim) passes cleanly; only the SECOND call — inside
      // the result publication transaction — aborts. The adapter itself never
      // aborts, so the only cancellation source is the result-guard window.
      let guardCalls = 0;
      const pending = readQqMediaTaskOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            calls.count++;
            return "结果守卫前的描述";
          },
        },
        {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: () => {
            guardCalls++;
            if (guardCalls > 1) controller.abort(reason);
          },
        },
        controller.signal,
      );
      await expect(pending).rejects.toBe(reason);
      expect(guardCalls).toBeGreaterThan(1);
      expect(calls.count).toBe(1);
      // The result was never published (no note, nothing cached). The cleanup
      // is a domain guard: it does not consult the signal, so the consumed
      // attempt is published failed — a cancellation is not an authority
      // refusal and never leaves a running orphan or a late cache.
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
      const tasks = h.orm.select().from(schema.qqMediaReadTasks).all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ attempts: 1, status: "failed" });
    } finally {
      h.close();
    }
  });

  it("refuses a wrong-channel conversation owner sharing the binding's source id", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      // A real open `web` conversation row whose sourceId equals THIS binding's
      // id: legal under the 0040 DDL (source_id has no typed FK and
      // UNIQUE(channel,source_id) is per-channel), but it is not this event's
      // onebot11 conversation — the owner boundary must refuse it before any
      // task or adapter call.
      h.orm
        .insert(schema.conversations)
        .values({
          id: "33333333-3333-4333-8333-333333333333",
          channel: "web",
          topology: "shared",
          sourceId: "11111111-1111-4111-8111-111111111111",
          agentId: "00000000-0000-0000-0000-000000000001",
          userId: DEFAULT_USER_ID,
          bindingEpoch: 1,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          closedAt: null,
        })
        .run();
      await expect(
        readQqMediaTaskOnce(h.orm, adapter(calls), {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: guardOk,
          owner: {
            kind: "conversation" as const,
            id: "33333333-3333-4333-8333-333333333333",
            userId: DEFAULT_USER_ID,
            agentId: "00000000-0000-0000-0000-000000000001",
          },
        } as never),
      ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(calls.count).toBe(0);
      expect(h.orm.select().from(schema.qqMediaReadTasks).all()).toHaveLength(0);
      // The onebot11 activation itself stays untouched and unambiguous.
      expect(
        h.orm
          .select({ id: schema.conversations.id })
          .from(schema.conversations)
          .where(eq(schema.conversations.channel, "onebot11"))
          .all(),
      ).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("accepts the real open onebot11 conversation owner and serves it from cache", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const conversationOwner = {
        kind: "conversation" as const,
        id: realConversationId(h),
        userId: DEFAULT_USER_ID,
        agentId: "00000000-0000-0000-0000-000000000001",
      };
      const first = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
        owner: conversationOwner,
      });
      expect(first).toMatchObject({ kind: "described", purpose: "baseline", source: "task" });
      expect(calls.count).toBe(1);
      // The same real conversation owner consumes the typed result cache with
      // zero extra model calls and no new task rows.
      const second = await readQqMediaTaskOnce(h.orm, adapter(calls), {
        ...base,
        purpose: "baseline",
        addressedToAssistant: true,
        assertCurrent: guardOk,
        owner: conversationOwner,
      });
      expect(second).toMatchObject({ kind: "described", source: "cache", attempt: 1 });
      expect(calls.count).toBe(1);
      const tasks = h.orm.select().from(schema.qqMediaReadTasks).all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ status: "succeeded" });
    } finally {
      h.close();
    }
  });

  it("refuses the result when the binding's authority revision drifts during the adapter read", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      // The binding's authorityRevision moves while the model call is in
      // flight. The reader's OWN domainGuard (not the host guard) must refuse
      // the result publication — the host guard stays a normal return so the
      // reader's re-verification is what is under test.
      const pending = readQqMediaTaskOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            calls.count++;
            // The contract moves both revisions together (authority change ⇒
            // revision + authorityRevision both advance; the DDL CHECK
            // authority_revision <= revision refuses a lone authority bump).
            h.orm
              .update(schema.qqBindings)
              .set({ revision: 7, authorityRevision: 7, updatedAt: nowIso() })
              .where(eq(schema.qqBindings.id, "11111111-1111-4111-8111-111111111111"))
              .run();
            return "漂移后到达的描述";
          },
        },
        {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: guardOk,
        },
      );
      await expect(pending).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(calls.count).toBe(1);
      // Nothing was published: no note, no succeeded cache; the consumed
      // attempt stays visible in its exact claimed state for recovery.
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
      const tasks = h.orm.select().from(schema.qqMediaReadTasks).all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ status: "running", attempts: 1 });
    } finally {
      h.close();
    }
  });

  it("re-runs the question anchor guard on a detail cache hit without a new call", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      let anchorChecked = 0;
      const anchorGuard: MediaTaskSourceGuard = () => {
        anchorChecked++;
      };
      const input = {
        ...base,
        purpose: "detail" as const,
        questionKey: normalizeQuestionKey("图里写了什么字？"),
        assertQuestionCurrent: anchorGuard,
        addressedToAssistant: true,
        assertCurrent: guardOk,
      };
      const first = await readQqMediaTaskOnce(h.orm, adapter(calls), input);
      expect(first.kind).toBe("described");
      const checksAfterFirst = anchorChecked;
      expect(checksAfterFirst).toBeGreaterThan(0);
      const second = await readQqMediaTaskOnce(h.orm, adapter(calls), input);
      expect(second).toMatchObject({ kind: "described", source: "cache" });
      expect(calls.count).toBe(1);
      // The question guard ran again at the cache consumption boundary.
      expect(anchorChecked).toBeGreaterThan(checksAfterFirst);
    } finally {
      h.close();
    }
  });

  it("refuses a detail cache hit when the question anchor guard rejects", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      let rejectAnchor = false;
      const anchorGuard: MediaTaskSourceGuard = () => {
        if (rejectAnchor) {
          throw Object.assign(new Error("question moved"), { code: "CONTEXT_SOURCE_INVALID" });
        }
      };
      const input = {
        ...base,
        purpose: "detail" as const,
        questionKey: normalizeQuestionKey("图里写了什么字？"),
        assertQuestionCurrent: anchorGuard,
        addressedToAssistant: true,
        assertCurrent: guardOk,
      };
      const first = await readQqMediaTaskOnce(h.orm, adapter(calls), input);
      expect(first.kind).toBe("described");
      rejectAnchor = true;
      await expect(readQqMediaTaskOnce(h.orm, adapter(calls), input)).rejects.toMatchObject({
        code: "CONTEXT_SOURCE_INVALID",
      });
      expect(calls.count).toBe(1);
      expect(h.orm.select().from(schema.qqMediaReadTasks).all()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("claims nothing and creates no task when cancelled before the claim", async () => {
    const h = setup();
    try {
      const controller = new AbortController();
      controller.abort();
      const calls = { count: 0 };
      await expect(
        readQqMediaTaskOnce(
          h.orm,
          adapter(calls),
          {
            ...base,
            purpose: "baseline",
            addressedToAssistant: true,
            assertCurrent: guardOk,
          },
          controller.signal,
        ),
      ).rejects.toThrow();
      expect(calls.count).toBe(0);
      expect(h.orm.select().from(schema.qqMediaReadTasks).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("refuses a changed source or expiry between claim and result via the result guard", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      // The host guard freezes the media expiry; during the read the row's
      // expiry is moved into the past — the result write must refuse.
      const pending = readQqMediaTaskOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            calls.count++;
            h.orm.update(schema.qqMediaNotes).set({ expiresAt: "2000-01-01T00:00:00.000Z" }).run();
            return "过期后到达的描述";
          },
        },
        {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: (tx) => {
            const row = mediaNoteRow(tx, base.eventKey, 0);
            if (!row || row.expiresAt <= new Date().toISOString()) {
              throw Object.assign(new Error("expired"), { code: "CONTEXT_SOURCE_INVALID" });
            }
          },
        },
      );
      // The reader surfaces the authority refusal as-is (never an ordinary
      // failed result): the result write refused, nothing is cached.
      await expect(pending).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(calls.count).toBe(1);
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
    } finally {
      h.close();
    }
  });

  it("refuses a changed media id between claim and result instead of claiming back", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const row0 = mediaNoteRow(h.orm, base.eventKey, 0);
      const originalId = row0?.id;
      const pending = readQqMediaTaskOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            calls.count++;
            // Simulate the media row being replaced (sweep + re-record).
            h.orm.delete(schema.qqMediaNotes).run();
            recordMediaSegment(h.orm, {
              eventKey: base.eventKey,
              segmentIndex: 0,
              kind: "image",
              sourceRef: "upstream-ref-new",
              occurredAtSeconds: Math.floor(Date.now() / 1000),
              addressed: true,
            });
            const fresh = mediaNoteRow(h.orm, base.eventKey, 0);
            expect(fresh?.id).not.toBe(originalId);
            return "换行后的描述";
          },
        },
        {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: (tx) => {
            const row = mediaNoteRow(tx, base.eventKey, 0);
            if (!row || row.id !== originalId) {
              throw Object.assign(new Error("row changed"), { code: "CONTEXT_SOURCE_INVALID" });
            }
          },
        },
      );
      // The authority refusal propagates as-is; the changed media id is never
      // claimed back and nothing is cached.
      await expect(pending).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(calls.count).toBe(1);
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
    } finally {
      h.close();
    }
  });

  it("records an ordinary transport failure silently without announcing it", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      const result = await readQqMediaTaskOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            calls.count++;
            throw new Error("boom");
          },
        },
        {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: guardOk,
        },
      );
      expect(result).toMatchObject({
        kind: "failed",
        attempt: 1,
        announceInConversation: false,
      });
      expect(calls.count).toBe(1);
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
    } finally {
      h.close();
    }
  });

  it("surfaces a cleanup-guard authority refusal instead of a failed result", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      let moved = false;
      // The source moves while the model call is in flight; the cleanup
      // (failure publication) must be refused by the guard, and the original
      // authority error surfaces — the transport failure is never turned into
      // an ordinary failed result.
      const pending = readQqMediaTaskOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            calls.count++;
            moved = true;
            throw new Error("transport down");
          },
        },
        {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: () => {
            if (moved) {
              throw Object.assign(new Error("authority moved"), { code: "CONTEXT_SOURCE_INVALID" });
            }
          },
        },
      );
      await expect(pending).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(calls.count).toBe(1);
      // The task is not force-written: the running attempt stays for recovery.
      const tasks = h.orm.select().from(schema.qqMediaReadTasks).all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ status: "running", attempts: 1 });
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the authority code when the cleanup error is a plain code match, not an AppError", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      let moved = false;
      const pending = readQqMediaTaskOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            calls.count++;
            moved = true;
            throw Object.assign(new Error("plain authority"), { code: "CONTEXT_SOURCE_INVALID" });
          },
        },
        {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: () => {
            if (moved) {
              throw Object.assign(new Error("authority moved"), { code: "CONTEXT_SOURCE_INVALID" });
            }
          },
        },
      );
      // The plain (non-AppError) authority error is preserved with its code,
      // never rewritten into a generic failed result.
      await expect(pending).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(calls.count).toBe(1);
    } finally {
      h.close();
    }
  });

  it("keeps the legacy unreadable pre-guards without spending anything", async () => {
    const h = setup();
    try {
      const calls = { count: 0 };
      // Paused binding.
      h.orm
        .update(schema.qqBindings)
        .set({ paused: 1 })
        .where(eq(schema.qqBindings.id, "11111111-1111-4111-8111-111111111111"))
        .run();
      expect(
        await readQqMediaTaskOnce(h.orm, adapter(calls), {
          ...base,
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: guardOk,
        }),
      ).toEqual({ kind: "unreadable", reason: "binding_inactive" });
      // Missing segment.
      expect(
        await readQqMediaTaskOnce(h.orm, adapter(calls), {
          ...base,
          eventKey: "no-such-event",
          purpose: "baseline",
          addressedToAssistant: true,
          assertCurrent: guardOk,
        }),
      ).toEqual({ kind: "unreadable", reason: "segment_missing" });
      expect(calls.count).toBe(0);
      expect(h.orm.select().from(schema.qqMediaReadTasks).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
});
