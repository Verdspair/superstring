// P0 离线验收环境（0.4.0）：脚本化模型桩。
//
// 它按"下一步该回什么"驱动整链，并把每次调用原样记下来：模型名、消息条数、声明的工具、
// 是否带结构化 schema、首条 system 的开头。脚本用尽、或步骤与调用类型不符时抛**带码错误**
// ——写错的场景必须吵，不能静默退化成"这轮没有输出"。
//
// 辅助调用（记忆挑选、资料挑选、压缩这类带 responseSchema 的叶子调用）不在脚本里时按空结果
// 应答并记成 auxiliary：它们本来就是可选材料，取不到只该留下诊断，不该打死整轮。

import type { ModelPort, ModelRequest, MultimodalRequest } from "../../src/server/agent/model-port";
import type { ModelMediaClassification } from "../../src/server/agent/model-response-envelope";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";

export type ModelStep =
  | { readonly kind: "none"; readonly media?: readonly ModelMediaClassification[] }
  | {
      readonly kind: "invoke";
      readonly name: string;
      readonly arguments?: Record<string, unknown>;
      readonly media?: readonly ModelMediaClassification[];
    }
  | {
      readonly kind: "inline";
      readonly targetId: string;
      readonly text: string;
      readonly stickerIds?: readonly string[] | null;
      readonly media?: readonly ModelMediaClassification[];
      /** 显式 @ 的成员号；宿主编码为 at 段，不给＝不 @（无 auto-at）。 */
      readonly mentions?: readonly string[];
    }
  | {
      readonly kind: "generate";
      readonly targetId: string;
      readonly instructions?: string;
      readonly stickerIds?: readonly string[] | null;
      readonly media?: readonly ModelMediaClassification[];
      readonly mentions?: readonly string[];
    }
  | {
      /** 一次决策为多个目标各出一份生成草稿（同一轮里"人人有份"）。 */
      readonly kind: "generate_many";
      readonly targetIds: readonly string[];
      readonly instructions?: string;
      readonly media?: readonly ModelMediaClassification[];
    }
  | {
      /**
       * 阶段一批量评分（QQ_BATCH_JUDGEMENT_RESPONSE_SCHEMA 的答复）：逐候选
       * {targetId,score,intent,sourceSeqs}。引用/覆盖是否属实由宿主核验——桩只按批准协议
       * 输出形状，不复刻生产的 range 校验与缓存。
       */
      readonly kind: "batch";
      readonly evaluations: readonly {
        readonly targetId: string;
        readonly score: number;
        readonly intent: string;
        readonly sourceSeqs: readonly number[];
      }[];
      readonly media?: readonly ModelMediaClassification[];
    }
  | {
      readonly kind: "score";
      readonly score: number;
      readonly reason?: string;
      readonly media?: readonly ModelMediaClassification[];
    }
  | {
      readonly kind: "say";
      readonly text: string;
      readonly onYield?: () => void;
      readonly media?: readonly ModelMediaClassification[];
    }
  | {
      readonly kind: "raw";
      readonly text: string;
      /** raw 永不包装（逐字输出用于负测）；字段只为各 variant 形状一致。 */
      readonly media?: readonly ModelMediaClassification[];
    };

export const decideNone = (): ModelStep => ({ kind: "none" });

export const decideInvoke = (name: string, args: Record<string, unknown> = {}): ModelStep => ({
  kind: "invoke",
  name,
  arguments: args,
});

export const decideInline = (
  targetId: string,
  text: string,
  stickerIds?: readonly string[] | null,
  media?: readonly ModelMediaClassification[],
  mentions?: readonly string[],
): ModelStep => ({
  kind: "inline",
  targetId,
  text,
  ...(stickerIds === undefined ? {} : { stickerIds }),
  ...(media === undefined ? {} : { media }),
  ...(mentions === undefined ? {} : { mentions }),
});

export const decideGenerate = (
  targetId: string,
  instructions = "respond",
  stickerIds?: readonly string[] | null,
  media?: readonly ModelMediaClassification[],
  mentions?: readonly string[],
): ModelStep => ({
  kind: "generate",
  targetId,
  instructions,
  ...(stickerIds === undefined ? {} : { stickerIds }),
  ...(media === undefined ? {} : { media }),
  ...(mentions === undefined ? {} : { mentions }),
});

/** 一次决策为多个目标各出一份生成草稿。 */
export const decideGenerateMany = (
  targetIds: readonly string[],
  instructions = "respond",
): ModelStep => ({ kind: "generate_many", targetIds, instructions });

/** 阶段一批量评分的答复：每个本批冻结候选一项，逐字按批准协议形状输出。 */
export const batchScore = (
  evaluations: readonly {
    targetId: string;
    score: number;
    intent: string;
    sourceSeqs: readonly number[];
  }[],
): ModelStep => ({ kind: "batch", evaluations });

