import type { Database } from "bun:sqlite";

export interface BotDiagnostics {
  pending_wakes: number;
  leased_wakes: number;
  failed_wakes: number;
  active_runs: number;
  pending_deliveries: number;
  unknown_deliveries: number;
}

/** Current Bot queue and delivery facts; old candidate rows are separate migration diagnostics. */
export function botDiagnostics(db: Database, at = new Date().toISOString()): BotDiagnostics {
  return db
    .query(`SELECT
    (SELECT COUNT(*) FROM wake_signals w JOIN conversations c ON c.id=w.conversation_id WHERE c.channel='onebot11' AND c.closed_at IS NULL AND w.status='pending') AS pending_wakes,
    (SELECT COUNT(*) FROM wake_signals w JOIN conversations c ON c.id=w.conversation_id WHERE c.channel='onebot11' AND c.closed_at IS NULL AND w.status='leased' AND w.lease_expires_at>?) AS leased_wakes,
    (SELECT COUNT(*) FROM wake_signals w JOIN conversations c ON c.id=w.conversation_id WHERE c.channel='onebot11' AND w.status='failed') AS failed_wakes,
    (SELECT COUNT(*) FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id WHERE c.channel='onebot11' AND r.ended_at IS NULL) AS active_runs,
    (SELECT COUNT(*) FROM outbound_intents WHERE status IN ('planned','delivering')) AS pending_deliveries,
    (SELECT COUNT(*) FROM outbound_intents WHERE status='unknown') AS unknown_deliveries
  `)
    .get(at) as BotDiagnostics;
}
