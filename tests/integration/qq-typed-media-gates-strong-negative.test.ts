// T08 Step5 Important-round strong negatives for the media gate predicate (spec §8.1):
// purpose-matched resolution, relational cross-carrier identity, no fake-succeeded release,
// and the purge's same-transaction revoke of source-cleared successes.

import { describe, expect, it } from "bun:test";
import {
  attemptedUnreadMediaCount,
  purgeExpiredMediaNotes,
} from "../../src/server/db/qq-media-repository";
import { mediaReadTaskIdentityKey } from "../../src/server/db/qq-media-task-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { prepareQqJudgement } from "../../src/server/services/qq-judgement-preparation";
import { QQ_PROMPT_DEFAULTS } from "../../src/server/services/qq-prompt-contract";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const agentId = "00000000-0000-0000-0000-000000000001";
const now = 2_000_000_000;
const at = new Date(now * 1000).toISOString();
const liveExpiry = new Date((now + 14 * 86400) * 1000).toISOString();
const pastExpiry = new Date((now - 86400) * 1000).toISOString();
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  event(h.orm, "old");
  event(h.orm, "latest");
  event(h.orm, "other");
  return h;
}

function event(orm: Orm, key: string, overrides: { peerId?: string; agentId?: string } = {}) {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey: key,
      accountId: "10001",
      conversationKind: "group",
      peerId: overrides.peerId ?? "30003",
      agentId: overrides.agentId ?? agentId,
      messageId: key,
      occurredAtSeconds: now - 40,
      speakerKind: "member",
      speakerId: "20002",
      recordedAt: nowIso(),
    })
    .run();
}

