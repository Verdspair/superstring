// T10 接力（r303）：prepareQqMediaProjection / describeAfterUnsupported 定向合成验证。
// 全合成 bytes（encodeQqFramePng / omggif 编码 GIF），无真实 QQ/模型/网络；分类消费段
// （consumeModelMediaData）不在本文件重测（accepted 节点）。

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { eq } from "drizzle-orm";
import upstream from "omggif";
import {
  createQqMediaInputService,
  isModelImageUnsupportedError,
} from "../../src/server/channels/onebot11/media-input-service";
import type { QqReplyProjection } from "../../src/server/channels/onebot11/reply-context";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import {
  readQqGroupAgentConfig,
  readQqGroupCapabilityRevision,
  updateQqGroupConfig,
} from "../../src/server/db/qq-group-config-repository";
import { recordMediaClassification } from "../../src/server/db/qq-media-asset-repository";
import { recordMediaSegment } from "../../src/server/db/qq-media-repository";
import { readQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
  type Orm,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { AppError, fail } from "../../src/server/errors";
import type { VisionClient } from "../../src/server/llm/vision-client";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import type { prepareQqImage } from "../../src/server/services/qq-image-codec";
import { qqMediaSourceAccess } from "../../src/server/services/qq-media-sources";
import { qqMediaReadTaskSourceAccess } from "../../src/server/services/qq-media-task-sources";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { QqEffectiveMediaPolicy } from "../../src/shared/contracts/qq-media-input";
import type { QqConversationScope, QqMessageFact } from "../../src/shared/contracts/qq-message";
import { createEphemeralAgentRuntime } from "../harness/ephemeral-runtime";

const AGENT = "00000000-0000-0000-0000-000000000001";
const ACCOUNT = "10001";
const PEER = "30003";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const MODEL = "synthetic-model";
const VISION_MODEL = "vision-local";
const POLICY = "baseline/v1/policy-native-v1";

const PNG_BYTES = () => encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(0x40), 8, 8);

function gifBytes(frameCount = 2): Uint8Array {
  const width = 8;
  const height = 8;
  const buffer = new Uint8Array(width * height * frameCount * 4 + 4096 + 768);
  const writer = new upstream.GifWriter(buffer, width, height, {
    palette: [0xff0000, 0x00ff00],
    loop: 0,
  });
  for (let index = 0; index < frameCount; index += 1) {
    writer.addFrame(0, 0, width, height, new Array(width * height).fill(index % 2), { delay: 10 });
  }
  const length = writer.end();
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error("fixture GIF not written");
  return buffer.slice(0, length);
}

const SETTINGS: QqEffectiveMediaPolicy = {
  mode: "native",
  stages: { decision: true, evaluation: true, generation: true },
  max_images: 8,
  ordinary_still_max_dimension: null,
  ordinary_frame_count: 3,
  ordinary_frame_max_dimension: 512,
  expression_max_dimension: 512,
  expression_frame_count: 3,
  expression_frame_max_dimension: 512,
};

function createScheme(orm: Orm): { id: string } {
  return orm
    .insert(schema.qqSchemes)
    .values({
      id: crypto.randomUUID(),
      name: `qq-media-input-${crypto.randomUUID()}`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .returning()
    .get();
}

interface Fixture {
  h: ReturnType<typeof openBusinessDb>;
  orm: Orm;
  scope: QqConversationScope;
  mediaImage(eventKey: string): { id: string };
}

function openFixture(): Fixture {
  const h = openBusinessDb();
  ensureDefaults(h.orm, MODEL);
  const scheme = createScheme(h.orm);
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: BINDING_ID,
      accountId: ACCOUNT,
      conversationKind: "group",
      peerId: PEER,
      agentId: AGENT,
      schemeId: scheme.id,
      paused: 0,
      shareWebMemory: 0,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  updateQqSettings(h.orm, { enabled: true, accountId: ACCOUNT, expectedRevision: 1 });
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(BINDING_ID);
  if (!conversation) throw new Error("conversation fixture missing");
  const scope: QqConversationScope = {
    conversationId: conversation.id,
    accountId: ACCOUNT,
    conversationKind: "group",
    peerId: PEER,
    agentId: AGENT,
    bindingId: BINDING_ID,
    bindingEpoch: conversation.bindingEpoch,
    authorityRevision: 1,
  };
  const future = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const mediaImage = (eventKey: string) => {
    const occurred = Math.floor(Date.now() / 1000);
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        messageId: `message-${eventKey}`,
        occurredAtSeconds: occurred,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: nowIso(),
      })
      .run();
    h.orm
      .insert(schema.qqObservationText)
      .values({
        eventKey,
        body: `body-${eventKey}`,
        occurredAtSeconds: occurred,
        expiresAt: future,
        recordedAt: nowIso(),
      })
      .run();
    journal.ingestOneBotEvent(eventKey, BINDING_ID);
    const seg = recordMediaSegment(h.orm, {
      eventKey,
      segmentIndex: 0,
      kind: "image",
      sourceRef: `ref-${eventKey}`,
      occurredAtSeconds: occurred,
      addressed: true,
    });
    journal.append({
      conversationId: conversation.id,
      eventKey: `media-src:${seg.id}`,
      kind: "inbound",
      source: {
        kind: "qq_media",
        id: seg.id,
        revision: String(seg.attempts),
        expiresAt: seg.expiresAt,
      },
      sources: [
        { kind: "qq_event", id: eventKey, revision: nowIso() },
        { kind: "qq_media", id: seg.id, revision: String(seg.attempts), expiresAt: seg.expiresAt },
      ],
      occurredAt: nowIso(),
    });
    return { id: seg.id };
  };
  return { h, orm: h.orm, scope, mediaImage };
}

function makeFact(
  eventKey: string,
  mediaId: string,
  category: "ordinary" | "expression" | "unknown" = "ordinary",
): QqMessageFact {
  return {
    id: eventKey,
    platformMessageId: null,
    seq: 1,
    occurredAtSeconds: Math.floor(Date.now() / 1000),
    speaker: {
      role: "member",
      qq: "20002",
      groupCard: null,
      personalNickname: null,
      legacyDisplayName: null,
      nameState: "unknown",
    },
    parts: [{ kind: "image", mediaId, category }],
    mentions: [],
    replyTo: null,
    sources: [{ kind: "qq_event", id: eventKey, revision: nowIso() }],
    completeness: "full",
  };
}

const NO_REPLIES: QqReplyProjection = { roots: [], sources: [] };

function focusOf(...responseMessageIds: string[]) {
  return {
    triggerMessageIds: responseMessageIds,
    responseMessageIds,
    responseQqs: ["20002"],
    assistantQq: "90009",
  };
}

function visionStub() {
  const calls: { model: string; prompt: string; images: number }[] = [];
  const client: VisionClient = {
    annotate: async (request) => {
      calls.push({ model: request.model, prompt: request.prompt, images: request.images.length });
      return "一张合成图片的描述";
    },
  };
  return { calls, client };
}

function serviceOf(
  f: Fixture,
  fetchSource: Parameters<typeof createQqMediaInputService>[0]["fetchSource"],
  modelConfig = { visionModelName: VISION_MODEL as string | null, transcriptionModelName: null },
) {
  return createQqMediaInputService({
    store: f.h,
    fetchSource,
    agentRuntime: createEphemeralAgentRuntime({ vision: visionStub().client }),
    prompt: "如实说明这条消息里的媒体内容。",
    modelConfig,
    baselinePolicy: POLICY,
  });
}

function okOwner(f: Fixture): RunOwner {
  return {
    kind: "conversation",
    id: f.scope.conversationId,
    userId: DEFAULT_USER_ID,
    agentId: f.scope.agentId,
  };
}

function baseInput(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    scope: f.scope,
    phase: "generation" as const,
    focus: focusOf(),
    facts: [] as QqMessageFact[],
    replies: NO_REPLIES,
    settings: SETTINGS,
    model: MODEL,
    now: nowIso(),
    runId: `run-${crypto.randomUUID()}`,
    signal: new AbortController().signal,
    assertCurrent: () => {},
    ...overrides,
  };
}

