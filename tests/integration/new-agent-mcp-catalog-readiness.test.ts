import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { createApp } from "../../src/server/app";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import type { McpSession } from "../../src/server/mcp/client";
import { McpToolHost, type McpToolHostOptions } from "../../src/server/mcp/host";
import { createMcpManagement } from "../../src/server/mcp/management";
import { FilePermissionStore, PermissionService } from "../../src/server/permissions/service";
import { createRuntime } from "../../src/server/runtime";
import { McpServerSchema, type McpToolInfo } from "../../src/shared/contracts/mcp";
import { PermissionPolicySchema } from "../../src/shared/contracts/permissions";
import { cloneBusinessDb } from "../harness/business-db";

const dirs: string[] = [];
const hosts: McpToolHost[] = [];
const databases: BusinessDbHandle[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const business of databases.splice(0)) business.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const gateway: ModelGateway = {
  config: { baseUrl: "http://synthetic.invalid/v1", model: "synthetic-model", timeoutSeconds: 1 },
  async listModels() {
    return ["synthetic-model"];
  },
  async loadedContextCapacity() {
    return 65536;
  },
  async probeModelLoaded() {
    return true;
  },
  async complete() {
    throw new Error("Model calls forbidden in creation");
  },
  async *streamChat() {
    yield await Promise.reject(new Error("Model calls forbidden in creation"));
  },
};
const tool = (name = "read"): McpToolInfo => ({
  name,
  description: null,
  inputSchema: { type: "object" },
  readOnly: true,
});
function fixture(enabled = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "creation-mcp-ready-"));
  dirs.push(dir);
  const file = path.join(dir, "mcp.json");
  const server = McpServerSchema.parse({
    id: "synthetic",
    name: "synthetic",
    transport: "stdio",
    enabled,
    command: "never-executed",
    trustToolAnnotations: true,
  });
  writeFileSync(file, JSON.stringify({ version: 1, servers: [server] }));
  const permissionPath = path.join(dir, "permissions.json");
  const permissions = new PermissionService(new FilePermissionStore(permissionPath));
  const business = cloneBusinessDb();
  databases.push(business);
  return { dir, file, server, permissionPath, permissions, business };
}
function session(
  listTools: McpSession["listTools"],
  close: () => Promise<void> = async () => {},
): McpSession {
  return {
    serverId: "synthetic",
    serverName: "synthetic",
    protocolVersion: "2025-06-18",
    listTools,
    async callTool() {
      throw new Error("No tool calls during discovery or creation");
    },
    close,
  };
}
function post() {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "created", model_name: "synthetic-model" }),
  };
}
function agentRows(business: BusinessDbHandle) {
  return business.db.query("SELECT * FROM agents ORDER BY id").all();
}
function hostFor(file: string, connect: NonNullable<McpToolHostOptions["connect"]>) {
  const host = new McpToolHost({ configPath: file, connect });
  hosts.push(host);
  return host;
}

