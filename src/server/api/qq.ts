// QQ routes (ADR0018 P5a/P5b). Mounted under `/qq`.
//
// Three resources: schemes (identity plus the four speech switches), the surface settings
// (global switch, account, transport credentials) and bindings (which conversation belongs
// to which assistant and scheme). Every row is mapped back through the contract on the way
// out, so a row whose stored columns are not a valid combination surfaces as a fault rather
// than as a configuration with odd values.
//
// Two rules live in the database and are only explained here: deleting a scheme a binding
// names is refused by a trigger, and a conversation has at most one binding. Both are turned
// into messages that say what to do instead.
//
// Sharing is accepted only for the explicitly configured owner's private conversation.

import { Hono } from "hono";
import {
  CreateQqBindingRequestSchema,
  CreateQqSchemeRequestSchema,
  CreateQqStickerCollectionRequestSchema,
  type QqBindingResponse,
  QqMemoryOrganiseResponseSchema,
  type QqOwnerResponse,
  type QqSchemeResponse,
  QqSchemeResponseSchema,
  type QqSettingsResponse,
  QqStatusResponseSchema,
  QqStickerAnnotationResponseSchema,
  QqStickerAssetResponseSchema,
  QqStickerBulkRequestSchema,
  QqStickerBulkResponseSchema,
  QqStickerCollectionImpactResponseSchema,
  type QqStickerCollectionResponse,
  QqStickerCollectionResponseSchema,
  QqStickerImpactResponseSchema,
  QqStickerImportResponseSchema,
  QqStorageCleanupResponseSchema,
  QqStorageUsageResponseSchema,
  ReplaceQqStickerCollectionsRequestSchema,
  SetQqStickerEnabledRequestSchema,
  UpdateQqBindingRequestSchema,
  UpdateQqOwnerRequestSchema,
  UpdateQqSchemeRequestSchema,
  UpdateQqSettingsRequestSchema,
  UpdateQqStickerCollectionRequestSchema,
  UpdateQqStickerRequestSchema,
  UpdateQqTransportRequestSchema,
} from "../../shared/contracts/qq";
import { readOrganizationSettings } from "../db/organization-repository";
import {
  insertQqBinding,
  readQqBinding,
  readQqBindings,
  saveQqBinding,
} from "../db/qq-binding-repository";
import { observedQqConversations, pendingObservationCount } from "../db/qq-observation-repository";
import { readQqOwnerIdentity, saveQqOwnerIdentity } from "../db/qq-owner-repository";
import {
  createQqScheme,
  deleteQqScheme,
  type QqSchemeRow,
  qqSchemeUsage,
  readQqScheme,
  readQqSchemes,
  schemeContext,
  schemeOutputReserve,
  schemePrompts,
  schemeReply,
  schemeRhythm,
  schemeStickerCollectionIds,
  schemeStickers,
  schemeTriggers,
  updateQqScheme,
} from "../db/qq-scheme-repository";
import {
  readQqSettings,
  readQqTransportConfigView,
  updateQqSettings,
  updateQqTransportConfig,
} from "../db/qq-settings-repository";
import {
  bulkUpdateQqStickers,
  createQqStickerCollection,
  editQqSticker,
  listQqStickerAssets,
  listQqStickerCollections,
  type QqStickerAssetView,
  type QqStickerCollectionView,
  qqStickerAssetImpact,
  qqStickerCollectionImpact,
  readQqStickerAsset,
  readQqStickerCollection,
  replaceQqStickerCollections,
  setQqStickerEnabled,
  updateQqStickerCollection,
} from "../db/qq-sticker-repository";
import { qqStorageCleanup, qqStorageUsage } from "../db/qq-storage-repository";
import { getAgentRow, newId, type Orm } from "../db/repositories";
import { fail } from "../errors";
import type { ModelGateway } from "../llm/model-gateway";
import { normalizeOneBotAccountId } from "../services/onebot-protocol";
import { sampleQqAnimationFrames } from "../services/qq-animation-frames";
import {
  createQqBinding,
  createQqOwnerIdentity,
  type QqBinding,
  type QqOwnerIdentity,
  qqConversationScope,
  updateQqBinding,
  updateQqOwnerIdentity,
} from "../services/qq-binding-contract";
import { QQ_STICKER_CONTENT_TYPES, readQqImageHeader } from "../services/qq-image-header";
import { organiseQqMemoryNow } from "../services/qq-memory-enqueue";
import { annotateQqSticker, type QqStickerAnnotator } from "../services/qq-sticker-annotation";
import { importQqStickerCopy } from "../services/qq-sticker-import";
import { DEFAULT_QQ_STICKER_DIRECTORY, QqStickerStore } from "../services/qq-sticker-store";
import { parseBody, parseUuidParam, readJsonBody, validationFailed } from "./validation";

