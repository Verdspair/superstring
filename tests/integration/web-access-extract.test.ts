// HTML → 可读文本的提取与 charset 解码。全离线：合成文章、GBK 字节样例。

import { describe, expect, it } from "bun:test";
import {
  charsetFromContentType,
  decodeHtml,
  extractReadable,
  MAX_EXTRACTED_CHARS,
} from "../../src/server/web-access/extract";

const articleHtml = `<html><head><title>页面标题 - 示例站</title>
<script>window.secret = "脚本不该出现";</script>
<style>.hidden { display: none; }</style>
</head><body>
<nav>导航不该出现</nav>
<article>
  <h1>文章主标题</h1>
  <p>这是第一段正文，包含足够多的字符来通过正文抽取阈值。这是第一段正文，包含足够多的字符来通过正文抽取阈值。</p>
  <p>第二段：更多内容在这里，用于验证多段落的 Markdown 转换。</p>
</article>
<footer>页脚不该出现</footer>
</body></html>`;

describe("HTML 正文提取", () => {
  it("合成文章：标题与正文进入 Markdown，脚本/导航不出现", () => {
    const result = extractReadable(articleHtml);
    expect(result.title).toBe("页面标题 - 示例站");
    expect(result.text).toContain("## 文章主标题");
    expect(result.text).toContain("这是第一段正文");
    expect(result.text).toContain("第二段");
    expect(result.text).not.toContain("脚本不该出现");
    expect(result.text).not.toContain("导航不该出现");
    expect(result.text).not.toContain("页脚不该出现");
  });

  it("提取失败退回简单文本化，标题缺失时不编造", () => {
    const result = extractReadable("<p>没有结构，只有一句中文。</p>");
    expect(result.title).toBe(undefined);
    expect(result.text).toContain("没有结构，只有一句中文。");
  });

  it("空 HTML 不崩，返回空文本", () => {
    const result = extractReadable("");
    expect(result.text).toBe("");
    expect(result.title).toBe(undefined);
  });

  it(`超长正文截断到 ${MAX_EXTRACTED_CHARS} 字符`, () => {
    const long = `<html><head><title>长文</title></head><body><article><p>${"内容".repeat(
      200_000,
    )}</p></article></body></html>`;
    const result = extractReadable(long);
    expect(result.text.length).toBe(MAX_EXTRACTED_CHARS);
  });
});

describe("charset 解码", () => {
  const gbkBytes = (...parts: readonly (readonly number[] | string)[]): Uint8Array => {
    const chunks = parts.map((part) =>
      typeof part === "string" ? new TextEncoder().encode(part) : Uint8Array.from(part),
    );
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };

  it("从 Content-Type 解析 charset：别名、引号、缺失与不支持", () => {
    expect(charsetFromContentType("text/html; charset=utf-8")).toBe("utf-8");
    expect(charsetFromContentType("text/html; charset=GBK")).toBe("gb18030");
    expect(charsetFromContentType("text/html; charset='gb2312'")).toBe("gb18030");
    expect(charsetFromContentType('text/html; charset="Big5"')).toBe("big5");
    expect(charsetFromContentType("text/html; charset=iso-8859-1")).toBe("latin1");
    expect(charsetFromContentType("text/html")).toBe("utf-8");
    expect(charsetFromContentType(undefined)).toBe("utf-8");
    expect(charsetFromContentType("text/html; charset=utf-7")).toBe("utf-8");
  });

  it("GBK 字节样例按声明解码为中文", () => {
    // 标题「中文测试」与正文「你好世界 / 正常」的 GBK 字节。
    const bytes = gbkBytes(
      "<html><head><title>",
      [0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4],
      "</title></head><body><article><h1>",
      [0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7],
      "</h1><p>",
      [0xd5, 0xfd, 0xb3, 0xa3, 0xd7, 0xaa, 0xbb, 0xbb, 0xb1, 0xe0, 0xc2, 0xeb],
      "</p></article></body></html>",
    );
    const html = decodeHtml(bytes, "text/html; charset=GBK");
    expect(html).toContain("中文测试");
    expect(html).toContain("你好世界");
    expect(html).toContain("正常转换编码");
    const result = extractReadable(html);
    expect(result.title).toBe("中文测试");
    expect(result.text).toContain("你好世界");
    expect(result.text).toContain("正常转换编码");
  });

  it("缺失或不支持 charset 时按 utf-8 解码", () => {
    const utf8 = new TextEncoder().encode("中文按 UTF-8 解码");
    expect(decodeHtml(utf8)).toBe("中文按 UTF-8 解码");
    expect(decodeHtml(utf8, "text/html; charset=utf-7")).toBe("中文按 UTF-8 解码");
    expect(decodeHtml(utf8, "text/html; charset=utf-8")).toBe("中文按 UTF-8 解码");
  });

  it("坏字节用替换符处理，不抛错", () => {
    const decoded = decodeHtml(new Uint8Array([0x41, 0xff, 0xfe, 0x0a]), "text/plain");
    expect(decoded.startsWith("A")).toBe(true);
    expect(decoded).toContain("\uFFFD");
  });
});
