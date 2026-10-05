// T08 Step5/8 e2e 准备（B 联调）：主动开口媒体闸 × 本 run 原生读证明（§8.1 native consumed proof）。
//
// 本文件落盘时不执行（等宿主与共享源稳定后统一运行）。历史稿 70d30432 的四处错误在此版改正：
//
//   1) 测试函数非 async、未 await activate/deliver、finally 过早 close —— 本稿全部 async/await，
//      自有合成 provider 在 finally 里等激活全部完成后再关闭；
//   2) 手写 ModelPort 假 gateway（自拼 JSON wire 冒充 HTTP）—— 本稿用产品真实 createLmStudioClient
//      + createModelPort（P4 realPort 同款装配，含真实视觉叶子 completeMultimodal）打到本文件自有
//      的 127.0.0.1 port 0 合成 provider；图片字节只在发送边界经真实 run resolver 解析进 HTTP body；
//   3) targetId "web" —— QQ 出站目标一律是本会话真实 targetId（说话人 "20002"），不是 web；
//   4) 以 3 个 it.skip 注释代 5 例 —— 本稿 4 例全部真实实现，零 skip、零占位、零 it.todo。
//
// 用例与 §8.1 分层契约的对应（nativeReadProof ＝ 已发生的实际理解证据；initialNativeReadEligibility
// ＝「可尝试」不是「已理解」；strict 闸（prepareOutput/commitOutputs）只吃 proof，不注入资格回调）：
//   [NP1] 正例：真实 typed 失败账本（决策相工具 media.describe → 真实 reader 失败 →
//         failMediaReadTask，不 SQL 手调 attempts/revisions）→ 同一 initiative 链上新 run 资格
//         暂缓闸 → 决策相真实 HTTP 带图（受控字节逐字上 wire）→ 成功调用消费记账
//         （onModelCallConsumed）→ strict prepareOutput 凭 model_consumed 放行 → 评分许可 → commit
//         → 真实出站；失败账本行原样保留（proof 解除误挡，不删行）。
//   [NP2] unsupported：真实 provider 400 能力句式 → 网关产 MODEL_IMAGE_UNSUPPORTED → 同相降级
//         description → 真实视觉读取成功 → run 合法发言。发言归因于 description 成功（真实
//         succeeded 账本行），**不是** native proof：整条成功链上零带图 HTTP 成功调用。
//   [NP3] 本 run 决策相关闭：上一 run 凭自己的消费发送后，本 run 关决策相——同内容旧失败行经
//         内容桥仍然挡闸，资格回调因 stage off 返回空 → 初始准备即 blocked media_read_failed →
//         零模型调用、零发送。只主张「之前的成功不代本 run 资格」；纯 Map 隔离在现有 public
//         接口不可直接观测，不断言（不 hook 造 proof）；stage-on 默认重读正对照即 NP1。
//   [NP4] 本群 media 能力当前关闭（真实 updateQqGroupConfig CAS，纪元推进）：资格回调因能力
//         关闭返回空 → blocked media_read_failed → 零发送。在飞请求的纪元动态覆盖是 P4 S37_3
//         已有真面，本稿不主张、不另建模板。
//   B1（留后续，不在本轮 4 例 scope）：生成相 native 流式成功消费观察进 proof —— 等 runtime 的
//   stream-consumed 回调（phase generate）合流后另派补例，本稿不实现、不占位。
//
// 2026-10-04 provider 修复（joint2 四例真实失败后的修复，限定在
// tests/integration/qq-native-consumed-judgement-e2e.test.ts 本文件）：只改本文件自有的合成
// provider 响应形状与捕获面的图字节度量，不动产品网关、不加 gateway fallback 兼容、不新增协议、
// 不改宿主/reader/harness、不改本轮强用例的 gate（all-fail 预期仍 expected fail，不是 pass）。
//   1) 响应信封：joint2 四例全部止于首 decision 的 AGENT_DECISION_INVALID /「决策解析失败…(空)」。
//      真实读法是 createLmStudioClient.complete 取 payload.choices[0].message.content，而桩原先
//      把模型正文（决策/评分/生成的 JSON）直接当 HTTP 200 的 body。空文本是形状错配的必然结果。
//      现所有非流式 200 统一交付 OpenAI 信封 choices[0].message.content＝模型正文；envelope
//      决策仍是 {decision,media}、其余仍是本体，信封只是运输。HTTP 错误（含 provider 能力句式
//      400）仍走非 2xx ＋ error 体，不套信封——分类与错误码映射是产品代码。流式 SSE 路径
//      delta.content 直接是模型正文（不在 delta 外再套 choices），与产品 streamChat 读法一致。
//      视觉叶子：原本就是 choices 信封（正确），现走同一条 formatter 保持单一来源。
//   2) 图字节 sha：捕获面对整条 data URL **字符串**求 sha256，而受控常量 IMAGE_SHA 是对
//      decode 后 **字节** 求的，两把尺子量同一张图恒不相等，命中面必红。现捕获面先对 base64
//      解码再求 sha，与 IMAGE_SHA 同一把尺子。「原 wire 逐字」由 carriesImage（原文出现
//      image_url）与每次请求的 imageShas 命中面证明，不依赖这次改动。
//
// 边界：不读真实 data/local/artifacts(state)、不触 17861、不接真实 QQ/模型/服务；合成 provider 是
// 本文件自有的 node:http port 0 服务（finally 关闭）；模型可见的 image part 只有来源元数据，字节
// 只出现在发送边界组装的 data URL；捕获面只记布尔/计数/码/JSON 结构，不落 bytes/base64。
// maxSteps 与输入容量走夹具默认（policy maxSteps 20、capacity 65536），本稿不扩预算、不改 schema。
// 运行期 trace：env `QQ_NATIVE_PROOF_TRACE_DIR` 指定目录时，每 case 在任何 assert 前把完整捕获面
// （runs/steps/spans/账本/出站正文/wire/全部诊断）落到唯一 UTC 文件；abort/error 也走捕获落 trace。

