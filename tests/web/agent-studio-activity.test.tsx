import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import {
  AgentToolScope,
  CapabilityEditor,
  IdentityEditor,
} from "../../src/web/screens/assistants/StudioEditors";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, B, setupLibrary } from "./helpers/library-fixture";

function permissions(agentId: string, resource: string): PermissionsResponse {
  return {
    revision: "permission-1",
    policy: {
      version: 1,
      grants: [{ resource, approved: true, agentIds: [agentId], revision: "1", directories: [] }],
    },
    resources: [
      {
        name: resource,
        description: "",
        effect: "read",
        resource,
        revision: "1",
        approvalRequired: true,
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("Agent studio activity", () => {
  it("does not initiate organization or capacity reads while hidden", async () => {
    setupLibrary();
    const organization = vi.fn().mockResolvedValue(undefined);
    const capacity = vi.fn().mockResolvedValue(undefined);
    store.setState({ loadOrganization: organization, refreshCapacityPreview: capacity });
    render(
      <DesignSystemProvider>
        <CapabilityEditor active={false} />
      </DesignSystemProvider>,
    );
    await act(async () => {});
    expect(organization).not.toHaveBeenCalled();
    expect(capacity).not.toHaveBeenCalled();
  });
  it("starts each necessary read once on activation", async () => {
    setupLibrary();
    const organization = vi.fn().mockResolvedValue(undefined);
    const capacity = vi.fn().mockResolvedValue(undefined);
    store.setState({ loadOrganization: organization, refreshCapacityPreview: capacity });
    const { rerender } = render(
      <DesignSystemProvider>
        <CapabilityEditor active={false} />
      </DesignSystemProvider>,
    );
    await act(async () => {});
    rerender(
      <DesignSystemProvider>
        <CapabilityEditor active />
      </DesignSystemProvider>,
    );
    await act(async () => {});
    expect(organization).toHaveBeenCalledTimes(1);
    expect(capacity).toHaveBeenCalledTimes(1);
  });
  it("keeps identity draft content across unrelated background updates", async () => {
    setupLibrary();
    const { container } = render(
      <DesignSystemProvider>
        <IdentityEditor />
      </DesignSystemProvider>,
    );
    const firstInput = container.querySelector("input");
    const editor = store.getState().pageEditor;
    await act(async () => {
      store.setState({ qqStickerLoading: true });
    });
    expect(container.querySelector("input")).toBe(firstInput);
    expect(store.getState().pageEditor).toBe(editor);
  });
  it("keeps approved tool badges across a tab roundtrip and revalidates identity changes", async () => {
    const getPermissions = vi.fn(async () => permissions(A, "tool-a"));
    const getToolDirectory = vi.fn(async () => ({
      tools: [
        {
          name: "tool-a",
          description: "Tool A",
          parameters: {},
          capability: "test",
          effect: "read" as const,
          sandboxCallable: false,
          origin: "mcp" as const,
          globalEnabled: true,
          functionId: null,
          resource: "tool-a",
          revision: "1",
          approvalRequired: true,
          directories: [],
        },
      ],
    }));
    setupLibrary({ getPermissions, getToolDirectory });
    const view = (active: boolean) => (
      <DesignSystemProvider>
        <AgentToolScope agentId={A} active={active} />
      </DesignSystemProvider>
    );
    // 1. Initial hidden: 0 reads
    const { container, rerender } = render(view(false));
    await act(async () => {});
    expect(getPermissions).not.toHaveBeenCalled();
    expect(getToolDirectory).not.toHaveBeenCalled();

    // 2. Initial active: first read (1 directory, 1 permissions)
    rerender(view(true));
    await act(async () => {});
    expect(getPermissions).toHaveBeenCalledTimes(1);
    expect(getToolDirectory).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("tool-a");

    // 3. Tab hidden: 0 additional reads
    rerender(view(false));
    await act(async () => {});
    expect(getToolDirectory).toHaveBeenCalledTimes(1);

    // 4. First reactivate: useSharedResource silent revalidates (!revalidated.current), total = 2
    rerender(view(true));
    await act(async () => {});
    expect(getToolDirectory).toHaveBeenCalledTimes(2);
    expect(getPermissions).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("tool-a");
    expect(container.textContent).not.toContain("正在加载…");

    // 5. Subsequent hidden -> visible cycle: revalidated.current is true, no additional directory read (still 2)
    rerender(view(false));
    await act(async () => {});
    rerender(view(true));
    await act(async () => {});
    expect(getToolDirectory).toHaveBeenCalledTimes(2);

    // 6. Ordinary unrelated render: 0 additional directory reads
    rerender(view(true));
    await act(async () => {});
    expect(getToolDirectory).toHaveBeenCalledTimes(2);

    // 7. API identity change: new client object triggers read on fresh cache
    const nextPermissions = vi.fn(async () => permissions(A, "tool-a"));
    await act(async () => {
      store.setState({
        apiClient: { ...store.getState().apiClient, getPermissions: nextPermissions },
      });
    });
    expect(nextPermissions).toHaveBeenCalledTimes(1);
  });
  it("does not paint the previous agent's tool badges while the new agent loads", async () => {
    const second = deferred<PermissionsResponse>();
    const getPermissions = vi
      .fn()
      .mockResolvedValueOnce(permissions(A, "tool-a"))
      .mockImplementationOnce(() => second.promise);
    const getToolDirectory = vi.fn(async () => ({
      tools: [
        {
          name: "tool-a",
          description: "Tool A",
          parameters: {},
          capability: "test",
          effect: "read" as const,
          sandboxCallable: false,
          origin: "mcp" as const,
          globalEnabled: true,
          functionId: null,
          resource: "tool-a",
          revision: "1",
          approvalRequired: true,
          directories: [],
        },
        {
          name: "tool-b",
          description: "Tool B",
          parameters: {},
          capability: "test",
          effect: "read" as const,
          sandboxCallable: false,
          origin: "mcp" as const,
          globalEnabled: true,
          functionId: null,
          resource: "tool-b",
          revision: "1",
          approvalRequired: true,
          directories: [],
        },
      ],
    }));
    setupLibrary({ getPermissions, getToolDirectory });
    const view = (agentId: string, active: boolean) => (
      <DesignSystemProvider>
        <AgentToolScope agentId={agentId} active={active} />
      </DesignSystemProvider>
    );
    const { rerender } = render(view(A, true));
    await act(async () => {});
    expect(screen.getByTestId("agent-tool-enable-tool-a").getAttribute("aria-checked")).toBe(
      "true",
    );
    rerender(view(A, false));
    await act(async () => {});
    await act(async () => {
      store.setState({ editorAgentId: B });
    });
    rerender(view(B, false));
    await act(async () => {});
    rerender(view(B, true));
    await act(async () => {});
    expect(getPermissions).toHaveBeenCalledTimes(2);
    // While Agent B loads, tool-a must NOT be enabled for B
    expect(screen.getByTestId("agent-tool-enable-tool-a").getAttribute("aria-checked")).toBe(
      "false",
    );
    await act(async () => {
      second.resolve(permissions(B, "tool-b"));
    });
    // When B finishes loading, tool-b is enabled for B, and tool-a is not enabled
    expect(screen.getByTestId("agent-tool-enable-tool-b").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("agent-tool-enable-tool-a").getAttribute("aria-checked")).toBe(
      "false",
    );
  });
  it("ignores a closed agent's late tool response after switching", async () => {
    const first = deferred<PermissionsResponse>();
    const second = deferred<PermissionsResponse>();
    const getPermissions = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const getToolDirectory = vi.fn(async () => ({
      tools: [
        {
          name: "tool-a",
          description: "Tool A",
          parameters: {},
          capability: "test",
          effect: "read" as const,
          sandboxCallable: false,
          origin: "mcp" as const,
          globalEnabled: true,
          functionId: null,
          resource: "tool-a",
          revision: "1",
          approvalRequired: true,
          directories: [],
        },
        {
          name: "tool-b",
          description: "Tool B",
          parameters: {},
          capability: "test",
          effect: "read" as const,
          sandboxCallable: false,
          origin: "mcp" as const,
          globalEnabled: true,
          functionId: null,
          resource: "tool-b",
          revision: "1",
          approvalRequired: true,
          directories: [],
        },
      ],
    }));
    setupLibrary({ getPermissions, getToolDirectory });
    const view = (agentId: string, active: boolean) => (
      <DesignSystemProvider>
        <AgentToolScope agentId={agentId} active={active} />
      </DesignSystemProvider>
    );
    const { rerender } = render(view(A, true));
    await act(async () => {});
    rerender(view(A, false));
    await act(async () => {});
    await act(async () => {
      store.setState({ editorAgentId: B });
      void store.getState().loadPermissionSettings(true);
    });
    rerender(view(B, true));
    await act(async () => {});
    expect(getPermissions).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve(permissions(B, "tool-b"));
    });
    expect(screen.getByTestId("agent-tool-enable-tool-b").getAttribute("aria-checked")).toBe(
      "true",
    );
    await act(async () => {
      first.resolve(permissions(A, "tool-a"));
    });
    // Stale response from Agent A does not pollute Agent B's controls
    expect(screen.getByTestId("agent-tool-enable-tool-b").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("agent-tool-enable-tool-a").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("API identity switch while request in-flight: only API B is effective, API A does not install, and controls do not show stale authorization", async () => {
    const apiA_deferred = deferred<PermissionsResponse>();
    const apiB_deferred = deferred<PermissionsResponse>();

    const getPermissionsA = vi.fn().mockImplementation(() => apiA_deferred.promise);
    const getPermissionsB = vi.fn().mockImplementation(() => apiB_deferred.promise);

    const getToolDirectory = vi.fn(async () => ({
      tools: [
        {
          name: "tool-a",
          description: "Tool A",
          parameters: {},
          capability: "test",
          effect: "read" as const,
          sandboxCallable: false,
          origin: "mcp" as const,
          globalEnabled: true,
          functionId: null,
          resource: "tool-a",
          revision: "1",
          approvalRequired: true,
          directories: [],
        },
      ],
    }));

    setupLibrary({ getPermissions: getPermissionsA, getToolDirectory });

    const view = (active: boolean) => (
      <DesignSystemProvider>
        <AgentToolScope agentId={A} active={active} />
      </DesignSystemProvider>
    );

    // 1. Initial mount with API A: triggers getPermissionsA (in-flight)
    render(view(true));
    await act(async () => {});
    expect(getPermissionsA).toHaveBeenCalledTimes(1);
    expect(getPermissionsB).not.toHaveBeenCalled();

    // 2. While API A is still in flight, switch to API B
    await act(async () => {
      store.setState({
        apiClient: { ...store.getState().apiClient, getPermissions: getPermissionsB },
      });
    });

    // API B triggers its unique read
    expect(getPermissionsB).toHaveBeenCalledTimes(1);

    // 3. API A resolves late with tool-a granted under API A
    await act(async () => {
      apiA_deferred.resolve(permissions(A, "tool-a"));
    });

    // Because API A is superseded (get().apiClient !== apiA), API A's response is dropped and does not install
    // So tool-a is NOT enabled yet
    expect(screen.getByTestId("agent-tool-enable-tool-a").getAttribute("aria-checked")).toBe(
      "false",
    );

    // 4. API B resolves with tool-a granted under API B
    await act(async () => {
      apiB_deferred.resolve(permissions(A, "tool-a"));
    });

    // Now API B's response installs, and tool-a is enabled!
    expect(screen.getByTestId("agent-tool-enable-tool-a").getAttribute("aria-checked")).toBe(
      "true",
    );
  });
});
