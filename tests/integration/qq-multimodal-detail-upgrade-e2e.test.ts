// T10 细节升级（detail upgrade）整链验证 —— tool-first 既有契约，无新协议字段。
//
// 产品语义（规格 §7.4/§7.5：明确细问表情按普通规格、不改原分类；细问的关键图最优先）：
// 已知表情默认规格 → 普通决策经既有工具按需补细节；宿主复验真实问题/来源/范围/能力；
// 同 activation 后续相只供被选中的普通规格图；不做全历史重放、不加第 4 次分类调用、
// 不改写分类、不抬预算默认。
//
// 契约：normal decision invoke media.list → media.read{id, questionMessageId}（既有契约，
// S28_2/S28_4 已证）；description 模式 media.describe / media.note.read 既有可选问题指针
// （resolveQuestionAnchor，detail 与 baseline 两条独立预算）。无 detailRequests / 私有分类
// 字段：决策 JSON 旧形状由本文件自带 objectport 直接脚本化，不改 tests/harness、不改产品。
//
// 用例（3+1 正交例；forged question / cross-scope 已由既有 [S28_3]/[S28_5]
// （qq-multimodal-image-shape-e2e.test.ts）精准覆盖，引用不重写）：
//   [DU_1] 正例 + 选择边界：平台表情 1024x512 自动按 512x256 准备；tool invoke media.read
//          （问题锚）后同 activation 后续相只收到被选中的 ordinary 1024x512；其他 focus/direct
//          图不补不升级；category 仍 expression；asset content sha 不变，新 variant sha 按
//          实际 variant 字节真核；首问正文/历史帧同材料不重复追加；source 字节每图一次、
//          detail 走缓存零新增；同 run 相/调用计数实测。
//   [DU_2] inline 回答必须发生在后续决策真实收到 ordinary 之后；none 决策零额外调用。
//   [DU_3] tool 之后能力真实关闭（updateQqGroupConfig 真实 CAS 翻转，纪元推进）→ 真实
//          MEDIA_CAPABILITY_EPOCH_CHANGED，绝不把 prepared-ok 当证明。本文件未覆盖的独立
//          边界：①问题正文 revision 中途真实变更（仅限合法 fixture 的 action-pending 窗口，
//          待 caller 接口建立后补例）；②native 相 stage-off（stages.generation/decision
//          false）独立场景不在本文件，本文件不称覆盖。
//   [DU_4] description 模式：media.describe{id, questionMessageId}（detail 预算）→
//          media.note.read{id, 同 questionMessageId} 读出 detail 正文（新 detail 出口）；
//          另一真实图 id-only baseline describe/note.read 作对照；两任务 purpose/
//          questionKey/attempts 独立不 reset（真实 qq_media_read_tasks 账本行核）。本例不断言
//          stage-off。
//
// 红线：全链真实 OneBot harness（createOneBotHarness），不建第二 harness、不造假 provider；
// 不读真实 data/local/artifacts/state、不联网、不触 17861；模型可见 image part 只有来源
// 元数据（无 bytes/base64/data/url/path/file）；不 import artifacts。
// 原始诊断只经可选 env（SUPERSTRING_DU_TRACE_DIR）
// 落盘，文件名带 UTC nonce 永不覆盖；源码内零本机路径、零批次内部 id 硬编码。
//

import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import {
  readQqGroupAgentConfig,
  readQqGroupCapabilityRevision,
  updateQqGroupConfig,
} from "../../src/server/db/qq-group-config-repository";
import { readQqScheme } from "../../src/server/db/qq-scheme-repository";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";

afterEach(() => {
  closeHarnesses();
});

// ---- 本文件内小工具（不构成第二 harness / 第二模型链）--------------------------------

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** 合成静图：真实 PNG 编码（IHDR 真实），每张字节不同便于按 sha 对账。 */
const pngOf = (fill: number, width = 8, height = 8): Uint8Array =>
  encodeQqFramePng(new Uint8Array(width * height * 4).fill(fill), width, height);

/** 真实 PNG 的 IHDR 宽高（字节 16..24，大端）——尺寸证据来自编码结果，不是构造参数。 */
const ihdrOf = (bytes: Uint8Array): { width: number; height: number } => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

/** 平台 market face 三键（规格 §7.2 唯一可靠的平台表情证据形态）。 */
const MARKET_FACE = {
  summary: "[萌宠]",
  key: "synthetic-secret-key",
  emoji_id: "00abc123",
  emoji_package_id: "8",
} as const;

// ---- 自带 objectport：完整捕获每次请求的全部 text/image part（h.model 为 null，
// 不存在 4000 字摘要面；断言面永远是这里的完整深拷贝）--------------------------------

type DecisionSpec =
  | { readonly kind: "invoke"; readonly name: string; readonly arguments?: Record<string, unknown> }
  | { readonly kind: "final"; readonly outputs: readonly Record<string, unknown>[] }
  | { readonly kind: "none" };

