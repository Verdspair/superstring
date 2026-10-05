// T15 P4（唯一切片）：spec §9 与矩阵 id 35–40——阶段/能力关闭、unsupported 降级与非 unsupported 故障。
//
// 上位依据：原计划 §T15、原规格 §14.1/§9、`briefs/t15-brief.md`、独立审阅终表 P4 分区。
//   id 35 阶段关闭矩阵；id 36 global/group 关闭后无 bytes/notes/fallback；
//   id 37 off→on 已撤权（含 in-flight 迟到结果）；id 38 native unsupported 降级 description；
//   id 39 401/403/413/429/5xx/timeout/schema/tools 400 一律不降级；
//   id 40 备用无模型/无容量只走 unknown 文字。
//
// 三条硬纪律（父任务要求，逐条对应下面的实现）：
//   1. 强负必须真实可失败。MODEL_IMAGE_UNSUPPORTED 与全部非 unsupported 码都由**真实
//      LM Studio 网关**（createLmStudioClient）经 `createModelPort` 装进 harness 产出：桩只回
//      HTTP 状态与 provider 原话，能力句式分类（imageRequestLifetime）、错误码映射
//      （mapModelError）、降级判定（bot-host 的 isModelImageUnsupportedError）全部是产品代码。
//      本文件不构造带 code 的 error，也不 `as` 收窄任何错误类型。
//   2. 整链。模型只经 harness 的 `createOneBotHarness`（不建第二 harness/第二模型链）；HTTP 桩是
//      本机 port 0 合成服务，finally 关闭；不触 17861、不读真实 data/密钥、不接真实模型。
//   3. 不 import artifacts/。矩阵结果由协调者汇总；本文件只跑行为、只输出自己的断言证据。
//
// 观测面：requestedMode/actualMode/why/code/omission 一律读**真实 run span**
// （宿主 emitMediaMode → harness onDiagnostic → 测试内存），不新增 HTTP、不改生产字段。

import { afterEach, describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { eq } from "drizzle-orm";
import { createModelPort, type ModelPort } from "../../src/server/agent/model-port";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import {
  readQqGroupAgentConfig,
  readQqGroupCapabilityRevision,
  updateQqGroupConfig,
} from "../../src/server/db/qq-group-config-repository";
import { readQqScheme } from "../../src/server/db/qq-scheme-repository";
import * as schema from "../../src/server/db/schema";
import {
  createLmStudioClient,
  type ExternalModelRoute,
  type ModelGateway,
} from "../../src/server/llm/model-gateway";
import { createLmStudioVisionClient } from "../../src/server/llm/vision-client";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";

afterEach(() => {
  closeHarnesses();
});

// ---- 本文件内的小工具（不构成第二 harness） ------------------------------------------------

const png = (fill = 64) => encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(fill), 8, 8);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** 媒体字节指纹：资产行必须与本轮注入的受控字节同源（不得脱钩的随意 sha）。 */
const IMAGE_BYTES = png(64);
const IMAGE_SHA = sha(IMAGE_BYTES);
const IMAGE_REF = "p4-image-1";

/** 资产/变体/分类三张登记表的真实行数（关闭与降级的强负面）。 */
function registered(h: OneBotHarness) {
  const one = (table: string): number =>
    (h.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    assets: one("qq_media_assets"),
    variants: one("qq_media_variants"),
    classifications: one("qq_media_classifications"),
    /** 资产行的 content_sha256 必须与注入字节同源。 */
    assetSha: (
      h.db.query("SELECT content_sha256 FROM qq_media_assets").all() as {
        content_sha256: string;
      }[]
    ).map((row) => row.content_sha256),
  };
}

/** 本群 media 能力：真实 updateQqGroupConfig 的 CAS 写（revision 逐次推进，旧纪元永久失效）。 */
function setGroupMedia(h: OneBotHarness, disabled: boolean): number {
  const binding = readQqBinding(h.orm, h.bindingId);
  if (!binding) throw new Error("binding missing");
  const scheme = readQqScheme(h.orm, binding.schemeId);
  if (!scheme) throw new Error("scheme missing");
  const current = readQqGroupAgentConfig(h.orm, binding);
  updateQqGroupConfig(h.orm, {
    bindingId: binding.id,
    payload: {
      agent_id: binding.agentId,
      expected_binding_revision: binding.revision,
      expected_scheme_revision: scheme.revision,
      expected_revision: current.revision,
      overrides: {},
      disabled_capabilities: disabled ? ["media"] : [],
    },
  });
  return readQqGroupCapabilityRevision(h.orm, binding, "media");
}

// ---- 真实网关 + 本机合成 HTTP 桩 -------------------------------------------------------------

/** provider 侧的一次答复。桩只回 HTTP，不判语义。 */
type ProviderAnswer =
  | {
      readonly kind: "http";
      readonly status: number;
      readonly message: string;
      /**
       * 只对**带 image_url 的请求**回这个错误。规格 §9：网关只给真实带图的请求挂图片分类
       * 回调，纯文字请求的 4xx 不进该分类（否则会把普通 400 误当成能力拒绝）。
       */
      readonly onlyWithImage?: boolean;
      /**
       * 只对**对话模型**（回复/判断）回这个错误：§9 降级后的 description 读取走视觉模型，
       * 那条路必须成功，否则断的是另一件事。不设＝所有 chat/completions 都回。
       */
      readonly textModelOnly?: boolean;
      /**
       * 只对**该相实际声明了输出协议/schema 的请求**回这个错误（评分相＝声明顶层是
       * scoreResult/score）。同一 judge 模型的决策相请求不受影响：故障按相命中，
       * 不按 model、不按序数。
       */
      readonly faultPhase?: "evaluation";
    }
  /** 流式正文（生成相的非信封路径）。 */
  | { readonly kind: "sse"; readonly text: string }
  /** 不写响应（模拟挂住；由调用方自己的超时/取消收场）。 */
  | { readonly kind: "hang"; readonly onlyWithImage?: boolean }
  /**
   * 容量探测两个**真实**来源（与对话请求隔离，隔离本块变量）：
   *  - `capacity_null`：探测 200 但目录里**没有该模型** -> 网关返回 `null`；
   *  - `capacity_probe_500`：探测 HTTP 500 -> 网关抛容量不可用。
   * 两者都只作用于容量面（`/models`、`/api/v1/models`），对话请求照常答复。
   */
  | { readonly kind: "capacity_null" }
  | { readonly kind: "capacity_probe_500" };

interface WireRequest {
  readonly model: string;
  readonly stream: boolean;
  /** 真实 wire 上是否带 image_url（读 HTTP body，不是脚本自述）。 */
  readonly carriesImage: boolean;
  readonly roles: readonly string[];
  readonly tools: readonly string[];
  readonly schema: boolean;
  /** 投给 provider 的图片 data URL 数（真实 body 内计数）。 */
  readonly dataUrls: number;
  /** 这次请求里用户原话是否逐字到达（文本窗口没被省的面）。 */
  readonly carriesUtterance: (needle: string) => boolean;
  /**
   * 这次请求的**声明协议相位**（读真实 body，不是脚本自述）：evaluation/decision/generation
   * 按声明面判，vision 按视觉模型名判；不读用户正文猜。
   */
  readonly phase: "decision" | "evaluation" | "generation" | "vision";
}

interface ProviderStub {
  readonly origin: string;
  readonly wire: WireRequest[];
  /** 切换后续请求的答复。 */
  set(answer: ProviderAnswer): void;
  /**
   * 把「本轮第一次决策」的对齐标记清零：多轮场景里每轮都要先走 generate 才会进生成相，
   * 否则第二轮拿到 inline 就没有带图的调用，故障注入落在不到图的那一次上。
   */
  resetDecisionRun(): void;
  close(): Promise<void>;
}

/**
 * 决策相答复。**形状由本次请求的真实 response schema 决定**（不是脚本猜关键词）：
 * 宿主只在「本相存在待分类 unknown 图」时把 schema 换成信封版（§10），否则是冻结的
 * AGENT_DECISION_JSON_SCHEMA；`media` 是信封分支的附属键，plain 形状没有它。
 * `stickerIds: []` 是 required（prepareOutput 的选择守卫读它，缺则 STICKER_SELECTION_REQUIRED）。
 */
/**
 * 决策相的答复体。用 **inline**（模型自己写正文）而不是 generate：generate 会再触发一次
 * 生成调用，而复核/重算没有新观察时模型会重复要求生成，最终撞上 AGENT_STEP_LIMIT——
 * 那是脚本自身在绕圈，不是被测行为。inline 是一轮里真实存在的「看完就回」形态。
 */
const inlineBody = {
  kind: "final" as const,
  outputs: [
    {
      kind: "inline" as const,
      targetId: "20002",
      text: "这是一张合成的灰蓝色方块图。",
      stickerIds: [],
    },
  ],
};

const generateBody = {
  kind: "final" as const,
  outputs: [
    { kind: "generate" as const, targetId: "20002", instructions: "描述这张图", stickerIds: [] },
  ],
};

/**
 * 决策相答复。`first=false` 时答 none：一次 generate 之后不再要求第二次独立生成
 * （真实一轮就是这样收口的），否则脚本会把自己绕进 AGENT_STEP_LIMIT。
 * `stickerIds: []` 是 required（prepareOutput 的选择守卫读它，缺则 STICKER_SELECTION_REQUIRED）。
 */
/**
 * 决策相答复。`draft` 选 generate 还是 inline：generate 才走生成相（本文件要断的正是
 * 那一相的图），inline 直接把正文写进决策、不产生生成调用。
 * `repeat=false` 时答 none：一次 generate 之后没有新观察就不该再要求第二次独立生成，
 * 否则脚本自己绕进 AGENT_STEP_LIMIT（那是脚本在绕，不是被测行为）。
 */
/**
 * 决策相答复。第一次要 `generate`（本文件断的就是生成相那张图）；之后的复核/重算一律
 * `inline`——把正文直接写进决策，不产生第二次生成调用。这是「模型看完就回」的真实形态：
 * 没有新观察时反复要求独立生成只会撞上 generate 预算（AGENT_STEP_LIMIT / no_output），
 * 那是脚本在绕圈，不是被测行为。
 */
const decisionReply = (envelope: boolean, first: boolean) => {
  const body = first ? generateBody : inlineBody;
  return JSON.stringify(envelope ? { decision: body, media: [] } : body);
};

/**
 * 本机 port 0 合成 provider（只服务本文件）。它按**真实请求形状**回答复：
 * 决策相（有决策协议提示词）给决策信封，评分相给 scoreResult，生成相给 text 信封。
 * 能力句式、错误码与降级判定全部留给真实网关与真实宿主。
 */
