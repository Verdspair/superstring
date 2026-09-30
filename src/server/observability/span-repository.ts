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

/** span 通道与状态（契约从 schema 推出，这里按已有导出类型取别名）。 */
type RuntimeChannel = RuntimeSpan["channel"];
type RuntimeSpanStatus = RuntimeSpan["status"];

/** 追踪侧的存储统计/条目/清理结果；只含元数据，正文永远不进入这些结构。 */
export interface TraceStorageCounts {
  traces: { live: number; expired: number; started: number; unknown: number };
  spans: { live: number; expired: number };
}
export interface TraceStorageItem {
  kind: "trace";
  traceId: string;
  at: string;
  lastActivityAt: string;
  status: RuntimeSpanStatus;
  spanCount: number;
  expiresAt: string;
  expired: boolean;
  protected: boolean;
  channels: RuntimeChannel[];
  agentId: string | null;
  conversationId: string | null;
}
export interface TraceStorageFilters {
  status: "all" | "live" | "expired";
  conversationId?: string;
  agentId?: string;
  beforeId?: number;
  limit: number;
}
export interface TraceStoragePage {
  items: TraceStorageItem[];
  nextBeforeId: number;
  hasMore: boolean;
  summary: { total: number; live: number; expired: number };
}
export interface TraceCleanupSelection {
  expired: number;
  protected: number;
  matched: number;
  missing: number;
  ids: string[];
  truncated: boolean;
}
const CLEANUP_ID_LIST_LIMIT = 100;

export class RuntimeSpanRepository {
  constructor(readonly db: Database) {}

  /** 追踪与 span 的物理数量：`expired` 按传入的服务端时间判定，不读客户端时钟。 */
  storageCounts(now: string, userId = DEFAULT_USER_ID): TraceStorageCounts {
    const scope = traceScope(userId);
    const traces = this.db
      .query(`SELECT COUNT(*) AS total,COALESCE(SUM(expired),0) AS expired,
      COALESCE(SUM(started),0) AS started,COALESCE(SUM(unknown),0) AS unknown FROM (
      SELECT s.trace_id,MIN(s.expires_at)<=? AS expired,MAX(s.status='started') AS started,
      MAX(s.status='unknown') AS unknown FROM runtime_spans s WHERE ${scope.where}
      GROUP BY s.trace_id)`)
      .get(now, ...scope.params) as {
      total: number;
      expired: number;
      started: number;
      unknown: number;
    };
    const spans = this.db
      .query(`SELECT COUNT(*) AS total,COALESCE(SUM(s.expires_at<=?),0) AS expired
      FROM runtime_spans s WHERE ${scope.where}`)
      .get(now, ...scope.params) as { total: number; expired: number };
    return {
      traces: {
        live: traces.total - traces.expired,
        expired: traces.expired,
        started: traces.started,
        unknown: traces.unknown,
      },
      spans: { live: spans.total - spans.expired, expired: spans.expired },
    };
  }

