import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionPolicySchema } from "../../src/shared/contracts/permissions";
import type { ToolDirectoryEntry } from "../../src/shared/contracts/tool-directory";
import { api, type SuperstringApi } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { McpPanel } from "../../src/web/screens/connections/mcp-panel";
import { SkillsPanel } from "../../src/web/screens/connections/skills-panel";
import { ToolDirectoryPanel } from "../../src/web/screens/connections/tool-directory-panel";
import { useSuperstringStore as store } from "../../src/web/store";

const mcpStatus = () => ({
  revision: "mcp-r1",
  code: null,
  servers: [
    {
      config: {
        id: "demo-server",
        name: "演示服务",
        transport: "stdio" as const,
        command: "demo-cmd",
        enabled: true,
        timeoutMs: 15000,
        maxResultChars: 8000,
        args: [],
        env: {},
      },
      state: "connected" as const,
      code: null,
      tools: ["demo.tool1"],
    },
  ],
});

const skillCatalog = () => ({
  skills: [
    {
      name: "doc-helper",
      description: "帮助文档技能",
      revision: "s1",
      origin: "system" as const,
      globalEnabled: true,
    },
  ],
  problems: [],
});

const toolEntry: ToolDirectoryEntry = {
  name: "demo.tool1",
  description: "演示工具描述",
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
};

const permSnapshot = () => ({
  revision: "pr-1",
  policy: { version: 1, grants: [], execution: ExecutionPolicySchema.parse({}) },
  resources: [],
});

beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests({
    ...api,
    getMcpServers: vi.fn().mockResolvedValue(mcpStatus()),
    getSkills: vi.fn().mockResolvedValue(skillCatalog()),
    getToolDirectory: vi.fn().mockResolvedValue({ tools: [toolEntry] }),
    getPermissions: vi.fn().mockResolvedValue(permSnapshot()),
    getSkill: vi.fn().mockResolvedValue({
      name: "doc-helper",
      description: "帮助文档技能详情",
      instructions: "Skill instructions here",
      origin: "system",
      revision: "s1",
      globalEnabled: true,
      bodyChars: 23,
      metadata: { author: "system" },
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("extension panel activity and portal gates", () => {
  it("gates McpPanel detail sheet and editor modal when active becomes false while preserving state", async () => {
    const { rerender } = render(<McpPanel active={true} />);

    // Wait for server row to appear
    await screen.findByText("演示服务");

    // Click details to open Sheet
    fireEvent.click(screen.getByRole("button", { name: "查看详情" }));

    // Sheet content should be visible in portal
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeDefined();
    });

    // Rerender with active=false: Sheet must be closed/hidden from portal
    rerender(<McpPanel active={false} />);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // Rerender with active=true: Sheet should restore open state without user re-clicking
    rerender(<McpPanel active={true} />);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeDefined();
    });
  });

  it("gates SkillsPanel detail sheet and cancels in-flight detail read when inactive", async () => {
    let resolveSkill!: (value: Awaited<ReturnType<SuperstringApi["getSkill"]>>) => void;
    const pendingSkillPromise = new Promise<Awaited<ReturnType<SuperstringApi["getSkill"]>>>(
      (resolve) => {
        resolveSkill = resolve;
      },
    );
    const mockGetSkill = vi.fn<SuperstringApi["getSkill"]>().mockReturnValue(pendingSkillPromise);
    store.getState().resetForTests({
      ...api,
      getSkills: vi.fn().mockResolvedValue(skillCatalog()),
      getSkill: mockGetSkill,
    });

    const { rerender } = render(<SkillsPanel active={true} />);
    await screen.findByText("doc-helper");

    // Click "查看" to initiate detail read
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(mockGetSkill).toHaveBeenCalledWith("doc-helper", expect.anything());

    // Switch active to false while read is pending: should cancel pending read
    rerender(<SkillsPanel active={false} />);

    // Resolve after cancel: should not crash or populate sheet
    expect(mockGetSkill.mock.calls[0][1]?.aborted).toBe(true);
    await act(async () => {
      resolveSkill({
        name: "doc-helper",
        description: "帮助文档技能详情",
        instructions: "Skill instructions here",
        origin: "system",
        revision: "s1",
        globalEnabled: true,
        bodyChars: 23,
      });
    });

    expect(screen.queryByText("Skill instructions here")).toBeNull();
  });

  it("gates ToolDirectoryPanel detail sheet when inactive and restores when active", async () => {
    const { rerender } = render(<ToolDirectoryPanel active={true} />);

    await screen.findByText("demo.tool1");

    // Open detail
    fireEvent.click(screen.getByRole("button", { name: "查看详情" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeDefined();
    });

    // Inactive: detail sheet must be hidden
    rerender(<ToolDirectoryPanel active={false} />);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // Active: restored
    rerender(<ToolDirectoryPanel active={true} />);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeDefined();
    });
  });
});
