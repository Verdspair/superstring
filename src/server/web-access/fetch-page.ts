// 受控抓取：页面抓取唯一的外发入口。
//
// - redirect: "manual"，最多 3 跳；每一跳都重新过 ssrf 校验（相对 Location 按当前 URL 解析）。
// - 总超时 20s 与调用方 signal 组合，取消立即中止；计时器跨跳共用，不是每跳一份。
// - 响应体读取上限 2MiB，超限中止读取并标记 truncated。
// - Content-Type 决定处理方式：html → 正文提取；text/*、application/json、application/xml
//    → 原样文本；其余明确拒绝。缺失 Content-Type 按纯文本处理（比按 HTML 解析更保守）。

import { webError } from "./errors";
import { decodeHtml, extractReadable, MAX_EXTRACTED_CHARS } from "./extract";
import { type CappedBody, deadline, readBodyCapped, throwFetchFailure } from "./http";
import { assertSafeUrl, type UrlSafetyOptions } from "./ssrf";

export const FETCH_TIMEOUT_MS = 20_000;
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECT_HOPS = 3;
export const FETCH_USER_AGENT = "Superstring (+https://github.com/Verdspair/superstring)";
export const FETCH_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export type PageContentKind = "html" | "text" | "json" | "xml";

export interface FetchedPage {
  readonly finalUrl: string;
  readonly title?: string;
  readonly text: string;
  readonly contentKind: PageContentKind;
  readonly truncated: boolean;
}

export interface FetchPageOptions extends UrlSafetyOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

function classifyContent(mime: string): PageContentKind | null {
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/json") return "json";
  if (mime === "application/xml") return "xml";
  return null;
}

export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = deadline(options.signal, options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const maxBytes = options.maxBytes ?? FETCH_MAX_BYTES;
  let current = await assertSafeUrl(url, options);
  for (let hop = 0; ; hop++) {
    options.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetchImpl(current.href, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": FETCH_USER_AGENT,
          "accept-language": FETCH_ACCEPT_LANGUAGE,
        },
        signal: target.signal,
      });
    } catch (error) {
      throwFetchFailure(error, options.signal, target, "WEB_FETCH_FAILED", "网页请求");
    }
    options.signal?.throwIfAborted();
    if (REDIRECT_STATUS.has(response.status)) {
      if (hop >= MAX_REDIRECT_HOPS)
        throw webError(
          "WEB_TOO_MANY_REDIRECTS",
          `重定向超过 ${MAX_REDIRECT_HOPS} 跳：${current.href}`,
        );
      const location = response.headers.get("location");
      if (location === null || location === "")
        throw webError("WEB_FETCH_FAILED", `重定向响应缺少 Location：${current.href}`);
      await response.body?.cancel().catch(() => {});
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw webError("WEB_URL_INVALID", `重定向到非法 URL：${location}`);
      }
      current = await assertSafeUrl(next, options);
      continue;
    }
    if (!response.ok) throw webError("WEB_FETCH_FAILED", `网页请求失败：HTTP ${response.status}`);
    let body: CappedBody;
    try {
      body = await readBodyCapped(response, maxBytes);
    } catch (error) {
      throwFetchFailure(error, options.signal, target, "WEB_FETCH_FAILED", "读取网页响应");
    }
    const contentType = response.headers.get("content-type") ?? "";
    const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    const kind = mime === "" ? "text" : classifyContent(mime);
    if (kind === null) throw webError("WEB_UNSUPPORTED_CONTENT", `不支持的内容类型：${mime}`);
    const decoded = decodeHtml(body.bytes, contentType);
    if (kind === "html") {
      const article = extractReadable(decoded);
      return {
        finalUrl: current.href,
        title: article.title,
        text: article.text,
        contentKind: "html",
        truncated: body.truncated,
      };
    }
    const text =
      decoded.length > MAX_EXTRACTED_CHARS ? decoded.slice(0, MAX_EXTRACTED_CHARS) : decoded;
    return { finalUrl: current.href, text, contentKind: kind, truncated: body.truncated };
  }
}