function mediaRow(
  orm: Orm,
  eventKey: string,
  overrides: {
    attempts?: number;
    note?: string | null;
    noteModel?: string | null;
    expiresAt?: string;
  } = {},
) {
  return orm
    .insert(schema.qqMediaNotes)
    .values({
      id: crypto.randomUUID(),
      eventKey,
      segmentIndex: 0,
      segmentKind: "image",
      sourceRef: "qq-media://synthetic",
      note: overrides.note ?? null,
      noteModel: overrides.noteModel ?? null,
      attempts: overrides.attempts ?? 0,
      addressed: 0,
      expiresAt: overrides.expiresAt ?? liveExpiry,
      recordedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .returning()
    .get();
}

function asset(orm: Orm, sha: string, overrides: { peerId?: string; agentId?: string } = {}) {
  const id = crypto.randomUUID();
  orm
    .insert(schema.qqMediaAssets)
    .values({
      id,
      accountId: "10001",
      conversationKind: "group",
      peerId: overrides.peerId ?? "30003",
      agentId: overrides.agentId ?? agentId,
      contentSha256: sha,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      revision: 1,
      expiresAt: liveExpiry,
      recordedAt: nowIso(),
    })
    .run();
  return id;
}

function assetSource(orm: Orm, assetId: string, mediaNoteId: string) {
  const id = crypto.randomUUID();
  orm
    .insert(schema.qqMediaAssetSources)
    .values({ id, assetId, mediaNoteId, expiresAt: liveExpiry, recordedAt: nowIso() })
    .run();
  return id;
}

type Seed = {
  mediaNoteId?: string;
  assetSourceId?: string | null;
  identityKey?: string | null;
  status: "running" | "failed" | "succeeded";
  purpose?: "baseline" | "detail";
  questionKey?: string;
  attempts?: number;
  note?: string;
  modelName?: string;
  expiresAt?: string;
  peerId?: string;
  agentId?: string;
};

function taskRow(orm: Orm, seed: Seed) {
  orm
    .insert(schema.qqMediaReadTasks)
    .values({
      id: crypto.randomUUID(),
      mediaNoteId: seed.mediaNoteId ?? null,
      assetSourceId: seed.assetSourceId ?? null,
      identityKey: seed.identityKey ?? null,
      accountId: "10001",
      conversationKind: "group",
      peerId: seed.peerId ?? "30003",
      agentId: seed.agentId ?? agentId,
      purpose: seed.purpose ?? "baseline",
      questionKey: seed.questionKey ?? null,
      modelName: seed.modelName ?? null,
      policy: "baseline/v1/synthetic",
      attempts: seed.attempts ?? 1,
      status: seed.status,
      note: seed.note ?? null,
      revision: 1,
      expiresAt: seed.expiresAt ?? liveExpiry,
      recordedAt: nowIso(),
    })
    .run();
}

const gate = (orm: Orm, keys: string[]) => attemptedUnreadMediaCount(orm, keys, at);

describe("purpose-matched resolution (a detail success never clears a baseline failure)", () => {
  it("a live detail success does not resolve a failed baseline task on the same picture", () => {
    const h = setup();
    try {
      const row = mediaRow(h.orm, "latest");
      taskRow(h.orm, { mediaNoteId: row.id, status: "failed", purpose: "baseline", attempts: 1 });
      taskRow(h.orm, {
        mediaNoteId: row.id,
        status: "succeeded",
        purpose: "detail",
        questionKey: "什么品种",
        note: "橘猫",
        modelName: "vision-a",
      });
      expect(gate(h.orm, ["latest"])).toBe(1);
    } finally {
      h.close();
    }
  });

  it("a live baseline success with a real readable result resolves the baseline failure", () => {
    const h = setup();
    try {
      const row = mediaRow(h.orm, "latest", { attempts: 1 });
      taskRow(h.orm, {
        mediaNoteId: row.id,
        status: "succeeded",
        purpose: "baseline",
        attempts: 1,
        note: "一只橘猫趴在键盘上",
        modelName: "vision-a",
      });
      expect(gate(h.orm, ["latest"])).toBe(0);
    } finally {
      h.close();
    }
  });

  it("a succeeded task with a dead window does not resolve the same-content failure", () => {
    const h = setup();
    try {
      const assetId = asset(h.orm, SHA_A);
      const oldNote = mediaRow(h.orm, "old");
      const sourceId = assetSource(h.orm, assetId, oldNote.id);
      taskRow(h.orm, {
        mediaNoteId: oldNote.id,
        assetSourceId: sourceId,
        status: "failed",
        attempts: 2,
      });
      const newNote = mediaRow(h.orm, "latest");
      const newSource = assetSource(h.orm, assetId, newNote.id);
      // Same content, same purpose — but the result's window is dead: no resolution.
      taskRow(h.orm, {
        mediaNoteId: newNote.id,
        assetSourceId: newSource,
        status: "succeeded",
        purpose: "baseline",
        attempts: 1,
        note: "橘猫",
        modelName: "vision-a",
        expiresAt: pastExpiry,
      });
      expect(gate(h.orm, ["latest"])).toBe(1);
    } finally {
      h.close();
    }
  });

  it("a success in another scope does not resolve this conversation's failure", () => {
    const h = setup();
    try {
      const assetId = asset(h.orm, SHA_A);
      const oldNote = mediaRow(h.orm, "old");
      const sourceId = assetSource(h.orm, assetId, oldNote.id);
      taskRow(h.orm, {
        mediaNoteId: oldNote.id,
        assetSourceId: sourceId,
        status: "failed",
        attempts: 2,
      });
      const newNote = mediaRow(h.orm, "latest");
      const newSource = assetSource(h.orm, assetId, newNote.id);
      taskRow(h.orm, {
        mediaNoteId: newNote.id,
        assetSourceId: newSource,
        status: "succeeded",
        purpose: "baseline",
        attempts: 1,
        note: "橘猫",
        modelName: "vision-a",
        peerId: "40004",
      });
      expect(gate(h.orm, ["latest"])).toBe(1);
    } finally {
      h.close();
    }
  });

  it("a live same-content same-purpose success resolves the failed task (typed variant)", () => {
    const h = setup();
    try {
      const assetId = asset(h.orm, SHA_A);
      const oldNote = mediaRow(h.orm, "old");
      const sourceId = assetSource(h.orm, assetId, oldNote.id);
      taskRow(h.orm, {
        mediaNoteId: oldNote.id,
        assetSourceId: sourceId,
        status: "failed",
        attempts: 2,
      });
      const newNote = mediaRow(h.orm, "latest");
      const newSource = assetSource(h.orm, assetId, newNote.id);
      taskRow(h.orm, {
        mediaNoteId: newNote.id,
        assetSourceId: newSource,
        status: "succeeded",
        purpose: "baseline",
        attempts: 1,
        note: "一只橘猫趴在键盘上",
        modelName: "vision-a",
      });
      expect(gate(h.orm, ["latest"])).toBe(0);
    } finally {
      h.close();
    }
  });
});

describe("relational cross-carrier identity (same asset = same content; no sourceRef guessing)", () => {
  it("a failed task hanging on an OLD carrier still blocks the NEW carrier of the same content", () => {
    const h = setup();
    try {
      const assetId = asset(h.orm, SHA_A);
      const oldNote = mediaRow(h.orm, "old");
      const sourceId = assetSource(h.orm, assetId, oldNote.id);
      taskRow(h.orm, {
        mediaNoteId: oldNote.id,
        assetSourceId: sourceId,
        status: "failed",
        attempts: 2,
      });
      // The new carrier of the SAME bytes: fresh note, zero attempts, no task pointing at it.
      const newNote = mediaRow(h.orm, "latest");
      assetSource(h.orm, assetId, newNote.id);
      expect(gate(h.orm, ["latest"])).toBe(1);
    } finally {
      h.close();
    }
  });

  it("a failed task of DIFFERENT content does not block the new carrier", () => {
    const h = setup();
    try {
      const oldAsset = asset(h.orm, SHA_A);
      const otherAsset = asset(h.orm, SHA_B);
      const oldNote = mediaRow(h.orm, "old");
      const sourceId = assetSource(h.orm, oldAsset, oldNote.id);
      taskRow(h.orm, {
        mediaNoteId: oldNote.id,
        assetSourceId: sourceId,
        status: "failed",
        attempts: 2,
      });
      const newNote = mediaRow(h.orm, "latest");
      assetSource(h.orm, otherAsset, newNote.id);
      expect(gate(h.orm, ["latest"])).toBe(0);
    } finally {
      h.close();
    }
  });

  it("the same content in ANOTHER scope never blocks this conversation", () => {
    const h = setup();
    try {
      const otherAsset = asset(h.orm, SHA_A, { peerId: "40004" });
      const oldNote = mediaRow(h.orm, "old");
      const sourceId = assetSource(h.orm, otherAsset, oldNote.id);
      taskRow(h.orm, {
        mediaNoteId: oldNote.id,
        assetSourceId: sourceId,
        status: "failed",
        attempts: 2,
        peerId: "40004",
      });
      const newNote = mediaRow(h.orm, "latest");
      assetSource(h.orm, asset(h.orm, SHA_A), newNote.id);
      expect(gate(h.orm, ["latest"])).toBe(0);
    } finally {
      h.close();
    }
  });

  it("a cross-carrier baseline success resolves the new carrier's legacy row-level failure", () => {
    const h = setup();
    try {
      const assetId = asset(h.orm, SHA_A);
      const oldNote = mediaRow(h.orm, "old");
      const sourceId = assetSource(h.orm, assetId, oldNote.id);
      taskRow(h.orm, {
        mediaNoteId: oldNote.id,
        assetSourceId: sourceId,
        status: "succeeded",
        purpose: "baseline",
        attempts: 2,
        note: "一只橘猫趴在键盘上",
        modelName: "vision-a",
      });
      const newNote = mediaRow(h.orm, "latest", { attempts: 1 });
      assetSource(h.orm, assetId, newNote.id);
      expect(gate(h.orm, ["latest"])).toBe(0);
    } finally {
      h.close();
    }
  });
});

describe("the purge revokes source-cleared successes in the same transaction", () => {
  it("deleting a note cascades its source and flips a consuming success to failed (budget kept)", () => {
    const h = setup();
    try {
      event(h.orm, "gone");
      const assetId = asset(h.orm, SHA_A);
      const note = mediaRow(h.orm, "gone", { expiresAt: pastExpiry });
      const sourceId = assetSource(h.orm, assetId, note.id);
      taskRow(h.orm, {
        mediaNoteId: note.id,
        assetSourceId: sourceId,
        status: "succeeded",
        attempts: 1,
        note: "橘猫",
        modelName: "vision-a",
      });
      expect(purgeExpiredMediaNotes(h.orm, at)).toBe(1);
      const rows = h.orm.select().from(schema.qqMediaReadTasks).all();
      expect(rows).toHaveLength(1);
      // The cascade that removed the source row also SET NULLs the task's asset_source_id;
      // the revoke already ran (status/note/model/revision), the ledger budget survives.
      expect(rows[0]).toMatchObject({
        status: "failed",
        note: null,
        modelName: null,
        attempts: 1,
        assetSourceId: null,
        mediaNoteId: null,
      });
      // The revoked window ends at the purge moment (min(expiry, at)) — it cannot keep
      // posing as a live success anywhere.
      expect(Date.parse(rows[0].expiresAt)).toBeLessThanOrEqual(Date.parse(at));
      // The note is physically gone; its source cascaded with it.
      expect(h.orm.select().from(schema.qqMediaNotes).all()).toHaveLength(0);
      expect(h.orm.select().from(schema.qqMediaAssetSources).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("a revoked (source-cleared) success never keeps suppressing the gate — legacy failure blocks again", () => {
    const h = setup();
    try {
      const assetId = asset(h.orm, SHA_A);
      // The expired carrier whose source the success consumed — purge will delete it.
      const goneNote = mediaRow(h.orm, "old", { expiresAt: pastExpiry });
      const sourceId = assetSource(h.orm, assetId, goneNote.id);
      taskRow(h.orm, {
        mediaNoteId: goneNote.id,
        assetSourceId: sourceId,
        status: "succeeded",
        purpose: "baseline",
        attempts: 2,
        note: "一只橘猫趴在键盘上",
        modelName: "vision-a",
      });
      // The live carrier of the same content: legacy row-level failure, no note.
      const liveNote = mediaRow(h.orm, "latest", { attempts: 1 });
      assetSource(h.orm, assetId, liveNote.id);
      // Before the purge the readable success resolves the legacy failure...
      expect(gate(h.orm, ["latest"])).toBe(0);
      // ...the source dies with the purge: the result is revoked (never resurrected) and the
      // gate must see the legacy failure again — no fake success suppression.
      expect(purgeExpiredMediaNotes(h.orm, at)).toBe(1);
      const rows = h.orm.select().from(schema.qqMediaReadTasks).all();
      expect(rows[0]).toMatchObject({
        status: "failed",
        note: null,
        modelName: null,
        attempts: 2,
      });
      expect(gate(h.orm, ["latest"])).toBe(1);
    } finally {
      h.close();
    }
  });

  it("identity-key lookup: a NULL-source failed task on the old carrier blocks the new carrier of the same bytes", () => {
    const h = setup();
    try {
      const assetId = asset(h.orm, SHA_A);
      // Old carrier: the task was claimed before any asset link existed — asset_source_id NULL,
      // ledger hangs on the old note. Production reader shape.
      const oldNote = mediaRow(h.orm, "old");
      // The ledger row carries the REAL identity key minted at record time (controlled bytes).
      const identityKey = mediaReadTaskIdentityKey({
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId,
        segmentKind: "image",
        purpose: "baseline",
        questionKey: null,
        contentSha256: SHA_A,
      });
      taskRow(h.orm, { mediaNoteId: oldNote.id, status: "failed", attempts: 1, identityKey });
      // The new carrier of the same bytes: live asset (controlled sha), zero attempts, no task.
      const newNote = mediaRow(h.orm, "latest");
      assetSource(h.orm, assetId, newNote.id);
      // Same-content identity via the note's live asset sha; different content never matches.
      const otherAssetId = asset(h.orm, SHA_B);
      const otherNote = mediaRow(h.orm, "other");
      assetSource(h.orm, otherAssetId, otherNote.id);
      expect(gate(h.orm, ["latest"])).toBe(1);
      expect(gate(h.orm, ["other"])).toBe(0);
    } finally {
      h.close();
    }
  });

  it("unified content list: a failed DETAIL task on the old carrier blocks the new carrier of the same bytes", () => {
    const h = setup();
    try {
      const assetId = asset(h.orm, SHA_A);
      const oldNote = mediaRow(h.orm, "old");
      const identityKey = mediaReadTaskIdentityKey({
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId,
        segmentKind: "image",
        purpose: "detail",
        questionKey: "什么品种",
        contentSha256: SHA_A,
      });
      taskRow(h.orm, {
        mediaNoteId: oldNote.id,
        status: "failed",
        purpose: "detail",
        questionKey: "什么品种",
        attempts: 1,
        identityKey,
      });
      const newNote = mediaRow(h.orm, "latest");
      const newSource = assetSource(h.orm, assetId, newNote.id);
      expect(gate(h.orm, ["latest"])).toBe(1);
      // A different question's detail success does NOT resolve this question's failure.
      taskRow(h.orm, {
        mediaNoteId: newNote.id,
        assetSourceId: newSource,
        status: "succeeded",
        purpose: "detail",
        questionKey: "什么颜色",
        attempts: 1,
        note: "橘色",
        modelName: "vision-a",
      });
      expect(gate(h.orm, ["latest"])).toBe(1);
    } finally {
      h.close();
    }
  });

  it("identity-NULL legacy ledger rows never participate in the content-identity lookup", () => {
    const h = setup();
    try {
      const assetId = asset(h.orm, SHA_A);
      // An unidentifiable history row: identity_key NULL, hung on the old carrier. Per spec it
      // keeps row-level identity, never merges, and never blocks a NEW identity's budget.
      const oldNote = mediaRow(h.orm, "old", { attempts: 2 });
      taskRow(h.orm, { mediaNoteId: oldNote.id, status: "failed", attempts: 2, identityKey: null });
      // The new carrier of the same bytes: live asset, zero attempts, no keyed task.
      const newNote = mediaRow(h.orm, "latest");
      assetSource(h.orm, assetId, newNote.id);
      expect(gate(h.orm, ["latest"])).toBe(0);
    } finally {
      h.close();
    }
  });

  it("a purge with nothing to delete revokes nothing", () => {
    const h = setup();
    try {
      event(h.orm, "gone");
      const assetId = asset(h.orm, SHA_A);
      const note = mediaRow(h.orm, "gone");
      const sourceId = assetSource(h.orm, assetId, note.id);
      taskRow(h.orm, {
        mediaNoteId: note.id,
        assetSourceId: sourceId,
        status: "succeeded",
        attempts: 1,
        note: "橘猫",
        modelName: "vision-a",
      });
      expect(purgeExpiredMediaNotes(h.orm, at)).toBe(0);
      const rows = h.orm.select().from(schema.qqMediaReadTasks).all();
      expect(rows[0]).toMatchObject({ status: "succeeded", note: "橘猫" });
    } finally {
      h.close();
    }
  });
});

/** Full judgement fixture (settings + scheme + binding) so prepareQqJudgement can run. */
function prepareSetup() {
  const h = setup();
  updateQqSettings(h.orm, {
    accountId: "10001",
    enabled: true,
    expectedRevision: 1,
  });
  const scheme = createQqScheme(h.orm, {
    name: "synthetic",
    triggers: {
      direct_reply: false,
      follow_up: false,
      chiming_in: true,
      idle_topic: true,
    },
    prompts: { ...QQ_PROMPT_DEFAULTS, judge: "自定义判断任务" },
  });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: "11111111-1111-4111-8111-111111111111",
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId,
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
  return h;
}

describe("native read proof relaxes only rows a successful model call actually consumed", () => {
  const bindingId = "11111111-1111-4111-8111-111111111111";
  const request = () => ({ bindingId, path: "chiming_in", nowSeconds: now });
  const sourceRefs = [{ kind: "qq_media_source", id: "src-1" }] as never;

  const prepare = (
    h: ReturnType<typeof prepareSetup>,
    proofs: ReadonlyArray<{ mediaNoteId: string; proof: unknown }>,
  ) =>
    prepareQqJudgement(h.orm, request(), {
      // Cast: the suite deliberately simulates misbehaving/legacy hosts that return
      // non-conforming proofs; the gate must treat every non-conforming shape as "no proof".
      nativeReadProof: (({ mediaNoteIds }: { mediaNoteIds: readonly string[] }) =>
        mediaNoteIds.map((id) => ({
          mediaNoteId: id,
          proof: proofs.find((p) => p.mediaNoteId === id)?.proof ?? null,
        }))) as never,
    });

  it("a model_consumed proof with real consumed sources relieves the legacy-failed row", () => {
    const h = prepareSetup();
    try {
      const note = mediaRow(h.orm, "latest", { attempts: 1 });
      const result = prepare(h, [
        {
          mediaNoteId: note.id,
          proof: { kind: "model_consumed", consumedAt: at, sourceRefs },
        },
      ]);
      expect(result.kind).toBe("prepared");
    } finally {
      h.close();
    }
  });

  it("prepared inventory alone never relieves the gate", () => {
    const h = prepareSetup();
    try {
      const note = mediaRow(h.orm, "latest", { attempts: 1 });
      const result = prepare(h, [
        { mediaNoteId: note.id, proof: { kind: "prepared_inventory", preparedAt: at } },
      ]);
      expect(result).toEqual({ kind: "blocked", reason: "media_read_failed" });
    } finally {
      h.close();
    }
  });

  it("MODEL_IMAGE_UNSUPPORTED (failed model call) never relieves the gate", () => {
    const h = prepareSetup();
    try {
      mediaRow(h.orm, "latest", { attempts: 1 });
      const result = prepare(h, [
        {
          mediaNoteId: "whatever",
          proof: { kind: "model_unsupported", reason: "MODEL_IMAGE_UNSUPPORTED" },
        },
      ]);
      expect(result).toEqual({ kind: "blocked", reason: "media_read_failed" });
    } finally {
      h.close();
    }
  });

  it("a successful native fetch that never reached a model call never relieves the gate", () => {
    const h = prepareSetup();
    try {
      mediaRow(h.orm, "latest", { attempts: 1 });
      const result = prepare(h, [{ mediaNoteId: "whatever", proof: { kind: "fetched_unsent" } }]);
      expect(result).toEqual({ kind: "blocked", reason: "media_read_failed" });
    } finally {
      h.close();
    }
  });

  it("phase off — the raw image never entered the wire — never relieves the gate", () => {
    const h = prepareSetup();
    try {
      mediaRow(h.orm, "latest", { attempts: 1 });
      const result = prepare(h, [{ mediaNoteId: "whatever", proof: null }]);
      expect(result).toEqual({ kind: "blocked", reason: "media_read_failed" });
    } finally {
      h.close();
    }
  });

  it("revoked sources — the producer's guard fails at proof time and returns null — never relieve the gate", () => {
    const h = prepareSetup();
    try {
      mediaRow(h.orm, "latest", { attempts: 1 });
      // The producer's contract: its assertCurrent fails for a revoked source → proof MUST be null.
      // The gate trusts the callback and does not re-verify source authorization itself.
      const result = prepare(h, [{ mediaNoteId: "whatever", proof: null }]);
      expect(result).toEqual({ kind: "blocked", reason: "media_read_failed" });
    } finally {
      h.close();
    }
  });

  it("light input consistency: unrequested ids, duplicates and future consumedAt never exempt", () => {
    const h = prepareSetup();
    try {
      const note = mediaRow(h.orm, "latest", { attempts: 1 });
      // A response for an id the gate never asked about must not exempt anything...
      const wrongId = prepare(h, [
        {
          mediaNoteId: "not-requested",
          proof: { kind: "model_consumed", consumedAt: at, sourceRefs },
        },
      ]);
      expect(wrongId).toEqual({ kind: "blocked", reason: "media_read_failed" });
      // ...a consumedAt in the future is not a valid success fact...
      const future = prepare(h, [
        {
          mediaNoteId: note.id,
          proof: {
            kind: "model_consumed",
            consumedAt: new Date((now + 3600) * 1000).toISOString(),
            sourceRefs,
          },
        },
      ]);
      expect(future).toEqual({ kind: "blocked", reason: "media_read_failed" });
      // ...and duplicates collapse without effect: one valid entry still relieves exactly this row.
      const duplicated = prepare(h, [
        { mediaNoteId: note.id, proof: { kind: "model_consumed", consumedAt: at, sourceRefs } },
        { mediaNoteId: note.id, proof: { kind: "model_consumed", consumedAt: at, sourceRefs } },
      ]);
      expect(duplicated.kind).toBe("prepared");
    } finally {
      h.close();
    }
  });

  it("a host without proof support (option absent) keeps the legacy failure blocking", () => {
    const h = prepareSetup();
    try {
      mediaRow(h.orm, "latest", { attempts: 1 });
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "media_read_failed",
      });
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 初始资格探询（initialNativeReadEligibility，§8.1）的消费端契约。
//
// 这里只证明一件事：消费端对宿主回调的**集合覆盖**契约。
// 回调是合成 stub，**不连网络、不开 server、不动 harness**；真 HTTP 闭环（真实 gateway
// 真发图、真消费、真出站）属后续单独授权的测试，不在本文件、不在本轮。
//
// 分层语义（不可混）：本回调是「可尝试」，不是「已理解」。产物仍是原 prepared，
// 它不代替 model_consumed 产生的真实许可——那一个已有用例不因本回调而放宽。
// ---------------------------------------------------------------------------

describe("initial native-read eligibility defers the legacy failure only when every failed row is offered", () => {
  const bindingId = "11111111-1111-4111-8111-111111111111";
  const request = () => ({ bindingId, path: "chiming_in", nowSeconds: now });
  // `as const`：不否则对象字面量被放宽为 string，与函数返回的联合类型不匹配。
  const blocked = { kind: "blocked", reason: "media_read_failed" } as const;

  /**
   * 宿主回调的**完整**输入形状（与 options 声明逐字一致）：它还会拿到 scope 与 now，
   * 但本类测试的 stub 不对这两项做断言——它们的判定在宿主闭包内，不是消费端这层的事。
   */
  type Eligibility = (input: {
    scope: unknown;
    mediaNoteIds: readonly string[];
    now: string;
  }) => readonly string[];

  const prepareWith = (h: ReturnType<typeof prepareSetup>, eligibility?: Eligibility) =>
    prepareQqJudgement(h.orm, request(), {
      ...(eligibility === undefined ? {} : { initialNativeReadEligibility: eligibility }),
    });

  it("default (no callback) keeps the legacy failure strictly blocking", () => {
    const h = prepareSetup();
    try {
      mediaRow(h.orm, "latest", { attempts: 1 });
      expect(prepareWith(h)).toEqual(blocked);
    } finally {
      h.close();
    }
  });

  it("an empty offer never defers — 空返回不是「都能试」", () => {
    const h = prepareSetup();
    try {
      mediaRow(h.orm, "latest", { attempts: 1 });
      expect(prepareWith(h, () => [])).toEqual(blocked);
    } finally {
      h.close();
    }
  });

  it("covering every failed row defers the initial gate and still returns the plain prepared result", () => {
    const h = prepareSetup();
    try {
      const note = mediaRow(h.orm, "latest", { attempts: 1 });
      const result = prepareWith(h, ({ mediaNoteIds }) => mediaNoteIds);
      // 产物仍是原 prepared（仅资格）：既无新状态、无新字段、无许可。
      expect(result.kind).toBe("prepared");
      if (result.kind === "prepared") expect(result.path).toBe("chiming_in");
      expect(note.id).toBeTruthy();
    } finally {
      h.close();
    }
  });

  it("a partial offer never defers — 一张焦点图不能放任窗口里无关失败行解锁", () => {
    const h = prepareSetup();
    try {
      // 两个失败行分属不同消息，都在本轮窗口内。
      mediaRow(h.orm, "latest", { attempts: 1 });
      mediaRow(h.orm, "other", { attempts: 1 });
      // 宿主只能为其中一个供图（那尠 focus 图）→ 不全覆盖 → 照旧阻断。
      expect(prepareWith(h, ({ mediaNoteIds }) => mediaNoteIds.slice(0, 1))).toEqual(blocked);
    } finally {
      h.close();
    }
  });

  it("unrequested or missing ids in the offer never defer", () => {
    const h = prepareSetup();
    try {
      const note = mediaRow(h.orm, "latest", { attempts: 1 });
      // 宿主返回的是自己猜的另一个 id，不是闸门问的那个 → 阻断。
      expect(prepareWith(h, () => ["not-requested"])).toEqual(blocked);
      // 要么就报了真正被问的那个。尽管它同时报了那个，额外的未知 id 也不能被当成「都能尝试」。
      expect(prepareWith(h, () => [note.id, "not-requested"])).toEqual(blocked);
    } finally {
      h.close();
    }
  });

  it("duplicates in the offer never count as extra coverage", () => {
    const h = prepareSetup();
    try {
      const note = mediaRow(h.orm, "latest", { attempts: 1 });
      mediaRow(h.orm, "other", { attempts: 1 });
      // 重复拼同一个 id 不能被当成覆盖了两行。
      expect(prepareWith(h, () => [note.id, note.id, note.id])).toEqual(blocked);
      // 两行都合法且都报了，但多报一个同名 id：形状不可信 → 照旧阻断。
      // 这条是新增的强负：旧版只测了「缺一个合法 id」，覆盖不了「全部合法+重复」。
      expect(prepareWith(h, ({ mediaNoteIds }) => [...mediaNoteIds, ...mediaNoteIds])).toEqual(
        blocked,
      );
    } finally {
      h.close();
    }
  });

  it("a throwing authority callback passes through — 权限复验失败不被吞掉当成「可尝试」", () => {
    const h = prepareSetup();
    try {
      mediaRow(h.orm, "latest", { attempts: 1 });
      expect(() =>
        prepareWith(h, () => {
          throw new Error("SOURCE_REVOKED");
        }),
      ).toThrow("SOURCE_REVOKED");
    } finally {
      h.close();
    }
  });

  it("rows already proven by a real model_consumed are not re-offered and do not need eligibility", () => {
    const h = prepareSetup();
    try {
      const provenNote = mediaRow(h.orm, "latest", { attempts: 1 });
      const pendingNote = mediaRow(h.orm, "other", { attempts: 1 });
      const sourceRefs: readonly SourceRef[] = [
        { kind: "qq_media_source", id: "src-1", revision: "1" },
      ];
      // 已有真实证据行不进 pending 集合：宿主只需覆盖剩下那个。
      const result = prepareQqJudgement(h.orm, request(), {
        nativeReadProof: ({ mediaNoteIds }) =>
          mediaNoteIds.map((id) => ({
            mediaNoteId: id,
            proof:
              id === provenNote.id
                ? { kind: "model_consumed" as const, consumedAt: at, sourceRefs }
                : null,
          })),
        initialNativeReadEligibility: ({ mediaNoteIds }) => {
          // 若宿主被要求重报已 proven 的行，这里会看到额外的 id ——日志证明不会。
          return mediaNoteIds.filter((id) => id === pendingNote.id);
        },
      });
      expect(result.kind).toBe("prepared");
    } finally {
      h.close();
    }
  });
});
