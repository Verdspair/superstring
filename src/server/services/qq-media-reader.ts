// P4: a single, explicitly requested media read. The adapter is injected: this module
// neither opens a network connection nor treats a text-only conversation model as vision.
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { SourceRef } from "../../shared/contracts/evidence";
import { readBindingByConversation } from "../db/qq-binding-repository";
import { mediaNoteRow, recordMediaAttempt, recordMediaNote } from "../db/qq-media-repository";
import { readQqSettings } from "../db/qq-settings-repository";
import { DEFAULT_USER_ID, getAgentRow, type Orm } from "../db/repositories";
import { qqEvents } from "../db/schema";
import { checkQqMediaRetry, qqMediaFailureOutcome, qqMediaModelFor } from "./qq-media-contract";

// Prevent two reads of the same segment in one process from overlapping. The database
// CAS below remains necessary for other processes; this is not a persistent lease.
const activeReads = new WeakMap<Orm, Set<string>>();

const Input = z.strictObject({
  eventKey: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  addressedToAssistant: z.boolean(),
  relatedSupplementArrived: z.boolean(),
  modelConfig: z.strictObject({
    visionModelName: z.string().nullable(),
    transcriptionModelName: z.string().nullable(),
  }),
});

export interface QqMediaReadAdapter {
  read(input: {
    kind: "image" | "record" | "video";
    sourceRef: string;
    model: string;
    source?: SourceRef;
    owner?: { kind: string; id: string; userId?: string; agentId?: string };
    signal?: AbortSignal;
  }): Promise<string>;
}

export type QqMediaReadResult =
  | { readonly kind: "described"; readonly attempt: number }
  | { readonly kind: "unreadable"; readonly reason: string }
  | {
      readonly kind: "failed";
      readonly attempt: number;
      readonly announceInConversation: false;
      readonly awaitSupplement: boolean;
    };

/** One attempt; never replays a read or announces a failure to the conversation. */
export async function readQqMediaOnce(
  orm: Orm,
  adapter: QqMediaReadAdapter,
  input: unknown,
  signal?: AbortSignal,
): Promise<QqMediaReadResult> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ media read input");
  const value = parsed.data;
  const row = mediaNoteRow(orm, value.eventKey, value.segmentIndex);
  if (!row) return { kind: "unreadable", reason: "segment_missing" };
  const activeKey = JSON.stringify([value.eventKey, value.segmentIndex]);
  const active = activeReads.get(orm) ?? new Set<string>();
  if (active.has(activeKey)) return { kind: "unreadable", reason: "read_in_progress" };
  const event = orm.select().from(qqEvents).where(eq(qqEvents.eventKey, value.eventKey)).get();
  if (!event) return { kind: "unreadable", reason: "event_missing" };
  const bindingIdentity = {
    accountId: event.accountId,
    kind: event.conversationKind as "group" | "private",
    peerId: event.peerId,
  };
  const startSettings = readQqSettings(orm);
  const startBinding = readBindingByConversation(orm, bindingIdentity);
  if (
    startSettings.enabled !== 1 ||
    startSettings.accountId !== event.accountId ||
    !startBinding ||
    startBinding.paused ||
    startBinding.agentId !== event.agentId ||
    getAgentRow(orm, event.agentId)?.isActive !== 1
  )
    return { kind: "unreadable", reason: "binding_inactive" };
  const authorized = (db: Orm = orm) => {
    const settings = readQqSettings(db);
    const binding = readBindingByConversation(db, bindingIdentity);
    return (
      settings.enabled === 1 &&
      settings.accountId === event.accountId &&
      settings.revision === startSettings.revision &&
      binding !== null &&
      !binding.paused &&
      binding.agentId === event.agentId &&
      binding.revision === startBinding.revision &&
      getAgentRow(db, event.agentId)?.isActive === 1
    );
  };
  if (row.note !== null) return { kind: "unreadable", reason: "already_described" };
  if (row.expiresAt <= new Date().toISOString())
    return { kind: "unreadable", reason: "segment_expired" };
  if (row.segmentKind !== "image" && row.segmentKind !== "record" && row.segmentKind !== "video")
    return { kind: "unreadable", reason: "unsupported_kind" };
  const kind = row.segmentKind;
  const choice = qqMediaModelFor(kind, value.modelConfig);
  if (choice.kind !== "configured") return { kind: "unreadable", reason: "model_not_configured" };
  const retry = checkQqMediaRetry({
    kind: row.segmentKind,
    attempts: row.attempts,
    addressedToAssistant: value.addressedToAssistant,
    relatedSupplementArrived: value.relatedSupplementArrived,
  });
  if (retry.kind !== "allowed") return { kind: "unreadable", reason: retry.reason };
  // The SQL update claims a unique attempt number even when two consumers race.
  let claimed: typeof row;
  try {
    claimed = recordMediaAttempt(orm, {
      eventKey: value.eventKey,
      segmentIndex: value.segmentIndex,
      expectedAttempts: row.attempts,
      validateBeforeClaim: authorized,
    });
  } catch {
    // A competing first read or authorization change is not proof that both attempts
    // were spent. Preserve the previously visible exhausted result only if it is true.
    const current = mediaNoteRow(orm, value.eventKey, value.segmentIndex);
    return {
      kind: "unreadable",
      reason: current && current.attempts >= 2 ? "attempts_exhausted" : "claim_changed",
    };
  }
  active.add(activeKey);
  activeReads.set(orm, active);
  try {
    const generated = await adapter.read({
      kind,
      sourceRef: row.sourceRef,
      model: choice.model,
      signal,
      owner: { kind: "qq_media", id: row.id, userId: DEFAULT_USER_ID, agentId: event.agentId },
      source: {
        kind: "qq_media",
        id: row.id,
        revision: String(claimed.attempts),
        expiresAt: row.expiresAt,
      },
    });
    if (typeof generated !== "string") throw new Error("invalid media description");
    const note = generated.trim();
    if (!note) throw new Error("empty media description");
    // A sweep or reset during the external read cannot resurrect an expired segment.
    const current = mediaNoteRow(orm, value.eventKey, value.segmentIndex);
    if (
      !current ||
      current.id !== row.id ||
      current.attempts !== claimed.attempts ||
      current.note !== null ||
      current.expiresAt <= new Date().toISOString() ||
      !authorized()
    ) {
      return { kind: "unreadable", reason: "segment_changed" };
    }
    try {
      recordMediaNote(orm, {
        eventKey: value.eventKey,
        segmentIndex: value.segmentIndex,
        note,
        noteModel: choice.model,
        expectedAttempts: claimed.attempts,
        validateBeforeWrite: authorized,
      });
    } catch {
      return { kind: "unreadable", reason: "segment_changed" };
    }
    return { kind: "described", attempt: claimed.attempts };
  } catch {
    // A transport/model failure after pause, account switch, or source expiry is not
    // permission to keep a waiting task alive for a later supplement.
    const current = mediaNoteRow(orm, value.eventKey, value.segmentIndex);
    if (
      !current ||
      current.id !== row.id ||
      current.attempts !== claimed.attempts ||
      current.note !== null ||
      current.expiresAt <= new Date().toISOString() ||
      !authorized()
    ) {
      return { kind: "unreadable", reason: "segment_changed" };
    }
    const failure = qqMediaFailureOutcome({
      kind: row.segmentKind,
      attempts: claimed.attempts,
      addressedToAssistant: value.addressedToAssistant,
    });
    return {
      kind: "failed",
      attempt: claimed.attempts,
      announceInConversation: false,
      awaitSupplement: failure.awaitSupplement,
    };
  } finally {
    active.delete(activeKey);
  }
}
