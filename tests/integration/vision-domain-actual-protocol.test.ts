import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentRuntime,
  type LeafAgentRuntime,
  type VisionLeafInput,
} from "../../src/server/agent/agent-runtime";
import type { ModelContextBudget } from "../../src/server/agent/model-port";
import { createApp } from "../../src/server/app";
import {
  createQqMediaInputService,
  type QqMediaProjectionInput,
} from "../../src/server/channels/onebot11/media-input-service";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  readOrganizationSettings,
  updateOrganizationSettings,
} from "../../src/server/db/organization-repository";
import { recordMediaSegment } from "../../src/server/db/qq-media-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { importQqSticker } from "../../src/server/db/qq-sticker-repository";
import { ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { createLmStudioClient, type ModelGateway } from "../../src/server/llm/model-gateway";
import type { PreparedRequestFormat } from "../../src/server/llm/request-format";
import { loadTextTokenCounter } from "../../src/server/llm/text-token-counter";
import { createLmStudioVisionClient } from "../../src/server/llm/vision-client";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { checkQqModelCapacity } from "../../src/server/services/qq-capacity-preflight";
import { createQqMediaAdapter } from "../../src/server/services/qq-media-adapter";
import {
  annotateQqSticker,
  QQ_STICKER_ANNOTATION_RESPONSE_SCHEMA,
  type QqStickerAnnotatorInput,
} from "../../src/server/services/qq-sticker-annotation";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import type { QqEffectiveMediaPolicy } from "../../src/shared/contracts/qq-media-input";
import type { QqConversationScope, QqMessageFact } from "../../src/shared/contracts/qq-message";

const MODEL = "synthetic-vision";
const PNG_BYTES = new Uint8Array(encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(0x40), 8, 8));

const tempDirs: string[] = [];
const handles: ReturnType<typeof openBusinessDb>[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  for (const h of handles.splice(0)) {
    try {
      h.close();
    } catch {}
  }
});

async function mockBudget(model = MODEL): Promise<ModelContextBudget> {
  const counter = await loadTextTokenCounter("cl100k_base");
  return {
    model,
    capacity: 65536,
    tokenizerEncoding: counter.encoding,
    countText: counter.count,
    assertCurrent: () => {},
  };
}

