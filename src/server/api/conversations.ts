import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { ConversationEvent, ConversationSummary } from "../../shared/contracts/conversation";
import { ConversationChannelSchema } from "../../shared/contracts/conversation";
import type { QqConversationScope, QqMessageFact } from "../../shared/contracts/qq-message";
import { visibleConversation } from "../agent/conversation-access";
import {
  loadQqOutboundMessageFact,
  projectQqMessageFacts,
} from "../channels/onebot11/message-projection";
import { projectConversationEvent } from "../conversation/conversation-view";
import { toOrmHandle } from "../db/connection";
import { ConversationAvatarRepository } from "../db/conversation-avatar-repository";
import { ConversationEventRepository } from "../db/conversation-event-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import type { EvidenceStore } from "../modules/conversation-evidence-store";
import { ownerScope } from "../services/qq-media-sources";
import {
  createQqMemberNameSource,
  pruneQqMemberCurrentNames,
  type QqMemberNameCandidate,
} from "../services/qq-member-sources";
import { qqOutboundFactSourceAccess } from "../services/qq-outbound-fact-sources";
import { conversationAvatarRoutes } from "./conversation-avatars";
import { parseUuidParam, validationFailed } from "./validation";

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
    repository.discover(principal.userId);
    // Existing/new Web sessions receive canonical identity before the first client send.
    if (channel === "web" && sourceId) repository.ensureWeb(sourceId, principal.userId);
    if (channel === "onebot11" && sourceId) {
      const ownBinding = db
        .query(`SELECT 1 FROM qq_bindings b JOIN agents a ON a.id=b.agent_id
          WHERE b.id=?`)
        .get(sourceId);
      if (ownBinding) repository.ensureOneBot(sourceId);
    }
    const result = repository.list({ userId: principal.userId, channel, sourceId, cursor, limit });
    return c.json({
      ...result,
      items: result.items.flatMap((item) => {
        const visible = visibleConversation(
          db,
          repository,
          item.id,
          principal,
          options.includeShared,
        );
        return visible ? [{ ...visible, avatar: avatars.metadata(visible.id) }] : [];
      }),
    });
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
  router.get("/:id/status", (c) => {
    const id = parseUuidParam(c.req.param("id"));
    const conversation = visibleConversation(db, repository, id, principal, options.includeShared);
    if (!conversation) return c.json(conversationNotFound, 404);
    const current = repository.historyRows(id).at(-1)!;
    const wakes = db
      .query(`SELECT COALESCE(SUM(status='pending'),0) AS pendingWakes,
      COALESCE(SUM(status='failed'),0) AS failedWakes,MIN(CASE WHEN status='pending' THEN ready_at END) AS nextReadyAt
      FROM wake_signals WHERE conversation_id=?`)
      .get(current.id) as { pendingWakes: number; failedWakes: number; nextReadyAt: string | null };
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
      activeRuns,
      unknownDeliveries,
      lastActivityAt: current.updated_at,
      connectionPhase:
        conversation.channel === "web" ? "ready" : (options.connectionPhase?.() ?? "unavailable"),
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
    return c.json({
      ...result,
      items: result.items.map(({ event, seq }) => ({
        ...projectConversationEvent(db, event),
        ...qqEventFacts(db, factStore, event, conversation),
        conversationId: conversation.id,
        seq,
      })),
    });
  });
  return router;
}

