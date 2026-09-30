// 助手「工具范围」卡的双入口用例：内置能力在系统能力页管理，外置 MCP/Skills 授权仍在工具授权页。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionPolicySchema,
  type PermissionsResponse,
} from "../../src/shared/contracts/permissions";
import { selectLocale, translate } from "../../src/web/i18n";
import { CapabilityEditor } from "../../src/web/screens/assistants/StudioEditors";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, setupLibrary } from "./helpers/library-fixture";

function permissions(): PermissionsResponse {
  return {
    revision: "pr-1",
    policy: {
      version: 1,
      grants: [
        // web 是内置能力资源：已批准给当前 Agent，且执行策略里联网模块开启。
        { resource: "web", approved: true, revision: "w1", agentIds: [A], directories: [] },
        // 外置工具资源：仍归工具授权页管理。
        { resource: "mcp.echo.read", approved: false, revision: "r1", directories: [] },
      ],
      execution: ExecutionPolicySchema.parse({ modules: { web: true } }),
    },
    resources: [
      {
        name: "web.search",
        resource: "web",
        description: "联网搜索",
        effect: "read",
        revision: "w1",
        approvalRequired: true,
      },
      {
        name: "mcp.echo.read",
        resource: "mcp.echo.read",
        description: "read notes",
        effect: "read",
        revision: "r1",
        approvalRequired: false,
      },
    ],
  };
}

beforeEach(() => {
  localStorage.clear();
  setupLibrary({ getPermissions: vi.fn().mockResolvedValue(permissions()) });
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectLocale("zh-CN");
});

describe("agent tool scope management links", () => {
  it("keeps the built-in capability entry next to the external grant entry while web is in scope", async () => {
    const open = vi.fn();
    store.setState({ openSettingsRoute: open });
    await act(async () => render(<CapabilityEditor />));
    // 卡片确实展示了内置 web 资源：这正是原先只有外部授权入口时的管理盲区。
    await screen.findByText("web");
    const builtIn = screen.getByRole("button", { name: translate("workspace.capabilities") });
    const external = screen.getByRole("button", { name: translate("library.tools.manage") });
    expect(builtIn.getAttribute("data-variant")).toBe("default");
    expect(external.getAttribute("data-variant")).toBe("outline");
    fireEvent.click(builtIn);
    fireEvent.click(external);
    expect(open).toHaveBeenNthCalledWith(1, "system-capabilities");
    expect(open).toHaveBeenNthCalledWith(2, "tool-grants");
  });
});
