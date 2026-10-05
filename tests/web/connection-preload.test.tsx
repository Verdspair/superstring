import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionPolicySchema } from "../../src/shared/contracts/permissions";
import type { ToolDirectoryEntry } from "../../src/shared/contracts/tool-directory";
import { api } from "../../src/web/api";
import { selectLocale, translate } from "../../src/web/i18n";
import { McpPanel } from "../../src/web/screens/connections/mcp-panel";
import { ToolDirectoryPanel } from "../../src/web/screens/connections/tool-directory-panel";
import {
  warmConnectionResources,
  warmMcpServers,
  warmToolDirectory,
} from "../../src/web/services/connection-resources";
import { useSuperstringStore as store } from "../../src/web/store";

const tool = (name: string): ToolDirectoryEntry => ({
  name,
  description: "A registered read tool",
  parameters: { type: "object" },
  capability: "read",
  effect: "read",
  sandboxCallable: true,
  origin: "system",
  globalEnabled: true,
  functionId: "memory-query",
  resource: null,
  revision: "v1",
  approvalRequired: false,
  directories: [],
});

const mcpStatus = (revision = "mcp-r1") => ({
  revision,
  code: null,
  servers: [
    {
      config: {
        id: "demo-server",
        name: "演示服务",
        transport: "stdio",
        command: "demo",
        enabled: true,
        timeoutMs: 15000,
        maxResultChars: 8000,
        args: [],
        env: {},
      },
      state: "connected",
      code: null,
      tools: [],
    },
  ],
});

const skillCatalog = () => ({
  skills: [
    {
      name: "doc-helper",
      description: "帮助文档技能",
      revision: "s1",
      origin: "system",
      globalEnabled: true,
    },
  ],
  problems: [],
});

const permSnapshot = () => ({
  revision: "pr-1",
  policy: { version: 1, grants: [], execution: ExecutionPolicySchema.parse({}) },
  resources: [],
});

afterEach(cleanup);
beforeEach(() => selectLocale("zh-CN"));