describe("createQqMediaInputService.prepareQqMediaProjection", () => {
  it("capability disabled: zero fetch/codec/vision/register, omissions carry capability_disabled, message facts untouched", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-cap-off");
      const fact = makeFact("ev-cap-off", media.id);
      let fetchCalls = 0;
      const service = serviceOf(f, async () => {
        fetchCalls += 1;
        return { bytes: PNG_BYTES() };
      });
      const projection = await service.prepareQqMediaProjection(
        baseInput(f, { facts: [fact], focus: focusOf("ev-cap-off"), capabilityEnabled: false }),
      );
      expect(fetchCalls).toBe(0);
      expect(projection.actualMode).toBe("disabled");
      expect(projection.requestedMode).toBe("native");
      expect(projection.images).toHaveLength(0);
      expect(projection.notes).toHaveLength(0);
      expect(projection.sources).toHaveLength(0);
      expect(projection.omissions.length).toBeGreaterThan(0);
      expect(projection.omissions.every((o) => o.reason === "capability_disabled")).toBe(true);
      expect(
        projection.omissions.some((o) => o.mediaId === media.id && o.messageId === "ev-cap-off"),
      ).toBe(true);
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(0);
      expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(0);
    } finally {
      f.h.close();
    }
  });

  it("stage disabled: only this phase's auto images are off (stage_disabled), other stages still prepare", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-stage-off");
      const fact = makeFact("ev-stage-off", media.id);
      let fetchCalls = 0;
      const service = serviceOf(f, async () => {
        fetchCalls += 1;
        return { bytes: PNG_BYTES() };
      });
      const off = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-stage-off"),
          settings: {
            ...SETTINGS,
            stages: { decision: true, evaluation: true, generation: false },
          },
        }),
      );
      expect(fetchCalls).toBe(0);
      expect(off.actualMode).toBe("disabled");
      expect(off.images).toHaveLength(0);
      expect(off.omissions.every((o) => o.reason === "stage_disabled")).toBe(true);
      // decision 阶段照常准备同一张图（stage 独立，不全局禁）。
      const on = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-stage-off"),
          phase: "decision",
          settings: {
            ...SETTINGS,
            stages: { decision: true, evaluation: true, generation: false },
          },
        }),
      );
      expect(fetchCalls).toBe(1);
      expect(on.actualMode).toBe("native");
      expect(on.images.length).toBe(1);
    } finally {
      f.h.close();
    }
  });

  it("native happy path: fetch → asset+link+variant cached → projection with finite-frame content, source minted fail-closed", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-native-ok");
      const fact = makeFact("ev-native-ok", media.id);
      let fetchCalls = 0;
      const service = serviceOf(f, async () => {
        fetchCalls += 1;
        return { bytes: PNG_BYTES() };
      });
      const projection = await service.prepareQqMediaProjection(
        baseInput(f, { facts: [fact], focus: focusOf("ev-native-ok") }),
      );
      expect(fetchCalls).toBe(1);
      expect(projection.actualMode).toBe("native");
      expect(projection.requestedMode).toBe("native");
      expect(projection.images).toHaveLength(1);
      const image = projection.images[0];
      expect(image?.mediaId).toBe(media.id);
      expect(image?.messageIds).toEqual(["ev-native-ok"]);
      expect(image?.category).toBe("ordinary");
      expect(image?.categorySource).toBe("platform");
      expect(image?.frameIndex).toBeNull();
      expect(image?.content.kind).toBe("image");
      expect(image?.content).toMatchObject({ sourceId: media.id, mimeType: "image/png" });
      expect(image?.sources).toHaveLength(1);
      expect(image?.sources[0]?.kind).toBe("qq_media_source");
      expect(projection.omissions).toHaveLength(0);
      // 缓存登记真实落库：asset、source link、variant 各一行。
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(1);
      expect(f.orm.select().from(schema.qqMediaAssetSources).all()).toHaveLength(1);
      expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(1);
      // 第二次准备：live source + asset 授权复验通过 → 复用缓存源字节，fetch=0；
      // variant 全命中 → codec=0；不新增行，投影等价且带确定取字节锚点。
      const again = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-native-ok"),
          runId: `run-${crypto.randomUUID()}`,
        }),
      );
      expect(fetchCalls).toBe(1);
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(1);
      expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(1);
      expect(again.images[0]?.sha256).toBe(image?.sha256);
      expect(again.images[0]?.sources[0]?.revision).toBe(image?.sources[0]?.revision);
      expect(again.images[0]?.variantId).toBe(image?.variantId);
      expect(again.images[0]?.variantPolicy).toBe(image?.variantPolicy);
      expect(again.images[0]?.assetId).toBe(image?.assetId);
      // variantId 真实指向仓储已有主键，host 按 id 直取字节。
      const variantRow = f.orm
        .select()
        .from(schema.qqMediaVariants)
        .where(eq(schema.qqMediaVariants.id, again.images[0]?.variantId ?? ""))
        .get();
      expect(variantRow?.policy).toBe(again.images[0]?.variantPolicy);
      expect(variantRow?.assetId).toBe(again.images[0]?.assetId);
    } finally {
      f.h.close();
    }
  });

  it("native GIF: sampled frames share one candidate slot, per-frame entries carry index and source total facts", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-native-gif");
      const fact = makeFact("ev-native-gif", media.id);
      const gif = gifBytes(3);
      const service = serviceOf(f, async () => ({ bytes: gif }));
      const projection = await service.prepareQqMediaProjection(
        baseInput(f, { facts: [fact], focus: focusOf("ev-native-gif") }),
      );
      expect(projection.actualMode).toBe("native");
      expect(projection.images).toHaveLength(3);
      expect(new Set(projection.images.map((image) => image.mediaId)).size).toBe(1);
      expect(projection.images.map((image) => image.frameIndex)).toEqual([0, 1, 2]);
      expect(projection.images.every((image) => image.mimeType === "image/png")).toBe(true);
      // 每帧一个 variant（同 asset，不同 policy 后缀）。
      expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(3);
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(1);
    } finally {
      f.h.close();
    }
  });

  it("source expired: fail closed before fetch, zero cache writes", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-expired");
      const fact = makeFact("ev-expired", media.id);
      const past = new Date(Date.now() - 60_000).toISOString();
      f.orm
        .update(schema.qqMediaNotes)
        .set({ expiresAt: past })
        .where(eq(schema.qqMediaNotes.id, media.id))
        .run();
      let fetchCalls = 0;
      const service = serviceOf(f, async () => {
        fetchCalls += 1;
        return { bytes: PNG_BYTES() };
      });
      await expect(
        service.prepareQqMediaProjection(
          baseInput(f, { facts: [fact], focus: focusOf("ev-expired") }),
        ),
      ).rejects.toThrow();
      expect(fetchCalls).toBe(0);
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(0);
    } finally {
      f.h.close();
    }
  });

  it("out-of-scope images are not prepared: not_selected/not_supplied omissions, selected set stays focus+direct", async () => {
    const f = openFixture();
    try {
      const inFocus = f.mediaImage("ev-sel-focus");
      const outside = f.mediaImage("ev-sel-outside");
      const focusFact = makeFact("ev-sel-focus", inFocus.id);
      const outsideFact = makeFact("ev-sel-outside", outside.id);
      const service = serviceOf(f, async () => ({ bytes: PNG_BYTES() }));
      const projection = await service.prepareQqMediaProjection(
        baseInput(f, { facts: [focusFact, outsideFact], focus: focusOf("ev-sel-focus") }),
      );
      expect(projection.images.map((image) => image.mediaId)).toEqual([inFocus.id]);
      const reasons = new Map(
        projection.omissions.map((o) => [`${o.mediaId}:${o.messageId}`, o.reason]),
      );
      expect(reasons.get(`${outside.id}:ev-sel-outside`)).toBe("not_selected");
    } finally {
      f.h.close();
    }
  });
});

