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
  });
  it("shows the actual stored choice and no unsupported ask-every-time action", async () => {
    desktop();
    await act(async () => render(<Preferences />));
    expect((screen.getByLabelText("关闭窗口时") as HTMLSelectElement).value).toBe("background");
    expect(screen.queryByRole("option", { name: "每次询问" })).toBeNull();
  });
  it("updates with the current revision and never claims a failed write succeeded", async () => {
    const client = setupLibrary();
    desktop();
    await act(async () => render(<Preferences />));
    await act(async () =>
      fireEvent.change(screen.getByLabelText("关闭窗口时"), { target: { value: "exit" } }),
    );
    expect(client.updateDesktopSettings).toHaveBeenCalledWith({
      close_action: "exit",
      expected_revision: 1,
    });
    expect(store.getState().desktopCloseAction).toBe("exit");
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
