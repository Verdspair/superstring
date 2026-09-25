// QQ storage usage and the one cleanup entry (ADR0018 §11.1/§10, P5h).
//
// §11.1's 存储与诊断 answers "what does the QQ side keep, and what can I do about it". The user's
// decision (2026-09-24) is that it reports only data that EXISTS: media notes hold references and
// descriptions rather than bytes, so there is no cache size to invent, and failure records are not
// stored yet — the page says so instead of showing a zero that reads as "no failures".
//
// Cleanup runs the same windows the rest of the side already uses: `qq-retention.ts` is the single
// definition of "how long do we keep this", and every purge below deletes rows whose expiry has
// passed and nothing else. Sticker copies and collections are counted here but deliberately NOT
// cleaned: §10 keeps material governance independent, and U11 forbids deleting them.

import { and, count, eq, gt, isNull, lte, sum } from "drizzle-orm";
import { QQ_OBSERVATION_RETENTION_DAYS } from "../services/qq-retention";
import {
  type QqSweepVerdictRow,
  qqDispatchLeaseIsHeld,
  readQqDispatchLease,
  readQqSweepVerdicts,
} from "./qq-dispatch-repository";
import { purgeExpiredMediaNotes } from "./qq-media-repository";
import { purgeExpiredQqMembers } from "./qq-member-repository";
import { purgeExpiredObservationText } from "./qq-observation-repository";
import { purgeExpiredQqSends } from "./qq-send-repository";
import { purgeExpiredQqSpeech } from "./qq-speech-repository";
import { nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

export interface QqStorageUsage {
  readonly observations: {
    readonly messages: number;
    readonly text: number;
    readonly expiredText: number;
  };
  readonly speech: { readonly records: number; readonly text: number };
  readonly sends: { readonly attempts: number; readonly parts: number };
  readonly nicknames: { readonly current: number; readonly expired: number };
  readonly stickers: {
    readonly collections: number;
    readonly assets: number;
    readonly enabled: number;
    readonly bytes: number;
  };
  /**
   * What the durable state machine is waiting for (P5m): queued conversations and whether the one
   * global model-chain slot is taken. Counts of rows, read-only — the token that owns the lease is
   * deliberately not part of this view.
   */
  readonly dispatch: {
    readonly candidates: number;
    readonly ready_now: number;
    readonly lease_held: boolean;
  };
  /** Received media positions: how many there are, how many were understood, how many are waiting. */
  readonly media: {
    readonly segments: number;
    readonly described: number;
    readonly pending: number;
  };
  /**
   * The last quiet-room verdict per conversation (0030, §11.1's 原因可追踪). Not a count of stored
   * data but the reason record itself: why each bound conversation did or did not get an opener on
   * the last pass. `tracked` counts every recorded conversation; `entries` carries the newest
   * `QQ_SWEEP_VERDICT_LIMIT` of them, so a page can never be asked to render an unbounded list.
   */
  readonly sweep: {
    readonly tracked: number;
    readonly lastSweptAtSeconds: number | null;
    readonly entries: readonly QqSweepVerdictRow[];
  };
  readonly retentionDays: number;
}

/** What the QQ side currently holds. Reads only; the numbers are the tables' own rows. */
export function qqStorageUsage(orm: Orm, now: string = nowIso()): QqStorageUsage {
  const rows = (row: { n: number | string } | undefined) => Number(row?.n ?? 0);
  const messages = rows(orm.select({ n: count() }).from(schema.qqEvents).get());
  const text = rows(orm.select({ n: count() }).from(schema.qqObservationText).get());
  const expiredText = rows(
    orm
      .select({ n: count() })
      .from(schema.qqObservationText)
      .where(lte(schema.qqObservationText.expiresAt, now))
      .get(),
  );
  const speechRecords = rows(orm.select({ n: count() }).from(schema.qqSpeechLog).get());
  const speechText = rows(orm.select({ n: count() }).from(schema.qqSpeechText).get());
  const attempts = rows(orm.select({ n: count() }).from(schema.qqSendLog).get());
  const parts = rows(orm.select({ n: count() }).from(schema.qqSendPart).get());
  const nicknames = rows(
    orm
      .select({ n: count() })
      .from(schema.qqMembers)
      .where(gt(schema.qqMembers.expiresAt, now))
      .get(),
  );
  const expiredNicknames = rows(
    orm
      .select({ n: count() })
      .from(schema.qqMembers)
      .where(lte(schema.qqMembers.expiresAt, now))
      .get(),
  );
  const collections = rows(orm.select({ n: count() }).from(schema.qqStickerCollections).get());
  const assets = rows(orm.select({ n: count() }).from(schema.qqStickerAssets).get());
  const enabled = rows(
    orm
      .select({ n: count() })
      .from(schema.qqStickerAssets)
      .where(eq(schema.qqStickerAssets.enabled, 1))
      .get(),
  );
  const nowSeconds = Math.floor(Date.parse(now) / 1000);
  const candidates = rows(orm.select({ n: count() }).from(schema.qqDispatchCandidates).get());
  const readyNow = rows(
    orm
      .select({ n: count() })
      .from(schema.qqDispatchCandidates)
      .where(lte(schema.qqDispatchCandidates.readyAtSeconds, nowSeconds))
      .get(),
  );
  const leaseHeld = qqDispatchLeaseIsHeld(readQqDispatchLease(orm), nowSeconds);
  const mediaSegments = rows(orm.select({ n: count() }).from(schema.qqMediaNotes).get());
  const mediaDescribed = rows(
    orm
      .select({ n: count() })
      .from(schema.qqMediaNotes)
      .where(gt(schema.qqMediaNotes.note, ""))
      .get(),
  );
  // "Waiting" means an attempt was spent and no description came back, on a segment that has not
  // expired: an expired one can never be read again, so counting it as pending would be a promise
  // the retention window already withdrew.
  const mediaPending = rows(
    orm
      .select({ n: count() })
      .from(schema.qqMediaNotes)
      .where(
        and(
          isNull(schema.qqMediaNotes.note),
          gt(schema.qqMediaNotes.attempts, 0),
          gt(schema.qqMediaNotes.expiresAt, now),
        ),
      )
      .get(),
  );
  const byteRow = orm
    .select({ total: sum(schema.qqStickerAssets.byteSize) })
    .from(schema.qqStickerAssets)
    .get();
  const sweepTracked = rows(orm.select({ n: count() }).from(schema.qqSweepVerdicts).get());
  const sweepEntries = readQqSweepVerdicts(orm);
  return Object.freeze({
    observations: Object.freeze({ messages, text, expiredText }),
    speech: Object.freeze({ records: speechRecords, text: speechText }),
    sends: Object.freeze({ attempts, parts }),
    nicknames: Object.freeze({ current: nicknames, expired: expiredNicknames }),
    stickers: Object.freeze({
      collections,
      assets,
      enabled,
      bytes: Number(byteRow?.total ?? 0),
    }),
    dispatch: Object.freeze({ candidates, ready_now: readyNow, lease_held: leaseHeld }),
    media: Object.freeze({
      segments: mediaSegments,
      described: mediaDescribed,
      pending: mediaPending,
    }),
    sweep: Object.freeze({
      tracked: sweepTracked,
      // The entries are newest-first, so the first one dates the last pass. `null` when nothing has
      // been recorded at all, which the page must be able to tell apart from "swept just now".
      lastSweptAtSeconds: sweepEntries[0]?.decidedAtSeconds ?? null,
      entries: Object.freeze(sweepEntries),
    }),
    retentionDays: QQ_OBSERVATION_RETENTION_DAYS,
  });
}

export interface QqStorageCleanup {
  readonly observationText: number;
  readonly mediaNotes: number;
  readonly speech: number;
  readonly sends: number;
  readonly nicknames: number;
}

/**
 * Remove what has expired, on the windows the rest of the side already follows.
 *
 * Nothing live is touched, and nothing here decides a retention rule: each purge reads its own
 * expiry column, which was written from `qq-retention.ts` when the row was created.
 */
export function qqStorageCleanup(orm: Orm, now: string = nowIso()): QqStorageCleanup {
  return Object.freeze({
    observationText: purgeExpiredObservationText(orm, now),
    mediaNotes: purgeExpiredMediaNotes(orm, now),
    speech: purgeExpiredQqSpeech(orm, now),
    sends: purgeExpiredQqSends(orm, now),
    nicknames: purgeExpiredQqMembers(orm, now),
  });
}
