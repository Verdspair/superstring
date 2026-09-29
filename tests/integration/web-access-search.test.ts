// 搜索适配（searxng / bing）：合成 fixture、回退链与错误码。全离线：fetchImpl 注入。

import { describe, expect, it } from "bun:test";
import {
  BING_SEARCH_ENDPOINT,
  resolveBingRedirect,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_SNIPPET_CHARS,
  SEARCH_TITLE_CHARS,
  searchBing,
  searchSearxng,
  searchWeb,
} from "../../src/server/web-access/search";

const SEARXNG_ENDPOINT = "http://127.0.0.1:8888/";

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

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function bingHtml(count: number): string {
  const rows = Array.from(
    { length: count },
    (_value, index) =>
      `<li class="b_algo"><h2><a href="https://site.example/${index}">结果 ${index} 标题</a></h2>` +
      `<div class="b_caption"><p>结果 ${index} 的摘要文字</p></div></li>`,
  );
  return `<html><body><ol>${rows.join("")}</ol><li class="b_ans">不是搜索结果块</li></body></html>`;
}

function searxngJson(count: number): string {
  return JSON.stringify({
    results: Array.from({ length: count }, (_value, index) => ({
      title: `结果 ${index}`,
      url: `https://site.example/${index}`,
      content: `结果 ${index} 的摘要`,
    })),
  });
}

describe("必应搜索解析", () => {
  it("合成结构与 fixture：标题、链接、摘要", async () => {
    const { calls, fetchImpl } = stubFetch(
      () => new Response(bingHtml(2), { status: 200, headers: { "content-type": "text/html" } }),
    );
    const items = await searchBing("测试 查询", { fetchImpl });
    expect(calls[0].url).toBe(`${BING_SEARCH_ENDPOINT}?q=${encodeURIComponent("测试 查询")}`);
    expect(items).toEqual([
      { title: "结果 0 标题", url: "https://site.example/0", snippet: "结果 0 的摘要文字" },
      { title: "结果 1 标题", url: "https://site.example/1", snippet: "结果 1 的摘要文字" },
    ]);
  });

  it("必应跳转链接尽量解析真实目标，解析不了保留原样", async () => {
    const target = "https://target.example/article?x=1";
    const wrapped = `https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString("base64url")}`;
    const html =
      `<li class="b_algo"><h2><a href="${wrapped}">跳转结果</a></h2><p>摘要</p></li>` +
      `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=zzz">解不出的结果</a></h2><p>摘要二</p></li>` +
      `<li class="b_algo"><h2><a href="/relative/page">相对链接</a></h2><p>摘要三</p></li>`;
    const { fetchImpl } = stubFetch(
      () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    );
    const items = await searchBing("x", { fetchImpl });
    expect(items[0].url).toBe(target);
    expect(items[1].url).toBe("https://www.bing.com/ck/a?u=zzz");
    expect(items[2].url).toBe("/relative/page");
    expect(resolveBingRedirect(wrapped)).toBe(target);
    expect(resolveBingRedirect("https://example.com/ck/a?u=a1abc")).toBe(null);
  });

  it("解析 0 条＝无结果（成功且为空）", async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response("<html><body><ol></ol></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    expect(await searchBing("没结果", { fetchImpl })).toEqual([]);
  });

  it("limit 默认 10、上限 15", async () => {
    const { fetchImpl } = stubFetch(
      () => new Response(bingHtml(20), { status: 200, headers: { "content-type": "text/html" } }),
    );
    expect((await searchBing("x", { fetchImpl })).length).toBe(SEARCH_DEFAULT_LIMIT);
    expect((await searchBing("x", { fetchImpl, limit: 20 })).length).toBe(SEARCH_MAX_LIMIT);
    expect((await searchBing("x", { fetchImpl, limit: 3 })).length).toBe(3);
  });

  it("标题截断 ≤200、摘要截断 ≤300 字符", async () => {
    const longTitle = "题".repeat(250);
    const longSnippet = "要".repeat(400);
    const html = `<li class="b_algo"><h2><a href="https://site.example/long">${longTitle}</a></h2><p>${longSnippet}</p></li>`;
    const { fetchImpl } = stubFetch(
      () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    );
    const items = await searchBing("x", { fetchImpl });
    expect(items[0].title.length).toBe(SEARCH_TITLE_CHARS);
    expect(items[0].snippet.length).toBe(SEARCH_SNIPPET_CHARS);
  });

  it("HTTP 失败归为 WEB_SEARCH_FAILED", async () => {
    const { fetchImpl } = stubFetch(() => new Response("down", { status: 500 }));
    expect(await codeOf(searchBing("x", { fetchImpl }))).toBe("WEB_SEARCH_FAILED");
  });
});

