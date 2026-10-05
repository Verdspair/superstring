import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  assertContextSources,
  inspectContext,
  sourceAccess,
} from "../../src/server/agent/context-access";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  linkMediaAssetSource,
  purgeExpiredMediaAssets,
  recordMediaAsset,
} from "../../src/server/db/qq-media-asset-repository";
import {
  attemptMediaReadTask,
  findMediaReadTasksForContent,
  findServableMediaReadTaskByIdentity,
  MediaReadTaskRejectedError,
  type MediaTaskSourceGuard,
  recordMediaReadTaskResult,
} from "../../src/server/db/qq-media-task-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { qqStorageCleanupExecute } from "../../src/server/db/qq-storage-repository";
import { DEFAULT_USER_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import {
  type QqMediaReadAdapter,
  readQqMediaTaskOnce,
} from "../../src/server/services/qq-media-reader";
import { createQqMediaSourceRef } from "../../src/server/services/qq-media-sources";
import {
  createQqMediaReadTaskSourceRef,
  qqMediaReadTaskSourceAccess,
} from "../../src/server/services/qq-media-task-sources";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";

const AGENT = "00000000-0000-0000-0000-000000000001";
const ACCOUNT = "90003";
const PEER = "32001";
const BINDING_ID = "33333333-3333-4333-8333-333333333333";
const AT = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const LONG = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  const scheme = createQqScheme(h.orm, { name: "link-lifecycle-test" });
  updateQqSettings(h.orm, { accountId: ACCOUNT, enabled: true, expectedRevision: 1 });
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,paused,share_web_memory,memory_batch_size,owner_identity_revision,revision,authority_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,0,0,NULL,NULL,1,1,?,?)",
    )
    .run(BINDING_ID, ACCOUNT, "group", PEER, AGENT, scheme.id, nowIso(), nowIso());
  const journal = new ConversationEventRepository(h.db);
  const opened = journal.ensureOneBot(BINDING_ID);
  if (!opened) throw new Error("conversation fixture missing");
  const scope: QqConversationScope = {
    conversationId: opened.id,
    accountId: ACCOUNT,
    conversationKind: "group",
    peerId: PEER,
    agentId: AGENT,
    bindingId: BINDING_ID,
    bindingEpoch: opened.bindingEpoch,
    authorityRevision: 1,
  };
  const guard: MediaTaskSourceGuard = (tx) => {
    const binding = tx
      .select({
        agentId: schema.qqBindings.agentId,
        authorityRevision: schema.qqBindings.authorityRevision,
      })
      .from(schema.qqBindings)
      .where(eq(schema.qqBindings.id, BINDING_ID))
      .get();
    if (!binding || binding.agentId !== AGENT || binding.authorityRevision !== 1) {
      throw new Error("CONTEXT_SOURCE_INVALID: binding moved");
    }
  };
  return {
    h,
    db: h.db,
    conversationId: opened.id,
    scope,
    guard,
    bindingEpoch: opened.bindingEpoch,
  };
}

