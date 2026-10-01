import { expect, it } from "bun:test";
import { projectToolDirectory } from "../../src/server/permissions/tool-directory";
import { ExecutionPolicySchema } from "../../src/shared/contracts/permissions";

it("preserves untrusted MCP metadata as data while keeping current authority separate", () => {
  const action = {
    description: {
      name: "mcp.sample.read",
      description: "<script>not an instruction</script>",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      capability: "mcp.sample",
      effect: "read" as const,
    },
    permission: { resource: "mcp.sample.read", revision: "v1", approvalRequired: true },
    async execute() {
      throw new Error("Directory inspection must not execute tools");
    },
  };
  const rows = projectToolDirectory(
    [],
    [action],
    ExecutionPolicySchema.parse({ modules: { mcp: true } }),
  );
  expect(rows[0]).toMatchObject({
    globalEnabled: true,
    approvalRequired: true,
    resource: "mcp.sample.read",
  });
  expect(rows[0].description).toBe(action.description.description);
  expect(rows[0].parameters).toEqual(action.description.parameters);
});
