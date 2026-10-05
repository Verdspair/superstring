// P4: a single, explicitly requested media read. The adapter is injected: this module
// neither opens a network connection nor treats a text-only conversation model as vision.
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import { readBindingByConversation } from "../db/qq-binding-repository";
import {
  linkMediaAssetSource,
  mediaAssetForMediaNote,
  recordMediaAsset,
} from "../db/qq-media-asset-repository";
import {
  mediaNoteRow,
  recordMediaAttempt,
  recordMediaNote,
  reusableMediaNote,
} from "../db/qq-media-repository";
import {
  associateLegacyMediaReadTask,
  attemptMediaReadTask,
  failMediaReadTask,
  findMediaReadTask,
  findMediaReadTaskByIdentity,
  MediaReadTaskRejectedError,
  type MediaTaskSourceGuard,
  type QqMediaReadPurpose,
  recordMediaReadTaskResult,
  type SupplementEvidence,
} from "../db/qq-media-task-repository";
import { readQqSettings } from "../db/qq-settings-repository";
import { DEFAULT_USER_ID, getAgentRow, nowIso, type Orm } from "../db/repositories";
import {
  conversations,
  qqMediaReadTasks as mediaReadTasks,
  qqBindings,
  qqEvents,
} from "../db/schema";
import { AppError, fail } from "../errors";
import { QQ_STICKER_CONTENT_TYPES, type QqImageHeader, readQqImageHeader } from "./qq-image-header";
import { checkQqMediaRetry, qqMediaFailureOutcome, qqMediaModelFor } from "./qq-media-contract";

// Prevent two reads of the same segment in one process from overlapping. The database
// CAS below remains necessary for other processes; this is not a persistent lease.
const activeReads = new WeakMap<Orm, Set<string>>();

const Input = z.strictObject({
  eventKey: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  addressedToAssistant: z.boolean(),
  relatedSupplementArrived: z.boolean(),
  modelConfig: z.strictObject({
    visionModelName: z.string().nullable(),
    transcriptionModelName: z.string().nullable(),
  }),
});

/**
 * 适配器**声明**自己能读哪些种类（0.4.0 P5）：语音与视频在这一版没有转写协议、也没有解码器，
 * 与其让每次被叫到都去"试一次然后失败"，不如让实现方把能力说清楚——阅读器在花钱之前就据此
 * 判"不可用"，不消耗尝试次数、也不产生失败叶子。未来的转写实现只需把 `record` 加进这份声明。
 */
