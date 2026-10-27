// T06（原计划文字记忆完整闭环）：memory_job 的 QQ 事实输入与 publication 冻结来源。
//
// 这是 memory_job 唯一的窄授权适配层：新导出只接受**显式从 memory_jobs 行读出的
// source_event_ids + scope_key**（userId/agentId 显式完全匹配），scope 经合成 `qq_binding`
// owner 走既有 `ownerScope` 全量解析（含换绑 fail closed），再复用既有
// `projectQqMessageFacts`/`projectQqTextRelations`/`createQqMemberNameSource`/
// `qqMessageFactSourceAccess`/`qqMemberNameSourceAccess` 算法——conversation/qq_binding
// owner 的既有 access 路径零改动，memory_job 没有获得任何泛化授权：媒体 refs 与
// `qq_media_source` 对 memory_job 仍全 revoked（不给 memory 所有 scope 媒体权限），
// generic `ownerScope` 不扩 `memory_job` 分支。scope_key 反解在本文件内完整实现
// （group/private 都解析；不调用未导出的 parseQqScopeKey，私聊没有群能力约束但绑定行与
// 完整 8 字段 scope 照常解析）。
//
// 语义（原计划 T06 Step3–6、规格 §3/§12）：
// * load：每个 selected event 真实 live full facts → projectQqTextRelations；存在但
//   expired/unavailable 的 facts 不回裸 body（只留最少状态、不产 ref）；SQL 真无 facts 行
//   且 body 仍活且在 timeline 内才 legacy（沿旧 source 形状，明确不编双名）；全部无可整理
//   记录 → MEMORY_SOURCE_INVALID，不发布 phantom sources。
// * currentName 依已验 helper 以合法 binding owner 复验（ref.id↔identity.qq↔value 吻合才
//   保留）；name refs 独立可选，失效只把 currentName 置空，不撤正文。
// * publication：同 tx 复验 facts/body 现值与冻结 8 字段 scope 逐项比对；name refs 不参与
//   publish 门（不取消仍合法 body 的 publication，也不把当前名声明当亲口事实）。
// * 运行期 name refs 只认 job.source_event_ids 里真实 speaker/mention 出现过的 QQ，模型
//   自造/别成员拒；外部 resolveSource 不能翻转这两类（context-access 直连 keeper）。

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceAccess, SourceRef } from "../../shared/contracts/evidence";
import { bodyRevision } from "../db/conversation-event-repository";
import { readQqBinding } from "../db/qq-binding-repository";
import { readQqOwnerIdentity } from "../db/qq-owner-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import { fail } from "../errors";
import { evidenceScopeExists } from "../modules/conversation-evidence";
import type { EvidenceStore } from "../modules/conversation-evidence-store";
import { inTimeline } from "../modules/conversation-evidence-store";
import { memoryJobScopes, type QqMemoryRouteSnapshot } from "./memory-contract";
import { correctionMetadata, memoryRevision } from "./memory-revision";
import { qqConversationKey, qqMemoryScopeKey, resolveQqMemoryAccess } from "./qq-binding-contract";
import { ownerScope } from "./qq-media-sources";
import { createQqMemberNameSource, qqMemberNameSourceAccess } from "./qq-member-sources";
import { projectQqMessageFacts } from "./qq-message-fact-projection";
import {
  qqMessageFactSourceAccess,
  qqMessageFactSourceAccessMany,
} from "./qq-message-fact-sources";
import { isObservationExpired } from "./qq-retention";
import { projectQqTextRelations } from "./qq-text-relations";

/** 完整 8 字段 QQ 会话作用域（与 QqConversationScope 同形，本地声明避免反向依赖）。 */
export interface QqMemoryFactScope {
  readonly conversationId: string;
  readonly accountId: string;
  readonly conversationKind: "group" | "private";
  readonly peerId: string;
  readonly agentId: string;
  readonly bindingId: string;
  readonly bindingEpoch: number;
  readonly authorityRevision: number;
}

/** 一个被消费（或显式不可读）的整理来源记录。 */
export interface QqMemoryFactRecord {
  readonly eventKey: string;
  readonly record: Record<string, unknown>;
}

/** load 的冻结快照：load↔publish 内存传递（同时冻结进 job.configSnapshot.qq_fact_scope）。 */
export interface QqPublication {
  readonly scopeKey: string;
  readonly scope: QqMemoryFactScope;
  readonly factRefs: SourceRef[];
  readonly nameRefs: SourceRef[];
  readonly records: QqMemoryFactRecord[];
}

interface JobRow {
  agent_id: string;
  user_id: string;
  config_snapshot: string;
}

interface SnapshotShape {
  scope_key?: unknown;
  source_event_ids?: unknown;
  qq_fact_scope?: unknown;
  qq_route?: QqMemoryRouteSnapshot;
}

