import { z } from "zod";
import { AppError } from "../../errors";

/**
 * 把一次失败的模型/资料来源调用映射成记录用的错误码。两个调用方各自保留自己的
 * "消息即错误码"识别范围：补充资料读取只认 `MODEL_` 前缀，压缩队列还接受调用方
 * 自带的 `code` 字段与其更宽的 `MODEL_` 之外码。
 */
export function failureCode(
  error: unknown,
  rules: { pattern: RegExp; allowErrorCode?: boolean },
): string {
  if (error instanceof AppError) return error.code;
  if (error instanceof DOMException && error.name === "TimeoutError") return "MODEL_TIMEOUT";
  if (error instanceof SyntaxError || error instanceof z.ZodError) return "MODEL_STRUCTURE_INVALID";
  if (
    rules.allowErrorCode &&
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  if (error instanceof Error && rules.pattern.test(error.message)) return error.message;
  return "UNEXPECTED_FAILURE";
}
