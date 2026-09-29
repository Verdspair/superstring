// HTML → 可读文本（联网抓取的正文提取）。
//
// 管道：linkedom 解析 → @mozilla/readability 抽正文 → turndown 转 Markdown。
// 提取失败（readability 返回 null、turndown 抛错或产物为空）逐级退回：readability 的
// textContent，再退到去脚本后的简单文本化；任何一级都不向外抛出，拿到多少给多少。
//
// charset 只从 Content-Type 解析（缺失或不支持一律 utf-8）；解码使用替换符，不因坏字节崩。

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

/** 文本上限：约 300k 字符，超出截断。 */
export const MAX_EXTRACTED_CHARS = 300_000;

const CHARSET_ALIASES: Readonly<Record<string, string>> = {
  "utf-8": "utf-8",
  utf8: "utf-8",
  "unicode-1-1-utf-8": "utf-8",
  gb2312: "gb18030",
  gbk: "gb18030",
  "x-gbk": "gb18030",
  gb18030: "gb18030",
  big5: "big5",
  "big5-hkscs": "big5",
  "cn-big5": "big5",
  latin1: "latin1",
  "iso-8859-1": "latin1",
  "iso8859-1": "latin1",
  "windows-1252": "latin1",
};

/** Content-Type 里的 charset → TextDecoder 标签；缺失、不支持或非法一律 utf-8。 */
export function charsetFromContentType(contentType: string | null | undefined): string {
  const match = /charset\s*=\s*["']?\s*([^"'\s;]+)/i.exec(contentType ?? "");
  const label = match?.[1]?.toLowerCase() ?? "";
  return CHARSET_ALIASES[label] ?? "utf-8";
}

/** 按 Content-Type 的 charset 解码字节；坏字节按替换符处理，不抛错。 */
export function decodeHtml(bytes: Uint8Array, contentType?: string | null): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charsetFromContentType(contentType));
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

export interface ExtractedText {
  readonly title?: string;
  readonly text: string;
}

const EMPTY_NODE_SELECTOR = "script, style, noscript, template, iframe, svg";

function cleanTitle(value: string | null | undefined): string | undefined {
  const title = value?.replace(/\s+/g, " ").trim() ?? "";
  return title === "" ? undefined : title;
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clampText(value: string): string {
  return value.length > MAX_EXTRACTED_CHARS ? value.slice(0, MAX_EXTRACTED_CHARS) : value;
}

// linkedom 对空文档或纯片段文档的 head/body/title getter 会抛错（documentElement 为 null），
// 这里全部兜住：拿不到就当没有。
function safeTitle(document: Document): string | undefined {
  try {
    return cleanTitle(document.title);
  } catch {
    return undefined;
  }
}

function safeBodyText(document: Document): string {
  try {
    const body = document.body?.textContent ?? "";
    if (body.trim() !== "") return normalizeText(body);
    return normalizeText(document.documentElement?.textContent ?? "");
  } catch {
    return "";
  }
}

/** 解析并提取正文；标题取 readability 结果，退回 <title>。 */
export function extractReadable(html: string): ExtractedText {
  const { document } = parseHTML(html) as unknown as { document: Document };
  // 兜底文本要在 readability 之前取：readability 会就地改写文档，之后 body 已不是原样。
  // 顺手移除脚本类节点——readability 自己也会移除，先做不改变它的输入语义。
  for (const element of document.querySelectorAll(EMPTY_NODE_SELECTOR)) element.remove();
  const fallback = safeBodyText(document);
  let article: {
    title?: string | null;
    content?: string | null;
    textContent?: string | null;
  } | null = null;
  try {
    article = new Readability(document).parse();
  } catch {
    article = null;
  }
  const title = cleanTitle(article?.title) ?? safeTitle(document);
  if (article?.content) {
    try {
      const markdown = normalizeText(
        new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(
          article.content,
        ),
      );
      if (markdown !== "") return { title, text: clampText(markdown) };
    } catch {
      /* 转 Markdown 失败就继续退回 textContent / 简单文本 */
    }
  }
  if (article?.textContent !== undefined && article.textContent !== null) {
    const plain = normalizeText(article.textContent);
    if (plain !== "") return { title, text: clampText(plain) };
  }
  return { title, text: clampText(fallback) };
}
