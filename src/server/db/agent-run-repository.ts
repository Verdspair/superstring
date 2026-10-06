import type { Database } from "bun:sqlite";
import type {
  AgentStepSnapshot,
  ContextHandle,
  ModelMessage,
  ProtectedModelOutput,
  RunEvent,
  RunEventPayload,
  RunOwner,
  RunSnapshot,
  RunStatus,
  StoredContext,
} from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import { publishConversationChange } from "../conversation/conversation-changes";
import { estimateTokens } from "../services/token-estimate";
import { DEFAULT_USER_ID } from "./repositories";

type RunRow = {
  run_id: string;
  spec_id: string;
  spec_version: string;
  owner_kind: string;
  owner_id: string;
  user_id: string | null;
  agent_id: string | null;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  error_code: string | null;
};
type StepRow = {
  step_id: string;
  run_id: string;
  step_no: number;
  model: string;
  phase: AgentStepSnapshot["phase"];
  status: AgentStepSnapshot["status"];
  started_at: string;
  ended_at: string | null;
  error_code: string | null;
};
type ContextRow = {
  run_id: string;
  step_id: string;
  source_refs: string;
  layout: string;
  expires_at: string | null;
  protected_messages: string | null;
  protected_output: string | null;
  output_recorded: number;
  status: StoredContext["status"];
};

/** 快照正文的存储统计/条目/清理（只含元数据，正文本身不进入这些结构）。 */
export interface ContextStorageCounts {
  live: number;
  expired: number;
  revoked: number;
  withProtectedBody: number;
  expiredProtectedBodies: number;
}
export interface ContextStorageItem {
  kind: "context";
  stepId: string;
  runId: string;
  at: string;
  status: StoredContext["status"];
  expiresAt: string | null;
  expired: boolean;
  sourceCount: number;
  hasProtectedBody: boolean;
  agentId: string | null;
  conversationId: string | null;
}
export interface ContextStorageFilters {
  status: "all" | "live" | "expired";
  agentId?: string;
  conversationId?: string;
  beforeRowid?: number;
  limit: number;
}
export interface ContextStoragePage {
  items: ContextStorageItem[];
  nextRowid: number;
  hasMore: boolean;
  summary: { total: number; live: number; expired: number };
}
export interface ContextCleanupSelection {
  expired: number;
  protected: number;
  matched: number;
  missing: number;
  ids: string[];
  truncated: boolean;
}
const CONTEXT_ROW_SELECT = `SELECT c.rowid AS cursorRowid,c.step_id AS stepId,s.run_id AS runId,
  s.started_at AS at,c.status AS status,c.expires_at AS expiresAt,
  (c.protected_messages IS NOT NULL OR c.protected_output IS NOT NULL) AS hasProtectedBody,
  json_array_length(c.source_refs) AS sourceCount,r.agent_id AS agentId,
  CASE WHEN r.owner_kind='conversation' THEN r.owner_id
    WHEN r.owner_kind='web_turn' THEN (SELECT c2.id FROM conversations c2 JOIN turns t2 ON t2.session_id=c2.source_id
      WHERE t2.id=r.owner_id AND c2.channel='web' LIMIT 1) END AS conversationId
  FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id JOIN agent_runs r ON r.run_id=s.run_id`;
const CLEANUP_ID_LIST_LIMIT = 100;
type ContextStorageRow = {
  cursorRowid: number;
  stepId: string;
  runId: string;
  at: string;
  status: StoredContext["status"];
  expiresAt: string | null;
  hasProtectedBody: number;
  sourceCount: number;
  agentId: string | null;
  conversationId: string | null;
};

/** principal 与来源相同的复验（与 canReadRun 的会话/用户边界一致，此处按行批量化）。 */
function contextScope(userId: string): { where: string; params: string[] } {
  return { where: "(r.user_id IS NULL OR r.user_id=?)", params: [userId] };
}

/** Synchronous writes commit before their associated inference or event publication. */
export class AgentRunRepository {
  constructor(private readonly db: Database) {}

