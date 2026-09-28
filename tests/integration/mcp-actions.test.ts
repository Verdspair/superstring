import { describe, expect, it } from "bun:test";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { createMcpActions, mcpActionName } from "../../src/server/mcp/actions";
import type { McpSession } from "../../src/server/mcp/client";
import { PermissionService } from "../../src/server/permissions/service";
import type { McpCallResult, McpServerConfig, McpToolInfo } from "../../src/shared/contracts/mcp";
import type { PermissionPolicy } from "../../src/shared/contracts/permissions";

const context = {
  owner: { kind: "test", id: "run", agentId: "agent" },
  signal: new AbortController().signal,
};
const config: McpServerConfig = {
  id: "notes",
  name: "Notes",
  transport: "stdio",
  enabled: true,
  command: "unused",
  args: [],
  env: {},
  timeoutMs: 5000,
  maxResultChars: 100,
};
const read: McpToolInfo = {
  name: "read",
  description: "read",
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
};
const write: McpToolInfo = { ...read, name: "write", readOnly: false };
function setup() {
  let policy: PermissionPolicy = { version: 1, grants: [] };
  let result: McpCallResult | Error = { text: "ok", isError: false, omittedParts: 0 };
  let calls = 0;
  const session: McpSession = {
    serverId: "notes",
    serverName: "Notes",
    protocolVersion: "2025-06-18",
    listTools: async () => [read, write],
    async callTool() {
      calls++;
      if (result instanceof Error) throw result;
      return result;
    },
    async close() {},
  };
  const permissions = new PermissionService({
    read: () => ({ revision: "1", policy }),
    replace: (_revision, next) => {
      policy = next;
      return { revision: "2", policy };
    },
  });
  const executor = new ActionExecutor(permissions);
  const actions = createMcpActions({ sources: [{ config, session, tools: [read, write] }] });
  return {
    actions,
    executor,
    permissions,
    session,
    setResult: (next: typeof result) => {
      result = next;
    },
    calls: () => calls,
  };
}

describe("MCP uses shared permissions", () => {
  it("separates discovery from permission grants and binds approval to the tool revision", async () => {
    const h = setup();
    const [reading, writing] = h.actions;
    if (!reading.permission || !writing.permission)
      throw new Error("missing permission requirement");
    expect(h.actions).toHaveLength(2);
    expect(h.actions.filter((action) => h.executor.allowed(action, context))).toEqual([]);
    h.permissions.replace("1", {
      version: 1,
      grants: [
        { resource: reading.permission.resource, approved: false, directories: [] },
        { resource: writing.permission.resource, approved: false, directories: [] },
      ],
    });
    expect(h.executor.allowed(reading, context)).toBe(true);
    expect(h.executor.allowed(writing, context)).toBe(false);
    await expect(h.executor.execute(writing, {}, context)).rejects.toMatchObject({
      code: "PERMISSION_APPROVAL_REQUIRED",
    });
    h.permissions.replace("1", {
      version: 1,
      grants: [
        {
          resource: writing.permission.resource,
          revision: writing.permission.revision,
          approved: true,
          directories: [],
        },
      ],
    });
    expect((await h.executor.execute(writing, {}, context)).value).toEqual({
      status: "ok",
      text: "ok",
    });
    expect(h.calls()).toBe(1);
    h.permissions.replace("1", { version: 1, grants: [] });
    await expect(h.executor.execute(writing, {}, context)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(h.calls()).toBe(1);
  });

  it("detects naming conflicts independently of grants", () => {
    const h = setup();
    expect(mcpActionName("notes", "read/notes")).toBe("mcp.notes.read_notes");
    expect(() =>
      createMcpActions({
        sources: [
          {
            config,
            session: h.session,
            tools: [
              { ...read, name: "read.notes" },
              { ...read, name: "read/notes" },
            ],
          },
        ],
      }),
    ).toThrow("MCP_ACTION_NAME_CONFLICT");
    expect(
      createMcpActions({
        sources: [{ config: { ...config, enabled: false }, session: h.session, tools: [read] }],
      }),
    ).toEqual([]);
  });

  it("retains bounded result envelopes and propagates caller cancellation", async () => {
    const h = setup();
    const action = h.actions[0];
    if (!action.permission) throw new Error("missing permission requirement");
    h.permissions.replace("1", {
      version: 1,
      grants: [{ resource: action.permission.resource, approved: false, directories: [] }],
    });
    for (const [result, code] of [
      [{ text: "y".repeat(101), isError: false, omittedParts: 0 }, "MCP_RESULT_TOO_LARGE"],
      [{ text: "boom", isError: true, omittedParts: 0 }, "MCP_TOOL_ERROR"],
      [Object.assign(new Error("gone"), { code: "MCP_SERVER_GONE" }), "MCP_SERVER_GONE"],
    ] as const) {
      h.setResult(result);
      expect((await h.executor.execute(action, {}, context)).value).toMatchObject({
        status: "unavailable",
        code,
      });
    }
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      h.executor.execute(action, {}, { ...context, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
  });

  it("revalidates host authority even when an external call fails", async () => {
    const h = setup();
    const action = h.actions[0];
    if (!action.permission) throw new Error("missing permission requirement");
    h.permissions.replace("1", {
      version: 1,
      grants: [{ resource: action.permission.resource, approved: false, directories: [] }],
    });
    h.setResult(new Error("network"));
    let checks = 0;
    await expect(
      h.executor.execute(action, {}, context, {
        assertCurrent() {
          if (++checks === 2)
            throw Object.assign(new Error("revoked"), { code: "CONTEXT_SOURCE_INVALID" });
        },
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(checks).toBe(2);
  });
});
