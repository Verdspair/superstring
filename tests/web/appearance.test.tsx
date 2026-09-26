// Presentation-specific cases moved to fresh-product-workspaces.test.tsx.
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyMode,
  applyTheme,
  MODE_STORAGE_KEY,
  observeSystemAppearance,
  readMode,
  readTheme,
  resolveTheme,
  selectMode,
  selectTheme,
  THEME_STORAGE_KEY,
  THEMES,
} from "../../src/web/appearance";
import { useSuperstringStore } from "../../src/web/store";

// 侧栏与新会话设置只用 id/name/is_active，其余字段与本次 UI 断言无关。

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.themeUnsaved;
  delete document.documentElement.dataset.modeUnsaved;
  applyTheme("slate");
  applyMode("system");
  useSuperstringStore.getState().resetForTests();
  useSuperstringStore.setState({
    status: "ready",
    bootstrap: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  applyTheme("slate");
  applyMode("system");
  localStorage.clear();
  delete document.documentElement.dataset.themeUnsaved;
  delete document.documentElement.dataset.modeUnsaved;
});

it("浏览器拒绝保存时同步读取仍保持当前完整外观", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "slate");
  localStorage.setItem(MODE_STORAGE_KEY, "light");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(selectTheme("rose")).toBe(false);
  expect(selectMode("dark")).toBe(false);
  expect({ theme: readTheme(), mode: readMode() }).toEqual({
    theme: "rose",
    mode: "dark",
  });
  expect(document.documentElement.dataset.theme).toBe("rose");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

it("切回默认清除覆盖，未知/损坏偏好回退", () => {
  for (const theme of THEMES) {
    applyTheme(theme.id);
    expect(document.documentElement.dataset.theme).toBe(theme.id);
  }
  applyTheme("slate");
  expect(document.documentElement.style.getPropertyValue("--superstring-tone-deep")).toBe("");
  localStorage.setItem(THEME_STORAGE_KEY, "invalid-color");
  expect(readTheme()).toBe("slate");
  expect(resolveTheme(null).id).toBe("slate");
});

it("主题只投影强调色，中性表面与边框由语义令牌保持一致", () => {
  const root = document.documentElement;
  for (const theme of THEMES) {
    applyTheme(theme.id);
    for (const role of ["--primary", "--ring", "--sidebar-primary", "--sidebar-ring"])
      expect(root.style.getPropertyValue(role)).toBe(`light-dark(${theme.color}, ${theme.dark})`);
    expect(root.style.getPropertyValue("--primary-foreground")).toBe(
      "light-dark(#ffffff, #171717)",
    );
    for (const property of [
      "--superstring-tone-deep",
      "--superstring-tone-light",
      "--superstring-tone-line",
      "--superstring-tone-soft",
      "--ac-accent-soft",
      "--background",
      "--card",
      "--accent",
      "--border",
    ])
      expect(root.style.getPropertyValue(property)).toBe("");
  }
});

it("进入外观仍遵守助手草稿的未保存保护", () => {
  useSuperstringStore.setState({
    page: "settings",
    settingsView: "agents",
    dirty: true,
  });
  useSuperstringStore.getState().requestPageNavigation("settings", "appearance");
  expect(useSuperstringStore.getState().settingsView).toBe("agents");
  expect(useSuperstringStore.getState().navigationConfirmOpen).toBe(true);
  expect(useSuperstringStore.getState().pendingNavigation).toEqual({
    kind: "page",
    page: "settings",
    settingsView: "appearance",
  });
});

it("跟随系统只改变实际配色，不覆盖保存的模式或手动选择", () => {
  let dark = true;
  let notify: (() => void) | undefined;
  const remove = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_: string, listener: () => void) => {
        notify = listener;
      },
      removeEventListener: remove,
    })),
  );
  try {
    selectMode("system");
    const stop = observeSystemAppearance();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    dark = false;
    notify?.();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(readMode()).toBe("system");
    selectMode("dark");
    notify?.();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(readMode()).toBe("dark");
    stop();
    expect(remove).toHaveBeenCalledWith("change", notify);
  } finally {
    vi.unstubAllGlobals();
  }
});
