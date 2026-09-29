// 搜索适配：SearXNG（JSON 接口）与必应（HTML 解析）两条通道。
//
// searchWeb 是调用入口：配置了 SearXNG 端点就先走 searxng，失败回退 bing；未配置直接 bing；
// 两者都失败抛出带 attempts 明细的错误。端点由用户配置（SearXNG）或固定（必应），
// 不经 ssrf 护栏——SearXNG 允许是用户自己的本机/内网实例。
//
// 标题截断 ≤200、摘要 ≤300 字符；limit 默认 10、上限 15。

import { parseHTML } from "linkedom";
import { type WebAccessAttempt, webError } from "./errors";
import { FETCH_ACCEPT_LANGUAGE, FETCH_USER_AGENT } from "./fetch-page";
import { deadline, readBodyCapped, throwFetchFailure } from "./http";

export const SEARCH_TIMEOUT_MS = 15_000;
export const SEARCH_MAX_BYTES = 1024 * 1024;
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 15;
export const SEARCH_TITLE_CHARS = 200;
export const SEARCH_SNIPPET_CHARS = 300;
export const BING_SEARCH_ENDPOINT = "https://www.bing.com/search";

export interface SearchItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export type SearchChannel = "searxng" | "bing";

export interface SearchResult {
  readonly channel: SearchChannel;
  readonly items: readonly SearchItem[];
}

export interface SearchChannelOptions {
  readonly limit?: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

export interface SearchOptions extends SearchChannelOptions {
  readonly searxngEndpoint?: string;
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SEARCH_DEFAULT_LIMIT;
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** SearXNG：GET {endpoint}/search?q=…&format=json；解析 results[].{title,url,content}。 */
export async function searchSearxng(
  query: string,
  endpoint: string,
  options: SearchChannelOptions = {},
): Promise<readonly SearchItem[]> {
  options.signal?.throwIfAborted();
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = deadline(options.signal, SEARCH_TIMEOUT_MS);
  const url = `${endpoint.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        "user-agent": FETCH_USER_AGENT,
        "accept-language": FETCH_ACCEPT_LANGUAGE,
        accept: "application/json",
      },
      signal: target.signal,
    });
  } catch (error) {
    throwFetchFailure(error, options.signal, target, "WEB_SEARCH_FAILED", "SearXNG 请求");
  }
  if (response.status === 403)
    throw webError(
      "WEB_SEARCH_JSON_DISABLED",
      "SearXNG 实例拒绝了 JSON 请求（HTTP 403）；需在实例设置中开启 json 输出格式",
    );
  if (!response.ok)
    throw webError("WEB_SEARCH_FAILED", `SearXNG 请求失败：HTTP ${response.status}`);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8").decode((await readBodyCapped(response, SEARCH_MAX_BYTES)).bytes);
  } catch (error) {
    throwFetchFailure(error, options.signal, target, "WEB_SEARCH_FAILED", "读取 SearXNG 响应");
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw webError(
      "WEB_SEARCH_JSON_DISABLED",
      "SearXNG 响应不是 JSON；需在实例设置中开启 json 输出格式",
    );
  }
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw webError("WEB_SEARCH_FAILED", "SearXNG 响应缺少 results 数组");
  const limit = resolveLimit(options.limit);
  const items: SearchItem[] = [];
  for (const entry of results) {
    if (items.length >= limit) break;
    const record = entry as { title?: unknown; url?: unknown; content?: unknown };
    const itemUrl = textOf(record.url);
    if (itemUrl === "") continue;
    items.push({
      title: truncate(textOf(record.title), SEARCH_TITLE_CHARS),
      url: itemUrl,
      snippet: truncate(textOf(record.content), SEARCH_SNIPPET_CHARS),
    });
  }
  return items;
}

/** 必应跳转链接（/ck/a?u=a1…）→ 真实目标；解不出来返回 null，由调用方保留原样。 */
export function resolveBingRedirect(href: string): string | null {
  let link: URL;
  try {
    link = new URL(href, "https://www.bing.com/");
  } catch {
    return null;
  }
  if (link.hostname !== "bing.com" && !link.hostname.endsWith(".bing.com")) return null;
  if (!link.pathname.startsWith("/ck/a")) return null;
  const encoded = link.searchParams.get("u");
  if (encoded === null || encoded === "") return null;
  const payload = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
  if (payload === "") return null;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** 必应：GET /search?q=…，解析 li.b_algo 块（标题 h2 a、摘要 .b_caption p 等）。 */
export async function searchBing(
  query: string,
  options: SearchChannelOptions = {},
): Promise<readonly SearchItem[]> {
  options.signal?.throwIfAborted();
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = deadline(options.signal, SEARCH_TIMEOUT_MS);
  const url = `${BING_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        "user-agent": FETCH_USER_AGENT,
        "accept-language": FETCH_ACCEPT_LANGUAGE,
        accept: "text/html",
      },
      signal: target.signal,
    });
  } catch (error) {
    throwFetchFailure(error, options.signal, target, "WEB_SEARCH_FAILED", "必应请求");
  }
  if (!response.ok) throw webError("WEB_SEARCH_FAILED", `必应请求失败：HTTP ${response.status}`);
  let html: string;
  try {
    html = new TextDecoder("utf-8").decode(
      (await readBodyCapped(response, SEARCH_MAX_BYTES)).bytes,
    );
  } catch (error) {
    throwFetchFailure(error, options.signal, target, "WEB_SEARCH_FAILED", "读取必应响应");
  }
  const { document } = parseHTML(html) as unknown as { document: Document };
  const limit = resolveLimit(options.limit);
  const items: SearchItem[] = [];
  for (const block of document.querySelectorAll("li.b_algo")) {
    if (items.length >= limit) break;
    const anchor = block.querySelector("h2 a");
    if (anchor === null) continue;
    const href = anchor.getAttribute("href") ?? "";
    const url = resolveBingRedirect(href) ?? href;
    if (url === "") continue;
    const caption = block.querySelector(".b_caption p") ?? block.querySelector("p");
    items.push({
      title: truncate(textOf(anchor.textContent), SEARCH_TITLE_CHARS),
      url,
      snippet: truncate(textOf(caption?.textContent), SEARCH_SNIPPET_CHARS),
    });
  }
  return items;
}

