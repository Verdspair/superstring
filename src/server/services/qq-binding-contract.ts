import { z } from "zod";
import { UuidSchema } from "../../shared/contracts/common";
import { QQ_ATTENTION_MEMBER_LIMIT } from "../../shared/contracts/qq";
import { normalizeOneBotAccountId, type QqObservation } from "./onebot-protocol";

// Server-owned binding state. These are not public HTTP contracts or access tokens.
const AccountId = z.union([z.string(), z.number()]).transform((input, ctx) => {
  const value = normalizeOneBotAccountId(input);
  if (value !== null) return value;
  ctx.addIssue({ code: "custom", message: "Invalid account identity" });
  return z.NEVER;
});
const Revision = z.number().int().positive();
const identityFields = {
  accountId: AccountId,
  kind: z.enum(["group", "private"]),
  peerId: AccountId,
};
const IdentitySchema = z.strictObject(identityFields);
const OwnerSchema = z.strictObject({
  accountId: AccountId,
  peerId: AccountId.nullable(),
  revision: Revision,
});
/**
 * The four module switches a conversation may set for itself (§0.6/F05).
 *
 * `null` is not "off": it means this conversation follows its scheme, which is what a binding does
 * until the user touches one switch. A whole group of `null`s is the fresh-binding state.
 */
const BindingTriggers = z.strictObject({
  direct_reply: z.boolean().nullable(),
  follow_up: z.boolean().nullable(),
  chiming_in: z.boolean().nullable(),
  idle_topic: z.boolean().nullable(),
});

/** Field-by-field, like the scheme's rhythm comparison: a false "changed" would bump revisions. */
function sameTriggers(left: QqBinding["triggers"], right: QqBinding["triggers"]): boolean {
  return (
    left.direct_reply === right.direct_reply &&
    left.follow_up === right.follow_up &&
    left.chiming_in === right.chiming_in &&
    left.idle_topic === right.idle_topic
  );
}

/**
 * 「重要的人」(0031): a conversation's attention list and how strictly it applies.
 *
 * `off` means no list; `soft` only marks the listed speakers in the judgement/reply context;
 * `hard` lets only them trigger anything. The members are normalized (deduplicated and sorted)
 * here, so re-saving the same people in another order is not a change and does not bump a
 * revision.
 */
const AttentionMembers = z
  .array(AccountId)
  .max(QQ_ATTENTION_MEMBER_LIMIT)
  .transform((members) => [...new Set(members)].sort());
const BindingAttention = z
  .strictObject({
    mode: z.enum(["off", "soft", "hard"]),
    members: AttentionMembers,
  })
  .refine((attention) =>
    attention.mode === "off" ? attention.members.length === 0 : attention.members.length > 0,
  );

/** A fresh conversation has no attention list at all. */
const NO_ATTENTION: QqBinding["attention"] = Object.freeze({ mode: "off", members: [] });

function sameAttention(left: QqBinding["attention"], right: QqBinding["attention"]): boolean {
  return (
    left.mode === right.mode &&
    left.members.length === right.members.length &&
    left.members.every((member, index) => member === right.members[index])
  );
}

const bindingFields = {
  id: UuidSchema,
  ...identityFields,
  agentId: UuidSchema,
  schemeId: UuidSchema,
  paused: z.boolean(),
  shareWebMemory: z.boolean(),
  /**
   * How many unread observations trigger one organisation of this conversation.
   * `null` means automatic organising is off for it (the default), so a freshly
   * bound conversation never spends model calls until the user asks.
   */
  memoryBatchSize: z.number().int().min(1).nullable(),
  /**
   * §0.6/F05's per-conversation module switches: `null` follows the scheme, a boolean overrides it
   * here. Detailed parameters stay on the scheme — a group may switch a module off, not re-tune it.
   */
  triggers: BindingTriggers,
  /** 「重要的人」: who this conversation listens to, and how strictly (0031). */
  attention: BindingAttention,
};
const CreateSchema = z.strictObject({
  ...bindingFields,
  shareWebMemory: z.boolean().default(false),
  memoryBatchSize: bindingFields.memoryBatchSize.default(null),
  triggers: BindingTriggers.optional(),
  attention: BindingAttention.optional(),
});

