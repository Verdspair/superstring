import type { ConversationAddressing } from "../../../shared/contracts/conversation";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import { readQqBinding, readQqBindings } from "../../db/qq-binding-repository";
import { newestMemberEventFor } from "../../db/qq-observation-intake";
import { effectiveQqTriggers, readQqScheme, schemeRhythm } from "../../db/qq-scheme-repository";
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
import type { QqSpeechKind } from "../../services/qq-speaking-contract";
/** OneBot supplies source/addressing facts; every Bot opportunity enters the same durable queue. */
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
        observation.speaker.kind,
        addressing.reasons.length > 0,
      );
  }
  afterMedia(bindingId: string, eventKey: string): void {
    const notes = this.options.journal.db
      .query("SELECT id FROM qq_media_notes WHERE event_key=? AND note IS NOT NULL")
      .all(eventKey) as { id: string }[];
    const original = this.options.journal.db
      .query(
        "SELECT occurred_at_seconds,speaker_id,speaker_kind,addressed FROM qq_events WHERE event_key=?",
      )
      .get(eventKey) as {
      occurred_at_seconds: number;
      speaker_id: string | null;
      speaker_kind: string;
      addressed: number;
    } | null;
    for (const note of notes) {
      const event = this.options.journal.ingestMedia(note.id, bindingId);
      if (event && original)
        this.offer(
          bindingId,
          event.seq,
          event.eventKey,
          original.occurred_at_seconds,
          original.speaker_id,
          original.speaker_kind,
          original.addressed === 1,
        );
    }
  }
  private offer(
    bindingId: string,
    seq: number,
    key: string,
    occurredAt: number,
    speakerId: string | null,
    speakerKind: string,
    addressed: boolean,
    restore = false,
  ): void {
    const { orm, journal, wakes } = this.options;
    const binding = readQqBinding(orm, bindingId);
    if (!binding || binding.paused || speakerKind === "system") return;
    const settings = readQqSettings(orm),
      scheme = readQqScheme(orm, binding.schemeId);
    if (
      settings.enabled !== 1 ||
      settings.accountId !== binding.accountId ||
      !scheme ||
      getAgentRow(orm, binding.agentId)?.isActive !== 1
    )
      return;
    const attention = attentionTriggerFilter(binding);
    if (attention && (!speakerId || !attention.includes(speakerId))) return;
    const scope = {
      kind: "qq" as const,
      accountId: binding.accountId,
      conversationKind: binding.kind,
      peerId: binding.peerId,
      agentId: binding.agentId,
    };
    const spoken = lastQqSpeech(orm, scope)?.spokeAtSeconds ?? null;
    const path: QqSpeechKind =
      binding.kind === "private" || addressed
        ? "direct_reply"
        : speakerKind === "member" && spoken !== null && occurredAt > spoken
          ? "follow_up"
          : "chiming_in";
    if (speakerKind === "anonymous" && !addressed) return;
    if (!effectiveQqTriggers(binding, scheme)[path]) return;
    const immediate = path === "direct_reply" || path === "follow_up";
    if (immediate && this.now() - occurredAt > QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS) return;
    const conversation = journal.ensureOneBot(bindingId)!;
    if (seq <= conversation.consumedSeq) return;
    const pending = !immediate
      ? (journal.db
          .query(
            "SELECT dedupe_key FROM wake_signals WHERE conversation_id=? AND cause=? AND status='pending' ORDER BY created_at LIMIT 1",
          )
          .get(conversation.id, path) as { dedupe_key: string } | null)
      : null;
    const mergeSeconds = immediate ? 0 : schemeRhythm(scheme).merge_window_seconds;
    wakes.enqueue({
      conversationId: conversation.id,
      cause: path,
      throughSeq: seq,
      dedupeKey: pending?.dedupe_key ?? `${path}:${conversation.id}:${key}`,
      readyAt: new Date(
        (restore ? Math.max(this.now(), occurredAt + mergeSeconds) : this.now() + mergeSeconds) *
          1000,
      ).toISOString(),
      at: new Date(occurredAt * 1000).toISOString(),
      priority: immediate ? 100 : 50,
      mergeReadyAt: immediate ? "earliest" : "latest",
    });
    this.options.wake?.();
  }
  /** Restore source-backed opportunities; the platform message that addressed us may not be newest. */
  scanImmediate(): void {
    const { orm, journal } = this.options;
    for (const binding of readQqBindings(orm)) {
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
      const addressed =
        binding.kind === "private"
          ? newest
          : newestMemberEventFor(orm, scope, {
              attentionMembers: attentionTriggerFilter(binding) ?? undefined,
              addressedOnly: true,
            });
      const c = journal.ensureOneBot(binding.id)!;
      const legacyBoundary =
        c.consumedSeq === 0
          ? Math.max(
              lastQqSpeech(orm, scope)?.spokeAtSeconds ?? -1,
              readQqSends(orm, scope, 1)[0]?.sentAtSeconds ?? -1,
            )
          : -1;
      for (const candidate of new Map(
        [newest, addressed]
          .filter((e): e is NonNullable<typeof e> => !!e)
          .map((e) => [e.eventKey, e]),
      ).values()) {
        if (candidate.occurredAtSeconds <= legacyBoundary) continue;
        const event = journal.ingestOneBotEvent(candidate.eventKey, binding.id);
        const source = journal.db
          .query("SELECT speaker_kind FROM qq_events WHERE event_key=?")
          .get(candidate.eventKey) as { speaker_kind: string };
        if (event)
          this.offer(
            binding.id,
            event.seq,
            candidate.eventKey,
            candidate.occurredAtSeconds,
            candidate.speakerId,
            source.speaker_kind,
            candidate.addressed,
            true,
          );
      }
    }
  }
  /** Transfer pre-refactor queued opportunities once, retaining their ready time and path. */
  migrateLegacyCandidates(): number {
    const { orm, journal, wakes } = this.options;
    return journal.db
      .transaction(() => {
        if (
          journal.db
            .query(
              "SELECT 1 FROM qq_dispatch_lease WHERE token IS NOT NULL AND expires_at_seconds>?",
            )
            .get(this.now())
        )
          return 0;
        const rows = journal.db.query("SELECT * FROM qq_dispatch_candidates").all() as {
          conversation_key: string;
          binding_id: string;
          event_key: string | null;
          path: QqSpeechKind;
          generation: number;
          ready_at_seconds: number;
          observed_at_seconds: number;
        }[];
        if (!rows.length) return 0;
        journal.db
          .query(
            "UPDATE qq_dispatch_lease SET token=NULL,conversation_key=NULL,generation=NULL,expires_at_seconds=NULL WHERE expires_at_seconds<=?",
          )
          .run(this.now());
        let count = 0;
        for (const row of rows) {
          const binding = readQqBinding(orm, row.binding_id);
          if (!binding) continue;
          const c = journal.ensureOneBot(binding.id)!;
          const event = row.event_key ? journal.ingestOneBotEvent(row.event_key, binding.id) : null;
          if (!row.event_key || event) {
            wakes.enqueue({
              conversationId: c.id,
              cause: row.path,
              throughSeq: event?.seq ?? journal.sourceThroughSeq(c.id),
              dedupeKey: `legacy:${c.id}:${row.conversation_key}:${row.generation}`,
              readyAt: new Date(row.ready_at_seconds * 1000).toISOString(),
              at: new Date(row.observed_at_seconds * 1000).toISOString(),
              priority:
                row.path === "direct_reply" || row.path === "follow_up"
                  ? 100
                  : row.path === "chiming_in"
                    ? 50
                    : 0,
            });
            count++;
          }
          journal.db
            .query("DELETE FROM qq_dispatch_candidates WHERE conversation_key=? AND generation=?")
            .run(row.conversation_key, row.generation);
        }
        return count;
      })
      .immediate();
  }
  sweep(nowSeconds = this.now()) {
    this.migrateLegacyCandidates();
    this.scanImmediate();
    const { orm, journal, wakes } = this.options;
    return sweepQqIdleTopics(
      orm,
      { nowSeconds },
      {
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
            throughSeq: journal.sourceThroughSeq(c.id),
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
