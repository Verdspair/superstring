// 受控抓取（fetch-page）：重定向、SSRF 复验、体积上限、超时取消与内容类型分派。
// 全离线：fetchImpl 与 DNS 解析器都是注入的假实现，不发真实请求。

import { describe, expect, it } from "bun:test";
import { MAX_EXTRACTED_CHARS } from "../../src/server/web-access/extract";
import {
  FETCH_ACCEPT_LANGUAGE,
  FETCH_MAX_BYTES,
  FETCH_USER_AGENT,
  fetchPage,
  MAX_REDIRECT_HOPS,
} from "../../src/server/web-access/fetch-page";

const publicResolver = async () => ["93.184.216.34"];

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function stubFetch(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? undefined };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const article =
  "<html><head><title>示例标题</title></head><body><article><h1>标题一</h1><p>正文段落内容，足够长以便被正文抽取器保留。正文段落内容，足够长以便被正文抽取器保留。</p></article></body></html>";

describe("fetchPage 正常路径", () => {
  it("抽取 HTML，并固定 UA、Accept-Language 与 manual 重定向", async () => {
    const { calls, fetchImpl } = stubFetch(
      () =>
        new Response(article, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const page = await fetchPage("http://example.com/start", {
      fetchImpl,
      resolve: publicResolver,
    });
    expect(page.finalUrl).toBe("http://example.com/start");
    expect(page.contentKind).toBe("html");
    expect(page.title).toBe("示例标题");
    expect(page.text).toContain("正文段落内容");
    expect(page.truncated).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.redirect).toBe("manual");
    expect(calls[0].init?.method).toBe("GET");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe(FETCH_USER_AGENT);
    expect(headers["accept-language"]).toBe(FETCH_ACCEPT_LANGUAGE);
    expect(FETCH_USER_AGENT).toBe("Superstring (+https://github.com/Verdspair/superstring)");
    expect(calls[0].init?.signal).toBeDefined();
  });

  it("text/json/xml 原样返回并按 charset 解码", async () => {
    const raw = '<root><item a="1"/></root>';
    const { fetchImpl } = stubFetch((call) => {
      if (call.url.endsWith("/data.json"))
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (call.url.endsWith("/data.xml"))
        return new Response(raw, { status: 200, headers: { "content-type": "application/xml" } });
      const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xaa, 0xbb, 0xbb]);
      return new Response(gbk, {
        status: 200,
        headers: { "content-type": "text/plain; charset=gbk" },
      });
    });
    const json = await fetchPage("http://example.com/data.json", {
      fetchImpl,
      resolve: publicResolver,
    });
    expect(json.contentKind).toBe("json");
    expect(json.text).toBe('{"ok":true}');
    expect(json.title).toBe(undefined);
    const xml = await fetchPage("http://example.com/data.xml", {
      fetchImpl,
      resolve: publicResolver,
    });
    expect(xml.contentKind).toBe("xml");
    expect(xml.text).toBe(raw);
    const text = await fetchPage("http://example.com/note.txt", {
      fetchImpl,
      resolve: publicResolver,
    });
    expect(text.contentKind).toBe("text");
    expect(text.text).toBe("中文转换");
  });

  it("二进制内容类型拒绝", async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    expect(
      await codeOf(fetchPage("http://example.com/a.png", { fetchImpl, resolve: publicResolver })),
    ).toBe("WEB_UNSUPPORTED_CONTENT");
  });

  it("HTTP 错误状态归为抓取失败并带状态码", async () => {
    const { fetchImpl } = stubFetch(
      () => new Response("nope", { status: 404, headers: { "content-type": "text/plain" } }),
    );
    try {
      await fetchPage("http://example.com/missing", { fetchImpl, resolve: publicResolver });
      throw new Error("should reject");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("WEB_FETCH_FAILED");
      expect((error as Error).message).toContain("404");
    }
  });
});

