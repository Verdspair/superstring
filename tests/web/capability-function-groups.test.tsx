import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpStatusResponseSchema } from "../../src/shared/contracts/mcp";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import { SkillCatalogResponseSchema } from "../../src/shared/contracts/skill";
import type { ToolDirectoryResponse } from "../../src/shared/contracts/tool-directory";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { CapabilitiesWorkspace } from "../../src/web/screens/connections/CapabilitiesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";

const permissionsFixture: PermissionsResponse = {
  revision: "pr-1",
  policy: {
    version: 1,
    grants: [],
    execution: {
      research: true,
      code: true,
      modules: {
        mcp: true,
        skills: true,
        web: true,
        tasks: true,
        memoryJobs: true,
        knowledgeJobs: true,
        qqMedia: true,
        qqStickers: true,
      },
      maintenance: { memoryTimeoutSeconds: 3600, knowledgeTimeoutSeconds: 3600 },
      telemetry: { retentionDays: 14 },
      pausedTools: [],
      tasks: { concurrency: 2, retentionHours: 24, leaseSeconds: 30, pollMs: 500 },
      researchLimits: { maxPerRun: 2, maxSteps: 6, deadlineMs: 60_000, maxConclusionChars: 4_000 },
      codeLimits: {
        timeoutMs: 20_000,
        maxCalls: 32,
        concurrency: 3,
        memoryBytes: 33_554_432,
        maxTransferBytes: 1_048_576,
        maxConclusionChars: 4_000,
      },
      loop: {
        maxSteps: 16,
        readBatch: 3,
        noProgress: 3,
        concurrency: 4,
        modelConcurrency: 1,
        providerConcurrency: 1,
      },
      qq: { retryDelayMs: 15_000, maxAttempts: 3, deliveryTtlSeconds: 120 },
    },
  },
  resources: [],
};

const toolFixture: ToolDirectoryResponse = {
  tools: [
    {
      name: "memory.query",
      description: "Search memory",
      parameters: {},
      capability: "memory",
      effect: "read",
      sandboxCallable: true,
      origin: "system",
      globalEnabled: true,
      functionId: "memory-query",
      resource: null,
      revision: null,
      approvalRequired: false,
      directories: [],
    },
    {
      name: "memory.read",
      description: "Read memory content",
      parameters: {},
      capability: "memory",
      effect: "read",
      sandboxCallable: true,
      origin: "system",
      globalEnabled: false,
      functionId: "memory-query",
      resource: null,
      revision: null,
      approvalRequired: false,
      directories: [],
    },
    {
      name: "web.search",
      description: "Web search",
      parameters: {},
      capability: "web",
      effect: "read",
      sandboxCallable: true,
      origin: "system",
      globalEnabled: true,
      functionId: "web-access",
      resource: null,
      revision: null,
      approvalRequired: false,
      directories: [],
    },
    {
      name: "mcp.search-server.lookup",
      description: "MCP lookup",
      parameters: {},
      capability: "mcp.search-server",
      effect: "read",
      sandboxCallable: true,
      origin: "mcp",
      globalEnabled: true,
      functionId: null,
      resource: null,
      revision: null,
      approvalRequired: false,
      directories: [],
    },
  ],
};

const skillFixture = SkillCatalogResponseSchema.parse({
  skills: [
    {
      name: "system-evidence-reading",
      description: "Evidence reading",
      revision: "rev-1",
      origin: "system",
      globalEnabled: true,
    },
    {
      name: "system-web-research",
      description: "Web research",
      revision: "rev-1",
      origin: "system",
      globalEnabled: false,
    },
    {
      name: "system-qq-reply",
      description: "QQ reply",
      revision: "rev-1",
      origin: "system",
      globalEnabled: true,
    },
    {
      name: "custom-data-analysis",
      description: "Custom analysis",
      revision: "rev-1",
      origin: "external",
      globalEnabled: true,
    },
  ],
  problems: [],
});

const mcpFixture = McpStatusResponseSchema.parse({
  revision: "rev-1",
  code: null,
  servers: [
    {
      config: {
        id: "search-server",
        name: "Search Hub",
        transport: "stdio",
        command: "node",
        args: [],
        env: {},
        enabled: true,
        timeoutMs: 15000,
        maxResultChars: 8000,
      },
      state: "connected",
      code: null,
      tools: [],
    },
    {
      config: {
        id: "offline-server",
        name: "Offline Storage",
        transport: "stdio",
        command: "node",
        args: [],
        env: {},
        enabled: false,
        timeoutMs: 15000,
        maxResultChars: 8000,
      },
      state: "disabled",
      code: null,
      tools: [],
    },
  ],
});

let getPermissionsMock = vi.fn();
let getToolDirectoryMock = vi.fn();
let getSkillsMock = vi.fn();
let getMcpServersMock = vi.fn();
let getSkillMock = vi.fn();

