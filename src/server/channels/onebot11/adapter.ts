import type { ConversationAddressing } from "../../../shared/contracts/conversation";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import { readQqBinding, readQqBindings } from "../../db/qq-binding-repository";
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
    const triggers = effectiveQqTriggers(binding, scheme);
    const path: QqSpeechKind =
      binding.kind === "private" || addressed
        ? "direct_reply"
        : triggers.follow_up && speakerKind === "member" && spoken !== null && occurredAt > spoken
          ? "follow_up"
          : "chiming_in";
    if (speakerKind === "anonymous" && !addressed) return;
    if (!triggers[path]) return;
    const immediate = path === "direct_reply" || path === "follow_up";
    if (immediate && this.now() - occurredAt > QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS) return;
    const conversation = journal.ensureOneBot(bindingId)!;
    // A consumed cursor means "observed", not "answered every participant". Existing
    // per-person opportunities remain authoritative even after another participant's reply.
    if (wakes.hasOfferedSource(conversation.id, seq)) return;
    const previous = wakes.latestParticipant(conversation.id, path, speakerId ?? "anonymous");
    if (previous && seq <= previous.throughSeq) return;
    if (!previous && seq <= conversation.consumedSeq) return;
    const mergeSeconds = immediate ? 0 : schemeRhythm(scheme).merge_window_seconds;
    const result = wakes.enqueueChanged({
      conversationId: conversation.id,
      cause: path,
      throughSeq: seq,
      dedupeKey:
        !immediate && previous?.status === "pending"
          ? previous.dedupeKey
          : `${path}:${conversation.id}:${key}`,
      readyAt: new Date(((restore ? occurredAt : this.now()) + mergeSeconds) * 1000).toISOString(),
      at: new Date(occurredAt * 1000).toISOString(),
      priority: immediate ? 100 : 50,
      mergeReadyAt: immediate ? "earliest" : "latest",
      onlyNewerSource: true,
    });
    if (result.changed) this.options.wake?.();
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
      // Restore each person's most recent activity and addressed input independently.
      // Permanent event identities alone are not readable conversation content after TTL.
      const candidates = journal.db
        .query(`WITH ranked AS (
        SELECT e.*,ROW_NUMBER() OVER(PARTITION BY speaker_id ORDER BY occurred_at_seconds DESC,rowid DESC) AS latest,
          ROW_NUMBER() OVER(PARTITION BY speaker_id,addressed ORDER BY occurred_at_seconds DESC,rowid DESC) AS latest_addressed
        FROM qq_events e WHERE account_id=? AND conversation_kind=? AND peer_id=? AND agent_id=?
          AND speaker_kind IN('member','anonymous')
      ) SELECT * FROM ranked e WHERE (latest=1 OR (addressed=1 AND latest_addressed=1))
        AND (EXISTS(SELECT 1 FROM qq_observation_text t WHERE t.event_key=e.event_key AND t.expires_at>?)
          OR EXISTS(SELECT 1 FROM qq_media_notes m WHERE m.event_key=e.event_key AND m.expires_at>?))
        ORDER BY occurred_at_seconds,event_key`)
        .all(
          scope.accountId,
          scope.conversationKind,
          scope.peerId,
          scope.agentId,
          new Date(this.now() * 1000).toISOString(),
          new Date(this.now() * 1000).toISOString(),
        ) as {
        event_key: string;
        occurred_at_seconds: number;
        speaker_id: string | null;
        speaker_kind: string;
        addressed: number | null;
      }[];
      if (!candidates.length) continue;
      const c = journal.ensureOneBot(binding.id)!;
      const legacyBoundary =
        c.consumedSeq === 0
          ? Math.max(
              lastQqSpeech(orm, scope)?.spokeAtSeconds ?? -1,
              readQqSends(orm, scope, 1)[0]?.sentAtSeconds ?? -1,
            )
          : -1;
      for (const candidate of candidates) {
        if (candidate.occurred_at_seconds <= legacyBoundary) continue;
        const event = journal.ingestOneBotEvent(candidate.event_key, binding.id);
        if (event)
          this.offer(
            binding.id,
            event.seq,
            candidate.event_key,
            candidate.occurred_at_seconds,
            candidate.speaker_id,
            candidate.speaker_kind,
            candidate.addressed === 1,
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
