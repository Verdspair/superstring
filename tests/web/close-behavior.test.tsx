import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Preferences } from "../../src/web/screens/environment/Preferences";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";

let remove: () => void = () => {};
beforeEach(() => {
  setupLibrary();
});
afterEach(() => {
  cleanup();
  remove();
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
  it("offers no close-action choice and keeps the manual quit available", async () => {
    const client = setupLibrary();
    desktop();
    await act(async () => render(<Preferences />));
    // The remembered background/exit choice is gone: closing the window always quits now.
    expect(screen.queryByLabelText("关闭窗口时")).toBeNull();
    expect(screen.queryByRole("option", { name: "保持后台在线" })).toBeNull();
    expect(screen.queryByRole("option", { name: "完全退出" })).toBeNull();
    expect(screen.queryByRole("option", { name: "每次询问" })).toBeNull();
    expect(
      screen.getByText("关闭窗口将退出 Superstring，并停止本地服务与 Agent 运行。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "立即退出应用" })).toBeTruthy();
    // No UI path writes the close preference anymore; the stored value stays whatever it was.
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
