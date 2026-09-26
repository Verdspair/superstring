import type { Database } from "bun:sqlite";
import { type Context, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { RuntimeSpan } from "../../shared/contracts/runtime-observability";
import { DEFAULT_USER_ID } from "../db/repositories";

type Scalar = string | number | boolean | null;
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
  private readonly activeTraces = new Map<
    string,
    { spans: number; expiresAt?: string; expired: boolean }
  >();
  private readonly tracer;
  constructor(readonly db: Database) {
    const processor: SpanProcessor = {
      onStart: (span) => {
        const { traceId } = span.spanContext();
        const lifetime = this.activeTraces.get(traceId) ?? { spans: 0, expired: false };
        lifetime.spans++;
        this.activeTraces.set(traceId, lifetime);
        this.safe(() => this.persist(span as unknown as ReadableSpan, false));
      },
      onEnd: (span) => {
        this.safe(() => this.persist(span, true));
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
  async observe<T>(
    name: string,
    metadata: TraceMetadata,
    work: (scope: TraceScope) => Promise<T>,
  ): Promise<T> {
    const scope = this.start(name, metadata);
    return scope.within(async () => {
      try {
        const result = await work(scope);
        scope.end();
        return result;
      } catch (error) {
        // Error messages may contain provider URLs, input or credentials. Only stable codes are stored.
        const code =
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string" &&
          /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
            ? error.code
            : "OPERATION_FAILED";
        scope.end("failed", code);
        throw error;
      }
    });
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
  expire(now = new Date().toISOString()): void {
    for (const lifetime of this.activeTraces.values()) {
      if (lifetime.expiresAt && lifetime.expiresAt <= now) lifetime.expired = true;
    }
    this.safe(() => this.db.query("DELETE FROM runtime_spans WHERE expires_at<=?").run(now));
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
    const traceExpiry = this.db
      .query("SELECT MIN(expires_at) AS expiry FROM runtime_spans WHERE trace_id=?")
      .get(ids.traceId) as { expiry: string | null };
    const expires = [
      ...(traceExpiry.expiry ? [traceExpiry.expiry] : []),
      ...(lifetime?.expiresAt ? [lifetime.expiresAt] : []),
      new Date(Date.parse(started) + 14 * 86400_000).toISOString(),
      ...(m.sources ?? []).flatMap((s) => (s.expiresAt ? [s.expiresAt] : [])),
    ].sort()[0]!;
    if (lifetime) {
      lifetime.expiresAt = expires;
      lifetime.expired ||= expires <= new Date().toISOString();
    }
    if (lifetime?.expired || expires <= new Date().toISOString()) {
      this.db.query("DELETE FROM runtime_spans WHERE trace_id=?").run(ids.traceId);
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
