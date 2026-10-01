import { expect, it } from "bun:test";
import {
  SYSTEM_TOOL_DEFINITIONS,
  systemToolDefinitions,
} from "../../src/server/modules/tool-definitions";
import { projectToolDirectory } from "../../src/server/permissions/tool-directory";
import { ExecutionPolicySchema } from "../../src/shared/contracts/permissions";

it("lists real built-in definitions even before an MCP connection is registered", () => {
  const rows = projectToolDirectory(SYSTEM_TOOL_DEFINITIONS, [], ExecutionPolicySchema.parse({}));
  expect(rows.map((row) => row.name)).toEqual(
    expect.arrayContaining([
      "memory.query",
      "memory.read",
      "knowledge.query",
      "knowledge.read",
      "history.query",
      "history.read",
      "summary.query",
      "summary.read",
      "media.list",
      "media.note.read",
      "media.describe",
      "sticker.search",
      "task.start",
      "task.read",
      "research.run",
      "code.run",
    ]),
  );
  expect(rows.every((row) => row.origin === "system" && row.resource === null)).toBe(true);
});

it("advertises the same input rules as the executable evidence factories", async () => {
  const { createBuiltInActions } = await import("../../src/server/agent/built-in-actions");
  const actions = createBuiltInActions(
    {
      memory: {
        async query() {
          return { status: "ok", items: [], nextCursor: null };
        },
      },
    },
    {
      assertSources() {},
      async fit() {
        return () => true;
      },
    },
  );
  const rows = projectToolDirectory(SYSTEM_TOOL_DEFINITIONS, [], ExecutionPolicySchema.parse({}));
  for (const action of actions) {
    const entry = rows.find((row) => row.name === action.description.name);
    expect(entry?.parameters).toEqual(action.description.parameters);
    expect(entry?.description).toBe(action.description.description);
    expect(entry?.effect).toBe(action.description.effect);
  }
});

it("uses the current sandbox concurrency in the management definition", () => {
  const execution = ExecutionPolicySchema.parse({ codeLimits: { concurrency: 7 } });
  const rows = projectToolDirectory(systemToolDefinitions(execution), [], execution);
  expect(rows.find((tool) => tool.name === "code.run")?.description).toContain(
    "7 concurrent calls",
  );
});

it("distinguishes global switches from Agent-scoped reading configuration", () => {
  const policy = ExecutionPolicySchema.parse({
    research: false,
    code: false,
    modules: { qqMedia: false, qqStickers: false, tasks: false },
  });
  const rows = projectToolDirectory(SYSTEM_TOOL_DEFINITIONS, [], policy);
  for (const name of [
    "media.describe",
    "media.list",
    "sticker.search",
    "task.start",
    "research.run",
    "code.run",
  ])
    expect(rows.find((row) => row.name === name)?.globalEnabled).toBe(false);
  for (const name of ["memory.query", "knowledge.query", "history.read", "task.read"])
    expect(rows.find((row) => row.name === name)?.globalEnabled).toBe(true);
});
