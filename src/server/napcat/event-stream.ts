import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type OneBotMessageSourceReference,
  type OneBotMessageSourceReferenceInput,
  OneBotMessageSourceReferenceSchema,
  type OneBotProtocolEvent,
  OneBotProtocolEventSchema,
} from "../../shared/contracts/onebot-events";
import {
  QqManagedEventCursorSchema,
  type QqManagedEventKind,
  QqManagedEventKindSchema,
  type QqManagedEventsInvalidation,
  QqManagedEventsInvalidationSchema,
  type QqManagedEventsPage,
  QqManagedEventsPageSchema,
  type QqManagedEventView,
  QqManagedEventViewSchema,
} from "../../shared/contracts/qq-managed-events";

export const NAPCAT_EVENT_RING_MAX_ENTRIES = 256;
export const NAPCAT_EVENT_RING_MAX_BYTES = 65_536;
export const NAPCAT_EVENT_MAX_BYTES = 512;
export const NAPCAT_EVENT_LINKED_MAX_BYTES = 1_536;
export const NAPCAT_EVENT_TTL_MS = 900_000;
export const NAPCAT_EVENT_PAGE_DEFAULT = 50;
export const NAPCAT_EVENT_PAGE_MAX = 100;
export const NAPCAT_EVENT_PREVIEW_MAX_CODEPOINTS = 160;

export const NapCatMessageSourceReferenceSchema = OneBotMessageSourceReferenceSchema;
export type NapCatMessageSourceReference = OneBotMessageSourceReference;
export interface NapCatEventQuery {
  readonly kind?: QqManagedEventKind;
  /** JSON-encoded generation+sequence cursor; invalid or stale cursors never restart implicitly. */
  readonly cursor?: string;
  readonly limit?: number;
  /** Deterministic clock injection for tests; milliseconds since epoch. */
  readonly now?: number;
}

export type NapCatEventSnapshot = QqManagedEventsPage;
export interface NapCatEventStream {
  readonly generation: string;
  readonly latestSequence: number;
  readonly revision: number;
  readonly bytes: number;
  record(event: OneBotProtocolEvent, observedAtMs?: number): number | null;
  linkMessageSource(correlationKey: string, reference: OneBotMessageSourceReferenceInput): boolean;
  snapshot(
    query?: NapCatEventQuery,
    readMessage?: (reference: NapCatMessageSourceReference, now: number) => string | null,
  ): NapCatEventSnapshot;
  subscribe(listener: (notice: QqManagedEventsInvalidation) => void): () => void;
  clear(): void;
}

export interface NapCatEventStreamOptions {
  readonly now?: () => number;
  readonly createGeneration?: () => string;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxEntryBytes?: number;
  readonly ttlMs?: number;
}

interface Entry {
  readonly sequence: number;
  readonly insertedAt: number;
  readonly expiresAtMs: number;
  readonly event: OneBotProtocolEvent;
  readonly correlationKey: string | null;
  readonly bytes: number;
  sourceReference?: NapCatMessageSourceReference;
  readonly protocolBytes: number;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function cursorValue(
  cursor: string | undefined,
): z.infer<typeof QqManagedEventCursorSchema> | null | undefined {
  if (cursor === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    return null;
  }
  const result = QqManagedEventCursorSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function sameReference(a: NapCatMessageSourceReference, b: NapCatMessageSourceReference): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createNapCatEventStream(options: NapCatEventStreamOptions = {}): NapCatEventStream {
  const now = options.now ?? Date.now;
  const createGeneration = options.createGeneration ?? randomUUID;
  const maxEntries = options.maxEntries ?? NAPCAT_EVENT_RING_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? NAPCAT_EVENT_RING_MAX_BYTES;
  const maxEntryBytes = options.maxEntryBytes ?? NAPCAT_EVENT_MAX_BYTES;
  const ttlMs = options.ttlMs ?? NAPCAT_EVENT_TTL_MS;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxEntryBytes) ||
    maxEntryBytes < 1 ||
    maxEntryBytes > maxBytes ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1
  )
    throw new TypeError("Invalid OneBot event stream bounds");

  let generation = createGeneration();
  if (!z.string().uuid().safeParse(generation).success)
    throw new TypeError("Invalid OneBot event stream generation");
  let sequence = 0;
  let revision = 0;
  let totalBytes = 0;
  let truncated = false;
  const entries: Entry[] = [];
  const listeners = new Set<(notice: QqManagedEventsInvalidation) => void>();

  const notify = () => {
    const notice = QqManagedEventsInvalidationSchema.parse({
      generation,
      latest_sequence: sequence,
      revision,
    });
    for (const listener of [...listeners]) {
      try {
        listener(notice);
      } catch {
        /* Optional invalidation consumers cannot own the ring. */
      }
    }
  };

  const prune = (at: number) => {
    let changed = false;
    while (entries.length > 0 && entries[0]!.expiresAtMs <= at) {
      totalBytes -= entries.shift()!.bytes;
      truncated = true;
      changed = true;
    }
    if (changed) {
      revision++;
      notify();
    }
  };

  const removeOldest = () => {
    const removed = entries.shift();
    if (removed) {
      totalBytes -= removed.bytes;
      truncated = true;
      return true;
    }
    return false;
  };