  /** Owner -> conversation fact: same mapping as CONTEXT_ROW_SELECT; no synthetic ids. */
  private conversationOfRun(runId: string): string | null {
    const row = this.db
      .query(
        `SELECT CASE WHEN r.owner_kind='conversation' THEN r.owner_id
        WHEN r.owner_kind='web_turn' THEN (SELECT c2.id FROM conversations c2 JOIN turns t2 ON t2.session_id=c2.source_id
          WHERE t2.id=r.owner_id AND c2.channel='web' LIMIT 1) END AS conversationId
        FROM agent_runs r WHERE r.run_id=?`,
      )
      .get(runId) as { conversationId: string | null } | null;
    return row?.conversationId ?? null;
  }

  /** Restart retires inference attempts; owning job/session workers decide whether to retry. */
  recoverInterrupted(at = new Date().toISOString()): number {
    return this.db.transaction(() => {
      const interrupted = this.db
        .query("SELECT run_id FROM agent_runs WHERE ended_at IS NULL")
        .all() as { run_id: string }[];
      for (const { run_id: runId } of interrupted) {
        this.db
          .query(`UPDATE agent_steps SET status='failed',ended_at=?,error_code='AGENT_INTERRUPTED'
          WHERE run_id=? AND status='running'`)
          .run(at, runId);
        this.finishRun(runId, "failed", { type: "failed", code: "AGENT_INTERRUPTED" }, at, {
          errorCode: "AGENT_INTERRUPTED",
        });
      }
      return interrupted.length;
    })();
  }

  createRun(input: {
    runId: string;
    specId: string;
    specVersion: string;
    owner: RunOwner;
    at: string;
  }): void {
    this.db
      .query(`INSERT INTO agent_runs
      (run_id,spec_id,spec_version,owner_kind,owner_id,user_id,agent_id,status,started_at)
      VALUES (?,?,?,?,?,?,?,'prepared',?)`)
      .run(
        input.runId,
        input.specId,
        input.specVersion,
        input.owner.kind,
        input.owner.id,
        input.owner.userId ?? null,
        input.owner.agentId ?? null,
        input.at,
      );
  }

  setStatus(runId: string, status: RunStatus, at: string, errorCode: string | null = null): void {
    const terminal = ["completed", "no_output", "failed", "cancelled"].includes(status);
    const changed = this.db
      .query(`UPDATE agent_runs SET status=?, ended_at=?, error_code=?
      WHERE run_id=? AND ended_at IS NULL`)
      .run(status, terminal ? at : null, errorCode, runId).changes;
    if (changed > 0) {
      const conversationId = this.conversationOfRun(runId);
      if (conversationId) publishConversationChange(this.db, conversationId);
    }
  }

  startStep(input: {
    runId: string;
    stepId: string;
    stepNo: number;
    model: string;
    phase: AgentStepSnapshot["phase"];
    at: string;
    messages: readonly ModelMessage[];
    sources: readonly SourceRef[];
  }): void {
    const expiresAt =
      input.sources
        .map((source) => source.expiresAt)
        .filter((s): s is string => s !== undefined)
        .sort()[0] ?? null;
    const expired = expiresAt !== null && expiresAt <= input.at;
    const layout = input.messages.map((message) => ({
      role: message.role,
      sourceIds: input.sources.map((source) => source.id),
      units:
        12 +
        estimateTokens(message.role) +
        estimateTokens(
          message.content.flatMap((item) => (item.kind === "text" ? [item.text] : [])).join(""),
        ),
    }));
    this.db.transaction(() => {
      this.db
        .query(`INSERT INTO agent_steps(step_id,run_id,step_no,model,phase,status,started_at)
        VALUES (?,?,?,?,?,'running',?)`)
        .run(input.stepId, input.runId, input.stepNo, input.model, input.phase, input.at);
      this.db
        .query(`INSERT INTO context_snapshots(step_id,source_refs,layout,expires_at,protected_messages,status)
        VALUES (?,?,?,?,?,?)`)
        .run(
          input.stepId,
          JSON.stringify(input.sources),
          JSON.stringify(layout),
          expiresAt,
          expired ? null : JSON.stringify(input.messages),
          expired ? "expired" : "exact",
        );
    })();
  }

