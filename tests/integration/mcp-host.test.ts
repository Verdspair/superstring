import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import type { McpSession } from "../../src/server/mcp/client";
import { type McpHostDiagnostic, McpToolHost } from "../../src/server/mcp/host";
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
  });
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
});