describe("vision domain actual protocol wiring", () => {
  it("checkQqModelCapacity uses prepareVisionRequestFormat 4th arg and avoids collision with text gateway preparer", async () => {
    const budget = await mockBudget();
    let textPreparerCalled = false;
    let visionPreparerCalled = false;

    const baseGateway = createLmStudioClient({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: MODEL,
      timeoutSeconds: 5,
    });

    const testGateway: ModelGateway = {
      ...baseGateway,
      loadedContextCapacity: async () => 65536,
      prepareContextModel: async () => budget,
      prepareRequestFormat(input) {
        textPreparerCalled = true;
        return baseGateway.prepareRequestFormat!(input);
      },
    };

    const vision = createLmStudioVisionClient({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: MODEL,
      timeoutSeconds: 5,
    });

    const customVisionPreparer = (input: {
      model: string;
      responseSchema?: Record<string, unknown>;
    }) => {
      visionPreparerCalled = true;
      return vision.prepareRequestFormat!(input);
    };

    const schema = {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    };

    const check = await checkQqModelCapacity(
      testGateway,
      {
        model: MODEL,
        messages: [{ role: "user", content: "hello" }],
        outputReserved: 512,
        responseSchema: schema,
      },
      undefined,
      customVisionPreparer,
    );

    expect(check.kind).toBe("allowed");
    if (check.kind !== "allowed") throw new Error("not allowed");
    expect(textPreparerCalled).toBe(false);
    expect(visionPreparerCalled).toBe(true);
    expect(check.requestFormat).toBeDefined();
    expect(check.requestFormat?.schema).toEqual(schema);
    expect(check.requestFormat?.level).toBe("json_schema");
    expect(check.requestFormat?.tools).toBeUndefined();
  });

  it("checkQqModelCapacity preserves legacy behavior when prepareVisionRequestFormat is absent", async () => {
    const budget = await mockBudget();
    const check = await checkQqModelCapacity(
      {
        loadedContextCapacity: async () => 65536,
        prepareContextModel: async () => budget,
      },
      {
        model: MODEL,
        messages: [{ role: "user", content: "hello legacy" }],
        outputReserved: 512,
      },
    );

    expect(check.kind).toBe("allowed");
    if (check.kind !== "allowed") throw new Error("not allowed");
    expect(check.requestFormat).toBeUndefined();
    expect(check.inputUnits).toBeGreaterThan(0);
  });

  it("createQqMediaAdapter carries the prepared requestFormat into completeVisionLeaf", async () => {
    const budget = await mockBudget();
    const vision = createLmStudioVisionClient({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: MODEL,
      timeoutSeconds: 5,
    });
    let capturedInput: VisionLeafInput | undefined;

    const fakeRuntime: LeafAgentRuntime = {
      completeLeaf: async () => "",
      completeVisionLeaf: async (_spec, input) => {
        capturedInput = input;
        return "synthetic media description";
      },
    };

    const adapter = createQqMediaAdapter({
      prompt: "Describe this image",
      fetchSource: async () => ({ bytes: PNG_BYTES }),
      agentRuntime: fakeRuntime,
      loadedContextCapacity: async () => 65536,
      prepareContextModel: async () => budget,
      prepareVisionRequestFormat: vision.prepareRequestFormat?.bind(vision),
    });

    const result = await adapter.read({
      kind: "image",
      sourceRef: "test-ref",
      model: MODEL,
    });

    expect(result).toBe("synthetic media description");
    expect(capturedInput).toBeDefined();
    expect(capturedInput?.requestFormat).toBeDefined();
    expect(capturedInput?.requestFormat?.level).toBe("none");
    expect(capturedInput?.requestFormat?.schema).toBeUndefined();
  });

  it("annotateQqSticker propagates prepareVisionRequestFormat to check and annotator", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qq-vision-test-"));
    tempDirs.push(dir);
    const store = new QqStickerStore({ directory: dir });
    const h = openBusinessDb({ path: ":memory:" });
    handles.push(h);
    ensureDefaults(h.orm, MODEL);

    const assetId = "11111111-1111-4111-8111-111111111111";
    const copy = store.importCopy({ assetId, bytes: PNG_BYTES });
    const asset = importQqSticker(h.orm, {
      id: assetId,
      name: "test-sticker",
      copy,
      width: copy.width,
      height: copy.height,
    });

    const budget = await mockBudget();
    const vision = createLmStudioVisionClient({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: MODEL,
      timeoutSeconds: 5,
    });

    let annotatorReceivedFormat: PreparedRequestFormat | undefined;
    const annotator = async (input: QqStickerAnnotatorInput) => {
      annotatorReceivedFormat = input.requestFormat;
      return JSON.stringify({ description: "测试表情描述", tags: ["开心", "问候"] });
    };

    const result = await annotateQqSticker(
      h.orm,
      {
        loadedContextCapacity: async () => 65536,
        prepareContextModel: async () => budget,
      },
      annotator,
      store,
      { assetId: asset.id, visionModel: MODEL },
      undefined,
      vision.prepareRequestFormat?.bind(vision),
    );

    expect(result.kind).toBe("annotated");
    expect(annotatorReceivedFormat).toBeDefined();
    expect(annotatorReceivedFormat?.schema).toEqual(QQ_STICKER_ANNOTATION_RESPONSE_SCHEMA);
    expect(annotatorReceivedFormat?.level).toBe("json_schema");
  });

  it("createApp wires vision.prepareRequestFormat to real AgentRuntime, ModelPort, and VisionClient HTTP wire body end-to-end", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qq-app-vision-"));
    tempDirs.push(dir);
    const store = new QqStickerStore({ directory: dir });
    const h = openBusinessDb({ path: ":memory:" });
    handles.push(h);
    ensureDefaults(h.orm, MODEL);

    updateOrganizationSettings(h.orm, {
      model_name: MODEL,
      vision_model_name: MODEL,
      expected_revision: readOrganizationSettings(h.orm).revision,
    });

    const assetId = "22222222-2222-4222-8222-222222222222";
    const copy = store.importCopy({ assetId, bytes: PNG_BYTES });
    const asset = importQqSticker(h.orm, {
      id: assetId,
      name: "app-sticker",
      copy,
      width: copy.width,
      height: copy.height,
    });

    let capturedBody: Record<string, unknown> | undefined;
    const fakeFetch = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
      if (typeof init?.body === "string") {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({ description: "端到端真机描述", tags: ["真机", "同形"] }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const vision = createLmStudioVisionClient(
      {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: MODEL,
        timeoutSeconds: 5,
      },
      fakeFetch,
    );

    const runtime = createAgentRuntime({
      repository: new AgentRunRepository(h.db),
      vision,
    });

    const baseGateway = createLmStudioClient({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: MODEL,
      timeoutSeconds: 5,
    });

    const gateway: ModelGateway = {
      ...baseGateway,
      loadedContextCapacity: async () => 65536,
      prepareContextModel: async () => mockBudget(MODEL),
    };

    const app = createApp({
      business: h,
      qqStickerDirectory: dir,
      vision,
      agentRuntime: runtime,
      gateway,
    });

    const response = await app.request(`/qq/stickers/${asset.id}/annotate`, { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { kind: string; asset?: { description_draft: string } };
    expect(body.kind).toBe("annotated");
    expect(body.asset?.description_draft).toBe("端到端真机描述");

    expect(capturedBody).toBeDefined();
    expect(capturedBody?.model).toBe(MODEL);
    expect(capturedBody?.tools).toBeUndefined();
    expect(capturedBody?.stream).toBeUndefined();

    const responseFormat = capturedBody?.response_format as {
      type?: string;
      json_schema?: { name?: string; strict?: boolean; schema?: unknown };
    };
    expect(responseFormat).toBeDefined();
    expect(responseFormat.type).toBe("json_schema");
    expect(responseFormat.json_schema?.name).toBe("superstring_result");
    expect(responseFormat.json_schema?.strict).toBe(true);
    expect(responseFormat.json_schema?.schema).toEqual(QQ_STICKER_ANNOTATION_RESPONSE_SCHEMA);
  });

  it("createQqMediaInputService description flow wires capacity check, visionpreparer and output reserve: tiny capacity yields 0 vision inference, sufficient capacity completes with same snapshot and 1 fetch", async () => {
    const h = openBusinessDb({ path: ":memory:" });
    handles.push(h);
    ensureDefaults(h.orm, MODEL);

    const schemeId = "33333333-3333-4333-8333-333333333333";
    const bindingId = "44444444-4444-4444-8444-444444444444";
    const account = "20001";
    const peer = "10001";
    const agentId = "00000000-0000-0000-0000-000000000001";

    h.orm
      .insert(schema.qqSchemes)
      .values({
        id: schemeId,
        name: "test-scheme",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();

    h.orm
      .insert(schema.qqBindings)
      .values({
        id: bindingId,
        accountId: account,
        conversationKind: "group",
        peerId: peer,
        agentId,
        schemeId,
        paused: 0,
        shareWebMemory: 0,
        revision: 1,
        authorityRevision: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();

    updateQqSettings(h.orm, { enabled: true, accountId: account, expectedRevision: 1 });
    const journal = new ConversationEventRepository(h.db);
    const conversation = journal.ensureOneBot(bindingId);
    if (!conversation) throw new Error("conversation fixture missing");

    const scope: QqConversationScope = {
      conversationId: conversation.id,
      accountId: account,
      conversationKind: "group",
      peerId: peer,
      agentId,
      bindingId,
      bindingEpoch: conversation.bindingEpoch,
      authorityRevision: 1,
    };

    const occurred = Math.floor(Date.now() / 1000);
    const future = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const mediaSettings: QqEffectiveMediaPolicy = {
      mode: "description",
      stages: { decision: true, evaluation: true, generation: true },
      max_images: 8,
      ordinary_still_max_dimension: null,
      ordinary_frame_count: 3,
      ordinary_frame_max_dimension: 512,
    };
    const prepareMedia = (eventKey: string) => {
      const recordedAt = nowIso();
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey,
          accountId: account,
          conversationKind: "group",
          peerId: peer,
          agentId,
          messageId: `msg-${eventKey}`,
          occurredAtSeconds: occurred,
          speakerKind: "member",
          speakerId: "20002",
          recordedAt,
        })
        .run();
      h.orm
        .insert(schema.qqObservationText)
        .values({
          eventKey,
          body: "测试图片描述文本",
          occurredAtSeconds: occurred,
          expiresAt: future,
          recordedAt,
        })
        .run();
      journal.ingestOneBotEvent(eventKey, bindingId);
      const segment = recordMediaSegment(h.orm, {
        eventKey,
        segmentIndex: 0,
        kind: "image",
        sourceRef: `source-ref-${eventKey}`,
        occurredAtSeconds: occurred,
        addressed: true,
      });
      journal.append({
        conversationId: conversation.id,
        eventKey: `media-src:${segment.id}`,
        kind: "inbound",
        source: {
          kind: "qq_media",
          id: segment.id,
          revision: String(segment.attempts),
          expiresAt: segment.expiresAt,
        },
        sources: [
          { kind: "qq_event", id: eventKey, revision: recordedAt },
          {
            kind: "qq_media",
            id: segment.id,
            revision: String(segment.attempts),
            expiresAt: segment.expiresAt,
          },
        ],
        occurredAt: recordedAt,
      });
      const fact: QqMessageFact = {
        id: eventKey,
        platformMessageId: null,
        seq: 1,
        occurredAtSeconds: occurred,
        speaker: {
          role: "member",
          qq: "20002",
          groupCard: null,
          personalNickname: null,
          legacyDisplayName: null,
          nameState: "unknown",
        },
        parts: [{ kind: "image", mediaId: segment.id, category: "ordinary" }],
        mentions: [],
        replyTo: null,
        sources: [{ kind: "qq_event", id: eventKey, revision: recordedAt }],
        completeness: "full",
      };
      const input: QqMediaProjectionInput = {
        scope,
        phase: "generation",
        focus: {
          triggerMessageIds: [eventKey],
          responseMessageIds: [eventKey],
          responseQqs: ["20002"],
          assistantQq: "90009",
        },
        facts: [fact],
        replies: { roots: [], sources: [] },
        settings: mediaSettings,
        model: MODEL,
        now: recordedAt,
        runId: `run-${eventKey}`,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      };
      return { input, segment };
    };
    const tinyMedia = prepareMedia("ev-tiny-adapter-test");
    const sufficientMedia = prepareMedia("ev-sufficient-adapter-test");

    let fetchCount = 0;
    const sufficientBytes = new Uint8Array(
      encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(0x80), 8, 8),
    );
    const fetchSource = async ({ sourceRef }: { sourceRef: string }) => {
      fetchCount++;
      return { bytes: sourceRef.includes("sufficient") ? sufficientBytes : PNG_BYTES };
    };

    let visionCallCount = 0;
    let capturedBody: Record<string, unknown> | undefined;
    const fakeVisionFetch = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
      visionCallCount++;
      if (typeof init?.body === "string") {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "这是合成测试的图片描述" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const vision = createLmStudioVisionClient(
      {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: MODEL,
        timeoutSeconds: 5,
      },
      fakeVisionFetch,
    );

    const runtime = createAgentRuntime({
      repository: new AgentRunRepository(h.db),
      vision,
    });

    const budget = await mockBudget(MODEL);

    // 1) 极小容量（tiny capacity）：预检超限，必须 0 vision inference 调用
    const tinyService = createQqMediaInputService({
      store: { db: h.db, orm: h.orm },
      fetchSource,
      agentRuntime: runtime,
      prompt: "说明媒体内容。",
      modelConfig: { visionModelName: MODEL, transcriptionModelName: null },
      baselinePolicy: "baseline/v1/test-policy",
      auxiliary_allocation: { mode: "auto", output_reserved: 1024 },
      loadedContextCapacity: async () => 10, // 极小容量，必超
      prepareContextModel: async () => ({ ...budget, capacity: 10 }),
      prepareVisionRequestFormat: vision.prepareRequestFormat?.bind(vision),
    });

    const tinyResult = await tinyService.prepareQqMediaProjection(tinyMedia.input);
    expect(tinyResult.actualMode).toBe("unavailable");
    expect(tinyResult.notes).toHaveLength(0);
    expect(visionCallCount).toBe(0);
    expect(fetchCount).toBe(1);

    // 2) 充足容量（sufficient capacity）：预检通过，透传 actual descriptor / role output / raw format，完成 1 次且仅 1 次 HTTP 发送
    const sufficientService = createQqMediaInputService({
      store: { db: h.db, orm: h.orm },
      fetchSource,
      agentRuntime: runtime,
      prompt: "说明媒体内容。",
      modelConfig: { visionModelName: MODEL, transcriptionModelName: null },
      baselinePolicy: "baseline/v1/test-policy",
      auxiliary_allocation: { mode: "auto", output_reserved: 512 },
      loadedContextCapacity: async () => 65536,
      prepareContextModel: async () => budget,
      prepareVisionRequestFormat: vision.prepareRequestFormat?.bind(vision),
    });

    const sufficientResult = await sufficientService.prepareQqMediaProjection(
      sufficientMedia.input,
    );
    expect(sufficientResult.actualMode).toBe("description");
    expect(sufficientResult.notes).toHaveLength(1);
    expect(sufficientResult.notes[0]?.text).toBe("这是合成测试的图片描述");
    expect(sufficientResult.notes[0]?.mediaId).toBe(sufficientMedia.segment.id);
    expect(visionCallCount).toBe(1);
    expect(fetchCount).toBe(2); // One source read per independent media item.

    // 验证 HTTP 载荷：max_tokens 继承自 output_reserved (512)，tools/stream 缺席，无 strict 改写
    expect(capturedBody).toBeDefined();
    expect(capturedBody?.model).toBe(MODEL);
    expect(capturedBody?.max_tokens).toBe(512);
    expect(capturedBody?.tools).toBeUndefined();
    expect(capturedBody?.stream).toBeUndefined();
  });
});
