import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema } from "../../src/shared/contracts/agent";
import {
  ExecutionPolicySchema,
  type PermissionGrant,
  type PermissionsResponse,
} from "../../src/shared/contracts/permissions";
import { ToolDirectoryResponseSchema } from "../../src/shared/contracts/tool-directory";
import { api } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import {
  type PermissionScope,
  permissionSettingsDirty,
} from "../../src/web/features/access/permission-state";
import { selectLocale, translate } from "../../src/web/i18n";
import { AgentToolScope } from "../../src/web/screens/assistants/StudioEditors";
import { useSuperstringStore as store } from "../../src/web/store";

const AGENT_A = "agent-alpha-id";
const AGENT_B = "agent-beta-id";

const makeSnapshot = (overrides?: PermissionGrant["agentOverrides"]): PermissionsResponse => ({
  revision: "rev-1",
  policy: {
    version: 1,
    execution: ExecutionPolicySchema.parse({ pausedTools: [] }),
    grants: [
      {
        resource: "mcp.search.query",
        approved: false,
        revision: "v1",
        directories: ["/data/search"],
        agentOverrides: overrides,
      },
    ],
  },
  resources: [
    {
      name: "mcp.search.query",
      resource: "mcp.search.query",
      description: "Search documents",
      effect: "read",
      revision: "v1",
      approvalRequired: true,
      directories: ["/data/search"],
    },
  ],
});

