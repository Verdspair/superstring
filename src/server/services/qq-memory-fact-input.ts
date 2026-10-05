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
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import { bodyRevision } from "../db/conversation-event-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import { fail } from "../errors";
import { evidenceScopeExists } from "../modules/conversation-evidence";
import type { EvidenceStore } from "../modules/conversation-evidence-store";
import { inTimeline } from "../modules/conversation-evidence-store";
import { ownerScope } from "./qq-media-sources";
import { createQqMemberNameSource, qqMemberNameSourceAccess } from "./qq-member-sources";
import { projectQqMessageFacts } from "./qq-message-fact-projection";
import { qqMessageFactSourceAccess } from "./qq-message-fact-sources";
import { isObservationExpired } from "./qq-retention";
import { projectQqTextRelations } from "./qq-text-relations";

type SourceAccess = "available" | "expired" | "revoked";

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
  if (typeof parsed.scope_key !== "string") return "revoked";
  const scope = resolveQqMemoryFactScope(db, job.agent_id, owner.id, parsed.scope_key);
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
    `SELECT e.event_key AS eventKey,t.body AS body,t.expires_at AS bodyExpiresAt,
    f.expires_at AS factExpiresAt,e.message_id AS messageId,
    e.occurred_at_seconds AS occurredAtSeconds,e.speaker_kind AS speakerKind,
    e.speaker_id AS speakerId
    FROM qq_events e LEFT JOIN qq_message_facts f ON f.event_key=e.event_key
    LEFT JOIN qq_observation_text t ON t.event_key=e.event_key
    WHERE e.event_key=?`,
  );
  for (const eventKey of eventKeys) {
    const row = statement.get(eventKey) as LoadRow | null;
    if (row) rows.set(eventKey, row);
  }
  return rows;
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
