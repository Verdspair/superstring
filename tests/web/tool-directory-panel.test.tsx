import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionPolicySchema } from "../../src/shared/contracts/permissions";
import type { ToolDirectoryEntry } from "../../src/shared/contracts/tool-directory";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { ToolDirectoryPanel } from "../../src/web/screens/connections/tool-directory-panel";
import { useSuperstringStore as store } from "../../src/web/store";

const tool = (
  name: string,
  globalEnabled = true,
  resource: string | null = null,
): ToolDirectoryEntry => ({
  name,
  description: "A registered read tool",
  parameters: { type: "object" },
  capability: "read",
  effect: "read",
  sandboxCallable: true,
  origin: "system",
  globalEnabled,
  functionId: "memory-query",
  resource,
  revision: "v1",
  approvalRequired: false,
  directories: [],
});
afterEach(cleanup);
beforeEach(() => selectLocale("zh-CN"));
function setup(tools: ToolDirectoryEntry[]) {
  const save = vi.fn();
  store.getState().resetForTests({
    ...api,
    getToolDirectory: vi.fn().mockResolvedValue({ tools }),
    getPermissions: vi.fn().mockResolvedValue({
      revision: "v1",
      policy: { version: 1, grants: [], execution: ExecutionPolicySchema.parse({}) },
      resources: [],
    }),
    savePermissions: save,
  });
  render(<ToolDirectoryPanel />);
  return save;
}

it("lists system tools without an MCP connection and keeps missing grants distinct from global disable", async () => {
  setup([tool("memory.query"), tool("web.fetch", true, "web"), tool("media.describe", false)]);
  await screen.findByText("memory.query");
  const web = screen.getByText("web.fetch").closest("tr");
  const media = screen.getByText("media.describe").closest("tr");
  expect(web?.getAttribute("data-global-enabled")).toBe("true");
  expect(media?.getAttribute("data-global-enabled")).toBe("false");
  await waitFor(() => expect(web?.textContent).toContain("未授权"));
  expect(media?.textContent).toContain("全局已关闭");
});

it("shows literal input rules without definition edits or deletions", async () => {
  const save = setup([tool("memory.query")]);
  const name = await screen.findByText("memory.query");
  const row = name.closest("tr");
  if (!row) throw new Error("missing tool row");
  fireEvent.click(within(row).getByRole("button", { name: "查看详情" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain('"type": "object"');
  expect(dialog.textContent).toContain("不能删除或修改定义");
  expect(within(dialog).queryByRole("button", { name: /删除|编辑定义/ })).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("opens an exact component requested by the shared navigation action", async () => {
  setup([tool("memory.query")]);
  store.setState({ componentTarget: { kind: "tool", id: "memory.query" } });
  expect((await screen.findByRole("dialog")).textContent).toContain("memory.query");
});