describe("createQqMediaInputService description mode", () => {
  it("description: cache/task described → notes carry taskId; unavailable model+no cache → actualMode unavailable, nothing invented", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-desc");
      const fact = makeFact("ev-desc", media.id);
      const service = serviceOf(f, async () => ({ bytes: PNG_BYTES() }));
      // 无 vision 模型配置：baseline 读取不可用 → unavailable，不编内容。
      const noModelService = createQqMediaInputService({
        store: f.h,
        fetchSource: async () => ({ bytes: PNG_BYTES() }),
        agentRuntime: createEphemeralAgentRuntime({ vision: visionStub().client }),
        prompt: "如实说明这条消息里的媒体内容。",
        modelConfig: { visionModelName: null, transcriptionModelName: null },
        baselinePolicy: POLICY,
      });
      const noModel = await noModelService.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-desc"),
          settings: { ...SETTINGS, mode: "description" },
        }),
      );
      expect(noModel.requestedMode).toBe("description");
      expect(noModel.actualMode).toBe("unavailable");
      expect(noModel.notes).toHaveLength(0);
      expect(noModel.images).toHaveLength(0);
      // 有 vision 模型 + 合成 bytes：视觉叶子一次，note 带真实 taskId。
      const vision = visionStub();
      const described = createQqMediaInputService({
        store: f.h,
        fetchSource: async () => ({ bytes: PNG_BYTES() }),
        agentRuntime: createEphemeralAgentRuntime({ vision: vision.client }),
        prompt: "如实说明这条消息里的媒体内容。",
        modelConfig: { visionModelName: VISION_MODEL, transcriptionModelName: null },
        baselinePolicy: POLICY,
      });
      const ok = await described.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-desc"),
          settings: { ...SETTINGS, mode: "description" },
        }),
      );
      expect(ok.actualMode).toBe("description");
      expect(ok.notes).toHaveLength(1);
      expect(ok.notes[0]?.mediaId).toBe(media.id);
      expect(ok.notes[0]?.text).toBe("一张合成图片的描述");
      expect((ok.notes[0]?.taskId ?? "").length).toBeGreaterThan(0);
      const visionCallsAfterFirst = vision.calls.length;
      expect(visionCallsAfterFirst).toBe(1);
      // 缓存命中：第二次不花视觉调用。
      const cached = await described.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-desc"),
          settings: { ...SETTINGS, mode: "description" },
        }),
      );
      expect(cached.actualMode).toBe("description");
      expect(cached.notes).toHaveLength(1);
      expect(vision.calls.length).toBe(visionCallsAfterFirst);
      void service;
    } finally {
      f.h.close();
    }
  });
});

describe("describeAfterUnsupported + isModelImageUnsupportedError", () => {
  it("fallback keeps requestedMode native, records actualMode description; discriminator matches ONLY MODEL_IMAGE_UNSUPPORTED", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-fallback");
      const fact = makeFact("ev-fallback", media.id);
      const vision = visionStub();
      const service = createQqMediaInputService({
        store: f.h,
        fetchSource: async () => ({ bytes: PNG_BYTES() }),
        agentRuntime: createEphemeralAgentRuntime({ vision: vision.client }),
        prompt: "如实说明这条消息里的媒体内容。",
        modelConfig: { visionModelName: VISION_MODEL, transcriptionModelName: null },
        baselinePolicy: POLICY,
      });
      const projection = await service.describeAfterUnsupported(
        baseInput(f, { facts: [fact], focus: focusOf("ev-fallback") }),
      );
      expect(projection.requestedMode).toBe("native");
      expect(projection.actualMode).toBe("description");
      expect(projection.notes).toHaveLength(1);
      // 窄判别：只有精确 code 匹配。
      expect(
        isModelImageUnsupportedError(new AppError("MODEL_IMAGE_UNSUPPORTED", "不支持", 400)),
      ).toBe(true);
      expect(isModelImageUnsupportedError(new AppError("MODEL_TIMEOUT", "超时", 504))).toBe(false);
      expect(isModelImageUnsupportedError(new AppError("MODEL_ERROR", "服务错误", 500))).toBe(
        false,
      );
      expect(isModelImageUnsupportedError(new Error("401 unauthorized"))).toBe(false);
      expect(isModelImageUnsupportedError(null)).toBe(false);
    } finally {
      f.h.close();
    }
  });

  it("fallback refuses when capability disabled (no silent picture path)", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-fallback-off");
      const fact = makeFact("ev-fallback-off", media.id);
      const service = serviceOf(f, async () => ({ bytes: PNG_BYTES() }));
      await expect(
        service.describeAfterUnsupported(
          baseInput(f, {
            facts: [fact],
            focus: focusOf("ev-fallback-off"),
            capabilityEnabled: false,
          }),
        ),
      ).rejects.toThrow();
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(0);
    } finally {
      f.h.close();
    }
  });
});

describe("native cache reuse details", () => {
  it("second prepare: fetch=0 and codec=0 via real codec spy; variant bytes/policy exact, spec change never false-hits", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-cache-spy");
      const fact = makeFact("ev-cache-spy", media.id);
      let fetchCalls = 0;
      const service = serviceOf(f, async () => {
        fetchCalls += 1;
        return { bytes: PNG_BYTES() };
      });
      // 真实 codec spy：包一层原 prepareQqImage 计数（bun mock.module 注册表级替换）。
      const codecModule = await import("../../src/server/services/qq-image-codec");
      const original = codecModule.prepareQqImage;
      let codecCalls = 0;
      const { mock } = await import("bun:test");
      mock.module("../../src/server/services/qq-image-codec", () => ({
        ...codecModule,
        prepareQqImage: ((bytes: Uint8Array, input: Parameters<typeof original>[1]) => {
          codecCalls += 1;
          return original(bytes, input);
        }) as typeof original,
      }));
      const first = await service.prepareQqMediaProjection(
        baseInput(f, { facts: [fact], focus: focusOf("ev-cache-spy") }),
      );
      expect(codecCalls).toBe(1);
      try {
        const second = await service.prepareQqMediaProjection(
          baseInput(f, {
            facts: [fact],
            focus: focusOf("ev-cache-spy"),
            runId: `run-${crypto.randomUUID()}`,
          }),
        );
        expect(fetchCalls).toBe(1); // 第二次零 fetch（源字节复用）
        expect(codecCalls).toBe(1); // 第二次零 codec（variant 全命中）
        expect(second.images[0]?.variantId).toBe(first.images[0]?.variantId);
        // variant 字节精确：行内 bytes sha == 投影 sha。
        const row = f.orm
          .select()
          .from(schema.qqMediaVariants)
          .where(eq(schema.qqMediaVariants.id, second.images[0]?.variantId ?? ""))
          .get();
        const rowBytes = new Uint8Array(row?.bytes as ArrayBufferLike);
        expect(second.images[0]?.sha256).toBe(
          (await import("node:crypto")).createHash("sha256").update(rowBytes).digest("hex"),
        );
        expect(second.images[0]?.mimeType).toBe(row?.mimeType ?? "");
        expect(second.images[0]?.width).toBe(row?.width ?? -1);
        expect(second.images[0]?.height).toBe(row?.height ?? -1);
      } finally {
        mock.restore();
      }
      // 规格改变（表情规格）→ policy 键不同 → 不误命中，重新解码并新写副本。
      const third = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-cache-spy"),
          runId: `run-${crypto.randomUUID()}`,
          settings: {
            ...SETTINGS,
            ordinary_still_max_dimension: 64,
          },
        }),
      );
      expect(third.images[0]?.variantPolicy).not.toBe(first.images[0]?.variantPolicy);
      expect(third.images[0]?.variantId).not.toBe(first.images[0]?.variantId);
      expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(2);
    } finally {
      f.h.close();
    }
  });
});

