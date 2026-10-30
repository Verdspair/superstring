import type { Database } from "bun:sqlite";
import type { ConversationSummary } from "../../shared/contracts/conversation";
import { conversationSourceBodies } from "../conversation/conversation-view";
import type { ConversationEventRepository } from "../db/conversation-event-repository";
import { bodyRevision } from "../db/conversation-event-repository";
import { evidenceTextPage } from "../modules/evidence-pagination";
import type { ContextPrincipal } from "./context-access";

export interface ConversationSourceTarget {
  conversationId: string;
  kind: "web_message" | "qq_observation";
  id: string;
  turnId?: string | null;
  role?: "user" | "assistant" | null;
}
export type ConversationSourceInspection =
  | { state: "unavailable"; reason: string }
  | { state: "unknown"; reason: string }
  | {
      state: "available";
      reason: null;
      text: string;
      offset: number;
      total: number;
      nextOffset: number | null;
      revision: string;
      conversationId: string;
      expiresAt: string | null;
      participant: string | null;
      occurredAt: string;
    };
export function inspectConversationSourcePages(
  db: Database,
  repository: ConversationEventRepository,
  principal: ContextPrincipal,
  targets: readonly ConversationSourceTarget[],
  options: {
    includeShared: boolean;
    now: string;
    signal: AbortSignal;
    offset: number;
    limit: number;
    expectedRevision?: string;
    clock?: () => string;
  },
) {
  options.signal.throwIfAborted();
  if (!Number.isFinite(Date.parse(options.now))) throw new Error("Invalid inspection clock");
  const denied = (reason: string) => ({ state: "unavailable" as const, reason });
  const ids = [...new Set(targets.map((target) => target.conversationId))];
  const visible = visibleConversationMetadataMany(
    db,
    repository,
    ids,
    principal,
    options.includeShared,
  );
  const allowed = targets.flatMap((target, index) =>
    visible.has(target.conversationId) ? [{ target, index }] : [],
  );
  const rows = repository.inspectionSources(allowed.map((entry) => entry.target));
  const byOrdinal = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = byOrdinal.get(Number(row.ordinal)) ?? [];
    list.push(row);
    byOrdinal.set(Number(row.ordinal), list);
  }
  const exact = allowed.map((entry, ordinal) => {
    const candidates = byOrdinal.get(ordinal) ?? [];
    const row = candidates.length === 1 && candidates[0]!.member === 1 ? candidates[0]! : null;
    return { ...entry, ordinal, row, event: row ? repository.inspectionEvent(row) : null };
  });
  const events = exact.flatMap((item) => (item.event ? [item.event] : []));
  const before = conversationSourceBodies(db, events, options.now, true);
  // Synchronous selected-batch revalidation; no permissions or bodies survive the call.
  options.signal.throwIfAborted();
  const afterVisible = visibleConversationMetadataMany(
    db,
    repository,
    ids,
    principal,
    options.includeShared,
  );
  const afterRows = repository.inspectionSources(allowed.map((entry) => entry.target));
  const afterIdentity = new Map<number, string[]>();
  for (const row of afterRows) {
    const values = afterIdentity.get(Number(row.ordinal)) ?? [];
    values.push(JSON.stringify(row));
    afterIdentity.set(Number(row.ordinal), values);
  }
  const atDelivery = options.clock?.() ?? new Date().toISOString();
  const after = conversationSourceBodies(db, events, atDelivery, true);
  const results = targets.map((target) =>
    visible.has(target.conversationId)
      ? { state: "unknown" as const, reason: "unmapped" }
      : denied("forbidden"),
  ) as ConversationSourceInspection[];
  function pageFor(item: (typeof exact)[number]): ConversationSourceInspection {
    if (!afterVisible.has(item.target.conversationId)) return denied("forbidden");
    if (!item.event || !item.row) return { state: "unknown" as const, reason: "unmapped" };
    const finalIdentity = afterIdentity.get(item.ordinal);
    if (finalIdentity?.length !== 1 || finalIdentity[0] !== JSON.stringify(item.row))
      return denied("changed");
    const body = before.get(item.event),
      current = after.get(item.event);
    if (
      !body ||
      !current ||
      body.state !== "active" ||
      current.state !== "active" ||
      body.text === null ||
      body.revision !== current.revision ||
      body.expiresAt !== current.expiresAt
    )
      return denied(
        body?.state === "expired" || current?.state === "expired" ? "expired" : "missing",
      );
    if (
      body.expiresAt &&
      Date.parse(body.expiresAt) <= Date.parse(options.clock?.() ?? new Date().toISOString())
    )
      return denied("expired");
    const revision = bodyRevision(
      JSON.stringify([
        item.target,
        item.row.bindingEpoch,
        item.row.authorityRevision,
        body.revision,
        body.expiresAt,
      ]),
    );
    if (options.expectedRevision && options.expectedRevision !== revision) return denied("changed");
    return {
      state: "available" as const,
      reason: null,
      ...evidenceTextPage(body.text, options),
      revision,
      conversationId: item.target.conversationId,
      expiresAt: body.expiresAt,
      participant: item.event.participant?.label ?? null,
      occurredAt: item.event.occurredAt,
    };
  }
  for (const item of exact) results[item.index] = pageFor(item);
  options.signal.throwIfAborted();
  return results;
}
export function inspectConversationSourcePage(
  db: Database,
  repository: ConversationEventRepository,
  principal: ContextPrincipal,
  target: ConversationSourceTarget,
  options: Parameters<typeof inspectConversationSourcePages>[4],
) {
  return inspectConversationSourcePages(db, repository, principal, [target], options)[0]!;
}

/** History visibility is not execution authority; every call checks the current source. */
export function visibleConversations(
  _db: Database,
  repository: ConversationEventRepository,
  ids: readonly string[],
  principal: ContextPrincipal,
  includeShared = false,
): Map<string, ConversationSummary> {
  return repository.historySummaries(ids, { userId: principal.userId, includeShared });
}
export function visibleConversation(
  db: Database,
  repository: ConversationEventRepository,
  id: string,
  principal: ContextPrincipal,
  includeShared = false,
): ConversationSummary | null {
  return visibleConversations(db, repository, [id], principal, includeShared).get(id) ?? null;
}
export function visibleConversationMetadataMany(
  _db: Database,
  repository: ConversationEventRepository,
  ids: readonly string[],
  principal: ContextPrincipal,
  includeShared = false,
): Map<string, Pick<ConversationSummary, "id" | "lastSeq" | "bindingEpoch">> {
  return repository.historyMetadataMany(ids, { userId: principal.userId, includeShared });
}
export function visibleConversationMetadata(
  db: Database,
  repository: ConversationEventRepository,
  id: string,
  principal: ContextPrincipal,
  includeShared = false,
): Pick<ConversationSummary, "id" | "lastSeq" | "bindingEpoch"> | null {
  return (
    visibleConversationMetadataMany(db, repository, [id], principal, includeShared).get(id) ?? null
  );
}
