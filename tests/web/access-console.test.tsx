import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpStatusResponse } from "../../src/shared/contracts/mcp";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import type { SkillCatalogResponse, SkillDetailResponse } from "../../src/shared/contracts/skill";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { ConnectionWorkspace } from "../../src/web/screens/connections/ConnectionWorkspace";
import { McpPanel } from "../../src/web/screens/connections/mcp-panel";
import { SkillsPanel } from "../../src/web/screens/connections/skills-panel";
import { ToolGrantsPanel } from "../../src/web/screens/connections/tool-grants-panel";
import { ExecutionSettings } from "../../src/web/screens/runs/execution-settings";
import { TaskLedger } from "../../src/web/screens/runs/task-ledger";
import { useSuperstringStore as store } from "../../src/web/store";

const PROVIDER = {
  id: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
};
const mcpStatus: McpStatusResponse = {
  revision: "rev-1",
  code: null,
  servers: [
    {
      config: {
        id: "echo",
        name: "Echo",
        transport: "stdio",
        enabled: true,
        command: "node",
        args: ["server.mjs"],
        env: { TOKEN: "$SYNTHETIC_TOKEN" },
        timeoutMs: 15_000,
        maxResultChars: 8_000,
      },
      state: "connected",
      code: null,
      tools: [{ name: "read", description: "read notes", readOnly: true }],
    },
    {
      config: {
        id: "remote",
        name: "Remote",
        transport: "http",
        enabled: true,
        url: "https://mcp.invalid/mcp",
        authorizationEnv: "SYNTHETIC_TOKEN",
        timeoutMs: 15_000,
        maxResultChars: 8_000,
      },
      state: "error",
      code: "MCP_CONNECT_FAILED",
      tools: [],
    },
  ],
};
const permissions: PermissionsResponse = {
  revision: "pr-1",
  policy: {
    version: 1,
    grants: [
      { resource: "mcp.echo.read", approved: false, revision: "r1", directories: [] },
      { resource: "skill.demo.echo", approved: true, revision: "r2", directories: ["/data/out"] },
    ],
    execution: {
      research: false,
      code: false,
      modules: {
        mcp: true,
        skills: true,
        web: false,
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
  resources: [
    {
      name: "mcp.echo.read",
      description: "read notes",
      effect: "read",
      resource: "mcp.echo.read",
      revision: "r1",
      approvalRequired: true,
    },
    {
      name: "skill.demo.echo",
      description: "echo",
      effect: "write",
      resource: "skill.demo.echo",
      revision: "r2",
      approvalRequired: true,
      directories: ["/data/out"],
    },
  ],
};

async function renderWith(fake: Partial<typeof api>, node: React.ReactNode) {
  store.getState().resetForTests({ ...api, ...fake } as unknown as typeof api);
  render(<>{node}</>);
  await act(async () => {});
}

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
});

// 接入工作区整屏渲染：面板行为在各自 describe 里按组件验证，这里只提供读取答案。
async function renderWorkspace(
  settingsRoute: "mcp-servers" | "skill-catalog" | "tool-grants" | "basic",
  settingsView: "workspace" | "operating-mode" = "workspace",
) {
  const fake = {
    ...api,
    getQqSettings: vi.fn().mockResolvedValue({
      enabled: false,
      account_id: null,
      judgement_model_name: null,
      transport: { endpoint: null, has_token: false },
      revision: 1,
    }),
    getQqOwner: vi
      .fn()
      .mockResolvedValue({ configured: false, account_id: null, peer_id: null, revision: null }),
    getQqStatus: vi.fn().mockResolvedValue({ connection: { phase: "idle", reason: null } }),
    listQqConversations: vi.fn().mockResolvedValue([]),
    listQqBindings: vi.fn().mockResolvedValue([]),
    listQqSchemes: vi.fn().mockResolvedValue([]),
    getMcpServers: vi.fn().mockResolvedValue(mcpStatus),
    getSkills: vi.fn().mockResolvedValue({ skills: [], problems: [] }),
  } as unknown as typeof api;
  store.getState().resetForTests(fake);
  store.setState({ page: "settings", settingsView, settingsRoute });
  render(<ConnectionWorkspace />);
  await act(async () => {});
  return fake;
}

describe("connection workspace entry", () => {
  it.each([
    ["mcp-servers", "connections.mcp.title"],
    ["skill-catalog", "connections.skills.title"],
    ["tool-grants", "connections.tools.title"],
  ] as const)("renders the %s route as its own selected tab", async (route, tabKey) => {
    await renderWorkspace(route);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(i18n.t(tabKey));
  });

  it("defaults to MCP services and never loads or fakes the QQ connection", async () => {
    const fake = await renderWorkspace("basic", "operating-mode");
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      i18n.t("connections.mcp.title"),
    );
    // 接入只剩外置扩展：没有 QQ 连接 Tab、没有绑定列表，也不发起 QQ 读取。
    expect(screen.queryByRole("tab", { name: i18n.t("connections.transportPage.tab") })).toBeNull();
    expect(
      screen.queryByRole("tab", { name: i18n.t("connections.conversationBindings") }),
    ).toBeNull();
    expect(fake.getQqStatus).not.toHaveBeenCalled();
    expect(fake.getQqSettings).not.toHaveBeenCalled();
    expect(fake.listQqBindings).not.toHaveBeenCalled();
  });
});