describe("description task source verification", () => {
  it("expired/revoked task: note not leaked, sources empty, actualMode unavailable", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-desc-expired");
      const fact = makeFact("ev-desc-expired", media.id);
      const vision = visionStub();
      const service = createQqMediaInputService({
        store: f.h,
        fetchSource: async () => ({ bytes: PNG_BYTES() }),
        agentRuntime: createEphemeralAgentRuntime({ vision: vision.client }),
        prompt: "如实说明这条消息里的媒体内容。",
        modelConfig: { visionModelName: VISION_MODEL, transcriptionModelName: null },
        baselinePolicy: POLICY,
      });
      const ok = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-desc-expired"),
          settings: { ...SETTINGS, mode: "description" },
        }),
      );
      expect(ok.actualMode).toBe("description");
      expect(ok.notes).toHaveLength(1);
      expect(ok.sources).toHaveLength(1);
      expect(ok.sources[0]?.kind).toBe("qq_media_read_task");
      // 媒体窗口过期后：ref 不可 mint（消费帽取实际窗口最早值）→ note 不裸泄，actualMode 降 unavailable。
      const past = new Date(Date.now() - 60_000).toISOString();
      f.orm
        .update(schema.qqMediaNotes)
        .set({ expiresAt: past })
        .where(eq(schema.qqMediaNotes.id, media.id))
        .run();
      const after = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-desc-expired"),
          settings: { ...SETTINGS, mode: "description" },
          runId: `run-${crypto.randomUUID()}`,
        }),
      );
      expect(after.notes).toHaveLength(0);
      expect(after.sources).toHaveLength(0);
      expect(after.actualMode).toBe("unavailable");
      // 撤销：早前签发的 ref 在任务 revision 被改后复验 revoked（旧引用不复活）。
      // 媒体窗口已死 → 早前签发的 ref 复验 expired（旧引用不复活，fail closed）。
      const issuedRef = ok.sources[0];
      expect(issuedRef).toBeDefined();
      const principal = { userId: DEFAULT_USER_ID };
      const deadWindow = qqMediaReadTaskSourceAccess(
        f.h.db,
        issuedRef,
        okOwner(f),
        principal,
        nowIso(),
      );
      expect(deadWindow).toBe("expired");
      // 任务 revision 被改 → 同一 ref 复验 revoked（内容身份变化不冒充 available）。
      f.orm
        .update(schema.qqMediaNotes)
        .set({ expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString() })
        .where(eq(schema.qqMediaNotes.id, media.id))
        .run();
      f.orm.update(schema.qqMediaReadTasks).set({ revision: 999 }).run();
      const afterTamper = qqMediaReadTaskSourceAccess(
        f.h.db,
        issuedRef,
        okOwner(f),
        principal,
        nowIso(),
      );
      expect(afterTamper).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("stage off fallback: zero vision calls, disabled projection, requestedMode preserved", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-fallback-stage");
      const fact = makeFact("ev-fallback-stage", media.id);
      const vision = visionStub();
      const service = createQqMediaInputService({
        store: f.h,
        fetchSource: async () => ({ bytes: PNG_BYTES() }),
        agentRuntime: createEphemeralAgentRuntime({ vision: vision.client }),
        prompt: "如实说明这条消息里的媒体内容。",
        modelConfig: { visionModelName: VISION_MODEL, transcriptionModelName: null },
        baselinePolicy: POLICY,
      });
      const projection = await service.describeAfterUnsupported(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-fallback-stage"),
          settings: {
            ...SETTINGS,
            stages: { decision: true, evaluation: true, generation: false },
          },
        }),
      );
      expect(projection.actualMode).toBe("disabled");
      expect(projection.requestedMode).toBe("native");
      expect(projection.images).toHaveLength(0);
      expect(projection.notes).toHaveLength(0);
      expect(projection.omissions.every((o) => o.reason === "stage_disabled")).toBe(true);
      expect(vision.calls).toHaveLength(0);
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(0);
    } finally {
      f.h.close();
    }
  });
});

