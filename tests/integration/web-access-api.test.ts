// /v2/web-access 管理面：读取/保存往返、修订冲突与校验错误、自检两态（注入 fetchImpl）。
// 配置写在临时目录，全离线。

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { handleError } from "../../src/server/api/error-handler";
import { webAccessRoutes } from "../../src/server/api/web-access";
import { FileWebAccessConfigStore } from "../../src/server/web-access/config";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SEARXNG_ENDPOINT = "http://127.0.0.1:8888";

interface Call {
  readonly url: string;
}

function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const call = { url: String(input) };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function bingHtml(): string {
  return (
    '<html><body><li class="b_algo"><h2><a href="https://site.example/0">结果标题</a></h2>' +
    "<p>摘要</p></li></body></html>"
  );
}

function setup(fetchImpl?: typeof fetch) {
  const dir = mkdtempSync(path.join(tmpdir(), "web-access-api-"));
  dirs.push(dir);
  const file = path.join(dir, "web-access.json");
  const store = new FileWebAccessConfigStore(file);
  const app = new Hono();
  app.onError(handleError);
  app.route("/v2/web-access", webAccessRoutes(store, fetchImpl ? { fetchImpl } : {}));
  return { app, file, store };
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("联网配置读写", () => {
  it("GET 默认空配置；PUT 往返、归一化端点并推进修订", async () => {
    const { app } = setup();
    const initial = await app.request("/v2/web-access");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ revision: "", config: { version: 1 } });

    const saved = await app.request(
      "/v2/web-access",
      json("PUT", {
        expectedRevision: "",
        config: { version: 1, searxngEndpoint: `${SEARXNG_ENDPOINT}/` },
      }),
    );
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { revision: string; config: unknown };
    expect(body.config).toEqual({ version: 1, searxngEndpoint: SEARXNG_ENDPOINT });
    expect(body.revision).not.toBe("");

    const reread = await app.request("/v2/web-access");
    expect(await reread.json()).toEqual(body);
  });

  it("PUT 拒绝过期修订、非法端点、空 body 与跨源请求", async () => {
    const { app } = setup();
    await app.request(
      "/v2/web-access",
      json("PUT", { expectedRevision: "", config: { version: 1 } }),
    );
    const stale = await app.request(
      "/v2/web-access",
      json("PUT", { expectedRevision: "stale", config: { version: 1 } }),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("WEB_CONFIG_CONFLICT");

    // 端点形状与配置存储同一份 schema：请求体校验失败＝通用 422，不落入存储错误码。
    const invalid = await app.request(
      "/v2/web-access",
      json("PUT", { expectedRevision: "", config: { version: 1, searxngEndpoint: "ftp://x" } }),
    );
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).error.code).toBe("VALIDATION_ERROR");

    expect((await app.request("/v2/web-access", json("PUT", {}))).status).toBe(422);
    expect((await app.request("http://rebound.invalid/v2/web-access")).status).toBe(403);
    expect(
      (
        await app.request("/v2/web-access", {
          method: "PUT",
          headers: { "content-type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(422);
  });

  it("配置损坏：读取与自检都按管理错误码拒绝", async () => {
    const { app, file } = setup();
    writeFileSync(file, "not json");
    const read = await app.request("/v2/web-access");
    expect(read.status).toBe(422);
    expect((await read.json()).error.code).toBe("WEB_CONFIG_INVALID");
    const test = await app.request("/v2/web-access/test", { method: "POST" });
    expect(test.status).toBe(422);
    expect((await test.json()).error.code).toBe("WEB_CONFIG_INVALID");
  });
});

describe("联网自检", () => {
  it("未配置端点：必应通道成功，不写配置", async () => {
    const { calls, fetchImpl } = stubFetch(
      () => new Response(bingHtml(), { status: 200, headers: { "content-type": "text/html" } }),
    );
    const { app } = setup(fetchImpl);
    const before = await (await app.request("/v2/web-access")).json();
    const response = await app.request("/v2/web-access/test", { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      channel: string;
      elapsedMs: number;
      error?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.channel).toBe("bing");
    expect(body.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(body.error).toBeUndefined();
    expect(calls[0].url.startsWith("https://www.bing.com/")).toBe(true);
    expect(await (await app.request("/v2/web-access")).json()).toEqual(before);
  });

  it("配置了端点：自检走 SearXNG 通道", async () => {
    const { calls, fetchImpl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            results: [{ title: "t", url: "https://site.example/0", content: "c" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const { app } = setup(fetchImpl);
    await app.request(
      "/v2/web-access",
      json("PUT", {
        expectedRevision: "",
        config: { version: 1, searxngEndpoint: SEARXNG_ENDPOINT },
      }),
    );
    const response = await app.request("/v2/web-access/test", { method: "POST" });
    const body = (await response.json()) as { ok: boolean; channel: string };
    expect(body).toMatchObject({ ok: true, channel: "searxng" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith(`${SEARXNG_ENDPOINT}/search?`)).toBe(true);
  });

  it("双通道失败：报告配置选中的通道与有界错误，配置不变", async () => {
    const { fetchImpl } = stubFetch(() => new Response("down", { status: 500 }));
    const { app } = setup(fetchImpl);
    const saved = await app.request(
      "/v2/web-access",
      json("PUT", {
        expectedRevision: "",
        config: { version: 1, searxngEndpoint: SEARXNG_ENDPOINT },
      }),
    );
    const revision = ((await saved.json()) as { revision: string }).revision;
    const response = await app.request("/v2/web-access/test", { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      channel: string;
      elapsedMs: number;
      error: string;
    };
    expect(body.ok).toBe(false);
    expect(body.channel).toBe("searxng");
    expect(body.error.length).toBeLessThanOrEqual(300);
    expect(body.error).toContain("searxng");
    expect(body.error).toContain("bing");
    const reread = (await (await app.request("/v2/web-access")).json()) as { revision: string };
    expect(reread.revision).toBe(revision);
  });
});
