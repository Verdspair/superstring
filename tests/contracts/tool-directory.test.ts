import { expect, it } from "bun:test";
import {
  describeTool,
  type ToolDirectoryEntry,
  ToolDirectoryResponseSchema,
} from "../../src/shared/contracts/tool-directory";

it("describes metadata with conservative effect and read-only sandbox defaults", () => {
  const description = {
    name: "example",
    description: "Example",
    parameters: { type: "object" },
    capability: "example.read",
  };
  expect(describeTool({ description })).toEqual({
    ...description,
    effect: "write",
    sandboxCallable: false,
  });
  expect(describeTool({ description: { ...description, effect: "read" } })).toEqual({
    ...description,
    effect: "read",
    sandboxCallable: true,
  });
  expect(
    describeTool({ description: { ...description, effect: "read" }, sandboxCallable: false })
      .sandboxCallable,
  ).toBe(false);
});

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
    invocation: "action" as const,
    scope: "conversation" as const,
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

it("requires dispatch and supported scope without making host terminals executable", () => {
  const terminal: ToolDirectoryEntry = {
    name: "reply.text",
    description: "Contribute text",
    parameters: {},
    capability: "conversation.reply",
    effect: "write",
    sandboxCallable: false,
    origin: "system",
    invocation: "host-terminal",
    scope: "qq-conversation",
    globalEnabled: true,
    functionId: "qq-reply",
    resource: null,
    revision: "descriptor-v1",
    approvalRequired: false,
    directories: [],
  };
  expect(ToolDirectoryResponseSchema.parse({ tools: [terminal] }).tools[0]).toEqual(terminal);
  for (const field of ["invocation", "scope"] as const) {
    const missing = { ...terminal } as Record<string, unknown>;
    delete missing[field];
    expect(ToolDirectoryResponseSchema.safeParse({ tools: [missing] }).success).toBe(false);
    expect(
      ToolDirectoryResponseSchema.safeParse({ tools: [{ ...terminal, [field]: "invented" }] })
        .success,
    ).toBe(false);
  }
  expect(
    ToolDirectoryResponseSchema.safeParse({ tools: [{ ...terminal, execute() {} }] }).success,
  ).toBe(false);
});
