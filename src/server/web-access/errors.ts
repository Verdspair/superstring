// 联网能力的错误类型。
//
// 错误码是本模块对调用方的稳定契约：后续工具（web.search / web.fetch）、API 路由与设置页
// 按 code 分支与映射文案，不解析消息文本——消息是给人看的中文说明，可以改，code 不能。
// 本单元不新增 src/shared 契约，码只在 web-access 内部与调用方之间约定。

export interface WebAccessAttempt {
  readonly channel: string;
  readonly code: string;
  readonly message: string;
}

export interface WebAccessErrorOptions {
  readonly cause?: unknown;
  /** 多通道尝试失败时的结构化明细（如 searxng → bing 的回退链）。 */
  readonly attempts?: readonly WebAccessAttempt[];
}

export class WebAccessError extends Error {
  readonly code: string;
  readonly attempts?: readonly WebAccessAttempt[];

  constructor(code: string, message: string, options: WebAccessErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WebAccessError";
    this.code = code;
    if (options.attempts !== undefined) this.attempts = options.attempts;
  }
}

export function webError(
  code: string,
  message: string,
  options: WebAccessErrorOptions = {},
): WebAccessError {
  return new WebAccessError(code, message, options);
}