beforeEach(() => {
  selectLocale("zh-CN");
  getPermissionsMock = vi.fn().mockResolvedValue(permissionsFixture);
  getToolDirectoryMock = vi.fn().mockResolvedValue(toolFixture);
  getSkillsMock = vi.fn().mockResolvedValue(skillFixture);
  getMcpServersMock = vi.fn().mockResolvedValue(mcpFixture);
  getSkillMock = vi.fn();

  store.getState().resetForTests({
    ...api,
    getPermissions: getPermissionsMock,
    getToolDirectory: getToolDirectoryMock,
    getSkills: getSkillsMock,
    getMcpServers: getMcpServersMock,
    getSkill: getSkillMock,
  } as unknown as typeof api);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("5 Function Groups in Capabilities Workspace", () => {
  it("renders all 5 big function groups with clear headers and dividers", async () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});

    expect(screen.getByRole("heading", { name: "资料与历史读取" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "联网能力" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "QQ 对话与媒体" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "任务与执行限制" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "外置扩展与集成" })).toBeTruthy();
  });

  it("reads shared metadata once across cards without per-card spamming and zero getSkill body prefetch", async () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});

    // 目录中各卡片共享同一资源，不按卡片重复派发请求
    expect(getToolDirectoryMock).toHaveBeenCalledTimes(1);
    expect(getSkillsMock).toHaveBeenCalledTimes(1);
    expect(getMcpServersMock).toHaveBeenCalledTimes(1);

    // 绝不预取 Skill 完整正文
    expect(getSkillMock).not.toHaveBeenCalled();
  });

  it("renders QQ reply with honest skill and runtime action, navigating to qq-app-schemes", async () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});

    const qqButton = screen.getByRole("button", { name: /^QQ 对话与接话/ });
    expect(qqButton).toBeTruthy();
    expect(screen.getByText("speech.reply")).toBeTruthy();
    expect(screen.getByText("运行时动作")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /system-qq-reply/ })).toBeTruthy();

    fireEvent.click(qqButton);
    expect(store.getState().settingsRoute).toBe("qq-app-schemes");
  });

  it("renders external MCP integrations with accurate connected count and navigation", async () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});

    expect(await screen.findByText("1 个已连接服务")).toBeTruthy();

    const serverButton = await screen.findByRole("button", { name: "Search Hub" });
    fireEvent.click(serverButton);
    expect(store.getState().componentTarget).toMatchObject({ kind: "mcp", id: "search-server" });

    fireEvent.click(screen.getByRole("button", { name: "管理 MCP 服务" }));
    expect(store.getState().settingsRoute).toBe("mcp-servers");
  });

  it("filters capabilities and components by technical and server names while preserving group context", async () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});

    const searchInput = screen.getByRole("textbox", { name: "搜索能力、关键词或技术名" });

    // 1. 搜索 technical ID "web.search"，保留所属大组 "联网能力" 上下文
    fireEvent.change(searchInput, { target: { value: "web.search" } });
    expect(screen.getByRole("heading", { name: "联网能力" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "资料与历史读取" })).toBeNull();

    // 2. 搜索外部 MCP 服务名 "Search Hub"，匹配大组 "外置扩展与集成"
    fireEvent.change(searchInput, { target: { value: "Search Hub" } });
    expect(screen.getByRole("heading", { name: "外置扩展与集成" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "联网能力" })).toBeNull();
  });

  it("renders disabled tools and skills in gray with off reason while keeping details clickable", async () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});

    // memory.read 在 fixture 中 globalEnabled: false
    const offToolButton = await screen.findByRole("button", { name: /memory.read/ });
    expect(offToolButton).toBeTruthy();
    expect(offToolButton.textContent).toContain("全局已关闭");

    // 点击仍可打开定义抽屉
    fireEvent.click(offToolButton);
    expect(store.getState().componentTarget).toMatchObject({ kind: "tool", id: "memory.read" });
  });

  it("shows honest error retry instead of false empty success when catalog read fails", async () => {
    getToolDirectoryMock = vi.fn().mockRejectedValue(new Error("Network failed"));
    store.getState().resetForTests({
      ...api,
      getPermissions: getPermissionsMock,
      getToolDirectory: getToolDirectoryMock,
      getSkills: getSkillsMock,
      getMcpServers: getMcpServersMock,
    } as unknown as typeof api);

    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});

    // 报错时展示失败信息并提供重试入口，绝不冒充空成功
    const alert = await screen.findAllByRole("alert");
    expect(alert.length).toBeGreaterThan(0);
  });

  it("reports server problem code on McpStatusResponse without claiming false empty state", async () => {
    const errorMcpFixture = McpStatusResponseSchema.parse({
      revision: "rev-2",
      code: "MCP_CONFIG_PARSE_ERROR",
      servers: [],
    });
    store.getState().resetForTests({
      ...api,
      getPermissions: getPermissionsMock,
      getToolDirectory: getToolDirectoryMock,
      getSkills: getSkillsMock,
      getMcpServers: vi.fn().mockResolvedValue(errorMcpFixture),
    } as unknown as typeof api);

    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});

    // 含有错误码时不应展示假空态 "尚未登记 MCP 服务"
    expect((await screen.findAllByText(/MCP_CONFIG_PARSE_ERROR/)).length).toBeGreaterThan(0);
    expect(screen.queryByText("尚未登记 MCP 服务")).toBeNull();
  });
  it("keeps catalog failures visible when a search has no match and retries the shared read", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("catalog offline"))
      .mockResolvedValue(toolFixture);
    store.setState({
      apiClient: { ...store.getState().apiClient, getToolDirectory: read },
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    render(<CapabilitiesWorkspace />);
    await act(async () => {});
    fireEvent.change(screen.getByRole("textbox", { name: "搜索能力、关键词或技术名" }), {
      target: { value: "unmatched-component" },
    });
    expect(screen.getByRole("alert").textContent).toContain("catalog offline");
    expect(screen.queryByText("没有匹配的能力")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("没有匹配的能力")).toBeTruthy();
  });
});
