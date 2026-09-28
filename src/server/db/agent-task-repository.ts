import type { Database, SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  AgentTask,
  TaskCall,
  TaskFilters,
  TaskList,
  TaskSummary,
} from "../../shared/contracts/agent-task";
import type { SourceRef } from "../../shared/contracts/evidence";

type TaskRow = {
  id: string;
  conversation_id: string;
  agent_id: string;
  origin_run_id: string | null;
  status: AgentTask["status"];
  sources: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  error_code: string | null;
};
export class AgentTaskRepository {
  constructor(readonly db: Database) {}
  get(id: string): AgentTask | null {
    const row = this.db.query("SELECT * FROM agent_tasks WHERE id=?").get(id) as TaskRow | null;
    if (!row) return null;
    const calls = this.db
      .query(`SELECT ordinal,name,revision,effect,arguments,status,
      approval_revision AS approvalRevision,result,error_code AS errorCode
      FROM agent_task_calls WHERE task_id=? ORDER BY ordinal`)
      .all(id) as (Omit<TaskCall, "arguments" | "result"> & {
      arguments: string | null;
      result: string | null;
    })[];
    return {
      id,
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      originRunId: row.origin_run_id,
      status: row.status,
      sources: JSON.parse(row.sources),
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      errorCode: row.error_code,
      calls: calls.map((call) => ({
        ...call,
        arguments: call.arguments === null ? null : JSON.parse(call.arguments),
        result: call.result === null ? null : JSON.parse(call.result),
      })),
    };
  }
  list(conversationId: string): AgentTask[] {
    return (
      this.db
        .query(
          "SELECT id FROM agent_tasks WHERE conversation_id=? ORDER BY created_at DESC,id LIMIT 100",
        )
        .all(conversationId) as { id: string }[]
    ).map(({ id }) => this.get(id) as AgentTask);
  }
  page(filters: TaskFilters, userId: string): TaskList {
    const conditions = [
      "c.user_id=?",
      "c.closed_at IS NULL",
      "c.agent_id=t.agent_id",
      `((c.channel='web' AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=c.source_id AND s.user_id=c.user_id AND s.agent_id=c.agent_id))
      OR (c.channel='onebot11' AND EXISTS(SELECT 1 FROM qq_bindings b JOIN agents a ON a.id=b.agent_id WHERE b.id=c.source_id AND b.agent_id=c.agent_id)))`,
    ];
    const params: SQLQueryBindings[] = [userId];
    const fields = {
      conversationId: "conversation_id",
      agentId: "agent_id",
      status: "status",
      originRunId: "origin_run_id",
    } as const;
    for (const [key, column] of Object.entries(fields)) {
      const value = filters[key as keyof typeof fields];
      if (value) {
        conditions.push(`t.${column}=?`);
        params.push(value);
      }
    }
    if (filters.cursor) {
      conditions.push("(t.created_at<? OR (t.created_at=? AND t.id<?))");
      params.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id);
    }
    const rows = this.db
      .query(`SELECT t.id,t.conversation_id AS conversationId,t.agent_id AS agentId,
      t.origin_run_id AS originRunId,t.status,t.created_at AS createdAt,t.updated_at AS updatedAt,
      t.expires_at AS expiresAt,t.error_code AS errorCode,
      (SELECT COUNT(*) FROM agent_task_calls a WHERE a.task_id=t.id) AS callCount,
      (SELECT COUNT(*) FROM agent_task_calls a WHERE a.task_id=t.id AND a.status='completed') AS completedCallCount,
      (SELECT MIN(ordinal) FROM agent_task_calls a WHERE a.task_id=t.id AND a.status IN('running','waiting_approval')) AS waitingOrdinal,
      CASE t.status WHEN 'waiting_tool' THEN 'tool' WHEN 'waiting_approval' THEN 'approval' END AS waitingReason
      FROM agent_tasks t JOIN conversations c ON c.id=t.conversation_id
      WHERE ${conditions.join(" AND ")} ORDER BY t.created_at DESC,t.id DESC LIMIT ?`)
      .all(...params, filters.limit + 1) as TaskSummary[];
    const items = rows.slice(0, filters.limit);
    const last = items.at(-1);
    const hasMore = rows.length > filters.limit;
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && last ? JSON.stringify({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }
  enqueue(input: {
    conversationId: string;
    agentId: string;
    originRunId?: string;
    dedupeKey: string;
    sources: readonly SourceRef[];
    at: string;
    expiresAt: string;
    calls: readonly Pick<TaskCall, "name" | "revision" | "effect" | "arguments">[];
  }): AgentTask {
    return this.db
      .transaction(() => {
        const old = this.db
          .query("SELECT id FROM agent_tasks WHERE dedupe_key=?")
          .get(input.dedupeKey) as { id: string } | null;
        if (old) return this.get(old.id) as AgentTask;
        const id = randomUUID();
        this.db
          .query(`INSERT INTO agent_tasks(id,conversation_id,agent_id,origin_run_id,dedupe_key,status,sources,created_at,updated_at,expires_at)
        VALUES(?,?,?,?,?,'queued',?,?,?,?)`)
          .run(
            id,
            input.conversationId,
            input.agentId,
            input.originRunId ?? null,
            input.dedupeKey,
            JSON.stringify(input.sources),
            input.at,
            input.at,
            input.expiresAt,
          );
        for (const [ordinal, call] of input.calls.entries())
          this.db
            .query(`INSERT INTO agent_task_calls(task_id,ordinal,name,revision,effect,arguments,status)
          VALUES(?,?,?,?,?,?,'pending')`)
            .run(
              id,
              ordinal,
              call.name,
              call.revision,
              call.effect,
              JSON.stringify(call.arguments),
            );
        return this.get(id) as AgentTask;
      })
      .immediate();
  }
  claim(
    at: string,
    leaseMs: number,
    pausedNames: readonly string[] = [],
    pausedPrefixes: readonly string[] = [],
  ): AgentTask | null {
    return this.db
      .transaction(() => {
        this.recover(at);
        const row = this.db
          .query(
            `SELECT t.id FROM agent_tasks t WHERE t.status='queued' AND t.expires_at>?
           AND NOT EXISTS(SELECT 1 FROM agent_tasks active WHERE active.conversation_id=t.conversation_id AND active.status IN('running','waiting_tool'))
           AND NOT EXISTS(SELECT 1 FROM agent_task_calls call WHERE call.task_id=t.id AND call.status!='completed'
             AND (call.name IN (SELECT value FROM json_each(?))
               OR EXISTS(SELECT 1 FROM json_each(?) p WHERE substr(call.name,1,length(p.value))=p.value)))
           ORDER BY t.created_at,t.id LIMIT 1`,
          )
          .get(at, JSON.stringify(pausedNames), JSON.stringify(pausedPrefixes)) as {
          id: string;
        } | null;
        if (!row) return null;
        this.db
          .query(
            "UPDATE agent_tasks SET status='running',lease_token=?,lease_expires_at=?,updated_at=? WHERE id=?",
          )
          .run(randomUUID(), new Date(Date.parse(at) + leaseMs).toISOString(), at, row.id);
        return this.get(row.id);
      })
      .immediate();
  }
  owns(id: string, token: string, at: string): boolean {
    return (
      this.db
        .query(
          "SELECT 1 FROM agent_tasks WHERE id=? AND lease_token=? AND lease_expires_at>? AND status IN('running','waiting_tool')",
        )
        .get(id, token, at) !== null
    );
  }
  renew(id: string, token: string, at: string, leaseMs: number): boolean {
    return (
      this.db
        .query(`UPDATE agent_tasks SET lease_expires_at=? WHERE id=? AND lease_token=?
      AND lease_expires_at>? AND status IN('running','waiting_tool')`)
        .run(new Date(Date.parse(at) + leaseMs).toISOString(), id, token, at).changes === 1
    );
  }
  assertOwned(id: string, token: string, at: string): void {
    if (!this.owns(id, token, at))
      throw Object.assign(new Error("TASK_LEASE_LOST"), { code: "TASK_LEASE_LOST" });
  }
  waitApproval(id: string, token: string, ordinal: number, approval: string, at: string): void {
    this.db
      .transaction(() => {
        this.assertOwned(id, token, at);
        this.db
          .query(
            "UPDATE agent_task_calls SET status='waiting_approval',approval_revision=? WHERE task_id=? AND ordinal=?",
          )
          .run(approval, id, ordinal);
        this.settle(id, "waiting_approval", at);
      })
      .immediate();
  }
  approve(id: string, ordinal: number, approval: string, at: string): boolean {
    return this.db
      .transaction(() => {
        const task = this.get(id);
        if (task?.status !== "waiting_approval" || task.expiresAt <= at) return false;
        const changed = this.db
          .query(`UPDATE agent_task_calls SET status='approved'
        WHERE task_id=? AND ordinal=? AND status='waiting_approval' AND approval_revision=?`)
          .run(id, ordinal, approval).changes;
        if (!changed) return false;
        this.settle(id, "queued", at);
        return true;
      })
      .immediate();
  }
  beginCall(id: string, token: string, ordinal: number, at: string): void {
    this.db
      .transaction(() => {
        this.assertOwned(id, token, at);
        const changed = this.db
          .query(
            `UPDATE agent_task_calls SET status='running' WHERE task_id=? AND ordinal=? AND status IN('pending','approved')`,
          )
          .run(id, ordinal).changes;
        if (!changed) throw new Error("TASK_CALL_STATE_INVALID");
        this.db
          .query("UPDATE agent_tasks SET status='waiting_tool',updated_at=? WHERE id=?")
          .run(at, id);
      })
      .immediate();
  }
  completeCall(
    id: string,
    token: string,
    ordinal: number,
    result: unknown,
    sources: readonly SourceRef[],
    at: string,
  ): void {
    this.db
      .transaction(() => {
        this.assertOwned(id, token, at);
        this.db
          .query(
            "UPDATE agent_task_calls SET status='completed',result=? WHERE task_id=? AND ordinal=? AND status='running'",
          )
          .run(JSON.stringify(result), id, ordinal);
        const expiry = sources
          .flatMap((source) => (source.expiresAt ? [source.expiresAt] : []))
          .sort()[0];
        this.db
          .query(
            "UPDATE agent_tasks SET status='running',sources=?,updated_at=?,expires_at=MIN(expires_at,COALESCE(?,expires_at)) WHERE id=?",
          )
          .run(JSON.stringify(sources), at, expiry ?? null, id);
      })
      .immediate();
  }
  settle(id: string, status: AgentTask["status"], at: string, code?: string): void {
    this.db
      .query(
        "UPDATE agent_tasks SET status=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?,error_code=? WHERE id=?",
      )
      .run(status, at, code ?? null, id);
  }
  interrupt(id: string, at: string, status: "failed" | "cancelled", code: string): void {
    this.db
      .transaction(() => {
        const unknown =
          this.db
            .query(
              "SELECT 1 FROM agent_task_calls WHERE task_id=? AND status='running' AND effect='write'",
            )
            .get(id) !== null;
        this.db
          .query(`UPDATE agent_task_calls SET status=CASE WHEN status='running' AND effect='write' THEN 'unknown' ELSE ? END,error_code=?
        WHERE task_id=? AND status NOT IN('completed','unknown','failed','cancelled')`)
          .run(status, code, id);
        this.settle(id, unknown ? "unknown" : status, at, code);
      })
      .immediate();
  }
  recover(at: string): void {
    for (const row of this.db
      .query(
        "SELECT id FROM agent_tasks WHERE status IN('running','waiting_tool') AND lease_expires_at<=?",
      )
      .all(at) as { id: string }[]) {
      const unknown = this.db
        .query(
          "SELECT 1 FROM agent_task_calls WHERE task_id=? AND status='running' AND effect='write'",
        )
        .get(row.id);
      if (unknown) this.interrupt(row.id, at, "failed", "TASK_OUTCOME_UNKNOWN");
      else {
        this.db
          .query(
            "UPDATE agent_task_calls SET status='pending' WHERE task_id=? AND status='running'",
          )
          .run(row.id);
        this.settle(row.id, "queued", at);
      }
    }
  }
  redact(id: string, at: string, code: string): void {
    this.db
      .transaction(() => {
        const task = this.get(id);
        if (task && !["completed", "failed", "cancelled", "unknown"].includes(task.status))
          this.interrupt(id, at, "failed", code);
        this.db
          .query("UPDATE agent_task_calls SET arguments=NULL,result=NULL WHERE task_id=?")
          .run(id);
      })
      .immediate();
  }
  expire(at: string): void {
    for (const { id } of this.db
      .query(`SELECT id FROM agent_tasks WHERE expires_at<=? AND EXISTS(
        SELECT 1 FROM agent_task_calls WHERE task_id=agent_tasks.id AND (arguments IS NOT NULL OR result IS NOT NULL))`)
      .all(at) as { id: string }[])
      this.redact(id, at, "TASK_EXPIRED");
  }
}
