import type { Database } from "bun:sqlite";
import type { WakeSignal } from "../../shared/contracts/conversation";
import { ConversationEventRepository } from "./conversation-event-repository";

/** 确定性失败：重排不会改变结果，直接判失败。 */
const NON_RETRYABLE_WAKE_FAILURES = new Set([
  "CONTEXT_BUDGET_EXCEEDED",
  "CONTEXT_CAPACITY_UNKNOWN",
  "CONTEXT_CAPACITY_ERROR",
  "CONTEXT_CAPACITY_INSUFFICIENT",
  "MODEL_CAPACITY_UNAVAILABLE",
  "MODEL_CAPACITY_AMBIGUOUS",
  "STICKER_SEARCH_CONTEXT_LIMIT",
]);

type Row = {
  id: string;
  conversation_id: string;
  cause: string;
  dedupe_key: string;
  through_seq: number;
  ready_at: string;
  created_at: string;
  priority: number;
  status: WakeSignal["status"];
  attempts: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  error_code: string | null;
};
const map = (r: Row): WakeSignal => ({
  id: r.id,
  conversationId: r.conversation_id,
  cause: r.cause,
  dedupeKey: r.dedupe_key,
  throughSeq: r.through_seq,
  readyAt: r.ready_at,
  createdAt: r.created_at,
  priority: r.priority,
  status: r.status,
  attempts: r.attempts,
  leaseToken: r.lease_token,
  leaseExpiresAt: r.lease_expires_at,
  errorCode: r.error_code,
});
export interface WakeEnqueueInput {
  conversationId: string;
  cause: string;
  throughSeq: number;
  dedupeKey: string;
  readyAt: string;
  priority: number;
  at?: string;
  mergeReadyAt?: "earliest" | "latest";
  /** A replay must not replace a retry/defer deadline or renew its notification. */
  onlyNewerSource?: boolean;
}
export interface ParticipantOpportunity {
  wake: WakeSignal;
  participantId: string | null;
  occurredAt: string;
}

export class WakeRepository {
  constructor(readonly db: Database) {}
  get(id: string): WakeSignal | null {
    const r = this.db.query("SELECT * FROM wake_signals WHERE id=?").get(id) as Row | null;
    return r ? map(r) : null;
  }
  enqueue(input: WakeEnqueueInput): WakeSignal {
    return this.enqueueChanged(input).wake;
  }
  /** State changes, not polling attempts, are the reason to notify a worker. */
  enqueueChanged(input: WakeEnqueueInput): { wake: WakeSignal; changed: boolean } {
    return this.db
      .transaction(() => {
        const existing = this.db
          .query("SELECT * FROM wake_signals WHERE dedupe_key=?")
          .get(input.dedupeKey) as Row | null;
        if (
          existing &&
          (existing.status !== "pending" ||
            (input.onlyNewerSource && input.throughSeq <= existing.through_seq))
        )
          return { wake: map(existing), changed: false };
        const at = input.at ?? new Date().toISOString();
        if (existing) {
          const through = Math.max(existing.through_seq, input.throughSeq);
          const ready =
            input.mergeReadyAt === "latest"
              ? existing.ready_at > input.readyAt
                ? existing.ready_at
                : input.readyAt
              : existing.ready_at < input.readyAt
                ? existing.ready_at
                : input.readyAt;
          const activity = existing.created_at > at ? existing.created_at : at;
          const priority = Math.max(existing.priority, input.priority);
          if (
            through === existing.through_seq &&
            ready === existing.ready_at &&
            activity === existing.created_at &&
            priority === existing.priority
          )
            return { wake: map(existing), changed: false };
          this.db
            .query(
              "UPDATE wake_signals SET through_seq=?,ready_at=?,created_at=?,priority=? WHERE id=?",
            )
            .run(through, ready, activity, priority, existing.id);
          return { wake: this.get(existing.id)!, changed: true };
        }
        const id = crypto.randomUUID();
        this.db
          .query(
            "INSERT INTO wake_signals(id,conversation_id,cause,through_seq,dedupe_key,ready_at,priority,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)",
          )
          .run(
            id,
            input.conversationId,
            input.cause,
            input.throughSeq,
            input.dedupeKey,
            input.readyAt,
            input.priority,
            at,
          );
        new ConversationEventRepository(this.db).append({
          conversationId: input.conversationId,
          eventKey: `wake:${id}`,
          kind: "wake",
          source: { kind: "wake", id, revision: "1" },
          occurredAt: at,
          recordedAt: at,
        });
        return { wake: this.get(id)!, changed: true };
      })
      .immediate();
  }
  /** Classifying a replay under another path must not create a second attempt. */
  hasOfferedSource(conversationId: string, throughSeq: number): boolean {
    return !!this.db
      .query(
        "SELECT 1 FROM wake_signals WHERE conversation_id=? AND through_seq=? AND cause IN('direct_reply','follow_up','chiming_in') LIMIT 1",
      )
      .get(conversationId, throughSeq);
  }
  /** Latest handled or pending source for one participant, including terminal failures. */
  latestParticipant(
    conversationId: string,
    cause: string,
    participantId: string | null,
  ): WakeSignal | null {
    const row = this.db
      .query(`SELECT w.* FROM wake_signals w
      JOIN conversation_events e ON e.conversation_id=w.conversation_id AND e.seq=w.through_seq
      WHERE w.conversation_id=? AND w.cause=? AND json_extract(e.participant,'$.id') IS ?
      ORDER BY w.through_seq DESC,w.created_at DESC,w.id DESC LIMIT 1`)
      .get(conversationId, cause, participantId) as Row | null;
    return row ? map(row) : null;
  }
  /** Snapshot of mature participant opportunities; callers explicitly acknowledge only this set. */
  readyParticipants(input: {
    conversationId: string;
    cause: string;
    at: string;
  }): ParticipantOpportunity[] {
    const rows = this.db
      .query(`SELECT w.*,json_extract(e.participant,'$.id') AS participant_id,e.occurred_at
      FROM wake_signals w JOIN conversation_events e ON e.conversation_id=w.conversation_id AND e.seq=w.through_seq
      JOIN conversations c ON c.id=w.conversation_id
      WHERE w.conversation_id=? AND w.cause=? AND w.status IN('pending','leased') AND w.ready_at<=? AND c.closed_at IS NULL
      ORDER BY e.occurred_at,participant_id,w.id`)
      .all(input.conversationId, input.cause, input.at) as (Row & {
      participant_id: string | null;
      occurred_at: string;
    })[];
    return rows.map((row) => ({
      wake: map(row),
      participantId: row.participant_id,
      occurredAt: row.occurred_at,
    }));
  }