  finishStep(
    stepId: string,
    status: AgentStepSnapshot["status"],
    at: string,
    options: { errorCode?: string; decision?: unknown; output?: ProtectedModelOutput } = {},
  ): void {
    // Decisions contain only typed control information. Bodies and action results belong to
    // source-bound snapshots, never an unbounded diagnostics log.
    this.db.transaction(() => {
      this.db
        .query(`UPDATE agent_steps SET status=?,ended_at=?,error_code=?,decision=?
        WHERE step_id=? AND status='running'`)
        .run(
          status,
          at,
          options.errorCode ?? null,
          options.decision === undefined ? null : JSON.stringify(options.decision),
          stepId,
        );
      // A source may have been revoked while inference was in flight. Never
      // restore content to a redacted snapshot, even when the model returns later.
      this.db
        .query(`UPDATE context_snapshots SET output_recorded=1,protected_output=
        CASE WHEN status='exact' AND protected_messages IS NOT NULL AND
        (expires_at IS NULL OR expires_at>?) THEN ? ELSE NULL END WHERE step_id=?`)
        .run(at, options.output === undefined ? null : JSON.stringify(options.output), stepId);
    })();
  }

  resolveStepModel(stepId: string, model: string): void {
    this.db
      .query("UPDATE agent_steps SET model=? WHERE step_id=? AND status='running'")
      .run(model, stepId);
  }

  appendEvent(
    runId: string,
    event: RunEventPayload,
    at: string,
    conversationId?: string,
  ): RunEvent {
    return this.db.transaction(() => {
      const row = this.db
        .query("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM run_events WHERE run_id=?")
        .get(runId) as { seq: number };
      const value = {
        ...event,
        runId,
        seq: row.seq,
        at,
        ...(conversationId ? { conversationId } : {}),
      } as RunEvent;
      // Delta content remains on the live stream. The durable message/intent is its replay
      // authority; event history preserves identity/order without a second plaintext copy.
      const durable = value.type === "output_delta" ? { ...value, text: "" } : value;
      this.db
        .query("INSERT INTO run_events(run_id,seq,type,at,payload) VALUES (?,?,?,?,?)")
        .run(runId, value.seq, value.type, at, JSON.stringify(durable));
      // Semantic run events notify the conversation hub; stream-only frames (output_delta,
      // context_usage) must not fan out a refresh per chunk.
      if (value.type !== "output_delta" && value.type !== "context_usage") {
        const conversationId = value.conversationId ?? this.conversationOfRun(runId);
        if (conversationId) publishConversationChange(this.db, conversationId);
      }
      return value;
    })();
  }

  finishRun(
    runId: string,
    status: RunStatus,
    event: RunEventPayload,
    at: string,
    options: { errorCode?: string; conversationId?: string } = {},
  ): RunEvent {
    return this.db.transaction(() => {
      this.setStatus(runId, status, at, options.errorCode ?? null);
      return this.appendEvent(runId, event, at, options.conversationId);
    })();
  }

  getRun(runId: string): RunSnapshot | null {
    const row = this.db
      .query("SELECT * FROM agent_runs WHERE run_id=?")
      .get(runId) as RunRow | null;
    if (!row) return null;
    const steps = (
      this.db
        .query("SELECT * FROM agent_steps WHERE run_id=? ORDER BY step_no")
        .all(runId) as StepRow[]
    ).map(
      (step): AgentStepSnapshot => ({
        stepId: step.step_id,
        runId,
        stepNo: step.step_no,
        model: step.model,
        phase: step.phase,
        status: step.status,
        context: { runId, stepId: step.step_id },
        startedAt: step.started_at,
        endedAt: step.ended_at,
        errorCode: step.error_code,
      }),
    );
    return {
      runId,
      specId: row.spec_id,
      specVersion: row.spec_version,
      owner: {
        kind: row.owner_kind,
        id: row.owner_id,
        ...(row.user_id === null ? {} : { userId: row.user_id }),
        ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
      },
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      errorCode: row.error_code,
      steps,
      lastSeq: (
        this.db
          .query("SELECT COALESCE(MAX(seq),0) AS seq FROM run_events WHERE run_id=?")
          .get(runId) as { seq: number }
      ).seq,
      outputs: this.listEvents(runId).flatMap((event) =>
        event.type === "completed" ? event.outputs : [],
      ),
    };
  }

