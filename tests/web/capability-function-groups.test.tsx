import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpStatusResponseSchema } from "../../src/shared/contracts/mcp";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import { SkillCatalogResponseSchema } from "../../src/shared/contracts/skill";
import type { ToolDirectoryResponse } from "../../src/shared/contracts/tool-directory";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { CapabilitiesWorkspace } from "../../src/web/screens/connections/CapabilitiesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

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
        qqMembers: true,
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
      system: { maxAttempts: 3, retryDelayMs: 2000 },
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

  it("keeps capability components collapsed until the capability trigger expands them, then navigates by its own button", async () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});

    const li = document.querySelector<HTMLElement>("[data-capability-id='qq-reply']")!;
    // 折叠时组件清单不渲染，导航入口是独立按钮（无 aria-expanded）。
    expect(screen.queryByText("reply.text")).toBeNull();
    const navButton = within(li).getByRole("button", { name: "前往配置功能 · QQ 对话与接话" });
    expect(navButton.hasAttribute("aria-expanded")).toBe(false);

    const trigger = within(li)
      .getAllByRole("button", { name: /QQ 对话与接话/ })
      .find((button) => button.getAttribute("aria-expanded") === "false");
    if (!trigger) throw new Error("missing collapsible trigger");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    // 展开后组件与运行时动作可见；技能/工具行仍可各自打开定义。
    expect(await screen.findByText("reply.text")).toBeTruthy();
    expect(screen.getByText("reply.sticker")).toBeTruthy();
    expect(screen.getByText("运行时动作")).toBeTruthy();
    const skillButton = await screen.findByRole("button", { name: /system-qq-reply/ });
    fireEvent.click(skillButton);
    expect(store.getState().componentTarget).toMatchObject({
      kind: "skill",
      id: "system-qq-reply",
    });

    fireEvent.click(navButton);
    expect(store.getState().settingsRoute).toBe("qq-app-schemes");
  });

  it("keeps external integrations collapsed and reveals the connected count only after expanding", async () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});

    const li = document.querySelector<HTMLElement>("[data-capability-id='external-integrations']")!;
    // 折叠时不显示已连接计数，也不显示服务清单。
    expect(screen.queryByText("1 个已连接服务")).toBeNull();
    expect(screen.queryByText("Search Hub")).toBeNull();

    const trigger = within(li)
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-expanded") !== null);
    if (!trigger) throw new Error("missing external integrations trigger");
    fireEvent.click(trigger);

    expect(await screen.findByText("1 个已连接服务")).toBeTruthy();
    const serverButton = await screen.findByRole("button", { name: /Search Hub/ });
    expect(serverButton).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(within(li).getByRole("button", { name: "管理 MCP 服务" }));
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

    // 3. 清空搜索恢复默认折叠（组件清单重新收起）。
    fireEvent.change(searchInput, { target: { value: "" } });
    expect(screen.queryByText("reply.text")).toBeNull();
  });

  it("renders disabled tools in gray with off reason inside the expanded capability while keeping them clickable", async () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});

    const li = document.querySelector<HTMLElement>("[data-capability-id='memory-query']")!;
    const trigger = within(li)
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-expanded") !== null);
    if (!trigger) throw new Error("missing capability trigger");
    fireEvent.click(trigger);

    // memory.read 在 fixture 中 globalEnabled: false；置灰但仍可点击打开定义。
    const offToolButton = await screen.findByRole("button", { name: /memory\.read/ });
    expect(offToolButton.textContent).toContain("全局已关闭");
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
