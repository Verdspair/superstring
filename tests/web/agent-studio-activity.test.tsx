import { act, cleanup, render } from "@testing-library/react";
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
    setupLibrary({ getPermissions });
    const view = (active: boolean) => (
      <DesignSystemProvider>
        <AgentToolScope agentId={A} active={active} />
      </DesignSystemProvider>
    );
    const { container, rerender } = render(view(false));
    await act(async () => {});
    expect(getPermissions).not.toHaveBeenCalled();
    rerender(view(true));
    await act(async () => {});
    expect(getPermissions).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("tool-a");
    rerender(view(false));
    await act(async () => {});
    rerender(view(true));
    await act(async () => {});
    expect(getPermissions).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("tool-a");
    expect(container.textContent).not.toContain("正在加载…");
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
    setupLibrary({ getPermissions });
    const view = (agentId: string, active: boolean) => (
      <DesignSystemProvider>
        <AgentToolScope agentId={agentId} active={active} />
      </DesignSystemProvider>
    );
    const { container, rerender } = render(view(A, true));
    await act(async () => {});
    expect(container.textContent).toContain("tool-a");
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
    expect(container.textContent).not.toContain("tool-a");
    await act(async () => {
      second.resolve(permissions(B, "tool-b"));
    });
    expect(container.textContent).toContain("tool-b");
    expect(container.textContent).not.toContain("tool-a");
  });
  it("ignores a closed agent's late tool response after switching", async () => {
    const first = deferred<PermissionsResponse>();
    const second = deferred<PermissionsResponse>();
    const getPermissions = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    setupLibrary({ getPermissions });
    const view = (agentId: string, active: boolean) => (
      <DesignSystemProvider>
        <AgentToolScope agentId={agentId} active={active} />
      </DesignSystemProvider>
    );
    const { container, rerender } = render(view(A, true));
    await act(async () => {});
    rerender(view(A, false));
    await act(async () => {});
    await act(async () => {
      store.setState({ editorAgentId: B });
    });
    rerender(view(B, true));
    await act(async () => {});
    expect(getPermissions).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve(permissions(B, "tool-b"));
    });
    expect(container.textContent).toContain("tool-b");
    await act(async () => {
      first.resolve(permissions(A, "tool-a"));
    });
    expect(container.textContent).toContain("tool-b");
    expect(container.textContent).not.toContain("tool-a");
  });
});