import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import http from "node:http";
import { createModelPort, type ModelPort } from "../../src/server/agent/model-port";
import { loadQqMessageFact } from "../../src/server/channels/onebot11/message-projection";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import {
  readQqGroupAgentConfig,
  readQqGroupCapabilityRevision,
  updateQqGroupConfig,
} from "../../src/server/db/qq-group-config-repository";
import { mediaAssetForMediaNote } from "../../src/server/db/qq-media-asset-repository";
import { mediaNoteRow, mediaSegmentsForEvent } from "../../src/server/db/qq-media-repository";
import { findMediaReadTask } from "../../src/server/db/qq-media-task-repository";
import {
  readQqScheme,
  schemeMediaInput,
  schemeTriggers,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";
import { createLmStudioVisionClient } from "../../src/server/llm/vision-client";
import { RuntimeSpanRepository } from "../../src/server/observability/span-repository";
import type { OneBotSendRequest } from "../../src/server/services/onebot-connection";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";
import {
  closeHarnesses,
  createOneBotHarness,
  type OneBotHarness,
  type OneBotHarnessOptions,
} from "../harness/onebot";

afterEach(() => {
  closeHarnesses();
});

// ---- 共享小工具（仅本文件内，不构成第二 harness/第二模型链） ------------------------------

const IMAGE_REF = "np-image-1";
const IMAGE_BYTES = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
const IMAGE_SHA = createHash("sha256").update(IMAGE_BYTES).digest("hex");
/**
 * NP3 专用：**内容不同**的第二张受控合成图（不同像素 → 不同 content sha）。NP3 要证的是
 * 「上一次成功不代本轮当前媒体的失败资格」，所以本轮挡闸的必须是一条**当前**图自己的失败，
 * 而不是同一张图靠历史成功来补。NP1/2/4 仍只用 IMAGE_BYTES。
 */
const IMAGE_REF_2 = "np-image-2";
const IMAGE_BYTES_2 = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(160), 8, 8);
const IMAGE_SHA_2 = createHash("sha256").update(IMAGE_BYTES_2).digest("hex");
/** 能力句式（命中网关的 IMAGE_REJECTION_PATTERN；分类由产品做，桩只回 HTTP 原话）。 */
const CAPABILITY_SENTENCE = "image input not supported by this model";
const INITIATIVE_WAIT_SECONDS = 31;

/** 渲染面上的 ActionObservation（context-engine dataMessage）：{id, name, arguments?, value, sources}。 */
interface ObservedAction {
  readonly id: string;
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
  readonly value?: { readonly items?: readonly { id?: string }[] };
}

/** 一次真实 HTTP 请求的安全捕获面：model/schema/status/动作观察/图字节 sha 全记，不落 bytes/base64。 */
interface WireRecord {
  readonly model: string;
  readonly stream: boolean;
  readonly schemaKind: "decision" | "score" | "plain-score" | "text" | "vision";
  readonly carriesImage: boolean;
  /** 本次请求体里实际出现的每个 image data URL 的 sha256（受控合成字节的 sha 常量见 IMAGE_SHA）。 */
  readonly imageShas: readonly string[];
  readonly tools: readonly string[];
  /** 本次请求携带的全部 action_observation（渲染顺序，name/id 逐字记录；args 在 decisionReply 里）。 */
  readonly observations: readonly { readonly id: string; readonly name: string }[];
  /** 决策相本桩实际回出的决策本体（含 invoke 的 name+arguments），HTTP 错误时记 "http <status>"。 */
  readonly decisionReply: string;
  readonly status: number;
}

/** 决策相答复：要么真实 HTTP 错误（桩只回状态与 provider 原话），要么决策本体（包装按请求 schema）。 */
type DecisionAnswer =
  | { readonly status: number; readonly message: string }
  | { readonly body: Record<string, unknown> };

interface DecisionContext {
  readonly carriesImage: boolean;
  readonly envelope: boolean;
  readonly observations: readonly ObservedAction[];
}

