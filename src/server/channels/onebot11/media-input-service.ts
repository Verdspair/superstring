import { createHash } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import type { ModelContent, RunOwner } from "../../../shared/contracts/agent-run";
import type { SourceRef } from "../../../shared/contracts/evidence";
import type {
  QqEffectiveMediaPolicy,
  QqImageCategory,
  QqImagePhase,
} from "../../../shared/contracts/qq-media-input";
import type {
  QqConversationScope,
  QqMessageFact,
  QqMessageFocus,
} from "../../../shared/contracts/qq-message";
import type { LeafAgentRuntime } from "../../agent/agent-runtime";
import type { ContextPrincipal } from "../../agent/context-access";
import type { ModelMediaClassification } from "../../agent/model-response-envelope";
import { bodyRevision } from "../../db/conversation-event-repository";
import {
  linkMediaAssetSource,
  mediaAssetForMediaNote,
  mediaClassificationFor,
  recordMediaAsset,
  recordMediaClassification,
  recordMediaVariant,
} from "../../db/qq-media-asset-repository";
import { DEFAULT_USER_ID, immediate, nowIso, type Orm } from "../../db/repositories";
import * as schema from "../../db/schema";
import { AppError, fail } from "../../errors";
import type { EvidenceStore } from "../../modules/conversation-evidence-store";
import {
  prepareQqImage,
  type QqPreparedImage as QqPreparedFrame,
} from "../../services/qq-image-codec";
import { QqImagePrepareError } from "../../services/qq-image-error";
import {
  QQ_STICKER_CONTENT_TYPES,
  type QqImageHeader,
  readQqImageHeader,
} from "../../services/qq-image-header";
import { createQqMediaAdapter } from "../../services/qq-media-adapter";
import { readQqMediaTaskOnce } from "../../services/qq-media-reader";
import {
  createQqMediaSourceRef,
  ownerScope,
  qqMediaSourceAccess,
} from "../../services/qq-media-sources";
import {
  createQqMediaReadTaskSourceRef,
  qqMediaReadTaskSourceAccess,
} from "../../services/qq-media-task-sources";
import {
  type QqMediaOmission,
  type QqSelectedMediaCandidate,
  selectQqMediaCandidates,
} from "./media-projection";
import type { QqReplyProjection } from "./reply-context";

export interface ConsumeModelMediaDataInput {
  readonly store: EvidenceStore;
  readonly owner: RunOwner;
  readonly scope: QqConversationScope;
  readonly sentMediaIds: ReadonlySet<string>;
  readonly sentSources: ReadonlyMap<string, SourceRef>;
  readonly classifications: readonly ModelMediaClassification[];
  readonly actualModel: string;
  readonly policyRevision: string;
  readonly assertCurrent: (tx: Orm) => void;
  readonly signal?: AbortSignal;
  readonly at?: string;
}

const atOrNow = (at?: string): string => at ?? nowIso();

function assetSourceLedgerRow(
  orm: Orm,
  mediaNoteId: string,
): { assetId: string; sourceId: string } | null {
  const row = orm
    .select({
      assetId: schema.qqMediaAssetSources.assetId,
      sourceId: schema.qqMediaAssetSources.id,
    })
    .from(schema.qqMediaAssetSources)
    .where(eq(schema.qqMediaAssetSources.mediaNoteId, mediaNoteId))
    .get();
  return row ?? null;
}

