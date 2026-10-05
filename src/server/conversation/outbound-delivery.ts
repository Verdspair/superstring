import type { Delivery } from "../../shared/contracts/conversation";
import type { ConversationEventRepository } from "../db/conversation-event-repository";
import type { OutboundIntentRepository, OutboundTarget } from "../db/outbound-intent-repository";
import { confirmQqOutboundPart } from "../db/qq-message-repository";
import { recordQqSend } from "../db/qq-send-repository";
import type { Orm } from "../db/repositories";
import type { RuntimeTelemetry, TraceScope } from "../observability/runtime-telemetry";
import type { OneBotSendResult } from "../services/onebot-connection";
import {
  type QqSendPort,
  type QqStickerFileReference,
  qqTextSegments,
} from "../services/qq-send-transport";
import { observationRelevant } from "./observation-relevance";

/** Durable side effects. No model call can occur inside a transport transaction. */
export class OutboundDelivery {
  private stopped = false;
  /** Finish an in-flight receipt, while leaving unstarted work durable for a new worker. */
  stop(): void {
    this.stopped = true;
  }
  constructor(
    private readonly options: {
      orm: Orm;
      telemetry?: RuntimeTelemetry;
      repository: OutboundIntentRepository;
      journal: ConversationEventRepository;
      port: QqSendPort;
      stickerFile: QqStickerFileReference;
      stickerAvailable?: (stickerId: string, target: OutboundTarget, at: string) => boolean;
      authorize: (target: OutboundTarget, delivery: Delivery) => boolean;
      onStale?: (delivery: Delivery) => void;
      now?: () => string;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? new Date().toISOString();
  }
  private revision(id: string): void {
    const { repository, journal } = this.options;
    const row = repository.row(id)!;
    const d = repository.get(id)!;
    if (journal.row(row.conversation_id)?.closed_at) return;
    const revision = JSON.stringify(d.parts.map((p) => [p.status, p.platformMessageId]));
    journal.append({
      conversationId: row.conversation_id,
      eventKey: `delivery:${id}:${revision}`,
      kind: "delivery",
      source: { kind: "outbound_intent", id, revision, expiresAt: row.expires_at },
      occurredAt: this.now(),
      runId: row.run_id,
      outputId: id,
    });
  }
  private projectLegacy(id: string): void {
    const { repository, orm } = this.options;
    const row = repository.row(id)!;
    if (row.legacy_send_id || ["planned", "delivering"].includes(row.status)) return;
    const parts = repository.parts(id);
    if (!parts.some((p) => p.attempted_at)) return;
    const target = JSON.parse(row.target) as OutboundTarget;
    // The projected send and its speech record must not outlive their provenance: the kept
    // window is capped by the earliest of the intent's own expiry and the outbound fact's
    // expiry (by exact intent id, never by text or time guessing). A missing fact is not
    // guessed around — the intent's stamp alone then caps; with no stamp at all nothing is
    // passed and the plain retention stamp stands.
    const factExpiresAt = (
      repository.db
        .query("SELECT expires_at FROM qq_outbound_message_facts WHERE intent_id=?")
        .get(id) as { expires_at: string } | undefined
    )?.expires_at;
    const sourceExpiresAt = [row.expires_at, factExpiresAt]
      .filter((cap): cap is string => cap != null)
      .reduce<string | undefined>(
        (earliest, cap) =>
          earliest === undefined || Date.parse(cap) < Date.parse(earliest) ? cap : earliest,
        undefined,
      );
    const text =
      parts
        .filter((p) => p.kind === "text" && p.status === "confirmed" && p.payload)
        .map((p) => (JSON.parse(p.payload!) as { text: string }).text)
        .join("\n") || null;
    const result = recordQqSend(
      orm,
      {
        scope: {
          kind: "qq",
          accountId: target.accountId,
          conversationKind: target.conversationKind,
          peerId: target.peerId,
          agentId: target.agentId,
        },
        kind: row.speech_kind,
        parts: parts.map((p) => ({
          kind: p.kind,
          result:
            p.status === "stale"
              ? "not_sent"
              : (p.status as "confirmed" | "failed" | "unknown" | "not_sent"),
          messageId: p.platform_message_id,
          stickerId:
            p.kind === "sticker" && p.payload
              ? (JSON.parse(p.payload) as { stickerId: string }).stickerId
              : null,
        })),
        text,
        sentAtSeconds: Math.floor(
          Date.parse(parts.find((p) => p.attempted_at)!.attempted_at!) / 1000,
        ),
        sourceExpiresAt,
      },
      undefined,
      repository.db,
    );
    repository.markLegacyProjection(id, result.log.id);
  }
  recover(): number {
    const { repository } = this.options;
    return repository.db.transaction(() => {
      const count = repository.recover(this.now());
      for (const delivery of repository.list({})) {
        const row = repository.row(delivery.id)!;
        if (!row.legacy_send_id && !["planned", "delivering"].includes(row.status)) {
          this.projectLegacy(row.id);
          this.revision(row.id);
        }
      }
      return count;
    })();
  }
  async deliver(id: string): Promise<Delivery | null> {
    const row = this.options.repository.row(id);
    if (!row || this.stopped || !["planned", "delivering"].includes(row.status))
      return this.options.repository.get(id);
    const target = JSON.parse(row.target) as OutboundTarget;
    const telemetry = this.options.telemetry;
    const span = telemetry?.start("bot.delivery", {
      channel: "onebot11",
      stage: "delivery",
      conversationId: row.conversation_id,
      runId: row.run_id,
      outputId: id,
      sourceSeq: row.source_through_seq,
      agentId: target.agentId,
      sources: target.sources,
      parent:
        telemetry.parentFor("output_id", id) ??
        telemetry.parentFor("run_id", row.run_id) ??
        undefined,
    });
    const work = () => this.deliverParts(id, span);
    try {
      const result = await (span ? span.within(work) : work());
      span?.end(
        result?.status === "unknown"
          ? "unknown"
          : result?.status === "failed"
            ? "failed"
            : result?.status === "stale"
              ? "skipped"
              : result?.status === "confirmed"
                ? "completed"
                : "deferred",
        result ? `DELIVERY_${result.status.toUpperCase()}` : "DELIVERY_MISSING",
      );
      return result;
    } catch (error) {
      span?.end("failed", "DELIVERY_FAILED");
      throw error;
    }
  }
  private async deliverParts(id: string, span?: TraceScope): Promise<Delivery | null> {
    const { repository, journal, orm } = this.options;
    let row = repository.row(id);
    if (!row) return null;
    while (!this.stopped && ["planned", "delivering"].includes(row.status)) {
      const delivery = repository.get(id)!;
      const target = JSON.parse(row.target) as OutboundTarget;
      const changed = journal
        .eventsAfter(row.conversation_id, row.source_through_seq, Number.MAX_SAFE_INTEGER)
        .items.some((event) =>
          observationRelevant(event, {
            topology: target.conversationKind === "private" ? "direct" : "shared",
            participantIds: [target.participantId ?? null],
            attentionMembers: target.attentionMembers,
          }),
        );
      const staleCode =
        this.now() >= row.deliver_by
          ? "DELIVERY_TTL_EXPIRED"
          : changed
            ? "CONVERSATION_CHANGED"
            : !this.options.authorize(target, delivery)
              ? "DELIVERY_AUTHORITY_CHANGED"
              : null;
      if (staleCode) {
        span?.update({ code: staleCode, details: { staleReason: staleCode } });
        const stale = repository.db.transaction(() => {
          const result = repository.stale(id, this.now());
          if (result) {
            this.projectLegacy(id);
            this.revision(id);
          }
          return result;
        })();
        if (stale) this.options.onStale?.(repository.get(id)!);
        break;
      }
      const claim = repository.db.transaction(() => {
        const value = repository.claimPart(id, this.now());
        if (value) this.revision(id);
        return value;
      })();
      if (!claim) break;
      const partSpan = this.options.telemetry?.start("bot.delivery.part", {
        channel: "onebot11",
        stage: "delivery",
        outputId: id,
        details: { partId: claim.part.id, ordinal: claim.part.ordinal, kind: claim.part.kind },
      });
      let result: OneBotSendResult;
      try {
        if ("text" in claim.payload) {
          result = await this.options.port.send({
            kind: target.conversationKind,
            peerId: target.peerId,
            message: qqTextSegments(
              claim.payload.text,
              claim.part.ordinal === 0 ? (target.participantId ?? null) : null,
            ),
          });
        } else {
          const file =
            this.options.stickerAvailable?.(claim.payload.stickerId, target, this.now()) === false
              ? null
              : this.options.stickerFile(claim.payload.stickerId);
          result = file
            ? await this.options.port.send({
                kind: target.conversationKind,
                peerId: target.peerId,
                message: [{ type: "image", data: { file } }],
              })
            : { kind: "not_sent", reason: "invalid_request" };
        }
      } catch {
        result = { kind: "unknown", reason: "transport_error" };
      }
      try {
        repository.db.transaction(() => {
          repository.settlePart(
            claim.part.id,
            {
              status: result.kind,
              ...(result.kind === "confirmed" ? { messageId: result.messageId } : {}),
            },
            this.now(),
          );
          // 平台 part 消息 ID 映射（§13.4）：只有确认送达的部件才映射到实际 part 正文；
          // 未确认（failed/unknown/not_sent）不作为已发原文，facts 保持该部件空缺。
          if (result.kind === "confirmed") {
            // 旧意图可能缺出站事实行：只按库内存在性判断，不凭模型拼身份。
            const factsExist =
              repository.db
                .query("SELECT 1 FROM qq_outbound_message_facts WHERE intent_id=?")
                .get(id) !== null;
            if (factsExist) {
              confirmQqOutboundPart(
                orm,
                {
                  intentId: id,
                  platformMessageId: result.messageId,
                  kind: claim.part.kind,
                  ordinal: claim.part.ordinal,
                  text: "text" in claim.payload ? claim.payload.text : null,
                },
                repository.db,
              );
            }
          }
          this.projectLegacy(id);
          this.revision(id);
        })();
        partSpan?.end(
          result.kind === "confirmed"
            ? "completed"
            : result.kind === "unknown"
              ? "unknown"
              : result.kind === "not_sent"
                ? "skipped"
                : "failed",
          `DELIVERY_PART_${result.kind.toUpperCase()}`,
        );
      } catch (error) {
        // The transport may have succeeded even though receipt persistence rolled back.
        // Preserve the sending row and original exception for existing recovery semantics.
        partSpan?.update({ details: { transportResult: result.kind } });
        partSpan?.end(
          result.kind === "confirmed" || result.kind === "unknown" ? "unknown" : "failed",
          "DELIVERY_PART_SETTLEMENT_FAILED",
        );
        throw error;
      }
      row = repository.row(id)!;
    }
    return repository.get(id);
  }
  housekeep(): number {
    const repository = this.options.repository;
    return repository.db.transaction(() => {
      const pending = repository.pending().map((d) => d.id);
      const count = repository.purgeExpired(this.now());
      for (const id of pending) {
        if (!["planned", "delivering"].includes(repository.get(id)!.status)) this.revision(id);
      }
      return count;
    })();
  }
  async runOnce(): Promise<number> {
    let count = 0;
    for (const d of this.options.repository.pending()) {
      if (this.stopped) break;
      await this.deliver(d.id);
      count++;
    }
    this.housekeep();
    return count;
  }
}