describe("MCP catalog readiness at Agent creation", () => {
  it("waits for actual discovery before POST snapshots permissions, including globally disabled modules", async () => {
    const f = fixture();
    ensureDefaults(f.business.orm, gateway.config.model);
    const listed = Promise.withResolvers<void>();
    const tools = Promise.withResolvers<readonly McpToolInfo[]>();
    let lists = 0;
    const host = hostFor(f.file, async () =>
      session(async () => {
        lists++;
        listed.resolve();
        return tools.promise;
      }),
    );
    const management = createMcpManagement({ configPath: f.file, host });
    f.permissions.replace(
      f.permissions.snapshot().revision,
      PermissionPolicySchema.parse({
        version: 1,
        grants: [],
        execution: { modules: { mcp: false }, pausedTools: ["mcp.synthetic.read"] },
      }),
    );
    const policyBefore = f.permissions.snapshot();
    const app = createApp({
      business: f.business,
      gateway,
      permissions: f.permissions,
      mcpManagement: management,
      externalActions: () => host.current(),
    });
    const before = agentRows(f.business);
    const pending = app.request("/agents", post());
    await listed.promise;
    expect(agentRows(f.business)).toEqual(before);
    expect(f.permissions.snapshot()).toEqual(policyBefore);
    expect(host.status()[0]?.state).toBe("pending");
    tools.resolve([tool()]);
    const response = await pending;
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const declaration = host.current()[0].permission;
    expect(declaration).toBeDefined();
    expect(f.permissions.snapshot().policy.grants[0]?.agentOverrides?.[created.id]).toEqual({
      enabled: true,
      approved: true,
      revision: declaration?.revision,
      directories: [],
    });
    expect(lists).toBe(1);
    expect(f.permissions.snapshot().policy.execution).toEqual(policyBefore.policy.execution);
    expect(host.status()[0]?.state).toBe("connected");
  });

  it("rejects registry changes during the one awaited discovery without writes or retries", async () => {
    const f = fixture();
    ensureDefaults(f.business.orm, gateway.config.model);
    const listed = Promise.withResolvers<void>();
    const tools = Promise.withResolvers<readonly McpToolInfo[]>();
    let lists = 0;
    const host = hostFor(f.file, async () =>
      session(async () => {
        lists++;
        listed.resolve();
        return tools.promise;
      }),
    );
    const management = createMcpManagement({ configPath: f.file, host });
    const app = createApp({
      business: f.business,
      gateway,
      permissions: f.permissions,
      mcpManagement: management,
      externalActions: () => host.current(),
    });
    const before = agentRows(f.business);
    const pending = app.request("/agents", post());
    await listed.promise;
    writeFileSync(
      f.file,
      JSON.stringify({ version: 1, servers: [{ ...f.server, name: "changed" }] }),
    );
    tools.resolve([tool()]);
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "MCP_CONFIG_CONFLICT" } });
    expect(agentRows(f.business)).toEqual(before);
    expect(f.permissions.snapshot().policy.grants).toEqual([]);
    expect(lists).toBe(1);
  });

  it("fails before POST writes on discovery failure or malformed configured registry", async () => {
    const f = fixture();
    ensureDefaults(f.business.orm, gateway.config.model);
    let connects = 0;
    const host = hostFor(f.file, async () => {
      connects++;
      throw new Error("synthetic failure");
    });
    const management = createMcpManagement({ configPath: f.file, host });
    const app = createApp({
      business: f.business,
      gateway,
      permissions: f.permissions,
      mcpManagement: management,
      externalActions: () => host.current(),
    });
    const before = agentRows(f.business);
    expect((await app.request("/agents", post())).status).toBe(503);
    expect(agentRows(f.business)).toEqual(before);
    expect(connects).toBe(1);
    writeFileSync(f.file, "not json");
    const malformed = await app.request("/agents", post());
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toMatchObject({ error: { code: "MCP_CONFIG_INVALID" } });
    expect(agentRows(f.business)).toEqual(before);
    expect(f.permissions.snapshot().policy.grants).toEqual([]);
  });

  it("accepts a genuinely zero-tool connected server and does not connect disabled servers", async () => {
    const f = fixture();
    ensureDefaults(f.business.orm, gateway.config.model);
    let connects = 0;
    const host = hostFor(f.file, async () => {
      connects++;
      return session(async () => []);
    });
    const management = createMcpManagement({ configPath: f.file, host });
    const app = createApp({
      business: f.business,
      gateway,
      permissions: f.permissions,
      mcpManagement: management,
      externalActions: () => host.current(),
    });
    expect((await app.request("/agents", post())).status).toBe(201);
    expect(host.status()[0]).toMatchObject({ state: "connected", tools: [] });
    expect(connects).toBe(1);
    writeFileSync(
      f.file,
      JSON.stringify({ version: 1, servers: [{ ...f.server, enabled: false }] }),
    );
    expect((await app.request("/agents", post())).status).toBe(201);
    expect(connects).toBe(1);
    expect(host.status()[0]?.state).toBe("disabled");
    expect(f.permissions.snapshot().policy.grants).toEqual([]);
  });

  it("rejects queued tools/list_changed discovery instead of treating an invalidated empty catalog as ready", async () => {
    const f = fixture();
    ensureDefaults(f.business.orm, gateway.config.model);
    let notify: (() => void) | undefined;
    let lists = 0;
    const secondListed = Promise.withResolvers<void>();
    const secondTools = Promise.withResolvers<readonly McpToolInfo[]>();
    const thirdListed = Promise.withResolvers<void>();
    const thirdTools = Promise.withResolvers<readonly McpToolInfo[]>();
    const host = hostFor(f.file, async (_config, options) => {
      notify = options.onToolsChanged;
      return session(async () => {
        lists++;
        if (lists === 2) {
          secondListed.resolve();
          return secondTools.promise;
        }
        if (lists === 3) {
          thirdListed.resolve();
          return thirdTools.promise;
        }
        return [tool()];
      });
    });
    await host.start();
    const management = createMcpManagement({ configPath: f.file, host });
    const app = createApp({
      business: f.business,
      gateway,
      permissions: f.permissions,
      mcpManagement: management,
      externalActions: () => host.current(),
    });
    const before = agentRows(f.business);
    const responsePromise = app.request("/agents", post());
    await secondListed.promise;
    notify?.();
    expect(host.status()[0]?.state).toBe("pending");
    secondTools.resolve([tool("changed")]);
    await thirdListed.promise;
    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(agentRows(f.business)).toEqual(before);
    expect(f.permissions.snapshot().policy.grants).toEqual([]);
    thirdTools.resolve([tool("changed")]);
    await host.reload();
    expect(host.status()[0]?.state).toBe("connected");
  });

  it("rejects a registry change during the synchronous raw snapshot and leaves creation untouched", async () => {
    const f = fixture();
    ensureDefaults(f.business.orm, gateway.config.model);
    const host = hostFor(f.file, async () => session(async () => [tool()]));
    const management = createMcpManagement({ configPath: f.file, host });
    const app = createApp({
      business: f.business,
      gateway,
      permissions: f.permissions,
      mcpManagement: management,
      externalActions: () => {
        writeFileSync(
          f.file,
          JSON.stringify({
            version: 1,
            servers: [{ ...f.server, name: "changed during snapshot" }],
          }),
        );
        return host.current();
      },
    });
    const before = agentRows(f.business);
    const response = await app.request("/agents", post());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "MCP_CONFIG_CONFLICT" } });
    expect(agentRows(f.business)).toEqual(before);
    expect(f.permissions.snapshot().policy.grants).toEqual([]);
  });

  it("keeps healthy B connected while only invalidated A blocks creation, then accepts a valid empty A catalog", async () => {
    const f = fixture();
    ensureDefaults(f.business.orm, gateway.config.model);
    const a = { ...f.server, id: "a", name: "a" };
    const b = { ...f.server, id: "b", name: "b" };
    writeFileSync(f.file, JSON.stringify({ version: 1, servers: [a, b] }));
    let invalidateA: (() => void) | undefined;
    let aLists = 0;
    const aPending = Promise.withResolvers<void>();
    const aTools = Promise.withResolvers<readonly McpToolInfo[]>();
    const host = hostFor(f.file, async (config, options) => {
      if (config.id === "a") invalidateA = options.onToolsChanged;
      return {
        ...session(async () => {
          if (config.id === "a" && ++aLists === 2) {
            aPending.resolve();
            return aTools.promise;
          }
          return config.id === "a" && aLists > 2 ? [] : [tool()];
        }),
        serverId: config.id,
        serverName: config.name,
      };
    });
    await host.start();
    const bAction = host.current().find((action) => action.description.name === "mcp.b.read");
    expect(bAction).toBeDefined();
    const management = createMcpManagement({ configPath: f.file, host });
    const app = createApp({
      business: f.business,
      gateway,
      permissions: f.permissions,
      mcpManagement: management,
      externalActions: () => host.current(),
    });
    const before = agentRows(f.business);
    invalidateA?.();
    await aPending.promise;
    const status = Object.fromEntries(host.status().map((entry) => [entry.config.id, entry.state]));
    expect(status).toEqual({ a: "pending", b: "connected" });
    expect(host.current().map((action) => action.description.name)).toEqual(["mcp.b.read"]);
    expect(() => bAction?.assertAvailable?.()).not.toThrow();
    const creating = app.request("/agents", post());
    expect(agentRows(f.business)).toEqual(before);
    aTools.resolve([]);
    const response = await creating;
    expect(response.status).toBe(201);
    const after = Object.fromEntries(host.status().map((entry) => [entry.config.id, entry]));
    expect(after.a).toMatchObject({ state: "connected", tools: [] });
    expect(after.b).toMatchObject({ state: "connected" });
    expect(f.permissions.snapshot().policy.grants.map((grant) => grant.resource)).toEqual([
      "mcp.b.read",
    ]);
  });

  it("does not grant later discovered resources to an existing Agent", async () => {
    const f = fixture();
    ensureDefaults(f.business.orm, gateway.config.model);
    let name = "first";
    const host = hostFor(f.file, async () => session(async () => [tool(name)]));
    const management = createMcpManagement({ configPath: f.file, host });
    const app = createApp({
      business: f.business,
      gateway,
      permissions: f.permissions,
      mcpManagement: management,
      externalActions: () => host.current(),
    });
    const response = await app.request("/agents", post());
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const before = f.permissions.snapshot();
    name = "future";
    await host.reload();
    expect(host.current()[0].permission?.resource).toBe("mcp.synthetic.future");
    expect(f.permissions.snapshot()).toEqual(before);
    expect(
      f.permissions.decide(
        host.current()[0].permission,
        { kind: "web", id: "test", agentId: created.id },
        "direct",
        "read",
        true,
      ).allowed,
    ).toBe(false);
  });
});