  listRuns(input: {
    ownerKind: string;
    ownerId: string;
    userId?: string;
    agentId?: string;
    limit?: number;
  }): RunSnapshot[] {
    const conditions = ["owner_kind=?", "owner_id=?"];
    const args: (string | number)[] = [input.ownerKind, input.ownerId];
    if (input.userId !== undefined) {
      conditions.push("user_id=?");
      args.push(input.userId);
    }
    if (input.agentId !== undefined) {
      conditions.push("agent_id=?");
      args.push(input.agentId);
    }
    args.push(input.limit ?? 100);
    return (
      this.db
        .query(
          `SELECT run_id FROM agent_runs WHERE ${conditions.join(" AND ")} ORDER BY started_at DESC, rowid DESC LIMIT ?`,
        )
        .all(...args) as { run_id: string }[]
    ).map((row) => this.getRun(row.run_id) as RunSnapshot);
  }

  listEvents(runId: string, afterSeq = 0): RunEvent[] {
    return (
      this.db
        .query("SELECT payload FROM run_events WHERE run_id=? AND seq>? ORDER BY seq")
        .all(runId, afterSeq) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as RunEvent);
  }

  getContext(handle: ContextHandle): StoredContext | null {
    const row = this.db
      .query(`SELECT c.*,s.run_id FROM context_snapshots c
      JOIN agent_steps s ON s.step_id=c.step_id WHERE c.step_id=? AND s.run_id=?`)
      .get(handle.stepId, handle.runId) as ContextRow | null;
    if (!row) return null;
    return {
      handle,
      sources: JSON.parse(row.source_refs),
      layout: JSON.parse(row.layout),
      messages: row.protected_messages === null ? null : JSON.parse(row.protected_messages),
      output: row.protected_output === null ? null : JSON.parse(row.protected_output),
      outputRecorded: row.output_recorded === 1,
      expiresAt: row.expires_at,
      status: row.status,
    };
  }

  redactContext(handle: ContextHandle, status: "expired" | "revoked"): void {
    this.db.transaction(() => {
      this.db
        .query(`UPDATE context_snapshots SET protected_messages=NULL,protected_output=NULL,status=? WHERE step_id=?
        AND EXISTS (SELECT 1 FROM agent_steps WHERE step_id=? AND run_id=?)`)
        .run(status, handle.stepId, handle.stepId, handle.runId);
      this.db
        .query("UPDATE agent_steps SET decision=NULL WHERE step_id=? AND run_id=?")
        .run(handle.stepId, handle.runId);
    })();
  }

  redactSource(kind: string, id: string, status: "expired" | "revoked" = "revoked"): number {
    const handles = this.db
      .query(`SELECT s.run_id,s.step_id FROM context_snapshots c
      JOIN agent_steps s ON s.step_id=c.step_id
      WHERE c.status='exact' AND EXISTS (SELECT 1 FROM json_each(c.source_refs) r
        WHERE json_extract(r.value,'$.kind')=? AND json_extract(r.value,'$.id')=?)`)
      .all(kind, id) as { run_id: string; step_id: string }[];
    this.db.transaction(() => {
      for (const handle of handles)
        this.redactContext({ runId: handle.run_id, stepId: handle.step_id }, status);
    })();
    return handles.length;
  }