type PortStep =
  | {
      readonly kind: "decision";
      /** 决策内容；build 收到此前全部捕获（media.list 观察解析出真实披露 id 再定 media.read 参数）。 */
      readonly build: (captures: readonly CapturedCall[]) => DecisionSpec;
      /** 返回决策 JSON 前执行恰一次（真实宿主侧状态变更的注入点，如能力关闭）。 */
      readonly beforeRespond?: () => void;
    }
  | { readonly kind: "text"; readonly text: string };

interface CapturedCall {
  readonly kind: "decision" | "text";
  readonly messages: ModelMessage[];
  readonly tools: readonly string[];
}

interface WireImage {
  readonly mediaId: string;
  readonly revision: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
}

function createCapturePort(steps: readonly PortStep[]): {
  port: Partial<ModelPort>;
  captures: CapturedCall[];
  pendingSteps: () => number;
} {
  const queue = [...steps];
  const captures: CapturedCall[] = [];
  const firstText = (request: ModelRequest): string => {
    for (const message of request.messages)
      for (const part of message.content) if (part.kind === "text") return part.text;
    return "";
  };
  const take = (expected: PortStep["kind"]): PortStep => {
    const step = queue.shift();
    if (!step || step.kind !== expected)
      throw new Error(
        `DU_PORT_STEP_MISMATCH: expected ${expected}, queue ${queue.length + (step ? 1 : 0)}`,
      );
    return step;
  };
  const record = (kind: CapturedCall["kind"], request: ModelRequest): void => {
    captures.push({
      kind,
      messages: structuredClone(request.messages) as ModelMessage[],
      tools: (request.tools ?? []).map((tool) => tool.name),
    });
  };
  const decisionTextOf = (spec: DecisionSpec, envelope: boolean): string => {
    const body =
      spec.kind === "invoke"
        ? {
            kind: "invoke",
            calls: [{ name: spec.name, arguments: spec.arguments ?? {} }],
          }
        : spec.kind === "final"
          ? { kind: "final", outputs: spec.outputs }
          : { kind: "none" };
    // 决策响应封装仅在 schema 明确声明 media 时使用（与 tests/harness/model.ts 同判据）。
    return envelope ? JSON.stringify({ decision: body, media: [] }) : JSON.stringify(body);
  };
  const envelopeWanted = (request: ModelRequest): boolean => {
    const schema = request.responseSchema;
    if (!schema) return false;
    const props = schema.properties as Record<string, unknown> | undefined;
    if (props !== null && typeof props === "object" && "media" in props) return true;
    const branches = schema.oneOf as Record<string, unknown>[] | undefined;
    return (
      Array.isArray(branches) &&
      branches.some(
        (branch) =>
          branch.properties !== null &&
          typeof branch.properties === "object" &&
          "media" in (branch.properties as Record<string, unknown>),
      )
    );
  };
  const port: Partial<ModelPort> = {
    async complete(request) {
      request.onModelResolved?.(request.model ?? "judge-model");
      const schema = request.responseSchema;
      const props =
        schema?.properties !== null && typeof schema?.properties === "object"
          ? (schema.properties as Record<string, unknown>)
          : {};
      if ("scoreResult" in props)
        throw new Error("DU_PORT_UNEXPECTED_CALL: score phase not scripted in this file");
      const isDecision =
        (request.tools?.length ?? 0) > 0 ||
        firstText(request).includes("Return exactly one JSON decision");
      if (isDecision) {
        record("decision", request);
        const step = take("decision") as Extract<PortStep, { kind: "decision" }>;
        step.beforeRespond?.();
        return decisionTextOf(step.build(captures), envelopeWanted(request));
      }
      if ("text" in props) {
        record("text", request);
        const step = take("text") as Extract<PortStep, { kind: "text" }>;
        return JSON.stringify({ text: step.text, media: [] });
      }
      throw new Error("DU_PORT_UNEXPECTED_CALL: neither decision nor text schema");
    },
    async *streamText(request) {
      record("text", request);
      const step = take("text") as Extract<PortStep, { kind: "text" }>;
      const half = Math.ceil(step.text.length / 2);
      yield step.text.slice(0, half);
      yield step.text.slice(half);
    },
  };
  return { port, captures, pendingSteps: () => queue.length };
}

const captureImages = (call: CapturedCall): WireImage[] =>
  call.messages.flatMap((message) =>
    message.content.flatMap((part) =>
      part.kind === "image"
        ? [
            {
              mediaId: part.sourceId,
              revision: part.revision,
              mimeType: part.mimeType,
              sha256: part.sha256,
              width: part.width === undefined ? null : part.width,
              height: part.height === undefined ? null : part.height,
            },
          ]
        : [],
    ),
  );

interface ObservationEnvelope {
  readonly kind: string;
  readonly trust: string;
  readonly value: {
    readonly id: string;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
    readonly value: unknown;
  };
}