/** 判断档的答复；`score` 走 `responseSchema` 里带 score 的那次调用。 */
export const scoreOf = (
  score: number,
  reason?: string,
  media?: readonly ModelMediaClassification[],
): ModelStep => ({
  kind: "score",
  score,
  ...(reason === undefined ? {} : { reason }),
  ...(media === undefined ? {} : { media }),
});

/**
 * 生成档/媒体档的正文。
 *
 * `onYield` 在流式输出的**第一段之后**执行一次：用来模拟"正文还没写完，群里又来了消息"，
 * 这类时序在真实链路里很常见，而它正好检验"新观测是否真的把这一轮拉回决策"。
 */
export const say = (
  text: string,
  onYield?: () => void,
  media?: readonly ModelMediaClassification[],
): ModelStep => ({
  kind: "say",
  text,
  ...(onYield === undefined ? {} : { onYield }),
  ...(media === undefined ? {} : { media }),
});

/** 原样返回的文本：用来构造"形状不对的答复"这类失败场景。 */
export const rawText = (text: string): ModelStep => ({ kind: "raw", text });

export interface ModelCallRecord {
  readonly phase: "next" | "generate" | "vision" | "auxiliary";
  readonly model: string | null;
  readonly messages: number;
  readonly tools: readonly string[];
  readonly schema: boolean;
  /** 首条消息的文本开头（提示词组成的断言用）；媒体档记的是 prompt。 */
  readonly head: string;
  /**
   * 这次调用里全部文本的拼接（截断到 4000 字符）：用来断言"某个事实确实进了上下文"，
   * 例如媒体说明、记忆更正后的正文。图片字节不入此串。
   */
  readonly text: string;
}

/** 一次调用的完整原生输入快照：按 phase 记录、整棵深拷贝（含 image part 元数据）。 */
export interface ModelCallMessages {
  readonly phase: ModelCallRecord["phase"];
  readonly messages: ModelMessage[];
}

