// 联网端点草稿的 store 持久化、离页守卫与面板接线：草稿跨路由/跨刷新保留，
// 离开设置页按作用域统一保存或放弃，自检只针对已保存配置。
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import { api, type WebAccessConfig } from "../../src/web/api";
import { webAccessDraftDirty } from "../../src/web/features/access/web-access-state";
import { settingsHaveDrafts } from "../../src/web/features/qq/draft-state";
import { selectLocale } from "../../src/web/i18n";
import { WebAccessPanel } from "../../src/web/screens/connections/web-access-panel";
import { useSuperstringStore as store } from "../../src/web/store";

const permissions: PermissionsResponse = {
  revision: "pr-1",
  policy: { version: 1, grants: [] },
  resources: [],
};

function fake(snapshot?: { revision: string; config: WebAccessConfig }) {
  const current = snapshot ?? { revision: "wa-1", config: { version: 1 } };
  const save = vi.fn(async (body: { expectedRevision: string; config: WebAccessConfig }) => ({
    revision: "wa-2",
    config: body.config,
  }));
  return {
    save,
    client: {
      ...api,
      getPermissions: vi.fn().mockResolvedValue(permissions),
      getWebAccess: vi.fn().mockResolvedValue(current),
      saveWebAccess: save,
    } as unknown as typeof api,
  };
}

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
});

describe("web access draft store", () => {
  it("only counts a non-null trimmed draft that differs from the saved endpoint", () => {
    const snapshot = {
      revision: "wa-1",
      config: { version: 1 as const, searxngEndpoint: "http://127.0.0.1:8888" },
    };
    expect(webAccessDraftDirty(snapshot, null)).toBe(false);
    expect(webAccessDraftDirty(snapshot, "  http://127.0.0.1:8888  ")).toBe(false);
    expect(webAccessDraftDirty(snapshot, "http://127.0.0.1:9999")).toBe(true);
    expect(webAccessDraftDirty(null, "x")).toBe(true);
    expect(webAccessDraftDirty(null, "")).toBe(false);
  });

  it("saves the trimmed draft, adopts the saved baseline and clears the draft", async () => {
    const f = fake();
    store.getState().resetForTests(f.client);
    await store.getState().loadWebAccess();
    store.getState().patchWebAccessDraft(" http://127.0.0.1:9999 ");
    expect(settingsHaveDrafts(store.getState())).toBe(true);
    expect(await store.getState().saveWebAccessDraft()).toBe(true);
    expect(f.save).toHaveBeenCalledWith({
      expectedRevision: "wa-1",
      config: { version: 1, searxngEndpoint: "http://127.0.0.1:9999" },
    });
    expect(store.getState().webAccessDraft).toBe(null);
    expect(store.getState().webAccessSnapshot?.config.searxngEndpoint).toBe(
      "http://127.0.0.1:9999",
    );
    expect(settingsHaveDrafts(store.getState())).toBe(false);
  });

  it("treats a blank draft as built-in Bing only and keeps the draft on failure", async () => {
    const f = fake({
      revision: "wa-1",
      config: { version: 1, searxngEndpoint: "http://127.0.0.1:8888" },
    });
    f.save.mockRejectedValueOnce(new Error("联网配置已变化，请重新读取后保存"));
    store.getState().resetForTests(f.client);
    await store.getState().loadWebAccess();
    store.getState().patchWebAccessDraft("   ");
    expect(await store.getState().saveWebAccessDraft()).toBe(false);
    expect(store.getState().webAccessError).toContain("联网配置已变化");
    expect(store.getState().webAccessDraft).toBe("   ");
    store.getState().discardWebAccessDraft();
    expect(store.getState().webAccessDraft).toBe(null);
    expect(
      webAccessDraftDirty(store.getState().webAccessSnapshot, store.getState().webAccessDraft),
    ).toBe(false);
  });
});

describe("web access draft navigation guards", () => {
  async function setupSettings() {
    const f = fake();
    store.getState().resetForTests(f.client);
    await store.getState().loadWebAccess();
    store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "web-access" });
    return f;
  }

  it("asks before leaving settings with a dirty endpoint draft and discards it on demand", async () => {
    await setupSettings();
    store.getState().patchWebAccessDraft("http://127.0.0.1:9999");
    store.getState().openChat();
    expect(store.getState().page).toBe("settings");
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().navigationConfirmMessage).toContain("设置中有未保存页面");
    store.getState().cancelPendingNavigation();
    store.getState().openChat();
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().page).toBe("chat");
    expect(store.getState().webAccessDraft).toBe(null);
  });

  it("saves the draft when leaving settings through the save path", async () => {
    const f = await setupSettings();
    store.getState().patchWebAccessDraft("http://127.0.0.1:9999");
    store.getState().openChat();
    await store.getState().confirmSaveAndContinue();
    expect(f.save).toHaveBeenCalledWith({
      expectedRevision: "wa-1",
      config: { version: 1, searxngEndpoint: "http://127.0.0.1:9999" },
    });
    expect(store.getState().page).toBe("chat");
    expect(store.getState().webAccessDraft).toBe(null);
  });

  it("ignores navigation and route changes while the web configuration is saving", async () => {
    await setupSettings();
    store.setState({ webAccessSaving: true });
    store.getState().openChat();
    expect(store.getState().page).toBe("settings");
    expect(store.getState().pendingNavigation).toBe(null);
    store.getState().openSettingsRoute("tool-grants");
    expect(store.getState().settingsRoute).toBe("web-access");
  });
});

describe("web access panel wiring", () => {
  async function renderPanel() {
    const f = fake();
    store.getState().resetForTests(f.client);
    render(<WebAccessPanel />);
    await act(async () => {});
    return f;
  }

  const endpointInput = () => screen.getByLabelText("SearXNG 端点（可选）") as HTMLInputElement;
  const testButton = () => screen.getByRole("button", { name: "自检" }) as HTMLButtonElement;

  it("embeds the capability switch and the web-scoped grants instead of the old jump", async () => {
    await renderPanel();
    expect(screen.getByRole("heading", { name: "执行开关" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "使用联网工具" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "工具授权" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "前往工具授权" })).toBeNull();
    expect(screen.getByText("自检验证的是已保存的配置；请先保存端点修改。")).toBeTruthy();
  });

  it("disables the self-test while the endpoint draft is unsaved and re-enables it after save", async () => {
    const f = await renderPanel();
    expect(testButton().disabled).toBe(false);
    fireEvent.change(endpointInput(), { target: { value: "http://127.0.0.1:9999" } });
    expect(testButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "保存联网配置" }));
    await act(async () => {});
    expect(testButton().disabled).toBe(false);
    expect(f.save).toHaveBeenCalledTimes(1);
  });

  it("discards only the endpoint draft from the channels section", async () => {
    await renderPanel();
    fireEvent.change(endpointInput(), { target: { value: "http://127.0.0.1:9999" } });
    const channels = screen.getByRole("heading", { name: "搜索通道" }).closest("section");
    if (!channels) throw new Error("channels section missing");
    fireEvent.click(within(channels).getByRole("button", { name: "放弃修改" }));
    expect(endpointInput().value).toBe("");
    expect(
      (screen.getByRole("button", { name: "保存联网配置" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