async function startProvider(options: { initial: ProviderAnswer }): Promise<ProviderStub> {
  let answer = options.initial;
  let decisions = 0;
  const wire: WireRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      if (!(req.url ?? "").includes("/chat/completions")) {
        // 容量探测面。两种情形：空目录（外部路由不看它）／显式不可读（容量未知 -> 明确拒绝）。
        if (answer.kind === "capacity_probe_500") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "catalog unavailable" } }));
          return;
        }
        // 默认：空目录。`capacity_null` 用的也是空目录——`capacityFromCatalog` 对
        // 「目录里没有该模型」返回 null，夹具**原样透传**，不拿默认容量顶替。
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [], models: [] }));
        return;
      }
      const messages = (body.messages as { role: string; content: unknown }[]) ?? [];
      let dataUrls = 0;
      for (const message of messages)
        if (Array.isArray(message.content))
          for (const part of message.content)
            if (
              (part as { type?: unknown }).type === "image_url" &&
              typeof (part as { image_url?: { url?: unknown } }).image_url?.url === "string" &&
              (part as { image_url: { url: string } }).image_url.url.startsWith("data:image/")
            )
              dataUrls += 1;
      // 只对**决策相**计数：评分/生成相的调用不是决策。计数用来让本轮第一次决策答
      // generate（走生成相），之后的复核答 inline——否则没有新观察时会反复要求独立生成。
      const isDecisionCall = JSON.stringify(body.messages ?? []).includes(
        "Return exactly one JSON decision",
      );
      /** 成功答复体。决策相只在**成功轮**推进计数：失败请求的 native 重试不得把
       * 「首轮 generate、其后 inline」的节拍提前翻成 inline（同相恰一次降级靠它保住）。 */
      const successReply = (): string => {
        const text = providerAnswer(body, isDecisionCall ? decisions + 1 : decisions);
        if (isDecisionCall) decisions += 1;
        return text;
      };
      wire.push({
        model: String(body.model ?? ""),
        stream: body.stream === true,
        carriesImage: dataUrls > 0,
        roles: messages.map((message) => message.role),
        tools:
          (body.tools as { function?: { name?: unknown } }[] | undefined)?.map((tool) =>
            String(tool.function?.name ?? ""),
          ) ?? [],
        schema: body.response_format !== undefined,
        dataUrls,
        phase: requestPhase(body, String(body.model ?? "")),
        carriesUtterance: (needle) => JSON.stringify(body.messages ?? []).includes(needle),
      });
      if (answer.kind === "hang") {
        // 纯文字请求照常答复（决策相不该被挂住），只有带图的那次真的挂住。
        if (answer.onlyWithImage !== true || dataUrls > 0) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { content: successReply() },
              },
            ],
          }),
        );
        return;
      }
      const askedModel = String(body.model ?? "");
      if (answer.kind === "http" && answer.textModelOnly === true && askedModel === VISION_MODEL) {
        // 视觉读取：按成功答复（description 备用要真的拿到文字，否则降级读不出东西）。
        // 注意只豁免**视觉**模型：对话侧可能是 reply-model 也可能是 judge-model
        // （自主接话路径的决策/评分都用判断模型），两者都要吃到故障。
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "一张合成的灰蓝色方块图" } }],
          }),
        );
        return;
      }
      if (answer.kind === "http" && answer.onlyWithImage === true && dataUrls === 0) {
        // 本轮请求不带图：按成功答复，让产品自己走到带图的那一次调用。
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: successReply(),
                },
              },
            ],
          }),
        );
        return;
      }
      if (answer.kind === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: answer.text } }] })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      // 容量类答复只作用于容量探测面；对话请求按成功答复（否则断的是另一件事）。
      // `hang` 已在上面专门处理（不带图照常答复、带图真挂住），到这里不可能再是 hang。
      const chatAnswer: ProviderAnswer =
        answer.kind === "capacity_null" || answer.kind === "capacity_probe_500"
          ? { kind: "http", status: 200, message: "" }
          : answer;
      // faultPhase：错误只打在该相**实际声明了输出协议/schema** 的请求上；同一模型其它相
      // （如同一 judge 的决策相）照常成功——故障按相命中，不按 model、不按序数。
      const declaredProps = declaredOutputProps(body);
      const faultHitsPhase =
        chatAnswer.status >= 400 &&
        chatAnswer.faultPhase === "evaluation" &&
        !(declaredProps.includes("scoreResult") || declaredProps.includes("score"));
      if (faultHitsPhase) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: successReply() } }],
          }),
        );
        return;
      }
      res.writeHead(chatAnswer.status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          chatAnswer.status >= 400
            ? { error: { message: chatAnswer.message } }
            : {
                choices: [
                  {
                    finish_reason: "stop",
                    message: { content: successReply() },
                  },
                ],
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${String(port)}/v1`,
    wire,
    set: (next) => {
      answer = next;
    },
    resetDecisionRun: () => {
      decisions = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * 本次请求**实际声明的输出 schema 顶层属性**：strict responseSchema 优先；wire 上只有
 * json_object 没有 schema 时，才解析 system 消息里受信任的 outputSchema JSON 声明
 * （context-engine 与请求同源渲染的那一块），绝不扫用户正文猜关键词。
 */
function declaredOutputProps(body: Record<string, unknown>): string[] {
  const responseFormat = body.response_format as
    | { type?: string; json_schema?: { schema?: Record<string, unknown> } }
    | undefined;
  let schema: Record<string, unknown> | undefined =
    responseFormat?.type === "json_schema"
      ? (responseFormat.json_schema?.schema as Record<string, unknown> | undefined)
      : undefined;
  if (schema === undefined) {
    // wire 上是 json_object（严格模式不收 oneOf 时网关的降级）：只从 system 受信任文本里
    // 与请求同源渲染的 outputSchema JSON 声明取值，不读用户正文。
    const messages = (body.messages as { role?: string; content?: unknown }[]) ?? [];
    for (const message of messages) {
      if (message.role !== "system") continue;
      const content = message.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((part) =>
                  typeof part === "object" && part !== null && "text" in part
                    ? String((part as { text: unknown }).text)
                    : "",
                )
                .join("\n\n")
            : "";
      for (const segment of text.split("\n\n")) {
        const trimmed = segment.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(trimmed) as { outputSchema?: Record<string, unknown> };
          if (parsed.outputSchema !== undefined) {
            schema = parsed.outputSchema;
            break;
          }
        } catch {
          // 提示词文本段，不是 JSON 声明，跳过
        }
      }
      if (schema !== undefined) break;
    }
  }
  if (schema === undefined) return [];
  const props = Object.keys((schema.properties as Record<string, unknown>) ?? {});
  // 决策 plain/envelope 版顶层是 oneOf：envelope 的每个分支都带附属 media 键（plain 没有）。
  const branches = (schema.oneOf ?? []) as { properties?: Record<string, unknown> }[];
  for (const branch of branches)
    for (const key of Object.keys(branch.properties ?? {}))
      if (!props.includes(key)) props.push(key);
  return props;
}

/**
 * 这次请求的**声明协议相位**：只看受信任声明面（responseSchema／system 协议文本）与模型名
 * ——evaluation＝声明顶层是 scoreResult/score，generation＝声明顶层有 text，decision＝声明
 * 顶层（含 oneOf 分支）是 decision/media 或带决策协议标记，vision＝视觉模型。绝不读用户正文猜。
 */
function requestPhase(body: Record<string, unknown>, model: string): WireRequest["phase"] {
  if (model === VISION_MODEL) return "vision";
  const props = declaredOutputProps(body);
  if (props.includes("scoreResult") || props.includes("score")) return "evaluation";
  if (props.includes("text")) return "generation";
  if (
    props.includes("decision") ||
    props.includes("media") ||
    JSON.stringify(body.messages ?? []).includes("Return exactly one JSON decision")
  )
    return "decision";
  return "generation";
}

/**
 * 一次成功请求的答复：按**本次请求实际声明的输出 schema** 选形状。信封与否由声明决定，
 * 不由 wire 上有没有图决定——同相纯文字重试的 responseSchema 保持原 envelope，答复必须与
 * 声明同源，否则宿主按 envelope 严格解析直接失败。
 */
function providerAnswer(body: Record<string, unknown>, decisions: number): string {
  const props = declaredOutputProps(body);
  if (props.includes("scoreResult"))
    return JSON.stringify({ scoreResult: { score: 6 }, media: [] });
  if (props.includes("text")) return JSON.stringify({ text: "一张合成的灰蓝色方块图", media: [] });
  // 决策相：信封版 schema 顶层是 decision/media；plain 版是冻结的 AGENT_DECISION_JSON_SCHEMA。
  // 相位判据用 system 协议文本（受信任面），信封与否只看声明的 schema。
  if (
    props.includes("decision") ||
    props.includes("media") ||
    JSON.stringify(body.messages ?? []).includes("Return exactly one JSON decision")
  )
    return decisionReply(
      props.includes("decision") || props.includes("media"),
      decisions % 2 === 1,
    );
  return JSON.stringify({ score: 6 });
}

/**
 * 真实 LM Studio 网关装成 ModelPort。`vision` 是能力声明三态（false＝发前识别为
 * MODEL_IMAGE_UNSUPPORTED）；`providerRevision` 是负缓存指纹修订号。
 */
function realPort(
  stub: ProviderStub,
  options: { vision?: boolean; providerRevision?: number } = {},
): ModelPort & {
  readonly capacityOf: Pick<ModelGateway, "loadedContextCapacity">;
  /** 容量 getter 的真实调用记录（模型名序列）；容量块据此断言「确实走到真实探测面」。 */
  readonly capacityProbeCalls: readonly string[];
} {
  const route: ExternalModelRoute = {
    baseUrl: stub.origin,
    apiKey: "synthetic-p4-key",
    contextWindow: 65536,
    vision: options.vision ?? true,
    toolCalling: false,
    providerRevision: options.providerRevision ?? 1,
  };
  const config = {
    baseUrl: stub.origin,
    model: "reply-model",
    timeoutSeconds: 5,
    apiKey: "synthetic-p4-key",
  };
  /** 本次 realPort 实例上容量 getter 被调用的模型名序列（容量块的强前置）。 */
  const capacityProbeCalls: string[] = [];
  //
  // 容量面走**同一个真实网关实例**（同一个 `createLmStudioClient`、同一 baseUrl/origin、
  // 同一 externalModel 闭包），不是常量、不是 noop、也不另开模型路径。
  //
  // 为什么这个实例**不挂** `reply-model` 的外部路由：`loadedContextCapacity` 对外部路由会
  // 直接返回声明的 `contextWindow`、**根本不探测**（`model-gateway.ts` 「A declared external
  // model carries the window the user typed」）。挂上会让「目录里没有该模型 -> null」与
  // 「探测 500」两条永远走不到，测的就不是拒绝语义。而文本侧需要外部路由是有既有原因的
  // （原生 tools 只发外部路由），所以**文本与容量用两个 client、但同 origin、同 config、同
  // provider 桩**——容量那条是本地路由的真实探测路径，文本那条保留外部路由行为。
  const capacityOf: Pick<ModelGateway, "loadedContextCapacity"> = {
    loadedContextCapacity: (model: string, options?: { signal?: AbortSignal }) => {
      // 调用计数：让「getter 真的被调到过」成为可断言事实，而不是靠「拒绝码对了」反推。
      capacityProbeCalls.push(model);
      return createLmStudioClient(config).loadedContextCapacity(model, options);
    },
  };
  // `createModelPort` **不会**把 factory options 里多余的键展到返回的 port 上，所以
  // `capacityOf` 必须显式挂在返回值上（否则 `realPort(stub).capacityOf` 运行时是 undefined，
  // 夹具会静默回落到常量容量 —— 那正是我第一版踩的坑）。
  return {
    ...createModelPort({
      gateway: createLmStudioClient(config, {
        externalModel: (model) => (model === "reply-model" ? route : null),
      }),
      // 描述回退要真发一次视觉读取：同一个本机合成 provider 承担（§9 的 description 备用
      // 正是「让视觉模型描述这张图」）。不给 vision 时 createModelPort 不带 completeMultimodal，
      // 产品会按「无可用视觉模型」处理——那是 S40 的语义，不是 S38 的。
      vision: createLmStudioVisionClient(config, undefined, {
        externalModel: (model) =>
          model === "vision-stub" ? { baseUrl: stub.origin, apiKey: null } : null,
      }),
    }),
    capacityOf,
    capacityProbeCalls,
  };
}

// ---- 真实 run span 读回（宿主 emitMediaMode → onDiagnostic） ---------------------------------

interface MediaMode {
  readonly phase: string;
  readonly requestedMode: string;
  readonly actualMode: string;
  readonly why: string | null;
  readonly code: string | null;
  readonly imageCount: number;
  readonly omissionCount: number;
  readonly requestedModel: string;
  readonly resolvedModel: string | null;
  readonly omissions: readonly { mediaId: string; reason: string }[];
}

function mediaModes(diagnostics: readonly Diagnostic[]): MediaMode[] {
  const out: MediaMode[] = [];
  for (const event of diagnostics) {
    if (event.stage !== "media_mode") continue;
    const details = event.details;
    if (details === undefined) continue;
    const omissions: { mediaId: string; reason: string }[] = [];
    for (const [key, value] of Object.entries(details))
      if (key.startsWith("omission:") && typeof value === "string")
        omissions.push(JSON.parse(value) as { mediaId: string; reason: string });
    out.push({
      phase: String(details.phase ?? ""),
      requestedMode: String(details.requestedMode ?? ""),
      actualMode: String(details.actualMode ?? ""),
      why: details.why === undefined || details.why === null ? null : String(details.why),
      code: event.code === undefined ? null : String(event.code),
      imageCount: Number(details.imageCount ?? 0),
      omissionCount: Number(details.omissionCount ?? 0),
      requestedModel: String(details.requestedModel ?? ""),
      resolvedModel:
        details.resolvedModel === undefined || details.resolvedModel === null
          ? null
          : String(details.resolvedModel),
      omissions,
    });
  }
  return out;
}

const lastModeFor = (modes: readonly MediaMode[], phase: string): MediaMode | undefined =>
  [...modes].reverse().find((mode) => mode.phase === phase);

/** 宿主诊断事件的最小形状（与 OneBotHost 的 BotHostDiagnostic 同字段）。 */
interface Diagnostic {
  readonly stage: string;
  readonly status: string;
  readonly code?: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

/**
 * 建一个走真实网关的 harness。`diagnostics` 由调用方持有，宿主每次 emit 真实追加。
 * 这里只做装配，不新增任何产品语义。
 */
function createFaultHarness(input: {
  readonly stub: ProviderStub;
  readonly diagnostics: Diagnostic[];
  readonly stages?: { decision?: boolean; evaluation?: boolean; generation?: boolean };
  readonly mode?: "native" | "description";
  /** 视觉桩的答复（按序取，用完重复最后一项）；给＝媒体工具接线。 */
  readonly visionAnswers?: readonly string[];
  /** false＝媒体组件根本不注入（global 关）。 */
  readonly mediaEnabled?: boolean;
  /** provider 能力声明三态（false＝发前识别为 MODEL_IMAGE_UNSUPPORTED）。 */
  readonly visionDeclared?: boolean;
  readonly providerRevision?: number;
  readonly triggers?: {
    direct_reply?: boolean;
    follow_up?: boolean;
    chiming_in?: boolean;
    idle_topic?: boolean;
  };
  /** 直接透传 createOneBotHarness 的可选接线（fetch 门/判断模型/主动门槛/容量/观测落库）。 */
  readonly fetchHook?: (sourceRef: string) => Promise<void>;
  readonly judgementModelName?: string | null;
  readonly initiativeMinScore?: number;
  readonly capacityGateway?: Pick<ModelGateway, "loadedContextCapacity">;
  readonly telemetry?: boolean;
}) {
  return createOneBotHarness({
    conversationModel: "reply-model",
    model: realPort(input.stub, {
      ...(input.visionDeclared === undefined ? {} : { vision: input.visionDeclared }),
      ...(input.providerRevision === undefined ? {} : { providerRevision: input.providerRevision }),
    }),
    mediaInput: {
      mode: input.mode ?? "native",
      ...(input.stages === undefined ? {} : { stages: input.stages }),
    },
    imageBytes: { [IMAGE_REF]: IMAGE_BYTES },
    // 媒体能力放行与视觉模型登记：夹具用 `vision` 开关打开（与生产 mediaEnabled 同侧）。
    // 不给 `vision` 时媒体组件根本不注入，测的就不是关闭语义而是「没接线」。
    ...(input.visionAnswers === undefined
      ? { vision: ["一张合成的灰蓝色方块图"] }
      : input.visionAnswers.length === 0
        ? // 空数组＝「媒体能力开着、但没有可用视觉模型」：不登记 vision-stub，
          // 组织设置保持真实 null（不伪造一个模型名）。
          { mediaEnabled: true }
        : { vision: input.visionAnswers }),
    ...(input.mediaEnabled === undefined ? {} : { mediaEnabled: input.mediaEnabled }),
    onDiagnostic: (event) => {
      input.diagnostics.push({
        stage: event.stage,
        status: event.status,
        ...(event.code === undefined ? {} : { code: event.code }),
        ...(event.details === undefined ? {} : { details: event.details }),
      });
    },
    ...(input.triggers === undefined ? {} : { triggers: input.triggers }),
    ...(input.fetchHook === undefined ? {} : { fetchHook: input.fetchHook }),
    ...(input.judgementModelName === undefined
      ? {}
      : { judgementModelName: input.judgementModelName }),
    ...(input.initiativeMinScore === undefined
      ? {}
      : { initiativeMinScore: input.initiativeMinScore }),
    ...(input.capacityGateway === undefined ? {} : { capacityGateway: input.capacityGateway }),
    ...(input.telemetry === undefined ? {} : { telemetry: input.telemetry }),
  });
}

/**
 * 自主接话（initiative）场景下真正进入**评分相**的一轮。
 *
 * 评分相只在 initiative 许可路径发生——`direct_reply` 按规格不要求许可评分，
 * 所以评分相的 fallback 不能靠直��回应路径伪造。这里用 `chiming_in`：未 @ 助手 的群消息
 * ＋ 时钟推进过新鲜度窗口 ⇒ 宿主排的是 initiative 唤醒；决策答 generate 之后
 * `prepareOutput` 会去取评分许可 ⇒ 真实评分相（judge-model）。
 */
const INITIATIVE_WAIT_SECONDS = 31;

// ---- id 35：阶段关闭矩阵 -----------------------------------------------------------------------

describe("T15 P4 · id 35 阶段关闭矩阵（每相独立，关闭只关本相自动图）", () => {
  it("[S35_1] 关决策相：决策零图而生成/评分照常带图，actualMode 逐相为 disabled/native", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    // 决策相关闭、生成相开着：本块断「关一个相不影响别的相」。
    const h = createFaultHarness({ stub, diagnostics, stages: { decision: false } });
    try {
      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      await h.activate("direct_reply");
      expect(h.db.query("SELECT status FROM agent_runs").all()).toEqual([{ status: "completed" }]);

      const modes = mediaModes(diagnostics);
      const decision = lastModeFor(modes, "decision");
      const generation = lastModeFor(modes, "generation");
      // 关闭相：requestedMode 仍是方案声明的 native（不是"没配图"），actualMode=disabled。
      expect(decision?.requestedMode).toBe("native");
      expect(decision?.actualMode).toBe("disabled");
      expect(decision?.imageCount).toBe(0);
      // 强负：关闭相零原生 part；未关闭相真发图（真实 wire 上带 image_url）。
      expect(generation?.actualMode).toBe("native");
      expect(generation?.imageCount).toBe(1);
      expect(stub.wire.filter((request) => request.carriesImage).length).toBeGreaterThan(0);
      // 登记面：图确实按受控字节落了一次资产（content_sha256 与注入字节同源）。
      const reg = registered(h);
      expect(reg.assets).toBe(1);
      expect(reg.assetSha).toEqual([IMAGE_SHA]);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("[S35_3] 默认三相全开：决策相字节经 resolver 解析后真带图上 wire", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    // **不改任何阶段开关**：QQ_MEDIA_INPUT_SCHEME_DEFAULT 三相全开是已批准默认路径。
    const h = createFaultHarness({ stub, diagnostics });
    try {
      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      // 默认三相全开。决策相曾在 bindRun（首次 read 之前）登记 resolver，那时尚未投影，
      // 于是发请求处 fail closed（CONTEXT_SOURCE_INVALID）。宿主已改为在
      // prepareWithResolved 拿到实际 used/final prepared 结果后再 registerProjection
      // 当前相内容与 resolver，source guard 仍在每次 send 前复验——所以这一轮必须自己走通。
      await h.activate("direct_reply");
      expect(h.db.query("SELECT status FROM agent_runs").all()).toEqual([{ status: "completed" }]);

      const modes = mediaModes(diagnostics);
      expect(lastModeFor(modes, "decision")?.actualMode).toBe("native");
      expect(lastModeFor(modes, "decision")?.imageCount).toBe(1);
      expect(lastModeFor(modes, "generation")?.actualMode).toBe("native");
      expect(lastModeFor(modes, "generation")?.imageCount).toBe(1);
      // 强负（核心）：决策相那一发**真的**带 image_url 上 wire——不是「投影备好了但没发出去」。
      expect(stub.wire.some((request) => request.carriesImage)).toBe(true);
      // 强负：base64 不出现在任何 role/文本面（字节只在图片 part 内解析）。
      for (const request of stub.wire)
        for (const role of request.roles) expect(role).not.toContain("base64");
      const reg = registered(h);
      expect(reg.assets).toBe(1);
      expect(reg.assetSha).toEqual([IMAGE_SHA]);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("[S35_2] 只关生成相：决策保持默认开启且照常带图，关闭只关本相", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    // **只关生成相**。决策相保持方案默认（开启）——本块要断的是「关一个相不影响别的相」，
    // 把它一起关掉就不再是独立负了。
    const h = createFaultHarness({ stub, diagnostics, stages: { generation: false } });
    try {
      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      await h.activate("direct_reply");

      const modes = mediaModes(diagnostics);
      // 决策相按默认开启走完准备（本块要断的正是它没被关掉）：真带图上 wire。
      expect(lastModeFor(modes, "decision")?.actualMode).toBe("native");
      expect(lastModeFor(modes, "decision")?.imageCount).toBe(1);
      expect(stub.wire.some((request) => request.carriesImage)).toBe(true);
      // 关闭的是生成相：它的投影全零（本块变量），requestedMode 仍是方案声明的 native。
      const generation = lastModeFor(modes, "generation");
      expect(generation?.requestedMode).toBe("native");
      expect(generation?.actualMode).toBe("disabled");
      expect(generation?.imageCount).toBe(0);
      // 强负：带图请求只出现在**决策相**（复核/重算那几次决策也带图，属同一相）；
      // 生成相关闭后**一次都没有**带图请求。判据取事实而不是我预设的次数。
      const imageCalls = stub.wire.filter((request) => request.carriesImage);
      expect(imageCalls.length).toBeGreaterThan(0);
      // 生成相关闭 ⇒ 投影 imageCount=0 已断；这里再断 wire：带图请求数不超过决策相调用数。
      const decisionCalls = stub.wire.filter((request) => !request.stream).length;
      expect(imageCalls.length).toBeLessThanOrEqual(decisionCalls);
      // 关闭的是画面不是这轮发言：出站意图照常产生。
      const intents = h.db.query("SELECT COUNT(*) AS n FROM outbound_intents").get() as {
        n: number;
      };
      expect(intents.n).toBe(1);
    } finally {
      await stub.close();
    }
  }, 60_000);
});

// ---- id 36：本群/global 媒体能力关闭 -----------------------------------------------------------

describe("T15 P4 · id 36 关闭后无 bytes / notes / fallback / 登记", () => {
  it("[S36_1] 本群关 media：决策纪元推进、真实服务在链但全零——零 fetch/解码/视觉/登记", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    const h = createFaultHarness({ stub, diagnostics, stages: { decision: false } });
    try {
      // 基线：能力开着时这一轮真的登记资产（证明后面「零」不是因为本来就没准备）。
      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      await h.activate("direct_reply");
      const before = registered(h);
      expect(before.assets).toBe(1);
      expect(before.assetSha).toEqual([IMAGE_SHA]);
      expect(stub.wire.some((request) => request.carriesImage)).toBe(true);

      // 关本群 media（真实 updateQqGroupConfig 的 CAS 写，纪元 0→1）。
      const epoch = setGroupMedia(h, true);
      expect(epoch).toBe(1);

      // 第二条消息：媒体行照常进线，但能力已关 → 不 fetch、不解码、不调视觉、不登记。
      h.receive({ id: "2", speaker: "20002", addressed: true, text: "再看这张", image: IMAGE_REF });
      await h.activate("direct_reply");

      // 强负一：登记面**没有增长**（不是「组件没注入所以空」——组件在链，是能力闸拒了）。
      const after = registered(h);
      expect(after.assets).toBe(before.assets);
      expect(after.variants).toBe(before.variants);
      expect(after.assetSha).toEqual(before.assetSha);
      // 强负二：视觉模型一次都没被叫（真桩计数，不是脚本自述）。
      expect(h.visionCalls).toHaveLength(0);
      // 强负三：关闭后新增的请求不再带图。
      const mark = stub.wire.length;
      void mark;
      expect(stub.wire.slice(2).some((request) => request.carriesImage)).toBe(false);
      // 关闭不省文本窗口：这一轮照常发言。
      const intents = h.db.query("SELECT COUNT(*) AS n FROM outbound_intents").get() as {
        n: number;
      };
      expect(intents.n).toBeGreaterThan(0);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("[S36_2] 关后再开：纪元推进到 2，旧纪元的图不复活，下一张新图才重新准备", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    const h = createFaultHarness({ stub, diagnostics, stages: { decision: false } });
    try {
      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      await h.activate("direct_reply");
      const opened = registered(h);
      expect(opened.assets).toBe(1);

      expect(setGroupMedia(h, true)).toBe(1);
      const offMark = stub.wire.length;
      h.receive({
        id: "2",
        speaker: "20002",
        addressed: true,
        text: "关着的时候发的",
        image: IMAGE_REF,
      });
      await h.activate("direct_reply");
      expect(registered(h).assets).toBe(opened.assets);
      // 关闭期间：零 wire 带图（能力闸在 prepare 之前，不是事后补救）。
      expect(stub.wire.slice(offMark).some((request) => request.carriesImage)).toBe(false);

      // 重新打开：纪元必须推进（1→2）——关闭再恢复不复活旧纪元的引用。
      expect(setGroupMedia(h, false)).toBe(2);
      const onMark = stub.wire.length;
      h.receive({ id: "3", speaker: "20002", addressed: true, text: "重新开了", image: IMAGE_REF });
      await h.activate("direct_reply");

      // 重新打开后这一轮真的走完了 native 准备：生成相 actualMode=native 且 wire 带图。
      const modes = mediaModes(diagnostics);
      expect(lastModeFor(modes, "generation")?.actualMode).toBe("native");
      expect(stub.wire.slice(onMark).some((request) => request.carriesImage)).toBe(true);
      // 资产不按纪元重复登记：同字节复用既有资产行（内容去重，不是按 run 复制）。
      const reopened = registered(h);
      expect(reopened.assets).toBe(opened.assets);
      expect(reopened.assetSha).toEqual([IMAGE_SHA]);
    } finally {
      await stub.close();
    }
  }, 60_000);
});

// ---- id 38 / 39：真实网关的 unsupported 降级与非降级 ----------------------------------------

/** 能力句式（命中网关的 IMAGE_REJECTION_PATTERN 且不含内容错误词）。 */
const CAPABILITY_SENTENCE = "image input not supported by this model";
/** 视觉模型名（harness 在媒体接线时登记的 `vision-stub`）。 */
const VISION_MODEL = "vision-stub";

/**
 * 终态安全快照：终态断言前整份落盘。输出目录只来自**可选**环境变量 `P4_TRACE_DIR`
 * （本夹具脚本专用，不设默认、不进生产路径）；未设置时不写任何文件。文件名带 UTC＋
 * crypto UUID nonce 防同秒覆写；内容仅文本/数值字段，无原始字节/URL。
 */
function isRunResult(
  value: unknown,
): value is { runId: string; status: "completed" | "no_output"; outputs: readonly unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "runId" in value &&
    typeof (value as { runId: unknown }).runId === "string" &&
    "status" in value &&
    ((value as { status: unknown }).status === "completed" ||
      (value as { status: unknown }).status === "no_output") &&
    "outputs" in value &&
    Array.isArray((value as { outputs: unknown }).outputs)
  );
}

function safeDump(label: string, payload: unknown): void {
  const dir = process.env.P4_TRACE_DIR;
  if (dir === undefined || dir === "") return;
  const utc = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}/${label}-${utc}-${randomUUID()}.json`,
    JSON.stringify(payload, null, 1),
    "utf8",
  );
}
/** 内容错误句式（含格式/尺寸词，规格要求**不**当成能力拒绝）。 */
const CONTENT_SENTENCE = "image format invalid: unsupported pixel dimension";

