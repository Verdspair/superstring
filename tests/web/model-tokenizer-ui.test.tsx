import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocalModelCatalogResponse,
  ModelProviderResponse,
} from "../../src/shared/contracts/models";
import { ApiError, type SuperstringApi } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { ModelServices } from "../../src/web/screens/environment/ModelServices";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

const syntheticProvider: ModelProviderResponse = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Synthetic Provider",
  base_url: "https://api.synthetic.example/v1",
  has_api_key: true,
  revision: 3,
  created_at: "2026-10-14T00:00:00.000Z",
  updated_at: "2026-10-14T00:00:00.000Z",
  models: [
    {
      name: "synthetic-model",
      context_window: 8192,
      tokenizer_encoding: "cl100k_base",
      capabilities: {
        toolCalling: true,
        parallelToolCalls: true,
        codeExecution: true,
        vision: false,
      },
    },
  ],
};

function client(overrides: Partial<SuperstringApi> = {}) {
  return {
    listModelProviders: vi.fn(async () => [syntheticProvider]),
    listModels: vi.fn(
      async (): Promise<LocalModelCatalogResponse> => ({
        provider: "lm_studio",
        status: "available",
        models: ["synthetic-model"],
        default_model: "synthetic-model",
      }),
    ),
    testModelProvider: vi.fn(async () => ({
      ok: true,
      models: [syntheticProvider.models[0].name],
      error: null,
    })),
    updateModelProvider: vi.fn(async (_id: string, body: object) => ({
      ...syntheticProvider,
      ...body,
      revision: syntheticProvider.revision + 1,
    })),
    createModelProvider: vi.fn(async (body: object) => ({
      ...syntheticProvider,
      ...body,
      id: "00000000-0000-4000-8000-000000000002",
      revision: 1,
    })),
    deleteModelProvider: vi.fn(async () => {}),
    getOrganizationSettings: vi.fn(async () => ({
      model_name: null,
      vision_model_name: null,
      transcription_model_name: null,
      revision: 1,
    })),
    getKnowledgeSettings: vi.fn(async () => ({
      model_name: null,
      revision: 1,
      auto_enabled: true,
      context_budget: 4096,
    })),
    getQqSettings: vi.fn(async () => ({
      enabled: false,
      account_id: "10001",
      judgement_model_name: null,
      transport: { endpoint: "ws://127.0.0.1:3000/", has_token: false },
      revision: 1,
    })),
    ...overrides,
  } as unknown as SuperstringApi;
}

