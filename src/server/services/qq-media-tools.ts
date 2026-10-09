// 0.4.0 P5 媒体工具（ADR0019 §8.11）：list 列本会话已记录的图片元数据，note.read 读取
// typed baseline 读取任务保存的描述，describe 显式花一次读取（effect=write；经真实
// `readQqMediaTaskOnce` 消费 0052 的 typed 任务账本——同一媒体行一个 baseline 任务、
// 每任务至多两次尝试，换模型/改策略不重置已消耗的尝试），read 取得当前 scope 的原生图像
// 输入（effect=read：初次下载/准备缓存是只读资源的派生缓存，不伪称外部写）。
// addressed/relatedSupplement 等授权事实由宿主从 journal 得出，模型只给 id 与分页参数；
// note.read/describe/read 只认本 run 由 media.list 披露过的 id。成功描述的来源引用是
// `qq_media_read_task`（任务删除/正文改写/窗口到期都会改变复算哈希），不再把 note 写回
// legacy 媒体行；0052 迁移的 legacy baseline 任务仍可读，其模型按 reader 缓存规则如实出示。
// list/note.read/describe 的"已描述"真值一律来自 typed baseline 任务按当前 model/policy
// 的可服务性（与 reader 缓存匹配同一条规则），绝不读 legacy note/旧 attempts 旧账。

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import {
  QQ_MEDIA_TOOL_DESCRIPTIONS,
  QQ_MEDIA_TOOL_SCHEMAS,
} from "../../shared/contracts/agent-action-descriptions";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { QqConversationScope } from "../../shared/contracts/qq-message";
import type { ActionContext, BuiltInAction, EvidenceResultFitter } from "../agent/built-in-actions";
import type { ActionObservation } from "../agent/context-engine";
import { readBindingByConversation } from "../db/qq-binding-repository";
import { readQqGroupAgentConfig } from "../db/qq-group-config-repository";
import { mediaAssetForMediaNote } from "../db/qq-media-asset-repository";
import type { QqMediaNoteRow } from "../db/qq-media-repository";
import {
  findMediaReadTask,
  findMediaReadTaskByIdentity,
  findServableMediaReadTaskById,
  findServableMediaReadTaskByIdentity,
  MediaReadTaskRejectedError,
  type MediaTaskSourceGuard,
  mediaReadTaskIdentityKey,
} from "../db/qq-media-task-repository";
import { readQqSettings } from "../db/qq-settings-repository";
import { DEFAULT_USER_ID, nowIso, type Orm } from "../db/repositories";
import * as schema from "../db/schema";
import { fail, isAppError } from "../errors";
import type { EvidenceStore } from "../modules/conversation-evidence-store";
import type { QqBinding } from "./qq-binding-contract";
import { qqMediaModelFor } from "./qq-media-contract";
import {
  type QqMediaReadAdapter,
  type QqMediaTaskReadInput,
  readQqMediaTaskOnce,
} from "./qq-media-reader";
import { createQqMediaSourceRef } from "./qq-media-sources";
import { createQqMediaReadTaskSourceRef } from "./qq-media-task-sources";

/** 列表项只有元数据：取流引用、url、路径与正文一概不出现。 */
interface MediaListItem {
  readonly id: string;
  readonly eventKey: string;
  readonly index: number;
  readonly kind: "image";
  readonly described: boolean;
  readonly attempts: number;
}
/** 列表项只有元数据：取流引用、url、路径与正文一概不出现。 */
type ListValue =
  | { readonly status: "ok"; readonly items: MediaListItem[]; readonly nextCursor: string | null }
  | { readonly status: "unavailable"; readonly code: string };
type NoteReadValue =
  | {
      readonly status: "ok";
      readonly id: string;
      readonly model: string;
      readonly text: string;
      readonly offset: number;
      readonly nextOffset: number | null;
    }
  | { readonly status: "undescribed"; readonly id: string; readonly attempts: number }
  | { readonly status: "unavailable"; readonly code: string };
type DescribeStatus =
  | { readonly status: "described"; readonly described: true; readonly attempt: number }
  | {
      readonly status: "failed";
      readonly described: false;
      readonly attempt: number;
      readonly awaitSupplement: boolean;
    }
  | { readonly status: "unavailable"; readonly code: string };
type DescribeValue = DescribeStatus;
interface DescribeOutcome {
  readonly value: DescribeStatus;
  readonly sources: SourceRef[];
}

/** One prepared picture projected to the model: metadata, never bytes. */
export interface QqMediaReadImage {
  readonly source: SourceRef;
  readonly mimeType: string;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly frameIndex: number | null;
}

/**
 * The frozen anchor of one detail question, resolved by the HOST from a real
 * message: the model only ever passes a message id, never wording. The host
 * checks that the message is this turn's question message (the answered
 * message or one it directly quotes), that its real original text is readable
 * and belongs to this conversation, and that the image sits in that
 * question's own media range; it then normalizes the ORIGINAL text into the
 * question key. `assertQuestionCurrent` re-checks all of that inside the read
 * task's claim transaction — a question that moved, changed or lost its image
 * range stops the read instead of authorizing a new one.
 */
export interface QqMediaQuestionAnchor {
  /** normalizeQuestionKey of the real original question (host-derived). */
  readonly questionKey: string;
  /** The question message's internal event key (journal-scoped identity). */
  readonly eventKey: string;
  /** The real original text's revision; the in-transaction guard re-derives it. */
  readonly bodyRevision: string;
  /** The real original message's own source ref — the question's evidence. */
  readonly source: SourceRef;
  /** In-transaction re-check of focus/direct membership, body and media range. */
  readonly assertQuestionCurrent: MediaTaskSourceGuard;
}

/** Host resolver for the optional `questionMessageId` pointer; null = refuse. */
export type QqMediaQuestionAnchorResolver = (input: {
  readonly questionMessageId: string;
  readonly mediaNoteId: string;
  readonly eventKey: string;
  readonly segmentIndex: number;
  readonly now: string;
}) => QqMediaQuestionAnchor | null;

/**
 * One servable description the identity ledger holds for the CURRENT carrier's
 * bytes, as the host's controlled reader resolved it. `sources` carries BOTH
 * pieces of evidence — the ledger's own result ref and the current carrier's
 * media ref — because a media ref alone cannot prove the note text is still the
 * one that was read (a rewritten note must revoke it). `metadataOnly` asks for a
 * zero-fetch answer (list surfaces), so a host never downloads just to render a
 * flag — it waives the download ONLY. Every authorization re-verification (host
 * boundary epochs, current-carrier authorization, both refs with their scope and
 * expiry, model/policy identity, the detail question anchor) still runs, because
 * these are read-only truth checks and skipping them would let the flag vouch for
 * a revoked, expired, foreign or malformed-question case.
 */
export interface QqServableMediaDescription {
  readonly note: string;
  readonly modelName: string;
  readonly policy: string;
  readonly attempts: number;
  readonly taskId: string;
  readonly sources: readonly SourceRef[];
}

/**
 * Host-controlled read-only consumption of the identity ledger for one current
 * carrier. It NEVER writes, never claims and never spends an attempt: the
 * budget row is the ledger's single row, and this path only reads a result
 * that is already there. The host re-verifies current-carrier authorization,
 * the result's own model/policy and every consumed window, and mints the
 * evidence refs; `null` means "nothing servable here" and never a guess.
 */
export type QqServableMediaDescriptionResolver = (input: {
  readonly mediaNoteId: string;
  readonly eventKey: string;
  readonly segmentIndex: number;
  readonly mediaKind: string;
  readonly purpose: "baseline" | "detail";
  readonly questionKey?: string | null;
  /** The model the current adapter would pick; the ledger's own model must match. */
  readonly modelName: string;
  /** The frozen policy string; the ledger's own policy must match. */
  readonly policy: string;
  /**
   * The exact ledger row the controlled reader already resolved for THIS read
   * (its cache consumption re-verified scope, bytes, model and policy). When
   * present it is the primary key: the host re-reads that exact row instead of
   * re-deriving the identity. The row is only consumed when the current carrier
   * is the row's own carrier, or the row is an identity-backed result for this
   * carrier's bytes.
   */
  readonly taskId?: string;
  readonly now: string;
  readonly metadataOnly: boolean;
  /** In-transaction re-check of the current carrier's authorization. */
  readonly assertCurrent: MediaTaskSourceGuard;
  /** Present only for a detail read; the anchor the host already frozen. */
  readonly question?: {
    readonly eventKey: string;
    readonly bodyRevision: string;
    readonly assertQuestionCurrent: MediaTaskSourceGuard;
  };
}) => QqServableMediaDescription | null;

/** The host-injected picture service behind `media.read` (spec T08 Step8). */
export type QqMediaReadImageService = (input: {
  readonly mediaNoteId: string;
  readonly eventKey: string;
  readonly sourceRef: string;
  readonly signal?: AbortSignal;
  /**
   * The read's purpose. `detail` is set only when the model pointed at a real
   * question message the host has already frozen (see
   * `QqMediaQuestionAnchor`); the picture service then prepares the image for
   * that question — a finer read than the first baseline description — and
   * re-checks the anchor in whatever transaction it authorizes the read in.
   * Omitted fields mean a plain first read; baseline callers see the exact
   * previous shape.
   */
  readonly purpose?: "baseline" | "detail";
  readonly questionKey?: string;
  readonly question?: {
    readonly eventKey: string;
    readonly source: SourceRef;
    readonly assertQuestionCurrent: MediaTaskSourceGuard;
  };
}) => Promise<{
  readonly category: "ordinary" | "expression" | "unknown";
  readonly images: readonly QqMediaReadImage[];
}>;

