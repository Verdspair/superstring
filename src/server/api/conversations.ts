import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { ConversationEvent, ConversationSummary } from "../../shared/contracts/conversation";
import {
  ConversationChannelSchema,
  ConversationGroupNamePatchSchema,
  ConversationMemoryReadModeUpdateSchema,
} from "../../shared/contracts/conversation";
import type { QqConversationScope, QqMessageFact } from "../../shared/contracts/qq-message";
import {
  visibleConversation,
  visibleConversationMetadata,
  visibleConversationMetadataMany,
  visibleConversations,
} from "../agent/conversation-access";
import {
  loadQqOutboundMessageFacts,
  projectQqMessageFacts,
} from "../channels/onebot11/message-projection";
import {
  type ConversationDirty,
  publishConversationChange,
  subscribeConversationChangeBatches,
} from "../conversation/conversation-changes";
import { projectConversationEvents } from "../conversation/conversation-view";
import { ownerScope } from "../conversation/evidence-scope";
import { toOrmHandle } from "../db/connection";
import { ConversationAvatarRepository } from "../db/conversation-avatar-repository";
import { ConversationEventRepository } from "../db/conversation-event-repository";
import { saveQqCustomName } from "../db/qq-group-name-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import { AppError } from "../errors";
import type { EvidenceStore } from "../modules/conversation-evidence-store";
import {
  createQqMemberNameSource,
  pruneQqMemberCurrentNames,
  type QqMemberNameCandidate,
} from "../services/qq-member-sources";
import { conversationAvatarRoutes } from "./conversation-avatars";
import { createSseResponse, type SseWriter } from "./sse";
import { parseBody, parseUuidParam, readJsonBody, validationFailed } from "./validation";

const principal = { userId: DEFAULT_USER_ID };
export const conversationNotFound = {
  error: { code: "CONVERSATION_NOT_FOUND", message: "会话不存在或不可访问" },
};

export function pageNumber(raw: string | undefined, fallback: number, minimum = 0): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw validationFailed();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw validationFailed();
  return value;
}

function pageCursor(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString());
  } catch {
    throw validationFailed();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((part) => typeof part === "string")
  )
    throw validationFailed();
  return raw;
}