describe("connection shared resource prewarm", () => {
  it("并行预热三端点；数据复用不再发包，force 才重读", async () => {
    const getMcpServers = vi.fn().mockResolvedValue(mcpStatus());
    const getSkills = vi.fn().mockResolvedValue(skillCatalog());
    const getToolDirectory = vi.fn().mockResolvedValue({ tools: [tool("memory.query")] });
    const fake = {
      ...api,
      getMcpServers,
      getSkills,
      getToolDirectory,
    } as unknown as typeof api;

    const warm = await warmConnectionResources(fake);
    expect(warm.mcp.revision).toBe("mcp-r1");
    expect(warm.skills.skills).toHaveLength(1);
    expect(warm.tools.tools).toHaveLength(1);
    expect(getMcpServers).toHaveBeenCalledTimes(1);
    expect(getSkills).toHaveBeenCalledTimes(1);
    expect(getToolDirectory).toHaveBeenCalledTimes(1);

    // 已有数据：预热直出缓存，不重复发包。
    await warmConnectionResources(fake);
    expect(getMcpServers).toHaveBeenCalledTimes(1);

    // force 才允许重读。
    await warmMcpServers(fake, { force: true });
    expect(getMcpServers).toHaveBeenCalledTimes(2);
  });

  it("预热在途即挂载：面板复用同一在途请求，不重复发包", async () => {
    let resolveTools: (value: { tools: ToolDirectoryEntry[] }) => void = () => {};
    const getToolDirectory = vi.fn().mockImplementation(
      () =>
        new Promise<{ tools: ToolDirectoryEntry[] }>((resolve) => {
          resolveTools = resolve;
        }),
    );
    const getPermissions = vi.fn().mockResolvedValue(permSnapshot());
    const fake = {
      ...api,
      getToolDirectory,
      getPermissions,
    } as unknown as typeof api;
    store.getState().resetForTests(fake);

    const warm = warmToolDirectory(fake);
    render(<ToolDirectoryPanel />);
    await act(async () => {});
    expect(getToolDirectory).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveTools({ tools: [tool("memory.query")] });
    });
    expect(await screen.findByText("memory.query")).toBeTruthy();
    await warm;
  });

  it("预热完成后挂载：数据直出无 Waiting 闪空，单次静默复验不循环", async () => {
    const getToolDirectory = vi.fn().mockResolvedValue({ tools: [tool("memory.query")] });
    const getPermissions = vi.fn().mockResolvedValue(permSnapshot());
    const fake = {
      ...api,
      getToolDirectory,
      getPermissions,
    } as unknown as typeof api;
    store.getState().resetForTests(fake);

    await warmToolDirectory(fake);
    expect(getToolDirectory).toHaveBeenCalledTimes(1);

    render(<ToolDirectoryPanel />);
    // 首渲染即直出预热数据，不闪加载态。
    expect(screen.getByText("memory.query")).toBeTruthy();
    expect(screen.queryByText(translate("connections.common.loading"))).toBeNull();

    // 挂载恰好一次静默复验；再多的 flush 不再发包。
    await act(async () => {});
    expect(getToolDirectory).toHaveBeenCalledTimes(2);
    await act(async () => {});
    await act(async () => {});
    expect(getToolDirectory).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("MCP 面板消费共享资源：预热直出且挂载单次复验", async () => {
    const getMcpServers = vi.fn().mockResolvedValue(mcpStatus());
    const getPermissions = vi.fn().mockResolvedValue(permSnapshot());
    const fake = {
      ...api,
      getMcpServers,
      getPermissions,
    } as unknown as typeof api;
    store.getState().resetForTests(fake);

    await warmMcpServers(fake);
    render(<McpPanel />);
    expect(screen.getByText("演示服务")).toBeTruthy();
    expect(screen.queryByText(translate("connections.common.loading"))).toBeNull();

    await act(async () => {});
    expect(getMcpServers).toHaveBeenCalledTimes(2);
    await act(async () => {});
    await act(async () => {});
    expect(getMcpServers).toHaveBeenCalledTimes(2);
  });

  it("共享消费者退出：warm 在途不取消，面板前台读取最后退场即取消且迟到结果不落", async () => {
    let resolveWarm: (value: { tools: ToolDirectoryEntry[] }) => void = () => {};
    const getToolDirectory = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ tools: ToolDirectoryEntry[] }>((resolve) => {
            resolveWarm = resolve;
          }),
      )
      .mockResolvedValue({ tools: [] });
    const getPermissions = vi.fn().mockResolvedValue(permSnapshot());
    const fake = {
      ...api,
      getToolDirectory,
      getPermissions,
    } as unknown as typeof api;
    store.getState().resetForTests(fake);

    // warm 持有在途读取：面板退场不 abort，读取允许完成。
    const warm = warmToolDirectory(fake);
    const warmView = render(<ToolDirectoryPanel />);
    await act(async () => {});
    expect(getToolDirectory).toHaveBeenCalledTimes(1);
    warmView.unmount();
    expect(getToolDirectory.mock.calls[0][0].aborted).toBe(false);
    await act(async () => {
      resolveWarm({ tools: [] });
    });
    await warm;

    // 面板前台读取（挂载单次复验）：最后消费者退场取消，迟到 resolve 不得落回。
    const late = Promise.withResolvers<{ tools: ToolDirectoryEntry[] }>();
    getToolDirectory.mockImplementationOnce(() => late.promise);
    const view = render(<ToolDirectoryPanel />);
    await act(async () => {});
    expect(getToolDirectory).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(getToolDirectory.mock.calls[1][0].aborted).toBe(true);
    await act(async () => {
      late.resolve({ tools: [tool("memory.query")] });
    });

    // 重新挂载是全新读取：被取消读取的迟到数据不得出现。
    const fresh = render(<ToolDirectoryPanel />);
    await act(async () => {});
    expect(screen.queryByText("memory.query")).toBeNull();
    fresh.unmount();
  });
});
