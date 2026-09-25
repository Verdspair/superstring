// 外部模型API（0032）：登记服务、写只读的密钥、手填上下文窗口。
//
// The two promises worth pinning: the stored key is never rendered (the field is empty and
// password-typed, and clearing it is its own explicit action), and a model cannot be saved without
// a context window — that number is what keeps the QQ chain able to call an external model at all.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderResponse } from "../../src/shared/contracts/models";
import { api } from "../../src/web/api";
import { ExternalApiSettings } from "../../src/web/features/models/ExternalApiSettings";
import { selectLocale } from "../../src/web/i18n";
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

async function renderPage(providers: ModelProviderResponse[] = [provider]) {
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
  store.getState().resetForTests(fake);
  render(<ExternalApiSettings />);
  await act(async () => {});
  return fake;
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("外部模型API", () => {
  it("列出已登记的服务，密钥只显示状态、不回显", async () => {
    await renderPage();
    expect(screen.getByText("DeepSeek")).toBeTruthy();
    expect(screen.getByText(/已保存密钥/)).toBeTruthy();
    const key = screen.getByLabelText("供应商密钥") as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.type).toBe("password");
  });

  it("改窗口后保存整份模型清单，带页面读到的修订号", async () => {
    const fake = await renderPage();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("上下文窗口"), { target: { value: "131072" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    expect(fake.updateModelProvider).toHaveBeenCalledWith(PROVIDER_ID, {
      name: "DeepSeek",
      base_url: "https://api.deepseek.com/v1",
      models: [{ name: "deepseek-chat", context_window: 131072 }],
      expected_revision: 3,
    });
  });

  it("清除密钥是独立动作，且保存时不会把它当新密钥发出去", async () => {
    const fake = await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "清除密钥" }));
    });
    expect(fake.updateModelProvider).toHaveBeenCalledWith(PROVIDER_ID, {
      api_key: null,
      expected_revision: 3,
    });
  });

  it("没有窗口就不允许保存（外部服务不报这个数，空着等于不可用）", async () => {
    const fake = await renderPage();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("上下文窗口"), { target: { value: "" } });
    });
    const save = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(save);
    });
    expect(fake.updateModelProvider).not.toHaveBeenCalled();
  });

  it("登记新服务时把名称、地址与密钥一起提交", async () => {
    const fake = await renderPage([]);
    expect(screen.getByText("还没有登记任何外部服务。")).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("新供应商名称"), { target: { value: "Moonshot" } });
      fireEvent.change(screen.getByLabelText("新供应商地址"), {
        target: { value: "https://api.moonshot.cn/v1" },
      });
      fireEvent.change(screen.getByLabelText("新供应商密钥"), { target: { value: "sk-moon" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "登记这个服务" }));
    });
    expect(fake.createModelProvider).toHaveBeenCalledWith({
      name: "Moonshot",
      base_url: "https://api.moonshot.cn/v1",
      api_key: "sk-moon",
      models: [],
    });
  });
});