  return {
    get generation() {
      return generation;
    },
    get latestSequence() {
      return sequence;
    },
    get revision() {
      return revision;
    },
    get bytes() {
      prune(now());
      return totalBytes;
    },

    record(event, observedAtMs = now()) {
      prune(observedAtMs);
      const parsed = OneBotProtocolEventSchema.safeParse(event);
      if (!parsed.success || !Number.isSafeInteger(observedAtMs) || observedAtMs < 0) return null;
      const safeEvent = Object.freeze(parsed.data);
      const correlationKey = safeEvent.kind === "message" ? safeEvent.event_key : null;
      const base = {
        sequence: sequence + 1,
        insertedAt: observedAtMs,
        expiresAtMs: observedAtMs + ttlMs,
        event: safeEvent,
        correlationKey,
      };
      const protocolBytes = byteLength(safeEvent);
      const size = byteLength({
        sequence: base.sequence,
        insertedAt: base.insertedAt,
        expiresAtMs: base.expiresAtMs,
        event: safeEvent,
      });
      if (protocolBytes > maxEntryBytes) return null;
      while (entries.length > 0 && (entries.length >= maxEntries || totalBytes + size > maxBytes))
        removeOldest();
      sequence++;
      const entry: Entry = { ...base, sequence, bytes: size, protocolBytes };
      entries.push(entry);
      totalBytes += size;
      revision++;
      notify();
      return sequence;
    },

    linkMessageSource(correlationKey, input) {
      const parsed = NapCatMessageSourceReferenceSchema.safeParse(input);
      if (!parsed.success || parsed.data.event_key !== correlationKey) return false;
      prune(now());
      const entry = entries.find((candidate) => candidate.correlationKey === correlationKey);
      if (!entry || entry.event.kind !== "message") return false;
      if (entry.sourceReference) return sameReference(entry.sourceReference, parsed.data);
      const reference = Object.freeze({
        event_key: parsed.data.event_key,
        scope: Object.freeze({ ...parsed.data.scope }),
        source: Object.freeze({ ...parsed.data.source }),
      });
      const nextBytes = byteLength({
        sequence: entry.sequence,
        insertedAt: entry.insertedAt,
        expiresAtMs: entry.expiresAtMs,
        event: entry.event,
        sourceReference: reference,
      });
      if (nextBytes > NAPCAT_EVENT_LINKED_MAX_BYTES || nextBytes > maxBytes) return false;
      while (entries.length > 1 && totalBytes - entry.bytes + nextBytes > maxBytes) removeOldest();
      const index = entries.indexOf(entry);
      if (index < 0) return false;
      const updated = { ...entry, sourceReference: reference, bytes: nextBytes };
      entries[index] = updated;
      totalBytes += nextBytes - entry.bytes;
      revision++;
      notify();
      return true;
    },

    snapshot(query: NapCatEventQuery = {}, readMessage) {
      const at = query.now ?? now();
      prune(at);
      const limit = query.limit ?? NAPCAT_EVENT_PAGE_DEFAULT;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > NAPCAT_EVENT_PAGE_MAX)
        throw new TypeError("Invalid OneBot event page limit");
      if (query.kind !== undefined && !QqManagedEventKindSchema.safeParse(query.kind).success)
        throw new TypeError("Invalid OneBot event kind");
      const cursor = cursorValue(query.cursor);
      if (cursor === null) throw new TypeError("Invalid OneBot event cursor");
      if (cursor && cursor.generation !== generation) {
        return QqManagedEventsPageSchema.parse({
          status: "reset_required",
          generation,
          latest_sequence: sequence,
          revision,
        });
      }
      const eligible = entries.filter(
        (entry) =>
          entry.expiresAtMs > at &&
          (query.kind === undefined || entry.event.kind === query.kind) &&
          (!cursor || entry.sequence < cursor.sequence),
      );
      const newest = eligible.slice(-limit).reverse();
      const hasMore = eligible.length > newest.length;
      const events = newest.map((entry): QqManagedEventView => {
        const event =
          entry.event.kind === "message"
            ? (({ event_key: _privateEventKey, ...publicEvent }) => publicEvent)(entry.event)
            : entry.event;
        const sourceReference = entry.sourceReference;
        let messagePreview: string | null = null;
        let previewState: QqManagedEventView["preview_state"] = "not_message";
        if (entry.event.kind === "message") {
          if (!sourceReference) {
            previewState = "unbound";
          } else if (
            sourceReference.source.expiresAt &&
            sourceReference.source.expiresAt <= iso(at)
          ) {
            previewState = "expired";
          } else if (readMessage) {
            try {
              const preview = readMessage(sourceReference, at);
              if (typeof preview === "string") {
                messagePreview = Array.from(preview)
                  .slice(0, NAPCAT_EVENT_PREVIEW_MAX_CODEPOINTS)
                  .join("");
                previewState = "available";
              } else {
                previewState = "unavailable";
              }
            } catch {
              previewState = "unavailable";
            }
          } else {
            previewState = "unavailable";
          }
        }
        return QqManagedEventViewSchema.parse({
          sequence: entry.sequence,
          expires_at: iso(entry.expiresAtMs),
          event,
          conversation_binding:
            entry.event.kind === "message" ? (sourceReference ? "bound" : "unbound") : "unknown",
          message_preview: messagePreview,
          preview_state: previewState,
        });
      });
      return QqManagedEventsPageSchema.parse({
        status: "ok",
        generation,
        latest_sequence: sequence,
        revision,
        events,
        next_cursor:
          hasMore && newest.length > 0
            ? JSON.stringify({ generation, sequence: newest.at(-1)!.sequence })
            : null,
        truncated,
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    clear() {
      entries.length = 0;
      totalBytes = 0;
      truncated = false;
      generation = createGeneration();
      if (!z.string().uuid().safeParse(generation).success)
        throw new TypeError("Invalid OneBot event stream generation");
      sequence = 0;
      revision++;
      notify();
    },
  };
}