type MediaReadValue =
  | {
      readonly status: "ok";
      readonly mediaId: string;
      readonly category: "ordinary" | "expression" | "unknown";
      readonly images: readonly {
        readonly sourceId: string;
        readonly revision: string;
        readonly mimeType: string;
        readonly sha256: string;
        readonly width: number | null;
        readonly height: number | null;
        readonly frameIndex: number | null;
      }[];
    }
  | { readonly status: "unavailable"; readonly code: string };

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_READ_LIMIT = 2048;
/**
 * baseline 任务的稳定策略形状标识：typed 结果缓存匹配由形状标识 + 宿主给出的真实
 * 策略修订共同决定（改方案参数＝改修订串后旧结果不再复用；任务身份不含它，
 * 换参数不重置已消耗的尝试）。baseline 读取没有可配置的产品策略面——形状只有这一版。
 */
const POLICY_BASELINE_SHAPE = "baseline/v1";
/**
 * 一次 describe 的完整策略串：形状标识 + 宿主在构造时冻结的真实策略修订。缓存的
 * 匹配语义由 reader 按 `policy` 字段精确比较——同一修订串才复用，不比较子串。
 */
const baselinePolicyOf = (policyRevision: string) => `${POLICY_BASELINE_SHAPE}/${policyRevision}`;
/** 补充扫描的有界行数：窗口内最多看这么多条 journal 入站消息。 */
const SUPPLEMENT_SCAN_LIMIT = 200;
/** 每 run 的上限：到顶一律给安全 unavailable，绝不抛无码异常。 */
const MAX_DISCLOSED = 512;
const MAX_CURSORS = 512;