export interface ScriptedModel {
  readonly port: ModelPort;
  readonly calls: ModelCallRecord[];
  /**
   * 每次 complete/stream 的完整消息深拷贝（structuredClone，含 image part 的来源元数据）。
   * 不是字节/URL：原生记录的 red line 与 ModelContent 一致——只保 sourceId/revision 等来源事实。
   */
  readonly receivedMessages: ModelCallMessages[];
  remaining(): number;
  /** 追加脚本步骤：一轮跑完还要再跑一轮的场景（崩溃重排、二次唤醒）用得上。 */
  push(steps: readonly ModelStep[]): void;
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** 文本类阶段（生成、媒体、原样答复）的步骤取值。 */
function textOf(step: ModelStep): string {
  if (step.kind === "say" || step.kind === "raw") return step.text;
  throw coded("HARNESS_STEP_MISMATCH", `该阶段不能消费 ${step.kind} 步骤`);
}

function firstText(messages: readonly ModelMessage[]): string {
  for (const message of messages) {
    for (const part of message.content) if (part.kind === "text") return part.text;
  }
  return "";
}

function joinedText(messages: readonly ModelMessage[]): string {
  return messages
    .flatMap((message) =>
      message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
    )
    .join("\n");
}

/** 决策步的判据：带着动作声明，或带着上下文引擎那句固定的决策协议说明。 */
function isDecisionRequest(request: ModelRequest): boolean {
  if ((request.tools?.length ?? 0) > 0) return true;
  return firstText(request.messages).includes("Return exactly one JSON decision");
}

function schemaHas(request: ModelRequest, key: string): boolean {
  return JSON.stringify(request.responseSchema ?? {}).includes(`"${key}"`);
}

/**
 * 同响应封装的 schema 判据（规格 §10）：响应 schema 的**顶层 properties**里明确声明了
 * `decision`/`scoreResult`/`text` 之一与 `media` 时，桩按对应 envelope 形状答复——形状与
 * `model-response-envelope` 的现 parser 一一对应（不猜关键词、不看嵌套描述字段）。`raw`
 * 故障文本照旧逐字输出，不包 envelope 掩盖坏形状；分类是否被接受由消费侧权威解析器裁决，
 * 桩不自己新增白名单规则。
 */
function envelopeOf(request: ModelRequest): "decision" | "scoreResult" | "text" | null {
  const properties = request.responseSchema?.properties;
  const names =
    properties !== null && typeof properties === "object" && !Array.isArray(properties)
      ? Object.keys(properties as Record<string, unknown>)
      : [];
  // decision envelope 的 JSON schema 是 oneOf 决策分支（无顶层 properties）——扫描分支里的
  // 附属 media 键，形状与 model-response-envelope 的 parser 一一对应，不猜关键词。
  const branchNames =
    (request.responseSchema?.oneOf as Record<string, unknown>[] | undefined)?.flatMap((branch) =>
      branch.properties !== null && typeof branch.properties === "object"
        ? Object.keys(branch.properties as Record<string, unknown>)
        : [],
    ) ?? [];
  if (!names.includes("media") && !branchNames.includes("media")) return null;
  if (names.includes("decision") || branchNames.includes("kind")) return "decision";
  if (names.includes("scoreResult")) return "scoreResult";
  if (names.includes("text")) return "text";
  return null;
}

type DecisionStep = Extract<
  ModelStep,
  { kind: "none" | "invoke" | "inline" | "generate" | "generate_many" }
>;

/** envelope 里 media 未给时输出 `[]`：schema 声明了 media，答复就带上这个键。 */
function decisionEnvelopeOf(step: DecisionStep, decisionJson: string): string {
  // envelope 分支经 AgentDecisionSchema 严格校验：outputs 的 stickerIds 是 required（override
  // 规则）——脚本未给时补 []（明确不选），与 plain 路径 normalizeInvoke 的宽容不同。
  const withStickerIds = (outputs: readonly Record<string, unknown>[]) =>
    outputs.map((output) => ({ stickerIds: [], ...output }));
  const decision = JSON.parse(decisionJson) as Record<string, unknown>;
  // envelope 分支产出权威形状（AgentDecisionSchema 只认批量 calls，不经 normalizeInvoke）：
  // 旧单调用 {kind:"invoke",name,arguments} 在这里换成 calls:[{name,arguments}]。
  // plain 决策（decisionText 原样返回）保持旧单调用形状，由产品链 normalizeInvoke 归一。
  if (
    decision.kind === "invoke" &&
    typeof decision.name === "string" &&
    !Array.isArray(decision.calls)
  ) {
    return JSON.stringify({
      decision: {
        kind: "invoke",
        calls: [{ name: decision.name, arguments: decision.arguments ?? {} }],
      },
      media: step.media ?? [],
    });
  }
  if (decision.kind === "final" && Array.isArray(decision.outputs))
    decision.outputs = withStickerIds(decision.outputs as Record<string, unknown>[]);
  return JSON.stringify({ decision, media: step.media ?? [] });
}

function scoreEnvelopeOf(step: Extract<ModelStep, { kind: "score" }>): string {
  return JSON.stringify({
    scoreResult: {
      score: step.score,
      ...(step.reason === undefined ? {} : { reason: step.reason }),
    },
    media: step.media ?? [],
  });
}

function textEnvelopeOf(step: Extract<ModelStep, { kind: "say" }>): string {
  return JSON.stringify({ text: step.text, media: step.media ?? [] });
}

export function scriptedModel(steps: readonly ModelStep[]): ScriptedModel {
  const queue = [...steps];
  const calls: ModelCallRecord[] = [];
  const received: ModelCallMessages[] = [];
  const take = (
    phase: ModelCallRecord["phase"],
    expected: readonly ModelStep["kind"][],
  ): ModelStep => {
    const step = queue[0];
    if (!step)
      throw coded(
        "HARNESS_SCRIPT_EXHAUSTED",
        `第 ${calls.length + 1} 次调用（${phase}）没有对应脚本步骤`,
      );
    if (!expected.includes(step.kind))
      throw coded(
        "HARNESS_STEP_MISMATCH",
        `${phase} 阶段期望 ${expected.join("/")}，脚本下一步是 ${step.kind}`,
      );
    queue.shift();
    return step;
  };
  const record = (
    phase: ModelCallRecord["phase"],
    request: ModelRequest,
    head?: string,
    body?: string,
  ): void => {
    // 每个调用计一次 phase；完整消息整棵深拷贝（图片只有来源元数据，没有 bytes/url）。
    received.push({
      phase,
      messages: structuredClone(request.messages) as ModelMessage[],
    });
    calls.push({
      phase,
      model: request.model ?? null,
      messages: request.messages.length,
      tools: (request.tools ?? []).map((tool) => tool.name),
      schema: request.responseSchema !== undefined,
      head: (head ?? firstText(request.messages)).slice(0, 120),
      text: (body ?? joinedText(request.messages)).slice(0, 4000),
    });
  };
  const decisionText = (step: ModelStep): string => {
    if (step.kind === "none") return JSON.stringify({ kind: "none" });
    if (step.kind === "invoke")
      return JSON.stringify({ kind: "invoke", name: step.name, arguments: step.arguments ?? {} });
    if (step.kind === "inline")
      return JSON.stringify({
        kind: "final",
        outputs: [
          {
            kind: "inline",
            targetId: step.targetId,
            text: step.text,
            ...(step.stickerIds === undefined ? {} : { stickerIds: step.stickerIds }),
            ...(step.mentions === undefined ? {} : { mentionIds: step.mentions }),
          },
        ],
      });
    if (step.kind === "generate")
      return JSON.stringify({
        kind: "final",
        outputs: [
          {
            kind: "generate",
            targetId: step.targetId,
            instructions: step.instructions ?? "respond",
            ...(step.stickerIds === undefined ? {} : { stickerIds: step.stickerIds }),
            ...(step.mentions === undefined ? {} : { mentionIds: step.mentions }),
          },
        ],
      });
    if (step.kind === "generate_many")
      return JSON.stringify({
        kind: "final",
        outputs: step.targetIds.map((targetId) => ({
          kind: "generate",
          targetId,
          instructions: step.instructions ?? "respond",
        })),
      });
    if (step.kind === "raw") return step.text;
    throw coded("HARNESS_STEP_MISMATCH", `决策阶段不能消费 ${step.kind} 步骤`);
  };
  const port: ModelPort = {
    async complete(request) {
      // resolved 真源模拟：与生产网关同语义——模型解析后即回写（默认 request.model）。
      request.onModelResolved?.(request.model ?? "judge-model");
      const envelope = envelopeOf(request);
      if (envelope === "scoreResult") {
        // 评分同响应封装：仍按 next 计一次、score 步骤只消费一次；raw 照旧逐字输出。
        record("next", request);
        const step = take("next", ["score", "raw"]);
        return step.kind === "score" ? scoreEnvelopeOf(step) : textOf(step);
      }
      if (schemaHas(request, "evaluations")) {
        // 阶段一批量评分：纯 JSON 答复（无 envelope 包装）；raw 照旧逐字输出做负测。
        record("next", request);
        const step = take("next", ["batch", "raw"]);
        return step.kind === "batch"
          ? JSON.stringify({ evaluations: step.evaluations })
          : textOf(step);
      }
      if (schemaHas(request, "score")) {
        record("next", request);
        const step = take("next", ["score", "raw"]);
        return step.kind === "score"
          ? JSON.stringify({
              score: step.score,
              ...(step.reason === undefined ? {} : { reason: step.reason }),
            })
          : textOf(step);
      }
      if (isDecisionRequest(request) || envelope === "decision") {
        record("next", request);
        const step = take("next", ["none", "invoke", "inline", "generate", "generate_many", "raw"]);
        // raw 是故意构造的坏形状：逐字输出，envelope 不包装、不遮丑。
        if (step.kind === "raw") return step.text;
        const decisionJson = decisionText(step);
        return envelope === "decision"
          ? decisionEnvelopeOf(step as DecisionStep, decisionJson)
          : decisionJson;
      }
      if (envelope === "text") {
        // 结构化生成 complete（未知分类随同一次调用返回）：计 generate，不落 auxiliary；
        // 脚本步骤只消费一次。这里没有真实的流式中段，`onYield` 的等价触发点是
        // **正文产生之后、返回之前**，恰一次（与流式"两段之间"同义，别多消费队列）。
        record("generate", request);
        const step = take("generate", ["say", "raw"]);
        if (step.kind === "raw") return textOf(step);
        if (step.kind !== "say")
          throw coded("HARNESS_STEP_MISMATCH", `生成阶段不能消费 ${step.kind} 步骤`);
        const body = textEnvelopeOf(step);
        step.onYield?.();
        return body;
      }
      record("auxiliary", request);
      const next = queue[0];
      if (next?.kind === "say" || next?.kind === "raw")
        return textOf(take("auxiliary", ["say", "raw"]));
      // 可选材料：给一个形状合法的空答复，让调用方按"没取到"处理（并留下诊断）。
      return schemaHas(request, "ids") ? JSON.stringify({ ids: [] }) : "{}";
    },
    async *streamText(request) {
      record("generate", request);
      const step = take("generate", ["say", "raw"]);
      if (step.kind !== "say" && step.kind !== "raw")
        throw coded("HARNESS_STEP_MISMATCH", `生成阶段不能消费 ${step.kind} 步骤`);
      const text = step.text;
      // 分两段产出，确保流式拼接真的被走到；`onYield` 落在两段之间（此时正文还没写完）。
      const half = Math.ceil(text.length / 2);
      yield text.slice(0, half);
      if (step.kind === "say") step.onYield?.();
      yield text.slice(half);
    },
    async completeMultimodal(request: MultimodalRequest) {
      record(
        "vision",
        {
          messages: [],
          prompt: request.prompt,
          model: request.model,
        } as unknown as ModelRequest,
        request.prompt,
        request.prompt,
      );
      return textOf(take("vision", ["say", "raw"]));
    },
  };
  return {
    port,
    calls,
    receivedMessages: received,
    remaining: () => queue.length,
    push: (steps) => void queue.push(...steps),
  };
}
