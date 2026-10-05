// T15 表情规则 / 不可读动画：真实 OneBot 宿主整链（矩阵 id 26 与 33 的宿主面）。
//
// 上位依据：
//   * 规格 dev/docs/superpowers/specs/2026-10-02-qq-message-context-multimodal-design.md
//     §7.2（分类与证据来源）、§7.3（表情图规则与 face 原位）、§7.4（输入规格表与"不能把静态帧
//     冒充已按 3 帧理解"）、§7.5（超限取舍与本轮不可读出口）、§10（wire 上不放裸字节/URL）、
//     §14.1（验收）；
//   * 计划 dev/docs/superpowers/plans/2026-10-02-qq-message-context-multimodal-plan.md §T15；
//   * 矩阵 artifacts/validation/qq-message-multimodal-20261002/functional-matrix.ts 的
//     id 26（expressionhint512/lowcontext；negativeEvidence：格式/动图/小尺寸/带字不得单独证明
//     表情类别）与 id 33（unsupportedanimunknown；negativeEvidence：不得把静态帧冒充已按 3 帧
//     理解、不得擅自新增解码器）。**本文件不 import artifacts**（tests/ 整体进发布导出面，
//     测试反向依赖 artifacts 会让发布测试树断依赖）；编号在文件头与块标题逐条注明，报告侧按
//     同一编号对账。
//
// 与既有 slice 的分工（不重复、不抢写）：
//   * tests/integration/qq-multimodal-image-shape-e2e.test.ts（P3，含 [S26_1]/[S33_1]）本文件不改；
//   * tests/integration/qq-multimodal-media-fault-e2e.test.ts（P4，矩阵 id 35–40）本文件不改；
//   * tests/harness/* 与产品代码本文件零改动。
//
// 本文件只补两块**宿主整链**证据（同编号的服务级/decoder 级面由 P3/P4 已覆盖）：
//   * [S26_2] 真实 market-face 三键 wire → 事实侧 category=expression → 真 HTTP body 上看得见
//     512 长边的表情副本；条件式表情规则段**无条件**进 system（native 轮无 mediaNotes/无
//     mediaUnread 时也在）；本轮不新增任何分类相关模型调用；模型输入里不出现数值 attention 字段
//     （只是"无该字段"的传输面证据，不承诺任何模型行为质量）。
//   * [S33_2] 同一条 focus 消息里一个**真正不可读**的动画（真 APNG 字节）＋一张合法静图：动画只
//     落 qq_media_unreadable（data_only、逐字带 mediaId/messageId/reason），零 variant、零 image
//     part、零首帧字节上 wire；合法静图照常按普通规格（原图）上 wire；两段 image part 的消息关系
//     与窗口文字都保留，整轮照常回复成功。
//
// 四条硬纪律（逐条对应实现）：
//   1. 真实 wire：模型只经产品真实端口（createModelPort + createLmStudioClient）打**本文件自建**
//      owned loopback（127.0.0.1、port 0、await listening 后取端口、finally close）。不手建
//      ModelPort、不 stringify(request) 假 wire、不用 web 端口或 17861、不接真实模型服务。
//   2. 真实字节：动画是带真 acTL 块（IHDR 之后、首个 IDAT 之前）的 APNG，容器识别走产品 isApng；
//      静图是 encodeQqFramePng 编出的真 PNG——**禁止** TextEncoder 文字冒图。512 规格不靠元数据
//      断言，而是把 wire 上 data URL 的字节解回 PNG 头逐字核对。
//   3. 真实入站：多段 wire 走 `normalizeOneBotMessage` → `recordInbound` 的公开路径（本文件内自建
//      helper，不改 harness、不改 adapter、不手写 DB fact category、不做 seed proof）。
//   4. 证据先行：raw 请求原文、wire 摘要、表行与宿主诊断在**任何 assert 之前**写进 env 指定的
//      唯一证据目录（QQ_EXPRESSION_UNREADABLE_TRACE_DIR；缺省＝不落盘，发布树里不生成文件）。
//      activate/deliver 抛错时同样先落盘再断言，失败不只剩一条断言。

import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import http from "node:http";
import { eq } from "drizzle-orm";
import { createModelPort } from "../../src/server/agent/model-port";
import * as schema from "../../src/server/db/schema";
import { createLmStudioClient, type ExternalModelRoute } from "../../src/server/llm/model-gateway";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { recordInbound } from "../../src/server/services/qq-intake";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";

afterEach(() => {
  closeHarnesses();
});

// ---- 证据落盘（断言之前；目录由 env 指定，缺省不落盘） ------------------------------------

/**
 * 本轮证据目录，**必须**由 env `QQ_EXPRESSION_UNREADABLE_TRACE_DIR` 指定。缺省为空表示不落任何盘
 * （tests/ 整体进发布导出面，不允许发布树运行时生成文件）。落盘内容全部合成：HTTP body 原文、
 * wire 摘要、真实表行与宿主诊断；不含真实 QQ 账号、真实图片字节或任何真实服务地址。
 */
const TRACE_DIR = (process.env.QQ_EXPRESSION_UNREADABLE_TRACE_DIR ?? "").trim();