describe("Runtime creation discovery wiring", () => {
  const action: BuiltInAction = {
    description: {
      name: "mcp.synthetic.read",
      description: "synthetic",
      capability: "mcp.synthetic",
      effect: "read",
      parameters: {},
    },
    permission: {
      resource: "mcp.synthetic.read",
      revision: "synthetic-discovered-v1",
      approvalRequired: false,
    },
    async execute() {
      throw new Error("Tools forbidden during creation");
    },
  };

  it("awaits the existing host only for a missing builtin and grants the resulting exact declaration", async () => {
    const f = fixture();
    databases.splice(databases.indexOf(f.business), 1);
    const entered = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    let discoveries = 0;
    const start = spyOn(McpToolHost.prototype, "start").mockImplementation(async () => {
      discoveries++;
      entered.resolve();
      await ready.promise;
    });
    const current = spyOn(McpToolHost.prototype, "current").mockImplementation(() => [action]);
    const status = spyOn(McpToolHost.prototype, "status").mockImplementation(() => [
      {
        config: f.server,
        state: "connected",
        code: null,
        tools: [{ name: "read", description: null, readOnly: true }],
      },
    ]);
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      const creating = createRuntime({
        business: f.business,
        gateway,
        permissionConfigPath: f.permissionPath,
        mcpConfigPath: f.file,
        browserStateSecret: "synthetic-readiness-secret",
      });
      await entered.promise;
      expect(agentRows(f.business)).toEqual([]);
      expect(f.permissions.snapshot().policy.grants).toEqual([]);
      ready.resolve();
      runtime = await creating;
      expect(discoveries).toBe(1);
      expect(
        f.permissions
          .snapshot()
          .policy.grants.find((grant) => grant.resource === "mcp.synthetic.read")?.agentOverrides?.[
          DEFAULT_AGENT_ID
        ],
      ).toEqual({
        enabled: true,
        approved: true,
        revision: "synthetic-discovered-v1",
        directories: [],
      });
      expect((await runtime.app.request("/agents")).status).toBe(200);
    } finally {
      ready.resolve();
      if (runtime) await runtime.stop();
      status.mockRestore();
      current.mockRestore();
      start.mockRestore();
    }
  });

  it("does not await or grant during existing-builtin startup", async () => {
    const f = fixture();
    ensureDefaults(f.business.orm, gateway.config.model);
    databases.splice(databases.indexOf(f.business), 1);
    const before = f.permissions.snapshot();
    const start = spyOn(McpToolHost.prototype, "start").mockImplementation(() => {
      throw new Error("existing startup must not await discovery");
    });
    const current = spyOn(McpToolHost.prototype, "current");
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      runtime = await createRuntime({
        business: f.business,
        gateway,
        permissionConfigPath: f.permissionPath,
        mcpConfigPath: f.file,
        browserStateSecret: "synthetic-readiness-secret",
      });
      expect(start).not.toHaveBeenCalled();
      expect(current).not.toHaveBeenCalled();
      expect(f.permissions.snapshot()).toEqual(before);
    } finally {
      if (runtime) await runtime.stop();
      current.mockRestore();
      start.mockRestore();
    }
  });

  it("closes started MCP ownership and the business DB if bootstrap readiness fails", async () => {
    const f = fixture();
    databases.splice(databases.indexOf(f.business), 1);
    const original = new Error("synthetic startup discovery failure");
    const start = spyOn(McpToolHost.prototype, "start").mockRejectedValue(original);
    const stop = spyOn(McpToolHost.prototype, "stop");
    try {
      await expect(
        createRuntime({
          business: f.business,
          gateway,
          permissionConfigPath: f.permissionPath,
          mcpConfigPath: f.file,
          browserStateSecret: "synthetic-readiness-secret",
        }),
      ).rejects.toBe(original);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(() => f.business.db.query("SELECT 1").get()).toThrow();
    } finally {
      stop.mockRestore();
      start.mockRestore();
    }
  });

  it("retains original startup failure when stopping new MCP ownership also fails", async () => {
    const f = fixture();
    databases.splice(databases.indexOf(f.business), 1);
    const original = new Error("synthetic discovery failure");
    const cleanup = new Error("synthetic close failure");
    const start = spyOn(McpToolHost.prototype, "start").mockRejectedValue(original);
    const stop = spyOn(McpToolHost.prototype, "stop").mockRejectedValue(cleanup);
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        createRuntime({
          business: f.business,
          gateway,
          permissionConfigPath: f.permissionPath,
          mcpConfigPath: f.file,
          browserStateSecret: "synthetic-readiness-secret",
        }),
      ).rejects.toMatchObject({ cause: original, errors: [original, cleanup] });
      expect(diagnostic).toHaveBeenCalledWith("Runtime initialization cleanup failed", {
        error: original,
        cleanupErrors: [cleanup],
      });
      expect(() => f.business.db.query("SELECT 1").get()).toThrow();
    } finally {
      diagnostic.mockRestore();
      stop.mockRestore();
      start.mockRestore();
    }
  });
});
