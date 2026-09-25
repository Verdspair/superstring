// Speaking eligibility and in-flight cancellation for QQ (ADR0018 P3a).
//
// A QQ conversation is not a chat window: nobody is waiting for an answer, so "should
// the assistant speak at all" has to be decided before generation and revisited before
// sending. This module is that decision as pure rules — no database, no model, no clock
// of its own, and no thresholds: the plan's windows, cooldowns and idle times are all
// still pending (U01), so everything here is expressed as "who spoke last", never as
// "how long ago".
//
// The four kinds are the independently controllable speech paths the plan names. Only
// two of them speak without being addressed, and only those two carry the confirmed
// rule "an initiative that got no reply is not followed by another one". A continuation
// is deliberately NOT initiative-taking (user decision 2026-09-23): a conversation the
// assistant is already part of keeps flowing as long as people talk, and any new message
// from a real partner releases the rule anyway, so treating a continuation as an
// initiative would buy nothing and risk silencing a live conversation.
//
// A direct reply is also exempt, and necessarily so: it answers being addressed. If it
// were subject to the no-reply rule, being mentioned while the assistant's own last
// initiative went unanswered would mean refusing to answer a direct question — the
// opposite of what the rule is for.

import { z } from "zod";
import { type QqSpeechTriggers, QqSpeechTriggersSchema } from "../../shared/contracts/qq";

const SpeechKindSchema = z.enum(["direct_reply", "follow_up", "chiming_in", "idle_topic"]);
export type QqSpeechKind = z.output<typeof SpeechKindSchema>;

/** Every kind the store accepts, in the order the plan lists them. */
export const QQ_SPEECH_KINDS: readonly QqSpeechKind[] = Object.freeze([
  "direct_reply",
  "follow_up",
  "chiming_in",
  "idle_topic",
]);

/**
 * The two paths that speak unprompted. Exported because storage, the settings surface
 * and the tests all need to agree on which kinds carry the no-reply rule.
 */
export const QQ_INITIATIVE_SPEECH_KINDS: readonly QqSpeechKind[] = Object.freeze([
  "chiming_in",
  "idle_topic",
]);

/** Whether this kind speaks without being addressed. */
export function isInitiativeSpeech(kind: unknown): boolean {
  return QQ_INITIATIVE_SPEECH_KINDS.includes(parse(SpeechKindSchema, kind));
}

const TriggerInputSchema = z.strictObject({
  kind: SpeechKindSchema,
  /** The global third-party switch. */
  featureEnabled: z.boolean(),
  /** This conversation's own pause. */
  conversationPaused: z.boolean(),
  /**
   * Speech paths whose trigger the user has switched off. Where this list is stored is
   * a decision the settings/UI stage owns; it is an input here on purpose, so this
   * module cannot invent a default of its own.
   */
  disabledKinds: z.array(SpeechKindSchema),
  /** When this assistant last took the initiative here, or null if it never did. */
  lastInitiativeSeconds: z.number().int().nonnegative().nullable(),
  /** The newest recorded message from a real conversation partner, or null if none. */
  newestMemberMessageSeconds: z.number().int().nonnegative().nullable(),
});
export type QqSpeechTriggerInput = Readonly<z.input<typeof TriggerInputSchema>>;

const SendInputSchema = z.strictObject({
  kind: SpeechKindSchema,
  featureEnabled: z.boolean(),
  conversationPaused: z.boolean(),
  disabledKinds: z.array(SpeechKindSchema),
});
export type QqSpeechSendInput = Readonly<z.input<typeof SendInputSchema>>;

export type QqSpeechBlockReason =
  | "feature_off"
  | "conversation_paused"
  | "trigger_off"
  | "awaiting_reply";
export type QqSpeechVerdict =
  | { readonly kind: "allowed" }
  | { readonly kind: "blocked"; readonly reason: QqSpeechBlockReason };

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ speech contract input");
  return result.data;
}

/** The gates that apply to both deciding to speak and actually sending. */
function configurationGate(input: {
  featureEnabled: boolean;
  conversationPaused: boolean;
  disabledKinds: readonly QqSpeechKind[];
  kind: QqSpeechKind;
}): QqSpeechBlockReason | null {
  if (!input.featureEnabled) return "feature_off";
  if (input.conversationPaused) return "conversation_paused";
  if (input.disabledKinds.includes(input.kind)) return "trigger_off";
  return null;
}

/**
 * May this kind of speech be started now?
 *
 * Checked BEFORE generation, which matters for the no-reply rule: by the time an
 * initiative has been generated, the silence it was born from is still there — that is
 * its premise, not a reason to cancel it. Re-checking the rule before sending would make
 * an idle-topic opener cancel itself, so the rule belongs here and only here.
 */
export function checkQqSpeechTrigger(input: unknown): QqSpeechVerdict {
  const value = parse(TriggerInputSchema, input);
  const blocked = configurationGate(value);
  if (blocked !== null) return Object.freeze({ kind: "blocked", reason: blocked });
  if (isInitiativeSpeech(value.kind) && value.lastInitiativeSeconds !== null) {
    // Only a partner's message released it and only if that message came after we
    // spoke. Message times have second precision, so a message in the same second is
    // not treated as a reply: assuming it was would let a two-second-old initiative be
    // followed by another one.
    const released =
      value.newestMemberMessageSeconds !== null &&
      value.newestMemberMessageSeconds > value.lastInitiativeSeconds;
    if (!released) return Object.freeze({ kind: "blocked", reason: "awaiting_reply" });
  }
  return Object.freeze({ kind: "allowed" });
}

/**
 * May content of this kind that is already generated still be sent?
 *
 * This is the in-flight half: switching a trigger off, pausing the conversation or
 * turning the feature off stops that content from going out, and it does so without
 * consulting any generation-time snapshot — the plan is explicit that a closed trigger
 * outranks an older snapshot.
 *
 * The no-reply rule is deliberately absent here; see `checkQqSpeechTrigger` for why it
 * cannot be re-applied at send time.
 */
export function checkQqSpeechSend(input: unknown): QqSpeechVerdict {
  const value = parse(SendInputSchema, input);
  const blocked = configurationGate(value);
  if (blocked !== null) return Object.freeze({ kind: "blocked", reason: blocked });
  return Object.freeze({ kind: "allowed" });
}

/** Validate a stored or assembled speech kind; storage maps rows through this. */
export function parseQqSpeechKind(input: unknown): QqSpeechKind {
  return parse(SpeechKindSchema, input);
}

/**
 * Every switch off. This is what a new scheme starts as, matching the project's existing
 * stance that a freshly bound conversation does not spend model calls until the user asks:
 * binding a scheme must not make an assistant start talking on its own.
 */
export const QQ_SPEECH_TRIGGERS_DEFAULT: QqSpeechTriggers = Object.freeze({
  direct_reply: false,
  follow_up: false,
  chiming_in: false,
  idle_topic: false,
});

/** The kinds a set of switches leaves off, in the order the plan lists them. */
export function disabledKindsFromTriggers(triggers: unknown): QqSpeechKind[] {
  const value = parse(QqSpeechTriggersSchema, triggers);
  // The switches are named exactly like the kinds, which is why this is a lookup rather
  // than a mapping table that could drift out of step with the contract.
  return QQ_SPEECH_KINDS.filter((kind) => !value[kind]);
}

export function parseQqSpeechTriggers(input: unknown): QqSpeechTriggers {
  return Object.freeze(parse(QqSpeechTriggersSchema, input));
}
