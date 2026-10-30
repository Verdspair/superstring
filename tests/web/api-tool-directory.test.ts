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
    invocation: "action" as const,
    scope: "conversation" as const,
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

it("round trips host terminal metadata and rejects a legacy row missing supported scope", async () => {
  const terminal = {
    name: "reply.sticker",
    description: "Contribute sticker",
    parameters: {},
    capability: "conversation.reply",
    effect: "write",
    sandboxCallable: false,
    invocation: "host-terminal",
    scope: "qq-conversation",
    origin: "system",
    globalEnabled: false,
    functionId: "qq-reply",
    resource: null,
    revision: "reply-v1",
    approvalRequired: false,
    directories: [],
  };
  const { scope: _scope, ...missing } = terminal;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ tools: [terminal] }), {
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ tools: [missing] }), {
        headers: { "content-type": "application/json" },
      }),
    );
  globalThis.fetch = Object.assign(fetcher, { preconnect: originalFetch.preconnect });
  expect(await api.getToolDirectory()).toEqual({ tools: [terminal] });
  await expect(api.getToolDirectory()).rejects.toThrow();
  expect(fetcher.mock.calls.every((call) => call[1]?.cache === "no-store")).toBe(true);
});
