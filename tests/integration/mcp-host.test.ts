import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import type { McpSession } from "../../src/server/mcp/client";
import { type McpHostDiagnostic, McpToolHost } from "../../src/server/mcp/host";
import { createMcpManagement } from "../../src/server/mcp/management";
import { PermissionService } from "../../src/server/permissions/service";

const fixture = path.join(import.meta.dir, "../fixtures/mcp/echo-server.mjs");
const dirs: string[] = [];
const hosts: McpToolHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function configFile(servers: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-host-"));
  dirs.push(dir);
  const file = path.join(dir, "mcp-servers.json");
  writeFileSync(file, JSON.stringify({ version: 1, servers }));
  return file;
}
const server = (id = "echo", patch: Record<string, unknown> = {}) => ({
  id,
  name: id,
  transport: "stdio",
  enabled: true,
  trustToolAnnotations: true,
  command: process.execPath,
  args: [fixture],
  ...patch,
});
function makeHost(
  file: string,
  diagnostics: McpHostDiagnostic[] = [],
  connect?: ConstructorParameters<typeof McpToolHost>[0]["connect"],
) {
  const host = new McpToolHost({
    configPath: file,
    onDiagnostic: (event) => diagnostics.push(event),
    connect,
  });
  hosts.push(host);
  return host;
}
function executorFor(resource: string) {
  return new ActionExecutor(
    new PermissionService({
      read: () => ({
        revision: "1",
        policy: { version: 1, grants: [{ resource, approved: false, directories: [] }] },
      }),
      replace() {
        throw new Error("read only test");
      },
    }),
  );
}
const context = { owner: { kind: "test", id: "run" }, signal: new AbortController().signal };