/** Read projections of source facts; no second copy of conversation plaintext. */
export function conversationRoutes(
  db: Database,
  options: { includeShared?: boolean; connectionPhase?: () => string } = {},
): Hono {
  const router = new Hono();
  const repository = new ConversationEventRepository(db);
  const avatars = new ConversationAvatarRepository(db);
  // Legacy/source import reconciliation is an explicit bootstrap boundary, never a GET prefix.
  repository.reconcileSources(principal.userId);
  // T13 Step6：事实投影走统一 EvidenceStore 形状（只读复用现有连接，不新开数据库句柄）。
  const factStore: EvidenceStore = toOrmHandle(db);
  router.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  router.route("/", conversationAvatarRoutes(db, options.includeShared));
  router.get("/", (c) => {
    const rawChannel = c.req.query("channel");
    const parsed =
      rawChannel === undefined ? undefined : ConversationChannelSchema.safeParse(rawChannel);
    if (parsed && !parsed.success) throw validationFailed();
    const channel = parsed?.success ? parsed.data : undefined;
    const rawSourceId = c.req.query("sourceId");
    const sourceId = rawSourceId === undefined ? undefined : parseUuidParam(rawSourceId);
    const cursor = pageCursor(c.req.query("cursor"));
    const limit = pageNumber(c.req.query("limit"), 50, 1);
    const page = repository.directoryPage({
      userId: principal.userId,
      channel,
      sourceId,
      cursor,
      limit,
    });
    const visible = visibleConversations(
      db,
      repository,
      page.ids,
      principal,
      options.includeShared,
    );
    const avatarMetadata = avatars.metadataMany([...visible.values()].map((item) => item.id));
    return c.json({
      nextCursor: page.nextCursor,
      items: page.ids.flatMap((id) => {
        const item = visible.get(id);
        return item ? [{ ...item, avatar: avatarMetadata.get(item.id) ?? null }] : [];
      }),
    });
  });
  // Metadata-only change stream for directory + timeline. Registered before /:id
  // so "changes" is never captured as a conversation id; each notification still
  // passes the ordinary conversation read guard without projecting display fields.
  type ChangeStream = { writer: SseWriter; pending: Map<string, ConversationDirty> };
  const streams = new Set<ChangeStream>();
  let stopChanges: (() => void) | undefined;
  let scheduled = false;
  const flushChanges = () => {
    scheduled = false;
    const ready = [...streams].filter(
      (stream) => stream.writer.writable && stream.pending.size > 0,
    );
    if (!ready.length) return;
    const ids = [
      ...new Set(
        ready.flatMap((stream) =>
          [...stream.pending.values()].map((change) => change.conversationId),
        ),
      ),
    ];
    // No await between the live subject guard and enqueue, including after transport backpressure.
    const views = visibleConversationMetadataMany(
      db,
      repository,
      ids,
      principal,
      options.includeShared,
    );
    for (const stream of ready) {
      const projected = new Map<string, { event: string; data: Record<string, unknown> }>();
      for (const change of stream.pending.values()) {
        const view = views.get(change.conversationId);
        if (!view) continue;
        projected.set(`${view.id}\u0000${change.kind}`, {
          event:
            change.kind === "activity" ? "conversation_activity_changed" : "conversation_changed",
          data: {
            conversationId: view.id,
            seq: view.lastSeq,
            bindingEpoch: view.bindingEpoch,
            ...(change.kind === "activity" ? { activity: "span" } : {}),
          },
        });
      }
      if (stream.writer.trySendBatch([...projected.values()])) stream.pending.clear();
    }
  };
  const scheduleChanges = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flushChanges);
  };
  router.get("/changes", (c) => {
    let stopped = false;
    let finish: (() => void) | undefined;
    let ownStream: ChangeStream | undefined;
    return createSseResponse(
      {
        requestSignal: c.req.raw.signal,
        onWritable: scheduleChanges,
        onDisconnect: () => {
          stopped = true;
          if (ownStream) {
            streams.delete(ownStream);
            ownStream.pending.clear();
          }
          if (!streams.size) {
            stopChanges?.();
            stopChanges = undefined;
          }
          finish?.();
        },
      },
      async (writer) => {
        if (stopped) return;
        ownStream = { writer, pending: new Map() };
        streams.add(ownStream);
        if (!stopChanges)
          stopChanges = subscribeConversationChangeBatches(db, (changes) => {
            for (const stream of streams)
              for (const change of changes)
                stream.pending.set(`${change.conversationId}\u0000${change.kind}`, change);
            scheduleChanges();
          });
        await writer.send("ready", { ready: true });
        scheduleChanges();
        if (!stopped)
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
      },
    );
  });
  router.get("/:id", (c) => {
    const conversation = visibleConversation(
      db,
      repository,
      parseUuidParam(c.req.param("id")),
      principal,
      options.includeShared,
    );
    return conversation
      ? c.json({ ...conversation, avatar: avatars.metadata(conversation.id) })
      : c.json(conversationNotFound, 404);
  });
  router.get("/:id/memory-read-mode", (c) => {
    const id = parseUuidParam(c.req.param("id"));
    const conversation = visibleConversationMetadata(
      db,
      repository,
      id,
      principal,
      options.includeShared,
    );
    if (!conversation) return c.json(conversationNotFound, 404);
    const activation = repository.activeHistoryIdentity(id, principal.userId);
    const mode = activation ? repository.memoryReadMode(activation.id, principal.userId) : null;
    if (!mode) return c.json(conversationNotFound, 404);
    return c.json({ conversation_id: activation!.id, mode: mode.mode, revision: mode.revision });
  });
  router.put("/:id/memory-read-mode", async (c) => {
    const id = parseUuidParam(c.req.param("id"));
    const conversation = visibleConversationMetadata(
      db,
      repository,
      id,
      principal,
      options.includeShared,
    );
    if (!conversation) return c.json(conversationNotFound, 404);
    const body = parseBody(ConversationMemoryReadModeUpdateSchema, await readJsonBody(c.req.raw));
    if (!visibleConversationMetadata(db, repository, id, principal, options.includeShared))
      return c.json(conversationNotFound, 404);
    const result = repository.setMemoryReadMode(
      id,
      principal.userId,
      body.mode,
      body.expected_revision,
    );
    if (!result) return c.json(conversationNotFound, 404);
    if (result.kind === "conflict")
      throw new AppError("CONFIG_VERSION_CONFLICT", "会话记忆读取模式已变化，请刷新后重试", 409);
    return c.json({ conversation_id: id, mode: result.mode, revision: result.revision });
  });
  // 0053 QQ 群显示备注：null / trim 空串恢复群默认名；只对 QQ 群开放，Web 会话沿用
  // 既有改名入口，私聊一律 404（不新增错误码）。
  router.patch("/:id/name", async (c) => {
    const id = parseUuidParam(c.req.param("id"));
    const conversation = visibleConversation(db, repository, id, principal, options.includeShared);
    if (!conversation || conversation.channel !== "onebot11" || conversation.topology !== "shared")
      return c.json(conversationNotFound, 404);
    const parsed = ConversationGroupNamePatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw validationFailed();
    if (!visibleConversationMetadata(db, repository, id, principal, options.includeShared))
      return c.json(conversationNotFound, 404);
    const binding = db
      .query("SELECT account_id, peer_id FROM qq_bindings WHERE id=?")
      .get(conversation.sourceId) as { account_id: string; peer_id: string } | null;
    if (!binding) return c.json(conversationNotFound, 404);
    const name = parsed.data.name?.trim() ?? "";
    saveQqCustomName(db, binding.account_id, binding.peer_id, name === "" ? null : name);
    publishConversationChange(db, repository.historyRows(id).at(-1)!.id);
    const updated = visibleConversation(db, repository, id, principal, options.includeShared);
    return updated
      ? c.json({ ...updated, avatar: avatars.metadata(updated.id) })
      : c.json(conversationNotFound, 404);
  });
  router.get("/:id/status", (c) => {
    const id = parseUuidParam(c.req.param("id"));
    const conversation = visibleConversationMetadata(
      db,
      repository,
      id,
      principal,
      options.includeShared,
    );
    if (!conversation) return c.json(conversationNotFound, 404);
    const current = repository.historyRows(id).at(-1)!;
    const wakes = db
      .query(`SELECT COALESCE(SUM(status='pending'),0) AS pendingWakes,
      COALESCE(SUM(status='failed'),0) AS failedWakes,MIN(CASE WHEN status='pending' THEN ready_at END) AS nextReadyAt
      FROM wake_signals WHERE conversation_id=?`)
      .get(current.id) as { pendingWakes: number; failedWakes: number; nextReadyAt: string | null };
    const tasks = db
      .query(`WITH queued_work AS (
        SELECT ready_at FROM qq_conversation_tasks WHERE conversation_id=? AND status='pending'
        UNION ALL
        SELECT w.ready_at FROM wake_signals w
        WHERE w.conversation_id=? AND w.status='pending'
          AND NOT EXISTS (
            SELECT 1 FROM qq_conversation_tasks t WHERE t.conversation_id=w.conversation_id
              AND (t.origin_wake_id=w.id OR
                (t.task_class='mention' AND t.source_through_seq=w.through_seq AND t.cause=w.cause))
          )
      )
      SELECT (SELECT COUNT(*) FROM qq_conversation_tasks
        WHERE conversation_id=? AND status='pending') AS pendingTasks,
        COUNT(*) AS queuedCount, MIN(ready_at) AS nextReadyAt FROM queued_work`)
      .get(current.id, current.id, current.id) as {
      pendingTasks: number;
      queuedCount: number;
      nextReadyAt: string | null;
    };
    const { activeRuns } = db
      .query(
        "SELECT COUNT(*) AS activeRuns FROM agent_runs WHERE conversation_id=? AND ended_at IS NULL",
      )
      .get(current.id) as { activeRuns: number };
    const { unknownDeliveries } = db
      .query(
        "SELECT COUNT(*) AS unknownDeliveries FROM outbound_intents WHERE conversation_id=? AND status='unknown'",
      )
      .get(current.id) as { unknownDeliveries: number };
    return c.json({
      ...wakes,
      ...tasks,
      activeRuns,
      unknownDeliveries,
      lastActivityAt: current.updated_at,
      connectionPhase:
        current.channel === "web" ? "ready" : (options.connectionPhase?.() ?? "unavailable"),
      now: new Date().toISOString(),
    });
  });
  router.get("/:id/events", (c) => {
    const id = parseUuidParam(c.req.param("id"));
    const conversation = visibleConversation(db, repository, id, principal, options.includeShared);
    if (!conversation) return c.json(conversationNotFound, 404);
    const after = pageNumber(c.req.query("afterSeq"), 0);
    const limit = pageNumber(c.req.query("limit"), 100, 1);
    const direction = c.req.query("direction") ?? "after";
    if (!["latest", "before", "after"].includes(direction)) throw validationFailed();
    const before = pageNumber(c.req.query("beforeSeq"), Number.MAX_SAFE_INTEGER, 1);
    const result =
      direction === "after"
        ? repository.historyAfter(id, after, limit)
        : repository.historyBefore(
            id,
            direction === "latest" ? Number.MAX_SAFE_INTEGER : before,
            limit,
          );
    // T13 Step6：scope 缓存按真实 event.conversationId（epoch/owner）分键，只活在本次
    // 请求闭包——同一真实会话只重建一次，不同 epoch/owner 各自重算；不跨请求持久，
    // 不按展示 root 或分页范围共键。投影授权与既有守卫全部不变。
    const requestScopes = new Map<string, ReturnType<typeof ownerScope>>();
    const projected = projectConversationEvents(
      db,
      result.items.map(({ event }) => event),
    );
    const deliveryFacts = qqDeliveryPageFacts(
      db,
      factStore,
      result.items.map(({ event }) => event),
      conversation,
      requestScopes,
    );
    return c.json({
      ...result,
      items: result.items.map(({ event, seq }, index) => {
        const itemProjected = projected[index];
        const facts = qqEventFacts(
          db,
          factStore,
          event,
          conversation,
          requestScopes,
          deliveryFacts,
        );
        let contentState = itemProjected.contentState;
        if (
          contentState === "unavailable" &&
          (event.source.kind === "qq_event" || event.source.kind === "qq_observation") &&
          facts.qqMessageFacts &&
          facts.qqMessageFacts.length > 0
        ) {
          const matchingFact = facts.qqMessageFacts.find((f) => f.id === event.source.id);
          if (
            matchingFact &&
            matchingFact.completeness === "full" &&
            !matchingFact.parts.some((p) => p.kind === "text") &&
            itemProjected.media.some((m) => m.availability === "available")
          ) {
            contentState = "active";
          }
        }
        return {
          ...itemProjected,
          contentState,
          ...facts,
          conversationId: conversation.id,
          seq,
        };
      }),
    });
  });
  return router;
}

