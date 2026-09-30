// 联网（web-access）面板：草稿→保存的 CAS 载荷、409 冲突保留草稿、自检成功/失败渲染，
// 以及真实 HTTP 客户端的 wire 形状。路由归属在 capabilities-workspace.test.tsx 中验证：
// 联网与执行设置已移归系统能力，接入工作区不再有联网 tab。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import {
  ApiError,
  api,
  type WebAccessConfig,
  type WebAccessSnapshot,
  type WebAccessTestResult,
} from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { ConnectionWorkspace } from "../../src/web/screens/connections/ConnectionWorkspace";
import { WebAccessPanel } from "../../src/web/screens/connections/web-access-panel";
import { useSuperstringStore as store } from "../../src/web/store";
import { activeSpace } from "../../src/web/workspace/navigation";

const permissions: PermissionsResponse = {
  revision: "pr-1",
  policy: { version: 1, grants: [] },
  resources: [],
};

// 接入工作区整屏渲染需要 QQ 接入的读取全部有答案；联网读取自带一份空配置快照。
function workspaceFake() {
  return {
    ...api,
    getQqSettings: vi.fn().mockResolvedValue({
      enabled: false,
      account_id: null,
      judgement_model_name: null,
      transport: { endpoint: null, has_token: false },
      revision: 1,
    }),
    getQqStatus: vi.fn().mockResolvedValue({ connection: { phase: "idle", reason: null } }),
    listQqConversations: vi.fn().mockResolvedValue([]),
    listQqBindings: vi.fn().mockResolvedValue([]),
    listQqSchemes: vi.fn().mockResolvedValue([]),
    getPermissions: vi.fn().mockResolvedValue(permissions),
    getWebAccess: vi.fn().mockResolvedValue({ revision: "wa-1", config: { version: 1 } }),
  } as unknown as typeof api;
}

async function renderWorkspace() {
  store.getState().resetForTests(workspaceFake());
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "tool-grants" });
  render(<ConnectionWorkspace />);
  await act(async () => {});
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
  render(<WebAccessPanel />);
  await act(async () => {});
}

const endpointInput = () => screen.getByLabelText("SearXNG 端点（可选）") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "保存联网配置" }) as HTMLButtonElement;

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("web access routing", () => {
  it("belongs to the system capabilities space and has no tab in the connections workspace", async () => {
    expect(
      activeSpace({ page: "settings", settingsView: "workspace", settingsRoute: "web-access" }),
    ).toBe("capabilities");
    await renderWorkspace();
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("工具授权");
    expect(screen.queryByRole("tab", { name: "联网" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "联网" })).toBeNull();
  });
});