/** 从单次捕获的完整 text part 解析 action_observation 信封（JSON.parse 全文，不做子串匹配）。 */
const observationsOf = (call: CapturedCall, name: string): ObservationEnvelope[] => {
  const found: ObservationEnvelope[] = [];
  for (const message of call.messages)
    for (const part of message.content) {
      if (part.kind !== "text") continue;
      try {
        const parsed = JSON.parse(part.text) as ObservationEnvelope;
        if (parsed.kind === "action_observation" && parsed.value?.name === name) found.push(parsed);
      } catch {
        // 非信封文本跳过；信封形状错误由外层断言真实失败。
      }
    }
  return found;
};

/** 规格红线：持久 ModelMessage 的 image part 只带来源元数据，逐块核对（多一个键就红）。 */
const noBytesOnWire = (captures: readonly CapturedCall[]): void => {
  for (const call of captures)
    for (const message of call.messages)
      for (const part of message.content) {
        if (part.kind !== "image") continue;
        for (const forbidden of ["bytes", "base64", "data", "url", "path", "file"])
          expect(Object.keys(part)).not.toContain(forbidden);
      }
};

/** QQ 消息事实信封的未转义渲染文本（分类/关系断言面）。 */
const variantRows = (h: OneBotHarness): { policy: string; width: number; height: number }[] =>
  h.db.query("SELECT policy, width, height FROM qq_media_variants").all() as {
    policy: string;
    width: number;
    height: number;
  }[];

/** 按 width/height 取真实落库 variant 字节（wire part sha 与它逐字对账，不是猜）。 */
const variantBytesOf = (h: OneBotHarness, width: number, height: number): Uint8Array => {
  const row = h.db
    .query("SELECT bytes FROM qq_media_variants WHERE width=? AND height=? LIMIT 1")
    .get(width, height) as { bytes: ArrayBufferLike } | null;
  if (row === null) throw new Error(`variant ${width}x${height} missing`);
  return new Uint8Array(row.bytes);
};

const assetShas = (h: OneBotHarness): string[] =>
  (
    h.db.query("SELECT content_sha256 FROM qq_media_assets ORDER BY id").all() as {
      content_sha256: string;
    }[]
  ).map((row) => row.content_sha256);

const classificationCount = (h: OneBotHarness): number =>
  (h.db.query("SELECT COUNT(*) AS n FROM qq_media_classifications").get() as { n: number }).n;

/** 原始诊断：只经可选 env 落盘，UTC nonce 文件名永不覆盖；未设 env＝完全不写盘。 */
const writeDuTrace = (caseId: string, payload: Record<string, unknown>): void => {
  const dir = process.env.SUPERSTRING_DU_TRACE_DIR;
  if (dir === undefined || dir === "") return;
  mkdirSync(dir, { recursive: true });
  const stem = `du-${caseId}-raw-${Date.now()}-${process.pid}`;
  let name = `${stem}.json`;
  for (let n = 2; existsSync(join(dir, name)); n += 1) name = `${stem}-${n}.json`;
  writeFileSync(
    join(dir, name),
    `${JSON.stringify({ utc: new Date().toISOString(), case: caseId, ...payload }, null, 2)}\n`,
    "utf8",
  );
};

/** media.list 观察里按平台消息 id 串定位真实披露 item（id 来自观察，不猜）。 */
const disclosedIdFor = (captures: readonly CapturedCall[], platformMessageId: string): string => {
  for (const call of captures)
    for (const envelope of observationsOf(call, "media.list")) {
      const value = envelope.value.value as
        | { status?: string; items?: readonly { id?: string; eventKey?: string }[] }
        | undefined;
      const item = (value?.items ?? []).find((entry) =>
        entry.eventKey?.includes(platformMessageId),
      );
      if (item?.id !== undefined) return item.id;
    }
  throw new Error(`media not disclosed for ${platformMessageId}`);
};

const runErrorOf = async (run: () => Promise<unknown>): Promise<{ code?: unknown } | null> => {
  try {
    await run();
  } catch (error) {
    return error as { code?: unknown };
  }
  return null;
};

// ---- [DU_1] 正例 + 选择边界 -----------------------------------------------------------------

