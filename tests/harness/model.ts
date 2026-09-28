// P0 离线验收环境（0.4.0）：脚本化模型桩。
//
// 它按"下一步该回什么"驱动整链，并把每次调用原样记下来：模型名、消息条数、声明的工具、
// 是否带结构化 schema、首条 system 的开头。脚本用尽、或步骤与调用类型不符时抛**带码错误**
// ——写错的场景必须吵，不能静默退化成"这轮没有输出"。
//
// 辅助调用（记忆挑选、资料挑选、压缩这类带 responseSchema 的叶子调用）不在脚本里时按空结果
// 应答并记成 auxiliary：它们本来就是可选材料，取不到只该留下诊断，不该打死整轮。

import type { ModelPort, ModelRequest, MultimodalRequest } from "../../src/server/agent/model-port";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";

export type ModelStep =
  | { readonly kind: "none" }
  | {
      readonly kind: "invoke";
      readonly name: string;
      readonly arguments?: Record<string, unknown>;
    }
  | {
      readonly kind: "inline";
      readonly targetId: string;
      readonly text: string;
      readonly stickerIds?: readonly string[] | null;
    }
  | {
      readonly kind: "generate";
      readonly targetId: string;
      readonly instructions?: string;
      readonly stickerIds?: readonly string[] | null;
    }
  | {
      /** 一次决策为多个目标各出一份生成草稿（同一轮里"人人有份"）。 */
      readonly kind: "generate_many";
      readonly targetIds: readonly string[];
      readonly instructions?: string;
    }
  | { readonly kind: "score"; readonly score: number; readonly reason?: string }
  | { readonly kind: "say"; readonly text: string; readonly onYield?: () => void }
  | { readonly kind: "raw"; readonly text: string };

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
): ModelStep => ({
  kind: "inline",
  targetId,
  text,
  ...(stickerIds === undefined ? {} : { stickerIds }),
});

export const decideGenerate = (
  targetId: string,
  instructions = "respond",
  stickerIds?: readonly string[] | null,
): ModelStep => ({
  kind: "generate",
  targetId,
  instructions,
  ...(stickerIds === undefined ? {} : { stickerIds }),
});

/** 一次决策为多个目标各出一份生成草稿。 */
export const decideGenerateMany = (
  targetIds: readonly string[],
  instructions = "respond",
): ModelStep => ({ kind: "generate_many", targetIds, instructions });

/** 判断档的答复；`score` 走 `responseSchema` 里带 score 的那次调用。 */
export const scoreOf = (score: number, reason?: string): ModelStep => ({
  kind: "score",
  score,
  ...(reason === undefined ? {} : { reason }),
});

/**
 * 生成档/媒体档的正文。
 *
 * `onYield` 在流式输出的**第一段之后**执行一次：用来模拟"正文还没写完，群里又来了消息"，
 * 这类时序在真实链路里很常见，而它正好检验"新观测是否真的把这一轮拉回决策"。
 */
export const say = (text: string, onYield?: () => void): ModelStep => ({
  kind: "say",
  text,
  ...(onYield === undefined ? {} : { onYield }),
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

export interface ScriptedModel {
  readonly port: ModelPort;
  readonly calls: ModelCallRecord[];
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

export function scriptedModel(steps: readonly ModelStep[]): ScriptedModel {
  const queue = [...steps];
  const calls: ModelCallRecord[] = [];
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
      if (isDecisionRequest(request)) {
        record("next", request);
        return decisionText(
          take("next", ["none", "invoke", "inline", "generate", "generate_many", "raw"]),
        );
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
    remaining: () => queue.length,
    push: (steps) => void queue.push(...steps),
  };
}
