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
import { publishConversationChange } from "../conversation/conversation-changes";
import { DEFAULT_USER_ID } from "./repositories";

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

/** 任务 payload 的存储统计/条目/清理（只含元数据，`arguments`/`result` 永不进入这些结构）。 */
export interface TaskPayloadStorageCounts {
  /** 未到期且仍有 arguments/result 的任务数。 */
  live: number;
  /** 已到期且仍有 arguments/result 的任务数。 */
  expired: number;
  /** 已到期但按保全规则不能清理的任务数。 */
  protected: number;
  /** 已到期且可清理的任务数。 */
  removable: number;
}
export interface TaskPayloadStorageItem {
  kind: "task_payload";
  taskId: string;
  conversationId: string;
  agentId: string;
  status: AgentTask["status"];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  expired: boolean;
  /** 已到期但按保全规则不能清理（任务未终态，或调用在跑/待批准/结果未知）。 */
  protected: boolean;
  callCount: number;
  payloadCallCount: number;
}
export interface TaskPayloadStorageFilters {
  status: "all" | "live" | "expired";
  conversationId?: string;
  agentId?: string;
  before?: { createdAt: string; id: string };
  limit: number;
}
export interface TaskPayloadStoragePage {
  items: TaskPayloadStorageItem[];
  hasMore: boolean;
  summary: { total: number; live: number; expired: number };
}
export interface TaskPayloadCleanupSelection {
  expired: number;
  protected: number;
  matched: number;
  missing: number;
  ids: string[];
  truncated: boolean;
}
/** 仍有 payload 的任务（自动到期的清理相位与手动清理共用同一存在性判定）。 */
const TASK_PAYLOAD_SQL = `EXISTS(SELECT 1 FROM agent_task_calls pc WHERE pc.task_id=t.id AND (pc.arguments IS NOT NULL OR pc.result IS NOT NULL))`;
/**
 * 保全规则：任务不在终态（completed/failed/cancelled），或有调用在跑/待批准/结果未知时，
 * 即使到期也不清 payload——在跑与未知效果必须保住结果证据。手动清理按当前状态直接判定；
 * 自动到期会先把到期未终态的任务安全 interrupt（见 expire），被 interrupt 的这批在当次仍保
 * payload，从下一 tick 起才按终态参与清理判定，unknown 调用恒保。
 */
const TASK_PROTECTION_SQL = `(t.status NOT IN('completed','failed','cancelled') OR EXISTS(SELECT 1 FROM agent_task_calls bc WHERE bc.task_id=t.id AND bc.status IN('running','waiting_approval','unknown')))`;
const CLEANUP_ID_LIST_LIMIT = 100;

/**
 * 任务存储的可见范围：与任务列表页相同的用户/会话来源复验，但包含已关闭会话——
 * 存储清点针对磁盘，不因会话关闭而隐藏（关闭的会话仍属同一 principal）。
 */
function taskScope(userId: string): { where: string; params: string[] } {
  return {
    where: `c.user_id=? AND c.agent_id=t.agent_id AND ((c.channel='web' AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=c.source_id AND s.user_id=c.user_id AND s.agent_id=c.agent_id)) OR (c.channel='onebot11' AND EXISTS(SELECT 1 FROM qq_bindings b JOIN agents a ON a.id=b.agent_id WHERE b.id=c.source_id AND b.agent_id=c.agent_id)))`,
    params: [userId],
  };
}
type TaskPayloadStorageRow = {
  taskId: string;
  conversationId: string;
  agentId: string;
  status: AgentTask["status"];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  callCount: number;
  payloadCallCount: number;
  blocked: number;
};
export class AgentTaskRepository {
  constructor(readonly db: Database) {}

