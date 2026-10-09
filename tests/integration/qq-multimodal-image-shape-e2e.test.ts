// 图片形状整链验证：真实平台 wire 到模型 wire。
//
// 红线：
//   * 全链走真实 OneBot → IntakeHost → AgentRuntime（createOneBotHarness + scriptedModel），
//     不建第二 harness、不造假 provider 服务；分类证据走真实平台 wire 归一（imageHint 三键）
//     而不是往 DB 里塞 category；
//   * 不读真实 data/local/artifacts/state、不联网、不触 17861、不启停服务；
//   * 模型可见的 image part 只有来源元数据（sourceId/revision/mimeType/sha256/尺寸/frameIndex），
//     每个整链块都断 wire 里**没有** bytes/base64/data/url。
//
// 各块设计（标题统一 S<id>_<序号>）：
//   [S25_1] native ordinary image 三相整链：三阶段各一次、同一 mediaId/sha、原图字节、
//           asset sha、call=3、无第 4 次分类调用
//   [S25_2] native ordinary image **真实 HTTP wire**（createLmStudioClient + createModelPort +
//           owned loopback port 0）：三相 body 的 ordered image_url data URL 与受控字节逐字相等、
//           决策 schema/tools 声明形状、持久面无 raw bytes
//   [S25_3] 非法来源强负（独立成例，不与合法路径共用 if/else）：无 resolver/runId/owner、
//           句柄未登记 → 真实 CONTEXT_SOURCE_INVALID，不是自造 code，也不是合法供应失败
//   [S26_1] 平台 market face 三键 → expression 证据 → 512 规格 + 表情只用文本角色无数值 attention
//           + 未知提示（仅 summary）不能猜表情
//   [S28_1] 明确细问表情升普通规格（按需服务 prepareByMediaId + detail 问题锚，**辅助**块）。
//   [S28_2] 真实 host 工具链：
//           media.list → media.read(questionMessageId=focus 平台 ID) → native detail 按
//           ordinary 规格准备 → 模型下一步看到 ordinary 规格元数据；分类不改变。
//   [S28_3] 拒绝对照：questionMessageId 指向无关消息（非 focus、非 focus 直接引用目标）→
//           宿主锚解析拒绝，真实 CONTEXT_INVALID_SELECTION，零 detail 副本。
//   [S29_1] face 平台 ID/名称原位、不走 vision（用真实 wire 直测 intake + 投影排除点）
//   [S30_1] 默认 8 张上限：9 张不同图，8 上 wire、第 9 张真实 omission（观测面＝onDiagnostic
//           诊断事件 mediaId+reason，非持久 span API；facts: 9 段 messageId 全保留）+ 稳定序取舍 + 窗口文字不牺牲
//   [S31_1] 两条消息共享同字节：asset/variant 层去重（1 asset / 2 links / 1 variant 共享缓存），
//           两条消息关系不丢；来源字节缓存按 mediaId 各取一次是真实实现，不伪称 fetch=1
//   [S32_1] GIF 3 帧 disposal 正确合成：真实原生 wire、源帧序号、逐像素读回、有限帧声明
//   [S33_1] 动画 WebP/APNG 真实 codec 判定 unsupported_animation（decoder 边界辅助块）：
//           真实 QqImagePrepareError，不存在自造 code，静帧/GIF 对照

import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import http from "node:http";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { eq } from "drizzle-orm";
import upstream from "omggif";
import { createQqMediaInputService } from "../../src/server/channels/onebot11/media-input-service";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { AppError } from "../../src/server/errors";
import { toGatewayMessages } from "../../src/server/llm/chat-content";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { prepareQqImage } from "../../src/server/services/qq-image-codec";
import { QqImagePrepareError } from "../../src/server/services/qq-image-error";
import { recordInbound } from "../../src/server/services/qq-intake";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { QqEffectiveMediaPolicy } from "../../src/shared/contracts/qq-media-input";
import type {
  QqConversationScope,
  QqMessageFact,
  QqMessageFocus,
  QqMessagePart,
} from "../../src/shared/contracts/qq-message";
import { createEphemeralAgentRuntime } from "../harness/ephemeral-runtime";
import { batchScore, decideGenerate, decideInvoke, decideNone, say } from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";
import { driveToolFirst } from "../harness/scenarios";

afterEach(() => {
  closeHarnesses();
});

// ---- 共享小工具（仅本文件内，不构成第二 harness/第二模型链） ------------------------------

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** 8x8 合成的不同灰度静图：每张图字节不同，便于按 sha 区分"哪张图真的上了 wire"。 */
const pngOf = (fill: number, width = 8, height = 8): Uint8Array =>
  encodeQqFramePng(new Uint8Array(width * height * 4).fill(fill), width, height);

/** 平台 market face 三键（规格 §7.2 唯一可靠的平台表情证据形态）。 */
const MARKET_FACE = {
  summary: "[萌宠]",
  key: "synthetic-secret-key",
  emoji_id: "00abc123",
  emoji_package_id: "8",
} as const;

const phases = (h: OneBotHarness): string[] => (h.model?.calls ?? []).map((call) => call.phase);

/** 某次调用输入的全文拼接（模型可见材料的断言面）。 */
const callText = (h: OneBotHarness, index: number): string =>
  (h.model?.receivedMessages[index]?.messages ?? [])
    .flatMap((message) =>
      message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
    )
    .join("\n");

interface WireImage {
  readonly mediaId: string;
  readonly revision: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly frameIndex: number | null;
}

/** 某次调用输入里的全部 image part（按出现顺序，不去重——动图同 mediaId 多帧要全看）。 */
const wireImages = (h: OneBotHarness, index: number): WireImage[] =>
  (h.model?.receivedMessages[index]?.messages ?? []).flatMap((message) =>
    message.content.flatMap((part) =>
      part.kind === "image"
        ? [
            {
              mediaId: String(part.sourceId),
              revision: String(part.revision),
              mimeType: String(part.mimeType),
              sha256: String(part.sha256),
              width: Number(part.width),
              height: Number(part.height),
              frameIndex: part.frameIndex === undefined ? null : Number(part.frameIndex),
            },
          ]
        : [],
    ),
  );

const distinctMediaOnWire = (h: OneBotHarness, index: number): number =>
  new Set(wireImages(h, index).map((image) => image.mediaId)).size;

/**
 * 规格 §10 红线：持久 ModelMessage 的 image 部分只带来源元数据，没有 bytes/base64/data/url。
 * 逐块调用——它不是恒真断言，part 上多一个键就会红。
 */
const noBytesOnWire = (h: OneBotHarness): void => {
  for (const call of h.model?.receivedMessages ?? []) {
    for (const message of call.messages) {
      for (const part of message.content) {
        if (part.kind !== "image") continue;
        for (const forbidden of ["bytes", "base64", "data", "url", "path", "file"]) {
          expect(Object.keys(part)).not.toContain(forbidden);
        }
      }
    }
  }
};

/** 解出「QQ消息事实」信封的未转义渲染文本。 */
const factsSegments = (text: string): string[] => {
  const out: string[] = [];
  const pattern = /\{"facts":("(?:[^"\\]|\\.)*"),"kind":"qq_message_facts"/g;
  for (const match of text.matchAll(pattern)) {
    try {
      out.push(JSON.parse(match[1] ?? '""') as string);
    } catch {
      // 解不开的信封不伪造：跳过（外层断言自然失败并留现场）。
    }
  }
  return out;
};

const factsText = (h: OneBotHarness, index: number): string =>
  factsSegments(callText(h, index)).join("\n");

/** 事实信封里所有 image part 的 category（模型看到的"平台分类"证据）。 */
const factCategories = (facts: string): string[] =>
  [...facts.matchAll(/"kind":"image","mediaId":"[^"]*","category":"([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );

/** 事实信封里所有 face part 的原样 JSON（name 是否可核实）。 */
const factFaces = (facts: string): string[] =>
  [...facts.matchAll(/\{"kind":"face"[^}]*\}/g)].map((match) => match[0]);

/** 媒体形状相关的真实表行（列名全部来自 migration 0052 / 0012，不猜）。 */
const rowsOf = (h: OneBotHarness, sql: string): Record<string, unknown>[] =>
  h.db.query(sql).all() as Record<string, unknown>[];

const assetRows = (h: OneBotHarness): Record<string, unknown>[] =>
  rowsOf(h, "SELECT id, content_sha256, mime_type, width, height FROM qq_media_assets ORDER BY id");

const variantRows = (h: OneBotHarness): Record<string, unknown>[] =>
  rowsOf(
    h,
    "SELECT policy, mime_type, width, height, frame_count, frames FROM qq_media_variants ORDER BY policy",
  );

const assetSourceRows = (h: OneBotHarness): Record<string, unknown>[] =>
  rowsOf(
    h,
    "SELECT id, asset_id, media_note_id FROM qq_media_asset_sources ORDER BY media_note_id",
  );

/** 真实 fetch 次数：受控 bytes 桥每被取一次加一（harness 的 fetchHook 唯一入口，不改 harness）。 */
const fetchCounter = (): FetchCounter => {
  const state = {
    count: 0,
    hook: async () => {
      state.count += 1;
    },
  };
  return state;
};

interface FetchCounter {
  count: number;
  hook: () => Promise<void>;
}

const assetShaFor = (h: OneBotHarness, shaValue: string): Record<string, unknown> | undefined =>
  assetRows(h).find((row) => row.content_sha256 === shaValue);

/** 第 index 个准备副本的真实字节（按 policy 的 #f<序号> 顺序，与 wire 帧序一致）。 */
function storedVariantBytes(h: OneBotHarness, index: number): Uint8Array {
  const row = h.db
    .query("SELECT bytes FROM qq_media_variants ORDER BY policy ASC LIMIT 1 OFFSET ?")
    .get(index) as { bytes: ArrayBufferLike } | null;
  if (!row) throw new Error(`variant ${index} missing`);
  return new Uint8Array(row.bytes);
}

it("[S25_1] a native ordinary image flows the real platform wire through all three phases", async () => {
  // 平台 wire：普通图**没有** market face 三键 → 协议层不判分类 → intake 记 unknown。
  // 分类证据因此来自 wire 事实，不是往 DB 里塞 category（规格 §7.2）。
  const bytes = pngOf(64);
  const fetches = fetchCounter();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "s25-image": bytes },
    fetchHook: fetches.hook,
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  h.receive({
    id: "-901",
    speaker: "10001",
    text: "这张图片里有什么？",
    groupCard: "阿林",
    image: "s25-image",
  });
  h.model?.push([
    batchScore([
      { targetId: "10001", score: 6, intent: "想回答图片问题", sourceSeqs: [h.lastEventSeq] },
    ]),
    decideGenerate("10001", "回答当前消息的图片问题", []),
    say("合成回复正文"),
  ]);
  h.advance(31);
  await h.activate("chiming_in");
  await h.deliver();

  // 批评分/回复决策/生成各一次——不新增固定分类调用（矩阵 negativeEvidence：call=3、无第 4 次）。
  expect(h.model?.calls.length).toBe(3);
  expect(phases(h)).toEqual(["next", "next", "generate"]);
  expect(h.sent).toHaveLength(1);

  // 三相都真的带着同一张图，且是同一 mediaId 的同一来源 revision。
  for (const index of [0, 1, 2]) {
    const images = wireImages(h, index);
    expect(images.length).toBe(1);
    expect(images[0]?.sha256).toBe(sha(bytes));
    expect(images[0]?.mimeType).toBe("image/png");
    expect(images[0]?.width).toBe(8);
    expect(images[0]?.height).toBe(8);
    // 普通静图：null 长边＝原图优先，规格不变形（§7.4 表第一行）。
    expect(images[0]?.frameIndex).toBeNull();
  }
  const mediaIds = wireImages(h, 0).map((image) => image.mediaId);
  expect(new Set(mediaIds)).toEqual(new Set(wireImages(h, 2).map((image) => image.mediaId)));
  noBytesOnWire(h);

  // 来源元数据的 sha 就是真实字节 sha（不是文件名、不是 URL 猜测）。
  const asset = assetShaFor(h, sha(bytes));
  expect(asset).toBeDefined();
  expect(asset?.mime_type).toBe("image/png");
  // 一个 asset、一次真实取字节（第二三相走缓存：fetch 仍为 1）。
  expect(assetRows(h)).toHaveLength(1);
  expect(fetches.count).toBe(1);
});

