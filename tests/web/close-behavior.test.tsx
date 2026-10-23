import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_ANIMATION_STORAGE_KEY } from "../../src/shared/desktop-preferences";
import { Preferences } from "../../src/web/screens/environment/Preferences";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

let remove: () => void = () => {};
beforeEach(() => {
  setupLibrary();
  localStorage.removeItem(CLOSE_ANIMATION_STORAGE_KEY);
  delete window.superstringPreferences;
});
afterEach(() => {
  cleanup();
  remove();
  delete window.superstringPreferences;
  localStorage.removeItem(CLOSE_ANIMATION_STORAGE_KEY);
  vi.restoreAllMocks();
});
function desktop() {
  const meta = document.createElement("meta");
  meta.name = "desktop-mode";
  meta.content = "1";
  document.head.append(meta);
  remove = () => meta.remove();
}
describe("desktop preference contract", () => {
  it("does not offer host-only controls in an ordinary browser", () => {
    render(<Preferences />);
    expect(screen.queryByLabelText("关闭窗口时")).toBeNull();
    expect(screen.queryByText("立即退出应用")).toBeNull();
    expect(screen.queryByText("桌面行为")).toBeNull();
  });
  it("defaults the animated close on and persists the off and on choices", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: vi.fn().mockResolvedValue({}),
      save,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    const client = setupLibrary();
    desktop();
    await act(async () => render(<Preferences />));
    const choice = screen.getByLabelText("关闭窗口时") as HTMLSelectElement;
    // Default on, with no stored key and no write on mount.
    expect(choice.value).toBe("on");
    expect(screen.getByRole("option", { name: "收回动画后退出" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "立即退出" })).toBeTruthy();
    expect(localStorage.getItem(CLOSE_ANIMATION_STORAGE_KEY)).toBeNull();
    expect(
      save.mock.calls.filter(([snapshot]) => CLOSE_ANIMATION_STORAGE_KEY in snapshot),
    ).toHaveLength(0);
    expect(
      screen.getByText("关闭窗口将退出 Superstring，并停止本地服务与 Agent 运行。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "立即退出应用" })).toBeTruthy();

    // The existing desktop preference bridge stores the user's choice; nothing else writes it.
    await act(async () => {
      fireEvent.change(choice, { target: { value: "off" } });
    });
    expect(localStorage.getItem(CLOSE_ANIMATION_STORAGE_KEY)).toBe("off");
    expect(choice.value).toBe("off");
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ [CLOSE_ANIMATION_STORAGE_KEY]: "off" }),
    );
    await act(async () => {
      fireEvent.change(choice, { target: { value: "on" } });
    });
    expect(localStorage.getItem(CLOSE_ANIMATION_STORAGE_KEY)).toBe("on");
    expect(choice.value).toBe("on");
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith({ [CLOSE_ANIMATION_STORAGE_KEY]: "on" }),
    );
    expect(store.getState().desktopCloseAction).toBe("background");
    expect(client.updateDesktopSettings).not.toHaveBeenCalled();
  });
  it("requires confirmation and reports an unavailable exit transport honestly", async () => {
    desktop();
    await act(async () => render(<Preferences />));
    fireEvent.click(screen.getByRole("button", { name: "立即退出应用" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(screen.getByRole("status").textContent).toContain("暂时无法连接桌面服务");
  });
});