/** A fresh conversation follows its scheme for all four modules. */
const NO_TRIGGER_OVERRIDES = Object.freeze({
  direct_reply: null,
  follow_up: null,
  chiming_in: null,
  idle_topic: null,
});
const BindingSchema = z
  .strictObject({
    ...bindingFields,
    ownerIdentityRevision: Revision.nullable(),
    revision: Revision,
    authorityRevision: Revision,
  })
  .refine(
    (binding) =>
      binding.authorityRevision <= binding.revision &&
      (binding.shareWebMemory
        ? binding.kind === "private" && binding.ownerIdentityRevision !== null
        : binding.ownerIdentityRevision === null),
  );
const PatchSchema = z.strictObject({
  agentId: UuidSchema.optional(),
  schemeId: UuidSchema.optional(),
  paused: z.boolean().optional(),
  shareWebMemory: z.boolean().optional(),
  memoryBatchSize: bindingFields.memoryBatchSize.optional(),
  /** The whole group travels: absent leaves all four alone, and a member set to null clears it. */
  triggers: BindingTriggers.optional(),
  /** The whole list travels too: absent leaves mode and members alone; `off` clears both. */
  attention: BindingAttention.optional(),
});

const ScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("web"), agentId: UuidSchema }),
  z.strictObject({
    kind: z.literal("qq"),
    accountId: AccountId,
    conversationKind: z.enum(["group", "private"]),
    peerId: AccountId,
    agentId: UuidSchema,
  }),
]);

export type QqConversationIdentity = Readonly<z.output<typeof IdentitySchema>>;
export type QqOwnerIdentity = Readonly<z.output<typeof OwnerSchema>>;
export type QqBinding = Readonly<z.output<typeof BindingSchema>>;
export type QqMemoryScope = Readonly<z.output<typeof ScopeSchema>>;
export interface QqMemoryAccess {
  readonly conversationKey: string;
  readonly historyScope: QqMemoryScope;
  readonly readScopes: readonly QqMemoryScope[];
  readonly writeScope: QqMemoryScope;
}
type SharingDenial = "private_only" | "owner_identity_required";
type Denied = { kind: "denied"; reason: SharingDenial };
export type QqBindingSave = { kind: "saved"; binding: QqBinding } | { kind: "conflict" } | Denied;
export type QqAccessResult = { kind: "resolved"; access: QqMemoryAccess } | Denied;

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ binding contract input");
  return result.data;
}

/**
 * Validate an already-assembled binding against the contract.
 *
 * Storage maps its own rows into the contract shape, and this is how that mapping is
 * checked: a row whose columns disagree with the contract's own rules is rejected
 * rather than treated as a usable binding.
 */
export function parseQqBinding(input: unknown): QqBinding {
  return Object.freeze(parse(BindingSchema, input));
}
function nextRevision(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) throw new TypeError("QQ binding revision exhausted");
  return value + 1;
}
function ownerOrNull(owner: QqOwnerIdentity | null): QqOwnerIdentity | null {
  return owner === null ? null : parse(OwnerSchema, owner);
}
function ownerMatches(identity: QqConversationIdentity, owner: QqOwnerIdentity | null): boolean {
  return (
    identity.kind === "private" &&
    owner !== null &&
    owner.accountId === identity.accountId &&
    owner.peerId === identity.peerId
  );
}
function grantDenial(
  identity: QqConversationIdentity,
  owner: QqOwnerIdentity | null,
): Denied | null {
  if (identity.kind !== "private") return { kind: "denied", reason: "private_only" };
  return ownerMatches(identity, owner)
    ? null
    : { kind: "denied", reason: "owner_identity_required" };
}

/** Owner identity is configured explicitly by the local user, never inferred from messages. */
export function createQqOwnerIdentity(accountId: unknown): QqOwnerIdentity {
  return Object.freeze({ accountId: parse(AccountId, accountId), peerId: null, revision: 1 });
}
export function updateQqOwnerIdentity(
  current: QqOwnerIdentity,
  peerId: unknown,
  expectedRevision: number,
): { kind: "saved"; owner: QqOwnerIdentity } | { kind: "conflict" } {
  const owner = parse(OwnerSchema, current);
  const nextPeer = parse(AccountId.nullable(), peerId);
  if (owner.revision !== parse(Revision, expectedRevision)) return { kind: "conflict" };
  return {
    kind: "saved",
    owner: Object.freeze({
      ...owner,
      peerId: nextPeer,
      revision: nextPeer === owner.peerId ? owner.revision : nextRevision(owner.revision),
    }),
  };
}

