// 联网动作（web.search / web.fetch）：核心库到统一工具管线的接线。
//
// 两个动作都声明 effect:"read" 与一条 "web" 授权（revision 固定在动作契约里）；结果是外部数据，
// 有界返回（搜索 ≤ 约 4KB、正文按字符分页），失败映射为 {status:"unavailable"} 工具信封而不是
// 让整轮失败——但调用方取消原样抛出，不误报成工具失败。fetchImpl / resolve / config 可注入，
// 测试全离线。

import {
  type WebToolLimits,
  webToolDescriptions,
  webToolSchemas,
} from "../../shared/contracts/agent-action-descriptions";
import type { PermissionRequirement } from "../../shared/contracts/permissions";
import {
  type ActionContext,
  type BuiltInAction,
  ReadRetryDeadlineError,
} from "../agent/built-in-actions";
import type { WebAccessConfig } from "./config";
import { WebAccessError, webError } from "./errors";
import { FETCH_TIMEOUT_MS, fetchPage } from "./fetch-page";
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SEARCH_TIMEOUT_MS, searchWeb } from "./search";
import type { HostResolver } from "./ssrf";

export const WEB_PERMISSION_RESOURCE = "web";
/** 一条 "web" 授权覆盖两个动作；动作的参数或语义变化时提升这个修订。 */
export const WEB_PERMISSION_REVISION = "web/v1";
/** 搜索结果的序列化上限（约 4KB）：超出从尾部丢弃条目，绝不原样返回整页。 */
export const WEB_SEARCH_RESULT_CHARS = 4_000;
export const WEB_FETCH_DEFAULT_LIMIT = 2_048;
export const WEB_FETCH_MAX_LIMIT = 4_096;
const WEB_SEARCH_URL_CHARS = 512;
const WEB_ERROR_TEXT_CHARS = 400;
/** 运行时限额事实：本文件常量唯一来源，传给共享描述函数（文案里的默认/上限数字来自这里）。 */
const WEB_TOOL_LIMITS: WebToolLimits = {
  searchDefaultLimit: SEARCH_DEFAULT_LIMIT,
  searchMaxLimit: SEARCH_MAX_LIMIT,
  fetchDefaultLimit: WEB_FETCH_DEFAULT_LIMIT,
  fetchMaxLimit: WEB_FETCH_MAX_LIMIT,
};
const SearchSchema = webToolSchemas(WEB_TOOL_LIMITS)["web.search"];
const FetchSchema = webToolSchemas(WEB_TOOL_LIMITS)["web.fetch"];

const WEB_PERMISSION: PermissionRequirement = {
  resource: WEB_PERMISSION_RESOURCE,
  revision: WEB_PERMISSION_REVISION,
  // 只读动作：对照 MCP 只读工具的构造（不逐次等批准）。
  approvalRequired: false,
};

export interface WebAccessActionOptions {
  /** 当前配置读取（searxng 端点）；省略＝未配置，直接走必应。每次执行现读。 */
  readonly config?: () => WebAccessConfig;
  /** 测试注入的网络与 DNS 解析；生产用全局 fetch 与 node:dns。 */
  readonly fetchImpl?: typeof fetch;
  readonly resolve?: HostResolver;
}

/** 按 Unicode 字符截断；用于错误文案与结果 URL 的有界化。 */
export function boundChars(value: string, maxChars: number): string {
  const points = [...value];
  return points.length <= maxChars ? value : points.slice(0, maxChars).join("");
}

/** WebAccessError → 工具失败信封：码、有界文案与结构化尝试明细；不携带页面内容。 */
function unavailable(
  error: WebAccessError,
): Omit<Awaited<ReturnType<BuiltInAction["execute"]>>, "id" | "name"> {
  const attempts = error.attempts?.map((attempt) => ({
    channel: attempt.channel,
    code: attempt.code,
  }));
  return {
    value: {
      status: "unavailable",
      code: error.code,
      message: boundChars(error.message, WEB_ERROR_TEXT_CHARS),
      ...(attempts?.length ? { attempts } : {}),
    },
    sources: [],
  };
}

/** 只有真实 HTTP 429/503 拒收可重试；超时、无 status 的网络失败与 403/404 等确定性失败都不重试。 */
const WEB_HTTP_FAILED_CODES: ReadonlySet<string> = new Set([
  "WEB_SEARCH_FAILED",
  "WEB_FETCH_FAILED",
]);
function isRetryableWebRejection(error: unknown): boolean {
  return (
    error instanceof WebAccessError &&
    WEB_HTTP_FAILED_CODES.has(error.code) &&
    (error.status === 429 || error.status === 503)
  );
}

