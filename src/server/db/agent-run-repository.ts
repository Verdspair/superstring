import type { Database } from "bun:sqlite";
import type {
  AgentStepSnapshot,
  ContextHandle,
  ModelMessage,
  RunEvent,
  RunEventPayload,
  RunOwner,
  RunSnapshot,
  RunStatus,
  StoredContext,
} from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import { estimateTokens } from "../services/token-estimate";

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
  status: StoredContext["status"];
};

/** Synchronous writes commit before their associated inference or event publication. */
export class AgentRunRepository {
  constructor(private readonly db: Database) {}

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
    this.db
      .query(`UPDATE agent_runs SET status=?, ended_at=?, error_code=?
      WHERE run_id=? AND ended_at IS NULL`)
      .run(status, terminal ? at : null, errorCode, runId);
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
    options: { errorCode?: string; decision?: unknown } = {},
  ): void {
    // Decisions contain only typed control information. Bodies and action results belong to
    // source-bound snapshots, never an unbounded diagnostics log.
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
      expiresAt: row.expires_at,
      status: row.status,
    };
  }

  redactContext(handle: ContextHandle, status: "expired" | "revoked"): void {
    this.db.transaction(() => {
      this.db
        .query(`UPDATE context_snapshots SET protected_messages=NULL,status=? WHERE step_id=?
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
}