describe("MCP panel", () => {
  it("shows per-server state, keeps credential references unexpanded and saves with the revision", async () => {
    const save = vi.fn().mockResolvedValue({ ...mcpStatus, revision: "rev-2" });
    const reload = vi.fn().mockResolvedValue(mcpStatus);
    await renderWith(
      {
        getMcpServers: vi.fn().mockResolvedValue(mcpStatus),
        saveMcpServers: save,
        reloadMcpServers: reload,
      },
      <McpPanel />,
    );
    expect(screen.getByText("已连接")).toBeTruthy();
    expect(screen.getByText("MCP_CONNECT_FAILED")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    await act(async () => {});
    expect(reload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: "管理" })[0]);
    const args = screen.getByLabelText("参数（每行一个）") as HTMLTextAreaElement;
    expect(args.value).toBe("server.mjs");
    const env = screen.getByLabelText("环境变量引用（每行 KEY=VALUE）") as HTMLTextAreaElement;
    expect(env.value).toBe("TOKEN=$SYNTHETIC_TOKEN");
    fireEvent.click(screen.getByRole("button", { name: "保存服务" }));
    await act(async () => {});
    expect(save).toHaveBeenCalledTimes(1);
    const [payload] = save.mock.calls[0];
    expect(payload.expectedRevision).toBe("rev-1");
    expect(payload.servers[0].env).toEqual({ TOKEN: "$SYNTHETIC_TOKEN" });
    expect(JSON.stringify(payload)).not.toContain("Bearer");
    expect(payload.servers[1].authorizationEnv).toBe("SYNTHETIC_TOKEN");
  });

  it("keeps annotation trust explicit and preserves it across edits", async () => {
    const save = vi.fn().mockResolvedValue({ ...mcpStatus, revision: "rev-2" });
    await renderWith(
      { getMcpServers: vi.fn().mockResolvedValue(mcpStatus), saveMcpServers: save },
      <McpPanel />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "管理" })[0]);
    const control = screen.getByRole("checkbox", { name: "信任此服务的只读声明" });
    expect(control.getAttribute("data-state")).toBe("unchecked");
    fireEvent.click(control);
    fireEvent.click(screen.getByRole("button", { name: "保存服务" }));
    await act(async () => {});
    expect(save.mock.calls[0][0].servers[0].trustToolAnnotations).toBe(true);
    expect(save.mock.calls[0][0].servers[1]).toEqual(mcpStatus.servers[1].config);
  });

  it("refuses an invalid entry before touching the server", async () => {
    const save = vi.fn();
    await renderWith(
      { getMcpServers: vi.fn().mockResolvedValue(mcpStatus), saveMcpServers: save },
      <McpPanel />,
    );
    fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
    fireEvent.change(screen.getByLabelText("服务 ID"), { target: { value: "Bad Id" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "保存服务" }));
    await act(async () => {});
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("服务 ID");
  });
});

