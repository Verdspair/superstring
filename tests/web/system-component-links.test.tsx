import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SkillCatalogResponse } from "../../src/shared/contracts/skill";
import type { ToolDirectoryResponse } from "../../src/shared/contracts/tool-directory";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { SystemComponents } from "../../src/web/screens/connections/system-components";
import { useSuperstringStore as store } from "../../src/web/store";
import {
  CAPABILITY_CATALOG,
  capabilityComponents,
} from "../../src/web/workspace/capability-catalog";

const toolFixture: ToolDirectoryResponse = {
  tools: [
    {
      name: "memory.query",
      description: "Search memories",
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
      globalEnabled: true,
      functionId: "memory-query",
      resource: null,
      revision: null,
      approvalRequired: false,
      directories: [],
    },
    {
      name: "knowledge.query",
      description: "Search knowledge",
      parameters: {},
      capability: "knowledge",
      effect: "read",
      sandboxCallable: true,
      origin: "system",
      globalEnabled: true,
      functionId: "knowledge-query",
      resource: null,
      revision: null,
      approvalRequired: false,
      directories: [],
    },
    {
      name: "history.query",
      description: "Query session history",
      parameters: {},
      capability: "history",
      effect: "read",
      sandboxCallable: true,
      origin: "system",
      globalEnabled: true,
      functionId: "session-history-summary",
      resource: null,
      revision: null,
      approvalRequired: false,
      directories: [],
    },
  ],
};

const skillFixture: SkillCatalogResponse = {
  skills: [
    {
      name: "system-evidence-reading",
      description: "Evidence reading guide",
      revision: "rev-1",
      origin: "system",
      globalEnabled: true,
    },
    {
      name: "system-qq-reply",
      description: "QQ reply guide",
      revision: "rev-1",
      origin: "system",
      globalEnabled: true,
    },
  ],
  problems: [],
};

afterEach(cleanup);
beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests({
    ...api,
    getToolDirectory: vi.fn().mockResolvedValue(toolFixture),
    getSkills: vi.fn().mockResolvedValue(skillFixture),
  } as unknown as typeof api);
});

it("links functions to honest tools and guides without falsified associations or invented MCP", () => {
  for (const entry of CAPABILITY_CATALOG) {
    if (entry.id === "external-integrations") continue;
    const components = capabilityComponents(entry, toolFixture.tools);
    // 会话历史无独立技能，其余内置项均有严格对应的系统技能
    if (entry.id === "session-history-summary") {
      expect(components.filter((c) => c.kind === "skill")).toHaveLength(0);
    } else {
      expect(components.filter((c) => c.kind === "skill")).toHaveLength(1);
    }
    // 内置能力绝不捏造 MCP 服务
    expect(components.some((c) => c.kind === "mcp")).toBe(false);
  }
});

it("uses the common guarded navigation to open a concrete tool", async () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
  });
  const entry = CAPABILITY_CATALOG.find((capability) => capability.detail === "memory");
  if (!entry) throw new Error("missing capability");
  render(<SystemComponents entry={entry} active={true} />);

  const toolButton = await screen.findByRole("button", { name: /memory.query/ });
  fireEvent.click(toolButton);
  expect(store.getState()).toMatchObject({
    settingsRoute: "tool-grants",
    componentTarget: { kind: "tool", id: "memory.query" },
  });
});
