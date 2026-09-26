// Durable P4 memory worker
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
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { SourceRef } from "../../shared/contracts/evidence";
import { createAgentRuntime, type LeafAgentRuntime } from "../agent/agent-runtime";
import { AgentRunRepository } from "../db/agent-run-repository";
import {
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
import { ownedObservations, type QqEventRow } from "../db/memory-source-repository";
import { readBindingByConversation } from "../db/qq-binding-repository";
import { observationText } from "../db/qq-observation-repository";
import { DEFAULT_USER_ID, immediate, nowIso, type Orm } from "../db/repositories";
import * as schema from "../db/schema";
import { AppError, fail } from "../errors";
import type { ModelGateway } from "../llm/model-gateway";
import { memoryEntrySources, observationSourcesForRun, turnSources } from "../modules/provenance";
import type { RuntimeTelemetry, TraceScope } from "../observability/runtime-telemetry";
import {
  buildConsolidationPrompt,
  type ConsolidationConfig,
  canonical,
  codePointLength,
  DRAFT_RESULT_JSON_SCHEMA,
  MAX_SOURCE_CHARS,
  parseResult,
  SUPPRESSION_RESULT_JSON_SCHEMA,
  SuppressionResultSchema,
  stringifyJsonSpaced,
  suppressionPrompt,
} from "./memory-contract";
import { correctionMetadata } from "./memory-revision";

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
  jobTimeoutMs?: number;
}

export interface MemoryInputs {
  kind: string;
  config: ConsolidationConfig;
  sources: Array<Record<string, unknown>>;
  blocked: Array<Record<string, unknown>>;
  sourceRefs: SourceRef[];
  blockedRefs: SourceRef[][];
}

export class MemoryService {
  private readonly orm: Orm;
  private readonly db: Database;
  private readonly agentRuntime: LeafAgentRuntime;
  private readonly telemetry?: RuntimeTelemetry;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly jobTimeoutMs: number;

  private loopPromise: Promise<void> | null = null;
  private stopped = false;
  private sleepResolve: (() => void) | null = null;
  private cancelCurrentJob: (() => void) | null = null;

