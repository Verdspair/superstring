// T08: scoped image assets, prepared variants and classification cache
// (plan T08 Steps 1/3/6, spec §8.2/§12/§13.6).
//
// Coverage:
//  - the same bytes arriving from different sources share ONE asset per scope,
//    and every source keeps its own expiry link
//  - the dedup identity is scope+sha: the same picture in another group or
//    under another agent is a different row, never a cross-scope hit
//  - an expired media source cannot feed (or revive) the cache; an expired
//    asset is not returned by lookups
//  - prepared variants are cached per policy and refuse content swaps
//  - platform classification evidence survives model re-labels
//  - the retention purge drops expired assets with their children
//  - the media.read action projects safe image metadata only, gated on this
//    run's disclosure, with a resolvable qq_media_asset source per picture

import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { ActionContext, BuiltInAction } from "../../src/server/agent/built-in-actions";
import { assertContextSources } from "../../src/server/agent/context-access";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { readBindingByConversation } from "../../src/server/db/qq-binding-repository";
import {
  linkMediaAssetSource,
  mediaAssetForContent,
  mediaAssetForMediaNote,
  mediaClassificationFor,
  mediaVariantFor,
  purgeExpiredMediaAssets,
  recordMediaAsset,
  recordMediaClassification,
  recordMediaVariant,
} from "../../src/server/db/qq-media-asset-repository";
import { mediaNoteRow, recordMediaSegment } from "../../src/server/db/qq-media-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_USER_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { fail } from "../../src/server/errors";
import { createQqMediaSourceRef } from "../../src/server/services/qq-media-sources";
import {
  createQqMediaTools,
  type QqMediaToolsOptions,
} from "../../src/server/services/qq-media-tools";
import {
  QQ_MEDIA_TOOL_DESCRIPTIONS,
  QQ_MEDIA_TOOL_SCHEMAS,
} from "../../src/shared/contracts/agent-action-descriptions";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";
import { cloneBusinessDb } from "../harness/business-db";

const AGENT = "00000000-0000-0000-0000-000000000001";
const ACCOUNT = "10001";
const PEER = "20001";
// The repositories validate windows against the real clock, so the fixtures
// use live windows derived from now.
const NOW = new Date().toISOString().replace("Z", "000Z").slice(0, 26);
const EXPIRES = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  .toISOString()
  .replace("Z", "000Z")
  .slice(0, 26);
const LATER = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  .toISOString()
  .replace("Z", "000Z")
  .slice(0, 26);
const shaOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function seedAgent(db: Database) {
  db.exec(`INSERT INTO users VALUES ('u1', 'synthetic', '${NOW}')`);
  db.exec(`INSERT INTO agents (id, name, system_prompt, description, additional_instructions,
      p5_config, model_name, memory_consolidation_prompt,
      memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
    VALUES ('${AGENT}', 'synthetic', '', '', '', '{}', 'fake', '', '', '', '${NOW}', '${NOW}')`);
}

interface AssetFixture {
  orm: AssetDbHandle["orm"];
  db: AssetDbHandle["db"];
  scope: { accountId: string; conversationKind: "group"; peerId: string; agentId: string };
  seedNote(id: string, peerId?: string, expiresAt?: string): void;
}

type AssetDbHandle = ReturnType<typeof cloneBusinessDb>;

function assetFixture(): AssetFixture {
  const h = cloneBusinessDb();
  seedAgent(h.db);
  const seedNote = (id: string, peerId = PEER, expiresAt = EXPIRES) => {
    h.db
      .query(
        `INSERT INTO qq_events (event_key, account_id, conversation_kind, peer_id, agent_id,
          message_id, occurred_at_seconds, speaker_kind, speaker_id, recorded_at)
         VALUES (?, '10001', 'group', ?, '${AGENT}', 'm-' || ?, 10, 'member', '30001', ?)`,
      )
      .run(`ev-${id}`, peerId, id, NOW);
    h.db
      .query(
        `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
          attempts, expires_at, recorded_at, updated_at)
         VALUES (?, 'ev-' || ?, 0, 'image', 'ref-' || ?, 0, ?, ?, ?)`,
      )
      .run(id, id, id, expiresAt, NOW, NOW);
  };
  return {
    orm: h.orm,
    db: h.db,
    scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
    seedNote,
  };
}