/** Wire shape of the QQ-global scheme and its confirmed editable groups. */
function toSchemeResponse(orm: Orm, row: QqSchemeRow): QqSchemeResponse {
  return QqSchemeResponseSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    triggers: schemeTriggers(row),
    rhythm: schemeRhythm(row),
    context: schemeContext(row),
    output_reserve: schemeOutputReserve(row),
    stickers: schemeStickers(row),
    sticker_collections: { collection_ids: schemeStickerCollectionIds(orm, row.id) },
    prompts: schemePrompts(row),
    reply: schemeReply(row),
    revision: row.revision,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}

function toStickerResponse(row: QqStickerAssetView) {
  return QqStickerAssetResponseSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    description_draft: row.descriptionDraft,
    tags: row.tags,
    tags_draft: row.tagsDraft,
    usage_note: row.usageNote,
    media_type: row.mediaType,
    byte_size: row.byteSize,
    width: row.width,
    height: row.height,
    enabled: row.enabled,
    collection_ids: row.collectionIds,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}

/** The token itself never appears here — only whether a usable one is stored. */
function toSettingsResponse(orm: Orm, keyPath?: string): QqSettingsResponse {
  const row = readQqSettings(orm);
  const transport = readQqTransportConfigView(orm, keyPath);
  return {
    enabled: row.enabled === 1,
    account_id: row.accountId,
    judgement_model_name: row.judgementModelName,
    transport: { endpoint: transport.endpoint, has_token: transport.hasToken },
    revision: row.revision,
  };
}

/**
 * The wire shape of a binding, plus the one derived number the page needs to make the memory
 * entry usable: how many observations of this conversation are readable and not yet offered to
 * consolidation (用户 2026-09-25 — without it neither "还差几条" nor "立即整理有没有东西可整理"
 * can be answered by the page).
 */
function toBindingResponse(orm: Orm, binding: QqBinding): QqBindingResponse {
  return {
    id: binding.id,
    account_id: binding.accountId,
    kind: binding.kind,
    peer_id: binding.peerId,
    agent_id: binding.agentId,
    scheme_id: binding.schemeId,
    paused: binding.paused,
    share_web_memory: binding.shareWebMemory,
    memory_batch_size: binding.memoryBatchSize,
    pending_observations: pendingObservationCount(orm, qqConversationScope(binding)),
    triggers: binding.triggers,
    attention: binding.attention,
    revision: binding.revision,
    authority_revision: binding.authorityRevision,
  };
}

/** A QQ account id the transport would accept, or a validation failure. */
function requireAccountId(value: string): string {
  const accountId = normalizeOneBotAccountId(value);
  if (accountId === null) throw validationFailed();
  return accountId;
}

function requireScheme(orm: Orm, schemeId: string): void {
  if (readQqScheme(orm, schemeId) === null) fail("MEMORY_NOT_FOUND", "方案不存在", 404);
}

/** A binding names an assistant that has to exist; the column's foreign key enforces it too. */
function requireAgent(orm: Orm, agentId: string): void {
  if (getAgentRow(orm, agentId) === null) fail("AGENT_NOT_FOUND", "助手不存在", 404);
}

