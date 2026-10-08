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
  qqReplySegments,
} from "../services/qq-send-transport";
import { observationRelevant } from "./observation-relevance";

/** Durable side effects. No model call can occur inside a transport transaction. */
export class OutboundDelivery {
  private stopped = false;
  /** 已占用的发送车道；名额与等待者由实例共享，多个 runOnce 不会各自超发。 */
  private lanesInFlight = 0;
  private readonly laneWaiters: Array<() => void> = [];
  /** 本实例正在跑投递循环的会话：跨 runOnce 去重，同一会话不会占两个空车道。 */
  private readonly activeConversations = new Set<string>();
  /** Finish an in-flight receipt, while leaving unstarted work durable for a new worker. */
  stop(): void {
    this.stopped = true;
    // 等待名额的循环被唤醒后按 stopped 退出；已在飞的发送仍会收到回执并结算。
    for (const wake of this.laneWaiters.splice(0)) wake();
  }
  /**
   * 策略调高/撤销后由装配处调用（接既有配置更新通知，无定时器轮询）：唤醒等待者按**当前**
   * 上限重新准入。不调用也不会卡死——每次释放都会再准入一次，只是调高后要等下一次释放。
   */
  notifyPolicyChange(): void {
    for (const wake of this.laneWaiters.splice(0)) wake();
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
      /**
       * 本宿主同时允许几条真实发送（车道数）。它是**发送资源**，不是模型帽：默认不限，
       * 生产由装配处按既有 QQ 并发资源注入（getter 形式，每次准入现读当前值）。同一个实例
       * 共享这个名额，所以并发多次 runOnce 也不会突破它；下调后排队者不会再按旧值被放行。
       */
      deliveryConcurrency?: number | (() => number);
    },
  ) {}
  /** 车道数每次准入现读：动态下调后，排队者不会再按旧值被放行。 */
  private laneLimit(): number {
    const configured = this.options.deliveryConcurrency;
    const value = typeof configured === "function" ? configured() : configured;
    return Math.max(1, value ?? Number.POSITIVE_INFINITY);
  }
  /** 取一条发送车道；停止时返回 false，调用方不发新请求，已在飞的照常结算。 */
  private async acquireLane(): Promise<boolean> {
    while (!this.stopped && this.lanesInFlight >= this.laneLimit())
      await new Promise<void>((resolve) => this.laneWaiters.push(resolve));
    if (this.stopped) return false;
    this.lanesInFlight += 1;
    return true;
  }
  /** 归还一条车道：只减一，再唤醒一个等待者按当前上限复核——不会向上限之外放行。 */
  private releaseLane(): void {
    this.lanesInFlight -= 1;
    this.laneWaiters.shift()?.();
  }
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
          const payload = claim.payload;
          const firstPart = claim.part.ordinal === 0;
          // New structured parts carry mentions explicitly (including an empty list), so the
          // shared encoder never invents a recipient. Legacy parts keep their historical CQ and
          // first-part recipient behavior; quote metadata is independent of that branch.
          const sendPayload = {
            text: payload.text,
            ...(payload.mentions === undefined
              ? {}
              : { mentions: firstPart ? payload.mentions : [] }),
            ...(firstPart && payload.replyToMessageId !== undefined
              ? { replyToMessageId: payload.replyToMessageId }
              : {}),
          };
          result = await this.options.port.send({
            kind: target.conversationKind,
            peerId: target.peerId,
            message: qqReplySegments(
              sendPayload,
              firstPart && payload.mentions === undefined ? (target.participantId ?? null) : null,
            ),
          });
        } else {
          const file =
            this.options.stickerAvailable?.(claim.payload.stickerId, target, this.now()) === false
              ? null
              : this.options.stickerFile(claim.payload.stickerId);
          if (!file) {
            result = { kind: "not_sent", reason: "invalid_request" };
          } else {
            const payload = claim.payload;
            const firstPart = claim.part.ordinal === 0;
            result = await this.options.port.send({
              kind: target.conversationKind,
              peerId: target.peerId,
              message: qqReplySegments({
                stickerFile: file,
                ...(payload.mentions === undefined
                  ? {}
                  : { mentions: firstPart ? payload.mentions : [] }),
                ...(firstPart && payload.replyToMessageId !== undefined
                  ? { replyToMessageId: payload.replyToMessageId }
                  : {}),
              }),
            });
          }
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
  /**
   * 投递所有待发意图。**按会话分车道**：慢群的真实 HTTP 只占它自己的车道，别的会话照常推进；
   * 同一会话里的意图仍按原顺序串行投递——单意图的部件顺序与同人前后窗口的顺序由这段串行与
   * 仓储里 claim 时的会话内因果检查共同保证，不引入第二条发送队列。
   *
   * 车道数＝发送资源上限（`deliveryConcurrency`，默认不限，每次准入现读）。它是发送上限而不是
   * 模型帽，且由实例共享，所以并发多次 runOnce 也不会超发；同一会话已有循环在跑就不再起一条，
   * 避免重复会话占空车道。停止后不再发新请求，等待者按 stopped 退出。
   */
  async runOnce(): Promise<number> {
    if (this.stopped) return 0;
    const byConversation = new Map<string, string[]>();
    for (const delivery of this.options.repository.pending()) {
      const ids = byConversation.get(delivery.conversationId);
      if (ids) ids.push(delivery.id);
      else byConversation.set(delivery.conversationId, [delivery.id]);
    }
    let count = 0;
    const workers: Promise<void>[] = [];
    for (const [conversationId, ids] of byConversation) {
      if (this.activeConversations.has(conversationId)) continue;
      this.activeConversations.add(conversationId);
      workers.push(
        (async () => {
          try {
            if (!(await this.acquireLane())) return;
            try {
              for (const id of ids) {
                if (this.stopped) break;
                await this.deliver(id);
                count++;
              }
            } finally {
              this.releaseLane();
            }
          } finally {
            this.activeConversations.delete(conversationId);
          }
        })(),
      );
    }
    await Promise.all(workers);
    this.housekeep();
    return count;
  }
}