  /** 条目列表：到期/未到期、会话与助手过滤，游标是该 trace 最早 span 的 id（新增 span 不会移动分页）。 */
  storageItems(
    filters: TraceStorageFilters,
    now: string,
    userId = DEFAULT_USER_ID,
  ): TraceStoragePage {
    const scope = traceScope(userId);
    const conditions = [scope.where];
    const params: SQLQueryBindings[] = [...scope.params];
    if (filters.agentId) {
      conditions.push("s.agent_id=?");
      params.push(filters.agentId);
    }
    if (filters.conversationId) {
      conditions.push(
        `s.conversation_id IN(SELECT c.id FROM conversations c JOIN conversations anchor ON anchor.id=? WHERE c.channel=anchor.channel AND c.source_id=anchor.source_id AND c.agent_id=anchor.agent_id AND c.user_id=anchor.user_id)`,
      );
      params.push(filters.conversationId);
    }
    const where = conditions.join(" AND ");
    const group = `SELECT s.trace_id AS traceId,MIN(s.id) AS cursorId,MIN(s.started_at) AS at,
      MAX(COALESCE(s.finished_at,s.started_at)) AS lastActivityAt,COUNT(*) AS spanCount,
      MIN(s.expires_at) AS expiresAt,MAX(s.status='started') AS started,
      MAX(s.status='failed') AS failed,MAX(s.status='unknown') AS unknown,
      MAX(s.status='cancelled') AS cancelled,
      (SELECT r.status FROM runtime_spans r WHERE r.trace_id=s.trace_id AND r.stage='run' ORDER BY r.id LIMIT 1) AS runStatus,
      (SELECT r.status FROM runtime_spans r WHERE r.trace_id=s.trace_id ORDER BY r.id LIMIT 1) AS rootStatus,
      GROUP_CONCAT(DISTINCT s.channel) AS channels,MAX(s.agent_id) AS agentId,
      MAX(s.conversation_id) AS conversationId
      FROM runtime_spans s WHERE ${where} GROUP BY s.trace_id`;
    const summary = this.db
      .query(`SELECT COUNT(*) AS total,COALESCE(SUM(expired),0) AS expired FROM (
      SELECT s.trace_id,MIN(s.expires_at)<=? AS expired FROM runtime_spans s WHERE ${where}
      GROUP BY s.trace_id)`)
      .get(now, ...params) as { total: number; expired: number };
    const having = ["1=1"];
    const havingParams: SQLQueryBindings[] = [];
    if (filters.status !== "all") {
      having.push(filters.status === "expired" ? "expiresAt<=?" : "expiresAt>?");
      havingParams.push(now);
    }
    if (filters.beforeId !== undefined) {
      having.push("cursorId<?");
      havingParams.push(filters.beforeId);
    }
    const rows = this.db
      .query(
        `SELECT * FROM (${group}) WHERE ${having.join(" AND ")} ORDER BY cursorId DESC LIMIT ?`,
      )
      .all(...params, ...havingParams, filters.limit + 1) as TraceStorageRow[];
    const pageRows = rows.slice(0, filters.limit);
    return {
      items: pageRows.map(toTraceStorageItem(now)),
      nextBeforeId: pageRows.at(-1)?.cursorId ?? 0,
      hasMore: rows.length > filters.limit,
      summary: {
        total: summary.total,
        live: summary.total - summary.expired,
        expired: summary.expired,
      },
    };
  }

  /**
   * 预览/清理共用的选择器：已到期 trace 中「含 started/unknown span」的保留，其余可删。
   * `matched`/`missing` 只在 ids 模式下有意义（类别模式 matched＝范围内 trace 总数）。
   */
  traceCleanupSelection(
    options: { now: string; userId?: string; ids?: readonly string[] },
    userId = DEFAULT_USER_ID,
  ): TraceCleanupSelection {
    const scope = traceScope(options.userId ?? userId);
    const conditions = [scope.where];
    const params: SQLQueryBindings[] = [...scope.params];
    if (options.ids) {
      conditions.push(`s.trace_id IN (${options.ids.map(() => "?").join(",")})`);
      params.push(...options.ids);
    }
    const where = conditions.join(" AND ");
    const counts = this.db
      .query(`SELECT COUNT(*) AS total,COALESCE(SUM(expired),0) AS expired,
      COALESCE(SUM(expired AND protected),0) AS protected FROM (
      SELECT s.trace_id,MIN(s.expires_at)<=? AS expired,
      (MAX(s.status='started')=1 OR MAX(s.status='unknown')=1) AS protected
      FROM runtime_spans s WHERE ${where} GROUP BY s.trace_id)`)
      .get(options.now, ...params) as { total: number; expired: number; protected: number };
    const ids = this.db
      .query(`SELECT s.trace_id AS traceId FROM runtime_spans s WHERE ${where}
      GROUP BY s.trace_id HAVING MIN(s.expires_at)<=? AND MAX(s.status='started')=0 AND MAX(s.status='unknown')=0
      ORDER BY MIN(s.id) DESC LIMIT ?`)
      .all(...params, options.now, CLEANUP_ID_LIST_LIMIT + 1) as { traceId: string }[];
    return {
      expired: counts.expired,
      protected: counts.protected,
      matched: counts.total,
      missing: options.ids ? Math.max(0, options.ids.length - counts.total) : 0,
      ids: ids.slice(0, CLEANUP_ID_LIST_LIMIT).map((row) => row.traceId),
      truncated: ids.length > CLEANUP_ID_LIST_LIMIT,
    };
  }

