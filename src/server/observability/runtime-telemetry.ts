import type { Database } from "bun:sqlite";
import { type Context, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { SourceRef } from "../../shared/contracts/evidence";
import { TELEMETRY_RETENTION_DEFAULT_DAYS } from "../../shared/contracts/permissions";
import type { RuntimeSpan } from "../../shared/contracts/runtime-observability";
import { publishConversationChange } from "../conversation/conversation-changes";
import { DEFAULT_USER_ID } from "../db/repositories";

type Scalar = string | number | boolean | null;
/** 契约缺省（permissions.ts 的 execution.telemetry.retentionDays）：没有配置源时的保留天数。 */
export const DEFAULT_TRACE_RETENTION_DAYS = TELEMETRY_RETENTION_DEFAULT_DAYS;
export interface RuntimeTelemetryOptions {
  /**
   * 有效追踪保留天数。新 trace 开始时读取一次并冻结，之后的设置变化不影响已开始的 trace；
   * 已写入过的 trace（如重启后续写）继续取已写入到期与来源 TTL 的最小值。
   */
  retentionDays?: () => number;
}
export interface TraceMetadata {
  channel: RuntimeSpan["channel"];
  stage: RuntimeSpan["stage"];
  userId?: string;
  agentId?: string;
  conversationId?: string;
  runId?: string;
  wakeId?: string;
  outputId?: string;
  sourceSeq?: number;
  model?: string;
  status?: RuntimeSpan["status"];
  code?: string;
  details?: Record<string, Scalar>;
  sources?: readonly SourceRef[];
  /** Continue a persisted operation after an async queue boundary/restart. */
  parent?: { traceId: string; spanId: string };
}
export interface TraceScope {
  readonly traceId: string;
  readonly spanId: string;
  within<T>(work: () => T): T;
  update(metadata: Partial<TraceMetadata>): void;
  end(status?: RuntimeSpan["status"], code?: string): void;
}
const date = (time: readonly [number, number]) =>
  new Date(time[0] * 1000 + time[1] / 1e6).toISOString();

/** Per-runtime OTel provider/context: no process-global registration or outbound exporter. */
export class RuntimeTelemetry {
  private readonly context = new AsyncLocalStorageContextManager().enable();
  private readonly provider: BasicTracerProvider;
  private readonly meta = new Map<string, TraceMetadata>();
  // Keep the source lifetime while any span can still write, even after housekeeping deletes rows.
  // `capAt` is this trace's frozen retention cap: written once when the trace first persists, so a
  // later configuration change cannot shorten or extend a trace that has already started.
  private readonly activeTraces = new Map<
    string,
    { spans: number; expiresAt?: string; capAt?: string; expired: boolean }
  >();
  private readonly retentionDays: () => number;
  private readonly tracer;
  constructor(
    readonly db: Database,
    options: RuntimeTelemetryOptions = {},
  ) {
    this.retentionDays = options.retentionDays ?? (() => DEFAULT_TRACE_RETENTION_DAYS);
    const processor: SpanProcessor = {
      onStart: (span) => {
        const { traceId } = span.spanContext();
        const lifetime = this.activeTraces.get(traceId) ?? { spans: 0, expired: false };
        lifetime.spans++;
        this.activeTraces.set(traceId, lifetime);
        this.safe(() => this.persist(span as unknown as ReadableSpan, false));
        this.notifyConversationChange(span as ReadableSpan);
      },
      onEnd: (span) => {
        this.safe(() => this.persist(span, true));
        this.notifyConversationChange(span);
        // Cleanup must also run when the diagnostic database write fails.
        const { traceId, spanId } = span.spanContext();
        this.meta.delete(spanId);
        const lifetime = this.activeTraces.get(traceId);
        if (lifetime && --lifetime.spans === 0) this.activeTraces.delete(traceId);
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    this.provider = new BasicTracerProvider({ spanProcessors: [processor] });
    this.tracer = this.provider.getTracer("superstring.runtime");
  }
  private safe(work: () => void): void {
    try {
      work();
    } catch {
      console.warn("runtime observability write failed");
    }
  }
  private notifyConversationChange(span: Pick<ReadableSpan, "spanContext">): void {
    const conversationId = this.meta.get(span.spanContext().spanId)?.conversationId;
    if (conversationId) this.safe(() => publishConversationChange(this.db, conversationId));
  }
  activeMetadata(): Readonly<TraceMetadata> | undefined {
    const parent = trace.getSpan(this.context.active());
    return parent ? this.meta.get(parent.spanContext().spanId) : undefined;
  }
  start(name: string, metadata: TraceMetadata): TraceScope {
    const inherited = this.activeMetadata();
    const combined: TraceMetadata = {
      ...inherited,
      ...metadata,
      status: metadata.status ?? "started",
      code: metadata.code ?? name,
      details: { ...inherited?.details, ...metadata.details },
    };
    const parentContext: Context = metadata.parent
      ? trace.setSpanContext(ROOT_CONTEXT, { ...metadata.parent, traceFlags: 1 })
      : this.context.active();
    // onStart receives initial attrs; mutable domain metadata is persisted on update/end.
    const span = this.tracer.startSpan(
      name,
      { attributes: { metadata: JSON.stringify(combined) } },
      parentContext,
    );
    const { traceId, spanId } = span.spanContext();
    this.meta.set(spanId, combined);
    this.notifyConversationChange(span);
    let ended = false;
    const scope: TraceScope = {
      traceId,
      spanId,
      within: (work) => this.context.with(trace.setSpan(parentContext, span), work),
      update: (next) => {
        if (ended) return;
        Object.assign(combined, next, { details: { ...combined.details, ...next.details } });
        this.safe(() => this.persist(span as unknown as ReadableSpan, false));
      },
      end: (status, code) => {
        if (ended) return;
        ended = true;
        combined.status = status ?? (combined.status === "started" ? "completed" : combined.status);
        if (code) combined.code = code;
        if (combined.status === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      },
    };
    return scope;
  }
  record(name: string, metadata: TraceMetadata): void {
    const scope = this.start(name, metadata);
    scope.end(metadata.status ?? "observed", metadata.code);
  }
  parentFor(
    field: "run_id" | "wake_id" | "output_id",
    id: string,
  ): { traceId: string; spanId: string } | null {
    let parent: { traceId: string; spanId: string } | null = null;
    this.safe(() => {
      parent = this.db
        .query(
          `SELECT trace_id AS traceId,span_id AS spanId FROM runtime_spans WHERE ${field}=? AND expires_at>? ORDER BY id LIMIT 1`,
        )
        .get(id, new Date().toISOString()) as typeof parent;
    });
    return parent;
  }
  /**
   * 物理清扫：只删完全停止且已到期的 trace。started/unknown 是管理端承诺的保全状态
   * （cleanupScope.protectedTraceStatuses），60s 自动清扫与手动清理必须用同一判定，
   * 否则“保护”只在按钮上成立；被删掉的 trace 记入 expired，后续写入不得复活。
   */
  expire(now = new Date().toISOString()): void {
    const deleted = new Set<string>();
    this.safe(() => {
      const rows = this.db
        .query(
          `DELETE FROM runtime_spans WHERE expires_at<=? AND trace_id NOT IN (
          SELECT trace_id FROM runtime_spans WHERE status IN('started','unknown')) RETURNING trace_id`,
        )
        .all(now) as { trace_id: string }[];
      for (const row of rows) deleted.add(row.trace_id);
    });
    for (const [traceId, lifetime] of this.activeTraces)
      if (deleted.has(traceId)) lifetime.expired = true;
  }
  recover(): void {
    this.safe(() =>
      this.db
        .query(
          "UPDATE runtime_spans SET status='unknown',code='PROCESS_INTERRUPTED',finished_at=? WHERE status='started' AND finished_at IS NULL",
        )
        .run(new Date().toISOString()),
    );
  }
  async close(): Promise<void> {
    this.context.disable();
    await this.provider.shutdown();
    this.meta.clear();
    this.activeTraces.clear();
  }
  private persist(span: ReadableSpan, ended: boolean): void {
    const ids = span.spanContext();
    const m: TraceMetadata =
      this.meta.get(ids.spanId) ?? JSON.parse(String(span.attributes.metadata));
    const started = date(span.startTime);
    const lifetime = this.activeTraces.get(ids.traceId);
    const traceState = this.db
      .query(
        `SELECT MIN(expires_at) AS expiry,COALESCE(MAX(status IN('started','unknown')),0) AS protected
        FROM runtime_spans WHERE trace_id=?`,
      )
      .get(ids.traceId) as { expiry: string | null; protected: number };
    // 保全：尚未结束、或落库状态为 started/unknown 的 span，与库里的 started/unknown 行一样
    // 受保护——自动清扫（expire）与续写（persist）都不得清掉在跑/结果未知的证据。
    const active = !ended || m.status === "started" || m.status === "unknown";
    // Freeze a new trace's own retention cap the first time it persists. A trace that already has
    // rows (resumed after a restart, or already written before this setting existed) keeps the MIN
    // of its stored expiry and its sources instead; the current setting is only read for new
    // traces, so it can neither shorten nor extend data written earlier.
    if (lifetime && lifetime.capAt === undefined && traceState.expiry === null) {
      if (span.parentSpanContext) {
        // 父 span 的行已不存在（到期被清）：这是挂回旧 trace 的续写，不能复活成新 cap。
        lifetime.expired = true;
      } else {
        lifetime.capAt =
          lifetime.expiresAt ??
          new Date(Date.parse(started) + this.retentionDays() * 86400_000).toISOString();
      }
    }
    const expires =
      [
        ...(traceState.expiry ? [traceState.expiry] : []),
        ...(lifetime?.expiresAt ? [lifetime.expiresAt] : []),
        ...(lifetime?.capAt ? [lifetime.capAt] : []),
        ...(m.sources ?? []).flatMap((s) => (s.expiresAt ? [s.expiresAt] : [])),
      ].sort()[0] ??
      // Unreachable while a lifetime exists; keeps `expires_at` non-null without consulting a
      // setting the trace never captured.
      new Date(Date.parse(started) + DEFAULT_TRACE_RETENTION_DAYS * 86400_000).toISOString();
    if (lifetime) lifetime.expiresAt = expires;
    if (
      lifetime?.expired ||
      (expires <= new Date().toISOString() && !active && traceState.protected === 0)
    ) {
      this.db.query("DELETE FROM runtime_spans WHERE trace_id=?").run(ids.traceId);
      if (lifetime) lifetime.expired = true;
      return;
    }
    const finished = ended ? date(span.endTime) : null;
    this.db
      .query(`INSERT INTO runtime_spans(trace_id,span_id,parent_span_id,name,user_id,agent_id,conversation_id,run_id,wake_id,output_id,source_seq,channel,stage,status,code,model,started_at,finished_at,duration_ms,expires_at,details)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(span_id) DO UPDATE SET
      run_id=excluded.run_id,conversation_id=excluded.conversation_id,agent_id=excluded.agent_id,
      wake_id=excluded.wake_id,output_id=excluded.output_id,source_seq=excluded.source_seq,
      status=excluded.status,code=excluded.code,model=excluded.model,finished_at=excluded.finished_at,
      duration_ms=excluded.duration_ms,expires_at=MIN(runtime_spans.expires_at,excluded.expires_at),details=excluded.details`)
      .run(
        ids.traceId,
        ids.spanId,
        span.parentSpanContext?.spanId ?? null,
        span.name,
        m.userId ?? DEFAULT_USER_ID,
        m.agentId ?? null,
        m.conversationId ?? null,
        m.runId ?? null,
        m.wakeId ?? null,
        m.outputId ?? null,
        m.sourceSeq ?? null,
        m.channel,
        m.stage,
        m.status ?? "started",
        m.code ?? span.name,
        m.model ?? null,
        started,
        finished,
        ended ? span.duration[0] * 1000 + span.duration[1] / 1e6 : null,
        expires,
        JSON.stringify(m.details ?? {}),
      );
    // Derived execution metadata cannot outlive any source used in its trace.
    this.db
      .query("UPDATE runtime_spans SET expires_at=MIN(expires_at,?) WHERE trace_id=?")
      .run(expires, ids.traceId);
  }
}
