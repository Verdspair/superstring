import { expect, it } from "bun:test";
import { Hono } from "hono";
import { toolDirectoryRoutes } from "../../src/server/api/tools";
import { ToolDirectoryResponseSchema } from "../../src/shared/contracts/tool-directory";

const tool = {
  name: "memory.query",
  description: "Read authorized memories",
  parameters: { type: "object" },
  capability: "memory.read",
  effect: "read" as const,
  sandboxCallable: true,
  origin: "system" as const,
  globalEnabled: true,
  functionId: "memory-query" as const,
  resource: null,
  revision: null,
  approvalRequired: false,
  directories: [],
};

it("returns the actual registered projection without creating grants", async () => {
  const app = new Hono().route(
    "/v2/tools",
    toolDirectoryRoutes(() => [tool]),
  );
  const response = await app.request("http://127.0.0.1/v2/tools");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(ToolDirectoryResponseSchema.parse(await response.json())).toEqual({ tools: [tool] });
});

it("reads global disable state without removing the system component", async () => {
  let enabled = true;
  const app = new Hono().route(
    "/v2/tools",
    toolDirectoryRoutes(() => [{ ...tool, globalEnabled: enabled }]),
  );
  enabled = false;
  const response = await app.request("http://127.0.0.1/v2/tools");
  expect((await response.json()).tools).toEqual([{ ...tool, globalEnabled: false }]);
});

it("rejects foreign origins and does not expose definition mutation routes", async () => {
  const app = new Hono().route(
    "/v2/tools",
    toolDirectoryRoutes(() => [tool]),
  );
  const foreign = await app.request("http://127.0.0.1/v2/tools", {
    headers: { origin: "http://foreign.invalid" },
  });
  expect(foreign.status).toBe(403);
  const edit = await app.request("http://127.0.0.1/v2/tools", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(edit.status).toBe(404);
});