  expireContexts(now = new Date().toISOString()): number {
    const handles = this.db
      .query(`SELECT s.run_id,s.step_id FROM context_snapshots c
      JOIN agent_steps s ON s.step_id=c.step_id WHERE c.status='exact' AND c.expires_at<=?`)
      .all(now) as { run_id: string; step_id: string }[];
    this.db.transaction(() => {
      for (const handle of handles)
        this.redactContext({ runId: handle.run_id, stepId: handle.step_id }, "expired");
    })();
    return handles.length;
  }

  /** 快照正文的有效/到期与物理残留清点；`expired` 按传入的服务端时间判断。 */
  contextStorageCounts(now: string, userId = DEFAULT_USER_ID): ContextStorageCounts {
    const scope = contextScope(userId);
    const row = this.db
      .query(`SELECT
      COALESCE(SUM(c.status='exact' AND (c.expires_at IS NULL OR c.expires_at>?)),0) AS live,
      COALESCE(SUM(c.expires_at IS NOT NULL AND c.expires_at<=?),0) AS expired,
      COALESCE(SUM(c.status='revoked'),0) AS revoked,
      COALESCE(SUM(c.protected_messages IS NOT NULL OR c.protected_output IS NOT NULL),0) AS withProtectedBody,
      COALESCE(SUM((c.protected_messages IS NOT NULL OR c.protected_output IS NOT NULL)
        AND c.expires_at IS NOT NULL AND c.expires_at<=?),0) AS expiredProtectedBodies
      FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id
      JOIN agent_runs r ON r.run_id=s.run_id WHERE ${scope.where}`)
      .get(now, now, now, ...scope.params) as ContextStorageCounts;
    return {
      live: row.live,
      expired: row.expired,
      revoked: row.revoked,
      withProtectedBody: row.withProtectedBody,
      expiredProtectedBodies: row.expiredProtectedBodies,
    };
  }

  /** 快照条目（只元数据）：正文是否残留、来源数量、到期与否；游标是快照行的 rowid。 */
  contextStorageItems(
    filters: ContextStorageFilters,
    now: string,
    userId = DEFAULT_USER_ID,
  ): ContextStoragePage {
    const scope = contextScope(userId);
    const conditions = [scope.where];
    const params: string[] = [...scope.params];
    if (filters.agentId) {
      conditions.push("r.agent_id=?");
      params.push(filters.agentId);
    }
    if (filters.conversationId) {
      conditions.push(`((r.owner_kind='conversation' AND r.owner_id=?) OR (r.owner_kind='web_turn' AND EXISTS(
        SELECT 1 FROM conversations cf JOIN turns tf ON tf.session_id=cf.source_id
        WHERE tf.id=r.owner_id AND cf.id=? AND cf.channel='web')))`);
      params.push(filters.conversationId, filters.conversationId);
    }
    const where = conditions.join(" AND ");
    const statusWhere =
      filters.status === "expired"
        ? " AND c.expires_at IS NOT NULL AND c.expires_at<=?"
        : filters.status === "live"
          ? " AND c.status='exact' AND (c.expires_at IS NULL OR c.expires_at>?)"
          : "";
    const rows = this.db
      .query(
        `SELECT * FROM (${CONTEXT_ROW_SELECT} WHERE ${where}${statusWhere}${
          filters.beforeRowid !== undefined ? " AND c.rowid<?" : ""
        }) ORDER BY cursorRowid DESC LIMIT ?`,
      )
      .all(
        ...params,
        ...(statusWhere ? [now] : []),
        ...(filters.beforeRowid !== undefined ? [filters.beforeRowid] : []),
        filters.limit + 1,
      ) as ContextStorageRow[];
    const summary = this.db
      .query(`SELECT COUNT(*) AS total,COALESCE(SUM(live),0) AS live,COALESCE(SUM(expired),0) AS expired FROM (
      SELECT c.step_id,(c.status='exact' AND (c.expires_at IS NULL OR c.expires_at>?)) AS live,
      (c.expires_at IS NOT NULL AND c.expires_at<=?) AS expired
      FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id
      JOIN agent_runs r ON r.run_id=s.run_id WHERE ${where})`)
      .get(now, now, ...params) as { total: number; live: number; expired: number };
    const pageRows = rows.slice(0, filters.limit);
    return {
      items: pageRows.map((row) => ({
        kind: "context" as const,
        stepId: row.stepId,
        runId: row.runId,
        at: row.at,
        status: row.status,
        expiresAt: row.expiresAt,
        expired: row.expiresAt !== null && row.expiresAt <= now,
        sourceCount: row.sourceCount,
        hasProtectedBody: row.hasProtectedBody === 1,
        agentId: row.agentId,
        conversationId: row.conversationId,
      })),
      nextRowid: pageRows.at(-1)?.cursorRowid ?? 0,
      hasMore: rows.length > filters.limit,
      summary,
    };
  }