/** 执行核心库调用：取消原样抛出；WebAccessError 映射为信封；其它错误照旧失败。 */
async function settle<T>(
  context: ActionContext,
  run: () => Promise<T>,
): Promise<Omit<Awaited<ReturnType<BuiltInAction["execute"]>>, "id" | "name">> {
  try {
    return { value: await run(), sources: [] };
  } catch (error) {
    // 取消不是故障：原样抛出调用方的中止原因（核心库同样优先原样抛出）。
    context.signal.throwIfAborted();
    // 重试总时限（含等待）用尽＝原 WEB_TIMEOUT 语义；权限/来源守卫失败照旧原样硬传播。
    if (error instanceof ReadRetryDeadlineError)
      return unavailable(webError("WEB_TIMEOUT", "联网读取总时限（含重试等待）已用尽"));
    if (error instanceof WebAccessError) return unavailable(error);
    throw error;
  }
}

export function createWebActions(options: WebAccessActionOptions = {}): BuiltInAction[] {
  const network = {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.resolve ? { resolve: options.resolve } : {}),
  };
  const search: BuiltInAction = {
    permission: WEB_PERMISSION,
    description: webToolDescriptions(WEB_TOOL_LIMITS)["web.search"],
    async execute(arguments_, context) {
      context.signal.throwIfAborted();
      const input = SearchSchema.parse(arguments_);
      const run = (signal: AbortSignal) =>
        searchWeb(input.query, {
          limit: input.limit ?? SEARCH_DEFAULT_LIMIT,
          ...(options.config !== undefined
            ? { searxngEndpoint: options.config().searxngEndpoint }
            : {}),
          signal,
          ...network,
        });
      return settle(context, async () => {
        // 实际搜索读放进属主重试回调：timeoutMs 用搜索自己的总时限常量（含等待与重试）。
        const result = await (context.runReadWithRetry?.({
          timeoutMs: SEARCH_TIMEOUT_MS,
          operation: run,
          isRetryableRejection: isRetryableWebRejection,
        }) ?? run(context.signal));
        const items: { title: string; url: string; snippet: string }[] = [];
        for (const item of result.items) {
          const candidate = {
            title: item.title,
            url: boundChars(item.url, WEB_SEARCH_URL_CHARS),
            snippet: item.snippet,
          };
          const probe = { status: "ok", channel: result.channel, items: [...items, candidate] };
          if (JSON.stringify(probe).length > WEB_SEARCH_RESULT_CHARS) break;
          items.push(candidate);
        }
        return { status: "ok", channel: result.channel, items };
      });
    },
  };
  const fetchAction: BuiltInAction = {
    permission: WEB_PERMISSION,
    description: webToolDescriptions(WEB_TOOL_LIMITS)["web.fetch"],
    async execute(arguments_, context) {
      context.signal.throwIfAborted();
      const input = FetchSchema.parse(arguments_);
      const run = (signal: AbortSignal, remainingMs: number) =>
        fetchPage(input.url, { signal, timeoutMs: remainingMs, ...network });
      return settle(context, async () => {
        // 实际抓取读放进属主重试回调：总时限用抓取自己的 20s 常量（含等待与重试），
        // 每次尝试只拿剩余预算，不重置整调用 deadline。
        const page = await (context.runReadWithRetry?.({
          timeoutMs: FETCH_TIMEOUT_MS,
          operation: run,
          isRetryableRejection: isRetryableWebRejection,
        }) ?? run(context.signal, FETCH_TIMEOUT_MS));
        const offset = input.offset ?? 0;
        const limit = input.limit ?? WEB_FETCH_DEFAULT_LIMIT;
        // offset/limit 按 Unicode 字符（码点）计；越界返回空文本与 nextOffset:null。
        const points = [...page.text];
        const start = Math.min(offset, points.length);
        const slice = start >= points.length ? [] : points.slice(start, start + limit);
        const end = start + slice.length;
        return {
          status: "ok",
          url: page.finalUrl,
          ...(page.title !== undefined ? { title: page.title } : {}),
          text: slice.join(""),
          offset,
          nextOffset: end < points.length ? end : null,
          ...(page.truncated ? { truncated: true } : {}),
        };
      });
    },
  };
  return [search, fetchAction];
}
