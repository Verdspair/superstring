// 原生 chat 内容转换。
//
// 为什么是独立模块：completion 与 stream 必须复用同一份 content 转换（规格 §10），而且 text-only
// 的转换要先 type narrow——数组的 content 不能被当成字符串 .trim()。持久化侧的 ModelMessage 图片
// part 只有元数据（sourceId/revision/mimeType/sha256/尺寸）；字节由 ImageByteResolver 在发送边界
// 解析成 data URL，本模块不持有、不缓存、不落日志。
//
// wire 形状 = OpenAI chat 内容数组：{type:"text"} 与 {type:"image_url", image_url:{url}}。

import type { ModelMessage, RunOwner } from "../../shared/contracts/agent-run";
import { AppError } from "../errors";
import type { VisionImage } from "./vision-client";

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: string;
  content: string | ChatContentPart[];
}

/** 发送边界把已解析的图片字节组装成 data URL（只进 wire，不进日志/错误）。 */
export function visionImageDataUrl(image: VisionImage): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;
}

export interface ChatContentResolver {
  resolve(input: {
    runId: string;
    owner: RunOwner;
    part: ModelMessage["content"][number];
    signal: AbortSignal;
  }): Promise<VisionImage>;
}

export interface ChatContentConvertInput {
  messages: readonly ModelMessage[];
  runId?: string;
  owner?: RunOwner;
  imageResolver?: ChatContentResolver;
  signal?: AbortSignal;
}

/**
 * ModelMessage[] → wire ChatMessage[]，按消息逐条判断。
 *
 * - 无 image part 的消息保持字符串 content（旧行为、旧断言不动）；请求里有图片不改变其他消息。
 * - 含 image part 的消息转成有序 [text, image_url, …] 数组；字节经 resolver 按 run/owner 句柄
 *   取得。可信解析器缺失（runId/owner/resolver）或句柄失效是来源/宿主缺陷，按来源错误拒绝
 *   （CONTEXT_SOURCE_INVALID），不是模型不支持，也不允许被当作模型降级处理。
 */
export async function toGatewayMessages(input: ChatContentConvertInput): Promise<ChatMessage[]> {
  return Promise.all(
    input.messages.map(async (message): Promise<ChatMessage> => {
      if (!message.content.some((part) => part.kind === "image")) {
        return {
          role: message.role,
          content: message.content
            .map((part) => {
              if (part.kind !== "text") throw new Error("Use completeMultimodal for image inputs");
              return part.text;
            })
            .join(""),
        };
      }
      if (!input.imageResolver || input.runId === undefined || input.owner === undefined) {
        throw new AppError(
          "CONTEXT_SOURCE_INVALID",
          "图片输入缺少可信来源解析器，无法安全发送（来源/宿主缺陷，不是模型能力问题）",
          409,
        );
      }
      const parts: ChatContentPart[] = [];
      let textBuffer = "";
      const flushText = () => {
        if (textBuffer !== "") {
          parts.push({ type: "text", text: textBuffer });
          textBuffer = "";
        }
      };
      for (const part of message.content) {
        if (part.kind === "text") {
          textBuffer += part.text;
          continue;
        }
        flushText();
        let image: VisionImage;
        try {
          image = await input.imageResolver.resolve({
            runId: input.runId,
            owner: input.owner,
            part,
            signal: input.signal ?? new AbortController().signal,
          });
        } catch (error) {
          if (error instanceof AppError) throw error;
          // caller 取消优先（既有取消语义）：resolver 在 signal.throwIfAborted 抛的就是原 reason，
          // 原样交回，不归宿主失败。
          if (input.signal?.aborted) throw input.signal.reason ?? error;
          // 其余 resolver 拒绝（句柄未登记、来源失效）是来源/宿主缺陷：按来源错误收口，
          // 不是模型不支持，也不允许被当作模型降级处理。
          throw new AppError("CONTEXT_SOURCE_INVALID", "图片来源校验未通过，拒绝发送", 409);
        }
        parts.push({ type: "image_url", image_url: { url: visionImageDataUrl(image) } });
      }
      flushText();
      return { role: message.role, content: parts };
    }),
  );
}