/** Who the user is, or an explicit "not yet configured" — never a guess. */
function toOwnerResponse(orm: Orm): QqOwnerResponse {
  const owner = readQqOwnerIdentity(orm);
  return {
    configured: owner !== null,
    account_id: owner?.accountId ?? readQqSettings(orm).accountId,
    peer_id: owner?.peerId ?? null,
    revision: owner?.revision ?? null,
  };
}

/**
 * The contract's two sharing refusals, said in terms of what to do about them. Both are
 * conflicts rather than validation failures: the request was well formed, the surrounding
 * state just does not allow it yet.
 */
function failSharingDenied(reason: "private_only" | "owner_identity_required"): never {
  return reason === "private_only"
    ? fail("MEMORY_SOURCE_INVALID", "只有本人私聊才能共享网页长期记忆")
    : fail("MEMORY_SOURCE_INVALID", "请先确认本人身份，再开启共享");
}

/** The owner identity a binding write must be judged against. */
function ownerFor(orm: Orm): QqOwnerIdentity | null {
  return readQqOwnerIdentity(orm);
}

export interface QqRoutesOptions {
  /**
   * The live transport state, supplied by whoever owns the runtime. Omitted means this process has
   * no transport at all (tests, or a host that never started one) and the status route says so.
   */
  connectionState?: () => { readonly phase: string; readonly reason?: string };
  /**
   * Key file for the stored transport token. Injectable so a test never touches the real one:
   * the default resolves inside the app's own state directory, which is not a test's to write.
   */
  transportKeyPath?: string;
  /**
   * Where imported sticker copies are written. Injectable for the same reason; the default is the
   * development private root, and an installation passes its own `userdata` path.
   */
  stickerDirectory?: string;
  /**
   * The multimodal transport, and the gateway whose capacity the annotation checks. Both are
   * always supplied by `createApp`: the transport exists (the vision client), and whether a
   * picture model is CONFIGURED is answered by the shared settings row, not by the wiring.
   */
  annotator: QqStickerAnnotator;
  gateway: Pick<ModelGateway, "loadedContextCapacity">;
}

/**
 * Hono's `c.body` takes an ArrayBuffer. A view's own buffer may be larger than the view, so the
 * exact range is copied rather than handing over `bytes.buffer`.
 */
function bodyBytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

/** The storage view's wire shape: snake_case on the wire, the module's names inside. */
function toStorageResponse(usage: ReturnType<typeof qqStorageUsage>) {
  return QqStorageUsageResponseSchema.parse({
    observations: {
      messages: usage.observations.messages,
      text: usage.observations.text,
      expired_text: usage.observations.expiredText,
    },
    speech: { records: usage.speech.records, text: usage.speech.text },
    sends: { attempts: usage.sends.attempts, parts: usage.sends.parts },
    nicknames: { current: usage.nicknames.current, expired: usage.nicknames.expired },
    stickers: usage.stickers,
    dispatch: usage.dispatch,
    media: usage.media,
    sweep: {
      tracked: usage.sweep.tracked,
      last_swept_at_seconds: usage.sweep.lastSweptAtSeconds,
      entries: usage.sweep.entries.map((row) => ({
        kind: row.conversationKind,
        peer_id: row.peerId,
        outcome: row.outcome,
        reason: row.reason,
        observed_at_seconds: row.observedAtSeconds,
        ready_at_seconds: row.readyAtSeconds,
        decided_at_seconds: row.decidedAtSeconds,
      })),
    },
    retention: { days: usage.retentionDays },
  });
}

/** One collection's wire shape; shared by the read and write routes so both answer identically. */
function toCollectionResponse(row: QqStickerCollectionView): QqStickerCollectionResponse {
  return QqStickerCollectionResponseSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    revision: row.revision,
    asset_count: row.assetCount,
  });
}

