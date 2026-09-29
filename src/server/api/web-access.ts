// /v2/web-access 管理面：联网配置读取/保存与当前通道自检。
//
// 保存形状对照权限/MCP 的修订惯例：PUT 带 expectedRevision，冲突 409；配置本身由
// FileWebAccessConfigStore 的 schema 校验。自检只读当前配置、跑一次小查询，不改任何文件；
// fetchImpl/resolve 可注入，测试全离线。

import { Hono } from "hono";
import { z } from "zod";
import { boundChars } from "../web-access/actions";
import { WebAccessConfigSchema, type WebAccessConfigStore } from "../web-access/config";
import { WebAccessError } from "../web-access/errors";
import { searchWeb } from "../web-access/search";
import type { HostResolver } from "../web-access/ssrf";
import { managementErrors, managementGuard } from "./management";
import { parseBody, readJsonBody } from "./validation";

const errors = {
  WEB_CONFIG_CONFLICT: [409, "联网配置已变化，请重新读取后保存"],
  WEB_CONFIG_INVALID: [422, "联网配置不合法：请检查 SearXNG 端点"],
  WEB_CONFIG_UNAVAILABLE: [503, "联网配置不可读，请检查文件访问权限"],
} as const;

const SnapshotSchema = z.strictObject({
  revision: z.string(),
  config: WebAccessConfigSchema,
});
const UpdateSchema = z.strictObject({
  expectedRevision: z.string(),
  config: WebAccessConfigSchema,
});
const SelfTestSchema = z.strictObject({
  ok: z.boolean(),
  channel: z.enum(["searxng", "bing"]),
  elapsedMs: z.number().int().nonnegative(),
  error: z.string().optional(),
});

const SELF_TEST_QUERY = "connectivity test";
const SELF_TEST_ERROR_CHARS = 300;

export interface WebAccessRouteOptions {
  /** 自检出口注入（测试用）；生产用全局 fetch 与真实 DNS。 */
  readonly fetchImpl?: typeof fetch;
  readonly resolve?: HostResolver;
}

export function webAccessRoutes(
  store: WebAccessConfigStore,
  options: WebAccessRouteOptions = {},
): Hono {
  const router = new Hono();
  router.onError(managementErrors(errors));
  router.use("*", managementGuard());
  router.get("/", (c) => c.json(SnapshotSchema.parse(store.read())));
  router.put("/", async (c) => {
    const input = parseBody(UpdateSchema, await readJsonBody(c.req.raw));
    return c.json(SnapshotSchema.parse(store.replace(input.expectedRevision, input.config)));
  });
  router.post("/test", async (c) => {
    const started = Date.now();
    const { config } = store.read();
    // 当前有效通道：配置了 SearXNG 端点就先走它，否则必应。失败时报告配置选中的通道。
    const preferred = config.searxngEndpoint === undefined ? "bing" : "searxng";
    try {
      const result = await searchWeb(SELF_TEST_QUERY, {
        ...(config.searxngEndpoint !== undefined
          ? { searxngEndpoint: config.searxngEndpoint }
          : {}),
        limit: 1,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.resolve ? { resolve: options.resolve } : {}),
      });
      return c.json(
        SelfTestSchema.parse({
          ok: true,
          channel: result.channel,
          elapsedMs: Date.now() - started,
        }),
      );
    } catch (error) {
      if (!(error instanceof WebAccessError)) throw error;
      return c.json(
        SelfTestSchema.parse({
          ok: false,
          channel: preferred,
          elapsedMs: Date.now() - started,
          error: boundChars(error.message, SELF_TEST_ERROR_CHARS),
        }),
      );
    }
  });
  return router;
}
