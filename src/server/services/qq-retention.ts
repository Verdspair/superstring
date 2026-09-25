// QQ conversation retention policy (ADR0018 / U03, decided 2026-09-22).
//
// The user's decision: QQ group and private message text is kept for two weeks by
// default, and the received media cache is cleaned on a time basis too, following
// the message it belongs to.
//
// Two lifecycles must never be conflated, and this module is the single place that
// says so:
//   * the DEDUP IDENTITY of a message (`qq_events.event_key`) is permanent, so a
//     re-delivered event is recognised and a memory keeps its provenance; and
//   * the message TEXT expires, after which the message is simply no longer
//     re-readable. An expired body does not invalidate a memory: only losing a
//     source's identity or a turn does that.
//
// Media follows the same window. When media storage is added it must derive its
// expiry from here rather than inventing a second retention rule — a media file
// outliving its message would keep an expired message effectively readable.

/** Default retention for QQ message text, in days (user decision). */
export const QQ_OBSERVATION_RETENTION_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Same fixed-width shape as `nowIso()` in db/repositories.ts. */
function fixedWidthIso(ms: number): string {
  const d = new Date(ms);
  return `${d.toISOString().slice(0, 19)}.${String(d.getMilliseconds()).padStart(3, "0")}000Z`;
}

/**
 * When a message's text (and therefore its media cache) becomes eligible for
 * cleanup, derived from when the message was sent rather than when it was stored:
 * a conversation that is only observed later must not extend the window.
 */
export function observationExpiresAt(
  occurredAtSeconds: number,
  retentionDays: number = QQ_OBSERVATION_RETENTION_DAYS,
): string {
  return fixedWidthIso(occurredAtSeconds * 1000 + retentionDays * MS_PER_DAY);
}

/** True once the window has passed. Comparison is on the fixed-width strings. */
export function isObservationExpired(expiresAt: string, now: string): boolean {
  return expiresAt <= now;
}

/** The same window applies to a message's cached media. */
export function mediaCacheExpiresAt(
  occurredAtSeconds: number,
  retentionDays: number = QQ_OBSERVATION_RETENTION_DAYS,
): string {
  return observationExpiresAt(occurredAtSeconds, retentionDays);
}

/**
 * The assistant's own speech records follow the same window as message text. This is
 * not a second retention rule — it is the same clock, under the name its own caller
 * reads it by, so that "how long do we keep this" is still answered in one place.
 */
export function speechExpiresAt(
  occurredAtSeconds: number,
  retentionDays: number = QQ_OBSERVATION_RETENTION_DAYS,
): string {
  return observationExpiresAt(occurredAtSeconds, retentionDays);
}

/**
 * A member's display name follows the same window, measured from the last time the
 * conversation showed us that person rather than from the first.
 *
 * A name is kept only as long as the messages that could refer to it, so this is again the
 * same clock under its own name. Anchoring it at first sight instead would delete the name of
 * somebody who talks every day, which is the opposite of what a "latest seen" record is for.
 * Deleting an expired name costs nothing: the timeline falls back to the QQ number, which is
 * the identity anyway.
 */
export function memberExpiresAt(
  seenAtSeconds: number,
  retentionDays: number = QQ_OBSERVATION_RETENTION_DAYS,
): string {
  return observationExpiresAt(seenAtSeconds, retentionDays);
}