export function qqConversationKey(identity: QqConversationIdentity): string {
  const value = parse(IdentitySchema, identity);
  return JSON.stringify(["qq", value.accountId, value.kind, value.peerId]);
}
/**
 * The opaque `scope_key` for a memory scope.
 *
 * The web scope must resolve to the **bare agent id**, because that is exactly the
 * key existing web memory rows already carry (`scopeKey()` in memory-contract.ts
 * returns the agent id). Encoding it as its own JSON form would make shared reads
 * match zero rows — sharing would silently return nothing instead of the user's web
 * memory. Do not "tidy" this into a symmetric JSON shape.
 */
export function qqMemoryScopeKey(scope: QqMemoryScope): string {
  const value = parse(ScopeSchema, scope);
  return value.kind === "web"
    ? value.agentId
    : JSON.stringify(["qq", value.accountId, value.conversationKind, value.peerId, value.agentId]);
}
function conversationOf(binding: QqBinding): QqConversationIdentity {
  return { accountId: binding.accountId, kind: binding.kind, peerId: binding.peerId };
}
/**
 * The `kind: "qq"` arm of a memory scope — the same shape `QqConversationScope` names in the
 * observation repository, derived here so this module needs no import from it.
 */
export type QqConversationMemoryScope = Extract<QqMemoryScope, { kind: "qq" }>;

/** The one place the `kind: "qq"` scope object is built, for contract bindings and DB rows alike. */
export function qqConversationScopeOf(fields: {
  readonly accountId: string;
  readonly conversationKind: "group" | "private";
  readonly peerId: string;
  readonly agentId: string;
}): QqConversationMemoryScope {
  return Object.freeze({ kind: "qq", ...fields });
}

/**
 * The memory scope of one bound conversation. Exported because three callers must derive it the
 * same way — the intake scheduler, the manual 「立即整理」 action, and the bindings response that
 * reports each conversation's pending count; deriving it separately is how a count and a job
 * could come to disagree about which conversation they mean.
 */
export function qqConversationScope(binding: QqBinding): QqConversationMemoryScope {
  return qqConversationScopeOf({
    accountId: binding.accountId,
    conversationKind: binding.kind,
    peerId: binding.peerId,
    agentId: binding.agentId,
  });
}

export function createQqBinding(
  input: unknown,
  owner: QqOwnerIdentity | null = null,
): QqBindingSave {
  const value = parse(CreateSchema, input);
  const identity = ownerOrNull(owner);
  if (value.shareWebMemory) {
    const denied = grantDenial(value, identity);
    if (denied) return denied;
  }
  return {
    kind: "saved",
    binding: Object.freeze({
      ...value,
      triggers: value.triggers ?? NO_TRIGGER_OVERRIDES,
      attention: value.attention ?? NO_ATTENTION,
      ownerIdentityRevision: value.shareWebMemory && identity ? identity.revision : null,
      revision: 1,
      authorityRevision: 1,
    }),
  };
}