/** scope_key 反解：`["qq",account,kind,peer,agent(可选)]`；kind 必须是 group|private。 */
export function parseQqMemoryScopeKey(scopeKey: string): {
  accountId: string;
  conversationKind: "group" | "private";
  peerId: string;
} | null {
  let value: unknown;
  try {
    value = JSON.parse(scopeKey);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value[0] !== "qq") return null;
  const accountId = value[1];
  const kind = value[2];
  const peerId = value[3];
  if (typeof accountId !== "string" || accountId === "") return null;
  if (kind !== "group" && kind !== "private") return null;
  if (typeof peerId !== "string" || peerId === "") return null;
  return { accountId, conversationKind: kind, peerId };
}

/**
 * 从真实 memory_jobs 行（userId/agentId 显式完全匹配）反解本任务当下完整 8 字段 scope。
 * 绑定必须与任务助手匹配（换绑 fail closed）；定位失败一律 null，调用方 fail closed。
 */
export function resolveQqMemoryFactScope(
  db: Database,
  agentId: string,
  jobId: string,
  scopeKey: string,
): QqMemoryFactScope | null {
  const job = db
    .query("SELECT agent_id,user_id,config_snapshot FROM memory_jobs WHERE id=?")
    .get(jobId) as JobRow | null;
  if (!job || job.agent_id !== agentId || job.user_id !== DEFAULT_USER_ID) return null;
  return resolveCurrentQqScope(db, agentId, scopeKey);
}

function resolveCurrentQqScope(
  db: Database,
  agentId: string,
  scopeKey: string,
): QqMemoryFactScope | null {
  const identity = parseQqMemoryScopeKey(scopeKey);
  if (!identity) return null;
  // 真实绑定行（唯一 (account,kind,peer)）；助手必须与任务一致。
  const binding = db
    .query(`SELECT id,agent_id,conversation_kind,peer_id,account_id FROM qq_bindings
    WHERE account_id=? AND conversation_kind=? AND peer_id=?`)
    .get(identity.accountId, identity.conversationKind, identity.peerId) as {
    id: string;
    agent_id: string;
    conversation_kind: string;
    peer_id: string;
    account_id: string;
  } | null;
  if (!binding || binding.agent_id !== agentId) return null;
  // 既有合法 owner 路径：合成 qq_binding owner 走完整 ownerScope（活会话唯一性等）。
  const located = ownerScope(db, {
    kind: "qq_binding",
    id: binding.id,
    userId: DEFAULT_USER_ID,
    agentId: binding.agent_id,
  });
  if (!located || located === "ambiguous") return null;
  const scope = located.scope;
  if (
    scope.conversationKind !== identity.conversationKind ||
    scope.accountId !== identity.accountId ||
    scope.peerId !== identity.peerId ||
    scope.agentId !== agentId
  )
    return null;
  return scope;
}

/** 该 job 的合法 binding owner（既有 access 算法的 owner 入参；不扩 ownerScope 本体）。 */
export function resolveQqMemoryFactOwner(scope: QqMemoryFactScope): RunOwner {
  return {
    kind: "qq_binding",
    id: scope.bindingId,
    userId: DEFAULT_USER_ID,
    agentId: scope.agentId,
  };
}

/**
 * load 时把本次真实 8 字段 scope 冻结为 job.configSnapshot 的附加 `qq_fact_scope`
 * （私有内部 JSON，不新 schema 列）。已有冻结（重复 load）不可被新 scope 覆盖：
 * frozen 缺失时写入本次值，存在时原样保留旧冻结——运行期复验以**冻结值**为准，
 * 现值须每次与冻结逐项比对（换绑/authority/epoch 变化在 verify 时拒）。
 */
export function freezeQqFactScope(
  db: Database,
  agentId: string,
  jobId: string,
  scopeKey: string,
): QqMemoryFactScope {
  const job = db.query("SELECT config_snapshot FROM memory_jobs WHERE id=?").get(jobId) as {
    config_snapshot: string;
  } | null;
  if (!job) fail("MEMORY_JOB_NOT_FOUND", "整理任务不存在", 404);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(job.config_snapshot) as Record<string, unknown>;
  } catch {
    fail("MEMORY_SOURCE_INVALID", "观察任务快照损坏，不能整理");
  }
  const existing = parsed.qq_fact_scope;
  if (isQqMemoryFactScope(existing)) {
    // 重复 load 不可用新 scope 覆盖旧 freeze；现值须与冻结 8 字段逐项比对，不符即拒。
    const current = resolveQqMemoryFactScope(db, agentId, jobId, scopeKey);
    if (!current || !sameScope(current, existing)) {
      fail("MEMORY_STATE_CONFLICT", "来源作用域已变化，不能继续整理");
    }
    return existing;
  }
  const scope = resolveQqMemoryFactScope(db, agentId, jobId, scopeKey);
  if (!scope) {
    fail("MEMORY_SOURCE_INVALID", "观察任务缺少有效绑定，不能整理");
  }
  // 冻结进 configSnapshot：同 job 重复 load 只保留第一次的真实 scope。
  parsed.qq_fact_scope = { ...scope, scope_key: scopeKey };
  db.query("UPDATE memory_jobs SET config_snapshot=? WHERE id=?").run(
    JSON.stringify(parsed),
    jobId,
  );
  return scope;
}

