import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Delivery, DeliveryPart } from "../../shared/contracts/conversation";
import type { SourceRef } from "../../shared/contracts/evidence";
export type OutboundTarget = {
  accountId: string;
  conversationKind: "private" | "group";
  peerId: string;
  agentId: string;
  bindingId: string;
  bindingEpoch: number;
  bindingRevision?: number;
  authorityRevision?: number;
  ownerIdentityRevision?: number | null;
  schemeId?: string;
  schemeRevision?: number;
  agentConfigVersion?: number;
  sources?: SourceRef[];
};
export type OutboundPartPayload = { text: string } | { stickerId: string };
type IntentRow = {
  id: string;
  run_id: string;
  conversation_id: string;
  output_ordinal: number;
  target: string;
  speech_kind: "direct_reply" | "follow_up" | "chiming_in" | "idle_topic";
  source_through_seq: number;
  deliver_by: string;
  status: Delivery["status"];
  created_at: string;
  expires_at: string;
  legacy_send_id: string | null;
};
type PartRow = {
  id: string;
  intent_id: string;
  ordinal: number;
  kind: "text" | "sticker";
  payload: string | null;
  status: DeliveryPart["status"];
  platform_message_id: string | null;
  attempted_at: string | null;
  finished_at: string | null;
};
const mapPart = (r: PartRow): DeliveryPart => ({
  id: r.id,
  ordinal: r.ordinal,
  kind: r.kind,
  status: r.status,
  platformMessageId: r.platform_message_id,
  attemptedAt: r.attempted_at,
  finishedAt: r.finished_at,
  stickerId:
    r.kind === "sticker" && r.payload
      ? (JSON.parse(r.payload) as { stickerId: string }).stickerId
      : null,
});
export class OutboundIntentRepository {
  constructor(readonly db: Database) {}
  row(id: string): IntentRow | null {
    return this.db.query("SELECT * FROM outbound_intents WHERE id=?").get(id) as IntentRow | null;
  }
  parts(id: string): PartRow[] {
    return this.db
      .query("SELECT * FROM outbound_parts WHERE intent_id=? ORDER BY ordinal")
      .all(id) as PartRow[];
  }
  get(id: string): Delivery | null {
    const r = this.row(id);
    return r
      ? {
          id: r.id,
          runId: r.run_id,
          conversationId: r.conversation_id,
          ordinal: r.output_ordinal,
          status: r.status,
          sourceThroughSeq: r.source_through_seq,
          deliverBy: r.deliver_by,
          createdAt: r.created_at,
          parts: this.parts(id).map(mapPart),
        }
      : null;
  }
  list(input: { conversationId?: string; conversationIds?: string[]; runId?: string }): Delivery[] {
    const where: string[] = [];
    const args: string[] = [];
    if (input.conversationId) {
      where.push("conversation_id=?");
      args.push(input.conversationId);
    }
    if (input.conversationIds) {
      if (!input.conversationIds.length) return [];
      where.push(`conversation_id IN (${input.conversationIds.map(() => "?").join(",")})`);
      args.push(...input.conversationIds);
    }
    if (input.runId) {
      where.push("run_id=?");
      args.push(input.runId);
    }
    return (
      this.db
        .query(
          `SELECT id FROM outbound_intents${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at,output_ordinal`,
        )
        .all(...args) as { id: string }[]
    ).map((r) => this.get(r.id)!);
  }
  commit(input: {
    id?: string;
    runId: string;
    conversationId: string;
    ordinal: number;
    target: OutboundTarget;
    speechKind: IntentRow["speech_kind"];
    sourceThroughSeq: number;
    deliverBy: string;
    createdAt: string;
    expiresAt: string;
    parts: ({ kind: "text"; text: string } | { kind: "sticker"; stickerId: string })[];
  }): Delivery {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT id FROM outbound_intents WHERE run_id=? AND output_ordinal=?")
        .get(input.runId, input.ordinal) as { id: string } | null;
      if (existing) return this.get(existing.id)!;
      const id = input.id ?? crypto.randomUUID();
      this.db
        .query(
          "INSERT INTO outbound_intents(id,run_id,conversation_id,output_ordinal,target,speech_kind,source_through_seq,deliver_by,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'planned',?,?)",
        )
        .run(
          id,
          input.runId,
          input.conversationId,
          input.ordinal,
          JSON.stringify(input.target),
          input.speechKind,
          input.sourceThroughSeq,
          input.deliverBy,
          input.createdAt,
          input.expiresAt,
        );
      for (const [ordinal, part] of input.parts.entries())
        this.db
          .query(
            "INSERT INTO outbound_parts(id,intent_id,ordinal,kind,payload,status) VALUES(?,?,?,?,?,'planned')",
          )
          .run(
            crypto.randomUUID(),
            id,
            ordinal,
            part.kind,
            JSON.stringify(
              part.kind === "text" ? { text: part.text } : { stickerId: part.stickerId },
            ),
          );
      return this.get(id)!;
    })();
  }
  pending(): Delivery[] {
    return (
      this.db
        .query(
          "SELECT id FROM outbound_intents WHERE status IN ('planned','delivering') ORDER BY created_at,output_ordinal",
        )
        .all() as { id: string }[]
    ).map((r) => this.get(r.id)!);
  }
  /** Persist sending before the first network byte. Another worker cannot claim the same part. */
  claimPart(
    intentId: string,
    at: string,
  ): { part: DeliveryPart; payload: OutboundPartPayload } | null {
    return this.db
      .transaction(() => {
        const intent = this.row(intentId);
        if (!intent || !["planned", "delivering"].includes(intent.status)) return null;
        const parts = this.parts(intentId);
        if (parts.some((p) => p.status !== "confirmed" && p.status !== "planned")) return null;
        const part = parts.find((p) => p.status === "planned");
        if (!part || !part.payload) return null;
        this.db
          .query(
            "UPDATE outbound_parts SET status='sending',attempted_at=? WHERE id=? AND status='planned'",
          )
          .run(at, part.id);
        this.db.query("UPDATE outbound_intents SET status='delivering' WHERE id=?").run(intentId);
        return {
          part: { ...mapPart(part), status: "sending" as const, attemptedAt: at },
          payload: JSON.parse(part.payload),
        };
      })
      .immediate();
  }
  settlePart(
    partId: string,
    result: { status: "confirmed" | "failed" | "unknown" | "not_sent"; messageId?: string },
    at: string,
  ): Delivery {
    return this.db.transaction(() => {
      const p = this.db
        .query("SELECT * FROM outbound_parts WHERE id=?")
        .get(partId) as PartRow | null;
      if (!p || p.status !== "sending") throw new Error("DELIVERY_PART_NOT_SENDING");
      if (result.status === "confirmed" && !result.messageId)
        throw new Error("DELIVERY_RECEIPT_REQUIRED");
      this.db
        .query("UPDATE outbound_parts SET status=?,platform_message_id=?,finished_at=? WHERE id=?")
        .run(result.status, result.messageId ?? null, at, partId);
      if (result.status !== "confirmed")
        this.db
          .query(
            "UPDATE outbound_parts SET status='not_sent',finished_at=? WHERE intent_id=? AND status='planned'",
          )
          .run(at, p.intent_id);
      this.refreshStatus(p.intent_id);
      return this.get(p.intent_id)!;
    })();
  }
  private refreshStatus(id: string): void {
    const parts = this.parts(id);
    const status: Delivery["status"] = parts.some((p) => p.status === "unknown")
      ? "unknown"
      : parts.some((p) => p.status === "failed" || p.status === "not_sent")
        ? "failed"
        : parts.every((p) => p.status === "confirmed")
          ? "confirmed"
          : parts.some((p) => p.status === "sending")
            ? "delivering"
            : parts.some((p) => p.status === "stale")
              ? "stale"
              : "delivering";
    this.db.query("UPDATE outbound_intents SET status=? WHERE id=?").run(status, id);
  }
  stale(id: string, at: string): boolean {
    return this.db.transaction(() => {
      const r = this.row(id);
      if (
        !r ||
        !["planned", "delivering"].includes(r.status) ||
        this.parts(id).some((p) => p.status === "sending")
      )
        return false;
      this.db
        .query(
          "UPDATE outbound_parts SET status='stale',finished_at=? WHERE intent_id=? AND status='planned'",
        )
        .run(at, id);
      this.db.query("UPDATE outbound_intents SET status='stale' WHERE id=?").run(id);
      return true;
    })();
  }
  recover(at = new Date().toISOString()): number {
    return this.db.transaction(() => {
      const rows = this.db
        .query("SELECT DISTINCT intent_id FROM outbound_parts WHERE status='sending'")
        .all() as { intent_id: string }[];
      for (const r of rows) {
        this.db
          .query(
            "UPDATE outbound_parts SET status='unknown',finished_at=? WHERE intent_id=? AND status='sending'",
          )
          .run(at, r.intent_id);
        this.db
          .query(
            "UPDATE outbound_parts SET status='not_sent',finished_at=? WHERE intent_id=? AND status='planned'",
          )
          .run(at, r.intent_id);
        this.refreshStatus(r.intent_id);
      }
      return rows.length;
    })();
  }
  /** Actual confirmed words from partial deliveries, without changing legacy U13 counters. */
  partialSpeechSince(
    conversationId: string,
    input: { sinceSeconds: number; limit: number; at: string },
  ): Array<{ occurredAtSeconds: number; text: string; sources: SourceRef[] }> {
    const rows = this.db
      .query(
        "SELECT id,expires_at FROM outbound_intents WHERE conversation_id=? AND status<>'confirmed' AND expires_at>? ORDER BY created_at DESC,output_ordinal DESC",
      )
      .all(conversationId, input.at) as { id: string; expires_at: string }[];
    const speech = rows.flatMap((row) => {
      const parts = this.parts(row.id).filter(
        (p) => p.kind === "text" && p.status === "confirmed" && p.payload,
      );
      const text = parts.map((p) => (JSON.parse(p.payload!) as { text: string }).text).join("\n");
      const seconds = Math.floor(Date.parse(parts[0]?.attempted_at ?? "") / 1000);
      return text && seconds > input.sinceSeconds
        ? [
            {
              occurredAtSeconds: seconds,
              text,
              sources: [
                {
                  kind: "outbound_intent",
                  id: row.id,
                  revision: createHash("sha256").update(text).digest("hex"),
                  expiresAt: row.expires_at,
                },
              ],
            },
          ]
        : [];
    });
    return speech.sort((a, b) => b.occurredAtSeconds - a.occurredAtSeconds).slice(0, input.limit);
  }
  /** Retention runs while transport is offline too; no pending payload can outlive its source. */
  purgeExpired(at = new Date().toISOString()): number {
    return this.db.transaction(() => {
      const rows = this.db
        .query(
          "SELECT id FROM outbound_intents WHERE expires_at<=? AND status IN('planned','delivering')",
        )
        .all(at) as { id: string }[];
      for (const row of rows) {
        this.db
          .query(
            "UPDATE outbound_parts SET status='stale',finished_at=? WHERE intent_id=? AND status='planned'",
          )
          .run(at, row.id);
        this.refreshStatus(row.id);
      }
      return this.db
        .query(
          "UPDATE outbound_parts SET payload=NULL WHERE payload IS NOT NULL AND intent_id IN(SELECT id FROM outbound_intents WHERE expires_at<=?)",
        )
        .run(at).changes;
    })();
  }
  /** Caller records legacy receipt and sets this marker in the same SQLite transaction. */
  markLegacyProjection(id: string, sendId: string): void {
    this.db
      .query("UPDATE outbound_intents SET legacy_send_id=? WHERE id=? AND legacy_send_id IS NULL")
      .run(sendId, id);
  }
}