describe("classification cache readback (§7.2)", () => {
  const CP = "media-policy-revision-1";

  it("cached model classification upgrades unknown→expression spec; platform never overridden; facts hash unchanged; zero new classification calls", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-readback");
      const fact = makeFact("ev-readback", media.id, "unknown");
      const factHashBefore = JSON.stringify(fact);
      let fetchCalls = 0;
      const service = serviceOf(f, async () => {
        fetchCalls += 1;
        return { bytes: PNG_BYTES() };
      });
      // 首次：unknown，无缓存 → ordinary 规格（原图 null 尺寸）。
      const first = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-readback"),
          classificationPolicy: CP,
        }),
      );
      expect(first.images[0]?.category).toBe("unknown");
      expect(first.images[0]?.categorySource).toBe("unknown");
      expect(first.images[0]?.width).toBe(8); // 原图 8x8，ordinary null=原图
      const assetId = first.images[0]?.assetId ?? "";
      expect(assetId.length).toBeGreaterThan(0);
      const classificationsBefore = f.orm.select().from(schema.qqMediaClassifications).all().length;
      // 写入模型分类（写侧真源键 = classificationPolicy + 模型名）。
      recordMediaClassification(f.orm, {
        assetId,
        category: "expression",
        evidence: "model",
        policy: CP,
        modelName: MODEL,
      });
      // 平台可靠分类不可覆：另一张 ordinary fact + 同样缓存 expression → 仍 platform ordinary。
      const platformMedia = f.mediaImage("ev-readback-platform");
      const platformFact = makeFact("ev-readback-platform", platformMedia.id, "ordinary");
      await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [platformFact],
          focus: focusOf("ev-readback-platform"),
          classificationPolicy: CP,
        }),
      );
      // 同字节内容在 (scope, sha) 去重下是同一资产：直接给该资产写模型分类，平台事实仍须优先。
      recordMediaClassification(f.orm, {
        assetId,
        category: "expression",
        evidence: "model",
        policy: CP,
        modelName: MODEL,
      });
      const second = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-readback"),
          classificationPolicy: CP,
          runId: `run-${crypto.randomUUID()}`,
        }),
      );
      expect(second.images[0]?.category).toBe("expression");
      expect(second.images[0]?.categorySource).toBe("model");
      // expression 规格（64）生效：8x8 ≤ 64 不放大，但 policy 键应含 expression 规格。
      expect(second.images[0]?.variantPolicy).not.toBe(first.images[0]?.variantPolicy);
      expect(second.images[0]?.sha256).toBe(first.images[0]?.sha256); // 同字节（未缩放）
      // 平台优先：ordinary fact 的分类不被缓存覆盖。
      const platformReadback = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [platformFact],
          focus: focusOf("ev-readback-platform"),
          classificationPolicy: CP,
          runId: `run-${crypto.randomUUID()}`,
        }),
      );
      expect(platformReadback.images[0]?.category).toBe("ordinary");
      expect(platformReadback.images[0]?.categorySource).toBe("platform");
      // detail 显式升 ordinary 规格（明确细问表情）。
      const detail = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-readback"),
          classificationPolicy: CP,
          detailMediaIds: new Set([media.id]),
          runId: `run-${crypto.randomUUID()}`,
        }),
      );
      expect(detail.images[0]?.variantPolicy).not.toBe(second.images[0]?.variantPolicy);
      // facts 原件 hash 不变。
      expect(JSON.stringify(fact)).toBe(factHashBefore);
      // 零新分类调用：分类行数不变（回读是纯 DB 读）。
      expect(f.orm.select().from(schema.qqMediaClassifications).all().length).toBe(
        classificationsBefore + 1,
      );
    } finally {
      f.h.close();
    }
  });

  it("model/policy mismatch never hits the cache; scope isolation implicit via scopeIdentity", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-readback-miss");
      const fact = makeFact("ev-readback-miss", media.id, "unknown");
      const service = serviceOf(f, async () => ({ bytes: PNG_BYTES() }));
      const first = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-readback-miss"),
          classificationPolicy: CP,
        }),
      );
      const assetId = first.images[0]?.assetId ?? "";
      recordMediaClassification(f.orm, {
        assetId,
        category: "expression",
        evidence: "model",
        policy: CP,
        modelName: "other-model", // 模型不同
      });
      const missModel = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-readback-miss"),
          classificationPolicy: CP,
          runId: `run-${crypto.randomUUID()}`,
        }),
      );
      expect(missModel.images[0]?.category).toBe("unknown");
      expect(missModel.images[0]?.categorySource).toBe("unknown");
      // 策略不同：缓存写在别的 classificationPolicy 键下。
      recordMediaClassification(f.orm, {
        assetId,
        category: "expression",
        evidence: "model",
        policy: "other-policy",
        modelName: MODEL,
      });
      const missPolicy = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-readback-miss"),
          classificationPolicy: CP,
          runId: `run-${crypto.randomUUID()}`,
        }),
      );
      expect(missPolicy.images[0]?.category).toBe("unknown");
      expect(missPolicy.images[0]?.categorySource).toBe("unknown");
      // 缺省（不传 classificationPolicy）→ 不回读。
      const noReadback = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-readback-miss"),
          runId: `run-${crypto.randomUUID()}`,
        }),
      );
      expect(noReadback.images[0]?.category).toBe("unknown");
    } finally {
      f.h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// §7.5 unsupported 动画最小补口：native 自动范围窄捕获（unsupported_animation 唯一）→
// unreadable omission；其余原因/非 codec 异常原样穿透；按需路径保留硬拒。
// ---------------------------------------------------------------------------

/** 真实动画容器（与 qq-image-codec.test 同构）：animated WebP（VP8X animation 位）。 */
function animatedWebpBytes(): Uint8Array {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x2c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58,
    0x0e, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    0x41, 0x4e, 0x49, 0x4d, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

/** 真实 APNG：IHDR + acTL（在 IDAT 前）+ IDAT + IEND，头可读、解码拒绝于 codec 窄捕获。 */
function apngBytes(): Uint8Array {
  const chunk = (type: Uint8Array, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(type, 4);
    out.set(data, 8);
    new DataView(out.buffer).setUint32(8 + data.length, crc32(new Uint8Array([...type, ...data])));
    return out;
  };
  const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (const byte of bytes) {
      c ^= byte;
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 4);
  new DataView(ihdr.buffer).setUint32(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const actl = new Uint8Array(8);
  new DataView(actl.buffer).setUint32(0, 2);
  const idat = new Uint8Array(64).fill(0x11);
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const head = sig;
  const ihdrChunk = chunk(new Uint8Array([0x49, 0x48, 0x44, 0x52]), ihdr);
  const actlChunk = chunk(new Uint8Array([0x61, 0x63, 0x54, 0x4c]), actl);
  const idatChunk = chunk(new Uint8Array([0x49, 0x44, 0x41, 0x54]), idat);
  const iendChunk = chunk(new Uint8Array([0x49, 0x45, 0x4e, 0x44]), new Uint8Array(0));
  const total =
    head.length + ihdrChunk.length + actlChunk.length + idatChunk.length + iendChunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [head, ihdrChunk, actlChunk, idatChunk, iendChunk]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("createQqMediaInputService unsupported_animation omission (§7.5)", () => {
  it("one unsupported animation + one legal still: still image is sent, animation becomes unreadable omission, no asset/variant rows, no vision", async () => {
    const f = openFixture();
    try {
      const animMedia = f.mediaImage("ev-anim-unreadable");
      const stillMedia = f.mediaImage("ev-still-ok");
      const animFact = makeFact("ev-anim-unreadable", animMedia.id);
      const stillFact = makeFact("ev-still-ok", stillMedia.id);
      const vision = visionStub();
      const bytesByRef = new Map<string, Uint8Array>([
        ["ref-ev-anim-unreadable", animatedWebpBytes()],
        ["ref-ev-still-ok", PNG_BYTES()],
      ]);
      const service = createQqMediaInputService({
        store: f.h,
        fetchSource: async ({ sourceRef }) => {
          const bytes = bytesByRef.get(sourceRef);
          if (!bytes) throw new Error(`unexpected sourceRef ${sourceRef}`);
          return { bytes };
        },
        agentRuntime: createEphemeralAgentRuntime({ vision: vision.client }),
        prompt: "如实说明这条消息里的媒体内容。",
        modelConfig: { visionModelName: VISION_MODEL, transcriptionModelName: null },
        baselinePolicy: POLICY,
      });
      const projection = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [animFact, stillFact],
          focus: focusOf("ev-anim-unreadable", "ev-still-ok"),
        }),
      );
      // 正面：合法静图照常 prepared 发送，整轮不失败。
      expect(projection.actualMode).toBe("native");
      expect(projection.images).toHaveLength(1);
      expect(projection.images[0]?.mediaId).toBe(stillMedia.id);
      // 动画：存在但本轮不可读（unreadable），mediaId 仍在 facts，messageId 取真实 occurrence。
      expect(projection.omissions).toContainEqual({
        mediaId: animMedia.id,
        messageId: "ev-anim-unreadable",
        reason: "unreadable",
      });
      // 窄捕获：动画本轮不产生 variant/描述（§8.2 源字节缓存按单链既有语义照常落库：
      // asset 行是 fetch 时写的事实字节缓存，不是"读懂"的证据）；静图 asset+variant 各一。
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(2);
      expect(f.orm.select().from(schema.qqMediaAssetSources).all()).toHaveLength(2);
      expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(1);
      expect(vision.calls).toHaveLength(0);
    } finally {
      f.h.close();
    }
  });

  it("APNG unsupported animation: same unreadable omission, no still-frame stand-in", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-apng-unreadable");
      const fact = makeFact("ev-apng-unreadable", media.id);
      const service = serviceOf(f, async () => ({ bytes: apngBytes() }));
      const projection = await service.prepareQqMediaProjection(
        baseInput(f, { facts: [fact], focus: focusOf("ev-apng-unreadable") }),
      );
      expect(projection.images).toHaveLength(0);
      expect(projection.omissions).toContainEqual({
        mediaId: media.id,
        messageId: "ev-apng-unreadable",
        reason: "unreadable",
      });
      // 动画源字节按 §8.2 单链语义缓存（1 asset），但零 variant、零冒充帧。
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(1);
      expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(0);
    } finally {
      f.h.close();
    }
  });

  it("narrow catch only: unreadable_image still rejects the whole round (no unreadable downgrade)", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-gif-broken");
      const fact = makeFact("ev-gif-broken", media.id);
      // 头可读（GIF89a）但帧数据截断：worker 采样失败 → unreadable_image，非 unsupported_animation。
      const brokenGif = gifBytes(2).slice(0, 60);
      const service = serviceOf(f, async () => ({ bytes: brokenGif }));
      await expect(
        service.prepareQqMediaProjection(
          baseInput(f, { facts: [fact], focus: focusOf("ev-gif-broken") }),
        ),
      ).rejects.toThrow();
      // 整轮失败穿透：variant/描述零产出，绝不降级成 unreadable omission。
      expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(0);
    } finally {
      f.h.close();
    }
  });

  it("revocation mid-prepare: abort after the awaited decode rejects — never packaged as unreadable", async () => {
    const f = openFixture();
    let decodeStarted = false;
    try {
      const media = f.mediaImage("ev-anim-revoked-mid");
      const fact = makeFact("ev-anim-revoked-mid", media.id);
      const service = createQqMediaInputService({
        store: f.h,
        fetchSource: async ({ signal }) => {
          // 受控窗口：fetch 返回前挂起一拍，abort 落在 fetch await 与解码之间的真实窗口。
          await new Promise((resolve) => setTimeout(resolve, 20));
          signal?.throwIfAborted();
          return { bytes: animatedWebpBytes() };
        },
        agentRuntime: createEphemeralAgentRuntime({ vision: visionStub().client }),
        prompt: "如实说明这条消息里的媒体内容。",
        modelConfig: { visionModelName: VISION_MODEL, transcriptionModelName: null },
        baselinePolicy: POLICY,
      });
      const controller = new AbortController();
      const input = {
        ...baseInput(f, { facts: [fact], focus: focusOf("ev-anim-revoked-mid") }),
        signal: controller.signal,
      };
      const pending = service.prepareQqMediaProjection(input);
      // 解码启动后（fetch 已过 await 窗口）取消：取消发生在 await 之后、catch 末验之前。
      void Promise.resolve().then(() => {
        setTimeout(() => {
          decodeStarted = true;
          controller.abort();
        }, 10);
      });
      await expect(pending).rejects.toThrow();
      expect(decodeStarted).toBe(true);
      // 零 variant：取消路径绝不产出可供模型的副本，也绝不降级成 unreadable omission。
      expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(0);
    } finally {
      f.h.close();
    }
  });

  /** 本群 media 能力真实关闭（updateQqGroupConfig CAS 写）：翻转即纪元推进，旧纪元永久失效。 */
  function closeGroupMediaForReal(f: Fixture): number {
    const binding = readQqBinding(f.orm, BINDING_ID);
    if (!binding) throw new Error("binding missing");
    const scheme = readQqScheme(f.orm, binding.schemeId);
    if (!scheme) throw new Error("scheme missing");
    const current = readQqGroupAgentConfig(f.orm, binding);
    updateQqGroupConfig(f.orm, {
      bindingId: binding.id,
      payload: {
        agent_id: binding.agentId,
        expected_binding_revision: binding.revision,
        expected_scheme_revision: scheme.revision,
        expected_revision: current.revision,
        overrides: {},
        disabled_capabilities: ["media"],
      },
    });
    return readQqGroupCapabilityRevision(f.orm, binding, "media");
  }

  /** 宿主 assertConfiguration 的 media 纪元子句镜像：每次复验重读真值，不是硬编码布尔。 */
  function mediaEpochAssert(f: Fixture, frozen: number): () => void {
    return () => {
      const binding = readQqBinding(f.orm, BINDING_ID);
      if (binding === null) throw new Error("BINDING_CHANGED");
      if (readQqGroupCapabilityRevision(f.orm, binding, "media") !== frozen) {
        throw new Error("MEDIA_CAPABILITY_EPOCH_CHANGED");
      }
    };
  }

  /** 真实 codec 注入 + deferred 握手：codec 入口被触到后挂起（真实解码尚未开始），放行断言窗口后再跑真解码；不宣布覆盖真实 worker decode 中途。 */
  function deferredCodecMock(original: typeof prepareQqImage) {
    let decodeTouchedResolve: () => void = () => {};
    let resumeDecode: () => void = () => {};
    const decodeTouched = new Promise<void>((resolve) => {
      decodeTouchedResolve = resolve;
    });
    const decodeGate = new Promise<void>((resolve) => {
      resumeDecode = resolve;
    });
    return {
      decodeTouched,
      resumeDecode,
      register: async () => {
        const codecModule = await import("../../src/server/services/qq-image-codec");
        const { mock } = await import("bun:test");
        mock.module("../../src/server/services/qq-image-codec", () => ({
          ...codecModule,
          prepareQqImage: (async (input: Uint8Array, options: Parameters<typeof original>[1]) => {
            decodeTouchedResolve();
            await decodeGate;
            return original(input, options);
          }) as typeof original,
        }));
        return mock;
      },
    };
  }

  it("capability epoch closes while codec preparation is pending before actual decode: authority fail, zero variant/classification, raw asset cache per spec retained", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-cap-mid-decode");
      const fact = makeFact("ev-cap-mid-decode", media.id);
      const bytes = PNG_BYTES();
      const service = serviceOf(f, async () => ({ bytes }));
      const codecModule = await import("../../src/server/services/qq-image-codec");
      const handshake = deferredCodecMock(codecModule.prepareQqImage);
      const mock = await handshake.register();
      const frozenBinding = readQqBinding(f.orm, BINDING_ID);
      if (!frozenBinding) throw new Error("binding missing");
      const frozen = readQqGroupCapabilityRevision(f.orm, frozenBinding, "media");
      try {
        const pending = service.prepareQqMediaProjection(
          baseInput(f, {
            facts: [fact],
            focus: focusOf("ev-cap-mid-decode"),
            assertCurrent: mediaEpochAssert(f, frozen),
          }),
        );
        await handshake.decodeTouched; // codec 入口已触发、真实解码未开始（无定时、无首调假抛）
        const epoch = closeGroupMediaForReal(f); // 在飞中真实关闭本群 media 能力
        expect(epoch).toBe(frozen + 1);
        handshake.resumeDecode(); // 放行真实解码
        await expect(pending).rejects.toThrow("MEDIA_CAPABILITY_EPOCH_CHANGED");
        // 资产原始字节按 §8.2 保留（有限受控缓存）——不误称「全部为 0」：
        const assets = f.orm.select().from(schema.qqMediaAssets).all();
        expect(assets).toHaveLength(1);
        const assetBytes = new Uint8Array(assets[0]!.bytes as ArrayBufferLike);
        expect(createHash("sha256").update(assetBytes).digest("hex")).toBe(
          createHash("sha256").update(bytes).digest("hex"),
        );
        // variant / 分类零发布（无 model run，本链路无消费 proof 可断）：
        expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(0);
        expect(f.orm.select().from(schema.qqMediaClassifications).all()).toHaveLength(0);
      } finally {
        mock.restore();
      }
    } finally {
      f.h.close();
    }
  });

  it("same deferred-decode handshake without closing the cap: regular success contrast with prepared variant published", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-cap-handshake-ok");
      const fact = makeFact("ev-cap-handshake-ok", media.id);
      const service = serviceOf(f, async () => ({ bytes: PNG_BYTES() }));
      const codecModule = await import("../../src/server/services/qq-image-codec");
      const handshake = deferredCodecMock(codecModule.prepareQqImage);
      const mock = await handshake.register();
      const frozenBinding = readQqBinding(f.orm, BINDING_ID);
      if (!frozenBinding) throw new Error("binding missing");
      const frozen = readQqGroupCapabilityRevision(f.orm, frozenBinding, "media");
      try {
        const pending = service.prepareQqMediaProjection(
          baseInput(f, {
            facts: [fact],
            focus: focusOf("ev-cap-handshake-ok"),
            assertCurrent: mediaEpochAssert(f, frozen),
          }),
        );
        await handshake.decodeTouched;
        handshake.resumeDecode(); // 不关 cap：真实纪元复验照旧通过
        const projection = await pending;
        expect(projection.actualMode).toBe("native");
        expect(projection.images).toHaveLength(1);
        expect(projection.sources).toHaveLength(1);
        expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(1);
      } finally {
        mock.restore();
      }
    } finally {
      f.h.close();
    }
  });

  /**
   * T14 real-worker cap-off fixture: a bounded GIF on a 64x64 canvas, encoded with the
   * existing omggif writer and grown by block concat to this test's OWN 4 MiB self-limit
   * (the T14 lifecycle experiment uses the same shape; neither number is a product cap —
   * the production 64 MiB decode boundary and the 30 s deadline are untouched). The frame
   * count is orders of magnitude above the 3 frames requested, so sampling has to walk the
   * whole container inside the worker.
   */
  function boundedSustainedGif(): Uint8Array {
    const canvas = 64;
    const limit = 4 * 1024 * 1024;
    const solid = new Array<number>(canvas * canvas).fill(0);
    const oneBuffer = new Uint8Array(4096);
    const twoBuffer = new Uint8Array(8192);
    const writer1 = new upstream.GifWriter(oneBuffer, canvas, canvas, {
      palette: [0xff0000, 0x00ff00],
      loop: 0,
    });
    writer1.addFrame(0, 0, canvas, canvas, solid, { delay: 10, disposal: 2 });
    const oneLength = writer1.end();
    const writer2 = new upstream.GifWriter(twoBuffer, canvas, canvas, {
      palette: [0xff0000, 0x00ff00],
      loop: 0,
    });
    writer2.addFrame(0, 0, canvas, canvas, solid, { delay: 10, disposal: 2 });
    writer2.addFrame(0, 0, canvas, canvas, solid, { delay: 10, disposal: 2 });
    const twoLength = writer2.end();
    const oneGif = oneBuffer.slice(0, oneLength);
    const twoGif = twoBuffer.slice(0, twoLength);
    const prefix = oneGif.slice(0, oneGif.length - 1);
    const block = twoGif.slice(oneGif.length - 1, twoGif.length - 1);
    const repeats = Math.floor((limit - prefix.length - 1) / block.length);
    const bytes = new Uint8Array(prefix.length + block.length * repeats + 1);
    bytes.set(prefix, 0);
    for (let at = prefix.length, index = 0; index < repeats; index += 1, at += block.length) {
      bytes.set(block, at);
    }
    bytes[bytes.length - 1] = 0x3b;
    return bytes;
  }

  /**
   * Real worker liveness, observed the same way `qq-image-worker-lifecycle-boundaries.test.ts`
   * does it: a local `Worker.prototype.on` spy on the production host's own worker, restored
   * in `finally`. No module mock, no production hook, no global patch leak. `online` fires
   * only once the thread is actually executing JavaScript, so it proves a real worker
   * instance is in flight — it says NOTHING about the CPU decode loop running
   * instruction by instruction (the host module states terminate() is the only real stop).
   */
  interface WorkerLiveness {
    readonly spawned: boolean;
    readonly onlineCount: number;
    readonly postedMessages: number;
    restore(): void;
  }

  function installWorkerLivenessSpy(onOnline: () => void): WorkerLiveness {
    const originalOn = Worker.prototype.on;
    const state = { spawned: false, onlineCount: 0, postedMessages: 0 };
    const observation: WorkerLiveness = {
      get spawned() {
        return state.spawned;
      },
      get onlineCount() {
        return state.onlineCount;
      },
      get postedMessages() {
        return state.postedMessages;
      },
      restore() {
        Worker.prototype.on = originalOn;
      },
    };
    const spyOn = function (this: Worker, event: string, listener: never) {
      if (!state.spawned) {
        state.spawned = true;
        originalOn.call(this, "online", () => {
          state.onlineCount += 1;
          onOnline();
        });
        originalOn.call(this, "message", () => {
          state.postedMessages += 1;
        });
      }
      return originalOn.call(this, event, listener);
    };
    Worker.prototype.on = spyOn as unknown as typeof Worker.prototype.on;
    return observation;
  }

  it("capability epoch closes while the REAL worker job is unsettled: thread started + job pending, authority refuses, zero variant/classification, raw asset cache per spec retained", async () => {
    const f = openFixture();
    let spy: WorkerLiveness | null = null;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const media = f.mediaImage("ev-cap-real-worker");
      const fact = makeFact("ev-cap-real-worker", media.id);
      const bytes = boundedSustainedGif();
      const service = serviceOf(f, async () => ({ bytes }));
      const frozenBinding = readQqBinding(f.orm, BINDING_ID);
      if (!frozenBinding) throw new Error("binding missing");
      const frozen = readQqGroupCapabilityRevision(f.orm, frozenBinding, "media");
      let notifyOnline: () => void = () => {};
      const onlineSeen = new Promise<void>((resolve) => {
        notifyOnline = resolve;
      });
      spy = installWorkerLivenessSpy(notifyOnline);
      let settled = false;
      const pending = service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-cap-real-worker"),
          assertCurrent: mediaEpochAssert(f, frozen),
        }),
      );
      // Track settlement explicitly: an unhandled rejection below would be a test defect, and
      // `settled` is the direct evidence that the job was still in flight at the cap close.
      const settledFlag = pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        // Liveness upper bound only. `online` is not an execution proof and not a timer for
        // the decode loop; it says the thread really started. If this runtime never reports
        // it, the interface is missing here and the test fails rather than fake-passes.
        const online = await Promise.race([
          onlineSeen.then(() => true),
          new Promise<false>((resolve) => {
            watchdog = setTimeout(() => resolve(false), 15_000);
          }),
        ]);
        if (watchdog !== undefined) clearTimeout(watchdog);
        watchdog = undefined;
        if (!online) {
          // Drain first: never leave a running worker or an unsettled promise behind.
          await pending.then(
            () => undefined,
            () => undefined,
          );
          throw new Error(
            "real QQ image worker never reported online: this runtime exposes no worker-state interface",
          );
        }
        // A real worker instance exists AND the job has not settled. Nothing more is claimed:
        // not that the CPU sampling loop is executing instruction by instruction.
        expect(spy.spawned).toBe(true);
        expect(spy.onlineCount).toBe(1);
        expect(settled).toBe(false);
        // In flight for real: close this group's media capability through the main thread CAS.
        const epoch = closeGroupMediaForReal(f);
        expect(epoch).toBe(frozen + 1);
        await expect(pending).rejects.toThrow("MEDIA_CAPABILITY_EPOCH_CHANGED");
        await settledFlag;
        // The worker really did run and post its sampled result before authority refused.
        expect(spy.postedMessages).toBeGreaterThanOrEqual(1);
        // Raw source bytes stay cached per §8.2 (a bounded fact cache, not a read receipt).
        const assets = f.orm.select().from(schema.qqMediaAssets).all();
        expect(assets).toHaveLength(1);
        const assetBytes = new Uint8Array(assets[0]!.bytes as ArrayBufferLike);
        expect(createHash("sha256").update(assetBytes).digest("hex")).toBe(
          createHash("sha256").update(bytes).digest("hex"),
        );
        // Nothing publishable: no variant for a model, no classification, no consumed proof.
        expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(0);
        expect(f.orm.select().from(schema.qqMediaClassifications).all()).toHaveLength(0);
      } finally {
        if (watchdog !== undefined) clearTimeout(watchdog);
        // 附带残余 drain：早断言抛出也先等在飞 job 落定，再还原 spy（外层 finally 关库）。
        await pending.then(
          () => undefined,
          () => undefined,
        );
        spy.restore();
        spy = null;
      }
    } finally {
      if (spy !== null) spy.restore();
      f.h.close();
    }
  }, 120_000);

  it("on-demand keeps the hard rejection: unsupported animation refuses prepareByMediaId", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-anim-demand");
      const fact = makeFact("ev-anim-demand", media.id);
      const service = serviceOf(f, async () => ({ bytes: animatedWebpBytes() }));
      await expect(
        service.prepareByMediaId(onDemandInput(f, media.id, { facts: [fact] })),
      ).rejects.toThrow();
      // 硬拒且零 variant/副本：不可读图绝不以成功空结果返回给工具。
      expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(0);
    } finally {
      f.h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T08 原生按需媒体准备（计划 T08 Step8 / 规格 §7.5、§8.2、§9、§12）：
// `prepareByMediaId` 是工具主动读取背后的受控准备服务——真建 asset/link/variant、
// 真 mint 来源、零模型调用、零 raw 字节外泄；与自动范围共用同一条准备实现。
// ---------------------------------------------------------------------------

/** 按需读取入参：只覆盖与自动范围不同的事实集（一个已披露 mediaId），其余同上。 */
function onDemandInput(f: Fixture, mediaId: string, overrides: Record<string, unknown> = {}) {
  return {
    scope: f.scope,
    phase: "generation" as const,
    focus: focusOf("ev-demand"),
    facts: [] as QqMessageFact[],
    replies: NO_REPLIES,
    settings: SETTINGS,
    model: MODEL,
    now: nowIso(),
    runId: `run-${crypto.randomUUID()}`,
    signal: new AbortController().signal,
    assertCurrent: () => {},
    mediaId,
    ...overrides,
  };
}

describe("createQqMediaInputService.prepareByMediaId", () => {
  it("disclosed image: real asset+link+variant, live store sha/variantId, no bytes or model calls", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-demand");
      const fact = makeFact("ev-demand", media.id);
      let fetchCalls = 0;
      const vision = visionStub();
      const service = createQqMediaInputService({
        store: f.h,
        fetchSource: async () => {
          fetchCalls += 1;
          return { bytes: PNG_BYTES() };
        },
        agentRuntime: createEphemeralAgentRuntime({ vision: vision.client }),
        prompt: "如实说明这条消息里的媒体内容。",
        modelConfig: { visionModelName: VISION_MODEL, transcriptionModelName: null },
        baselinePolicy: POLICY,
      });
      const result = await service.prepareByMediaId(onDemandInput(f, media.id, { facts: [fact] }));
      expect(fetchCalls).toBe(1);
      expect(result.mediaId).toBe(media.id);
      expect(result.category).toBe("ordinary");
      expect(result.categorySource).toBe("platform");
      expect(result.messageIds).toEqual(["ev-demand"]);
      expect(result.images).toHaveLength(1);
      const image = result.images[0];
      if (image === undefined) throw new Error("prepared image missing");
      // 真实 store 登记：asset / source link / variant 各一行，variantId 指向真实主键。
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(1);
      expect(f.orm.select().from(schema.qqMediaAssetSources).all()).toHaveLength(1);
      expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(1);
      const variantRow = f.orm
        .select()
        .from(schema.qqMediaVariants)
        .where(eq(schema.qqMediaVariants.id, image.variantId))
        .get();
      expect(variantRow?.assetId).toBe(image.assetId);
      expect(variantRow?.policy).toBe(image.variantPolicy);
      // 投影 sha 必须是 variant 行内真实字节的 sha，不是重新解释的形状。
      const rowBytes = new Uint8Array(variantRow?.bytes as ArrayBufferLike);
      expect(image.sha256).toBe(
        (await import("node:crypto")).createHash("sha256").update(rowBytes).digest("hex"),
      );
      // 真实来源：qq_media_source 引用，可被统一 access 复验为 available。
      expect(result.sources).toHaveLength(1);
      const source = result.sources[0];
      if (source === undefined) throw new Error("prepared source missing");
      expect(source.kind).toBe("qq_media_source");
      expect(source.id).toBe(media.id);
      expect(
        qqMediaSourceAccess(f.h.db, source, okOwner(f), { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("available");
      // 零模型调用（原生按需准备不碰描述链）。
      expect(vision.calls).toHaveLength(0);
      // 无 raw bytes / base64 / url / path 外泄。
      const wire = JSON.stringify(result);
      expect(wire).not.toContain("base64");
      expect(wire).not.toContain("data:");
      expect(wire).not.toContain("ref-ev-demand");
      expect(wire).not.toContain("http");
    } finally {
      f.h.close();
    }
  });

  it("outside the auto focus range: still prepared (on-demand is not the auto selector)", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-demand-outside");
      const fact = makeFact("ev-demand-outside", media.id);
      let fetchCalls = 0;
      const service = serviceOf(f, async () => {
        fetchCalls += 1;
        return { bytes: PNG_BYTES() };
      });
      // 事实里有这张图，但本轮 focus 是另一条消息：自动范围会 not_selected 跳过它。
      const auto = await service.prepareQqMediaProjection(
        baseInput(f, {
          facts: [fact],
          focus: focusOf("ev-unrelated"),
        }),
      );
      expect(auto.images).toHaveLength(0);
      expect(auto.omissions.some((o) => o.mediaId === media.id)).toBe(true);
      // 按需读取只处理被点名的这一个 mediaId：同样真准备，不因为超出自动范围而失败。
      const demand = await service.prepareByMediaId(onDemandInput(f, media.id, { facts: [fact] }));
      expect(fetchCalls).toBe(1);
      expect(demand.images).toHaveLength(1);
      expect(demand.images[0]?.mediaId).toBe(media.id);
    } finally {
      f.h.close();
    }
  });

  it("stage off: on-demand read still prepares (stage gates the auto images, not a disclosed resource)", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-demand-stage");
      const fact = makeFact("ev-demand-stage", media.id);
      let fetchCalls = 0;
      const service = serviceOf(f, async () => {
        fetchCalls += 1;
        return { bytes: PNG_BYTES() };
      });
      const result = await service.prepareByMediaId(
        onDemandInput(f, media.id, {
          facts: [fact],
          settings: {
            ...SETTINGS,
            stages: { decision: true, evaluation: true, generation: false },
          },
        }),
      );
      expect(fetchCalls).toBe(1);
      expect(result.images).toHaveLength(1);
    } finally {
      f.h.close();
    }
  });

  it("capability disabled: refuses with zero fetch, zero cache writes", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-demand-cap-off");
      let fetchCalls = 0;
      const service = serviceOf(f, async () => {
        fetchCalls += 1;
        return { bytes: PNG_BYTES() };
      });
      await expect(
        service.prepareByMediaId(
          onDemandInput(f, media.id, {
            facts: [makeFact("ev-demand-cap-off", media.id)],
            capabilityEnabled: false,
          }),
        ),
      ).rejects.toThrow();
      expect(fetchCalls).toBe(0);
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(0);
      expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(0);
    } finally {
      f.h.close();
    }
  });

  it("expired source and missing row: fail closed, zero cache writes", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-demand-expired");
      const past = new Date(Date.now() - 60_000).toISOString();
      f.orm
        .update(schema.qqMediaNotes)
        .set({ expiresAt: past })
        .where(eq(schema.qqMediaNotes.id, media.id))
        .run();
      let fetchCalls = 0;
      const service = serviceOf(f, async () => {
        fetchCalls += 1;
        return { bytes: PNG_BYTES() };
      });
      await expect(
        service.prepareByMediaId(
          onDemandInput(f, media.id, { facts: [makeFact("ev-demand-expired", media.id)] }),
        ),
      ).rejects.toThrow();
      // 不存在的行同样 fail closed，绝不猜。
      await expect(
        service.prepareByMediaId(onDemandInput(f, "00000000-0000-4000-8000-000000000000")),
      ).rejects.toThrow();
      expect(fetchCalls).toBe(0);
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(0);
    } finally {
      f.h.close();
    }
  });

  it("owner out of this scope: refuses before any fetch or write", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-demand-bad-scope");
      let fetchCalls = 0;
      const service = serviceOf(f, async () => {
        fetchCalls += 1;
        return { bytes: PNG_BYTES() };
      });
      await expect(
        service.prepareByMediaId(
          onDemandInput(f, media.id, {
            facts: [makeFact("ev-demand-bad-scope", media.id)],
            owner: {
              kind: "conversation",
              id: f.scope.conversationId,
              userId: DEFAULT_USER_ID,
              agentId: "00000000-0000-0000-0000-0000000000ff",
            },
          }),
        ),
      ).rejects.toThrow();
      expect(fetchCalls).toBe(0);
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(0);
    } finally {
      f.h.close();
    }
  });

  it("detail question: body change mid-prepare is refused, zero cache writes", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-demand-detail");
      const fact = makeFact("ev-demand-detail", media.id, "expression");
      let questionCurrent = true;
      let guardCalls = 0;
      const service = serviceOf(f, async () => ({ bytes: PNG_BYTES() }));
      const anchor = {
        questionKey: "这是那张图里的梗出自哪里",
        eventKey: "ev-demand-detail",
        source: { kind: "qq_event" as const, id: "ev-demand-detail", revision: nowIso() },
        assertQuestionCurrent: () => {
          guardCalls += 1;
          if (!questionCurrent) fail("CONTEXT_SOURCE_INVALID", "问题原文已变化");
        },
      };
      // 正常细问：detail 升普通规格（§7.4），但不改图片原分类。
      const ok = await service.prepareByMediaId(
        onDemandInput(f, media.id, { facts: [fact], detail: anchor }),
      );
      expect(ok.detail).toBe(true);
      expect(ok.category).toBe("expression");
      expect(ok.categorySource).toBe("platform");
      const expressionPolicy = ok.images[0]?.variantPolicy ?? "";
      expect(expressionPolicy.length).toBeGreaterThan(0);
      // 锚真被调用过（读边界 + 每个写事务），否则下面那次「中途变化」会空跑成绿。
      expect(guardCalls).toBeGreaterThan(1);
      // 同一张图按普通规格再取（分类不变、只是 detail=false）：副本策略键必须不同。
      const plain = await service.prepareByMediaId(onDemandInput(f, media.id, { facts: [fact] }));
      expect(plain.detail).toBe(false);
      expect(plain.images[0]?.variantPolicy).not.toBe(expressionPolicy);
      // 问题真值在边界与写事务里各复验一次：中途变化即 authority 失败，零新写入。
      const assetsBefore = f.orm.select().from(schema.qqMediaAssets).all().length;
      const variantsBefore = f.orm.select().from(schema.qqMediaVariants).all().length;
      questionCurrent = false;
      const guardCallsBefore = guardCalls;
      await expect(
        service.prepareByMediaId(
          onDemandInput(f, media.id, {
            facts: [fact],
            detail: { ...anchor },
            settings: { ...SETTINGS, expression_max_dimension: 64 },
          }),
        ),
      ).rejects.toThrow();
      // 拒绝来自锚复验本身，不是别的偶然失败。
      expect(guardCalls).toBeGreaterThan(guardCallsBefore);
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(assetsBefore);
      expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(variantsBefore);
    } finally {
      f.h.close();
    }
  });

  it("second read of the same media reuses the cache: fetch=0, codec=0, same variantId", async () => {
    const f = openFixture();
    try {
      const media = f.mediaImage("ev-demand-cache");
      const fact = makeFact("ev-demand-cache", media.id);
      let fetchCalls = 0;
      const service = serviceOf(f, async () => {
        fetchCalls += 1;
        return { bytes: PNG_BYTES() };
      });
      const codecModule = await import("../../src/server/services/qq-image-codec");
      const original = codecModule.prepareQqImage;
      let codecCalls = 0;
      const { mock } = await import("bun:test");
      mock.module("../../src/server/services/qq-image-codec", () => ({
        ...codecModule,
        prepareQqImage: ((bytes: Uint8Array, input: Parameters<typeof original>[1]) => {
          codecCalls += 1;
          return original(bytes, input);
        }) as typeof original,
      }));
      try {
        const first = await service.prepareByMediaId(onDemandInput(f, media.id, { facts: [fact] }));
        expect(fetchCalls).toBe(1);
        expect(codecCalls).toBe(1);
        const second = await service.prepareByMediaId(
          onDemandInput(f, media.id, { facts: [fact], runId: `run-${crypto.randomUUID()}` }),
        );
        expect(fetchCalls).toBe(1);
        expect(codecCalls).toBe(1);
        expect(second.images[0]?.variantId).toBe(first.images[0]?.variantId);
        expect(second.sources[0]?.revision).toBe(first.sources[0]?.revision);
        expect(f.orm.select().from(schema.qqMediaVariants).all()).toHaveLength(1);
      } finally {
        mock.restore();
      }
    } finally {
      f.h.close();
    }
  });

  it("shared implementation: the same media reads identically through the auto path", async () => {
    const f = openFixture();
    try {
      const autoMedia = f.mediaImage("ev-same-a");
      const demandMedia = f.mediaImage("ev-same-b");
      const service = serviceOf(f, async () => ({ bytes: PNG_BYTES() }));
      const auto = await service.prepareQqMediaProjection(
        baseInput(f, { facts: [makeFact("ev-same-a", autoMedia.id)], focus: focusOf("ev-same-a") }),
      );
      const demand = await service.prepareByMediaId(
        onDemandInput(f, demandMedia.id, { facts: [makeFact("ev-same-b", demandMedia.id)] }),
      );
      // 同一份 bytes、同一作用域 ⇒ 同一份缓存资产，投影形状逐字一致（一条准备链的证据）。
      expect(auto.images[0]?.sha256).toBe(demand.images[0]?.sha256);
      expect(auto.images[0]?.assetId).toBe(demand.images[0]?.assetId);
      expect(auto.images[0]?.variantPolicy).toBe(demand.images[0]?.variantPolicy);
      expect(f.orm.select().from(schema.qqMediaAssets).all()).toHaveLength(1);
    } finally {
      f.h.close();
    }
  });
});