/** Caller persists the result with compare-and-swap in the same short transaction. */
export function updateQqBinding(
  current: QqBinding,
  input: unknown,
  expectedRevision: number,
  owner: QqOwnerIdentity | null = null,
): QqBindingSave {
  const binding = parse(BindingSchema, current);
  const patch = parse(PatchSchema, input);
  const identity = ownerOrNull(owner);
  if (binding.revision !== parse(Revision, expectedRevision)) return { kind: "conflict" };
  const agentId = patch.agentId ?? binding.agentId;
  const changedAgent = agentId !== binding.agentId;
  const shared = patch.shareWebMemory ?? (changedAgent ? false : binding.shareWebMemory);
  let ownerRevision = shared ? binding.ownerIdentityRevision : null;
  if (patch.shareWebMemory === true) {
    const denied = grantDenial(binding, identity);
    if (denied) return denied;
    ownerRevision = identity?.revision ?? null;
  }
  const changedAuthority =
    changedAgent ||
    shared !== binding.shareWebMemory ||
    ownerRevision !== binding.ownerIdentityRevision;
  const schemeId = patch.schemeId ?? binding.schemeId;
  const paused = patch.paused ?? binding.paused;
  // `null` is a meaningful value here ("automatic organising off"), so it must not be
  // collapsed into "not provided" by `??` — that would make switching it off a no-op.
  const memoryBatchSize =
    patch.memoryBatchSize === undefined ? binding.memoryBatchSize : patch.memoryBatchSize;
  const triggers = patch.triggers === undefined ? binding.triggers : patch.triggers;
  const attention = patch.attention === undefined ? binding.attention : patch.attention;
  // The batch size is an ordinary modification, not an authority change: it does not
  // move which assistant owns the memory or who may share it, so changing it must not
  // invalidate a running organisation the way an authority change does.
  const changed =
    changedAuthority ||
    schemeId !== binding.schemeId ||
    paused !== binding.paused ||
    memoryBatchSize !== binding.memoryBatchSize ||
    !sameTriggers(triggers, binding.triggers) ||
    !sameAttention(attention, binding.attention);
  return {
    kind: "saved",
    binding: Object.freeze({
      ...binding,
      agentId,
      schemeId,
      paused,
      memoryBatchSize,
      triggers,
      attention,
      shareWebMemory: shared,
      ownerIdentityRevision: ownerRevision,
      revision: changed ? nextRevision(binding.revision) : binding.revision,
      authorityRevision: changedAuthority
        ? nextRevision(binding.authorityRevision)
        : binding.authorityRevision,
    }),
  };
}

/** A stale grant fails closed rather than silently changing the task's memory destination. */
export function resolveQqMemoryAccess(
  current: QqBinding,
  owner: QqOwnerIdentity | null = null,
): QqAccessResult {
  const binding = parse(BindingSchema, current);
  const identity = ownerOrNull(owner);
  if (binding.shareWebMemory) {
    const denied = grantDenial(binding, identity);
    if (denied) return denied;
    if (identity?.revision !== binding.ownerIdentityRevision) {
      return { kind: "denied", reason: "owner_identity_required" };
    }
  }
  const historyScope = qqConversationScope(binding);
  const writeScope: QqMemoryScope = binding.shareWebMemory
    ? Object.freeze({ kind: "web", agentId: binding.agentId })
    : historyScope;
  return {
    kind: "resolved",
    access: Object.freeze({
      conversationKey: qqConversationKey(conversationOf(binding)),
      historyScope,
      readScopes: Object.freeze(
        binding.shareWebMemory ? [historyScope, writeScope] : [historyScope],
      ),
      writeScope,
    }),
  };
}

export interface QqTaskSnapshot {
  readonly bindingId: string;
  readonly agentId: string;
  readonly schemeId: string;
  readonly revision: number;
  readonly authorityRevision: number;
  readonly ownerIdentityRevision: number | null;
  readonly purpose: "reply" | "organization";
  readonly access: QqMemoryAccess;
}
type TaskBlockReason =
  | SharingDenial
  | "paused"
  | "binding_changed"
  | "authority_changed"
  | "wrong_purpose";
export type QqTaskCheck = { kind: "allowed" } | { kind: "blocked"; reason: TaskBlockReason };

/** Minted by the server when work is queued; never accept a client-supplied snapshot. */
export function captureQqTask(
  current: QqBinding,
  purpose: QqTaskSnapshot["purpose"],
  owner: QqOwnerIdentity | null = null,
): { kind: "captured"; snapshot: QqTaskSnapshot } | Exclude<QqTaskCheck, { kind: "allowed" }> {
  const binding = parse(BindingSchema, current);
  const taskPurpose = parse(z.enum(["reply", "organization"]), purpose);
  if (binding.paused) return { kind: "blocked", reason: "paused" };
  const result = resolveQqMemoryAccess(binding, owner);
  if (result.kind === "denied") return { kind: "blocked", reason: result.reason };
  return {
    kind: "captured",
    snapshot: Object.freeze({
      bindingId: binding.id,
      agentId: binding.agentId,
      schemeId: binding.schemeId,
      revision: binding.revision,
      authorityRevision: binding.authorityRevision,
      ownerIdentityRevision: binding.ownerIdentityRevision,
      purpose: taskPurpose,
      access: result.access,
    }),
  };
}

