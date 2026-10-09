import type { ConversationAddressing } from "../../../shared/contracts/conversation";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import { readQqBinding, readQqBindings } from "../../db/qq-binding-repository";
import { readEffectiveQqScheme } from "../../db/qq-group-config-repository";
import { effectiveQqTriggers, schemeRhythm } from "../../db/qq-scheme-repository";
import { platformMessageWasSentByAssistant, readQqSends } from "../../db/qq-send-repository";
import { readQqSettings } from "../../db/qq-settings-repository";
import { lastQqSpeech } from "../../db/qq-speech-repository";
import { getAgentRow, type Orm } from "../../db/repositories";
import type { WakeRepository } from "../../db/wake-repository";
import type { RuntimeTelemetry } from "../../observability/runtime-telemetry";
import type { QqObservation } from "../../services/onebot-protocol";
import { qqChimingBatchWindow } from "../../services/qq-chiming-time-window";
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
      telemetry?: RuntimeTelemetry;
      nowSeconds?: () => number;
      wake?: () => void;
      /** 模型准入的可用性提示（B ModelAdmission）；缺省视为可用。真实获取不在这里。 */
      admission?: { available(model?: string): boolean };
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
    if (event) {
      const conversation = this.options.journal.get(event.conversationId);
      const span = this.options.telemetry?.start("bot.ingress", {
        channel: "onebot11",
        stage: "ingress",
        conversationId: event.conversationId,
        agentId: conversation?.agentId,
        sourceSeq: event.seq,
        sources: event.sources,
        details: {
          kind: "message",
          speakerKind: observation.speaker.kind,
          addressed: addressing.reasons.length > 0,
        },
      });
      const offer = () =>
        this.offer(
          bindingId,
          event.seq,
          observation.eventKey,
          observation.occurredAtSeconds,
          observation.speaker.id,
          observation.speaker.kind,
          addressing.reasons.length > 0,
        );
      if (span) span.within(offer);
      else offer();
      span?.end("completed", "INGRESS_RECORDED");
    }
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
      const conversation = this.options.journal.ensureOneBot(bindingId);
      const before = conversation?.lastSeq ?? 0;
      const event = this.options.journal.ingestMedia(note.id, bindingId);
      const span =
        event && event.seq > before
          ? this.options.telemetry?.start("bot.ingress.media", {
              channel: "onebot11",
              stage: "ingress",
              code: "MEDIA_REVISION_RECORDED",
              conversationId: event.conversationId,
              agentId: conversation?.agentId,
              sourceSeq: event.seq,
              sources: event.sources,
            })
          : undefined;
      if (event && original) {
        const offer = () =>
          this.offer(
            bindingId,
            event.seq,
            event.eventKey,
            original.occurred_at_seconds,
            original.speaker_id,
            original.speaker_kind,
            original.addressed === 1,
          );
        if (span) span.within(offer);
        else offer();
      }
      span?.end("observed", "MEDIA_REVISION_RECORDED");
    }
  }
  /**
   * 自主批次的合格成员事件数：从边界起逐条数 journal 事实（不是 seq 差值）。成员身份、
   * attention 名单与来源内容有效期都在计数里过滤；匿名与系统消息从来不是合格目标。
   * `onebot:` 前缀是 journal 侧事件键的通道标记，观察表键没有这个前缀。
   */
  private eligibleChimingCount(
    conversationId: string,
    boundary: number,
    attention: readonly string[] | null,
    directEnabled: boolean,
  ): { count: number; firstEligibleSeconds: number | null } {
    const placeholders = (attention ?? []).map(() => "?").join(",");
    const row = this.options.journal.db
      .query(
        `SELECT COUNT(*) AS n,MIN(CAST(strftime('%s',ce.occurred_at) AS INTEGER)) AS first_at FROM conversation_events ce
      WHERE ce.conversation_id=? AND ce.seq>? AND ce.kind='inbound' AND ce.source_kind='qq_event'
        AND json_extract(ce.participant,'$.role')='member'
        AND (${attention ? `json_extract(ce.participant,'$.id') IN (${placeholders})` : "1=1"})
        -- direct 开启时被指名事件由直接回应独占；关闭时它们仍可进入剩余模式计数，
        -- 除非该 source 已经被一次 direct 机会真正处理过。
        AND (?=0 OR json_array_length(ce.addressing,'$.reasons')=0)
        AND ce.seq NOT IN (
          SELECT w.through_seq FROM wake_signals w
          WHERE w.conversation_id=? AND w.cause='direct_reply'
        )
        AND (
          EXISTS(SELECT 1 FROM qq_observation_text t WHERE t.event_key=substr(ce.event_key,8) AND t.expires_at>?)
          OR EXISTS(SELECT 1 FROM qq_media_notes m WHERE m.event_key=substr(ce.event_key,8) AND m.expires_at>?)
        )`,
      )
      .get(
        conversationId,
        boundary,
        ...(attention ?? []),
        directEnabled ? 1 : 0,
        conversationId,
        new Date(this.now() * 1000).toISOString(),
        new Date(this.now() * 1000).toISOString(),
      ) as { n: number; first_at: number | null };
    // 没有合格输入就没有时间窗（空白周期不调用模型），所以这里必须回传"没有"。
    return {
      count: row.n,
      firstEligibleSeconds: row.first_at === null ? null : Math.floor(row.first_at),
    };
  }

  private coalesceChiming(
    conversationId: string,
    seq: number,
    readySeconds: number,
    nowSeconds: number,
  ) {
    const readyAt = new Date(readySeconds * 1000).toISOString();
    // 活动时刻永远是**现在**：为下界排队的未来 ready_at 不是"某条消息刚才到了"，写进
    // created_at 会让"最新一条机会"的排序按未来算，扫描与恢复因此会读错批次。
    const at = new Date(nowSeconds * 1000).toISOString();
    // 只复用**未认领**的 pending：`source_from_seq IS NULL`＝下界还没冻结，这一条才是本批
    // 仍可合并的机会。已认领的行（评分失败重排、或已判但回复失败后仍在重试）下界已冻结，
    // 它评分成功与否都不是下一批，新人消息绝不推它的 throughSeq——否则阶段一冻结的候选、
    // 同一 wake 的判定 raw 与幂等重试身份都会被改写。
    const reusable = this.options.journal.db
      .query(
        `SELECT dedupe_key AS k FROM wake_signals
      WHERE conversation_id=? AND cause='chiming_in' AND status='pending' AND source_from_seq IS NULL
      ORDER BY created_at DESC,id DESC LIMIT 1`,
      )
      .get(conversationId) as { k: string } | null;
    return this.options.wakes.enqueueChanged({
      conversationId,
      cause: "chiming_in",
      throughSeq: seq,
      dedupeKey: reusable?.k ?? `chiming_in:${conversationId}:${seq}`,
      readyAt,
      at,
      priority: 50,
      mergeReadyAt: "earliest",
      onlyNewerSource: true,
    });
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
    const report = (
      code: string,
      status: "scheduled" | "skipped",
      wakeId?: string,
      details?: Record<string, string | number | boolean | null>,
    ) => {
      if (!this.options.telemetry || (restore && status !== "scheduled")) return;
      const conversation = journal.db
        .query(
          "SELECT id,agent_id FROM conversations WHERE channel='onebot11' AND source_id=? AND closed_at IS NULL ORDER BY binding_epoch DESC LIMIT 1",
        )
        .get(bindingId) as { id: string; agent_id: string } | null;
      const event = conversation
        ? journal.eventsAfter(conversation.id, Math.max(0, seq - 1), 1).items[0]
        : undefined;
      this.options.telemetry.record("bot.wake.offer", {
        channel: "onebot11",
        stage: "wake",
        status,
        code,
        conversationId: conversation?.id,
        agentId: binding?.agentId,
        wakeId,
        sourceSeq: seq,
        sources: event?.sources,
        details: { restored: restore, ...details },
      });
    };
    if (!binding) {
      report("BINDING_MISSING", "skipped");
      return;
    }
    if (binding.paused) {
      report("CONVERSATION_PAUSED", "skipped");
      return;
    }
    if (speakerKind === "system") {
      report("SYSTEM_OBSERVATION", "skipped");
      return;
    }
    // 本群差异随基础方案一起读：触发分类、合并窗口与冷却用生效值，不是基础值。
    const settings = readQqSettings(orm),
      scheme = readEffectiveQqScheme(orm, binding);
    if (settings.enabled !== 1) {
      report("FEATURE_OFF", "skipped");
      return;
    }
    if (settings.accountId !== binding.accountId) {
      report("ACCOUNT_MISMATCH", "skipped");
      return;
    }
    if (!scheme) {
      report("SCHEME_MISSING", "skipped");
      return;
    }
    if (getAgentRow(orm, binding.agentId)?.isActive !== 1) {
      report("AGENT_UNAVAILABLE", "skipped");
      return;
    }
    const attention = attentionTriggerFilter(binding);
    if (attention && (!speakerId || !attention.includes(speakerId))) {
      report("ATTENTION_EXCLUDED", "skipped");
      return;
    }
    const triggers = effectiveQqTriggers(binding, scheme);
    const path: QqSpeechKind =
      (binding.kind === "private" || addressed) && triggers.direct_reply
        ? "direct_reply"
        : triggers.follow_up && speakerKind === "member"
          ? // direct 关闭时私聊与被指名的事件都并入 continuous，不另设窗口。
            "follow_up"
          : "chiming_in";
    // 匿名没有稳定 ID，不能成为连续/自主的目标；沿用既有 skip，不编 ID。
    if (speakerKind === "anonymous" && path !== "direct_reply") {
      report("ANONYMOUS_UNADDRESSED", "skipped");
      return;
    }
    if (!triggers[path]) {
      report("TRIGGER_OFF", "skipped", undefined, { cause: path });
      return;
    }
    const immediate = path === "direct_reply";
    // 连续交谈是"必回"：只有 direct 是要抢时效的立即路径。continuous 不设额外硬超时，
    // 消息过不过期只由来源内容自己的保留期决定。
    if (immediate && this.now() - occurredAt > QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS) {
      report("OPPORTUNITY_EXPIRED", "skipped", undefined, { cause: path });
      return;
    }
    const conversation = journal.ensureOneBot(bindingId)!;
    // A consumed cursor means "observed", not "answered every participant". Existing
    // per-person opportunities remain authoritative even after another participant's reply.
    if (wakes.hasOfferedSource(conversation.id, seq)) {
      report("SOURCE_ALREADY_OFFERED", "skipped");
      return;
    }
    const previous = wakes.latestParticipant(conversation.id, path, speakerId ?? "anonymous");
    if (previous && seq <= previous.throughSeq) {
      report("SOURCE_ALREADY_COVERED", "skipped");
      return;
    }
    if (path === "chiming_in") {
      // 自主批次的两维窗口：条数与时间都是**资源名额**而非随机采样或防抖，任一成熟即可判。
      // 时间窗关闭时退回纯计数模式（只看 [X−Y, X+Y]），与 0054 的行为逐字一致；没有合格
      // 输入就没有窗口，空白周期不调用模型。
      const rhythm = schemeRhythm(scheme);
      const nowSeconds = this.now();
      const eligible = this.eligibleChimingCount(
        conversation.id,
        journal.chimingInObservedSeq(conversation.id),
        attention,
        triggers.direct_reply,
      );
      const judgedAt = journal.chimingInJudgedAt(conversation.id);
      const window = qqChimingBatchWindow({
        rhythm,
        count: eligible.count,
        firstEligibleSeconds: eligible.firstEligibleSeconds,
        judgedAtSeconds: judgedAt === null ? null : Math.floor(Date.parse(judgedAt) / 1000),
        nowSeconds,
      });
      if (window.kind === "none") {
        report("BATCH_INSUFFICIENT", "skipped", undefined, { cause: path, count: window.count });
        return;
      }
      // 会话级合并：只有未认领且仍含未判消息的 pending 才是本批可合并机会；已认领的重试
      // （无论评分成功与否）都不并入，已结算批次的旧事件也不重判。判定游标之后的输入才
      // 形成新机会——"新消息可形成新机会"。
      const reusable = journal.db
        .query(
          `SELECT through_seq AS t FROM wake_signals
      WHERE conversation_id=? AND cause='chiming_in' AND status='pending' AND source_from_seq IS NULL
      ORDER BY created_at DESC,id DESC LIMIT 1`,
        )
        .get(conversation.id) as { t: number } | null;
      if (!reusable) {
        // 没有可合并的未认领机会时，只有跨过**本会话已认领/已结算过的最大范围**的输入才
        // 另起一批。范围相等也算覆盖：已认领的重试（判定失败或回复失败重排）虽然下界
        // 冻结、不接受新人消息，但它覆盖的那些 source 仍在同一条唤醒里等重试，
        // 恢复扫描不得为同一批范围再开一条新机会。
        const covered = journal.db
          .query(
            "SELECT MAX(through_seq) AS t FROM wake_signals WHERE conversation_id=? AND cause='chiming_in'",
          )
          .get(conversation.id) as { t: number | null };
        if (covered.t !== null && seq <= covered.t) {
          report("BATCH_ALREADY_SETTLED", "skipped", undefined, { cause: path });
          return;
        }
      }
      // 名额提示按实际判断模型取（global+provider 两条件都在准入里判定）；
      // settings 的判断模型为空时跟随绑定助手的对话模型。真实获取仍只在模型准入。
      const judgeModel =
        readQqSettings(orm).judgementModelName ?? getAgentRow(orm, binding.agentId)?.modelName;
      if (window.expired && !(this.options.admission?.available(judgeModel || undefined) ?? true)) {
        if (!rhythm.initiative_queue_on_busy) {
          journal.db
            .transaction(() => {
              const throughSeq = journal.sourceThroughSeq(conversation.id);
              // 本事件先并入会话级机会，再把该机会在同一事务结算为 skipped 终态——持久
              // 台账 = no_output+BATCH_SKIPPED_BUSY 行，随后推进边界；不留"以后会 judge
              // 已消费范围"的 pending，已在跑的（leased）不动。跳过不是有效判定：只消费
              // 边界，不写 chiming_in_judged_at，所以时间窗不从此刻重计。
              const coalesced = this.coalesceChiming(conversation.id, seq, nowSeconds, nowSeconds);
              if (coalesced.wake.status === "pending") {
                wakes.skipPending(coalesced.wake.id, {
                  at: new Date(nowSeconds * 1000).toISOString(),
                  throughSeq,
                  errorCode: "BATCH_SKIPPED_BUSY",
                });
              }
              journal.advanceChimingInObservedSeq(conversation.id, throughSeq);
            })
            .immediate();
          report("BATCH_SKIPPED_BUSY", "skipped", undefined, { cause: path, count: window.count });
          return;
        }
        // 繁忙 ON：保留同一个未判机会，不推 ready_at、不重置退避，只是让上界到期这件事
        // 本身成为可以判定的理由——判定时机由宿主读时间锚决定，不靠这里再排一次队。
        const kept = this.coalesceChiming(conversation.id, seq, nowSeconds, nowSeconds);
        if (kept.changed) {
          report("WAKE_SCHEDULED", "scheduled", kept.wake.id, {
            cause: path,
            readyAt: kept.wake.readyAt,
            merged: previous?.id === kept.wake.id,
            count: window.count,
            busy: true,
          });
          this.options.wake?.();
        }
        return;
      }
      // 未过期：机会照入队；时间窗还没到下界时 ready_at 落在下界那一刻，否则 worker 会
      // 领走一批时间上还不该判的消息。条数已够就立刻可领。上界由起算锚独立推出。
      const readySeconds = window.kind === "waiting" ? window.readyAtSeconds : nowSeconds;
      const coalesced = this.coalesceChiming(conversation.id, seq, readySeconds, nowSeconds);
      if (coalesced.changed) {
        report("WAKE_SCHEDULED", "scheduled", coalesced.wake.id, {
          cause: path,
          readyAt: coalesced.wake.readyAt,
          merged: previous?.id === coalesced.wake.id,
          count: window.count,
          waitingForSeconds: window.kind === "waiting",
        });
        this.options.wake?.();
      }
      return;
    }
    // continuous 按人滚动：只有 direct 立即。mergeReadyAt=latest 让同一人的下一条消息把自己的
    // 窗口顺延到"最后到达 + merge"，别人的消息不推迟他。
    const rolling = path === "follow_up";
    const result = wakes.enqueueChanged({
      conversationId: conversation.id,
      cause: path,
      throughSeq: seq,
      dedupeKey:
        previous?.status === "pending" ? previous.dedupeKey : `${path}:${conversation.id}:${key}`,
      readyAt: new Date(
        // merge 只属 continuous；direct 无论 fresh 还是恢复都立即成熟（恢复用原到达时刻）。
        (rolling
          ? occurredAt + schemeRhythm(scheme).merge_window_seconds
          : restore
            ? occurredAt
            : this.now()) * 1000,
      ).toISOString(),
      at: new Date(occurredAt * 1000).toISOString(),
      priority: immediate ? 100 : 50,
      mergeReadyAt: "latest",
      onlyNewerSource: true,
    });
    if (result.changed) {
      report("WAKE_SCHEDULED", "scheduled", result.wake.id, {
        cause: path,
        readyAt: result.wake.readyAt,
        merged: previous?.id === result.wake.id,
      });
      this.options.wake?.();
    }
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
        SELECT event_key,occurred_at_seconds,speaker_id,speaker_kind,addressed,
          ROW_NUMBER() OVER(PARTITION BY speaker_id ORDER BY occurred_at_seconds DESC,rowid DESC) AS latest,
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
  /**
   * 时间维度的扫尾：时间窗的成熟与上界都来自持久事实，不依赖又一条入站消息。
   *
   * 未认领的自主机会到点即可被领取，所以这里只处理一件事——上界已过而模型名额仍被占用时，
   * 按繁忙设置要么保留、要么在同一事务里显式跳过并消费边界。跳过不是有效判定：只推进观察
   * 边界，不写判定时刻，所以时间窗不会从此刻重计。已认领的重试不在这里动。
   */
  /**
   * 时间维度的扫尾，在派发之前跑。
   *
   * 两件事，都用**当前**唯一游标与判定时刻重新派生，所以不需要新消息来触发：
   *
   * 1) 重锚。有效判定会在判定途中更新游标与判定时刻，此前为下一批排好的 ready_at 因此过时：
   *    若不纠正，它会在旧时刻被领取，把刚判完的这一轮立刻再判一次——那等于用同一条消息
   *    开了第二个窗。等待中的机会按当前锚与 [A−B, A+B] 重新推出 ready_at，**可以往后**；
   *    条数已成熟的仍立刻可领。重锚只碰未认领的行，已认领的重试下界已冻结，一字不动。
   * 2) 上界扫尾。到上界仍无模型名额时，按繁忙设置显式跳过并消费边界；跳过不是有效判定，
   *    只推进观察边界，不写判定时刻，所以时间窗不从此刻重计。
   */
  private sweepChimingWindows(nowSeconds: number): void {
    const { orm, journal, wakes, telemetry } = this.options;
    const rows = journal.db
      .query(
        `SELECT w.id AS id,w.conversation_id AS conversation_id,w.through_seq AS through_seq,
          w.ready_at AS ready_at,c.source_id AS binding_id
      FROM wake_signals w JOIN conversations c ON c.id=w.conversation_id
      WHERE w.cause='chiming_in' AND w.status='pending' AND w.source_from_seq IS NULL
        AND c.closed_at IS NULL AND c.channel='onebot11'`,
      )
      .all() as {
      id: string;
      conversation_id: string;
      through_seq: number;
      ready_at: string;
      binding_id: string;
    }[];
    for (const row of rows) {
      const binding = readQqBinding(orm, row.binding_id);
      if (!binding || binding.paused) continue;
      const settings = readQqSettings(orm);
      if (settings.enabled !== 1 || settings.accountId !== binding.accountId) continue;
      const scheme = readEffectiveQqScheme(orm, binding);
      if (!scheme) continue;
      const rhythm = schemeRhythm(scheme);
      const eligible = this.eligibleChimingCount(
        row.conversation_id,
        journal.chimingInObservedSeq(row.conversation_id),
        attentionTriggerFilter(binding),
        effectiveQqTriggers(binding, scheme).direct_reply,
      );
      const judgedAt = journal.chimingInJudgedAt(row.conversation_id);
      const window = qqChimingBatchWindow({
        rhythm,
        count: eligible.count,
        firstEligibleSeconds: eligible.firstEligibleSeconds,
        judgedAtSeconds: judgedAt === null ? null : Math.floor(Date.parse(judgedAt) / 1000),
        nowSeconds,
      });
      // 材料没了（合格输入为 0），或还有输入但没到条数下界：这两种都关掉这条过时机会，
      // 因为它留在可领集合里就会被在条件不足时领走。关闭不推进观察边界、不写判定时刻，
      // 消息仍然保留并继续计入，之后的新输入凑够下界时另起一批。
      if (eligible.count === 0 || window.kind === "none") {
        const noSource = eligible.count === 0;
        const reason = noSource ? "BATCH_NO_ELIGIBLE_SOURCE" : "BATCH_WAITING_FOR_COUNT";
        journal.db
          .transaction(() => {
            wakes.skipPending(row.id, {
              at: new Date(nowSeconds * 1000).toISOString(),
              throughSeq: row.through_seq,
              errorCode: reason,
            });
          })
          .immediate();
        telemetry?.record("bot.wake.offer", {
          channel: "onebot11",
          stage: "wake",
          status: "skipped",
          code: reason,
          conversationId: row.conversation_id,
          agentId: binding.agentId,
          wakeId: row.id,
          sourceSeq: row.through_seq,
          details: { cause: "chiming_in", count: eligible.count, swept: true },
        });
        continue;
      }
      if (window.kind === "waiting") {
        const derivedAt = new Date(window.readyAtSeconds * 1000).toISOString();
        // 只往后纠正：更早的 ready_at 由领取侧的到期判定处理，这里不把机会拉回过去。
        if (derivedAt > row.ready_at) {
          journal.db
            .query(
              "UPDATE wake_signals SET ready_at=? WHERE id=? AND status='pending' AND source_from_seq IS NULL AND ready_at<?",
            )
            .run(derivedAt, row.id, derivedAt);
        }
      }
      if (!window.expired) continue;
      const judgeModel =
        readQqSettings(orm).judgementModelName ?? getAgentRow(orm, binding.agentId)?.modelName;
      if (this.options.admission?.available(judgeModel || undefined) ?? true) continue;
      if (rhythm.initiative_queue_on_busy) continue;
      journal.db
        .transaction(() => {
          const throughSeq = journal.sourceThroughSeq(row.conversation_id);
          wakes.skipPending(row.id, {
            at: new Date(nowSeconds * 1000).toISOString(),
            throughSeq: Math.max(row.through_seq, throughSeq),
            errorCode: "BATCH_SKIPPED_BUSY",
          });
          journal.advanceChimingInObservedSeq(row.conversation_id, throughSeq);
        })
        .immediate();
      telemetry?.record("bot.wake.offer", {
        channel: "onebot11",
        stage: "wake",
        status: "skipped",
        code: "BATCH_SKIPPED_BUSY",
        conversationId: row.conversation_id,
        agentId: binding.agentId,
        wakeId: row.id,
        sourceSeq: row.through_seq,
        details: { cause: "chiming_in", count: window.count, swept: true },
      });
    }
  }

  sweep(nowSeconds = this.now()) {
    this.migrateLegacyCandidates();
    this.scanImmediate();
    this.sweepChimingWindows(nowSeconds);
    const { orm, journal, wakes, telemetry } = this.options;
    return sweepQqIdleTopics(
      orm,
      { nowSeconds },
      {
        hasPending(binding) {
          const c = journal.ensureOneBot(binding.id)!;
          // 冷场发起有自己的安静前提，不能被一条**尚未到判定时刻**的自主机会永久挡住。
          // 已认领的自主批、判定失败重排、以及已到 ready_at 的自主机会仍然是真实待办。
          return !!journal.db
            .query(
              `SELECT 1 FROM wake_signals
        WHERE conversation_id=? AND (
          status='leased'
          OR (status='pending' AND NOT (cause='chiming_in' AND source_from_seq IS NULL AND ready_at>?))
        )`,
            )
            .get(c.id, new Date(nowSeconds * 1000).toISOString());
        },
        enqueue(input) {
          const c = journal.ensureOneBot(input.binding.id)!;
          const result = wakes.enqueueChanged({
            conversationId: c.id,
            cause: "idle_topic",
            throughSeq: journal.sourceThroughSeq(c.id),
            dedupeKey: `idle:${c.id}:${input.basisSeconds}`,
            readyAt: new Date(nowSeconds * 1000).toISOString(),
            at: new Date(nowSeconds * 1000).toISOString(),
            priority: 0,
          });
          const wake = result.wake;
          if (result.changed)
            telemetry?.record("bot.wake.offer", {
              channel: "onebot11",
              stage: "wake",
              status: "scheduled",
              code: "WAKE_SCHEDULED",
              conversationId: c.id,
              agentId: c.agentId,
              wakeId: wake.id,
              sourceSeq: wake.throughSeq,
              details: { cause: "idle_topic", readyAt: wake.readyAt },
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
