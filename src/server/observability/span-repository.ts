import type { Database, SQLQueryBindings } from "bun:sqlite";
import type {
  RuntimeSpan,
  RuntimeSpanFilters,
  RuntimeSpansPage,
} from "../../shared/contracts/runtime-observability";
import { DEFAULT_USER_ID } from "../db/repositories";

export class RuntimeSpanRepository {
  constructor(readonly db: Database) {}
  page(
    filters: RuntimeSpanFilters,
    userId = DEFAULT_USER_ID,
    now = new Date().toISOString(),
  ): RuntimeSpansPage {
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
}