export function consumeModelMediaData(input: ConsumeModelMediaDataInput): void {
  input.signal?.throwIfAborted();
  const at = atOrNow(input.at);
  if (input.actualModel.trim().length === 0) {
    throw new TypeError("A model classification consumer must name the actual model");
  }
  if (input.policyRevision.trim().length === 0) {
    throw new TypeError("A model classification consumer must carry a policy revision");
  }
  const owner = input.owner;
  if (
    owner.userId !== DEFAULT_USER_ID ||
    typeof owner.agentId !== "string" ||
    owner.agentId !== input.scope.agentId
  ) {
    fail("CONTEXT_SOURCE_INVALID", "分类消费的运行归属不合法");
  }
  const principal: ContextPrincipal = { userId: DEFAULT_USER_ID };
  const db = input.store.db;
  const orm = input.store.orm;

  try {
    immediate(db, () => {
      input.assertCurrent(orm);
      input.signal?.throwIfAborted();
      const located = ownerScope(db, owner);
      if (located === "ambiguous" || !located) {
        fail("CONTEXT_SOURCE_INVALID", "分类消费的会话归属不合法");
      }
      const resolvedScope = located.scope;
      if (
        resolvedScope.conversationId !== input.scope.conversationId ||
        resolvedScope.bindingId !== input.scope.bindingId ||
        resolvedScope.bindingEpoch !== input.scope.bindingEpoch ||
        resolvedScope.authorityRevision !== input.scope.authorityRevision
      ) {
        fail("CONTEXT_SOURCE_INVALID", "分类消费的作用域与 owner 解析不一致");
      }
      interface ResolvedEntry {
        readonly mediaNoteId: string;
        readonly category: ModelMediaClassification["category"];
        readonly assetId: string;
      }
      const resolved: ResolvedEntry[] = [];
      const seenIds = new Set<string>();
      for (const item of input.classifications) {
        if (!input.sentMediaIds.has(item.mediaId)) {
          fail("MEMORY_SOURCE_INVALID", "分类指向了未发送的媒体，拒绝写入");
        }
        if (seenIds.has(item.mediaId)) {
          fail("MEMORY_SOURCE_INVALID", "分类重复指向同一媒体，拒绝写入");
        }
        seenIds.add(item.mediaId);
        const ref = input.sentSources.get(item.mediaId);
        if (ref?.kind !== "qq_media_source" || ref.id !== item.mediaId) {
          fail("MEMORY_SOURCE_INVALID", "分类缺少本轮冻结的媒体来源引用");
        }
        const access = qqMediaSourceAccess(db, ref, owner, principal, at);
        if (access !== "available") {
          fail("CONTEXT_SOURCE_INVALID", "媒体来源引用不可用，拒绝写入");
        }
        const liveRef = createQqMediaSourceRef(input.store, resolvedScope, item.mediaId, at);
        if (!liveRef || liveRef.revision !== ref.revision || liveRef.expiresAt !== ref.expiresAt) {
          fail("CONTEXT_SOURCE_INVALID", "媒体来源当前不可复现，拒绝写入");
        }
        const ledger = assetSourceLedgerRow(orm, item.mediaId);
        if (!ledger) {
          fail("MEMORY_SOURCE_INVALID", "媒体没有挂接的缓存资产，拒绝写入");
        }
        const asset = orm
          .select({
            id: schema.qqMediaAssets.id,
            accountId: schema.qqMediaAssets.accountId,
            conversationKind: schema.qqMediaAssets.conversationKind,
            peerId: schema.qqMediaAssets.peerId,
            agentId: schema.qqMediaAssets.agentId,
            expiresAt: schema.qqMediaAssets.expiresAt,
          })
          .from(schema.qqMediaAssets)
          .where(eq(schema.qqMediaAssets.id, ledger.assetId))
          .get();
        if (
          !asset ||
          asset.accountId !== input.scope.accountId ||
          asset.conversationKind !== input.scope.conversationKind ||
          asset.peerId !== input.scope.peerId ||
          asset.agentId !== input.scope.agentId ||
          Date.parse(asset.expiresAt) <= Date.parse(at)
        ) {
          fail("MEMORY_SOURCE_INVALID", "缓存资产与分类消费不在同一作用域或已过期");
        }
        resolved.push({
          mediaNoteId: item.mediaId,
          category: item.category,
          assetId: ledger.assetId,
        });
      }
      input.signal?.throwIfAborted();
      for (const entry of resolved) {
        const liveSource = orm
          .select({ id: schema.qqMediaAssetSources.id })
          .from(schema.qqMediaAssetSources)
          .where(
            and(
              eq(schema.qqMediaAssetSources.mediaNoteId, entry.mediaNoteId),
              eq(schema.qqMediaAssetSources.assetId, entry.assetId),
            ),
          )
          .get();
        if (!liveSource) {
          fail("MEMORY_SOURCE_INVALID", "媒体来源行已在事务内失效，拒绝写入");
        }
      }
      for (const entry of resolved) {
        recordMediaClassification(orm, {
          assetId: entry.assetId,
          category: entry.category,
          evidence: "model",
          policy: input.policyRevision,
          modelName: input.actualModel,
          at,
        });
      }
    });
  } catch (error) {
    // Cancellation must surface as its own reason — a primitive or object value
    // included — never as the DatabaseError that `immediate` wraps it into;
    // any other escaping error keeps its own class untouched.
    if (input.signal?.aborted) input.signal.throwIfAborted();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// T10 实际媒体准备（规格 §2.3 QqMediaProjection、§7.1/§7.4/§7.5、§8.1、§9）。
//
// 工厂注入唯一一套 bytes source / Runtime / 读取配置；每次调用只做：候选选择（已验纯函数
// selectQqMediaCandidates）→ 作用域复验（fail closed）→ 字节获取与缓存（asset+variant）→ 投影。
// 不建模型链、不新增固定 classifier 调用；description 走既有 typed baseline 读取（缓存命中
// 不花尝试）。stage 关闭只关闭本阶段自动图（selector 产 stage_disabled omissions）；全局/本群
// 能力关闭由宿主传 capabilityEnabled=false——此时连 fetch/codec/describe 都不发生（§9）。
// ---------------------------------------------------------------------------

/** 规格 §2.3：一张准备好的图投影给装配层；bytes 永不进本结构，只进宿主的登记边界。 */
export interface QqPreparedMediaImage {
  readonly mediaId: string;
  readonly messageIds: readonly string[];
  readonly category: QqImageCategory;
  readonly categorySource: "platform" | "model" | "unknown";
  readonly sha256: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly frameIndex: number | null;
  readonly content: ModelContent;
  readonly sources: readonly SourceRef[];
  /**
   * 宿主取字节锚点（不扩 ModelContent/wire）：variantId＝qq_media_variants 主键（仓储已有
   * 主键），assetId＝qq_media_assets 主键；宿主按 id 直取缓存字节后登记 resolver，不重算策略。
   */
  readonly variantId: string;
  readonly variantPolicy: string;
  readonly assetId: string;
}

/** 规格 §2.3 QqMediaProjection：装配层唯一媒体投影形状。 */
export interface QqMediaProjection {
  readonly phase: QqImagePhase;
  readonly requestedMode: "native" | "description";
  readonly actualMode: "native" | "description" | "disabled" | "unavailable";
  readonly images: readonly QqPreparedMediaImage[];
  readonly notes: ReadonlyArray<{ mediaId: string; text: string; taskId: string }>;
  readonly omissions: ReadonlyArray<{ mediaId: string; messageId: string; reason: string }>;
  readonly sources: readonly SourceRef[];
}

export interface QqMediaInputServiceOptions {
  readonly store: EvidenceStore;
  /** 受控 bytes source：宿主注入（真实接线 = OneBot 来源解析；测试注入合成 bytes）。 */
  readonly fetchSource: (input: {
    readonly sourceRef: string;
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly bytes: Uint8Array }>;
  /** description 模式的视觉叶子运行时（与宿主 media adapter 同一 Runtime 侧）。 */
  readonly agentRuntime: LeafAgentRuntime;
  /** 媒体槽指令（方案 media prompt），透传 createQqMediaAdapter。 */
  readonly prompt: string;
  /** description 读取的模型选择（与宿主 createQqMediaTools 注入同源）。 */
  readonly modelConfig: {
    readonly visionModelName: string | null;
    readonly transcriptionModelName: string | null;
  };
  /**
   * description baseline 读取的完整策略串：宿主必须把给 createQqMediaTools 的同一
   * `baseline/v1/<policyRevision>` 组合值传进来（同一真源，本服务不另造策略键）。
   */
  readonly baselinePolicy: string;
}

export interface QqMediaProjectionInput {
  readonly scope: QqConversationScope;
  readonly phase: QqImagePhase;
  readonly focus: QqMessageFocus;
  readonly facts: readonly QqMessageFact[];
  readonly replies: QqReplyProjection;
  readonly settings: QqEffectiveMediaPolicy;
  readonly model: string;
  readonly now: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  /** 全局/本群 media 能力放行真值（宿主 capability guard 结果）；缺省 true。 */
  readonly capabilityEnabled?: boolean;
  /** 明确细问的 mediaId（升普通规格 + explicit 桶）；缺省空集。 */
  readonly detailMediaIds?: ReadonlySet<string>;
  /** per-call 覆盖 owner；缺省按 scope 精确派生 conversation owner，不扩大来源。 */
  readonly owner?: RunOwner;
  /** description 读取的 addressedToAssistant（§7.2 重试规则）；缺省 true。 */
  readonly addressedToAssistant?: boolean;
  /**
   * 分类缓存回读键（§7.2）：宿主透传给 consumeModelMediaData 的同一
   * `policyRevision`（＝mediaPolicyRevision，写侧真源）——与 typed baseline 读取任务的
   * `baseline/v1/<rev>` 组合串不是同一把键，本服务不做二次组合。缺省＝不做分类回读。
   * 回读模型键＝input.model（消费同一 call 的目标模型）；平台可靠分类优先，模型不覆平台。
   */
  readonly classificationPolicy?: string;
}

/**
 * 明确细问的问题锚（规格 §7.3/§7.4，宿主冻结）：问题身份只来自真实问题消息的原文
 * （`questionKey` 由宿主 normalizeQuestionKey 规范化，`eventKey` 是该消息的真实事件键，
 * `source` 是它自己的来源）。模型措辞不参与身份，也不参与任何键。
 * `assertQuestionCurrent(tx)` 在本服务的每个读边界与每个写事务内复验：问题消息消失、
 * 改写或换绑即按 authority 失败穿透（CONTEXT_SOURCE_INVALID），零缓存写入。
 */
export interface QqMediaDetailQuestionAnchor {
  readonly questionKey: string;
  readonly eventKey: string;
  readonly source: SourceRef;
  readonly assertQuestionCurrent: (tx: Orm) => void;
}

/**
 * 按需读取一张已披露媒体行的输入（计划 T08 Step8，规格 §7.5/§8.2/§9/§12）。
 *
 * 与自动范围投影的边界差别：调用方（宿主 `media.read` 工具边界）**已经**校验过
 * 「本 run 由 media.list 披露 / 作用域一致 / 未过期」；本服务只负责把这个指定 mediaId
 * 真准备出来并给出真实来源与影像元数据，不重跑自动选择器、不放大范围、也不为别的
 * 媒体行写任何缓存。阶段（stage）关闭**不**阻止这条合法资源读取（规格 §7.1：阶段只关
 * 自动图）；但能力关闭（capabilityEnabled=false）必全拒，零 fetch/零 codec/零写入。
 * 画面是否真的送进下一次模型调用仍由宿主按阶段设置与能力守卫视，本服务不发 raw 字节。
 */
export interface QqMediaOnDemandInput {
  readonly scope: QqConversationScope;
  /** 调用方所在阶段（记录在结果里；本服务不据此关闭按需读取）。 */
  readonly phase: QqImagePhase;
  /** 本轮应回应的消息（焦点）事实；用于分类证据与 messageIds 关系，不扩大选择范围。 */
  readonly focus: QqMessageFocus;
  readonly facts: readonly QqMessageFact[];
  readonly replies: QqReplyProjection;
  readonly settings: QqEffectiveMediaPolicy;
  /** 本次调用的实际目标模型（分类回读的模型维度；未知时按 requested 透传，不猜 resolved）。 */
  readonly model: string;
  readonly now: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  /** 已被工具边界确认披露、确属本 scope 的 mediaId。 */
  readonly mediaId: string;
  /** 全局/本群 media 能力放行真值（宿主 capability guard 结果）；缺省 true。 */
  readonly capabilityEnabled?: boolean;
  /** per-call 覆盖 owner；缺省按 scope 精确派生 conversation owner，不扩大来源。 */
  readonly owner?: RunOwner;
  /** 分类缓存回读键（与 consumeModelMediaData 同一真源）；缺省＝不回读。 */
  readonly classificationPolicy?: string;
  /** 明确细问锚：存在则按 detail 规格准备（本次升普通规格），并逐边界复验问题真值。 */
  readonly detail?: QqMediaDetailQuestionAnchor;
}

/**
 * 按需读取的返回：影像元数据与真实来源（`QqPreparedMediaImage[]`），与自动范围投影
 * 共用同一契约（同一个 `QqPreparedMediaImage`，同一套 variantId/assetId 取字节锚点），
 * 绝不另造第二个 resolver 或第二套返回形状。bytes/url/path 一律不出现在这里。
 */
export interface QqMediaOnDemandResult {
  readonly mediaId: string;
  readonly category: QqImageCategory;
  readonly categorySource: "platform" | "model" | "unknown";
  readonly detail: boolean;
  readonly messageIds: readonly string[];
  readonly images: readonly QqPreparedMediaImage[];
  readonly sources: readonly SourceRef[];
}

/** 媒体输入服务：工厂注入依赖，T11 宿主按稳定签名消费。 */
export interface QqMediaInputService {
  prepareQqMediaProjection(input: QqMediaProjectionInput): Promise<QqMediaProjection>;
  /**
   * 仅 MODEL_IMAGE_UNSUPPORTED 的显式 fallback：requestedMode 保持 native、actualMode
   * description（§9），原因/目标模型由调用方记录。其他错误绝不走本接口。
   */
  describeAfterUnsupported(input: QqMediaProjectionInput): Promise<QqMediaProjection>;
  /**
   * 按需准备**一个**已披露媒体行（计划 T08 Step8 / 规格 §7.5）：真实受控 fetch（缺
   * cache 才下）、bytes 缓存、asset+link+variant 登记、分类回读与 detail 规格，与
   * prepareQqMediaProjection 完全同一实现。阶段关闭不阻止它（合法资源读取），能力关闭
   * 必全拒。返回真实来源与影像元数据，供宿主登记 currentrun resolver 并在下一步按阶段
   * 设置把 prepared 集合送入画面；本服务自己不发模型调用、不消费 noimagebudget 旁路。
   */
  prepareByMediaId(input: QqMediaOnDemandInput): Promise<QqMediaOnDemandResult>;
}

/** 窄判别：只有 AppError 且 code 精确等于 MODEL_IMAGE_UNSUPPORTED 才是图片能力拒绝。
 * 鉴权（401/403）、超长（413）、限流（429）、5xx、schema/tools 与超时全部不匹配。 */
export function isModelImageUnsupportedError(error: unknown): boolean {
  return error instanceof AppError && error.code === "MODEL_IMAGE_UNSUPPORTED";
}

const DEFAULT_DETAIL_MEDIA_IDS: ReadonlySet<string> = new Set();

function categorySourceOf(
  facts: readonly QqMessageFact[],
  mediaId: string,
): "platform" | "model" | "unknown" {
  for (const fact of facts) {
    for (const part of fact.parts) {
      if (part.kind === "image" && part.mediaId === mediaId) {
        // 平台可靠证据在 intake 已归一进 category；unknown＝无可靠证据，不冒充 platform。
        return part.category === "unknown" ? "unknown" : "platform";
      }
    }
  }
  return "unknown";
}

/** §7.4 规格选择：普通/unknown 按 ordinary 规格；明确细问的表情本次升普通规格。 */
function specFor(
  category: QqImageCategory,
  detail: boolean,
  settings: QqEffectiveMediaPolicy,
): { stillMaxDimension: number | null; frameCount: number; frameMaxDimension: number } {
  const effective: QqImageCategory = category === "expression" && detail ? "ordinary" : category;
  if (effective === "expression") {
    return {
      stillMaxDimension: settings.expression_max_dimension,
      frameCount: settings.expression_frame_count,
      frameMaxDimension: settings.expression_frame_max_dimension,
    };
  }
  return {
    stillMaxDimension: settings.ordinary_still_max_dimension,
    frameCount: settings.ordinary_frame_count,
    frameMaxDimension: settings.ordinary_frame_max_dimension,
  };
}

/** 准备副本策略键：规格内容决定，规格变了不复用旧副本（§8.2）。动图带帧后缀 `#f<i>`。 */
function variantPolicyOf(
  spec: {
    category: QqImageCategory;
    detail: boolean;
    stillMaxDimension: number | null;
    frameCount: number;
    frameMaxDimension: number;
  },
  frameIndex: number | null,
): string {
  const base = `prepare/v1:${bodyRevision(
    JSON.stringify([
      spec.category,
      spec.detail,
      spec.stillMaxDimension,
      spec.frameCount,
      spec.frameMaxDimension,
    ]),
  )}`;
  return frameIndex === null ? base : `${base}#f${frameIndex}`;
}

export function createQqMediaInputService(
  options: QqMediaInputServiceOptions,
): QqMediaInputService {
  const prompt = options.prompt.trim();
  if (prompt.length === 0) throw new TypeError("Invalid QQ media input service prompt");
  const baselinePolicy = options.baselinePolicy.trim();
  if (baselinePolicy.length === 0) {
    fail("CONTEXT_SOURCE_INVALID", "媒体描述读取的策略修订缺失");
  }
  const adapter = createQqMediaAdapter({
    fetchSource: options.fetchSource,
    agentRuntime: options.agentRuntime,
    prompt,
  });
  const db = options.store.db;
  const orm = options.store.orm;

  /** 作用域复验：与 consumeModelMediaData 同一 ownerScope + 四元组规则，fail closed。 */
  function verifyScope(scope: QqConversationScope, owner: RunOwner): void {
    const located = ownerScope(db, owner);
    if (located === "ambiguous" || !located) {
      fail("CONTEXT_SOURCE_INVALID", "媒体准备的会话归属不合法");
    }
    const resolved = located.scope;
    if (
      resolved.conversationId !== scope.conversationId ||
      resolved.accountId !== scope.accountId ||
      resolved.conversationKind !== scope.conversationKind ||
      resolved.peerId !== scope.peerId ||
      resolved.agentId !== scope.agentId ||
      resolved.bindingId !== scope.bindingId ||
      resolved.bindingEpoch !== scope.bindingEpoch ||
      resolved.authorityRevision !== scope.authorityRevision
    ) {
      fail("CONTEXT_SOURCE_INVALID", "媒体准备的作用域与 owner 解析不一致");
    }
  }

  const deriveOwner = (scope: QqConversationScope): RunOwner => ({
    kind: "conversation",
    id: scope.conversationId,
    userId: DEFAULT_USER_ID,
    agentId: scope.agentId,
  });

  function select(input: QqMediaProjectionInput) {
    return selectQqMediaCandidates({
      facts: input.facts,
      replies: input.replies,
      focus: { responseMessageIds: input.focus.responseMessageIds },
      settings: input.settings,
      phase: input.phase,
      capabilityEnabled: true,
      detailMediaIds: input.detailMediaIds ?? DEFAULT_DETAIL_MEDIA_IDS,
      now: input.now,
    });
  }

  /** description 路径（§8.1）：typed baseline 读取，命中缓存不花尝试；缺读不编内容。 */
  async function describe(
    input: QqMediaProjectionInput,
    owner: RunOwner,
  ): Promise<QqMediaProjection> {
    const selection = select(input);
    const notes: Array<{ mediaId: string; text: string; taskId: string }> = [];
    const sources: SourceRef[] = [];
    let unavailable = false;
    for (const candidate of selection.selected) {
      input.signal.throwIfAborted();
      const noteRow = orm
        .select()
        .from(schema.qqMediaNotes)
        .where(eq(schema.qqMediaNotes.id, candidate.mediaId))
        .get();
      if (!noteRow) {
        unavailable = true;
        continue;
      }
      const result = await readQqMediaTaskOnce(orm, adapter, {
        eventKey: noteRow.eventKey,
        segmentIndex: noteRow.segmentIndex,
        purpose: "baseline",
        policy: baselinePolicy,
        modelConfig: options.modelConfig,
        addressedToAssistant: input.addressedToAssistant ?? true,
        assertCurrent: input.assertCurrent,
        owner: {
          kind: "conversation",
          id: input.scope.conversationId,
          userId: owner.userId ?? DEFAULT_USER_ID,
          agentId: owner.agentId ?? input.scope.agentId,
        },
      });
      if (result.kind !== "described") {
        // unreadable/failed：不编内容，也不伪造图像；描述缺口如实体现。
        unavailable = true;
        continue;
      }
      // 实际任务 mint qq_media_read_task ref，owner/revision/expiry 复验后才进 notes/sources；
      // mint 或复验失败＝来源不可信，该 note 不外泄（不裸 notes）。
      const taskRef = createQqMediaReadTaskSourceRef(
        options.store,
        input.scope,
        result.taskId,
        input.now,
      );
      const principal: ContextPrincipal = { userId: DEFAULT_USER_ID };
      const access =
        taskRef === null
          ? "revoked"
          : qqMediaReadTaskSourceAccess(db, taskRef, owner, principal, input.now);
      if (taskRef === null || access !== "available") {
        unavailable = true;
        continue;
      }
      notes.push({ mediaId: candidate.mediaId, text: result.note, taskId: result.taskId });
      sources.push(taskRef);
    }
    return {
      phase: input.phase,
      requestedMode: input.settings.mode,
      actualMode: unavailable && notes.length === 0 ? "unavailable" : "description",
      images: [],
      notes,
      omissions: selection.omissions,
      sources,
    };
  }

  const scopeIdentityOf = (scope: QqConversationScope) => ({
    accountId: scope.accountId,
    conversationKind: scope.conversationKind,
    peerId: scope.peerId,
    agentId: scope.agentId,
  });

  /**
   * 一个已授权媒体行的真实准备（native 内核）：缓存优先（live source + asset 复验后复用源
   * 字节、variant 先查后 codec），缺口才 fetch/解码；写入事务内复验来源（§8.2/§12）。
   * 自动范围（prepareQqMediaProjection）与按需读取（prepareByMediaId）共用这一条实现——
   * 同一套受控 fetch、同一份字节缓存、同一套 asset/link/variant 登记、同一把 specFor 与
   * 分类回读，绝不出现第二条准备链、也不复制 codec 或新 gateway。
   * `detailAnchor` 只在明确细问时存在：每个边界与每个写事务都复验问题真值，问题原文变了
   * 就按 authority 失败穿透（不回写任何缓存）。
   */
  async function prepareNativeCandidate(
    input: QqMediaProjectionInput,
    owner: RunOwner,
    candidate: QqSelectedMediaCandidate,
    scopeIdentity: ReturnType<typeof scopeIdentityOf>,
    detailAnchor?: QqMediaDetailQuestionAnchor,
  ): Promise<{
    readonly images: QqPreparedMediaImage[];
    /** 「本轮不可读」出口：仅 unsupported_animation 窄捕获命中；asset 原始字节缓存照常，variant 零产出，已 mint 的 ref 不作为消费证明返回。 */
    readonly source: SourceRef | null;
    /** 缺省 false；命中窄捕获时 true，prepareNative 据此追加 unreadable omission。 */
    readonly unreadable?: boolean;
  }> {
    const images: QqPreparedMediaImage[] = [];
    input.signal.throwIfAborted();
    input.assertCurrent();
    verifyScope(input.scope, owner);
    detailAnchor?.assertQuestionCurrent(orm);
    const row = orm
      .select()
      .from(schema.qqMediaNotes)
      .where(eq(schema.qqMediaNotes.id, candidate.mediaId))
      .get();
    if (!row) fail("MEMORY_SOURCE_INVALID", "媒体行不存在，拒绝准备");
    if (Date.parse(row.expiresAt) <= Date.parse(input.now)) {
      fail("CONTEXT_SOURCE_INVALID", "媒体来源已过期，拒绝准备");
    }
    // 1) 先 mint 来源 ref：null＝尚无 live link（首见）；有＝live link+asset 均活，可复用缓存字节。
    let ref = createQqMediaSourceRef(options.store, input.scope, row.id, input.now);
    let assetId: string;
    let sourceBytes: Uint8Array;
    let sourceMimeType: string;
    const cachedAsset =
      ref === null
        ? null
        : mediaAssetForMediaNote(orm, {
            mediaNoteId: row.id,
            scope: scopeIdentity,
            at: input.now,
          });
    if (ref !== null && cachedAsset !== null) {
      // 授权复验通过：复用缓存源字节，本轮不 fetch。
      assetId = cachedAsset.asset.id;
      sourceBytes = new Uint8Array(cachedAsset.asset.bytes as ArrayBufferLike);
      sourceMimeType = cachedAsset.asset.mimeType;
    } else {
      const fetched = await options.fetchSource({
        sourceRef: row.sourceRef,
        signal: input.signal,
      });
      input.signal.throwIfAborted();
      const header: QqImageHeader = readQqImageHeader(fetched.bytes);
      if (header.kind !== "read") {
        fail("MEMORY_SOURCE_INVALID", "图片字节不可读，拒绝缓存");
      }
      sourceBytes = fetched.bytes;
      sourceMimeType = QQ_STICKER_CONTENT_TYPES[header.format];
      // 2) asset + link + 来源 mint（同一 immediate 事务，写前复验 §12）。
      const recorded = immediate(db, () => {
        verifyScope(input.scope, owner);
        input.assertCurrent();
        detailAnchor?.assertQuestionCurrent(orm);
        const recordedAsset = recordMediaAsset(orm, {
          scope: scopeIdentity,
          bytes: sourceBytes,
          mimeType: sourceMimeType,
          expiresAt: row.expiresAt,
          at: input.now,
        });
        linkMediaAssetSource(orm, {
          assetId: recordedAsset.asset.id,
          mediaNoteId: row.id,
          scope: scopeIdentity,
          expiresAt: row.expiresAt,
          at: input.now,
        });
        const minted = createQqMediaSourceRef(options.store, input.scope, row.id, input.now);
        if (!minted) {
          fail("CONTEXT_SOURCE_INVALID", "媒体来源当前不可复现，拒绝准备");
        }
        return { assetId: recordedAsset.asset.id, ref: minted };
      });
      assetId = recorded.assetId;
      ref = recorded.ref;
    }
    // 2) 分类缓存回读（§7.2）：仅 facts 无可靠平台分类（unknown）时采用缓存；模型不覆平台。
    //    回读键 = (assetId, classificationPolicy=宿主透传的 consume policyRevision, input.model)；
    //    live source 已由 mediaAssetForMediaNote/ref mint 复验，另查分类行所在资产即本资产。
    let effectiveCategory = candidate.category;
    let effectiveCategorySource: "platform" | "model" | "unknown" = categorySourceOf(
      input.facts,
      candidate.mediaId,
    );
    if (input.classificationPolicy !== undefined && effectiveCategory === "unknown") {
      const policy = input.classificationPolicy.trim();
      if (policy.length === 0) {
        fail("CONTEXT_SOURCE_INVALID", "分类回读策略缺失");
      }
      const cached = mediaClassificationFor(orm, {
        assetId,
        policy,
        modelName: input.model,
      });
      const cachedCategory = cached?.category;
      if (
        cached &&
        cached.assetId === assetId &&
        (cachedCategory === "ordinary" ||
          cachedCategory === "expression" ||
          cachedCategory === "unknown")
      ) {
        effectiveCategory = cachedCategory;
        if (cached.evidence === "model") effectiveCategorySource = "model";
      }
    }
    const spec = specFor(effectiveCategory, candidate.detail, input.settings);
    const basePolicy = variantPolicyOf(
      { category: effectiveCategory, detail: candidate.detail, ...spec },
      null,
    );
    // 3) variant 先查后解码：按帧序号逐帧查该规格的已有副本，全命中则 codec=0。
    //    帧总数未知（未解码）时以「已缓存的连续帧序」为准：存在 `#f<i>` 行则沿用其
    //    frames 元数据声明的帧数，否则解码后按实际帧数写。
    const variantRows = orm
      .select()
      .from(schema.qqMediaVariants)
      .where(
        and(
          eq(schema.qqMediaVariants.assetId, assetId),
          like(schema.qqMediaVariants.policy, `${basePolicy}%`),
        ),
      )
      .all();
    const cachedByIndex = new Map<number, (typeof variantRows)[number]>();
    let declaredFrameCount: number | null = null;
    for (const variantRow of variantRows) {
      const suffix = variantRow.policy.slice(basePolicy.length);
      if (suffix === "") {
        cachedByIndex.set(-1, variantRow); // still-image variant
        continue;
      }
      const match = /^#f(\d+)$/.exec(suffix);
      if (!match) continue;
      cachedByIndex.set(Number(match[1]), variantRow);
      if (variantRow.frameCount !== null && declaredFrameCount === null) {
        declaredFrameCount = variantRow.frameCount;
      }
    }
    const isAnimation = declaredFrameCount !== null;
    const expectedIndices: number[] = isAnimation
      ? Array.from({ length: declaredFrameCount ?? 0 }, (_, index) => index)
      : [-1];
    const missing = expectedIndices.filter((index) => !cachedByIndex.has(index));
    const preparedFrames: QqPreparedFrame[] = [];
    for (const index of expectedIndices) {
      const cached = cachedByIndex.get(index);
      if (!cached) continue;
      preparedFrames.push({
        mimeType: cached.mimeType,
        bytes: new Uint8Array(cached.bytes as ArrayBufferLike),
        width: cached.width ?? 0,
        height: cached.height ?? 0,
        frameIndex: index === -1 ? null : index,
        sourceFrameCount: declaredFrameCount ?? 1,
        truncated: false,
      });
    }
    if (missing.length > 0 || (!isAnimation && !cachedByIndex.has(-1))) {
      let decoded: QqPreparedFrame[];
      try {
        decoded = await prepareQqImage(sourceBytes, {
          category: effectiveCategory,
          detail: candidate.detail,
          stillMaxDimension: spec.stillMaxDimension,
          frameCount: spec.frameCount,
          frameMaxDimension: spec.frameMaxDimension,
          signal: input.signal,
        });
      } catch (error) {
        // §7.5 最小补口：唯一一处窄捕获。真实动画容器（animated WebP/APNG）宿主侧无法
        // 诚实采样，该图本轮「存在但不可读」：保原始字节缓存（asset 按单链既有事实缓存），
        // 不创建可供模型的 variant、不返回图像或消费证明。其余原因（unreadable_image/
        // decode_failed/cancelled）与任何非 codec 异常原样穿透，不泛 catch（§9 故障如实报错）。
        if (!(error instanceof QqImagePrepareError) || error.reason !== "unsupported_animation") {
          throw error;
        }
        // 返回 unreadable 前末次复验：await 之后取消/撤源绝不包装成 unreadable（§9/§12）。
        input.signal.throwIfAborted();
        verifyScope(input.scope, owner);
        input.assertCurrent();
        detailAnchor?.assertQuestionCurrent(orm);
        return { images: [], source: null, unreadable: true };
      }
      input.signal.throwIfAborted();
      for (const frame of decoded) {
        const index = frame.frameIndex === null ? -1 : frame.frameIndex;
        if (!cachedByIndex.has(index)) preparedFrames.push(frame);
        const policy = variantPolicyOf(
          { category: effectiveCategory, detail: candidate.detail, ...spec },
          frame.frameIndex,
        );
        if (cachedByIndex.has(index)) continue;
        const variantRow = immediate(db, () => {
          verifyScope(input.scope, owner);
          input.assertCurrent();
          detailAnchor?.assertQuestionCurrent(orm);
          return recordMediaVariant(orm, {
            assetId,
            policy,
            bytes: frame.bytes,
            mimeType: frame.mimeType,
            width: frame.width,
            height: frame.height,
            frameCount: decoded.length > 1 ? decoded.length : undefined,
            frames:
              decoded.length > 1
                ? decoded.map((entry) => ({
                    index: entry.frameIndex,
                    width: entry.width,
                    height: entry.height,
                  }))
                : undefined,
            at: input.now,
          });
        });
        cachedByIndex.set(index, variantRow.variant);
      }
    }
    for (const frame of preparedFrames) {
      const index = frame.frameIndex === null ? -1 : frame.frameIndex;
      const variantRow = cachedByIndex.get(index);
      if (!variantRow) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
      const policy = variantPolicyOf(
        { category: effectiveCategory, detail: candidate.detail, ...spec },
        frame.frameIndex,
      );
      const sha256 = createHash("sha256").update(frame.bytes).digest("hex");
      const content: ModelContent = {
        kind: "image",
        sourceId: candidate.mediaId,
        revision: ref.revision,
        mimeType: frame.mimeType,
        sha256,
        width: frame.width,
        height: frame.height,
        ...(frame.frameIndex === null ? {} : { frameIndex: frame.frameIndex }),
      };
      images.push({
        mediaId: candidate.mediaId,
        messageIds: candidate.messageIds,
        category: effectiveCategory,
        categorySource: effectiveCategorySource,
        sha256,
        mimeType: frame.mimeType,
        width: frame.width,
        height: frame.height,
        frameIndex: frame.frameIndex,
        content,
        sources: [ref],
        variantId: variantRow.id,
        variantPolicy: policy,
        assetId,
      });
    }
    return { images, source: ref, unreadable: false };
  }

  /** native 路径：按自动范围逐行准备，投影回既有 QqMediaProjection（行为逐字不变）。 */
  async function prepareNative(
    input: QqMediaProjectionInput,
    owner: RunOwner,
  ): Promise<QqMediaProjection> {
    const selection = select(input);
    const images: QqPreparedMediaImage[] = [];
    const sources: SourceRef[] = [];
    const scopeIdentity = scopeIdentityOf(input.scope);
    // 窄捕获（unsupported_animation）本轮命中的媒体：图存在但不可读；asset 原始字节缓存照常，ref 不作为消费证明外泄。
    const omissions: QqMediaOmission[] = [];
    for (const candidate of selection.selected) {
      input.signal.throwIfAborted();
      input.assertCurrent();
      verifyScope(input.scope, owner);
      const prepared = await prepareNativeCandidate(input, owner, candidate, scopeIdentity);
      images.push(...prepared.images);
      if (prepared.source === null) {
        // §7.5：该图仍在 facts/selected 里，窗口文字不受影响；其他 prepared 成功的图照常发送。
        if (prepared.unreadable !== true) {
          fail("CONTEXT_SOURCE_INVALID", "媒体准备缺少来源引用");
        }
        for (const messageId of candidate.messageIds) {
          omissions.push({ mediaId: candidate.mediaId, messageId, reason: "unreadable" });
        }
        continue;
      }
      sources.push(prepared.source);
    }
    // 最后一张候选返回前同样末次复验：循环内的逐候选验不覆盖「最后一张之后」的窗口。
    input.signal.throwIfAborted();
    verifyScope(input.scope, owner);
    input.assertCurrent();
    return {
      phase: input.phase,
      requestedMode: input.settings.mode,
      actualMode: "native",
      images,
      notes: [],
      omissions: [...selection.omissions, ...omissions],
      sources,
    };
  }

  function baseChecks(input: QqMediaProjectionInput, owner: RunOwner): "disabled" | null {
    input.signal.throwIfAborted();
    input.assertCurrent();
    verifyScope(input.scope, owner);
    if (input.capabilityEnabled === false) return "disabled";
    return null;
  }

  /** capability 关闭的全零投影（§9）：无画面、无描述、无 fetch/codec/describe/register。 */
  function capabilityDisabledProjection(input: QqMediaProjectionInput): QqMediaProjection {
    const selection = selectQqMediaCandidates({
      facts: input.facts,
      replies: input.replies,
      focus: { responseMessageIds: input.focus.responseMessageIds },
      settings: input.settings,
      phase: input.phase,
      capabilityEnabled: false,
      detailMediaIds: input.detailMediaIds ?? DEFAULT_DETAIL_MEDIA_IDS,
      now: input.now,
    });
    return {
      phase: input.phase,
      requestedMode: input.settings.mode,
      actualMode: "disabled",
      images: [],
      notes: [],
      omissions: selection.omissions,
      sources: [],
    };
  }

  /** stage 关闭的全零投影（§7.1）：仅本阶段自动图关闭，按需读取与工具不在这里禁。 */
  function stageDisabledProjection(input: QqMediaProjectionInput): QqMediaProjection {
    const selection = selectQqMediaCandidates({
      facts: input.facts,
      replies: input.replies,
      focus: { responseMessageIds: input.focus.responseMessageIds },
      settings: input.settings,
      phase: input.phase,
      capabilityEnabled: true,
      detailMediaIds: input.detailMediaIds ?? DEFAULT_DETAIL_MEDIA_IDS,
      now: input.now,
    });
    return {
      phase: input.phase,
      requestedMode: input.settings.mode,
      actualMode: "disabled",
      images: [],
      notes: [],
      omissions: selection.omissions,
      sources: [],
    };
  }

  /**
   * 按需读取一个已披露 mediaId（计划 T08 Step8 / 规格 §7.5/§8.2/§9/§12）。
   *
   * 授权分层清晰：披露、作用域、过期由工具边界先验（`media.list` 只披露本 run 本
   * scope 的行），本服务再对这一行**独立复验**（`verifyScope` + ownerScope + 媒体行
   * 存在/未过期），任何一项不过就 fail closed，绝不猜、绝不跨 scope、绝不为别的行写缓存。
   * detail 锚在每个读边界与每个写事务内复验，body 变了就按 authority 失败穿透。
   */
  async function prepareByMediaId(input: QqMediaOnDemandInput): Promise<QqMediaOnDemandResult> {
    const owner = input.owner ?? deriveOwner(input.scope);
    input.signal.throwIfAborted();
    input.assertCurrent();
    verifyScope(input.scope, owner);
    // §9 能力关闭必全拒：连 fetch/codec/登记都不发生。阶段关闭**不**在这里禁——阶段只
    // 关闭本阶段的自动图（§7.1）；是否把画面送进下一次调用由宿主按阶段设置与能力守卫
    // 决定，本服务只准备资源。
    if (input.capabilityEnabled === false) {
      fail("CONTEXT_SOURCE_INVALID", "媒体能力已关闭，不存在按需读取");
    }
    const mediaId = input.mediaId.trim();
    if (mediaId.length === 0) fail("CONTEXT_SOURCE_INVALID", "按需读取缺少媒体标识");
    if (input.detail !== undefined) {
      if (
        input.detail.questionKey.trim().length === 0 ||
        input.detail.eventKey.trim().length === 0
      ) {
        fail("CONTEXT_SOURCE_INVALID", "明确细问缺少真实问题身份");
      }
    }
    const row = orm
      .select()
      .from(schema.qqMediaNotes)
      .where(eq(schema.qqMediaNotes.id, mediaId))
      .get();
    if (!row) fail("MEMORY_SOURCE_INVALID", "媒体行不存在，拒绝准备");
    if (Date.parse(row.expiresAt) <= Date.parse(input.now)) {
      fail("CONTEXT_SOURCE_INVALID", "媒体来源已过期，拒绝准备");
    }
    // 按需读取不重跑自动范围选择：只处理这一个已披露 mediaId。分类证据与 messageIds
    // 关系来自事实里同一 mediaId 的 image part；事实里没有该 mediaId 的 part 时，
    // category 保守按 unknown（不猜 platform），messageIds 为空（不造关系）。
    const occurrences = input.facts
      .filter((fact) =>
        fact.parts.some((part) => part.kind === "image" && part.mediaId === mediaId),
      )
      .map((fact) => fact.id)
      .sort();
    let declaredCategory: QqImageCategory = "unknown";
    for (const fact of input.facts) {
      for (const part of fact.parts) {
        if (part.kind === "image" && part.mediaId === mediaId) {
          if (declaredCategory === "unknown" && part.category !== "unknown") {
            declaredCategory = part.category;
          }
        }
      }
    }
    const candidate: QqSelectedMediaCandidate = {
      mediaId,
      category: declaredCategory,
      messageIds: occurrences,
      detail: input.detail !== undefined,
    };
    const prepared = await prepareNativeCandidate(
      { ...input, phase: input.phase, settings: input.settings } as QqMediaProjectionInput,
      owner,
      candidate,
      scopeIdentityOf(input.scope),
      input.detail,
    );
    // 按需读取保留硬拒（§7.5）：工具路径不把「不可读」伪装成成功空结果——unsupported
    // animation 在工具侧仍按原错误路径拒绝，由模型显式得到失败，而不是拿到空 images。
    if (prepared.source === null) {
      if (prepared.unreadable === true) {
        fail("CONTEXT_SOURCE_INVALID", "该媒体为宿主无法采样的动画容器，按需读取拒绝");
      }
      fail("CONTEXT_SOURCE_INVALID", "媒体准备缺少来源引用");
    }
    const first = prepared.images[0];
    return {
      mediaId,
      category: first?.category ?? declaredCategory,
      categorySource: first?.categorySource ?? "unknown",
      detail: candidate.detail,
      messageIds: candidate.messageIds,
      images: prepared.images,
      sources: [prepared.source],
    };
  }

  const service: QqMediaInputService = {
    async prepareQqMediaProjection(input): Promise<QqMediaProjection> {
      const owner = input.owner ?? deriveOwner(input.scope);
      if (baseChecks(input, owner) === "disabled") {
        return capabilityDisabledProjection(input);
      }
      if (!input.settings.stages[input.phase]) {
        return stageDisabledProjection(input);
      }
      return input.settings.mode === "description"
        ? await describe(input, owner)
        : await prepareNative(input, owner);
    },

    async describeAfterUnsupported(input): Promise<QqMediaProjection> {
      const owner = input.owner ?? deriveOwner(input.scope);
      if (baseChecks(input, owner) === "disabled") {
        fail("CONTEXT_SOURCE_INVALID", "媒体能力已关闭，不存在原生回退");
      }
      // #4：fallback 遵同 stage 关闭——本阶段自动图关闭时同样全零，不借 fallback 描述。
      if (!input.settings.stages[input.phase]) {
        return stageDisabledProjection(input);
      }
      const projection = await describe(input, owner);
      return { ...projection, requestedMode: "native" };
    },

    async prepareByMediaId(input): Promise<QqMediaOnDemandResult> {
      return prepareByMediaId(input);
    },
  };

  return service;
}