function attemptOf(channel: SearchChannel, error: unknown): WebAccessAttempt {
  if (error instanceof Error && "code" in error && typeof error.code === "string")
    return { channel, code: error.code, message: error.message };
  return {
    channel,
    code: "WEB_SEARCH_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** 入口：先 SearXNG（若配置了端点）再回退必应；两者都失败抛出错误信封。 */
export async function searchWeb(query: string, options: SearchOptions = {}): Promise<SearchResult> {
  options.signal?.throwIfAborted();
  const limit = resolveLimit(options.limit);
  const attempts: WebAccessAttempt[] = [];
  const endpoint = options.searxngEndpoint?.trim();
  if (endpoint !== undefined && endpoint !== "") {
    try {
      const items = await searchSearxng(query, endpoint, { ...options, limit });
      return { channel: "searxng", items };
    } catch (error) {
      if (options.signal?.aborted === true) throw options.signal.reason ?? error;
      attempts.push(attemptOf("searxng", error));
    }
  }
  options.signal?.throwIfAborted();
  try {
    const items = await searchBing(query, { ...options, limit });
    return { channel: "bing", items };
  } catch (error) {
    if (options.signal?.aborted === true) throw options.signal.reason ?? error;
    attempts.push(attemptOf("bing", error));
  }
  throw webError(
    "WEB_SEARCH_FAILED",
    `搜索失败：${attempts.map((attempt) => `${attempt.channel}（${attempt.message}）`).join("；")}`,
    { attempts },
  );
}
