import { expect, it } from "bun:test";
import { ToolDirectoryResponseSchema } from "../../src/shared/contracts/tool-directory";

it("does not accept a directory entry with an unknown origin or missing global state", () => {
  expect(
    ToolDirectoryResponseSchema.safeParse({ tools: [{ name: "memory.query", origin: "guess" }] })
      .success,
  ).toBe(false);
});

it("distinguishes a system definition from its authorization resource", () => {
  const tool = {
    name: "memory.query",
    description: "Query memories",
    parameters: {},
    capability: "memory.read",
    effect: "read",
    sandboxCallable: true,
    origin: "system",
    globalEnabled: true,
    functionId: "memory-query",
    resource: null,
    revision: "v1",
    approvalRequired: false,
    directories: [],
  };
  expect(ToolDirectoryResponseSchema.parse({ tools: [tool] }).tools[0].resource).toBeNull();
  expect(
    ToolDirectoryResponseSchema.safeParse({ tools: [{ ...tool, deleteable: true }] }).success,
  ).toBe(false);
});