  /** Earliest durable deadline, excluding retired conversations and an already held conversation. */
  nextReadyAt(): string | null {
    const row = this.db
      .query(`SELECT MIN(w.ready_at) AS at FROM wake_signals w
      JOIN conversations c ON c.id=w.conversation_id
      WHERE w.status='pending' AND c.channel='onebot11' AND c.closed_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM wake_signals held WHERE held.conversation_id=w.conversation_id AND held.status='leased')`)
      .get() as { at: string | null };
    return row.at;
  }

  peek(input: { at: string; topology?: "direct" | "shared"; cause?: string }): WakeSignal | null {
    const row = this.db
      .query(
        `SELECT w.* FROM wake_signals w JOIN conversations c ON c.id=w.conversation_id WHERE w.status='pending' AND w.ready_at<=? AND c.closed_at IS NULL AND c.channel='onebot11' AND (? IS NULL OR c.topology=?) AND (? IS NULL OR w.cause=?) AND NOT EXISTS(SELECT 1 FROM wake_signals held WHERE held.conversation_id=w.conversation_id AND held.status='leased') ORDER BY w.priority DESC,w.created_at DESC,w.conversation_id,w.through_seq DESC,w.id DESC LIMIT 1`,
      )
      .get(
        input.at,
        input.topology ?? null,
        input.topology ?? null,
        input.cause ?? null,
        input.cause ?? null,
      ) as Row | null;
    return row ? map(row) : null;
  }
  claim(input: {
    at: string;
    leaseMs: number;
    topology?: "direct" | "shared";
    cause?: string;
    wakeId?: string;
    globalConcurrency?: number;
  }): WakeSignal | null {
    return this.db
      .transaction(() => {
        const limit = input.globalConcurrency ?? 1;
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("BOT_CONCURRENCY_INVALID");
        // The count and claim share SQLite's writer lock: multiple processes cannot each take
        // the last slot. The same persisted lease provides renewal and crash recovery.
        const active = this.db
          .query(
            "SELECT COUNT(*) AS n FROM wake_signals w JOIN conversations c ON c.id=w.conversation_id WHERE w.status='leased' AND w.lease_expires_at>? AND c.channel='onebot11'",
          )
          .get(input.at) as { n: number };
        const legacy = this.db
          .query("SELECT 1 FROM qq_dispatch_lease WHERE token IS NOT NULL AND expires_at_seconds>?")
          .get(Math.floor(Date.parse(input.at) / 1000));
        if (legacy || active.n >= limit) return null;
        const r = this.db
          .query(
            `SELECT w.* FROM wake_signals w JOIN conversations c ON c.id=w.conversation_id WHERE w.status='pending' AND w.ready_at<=? AND c.closed_at IS NULL AND c.channel='onebot11' AND (? IS NULL OR c.topology=?) AND (? IS NULL OR w.cause=?) AND (? IS NULL OR w.id=?) AND NOT EXISTS(SELECT 1 FROM wake_signals held WHERE held.conversation_id=w.conversation_id AND held.status='leased') ORDER BY w.priority DESC,w.created_at DESC,w.conversation_id,w.through_seq DESC,w.id DESC LIMIT 1`,
          )
          .get(
            input.at,
            input.topology ?? null,
            input.topology ?? null,
            input.cause ?? null,
            input.cause ?? null,
            input.wakeId ?? null,
            input.wakeId ?? null,
          ) as Row | null;
        if (!r) return null;
        const token = crypto.randomUUID();
        this.db
          .query(
            "UPDATE wake_signals SET status='leased',lease_token=?,lease_expires_at=?,attempts=attempts+1 WHERE id=? AND status='pending'",
          )
          .run(token, new Date(Date.parse(input.at) + input.leaseMs).toISOString(), r.id);
        return this.get(r.id);
      })
      .immediate();
  }
  owns(id: string, token: string, at = new Date().toISOString()): boolean {
    return !!this.db
      .query(
        "SELECT 1 FROM wake_signals WHERE id=? AND status='leased' AND lease_token=? AND lease_expires_at>?",
      )
      .get(id, token, at);
  }
  renew(id: string, token: string, at: string, leaseMs: number): boolean {
    return (
      this.db
        .query(
          "UPDATE wake_signals SET lease_expires_at=? WHERE id=? AND status='leased' AND lease_token=? AND lease_expires_at>?",
        )
        .run(new Date(Date.parse(at) + leaseMs).toISOString(), id, token, at).changes > 0
    );
  }
  complete(
    id: string,
    token: string,
    status: "completed" | "no_output",
    throughSeq: number,
    at = new Date().toISOString(),
    covered: readonly { id: string; throughSeq: number }[] = [],
    currentFailureCode?: string,
  ): void {
    this.db
      .transaction(() => {
        const r = this.get(id);
        if (!r || !this.owns(id, token, at)) throw new Error("WAKE_LEASE_LOST");
        const completed = this.db
          .query(
            "UPDATE wake_signals SET status=?,error_code=?,lease_token=NULL,lease_expires_at=NULL,completed_at=? WHERE id=? AND status='leased' AND lease_token=?",
          )
          .run(
            currentFailureCode ? "failed" : status,
            currentFailureCode ?? null,
            at,
            id,
            token,
          ).changes;
        if (completed === 0) throw new Error("WAKE_LEASE_LOST");
        // Observing another person's input is not the same as resolving their opportunity.
        // A newer source (or a still immature participant) keeps its pending work.
        for (const item of covered) {
          if (item.throughSeq > throughSeq) continue;
          this.db
            .query(`UPDATE wake_signals SET status=?,completed_at=?
          WHERE id=? AND conversation_id=? AND cause=? AND status='pending' AND through_seq=? AND ready_at<=?`)
            .run(status, at, item.id, r.conversationId, r.cause, item.throughSeq, at);
        }
      })
      .immediate();
  }