  /** 已到期且正文仍物理残留的快照＝手动清理目标；来源引用与布局身份不在清理范围。 */
  contextCleanupSelection(
    options: { now: string; userId?: string; ids?: readonly string[] },
    userId = DEFAULT_USER_ID,
  ): ContextCleanupSelection {
    const scope = contextScope(options.userId ?? userId);
    const conditions = [scope.where];
    const params: string[] = [...scope.params];
    if (options.ids) {
      conditions.push(`c.step_id IN (${options.ids.map(() => "?").join(",")})`);
      params.push(...options.ids);
    }
    const where = conditions.join(" AND ");
    const counts = this.db
      .query(`SELECT COUNT(*) AS total,COALESCE(SUM(c.expires_at IS NOT NULL AND c.expires_at<=?
      AND (c.protected_messages IS NOT NULL OR c.protected_output IS NOT NULL)),0) AS expired
      FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id
      JOIN agent_runs r ON r.run_id=s.run_id WHERE ${where}`)
      .get(options.now, ...params) as { total: number; expired: number };
    const ids = this.db
      .query(`SELECT c.step_id AS stepId FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id
      JOIN agent_runs r ON r.run_id=s.run_id WHERE ${where}
      AND c.expires_at IS NOT NULL AND c.expires_at<=?
      AND (c.protected_messages IS NOT NULL OR c.protected_output IS NOT NULL)
      ORDER BY c.rowid DESC LIMIT ?`)
      .all(...params, options.now, CLEANUP_ID_LIST_LIMIT + 1) as { stepId: string }[];
    return {
      expired: counts.expired,
      protected: 0,
      matched: counts.total,
      missing: options.ids ? Math.max(0, options.ids.length - counts.total) : 0,
      ids: ids.slice(0, CLEANUP_ID_LIST_LIMIT).map((row) => row.stepId),
      truncated: ids.length > CLEANUP_ID_LIST_LIMIT,
    };
  }

  /** 清掉已到期快照的正文（与自动到期同一语义：status='expired'，触发器同时清 decision）。 */
  purgeExpiredContextBodies(options: { now: string; userId?: string; ids?: readonly string[] }): {
    contexts: number;
  } {
    const scope = contextScope(options.userId ?? DEFAULT_USER_ID);
    const conditions = [scope.where];
    const params: string[] = [...scope.params];
    if (options.ids) {
      conditions.push(`c.step_id IN (${options.ids.map(() => "?").join(",")})`);
      params.push(...options.ids);
    }
    // RETURNING（而不是 changes()）：context_snapshots 的触发器也会改行，changes() 会把触发器
    // 的改动一起计入；这里只数外层语句实际清理的快照。
    const cleared = this.db
      .query(`UPDATE context_snapshots SET protected_messages=NULL,protected_output=NULL,status='expired'
      WHERE expires_at IS NOT NULL AND expires_at<=?
      AND (protected_messages IS NOT NULL OR protected_output IS NOT NULL)
      AND step_id IN (SELECT c.step_id FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id
        JOIN agent_runs r ON r.run_id=s.run_id WHERE ${conditions.join(" AND ")}) RETURNING step_id`)
      .all(options.now, ...params) as { step_id: string }[];
    return { contexts: cleared.length };
  }
}