function snapshotOf(db: Database, jobId: string): { job: JobRow; parsed: SnapshotShape } | null {
  const job = db
    .query("SELECT agent_id,user_id,config_snapshot FROM memory_jobs WHERE id=?")
    .get(jobId) as JobRow | null;
  if (!job || job.user_id !== DEFAULT_USER_ID) return null;
  let parsed: SnapshotShape;
  try {
    parsed = JSON.parse(job.config_snapshot) as SnapshotShape;
  } catch {
    return null;
  }
  return { job, parsed };
}

const SCOPE_FIELDS = [
  "conversationId",
  "accountId",
  "conversationKind",
  "peerId",
  "agentId",
  "bindingId",
  "bindingEpoch",
  "authorityRevision",
] as const;

export function isQqMemoryFactScope(value: unknown): value is QqMemoryFactScope {
  if (value === null || typeof value !== "object") return false;
  return SCOPE_FIELDS.every(
    (field) =>
      typeof (value as Record<string, unknown>)[field] === "string" ||
      typeof (value as Record<string, unknown>)[field] === "number",
  );
}

function sameScope(a: QqMemoryFactScope, b: QqMemoryFactScope): boolean {
  return SCOPE_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * memory_job 的窄来源 access（context-access 对这两个 kind 的直连 keeper 委托点）：
 * owner 必须是本 job 自己（userId/agentId 显式匹配），`qq_message_fact` 只认
 * job.source_event_ids 里的精确 eventKey，`qq_member_name` 只认 selected events 的真实
 * speaker/mention 出现过的 QQ；其余 kind（含媒体）一律 revoked。之后委托既有
 * conversation/binding access 算法做完整 owner/scope/timeline/revision/expiry 复验。
 */
export function qqMemoryJobSourceAccess(
  db: Database,
  source: SourceRef,
  owner: RunOwner,
  now: string,
): SourceAccess {
  if (owner.kind !== "memory_job") return "revoked";
  const found = snapshotOf(db, owner.id);
  if (!found) return "revoked";
  const { job, parsed } = found;
  if (owner.agentId !== undefined && owner.agentId !== job.agent_id) return "revoked";
  const sourceScope = memoryJobScopes(
    parsed as { scope_key?: string; qq_route?: QqMemoryRouteSnapshot },
  ).source;
  if (typeof sourceScope !== "string") return "revoked";
  const scope = resolveQqMemoryFactScope(db, job.agent_id, owner.id, sourceScope);
  if (!scope) return "revoked";
  const eventIds = Array.isArray(parsed.source_event_ids)
    ? (parsed.source_event_ids as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  if (source.kind === "qq_message_fact") {
    if (!eventIds.includes(source.id)) return "revoked";
    return (
      qqMessageFactSourceAccess(
        db,
        source,
        resolveQqMemoryFactOwner(scope),
        { userId: DEFAULT_USER_ID },
        now,
      ) ?? "revoked"
    );
  }
  if (source.kind === "qq_member_name") {
    // ref.id 是 JSON [account,kind,peer,qq]；先核身份属于本 job scope，再核该 QQ 在
    // selected events 里真实出现过（speaker 或 mention），最后走既有 name access。
    let identity: unknown;
    try {
      identity = JSON.parse(source.id);
    } catch {
      return "revoked";
    }
    if (!Array.isArray(identity) || identity.length !== 4) return "revoked";
    const [accountId, kind, peerId, qq] = identity as unknown[];
    if (
      accountId !== scope.accountId ||
      kind !== scope.conversationKind ||
      peerId !== scope.peerId ||
      typeof qq !== "string" ||
      qq === ""
    )
      return "revoked";
    if (!qqInSelectedEvents(db, eventIds, qq)) return "revoked";
    return (
      qqMemberNameSourceAccess(
        db,
        source,
        resolveQqMemoryFactOwner(scope),
        { userId: DEFAULT_USER_ID },
        now,
      ) ?? "revoked"
    );
  }
  return "revoked";
}

/** 该 QQ 是否真出现在 selected events（speaker 或 facts 的 mention 段）。 */
function qqInSelectedEvents(db: Database, eventIds: string[], qq: string): boolean {
  if (eventIds.length === 0) return false;
  const placeholders = eventIds.map(() => "?").join(",");
  const row = db
    .query(`SELECT 1 FROM qq_events e LEFT JOIN qq_message_facts f ON f.event_key=e.event_key
    WHERE e.event_key IN (${placeholders}) AND (e.speaker_id=? OR EXISTS(
      SELECT 1 FROM json_each(CASE WHEN f.parts IS NOT NULL AND length(f.parts)<=65536
        AND json_valid(f.parts) THEN f.parts ELSE '[]' END) p
      WHERE json_extract(p.value,'$.kind')='mention' AND json_extract(p.value,'$.qq')=?)) LIMIT 1`)
    .get(...eventIds, qq, qq);
  return row !== null;
}

interface LoadRow {
  eventKey: string;
  accountId: string;
  conversationKind: string;
  peerId: string;
  agentId: string;
  body: string | null;
  bodyExpiresAt: string | null;
  factExpiresAt: string | null;
  messageId: string;
  occurredAtSeconds: number;
  speakerKind: string;
  speakerId: string | null;
}

function loadRows(db: Database, eventKeys: readonly string[]): Map<string, LoadRow> {
  const rows = new Map<string, LoadRow>();
  const statement = db.query(
    `SELECT e.event_key AS eventKey,e.account_id AS accountId,e.conversation_kind AS conversationKind,
    e.peer_id AS peerId,e.agent_id AS agentId,t.body AS body,t.expires_at AS bodyExpiresAt,
    f.expires_at AS factExpiresAt,e.message_id AS messageId,
    e.occurred_at_seconds AS occurredAtSeconds,e.speaker_kind AS speakerKind,
    e.speaker_id AS speakerId
    FROM json_each(?) requested JOIN qq_events e ON e.event_key=requested.value
    LEFT JOIN qq_message_facts f ON f.event_key=e.event_key
    LEFT JOIN qq_observation_text t ON t.event_key=e.event_key`,
  );
  for (const row of statement.all(JSON.stringify([...new Set(eventKeys)])) as LoadRow[]) {
    rows.set(row.eventKey, row);
  }
  return rows;
}

type QqEntrySource = {
  eventKey: string;
  scopeKey: string;
  conversationKey: string;
  messageId: string;
  occurredAtSeconds: number;
  speakerKind: string;
  speakerId: string | null;
};

/** Group every entry's QQ sources by actual owner and scope in this call only. */
type QqPublicationBatchInput = {
  db: Database;
  orm: EvidenceStore["orm"];
  entries: readonly { id: string; agentId: string; sources: readonly QqEntrySource[] }[];
  now: string;
};

type QqFact = ReturnType<typeof projectQqMessageFacts>[number];

function collectQqEntryPublicationSources(input: QqPublicationBatchInput): {
  proof: ReadonlyMap<string, unknown[]>;
  facts: ReadonlyMap<string, QqFact>;
} {
  const groups = new Map<
    string,
    { agentId: string; scopeKey: string; items: { id: string; source: QqEntrySource }[] }
  >();
  const proof = new Map<string, unknown[]>();
  const facts = new Map<string, QqFact>();
  const invalid = new Set<string>();
  for (const entry of input.entries) {
    proof.set(entry.id, []);
    for (const source of entry.sources) {
      const key = JSON.stringify([entry.agentId, source.scopeKey]);
      const group = groups.get(key) ?? {
        agentId: entry.agentId,
        scopeKey: source.scopeKey,
        items: [],
      };
      group.items.push({ id: entry.id, source });
      groups.set(key, group);
    }
  }
  for (const { agentId, scopeKey, items } of groups.values()) {
    const scope = resolveCurrentQqScope(input.db, agentId, scopeKey);
    if (
      !scope ||
      qqMemoryScopeKey({
        kind: "qq",
        accountId: scope.accountId,
        conversationKind: scope.conversationKind,
        peerId: scope.peerId,
        agentId: scope.agentId,
      }) !== scopeKey
    ) {
      for (const item of items) invalid.add(item.id);
      continue;
    }
    const ids = [...new Set(items.map(({ source }) => source.eventKey))];
    const matches = input.db
      .query(`SELECT source_id AS eventKey, conversation_id AS conversationId
      FROM conversation_events WHERE source_kind='qq_event' AND kind='inbound'
      AND source_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as {
      eventKey: string;
      conversationId: string;
    }[];
    const byEvent = new Map<string, string[]>();
    for (const match of matches) {
      const list = byEvent.get(match.eventKey) ?? [];
      list.push(match.conversationId);
      byEvent.set(match.eventKey, list);
    }
    const events = loadRows(input.db, ids);
    const projected = new Map(
      projectQqMessageFacts({ db: input.db, orm: input.orm }, scope, ids, input.now).map((fact) => [
        fact.id,
        fact,
      ]),
    );
    for (const [eventKey, fact] of projected)
      facts.set(JSON.stringify([agentId, scopeKey, eventKey]), fact);
    const conversationKey = qqConversationKey({
      accountId: scope.accountId,
      kind: scope.conversationKind,
      peerId: scope.peerId,
    });
    for (const { id, source } of items) {
      const matchesForEvent = byEvent.get(source.eventKey) ?? [];
      const event = events.get(source.eventKey);
      if (
        source.conversationKey !== conversationKey ||
        matchesForEvent.length !== 1 ||
        matchesForEvent[0] !== scope.conversationId ||
        !event ||
        event.accountId !== scope.accountId ||
        event.conversationKind !== scope.conversationKind ||
        event.peerId !== scope.peerId ||
        event.agentId !== scope.agentId ||
        event.messageId !== source.messageId ||
        event.occurredAtSeconds !== source.occurredAtSeconds ||
        event.speakerKind !== source.speakerKind ||
        event.speakerId !== source.speakerId
      ) {
        invalid.add(id);
        continue;
      }
      const fact = projected.get(source.eventKey);
      let refs: SourceRef[];
      if (fact && fact.completeness !== "unavailable") refs = [...fact.sources];
      else if (
        !fact &&
        event.factExpiresAt === null &&
        event.body !== null &&
        event.bodyExpiresAt !== null &&
        !isObservationExpired(event.bodyExpiresAt, input.now)
      ) {
        refs = [
          {
            kind: "qq_observation",
            id: source.eventKey,
            revision: bodyRevision(event.body),
            expiresAt: event.bodyExpiresAt,
          },
        ];
      } else {
        invalid.add(id);
        continue;
      }
      proof
        .get(id)!
        .push([
          "qq",
          source.eventKey,
          source.scopeKey,
          source.conversationKey,
          source.messageId,
          source.occurredAtSeconds,
          source.speakerKind,
          source.speakerId,
          scope,
          refs.map((ref) => [ref.kind, ref.id, ref.revision, ref.expiresAt ?? null]),
        ]);
    }
  }
  for (const id of invalid) proof.delete(id);
  return { proof, facts };
}

export function qqEntryPublicationSourcesBatch(
  input: QqPublicationBatchInput,
): ReadonlyMap<string, unknown[]> {
  return collectQqEntryPublicationSources(input).proof;
}

export interface SuppressionSourceContext {
  readonly speaker: string | null;
  readonly sourceIds: readonly string[];
  readonly records: readonly Record<string, unknown>[];
  readonly ref: SourceRef;
}

/** Current job source scope, frozen binding authority and route, without granting preview. */
export function qqBlockedJobScope(
  store: EvidenceStore,
  jobId: string,
  agentId: string,
): { scope: QqMemoryFactScope; sourceKey: string } | null {
  const job = snapshotOf(store.db, jobId);
  if (!job || job.job.agent_id !== agentId) return null;
  const sourceKey = memoryJobScopes(
    job.parsed as { scope_key?: string; qq_route?: QqMemoryRouteSnapshot },
  ).source;
  if (typeof sourceKey !== "string") return null;
  const scope = resolveQqMemoryFactScope(store.db, agentId, jobId, sourceKey);
  if (!scope || !evidenceScopeExists(store.db, { channel: "onebot11", ...scope })) return null;
  const frozen = job.parsed.qq_fact_scope;
  if (!isQqMemoryFactScope(frozen) || !sameScope(scope, frozen)) return null;
  const route = job.parsed.qq_route;
  if (route) {
    const binding = readQqBinding(store.orm, scope.bindingId);
    if (
      !binding ||
      route.binding_id !== scope.bindingId ||
      route.authority_revision !== scope.authorityRevision ||
      binding.ownerIdentityRevision !== route.owner_identity_revision
    )
      return null;
    const access = resolveQqMemoryAccess(binding, readQqOwnerIdentity(store.orm));
    if (
      access.kind !== "resolved" ||
      qqMemoryScopeKey(access.access.writeScope) !== route.destination_scope_key
    )
      return null;
  }
  return { scope, sourceKey };
}

/** Current job may inspect only actual blocked entries backed wholly by its own QQ scope. */
export function qqSuppressionContexts(
  store: EvidenceStore,
  jobId: string,
  agentId: string,
  entryIds: readonly string[],
  now: string,
): ReadonlyMap<string, SuppressionSourceContext> {
  const result = new Map<string, SuppressionSourceContext>();
  if (!entryIds.length) return result;
  const jobScope = qqBlockedJobScope(store, jobId, agentId);
  if (!jobScope) return result;
  const { scope, sourceKey } = jobScope;
  const candidates = store.db
    .query(`SELECT m.id,m.name,m.summary,m.tags,m.config_snapshot AS configSnapshot,m.body,m.status,
      q.event_key AS eventKey,q.scope_key AS scopeKey,q.conversation_key AS conversationKey,
      q.message_id AS messageId,q.occurred_at_seconds AS occurredAtSeconds,q.speaker_kind AS speakerKind,q.speaker_id AS speakerId
    FROM memory_entries m JOIN qq_memory_sources q ON q.memory_id=m.id
    WHERE m.user_id=? AND m.agent_id=? AND m.status<>'invalid'
      AND m.id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM memory_sources w WHERE w.memory_id=m.id)
      AND NOT EXISTS (SELECT 1 FROM qq_memory_sources x WHERE x.memory_id=m.id AND x.scope_key<>?)
    ORDER BY m.id,q.event_key`)
    .all(DEFAULT_USER_ID, agentId, JSON.stringify([...new Set(entryIds)]), sourceKey) as Array<{
    id: string;
    name: string;
    summary: string;
    tags: string;
    configSnapshot: string;
    body: string;
    status: string;
    eventKey: string;
    scopeKey: string;
    conversationKey: string;
    messageId: string;
    occurredAtSeconds: number;
    speakerKind: string;
    speakerId: string | null;
  }>;
  const grouped = new Map<string, typeof candidates>();
  for (const row of candidates) {
    const list = grouped.get(row.id) ?? [];
    list.push(row);
    grouped.set(row.id, list);
  }
  const entries = [...grouped].map(([id, rows]) => ({ id, agentId, sources: rows }));
  const collected = collectQqEntryPublicationSources({
    db: store.db,
    orm: store.orm,
    entries,
    now,
  });
  const proof = collected.proof;
  const valid = [...grouped].filter(
    ([id, rows]) =>
      proof.has(id) &&
      rows.length > 0 &&
      rows.every((row) => row.scopeKey === sourceKey) &&
      (rows[0]!.status === "suppressed" ||
        rows[0]!.status === "replaced" ||
        !!correctionMetadata(rows[0]!.configSnapshot)?.rejected.length),
  );
  if (!valid.length) return result;
  const known = valid.filter(
    ([, rows]) =>
      rows[0]!.speakerId !== null &&
      rows.every((row) => row.speakerKind === "member" && row.speakerId === rows[0]!.speakerId),
  );
  const allIds = [...new Set(known.flatMap(([, rows]) => rows.map((row) => row.eventKey)))];
  const facts = allIds.flatMap((id) => {
    const fact = collected.facts.get(JSON.stringify([agentId, sourceKey, id]));
    return fact && fact.completeness !== "unavailable" ? [fact] : [];
  });
  const factRefs = facts.map((fact) => fact.sources.find((ref) => ref.kind === "qq_message_fact"));
  const present = factRefs.filter((ref): ref is SourceRef => ref !== undefined);
  const verdicts = qqMessageFactSourceAccessMany(
    store.db,
    present,
    resolveQqMemoryFactOwner(scope),
    { userId: DEFAULT_USER_ID },
    now,
  );
  const allowed = new Set(
    present.filter((_, index) => verdicts[index] === "available").map((ref) => ref.id),
  );
  const factsById = new Map(
    facts.filter((fact) => allowed.has(fact.id)).map((fact) => [fact.id, fact]),
  );
  const projected = projectQqTextRelations({ facts: [...factsById.values()], scope, now });
  const records = new Map(
    projected.records.flatMap((record) => {
      const parts = record.parts;
      if (
        !Array.isArray(parts) ||
        !parts.length ||
        parts.some(
          (part) =>
            part === null ||
            typeof part !== "object" ||
            (part as { kind?: unknown }).kind !== "text",
        )
      )
        return [];
      return [
        [
          String(record.id),
          { id: record.id, occurredAtSeconds: record.occurredAtSeconds, parts },
        ] as const,
      ];
    }),
  );
  for (const [id, rows] of valid) {
    const sourceIds = rows.map((row) => row.eventKey);
    const possibleRecords = sourceIds.map((key) => records.get(key));
    const isKnown =
      rows[0]!.speakerId !== null &&
      rows.every((row) => row.speakerKind === "member" && row.speakerId === rows[0]!.speakerId) &&
      possibleRecords.every((record) => record !== undefined);
    const ownRecords = isKnown ? (possibleRecords as Record<string, unknown>[]) : [];
    const proofParts = proof.get(id)!;
    const expiries = proofParts.flatMap((part) => {
      if (!Array.isArray(part) || !Array.isArray(part[9])) return [];
      return part[9].flatMap((ref: unknown) =>
        Array.isArray(ref) && typeof ref[3] === "string" ? [ref[3]] : [],
      );
    });
    const expiresAt = expiries.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    const revision = createHash("sha256")
      .update(JSON.stringify([jobId, id, memoryRevision(rows[0]!), scope, proofParts, ownRecords]))
      .digest("hex");
    result.set(id, {
      speaker: isKnown ? rows[0]!.speakerId : null,
      sourceIds,
      records: ownRecords,
      ref: {
        kind: "memory_suppression_context",
        id: JSON.stringify([jobId, id]),
        revision,
        ...(expiresAt ? { expiresAt } : {}),
      },
    });
  }
  return result;
}

/** Recompute grouped context proof; a ref never grants source access. */
export function qqSuppressionContextStates(
  store: EvidenceStore,
  sources: readonly SourceRef[],
  owner: RunOwner,
  principal: { userId: string },
  now: string,
): SourceAccess[] {
  const result: SourceAccess[] = sources.map(() => "revoked");
  if (
    owner.kind !== "memory_job" ||
    owner.userId !== principal.userId ||
    principal.userId !== DEFAULT_USER_ID ||
    !owner.agentId
  )
    return result;
  const parsed = sources.map((source) => {
    try {
      const value = JSON.parse(source.id);
      return Array.isArray(value) &&
        value.length === 2 &&
        value[0] === owner.id &&
        typeof value[1] === "string"
        ? (value[1] as string)
        : null;
    } catch {
      return null;
    }
  });
  const contexts = qqSuppressionContexts(
    store,
    owner.id,
    owner.agentId,
    parsed.filter((id): id is string => id !== null),
    now,
  );
  for (const [index, id] of parsed.entries()) {
    const current = id === null ? undefined : contexts.get(id);
    const source = sources[index]!;
    if (current && current.ref.id === source.id && current.ref.revision === source.revision) {
      const cap = source.expiresAt;
      const currentCap = current.ref.expiresAt;
      if (cap !== undefined && !Number.isFinite(Date.parse(cap))) continue;
      if (currentCap && (!cap || Date.parse(cap) > Date.parse(currentCap))) continue;
      result[index] =
        cap !== undefined && Date.parse(cap) <= Date.parse(now) ? "expired" : "available";
    }
  }
  return result;
}

/** image 片段只作存在/unknown 标记：不透传任何非 unknown 分类，不 join 模型分类/OCR/note。 */
function restyleRecord(record: Record<string, unknown>): void {
  const parts = record.parts;
  if (Array.isArray(parts)) {
    record.parts = parts.map((part) =>
      part !== null && typeof part === "object" && (part as { kind?: unknown }).kind === "image"
        ? { ...(part as Record<string, unknown>), category: "unknown" }
        : part,
    );
  }
}

function dedupe(refs: SourceRef[]): SourceRef[] {
  const map = new Map<string, SourceRef>();
  for (const ref of refs) {
    const key = JSON.stringify([ref.kind, ref.id, ref.revision]);
    const old = map.get(key);
    const keepOld =
      !!old?.expiresAt && (!ref.expiresAt || Date.parse(old.expiresAt) < Date.parse(ref.expiresAt));
    map.set(key, keepOld ? old : ref);
  }
  return [...map.values()];
}

/**
 * load 每个 selected event（在 loadInputs 的同一 immediate 内调用）：
 * 真 live full facts → projectQqTextRelations；存在但 expired/unavailable 的 facts 不回裸
 * body（不可用状态记录、不产 ref）；SQL 真无 facts 行且 body 仍活才 legacy（沿旧形状，
 * 明确不编名字）；全部无可整理 → MEMORY_SOURCE_INVALID。
 * 产出当前值 refs（只含实际消费的）+ 可选 name refs + 记录。
 */
export function loadQqFactInputs(input: {
  store: EvidenceStore;
  scope: QqMemoryFactScope;
  scopeKey: string;
  eventKeys: readonly string[];
  now: string;
  important: ReadonlySet<string>;
}): QqPublication {
  const { store, scope, now, important } = input;
  const eventKeys = [...new Set(input.eventKeys)];
  if (eventKeys.length === 0) fail("MEMORY_SOURCE_INVALID", "观察任务没有可整理来源");
  if (!evidenceScopeExists(store.db, { channel: "onebot11", ...scope })) {
    fail("MEMORY_SOURCE_INVALID", "观察来源不属于本会话的记忆范围");
  }
  // legacy 路径（真无 facts 行）需要 journal timeline 复验：事件必须真实在本会话里
  // （既有 inTimeline，T03a 复用，不建第二宽读路径）。
  const timeline = (eventKey: string): boolean =>
    inTimeline(store.db, { channel: "onebot11", ...scope }, "qq_event", eventKey);
  const rows = loadRows(store.db, eventKeys);
  for (const eventKey of eventKeys) {
    if (!rows.has(eventKey)) fail("MEMORY_SOURCE_INVALID", "观察来源不存在或已被清理");
  }
  const projected = projectQqMessageFacts(store, scope, eventKeys, now);
  const byKey = new Map(projected.map((fact) => [fact.id, fact]));
  // currentName 候选只从真实 speaker/mention 的 QQ mint（模型自造/别成员不进候选面）。
  const nameRefs: SourceRef[] = [];
  const nameValues = new Map<
    string,
    { groupCard: string | null; personalNickname: string | null }
  >();
  for (const fact of projected) {
    if (fact.completeness === "unavailable") continue;
    const qqs = new Set<string>();
    if (fact.speaker.role === "member" && fact.speaker.qq) qqs.add(fact.speaker.qq);
    for (const mention of fact.mentions) {
      if (mention.identity?.role === "member" && mention.identity.qq) qqs.add(mention.identity.qq);
    }
    for (const qq of qqs) {
      const minted = createQqMemberNameSource(store, scope, qq, now);
      if (minted) {
        nameRefs.push(minted.source);
        nameValues.set(qq, minted.currentName);
      }
    }
  }
  const factRefs: SourceRef[] = [];
  const records: QqMemoryFactRecord[] = [];
  for (const eventKey of eventKeys) {
    const row = rows.get(eventKey);
    if (!row) fail("MEMORY_SOURCE_INVALID", "观察来源不存在或已被清理");
    const fact = byKey.get(eventKey);
    if (fact) {
      // 事实快照存在但正文失效/不一致：不可回裸 body，也不能算已消费 → 整任务拒
      // （publish 的 qq_memory_sources 按原 selected-event 契约写全部事件，若允许部分
      // 消费继续，就会把未消费消息当证据；保守方案与既有"每个 selected 都必须可读"一致）。
      if (fact.completeness === "unavailable") {
        fail("MEMORY_SOURCE_INVALID", "观察事实不可读，不能整理为长期记忆");
      }
      const relations = projectQqTextRelations({ facts: [fact], scope, now });
      const record = relations.records[0];
      if (!record) {
        fail("MEMORY_SOURCE_INVALID", "观察事实已过期，不能整理为长期记忆");
      }
      // currentName 只在 mint 值与投影值吻合（ref.id↔identity.qq↔value）时保留，
      // 否则只把 currentName 置空，快照/正文/关系原样。
      const qq = fact.speaker.role === "member" ? fact.speaker.qq : null;
      const minted = qq === null ? undefined : nameValues.get(qq);
      const verified =
        minted !== undefined &&
        fact.speaker.currentName !== undefined &&
        minted.groupCard === fact.speaker.currentName.groupCard &&
        minted.personalNickname === fact.speaker.currentName.personalNickname;
      if (!verified) record.currentName = null;
      restyleRecord(record);
      if (qq !== null && important.has(qq)) record.important = true;
      records.push({ eventKey, record });
      factRefs.push(...relations.sources);
      continue;
    }
    if (row.factExpiresAt === null) {
      // SQL 真无 facts 行：只有 body 仍活且事件真在本会话 timeline 里才 legacy
      // （沿旧形状，明确不编名字）。
      const bodyLive =
        row.body !== null &&
        row.bodyExpiresAt !== null &&
        !isObservationExpired(row.bodyExpiresAt, now);
      if (!bodyLive || !timeline(eventKey)) {
        fail("MEMORY_SOURCE_INVALID", "观察正文已过期或缺失，不能整理为长期记忆");
      }
      const legacy: Record<string, unknown> = {
        id: eventKey,
        message_id: row.messageId,
        speaker_kind: row.speakerKind,
        speaker_id: row.speakerId,
        occurred_at_seconds: row.occurredAtSeconds,
        completeness: "legacy_partial",
        body: row.body,
      };
      if (row.speakerId !== null && important.has(row.speakerId)) legacy.important = true;
      records.push({ eventKey, record: legacy });
      factRefs.push({
        kind: "qq_observation",
        id: eventKey,
        revision: bodyRevision(row.body!),
        expiresAt: row.bodyExpiresAt!,
      });
      continue;
    }
    // facts 行存在但投影未产出（过期/时间线/一致性 fail closed）：不回裸 body、不产 ref；
    // 该来源不可消费 → 整任务拒绝（不把未消费消息带进 publication provenance）。
    fail("MEMORY_SOURCE_INVALID", "观察来源不可读，不能整理为长期记忆");
  }
  return {
    scopeKey: input.scopeKey,
    scope,
    factRefs: dedupe(factRefs),
    nameRefs: dedupe(nameRefs),
    records,
  };
}

/**
 * 现值与冻结 8 字段 scope 逐项比对 + 每个 fact/body ref 走既有 access 复算（含 ref 自己的
 * in-flight 到期帽）。任一不符 → MEMORY_STATE_CONFLICT。name refs 不参与本门。
 */
export function verifyQqFactInputs(input: {
  db: Database;
  agentId: string;
  jobId: string;
  frozen: QqPublication;
  now: string;
}): void {
  const { db, agentId, jobId, frozen, now } = input;
  const scope = resolveQqMemoryFactScope(db, agentId, jobId, frozen.scopeKey);
  if (!scope || !sameScope(scope, frozen.scope)) {
    fail("MEMORY_STATE_CONFLICT", "来源作用域已变化，旧整理结果不发布");
  }
  const owner = resolveQqMemoryFactOwner(scope);
  for (const ref of frozen.factRefs) {
    if (ref.expiresAt !== undefined && Date.parse(ref.expiresAt) <= Date.parse(now)) {
      fail("MEMORY_STATE_CONFLICT", "来源在整理期间到期，旧整理结果不发布");
    }
    const access: SourceAccess =
      ref.kind === "qq_message_fact"
        ? (qqMessageFactSourceAccess(db, ref, owner, { userId: DEFAULT_USER_ID }, now) ?? "revoked")
        : ref.kind === "qq_observation"
          ? qqObservationLive(db, ref, owner, now)
          : "revoked";
    if (access !== "available") {
      fail("MEMORY_STATE_CONFLICT", "来源在整理期间失效，旧整理结果不发布");
    }
  }
}

/** qq_observation 的既有同式只读复验（agent 匹配 + body 活 + sha 一致），不建宽读路径。 */
function qqObservationLive(
  db: Database,
  ref: SourceRef,
  owner: RunOwner,
  now: string,
): SourceAccess {
  const row = db
    .query(`SELECT e.agent_id,t.body,t.expires_at FROM qq_events e
    LEFT JOIN qq_observation_text t ON t.event_key=e.event_key WHERE e.event_key=?`)
    .get(ref.id) as { agent_id: string; body: string | null; expires_at: string | null } | null;
  if (!row || row.agent_id !== owner.agentId) return "revoked";
  if (!row.expires_at || Date.parse(row.expires_at) <= Date.parse(now)) return "expired";
  return row.body !== null && bodyRevision(row.body) === ref.revision ? "available" : "revoked";
}

/**
 * 运行期来源列表的 name 修剪：失效的 `qq_member_name` ref 不再随后续调用出示（name 失效
 * 剪 name 不整 body）。memory_job owner 之外原样返回。
 */
export function filterLiveNameSources(
  db: Database,
  owner: RunOwner,
  sources: readonly SourceRef[],
  now: string,
): SourceRef[] {
  if (owner.kind !== "memory_job") return [...sources];
  return sources.filter(
    (source) =>
      source.kind !== "qq_member_name" ||
      qqMemoryJobSourceAccess(db, source, owner, now) === "available",
  );
}