it("[DU_1] a question-anchored media.read supplies only the selected ordinary image in the same activation", async () => {
  // 平台表情 1024x512（真实 IHDR）自动按表情规格 512x256 准备；tool-first：media.list →
  // media.read{id, questionMessageId="-2502"} → 后续相只收被选中图的 ordinary 1024x512；
  // 直连原图（普通图）不补不升级；category 仍 expression；asset sha 不变、variant sha 真核；
  // 首问正文/事实同材料不重复追加；source 字节每图一次，detail 走缓存零新增。
  const exprBytes = pngOf(120, 1024, 512);
  const plainBytes = pngOf(80, 800, 400);
  expect(ihdrOf(exprBytes)).toEqual({ width: 1024, height: 512 });
  const fetches = { count: 0 };
  const { port, captures, pendingSteps } = createCapturePort([
    {
      kind: "decision",
      build: () => ({ kind: "invoke", name: "media.list", arguments: {} }),
    },
    {
      kind: "decision",
      build: (seen) => ({
        kind: "invoke",
        name: "media.read",
        arguments: { id: disclosedIdFor(seen, "-2502"), questionMessageId: "-2502" },
      }),
    },
    {
      kind: "decision",
      build: () => ({
        kind: "final",
        outputs: [
          { kind: "generate", targetId: "10001", instructions: "回答表情细节", stickerIds: [] },
        ],
      }),
    },
    { kind: "text", text: "合成回复正文" },
  ]);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "du1-face": exprBytes, "du1-plain": plainBytes },
    fetchHook: async () => {
      fetches.count += 1;
    },
    model: port,
  });
  h.receive({
    id: "-2501",
    speaker: "20002",
    text: "看这张原图 DU1PLAIN",
    groupCard: "小周",
    image: "du1-plain",
  });
  h.receive({
    id: "-2502",
    speaker: "10001",
    text: "这个表情包上画的是什么 DU1",
    groupCard: "阿林",
    image: "du1-face",
    imageHint: { ...MARKET_FACE },
    addressed: true,
    replyTo: "-2501",
  });
  await h.activate("direct_reply");
  await h.deliver();
  expect(h.sent).toHaveLength(1);

  // 相/调用按真实 workflow 核：首调决策、正文在最后、脚本步恰好消费完；工具步对应的正常
  // 决策调用数以实际为准，不硬编码总次数；无辅助/第四分类调用。
  expect(captures[0]?.kind).toBe("decision");
  expect(captures[captures.length - 1]?.kind).toBe("text");
  expect(
    captures.some((call, index) => call.kind === "text" && index !== captures.length - 1),
  ).toBe(false);
  expect(pendingSteps()).toBe(0);

  // 决策相：表情 512x256（自动规格），直连普通图原尺寸；wire part sha 与真实 variant 字节对账。
  const firstImages = captureImages(captures[0] as CapturedCall);
  const exprFirst = firstImages.find((image) => image.width === 512 && image.height === 256);
  expect(exprFirst?.sha256).toBe(sha(variantBytesOf(h, 512, 256)));
  const plainFirst = firstImages.find((image) => image.width === 800 && image.height === 400);
  if (!plainFirst) throw new Error("Original image was not supplied in the first request");
  expect(plainFirst.sha256).toBe(sha(variantBytesOf(h, 800, 400)));

  // media.read 观察真实 ok：ordinary 规格、category 仍 expression（平台证据未被改写）。
  const observationsById = new Map<string, ObservationEnvelope>();
  for (const call of captures) {
    for (const observation of observationsOf(call, "media.read")) {
      const previous = observationsById.get(observation.value.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(observation))
        throw new Error("Repeated observation id has changed content");
      observationsById.set(observation.value.id, observation);
    }
  }
  const readObservations = [...observationsById.values()];
  expect(readObservations).toHaveLength(1);
  const readValue = readObservations[0]?.value.value as
    | {
        status?: string;
        category?: string;
        images?: readonly { width?: number; height?: number }[];
      }
    | undefined;
  expect(readValue?.status).toBe("ok");
  expect(readValue?.category).toBe("expression");
  expect(
    (readValue?.images ?? []).some((image) => image.width === 1024 && image.height === 512),
  ).toBe(true);

  // 生成相只供被选中图的 ordinary 1024x512；其他图不补送，原缓存变体保持不变。
  const lastCall = captures[captures.length - 1] as CapturedCall;
  const lastImages = captureImages(lastCall);
  const exprLast = lastImages.filter((image) => image.mediaId === exprFirst?.mediaId);
  expect(exprLast).toHaveLength(1);
  expect(exprLast[0]?.width).toBe(1024);
  expect(exprLast[0]?.height).toBe(512);
  expect(exprLast[0]?.sha256).toBe(sha(variantBytesOf(h, 1024, 512)));
  expect(exprLast[0]?.sha256).not.toBe(exprFirst?.sha256);
  expect(lastImages.some((image) => image.width === 512 && image.height === 256)).toBe(false);
  const plainLast = lastImages.find((image) => image.mediaId === plainFirst?.mediaId);
  expect(plainLast).toBeUndefined();
  expect(sha(variantBytesOf(h, 800, 400))).toBe(plainFirst?.sha256);

  writeDuTrace("DU_1", { captures, sent: h.sent, variants: variantRows(h) });
  // 只计消息事实正文，不把协议、焦点关联或工具观察中的同一标记算成重复历史。
  const factRows: Array<{
    platformMessageId: string;
    parts: Array<{ kind: string; text?: string; mediaId?: string }>;
  }> = [];
  for (const message of lastCall.messages) {
    for (const part of message.content) {
      if (part.kind !== "text" || !part.text.startsWith("{")) continue;
      const envelope = JSON.parse(part.text) as { kind?: string; facts?: string };
      if (envelope.kind !== "qq_message_facts" || envelope.facts === undefined) continue;
      for (const line of envelope.facts.split("\n")) {
        if (line.startsWith("msg=")) factRows.push(JSON.parse(line.slice(4)));
      }
    }
  }
  const questionRows = factRows.filter((row) => row.platformMessageId === "-2502");
  const originalRows = factRows.filter((row) => row.platformMessageId === "-2501");
  expect(questionRows).toHaveLength(1);
  expect(originalRows).toHaveLength(1);
  expect(questionRows[0]?.parts.filter((part) => part.kind === "text")).toEqual([
    { kind: "text", text: "这个表情包上画的是什么 DU1" },
  ]);
  expect(questionRows[0]?.parts.filter((part) => part.kind === "image")).toHaveLength(1);
  expect(originalRows[0]?.parts.filter((part) => part.kind === "image")).toHaveLength(1);
  // 持久面：asset content sha＝受控源字节（两张都在）；variant 恰三行（无重复副本）；分类零改写。
  expect(new Set(assetShas(h))).toEqual(new Set([sha(exprBytes), sha(plainBytes)]));
  const widths = variantRows(h).map((row) => row.width);
  expect(widths.filter((width) => width === 1024)).toHaveLength(1);
  expect(widths.filter((width) => width === 512)).toHaveLength(1);
  expect(widths.filter((width) => width === 800)).toHaveLength(1);
  expect(classificationCount(h)).toBe(0);

  // source 字节每图恰一次（auto 准备两图），detail 走缓存零新增 fetch。
  expect(fetches.count).toBe(2);
  noBytesOnWire(captures);
  writeDuTrace("DU_1", { captures, sent: h.sent, variants: variantRows(h) });
});