it("[S25_2] the native decision/score/generation calls reach real HTTP with the image's bytes on the wire", async () => {
  // S25 的**真实 wire**半边：metadata 快照不能证明 wire 上真有画面。
  // 这里用产品真实网关（createLmStudioClient）+ 产品真实端口（createModelPort）打到 owned
  // loopback（127.0.0.1 port 0，finally close），捕获三相 HTTP body。合法请求必须真的发图；
  // 非法来源的强负独立成 [S25_3]，不与本块共用 if/else（合法路径不许"失败也 green"）。
  const bytes = pngOf(64);
  const base64OfBytes = Buffer.from(bytes).toString("base64");
  const fetches = fetchCounter();
  const captures: string[] = [];
  const { server, port } = await startCaptureLoopback(captures);
  try {
    const { createLmStudioClient } = await import("../../src/server/llm/model-gateway");
    const { createModelPort } = await import("../../src/server/agent/model-port");
    const gateway = createLmStudioClient({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "reply-model",
      timeoutSeconds: 5,
    });
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      mediaEnabled: true,
      mergeWindowSeconds: 0,
      mediaInput: { mode: "native" },
      imageBytes: { "s25w-image": bytes },
      fetchHook: fetches.hook,
      initiativeBatchTargetCount: 1,
      initiativeBatchJitterCount: 0,
      model: createModelPort({ gateway }),
    });
    try {
      h.receive({
        id: "-921",
        speaker: "10001",
        text: "这张图片里有什么？",
        groupCard: "阿林",
        image: "s25w-image",
      });
      h.advance(31);
      await h.activate("chiming_in");
      await h.deliver();
      expect(h.sent).toHaveLength(1);

      // 批评分/回复决策/生成三相各一条真实 HTTP 调用。
      expect(captures).toHaveLength(3);
      const bodies = captures.map(
        (raw) =>
          JSON.parse(raw) as {
            model?: string;
            tools?: unknown;
            messages?: Array<{ role: string; content: unknown }>;
            response_format?: { json_schema?: { schema?: Record<string, unknown> } };
          },
      );
      const schemaOf = (body: (typeof bodies)[number]) => body.response_format?.json_schema?.schema;
      const phaseOf = (
        body: (typeof bodies)[number],
      ): "decision" | "evaluation" | "score" | "text" => {
        const schema = schemaOf(body);
        const props = schema?.properties as Record<string, unknown> | undefined;
        if (props?.evaluations) return "evaluation";
        if (props?.scoreResult) return "score";
        if (props?.text) return "text";
        return "decision";
      };
      expect(bodies.map(phaseOf)).toEqual(["evaluation", "decision", "text"]);

      let sawImage = false;
      for (const body of bodies) {
        // system 打头；图片以 data URL 出现且与受控字节逐字相等（发送边界组装，无第二来源）。
        expect(body.messages?.[0]?.role).toBe("system");
        for (const message of body.messages ?? []) {
          if (typeof message.content === "string") continue;
          const parts = message.content as Array<{ type: string; image_url?: { url: string } }>;
          for (const part of parts) {
            if (part.type !== "image_url") continue;
            sawImage = true;
            expect(part.image_url?.url).toBe(`data:image/png;base64,${base64OfBytes}`);
            // 有序片段：wire 上只出现 text / image_url 两种 part（wire 序 = 消息 content 序）。
            expect(
              parts.every(
                (candidate) => candidate.type === "text" || candidate.type === "image_url",
              ),
            ).toBe(true);
          }
        }
      }
      expect(sawImage).toBe(true);

      // 声明形状（本地路由）：批评分带 evaluations schema、回复决策带 oneOf 决策分支，均无 native tools。
      const evaluationSchema = schemaOf(bodies[0] ?? {}) as {
        properties?: Record<string, unknown>;
      };
      expect(evaluationSchema?.properties?.evaluations).toBeDefined();
      expect(bodies[0]?.tools).toBeUndefined();
      const decisionSchema = schemaOf(bodies[1] ?? {}) as { oneOf?: unknown } | undefined;
      expect(Array.isArray(decisionSchema?.oneOf)).toBe(true);
      expect(bodies[1]?.tools).toBeUndefined();

      // 来源真落库：一个 asset，sha 等于受控字节 sha；一次真实取字节（后两相走缓存）。
      expect(fetches.count).toBe(1);
      expect(assetShaFor(h, sha(bytes))).toBeDefined();
      expect(assetRows(h)).toHaveLength(1);

      // 持久面强负：wire 上合法的 data URL/base64 绝不落任何持久面（规格 §10）。
      const persisted = [
        JSON.stringify(rowsOf(h, "SELECT * FROM qq_message_facts")),
        JSON.stringify(rowsOf(h, "SELECT * FROM qq_events")),
        JSON.stringify(rowsOf(h, "SELECT * FROM conversation_events")),
        JSON.stringify(rowsOf(h, "SELECT * FROM agent_runs")),
      ].join("\n");
      expect(persisted).not.toContain("data:image");
      expect(persisted).not.toContain(base64OfBytes);
    } finally {
      h.close();
    }
  } finally {
    server.close();
  }
});

it("[S25_3] an illegal image source is refused with the real code, as its own negative", async () => {
  // 强负独立成例：不是"合法供应失败也 pass"的 if/else，而是直接对
  // wire 转换边界（toGatewayMessages，completion 与 stream 共用的唯一转换）喂**非法输入**：
  //   1) 图片 part 缺可信 resolver/runId/owner 三件套 → 真实 CONTEXT_SOURCE_INVALID；
  //   2) resolver 有、句柄未登记（伪造/跨 run 的 part）→ 真实 CONTEXT_SOURCE_INVALID。
  // 两条都是产品代码自己抛的真实 AppError，不是测试自造 code，也绝不能冒充
  // MODEL_IMAGE_UNSUPPORTED（能力问题）或 MEDIA_PREPARE_FAILED（不存在的 code）。
  const imagePart = {
    kind: "image" as const,
    sourceId: "media-illegal",
    revision: "rev-1",
    mimeType: "image/png",
    sha256: sha(pngOf(11)),
  };
  const messages = [
    {
      role: "user" as const,
      content: [{ kind: "text" as const, text: "看图" }, imagePart],
    },
  ];

  // 1) 缺 resolver/runId/owner：wire 转换直接拒绝，请求不该被发出。
  let missing: unknown = null;
  try {
    await toGatewayMessages({ messages });
  } catch (error) {
    missing = error;
  }
  expect(missing).toBeInstanceOf(AppError);
  expect((missing as AppError).code).toBe("CONTEXT_SOURCE_INVALID");
  expect((missing as AppError).statusCode).toBe(409);

  // 2) 句柄未登记：resolver 存在但这个 part 从未 register（伪造 sourceId/revision 全都取不到）。
  const { createImageByteResolver } = await import("../../src/server/agent/image-byte-resolver");
  const resolver = createImageByteResolver();
  let unregistered: unknown = null;
  try {
    await toGatewayMessages({
      messages,
      runId: "run-illegal",
      owner: { kind: "conversation", id: "conv-illegal", userId: "u", agentId: "a" },
      imageResolver: resolver,
      signal: new AbortController().signal,
    });
  } catch (error) {
    unregistered = error;
  }
  expect(unregistered).toBeInstanceOf(AppError);
  expect((unregistered as AppError).code).toBe("CONTEXT_SOURCE_INVALID");

  // 两个负例都不是能力/prepare 语义：真实产品里不存在 MEDIA_PREPARE_FAILED 这个 code，
  // wire 边界的来源问题不归到 MODEL_IMAGE_UNSUPPORTED。
  for (const error of [missing, unregistered]) {
    expect((error as AppError).code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
    expect(String((error as Error).message)).not.toContain("MEDIA_PREPARE_FAILED");
  }
});

/** owned loopback：port 0 / 127.0.0.1 / finally close；/models 与 /chat/completions 全拦。 */
async function startCaptureLoopback(captures: string[]): Promise<{ server: Server; port: number }> {
  const server: Server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "reply-model" }, { id: "judge-model" }] }));
      return;
    }
    if (req.url?.endsWith("/chat/completions")) {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      req.on("end", () => {
        captures.push(raw);
        let parsed: {
          stream?: boolean;
          response_format?: { json_schema?: { schema?: Record<string, unknown> } };
        } = {};
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          parsed = {};
        }
        if (parsed.stream === true) {
          const delta = JSON.stringify({
            choices: [{ delta: { content: loopbackReply(parsed) } }],
          });
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${delta}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: loopbackReply(parsed) } }],
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return { server, port: address.port };
}

