import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityEditor, IdentityEditor } from "../../src/web/screens/assistants/StudioEditors";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";

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
    render(<CapabilityEditor active={false} />);
    await act(async () => {});
    expect(organization).not.toHaveBeenCalled();
    expect(capacity).not.toHaveBeenCalled();
  });
  it("starts each necessary read once on activation", async () => {
    setupLibrary();
    const organization = vi.fn().mockResolvedValue(undefined);
    const capacity = vi.fn().mockResolvedValue(undefined);
    store.setState({ loadOrganization: organization, refreshCapacityPreview: capacity });
    const { rerender } = render(<CapabilityEditor active={false} />);
    await act(async () => {});
    rerender(<CapabilityEditor active />);
    await act(async () => {});
    expect(organization).toHaveBeenCalledTimes(1);
    expect(capacity).toHaveBeenCalledTimes(1);
  });
  it("keeps identity draft content across unrelated background updates", async () => {
    setupLibrary();
    const { container } = render(<IdentityEditor />);
    const firstInput = container.querySelector("input");
    const editor = store.getState().pageEditor;
    await act(async () => {
      store.setState({ qqStickerLoading: true });
    });
    expect(container.querySelector("input")).toBe(firstInput);
    expect(store.getState().pageEditor).toBe(editor);
  });
});