/** 本请求内按真实 event conversationId（epoch/owner）缓存 ownerScope；跨请求不持久。 */
function requestScope(
  db: Database,
  conversation: ConversationSummary,
  eventConversationId: string,
  requestScopes: Map<string, ReturnType<typeof ownerScope>>,
): ReturnType<typeof ownerScope> {
  let located = requestScopes.get(eventConversationId);
  if (located === undefined) {
    located = ownerScope(db, {
      kind: "conversation",
      id: eventConversationId,
      userId: DEFAULT_USER_ID,
      agentId: conversation.agentId,
    });
    requestScopes.set(eventConversationId, located);
  }
  return located;
}

/** 按事件种类分派详情组（入站事实 / 出站 delivery 确认部件）。 */
function qqEventFacts(
  db: Database,
  store: EvidenceStore,
  event: ConversationEvent,
  conversation: ConversationSummary,
  requestScopes: Map<string, ReturnType<typeof ownerScope>>,
  deliveryFacts: ReadonlyMap<ConversationEvent, QqMessageFact[]>,
): { qqMessageFacts?: QqMessageFact[] } {
  if (event.kind === "inbound")
    return qqInboundEventFacts(db, store, event, conversation, requestScopes);
  const facts = deliveryFacts.get(event);
  return facts?.length ? { qqMessageFacts: facts } : {};
}