// ---- [DU_2] inline 消费次序 + none 零额外调用 ------------------------------------------------

it("[DU_2] an inline answer is decided only after the same run supplied the consumed ordinary image; none adds no calls", async () => {
  // inline 分支：media.read 消费 ordinary 之后，**下一条决策请求**里已经带着 1024x512 原图，
  // inline 正文才允许发出——理解声明不先于真实消费。none 分支：零额外调用、零 detail 副本。
  const exprBytes = pngOf(120, 1024, 512);
  const fetches = { count: 0 };
  const { port, captures, pendingSteps } = createCapturePort([
    { kind: "decision", build: () => ({ kind: "invoke", name: "media.list", arguments: {} }) },
    {
      kind: "decision",
      build: (seen) => ({
        kind: "invoke",
        name: "media.read",
        arguments: { id: disclosedIdFor(seen, "-2601"), questionMessageId: "-2601" },
      }),
    },
    {
      kind: "decision",
      build: () => ({
        kind: "final",
        outputs: [{ kind: "inline", targetId: "10001", text: "画的是一只猫 DU2", stickerIds: [] }],
      }),
    },
  ]);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "du2-face": exprBytes },
    fetchHook: async () => {
      fetches.count += 1;
    },
    model: port,
  });
  h.receive({
    id: "-2601",
    speaker: "10001",
    text: "这个表情包上画的是什么 DU2",
    groupCard: "阿林",
    image: "du2-face",
    imageHint: { ...MARKET_FACE },
    addressed: true,
  });
  await h.activate("direct_reply");
  await h.deliver();
  expect(h.sent).toHaveLength(1);

  // 发出 inline 正文的那次决策请求已含 ordinary 1024x512（sha＝真实 variant 字节），512x256
  // 不在。消费次序的证明是捕获到的请求内容（wire part 元数据），不是 DB variant 存在性。
  expect(captures[captures.length - 1]?.kind).toBe("decision");
  expect(pendingSteps()).toBe(0);
  const inlineCall = captures[captures.length - 1] as CapturedCall;
  const inlineImages = captureImages(inlineCall);
  const detail = inlineImages.find((image) => image.width === 1024 && image.height === 512);
  expect(detail?.sha256).toBe(sha(variantBytesOf(h, 1024, 512)));
  expect(inlineImages.some((image) => image.width === 512 && image.height === 256)).toBe(false);
  expect(fetches.count).toBe(1);
  expect(classificationCount(h)).toBe(0);
  noBytesOnWire(captures);
  writeDuTrace("DU_2", { captures, sent: h.sent, variants: variantRows(h) });

  // none 分支（独立 run）：决策止于 none，零额外调用、零 detail 副本、零发送。
  const fetchesNone = { count: 0 };
  const nonePort = createCapturePort([
    { kind: "decision", build: () => ({ kind: "invoke", name: "media.list", arguments: {} }) },
    { kind: "decision", build: () => ({ kind: "none" }) },
  ]);
  const hNone = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "du2n-face": exprBytes },
    fetchHook: async () => {
      fetchesNone.count += 1;
    },
    model: nonePort.port,
  });
  hNone.receive({
    id: "-2602",
    speaker: "10001",
    text: "这个表情包上画的是什么 DU2N",
    groupCard: "阿林",
    image: "du2n-face",
    imageHint: { ...MARKET_FACE },
    addressed: true,
  });
  await hNone.activate("direct_reply");
  await hNone.deliver();
  expect(hNone.sent).toHaveLength(0);
  expect(nonePort.captures.every((call) => call.kind === "decision")).toBe(true);
  expect(nonePort.captures.length).toBeGreaterThanOrEqual(2);
  expect(nonePort.pendingSteps()).toBe(0);
  expect(nonePort.captures.some((call) => observationsOf(call, "media.read").length > 0)).toBe(
    false,
  );
  expect(variantRows(hNone).some((row) => row.width === 1024 && row.height === 512)).toBe(false);
  expect(fetchesNone.count).toBe(1);
});