  /** Task state changes notify the owning conversation through the existing hub. */
  private notifyTask(id: string): void {
    const row = this.db.query("SELECT conversation_id FROM agent_tasks WHERE id=?").get(id) as {
      conversation_id: string;
    } | null;
    if (row) publishConversationChange(this.db, row.conversation_id);
  }
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
        this.notifyTask(id);
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
        this.notifyTask(row.id);
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
        this.notifyTask(id);
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
        this.notifyTask(id);
      })
      .immediate();
  }
  settle(id: string, status: AgentTask["status"], at: string, code?: string): void {
    this.db
      .query(
        "UPDATE agent_tasks SET status=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?,error_code=? WHERE id=?",
      )
      .run(status, at, code ?? null, id);
    this.notifyTask(id);
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
  /**
   * 自动到期（worker 巡检相位，与手动清理分开）：
   * 1）先对到期仍未终态的任务（queued/running/waiting_tool/waiting_approval）各做一次安全
   *    interrupt：running write → unknown（绝不重放），其余未完成调用 → failed；任务落到
   *    failed/unknown 并记 TASK_EXPIRED——过期任务不能继续占活动状态、不能被领取或批准；
   * 2）本相位不清 payload：刚离开非终态的这批任务在 interrupt 的当次仍保留物理 args/result
   *    （含被取消的 waiting_approval 调用），从下一 tick 起才以终态重新参与清理判定；
   * 3）到期且按 interrupt 前 prestate 已终态、无 running/waiting_approval/unknown 调用的任务
   *    照旧在本相位清 payload；unknown 调用永久保全（fail-closed 证据，不重放）。
   * 手动清理与手动的 redact 路径判定不变。
   */
  expire(at: string): void {
    // 两个集合都按 interrupt 前的 prestate 计算：非终态任务不会被同一相位清 payload。
    const interrupted = (
      this.db
        .query(
          "SELECT id FROM agent_tasks WHERE expires_at<=? AND status IN('queued','running','waiting_tool','waiting_approval')",
        )
        .all(at) as { id: string }[]
    ).map((row) => row.id);
    const removable = (
      this.db
        .query(
          `SELECT t.id FROM agent_tasks t WHERE t.expires_at<=? AND ${TASK_PAYLOAD_SQL} AND NOT ${TASK_PROTECTION_SQL}`,
        )
        .all(at) as { id: string }[]
    ).map((row) => row.id);
    for (const id of interrupted) this.interrupt(id, at, "failed", "TASK_EXPIRED");
    for (const id of removable) this.redact(id, at, "TASK_EXPIRED");
  }

  /** payload 存储统计：`live`/`expired` 只看仍有 arguments/result 的任务；到期按服务端时间。 */
  taskPayloadStorageCounts(now: string, userId = DEFAULT_USER_ID): TaskPayloadStorageCounts {
    const scope = taskScope(userId);
    return this.db
      .query(`SELECT
      COALESCE(SUM(payload AND expires_at>?),0) AS live,
      COALESCE(SUM(payload AND expires_at<=?),0) AS expired,
      COALESCE(SUM(payload AND expires_at<=? AND blocked),0) AS protected,
      COALESCE(SUM(payload AND expires_at<=? AND NOT blocked),0) AS removable
      FROM (SELECT t.expires_at,${TASK_PAYLOAD_SQL} AS payload,${TASK_PROTECTION_SQL} AS blocked
        FROM agent_tasks t JOIN conversations c ON c.id=t.conversation_id WHERE ${scope.where})`)
      .get(now, now, now, now, ...scope.params) as TaskPayloadStorageCounts;
  }

  /** payload 条目（只元数据）：到期与保护状态、调用数与带 payload 的调用数；游标不因新任务移动。 */
  taskPayloadStorageItems(
    filters: TaskPayloadStorageFilters,
    now: string,
    userId = DEFAULT_USER_ID,
  ): TaskPayloadStoragePage {
    const scope = taskScope(userId);
    const conditions = [scope.where];
    const params: SQLQueryBindings[] = [...scope.params];
    if (filters.agentId) {
      conditions.push("t.agent_id=?");
      params.push(filters.agentId);
    }
    if (filters.conversationId) {
      conditions.push("t.conversation_id=?");
      params.push(filters.conversationId);
    }
    if (filters.before) {
      conditions.push("(t.created_at<? OR (t.created_at=? AND t.id<?))");
      params.push(filters.before.createdAt, filters.before.createdAt, filters.before.id);
    }
    const where = conditions.join(" AND ");
    const statusWhere =
      filters.status === "expired"
        ? " AND t.expires_at<=?"
        : filters.status === "live"
          ? " AND t.expires_at>?"
          : "";
    const rows = this.db
      .query(`SELECT t.id AS taskId,t.conversation_id AS conversationId,t.agent_id AS agentId,
      t.status,t.created_at AS createdAt,t.updated_at AS updatedAt,t.expires_at AS expiresAt,
      (SELECT COUNT(*) FROM agent_task_calls a WHERE a.task_id=t.id) AS callCount,
      (SELECT COUNT(*) FROM agent_task_calls a WHERE a.task_id=t.id AND (a.arguments IS NOT NULL OR a.result IS NOT NULL)) AS payloadCallCount,
      ${TASK_PROTECTION_SQL} AS blocked
      FROM agent_tasks t JOIN conversations c ON c.id=t.conversation_id
      WHERE ${where}${statusWhere} ORDER BY t.created_at DESC,t.id DESC LIMIT ?`)
      .all(...params, ...(statusWhere ? [now] : []), filters.limit + 1) as TaskPayloadStorageRow[];
    const summary = this.db
      .query(`SELECT COUNT(*) AS total,COALESCE(SUM(expires_at>?),0) AS live,
      COALESCE(SUM(expires_at<=?),0) AS expired FROM (
      SELECT t.expires_at FROM agent_tasks t JOIN conversations c ON c.id=t.conversation_id WHERE ${where})`)
      .get(now, now, ...params) as { total: number; live: number; expired: number };
    const pageRows = rows.slice(0, filters.limit);
    return {
      items: pageRows.map((row) => ({
        kind: "task_payload" as const,
        taskId: row.taskId,
        conversationId: row.conversationId,
        agentId: row.agentId,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        expiresAt: row.expiresAt,
        expired: row.expiresAt <= now,
        protected: row.expiresAt <= now && row.blocked === 1,
        callCount: row.callCount,
        payloadCallCount: row.payloadCallCount,
      })),
      hasMore: rows.length > filters.limit,
      summary: {
        total: summary.total,
        live: summary.live,
        expired: summary.expired,
      },
    };
  }

  /**
   * 预览/清理共用的选择器：只选已到期、仍有 payload、且不在保全范围内的任务；
   * `matched`/`missing` 只在 ids 模式下有意义（类别模式 matched＝范围内任务总数）。
   */
  taskPayloadCleanupSelection(
    options: { now: string; userId?: string; ids?: readonly string[] },
    userId = DEFAULT_USER_ID,
  ): TaskPayloadCleanupSelection {
    const scope = taskScope(options.userId ?? userId);
    const conditions = [scope.where];
    const params: SQLQueryBindings[] = [...scope.params];
    if (options.ids) {
      conditions.push(`t.id IN (${options.ids.map(() => "?").join(",")})`);
      params.push(...options.ids);
    }
    const where = conditions.join(" AND ");
    const counts = this.db
      .query(`SELECT COUNT(*) AS total,
      COALESCE(SUM(payload AND expires_at<=?),0) AS expired,
      COALESCE(SUM(payload AND expires_at<=? AND blocked),0) AS protected
      FROM (SELECT t.expires_at,${TASK_PAYLOAD_SQL} AS payload,${TASK_PROTECTION_SQL} AS blocked
        FROM agent_tasks t JOIN conversations c ON c.id=t.conversation_id WHERE ${where})`)
      .get(options.now, options.now, ...params) as {
      total: number;
      expired: number;
      protected: number;
    };
    const ids = this.db
      .query(`SELECT t.id AS taskId FROM agent_tasks t JOIN conversations c ON c.id=t.conversation_id
      WHERE ${where} AND t.expires_at<=? AND ${TASK_PAYLOAD_SQL} AND NOT ${TASK_PROTECTION_SQL}
      ORDER BY t.created_at DESC,t.id DESC LIMIT ?`)
      .all(...params, options.now, CLEANUP_ID_LIST_LIMIT + 1) as { taskId: string }[];
    return {
      expired: counts.expired,
      protected: counts.protected,
      matched: counts.total,
      missing: options.ids ? Math.max(0, options.ids.length - counts.total) : 0,
      ids: ids.slice(0, CLEANUP_ID_LIST_LIMIT).map((row) => row.taskId),
      truncated: ids.length > CLEANUP_ID_LIST_LIMIT,
    };
  }

  /**
   * 清掉可清理任务的 payload（arguments/result 置空）。任务行本身不动：状态、来源身份与
   * expires_at 全部保留；在跑/待批准/未知结果的调用永不进入选择集。
   */
  purgeExpiredTaskPayloads(options: { now: string; userId?: string; ids?: readonly string[] }): {
    tasks: number;
  } {
    const scope = taskScope(options.userId ?? DEFAULT_USER_ID);
    const conditions = [scope.where];
    const params: SQLQueryBindings[] = [...scope.params];
    if (options.ids) {
      conditions.push(`t.id IN (${options.ids.map(() => "?").join(",")})`);
      params.push(...options.ids);
    }
    const eligible = `SELECT t.id FROM agent_tasks t JOIN conversations c ON c.id=t.conversation_id
      WHERE ${conditions.join(" AND ")} AND t.expires_at<=? AND ${TASK_PAYLOAD_SQL} AND NOT ${TASK_PROTECTION_SQL}`;
    const tasks = this.db
      .query(`SELECT COUNT(*) AS n FROM (${eligible})`)
      .get(...params, options.now) as { n: number };
    if (tasks.n > 0)
      this.db
        .query(
          `UPDATE agent_task_calls SET arguments=NULL,result=NULL WHERE task_id IN (${eligible})`,
        )
        .run(...params, options.now);
    return { tasks: tasks.n };
  }
}
