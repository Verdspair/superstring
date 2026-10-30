// Durable memory worker
// Source invariant, quoted from its module docstring: "Model calls never hold a
// transaction or publish directly." Everything below is arranged to keep that
// true:
// * `claim` takes the job in a short transaction and hands back a token.
// * `loadInputs` reads sources in a short transaction and returns plain data.
// * `generate` performs model calls **outside** any transaction.
// * `publish` re-validates ownership and writes in one short transaction.
// A lease + per-beat ownership re-check is what makes concurrent workers safe:
// a job whose lease lapsed, whose token changed or whose `governance_epoch`
// moved can never publish, no matter how long the model took.

import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { SourceRef } from "../../shared/contracts/evidence";
import { createAgentRuntime, type LeafAgentRuntime } from "../agent/agent-runtime";
import type { RetryOrigin } from "../agent/built-in-actions";
import type { ModelContextBudget } from "../agent/model-port";
import { AgentRunRepository } from "../db/agent-run-repository";
import {
  assertQqConsolidationPublishable,
  assertQqRouteCurrent,
  claim,
  enqueue,
  entries,
  jobOwned,
  type MemoryDraft,
  ownedRunning,
  policy,
  publish,
  renewLease,
  sourceData,
  turns,
  updateJobRow,
  validateEntrySources,
} from "../db/memory-repository";
import {
  blockedMemorySourceRefs,
  blockedMemorySourceStates,
  loadSessionIntegrity,
  loadTurnIntegrity,
  mergeJobSourceSet,
  observationSources,
  ownedObservations,
  type QqEventRow,
} from "../db/memory-source-repository";
import { readBindingByConversation } from "../db/qq-binding-repository";
import { DEFAULT_USER_ID, immediate, nowIso, type Orm } from "../db/repositories";
import * as schema from "../db/schema";
import { AppError, fail } from "../errors";
import type { ModelGateway } from "../llm/model-gateway";
import {
  measureContextTokens,
  measurePreparedRequest,
  type PreparedRequestFormat,
} from "../llm/request-format";
import { estimateMessages } from "../modules/memory-query";
import { memoryEntrySources, turnSources } from "../modules/provenance";
import type { RuntimeTelemetry, TraceScope } from "../observability/runtime-telemetry";
import { QqGroupCapabilityGuard } from "../permissions/qq-group-capabilities";
import { estimateTokens } from "../services/token-estimate";
import {
  buildConsolidationPrompt,
  type ConsolidationConfig,
  canonical,
  codePointLength,
  DRAFT_RESULT_JSON_SCHEMA,
  MAX_SOURCE_CHARS,
  memoryJobScopes,
  type PromptMessage,
  parseResult,
  resolveAuxAllocation,
  SUPPRESSION_RESULT_JSON_SCHEMA,
  SuppressionResultSchema,
  stringifyJsonSpaced,
  suppressionPrompt,
} from "./memory-contract";
import { correctionMetadata } from "./memory-revision";
import {
  filterLiveNameSources,
  freezeQqFactScope,
  loadQqFactInputs,
  type QqPublication,
  qqSuppressionContextStates,
  qqSuppressionContexts,
  verifyQqFactInputs,
} from "./qq-memory-fact-input";

/**
 * Marker for "the caller asked us to stop". The contract signals this with
 * a cancellation exception; JS has no such exception, so a unique
 * sentinel carries the same meaning through one `catch`.
 */
const WORKER_STOPPED = Symbol("superstring.memory-worker-stopped");

export interface MemoryServiceOptions {
  orm: Orm;
  /** The raw handle, needed for the explicit `BEGIN IMMEDIATE` transactions. */
  db: Database;
  gateway: ModelGateway;
  agentRuntime?: LeafAgentRuntime;
  telemetry?: RuntimeTelemetry;
  /** How long an idle cycle waits before the next poll. */
  pollIntervalMs?: number;
  /** How often the heartbeat renews the lease. */
  heartbeatIntervalMs?: number;
  /**
   * The whole-job wall clock budget.
   * Set to one hour (recorded in ADR0016): this
   * budget has to outlive a single model call, and one call on a local model can
   * legitimately take many minutes. A 600s job budget equal to the per-request
   * budget meant a slow-but-healthy job was killed by the job timer instead of
   * finishing, or failed with the less specific MEMORY_TIMEOUT.
   */
  jobTimeoutMs?: number | (() => number);
  enabled?: () => boolean;
}

export interface MemoryInputs {
  kind: string;
  config: ConsolidationConfig;
  sources: Array<Record<string, unknown>>;
  blocked: Array<Record<string, unknown>>;
  sourceRefs: SourceRef[];
  blockedRefs: SourceRef[][];
  blockedRejected?: boolean[];
  candidateSpeaker?: string;
  blockedContexts?: Array<{
    speaker: string;
    sourceIds: readonly string[];
    records: readonly Record<string, unknown>[];
  } | null>;
  /**
   * QQ 事实输入的冻结快照（load↔publish 内存传递 + 写进 job.configSnapshot.qq_fact_scope）。
   * merge/Web 任务无此字段，publication 复验按无操作处理。
   */
  publication?: QqPublication;
  /** 按任务快照 scope_key 形态派生的叶子来源，在 loadInputs 冻结并随任务传递。 */
  retryOrigin: RetryOrigin;
}

export class MemoryService {
  private readonly orm: Orm;
  private readonly db: Database;
  private readonly agentRuntime: LeafAgentRuntime;
  private readonly gateway: Pick<ModelGateway, "loadedContextCapacity"> &
    Partial<Pick<ModelGateway, "prepareContextModel" | "prepareRequestFormat">>;
  private readonly telemetry?: RuntimeTelemetry;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly jobTimeoutMs: number | (() => number);
  private readonly enabled: () => boolean;

  private loopPromise: Promise<void> | null = null;
  private stopped = false;
  private sleepResolve: (() => void) | null = null;
  private cancelCurrentJob: (() => void) | null = null;

  constructor(options: MemoryServiceOptions) {
    this.telemetry = options.telemetry;
    this.orm = options.orm;
    this.db = options.db;
    this.gateway = options.gateway;
    this.agentRuntime =
      options.agentRuntime ??
      createAgentRuntime({
        gateway: options.gateway,
        repository: new AgentRunRepository(options.db),
      });
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 3_600_000;
    this.enabled = options.enabled ?? (() => true);
  }

  /** `MemoryService.start`. */
  start(): void {
    if (this.loopPromise !== null) return;
    this.stopped = false;
    this.loopPromise = this.loop();
  }

