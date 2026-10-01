import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../src/web/api";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

it("loads the strict tool directory through its own read-only route", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ tools: [] }), {
      headers: { "content-type": "application/json" },
    }),
  );
  globalThis.fetch = Object.assign(fetcher, { preconnect: originalFetch.preconnect });
  expect(await api.getToolDirectory()).toEqual({ tools: [] });
  expect(fetcher.mock.calls[0][0]).toBe("/v2/tools");
  expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
});

it("preserves external descriptions literally without converting them into instructions", async () => {
  const description = "<script>alert('untrusted')</script>";
  const tool = {
    name: "mcp.example.read",
    description,
    parameters: { type: "object" },
    capability: "mcp.example",
    effect: "read",
    sandboxCallable: true,
    origin: "mcp",
    globalEnabled: true,
    functionId: null,
    resource: "mcp.example.read",
    revision: "v1",
    approvalRequired: false,
    directories: [],
  };
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ tools: [tool] }), {
      headers: { "content-type": "application/json" },
    }),
  );
  globalThis.fetch = Object.assign(fetcher, { preconnect: originalFetch.preconnect });
  expect((await api.getToolDirectory()).tools[0].description).toBe(description);
});

it("rejects malformed directory entries instead of inventing availability", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ tools: [{ name: "memory.query" }] }), {
      headers: { "content-type": "application/json" },
    }),
  );
  globalThis.fetch = Object.assign(fetcher, { preconnect: originalFetch.preconnect });
  await expect(api.getToolDirectory()).rejects.toThrow();
});
