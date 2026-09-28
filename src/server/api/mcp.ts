import { Hono } from "hono";
import { McpServersUpdateSchema, McpStatusResponseSchema } from "../../shared/contracts/mcp";
import type { McpManagement } from "../mcp/management";
import { managementErrors, managementGuard } from "./management";
import { parseBody, readJsonBody } from "./validation";

const errors = {
  MCP_CONFIG_CONFLICT: [409, "MCP 配置已变化，请重新读取后保存"],
  MCP_CONFIG_INVALID: [422, "MCP 登记内容不合法：请检查服务器条目与 id 是否重复"],
  MCP_CONFIG_UNAVAILABLE: [503, "MCP 登记文件不可读，请检查文件访问权限"],
} as const;

export function mcpRoutes(management: McpManagement): Hono {
  const router = new Hono();
  router.onError(managementErrors(errors));
  router.use("*", managementGuard());
  router.get("/servers", (c) => c.json(McpStatusResponseSchema.parse(management.status())));
  router.put("/servers", async (c) => {
    const input = parseBody(McpServersUpdateSchema, await readJsonBody(c.req.raw));
    return c.json(
      McpStatusResponseSchema.parse(management.update(input.expectedRevision, input.servers)),
    );
  });
  router.post("/reload", async (c) =>
    c.json(McpStatusResponseSchema.parse(await management.reload())),
  );
  return router;
}