function loopbackReply(parsed: {
  response_format?: { json_schema?: { schema?: Record<string, unknown> } };
  messages?: Array<{ role: string; content: unknown }>;
}): string {
  const schema = parsed.response_format?.json_schema?.schema as
    | {
        properties?: Record<string, unknown>;
        oneOf?: readonly unknown[];
      }
    | undefined;
  const properties = schema?.properties;
  const oneOf = schema?.oneOf;
  if (properties?.evaluations !== undefined) {
    // 批评分协议：目标与可引用 seq 真正从请求里的 qq_batch_targets data dump 读回（不猜）。
    const targets: Array<{ targetId: string; sourceSeqs: number[] }> = [];
    for (const message of parsed.messages ?? []) {
      const texts =
        typeof message.content === "string"
          ? [message.content]
          : Array.isArray(message.content)
            ? message.content.map((part) =>
                part !== null && typeof part === "object" && "text" in part
                  ? String((part as { text: unknown }).text)
                  : "",
              )
            : [];
      for (const text of texts) {
        const trimmed = text.trim();
        if (!trimmed.startsWith("{") || !trimmed.includes('"qq_batch_targets"')) continue;
        try {
          const dump = JSON.parse(trimmed) as {
            sourceSeqs: number[];
            targets?: Array<{ targetId: string }>;
          };
          for (const target of dump.targets ?? [])
            targets.push({ targetId: target.targetId, sourceSeqs: [...dump.sourceSeqs] });
        } catch {
          // 解不开的 dump 不伪造：targets 保持为空，宿主按目标缺失协议报错留现场。
        }
      }
    }
    return JSON.stringify({
      evaluations: targets.map((target) => ({
        targetId: target.targetId,
        score: 6,
        intent: "想回答图片问题",
        sourceSeqs: target.sourceSeqs,
      })),
    });
  }
  if (properties?.scoreResult !== undefined) {
    return JSON.stringify({ scoreResult: { score: 6 }, media: [] });
  }
  if (properties?.score !== undefined) {
    return JSON.stringify({ score: 6, reason: "ok" });
  }
  if (properties?.text !== undefined) {
    return JSON.stringify({ text: "合成回复正文", media: [] });
  }
  if (oneOf !== undefined) {
    const hasMediaBranch = oneOf.some(
      (branch) =>
        branch !== null &&
        typeof branch === "object" &&
        (branch as { properties?: { media?: unknown } }).properties?.media !== undefined,
    );
    return hasMediaBranch
      ? JSON.stringify({
          decision: {
            kind: "final",
            outputs: [
              { kind: "generate", targetId: "10001", instructions: "回答", stickerIds: [] },
            ],
          },
          media: [],
        })
      : JSON.stringify({
          kind: "final",
          outputs: [{ kind: "generate", targetId: "10001", instructions: "回答", stickerIds: [] }],
        });
  }
  return "合成回复正文";
}