describe("SearXNG 搜索解析", () => {
  it("JSON fixture：去尾斜杠的 /search?q=…&format=json", async () => {
    const { calls, fetchImpl } = stubFetch(
      () =>
        new Response(searxngJson(2), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const items = await searchSearxng("你好 世界", SEARXNG_ENDPOINT, { fetchImpl });
    expect(calls[0].url).toBe(
      `http://127.0.0.1:8888/search?q=${encodeURIComponent("你好 世界")}&format=json`,
    );
    expect(items[0]).toEqual({
      title: "结果 0",
      url: "https://site.example/0",
      snippet: "结果 0 的摘要",
    });
  });

  it("limit 默认 10、上限 15，标题与摘要按上限截断", async () => {
    const payload = JSON.stringify({
      results: Array.from({ length: 20 }, (_value, index) => ({
        title: index === 0 ? "题".repeat(250) : `结果 ${index}`,
        url: `https://site.example/${index}`,
        content: index === 0 ? "要".repeat(400) : `摘要 ${index}`,
      })),
    });
    const { fetchImpl } = stubFetch(
      () => new Response(payload, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const defaults = await searchSearxng("x", SEARXNG_ENDPOINT, { fetchImpl });
    expect(defaults.length).toBe(SEARCH_DEFAULT_LIMIT);
    expect(defaults[0].title.length).toBe(SEARCH_TITLE_CHARS);
    expect(defaults[0].snippet.length).toBe(SEARCH_SNIPPET_CHARS);
    const capped = await searchSearxng("x", SEARXNG_ENDPOINT, { fetchImpl, limit: 20 });
    expect(capped.length).toBe(SEARCH_MAX_LIMIT);
  });

  it("403 或非 JSON 响应：提示需在实例开启 json 格式", async () => {
    const forbidden = stubFetch(() => new Response("forbidden", { status: 403 }));
    try {
      await searchSearxng("x", SEARXNG_ENDPOINT, { fetchImpl: forbidden.fetchImpl });
      throw new Error("should reject");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("WEB_SEARCH_JSON_DISABLED");
      expect((error as Error).message).toContain("json");
    }
    const html = stubFetch(
      () =>
        new Response("<html>不是 JSON</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    expect(await codeOf(searchSearxng("x", SEARXNG_ENDPOINT, { fetchImpl: html.fetchImpl }))).toBe(
      "WEB_SEARCH_JSON_DISABLED",
    );
  });

  it("其他 HTTP 失败归为 WEB_SEARCH_FAILED", async () => {
    const { fetchImpl } = stubFetch(() => new Response("boom", { status: 500 }));
    expect(await codeOf(searchSearxng("x", SEARXNG_ENDPOINT, { fetchImpl }))).toBe(
      "WEB_SEARCH_FAILED",
    );
  });
});

describe("searchWeb 入口", () => {
  it("未配置端点直接必应", async () => {
    const { calls, fetchImpl } = stubFetch(
      () => new Response(bingHtml(1), { status: 200, headers: { "content-type": "text/html" } }),
    );
    const result = await searchWeb("查询", { fetchImpl });
    expect(result.channel).toBe("bing");
    expect(result.items.length).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("配了端点先 SearXNG；失败回退必应", async () => {
    const { calls, fetchImpl } = stubFetch((call) =>
      call.url.startsWith("http://127.0.0.1:8888/")
        ? new Response("boom", { status: 500 })
        : new Response(bingHtml(1), { status: 200, headers: { "content-type": "text/html" } }),
    );
    const result = await searchWeb("查询", {
      fetchImpl,
      searxngEndpoint: SEARXNG_ENDPOINT,
    });
    expect(result.channel).toBe("bing");
    expect(calls.map((call) => call.url.startsWith("http://127.0.0.1:8888/"))).toEqual([
      true,
      false,
    ]);
  });

  it("SearXNG 未开 json 也回退必应", async () => {
    const { fetchImpl } = stubFetch((call) =>
      call.url.startsWith("http://127.0.0.1:8888/")
        ? new Response("forbidden", { status: 403 })
        : new Response(bingHtml(1), { status: 200, headers: { "content-type": "text/html" } }),
    );
    const result = await searchWeb("查询", { fetchImpl, searxngEndpoint: SEARXNG_ENDPOINT });
    expect(result.channel).toBe("bing");
  });

  it("两者都失败：错误信封带两次尝试的码", async () => {
    const { fetchImpl, calls } = stubFetch((call) =>
      call.url.startsWith("http://127.0.0.1:8888/")
        ? new Response("forbidden", { status: 403 })
        : new Response("down", { status: 502 }),
    );
    try {
      await searchWeb("查询", { fetchImpl, searxngEndpoint: SEARXNG_ENDPOINT });
      throw new Error("should reject");
    } catch (error) {
      const failure = error as { code?: string; message?: string; attempts?: unknown[] };
      expect(failure.code).toBe("WEB_SEARCH_FAILED");
      expect(failure.message).toContain("searxng");
      expect(failure.message).toContain("bing");
      expect(failure.attempts).toHaveLength(2);
      expect(calls).toHaveLength(2);
    }
  });

  it("调用方已取消：不发起任何请求", async () => {
    const controller = new AbortController();
    const reason = new Error("取消搜索");
    controller.abort(reason);
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    try {
      await searchWeb("x", {
        fetchImpl,
        searxngEndpoint: SEARXNG_ENDPOINT,
        signal: controller.signal,
      });
      throw new Error("should reject");
    } catch (error) {
      expect(error).toBe(reason);
    }
    expect(called).toBe(false);
  });
});