/** Binding guard only; caller also checks global/agent/module gates, sources and task ownership. */
export function checkQqTask(
  snapshot: QqTaskSnapshot,
  current: QqBinding | null,
  stage: "start" | "send" | "publish",
  owner: QqOwnerIdentity | null = null,
): QqTaskCheck {
  parse(z.enum(["start", "send", "publish"]), stage);
  if (
    (stage === "send" && snapshot.purpose !== "reply") ||
    (stage === "publish" && snapshot.purpose !== "organization")
  )
    return { kind: "blocked", reason: "wrong_purpose" };
  if (current === null) return { kind: "blocked", reason: "binding_changed" };
  const binding = parse(BindingSchema, current);
  if (
    binding.id !== snapshot.bindingId ||
    binding.agentId !== snapshot.agentId ||
    qqConversationKey(conversationOf(binding)) !== snapshot.access.conversationKey
  )
    return { kind: "blocked", reason: "binding_changed" };
  if (
    binding.authorityRevision !== snapshot.authorityRevision ||
    binding.ownerIdentityRevision !== snapshot.ownerIdentityRevision
  )
    return { kind: "blocked", reason: "authority_changed" };
  const result = resolveQqMemoryAccess(binding, owner);
  if (result.kind === "denied") return { kind: "blocked", reason: result.reason };
  if (
    qqMemoryScopeKey(result.access.writeScope) !== qqMemoryScopeKey(snapshot.access.writeScope) ||
    JSON.stringify(result.access.readScopes.map(qqMemoryScopeKey)) !==
      JSON.stringify(snapshot.access.readScopes.map(qqMemoryScopeKey))
  )
    return { kind: "blocked", reason: "authority_changed" };
  // Only running organization work may outlive pause or an ordinary scheme change.
  if (stage !== "publish") {
    if (binding.paused) return { kind: "blocked", reason: "paused" };
    if (binding.revision !== snapshot.revision)
      return { kind: "blocked", reason: "binding_changed" };
  }
  return { kind: "allowed" };
}

export interface QqObservationSource {
  readonly type: "qq_observation";
  readonly scopeKey: string;
  readonly conversationKey: string;
  readonly eventKey: string;
  readonly messageId: string;
  readonly occurredAtSeconds: number;
  readonly speakerKind: QqObservation["speaker"]["kind"];
  readonly speakerId: string | null;
}

/** References only. A paused binding still accepts observations into its own agent scope. */
export function qqObservationSource(
  current: QqBinding,
  observation: QqObservation,
): QqObservationSource {
  const binding = parse(BindingSchema, current);
  const conversationKey = qqConversationKey(conversationOf(binding));
  const observedKey = qqConversationKey({
    accountId: observation.accountId,
    kind: observation.conversation.kind,
    peerId: observation.conversation.peerId,
  });
  const messageId = parse(z.string().regex(/^(?:0|[1-9]\d*|-[1-9]\d*)$/), observation.messageId);
  const eventKey = JSON.stringify([
    "qq",
    binding.accountId,
    binding.kind,
    binding.peerId,
    messageId,
  ]);
  const speakerKind = parse(z.enum(["member", "anonymous", "system"]), observation.speaker.kind);
  const speakerId =
    observation.speaker.id === null ? null : parse(AccountId, observation.speaker.id);
  if (
    conversationKey !== observedKey ||
    observation.conversation.key !== conversationKey ||
    observation.eventKey !== eventKey ||
    (speakerKind === "member") !== (speakerId !== null) ||
    speakerId === binding.accountId ||
    (binding.kind === "private" && (speakerKind !== "member" || speakerId !== binding.peerId))
  )
    throw new TypeError("Invalid QQ observation source");
  return Object.freeze({
    type: "qq_observation",
    scopeKey: qqMemoryScopeKey(qqConversationScope(binding)),
    conversationKey,
    eventKey,
    messageId,
    occurredAtSeconds: parse(z.number().int().nonnegative(), observation.occurredAtSeconds),
    speakerKind,
    speakerId,
  });
}