/** T13 Step6：按事件种类分派详情组（入站事实 / 出站 delivery 确认部件）。 */
function qqEventFacts(
  db: Database,
  store: EvidenceStore,
  event: ConversationEvent,
  conversation: ConversationSummary,
): { qqMessageFacts?: QqMessageFact[] } {
  if (event.kind === "inbound") return qqInboundEventFacts(db, store, event, conversation);
  if (event.kind === "delivery") return qqDeliveryEventFacts(db, store, event, conversation);
  return {};
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
): { qqMessageFacts?: QqMessageFact[] } {
  const eventKeySource = event.sources.find((ref) => ref.kind === "qq_event");
  if (!eventKeySource) return {};
  // 真实 event 归属（不是展示 root）：ownerScope 从 conversation 行重建完整 scope，
  // remap 后 root ID 与真实事件会话不一致时自然拿不到 scope。
  const located = ownerScope(db, {
    kind: "conversation",
    id: event.conversationId,
    userId: DEFAULT_USER_ID,
    agentId: conversation.agentId,
  });
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

/**
 * T13 Step6 出站余项（规格 §6/§13.4）：`delivery` 事件的已确认部件详情组。
 *
 * 授权 fail closed（复用已审 loader，不复制权限 SQL）：`ownerScope` 用 event 的真实
 * conversationId（不是展示 root）重建完整 8 字段 scope；`event.source.id` 必须对应真实
 * `outbound_intents.conversation_id = event.conversationId` 的意图。候选按真实 ledger
 * （本 intent 的 confirmed 部件 + 非空平台 ID，ordinal 稳定序）与 event 自身 revision
 * 快照的交集，逐件经 `loadQqOutboundMessageFact`（scope 存在、confirmed 台账 + facts
 * 双账一致、intent target 六维 + 当前 authorityRevision、真实 delivery journal 归属、
 * 双期限帽）投影；fact.id 必须等于该 ordinal 部件在 ledger 里的精确 id（防 ambiguous）。
 * 来源证明是 loader mint 的 `qq_outbound_message_fact` ref（仅 part.id/ref），详情组末尾
 * 用域 keeper `qqOutboundFactSourceAccess` 复核（revision/expiry），不借 generic
 * contextaccess，保持与 315 域隔离。
 *
 * 事件时间语义（2026-10-03 裁定）：outbound-delivery 对每个状态推进 append 一个 delivery
 * 事件。只有 event 自己的 source.revision JSON 快照证明"本次确认了哪些 part"（planned
 * commit 事件 revision='planned'，无任何事实，不冒当时已发送）；不做后续 ledger 倒灌——
 * 早期 planned/中间态事件不得借当前 confirmed 状态加"已发详情"，重复事件各自真实映射。
 */
function qqDeliveryEventFacts(
  db: Database,
  store: EvidenceStore,
  event: ConversationEvent,
  conversation: ConversationSummary,
): { qqMessageFacts?: QqMessageFact[] } {
  const intentSource = event.sources.find((ref) => ref.kind === "outbound_intent");
  if (!intentSource || intentSource.id !== event.source.id) return {};
  // source.id 必须真实指向本会话的出站意图：conversation_id 不符即拒绝（跨会话引用不泄露）。
  const intentRow = db
    .query("SELECT conversation_id AS conversationId FROM outbound_intents WHERE id=?")
    .get(intentSource.id) as { conversationId: string } | null;
  if (!intentRow || intentRow.conversationId !== event.conversationId) return {};
  // 该事件时点自己证明的已确认部件：revision 是 [status, platformMessageId] 快照；
  // 'planned'/畸形快照无任何已发事实，直接无详情（不借当前 ledger 状态补历史事件）。
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(intentSource.revision);
  } catch {
    return {};
  }
  if (!Array.isArray(snapshot)) return {};
  const claimed = new Set<string>();
  for (const entry of snapshot) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      entry[0] !== "confirmed" ||
      typeof entry[1] !== "string" ||
      entry[1] === ""
    )
      continue;
    claimed.add(entry[1]);
  }
  if (!claimed.size) return {};
  const located = ownerScope(db, {
    kind: "conversation",
    id: event.conversationId,
    userId: DEFAULT_USER_ID,
    agentId: conversation.agentId,
  });
  if (!located || located === "ambiguous") return {};
  const scope = located.scope;
  const now = new Date().toISOString();
  // 候选 = 真实 ledger 里本 intent 的 confirmed 部件（ordinal 稳定序），且平台 ID 被该
  // event 自己的 revision 快照证明为"当时已确认"；伪造/外来引用进不来。
  const ledgerParts = db
    .query(
      `SELECT p.id AS partId,p.platform_message_id AS platformMessageId FROM outbound_parts p
      JOIN outbound_intents i ON i.id=p.intent_id
      WHERE i.id=? AND p.status='confirmed' AND p.platform_message_id IS NOT NULL
      ORDER BY p.ordinal`,
    )
    .all(intentSource.id) as { partId: string; platformMessageId: string }[];
  const facts: QqMessageFact[] = [];
  for (const part of ledgerParts) {
    if (!claimed.has(part.platformMessageId)) continue;
    const fact = loadQqOutboundMessageFact(store, scope, part.platformMessageId, now);
    // loader 已完整校验 8 字段 scope/authority/journal/target/body；这里再防 ambiguous：
    // fact.id（精确 outbound_parts.id）必须是该 ordinal 部件的真实 id。
    if (!fact || fact.id !== part.partId) continue;
    // 来源末验：域 keeper 复核 loader mint 的 qq_outbound_message_fact ref（revision/expiry）。
    const ref = fact.sources.find((source) => source.kind === "qq_outbound_message_fact");
    if (!ref) continue;
    if (
      qqOutboundFactSourceAccess(
        db,
        ref,
        {
          kind: "conversation",
          id: scope.conversationId,
          userId: DEFAULT_USER_ID,
          agentId: scope.agentId,
        },
        { userId: DEFAULT_USER_ID },
        now,
      ) !== "available"
    )
      continue;
    facts.push(fact);
  }
  // 与入站同一 readable filter：sticker/不可读快照（completeness=unavailable）只标存在，
  // 不进详情组、不编描述（§4.3 边界）。
  const readable = facts.filter((fact) => fact.completeness !== "unavailable");
  return readable.length ? { qqMessageFacts: readable } : {};
}