beforeEach(() => {
  store.getState().resetForTests();
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("agent tool permission scope: scoped save and isolation contracts", () => {
  it("scoped save of Agent A override commits only Agent A, leaving Agent B override and global dirty untouched", async () => {
    let current = makeSnapshot({
      [AGENT_B]: {
        enabled: true,
        approved: true,
        revision: "v1",
        directories: ["/data/beta"],
      },
    });

    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      current = { ...current, policy: input.policy, revision: "rev-2" };
      return { revision: current.revision, policy: current.policy };
    });

    store.getState().resetForTests({ ...api, getPermissions: get, savePermissions: save });
    await store.getState().loadPermissionSettings();

    store.getState().patchToolGrant("mcp.search.query", { enabled: false });

    store.getState().patchToolGrant("mcp.search.query", {
      agentOverrides: {
        ...store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides,
        [AGENT_B]: {
          enabled: false,
          approved: false,
          revision: "v1",
          directories: [],
        },
      },
    });

    store.getState().patchToolGrant("mcp.search.query", {
      agentOverrides: {
        ...store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides,
        [AGENT_A]: {
          enabled: true,
          approved: true,
          revision: "v1",
          directories: ["/data/alpha"],
        },
      },
    });

    const scopedSelection: PermissionScope = {
      agentOverrides: [{ resource: "mcp.search.query", agentId: AGENT_A }],
    };

    const savedOk = await store.getState().savePermissionSettings(scopedSelection);
    expect(savedOk).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);

    const submittedPolicy = save.mock.calls[0][0].policy;
    const submittedOverrides = submittedPolicy.grants[0].agentOverrides ?? {};

    // Submitted payload must ONLY contain Agent A's override and preserved baseline for Agent B
    expect(submittedOverrides[AGENT_A]).toEqual({
      enabled: true,
      approved: true,
      revision: "v1",
      directories: ["/data/alpha"],
    });
    // Unsubmitted Agent B dirty override must NOT be sent to server (server receives baseline Agent B)
    expect(submittedOverrides[AGENT_B]).toEqual({
      enabled: true,
      approved: true,
      revision: "v1",
      directories: ["/data/beta"],
    });
    // Global pause must NOT be submitted
    expect(submittedPolicy.execution?.pausedTools).toEqual([]);

    const editor = store.getState().permissionEditor;
    if (!editor) throw new Error("Missing permissionEditor");
    expect(editor.grants["mcp.search.query"].enabled).toBe(false);
    expect(editor.grants["mcp.search.query"].agentOverrides?.[AGENT_B]?.enabled).toBe(false);
    expect(permissionSettingsDirty(editor)).toBe(true);
  });

  it("deleting Agent A override via scoped save removes key to restore inheritance without touching Agent B", async () => {
    let current = makeSnapshot({
      [AGENT_A]: {
        enabled: false,
        approved: false,
        revision: "v1",
        directories: [],
      },
      [AGENT_B]: {
        enabled: true,
        approved: true,
        revision: "v1",
        directories: ["/data/beta"],
      },
    });

    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      current = { ...current, policy: input.policy, revision: "rev-2" };
      return { revision: current.revision, policy: current.policy };
    });

    store.getState().resetForTests({ ...api, getPermissions: get, savePermissions: save });
    await store.getState().loadPermissionSettings();

    const nextOverrides = {
      ...store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides,
    };
    delete nextOverrides[AGENT_A];
    store.getState().patchToolGrant("mcp.search.query", { agentOverrides: nextOverrides });

    const scopedSelection: PermissionScope = {
      agentOverrides: [{ resource: "mcp.search.query", agentId: AGENT_A }],
    };

    const savedOk = await store.getState().savePermissionSettings(scopedSelection);
    expect(savedOk).toBe(true);

    const submittedOverrides = save.mock.calls[0][0].policy.grants[0].agentOverrides ?? {};
    expect(submittedOverrides[AGENT_A]).toBeUndefined();
    expect(submittedOverrides[AGENT_B]).toEqual({
      enabled: true,
      approved: true,
      revision: "v1",
      directories: ["/data/beta"],
    });
  });

  it("retains dirty agent overrides upon CAS 409 conflict and preserves them during refresh", async () => {
    let current = makeSnapshot();
    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      if (input.expectedRevision !== current.revision) {
        throw new Error("REVISION_CONFLICT");
      }
      current = { ...current, policy: input.policy, revision: "rev-2" };
      return { revision: current.revision, policy: current.policy };
    });

    store.getState().resetForTests({ ...api, getPermissions: get, savePermissions: save });
    await store.getState().loadPermissionSettings();

    store.getState().patchToolGrant("mcp.search.query", {
      agentOverrides: {
        [AGENT_A]: {
          enabled: true,
          approved: true,
          revision: "v1",
          directories: ["/data/a"],
        },
      },
    });

    current.revision = "rev-conflict";

    const scopedSelection: PermissionScope = {
      agentOverrides: [{ resource: "mcp.search.query", agentId: AGENT_A }],
    };

    const savedOk = await store.getState().savePermissionSettings(scopedSelection);
    expect(savedOk).toBe(false);

    expect(
      store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides?.[AGENT_A],
    ).toEqual({
      enabled: true,
      approved: true,
      revision: "v1",
      directories: ["/data/a"],
    });

    await store.getState().loadPermissionSettings(true);
    expect(store.getState().permissionEditor?.snapshot.revision).toBe("rev-conflict");
    expect(
      store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides?.[AGENT_A],
    ).toEqual({
      enabled: true,
      approved: true,
      revision: "v1",
      directories: ["/data/a"],
    });
  });

  it("identifies resource:null built-ins as first-class tools that must not be omitted or given fake grants", () => {
    const response = ToolDirectoryResponseSchema.parse({
      tools: [
        {
          name: "memory.query",
          description: "Query long-term memory",
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
          name: "mcp.search.query",
          description: "External MCP search",
          parameters: {},
          capability: "search",
          effect: "read",
          sandboxCallable: false,
          origin: "mcp",
          globalEnabled: true,
          functionId: null,
          resource: "mcp.search.query",
          revision: "v1",
          approvalRequired: true,
          directories: ["/data"],
        },
      ],
    });

    expect(response.tools.filter((t) => t.resource !== null).map((t) => t.name)).toEqual([
      "mcp.search.query",
    ]);

    const builtins = response.tools.filter((t) => t.resource === null);
    expect(builtins.length).toBe(1);
    expect(builtins[0].name).toBe("memory.query");
    expect(builtins[0].origin).toBe("system");
  });

  it("creates minimal disabled base grant when saving override for resource with no base grant", async () => {
    const snapshotNoGrant: PermissionsResponse = {
      revision: "rev-nogrant",
      policy: {
        version: 1,
        execution: ExecutionPolicySchema.parse({ pausedTools: [] }),
        grants: [],
      },
      resources: [
        {
          name: "mcp.custom.action",
          resource: "mcp.custom.action",
          description: "Custom Action",
          effect: "read",
          revision: "v2",
          approvalRequired: true,
          directories: [],
        },
      ],
    };

    let current = snapshotNoGrant;
    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      current = { ...current, policy: input.policy, revision: "rev-saved" };
      return { revision: current.revision, policy: current.policy };
    });

    store.getState().resetForTests({ ...api, getPermissions: get, savePermissions: save });
    await store.getState().loadPermissionSettings();

    store.getState().patchToolGrant("mcp.custom.action", {
      agentOverrides: {
        [AGENT_A]: {
          enabled: true,
          approved: true,
          revision: "v2",
          directories: [],
        },
      },
    });

    const scopedSelection: PermissionScope = {
      agentOverrides: [{ resource: "mcp.custom.action", agentId: AGENT_A }],
    };

    const savedOk = await store.getState().savePermissionSettings(scopedSelection);
    expect(savedOk).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);

    const submittedGrants = save.mock.calls[0][0].policy.grants;
    expect(submittedGrants.length).toBe(1);
    const newGrant = submittedGrants[0];
    expect(newGrant.resource).toBe("mcp.custom.action");
    // Minimal disabled base: approved: false, agentIds: [], revision: "v2", directories: []
    expect(newGrant.approved).toBe(false);
    expect(newGrant.agentIds).toEqual([]);
    expect(newGrant.revision).toBe("v2");
    expect(newGrant.agentOverrides?.[AGENT_A]).toEqual({
      enabled: true,
      approved: true,
      revision: "v2",
      directories: [],
    });
  });

  it("saving Agent A override preserves Agent B dirty deletion and retains unedited remote B", async () => {
    let current = makeSnapshot({
      [AGENT_B]: {
        enabled: true,
        approved: true,
        revision: "v1",
        directories: ["/data/b"],
      },
    });

    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      current = { ...current, policy: input.policy, revision: "rev-2" };
      return { revision: current.revision, policy: current.policy };
    });

    store.getState().resetForTests({ ...api, getPermissions: get, savePermissions: save });
    await store.getState().loadPermissionSettings();

    store.getState().patchToolGrant("mcp.search.query", {
      agentOverrides: {
        [AGENT_A]: {
          enabled: true,
          approved: true,
          revision: "v1",
          directories: ["/data/a"],
        },
      },
    });

    const scopedSelection: PermissionScope = {
      agentOverrides: [{ resource: "mcp.search.query", agentId: AGENT_A }],
    };

    const savedOk = await store.getState().savePermissionSettings(scopedSelection);
    expect(savedOk).toBe(true);

    const submittedOverrides = save.mock.calls[0][0].policy.grants[0].agentOverrides ?? {};
    expect(submittedOverrides[AGENT_A]).toBeDefined();
    expect(submittedOverrides[AGENT_B]).toEqual({
      enabled: true,
      approved: true,
      revision: "v1",
      directories: ["/data/b"],
    });

    const editorAfterSave = store.getState().permissionEditor;
    if (!editorAfterSave) throw new Error("Missing permissionEditor");
    expect(editorAfterSave.grants["mcp.search.query"].agentOverrides?.[AGENT_B]).toBeUndefined();
    expect(permissionSettingsDirty(editorAfterSave)).toBe(true);
  });

  it("saves combined scope with both resources and agentOverrides correctly", async () => {
    let current: PermissionsResponse = {
      revision: "rev-1",
      policy: {
        version: 1,
        execution: ExecutionPolicySchema.parse({ pausedTools: [] }),
        grants: [
          {
            resource: "mcp.tool.one",
            approved: false,
            revision: "v1",
            directories: [],
          },
          {
            resource: "mcp.search.query",
            approved: false,
            revision: "v1",
            directories: ["/data/search"],
            agentOverrides: {
              [AGENT_B]: {
                enabled: true,
                approved: true,
                revision: "v1",
                directories: ["/data/b"],
              },
            },
          },
        ],
      },
      resources: [
        {
          name: "mcp.tool.one",
          resource: "mcp.tool.one",
          description: "One",
          effect: "read",
          revision: "v1",
          approvalRequired: false,
        },
        {
          name: "mcp.search.query",
          resource: "mcp.search.query",
          description: "Search",
          effect: "read",
          revision: "v1",
          approvalRequired: true,
          directories: ["/data/search"],
        },
      ],
    };

    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      current = { ...current, policy: input.policy, revision: "rev-2" };
      return { revision: current.revision, policy: current.policy };
    });

    store.getState().resetForTests({ ...api, getPermissions: get, savePermissions: save });
    await store.getState().loadPermissionSettings();

    store.getState().patchToolGrant("mcp.tool.one", { approved: true });

    store.getState().patchToolGrant("mcp.search.query", {
      agentOverrides: {
        ...store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides,
        [AGENT_A]: {
          enabled: true,
          approved: true,
          revision: "v1",
          directories: ["/data/a"],
        },
      },
    });

    const combinedScope: PermissionScope = {
      resources: ["mcp.tool.one"],
      agentOverrides: [{ resource: "mcp.search.query", agentId: AGENT_A }],
    };

    const savedOk = await store.getState().savePermissionSettings(combinedScope);
    expect(savedOk).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);

    const submittedPolicy = save.mock.calls[0][0].policy;
    expect(submittedPolicy.grants.find((g) => g.resource === "mcp.tool.one")?.approved).toBe(true);
    expect(
      submittedPolicy.grants.find((g) => g.resource === "mcp.search.query")?.agentOverrides?.[
        AGENT_A
      ],
    ).toEqual({
      enabled: true,
      approved: true,
      revision: "v1",
      directories: ["/data/a"],
    });

    const editor = store.getState().permissionEditor;
    if (!editor) throw new Error("Missing permissionEditor");
    expect(permissionSettingsDirty(editor, combinedScope)).toBe(false);
  });

  it("renders tool directory in AgentToolScope and executes scoped save on override toggle", async () => {
    let current = makeSnapshot();
    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      current = { ...current, policy: input.policy, revision: "rev-2" };
      return { revision: current.revision, policy: current.policy };
    });
    const getToolDir = vi.fn(async () => ({
      tools: [
        {
          name: "memory.query",
          description: "Query long-term memory",
          parameters: {},
          capability: "memory",
          effect: "read" as const,
          sandboxCallable: true,
          origin: "system" as const,
          globalEnabled: true,
          functionId: "memory-query" as const,
          resource: null,
          revision: null,
          approvalRequired: false,
          directories: [],
        },
        {
          name: "mcp.search.query",
          description: "Search documents",
          parameters: {},
          capability: "search",
          effect: "read" as const,
          sandboxCallable: false,
          origin: "mcp" as const,
          globalEnabled: true,
          functionId: null,
          resource: "mcp.search.query",
          revision: "v1",
          approvalRequired: true,
          directories: ["/data/search"],
        },
      ],
    }));

    store.getState().resetForTests({
      ...api,
      getPermissions: get,
      savePermissions: save,
      getToolDirectory: getToolDir,
    });
    store.setState({
      editorAgentId: AGENT_A,
      agents: [
        AgentResponseSchema.parse({
          id: AGENT_A,
          name: "Alpha Agent",
          model_name: "test-model",
          config_version: 1,
          persona_intensity: 60,
          created_at: "2026-10-27T00:00:00.000Z",
          updated_at: "2026-10-27T00:00:00.000Z",
        }),
      ],
    });

    await act(async () => {
      render(
        React.createElement(
          DesignSystemProvider,
          null,
          React.createElement(AgentToolScope, { agentId: AGENT_A, active: true }),
        ),
      );
    });

    expect(screen.getByText("memory.query")).toBeTruthy();
    expect(screen.getByText("mcp.search.query")).toBeTruthy();

    const enableCheckbox = screen.getByTestId("agent-tool-enable-mcp.search.query");
    expect(enableCheckbox.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(enableCheckbox);
    expect(enableCheckbox.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(enableCheckbox);
    expect(enableCheckbox.getAttribute("aria-checked")).toBe("true");

    const saveBtn = screen.getByTestId("agent-tool-save-mcp.search.query") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(save).toHaveBeenCalledTimes(1);
    const submittedOverrides = save.mock.calls[0][0].policy.grants[0].agentOverrides ?? {};
    expect(submittedOverrides[AGENT_A]).toBeDefined();
    expect(submittedOverrides[AGENT_A].enabled).toBe(true);
  });

  it("disables controls and renders error with retry button when getPermissions fails", async () => {
    let failFirst = true;
    const current = makeSnapshot();
    const get = vi.fn(async () => {
      if (failFirst) {
        failFirst = false;
        throw new Error("NETWORK_FAILURE");
      }
      return structuredClone(current);
    });
    const getToolDir = vi.fn(async () => ({
      tools: [
        {
          name: "mcp.search.query",
          description: "Search documents",
          parameters: {},
          capability: "search",
          effect: "read" as const,
          sandboxCallable: false,
          origin: "mcp" as const,
          globalEnabled: true,
          functionId: null,
          resource: "mcp.search.query",
          revision: "v1",
          approvalRequired: true,
          directories: ["/data/search"],
        },
      ],
    }));

    store.getState().resetForTests({
      ...api,
      getPermissions: get,
      getToolDirectory: getToolDir,
    });
    store.setState({
      editorAgentId: AGENT_A,
      agents: [
        AgentResponseSchema.parse({
          id: AGENT_A,
          name: "Alpha Agent",
          model_name: "test-model",
          config_version: 1,
          persona_intensity: 60,
          created_at: "2026-10-27T00:00:00.000Z",
          updated_at: "2026-10-27T00:00:00.000Z",
        }),
      ],
    });

    await act(async () => {
      render(
        React.createElement(
          DesignSystemProvider,
          null,
          React.createElement(AgentToolScope, { agentId: AGENT_A, active: true }),
        ),
      );
    });

    expect(screen.getByRole("alert")).toBeTruthy();
    const retryBtn = screen.getByRole("button", { name: translate("capabilities.retry") });
    expect(retryBtn).toBeTruthy();

    const enableCheckbox = screen.getByTestId(
      "agent-tool-enable-mcp.search.query",
    ) as HTMLButtonElement;
    expect(enableCheckbox.disabled).toBe(true);
    const saveBtn = screen.getByTestId("agent-tool-save-mcp.search.query") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    await act(async () => {
      fireEvent.click(retryBtn);
    });

    expect(enableCheckbox.disabled).toBe(false);
  });

  it("renders tool with module paused status when globalEnabled is false", async () => {
    const current = makeSnapshot();
    const get = vi.fn(async () => structuredClone(current));
    const getToolDir = vi.fn(async () => ({
      tools: [
        {
          name: "mcp.search.query",
          description: "Search documents",
          parameters: {},
          capability: "search",
          effect: "read" as const,
          sandboxCallable: false,
          origin: "mcp" as const,
          globalEnabled: false,
          functionId: null,
          resource: "mcp.search.query",
          revision: "v1",
          approvalRequired: true,
          directories: ["/data/search"],
        },
      ],
    }));

    store.getState().resetForTests({
      ...api,
      getPermissions: get,
      getToolDirectory: getToolDir,
    });
    store.setState({
      editorAgentId: AGENT_A,
      agents: [
        AgentResponseSchema.parse({
          id: AGENT_A,
          name: "Alpha Agent",
          model_name: "test-model",
          config_version: 1,
          persona_intensity: 60,
          created_at: "2026-10-27T00:00:00.000Z",
          updated_at: "2026-10-27T00:00:00.000Z",
        }),
      ],
    });

    await act(async () => {
      render(
        React.createElement(
          DesignSystemProvider,
          null,
          React.createElement(AgentToolScope, { agentId: AGENT_A, active: true }),
        ),
      );
    });

    expect(screen.getByText(translate("connections.grants.modulePaused"))).toBeTruthy();
  });

  it("renders built-in tool with module paused status when globalEnabled is false", async () => {
    const current = makeSnapshot();
    const get = vi.fn(async () => structuredClone(current));
    const getToolDir = vi.fn(async () => ({
      tools: [
        {
          name: "memory.query",
          description: "Query long-term memory",
          parameters: {},
          capability: "memory",
          effect: "read" as const,
          sandboxCallable: true,
          origin: "system" as const,
          globalEnabled: false,
          functionId: "memory-query" as const,
          resource: null,
          revision: null,
          approvalRequired: false,
          directories: [],
        },
      ],
    }));

    store.getState().resetForTests({
      ...api,
      getPermissions: get,
      getToolDirectory: getToolDir,
    });
    store.setState({
      editorAgentId: AGENT_A,
      agents: [
        AgentResponseSchema.parse({
          id: AGENT_A,
          name: "Alpha Agent",
          model_name: "test-model",
          config_version: 1,
          persona_intensity: 60,
          created_at: "2026-10-27T00:00:00.000Z",
          updated_at: "2026-10-27T00:00:00.000Z",
        }),
      ],
    });

    await act(async () => {
      render(
        React.createElement(
          DesignSystemProvider,
          null,
          React.createElement(AgentToolScope, { agentId: AGENT_A, active: true }),
        ),
      );
    });

    expect(screen.getByText("memory.query")).toBeTruthy();
    expect(
      screen.getAllByText(translate("connections.grants.modulePaused")).length,
    ).toBeGreaterThan(0);
  });

  it("savedbasevsdirtybase: initializing override from directory edit builds from saved effective grant, not dirty base draft", async () => {
    let current: PermissionsResponse = {
      revision: "rev-saved-base",
      policy: {
        version: 1,
        execution: ExecutionPolicySchema.parse({ pausedTools: [] }),
        grants: [
          {
            resource: "mcp.search.query",
            approved: false,
            revision: "v1",
            directories: ["/data/saved1", "/data/saved2"],
          },
        ],
      },
      resources: [
        {
          name: "mcp.search.query",
          resource: "mcp.search.query",
          description: "Search documents",
          effect: "read",
          revision: "v1",
          approvalRequired: true,
          directories: ["/data/saved1", "/data/saved2"],
        },
      ],
    };

    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      current = { ...current, policy: input.policy, revision: "rev-saved-after" };
      return { revision: current.revision, policy: current.policy };
    });
    const getToolDir = vi.fn(async () => ({
      tools: [
        {
          name: "mcp.search.query",
          description: "Search documents",
          parameters: {},
          capability: "search",
          effect: "read" as const,
          sandboxCallable: false,
          origin: "mcp" as const,
          globalEnabled: true,
          functionId: null,
          resource: "mcp.search.query",
          revision: "v1",
          approvalRequired: true,
          directories: ["/data/saved1", "/data/saved2"],
        },
      ],
    }));

    store.getState().resetForTests({
      ...api,
      getPermissions: get,
      savePermissions: save,
      getToolDirectory: getToolDir,
    });
    store.setState({
      editorAgentId: AGENT_A,
      agents: [
        AgentResponseSchema.parse({
          id: AGENT_A,
          name: "Alpha Agent",
          model_name: "test-model",
          config_version: 1,
          persona_intensity: 60,
          created_at: "2026-10-27T00:00:00.000Z",
          updated_at: "2026-10-27T00:00:00.000Z",
        }),
      ],
    });

    await store.getState().loadPermissionSettings();

    // 1. Admin creates uncommitted dirty base edits in store
    store.getState().patchToolGrant("mcp.search.query", {
      directories: ["/data/dirty-uncommitted"],
    });

    // 2. Render AgentToolScope for AGENT_A (has NO override yet)
    await act(async () => {
      render(
        React.createElement(
          DesignSystemProvider,
          null,
          React.createElement(AgentToolScope, { agentId: AGENT_A, active: true }),
        ),
      );
    });

    // Initial state: inherited from saved base, /data/saved1 is checked
    const saved1Cb = screen.getByTestId("agent-dir-mcp.search.query-/data/saved1");
    expect(saved1Cb.getAttribute("aria-checked")).toBe("true");

    // 3. User unchecks /data/saved1 for Agent A
    await act(async () => {
      fireEvent.click(saved1Cb);
    });

    // 4. Verify Agent A override was built from saved base (["/data/saved1", "/data/saved2"]),
    // NOT from dirty base draft (["/data/dirty-uncommitted"])!
    const editor = store.getState().permissionEditor;
    const agentAOverride = editor?.grants["mcp.search.query"]?.agentOverrides?.[AGENT_A];
    expect(agentAOverride).toBeDefined();
    expect(agentAOverride?.directories).toEqual(["/data/saved2"]);
    expect(agentAOverride?.directories).not.toContain("/data/dirty-uncommitted");

    // 5. Scoped save of Agent A sends ONLY Agent A's override, preserving server baseline base
    const saveBtn = screen.getByTestId("agent-tool-save-mcp.search.query");
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(save).toHaveBeenCalledTimes(1);
    const submittedGrant = save.mock.calls[0][0].policy.grants[0];
    // Baseline base directories on server preserved
    expect(submittedGrant.directories).toEqual(["/data/saved1", "/data/saved2"]);
    // Agent A override committed
    expect(submittedGrant.agentOverrides?.[AGENT_A]?.directories).toEqual(["/data/saved2"]);
    // Dirty uncommitted base draft remains in local editor
    expect(store.getState().permissionEditor?.grants["mcp.search.query"]?.directories).toEqual([
      "/data/dirty-uncommitted",
    ]);
  });

  it("renders declared directories and preserves historical directories on edit without silent drop", async () => {
    let current: PermissionsResponse = {
      revision: "rev-hist-1",
      policy: {
        version: 1,
        execution: ExecutionPolicySchema.parse({ pausedTools: [] }),
        grants: [
          {
            resource: "mcp.search.query",
            approved: true,
            revision: "v1",
            directories: ["/data/declared", "/data/historical"],
          },
        ],
      },
      resources: [
        {
          name: "mcp.search.query",
          resource: "mcp.search.query",
          description: "Search documents",
          effect: "read",
          revision: "v1",
          approvalRequired: true,
          directories: ["/data/declared"], // declared does NOT include /data/historical
        },
      ],
    };

    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      current = { ...current, policy: input.policy, revision: "rev-hist-saved" };
      return { revision: current.revision, policy: current.policy };
    });
    const getToolDir = vi.fn(async () => ({
      tools: [
        {
          name: "mcp.search.query",
          description: "Search documents",
          parameters: {},
          capability: "search",
          effect: "read" as const,
          sandboxCallable: false,
          origin: "mcp" as const,
          globalEnabled: true,
          functionId: null,
          resource: "mcp.search.query",
          revision: "v1",
          approvalRequired: true,
          directories: ["/data/declared"],
        },
      ],
    }));

    store.getState().resetForTests({
      ...api,
      getPermissions: get,
      savePermissions: save,
      getToolDirectory: getToolDir,
    });
    store.setState({
      editorAgentId: AGENT_A,
      agents: [
        AgentResponseSchema.parse({
          id: AGENT_A,
          name: "Alpha Agent",
          model_name: "test-model",
          config_version: 1,
          persona_intensity: 60,
          created_at: "2026-10-27T00:00:00.000Z",
          updated_at: "2026-10-27T00:00:00.000Z",
        }),
      ],
    });

    await act(async () => {
      render(
        React.createElement(
          DesignSystemProvider,
          null,
          React.createElement(AgentToolScope, { agentId: AGENT_A, active: true }),
        ),
      );
    });

    // Declared directory is rendered
    expect(screen.getByTestId("agent-dir-mcp.search.query-/data/declared")).toBeTruthy();
    // Historical directory is also rendered with historical badge
    const histCb = screen.getByTestId("agent-dir-hist-mcp.search.query-/data/historical");
    expect(histCb).toBeTruthy();
    expect(screen.getByText(translate("connections.grants.historicalDirectory"))).toBeTruthy();

    // Toggle declared directory
    const declaredCb = screen.getByTestId("agent-dir-mcp.search.query-/data/declared");
    await act(async () => {
      fireEvent.click(declaredCb);
    });

    // Historical directory is retained in override, NOT silently dropped!
    const overrideDraft =
      store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides?.[AGENT_A];
    expect(overrideDraft?.directories).toContain("/data/historical");

    // Scoped save persists the retained historical directory
    const saveBtn = screen.getByTestId("agent-tool-save-mcp.search.query");
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].policy.grants[0].agentOverrides?.[AGENT_A]?.directories).toContain(
      "/data/historical",
    );
  });

  it("preserves dirty directory overrides across CAS 409 conflict and refresh", async () => {
    let current = makeSnapshot();
    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      if (input.expectedRevision !== current.revision) {
        throw new Error("REVISION_CONFLICT");
      }
      current = { ...current, policy: input.policy, revision: "rev-conflict-saved" };
      return { revision: current.revision, policy: current.policy };
    });

    store.getState().resetForTests({ ...api, getPermissions: get, savePermissions: save });
    await store.getState().loadPermissionSettings();

    // Explicit empty directories override for Agent A
    store.getState().patchToolGrant("mcp.search.query", {
      agentOverrides: {
        [AGENT_A]: {
          enabled: true,
          approved: true,
          revision: "v1",
          directories: [],
        },
      },
    });

    // Simulate concurrent revision bump on server
    current.revision = "rev-bumped-elsewhere";

    const scopedSelection: PermissionScope = {
      agentOverrides: [{ resource: "mcp.search.query", agentId: AGENT_A }],
    };

    const savedOk = await store.getState().savePermissionSettings(scopedSelection);
    expect(savedOk).toBe(false);

    // Draft directories: [] preserved after conflict
    expect(
      store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides?.[AGENT_A]
        ?.directories,
    ).toEqual([]);

    // Refresh preserves dirty directories: []
    await store.getState().loadPermissionSettings(true);
    expect(
      store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides?.[AGENT_A]
        ?.directories,
    ).toEqual([]);
  });

  it("basefalse: editing directories when base is disabled retains enabled: false without escalation", async () => {
    let current: PermissionsResponse = {
      revision: "rev-bf-1",
      policy: {
        version: 1,
        execution: ExecutionPolicySchema.parse({ pausedTools: [] }),
        grants: [
          {
            resource: "mcp.search.query",
            approved: false,
            revision: "v1",
            directories: ["/data/saved1", "/data/saved2"],
          },
        ],
      },
      resources: [
        {
          name: "mcp.search.query",
          resource: "mcp.search.query",
          description: "Search documents",
          effect: "read",
          revision: "v1",
          approvalRequired: true,
          directories: ["/data/saved1", "/data/saved2"],
        },
      ],
    };
    (current.policy.grants[0] as { enabled?: boolean }).enabled = false;

    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      current = { ...current, policy: input.policy, revision: "rev-bf-2" };
      return { revision: current.revision, policy: current.policy };
    });
    const getToolDir = vi.fn(async () => ({
      tools: [
        {
          name: "mcp.search.query",
          description: "Search documents",
          parameters: {},
          capability: "search",
          effect: "read" as const,
          sandboxCallable: false,
          origin: "mcp" as const,
          globalEnabled: true,
          functionId: null,
          resource: "mcp.search.query",
          revision: "v1",
          approvalRequired: true,
          directories: ["/data/saved1", "/data/saved2"],
        },
      ],
    }));

    store.getState().resetForTests({
      ...api,
      getPermissions: get,
      savePermissions: save,
      getToolDirectory: getToolDir,
    });
    store.setState({
      editorAgentId: AGENT_A,
      agents: [
        AgentResponseSchema.parse({
          id: AGENT_A,
          name: "Alpha Agent",
          model_name: "test-model",
          config_version: 1,
          persona_intensity: 60,
          created_at: "2026-10-27T00:00:00.000Z",
          updated_at: "2026-10-27T00:00:00.000Z",
        }),
      ],
    });

    await store.getState().loadPermissionSettings();

    await act(async () => {
      render(
        React.createElement(
          DesignSystemProvider,
          null,
          React.createElement(AgentToolScope, { agentId: AGENT_A, active: true }),
        ),
      );
    });

    const saved2Cb = screen.getByTestId("agent-dir-mcp.search.query-/data/saved2");
    await act(async () => {
      fireEvent.click(saved2Cb);
    });

    const override =
      store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides?.[AGENT_A];
    expect(override).toBeDefined();
    expect(override?.directories).toEqual(["/data/saved1"]);
    // Must remain explicitly disabled (enabled: false)
    expect(override?.enabled).toBe(false);
    expect(override?.approved).toBe(false);
  });

  it("persisted saved override: revert immediately displays base [A,B], unchecking A leaves [B], and scoped save sends only A without discarded history", async () => {
    let current: PermissionsResponse = {
      revision: "rev-saved-override-1",
      policy: {
        version: 1,
        execution: ExecutionPolicySchema.parse({ pausedTools: [] }),
        grants: [
          {
            resource: "mcp.search.query",
            approved: true,
            revision: "v1-base",
            directories: ["/synthetic/dirA", "/synthetic/dirB"],
            agentOverrides: {
              [AGENT_A]: {
                enabled: true,
                approved: true,
                revision: "v1-old-override",
                directories: ["/synthetic/dirA"],
              },
              [AGENT_B]: {
                enabled: true,
                approved: true,
                revision: "v1-b",
                directories: ["/synthetic/dirB"],
              },
            },
          },
        ],
      },
      resources: [
        {
          name: "mcp.search.query",
          resource: "mcp.search.query",
          description: "Search",
          effect: "read",
          revision: "v1-base",
          approvalRequired: true,
          directories: ["/synthetic/dirA", "/synthetic/dirB"],
        },
      ],
    };

    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      current = { ...current, policy: input.policy, revision: "rev-saved-override-2" };
      return { revision: current.revision, policy: current.policy };
    });
    const getToolDir = vi.fn(async () => ({
      tools: [
        {
          name: "mcp.search.query",
          description: "Search documents",
          parameters: {},
          capability: "search",
          effect: "read" as const,
          sandboxCallable: false,
          origin: "mcp" as const,
          globalEnabled: true,
          functionId: null,
          resource: "mcp.search.query",
          revision: "v1-base",
          approvalRequired: true,
          directories: ["/synthetic/dirA", "/synthetic/dirB"],
        },
      ],
    }));

    store.getState().resetForTests({
      ...api,
      getPermissions: get,
      savePermissions: save,
      getToolDirectory: getToolDir,
    });
    store.setState({
      editorAgentId: AGENT_A,
      agents: [
        AgentResponseSchema.parse({
          id: AGENT_A,
          name: "Alpha Agent",
          model_name: "test-model",
          config_version: 1,
          persona_intensity: 60,
          created_at: "2026-10-27T00:00:00.000Z",
          updated_at: "2026-10-27T00:00:00.000Z",
        }),
      ],
    });

    await store.getState().loadPermissionSettings();

    await act(async () => {
      render(
        React.createElement(
          DesignSystemProvider,
          null,
          React.createElement(AgentToolScope, { agentId: AGENT_A, active: true }),
        ),
      );
    });

    // 1. Initial state: Agent A has saved override with only [/synthetic/dirA]
    const dirACb = screen.getByTestId("agent-dir-mcp.search.query-/synthetic/dirA");
    const dirBCb = screen.getByTestId("agent-dir-mcp.search.query-/synthetic/dirB");
    expect(dirACb.getAttribute("aria-checked")).toBe("true");
    expect(dirBCb.getAttribute("aria-checked")).toBe("false");

    const revertBtn = screen.getByTestId("agent-tool-revert-mcp.search.query");
    expect(revertBtn).toBeTruthy();

    // 2. Click revert -> deletes overrideDraft; UI MUST immediately display base [A,B]!
    await act(async () => {
      fireEvent.click(revertBtn);
    });

    // Both dirA and dirB must now be checked (inheriting base)!
    expect(dirACb.getAttribute("aria-checked")).toBe("true");
    expect(dirBCb.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("agent-tool-revert-mcp.search.query")).toBeNull();

    // 3. User unchecks dirA -> new override created from base [A,B], leaving [B]!
    await act(async () => {
      fireEvent.click(dirACb);
    });

    expect(dirACb.getAttribute("aria-checked")).toBe("false");
    expect(dirBCb.getAttribute("aria-checked")).toBe("true");

    const overrideAfterUncheck =
      store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides?.[AGENT_A];
    expect(overrideAfterUncheck).toBeDefined();
    // Must be [B], NOT []!
    expect(overrideAfterUncheck?.directories).toEqual(["/synthetic/dirB"]);
    // Must take revision from base v1-base, NOT revive discarded "v1-old-override"!
    expect(overrideAfterUncheck?.revision).toBe("v1-base");

    // 4. Scoped save of Agent A sends ONLY Agent A's override, preserving server baseline and Agent B
    const saveBtn = screen.getByTestId("agent-tool-save-mcp.search.query");
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(save).toHaveBeenCalledTimes(1);
    const submittedGrant = save.mock.calls[0][0].policy.grants[0];
    expect(submittedGrant.directories).toEqual(["/synthetic/dirA", "/synthetic/dirB"]);
    expect(submittedGrant.agentOverrides?.[AGENT_A]?.directories).toEqual(["/synthetic/dirB"]);
    expect(submittedGrant.agentOverrides?.[AGENT_B]?.directories).toEqual(["/synthetic/dirB"]);
  });
});
