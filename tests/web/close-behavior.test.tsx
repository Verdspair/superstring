// §12's close behaviour in 通用 (ADR0018/U07, P5l).
//
// Three promises are asserted here: the block only appears in desktop mode (nothing would obey the
// value in a plain browser), the remembered answer round-trips through the API, and the exit path
// is honest about whether the request actually left the page.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/web/api";
import { CloseBehaviorSettings } from "../../src/web/features/general/CloseBehaviorSettings";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

function withDesktopMeta(): () => void {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "desktop-mode");
  meta.setAttribute("content", "1");
  document.head.appendChild(meta);
  return () => meta.remove();
}

async function renderPage(close_action: "background" | "exit" = "exit") {
  const fake = {
    ...api,
    getDesktopSettings: vi.fn().mockResolvedValue({ close_action, revision: 1 }),
    updateDesktopSettings: vi
      .fn()
      .mockImplementation(async (body: { close_action: "background" | "exit" }) => ({
        close_action: body.close_action,
        revision: 2,
      })),
  } as unknown as typeof api;
  store.getState().resetForTests(fake);
  store.setState({ page: "settings", settingsView: "general" });
  render(<CloseBehaviorSettings />);
  await act(async () => {});
  return fake;
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("关闭窗口时", () => {
  it("在普通浏览器里整块不出现（没有宿主会执行这个值）", async () => {
    await renderPage();
    expect(screen.queryByText("关闭窗口时")).toBeNull();
  });

  it("桌面模式下读取已记住的选择，并把它标成当前项", async () => {
    const remove = withDesktopMeta();
    try {
      const fake = await renderPage("background");
      // Title plus the visually-hidden legend, which is why this is not a single node.
      expect(screen.getAllByText("关闭窗口时").length).toBeGreaterThan(0);
      expect(fake.getDesktopSettings).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: /^保持后台在线/ }).getAttribute("aria-pressed"),
      ).toBe("true");
      expect(screen.getByRole("button", { name: /^完全退出/ }).getAttribute("aria-pressed")).toBe(
        "false",
      );
    } finally {
      remove();
    }
  });

  it("改选后带上 revision 保存，并按新值给出反馈", async () => {
    const remove = withDesktopMeta();
    try {
      const fake = await renderPage("exit");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^保持后台在线/ }));
      });
      expect(fake.updateDesktopSettings).toHaveBeenCalledWith({
        close_action: "background",
        expected_revision: 1,
      });
      expect(store.getState().desktopCloseAction).toBe("background");
      expect(screen.getByText("关闭窗口后将保持后台在线")).toBeTruthy();
    } finally {
      remove();
    }
  });

  it("把「每次询问」列为未开放，而不是给一个当前行为不一致的选项", async () => {
    const remove = withDesktopMeta();
    try {
      await renderPage();
      const ask = screen.getByRole("button", { name: /^每次询问/ }) as HTMLButtonElement;
      expect(ask.disabled).toBe(true);
      expect(screen.getByText(/尚未开放/)).toBeTruthy();
    } finally {
      remove();
    }
  });

  it("退出请求发不出去时如实说明，不假装已经退出", async () => {
    const remove = withDesktopMeta();
    try {
      await renderPage();
      // No liveness socket is open in this test, which is exactly the case the message covers.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "立即完全退出应用" }));
      });
      expect(screen.getByText(/没能发出退出请求/)).toBeTruthy();
    } finally {
      remove();
    }
  });
});