// ---- [DU_3] tool 之后能力真实关闭 → 真实纪元错误，绝不冒充 prepared-ok ------------------------

it("[DU_3] a real capability close after the tool call fails the same run with the real epoch code", async () => {
  // media.read 成功（detail 已真实消费）之后、下一决策返回前，用既有 CAS 路径真实关闭本群
  // media 能力（updateQqGroupConfig → 纪元推进）。后续相的来源复验必须以真实
  // MEDIA_CAPABILITY_EPOCH_CHANGED 失败：零发送、零生成相调用，prepared-ok 不当证明。
  const exprBytes = pngOf(120, 1024, 512);
  const { port, captures, pendingSteps } = createCapturePort([
    { kind: "decision", build: () => ({ kind: "invoke", name: "media.list", arguments: {} }) },
    {
      kind: "decision",
      build: (seen) => ({
        kind: "invoke",
        name: "media.read",
        arguments: { id: disclosedIdFor(seen, "-2601"), questionMessageId: "-2601" },
      }),
    },
    {
      kind: "decision",
      build: () => ({
        kind: "final",
        outputs: [
          { kind: "generate", targetId: "10001", instructions: "回答表情细节", stickerIds: [] },
        ],
      }),
      // 能力关闭发生在 media.read 观察已被消费、detail 副本已落库之后（tool-after 语义）。
      beforeRespond: () => {
        const binding = readQqBinding(h.orm, h.bindingId);
        if (binding === null) throw new Error("BINDING_MISSING");
        const scheme = readQqScheme(h.orm, binding.schemeId);
        if (scheme === null) throw new Error("SCHEME_MISSING");
        const current = readQqGroupAgentConfig(h.orm, binding);
        updateQqGroupConfig(h.orm, {
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
      },
    },
    { kind: "text", text: "不应当被消费" },
  ]);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "du3-face": exprBytes },
    model: port,
  });
  const bindingAtStart = readQqBinding(h.orm, h.bindingId);
  expect(bindingAtStart).not.toBeNull();
  const epochAtStart = readQqGroupCapabilityRevision(
    h.orm,
    bindingAtStart as NonNullable<typeof bindingAtStart>,
    "media",
  );
  h.receive({
    id: "-2601",
    speaker: "10001",
    text: "这个表情包上画的是什么 DU3",
    groupCard: "阿林",
    image: "du3-face",
    imageHint: { ...MARKET_FACE },
    addressed: true,
  });
  const refusal = await runErrorOf(async () => {
    await h.activate("direct_reply");
    await h.deliver();
  });
  // 真实纪元拒绝（不是自造 code、不是静默成功）；生成相从未发生，正文未发。
  expect(refusal).not.toBeNull();
  // 宿主真实抛出形态以 actual error 为准：code 字段或 message 携带同一 codeword，逐字相等；
  // 不自造 AppError、不做泛化 contains 弱化。
  const du3Code = (refusal as { code?: unknown } | null)?.code;
  const du3Message =
    refusal instanceof Error
      ? refusal.message
      : ((refusal as { message?: unknown } | null)?.message ?? "");
  expect(
    du3Code === "MEDIA_CAPABILITY_EPOCH_CHANGED" || du3Message === "MEDIA_CAPABILITY_EPOCH_CHANGED",
  ).toBe(true);
  expect(h.sent).toHaveLength(0);
  expect(captures.some((call) => call.kind === "text")).toBe(false);
  const bindingNow = readQqBinding(h.orm, h.bindingId);
  expect(bindingNow).not.toBeNull();
  expect(
    readQqGroupCapabilityRevision(h.orm, bindingNow as NonNullable<typeof bindingNow>, "media"),
  ).not.toBe(epochAtStart);
  writeDuTrace("DU_3", {
    captures,
    sent: h.sent,
    refusal: refusal === null ? null : String(refusal.code),
    variants: variantRows(h),
  });
  // blocked（已记，不在本文件伪造）：①问题正文 revision 中途真实变更——可用真实当前
  // scope 的 DB 修改原 body rev，但仅限合法 fixture 的 action-pending 窗口、不产 mutant；
  // 待前例建立 caller 接口后补例；②native 相 stage-off 独立场景需另 case/参数，
  // 不在本文件伪称覆盖。
  expect(pendingSteps()).toBeGreaterThan(0);
});

// ---- [DU_4] description 模式：describe detail 出口与 baseline 对照，任务账本独立 ----------------

