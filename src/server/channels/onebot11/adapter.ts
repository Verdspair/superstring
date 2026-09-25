import type { ConversationAddressing } from "../../../shared/contracts/conversation";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import { readQqBinding, readQqBindings } from "../../db/qq-binding-repository";
import { newestMemberEventFor } from "../../db/qq-observation-intake";
import { effectiveQqTriggers, readQqScheme } from "../../db/qq-scheme-repository";
import { platformMessageWasSentByAssistant, readQqSends } from "../../db/qq-send-repository";
import { readQqSettings } from "../../db/qq-settings-repository";
import { lastQqSpeech } from "../../db/qq-speech-repository";
import { getAgentRow, type Orm } from "../../db/repositories";
import type { WakeRepository } from "../../db/wake-repository";
import type { QqObservation } from "../../services/onebot-protocol";
import {
  attentionTriggerFilter,
  QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS,
  sweepQqIdleTopics,
} from "../../services/qq-dispatch";
import type { ConversationIngress } from "../../services/qq-intake";

/** OneBot owns protocol addressing; QQ remains external to the application protocol. */
export class OneBot11Adapter implements ConversationIngress {
  constructor(
    private readonly options: {
      orm: Orm;
      journal: ConversationEventRepository;
      wakes: WakeRepository;
      nowSeconds?: () => number;
      wake?: () => void;
    },
  ) {}
  private now() {
    return this.options.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  }
  beforeRecord(bindingId: string): void {
    this.options.journal.ensureOneBot(bindingId);
  }
  afterRecord(bindingId: string, observation: QqObservation): void {
    const mentions = observation.segments.filter((s) => s.kind === "mention").map((s) => s.target);
    const reply = observation.replyToMessageId;
    const replyingToAgent =
      !!reply &&
      platformMessageWasSentByAssistant(this.options.orm, {
        accountId: observation.accountId,
        conversationKind: observation.conversation.kind,
        peerId: observation.conversation.peerId,
        platformMessageId: reply,
      });
    const addressing: ConversationAddressing = {
      reasons: [
        ...(observation.conversation.kind === "private" ? ["private" as const] : []),
        ...(mentions.includes(observation.accountId) ? ["mention" as const] : []),
        ...(replyingToAgent ? ["reply_to_agent" as const] : []),
      ],
      mentionIds: mentions,
      ...(reply ? { replyTo: { sourceId: reply } } : {}),
    };
    const event = this.options.journal.ingestOneBotEvent(
      observation.eventKey,
      bindingId,
      addressing,
    );
    if (event)
      this.offer(
        bindingId,
        event.seq,
        observation.eventKey,
        observation.occurredAtSeconds,
        observation.speaker.id,
      );
  }
  afterMedia(bindingId: string, eventKey: string): void {
    const notes = this.options.journal.db
      .query("SELECT id FROM qq_media_notes WHERE event_key=? AND note IS NOT NULL")
      .all(eventKey) as { id: string }[];
    const original = this.options.journal.db
      .query("SELECT occurred_at_seconds,speaker_id FROM qq_events WHERE event_key=?")
      .get(eventKey) as { occurred_at_seconds: number; speaker_id: string | null } | null;
    for (const note of notes) {
      const event = this.options.journal.ingestMedia(note.id, bindingId);
      if (event && original)
        this.offer(
          bindingId,
          event.seq,
          event.eventKey,
          original.occurred_at_seconds,
          original.speaker_id,
        );
    }
  }
  private offer(
    bindingId: string,
    seq: number,
    key: string,
    occurredAt: number,
    speakerId: string | null,
  ): void {
    const { orm, journal, wakes } = this.options;
    const binding = readQqBinding(orm, bindingId);
    if (!binding || binding.kind !== "private" || binding.paused) return;
    const settings = readQqSettings(orm),
      scheme = readQqScheme(orm, binding.schemeId);
    if (
      settings.enabled !== 1 ||
      settings.accountId !== binding.accountId ||
      !scheme ||
      getAgentRow(orm, binding.agentId)?.isActive !== 1 ||
      !effectiveQqTriggers(binding, scheme).direct_reply
    )
      return;
    const attention = attentionTriggerFilter(binding);
    if (attention && (!speakerId || !attention.includes(speakerId))) return;
    if (this.now() - occurredAt > QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS) return;
    const conversation = journal.ensureOneBot(bindingId)!;
    if (seq <= conversation.consumedSeq) return;
    wakes.enqueue({
      conversationId: conversation.id,
      cause: "direct_reply",
      throughSeq: seq,
      dedupeKey: `direct:${conversation.id}:${key}`,
      readyAt: new Date(this.now() * 1000).toISOString(),
      at: new Date(occurredAt * 1000).toISOString(),
      priority: 100,
    });
    this.options.wake?.();
  }
  scanImmediate(): void {
    const { orm, journal } = this.options;
    for (const binding of readQqBindings(orm)) {
      if (binding.kind !== "private") continue;
      const scope = {
        kind: "qq" as const,
        accountId: binding.accountId,
        conversationKind: binding.kind,
        peerId: binding.peerId,
        agentId: binding.agentId,
      };
      const newest = newestMemberEventFor(orm, scope, {
        attentionMembers: attentionTriggerFilter(binding) ?? undefined,
      });
      if (!newest) continue;
      const c = journal.ensureOneBot(binding.id)!;
      if (c.consumedSeq === 0) {
        const last = Math.max(
          lastQqSpeech(orm, scope)?.spokeAtSeconds ?? -1,
          readQqSends(orm, scope, 1)[0]?.sentAtSeconds ?? -1,
        );
        if (newest.occurredAtSeconds <= last) continue;
      }
      const event = journal.ingestOneBotEvent(newest.eventKey, binding.id);
      if (event)
        this.offer(
          binding.id,
          event.seq,
          newest.eventKey,
          newest.occurredAtSeconds,
          newest.speakerId,
        );
    }
  }
  sweep(nowSeconds = this.now()) {
    this.scanImmediate();
    const { orm, journal, wakes } = this.options;
    return sweepQqIdleTopics(
      orm,
      { nowSeconds },
      {
        conversationKinds: ["private"],
        hasPending(binding) {
          const c = journal.ensureOneBot(binding.id)!;
          return !!journal.db
            .query(
              "SELECT 1 FROM wake_signals WHERE conversation_id=? AND status IN('pending','leased')",
            )
            .get(c.id);
        },
        enqueue(input) {
          const c = journal.ensureOneBot(input.binding.id)!;
          const wake = wakes.enqueue({
            conversationId: c.id,
            cause: "idle_topic",
            throughSeq: c.lastSeq,
            dedupeKey: `idle:${c.id}:${input.basisSeconds}`,
            readyAt: new Date(nowSeconds * 1000).toISOString(),
            at: new Date(nowSeconds * 1000).toISOString(),
            priority: 0,
          });
          return {
            kind: "scheduled",
            conversationKey: input.conversationKey,
            path: "idle_topic",
            generation: wake.throughSeq,
            readyAtSeconds: nowSeconds,
          };
        },
      },
    );
  }
}