export function qqRoutes(orm: Orm, options: QqRoutesOptions): Hono {
  const router = new Hono();
  const keyPath = options.transportKeyPath;
  const stickerStore = () =>
    new QqStickerStore({ directory: options.stickerDirectory ?? DEFAULT_QQ_STICKER_DIRECTORY });

  // §11.1's 存储与诊断: what the QQ side keeps (counts only, no invented caches) and the one
  // cleanup entry, which removes expired rows on the windows the rest of the side already follows.
  router.get("/storage", (c) => c.json(toStorageResponse(qqStorageUsage(orm))));

  router.post("/storage/cleanup", (c) => {
    const removed = qqStorageCleanup(orm);
    return c.json(
      QqStorageCleanupResponseSchema.parse({
        observation_text: removed.observationText,
        media_notes: removed.mediaNotes,
        speech: removed.speech,
        sends: removed.sends,
        nicknames: removed.nicknames,
      }),
    );
  });

  router.get("/schemes", (c) =>
    c.json(readQqSchemes(orm).map((row) => toSchemeResponse(orm, row))),
  );

  router.post("/schemes", async (c) => {
    const body = parseBody(CreateQqSchemeRequestSchema, await readJsonBody(c.req.raw));
    return c.json(
      toSchemeResponse(
        orm,
        createQqScheme(orm, {
          ...body,
          outputReserve: body.output_reserve,
          stickers: body.stickers,
          stickerCollections: body.sticker_collections?.collection_ids,
        }),
      ),
      201,
    );
  });

  router.get("/schemes/:schemeId", (c) => {
    const schemeId = parseUuidParam(c.req.param("schemeId"));
    const row = readQqScheme(orm, schemeId);
    if (row === null) fail("MEMORY_NOT_FOUND", "方案不存在", 404);
    return c.json(toSchemeResponse(orm, row));
  });

  // Lets a settings surface explain why a delete is refused before it is attempted.
  router.get("/schemes/:schemeId/usage", (c) => {
    const schemeId = parseUuidParam(c.req.param("schemeId"));
    if (readQqScheme(orm, schemeId) === null) fail("MEMORY_NOT_FOUND", "方案不存在", 404);
    return c.json({ scheme_id: schemeId, bindings: qqSchemeUsage(orm, schemeId) });
  });

  router.put("/schemes/:schemeId", async (c) => {
    const schemeId = parseUuidParam(c.req.param("schemeId"));
    const body = parseBody(UpdateQqSchemeRequestSchema, await readJsonBody(c.req.raw));
    const row = readQqScheme(orm, schemeId);
    if (row === null) fail("MEMORY_NOT_FOUND", "方案不存在", 404);
    return c.json(
      toSchemeResponse(
        orm,
        updateQqScheme(orm, schemeId, {
          name: body.name,
          description: body.description,
          triggers: body.triggers,
          rhythm: body.rhythm,
          context: body.context,
          outputReserve: body.output_reserve,
          stickers: body.stickers,
          stickerCollections: body.sticker_collections?.collection_ids,
          prompts: body.prompts,
          reply: body.reply,
          expectedRevision: body.expected_revision,
        }),
      ),
    );
  });

  router.delete("/schemes/:schemeId", (c) => {
    const schemeId = parseUuidParam(c.req.param("schemeId"));
    deleteQqScheme(orm, schemeId);
    return c.body(null, 204);
  });

  // §9.2's management surface. Writes are limited to what §9.1 decided: create/rename a
  // collection, import a file (always disabled), describe and enable an asset, and set which
  // collections hold it. No delete, no replacement and no duplicate handling — U11.
  router.post("/sticker-collections", async (c) => {
    const body = parseBody(CreateQqStickerCollectionRequestSchema, await readJsonBody(c.req.raw));
    return c.json(toCollectionResponse(createQqStickerCollection(orm, body)), 201);
  });

  router.put("/sticker-collections/:collectionId", async (c) => {
    const collectionId = parseUuidParam(c.req.param("collectionId"));
    const body = parseBody(UpdateQqStickerCollectionRequestSchema, await readJsonBody(c.req.raw));
    return c.json(
      toCollectionResponse(
        updateQqStickerCollection(orm, collectionId, {
          name: body.name,
          description: body.description,
          expectedRevision: body.expected_revision,
        }),
      ),
    );
  });

  /**
   * §9.1's first step: the picked file becomes an app-owned copy and a DISABLED asset.
   *
   * A file the header reader refuses is answered with the verdict, not an error code: the request
   * was well-formed, and §9.2's surface has to say which of the four reasons applies. The copy
   * store is created per call and its directory is the routes' own option, so a test never writes
   * into the app's real data area.
   */
  router.post("/stickers/import", async (c) => {
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw validationFailed();
    }
    const file = form.get("file");
    const fields = [...form.keys()];
    if (
      !(file instanceof File) ||
      form.getAll("file").length !== 1 ||
      fields.some((key) => key !== "file" && key !== "name") ||
      form.getAll("name").length > 1
    ) {
      throw validationFailed();
    }
    const nameEntry = form.get("name");
    // A `name` that arrived as a second file part is not a name; the strict field list alone
    // would let it through and then hand a File to the store.
    if (nameEntry !== null && typeof nameEntry !== "string") throw validationFailed();
    const name = (nameEntry ?? file.name).trim();
    if (name === "" || name.length > 200) throw validationFailed();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = importQqStickerCopy({
      orm,
      store: stickerStore(),
      request: { bytes, name },
    });
    if (result.kind === "rejected") {
      return c.json(
        QqStickerImportResponseSchema.parse({ kind: "rejected", reason: result.reason }),
      );
    }
    return c.json(
      QqStickerImportResponseSchema.parse({
        kind: "imported",
        asset: toStickerResponse(result.asset),
      }),
      201,
    );
  });

  /**
   * §9.2's batch operations. Validate-then-execute: a batch that cannot be completed in full is
   * refused whole, naming the entry that stopped it, and a batch that passes touches every
   * selected asset in one transaction.
   */
  router.post("/stickers/bulk", async (c) => {
    const body = parseBody(QqStickerBulkRequestSchema, await readJsonBody(c.req.raw));
    const assets = bulkUpdateQqStickers(orm, {
      assetIds: body.asset_ids,
      addCollectionIds: body.add_collection_ids,
      removeCollectionIds: body.remove_collection_ids,
      tags: body.tags,
      enabled: body.enabled,
    });
    return c.json(QqStickerBulkResponseSchema.parse({ assets: assets.map(toStickerResponse) }));
  });

  /**
   * §9.2's 生成说明和标签: one picture call, two drafts, nothing else touched.
   *
   * The answer is a verdict, like the import's — "no picture model is configured" is a state the
   * surface explains (and links to 默认模型页), not a failed request.
   */
  router.post("/stickers/:stickerId/annotate", async (c) => {
    const stickerId = parseUuidParam(c.req.param("stickerId"));
    const settings = readOrganizationSettings(orm);
    const result = await annotateQqSticker(
      orm,
      options.gateway,
      options.annotator,
      stickerStore(),
      {
        assetId: stickerId,
        visionModel: settings.vision_model_name,
      },
    );
    if (result.kind === "rejected") {
      return c.json(
        QqStickerAnnotationResponseSchema.parse({ kind: "rejected", reason: result.reason }),
      );
    }
    return c.json(
      QqStickerAnnotationResponseSchema.parse({
        kind: "annotated",
        asset: toStickerResponse(result.asset),
      }),
    );
  });

  /** §9.2's "保存整理": content only. Enablement has its own action, so this cannot switch it on. */
  router.patch("/stickers/:stickerId", async (c) => {
    const stickerId = parseUuidParam(c.req.param("stickerId"));
    const body = parseBody(UpdateQqStickerRequestSchema, await readJsonBody(c.req.raw));
    return c.json(
      toStickerResponse(
        editQqSticker(orm, stickerId, {
          name: body.name,
          description: body.description,
          tags: body.tags,
          usageNote: body.usage_note,
        }),
      ),
    );
  });

  /** §9.1: enabling is what makes an asset selectable; disabling also stops an unsubmitted send. */
  router.put("/stickers/:stickerId/enabled", async (c) => {
    const stickerId = parseUuidParam(c.req.param("stickerId"));
    const body = parseBody(SetQqStickerEnabledRequestSchema, await readJsonBody(c.req.raw));
    return c.json(toStickerResponse(setQqStickerEnabled(orm, stickerId, body.enabled)));
  });

  router.put("/stickers/:stickerId/collections", async (c) => {
    const stickerId = parseUuidParam(c.req.param("stickerId"));
    const body = parseBody(ReplaceQqStickerCollectionsRequestSchema, await readJsonBody(c.req.raw));
    return c.json(
      toStickerResponse(replaceQqStickerCollections(orm, stickerId, body.collection_ids)),
    );
  });

  // §9.2 read-only inventory. No original path, copy name or bytes are exposed here.
  router.get("/sticker-collections", (c) =>
    c.json(listQqStickerCollections(orm).map((row) => toCollectionResponse(row))),
  );
  router.get("/sticker-collections/:collectionId/impact", (c) => {
    const id = parseUuidParam(c.req.param("collectionId"));
    if (readQqStickerCollection(orm, id) === null) {
      fail("MEMORY_NOT_FOUND", "素材集合不存在", 404);
    }
    const impact = qqStickerCollectionImpact(orm, [id]);
    return c.json(
      QqStickerCollectionImpactResponseSchema.parse({
        collection_ids: impact.collectionIds,
        schemes: impact.schemes.map((scheme) => ({
          id: scheme.id,
          name: scheme.name,
          collection_ids: scheme.collectionIds,
        })),
        bindings: impact.bindings.map((binding) => ({
          scheme_id: binding.schemeId,
          account_id: binding.accountId,
          conversation_kind: binding.conversationKind,
          peer_id: binding.peerId,
          paused: binding.paused,
        })),
      }),
    );
  });
  router.get("/stickers", (c) => c.json(listQqStickerAssets(orm).map(toStickerResponse)));
  router.get("/stickers/:stickerId", (c) => {
    const id = parseUuidParam(c.req.param("stickerId"));
    const row = readQqStickerAsset(orm, id);
    if (row === null) fail("MEMORY_NOT_FOUND", "素材不存在", 404);
    return c.json(toStickerResponse(row));
  });
  /**
   * §9.2's preview — the library's one byte exit, added deliberately (P5g).
   *
   * A management surface that cannot show the picture cannot be used to review one, so the copy
   * is served here. What it does NOT do is name the file: the asset id is the address, the store
   * resolves the copy inside its own directory, and neither the file name nor the path appears in
   * any response. `?still=1` answers with the FIRST FRAME as a PNG for an animation, which is
   * what "列表用静态预览、点开播放" needs — otherwise a list of GIFs animates all at once.
   */
  router.get("/stickers/:stickerId/preview", (c) => {
    const stickerId = parseUuidParam(c.req.param("stickerId"));
    const asset = readQqStickerAsset(orm, stickerId);
    if (asset === null) fail("MEMORY_NOT_FOUND", "素材不存在", 404);
    let bytes: Uint8Array;
    try {
      bytes = stickerStore().readCopy(asset.fileName);
    } catch {
      // The row exists but its copy does not read; the surface shows "file unavailable" for this.
      fail("MEMORY_NOT_FOUND", "素材文件不可读", 404);
    }
    if (c.req.query("still") === "1" && asset.mediaType === "animation") {
      const sample = sampleQqAnimationFrames(bytes, {
        frames: 1,
        maxDimension: 512,
        budgetTokens: 1,
      });
      const first = sample.kind === "sampled" ? sample.frames[0] : undefined;
      if (first !== undefined) {
        return c.body(bodyBytes(first.png), 200, {
          "content-type": "image/png",
          "cache-control": "no-store",
        });
      }
    }
    const header = readQqImageHeader(bytes);
    return c.body(bodyBytes(bytes), 200, {
      "content-type":
        header.kind === "read"
          ? QQ_STICKER_CONTENT_TYPES[header.format]
          : "application/octet-stream",
      "cache-control": "no-store",
    });
  });

  router.get("/stickers/:stickerId/impact", (c) => {
    const id = parseUuidParam(c.req.param("stickerId"));
    const impact = qqStickerAssetImpact(orm, id);
    if (impact === null) fail("MEMORY_NOT_FOUND", "素材不存在", 404);
    return c.json(
      QqStickerImpactResponseSchema.parse({
        asset_id: impact.assetId,
        collection_ids: impact.collectionIds,
        schemes: impact.schemes.map((scheme) => ({
          id: scheme.id,
          name: scheme.name,
          collection_ids: scheme.collectionIds,
        })),
        bindings: impact.bindings.map((binding) => ({
          scheme_id: binding.schemeId,
          account_id: binding.accountId,
          conversation_kind: binding.conversationKind,
          peer_id: binding.peerId,
          paused: binding.paused,
        })),
      }),
    );
  });

  // ---- transport status (P5q) ----
  //
  // Read-only and credential-free: what the page needs to say "已连接／未连接" instead of
  // guessing from a saved endpoint.
  router.get("/status", (c) => {
    const state = options.connectionState?.();
    return c.json(
      QqStatusResponseSchema.parse({
        connection: state
          ? { phase: state.phase, reason: state.reason ?? null }
          : { phase: "unavailable", reason: null },
      }),
    );
  });

  // ---- surface settings ----
  router.get("/settings", (c) => c.json(toSettingsResponse(orm, keyPath)));

  router.put("/settings", async (c) => {
    const payload = parseBody(UpdateQqSettingsRequestSchema, await readJsonBody(c.req.raw));
    updateQqSettings(orm, {
      enabled: payload.enabled,
      accountId:
        payload.account_id === undefined
          ? undefined
          : payload.account_id === null
            ? null
            : requireAccountId(payload.account_id),
      judgementModelName: payload.judgement_model_name,
      expectedRevision: payload.expected_revision,
    });
    return c.json(toSettingsResponse(orm, keyPath));
  });

  router.put("/transport", async (c) => {
    const payload = parseBody(UpdateQqTransportRequestSchema, await readJsonBody(c.req.raw));
    updateQqTransportConfig(orm, {
      endpoint: payload.endpoint,
      token: payload.token,
      expectedRevision: payload.expected_revision,
      keyPath,
    });
    // The response carries `has_token`, never the token.
    return c.json(toSettingsResponse(orm, keyPath));
  });

  // ---- owner identity ----
  router.get("/owner", (c) => c.json(toOwnerResponse(orm)));

  router.put("/owner", async (c) => {
    const payload = parseBody(UpdateQqOwnerRequestSchema, await readJsonBody(c.req.raw));
    const settings = readQqSettings(orm);
    // An identity without an account would say "this person is me" about no account at all.
    if (!settings.accountId) fail("MEMORY_SOURCE_INVALID", "请先配置助手账号，再确认本人身份");
    const current = readQqOwnerIdentity(orm);
    if (
      current !== null &&
      payload.expected_revision !== undefined &&
      current.revision !== payload.expected_revision
    ) {
      fail("MEMORY_STATE_CONFLICT", "本人身份已变化，请重新加载后保存");
    }
    const base = current ?? createQqOwnerIdentity(settings.accountId);
    const result = updateQqOwnerIdentity(base, requireAccountId(payload.peer_id), base.revision);
    if (result.kind === "conflict")
      fail("MEMORY_STATE_CONFLICT", "本人身份已变化，请重新加载后保存");
    saveQqOwnerIdentity(orm, result.owner);
    return c.json(toOwnerResponse(orm));
  });

  // ---- observed conversations ----
  router.get("/conversations", (c) =>
    c.json(
      observedQqConversations(orm).map((conversation) => ({
        account_id: conversation.accountId,
        kind: conversation.kind,
        peer_id: conversation.peerId,
        messages: conversation.messages,
        last_at_seconds: conversation.lastAtSeconds,
        binding_id: conversation.bindingId,
      })),
    ),
  );

  // ---- bindings ----
  router.get("/bindings", (c) =>
    c.json(readQqBindings(orm).map((row) => toBindingResponse(orm, row))),
  );

  router.post("/bindings", async (c) => {
    const payload = parseBody(CreateQqBindingRequestSchema, await readJsonBody(c.req.raw));
    requireAgent(orm, payload.agent_id);
    requireScheme(orm, payload.scheme_id);
    const created = createQqBinding(
      {
        id: newId(),
        accountId: requireAccountId(payload.account_id),
        kind: payload.kind,
        peerId: requireAccountId(payload.peer_id),
        agentId: payload.agent_id,
        schemeId: payload.scheme_id,
        paused: payload.paused,
        memoryBatchSize: payload.memory_batch_size,
        triggers: payload.triggers,
        attention: payload.attention,
        shareWebMemory: payload.share_web_memory,
      },
      ownerFor(orm),
    );
    if (created.kind === "denied") failSharingDenied(created.reason);
    if (created.kind !== "saved") fail("MEMORY_SOURCE_INVALID", "该绑定请求不被接受");
    return c.json(toBindingResponse(orm, insertQqBinding(orm, created.binding)), 201);
  });

  router.put("/bindings/:bindingId", async (c) => {
    const bindingId = parseUuidParam(c.req.param("bindingId"));
    const payload = parseBody(UpdateQqBindingRequestSchema, await readJsonBody(c.req.raw));
    const current = readQqBinding(orm, bindingId);
    if (current === null) fail("MEMORY_NOT_FOUND", "QQ绑定不存在", 404);
    if (payload.agent_id !== undefined) requireAgent(orm, payload.agent_id);
    if (payload.scheme_id !== undefined) requireScheme(orm, payload.scheme_id);
    const patch: Record<string, unknown> = {};
    if (payload.agent_id !== undefined) patch.agentId = payload.agent_id;
    if (payload.scheme_id !== undefined) patch.schemeId = payload.scheme_id;
    if (payload.paused !== undefined) patch.paused = payload.paused;
    if (payload.share_web_memory !== undefined) patch.shareWebMemory = payload.share_web_memory;
    // `null` is a meaningful value here ("automatic organising off"), so it must stay a
    // present key instead of collapsing into "not provided".
    if (payload.memory_batch_size !== undefined) patch.memoryBatchSize = payload.memory_batch_size;
    if (payload.triggers !== undefined) patch.triggers = payload.triggers;
    if (payload.attention !== undefined) patch.attention = payload.attention;
    const result = updateQqBinding(current, patch, payload.expected_revision, ownerFor(orm));
    if (result.kind === "conflict") {
      fail("MEMORY_STATE_CONFLICT", "QQ绑定已变化，请重新加载后保存");
    }
    if (result.kind === "denied") failSharingDenied(result.reason);
    return c.json(
      toBindingResponse(
        orm,
        saveQqBinding(orm, {
          binding: result.binding,
          expectedRevision: payload.expected_revision,
        }),
      ),
    );
  });

  /**
   * 「立即整理」(用户 2026-09-25): organise this conversation's readable observations now, ignoring
   * the configured count — pressing the button IS the decision to spend a model call, so the pacing
   * setting must not veto it.
   *
   * A policy refusal is a verdict, not an error (see `QqMemoryOrganiseResponseSchema`); only a
   * binding that does not exist is a 404. The verdict carries the job id when something was queued,
   * so the job can be watched on the memory page's 整理任务 list.
   */
  router.post("/bindings/:bindingId/memory", (c) => {
    const bindingId = parseUuidParam(c.req.param("bindingId"));
    const binding = readQqBinding(orm, bindingId);
    if (binding === null) fail("MEMORY_NOT_FOUND", "QQ绑定不存在", 404);
    const outcome = organiseQqMemoryNow(orm, binding);
    return c.json(
      QqMemoryOrganiseResponseSchema.parse({
        status: outcome.status,
        job_id: outcome.jobId,
        pending: outcome.pending,
      }),
    );
  });

  return router;
}
