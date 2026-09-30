// 联网面板交互守卫：自检锁定期不产生可点却无效的按钮，迟到结果不作数，提示不与未保存状态并存。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import { api, type WebAccessSnapshot, type WebAccessTestResult } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { WebAccessPanel } from "../../src/web/screens/connections/web-access-panel";
import { useSuperstringStore as store } from "../../src/web/store";

const permissions: PermissionsResponse = {
  revision: "pr-1",
  policy: { version: 1, grants: [] },
  resources: [],
};

function fakeClient(snapshot?: WebAccessSnapshot) {
  const saved = snapshot ?? { revision: "wa-1", config: { version: 1 } };
  const save = vi.fn(
    async (body: {
      expectedRevision: string;
      config: { version: 1; searxngEndpoint?: string };
    }) => ({
      revision: "wa-2",
      config: body.config,
    }),
  );
  return {
    save,
    client: {
      ...api,
      getPermissions: vi.fn().mockResolvedValue(permissions),
      getWebAccess: vi.fn().mockResolvedValue(saved),
      saveWebAccess: save,
    } as unknown as typeof api,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function renderPanel(fake: Partial<typeof api> = {}, snapshot?: WebAccessSnapshot) {
  store.getState().resetForTests({
    ...api,
    getPermissions: vi.fn().mockResolvedValue(permissions),
    getWebAccess: vi
      .fn()
      .mockResolvedValue(snapshot ?? { revision: "wa-1", config: { version: 1 } }),
    ...fake,
  } as unknown as typeof api);
  const view = render(<WebAccessPanel />);
  await act(async () => {});
  return view;
}

const endpointInput = () => screen.getByLabelText("SearXNG 端点（可选）") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "保存联网配置" }) as HTMLButtonElement;

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
});

describe("web access guards", () => {
  it("does not write when the draft trims to the saved endpoint", async () => {
    const f = fakeClient({
      revision: "wa-1",
      config: { version: 1, searxngEndpoint: "http://127.0.0.1:8888" },
    });
    store.getState().resetForTests(f.client);
    await store.getState().loadWebAccess();
    store.getState().patchWebAccessDraft("  http://127.0.0.1:8888  ");
    expect(await store.getState().saveWebAccessDraft()).toBe(true);
    expect(f.save).not.toHaveBeenCalled();
    expect(store.getState().webAccessDraft).toBe(null);
    expect(store.getState().webAccessSnapshot?.revision).toBe("wa-1");
  });

  it("clears the saved notice as soon as the endpoint is edited again", async () => {
    const f = fakeClient();
    store.getState().resetForTests(f.client);
    await store.getState().loadWebAccess();
    store.setState({ webAccessNotice: "connections.web.saved" });
    store.getState().patchWebAccessDraft("http://127.0.0.1:9999");
    expect(store.getState().webAccessNotice).toBe("");
    expect(store.getState().webAccessDraft).toBe("http://127.0.0.1:9999");
  });

  it("freezes edits and saves while the self-test is running", async () => {
    const f = fakeClient();
    const pending = deferred<WebAccessTestResult>();
    f.client.testWebAccess = vi.fn(() => pending.promise);
    store.getState().resetForTests(f.client);
    await store.getState().loadWebAccess();
    store.getState().patchWebAccessDraft("http://127.0.0.1:9999");
    const running = store.getState().testWebAccess();
    expect(store.getState().webAccessTesting).toBe(true);
    store.getState().patchWebAccessDraft("http://127.0.0.1:7777");
    expect(store.getState().webAccessDraft).toBe("http://127.0.0.1:9999");
    store.getState().discardWebAccessDraft();
    expect(store.getState().webAccessDraft).toBe("http://127.0.0.1:9999");
    expect(await store.getState().saveWebAccessDraft()).toBe(false);
    expect(f.save).not.toHaveBeenCalled();
    pending.resolve({ ok: true, channel: "searxng", elapsedMs: 42 });
    expect(await running).toEqual({ ok: true, channel: "searxng", elapsedMs: 42 });
  });

  it("drops a late result when the api client was replaced", async () => {
    const f = fakeClient();
    const pending = deferred<WebAccessTestResult>();
    f.client.testWebAccess = vi.fn(() => pending.promise);
    store.getState().resetForTests(f.client);
    await store.getState().loadWebAccess();
    const running = store.getState().testWebAccess();
    store.setState({ apiClient: { ...f.client } });
    pending.resolve({ ok: true, channel: "searxng", elapsedMs: 7 });
    expect(await running).toBe(null);
    store.getState().resetForTests(f.client);
  });

  it("drops a late result when the saved configuration changed", async () => {
    const f = fakeClient();
    const pending = deferred<WebAccessTestResult>();
    f.client.testWebAccess = vi.fn(() => pending.promise);
    store.getState().resetForTests(f.client);
    await store.getState().loadWebAccess();
    const running = store.getState().testWebAccess();
    store.setState({ webAccessSnapshot: { revision: "wa-2", config: { version: 1 } } });
    pending.resolve({ ok: true, channel: "searxng", elapsedMs: 7 });
    expect(await running).toBe(null);
    store.getState().resetForTests(f.client);
  });
});

describe("web access panel guards", () => {
  it("uses the full-width single container", async () => {
    const { container } = await renderPanel();
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("w-full");
    expect(root.className).toContain("px-4");
    expect(root.className).not.toContain("max-w-6xl");
  });

  it("locks the endpoint, save and self-test buttons while the self-test runs", async () => {
    const pending = deferred<WebAccessTestResult>();
    const save = vi.fn(
      async (): Promise<WebAccessSnapshot> => ({
        revision: "wa-2",
        config: { version: 1, searxngEndpoint: "http://127.0.0.1:9999" },
      }),
    );
    await renderPanel({ saveWebAccess: save, testWebAccess: vi.fn(() => pending.promise) });
    fireEvent.click(screen.getByRole("button", { name: "自检" }));
    expect(endpointInput().disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
    const running = screen.getByRole("button", { name: "自检进行中…" }) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(save).not.toHaveBeenCalled();
    pending.resolve({ ok: true, channel: "searxng", elapsedMs: 42 });
    await act(async () => {});
    expect(endpointInput().disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("通道：SearXNG，耗时 42 ms");
  });

  it("hides the saved notice as soon as the endpoint is edited again", async () => {
    const save = vi.fn(
      async (): Promise<WebAccessSnapshot> => ({ revision: "wa-2", config: { version: 1 } }),
    );
    await renderPanel({ saveWebAccess: save });
    fireEvent.change(endpointInput(), { target: { value: "http://127.0.0.1:9999" } });
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("已保存");
    fireEvent.change(endpointInput(), { target: { value: "http://127.0.0.1:7777" } });
    expect(screen.queryByRole("status")).toBe(null);
  });

  it("shows the self-test failure detail", async () => {
    const test = vi.fn(
      async (): Promise<WebAccessTestResult> => ({
        ok: false,
        channel: "searxng",
        error: "connection refused",
        elapsedMs: 0,
      }),
    );
    await renderPanel({ testWebAccess: test });
    fireEvent.click(screen.getByRole("button", { name: "自检" }));
    await act(async () => {});
    expect(document.body.textContent).toContain("connection refused");
    expect(store.getState().webAccessTesting).toBe(false);
  });
});
