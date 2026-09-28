// P7-d 接入与运行页面的行为用例：读写形状、保真与关键操作。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpStatusResponse } from "../../src/shared/contracts/mcp";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
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
        tasks: true,
        memoryJobs: true,
        knowledgeJobs: true,
        qqMedia: true,
        qqStickers: true,
      },
      maintenance: { memoryTimeoutSeconds: 3600, knowledgeTimeoutSeconds: 3600 },
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
      approvalRequired: false,
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
  it("lists installable skills with problems and shows the read-only detail", async () => {
    const getSkill = vi.fn().mockResolvedValue({
      name: "demo",
      description: "Demo skill",
      revision: "rev",
      scriptCount: 1,
      instructions: "# demo\n\nBody text",
      bodyChars: 15,
      scripts: [
        {
          name: "echo",
          description: "Echo",
          command: "node",
          args: ["echo.mjs"],
          directories: ["data"],
          resolvedDirectories: ["/skills/demo/data"],
          timeoutMs: 60_000,
          maxOutputChars: 20_000,
          resource: "skill.demo.echo",
        },
      ],
    });
    await renderWith(
      {
        getSkills: vi.fn().mockResolvedValue({
          skills: [{ name: "demo", description: "Demo skill", revision: "rev", scriptCount: 1 }],
          problems: [{ skill: "broken", code: "SKILL_MANIFEST_INVALID" }],
        }),
        getSkill,
      },
      <SkillsPanel />,
    );
    expect(screen.getByText("broken")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    await act(async () => {});
    expect(getSkill).toHaveBeenCalledWith("demo", expect.anything());
    expect(screen.getByText(/Body text/)).toBeTruthy();
    expect(screen.getByText("skill.demo.echo")).toBeTruthy();
    expect(screen.getByText("/skills/demo/data")).toBeTruthy();
  });
});

describe("tool grants", () => {
  it("edits one grant without touching the others and saves with the revision", async () => {
    const save = vi.fn().mockResolvedValue({ revision: "pr-2", policy: permissions.policy });
    await renderWith(
      { getPermissions: vi.fn().mockResolvedValue(permissions), savePermissions: save },
      <ToolGrantsPanel />,
    );
    expect(screen.getByText("MCP 工具")).toBeTruthy();
    expect(screen.getByText("技能脚本")).toBeTruthy();
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
      <ToolGrantsPanel />,
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