it("[S26_1] a real market-face wire segment is the platform expression evidence and gets the 512 spec", async () => {
  // 三键同现且均为非空 string → 协议层判 expression；facts 里 category 必须是 expression，
  // 且 categorySource 是 platform（不是 unknown、不是模型补判）。
  const bytes = pngOf(96, 1024, 768);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["一个表情包"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "s26-face": bytes },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  h.receive({
    id: "-911",
    speaker: "10001",
    text: "这个表情什么意思",
    groupCard: "阿林",
    image: "s26-face",
    imageHint: { ...MARKET_FACE },
  });
  h.model?.push([
    batchScore([
      { targetId: "10001", score: 6, intent: "想接这个表情的话", sourceSeqs: [h.lastEventSeq] },
    ]),
    decideGenerate("10001", "看看这个表情", []),
    say("合成回复正文"),
  ]);
  h.advance(31);
  await h.activate("chiming_in");
  await h.deliver();

  expect(h.sent).toHaveLength(1);
  const facts = factsText(h, 0);
  // 平台证据真的进了事实：category=expression，且只有一个候选类别（不是 unknown）。
  expect(factCategories(facts)).toContain("expression");
  expect(factCategories(facts)).not.toContain("unknown");

  // 表情静图按 §7.4 表：长边 512，不放大小图 —— 1024x768 变 512x384。
  const images = wireImages(h, 0);
  expect(images.length).toBe(1);
  expect(images[0]?.width).toBe(512);
  expect(images[0]?.height).toBe(384);
  expect(images[0]?.mimeType).toBe("image/png");
  // 缩放重编后 sha 不再等于原图（原图 sha 只落在 asset 上，两层各自可核）。
  expect(images[0]?.sha256).not.toBe(sha(bytes));
  expect(assetShaFor(h, sha(bytes))).toBeDefined();
  noBytesOnWire(h);

  // 矩阵 negativeEvidence：格式/动图/小尺寸/带字都不得单独证明表情类别。
  // 同一张普通图（无三键）走相同 1024x768 尺寸 → 走普通规格＝原图，不缩到 512。
  const plain = pngOf(96, 1024, 768);
  const h2 = createOneBotHarness({
    accountId: "90002",
    member: "10001",
    mediaEnabled: true,
    vision: ["一个表情包"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "s26-plain": plain },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  h2.receive({
    id: "-912",
    speaker: "10001",
    text: "这张图是什么",
    groupCard: "阿林",
    image: "s26-plain",
    // 只有 summary（带字）——不构成三键，不得判表情。
    imageHint: { summary: "[萌宠]", key: "synthetic-secret-key", sub_type: 1, type: "flash" },
  });
  h2.model?.push([
    batchScore([
      { targetId: "10001", score: 6, intent: "想问这张图", sourceSeqs: [h2.lastEventSeq] },
    ]),
    decideGenerate("10001", "看看这张图", []),
    say("合成回复正文二"),
  ]);
  h2.advance(31);
  await h2.activate("chiming_in");
  await h2.deliver();
  expect(h2.sent).toHaveLength(1);
  expect(factCategories(factsText(h2, 0))).toContain("unknown");
  const plainImages = wireImages(h2, 0);
  expect(plainImages[0]?.width).toBe(1024);
  expect(plainImages[0]?.height).toBe(768);
  expect(plainImages[0]?.sha256).toBe(sha(plain));

  // 表情只用文本角色表达，模型输入里不出现任何数值 attention 字段（规格 §2.10/§7.3）。
  const promptText = `${callText(h, 0)}\n${callText(h, 1)}`;
  expect(promptText).not.toMatch(/attention/i);
  expect(promptText).not.toMatch(/"attention"\s*:/);
});

/**
 * 真实多段平台 wire 入站：一条消息带任意多个 image 段（harness 的 `receive` 一次只送一段，
 * 而本文件不改 harness、不造第二 harness）。
 *
 * 走的是与生产**同一条**路径：`normalizeOneBotMessage` 归一 → `recordInbound` 摄入，
 * 所以平台分类证据、mediaId 分配、fact parts 顺序全部是真实实现的结果，不往 DB 里塞
 * category、不手动插 media 行。
 */
function receiveWire(
  h: OneBotHarness,
  input: {
    readonly id: string;
    readonly speaker: string;
    readonly text?: string;
    readonly imageFiles?: readonly string[];
    readonly imageHints?: readonly Record<string, unknown>[];
    readonly addressed?: boolean;
    readonly groupCard?: string;
    readonly faces?: readonly string[];
  },
): void {
  const binding = h.orm.select().from(schema.qqBindings).where(eqBinding(h.bindingId)).get();
  if (!binding) throw new Error("harness binding missing");
  const payload = {
    post_type: "message",
    time: Math.floor(Date.parse(h.now()) / 1000),
    self_id: Number(binding.accountId),
    user_id: Number(input.speaker),
    message_id: Number(input.id),
    message_type: "group",
    sub_type: "normal",
    group_id: Number(binding.peerId),
    sender: {
      nickname: input.speaker,
      ...(input.groupCard === undefined ? {} : { card: input.groupCard }),
    },
    message: [
      ...(input.addressed ? [{ type: "at", data: { qq: binding.accountId } }] : []),
      ...(input.faces ?? []).map((id) => ({ type: "face", data: { id } })),
      ...(input.imageFiles ?? []).map((file, index) => ({
        type: "image",
        data: { file, ...(input.imageHints?.[index] ?? {}) },
      })),
      { type: "text", data: { text: input.text ?? "hello" } },
    ],
  };
  const normalized = normalizeOneBotMessage(payload, binding.accountId);
  if (normalized.kind !== "message") throw new Error("wire message expected to normalize");
  recordInbound(h.orm, normalized, {
    accountId: binding.accountId,
    conversationIngress: h.adapter,
  });
}

function eqBinding(bindingId: string) {
  return eq(schema.qqBindings.id, bindingId);
}

it("[S30_1] the default eight-image cap supplies eight and marks the ninth not_supplied, keeping window text", async () => {
  // 一条焦点消息带 9 个**字节不同**的普通图段（真实 wire，非 DB 造事实）。
  const fetches = fetchCounter();
  const files: string[] = [];
  const bytesByFile: Record<string, Uint8Array> = {};
  // imageBytes 必须在建夹具时给全，所以先算好 9 张再构造夹具。
  for (let index = 0; index < 9; index += 1) {
    const key = `s30-${index}`;
    files.push(key);
    bytesByFile[key] = pngOf(10 + index);
  }
  const diagnostics: { stage: string; details?: Record<string, unknown> }[] = [];
  const h2 = createOneBotHarness({
    accountId: "90002",
    member: "10001",
    mediaEnabled: true,
    vision: ["合成图片描述"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: bytesByFile,
    fetchHook: fetches.hook,
    model: [decideGenerate("10001", "回答这些图", []), say("合成回复正文")],
    onDiagnostic: (event) => {
      if (event.stage === "media_mode") diagnostics.push(event);
    },
  });
  receiveWire(h2, {
    id: "-1009",
    speaker: "10001",
    text: "这九张图分别是啥WINDOWTEXT",
    groupCard: "阿林",
    addressed: true,
    imageFiles: files,
  });
  await h2.activate("direct_reply");
  await h2.deliver();

  expect(h2.sent).toHaveLength(1);
  // 恰好 8 个不同来源上了 wire；第 9 个来源不在 wire 上。
  expect(distinctMediaOnWire(h2, 0)).toBe(8);
  const supplied = wireImages(h2, 0);
  expect(new Set(supplied.map((image) => image.sha256)).size).toBe(8);
  // 只为 8 张取了字节：被舍弃的那张连 fetch 都没发生（不占预算、不降质）。
  expect(fetches.count).toBe(8);
  // 9 张图的存在都还在事实里：被舍弃不是"不存在"，是"未提供"。
  const facts = factsText(h2, 0);
  expect((facts.match(/"kind":"image","mediaId":"[^"]*","category":"[^"]+"/g) ?? []).length).toBe(
    9,
  );
  // 窗口文字不牺牲（矩阵 negativeEvidence）。
  expect(facts).toContain("这九张图分别是啥WINDOWTEXT");
  noBytesOnWire(h2);

  // 真实 omission（观测面＝harness onDiagnostic 收到的宿主 media_mode 诊断事件，不改生产
  // 字段；这是诊断事件流，不是已落库的持久 RuntimeTelemetry/span API）：第 9 张按稳定序被
  // 取舍，决策与生成相都带 mediaId+reason="not_supplied" 的真实记录；messageId 关系在
  // facts 里全量保留（上面 9 段 image part 就是各消息的 mediaId/messageId 关系，未因取舍丢失）。
  const omissionsOf = (
    diags: { details?: Record<string, unknown> }[],
  ): {
    mediaId: string;
    reason: string;
  }[] =>
    diags.flatMap((diag) =>
      Object.entries(diag.details ?? {})
        .filter(([key]) => key.startsWith("omission:"))
        .map(([, value]) => JSON.parse(String(value)) as { mediaId: string; reason: string }),
    );
  const omittedSha = sha(bytesByFile["s30-8"] as Uint8Array);
  const decisionOmissions = omissionsOf(diagnostics.filter((d) => d.details?.phase === "decision"));
  expect(decisionOmissions.length).toBeGreaterThanOrEqual(1);
  expect(decisionOmissions.some((o) => o.reason === "not_supplied")).toBe(true);
  const suppliedShas = new Set(supplied.map((image) => image.sha256));
  // 被舍弃的那张＝唯一不在 wire 上的 sha（稳定序：s30-0..7 上 wire，s30-8 被舍）。
  const allShas = files.map((key) => sha(bytesByFile[key] as Uint8Array));
  const missing = allShas.filter((value) => !suppliedShas.has(value));
  expect(missing).toEqual([omittedSha]);
  expect(supplied.map((image) => image.sha256)).toEqual(allShas.slice(0, 8));

  // 9 张全部上 wire 的情况：规格真被当作上限，不是恰好只有 8 张可选。
  const wide = { ...bytesByFile };
  const h3 = createOneBotHarness({
    accountId: "90003",
    member: "10001",
    mediaEnabled: true,
    vision: ["合成图片描述"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native", max_images: 9 },
    imageBytes: wide,
    model: [decideGenerate("10001", "回答这些图", []), say("合成回复正文三")],
  });
  receiveWire(h3, {
    id: "-1009",
    speaker: "10001",
    text: "这九张图分别是啥WINDOWTEXT",
    groupCard: "阿林",
    addressed: true,
    imageFiles: files,
  });
  await h3.activate("direct_reply");
  await h3.deliver();
  expect(h3.sent).toHaveLength(1);
  expect(distinctMediaOnWire(h3, 0)).toBe(9);
});

it("[S31_1] two messages sharing one byte-identical image dedupe to one asset yet keep both relations", async () => {
  // 同一条 wire 的两次入站引用同一张图：同 scope + 同 sha → 一条 asset；两次都是
  // 独立 mediaId（媒体身份按消息片段），关系不因去重丢掉（规格 §8.2 + §4.1）。
  const shared = pngOf(77);
  const fetches = fetchCounter();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["合成图片描述"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "s31-shared": shared },
    fetchHook: fetches.hook,
    model: [decideGenerate("10001", "回答", []), say("合成回复正文")],
  });
  h.receive({
    id: "-1101",
    speaker: "20002",
    text: "先看这张SHAREDTAG",
    groupCard: "甲",
    image: "s31-shared",
  });
  h.receive({
    id: "-1102",
    speaker: "10001",
    text: "再看同一张SHAREDTAG",
    groupCard: "阿林",
    image: "s31-shared",
    addressed: true,
    replyTo: "-1101",
  });
  await h.activate("direct_reply");
  await h.deliver();

  expect(h.sent).toHaveLength(1);
  // 每个媒体行各自取一次源字节（source 缓存按 mediaId 走），但字节**去重**发生在 asset：
  // 同一 scope + 同一 sha 只是一条资产，不是两条副本。矩阵 negativeEvidence 的"一次 bytes
  // 只取一次"在本产品实现里落在 asset/variant 层（见下面 assetRows 与 wire 断言），
  // fetch 层的每行一次如实记录，不伪称"只 fetch 一次"。
  expect(fetches.count).toBe(2);
  // 只有一条 asset，sha 等于真实字节 sha。
  expect(assetRows(h)).toHaveLength(1);
  expect(assetRows(h)[0]?.content_sha256).toBe(sha(shared));
  // 两个 mediaId 都各自挂了 link 到这一条 asset（关系都保留）。
  expect(assetSourceRows(h)).toHaveLength(2);
  expect(new Set(assetSourceRows(h).map((row) => row.asset_id)).size).toBe(1);
  // wire 上是两个**不同来源**的 image part（各自 mediaId，关系都送到模型面前），
  // 但承载的是同一份字节：sha 相同、来源 revision 不同 —— 去重在资产层，不在关系层
  // （规格 §7.1「同图去重，但保留各消息到图的关系」）。
  const images = wireImages(h, 0);
  expect(images.length).toBe(2);
  expect(images.every((image) => image.sha256 === sha(shared))).toBe(true);
  expect(new Set(images.map((image) => image.mediaId)).size).toBe(2);
  expect(new Set(images.map((image) => image.revision)).size).toBe(2);
  // 准备副本也只有一份：同一 asset 同一策略 → 一条 variant（不是两条副本）。
  expect(variantRows(h).length).toBe(1);
  const facts = factsText(h, 0);
  // 两条消息各自的事实行都在，两段 image part 都记着（各自 mediaId）。
  expect(facts).toContain("-1101");
  expect(facts).toContain("-1102");
  const mediaIdsInFacts = [...facts.matchAll(/"kind":"image","mediaId":"([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );
  expect(new Set(mediaIdsInFacts).size).toBe(2);
  noBytesOnWire(h);
});

/**
 * 真实 GIF 夹具：omggif 上游编码器写出的多帧 GIF，逐帧 disposal 可控。
 * disposal 0/1＝保留画面、2＝清该帧矩形、3＝恢复前一帧（合成器必须真按它走，
 * 否则后一帧读到的只是局部变化块而不是整画面——规格 §7.4）。
 */
const RED = 0;
const GREEN = 1;
const BLUE = 2;
const PALETTE = [0xff0000, 0x00ff00, 0x0000ff, 0xffffff];

interface GifFrameSpec {
  readonly indices: readonly number[];
  readonly disposal?: number;
  readonly delay?: number;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

function writeGif(width: number, height: number, frames: readonly GifFrameSpec[]): Uint8Array {
  const buffer = new Uint8Array(width * height * frames.length * 4 + 4096 + 768);
  const writer = new upstream.GifWriter(buffer, width, height, { palette: PALETTE, loop: 0 });
  for (const frame of frames) {
    writer.addFrame(
      frame.x ?? 0,
      frame.y ?? 0,
      frame.width ?? width,
      frame.height ?? height,
      [...frame.indices],
      { delay: frame.delay ?? 10, disposal: frame.disposal ?? 1 },
    );
  }
  const length = writer.end();
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error("fixture GIF not written");
  return buffer.slice(0, length);
}

function makeGif(width: number, height: number, frames: readonly GifFrameSpec[]): Uint8Array {
  return writeGif(width, height, frames);
}

/**
 * 5 帧、逐帧不同 disposal 的动画：帧 0 全蓝；帧 1 只画左上 4x4 且 disposal=2（清矩形）；
 * 帧 2 全绿且 disposal=1；帧 3 全红且 disposal=3（恢复前帧）；帧 4 全白。
 * 按 3 帧采样（首尾必含）会取到源帧 0/2/4 —— 三张都必须读回**整画面**，不是局部块。
 */
function composedGif(): Uint8Array {
  const width = 8;
  const height = 8;
  const solid = (colour: number): number[] => new Array(width * height).fill(colour);
  // 帧 1 只覆盖左上 4x4 且 disposal=2（画完清矩形）；帧 2 又只覆盖**右下** 4x4 且 disposal=1。
  // 正确合成时帧 2 的画面＝「帧 2 的右下块 + 帧 1 被清空后的左上块为透明」，
  // 若不处理 disposal=2，左上块会残留帧 1 的红 —— 像素断言能分辨这两种合成。
  // 行主序 8x8。帧 1 是**局部矩形**（x=0,w=4,h=2）的红色变化块且 disposal=2；
  // 帧 2 只画右半（x=4,w=4）绿色且 disposal=1。
  //   * 正确合成：帧 1 的矩形被 disposal=2 清空 → 帧 2 的左半是透明（不是红）。
  //   * 不处理 disposal：帧 1 的红块会留在帧 2 的左上 4x2 —— 正是「把局部变化块
  //     当整画面」的失败形态。
  const row = (indices: readonly number[]): number[] => [...indices];
  const leftBlock = [...row([RED, RED, RED, RED]), ...row([RED, RED, RED, RED])];
  const rightHalf = [
    ...row(new Array(4).fill(GREEN)),
    ...row(new Array(4).fill(GREEN)),
    ...row(new Array(4).fill(GREEN)),
    ...row(new Array(4).fill(GREEN)),
    ...row(new Array(4).fill(GREEN)),
    ...row(new Array(4).fill(GREEN)),
    ...row(new Array(4).fill(GREEN)),
    ...row(new Array(4).fill(GREEN)),
  ];
  return writeGif(width, height, [
    { indices: solid(3), disposal: 1 },
    { indices: leftBlock, disposal: 2, x: 0, y: 0, width: 4, height: 2 },
    { indices: rightHalf, disposal: 1, x: 4, y: 0, width: 4, height: 8 },
    { indices: solid(RED), disposal: 3 },
    { indices: solid(BLUE), disposal: 1 },
  ]);
}

/** 解 PNG 的 IDAT（8-bit RGBA、逐行 filter 0），用来逐像素读回真正上了 wire 的帧。 */
function decodePngRgba(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const u32 = (at: number): number =>
    ((png[at] ?? 0) * 0x1000000 +
      ((png[at + 1] ?? 0) << 16) +
      ((png[at + 2] ?? 0) << 8) +
      (png[at + 3] ?? 0)) >>>
    0;
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (at + 12 <= png.length) {
    const length = u32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === "IHDR") {
      width = u32(at + 8);
      height = u32(at + 8 + 4);
    } else if (type === "IDAT") {
      idat.push(png.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
    if (type === "IEND") break;
  }
  const joined = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of idat) {
    joined.set(part, cursor);
    cursor += part.length;
  }
  const raw = new Uint8Array(inflateSync(joined));
  const stride = 1 + width * 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    rgba.set(raw.subarray(y * stride + 1, y * stride + 1 + width * 4), y * width * 4);
  }
  return { width, height, rgba };
}

type Pixel = [number, number, number, number];

const pixelAt = (rgba: Uint8Array, width: number, x: number, y: number): Pixel => {
  const at = (y * width + x) * 4;
  return [rgba[at] ?? 0, rgba[at + 1] ?? 0, rgba[at + 2] ?? 0, rgba[at + 3] ?? 0];
};

it("[S32_1] a real GIF is composited into three ordered frames on the native wire", async () => {
  // 5 帧动图，方案默认普通动图规格＝3 帧 × 512（§7.4 表第二行；帧数/尺寸真源是
  // rhythm.media_frame_count / media_max_dimension，宿主汇进 effective policy）。
  const bytes = composedGif();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["一个动图"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "s32-gif": bytes },
    model: [decideGenerate("10001", "这个动图讲了什么", []), say("合成回复正文")],
  });
  h.receive({
    id: "-1201",
    speaker: "10001",
    text: "这个动图讲了什么",
    groupCard: "阿林",
    image: "s32-gif",
    addressed: true,
  });
  await h.activate("direct_reply");
  await h.deliver();

  expect(h.sent).toHaveLength(1);
  const images = wireImages(h, 0);
  // 同一个媒体来源、三个**不同**的帧 part —— 动图帧是同一媒体的不同时间，
  // 不是 8 张独立来源名额（§7.1），也不是一张静态帧。
  expect(images.length).toBe(3);
  expect(new Set(images.map((image) => image.mediaId)).size).toBe(1);
  expect(images.every((image) => image.mimeType === "image/png")).toBe(true);
  // 帧序号真实来自源文件，按采样顺序递增（首尾必含，源 5 帧取 0/2/4）。
  expect(images.map((image) => image.frameIndex)).toEqual([0, 2, 4]);
  // 三帧字节各不相同：不是把同一帧复制三次。
  expect(new Set(images.map((image) => image.sha256)).size).toBe(3);
  noBytesOnWire(h);

  // 有限帧事实落在真实准备副本上：frame_count=3、frames 数组逐帧带源序号。
  const variants = variantRows(h);
  expect(variants.length).toBe(3);
  for (const variant of variants) {
    expect(variant.frame_count).toBe(3);
    expect(String(variant.policy)).toMatch(/#f\d+$/);
  }
  const declared = JSON.parse(String(variants[0]?.frames)) as { index: number }[];
  expect(declared.map((frame) => frame.index)).toEqual([0, 2, 4]);

  // 合成读回（矩阵 negativeEvidence：不得把局部变化块当整画面）。逐像素读回真实副本：
  //   * 源帧 0：整幅白；
  //   * 源帧 2：右半整幅绿、左上 2x4 被 disposal=2 清成**透明**、左下 4x2 仍是源帧 0 的白。
  //     如果合成器忽略 disposal，帧 1 的红块会留在左上 2x4 —— 那正是「局部块被当整画面」。
  //   * 源帧 4：整幅蓝。
  const WHITE: Pixel = [255, 255, 255, 255];
  const GREEN: Pixel = [0, 255, 0, 255];
  const BLUE: Pixel = [0, 0, 255, 255];
  const TRANSPARENT: Pixel = [0, 0, 0, 0];
  const RED: Pixel = [255, 0, 0, 255];

  const frame0 = decodePngRgba(storedVariantBytes(h, 0));
  expect(pixelAt(frame0.rgba, frame0.width, 0, 0)).toEqual(WHITE);
  expect(pixelAt(frame0.rgba, frame0.width, 7, 7)).toEqual(WHITE);

  const frame2 = decodePngRgba(storedVariantBytes(h, 1));
  // 右半整幅绿（帧 2 的局部矩形真被画上）。
  for (const [x, y] of [
    [7, 7],
    [4, 6],
    [5, 0],
  ] as const) {
    expect(pixelAt(frame2.rgba, frame2.width, x, y)).toEqual(GREEN);
  }
  // 左上 4x2 是 disposal=2 清出来的透明，**不是**帧 1 的红块。
  for (const [x, y] of [
    [0, 0],
    [3, 1],
  ] as const) {
    expect(pixelAt(frame2.rgba, frame2.width, x, y)).toEqual(TRANSPARENT);
    expect(pixelAt(frame2.rgba, frame2.width, x, y)).not.toEqual(RED);
  }
  // 左下 4x2 保留源帧 0 的白（disposal=2 只清自己的矩形，不是清整幅）。
  for (const [x, y] of [
    [0, 2],
    [3, 7],
  ] as const) {
    expect(pixelAt(frame2.rgba, frame2.width, x, y)).toEqual(WHITE);
  }

  const frame4 = decodePngRgba(storedVariantBytes(h, 2));
  expect(pixelAt(frame4.rgba, frame4.width, 0, 0)).toEqual(BLUE);
  expect(pixelAt(frame4.rgba, frame4.width, 7, 7)).toEqual(BLUE);
  for (const frame of [frame0, frame2, frame4]) {
    expect(frame.width).toBe(8);
    expect(frame.height).toBe(8);
  }
});

/**
 * 真 APNG 夹具：PNG 签名 + IHDR + **acTL**（动画控制块，必须在首个 IDAT 之前）
 * + IDAT(fcTL/fdAT 帧数据最小集) + IEND。`isApng` 按容器识别，判错就会退化成静图。
 */
function animatedApngBytes(width: number, height: number, frameCount: number): Uint8Array {
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + payload.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, payload.length);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(payload, 8);
    view.setUint32(8 + payload.length, crc32(out.subarray(4, 8 + payload.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const actl = new Uint8Array(8);
  const actlView = new DataView(actl.buffer);
  actlView.setUint32(0, frameCount);
  actlView.setUint32(4, 0);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("acTL", actl),
    chunk(
      "IDAT",
      encodeQqFramePng(new Uint8Array(width * height * 4).fill(0x20), width, height).subarray(
        8 + 25,
      ),
    ),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** 真动画 WebP 夹具：RIFF/WEBP + VP8X 块，animation flag（bit 1）置位。 */
function animatedWebpBytes(width: number, height: number): Uint8Array {
  const payload = new Uint8Array(10);
  payload[0] = 0x02; // ALPHA | ANIMATION
  payload[1] = 0x00;
  payload[2] = width & 0xff;
  payload[3] = width >> 8;
  payload[4] = height & 0xff;
  payload[5] = height >> 8;
  const chunk = new Uint8Array(8 + payload.length);
  chunk.set([0x56, 0x50, 0x38, 0x58], 0); // "VP8X"
  chunk[4] = payload.length & 0xff;
  chunk[5] = (payload.length >> 8) & 0xff;
  chunk[6] = (payload.length >> 16) & 0xff;
  chunk[7] = 0;
  chunk.set(payload, 8);
  const riff = new Uint8Array(12 + chunk.length);
  riff.set([0x52, 0x49, 0x46, 0x46], 0);
  const size = 4 + chunk.length;
  riff[4] = size & 0xff;
  riff[5] = (size >> 8) & 0xff;
  riff[6] = (size >> 16) & 0xff;
  riff[7] = (size >>> 24) & 0xff;
  riff.set([0x57, 0x45, 0x42, 0x50], 8);
  riff.set(chunk, 12);
  return riff;
}

it("[S33_1] an animated WebP or APNG is refused as unsupported, never faked as one sampled frame", async () => {
  // 真实 codec 判定（qq-image-codec.ts）：GIF 抽帧，动画 WebP/APNG 抛
  // QqImagePrepareError("unsupported_animation")。矩阵 negativeEvidence：
  //   * 不得把静态帧冒充已按 3 帧理解；
  //   * 不得擅自新增解码器；
  //   * 不得用自造/不存在的错误 code（真实码不存在于本产品）。
  const animatedApng = animatedApngBytes(8, 8, 2);
  const animatedWebp = animatedWebpBytes(8, 8);
  const controller = new AbortController();

  // APNG：真实 acTL 块，容器识别走 isApng（IHDR 之后、首个 IDAT 之前）。
  let apngError: unknown = null;
  try {
    await prepareQqImage(animatedApng, {
      category: "ordinary",
      detail: false,
      stillMaxDimension: null,
      frameCount: 3,
      frameMaxDimension: 512,
      signal: controller.signal,
    });
  } catch (error) {
    apngError = error;
  }
  expect(apngError).toBeInstanceOf(QqImagePrepareError);
  expect((apngError as QqImagePrepareError).reason).toBe("unsupported_animation");

  // 动画 WebP：VP8X 的 animation flag（bit 1）置位。
  let webpError: unknown = null;
  try {
    await prepareQqImage(animatedWebp, {
      category: "expression",
      detail: false,
      stillMaxDimension: 512,
      frameCount: 3,
      frameMaxDimension: 512,
      signal: controller.signal,
    });
  } catch (error) {
    webpError = error;
  }
  expect(webpError).toBeInstanceOf(QqImagePrepareError);
  expect((webpError as QqImagePrepareError).reason).toBe("unsupported_animation");

  // 没有第 4 种 reason，也没有 AppError/code：不支持不是「任何 400」，也不自造 code。
  const reasons: string[] = [
    "unreadable_image",
    "unsupported_animation",
    "cancelled",
    "decode_failed",
  ];
  for (const error of [apngError, webpError]) {
    const reason = (error as QqImagePrepareError).reason;
    expect(reasons).toContain(reason);
    expect(typeof (error as { code?: unknown }).code).toBe("undefined");
  }
  // 明确写清：这个 code 不存在于本产品（矩阵要求的强负，不是断言不存在的东西）。
  expect(String((webpError as Error).message)).toContain("cannot be sampled into 3 frames");

  // 静帧对照：同一容器族的**静止** WebP/PNG 走正常路径，不是被同一个判定挡掉。
  // 证明判定看的是「动画容器」而不是「WebP 这个后缀」。
  const stillPng = pngOf(31);
  const still = await prepareQqImage(stillPng, {
    category: "ordinary",
    detail: false,
    stillMaxDimension: null,
    frameCount: 3,
    frameMaxDimension: 512,
    signal: controller.signal,
  });
  expect(still.length).toBe(1);
  expect(still[0]?.frameIndex).toBeNull();
  expect(still[0]?.sourceFrameCount).toBe(1);
  expect(still[0]?.truncated).toBe(false);
  expect(sha(still[0]?.bytes as Uint8Array)).toBe(sha(stillPng));

  // 真 GIF 仍走抽帧，不被误判成 unsupported。
  const gif = makeGif(4, 4, [
    { indices: new Array(16).fill(RED), disposal: 1 },
    { indices: new Array(16).fill(GREEN), disposal: 1 },
  ]);
  const sampled = await prepareQqImage(gif, {
    category: "ordinary",
    detail: false,
    stillMaxDimension: null,
    frameCount: 3,
    frameMaxDimension: 512,
    signal: controller.signal,
  });
  expect(sampled.length).toBe(2);
  expect(sampled.map((frame) => frame.frameIndex)).toEqual([0, 1]);
  expect(sampled.every((frame) => frame.truncated)).toBe(false);
});

it("[S29_1] QQ faces keep verified official names or unknown ids in place and never reach vision", async () => {
  // face 的生产链：normalizeOneBotMessage 产 {kind:"face", id}（只带 ID、无名称）→
  // intake 仅为官方公开表内 ID 填名称，未列出的 ID 保持 name:null →
  // 模型输入里原位保留。face **不**进图片准备/vision（没有 mediaId，不参与选择桶）。
  const fetches = fetchCounter();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["合成描述"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: {},
    fetchHook: fetches.hook,
    model: [decideGenerate("20002", "回应", []), say("合成回复正文")],
  });
  receiveWire(h, {
    id: "-1301",
    speaker: "20002",
    text: "今天真不错FACEMARK",
    groupCard: "小周",
    addressed: true,
    // 两个原位 face：一个官方已列 ID、一个未知 ID。
    faces: ["14", "999999"],
  });
  await h.activate("direct_reply");
  await h.deliver();

  expect(h.sent).toHaveLength(1);
  const facts = factsText(h, 0);
  // 两个 face part 都在，ID 原样保留（负号/大数字都不改写）。
  const faces = factFaces(facts);
  expect(faces.length).toBe(2);
  expect(facts).toContain('"id":"14"');
  expect(facts).toContain('"id":"999999"');
  expect(faces.map((face) => JSON.parse(face))).toEqual([
    { kind: "face", id: "14", name: "微笑" },
    { kind: "face", id: "999999", name: null },
  ]);

  // 强负：face 不进图片准备、不 fetch、不占图数名额、不进 vision。
  expect(fetches.count).toBe(0);
  expect(distinctMediaOnWire(h, 0)).toBe(0);
  expect(assetRows(h)).toHaveLength(0);
  expect(h.visionCalls).toHaveLength(0);
  noBytesOnWire(h);

  // 原位：face 出现在片段顺序里（文本之前），不是被提到句尾或丢弃。
  expect(facts.indexOf('"kind":"face","id":"14"')).toBeGreaterThanOrEqual(0);
  expect(facts).toContain("今天真不错FACEMARK");

  // face 与 image 混在一条消息时：image 照常上 wire，face 仍不产生来源。
  const bytes = pngOf(52);
  const h2 = createOneBotHarness({
    accountId: "90002",
    member: "10001",
    mediaEnabled: true,
    vision: ["合成描述"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "s29-image": bytes },
    model: [decideGenerate("20002", "回应", []), say("合成回复正文二")],
  });
  receiveWire(h2, {
    id: "-1302",
    speaker: "20002",
    text: "看图MIXEDMARK",
    groupCard: "小周",
    addressed: true,
    faces: ["178"],
    imageFiles: ["s29-image"],
  });
  await h2.activate("direct_reply");
  await h2.deliver();
  expect(h2.sent).toHaveLength(1);
  const mixedFacts = factsText(h2, 0);
  expect(factFaces(mixedFacts).length).toBe(1);
  expect(mixedFacts).toContain('"id":"178"');
  // 图真的上了 wire，脸没有。
  expect(distinctMediaOnWire(h2, 0)).toBe(1);
  expect(wireImages(h2, 0)[0]?.sha256).toBe(sha(bytes));
  expect(assetRows(h2)).toHaveLength(1);
  expect(h2.visionCalls).toHaveLength(0);
});

/**
 * 一个最小但**真实**的 scope 夹具：走 openBusinessDb + 真实绑定 + 真实 intake
 * （normalizeOneBotMessage → recordObservation），所以 mediaId、facts.parts 的分类证据、
 * 分类来源全部是生产实现产出的，不手动插 category。
 *
 * 它只补「宿主那层的 owner/focus/policy」入参——那本来就是宿主在真实链路里传给服务的值，
 * 不是另造一条服务。媒体准备本身（fetch/asset/variant/分类回读/specFor）全部是真实代码。
 */
interface ScopeFixture {
  readonly store: ReturnType<typeof openBusinessDb>;
  readonly scope: QqConversationScope;
  readonly owner: RunOwner;
  readonly runtime: ReturnType<typeof createEphemeralAgentRuntime>;
  readonly settings: QqEffectiveMediaPolicy;
  readonly now: string;
  image(
    key: string,
    options?: { hint?: Record<string, unknown>; eventKey?: string },
  ): { mediaId: string; eventKey: string };
  factsFor(eventKey: string): QqMessageFact;
  focusOf(eventKey: string): QqMessageFocus;
  classificationRows(): Record<string, unknown>[];
  close(): void;
}

const SCOPE_ACCOUNT = "10001";
const SCOPE_PEER = "30003";
const SCOPE_BINDING = "11111111-1111-4111-8111-111111111111";

function openScopeFixture(): ScopeFixture {
  const handle = openBusinessDb();
  ensureDefaults(handle.orm, "reply-model");
  const now = new Date().toISOString();
  const scheme = handle.orm
    .insert(schema.qqSchemes)
    .values({
      id: crypto.randomUUID(),
      name: `p3-${crypto.randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  handle.orm
    .insert(schema.qqBindings)
    .values({
      id: SCOPE_BINDING,
      accountId: SCOPE_ACCOUNT,
      conversationKind: "group",
      peerId: SCOPE_PEER,
      agentId: DEFAULT_AGENT_ID,
      schemeId: scheme.id,
      paused: 0,
      shareWebMemory: 0,
      revision: 1,
      authorityRevision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const journal = new ConversationEventRepository(handle.db);
  const conversation = journal.ensureOneBot(SCOPE_BINDING);
  if (!conversation) throw new Error("scope conversation missing");
  const scope: QqConversationScope = {
    conversationId: conversation.id,
    accountId: SCOPE_ACCOUNT,
    conversationKind: "group",
    peerId: SCOPE_PEER,
    agentId: DEFAULT_AGENT_ID,
    bindingId: SCOPE_BINDING,
    bindingEpoch: conversation.bindingEpoch,
    authorityRevision: 1,
  };
  const owner: RunOwner = {
    kind: "conversation",
    id: conversation.id,
    userId: DEFAULT_USER_ID,
    agentId: DEFAULT_AGENT_ID,
  };
  const expiresAt = new Date(Date.parse(now) + 14 * 24 * 60 * 60 * 1000).toISOString();
  let counter = 0;
  const image = (key: string, options?: { hint?: Record<string, unknown>; eventKey?: string }) => {
    counter += 1;
    const messageId = `p3-${counter}-${key}`;
    handle.orm
      .insert(schema.qqEvents)
      .values({
        eventKey: messageId,
        accountId: SCOPE_ACCOUNT,
        conversationKind: "group",
        peerId: SCOPE_PEER,
        agentId: DEFAULT_AGENT_ID,
        messageId,
        occurredAtSeconds: Math.floor(Date.parse(now) / 1000),
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: now,
      })
      .run();
    const normalized = normalizeOneBotMessage(
      {
        post_type: "message",
        time: Math.floor(Date.parse(now) / 1000),
        self_id: Number(SCOPE_ACCOUNT),
        user_id: Number("20002"),
        message_id: Number(messageId.replace(/\D/g, "")) || 1,
        message_type: "group",
        sub_type: "normal",
        group_id: Number(SCOPE_PEER),
        sender: { nickname: "小周" },
        message: [
          { type: "image", data: { file: key, ...(options?.hint ?? {}) } },
          { type: "text", data: { text: "看这个" } },
        ],
      },
      SCOPE_ACCOUNT,
    );
    if (normalized.kind !== "message") throw new Error("scope wire message expected");
    // intake 自己派生 eventKey（与真实入站同一条派生规则），用它的返回值而不是本地拼的键。
    const recorded = recordObservation(handle.orm, normalized.observation, DEFAULT_AGENT_ID);
    const eventKey = recorded.eventKey;
    journal.ingestOneBotEvent(eventKey, SCOPE_BINDING);
    const parts = handle.db
      .query("SELECT parts FROM qq_message_facts WHERE event_key=?")
      .get(eventKey) as { parts: string } | null;
    if (!parts) throw new Error("scope fact row missing");
    const parsed = JSON.parse(parts.parts) as QqMessagePart[];
    const mediaPart = parsed.find((part) => part.kind === "image");
    if (mediaPart?.kind !== "image") throw new Error("scope media part missing");
    return { mediaId: mediaPart.mediaId, eventKey };
  };
  const factsFor = (eventKey: string): QqMessageFact => {
    const row = handle.db
      .query("SELECT * FROM qq_message_facts WHERE event_key=?")
      .get(eventKey) as Record<string, unknown> | null;
    if (!row) throw new Error("scope fact row missing");
    return {
      id: eventKey,
      platformMessageId: String(row.platform_message_id ?? ""),
      seq: Number(row.seq ?? 1),
      occurredAtSeconds: Number(row.occurred_at_seconds ?? 0),
      speaker: {
        role: "member",
        qq: "20002",
        groupCard: null,
        personalNickname: null,
        legacyDisplayName: null,
        nameState: "unknown",
      },
      parts: JSON.parse(String(row.parts)) as QqMessagePart[],
      mentions: [],
      replyTo: null,
      sources: [{ kind: "qq_event", id: eventKey, revision: now, expiresAt }],
      completeness: "full",
    };
  };
  const runtime = createEphemeralAgentRuntime({
    vision: {
      async annotate() {
        return "合成图片描述";
      },
    },
  });
  const settings: QqEffectiveMediaPolicy = {
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
  return {
    store: handle,
    scope,
    owner,
    runtime,
    settings,
    now,
    image,
    factsFor,
    focusOf: (eventKey: string) => ({
      triggerMessageIds: [eventKey],
      responseMessageIds: [eventKey],
      responseQqs: ["20002"],
      assistantQq: "90009",
    }),
    classificationRows: () =>
      handle.db.query("SELECT * FROM qq_media_classifications").all() as Record<string, unknown>[],
    close: () => handle.close(),
  };
}

it("[S28_1] (auxiliary) a detail question prepares the expression image at the ordinary spec but never reclassifies it", async () => {
  // 辅助块：走按需服务 `prepareByMediaId` + detail 问题锚（宿主 media.read 背后的同一实现）。
  // 两跳缺口如实登记：① 自动投影链的 detailMediaIds 在宿主没有生产 caller；② 真实 host 工具
  // media.read(questionMessageId) 的锚解析当前必然拒绝（bot-host resolveQuestion 的 focusKey
  // 是事件键，而 loadQqMessageFact 按平台消息 ID 查找，二者不可同时成立；探针
  // logs/probe-question-anchor.ts 实证 CONTEXT_INVALID_SELECTION）——缺口在 T11 范围内处理，
  // 本文件不改产品。规格 §7.4：明确细问的表情本次按普通图片规格，但不改图片原分类
  // （分类仍是 expression，来源仍是 platform）。
  const bytes = pngOf(120, 1024, 512);
  const scope = openScopeFixture();
  try {
    const media = scope.image("s28-face", { hint: { ...MARKET_FACE } });
    const mediaId = media.mediaId;
    // 平台证据：facts 里这图的 category 必须是 expression。
    const facts = scope.factsFor(media.eventKey);
    // 平台三键真的被判成 expression（不是往 DB 里塞的 category）。
    expect(facts.parts.filter((part) => part.kind === "image")).toEqual([
      { kind: "image", mediaId, category: "expression" },
    ]);

    const service = createQqMediaInputService({
      store: scope.store,
      fetchSource: async () => ({ bytes }),
      agentRuntime: scope.runtime,
      prompt: "如实说明这条消息里的媒体内容。",
      modelConfig: { visionModelName: "vision-stub", transcriptionModelName: null },
      baselinePolicy: "baseline/v1/p3",
    });
    const input = {
      scope: scope.scope,
      phase: "generation" as const,
      focus: scope.focusOf(media.eventKey),
      facts: [facts],
      replies: { roots: [], sources: [] },
      settings: scope.settings,
      model: "reply-model",
      now: scope.now,
      runId: `run-${crypto.randomUUID()}`,
      signal: new AbortController().signal,
      assertCurrent: () => {},
      mediaId,
      owner: scope.owner,
      classificationPolicy: "policy-native-v1",
    };

    // 无 detail 锚：按表情规格 512 缩放（1024x512 → 512x256）。
    const plain = await service.prepareByMediaId(input);
    expect(plain.detail).toBe(false);
    expect(plain.category).toBe("expression");
    expect(plain.categorySource).toBe("platform");
    expect(plain.images).toHaveLength(1);
    expect(plain.images[0]?.width).toBe(512);
    expect(plain.images[0]?.height).toBe(256);
    const expressionVariantPolicy = plain.images[0]?.variantPolicy;
    expect(expressionVariantPolicy).toBeDefined();

    // 带 detail 锚：同一张图按**普通规格**准备（普通静图 null 长边＝原图优先）。
    const detail = await service.prepareByMediaId({
      ...input,
      detail: {
        questionKey: "这个表情包上画的是什么",
        eventKey: media.eventKey,
        source: { kind: "qq_message_fact", id: media.eventKey, revision: "rev-1" },
        assertQuestionCurrent: () => {},
      },
    });
    expect(detail.detail).toBe(true);
    // 分类没变：仍然是表情，证据来源仍然是平台（明确细问不改原分类）。
    expect(detail.category).toBe("expression");
    expect(detail.categorySource).toBe("platform");
    // 规格升到 ordinary：1024x512 原图，不缩到 512。
    expect(detail.images).toHaveLength(1);
    expect(detail.images[0]?.width).toBe(1024);
    expect(detail.images[0]?.height).toBe(512);
    expect(detail.images[0]?.sha256).toBe(sha(bytes));
    // 两套规格是**不同的准备副本**，不共用（规格变了不复用旧副本，§8.2）。
    expect(detail.images[0]?.variantPolicy).not.toBe(expressionVariantPolicy);
    // 分类证据没被这次 detail 改写（没有写任何分类行）。
    expect(scope.classificationRows()).toHaveLength(0);
  } finally {
    scope.close();
  }
});

it("[S28_2] a real host media.read with questionMessageId prepares the native detail at the ordinary spec", async () => {
  // 真实 host 工具链（题锚 internal/platform 域比对修复后补块）：
  // 模型走 media.list → media.read（questionMessageId 指回本轮 focus 消息的平台 ID）→
  // 宿主 resolveQuestion 锚解析（internal eventKey ↔ platform ID 正确域比对）→ media 服务
  // 真实 detail 准备（ordinary 规格）→ 模型下一步的 action_observation 里就是 ordinary 规格元数据。
  // 分类不改写：category 仍是 expression（platform），分类表零新行。
  const bytes = pngOf(120, 1024, 512);
  const fetches = fetchCounter();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["合成描述"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "s28e-face": bytes },
    fetchHook: fetches.hook,
    // 首个决策步：先 media.list 拿到本轮已披露媒体，再按观察接 media.read（driveToolFirst）。
    model: [decideInvoke("media.list", {})],
  });
  driveToolFirst(h, (observation) => {
    if (observation?.name === "media.list") {
      const items = observation.value?.items ?? [];
      const target = items[0];
      if (target?.id === undefined) throw new Error("media not disclosed");
      return [decideInvoke("media.read", { id: target.id, questionMessageId: "-1401" })];
    }
    if (observation?.name === "media.read") {
      // 决策出 generate 输出后还有生成相：脚本同时给 say 步骤。
      return [decideGenerate("20002", "回答这个表情的细节", []), say("合成回复正文")];
    }
    return null;
  });
  h.receive({
    id: "-1401",
    speaker: "20002",
    text: "这个表情包上画的是什么 DETAIL28",
    groupCard: "阿林",
    image: "s28e-face",
    imageHint: { ...MARKET_FACE },
    addressed: true,
  });
  await h.activate("direct_reply");
  await h.deliver();
  expect(h.sent).toHaveLength(1);

  // media.read 的 action_observation 真进了模型上下文：ordinary 规格的原图元数据。
  const readText = (h.model?.calls ?? []).map((call) => call.text).join("\n");
  expect(readText).toContain('"name":"media.read"');
  expect(readText).toContain('"status":"ok"');
  expect(readText).toContain('"category":"expression"');
  // ordinary 规格（原图 1024x512），不是表情 512x256。
  expect(readText).toContain('"width":1024');
  expect(readText).toContain('"height":512');
  expect(readText).not.toContain('"width":512,"height":256');

  // detail 准备副本真实落库：expression 512x256 之外，多一条 ordinary 1024x512 的 variant。
  const variants = h.db.query("SELECT policy, width, height FROM qq_media_variants").all() as {
    policy: string;
    width: number;
    height: number;
  }[];
  expect(variants.some((row) => row.width === 512 && row.height === 256)).toBe(true);
  expect(variants.some((row) => row.width === 1024 && row.height === 512)).toBe(true);

  // 明确细问不改分类：分类表零新行（分类证据始终是 platform intake 的事实，不是 model 补判）。
  expect(
    (h.db.query("SELECT COUNT(*) AS n FROM qq_media_classifications").get() as { n: number }).n,
  ).toBe(0);
  // detail 读取复用按 mediaId 的来源字节缓存（决策相已取过一次），不再第二次 fetch：
  // fetch 计数＝1（决策相自动准备那次），detail 的 ordinary 副本由缓存字节生成。
  expect(fetches.count).toBe(1);
  // asset 与消息关系仍在：同一 mediaId 的 asset sha 等于受控字节。
  expect(assetShaFor(h, sha(bytes))).toBeDefined();
  noBytesOnWire(h);
});

it("[S28_3] a questionMessageId outside the focus scope is refused by the host anchor", async () => {
  // 选择拒绝对照：questionMessageId 指向一条真实存在但不在 focus∪depth1 范围的旧消息。
  // 宿主不扩展授权，media.read 返回可修正的 CONTEXT_INVALID_SELECTION 观察供模型决定收口；
  // 本轮零 detail 副本、零额外取字节。
  const bytes = pngOf(120, 1024, 512);
  const fetches = fetchCounter();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["合成描述"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "s28x-face": bytes },
    fetchHook: fetches.hook,
    model: [decideInvoke("media.list", {})],
  });
  driveToolFirst(h, (observation) => {
    if (observation?.name === "media.list") {
      const items = observation.value?.items ?? [];
      const target = items[0];
      if (target?.id === undefined) throw new Error("media not disclosed");
      // "-1300" 是这条更早消息的平台 ID——真实存在但不是 focus 也不是 focus 的直接引用目标。
      return [decideInvoke("media.read", { id: target.id, questionMessageId: "-1300" })];
    }
    // 只有真看到了 media.read 的观察才收尾；对选择反馈，模型在当前 run 内可安全收口。
    if (observation?.name === "media.read") return [decideNone()];
    return null;
  });
  // 先收一条更早的无关消息（有正文、可被按平台 ID 查到），再收本轮 focus 图片消息。
  h.receive({
    id: "-1300",
    speaker: "20002",
    text: "早前一句无关聊天 OLDMARK",
    groupCard: "阿林",
  });
  h.receive({
    id: "-1402",
    speaker: "20002",
    text: "这个表情包上画的是什么 DETAIL28X",
    groupCard: "阿林",
    image: "s28x-face",
    imageHint: { ...MARKET_FACE },
    addressed: true,
  });
  await h.activate("direct_reply");
  await h.deliver();
  const observations = actionObservationsOf(h, "media.read");
  expect(observations).toHaveLength(1);
  expect(observations[0]?.value.value).toEqual({
    status: "unavailable",
    code: "CONTEXT_INVALID_SELECTION",
    recoverable: true,
  });
  expect(observations[0]?.value.sources).toEqual([
    {
      kind: "qq_group_capability",
      id: JSON.stringify([
        "11111111-1111-4111-8111-111111111111",
        "00000000-0000-0000-0000-000000000001",
        "media",
      ]),
      revision: "0",
    },
  ]);
  expect(
    observations[0]?.value.sources.some((source) =>
      ["qq_message_fact", "qq_media_source", "qq_media_note", "qq_media_read_task"].includes(
        String((source as { kind?: unknown }).kind),
      ),
    ),
  ).toBe(false);
  expect(h.sent).toHaveLength(0);
  expect(assetRows(h)).toHaveLength(1);
  expect(rowsOf(h, "SELECT id FROM qq_media_read_tasks")).toHaveLength(0);
  // 零 detail 副本：只有决策相自动准备的 expression 512x256（ordinary 1024x512 不得出现）。
  const variants = h.db.query("SELECT width, height FROM qq_media_variants").all() as {
    width: number;
    height: number;
  }[];
  expect(variants.some((row) => row.width === 1024 && row.height === 512)).toBe(false);
  expect(variants.some((row) => row.width === 512 && row.height === 256)).toBe(true);
  // 零额外取字节：只有决策相自动准备那一次 fetch。
  expect(fetches.count).toBe(1);
});

// ---- S28_4 观察断言与 raw capture 专用小工具（仅本块使用，不构成第二模型链）----------------

/** media.read 观察 value 的严格信封形状（绝无 bytes/base64/取流引用）。 */
interface MediaReadObservationValue {
  readonly status: string;
  readonly mediaId: string;
  readonly category: string;
  readonly images: readonly { readonly width: number; readonly height: number }[];
}

/** 模型输入里的完整 action_observation 信封（dataMessage 原文 JSON.parse，不做子串匹配）。 */
interface ActionObservationEnvelope {
  readonly kind: string;
  readonly trust: string;
  readonly value: {
    readonly id: string;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
    readonly value: unknown;
    readonly sources: readonly unknown[];
  };
}

/**
 * 从 receivedMessages 的每个 text part 解析完整 action_observation 信封（指定 action 名）。
 * 解不开的 part 不伪造：跳过（外层断言自然失败并留现场）。
 * joint3 实测：一次工具执行的结果在后续 request 里被重复承载——按实际 observation id 去重，
 * 同一 id 只计一次（重复承载不是两次执行）；不同 id 不合并；同 id 不同 body 不猜，直接抛出留现场。
 */
const actionObservationsOf = (h: OneBotHarness, name: string): ActionObservationEnvelope[] => {
  const envelopes = (h.model?.receivedMessages ?? [])
    .flatMap((call) => call.messages)
    .flatMap((message) =>
      message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
    )
    .flatMap((text) => {
      try {
        const parsed = JSON.parse(text) as ActionObservationEnvelope;
        return parsed.kind === "action_observation" && parsed.value?.name === name ? [parsed] : [];
      } catch {
        return [];
      }
    });
  const byId = new Map<string, ActionObservationEnvelope>();
  for (const envelope of envelopes) {
    const previous = byId.get(envelope.value.id);
    if (previous === undefined) {
      byId.set(envelope.value.id, envelope);
      continue;
    }
    if (JSON.stringify(previous) !== JSON.stringify(envelope)) {
      throw new Error(
        `action_observation ${name} id=${envelope.value.id} 被以不同 body 重复承载，不猜取哪份`,
      );
    }
  }
  return [...byId.values()];
};

/** 决策相 system 段 JSON 里的 authorizedTargets（现场底，不是断言面；取不到＝null 不猜）。 */
const authorizedTargetsOf = (h: OneBotHarness): string[] | null => {
  for (const call of h.model?.receivedMessages ?? []) {
    for (const message of call.messages) {
      if (message.role !== "system") continue;
      for (const part of message.content) {
        if (part.kind !== "text") continue;
        for (const segment of part.text.split("\n\n")) {
          if (!segment.startsWith("{")) continue;
          try {
            const parsed = JSON.parse(segment) as { authorizedTargets?: unknown };
            if (Array.isArray(parsed.authorizedTargets)) {
              return parsed.authorizedTargets.map((target) => String(target));
            }
          } catch {
            // 不是 JSON 段就跳过。
          }
        }
      }
    }
  }
  return null;
};

/**
 * S28 断言前的 raw capture 落点：只由 `SUPERSTRING_S28_TRACE_DIR` 指定，
 * 用 Bun 自带 fs；不 import artifacts、也不从 artifacts 读任何东西。未设该变量＝完全不写盘。
 * 只新建、不覆盖（文件名带 Date.now()+pid，末尾序号去重）；写盘自身抛出会覆盖原错误（不掩盖失败）。
 */
const writeS28RawCapture = (
  h: OneBotHarness,
  payload: {
    readonly case: string;
    readonly activateError: string | null;
    readonly variants: readonly { policy: string; width: number; height: number }[];
  },
): void => {
  const dir = process.env.SUPERSTRING_S28_TRACE_DIR;
  if (dir === undefined || dir === "") return;
  mkdirSync(dir, { recursive: true });
  const runs = h.runs
    .listRuns({ ownerKind: "conversation", ownerId: h.conversationId })
    .filter((run) => run.specId === "onebot.main")
    .map((run) => {
      const snapshot = h.runs.getRun(run.runId);
      return {
        runId: run.runId,
        status: run.status,
        errorCode: run.errorCode,
        runSteps: (snapshot?.steps ?? []).map((step) => ({
          stepNo: step.stepNo,
          phase: step.phase,
          status: step.status,
          errorCode: step.errorCode ?? null,
        })),
      };
    });
  const stem = `s28-${payload.case}-raw`;
  let name = `${stem}-${Date.now()}-${process.pid}.json`;
  for (let n = 2; existsSync(join(dir, name)); n += 1) {
    name = `${stem}-${Date.now()}-${process.pid}-${n}.json`;
  }
  writeFileSync(
    join(dir, name),
    `${JSON.stringify(
      {
        utc: new Date().toISOString(),
        ...payload,
        runs,
        authorizedTargets: authorizedTargetsOf(h),
        actualRequests: h.model?.receivedMessages ?? [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

it("[S28_4] a legal focus question reads the directly-referenced original image at the ordinary spec", async () => {
  // 正对照（规格 §7.1/§7.4 语义）：focus 问题消息 replyTo 一条带图消息 → 该原图属于 focus 的
  // direct 范围，media.read(questionMessageId=focus 平台 ID) 对它的 detail 读取**必须成功**并按
  // ordinary 规格准备；分类不改变（expression/platform）。
  // 已知上游（T11 producer 侧静态 Important）：当前 assertQuestionCurrent 复验只在 question fact
  // 自己的 parts 里找 image —— direct 原图场景会被误拒。本块按**规格语义**写正 expected，
  // 不迁就现实现改 expected 为拒。2026-10-04 joint2 首轮真实运行：读取面已按规格语义走通，
  // 失败在 caller 的 generate 目标（见下方修复注）；本块已实运行。
  const bytes = pngOf(120, 1024, 512);
  const fetches = fetchCounter();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["合成描述"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "s28d-face": bytes },
    fetchHook: fetches.hook,
    model: [decideInvoke("media.list", {})],
  });
  driveToolFirst(h, (observation) => {
    if (observation?.name === "media.list") {
      const items = observation.value?.items ?? [];
      const target = items[0];
      if (target?.id === undefined) throw new Error("media not disclosed");
      // 问题指针＝focus 消息（"-1502"）自己的平台 ID；目标图属于它直接引用的原图。
      return [decideInvoke("media.read", { id: target.id, questionMessageId: "-1502" })];
    }
    if (observation?.name === "media.read") {
      // 生成目标＝本轮 focus 的直接回应授权目标（speaker 10001，见下面 -1502 的 speaker）。
      // 首轮真实运行失败在 caller 写成原作者 20002：AGENT_TARGET_UNAUTHORIZED → 整轮
      // AGENT_OUTPUT_FAILED；读取目标原图不变，只修目标指向。
      return [decideGenerate("10001", "回答原图细节", []), say("合成回复正文")];
    }
    return null;
  });
  // 先收带图消息（direct 目标），再收 focus 问题消息（replyTo 指回它）。
  h.receive({
    id: "-1501",
    speaker: "20002",
    text: "看这个原图 ORIGIN28",
    groupCard: "小周",
    image: "s28d-face",
    imageHint: { ...MARKET_FACE },
  });
  h.receive({
    id: "-1502",
    speaker: "10001",
    text: "这个表情包原图长什么样 DIRECT28",
    groupCard: "阿林",
    addressed: true,
    replyTo: "-1501",
  });
  // activate/deliver 任一抛都先照落 raw capture 再原样重抛：真实 source fail 报真实 code，
  // 不吞、不双分支当 pass。
  let activateError: unknown = null;
  try {
    await h.activate("direct_reply");
    await h.deliver();
  } catch (error) {
    activateError = error;
  }
  // ---- raw capture（任何 assert 之前）---- actual requests（receivedMessages 全量，不截断）/
  // run steps/errors/authorizedTargets/variants。落点只由 SUPERSTRING_S28_TRACE_DIR 指定
  // （证据目录）；未设该变量＝完全不写盘。再次红时有完整现场底，不需要重跑猜。
  writeS28RawCapture(h, {
    case: "S28_4",
    activateError: activateError === null ? null : String(activateError),
    variants: h.db.query("SELECT policy, width, height FROM qq_media_variants").all() as {
      policy: string;
      width: number;
      height: number;
    }[],
  });
  if (activateError !== null) throw activateError;
  expect(h.sent).toHaveLength(1);

  // media.read 成功：从 receivedMessages（本块 array steps 场景必有）解析**完整**
  // action_observation 信封 JSON 再断言——不再用 calls 的 4000 字摘要做嵌套 regex 子串匹配
  // （截断拼接面上的子串命中可以是 false green）。
  const readObservations = actionObservationsOf(h, "media.read");
  expect(readObservations).toHaveLength(1);
  const readEnvelope = readObservations[0] as ActionObservationEnvelope;
  expect(readEnvelope.kind).toBe("action_observation");
  expect(readEnvelope.trust).toBe("data_only");
  expect(readEnvelope.value.name).toBe("media.read");
  expect(readEnvelope.value.arguments).toMatchObject({ questionMessageId: "-1502" });
  const readValue = readEnvelope.value.value as MediaReadObservationValue;
  expect(readValue.status).toBe("ok");
  expect(readValue.category).toBe("expression");
  // ordinary 规格（原图 1024x512），不是表情 512x256——按解析后的字段断言，可真实失败。
  expect(readValue.images.some((image) => image.width === 1024 && image.height === 512)).toBe(true);
  expect(readValue.images.some((image) => image.width === 512 && image.height === 256)).toBe(false);

  // detail 副本真实落库：expression 512x256 之外，多一条 ordinary 1024x512 variant。
  const variants = h.db.query("SELECT policy, width, height FROM qq_media_variants").all() as {
    policy: string;
    width: number;
    height: number;
  }[];
  expect(variants.some((row) => row.width === 512 && row.height === 256)).toBe(true);
  expect(variants.some((row) => row.width === 1024 && row.height === 512)).toBe(true);

  // 分类不改写：分类表零新行。
  expect(
    (h.db.query("SELECT COUNT(*) AS n FROM qq_media_classifications").get() as { n: number }).n,
  ).toBe(0);
  // detail 复用按 mediaId 的来源字节缓存：fetch 只发生在决策相自动准备那次。
  expect(fetches.count).toBe(1);
  expect(assetShaFor(h, sha(bytes))).toBeDefined();
  noBytesOnWire(h);
});

it("[S28_5] a legal focus question cannot read an out-of-scope image from the same scope's list", async () => {
  // 强负：问题本身合法（focus 消息、有正文、有自己的图），但 media.read 的目标图是
  // **同 scope 其他 list 图**——它不属于该问题的 focus/direct 图范围。宿主不给该图授权，
  // 返回选择反馈而不是继续读；零 detail 副本、零额外 fetch、零发送。
  const scopeImage = pngOf(200); // 同 scope 旧图（不在本轮 focus/direct 范围）
  const focusImage = pngOf(120, 1024, 512); // focus 消息自己的表情图
  const fetches = fetchCounter();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["合成描述"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "s28o-other": scopeImage, "s28f-face": focusImage },
    fetchHook: fetches.hook,
    model: [decideInvoke("media.list", {})],
  });
  driveToolFirst(h, (observation) => {
    if (observation?.name === "media.list") {
      const items = observation.value?.items as
        | readonly { readonly id?: string; readonly eventKey?: string }[]
        | undefined;
      // list 会披露本会话全部图（含范围外旧图）——挑**范围外**那张作为读取目标。
      const older = (items ?? []).find((item) => item.eventKey?.includes("-1600"));
      if (older?.id === undefined) throw new Error("out-of-scope media not disclosed");
      return [decideInvoke("media.read", { id: older.id, questionMessageId: "-1601" })];
    }
    // 选择反馈到模型后，使用 none 收口，不进行额外图片或消息操作。
    if (observation?.name === "media.read") return [decideNone()];
    return null;
  });
  // 旧图消息（范围外）；随后 focus 问题消息带自己的图（合法问题）。
  h.receive({
    id: "-1600",
    speaker: "20002",
    text: "早前另一张图 OTHER28",
    groupCard: "小周",
    image: "s28o-other",
  });
  h.receive({
    id: "-1601",
    speaker: "10001",
    text: "这个表情包上画的是什么 SCOPE28",
    groupCard: "阿林",
    image: "s28f-face",
    imageHint: { ...MARKET_FACE },
    addressed: true,
  });
  await h.activate("direct_reply");
  await h.deliver();
  const observations = actionObservationsOf(h, "media.read");
  expect(observations).toHaveLength(1);
  expect(observations[0]?.value.value).toEqual({
    status: "unavailable",
    code: "CONTEXT_INVALID_SELECTION",
    recoverable: true,
  });
  expect(observations[0]?.value.sources).toEqual([
    {
      kind: "qq_group_capability",
      id: JSON.stringify([
        "11111111-1111-4111-8111-111111111111",
        "00000000-0000-0000-0000-000000000001",
        "media",
      ]),
      revision: "0",
    },
  ]);
  expect(
    observations[0]?.value.sources.some((source) =>
      ["qq_message_fact", "qq_media_source", "qq_media_note", "qq_media_read_task"].includes(
        String((source as { kind?: unknown }).kind),
      ),
    ),
  ).toBe(false);
  expect(h.sent).toHaveLength(0);
  expect(rowsOf(h, "SELECT id FROM qq_media_read_tasks")).toHaveLength(0);

  // 零 detail 副本：没有 ordinary 1024x512（focus 图的 detail），也没有范围外旧图的任何准备副本。
  const variants = h.db.query("SELECT width, height FROM qq_media_variants").all() as {
    width: number;
    height: number;
  }[];
  expect(variants.some((row) => row.width === 1024 && row.height === 512)).toBe(false);
  expect(variants.some((row) => row.width === 8 && row.height === 8)).toBe(false);
  // 只有 focus 表情图的自动准备副本。
  expect(variants.some((row) => row.width === 512 && row.height === 256)).toBe(true);
  // 只有一次 asset（focus 图那次自动准备）；范围外图从未准备。
  expect(assetRows(h)).toHaveLength(1);
  // 零额外取字节：只有决策相自动准备那一次 fetch。
  expect(fetches.count).toBe(1);
});