describe("scoped QQ media assets", () => {
  it("shares one asset per scope for the same bytes from different sources, expiry takes the earliest cap", () => {
    const f = assetFixture();
    try {
      f.seedNote("mn-1");
      f.seedNote("mn-2");
      const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
      const first = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: png,
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      expect(first.created).toBe(true);
      // The same bytes arrive again under a later source window: the scoped
      // dedup identity still hits (same asset), but the stored expiry is NOT
      // extended — a source window justifies the cache only up to its own end,
      // and a later window never stretches an earlier source's authorization
      // (来源独立 expiry：写不延长旧来源的授权窗口).
      const second = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: png.slice(),
        mimeType: "image/png",
        expiresAt: LATER,
      });
      expect(second.created).toBe(false);
      expect(second.asset.id).toBe(first.asset.id);
      expect(second.asset.expiresAt).toBe(EXPIRES);
      const s1 = linkMediaAssetSource(f.orm, {
        assetId: first.asset.id,
        mediaNoteId: "mn-1",
        scope: f.scope,
        expiresAt: EXPIRES,
      });
      const s2 = linkMediaAssetSource(f.orm, {
        assetId: first.asset.id,
        mediaNoteId: "mn-2",
        scope: f.scope,
        expiresAt: LATER,
      });
      expect(s1.id).not.toBe(s2.id);
      // Idempotent relink of the same media row returns the existing source.
      const s1again = linkMediaAssetSource(f.orm, {
        assetId: first.asset.id,
        mediaNoteId: "mn-1",
        scope: f.scope,
        expiresAt: EXPIRES,
      });
      expect(s1again.id).toBe(s1.id);
      expect(
        mediaAssetForContent(f.orm, { scope: f.scope, contentSha256: shaOf(png), at: NOW }),
      ).toMatchObject({
        id: first.asset.id,
      });
    } finally {
      f.db.close();
    }
  });

  it("never shares an asset across groups or agents", () => {
    const f = assetFixture();
    try {
      f.seedNote("mn-other-peer", "20002");
      // The cross-agent case needs a second real assistant (FK on agent_id).
      f.db.exec(`INSERT INTO agents (id, name, system_prompt, description, additional_instructions,
          p5_config, model_name, memory_consolidation_prompt,
          memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
        VALUES ('00000000-0000-0000-0000-000000000009', 'synthetic-2', '', '', '', '{}', 'fake', '', '', '', '${NOW}', '${NOW}')`);
      const png = new Uint8Array([9, 9, 9, 9]);
      const own = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: png,
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      const otherGroup = recordMediaAsset(f.orm, {
        scope: { ...f.scope, peerId: "20002" },
        bytes: png,
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      const otherAgent = recordMediaAsset(f.orm, {
        scope: { ...f.scope, agentId: "00000000-0000-0000-0000-000000000009" },
        bytes: png,
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      expect(otherGroup.created).toBe(true);
      expect(otherAgent.created).toBe(true);
      expect(otherGroup.asset.id).not.toBe(own.asset.id);
      expect(otherAgent.asset.id).not.toBe(own.asset.id);
      // A scoped lookup cannot see another scope's cache entry.
      expect(
        mediaAssetForContent(f.orm, { scope: f.scope, contentSha256: shaOf(png), at: NOW })?.id,
      ).toBe(own.asset.id);
      expect(
        mediaAssetForContent(f.orm, {
          scope: { ...f.scope, peerId: "20003" },
          contentSha256: shaOf(png),
          at: NOW,
        }),
      ).toBeNull();
    } finally {
      f.db.close();
    }
  });

  it("an expired source cannot feed the cache and an expired asset is not served", () => {
    const f = assetFixture();
    try {
      f.seedNote("mn-dead", PEER, "2000-01-01T00:00:00.000000Z");
      const png = new Uint8Array([7, 7, 7]);
      const { asset } = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: png,
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      // The source row is past its expiry: linking it must refuse, and no
      // source row may appear — the cache cannot be revived through it.
      expect(() =>
        linkMediaAssetSource(f.orm, {
          assetId: asset.id,
          mediaNoteId: "mn-dead",
          scope: f.scope,
          expiresAt: EXPIRES,
        }),
      ).toThrow();
      expect(f.db.query("SELECT count(*) AS n FROM qq_media_asset_sources").get()).toEqual({
        n: 0,
      });
      // ...and an asset past its own expiry is not a cache hit either.
      expect(
        mediaAssetForContent(f.orm, {
          scope: f.scope,
          contentSha256: shaOf(png),
          at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
            .toISOString()
            .replace("Z", "000Z")
            .slice(0, 26),
        }),
      ).toBeNull();
    } finally {
      f.db.close();
    }
  });

  it("refuses to link a media row whose event is outside the asset's scope", () => {
    const f = assetFixture();
    try {
      // mn-cross-group lives in another group; mn-cross-agent in another agent.
      f.seedNote("mn-cross-group", "20002");
      f.db.exec(`INSERT INTO agents (id, name, system_prompt, description, additional_instructions,
          p5_config, model_name, memory_consolidation_prompt,
          memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
        VALUES ('00000000-0000-0000-0000-000000000009', 'synthetic-2', '', '', '', '{}', 'fake', '', '', '', '${NOW}', '${NOW}')`);
      f.db.exec(
        `INSERT INTO qq_events (event_key, account_id, conversation_kind, peer_id, agent_id,
          message_id, occurred_at_seconds, speaker_kind, speaker_id, recorded_at)
         VALUES ('ev-mn-cross-agent', '10001', 'group', '${PEER}', '00000000-0000-0000-0000-000000000009',
           'm-xa', 10, 'member', '30001', '${NOW}')`,
      );
      f.db.exec(
        `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
          attempts, expires_at, recorded_at, updated_at)
         VALUES ('mn-cross-agent', 'ev-mn-cross-agent', 0, 'image', 'ref-xa', 0, '${EXPIRES}', '${NOW}', '${NOW}')`,
      );
      const { asset } = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: new Uint8Array([6, 6, 6]),
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      // Cross-group and cross-agent links are refused: a media event only
      // justifies a cache entry inside its own (account, kind, peer, agent)
      // scope — 跨 scope 字节替换/同 sha 授权都不接受.
      expect(() =>
        linkMediaAssetSource(f.orm, {
          assetId: asset.id,
          mediaNoteId: "mn-cross-group",
          scope: f.scope,
          expiresAt: EXPIRES,
        }),
      ).toThrow();
      expect(() =>
        linkMediaAssetSource(f.orm, {
          assetId: asset.id,
          mediaNoteId: "mn-cross-agent",
          scope: f.scope,
          expiresAt: EXPIRES,
        }),
      ).toThrow();
      expect(f.db.query("SELECT count(*) AS n FROM qq_media_asset_sources").get()).toEqual({
        n: 0,
      });
    } finally {
      f.db.close();
    }
  });

  it("refuses a link whose target asset belongs to another scope or does not exist", () => {
    const f = assetFixture();
    try {
      f.seedNote("mn-hijack");
      const { asset } = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: new Uint8Array([8, 8, 8]),
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      // The asset exists, but the caller's scope is another group: the link
      // must refuse (a cross-scope caller cannot attach to a foreign asset).
      expect(() =>
        linkMediaAssetSource(f.orm, {
          assetId: asset.id,
          mediaNoteId: "mn-hijack",
          scope: { ...f.scope, peerId: "29999" },
          expiresAt: EXPIRES,
        }),
      ).toThrow();
      // A nonexistent asset id refuses too.
      expect(() =>
        linkMediaAssetSource(f.orm, {
          assetId: "no-such-asset",
          mediaNoteId: "mn-hijack",
          scope: f.scope,
          expiresAt: EXPIRES,
        }),
      ).toThrow();
      expect(f.db.query("SELECT count(*) AS n FROM qq_media_asset_sources").get()).toEqual({
        n: 0,
      });
    } finally {
      f.db.close();
    }
  });

  it("caches prepared variants per policy and refuses content swaps", () => {
    const f = assetFixture();
    try {
      const { asset } = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: new Uint8Array([1, 1, 1]),
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      // Variant/classification caches are authorized derivatives: they may only
      // be written while a live authorized source backs the asset.
      expect(() =>
        recordMediaVariant(f.orm, {
          assetId: asset.id,
          policy: "orphan",
          bytes: new Uint8Array([40, 40, 40]),
          mimeType: "image/png",
        }),
      ).toThrow();
      expect(() =>
        recordMediaClassification(f.orm, {
          assetId: asset.id,
          category: "ordinary",
          evidence: "platform",
          policy: "orphan",
        }),
      ).toThrow();
      // After a live source link exists, the writes succeed.
      f.seedNote("mn-variant");
      linkMediaAssetSource(f.orm, {
        assetId: asset.id,
        mediaNoteId: "mn-variant",
        scope: f.scope,
        expiresAt: EXPIRES,
      });
      const frames = [{ index: 0 }];
      const first = recordMediaVariant(f.orm, {
        assetId: asset.id,
        policy: "ordinary@512",
        bytes: new Uint8Array([10, 20, 30]),
        mimeType: "image/png",
        width: 8,
        height: 8,
        frameCount: 1,
        frames,
      });
      expect(first.created).toBe(true);
      const again = recordMediaVariant(f.orm, {
        assetId: asset.id,
        policy: "ordinary@512",
        bytes: new Uint8Array([10, 20, 30]),
        mimeType: "image/png",
        width: 8,
        height: 8,
        frameCount: 1,
        frames,
      });
      expect(again.created).toBe(false);
      expect(again.variant.id).toBe(first.variant.id);
      // The same policy slot with different bytes would silently hand the
      // model the wrong picture — refuse instead of overwriting.
      expect(() =>
        recordMediaVariant(f.orm, {
          assetId: asset.id,
          policy: "ordinary@512",
          bytes: new Uint8Array([99, 98, 97]),
          mimeType: "image/png",
        }),
      ).toThrow();
      const other = recordMediaVariant(f.orm, {
        assetId: asset.id,
        policy: "expression@512",
        bytes: new Uint8Array([11, 21, 31]),
        mimeType: "image/png",
        width: 4,
        height: 4,
      });
      expect(other.created).toBe(true);
      expect(mediaVariantFor(f.orm, { assetId: asset.id, policy: "ordinary@512" })?.width).toBe(8);
      expect(mediaVariantFor(f.orm, { assetId: asset.id, policy: "missing" })).toBeNull();
    } finally {
      f.db.close();
    }
  });

  it("keeps platform classification evidence over later model labels and keys policy by model", () => {
    const f = assetFixture();
    try {
      const { asset } = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: new Uint8Array([2, 2, 2]),
        mimeType: "image/gif",
        expiresAt: EXPIRES,
      });
      f.seedNote("mn-classify");
      linkMediaAssetSource(f.orm, {
        assetId: asset.id,
        mediaNoteId: "mn-classify",
        scope: f.scope,
        expiresAt: EXPIRES,
      });
      recordMediaClassification(f.orm, {
        assetId: asset.id,
        category: "ordinary",
        evidence: "platform",
        policy: "p1",
      });
      // A model guess must not overwrite a platform verdict...
      const kept = recordMediaClassification(f.orm, {
        assetId: asset.id,
        category: "expression",
        evidence: "model",
        modelName: "vision-local",
        policy: "p1",
      });
      expect(kept).toMatchObject({ category: "ordinary", evidence: "platform" });
      // ...but another policy keeps its own classification.
      const other = recordMediaClassification(f.orm, {
        assetId: asset.id,
        category: "expression",
        evidence: "model",
        modelName: "vision-local",
        policy: "p2",
      });
      expect(other).toMatchObject({ category: "expression", evidence: "model" });
      // A model classification cached under one model must not be served to a
      // different model's call: the cache match is (asset, policy, model).
      expect(
        mediaClassificationFor(f.orm, {
          assetId: asset.id,
          policy: "p2",
          modelName: "vision-local",
        }),
      ).toMatchObject({ category: "expression" });
      expect(
        mediaClassificationFor(f.orm, {
          assetId: asset.id,
          policy: "p2",
          modelName: "vision-other",
        }),
      ).toBeNull();
      expect(mediaClassificationFor(f.orm, { assetId: asset.id, policy: "p1" })).toMatchObject({
        category: "ordinary",
        evidence: "platform",
      });
      // A model classification must name the model that produced it.
      expect(() =>
        recordMediaClassification(f.orm, {
          assetId: asset.id,
          category: "unknown",
          evidence: "model",
          policy: "p3",
        }),
      ).toThrow();
    } finally {
      f.db.close();
    }
  });

  it("purges expired assets together with their sources, variants and classifications, but only past their windows", () => {
    const f = assetFixture();
    try {
      f.seedNote("mn-purge");
      // The fixture writes the source while it is still valid, then advances
      // the sweep clock past its window — writing an already-expired source is
      // refused by design, so the seed uses a short-but-live window first.
      const shortlyExpired = new Date(Date.now() + 2000)
        .toISOString()
        .replace("Z", "000Z")
        .slice(0, 26);
      const { asset } = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: new Uint8Array([3, 3, 3]),
        mimeType: "image/png",
        expiresAt: shortlyExpired,
      });
      linkMediaAssetSource(f.orm, {
        assetId: asset.id,
        mediaNoteId: "mn-purge",
        scope: f.scope,
        expiresAt: shortlyExpired,
      });
      recordMediaVariant(f.orm, {
        assetId: asset.id,
        policy: "p",
        bytes: new Uint8Array([4, 4, 4]),
        mimeType: "image/png",
      });
      recordMediaClassification(f.orm, {
        assetId: asset.id,
        category: "unknown",
        evidence: "unknown",
        policy: "p",
      });
      // An asset that is still inside its window is untouched.
      const live = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: new Uint8Array([5, 5, 5]),
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      // With nothing expired yet the sweep is a legal no-op: unrelated live
      // assets never block a purge that would delete nothing (purge 返回 0，
      // 不因无关活资产报错)。
      expect(purgeExpiredMediaAssets(f.orm, NOW)).toBe(0);
      // A purge that deletes nothing also leaves everything untouched.
      expect(f.db.query("SELECT count(*) AS n FROM qq_media_assets").get()).toEqual({ n: 2 });
      // Once the window has passed, the sweep drops the expired asset with its
      // children, and the live one stays.
      const after = new Date(Date.now() + 60 * 1000)
        .toISOString()
        .replace("Z", "000Z")
        .slice(0, 26);
      expect(purgeExpiredMediaAssets(f.orm, after)).toBe(1);
      expect(f.db.query("SELECT count(*) AS n FROM qq_media_assets").get()).toEqual({ n: 1 });
      expect(
        mediaAssetForContent(f.orm, {
          scope: f.scope,
          contentSha256: shaOf(new Uint8Array([5, 5, 5])),
          at: NOW,
        })?.id,
      ).toBe(live.asset.id);
      expect(f.db.query("SELECT count(*) AS n FROM qq_media_asset_sources").get()).toEqual({
        n: 0,
      });
      expect(f.db.query("SELECT count(*) AS n FROM qq_media_variants").get()).toEqual({ n: 0 });
      expect(f.db.query("SELECT count(*) AS n FROM qq_media_classifications").get()).toEqual({
        n: 0,
      });
    } finally {
      f.db.close();
    }
  });

  it("the sweep removes only expired rows: a live asset and its live source are never touched", () => {
    const f = assetFixture();
    try {
      f.seedNote("mn-protect");
      // The asset keeps its full window (EXPIRES, 14d); the SOURCE link gets a
      // genuinely shorter window (7d) written while it is still valid. The
      // fixture is internally consistent: the link is created inside both
      // windows, then the sweep clock is advanced — no illegal link, no
      // stretched window.
      const sourceWindow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("Z", "000Z")
        .slice(0, 26);
      const { asset } = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: new Uint8Array([13, 13, 13]),
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      const source = linkMediaAssetSource(f.orm, {
        assetId: asset.id,
        mediaNoteId: "mn-protect",
        scope: f.scope,
        expiresAt: sourceWindow,
      });
      // The negative half first: with nothing expired (at NOW) the sweep is a
      // legal no-op (0) and the protected pair is untouched.
      expect(purgeExpiredMediaAssets(f.orm, NOW)).toBe(0);
      expect(
        f.db.query("SELECT 1 AS x FROM qq_media_asset_sources WHERE id=?").get(source.id),
      ).toBeTruthy();
      // At +7d+ε the source link is expired but the asset is still live
      // (EXPIRES = 14d). M2 裁决 2026-10: the sweep deletes exactly the rows
      // whose own window has passed — the EXPIRED source row goes, the LIVE
      // asset row and any live source are never in the deletion set (活 source
      // 不消失). No error is raised for it: the read through that already-
      // expired link was already dead, so there is no readable access lost.
      const pastSource = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("Z", "000Z")
        .slice(0, 26);
      expect(purgeExpiredMediaAssets(f.orm, pastSource)).toBe(0);
      expect(f.db.query("SELECT count(*) AS n FROM qq_media_assets").get()).toEqual({ n: 1 });
      expect(
        f.db.query("SELECT 1 AS x FROM qq_media_asset_sources WHERE id=?").get(source.id),
      ).toBeNull();
      // The live asset itself is not removed by the sweep.
      expect(
        f.db.query("SELECT 1 AS x FROM qq_media_assets WHERE id=?").get(asset.id),
      ).toBeTruthy();
      // After the asset's own window has passed too, the sweep deletes it.
      expect(
        purgeExpiredMediaAssets(
          f.orm,
          new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
            .toISOString()
            .replace("Z", "000Z")
            .slice(0, 26),
        ),
      ).toBe(1);
      expect(f.db.query("SELECT count(*) AS n FROM qq_media_assets").get()).toEqual({ n: 0 });
    } finally {
      f.db.close();
    }
  });

  it("a second source with the same sha never extends the first source's window, and a dead source does not revive through another live source", () => {
    const f = assetFixture();
    try {
      f.seedNote("mn-early");
      // The late media note carries a genuinely longer window of its own.
      f.seedNote("mn-late", PEER, LATER);
      const png = new Uint8Array([137, 80, 78, 71, 7, 8, 9]);
      const { asset } = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: png,
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      // Source 1 carries the earlier window; source 2 the later one.
      const s1 = linkMediaAssetSource(f.orm, {
        assetId: asset.id,
        mediaNoteId: "mn-early",
        scope: f.scope,
        expiresAt: EXPIRES,
      });
      const s2 = linkMediaAssetSource(f.orm, {
        assetId: asset.id,
        mediaNoteId: "mn-late",
        scope: f.scope,
        expiresAt: LATER,
      });
      // The link's own window is the earliest of the media row's window, the
      // caller's window and the asset's cap: the later source never stretches
      // the earlier one (写不延长).
      expect(Date.parse(s2.expiresAt)).toBeLessThanOrEqual(Date.parse(s1.expiresAt));
      // A read past the stored earliest cap is dead for BOTH messages — the
      // later source does not extend the asset's (and neither message's) window.
      const pastCap = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("Z", "000Z")
        .slice(0, 26);
      expect(
        mediaAssetForMediaNote(f.orm, { mediaNoteId: "mn-early", scope: f.scope, at: pastCap }),
      ).toBeNull();
      expect(
        mediaAssetForMediaNote(f.orm, { mediaNoteId: "mn-late", scope: f.scope, at: pastCap }),
      ).toBeNull();
      // Inside both windows both reads are alive.
      expect(
        mediaAssetForMediaNote(f.orm, { mediaNoteId: "mn-early", scope: f.scope, at: NOW })?.asset
          .id,
      ).toBe(asset.id);
      expect(
        mediaAssetForMediaNote(f.orm, { mediaNoteId: "mn-late", scope: f.scope, at: NOW })?.asset
          .id,
      ).toBe(asset.id);
      // Deleting the late source row removes only that message's read path —
      // the read never borrows the other live source of the same asset
      // (来源删除不借其他 live source 复活); the early note is unaffected.
      f.db.query("DELETE FROM qq_media_asset_sources WHERE id=?").run(s2.id);
      expect(
        mediaAssetForMediaNote(f.orm, { mediaNoteId: "mn-late", scope: f.scope, at: NOW }),
      ).toBeNull();
      expect(
        mediaAssetForMediaNote(f.orm, { mediaNoteId: "mn-early", scope: f.scope, at: NOW })?.asset
          .id,
      ).toBe(asset.id);
    } finally {
      f.db.close();
    }
  });

  it("a purge with only unrelated live assets deletes nothing and returns 0", () => {
    const f = assetFixture();
    try {
      f.seedNote("mn-only-live");
      const { asset } = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: new Uint8Array([21, 21, 21]),
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      linkMediaAssetSource(f.orm, {
        assetId: asset.id,
        mediaNoteId: "mn-only-live",
        scope: f.scope,
        expiresAt: EXPIRES,
      });
      // Nothing is expired: the sweep is a legal no-op (0), not an error —
      // unrelated live assets never block a purge that would delete nothing.
      expect(purgeExpiredMediaAssets(f.orm, NOW)).toBe(0);
      expect(f.db.query("SELECT count(*) AS n FROM qq_media_assets").get()).toEqual({ n: 1 });
      expect(f.db.query("SELECT count(*) AS n FROM qq_media_asset_sources").get()).toEqual({
        n: 1,
      });
    } finally {
      f.db.close();
    }
  });

  it("refills an expired (scope, sha) row for a genuinely new source and never revives its old links", () => {
    const f = assetFixture();
    try {
      f.seedNote("mn-old");
      const png = new Uint8Array([137, 80, 78, 71, 42, 42, 42]);
      const first = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: png,
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      const oldSource = linkMediaAssetSource(f.orm, {
        assetId: first.asset.id,
        mediaNoteId: "mn-old",
        scope: f.scope,
        expiresAt: EXPIRES,
      });
      const oldVariant = recordMediaVariant(f.orm, {
        assetId: first.asset.id,
        policy: "ordinary@512",
        bytes: new Uint8Array([31, 32, 33]),
        mimeType: "image/png",
      });
      recordMediaClassification(f.orm, {
        assetId: first.asset.id,
        category: "ordinary",
        evidence: "platform",
        policy: "p1",
      });
      // +20d: the OLD asset row and its old source link are expired. A NEW
      // message of the same content arrives with its own CURRENTLY-VALID
      // +30d window (F1 裁决: 过期行不能永久挡新合法消息的实际新 bytes).
      const at20d = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("Z", "000Z")
        .slice(0, 26);
      const expires30d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("Z", "000Z")
        .slice(0, 26);
      f.seedNote("mn-new", PEER, expires30d);
      const second = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: png.slice(),
        mimeType: "image/png",
        expiresAt: expires30d,
        at: at20d,
      });
      expect(second.created).toBe(false);
      expect(second.asset.id).toBe(first.asset.id);
      expect(second.asset.expiresAt).toBe(expires30d);
      // The refill advances the revision: old refs' revision no longer matches.
      expect(second.asset.revision).toBe(first.asset.revision + 1);
      // Derivatives from the old cache epoch are gone, and only a NEW link can
      // read the refilled bytes again.
      expect(
        mediaVariantFor(f.orm, { assetId: first.asset.id, policy: "ordinary@512" }),
      ).toBeNull();
      expect(mediaClassificationFor(f.orm, { assetId: first.asset.id, policy: "p1" })).toBeNull();
      // The OLD source row survives untouched with its ORIGINAL expiry — it is
      // never deleted (cascade would wipe the read task's asset_source_id), and
      // it is never extended.
      const oldRow = f.db
        .query("SELECT * FROM qq_media_asset_sources WHERE id=?")
        .get(oldSource.id) as { expires_at: string };
      expect(oldRow.expires_at).toBe(EXPIRES);
      // A read through the old link stays dead: the link is past its window at
      // +20d, and the old media note expired too — nothing was revived.
      expect(
        mediaAssetForMediaNote(f.orm, {
          mediaNoteId: "mn-old",
          scope: f.scope,
          at: at20d,
        }),
      ).toBeNull();
      // The new bytes become readable through a NEW link only.
      const newSource = linkMediaAssetSource(f.orm, {
        assetId: second.asset.id,
        mediaNoteId: "mn-new",
        scope: f.scope,
        expiresAt: expires30d,
        at: at20d,
      });
      expect(newSource.id).not.toBe(oldSource.id);
      expect(
        mediaAssetForMediaNote(f.orm, { mediaNoteId: "mn-new", scope: f.scope, at: at20d })?.asset
          .id,
      ).toBe(first.asset.id);
      expect(oldVariant.created).toBe(true);
      // The variant cache is refillable only through the new epoch (a live
      // source exists again), with fresh bytes.
      const refilledVariant = recordMediaVariant(f.orm, {
        assetId: first.asset.id,
        policy: "ordinary@512",
        bytes: new Uint8Array([34, 35, 36]),
        mimeType: "image/png",
        at: at20d,
      });
      expect(refilledVariant.created).toBe(true);
    } finally {
      f.db.close();
    }
  });

  // Race simulation without touching production code: BEFORE triggers stand in
  // for the concurrent writer. A trigger REWRITES the row to the racer's
  // committed state and then RAISE(IGNORE) skips OUR guarded write — exactly a
  // CAS miss against a row that has moved. The assertions compare the RETURNED
  // row against a fresh SELECT, not against what the call produced.
  it("returns the row the DB actually holds when a concurrent refiller wins the expired-row CAS (return fidelity)", () => {
    const f = assetFixture();
    try {
      f.seedNote("mn-race1");
      const png = new Uint8Array([137, 80, 78, 71, 71, 71, 71]);
      const first = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: png,
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      // The row expired the way the sweep would NOT (retention deletes) — a
      // direct expiry UPDATE stands in for "time passed" with revision kept.
      f.db
        .query("UPDATE qq_media_assets SET expires_at='2020-01-01T00:00:00.000000Z' WHERE id=?")
        .run(first.asset.id);
      // The "concurrent refiller": between our pre-read and our refill CAS, it
      // commits a new epoch (revision 7, live window, different mime) — our
      // refill then misses its CAS.
      f.db.exec(`CREATE TRIGGER concurrent_refill BEFORE UPDATE ON qq_media_assets
        WHEN NEW.revision = OLD.revision + 1 AND OLD.expires_at <= '2026-02-02T00:00:00.000000Z'
        BEGIN
          UPDATE qq_media_assets SET revision = 7, expires_at = '2032-01-01T00:00:00.000000Z',
            mime_type = 'image/jpeg' WHERE id = OLD.id;
          SELECT RAISE(IGNORE);
        END`);
      const second = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: png.slice(),
        mimeType: "image/png",
        expiresAt: LATER,
      });
      // The returned row must equal what the DB holds RIGHT NOW — the racer's
      // committed state, never the stale pre-transaction snapshot.
      const truth = f.db
        .query("SELECT id, revision, expires_at, mime_type FROM qq_media_assets WHERE id=?")
        .get(first.asset.id) as {
        id: string;
        revision: number;
        expires_at: string;
        mime_type: string;
      };
      expect(second.created).toBe(false);
      expect(second.asset.id).toBe(truth.id);
      expect(second.asset.revision).toBe(truth.revision);
      expect(second.asset.expiresAt).toBe(truth.expires_at);
      expect(second.asset.mimeType).toBe(truth.mime_type);
      expect(truth.revision).toBe(7);
    } finally {
      f.db.close();
    }
  });

  it("returns the row the DB actually holds when a raced insert lands an expired row and another refiller wins its CAS", () => {
    const f = assetFixture();
    try {
      const png = new Uint8Array([137, 80, 78, 71, 81, 81, 81]);
      const sha = shaOf(png);
      // Racer 1: our first INSERT conflicts — the racer's EXPIRED row is already
      // there (created by the trigger, then our insert is skipped).
      f.db.exec(`CREATE TRIGGER racer_insert BEFORE INSERT ON qq_media_assets
        WHEN (SELECT count(*) FROM qq_media_assets WHERE content_sha256 = NEW.content_sha256) = 0
        BEGIN
          INSERT INTO qq_media_assets (id, account_id, conversation_kind, peer_id, agent_id,
            content_sha256, bytes, mime_type, revision, expires_at, recorded_at)
            VALUES ('racer-asset', NEW.account_id, NEW.conversation_kind, NEW.peer_id, NEW.agent_id,
              NEW.content_sha256, NEW.bytes, NEW.mime_type, 1, '2020-01-01T00:00:00.000000Z',
              '${NOW}');
          SELECT RAISE(IGNORE);
        END`);
      // Racer 2: the refill CAS for that expired raced row misses too — the
      // concurrent refiller commits revision 9 + a live window first.
      f.db.exec(`CREATE TRIGGER concurrent_refill BEFORE UPDATE ON qq_media_assets
        WHEN NEW.revision = OLD.revision + 1
        BEGIN
          UPDATE qq_media_assets SET revision = 9, expires_at = '2033-01-01T00:00:00.000000Z',
            mime_type = 'image/webp' WHERE id = OLD.id;
          SELECT RAISE(IGNORE);
        END`);
      const out = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: png,
        mimeType: "image/png",
        expiresAt: LATER,
      });
      const truth = f.db
        .query(
          "SELECT id, revision, expires_at, mime_type FROM qq_media_assets WHERE content_sha256=?",
        )
        .get(sha) as { id: string; revision: number; expires_at: string; mime_type: string };
      expect(out.created).toBe(false);
      expect(out.asset.id).toBe(truth.id);
      expect(out.asset.revision).toBe(truth.revision);
      expect(out.asset.expiresAt).toBe(truth.expires_at);
      expect(out.asset.mimeType).toBe(truth.mime_type);
      expect(truth.revision).toBe(9);
    } finally {
      f.db.close();
    }
  });

  // Raced insert lands a LIVE row, and another writer narrows it between our
  // re-read and our narrowing UPDATE (our CAS guard misses) — the return must
  // be the row the DB actually holds (2034), not the stale 2035 snapshot.
  it("returns the row the DB actually holds when another writer wins the raced live-row narrowing CAS", () => {
    const f = assetFixture();
    try {
      const png = new Uint8Array([137, 80, 78, 71, 91, 91, 92]);
      const sha = shaOf(png);
      // Racer 1: our INSERT conflicts — the racer's LIVE 2035 row is already
      // there (created by the trigger, our insert skipped).
      f.db.exec(`CREATE TRIGGER racer_insert BEFORE INSERT ON qq_media_assets
        WHEN (SELECT count(*) FROM qq_media_assets WHERE content_sha256 = NEW.content_sha256) = 0
        BEGIN
          INSERT INTO qq_media_assets (id, account_id, conversation_kind, peer_id, agent_id,
            content_sha256, bytes, mime_type, revision, expires_at, recorded_at)
            VALUES ('racer-asset-live', NEW.account_id, NEW.conversation_kind, NEW.peer_id,
              NEW.agent_id, NEW.content_sha256, NEW.bytes, NEW.mime_type, 1,
              '2035-01-01T00:00:00.000000Z', '${NOW}');
          SELECT RAISE(IGNORE);
        END`);
      // The trigger narrows the row and skips this update to simulate a raced write.
      f.db.exec(`CREATE TRIGGER concurrent_narrow BEFORE UPDATE ON qq_media_assets
        WHEN OLD.expires_at = '2035-01-01T00:00:00.000000Z' AND NEW.expires_at = '2033-01-01T00:00:00.000000Z'
        BEGIN
          UPDATE qq_media_assets SET expires_at = '2034-01-01T00:00:00.000000Z' WHERE id = OLD.id;
          SELECT RAISE(IGNORE);
        END`);
      // This write proposes 2033; the simulated concurrent row ends at 2034.
      const out = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: png,
        mimeType: "image/png",
        expiresAt: "2033-01-01T00:00:00.000000Z",
      });
      const truth = f.db
        .query(
          "SELECT id, revision, expires_at, mime_type FROM qq_media_assets WHERE content_sha256=?",
        )
        .get(sha) as { id: string; revision: number; expires_at: string; mime_type: string };
      expect(out.created).toBe(false);
      expect(out.asset.id).toBe(truth.id);
      expect(out.asset.expiresAt).toBe(truth.expires_at);
      expect(out.asset.expiresAt).toBe("2034-01-01T00:00:00.000000Z");
      expect(truth.revision).toBe(1);
    } finally {
      f.db.close();
    }
  });

  it("returns the platform row the DB actually holds when a platform write wins the raced classification slot", () => {
    const f = assetFixture();
    try {
      const { asset } = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: new Uint8Array([91, 91, 91]),
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      f.seedNote("mn-class-race");
      linkMediaAssetSource(f.orm, {
        assetId: asset.id,
        mediaNoteId: "mn-class-race",
        scope: f.scope,
        expiresAt: EXPIRES,
      });
      // Racer 1: our INSERT conflicts — a model classification already occupies
      // the (asset, policy) slot (created by the trigger, ours skipped).
      f.db.exec(`CREATE TRIGGER racer_insert BEFORE INSERT ON qq_media_classifications
        WHEN (SELECT count(*) FROM qq_media_classifications
                WHERE asset_id = NEW.asset_id AND policy = NEW.policy) = 0
        BEGIN
          INSERT INTO qq_media_classifications (id, asset_id, category, evidence, model_name, policy, recorded_at)
            VALUES ('racer-cls', NEW.asset_id, 'unknown', 'model', 'racer-model', NEW.policy, '${NOW}');
          SELECT RAISE(IGNORE);
        END`);
      // Racer 2: a PLATFORM write lands between our slot re-read and our
      // guarded UPDATE — the guard (`evidence <> 'platform'`) misses.
      f.db.exec(`CREATE TRIGGER platform_wins BEFORE UPDATE ON qq_media_classifications
        WHEN OLD.evidence <> 'platform' AND OLD.id = 'racer-cls'
        BEGIN
          UPDATE qq_media_classifications SET evidence='platform', category='ordinary',
            model_name=NULL WHERE id=OLD.id;
          SELECT RAISE(IGNORE);
        END`);
      const out = recordMediaClassification(f.orm, {
        assetId: asset.id,
        category: "expression",
        evidence: "model",
        modelName: "mine",
        policy: "p1",
      });
      const truth = f.db
        .query(
          "SELECT category, evidence, model_name FROM qq_media_classifications WHERE asset_id=? AND policy='p1'",
        )
        .get(asset.id) as { category: string; evidence: string; model_name: string | null };
      // The return must be the platform row the DB actually holds — platform
      // wins is unchanged; only the return fidelity is pinned.
      expect(out.evidence).toBe(truth.evidence);
      expect(out.category).toBe(truth.category);
      expect(out.modelName).toBe(truth.model_name);
      expect(truth.evidence).toBe("platform");
      expect(truth.category).toBe("ordinary");
    } finally {
      f.db.close();
    }
  });

  it("a future expiry never widens a live row and old links stay exact after unrelated expiries are swept", () => {
    const f = assetFixture();
    try {
      f.seedNote("mn-live");
      const png = new Uint8Array([51, 52, 53]);
      const live = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: png,
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      linkMediaAssetSource(f.orm, {
        assetId: live.asset.id,
        mediaNoteId: "mn-live",
        scope: f.scope,
        expiresAt: EXPIRES,
      });
      // A write carrying a FUTURE window cannot widen the live row's cap
      // (livehit 仍最早帽，不允许用未来 expiry 偷延活行).
      const future = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: png.slice(),
        mimeType: "image/png",
        expiresAt: LATER,
      });
      expect(future.asset.expiresAt).toBe(EXPIRES);
      // An already-dead source row (its window passed) no longer blocks the
      // cleanup of UNRELATED expiries (M2 裁决): the sweep deletes exactly the
      // expired rows and nothing else. The dead asset is written with a
      // genuinely past-its-window-later SHORT window while live, so at the
      // sweep clock both it and its source are expired together.
      f.seedNote("mn-dead-src", PEER, EXPIRES);
      const shortlyExpired = new Date(Date.now() + 2000)
        .toISOString()
        .replace("Z", "000Z")
        .slice(0, 26);
      const deadAsset = recordMediaAsset(f.orm, {
        scope: f.scope,
        bytes: new Uint8Array([61, 62, 63]),
        mimeType: "image/png",
        expiresAt: shortlyExpired,
      });
      const deadSource = linkMediaAssetSource(f.orm, {
        assetId: deadAsset.asset.id,
        mediaNoteId: "mn-dead-src",
        scope: f.scope,
        expiresAt: shortlyExpired,
      });
      // The sweep clock sits between the dead asset's short window (+2s) and
      // the live asset's window (+14d): exactly the dead asset and its source
      // are deleted, the live pair is untouched.
      const pastDead = new Date(Date.now() + 10_000)
        .toISOString()
        .replace("Z", "000Z")
        .slice(0, 26);
      expect(purgeExpiredMediaAssets(f.orm, pastDead)).toBe(1);
      expect(
        f.db.query("SELECT 1 AS x FROM qq_media_asset_sources WHERE id=?").get(deadSource.id),
      ).toBeNull();
      // The live asset keeps its row and its live source.
      expect(
        mediaAssetForMediaNote(f.orm, { mediaNoteId: "mn-live", scope: f.scope, at: NOW })?.asset
          .id,
      ).toBe(live.asset.id);
    } finally {
      f.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// media.read action (plan T08 Step8): safe projection of prepared pictures.
// ---------------------------------------------------------------------------

const BINDING_ID = "11111111-1111-4111-8111-111111111111";

interface ToolsFixture {
  h: ReturnType<typeof openBusinessDb>;
  conversationId: string;
  baseSeconds: number;
  /** The exact QqConversationScope of the fixture's (binding, conversation) pair. */
  scope: QqConversationScope;
  image(eventKey: string): NonNullable<ReturnType<typeof mediaNoteRow>>;
  /** 真实统一入口 mint：真实 EvidenceStore + 完整 scope，非伪 scope。 */
  mint(mediaNoteId: string, at?: string): SourceRef | null;
  mount(input: { readImage?: QqMediaToolsOptions["readImage"] }): {
    actions: BuiltInAction[];
    named(name: string): BuiltInAction;
  };
  context(): { controller: AbortController; ctx: ActionContext };
}

function toolsFixture(): ToolsFixture {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT, enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, { name: "qq-media-read-action-test" });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: BINDING_ID,
      accountId: ACCOUNT,
      conversationKind: "group",
      peerId: PEER,
      agentId: AGENT,
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
  const binding = readBindingByConversation(h.orm, {
    accountId: ACCOUNT,
    kind: "group",
    peerId: PEER,
  });
  if (!binding) throw new Error("binding fixture missing");
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation fixture missing");
  const scope: QqConversationScope = {
    conversationId: conversation.id,
    accountId: ACCOUNT,
    conversationKind: "group",
    peerId: PEER,
    agentId: AGENT,
    bindingId: binding.id,
    bindingEpoch: conversation.bindingEpoch,
    authorityRevision: binding.authorityRevision,
  };
  const baseSeconds = Math.floor(Date.now() / 1000);
  const image = (eventKey: string) => {
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        messageId: `message-${eventKey}`,
        occurredAtSeconds: baseSeconds,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: nowIso(),
      })
      .run();
    journal.ingestOneBotEvent(eventKey, binding.id, { reasons: ["mention"], mentionIds: [] });
    const row0 = recordMediaSegment(h.orm, {
      eventKey,
      segmentIndex: 0,
      kind: "image",
      sourceRef: `ref-${eventKey}`,
      occurredAtSeconds: baseSeconds,
      addressed: true,
    });
    // 真实 journal inbound 携带精确 qq_media 来源（inTimeline 的唯一事实来源），
    // 不放宽生产 inTimeline：夹具按真实 ConversationEventRepository.append 形状写入。
    journal.append({
      conversationId: conversation.id,
      eventKey: `media-src:${row0.id}`,
      kind: "inbound",
      source: {
        kind: "qq_media",
        id: row0.id,
        revision: String(row0.attempts),
        expiresAt: row0.expiresAt,
      },
      sources: [
        { kind: "qq_event", id: eventKey, revision: nowIso() },
        {
          kind: "qq_media",
          id: row0.id,
          revision: String(row0.attempts),
          expiresAt: row0.expiresAt,
        },
      ],
      occurredAt: nowIso(),
    });
    const row = mediaNoteRow(h.orm, eventKey, 0);
    if (!row) throw new Error("media fixture missing");
    return row;
  };
  const mint = (mediaNoteId: string, at?: string): SourceRef | null =>
    createQqMediaSourceRef(h, scope, mediaNoteId, at ?? nowIso());
  const mount = (input: { readImage?: QqMediaToolsOptions["readImage"] }) => {
    const actions = createQqMediaTools({
      db: h.db,
      orm: h.orm,
      conversationId: conversation.id,
      binding,
      adapter: { capabilities: ["image"] as const, read: async () => "unused" },
      modelConfig: { visionModelName: "vision-local", transcriptionModelName: null },
      supplementWindowMinutes: 30,
      policyRevision: "test-policy",
      assertCurrent: () => {},
      fit: async () => () => true,
      evidence: { db: h.db, orm: h.orm },
      ...(input.readImage === undefined ? {} : { readImage: input.readImage }),
    });
    return {
      actions,
      named: (name: string) => {
        const action = actions.find((entry) => entry.description.name === name);
        if (!action) throw new Error(`missing action ${name}`);
        return action;
      },
    };
  };
  const context = () => {
    const controller = new AbortController();
    return {
      controller,
      ctx: {
        owner: {
          kind: "conversation" as const,
          id: conversation.id,
          userId: DEFAULT_USER_ID,
          agentId: AGENT,
        },
        runId: "run-1",
        signal: controller.signal,
      },
    };
  };
  return { h, conversationId: conversation.id, baseSeconds, scope, image, mint, mount, context };
}