describe("true same-ref lifecycle: link consumed → purged → the ORIGINAL ref never revives", () => {
  it("mint-before-consumed-link stays fail-closed after link expiry/purge/SET NULL; stored context revokes", async () => {
    const f = setup();
    try {
      const observation = normalizeOneBotMessage(
        {
          time: AT,
          self_id: Number(ACCOUNT),
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -71000 - Math.floor(Math.random() * 10000),
          user_id: 10001,
          group_id: Number(PEER),
          sender: { card: "阿林", nickname: "阿林" },
          message: [
            { type: "image", data: { file: "picture.png", url: "https://example.test/p" } },
          ],
        },
        ACCOUNT,
      );
      if (observation.kind !== "message") throw new Error("message expected");
      recordObservation(f.h.orm, observation.observation, AGENT);
      if (
        !new ConversationEventRepository(f.db).ingestOneBotEvent(
          observation.observation.eventKey,
          BINDING_ID,
        )
      )
        throw new Error("ingest failed");
      const media = f.db
        .query("SELECT id FROM qq_media_notes WHERE event_key=?")
        .get(observation.observation.eventKey) as { id: string } | null;
      if (!media) throw new Error("media missing");

      // 1) The consumed chain: live asset + SHORT-window link (the true consumption cap).
      const shortLink = new Date(Date.now() + 60_000).toISOString();
      const bytes = new Uint8Array([137, 80, 78, 71, 42]);
      const contentSha = createHash("sha256").update(bytes).digest("hex");
      const { asset } = recordMediaAsset(f.h.orm, {
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        bytes,
        mimeType: "image/png",
        expiresAt: LONG,
      });
      const link = linkMediaAssetSource(f.h.orm, {
        assetId: asset.id,
        mediaNoteId: media.id,
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        expiresAt: shortLink,
      });

      // 2) The real claim + result, then bind the task to the exact consumed link.
      const claimed = await attemptMediaReadTask(f.h.orm, {
        mediaNoteId: media.id,
        purpose: "baseline",
        modelName: "vision-synthetic",
        policy: "p1",
        contentSha256: contentSha,
        assertCurrent: f.guard,
      });
      recordMediaReadTaskResult(f.h.orm, {
        mediaNoteId: media.id,
        purpose: "baseline",
        note: "橘猫在沙发上睡觉",
        modelName: "vision-synthetic",
        expectedAttempts: claimed.attempt,
        claimToken: claimed.claimToken,
        assertCurrent: f.guard,
      });
      f.db
        .query("UPDATE qq_media_read_tasks SET asset_source_id=? WHERE media_note_id=?")
        .run(link.id, media.id);
      const task = f.db
        .query("SELECT id, asset_source_id FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(media.id) as { id: string; asset_source_id: string };
      expect(task.asset_source_id).toBe(link.id);
      const atNow = nowIso();

      // 3) The ORIGINAL ref minted BEFORE the purge: available, capped by the LINK window.
      const refBefore = createQqMediaReadTaskSourceRef(f.h, f.scope, task.id, atNow);
      expect(refBefore).not.toBeNull();
      if (!refBefore) return;
      expect(
        refBefore.expiresAt !== undefined &&
          Date.parse(refBefore.expiresAt) <= Date.parse(shortLink),
      ).toBe(true);
      const owner = {
        kind: "conversation" as const,
        id: f.conversationId,
        userId: DEFAULT_USER_ID,
        agentId: AGENT,
      };
      const principal = { userId: DEFAULT_USER_ID };
      expect(qqMediaReadTaskSourceAccess(f.db, refBefore, owner, principal, atNow)).toBe(
        "available",
      );

      // 4) The link expires; the source-only purge deletes the link row → FK SET NULL on the task.
      // (No nonterminal run holds a minted ref yet — the stored-context surface is created after the
      // purge so the held-ref protection cannot block the source deletion this lifecycle exercises.)
      const sweep = new Date(Date.now() + 120_000).toISOString();
      expect(Date.parse(sweep) > Date.parse(shortLink)).toBe(true);
      f.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE id=?")
        .run(new Date(Date.parse(atNow) + 1000).toISOString(), link.id);
      expect(purgeExpiredMediaAssets(f.h.orm, sweep)).toBe(0);
      const after = f.db
        .query("SELECT asset_source_id FROM qq_media_read_tasks WHERE id=?")
        .get(task.id) as { asset_source_id: string | null };
      expect(after.asset_source_id).toBeNull();
      const linkRow = f.db.query("SELECT id FROM qq_media_asset_sources WHERE id=?").get(link.id);
      expect(linkRow).toBeNull();

      // 6) The ref persists in a REAL durable run step (the stored-context surface) — created now, holding
      // the ORIGINAL ref object minted before the purge.
      const runs = new AgentRunRepository(f.db);
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      runs.createRun({ runId, specId: "main", specVersion: "1", owner, at: sweep });
      runs.startStep({
        runId,
        stepId,
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: sweep,
        messages: [{ role: "user", content: [{ kind: "text", text: "整理这段输出" }] }],
        sources: [refBefore],
      });
      expect(inspectContext(f.db, runs, { runId, stepId }, principal, sweep)?.status).toBe(
        "expired",
      );

      // 7) The ORIGINAL ref after the purge: the old verdict at its frozen cap is expired — never available.
      const verdict = qqMediaReadTaskSourceAccess(f.db, refBefore, owner, principal, sweep);
      expect(verdict).toBe("expired");
      expect(sourceAccess(f.db, refBefore, owner, principal, sweep)).toBe("expired");

      // 8) The STORED context re-read: not exact, messages gone; the boundary re-assert throws.
      const inspected = inspectContext(f.db, runs, { runId, stepId }, principal, sweep);
      if (inspected === null) throw new Error("inspect must return a verdict, not null");
      expect(inspected.status).not.toBe("exact");
      expect(runs.getContext({ runId, stepId })?.messages).toBeNull();
      expect(() =>
        assertContextSources({
          db: f.db,
          sources: [refBefore],
          owner,
          now: sweep,
          memoryRevisions: () => new Map(),
          messages: { memory: "", other: "读取受保护来源" },
        }),
      ).toThrow();
    } finally {
      f.h.close();
    }
  });
});

describe("after the consumed link is purged, a NEW mint must not serve the dead-source description", () => {
  it("a fresh mint after the purge refuses: the consumed source is gone, the budget ledger stays", async () => {
    const f = setup();
    try {
      const observation = normalizeOneBotMessage(
        {
          time: AT,
          self_id: Number(ACCOUNT),
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -82000 - Math.floor(Math.random() * 10000),
          user_id: 10001,
          group_id: Number(PEER),
          sender: { card: "阿林", nickname: "阿林" },
          message: [
            { type: "image", data: { file: "picture.png", url: "https://example.test/p" } },
          ],
        },
        ACCOUNT,
      );
      if (observation.kind !== "message") throw new Error("message expected");
      recordObservation(f.h.orm, observation.observation, AGENT);
      if (
        !new ConversationEventRepository(f.db).ingestOneBotEvent(
          observation.observation.eventKey,
          BINDING_ID,
        )
      )
        throw new Error("ingest failed");
      const media = f.db
        .query("SELECT id FROM qq_media_notes WHERE event_key=?")
        .get(observation.observation.eventKey) as { id: string } | null;
      if (!media) throw new Error("media missing");
      const shortLink = new Date(Date.now() + 60_000).toISOString();
      const bytes = new Uint8Array([137, 80, 78, 71, 43]);
      const contentSha = createHash("sha256").update(bytes).digest("hex");
      const { asset } = recordMediaAsset(f.h.orm, {
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        bytes,
        mimeType: "image/png",
        expiresAt: LONG,
      });
      const link = linkMediaAssetSource(f.h.orm, {
        assetId: asset.id,
        mediaNoteId: media.id,
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        expiresAt: shortLink,
      });
      const claimed = await attemptMediaReadTask(f.h.orm, {
        mediaNoteId: media.id,
        purpose: "baseline",
        modelName: "vision-synthetic",
        policy: "p1",
        contentSha256: contentSha,
        assertCurrent: f.guard,
      });
      recordMediaReadTaskResult(f.h.orm, {
        mediaNoteId: media.id,
        purpose: "baseline",
        note: "橘猫在沙发上睡觉",
        modelName: "vision-synthetic",
        expectedAttempts: claimed.attempt,
        claimToken: claimed.claimToken,
        assertCurrent: f.guard,
      });
      f.db
        .query("UPDATE qq_media_read_tasks SET asset_source_id=? WHERE media_note_id=?")
        .run(link.id, media.id);
      const task = f.db
        .query("SELECT id FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(media.id) as { id: string };

      // The link expires and the source-only purge deletes it (FK SET NULL on the task).
      const sweep = new Date(Date.now() + 120_000).toISOString();
      f.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE id=?")
        .run(new Date(Date.now() + 90_000).toISOString(), link.id);
      expect(purgeExpiredMediaAssets(f.h.orm, sweep)).toBe(0);
      const after = f.db
        .query(
          "SELECT asset_source_id, status, note, attempts, identity_key FROM qq_media_read_tasks WHERE id=?",
        )
        .get(task.id) as {
        asset_source_id: string | null;
        status: string;
        note: string | null;
        attempts: number;
        identity_key: string | null;
      };

      // THE RULING: a dead source must never serve its description. Whatever the ledger keeps
      // (identity/attempts/scope), a NEW mint after the purge must refuse.
      const refAfter = createQqMediaReadTaskSourceRef(f.h, f.scope, task.id, sweep);
      expect(refAfter).toBeNull();

      // The budget ledger survives: identity/attempts stay on the row.
      expect(after.identity_key).not.toBeNull();
      expect(after.attempts).toBe(1);
    } finally {
      f.h.close();
    }
  });
});

describe("the cleared result's remaining budget re-opens on a NEW legal carrier; protection unchanged", () => {
  it("a held source is never purgeable, and after the purge a new carrier re-claims the remaining attempt without reviving the old body", async () => {
    const f = setup();
    try {
      // --- Setup: task bound to a short-window link, succeeded (same as case 2). ---
      const observation = normalizeOneBotMessage(
        {
          time: AT,
          self_id: Number(ACCOUNT),
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -93000 - Math.floor(Math.random() * 10000),
          user_id: 10001,
          group_id: Number(PEER),
          sender: { card: "阿林", nickname: "阿林" },
          message: [
            { type: "image", data: { file: "picture.png", url: "https://example.test/p" } },
          ],
        },
        ACCOUNT,
      );
      if (observation.kind !== "message") throw new Error("message expected");
      recordObservation(f.h.orm, observation.observation, AGENT);
      if (
        !new ConversationEventRepository(f.db).ingestOneBotEvent(
          observation.observation.eventKey,
          BINDING_ID,
        )
      )
        throw new Error("ingest failed");
      const media = f.db
        .query("SELECT id FROM qq_media_notes WHERE event_key=?")
        .get(observation.observation.eventKey) as { id: string } | null;
      if (!media) throw new Error("media missing");
      const bytes = new Uint8Array([137, 80, 78, 71, 44]);
      const contentSha = createHash("sha256").update(bytes).digest("hex");
      const { asset } = recordMediaAsset(f.h.orm, {
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        bytes,
        mimeType: "image/png",
        expiresAt: LONG,
      });
      const shortLink = new Date(Date.now() + 60_000).toISOString();
      const link = linkMediaAssetSource(f.h.orm, {
        assetId: asset.id,
        mediaNoteId: media.id,
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        expiresAt: shortLink,
      });
      const claimed = await attemptMediaReadTask(f.h.orm, {
        mediaNoteId: media.id,
        purpose: "baseline",
        modelName: "vision-synthetic",
        policy: "p1",
        contentSha256: contentSha,
        assertCurrent: f.guard,
      });
      f.db
        .query("UPDATE qq_media_read_tasks SET asset_source_id=? WHERE media_note_id=?")
        .run(link.id, media.id);
      const task = f.db
        .query("SELECT id, attempts FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(media.id) as { id: string; attempts: number };

      // PROTECTION: an expired link whose task is still IN-FLIGHT (claim claimed, result not yet
      // published) is not purgeable — the exact real claim-protocol face. The link is past-dated first
      // (a real expired window), the purge clock is the REAL now.
      const sweepEarly = nowIso();
      f.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE id=?")
        .run(new Date(Date.now() - 1000).toISOString(), link.id);
      expect(purgeExpiredMediaAssets(f.h.orm, sweepEarly)).toBe(0);
      expect(
        f.db.query("SELECT id FROM qq_media_asset_sources WHERE id=?").get(link.id),
      ).not.toBeNull();

      // Resolve the claim (the exact token publishes), then purge: transition + delete.
      recordMediaReadTaskResult(f.h.orm, {
        mediaNoteId: media.id,
        purpose: "baseline",
        note: "橘猫在沙发上睡觉",
        modelName: "vision-synthetic",
        expectedAttempts: claimed.attempt,
        claimToken: claimed.claimToken,
        assertCurrent: f.guard,
      });
      expect(purgeExpiredMediaAssets(f.h.orm, sweepEarly)).toBe(0);
      const cleared = f.db
        .query(
          "SELECT status, note, model_name, attempts, expires_at FROM qq_media_read_tasks WHERE id=?",
        )
        .get(task.id) as {
        status: string;
        note: string | null;
        model_name: string | null;
        attempts: number;
        expires_at: string;
      };
      expect(cleared).toMatchObject({
        status: "failed",
        note: null,
        model_name: null,
        attempts: 1,
      });
      expect(Date.parse(cleared.expires_at)).toBeLessThanOrEqual(Date.parse(sweepEarly));

      // A NEW LEGAL CARRIER with a CURRENT live source re-claims the remaining attempt through the
      // ordinary expired-row reclaim path — no supplement gate, no reset, old body not revived.
      const obs2 = normalizeOneBotMessage(
        {
          time: AT,
          self_id: Number(ACCOUNT),
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -94000 - Math.floor(Math.random() * 10000),
          user_id: 10001,
          group_id: Number(PEER),
          sender: { card: "阿林", nickname: "阿林" },
          message: [
            { type: "image", data: { file: "picture2.png", url: "https://example.test/p2" } },
          ],
        },
        ACCOUNT,
      );
      if (obs2.kind !== "message") throw new Error("message expected");
      recordObservation(f.h.orm, obs2.observation, AGENT);
      if (
        !new ConversationEventRepository(f.db).ingestOneBotEvent(
          obs2.observation.eventKey,
          BINDING_ID,
        )
      )
        throw new Error("ingest failed");
      const media2 = f.db
        .query("SELECT id FROM qq_media_notes WHERE event_key=?")
        .get(obs2.observation.eventKey) as { id: string } | null;
      if (!media2) throw new Error("second media missing");
      const { asset: asset2 } = recordMediaAsset(f.h.orm, {
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        bytes,
        mimeType: "image/png",
        expiresAt: LONG,
      });
      linkMediaAssetSource(f.h.orm, {
        assetId: asset2.id,
        mediaNoteId: media2.id,
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        expiresAt: LONG,
      });
      const reclaimed = await attemptMediaReadTask(f.h.orm, {
        mediaNoteId: media2.id,
        purpose: "baseline",
        modelName: "vision-synthetic",
        policy: "p1",
        contentSha256: contentSha,
        assertCurrent: f.guard,
      });
      expect(reclaimed.claimed).toBe(true);
      expect(reclaimed.attempt).toBe(2);
      recordMediaReadTaskResult(f.h.orm, {
        mediaNoteId: media2.id,
        purpose: "baseline",
        note: "新载体上的重读描述",
        modelName: "vision-synthetic",
        expectedAttempts: reclaimed.attempt,
        claimToken: reclaimed.claimToken,
        assertCurrent: f.guard,
      });
      const ledger = f.db
        .query(
          "SELECT attempts, status, note FROM qq_media_read_tasks WHERE identity_key IS NOT NULL ORDER BY rowid",
        )
        .all() as { attempts: number; status: string; note: string | null }[];
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        attempts: 2,
        status: "succeeded",
        note: "新载体上的重读描述",
      });
      // The budget is fully spent on the SAME ledger row (2/2) — a third claim is refused
      // (live cache → already_succeeded), never reset.
      let refused = false;
      try {
        await attemptMediaReadTask(f.h.orm, {
          mediaNoteId: media2.id,
          purpose: "baseline",
          modelName: "vision-synthetic",
          policy: "p1",
          contentSha256: contentSha,
          assertCurrent: f.guard,
        });
      } catch (error) {
        refused =
          error instanceof MediaReadTaskRejectedError && error.reason === "already_succeeded";
      }
      expect(refused).toBe(true);
    } finally {
      f.h.close();
    }
  });
});

describe("every real source-deletion entry point closes the result-revival hole", () => {
  /** Shared: a succeeded task bound to a live short-window link; returns handles. */
  async function seedBoundTask(f: ReturnType<typeof setup>, tag: number) {
    const observation = normalizeOneBotMessage(
      {
        time: AT,
        self_id: Number(ACCOUNT),
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: -95000 - tag * 1000 - Math.floor(Math.random() * 900),
        user_id: 10001,
        group_id: Number(PEER),
        sender: { card: "阿林", nickname: "阿林" },
        message: [
          { type: "image", data: { file: `p${tag}.png`, url: `https://example.test/p${tag}` } },
        ],
      },
      ACCOUNT,
    );
    if (observation.kind !== "message") throw new Error("message expected");
    recordObservation(f.h.orm, observation.observation, AGENT);
    if (
      !new ConversationEventRepository(f.db).ingestOneBotEvent(
        observation.observation.eventKey,
        BINDING_ID,
      )
    )
      throw new Error("ingest failed");
    const media = f.db
      .query("SELECT id FROM qq_media_notes WHERE event_key=?")
      .get(observation.observation.eventKey) as { id: string } | null;
    if (!media) throw new Error("media missing");
    const bytes = new Uint8Array([137, 80, 78, 71, tag]);
    const contentSha = createHash("sha256").update(bytes).digest("hex");
    const { asset } = recordMediaAsset(f.h.orm, {
      scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
      bytes,
      mimeType: "image/png",
      expiresAt: LONG,
    });
    const link = linkMediaAssetSource(f.h.orm, {
      assetId: asset.id,
      mediaNoteId: media.id,
      scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
      expiresAt: LONG,
    });
    const claimed = await attemptMediaReadTask(f.h.orm, {
      mediaNoteId: media.id,
      purpose: "baseline",
      modelName: "vision-synthetic",
      policy: "p1",
      contentSha256: contentSha,
      assertCurrent: f.guard,
    });
    recordMediaReadTaskResult(f.h.orm, {
      mediaNoteId: media.id,
      purpose: "baseline",
      note: `描述${tag}`,
      modelName: "vision-synthetic",
      expectedAttempts: claimed.attempt,
      claimToken: claimed.claimToken,
      assertCurrent: f.guard,
    });
    f.db
      .query("UPDATE qq_media_read_tasks SET asset_source_id=? WHERE media_note_id=?")
      .run(link.id, media.id);
    const task = f.db
      .query("SELECT id FROM qq_media_read_tasks WHERE media_note_id=?")
      .get(media.id) as { id: string };
    return { mediaId: media.id, linkId: link.id, assetId: asset.id, taskId: task.id, contentSha };
  }

  it("manual storage cleanup of the asset-source category transitions the bound result: a new mint refuses", async () => {
    const f = setup();
    try {
      const bound = await seedBoundTask(f, 1);
      const sweep = new Date(Date.now() + 60_000).toISOString();
      // Past-date the source window, then run the MANUAL storage cleanup on the source category.
      f.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE id=?")
        .run(new Date(Date.now() - 1000).toISOString(), bound.linkId);
      const execution = qqStorageCleanupExecute(
        f.h.orm,
        { category: "media_notes", ids: [`asset-source:${bound.linkId}`] },
        sweep,
      );
      expect(execution.removed).toBe(1);
      const cleared = f.db
        .query("SELECT status, note, model_name FROM qq_media_read_tasks WHERE id=?")
        .get(bound.taskId) as { status: string; note: string | null; model_name: string | null };
      expect(cleared).toMatchObject({ status: "failed", note: null, model_name: null });
      // A new mint must not serve the dead-source description; the budget stays.
      expect(createQqMediaReadTaskSourceRef(f.h, f.scope, bound.taskId, sweep)).toBeNull();
      const ledger = f.db
        .query("SELECT attempts, identity_key FROM qq_media_read_tasks WHERE id=?")
        .get(bound.taskId) as { attempts: number; identity_key: string | null };
      expect(ledger).toMatchObject({ attempts: 1 });
      expect(ledger.identity_key).not.toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("deleting the ASSET (cascade to its sources) transitions the bound result too", async () => {
    const f = setup();
    try {
      const bound = await seedBoundTask(f, 2);
      const sweep = new Date(Date.now() + 60_000).toISOString();
      // Past-date BOTH the asset and the source so the manual asset face takes the asset (and cascades the source).
      f.db
        .query("UPDATE qq_media_assets SET expires_at=? WHERE id=?")
        .run(new Date(Date.now() - 1000).toISOString(), bound.assetId);
      f.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE id=?")
        .run(new Date(Date.now() - 1000).toISOString(), bound.linkId);
      const execution = qqStorageCleanupExecute(
        f.h.orm,
        { category: "media_notes", ids: [`asset:${bound.assetId}`] },
        sweep,
      );
      expect(execution.removed).toBe(1);
      const linkRow = f.db
        .query("SELECT id FROM qq_media_asset_sources WHERE id=?")
        .get(bound.linkId);
      expect(linkRow).toBeNull();
      const cleared = f.db
        .query("SELECT status, note FROM qq_media_read_tasks WHERE id=?")
        .get(bound.taskId) as { status: string; note: string | null };
      expect(cleared).toMatchObject({ status: "failed", note: null });
      expect(createQqMediaReadTaskSourceRef(f.h, f.scope, bound.taskId, sweep)).toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("only the task bound to the DOOMED source transitions; a same-content task on a live source keeps its result", async () => {
    const f = setup();
    try {
      // Two INDEPENDENT tasks (different content bytes → different identity rows, each its own budget):
      // the precision property under test is binding-scoped — only the task bound to the DOOMED source
      // transitions; a task bound to a live source keeps its result. (True same-content single-ledger
      // precision is covered by case 3's reclaim: the ledger row is one and its carrier/binding move.)
      const bytes = new Uint8Array([137, 80, 78, 71, 77]);
      const contentSha = createHash("sha256").update(bytes).digest("hex");
      const first = await seedBoundTask(f, 3);
      // Rebind the first task to its own link with a SHORT window (the doomed one).
      const shortLink = new Date(Date.now() - 1000).toISOString();
      f.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE id=?")
        .run(shortLink, first.linkId);
      // A second carrier with DIFFERENT content (its own budget row) and its own live link + succeeded task.
      const observation = normalizeOneBotMessage(
        {
          time: AT,
          self_id: Number(ACCOUNT),
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -99000 - Math.floor(Math.random() * 900),
          user_id: 10001,
          group_id: Number(PEER),
          sender: { card: "阿林", nickname: "阿林" },
          message: [
            { type: "image", data: { file: "same.png", url: "https://example.test/same" } },
          ],
        },
        ACCOUNT,
      );
      if (observation.kind !== "message") throw new Error("message expected");
      recordObservation(f.h.orm, observation.observation, AGENT);
      if (
        !new ConversationEventRepository(f.db).ingestOneBotEvent(
          observation.observation.eventKey,
          BINDING_ID,
        )
      )
        throw new Error("ingest failed");
      const media2 = f.db
        .query("SELECT id FROM qq_media_notes WHERE event_key=?")
        .get(observation.observation.eventKey) as { id: string } | null;
      if (!media2) throw new Error("second media missing");
      const { asset: asset2 } = recordMediaAsset(f.h.orm, {
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        bytes,
        mimeType: "image/png",
        expiresAt: LONG,
      });
      const link2 = linkMediaAssetSource(f.h.orm, {
        assetId: asset2.id,
        mediaNoteId: media2.id,
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        expiresAt: LONG,
      });
      const claimed2 = await attemptMediaReadTask(f.h.orm, {
        mediaNoteId: media2.id,
        purpose: "baseline",
        modelName: "vision-synthetic",
        policy: "p1",
        contentSha256: contentSha,
        assertCurrent: f.guard,
      });
      recordMediaReadTaskResult(f.h.orm, {
        mediaNoteId: media2.id,
        purpose: "baseline",
        note: "第二载体描述",
        modelName: "vision-synthetic",
        expectedAttempts: claimed2.attempt,
        claimToken: claimed2.claimToken,
        assertCurrent: f.guard,
      });
      f.db
        .query("UPDATE qq_media_read_tasks SET asset_source_id=? WHERE media_note_id=?")
        .run(link2.id, media2.id);
      const task2 = f.db
        .query("SELECT id FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(media2.id) as { id: string };

      // Purge the doomed first link: only ITS bound task transitions.
      const sweep = new Date(Date.now() + 60_000).toISOString();
      expect(purgeExpiredMediaAssets(f.h.orm, sweep)).toBe(0);
      const cleared = f.db
        .query("SELECT status, note FROM qq_media_read_tasks WHERE id=?")
        .get(first.taskId) as { status: string; note: string | null };
      expect(cleared).toMatchObject({ status: "failed", note: null });
      const kept = f.db
        .query("SELECT status, note FROM qq_media_read_tasks WHERE id=?")
        .get(task2.id) as { status: string; note: string | null };
      expect(kept).toMatchObject({ status: "succeeded", note: "第二载体描述" });
    } finally {
      f.h.close();
    }
  });
});

/** A test-level override for the controlled fetch: null = the default valid-PNG stub. */
let controlledBytesOverride: Uint8Array | null = null;

const adapter: QqMediaReadAdapter = {
  capabilities: ["image"] as const,
  // The controlled fetch: deterministic bytes keyed by the source ref; NO second
  // download path, no decode here — the reader's header discipline decides mime.
  fetchBytes: async (request) => {
    if (controlledBytesOverride !== null) return { bytes: controlledBytesOverride };
    // A minimal REAL PNG header (signature + IHDR): the reader's header discipline
    // must read a true format, not a magic-prefix fake.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00,
    ]);
    void request;
    return { bytes: png };
  },
  read: async () => "受控读取描述",
};

describe("reader cache-chain discipline: header mime, guard-tx writes, and the full-state gate lookup", () => {
  it("fetchBytes bytes persist as asset+link inside the guard tx and the claim binds the consumed link", async () => {
    const f = setup();
    try {
      // Seed a carrier WITHOUT any asset/link (the native no-live-asset shape): the reader must derive
      // identity from fetchBytes and persist the controlled chain itself.
      const observation = normalizeOneBotMessage(
        {
          time: AT,
          self_id: Number(ACCOUNT),
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -61000 - Math.floor(Math.random() * 10000),
          user_id: 10001,
          group_id: Number(PEER),
          sender: { card: "阿林", nickname: "阿林" },
          message: [{ type: "image", data: { file: "p.png", url: "https://example.test/p" } }],
        },
        ACCOUNT,
      );
      if (observation.kind !== "message") throw new Error("message expected");
      recordObservation(f.h.orm, observation.observation, AGENT);
      if (
        !new ConversationEventRepository(f.db).ingestOneBotEvent(
          observation.observation.eventKey,
          BINDING_ID,
        )
      )
        throw new Error("ingest failed");
      const media = f.db
        .query("SELECT id, expires_at FROM qq_media_notes WHERE event_key=?")
        .get(observation.observation.eventKey) as { id: string; expires_at: string } | null;
      if (!media) throw new Error("media missing");
      // NO contentSha256 input: the reader derives identity from the controlled fetch and persists the chain.
      const result = await readQqMediaTaskOnce(f.h.orm, adapter as never, {
        eventKey: observation.observation.eventKey,
        segmentIndex: 0,
        purpose: "baseline",
        policy: "p1",
        modelConfig: { visionModelName: "vision-synthetic", transcriptionModelName: null },
        addressedToAssistant: true,
        assertCurrent: f.guard,
        owner: {
          kind: "conversation",
          id: f.conversationId,
          userId: DEFAULT_USER_ID,
          agentId: AGENT,
        },
      });
      expect(result).toMatchObject({ kind: "described", purpose: "baseline" });
      if (result.kind !== "described") return;
      // The reader persisted the controlled chain: one asset + one link bound to THIS carrier.
      const links = f.db
        .query("SELECT id, asset_id, expires_at FROM qq_media_asset_sources WHERE media_note_id=?")
        .all(media.id) as { id: string; asset_id: string; expires_at: string }[];
      expect(links).toHaveLength(1);
      const asset = f.db
        .query("SELECT id, mime_type, content_sha256 FROM qq_media_assets WHERE id=?")
        .get(links[0].asset_id) as { id: string; mime_type: string; content_sha256: string };
      expect(asset.mime_type).toBe("image/png");
      expect(asset.content_sha256).toBe(result.contentSha256);
      // The claim bound the task to the consumed link (the real consumed source, never NULL).
      const task = f.db
        .query("SELECT id, asset_source_id FROM qq_media_read_tasks WHERE identity_key IS NOT NULL")
        .get() as { id: string; asset_source_id: string } | null;
      expect(task?.asset_source_id).toBe(links[0].id);
      // The link window is THIS carrier's own (the media row's window), never a renewal of anything.
      expect(Date.parse(links[0].expires_at)).toBe(Date.parse(media.expires_at));
    } finally {
      f.h.close();
    }
  });

  it("an unreadable image header is an explicit fail: no cache write, no task, no attempt", async () => {
    const f = setup();
    try {
      const observation = normalizeOneBotMessage(
        {
          time: AT,
          self_id: Number(ACCOUNT),
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -62000 - Math.floor(Math.random() * 10000),
          user_id: 10001,
          group_id: Number(PEER),
          sender: { card: "阿林", nickname: "阿林" },
          message: [{ type: "image", data: { file: "p.png", url: "https://example.test/p" } }],
        },
        ACCOUNT,
      );
      if (observation.kind !== "message") throw new Error("message expected");
      recordObservation(f.h.orm, observation.observation, AGENT);
      if (
        !new ConversationEventRepository(f.db).ingestOneBotEvent(
          observation.observation.eventKey,
          BINDING_ID,
        )
      )
        throw new Error("ingest failed");
      const media = f.db
        .query("SELECT id FROM qq_media_notes WHERE event_key=?")
        .get(observation.observation.eventKey) as { id: string } | null;
      if (!media) throw new Error("media missing");
      // NOT a readable image header — the controlled fetch must deliver THESE bytes so the reader's
      // header discipline hits its explicit information boundary.
      controlledBytesOverride = new Uint8Array([0, 1, 2, 3, 4]);
      // NO contentSha256 input: the reader must derive the identity from the controlled fetch itself,
      // and the header discipline decides mime — the exact production path for a no-live-asset carrier.
      // The header discipline fails CLOSED with the explicit domain error (not a swallowed unreadable):
      // no cache write, no task, no attempt, no decode attempt.
      await expect(
        readQqMediaTaskOnce(f.h.orm, adapter as never, {
          eventKey: observation.observation.eventKey,
          segmentIndex: 0,
          purpose: "baseline",
          policy: "p1",
          modelConfig: { visionModelName: "vision-synthetic", transcriptionModelName: null },
          addressedToAssistant: true,
          assertCurrent: f.guard,
          owner: {
            kind: "conversation",
            id: f.conversationId,
            userId: DEFAULT_USER_ID,
            agentId: AGENT,
          },
        }),
      ).rejects.toMatchObject({ code: "MEMORY_SOURCE_INVALID" });
      // Zero cache write, zero task, zero attempt: the information boundary holds.
      expect(
        f.db.query("SELECT id FROM qq_media_asset_sources WHERE media_note_id=?").all(media.id),
      ).toHaveLength(0);
      expect(
        f.db.query("SELECT id FROM qq_media_read_tasks WHERE identity_key IS NOT NULL").all(),
      ).toHaveLength(0);
    } finally {
      controlledBytesOverride = null;
      f.h.close();
    }
  });

  it("the full-state gate lookup finds a FAILED task under the same content identity (running too)", async () => {
    const f = setup();
    try {
      const observation = normalizeOneBotMessage(
        {
          time: AT,
          self_id: Number(ACCOUNT),
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -63000 - Math.floor(Math.random() * 10000),
          user_id: 10001,
          group_id: Number(PEER),
          sender: { card: "阿林", nickname: "阿林" },
          message: [{ type: "image", data: { file: "p.png", url: "https://example.test/p" } }],
        },
        ACCOUNT,
      );
      if (observation.kind !== "message") throw new Error("message expected");
      recordObservation(f.h.orm, observation.observation, AGENT);
      if (
        !new ConversationEventRepository(f.db).ingestOneBotEvent(
          observation.observation.eventKey,
          BINDING_ID,
        )
      )
        throw new Error("ingest failed");
      const media = f.db
        .query("SELECT id FROM qq_media_notes WHERE event_key=?")
        .get(observation.observation.eventKey) as { id: string } | null;
      if (!media) throw new Error("media missing");
      const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
      const contentSha = createHash("sha256").update(bytes).digest("hex");
      // Claim (running, in-flight) — the full-state lookup must see it; the servable lookup must not.
      const claimed = await attemptMediaReadTask(f.h.orm, {
        mediaNoteId: media.id,
        purpose: "baseline",
        modelName: "vision-synthetic",
        policy: "p1",
        contentSha256: contentSha,
        assertCurrent: f.guard,
      });
      const rows = findMediaReadTasksForContent(f.h.orm, {
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        segmentKind: "image",
        contentSha256: contentSha,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: claimed.task.id, status: "running", attempts: 1 });
      expect(
        findServableMediaReadTaskByIdentity(f.h.orm, {
          accountId: ACCOUNT,
          conversationKind: "group",
          peerId: PEER,
          agentId: AGENT,
          segmentKind: "image",
          purpose: "baseline",
          questionKey: null,
          contentSha256: contentSha,
          modelName: "vision-synthetic",
          policy: "p1",
          now: nowIso(),
        }),
      ).toBeNull();
      // A FAILED row under the same identity: the gate's blocked truth source, never a null-as-no-failure.
      recordMediaReadTaskResult(f.h.orm, {
        mediaNoteId: media.id,
        purpose: "baseline",
        note: "临时",
        modelName: "vision-synthetic",
        expectedAttempts: claimed.attempt,
        claimToken: claimed.claimToken,
        assertCurrent: f.guard,
      });
      f.db
        .query(
          "UPDATE qq_media_read_tasks SET status='failed', note=NULL, model_name=NULL WHERE id=?",
        )
        .run(claimed.task.id);
      const failedRows = findMediaReadTasksForContent(f.h.orm, {
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        segmentKind: "image",
        contentSha256: contentSha,
      });
      expect(failedRows[0]).toMatchObject({ status: "failed", attempts: 1 });
    } finally {
      f.h.close();
    }
  });
});

describe("F1 precision: a protected sibling source keeps the expired asset and every live result", () => {
  it("expired asset + live unprotected source + protected sibling → purge deletes nothing, helper revokes nothing", async () => {
    const f = setup();
    try {
      // One asset (same bytes) behind TWO carriers: media A (live-window source A) and media B (source B).
      const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6, 7, 8]);
      const contentSha = createHash("sha256").update(bytes).digest("hex");
      const observationA = normalizeOneBotMessage(
        {
          time: AT,
          self_id: Number(ACCOUNT),
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -71000 - Math.floor(Math.random() * 10000),
          user_id: 10001,
          group_id: Number(PEER),
          sender: { card: "阿林", nickname: "阿林" },
          message: [{ type: "image", data: { file: "pa.png", url: "https://example.test/pa" } }],
        },
        ACCOUNT,
      );
      if (observationA.kind !== "message") throw new Error("message expected");
      recordObservation(f.h.orm, observationA.observation, AGENT);
      if (
        !new ConversationEventRepository(f.db).ingestOneBotEvent(
          observationA.observation.eventKey,
          BINDING_ID,
        )
      )
        throw new Error("ingest failed");
      const mediaA = f.db
        .query("SELECT id FROM qq_media_notes WHERE event_key=?")
        .get(observationA.observation.eventKey) as { id: string } | null;
      if (!mediaA) throw new Error("media A missing");
      const { asset } = recordMediaAsset(f.h.orm, {
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        bytes,
        mimeType: "image/png",
        expiresAt: LONG,
      });
      const linkA = linkMediaAssetSource(f.h.orm, {
        assetId: asset.id,
        mediaNoteId: mediaA.id,
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        // Source A's own window is LIVE and unprotected.
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      const claimedA = await attemptMediaReadTask(f.h.orm, {
        mediaNoteId: mediaA.id,
        purpose: "baseline",
        modelName: "vision-synthetic",
        policy: "p1",
        contentSha256: contentSha,
        assertCurrent: f.guard,
      });
      recordMediaReadTaskResult(f.h.orm, {
        mediaNoteId: mediaA.id,
        purpose: "baseline",
        note: "载体A的描述",
        modelName: "vision-synthetic",
        expectedAttempts: claimedA.attempt,
        claimToken: claimedA.claimToken,
        assertCurrent: f.guard,
      });
      f.db
        .query("UPDATE qq_media_read_tasks SET asset_source_id=? WHERE media_note_id=?")
        .run(linkA.id, mediaA.id);
      const taskA = f.db
        .query("SELECT id FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(mediaA.id) as { id: string };

      // Media B: a source whose sibling protection comes from a RUNNING task bound to it.
      const observationB = normalizeOneBotMessage(
        {
          time: AT,
          self_id: Number(ACCOUNT),
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -72000 - Math.floor(Math.random() * 10000),
          user_id: 10001,
          group_id: Number(PEER),
          sender: { card: "阿林", nickname: "阿林" },
          message: [{ type: "image", data: { file: "pb.png", url: "https://example.test/pb" } }],
        },
        ACCOUNT,
      );
      if (observationB.kind !== "message") throw new Error("message expected");
      recordObservation(f.h.orm, observationB.observation, AGENT);
      if (
        !new ConversationEventRepository(f.db).ingestOneBotEvent(
          observationB.observation.eventKey,
          BINDING_ID,
        )
      )
        throw new Error("ingest failed");
      const mediaB = f.db
        .query("SELECT id FROM qq_media_notes WHERE event_key=?")
        .get(observationB.observation.eventKey) as { id: string } | null;
      if (!mediaB) throw new Error("media B missing");
      const linkB = linkMediaAssetSource(f.h.orm, {
        assetId: asset.id,
        mediaNoteId: mediaB.id,
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      // Source B's protection: a real minted qq_media_source ref for media B, held by a NONTERMINAL run
      // step's exact snapshot (the same protection face production holds refs with).
      const heldRef = createQqMediaSourceRef(f.h, f.scope, mediaB.id, nowIso());
      if (!heldRef) throw new Error("held ref mint failed");
      const runs = new AgentRunRepository(f.db);
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      const ownerB = {
        kind: "conversation" as const,
        id: f.conversationId,
        userId: DEFAULT_USER_ID,
        agentId: AGENT,
      };
      runs.createRun({ runId, specId: "main", specVersion: "1", owner: ownerB, at: nowIso() });
      runs.startStep({
        runId,
        stepId,
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: nowIso(),
        messages: [{ role: "user", content: [{ kind: "text", text: "持引用" }] }],
        sources: [heldRef],
      });
      // Age the asset window AFTER both links exist (real state transition): the sweep would take it
      // without protection — but the held ref on source B protects it.
      f.db
        .query("UPDATE qq_media_assets SET expires_at=? WHERE id=?")
        .run(new Date(Date.now() - 1000).toISOString(), asset.id);
      // claimedB stays RUNNING (in-flight) → source B is protected → the expired asset survives.

      const sweep = new Date(Date.now() + 60_000).toISOString();
      expect(purgeExpiredMediaAssets(f.h.orm, sweep)).toBe(0);
      // Nothing deleted: the asset survives (protected sibling), source A survives (live window),
      // source B survives (protected).
      expect(f.db.query("SELECT id FROM qq_media_assets WHERE id=?").get(asset.id)).not.toBeNull();
      expect(
        f.db.query("SELECT id FROM qq_media_asset_sources WHERE id=?").get(linkA.id),
      ).not.toBeNull();
      expect(
        f.db.query("SELECT id FROM qq_media_asset_sources WHERE id=?").get(linkB.id),
      ).not.toBeNull();
      // The live result on carrier A is untouched (helper revoked nothing).
      const kept = f.db
        .query("SELECT status, note, model_name FROM qq_media_read_tasks WHERE id=?")
        .get(taskA.id) as { status: string; note: string | null; model_name: string | null };
      expect(kept).toMatchObject({
        status: "succeeded",
        note: "载体A的描述",
        model_name: "vision-synthetic",
      });
    } finally {
      f.h.close();
    }
  });
});

describe("F2 precision: whole-category cleanup freezes its targets; the helper never enlarges the delete", () => {
  it("no-ids media_notes cleanup removes the expired closure but the transitioned task row survives", async () => {
    const f = setup();
    try {
      // Media A: a fully expired closure (note/asset/source) with a succeeded bound task whose OWN row
      // window is still in the future (the carrier media row lives longer than the source chain).
      const observation = normalizeOneBotMessage(
        {
          time: AT,
          self_id: Number(ACCOUNT),
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -75000 - Math.floor(Math.random() * 10000),
          user_id: 10001,
          group_id: Number(PEER),
          sender: { card: "阿林", nickname: "阿林" },
          message: [{ type: "image", data: { file: "p.png", url: "https://example.test/p" } }],
        },
        ACCOUNT,
      );
      if (observation.kind !== "message") throw new Error("message expected");
      recordObservation(f.h.orm, observation.observation, AGENT);
      if (
        !new ConversationEventRepository(f.db).ingestOneBotEvent(
          observation.observation.eventKey,
          BINDING_ID,
        )
      )
        throw new Error("ingest failed");
      const media = f.db
        .query("SELECT id, expires_at FROM qq_media_notes WHERE event_key=?")
        .get(observation.observation.eventKey) as { id: string; expires_at: string } | null;
      if (!media) throw new Error("media missing");
      const bytes = new Uint8Array([137, 80, 78, 71, 9, 9, 9, 9]);
      const contentSha = createHash("sha256").update(bytes).digest("hex");
      const { asset } = recordMediaAsset(f.h.orm, {
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        bytes,
        mimeType: "image/png",
        expiresAt: LONG,
      });
      // Source + asset windows expired; the NOTE window (and therefore the task's window) stays live.
      const short = new Date(Date.now() - 1000).toISOString();
      const link = linkMediaAssetSource(f.h.orm, {
        assetId: asset.id,
        mediaNoteId: media.id,
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        expiresAt: short,
      });
      f.db.query("UPDATE qq_media_assets SET expires_at=? WHERE id=?").run(short, asset.id);
      const claimed = await attemptMediaReadTask(f.h.orm, {
        mediaNoteId: media.id,
        purpose: "baseline",
        modelName: "vision-synthetic",
        policy: "p1",
        contentSha256: contentSha,
        assertCurrent: f.guard,
      });
      recordMediaReadTaskResult(f.h.orm, {
        mediaNoteId: media.id,
        purpose: "baseline",
        note: "到期闭包上的描述",
        modelName: "vision-synthetic",
        expectedAttempts: claimed.attempt,
        claimToken: claimed.claimToken,
        assertCurrent: f.guard,
      });
      f.db
        .query("UPDATE qq_media_read_tasks SET asset_source_id=? WHERE media_note_id=?")
        .run(link.id, media.id);
      // Age the NOTE window after the claim (real state transition): the note closure becomes removable
      // while the task row's own window (frozen at claim from the then-live media window) stays future.
      f.db
        .query("UPDATE qq_media_notes SET expires_at=? WHERE id=?")
        .run(new Date(Date.now() - 1000).toISOString(), media.id);
      const task = f.db
        .query("SELECT id, expires_at FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(media.id) as { id: string; expires_at: string };
      expect(Date.parse(task.expires_at)).toBeGreaterThan(Date.now()); // task window live

      const sweep = new Date(Date.now() + 60_000).toISOString();
      const execution = qqStorageCleanupExecute(f.h.orm, { category: "media_notes" }, sweep);
      // The expired note + asset faces are removed — exactly 2 (the source row dies by the note's own
      // CASCADE and is deliberately excluded from the source face's doom count, matching the existing
      // "parent cascade removes rows the doom set already excluded" design). The read-task face was frozen
      // BEFORE the helper narrowed the task's expiry, so the transitioned task row is NOT deleted.
      expect(execution.removed).toBe(2);
      expect(
        f.db.query("SELECT id FROM qq_media_asset_sources WHERE id=?").get(link.id),
      ).toBeNull();
      // The task row survived the helper's expiry change (frozen ids), transitioned, budget intact.
      const kept = f.db
        .query(
          "SELECT status, note, model_name, attempts, expires_at FROM qq_media_read_tasks WHERE id=?",
        )
        .get(task.id) as {
        status: string;
        note: string | null;
        model_name: string | null;
        attempts: number;
        expires_at: string;
      };
      expect(kept).toMatchObject({ status: "failed", note: null, model_name: null, attempts: 1 });
      expect(Date.parse(kept.expires_at)).toBeLessThanOrEqual(Date.parse(sweep));
      // The dead-source description cannot be re-minted; the budget identity stays.
      expect(createQqMediaReadTaskSourceRef(f.h, f.scope, task.id, nowIso())).toBeNull();
      const ledger = f.db
        .query("SELECT identity_key FROM qq_media_read_tasks WHERE id=?")
        .get(task.id) as { identity_key: string | null };
      expect(ledger.identity_key).not.toBeNull();
    } finally {
      f.h.close();
    }
  });
});