function renderModelServices(fake: SuperstringApi, provider = syntheticProvider) {
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "external-api",
    modelProviders: [provider],
    loadedModelNames: [],
    modelStatus: "",
  });
  render(<ModelServices active={true} />);
  return fake;
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("ModelServices tokenizer UI component lifecycle", () => {
  it("configures synthetic provider: changes encoding from cl100k_base to o200k_base and saves with explicit button", async () => {
    const fake = client();
    renderModelServices(fake);
    await act(async () => {});

    const configureBtn = screen.getByRole("button", { name: "配置" });
    await act(async () => {
      fireEvent.click(configureBtn);
    });

    const encodingSelect = screen.getByLabelText("文本 token 编码") as HTMLSelectElement;
    expect(encodingSelect.value).toBe("cl100k_base");
    expect((encodingSelect.closest("details") as HTMLDetailsElement | null)?.open).toBe(true);

    await act(async () => {
      fireEvent.change(encodingSelect, { target: { value: "o200k_base" } });
    });
    expect(encodingSelect.value).toBe("o200k_base");

    const saveBtn = screen.getByRole("button", { name: "保存服务" });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(fake.updateModelProvider).toHaveBeenCalledTimes(1);
    expect(fake.updateModelProvider).toHaveBeenCalledWith(syntheticProvider.id, {
      name: "Synthetic Provider",
      base_url: "https://api.synthetic.example/v1",
      expected_revision: 3,
      models: [
        {
          name: "synthetic-model",
          context_window: 8192,
          tokenizer_encoding: "o200k_base",
          capabilities: {
            toolCalling: true,
            parallelToolCalls: true,
            codeExecution: true,
            vision: false,
          },
        },
      ],
    });

    const sentPayload = (fake.updateModelProvider as any).mock.calls[0][1];
    expect(sentPayload).not.toHaveProperty("api_key");
  });

  it("does not expose per-model ability controls", async () => {
    const fake = client();
    renderModelServices(fake);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "配置" }));
    });

    expect(screen.queryByLabelText("图片理解")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "原生工具调用" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "并行工具调用" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "允许使用本机代码沙箱" })).toBeNull();
    expect(screen.queryByRole("button", { name: "清除能力声明" })).toBeNull();
    expect(screen.queryByRole("button", { name: "执行设置" })).toBeNull();
    // The only optional per-model declaration left is the tokenizer usage estimate.
    expect(screen.getByLabelText("文本 token 编码")).toBeTruthy();
    expect(fake.updateModelProvider).not.toHaveBeenCalled();
  });

  it("does not dispatch save or add request on select Enter key down, dispatches only on explicit save", async () => {
    const fake = client();
    renderModelServices(fake);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "配置" }));
    });

    const encodingSelect = screen.getByLabelText("文本 token 编码");
    await act(async () => {
      fireEvent.change(encodingSelect, { target: { value: "o200k_base" } });
    });

    // Enter in select must not submit/save
    fireEvent.keyDown(encodingSelect, { key: "Enter", code: "Enter" });

    expect(fake.updateModelProvider).not.toHaveBeenCalled();
    expect(fake.createModelProvider).not.toHaveBeenCalled();

    const saveBtn = screen.getByRole("button", { name: "保存服务" });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(fake.updateModelProvider).toHaveBeenCalledTimes(1);
    expect(fake.createModelProvider).not.toHaveBeenCalled();
    expect(fake.updateModelProvider).toHaveBeenCalledWith(
      syntheticProvider.id,
      expect.objectContaining({
        expected_revision: 3,
        models: [
          expect.objectContaining({
            name: "synthetic-model",
            context_window: 8192,
            tokenizer_encoding: "o200k_base",
          }),
        ],
      }),
    );
  });

  it("keeps legacy capability declarations unchanged on an ordinary save", async () => {
    const legacyProvider: ModelProviderResponse = {
      ...syntheticProvider,
      id: "00000000-0000-4000-8000-000000000004",
      name: "Legacy Provider",
      revision: 7,
      models: [
        {
          name: "legacy-model",
          context_window: 2048,
          capabilities: {
            toolCalling: false,
            parallelToolCalls: false,
            codeExecution: false,
            vision: false,
          },
        },
      ],
    };
    const update = vi.fn(async (_id: string, body: object) => ({
      ...legacyProvider,
      ...body,
      revision: 8,
    }));
    const fake = client({
      listModelProviders: vi.fn(async () => [legacyProvider]),
      testModelProvider: vi.fn(async () => ({
        ok: true,
        models: ["legacy-model"],
        error: null,
      })),
      updateModelProvider: update,
    });
    renderModelServices(fake, legacyProvider);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "配置" }));
    });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Renamed" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存服务" }));
    });
    expect(update).toHaveBeenCalledWith(legacyProvider.id, {
      name: "Renamed",
      base_url: "https://api.synthetic.example/v1",
      expected_revision: 7,
      models: [
        {
          name: "legacy-model",
          context_window: 2048,
          capabilities: {
            toolCalling: false,
            parallelToolCalls: false,
            codeExecution: false,
            vision: false,
          },
        },
      ],
    });
  });

  it("keeps an unset encoding draft on a CAS conflict", async () => {
    const update = vi
      .fn()
      .mockRejectedValue(
        new ApiError(409, "CONFIG_VERSION_CONFLICT", "provider 已变化，请重新加载后保存"),
      );
    const fake = client({ updateModelProvider: update });
    renderModelServices(fake);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "配置" }));
    });
    const encodingSelect = screen.getByLabelText("文本 token 编码") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(encodingSelect, { target: { value: "" } });
    });
    expect(encodingSelect.value).toBe("");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存服务" }));
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("文本 token 编码") as HTMLSelectElement).value).toBe("");
    expect(
      screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("provider 已变化")),
    ).toBe(true);
    expect((screen.getByRole("button", { name: "保存服务" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByText("配置模型服务")).toBeTruthy();
  });

  it("provider 409 keeps the edited draft and does not retry automatically", async () => {
    const update = vi
      .fn()
      .mockRejectedValue(
        new ApiError(409, "CONFIG_VERSION_CONFLICT", "provider 已变化，请重新加载后保存"),
      );
    const fake = client({ updateModelProvider: update });
    renderModelServices(fake);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "配置" }));
    });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Renamed" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存服务" }));
    });

    expect(
      screen
        .getAllByRole("alert")
        .some((alert) => alert.textContent?.includes("provider 已变化，请重新加载后保存")),
    ).toBe(true);
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("Renamed");
    expect(update).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "保存服务" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByText("配置模型服务")).toBeTruthy();
  });
});