describe("fetchPage 重定向与 SSRF 复验", () => {
  it("相对 Location 按当前 URL 解析，每一跳都重新过 SSRF", async () => {
    const { calls, fetchImpl } = stubFetch((call) => {
      if (call.url === "http://example.com/start")
        return new Response(null, { status: 302, headers: { location: "/next" } });
      if (call.url === "http://example.com/next")
        return new Response(null, {
          status: 301,
          headers: { location: "http://example.com/final" },
        });
      return new Response(article, { status: 200, headers: { "content-type": "text/html" } });
    });
    let resolutions = 0;
    const resolve = async () => {
      resolutions++;
      return ["93.184.216.34"];
    };
    const page = await fetchPage("http://example.com/start", { fetchImpl, resolve });
    expect(page.finalUrl).toBe("http://example.com/final");
    expect(page.title).toBe("示例标题");
    expect(calls.map((call) => call.url)).toEqual([
      "http://example.com/start",
      "http://example.com/next",
      "http://example.com/final",
    ]);
    expect(resolutions).toBe(3);
  });

  it("重定向到私网地址被拒（IP 字面量与 DNS 两条路径）", async () => {
    const literal = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/admin" } }),
    );
    expect(
      await codeOf(
        fetchPage("http://example.com/", { fetchImpl: literal.fetchImpl, resolve: publicResolver }),
      ),
    ).toBe("WEB_BLOCKED_ADDRESS");
    expect(literal.calls).toHaveLength(1);

    const privateDns = stubFetch(() => {
      const url = "http://internal.example/secret";
      return new Response(null, { status: 302, headers: { location: url } });
    });
    const resolve = async (hostname: string) =>
      hostname === "internal.example" ? ["192.168.1.10"] : ["93.184.216.34"];
    expect(
      await codeOf(fetchPage("http://example.com/", { fetchImpl: privateDns.fetchImpl, resolve })),
    ).toBe("WEB_BLOCKED_ADDRESS");
  });

  it("重定向到非 http 协议被拒", async () => {
    const { fetchImpl } = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "ftp://example.com/x" } }),
    );
    expect(
      await codeOf(fetchPage("http://example.com/", { fetchImpl, resolve: publicResolver })),
    ).toBe("WEB_URL_BLOCKED");
  });

  it(`超过 ${MAX_REDIRECT_HOPS} 跳拒绝`, async () => {
    const { calls, fetchImpl } = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "/loop" } }),
    );
    expect(
      await codeOf(fetchPage("http://example.com/loop", { fetchImpl, resolve: publicResolver })),
    ).toBe("WEB_TOO_MANY_REDIRECTS");
    expect(calls).toHaveLength(MAX_REDIRECT_HOPS + 1);
  });
});

describe("fetchPage 体积、超时与取消", () => {
  it(`响应体超过 ${FETCH_MAX_BYTES} 字节时截断并中止`, async () => {
    const big = new Uint8Array(FETCH_MAX_BYTES + 4096).fill(0x61);
    const { fetchImpl } = stubFetch(
      () => new Response(big, { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const page = await fetchPage("http://example.com/big", {
      fetchImpl,
      resolve: publicResolver,
    });
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBe(MAX_EXTRACTED_CHARS);
  });

  it("恰好等于上限不标记截断，超过一个字节也截断", async () => {
    const exact = stubFetch(
      () => new Response("12345678", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const page = await fetchPage("http://example.com/exact", {
      fetchImpl: exact.fetchImpl,
      resolve: publicResolver,
      maxBytes: 8,
    });
    expect(page.truncated).toBe(false);
    expect(page.text).toBe("12345678");

    const over = stubFetch(
      () => new Response("123456789", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const clipped = await fetchPage("http://example.com/over", {
      fetchImpl: over.fetchImpl,
      resolve: publicResolver,
      maxBytes: 8,
    });
    expect(clipped.truncated).toBe(true);
    expect(clipped.text).toBe("12345678");
  });

  it("总超时映射 WEB_TIMEOUT", async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    expect(
      await codeOf(
        fetchPage("http://example.com/slow", { fetchImpl, resolve: publicResolver, timeoutMs: 30 }),
      ),
    ).toBe("WEB_TIMEOUT");
  });

  it("调用方取消：立即中止并把原因原样抛出", async () => {
    const controller = new AbortController();
    const reason = new Error("用户取消");
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const promise = fetchPage("http://example.com/slow", {
      fetchImpl,
      resolve: publicResolver,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(reason);
    try {
      await promise;
      throw new Error("should reject");
    } catch (error) {
      expect(error).toBe(reason);
    }
  });

  it("已取消的 signal 不发请求", async () => {
    const controller = new AbortController();
    const reason = new Error("提前取消");
    controller.abort(reason);
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("x");
    }) as unknown as typeof fetch;
    try {
      await fetchPage("http://example.com/", {
        fetchImpl,
        resolve: publicResolver,
        signal: controller.signal,
      });
      throw new Error("should reject");
    } catch (error) {
      expect(error).toBe(reason);
    }
    expect(called).toBe(false);
  });
});
