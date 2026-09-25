import type { Database } from "bun:sqlite";
import type { WakeSignal } from "../../shared/contracts/conversation";

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
export class WakeRepository {
  constructor(readonly db: Database) {}
  get(id: string): WakeSignal | null {
    const r = this.db.query("SELECT * FROM wake_signals WHERE id=?").get(id) as Row | null;
    return r ? map(r) : null;
  }
  enqueue(input: {
    conversationId: string;
    cause: string;
    throughSeq: number;
    dedupeKey: string;
    readyAt: string;
    priority: number;
    at?: string;
    mergeReadyAt?: "earliest" | "latest";
  }): WakeSignal {
    const at = input.at ?? new Date().toISOString();
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO wake_signals(id,conversation_id,cause,through_seq,dedupe_key,ready_at,priority,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?) ON CONFLICT(dedupe_key) DO UPDATE SET through_seq=MAX(through_seq,excluded.through_seq),ready_at=${input.mergeReadyAt === "latest" ? "MAX" : "MIN"}(ready_at,excluded.ready_at),created_at=MAX(created_at,excluded.created_at),priority=MAX(priority,excluded.priority) WHERE status='pending'`,
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
    return map(
      this.db.query("SELECT * FROM wake_signals WHERE dedupe_key=?").get(input.dedupeKey) as Row,
    );
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
  }): WakeSignal | null {
    return this.db
      .transaction(() => {
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
  ): void {
    const r = this.get(id);
    if (!r || !this.owns(id, token, at)) throw new Error("WAKE_LEASE_LOST");
    this.db
      .query(
        "UPDATE wake_signals SET status=?,lease_token=NULL,lease_expires_at=NULL,completed_at=? WHERE id=?",
      )
      .run(status, at, id);
    // Opportunities covered by this successful observation are consumed, not their source messages.
    this.db
      .query(
        "UPDATE wake_signals SET status=?,completed_at=? WHERE conversation_id=? AND cause=? AND status='pending' AND through_seq<=?",
      )
      .run(status, at, r.conversationId, r.cause, throughSeq);
  }
  fail(
    id: string,
    token: string,
    input: { at: string; errorCode: string; maxAttempts: number; retryDelayMs: number },
  ): boolean {
    const r = this.get(id);
    if (!r || r.status !== "leased" || r.leaseToken !== token) return false;
    this.db
      .query(
        "UPDATE wake_signals SET status=?,lease_token=NULL,lease_expires_at=NULL,error_code=?,ready_at=? WHERE id=?",
      )
      .run(
        r.attempts >= input.maxAttempts ? "failed" : "pending",
        input.errorCode,
        new Date(Date.parse(input.at) + input.retryDelayMs).toISOString(),
        id,
      );
    return true;
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
