import { describe, expect, it, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { consumeModelMediaData } from "../../src/server/channels/onebot11/media-input-service";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  linkMediaAssetSource,
  mediaClassificationFor,
  recordMediaAsset,
  recordMediaClassification,
} from "../../src/server/db/qq-media-asset-repository";
import { recordMediaSegment } from "../../src/server/db/qq-media-repository";
import {
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
  type Orm,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { AppError } from "../../src/server/errors";
import { createQqMediaSourceRef } from "../../src/server/services/qq-media-sources";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";

const AGENT = "00000000-0000-0000-0000-000000000001";
const ACCOUNT = "10001";
const PEER = "30003";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const MODEL = "synthetic-model";
const POLICY = "policy-native-v1";

interface Fixture {
  h: ReturnType<typeof openBusinessDb>;
  orm: Orm;
  db: ReturnType<typeof openBusinessDb>["db"];
  conversationId: string;
  scope: QqConversationScope;
  owner: RunOwner;
  mediaWithJournal(eventKey: string): { id: string; expiresAt: string };
  mint(mediaNoteId: string): SourceRef | null;
  mintWithPastCap(mediaNoteId: string, cap: string, mintAt: string): SourceRef | null;
  linkAsset(mediaNoteId: string): { assetId: string };
  assetIdOf(mediaNoteId: string): string;
  classificationCount(): number;
}

function createScheme(orm: Orm): { id: string } {
  return orm
    .insert(schema.qqSchemes)
    .values({
      id: crypto.randomUUID(),
      name: `qq-media-classification-${crypto.randomUUID()}`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .returning()
    .get();
}

function openFixture(): Fixture {
  const h = openBusinessDb();
  ensureDefaults(h.orm, MODEL);
  const scheme = createScheme(h.orm);
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
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(BINDING_ID);
  if (!conversation) throw new Error("conversation fixture missing");
  const scope: QqConversationScope = {
    conversationId: conversation.id,
    accountId: ACCOUNT,
    conversationKind: "group",
    peerId: PEER,
    agentId: AGENT,
    bindingId: BINDING_ID,
    bindingEpoch: conversation.bindingEpoch,
    authorityRevision: 1,
  };
  const owner: RunOwner = {
    kind: "conversation",
    id: conversation.id,
    userId: DEFAULT_USER_ID,
    agentId: AGENT,
  };
  const future = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const mediaWithJournal = (eventKey: string) => {
    const occurred = Math.floor(Date.now() / 1000);
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        messageId: `message-${eventKey}`,
        occurredAtSeconds: occurred,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: nowIso(),
      })
      .run();
    h.orm
      .insert(schema.qqObservationText)
      .values({
        eventKey,
        body: `body-${eventKey}`,
        occurredAtSeconds: occurred,
        expiresAt: future,
        recordedAt: nowIso(),
      })
      .run();
    journal.ingestOneBotEvent(eventKey, BINDING_ID);
    const seg = recordMediaSegment(h.orm, {
      eventKey,
      segmentIndex: 0,
      kind: "image",
      sourceRef: `ref-${eventKey}`,
      occurredAtSeconds: occurred,
      addressed: true,
    });
    journal.append({
      conversationId: conversation.id,
      eventKey: `media-src:${seg.id}`,
      kind: "inbound",
      source: {
        kind: "qq_media",
        id: seg.id,
        revision: String(seg.attempts),
        expiresAt: seg.expiresAt,
      },
      sources: [
        { kind: "qq_event", id: eventKey, revision: nowIso() },
        { kind: "qq_media", id: seg.id, revision: String(seg.attempts), expiresAt: seg.expiresAt },
      ],
      occurredAt: nowIso(),
    });
    return { id: seg.id, expiresAt: seg.expiresAt };
  };
  const linkAsset = (mediaNoteId: string) => {
    const { asset } = recordMediaAsset(h.orm, {
      scope: {
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
      },
      bytes: new Uint8Array([137, 80, 78, 71, mediaNoteId.length, mediaNoteId.charCodeAt(3)]),
      mimeType: "image/png",
      expiresAt: future,
    });
    linkMediaAssetSource(h.orm, {
      assetId: asset.id,
      mediaNoteId,
      scope: {
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
      },
      expiresAt: future,
    });
    return { assetId: asset.id };
  };
  const assetIdOf = (mediaNoteId: string): string => {
    const row = h.orm
      .select({ assetId: schema.qqMediaAssetSources.assetId })
      .from(schema.qqMediaAssetSources)
      .where(eq(schema.qqMediaAssetSources.mediaNoteId, mediaNoteId))
      .get();
    if (!row) throw new Error(`fixture: no asset source for ${mediaNoteId}`);
    return row.assetId;
  };
  const mint = (mediaNoteId: string) => {
    linkAsset(mediaNoteId);
    return createQqMediaSourceRef(h, scope, mediaNoteId, nowIso());
  };
  // Mint while a soon-to-expire window is still live, using an explicit prior
  // `at` (the real clock has already passed `cap`).
  const mintWithPastCap = (mediaNoteId: string, cap: string, mintAt: string) => {
    const { asset } = recordMediaAsset(h.orm, {
      scope: {
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
      },
      bytes: new Uint8Array([137, 80, 78, 71, mediaNoteId.length, mediaNoteId.charCodeAt(3)]),
      mimeType: "image/png",
      expiresAt: cap,
      at: mintAt,
    });
    linkMediaAssetSource(h.orm, {
      assetId: asset.id,
      mediaNoteId,
      scope: {
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
      },
      expiresAt: cap,
      at: mintAt,
    });
    return createQqMediaSourceRef(h, scope, mediaNoteId, mintAt);
  };
  const classificationCount = () =>
    h.orm.select({ id: schema.qqMediaClassifications.id }).from(schema.qqMediaClassifications).all()
      .length;
  return {
    h,
    orm: h.orm,
    db: h.db,
    conversationId: conversation.id,
    scope,
    owner,
    mediaWithJournal,
    mint,
    mintWithPastCap,
    linkAsset,
    assetIdOf,
    classificationCount,
  };
}

function consume(f: Fixture, input: Partial<Parameters<typeof consumeModelMediaData>[0]>) {
  return consumeModelMediaData({
    store: f.h,
    owner: f.owner,
    scope: f.scope,
    sentMediaIds: new Set<string>(),
    sentSources: new Map<string, SourceRef>(),
    classifications: [],
    actualModel: MODEL,
    policyRevision: POLICY,
    assertCurrent: () => {},
    ...input,
  });
}

describe("consumeModelMediaData", () => {
  it("writes two model classifications for one call with zero model calls", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-ok-a");
      const b = f.mediaWithJournal("ev-ok-b");
      const refA = f.mint(a.id);
      const refB = f.mint(b.id);
      expect(refA).not.toBeNull();
      expect(refB).not.toBeNull();
      if (!refA || !refB) return;
      const fetchSpy = spyOn(globalThis, "fetch");
      try {
        consume(f, {
          sentMediaIds: new Set([a.id, b.id]),
          sentSources: new Map([
            [a.id, refA],
            [b.id, refB],
          ]),
          classifications: [
            { mediaId: a.id, category: "ordinary" },
            { mediaId: b.id, category: "expression" },
          ],
        });
        expect(fetchSpy).toHaveBeenCalledTimes(0);
      } finally {
        fetchSpy.mockRestore();
      }
      const assetIds = f.orm
        .select({
          assetId: schema.qqMediaAssetSources.assetId,
          mediaNoteId: schema.qqMediaAssetSources.mediaNoteId,
        })
        .from(schema.qqMediaAssetSources)
        .all();
      for (const row of assetIds) {
        const cached = mediaClassificationFor(f.orm, {
          assetId: row.assetId,
          policy: POLICY,
          modelName: MODEL,
        });
        expect(cached).not.toBeNull();
        expect(cached?.evidence).toBe("model");
        expect(cached?.modelName).toBe(MODEL);
      }
      const rows = f.orm.select().from(schema.qqMediaClassifications).all();
      expect(rows.map((r) => r.category).sort()).toEqual(["expression", "ordinary"]);
      expect(f.classificationCount()).toBe(2);
    } finally {
      f.h.close();
    }
  });

  it("an unsent second entry refuses the whole batch and the first entry is not written", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-unsent-a");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      expect(() =>
        consume(f, {
          sentMediaIds: new Set([a.id]),
          sentSources: new Map([[a.id, refA]]),
          classifications: [
            { mediaId: a.id, category: "ordinary" },
            { mediaId: "mn-forged", category: "ordinary" },
          ],
        }),
      ).toThrow();
      expect(f.classificationCount()).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("a cross-scope media id that exists in another scope is refused with zero writes", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-cross-a");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      const otherPeer = "30099";
      const occurred = Math.floor(Date.now() / 1000);
      f.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: "ev-cross-other",
          accountId: ACCOUNT,
          conversationKind: "group",
          peerId: otherPeer,
          agentId: AGENT,
          messageId: "message-ev-cross-other",
          occurredAtSeconds: occurred,
          speakerKind: "member",
          speakerId: "20002",
          recordedAt: nowIso(),
        })
        .run();
      const other = recordMediaSegment(f.orm, {
        eventKey: "ev-cross-other",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "ref-cross-other",
        occurredAtSeconds: occurred,
        addressed: true,
      });
      expect(() =>
        consume(f, {
          sentMediaIds: new Set([a.id, other.id]),
          sentSources: new Map([
            [a.id, refA],
            [
              other.id,
              { kind: "qq_media_source", id: other.id, revision: "1", expiresAt: nowIso() },
            ],
          ]),
          classifications: [{ mediaId: other.id, category: "ordinary" }],
        }),
      ).toThrow();
      expect(f.classificationCount()).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("a wrong owner never consumes: zero writes", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-owner-a");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      expect(() =>
        consume(f, {
          owner: {
            kind: "conversation",
            id: f.conversationId,
            userId: DEFAULT_USER_ID,
            agentId: "other-agent",
          },
          sentMediaIds: new Set([a.id]),
          sentSources: new Map([[a.id, refA]]),
          classifications: [{ mediaId: a.id, category: "ordinary" }],
        }),
      ).toThrow();
      expect(f.classificationCount()).toBe(0);
      expect(() =>
        consume(f, {
          owner: {
            kind: "conversation",
            id: "some-other-conversation",
            userId: DEFAULT_USER_ID,
            agentId: AGENT,
          },
          sentMediaIds: new Set([a.id]),
          sentSources: new Map([[a.id, refA]]),
          classifications: [{ mediaId: a.id, category: "ordinary" }],
        }),
      ).toThrow();
      expect(f.classificationCount()).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("binding epoch / authority revision drift after mint fails closed with zero writes", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-drift-a");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      f.orm
        .update(schema.qqBindings)
        .set({ authorityRevision: 2, revision: 2 })
        .where(eq(schema.qqBindings.id, BINDING_ID))
        .run();
      expect(() =>
        consume(f, {
          sentMediaIds: new Set([a.id]),
          sentSources: new Map([[a.id, refA]]),
          classifications: [{ mediaId: a.id, category: "ordinary" }],
        }),
      ).toThrow();
      expect(f.classificationCount()).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("a mutated frozen ref (revision or cap) is refused with zero writes", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-mut-a");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      expect(() =>
        consume(f, {
          sentMediaIds: new Set([a.id]),
          sentSources: new Map([[a.id, { ...refA, revision: "tampered" }]]),
          classifications: [{ mediaId: a.id, category: "ordinary" }],
        }),
      ).toThrow();
      expect(f.classificationCount()).toBe(0);
      expect(() =>
        consume(f, {
          sentMediaIds: new Set([a.id]),
          sentSources: new Map([[a.id, { ...refA, expiresAt: "1999-01-01T00:00:00.000Z" }]]),
          classifications: [{ mediaId: a.id, category: "ordinary" }],
        }),
      ).toThrow();
      expect(f.classificationCount()).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("an expired consumption window refuses with zero writes", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-exp-a");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      const late = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      expect(() =>
        consume(f, {
          at: late,
          sentMediaIds: new Set([a.id]),
          sentSources: new Map([[a.id, refA]]),
          classifications: [{ mediaId: a.id, category: "ordinary" }],
        }),
      ).toThrow();
      expect(f.classificationCount()).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("a ref expired hours before the real now is refused on the default clock (no at), under pinned UTC and non-UTC timezones", () => {
    const f = openFixture();
    // F1 regression: the old default timestamp had no trailing Z, so Date.parse
    // read it in the local timezone and widened every expiry gate by the zone
    // offset (up to 8h here). Pin the zone explicitly per run so the RED state
    // is timezone-independent and the fix is proven against both.
    const originalTz = process.env.TZ;
    const noZ = "2026-10-03T04:00:00.000";
    try {
      const a = f.mediaWithJournal("ev-tz-a");
      const b = f.mediaWithJournal("ev-tz-b");
      // Mint while the windows are still live with an explicit prior `at`
      // (mintAt), then expire media/link/asset caps to now-4h / now-0.5h —
      // already dead at the real now, still "live" for a locally-parsed clock.
      const mintAt = new Date(Date.now() - 9 * 3600 * 1000).toISOString();
      const capA = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
      const capB = new Date(Date.now() - 0.5 * 3600 * 1000).toISOString();
      const refA = f.mintWithPastCap(a.id, capA, mintAt);
      const refB = f.mintWithPastCap(b.id, capB, mintAt);
      expect(refA).not.toBeNull();
      expect(refB).not.toBeNull();
      if (!refA || !refB) return;
      const consumeAll = () =>
        consume(f, {
          sentMediaIds: new Set([a.id, b.id]),
          sentSources: new Map([
            [a.id, refA],
            [b.id, refB],
          ]),
          classifications: [
            { mediaId: a.id, category: "ordinary" },
            { mediaId: b.id, category: "expression" },
          ],
        });
      for (const tz of ["UTC", "Asia/Shanghai"] as const) {
        process.env.TZ = tz;
        // The drift probe must confirm the zone actually changed between the
        // two runs; otherwise the pair proves nothing about the timezone path.
        const currentDrift = (Date.parse(noZ) - Date.parse(`${noZ}Z`)) / 3600000;
        expect(currentDrift).toBe(tz === "UTC" ? 0 : -8);
        let threw: unknown;
        try {
          consumeAll();
        } catch (e) {
          threw = e;
        }
        // Not just "threw something": the expiry gate itself (`CONTEXT_SOURCE_INVALID`
        // from the frozen-ref re-verify at the default clock) must be the refuser. The
        // old no-Z default timestamp parsed the clock 8h early, so the gate let the
        // expired refs through and the rows were written — this exact error is what
        // the fix restores; a different refusal (e.g. the later SQL revision compare)
        // would mean the gate is still blind and the fix is wrong.
        expect(threw instanceof AppError && threw.code === "CONTEXT_SOURCE_INVALID").toBe(true);
        expect(f.classificationCount()).toBe(0);
        console.log(
          `TZ=${tz}: drift ${currentDrift}h — expiry gate (CONTEXT_SOURCE_INVALID) refused expired refs, 0 writes`,
        );
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
      f.h.close();
    }
  });

  it("an existing platform classification is not overwritten by the model label", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-plat-a");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      const assetId = f.assetIdOf(a.id);
      recordMediaClassification(f.orm, {
        assetId,
        category: "ordinary",
        evidence: "platform",
        policy: POLICY,
      });
      consume(f, {
        sentMediaIds: new Set([a.id]),
        sentSources: new Map([[a.id, refA]]),
        classifications: [{ mediaId: a.id, category: "expression" }],
      });
      const row = mediaClassificationFor(f.orm, { assetId, policy: POLICY, modelName: MODEL });
      expect(row?.evidence).toBe("platform");
      expect(row?.category).toBe("ordinary");
      expect(row?.modelName).toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("a guard abort inside the transaction rolls back to zero writes", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-guard-a");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      expect(() =>
        consume(f, {
          sentMediaIds: new Set([a.id]),
          sentSources: new Map([[a.id, refA]]),
          classifications: [{ mediaId: a.id, category: "ordinary" }],
          assertCurrent: () => {
            throw new Error("host guard: current changed");
          },
        }),
      ).toThrow("host guard: current changed");
      expect(f.classificationCount()).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("an abort signal before consumption rejects with the original abort reason and zero writes", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-sig-a");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      const controller = new AbortController();
      controller.abort();
      let caught: unknown;
      try {
        consume(f, {
          signal: controller.signal,
          sentMediaIds: new Set([a.id]),
          sentSources: new Map([[a.id, refA]]),
          classifications: [{ mediaId: a.id, category: "ordinary" }],
        });
      } catch (e) {
        caught = e;
      }
      // Strong reject: the caller must receive the signal's own reason object,
      // not a copy, wrapper or normalized stand-in.
      expect(caught).toBe(controller.signal.reason);
      expect(caught instanceof Error).toBe(true);
      expect((caught as Error).name).toBe("AbortError");
      expect(f.classificationCount()).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("a pre-abort with a custom reason rejects with that exact reason, even a non-Error object", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-sig-b");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      const controller = new AbortController();
      const hostReason = { code: "HOST_ABORT" };
      controller.abort(hostReason);
      let caught: unknown;
      try {
        consume(f, {
          signal: controller.signal,
          sentMediaIds: new Set([a.id]),
          sentSources: new Map([[a.id, refA]]),
          classifications: [{ mediaId: a.id, category: "ordinary" }],
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBe(hostReason);
      expect(f.classificationCount()).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("a guard that aborts the signal inside the transaction rejects with the abort reason and rolls back to zero writes", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-guard-sig-a");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      const controller = new AbortController();
      const guardAbortReason = new DOMException(
        "host guard cancelled mid-transaction",
        "AbortError",
      );
      let caught: unknown;
      try {
        consume(f, {
          signal: controller.signal,
          sentMediaIds: new Set([a.id]),
          sentSources: new Map([[a.id, refA]]),
          classifications: [{ mediaId: a.id, category: "ordinary" }],
          // Guard runs as the first statement inside the transaction and only
          // aborts the signal — no throw, so the rollback must come from the
          // signal rejection itself, not from the guard's own error.
          assertCurrent: () => {
            controller.abort(guardAbortReason);
          },
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBe(guardAbortReason);
      expect(f.classificationCount()).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("a mid-transaction guard abort with a non-Error reason still rolls back an in-transaction write to zero rows", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-guard-sig-b");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      const controller = new AbortController();
      const hostReason = { code: "HOST_ABORT_NON_ERROR" };
      let caught: unknown;
      try {
        consume(f, {
          signal: controller.signal,
          sentMediaIds: new Set([a.id]),
          sentSources: new Map([[a.id, refA]]),
          classifications: [{ mediaId: a.id, category: "ordinary" }],
          // The guard writes a real row through the transaction handle first,
          // then only aborts the signal (no throw). If the abort rejection
          // unwinds the transaction, that guard write must be rolled back —
          // proof the rejection is a genuine rollback, not a silent return.
          assertCurrent: (tx) => {
            tx.insert(schema.qqProcessedEvents)
              .values({ eventKey: "ev-guard-sig-b", processedAt: nowIso() })
              .run();
            controller.abort(hostReason);
          },
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBe(hostReason);
      expect(f.classificationCount()).toBe(0);
      const guardRow = f.orm
        .select({ eventKey: schema.qqProcessedEvents.eventKey })
        .from(schema.qqProcessedEvents)
        .where(eq(schema.qqProcessedEvents.eventKey, "ev-guard-sig-b"))
        .get();
      expect(guardRow ?? null).toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("a guard abort plus the host's own domain error lets the abort reason win, with zero writes", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-guard-prio-a");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      const controller = new AbortController();
      const hostReason = { code: "HOST_ABORT_PRIORITY" };
      let caught: unknown;
      try {
        consume(f, {
          signal: controller.signal,
          sentMediaIds: new Set([a.id]),
          sentSources: new Map([[a.id, refA]]),
          classifications: [{ mediaId: a.id, category: "ordinary" }],
          assertCurrent: () => {
            controller.abort(hostReason);
            throw new Error("host guard: current changed");
          },
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBe(hostReason);
      expect(f.classificationCount()).toBe(0);
    } finally {
      f.h.close();
    }
  });

  it("input boundary stays strict: empty model/policy, illegal category, duplicate ids refused", () => {
    const f = openFixture();
    try {
      const a = f.mediaWithJournal("ev-strict-a");
      const refA = f.mint(a.id);
      expect(refA).not.toBeNull();
      if (!refA) return;
      const base = {
        sentMediaIds: new Set([a.id]),
        sentSources: new Map([[a.id, refA]]),
        classifications: [{ mediaId: a.id, category: "ordinary" as const }],
      };
      expect(() => consume(f, { ...base, actualModel: "  " })).toThrow();
      expect(() => consume(f, { ...base, policyRevision: "" })).toThrow();
      expect(() =>
        consume(f, {
          ...base,
          classifications: [{ mediaId: a.id, category: "sticker" as "ordinary" }],
        }),
      ).toThrow();
      expect(() =>
        consume(f, {
          ...base,
          classifications: [
            { mediaId: a.id, category: "ordinary" },
            { mediaId: a.id, category: "expression" },
          ],
        }),
      ).toThrow();
      expect(f.classificationCount()).toBe(0);
    } finally {
      f.h.close();
    }
  });
});
