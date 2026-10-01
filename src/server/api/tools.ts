import { Hono } from "hono";
import {
  type ToolDirectoryEntry,
  ToolDirectoryResponseSchema,
} from "../../shared/contracts/tool-directory";
import { managementGuard } from "./management";

export function toolDirectoryRoutes(tools: () => readonly ToolDirectoryEntry[]): Hono {
  const router = new Hono();
  router.use("*", managementGuard());
  router.get("/", (c) => c.json(ToolDirectoryResponseSchema.parse({ tools: tools() })));
  return router;
}
