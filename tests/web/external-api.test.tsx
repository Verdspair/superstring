// 外部模型API（0032）：登记服务、写只读的密钥、手填上下文窗口。
//
// The two promises worth pinning: the stored key is never rendered (the field is empty and
// password-typed, and clearing it is its own explicit action), and a model cannot be saved without
// a context window — that number is what keeps the QQ chain able to call an external model at all.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderResponse } from "../../src/shared/contracts/models";
import { api, type SuperstringApi } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { ModelServices } from "../../src/web/screens/environment/ModelServices";
import { useSuperstringStore as store } from "../../src/web/store";

const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";

const provider: ModelProviderResponse = {
  id: PROVIDER_ID,
  name: "DeepSeek",
  base_url: "https://api.deepseek.com/v1",
  has_api_key: true,
  models: [{ name: "deepseek-chat", context_window: 65536 }],
  revision: 3,
  created_at: "2026-09-25T00:00:00.000000Z",
  updated_at: "2026-09-25T00:00:00.000000Z",
};

async function renderPage(
  providers: ModelProviderResponse[] = [provider],
  overrides: Partial<typeof api> = {},
) {
  const fake = {
    ...api,
    listModelProviders: vi.fn().mockResolvedValue(providers),
    createModelProvider: vi.fn().mockResolvedValue(provider),
    updateModelProvider: vi.fn().mockResolvedValue(provider),
    deleteModelProvider: vi.fn().mockResolvedValue(undefined),
    testModelProvider: vi
      .fn()
      .mockResolvedValue({ ok: true, models: ["deepseek-chat"], error: null }),
    listModels: vi.fn().mockResolvedValue({
      provider: "lm_studio",
      status: "available",
      models: ["local-model"],
      default_model: "local-model",
    }),
  } as unknown as typeof api;
  Object.assign(fake, overrides);
  store.getState().resetForTests(fake);
  store.setState({ settingsRoute: "external-api" });
  render(<ModelServices />);
  await act(async () => {});
  return fake;
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("Model services workspace", () => {
  async function edit() {
    const fake = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    return fake;
  }
  it("opens a write-only credential editor from the provider directory", async () => {
    await edit();
    const key = screen.getByLabelText("API 密钥") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
    expect(key.placeholder).toContain("已保存");
  });
  it("saves model capacity with the source revision and omits an unchanged key", async () => {
    const fake = await edit();
    fireEvent.change(screen.getByLabelText("上下文窗口"), { target: { value: "131072" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存服务" })));
    expect(fake.updateModelProvider).toHaveBeenCalledWith(PROVIDER_ID, {
      name: "DeepSeek",
      base_url: provider.base_url,
      models: [{ name: "deepseek-chat", context_window: 131072 }],
      expected_revision: 3,
    });
  });
  it("preserves all capability declarations when only a provider name changes", async () => {
    const capabilities = { toolCalling: true, parallelToolCalls: false, codeExecution: true };
    const current = { ...provider, models: [{ ...provider.models[0], capabilities }] };
    const fake = await renderPage([current]);
    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Renamed" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存服务" })));
    expect(fake.updateModelProvider).toHaveBeenCalledWith(PROVIDER_ID, {
      name: "Renamed",
      base_url: provider.base_url,
      models: current.models,
      expected_revision: 3,
    });
  });
  it.each(["zh-CN", "en"] as const)(
    "explains local sandbox consent separately from hosted capabilities in %s",
    async (locale) => {
      selectLocale(locale);
      await renderPage();
      fireEvent.click(
        screen.getByRole("button", { name: locale === "zh-CN" ? "配置" : "Configure" }),
      );
      const label = locale === "zh-CN" ? "允许使用本机代码沙箱" : "Allow the local code sandbox";
      expect(screen.getByRole("checkbox", { name: label }).getAttribute("data-state")).toBe(
        "unchecked",
      );
      expect(
        screen.getByText(
          locale === "zh-CN" ? /不是托管 PTC 能力认证/ : /not certification of hosted PTC support/,
        ),
      ).toBeTruthy();
    },
  );
  it.each(["zh-CN", "en"] as const)(
    "describes tool calls as a transport switch and parallel calls as a declaration in %s",
    async (locale) => {
      selectLocale(locale);
      await renderPage();
      fireEvent.click(
        screen.getByRole("button", { name: locale === "zh-CN" ? "配置" : "Configure" }),
      );
      // 工具调用：填过声明的模型按声明执行——未勾选就不发原生 tools，JSON 决策协议仍在。
      expect(
        screen.getByText(
          locale === "zh-CN"
            ? /不再接收原生工具声明/
            : /no longer receives native tool declarations/,
        ),
      ).toBeTruthy();
      // 并行工具调用：只是声明记录；批量调用的安全调度与它无关。
      expect(
        screen.getByText(locale === "zh-CN" ? /只读并行、写串行/ : /read-only in parallel/),
      ).toBeTruthy();
    },
  );
  it("edits capabilities without losing the other flags and keeps the draft on conflict", async () => {
    const capabilities = { toolCalling: true, parallelToolCalls: false, codeExecution: false };
    const update = vi.fn().mockRejectedValue(new Error("配置已变化，请刷新"));
    await renderPage([{ ...provider, models: [{ ...provider.models[0], capabilities }] }], {
      updateModelProvider: update,
    });
    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "允许使用本机代码沙箱" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存服务" })));
    expect(update.mock.calls[0][1].models[0].capabilities).toEqual({
      ...capabilities,
      codeExecution: true,
    });
    expect(
      screen.getByRole("checkbox", { name: "允许使用本机代码沙箱" }).getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("配置已变化")),
    ).toBe(true);
  });
  it("keeps absent capabilities absent until edited and can restore the undeclared state", async () => {
    const fake = await edit();
    fireEvent.click(screen.getByRole("checkbox", { name: "允许使用本机代码沙箱" }));
    fireEvent.click(screen.getByRole("button", { name: "清除能力声明" }));
    fireEvent.change(screen.getByLabelText("上下文窗口"), { target: { value: "131072" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存服务" })));
    expect(fake.updateModelProvider).toHaveBeenCalledWith(PROVIDER_ID, {
      name: provider.name,
      base_url: provider.base_url,
      models: [{ name: "deepseek-chat", context_window: 131072 }],
      expected_revision: 3,
    });
  });
  it("clears the saved credential explicitly without discarding other draft fields", async () => {
    const fake = await edit();
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Draft name" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "清除已保存密钥" })));
    expect(fake.updateModelProvider).toHaveBeenCalledWith(PROVIDER_ID, {
      api_key: null,
      expected_revision: 3,
    });
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("Draft name");
  });
  it("rejects missing capacity using the provider contract", async () => {
    const fake = await edit();
    fireEvent.change(screen.getByLabelText("上下文窗口"), { target: { value: "" } });
    expect((screen.getByRole("button", { name: "保存服务" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(fake.updateModelProvider).not.toHaveBeenCalled();
  });
  it("registers a provider with a secret through the same editor", async () => {
    const fake = await renderPage([]);
    fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Example" } });
    fireEvent.change(screen.getByLabelText("服务地址"), {
      target: { value: "https://example.test/v1" },
    });
    fireEvent.change(screen.getByLabelText("API 密钥"), { target: { value: "test-secret" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存服务" })));
    expect(fake.createModelProvider).toHaveBeenCalledWith({
      name: "Example",
      base_url: "https://example.test/v1",
      api_key: "test-secret",
      models: [],
    });
  });
});

it("provider configuration remains usable while health checks are pending and aborts them on unmount", async () => {
  let signal: AbortSignal | undefined;
  await renderPage([provider], {
    testModelProvider: vi.fn((_id: string, requestSignal?: AbortSignal) => {
      signal = requestSignal;
      return new Promise<Awaited<ReturnType<SuperstringApi["testModelProvider"]>>>(() => {});
    }),
  });
  expect(screen.getByText("DeepSeek")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "配置" }));
  expect(screen.getByRole("textbox", { name: "名称" })).toBeTruthy();
  cleanup();
  expect(signal?.aborted).toBe(true);
});
it("dirty provider credentials warn before window close and keep the navigation shortcut inside the editor", async () => {
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "配置" }));
  const name = screen.getByRole("textbox", { name: "名称" });
  fireEvent.change(name, { target: { value: "Draft" } });
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  const listener = vi.fn();
  document.addEventListener("keydown", listener);
  fireEvent.keyDown(name, { key: "k", ctrlKey: true });
  expect(listener).not.toHaveBeenCalled();
  document.removeEventListener("keydown", listener);
});
it("a pending confirmed provider deletion cannot be submitted twice", async () => {
  let finish!: () => void;
  const remove = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await renderPage([provider], { deleteModelProvider: remove });
  fireEvent.click(screen.getByRole("button", { name: "配置" }));
  fireEvent.click(screen.getByRole("button", { name: "删除服务" }));
  const confirm = screen.getByRole("button", { name: "确认" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveProperty("disabled", true);
  await act(async () => finish());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});
