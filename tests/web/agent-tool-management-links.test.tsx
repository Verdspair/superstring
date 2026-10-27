// 助手「工具范围」卡用例：内置能力与外置 MCP/Skills 授权在同一工具目录内联呈现与管理。
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionPolicySchema,
  type PermissionsResponse,
} from "../../src/shared/contracts/permissions";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { selectLocale, translate } from "../../src/web/i18n";
import { AgentToolScope } from "../../src/web/screens/assistants/StudioEditors";
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

const toolDirectoryFixture = {
  tools: [
    {
      name: "web.search",
      description: "联网搜索",
      parameters: {},
      capability: "web",
      effect: "read" as const,
      sandboxCallable: false,
      origin: "system" as const,
      globalEnabled: true,
      functionId: "web-access" as const,
      resource: "web",
      revision: "w1",
      approvalRequired: true,
      directories: [],
    },
    {
      name: "mcp.echo.read",
      description: "read notes",
      parameters: {},
      capability: "notes",
      effect: "read" as const,
      sandboxCallable: false,
      origin: "mcp" as const,
      globalEnabled: true,
      functionId: null,
      resource: "mcp.echo.read",
      revision: "r1",
      approvalRequired: false,
      directories: [],
    },
  ],
};

beforeEach(() => {
  localStorage.clear();
  setupLibrary({
    getPermissions: vi.fn().mockResolvedValue(permissions()),
    getToolDirectory: vi.fn().mockResolvedValue(toolDirectoryFixture),
  });
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectLocale("zh-CN");
});

describe("agent tool scope management links", () => {
  it("keeps the built-in capability entry next to the external grant entry while web is in scope", async () => {
    store.setState({ editorAgentId: A });
    await act(async () =>
      render(
        <DesignSystemProvider>
          <AgentToolScope agentId={A} active />
        </DesignSystemProvider>,
      ),
    );
    // 卡片展示了内置 web 资源与外置 mcp 资源
    await screen.findByText("web");
    expect(screen.getByText("mcp.echo.read")).toBeTruthy();

    // 验证卡片说明文案清晰标示内置与扩展工具的分工
    expect(screen.getByText(translate("library.tools.for.agent.hint"))).toBeTruthy();

    // 验证内置 web 资源的内联控制项
    const webEnable = screen.getByTestId("agent-tool-enable-web");
    expect(webEnable.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("agent-tool-save-web")).toBeTruthy();

    // 验证外置 MCP 资源的内联控制项
    const mcpEnable = screen.getByTestId("agent-tool-enable-mcp.echo.read");
    expect(mcpEnable).toBeTruthy();
    expect(screen.getByTestId("agent-tool-save-mcp.echo.read")).toBeTruthy();

    // 验证原 origin 标记：web 标为系统，mcp 标为 MCP
    expect(screen.getByText(translate("connections.components.system"))).toBeTruthy();
    expect(screen.getByText("MCP")).toBeTruthy();
  });
});