  /** Waiting for a configured cadence is not a failed model attempt. */
  defer(id: string, token: string, readyAt: string, at: string): void {
    if (!this.owns(id, token, at)) throw new Error("WAKE_LEASE_LOST");
    const deferred = this.db
      .query(
        "UPDATE wake_signals SET status='pending',lease_token=NULL,lease_expires_at=NULL,ready_at=?,attempts=MAX(0,attempts-1) WHERE id=? AND status='leased' AND lease_token=?",
      )
      .run(readyAt, id, token).changes;
    if (deferred === 0) throw new Error("WAKE_LEASE_LOST");
  }
  fail(
    id: string,
    token: string,
    input: { at: string; errorCode: string; maxAttempts: number; retryDelayMs: number },
  ): boolean {
    const r = this.get(id);
    if (!r || r.status !== "leased" || r.leaseToken !== token) return false;
    const failed = this.db
      .query(
        "UPDATE wake_signals SET status=?,lease_token=NULL,lease_expires_at=NULL,error_code=?,ready_at=? WHERE id=? AND status='leased' AND lease_token=?",
      )
      .run(
        // 容量/预算这类**确定性**失败不重排——重试三次还是同一个结果，只会让人反复
        // 看到"等待处理 → 又失败"。瞬时问题（模型忙、网络抖动）照旧按 maxAttempts 重试。
        r.attempts >= input.maxAttempts || NON_RETRYABLE_WAKE_FAILURES.has(input.errorCode)
          ? "failed"
          : "pending",
        input.errorCode,
        new Date(Date.parse(input.at) + input.retryDelayMs).toISOString(),
        id,
        token,
      ).changes;
    return failed > 0;
  }
  recover(input: { at: string; maxAttempts: number; retryDelayMs: number }): number {
    const rows = this.db
      .query("SELECT * FROM wake_signals WHERE status='leased' AND lease_expires_at<=?")
      .all(input.at) as Row[];
    for (const r of rows)
      this.fail(r.id, r.lease_token!, { ...input, errorCode: "WAKE_INTERRUPTED" });
    return rows.length;
  }
}