/**
 * T13 Step6（规格 §6）：入站 QQ 事件的详情组——发送时双名快照、当前双名映射、ordered
 * @ 与 reply 关系，全部来自统一事实投影 `projectQqMessageFacts`，不另解析 raw OneBot。
 *
 * 授权（fail closed）：事件必须真实归属于本会话（用 event 的真实 conversationId，不是
 * 展示用的 history root remap ID）；owner 四维 + 完整 8 字段 scope + evidenceScopeExists
 * + journal timeline（qq_event/qq_observation inbound）全部经投影与来源校验。旧 closed
 * epoch / 新 binding 不借当前 owner 读旧 facts——投影按真实 scope 拒绝后无详情组，而既有
 * 历史正文仍按原 remap guard 保持（不回退既有行为）。当前双名只作 optional prune：
 * mint 独立 `qq_member_name` 来源并经 `pruneQqMemberCurrentNames` 校验实际 QQ/ref/value；
 * 名字过期或改名只丢 `currentName`，不取消仍合法的事实快照与正文。
 */
function qqInboundEventFacts(
  db: Database,
  store: EvidenceStore,
  event: ConversationEvent,
  conversation: ConversationSummary,
  requestScopes: Map<string, ReturnType<typeof ownerScope>>,
): { qqMessageFacts?: QqMessageFact[] } {
  const eventKeySource = event.sources.find((ref) => ref.kind === "qq_event");
  if (!eventKeySource) return {};
  // 真实 event 归属（不是展示 root）：ownerScope 从 conversation 行重建完整 scope，
  // remap 后 root ID 与真实事件会话不一致时自然拿不到 scope。
  const located = requestScope(db, conversation, event.conversationId, requestScopes);
  if (!located || located === "ambiguous") return {};
  const scope: QqConversationScope = located.scope;
  const now = new Date().toISOString();
  const facts = projectQqMessageFacts(store, scope, [eventKeySource.id], now);
  // unavailable（正文失效/快照不一致）拒整个详情组：不含 QQ/姓名/mentions（§4.3 边界）；
  // 过期事实在投影内已是 null。legacy_partial 保留——legacy 单名快照明确显示为 legacy。
  const readable = facts.filter((fact) => fact.completeness !== "unavailable");
  if (!readable.length) return {};
  // 当前双名映射独立 prune：ref 的 value 必须等于成员行真实当前双名，过期/改名即裁剪。
  const candidates = new Map<string, QqMemberNameCandidate>();
  const qqs = new Set<string>();
  if (readable[0]?.speaker.qq) qqs.add(readable[0].speaker.qq);
  for (const mention of readable[0]?.mentions ?? [])
    if (mention.identity?.qq) qqs.add(mention.identity.qq);
  for (const qq of qqs) {
    const minted = createQqMemberNameSource(store, scope, qq, now);
    if (minted) candidates.set(qq, { value: minted.currentName, source: minted.source });
  }
  const pruned = pruneQqMemberCurrentNames({
    db,
    facts: readable,
    owner: {
      kind: "conversation",
      id: scope.conversationId,
      userId: DEFAULT_USER_ID,
      agentId: scope.agentId,
    },
    principal: { userId: DEFAULT_USER_ID },
    now,
    candidates,
  });
  return pruned.length ? { qqMessageFacts: pruned } : {};
}