describe("web access panel", () => {
  it("loads the saved endpoint and only enables save for a changed draft", async () => {
    await renderPanel(
      {},
      { revision: "wa-1", config: { version: 1, searxngEndpoint: "http://127.0.0.1:8888" } },
    );
    expect(endpointInput().value).toBe("http://127.0.0.1:8888");
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(endpointInput(), { target: { value: "http://127.0.0.1:9999" } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.change(endpointInput(), { target: { value: "http://127.0.0.1:8888" } });
    expect(saveButton().disabled).toBe(true);
  });

  it("saves the trimmed draft with the loaded revision and adopts the saved baseline", async () => {
    const save = vi.fn(async (body: { expectedRevision: string; config: WebAccessConfig }) => ({
      revision: "wa-2",
      config: body.config,
    }));
    await renderPanel({ saveWebAccess: save });
    fireEvent.change(endpointInput(), { target: { value: " http://127.0.0.1:9999 " } });
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toEqual({
      expectedRevision: "wa-1",
      config: { version: 1, searxngEndpoint: "http://127.0.0.1:9999" },
    });
    expect(screen.getByRole("status").textContent).toContain("已保存");
    expect(endpointInput().value).toBe("http://127.0.0.1:9999");
    expect(saveButton().disabled).toBe(true);
  });

  it("treats a blank draft as the built-in Bing only configuration", async () => {
    const save = vi.fn(async (body: { expectedRevision: string; config: WebAccessConfig }) => ({
      revision: "wa-2",
      config: body.config,
    }));
    await renderPanel(
      { saveWebAccess: save },
      {
        revision: "wa-1",
        config: { version: 1, searxngEndpoint: "http://127.0.0.1:8888" },
      },
    );
    fireEvent.change(endpointInput(), { target: { value: "   " } });
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(save.mock.calls[0][0]).toEqual({ expectedRevision: "wa-1", config: { version: 1 } });
  });

  it("keeps the draft and prompts a reread on a 409 conflict", async () => {
    const save = vi
      .fn()
      .mockRejectedValue(
        new ApiError(409, "WEB_CONFIG_CONFLICT", "联网配置已变化，请重新读取后保存"),
      );
    await renderPanel({ saveWebAccess: save });
    fireEvent.change(endpointInput(), { target: { value: "http://127.0.0.1:9999" } });
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(save).toHaveBeenCalledTimes(1);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("联网配置已变化");
    expect(endpointInput().value).toBe("http://127.0.0.1:9999");
    expect(document.activeElement).toBe(alert);
  });

  it("disables the self-test while running and reports channel and elapsed time", async () => {
    const pending = Promise.withResolvers<WebAccessTestResult>();
    const test = vi.fn().mockReturnValue(pending.promise);
    await renderPanel({ testWebAccess: test });
    fireEvent.click(screen.getByRole("button", { name: "自检" }));
    await act(async () => {});
    expect(test).toHaveBeenCalledTimes(1);
    const running = screen.getByRole("button", { name: "自检进行中…" }) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    fireEvent.click(running);
    expect(test).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ ok: true, channel: "searxng", elapsedMs: 42 }));
    expect(screen.getByRole("status").textContent).toBe("通道：SearXNG，耗时 42 ms");
    expect((screen.getByRole("button", { name: "自检" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("shows the channel error text when the self-test fails", async () => {
    const test = vi
      .fn()
      .mockResolvedValue({ ok: false, channel: "bing", elapsedMs: 12, error: "SEARCH_FAILED" });
    await renderPanel({ testWebAccess: test });
    fireEvent.click(screen.getByRole("button", { name: "自检" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toBe("自检失败：SEARCH_FAILED");
  });

  it("uses the documented wire shape through the real HTTP client", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const answer = (value: unknown) =>
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url === "/v2/web-access" && method === "GET")
        return answer({ revision: "wa-1", config: { version: 1 } });
      if (url === "/v2/permissions" && method === "GET")
        return answer({ revision: "pr-1", policy: { version: 1, grants: [] }, resources: [] });
      if (url === "/v2/web-access" && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { config: WebAccessConfig };
        return answer({ revision: "wa-2", config: body.config });
      }
      if (url === "/v2/web-access/test") return answer({ ok: true, channel: "bing", elapsedMs: 7 });
      throw new Error(`unexpected ${method} ${url}`);
    });
    store.getState().resetForTests();
    render(<WebAccessPanel />);
    await act(async () => {});
    fireEvent.change(endpointInput(), { target: { value: "http://127.0.0.1:8888" } });
    fireEvent.click(saveButton());
    await act(async () => {});
    const put = fetcher.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
    );
    if (!put) throw new Error("PUT request was not captured");
    expect(put[0]).toBe("/v2/web-access");
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({
      expectedRevision: "wa-1",
      config: { version: 1, searxngEndpoint: "http://127.0.0.1:8888" },
    });
    expect(screen.getByRole("status").textContent).toContain("已保存");
    fireEvent.click(screen.getByRole("button", { name: "自检" }));
    await act(async () => {});
    const test = fetcher.mock.calls.find((call) => {
      const init = call[1] as RequestInit | undefined;
      return String(call[0]) === "/v2/web-access/test" && init?.method === "POST";
    });
    if (!test) throw new Error("self-test request was not captured");
    expect(screen.getByRole("status").textContent).toBe("通道：内置 Bing，耗时 7 ms");
  });
});