describe("MCP lifecycle and revocation", () => {
  it("starts without any config or tools", async () => {
    const file = configFile([]);
    const host = makeHost(`${file}.missing`);
    await host.start();
    expect(host.current()).toEqual([]);
  });
  it("discovers a real server and blocks a captured action as soon as its server is disabled", async () => {
    const file = configFile([server()]);
    const host = makeHost(file);
    await host.start();
    const actions = host.current();
    expect(actions).toHaveLength(4);
    const action = actions[0];
    if (!action.permission) throw new Error("missing permission requirement");
    const executor = executorFor(action.permission.resource);
    expect((await executor.execute(action, {}, context)).value).toMatchObject({
      status: "ok",
      text: "note: 冰箱里有牛奶",
    });
    writeFileSync(
      file,
      JSON.stringify({ version: 1, servers: [server("echo", { enabled: false })] }),
    );
    await expect(executor.execute(action, {}, context)).rejects.toMatchObject({
      code: "PERMISSION_REVISION_CHANGED",
    });
    await host.reload();
    expect(host.current()).toEqual([]);
  }, 20_000);
  it("does not retain usable authorization from a malformed registry", async () => {
    const file = configFile([server()]);
    const diagnostics: McpHostDiagnostic[] = [];
    const host = makeHost(file, diagnostics);
    await host.start();
    const action = host.current()[0];
    if (!action.permission) throw new Error("missing permission requirement");
    writeFileSync(file, "{ invalid");
    await host.reload();
    expect(host.current()).toEqual([]);
    await expect(
      executorFor(action.permission.resource).execute(action, {}, context),
    ).rejects.toMatchObject({ code: "MCP_CONFIG_INVALID" });
    expect(diagnostics).toEqual([{ serverId: "-", code: "MCP_CONFIG_INVALID" }]);
  }, 20_000);
  it("refreshes changed catalogs while keeping unchanged actions valid", async () => {
    let notify: (() => void) | undefined;
    let name = "read";
    const host = makeHost(configFile([server()]), [], async (_config, options) => {
      notify = options.onToolsChanged;
      return {
        serverId: "echo",
        serverName: "echo",
        protocolVersion: "2026-07-28",
        listTools: async () => [
          { name, description: null, inputSchema: { type: "object" }, readOnly: true },
        ],
        callTool: async () => ({ text: "ok", isError: false, omittedParts: 0 }),
        async close() {},
      };
    });
    await host.start();
    const first = host.current()[0];
    await host.reload();
    expect(host.current()[0].permission?.revision).toBe(first.permission?.revision);
    expect(() => first.assertAvailable?.()).not.toThrow();
    name = "replacement";
    notify?.();
    expect(host.current()).toEqual([]);
    await host.reload();
    expect(host.current()[0].description.name).toBe("mcp.echo.replacement");
    expect(() => first.assertAvailable?.()).toThrow("PERMISSION_REVISION_CHANGED");
  });

  it("supports multiple servers and drains a connection completed during shutdown", async () => {
    const closed: string[] = [];
    const session = (id: string): McpSession => ({
      serverId: id,
      serverName: id,
      protocolVersion: "2025-06-18",
      listTools: async () => [{ name: "read", description: null, inputSchema: {}, readOnly: true }],
      callTool: async () => ({ text: id, isError: false, omittedParts: 0 }),
      async close() {
        closed.push(id);
      },
    });
    const diagnostics: McpHostDiagnostic[] = [];
    const file = configFile([server("a"), server("bad"), server("b")]);
    const host = makeHost(file, diagnostics, async (config) => {
      if (config.id === "bad") throw new Error("connection failed");
      return session(config.id);
    });
    await host.start();
    expect(host.current().map((action) => action.description.name)).toEqual([
      "mcp.a.read",
      "mcp.b.read",
    ]);
    expect(diagnostics).toHaveLength(1);
    await host.stop();
    expect(closed.sort()).toEqual(["a", "b"]);
    const pending = Promise.withResolvers<McpSession>();
    const another = makeHost(configFile([server("late")]), [], () => pending.promise);
    const starting = another.start();
    const stopping = another.stop();
    pending.resolve(session("late"));
    await Promise.all([starting, stopping]);
    expect(another.current()).toEqual([]);
    expect(closed).toContain("late");
  });

  it("publishes healthy discovery before a blocked server and preserves registry order", async () => {
    const delayed = Promise.withResolvers<McpSession>();
    const healthyListed = Promise.withResolvers<void>();
    const session = (id: string): McpSession => ({
      serverId: id,
      serverName: id,
      protocolVersion: "2025-06-18",
      async listTools() {
        if (id === "b") healthyListed.resolve();
        return [{ name: "read", description: null, inputSchema: {}, readOnly: true }];
      },
      callTool: async () => ({ text: id, isError: false, omittedParts: 0 }),
      async close() {},
    });
    const host = makeHost(configFile([server("a"), server("b")]), [], async (config) =>
      config.id === "a" ? delayed.promise : session("b"),
    );
    const starting = host.start();
    await healthyListed.promise;
    // Observe after B's discovery continuation, without advancing A.
    await Promise.resolve();
    expect(host.current().map((action) => action.description.name)).toEqual(["mcp.b.read"]);
    delayed.resolve(session("a"));
    await starting;
    expect(host.current().map((action) => action.description.name)).toEqual([
      "mcp.a.read",
      "mcp.b.read",
    ]);
  });

  it("keeps B available while A refreshes, invalidates only A, and isolates A failure", async () => {
    const refresh = Promise.withResolvers<never>();
    const entered = Promise.withResolvers<void>();
    let notifyA: (() => void) | undefined;
    let refreshing = false;
    const closed: string[] = [];
    const host = makeHost(configFile([server("a"), server("b")]), [], async (config, options) => {
      if (config.id === "a") notifyA = options.onToolsChanged;
      return {
        serverId: config.id,
        serverName: config.id,
        protocolVersion: "2025-06-18",
        async listTools() {
          if (config.id === "a" && refreshing) {
            entered.resolve();
            return refresh.promise;
          }
          return [{ name: "read", description: null, inputSchema: {}, readOnly: true }];
        },
        callTool: async () => ({ text: "ok", isError: false, omittedParts: 0 }),
        async close() {
          closed.push(config.id);
        },
      };
    });
    await host.start();
    const [a, b] = host.current();
    refreshing = true;
    notifyA?.();
    const reloading = host.reload();
    await entered.promise;
    expect(host.current().map((action) => action.description.name)).toEqual(["mcp.b.read"]);
    expect(() => a.assertAvailable?.()).toThrow("PERMISSION_REVISION_CHANGED");
    expect(() => b.assertAvailable?.()).not.toThrow();
    refresh.reject(new Error("catalog unavailable"));
    await reloading;
    expect(host.current().map((action) => action.description.name)).toEqual(["mcp.b.read"]);
    expect(closed).toEqual(["a"]);
  });

  it("clears saved-registry failures while unchanged B stays usable during blocked A discovery", async () => {
    const pending = Promise.withResolvers<McpSession>();
    let aConnections = 0;
    const session = (id: string): McpSession => ({
      serverId: id,
      serverName: id,
      protocolVersion: "2025-06-18",
      listTools: async () => [{ name: "read", description: null, inputSchema: {}, readOnly: true }],
      callTool: async () => ({ text: id, isError: false, omittedParts: 0 }),
      async close() {},
    });
    const file = configFile([server("a"), server("b"), server("bad"), server("disabled")]);
    const host = makeHost(file, [], async (config) => {
      if (config.id === "bad") throw new Error("synthetic connect failure");
      if (config.id === "a" && ++aConnections > 1) return pending.promise;
      return session(config.id);
    });
    const management = createMcpManagement({ configPath: file, host });
    await host.start();
    const b = host.current().find((action) => action.description.name === "mcp.b.read");
    expect(b).toBeDefined();
    expect(management.status().servers.find((row) => row.config.id === "bad")).toMatchObject({
      state: "error",
      code: "MCP_CONNECT_FAILED",
    });
    const before = management.status();
    const saved = management.update(
      before.revision,
      before.servers.map(({ config }) =>
        config.id === "a"
          ? { ...config, name: "updated" }
          : config.id === "disabled"
            ? { ...config, enabled: false }
            : config,
      ),
    );
    const byId = Object.fromEntries(saved.servers.map((row) => [row.config.id, row]));
    expect(byId.a).toMatchObject({ state: "pending", code: null, tools: [] });
    expect(byId.b).toMatchObject({ state: "connected", code: null });
    expect(byId.bad).toMatchObject({ state: "pending", code: null, tools: [] });
    expect(byId.disabled).toMatchObject({ state: "disabled", code: null, tools: [] });
    expect(host.current().map((action) => action.description.name)).toEqual(["mcp.b.read"]);
    expect(() => b?.assertAvailable?.()).not.toThrow();
    pending.resolve(session("a"));
    await host.reload();
    expect(management.status().servers.find((row) => row.config.id === "bad")).toMatchObject({
      state: "error",
      code: "MCP_CONNECT_FAILED",
    });
    expect(host.current().map((action) => action.description.name)).toEqual([
      "mcp.a.read",
      "mcp.b.read",
    ]);
  });

  it("rejects late discovery after revision changes and closes it exactly once", async () => {
    const pending = Promise.withResolvers<McpSession>();
    const file = configFile([server("a")]);
    const closed: string[] = [];
    const host = makeHost(file, [], () => pending.promise);
    const starting = host.start();
    writeFileSync(file, JSON.stringify({ version: 1, servers: [server("a", { enabled: false })] }));
    expect(host.current()).toEqual([]);
    pending.resolve({
      serverId: "a",
      serverName: "a",
      protocolVersion: "2025-06-18",
      listTools: async () => [{ name: "read", description: null, inputSchema: {}, readOnly: true }],
      callTool: async () => ({ text: "a", isError: false, omittedParts: 0 }),
      async close() {
        closed.push("a");
      },
    });
    await starting;
    await host.reload();
    await host.stop();
    expect(host.current()).toEqual([]);
    expect(closed).toEqual(["a"]);
  });

  it("removes changed A immediately without hiding unchanged B during reconnect", async () => {
    const pending = Promise.withResolvers<McpSession>();
    const file = configFile([server("a"), server("b")]);
    const closed: string[] = [];
    let aConnections = 0;
    const session = (id: string): McpSession => ({
      serverId: id,
      serverName: id,
      protocolVersion: "2025-06-18",
      listTools: async () => [{ name: "read", description: null, inputSchema: {}, readOnly: true }],
      callTool: async () => ({ text: id, isError: false, omittedParts: 0 }),
      async close() {
        closed.push(id);
      },
    });
    const host = makeHost(file, [], async (config) => {
      if (config.id === "a" && ++aConnections > 1) return pending.promise;
      return session(config.id);
    });
    await host.start();
    const [a, b] = host.current();
    writeFileSync(
      file,
      JSON.stringify({ version: 1, servers: [server("a", { name: "updated" }), server("b")] }),
    );
    const reloading = host.reload();
    expect(host.current().map((action) => action.description.name)).toEqual(["mcp.b.read"]);
    expect(() => a.assertAvailable?.()).toThrow("PERMISSION_REVISION_CHANGED");
    expect(() => b.assertAvailable?.()).not.toThrow();
    expect(closed).toEqual(["a"]);
    pending.resolve(session("a"));
    await reloading;
    expect(host.current().map((action) => action.description.name)).toEqual([
      "mcp.a.read",
      "mcp.b.read",
    ]);
    expect(closed).toEqual(["a"]);
  });
});
