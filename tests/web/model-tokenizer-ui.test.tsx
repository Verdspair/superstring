import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderResponse } from "../../src/shared/contracts/models";
import type { SuperstringApi } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { ModelServices } from "../../src/web/screens/environment/ModelServices";
import { useSuperstringStore as store } from "../../src/web/store";

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
        parallelToolCalls: false,
        codeExecution: false,
        vision: false,
      },
    },
  ],
};

function client(overrides: Partial<SuperstringApi> = {}) {
  return {
    listModelProviders: vi.fn(async () => [syntheticProvider]),
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

function renderModelServices(fake: SuperstringApi) {
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "external-api",
    modelProviders: [syntheticProvider],
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
            parallelToolCalls: false,
            codeExecution: false,
            vision: false,
          },
        },
      ],
    });

    const sentPayload = (fake.updateModelProvider as any).mock.calls[0][1];
    expect(sentPayload).not.toHaveProperty("api_key");
  });

  it("clears capabilities while preserving tokenizer encoding on truthful existing list", async () => {
    const fake = client();
    renderModelServices(fake);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "配置" }));
    });

    const clearCapsBtn = screen.getByRole("button", { name: "清除能力声明" });
    await act(async () => {
      fireEvent.click(clearCapsBtn);
    });

    expect(screen.queryByRole("button", { name: "清除能力声明" })).toBeNull();

    const saveBtn = screen.getByRole("button", { name: "保存服务" });
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
          tokenizer_encoding: "cl100k_base",
        },
      ],
    });

    const sentModel = (fake.updateModelProvider as any).mock.calls[0][1].models[0];
    expect(sentModel).not.toHaveProperty("capabilities");
    expect(sentModel.tokenizer_encoding).toBe("cl100k_base");
    expect(sentModel.context_window).toBe(8192);
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
});