it("[DU_4] in description mode the question-anchored detail note and the id-only baseline stay separate budgets", async () => {
  // description 模式（本例不断言 stage-off）：media.describe{id, questionMessageId="-2701"}
  // 走 detail 读取，media.note.read{id, 同 questionMessageId} 读出 detail 正文（新 detail
  // 出口）；另一张直连图 id-only baseline describe/note.read 作对照。两任务 purpose/
  // questionKey/attempts 独立不 reset——以真实 qq_media_read_tasks 账本行核对，不 SQL 伪造。
  // vision 答复顺序不预先固定：自动 baseline 通常先于显式 describe 调用；outcomes 以首次
  // 真实运行捕获的 vision 调用日志核对后按需 exact edit 校正，正文断言保持逐字。
  const exprBytes = pngOf(120, 1024, 512);
  const plainBytes = pngOf(90, 640, 320);
  const { port, captures, pendingSteps } = createCapturePort([
    { kind: "decision", build: () => ({ kind: "invoke", name: "media.list", arguments: {} }) },
    {
      kind: "decision",
      build: (seen) => ({
        kind: "invoke",
        name: "media.describe",
        arguments: { id: disclosedIdFor(seen, "-2701"), questionMessageId: "-2701" },
      }),
    },
    {
      kind: "decision",
      build: (seen) => ({
        kind: "invoke",
        name: "media.note.read",
        arguments: { id: disclosedIdFor(seen, "-2701"), questionMessageId: "-2701" },
      }),
    },
    {
      kind: "decision",
      build: (seen) => ({
        kind: "invoke",
        name: "media.describe",
        arguments: { id: disclosedIdFor(seen, "-2702") },
      }),
    },
    {
      kind: "decision",
      build: (seen) => ({
        kind: "invoke",
        name: "media.note.read",
        arguments: { id: disclosedIdFor(seen, "-2702") },
      }),
    },
    {
      kind: "decision",
      build: () => ({
        kind: "final",
        outputs: [{ kind: "inline", targetId: "10001", text: "结合描述回答 DU4", stickerIds: [] }],
      }),
    },
  ]);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["基线描述DU4B", "基线描述DU4B", "细节描述DU4"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "description" },
    imageBytes: { "du4-face": exprBytes, "du4-plain": plainBytes },
    model: port,
  });
  h.receive({
    id: "-2702",
    speaker: "20002",
    text: "另一张直连图 DU4B",
    groupCard: "小周",
    image: "du4-plain",
  });
  h.receive({
    id: "-2701",
    speaker: "10001",
    text: "这个表情包上画的是什么 DU4",
    groupCard: "阿林",
    image: "du4-face",
    imageHint: { ...MARKET_FACE },
    addressed: true,
    replyTo: "-2702",
  });
  await h.activate("direct_reply");
  await h.deliver();
  expect(h.sent).toHaveLength(1);

  // description 模式事实：全程 wire 上无原生 image part（本例不称 stage-off 覆盖）。
  expect(captures.flatMap((call) => captureImages(call))).toEqual([]);

  // detail 出口：describe{q} 后，note.read{id, 同 questionMessageId} 读出 detail 正文。
  const describeDetail = captures.flatMap((call) => observationsOf(call, "media.describe"))[0];
  expect(describeDetail?.value.arguments).toMatchObject({ questionMessageId: "-2701" });
  const describeDetailValue = describeDetail?.value.value as
    | { status?: string; described?: boolean; attempt?: number }
    | undefined;
  expect(describeDetailValue?.status).toBe("described");
  expect(describeDetailValue?.described).toBe(true);
  expect(describeDetailValue?.attempt).toBe(1);
  const noteDetail = captures
    .flatMap((call) => observationsOf(call, "media.note.read"))
    .find(
      (envelope) =>
        (envelope.value.arguments as { questionMessageId?: string }).questionMessageId === "-2701",
    );
  const noteDetailValue = noteDetail?.value.value as { status?: string; text?: string } | undefined;
  expect(noteDetailValue?.status).toBe("ok");
  expect(noteDetailValue?.text).toContain("细节描述DU4");

  // 对照：另一图 id-only baseline describe/note.read，正文真实可读，未带问题指针。
  const describeBaseline = captures
    .flatMap((call) => observationsOf(call, "media.describe"))
    .find(
      (envelope) =>
        (envelope.value.arguments as { questionMessageId?: string }).questionMessageId ===
        undefined,
    );
  expect(describeBaseline).toBeDefined();
  const noteBaseline = captures
    .flatMap((call) => observationsOf(call, "media.note.read"))
    .find(
      (envelope) =>
        (envelope.value.arguments as { questionMessageId?: string }).questionMessageId ===
        undefined,
    );
  const noteBaselineValue = noteBaseline?.value.value as
    | { status?: string; text?: string }
    | undefined;
  expect(noteBaselineValue?.status).toBe("ok");
  expect(noteBaselineValue?.text).toContain("基线描述DU4B");

  // 真实任务账本：purpose/questionKey/attempts 独立不 reset（读真行，不 SQL 伪造）。
  const exprId = disclosedIdFor(captures, "-2701");
  const plainId = disclosedIdFor(captures, "-2702");
  const taskRows = h.db
    .query(
      "SELECT media_note_id, purpose, question_key, attempts, note FROM qq_media_read_tasks ORDER BY purpose",
    )
    .all() as {
    media_note_id: string;
    purpose: string;
    question_key: string | null;
    attempts: number;
    note: string | null;
  }[];
  const detailTask = taskRows.find(
    (row) => row.media_note_id === exprId && row.purpose === "detail",
  );
  expect(detailTask?.question_key).not.toBeNull();
  expect(detailTask?.attempts).toBe(1);
  expect(detailTask?.note).toContain("细节描述DU4");
  const baselineTask = taskRows.find(
    (row) => row.media_note_id === plainId && row.purpose === "baseline",
  );
  expect(baselineTask?.question_key).toBeNull();
  expect(baselineTask?.attempts).toBe(1);
  expect(baselineTask?.note).toContain("基线描述DU4B");
  expect(pendingSteps()).toBe(0);
  expect(classificationCount(h)).toBe(0);
  noBytesOnWire(captures);
  writeDuTrace("DU_4", { captures, sent: h.sent, tasks: taskRows, visionCalls: h.visionCalls });
});