async function writeTrace(name: string, value: unknown): Promise<void> {
  if (TRACE_DIR === "") return;
  await Bun.write(`${TRACE_DIR}/${name}`, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 证据落盘的最小外壳：两份证据**各自独立**写，一份失败不吞掉另一份，也不掩盖被测行为本身的
 * 失败（写盘异常记成 evidenceError，被测异常原样重抛）。调用方在 `finally` 里调它，所以无论
 * 是 activate/deliver 抛错、取证途中抛错、还是某条 assert 抛错，证据都已经落盘。
 */
async function writeEvidence(
  files: readonly { readonly name: string; readonly build: () => unknown }[],
): Promise<string | null> {
  const failures: string[] = [];
  for (const file of files) {
    try {
      await writeTrace(file.name, file.build());
    } catch (error) {
      failures.push(`${file.name}: ${String(error)}`);
    }
  }
  return failures.length === 0 ? null : failures.join(" | ");
}

// ---- 本文件内的小工具（不构成第二 harness / 第二模型链） --------------------------------

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** 合成的**真** PNG 静图：每张字节不同，便于按 sha 与尺寸区分哪张真的上了 wire。 */
const pngOf = (fill: number, width = 8, height = 8): Uint8Array =>
  encodeQqFramePng(new Uint8Array(width * height * 4).fill(fill), width, height);

/** 平台 market face 三键（规格 §7.2 唯一可靠的平台表情证据形态）。 */
const MARKET_FACE = {
  summary: "[萌宠]",
  key: "synthetic-secret-key",
  emoji_id: "00abc123",
  emoji_package_id: "8",
} as const;

/** 合成账号与发言人。 */
const ACCOUNT = "90001";
const SPEAKER = "10001";

/** wire 上一个 PNG data URL 的真实像素尺寸（解字节读 IHDR，不是信脚本自述的元数据）。 */
function pngSizeOfDataUrl(url: string): { width: number; height: number; sha256: string } {
  const at = url.indexOf(",");
  if (!url.startsWith("data:image/") || at < 0)
    throw new Error(`not a data URL: ${url.slice(0, 32)}`);
  const bytes = new Uint8Array(Buffer.from(url.slice(at + 1), "base64"));
  if (bytes.length < 24) throw new Error("wire PNG too short to carry a header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR")
    throw new Error("wire image is not a PNG with an IHDR first chunk");
  return { width: view.getUint32(16), height: view.getUint32(20), sha256: sha(bytes) };
}

/** 真 APNG 夹具：PNG 签名 + IHDR + **acTL**（动画控制块，必须在首个 IDAT 之前）+ IDAT + IEND。 */
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
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** 宿主诊断事件的最小形状（与 OneBotHost 的 BotHostDiagnostic 同字段）。 */
interface Diagnostic {
  readonly stage: string;
  readonly status: string;
  readonly code?: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

/** 某相真实的 media_mode 观测：模式三元组、图数与逐条真实 omission。 */
interface MediaMode {
  readonly phase: string;
  readonly requestedMode: string;
  readonly actualMode: string;
  readonly imageCount: number;
  readonly omissionCount: number;
  readonly omissions: readonly { mediaId: string; reason: string }[];
}

function mediaModes(diagnostics: readonly Diagnostic[]): MediaMode[] {
  const out: MediaMode[] = [];
  for (const event of diagnostics) {
    if (event.stage !== "media_mode") continue;
    const details = event.details ?? {};
    const omissions: { mediaId: string; reason: string }[] = [];
    for (const [key, value] of Object.entries(details))
      if (key.startsWith("omission:") && typeof value === "string")
        omissions.push(JSON.parse(value) as { mediaId: string; reason: string });
    out.push({
      phase: String(details.phase ?? ""),
      requestedMode: String(details.requestedMode ?? ""),
      actualMode: String(details.actualMode ?? ""),
      imageCount: Number(details.imageCount ?? 0),
      omissionCount: Number(details.omissionCount ?? 0),
      omissions,
    });
  }
  return out;
}

/** 某相的「本轮不可读」omission（产品对 unsupported_animation 的唯一窄捕获出口）。 */
const unreadableOmissions = (
  modes: readonly MediaMode[],
): readonly { mediaId: string; reason: string }[] =>
  modes.flatMap((mode) => mode.omissions.filter((omission) => omission.reason === "unreadable"));

// ---- 真实多段平台 wire 入站（harness 的 receive 一次只送一段 image） ------------------------

/**
 * 走生产**同一条**入站路径：`normalizeOneBotMessage` 归一 → `recordInbound` 摄入。所以平台分类
 * 证据（market face 三键）、mediaId 分配、fact parts 顺序与消息关系全部是真实实现的结果——不往
 * DB 里塞 category、不手动插媒体行、不手写 fact、不做 seed proof。
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
  },
  // 返回**逐字送出**的平台 wire 载荷：三键等平台证据只有它才是「真实入站」的原始凭据（facts 里的
  // category 是它的派生结果，不是入站本身）。
): Record<string, unknown> {
  const binding = h.orm
    .select()
    .from(schema.qqBindings)
    .where(eq(schema.qqBindings.id, h.bindingId))
    .get();
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
  return payload;
}

// ---- 真实表行读回（列名全部来自 migration 0052 / 0012，不猜） -----------------------------

const rowsOf = (h: OneBotHarness, sql: string): Record<string, unknown>[] =>
  h.db.query(sql).all() as Record<string, unknown>[];

const assetRows = (h: OneBotHarness): Record<string, unknown>[] =>
  rowsOf(h, "SELECT id, content_sha256, mime_type FROM qq_media_assets ORDER BY content_sha256");

const variantRows = (h: OneBotHarness): Record<string, unknown>[] =>
  rowsOf(
    h,
    "SELECT id, asset_id, policy, mime_type, width, height, frame_count FROM qq_media_variants ORDER BY policy",
  );

/** 事实资料段里每条消息的**完整**字段（不是只抠 category）：完整字段才是行为证据本身。 */
const factMessageLines = (segments: readonly string[]): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const segment of segments)
    for (const match of segment.matchAll(/^msg=(\{.*\})$/gm)) {
      try {
        out.push(JSON.parse(match[1] ?? "{}") as Record<string, unknown>);
      } catch {
        /* 解不开的单行不伪造：跳过（外层断言自然失败并留现场）。 */
      }
    }
  return out;
};

/**
 * 决策响应**信封协议**在本机桩这里的判据：只读**本次请求自己带在身上的协议**，不猜、不按图片
 * 张数分支、不按固定 case 硬写。
 *
 * 为什么不能只看 `response_format`：真实决策 schema 是判别联合（`oneOf`），外部路由按
 * strict-json-schema 的既定降级链**从 `json_object` 起步**（`strictSchemaAccepted` 对 `oneOf`
 * 直接判否）。于是 `response_format` 恒为 `{"type":"json_object"}`，信封版决策与 plain 版决策
 * 在 wire 上 response_format **逐字相同**。上一版桩靠 `schemaHasMediaBranch` 分支，因此对
 * 真实的信封决策恒答 plain，宿主拿到裸 `{"kind":…}`，`parseModelEnvelope` 的 `z.strictObject`
 * 拒缺失的 `decision` 键，整轮以 AGENT_DECISION_INVALID 收场。
 *
 * 为什么也不能靠系统提示里声明的 `outputSchema`：`context-engine` 那一行**恒定**声明
 * `AGENT_DECISION_JSON_SCHEMA`（无论宿主本次是否挂了信封），实测 S26 与 S33 的系统提示逐字
 * 相同（同一 sha256）。声明面看不出信封——这是本桩上一版尝试的真实否定证据，留在注释里提醒
 * 下一个人不要再拿它当判据。
 *
 * 本次请求真正自带的信封判据是**事实投影里待分类那一面**：`context-source` 把 image part 的
 * `category` 统一投影成 `unknown` 存在标记，而宿主只在**该相投影里存在 unknown 图**时才换
 * 信封 schema（`hasUnknownImages`）。所以从本次请求 `qq_message_facts` 段逐字读出的 image part
 * 类别，就是这次决策**实际适用**信封协议的同一判据，并且它随请求变化：
 *   * S26 的平台三键已定 `category="expression"` → 无 unknown → 不启用信封（plain 决策）；
 *   * S33 的两段 image part 都是 `category="unknown"` → 启用信封（`{decision, media}`）。
 * 读的是本次请求真实下发的媒体事实面：不按 URL 猜类别、不按图片个数推断、也不是"只要有图
 * 就当信封"。
 */
/**
 * 生成相**正文信封**协议的判据：本次请求的 `response_format` 自己声明了带顶层 `text` 键的
 * `json_schema`（宿主 `QQ_TEXT_ENVELOPE_SCHEMA`）。
 *
 * 这里可以看 `response_format`，与决策相反：`QQ_TEXT_ENVELOPE_SCHEMA` 不含 `oneOf`，所以
 * strict-json-schema 接受它，外部路由不从 `json_object` 起步，`json_schema` 真的上了 wire。
 * 判的仍是**声明本身**（顶层有没有 `text` 键），不是关键词、不是图片个数、不是 case 名。
 */
function declaresTextProtocol(responseFormat: unknown): boolean {
  if (responseFormat === null || typeof responseFormat !== "object") return false;
  const format = responseFormat as { type?: unknown; json_schema?: { schema?: unknown } };
  if (format.type !== "json_schema") return false;
  const schema = format.json_schema?.schema;
  if (schema === null || typeof schema !== "object") return false;
  const properties = (schema as { properties?: unknown }).properties;
  return properties !== null && typeof properties === "object" && "text" in properties;
}

/** 决策相判据：上下文引擎那句固定的决策协议说明（与 WireRequest.isDecision 同一句）。 */
const isDecisionPhase = (systemText: string): boolean =>
  systemText.includes("Return exactly one JSON decision");

/** 「QQ消息事实」资料段（外层信封键按字母序：facts / kind / trust）的未转义渲染文本。 */
const factsSegments = (text: string): string[] => {
  const out: string[] = [];
  const pattern = /\{"facts":("(?:[^"\\]|\\.)*"),"kind":"qq_message_facts"/g;
  for (const match of text.matchAll(pattern)) {
    try {
      out.push(JSON.parse(match[1] ?? '""') as string);
    } catch {
      /* 解不开的信封不伪造：跳过（外层断言自然失败并留现场）。 */
    }
  }
  return out;
};

/** 未转义的「QQ消息事实」正文里每段 image part 的 (mediaId, category)，按出现顺序逐字读出。 */
function factImageParts(text: string): { mediaId: string; category: string }[] {
  const out: { mediaId: string; category: string }[] = [];
  const pattern = /\{"kind":"image","mediaId":"([^"]*)","category":"([^"]*)"/g;
  for (const segment of factsSegments(text))
    for (const match of segment.matchAll(pattern))
      out.push({ mediaId: match[1] ?? "", category: match[2] ?? "" });
  return out;
}

/**
 * 本次决策是否适用信封协议＝本次请求带过来的**待分类 unknown 图**存不存在。
 *
 * 与宿主 `hasUnknownImages(phase)` 同一判据（该相投影里存在 `category === "unknown"` 的图），
 * 只是从**模型实际看到的那份**事实投影读（经 factsSegments 解掉 JSON 转义后逐字匹配），而不是
 * 从脚本自述推断；mediaId 也取自同一份投影，所以回的分类项不会指向未发送的媒体（宿主
 * `parseModelEnvelope` 与 `consumeModelMediaData` 的白名单还会再核一次）。
 */
function declaresEnvelopeProtocol(visible: string): {
  readonly envelope: boolean;
  readonly unknownMediaIds: readonly string[];
} {
  const unknownMediaIds = factImageParts(visible)
    .filter((part) => part.category === "unknown")
    .map((part) => part.mediaId);
  return { envelope: unknownMediaIds.length > 0, unknownMediaIds };
}

// ---- 本机 owned loopback：产品真实端口（createModelPort + createLmStudioClient） ----------

/** 一次真实 HTTP 请求的读回面（全部从 wire 上读，不采信脚本自述）。 */
interface WireRequest {
  readonly model: string;
  readonly stream: boolean;
  /** 真实 body 内携带的 image data URL 原文，按出现顺序。 */
  readonly dataUrls: readonly string[];
  /**
   * 本次决策是否适用信封协议＝本次请求的事实投影里有没有待分类 `unknown` 图（与宿主
   * `hasUnknownImages` 同一判据）。`response_format`（对 `oneOf` 恒 `json_object`）与系统提示
   * 声明的 `outputSchema`（恒为 plain）都分不出两者，见 declaresEnvelopeProtocol 的说明。
   */
  readonly declaresEnvelope: boolean;
  /**
   * 本次生成相是否走**正文信封**：`response_format` 是 `json_schema` 且其声明的 schema 带顶层
   * `text` 键（宿主 `QQ_TEXT_ENVELOPE_SCHEMA`）。与决策信封是两套协议、两个声明面。
   */
  readonly declaresTextEnvelope: boolean;
  /** 本次请求全部 system 消息的拼接（断言面：程序拥有的规则段到没到）。 */
  readonly systemText: string;
  /** 决策相判据：上下文引擎那句固定的决策协议说明。 */
  readonly isDecision: boolean;
}

interface ProviderStub {
  readonly origin: string;
  readonly wire: readonly WireRequest[];
  /** 每次真正发到 /chat/completions 的请求体原文（字节级负面核对用：data URL/base64 不落盘）。 */
  readonly raw: readonly string[];
  /**
   * 每次请求的**模型可见全文**（按 body 的 messages 逐条解出：字符串 content 原样、数组 content
   * 取其中的 text part 拼接）。断言面必须用这一份——raw body 里的引号是 JSON 转义的，直接对它做
   * 逐字匹配会把「内容真的到了」误判成「没到」。
   */
  readonly texts: readonly string[];
  close(): Promise<void>;
}

/**
 * 本机 port 0 合成 provider（只服务本文件）。**只回 HTTP，不判语义**：三种真实 response schema
 * 由 `stubAnswer` 按 schema 自身分支选形状（与 model-response-envelope 的现 parser 一一对应），
 * 能力句式、错误码与降级判定全部留给真实网关与真实宿主。
 */
async function startProvider(): Promise<ProviderStub> {
  const wire: WireRequest[] = [];
  const raw: string[] = [];
  const texts: string[] = [];
  let decisions = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!(req.url ?? "").includes("/chat/completions")) {
        // 容量探测面：给一个含两个模型的目录，容量有真实答案（不猜、不用默认值顶替）。
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "reply-model" }, { id: "judge-model" }] }));
        return;
      }
      raw.push(body);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const messages = (parsed.messages as { role: string; content: unknown }[]) ?? [];
      const dataUrls: string[] = [];
      let systemText = "";
      let visible = "";
      for (const message of messages) {
        if (typeof message.content === "string") {
          visible += `${message.content}\n`;
          if (message.role === "system") systemText += `${message.content}\n`;
          continue;
        }
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
          const type = (part as { type?: unknown }).type;
          if (type === "text") {
            const text = (part as { text?: unknown }).text;
            if (typeof text === "string") {
              visible += `${text}\n`;
              if (message.role === "system") systemText += `${text}\n`;
              continue;
            }
          }
          const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
          if (typeof url === "string" && url.startsWith("data:image/")) dataUrls.push(url);
        }
      }
      texts.push(visible);
      const isDecision = isDecisionPhase(systemText);
      // 本次决策适用的信封协议：从**本次请求真实下发的事实投影**逐字读出待分类 unknown 图。
      // response_format 与系统提示声明的 outputSchema 都分不出信封/plain（见 declaresEnvelopeProtocol）。
      const protocol = declaresEnvelopeProtocol(visible);
      const declaresEnvelope = isDecision && protocol.envelope;
      const declaresTextEnvelope = declaresTextProtocol(parsed.response_format);
      if (isDecision) decisions += 1;
      wire.push({
        model: String(parsed.model ?? ""),
        stream: parsed.stream === true,
        dataUrls,
        declaresEnvelope,
        declaresTextEnvelope,
        systemText,
        isDecision,
      });
      const answer = stubAnswer({
        declaresEnvelope,
        declaresTextEnvelope,
        stream: parsed.stream === true,
        isDecision,
        decisions,
      });
      if (parsed.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: answer } }] }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${String(address.port)}/v1`,
    wire,
    raw,
    texts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * 决策相的第一次答复要 **generate**（走生成相）：条件式表情规则段（§7.3）由
 * `buildQqPrompt` 的 media_rule 段发出，而那一段是**生成相 instructions** 的一部分
 * （`context-source.replyInstructions`）——只有真正发生一次生成调用，它才真的到达 wire。
 * `inline` 会让规则永远不上 wire，那测的就不是「规则到没到」。
 *
 * 第二次及以后的决策一律答 `none`：本轮只有一次唤醒、没有新观察，不该再要求生成；万一产品
 * 真的重算了，这里收口成静默而不是把脚本自己绕进 AGENT_STEP_LIMIT。
 */
const generateBody = {
  kind: "final" as const,
  outputs: [{ kind: "generate" as const, targetId: SPEAKER, instructions: "回应", stickerIds: [] }],
};

const noneBody = { kind: "none" as const };

const REPLY_TEXT = "这是我的合成回复正文。";

/**
 * 一次成功请求的答复：按**本次请求自己声明的协议**选形状，不猜、不按 case 硬写。
 *
 * 三种真实协议，各有各的声明面：
 *   * 生成相走 `response_format: {type:"json_schema", …}`，声明的 schema **带 `text` 顶层键**
 *     （宿主 `QQ_TEXT_ENVELOPE_SCHEMA`）→ 答 `{text, media}` 信封正文（`media` 缺省空数组——
 *     不替模型编分类）。S26 的生成相走 `stream`，不进这条。
 *   * 决策相**信封版**：本次请求的事实投影里有待分类 `unknown` 图（与宿主 `hasUnknownImages`
 *     同一判据）→ 答 `{decision, media}`。
 *   * 决策相**plain 版**：没有待分类 unknown 图 → 答裸的 `{kind:…}` 冻结决策本体。
 *
 * 决策相**不能**看 `response_format` 分：外部路由对判别联合（`oneOf`）按 strict-json-schema
 * 的既定降级链恒从 `json_object` 起步，信封版与 plain 版的 `response_format` 逐字相同。也不能
 * 看系统提示声明的 `outputSchema`：context-engine 那一行恒定声明 plain 决策 schema，所以 S26 与
 * S33 的系统提示实测逐字相同。两个否定证据都留在 declaresEnvelopeProtocol 的注释里。
 */
function stubAnswer(input: {
  readonly declaresEnvelope: boolean;
  readonly declaresTextEnvelope: boolean;
  readonly stream: boolean;
  readonly isDecision: boolean;
  readonly decisions: number;
}): string {
  if (input.stream) return REPLY_TEXT;
  if (input.declaresTextEnvelope) return JSON.stringify({ text: REPLY_TEXT, media: [] });
  // 决策相：第一次答 generate（真发生一次生成调用），第二次及以后答 none——本轮只有一次唤醒。
  const decision = input.decisions % 2 === 1 ? generateBody : noneBody;
  return input.declaresEnvelope
    ? JSON.stringify({ decision, media: [] })
    : JSON.stringify(decision);
}

/** 真实网关装成 ModelPort：走 owned loopback（真实 HTTP、真实 wire 转换、真实 vision 闸）。 */
function realPort(stub: ProviderStub) {
  const config = {
    baseUrl: stub.origin,
    model: "reply-model",
    timeoutSeconds: 5,
    apiKey: "synthetic-expression-key",
  };
  const external: ExternalModelRoute = {
    baseUrl: stub.origin,
    apiKey: "synthetic-expression-key",
    contextWindow: 65536,
    vision: true,
    toolCalling: false,
    providerRevision: 1,
  };
  return createModelPort({
    gateway: createLmStudioClient(config, {
      externalModel: (model) => (model === "reply-model" ? external : null),
    }),
  });
}

/** 本文件两块共用的宿主装配：native 输入、受控合成字节表、真实媒体组件、真实 loopback 端口。 */
function createHostHarness(
  stub: ProviderStub,
  input: {
    readonly imageBytes: Readonly<Record<string, Uint8Array>>;
    readonly diagnostics: Diagnostic[];
  },
) {
  return createOneBotHarness({
    accountId: ACCOUNT,
    member: SPEAKER,
    mediaEnabled: true,
    vision: ["合成图片描述"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: input.imageBytes,
    model: realPort(stub),
    onDiagnostic: (event) => {
      input.diagnostics.push({
        stage: event.stage,
        status: event.status,
        ...(event.code === undefined ? {} : { code: event.code }),
        ...(event.details === undefined ? {} : { details: event.details }),
      });
    },
  });
}

// ---- [S26_2] 表情规则：三键 wire → 512 规格 + 条件式规则无条件进 system -------------------

it("[S26_2] a real market-face wire segment gets the 512 spec and the expression rule reaches system", async () => {
  // 一张 1024x768 的**真** PNG 带 platform market face 三键：协议层判 expression → 事实侧
  // category=expression（来源 platform，不是 unknown、不是模型补判）→ 表情静图按 §7.4 表长边 512
  // （1024x768 → 512x384）。512 规格不靠元数据断言，而是解 wire 上 data URL 的真实字节。
  const bytes = pngOf(96, 1024, 768);
  const stub = await startProvider();
  const diagnostics: Diagnostic[] = [];
  const h = createHostHarness(stub, { imageBytes: { "s26-face": bytes }, diagnostics });
  let runError: string | null = null;
  let inboundWire: Record<string, unknown> = {};
  // 取证途中抛出的异常：记下来、照常落证据，但**原样重抛**（不把被测失败换成取证失败）。
  let evidenceError: unknown = null;
  // finally 里不能 throw（会覆盖 try/catch 的控制流），所以收尾统一在 try/catch/finally 之后。
  let thrown: unknown = null;
  let writeFailure: string | null = null;
  try {
    inboundWire = receiveWire(h, {
      id: "-2601",
      speaker: SPEAKER,
      text: "这个表情什么意思EXPRMARK",
      groupCard: "阿林",
      addressed: true,
      imageFiles: ["s26-face"],
      imageHints: [{ ...MARKET_FACE }],
    });
    try {
      await h.activate("direct_reply");
      await h.deliver();
    } catch (error) {
      runError = String(error);
    }
    // raw 用于字节级负面核对（转义后的 base64 不该出现在持久面），texts 才是模型可见全文。
    const bodies = stub.texts.join("\n");

    // ---- 强正一：整轮跑通并真的发出一条 ----
    expect(runError).toBeNull();
    expect(h.sent).toHaveLength(1);

    // ---- 强正二：真 HTTP body 上是 512 长边的表情副本（原图 1024x768 不该原样上 wire） ----
    const withImages = stub.wire.filter((entry) => entry.dataUrls.length > 0);
    expect(withImages.length).toBeGreaterThanOrEqual(2);
    for (const entry of withImages)
      for (const url of entry.dataUrls) {
        const size = pngSizeOfDataUrl(url);
        expect(size.width).toBe(512);
        expect(size.height).toBe(384);
        // 缩放重编后 sha 不再等于原图（原图 sha 只落在 asset 上，两层各自可核）。
        expect(size.sha256).not.toBe(sha(bytes));
      }
    expect(assetRows(h).some((row) => row.content_sha256 === sha(bytes))).toBe(true);

    // ---- 强正三：平台三键真被判成表情类别，且只有这一个候选类别 ----
    const facts = factsSegments(bodies).join("\n");
    expect(facts.length).toBeGreaterThan(0);
    expect(facts).toMatch(/"kind":"image","mediaId":"[^"]*","category":"expression"/);
    expect(facts).not.toMatch(/"kind":"image","mediaId":"[^"]*","category":"unknown"/);
    // 平台证据不是模型补判：没有模型分类行（分类是后续、来源分明的事实）。
    expect(rowsOf(h, "SELECT * FROM qq_media_classifications")).toHaveLength(0);

    // ---- 强正四：条件式表情规则段**无条件**进 system（native 轮无 mediaNotes/无 mediaUnread） ----
    const systemTexts = stub.wire.map((entry) => entry.systemText);
    for (const systemText of systemTexts) {
      expect(systemText).toContain('收到的图片若在事实里标为 category="expression"');
      expect(systemText).toContain("表情图按低关注处理");
    }

    // ---- 强负一：没有数值 attention 字段（只证明"无该字段"的传输面证据，不承诺模型行为） ----
    for (const entry of stub.wire) expect(entry.systemText).not.toMatch(/attention/i);

    // ---- 强负二：没有新增分类相关模型调用 ----
    // 真实相序列＝决策 1 次＋生成 1 次（direct_reply 不要求许可评分，故无评分相）；桩记录到的
    // 真实 HTTP 次数与相序列一致：没有第 3 次、没有独立分类请求、没有额外 envelope 调用。
    const decisionCalls = stub.wire.filter((entry) => entry.isDecision);
    const generationCalls = stub.wire.filter((entry) => !entry.isDecision);
    expect(decisionCalls).toHaveLength(1);
    expect(generationCalls).toHaveLength(1);
    expect(stub.wire).toHaveLength(2);
    // 表情图是平台三键已定的已知类别 → 本轮事实投影里没有待分类 unknown 图 → 不启用信封
    // （信封只对"待分类 unknown 图"启用），所以决策照走 plain 的冻结决策协议。
    expect(decisionCalls[0]?.declaresEnvelope).toBe(false);
    expect(generationCalls[0]?.declaresEnvelope).toBe(false);

    // ---- 强负三：合法的 data URL/base64 绝不落任何持久面（规格 §10） ----
    // 对**真实请求体原文**核对：JSON 转义后的 base64 片段也不该出现在任何持久行里。
    const persisted = [
      JSON.stringify(rowsOf(h, "SELECT * FROM qq_message_facts")),
      JSON.stringify(rowsOf(h, "SELECT * FROM qq_events")),
      JSON.stringify(rowsOf(h, "SELECT * FROM conversation_events")),
      JSON.stringify(rowsOf(h, "SELECT * FROM agent_runs")),
    ].join("\n");
    expect(persisted).not.toContain("data:image");
    expect(persisted).not.toContain("base64");
    for (const entry of withImages)
      for (const url of entry.dataUrls) {
        const at = url.indexOf(",");
        const body64 = url.slice(at + 1, at + 64);
        expect(stub.raw.join("\n")).toContain(body64);
        expect(persisted).not.toContain(body64);
      }
  } catch (error) {
    // 只**记下**被测失败，不在这里抛：finally 里抛会覆盖 try/catch 的控制流，那会把真正的失败
    // 换成取证失败。重抛统一放在 finally 之后（见文件末尾的收尾三行）。
    evidenceError = error;
    thrown = error;
  } finally {
    // 证据落盘在 finally：activate/deliver 抛错、取证途中抛错、任一条 assert 抛错，都已有现场。
    // 两份文件各自独立写（writeEvidence 逐个写）；写盘失败只进 evidenceError，不掩盖已记下的
    // 被测失败——只有「本来没失败、却写不出证据」才在收尾处升级成显式失败，不静默。
    writeFailure = await writeEvidence([
      {
        name: "s26_2-wire.json",
        build: () => ({
          case: "[S26_2]",
          runError,
          evidenceError: evidenceError === null ? null : String(evidenceError),
          sentCount: h.sent.length,
          // 逐字送出的平台 wire（market face 三键的原始凭据；facts 的 category 由它派生）。
          inboundWire,
          factMessageLines: factMessageLines(factsSegments(stub.texts.join("\n"))),
          rawRequests: stub.raw,
          modelVisibleTexts: stub.texts,
          wire: stub.wire.map((entry) => ({
            model: entry.model,
            stream: entry.stream,
            isDecision: entry.isDecision,
            dataUrlCount: entry.dataUrls.length,
            wireImageSizes: entry.dataUrls.map((url) => {
              try {
                const size = pngSizeOfDataUrl(url);
                return { width: size.width, height: size.height, sha256: size.sha256 };
              } catch (error) {
                return { error: String(error) };
              }
            }),
            declaresEnvelope: entry.declaresEnvelope,
            declaresTextEnvelope: entry.declaresTextEnvelope,
          })),
          systemTextByCall: stub.wire.map((entry) => entry.systemText),
        }),
      },
      {
        name: "s26_2-tables.json",
        build: () => ({
          case: "[S26_2]",
          runError,
          evidenceError: evidenceError === null ? null : String(evidenceError),
          factRows: rowsOf(
            h,
            "SELECT event_key, parts, group_card, personal_nickname, name_state, reply_to_message_id FROM qq_message_facts",
          ),
          assets: assetRows(h),
          variants: variantRows(h),
          classifications: rowsOf(h, "SELECT * FROM qq_media_classifications"),
          mediaModes: mediaModes(diagnostics),
        }),
      },
    ]);
    h.close();
    await stub.close();
  }
  // 收尾：先重抛被测失败（它比取证问题重要），没有失败时才把「写不出证据」升级成显式失败。
  if (thrown !== null) throw thrown;
  if (writeFailure !== null) throw new Error(`evidence write failed: ${writeFailure}`);
});

// ---- [S33_2] 真正不可读的动画 + 合法静图：动画只落 data_only 说明、静图照常上 wire --------

it("[S33_2] an unreadable animation is marked data_only while a legal still is sent and the turn completes", async () => {
  // 同一条 focus 消息带两段 image：动画（真 APNG 字节，宿主侧无法诚实采样）＋一张合法静图。
  // §7.5：动画本轮「存在但不可读」——保留原始字节缓存（asset），但零准备副本、零 image part、
  // 不作消费证明；合法静图照常按普通规格（null 长边＝原图）上 wire；两段 image part 的消息关系
  // 与窗口文字都保留（被舍弃不是"不存在"），整轮照常回复成功。
  const animated = animatedApngBytes(8, 8, 2);
  const still = pngOf(52);
  const stub = await startProvider();
  const diagnostics: Diagnostic[] = [];
  const h = createHostHarness(stub, {
    imageBytes: { "s33-anim": animated, "s33-still": still },
    diagnostics,
  });
  let runError: string | null = null;
  let inboundWire: Record<string, unknown> = {};
  // 取证途中抛出的异常：记下来、照常落证据，但**原样重抛**（不把被测失败换成取证失败）。
  let evidenceError: unknown = null;
  // finally 里不能 throw（会覆盖 try/catch 的控制流），所以收尾统一在 try/catch/finally 之后。
  let thrown: unknown = null;
  let writeFailure: string | null = null;
  try {
    inboundWire = receiveWire(h, {
      id: "-3301",
      speaker: SPEAKER,
      text: "这两张分别是啥UNREADABLEMARK",
      groupCard: "阿林",
      addressed: true,
      imageFiles: ["s33-anim", "s33-still"],
    });
    try {
      await h.activate("direct_reply");
      await h.deliver();
    } catch (error) {
      runError = String(error);
    }
    // raw 用于字节级负面核对（动画的原始 base64 不该上 wire），texts 才是模型可见全文。
    const bodies = stub.texts.join("\n");
    const modes = mediaModes(diagnostics);
    // 相观测里的「本轮不可读」omission：产品对 unsupported_animation 的唯一窄捕获出口。
    const unreadable = unreadableOmissions(modes);
    // 「QQ消息事实」资料段：平台分类证据与消息关系都在这里（外层信封键按字母序）。
    const facts = factsSegments(bodies).join("\n");
    const wireImageSizes = stub.wire.flatMap((entry) =>
      entry.dataUrls.map((url) => {
        try {
          const size = pngSizeOfDataUrl(url);
          return { width: size.width, height: size.height, sha256: size.sha256 };
        } catch (error) {
          return { error: String(error) };
        }
      }),
    );
    // ---- 强正一：不可读动画不打死整轮 ----
    expect(runError).toBeNull();
    expect(h.sent).toHaveLength(1);

    // ---- 强正一之二：本轮决策真的走了信封协议（不是"碰巧答对"） ----
    // 事实投影里两段 image part 都是待分类 unknown → 宿主挂信封 schema → 决策必须按
    // `{decision, media}` 解。这一条断言的是**协议形状被真实使用**，与"整轮跑通"互相独立：
    // 桩若退回 plain（`{kind:…}` 裸本体），宿主会 AGENT_DECISION_INVALID，整轮根本走不到这里。
    const s33Decisions = stub.wire.filter((entry) => entry.isDecision);
    expect(s33Decisions).toHaveLength(1);
    expect(s33Decisions[0]?.declaresEnvelope).toBe(true);
    // 附属分类缺省空数组＝桩不替模型编分类；本文件不消费任何分类，所以库里没有分类行。
    expect(rowsOf(h, "SELECT * FROM qq_media_classifications")).toHaveLength(0);

    // ---- 强正二：合法静图真的上了 wire（普通规格：原图 8x8、字节与注入的完全相同） ----
    expect(wireImageSizes.length).toBeGreaterThanOrEqual(1);
    for (const image of wireImageSizes) {
      expect(image).toEqual({ width: 8, height: 8, sha256: sha(still) });
    }

    // ---- 强负一：动画零准备副本、零首帧字节、零 image part ----
    //  * 准备副本只有合法静图那一张；动画在 codec 边界就被拒（unsupported_animation），不进 variant。
    const variants = variantRows(h);
    expect(variants).toHaveLength(1);
    expect(variants[0]?.width).toBe(8);
    expect(variants[0]?.height).toBe(8);
    const stillAsset = assetRows(h).find((row) => row.content_sha256 === sha(still));
    expect(stillAsset).toBeDefined();
    expect(variants[0]?.asset_id).toBe(stillAsset?.id);
    //  * 动画的原始字节一个都没进 wire（没有"静态帧冒充已理解"）。
    expect(bodies).not.toContain(Buffer.from(animated).toString("base64"));
    //  * asset 允许保留动画的**原始**缓存字节（受控缓存，不作消费证明）——不作强负。
    const animatedAsset = assetRows(h).find((row) => row.content_sha256 === sha(animated));
    if (animatedAsset !== undefined) expect(animatedAsset.mime_type).toBe("image/png");
    //  * 事实侧两段 image part 各自 mediaId（真实分配、互不相同），动画那一份在 wire 上没有
    //    对应的 image part（wire 上只有来源元数据），只有 data_only 说明提到它。
    //    按**互不相同的 mediaId** 计数：本轮真的发生决策相＋生成相两次调用，同一条事实资料段
    //    会逐字出现在两次请求里，按出现次数计数会把「两次调用都带齐」误判成「多出图片」。
    const mediaIds = [
      ...new Set(
        (facts.match(/"kind":"image","mediaId":"[^"]*"/g) ?? []).map(
          (part) => /"mediaId":"([^"]*)"/.exec(part)?.[1] ?? "",
        ),
      ),
    ];
    expect(mediaIds.length).toBe(2);
    expect(mediaIds.filter((id) => id === "")).toHaveLength(0);
    // 动画的 mediaId 是真实分配的那一个，且与上 wire 的静图 mediaId 不同（不是同一张图）。
    expect(unreadable[0]?.mediaId).toBeTruthy();
    expect(mediaIds).toContain(unreadable[0]?.mediaId ?? "");
    expect(unreadable[0]?.mediaId).not.toBe(
      mediaIds.find((id) => id !== (unreadable[0]?.mediaId ?? "")),
    );

    // ---- 强负二：相观测如实记「图存在但不可读」，不记成已提供 ----
    expect(unreadable.length).toBeGreaterThanOrEqual(1);
    for (const omission of unreadable) expect(omission.reason).toBe("unreadable");
    for (const mode of modes.filter((entry) => entry.omissions.length > 0))
      expect(mode.actualMode).toBe("native");

    // ---- 强正三：data_only 说明在**实际请求里**逐字带 mediaId/messageId/reason ----
    expect(bodies).toContain('"kind":"qq_media_unreadable"');
    expect(bodies).toContain('"trust":"data_only"');
    expect(bodies).toContain('"reason":"unreadable"');
    expect(bodies).toContain(unreadable[0]?.mediaId ?? "missing-media-id");
    // 消息关系：omission 的 messageId 是这条消息的**事实身份**（qq_message_facts.event_key，事实
    // 资料段里就是同一条 msg 的 id），platformMessageId 另列在事实行上。信封键按字母序
    // （contextDumps 递归排序键），逐字形态是 {"kind":"qq_media_unreadable","omissions":[
    // {"mediaId":…,"messageId":"<factId>","reason":"unreadable"}],"trust":"data_only"}。
    // 事实身份 id 自身含转义引号（`["qq",…]` 在资料段里是 `\["qq\",…]`），所以捕获组要能吃
    // 转义序列，不能用 `[^"]*`——那会在第一个 `"` 处截断，整条正则匹配不上，factId 恒为空串。
    const factId =
      /msg=\{"id":"((?:[^"\\]|\\.)*)","platformMessageId":"-3301"/.exec(facts)?.[1] ?? "";
    expect(factId).not.toBe("");
    expect(bodies).toContain(
      `"omissions":[{"mediaId":"${unreadable[0]?.mediaId ?? ""}","messageId":"${factId}","reason":"unreadable"}]`,
    );

    // ---- 强正四：消息关系与窗口文字都保留（两段 image part 都在，文字没被牺牲） ----
    // 同上按互不相同的 mediaId 计数（决策相与生成相都带同一条事实资料段）。
    expect(facts.length).toBeGreaterThan(0);
    expect(new Set(facts.match(/"kind":"image","mediaId":"[^"]*"/g) ?? []).size).toBe(2);
    expect(bodies).toContain("UNREADABLEMARK");

    // ---- 强负三：窗口文字没被牺牲的同时，动画仍零画面（再次按字节核对） ----
    for (const image of wireImageSizes) expect(image.sha256).not.toBe(sha(animated));
  } catch (error) {
    // 同 S26_2：只记下被测失败，重抛放到 finally 之后（finally 里抛会覆盖控制流）。
    evidenceError = error;
    thrown = error;
  } finally {
    // 证据落盘在 finally：activate/deliver 抛错、取证途中抛错、任一条 assert 抛错，都已有现场。
    writeFailure = await writeEvidence([
      {
        name: "s33_2-wire.json",
        build: () => ({
          case: "[S33_2]",
          runError,
          evidenceError: evidenceError === null ? null : String(evidenceError),
          sentCount: h.sent.length,
          // 逐字送出的平台 wire（两段 image：动画没有三键，所以事实里不是表情类别）。
          inboundWire,
          factMessageLines: factMessageLines(factsSegments(stub.texts.join("\n"))),
          rawRequests: stub.raw,
          modelVisibleTexts: stub.texts,
          wire: stub.wire.map((entry) => ({
            model: entry.model,
            stream: entry.stream,
            isDecision: entry.isDecision,
            dataUrlCount: entry.dataUrls.length,
            declaresEnvelope: entry.declaresEnvelope,
            declaresTextEnvelope: entry.declaresTextEnvelope,
          })),
          wireImageSizes: stub.wire.flatMap((entry) =>
            entry.dataUrls.map((url) => {
              try {
                const size = pngSizeOfDataUrl(url);
                return { width: size.width, height: size.height, sha256: size.sha256 };
              } catch (error) {
                return { error: String(error) };
              }
            }),
          ),
        }),
      },
      {
        name: "s33_2-tables.json",
        build: () => ({
          case: "[S33_2]",
          runError,
          evidenceError: evidenceError === null ? null : String(evidenceError),
          factRows: rowsOf(
            h,
            "SELECT event_key, parts, group_card, personal_nickname, name_state, reply_to_message_id FROM qq_message_facts",
          ),
          assets: assetRows(h),
          variants: variantRows(h),
          mediaModes: mediaModes(diagnostics),
        }),
      },
    ]);
    h.close();
    await stub.close();
  }
  // 收尾：先重抛被测失败（它比取证问题重要），没有失败时才把「写不出证据」升级成显式失败。
  if (thrown !== null) throw thrown;
  if (writeFailure !== null) throw new Error(`evidence write failed: ${writeFailure}`);
});