interface Diagnostic {
  readonly stage: string;
  readonly status: string;
  readonly code?: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

/**
 * 本机 port 0 合成 provider（只服务本文件）：/models 全量目录；/chat/completions 按**本次请求的
 * 真实 response schema 形状**应答（评分/生成形状固定，决策相交给用例的 script），视觉叶子
 * （vision-stub）按 setVision 应答。能力句式分类、错误码映射、降级判定、envelope 解析全部是
 * 产品代码，桩只回 HTTP。
 */
async function startProvider(): Promise<{
  origin: string;
  readonly wire: WireRecord[];
  setDecision: (script: (context: DecisionContext) => DecisionAnswer) => void;
  setVision: (answer: { readonly ok: boolean; readonly text?: string }) => void;
  close: () => Promise<void>;
}> {
  const wire: WireRecord[] = [];
  let decide: (context: DecisionContext) => DecisionAnswer = () => ({ body: { kind: "none" } });
  let vision: { readonly ok: boolean; readonly text?: string } = { ok: false };
  const server: Server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "reply-model" }, { id: "judge-model" }] }));
        return;
      }
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = JSON.parse(raw) as {
        model?: string;
        stream?: boolean;
        tools?: readonly { function?: { name?: string } }[];
        messages?: readonly { content: unknown }[];
        response_format?: { json_schema?: { schema?: Record<string, unknown> } };
      };
      const schema = body.response_format?.json_schema?.schema;
      const properties = (schema?.properties ?? null) as Record<string, unknown> | null;
      const oneOfBranches = Array.isArray(schema?.oneOf) ? (schema?.oneOf as unknown[]) : [];
      const envelope = oneOfBranches.some(
        (branch) =>
          typeof branch === "object" &&
          branch !== null &&
          (branch as { properties?: { media?: unknown } }).properties?.media !== undefined,
      );
      const texts: string[] = [];
      for (const message of body.messages ?? []) {
        if (typeof message.content === "string") texts.push(message.content);
        else if (Array.isArray(message.content))
          for (const part of message.content as { type?: string; text?: string }[])
            if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
      }
      // context-engine 渲染：JSON.stringify({kind:"action_observation", trust:"data_only",
      // value:<ActionObservation {id,name,arguments?,value,sources}>})。按 name 匹配动作，
      // 不猜形状、不把别的动作观察当作 media.list/media.describe。
      const observations: ObservedAction[] = [];
      for (const text of texts) {
        if (!text.includes('"action_observation"')) continue;
        try {
          const parsed = JSON.parse(text) as { kind?: string; value?: ObservedAction };
          if (parsed.kind === "action_observation" && typeof parsed.value?.name === "string")
            observations.push({
              id: typeof parsed.value.id === "string" ? parsed.value.id : "",
              name: parsed.value.name,
              arguments: parsed.value.arguments,
              value: parsed.value.value,
            });
        } catch {
          // 不是本渲染面的 JSON：跳过继续向前找（与 driveToolFirst 同一纪律）。
        }
      }
      const carriesImage = raw.includes('"image_url"');
      // 图的身份按**解码后的字节**算（受控常量 IMAGE_SHA 同样是 IMAGE_BYTES 的 sha256）。
      // 捕获面用同一把尺子：对 data URL 里的 base64 解码再求 sha。原先对整条 data URL 字符串
      // 求 sha，两把尺子量同一张图恒不相等，命中面会红在度量口径上而不是字节上。
      // "原 wire 逐字" 仍由 carriesImage（原文出现 image_url）与下面这些逐请求命中面证明。
      const imageShas = [...raw.matchAll(/data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)/g)].map(
        (match) =>
          createHash("sha256")
            .update(Buffer.from(match[1] ?? "", "base64"))
            .digest("hex"),
      );
      // 本文件自有的模型正文（决策/评分/生成）与**响应信封**分开：真实网关读的是
      // choices[0].message.content（createLmStudioClient.complete），视觉叶子读
      // choices[0].message.content（createLmStudioVisionClient.annotate）。模型正文是本次请求
      // response_schema 要求的那份 JSON（envelope 决策＝{decision,media}，其余＝本体），
      // OpenAI 信封只是运输；错误仍是 HTTP 非 2xx ＋ error 体，不套信封。
      const answer: { status: number; text: string } = { status: 200, text: "" };
      let schemaKind: WireRecord["schemaKind"] = "decision";
      let decisionReply = "";
      if (body.model === "vision-stub") {
        schemaKind = "vision";
        if (vision.ok) {
          answer.text = vision.text ?? "";
        } else {
          answer.status = 500;
          answer.text = "vision unavailable";
        }
      } else if (properties?.scoreResult !== undefined) {
        schemaKind = "score";
        answer.text = JSON.stringify({ scoreResult: { score: 6 }, media: [] });
      } else if (properties?.score !== undefined) {
        schemaKind = "plain-score";
        answer.text = JSON.stringify({ score: 6, reason: "ok" });
      } else if (properties?.text !== undefined) {
        schemaKind = "text";
        answer.text = JSON.stringify({ text: "合成回复正文", media: [] });
      } else {
        const decided = decide({ carriesImage, envelope, observations });
        if ("status" in decided) {
          answer.status = decided.status;
          decisionReply = `http ${decided.status}`;
          answer.text = decided.message;
        } else {
          decisionReply = JSON.stringify(decided.body);
          answer.text = JSON.stringify(
            envelope ? { decision: decided.body, media: [] } : decided.body,
          );
        }
      }
      wire.push({
        model: body.model ?? "",
        stream: body.stream === true,
        schemaKind,
        carriesImage,
        imageShas,
        tools: (body.tools ?? []).map((tool) => tool?.function?.name ?? ""),
        observations: observations.map((observation) => ({
          id: observation.id,
          name: observation.name,
        })),
        decisionReply,
        status: answer.status,
      });
      // 非 2xx 与 HTTP 错误答案是 provider 原话（error 体），2xx 才按 OpenAI 信封交付；
      // 流式路径另走 SSE（delta.content 直接是模型正文，不在 delta 外再套 choices）。
      if (answer.status !== 200) {
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: answer.text } }));
        return;
      }
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: answer.text } }] })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: answer.text } }] }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${address.port}/v1`,
    wire,
    setDecision: (script) => {
      decide = script;
    },
    setVision: (next) => {
      vision = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 产品真实网关 + 真实端口（P4 realPort 同款装配）：文本与视觉叶子都打本文件自有合成 provider。 */
function realPort(origin: string): ModelPort {
  const config = { baseUrl: origin, model: "reply-model", timeoutSeconds: 5 };
  return createModelPort({
    gateway: createLmStudioClient(config),
    // §9 描述回退要真发一次视觉读取：不给 vision 时 createModelPort 不带 completeMultimodal，
    // 产品按「无可用视觉模型」处理——那是 S40 的语义，不是本稿要的。
    vision: createLmStudioVisionClient(config),
  });
}

function createNativeHarness(
  stubOrigin: string,
  diagnostics: Diagnostic[],
  visionCursor: readonly string[],
  /**
   * 触发开关的合法夹具设置（只影响**分类**走哪条生产分支，不改产品默认）。缺省＝夹具默认
   * （direct_reply/follow_up/chiming_in/idle_topic 全开），NP1/2/4 一律不传。
   * 见 NP3：`offer()` 的真实分类里，会员在**助手已开口之后**的新消息落到 follow_up，
   * 所以只 claim chiming_in 永远领不到机会；本例把 follow_up 关掉，让生产分类本身走
   * chiming_in，而不是在测试里改口径或绕过分类。
   */
  triggers?: OneBotHarnessOptions["triggers"],
  /**
   * 受控合成图片字节表的覆盖（NP3 用它挂第二张不同内容的图）。缺省＝本文件那一张
   * IMAGE_BYTES；只有 NP3 传，NP1/2/4 的字节表逐字不变。
   */
  imageBytes?: Readonly<Record<string, Uint8Array>>,
): OneBotHarness {
  return createOneBotHarness({
    kind: "group",
    accountId: "90001",
    member: "20002",
    conversationModel: "reply-model",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    ...(triggers === undefined ? {} : { triggers }),
    mediaInput: { mode: "native" },
    imageBytes: imageBytes ?? { [IMAGE_REF]: IMAGE_BYTES },
    // 媒体工具接线（media.list/describe）+ 组织设置 vision-stub 登记：工具型描述读取走夹具合成
    // 适配器的受控答复游标（夹具只替换视觉模型本身）；native 投影/分类/降级/账本全部是宿主与
    // 服务的真实代码。
    vision: visionCursor,
    // 真实可观测落库（RuntimeTelemetry）：宿主诊断与 agent.* span 同一实例、同一业务库，
    // captureState 经 RuntimeSpanRepository 按真实 run_id 读回 stepID/来源诊断。
    telemetry: true,
    model: realPort(stubOrigin),
    onDiagnostic: (event) => {
      diagnostics.push({
        stage: event.stage,
        status: event.status,
        ...(event.code === undefined ? {} : { code: event.code }),
        ...(event.details === undefined ? {} : { details: event.details }),
      });
    },
  });
}

interface MediaMode {
  readonly phase: string;
  readonly requestedMode: string;
  readonly actualMode: string;
  readonly why: string | null;
  readonly code: string | null;
  readonly imageCount: number;
}

function mediaModes(diagnostics: readonly Diagnostic[]): MediaMode[] {
  const out: MediaMode[] = [];
  for (const event of diagnostics) {
    if (event.stage !== "media_mode") continue;
    const details = event.details ?? {};
    out.push({
      phase: String(details.phase ?? ""),
      requestedMode: String(details.requestedMode ?? ""),
      actualMode: String(details.actualMode ?? ""),
      why: details.why === undefined || details.why === null ? null : String(details.why),
      code: event.code === undefined || event.code === null ? null : String(event.code),
      imageCount: Number(details.imageCount ?? 0),
    });
  }
  return out;
}

const lastModeFor = (modes: readonly MediaMode[], phase: string): MediaMode | undefined =>
  [...modes].reverse().find((mode) => mode.phase === phase);

/** 出站请求的安全面：部件数 + 全部 text 段逐字正文（合成内容，无 bytes）。 */
function sentTextOf(request: OneBotSendRequest): string {
  return request.message
    .map((segment) => (segment.type === "text" ? segment.data.text : ""))
    .join("");
}

/**
 * 断言前的完整真实状态捕获：runs（公开契约 listRuns，真实 run_id/stepId/status/errorCode）、
 * 最新 run 的真实 span 面（RuntimeSpanRepository.page：spanId/stage/status/code/model/sourceSeq/
 * details）+ typed 账本 + 出站正文 + wire + **全部**诊断，先落变量再写断言。
 */
function captureState(
  h: OneBotHarness,
  wire: readonly WireRecord[],
  diagnostics: readonly Diagnostic[],
) {
  const runs = h.runs.listRuns({ ownerKind: "conversation", ownerId: h.conversationId });
  const spans =
    runs.length > 0
      ? new RuntimeSpanRepository(h.db).page({ runId: runs[0].runId, limit: 200 }).items
      : [];
  return {
    runs: runs.map((run) => ({
      runId: run.runId,
      status: run.status,
      errorCode: run.errorCode,
      steps: run.steps.map((step) => ({
        stepId: step.stepId,
        stepNo: step.stepNo,
        phase: step.phase,
        status: step.status,
        model: step.model,
        errorCode: step.errorCode,
      })),
    })),
    spans: spans.map((span) => ({
      spanId: span.spanId,
      name: span.name,
      stage: span.stage,
      status: span.status,
      code: span.code,
      model: span.model,
      runId: span.runId,
      sourceSeq: span.sourceSeq,
      details: span.details,
    })),
    readTasks: h.db
      .query("SELECT status,attempts,note FROM qq_media_read_tasks ORDER BY rowid")
      .all() as { status: string; attempts: number; note: string | null }[],
    intents: h.db.query("SELECT id,status FROM outbound_intents ORDER BY rowid").all() as {
      id: string;
      status: string;
    }[],
    sent: h.sent.map((request) => ({ parts: request.message.length, text: sentTextOf(request) })),
    wire: [...wire],
    diagnostics: [...diagnostics],
    mediaModes: mediaModes(diagnostics),
  };
}

/**
 * 每 case 的 UTC trace：env `QQ_NATIVE_PROOF_TRACE_DIR` 指定目录时，在**任何 assert 之前**把
 * 完整捕获面落到该目录下唯一 UTC 文件（node:fs mkdirSync recursive + writeFileSync）。
 * 目录已指定而落盘失败＝错误**向上抛**（test 明确失败，不吞错、不静默当成功）；错误路径的
 * 使用见各 case 的 catch：先 capture 失败现场，trace 自身失败显式 console.error，原 error
 * 原样抛出。
 */
function writeTrace(tag: string, build: () => unknown): void {
  const dir = process.env.QQ_NATIVE_PROOF_TRACE_DIR;
  if (dir === undefined || dir === "") return;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(
    `${dir}/qq-native-proof-${tag}-${stamp}-${crypto.randomUUID().slice(0, 8)}.json`,
    JSON.stringify(build(), null, 2),
  );
}

/** 方案 media_input 组真实 CAS 写（updateQqScheme；revision 不符即冲突），返回写后的决策相开关。 */
function setDecisionStage(h: OneBotHarness, decision: boolean): boolean {
  const binding = readQqBinding(h.orm, h.bindingId);
  if (!binding) throw new Error("binding missing");
  const current = readQqScheme(h.orm, binding.schemeId);
  if (!current) throw new Error("scheme missing");
  const mediaInput = schemeMediaInput(current);
  updateQqScheme(h.orm, current.id, {
    name: current.name,
    mediaInput: { ...mediaInput, stages: { ...mediaInput.stages, decision } },
    expectedRevision: current.revision,
  });
  const updated = readQqScheme(h.orm, binding.schemeId);
  if (!updated) throw new Error("scheme missing");
  return schemeMediaInput(updated).stages.decision;
}

/** 本会话当前的媒体事实作用域（与宿主 mediaScope 同一四元组，只读用途）。 */
function mediaScopeOf(h: OneBotHarness): QqConversationScope {
  const binding = readQqBinding(h.orm, h.bindingId);
  if (!binding) throw new Error("binding missing");
  return {
    conversationId: h.conversationId,
    accountId: binding.accountId,
    conversationKind: binding.kind,
    peerId: binding.peerId,
    agentId: binding.agentId,
    bindingId: binding.id,
    bindingEpoch: h.journal.ensureOneBot(h.bindingId)?.bindingEpoch ?? 0,
    authorityRevision: binding.authorityRevision,
  };
}

/**
 * 一条平台消息 id 在**当前**作用域下的真实 event key（公开投影读法 loadQqMessageFact，
 * 按 platformMessageId 定位，只读）。
 *
 * 不用 h.lastEventSeq：那是 receive() 里按 normalized.eventKey 找 journal 行得到的**缓存值**，
 * 本例多次 receive 之后它可能仍停在前一条，于是 sourceRef 断言拿到的是图 1 而不是图 2。
 * 这里按「当前作用域 + 当前 platformMessageId」现查，拿到的一定是这条消息自己的行。
 */
function eventKeyOfMessage(h: OneBotHarness, platformMessageId: string): string {
  const fact = loadQqMessageFact(
    { db: h.db, orm: h.orm },
    mediaScopeOf(h),
    platformMessageId,
    h.now(),
  );
  if (!fact) throw new Error("inbound fact missing");
  return fact.id;
}

/**
 * 一条消息上那张图的**真实**读取事实（全部走公开仓储的只读口径，不 SQL update、不插预算）：
 * 媒体行的 id/引用、typed 账本那一行、以及该载体自己的 live asset 链（同 scope）。
 * 「当前媒体的失败」必须由这三样一起证明——只有账本 failed 行不够：没有 asset 链就没有
 * 内容身份，同内容桥也接不上，那样的 failed 行并不是本轮可判定的当前失败。
 */
function imageReadFacts(h: OneBotHarness, eventKey: string) {
  const binding = readQqBinding(h.orm, h.bindingId);
  if (!binding) throw new Error("binding missing");
  const segment = mediaSegmentsForEvent(h.orm, eventKey).find((row) => row.kind === "image");
  if (!segment) throw new Error("image segment missing");
  const note = mediaNoteRow(h.orm, eventKey, segment.segmentIndex);
  if (!note) throw new Error("media note missing");
  const task = findMediaReadTask(h.orm, { mediaNoteId: note.id, purpose: "baseline" });
  const asset = mediaAssetForMediaNote(h.orm, {
    mediaNoteId: note.id,
    scope: {
      accountId: binding.accountId,
      conversationKind: binding.kind,
      peerId: binding.peerId,
      agentId: binding.agentId,
    },
    at: h.now(),
  });
  return {
    noteId: note.id,
    sourceRef: note.sourceRef,
    task: task === null ? null : { status: task.status, attempts: task.attempts },
    assetId: asset?.asset.id ?? null,
    contentSha256: asset?.asset.contentSha256 ?? null,
  };
}

/** 方案 triggers 组的真实 CAS 写（updateQqScheme，revision 不符即冲突），返回写后的开关值。 */
function setFollowUp(h: OneBotHarness, enabled: boolean): boolean {
  const binding = readQqBinding(h.orm, h.bindingId);
  if (!binding) throw new Error("binding missing");
  const current = readQqScheme(h.orm, binding.schemeId);
  if (!current) throw new Error("scheme missing");
  const triggers = schemeTriggers(current);
  updateQqScheme(h.orm, current.id, {
    name: current.name,
    triggers: { ...triggers, follow_up: enabled },
    expectedRevision: current.revision,
  });
  const updated = readQqScheme(h.orm, binding.schemeId);
  if (!updated) throw new Error("scheme missing");
  return schemeTriggers(updated).follow_up;
}

/** 本群 media 能力：真实 updateQqGroupConfig 的 CAS 写（纪元逐次推进，旧纪元永久失效）。 */
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

/**
 * 种子 run 的决策 script：list → describe（工具型描述经夹具视觉游标真实失败）→ none。
 *
 * `wantedId` 是 NP3 专用的精确目标：会话里同时存在图 1（已失败）与图 2（新图）时，
 * media.list 的观察是**真实列表**（按发生时间倒序），取 items[0] 会拿到另一张图的 id，
 * 于是 describe 读的是旧图、失败账本记的也不是本轮这条消息。给了 wantedId 就按该 id 精确
 * 选择 media.list 自己披露的那一项——不 mock 披露、不绕开 media.list、仍然只认 list 自己的
 * 观察（不拿别的动作的 id 顶替）。
 *
 * 不传（NP1/2/4 全部如此）＝取首个 item，行为逐字不变。
 */
function seedDecisionScript(wantedId?: string): (context: DecisionContext) => DecisionAnswer {
  return (context) => {
    // 按 name 匹配观察：media.describe 已有观察＝读取已真实发生 → none 收口；media.list 的
    // 观察里取目标 item id（同 ref 只认 media.list 自己的观察，不取别的动作）→ describe。
    if (context.observations.some((observation) => observation.name === "media.describe"))
      return { body: { kind: "none" } };
    const listed = context.observations.find((observation) => observation.name === "media.list");
    const items = listed?.value?.items ?? [];
    const id =
      wantedId === undefined ? items[0]?.id : items.find((item) => item?.id === wantedId)?.id;
    if (typeof id === "string" && id !== "")
      return { body: { kind: "invoke", calls: [{ name: "media.describe", arguments: { id } }] } };
    return { body: { kind: "invoke", calls: [{ name: "media.list", arguments: {} }] } };
  };
}

const GENERATE_DECISION: Record<string, unknown> = {
  kind: "final",
  outputs: [{ kind: "generate", targetId: "20002", instructions: "描述这张图", stickerIds: [] }],
};

it("[NP1] this run's native consumption really relieves a legacy failed read: eligibility defers, the image round-trips HTTP, strict permit commits a send", async () => {
  const diagnostics: Diagnostic[] = [];
  const stub = await startProvider();
  let h: OneBotHarness | null = null;
  try {
    h = createNativeHarness(stub.origin, diagnostics, ["fail"]);
    // ── 种子 run：真实 typed 失败账本（media.describe → 夹具视觉游标 fail → 真实 reader 失败
    // 落账），run 零发送、无 speech —— 失败行因此留在后续 run 的闸窗口里。
    stub.setDecision(seedDecisionScript());
    h.receive({ id: "1", speaker: "20002", text: "看这张图", image: IMAGE_REF });
    h.advance(INITIATIVE_WAIT_SECONDS);
    await h.activate("chiming_in");
    const seeded = captureState(h, stub.wire, diagnostics);
    writeTrace("np1-seed", () => seeded);
    expect(seeded.sent).toHaveLength(0);
    expect(seeded.readTasks).toEqual([{ status: "failed", attempts: 1, note: null }]);

    // ── 正例 run：新 initiative 回复直接引用原图（§7.1 自动范围＝回应消息里的图＋它直接引用
    // 原图）→ 初始资格探询暂缓闸 → 决策相真实带图 HTTP → 消费记账 → strict prepareOutput 凭
    // model_consumed 放行 → 评分许可 → 生成 → commit → 真实出站。
    stub.setDecision(() => ({ body: { ...GENERATE_DECISION } }));
    const wireMark = stub.wire.length;
    h.receive({ id: "2", speaker: "20002", text: "那这张呢", replyTo: "1" });
    h.advance(INITIATIVE_WAIT_SECONDS);
    await h.activate("chiming_in");
    await h.deliver();
    const done = captureState(h, stub.wire, diagnostics);
    writeTrace("np1-final", () => done);
    const runWire = done.wire.slice(wireMark);

    // wire：本 run 决策相真的把受控字节逐字发上了 HTTP（发送边界 resolver，不是投影快照）；
    // wire 上实际图字节的 sha256 与受控合成字节逐字相同。
    const decisionCalls = runWire.filter((request) => request.schemaKind === "decision");
    expect(
      decisionCalls.some(
        (request) => request.status === 200 && request.imageShas.includes(IMAGE_SHA),
      ),
    ).toBe(true);
    // 本地路由保持冻结 JSON 决策协议：tools 不上 wire。
    for (const request of decisionCalls) expect(request.tools).toEqual([]);
    // native 全链零视觉读取（native 不需要描述；真实视觉叶子一次都没被叫）。
    expect(runWire.some((request) => request.schemaKind === "vision")).toBe(false);
    // strict 闸只认 model_consumed：失败账本行原样保留（proof 解除误挡、不删行）而发送真实发生。
    expect(done.readTasks).toContainEqual({ status: "failed", attempts: 1, note: null });
    expect(done.sent).toHaveLength(1);
    expect(done.intents).toHaveLength(1);
    expect(done.runs.some((run) => run.status === "completed")).toBe(true);
    // 诊断面：决策相 requestedMode=native、actualMode=native（真实 emitMediaMode 事件）。
    expect(lastModeFor(done.mediaModes, "decision")?.requestedMode).toBe("native");
    expect(lastModeFor(done.mediaModes, "decision")?.actualMode).toBe("native");
  } catch (error) {
    // 错误路径：先 capture 失败现场；trace 自身失败显式报出（不静默），原 error 原样抛出。
    try {
      writeTrace("np1-error", () => ({
        error: String(error),
        captured: h === null ? null : captureState(h, stub.wire, diagnostics),
      }));
    } catch (traceError) {
      console.error("[NP1] trace 落盘失败（原错误随后原样抛出）:", traceError);
    }
    throw error;
  } finally {
    await stub.close();
  }
}, 120_000);

it("[NP2] a real provider image rejection falls back to a real description: the send is a legal description success, never native proof", async () => {
  const diagnostics: Diagnostic[] = [];
  const stub = await startProvider();
  let h: OneBotHarness | null = null;
  try {
    h = createNativeHarness(stub.origin, diagnostics, ["unused-cursor"]);
    stub.setVision({ ok: true, text: "一张合成的灰蓝色方块图" });
    stub.setDecision((context) =>
      context.carriesImage
        ? { status: 400, message: CAPABILITY_SENTENCE }
        : {
            body: {
              kind: "final",
              outputs: [
                {
                  kind: "inline",
                  targetId: "20002",
                  text: "一张合成的灰蓝色方块图。",
                  stickerIds: [],
                },
              ],
            },
          },
    );
    h.receive({ id: "1", speaker: "20002", text: "看这张图", image: IMAGE_REF });
    h.advance(INITIATIVE_WAIT_SECONDS);
    await h.activate("chiming_in");
    await h.deliver();
    const done = captureState(h, stub.wire, diagnostics);
    writeTrace("np2-final", () => done);

    // 真实拒绝：对话相恰好一次带图 HTTP，被 provider 以能力句式拒绝（400；分类是产品做的）。
    const chatCalls = done.wire.filter((request) => request.schemaKind !== "vision");
    const imageCalls = chatCalls.filter((request) => request.carriesImage);
    expect(imageCalls).toHaveLength(1);
    expect(imageCalls[0]?.status).toBe(400);
    expect(imageCalls[0]?.imageShas).toEqual([IMAGE_SHA]);
    // 成功链全部无图：决策重试/评分/生成都是纯文字（降级重试排在带图那次之后）。
    const successCalls = chatCalls.filter((request) => request.status === 200);
    expect(successCalls.length).toBeGreaterThan(0);
    for (const request of successCalls) expect(request.carriesImage).toBe(false);
    // 真实视觉读取恰一次（§9 description 备用经真实 completeMultimodal 叶子），后续相走复用。
    expect(done.wire.filter((request) => request.schemaKind === "vision")).toHaveLength(1);
    // typed 账本：真实 succeeded 行（note 由真实视觉答复写入）——这是发言的合法依据。
    expect(done.readTasks).toEqual([
      { status: "succeeded", attempts: 1, note: "一张合成的灰蓝色方块图" },
    ]);
    // 诊断面：产品判定 model_image_unsupported / MODEL_IMAGE_UNSUPPORTED、actualMode=description。
    const decisionMode = lastModeFor(done.mediaModes, "decision");
    expect(decisionMode?.why).toBe("model_image_unsupported");
    expect(decisionMode?.code).toBe("MODEL_IMAGE_UNSUPPORTED");
    expect(decisionMode?.actualMode).toBe("description");
    expect(decisionMode?.requestedMode).toBe("native");
    // 发言合法发生，但归因是 description：零成功带图调用 ＝ 零 native 消费证明。
    expect(done.sent).toHaveLength(1);
    // 出站正文逐字含合成描述的 text 段（不是「有发送」的长度证明）。
    expect(done.sent[0]?.text).toContain("一张合成的灰蓝色方块图。");
  } catch (error) {
    try {
      writeTrace("np2-error", () => ({
        error: String(error),
        captured: h === null ? null : captureState(h, stub.wire, diagnostics),
      }));
    } catch (traceError) {
      console.error("[NP2] trace 落盘失败（原错误随后原样抛出）:", traceError);
    }
    throw error;
  } finally {
    await stub.close();
  }
}, 120_000);

it("[NP3] with this run's decision stage off the failed read still blocks: a prior success does not stand in for this run's eligibility, zero model calls, zero sends", async () => {
  const diagnostics: Diagnostic[] = [];
  const stub = await startProvider();
  let h: OneBotHarness | null = null;
  try {
    // follow_up 关掉（真实 updateQqScheme 的 triggers 组 CAS，方案本身的合法设置，不是产品
    // 改动）：NP1 那一次真实发送之后，会员再开口的生产分类是 follow_up
    // （adapter.offer：speaker 为 member、已开口过、新消息更晚），而 follow_up 走立即路径、
    // 不受决策相阶段开关管；只有 chiming_in 才带 media_read_failed 闸。关掉它，本例要走的
    // 就是 chiming_in 这条真实分支（其余开关沿用夹具默认全开）。
    // 第二张（内容不同的）图挂在同一会话：字节表覆盖，NP1/2/4 的字节表逐字不变。
    h = createNativeHarness(
      stub.origin,
      diagnostics,
      ["fail"],
      { follow_up: false },
      { [IMAGE_REF]: IMAGE_BYTES, [IMAGE_REF_2]: IMAGE_BYTES_2 },
    );
    expect(setFollowUp(h, false)).toBe(false);
    // 种子 run：真实 typed 失败账本（同 NP1），零发送。
    stub.setDecision(seedDecisionScript());
    h.receive({ id: "1", speaker: "20002", text: "看这张图", image: IMAGE_REF });
    h.advance(INITIATIVE_WAIT_SECONDS);
    await h.activate("chiming_in");

    // 上一 run：凭本 run 自己的原生消费真实发送（run 级消费记账随 run 结束而失效）。
    stub.setDecision(() => ({ body: { ...GENERATE_DECISION } }));
    h.receive({ id: "2", speaker: "20002", text: "那这张呢", replyTo: "1" });
    h.advance(INITIATIVE_WAIT_SECONDS);
    await h.activate("chiming_in");
    await h.deliver();
    expect(h.sent).toHaveLength(1);

    // 本轮当前的失败：**被叫到**的新图（内容与图 1 不同），走 direct_reply 立即路径 ——
    // 只有被叫到这一条才真的执行 media.list/describe（未addressed 的自主路径不会替它
    // 描述），所以这里的 failed 是这条消息自己的真实失败，不是沿用图 1 的旧账。
    // 目标 id 用**图 2 自己那条媒体行**的 id 现查（mediaSegmentsForEvent + mediaNoteRow，
    // 只读），不给桩一个凭空写死的常量：describe 读的就是这一轮这条消息自己的图。
    h.receive({
      id: "3",
      speaker: "20002",
      text: "这张是什么",
      image: IMAGE_REF_2,
      addressed: true,
    });
    const failedKey = eventKeyOfMessage(h, "3");
    const target = imageReadFacts(h, failedKey);
    expect(target.sourceRef).toBe(IMAGE_REF_2);
    stub.setDecision(seedDecisionScript(target.noteId));
    h.advance(INITIATIVE_WAIT_SECONDS);
    // 这条 direct_reply 真实跑完（不判它的闸原因——media_read_failed 闸只属于主动路径，
    // 直接回应路径上它不在同一处判定；这里要证的是这次激活真的发生、且产生了真实失败）。
    const failedRun = await h.activate("direct_reply");
    expect(failedRun).not.toBeNull();
    // 这条失败媒体必须晚于助手最后开口（否则它落在「上次开口之前」的消息里，不属本轮范围）。
    // 事件 key 按 platformMessageId 现查，不复用 h.lastEventSeq 那个缓存值。
    expect(eventKeyOfMessage(h, "3")).toBe(failedKey);
    const facts = imageReadFacts(h, failedKey);
    expect(facts.sourceRef).toBe(IMAGE_REF_2);
    // 三样一起才算「当前媒体的真实失败」：账本 failed、内容身份有 live asset 链、且是这张图。
    expect(facts.task).toEqual({ status: "failed", attempts: 1 });
    expect(facts.assetId).not.toBeNull();
    expect(facts.contentSha256).toBe(IMAGE_SHA_2);
    expect(facts.contentSha256).not.toBe(IMAGE_SHA);
    expect(h.sent).toHaveLength(1);

    // 本 run 关决策相（真实 updateQqScheme CAS）：这条**当前**媒体自己的 failed 行在闸窗口
    // 里，资格回调因 stage off 返回空 → 初始准备即 blocked。本例只主张「上一 run 的成功
    // 不代本轮当前媒体的资格」：stage off 之下本 run 有无消费记录都同样 blocked，纯 Map
    // 隔离在现有 public 接口不可直接观测——本稿不断言（不 hook 造 proof）；stage-on 默认
    // 正常重读的正对照即 NP1（同一历史账本旧场景，说明本 run 能力 flag 必要）。
    expect(setDecisionStage(h, false)).toBe(false);
    const wireMark = stub.wire.length;
    // 触发这一轮的是**未addressed** 的新消息（生产分类自己落到 chiming_in，见上面的
    // follow_up 关闭说明），它回应的正是那张当前失败的图 —— 同一 scope、同内容。
    h.receive({ id: "4", speaker: "20002", text: "还在看这张", image: IMAGE_REF_2 });
    h.advance(INITIATIVE_WAIT_SECONDS);
    // 轮到的确实是**图 2 那条**失败媒体的 chiming_in 机会：消息 4 自己的 throughSeq 用
    // h.observedSeq()（公开的当前观察序列，实读仓库）现取，不用 h.lastEventSeq 那个缓存值。
    expect(eventKeyOfMessage(h, "4")).not.toBe(failedKey);
    expect(
      h.wakes
        .readyParticipants({
          conversationId: h.conversationId,
          cause: "chiming_in",
          at: h.now(),
        })
        .map((opportunity) => opportunity.wake.throughSeq),
    ).toContain(h.observedSeq());
    const blocked = await h.activate("chiming_in");
    const done = captureState(h, stub.wire, diagnostics);
    writeTrace("np3-final", () => done);

    // 真闸结果，不是「没触发」也不是「触发后被别的分支挡下」：非 null 的 blocked 判定，
    // 原因恰是 media_read_failed。
    expect(blocked).toEqual({ status: "no_output", reason: "media_read_failed" });
    // 强负：本 run 零模型调用、零新出站；失败账本行原样保留；无 run 以 failed 收场。
    expect(done.wire.slice(wireMark)).toEqual([]);
    expect(done.sent).toHaveLength(1);
    // 账本：图 1 的旧失败行**仍在**（没有被本轮的成功或任何写入抹掉），本轮当前图 2 的
    // failed 行也仍在；新增只有图 2 那一条，不是零。
    expect(done.readTasks).toContainEqual({ status: "failed", attempts: 1, note: null });
    expect(done.readTasks.filter((row) => row.status === "failed")).toHaveLength(2);
    expect(done.runs.filter((run) => run.status === "failed")).toEqual([]);
  } catch (error) {
    try {
      writeTrace("np3-error", () => ({
        error: String(error),
        captured: h === null ? null : captureState(h, stub.wire, diagnostics),
      }));
    } catch (traceError) {
      console.error("[NP3] trace 落盘失败（原错误随后原样抛出）:", traceError);
    }
    throw error;
  } finally {
    await stub.close();
  }
}, 120_000);

it("[NP4] with the group media capability currently off the failed read still blocks: no eligibility, zero model calls, zero sends", async () => {
  const diagnostics: Diagnostic[] = [];
  const stub = await startProvider();
  let h: OneBotHarness | null = null;
  try {
    h = createNativeHarness(stub.origin, diagnostics, ["fail"]);
    // 种子 run：真实 typed 失败账本（同 NP1），零发送、无 speech —— 失败行留在闸窗口。
    stub.setDecision(seedDecisionScript());
    h.receive({ id: "1", speaker: "20002", text: "看这张图", image: IMAGE_REF });
    h.advance(INITIATIVE_WAIT_SECONDS);
    await h.activate("chiming_in");

    // 当前能力关闭：本群 media 关（updateQqGroupConfig 真实 CAS，纪元 0→1）。本例只主张
    // 「能力当前关闭 → 资格回调空 → blocked」；在飞请求的纪元动态覆盖是 P4 S37_3 已有真面，
    // 本例不另建模板、不主张该语义。
    expect(setGroupMedia(h, true)).toBe(1);
    const wireMark = stub.wire.length;
    // 这一 run 的回复直接引用原图：能力若在，资格回调会暂缓闸（NP1 已证）；撤权后返回空。
    h.receive({ id: "2", speaker: "20002", text: "那这张呢", replyTo: "1" });
    h.advance(INITIATIVE_WAIT_SECONDS);
    const blocked = await h.activate("chiming_in");
    const done = captureState(h, stub.wire, diagnostics);
    writeTrace("np4-final", () => done);

    expect(blocked).toEqual({ status: "no_output", reason: "media_read_failed" });
    // 强负：能力关闭后零模型调用、零发送；失败账本行原样保留。
    expect(done.wire.slice(wireMark)).toEqual([]);
    expect(done.sent).toHaveLength(0);
    expect(done.readTasks).toContainEqual({ status: "failed", attempts: 1, note: null });
  } catch (error) {
    try {
      writeTrace("np4-error", () => ({
        error: String(error),
        captured: h === null ? null : captureState(h, stub.wire, diagnostics),
      }));
    } catch (traceError) {
      console.error("[NP4] trace 落盘失败（原错误随后原样抛出）:", traceError);
    }
    throw error;
  } finally {
    await stub.close();
  }
}, 120_000);

// ---------------------------------------------------------------------------
// B1（留后续，不在本轮 4 例 scope）：生成相 native 流式成功消费观察进 proof。
// runtime 的 stream-consumed 回调（phase generate）在 agent-runtime.ts
// 合流后另派补例：同 run 生成相 native（已知 category／无 envelope）成功流式 HTTP 输出也应进入
// proof——strict permit 在生成相之前，可能仅 decision proof，不在 commit 前伪造资格消费。
// 本稿不实现、不占位。
// ---------------------------------------------------------------------------
