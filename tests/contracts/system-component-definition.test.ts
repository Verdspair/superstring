import { expect, it } from "bun:test";
import { ToolDirectoryEntrySchema } from "../../src/shared/contracts/tool-directory";

it("does not expose mutable system definition flags or accept executable callbacks", () => {
  const metadata = {
    name: "memory.read",
    description: "Read a current reference",
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
  expect(ToolDirectoryEntrySchema.safeParse(metadata).success).toBe(true);
  expect(ToolDirectoryEntrySchema.safeParse({ ...metadata, execute: () => null }).success).toBe(
    false,
  );
  expect(ToolDirectoryEntrySchema.safeParse({ ...metadata, editable: true }).success).toBe(false);
});