export interface QqMediaToolsOptions {
  readonly db: Database;
  readonly orm: Orm;
  readonly conversationId: string;
  readonly binding: QqBinding;
  readonly adapter: QqMediaReadAdapter;
  readonly modelConfig: {
    readonly visionModelName: string | null;
    readonly transcriptionModelName: string | null;
  };
  readonly supplementWindowMinutes: number;
  /**
   * baseline 读取的真实策略修订：宿主从生效方案的实际媒体输入形状规范化得出（prompt、
   * 帧数、最大边）。它是 typed 结果缓存的匹配维度——改方案参数后旧结果不再按旧策略复用，
   * 但任务身份不含它，已消耗的尝试不因换参数重置。
   */
  readonly policyRevision: string;
  readonly assertCurrent: () => void;
  readonly fit: (
    name: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<EvidenceResultFitter>;
  /** 宿主时钟（nowIso 形状）；省略＝真实时钟。过期与补充窗口都用它。 */
  readonly now?: () => string;
  /**
   * typed 读取任务落成（成功或失败结清）后的通知：宿主用 `actualTaskId` 诊断，不读事件
   * 细节本身；必须幂等（同一 run 会重复触发）。
   *
   * 语义边界：它通知的是「本 carrier 在本 run 刚拿到／结清了一份可服务读
   * 结果」这一**状态**，不是「新建了一个预算任务」。因此跨 carrier 复用成功（预算行
   * 仍是账本上那唯一一行、未新建也未 claim）同样按本条规则通知，报主账本行的 taskId；
   * 未交付（失败／未授权／签不出证据）一律不通知。`media.note.read` 不发本通知——
   * 它没有任务结清语义，证据走 ActionObservation 的 sources。
   */
  readonly onDescribed?: (eventKey: string, actualTaskId: string) => void;
  /**
   * 证据仓库：`qq_media_read_task` 引用的签发方（真实任务投影 + journal 时间线复验）。
   * typed 描述来源必须能被 context-access 复验。
   */
  readonly evidence: EvidenceStore;
  /**
   * 冻结进 describe 边界的宿主授权快照（缺省＝构造时按真实字段现查：qq_settings.revision
   * 与本群 capability_revisions['media']）；边界事务里逐项复验，动了就按原 reason 抛。
   */
  readonly mediaEpochs?: {
    readonly globalRevision: number;
    readonly groupCapabilityRevision: number;
  };
  /**
   * `media.read` 背后的受控图片服务（宿主接线，缺省＝不广告该动作）。信任边界在宿主：
   * 它只接受本会话 scope 的媒体行，返回的 sources 是它真实记录的引用。
   */
  readonly readImage?: QqMediaReadImageService;
  /**
   * Host resolver for the optional `questionMessageId` pointer on
   * `media.describe` / `media.read` (omitted = the pointer is never servable,
   * so both tools keep their exact first-read behaviour). The resolver decides
   * whether the pointed-at message really is this turn's question for this
   * image and freezes the question key from the real original text; tools never
   * re-derive it and never use model wording.
   */
  readonly resolveQuestion?: QqMediaQuestionAnchorResolver;
  /**
   * Host-controlled read-only consumption of the identity ledger for the
   * current carrier (omitted = per-carrier rows only, the previous behaviour).
   * One budget row per content identity: a re-delivered same-bytes carrier reads
   * the SAME served result with NO extra attempt, while every authorization
   * (current carrier scope, model/policy match, both evidence refs and their
   * windows) is re-verified by the host on this carrier.
   */
  readonly servableDescription?: QqServableMediaDescriptionResolver;
}

/** 与内建证据工具相同的运行态键：同一 (owner, runId) 的三个工具共享一张披露表。 */
function contextKey(context: Pick<ActionContext, "owner" | "runId">): string {
  const { kind, id, userId, agentId } = context.owner;
  return JSON.stringify([context.runId ?? null, kind, id, userId ?? null, agentId ?? null]);
}
/** 续页游标：per-run 随机 token → 页尾 keyset 位置；不可伪造、不跨 run。 */
interface ListCursor {
  readonly occurredAtSeconds: number;
  readonly eventKey: string;
  readonly segmentIndex: number;
}
interface MediaRunState {
  readonly key: string;
  /** 建立这张表的信号；只有它中止才回收整张表。 */
  readonly signal: AbortSignal;
  active: boolean;
  readonly disclosed: Set<string>;
  readonly outcomes: Map<string, DescribeOutcome>;
  readonly cursors: Map<string, ListCursor>;
  release(): void;
}

/** Typed 描述来源成功才签发：`createQqMediaReadTaskSourceRef` 对不完整授权一律回 null。 */

export function createQqMediaTools(options: QqMediaToolsOptions): BuiltInAction[] {
  const binding = options.binding;
  const identity = { accountId: binding.accountId, kind: binding.kind, peerId: binding.peerId };
  const now = () => options.now?.() ?? nowIso();
  const journalKey = (eventKey: string) => `onebot:${eventKey}`;
  const unavailableValue = () => ({ status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED" });
  const policyBaseline = baselinePolicyOf(options.policyRevision.trim());
  if (policyBaseline === `${POLICY_BASELINE_SHAPE}/`)
    fail("CONTEXT_SOURCE_INVALID", "媒体读取策略修订缺失");

  /**
   * 冻结进 describe 边界守卫的宿主授权快照（构造时逐项现查，边界事务里复验）：
   * 真实全局 media 开关纪元取 `qq_settings.revision`（enable/account 等任何字段翻转都会
   * +1，是该行唯一的现成纪元计数）；本群 media 能力停用纪元取 capability_revisions
   * （无记录＝0＝跟随开）。非群绑定的 group config 为空视图，纪元也是 0。不硬编码
   * 任何自造 epoch。
   */
  const mediaEpochs =
    options.mediaEpochs ??
    (() => {
      const config = readQqGroupAgentConfig(options.orm, {
        id: binding.id,
        agentId: binding.agentId,
        kind: binding.kind,
      });
      return {
        globalRevision: readQqSettings(options.orm).revision,
        groupCapabilityRevision: config.capability_revisions.get("media") ?? 0,
      };
    })();

  /** Typed 描述来源成功才签发：`createQqMediaReadTaskSourceRef` 对不完整授权一律回 null。 */
  const readTaskRefOrNull = (taskId: string, at: string): SourceRef | null => {
    const scope = currentScope();
    return scope === null
      ? null
      : createQqMediaReadTaskSourceRef(options.evidence, scope, taskId, at);
  };

  /** 接线校验：只接受这条绑定在用的会话/绑定 owner；其余形状一律 CONTEXT_SOURCE_INVALID。 */
  function assertWired(context: ActionContext): void {
    const { kind, id, userId, agentId } = context.owner;
    const wired =
      userId === DEFAULT_USER_ID &&
      agentId === binding.agentId &&
      ((kind === "conversation" && id === options.conversationId) ||
        (kind === "qq_binding" && id === binding.id));
    if (!wired) fail("CONTEXT_SOURCE_INVALID", "媒体工具与调用方接线不一致");
  }

  const runs = new Map<string, MediaRunState>();
  /** 释放某个 (owner, runId) 下的全部运行态；对不存在的范围是空操作（幂等）。 */
  function releaseRun(scope: Pick<ActionContext, "owner" | "runId">): void {
    runs.get(contextKey(scope))?.release();
  }
  function runState(context: ActionContext, create: boolean): MediaRunState {
    context.signal.throwIfAborted();
    const key = contextKey(context);
    const existing = runs.get(key);
    if (existing) return existing;
    if (!create) fail("CONTEXT_INVALID_SELECTION", "媒体引用不属于本轮已披露的列表");
    const state: MediaRunState = {
      key,
      signal: context.signal,
      active: true,
      disclosed: new Set(),
      outcomes: new Map(),
      cursors: new Map(),
      release() {
        state.active = false;
        state.disclosed.clear();
        state.outcomes.clear();
        state.cursors.clear();
        state.signal.removeEventListener("abort", state.release);
        if (runs.get(key) === state) runs.delete(key);
      },
    };
    runs.set(key, state);
    // 只认建立这张表的信号：外部调用的信号中止只让在飞调用失败，不回收运行态。
    state.signal.addEventListener("abort", state.release, { once: true });
    return state;
  }
  /** 每个边界都复验：取消、运行态、宿主权威、宿主当前性。 */
  function boundary(state: MediaRunState, context: ActionContext): void {
    context.signal.throwIfAborted();
    if (!state.active || state.key !== contextKey(context))
      fail("CONTEXT_INVALID_SELECTION", "引用不属于本轮已披露的媒体");
    context.assertAuthority?.();
    options.assertCurrent();
  }

  interface ConversationRow {
    source_id: string;
    agent_id: string;
    binding_epoch: number;
  }
  function conversationRow(): ConversationRow | null {
    return (
      (options.db
        .query(
          "SELECT source_id,agent_id,binding_epoch FROM conversations WHERE id=? AND closed_at IS NULL",
        )
        .get(options.conversationId) as ConversationRow | null) ?? null
    );
  }
  function mediaRowById(id: string): QqMediaNoteRow | null {
    return (
      options.orm.select().from(schema.qqMediaNotes).where(eq(schema.qqMediaNotes.id, id)).get() ??
      null
    );
  }
  function eventRow(eventKey: string): typeof schema.qqEvents.$inferSelect | null {
    return (
      options.orm
        .select()
        .from(schema.qqEvents)
        .where(eq(schema.qqEvents.eventKey, eventKey))
        .get() ?? null
    );
  }

  type Scope = { ok: true; reasons: readonly string[] } | { ok: false; code: string };
  /** 范围 / owner / 绑定 / 过期逐次复验。失效一律是安全拒绝值，不是异常。 */
  function scopeFor(row: QqMediaNoteRow, event: typeof schema.qqEvents.$inferSelect): Scope {
    const conversation = conversationRow();
    if (
      !conversation ||
      conversation.source_id !== binding.id ||
      conversation.agent_id !== binding.agentId
    )
      return { ok: false, code: "conversation_changed" };
    const current = readBindingByConversation(options.orm, identity);
    if (
      !current ||
      current.id !== binding.id ||
      current.agentId !== binding.agentId ||
      current.paused ||
      current.revision !== binding.revision
    )
      return { ok: false, code: "binding_changed" };
    if (
      event.accountId !== binding.accountId ||
      event.conversationKind !== binding.kind ||
      event.peerId !== binding.peerId ||
      event.agentId !== binding.agentId
    )
      return { ok: false, code: "conversation_changed" };
    const journal = options.db
      .query(
        "SELECT addressing FROM conversation_events WHERE conversation_id=? AND event_key=? AND kind='inbound'",
      )
      .get(options.conversationId, journalKey(row.eventKey)) as { addressing: string } | null;
    if (!journal) return { ok: false, code: "conversation_changed" };
    if (Date.parse(row.expiresAt) <= Date.parse(now()))
      return { ok: false, code: "segment_expired" };
    let reasons: readonly string[] = [];
    try {
      const addressing = JSON.parse(journal.addressing) as { reasons?: unknown };
      reasons = Array.isArray(addressing.reasons)
        ? addressing.reasons.filter((reason): reason is string => typeof reason === "string")
        : [];
    } catch {
      reasons = [];
    }
    return { ok: true, reasons };
  }

  /**
   * typed 读取边的四维 owner：直接用调用上下文的 owner（assertWired 已保证它是本工厂
   * 接线的 conversation/qq_binding 形状），不二次猜测。reader 内部再做完整四维 + 归属校验。
   */
  function ownerOf(context: ActionContext): QqMediaTaskReadInput["owner"] {
    const { kind, id, userId, agentId } = context.owner;
    if (kind !== "conversation" && kind !== "qq_binding")
      fail("CONTEXT_SOURCE_INVALID", "媒体工具与调用方接线不一致");
    return { kind, id, userId: userId ?? DEFAULT_USER_ID, agentId: agentId ?? binding.agentId };
  }

  /**
   * typed 描述来源签发用的完整八维 scope：只从真实表现值构造（当前会话 + 绑定现值）。
   * 一项不齐（会话关闭、绑定缺失）就是 null——来源签发绝不猜。
   */
  function currentScope(): QqConversationScope | null {
    const conversation = conversationRow();
    if (
      !conversation ||
      conversation.source_id !== binding.id ||
      conversation.agent_id !== binding.agentId
    )
      return null;
    const current = readBindingByConversation(options.orm, identity);
    if (!current || current.id !== binding.id || current.agentId !== binding.agentId) return null;
    return {
      conversationId: options.conversationId,
      accountId: binding.accountId,
      conversationKind: binding.kind,
      peerId: binding.peerId,
      agentId: binding.agentId,
      bindingId: binding.id,
      bindingEpoch: conversation.binding_epoch,
      authorityRevision: current.authorityRevision,
    };
  }

  /**
   * §7.1/§8.11 的补充事实，全部来自 journal：更晚、在窗口内、晚于 typed 任务的最近一次
   * 已消耗尝试（任务 lastAttemptAt——claim CAS 打点的真实时刻，result/fail 不回写）、且是
   * member 的 @／reply_to_agent（群）或任意成员消息（私聊）。原图消息被显式排除——它不能
   * 当自己的补充；原图自己的 originalEvent 永远不算它自己的补充证据。
   */
  function freshSupplementLaterThan(
    row: QqMediaNoteRow,
    event: typeof schema.qqEvents.$inferSelect,
    notBeforeMs: number,
  ): boolean {
    const windowSeconds = Math.floor(options.supplementWindowMinutes * 60);
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return false;
    const from = new Date(event.occurredAtSeconds * 1000).toISOString();
    const to = new Date((event.occurredAtSeconds + windowSeconds) * 1000).toISOString();
    const candidates = options.orm
      .select({
        eventKey: schema.conversationEvents.eventKey,
        addressing: schema.conversationEvents.addressing,
        participant: schema.conversationEvents.participant,
        occurredAt: schema.conversationEvents.occurredAt,
      })
      .from(schema.conversationEvents)
      .where(
        and(
          eq(schema.conversationEvents.conversationId, options.conversationId),
          eq(schema.conversationEvents.kind, "inbound"),
          gt(schema.conversationEvents.occurredAt, from),
          lte(schema.conversationEvents.occurredAt, to),
        ),
      )
      .orderBy(desc(schema.conversationEvents.seq))
      .limit(SUPPLEMENT_SCAN_LIMIT)
      .all();
    return candidates.some((candidate) => {
      // 原图消息不能当它自己的补充（journal key 逐一排除，不按 kind 猜）。
      if (candidate.eventKey === journalKey(row.eventKey)) return false;
      if (!(Date.parse(candidate.occurredAt) > notBeforeMs)) return false;
      let role: unknown = null;
      let reasons: unknown[] = [];
      try {
        role = candidate.participant
          ? (JSON.parse(candidate.participant) as { role?: unknown }).role
          : null;
        const addressing = JSON.parse(candidate.addressing) as { reasons?: unknown };
        reasons = Array.isArray(addressing.reasons) ? addressing.reasons : [];
      } catch {
        return false;
      }
      if (role !== "member") return false;
      return binding.kind === "private"
        ? true
        : reasons.some(
            (reason) =>
              reason === "mention" || reason === "reply_to_agent" || reason === "legacy_addressed",
          );
    });
  }

  /** typed baseline 任务的键：本片只做 baseline（无 questionKey）。 */
  const baselineKey = (mediaNoteId: string) => ({ mediaNoteId, purpose: "baseline" as const });

  /** typed 任务的真实现值（list 元数据与补充比较基准都用它，绝不看 media row 的旧账）。 */
  function baselineTask(mediaNoteId: string) {
    return findMediaReadTask(options.orm, baselineKey(mediaNoteId));
  }

  /**
   * 补充证明的基准行：**同一 purpose 的那一条预算**，先按本载体找，找不到再按内容身份
   * 找 identity 账本行（同内容跨载体投递＝同一条预算，不因换载体重开）。绝不退回另一条
   * purpose 的行——detail 的基准永远不是 baseline，反之亦然。
   */
  function budgetRowForSupplement(input: {
    readonly row: QqMediaNoteRow;
    readonly event: typeof schema.qqEvents.$inferSelect;
    readonly purpose: "baseline" | "detail";
    readonly questionKey?: string;
  }) {
    const carrier = findMediaReadTask(options.orm, {
      mediaNoteId: input.row.id,
      purpose: input.purpose,
      ...(input.purpose === "detail" ? { questionKey: input.questionKey ?? "" } : {}),
    });
    if (carrier !== null) return carrier;
    const asset = mediaAssetForMediaNote(options.orm, {
      mediaNoteId: input.row.id,
      scope: {
        accountId: binding.accountId,
        conversationKind: binding.kind,
        peerId: binding.peerId,
        agentId: binding.agentId,
      },
      at: now(),
    });
    if (asset === null) return null;
    return findMediaReadTaskByIdentity(options.orm, {
      accountId: binding.accountId,
      conversationKind: binding.kind,
      peerId: binding.peerId,
      agentId: binding.agentId,
      segmentKind: input.row.segmentKind,
      purpose: input.purpose,
      ...(input.purpose === "detail" ? { questionKey: input.questionKey ?? "" } : {}),
      contentSha256: asset.asset.contentSha256,
    });
  }

  /**
   * list 的"已描述"元数据：typed 任务真值，按 reader 缓存匹配的同一条规则——成功任务
   * 且当前 adapter 实际会选的模型与冻结策略串都匹配才 `described`；legacy 迁移任务
   * （policy='legacy'）按其已验规则只认同模型。不读媒体行 note/旧 attempts 作真值；
   * 模型未配置时一律不算已描述（没有可服务的缓存结果）。
   */
  function describedForCurrentModelPolicy(
    task: NonNullable<ReturnType<typeof baselineTask>>,
    kind: "image",
  ): boolean {
    const choice = qqMediaModelFor(kind, options.modelConfig);
    if (task.status !== "succeeded" || task.note === null || choice.kind !== "configured")
      return false;
    if (task.modelName === null) return false;
    if (task.policy === "legacy" && task.id.startsWith("legacy-"))
      return task.modelName === choice.model;
    return task.modelName === choice.model && task.policy === policyBaseline;
  }

  /**
   * 宿主受控的 identity 消费（默认实现，可用 options.servableDescription 覆盖）：
   * 身份只由「本 carrier 现存的活资产」的内容哈希给出（零下载；没有活资产就没有同内容
   * 证明，绝不按行猜），再按同 scope + 同 kind + 同 purpose + 同问题 + 同字节只读查
   * 账本那一行。绝不自造行、绝不 claim、绝不动 attempts——那一行是唯一的预算。
   * 交付正文前两证据缺一不可：账本结果引用（正文被改写/删除/过期即撤）与本 carrier 的
   * 媒体引用（当前 carrier 的授权与窗口）。少一条就返回 null，交给上层按未描述处理。
   */
  const defaultServableDescription: QqServableMediaDescriptionResolver = (request) => {
    // 同内容证明只有一个来源：本 carrier 现存活资产的内容 sha，按四维 scope + kind +
    // purpose + 问题 + 该 sha 重算出 identity 键，与账本那一行的 identity_key 必须逐字
    // 相等。没有活资产 ⇒ 没有同内容证明 ⇒ 一律 fail closed，绝不按行猜、绝不旁路。
    // 「reader 曾经证明过」不等于「此刻对这一张图可用」：那条行可能属于另一张图。
    const asset = mediaAssetForMediaNote(options.orm, {
      mediaNoteId: request.mediaNoteId,
      scope: {
        accountId: binding.accountId,
        conversationKind: binding.kind,
        peerId: binding.peerId,
        agentId: binding.agentId,
      },
      at: request.now,
    });
    if (asset === null) return null;
    // 两条只读真源，共用上面这一个同内容证明：byId 先取「本次读取已证明的那一行」，
    // byIdentity 按重算出的 identity 键取唯一预算行。两者都再受同一把闸。
    const row =
      findServableMediaReadTaskById(options.orm, {
        taskId: request.taskId ?? "",
        modelName: request.modelName,
        policy: request.policy,
        now: request.now,
      }) ??
      findServableMediaReadTaskByIdentity(options.orm, {
        accountId: binding.accountId,
        conversationKind: binding.kind,
        peerId: binding.peerId,
        agentId: binding.agentId,
        segmentKind: request.mediaKind,
        purpose: request.purpose,
        questionKey: request.questionKey ?? null,
        contentSha256: asset.asset.contentSha256,
        modelName: request.modelName,
        policy: request.policy,
        now: request.now,
      });
    if (row === null) return null;
    // byId 那一支必须**当场重算** identity 键并与该行逐字比对：只有「这一行的
    // identity_key == 本 carrier 现存活资产重算出的键」才证明这一行讲的是这张图。
    // reader 曾经证明过 identity，不等于此刻对这张图可用——那一行可能属于另一张图。
    if (row.identityKey === null || row.identityKey.trim().length === 0) return null;
    if (
      row.identityKey !==
      mediaReadTaskIdentityKey({
        accountId: binding.accountId,
        conversationKind: binding.kind,
        peerId: binding.peerId,
        agentId: binding.agentId,
        segmentKind: request.mediaKind,
        purpose: request.purpose,
        questionKey: request.purpose === "detail" ? (request.questionKey ?? null) : null,
        contentSha256: asset.asset.contentSha256,
      })
    )
      return null;
    // 真实一致性：复用结果行必须就是刚才查到的那一行，model/policy 逐字相符。
    if (row.modelName !== request.modelName || row.note === null || row.note.trim().length === 0)
      return null;
    const scope = currentScope();
    if (scope === null) return null;
    const at = request.now;
    // 两证据：identity 结果引用（复合 id 受控引用，正文被改写/删除/过期即撤）与本
    // carrier 的媒体引用（当前 carrier 的授权与窗口）。前者显式带上当前 carrier，
    // 绝不签那个旧 carrier 自己的裸任务引用。
    const resultRef = createQqMediaReadTaskSourceRef(options.evidence, scope, row.id, at, {
      carrierMediaNoteId: request.mediaNoteId,
    });
    const carrierRef = createQqMediaSourceRef(options.evidence, scope, request.mediaNoteId, at);
    if (resultRef === null || carrierRef === null) return null;
    // 「不下载字节」只意味着省掉 fetch，**不意味着可以跳过任何授权复验**：list 的
    // described 标记同样要过 assertCurrent、当前 carrier 授权、两证据引用（含各自
    // 的 scope 与 expiry）、model/policy 身份，以及 detail 的问题锚
    // assertQuestionCurrent。这些全是只读真授权，不开任何新写事务；少了任何一项，
    // 标记就可能为跨 scope/已撤权/已过期/畸形问题背书。
    request.assertCurrent(options.orm);
    if (request.question !== undefined) request.question.assertQuestionCurrent(options.orm);
    return {
      note: row.note,
      modelName: row.modelName,
      policy: row.policy,
      attempts: row.attempts,
      taskId: row.id,
      sources: [resultRef, carrierRef],
    };
  };

  /**
   * 本 carrier 当前可服务的描述：判据只有一条真源——「本次 adapter 会选的模型 + 冻结
   * 策略串」的匹配（legacy 迁移任务按其已验规则只认同模型）。载体行任务优先（legacy
   * 语义不变）；没有载体行时，宿主受控的 identity 消费接口给出同内容另一 carrier 的
   * 已服务结果——预算只花过一次（不 claim、不动 attempts），来源由宿主按「本 carrier 的
   * 媒体 ref + identity 行的结果 ref」两证据签发，工具不自造行也不签裸 ref。
   * 两条路都没有 ⇒ null（绝不猜、绝不冒充正文）。
   */
  function servableDescription(input: {
    readonly row: QqMediaNoteRow;
    readonly event: typeof schema.qqEvents.$inferSelect;
    readonly purpose: "baseline" | "detail";
    readonly questionKey?: string | null;
    /** The reader-proven ledger row for this read, when there is one. */
    readonly taskId?: string;
    readonly metadataOnly: boolean;
    readonly assertCurrent: MediaTaskSourceGuard;
    readonly question?: {
      readonly eventKey: string;
      readonly bodyRevision: string;
      readonly assertQuestionCurrent: MediaTaskSourceGuard;
    };
  }): QqServableMediaDescription | null {
    const carrierTask = findMediaReadTask(options.orm, {
      mediaNoteId: input.row.id,
      purpose: input.purpose,
      ...(input.purpose === "detail" ? { questionKey: input.questionKey ?? "" } : {}),
    });
    if (carrierTask !== null && describedForCurrentModelPolicy(carrierTask, "image")) return null; // 载体行有可服务结果时，消费接口不介入（同一真源，只走一条路）。
    const resolver = options.servableDescription ?? defaultServableDescription;
    const choice = qqMediaModelFor("image", options.modelConfig);
    if (choice.kind !== "configured") return null;
    const served = resolver({
      mediaNoteId: input.row.id,
      eventKey: input.event.eventKey,
      segmentIndex: input.row.segmentIndex,
      mediaKind: input.row.segmentKind,
      purpose: input.purpose,
      ...(input.purpose === "detail" ? { questionKey: input.questionKey ?? "" } : {}),
      modelName: choice.model,
      policy: policyBaseline,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      now: now(),
      metadataOnly: input.metadataOnly,
      assertCurrent: input.assertCurrent,
      ...(input.question === undefined ? {} : { question: input.question }),
    });
    if (served === null) return null;
    if (served.taskId.trim().length === 0 || served.note.trim().length === 0) return null;
    if (served.modelName !== choice.model) return null;
    if (served.policy !== policyBaseline && served.policy !== "legacy") return null;
    // 复用结果的两条证据缺一不可：identity 行的结果 ref（正文被改写/删除/过期即撤）
    // 与本 carrier 的媒体 ref（当前 carrier 的授权与窗口）。只有本 carrier 自己那一行
    // 走既有单来源出口，由各调用点自己签——那条路不在这里。
    if (served.sources.length < 2) return null;
    return served;
  }

  /**
   * 冻结本轮问题锚：模型只给指针，宿主复验后才成为问题身份。无效选择返回 null 供模型修正；
   * 授权来源失效由宿主抛 CONTEXT_SOURCE_INVALID，保持致命。绝不用模型措辞造键，也不退回 baseline。
   */
  function resolveQuestionAnchor(input: {
    readonly row: QqMediaNoteRow;
    readonly questionMessageId: string;
  }): QqMediaQuestionAnchor | null {
    const resolve = options.resolveQuestion;
    if (resolve === undefined) fail("CONTEXT_INVALID_SELECTION", "当前轮次不支持按问题细读这张图");
    const anchor = resolve({
      questionMessageId: input.questionMessageId,
      mediaNoteId: input.row.id,
      eventKey: input.row.eventKey,
      segmentIndex: input.row.segmentIndex,
      now: now(),
    });
    if (anchor === null) return null;
    if (anchor.questionKey.trim().length === 0)
      fail("CONTEXT_SOURCE_INVALID", "问题消息没有可用的真实原文");
    return anchor;
  }

  /** 构造时冻结的八维初 scope：run 期间任何边界移动都按原 reason 抛，不拿新值续跑。 */
  const initialScope = ((): QqConversationScope => {
    const scope = currentScope();
    if (scope === null) fail("CONTEXT_SOURCE_INVALID", "媒体工具与会话接线不一致");
    return scope;
  })();

  /**
   * describe 的宿主边界守卫（claim/result/failure 每个事务里重跑）：冻结的八维 scope、
   * 全局 media 开关纪元与本群 media 能力纪元在同一事务里逐项复验，动了按原 reason 抛
   * （reader 把 authority 失败原样穿透，绝不吞成工具结果）。
   */
  function describeTaskGuard(event: typeof schema.qqEvents.$inferSelect): MediaTaskSourceGuard {
    return (tx: Orm) => {
      const conversation = tx
        .select({
          sourceId: schema.conversations.sourceId,
          agentId: schema.conversations.agentId,
          bindingEpoch: schema.conversations.bindingEpoch,
          closedAt: schema.conversations.closedAt,
        })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, initialScope.conversationId))
        .get();
      const bindingRow = tx
        .select({
          agentId: schema.qqBindings.agentId,
          authorityRevision: schema.qqBindings.authorityRevision,
          paused: schema.qqBindings.paused,
        })
        .from(schema.qqBindings)
        .where(eq(schema.qqBindings.id, initialScope.bindingId))
        .get();
      const settings = readQqSettings(tx);
      const config = readQqGroupAgentConfig(tx, {
        id: initialScope.bindingId,
        agentId: initialScope.agentId,
        kind: initialScope.conversationKind,
      });
      const capabilityRevision = config.capability_revisions.get("media") ?? 0;
      if (
        !conversation ||
        conversation.closedAt !== null ||
        conversation.bindingEpoch !== initialScope.bindingEpoch ||
        conversation.sourceId !== initialScope.bindingId ||
        conversation.agentId !== initialScope.agentId ||
        !bindingRow ||
        bindingRow.agentId !== initialScope.agentId ||
        bindingRow.authorityRevision !== initialScope.authorityRevision ||
        bindingRow.paused === 1 ||
        settings.revision !== mediaEpochs.globalRevision ||
        capabilityRevision !== mediaEpochs.groupCapabilityRevision ||
        event.accountId !== initialScope.accountId ||
        event.conversationKind !== initialScope.conversationKind ||
        event.peerId !== initialScope.peerId ||
        event.agentId !== initialScope.agentId
      ) {
        fail("CONTEXT_SOURCE_INVALID", "媒体读取的宿主授权已变化");
      }
    };
  }

  /**
   * fit 前后必须逐字一致的范围快照：媒体行的可见状态字段（note/read 的描述正文来源
   * changed 检测）+ 行 expiresAt。typed 任务的正文不在媒体行里，媒体行的 note 列不再是
   * note.read 的授权事实。
   */
  interface RowSnapshot {
    readonly id: string;
    readonly expiresAt: string;
  }
  function snapshot(row: QqMediaNoteRow): RowSnapshot {
    return {
      id: row.id,
      expiresAt: row.expiresAt,
    };
  }
  /** fit 之后的末次复验：行与范围仍与快照一致，否则只回安全拒绝值。 */
  function revalidated(snap: RowSnapshot): { ok: true } | { ok: false; code: string } {
    const fresh = mediaRowById(snap.id);
    if (!fresh) return { ok: false, code: "segment_missing" };
    if (fresh.expiresAt !== snap.expiresAt) return { ok: false, code: "segment_changed" };
    const event = eventRow(fresh.eventKey);
    if (!event) return { ok: false, code: "segment_missing" };
    const scope = scopeFor(fresh, event);
    return scope.ok ? { ok: true } : { ok: false, code: scope.code };
  }
  /** 列表候选的行内复验：身份、归属与过期逐项复核；返回失效码或 null。 */
  function listedStillValid(item: MediaListItem): string | null {
    const fresh = mediaRowById(item.id);
    if (
      !fresh ||
      fresh.eventKey !== item.eventKey ||
      fresh.segmentIndex !== item.index ||
      fresh.segmentKind !== "image"
    )
      return "segment_missing";
    const event = eventRow(fresh.eventKey);
    if (!event) return "segment_missing";
    const scope = scopeFor(fresh, event);
    return scope.ok ? null : scope.code;
  }

  /** 同一次 execute 只捕获一个 fitter：重复 fit 不重复计预留（宿主账本语义）。 */
  type FitCapture = () => Promise<EvidenceResultFitter>;
  function captureFit(
    context: ActionContext,
    name: string,
    arguments_: Record<string, unknown>,
  ): FitCapture {
    let captured: Promise<EvidenceResultFitter> | undefined;
    return () => (captured ??= options.fit(name, arguments_, context.signal));
  }
  /** 结果按完整信封拟合：装不下＝标准预算拒绝；fit 通过后还要复验行，失效就回拒绝码。 */
  async function settle(
    state: MediaRunState,
    context: ActionContext,
    fits: FitCapture,
    value: unknown,
    sources: SourceRef[],
    snap: RowSnapshot | null = null,
    also?: () => void,
  ): Promise<Omit<ActionObservation, "id" | "name">> {
    boundary(state, context);
    if (!(await fits())(value, sources)) return { value: unavailableValue(), sources: [] };
    if (snap !== null) {
      boundary(state, context);
      const check = revalidated(snap);
      if (!check.ok) return refuse(state, context, fits, check.code);
    }
    boundary(state, context);
    // fit 等待期间的末次复验钩子（detail 用它复验问题锚新鲜度；失败按原 reason 穿透）。
    also?.();
    return { value, sources };
  }
  async function refuse(
    state: MediaRunState,
    context: ActionContext,
    fits: FitCapture,
    code: string,
  ): Promise<Omit<ActionObservation, "id" | "name">> {
    const value = { status: "unavailable", code };
    boundary(state, context);
    const observation = (await fits())(value, [])
      ? { value, sources: [] }
      : { value: unavailableValue(), sources: [] };
    boundary(state, context);
    return observation;
  }

  async function invalidSelection(
    state: MediaRunState,
    context: ActionContext,
    fits: FitCapture,
  ): Promise<Omit<ActionObservation, "id" | "name">> {
    const value = { status: "unavailable", code: "CONTEXT_INVALID_SELECTION", recoverable: true };
    boundary(state, context);
    const observation = (await fits())(value, [])
      ? { value, sources: [] }
      : { value: unavailableValue(), sources: [] };
    boundary(state, context);
    return observation;
  }

  const list: BuiltInAction = {
    description: QQ_MEDIA_TOOL_DESCRIPTIONS["media.list"],
    release: releaseRun,
    execute: async (arguments_, context) => {
      context.signal.throwIfAborted();
      assertWired(context);
      const input = QQ_MEDIA_TOOL_SCHEMAS["media.list"].parse(arguments_);
      // 续页不建表：游标必须还活在本 run 的运行态里，跨 run 或伪造一律拒绝。
      const state = runState(context, input.cursor === undefined);
      const fits = captureFit(context, "media.list", arguments_);
      boundary(state, context);
      let cursor: ListCursor | null = null;
      if (input.cursor !== undefined) {
        const found = state.cursors.get(input.cursor);
        if (!found) return invalidSelection(state, context, fits);
        cursor = found;
      }
      // 范围/绑定复验：绑定改到别处或会话关闭后，列表不再披露任何行。
      const conversation = conversationRow();
      if (
        !conversation ||
        conversation.source_id !== binding.id ||
        conversation.agent_id !== binding.agentId
      )
        return refuse(state, context, fits, "conversation_changed");
      const current = readBindingByConversation(options.orm, identity);
      if (
        !current ||
        current.id !== binding.id ||
        current.agentId !== binding.agentId ||
        current.paused ||
        current.revision !== binding.revision
      )
        return refuse(state, context, fits, "binding_changed");
      const limit = input.limit ?? DEFAULT_LIST_LIMIT;
      const at = now();
      // 元数据只查行身份与位置；described/attempts 一律从 typed 任务现值得出，不查
      // 媒体行的 note 列。legacyAttempts 只在任务缺失时作"已消耗次数"的兜底展示——
      // legacy 任务缺失但旧计数 >0 时绝不显示重置。
      const rows = options.orm
        .select({
          id: schema.qqMediaNotes.id,
          eventKey: schema.qqMediaNotes.eventKey,
          segmentIndex: schema.qqMediaNotes.segmentIndex,
          legacyAttempts: schema.qqMediaNotes.attempts,
          occurredAtSeconds: schema.qqEvents.occurredAtSeconds,
        })
        .from(schema.qqMediaNotes)
        .innerJoin(schema.qqEvents, eq(schema.qqEvents.eventKey, schema.qqMediaNotes.eventKey))
        .innerJoin(
          schema.conversationEvents,
          and(
            eq(schema.conversationEvents.conversationId, options.conversationId),
            eq(schema.conversationEvents.kind, "inbound"),
            eq(
              schema.conversationEvents.eventKey,
              sql`${"onebot:"} || ${schema.qqMediaNotes.eventKey}`,
            ),
          ),
        )
        .where(
          and(
            eq(schema.qqEvents.accountId, binding.accountId),
            eq(schema.qqEvents.conversationKind, binding.kind),
            eq(schema.qqEvents.peerId, binding.peerId),
            eq(schema.qqEvents.agentId, binding.agentId),
            eq(schema.qqMediaNotes.segmentKind, "image"),
            gt(schema.qqMediaNotes.expiresAt, at),
            ...(cursor === null
              ? []
              : [
                  sql`(${schema.qqEvents.occurredAtSeconds} < ${cursor.occurredAtSeconds} OR (${schema.qqEvents.occurredAtSeconds} = ${cursor.occurredAtSeconds} AND (${schema.qqMediaNotes.eventKey} < ${cursor.eventKey} OR (${schema.qqMediaNotes.eventKey} = ${cursor.eventKey} AND ${schema.qqMediaNotes.segmentIndex} < ${cursor.segmentIndex}))))`,
                ]),
          ),
        )
        .orderBy(
          desc(schema.qqEvents.occurredAtSeconds),
          desc(schema.qqMediaNotes.eventKey),
          desc(schema.qqMediaNotes.segmentIndex),
        )
        .limit(limit + 1)
        .all();
      const page = rows.slice(0, limit).map((row) => ({
        ...row,
        index: row.segmentIndex,
        kind: "image" as const,
      }));
      if (page.length === 0) {
        const value: ListValue = { status: "ok", items: [], nextCursor: null };
        return settle(state, context, fits, value, []);
      }
      // 装不下就减半重试；fit 通过的候选还要过上限与行复验，游标只落在最后披露的一行上。
      let staleCode: string | null = null;
      for (let length = page.length; length >= 1; length = Math.floor(length / 2)) {
        const items: MediaListItem[] = page.slice(0, length).map((row) => {
          const task = baselineTask(row.id);
          // 跨 carrier 同内容：identity 账本里同一预算行的已服务结果也算 described，
          // 与 note.read/describe 同一判据（同一真源，绝不出现 list 说未描述而
          // note.read 拿得到正文）。只读元数据，绝不为渲染一个标记去下载字节。
          const carrierRow = mediaRowById(row.id);
          const carrierEvent = carrierRow === null ? null : eventRow(carrierRow.eventKey);
          const served =
            carrierRow === null || carrierEvent === null
              ? null
              : servableDescription({
                  row: carrierRow,
                  event: carrierEvent,
                  purpose: "baseline",
                  metadataOnly: true,
                  // 「不下载字节」不等于免检：described 标记同样走与正文交付同一条
                  // 授权闸（宿主边界纪元 + 当前 carrier 授权 + 两证据引用含 scope 与
                  // expiry + model/policy 身份）。下方 listedStillValid 是**列表自身的**
                  // 行复验，不替代这道闸。
                  assertCurrent: describeTaskGuard(carrierEvent),
                });
          return {
            id: row.id,
            eventKey: row.eventKey,
            index: row.index,
            kind: row.kind,
            described:
              (task !== null && describedForCurrentModelPolicy(task, row.kind)) || served !== null,
            // 任务在＝typed 真实计数；identity 账本命中＝同内容已花过的真实预算（不重置）；
            // 两者都没有＝旧账只作已消耗次数的兜底展示，绝不显示 0（那会伪装成"还能再来两次"）。
            attempts: task !== null ? task.attempts : (served?.attempts ?? row.legacyAttempts),
          };
        });
        const token = length < rows.length ? randomUUID() : null;
        const value: ListValue = { status: "ok", items, nextCursor: token };
        boundary(state, context);
        if (!(await fits())(value, [])) continue;
        boundary(state, context);
        const undisclosed = items.filter((item) => !state.disclosed.has(item.id)).length;
        if (state.disclosed.size + undisclosed > MAX_DISCLOSED) continue;
        if (token !== null && state.cursors.size >= MAX_CURSORS) continue;
        let stale: string | null = null;
        for (const item of items) {
          stale = listedStillValid(item);
          if (stale !== null) break;
        }
        if (stale !== null) {
          staleCode = stale;
          continue;
        }
        if (token !== null) {
          const last = page[length - 1];
          state.cursors.set(token, {
            occurredAtSeconds: last.occurredAtSeconds,
            eventKey: last.eventKey,
            segmentIndex: last.segmentIndex,
          });
        }
        for (const item of items) state.disclosed.add(item.id);
        return { value, sources: [] };
      }
      if (staleCode !== null) return refuse(state, context, fits, staleCode);
      boundary(state, context);
      return { value: unavailableValue(), sources: [] };
    },
  };

  /** Resolve a result only through the current carrier task or the guarded identity reader. */
  function servedDescription(input: {
    row: QqMediaNoteRow;
    event: typeof schema.qqEvents.$inferSelect;
    purpose: "baseline" | "detail";
    question: QqMediaQuestionAnchor | null;
    taskId?: string;
  }): QqServableMediaDescription | null {
    const task = findMediaReadTask(options.orm, {
      mediaNoteId: input.row.id,
      purpose: input.purpose,
      ...(input.question === null ? {} : { questionKey: input.question.questionKey }),
    });
    if (
      task !== null &&
      task.status === "succeeded" &&
      task.note !== null &&
      task.modelName !== null &&
      describedForCurrentModelPolicy(task, "image") &&
      (input.taskId === undefined || input.taskId === task.id)
    ) {
      const ref = readTaskRefOrNull(task.id, now());
      if (ref === null) return null;
      return {
        note: task.note,
        modelName: task.modelName,
        policy: task.policy,
        attempts: task.attempts,
        taskId: task.id,
        sources: [ref],
      };
    }
    return servableDescription({
      row: input.row,
      event: input.event,
      purpose: input.purpose,
      ...(input.question === null ? {} : { questionKey: input.question.questionKey }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      metadataOnly: false,
      assertCurrent: describeTaskGuard(input.event),
      ...(input.question === null
        ? {}
        : {
            question: {
              eventKey: input.question.eventKey,
              bodyRevision: input.question.bodyRevision,
              assertQuestionCurrent: input.question.assertQuestionCurrent,
            },
          }),
    });
  }

  /** Deliver a bounded page through the shared fitter and final source/question checks. */
  async function deliverDescriptionPage(input: {
    state: MediaRunState;
    context: ActionContext;
    fits: FitCapture;
    id: string;
    row: QqMediaNoteRow;
    event: typeof schema.qqEvents.$inferSelect;
    purpose: "baseline" | "detail";
    question: QqMediaQuestionAnchor | null;
    offset: number;
    limit: number;
    served: QqServableMediaDescription;
    resolveFresh: () => QqServableMediaDescription | null;
    wrap: (page: Extract<NoteReadValue, { status: "ok" }>) => unknown;
  }): Promise<Omit<ActionObservation, "id" | "name">> {
    const points = [...input.served.note];
    const snapshotAtRead = snapshot(input.row);
    const anchorStillCurrent = () => input.question?.assertQuestionCurrent(options.orm);
    if (input.offset > points.length) {
      boundary(input.state, input.context);
      const current = revalidated(snapshotAtRead);
      if (!current.ok) return refuse(input.state, input.context, input.fits, current.code);
      anchorStillCurrent();
      const fresh = input.resolveFresh();
      if (
        fresh === null ||
        fresh.taskId !== input.served.taskId ||
        fresh.note !== input.served.note ||
        fresh.modelName !== input.served.modelName
      )
        return refuse(input.state, input.context, input.fits, "segment_changed");
      return invalidSelection(input.state, input.context, input.fits);
    }
    const remaining = points.length - input.offset;
    for (
      let length = Math.max(1, Math.min(input.limit, remaining));
      length >= 1;
      length = Math.floor(length / 2)
    ) {
      const end = Math.min(input.offset + length, points.length);
      const page: Extract<NoteReadValue, { status: "ok" }> = {
        status: "ok",
        id: input.id,
        model: input.served.modelName,
        text: points.slice(input.offset, end).join(""),
        offset: input.offset,
        nextOffset: end < points.length ? end : null,
      };
      const value = input.wrap(page);
      boundary(input.state, input.context);
      if (!(await input.fits())(value, [...input.served.sources])) continue;
      boundary(input.state, input.context);
      const check = revalidated(snapshotAtRead);
      if (!check.ok) return refuse(input.state, input.context, input.fits, check.code);
      anchorStillCurrent();
      const fresh = input.resolveFresh();
      if (
        fresh === null ||
        fresh.taskId !== input.served.taskId ||
        fresh.note !== input.served.note ||
        fresh.modelName !== input.served.modelName
      )
        return refuse(input.state, input.context, input.fits, "segment_changed");
      boundary(input.state, input.context);
      return { value, sources: [...fresh.sources] };
    }
    return { value: unavailableValue(), sources: [] };
  }

  /** The single authorized description reader used for explicit paging and describe success. */
  async function readDescriptionPage(input: {
    state: MediaRunState;
    context: ActionContext;
    fits: FitCapture;
    id: string;
    row: QqMediaNoteRow;
    event: typeof schema.qqEvents.$inferSelect;
    purpose: "baseline" | "detail";
    question: QqMediaQuestionAnchor | null;
    offset: number;
    limit: number;
    wrap: (page: Extract<NoteReadValue, { status: "ok" }>) => unknown;
  }): Promise<Omit<ActionObservation, "id" | "name">> {
    const task = findMediaReadTask(options.orm, {
      mediaNoteId: input.id,
      purpose: input.purpose,
      ...(input.question === null ? {} : { questionKey: input.question.questionKey }),
    });
    if (
      task?.status === "succeeded" &&
      task.note !== null &&
      (task.modelName === null || !describedForCurrentModelPolicy(task, "image"))
    )
      return refuse(input.state, input.context, input.fits, "cache_mismatch");
    const resolveFresh = () => servedDescription(input);
    const served = resolveFresh();
    if (served !== null) return deliverDescriptionPage({ ...input, served, resolveFresh });
    // 已成功的 typed 任务在上面的 cache_mismatch 之后必然模型与当前策略相符，唯一落空
    // 只剩结果引用签不出（来源到期/被删/时间线漂移）——那是来源失效，不是否定描述：
    // 按 segment_changed 拒绝，与结果引用现签现用同一条规则，不冒充"从未描述"。
    if (task?.status === "succeeded" && task.note !== null)
      return refuse(input.state, input.context, input.fits, "segment_changed");
    const anchorStillCurrent = () => input.question?.assertQuestionCurrent(options.orm);
    return settle(
      input.state,
      input.context,
      input.fits,
      {
        status: "undescribed",
        id: input.id,
        attempts: task?.attempts ?? (input.purpose === "detail" ? 0 : input.row.attempts),
      },
      [],
      snapshot(input.row),
      anchorStillCurrent,
    );
  }

  /** Same reader and result fitter as note.read, with describe's existing status fields. */
  async function describeWithPage(input: {
    state: MediaRunState;
    context: ActionContext;
    fits: FitCapture;
    id: string;
    row: QqMediaNoteRow;
    event: typeof schema.qqEvents.$inferSelect;
    purpose: "baseline" | "detail";
    question: QqMediaQuestionAnchor | null;
    attempt: number;
    taskId: string;
  }): Promise<Omit<ActionObservation, "id" | "name">> {
    const resolveFresh = () => servedDescription(input);
    const served = resolveFresh();
    if (served === null || served.taskId !== input.taskId)
      return refuse(input.state, input.context, input.fits, "segment_changed");
    return deliverDescriptionPage({
      ...input,
      offset: 0,
      limit: DEFAULT_READ_LIMIT,
      served,
      resolveFresh,
      wrap: (page) => ({
        ...page,
        status: "described",
        described: true,
        attempt: input.attempt,
      }),
    });
  }

  const noteRead: BuiltInAction = {
    description: QQ_MEDIA_TOOL_DESCRIPTIONS["media.note.read"],
    release: releaseRun,
    execute: async (arguments_, context) => {
      context.signal.throwIfAborted();
      assertWired(context);
      const input = QQ_MEDIA_TOOL_SCHEMAS["media.note.read"].parse(arguments_);
      const state = runState(context, false);
      const fits = captureFit(context, "media.note.read", arguments_);
      boundary(state, context);
      if (!state.disclosed.has(input.id)) return invalidSelection(state, context, fits);
      const row = mediaRowById(input.id);
      if (!row) return refuse(state, context, fits, "segment_missing");
      const event = eventRow(row.eventKey);
      if (!event) return refuse(state, context, fits, "segment_missing");
      const scope = scopeFor(row, event);
      if (!scope.ok) return refuse(state, context, fits, scope.code);
      const question =
        input.questionMessageId === undefined
          ? undefined
          : resolveQuestionAnchor({ row, questionMessageId: input.questionMessageId });
      if (question === null) return invalidSelection(state, context, fits);
      return readDescriptionPage({
        state,
        context,
        fits,
        id: input.id,
        row,
        event,
        purpose: question === undefined ? "baseline" : "detail",
        question: question ?? null,
        offset: input.offset ?? 0,
        limit: input.limit ?? DEFAULT_READ_LIMIT,
        wrap: (page) => page,
      });
    },
  };

  const describe: BuiltInAction = {
    description: QQ_MEDIA_TOOL_DESCRIPTIONS["media.describe"],
    // 有副作用的工具不进沙箱绑定目录；串行执行，绝不与只读批并行。
    sandboxCallable: false,
    release: releaseRun,
    execute: async (arguments_, context) => {
      context.signal.throwIfAborted();
      assertWired(context);
      const input = QQ_MEDIA_TOOL_SCHEMAS["media.describe"].parse(arguments_);
      const state = runState(context, false);
      const fits = captureFit(context, "media.describe", arguments_);
      boundary(state, context);
      if (!state.disclosed.has(input.id)) return invalidSelection(state, context, fits);
      const row = mediaRowById(input.id);
      if (!row) return refuse(state, context, fits, "segment_missing");
      const event = eventRow(row.eventKey);
      if (!event) return refuse(state, context, fits, "segment_missing");
      const scope = scopeFor(row, event);
      if (!scope.ok) return refuse(state, context, fits, scope.code);
      if (row.segmentKind !== "image") return refuse(state, context, fits, "unsupported_kind");
      // 结果缓存的键只能是已披露 id（≤ MAX_DISCLOSED），这里只是防御性复检。
      if (!state.outcomes.has(input.id) && state.outcomes.size >= MAX_DISCLOSED)
        return { value: unavailableValue(), sources: [] };

      /**
       * 缓存命中的统一出口：走已验的 `readQqMediaTaskOnce` 权威 cache 路径——复用
       * 它的 model/policy 匹配、legacy 已验规则、fit 期间任务/来源漂移的末次复验与
       * 真实 typed 来源签发，绝不复述本 run 里可能已失效的 prior memo。
       */
      const cachePath = async (
        attemptValue: (attempt: number) => DescribeStatus,
        purpose: "baseline" | "detail" = "baseline",
        question?: QqMediaQuestionAnchor,
      ): Promise<{
        value: DescribeValue;
        sources: SourceRef[];
        taskId: string | null;
        attempt: number;
      }> => {
        // 本 carrier 上的那一行：baseline 与 detail 是两条独立预算行，键必须跟着
        // 本次读取的 purpose 走，绝不拿 baseline 行冒充 detail 结果。
        const carrierRow = (): ReturnType<typeof findMediaReadTask> =>
          findMediaReadTask(options.orm, {
            mediaNoteId: input.id,
            purpose,
            ...(purpose === "detail" ? { questionKey: question?.questionKey ?? "" } : {}),
          });
        const readInput: QqMediaTaskReadInput = {
          eventKey: row.eventKey,
          segmentIndex: row.segmentIndex,
          policy: policyBaseline,
          modelConfig: options.modelConfig,
          addressedToAssistant: true,
          // 缓存/legacy 分支与新读分支共用同一把宿主时钟：命中判定与打点不再跨刻度。
          now,
          assertCurrent: describeTaskGuard(event),
          owner: ownerOf(context),
          ...(purpose === "detail" && question !== undefined
            ? {
                purpose: "detail" as const,
                questionKey: question.questionKey,
                assertQuestionCurrent: question.assertQuestionCurrent,
              }
            : { purpose: "baseline" as const }),
        };
        const result = await readQqMediaTaskOnce(
          options.orm,
          options.adapter,
          readInput,
          context.signal,
        );
        if (result.kind === "described") {
          if (result.source === "task") {
            // 本 carrier 刚花出的预算：结果引用锁在本 carrier 的任务行上。
            const task = carrierRow();
            if (!task || task.id !== result.taskId)
              return {
                value: { status: "unavailable", code: "segment_changed" },
                sources: [],
                taskId: null,
                attempt: 0,
              };
            const ref = readTaskRefOrNull(task.id, now());
            if (ref === null)
              return {
                value: { status: "unavailable", code: "segment_changed" },
                sources: [],
                taskId: null,
                attempt: 0,
              };
            return {
              value: attemptValue(result.attempt),
              sources: [ref],
              taskId: task.id,
              attempt: result.attempt,
            };
          }
          // cache/legacy：权威 reader 已在自己的边界里复验过模型、策略、身份与窗口。
          // 结果引用锁在那一行自己的 carrier 上，所以先问「这一行的 carrier 是不是本
          // carrier」：是则签本 carrier 的任务引用（既有语义逐字不变）；不是则那条任务
          // 引用属于旧 carrier，绝不签，改由受控消费按「identity 结果 ref + 本 carrier
          // 媒体 ref」两证据签发——缺一即不交。
          // 判据是「那一行自己的 carrier 是不是本 carrier」，不是 reader 回显的
          // mediaNoteId（缓存命中时它回显本次读取的行）。本 carrier 拥有这一行 ⇒ 签它
          // 自己的任务引用（既有语义逐字不变）；否则那一行属于旧 carrier，绝不签。
          const own = carrierRow();
          if (own !== null && own.id === result.taskId) {
            const ref = readTaskRefOrNull(own.id, now());
            if (ref === null)
              return {
                value: { status: "unavailable", code: "segment_changed" },
                sources: [],
                taskId: null,
                attempt: 0,
              };
            return {
              value: attemptValue(result.attempt),
              sources: [ref],
              taskId: own.id,
              attempt: result.attempt,
            };
          }
          const served = servableDescription({
            row,
            event,
            purpose,
            taskId: result.taskId,
            metadataOnly: false,
            assertCurrent: describeTaskGuard(event),
            ...(purpose === "detail" && question !== undefined
              ? {
                  question: {
                    eventKey: question.eventKey,
                    bodyRevision: question.bodyRevision,
                    assertQuestionCurrent: question.assertQuestionCurrent,
                  },
                }
              : {}),
          });
          if (served === null || served.taskId !== result.taskId)
            return {
              value: { status: "unavailable", code: "segment_changed" },
              sources: [],
              taskId: null,
              attempt: 0,
            };
          // 同 A 分支：复用成功按同规则通知（幂等结清诊断 + 宿主视图失效），报主账本行。
          return {
            value: attemptValue(result.attempt),
            sources: [...served.sources],
            taskId: served.taskId,
            attempt: result.attempt,
          };
        }
        if (result.kind === "failed")
          return {
            value: attemptValue(result.attempt),
            sources: [],
            taskId: null,
            attempt: result.attempt,
          };
        return {
          value: { status: "unavailable", code: result.reason },
          sources: [],
          taskId: null,
          attempt: 0,
        };
      };

      /**
       * 明确细问（本轮问题消息真的在问这张图的细节）：走 detail 读取。问题身份由宿主
       * 从真实原文冻结（模型只给指针），detail 与 baseline 是两条独立预算，永不合流；
       * 锚在 claim 事务里复验，动了就按原 authority 失败抛出，不吞成 unavailable。
       */
      if (input.questionMessageId !== undefined) {
        const question = resolveQuestionAnchor({ row, questionMessageId: input.questionMessageId });
        if (question === null) return invalidSelection(state, context, fits);
        const existing = findMediaReadTask(options.orm, {
          mediaNoteId: row.id,
          purpose: "detail",
          questionKey: question.questionKey,
        });
        if (existing !== null && existing.status === "succeeded") {
          const outcome = await cachePath(
            (attempt) => ({ status: "described", described: true, attempt }),
            "detail",
            question,
          );
          if (outcome.taskId === null)
            return settle(state, context, fits, outcome.value, outcome.sources, snapshot(row));
          state.outcomes.set(input.id, { value: outcome.value, sources: [...outcome.sources] });
          options.onDescribed?.(row.eventKey, outcome.taskId);
          const delivered = await describeWithPage({
            state,
            context,
            fits,
            id: input.id,
            row,
            event,
            purpose: "detail",
            question,
            attempt: outcome.attempt,
            taskId: outcome.taskId,
          });
          return delivered;
        }
        // 结果信封上界都装不下时不认领尝试、不调模型、不写缓存。
        boundary(state, context);
        if (
          !(await fits())(
            { status: "failed", described: false, attempt: 2, awaitSupplement: false },
            [],
          )
        )
          return { value: unavailableValue(), sources: [] };
        boundary(state, context);
        // 第二次尝试的补充证明（detail 与 baseline 同规则、同基准来源）：回调在 claim
        // 事务里被调用，此刻现读**本 detail 任务**（purpose=detail + 本 questionKey）
        // 的真实现值——不是 baseline 行，也不是创建时的快照。基准取该行 claim CAS
        // 打点的 lastAttemptAt（result/fail 不回写它）；缺失/不可解析 fail closed。
        const proveDetailSupplementLaterThan = (): boolean => {
          const current = budgetRowForSupplement({
            row,
            event,
            purpose: "detail",
            questionKey: question.questionKey,
          });
          if (current === null) return false;
          if (current.status !== "failed" || current.attempts < 1) return false;
          const stamp = current.lastAttemptAt;
          if (stamp === null) return false;
          const benchmarkMs = Date.parse(stamp);
          if (!Number.isFinite(benchmarkMs)) return false;
          return freshSupplementLaterThan(row, event, benchmarkMs);
        };
        const detail = await readQqMediaTaskOnce(
          options.orm,
          options.adapter,
          {
            eventKey: row.eventKey,
            segmentIndex: row.segmentIndex,
            purpose: "detail",
            questionKey: question.questionKey,
            assertQuestionCurrent: question.assertQuestionCurrent,
            policy: policyBaseline,
            modelConfig: options.modelConfig,
            addressedToAssistant: true,
            proveSupplementLaterThan: proveDetailSupplementLaterThan,
            now,
            assertCurrent: describeTaskGuard(event),
            owner: ownerOf(context),
          },
          context.signal,
        );
        boundary(state, context);
        if (detail.kind === "described") {
          const taskId = detail.taskId;
          options.onDescribed?.(row.eventKey, taskId);
          return describeWithPage({
            state,
            context,
            fits,
            id: input.id,
            row,
            event,
            purpose: "detail",
            question,
            attempt: detail.attempt,
            taskId,
          });
        }
        if (detail.kind === "failed") {
          const value: DescribeValue = {
            status: "failed",
            described: false,
            attempt: detail.attempt,
            awaitSupplement: detail.awaitSupplement,
          };
          return settle(state, context, fits, value, [], snapshot(row));
        }
        return refuse(state, context, fits, detail.reason);
      }

      // 同 run 重复 describe 不烧第二次：复走权威 cache 路径（prior memo 只挡"再花一次"
      // 的入口，不给正文/结论本身）。
      const prior = state.outcomes.get(input.id);
      if (prior) {
        const fresh = baselineTask(input.id);
        if (!fresh) return refuse(state, context, fits, "segment_missing");
        if (fresh.status === "succeeded") {
          const outcome = await cachePath((attempt) => ({
            status: "described",
            described: true,
            attempt,
          }));
          if (outcome.taskId === null)
            return settle(state, context, fits, outcome.value, outcome.sources, snapshot(row));
          options.onDescribed?.(row.eventKey, outcome.taskId);
          const delivered = await describeWithPage({
            state,
            context,
            fits,
            id: input.id,
            row,
            event,
            purpose: "baseline",
            question: null,
            attempt: outcome.attempt,
            taskId: outcome.taskId,
          });
          return delivered;
        }
        return settle(state, context, fits, prior.value, [], snapshot(row));
      }

      // 已有成功的 typed baseline（含 0052 legacy 迁移任务）：走权威 cache 路径直接读，
      // 不花预算也不烧尝试。
      const existing = baselineTask(input.id);
      if (existing && existing.status === "succeeded") {
        const outcome = await cachePath((attempt) => ({
          status: "described",
          described: true,
          attempt,
        }));
        if (outcome.taskId === null)
          return settle(state, context, fits, outcome.value, outcome.sources, snapshot(row));
        state.outcomes.set(input.id, { value: outcome.value, sources: [...outcome.sources] });
        options.onDescribed?.(row.eventKey, outcome.taskId);
        const result = await describeWithPage({
          state,
          context,
          fits,
          id: input.id,
          row,
          event,
          purpose: "baseline",
          question: null,
          attempt: outcome.attempt,
          taskId: outcome.taskId,
        });
        return result;
      }

      // 先花预算、后花视觉：结果信封上界都装不下时不认领尝试、不调模型、不写缓存、不发宿主通知。
      // attempt 用上限而非预测值——不提前声明这次会是第几次尝试。
      const resultFloor: DescribeValue = {
        status: "failed",
        described: false,
        attempt: 2,
        awaitSupplement: false,
      };
      boundary(state, context);
      if (!(await fits())(resultFloor, [])) return { value: unavailableValue(), sources: [] };

      // 授权事实全部从宿主事实得出：原图被叫到（journal addressing），第二次尝试的补充
      // 证据闭包在 claim 事务里同步重查真实 journal（基准＝typed 任务的真实现值时刻）。
      const addressedByMessage = scope.reasons.some(
        (reason) =>
          reason === "mention" ||
          reason === "reply_to_agent" ||
          reason === "private" ||
          reason === "legacy_addressed",
      );
      const guard = describeTaskGuard(event);
      // 第二次尝试的补充证明：回调在 claim 事务里执行，此刻现读同一任务的真实"最近一次
      // 已消耗尝试"时刻（lastAttemptAt，claim CAS 打点）与 state，再扫宿主 journal。
      // 基准绝不取 recordedAt/内存快照——创建与第二次 claim 之间的漂移不得用旧基准
      // 授权；lastAttemptAt 为 NULL/NaN 的已消耗任务 fail closed，不解锁。
      // 构造不以原图 addressing 为前提：原图未被 @ 的第一次尝试仍走既有主动读（无已
      // 消耗任务时闭包恒为 false），但更晚的真实 @/私聊补充事实同样解锁第二次尝试。
      const proveSupplementLaterThan = (): boolean => {
        const current = budgetRowForSupplement({ row, event, purpose: "baseline" });
        if (current === null) return false;
        if (current.status !== "failed" || current.attempts < 1) return false;
        const stamp = current.lastAttemptAt;
        if (stamp === null) return false;
        const benchmarkMs = Date.parse(stamp);
        if (!Number.isFinite(benchmarkMs)) return false;
        return freshSupplementLaterThan(row, event, benchmarkMs);
      };
      const addressedToAssistant = addressedByMessage || proveSupplementLaterThan();
      boundary(state, context);
      const result = await readQqMediaTaskOnce(
        options.orm,
        options.adapter,
        {
          eventKey: row.eventKey,
          segmentIndex: row.segmentIndex,
          purpose: "baseline",
          policy: policyBaseline,
          modelConfig: options.modelConfig,
          addressedToAssistant,
          ...(addressedToAssistant ? { proveSupplementLaterThan } : {}),
          now,
          assertCurrent: guard,
          owner: ownerOf(context),
        },
        context.signal,
      );
      boundary(state, context);
      let snap: RowSnapshot | null = snapshot(row);
      if (result.kind === "described") {
        const value: DescribeStatus = {
          status: "described",
          described: true,
          attempt: result.attempt,
        };
        const taskId = result.taskId;
        state.outcomes.set(input.id, { value, sources: [] });
        options.onDescribed?.(row.eventKey, taskId);
        const delivered = await describeWithPage({
          state,
          context,
          fits,
          id: input.id,
          row,
          event,
          purpose: "baseline",
          question: null,
          attempt: result.attempt,
          taskId,
        });
        return delivered;
      } else if (result.kind === "failed") {
        const value: DescribeStatus = {
          status: "failed",
          described: false,
          attempt: result.attempt,
          awaitSupplement: result.awaitSupplement,
        };
        const task = baselineTask(input.id);
        if (task) options.onDescribed?.(row.eventKey, task.id);
        const outcome: DescribeOutcome = { value, sources: [] };
        state.outcomes.set(input.id, outcome);
        return settle(state, context, fits, value, [], snap);
      }
      const value: DescribeStatus = { status: "unavailable", code: result.reason };
      snap = null;
      const outcome: DescribeOutcome = { value, sources: [] };
      state.outcomes.set(input.id, outcome);
      return settle(state, context, fits, value, [], snap);
    },
  };

  /** media.read 的结果投影：宿主服务的图片元数据 → 严格信封，绝无 bytes/base64/取流引用。 */
  const readImage = options.readImage;
  const read: BuiltInAction | null = readImage
    ? {
        description: QQ_MEDIA_TOOL_DESCRIPTIONS["media.read"],
        release: releaseRun,
        execute: async (arguments_, context) => {
          context.signal.throwIfAborted();
          assertWired(context);
          const input = QQ_MEDIA_TOOL_SCHEMAS["media.read"].parse(arguments_);
          const state = runState(context, false);
          const fits = captureFit(context, "media.read", arguments_);
          boundary(state, context);
          if (!state.disclosed.has(input.id)) return invalidSelection(state, context, fits);
          const row = mediaRowById(input.id);
          if (!row) return refuse(state, context, fits, "segment_missing");
          const event = eventRow(row.eventKey);
          if (!event) return refuse(state, context, fits, "segment_missing");
          const scope = scopeFor(row, event);
          if (!scope.ok) return refuse(state, context, fits, scope.code);
          if (row.segmentKind !== "image") return refuse(state, context, fits, "unsupported_kind");
          // 带问题指针＝按本轮真实问题的细节准备这张图（宿主锚已复验）；不带＝首次读取，
          // 入参形状与既有行为逐字相同。
          const question =
            input.questionMessageId === undefined
              ? undefined
              : resolveQuestionAnchor({ row, questionMessageId: input.questionMessageId });
          if (question === null) return invalidSelection(state, context, fits);
          let prepared: Awaited<ReturnType<QqMediaReadImageService>>;
          try {
            prepared = await readImage({
              mediaNoteId: row.id,
              eventKey: row.eventKey,
              sourceRef: row.sourceRef,
              signal: context.signal,
              ...(question === undefined
                ? {}
                : {
                    purpose: "detail" as const,
                    questionKey: question.questionKey,
                    question: {
                      eventKey: question.eventKey,
                      source: question.source,
                      assertQuestionCurrent: question.assertQuestionCurrent,
                    },
                  }),
            });
          } catch (error) {
            // 权限/来源失效必须穿透（fail loudly）；普通失败只回安全 code，不泄露源 URL。
            if (isAppError(error)) throw error;
            if (error instanceof MediaReadTaskRejectedError && error.authority) throw error;
            return refuse(state, context, fits, "image_unavailable");
          }
          boundary(state, context);
          const value: MediaReadValue = {
            status: "ok",
            mediaId: row.id,
            category: prepared.category,
            images: prepared.images.map((image) => ({
              sourceId: image.source.id,
              revision: image.source.revision,
              mimeType: image.mimeType,
              sha256: image.sha256,
              width: image.width,
              height: image.height,
              frameIndex: image.frameIndex,
            })),
          };
          return settle(
            state,
            context,
            fits,
            value,
            prepared.images.map((image) => image.source),
          );
        },
      }
    : null;

  // 建立时先验一次接线：会话必须是这条绑定在用的那一间，否则这些工具都不该存在。
  const opening = conversationRow();
  if (!opening || opening.source_id !== binding.id || opening.agent_id !== binding.agentId)
    fail("CONTEXT_SOURCE_INVALID", "媒体工具与会话接线不一致");

  return [list, noteRead, describe, ...(read ? [read] : [])];
}