  /**
   * `MemoryService.stop`.
   * The contract cancels the runner task; here the same effect is produced by
   * flagging the loop, releasing any in-flight poll sleep, and letting the
   * job-level race observe the cancel so the job is recorded as
   * `MEMORY_WORKER_STOPPED` instead of being left `running` until its lease
   * expires.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.sleepResolve?.();
    this.cancelCurrentJob?.();
    await this.loopPromise;
    this.loopPromise = null;
  }

  /** `loop`. */
  private async loop(): Promise<void> {
    while (!this.stopped) {
      let ranJob = false;
      try {
        ranJob = await this.runCycle();
      } catch {
        // Source: `logger.warning("memory worker cycle failed; retrying next check")`.
        // The message is deliberately fixed — never log source text, response
        // body, connection strings or an exception repr.
        console.warn("memory worker cycle failed; retrying next check");
      }
      if (this.stopped) return;
      // Source uses `continue` after a job so the queue drains without delay.
      if (ranJob) continue;
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * One pass of the loop body, minus the trailing sleep. Split out so tests can
   * drive the worker deterministically instead of racing a timer.
   * Returns `true` when a job was run.
   */
  async runCycle(): Promise<boolean> {
    if (!this.enabled()) return false;
    this.recoverExpired();
    this.scheduleAuto();
    const jobId = this.nextQueuedJobId();
    if (jobId === null) return false;
    await this.runJob(jobId);
    return true;
  }

  /**
   * `recover_expired`.
   * A `running` job whose lease has lapsed belongs to a worker that died
   * mid-flight. It is failed as `MEMORY_WORKER_INTERRUPTED` so the interval it
   * covered can be retried, and its token is cleared so a zombie holder cannot
   * publish. Note the SQL comparison mirrors the contract exactly: rows with a
   * `NULL` lease are never selected, because `NULL <= x` is `NULL`.
   */
  recoverExpired(): void {
    const expired = this.orm
      .select({ id: schema.memoryJobs.id, agentId: schema.memoryJobs.agentId })
      .from(schema.memoryJobs)
      .where(
        and(
          eq(schema.memoryJobs.status, "running"),
          lte(schema.memoryJobs.leaseExpiresAt, nowIso()),
        ),
      )
      .all();

    for (const row of expired) {
      immediate(this.db, () => {
        policy(this.orm, row.agentId);
        const job = jobOwned(this.orm, row.agentId, row.id);
        // The outer query already guarantees a non-null lease; the explicit
        // check replaces the contract's implicit "it is a datetime here".
        if (
          job.status === "running" &&
          job.leaseExpiresAt !== null &&
          job.leaseExpiresAt <= nowIso()
        ) {
          updateJobRow(this.orm, job.id, {
            status: "failed",
            errorCode: "MEMORY_WORKER_INTERRUPTED",
            token: null,
            leaseExpiresAt: null,
            finishedAt: nowIso(),
          });
          this.telemetry?.record("memory.recover", {
            channel: "memory",
            stage: "maintenance",
            status: "failed",
            code: "MEMORY_WORKER_INTERRUPTED",
            agentId: row.agentId,
            details: { jobId: row.id },
          });
        }
      });
    }
  }

  /**
   * `schedule_auto`.
   * For every session whose Agent has automatic consolidation on, queue work
   * once `every_turns` *unprocessed* valid turns exist.
   * The failure filter is the subtle part, and the reasoning states the
   * rule: "Governance/source changes invalidate old work, not future
   * scheduling. A model failure pauses only its still-unprocessed interval."
   * So a previous `auto` failure blocks rescheduling **only** while it overlaps
   * the turns we are about to submit AND was recorded under the current
   * `governance_epoch`. A model failure therefore does not wedge the Agent
   * forever — the next interval proceeds — while a governance change frees the
   * interval for a clean retry.
   * `AppError` per session is swallowed (the contract rolls back and moves on);
   * anything else propagates to the loop's generic handler.
   *
   * `sessionId` narrows the same query to one session — the completed-turn path uses it so a
   * single turn does not re-walk every session. Without it the pass stays the periodic
   * restore of all auto-enabled sessions, in the same (oldest session first) order.
   */
  scheduleAuto(sessionId?: string): void {
    const sessions = this.orm
      .select({ id: schema.sessions.id, agentId: schema.sessions.agentId })
      .from(schema.sessions)
      .innerJoin(schema.memoryPolicies, eq(schema.memoryPolicies.agentId, schema.sessions.agentId))
      .innerJoin(schema.agents, eq(schema.agents.id, schema.sessions.agentId))
      .where(
        and(
          eq(schema.memoryPolicies.autoEnabled, 1),
          eq(schema.agents.isActive, 1),
          eq(schema.sessions.userId, DEFAULT_USER_ID),
          eq(schema.memoryPolicies.userId, DEFAULT_USER_ID),
          // 定向就限定这一条会话；查不到即空集，绝不回退成全量扫描。
          ...(sessionId === undefined ? [] : [eq(schema.sessions.id, sessionId)]),
        ),
      )
      .orderBy(asc(schema.sessions.createdAt), asc(schema.sessions.id))
      .all();

    for (const session of sessions) {
      try {
        immediate(this.db, () => {
          const p = policy(this.orm, session.agentId);
          const busy = this.orm
            .select({ id: schema.memoryJobs.id })
            .from(schema.memoryJobs)
            .where(
              and(
                eq(schema.memoryJobs.agentId, session.agentId),
                inArray(schema.memoryJobs.status, ["queued", "running"]),
              ),
            )
            .limit(1)
            .get();
          if (p.autoEnabled !== 1 || busy) return;

          // 阈值只需要最老的 everyTurns 条；不再把全部未处理正文读进内存。
          const rows = turns(this.orm, session.agentId, session.id, {
            unprocessed: true,
            limit: p.everyTurns,
          });
          if (rows.length < p.everyTurns) return;
          const selected = rows.slice(0, p.everyTurns);
          const pendingIds = new Set(selected.map((r) => r.turn.id));

          const failures = this.orm
            .select()
            .from(schema.memoryJobs)
            .where(
              and(
                eq(schema.memoryJobs.sessionId, session.id),
                eq(schema.memoryJobs.kind, "auto"),
                eq(schema.memoryJobs.status, "failed"),
              ),
            )
            .all();
          const overlapsPending = failures.some((job) => {
            const jobTurnIds = JSON.parse(job.turnIds) as string[];
            return (
              jobTurnIds.some((id) => pendingIds.has(id)) &&
              job.governanceEpoch === p.governanceEpoch
            );
          });
          if (overlapsPending) return;

          enqueue(this.orm, session.agentId, `auto_${crypto.randomUUID().replace(/-/g, "")}`, {
            kind: "auto",
            sessionId: session.id,
            turnIds: selected.map((r) => r.turn.id),
          });
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
  }

  /** The oldest queued job. */ private nextQueuedJobId(): string | null {
    const row = this.orm
      .select({ id: schema.memoryJobs.id })
      .from(schema.memoryJobs)
      .where(eq(schema.memoryJobs.status, "queued"))
      .orderBy(asc(schema.memoryJobs.createdAt), asc(schema.memoryJobs.id))
      .limit(1)
      .get();
    return row?.id ?? null;
  }

  /**
   * `load_inputs`.
   * For a `merge` job the sources are the selected memory entries (re-validated
   * because a merge can be queued long before it runs) and every source must
   * still be `active`. For any other kind they are the job's turns.
   * `blocked` is every suppressed/replaced entry, which the suppression pass
   * compares the candidate against. The size guard runs *after* the read
   * transaction closes and rejects the job rather than truncating the input
   * the reasoning for the chunked suppression call says the same thing:
   * never silently truncate.
   */
  loadInputs(agentId: string, jobId: string, token: string): MemoryInputs {
    const loaded = immediate(this.db, () => {
      const job = ownedRunning(this.orm, agentId, jobId, token);
      assertQqRouteCurrent(this.orm, agentId, job.configSnapshot);
      const config = JSON.parse(job.configSnapshot) as ConsolidationConfig;
      const snapshot = JSON.parse(job.configSnapshot) as ConsolidationConfig & {
        source_event_ids?: string[];
      };
      const scopes = memoryJobScopes(snapshot);
      // 来源按任务快照里 scope_key 的真实形态判定（网页键＝纯 agentId；QQ 键＝
      // qqMemoryScopeKey 的 ["qq",accountId,kind,peerId,agentId] JSON，QQ 事实任务与
      // 网页手动整理 QQ 分区的任务都带这种键）：QQ 形态 → qq，网页会话/普通任务 → system。
      const retryOrigin: RetryOrigin = (() => {
        try {
          const parsed: unknown = JSON.parse(scopes.source ?? "");
          return Array.isArray(parsed) && parsed[0] === "qq" ? "qq" : "system";
        } catch {
          return "system";
        }
      })();
      // QQ 观察任务的输入加载复验本群能力：停用后不得再把来源正文交给模型
      // （不花这次调用；重试入队的任务同样在这里被拒）。
      assertQqConsolidationPublishable(this.orm, jobId, agentId, scopes.source);
      // A job only ever sees the scope it writes into. Without this, a suppressed
      // memory's body from one group would be handed to the model while organising
      // another group — a cross-scope content leak, not just a governance detail.
      const scopeKeys = scopes.source === undefined ? undefined : [scopes.source];
      let sources: Array<Record<string, unknown>>;
      let sourceRefs: SourceRef[];
      let publication: QqPublication | undefined;
      let candidateSpeaker: string | undefined;
      if (job.kind === "merge") {
        const selected = entries(this.orm, agentId, JSON.parse(job.memoryIds) as string[], {
          scopeKeys,
        });
        if (selected.some((item) => item.status !== "active")) {
          fail("MEMORY_STATE_CONFLICT", "来源记忆已变化");
        }
        const webSources = validateEntrySources(this.orm, selected);
        sourceRefs = memoryEntrySources(this.orm, selected);
        const turnRows = loadTurnIntegrity(
          this.orm,
          webSources.map((source) => source.turnId),
        );
        const sessionRows = loadSessionIntegrity(
          this.orm,
          [...turnRows.values()].map((turn) => turn.sessionId),
        );
        const qqSources = observationSources(
          this.orm,
          selected.map((entry) => entry.id),
        );
        const messageIds = [
          ...new Set(
            webSources.flatMap((source) => [source.userMessageId, source.assistantMessageId]),
          ),
        ];
        const messageRows = this.db
          .query(
            "SELECT id,role,created_at FROM messages WHERE id IN (SELECT value FROM json_each(?))",
          )
          .all(JSON.stringify(messageIds)) as { id: string; role: string; created_at: string }[];
        const messageById = new Map(messageRows.map((row) => [row.id, row]));
        sources = selected.map((entry) => ({
          name: entry.name,
          summary: entry.summary,
          body: entry.body,
          tags: JSON.parse(entry.tags),
          kinds: JSON.parse(entry.kinds),
          source_context: {
            web: webSources
              .filter((source) => source.memoryId === entry.id)
              .map((source) => {
                const turn = turnRows.get(source.turnId)!;
                const session = sessionRows.get(turn.sessionId)!;
                const messages = [
                  messageById.get(source.userMessageId),
                  messageById.get(source.assistantMessageId),
                ];
                return {
                  session_id: turn.sessionId,
                  turn_id: source.turnId,
                  participants: [
                    { kind: "user", id: session.userId },
                    { kind: "agent", id: session.agentId },
                  ],
                  message_records: messages,
                };
              }),
            qq: (qqSources.get(entry.id) ?? []).map((source) => ({
              conversation_key: source.conversationKey,
              event_key: source.eventKey,
              speaker_kind: source.speakerKind,
              speaker_id: source.speakerId,
              utterance_time: { unix_seconds: source.occurredAtSeconds },
            })),
            event_time: "unknown unless explicitly supported by the original content",
          },
        }));
      } else if ((snapshot.source_event_ids ?? []).length > 0) {
        // QQ 文字事实输入（T06）：每个 selected event 走统一事实投影（真 live full facts →
        // projectQqMessageFacts/projectQqTextRelations）；存在但 expired/unavailable 的 facts
        // 不回裸 body；SQL 真无 facts 行且 body 仍活才 legacy（不编名字）。scope 经真实
        // memory_jobs 行 + 当下合法绑定在 load 内冻结进 configSnapshot.qq_fact_scope；重复
        // load 不覆盖旧 freeze，现值随后每次与冻结 8 字段逐项比对。off→on 仍走既有 cap checkpoint。
        const eventIds = snapshot.source_event_ids ?? [];
        const scopeKey = scopes.source;
        if (scopeKey === undefined) {
          fail("MEMORY_SOURCE_INVALID", "观察任务缺少记忆范围，不能整理");
        }
        // ownedObservations 先验：每个 selected event 必须属于本 job 的 scope（agent+键）。
        const events = ownedObservations(this.orm, agentId, eventIds, scopeKey);
        if (
          events.length &&
          events.every(
            (event) =>
              event.speakerKind === "member" &&
              event.speakerId !== null &&
              event.speakerId === events[0]!.speakerId,
          )
        )
          candidateSpeaker = events[0]!.speakerId ?? undefined;
        const frozen = freezeQqFactScope(this.db, agentId, jobId, scopeKey);
        const loaded = loadQqFactInputs({
          store: { db: this.db, orm: this.orm },
          scope: frozen,
          scopeKey,
          eventKeys: eventIds,
          now: nowIso(),
          important: attentionSpeakerIds(this.orm, events[0]),
        });
        sources = loaded.records.map(({ record }) => record);
        // 必须 sources 精确事实 + body 进 Runtime memory_job run；currentName 独立来源另列
        // （name refs 可选：startStep 到期帽排除 qq_member_name，不挡仍合法正文）。
        sourceRefs = [...loaded.factRefs, ...loaded.nameRefs];
        publication = loaded;
      } else {
        sourceRefs = turnSources(this.orm, JSON.parse(job.turnIds) as string[]);
        sources = sourceData(
          turns(this.orm, agentId, job.sessionId, {
            ids: JSON.parse(job.turnIds) as string[],
          }),
        );
      }
      const mergeSources =
        job.kind === "merge" ? mergeJobSourceSet(this.orm, jobId, agentId, nowIso()) : null;
      if (job.kind === "merge" && !mergeSources) fail("MEMORY_SOURCE_INVALID", "整合来源不可验证");
      const existing =
        scopes.route && scopes.source !== undefined
          ? this.orm
              .select()
              .from(schema.memoryEntries)
              .where(
                and(
                  eq(schema.memoryEntries.agentId, agentId),
                  eq(schema.memoryEntries.userId, DEFAULT_USER_ID),
                  sql`(${schema.memoryEntries.status} IN ('suppressed','replaced') OR CASE WHEN json_valid(${schema.memoryEntries.configSnapshot}) THEN json_type(${schema.memoryEntries.configSnapshot}, '$.content_correction.rejected')='array' AND json_array_length(${schema.memoryEntries.configSnapshot}, '$.content_correction.rejected')>0 ELSE 0 END)`,
                  sql`EXISTS (SELECT 1 FROM qq_memory_sources q WHERE q.memory_id=${schema.memoryEntries.id} AND q.scope_key=${scopes.source})`,
                  sql`NOT EXISTS (SELECT 1 FROM qq_memory_sources q WHERE q.memory_id=${schema.memoryEntries.id} AND q.scope_key<>${scopes.source})`,
                  sql`NOT EXISTS (SELECT 1 FROM memory_sources w WHERE w.memory_id=${schema.memoryEntries.id})`,
                ),
              )
              .orderBy(desc(schema.memoryEntries.createdAt), asc(schema.memoryEntries.id))
              .all()
          : job.kind !== "merge" && job.sessionId !== null
            ? this.orm
                .select()
                .from(schema.memoryEntries)
                .where(
                  and(
                    eq(schema.memoryEntries.agentId, agentId),
                    eq(schema.memoryEntries.userId, DEFAULT_USER_ID),
                    sql`EXISTS (SELECT 1 FROM memory_sources ms JOIN turns t ON t.id=ms.turn_id WHERE ms.memory_id=${schema.memoryEntries.id} AND t.session_id=${job.sessionId})`,
                    sql`NOT EXISTS (SELECT 1 FROM memory_sources ms LEFT JOIN turns t ON t.id=ms.turn_id WHERE ms.memory_id=${schema.memoryEntries.id} AND (t.id IS NULL OR t.session_id<>${job.sessionId}))`,
                    sql`NOT EXISTS (SELECT 1 FROM qq_memory_sources q WHERE q.memory_id=${schema.memoryEntries.id})`,
                  ),
                )
                .orderBy(desc(schema.memoryEntries.createdAt), asc(schema.memoryEntries.id))
                .all()
            : mergeSources
              ? this.orm
                  .select()
                  .from(schema.memoryEntries)
                  .where(
                    and(
                      eq(schema.memoryEntries.agentId, agentId),
                      eq(schema.memoryEntries.userId, DEFAULT_USER_ID),
                      sql`(EXISTS (SELECT 1 FROM memory_sources m WHERE m.memory_id=${schema.memoryEntries.id}) OR EXISTS (SELECT 1 FROM qq_memory_sources q WHERE q.memory_id=${schema.memoryEntries.id}))`,
                      sql`NOT EXISTS (SELECT 1 FROM memory_sources m WHERE m.memory_id=${schema.memoryEntries.id} AND m.turn_id NOT IN (SELECT value FROM json_each(${JSON.stringify(mergeSources.turnIds)})))`,
                      sql`NOT EXISTS (SELECT 1 FROM qq_memory_sources q WHERE q.memory_id=${schema.memoryEntries.id} AND q.event_key NOT IN (SELECT value FROM json_each(${JSON.stringify(mergeSources.eventKeys)})))`,
                    ),
                  )
                  .orderBy(desc(schema.memoryEntries.createdAt), asc(schema.memoryEntries.id))
                  .all()
              : entries(this.orm, agentId, undefined, { scopeKeys });
      const relevant = existing.filter(
        (entry) =>
          entry.status === "suppressed" ||
          entry.status === "replaced" ||
          correctionMetadata(entry.configSnapshot)?.rejected.length,
      );
      const safeRelevant = relevant;
      const contexts =
        scopes.route && candidateSpeaker
          ? qqSuppressionContexts(
              { db: this.db, orm: this.orm },
              jobId,
              agentId,
              safeRelevant.map((entry) => entry.id),
              nowIso(),
            )
          : new Map();
      const unknownIds = safeRelevant
        .filter((entry) => !contexts.has(entry.id))
        .map((entry) => entry.id);
      const sourceRefsByEntry = blockedMemorySourceRefs(
        this.orm,
        jobId,
        agentId,
        unknownIds,
        nowIso(),
      );
      if (unknownIds.some((id) => !sourceRefsByEntry.has(id)))
        fail("MEMORY_SOURCE_INVALID", "屏蔽记忆来源已变化或不可验证");
      const blockedWithRefs = safeRelevant.flatMap((entry) => {
        const context = contexts.get(entry.id);
        const proofRef = context?.ref ?? sourceRefsByEntry.get(entry.id)!;
        const memoryRefs = [...memoryEntrySources(this.orm, [entry]), proofRef];
        return [
          ...(entry.status === "suppressed" || entry.status === "replaced"
            ? [
                {
                  value: { name: entry.name, summary: entry.summary, body: entry.body },
                  refs: memoryRefs,
                  context: context?.speaker
                    ? {
                        speaker: context.speaker,
                        sourceIds: context.sourceIds,
                        records: context.records,
                      }
                    : null,
                  rejected: false,
                },
              ]
            : []),
          ...(correctionMetadata(entry.configSnapshot)?.rejected ?? []).map((value) => ({
            value,
            refs: memoryRefs,
            context: null,
            rejected: true,
          })),
        ];
      });
      return {
        kind: job.kind,
        config,
        retryOrigin,
        sources,
        blocked: blockedWithRefs.map((entry) => entry.value),
        sourceRefs,
        blockedRefs: blockedWithRefs.map((entry) => entry.refs),
        blockedRejected: blockedWithRefs.map((entry) => entry.rejected),
        blockedContexts: blockedWithRefs.map((entry) => entry.context),
        ...(candidateSpeaker ? { candidateSpeaker } : {}),
        ...(publication ? { publication } : {}),
      };
    });

    if (codePointLength(stringifyJsonSpaced(loaded.sources)) > MAX_SOURCE_CHARS) {
      fail("MEMORY_INPUT_TOO_LARGE", "来源内容过长，请减少所选轮次或记忆");
    }
    return loaded;
  }

  /**
   * `generate`.
   * Three independent chances to discard a draft, all returning `null` (which
   * is a *successful* job with no new memory, not a failure):
   * 1. the model itself said `{"memory": null}`;
   * 2. a cheap canonical containment check against blocked entries;
   * 3. a model-judged semantic comparison, in bounded chunks of 8.
   * The containment check strips case and punctuation via `canonical()`, so
   * "我 喜欢：精炼" and "我喜欢精炼" collide. It is a short-circuit, not the
   * authority — step 3 catches paraphrase that shares no substring.
   */
  async generate(
    kind: string,
    config: ConsolidationConfig,
    sources: Array<Record<string, unknown>>,
    blocked: Array<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: {
      owner: { kind: string; id: string; userId?: string; agentId?: string };
      sources: SourceRef[];
      blockedSources: SourceRef[][];
      blockedRejected?: boolean[];
      candidateSpeaker?: string;
      blockedContexts?: Array<{
        speaker: string;
        sourceIds: readonly string[];
        records: readonly Record<string, unknown>[];
      } | null>;
      /** loadInputs 按任务快照冻结的叶子来源。 */
      retryOrigin: RetryOrigin;
    },
    publication?: QqPublication,
  ): Promise<MemoryDraft | null> {
    const guard = new QqGroupCapabilityGuard(this.orm);
    // 飞行前冻结本群能力纪元：停用后（哪怕随后恢复）这次结果不得继续调用或发布。
    // standalone worker 不注入中央叶子边界，业务路径按捕获的纪元自足复验。
    const capCheckpoint = guard.assertLeaf(context.owner, "memory.consolidate");
    // publication 守卫：生成前/后/各 suppression call 前同式复验 facts/body/scope 现值。
    // name 变化时不使用失效 name 继续调用（name refs 剪除，不整 body）；publication 的
    // fact/body 复验失败即中止后续模型调用。
    const verifyPublication = (): void => {
      if (!publication) return;
      const job = jobOwned(this.orm, context.owner.agentId ?? "", context.owner.id);
      assertQqRouteCurrent(this.orm, context.owner.agentId ?? "", job.configSnapshot);
      verifyQqFactInputs({
        db: this.db,
        agentId: context.owner.agentId ?? "",
        jobId: context.owner.id,
        frozen: publication,
        now: nowIso(),
      });
    };
    verifyPublication();
    const liveSources = () =>
      publication
        ? filterLiveNameSources(this.db, context.owner, context.sources, nowIso())
        : context.sources;
    const checkCapture = () => {
      guard.assert(context.owner, "memory_organize");
      if (typeof capCheckpoint === "function") capCheckpoint();
    };
    const allBlockedRefs = context.blockedSources.flat();
    const verifyBlockedSources = () => {
      const now = nowIso();
      const bodyRefs = allBlockedRefs.filter((ref) => ref.kind === "memory_blocked_source");
      const qqRefs = allBlockedRefs.filter((ref) => ref.kind === "memory_suppression_context");
      if (
        blockedMemorySourceStates(
          this.orm,
          bodyRefs,
          context.owner,
          { userId: DEFAULT_USER_ID },
          now,
        ).some((state) => state !== "available") ||
        qqSuppressionContextStates(
          { db: this.db, orm: this.orm },
          qqRefs,
          context.owner,
          { userId: DEFAULT_USER_ID },
          now,
        ).some((state) => state !== "available")
      )
        fail("MEMORY_SOURCE_INVALID", "屏蔽记忆来源已变化");
    };
    // Every leaf boundary includes the facts that may be compared later.
    const recheckLeaf = (): void => {
      checkCapture();
      verifyPublication();
    };
    // 冻结在入队快照里的辅助分配档（0068）：output_reserved 是两种模式下都硬性的
    // max_tokens；缺席（含显式 null）＝角色现值（不发送输出帽）。输入门按完整请求计
    // （消息 + 响应 schema/协议包装，utf8 估算口径）：fixed 用显式 input_limit；
    // auto 用已知模型容量减输出预留（沿用既有容量读数，无档的老任务不新增探测，
    // 容量未知即显式拒绝，不发明保底值）。整理输入不可分，超限拒绝而不截断。
    const allocation = resolveAuxAllocation(config.allocation);
    const consolidateMessages = buildConsolidationPrompt(kind, config, sources);
    const schemaCost = (schema: Record<string, unknown>): number =>
      estimateTokens(JSON.stringify(schema));
    // 自动档的容量封顶：仅显式保存了档才取容量（老任务/无档不新增探测调用）；
    // 容量未知即显式拒绝。封顶 = 已知容量 - 输出预留（角色无输出预留则不发明余量）。
    // 有 prepare 钩子时描述符是唯一容量来源（实际模型/容量，替换原探测，不双探）：
    // 路由显式宣告编码时按完整请求（消息 + 响应 schema）的宣告 token 计量，未宣告编码
    // 保持原 utf8 字节估算；描述符随叶子输入透传，每次真实发送由网关 assertCurrent 复验。
    let capacityCeiling: number | null = null;
    let descriptor: ModelContextBudget | undefined;
    if (allocation.profile !== undefined) {
      if (this.gateway.prepareContextModel) {
        const prepared = await this.gateway.prepareContextModel(config.model, { signal });
        const capacity = prepared.capacity;
        if (capacity === null || !Number.isSafeInteger(capacity) || capacity < 1)
          fail("CONTEXT_CAPACITY_UNKNOWN", "无法确认整理模型容量，不猜保底值");
        descriptor = prepared;
        capacityCeiling = capacity - (allocation.outputReserved ?? 0);
        if (capacityCeiling < 1) fail("CONTEXT_AUX_BUDGET", "输出预留已用尽模型容量");
      } else if (allocation.profile.mode === "auto") {
        const capacity = await this.gateway.loadedContextCapacity(config.model, {
          signal,
        });
        if (capacity === null || !Number.isSafeInteger(capacity) || capacity < 1)
          fail("CONTEXT_CAPACITY_UNKNOWN", "自动档无法确认整理模型容量，不猜保底值");
        capacityCeiling = capacity - (allocation.outputReserved ?? 0);
        if (capacityCeiling < 1) fail("CONTEXT_AUX_BUDGET", "自动档的输出预留已用尽模型容量");
      }
    }
    // 必须在获取 descriptor 之后使用 actualModel（避免猜测请求配置与实际路由/回退模型不一致）。
    const actualModel = descriptor?.model ?? config.model;
    // 准备各阶段真实请求协议快照（网关拥有方方言/负缓存），预门禁与 LeafInput 共用同一快照。
    const draftFormat = this.gateway.prepareRequestFormat?.({
      model: actualModel,
      responseSchema: DRAFT_RESULT_JSON_SCHEMA,
    });
    const suppressionFormat = this.gateway.prepareRequestFormat?.({
      model: actualModel,
      responseSchema: SUPPRESSION_RESULT_JSON_SCHEMA,
    });
    const hasDeclaredCounter =
      descriptor?.countText !== undefined && descriptor?.tokenizerEncoding !== undefined;
    // 共享计量入口：优先使用公共纯函数 measurePreparedRequest 复用同一协议快照；
    // 协议或计数器缺失时保持旧完整协议估算，不使用空协议。
    const measureCost = (
      messages: PromptMessage[],
      schema: Record<string, unknown>,
      format?: PreparedRequestFormat,
    ): number | null => {
      if (format !== undefined && descriptor !== undefined) {
        const measured = measurePreparedRequest(messages, descriptor, format);
        if (measured !== undefined) return measured.textTokens;
      }
      if (hasDeclaredCounter && descriptor !== undefined) {
        descriptor.assertCurrent();
        const counter = { encoding: descriptor.tokenizerEncoding!, count: descriptor.countText! };
        const measured = measureContextTokens(messages, counter, {
          responseSchema: schema,
        }).textTokens;
        descriptor.assertCurrent();
        return measured;
      }
      return null;
    };
    // 输入门（utf8 字节估算口径，独立硬帽）与容量门（宣告 token 或字节估算）单向解耦检查，
    // 不跨单位折算。整理与抑制比对各自按自己的完整请求计价。
    const checkRequestFit = (
      messages: PromptMessage[],
      schema: Record<string, unknown>,
      format?: PreparedRequestFormat,
    ): { fits: boolean; reason?: "input_limit" | "capacity" } => {
      const byteCost = estimateMessages(messages) + schemaCost(schema);
      if (allocation.inputLimit !== null && byteCost > allocation.inputLimit)
        return { fits: false, reason: "input_limit" };
      if (capacityCeiling !== null) {
        const tokens = measureCost(messages, schema, format);
        const cost = tokens === null ? byteCost : tokens;
        if (cost > capacityCeiling) return { fits: false, reason: "capacity" };
      }
      return { fits: true };
    };
    const fits = (
      messages: PromptMessage[],
      schema: Record<string, unknown>,
      format?: PreparedRequestFormat,
    ): boolean => checkRequestFit(messages, schema, format).fits;
    const gate = (
      messages: PromptMessage[],
      schema: Record<string, unknown>,
      what: string,
      format?: PreparedRequestFormat,
    ): void => {
      const check = checkRequestFit(messages, schema, format);
      if (!check.fits) {
        if (check.reason === "input_limit") {
          fail("CONTEXT_AUX_BUDGET", `冻结的输入上限小于完整${what}请求，未截断来源`);
        } else {
          fail("CONTEXT_AUX_BUDGET", `模型容量小于完整${what}请求，未截断来源`);
        }
      }
    };
    gate(consolidateMessages, DRAFT_RESULT_JSON_SCHEMA, "整理", draftFormat);
    // 描述符与 token 上限只随叶子输入透传；token 上限仅在宣告计数器存在时携带，
    // 让网关在最终 wire 上按同一计量方法复核严格 schema 完整请求。
    const leafBudget = {
      ...(descriptor === undefined ? {} : { contextBudget: descriptor }),
      ...(descriptor !== undefined && hasDeclaredCounter && capacityCeiling !== null
        ? { contextInputLimit: capacityCeiling }
        : {}),
    };
    verifyBlockedSources();
    const text = await this.agentRuntime.completeLeaf(
      {
        id: "memory.consolidate",
        version: "1",
        model: actualModel,
        temperature: 0,
        ...(allocation.outputReserved === null ? {} : { maxTokens: allocation.outputReserved }),
        responseSchema: DRAFT_RESULT_JSON_SCHEMA,
      },
      {
        messages: consolidateMessages,
        signal,
        owner: context.owner,
        retryOrigin: context.retryOrigin,
        assertSources: recheckLeaf,
        sources: liveSources(),
        validate: parseResult,
        ...(draftFormat === undefined ? {} : { requestFormat: draftFormat }),
        ...leafBudget,
      },
    );
    // 飞行后、解析前复验：停用后不再产生后续调用，off→on 的旧纪元结果同样被拒。
    recheckLeaf();
    verifyBlockedSources();
    const draft = parseResult(text);
    if (draft === null) return null;

    const candidateEventIds = new Set(publication?.records.map((record) => record.eventKey) ?? []);
    for (const [index, entry] of blocked.entries()) {
      const original = canonical(String(entry.body ?? ""));
      const candidate = canonical(draft.body);
      if (original && (candidate.includes(original) || original.includes(candidate))) {
        const evidence = context.blockedContexts?.[index];
        const independentlyDifferent =
          context.candidateSpeaker &&
          evidence &&
          context.candidateSpeaker !== evidence.speaker &&
          evidence.sourceIds.every((id) => !candidateEventIds.has(id));
        if (!independentlyDifferent) return null;
      }
    }
    const compared = blocked.map((value, index) => ({
      ...value,
      source_context: context.blockedContexts?.[index]
        ? {
            speaker: {
              channel: "onebot11",
              kind: "member",
              id: context.blockedContexts[index]!.speaker,
            },
            source_ids: context.blockedContexts[index]!.sourceIds,
            records: context.blockedContexts[index]!.records,
          }
        : null,
      subject: "unknown",
    }));
    const candidateContext = publication
      ? {
          speaker: context.candidateSpeaker
            ? { channel: "onebot11", kind: "member", id: context.candidateSpeaker }
            : null,
          records: publication.records.map((record) => record.record),
          subject: "unknown",
        }
      : null;
    if (codePointLength(stringifyJsonSpaced({ candidateContext, compared })) > MAX_SOURCE_CHARS)
      fail("MEMORY_INPUT_TOO_LARGE", "抑制来源内容过长，请减少所选来源");

    for (let start = 0; start < compared.length; ) {
      checkCapture();
      verifyPublication();
      let count = 1;
      if (allocation.mode === "auto") {
        const firstMessages = suppressionPrompt(
          draft,
          compared.slice(start, start + 1),
          candidateContext,
        );
        gate(firstMessages, SUPPRESSION_RESULT_JSON_SCHEMA, "抑制比对", suppressionFormat);
        while (
          start + count < compared.length &&
          fits(
            suppressionPrompt(draft, compared.slice(start, start + count + 1), candidateContext),
            SUPPRESSION_RESULT_JSON_SCHEMA,
            suppressionFormat,
          )
        ) {
          count++;
        }
      } else {
        count = Math.min(8, compared.length - start);
      }
      const chunk = compared.slice(start, start + count);
      const chunkRefs = context.blockedSources.slice(start, start + count).flat();
      const verifyBlocked = () => {
        const bodyRefs = chunkRefs.filter((ref) => ref.kind === "memory_blocked_source");
        if (
          blockedMemorySourceStates(
            this.orm,
            bodyRefs,
            context.owner,
            { userId: DEFAULT_USER_ID },
            nowIso(),
          ).some((state) => state !== "available")
        )
          fail("MEMORY_SOURCE_INVALID", "屏蔽记忆来源已变化");
        const refs = chunkRefs.filter((ref) => ref.kind === "memory_suppression_context");
        if (
          qqSuppressionContextStates(
            { db: this.db, orm: this.orm },
            refs,
            context.owner,
            { userId: DEFAULT_USER_ID },
            nowIso(),
          ).some((state) => state !== "available")
        )
          fail("MEMORY_SOURCE_INVALID", "抑制来源已变化");
      };
      verifyBlocked();
      const suppressionMessages = suppressionPrompt(draft, chunk, candidateContext);
      gate(suppressionMessages, SUPPRESSION_RESULT_JSON_SCHEMA, "抑制比对", suppressionFormat);
      const response = await this.agentRuntime.completeLeaf(
        {
          id: "memory.suppression",
          version: "1",
          model: actualModel,
          temperature: 0,
          ...(allocation.outputReserved === null ? {} : { maxTokens: allocation.outputReserved }),
          responseSchema: SUPPRESSION_RESULT_JSON_SCHEMA,
        },
        {
          messages: suppressionMessages,
          signal,
          owner: context.owner,
          retryOrigin: context.retryOrigin,
          assertSources: () => {
            recheckLeaf();
            verifyBlocked();
          },
          sources: [...liveSources(), ...chunkRefs],
          validate: (text) => SuppressionResultSchema.parse(JSON.parse(text)),
          ...(suppressionFormat === undefined ? {} : { requestFormat: suppressionFormat }),
          ...leafBudget,
        },
      );
      checkCapture();
      verifyPublication();
      verifyBlocked();
      if (SuppressionResultSchema.parse(JSON.parse(response)).blocked) return null;
      start += count;
    }
    checkCapture();
    return draft;
  }

  /** `fail_job` — token-guarded so it never clobbers a successor. */
  async failJob(agentId: string, jobId: string, token: string, code: string): Promise<void> {
    try {
      immediate(this.db, () => {
        policy(this.orm, agentId);
        const job = jobOwned(this.orm, agentId, jobId);
        if (job.status === "running" && job.token === token) {
          updateJobRow(this.orm, job.id, {
            status: "failed",
            errorCode: code,
            finishedAt: nowIso(),
            token: null,
            leaseExpiresAt: null,
          });
        }
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }
  }

  /**
   * `run_job`.
   * The order of checks after the race is load-bearing and matches the contract:
   * a completed heartbeat is inspected **before** the work result, because
   * losing ownership must abort the job even if the model already returned
   * publishing stale work is exactly what the lease exists to prevent.
   */
  async runJob(jobId: string): Promise<void> {
    if (!this.enabled()) return;
    const timeoutMs =
      typeof this.jobTimeoutMs === "function" ? this.jobTimeoutMs() : this.jobTimeoutMs;
    const before = this.telemetry
      ? (this.db.query("SELECT status FROM memory_jobs WHERE id=?").get(jobId) as {
          status: string;
        } | null)
      : null;
    const claimed = immediate(this.db, () => claim(this.orm, jobId));
    if (claimed === null) {
      if (before?.status === "queued") {
        const after = this.db
          .query("SELECT status,error_code,agent_id FROM memory_jobs WHERE id=?")
          .get(jobId) as { status: string; error_code: string | null; agent_id: string } | null;
        if (after?.status === "failed")
          this.telemetry?.record("memory.claim", {
            channel: "memory",
            stage: "maintenance",
            status: "failed",
            code: after.error_code ?? "MEMORY_CLAIM_FAILED",
            agentId: after.agent_id,
            details: { jobId },
          });
      }
      return;
    }
    if (claimed.token === null) return;
    const span = this.telemetry?.start("memory.job", {
      channel: "memory",
      stage: "maintenance",
      agentId: claimed.agentId,
      details: { jobId, kind: claimed.kind },
      code: "MEMORY_JOB_CLAIMED",
    });
    const work = () => this.runClaimedJob(claimed.agentId, jobId, claimed.token!, timeoutMs, span);
    await (span ? span.within(work) : work());
  }
  private async runClaimedJob(
    agentId: string,
    jobId: string,
    token: string,
    timeoutMs: number,
    span?: TraceScope,
  ): Promise<void> {
    let stopped = false;
    let onCancel: () => void = () => {};
    const cancelled = new Promise<void>((resolve) => {
      onCancel = resolve;
    });
    // One controller per job. Every exit path (stop, timeout, ownership loss
    // normal completion) aborts it, so the in-flight model request is actually
    // terminated instead of being left to burn LM Studio capacity (#96).
    const jobAbort = new AbortController();
    this.cancelCurrentJob = () => {
      stopped = true;
      jobAbort.abort();
      onCancel();
    };

    let heartbeatDone = false;
    let heartbeatError: unknown;
    const heartbeat = this.heartbeatLoop(
      agentId,
      jobId,
      token,
      () => stopped,
      jobAbort.signal,
    ).then(
      () => {
        heartbeatDone = true;
      },
      (error: unknown) => {
        heartbeatDone = true;
        heartbeatError = error;
      },
    );

    let workDone = false;
    let workError: unknown;
    let draft: MemoryDraft | null = null;
    let work: Promise<void> | null = null;

    try {
      // 最小冻结：输入加载前捕获本群能力纪元；generate 内部与发布提交边界都用同一 job 作用域
      // 的纪元复核，填补 generate 返回后到 publish 之间（await 调度）的窗口。
      const publishCheckpoint = new QqGroupCapabilityGuard(this.orm).assertLeaf(
        { kind: "memory_job", id: jobId, userId: DEFAULT_USER_ID, agentId },
        "memory.consolidate",
      );
      const inputs = this.loadInputs(agentId, jobId, token);
      const refs = [...inputs.sourceRefs, ...inputs.blockedRefs.flat()];
      span?.update({
        model: inputs.config.model,
        sources: refs,
        details: { sourceCount: inputs.sources.length, blockedCount: inputs.blocked.length },
      });
      this.telemetry?.record("memory.load", {
        channel: "memory",
        stage: "context",
        sources: refs,
        status: "completed",
        code: "MEMORY_INPUTS_LOADED",
        details: { jobId, sourceCount: inputs.sources.length },
      });
      work = this.generate(
        inputs.kind,
        inputs.config,
        inputs.sources,
        inputs.blocked,
        jobAbort.signal,
        {
          owner: { kind: "memory_job", id: jobId, userId: DEFAULT_USER_ID, agentId },
          sources: inputs.sourceRefs,
          blockedSources: inputs.blockedRefs,
          blockedRejected: inputs.blockedRejected,
          candidateSpeaker: inputs.candidateSpeaker,
          blockedContexts: inputs.blockedContexts,
          retryOrigin: inputs.retryOrigin,
        },
        inputs.publication,
      ).then(
        (value) => {
          workDone = true;
          draft = value;
        },
        (error: unknown) => {
          workDone = true;
          workError = error;
        },
      );

      await this.waitForFirst(heartbeat, work, cancelled, timeoutMs);
      if (stopped) throw WORKER_STOPPED;
      if (heartbeatDone && heartbeatError !== undefined) throw heartbeatError;
      if (!workDone) fail("MEMORY_TIMEOUT", "记忆整理超时");
      if (workError !== undefined) throw workError;
      const publication = this.telemetry?.start("memory.publish", {
        channel: "memory",
        stage: "maintenance",
        details: { jobId },
      });
      try {
        immediate(this.db, () => {
          if (typeof publishCheckpoint === "function") publishCheckpoint();
          const blockedRefs = inputs.blockedRefs
            .flat()
            .filter((ref) => ref.kind === "memory_blocked_source");
          if (
            blockedMemorySourceStates(
              this.orm,
              blockedRefs,
              { kind: "memory_job", id: jobId, userId: DEFAULT_USER_ID, agentId },
              { userId: DEFAULT_USER_ID },
              nowIso(),
            ).some((state) => state !== "available")
          )
            fail("MEMORY_SOURCE_INVALID", "屏蔽记忆来源已变化");
          const suppressionRefs = inputs.blockedRefs
            .flat()
            .filter((ref) => ref.kind === "memory_suppression_context");
          if (
            qqSuppressionContextStates(
              { db: this.db, orm: this.orm },
              suppressionRefs,
              { kind: "memory_job", id: jobId, userId: DEFAULT_USER_ID, agentId },
              { userId: DEFAULT_USER_ID },
              nowIso(),
            ).some((state) => state !== "available")
          )
            fail("MEMORY_SOURCE_INVALID", "抑制来源已变化");
          // publication 同 tx 复验（publishCheckpoint 之后、publish 之前）：现值须与冻结
          // 8 字段 scope/fact refs 逐项比对；name refs 不参与本门（可选资料，不取消仍合法
          // body 的 publication）。merge/Web 任务无 publication，按无操作处理。
          if (inputs.publication) {
            verifyQqFactInputs({
              db: this.db,
              agentId,
              jobId,
              frozen: inputs.publication,
              now: nowIso(),
            });
          }
          publish(this.orm, agentId, jobId, token, draft);
        });
        publication?.end(
          draft ? "completed" : "no_output",
          draft ? "MEMORY_PUBLISHED" : "MEMORY_NO_DRAFT",
        );
      } catch (error) {
        publication?.end("failed", "MEMORY_PUBLISH_REJECTED");
        throw error;
      }
      span?.end(draft ? "completed" : "no_output", draft ? "MEMORY_PUBLISHED" : "MEMORY_NO_DRAFT");
    } catch (error) {
      if (error === WORKER_STOPPED) {
        span?.end("cancelled", "MEMORY_WORKER_STOPPED");
        await this.failJob(agentId, jobId, token, "MEMORY_WORKER_STOPPED");
        return;
      }
      const code = error instanceof AppError ? error.code : "MEMORY_INVALID_RESULT";
      span?.end("failed", code);
      await this.failJob(agentId, jobId, token, code);
    } finally {
      this.cancelCurrentJob = null;
      stopped = true;
      onCancel();
      // Abort first, then await: the heartbeat's delay is now interruptible and
      // the model request observes the same signal, so BOTH settle promptly.
      // Without the abort, `await service.stop()` used to block for the
      // remainder of a 15s heartbeat sleep and the model call kept running
      // (#96). `work` is still not awaited — the contract cancels that coroutine
      // and a fake gateway may legitimately ignore the signal; the attached
      // handler keeps a late rejection from surfacing as an unhandled
      // rejection, and the token/lease guards above are the only route to
      // publish, with the job already terminal.
      jobAbort.abort();
      work?.catch(() => {});
      await heartbeat;
    }
  }

  /** `heartbeat` — renew every 15s, extend by 60s. */
  private async heartbeatLoop(
    agentId: string,
    jobId: string,
    token: string,
    shouldStop: () => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      // Not the loop's `sleep`: the heartbeat must not be woken by an unrelated
      // poll can. It IS tied to the job's abort signal, because the contract's
      // heartbeat must stop the instant the runner task is
      // cancelled. A bare `setTimeout` made
      // `await stop()` wait out the remaining sleep (#96).
      await this.delayUntilAborted(this.heartbeatIntervalMs, signal);
      if (shouldStop() || signal.aborted) return;
      immediate(this.db, () => renewLease(this.orm, agentId, jobId, token));
    }
  }

  /** A delay that resolves early — and immediately — when `signal` aborts. */
  private delayUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Resolve as soon as either participant settles, the caller cancels, or the
   * job budget elapses — the first participant to settle wins.
   */
  private waitForFirst(
    heartbeat: Promise<void>,
    work: Promise<void>,
    cancelled: Promise<void>,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      void heartbeat.then(done, done);
      void work.then(done, done);
      void cancelled.then(done);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sleepResolve = () => {
        clearTimeout(timer);
        this.sleepResolve = null;
        resolve();
      };
      const timer = setTimeout(() => {
        this.sleepResolve = null;
        resolve();
      }, ms);
    });
  }
}

/**
 * 这条 QQ 会话当下的「重要的人」名单（软优先与硬优先都算）——整理来源打 `important` 标记的依据。
 *
 * 取绑定当下的值而不是消息到达时的值：名单是"这个人现在在意谁"，改名单要能看到旧消息也跟着变。
 * 找不到绑定（会话已解绑）时不标记，整理照旧按来源内容判断，不额外失败。
 */
function attentionSpeakerIds(orm: Orm, event: QqEventRow | undefined): ReadonlySet<string> {
  if (event === undefined) return new Set();
  const binding = readBindingByConversation(orm, {
    accountId: event.accountId,
    kind: event.conversationKind as "group" | "private",
    peerId: event.peerId,
  });
  if (!binding || binding.attention.mode === "off") return new Set();
  return new Set(binding.attention.members);
}
