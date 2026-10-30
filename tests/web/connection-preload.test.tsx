import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionPolicySchema } from "../../src/shared/contracts/permissions";
import type { ToolDirectoryEntry } from "../../src/shared/contracts/tool-directory";
import { api } from "../../src/web/api";
import { selectLocale, translate } from "../../src/web/i18n";
import { McpPanel } from "../../src/web/screens/connections/mcp-panel";
import { ToolDirectoryPanel } from "../../src/web/screens/connections/tool-directory-panel";
import {
  invalidateToolDirectory,
  warmConnectionResources,
  warmMcpServers,
  warmToolDirectory,
} from "../../src/web/services/connection-resources";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

const tool = (name: string): ToolDirectoryEntry => ({
  name,
  description: "A registered read tool",
  parameters: { type: "object" },
  capability: "read",
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
  it("MCP 详情与工具面板共享读取，刷新后展示新发现并保留工具入口", async () => {
    const pending = Promise.withResolvers<{ tools: ToolDirectoryEntry[] }>();
    const getToolDirectory = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        tools: [tool("mcp.demo-server.new")],
      });
    const fake = {
      ...api,
      getMcpServers: vi.fn().mockResolvedValue(mcpStatus()),
      getPermissions: vi.fn().mockResolvedValue(permSnapshot()),
      getToolDirectory,
    } as unknown as typeof api;
    store.getState().resetForTests(fake);
    render(
      <>
        <McpPanel />
        <ToolDirectoryPanel />
      </>,
    );
    const server = await screen.findByText("演示服务");
    const row = server.closest("[data-server-id]") as HTMLElement;
    fireEvent.click(
      within(row).getByRole("button", { name: translate("connections.tools.details") }),
    );
    await act(async () => {});
    expect(getToolDirectory).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ tools: [tool("mcp.demo-server.old")] }));
    expect((await screen.findAllByText("mcp.demo-server.old")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: translate("common.dismissPanel") }));
    const refresh = screen.getAllByRole("button", {
      name: translate("connections.common.refresh"),
    })[0];
    fireEvent.click(refresh);
    expect((await screen.findAllByText("mcp.demo-server.new")).length).toBeGreaterThan(0);
    fireEvent.click(
      within(row).getByRole("button", { name: translate("connections.tools.details") }),
    );
    const detailButton = await screen.findByRole("button", { name: "mcp.demo-server.new" });
    fireEvent.click(detailButton);
    expect(store.getState().componentTarget).toEqual({ kind: "tool", id: "mcp.demo-server.new" });
  });

  it("详情隐藏取消最后消费者，恢复重读；API 切换隔离迟到错误", async () => {
    const first = Promise.withResolvers<{ tools: ToolDirectoryEntry[] }>();
    const oldRead = vi.fn().mockReturnValue(first.promise);
    const fake = {
      ...api,
      getMcpServers: vi.fn().mockResolvedValue(mcpStatus()),
      getPermissions: vi.fn().mockResolvedValue(permSnapshot()),
      getToolDirectory: oldRead,
    } as unknown as typeof api;
    store.getState().resetForTests(fake);
    const view = render(<McpPanel active />);
    const server = await screen.findByText("演示服务");
    fireEvent.click(
      within(server.closest("[data-server-id]") as HTMLElement).getByRole("button", {
        name: translate("connections.tools.details"),
      }),
    );
    await act(async () => {});
    expect(oldRead).toHaveBeenCalledTimes(1);
    const nextRead = vi.fn().mockResolvedValue({ tools: [tool("mcp.demo-server.fresh")] });
    const nextApi = { ...fake, getToolDirectory: nextRead } as typeof api;
    act(() => store.setState({ apiClient: nextApi }));
    expect(oldRead.mock.calls[0][0].aborted).toBe(true);
    expect(await screen.findByRole("button", { name: "mcp.demo-server.fresh" })).toBeTruthy();
    view.rerender(<McpPanel active={false} />);
    view.rerender(<McpPanel active />);
    expect(await screen.findByRole("button", { name: "mcp.demo-server.fresh" })).toBeTruthy();
    await act(async () => first.reject(new Error("late failure")));
    expect(screen.queryByText("late failure")).toBeNull();
    expect(nextRead).toHaveBeenCalledTimes(2);
  });

  it("恢复只静默复验一次，显式刷新与 API 身份切换仍可重读", async () => {
    const firstRead = vi.fn().mockResolvedValue({ tools: [tool("memory.query")] });
    const fake = {
      ...api,
      getToolDirectory: firstRead,
      getPermissions: vi.fn().mockResolvedValue(permSnapshot()),
    } as unknown as typeof api;
    store.getState().resetForTests(fake);
    const view = render(<ToolDirectoryPanel active />);
    expect(await screen.findByText("memory.query")).toBeTruthy();
    expect(firstRead).toHaveBeenCalledTimes(1);
    view.rerender(<ToolDirectoryPanel active={false} />);
    view.rerender(<ToolDirectoryPanel active />);
    await act(async () => {});
    expect(firstRead).toHaveBeenCalledTimes(2);
    view.rerender(<ToolDirectoryPanel active={false} />);
    view.rerender(<ToolDirectoryPanel active />);
    await act(async () => {});
    expect(firstRead).toHaveBeenCalledTimes(2);
    fireEvent.blur(window);
    fireEvent.focus(window);
    await act(async () => {});
    expect(firstRead).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: translate("connections.common.refresh") }));
    await vi.waitFor(() => expect(firstRead).toHaveBeenCalledTimes(3));

    const secondRead = vi.fn().mockResolvedValue({ tools: [tool("memory.read")] });
    const secondApi = { ...fake, getToolDirectory: secondRead } as typeof api;
    act(() => store.setState({ apiClient: secondApi }));
    expect(await screen.findByText("memory.read")).toBeTruthy();
    expect(secondRead).toHaveBeenCalledTimes(1);
    view.rerender(<ToolDirectoryPanel active={false} />);
    view.rerender(<ToolDirectoryPanel active />);
    await act(async () => {});
    expect(secondRead).toHaveBeenCalledTimes(2);
  });

  it("API 换成已预热资源后仍重新验证，而不是沿用旧 API 的标记", async () => {
    const firstRead = vi.fn().mockResolvedValue({ tools: [tool("memory.query")] });
    const secondRead = vi.fn().mockResolvedValue({ tools: [tool("memory.read")] });
    const fake = {
      ...api,
      getToolDirectory: firstRead,
      getPermissions: vi.fn().mockResolvedValue(permSnapshot()),
    } as unknown as typeof api;
    const secondApi = { ...fake, getToolDirectory: secondRead } as typeof api;
    store.getState().resetForTests(fake);
    await warmToolDirectory(secondApi);
    const view = render(<ToolDirectoryPanel active />);
    expect(await screen.findByText("memory.query")).toBeTruthy();
    view.rerender(<ToolDirectoryPanel active={false} />);
    view.rerender(<ToolDirectoryPanel active />);
    await act(async () => {});
    expect(firstRead).toHaveBeenCalledTimes(2);
    act(() => store.setState({ apiClient: secondApi }));
    expect(await screen.findByText("memory.read")).toBeTruthy();
    await vi.waitFor(() => expect(secondRead).toHaveBeenCalledTimes(2));
  });

  it("一次静默复验在隐藏时被取消，恢复必须重新读取", async () => {
    const pending = Promise.withResolvers<{ tools: ToolDirectoryEntry[] }>();
    const read = vi
      .fn()
      .mockResolvedValueOnce({ tools: [tool("memory.query")] })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ tools: [tool("memory.read")] });
    const fake = {
      ...api,
      getToolDirectory: read,
      getPermissions: vi.fn().mockResolvedValue(permSnapshot()),
    } as unknown as typeof api;
    store.getState().resetForTests(fake);
    const view = render(<ToolDirectoryPanel active />);
    expect(await screen.findByText("memory.query")).toBeTruthy();
    view.rerender(<ToolDirectoryPanel active={false} />);
    view.rerender(<ToolDirectoryPanel active />);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    view.rerender(<ToolDirectoryPanel active={false} />);
    expect(read.mock.calls[1][0].aborted).toBe(true);
    view.rerender(<ToolDirectoryPanel active />);
    expect(await screen.findByText("memory.read")).toBeTruthy();
    await act(async () => pending.resolve({ tools: [tool("memory.stale")] }));
    expect(screen.queryByText("memory.stale")).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("预热失效不取消预热持有者，完成后活跃消费者取得新目录", async () => {
    const pending = Promise.withResolvers<{ tools: ToolDirectoryEntry[] }>();
    const getToolDirectory = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ tools: [tool("mcp.demo-server.current")] });
    const fake = {
      ...api,
      getToolDirectory,
      getPermissions: vi.fn().mockResolvedValue(permSnapshot()),
    } as unknown as typeof api;
    store.getState().resetForTests(fake);
    const warm = warmToolDirectory(fake);
    render(<ToolDirectoryPanel />);
    await act(async () => {});
    act(() => invalidateToolDirectory(fake));
    expect(getToolDirectory.mock.calls[0][0].aborted).toBe(false);
    await act(async () => pending.resolve({ tools: [tool("mcp.demo-server.stale")] }));
    await expect(warm).resolves.toEqual({ tools: [tool("mcp.demo-server.stale")] });
    expect(await screen.findByText("mcp.demo-server.current")).toBeTruthy();
    expect(screen.queryByText("mcp.demo-server.stale")).toBeNull();
    expect(getToolDirectory).toHaveBeenCalledTimes(2);
  });

  it("两个消费者分别退场，最后隐藏才取消共享读取", async () => {
    const pending = Promise.withResolvers<{ tools: ToolDirectoryEntry[] }>();
    const getToolDirectory = vi.fn().mockReturnValue(pending.promise);
    const fake = {
      ...api,
      getToolDirectory,
      getMcpServers: vi.fn().mockResolvedValue(mcpStatus()),
      getPermissions: vi.fn().mockResolvedValue(permSnapshot()),
    } as unknown as typeof api;
    store.getState().resetForTests(fake);
    const view = render(
      <>
        <McpPanel />
        <ToolDirectoryPanel />
      </>,
    );
    const server = await screen.findByText("演示服务");
    fireEvent.click(
      within(server.closest("[data-server-id]") as HTMLElement).getByRole("button", {
        name: translate("connections.tools.details"),
      }),
    );
    await act(async () => {});
    expect(getToolDirectory).toHaveBeenCalledTimes(1);
    view.rerender(
      <>
        <McpPanel />
        <ToolDirectoryPanel active={false} />
      </>,
    );
    expect(getToolDirectory.mock.calls[0][0].aborted).toBe(false);
    view.rerender(
      <>
        <McpPanel active={false} />
        <ToolDirectoryPanel active={false} />
      </>,
    );
    expect(getToolDirectory.mock.calls[0][0].aborted).toBe(true);
    await act(async () => pending.resolve({ tools: [tool("mcp.demo-server.stale")] }));
    expect(screen.queryByText("mcp.demo-server.stale")).toBeNull();
  });

  it("保存、重载、删除成功后更新共享目录", async () => {
    const getToolDirectory = vi
      .fn()
      .mockResolvedValueOnce({ tools: [tool("mcp.demo-server.initial")] })
      .mockResolvedValueOnce({ tools: [tool("mcp.demo-server.saved")] })
      .mockResolvedValueOnce({ tools: [tool("mcp.demo-server.reloaded")] })
      .mockResolvedValueOnce({ tools: [] });
    const saveMcpServers = vi
      .fn()
      .mockResolvedValueOnce(mcpStatus("saved"))
      .mockResolvedValueOnce({ revision: "deleted", code: null, servers: [] });
    const reloadMcpServers = vi.fn().mockResolvedValue(mcpStatus("reloaded"));
    const fake = {
      ...api,
      getToolDirectory,
      saveMcpServers,
      reloadMcpServers,
      getMcpServers: vi.fn().mockResolvedValue(mcpStatus()),
      getPermissions: vi.fn().mockResolvedValue(permSnapshot()),
    } as unknown as typeof api;
    store.getState().resetForTests(fake);
    render(
      <>
        <McpPanel />
        <ToolDirectoryPanel />
      </>,
    );
    expect(await screen.findByText("mcp.demo-server.initial")).toBeTruthy();
    const row = (await screen.findByText("演示服务")).closest("[data-server-id]") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: translate("connections.manage") }));
    fireEvent.click(screen.getByRole("button", { name: translate("connections.mcp.save") }));
    expect(await screen.findByText("mcp.demo-server.saved")).toBeTruthy();
    expect(saveMcpServers.mock.calls[0][0].expectedRevision).toBe("mcp-r1");
    fireEvent.click(screen.getByRole("button", { name: translate("connections.mcp.reload") }));
    expect(await screen.findByText("mcp.demo-server.reloaded")).toBeTruthy();
    expect(reloadMcpServers).toHaveBeenCalledTimes(1);
    const updatedRow = (await screen.findByText("演示服务")).closest(
      "[data-server-id]",
    ) as HTMLElement;
    fireEvent.click(
      within(updatedRow).getByRole("button", { name: translate("connections.manage") }),
    );
    fireEvent.click(screen.getByRole("button", { name: translate("connections.mcp.delete") }));
    fireEvent.click(screen.getByRole("button", { name: translate("connections.confirm") }));
    await vi.waitFor(() => expect(saveMcpServers).toHaveBeenCalledTimes(2));
    expect(saveMcpServers.mock.calls[1][0]).toEqual({ expectedRevision: "reloaded", servers: [] });
    await vi.waitFor(() => expect(getToolDirectory).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(screen.queryByText("mcp.demo-server.reloaded")).toBeNull());
  });
  it("服务详情随状态变化更新，删除后关闭且不会随同 ID 重新出现", async () => {
    const readDirectory = vi.fn().mockResolvedValue({ tools: [tool("mcp.demo-server.item")] });
    const first = mcpStatus();
    const renamed = mcpStatus("renamed");
    renamed.servers[0].config.name = "更新后的服务";
    const getMcpServers = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(renamed)
      .mockResolvedValueOnce({ revision: "removed", code: null, servers: [] })
      .mockResolvedValueOnce(first);
    const fake = {
      ...api,
      getMcpServers,
      getToolDirectory: readDirectory,
      getPermissions: vi.fn().mockResolvedValue(permSnapshot()),
    } as unknown as typeof api;
    store.getState().resetForTests(fake);
    render(<McpPanel />);
    const row = (await screen.findByText("演示服务")).closest("[data-server-id]") as HTMLElement;
    fireEvent.click(
      within(row).getByRole("button", { name: translate("connections.tools.details") }),
    );
    expect(await screen.findByRole("dialog", { name: "演示服务" })).toBeTruthy();
    await screen.findByRole("button", { name: "mcp.demo-server.item" });
    // Only the status resource changes while the detail is open.
    await act(async () => {
      await warmMcpServers(fake, { force: true });
    });
    expect(await screen.findByRole("dialog", { name: "更新后的服务" })).toBeTruthy();
    await act(async () => {
      await warmMcpServers(fake, { force: true });
    });
    expect(screen.queryByRole("dialog", { name: "更新后的服务" })).toBeNull();
    await act(async () => {
      await warmMcpServers(fake, { force: true });
    });
    expect(screen.queryByRole("dialog", { name: "演示服务" })).toBeNull();
  });
});
