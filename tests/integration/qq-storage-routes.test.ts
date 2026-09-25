// 存储与诊断 (ADR0018 §11.1/§10, P5h).
//
// The page's promise is that it reports what actually exists and that its one action removes only
// what has already expired. Both are asserted here with seeded rows: live rows and sticker copies
// must survive a cleanup untouched, because "clean up" silently growing into "delete my things"
// is the failure this whole surface exists to avoid.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server/app";
import { recordQqSweepVerdicts } from "../../src/server/db/qq-dispatch-repository";
import {
  createQqStickerCollection,
  importQqSticker,
} from "../../src/server/db/qq-sticker-repository";
import { ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { QqStorageUsageResponse } from "../../src/shared/contracts/qq";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT = "00000000-0000-0000-0000-000000000001";
const PAST = "2020-01-01T00:00:00.000000Z";
const FUTURE = "2030-01-01T00:00:00.000000Z";

function fixture() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const orm = business.orm;
  const event = (key: string, expiresAt: string) => {
    orm
      .insert(schema.qqEvents)
      .values({
        eventKey: key,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: AGENT,
        messageId: key,
        occurredAtSeconds: 1_700_000_000,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: nowIso(),
      })
      .run();
    orm
      .insert(schema.qqObservationText)
      .values({
        eventKey: key,
        body: `正文 ${key}`,
        occurredAtSeconds: 1_700_000_000,
        expiresAt,
        recordedAt: nowIso(),
      })
      .run();
  };
  event("live", FUTURE);
  event("expired", PAST);
  for (const [id, expiresAt] of [
    ["11111111-1111-4111-8111-111111111111", FUTURE],
    ["22222222-2222-4222-8222-222222222222", PAST],
  ] as const) {
    orm
      .insert(schema.qqSpeechLog)
      .values({
        id,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: AGENT,
        kind: "chiming_in",
        spokeAtSeconds: 1_700_000_000,
        expiresAt,
        recordedAt: nowIso(),
      })
      .run();
    orm
      .insert(schema.qqSpeechText)
      .values({
        speechId: id,
        body: "说过的话",
        spokeAtSeconds: 1_700_000_000,
        expiresAt,
        recordedAt: nowIso(),
      })
      .run();
  }
  for (const [id, expiresAt] of [
    ["33333333-3333-4333-8333-333333333333", FUTURE],
    ["44444444-4444-4444-8444-444444444444", PAST],
  ] as const) {
    orm
      .insert(schema.qqSendLog)
      .values({
        id,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: AGENT,
        kind: "chiming_in",
        outcome: "sent",
        deliveryMessageId: `m${id}`,
        sentAtSeconds: 1_700_000_000,
        expiresAt,
        recordedAt: nowIso(),
      })
      .run();
    orm
      .insert(schema.qqSendPart)
      .values({
        sendId: id,
        partIndex: 0,
        partKind: "text",
        result: "confirmed",
        platformMessageId: `m${id}`,
        stickerId: null,
      })
      .run();
  }
  for (const [userId, expiresAt] of [
    ["20001", FUTURE],
    ["20002", PAST],
  ] as const) {
    orm
      .insert(schema.qqMembers)
      .values({
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        userId,
        nickname: `昵称${userId}`,
        firstSeenAtSeconds: 1_700_000_000,
        lastSeenAtSeconds: 1_700_000_000,
        expiresAt,
      })
      .run();
  }
  // P5n: the durable waiting state, so the page's new section reports rows that really exist.
  // One conversation is queued and runnable, one is still inside its merge window. The scheme has
  // to exist first: a trigger refuses a binding that names a scheme which is not there.
  orm
    .insert(schema.qqSchemes)
    .values({
      id: "88888888-8888-4888-8888-888888888888",
      name: "存储用例方案",
      revision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  for (const [key, readyAt] of [
    ["30003", 1_700_000_000],
    ["30004", 4_000_000_000],
  ] as const) {
    orm
      .insert(schema.qqBindings)
      .values({
        id:
          key === "30003"
            ? "66666666-6666-4666-8666-666666666666"
            : "77777777-7777-4777-8777-777777777777",
        accountId: "10001",
        conversationKind: "group",
        peerId: key,
        agentId: AGENT,
        schemeId: "88888888-8888-4888-8888-888888888888",
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
    orm
      .insert(schema.qqDispatchCandidates)
      .values({
        conversationKey: key,
        bindingId:
          key === "30003"
            ? "66666666-6666-4666-8666-666666666666"
            : "77777777-7777-4777-8777-777777777777",
        eventKey: null,
        path: "idle_topic",
        readyAtSeconds: readyAt,
        observedAtSeconds: 1_700_000_000,
        generation: 1,
        claimedGeneration: null,
      })
      .run();
  }
  // A media position that was attempted and never understood: the "waiting" count.
  orm
    .insert(schema.qqMediaNotes)
    .values({
      id: "99999999-9999-4999-8999-999999999999",
      eventKey: "live",
      segmentIndex: 0,
      segmentKind: "image",
      sourceRef: "upstream-1",
      note: null,
      noteModel: null,
      attempts: 1,
      addressed: 1,
      expiresAt: FUTURE,
      recordedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  // A live lease held by another owner: `held` is reported, the token is not. The single row is
  // seeded by the migration, so this claims it rather than inserting.
  orm
    .update(schema.qqDispatchLease)
    .set({
      token: "synthetic-lease-token",
      conversationKey: "30003",
      generation: 1,
      expiresAtSeconds: 4_000_000_000,
    })
    .where(eq(schema.qqDispatchLease.id, 1))
    .run();

  const collection = createQqStickerCollection(orm, { name: "日常" });
  const assetId = "55555555-5555-4555-8555-555555555555";
  importQqSticker(orm, {
    id: assetId,
    name: "问好",
    copy: { fileName: `${assetId}.png`, byteSize: 1024, mediaType: "image" },
    width: 8,
    height: 8,
    collectionIds: [collection.id],
  });
  return { business, app: createApp({ business }) };
}

describe("storage usage reports what exists", () => {
  it("counts rows, separates expired text, and totals the sticker copies", async () => {
    const h = fixture();
    try {
      const response = await h.app.request("/qq/storage");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        observations: { messages: 2, text: 2, expired_text: 1 },
        speech: { records: 2, text: 2 },
        sends: { attempts: 2, parts: 2 },
        nicknames: { current: 1, expired: 1 },
        stickers: { collections: 1, assets: 1, enabled: 0, bytes: 1024 },
        // One candidate is runnable and one is still waiting for its merge window; the global
        // chain slot is taken by an owner whose token never appears in this view.
        dispatch: { candidates: 2, ready_now: 1, lease_held: true },
        media: { segments: 1, described: 0, pending: 1 },
        // No sweep has run against this database, and the empty answer says so rather than
        // implying that every conversation was looked at and had nothing to report.
        sweep: { tracked: 0, last_swept_at_seconds: null, entries: [] },
        retention: { days: 14 },
      });
      expect(JSON.stringify(body)).not.toContain("synthetic-lease-token");
    } finally {
      h.business.close();
    }
  });

  it("reports why each conversation is silent, newest decision first", async () => {
    const h = fixture();
    try {
      const key = (peerId: string) => JSON.stringify(["qq", "10001", "group", peerId]);
      recordQqSweepVerdicts(h.business.orm, {
        nowSeconds: 1_700_000_000,
        verdicts: [
          {
            conversationKey: key("30003"),
            kind: "group",
            peerId: "30003",
            outcome: "skipped",
            reason: "not_quiet_yet",
            observedAtSeconds: 1_699_999_000,
            readyAtSeconds: 1_700_001_000,
          },
          {
            conversationKey: key("30004"),
            kind: "group",
            peerId: "30004",
            outcome: "scheduled",
            reason: null,
            observedAtSeconds: 1_699_998_000,
            readyAtSeconds: null,
          },
        ],
      });
      // A later pass rewrites both rows (one conversation's reason has moved on), so this is a
      // statement about the last pass, not a growing history.
      recordQqSweepVerdicts(h.business.orm, {
        nowSeconds: 1_700_000_600,
        verdicts: [
          {
            conversationKey: key("30003"),
            kind: "group",
            peerId: "30003",
            outcome: "skipped",
            reason: "cooling_down",
            observedAtSeconds: 1_699_999_000,
            readyAtSeconds: 1_700_000_900,
          },
          {
            conversationKey: key("30004"),
            kind: "group",
            peerId: "30004",
            outcome: "scheduled",
            reason: null,
            observedAtSeconds: 1_699_998_000,
            readyAtSeconds: null,
          },
        ],
      });
      const body = (await (await h.app.request("/qq/storage")).json()) as QqStorageUsageResponse;
      expect(body.sweep).toEqual({
        tracked: 2,
        last_swept_at_seconds: 1_700_000_600,
        entries: [
          {
            kind: "group",
            peer_id: "30003",
            outcome: "skipped",
            reason: "cooling_down",
            observed_at_seconds: 1_699_999_000,
            ready_at_seconds: 1_700_000_900,
            decided_at_seconds: 1_700_000_600,
          },
          {
            kind: "group",
            peer_id: "30004",
            outcome: "scheduled",
            reason: null,
            observed_at_seconds: 1_699_998_000,
            ready_at_seconds: null,
            decided_at_seconds: 1_700_000_600,
          },
        ],
      });
      // The cleanup window does not apply to this record: it is rewritten every pass and holds no
      // message text, so removing it would only lose the answer to "why was there no sound".
      expect(await (await h.app.request("/qq/storage/cleanup", { method: "POST" })).json()).toEqual(
        {
          observation_text: 1,
          media_notes: 0,
          speech: 1,
          sends: 1,
          nicknames: 1,
        },
      );
      const after = (await (await h.app.request("/qq/storage")).json()) as QqStorageUsageResponse;
      expect(after.sweep.entries).toHaveLength(2);
    } finally {
      h.business.close();
    }
  });

  it("reports the transport state, or says there is none", async () => {
    const h = fixture();
    try {
      // No runtime is wired in this app, so the honest answer is "unavailable" — different from
      // "idle", which means a runtime exists and is not connected.
      const response = await h.app.request("/qq/status");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        connection: { phase: "unavailable", reason: null },
      });
    } finally {
      h.business.close();
    }
  });

  it("removes only expired rows, and never a sticker", async () => {
    const h = fixture();
    try {
      const cleanup = await h.app.request("/qq/storage/cleanup", { method: "POST" });
      expect(cleanup.status).toBe(200);
      expect(await cleanup.json()).toEqual({
        observation_text: 1,
        media_notes: 0,
        speech: 1,
        sends: 1,
        nicknames: 1,
      });
      const after = (await (await h.app.request("/qq/storage")).json()) as QqStorageUsageResponse;
      // Everything live is still here, and the expired rows are gone rather than merely counted.
      expect(after.observations).toEqual({ messages: 2, text: 1, expired_text: 0 });
      expect(after.speech).toEqual({ records: 1, text: 1 });
      expect(after.sends.attempts).toBe(1);
      expect(after.nicknames).toEqual({ current: 1, expired: 0 });
      // §10: material governance is separate; cleanup must not touch copies or their rows.
      expect(after.stickers).toEqual({ collections: 1, assets: 1, enabled: 0, bytes: 1024 });
      // A second run has nothing left to remove.
      expect(await (await h.app.request("/qq/storage/cleanup", { method: "POST" })).json()).toEqual(
        {
          observation_text: 0,
          media_notes: 0,
          speech: 0,
          sends: 0,
          nicknames: 0,
        },
      );
    } finally {
      h.business.close();
    }
  });
});