  /** 物理删除整条已到期且非 started/unknown 的 trace；返回被删 trace 数与 span 行数。 */
  purgeExpiredTraces(options: { now: string; userId?: string; ids?: readonly string[] }): {
    traces: number;
    spans: number;
  } {
    const scope = traceScope(options.userId ?? DEFAULT_USER_ID);
    const conditions = [scope.where];
    const params: SQLQueryBindings[] = [...scope.params];
    if (options.ids) {
      conditions.push(`s.trace_id IN (${options.ids.map(() => "?").join(",")})`);
      params.push(...options.ids);
    }
    const where = conditions.join(" AND ");
    const eligible = `SELECT s.trace_id FROM runtime_spans s WHERE ${where}
      GROUP BY s.trace_id HAVING MIN(s.expires_at)<=? AND MAX(s.status='started')=0 AND MAX(s.status='unknown')=0`;
    const traces = this.db
      .query(`SELECT COUNT(*) AS n FROM (${eligible})`)
      .get(...params, options.now) as { n: number };
    const changed = this.db
      .query(`DELETE FROM runtime_spans WHERE trace_id IN (${eligible})`)
      .run(...params, options.now).changes;
    return { traces: traces.n, spans: changed };
  }
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
    const matched = spanQuery(filters, userId, now);
    // One scan of the visible spans groups by trace and counts matches per group in the same
    // pass. The earlier shape (visible CTE + matches CTE + a correlated COUNT over matches per
    // group) re-evaluated the match set for every group; on a large span table that took
    // minutes and, because bun:sqlite is synchronous, froze the whole server while it ran.
    const countExpr = matched.filterWhere
      ? `SUM(CASE WHEN ${matched.filterWhere} THEN 1 ELSE 0 END)`
      : "COUNT(*)";
    const cte = `WITH groups AS MATERIALIZED (SELECT * FROM (SELECT s.trace_id AS traceId,MIN(s.id) AS cursorId,
        MAX(s.status='started') AS active,MAX(s.status='failed') AS failed,
        MAX(COALESCE(s.finished_at,s.started_at)) AS lastActivityAt,
        ${countExpr} AS matchedSpanCount
        FROM runtime_spans s WHERE ${matched.visibilityWhere} GROUP BY s.trace_id)
        WHERE matchedSpanCount>0)`;
    // Text order inside the statement: the CASE's filter placeholders come before the scan's
    // visibility placeholders, so the filter params bind first.
    const params = [...matched.filterParams, ...matched.visibilityParams];
    const summary = this.db
      .query(`${cte} SELECT COUNT(*) AS totalTraces,
      COALESCE(SUM(active),0) AS activeTraces,COALESCE(SUM(failed),0) AS failedTraces,
      COALESCE(SUM(matchedSpanCount),0) AS matchedSpans,MAX(lastActivityAt) AS lastActivityAt FROM groups`)
      .get(...params) as Omit<RuntimeTracesPage["summary"], "now">;
    const limit = filters.limit ?? 50;
    const groups = this.db
      .query(`${cte} SELECT traceId,matchedSpanCount FROM groups
      ${filters.beforeId ? "WHERE cursorId<?" : ""} ORDER BY cursorId DESC LIMIT ?`)
      .all(...params, ...(filters.beforeId ? [filters.beforeId] : []), limit + 1) as {
      traceId: string;
      matchedSpanCount: number;
    }[];
    const items = groups
      .slice(0, limit)
      .map((group) =>
        summarizeTrace(this.traceSpans(group.traceId, userId, now), group.matchedSpanCount, now),
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

const CONVERSATION_VISIBILITY = `(s.conversation_id IS NULL OR EXISTS (
      SELECT 1 FROM conversations c WHERE c.id=s.conversation_id AND c.user_id=s.user_id AND
      ((c.channel='web' AND EXISTS(SELECT 1 FROM sessions x WHERE x.id=c.source_id AND x.agent_id=c.agent_id AND x.user_id=c.user_id)) OR
       (c.channel='onebot11' AND EXISTS(SELECT 1 FROM qq_bindings b WHERE b.id=c.source_id AND b.agent_id=c.agent_id)))))`;

/**
 * 追踪可见性：本机 principal + 会话归属复验，与 `spanQuery` 的可见集逐字一致，只少了到期过滤。
 * 存储统计/清理只按它过滤——来源失效行本来就不可见，但它们仍要被物理清点。
 */
function traceScope(userId: string): { where: string; params: SQLQueryBindings[] } {
  return { where: `s.user_id=? AND ${CONVERSATION_VISIBILITY}`, params: [userId] };
}

type TraceStorageRow = {
  traceId: string;
  cursorId: number;
  at: string;
  lastActivityAt: string;
  spanCount: number;
  expiresAt: string;
  started: number;
  failed: number;
  unknown: number;
  cancelled: number;
  runStatus: RuntimeSpanStatus | null;
  rootStatus: RuntimeSpanStatus | null;
  channels: string | null;
  agentId: string | null;
  conversationId: string | null;
};

/** 列表项的派生状态与 `summarizeTrace` 同一优先级；到期只按传入的服务端时间判断。 */
function toTraceStorageItem(now: string) {
  return (row: TraceStorageRow): TraceStorageItem => {
    const expired = row.expiresAt <= now;
    const status: RuntimeSpanStatus = row.started
      ? "started"
      : row.failed
        ? "failed"
        : row.unknown
          ? "unknown"
          : row.cancelled
            ? "cancelled"
            : (row.runStatus ?? row.rootStatus ?? "observed");
    return {
      kind: "trace",
      traceId: row.traceId,
      at: row.at,
      lastActivityAt: row.lastActivityAt,
      status,
      spanCount: row.spanCount,
      expiresAt: row.expiresAt,
      expired,
      protected: expired && (row.started === 1 || row.unknown === 1),
      channels: (row.channels ?? "").split(",").filter((value) => value !== "") as RuntimeChannel[],
      agentId: row.agentId,
      conversationId: row.conversationId,
    };
  };
}

function spanQuery(filters: RuntimeSpanFilters, userId: string, now: string) {
  const visibility = ["s.user_id=?", "s.expires_at>?", CONVERSATION_VISIBILITY];
  const visibilityParams: SQLQueryBindings[] = [userId, now];
  const conditions: string[] = [];
  const filterParams: SQLQueryBindings[] = [];
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
      filterParams.push(value);
    }
  }
  if (filters.conversationId) {
    conditions.push(
      `s.conversation_id IN(SELECT c.id FROM conversations c JOIN conversations anchor ON anchor.id=? WHERE c.channel=anchor.channel AND c.source_id=anchor.source_id AND c.agent_id=anchor.agent_id AND c.user_id=anchor.user_id)`,
    );
    filterParams.push(filters.conversationId);
  }
  if (filters.from) {
    conditions.push("s.started_at>=?");
    filterParams.push(new Date(filters.from).toISOString());
  }
  if (filters.to) {
    conditions.push("s.started_at<=?");
    filterParams.push(new Date(filters.to).toISOString());
  }
  if (filters.q) {
    conditions.push(
      "instr(lower(s.name||' '||s.code||' '||s.trace_id||' '||s.span_id||' '||COALESCE(s.run_id,'')||' '||COALESCE(s.wake_id,'')||' '||COALESCE(s.output_id,'')||' '||COALESCE(s.model,'')||' '||s.details),lower(?))>0",
    );
    filterParams.push(filters.q);
  }
  const where = [...visibility, ...conditions].join(" AND ");
  // The pieces travel too: `traces` needs the visibility predicate alone plus the filters as a
  // per-row boolean, so one scan can both group by trace and count matches without rescanning.
  return {
    where,
    params: [...visibilityParams, ...filterParams],
    visibilityWhere: visibility.join(" AND "),
    visibilityParams,
    filterWhere: conditions.join(" AND "),
    filterParams,
  };
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
    causes: unique(
      items.map((item) => (typeof item.details.cause === "string" ? item.details.cause : null)),
    ),
    specIds: unique(
      items.map((item) => (typeof item.details.specId === "string" ? item.details.specId : null)),
    ),
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