/** Preserve each event's confirmation snapshot; current ledger state cannot backfill it. */
function qqDeliveryPageFacts(
  db: Database,
  store: EvidenceStore,
  events: readonly ConversationEvent[],
  conversation: ConversationSummary,
  requestScopes: Map<string, ReturnType<typeof ownerScope>>,
): Map<ConversationEvent, QqMessageFact[]> {
  const result = new Map<ConversationEvent, QqMessageFact[]>();
  const groups = new Map<
    string,
    {
      scope: QqConversationScope;
      selections: {
        event: ConversationEvent;
        parts: { partId: string; platformMessageId: string }[];
      }[];
    }
  >();
  for (const event of events) {
    if (event.kind !== "delivery") continue;
    const intentSource = event.sources.find((ref) => ref.kind === "outbound_intent");
    if (!intentSource || intentSource.id !== event.source.id) continue;
    const intent = db
      .query("SELECT conversation_id AS conversationId FROM outbound_intents WHERE id=?")
      .get(intentSource.id) as { conversationId: string } | null;
    if (!intent || intent.conversationId !== event.conversationId) continue;
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(intentSource.revision);
    } catch {
      continue;
    }
    if (!Array.isArray(snapshot)) continue;
    const claimed = new Set<string>();
    for (const entry of snapshot) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry[0] === "confirmed" &&
        typeof entry[1] === "string" &&
        entry[1] !== ""
      )
        claimed.add(entry[1]);
    }
    if (!claimed.size) continue;
    const located = requestScope(db, conversation, event.conversationId, requestScopes);
    if (!located || located === "ambiguous") continue;
    const parts = (
      db
        .query(`SELECT p.id AS partId,p.platform_message_id AS platformMessageId
      FROM outbound_parts p JOIN outbound_intents i ON i.id=p.intent_id
      WHERE i.id=? AND p.status='confirmed' AND p.platform_message_id IS NOT NULL ORDER BY p.ordinal`)
        .all(intentSource.id) as { partId: string; platformMessageId: string }[]
    ).filter((part) => claimed.has(part.platformMessageId));
    if (!parts.length) continue;
    // requestScope is keyed by the physical conversation, not the displayed history root.
    const group = groups.get(event.conversationId) ?? { scope: located.scope, selections: [] };
    group.selections.push({ event, parts });
    groups.set(event.conversationId, group);
  }
  const now = new Date().toISOString();
  for (const { scope, selections } of groups.values()) {
    const platformIds = [
      ...new Set(
        selections.flatMap((selection) => selection.parts.map((part) => part.platformMessageId)),
      ),
    ];
    const facts = loadQqOutboundMessageFacts(store, scope, platformIds, now);
    const byPlatform = new Map(facts.map((fact) => [fact.platformMessageId, fact]));
    for (const { event, parts } of selections) {
      const readable = parts.flatMap((part) => {
        const fact = byPlatform.get(part.platformMessageId);
        return fact && fact.id === part.partId && fact.completeness !== "unavailable" ? [fact] : [];
      });
      if (readable.length) result.set(event, readable);
    }
  }
  return result;
}