export interface QqMediaReadAdapter {
  readonly capabilities: readonly ("image" | "record" | "video")[];
  /**
   * Controlled bytes for the identity derivation, when no live asset cache can
   * answer for the row: the SAME controlled source chain the adapter's own read
   * uses (no second download path). Optional — a host without bytes refuses the
   * read with `identity_unavailable` instead of silently falling back to
   * row-level identity (which would let the same picture regain budget on a new
   * URL, §8.1).
   */
  fetchBytes?(input: {
    readonly kind: "image" | "record" | "video";
    readonly sourceRef: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly bytes: Uint8Array }>;
  read(input: {
    kind: "image" | "record" | "video";
    sourceRef: string;
    model: string;
    source?: SourceRef;
    owner?: { kind: string; id: string; userId?: string; agentId?: string };
    signal?: AbortSignal;
    /** The bytes already fetched for the identity derivation — reuse, never re-fetch. */
    bytes?: Uint8Array;
  }): Promise<string>;
}

export type QqMediaReadResult =
  /** `attempt: 0` ＝ 复用了同会话里同一引用的已有描述，这一行没有花过读取尝试。 */
  | { readonly kind: "described"; readonly attempt: number }
  | { readonly kind: "unreadable"; readonly reason: string }
  | {
      readonly kind: "failed";
      readonly attempt: number;
      readonly announceInConversation: false;
      readonly awaitSupplement: boolean;
    };

/** One attempt; never replays a read or announces a failure to the conversation. */
export async function readQqMediaOnce(
  orm: Orm,
  adapter: QqMediaReadAdapter,
  input: unknown,
  signal?: AbortSignal,
): Promise<QqMediaReadResult> {
  signal?.throwIfAborted();
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ media read input");
  const value = parsed.data;
  const row = mediaNoteRow(orm, value.eventKey, value.segmentIndex);
  if (!row) return { kind: "unreadable", reason: "segment_missing" };
  const activeKey = JSON.stringify([value.eventKey, value.segmentIndex]);
  const active = activeReads.get(orm) ?? new Set<string>();
  if (active.has(activeKey)) return { kind: "unreadable", reason: "read_in_progress" };
  const event = orm.select().from(qqEvents).where(eq(qqEvents.eventKey, value.eventKey)).get();
  if (!event) return { kind: "unreadable", reason: "event_missing" };
  const bindingIdentity = {
    accountId: event.accountId,
    kind: event.conversationKind as "group" | "private",
    peerId: event.peerId,
  };
  const startSettings = readQqSettings(orm);
  const startBinding = readBindingByConversation(orm, bindingIdentity);
  if (
    startSettings.enabled !== 1 ||
    startSettings.accountId !== event.accountId ||
    !startBinding ||
    startBinding.paused ||
    startBinding.agentId !== event.agentId ||
    getAgentRow(orm, event.agentId)?.isActive !== 1
  )
    return { kind: "unreadable", reason: "binding_inactive" };
  const authorized = (db: Orm = orm) => {
    const settings = readQqSettings(db);
    const binding = readBindingByConversation(db, bindingIdentity);
    return (
      settings.enabled === 1 &&
      settings.accountId === event.accountId &&
      settings.revision === startSettings.revision &&
      binding !== null &&
      !binding.paused &&
      binding.agentId === event.agentId &&
      binding.revision === startBinding.revision &&
      getAgentRow(db, event.agentId)?.isActive === 1
    );
  };
  if (row.note !== null) return { kind: "unreadable", reason: "already_described" };
  if (row.expiresAt <= new Date().toISOString())
    return { kind: "unreadable", reason: "segment_expired" };
  if (row.segmentKind !== "image" && row.segmentKind !== "record" && row.segmentKind !== "video")
    return { kind: "unreadable", reason: "unsupported_kind" };
  const kind = row.segmentKind;
  // 能力先于配置：声明读不了的种类，配了模型也不试（不记尝试、不产生失败）。
  if (!adapter.capabilities.includes(kind))
    return { kind: "unreadable", reason: "capability_unavailable" };
  // 复用先于花钱：同一会话里同一张图已经读过，就照抄那份描述（不消耗尝试、不调模型）。
  // 复用严格同 agent：改绑之后旧助手的描述不得漂移到新助手名下（note_model 的归属是原读法的）。
  const reused = reusableMediaNote(orm, {
    accountId: event.accountId,
    conversationKind: event.conversationKind as "group" | "private",
    peerId: event.peerId,
    agentId: event.agentId,
    kind,
    sourceRef: row.sourceRef,
    at: new Date().toISOString(),
  });
  if (reused) {
    // 取消在写入之前生效：取消不是"重试结论"，不能借复用的手把缓存补上。
    signal?.throwIfAborted();
    try {
      recordMediaNote(orm, {
        eventKey: value.eventKey,
        segmentIndex: value.segmentIndex,
        note: reused.note,
        noteModel: reused.noteModel,
        validateBeforeWrite: authorized,
      });
    } catch {
      return { kind: "unreadable", reason: "segment_changed" };
    }
    return { kind: "described", attempt: 0 };
  }
  const choice = qqMediaModelFor(kind, value.modelConfig);
  if (choice.kind !== "configured") return { kind: "unreadable", reason: "model_not_configured" };
  const retry = checkQqMediaRetry({
    kind: row.segmentKind,
    attempts: row.attempts,
    addressedToAssistant: value.addressedToAssistant,
    relatedSupplementArrived: value.relatedSupplementArrived,
  });
  if (retry.kind !== "allowed") return { kind: "unreadable", reason: retry.reason };
  // 取消在认领尝试之前生效：一次被取消的调用不该烧掉这张图的读取次数。
  signal?.throwIfAborted();
  // The SQL update claims a unique attempt number even when two consumers race.
  let claimed: typeof row;
  try {
    claimed = recordMediaAttempt(orm, {
      eventKey: value.eventKey,
      segmentIndex: value.segmentIndex,
      expectedAttempts: row.attempts,
      validateBeforeClaim: authorized,
    });
  } catch {
    // A competing first read or authorization change is not proof that both attempts
    // were spent. Preserve the previously visible exhausted result only if it is true.
    const current = mediaNoteRow(orm, value.eventKey, value.segmentIndex);
    return {
      kind: "unreadable",
      reason: current && current.attempts >= 2 ? "attempts_exhausted" : "claim_changed",
    };
  }
  active.add(activeKey);
  activeReads.set(orm, active);
  try {
    const generated = await adapter.read({
      kind,
      sourceRef: row.sourceRef,
      model: choice.model,
      signal,
      owner: { kind: "qq_media", id: row.id, userId: DEFAULT_USER_ID, agentId: event.agentId },
      source: {
        kind: "qq_media",
        id: row.id,
        revision: String(claimed.attempts),
        expiresAt: row.expiresAt,
      },
    });
    // 取消在写回之前生效：模型已经给出描述也不能救回一个被取消的调用。
    signal?.throwIfAborted();
    if (typeof generated !== "string") throw new Error("invalid media description");
    const note = generated.trim();
    if (!note) throw new Error("empty media description");
    // A sweep or reset during the external read cannot resurrect an expired segment.
    const current = mediaNoteRow(orm, value.eventKey, value.segmentIndex);
    if (
      !current ||
      current.id !== row.id ||
      current.attempts !== claimed.attempts ||
      current.note !== null ||
      current.expiresAt <= new Date().toISOString() ||
      !authorized()
    ) {
      return { kind: "unreadable", reason: "segment_changed" };
    }
    try {
      recordMediaNote(orm, {
        eventKey: value.eventKey,
        segmentIndex: value.segmentIndex,
        note,
        noteModel: choice.model,
        expectedAttempts: claimed.attempts,
        validateBeforeWrite: authorized,
      });
    } catch {
      return { kind: "unreadable", reason: "segment_changed" };
    }
    return { kind: "described", attempt: claimed.attempts };
  } catch {
    // 取消不是失败：先让取消穿透，绝不把它吞成 failed 之后再把描述/状态写进缓存。
    signal?.throwIfAborted();
    // A transport/model failure after pause, account switch, or source expiry is not
    // permission to keep a waiting task alive for a later supplement.
    const current = mediaNoteRow(orm, value.eventKey, value.segmentIndex);
    if (
      !current ||
      current.id !== row.id ||
      current.attempts !== claimed.attempts ||
      current.note !== null ||
      current.expiresAt <= new Date().toISOString() ||
      !authorized()
    ) {
      return { kind: "unreadable", reason: "segment_changed" };
    }
    const failure = qqMediaFailureOutcome({
      kind: row.segmentKind,
      attempts: claimed.attempts,
      addressedToAssistant: value.addressedToAssistant,
    });
    return {
      kind: "failed",
      attempt: claimed.attempts,
      announceInConversation: false,
      awaitSupplement: failure.awaitSupplement,
    };
  } finally {
    active.delete(activeKey);
  }
}

// ---------------------------------------------------------------------------
// Typed media read task reader (T08 Step4/5; spec §8.1/§12).
// ---------------------------------------------------------------------------

/** A baseline read: no question, no question anchor guard. */
export interface QqMediaTaskReadBaselineInput {
  readonly purpose: "baseline";
}

/** A detail read: the host anchors the real original question through `assertQuestionCurrent`. */
export interface QqMediaTaskReadDetailInput {
  readonly purpose: "detail";
  readonly questionKey: string;
  readonly assertQuestionCurrent: MediaTaskSourceGuard;
}

export type QqMediaTaskReadPurposeInput = QqMediaTaskReadBaselineInput | QqMediaTaskReadDetailInput;

export type QqMediaTaskReadResult =
  | {
      readonly kind: "described";
      readonly purpose: QqMediaReadPurpose;
      readonly source: "cache" | "task" | "legacy";
      readonly taskId: string;
      /** The content-identity key of the ledger row that answered this read. */
      readonly identityKey: string | null;
      /** The CURRENT carrier the ledger row is re-pointed to after this read. */
      readonly mediaNoteId: string;
      /** The controlled bytes' sha256 that derived the identity (host-provided or fetched). */
      readonly contentSha256: string;
      readonly note: string;
      readonly model: string;
      readonly attempt: number;
    }
  | { readonly kind: "unreadable"; readonly reason: string }
  | {
      readonly kind: "failed";
      readonly purpose: QqMediaReadPurpose;
      readonly attempt: number;
      readonly announceInConversation: false;
      readonly awaitSupplement: boolean;
    };

/** Typed input: everything is host-supplied, nothing is model-choosable. */
export type QqMediaTaskReadInput = QqMediaTaskReadPurposeInput & {
  readonly eventKey: string;
  readonly segmentIndex: number;
  readonly policy: string;
  readonly modelConfig: {
    readonly visionModelName: string | null;
    readonly transcriptionModelName: string | null;
  };
  readonly addressedToAssistant: boolean;
  /**
   * The controlled bytes' sha256 when the host already knows it (live asset or
   * an earlier controlled fetch). Omitted = the reader resolves it through the
   * adapter's fetchBytes; neither available = `identity_unavailable` (never a
   * silent row-level fallback, §8.1).
   */
  readonly contentSha256?: string;
  readonly relatedSupplementArrived?: boolean;
  readonly proveSupplementLaterThan?: SupplementEvidence;
  /**
   * 宿主时钟（nowIso 形状）；省略＝真实时钟。任务读取路径的过期判断、资产/来源链打点、
   * claim 与结果/失败发布都用它——同一把刻度，比较与打点不会跨两套时钟各自成立。
   * 每次使用时现取（claim 时那一刻），不是异步 fetch 开始时的旧值。
   */
  readonly now?: () => string;
  /** REQUIRED host source guard at every claim / result / cache consumption boundary. */
  readonly assertCurrent: MediaTaskSourceGuard;
  /**
   * The real host run owner; passed through to the adapter verbatim. The real
   * conversation/binding guard scope stays the host's duty.
   */
  readonly owner: RunOwner & {
    readonly kind: "conversation" | "qq_binding";
    readonly id: string;
    readonly userId: string;
    readonly agentId: string;
  };
};

const TaskPolicy = z.string().trim().min(1);

/** A pending task takes its first attempt regardless of @-addressing; only a resolved failed task faces the not-addressed gate. */
function claimWillBeSecondAttempt(
  orm: Orm,
  taskKey: {
    mediaNoteId: string;
    purpose: QqMediaReadPurpose;
    questionKey?: string | null;
    contentSha256?: string;
  },
): boolean {
  const task = findMediaReadTask(orm, taskKey);
  return task !== null && task.status === "failed" && task.attempts >= 1;
}

/** A migrated database always owns one baseline task per consumed media row; absence means the ledger was changed outside 0052. */
function hasBaselineTask(orm: Orm, mediaNoteId: string): boolean {
  return (
    orm
      .select({ id: mediaReadTasks.id })
      .from(mediaReadTasks)
      .where(
        and(
          eq(mediaReadTasks.mediaNoteId, mediaNoteId),
          eq(mediaReadTasks.purpose, "baseline"),
          isNull(mediaReadTasks.questionKey),
        ),
      )
      .get() !== undefined
  );
}

export async function readQqMediaTaskOnce(
  orm: Orm,
  adapter: QqMediaReadAdapter,
  input: QqMediaTaskReadInput,
  signal?: AbortSignal,
): Promise<QqMediaTaskReadResult> {
  signal?.throwIfAborted();
  // 同一把宿主时钟贯穿整条任务读取路径；每次使用现取，claim/打点那一刻的刻度才是真实刻度。
  const now = () => input.now?.() ?? nowIso();
  const questionKey = input.purpose === "detail" ? input.questionKey : null;
  if (input.purpose === "baseline" && "assertQuestionCurrent" in input) {
    throw new TypeError("A baseline read never carries a question anchor");
  }
  if (input.purpose === "detail" && (questionKey === null || questionKey.trim().length === 0)) {
    throw new TypeError("A detail read task must name its question");
  }
  const policy = TaskPolicy.safeParse(input.policy);
  if (!policy.success) throw new TypeError("Invalid QQ media task read input");
  const owner = input.owner;
  const row = mediaNoteRow(orm, input.eventKey, input.segmentIndex);
  if (!row) return { kind: "unreadable", reason: "segment_missing" };
  const event = orm.select().from(qqEvents).where(eq(qqEvents.eventKey, input.eventKey)).get();
  if (!event) return { kind: "unreadable", reason: "event_missing" };
  const bindingIdentity = {
    accountId: event.accountId,
    kind: event.conversationKind as "group" | "private",
    peerId: event.peerId,
  };
  const startSettings = readQqSettings(orm);
  const startBinding = readBindingByConversation(orm, bindingIdentity);
  if (
    startSettings.enabled !== 1 ||
    startSettings.accountId !== event.accountId ||
    !startBinding ||
    startBinding.paused ||
    startBinding.agentId !== event.agentId ||
    getAgentRow(orm, event.agentId)?.isActive !== 1
  )
    return { kind: "unreadable", reason: "binding_inactive" };
  if (
    (owner.kind !== "conversation" && owner.kind !== "qq_binding") ||
    typeof owner.id !== "string" ||
    owner.id.trim().length === 0 ||
    owner.userId !== DEFAULT_USER_ID ||
    typeof owner.agentId !== "string" ||
    owner.agentId.trim().length === 0
  ) {
    fail("CONTEXT_SOURCE_INVALID", "媒体读取的运行归属不合法");
  }
  if (owner.agentId !== event.agentId) {
    fail("CONTEXT_SOURCE_INVALID", "媒体读取的运行归属不合法");
  }
  const ownerScope: { conversationId: string; bindingEpoch: number; authorityRevision: number } =
    (() => {
      if (owner.kind === "qq_binding" && owner.id !== startBinding.id) {
        fail("CONTEXT_SOURCE_INVALID", "媒体读取的绑定归属不合法");
      }
      if (owner.kind === "conversation") {
        const conversation = orm
          .select({
            id: conversations.id,
            channel: conversations.channel,
            sourceId: conversations.sourceId,
            agentId: conversations.agentId,
            userId: conversations.userId,
            closedAt: conversations.closedAt,
          })
          .from(conversations)
          .where(eq(conversations.id, owner.id))
          .get();
        if (
          conversation?.channel !== "onebot11" ||
          conversation.sourceId !== startBinding.id ||
          conversation.agentId !== event.agentId ||
          conversation.userId !== DEFAULT_USER_ID ||
          conversation.closedAt !== null
        ) {
          fail("CONTEXT_SOURCE_INVALID", "媒体读取的会话归属不合法");
        }
      }
      const open = orm
        .select({ id: conversations.id, bindingEpoch: conversations.bindingEpoch })
        .from(conversations)
        .where(
          and(
            eq(conversations.channel, "onebot11"),
            eq(conversations.sourceId, startBinding.id),
            isNull(conversations.closedAt),
          ),
        )
        .all();
      if (open.length !== 1 || !open[0]) fail("CONTEXT_SOURCE_INVALID", "媒体读取的会话归属不合法");
      // The owner must name this exact open activation, not another row that
      // merely shares the binding's source id under a different channel.
      if (owner.kind === "conversation" && owner.id !== open[0].id) {
        fail("CONTEXT_SOURCE_INVALID", "媒体读取的会话归属不合法");
      }
      return {
        conversationId: open[0].id,
        bindingEpoch: open[0].bindingEpoch,
        authorityRevision: startBinding.authorityRevision,
      };
    })();
  const purpose: QqMediaReadPurpose = input.purpose;
  if (row.expiresAt <= now()) return { kind: "unreadable", reason: "segment_expired" };
  if (row.segmentKind !== "image" && row.segmentKind !== "record" && row.segmentKind !== "video")
    return { kind: "unreadable", reason: "unsupported_kind" };
  const kind = row.segmentKind;
  if (!adapter.capabilities.includes(kind))
    return { kind: "unreadable", reason: "capability_unavailable" };
  const choice = qqMediaModelFor(kind, input.modelConfig);
  if (choice.kind !== "configured") return { kind: "unreadable", reason: "model_not_configured" };
  const taskKey = {
    mediaNoteId: row.id,
    purpose,
    ...(questionKey === null ? {} : { questionKey }),
  };
  // 同载体已成功结果先服务（零 fetch，现语义不变）：legacy 迁移任务与普通任务都按
  // 原窗口规则命中即回。
  const carrierCached = findMediaReadTask(orm, taskKey);
  // Identity bytes: a live asset answers for the row with ZERO fetch; otherwise
  // the adapter's controlled fetchBytes does one download (reused by read).
  // Neither available = explicit refusal: silently continuing with row-level
  // identity would let the same picture regain budget on a new URL (§8.1).
  const scopeIdentity = {
    accountId: event.accountId,
    conversationKind: event.conversationKind as "group" | "private",
    peerId: event.peerId,
    agentId: event.agentId,
  };
  let contentSha256 = input.contentSha256?.trim() ?? "";
  let identityBytes: Uint8Array | undefined;
  if (!contentSha256) {
    const asset = mediaAssetForMediaNote(orm, {
      mediaNoteId: row.id,
      scope: scopeIdentity,
      at: now(),
    });
    if (asset) {
      contentSha256 = asset.asset.contentSha256;
    } else if (adapter.fetchBytes) {
      const fetched = await adapter.fetchBytes({ kind, sourceRef: row.sourceRef, signal });
      signal?.throwIfAborted();
      if (!(fetched.bytes instanceof Uint8Array) || fetched.bytes.byteLength === 0) {
        fail("MEMORY_SOURCE_INVALID", "媒体字节不可用，无法确认内容身份");
      }
      identityBytes = fetched.bytes;
      contentSha256 = createHash("sha256").update(identityBytes).digest("hex");
    } else {
      return { kind: "unreadable", reason: "identity_unavailable" };
    }
  }
  // Required-sha cache chain (image kind only; record/video have no decode contract): when the identity came
  // from controlled fetched bytes and no live asset answers for this carrier, persist the bytes as the
  // carrier's asset + source link INSIDE the host guard's transaction — the claim's consumed authorization
  // then has a real, expiring chain instead of an unbound NULL. The header decides the real mime (never the
  // network content-type or a file suffix); an unreadable/unsupported header is the explicit information
  // boundary (fail, no cache write, no decode). Same-sha dedupe in recordMediaAsset reuses the cached bytes
  // row — that dedupe never authorizes anything: the link window is THIS carrier's own, never a renewal.
  let consumedAssetSourceId: string | undefined;
  if (identityBytes && kind === "image") {
    const header: QqImageHeader = readQqImageHeader(identityBytes);
    if (header.kind !== "read") {
      fail("MEMORY_SOURCE_INVALID", `图片字节不可读（${header.reason}），拒绝缓存与读取`);
    }
    const at = now();
    const recorded = orm.transaction(() => {
      input.assertCurrent(orm);
      if (input.purpose === "detail") input.assertQuestionCurrent(orm);
      const recordedAsset = recordMediaAsset(orm, {
        scope: scopeIdentity,
        bytes: identityBytes,
        mimeType: QQ_STICKER_CONTENT_TYPES[header.format],
        expiresAt: row.expiresAt,
        at,
      });
      const recordedLink = linkMediaAssetSource(orm, {
        assetId: recordedAsset.asset.id,
        mediaNoteId: row.id,
        scope: scopeIdentity,
        expiresAt: row.expiresAt,
        at,
      });
      return recordedLink.id;
    });
    consumedAssetSourceId = recorded;
  }
  // The identity ledger first (cross-carrier cache + budget); the carrier row
  // (incl. legacy migrations, identity NULL) fills the same-shaped slot when
  // the identity ledger has nothing — the per-carrier lookup below is what
  // serves the legacy policy='legacy' cache semantics unchanged.
  let identityLedger = findMediaReadTaskByIdentity(orm, {
    accountId: event.accountId,
    conversationKind: event.conversationKind,
    peerId: event.peerId,
    agentId: event.agentId,
    segmentKind: kind,
    purpose,
    questionKey: questionKey,
    contentSha256,
  });
  if (identityLedger === null) {
    // Controlled bytes just confirmed an identity that has no ledger row yet:
    // associate same-source legacy history (saturating min(2, Σ)) in its OWN
    // transaction — the association is a bytes-proven fact and must survive a
    // refused claim, or an exhausted legacy row would let a new carrier regain
    // budget. No legacy row matched = a genuinely fresh budget.
    identityLedger = associateLegacyMediaReadTask(orm, {
      mediaNoteId: row.id,
      mediaSegmentKind: kind,
      mediaSourceRef: row.sourceRef,
      accountId: event.accountId,
      conversationKind: event.conversationKind,
      peerId: event.peerId,
      agentId: event.agentId,
      purpose,
      questionKey: questionKey,
      contentSha256,
    });
  }
  const domainGuard: MediaTaskSourceGuard = (tx) => {
    const conversation = tx
      .select({ epoch: conversations.bindingEpoch, closedAt: conversations.closedAt })
      .from(conversations)
      .where(eq(conversations.id, ownerScope.conversationId))
      .get();
    const binding = tx
      .select({ authorityRevision: qqBindings.authorityRevision, agentId: qqBindings.agentId })
      .from(qqBindings)
      .where(eq(qqBindings.id, startBinding.id))
      .get();
    if (
      !conversation ||
      conversation.closedAt !== null ||
      conversation.epoch !== ownerScope.bindingEpoch ||
      !binding ||
      binding.agentId !== owner.agentId ||
      binding.agentId !== event.agentId ||
      binding.authorityRevision !== ownerScope.authorityRevision
    ) {
      fail("CONTEXT_SOURCE_INVALID", "媒体读取的会话归属已变化");
    }
    input.assertCurrent(tx);
    if (input.purpose === "detail") input.assertQuestionCurrent(tx);
  };
  const checkedGuard: MediaTaskSourceGuard = (tx) => {
    signal?.throwIfAborted();
    try {
      domainGuard(tx);
    } finally {
      // A cancellation during the guard wins over any domain error the guard
      // raised; 取消后的失败记账仍需来源授权。
      signal?.throwIfAborted();
    }
  };
  const cached = identityLedger ?? carrierCached;
  const legacyTask =
    purpose === "baseline" &&
    cached !== null &&
    cached.status === "succeeded" &&
    cached.policy === "legacy" &&
    cached.id.startsWith("legacy-");
  if (cached && cached.status === "succeeded") {
    const modelMatched = cached.modelName === choice.model;
    if (legacyTask) {
      if (modelMatched) {
        checkedGuard(orm);
        return {
          kind: "described",
          purpose,
          source: "legacy",
          taskId: cached.id,
          identityKey: cached.identityKey,
          mediaNoteId: row.id,
          contentSha256,
          note: cached.note ?? "",
          model: cached.modelName ?? choice.model,
          attempt: cached.attempts,
        };
      }
      return { kind: "unreadable", reason: "cache_mismatch" };
    }
    if (modelMatched && cached.policy === policy.data) {
      checkedGuard(orm);
      return {
        kind: "described",
        purpose,
        source: "cache",
        taskId: cached.id,
        identityKey: cached.identityKey,
        mediaNoteId: row.id,
        contentSha256,
        note: cached.note ?? "",
        model: cached.modelName ?? choice.model,
        attempt: cached.attempts,
      };
    }
    return { kind: "unreadable", reason: "cache_mismatch" };
  }
  // A legacy-consumed row (attempts > 0) must own its 0052 baseline task: the
  // check is against the real baseline ledger (media id + purpose='baseline'),
  // not the current taskKey — a legitimate fresh detail read on a consumed row
  // passes, an expired task must not count as a resettable missing baseline,
  // and a genuinely missing baseline still refuses instead of silently
  // resetting consumed attempts.
  if (row.attempts > 0 && !hasBaselineTask(orm, row.id)) {
    return { kind: "unreadable", reason: "legacy_task_missing" };
  }
  if (claimWillBeSecondAttempt(orm, taskKey) && !input.addressedToAssistant) {
    return { kind: "unreadable", reason: "not_addressed" };
  }
  let claim: Awaited<ReturnType<typeof attemptMediaReadTask>>;
  try {
    claim = await attemptMediaReadTask(orm, {
      ...taskKey,
      contentSha256,
      modelName: choice.model,
      policy: policy.data,
      ...(consumedAssetSourceId !== undefined ? { consumedAssetSourceId } : {}),
      relatedSupplementArrived:
        input.relatedSupplementArrived === true && input.addressedToAssistant,
      proveSupplementLaterThan:
        input.addressedToAssistant === false ? undefined : input.proveSupplementLaterThan,
      at: now(),
      assertCurrent: checkedGuard,
    });
  } catch (error) {
    if (error instanceof MediaReadTaskRejectedError) {
      if (error.authority) throw error;
      return { kind: "unreadable", reason: error.reason };
    }
    throw error;
  }
  // Claim succeeded; a cancellation from here on is a real consumed attempt.
  try {
    signal?.throwIfAborted();
    const generated = await adapter.read({
      kind,
      sourceRef: row.sourceRef,
      model: choice.model,
      signal,
      ...(identityBytes ? { bytes: identityBytes } : {}),
      owner,
      source: {
        // The raw ref names the ORIGINAL media (not the success task) and its
        // revision is the media row's real attempts counter — the exact value
        // context-access re-verifies for kind qq_media. The full combined
        // scope (owner guard + capability epoch) stays the host's composition.
        kind: "qq_media",
        id: row.id,
        revision: String(row.attempts),
        expiresAt: row.expiresAt,
      },
    });
    signal?.throwIfAborted();
    if (typeof generated !== "string") throw new Error("invalid media description");
    const note = generated.trim();
    if (!note) throw new Error("empty media description");
    recordMediaReadTaskResult(orm, {
      ...taskKey,
      note,
      modelName: choice.model,
      expectedAttempts: claim.attempt,
      claimToken: claim.claimToken,
      assertCurrent: checkedGuard,
      at: now(),
    });
    // The claim may have re-pointed the ledger's carrier to THIS read's row:
    // report the CURRENT carrier (re-read through the ledger row, window-blind).
    const ledger = findMediaReadTaskByIdentity(orm, {
      accountId: event.accountId,
      conversationKind: event.conversationKind,
      peerId: event.peerId,
      agentId: event.agentId,
      segmentKind: kind,
      purpose,
      questionKey,
      contentSha256,
    });
    return {
      kind: "described",
      purpose,
      source: "task",
      taskId: claim.task.id,
      identityKey: claim.task.identityKey,
      mediaNoteId: ledger?.mediaNoteId ?? row.id,
      contentSha256,
      note,
      model: choice.model,
      attempt: claim.attempt,
    };
  } catch (error) {
    let cleanupError: unknown = null;
    try {
      failMediaReadTask(orm, {
        ...taskKey,
        expectedAttempt: claim.attempt,
        revisionAtClaim: claim.task.revision,
        claimToken: claim.claimToken,
        // Cleanup is a domain guard: no signal check — a cancelled read still
        // publishes its consumed attempt as failed, never a running orphan.
        assertCurrent: domainGuard,
        at: now(),
      });
    } catch (cleanup) {
      cleanupError = cleanup;
    }
    signal?.throwIfAborted();
    if (cleanupError !== null && isAuthorityRefusal(cleanupError)) throw cleanupError;
    if (isAuthorityRefusal(error)) throw error;
    if (cleanupError === null) {
      const failure = qqMediaFailureOutcome({
        kind,
        attempts: claim.attempt,
        addressedToAssistant: input.addressedToAssistant,
      });
      return {
        kind: "failed",
        purpose,
        attempt: claim.attempt,
        announceInConversation: false,
        awaitSupplement: failure.awaitSupplement,
      };
    }
    throw error;
  }
}

/** Is this thrown value an authority refusal (never swallowable)? */
function isAuthorityRefusal(error: unknown): boolean {
  if (error instanceof AppError && error.code === "CONTEXT_SOURCE_INVALID") return true;
  if (error instanceof MediaReadTaskRejectedError && error.authority) return true;
  if (error instanceof Error && (error as { code?: unknown }).code === "CONTEXT_SOURCE_INVALID") {
    return true;
  }
  return false;
}
