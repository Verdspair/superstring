import { expect, it } from "bun:test";
import { projectToolDirectory } from "../../src/server/permissions/tool-directory";
import { ExecutionPolicySchema } from "../../src/shared/contracts/permissions";

const description = {
  name: "media.describe",
  description: "Describe a disclosed image",
  parameters: { type: "object" },
  capability: "media.write",
  effect: "write" as const,
};
const builtin = { description, sandboxCallable: false, functionId: "media-stickers" as const };

it("keeps a globally disabled built-in definition in the directory", () => {
  const execution = ExecutionPolicySchema.parse({ modules: { qqMedia: false } });
  const rows = projectToolDirectory([builtin], [], execution);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    name: "media.describe",
    origin: "system",
    globalEnabled: false,
    resource: null,
  });
  expect(rows[0].parameters).toEqual(description.parameters);
});

it("does not mistake missing grants for a global disable", () => {
  const action = {
    description: { ...description, name: "web.fetch", effect: "read" as const },
    permission: { resource: "web", revision: "web/v1", approvalRequired: false },
    async execute() {
      return { value: {}, sources: [] };
    },
  };
  const rows = projectToolDirectory(
    [],
    [action],
    ExecutionPolicySchema.parse({ modules: { web: true } }),
  );
  expect(rows[0]).toMatchObject({
    origin: "system",
    globalEnabled: true,
    resource: "web",
    functionId: "web-access",
  });
});

it("rejects duplicate tool names rather than masking one definition", () => {
  expect(() =>
    projectToolDirectory([builtin, builtin], [], ExecutionPolicySchema.parse({})),
  ).toThrow("TOOL_CATALOG_DUPLICATE");
});

it("shows MCP module pauses without changing their authorization resource", () => {
  const action = {
    description: { ...description, name: "mcp.example.read", effect: "read" as const },
    permission: { resource: "mcp.example.read", revision: "v1", approvalRequired: false },
    async execute() {
      return { value: {}, sources: [] };
    },
  };
  const rows = projectToolDirectory(
    [],
    [action],
    ExecutionPolicySchema.parse({ modules: { mcp: false } }),
  );
  expect(rows[0]).toMatchObject({
    origin: "mcp",
    globalEnabled: false,
    resource: "mcp.example.read",
    functionId: null,
  });
});

it("keeps document-reading actions distinct from document entries", () => {
  const action = {
    description: { ...description, name: "skill.read", effect: "read" as const },
    async execute() {
      return { value: {}, sources: [] };
    },
  };
  const rows = projectToolDirectory(
    [],
    [action],
    ExecutionPolicySchema.parse({ modules: { skills: false } }),
  );
  expect(rows[0]).toMatchObject({
    origin: "system",
    globalEnabled: false,
    resource: null,
    functionId: null,
  });
});

it("does not execute registered actions while projecting their metadata", () => {
  let calls = 0;
  const action = {
    description: { ...description, name: "mcp.example.write" },
    async execute() {
      calls++;
      return { value: {}, sources: [] };
    },
  };
  expect(projectToolDirectory([], [action], ExecutionPolicySchema.parse({}))).toHaveLength(1);
  expect(calls).toBe(0);
});

it("does not list write tools as callable from the read-only sandbox", () => {
  const rows = projectToolDirectory(
    [{ ...builtin, sandboxCallable: true }],
    [],
    ExecutionPolicySchema.parse({}),
  );
  expect(rows[0].sandboxCallable).toBe(false);
});

it("retains separate actions that share one permission resource", () => {
  const actions = ["web.search", "web.fetch"].map((name) => ({
    description: { ...description, name, effect: "read" as const },
    permission: { resource: "web", revision: "web/v1", approvalRequired: false },
    async execute() {
      return { value: {}, sources: [] };
    },
  }));
  expect(
    projectToolDirectory([], actions, ExecutionPolicySchema.parse({})).map((row) => row.name),
  ).toEqual(["web.fetch", "web.search"]);
});
