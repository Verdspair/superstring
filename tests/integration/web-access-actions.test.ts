// 联网动作（web.search / web.fetch）：正常流、分页、有界与失败映射。全离线：fetchImpl 与
// DNS 解析器注入，取消语义按调用方 signal 原样抛出。

import { describe, expect, it } from "bun:test";
import type { ActionContext, BuiltInAction } from "../../src/server/agent/built-in-actions";
import {
  createWebActions,
  WEB_FETCH_DEFAULT_LIMIT,
  WEB_FETCH_MAX_LIMIT,
  WEB_SEARCH_RESULT_CHARS,
} from "../../src/server/web-access/actions";
import { webError } from "../../src/server/web-access/errors";
import { BING_SEARCH_ENDPOINT } from "../../src/server/web-access/search";
import type { HostResolver } from "../../src/server/web-access/ssrf";

const SEARXNG_ENDPOINT = "http://127.0.0.1:8888";
const PUBLIC_HOST = "https://public.example";

interface Call {
  readonly url: string;
}

function stubFetch(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const call = { url: String(input) };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const publicResolver: HostResolver = async () => ["93.184.216.34"];
const privateResolver: HostResolver = async () => ["10.0.0.5"];

function context(signal: AbortSignal = new AbortController().signal): ActionContext {
  return { owner: { kind: "test", id: "run", agentId: "agent" }, signal };
}

async function execute(
  action: BuiltInAction,
  arguments_: Record<string, unknown>,
  actionContext: ActionContext = context(),
) {
  return action.execute(arguments_, actionContext);
}

function bingHtml(count: number): string {
  const rows = Array.from(
    { length: count },
    (_value, index) =>
      `<li class="b_algo"><h2><a href="https://site.example/${index}">结果 ${index} 标题</a></h2>` +
      `<div class="b_caption"><p>结果 ${index} 的摘要文字</p></div></li>`,
  );
  return `<html><body><ol>${rows.join("")}</ol></body></html>`;
}

const bingOk = () =>
  new Response(bingHtml(3), { status: 200, headers: { "content-type": "text/html" } });

describe("web.search 动作", () => {
  it("必应通道正常流：查询参数与结果形状", async () => {
    const { calls, fetchImpl } = stubFetch(bingOk);
    const [search] = createWebActions({ fetchImpl });
    const observation = await execute(search, { query: "测试 查询", limit: 2 });
    expect(observation.value).toEqual({
      status: "ok",
      channel: "bing",
      items: [
        { title: "结果 0 标题", url: "https://site.example/0", snippet: "结果 0 的摘要文字" },
        { title: "结果 1 标题", url: "https://site.example/1", snippet: "结果 1 的摘要文字" },
      ],
    });
    expect(calls[0].url).toBe(`${BING_SEARCH_ENDPOINT}?q=${encodeURIComponent("测试 查询")}`);
  });

  it("SearXNG 优先、失败回退必应；两者都失败时给带 attempts 的信封", async () => {
    const fallingBack = stubFetch((call) =>
      call.url.startsWith(SEARXNG_ENDPOINT) ? new Response("boom", { status: 500 }) : bingOk(),
    );
    const [search] = createWebActions({
      fetchImpl: fallingBack.fetchImpl,
      config: () => ({ version: 1, searxngEndpoint: SEARXNG_ENDPOINT }),
    });
    const viaFallback = await execute(search, { query: "查询" });
    expect(viaFallback.value).toMatchObject({ status: "ok", channel: "bing" });
    expect(fallingBack.calls.map((call) => call.url.startsWith(SEARXNG_ENDPOINT))).toEqual([
      true,
      false,
    ]);

    const bothFail = stubFetch((call) =>
      call.url.startsWith(SEARXNG_ENDPOINT)
        ? new Response("forbidden", { status: 403 })
        : new Response("down", { status: 502 }),
    );
    const [failing] = createWebActions({
      fetchImpl: bothFail.fetchImpl,
      config: () => ({ version: 1, searxngEndpoint: SEARXNG_ENDPOINT }),
    });
    const failed = await execute(failing, { query: "查询" });
    const value = failed.value as {
      status: string;
      code: string;
      message: string;
      attempts: { channel: string; code: string }[];
    };
    expect(value.status).toBe("unavailable");
    expect(value.code).toBe("WEB_SEARCH_FAILED");
    expect(value.message.length).toBeLessThanOrEqual(400);
    expect(value.attempts).toEqual([
      { channel: "searxng", code: "WEB_SEARCH_JSON_DISABLED" },
      { channel: "bing", code: "WEB_SEARCH_FAILED" },
    ]);
  });

  it("limit 上限 15；结果有界（约 4KB），超长条目从尾部截断", async () => {
    const longHtml =
      `<li class="b_algo"><h2><a href="https://site.example/${"u".repeat(700)}">${"题".repeat(250)}</a></h2><p>${"要".repeat(400)}</p></li>`.repeat(
        15,
      );
    const { fetchImpl } = stubFetch(
      () =>
        new Response(`<html><body><ol>${longHtml}</ol></body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const [search] = createWebActions({ fetchImpl });
    const bounded = await execute(search, { query: "长结果", limit: 15 });
    const value = bounded.value as { items: { url: string }[] };
    expect(JSON.stringify(bounded.value).length).toBeLessThanOrEqual(WEB_SEARCH_RESULT_CHARS);
    expect(value.items.length).toBeGreaterThanOrEqual(1);
    for (const item of value.items) expect([...item.url].length).toBeLessThanOrEqual(512);

    const small = stubFetch(bingOk);
    const [shortSearch] = createWebActions({ fetchImpl: small.fetchImpl });
    expect((await execute(shortSearch, { query: "x", limit: 2 })).value).toMatchObject({
      status: "ok",
    });
    await expect(execute(shortSearch, { query: "x", limit: 16 })).rejects.toThrow();
  });

  it("取消：预取消的调用不发起请求，原样抛出原因", async () => {
    const controller = new AbortController();
    const reason = new Error("取消搜索");
    controller.abort(reason);
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return bingOk();
    }) as unknown as typeof fetch;
    const [search] = createWebActions({ fetchImpl });
    await expect(execute(search, { query: "x" }, context(controller.signal))).rejects.toBe(reason);
    expect(called).toBe(false);
  });
});

describe("web.fetch 动作", () => {
  const pageHtml =
    "<html><head><title>示例文章</title></head><body><article><h1>示例文章</h1>" +
    "<p>第一段正文内容。</p><p>第二段正文内容。</p></article></body></html>";

  it("HTML 正常流：finalUrl、标题与正文", async () => {
    const { calls, fetchImpl } = stubFetch(
      () => new Response(pageHtml, { status: 200, headers: { "content-type": "text/html" } }),
    );
    const [, fetchAction] = createWebActions({ fetchImpl, resolve: publicResolver });
    const observation = await execute(fetchAction, { url: `${PUBLIC_HOST}/page` });
    const value = observation.value as Record<string, unknown>;
    expect(value.status).toBe("ok");
    expect(value.url).toBe(`${PUBLIC_HOST}/page`);
    expect(value.title).toBe("示例文章");
    expect(String(value.text)).toContain("第一段正文内容");
    expect(value.offset).toBe(0);
    expect(value.nextOffset).toBe(null);
    expect(calls).toHaveLength(1);
  });

  it("offset/limit 按 Unicode 字符分页（含代理对）；越界返回空文本与 nextOffset:null", async () => {
    const text = "一二三🙂四五";
    const { fetchImpl } = stubFetch(
      () =>
        new Response(text, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    );
    const [, fetchAction] = createWebActions({ fetchImpl, resolve: publicResolver });
    const page = (arguments_: Record<string, unknown>) =>
      execute(fetchAction, { url: `${PUBLIC_HOST}/plain`, ...arguments_ });
    expect((await page({ limit: 3 })).value).toMatchObject({
      text: "一二三",
      offset: 0,
      nextOffset: 3,
    });
    expect((await page({ offset: 3, limit: 2 })).value).toMatchObject({
      text: "🙂四",
      offset: 3,
      nextOffset: 5,
    });
    expect((await page({ offset: 5 })).value).toMatchObject({
      text: "五",
      offset: 5,
      nextOffset: null,
    });
    expect((await page({ offset: 99 })).value).toMatchObject({
      text: "",
      offset: 99,
      nextOffset: null,
    });
    expect(((await page({ limit: WEB_FETCH_MAX_LIMIT })).value as { text: string }).text).toBe(
      text,
    );
    await expect(page({ offset: -1 })).rejects.toThrow();
    await expect(page({ limit: WEB_FETCH_MAX_LIMIT + 1 })).rejects.toThrow();
    const defaulted = await page({});
    expect((defaulted.value as { text: string }).text).toBe(text);
    expect(WEB_FETCH_DEFAULT_LIMIT).toBe(2048);
  });

  it("私网与环回地址、非支持协议被拒绝，且不发起请求", async () => {
    const { calls, fetchImpl } = stubFetch(bingOk);
    const [, fetchAction] = createWebActions({ fetchImpl, resolve: privateResolver });
    await expect(
      execute(fetchAction, { url: "http://127.0.0.1:8888/private" }),
    ).resolves.toMatchObject({ value: { status: "unavailable", code: "WEB_BLOCKED_ADDRESS" } });
    await expect(
      execute(fetchAction, { url: "http://private.example/secret" }),
    ).resolves.toMatchObject({ value: { status: "unavailable", code: "WEB_BLOCKED_ADDRESS" } });
    await expect(execute(fetchAction, { url: "ftp://public.example/file" })).resolves.toMatchObject(
      { value: { status: "unavailable", code: "WEB_URL_BLOCKED" } },
    );
    expect(calls).toHaveLength(0);
  });

  it("非支持内容类型与 HTTP 失败映射为工具信封", async () => {
    const image = stubFetch(
      () => new Response("png-bytes", { status: 200, headers: { "content-type": "image/png" } }),
    );
    const [, imageFetch] = createWebActions({
      fetchImpl: image.fetchImpl,
      resolve: publicResolver,
    });
    await expect(execute(imageFetch, { url: `${PUBLIC_HOST}/image.png` })).resolves.toMatchObject({
      value: { status: "unavailable", code: "WEB_UNSUPPORTED_CONTENT" },
    });

    const down = stubFetch(() => new Response("down", { status: 500 }));
    const [, downFetch] = createWebActions({ fetchImpl: down.fetchImpl, resolve: publicResolver });
    const failed = await execute(downFetch, { url: `${PUBLIC_HOST}/error` });
    expect(failed.value).toMatchObject({ status: "unavailable", code: "WEB_FETCH_FAILED" });
    expect(String((failed.value as { message: string }).message).length).toBeLessThanOrEqual(400);
  });

  it("响应体超上限时标记 truncated，正文仍按窗口返回", async () => {
    const chunk = new TextEncoder().encode("a".repeat(1024 * 1024));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const { fetchImpl } = stubFetch(
      () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    );
    const [, fetchAction] = createWebActions({ fetchImpl, resolve: publicResolver });
    const observation = await execute(fetchAction, { url: `${PUBLIC_HOST}/huge` });
    const value = observation.value as { truncated?: boolean; text: string };
    expect(value.truncated).toBe(true);
    expect(value.text).toHaveLength(WEB_FETCH_DEFAULT_LIMIT);
  });

  it("取消：预取消的调用不发起请求，原样抛出原因", async () => {
    const controller = new AbortController();
    const reason = new Error("取消抓取");
    controller.abort(reason);
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(pageHtml, { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const [, fetchAction] = createWebActions({ fetchImpl, resolve: publicResolver });
    await expect(
      execute(fetchAction, { url: `${PUBLIC_HOST}/page` }, context(controller.signal)),
    ).rejects.toBe(reason);
    expect(called).toBe(false);
  });
});

describe("web.search 的配置读取", () => {
  it("配置读取失败映射为信封；未配置时直接必应", async () => {
    const { calls, fetchImpl } = stubFetch(bingOk);
    const [noConfig] = createWebActions({ fetchImpl });
    expect((await execute(noConfig, { query: "x" })).value).toMatchObject({ channel: "bing" });

    const [brokenConfig] = createWebActions({
      fetchImpl,
      config: () => {
        throw webError("WEB_CONFIG_INVALID", "联网配置不合法，请检查 SearXNG 端点");
      },
    });
    await expect(execute(brokenConfig, { query: "x" })).resolves.toMatchObject({
      value: { status: "unavailable", code: "WEB_CONFIG_INVALID" },
    });
    expect(calls).toHaveLength(1);
  });
});