describe("T15 P4 · id 38 native unsupported 降级 description（同阶段一次）", () => {
  it("[S38_1] provider 明确拒绝图片能力：真实网关产 MODEL_IMAGE_UNSUPPORTED，宿主同阶段降级 description", async () => {
    const diagnostics: Diagnostic[] = [];
    // 第一轮成功（建立资产与投影），第二轮开始一律 400 能力句式。
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    const h = createFaultHarness({ stub, diagnostics, stages: { decision: false } });
    try {
      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      await h.activate("direct_reply");
      expect(lastModeFor(mediaModes(diagnostics), "generation")?.actualMode).toBe("native");

      // 真实 provider 拒绝：桩只回 HTTP，分类由产品做。**只对带图的请求**回能力句式——
      // 纯文字请求的 4xx 按规格不进图片分类（网关只给带图请求挂 imageRejection）。
      stub.set({
        kind: "http",
        status: 400,
        message: CAPABILITY_SENTENCE,
        onlyWithImage: true,
        textModelOnly: true,
      });
      // 每次唤醒的第一个决策都要 generate（generation 相才带图）：把计数起点对齐到本轮。
      stub.resetDecisionRun();
      // round-before 基线：run_id 集合＋真实出站 send 计数（按轮 diff，不跨轮虚计）。
      const runsBefore = new Set(
        (h.db.query("SELECT run_id FROM agent_runs").all() as { run_id: string }[]).map(
          (row) => row.run_id,
        ),
      );
      const sentBefore = h.sent.length;
      const mark = stub.wire.length;
      h.receive({ id: "2", speaker: "20002", addressed: true, text: "再看这张", image: IMAGE_REF });
      // 真实终态：降级跑通且本轮真实发言，不吞错误（旧「必须 failed」要求是坏 stub 时代产物）。
      const activationResult: unknown = await h.activate("direct_reply");
      expect(isRunResult(activationResult)).toBe(true);
      if (!isRunResult(activationResult)) throw new Error("ACTIVATION_SHAPE_INVALID");
      const activation = activationResult;
      await h.deliver();

      const modes = mediaModes(diagnostics);
      const generation = lastModeFor(modes, "generation");
      // requestedMode 保持 native（请求没变），actualMode 变 description。
      expect(generation?.requestedMode).toBe("native");
      expect(generation?.actualMode).toBe("description");
      // why/code 是产品的判断，不是脚本自述。
      expect(generation?.why).toBe("model_image_unsupported");
      expect(generation?.code).toBe("MODEL_IMAGE_UNSUPPORTED");
      // 降级后这一轮真的拿到了文字描述（真实视觉读取 + 真实 read task 落库）。
      expect(generation?.imageCount).toBe(0);
      const tasks = h.db.query("SELECT status, attempts, note FROM qq_media_read_tasks").all() as {
        status: string;
        attempts: number;
        note: string | null;
      }[];
      expect(tasks.length).toBeGreaterThan(0);
      for (const task of tasks) {
        expect(task.status).toBe("succeeded");
        expect(task.attempts).toBe(1);
        // 描述是真实视觉读取的结果，不是编出来的占位文字。
        expect(task.note).toBe("一张合成的灰蓝色方块图");
      }
      // 强负：降级后的**重试请求**本身不再带 image_url（原生图被剥掉、改送 description notes）。
      const retry = stub.wire[stub.wire.length - 1];
      expect(retry.carriesImage).toBe(false);
      expect(retry.roles).toContain("user");
      const runRows = h.db
        .query(
          "SELECT run_id, conversation_id, spec_id, status, error_code FROM agent_runs ORDER BY started_at",
        )
        .all() as {
        run_id: string;
        conversation_id: string | null;
        spec_id: string;
        status: string;
        error_code: string | null;
      }[];
      const stepRows = h.db
        .query(
          "SELECT run_id, step_no, model, phase, status, error_code FROM agent_steps ORDER BY run_id, step_no",
        )
        .all() as {
        run_id: string;
        step_no: number;
        model: string;
        phase: string;
        status: string;
        error_code: string | null;
      }[];
      // 断言前整份安全落盘（新 UTC nonce）：runs/steps/相位 wire 文本 presence。
      safeDump("s38_1-terminal", {
        activation: { runId: activation.runId, status: activation.status },
        newRuns: runRows.filter((row) => !runsBefore.has(row.run_id)),
        newSteps: stepRows.filter((row) => !runsBefore.has(row.run_id)),
        wire: stub.wire.slice(mark).map((request) => ({
          phase: request.phase,
          model: request.model,
          carriesImage: request.carriesImage,
          descriptionPresent: request.carriesUtterance("一张合成的灰蓝色方块图"),
        })),
      });
      // 真实终态（批准语义：同相降级跑通、本轮真实发言）：主 run 仓储行 completed /
      // error_code null，outputs 含本轮实际生成的描述正文；出站相对轮前基线恰 1 send。
      const mainRun = runRows.find((row) => row.run_id === activation.runId);
      expect(mainRun).toBeDefined();
      if (mainRun === undefined) throw new Error("MAIN_RUN_ROW_MISSING");
      expect(mainRun.conversation_id).not.toBeNull();
      expect(mainRun.spec_id).not.toBe("");
      expect(activation.status).toBe("completed");
      expect(mainRun.status).toBe("completed");
      expect(mainRun.error_code).toBeNull();
      expect(JSON.stringify(activation.outputs)).toContain("一张合成的灰蓝色方块图");
      expect(h.sent.length - sentBefore).toBe(1);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("[S38_2] 同一轮里原生请求与降级重试各发一次：先带图被拒，再纯文字成功", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    const h = createFaultHarness({ stub, diagnostics, stages: { decision: false } });
    try {
      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      await h.activate("direct_reply");
      stub.set({
        kind: "http",
        status: 400,
        message: CAPABILITY_SENTENCE,
        onlyWithImage: true,
        textModelOnly: true,
      });
      // round-before 基线：run_id 集合＋真实出站 send 计数（按轮 diff，不跨轮虚计）。
      const runsBefore = new Set(
        (h.db.query("SELECT run_id FROM agent_runs").all() as { run_id: string }[]).map(
          (row) => row.run_id,
        ),
      );
      const sentBefore = h.sent.length;
      stub.resetDecisionRun();
      const mark = stub.wire.length;
      h.receive({ id: "2", speaker: "20002", addressed: true, text: "再看这张", image: IMAGE_REF });
      // 真实终态：降级跑通且本轮真实发言，不吞错误。
      const activationResult: unknown = await h.activate("direct_reply");
      expect(isRunResult(activationResult)).toBe(true);
      if (!isRunResult(activationResult)) throw new Error("ACTIVATION_SHAPE_INVALID");
      const activation = activationResult;
      await h.deliver();

      // 真实 wire（按**声明相位**过滤）：generation 相被拒带图恰 1、紧随纯文 retry 恰 1、
      // 描述正文真到——不做跨相「全部纯文>0」的模糊计数。
      const turn = stub.wire.slice(mark).filter((request) => request.phase === "generation");
      const firstImage = turn.findIndex((request) => request.carriesImage);
      expect(firstImage).toBeGreaterThanOrEqual(0);
      // 同相禁止重复带图。
      expect(turn.some((request, index) => request.carriesImage && index !== firstImage)).toBe(
        false,
      );
      expect(turn).toHaveLength(firstImage + 2);
      // 降级重试排在带图那次**之后**（顺序是产品决定的，不是桩排的），且是纯文字。
      const retry = turn[firstImage + 1];
      expect(retry).toBeDefined();
      expect(retry?.carriesImage).toBe(false);
      // 描述正文真到：retry 请求里真带着视觉模型读出的描述。
      expect(retry?.carriesUtterance("一张合成的灰蓝色方块图")).toBe(true);
      // requestedMode 保持 native：被拒的是「这个模型收不了原生图」，请求本身没变。
      const generation = lastModeFor(mediaModes(diagnostics), "generation");
      expect(generation?.requestedMode).toBe("native");
      expect(generation?.actualMode).toBe("description");
      const runRows = h.db
        .query(
          "SELECT run_id, conversation_id, spec_id, status, error_code FROM agent_runs ORDER BY started_at",
        )
        .all() as {
        run_id: string;
        conversation_id: string | null;
        spec_id: string;
        status: string;
        error_code: string | null;
      }[];
      const stepRows = h.db
        .query(
          "SELECT run_id, step_no, model, phase, status, error_code FROM agent_steps ORDER BY run_id, step_no",
        )
        .all() as {
        run_id: string;
        step_no: number;
        model: string;
        phase: string;
        status: string;
        error_code: string | null;
      }[];
      // 断言前整份安全落盘（新 UTC nonce）：runs/steps/相位 wire 文本 presence。
      safeDump("s38_2-terminal", {
        activation: { runId: activation.runId, status: activation.status },
        newRuns: runRows.filter((row) => !runsBefore.has(row.run_id)),
        newSteps: stepRows.filter((row) => !runsBefore.has(row.run_id)),
        wire: stub.wire.slice(mark).map((request) => ({
          phase: request.phase,
          model: request.model,
          carriesImage: request.carriesImage,
          descriptionPresent: request.carriesUtterance("一张合成的灰蓝色方块图"),
        })),
      });
      // 真实终态（批准语义：同相降级跑通、本轮真实发言）：主 run 仓储行 completed /
      // error_code null，outputs 含本轮实际生成的描述正文；出站相对轮前基线恰 1 send。
      const mainRun = runRows.find((row) => row.run_id === activation.runId);
      expect(mainRun).toBeDefined();
      if (mainRun === undefined) throw new Error("MAIN_RUN_ROW_MISSING");
      expect(mainRun.conversation_id).not.toBeNull();
      expect(mainRun.spec_id).not.toBe("");
      expect(activation.status).toBe("completed");
      expect(mainRun.status).toBe("completed");
      expect(mainRun.error_code).toBeNull();
      expect(JSON.stringify(activation.outputs)).toContain("一张合成的灰蓝色方块图");
      expect(h.sent.length - sentBefore).toBe(1);
    } finally {
      await stub.close();
    }
  }, 60_000);
});

// ---- id 39：非 unsupported 故障一律不降级 ------------------------------------------------------

/** 逐个跑：这些故障都**不是**能力拒绝，产品必须原样报错、不得改写成 description。 */
const NON_UNSUPPORTED_FAULTS: readonly {
  readonly label: string;
  readonly status: number;
  readonly message: string;
}[] = [
  { label: "401 鉴权", status: 401, message: "invalid api key" },
  { label: "403 禁止", status: 403, message: "forbidden" },
  { label: "413 输入超长", status: 413, message: "image input too large" },
  { label: "429 限流", status: 429, message: "image rate limit exceeded" },
  { label: "500 服务错误", status: 500, message: "internal error" },
  // 带图片词但不是能力拒绝：内容错误词（format/dimension）必须按原 code，不写负缓存。
  { label: "400 内容拒绝", status: 400, message: CONTENT_SENTENCE },
  // 带能力句式但状态不是能力窗（429/413）：仍不构成能力证据。
  { label: "429 带能力句式", status: 429, message: CAPABILITY_SENTENCE },
  { label: "408 请求超时", status: 408, message: "request timeout" },
  { label: "503 服务不可用", status: 503, message: "service unavailable" },
];

/**
 * 非 HTTP 的两类故障：挂住（超时）与断连（网络）。它们不经 `mapModelError` 的状态映射，
 * 走超时/连接拒绝分支，因此单独成块而不是塞进上表。
 */
const TRANSPORT_FAULTS: readonly { readonly label: string; readonly answer: ProviderAnswer }[] = [
  // 桩收下请求后**不写响应**：调用方的整轮预算到期，错误来自超时而非 provider 状态。
  { label: "超时（桩不响应）", answer: { kind: "hang", onlyWithImage: true } },
];

describe("T15 P4 · id 39 非 unsupported 故障不降级（401/403/413/429/5xx/内容 400）", () => {
  // 每类一个**唯一**块号：聚合 runner 按标题匹配，重复标题会让 7 条塌成最后一条。
  NON_UNSUPPORTED_FAULTS.forEach((fault, index) => {
    const id = `S39_${String(index + 1)}`;
    it(`[${id}] ${fault.label}：真实网关按原 code 报错，本相零降级（actualMode 仍 native）`, async () => {
      const diagnostics: Diagnostic[] = [];
      const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
      const h = createFaultHarness({ stub, diagnostics, stages: { decision: false } });
      try {
        // 基线轮：成功，建立资产与投影（证明故障轮之前媒体是通的）。
        h.receive({
          id: "1",
          speaker: "20002",
          addressed: true,
          text: "看这张图",
          image: IMAGE_REF,
        });
        await h.activate("direct_reply");
        expect(lastModeFor(mediaModes(diagnostics), "generation")?.actualMode).toBe("native");
        const before = registered(h);

        stub.set({
          kind: "http",
          status: fault.status,
          message: fault.message,
          onlyWithImage: true,
          textModelOnly: true,
        });
        stub.resetDecisionRun();
        const mark = stub.wire.length;
        h.receive({
          id: "2",
          speaker: "20002",
          addressed: true,
          text: "再看这张",
          image: IMAGE_REF,
        });
        await h.activate("direct_reply").catch(() => undefined);

        // 强负一：**没有**降级。本相的实际模式仍是 native（不是 description/unavailable），
        // 也没有任何 media_mode 带 model_image_unsupported 的 why。
        const modes = mediaModes(diagnostics);
        expect(lastModeFor(modes, "generation")?.actualMode).toBe("native");
        expect(modes.some((mode) => mode.why === "model_image_unsupported")).toBe(false);
        expect(modes.some((mode) => mode.code === "MODEL_IMAGE_UNSUPPORTED")).toBe(false);
        // 强负二：**没有**独立的分类调用（§10 同次分类，不因故障多发一次）。
        expect(registered(h).classifications).toBe(before.classifications);
        // 强负三：带图的请求确实发出去了并被拒（不是发前就被能力闸拦掉——那会掩盖本故障）。
        expect(stub.wire.slice(mark).some((request) => request.carriesImage)).toBe(true);
        // 强负四：本轮不产生新的成功描述（降级路径一次都没走）。
        const succeeded = h.db
          .query("SELECT COUNT(*) AS n FROM qq_media_read_tasks WHERE status='succeeded'")
          .get() as { n: number };
        expect(succeeded.n).toBe(0);
      } finally {
        await stub.close();
      }
    }, 60_000);
  });
});

describe("T15 P4 · id 39 非 HTTP 故障（超时/挂住）同样不降级", () => {
  for (const [index, fault] of TRANSPORT_FAULTS.entries()) {
    // 编号接在 HTTP 故障之后（本文件 HTTP 故障共 9 条：401/403/413/429/500/400内容/429能力句式/408/503）。
    const id = `S39_${String(10 + index)}`;
    it(`[${id}] ${fault.label}：走超时分支，不改写成 unsupported、不降级 description`, async () => {
      const diagnostics: Diagnostic[] = [];
      const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
      const h = createFaultHarness({ stub, diagnostics, stages: { decision: false } });
      try {
        h.receive({
          id: "1",
          speaker: "20002",
          addressed: true,
          text: "看这张图",
          image: IMAGE_REF,
        });
        await h.activate("direct_reply");
        expect(lastModeFor(mediaModes(diagnostics), "generation")?.actualMode).toBe("native");

        // 带图的那次真的挂住：桩不写响应，由调用方的整轮预算收场。
        stub.set(fault.answer);
        stub.resetDecisionRun();
        const mark = stub.wire.length;
        h.receive({
          id: "2",
          speaker: "20002",
          addressed: true,
          text: "再看这张",
          image: IMAGE_REF,
        });
        // 超时会等满整轮预算：给一个明确的等待上限，但不为它放大预算。
        await h.activate("direct_reply").catch(() => undefined);

        // 强负：带图请求确实发出去了（故障落在传输层，不是发前被能力闸拦掉）。
        expect(stub.wire.slice(mark).some((request) => request.carriesImage)).toBe(true);
        // 强负：**没有**降级。超时不是能力拒绝，不得改写成 description。
        const modes = mediaModes(diagnostics);
        expect(modes.some((mode) => mode.why === "model_image_unsupported")).toBe(false);
        expect(modes.some((mode) => mode.code === "MODEL_IMAGE_UNSUPPORTED")).toBe(false);
        expect(lastModeFor(modes, "generation")?.actualMode).toBe("native");
        // 强负：降级路径一次都没走（没有成功的描述读取）。
        const succeeded = h.db
          .query("SELECT COUNT(*) AS n FROM qq_media_read_tasks WHERE status='succeeded'")
          .get() as { n: number };
        expect(succeeded.n).toBe(0);
      } finally {
        await stub.close();
      }
    }, 60_000);
  }
});

// ---- id 40：备用无模型 / 无容量只走 unknown 文字 ------------------------------------------------

describe("T15 P4 · id 40 备用无视觉模型：actualMode=unavailable，图像仍标 unknown，不编文字", () => {
  it("[S40_1] 备用无模型/无能力：真实服务在链且读不出，actualMode 如实 unavailable、零编造描述", async () => {
    // 方案声明 description + 视觉读取这次读不出来 → 真实服务（已接线）如实投影
    // **unavailable**：不编文字、不假装有描述、原生画面也不发。
    // 这是 §8.1「取不到就不编内容」——不是「组件没接线」。
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    // mediaEnabled:true 但**不配视觉模型**（不传 vision 数组）→ 组织设置 vision_model_name
    // 保持真实 null，而媒体组件**仍在链**。这正是「有媒体能力、无可用视觉模型」。
    const h = createFaultHarness({
      stub,
      diagnostics,
      stages: { decision: false },
      mode: "description",
    });
    try {
      // 组织设置里**真实**清掉视觉模型名：媒体组件仍在链（capabilityEnabled=true），
      // 但没有任何可用视觉模型。不用「不接线」或「改产品配置」来伪造这个场景——
      // 这是安装里「装了 QQ 媒体能力、没配视觉模型」的真实状态。
      h.orm
        .update(schema.organizationSettings)
        .set({ visionModelName: null })
        .where(eq(schema.organizationSettings.id, 1))
        .run();
      const cleared = h.db
        .query("SELECT vision_model_name AS v FROM organization_settings WHERE id=1")
        .get() as { v: string | null };
      expect(cleared.v).toBeNull();

      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      await h.activate("direct_reply").catch(() => undefined);

      const generation = lastModeFor(mediaModes(diagnostics), "generation");
      // requestedMode 仍是方案声明的 description；actualMode 是 unavailable（没有编造内容）。
      expect(generation?.requestedMode).toBe("description");
      expect(generation?.actualMode).toBe("unavailable");
      expect(generation?.imageCount).toBe(0);
      // 强负：没有可用视觉模型 ⇒ 一次视觉调用都没发生（真桩计数）。
      expect(h.visionCalls).toHaveLength(0);
      // 强负：没有落库的**成功**描述（不编文字）；失败的那次是真实的。
      const succeeded = h.db
        .query("SELECT COUNT(*) AS n FROM qq_media_read_tasks WHERE status='succeeded'")
        .get() as { n: number };
      expect(succeeded.n).toBe(0);
      // 强负：任何 read task 都没有 note 文字（失败的行不写描述）。
      const noted = h.db
        .query(
          "SELECT COUNT(*) AS n FROM qq_media_read_tasks WHERE note IS NOT NULL AND note != ''",
        )
        .get() as { n: number };
      expect(noted.n).toBe(0);
      // 强负：wire 上从未出现 image_url（这一模式本就不发原生画面）。
      expect(stub.wire.some((request) => request.carriesImage)).toBe(false);
      // 图像仍然被当作存在（媒体行进了线），没有被当成「没有图」。
      const disclosed = h.db.query("SELECT COUNT(*) AS n FROM qq_media_notes").get() as {
        n: number;
      };
      expect(disclosed.n).toBeGreaterThan(0);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("[S40_2] 无模型也不省文本窗口：这轮照常把原话与图的存在送进模型，只是不含图像解读", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    const h = createFaultHarness({
      stub,
      diagnostics,
      stages: { decision: false },
      mode: "description",
    });
    try {
      h.receive({
        id: "1",
        speaker: "20002",
        addressed: true,
        text: "这张图里有什么",
        image: IMAGE_REF,
      });
      await h.activate("direct_reply").catch(() => undefined);

      // 强负：模型确实被叫了（能力缺失不是「整轮不跑」）。
      expect(stub.wire.length).toBeGreaterThan(0);
      // 文本窗口没被省：用户那句原话进了请求。
      const said = stub.wire.some((request) => request.carriesUtterance("这张图里有什么"));
      expect(said).toBe(true);
    } finally {
      await stub.close();
    }
  }, 60_000);
});

// ---- id 37：in-flight 迟到结果不得发布 ------------------------------------------------------

describe("T15 P4 · id 37 取消：in-flight 迟到结果不发布、不留成功缓存", () => {
  it("[S37_1] fetch 中段真 abort：迟到结果既不发模型、也不落成功描述（真实 AbortController）", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    // 真 AbortController：测试自己持有取消所有权，经 activate 的 opts.signal 交给宿主。
    // 不用「替身回调自抛错误」——abort 由调用方真实发出，穿过宿主与读取器既有取消语义。
    const controller = new AbortController();
    let enteredFetch = false;
    const h = createFaultHarness({
      stub,
      diagnostics,
      stages: { decision: false },
      fetchHook: async () => {
        enteredFetch = true;
        // 取消发生在 fetch pending 中段：先把控制权交回，再由测试真实 abort。
        await Promise.resolve();
        controller.abort(new Error("S37_TEST_CANCELLED"));
        // 让这次 fetch 有机会观察到已取消的 signal（真实读取器会 throwIfAborted）。
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });
    try {
      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      // activate 传调用方自己的 signal（harness 已有该入参）。
      await h.activate("direct_reply", { signal: controller.signal }).catch(() => undefined);

      // 前置确认：取消确实发生在 fetch 门里（否则本块什么都没测）。
      expect(enteredFetch).toBe(true);
      expect(controller.signal.aborted).toBe(true);

      // 强负一：取消后**没有任何带图请求**上 wire（迟到的结果没有发出去）。
      expect(stub.wire.some((request) => request.carriesImage)).toBe(false);
      // 强负二：没有落库的**成功**描述（迟到的结果没有写缓存）。
      const succeeded = h.db
        .query("SELECT COUNT(*) AS n FROM qq_media_read_tasks WHERE status='succeeded'")
        .get() as { n: number };
      expect(succeeded.n).toBe(0);
      // 强负三：没有出站发送（这一轮被取消，不发言）。
      expect(h.sent).toHaveLength(0);
      const intents = h.db.query("SELECT COUNT(*) AS n FROM outbound_intents").get() as {
        n: number;
      };
      expect(intents.n).toBe(0);
      // 强负四：唤醒租约已结清，不留 running 孤儿（取消由既有 wakes.fail 收场）。
      const live = h.db
        .query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='running'")
        .get() as { n: number };
      expect(live.n).toBe(0);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("[S37_2] 取消与未取消的对照：不取消时同一张图会真的发出并登记（证明上一条不是恒真）", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    const h = createFaultHarness({ stub, diagnostics, stages: { decision: false } });
    try {
      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      await h.activate("direct_reply");
      // 对照面：不取消时同一张图真的上 wire 且真的登记了资产。
      expect(stub.wire.some((request) => request.carriesImage)).toBe(true);
      const reg = registered(h);
      expect(reg.assets).toBe(1);
      expect(reg.assetSha).toEqual([IMAGE_SHA]);
    } finally {
      await stub.close();
    }
  }, 60_000);
});

// ---- id 38 / 39：决策相与评分相的 unsupported 降级与非降级 -------------------------------------
//
// 上一节只在 generation 相实测。规格 §9 对**每一相**都有要求，因此这里补两块：
//   [S38_3] 决策相：真实 400 能力句式 -> 同相降级 description 恰一次；
//   [S38_4] 评分相：真实 initiative 许可路径 + 真实 judge-model，同相降级 description 恰一次。
// 两块都断言观测面的 requested/actual/why/code 与「文字/关系仍在、原生图被剥掉」。

/** 决策相要真带图，阶段必须**默认全开**（不为绿关阶段）。 */
const ALL_STAGES_OPEN = undefined;

describe("T15 P4 · id 38 决策相与评分相的 native unsupported 降级", () => {
  it("[S38_3] 决策相：真实 400 能力句式 -> 同相降级 description 恰一次，原生图被剥掉、文字保留", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    // 阶段**全部默认开启**（不给 stages）。决策相带图是已批准默认路径。
    const h = createFaultHarness({ stub, diagnostics, stages: ALL_STAGES_OPEN });
    try {
      // 基线轮：真带图上 wire（证明后面不是「本来就没图」）。
      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      await h.activate("direct_reply");
      const baseline = lastModeFor(mediaModes(diagnostics), "decision");
      expect(baseline?.actualMode).toBe("native");
      expect(baseline?.imageCount).toBe(1);

      // 决策相带图的那次真实 400 能力句式（纯文字请求照常答复——规格：网关只给带图请求挂图片分类）。
      stub.set({
        kind: "http",
        status: 400,
        message: CAPABILITY_SENTENCE,
        onlyWithImage: true,
        textModelOnly: true,
      });
      stub.resetDecisionRun();
      // 本轮 round-before run_id 集合：主 run 按真实 runId 配对，不猜 last row。
      const runsBefore = new Set(
        (h.db.query("SELECT run_id FROM agent_runs").all() as { run_id: string }[]).map(
          (row) => row.run_id,
        ),
      );
      const mark = stub.wire.length;
      h.receive({ id: "2", speaker: "20002", addressed: true, text: "再看这张", image: IMAGE_REF });
      // 真实终态：activate 必须真收口（旧 diag 通过不代表主 run 已通过），不吞错误。
      const activationResult: unknown = await h.activate("direct_reply");
      expect(isRunResult(activationResult)).toBe(true);
      if (!isRunResult(activationResult)) throw new Error("ACTIVATION_SHAPE_INVALID");
      const activation = activationResult;
      const runRows = h.db
        .query(
          "SELECT run_id, owner_kind, owner_id, spec_id, conversation_id, status, error_code FROM agent_runs ORDER BY started_at",
        )
        .all() as {
        run_id: string;
        owner_kind: string;
        owner_id: string;
        spec_id: string;
        conversation_id: string | null;
        status: string;
        error_code: string | null;
      }[];
      safeDump("s38_3-terminal", {
        activation: { runId: activation.runId, status: activation.status },
        newRuns: runRows.filter((row) => !runsBefore.has(row.run_id)),
        wire: stub.wire.slice(mark).map((request) => ({
          phase: request.phase,
          model: request.model,
          carriesImage: request.carriesImage,
        })),
      });
      const mainRun = runRows.find((row) => row.run_id === activation.runId);
      expect(mainRun).toBeDefined();
      if (mainRun === undefined) throw new Error("MAIN_RUN_ROW_MISSING");
      expect(mainRun.conversation_id).not.toBeNull();
      expect(mainRun.spec_id).not.toBe("");
      expect(activation.status).toBe("completed");
      expect(mainRun.status).toBe("completed");
      expect(mainRun.error_code).toBeNull();

      // 观测面：requestedMode 保持 native；actualMode 变 description；why/code 是产品判断。
      // 降级后宿主会**再观测一次**并补发一条同相 media_mode（why/code 为 null 的那一条是
      // 重观测，不是第二次降级），所以这里取**带 why 的那一条**——「同相降级恰一次」由此可断。
      const decisionFallback = mediaModes(diagnostics).find(
        (mode) => mode.phase === "decision" && mode.why === "model_image_unsupported",
      );
      expect(decisionFallback).toBeDefined();
      const decision = decisionFallback;
      expect(decision?.requestedMode).toBe("native");
      expect(decision?.actualMode).toBe("description");
      expect(decision?.why).toBe("model_image_unsupported");
      expect(decision?.code).toBe("MODEL_IMAGE_UNSUPPORTED");
      expect(decision?.imageCount).toBe(0);
      // 本请求已由真实网关解析，观测记录同次调用的实际模型。
      expect(decision?.resolvedModel).toBe("reply-model");
      // 强负：这一轮带图请求确实发出并被拒（不是发前就被能力闸拦掉）。
      expect(stub.wire.slice(mark).some((request) => request.carriesImage)).toBe(true);
      // 强负：**紧接被拒那一次的重试是纯文字**，原生 image_url 被剥掉。
      // 只看紧邻的一次——后续复核会重新观测并可能再次带图，那不是「同相降级的重试」。
      // 真实 wire 顺序（逐条实测）：reply-model 带图(被拒) -> vision-stub 带图(描述读取)
      // -> reply-model 纯文字(同相降级重试)。vision 那一步本来就带 data: 图（那是描述读取的
      // 输入），所以「剥掉原生图」指的是**对话模型**的重试不带图。
      const turn = stub.wire.slice(mark);
      const rejected = turn.findIndex(
        (request) => request.carriesImage && request.model === "reply-model",
      );
      expect(rejected).toBeGreaterThanOrEqual(0);
      // 紧邻的一步是真实视觉描述读取（证明降级不是「不发」，而是「换个方式再发」）。
      expect(turn[rejected + 1]?.model).toBe("vision-stub");
      // 强负：对话模型的重试是**纯文字**——原生 image_url 被剥掉。
      const retry = turn.slice(rejected + 1).find((request) => request.model === "reply-model");
      expect(retry).toBeDefined();
      expect(retry?.carriesImage).toBe(false);
      // 降级恰一次：本相只出现一条带 why 的 media_mode。
      const fallbacks = mediaModes(diagnostics).filter(
        (mode) => mode.phase === "decision" && mode.why === "model_image_unsupported",
      );
      expect(fallbacks).toHaveLength(1);
      // 文字与关系保留：用户原话仍逐字在重试请求里（降级不删文本窗口）。
      const said = turn.some((request) => request.carriesUtterance("再看这张"));
      expect(said).toBe(true);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("[S38_4] 评分相：真实 initiative 许可 + judge-model，真实 400 能力句式 -> 同相降级 description 恰一次", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    // 走真实 initiative 许可路径：未 @ 助手 的群消息 + 时钟推进过新鲜度窗口。
    const h = createFaultHarness({
      stub,
      diagnostics,
      stages: ALL_STAGES_OPEN,
      judgementModelName: "judge-model",
      initiativeMinScore: 6,
      telemetry: true,
    });
    try {
      // 基线轮：评分相真的发生（media_mode 里出现 evaluation 且真带图）。
      h.receive({ id: "1", speaker: "20002", text: "有人知道这个吗", image: IMAGE_REF });
      h.advance(INITIATIVE_WAIT_SECONDS);
      await h.activate("chiming_in").catch(() => undefined);
      const baseline = lastModeFor(mediaModes(diagnostics), "evaluation");
      expect(baseline).toBeDefined();
      expect(baseline?.actualMode).toBe("native");
      expect(baseline?.imageCount).toBe(1);
      // 评分相真的用判断模型（requestedModel 逐字是 judge-model，不是回复模型顶替）。
      expect(baseline?.requestedModel).toBe("judge-model");

      // 评分相带图的那次真实 400 能力句式。faultPhase 按评分相实际声明的 score schema 命中：
      // 同一 judge 模型的决策相请求照常成功（不按 model、不按序数打错 decision）。
      stub.set({
        kind: "http",
        status: 400,
        message: CAPABILITY_SENTENCE,
        onlyWithImage: true,
        textModelOnly: true,
        faultPhase: "evaluation",
      });
      stub.resetDecisionRun();
      const mark = stub.wire.length;
      // 本轮 round-before real agent_runs run_id 集合：主 run 按 activate runId 配对，不猜 last row。
      const runsBefore = new Set(
        (h.db.query("SELECT run_id FROM agent_runs").all() as { run_id: string }[]).map(
          (row) => row.run_id,
        ),
      );
      h.receive({ id: "2", speaker: "20002", text: "那这个呢", image: IMAGE_REF });
      h.advance(INITIATIVE_WAIT_SECONDS);
      // 真实终态：activate 必须真收口（generation/send 完成），返回值带真实主 runId。
      const activationResult: unknown = await h.activate("chiming_in");
      expect(isRunResult(activationResult)).toBe(true);
      if (!isRunResult(activationResult)) throw new Error("ACTIVATION_SHAPE_INVALID");
      const activation = activationResult;
      // 权威面：断言前 runs/steps/wire 相位整份安全落盘（独有 UTC，无 raw bytes/URL）。
      const runRows = h.db
        .query(
          "SELECT run_id, owner_kind, owner_id, spec_id, conversation_id, status, error_code FROM agent_runs ORDER BY started_at",
        )
        .all() as {
        run_id: string;
        owner_kind: string;
        owner_id: string;
        spec_id: string;
        conversation_id: string | null;
        status: string;
        error_code: string | null;
      }[];
      const stepRows = h.db
        .query(
          "SELECT run_id, step_no, model, phase, status, error_code FROM agent_steps ORDER BY run_id, step_no",
        )
        .all() as {
        run_id: string;
        step_no: number;
        model: string;
        phase: string;
        status: string;
        error_code: string | null;
      }[];
      const turn = stub.wire.slice(mark);
      safeDump("s38_4-terminal", {
        activation: { runId: activation.runId, status: activation.status },
        newRuns: runRows.filter((row) => !runsBefore.has(row.run_id)),
        newSteps: stepRows.filter((row) => !runsBefore.has(row.run_id)),
        wire: turn.map((request) => ({
          phase: request.phase,
          model: request.model,
          carriesImage: request.carriesImage,
          dataUrls: request.dataUrls,
          descriptionPresent: request.carriesUtterance("一张合成的灰蓝色方块图"),
        })),
      });
      // 主会话 run：activate 真实 runId ＋ 仓储同源校验（conversation/spec 面非空）。
      const mainRun = runRows.find((row) => row.run_id === activation.runId);
      expect(mainRun).toBeDefined();
      if (mainRun === undefined) throw new Error("MAIN_RUN_ROW_MISSING");
      expect(mainRun.conversation_id).not.toBeNull();
      expect(mainRun.spec_id).not.toBe("");
      // 本轮发送必须真主 completed（no_output ≠ completed，不假全 complete）。
      expect(activation.status).toBe("completed");
      expect(mainRun.status).toBe("completed");
      expect(mainRun.error_code).toBeNull();
      expect(activation.outputs.length).toBeGreaterThan(0);
      // 故意评分 leaf failed：本轮新增独立行，steps 留 typed 原码 MODEL_IMAGE_UNSUPPORTED
      //（按 phase=leaf ＋ model=judge-model 精确关联，不做泛配）。
      const failedRuns = runRows.filter(
        (row) => !runsBefore.has(row.run_id) && row.status === "failed",
      );
      const leafFailures = stepRows.filter(
        (row) =>
          failedRuns.some((run) => run.run_id === row.run_id) &&
          row.phase === "leaf" &&
          row.model === "judge-model" &&
          row.error_code === "MODEL_IMAGE_UNSUPPORTED",
      );
      expect(leafFailures.length).toBeGreaterThan(0);

      const evaluation = lastModeFor(mediaModes(diagnostics), "evaluation");
      expect(evaluation?.requestedMode).toBe("native");
      expect(evaluation?.actualMode).toBe("description");
      expect(evaluation?.why).toBe("model_image_unsupported");
      expect(evaluation?.code).toBe("MODEL_IMAGE_UNSUPPORTED");
      expect(evaluation?.imageCount).toBe(0);
      expect(evaluation?.resolvedModel).toBe("judge-model");
      // 强负（按**声明相位**过滤，不跨相伪造）：评分相带图请求恰一次。
      const evaluationTurn = turn.filter((request) => request.phase === "evaluation");
      const evaluationImageIndex = evaluationTurn.findIndex((request) => request.carriesImage);
      expect(evaluationImageIndex).toBeGreaterThanOrEqual(0);
      // 同相禁止重复带图：评分相其余请求全部纯文字，随后纯文字 retry 恰一次。
      expect(
        evaluationTurn.some(
          (request, index) => request.carriesImage && index !== evaluationImageIndex,
        ),
      ).toBe(false);
      expect(evaluationTurn).toHaveLength(evaluationImageIndex + 2);
      const evaluationRetry = evaluationTurn[evaluationImageIndex + 1];
      expect(evaluationRetry).toBeDefined();
      expect(evaluationRetry?.carriesImage).toBe(false);
      // 顺序＋描述正文真含：retry 请求里真带着视觉模型读出的描述（不是回读 round-1 基线）。
      expect(evaluationRetry?.carriesUtterance("一张合成的灰蓝色方块图")).toBe(true);
      // decision/generation 各自按相记录：用明确相位证证据，不做跨相零图伪要求。
      expect(turn.some((request) => request.phase === "decision")).toBe(true);
    } finally {
      await stub.close();
    }
  }, 60_000);
});

// ---- id 39：决策相与评分相的非 unsupported 故障（代表类，不做 phase x 十类笛卡尔） ------------
//
// 生成相的十类映射已由 [S39_1..10] 逐类实测（401/403/413/429/500/400内容/429能力句式/408/503/超时）。
// 这里只补另两相的**代表类**，不为凑笛卡尔重复十类：
//   [S39_11] 决策相 + 鉴权拒绝（401）→ 不降级；
//   [S39_12] 评分相 + 超时（桩不响应）→ 不降级、不重发第二次。
// 两相的「不降级」判据与生成相一致：actualMode 仍 native、零 model_image_unsupported why/code。

describe("T15 P4 · id 39 决策相与评分相的非 unsupported 故障不降级", () => {
  it("[S39_11] 决策相：真实 401 鉴权拒绝 -> 按原码报错，本相零降级（actualMode 仍 native）", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    const h = createFaultHarness({ stub, diagnostics, stages: ALL_STAGES_OPEN });
    try {
      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      await h.activate("direct_reply");
      expect(lastModeFor(mediaModes(diagnostics), "decision")?.actualMode).toBe("native");

      // 决策相带图的那次真实 401（鉴权：服务可达但拒绝）。纯文字请求照常答复。
      stub.set({
        kind: "http",
        status: 401,
        message: "invalid api key",
        onlyWithImage: true,
        textModelOnly: true,
      });
      stub.resetDecisionRun();
      const mark = stub.wire.length;
      h.receive({ id: "2", speaker: "20002", addressed: true, text: "再看这张", image: IMAGE_REF });
      await h.activate("direct_reply").catch(() => undefined);

      // 强负一：**没有**降级——本相没有出现任何 model_image_unsupported 的观测。
      const modes = mediaModes(diagnostics);
      expect(modes.some((mode) => mode.why === "model_image_unsupported")).toBe(false);
      expect(modes.some((mode) => mode.code === "MODEL_IMAGE_UNSUPPORTED")).toBe(false);
      expect(lastModeFor(modes, "decision")?.actualMode).toBe("native");
      // 强负二：带图请求确实发出并被拒（不是发前被能力闸拦掉，那会掩盖本故障）。
      expect(stub.wire.slice(mark).some((request) => request.carriesImage)).toBe(true);
      // 强负三：降级路径一次都没走（无成功描述读取）。
      const succeeded = h.db
        .query("SELECT COUNT(*) AS n FROM qq_media_read_tasks WHERE status='succeeded'")
        .get() as { n: number };
      expect(succeeded.n).toBe(0);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("[S39_12] 评分相：真实超时（桩不响应）-> 不降级、不改写成 unsupported", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    const h = createFaultHarness({
      stub,
      diagnostics,
      stages: ALL_STAGES_OPEN,
      judgementModelName: "judge-model",
      initiativeMinScore: 6,
    });
    try {
      h.receive({ id: "1", speaker: "20002", text: "有人知道这个吗", image: IMAGE_REF });
      h.advance(INITIATIVE_WAIT_SECONDS);
      await h.activate("chiming_in").catch(() => undefined);
      expect(lastModeFor(mediaModes(diagnostics), "evaluation")?.actualMode).toBe("native");

      // 评分相带图的那次挂住（整轮预算到期，不是 provider 状态）。
      stub.set({ kind: "hang", onlyWithImage: true });
      stub.resetDecisionRun();
      const mark = stub.wire.length;
      h.receive({ id: "2", speaker: "20002", text: "那这个呢", image: IMAGE_REF });
      h.advance(INITIATIVE_WAIT_SECONDS);
      await h.activate("chiming_in").catch(() => undefined);

      // 强负一：评分请求确实带图发出了（故障落在传输层）。
      const judgeImage = stub.wire
        .slice(mark)
        .filter((request) => request.model === "judge-model" && request.carriesImage);
      expect(judgeImage.length).toBeGreaterThan(0);
      // 强负二：**没有**降级。超时不是能力拒绝。
      const modes = mediaModes(diagnostics);
      expect(modes.some((mode) => mode.why === "model_image_unsupported")).toBe(false);
      expect(modes.some((mode) => mode.code === "MODEL_IMAGE_UNSUPPORTED")).toBe(false);
      expect(lastModeFor(modes, "evaluation")?.actualMode).toBe("native");
      // 强负三：降级路径一次都没走。
      const succeeded = h.db
        .query("SELECT COUNT(*) AS n FROM qq_media_read_tasks WHERE status='succeeded'")
        .get() as { n: number };
      expect(succeeded.n).toBe(0);
    } finally {
      await stub.close();
    }
  }, 60_000);
});

// ---- id 37 续：off→on 旧纪元不复活 + 在飞迟到结果在纪元变化后不发布 -------------------------

describe("T15 P4 · id 37 纪元变化：旧在飞结果在 off→on 之后不发布、不发消息", () => {
  it("[S37_3] 组能力 off→on 纪元推进：在飞请求跨纪元回来时零发送、零资产、零缓存", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    // 在飞控制：fetch 门里挂住，期间测试把本群 media 能力 off→on（纪元 0->1->2）后放行。
    // 只有**一个** activate 在飞（唤醒租约串行），不并发两个 run。
    // 闭包内赋值再在闭包外调用：`let` 会被 TS 控制流收窄成 never（TS2349），用显式容器。
    const gate: { release: (() => void) | null } = { release: null };
    let enteredFetch = false;
    const h = createFaultHarness({
      stub,
      diagnostics,
      stages: ALL_STAGES_OPEN,
      fetchHook: async () => {
        enteredFetch = true;
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      },
    });
    try {
      h.receive({
        id: "1",
        speaker: "20002",
        addressed: true,
        text: "在飞时关掉",
        image: IMAGE_REF,
      });
      // 先等到 fetch 门真的被走到（这一轮已经在飞）。
      const inFlight = h.activate("direct_reply");
      for (let spin = 0; spin < 500 && !enteredFetch; spin += 1)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(enteredFetch).toBe(true);

      // 纪元真的推进：off -> 1，on -> 2（关闭再恢复不复活旧纪元引用）。
      const epochOff = setGroupMedia(h, true);
      const epochOn = setGroupMedia(h, false);
      expect(epochOff).toBe(1);
      expect(epochOn).toBe(2);

      // 放行在飞请求：它的结果属于**旧纪元**（fetch 是在纪元 0 时进入的）。
      gate.release?.();
      await inFlight.catch(() => undefined);

      // 强负一：零发送——纪元变化后这一轮没有把结果变成真实出站（本条成立）。
      expect(h.sent).toHaveLength(0);
      // 强负二：零成功描述（旧纪元结果不写缓存）。
      const succeeded = h.db
        .query("SELECT COUNT(*) AS n FROM qq_media_read_tasks WHERE status='succeeded'")
        .get() as { n: number };
      expect(succeeded.n).toBe(0);
      // 强负三：纪元变化后旧在飞结果**不得**被采纳——零资产、零变体。
      // 这是规格要求的强负（关闭再恢复不复活旧纪元的任何产物），不是「记录现状」。
      //
      // 记录分工（避免把「注释改动」与「断言改动」混为一谈）：
      //  - **断言**：下面 `assets/variants/assetSha` 三条自 RED 阶段起**逐字未改**，
      //    修复后直接变绿（日志 `p4-s37-3-epoch-green.log`；RED 原件 `p4-s37-3-epoch-red.log` 保留）。
      //  - **注释**：只有这一段说明文字是修复后补写的，用于交代 RED->GREEN 的来历。
      //
      // 修复落点在 producer 侧：`assertConfiguration` 新增群 media 能力纪元检查
      // （`MEDIA_CAPABILITY_EPOCH_CHANGED`），经 `assertAuthority -> source.assertCurrent
      // -> 服务内 assertCurrent` 覆盖到真正的写入边界。我未改 prod/harness、未 restore。
      const after = registered(h);
      expect(after.assets).toBe(0);
      expect(after.variants).toBe(0);
      expect(after.assetSha).toEqual([]);
      // 强负四：纪元确实是 2，旧纪元 1 不因重新打开而复活。
      const binding = readQqBinding(h.orm, h.bindingId);
      if (binding === null) throw new Error("BINDING_MISSING");
      expect(readQqGroupCapabilityRevision(h.orm, binding, "media")).toBe(2);
    } finally {
      gate.release?.();
      await stub.close();
    }
  }, 60_000);
});

// ---- id 40 续：容量未知的边界 ---------------------------------------------------------------
//
// 规格 §14/§9 只要求「备用无模型/无能力仅 unknown」。**容量未知**是另一条独立的拒绝理由：
// UTF-8 字节近似 token、容量未知或预算错误必须**明确拒绝**，不许静默缩预算。
// 本块断的是这条边界本身：容量探测不可读时这一轮**如实失败**，而不是缩预算或降级发图。

describe("T15 P4 · id 40 容量未知：明确拒绝，不静默缩预算、不降级发图", () => {
  // 容量未知的两个**真实**来源（码已从源码逐行核定，不靠 regexp 粗过）：
  //   - 目录里没有该模型：网关 `loadedContextCapacity` 返回 `null`（harness 原样透传 null，
  //     不拿默认容量顶替）-> `context-source.ts:914-915` `fail("CONTEXT_CAPACITY_UNKNOWN")`；
  //   - 容量探测 HTTP 500：网关抛 `ModelUnavailableError("MODEL_CAPACITY_UNAVAILABLE")`
  //     （`model-gateway.ts:859-862`）。
  // 两者都是既有 taxonomy 里的真实 code，不是本文件造的。
  // 容量在**图片准备之前**就要确认，所以拒绝必须早于任何取字节/登记/模型调用。

  it("[S40_3] 目录里没有该模型：容量 getter 返回 null -> CONTEXT_CAPACITY_UNKNOWN，零取字节/零调用", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    stub.set({ kind: "capacity_null" });
    let fetchCalls = 0;
    // 端口**取一次**并复用：同一实例同时供文本与容量（容量是它自带的真实 getter）。
    const port = realPort(stub);
    // 强前置：getter 必须是**真实存在的那个方法**，不是被静默丢掉的 undefined
    // ——否则夹具会回落到常量容量，那正是本块要断的反面。
    expect(typeof port.capacityOf?.loadedContextCapacity).toBe("function");
    const h = createFaultHarness({
      stub,
      diagnostics,
      stages: ALL_STAGES_OPEN,
      capacityGateway: port.capacityOf,
      fetchHook: async () => {
        fetchCalls += 1;
      },
    });
    try {
      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      // 容量未知必须**明确拒绝**（抛错），不得静默缩预算后照发。
      await expect(h.activate("direct_reply")).rejects.toMatchObject({
        code: "CONTEXT_CAPACITY_UNKNOWN",
      });
      // 强前置：真实容量 getter 确实被调过（不是常量兜底把拒绝蒙混出来）。
      expect(port.capacityProbeCalls.length).toBeGreaterThan(0);
      expect(port.capacityProbeCalls).toContain("reply-model");
      // 强负一：拒绝发生在**取字节之前**——零受控 fetch。
      expect(fetchCalls).toBe(0);
      // 强负二：零带图请求发出去（没有「先发了再说」）。
      expect(stub.wire.some((request) => request.carriesImage)).toBe(false);
      // 强负三：零资产/变体登记（缓存面同样没被写）。
      const reg = registered(h);
      expect(reg.assets).toBe(0);
      expect(reg.variants).toBe(0);
      // 强负四：零成功描述、零发送。
      const succeeded = h.db
        .query("SELECT COUNT(*) AS n FROM qq_media_read_tasks WHERE status='succeeded'")
        .get() as { n: number };
      expect(succeeded.n).toBe(0);
      expect(h.sent).toHaveLength(0);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("[S40_4] 容量探测 HTTP 500：真实 getter 抛 MODEL_CAPACITY_UNAVAILABLE，同样早于取字节与调用", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    // 容量探测面回 500（对话请求照常答复，隔离本块变量）。
    stub.set({ kind: "capacity_probe_500" });
    let fetchCalls = 0;
    // 端口取一次并复用（同一实例供文本与容量）。
    const port = realPort(stub);
    // 强前置：真实 getter 存在（不是被静默丢掉的 undefined -> 常量兜底）。
    expect(typeof port.capacityOf?.loadedContextCapacity).toBe("function");
    const h = createFaultHarness({
      stub,
      diagnostics,
      stages: ALL_STAGES_OPEN,
      capacityGateway: port.capacityOf,
      fetchHook: async () => {
        fetchCalls += 1;
      },
    });
    try {
      h.receive({ id: "1", speaker: "20002", addressed: true, text: "看这张图", image: IMAGE_REF });
      // 探测失败是**传输层**拒绝：网关自己的码，不是 context-source 的容量未知码。
      await expect(h.activate("direct_reply")).rejects.toMatchObject({
        code: "MODEL_CAPACITY_UNAVAILABLE",
      });
      // 强前置：真实容量 getter 确实被调过（本块与 S40_3 分开跑，各自独立计）。
      expect(port.capacityProbeCalls.length).toBeGreaterThan(0);
      // 强负：同样早于取字节、零带图请求、零登记、零发送。
      expect(fetchCalls).toBe(0);
      expect(stub.wire.some((request) => request.carriesImage)).toBe(false);
      expect(registered(h).assets).toBe(0);
      expect(h.sent).toHaveLength(0);
    } finally {
      await stub.close();
    }
  }, 60_000);
});

// ---- S36 全局关闭（与本群能力关闭分别） ------------------------------------------------------
//
// 本群关闭走 `updateQqGroupConfig` 的能力纪元（`[S36_1]/[S36_2]` 已实测）。
// **全局**关闭是另一条路：宿主选项 `mediaEnabled`（生产消费点 `runtime.ts`
// `mediaEnabled: () => execution().modules.qqMedia`，进 `bot-host.ts:559` 的
// `o.mediaEnabled?.() !== false`）。本块断的是**同一宿主选项消费面**——由夹具注入该 bool，
// 走的正是生产那条 `mediaEnabled` 判定分支。
//
// 范围声明（不夸大）：**未**验证「设置保存链」。真实安装里这个 bool 来自
// `ExecutionModules.qqMedia`（`src/shared/contracts/permissions.ts`），要经 PermissionService
// 的 store 落盘、再被 runtime 读出；那条链需要真实权限存储接线，不在本块范围。
// 所以本块只声称「同宿主选项消费面」，**不**声称「设置已保存并生效」。
//
// 全局关闭时**媒体组件根本不注入**——那正是审阅点名的「组件未注入所以空」，
// 所以本块必须同时给出**对照**：同一条链在全局开着时真 fetch、真登记，关掉才全 0。

/** 带图入站（全局开/关两段完全相同的输入；消息 id 必须是 `^-?\d+$` 才过 OneBot wire 校验）。 */
let globalOffMessageSeq = 0;
function imageMessage(h: OneBotHarness): void {
  globalOffMessageSeq += 1;
  h.receive({
    id: String(900 + globalOffMessageSeq),
    speaker: "20002",
    addressed: true,
    text: "看这张图",
    image: IMAGE_REF,
  });
}

describe("T15 P4 · S36 全局媒体关闭（与本群能力关闭分别）", () => {
  it("[S36_3] 全局关 media：零 fetch、零视觉、零登记、零带图请求；开着时确有 fetch/登记作对照", async () => {
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    try {
      // 对照：全局**开**（mediaEnabled 不传＝夹具按 vision 接线，媒体在链）。
      const onDiagnostics: Diagnostic[] = [];
      let onFetch = 0;
      const on = createFaultHarness({
        stub,
        diagnostics: onDiagnostics,
        stages: ALL_STAGES_OPEN,
        fetchHook: async () => {
          onFetch += 1;
        },
      });
      imageMessage(on);
      await on.activate("direct_reply");
      // 强负（对照）：开着时这条链**真的**做了 fetch 与登记——不是天生 0。
      // 对照项选 native 路径真正会发生的两件（取字节 + 登记资产/变体）；
      // **不含** visionCalls：native 自动图不调视觉模型（那是 description 路径的事），
      // 拿 visionCalls 当对照会变成恒假，掩盖真正的对照意义。
      expect(onFetch).toBeGreaterThan(0);
      const onRegistered = registered(on);
      expect(onRegistered.assets).toBe(1);
      expect(onRegistered.variants).toBe(1);
      expect(onRegistered.assetSha).toEqual([IMAGE_SHA]);
      on.close();

      // 全局关：mediaEnabled=false -> 媒体组件不注入。
      const offDiagnostics: Diagnostic[] = [];
      let offFetch = 0;
      const off = createFaultHarness({
        stub,
        diagnostics: offDiagnostics,
        stages: ALL_STAGES_OPEN,
        mediaEnabled: false,
        fetchHook: async () => {
          offFetch += 1;
        },
      });
      imageMessage(off);
      await off.activate("direct_reply").catch(() => undefined);
      // 强负一：零 fetch（没有受控取字节）。
      expect(offFetch).toBe(0);
      // 强负二：零视觉调用。
      expect(off.visionCalls).toHaveLength(0);
      // 强负三：零登记（资产/变体/分类全 0）。
      const reg = registered(off);
      expect(reg.assets).toBe(0);
      expect(reg.variants).toBe(0);
      expect(reg.classifications).toBe(0);
      // 强负四：零带图请求上 wire（再发一条，确保不是只有首轮没图）。
      const mark = stub.wire.length;
      imageMessage(off);
      await off.activate("direct_reply").catch(() => undefined);
      expect(stub.wire.slice(mark).some((request) => request.carriesImage)).toBe(false);
      // 强负五：零成功描述（不编文字）。
      const succeeded = off.db
        .query("SELECT COUNT(*) AS n FROM qq_media_read_tasks WHERE status='succeeded'")
        .get() as { n: number };
      expect(succeeded.n).toBe(0);
      off.close();
    } finally {
      await stub.close();
    }
  }, 60_000);
});

// ---- S39 故障的真实错误码与图片尝试次数 ------------------------------------------------------
//
// 每个 status 都要有**真实**的落库结果：`agent_runs.error_code` 是产品自己写的码（不是我构造的），
// 且带图请求在 wire 上**恰好一次**——不多一次图片重试。
// 注意：一次失败可能伴随若干次**纯文字**调用（schema/tools 降级、决策复核），那些不计图片尝试。
//
// 码的来源（按源码逐行核定，不猜）：生成相的模型调用失败先在运行时内被「没有可准备的输出」
// 收口 —— `agent-runtime.ts:1198` 抛 `AGENT_OUTPUT_FAILED`，`errorCode()` 只取抛出点自设的 `.code`，
// 所以这一层落库的是 `AGENT_OUTPUT_FAILED`；模型层的真实映射码（`mapModelError`：
// 401/403 -> MODEL_SERVICE_UNAVAILABLE、其余 -> MODEL_ERROR）只在失败一路冒到运行时最外层时才落库。
// 两种都是既有 taxonomy 里的真实 code，这里按**实际观测**逐个固定，不用 regexp 泛配。

describe("T15 P4 · S39 真实错误码与图片尝试次数", () => {
  const CASES: readonly {
    readonly id: string;
    readonly status: number;
    readonly message: string;
    /** 模型层真实映射码（`mapModelError`），必须在 agent_steps 面逐字出现。 */
    readonly expectModelCode: string;
    /** run 级外码（生成相被收口后的产物），只作辅助断言。 */
    readonly expectRunError: string;
  }[] = [
    {
      id: "401",
      status: 401,
      message: "invalid api key",
      // 401/403 是「服务可达但拒绝」，按既有约定共用 MODEL_SERVICE_UNAVAILABLE
      // （`model-gateway.ts:366-368`），不是鉴权专属码。
      expectModelCode: "MODEL_SERVICE_UNAVAILABLE",
      expectRunError: "AGENT_OUTPUT_FAILED",
    },
    {
      id: "413",
      status: 413,
      message: "image input too large",
      expectModelCode: "MODEL_ERROR",
      expectRunError: "AGENT_OUTPUT_FAILED",
    },
    {
      id: "429",
      status: 429,
      message: "image rate limit exceeded",
      expectModelCode: "MODEL_ERROR",
      expectRunError: "AGENT_OUTPUT_FAILED",
    },
    {
      id: "500",
      status: 500,
      message: "internal error",
      expectModelCode: "MODEL_ERROR",
      expectRunError: "AGENT_OUTPUT_FAILED",
    },
  ];

  for (const item of CASES) {
    it(`[S39_13] HTTP ${item.id}：agent_steps 留真实模型映射码、run 级外码如实，带图请求恰好 1 次`, async () => {
      const diagnostics: Diagnostic[] = [];
      const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
      // 关决策相，让本块只观察**生成相**这一次带图调用（避免把决策相的图算进来）。
      const h = createFaultHarness({ stub, diagnostics, stages: { decision: false } });
      try {
        h.receive({
          id: "1",
          speaker: "20002",
          addressed: true,
          text: "看这张图",
          image: IMAGE_REF,
        });
        await h.activate("direct_reply");

        stub.set({
          kind: "http",
          status: item.status,
          message: item.message,
          onlyWithImage: true,
          textModelOnly: true,
        });
        stub.resetDecisionRun();
        const mark = stub.wire.length;
        h.receive({
          id: "2",
          speaker: "20002",
          addressed: true,
          text: "再看这张",
          image: IMAGE_REF,
        });
        await h.activate("direct_reply").catch(() => undefined);

        const turn = stub.wire.slice(mark);
        // 强负一：带图请求**恰好一次**——失败后没有再发第二次带图请求。
        // （纯文字调用不算图片尝试：它们是 schema/tools 降级或复核，不是重发图片。）
        const imageCalls = turn.filter((request) => request.carriesImage);
        expect(imageCalls).toHaveLength(1);

        // 强负二：**模型层真实映射码必须仍然在案**。
        // 生成相的 catch（`agent-runtime.ts:1164-1175`）把模型错误收成
        // `status:"failed"` 的 output（带 `code: errorCode(error)`＝原码），
        // run 级因此落 `AGENT_OUTPUT_FAILED`；但**同一次 step**（`:1466-1470` 的
        // `finishStep(...,{errorCode:code})`）留的是**原码**。
        // 所以「原错误动作/重试语义有没有被统一输出掩盖」要在 step 面断，不能只看 run 面。
        const steps = h.db
          .query(
            "SELECT phase, model, status, error_code FROM agent_steps WHERE status='failed' ORDER BY step_no",
          )
          .all() as {
          phase: string;
          model: string | null;
          status: string;
          error_code: string | null;
        }[];
        expect(steps.length).toBeGreaterThan(0);
        for (const step of steps) {
          // 每一行失败 step 都带非空错误码（不允许 null 蒙过去）。
          expect(step.error_code).not.toBeNull();
          // 绝不出现「被改成 unsupported」的那个码。
          expect(step.error_code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
          // 不被统一收口成 run 级那个码：step 面必须留模型层的真实映射码。
          expect(step.error_code).not.toBe("AGENT_OUTPUT_FAILED");
        }
        // 真实 HTTP status 映射码必须逐字出现（按 status 固定，不做 regexp 泛配）。
        expect(steps.map((step) => step.error_code)).toContain(item.expectModelCode);
        // 生成相那一行的模型名与 status 也如实记录（不是空壳）。
        const generationStep = steps.find((step) => step.phase === "generate");
        expect(generationStep).toBeDefined();
        if (generationStep === undefined) throw new Error("GENERATION_STEP_MISSING");
        expect(generationStep.model).not.toBeNull();
        // run 级外码（辅助面）：它只说明「这一轮没产出」，不代替上面的原码。
        const failedRuns = h.db
          .query("SELECT error_code FROM agent_runs WHERE status='failed'")
          .all() as { error_code: string | null }[];
        expect(failedRuns.length).toBeGreaterThan(0);
        for (const row of failedRuns) expect(row.error_code).toBe(item.expectRunError);

        // 强负三：仍然零降级（真实码不是 MODEL_IMAGE_UNSUPPORTED）。
        const modes = mediaModes(diagnostics);
        expect(modes.some((mode) => mode.code === "MODEL_IMAGE_UNSUPPORTED")).toBe(false);
        expect(lastModeFor(modes, "generation")?.actualMode).toBe("native");
        // 强负四：零成功描述（降级路径一次没走）。
        const succeeded = h.db
          .query("SELECT COUNT(*) AS n FROM qq_media_read_tasks WHERE status='succeeded'")
          .get() as { n: number };
        expect(succeeded.n).toBe(0);
      } finally {
        await stub.close();
      }
    }, 60_000);
  }
});

// ---- S35 评分相关闭（独立 initiative 对照，不靠 direct 两相） --------------------------------
//
// `[S35_1]/[S35_2]` 断的是决策相与生成相。评分相只在 **initiative 许可路径**发生
// （`chiming_in` 未 @ 助手 + 时钟推进），所以「关评分相」不能拿 direct 两相凑：
// 必须走真实许可路径，证关掉评分相时**评分相无图**、而决策/生成相照常带图。

describe("T15 P4 · S35 评分相关闭（真实 initiative 许可路径）", () => {
  it("[S35_4] 关评分相：评分相 actualMode=disabled 且零图，决策/生成相照常 native；许可路径真实发生", async () => {
    const diagnostics: Diagnostic[] = [];
    const stub = await startProvider({ initial: { kind: "http", status: 200, message: "" } });
    const h = createFaultHarness({
      stub,
      diagnostics,
      stages: { evaluation: false },
      judgementModelName: "judge-model",
      initiativeMinScore: 6,
    });
    try {
      h.receive({ id: "1", speaker: "20002", text: "有人知道这个吗", image: IMAGE_REF });
      h.advance(INITIATIVE_WAIT_SECONDS);
      const result = await h.activate("chiming_in").catch(() => undefined);

      const modes = mediaModes(diagnostics);
      // 许可路径真的发生了：评分相被观测到（哪怕是关闭投影），requestedMode 仍是方案声明的 native。
      const evaluation = lastModeFor(modes, "evaluation");
      expect(evaluation).toBeDefined();
      expect(evaluation?.requestedMode).toBe("native");
      // 本块变量：评分相关闭 → 全零，且**没有**评分请求带图。
      expect(evaluation?.actualMode).toBe("disabled");
      expect(evaluation?.imageCount).toBe(0);
      // 强负：关掉评分相后，**那一相**不再带图。
      // 注意 initiative 路径的**决策相也用 judge-model**（`spec.model`），它按本块设计
      // 仍开着并照常带图——所以不能按模型名断言「judge-model 零带图」，
      // 那会把决策相的合法带图误判成失败。按相断：观测面已证 evaluation 关闭且 imageCount=0，
      // 诊断可同时记录投影与实际模型；调用次数以真实 wire 的协议相位为准。
      const evaluationRequests = stub.wire.filter((request) => request.phase === "evaluation");
      expect(evaluationRequests).toHaveLength(1);
      expect(evaluationRequests[0]?.carriesImage).toBe(false);
      const evaluationModes = mediaModes(diagnostics).filter((mode) => mode.phase === "evaluation");
      expect(evaluationModes.every((mode) => mode.actualMode === "disabled")).toBe(true);
      // 未关闭的相照常：决策相与生成相仍 native/1。
      expect(lastModeFor(modes, "decision")?.actualMode).toBe("native");
      expect(lastModeFor(modes, "decision")?.imageCount).toBe(1);
      expect(lastModeFor(modes, "generation")?.actualMode).toBe("native");
      expect(lastModeFor(modes, "generation")?.imageCount).toBe(1);
      // 许可路径确实被走到（不是提前静默）：这一轮要么完成要么按许可被拒，但评分相有观测。
      expect(result === null).toBe(false);
    } finally {
      await stub.close();
    }
  }, 60_000);
});
