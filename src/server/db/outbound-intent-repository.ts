import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Delivery, DeliveryPart } from "../../shared/contracts/conversation";
import type { SourceRef } from "../../shared/contracts/evidence";
export type OutboundTarget = {
  accountId: string;
  conversationKind: "private" | "group";
  peerId: string;
  participantId?: string;
  attentionMembers?: readonly string[];
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
export type OutboundPartPayload =
  | { text: string; mentions?: readonly string[] }
  | { stickerId: string };
/**
 * 落库形状。`mentions` 键只在调用方给了结构化协议时才写入：有键＝新协议（新提交恒带，可为
 * 空数组），无键＝变更前计划的旧部件。发送与出站事实的读回都靠这个区别还原真实线上段，
 * 不能用空数组冒充旧件，否则历史已送内容会被重新解释。
 */
function payloadJson(part: {
  text: string;
  mentions?: readonly string[];
}): Record<string, unknown> {
  return part.mentions === undefined
    ? { text: part.text }
    : { text: part.text, mentions: [...part.mentions] };
}
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
/**
 * 「同一个逻辑回复」的稳定身份 → 确定性 UUID（0.4.0 P1 的幂等键）。
 *
 * 为什么需要：一次唤醒可能在崩溃后被重新排程，或在结果未知后重跑；两次运行的 `run_id` 与临时
 * `outputId` 都不同，靠它们去重是去不掉的。把"会话 + 观察序号 + 发言类别 + 收件人"拼成一个稳定键，
 * 重跑就会命中同一行出站意图——**已尝试过的原样返回，计划中的被替换**，于是群里只会收到一条。
 *
 * 版本位与变体位按 UUID 形状固定，纯为了可读（它就是个哈希，不需要真随机）。
 */
export function idempotentIntentId(parts: readonly (string | number | null)[]): string {
  const hex = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u0000"))
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = "a";
  const join = (from: number, to: number) => hex.slice(from, to).join("");
  return `${join(0, 8)}-${join(8, 12)}-${join(12, 16)}-${join(16, 20)}-${join(20, 32)}`;
}

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
    const target = r ? (JSON.parse(r.target) as OutboundTarget) : null;
    return r
      ? {
          target: target
            ? { peerId: target.peerId, participantId: target.participantId ?? null }
            : null,
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
    parts: (
      | { kind: "text"; text: string; mentions?: readonly string[] }
      | { kind: "sticker"; stickerId: string }
    )[];
  }): Delivery {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT id FROM outbound_intents WHERE run_id=? AND output_ordinal=?")
        .get(input.runId, input.ordinal) as { id: string } | null;
      if (existing) return this.get(existing.id)!;
      const id = input.id ?? crypto.randomUUID();
      // 幂等提交（0.4.0 P1）：调用方给的 id 由"逻辑回复的身份"派生时，**同一个机会重跑**会落到同一行——
      // 已尝试过的（在发、已确认、失败、结果未知）一律原样返回，绝不产生第二条；还只是"计划中"的，
      // 用新一轮的内容替换它的部件（同一个逻辑回复的更新版），投递仍然只有一次。
      const byId = this.get(id);
      if (byId !== null) {
        if (byId.status !== "planned") return byId;
        this.db.query("DELETE FROM outbound_parts WHERE intent_id=?").run(id);
        this.db
          .query(
            "UPDATE outbound_intents SET run_id=?, deliver_by=?, created_at=?, expires_at=? WHERE id=?",
          )
          .run(input.runId, input.deliverBy, input.createdAt, input.expiresAt, id);
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
                part.kind === "text" ? payloadJson(part) : { stickerId: part.stickerId },
              ),
            );
        return this.get(id)!;
      }
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
              part.kind === "text" ? payloadJson(part) : { stickerId: part.stickerId },
            ),
          );
      return this.get(id)!;
    })();
  }
  pending(): Delivery[] {
    return (
      this.db
        .query(
          "SELECT id FROM outbound_intents WHERE status IN ('planned','delivering') ORDER BY created_at,output_ordinal,id",
        )
        .all() as { id: string }[]
    ).map((r) => this.get(r.id)!);
  }
  /**
   * Persist sending before the first network byte.
   *
   * Two different workers may deliver different conversations at the same time, so the claim is
   * also where causal order inside one conversation is enforced: the intent that still owes an
   * earlier reply must settle (or go final) before a later one starts. "Earlier" is the same
   * order the delivery queue uses — created_at then output_ordinal — so a reply never overtakes
   * the previous one for the same people. A stuck or already-tried earlier intent returns `null`
   * here rather than letting the later one through; the caller leaves it planned and retries.
   */
  claimPart(
    intentId: string,
    at: string,
  ): { part: DeliveryPart; payload: OutboundPartPayload } | null {
    return this.db
      .transaction(() => {
        const intent = this.row(intentId);
        if (!intent || !["planned", "delivering"].includes(intent.status)) return null;
        if (
          this.db
            .query(
              `SELECT 1 FROM outbound_intents
               WHERE conversation_id=? AND id<>? AND status IN ('planned','delivering')
                 AND (created_at<? OR (created_at=? AND output_ordinal<?)
                      OR (created_at=? AND output_ordinal=? AND id<?))
               LIMIT 1`,
            )
            .get(
              intent.conversation_id,
              intentId,
              intent.created_at,
              intent.created_at,
              intent.output_ordinal,
              intent.created_at,
              intent.output_ordinal,
              intentId,
            )
        )
          return null;
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
