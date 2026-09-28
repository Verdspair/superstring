import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { handleError } from "../../src/server/api/error-handler";
import { mcpRoutes } from "../../src/server/api/mcp";
import type { McpSession } from "../../src/server/mcp/client";
import { McpToolHost } from "../../src/server/mcp/host";
import { createMcpManagement } from "../../src/server/mcp/management";

const dirs: string[] = [];
const hosts: McpToolHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-admin-"));
  dirs.push(dir);
  const file = path.join(dir, "mcp-servers.json");
  const connect = async (config: { id: string }): Promise<McpSession> => {
    if (config.id === "bad") throw new Error("synthetic connect failure");
    return {
      serverId: config.id,
      serverName: config.id,
      protocolVersion: "2025-06-18",
      listTools: async () => [
        { name: "read", description: "read notes", inputSchema: {}, readOnly: true },
        { name: "write", description: null, inputSchema: {}, readOnly: false },
      ],
      callTool: async () => ({ text: config.id, isError: false, omittedParts: 0 }),
      async close() {},
    };
  };
  const host = new McpToolHost({ configPath: file, connect });
  hosts.push(host);
  const app = new Hono();
  app.onError(handleError);
  app.route("/v2/mcp", mcpRoutes(createMcpManagement({ configPath: file, host })));
  return { file, host, app };
}
const stdio = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  name: id,
  transport: "stdio",
  enabled: true,
  command: process.execPath,
  args: [],
  ...patch,
});
const put = (app: Hono, body: unknown) =>
  app.request("/v2/mcp/servers", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("MCP management", () => {
  it("reads an empty registry then saves a normalized file with a content revision", async () => {
    const f = workspace();
    const empty = await (await f.app.request("/v2/mcp/servers")).json();
    expect(empty).toEqual({ revision: "", code: null, servers: [] });
    const saved = await (
      await put(f.app, { expectedRevision: "", servers: [stdio("echo")] })
    ).json();
    expect(saved.code).toBeNull();
    expect(saved.revision).not.toBe("");
    expect(saved.servers[0].config).toMatchObject({
      id: "echo",
      timeoutMs: 15_000,
      maxResultChars: 8_000,
    });
    const file = JSON.parse(readFileSync(f.file, "utf8"));
    expect(file).toMatchObject({ version: 1 });
    expect(file.servers[0].id).toBe("echo");
  });

  it("keeps the local/JSON management boundary and never expands credential references", async () => {
    const f = workspace();
    expect((await f.app.request("http://rebound.invalid/v2/mcp/servers")).status).toBe(403);
    expect((await f.app.request("/v2/mcp/servers", { method: "PUT", body: "{}" })).status).toBe(
      422,
    );
    const entry = {
      id: "remote",
      name: "remote",
      transport: "http",
      enabled: true,
      url: "https://mcp.invalid/mcp",
      authorizationEnv: "SYNTHETIC_TOKEN",
    };
    const saved = await put(f.app, {
      expectedRevision: "",
      servers: [stdio("echo", { env: { TOKEN: "$SYNTHETIC_TOKEN" } }), entry],
    });
    expect(saved.status).toBe(200);
    const body = await (await f.app.request("/v2/mcp/servers")).json();
    const remote = body.servers.find(
      (row: { config: { id: string } }) => row.config.id === "remote",
    );
    expect(remote.config.authorizationEnv).toBe("SYNTHETIC_TOKEN");
    expect(JSON.stringify(remote)).not.toContain("Bearer");
    const local = body.servers.find((row: { config: { id: string } }) => row.config.id === "echo");
    expect(local.config.env.TOKEN).toBe("$SYNTHETIC_TOKEN");
  });

  it("separates a saved configuration from its connection result and isolates per-server failures", async () => {
    const f = workspace();
    expect(
      (
        await put(f.app, {
          expectedRevision: "",
          servers: [stdio("echo"), stdio("bad")],
        })
      ).status,
    ).toBe(200);
    const reloaded = await (await f.app.request("/v2/mcp/reload", { method: "POST" })).json();
    const byId = Object.fromEntries(
      reloaded.servers.map((row: { config: { id: string } }) => [row.config.id, row]),
    );
    expect(byId.echo).toMatchObject({ state: "connected", code: null });
    expect(byId.echo.tools.map((tool: { name: string }) => tool.name)).toEqual(["read", "write"]);
    expect(byId.bad).toMatchObject({ state: "error", code: "MCP_CONNECT_FAILED", tools: [] });
    expect(f.host.current().map((action) => action.description.name)).toEqual([
      "mcp.echo.read",
      "mcp.echo.write",
    ]);
    const revision = reloaded.revision;
    const disabled = await (
      await put(f.app, {
        expectedRevision: revision,
        servers: [stdio("echo", { enabled: false }), stdio("bad")],
      })
    ).json();
    // 保存后快照不再沿用旧连接/旧失败：显式停用显示 disabled，待重连的显示 pending。
    expect(disabled.servers[0]).toMatchObject({ state: "disabled", code: null, tools: [] });
    expect(disabled.servers[1]).toMatchObject({ state: "pending", code: null });
    const after = await (await f.app.request("/v2/mcp/reload", { method: "POST" })).json();
    expect(after.servers[0]).toMatchObject({ state: "disabled", code: null, tools: [] });
    expect(after.servers[1]).toMatchObject({ state: "error", code: "MCP_CONNECT_FAILED" });
  });

  it("reports a malformed file with its revision and repairs it through the conflict check", async () => {
    const f = workspace();
    await put(f.app, { expectedRevision: "", servers: [stdio("echo")] });
    writeFileSync(f.file, "{ invalid");
    const broken = await (await f.app.request("/v2/mcp/servers")).json();
    expect(broken.code).toBe("MCP_CONFIG_INVALID");
    expect(broken.servers).toEqual([]);
    expect(broken.revision).not.toBe("");
    expect((await put(f.app, { expectedRevision: "", servers: [stdio("echo")] })).status).toBe(409);
    const conflict = await (
      await put(f.app, { expectedRevision: "", servers: [stdio("echo")] })
    ).json();
    expect(conflict.error.code).toBe("MCP_CONFIG_CONFLICT");
    const repaired = await put(f.app, {
      expectedRevision: broken.revision,
      servers: [stdio("echo")],
    });
    expect(repaired.status).toBe(200);
    const after = await (await f.app.request("/v2/mcp/servers")).json();
    expect(after.code).toBeNull();
    expect(after.servers).toHaveLength(1);
  });

  it("rejects duplicate ids and malformed entries without writing the file", async () => {
    const f = workspace();
    expect(
      (await put(f.app, { expectedRevision: "", servers: [stdio("echo"), stdio("echo")] })).status,
    ).toBe(422);
    expect(
      (
        await put(f.app, {
          expectedRevision: "",
          servers: [{ ...stdio("remote"), transport: "http", url: "not-a-url" }],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await put(f.app, {
          expectedRevision: "",
          servers: [stdio("echo", { extra: true })],
        })
      ).status,
    ).toBe(422);
    expect(() => readFileSync(f.file, "utf8")).toThrow();
  });
});