describe("skills panel", () => {
  it("retains Skills error codes through the real HTTP client", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "SKILL_CATALOG_UNAVAILABLE", message: "Skill directory unavailable" },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      await renderWith({}, <SkillsPanel />);
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toBe(
          "[SKILL_CATALOG_UNAVAILABLE] Skill directory unavailable",
        ),
      );
    } finally {
      fetcher.mockRestore();
    }
  });

  const entry = {
    name: "demo",
    description: "Demo skill",
    revision: "rev",
    origin: "external" as const,
    globalEnabled: true,
  };
  const body = "# Demo\n\nBody text\n\n[Reference](references/guide.md)";
  const detail: SkillDetailResponse = {
    ...entry,
    instructions: `---\nname: demo\ndescription: Demo skill\n---\n${body}`,
    bodyChars: Array.from(`---\nname: demo\ndescription: Demo skill\n---\n${body}`).length,
  };
  const catalog: SkillCatalogResponse = {
    skills: [entry],
    problems: [{ skill: "broken", code: "SKILL_DOCUMENT_INVALID" }],
  };

  it.each(["zh-CN", "en"] as const)(
    "shows document skills and optional metadata without granting permissions (%s)",
    async (locale) => {
      selectLocale(locale);
      const labels =
        locale === "zh-CN"
          ? {
              view: "查看",
              type: "类型",
              document: "文档技能",
              license: "许可证",
              compatibility: "兼容性",
              metadata: "元数据",
              allowedTools: "allowed-tools（实验性）",
              boundary: "不运行技能附带脚本。引用文本按需读取尚未开放。",
              declaration: "文档声明不能授予权限。",
              approval: "仅展示声明原文，不授予权限，也不支持自动批准。",
            }
          : {
              view: "View",
              type: "Type",
              document: "Document skill",
              license: "License",
              compatibility: "Compatibility",
              metadata: "Metadata",
              allowedTools: "allowed-tools (experimental)",
              boundary:
                "Bundled scripts are not run. On-demand reading of referenced text is not yet available.",
              declaration: "Declarations cannot grant permissions.",
              approval:
                "Shown as declared; this grants no permissions and does not enable automatic approval.",
            };
      const standard: SkillDetailResponse = {
        ...detail,
        license: "Apache-2.0",
        compatibility: "Requires a text reader.\nNo network needed.",
        metadata: { author: "示例作者", version: "1.2" },
        "allowed-tools": "Bash(git:*) Read",
        instructions: [
          "---",
          "name: demo",
          "description: Demo skill",
          "license: Apache-2.0",
          "compatibility: |",
          "  Requires a text reader.",
          "  No network needed.",
          "metadata:",
          "  author: 示例作者",
          '  version: "1.2"',
          "allowed-tools: Bash(git:*) Read",
          "---",
          body,
        ].join("\n"),
      };
      const getSkill = vi.fn().mockResolvedValue(standard);
      const savePermissions = vi.fn();
      const approveTask = vi.fn();
      await renderWith(
        { getSkills: vi.fn().mockResolvedValue(catalog), getSkill, savePermissions, approveTask },
        <SkillsPanel />,
      );
      expect(screen.getByText("broken")).toBeTruthy();
      expect(screen.getByText("SKILL_DOCUMENT_INVALID")).toBeTruthy();
      expect(screen.getByRole("columnheader", { name: labels.type })).toBeTruthy();
      expect(screen.getByText(labels.document)).toBeTruthy();
      expect(screen.getByText(labels.boundary, { exact: false })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: labels.view }));
      await act(async () => {});
      expect(getSkill).toHaveBeenCalledWith("demo", expect.any(AbortSignal));
      const dialog = screen.getByRole("dialog", { name: "demo" });
      expect(dialog.querySelector("pre")?.textContent).toBe(standard.instructions);
      for (const heading of [
        labels.license,
        labels.compatibility,
        labels.metadata,
        labels.allowedTools,
      ]) {
        expect(within(dialog).getByRole("heading", { name: heading })).toBeTruthy();
      }
      expect(within(dialog).getByText("Apache-2.0").textContent).toBe(standard.license);
      expect(
        within(dialog).getByText(/Requires a text reader/, { selector: "p" }).textContent,
      ).toBe(standard.compatibility);
      expect(within(dialog).getByText("author").tagName).toBe("DT");
      expect(within(dialog).getByText("示例作者").tagName).toBe("DD");
      expect(within(dialog).getByText("version").tagName).toBe("DT");
      expect(within(dialog).getByText("1.2").tagName).toBe("DD");
      expect(within(dialog).getByText("Bash(git:*) Read").textContent).toBe(
        standard["allowed-tools"],
      );
      expect(within(dialog).getByText(labels.declaration, { exact: false })).toBeTruthy();
      expect(within(dialog).getByText(labels.approval)).toBeTruthy();
      expect(within(dialog).getAllByRole("button")).toHaveLength(1);
      expect(dialog.querySelector("a, input, textarea")).toBeNull();
      expect(savePermissions).not.toHaveBeenCalled();
      expect(approveTask).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["absent", {}],
    ["empty", { license: "", compatibility: " \n", metadata: {}, "allowed-tools": "" }],
  ] as const)("omits %s optional fields and keeps the full source", async (_kind, optional) => {
    await renderWith(
      {
        getSkills: vi.fn().mockResolvedValue(catalog),
        getSkill: vi.fn().mockResolvedValue({ ...detail, ...optional }),
      },
      <SkillsPanel />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    await act(async () => {});
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("pre")?.textContent).toBe(detail.instructions);
    expect(
      within(dialog)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["demo", "SKILL.md 原文"]);
    expect(dialog.querySelector("dl, table, a")).toBeNull();
    expect(within(dialog).queryByText("仅展示声明原文，不授予权限，也不支持自动批准。")).toBeNull();
  });

  it("renders malicious HTML and Markdown in every content field as text only", async () => {
    const description = '<img src="bad" onerror="alert(1)">';
    const license = '<a href="javascript:alert(1)">License</a>';
    const compatibility = '<iframe srcdoc="bad"></iframe>\n[Help](javascript:alert(1))';
    const key = '<svg data-skill-payload="true" onload="alert(1)">';
    const value = '<script>alert("metadata")</script>';
    const allowedTools = '<img src="tools" onerror="alert(2)"> Read';
    const instructions = `${detail.instructions}\n<script>alert("body")</script>`;
    await renderWith(
      {
        getSkills: vi.fn().mockResolvedValue({ skills: [{ ...entry, description }], problems: [] }),
        getSkill: vi.fn().mockResolvedValue({
          ...detail,
          description,
          license,
          compatibility,
          metadata: { [key]: value },
          "allowed-tools": allowedTools,
          instructions,
        }),
      },
      <SkillsPanel />,
    );
    expect(within(screen.getByRole("table")).getByText(description).textContent).toBe(description);
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    await act(async () => {});
    const dialog = screen.getByRole("dialog");
    for (const text of [description, license, key, value, allowedTools]) {
      expect(within(dialog).getByText(text).textContent).toBe(text);
    }
    expect(within(dialog).getByText(/srcdoc/).textContent).toBe(compatibility);
    expect(dialog.querySelector("pre")?.textContent).toBe(instructions);
    expect(document.querySelector("script, img, iframe, a, [data-skill-payload]")).toBeNull();
  });

  it("shows catalog errors, retries with refresh and updates the empty state", async () => {
    const pending = Promise.withResolvers<SkillCatalogResponse>();
    const getSkills = vi
      .fn()
      .mockRejectedValueOnce(new Error("Catalog unavailable"))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ skills: [], problems: [] });
    await renderWith({ getSkills }, <SkillsPanel />);
    expect(screen.getByRole("alert").textContent).toBe("Catalog unavailable");
    const refresh = screen.getByRole("button", { name: "刷新" });
    fireEvent.click(refresh);
    await act(async () => {});
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(refresh);
    expect(getSkills).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(catalog));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("文档技能")).toBeTruthy();
    expect((refresh as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(refresh);
    await act(async () => {});
    expect(screen.getByText(/未发现文档技能/)).toBeTruthy();
    expect(screen.queryByText("demo")).toBeNull();
    expect(screen.queryByText("broken")).toBeNull();
  });

  it("shows detail errors without opening the sheet and allows retry after close", async () => {
    const getSkill = vi
      .fn()
      .mockRejectedValueOnce(new Error("SKILL_NOT_FOUND"))
      .mockResolvedValue(detail);
    await renderWith({ getSkills: vi.fn().mockResolvedValue(catalog), getSkill }, <SkillsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toBe("SKILL_NOT_FOUND");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("dialog").querySelector("pre")?.textContent).toBe(detail.instructions);
    fireEvent.click(screen.getByRole("button", { name: "关闭面板" }));
    expect(getSkill.mock.calls[1][1].aborted).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    await act(async () => {});
    expect(screen.getByRole("dialog", { name: "demo" })).toBeTruthy();
    expect(getSkill).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["success", false],
    ["error", false],
    ["success", true],
    ["error", true],
  ] as const)("ignores a replaced detail %s (closed: %s)", async (outcome, closed) => {
    const pending = Promise.withResolvers<SkillDetailResponse>();
    const nextEntry = { ...entry, name: "next", description: "Next skill" };
    const nextDetail = { ...detail, ...nextEntry, instructions: "# Current document" };
    const getSkill = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(nextDetail);
    await renderWith(
      {
        getSkills: vi.fn().mockResolvedValue({ skills: [entry, nextEntry], problems: [] }),
        getSkill,
      },
      <SkillsPanel />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "查看" })[0]);
    await act(async () => {});
    fireEvent.click(screen.getAllByRole("button", { name: "查看" })[1]);
    await act(async () => {});
    expect(getSkill.mock.calls[0][1].aborted).toBe(true);
    expect(screen.getByRole("dialog", { name: "next" })).toBeTruthy();
    if (closed) fireEvent.click(screen.getByRole("button", { name: "关闭面板" }));
    await act(async () => {
      if (outcome === "success") pending.resolve(detail);
      else pending.reject(new Error("Late detail error"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Body text/)).toBeNull();
    if (closed) expect(screen.queryByRole("dialog")).toBeNull();
    else {
      expect(screen.getByRole("dialog", { name: "next" }).querySelector("pre")?.textContent).toBe(
        nextDetail.instructions,
      );
    }
  });

  it.each(["success", "error"] as const)(
    "cancels catalog and detail reads on unmount and ignores late %s after remount",
    async (outcome) => {
      const pendingCatalog = Promise.withResolvers<SkillCatalogResponse>();
      const pendingDetail = Promise.withResolvers<SkillDetailResponse>();
      const getSkills = vi
        .fn()
        .mockResolvedValueOnce(catalog)
        .mockReturnValue(pendingCatalog.promise);
      const getSkill = vi.fn().mockReturnValue(pendingDetail.promise);
      await renderWith({ getSkills, getSkill }, <SkillsPanel />);
      fireEvent.click(screen.getByRole("button", { name: "查看" }));
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await act(async () => {});
      expect(getSkills).toHaveBeenCalledTimes(2);
      expect(getSkill).toHaveBeenCalledTimes(1);
      cleanup();
      expect(getSkills.mock.calls[1][0].aborted).toBe(true);
      expect(getSkill.mock.calls[0][1].aborted).toBe(true);
      await renderWith(
        { getSkills: vi.fn().mockResolvedValue({ skills: [], problems: [] }) },
        <SkillsPanel />,
      );
      await act(async () => {
        if (outcome === "success") {
          pendingCatalog.resolve(catalog);
          pendingDetail.resolve(detail);
        } else {
          pendingCatalog.reject(new Error("Late catalog error"));
          pendingDetail.reject(new Error("Late detail error"));
        }
      });
      expect(screen.getByText(/未发现文档技能/)).toBeTruthy();
      expect(screen.queryByText("demo")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect((screen.getByRole("button", { name: "刷新" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    },
  );

  it.each(["zh-CN", "en"] as const)(
    "describes document skills and leaves web/QQ media modules to their capability pages (%s)",
    async (locale) => {
      selectLocale(locale);
      await renderWith(
        { getPermissions: vi.fn().mockResolvedValue(permissions) },
        <ExecutionSettings />,
      );
      expect(
        screen.getByText(
          locale === "zh-CN"
            ? "控制文档技能的发现与读取；关闭保留技能文件和现有授权。"
            : "Controls document skill discovery and reading. Turning it off keeps skill files and existing grants.",
        ),
      ).toBeTruthy();
      for (const label of locale === "zh-CN"
        ? ["使用联网工具", "按需理解 QQ 图片", "QQ 表情发送"]
        : ["Use web tools", "Understand QQ images on demand", "Send QQ stickers"]) {
        expect(screen.queryByText(label)).toBeNull();
      }
    },
  );
});

describe("tool grants", () => {
  it("edits one grant without touching the others and saves with the revision", async () => {
    const save = vi.fn().mockResolvedValue({ revision: "pr-2", policy: permissions.policy });
    await renderWith(
      { getPermissions: vi.fn().mockResolvedValue(permissions), savePermissions: save },
      <ToolGrantsPanel scope="external" />,
    );
    expect(screen.getByText("MCP 工具")).toBeTruthy();
    expect(screen.getByText("已存技能授权")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("持续批准 mcp.echo.read"));
    fireEvent.click(screen.getByRole("button", { name: "保存授权" }));
    await act(async () => {});
    const [payload] = save.mock.calls[0];
    expect(payload.expectedRevision).toBe("pr-1");
    expect(payload.policy.grants).toHaveLength(2);
    expect(payload.policy.grants[0]).toMatchObject({ resource: "mcp.echo.read", approved: true });
    expect(payload.policy.grants[1]).toMatchObject({
      resource: "skill.demo.echo",
      approved: true,
      directories: ["/data/out"],
    });
    // 未改动的执行分组原样带回。
    expect(payload.policy.execution.loop.maxSteps).toBe(16);
    expect(screen.getByRole("status").textContent).toContain("授权已保存");
  });

  it("keeps the draft and reports a conflict without overwriting it", async () => {
    const save = vi.fn().mockRejectedValue(new Error("权限配置已变化，请重新读取后保存"));
    await renderWith(
      { getPermissions: vi.fn().mockResolvedValue(permissions), savePermissions: save },
      <ToolGrantsPanel scope="external" />,
    );
    fireEvent.click(screen.getByLabelText("持续批准 mcp.echo.read"));
    fireEvent.click(screen.getByRole("button", { name: "保存授权" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("权限配置已变化");
    expect(screen.getByLabelText("持续批准 mcp.echo.read").getAttribute("data-state")).toBe(
      "checked",
    );
  });
});

describe("task ledger", () => {
  it("lists tasks, pages the result body and approves once with the ticket", async () => {
    const approve = vi.fn().mockResolvedValue({ ok: true });
    await renderWith(
      {
        listTasks: vi.fn().mockResolvedValue({
          items: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              conversationId: PROVIDER.conversationId,
              agentId: PROVIDER.agentId,
              originRunId: null,
              status: "waiting_approval",
              createdAt: "2026-09-28T00:00:00.000Z",
              updatedAt: "2026-09-28T00:00:00.000Z",
              expiresAt: "2026-09-29T00:00:00.000Z",
              errorCode: null,
              callCount: 1,
              completedCallCount: 0,
              waitingOrdinal: 0,
              waitingReason: "approval",
            },
          ],
          nextCursor: null,
          hasMore: false,
        }),
        getTask: vi.fn().mockResolvedValue({
          id: "44444444-4444-4444-8444-444444444444",
          conversationId: PROVIDER.conversationId,
          agentId: PROVIDER.agentId,
          originRunId: null,
          status: "waiting_approval",
          createdAt: "2026-09-28T00:00:00.000Z",
          updatedAt: "2026-09-28T00:00:00.000Z",
          expiresAt: "2026-09-29T00:00:00.000Z",
          errorCode: null,
          callCount: 1,
          completedCallCount: 0,
          waitingOrdinal: 0,
          waitingReason: "approval",
          dataStatus: "available",
          calls: [
            {
              ordinal: 0,
              name: "fixture.write",
              revision: "v1",
              effect: "write",
              status: "waiting_approval",
              approvalRevision: "ticket-1",
              errorCode: null,
              argumentsPreview: {
                status: "available",
                text: '{"note":"synthetic"}',
                offset: 0,
                total: 20,
                nextOffset: null,
              },
              resultStatus: "pending",
            },
          ],
        }),
        getTaskBody: vi.fn().mockResolvedValue({
          status: "available",
          text: '{"note":"synthetic"}',
          offset: 0,
          total: 20,
          nextOffset: null,
        }),
        approveTask: approve,
      },
      <TaskLedger />,
    );
    expect(within(screen.getByRole("table")).getByText("等待批准")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    await act(async () => {});
    expect(screen.getByText("fixture.write")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "参数" }));
    await act(async () => {});
    expect(screen.getByText('{"note":"synthetic"}')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "核对并批准" }));
    fireEvent.click(screen.getByRole("button", { name: "批准这一次" }));
    await act(async () => {});
    expect(approve).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444", {
      ordinal: 0,
      expectedApproval: "ticket-1",
      approve: true,
    });
  });
});

