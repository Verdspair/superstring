// 管理面共用的边界与错误映射（P7-b）。
//
// 所有本机管理路由（权限、MCP、技能）共用同一个守卫：只允许本机目标与同源来源、
// 写请求必须是 JSON、响应一律 no-store。错误只把已知域码映射成稳定状态与中英提示；
// 未知异常与数据库故障继续走全局处理器，不被包装成"配置冲突"。

import type { ErrorHandler, MiddlewareHandler } from "hono";
import { handleError } from "./error-handler";

export function managementGuard(): MiddlewareHandler {
  return async (c, next) => {
    c.header("cache-control", "no-store");
    const url = new URL(c.req.url);
    const origin = c.req.header("origin");
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      (origin && origin !== url.origin) ||
      c.req.header("sec-fetch-site") === "cross-site"
    )
      return c.json(
        { error: { code: "PERMISSION_MANAGEMENT_FORBIDDEN", message: "请从本机管理界面操作" } },
        403,
      );
    // 带 body 的写请求必须是 JSON；不带 body 的动作（如 reload）允许没有 content-type。
    const declared = c.req.header("content-type");
    if (
      ["PUT", "POST", "PATCH", "DELETE"].includes(c.req.method) &&
      declared !== undefined &&
      declared.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    )
      return c.json({ error: { code: "VALIDATION_ERROR", message: "需要 JSON 请求" } }, 422);
    await next();
  };
}

/** 稳定码 → [状态, 提示]。未列出的码不属于该域，交给全局处理器。 */
export type ManagementErrorMap = Readonly<Record<string, readonly [number, string]>>;

export function managementErrors(map: ManagementErrorMap): ErrorHandler {
  return (error, c) => {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
    if (Object.hasOwn(map, code)) {
      const [status, message] = map[code];
      return c.json({ error: { code, message } }, status as 400);
    }
    return handleError(error, c);
  };
}
