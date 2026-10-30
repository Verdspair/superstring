import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionPolicySchema,
  type PermissionGrant,
  type PermissionPolicy,
  type PermissionsResponse,
  selectEffectivePermissionGrant,
} from "../../src/shared/contracts/permissions";
import { api } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { applyGrantEdits, grantDraftOf } from "../../src/web/features/access/permission-draft";
import {
  agentPermissionScope,
  type PermissionScope,
  permissionSettingsDirty,
} from "../../src/web/features/access/permission-state";
import { selectLocale, translate } from "../../src/web/i18n";
import { AgentToolScope } from "../../src/web/screens/assistants/StudioEditors";
import { ToolGrantsPanel } from "../../src/web/screens/connections/tool-grants-panel";
import { useSuperstringStore as store } from "../../src/web/store";
import { agent, setupLibrary } from "./helpers/library-fixture";

const AGENT_ALPHA = "agent-alpha-id";
const AGENT_BETA = "agent-beta-id";

const makeSnapshot = (overrides?: PermissionGrant["agentOverrides"]): PermissionsResponse => ({
  revision: "rev-1",
  policy: {
    version: 1,
    execution: ExecutionPolicySchema.parse({ modules: { mcp: true, tasks: true } }),
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
  vi.restoreAllMocks();
});

describe("agent permission overrides (round-trip closure)", () => {
  it("preserves stale base and other Agent identities when only an override changes", () => {
    const policy: PermissionPolicy = {
      version: 1,
      grants: [
        {
          resource: "mcp.search.query",
          approved: true,
          revision: "old-revision",
          agentIds: [AGENT_BETA, AGENT_ALPHA],
          directories: ["/z", "/a"],
          agentOverrides: {
            [AGENT_BETA]: { approved: true, revision: "other-revision", directories: ["/z", "/a"] },
          },
        },
      ],
    };
    const resource = {
      name: "mcp.search.query",
      resource: "mcp.search.query",
      description: "Search",
      effect: "read" as const,
      revision: "current-revision",
      approvalRequired: true,
    };
    const beforeIdentity = JSON.stringify(
      selectEffectivePermissionGrant(policy, resource.resource, AGENT_BETA)?.identity,
    );
    const draft = grantDraftOf(policy, resource.resource, resource.revision);
    draft.agentOverrides = {
      ...draft.agentOverrides,
      [AGENT_ALPHA]: {
        enabled: false,
        approved: false,
        revision: resource.revision,
        directories: [],
      },
    };
    const next = applyGrantEdits(policy, [resource], { [resource.resource]: draft });
    const { agentOverrides: _beforeOverrides, ...beforeBase } = policy.grants[0];
    const { agentOverrides: _afterOverrides, ...afterBase } = next.grants[0];
    expect(JSON.stringify(afterBase)).toBe(JSON.stringify(beforeBase));
    expect(
      JSON.stringify(selectEffectivePermissionGrant(next, resource.resource, AGENT_BETA)?.identity),
    ).toBe(beforeIdentity);
    expect(next.grants[0].agentOverrides?.[AGENT_ALPHA]?.enabled).toBe(false);
  });

  it("baseeditsmap保: base grant edit preserves all agentOverrides without dropping them", async () => {
    const initialOverrides = {
      [AGENT_ALPHA]: {
        enabled: true,
        approved: true,
        revision: "v1",
        directories: ["/data/search"],
      },
      [AGENT_BETA]: {
        enabled: false,
        approved: false,
        revision: "v1",
        directories: [],
      },
    };
    let current = makeSnapshot(initialOverrides);
    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      current = { ...current, policy: input.policy, revision: "rev-2" };
      return { revision: current.revision, policy: current.policy };
    });
    store.getState().resetForTests({ ...api, getPermissions: get, savePermissions: save });

    await store.getState().loadPermissionSettings();
    // Admin edits base grant approval and scope without touching overrides
    store.getState().patchToolGrant("mcp.search.query", {
      approved: true,
      agentIds: [AGENT_ALPHA],
    });

    const dirty = permissionSettingsDirty(store.getState().permissionEditor, "grants");
    expect(dirty).toBe(true);

    const saved = await store.getState().savePermissionSettings("grants");
    expect(saved).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);

    const savedGrant = save.mock.calls[0][0].policy.grants[0];
    expect(savedGrant.approved).toBe(true);
    expect(savedGrant.agentIds).toEqual([AGENT_ALPHA]);
    // agentOverrides are completely preserved in payload
    expect(savedGrant.agentOverrides).toEqual(initialOverrides);
  });

  it("单Agent关/开后savepayload+refresh真状态: disables and enables single agent override with accurate payload and refresh state", async () => {
    let current = makeSnapshot({
      [AGENT_ALPHA]: {
        enabled: true,
        approved: true,
        revision: "v1",
        directories: ["/data/search"],
      },
    });
    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      current = { ...current, policy: input.policy, revision: "rev-2" };
      return { revision: current.revision, policy: current.policy };
    });
    store.getState().resetForTests({ ...api, getPermissions: get, savePermissions: save });

    await store.getState().loadPermissionSettings();

    // 1. Disable AGENT_ALPHA: writes override.enabled: false
    store.getState().patchToolGrant("mcp.search.query", {
      agentOverrides: {
        [AGENT_ALPHA]: {
          enabled: false,
          approved: true,
          revision: "v1",
          directories: ["/data/search"],
        },
      },
    });

    expect(await store.getState().savePermissionSettings("grants")).toBe(true);
    expect(save.mock.calls[0][0].policy.grants[0].agentOverrides?.[AGENT_ALPHA]?.enabled).toBe(
      false,
    );

    // Refresh state reflects real enabled: false
    const refreshedPolicy = current.policy;
    const effectiveDisabled = selectEffectivePermissionGrant(
      refreshedPolicy,
      "mcp.search.query",
      AGENT_ALPHA,
    );
    expect(effectiveDisabled?.grant.enabled).toBe(false);

    // 2. Re-enable AGENT_ALPHA: writes override.enabled: true
    store.getState().patchToolGrant("mcp.search.query", {
      agentOverrides: {
        [AGENT_ALPHA]: {
          enabled: true,
          approved: true,
          revision: "v1",
          directories: ["/data/search"],
        },
      },
    });

    expect(await store.getState().savePermissionSettings("grants")).toBe(true);
    expect(save.mock.calls[1][0].policy.grants[0].agentOverrides?.[AGENT_ALPHA]?.enabled).toBe(
      true,
    );

    const effectiveEnabled = selectEffectivePermissionGrant(
      current.policy,
      "mcp.search.query",
      AGENT_ALPHA,
    );
    expect(effectiveEnabled?.grant.enabled).toBe(true);
  });

  it("globalallowbaseownfalse拒视觉: global base allows, but agent override.enabled is false -> visually/semantically denied", async () => {
    const snapshot: PermissionsResponse = {
      revision: "rev-1",
      policy: {
        version: 1,
        execution: ExecutionPolicySchema.parse({ modules: { mcp: true } }),
        grants: [
          {
            resource: "mcp.search.query",
            approved: true, // Base globally allowed & approved
            revision: "v1",
            agentIds: undefined, // All agents
            directories: [],
            agentOverrides: {
              [AGENT_ALPHA]: {
                enabled: false, // Explicitly denied for Alpha
                approved: true,
                revision: "v1",
                directories: [],
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
          revision: "v1",
          approvalRequired: true,
        },
      ],
    };

    let current = structuredClone(snapshot);
    const get = vi.fn(async () => structuredClone(current));
    const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
      current = { ...current, policy: input.policy, revision: "saved-revision" };
      return { revision: current.revision, policy: current.policy };
    });
    store.getState().resetForTests({ ...api, getPermissions: get, savePermissions: save });
    store.setState({
      agents: [
        { ...agent, id: AGENT_ALPHA, name: "Alpha Worker" },
        { ...agent, id: AGENT_BETA, name: "Beta Worker" },
      ],
    });

    await act(async () =>
      render(
        <DesignSystemProvider>
          <ToolGrantsPanel scope="external" />
        </DesignSystemProvider>,
      ),
    );

    // Click manage to expand
    const manageButtons = screen.getAllByRole("button", { name: translate("connections.manage") });
    fireEvent.click(manageButtons[0]);

    // Agent Alpha shows explicit disabled status
    expect(screen.getByText(translate("connections.grants.agentOverrideDisabled"))).toBeTruthy();

    // The override enabled checkbox for Alpha is unchecked (false)
    const alphaCheckbox = screen.getByLabelText(
      translate("connections.grants.agentOverrideEnabledFor", "Alpha Worker"),
    );
    expect(alphaCheckbox.getAttribute("data-state")).toBe("unchecked");

    // Agent Beta has no override and inherits base (enabled)
    const betaCheckbox = screen.getByLabelText(
      translate("connections.grants.agentOverrideEnabledFor", "Beta Worker"),
    );
    expect(betaCheckbox.getAttribute("data-state")).toBe("checked");
    await act(async () => fireEvent.click(alphaCheckbox));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: translate("connections.grants.save") })),
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(current.policy.grants[0].agentOverrides?.[AGENT_ALPHA]?.enabled).toBe(true);
    const { agentOverrides: _originalOverrides, ...originalBase } = snapshot.policy.grants[0];
    const { agentOverrides: _savedOverrides, ...savedBase } = current.policy.grants[0];
    expect(savedBase).toEqual(originalBase);
    await act(async () =>
      fireEvent.click(
        screen.getByLabelText(
          translate("connections.grants.agentOverrideEnabledFor", "Alpha Worker"),
        ),
      ),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: translate("connections.grants.save") })),
    );
    expect(save).toHaveBeenCalledTimes(2);
    expect(current.policy.grants[0].agentOverrides?.[AGENT_ALPHA]?.enabled).toBe(false);
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: translate("connections.common.refresh") }),
      ),
    );
    expect(
      screen
        .getByLabelText(translate("connections.grants.agentOverrideEnabledFor", "Alpha Worker"))
        .getAttribute("data-state"),
    ).toBe("unchecked");
  });

  it("其他Agentbaseunchanged: editing one agent override leaves other agents and base unchanged", () => {
    const initialPolicy: PermissionPolicy = {
      version: 1,
      execution: ExecutionPolicySchema.parse({}),
      grants: [
        {
          resource: "mcp.search.query",
          approved: false,
          revision: "v1",
          agentIds: [AGENT_ALPHA, AGENT_BETA],
          directories: ["/data/search"],
          agentOverrides: {
            [AGENT_BETA]: {
              enabled: true,
              approved: true,
              revision: "v1",
              directories: ["/beta/dir"],
            },
          },
        },
      ],
    };

    const resources = [
      {
        name: "mcp.search.query",
        resource: "mcp.search.query",
        description: "Search",
        effect: "read" as const,
        revision: "v1",
        approvalRequired: true,
        directories: ["/data/search"],
      },
    ];

    const draft = grantDraftOf(initialPolicy, "mcp.search.query", "v1");
    // Modify only AGENT_ALPHA
    draft.agentOverrides = {
      ...draft.agentOverrides,
      [AGENT_ALPHA]: {
        enabled: false,
        approved: false,
        revision: "v1",
        directories: ["/data/search"],
      },
    };

    const nextPolicy = applyGrantEdits(initialPolicy, resources, {
      "mcp.search.query": draft,
    });

    const nextGrant = nextPolicy.grants[0];
    // Base grant properties completely unchanged
    expect(nextGrant.approved).toBe(false);
    expect(nextGrant.revision).toBe("v1");
    expect(nextGrant.agentIds).toEqual([AGENT_ALPHA, AGENT_BETA]);
    expect(nextGrant.directories).toEqual(["/data/search"]);

    // AGENT_BETA override completely unchanged
    expect(nextGrant.agentOverrides?.[AGENT_BETA]).toEqual({
      enabled: true,
      approved: true,
      revision: "v1",
      directories: ["/beta/dir"],
    });

    // AGENT_ALPHA has the new override
    expect(nextGrant.agentOverrides?.[AGENT_ALPHA]).toEqual({
      enabled: false,
      approved: false,
      revision: "v1",
      directories: ["/data/search"],
    });
  });

  it("explicitinherit删除不同语义: deleting override restores base inheritance, distinct from enabled:false revocation", () => {
    const baseAllowedPolicy: PermissionPolicy = {
      version: 1,
      execution: ExecutionPolicySchema.parse({}),
      grants: [
        {
          resource: "mcp.search.query",
          approved: true,
          revision: "v1",
          directories: [],
          agentOverrides: {
            [AGENT_ALPHA]: {
              enabled: false, // State 1: explicitly revoked / disabled
              approved: true,
              revision: "v1",
              directories: [],
            },
          },
        },
      ],
    };

    // State 1: Explicit enabled: false denies agent even though base is approved
    const effective1 = selectEffectivePermissionGrant(
      baseAllowedPolicy,
      "mcp.search.query",
      AGENT_ALPHA,
    );
    expect(effective1?.grant.enabled).toBe(false);

    // State 2: Override is deleted (inherit base, NOT revoke)
    const policyWithInherit: PermissionPolicy = {
      ...baseAllowedPolicy,
      grants: [
        {
          ...baseAllowedPolicy.grants[0],
          agentOverrides: undefined, // Cleared override
        },
      ],
    };

    const effective2 = selectEffectivePermissionGrant(
      policyWithInherit,
      "mcp.search.query",
      AGENT_ALPHA,
    );
    // Inherits base grant: enabled is undefined (allowed) and approved is true!
    expect(effective2?.grant.enabled).toBeUndefined();
    expect(effective2?.grant.approved).toBe(true);
  });

  it("Studiooverride正显示: Studio AgentToolScope accurately shows tools/pending via canonical selector", async () => {
    const permissions: PermissionsResponse = {
      revision: "pr-1",
      policy: {
        version: 1,
        execution: ExecutionPolicySchema.parse({
          modules: { mcp: true, tasks: true, skills: false }, // skills module paused!
        }),
        grants: [
          // Resource 1: Base unapproved, but Agent has override with approved: true -> should be APPROVED
          {
            resource: "mcp.tool.one",
            approved: false,
            revision: "v1",
            directories: [],
            agentOverrides: {
              [AGENT_ALPHA]: {
                enabled: true,
                approved: true,
                revision: "v1",
                directories: [],
              },
            },
          },
          // Resource 2: Base approved, but Agent has override with enabled: false -> should NOT appear (disabled down)
          {
            resource: "mcp.tool.two",
            approved: true,
            revision: "v1",
            directories: [],
            agentOverrides: {
              [AGENT_ALPHA]: {
                enabled: false,
                approved: true,
                revision: "v1",
                directories: [],
              },
            },
          },
          // Resource 3: Base approved, Agent has override with approved: false -> should count towards PENDING
          {
            resource: "mcp.tool.three",
            approved: true,
            revision: "v1",
            directories: [],
            agentOverrides: {
              [AGENT_ALPHA]: {
                enabled: true,
                approved: false,
                revision: "v1",
                directories: [],
              },
            },
          },
          // Resource 4: Module paused (skills is false in execution.modules) -> should be filtered out
          {
            resource: "skill.search",
            approved: true,
            revision: "v1",
            directories: [],
            agentOverrides: {
              [AGENT_ALPHA]: {
                enabled: true,
                approved: true,
                revision: "v1",
                directories: [],
              },
            },
          },
        ],
      },
      resources: [
        {
          name: "mcp.tool.one",
          resource: "mcp.tool.one",
          description: "Tool One",
          effect: "read",
          revision: "v1",
          approvalRequired: true,
        },
        {
          name: "mcp.tool.two",
          resource: "mcp.tool.two",
          description: "Tool Two",
          effect: "read",
          revision: "v1",
          approvalRequired: true,
        },
        {
          name: "mcp.tool.three",
          resource: "mcp.tool.three",
          description: "Tool Three",
          effect: "read",
          revision: "v1",
          approvalRequired: true,
        },
        {
          name: "skill.search",
          resource: "skill.search",
          description: "Skill Search",
          effect: "read",
          revision: "v1",
          approvalRequired: true,
        },
      ],
    };

    const confirmedExecution = ExecutionPolicySchema.parse(permissions.policy.execution);
    setupLibrary({
      getPermissions: vi.fn().mockResolvedValue(permissions),
      getToolDirectory: vi.fn().mockResolvedValue({
        tools: permissions.resources.map((r) => ({
          name: r.name,
          description: r.description,
          parameters: {},
          capability: "test",
          effect: r.effect,
          sandboxCallable: false,
          invocation: "action" as const,
          scope: "conversation" as const,
          origin: r.name.startsWith("mcp.") ? "mcp" : "system",
          globalEnabled: !r.name.startsWith("skill.") || confirmedExecution.modules.skills,
          functionId: null,
          resource: r.resource,
          revision: r.revision,
          approvalRequired: r.approvalRequired,
          directories: [],
        })),
      }),
    });
    store.setState({ editorAgentId: AGENT_ALPHA });

    await act(async () =>
      render(
        <DesignSystemProvider>
          <AgentToolScope agentId={AGENT_ALPHA} active />
        </DesignSystemProvider>,
      ),
    );

    // Full catalog renders all discovered tools; disabled and paused tools remain visible with restricted status
    await screen.findByText("mcp.tool.one");
    expect(screen.getByText("mcp.tool.two")).toBeTruthy();
    expect(screen.getByText("skill.search")).toBeTruthy();
    expect(screen.getByText("mcp.tool.three")).toBeTruthy();

    // Resource 2 (mcp.tool.two) shows explicit disabled override badge
    expect(screen.getByText(translate("connections.grants.agentOverrideDisabled"))).toBeTruthy();
  });

  it("scopeindependentdirty/discard: dirty checking and discard work independently per scope without leaking", async () => {
    const snapshot: PermissionsResponse = {
      revision: "rev-1",
      policy: {
        version: 1,
        execution: ExecutionPolicySchema.parse({}),
        grants: [
          {
            resource: "mcp.search.query",
            approved: false,
            revision: "v1",
            directories: [],
          },
          {
            resource: "mcp.echo.read",
            approved: false,
            revision: "v1",
            directories: [],
          },
        ],
      },
      resources: [
        {
          name: "mcp.search.query",
          resource: "mcp.search.query",
          description: "Search",
          effect: "read",
          revision: "v1",
          approvalRequired: false,
        },
        {
          name: "mcp.echo.read",
          resource: "mcp.echo.read",
          description: "Echo",
          effect: "read",
          revision: "v1",
          approvalRequired: false,
        },
      ],
    };

    const current = snapshot;
    const get = vi.fn(async () => structuredClone(current));
    store.getState().resetForTests({ ...api, getPermissions: get });

    await store.getState().loadPermissionSettings();

    // Edit only mcp.search.query override
    store.getState().patchToolGrant("mcp.search.query", {
      agentOverrides: {
        [AGENT_ALPHA]: {
          enabled: true,
          approved: true,
          revision: "v1",
          directories: [],
        },
      },
    });

    const searchScope: PermissionScope = { resources: ["mcp.search.query"] };
    const echoScope: PermissionScope = { resources: ["mcp.echo.read"] };

    // Dirty check is isolated to searchScope
    expect(permissionSettingsDirty(store.getState().permissionEditor, searchScope)).toBe(true);
    expect(permissionSettingsDirty(store.getState().permissionEditor, echoScope)).toBe(false);

    // Discard searchScope reverts the draft
    store.getState().discardPermissionSettings(searchScope);
    expect(permissionSettingsDirty(store.getState().permissionEditor, searchScope)).toBe(false);
    expect(
      store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides,
    ).toBeUndefined();
  });

  it("AgentToolScope declared directories lifecycle: inherit -> select one -> empty [] -> revert to base", async () => {
    const permissions: PermissionsResponse = {
      revision: "rev-dir-1",
      policy: {
        version: 1,
        execution: ExecutionPolicySchema.parse({ modules: { mcp: true } }),
        grants: [
          {
            resource: "mcp.search.query",
            approved: false,
            revision: "v1",
            directories: ["/data/search", "/data/docs"],
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
          directories: ["/data/search", "/data/docs"],
        },
      ],
    };

    setupLibrary({
      getPermissions: vi.fn().mockResolvedValue(permissions),
      getToolDirectory: vi.fn().mockResolvedValue({
        tools: [
          {
            name: "mcp.search.query",
            description: "Search documents",
            parameters: {},
            capability: "search",
            effect: "read",
            sandboxCallable: false,
            invocation: "action" as const,
            scope: "conversation" as const,
            origin: "mcp",
            globalEnabled: true,
            functionId: null,
            resource: "mcp.search.query",
            revision: "v1",
            approvalRequired: true,
            directories: ["/data/search", "/data/docs"],
          },
        ],
      }),
    });
    store.setState({ editorAgentId: AGENT_ALPHA });

    await act(async () =>
      render(
        <DesignSystemProvider>
          <AgentToolScope agentId={AGENT_ALPHA} active />
        </DesignSystemProvider>,
      ),
    );

    // Initial state: inherited from base grant, both directories checked
    const searchCheckbox = screen.getByTestId("agent-dir-mcp.search.query-/data/search");
    const docsCheckbox = screen.getByTestId("agent-dir-mcp.search.query-/data/docs");
    expect(searchCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(docsCheckbox.getAttribute("aria-checked")).toBe("true");

    // Inheritance status shown within directories fieldset container; revert button is absent
    const dirFieldset = screen.getByTestId("agent-directories-mcp.search.query");
    expect(
      within(dirFieldset).getByText(translate("connections.grants.agentOverrideInherited")),
    ).toBeTruthy();
    expect(screen.queryByTestId("agent-tool-revert-mcp.search.query")).toBeNull();

    // 1. Uncheck /data/docs -> creates explicit override with only ["/data/search"]
    await act(async () => {
      fireEvent.click(docsCheckbox);
    });

    expect(docsCheckbox.getAttribute("aria-checked")).toBe("false");
    expect(searchCheckbox.getAttribute("aria-checked")).toBe("true");

    // Revert button now present, status shows explicit override within fieldset
    expect(screen.getByTestId("agent-tool-revert-mcp.search.query")).toBeTruthy();
    expect(
      within(dirFieldset).getByText(translate("connections.grants.agentOverrideExplicit")),
    ).toBeTruthy();

    const overrideDraft1 =
      store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides?.[AGENT_ALPHA];
    expect(overrideDraft1).toBeDefined();
    expect(overrideDraft1?.directories).toEqual(["/data/search"]);

    // 2. Uncheck /data/search -> explicit empty array [], NOT inheritance!
    await act(async () => {
      fireEvent.click(searchCheckbox);
    });

    expect(searchCheckbox.getAttribute("aria-checked")).toBe("false");
    expect(docsCheckbox.getAttribute("aria-checked")).toBe("false");

    const overrideDraft2 =
      store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides?.[AGENT_ALPHA];
    expect(overrideDraft2?.directories).toEqual([]);
    // Still shows explicit override and revert button is still present!
    expect(screen.getByTestId("agent-tool-revert-mcp.search.query")).toBeTruthy();
    expect(
      within(dirFieldset).getByText(translate("connections.grants.agentOverrideExplicit")),
    ).toBeTruthy();

    // 3. Click revert button -> deletes override completely, restores base inheritance
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-tool-revert-mcp.search.query"));
    });

    expect(screen.queryByTestId("agent-tool-revert-mcp.search.query")).toBeNull();
    expect(
      store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides?.[AGENT_ALPHA],
    ).toBeUndefined();
    // Checkboxes reflect base grant again
    expect(searchCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(docsCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(
      within(dirFieldset).getByText(translate("connections.grants.agentOverrideInherited")),
    ).toBeTruthy();
  });

  it("no escalation: directory modification does not escalate approved or enabled status", async () => {
    const permissions: PermissionsResponse = {
      revision: "rev-noesc-1",
      policy: {
        version: 1,
        execution: ExecutionPolicySchema.parse({ modules: { mcp: true } }),
        grants: [
          {
            resource: "mcp.search.query",
            approved: false, // Base unapproved!
            revision: "v1",
            directories: ["/data/search", "/data/docs"],
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
          directories: ["/data/search", "/data/docs"],
        },
      ],
    };

    setupLibrary({
      getPermissions: vi.fn().mockResolvedValue(permissions),
      getToolDirectory: vi.fn().mockResolvedValue({
        tools: [
          {
            name: "mcp.search.query",
            description: "Search documents",
            parameters: {},
            capability: "search",
            effect: "read",
            sandboxCallable: false,
            invocation: "action" as const,
            scope: "conversation" as const,
            origin: "mcp",
            globalEnabled: true,
            functionId: null,
            resource: "mcp.search.query",
            revision: "v1",
            approvalRequired: true,
            directories: ["/data/search", "/data/docs"],
          },
        ],
      }),
    });
    store.setState({ editorAgentId: AGENT_ALPHA });

    await act(async () =>
      render(
        <DesignSystemProvider>
          <AgentToolScope agentId={AGENT_ALPHA} active />
        </DesignSystemProvider>,
      ),
    );

    const docsCheckbox = screen.getByTestId("agent-dir-mcp.search.query-/data/docs");
    await act(async () => {
      fireEvent.click(docsCheckbox);
    });

    const overrideDraft =
      store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides?.[AGENT_ALPHA];
    expect(overrideDraft).toBeDefined();
    // Directory is updated
    expect(overrideDraft?.directories).toEqual(["/data/search"]);
    // Approval is NOT escalated to true!
    expect(overrideDraft?.approved).toBe(false);
    // Effective approval checkbox in UI is still unchecked
    const approveCheckbox = screen.getByTestId("agent-tool-approve-mcp.search.query");
    expect(approveCheckbox.getAttribute("aria-checked")).toBe("false");
  });

  it("basefalse: editing directories when base grant is disabled retains enabled: false without privilege escalation", async () => {
    const permissions: PermissionsResponse = {
      revision: "rev-basefalse-1",
      policy: {
        version: 1,
        execution: ExecutionPolicySchema.parse({ modules: { mcp: true } }),
        grants: [
          {
            resource: "mcp.search.query",
            approved: false,
            revision: "v1",
            directories: ["/data/search", "/data/docs"],
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
          directories: ["/data/search", "/data/docs"],
        },
      ],
    };
    (permissions.policy.grants[0] as { enabled?: boolean }).enabled = false;

    setupLibrary({
      getPermissions: vi.fn().mockResolvedValue(permissions),
      getToolDirectory: vi.fn().mockResolvedValue({
        tools: [
          {
            name: "mcp.search.query",
            description: "Search documents",
            parameters: {},
            capability: "search",
            effect: "read",
            sandboxCallable: false,
            invocation: "action" as const,
            scope: "conversation" as const,
            origin: "mcp",
            globalEnabled: true,
            functionId: null,
            resource: "mcp.search.query",
            revision: "v1",
            approvalRequired: true,
            directories: ["/data/search", "/data/docs"],
          },
        ],
      }),
    });
    store.setState({ editorAgentId: AGENT_ALPHA });

    await act(async () =>
      render(
        <DesignSystemProvider>
          <AgentToolScope agentId={AGENT_ALPHA} active />
        </DesignSystemProvider>,
      ),
    );

    const docsCheckbox = screen.getByTestId("agent-dir-mcp.search.query-/data/docs");
    await act(async () => {
      fireEvent.click(docsCheckbox);
    });

    const overrideDraft =
      store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides?.[AGENT_ALPHA];
    expect(overrideDraft).toBeDefined();
    expect(overrideDraft?.directories).toEqual(["/data/search"]);
    // Enabled must remain explicitly false!
    expect(overrideDraft?.enabled).toBe(false);
    expect(overrideDraft?.approved).toBe(false);
  });

  it.each([
    ["zh-CN", "仅修改当前助手的工具授权；未设置覆盖时继承基础授权。"],
    [
      "en",
      "Only this assistant’s tool grants are edited here. Without an override, base grants apply.",
    ],
  ] as const)(
    "%s: described Agent scope saves only its override and restores base inheritance",
    async (locale, scopeDescription) => {
      const permissions: PermissionsResponse = {
        revision: "rev-persisted-apo-1",
        policy: {
          version: 1,
          execution: ExecutionPolicySchema.parse({ modules: { mcp: true } }),
          grants: [
            {
              resource: "mcp.search.query",
              approved: true,
              revision: "v1-base",
              directories: ["/synthetic/dirA", "/synthetic/dirB"],
              agentOverrides: {
                [AGENT_ALPHA]: {
                  enabled: true,
                  approved: true,
                  revision: "v1-old-alpha",
                  directories: ["/synthetic/dirA"],
                },
                [AGENT_BETA]: {
                  enabled: false,
                  approved: false,
                  revision: "v1-base",
                  directories: [],
                },
              },
            },
          ],
        },
        resources: [
          {
            name: "mcp.search.query",
            resource: "mcp.search.query",
            description: "Search documents",
            effect: "read",
            revision: "v1-base",
            approvalRequired: true,
            directories: ["/synthetic/dirA", "/synthetic/dirB"],
          },
        ],
      };

      const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => ({
        revision: "rev-persisted-apo-saved",
        policy: input.policy,
      }));
      setupLibrary({
        getPermissions: vi.fn().mockResolvedValue(permissions),
        savePermissions: save,
        getToolDirectory: vi.fn().mockResolvedValue({
          tools: [
            {
              name: "mcp.search.query",
              description: "Search documents",
              parameters: {},
              capability: "search",
              effect: "read",
              sandboxCallable: false,
              invocation: "action" as const,
              scope: "conversation" as const,
              origin: "mcp",
              globalEnabled: true,
              functionId: null,
              resource: "mcp.search.query",
              revision: "v1-base",
              approvalRequired: true,
              directories: ["/synthetic/dirA", "/synthetic/dirB"],
            },
          ],
        }),
      });
      selectLocale(locale);
      store.setState({ editorAgentId: AGENT_ALPHA });

      await act(async () =>
        render(
          <DesignSystemProvider>
            <AgentToolScope agentId={AGENT_ALPHA} active />
          </DesignSystemProvider>,
        ),
      );

      const scope = screen.getByRole("region", { name: translate("library.tools.for.agent") });
      const description = document.getElementById(scope.getAttribute("aria-describedby") ?? "");
      expect(description?.textContent).toBe(scopeDescription);
      await act(async () =>
        fireEvent.click(
          within(scope).getByRole("button", {
            name: translate("hints.field.learnAbout", translate("library.tools.for.agent")),
          }),
        ),
      );
      expect((await screen.findByRole("tooltip")).textContent).toContain(
        translate("library.tools.for.agent.hint"),
      );

      const editor = store.getState().permissionEditor!;
      const originalGrant = structuredClone(editor.snapshot.policy.grants[0]);
      const betaDraft = {
        ...originalGrant.agentOverrides![AGENT_BETA],
        directories: ["/synthetic/beta-draft"],
      };
      await act(async () => {
        store.getState().patchExecutionSettings({ research: true });
        store.getState().patchToolGrant("mcp.search.query", {
          agentOverrides: {
            ...editor.grants["mcp.search.query"].agentOverrides,
            [AGENT_BETA]: betaDraft,
          },
        });
      });
      const selectedScope = () =>
        agentPermissionScope(store.getState().permissionEditor, AGENT_ALPHA);
      const assertSaveIsolation = (index: number) => {
        const payload = save.mock.calls[index][0].policy;
        expect(payload.execution).toEqual(permissions.policy.execution);
        expect(payload.grants[0].agentOverrides?.[AGENT_BETA]).toEqual(
          originalGrant.agentOverrides?.[AGENT_BETA],
        );
        const { agentOverrides: _originalOverrides, ...originalBase } = originalGrant;
        const { agentOverrides: _savedOverrides, ...savedBase } = payload.grants[0];
        expect(savedBase).toEqual(originalBase);
        expect(
          store.getState().permissionEditor?.grants["mcp.search.query"].agentOverrides?.[
            AGENT_BETA
          ],
        ).toEqual(betaDraft);
        expect(permissionSettingsDirty(store.getState().permissionEditor, "execution")).toBe(true);
      };
      const dirFieldset = within(scope).getByTestId("agent-directories-mcp.search.query");
      const dirACb = screen.getByTestId("agent-dir-mcp.search.query-/synthetic/dirA");
      const dirBCb = screen.getByTestId("agent-dir-mcp.search.query-/synthetic/dirB");

      // Initially dirA is checked, dirB unchecked (per saved override)
      expect(dirACb.getAttribute("aria-checked")).toBe("true");
      expect(dirBCb.getAttribute("aria-checked")).toBe("false");
      expect(
        within(dirFieldset).getByText(translate("connections.grants.agentOverrideExplicit")),
      ).toBeTruthy();

      const revertBtn = screen.getByTestId("agent-tool-revert-mcp.search.query");
      expect(revertBtn).toBeTruthy();

      // Click revert -> immediately displays base [dirA, dirB]
      await act(async () => {
        fireEvent.click(revertBtn);
      });

      expect(dirACb.getAttribute("aria-checked")).toBe("true");
      expect(dirBCb.getAttribute("aria-checked")).toBe("true");
      expect(
        within(dirFieldset).getByText(translate("connections.grants.agentOverrideInherited")),
      ).toBeTruthy();
      expect(screen.queryByTestId("agent-tool-revert-mcp.search.query")).toBeNull();

      await act(async () => {
        expect(await store.getState().savePermissionSettings(selectedScope())).toBe(true);
      });
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0][0].policy.grants[0].agentOverrides?.[AGENT_ALPHA]).toBeUndefined();
      expect(
        selectEffectivePermissionGrant(
          save.mock.calls[0][0].policy,
          "mcp.search.query",
          AGENT_ALPHA,
        )?.grant.directories,
      ).toEqual(["/synthetic/dirA", "/synthetic/dirB"]);
      assertSaveIsolation(0);

      // Uncheck dirA -> derives from base [dirA, dirB], leaving [dirB]
      await act(async () => {
        fireEvent.click(dirACb);
      });

      expect(dirACb.getAttribute("aria-checked")).toBe("false");
      expect(dirBCb.getAttribute("aria-checked")).toBe("true");

      const overrideDraft =
        store.getState().permissionEditor?.grants["mcp.search.query"]?.agentOverrides?.[
          AGENT_ALPHA
        ];
      expect(overrideDraft).toBeDefined();
      expect(overrideDraft?.directories).toEqual(["/synthetic/dirB"]);
      expect(overrideDraft?.revision).toBe("v1-base");
      await act(async () => {
        expect(await store.getState().savePermissionSettings(selectedScope())).toBe(true);
      });
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[1][0].policy.grants[0].agentOverrides?.[AGENT_ALPHA]).toEqual({
        enabled: true,
        approved: true,
        revision: "v1-base",
        directories: ["/synthetic/dirB"],
      });
      assertSaveIsolation(1);
    },
  );
});
