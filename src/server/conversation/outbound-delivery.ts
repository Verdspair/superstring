import type { Delivery } from "../../shared/contracts/conversation";
import type { ConversationEventRepository } from "../db/conversation-event-repository";
import type { OutboundIntentRepository, OutboundTarget } from "../db/outbound-intent-repository";
import { recordQqSend } from "../db/qq-send-repository";
import type { Orm } from "../db/repositories";
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
    const { repository, journal } = this.options;
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
      if (this.now() >= row.deliver_by || changed || !this.options.authorize(target, delivery)) {
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
      repository.db.transaction(() => {
        repository.settlePart(
          claim.part.id,
          {
            status: result.kind,
            ...(result.kind === "confirmed" ? { messageId: result.messageId } : {}),
          },
          this.now(),
        );
        this.projectLegacy(id);
        this.revision(id);
      })();
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