  constructor(options: MemoryServiceOptions) {
    this.telemetry = options.telemetry;
    this.orm = options.orm;
    this.db = options.db;
    this.agentRuntime =
      options.agentRuntime ??
      createAgentRuntime({
        gateway: options.gateway,
        repository: new AgentRunRepository(options.db),
      });
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 3_600_000;
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
   */
  scheduleAuto(): void {
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

          const rows = turns(this.orm, session.agentId, session.id, { unprocessed: true });
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
      const config = JSON.parse(job.configSnapshot) as ConsolidationConfig;
      const snapshot = JSON.parse(job.configSnapshot) as {
        scope_key?: string;
        source_event_ids?: string[];
      };
      // A job only ever sees the scope it writes into. Without this, a suppressed
      // memory's body from one group would be handed to the model while organising
      // another group — a cross-scope content leak, not just a governance detail.
      const scopeKeys = snapshot.scope_key === undefined ? undefined : [snapshot.scope_key];
      let sources: Array<Record<string, unknown>>;
      let sourceRefs: SourceRef[];
      if (job.kind === "merge") {
        const selected = entries(this.orm, agentId, JSON.parse(job.memoryIds) as string[], {
          scopeKeys,
        });
        if (selected.some((item) => item.status !== "active")) {
          fail("MEMORY_STATE_CONFLICT", "来源记忆已变化");
        }
        validateEntrySources(this.orm, selected);
        sourceRefs = memoryEntrySources(this.orm, selected);
        sources = selected.map((entry) => ({
          name: entry.name,
          summary: entry.summary,
          body: entry.body,
          tags: JSON.parse(entry.tags),
          kinds: JSON.parse(entry.kinds),
        }));
      } else if ((snapshot.source_event_ids ?? []).length > 0) {
        // A QQ conversation cites observations instead of turns. Every event must
        // still have its text: a body that reached the retention window is not a
        // source we can summarise, and using only the survivors would attach
        // provenance for messages that were never read. Fail closed instead.
        const eventIds = snapshot.source_event_ids ?? [];
        const scopeKey = snapshot.scope_key;
        if (scopeKey === undefined) {
          fail("MEMORY_SOURCE_INVALID", "观察任务缺少记忆范围，不能整理");
        }
        const bodies = observationText(this.orm, eventIds);
        const missing = eventIds.filter((id) => !bodies.has(id));
        if (missing.length > 0) {
          fail("MEMORY_SOURCE_INVALID", "观察正文已过期或缺失，不能整理为长期记忆");
        }
        sourceRefs = observationSourcesForRun(this.orm, eventIds);
        const events = ownedObservations(this.orm, agentId, eventIds, scopeKey);
        // 软优先名单要影响整理——名单内的人明确说过、且没有互相矛盾的事实更容易
        // 被保留。名单取**当下**的绑定（和会话侧同一份事实），不按消息到达时的状态打标签；只标
        // 成员来源，匿名/系统发言没有号可对。标记只是事实，判断仍以来源内容为准。
        const important = attentionSpeakerIds(this.orm, events[0]);
        sources = events.map((event) => ({
          message_id: event.messageId,
          speaker_kind: event.speakerKind,
          speaker_id: event.speakerId,
          ...(event.speakerId !== null && important.has(event.speakerId)
            ? { important: true }
            : {}),
          occurred_at_seconds: event.occurredAtSeconds,
          body: bodies.get(event.eventKey) ?? "",
        }));
      } else {
        sourceRefs = turnSources(this.orm, JSON.parse(job.turnIds) as string[]);
        sources = sourceData(
          turns(this.orm, agentId, job.sessionId, {
            ids: JSON.parse(job.turnIds) as string[],
          }),
        );
      }
      const existing = entries(this.orm, agentId, undefined, { scopeKeys });
      const blockedWithRefs = existing.flatMap((entry) => {
        const values = [
          ...(entry.status === "suppressed" || entry.status === "replaced"
            ? [{ name: entry.name, summary: entry.summary, body: entry.body }]
            : []),
          ...(correctionMetadata(entry.configSnapshot)?.rejected ?? []),
        ];
        return values.map((value) => ({ value, refs: memoryEntrySources(this.orm, [entry]) }));
      });
      return {
        kind: job.kind,
        config,
        sources,
        blocked: blockedWithRefs.map((entry) => entry.value),
        sourceRefs,
        blockedRefs: blockedWithRefs.map((entry) => entry.refs),
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
    },
  ): Promise<MemoryDraft | null> {
    const text = await this.agentRuntime.completeLeaf(
      {
        id: "memory.consolidate",
        version: "1",
        model: config.model,
        temperature: 0,
        responseSchema: DRAFT_RESULT_JSON_SCHEMA,
      },
      {
        messages: buildConsolidationPrompt(kind, config, sources),
        signal,
        owner: context.owner,
        sources: context.sources,
        validate: parseResult,
      },
    );
    const draft = parseResult(text);
    if (draft === null) return null;

    for (const entry of blocked) {
      const original = canonical(String(entry.body ?? ""));
      const candidate = canonical(draft.body);
      if (original && (candidate.includes(original) || original.includes(candidate))) {
        return null;
      }
    }

    for (let start = 0; start < blocked.length; start += 8) {
      const response = await this.agentRuntime.completeLeaf(
        {
          id: "memory.suppression",
          version: "1",
          model: config.model,
          temperature: 0,
          responseSchema: SUPPRESSION_RESULT_JSON_SCHEMA,
        },
        {
          messages: suppressionPrompt(draft, blocked.slice(start, start + 8)),
          signal,
          owner: context.owner,
          sources: [...context.sources, ...context.blockedSources.slice(start, start + 8).flat()],
          validate: (text) => SuppressionResultSchema.parse(JSON.parse(text)),
        },
      );
      if (SuppressionResultSchema.parse(JSON.parse(response)).blocked) return null;
    }
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
    const work = () => this.runClaimedJob(claimed.agentId, jobId, claimed.token!, span);
    await (span ? span.within(work) : work());
  }
  private async runClaimedJob(
    agentId: string,
    jobId: string,
    token: string,
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
        },
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

      await this.waitForFirst(heartbeat, work, cancelled);
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
        immediate(this.db, () => publish(this.orm, agentId, jobId, token, draft));
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
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, this.jobTimeoutMs);
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