it("[DU_5] changing the real question body after detail preparation refuses the pending answer", async () => {
  const bytes = pngOf(120, 1024, 512);
  const { port, captures } = createCapturePort([
    { kind: "decision", build: () => ({ kind: "invoke", name: "media.list", arguments: {} }) },
    {
      kind: "decision",
      build: (seen) => ({
        kind: "invoke",
        name: "media.read",
        arguments: { id: disclosedIdFor(seen, "-2801"), questionMessageId: "-2801" },
      }),
    },
    {
      kind: "decision",
      build: () => ({
        kind: "final",
        outputs: [
          { kind: "inline", targetId: "10001", text: "不应发送的旧问题回答", stickerIds: [] },
        ],
      }),
      beforeRespond: () => {
        const mediaId = disclosedIdFor(captures, "-2801");
        const row = h.db.query("SELECT event_key FROM qq_media_notes WHERE id=?").get(mediaId) as {
          event_key: string;
        } | null;
        if (!row) throw new Error("question media missing");
        const changed = h.db
          .query("UPDATE qq_observation_text SET body=? WHERE event_key=?")
          .run("问题已更正 DU5", row.event_key);
        expect(changed.changes).toBe(1);
      },
    },
  ]);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "du5-face": bytes },
    model: port,
  });
  h.receive({
    id: "-2801",
    speaker: "10001",
    text: "请看清这张表情的细节 DU5",
    image: "du5-face",
    imageHint: { ...MARKET_FACE },
    addressed: true,
  });
  const refusal = await runErrorOf(async () => {
    await h.activate("direct_reply");
    await h.deliver();
  });
  expect(refusal).not.toBeNull();
  expect((refusal as { code?: string } | null)?.code).toBe("CONTEXT_SOURCE_INVALID");
  expect(h.sent).toHaveLength(0);
  const supplied = captureImages(captures[captures.length - 1] as CapturedCall);
  expect(supplied.some((image) => image.width === 1024 && image.height === 512)).toBe(true);
  writeDuTrace("DU_5", { captures, sent: h.sent, refusal: String(refusal) });
});

it("[DU_6] generation stage off sends no raw image after a successful detail decision", async () => {
  const bytes = pngOf(120, 1024, 512);
  const { port, captures, pendingSteps } = createCapturePort([
    { kind: "decision", build: () => ({ kind: "invoke", name: "media.list", arguments: {} }) },
    {
      kind: "decision",
      build: (seen) => ({
        kind: "invoke",
        name: "media.read",
        arguments: { id: disclosedIdFor(seen, "-2901"), questionMessageId: "-2901" },
      }),
    },
    {
      kind: "decision",
      build: () => ({
        kind: "final",
        outputs: [
          { kind: "generate", targetId: "10001", instructions: "回答已读细节", stickerIds: [] },
        ],
      }),
    },
    { kind: "text", text: "按已读细节回答 DU6" },
  ]);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native", stages: { generation: false } },
    imageBytes: { "du6-face": bytes },
    model: port,
  });
  h.receive({
    id: "-2901",
    speaker: "10001",
    text: "请看清这张表情的细节 DU6",
    image: "du6-face",
    imageHint: { ...MARKET_FACE },
    addressed: true,
  });
  await h.activate("direct_reply");
  await h.deliver();
  const decisions = captures.filter((call) => call.kind === "decision");
  expect(captureImages(decisions[0] as CapturedCall).some((image) => image.width === 512)).toBe(
    true,
  );
  expect(
    captureImages(decisions[decisions.length - 1] as CapturedCall).some(
      (image) => image.width === 1024 && image.height === 512,
    ),
  ).toBe(true);
  const generated = captures.filter((call) => call.kind === "text");
  expect(generated).toHaveLength(1);
  expect(captureImages(generated[0] as CapturedCall)).toEqual([]);
  expect(h.sent).toHaveLength(1);
  expect(pendingSteps()).toBe(0);
  writeDuTrace("DU_6", { captures, sent: h.sent });
});