describe("media.read action", () => {
  it("is declared read-only with a strict {id} schema", () => {
    expect(QQ_MEDIA_TOOL_DESCRIPTIONS["media.read"]).toMatchObject({
      name: "media.read",
      capability: "media.read",
      effect: "read",
    });
    expect(QQ_MEDIA_TOOL_SCHEMAS["media.read"].parse({ id: "m1" })).toEqual({ id: "m1" });
    expect(() => QQ_MEDIA_TOOL_SCHEMAS["media.read"].parse({})).toThrow();
    expect(() =>
      QQ_MEDIA_TOOL_SCHEMAS["media.read"].parse({ id: "m1", url: "http://x" }),
    ).toThrow();
  });

  it("projects prepared picture metadata without bytes or fetch references", async () => {
    const f = toolsFixture();
    try {
      const row = f.image("img-read");
      const png = new Uint8Array([137, 80, 78, 71, 4, 5, 6]);
      // The asset is real AND linked to the actual media row: a bare asset
      // without a live source link authorizes nothing (来源链接才授权).
      const { asset } = recordMediaAsset(f.h.orm, {
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        bytes: png,
        mimeType: "image/png",
        expiresAt: EXPIRES,
      });
      linkMediaAssetSource(f.h.orm, {
        assetId: asset.id,
        mediaNoteId: row.id,
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        expiresAt: EXPIRES,
      });
      // 真实统一入口 mint：id = 精确媒体行、revision = 完整 scope + 现值 hash、
      // expiresAt = 实际消费帽；raw qq_media_asset 宽授权已关闭，不再造旧引用。
      const source = f.mint(row.id);
      expect(source).not.toBeNull();
      if (!source) return;
      expect(source.kind).toBe("qq_media_source");
      expect(source.id).toBe(row.id);
      expect(Date.parse(source.expiresAt ?? "") <= Date.parse(EXPIRES)).toBe(true);
      // 媒体工具的 callback 真正返回 mint 出的这个 source（宿主服务语义）。
      const tool = f.mount({
        readImage: async () => ({
          category: "ordinary",
          images: [
            {
              source,
              mimeType: "image/png",
              sha256: shaOf(png),
              width: 8,
              height: 8,
              frameIndex: null,
            },
          ],
        }),
      });
      const { ctx } = f.context();
      await tool.named("media.list").execute({}, ctx);
      const observation = await tool.named("media.read").execute({ id: row.id }, ctx);
      const value = observation.value as Record<string, unknown>;
      expect(value).toEqual({
        status: "ok",
        mediaId: row.id,
        category: "ordinary",
        images: [
          {
            sourceId: source.id,
            revision: source.revision,
            mimeType: "image/png",
            sha256: shaOf(png),
            width: 8,
            height: 8,
            frameIndex: null,
          },
        ],
      });
      // 绝无 bytes/base64，也绝不外显取流引用。
      const text = JSON.stringify(observation);
      expect(text).not.toContain("ref-img-read");
      expect(text).not.toContain("base64");
      // The minted source must survive the host-side access resolver (统一入口 available，
      // 非伪 scope)：真实完整 owner 四维身份 + 真实现值复验。
      assertContextSources({
        db: f.h.db,
        sources: observation.sources,
        owner: {
          kind: "conversation",
          id: f.conversationId,
          userId: DEFAULT_USER_ID,
          agentId: AGENT,
        },
        now: nowIso(),
        memoryRevisions: () => new Map(),
        messages: { memory: "memory changed", other: "source changed" },
      });
    } finally {
      f.h.close();
    }
  });

  it("refuses ids that media.list never disclosed in this run", async () => {
    const f = toolsFixture();
    try {
      const row = f.image("img-secret");
      const tool = f.mount({ readImage: async () => ({ category: "ordinary", images: [] }) });
      const { ctx } = f.context();
      await expect(tool.named("media.read").execute({ id: row.id }, ctx)).rejects.toMatchObject({
        code: "CONTEXT_INVALID_SELECTION",
      });
    } finally {
      f.h.close();
    }
  });

  it("surfaces authority failures and maps other failures to a safe code", async () => {
    const f = toolsFixture();
    try {
      const row = f.image("img-fail");
      const tool = f.mount({
        readImage: (input) => {
          if (input.mediaNoteId === row.id)
            throw new Error("fetch failed https://secret-upstream/path");
          return Promise.resolve({ category: "ordinary", images: [] });
        },
      });
      const { ctx } = f.context();
      await tool.named("media.list").execute({}, ctx);
      const observation = await tool.named("media.read").execute({ id: row.id }, ctx);
      expect(observation.value).toEqual({ status: "unavailable", code: "image_unavailable" });
      // 失败返码只给安全 code，不泄露源 URL。
      expect(JSON.stringify(observation)).not.toContain("secret-upstream");
    } finally {
      f.h.close();
    }
  });

  it("never swallows an authority failure into a continueable tool error", async () => {
    const f = toolsFixture();
    try {
      const row = f.image("img-authority");
      const tool = f.mount({
        readImage: async () => {
          fail("MEMORY_SOURCE_INVALID", "媒体授权已变化");
        },
      });
      const { ctx } = f.context();
      await tool.named("media.list").execute({}, ctx);
      await expect(tool.named("media.read").execute({ id: row.id }, ctx)).rejects.toMatchObject({
        code: "MEMORY_SOURCE_INVALID",
      });
    } finally {
      f.h.close();
    }
  });

  it("is not advertised without a wired picture service", () => {
    const f = toolsFixture();
    try {
      const { actions } = f.mount({});
      expect(actions.some((action) => action.description.name === "media.read")).toBe(false);
    } finally {
      f.h.close();
    }
  });
});
