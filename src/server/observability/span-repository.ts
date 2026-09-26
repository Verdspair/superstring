import type { Database, SQLQueryBindings } from "bun:sqlite";
import type {
  RuntimeSpan,
  RuntimeSpanFilters,
  RuntimeSpansPage,
  RuntimeTrace,
  RuntimeTraceDetail,
  RuntimeTracesPage,
} from "../../shared/contracts/runtime-observability";
import { DEFAULT_USER_ID } from "../db/repositories";

export class RuntimeSpanRepository {
  constructor(readonly db: Database) {}
  page(
    filters: RuntimeSpanFilters,
    userId = DEFAULT_USER_ID,
    now = new Date().toISOString(),
  ): RuntimeSpansPage {
    const { where, params } = spanQuery(filters, userId, now);
    const summary = this.db
      .query(
        `SELECT COUNT(*) AS total,COALESCE(SUM(status='started'),0) AS active,COALESCE(SUM(status='failed'),0) AS failed,COALESCE(SUM(status='unknown'),0) AS unknown,MAX(COALESCE(finished_at,started_at)) AS lastActivityAt FROM runtime_spans s WHERE ${where}`,
      )
      .get(...params) as RuntimeSpansPage["summary"];
    const limit = filters.limit ?? 100;
    const rows = this.db
      .query(
        `SELECT id,trace_id AS traceId,span_id AS spanId,parent_span_id AS parentSpanId,name,started_at AS at,finished_at AS finishedAt,duration_ms AS durationMs,channel,stage,status,code,model,conversation_id AS conversationId,agent_id AS agentId,run_id AS runId,wake_id AS wakeId,output_id AS outputId,source_seq AS sourceSeq,details FROM runtime_spans s WHERE ${where}${filters.beforeId ? " AND id<?" : ""} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, ...(filters.beforeId ? [filters.beforeId] : []), limit + 1) as (Omit<
      RuntimeSpan,
      "details"
    > & { details: string })[];
    const items = rows.slice(0, limit).map((r) => ({ ...r, details: JSON.parse(r.details) }));
    return {
      items,
      nextBeforeId: items.at(-1)?.id ?? 0,
      hasMore: rows.length > limit,
      summary: { ...summary, now },
    };
  }
  traces(
    filters: RuntimeSpanFilters,
    userId = DEFAULT_USER_ID,
    now = new Date().toISOString(),
  ): RuntimeTracesPage {
    const visible = spanQuery({}, userId, now);
    const matched = spanQuery(filters, userId, now);
    const cte = `WITH visible AS (SELECT * FROM runtime_spans s WHERE ${visible.where}),
      matches AS (SELECT s.id,s.trace_id FROM runtime_spans s WHERE ${matched.where}),
      groups AS (SELECT s.trace_id,MIN(s.id) AS cursorId,
        MAX(s.status='started') AS active,MAX(s.status='failed') AS failed,
        MAX(COALESCE(s.finished_at,s.started_at)) AS lastActivityAt,
        (SELECT COUNT(*) FROM matches m WHERE m.trace_id=s.trace_id) AS matchedSpanCount
        FROM visible s WHERE s.trace_id IN(SELECT trace_id FROM matches) GROUP BY s.trace_id)`;
    const params = [...visible.params, ...matched.params];
    const summary = this.db
      .query(`${cte} SELECT COUNT(*) AS totalTraces,
      COALESCE(SUM(active),0) AS activeTraces,COALESCE(SUM(failed),0) AS failedTraces,
      COALESCE(SUM(matchedSpanCount),0) AS matchedSpans,MAX(lastActivityAt) AS lastActivityAt FROM groups`)
      .get(...params) as Omit<RuntimeTracesPage["summary"], "now">;
    const limit = filters.limit ?? 50;
    const groups = this.db
      .query(`${cte} SELECT trace_id,matchedSpanCount FROM groups
      ${filters.beforeId ? "WHERE cursorId<?" : ""} ORDER BY cursorId DESC LIMIT ?`)
      .all(...params, ...(filters.beforeId ? [filters.beforeId] : []), limit + 1) as {
      trace_id: string;
      matchedSpanCount: number;
    }[];
    const items = groups
      .slice(0, limit)
      .map((group) =>
        summarizeTrace(this.traceSpans(group.trace_id, userId, now), group.matchedSpanCount, now),
      );
    return {
      items,
      nextBeforeId: items.at(-1)?.cursorId ?? 0,
      hasMore: groups.length > limit,
      summary: { ...summary, now },
    };
  }

  waterfall(
    traceId: string,
    filters: RuntimeSpanFilters,
    userId = DEFAULT_USER_ID,
    now = new Date().toISOString(),
  ): RuntimeTraceDetail | null {
    const items = this.traceSpans(traceId, userId, now);
    if (!items.length) return null;
    const matched = spanQuery({ ...filters, traceId }, userId, now);
    const matchedSpanIds = (
      this.db
        .query(`SELECT span_id FROM runtime_spans s WHERE ${matched.where}`)
        .all(...matched.params) as { span_id: string }[]
    ).map((r) => r.span_id);
    return { now, items, matchedSpanIds, trace: summarizeTrace(items, matchedSpanIds.length, now) };
  }

  private traceSpans(traceId: string, userId: string, now: string): RuntimeSpan[] {
    const { where, params } = spanQuery({ traceId }, userId, now);
    const rows = this.db
      .query(`SELECT id,trace_id AS traceId,span_id AS spanId,parent_span_id AS parentSpanId,
      name,started_at AS at,finished_at AS finishedAt,duration_ms AS durationMs,channel,stage,status,code,model,
      conversation_id AS conversationId,agent_id AS agentId,run_id AS runId,wake_id AS wakeId,output_id AS outputId,
      source_seq AS sourceSeq,details FROM runtime_spans s WHERE ${where} ORDER BY id ASC`)
      .all(...params) as (Omit<RuntimeSpan, "details"> & { details: string })[];
    return rows.map((row) => ({ ...row, details: JSON.parse(row.details) }));
  }
}

function spanQuery(filters: RuntimeSpanFilters, userId: string, now: string) {
  const conditions = [
    "s.user_id=?",
    "s.expires_at>?",
    `(s.conversation_id IS NULL OR EXISTS (
      SELECT 1 FROM conversations c WHERE c.id=s.conversation_id AND c.user_id=s.user_id AND
      ((c.channel='web' AND EXISTS(SELECT 1 FROM sessions x WHERE x.id=c.source_id AND x.agent_id=c.agent_id AND x.user_id=c.user_id)) OR
       (c.channel='onebot11' AND EXISTS(SELECT 1 FROM qq_bindings b WHERE b.id=c.source_id AND b.agent_id=c.agent_id)))))`,
  ];
  const params: SQLQueryBindings[] = [userId, now];
  const fields = {
    channel: "channel",
    stage: "stage",
    status: "status",
    model: "model",
    agentId: "agent_id",
    runId: "run_id",
    traceId: "trace_id",
  } as const;
  for (const [key, column] of Object.entries(fields)) {
    const value = filters[key as keyof typeof fields];
    if (value) {
      conditions.push(`s.${column}=?`);
      params.push(value);
    }
  }
  if (filters.conversationId) {
    conditions.push(
      `s.conversation_id IN(SELECT c.id FROM conversations c JOIN conversations anchor ON anchor.id=? WHERE c.channel=anchor.channel AND c.source_id=anchor.source_id AND c.agent_id=anchor.agent_id AND c.user_id=anchor.user_id)`,
    );
    params.push(filters.conversationId);
  }
  if (filters.from) {
    conditions.push("s.started_at>=?");
    params.push(new Date(filters.from).toISOString());
  }
  if (filters.to) {
    conditions.push("s.started_at<=?");
    params.push(new Date(filters.to).toISOString());
  }
  if (filters.q) {
    conditions.push(
      "instr(lower(s.name||' '||s.code||' '||s.trace_id||' '||s.span_id||' '||COALESCE(s.run_id,'')||' '||COALESCE(s.wake_id,'')||' '||COALESCE(s.output_id,'')||' '||COALESCE(s.model,'')||' '||s.details),lower(?))>0",
    );
    params.push(filters.q);
  }
  const where = conditions.join(" AND ");
  return { where, params };
}

function summarizeTrace(items: RuntimeSpan[], matchedSpanCount: number, now: string): RuntimeTrace {
  const ids = new Set(items.map((item) => item.spanId));
  const root = items.find((item) => !item.parentSpanId || !ids.has(item.parentSpanId)) ?? items[0];
  const at = items.map((item) => item.at).sort()[0];
  const lastActivityAt = items.reduce((latest, item) => {
    const timestamp = item.finishedAt ?? item.at;
    return timestamp > latest ? timestamp : latest;
  }, at);
  const active = items.some((item) => item.status === "started");
  const status = active
    ? "started"
    : items.some((item) => item.status === "failed")
      ? "failed"
      : items.some((item) => item.status === "unknown")
        ? "unknown"
        : items.some((item) => item.status === "cancelled")
          ? "cancelled"
          : (items.find((item) => item.stage === "run")?.status ?? root.status);
  const unique = (values: (string | null)[]) => [
    ...new Set(values.filter((value): value is string => value !== null)),
  ];
  return {
    traceId: root.traceId,
    cursorId: items[0].id,
    root,
    at,
    lastActivityAt,
    finishedAt: active ? null : lastActivityAt,
    durationMs: Math.max(0, Date.parse(active ? now : lastActivityAt) - Date.parse(at)),
    status,
    spanCount: items.length,
    matchedSpanCount,
    models: unique(items.map((item) => item.model)),
    channels: [...new Set(items.map((item) => item.channel))],
    runIds: unique(items.map((item) => item.runId)),
    wakeIds: unique(items.map((item) => item.wakeId)),
  };
}
