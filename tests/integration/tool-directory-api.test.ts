import { expect, it } from "bun:test";
import { Hono } from "hono";
import { toolDirectoryRoutes } from "../../src/server/api/tools";
import { createApp } from "../../src/server/app";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
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

// Merged from tool-directory-factory-guard.test.ts (same behaviors, one file):
// full createApp factory path — agents count untouched, foreign origin refused, no mutation routes.
it("keeps directory inspection read-only in the full application factory", async () => {
  const business = openBusinessDb();
  try {
    ensureDefaults(business.orm, "synthetic-model");
    const app = createApp({ business });
    const before = business.db.query("SELECT count(*) AS n FROM agents").get();
    expect(
      (
        await app.request("http://127.0.0.1/v2/tools", {
          headers: { origin: "http://foreign.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request("http://127.0.0.1/v2/tools/memory.query", { method: "DELETE" })).status,
    ).toBe(404);
    expect(business.db.query("SELECT count(*) AS n FROM agents").get()).toEqual(before);
  } finally {
    business.close();
  }
});