describe("execution settings", () => {
  it("saves edited numbers with the revision and refuses out-of-range values", async () => {
    const save = vi.fn().mockResolvedValue({ revision: "pr-2", policy: permissions.policy });
    await renderWith(
      { getPermissions: vi.fn().mockResolvedValue(permissions), savePermissions: save },
      <ExecutionSettings />,
    );
    const steps = screen.getByLabelText("决策步数上限") as HTMLInputElement;
    expect(steps.value).toBe("16");
    fireEvent.change(steps, { target: { value: "64" } });
    const memory = screen.getByLabelText("guest 内存（MiB）") as HTMLInputElement;
    expect(memory.value).toBe("32");
    fireEvent.change(memory, { target: { value: "64" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await act(async () => {});
    const [payload] = save.mock.calls[0];
    expect(payload.expectedRevision).toBe("pr-1");
    expect(payload.policy.execution.loop.maxSteps).toBe(64);
    expect(payload.policy.execution.codeLimits.memoryBytes).toBe(64 * 1_048_576);
    expect(payload.policy.execution.tasks.concurrency).toBe(2);
    expect(screen.getByRole("status").textContent).toContain("执行设置已保存");
  });

  it("saves code concurrency without enabling code or changing other settings", async () => {
    const save = vi.fn(async ({ policy }: Parameters<typeof api.savePermissions>[0]) => ({
      revision: "pr-2",
      policy,
    }));
    await renderWith(
      { getPermissions: vi.fn().mockResolvedValue(permissions), savePermissions: save },
      <ExecutionSettings />,
    );
    const concurrency = screen.getByLabelText("每段脚本的工具并发上限") as HTMLInputElement;
    expect(concurrency.value).toBe("3");
    fireEvent.change(concurrency, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await act(async () => {});
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      expectedRevision: "pr-1",
      policy: {
        ...permissions.policy,
        execution: {
          ...permissions.policy.execution,
          code: false,
          codeLimits: { ...permissions.policy.execution?.codeLimits, concurrency: 5 },
        },
      },
    });
    expect(concurrency.value).toBe("5");
    expect(screen.getByRole("status").textContent).toContain("执行设置已保存");
  });

  it.each(["只读并行上限", "每段脚本的工具并发上限"])(
    "marks out-of-range %s instead of sending it",
    async (label) => {
      const save = vi.fn();
      await renderWith(
        { getPermissions: vi.fn().mockResolvedValue(permissions), savePermissions: save },
        <ExecutionSettings />,
      );
      const input = screen.getByLabelText(label) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "9" } });
      fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
      await act(async () => {});
      expect(save).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("超出允许范围"));
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.value).toBe("9");
    },
  );
});
